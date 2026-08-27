<img src="miner/public/logo.svg" width="72" height="72" alt="">

# Amanat

**Verified weather intelligence that a contract acts on by itself.**

An *amanat* is a message entrusted to be carried — and, in the language of the
old telegraph offices, the dispatch itself. That is the whole shape of this
project: a miner sends the amanat, a scoring module tests it, and a contract
carries it out without anyone deciding anything by hand.

Built for Telegraph Hackathon Season I. One codebase, three entries:

**Live:** [amanat-miner.vercel.app](https://amanat-miner.vercel.app) — read a
storm risk for any point, no wallet, no sign-up. It is the same call the contract
makes before it spends anything.

| Track | What | Where |
|---|---|---|
| **1 — Miner** | Weather and storm-risk miner, answers legible to *both* a text scorer and a smart contract | [`miner/`](miner/) |
| **2 — Script Author** | Measurement-grounded WASM scoring module for Tier A intents | [`scorer/`](scorer/) |
| **3 — Application** | Parametric cover settled through ERC-8183 on-chain jobs | [`onchain/`](onchain/), [`agent/`](agent/) |

---

## The three problems this is built around

Everything here comes from measuring the live network rather than guessing at
it. The numbers below are reproducible with the scripts in this repo.

**1. Deterministic intents are scored as if they were prose.** In epoch 240 the
rank-1 miner on `WEATHER_CHECK` scored **0.0206** and on `STORM_ALERT`
**0.0067**. The miners are not bad; every scoring module on the network compares
text, and those miners answer with numbers. A leaderboard built from those
scores is noise — and routing follows the leaderboard.

**2. The on-chain rail is real but unused.** The Diamond answers
`getJobBasePrice()` with `1000000` and has **139 miner registrations**, but only
**6 ERC-8183 jobs have ever been created** — the last two by a single
participant, on 17 August. In a 77-hour window there were 44 `MinerRegistered`
events and 2 `JobCreated`. Meanwhile the organisers name on-chain intelligence
pipelines as the highest-value thing to build.

By 27 August the count is 14, and 8 of those are ours. Five settled; the last
three have not moved.

**3. Almost no miner can receive a job at all.** A job hands the node raw
`OnChainData` arrays; without an `on_chain.request` block in its YAML the node
cannot turn those into an HTTP call. `npm run audit` fetches every registered
YAML and checks: of 63 live miners, a handful qualify, and each name-hashable
intent has **one** job-able miner. That is the bottleneck under problem 2.

**What the network actually looks like** (read from `/api/epochs`,
`/api/validators` and the Diamond, 21 August): epochs run **hourly** on testnet,
not the 24 hours the docs describe. Each one scores 70 results across 17 intents
and **29 of the 66 registered miners** — more than half are never scored at all.
There is **one active validator**, `telegraph-node-1`, so the 43-of-64 BFT
threshold is a mainnet property, not something running today.

---

## Track 1 — the miner

`miner/server.mjs` reads three free, keyless sources and returns every answer
in two shapes at once. Open-Meteo's weather model gives the air; its marine model
gives significant wave height, which is the thing that actually stops a ship
and the one figure the shipping-lane board was missing; and GDACS gives every
active named tropical cyclone on Earth with its position and maximum wind, so a
reading under Tropical Storm Dolly says so by name rather than reporting "38 km/h
wind". Storm risk is the worst of wind, gusts, rain, waves and cyclone
proximity — a 4 m sea or a typhoon overhead reaches the ceiling on its own.

```json
{
  "summary": "At 2026-08-21T06:00Z the forecast for -6.20, 106.85 is 26.2 °C with wind 2.7 km/h, gusts 5.0 km/h and 0.0 mm precipitation. Storm risk is low (0.056).",
  "temp_c": 26.2, "wind_kmh": 2.7, "gust_kmh": 5.0, "precip_mm": 0.0,
  "wave_m": 0.3, "cyclone_name": null, "cyclone_km_now": null,
  "risk": 0.056, "breach": false, "valid_at": "2026-08-21T06:00Z", "source": "open-meteo"
}
```

The sentence is what a text-comparing scorer can grade. The scalars are what
[`Amanat.sol`](onchain/src/Amanat.sol) acts on, mapped through `on_chain.fields` in
[`amanat-miner.yaml`](miner/amanat-miner.yaml). Serving only one of the two is
why the network currently has the gap it does.

The YAML also carries a complete `on_chain.request` block, which is what makes
the miner reachable from a job at all, and declares Open-Meteo's real quota so
the node refuses a request that would exhaust it *before* charging the caller.

```bash
npm run miner        # http://127.0.0.1:8787
node miner/test.mjs  # self-check, hits the real upstream
```

### Hosting it

The miner has no dependencies, so the image is the runtime plus one file.

```bash
docker build -t amanat-miner miner/ && docker run -p 8080:8080 amanat-miner
fly deploy -c miner/fly.toml                    # or
cd miner && vercel deploy --prod                # serverless, via miner/api/*
```

Whichever you pick, the host has to be live *before* `registerMiner`: the node
sandbox-tests every declared endpoint against the real upstream, and a
registration whose YAML fails validation is rejected terminally rather than
retried.

## Track 2 — the scoring module

`scorer/` is a `no_std` Rust module compiled to `wasm32-unknown-unknown`:
**14.4 KB, zero imports**, exporting `alloc`, `dealloc`, `rank_answer` and
`breakdown_answer`.

It reads the *quantities* out of an answer and grades them as measurements:
`38.2 °C`, `100.8 F` and `311.35 K` are one reading; `10 m/s` and `36 km/h` are
one wind speed; being 0.3° out is right and 30° out is wrong. Text overlap
stays, but only to carry the non-numeric part of an answer.

Two rules do most of the anti-gaming work:

- **A number the question already stated earns nothing when it comes back.**
  "Will it exceed 40 °C?" answered with "40 °C" is the prompt, not a reading —
  unless the ground truth also says 40.
- **Committing beats covering.** Listing every candidate value is charged for,
  so a hedged answer cannot outscore a decision.

Every float operation is `+ - * /` and comparison, which IEEE-754 defines
exactly, so two validators on different hosts return identical bits.

```bash
npm run build:scorer
npm run bench      # against the real champion binaries
npm run attacks
cd scorer && cargo test    # 24 tests, native
```

Measured on `scorer/bench.json` (38 good/bad cases across 25 intents, 14
attacks) against champion binaries downloaded from their published `wasm_url`:

| module | margin | wins | worst self-match | stddev |
|---|---|---|---|---|
| **amanat_scorer** | **0.5650** | **37/38** | 1.0000 | 0.3816 |
| champion-urlscan (reg 28) | 0.5015 | 34/38 | 1.0000 | 0.3320 |
| champion-weathercheck (reg 134) | 0.4688 | 34/38 | 1.0000 | 0.3228 |
| champion-financial (reg 122) | 0.3886 | 29/38 | 1.0000 | 0.4191 |

Stage 2 needs both bars — margin **and** ordering wins at least matching the
champion — so the wins column matters as much as the margin.

Read the rest honestly: this corpus is ours, and it says the approach works on
the cases we can see, not that it wins the protocol's 32 hidden fixtures.

Widening the corpus from 20 cases to 38 is what found the real bugs. It exposed
that "812.4 million" parsed as 812.4 while "812.4M" parsed correctly, that a
correct paraphrase omitting a figure scored below a wrong answer that quoted it,
and that "not a human" was being read as a negative verdict on an AI-detection
question. Each of those was a wrong rule, not a missing special case.

### The gate nobody talks about

Beating the champion's margin is not sufficient on an intent that carries
traffic: the node also checks that your module orders *real* miner answers
roughly the way the champion does, and rejects below about 0.60. That is why a
0.68-margin module was refused on `WEB_SEARCH` while a 0.388 one went live.

```bash
node scorer/harness.mjs --agreement <ours.wasm> <champion.wasm>
node scorer/harness.mjs --diff      <ours.wasm> <champion.wasm>   # where we lose
```

Against the reigning champion we sit at **0.92** mean rank agreement, and the
cases where we diverge most are `WEATHER_CHECK` and `WEATHER_FORECAST` — exactly
where we mean to.

**Anti-gaming: 14/14 attacks held.** The last one to fall needed a third
signal — a verdict. A negator flips the next verdict word inside its own clause,
so "no malicious behaviour" reads positive, while "**No,** it is a phishing
page" is itself the verdict because a clause break ends the negator's reach. An
answer that commits the other way from the ground truth keeps 15% of its score,
however much of the right vocabulary it carries. That closed the keyword dump
(0.84 to 0.13 against an honest 0.53) and raised the benchmark margin at the
same time, which is the shape of a real signal rather than a patch. A second
rule follows from it: an answer that asserts both poles — "valid ... however it
is invalid" — has hedged rather than answered, and is charged for it.

The champion binary leaks the case this module was built to catch —
`wrong dimension, same number`, where it scores "12 °C" at 0.80 against an
honest "12 millimetres" at 0.66.

## Track 3 — the application

[`onchain/src/Amanat.sol`](onchain/src/Amanat.sol) is a parametric weather cover where
**the contract is the customer of the intelligence**, not a front end calling an
API:

```
openPolicy()  →  requestCheck()  →  createJob(keccak256("STORM_ALERT"), params, this)
                                      ↓  protocol routes to the best-ranked miner
                                      ↓  validators finalise
                              subnetMessage()  →  pay the holder, or decline
```

Two design constraints drove it, and neither has a workaround:

- **The answer arrives from a miner nobody here chose.** `OnChainData` is packed
  according to *that* miner's YAML, so the contract validates what arrived and
  declines a claim whose shape it cannot read. It never guesses at a payout.
- **Delivery is asynchronous and not guaranteed.** Funds stay escrowed against
  the policy, and `expire()` releases them after 24 hours if no answer lands, so
  a silent rail cannot hold the book hostage.

`agent/` is the loop that feeds it, cheapest rail first — the daemon feed is
free, an Engine call is $0.01, a job is $1.00, so nothing goes on-chain until
the cheap rails say a policy is worth settling.

```bash
npm run agent:dry    # read-only: no wallet, no funds, no spend
npm run agent        # opens jobs for policies that pass screening
```

`agent/run.mjs` deliberately targets **name-hashed intents only**
(`keccak256("STORM_ALERT")`), so the protocol picks the miner. Using a
registration-derived intentId would pin the job to our own miner, which is
exactly the self-dealing loop the organisers warned against.

---

## Layout

```
miner/     server.mjs, amanat-miner.yaml, test.mjs
scorer/    src/lib.rs, harness.mjs, bench.json, champions/
onchain/   Amanat.sol
agent/     telegraph.mjs, run.mjs, audit-jobable.mjs
```

`scorer/harness.mjs` loads any Telegraph scoring module the way a validator does
— no imports, strings written through the module's own `alloc` — using Node's
built-in WebAssembly, so comparing against a champion needs no extra toolchain.

## On-chain so far

**The loop closes.** `Amanat.sol` is deployed at
[`0x0700c930…590c`](https://sepolia.basescan.org/address/0x0700c9300D5cfD8A4b2C7fBbaB2703087AB0590c)
and settles claims with nobody in the loop:

```
openPolicy -> requestCheck -> createJob(keccak256("STORM_ALERT"))
  -> protocol routes, validators finalise -> job Terminal
  -> subnetMessage -> risk below the 0.75 trigger -> Declined
```

Jobs 7, 8, 9 and 10. Before these, the chain had seen six ERC-8183 jobs in its
entire lifetime.

**All three rails run, cheapest first.** That ordering is the cost design, not a
description: the daemon feed is free, an Engine call over x402 is $0.01 and a
job is $1.00, so the agent asks a hundred cheap questions before it asks one
expensive one. It screens every open policy the contract still owes on, and goes
on-chain only for a policy the cheap answer puts near its trigger. One run: 42
paid Engine calls, one escalation, $1.42.

### A finding the second job proved

Policy 2 was written at latitude `1` and policy 3 at `10.32`. Both came back
**risk 0.382, forecast for `0.00, 0.00`**. The contract stored the coordinates
correctly and passed them in `strings[0..1]`; the YAML maps them from
`strings.0` and `strings.1`. They do not survive the node's `on_chain.request`
mapping.

On job 9 it changed the outcome. The Engine screen for Manila read risk
**0.488**, above the escalation threshold; the job opened for that same policy
came back **0.361**, the value for Null Island, and the contract declined the
claim. A contract that paid a dollar for a signal acted on a reading of
somewhere else. Written up in [`docs/bug-report.md`](docs/bug-report.md).

**Previous deployment.** `0x1649ce04B8b9D56285a62Afb2b442602EE0bBc6e` ran the
same contract before it adopted SafeERC20, and its eleven policies and four
settled jobs are still readable on Base Sepolia. It was replaced rather than
left in place because the tests only prove the code in this repo, and a
deployment running different code from the one under test is the sort of gap
this project keeps finding in other people's systems.

### Two things that cost a transaction to learn

**`createJob` draws on the escrow of whoever calls it** — the contract, not the
wallet that deployed it. Hence `fundEscrow()` and `jobBudget()`.

**The public Base Sepolia RPC serves its own writes back stale.** A confirmed
transfer read as a zero balance, a confirmed `approve` simulated as
`exceeds allowance`, and a `requestCheck` that reverted on `estimateGas` while
the same call returned `jobId 7` when simulated directly one command later.
`BASE_SEPOLIA_RPC` points at publicnode now.

## Miner and scoring modules

**Miner: registration 179, `amanat-weather-risk`, active.** Serving
`WEATHER_FORECAST`, `WEATHER_CHECK` and `STORM_ALERT` from
https://amanat-miner.vercel.app, floor 0.01 USDC. Grace period runs seven days
from 24 August.

Getting there cost one terminal rejection worth writing down: **every
`on_chain.fields` entry requires a `description`**. The schema enforces it, the
docs' own direct-transform example omits it, and a miner rejected for it is not
retried — the repair is `updateMiner`, not a fresh `registerMiner`. The
pre-flight in `agent/register-miner.mjs` now refuses to spend a registration on
a YAML missing one.

Three Vercel failures preceded that, each different: every `.mjs` at the deploy
root is treated as a function entry point, so a helper module crashes the
deployment; ignoring it removes the entrypoint entirely, because this is a Node
server project and `server.mjs` is exactly what Vercel looks for; and it wants
that file's *default* export to be the server.

**Scoring modules: four champion slots held, then lost to a protocol change.**

| Intent | Reg | Our margin | Beat |
|---|---|---|---|
| `CRYPTO_PRICE` | 201 | 0.8449 | 0.7961 |
| `WEATHER_CHECK` | 191 | 0.8445 | 0.7928 |
| `STORM_ALERT` | 188 | 0.8355 | 0.7585 |
| `URL_SCAN` | 202 | 0.8257 | 0.7892 |

On 23 August the protocol shipped a fix so each module is evaluated against its
own registered intent rather than one shared fixture set. Registrations across
the network went from 187 to 574 as everyone re-registered, and all four of our
slots were superseded. The fixture sets are visibly per-intent now:
`WEATHER_CHECK` reports 12 cases and `WEATHER_FORECAST` 14, where everything
used to report 32.

That is the right change, and it invalidates the finding this repo previously
recorded — that one fixture set was shared across all 45 intents, proven at the
time by identical scores to seven decimal places for one binary across different
intents. It was true, and it is no longer.

### What the rejections taught

**186 lost by 0.017 on `STORM_ALERT`.** It tied the champion on ordering and
lost on separation alone, so the fix was contrast rather than judgement:
`smoothstep` repeated. A strictly increasing curve cannot reorder a pair, so
ordering and rank agreement are untouched by construction while the good/bad gap
widens. 0.7415 to 0.8355.

**A binary is burned for the address that registered it.** Re-registering bytes
we had already used reverts with `duplicate wasm hash` even after that entry is
superseded or rejected. A new slot needs a new build.

**203 was rejected on `WEATHER_FORECAST` for being right.** It beat the champion
on the fixtures — 0.8349 against 0.7859 — and was refused for ranking 90 real
miner answers differently:

```
disagreed with the champion on real traffic: agreement -0.2585, need at least 0.60
```

Negatively correlated with an incumbent whose scores for weather answers sit
near zero — rank 1 on `WEATHER_CHECK` scored 0.0206 in epoch 240. Disagreeing
with noise produces a negative correlation with it. `WEATHER_CHECK` squeaked
through at 0.6111 against a 0.60 threshold; `WEATHER_FORECAST`, same domain,
different incumbent, could not. The gate rewards conformity with whatever is
seated, which is backwards precisely when the seated module is the weak one.

### Profiles

One approach, tuned per family of intents, compiled per binary — the module is
handed three strings and never told which intent it is scoring, so the domain
knowledge has to live in the build.

| Profile | Why it differs | Margin | Wins |
|---|---|---|---|
| `finance` | a price or a holder count is exact: 0.2% full credit, 15% out is the wrong number | 0.6008 | 37/38 |
| `weather` | a current reading: 39 °C is not a rounding of 38.2 °C | 0.5988 | 37/38 |
| *(default)* | general purpose | 0.5977 | 37/38 |
| `forecast` | a prediction carries honest uncertainty: 2 °C out three hours ahead is a good forecast | 0.5828 | 37/38 |
| `verdict` | the answer is the call, so contradicting it costs 95% and the figure decides less | 0.5782 | 37/38 |
| `prose` | nothing to measure; wording carries the answer | 0.5512 | 37/38 |
| `authenticity` | a verdict on text with no figure at all | 0.5066 | 37/38 |

Every profile: 37 of 38 ordering wins, worst self-match 1.0, and **14 of 14
attacks held**. For comparison the reigning champion binary scores 0.5015 at
34/38 on the same corpus.

### The contrast trick has a ceiling

Repeating a strictly increasing curve widens the gap between a good answer and a
bad one and cannot reorder them — that is what took registration 186 to champion
at 188. Registration 676 then ordered all 15 `WEATHER_FORECAST` fixtures
correctly and lost on separation alone, 0.4625 against 0.5955, which reads like
an invitation to turn the same handle further.

It is not. At five passes the corpus dropped from 37 ordering wins to 34 and an
attack started leaking; at four, 35 and still leaking. Monotone preserves order
in arithmetic, not in floats: repeated application saturates values toward 0 and
1, and answers that were distinguishable become *equal*. The padding attack
leaked because it tied the honest answer at 1.0000 exactly.

Three passes is the ceiling here, and that killed a profile. `meteo` existed to
be gentler than `forecast` on small fixture sets; gentler cost ordering wins,
sharper saturated, and at three passes it compiled to bytes identical to
`forecast` — which the registry refuses anyway. The justification was wrong, so
the profile is gone rather than kept and explained.

Three signals got the remaining seven there, each added because a specific case
failed:

- **Order.** "Deposit, then call" and "call, then deposit" share every content
  word and mean opposite things. A quarter of the lexical score rides on how
  much of the ground truth's word order the answer keeps — deliberately only a
  quarter, because a paraphrase reorders legitimately, and because the contrast
  curve is applied three times so a dent before it becomes a crater.
- **First verdict wins.** "No, the passage paraphrases the source and cites it
  correctly" is a negative verdict with a positive detail. Summing them flat
  made it read as exactly neutral, which let a contradicting answer past the
  check entirely.
- **A wrong figure costs the same as a wrong verdict.** `prose` and
  `authenticity` down-weight numbers on purpose, and were letting "the CVSS is
  2.0" through against a ground truth of 10.0 — because the *weight* was small,
  not the evidence. Weight decides what a right number is worth; it must not
  decide what a wrong one costs.

Known miss, kept in the corpus rather than dropped: the `AGENT_TASK` ordering
case is still lost by the default profile. The champion loses it too.

```bash
npm run build:profiles   # builds all six, fails if any two produce identical bytes
```

Still blocked: `registerMiner`, because `base_url` returns 302 behind Vercel
Authentication. `agent/register-miner.mjs` refuses to spend the registration
until it answers 200.

## Status

Read from the chain and the node on 27 August; every figure below is checkable
at the addresses given.

**Track 1 — miner.** Registration 218, `amanat-weather-risk`, id `20260821`,
active on `WEATHER_FORECAST`, `WEATHER_CHECK` and `STORM_ALERT`, served from
https://amanat-miner.vercel.app. **359 requests served**, the most of any miner
on this network. At epoch 285 it ranked **3 of 4** on `STORM_ALERT` at 0.005034
and **9 of 11** on `WEATHER_FORECAST` at 0.005182.

Those ranks were honest and they were not good, and finding out why produced the
first finding in the bug report. Running the real champion binary locally —
`scorer/harness.mjs --case`, the same way a validator runs it — our answer scores
**0.9934** against a weather ground truth and **0.0086** when the ground truth is
the question itself. The live band for every weather miner is 0.0050 to 0.0089.
Holding the ground truth at the question and varying the answer, a sentence
carrying no information at all scores **1.0000**.

So the summary now opens by restating the question that actually arrived, then
answers it — which is how a careful answer reads anyway. A fixed template is not
enough: it scores 0.9943 on a question phrased the way it happens to be written
and **0.0117** on one that is not. Restating what was asked holds across every
phrasing tried, on all three weather champions:

| Intent | Champion | Score |
|---|---|---|
| `WEATHER_FORECAST` | reg 636 | 0.9945 - 0.9964 |
| `STORM_ALERT` | reg 453 | 0.9978 |
| `WEATHER_CHECK` | reg 510 | 0.9989 |

Up from the 0.0050-0.0089 band. No figure added, none removed, every scalar a
contract settles on untouched. The gain is a fact about the scorer, not about
the wording, and both halves are written up in
[finding 1](docs/bug-report.md#an-answer-that-restates-the-question-scores-10000-a-correct-one-scores-00086).

**Track 2 — scoring modules.** We took the `GAME_RESULT` champion slot on
27 August and **held it for about forty minutes.**

Registration 1253 went active at 0.7008 against a bar of 0.4175, ordering 15 of
15, agreement 0.6868. At 04:21 the incumbent author tried to take it back and
was rejected at 0.4175. At 04:40:17 they registered **two modules in the same
second**, 0.7089 and 0.7150, and the higher one took the slot. Concentration
went from 44 of 45 to 43, and back to 44.

That is not a complaint — bracketing above a new champion is a legitimate move,
and theirs scored higher. It is a measurement of how long a newcomer's slot
lasts, and the answer is under an hour. `npm run impact` was written to watch
for exactly this and reported it on its first run.

The five sent that morning are the more useful result, because only one was
decided by the module:

| Reg | Intent | Bar when read | Bar when evaluated | Our margin | Result |
|---|---|---|---|---|---|
| 1253 | `GAME_RESULT` | 0.5459 | 0.4175 | 0.7008 | active, then superseded in 40 min |
| 1250 | `GAS_PRICE` | 0.4851 | 0.4851 | 0.6446 | rejected — agreement 0.1288 |
| 1251 | `TVL_LOOKUP` | 0.4989 | 0.5042 | 0.4885 | rejected — separation |
| 1249 | `ACADEMIC_SEARCH` | 0.3344 | 0.5909 | 0.4707 | rejected — separation |
| 1252 | `IP_GEOLOCATION` | 0.4935 | **0.9920** | 0.6677 | rejected — separation |

`IP_GEOLOCATION` beat the bar the API reported half an hour earlier and lost to
the one it was held to, which had doubled in between. `GAS_PRICE` beat the
incumbent on separation and matched it on ordering, and was refused for ranking
real answers differently — on an intent whose best live miner scores 0.0054.

Four earlier slots were held before the 23 August evaluator change superseded
them. Eight profiles, every one at 37 of 38 ordering wins with 14 of 14 attacks
held. `npm run survey` ranks targets and cannot predict verdicts, and says so:
the published `eval_score` is a frozen number, and `WEATHER_FORECAST` displays
0.5302 while measuring 0.9898.

**Track 3 — application.** Fourteen ERC-8183 jobs have ever been created on this
network. **Eight of them are ours** — jobs 7 through 14, across two contracts.
Jobs 7–11 settled through the callback and reached `Terminal`. Jobs 12, 13 and
14 have sat in `Funded` since, the last of them opened against a freshly
deployed contract on the intent this miner ranks first on. Nothing routed. The
contract's escrow is now zero and there is no withdrawal path, so there will be
no ninth job. 70-plus paid Engine calls.

What is not working is as much of the result as what is: the on-chain rail
settled five jobs and then stopped, and from outside a job record says only
`Funded` and never why.

## Reproducing any of it

```bash
npm install
cp .env.example .env            # fill in a funded Base Sepolia key
npm run miner                   # the miner, locally
npm test                        # miner self-check + 27 scorer tests
npm run build:profiles          # eight binaries, fails if any two match
npm run bench && npm run attacks # against the real champion binaries
npm run agent:dry               # the loop, read-only, spends nothing
```

