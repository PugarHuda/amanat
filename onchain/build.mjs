// Compile the contract and emit the artefacts the deploy script reads.
//
//   npm run build:contract
//
// forge owns the build. The ABI and bytecode are committed because
// agent/deploy.mjs needs them at runtime and nothing else in the repo runs a
// Solidity compiler — so a checkout can deploy without installing one.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

execFileSync("forge", ["build"], { cwd: HERE, stdio: "inherit" });

const artefact = JSON.parse(readFileSync(join(HERE, "out/Amanat.sol/Amanat.json"), "utf8"));
const bytecode = artefact.bytecode.object.replace(/^0x/, "");

writeFileSync(join(HERE, "Amanat.abi.json"), JSON.stringify(artefact.abi));
writeFileSync(join(HERE, "Amanat.bin"), bytecode);

console.log(`wrote Amanat.abi.json (${artefact.abi.length} entries) and Amanat.bin (${bytecode.length / 2} bytes)`);
