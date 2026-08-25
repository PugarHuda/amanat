# Calling Amanat from your own agent

Four ways in, cheapest first. Pick the one that matches how much you need to
trust the answer.

| Route | Cost | Verified by validators | Wallet needed |
|---|---|---|---|
| Direct HTTP | free | no | no |
| Telegraph MCP | $0.01 | yes | yes |
| Engine over x402 | $0.01 | yes | yes |
| ERC-8183 job | $1.00 | yes, delivered on-chain | yes |

---

## 1. Direct HTTP — no wallet, no sign-up

```bash
curl -X POST https://amanat-miner.vercel.app/forecast \
  -H "Content-Type: application/json" \
  -d '{"lat": 14.60, "lon": 120.98, "hours": 3}'
```

```json
{
  "summary": "At 2026-08-25T19:00Z the forecast for 14.60, 120.98 is 28.4 °C with wind 21.6 km/h, gusts 34.2 km/h and 0.2 mm precipitation. Storm risk is elevated (0.483).",
  "temp_c": 28.4, "wind_kmh": 21.6, "gust_kmh": 34.2, "precip_mm": 0.2,
  "risk": 0.483, "breach": false,
  "valid_at": "2026-08-25T19:00Z", "source": "open-meteo"
}
```

`lat` and `lon` are required and are refused if absent — a missing coordinate is
not the same as zero, and a forecast for Null Island is worse than an error.
`hours` is an offset from now, 0 to 168.

`risk` is 0 to 1 from wind, gusts and precipitation against thresholds a
reinsurer would recognise: Beaufort 8 at 62 km/h, 90 km/h gusts, 30 mm/h rain.
`breach` is `risk >= 0.75`, the point at which the Amanat contract pays a claim.

## 2. From an agent, over MCP

The [Telegraph MCP server](https://github.com/telegraphprotocol/telegraph-mcp)
discovers every registered miner and exposes its endpoints as tools, so Amanat
is already there — no integration on your side:

```
tg_amanat_weather_risk_forecast
```

Claude Desktop, Cursor, Continue, Goose, LangChain and ElizaOS all take the same
server. Point your client at it and the tool appears alongside every other
Telegraph miner:

```json
{
  "mcpServers": {
    "telegraph": {
      "command": "npx",
      "args": ["-y", "@telegraphprotocol/telegraph-mcp"],
      "env": {
        "TELEGRAPH_NODE": "https://devnode.telegraphprotocol.com",
        "EVM_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

The key pays the $0.01 per call over x402. Node 20 or newer — the x402 packages
sign with WebCrypto, which Node 18 does not expose.

## 3. Through the Engine, letting the protocol route

Ask in plain language and the Engine picks the miner. You may or may not get
Amanat; that is the point, and it is how you find out whether we are any good.

```js
import { ask } from "./agent/telegraph.mjs";

const answer = await ask(
  "What is the storm risk at latitude 14.60, longitude 120.98 in the next six hours?"
);
// answer.miner_name, answer.intent, answer.result, answer.signal_hash
```

Every answer carries a `signal_hash`. `agent/verify.mjs` in this repo re-derives
it rather than trusting the node's own `verified: true` — and reports honestly
that it currently cannot, which is worth knowing before you rely on it.

## 4. From a contract, over ERC-8183

Your contract escrows USDC, opens a job against an intent, and receives the
answer through a callback. [`onchain/Amanat.sol`](../onchain/Amanat.sol) is a
working receiver — `subnetMessage` decodes the reading and settles a claim on it.

```solidity
jobId = ITelegraph(telegraph).createJob(
    keccak256("STORM_ALERT"),   // the intent: the protocol picks the miner
    params,                     // strings[0..1] = lat, lon
    address(this)               // your callback
);
```

Two things to know before you build on this rail:

- `createJob` spends the escrow of **whoever calls it**. That is your contract,
  not the wallet that deployed it.
- Job parameters are not currently reaching miners. See
  [the bug report](bug-report.md) — the coordinates never arrive, so a job
  answers about somewhere else. The HTTP and Engine routes are unaffected.

---

## What it is for

Amanat is parametric weather cover: a contract holds a policy, buys a storm
reading, and pays the claim itself when the reading crosses 0.75. Nobody
approves it and nobody can decline it out of turn.

The same reading is useful anywhere a decision waits on weather — a logistics
agent holding a shipment, a treasury sizing an exposure, an insurer pricing an
hour. Take the number; the contract is only one thing to do with it.

Live: [amanat-miner.vercel.app](https://amanat-miner.vercel.app) ·
Source: [github.com/PugarHuda/amanat](https://github.com/PugarHuda/amanat)
