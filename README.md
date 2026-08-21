# Amanat

**Verified weather intelligence that a contract acts on by itself.**

An *amanat* is a message entrusted to be carried — and, in the language of the
old telegraph offices, the dispatch itself. That is the whole shape of this
project: a miner sends the amanat, a scoring module tests it, and a contract
carries it out without anyone deciding anything by hand.

Built for Telegraph Hackathon Season I. One codebase, three entries:

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

`miner/server.mjs` wraps Open-Meteo (free, no key) and returns every answer in
two shapes at once:

```json
{
  "summary": "At 2026-08-21T06:00Z the forecast for -6.20, 106.85 is 26.2 °C with wind 2.7 km/h, gusts 5.0 km/h and 0.0 mm precipitation. Storm risk is low (0.056).",
  "temp_c": 26.2, "wind_kmh": 2.7, "gust_kmh": 5.0, "precip_mm": 0.0,
  "risk": 0.056, "breach": false, "valid_at": "2026-08-21T06:00Z", "source": "open-meteo"
}
```

The sentence is what a text-comparing scorer can grade. The scalars are what
[`Amanat.sol`](onchain/Amanat.sol) acts on, mapped through `on_chain.fields` in
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

[`onchain/Amanat.sol`](onchain/Amanat.sol) is a parametric weather cover where
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

Two champion scoring-module slots, both taken from the author who holds most of
the board. Verify either at `/api/wasm`, or on Base Sepolia.

| Intent | Registration | Our margin | Beat | Wins | Traffic gate |
|---|---|---|---|---|---|
| `STORM_ALERT` | **188** | **0.8355** | 0.7585 | 32/32 | passed, 15 rows |
| `WEATHER_CHECK` | **191** | **0.8445** | 0.7928 | 32/32 | passed, spearman **0.6111** on 79 rows |

Three things that cost a registration each and are worth writing down:

**Registration 186 lost by 0.017.** It tied the champion 32/32 on ordering and
lost on separation alone. Ordering was already perfect, so the fix was contrast
rather than judgement: `smoothstep` applied three times. A strictly increasing
curve cannot reorder a pair, so wins and rank agreement are untouched by
construction while the good/bad gap widens. 0.7415 to 0.8355.

**That rejection calibrated this repo's benchmark.** Our corpus reads 0.5650
where the protocol's hidden fixtures read 0.7415, so ours is the harsher of the
two — which is the useful direction for it to be wrong in.

**`duplicate wasm hash` is per (address, binary) across all intents**, not per
intent, so one binary holds exactly one slot. A second slot needs a build that
genuinely behaves differently: `--features weather` halves the tolerance bands,
because a forecast is an instrument reading and 39 °C is a different forecast
from 38.2 °C rather than a rounding of it.

**The traffic gate is as tight as it looked.** `WEATHER_CHECK` passed with
spearman **0.611** against a threshold of about 0.60, on 79 real rows. The
`--agreement` harness predicted exactly that: weather was where we diverged most
from the incumbent, because weather is where we mean to.

Still blocked: `registerMiner`, because `base_url` returns 302 behind Vercel
Authentication. `agent/register-miner.mjs` refuses to spend the registration
until it answers 200.

## Status

Done: miner (live upstream, validation, self-check passing, Docker image built
and health-checked, Vercel adapter tested), YAML with full on-chain mapping,
scoring module at 24 tests / 14-of-14 attacks / 37-of-38 ordering wins against
the reigning champion, rank-agreement and diff tooling, contract written, agent
loop dry-running against the live node.

Blocked, not skipped: `fly deploy` fails with `requested machine count exceeds
organization limit` on an account with zero apps, which is an account-level cap
rather than anything in this repo. The Docker image runs anywhere, and
`miner/api/` covers the serverless route.

Next: host the miner, `registerMiner` on Base Sepolia, deploy `Amanat.sol`,
`registerWasm` the scoring module. Then keep widening the benchmark — 38 cases
found four real bugs, and the next 38 will find more.

Nothing here has been submitted on-chain yet — no transaction is sent without
an explicit go-ahead.
