# amanat-mcp

Storm risk for any point on earth, read from a live miner on the Telegraph
network. **Four tools, zero dependencies, no API key, no wallet.**

```json
{
  "mcpServers": {
    "amanat": { "command": "npx", "args": ["-y", "amanat-mcp"] }
  }
}
```

## What it answers

| Tool | Question |
|---|---|
| `storm_risk` | Risk 0–1 for a place, a coordinate, or a whole question naming one — with the wind, gusts, precipitation, sea state, nearest named cyclone, and a band across 51 ECMWF ensemble members behind it |
| `route_risk` | Risk per leg along a route, each read at the hour a vehicle travelling at a given speed actually reaches it |
| `backtest` | Would a 0.75 trigger have fired at this place over these dates — from the ERA5 reanalysis archive, so it is what happened rather than what was predicted |
| `telegraph_onchain_jobable` | Which Telegraph intents an ERC-8183 on-chain job cannot reach, and which miners on each one can actually receive a job |

0.75 is the line a parametric weather cover pays on. Every reading carries an
Ed25519 attestation over the fields a contract would settle from, so an answer
can be checked after the fact rather than trusted at the time.

```
storm_risk({ place: "Cebu" })
storm_risk({ place: "10.32,123.89", hours: 24 })
route_risk({ from: "Cebu", to: "Manila", legs: 4 })
backtest({ place: "Cebu", start: "2021-12-15", end: "2021-12-18" })   // Typhoon Rai: 1.000
```

## Why the last tool is in here

An ERC-8183 job on Telegraph is routed by rank, and nothing in that path checks
whether the miner it lands on declares an `on_chain.request` mapping. When it
does not, the node has nothing to map the job's parameters onto and falls back
to that miner's *first* endpoint with nothing in it — so a contract asking for a
storm risk gets back "no hostname was supplied" from a TLS checker, or "no
transaction hash was supplied" from a block explorer. Both of those are real
answers to real jobs from this project.

`telegraph_onchain_jobable` is that audit, live. It cost five on-chain jobs to
find; it costs you one tool call.

## Where the data comes from

Open-Meteo (weather, marine, ensemble and archive models, CC BY 4.0) and the
GDACS cyclone feed, through <https://amanat-miner.vercel.app>. Point it
elsewhere with `AMANAT_MINER`.

Source, and the full write-up of what measuring this network turned up:
<https://github.com/PugarHuda/amanat>

MIT.
