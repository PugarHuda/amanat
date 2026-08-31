// Where we stand under the rubric the organisers actually published.
//
//   node agent/standing.mjs          the scoreboard
//   node agent/standing.mjs --json   the same, written to standing.json
//
// From hackathon.telegraphprotocol.com/rules, the Miner track is scored out of
// 100: 75 points Normalized Performance and 25 points X engagement. Normalized
// Performance is "your average Canonical Score divided by the highest average
// score achieved inside your specific Intent" — so the best miner in an intent
// scores 1.000 there whatever the absolute numbers are, and prizes go to "the
// Top 3 Miners with the highest total normalized scores across all intents".
//
// Two things follow, and neither is obvious from the leaderboard:
//
//   Breadth compounds. The total is a SUM across intents, so a miner serving
//   thirteen intents at 0.55 each beats one serving three at 0.95. Our rank
//   inside an intent matters far less than how many intents we are in.
//
//   Being close to the leader is worth nearly as much as being the leader.
//   Where every honest miner sits in the same narrow band — which is most
//   weather intents, because the champion module is near-binary — second place
//   normalizes to ~0.9 and costs almost nothing.
//
// The 25 points for X are not readable from any API. Neither is the guardrail
// (an intent needs 3+ active miners AND 100+ real requests from Track 3 apps to
// be eligible for cash), so `requests` below is context, not a criterion.
//
// Public reads only. This spends nothing — unlike most of agent/, which pays
// per run through x402.

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { NODE, miners } from "./telegraph.mjs";
import { has, reject } from "./args.mjs";

const US = "amanat-weather-risk";
const OUR_ADDRESS = "0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e";
const OUT = new URL("../standing.json", import.meta.url);

export async function standing() {
  const all = await miners();
  const active = all.filter((m) => m.activation_status === "active");

  // Every intent, every active miner's latest score in it.
  const byIntent = new Map();
  for (const m of active) {
    for (const s of m.scores ?? []) {
      if (!byIntent.has(s.intent_id)) byIntent.set(s.intent_id, []);
      byIntent.get(s.intent_id).push({ slug: m.slug, score: s.score ?? 0, epoch: s.epoch_id });
    }
  }

  // Normalized per intent, then summed per miner — the rubric's own arithmetic.
  const totals = new Map();
  const ours = [];
  for (const [intent, rows] of byIntent) {
    rows.sort((a, b) => b.score - a.score);
    const top = rows[0].score;
    for (const r of rows) {
      const normalized = top > 0 ? r.score / top : 0;
      if (!totals.has(r.slug)) totals.set(r.slug, { sum: 0, intents: 0 });
      const t = totals.get(r.slug);
      t.sum += normalized;
      t.intents++;
      if (r.slug === US) {
        ours.push({
          intent,
          epoch: r.epoch,
          rank: rows.findIndex((x) => x.slug === US) + 1,
          of: rows.length,
          score: r.score,
          normalized,
          leader: rows[0].slug,
          leader_score: top,
          // A leader inside the same band as everyone else has not cleared the
          // ground truth either, and the order among the rest is chance
          // overlap. One orders of magnitude clear has actually solved it.
          leader_cleared_the_band: top >= 0.5,
        });
      }
    }
  }

  const board = [...totals.entries()]
    .map(([slug, t]) => ({ slug, total: t.sum, avg: t.sum / t.intents, intents: t.intents }))
    .sort((a, b) => b.total - a.total);
  const rank = board.findIndex((r) => r.slug === US) + 1;
  // The rubric says "total normalized scores across all intents" without saying
  // whether that is a sum or an average, and the two invert the strategy — so
  // both are printed rather than one being chosen for you. A sum rewards
  // breadth; an average rewards quality and is dragged down by a weak new
  // intent. The rules' own justification — "the best Miner in every intent has
  // a fair chance to win, regardless of how strict or easy their intent's
  // Canonical Script is" — only holds under an average: under a sum a
  // one-intent specialist can never beat a thirteen-intent generalist.
  const avgBoard = board.filter((r) => r.intents >= 3).sort((a, b) => b.avg - a.avg);
  const avgRank = avgBoard.findIndex((r) => r.slug === US) + 1;

  const served = all
    .map((m) => ({ slug: m.slug, requests: m.total_requests_served ?? 0 }))
    .sort((a, b) => b.requests - a.requests);

  const wasm = await (await fetch(`${NODE}/api/wasm`)).json();
  const slots = Object.entries(wasm.intents ?? {})
    .filter(([, v]) => v.champion?.author_address?.toLowerCase() === OUR_ADDRESS)
    .map(([intent]) => intent);

  return {
    read_at: new Date().toISOString(),
    track1: {
      rank,
      of: board.length,
      avg_rank: avgRank,
      avg_of: avgBoard.length,
      avg: (totals.get(US)?.sum ?? 0) / (totals.get(US)?.intents || 1),
      avg_leaders: avgBoard.slice(0, 3).map((r) => ({ slug: r.slug, avg: r.avg, intents: r.intents })),
      total: totals.get(US)?.sum ?? 0,
      intents: ours.sort((a, b) => b.normalized - a.normalized),
      leaders: board.slice(0, 5),
      // What one more intent at the median would be worth, since the total is
      // a sum: the cheapest point on the board is an intent we are not in.
      median_intent_worth: ours.length
        ? ours.reduce((a, b) => a + b.normalized, 0) / ours.length
        : 0,
    },
    requests: {
      rank: served.findIndex((r) => r.slug === US) + 1,
      of: served.length,
      ours: served.find((r) => r.slug === US)?.requests ?? 0,
    },
    track2: { slots_held: slots, intents_on_board: Object.keys(wasm.intents ?? {}).length },
  };
}

function print(s) {
  const t = s.track1;
  console.log(`\namanat standing — ${s.read_at.slice(0, 16).replace("T", " ")} UTC`);
  console.log(`rubric: 75% normalized performance + 25% X engagement (hackathon.telegraphprotocol.com/rules)\n`);

  console.log(`TRACK 1 read as a SUM       ${t.total.toFixed(3)}   rank ${t.rank} of ${t.of}`);
  console.log(`TRACK 1 read as an AVERAGE  ${t.avg.toFixed(3)}   rank ${t.avg_rank} of ${t.avg_of} (miners on 3+ intents)`);
  console.log(`  The rubric does not say which. A sum rewards breadth; an average`);
  console.log(`  rewards quality, and a weak new intent drags it down.`);
  for (const r of t.avg_leaders) {
    console.log(`   avg ${r.avg.toFixed(3)}  ${r.slug.padEnd(28)}${String(r.intents).padStart(2)} intents`);
  }
  console.log("");
  for (const r of t.leaders) {
    const mark = r.slug === "amanat-weather-risk" ? " <- us" : "";
    console.log(`   ${r.total.toFixed(3).padStart(6)}  ${r.slug.padEnd(28)}${String(r.intents).padStart(2)} intents${mark}`);
  }

  console.log(`\n  our intents (epoch ${t.intents[0]?.epoch ?? "?"}):`);
  for (const i of t.intents) {
    console.log(`   ${i.normalized.toFixed(3)}  ${i.intent.padEnd(18)} #${i.rank} of ${i.of}   ${i.score.toFixed(6)}`);
    if (!i.leader_cleared_the_band) {
      console.log(`          nobody has cleared the band here — this order is epoch noise`);
    } else {
      console.log(`          ${i.leader} has cleared the band at ${i.leader_score.toFixed(4)} — real, and worth studying`);
    }
  }

  console.log(`\n  A fourth intent at our median (${t.median_intent_worth.toFixed(3)}) would add more`);
  console.log(`  than winning any single one of the three outright.`);

  console.log(`\nCONTEXT — requests served: #${s.requests.rank} of ${s.requests.of} (${s.requests.ours}).`);
  console.log(`  Not one of the two weighted criteria, but it feeds the guardrail:`);
  console.log(`  an intent needs 100+ real requests from Track 3 apps to pay cash.`);
  console.log(`TRACK 2 — champion slots held: ${s.track2.slots_held.join(", ") || `none of ${s.track2.intents_on_board}`}`);
  console.log(`\nThe other 25 points are on X and no API can read them. See docs/x-posts.md.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  reject(argv, ["--json"]);
  const s = await standing();
  if (has(argv, "--json")) {
    await writeFile(OUT, `${JSON.stringify(s, null, 2)}\n`);
    console.log(`standing.json written — rank ${s.track1.rank} of ${s.track1.of}, total ${s.track1.total.toFixed(3)}`);
  } else {
    print(s);
  }
}
