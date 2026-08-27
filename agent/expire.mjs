// Release the policies the network never answered, and take the float back.
//
//   node --env-file=.env agent/expire.mjs --dry
//   node --env-file=.env agent/expire.mjs
//
// A policy is opened with its payout escrowed in the contract, and a check
// opens an ERC-8183 job that is supposed to come back and settle it. Jobs 12,
// 13 and 14 never came back. The contract was written for exactly that: after
// CLAIM_TIMEOUT with no answer, `expire()` releases the payout from the
// outstanding total, and `sweep()` returns whatever is not backing a live
// policy to the underwriter. This runs both, and is the first time the rail has
// been exercised — the failure it guards against had not happened before 26
// August.
//
// Gas only. Nothing here pays a miner or opens a job.

import { ethers } from "ethers";
import { readFile } from "node:fs/promises";
import { wallet, provider } from "./telegraph.mjs";
import { has, reject } from "./args.mjs";

const ADDRESS = process.env.AMANAT_CONTRACT;
const STATUS = ["None", "Active", "Claimed", "Declined", "Expired"];

async function main() {
  reject(process.argv.slice(2), ["--dry"]);
  const dry = has(process.argv, "--dry");
  if (!ADDRESS) throw new Error("AMANAT_CONTRACT is not set — deploy first");

  const signer = wallet();
  const me = await signer.getAddress();
  const abi = JSON.parse(await readFile(new URL("../onchain/Amanat.abi.json", import.meta.url), "utf8"));
  const book = new ethers.Contract(ADDRESS, abi, signer);
  const token = new ethers.Contract(await book.payoutToken(), ["function balanceOf(address) view returns (uint256)"], provider());

  const timeout = Number(await book.CLAIM_TIMEOUT());
  const now = (await provider().getBlock("latest")).timestamp;
  const n = Number(await book.nextPolicyId());

  console.log(`contract   ${ADDRESS}`);
  console.log(`signer     ${me}`);
  console.log(`timeout    ${timeout / 3600} h\n`);

  // Every policy still Active and older than the timeout. The contract checks
  // the same two things and reverts otherwise, so this is the only set worth
  // spending a transaction on.
  const due = [];
  for (let id = 1; id < n; id++) {
    const p = await book.policies(id);
    const status = STATUS[Number(p.status)] ?? String(p.status);
    const age = now - Number(p.openedAt);
    const ok = status === "Active" && age >= timeout;
    console.log(`policy ${id}  ${status.padEnd(8)} ${(age / 3600).toFixed(1).padStart(6)} h  job ${p.jobId}  ${ok ? "due" : ""}`);
    if (ok) due.push(id);
  }

  const before = { outstanding: await book.outstanding(), balance: await token.balanceOf(ADDRESS) };
  console.log(`\noutstanding ${ethers.formatUnits(before.outstanding, 6)} USDC, held ${ethers.formatUnits(before.balance, 6)} USDC`);

  if (!due.length) {
    console.log("nothing is due.");
    return;
  }
  if (dry) {
    console.log(`--dry: would expire ${due.join(", ")} and sweep the freed float to ${me}. Nothing sent.`);
    return;
  }

  for (const id of due) {
    const tx = await book.expire(id);
    const r = await tx.wait();
    console.log(`expired ${id}   https://sepolia.basescan.org/tx/${tx.hash}  (block ${r.blockNumber})`);
  }

  const outstanding = await book.outstanding();
  const balance = await token.balanceOf(ADDRESS);
  const free = balance - outstanding;
  console.log(`\noutstanding ${ethers.formatUnits(outstanding, 6)} USDC, held ${ethers.formatUnits(balance, 6)} USDC, free ${ethers.formatUnits(free, 6)} USDC`);

  if (free > 0n) {
    const tx = await book.sweep(me);
    const r = await tx.wait();
    console.log(`swept       https://sepolia.basescan.org/tx/${tx.hash}  (block ${r.blockNumber})`);
    console.log(`wallet now  ${ethers.formatUnits(await token.balanceOf(me), 6)} USDC`);
  }
}

main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
