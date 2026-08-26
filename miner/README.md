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

## POST /api/route

Storm risk along a route, not at a point.

```bash
curl -X POST https://amanat-miner.vercel.app/api/route \
  -H "Content-Type: application/json" \
  -d '{"from": "Cebu", "to": "Manila", "speed_kmh": 37}'
```

```
  km     0  h+  0   10.33,123.75   risk 0.468   Light drizzle
  km   187  h+  5   11.76,122.84   risk 0.229   Light drizzle
  km   375  h+ 10   13.18,121.92   risk 0.320   Overcast
  km   562  h+ 15   14.60,120.98   risk 0.524   Light drizzle

Elevated: risk 0.524 at 14.6042, 120.9822 at hour 15.
```

Each end is a place name, a `"lat, lon"` pair, or `{lat, lon}`. `speed_kmh`
defaults to 37 — about 20 knots, a loaded container ship. `max_legs` is 2 to 12.

Three things it does that a point forecast cannot:

**The hour moves with the cargo.** A leg 375 km out at 37 km/h is reached in ten
hours, so it is forecast for hour 10. A route assessed entirely at hour zero is
a weather report, not a risk assessment — and in the run above the destination
at arrival reads 0.524 while the origin reads 0.468, which is the difference the
whole feature exists to show.

**The samples sit on the great circle.** Interpolating latitude and longitude
linearly is the tempting shortcut and it is wrong: the Cebu–Rotterdam midpoint
comes out in Afghanistan instead of the Altai, nearly 2000 km off the path
anything actually travels.

**A leg past the 168-hour horizon says so.** It is never clamped to hour 168 and
served as a reading, and a leg that failed to read is never reported as calm —
that is exactly the leg you should not assume is safe.
