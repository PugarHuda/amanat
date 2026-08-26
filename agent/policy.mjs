// Open a policy and settle it with verified intelligence (Track 3).
//
//   node --env-file=.env agent/policy.mjs "Cebu port" 10.32 123.89 1
//
// The full loop, on-chain end to end:
//
//   openPolicy      the book takes on the risk
//   requestCheck    the contract opens an ERC-8183 job against STORM_ALERT
//                   — a name hash, so the protocol picks the miner, not us
//   subnetMessage   the protocol delivers the answer and the contract pays,
//                   declines, or refuses a payload it cannot read
//
// Nothing here decides anything. The contract does, from what the network sent.

import { ethers } from "ethers";
import { readFile } from "node:fs/promises";
import { wallet, provider, diamond, usdc, intentId, waitForJob, POLICY_STATUS } from "./telegraph.mjs";
import { flag, positionals, reject } from "./args.mjs";

const ADDRESS = process.env.AMANAT_CONTRACT;
const INTENT = process.env.AMANAT_INTENT ?? "STORM_ALERT";

async function main() {
  reject(process.argv.slice(2), ["--policy"]);
  // Pull flags out before reading positionals, or "--policy 1" is read as a
  // policy name and a latitude — which is exactly what it did once.
  const argv = process.argv.slice(2);
  const reuse = flag(argv, "--policy");
  const reuseId = reuse === undefined ? null : BigInt(reuse);
  const [name = "Cebu port cover", lat = "10.32", lon = "123.89", hoursArg = "1"] =
    positionals(argv, ["--policy"]);
  const hours = BigInt(hoursArg);
  if (!ADDRESS) throw new Error("AMANAT_CONTRACT is not set — deploy first");

  const signer = wallet();
  const me = await signer.getAddress();
  const p = provider();
  const abi = JSON.parse(await readFile(new URL("../onchain/Amanat.abi.json", import.meta.url), "utf8"));
  const book = new ethers.Contract(ADDRESS, abi, signer);

  const [bookUsdc, escrow, jobPrice] = await Promise.all([
    usdc(p).balanceOf(ADDRESS),
    diamond(p).escrowBalance(ADDRESS),
    diamond(p).getJobBasePrice(),
  ]);
  const u = (x) => ethers.formatUnits(x, 6);
  console.log(`contract   ${ADDRESS}`);
  console.log(`book       ${u(bookUsdc)} USDC   escrow ${u(escrow)} USDC   job ${u(jobPrice)} USDC`);
  if (escrow < jobPrice) throw new Error("the contract's escrow cannot cover a job — call fundEscrow");

  // --policy <id> reuses a policy that is already open, so a failure anywhere
  // after openPolicy does not write a second policy against the book on retry.
  let policyId;
  if (reuseId !== null) {
    policyId = reuseId;
    console.log(`\nreusing    policy ${policyId}`);
  } else {
    const payout = ethers.parseUnits("1", 6);
    if (bookUsdc < payout) throw new Error("the book cannot back a policy");

    console.log(`\nopening    "${name}" at ${lat}, ${lon} for ${u(payout)} USDC`);
    const open = await book.openPolicy(me, lat, lon, payout);
    const openReceipt = await open.wait();
    const opened = openReceipt.logs
      .map((l) => { try { return book.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "PolicyOpened");
    policyId = opened.args.policyId;
    console.log(`policy     ${policyId}  ${open.hash}`);
  }

  const id = intentId(INTENT);
  console.log(`\nintent     ${INTENT}`);
  console.log(`intentId   ${id}  (keccak256 of the name — the protocol picks the miner)`);
  const check = await book.requestCheck(policyId, id, hours);
  const checkReceipt = await check.wait();
  const requested = checkReceipt.logs
    .map((l) => { try { return book.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "CheckRequested");
  const jobId = requested.args.jobId;
  console.log(`job        ${jobId}  ${check.hash}`);
  console.log(`explorer   https://sepolia.basescan.org/tx/${check.hash}`);

  console.log(`\nwaiting for validators to finalise…`);
  const { state, timedOut } = await waitForJob(jobId, { timeoutMs: 25 * 60_000, everyMs: 20_000 });
  console.log(`job ${jobId}: ${state}${timedOut ? " (still Funded when we stopped waiting)" : ""}`);

  // Whatever happened, read it from the contract rather than assuming.
  const policy = await book.policies(policyId);
  console.log(`\npolicy ${policyId}: ${POLICY_STATUS[Number(policy.status)]}`);
  console.log(`risk reported: ${Number(policy.riskReported) / 10000}`);
  console.log(`book now:      ${u(await usdc(p).balanceOf(ADDRESS))} USDC`);
  console.log(`holder now:    ${u(await usdc(p).balanceOf(me))} USDC`);

  const from = checkReceipt.blockNumber;
  for (const name of ["AnswerReceived", "Paid", "Declined", "Expired"]) {
    const events = await book.queryFilter(book.filters[name](), from, "latest").catch(() => []);
    // queryFilter returns a bare Log, without decoded args, for anything it
    // could not decode against the ABI. Reaching straight for e.args turns one
    // undecodable log into a TypeError that ends the whole report.
    for (const e of events) {
      const args = "args" in e ? [...e.args].map((a) => String(a)) : null;
      console.log(args ? `event ${name}: ${JSON.stringify(args)}` : `event ${name}: undecodable log at ${e.transactionHash}`);
    }
  }
}

main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
