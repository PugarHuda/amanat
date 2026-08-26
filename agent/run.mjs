// The Amanat loop: screen every open policy cheaply, settle on-chain only when
// a policy is close enough to its trigger to be worth a dollar.
//
//   node --env-file=.env agent/run.mjs --dry            read-only, spends nothing
//   node --env-file=.env agent/run.mjs                  one pass
//   node --env-file=.env agent/run.mjs --cycles 20 --interval 300
//
// Cost discipline is the whole design. An Engine call is $0.01 and a job is
// $1.00, so the loop asks the network a hundred cheap questions before it asks
// one expensive one, and never opens a job for a policy the cheap answer has
// already cleared.
//
// The book is read from the contract, not from a list here: the contract is the
// source of truth about what it owes.

import { ethers } from "ethers";
import { readFile } from "node:fs/promises";
import {
  NODE, wallet, provider, diamond, usdc, ask, intentId, waitForJob, recentSignals,
  POLICY_STATUS,
} from "./telegraph.mjs";
import { flag, has, reject } from "./args.mjs";

const ADDRESS = process.env.AMANAT_CONTRACT;
const SETTLE_INTENT = process.env.AMANAT_INTENT ?? "STORM_ALERT";

/** Screen below this and a policy is not worth a job. */
const ESCALATE_AT = Number(process.env.AMANAT_ESCALATE_AT ?? 0.45);

/**
 * Hard ceiling on what one run may spend, in USD. The loop stops when it is
 * reached rather than continuing to its cycle count.
 *
 * A screening pass is cheap enough to feel free — $0.01 — which is exactly how
 * a long run quietly drains a wallet. The cap is deliberately small: raise it
 * per run with AMANAT_MAX_SPEND when you actually mean to.
 */
const MAX_SPEND = Number(process.env.AMANAT_MAX_SPEND ?? 0.5);

/** Every policy the contract still owes on. */
async function openPolicies(book) {
  const next = await book.nextPolicyId();
  const out = [];
  for (let id = 1n; id < next; id++) {
    const p = await book.policies(id);
    if (Number(p.status) === 1) out.push({ id, lat: p.lat, lon: p.lon, payout: p.payout });
  }
  return out;
}

/** Pull a risk out of an answer whose shape is not ours to assume. */
function readRisk(result) {
  const direct = result?.risk;
  if (typeof direct === "number") return direct;
  const fractions = [...JSON.stringify(result ?? {}).matchAll(/0\.\d+/g)].map((m) => Number(m[0]));
  return fractions.length ? Math.max(...fractions) : null;
}

/**
 * The free rail, tried before any paid one.
 *
 * The Daemon answers its own questions on a schedule whether or not anyone is
 * asking, and those answers cost nothing to read. When one of them is recent and
 * on an intent we care about, it is worth knowing before spending a cent — not
 * because it is about our exact point, but because a network that has just seen
 * no storm activity at all is a network we do not need to interrogate twice.
 *
 * Returns the signals rather than a verdict: this rail informs the pass, it does
 * not replace it.
 */
async function freeContext(intents) {
  try {
    return await recentSignals({ intents, maxAgeMinutes: 180, limit: 60 });
  } catch {
    return [];
  }
}

/**
 * Ask the network what the weather is at a point, and read a risk out of the
 * answer. The miner is whichever one the Engine routes to, so the shape of the
 * reply is not ours to assume.
 */
async function screen(policy, signer) {
  const answer = await ask(
    `What is the storm risk at latitude ${policy.lat}, longitude ${policy.lon} in the next six hours? ` +
    `Report wind speed, gusts, precipitation and an overall risk between 0 and 1.`,
    { signer },
  );

  const text = JSON.stringify(answer.result ?? {});
  // Our own miner reports `risk` directly; anyone else's answer has to be read
  // out of prose, so fall back to the largest 0..1 figure it states.
  const direct = answer.result?.risk;
  let risk = typeof direct === "number" ? direct : null;
  if (risk === null) {
    const fractions = [...text.matchAll(/\b0\.\d+\b/g)].map((m) => Number(m[0]));
    risk = fractions.length ? Math.max(...fractions) : null;
  }
  return { risk, answer };
}

async function cycle(book, signer, n) {
  const p = provider();
  const policies = await openPolicies(book);
  const jobPrice = await diamond(p).getJobBasePrice();
  let escrow = await diamond(p).escrowBalance(ADDRESS);

  console.log(`\n── pass ${n} ── ${policies.length} open ${policies.length === 1 ? "policy" : "policies"}, ` +
    `escrow ${ethers.formatUnits(escrow, 6)} USDC`);

  if (!policies.length) {
    console.log("   nothing open — the book is clear");
    return { screened: 0, escalated: 0, spent: 0 };
  }

  let screened = 0;
  let escalated = 0;
  let spent = 0;

  for (const policy of policies) {
    let result;
    try {
      result = await screen(policy, signer);
    } catch (e) {
      console.log(`   policy ${policy.id}: screening failed — ${e.message}`);
      continue;
    }
    screened++;
    spent += Number(result.answer.cost_usd ?? 0.01);

    const { risk, answer } = result;
    const shown = risk === null ? "unreadable" : risk.toFixed(3);
    console.log(
      `   policy ${policy.id} @ ${policy.lat},${policy.lon}: risk ${shown} ` +
      `via ${answer.miner_name} (${answer.intent}) ${answer.signal_hash?.slice(0, 12)}…`,
    );

    if (risk === null || risk < ESCALATE_AT) continue;
    if (escrow < jobPrice) {
      console.log(`      above ${ESCALATE_AT} but escrow cannot cover a job — call fundEscrow`);
      continue;
    }
    if (has(process.argv, "--dry")) {
      console.log(`      above ${ESCALATE_AT}: would open a job (--dry, nothing sent)`);
      escalated++;
      continue;
    }

    console.log(`      above ${ESCALATE_AT}: settling on-chain`);
    // Screening is the point of the loop; a job that fails must not stop it.
    try {
      const tx = await book.requestCheck(policy.id, intentId(SETTLE_INTENT), 1n);
      const receipt = await tx.wait();
      const created = receipt.logs
        .map((l) => { try { return book.interface.parseLog(l); } catch { return null; } })
        .find((e) => e?.name === "CheckRequested");
      const jobId = created?.args?.jobId;
      console.log(`      job ${jobId}  ${tx.hash}`);
      escalated++;
      spent += 1;

      const { state } = await waitForJob(jobId, { timeoutMs: 10 * 60_000 });
      const after = await book.policies(policy.id);
      console.log(`      job ${jobId} ${state} -> policy ${policy.id} ${POLICY_STATUS[Number(after.status)]} ` +
        `(risk ${Number(after.riskReported) / 10000})`);
    } catch (e) {
      console.log(`      job failed: ${e.shortMessage ?? e.message}`);
    }
    // A job just spent from the escrow this pass read at the start.
    escrow = await diamond(p).escrowBalance(ADDRESS);
  }

  return { screened, escalated, spent };
}

async function main() {
  reject(process.argv.slice(2), ["--dry", "--cycles", "--interval"]);
  if (!ADDRESS) throw new Error("AMANAT_CONTRACT is not set — deploy first");
  const signer = wallet();
  const abi = JSON.parse(await readFile(new URL("../onchain/Amanat.abi.json", import.meta.url), "utf8"));
  const book = new ethers.Contract(ADDRESS, abi, signer);

  const cycles = Number(flag(process.argv, "--cycles", 1));
  const interval = Number(flag(process.argv, "--interval", 300));

  console.log(`node       ${NODE}`);
  console.log(`contract   ${ADDRESS}`);
  console.log(`escalate   risk >= ${ESCALATE_AT}, settling via ${SETTLE_INTENT}`);
  console.log(`wallet     ${await signer.getAddress()}`);

  console.log(`budget     $${MAX_SPEND.toFixed(2)} for this run`);

  const totals = { screened: 0, escalated: 0, spent: 0 };
  for (let n = 1; n <= cycles; n++) {
    const r = await cycle(book, signer, n);
    totals.screened += r.screened;
    totals.escalated += r.escalated;
    totals.spent += r.spent;
    if (totals.spent >= MAX_SPEND) {
      console.log(`
budget spent ($${totals.spent.toFixed(2)} of $${MAX_SPEND.toFixed(2)}) — stopping after pass ${n}`);
      break;
    }
    if (n < cycles) await new Promise((r) => setTimeout(r, interval * 1000));
  }

  console.log(`\ntotal: ${totals.screened} screened, ${totals.escalated} settled on-chain, ` +
    `about $${totals.spent.toFixed(2)} spent`);
  console.log(`wallet USDC ${ethers.formatUnits(await usdc(provider()).balanceOf(await signer.getAddress()), 6)}`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
