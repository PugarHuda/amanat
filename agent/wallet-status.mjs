// What the agent wallet can and cannot do right now.
//
//   node --env-file=.env agent/wallet-status.mjs
//
// Reads the key from .env only — never from an argument, so it stays out of
// shell history and process listings. Prints the address and balances, never
// the key.

import { ethers } from "ethers";
import { wallet, provider, diamond, usdc, USDC, DIAMOND } from "./telegraph.mjs";
import { reject } from "./args.mjs";

const JOB_PRICE = 1n * 10n ** 6n; // 1 USDC, from getJobBasePrice()
const GAS_FLOOR = ethers.parseEther("0.0005");

async function main() {
  reject(process.argv.slice(2), []);
  const w = wallet();
  const address = await w.getAddress();
  const p = provider();

  const [eth, usdcBal, escrow, jobPrice] = await Promise.all([
    p.getBalance(address),
    usdc(p).balanceOf(address).catch(() => 0n),
    diamond(p).escrowBalance(address).catch(() => 0n),
    diamond(p).getJobBasePrice().catch(() => JOB_PRICE),
  ]);

  const u = (x) => ethers.formatUnits(x, 6);
  console.log(`address        ${address}`);
  console.log(`network        Base Sepolia (84532)`);
  console.log(`ETH            ${ethers.formatEther(eth)}`);
  console.log(`USDC (wallet)  ${u(usdcBal)}   ${USDC}`);
  console.log(`USDC (escrow)  ${u(escrow)}   on ${DIAMOND}`);
  console.log(`job price      ${u(jobPrice)} USDC\n`);

  const blockers = [];
  if (eth < GAS_FLOOR) blockers.push("no ETH for gas — https://faucet.quicknode.com/base/sepolia or base.app");
  if (usdcBal + escrow < jobPrice) blockers.push("under one job's worth of USDC — needs Circle Base Sepolia USDC");
  if (escrow < jobPrice) blockers.push("escrow below one job — run fundEscrow() before createJob");

  if (blockers.length === 0) {
    console.log("ready: can register on-chain and open a job.");
  } else {
    console.log("blocked:");
    for (const b of blockers) console.log(`  - ${b}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
