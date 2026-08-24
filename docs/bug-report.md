# Bug report: ERC-8183 job params do not reach the miner

**Miner:** `amanat-weather-risk`, registration 179, id `20260821`
**Contract:** [`0x1649ce04B8b9D56285a62Afb2b442602EE0bBc6e`](https://sepolia.basescan.org/address/0x1649ce04B8b9D56285a62Afb2b442602EE0bBc6e)
**Jobs:** 7, 8, 9 on Base Sepolia

## What happens

A job created with coordinates in `strings[0]` and `strings[1]` reaches the
miner as `lat=0, lon=0`. The miner answers about Null Island every time.

The miner's YAML maps them the way the docs describe:

```yaml
on_chain:
  request:
    - endpoint: forecast
      method: POST
      content_type: application/json
      body:
        lat: { source: strings.0, type: float }
        lon: { source: strings.1, type: float }
        hours: { source: numbers.0, type: int, optional: true }
```

and the contract packs them before calling `createJob`:

```solidity
params.strings = new string[](2);
params.strings[0] = p.lat;   // e.g. "10.32"
params.strings[1] = p.lon;   // e.g. "123.89"
params.integers = new uint256[](1);
params.integers[0] = hoursAhead;
```

## Why it is the mapping and not our miner

Two jobs with different coordinates returned byte-identical answers.

| Job | Policy | Coordinates stored on-chain | Answer |
|---|---|---|---|
| 7 | 2 | `1`, `123.89` | forecast for `0.00, 0.00`, risk 0.382 |
| 8 | 3 | `10.32`, `123.89` | forecast for `0.00, 0.00`, risk 0.382 |

`policies(2)` and `policies(3)` both read back the coordinates correctly, so the
contract stored and sent what it meant to. The miner is a pure function of
lat/lon/hour: identical output for different input means it received identical
input.

The same miner answers correctly on the HTTP rail. Asked through
`POST /engine/v1/ask` for latitude 14.60, longitude 120.98, it returns a Manila
forecast. So the miner and its YAML are fine on one path and starved on the
other.

## Why it matters beyond a wrong number

On job 9 the difference changed the outcome. The Engine screen for Manila
(14.60, 120.98) reported risk **0.488**, above our 0.45 escalation threshold.
The job opened for that same policy came back with risk **0.361** — the value
for 0,0 — and the contract declined the claim.

A contract settling on a signal it paid a dollar for acted on a reading of
somewhere else entirely. For a parametric product that is not a display bug.

## Reproducing

```bash
git clone https://github.com/PugarHuda/amanat && cd amanat && npm install
cp .env.example .env          # fill in a funded Base Sepolia key
node --env-file=.env agent/deploy.mjs
node --env-file=.env agent/policy.mjs "anywhere" 14.60 120.98 1
```

The settled policy reports a forecast for `0.00, 0.00` whatever coordinates you
pass.

## Two smaller things found alongside

**`on_chain.fields` entries require a `description`.** Registration 178 was
rejected terminally with:

```
on_chain.fields.{bools,strings,integers}.N: description is required
```

The schema enforces it and the direct-transform example in
[YAML Configuration](https://docs.telegraphprotocol.com/docs/miners/yaml-config)
omits it, so it is easy to miss — and the cost is a burned registration plus an
`updateMiner`.

**The WASM registry index is running well behind the chain.** At the time of
writing `/api/wasm` reports 580 registrations and knows registration ids up to
**641**, while ids **649–653** were mined about two hours earlier and are still
unindexed. It advances a few per hour rather than being stuck, so this reads
like the evaluation queue draining after the 23 August evaluator redeploy sent
the whole network re-registering. Flagging it because other builders reported
the same symptom and assumed their submissions had failed.
