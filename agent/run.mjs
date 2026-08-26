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
  NODE, wallet, provider, diamond, usdc, ask, askDirect, intentId, waitForJob, recentSignals, readRisk,
  POLICY_STATUS,
} from "./telegraph.mjs";
import { flag, has, reject } from "./args.mjs";

const ADDRESS = process.env.AMANAT_CONTRACT;
const SETTLE_INTENT = process.env.AMANAT_INTENT ?? "STORM_ALERT";

/**
 * The miner asked directly when a routed answer cannot be read as a number.
 * Any miner publishing an output_schema with a 0-1 risk field would do; this is
 * the one we can guarantee stays live for the length of the run.
 */
const SCHEMA_MINER = process.env.AMANAT_SCHEMA_MINER ?? "20260821";

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

/**
 * The free rail: what the Daemon has already answered, at no cost.
 *
 * Worth asking before paying, and worth reporting when it yields nothing. The
 * Daemon collectors cover Hacker News, openFDA, ClinicalTrials and Polymarket,
 * and not one of them produces a weather question — so for our intents this
 * returns empty every time. It stays because the check costs one free request
 * and the collector set is the node's to change, not ours. The count is
 * printed so a pass says plainly which rail did the work.
 */
async function freeContext(intents) {
  try {
    return await recentSignals({ intents, maxAgeMinutes: 180, limit: 60 });
  } catch {
    return [];
  }
}

/**
 * Ask the network what the weather is at a point, and read a risk out of it.
 *
 * Two paid rails, in the order that respects the protocol. The Engine picks
 * the miner, which is the point — routing is the thing being tested, and
 * Amanat should take whichever miner the network rates highest. But a routed
 * answer stating no readable figure has cost a cent and settled nothing, and
 * the policy would be skipped with the money already gone. When that happens
 * the same point goes directly to a miner that publishes an output_schema, and
 * the pass reports which rail answered.
 */
async function screen(policy, signer) {
  const question =
    `What is the storm risk at latitude ${policy.lat}, longitude ${policy.lon} in the next six hours? ` +
    `Report wind speed, gusts, precipitation and an overall risk between 0 and 1.`;

  const answer = await ask(question, { signer });
  const risk = readRisk(answer.result);
  if (risk !== null) return { risk, answer, rail: "routed" };

  try {
    const fallback = await askDirect(SCHEMA_MINER, {
      endpoint: "/forecast",
      payload: { lat: Number(policy.lat), lon: Number(policy.lon), hours: 6 },
      signer,
    });
    return { risk: readRisk(fallback.result), answer: fallback, rail: "direct", blind: answer.miner_name };
  } catch (e) {
    return { risk: null, answer, rail: "routed", fallbackError: e.message };
  }
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

  // The free rail first, every pass, and reported either way — a run should
  // never leave you guessing whether the cheap answer was even tried.
  const free = await freeContext([SETTLE_INTENT, "WEATHER_FORECAST", "WEATHER_CHECK"]);
  console.log(free.length
    ? `   free rail: ${free.length} recent Daemon signal${free.length === 1 ? "" : "s"} on these intents`
    : "   free rail: nothing — the Daemon runs no weather collector, so it never has one");

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

    const { risk, answer, rail, blind, fallbackError } = result;
    const shown = risk === null ? "unreadable" : risk.toFixed(3);
    console.log(
      `   policy ${policy.id} @ ${policy.lat},${policy.lon}: risk ${shown} ` +
      `via ${answer.miner_name ?? SCHEMA_MINER} (${answer.intent ?? "direct"}) ${answer.signal_hash?.slice(0, 12)}…`,
    );
    if (rail === "direct") {
      console.log(`      routed answer from ${blind} stated no readable risk — asked a schema miner directly`);
      spent += Number(answer.cost_usd ?? 0.01);
    }
    if (fallbackError) console.log(`      and the direct rail failed too: ${fallbackError}`);

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
