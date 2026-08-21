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

const NODE = process.env.TELEGRAPH_NODE ?? "https://devnode.telegraphprotocol.com";
const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://4everland.io/ipfs/",
];

// Intents whose id is keccak256(name) — the protocol picks the miner for these.
// Anything else needs a registration-derived intentId, which pins one miner.
const NAME_HASHED = new Set([
  "LANGUAGE_GENERATION", "CHAT_COMPLETION", "WEATHER_CHECK", "STORM_ALERT",
  "WEATHER_FORECAST", "TASK_COMPLETION", "AGENT_TASK", "WEB_SEARCH",
  "NEWS_SEARCH", "FACT_CHECK", "AI_TEXT_DETECTION", "CONTENT_VERIFICATION",
  "DEEPFAKE_DETECTION", "MEDIA_AUTHENTICITY_CHECK", "IMAGE_VERIFICATION",
  "VIDEO_VERIFICATION",
]);

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
  const miners = await (await fetch(`${NODE}/api/miners`)).json();
  const cache = await loadCache();
  const rows = [];

  // ponytail: 8 at a time — polite to IPFS gateways, still finishes in seconds.
  const queue = [...miners];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const m = queue.shift();
      const yaml = cache[m.yaml_url] ?? await fetchText(yamlUrlToHttp(m.yaml_url));
      if (yaml) cache[m.yaml_url] = yaml;
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
  await saveCache(cache);
  rows.sort((a, b) => Number(a.id) - Number(b.id));

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const jobable = rows.filter((r) => r.has_request);
  const both = jobable.filter((r) => r.routable_by_name);
  const unreachable = rows.filter((r) => !r.yaml_reachable);

  console.log(`\nMiner terdaftar          : ${rows.length}`);
  console.log(`YAML tidak terjangkau    : ${unreachable.length}`);
  console.log(`Punya blok on_chain      : ${rows.filter((r) => r.has_on_chain).length}`);
  console.log(`Job-able (on_chain.request): ${jobable.length}`);
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
  if (!both.length) console.log("  (belum ada — lihat README: inilah celah yang Amanat isi)");
}

main().catch((e) => { console.error(e); process.exit(1); });
