// Re-derive a signal hash instead of taking the node's word for it.
//
//   node --env-file=.env agent/verify.mjs <signal_hash>
//   node --env-file=.env agent/verify.mjs --ask "what is the weather in Cebu?"
//
// Every paid call returns a `signal_hash`, and `GET /engine/v1/signal/{hash}`
// returns the payload that hash commits to — plus a `verification` block saying
// `verified: true`.
//
// That block is the node telling you its own work is fine. The payload is there
// so you do not have to believe it: keccak256 the same bytes and compare. If a
// node ever served a different answer than it committed to, this is the check
// that would notice.

import { ethers } from "ethers";
import { NODE, ask } from "./telegraph.mjs";

/**
 * Serialise the way Go's encoding/json does, which is what the node hashes:
 * object keys sorted, no insignificant whitespace.
 */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

export async function verify(signalHash) {
  const res = await fetch(`${NODE}/engine/v1/signal/${signalHash}`);
  if (!res.ok) throw new Error(`signal lookup ${res.status}`);
  const record = await res.json();

  const claimed = record.signal_hash;
  const algorithm = record.verification?.algorithm ?? "keccak256";
  if (algorithm !== "keccak256") throw new Error(`unexpected algorithm: ${algorithm}`);

  // Try the serialisations a Go service plausibly hashed. Any match proves the
  // payload is the one committed to; none means we cannot confirm it, which is
  // a different statement from "it is wrong".
  const payload = record.payload;
  const candidates = {
    "canonical (sorted keys)": canonical(payload),
    "as served": JSON.stringify(payload),
    "canonical + newline": canonical(payload) + "\n",
  };

  const attempts = Object.entries(candidates).map(([label, text]) => ({
    label,
    hash: ethers.keccak256(ethers.toUtf8Bytes(text)),
  }));
  const match = attempts.find((a) => a.hash.toLowerCase() === claimed.toLowerCase());

  return { claimed, record, attempts, match, nodeSays: record.verification?.verified };
}

async function main() {
  const args = process.argv.slice(2);
  let hash = args.find((a) => a.startsWith("0x"));

  if (!hash) {
    const i = args.indexOf("--ask");
    const query = i === -1 ? "What is the storm risk at 10.32, 123.89 in the next six hours?" : args[i + 1];
    console.log(`asking:    ${query}`);
    const answer = await ask(query);
    console.log(`miner:     ${answer.miner_name} (${answer.intent})  cost $${answer.cost_usd}`);
    hash = answer.signal_hash;
  }

  console.log(`signal:    ${hash}\n`);
  const { record, attempts, match, nodeSays } = await verify(hash);

  console.log(`miner      ${record.payload?.miner_slug}`);
  console.log(`intent     ${record.payload?.intent_id}`);
  console.log(`paid by    ${record.payload?.wallet_address}`);
  if (record.signal?.tx_hash) console.log(`payment    https://sepolia.basescan.org/tx/${record.signal.tx_hash}`);
  console.log(`node says  verified: ${nodeSays}\n`);

  for (const a of attempts) {
    console.log(`  ${a.label.padEnd(24)} ${a.hash.slice(0, 18)}…  ${a === match ? "MATCH" : ""}`);
  }

  console.log();
  if (match) {
    console.log(`independently verified: the payload hashes to the signal, under ${match.label}.`);
  } else {
    // Not a failure of the answer — a failure to reproduce the node's byte-level
    // serialisation. Say which, because the difference matters.
    console.log(
      "could not reproduce the hash from the payload as served.\n" +
      "That does not mean the answer is wrong: it means the exact bytes the node hashed\n" +
      "are not recoverable from this response, so the commitment cannot be checked\n" +
      "independently. Worth raising — a commitment you cannot re-derive is a promise."
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
