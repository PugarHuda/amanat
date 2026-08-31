// Build every profile into scorer/dist/ and print its hash.
//
//   node scorer/build-profiles.mjs
//
// The registry refuses the same bytes twice from one address across all
// intents, so each slot needs its own binary. This makes the set reproducible
// and shows at a glance that the profiles really are distinct builds.

import { execFileSync } from "node:child_process";
import { copyFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "dist");
const BUILT = join(HERE, "target/wasm32-unknown-unknown/release/amanat_scorer.wasm");

const PROFILES = ["", "weather", "forecast", "finance", "verdict", "prose", "authenticity", "authenticity2", "game"];

// keccak256 is what registerWasm commits to; ethers is already a dependency.
const { ethers } = await import("ethers");

mkdirSync(OUT, { recursive: true });
const seen = new Map();

for (const profile of PROFILES) {
  const args = ["build", "--release", "--target", "wasm32-unknown-unknown", "-q"];
  if (profile) args.push("--features", profile);
  execFileSync("cargo", args, { cwd: HERE, stdio: "inherit" });

  const name = `amanat_scorer${profile ? "_" + profile : ""}.wasm`;
  const dest = join(OUT, name);

  // Never overwrite a binary that is already here. Each of these files is the
  // exact bytes some registration committed a keccak256 of, and the node
  // fetches them from this path in the repo — replacing them makes the hash
  // on-chain disagree with what the URL serves. A profile whose behaviour
  // changes needs a new filename, because it needs a new registration anyway:
  // the registry refuses the same bytes twice from one address.
  const stale = existsSync(dest) && !readFileSync(dest).equals(readFileSync(BUILT));
  if (!existsSync(dest)) copyFileSync(BUILT, dest);

  const bytes = readFileSync(dest);
  const hash = ethers.keccak256(bytes);
  const clash = seen.get(hash);
  seen.set(hash, name);
  console.log(`${name.padEnd(32)} ${String(statSync(dest).size).padStart(6)} bytes  ${hash.slice(0, 18)}…${clash ? `  DUPLICATE OF ${clash}` : ""}${stale ? "  kept — this build differs; a changed profile needs a new name" : ""}`);
}

console.log(`\n${seen.size} distinct binaries from ${PROFILES.length} profiles.`);
if (seen.size !== PROFILES.length) {
  console.error("a profile produced identical bytes to another — the registry will refuse the second");
  process.exit(1);
}
