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

  const paths = args.filter((a) => a.endsWith(".wasm"));
  if (!paths.length) {
    console.error("usage: node scorer/harness.mjs [--attacks] <module.wasm> [...]");
    process.exit(2);
  }

  const bench = JSON.parse(await readFile(join(HERE, "bench.json"), "utf8"));

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
