// Subscribe to the Daemon's signal feed over WebSocket — the third rail.
//
//   node --env-file=.env agent/subscribe.mjs
//   node --env-file=.env agent/subscribe.mjs --intents WEATHER_FORECAST,STORM_ALERT --minutes 10
//
// This is the rail that costs nothing to wait on. The Daemon produces signals on
// its own schedule whether or not anyone is asking, and a subscriber is charged
// per signal delivered against an on-chain escrow rather than per call. For a
// book of policies that is the right shape: watch continuously, and only reach
// for a paid question when something arrives worth acting on.
//
// Three things the handshake demands, each of which fails silently if missed:
// the wallet address goes in the query string, the challenge must be signed with
// personal_sign and returned within 15 seconds, and `spend_limit_usdc` is
// mandatory on subscribe.

import { ethers } from "ethers";
import { wallet, diamond, provider, NODE } from "./telegraph.mjs";

const WS_URL = process.env.TELEGRAPH_WS ?? NODE.replace(/^http/, "ws") + "/engine/ws";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const INTENTS = arg("--intents", "WEATHER_FORECAST,STORM_ALERT,WEATHER_CHECK").split(",");
const MINUTES = Number(arg("--minutes", 5));
const SPEND_LIMIT = Number(arg("--spend-limit", 500000)); // raw µUSDC, so 0.50

async function main() {
  const signer = wallet();
  const address = await signer.getAddress();

  // The gate is checked at connect time, so a thin escrow closes the socket
  // with an error rather than refusing the subscribe.
  const escrow = await diamond(provider()).escrowBalance(address);
  console.log(`wallet     ${address}`);
  console.log(`escrow     ${ethers.formatUnits(escrow, 6)} USDC (the feed needs at least 1.00)`);
  if (escrow < 1_000_000n) throw new Error("escrow below $1 — deposit before subscribing");

  const url = `${WS_URL}?wallet_address=${address}`;
  console.log(`connecting ${url}\n`);
  const ws = new WebSocket(url);

  const send = (o) => ws.send(JSON.stringify(o));
  let signals = 0;

  ws.addEventListener("open", () => send({ action: "auth_wallet" }));

  ws.addEventListener("message", async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "wallet_challenge": {
        // Sign the server's exact string. Rebuilding it never matches.
        const signature = await signer.signMessage(msg.data.message);
        send({ action: "wallet_verify", signature });
        break;
      }
      case "wallet_verified":
        console.log(`verified   ${msg.data.wallet_address}`);
        break;
      case "connected":
        console.log(`subscribing to ${INTENTS.join(", ")}`);
        send({ action: "subscribe", intents: INTENTS, spend_limit_usdc: SPEND_LIMIT });
        break;
      case "subscribed":
        console.log(`subscribed ${msg.data.subscription_id}`);
        console.log(`           cap ${ethers.formatUnits(BigInt(msg.data.spend_limit_usdc), 6)} USDC, ` +
          `max ${msg.data.max_per_hour}/hour\n`);
        break;
      case "signal":
      case "daemon_signal": {
        signals++;
        const d = msg.data ?? {};
        const q = d.question?.text ?? d.question ?? "";
        console.log(`signal ${signals}: [${d.routing?.intent ?? d.intent ?? "?"}] ${String(q).slice(0, 90)}`);
        if (d.signal_hash) console.log(`           ${d.signal_hash}`);
        break;
      }
      case "error":
        console.log(`error      ${JSON.stringify(msg.data)}`);
        break;
      default:
        console.log(`${msg.type}: ${JSON.stringify(msg.data).slice(0, 140)}`);
    }
  });

  ws.addEventListener("close", (e) => {
    console.log(`\nclosed     code ${e.code} ${e.reason || ""}`.trimEnd());
    console.log(`received   ${signals} signal${signals === 1 ? "" : "s"}`);
    process.exit(0);
  });
  ws.addEventListener("error", (e) => console.log(`socket error: ${e.message ?? e}`));

  setTimeout(() => {
    console.log(`\n${MINUTES} minutes up.`);
    ws.close();
  }, MINUTES * 60_000);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
