# Calling Amanat from your own agent

Four ways in, cheapest first. Pick the one that matches how much you need to
trust the answer.

| Route | Cost | Verified by validators | Wallet needed |
|---|---|---|---|
| Direct HTTP | free | no | no |
| Route assessment | free | no | no |
| The published board | free | yes — it was already bought | no |
| The on-chain audit | free | n/a — it is about the network | no |
| MCP, from any agent | free | no | no |
| Telegraph MCP | $0.01 | yes | yes |
| Engine over x402 | $0.01 | yes | yes |

### From an agent, over MCP

Four tools, no dependencies, no wallet, no key. Published to npm and listed in
the official MCP registry as `io.github.PugarHuda/amanat`, so there is nothing to
clone:

```json
{
  "mcpServers": {
    "amanat": { "command": "npx", "args": ["-y", "amanat-mcp"] }
  }
}
```

| Tool | What it answers |
|---|---|
| `storm_risk` | Risk 0–1 for a place or a question naming one, with the reading and the 51-member band behind it |
| `route_risk` | Risk per leg, each read at the hour a vehicle actually reaches it |
| `backtest` | Would the 0.75 trigger have fired here, from the reanalysis archive |
| `telegraph_onchain_jobable` | Which Telegraph intents an on-chain job cannot survive, and who on each can receive one |

`AMANAT_MINER` points it at another instance. A refusal from the miner comes back
as an `isError` tool result rather than a dead session, so a model can read "no
place found in …" and try a different place.

### Before you put a contract on the on-chain rail, read this one

```bash
curl -s https://amanat-miner.vercel.app/api/jobable
```

An ERC-8183 job is routed by rank, and nothing in that path checks whether the
miner it lands on declares an `on_chain.request` mapping. On an intent whose
rank-1 miner has none, every job is answered from that miner's first endpoint
with no parameters — which is how four of ours came back as a TLS certificate
error to a contract asking for a storm risk.

`closed[]` is what is confirmed shut, `unknown[]` is where the leader's YAML
cannot be fetched to check, and `jobable_by_intent` is who on each intent can
actually receive a job. It cost us five jobs to find. It costs you a GET.
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
  "wave_m": 1.1, "cyclone_name": null, "cyclone_km_now": null,
  "risk": 0.483, "breach": false,
  "valid_at": "2026-08-25T19:00Z", "source": "open-meteo"
}
```

Or ask in a sentence and let the miner find the place:

```bash
curl -X POST https://amanat-miner.vercel.app/forecast \
  -H "Content-Type: application/json" \
  -d '{"question": "Will Riyadh exceed 40 degrees in the next 24 hours?"}'
```

```json
{
  "summary": "At 2026-08-27T03:00Z the forecast for Riyadh, Riyadh Region, Saudi Arabia is 32.2 °C with wind 6.9 km/h, gusts 13.0 km/h and 0.0 mm precipitation. Storm risk is low (0.144).",
  "place": "Riyadh, Riyadh Region, Saudi Arabia",
  "lat": 24.68773, "lon": 46.72185, "hours": 24,
  "temp_c": 32.2, "risk": 0.144, "breach": false
}
```

The place is resolved through Open-Meteo's geocoding API — the same source as
the forecast, so the name and the reading agree about where they are. The hour
offset is read from the question too: "in the next six hours" is hour 6, and
"tomorrow" is hour 24.

Give it coordinates or a question. `lat` and `lon` must come as a pair and are
refused if either is absent — a missing coordinate is not the same as zero, and
a forecast for Null Island is worse than an error. A question naming no place
("Will it storm?") is refused for the same reason: guessing a location is worse
than saying no when a contract may settle on the answer. `hours` is an offset
from now, 0 to 168, and overrides whatever the question implies.

`risk` is 0 to 1 from wind, gusts and precipitation against thresholds a
reinsurer would recognise: Beaufort 8 at 62 km/h, 90 km/h gusts, 30 mm/h rain.
`breach` is `risk >= 0.75`, the point at which the Amanat contract pays a claim.

## 1b. A route, not a point

Cargo is not exposed to the weather at the port it left, so each leg is
forecast for the hour the shipment actually reaches it.

```bash
curl -X POST https://amanat-miner.vercel.app/api/route   -H "Content-Type: application/json"   -d "{\"from\": \"Cebu\", \"to\": \"Manila\", \"speed_kmh\": 37}"
```

```
km     0  h+  0   risk 0.196   Overcast
km   187  h+  5   risk 0.260   Overcast
km   375  h+ 10   risk 0.300   Overcast
km   562  h+ 15   risk 0.648   Drizzle

Elevated: risk 0.648 at 14.6042, 120.9822 at hour 15.
```

The quay reads 0.196 and the arrival reads 0.648 fifteen hours later. A point
forecast would have reported the first number and called it the answer.

Each end is a place name, a `"lat, lon"` pair, or `{lat, lon}`. `speed_kmh`
defaults to 37 — about 20 knots. A leg past the 168-hour horizon says so rather
than being clamped, and a leg that failed to read is never reported as calm.

For the same assessment over the paid, verified rail — one signal hash per leg:

```bash
npm run route -- "Cebu" "Manila" --legs 6
```

## 1c. The board: lanes already screened, free to read

```bash
curl https://amanat-miner.vercel.app/api/board
```

Ten Southeast and East Asian shipping lanes, screened through Telegraph every
six hours by `agent/board.mjs`. Each leg carries the signal hash of the paid
call behind it, so reading the board costs nothing while the readings in it were
still bought and verified. The gauge on the landing page is drawn from this.

## Verifying an answer

Every answer is signed over the fields a contract settles on. Check it with
Node and nothing else:

```js
import { createPublicKey, verify } from "node:crypto";
const a = answer.attestation;
const ok = verify(null, Buffer.from(a.canonical),
  createPublicKey({ key: Buffer.from(a.public_key, "base64"), format: "der", type: "spki" }),
  Buffer.from(a.signature, "base64"));
// and that the canonical payload is what you were given:
const signed = JSON.parse(a.canonical);   // { lat, lon, hours, valid_at, temp_c, …, risk, breach }
```

`a.key_persistent` is false when the instance generated its key at start —
set `AMANAT_SIGNING_KEY` on the host to pin one. The current public key is at
`/.well-known/amanat.json`.

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
      "args": ["-y", "telegraph-protocol-mcp"],
      "env": {
        "TELEGRAPH_NODE_URL": "https://devnode.telegraphprotocol.com",
        "TELEGRAPH_ENGINE_URL": "https://devnode.telegraphprotocol.com",
        "TELEGRAPH_DAEMON_URL": "https://devnode.telegraphprotocol.com",
        "TELEGRAPH_EVM_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

The key pays the $0.01 per call over x402. Node 20 or newer — the x402 packages
sign with WebCrypto, which Node 18 does not expose.

This block was wrong until it was run. It named `@telegraphprotocol/telegraph-mcp`,
which is not a package — npm answers 404 — and two environment variables the
server does not read. Anyone who copied it got nothing, and we would not have
known, because documenting a route is not the same as taking it.

What a handshake against the server actually reports:

```
initialize   {"name":"telegraph","version":"1.0.0"}
             Found 92 integrations
tools        188
             tg_amanat_weather_risk_forecast   <- ours
```

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
answer through a callback. [`onchain/src/Amanat.sol`](../onchain/src/Amanat.sol) is a
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
