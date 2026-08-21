// The Amanat loop: screen cheaply, settle on-chain only when it matters.
//
//   node agent/run.mjs --dry        read-only; no wallet, no spend  (start here)
//   node agent/run.mjs              opens jobs for policies that pass screening
//
// A dry run touches only free endpoints, so it works with no keys and no funds
// and still shows exactly which policies would have gone on-chain.

import { ethers } from "ethers";
import {
  NODE, DIAMOND, intentId, wallet, diamond, provider,
  daemonSignals, miners, waitForJob, JOB_STATE,
} from "./telegraph.mjs";

const DRY = process.argv.includes("--dry");
const AMANAT = process.env.AMANAT_CONTRACT;

/** Policies to watch. In production these are read from the contract. */
const BOOK = [
  { id: 1, name: "Cebu port cover", lat: "10.32", lon: "123.89" },
  { id: 2, name: "Jakarta warehouse cover", lat: "-6.20", lon: "106.85" },
  { id: 3, name: "Rotterdam terminal cover", lat: "51.92", lon: "4.48" },
];

const SCREEN_INTENT = "WEATHER_FORECAST";
const SETTLE_INTENT = "STORM_ALERT";
const SCREEN_THRESHOLD = 0.45; // below this a policy is not worth a $1 job

/** Free screening: ask our own miner directly rather than paying per call. */
async function screen(policy) {
  const base = process.env.AMANAT_MINER ?? "http://127.0.0.1:8787";
  const res = await fetch(`${base}/forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: Number(policy.lat), lon: Number(policy.lon), hours: 3 }),
  });
  if (!res.ok) throw new Error(`screen ${policy.name}: ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`node      ${NODE}`);
  console.log(`diamond   ${DIAMOND}`);

  // What the network already knows, for free.
  const [signals, weatherMiners] = await Promise.all([
    daemonSignals({ limit: 20, intent: SCREEN_INTENT }).catch(() => []),
    miners({ intent: SETTLE_INTENT }).catch(() => []),
  ]);
  console.log(`daemon    ${signals.length} recent ${SCREEN_INTENT} signals`);
  console.log(`supply    ${weatherMiners.length} miners serve ${SETTLE_INTENT}`);
  if (weatherMiners.length === 0) {
    console.log("no miner serves the settlement intent — a job would have nowhere to route");
  }

  const settleIntent = intentId(SETTLE_INTENT);
  console.log(`intentId  ${settleIntent}  (keccak256 of the name: the protocol picks the miner)\n`);

  const escalate = [];
  for (const p of BOOK) {
    let reading;
    try {
      reading = await screen(p);
    } catch (e) {
      console.log(`  ${p.name.padEnd(28)} screening failed: ${e.message}`);
      continue;
    }
    const hot = reading.risk >= SCREEN_THRESHOLD;
    console.log(
      `  ${p.name.padEnd(28)} risk ${reading.risk.toFixed(3)}  ${hot ? "-> settle on-chain" : "no action"}`
    );
    if (hot) escalate.push({ policy: p, reading });
  }

  if (!escalate.length) {
    console.log("\nnothing above the screening threshold — no USDC spent.");
    return;
  }

  if (DRY) {
    console.log(`\n--dry: would open ${escalate.length} job(s) at 1 USDC each. Nothing was sent.`);
    return;
  }
  if (!AMANAT) throw new Error("AMANAT_CONTRACT is not set — deploy onchain/Amanat.sol first");

  const signer = wallet();
  const d = diamond(signer);
  console.log(`\nagent     ${await signer.getAddress()}`);

  for (const { policy } of escalate) {
    const params = {
      addresses: [],
      integers: [3n], // hours ahead
      strings: [policy.lat, policy.lon],
      bools: [],
    };
    const tx = await d.createJob(settleIntent, params, AMANAT);
    const receipt = await tx.wait();
    const created = receipt.logs
      .map((l) => { try { return d.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "JobCreated");
    const jobId = created?.args?.jobId;
    console.log(`  ${policy.name}: job ${jobId} — ${tx.hash}`);

    const { state, timedOut } = await waitForJob(jobId);
    console.log(`  ${policy.name}: ${state}${timedOut ? " (timed out waiting)" : ""}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
