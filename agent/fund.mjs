// Put money where the contract can spend it.
//
//   node --env-file=.env agent/fund.mjs --book 4 --escrow 2 --dry
//   node --env-file=.env agent/fund.mjs --book 4 --escrow 2
//
// Two different pots, and confusing them is the failure this exists to stop.
// The *book* is USDC held by the contract, and it backs policy payouts. The
// *escrow* is USDC the Diamond holds for this contract, and it pays the $1 a
// job costs. `createJob` draws on the escrow of whoever calls it — the contract,
// not the wallet that deployed it — so funding the deployer's escrow leaves the
// book unable to open a single job.
//
// It exists because there was no way to call `fundEscrow` short of writing a
// script: `run.mjs` printed "escrow cannot cover a job — call fundEscrow" and
// left the operator with nothing to run. The escrow sat at zero from 2 to 6
// September, so every breach in that window would have been screened, found,
// and then not acted on.
//
// Spends real USDC. --dry prints the plan and sends nothing.

import { ethers } from "ethers";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { wallet, provider, diamond, usdc } from "./telegraph.mjs";
import { flag, has, reject } from "./args.mjs";

const ADDRESS = process.env.AMANAT_CONTRACT;

/**
 * What the two transfers leave behind, or why they must not be sent.
 *
 * Separated from the sending so it can be checked without a chain: the whole
 * risk in this script is arithmetic, and the contract’s own revert
 * ("would strand a policy") is the last line of defence rather than the first.
 */
export function plan({ walletUsdc, bookUsdc, outstanding, toBook, toEscrow }) {
  const u = (x) => ethers.formatUnits(x, 6);
  if (walletUsdc < toBook) throw new Error(`wallet holds ${u(walletUsdc)} USDC, cannot send ${u(toBook)}`);
  const book = bookUsdc + toBook - toEscrow;
  if (book < outstanding) {
    throw new Error(
      `escrowing ${u(toEscrow)} would leave ${u(book)} USDC against ${u(outstanding)} of live policies`,
    );
  }
  return { book };
}

async function main() {
  const argv = process.argv.slice(2);
  reject(argv, ["--book", "--escrow", "--dry"]);
  const dry = has(argv, "--dry");
  const toBook = ethers.parseUnits(flag(argv, "--book", "0"), 6);
  const toEscrow = ethers.parseUnits(flag(argv, "--escrow", "0"), 6);
  if (!ADDRESS) throw new Error("AMANAT_CONTRACT is not set — deploy first");
  if (toBook === 0n && toEscrow === 0n) throw new Error("nothing to do: pass --book and/or --escrow");

  const signer = wallet();
  const me = await signer.getAddress();
  const p = provider();
  const abi = JSON.parse(await readFile(new URL("../onchain/Amanat.abi.json", import.meta.url), "utf8"));
  const book = new ethers.Contract(ADDRESS, abi, signer);
  const token = usdc(signer);
  const u = (x) => ethers.formatUnits(x, 6);

  const [walletUsdc, bookUsdc, outstanding, escrow] = await Promise.all([
    token.balanceOf(me), usdc(p).balanceOf(ADDRESS), book.outstanding(), diamond(p).escrowBalance(ADDRESS),
  ]);
  console.log(`contract   ${ADDRESS}`);
  console.log(`wallet     ${u(walletUsdc)} USDC`);
  console.log(`book       ${u(bookUsdc)} USDC held, ${u(outstanding)} backing live policies`);
  console.log(`escrow     ${u(escrow)} USDC on the Diamond\n`);

  const after = plan({ walletUsdc, bookUsdc, outstanding, toBook, toEscrow });
  console.log(`plan       send ${u(toBook)} to the book, then escrow ${u(toEscrow)} of it for jobs`);
  console.log(`after      book ${u(after.book)} USDC, escrow ${u(escrow + toEscrow)} USDC`);
  if (dry) return console.log("\n--dry: nothing sent.");

  if (toBook > 0n) {
    const tx = await token.transfer(ADDRESS, toBook);
    await tx.wait();
    console.log(`\nfunded     https://sepolia.basescan.org/tx/${tx.hash}`);
  }
  if (toEscrow > 0n) {
    const tx = await book.fundEscrow(toEscrow);
    await tx.wait();
    console.log(`escrowed   https://sepolia.basescan.org/tx/${tx.hash}`);
  }
  console.log(`\nbook       ${u(await usdc(p).balanceOf(ADDRESS))} USDC`);
  console.log(`escrow     ${u(await diamond(p).escrowBalance(ADDRESS))} USDC`);
}

// Importing this module must never move money: `plan` is imported by the tests,
// and running main on import would send two transfers from whoever imported it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
}
