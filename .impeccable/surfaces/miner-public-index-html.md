---
version: 1
slug: "miner-public-index-html"
primary_target: "miner/public/index.html"
related_targets: []
---

# Surface brief: miner/public/index.html

## Scope and mode
The single public page of amanat-miner.vercel.app. Persuade: a judge or an agent builder must decide, within a minute, that the loop closes on-chain and that every number is checkable; the primary action is to read a risk for a place, free.

## Audience, job, action, proof
- Judges scoring three tracks fast; builders deciding whether to call this miner.
- Job: see the mechanism (a reading crosses a line, the contract pays), then verify it.
- Action: type a place into the plate's caption and read the risk; secondary, run a route; tertiary, follow an address to Base Sepolia.
- Proof on the page: the live board of five lanes, the Typhoon Rai backtest from the archive, the on-chain ledger, the survey, the attestation on every reading.

## Constraints
- Every DOM hook the Playwright suites use stays: #ask #go #result .summary .num .figures .err, #plot .reading .val .place .over .missing, #plotstamp (+ .stale), #routeform #routefrom #routeto #routespeed #routego #routeresult .leg .verdict, #presets [data-ask], #routepresets [data-from], #ledgerbody, #bookstat, #backtestbody, #backteststat, #surveybody, #surveystat, nav a, h1 containing "One reading, one line", footer with Open-Meteo and CC BY 4.0.
- No horizontal scroll at 390px; every nav link inside 391px.
- Untrusted strings (miner summary, chain rows) rendered through textContent only.
- Functional text ≥ 11px; no eyebrow above the h1; uppercase only on short labels; no ruled-paper repeating gradient; no hairline-plus-shadow cards.
- The mark (logo.svg geometry) and the name stay; the voice stays plain and measured.

## Chosen direction and memorable moment
Beaufort Plate (seed 5db15dc1, assigned; code-led). The first viewport is one ivory plate on a night-sea ground: eleven risk bands down the left, each with the reading that reaches it and a flat layered sea glyph, the band from 0.75 red and captioned "the cover pays"; the five lanes pinned on the plate with needles that swing in with VU ballistics; the question field in the plate's caption line. Memorable moment: the Rai replay, the needle crossing into the red at 13:00 UTC, deterministic, from the archive.

## Raises carried
VU ballistics on every needle; one thing per viewport; fixed hook–place–number hierarchy on every reading; every reading and route addressable by URL; depth by overlap only; deterministic replay.

## Unresolved
Whether a second scene (a dark plate for a print handoff) is ever needed; not now.
