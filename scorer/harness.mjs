// Load any Telegraph scoring module the way a validator node does, and report
// the same numbers the node records on a registration.
//
//   node scorer/harness.mjs <module.wasm> [more.wasm ...]
//   node scorer/harness.mjs --attacks <module.wasm> [more.wasm ...]
//   node scorer/harness.mjs --case "question" "ground truth" "answer" <module.wasm>
//
// Champion binaries are public (their wasm_url is in /api/wasm), so the same
// harness runs ours and theirs over one corpus — which is the only honest way
// to know whether a change is an improvement before spending gas on it.

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A scoring module: no imports, three exports, strings written through its own alloc. */
export async function load(path) {
  const { instance } = await WebAssembly.instantiate(await readFile(path), {});
  const { memory, alloc, rank_answer } = instance.exports;
  if (typeof alloc !== "function" || typeof rank_answer !== "function") {
    throw new Error(`${path}: missing alloc/rank_answer export`);
  }

  const write = (s) => {
    const bytes = new TextEncoder().encode(s);
    const ptr = alloc(bytes.length);
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
    return [ptr, bytes.length];
  };

  return {
    name: basename(path),
    score(question, groundTruth, answer) {
      // Order matters and never changes: question, ground truth, miner answer.
      const [qp, ql] = write(question);
      const [gp, gl] = write(groundTruth);
      const [mp, ml] = write(answer);
      return rank_answer(qp, ql, gp, gl, mp, ml);
    },
  };
}

/** The node's Stage 2 metrics, computed over a good/bad benchmark. */
export function evaluate(mod, cases) {
  let wins = 0;
  let marginSum = 0;
  let worstSelf = 1;
  const all = [];

  for (const c of cases) {
    const good = mod.score(c.question, c.ground_truth, c.good);
    const bad = mod.score(c.question, c.ground_truth, c.bad);
    const self = mod.score(c.question, c.ground_truth, c.ground_truth);
    if (good > bad) wins++;
    marginSum += good - bad;
    if (self < worstSelf) worstSelf = self;
    all.push(good, bad);
  }

  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const stddev = Math.sqrt(all.reduce((a, b) => a + (b - mean) ** 2, 0) / all.length);

  return {
    margin: marginSum / cases.length,
    wins,
    cases: cases.length,
    worst_self_match: worstSelf,
    score_stddev: stddev,
  };
}

/**
 * Rank agreement with the incumbent — the Stage 2 gate nobody talks about.
 *
 * Beating the champion's margin is not enough on an intent that carries
 * traffic: the node also checks that your module orders *real* miner answers
 * roughly the way the champion does, and rejects you below about 0.60. That is
 * why a 0.68-margin module was turned down on WEB_SEARCH while a 0.388 one went
 * live. Registrations are gas, so it is worth knowing before you send one.
 *
 * We cannot see the node's historical corpus, so we approximate it: for every
 * benchmark case, score a ladder of answers from perfect to empty with both
 * modules and measure Spearman's rho between the two orderings.
 */
export function agreement(candidate, champion, cases) {
  const perCase = cases.map((c) => {
    const ladder = [
      c.ground_truth,
      c.good,
      `${c.good} Hope this helps!`,
      c.bad,
      c.question,
      "",
    ];
    const a = ladder.map((x) => candidate.score(c.question, c.ground_truth, x));
    const b = ladder.map((x) => champion.score(c.question, c.ground_truth, x));
    return { intent: c.intent, rho: spearman(a, b) };
  });
  const mean = perCase.reduce((s, r) => s + r.rho, 0) / perCase.length;
  return { mean, perCase };
}

/** Ranks with ties averaged, so a module that flattens a pair is not punished twice. */
function rankOf(xs) {
  const order = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const ranks = new Array(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = shared;
    i = j + 1;
  }
  return ranks;
}

export function spearman(a, b) {
  const ra = rankOf(a);
  const rb = rankOf(b);
  const n = a.length;
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / n;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  // No spread on one side means the two cannot be said to disagree.
  if (da === 0 || db === 0) return 1;
  return num / Math.sqrt(da * db);
}

/** Attacks: each must score BELOW the honest answer on the same question. */
export function attackReport(mod, attacks) {
  return attacks.map((a) => {
    const honest = mod.score(a.question, a.ground_truth, a.good);
    const attack = mod.score(a.question, a.ground_truth, a.attack);
    return { name: a.name, honest, attack, held: attack < honest };
  });
}

const fmt = (x) => x.toFixed(4).padStart(7);

async function main() {
  const args = process.argv.slice(2);
  const attacksMode = args.includes("--attacks");
  const caseMode = args.indexOf("--case");

  if (caseMode !== -1) {
    const [q, gt, ma] = args.slice(caseMode + 1, caseMode + 4);
    for (const p of args.slice(caseMode + 4)) {
      const m = await load(p);
      console.log(`${m.name.padEnd(34)} ${fmt(m.score(q, gt, ma))}`);
    }
    return;
  }

  const agreeMode = args.includes("--agreement");
  const paths = args.filter((a) => a.endsWith(".wasm"));
  if (!paths.length) {
    console.error("usage: node scorer/harness.mjs [--attacks] <module.wasm> [...]");
    process.exit(2);
  }

  const bench = JSON.parse(await readFile(join(HERE, "bench.json"), "utf8"));

  // Where do we lose? Stage 2 needs wins >= champion AND margin >= champion,
  // so a case the champion orders correctly and we do not is a hard blocker.
  if (args.includes("--diff")) {
    if (paths.length < 2) {
      console.error("usage: node scorer/harness.mjs --diff <candidate.wasm> <champion.wasm>");
      process.exit(2);
    }
    const cand = await load(paths[0]);
    const champ = await load(paths[1]);
    console.log(`${cand.name} vs ${champ.name}\n`);
    for (const c of bench.cases) {
      const cg = cand.score(c.question, c.ground_truth, c.good);
      const cb = cand.score(c.question, c.ground_truth, c.bad);
      const hg = champ.score(c.question, c.ground_truth, c.good);
      const hb = champ.score(c.question, c.ground_truth, c.bad);
      const weWin = cg > cb;
      const theyWin = hg > hb;
      if (weWin && theyWin) continue;
      const tag = !weWin && theyWin ? "BLOCKER" : !weWin && !theyWin ? "both lose" : "we win, they lose";
      console.log(`  ${tag.padEnd(18)} ${c.intent}`);
      console.log(`    ours   good ${fmt(cg)}  bad ${fmt(cb)}`);
      console.log(`    champ  good ${fmt(hg)}  bad ${fmt(hb)}`);
      console.log(`    q:    ${c.question}`);
      console.log(`    gt:   ${c.ground_truth}`);
      console.log(`    good: ${c.good}`);
      console.log(`    bad:  ${c.bad}\n`);
    }
    return;
  }

  if (agreeMode) {
    if (paths.length < 2) {
      console.error("usage: node scorer/harness.mjs --agreement <candidate.wasm> <champion.wasm>");
      process.exit(2);
    }
    const cand = await load(paths[0]);
    for (const p of paths.slice(1)) {
      const champ = await load(p);
      const { mean, perCase } = agreement(cand, champ, bench.cases);
      const worst = [...perCase].sort((a, b) => a.rho - b.rho).slice(0, 3);
      const verdict = mean >= 0.6 ? "above the ~0.60 gate" : "BELOW the ~0.60 gate — likely rejected on a trafficked intent";
      console.log(`\n${cand.name} vs ${champ.name}`);
      console.log(`  mean rank agreement ${fmt(mean)}  ${verdict}`);
      console.log(`  weakest cases: ${worst.map((w) => `${w.intent} ${w.rho.toFixed(2)}`).join(", ")}`);
    }
    return;
  }

  if (attacksMode) {
    for (const p of paths) {
      const mod = await load(p);
      const rows = attackReport(mod, bench.attacks);
      const held = rows.filter((r) => r.held).length;
      console.log(`\n${mod.name} — attacks held ${held}/${rows.length}`);
      console.log("  " + "attack".padEnd(34) + "honest   attack   verdict");
      for (const r of rows) {
        console.log(`  ${r.name.padEnd(34)}${fmt(r.honest)}  ${fmt(r.attack)}   ${r.held ? "held" : "LEAKS"}`);
      }
    }
    return;
  }

  console.log("module".padEnd(34) + "margin    wins  self-match  stddev");
  for (const p of paths) {
    const mod = await load(p);
    const e = evaluate(mod, bench.cases);
    console.log(
      mod.name.padEnd(34) + fmt(e.margin) + "  " +
      `${e.wins}/${e.cases}`.padStart(6) + "   " + fmt(e.worst_self_match) + "  " + fmt(e.score_stddev)
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
