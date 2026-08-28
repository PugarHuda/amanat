# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, confirmed, both reading fast and skeptical:

- **Hackathon judges** for Telegraph Hackathon Season I, scoring three tracks (miner, scoring module, on-chain application) in a few minutes per entry. They want the claim, the proof, and the on-chain address they can check, in that order.
- **Agent and contract builders** deciding whether this miner is worth calling — from an agent over MCP or x402, or from a contract through an ERC-8183 job. They want the answer shape, the guarantees, and what it costs.

Secondary, not confirmed as a design target: other Telegraph miners reading the scoring survey and the bug report.

## Product Purpose

Amanat is verified weather intelligence that a contract acts on by itself. One codebase, three entries: a miner that answers in two shapes at once (a report a text scorer can grade, and the scalars a contract settles on); a `no_std` WASM scoring module that grades answers as measurements; and a parametric weather-cover contract on Base Sepolia that buys a storm reading from whichever miner the network ranks best and pays the claim itself when the reading crosses 0.75. Success is a judge or builder seeing, within a minute, that the loop closes on-chain and that every number on the page is checkable.

## Positioning

**A contract that buys its own evidence and pays itself — with the evidence a reinsurer would recognise.** Every answer carries sea state (Open-Meteo marine), the nearest named cyclone (GDACS), an ensemble band across 51 ECMWF members (how sure the model is), an Ed25519 attestation over the settle fields (who said it), and a backtest against the reanalysis archive (would it have paid: Typhoon Rai, 16 December 2021, Cebu 1.000 with 170 km/h gusts, Singapore 0.418). No other miner on the network carries any of those; the network's own `signal_hash` cannot be re-derived from outside. Everything is measured from the live network and written down, including what is broken.

## Operating Context

- Live site: https://amanat-miner.vercel.app (Vercel, manual deploy + alias; free tier caps 100 deploys a day).
- Telegraph devnode at devnode.telegraphprotocol.com; Diamond and USDC on Base Sepolia; ~hourly epochs score miners per intent.
- The page is read from a link on X or the hackathon submission, on desktop and phone, often in the dark.
- Data: Open-Meteo weather, marine, ensemble and archive models (CC BY 4.0, attribution required on every answer); GDACS cyclone feed.
- The storm board (five shipping lanes screened through Telegraph) is published every twelve hours to an orphan `board` branch by GitHub Actions; the page reads it, and says when it is stale.

## Capabilities and Constraints

- `POST /forecast` with coordinates or a plain-language question; `hours` parsed from a question is a window answered at its worst hour; explicit hours are an exact hour (the contract path).
- `GET /api/route` (risk per leg at the hour the vehicle reaches it), `/api/backtest`, `/api/board`, `/api/survey` (what the network scores: measured bar vs displayed champion score), `/api/asked` (what the node actually sends), `/openapi.json`, `/llms.txt`, `/.well-known/amanat.json` (signing key).
- The miner has **no dependencies**; Vercel runs `server.mjs` directly; the page is one static `index.html` with inline CSS and JS, rendered through `textContent` (miner and chain output are untrusted).
- Terminology: *reading* (one answer), *trigger* (0.75), *breach*, *policy*, *job* (ERC-8183), *epoch*, *champion* (scoring-module slot), *bar* (the margin a challenger must clear).
- Undecided: whether the page should ever sell cover to a real customer. Today it demonstrates and lets anyone read a risk for free.

## Brand Commitments

- Name: **Amanat** — a message entrusted to be carried; in old telegraph offices, the dispatch itself.
- Mark: `miner/public/logo.svg`, a barograph trace crossing a dashed trigger line, green below and red above, with the pen nib at the head. The header inlines it against page tokens.
- Voice: plain, measured, exact; says what is broken as readily as what works; no hype, no "boost", no exclamation marks. Numbers carry the argument.
- The user has **released the incumbent visual world** (ruled barograph paper, ink trace, one red trigger line, Familjen Grotesk + IBM Plex Mono + Public Sans). A replacement world may be chosen; the mark, the name and the voice stay.

## Evidence on Hand

- On-chain: contract `0x0700c9300D5cfD8A4b2C7fBbaB2703087AB0590c`, jobs 7–14, expire/sweep transactions, registration 256 — all linked from README.md.
- Live figures: 359+ requests served (most of any miner), epoch ranks per intent, the survey, the board.
- Backtest: Typhoon Rai over five ports, from the archive, live on the page.
- `docs/bug-report.md`: fourteen measured findings against the network.
- `docs/x-posts.md`: the post thread.
- No customer testimonials, no press, no pricing, no partners. None may be invented.

## Product Principles

1. **Every number is checkable.** An address, a transaction, a signal hash, an archive date, or a signature sits beside every claim; a figure without one is not shown.
2. **Say what is missing.** Null over land, "stale" on an old board, "could not read the archive" — an absence is reported as an absence, never as a calm zero.
3. **The contract is the customer.** Readings exist to be acted on; scalars and their on-chain projections are the product, the prose serves the scorer and the reader.
4. **Free to read, honest about cost.** Anyone reads a risk for free; the paid rails and what they cost are stated where they apply.
5. **Broken is a finding, not a secret.** What the network does wrong is measured and published beside what works.

## Accessibility & Inclusion

Keyboard-operable forms with visible focus; every interactive element labelled; axe-core checks run in the Playwright UI suite on Chromium, Firefox and WebKit; both colour schemes; text never below 11px for functional content; no information carried by colour alone (a breach is also the word "pays").
