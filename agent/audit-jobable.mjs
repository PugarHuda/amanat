// Audit which live Telegraph miners can actually be targeted by an ERC-8183 job.
//
// A job hands the node raw OnChainData arrays; the node can only build the HTTP
// call if the miner's YAML declares an `on_chain.request` block. Miners without
// one serve HTTP/WebSocket traffic fine but are invisible to the on-chain rail.
// Nothing in the public API exposes this, so we fetch every registered YAML.
//
//   node agent/audit-jobable.mjs            # human table
//   node agent/audit-jobable.mjs --json     # machine output for the agent
//
// ponytail: hand-rolled indent scan instead of a YAML parser — we need three
// keys, not a document model. Swap in `yaml` if we ever need real parsing.

import { writeFile } from "node:fs/promises";
import { miners, NAME_HASHED_INTENTS } from "./telegraph.mjs";
import { reject } from "./args.mjs";

const NAME_HASHED = new Set(NAME_HASHED_INTENTS);
const OUT = new URL("../jobable.json", import.meta.url);
const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://4everland.io/ipfs/",
];

function yamlUrlToHttp(url) {
  if (!url) return [];
  if (url.startsWith("ipfs://")) {
    const cid = url.slice("ipfs://".length);
    return IPFS_GATEWAYS.map((g) => g + cid);
  }
  return [url];
}

/** Return the block of lines nested under a top-level `key:` (2-space YAML). */
function topLevelBlock(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(key + ":"));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || l.startsWith("#")) { out.push(l); continue; }
    if (!/^\s/.test(l)) break; // dedented back to top level
    out.push(l);
  }
  return out.join("\n");
}

async function fetchText(urls, timeoutMs = 20000) {
  for (const u of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(u, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return await res.text();
    } catch { /* try the next gateway */ }
  }
  return null;
}

// ponytail: public IPFS gateways rate-limit, so a single run reaches maybe two
// thirds of the YAMLs. Cache by url and every re-run fills in more of the map.
const CACHE = new URL("../.yaml-cache.json", import.meta.url);
async function loadCache() {
  try { return JSON.parse(await (await import("node:fs/promises")).readFile(CACHE, "utf8")); }
  catch { return {}; }
}
async function saveCache(c) {
  const fs = await import("node:fs/promises");
  await fs.writeFile(CACHE, JSON.stringify(c));
}

async function main() {
  reject(process.argv.slice(2), ["--json"]);
  const catalogue = await miners();
  const cache = await loadCache();
  const rows = [];

  // ponytail: 8 at a time — polite to IPFS gateways, still finishes in seconds.
  const queue = [...catalogue];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const m = queue.shift();
      // Cache the promise, not the result. Reading the cache, awaiting a fetch
      // and then writing it back leaves a gap in which another worker reads a
      // miss for the same URL and fetches it a second time — the miners share
      // gateways, so that is a duplicate round trip to somebody else's IPFS.
      cache[m.yaml_url] ??= fetchText(yamlUrlToHttp(m.yaml_url));
      const yaml = await cache[m.yaml_url];
      const onChain = yaml ? topLevelBlock(yaml, "on_chain") : null;
      rows.push({
        id: m.id,
        slug: m.slug,
        intents: m.supported_intents ?? [],
        yaml_url: m.yaml_url,
        yaml_reachable: yaml !== null,
        has_on_chain: onChain !== null,
        has_request: onChain !== null && /^\s+request:/m.test(onChain),
        has_fields: onChain !== null && /^\s+fields:/m.test(onChain),
        transform: onChain?.match(/^\s+transform:\s*(\S+)/m)?.[1] ?? null,
        routable_by_name: (m.supported_intents ?? []).some((i) => NAME_HASHED.has(i)),
      });
    }
  });
  await Promise.all(workers);
  // Resolve before writing. The cache holds promises so that concurrent workers
  // share one fetch, and JSON.stringify turns a promise into `{}` — so the run
  // that populated the cache also poisoned it, and every later run read `{}`
  // back and died in topLevelBlock with "text.split is not a function".
  await saveCache(Object.fromEntries(
    await Promise.all(Object.entries(cache).map(async ([url, v]) => [url, await v])),
  ));
  rows.sort((a, b) => Number(a.id) - Number(b.id));

  // --json publishes the finding rather than the working data. The rows are a
  // hundred YAML reads; what a reader needs is which intents an on-chain job
  // cannot survive, and who on each one can actually receive it.
  if (process.argv.includes("--json")) {
    const summary = await deadIntents(rows, { quiet: true });
    await writeFile(OUT, JSON.stringify({ ...summary, miners: rows }, null, 2) + "\n");
    console.log(`wrote      jobable.json — ${summary.dead.length} of ${summary.scored_name_hashed_intents} intents closed`);
    return;
  }

  const jobable = rows.filter((r) => r.has_request);
  const both = jobable.filter((r) => r.routable_by_name);
  const unreachable = rows.filter((r) => !r.yaml_reachable);

  console.log(`\nMiner terdaftar          : ${rows.length}`);
  console.log(`YAML unreachable            ${unreachable.length}`);
  console.log(`declare an on_chain block   ${rows.filter((r) => r.has_on_chain).length}`);
  console.log(`job-able (on_chain.request) ${jobable.length}`);
  console.log(`Job-able DAN routable lewat keccak256(nama intent): ${both.length}\n`);

  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(w("id", 9) + w("slug", 32) + w("job-able", 10) + w("byName", 8) + "intents");
  for (const r of rows) {
    console.log(
      w(r.id, 9) + w(r.slug, 32) +
      w(r.has_request ? "ya" : (r.yaml_reachable ? "-" : "?yaml"), 10) +
      w(r.routable_by_name ? "ya" : "-", 8) +
      r.intents.join(",").slice(0, 60)
    );
  }

  console.log(`\nTarget job yang sah (protokol yang memilih miner, bukan kita):`);
  const byIntent = {};
  for (const r of both) for (const i of r.intents) if (NAME_HASHED.has(i)) (byIntent[i] ??= []).push(r.slug);
  for (const [i, slugs] of Object.entries(byIntent).sort()) {
    console.log(`  ${w(i, 26)} ${slugs.length} miner: ${slugs.join(", ")}`);
  }
  if (!both.length) console.log("  (none yet — this is the gap Amanat fills)");

  await deadIntents(rows);
}

/**
 * The intents whose on-chain rail is dead, and why.
 *
 * A job is routed by rank. Nothing in that path checks whether the miner it
 * lands on can receive a job at all — so when the highest-ranked miner on an
 * intent declares no `on_chain.request` block, every job for that intent goes
 * to it, the node has no mapping to build a call from, and it falls back to the
 * miner's first endpoint with no parameters.
 *
 * Measured, not inferred. Four ERC-8183 jobs from this repo (15, 16, 18 on
 * STORM_ALERT and 17 on WEATHER_FORECAST) were all answered by `livecert`,
 * rank 1 on STORM_ALERT, ten endpoints, no on_chain block — every one of them
 * with the same reply from its *first* endpoint, `/ssl-check`:
 * "No hostname was supplied with this request."
 *
 * The uncomfortable part is that rank causes it. Rank is earned on the
 * off-chain rail, where a generalist serving ten intents does well; that same
 * rank then routes on-chain jobs to a miner that cannot serve one. The better a
 * generalist ranks, the more completely the on-chain rail closes behind it.
 */
async function deadIntents(rows, { quiet = false } = {}) {
  const jobable = new Set(rows.filter((r) => r.has_request && r.routable_by_name).map((r) => r.slug));
  const all = await miners();

  // rank 1 per intent, from the live scoreboard
  const top = {};
  for (const m of all) {
    for (const sc of m.scores ?? []) {
      const intent = sc.intent_id ?? sc.intent;
      if (!NAME_HASHED.has(intent)) continue;
      if (!top[intent] || sc.rank < top[intent].rank) {
        top[intent] = { rank: sc.rank, slug: m.slug, endpoints: (m.endpoints ?? []).length };
      }
    }
  }

  const dead = Object.entries(top).filter(([, t]) => !jobable.has(t.slug)).sort();
  const summary = {
    read_at: new Date().toISOString(),
    scored_name_hashed_intents: Object.keys(top).length,
    dead: dead.map(([intent, t]) => ({
      intent,
      rank1: t.slug,
      endpoints: t.endpoints,
      declares_on_chain_request: false,
    })),
    jobable_by_intent: Object.fromEntries(
      Object.keys(top).sort().map((i) => [
        i,
        rows.filter((r) => r.has_request && r.routable_by_name && r.intents.includes(i)).map((r) => r.slug),
      ]),
    ),
  };

  if (quiet) return summary;
  console.log(`\nIntents whose rank-1 miner cannot receive an ERC-8183 job:`);
  if (!dead.length) {
    console.log("  none — every leader on a name-hashed intent declares on_chain.request");
    return summary;
  }
  for (const [intent, t] of dead) {
    console.log(`  ${String(intent).padEnd(26)} rank 1 is ${t.slug} (${t.endpoints} endpoint${t.endpoints === 1 ? "" : "s"}, no on_chain.request)`);
  }
  console.log(`\n  ${dead.length} of ${Object.keys(top).length} scored name-hashed intents. A job on one of these`);
  console.log(`  is answered from the leader's first endpoint with no parameters, whatever`);
  console.log(`  it asked for. Measured on jobs 15–18 — see docs/bug-report.md.`);
  return summary;
}

main().catch((e) => { console.error(e); process.exit(1); });
