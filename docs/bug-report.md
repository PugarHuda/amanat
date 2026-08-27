# Bug report: what broke while building on the Telegraph testnet

Everything below was found building three tracks against the live testnet
between 21 and 27 August, and every claim is reproducible with the scripts in
this repo. Ordered by what would cost a builder the most time.

| # | Finding | Effect |
|---|---|---|
| 1 | [Jobs sit in `Funded` and never route](#update-27-august-a-third-job-a-fresh-contract-still-funded) | Three jobs, two contracts, 3 USDC escrowed, nothing returned. Jobs 7–11 settled four days earlier, so the rail worked and then stopped. |
| 2 | [Three gates, and the one that makes the real problem unfixable](#three-gates-and-the-one-that-makes-the-networks-real-problem-unfixable) | To replace the module scoring numeric answers at 1e-8, you must first rank answers the way it does. 42 of 45 slots sit with one author. |
| 3 | [The bar moves between registrations, invisibly](#the-bar-moves-between-registrations-and-cannot-be-read-before-you-spend-one) | The same intent demanded 0.7859 then 0.9900. The number that would make registration a decision is published only after you pay to learn it. |
| 4 | [The champion score on the board is not the champion's score](#the-champion-score-on-the-board-is-not-the-champions-score) | `WEATHER_FORECAST` displays 0.5302 and measures 0.9898. Ranked by the published number, the strongest incumbent looks like the weakest. |
| 5 | [A whole intent family scored exactly zero](#a-whole-intent-family-scored-exactly-zero-and-it-is-not-only-weather) | 31 of 40 intents have no miner above 0.05; the other 9 reach 0.999. The split is by answer shape, not miner quality. |
| 6 | [ERC-8183 job params do not reach the miner](#erc-8183-job-params-do-not-reach-the-miner) | A job carrying coordinates arrives as `lat=0, lon=0`. The contract acts on an answer about the wrong place. |
| 7 | [The escrow has no exit](#the-escrow-has-no-exit) | `depositUSDC` exists; nothing withdraws. Funds in are funds gone. |
| 8 | [A signal commitment that cannot be re-derived](#a-signal-commitment-that-cannot-be-re-derived) | `verified: true` is the node vouching for itself. Thirty variants, two miners, no match. |
| 9 | [`MAX_PARAM_VALUE` with `operator: lte` is evaluated backwards](#max_param_value-with-operator-lte-is-evaluated-backwards) | A policy that means "at most" enforces "at least". |
| 10 | [A terminal rejection with an empty reason list](#a-terminal-rejection-with-an-empty-reason-list) | The one field that would say why is empty. |
| 11 | [Two smaller things](#two-smaller-things-found-alongside) | A dead regex, and docs that describe a call the node does not make. |

---

**Miner:** `amanat-weather-risk`, registration 218, id `20260821`
**Contract:** [`0x0700c9300D5cfD8A4b2C7fBbaB2703087AB0590c`](https://sepolia.basescan.org/address/0x0700c9300D5cfD8A4b2C7fBbaB2703087AB0590c)
**Superseded:** the jobs below were opened by [`0x51fa7d66…7B3c`](https://sepolia.basescan.org/address/0x51fa7d66af31dE4d94Bd14e0404465fd2D0c7B3c), which this replaced.
**Jobs:** 7, 8, 9 on Base Sepolia

## ERC-8183 job params do not reach the miner

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

On 27 August the same check was run against a different miner —
`bittensor-sn18-zeus`, signal
`0x73643031cc60762211d36b72d69509c6f86324ca26be4a1c23cfaa8ca66e947e`, payment
[`0xe092350a…`](https://sepolia.basescan.org/tx/0xe092350a1343e91c045a9979e59d2552d9fe6cfc6499f5a42f6ea5ccf18659d2)
— and the hash was again unreachable from the payload as served. So this is not
one miner serialising its answer oddly: the node hashes bytes that no miner
response exposes.

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

Ours currently holds 8.28 USDC that can only ever leave as job payments.

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

## A terminal rejection with an empty reason list

Registration **217** was rejected with:

```
YAML schema validation failed: []. This will NOT be retried:
fix the YAML and re-submit the registration with updateMiner().
```

The list of what failed is empty. The cause turned out to be on our side — a
`description` written into a `{ }` flow mapping carried a comma and a question
mark, so the document did not parse at all — but the message gives no way to
learn that. Rejection is terminal and costs a transaction plus, because
`updateMiner` deregisters the old entry first, the live registration: the miner
was off the network from 03:28 to 03:43 UTC with nothing to act on.

Two changes would remove the whole class:

- when the document fails to **parse**, say so and give the parser's message
  and line, rather than reporting an empty schema-validation list;
- validate the YAML at the URL **before** deregistering the incumbent, so a
  bad update leaves the working miner in place instead of taking it down.

The first is what turns a fifteen-minute outage into a one-line fix. Anyone
generating YAML programmatically will hit this, because flow mappings are what
a serialiser reaches for and punctuation in a description is normal.

## Update, 26 August: two jobs still sitting in `Funded`

The 3 July announcement said job results are now "automatically delivered and
recorded directly on-chain" and that "the full cycle from request to on-chain
settlement is closed and confirmed working end to end". Both jobs we have open
were created well after that and neither has moved:

| Job | Budget | State | Open for |
|---|---|---|---|
| 12 | 1.0 USDC | `Funded` | 11 h |
| 13 | 1.0 USDC | `Funded` | 2 h |

Jobs 7–11 all reached `Terminal`, so the callback path does work — it worked
for us four days ago. Something about 12 and 13 is different, and from the
outside there is no way to tell what: `getJob` exposes a state and nothing
about why it is stuck, and 2 USDC is escrowed against them meanwhile.

What would make this diagnosable from a contract's side: a reason on the job
record, or an event when the node picks a job up and when it fails to route
one. Right now `Funded` covers both "queued" and "abandoned".

## A whole intent family scored exactly zero, and it is not only weather

Epoch 280 evaluated fine: 141 miner-intent pairs were scored network-wide and
46 came back above zero.

```
telegraph-chatbot      TASK_COMPLETION       0.996
bedrock-nova-2-lite    LANGUAGE_GENERATION   0.970
litellm                CHAT_COMPLETION       0.153
degenlens-onchain      ONCHAIN_TX_LOOKUP     0.009
```

Every weather miner in the same epoch scored `0.000000`, without exception:

| Intent | Miners | Any score above zero |
|---|---|---|
| `WEATHER_FORECAST` | 9 | none |
| `WEATHER_CHECK` | 8 | none |
| `STORM_ALERT` | 3 | none |

Three epochs earlier the same intents produced real spread — `amanat-weather-risk`
0.009192, `skywire-storm-alert` 0.008503, `bittensor-sn18-zeus` 0.006845 on
STORM_ALERT at epoch 277 — so the miners can be told apart and were.

Two things stand out.

**A whole intent family at exactly zero is not a ranking, it is an absence.**
The leaderboard still assigns ranks 1..9 on top of it, so a miner can show as
`#1` in an intent where nothing was measured. That reads as an achievement on
the explorer and is not one.

**The scale is nothing like the text intents.** `TASK_COMPLETION` pays 0.996
while a good weather answer at epoch 277 paid 0.009 — two orders of magnitude.
If the miner track normalises within an intent that is fair, but any figure
compared across intents is not comparing the same thing.

What would make this diagnosable from a miner's side: the ground truth the
canonical scorer graded against, or at least whether one was found. A score of
zero currently covers "your answer was wrong", "your answer never arrived" and
"there was nothing to compare it to", and a miner cannot act on the difference.

**It is not weather.** Reading every intent's live scores out of `/api/miners`
on 27 August — `npm run survey` — the same shape covers the network. Of 40
intents that produced a score, **31 have no miner above 0.05**. The other 9
reach 0.89 to 0.999.

| Intent | Best miner | Shape of a correct answer |
|---|---|---|
| `TASK_COMPLETION` | 0.9963 | prose |
| `URL_SCAN` | 0.9991 | prose |
| `LANGUAGE_GENERATION` | 0.9824 | prose |
| `STOCK_PRICE` | 0.0196 | a number |
| `TVL_LOOKUP` | 0.0182 | a number |
| `GAS_PRICE` | 0.0054 | a number |
| `CRYPTO_PRICE` | **1.37e-8** | a number |
| `CVE_LOOKUP` | **2.13e-22** | an identifier |

The division is not miner quality. It is whether the right answer is a sentence
or a quantity. `CRYPTO_PRICE` is the cleanest case on the network — one asset,
one number, checkable against any exchange — and its best miner scores 0.0000000137
while a chat miner scores 0.996.


## Update, 27 August: a third job, a fresh contract, still `Funded`

Job 14 was opened against `STORM_ALERT` — the intent this miner currently ranks
first on — from a contract deployed hours earlier with a correct callback. It
has not moved.

| Job | Contract | Opened | State |
|---|---|---|---|
| 12 | `0x51fa7d66…7B3c` | 26 h ago | `Funded` |
| 13 | `0x51fa7d66…7B3c` | 17 h ago | `Funded` |
| 14 | `0x0700c930…590c` | 2 h ago | `Funded` |

Every condition that could plausibly have been ours has since changed, and the
outcome has not:

- the miner answers plain-language questions now, not only coordinate pairs;
- it is ranked **1** on the intent the job targets, so routing has every reason
  to reach it;
- its registration declares an `on_chain.request` mapping, which most miners
  omit;
- the callback address is a contract deployed after the previous two jobs, with
  its own escrow, and `subnetMessage` is reachable — the same contract shape
  settled jobs 7 through 11 four days ago.

Jobs 7–11 reaching `Terminal` is the part that matters: this rail worked, and
then stopped. Something between 22 and 26 August changed, and from outside
there is no way to see what. `getJob` exposes a state and nothing about why a
job sits in it, so `Funded` covers "queued", "no miner matched", "the miner was
called and failed" and "abandoned" without distinguishing them.

That is 3 USDC escrowed against jobs that have returned nothing. Our contract's
escrow is now zero, so we cannot open a fourth without funding more into a sink
that has no withdrawal path — which is the other half of this report.

What would make this actionable for anyone building on the on-chain rail: a
reason on the job record, or an event when the node picks a job up and when it
fails to route one.

## The champion score on the board is not the champion's score

`/api/wasm` publishes an `eval_score` against each champion, and the explorer
shows it. It is not a description of that champion. It is the
`candidate_margin` it recorded *on the day it won*, frozen — measured against
whatever corpus and whatever incumbent existed at that moment.

The bar a new registration actually clears is the `champion_margin` on the most
recent entry: the same incumbent, re-measured on today's corpus. The two numbers
drift apart badly.

| Intent | Displayed `eval_score` | Measured bar | Off by |
|---|---|---|---|
| `WEATHER_FORECAST` | 0.5302 | **0.9898** | 0.4596 harder |
| `IP_GEOLOCATION` | 0.8574 | 0.4935 | 0.3639 easier |
| `ACADEMIC_SEARCH` | 0.6804 | 0.3344 | 0.3460 easier |
| `GAS_PRICE` | 0.8078 | 0.4851 | 0.3227 easier |
| `CONTENT_VERIFICATION` | 0.9904 | 0.6877 | 0.3027 easier |

`WEATHER_FORECAST` is the case that costs money. Ranked by the published score
it is the weakest champion on the board at 0.5302, and the obvious place to
spend a registration. Measured, it is one of the strongest at 0.9898. We spent
four registrations there before reading the entries rather than the summary.

`npm run survey` in this repo prints both columns side by side, because the
displayed one on its own is worse than no number at all.

## The bar moves between registrations, and cannot be read before you spend one

The same intent does not present the same target twice. Our four attempts on
`WEATHER_FORECAST`, in order, were measured against these champion margins:

| Registration | Our margin | Bar that day | Verdict |
|---|---|---|---|
| 203 | 0.8349 | 0.7859 | rejected — agreement −0.2585 |
| 651 | 0.4310 | 0.5302 | rejected — separation |
| 676 | 0.4625 | 0.5955 | rejected — separation |
| 1112 | 0.8207 | **0.9900** | rejected — separation |

Registration 203 cleared 0.7859 on separation and 1112 did not clear 0.9900 —
the bar rose 26% between them, with the slot never changing hands. On
`TEXT_AUTHENTICITY_CHECK` it sat at 0.4045 for three consecutive attempts and
then jumped to 0.6586 for the fourth.

A submission is therefore accepted or refused partly on when it was sent, and
nothing in the API exposes the current bar before a registration is spent. The
number that would make registration a decision rather than a lottery is already
computed — it is `champion_margin` — and is only published *after* you have paid
to learn it.

## Three gates, and the one that makes the network's real problem unfixable

A registration can be refused three separate ways, each sufficient on its own:

- **separation** — average margin below the champion's;
- **ordering** — fewer fixture cases ranked correctly than the champion;
- **agreement** — Spearman correlation with the champion's ranking of *real
  miner answers* below 0.60.

All three have refused us. Registration 650 on `TEXT_AUTHENTICITY_CHECK` beat
the champion on separation — 0.4252 against 0.4045 — and was refused on ordering
anyway, 12 of 15 against 14. Registration 653 on `CHAT_COMPLETION` beat the
champion on separation by a wide margin, 0.8449 against 0.5723, with 32 of 32
ordering wins, and was refused for agreeing only 0.3005.

The agreement gate is the one worth thinking about, because of what it does in
combination with [finding 6](#a-whole-intent-family-scored-exactly-zero-and-it-is-not-only-weather).

Across 40 intents that produced a score, **31 have no miner above 0.05** while
the other 9 reach 0.89 to 0.999. The split is not by miner quality, it is by
answer shape: prose intents score near 1, deterministic ones near 0.
`CRYPTO_PRICE`, the most deterministic intent on the network, tops out at
**1.37e-8**. `CVE_LOOKUP` at **2.13e-22**. The mean champion `eval_score` across
those 31 dead intents is **0.9126** — the gate that awarded the slot says the
module is excellent, and on real traffic it returns nothing.

Now put the agreement gate next to that. To replace the module that scores
numeric answers at 1e-8, a challenger must rank real miner answers *the way that
module already ranks them*, at 0.60 or better. A scorer that reads numbers as
measurements necessarily disagrees — ours scored −0.2585 on `WEATHER_FORECAST`,
and the disagreement is the correction. The rule admits challengers in
proportion to how little they change.

That is the whole shape of the problem: **the deterministic half of the network
is scored wrongly, and the mechanism for replacing a scoring module requires
agreeing with the module that is scoring it wrongly.** One address holds 42 of
45 champion slots out of 1153 registrations, which is what a rule like that
produces given time.

### The gate demonstrated, 27 August

Five registrations were sent within one minute of each other, from one address,
to test exactly this. Two had been evaluated an hour later.

| Reg | Intent | Our margin | Bar | Ordering | Agreement | Result |
|---|---|---|---|---|---|---|
| 1253 | `GAME_RESULT` | 0.7008 | 0.4175 | 15/15 | **0.6868** | **active** |
| 1250 | `GAS_PRICE` | 0.6446 | 0.4851 | 14/14 | **0.1288** | rejected |

Both beat the incumbent on separation. Both matched it on ordering, case for
case. The only thing that separated them was whether they ranked real miner
answers the way the incumbent already does, and that alone decided the slot.

`GAS_PRICE` is an intent whose best live miner scores **0.0054**. The module
holding it is not ranking those answers usefully — there is nothing there to
agree with — and a challenger was refused for not reproducing that ranking.


None of this needs new machinery to fix. Publish `champion_margin` alongside
`eval_score`, and exempt a challenger from the agreement gate on any intent
where the incumbent's live scores are all below some floor — an intent nobody
scores has no ranking worth agreeing with.
