// Deploy Amanat.sol and stock the book (Track 3).
//
//   node --env-file=.env agent/deploy.mjs --dry
//   node --env-file=.env agent/deploy.mjs
//
// Three things have to be true before the contract can settle a claim, and each
// is checked here rather than discovered later:
//
//   1. the contract holds USDC, because a policy is only written against funds
//      already in the book,
//   2. the agent's escrow on the Diamond covers a job, because createJob draws
//      from escrow and not from the wallet,
//   3. the deployed code answers as itself — same telegraph, same token.

import { ethers } from "ethers";
import { readFile } from "node:fs/promises";
import { wallet, provider, DIAMOND, USDC, diamond, usdc } from "./telegraph.mjs";
import { reject } from "./args.mjs";

const BOOK_USDC = ethers.parseUnits(process.env.AMANAT_BOOK_USDC ?? "5", 6);
const ESCROW_USDC = ethers.parseUnits(process.env.AMANAT_ESCROW_USDC ?? "5", 6);

async function main() {
  reject(process.argv.slice(2), ["--dry"]);
  const dry = process.argv.includes("--dry");
  const signer = wallet();
  const me = await signer.getAddress();
  const p = provider();

  const [abi, bin] = await Promise.all([
    readFile(new URL("../onchain/Amanat.abi.json", import.meta.url), "utf8"),
    readFile(new URL("../onchain/Amanat.bin", import.meta.url), "utf8"),
  ]);

  const balance = await usdc(p).balanceOf(me);
  console.log(`signer     ${me}`);
  console.log(`USDC       ${ethers.formatUnits(balance, 6)}`);
  console.log(`book       ${ethers.formatUnits(BOOK_USDC, 6)} USDC into the contract`);
  console.log(`escrow     ${ethers.formatUnits(ESCROW_USDC, 6)} USDC into the Diamond`);
  if (balance < BOOK_USDC + ESCROW_USDC) {
    throw new Error(`need ${ethers.formatUnits(BOOK_USDC + ESCROW_USDC, 6)} USDC, have ${ethers.formatUnits(balance, 6)}`);
  }

  // The Diamond is the settlement token's authority, not us — read it rather
  // than trusting the address in .env.
  const onChainUsdc = await diamond(p).usdcToken();
  console.log(`diamond's settlement token ${onChainUsdc}`);
  if (onChainUsdc.toLowerCase() !== USDC.toLowerCase()) {
    throw new Error(`the Diamond settles in ${onChainUsdc}, not the USDC we hold (${USDC})`);
  }

  if (dry) {
    console.log("\n--dry: nothing deployed.");
    return;
  }

  const factory = new ethers.ContractFactory(JSON.parse(abi), bin, signer);
  const amanat = await factory.deploy(DIAMOND, USDC);
  console.log(`\ndeploying  ${amanat.deploymentTransaction().hash}`);
  await amanat.waitForDeployment();
  const address = await amanat.getAddress();
  console.log(`deployed   ${address}`);
  console.log(`explorer   https://sepolia.basescan.org/address/${address}`);

  console.log(`\nfunding the book…`);
  await (await usdc(signer).transfer(address, BOOK_USDC)).wait();
  console.log(`  contract holds ${ethers.formatUnits(await usdc(p).balanceOf(address), 6)} USDC`);

  // createJob draws on the escrow of whoever calls it, and that is the contract
  // — funding the deployer's escrow leaves the contract unable to open a job.
  console.log(`funding the contract's escrow on the Diamond…`);
  const book = new ethers.Contract(address, JSON.parse(abi), signer);
  await (await book.fundEscrow(ESCROW_USDC)).wait();
  await new Promise((r) => setTimeout(r, 4000)); // the public RPC lags its own writes
  console.log(`  contract escrow ${ethers.formatUnits(await diamond(p).escrowBalance(address), 6)} USDC`);
  console.log(`  book remaining  ${ethers.formatUnits(await usdc(p).balanceOf(address), 6)} USDC`);

  console.log(`\nAMANAT_CONTRACT=${address}`);
  console.log(`add that to .env, then: node --env-file=.env agent/policy.mjs`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
