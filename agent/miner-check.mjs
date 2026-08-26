// Is the deployed miner actually reachable the way Telegraph's node will reach
// it — anonymously, following nothing?
//
//   npm run miner:check
//
// `fetch` follows redirects by default, so a naive check reads the SSO login
// page as a 200 and reports a gated miner as ready. That is worse than no
// check: registration is terminal, and a miner whose endpoints fail the node's
// sandbox test is rejected with no retry.

import { reject } from "./args.mjs";

const BASE = process.env.AMANAT_MINER_URL ?? "https://amanat-miner.vercel.app";

async function probe(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, redirect: "manual" });
  const body = await res.text();
  return { status: res.status, body, location: res.headers.get("location") };
}

try {
  reject(process.argv.slice(2), []);
} catch (e) {
  // Top-level throw prints a stack trace, which tells a reader nothing they can
  // act on. The message is the whole content of this failure.
  console.error(e.message);
  process.exit(2);
}

const health = await probe("/health");
if (health.status !== 200) {
  console.log(`${BASE}/health -> ${health.status}`);
  if (health.location?.includes("sso") || health.location?.includes("vercel.com")) {
    console.log("\nThis is Vercel Deployment Protection, not a bug in the miner.");
    console.log("Project Settings -> Deployment Protection -> Vercel Authentication -> Disabled -> Save.");
  } else if (health.location) {
    console.log(`redirects to ${health.location}`);
  }
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(health.body);
} catch {
  console.log(`/health returned 200 but not JSON — something other than the miner is answering:\n${health.body.slice(0, 160)}`);
  process.exit(1);
}
if (parsed.status !== "ok" || parsed.miner !== "amanat") {
  console.log(`/health answered, but not as the Amanat miner: ${health.body.slice(0, 160)}`);
  process.exit(1);
}

// The endpoint the YAML declares has to work too, not just health.
const forecast = await probe("/forecast", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ lat: -6.2, lon: 106.85, hours: 1 }),
});
if (forecast.status !== 200) {
  console.log(`/health ok, but POST /forecast -> ${forecast.status}`);
  process.exit(1);
}

console.log(`${BASE}`);
console.log(`  GET  /health   200  ${health.body.slice(0, 80)}`);
console.log(`  POST /forecast 200  ${forecast.body.slice(0, 110)}`);
console.log(`\nready: run npm run register:miner`);
