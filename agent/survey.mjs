// What the network scores, and who decides it (Track 2 reconnaissance).
//
//   node agent/survey.mjs            the table, ranked by where a slot is winnable
//   node agent/survey.mjs --json     the same, written to survey.json
//
// Registering a scoring module is a guess unless you know two things: how weak
// the module currently holding the intent is, and whether that intent produces
// real scores at all. Both are readable for free from `/api/wasm` and
// `/api/miners`, and neither is on the explorer.
//
// This spends nothing. Every other agent script that reaches the node pays.

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { NODE } from "./telegraph.mjs";
import { flag, has, reject } from "./args.mjs";

const OUT = new URL("../survey.json", import.meta.url);

// Our own benchmark margin on `scorer/bench.json`.
//
// ponytail: this is a heuristic, not a like-for-like comparison — our margin is
// measured on our corpus and the champion eval on the protocol's 32 hidden
// fixtures, so the two numbers are not the same scale. It is still the only
// ordering available before spending a registration, and a champion far below
// it is a weaker incumbent than one far above. Replace with real eval scores
// once a registration of ours comes back with one.
const OUR_MARGIN = 0.565;

const pct = (n) => (n === null ? "     —" : n.toFixed(4).padStart(6));

/**
 * Champion per intent, the bar a challenger actually has to clear, and how many
 * slots each author holds.
 *
 * The two numbers are not the same and the difference is the point. A
 * champion's `eval_score` is its *candidate_margin from the day it won* — a
 * historical artefact, frozen. The bar a new registration is measured against
 * is the `champion_margin` recorded on the most recent entry, which is that
 * same champion re-measured on today's corpus.
 *
 * They diverge enormously. WEATHER_FORECAST displays 0.5302 and measures
 * 0.9898: picking targets by the displayed score sends you at the strongest
 * incumbent on the board believing it is the weakest. Four of our own
 * registrations were spent that way.
 *
 * ponytail: `bar` is a lagging proxy, not a prediction, and five registrations
 * on 27 August proved how lagging. Sent half an hour after this survey ran, they
 * were measured against bars of 0.4175, 0.4851, 0.5042, 0.5909 and 0.9920 where
 * this had reported 0.5459, 0.4851, 0.4989, 0.3344 and 0.4935. IP_GEOLOCATION
 * doubled inside thirty minutes; our 0.6677 there would have won comfortably
 * against the figure this printed. The bar is recomputed at evaluation and is
 * not knowable beforehand — which is finding 3 in docs/bug-report.md, not a
 * defect here. Use this to rank targets, never to predict a verdict.
 */
async function champions() {
  const res = await fetch(`${NODE}/api/wasm`);
  if (!res.ok) throw new Error(`wasm registry ${res.status}`);
  const { intents, count } = await res.json();

  const byAuthor = {};
  const map = {};
  for (const [intent, v] of Object.entries(intents)) {
    const c = v.champion;
    if (!c) { map[intent] = null; continue; }

    // Most recent entry carrying a champion_margin: the freshest reading of
    // what the incumbent is currently worth.
    const measured = (v.entries ?? [])
      .filter((e) => e.eval?.champion_margin != null && e.updated_at)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];

    map[intent] = {
      eval: c.eval_score ?? null,
      bar: measured?.eval.champion_margin ?? null,
      barAt: measured?.updated_at?.slice(0, 10) ?? null,
      attempts: (v.entries ?? []).length,
      registration: c.registration_id,
      author: c.author_address,
    };
    byAuthor[c.author_address] = (byAuthor[c.author_address] ?? 0) + 1;
  }
  return { map, byAuthor, registrations: count };
}

/** Live miner scores per intent, from the miner catalogue's embedded scores. */
async function live() {
  const res = await fetch(`${NODE}/api/miners`);
  if (!res.ok) throw new Error(`miner catalogue ${res.status}`);
  const map = {};
  for (const m of await res.json()) {
    for (const s of m.scores ?? []) {
      const k = s.intent_id ?? s.intent;
      if (!k) continue;
      (map[k] ??= []).push(s.score ?? 0);
    }
  }
  return map;
}

/**
 * Join the two catalogues, weakest champion first — the order in which a slot
 * is winnable.
 *
 * An intent with no champion sorts last rather than first: an empty slot reads
 * as eval 0 if you are careless, and that would put the intents nobody scores
 * at the top of a list of things to attack.
 */
export function rank(champ, scores) {
  return Object.keys(champ)
    .map((intent) => {
      const s = scores[intent] ?? [];
      return {
        intent,
        champion: champ[intent],
        live: {
          scored: s.length,
          nonzero: s.filter((x) => x > 0).length,
          best: s.length ? Math.max(...s) : null,
        },
      };
    })
    // By the measured bar, never the displayed score. Sorting on `eval` is the
    // mistake this tool exists to stop someone making.
    .sort((a, b) => (a.champion?.bar ?? a.champion?.eval ?? 2) - (b.champion?.bar ?? b.champion?.eval ?? 2));
}

async function main() {
  reject(process.argv.slice(2), ["--json", "--margin"]);
  const margin = Number(flag(process.argv, "--margin", OUR_MARGIN));
  if (!Number.isFinite(margin)) throw new Error("--margin takes a number");

  const [{ map: champ, byAuthor, registrations }, scores] = await Promise.all([champions(), live()]);
  const rows = rank(champ, scores);

  console.log(`node       ${NODE}`);
  console.log(`registry   ${registrations} registrations ever, ${rows.length} intents\n`);

  console.log("intent                       bar   shown  tries   live best  scored");
  for (const r of rows) {
    const best = r.live.best === null ? "       —"
      : r.live.best < 1e-4 ? r.live.best.toExponential(1).padStart(8)
      : r.live.best.toFixed(6).padStart(8);
    const bar = r.champion?.bar ?? null;
    const mark = bar !== null && bar < margin ? " ←" : "";
    console.log(
      `${r.intent.padEnd(26)} ${pct(bar)}  ${pct(r.champion?.eval ?? null)}  ${String(r.champion?.attempts ?? 0).padStart(4)}  ${best}  ${String(r.live.scored).padStart(3)}${mark}`,
    );
  }

  // Who holds the board. One author across most of it is a fact about the
  // separation gate, not about that author: a challenger has to agree with the
  // incumbent to replace it, which is a rule that preserves whoever arrived first.
  const held = Object.entries(byAuthor).sort((a, b) => b[1] - a[1]);
  console.log(`\nchampion slots held, by author`);
  for (const [addr, n] of held.slice(0, 5)) {
    console.log(`  ${addr}  ${String(n).padStart(2)} of ${rows.length}`);
  }

  // The headline: deterministic intents and prose intents are not on the same
  // scale, and the champion's own evaluation score does not predict which.
  const graded = rows.filter((r) => r.live.best !== null && r.champion?.eval !== null);
  const dead = graded.filter((r) => r.live.best < 0.05);
  const alive = graded.filter((r) => r.live.best >= 0.05);
  console.log(`\nlive scoring`);
  console.log(`  ${alive.length} intents where a miner scores 0.05 or better, best ${Math.max(...alive.map((r) => r.live.best)).toFixed(4)}`);
  console.log(`  ${dead.length} intents where the best miner is under 0.05, worst ${Math.min(...dead.map((r) => r.live.best)).toExponential(2)}`);
  const evalOfDead = dead.reduce((a, r) => a + r.champion.eval, 0) / (dead.length || 1);
  console.log(`  mean champion eval on those ${dead.length}: ${evalOfDead.toFixed(4)} — the gate that awarded the slot`);
  console.log(`    does not predict what the module does to a real answer.`);

  // How far the displayed score has drifted from the bar it is meant to describe.
  const drift = rows
    .filter((r) => r.champion?.bar != null && r.champion.eval != null)
    .map((r) => ({ intent: r.intent, d: r.champion.bar - r.champion.eval }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log(`\nwhere the displayed champion score misleads most`);
  for (const { intent, d } of drift.slice(0, 5)) {
    console.log(`  ${intent.padEnd(26)} ${d > 0 ? "harder" : "easier"} than shown by ${Math.abs(d).toFixed(4)}`);
  }

  const targets = rows.filter((r) => r.champion?.bar != null && r.champion.bar < margin);
  console.log(`\n${targets.length} intent(s) whose last measured bar was under ${margin}:`);
  console.log(`  ${targets.map((r) => `${r.intent} ${r.champion.bar.toFixed(4)}`).join(", ") || "none"}`);
  console.log(`\nThat is the separation gate only. A registration must also match the`);
  console.log(`champion's ordering on fixtures and agree with its ranking of real answers`);
  console.log(`at 0.60 or better — three gates, each able to reject on its own.`);
  console.log(`\nAnd the bar is a last reading, not a forecast: it is recomputed when your`);
  console.log(`registration is evaluated. On 27 August one of these moved from 0.4935 to`);
  console.log(`0.9920 inside half an hour. Rank targets with it; do not bet on it.`);

  if (has(process.argv, "--json")) {
    const read_at = new Date().toISOString();
    await writeFile(OUT, JSON.stringify({ read_at, node: NODE, registrations, held, rows }, null, 2) + "\n");
    console.log(`\nwrote      survey.json — ${rows.length} intents`);
  }
}

// Importing this module must never start asking the network questions; rank()
// is the part worth testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
