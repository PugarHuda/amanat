# Amanat Weather Risk — miner

A Telegraph miner that answers weather questions with a number a contract can
act on. One endpoint, no API key, no dependencies.

Live: [amanat-miner.vercel.app](https://amanat-miner.vercel.app) ·
Registration 218 · id `20260821` ·
Intents `WEATHER_FORECAST`, `WEATHER_CHECK`, `STORM_ALERT`

## POST /forecast

Ask with coordinates:

```bash
curl -X POST https://amanat-miner.vercel.app/forecast \
  -H "Content-Type: application/json" \
  -d '{"lat": 10.32, "lon": 123.89, "hours": 6}'
```

or in a sentence:

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
  "temp_c": 32.2, "wind_kmh": 6.9, "gust_kmh": 13.0, "precip_mm": 0.0,
  "risk": 0.144, "breach": false,
  "valid_at": "2026-08-27T03:00Z", "source": "open-meteo"
}
```

| Field | | |
|---|---|---|
| `lat`, `lon` | number | Decimal degrees. Must come as a pair. |
| `question` | string | A sentence naming a place. Used when `lat`/`lon` are absent. |
| `hours` | integer | 0–168, from the current hour. Read from the question when absent. |

`GET /forecast?lat=…&lon=…` works too. `GET /health` reports liveness.

## What the numbers mean

`risk` is 0 to 1: the worst of wind, gusts and precipitation measured against
thresholds a reinsurer would recognise — Beaufort 8 at 62 km/h, 90 km/h gusts,
30 mm/h rain. It is deliberately not a model. The point is a figure a contract
can compare, derived the same way every time, from a source anyone can check.

`breach` is `risk >= 0.75`, the point at which the
[Amanat contract](../onchain/src/Amanat.sol) pays a claim without anyone
approving it.

The `summary` carries every figure in prose because that is what a validator
grades — `signal_mapping.label_field` points at it. The scalars carry the same
answer in the shape a contract reads. They are one answer in two forms and the
tests assert they agree.

## Two rules it will not bend

**Absent is not zero.** `Number(null)` is `0`, so a request with no coordinates
once returned a confident forecast for Null Island. Missing input is now a 400
that names the missing field.

**A question naming no place is refused.** "Will it storm?" gets a 400, not a
guess. Somewhere on earth it is always storming; picking a location to make the
sentence answerable would be inventing the answer, and a policy may settle on
it.

Both are real HTTP status codes, so Telegraph never charges for them and never
stores a signal.

## Running it

```bash
node server.mjs          # PORT defaults to 8787
node test.mjs            # unit + live HTTP self-check, no framework
```

No dependencies, by choice: Vercel treats every `.mjs` at the deploy root as a
function entry point, and the smaller the surface the fewer ways a deploy has to
fail. Logic lives in `lib/`, `server.mjs` is transport, and both the local
server and the serverless handler are the same object.

A `Dockerfile` and `fly.toml` are here for hosting it anywhere else.

## Upstream

[Open-Meteo](https://open-meteo.com) forecast and geocoding APIs — free, no key,
10 000 calls/day. That quota is declared in `amanat-miner.yaml` as an
`ACCOUNT_QUOTA` limitation so the node refuses a call that would exhaust it
*before* charging the caller.
