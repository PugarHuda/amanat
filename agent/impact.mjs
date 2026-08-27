// What changed on an intent after our scoring module took it over (Track 2).
//
//   node agent/impact.mjs                   every intent we hold, by epoch
//   node agent/impact.mjs GAME_RESULT       one of them
//
// Holding a champion slot means our module decides what every miner on that
// intent earns. That is testable, and nobody else on this network is in a
// position to test it: the slot was taken specifically to fix scoring, so the
// epochs before and after the handover are a before and after.
//
// It answers a second question at the same time — whether we still hold the
// slot. A champion is replaced by whoever next clears the three gates, and
// nothing notifies the incumbent.
//
// Public reads only. This spends nothing.

import { NODE } from "./telegraph.mjs";
import { positionals, reject } from "./args.mjs";

// Ours. The scores below are what this address's modules produced.
const US = "0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e";

/** Intents whose champion is `author`, with the registration holding it. */
async function held(author) {
  const res = await fetch(`${NODE}/api/wasm`);
  if (!res.ok) throw new Error(`wasm registry ${res.status}`);
  const { intents } = await res.json();

  const mine = {};
  for (const [intent, v] of Object.entries(intents)) {
    const c = v.champion;
    if (c && (c.author_address ?? "").toLowerCase() === author) {
      mine[intent] = { registration: c.registration_id, since: c.updated_at ?? c.registered_at };
    }
  }
  return mine;
}

/** Every score recorded on `intent`, newest epoch first. */
async function scores(intent) {
  const res = await fetch(`${NODE}/api/miners`);
  if (!res.ok) throw new Error(`miner catalogue ${res.status}`);
  const rows = [];
  for (const m of await res.json()) {
    for (const s of m.scores ?? []) {
      if ((s.intent_id ?? s.intent) === intent) {
        rows.push({ slug: m.slug, epoch: s.epoch_id, rank: s.rank, score: s.score ?? 0, at: s.scored_at });
      }
    }
  }
  return rows.sort((a, b) => b.epoch - a.epoch || a.rank - b.rank);
}

/**
 * Group by epoch and mark the handover.
 *
 * An epoch is scored once, at a moment; the champion changed at another. An
 * epoch scored before the handover was graded by the previous module however
 * recently it ran, so the comparison is by timestamp, not by epoch number.
 */
export function split(rows, since) {
  const cut = Date.parse(since);
  const byEpoch = new Map();
  for (const r of rows) {
    const e = byEpoch.get(r.epoch) ?? { epoch: r.epoch, at: r.at, rows: [] };
    e.rows.push(r);
    byEpoch.set(r.epoch, e);
  }
  return [...byEpoch.values()]
    .map((e) => ({ ...e, ours: Number.isFinite(cut) && Date.parse(e.at) >= cut }))
    .sort((a, b) => b.epoch - a.epoch);
}

async function main() {
  reject(process.argv.slice(2), []);
  const want = positionals(process.argv.slice(2))[0];

  const mine = await held(US);
  const names = want ? [want] : Object.keys(mine);

  if (!names.length) {
    console.log("we hold no champion slot — nothing to measure, and that is the news");
    return;
  }
  if (want && !mine[want]) {
    console.log(`we do not hold ${want}. Slots held: ${Object.keys(mine).join(", ") || "none"}`);
  }

  for (const intent of names) {
    const slot = mine[intent];
    console.log(`\n${intent}`);
    console.log(slot
      ? `  ours since ${slot.since} (registration ${slot.registration})`
      : `  NOT OURS — the slot has been taken back`);

    const epochs = split(await scores(intent), slot?.since ?? "");
    if (!epochs.length) { console.log("  no scores recorded on this intent"); continue; }

    for (const e of epochs) {
      const best = Math.max(...e.rows.map((r) => r.score));
      const mark = e.ours ? "ours " : "     ";
      console.log(`  ${mark}epoch ${e.epoch}  ${e.at?.slice(0, 16) ?? ""}  best ${best < 1e-4 ? best.toExponential(1) : best.toFixed(6)}  (${e.rows.length} miners)`);
      for (const r of e.rows) console.log(`          ${String(r.rank).padStart(2)}  ${r.slug.padEnd(30)} ${r.score.toFixed(7)}`);
    }

    const after = epochs.filter((e) => e.ours);
    if (!after.length) {
      console.log(slot
        ? `  no epoch has been scored by our module yet — the next one is the measurement`
        : `  no epoch was ever scored by our module: the slot was taken back before one ran`);
    }
  }
}

// Importing this must not start asking the network questions; split() is the
// part worth testing.
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
