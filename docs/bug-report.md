# Bug report: ERC-8183 job params do not reach the miner

**Miner:** `amanat-weather-risk`, registration 179, id `20260821`
**Contract:** [`0x51fa7d66af31dE4d94Bd14e0404465fd2D0c7B3c`](https://sepolia.basescan.org/address/0x51fa7d66af31dE4d94Bd14e0404465fd2D0c7B3c)
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

## Correction: the node may be sending nothing, not zeros

The original report said the miner receives `lat=0, lon=0`. Testing my own miner
turned that around.

Playwright over the unhappy paths found that `{}`, `{"lon": 10}` and
`{"lat": null}` all returned **200 with a forecast for 0.00, 0.00**.
`Number(null)` is 0, and `searchParams.get` on a missing key returns `null`, so
the miner was quietly turning *absent* into *zero* — which is exactly the failure
it exists to prevent, in the miner itself. Fixed: missing coordinates are now a
`400 lat is required`.

Then the same job was run again. Jobs 9, 10 and 11 reached `Terminal` within
minutes. Job 12, opened after the fix against the same policy, the same intent
and the same coordinates, has stayed `Funded` for **148 minutes and counting**.

That points at the node calling the miner with no coordinate fields at all,
rather than with zeros. The zeros were ours. The parameters still are not
arriving, and a miner that validates its input now fails the job loudly instead
of answering about Null Island — which is the better failure, but it is still a
failure of the `on_chain.request` mapping.

The miner is the only thing that changed between job 11 and job 12, and the
change was that it stopped accepting a request with no coordinates. A job that
settled in minutes now does not settle at all.

So: the parameters are not reaching the miner, the miner was masking it by
treating absent as zero, and with the mask removed the job simply fails. The
`on_chain.request` mapping is where to look.

## Reproducing

```bash
git clone https://github.com/PugarHuda/amanat && cd amanat && npm install
cp .env.example .env          # fill in a funded Base Sepolia key
node --env-file=.env agent/deploy.mjs
node --env-file=.env agent/policy.mjs "anywhere" 14.60 120.98 1
```

The settled policy reports a forecast for `0.00, 0.00` whatever coordinates you
pass.

## `MAX_PARAM_VALUE` with `operator: lte` is evaluated backwards

This one blocks calls today, and it is easy to reproduce.

The miner declared its real constraint:

```yaml
limitations:
  - code: MAX_PARAM_VALUE
    message: hours must be an integer offset between 0 and 168
    param: hours
    property: value
    value_num: 168
    operator: lte
```

Direct calls through `POST /engine/v1/ask/{minerId}`:

| `hours` | Result |
|---|---|
| omitted | 200 |
| `0` | **422** — `parameter "hours" value 0.00 violates the miner's declared limit (lte 168.00)` |
| `2` | **422** — same message, value 2.00 |
| `200` | passes the node's check, then the miner rejects it with its own 400 |

Values *inside* the limit are refused; a value *outside* it is let through. The
comparison is inverted.

The cost is not cosmetic. Pre-request validation runs before payment on the
direct path and blocks the call, so a miner that declares an honest
`MAX_PARAM_VALUE` has every valid call to that parameter refused. And it plausibly
explains the hanging ERC-8183 jobs better than the missing coordinates did: every
job this contract opens carries `hours = 1` in `integers[0]`, and 1 is inside the
declared limit, so the node would refuse before the miner is ever called.

Worked around by deleting the declaration — the miner validates the range itself
and answers 400 — but that is the wrong direction to be pushed in. Declaring
limits accurately is what the field is for.

## A signal commitment that cannot be re-derived

Every paid call returns a `signal_hash`, and the docs say why that is useful:

> The response includes the signal, the result behind it, and the payload the
> hash was computed over, so you can re-derive the hash yourself rather than
> taking the node's word for it.

`GET /engine/v1/signal/{hash}` does return a payload and a verification block:

```json
"verification": { "algorithm": "keccak256", "commitment": "payload", "verified": true }
```

But the hash cannot be reproduced from what it returns. Thirty variants tried —
`payload`, `result`, `signal`, the response and the request alone, each under
canonical key-sorted JSON, plain `JSON.stringify` and indented, each under both
keccak256 and sha256. None matches.

Example: signal
`0x5118458217d28fdc93f1b1588958232ebf3213f41cc0877d0288dec1fb9f2af6`, miner
`amanat-weather-risk`, payment
[`0x0ccfe6f1…`](https://sepolia.basescan.org/tx/0x0ccfe6f1616ddbfc3903163e2f6305dd1f5abd959cb780d1fc82209d5582c838).

This is not a claim that any answer is wrong. It is that `verified: true` is
currently the node vouching for itself, and the independent check the docs
describe is not reachable from the response. Either the exact bytes hashed
should be recoverable — a canonical form, or the pre-image returned verbatim —
or the docs should stop promising it can be checked.

`agent/verify.mjs` in this repo does the check and reports honestly when it
cannot confirm, rather than printing a tick.

## The escrow has no exit

`depositUSDC` and `escrowBalance` are both on the Diamond. Nothing that takes
USDC back out is.

Enumerated through the loupe: 21 facets, 182 selectors. None of them matches any
of 420 withdrawal-shaped names — `withdraw`, `unstake`, `redeem`, `exit`,
`reclaim`, `release`, `refund`, `unlock`, `sweep`, each crossed with the obvious
suffixes and argument shapes.

```
depositUSDC(uint256)        YES
escrowBalance(address)      YES
createJob(bytes32,...)      YES
withdraw* / reclaim* / ...  none
```

The docs list an "Escrow withdrawal timelock — 4 hours" under Gas & Escrow,
which reads as a withdrawal path that exists and is delayed. On this deployment
there is no path at all.

It matters more than it looks, because the docs send you here: funding escrow is
step one of the ERC-8183 walkthrough, and a WebSocket subscription gates on a
minimum escrow balance at connect time. Following either instruction puts USDC
somewhere it cannot come back from. On testnet that is an annoyance. The same
contract on mainnet would be something else.

Ours currently holds 7.4 USDC that can only ever leave as job payments.

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
