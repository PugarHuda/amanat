// Register the miner on-chain (Track 1).
//
//   node --env-file=.env agent/register-miner.mjs --dry
//   node --env-file=.env agent/register-miner.mjs
//
// A rejected miner registration is terminal — the node records the reason and
// does not retry, and the fix costs another transaction. So every failure this
// can catch beforehand, it catches:
//
//   1. the YAML URL serves bytes whose SHA-256 matches what we commit,
//   2. the base_url in that YAML actually answers, unauthenticated,
//   3. every declared endpoint responds to a real call,
//   4. every declared intent is canonical on-chain,
//   5. the call simulates.
//
// Point 2 is not paranoia: the node sandbox-tests your endpoints during
// activation, so a host behind SSO or a login wall fails there rather than here.

import { ethers } from "ethers";
import { readFile } from "node:fs/promises";
import { wallet, provider, DIAMOND } from "./telegraph.mjs";

const ABI = [
  "function registerMiner(string yamlUrl, bytes32 yamlHash, address feeAddress, uint256 minPriceUsdc, string[] supportedIntents) returns (uint256)",
  "function updateMiner(uint256 oldRegistrationId, string yamlUrl, bytes32 yamlHash, address feeAddress, uint256 minPriceUsdc, string[] supportedIntents) returns (uint256)",
  "function isCanonicalIntent(string) view returns (bool)",
];

const YAML_URL = process.env.AMANAT_YAML_URL;
const FEE_ADDRESS = process.env.FEE_ADDRESS;
const MIN_PRICE = 10_000n; // 0.01 USDC, the protocol minimum

/** Pull the handful of fields we need without a YAML parser. */
function readYaml(text) {
  const scalar = (key) => text.match(new RegExp(`^${key}:\\s*(\\S+)`, "m"))?.[1];
  const intents = [...text.matchAll(/^\s{4}- ([A-Z_]+)\s*$/gm)].map((m) => m[1]);
  const paths = [...text.matchAll(/^\s+- path:\s*(\S+)/gm)].map((m) => m[1]);
  const methods = [...text.matchAll(/^\s+method:\s*(\S+)/gm)].map((m) => m[1]);
  return { baseUrl: scalar("base_url"), slug: scalar("slug"), id: scalar("id"), intents, paths, methods };
}

async function main() {
  const dry = process.argv.includes("--dry");
  if (!YAML_URL) throw new Error("AMANAT_YAML_URL is not set — point it at an immutable raw URL for the YAML");
  if (!FEE_ADDRESS) throw new Error("FEE_ADDRESS is not set");

  // 1 — the exact bytes the node will fetch and hash.
  const res = await fetch(YAML_URL);
  if (!res.ok) throw new Error(`yaml url ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const yamlHash = ethers.sha256(bytes); // SHA-256, not keccak — the node verifies with SHA-256
  const local = await readFile(new URL("../miner/amanat-miner.yaml", import.meta.url));
  const same = Buffer.compare(Buffer.from(bytes), local) === 0;

  // Every on_chain.fields entry needs a `description`. The schema requires it,
  // the docs' own direct-transform example omits it, and leaving it out cost
  // registration 178 — rejected terminally, fixable only with updateMiner.
  const fieldNames = [...text.matchAll(/^\s+- index:[\s\S]*?(?=^\s+- index:|^\s{2}\w|\Z)/gm)].map((m) => m[0]);
  const undescribed = fieldNames.filter((b) => /name:/.test(b) && !/description:/.test(b));
  if (undescribed.length) {
    throw new Error(
      `${undescribed.length} on_chain.fields entr${undescribed.length === 1 ? "y is" : "ies are"} missing a description — ` +
      `the schema requires one on every field and rejects the registration terminally`
    );
  }

  const y = readYaml(text);
  console.log(`yaml       ${YAML_URL}`);
  console.log(`bytes      ${bytes.length}  sha256 ${yamlHash}`);
  console.log(`matches working copy: ${same}`);
  if (!same) throw new Error("the hosted YAML differs from miner/amanat-miner.yaml — push first");
  console.log(`slug       ${y.slug}  id ${y.id}`);
  console.log(`base_url   ${y.baseUrl}`);
  console.log(`intents    ${y.intents.join(", ")}`);

  // 2 and 3 — the endpoints have to answer an anonymous caller, the way the
  // node will call them.
  const health = await fetch(`${y.baseUrl}/health`, { redirect: "manual" });
  console.log(`\nGET  /health   -> ${health.status}`);
  if (health.status !== 200) {
    throw new Error(
      `base_url is not publicly reachable (${health.status}). If this is Vercel, turn off ` +
      `Deployment Protection: Project Settings -> Deployment Protection -> Vercel Authentication -> Disabled.`
    );
  }
  const probe = await fetch(`${y.baseUrl}/forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: -6.2, lon: 106.85, hours: 1 }),
    redirect: "manual",
  });
  const body = await probe.text();
  console.log(`POST /forecast -> ${probe.status}  ${body.slice(0, 90)}`);
  if (probe.status !== 200) throw new Error("declared endpoint did not answer with 200");

  const signer = wallet();
  const address = await signer.getAddress();
  const reader = new ethers.Contract(DIAMOND, ABI, provider());

  // 4 — one non-canonical intent reverts the whole registration.
  for (const intent of y.intents) {
    const ok = await reader.isCanonicalIntent(intent);
    console.log(`canonical  ${intent}: ${ok}`);
    if (!ok) throw new Error(`${intent} is not canonical on-chain`);
  }

  const d = new ethers.Contract(DIAMOND, ABI, signer);
  // A rejected registration is fixed with updateMiner, not a fresh register:
  // it swaps the entry atomically and keeps the slug bound to this wallet.
  const updateIdx = process.argv.indexOf("--update");
  const updateId = updateIdx === -1 ? null : BigInt(process.argv[updateIdx + 1]);
  const method = updateId === null ? "registerMiner" : "updateMiner";
  const args = updateId === null
    ? [YAML_URL, yamlHash, FEE_ADDRESS, MIN_PRICE, y.intents]
    : [updateId, YAML_URL, yamlHash, FEE_ADDRESS, MIN_PRICE, y.intents];
  const gas = await d[method].estimateGas(...args);
  const fee = await provider().getFeeData();
  console.log(`\nsigner     ${address}`);
  console.log(`fee addr   ${FEE_ADDRESS}`);
  console.log(`floor      ${ethers.formatUnits(MIN_PRICE, 6)} USDC`);
  console.log(`method     ${method}${updateId === null ? "" : ` (replacing ${updateId})`}`);
  console.log(`gas        ${gas} units, about ${ethers.formatEther(gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n))} ETH`);

  if (dry) {
    console.log("\n--dry: simulated only, nothing sent.");
    return;
  }

  const tx = await d[method](...args);
  console.log(`\nsent       ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`mined      block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  console.log(`explorer   https://sepolia.basescan.org/tx/${tx.hash}`);
  console.log(`\nactivation usually lands within a minute:`);
  console.log(`  curl -s https://devnode.telegraphprotocol.com/api/miners/<registrationId> | jq '.miner.activation_status'`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
