# X drafts

Tag `@Telegraphprotoc` in every one. Everything below is checkable — a
registration id, a transaction, or a number from `/api/wasm`. Post the ones that
are still true when you post them; the board moves fast.

---

## 1. The on-chain loop (post first — nobody else has this)

> Amanat just settled an insurance claim with nobody in the loop.
>
> The contract opened an ERC-8183 job on @Telegraphprotoc, the protocol picked
> the miner, validators finalised it, and the callback paid or declined on what
> came back.
>
> Before this, the chain had seen 6 jobs in its entire lifetime. We ran 4.
>
> 0x1649ce04B8b9D56285a62Afb2b442602EE0bBc6e

Reply with the mechanism:

> The part that took a transaction to learn: createJob draws on the escrow of
> whoever calls it. That's the contract, not the wallet that deployed it.
>
> Fund the deployer and your contract can't open a single job.

Reply with the cost design:

> A job is $1. An Engine call is $0.01. So the agent asks a hundred cheap
> questions before it asks one expensive one — it screens every open policy over
> x402 and only goes on-chain when a policy is near its trigger.
>
> All three rails, cheapest first.

---

## 2. Beating the champion, and how it felt to lose by 0.017

> First scoring module I registered on @Telegraphprotoc lost.
>
> margin 0.74155 vs the champion's 0.75854. Ordering tied 32/32. Beaten on
> separation by 0.017.
>
> Ordering was already perfect, so the fix wasn't judgement. It was contrast.

Reply:

> smoothstep, applied three times.
>
> A strictly increasing curve can't reorder a pair, so ordering wins and rank
> agreement are untouched by construction — while the gap between a good answer
> and a bad one widens.
>
> 0.7415 → 0.8355. Champion.

Reply:

> That rejection was worth more than a pass. It calibrated my benchmark against
> the protocol's hidden fixtures: my corpus read 0.5650 where theirs read
> 0.7415.
>
> Mine is the harsher one. That's the useful direction to be wrong in.

---

## 3. The rejection that says something about the protocol

Post this one on its own. It is the most interesting thing in the whole build.

> A scoring module I registered on @Telegraphprotoc beat the champion on the
> fixtures — 0.8349 vs 0.7859, ordering 32/32 — and was rejected anyway:
>
> "disagreed with the champion on real traffic: agreement -0.2585, need at least
> 0.60"
>
> Negatively correlated. On purpose.

Reply:

> The incumbent scores weather answers near zero. Rank 1 on WEATHER_CHECK scored
> 0.0206 in epoch 240 — the miners answer with numbers and it's comparing words.
>
> Its ordering of real answers is close to noise. Disagreeing with noise gives
> you a negative correlation with it.

Reply:

> So on an intent that carries traffic, a scorer can't replace the incumbent by
> being right, if being right means disagreeing with it.
>
> WEATHER_CHECK squeaked through at 0.6111 against a 0.60 threshold.
> WEATHER_FORECAST, same domain, different incumbent, couldn't.
>
> I haven't tuned it to agree more. A scorer fitted to match one that scores real
> answers near zero is a worse scorer.

---

## 4. The bug, with the evidence that makes it a bug

> Found an ERC-8183 bug on @Telegraphprotoc worth reporting properly.
>
> Two jobs. Different coordinates stored on-chain. Byte-identical answers, both
> about 0.00, 0.00.
>
> Job params aren't reaching the miner.

Reply:

> It isn't cosmetic. On job 9 it changed the outcome.
>
> The Engine screen for Manila read risk 0.488, above my escalation threshold.
> The job opened for that same policy came back 0.361 — the value for Null Island
> — and the contract declined the claim.
>
> A contract that paid $1 for a signal acted on a reading of somewhere else.

Reply:

> Same miner answers Manila correctly over HTTP. It's the job path, not the
> miner.
>
> Full writeup, reproducible:
> github.com/PugarHuda/amanat/blob/main/docs/bug-report.md

---

## 5. The scoring module itself

> My @Telegraphprotoc scoring module reads answers as measurements instead of
> text.
>
> 38.2 °C, 100.8 F and 311.35 K are one reading. 10 m/s and 36 km/h are one wind
> speed. 0.3° out is right, 30° out is wrong.
>
> 12 KB of no_std Rust, zero imports.

Reply:

> Three rules do the anti-gaming:
>
> A number the question already gave you earns nothing when you hand it back.
> Committing beats covering — listing every candidate value is charged for.
> Contradicting the verdict keeps 15% of your score.
>
> 14/14 attacks held.

Reply:

> Eight profiles, because the registry binds one binary to one intent and refuses
> the same bytes twice. So domain knowledge lives in the build:
>
> finance — a price is exact
> weather — a reading, 39 isn't a rounding of 38.2
> forecast — a prediction, honest uncertainty
> authenticity — no figure at all
>
> All 37/38.

---

## Things worth saying that aren't posts yet

Save these for when the numbers land:

- Miner 179 once it has served scored traffic and has a rank.
- Whichever of registrations 649–653 come back champion.
- Total Telegraph calls the agent has made by the end of the week — that is the
  Track 3 number judges are actually weighing, so post it as a count with the
  contract address next to it.
