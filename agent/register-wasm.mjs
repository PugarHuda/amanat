// Register the scoring module on-chain (Track 2).
//
//   node --env-file=.env agent/register-wasm.mjs STORM_ALERT --dry
//   node --env-file=.env agent/register-wasm.mjs STORM_ALERT
//
// Registration costs gas and nothing else, but a rejection is recorded against
// the registration id and the same binary cannot be re-registered from the same
// address while it is active. So this verifies, in order:
//
//   1. the URL serves bytes whose keccak256 matches what we are committing,
//   2. the intent is canonical on-chain,
//   3. the call actually simulates.
//
// Any of those failing costs nothing. Skipping them costs a registration.

import { ethers } from "ethers";
import { wallet, provider, DIAMOND } from "./telegraph.mjs";

const WASM_URL = process.env.AMANAT_WASM_URL
  ?? "https://raw.githubusercontent.com/PugarHuda/amanat/main/scorer/dist/amanat_scorer.wasm";

const ABI = [
  "function registerWasm(bytes32 wasmHash, string wasmUrl, string intent) returns (uint256)",
  "function isCanonicalIntent(string) view returns (bool)",
  "function deregisterEntity(uint256 registrationId, uint8 entityType)",
];

async function main() {
  const intent = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (!intent) {
    console.error("usage: node --env-file=.env agent/register-wasm.mjs <INTENT> [--dry]");
    process.exit(2);
  }

  // 1 — the bytes the node will fetch, hashed the way the node hashes them.
  const res = await fetch(WASM_URL);
  if (!res.ok) throw new Error(`wasm url ${res.status} — the node has to be able to fetch this`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const wasmHash = ethers.keccak256(bytes);
  console.log(`url        ${WASM_URL}`);
  console.log(`bytes      ${bytes.length}`);
  console.log(`keccak256  ${wasmHash}`);

  // A module with host imports cannot instantiate in the node's sandbox, and
  // that failure only shows up after the registration is spent.
  const { instance } = await WebAssembly.instantiate(bytes, {});
  for (const fn of ["alloc", "dealloc", "rank_answer"]) {
    if (typeof instance.exports[fn] !== "function") throw new Error(`missing export: ${fn}`);
  }
  console.log(`exports    alloc, dealloc, rank_answer present; instantiated with no imports`);

  const signer = wallet();
  const address = await signer.getAddress();
  const d = new ethers.Contract(DIAMOND, ABI, signer);

  // 2 — an intent that is not canonical reverts the whole call.
  const canonical = await new ethers.Contract(DIAMOND, ABI, provider()).isCanonicalIntent(intent);
  console.log(`intent     ${intent} — canonical: ${canonical}`);
  if (!canonical) throw new Error(`${intent} is not canonical on-chain`);

  // 3 — simulate before spending.
  const gas = await d.registerWasm.estimateGas(wasmHash, WASM_URL, intent);
  const fee = await provider().getFeeData();
  const cost = gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
  console.log(`signer     ${address}`);
  console.log(`gas        ${gas} units, about ${ethers.formatEther(cost)} ETH\n`);

  if (dry) {
    console.log("--dry: simulated only, nothing sent.");
    return;
  }

  const tx = await d.registerWasm(wasmHash, WASM_URL, intent);
  console.log(`sent       ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`mined      block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  console.log(`explorer   https://sepolia.basescan.org/tx/${tx.hash}`);
  console.log(`\nstatus lands within a few minutes while the node fetches and benchmarks it:`);
  console.log(`  curl -s https://devnode.telegraphprotocol.com/api/wasm | jq '.intents.${intent}'`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
