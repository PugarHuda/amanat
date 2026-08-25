# X drafts

Tag `@Telegraphprotoc` in every one. Everything here is checkable — a
registration id, a transaction, a number from `/api/wasm`, or a page you can
open. Announcements do not travel; specifics do.

Post 1 and 2 first. They are the two that give other builders something they did
not have.

---

## 1. The finding worth posting on its own: escrow has no exit

> Spent a while looking for how to get USDC back out of the @Telegraphprotoc
> escrow on Base Sepolia.
>
> There isn't a way.
>
> `depositUSDC` and `escrowBalance` are both on the Diamond. Nothing that takes
> USDC back out is.

Reply:

> Enumerated it through the diamond loupe rather than guessing: 21 facets, 182
> selectors. None matches any of 420 withdrawal-shaped names — withdraw,
> unstake, redeem, exit, reclaim, release, refund, unlock, sweep, crossed with
> the obvious suffixes and argument shapes.

Reply:

> The docs list "Escrow withdrawal timelock — 4 hours", which reads like a path
> that exists and is delayed.
>
> And the docs send you there: funding escrow is step one of the ERC-8183
> walkthrough, and a WebSocket subscription gates on a minimum escrow balance at
> connect time.

Reply:

> Testnet makes this an annoyance — mine's holding 7.4 USDC that can only ever
> leave as job payments. The same contract on mainnet would not be an annoyance.
>
> Writeup: github.com/PugarHuda/amanat/blob/main/docs/bug-report.md

---

## 2. Why your miner might be scoring zero

This one helps other people directly, which is the point.

> My @Telegraphprotoc miner served 289 requests in one epoch — more than any
> other recently registered miner but one — and scored **0**. Rank 7 of 9.
> Miners serving a third of that traffic scored 0.011.
>
> The cause was one line of YAML.

Reply:

> `signal_mapping.label_field` is the field a validator reads as your answer.
> Mine pointed at `breach` — a boolean.
>
> Grading "false" against a scraped weather reading compares nothing to
> something. Zero, every epoch.

Reply:

> The pattern across the board is unambiguous. Every miner that scores declares
> something substantive: `current`, `weather`, `answer`, `summary`.
>
> The only other miner sitting at 0 points its label at an array.
>
> If you're scoring zero with traffic, check that line first.

---

## 3. Something you can click

> Amanat is live: read a storm risk for any point on earth, no wallet, no
> sign-up.
>
> It's the same call the contract makes on @Telegraphprotoc before it spends
> anything — and if the reading crosses 0.75, the contract pays the claim itself.
>
> amanat-miner.vercel.app

Reply:

> The page is the product's own instrument. Barograph paper, an ink trace, and
> one red line at 0.75.
>
> Red appears nowhere else, so the only red thing on the page is the only thing
> that means money moves. The band above the line is usually empty, and it says
> so, because empty is the reading.

---

## 4. The on-chain loop

> Amanat settled an insurance claim with nobody in the loop.
>
> The contract opened an ERC-8183 job on @Telegraphprotoc, the protocol picked
> the miner, validators finalised it, and the callback paid or declined on what
> came back.
>
> Before this the chain had seen 6 jobs in its lifetime. We've run 4.

Reply:

> The part that cost a transaction to learn: `createJob` draws on the escrow of
> whoever calls it. That's the contract, not the wallet that deployed it.
>
> Fund the deployer and your contract cannot open a single job.

Reply:

> A job is $1. An Engine call is $0.01. So the agent asks a hundred cheap
> questions before it asks one expensive one — it screens every open policy over
> x402 and only goes on-chain when one is near its trigger.
>
> 42 screens, one escalation, $1.42.

---

## 5. Rejected for being right

> A scoring module I registered on @Telegraphprotoc beat the champion on the
> fixtures — 0.8349 vs 0.7859, ordering 32/32 — and was rejected anyway:
>
> "disagreed with the champion on real traffic: agreement -0.2585, need at least
> 0.60"
>
> Negatively correlated. On purpose.

Reply:

> The incumbent scores weather answers near zero — rank 1 on WEATHER_CHECK got
> 0.0206. The miners answer with numbers and it compares words.
>
> Its ordering of real answers is close to noise, and disagreeing with noise
> gives you a negative correlation with it.

Reply:

> So on an intent carrying traffic, a scorer can't replace the incumbent by being
> right, if being right means disagreeing with it.
>
> I haven't tuned it to agree more. A scorer fitted to match one that scores real
> answers near zero is a worse scorer.

---

## 6. The trick that stopped working

For the scorer-authors watching. This is the kind of thing people repay.

> Losing on separation with your ordering already perfect looks like a free win:
> repeat a strictly increasing curve, the good/bad gap widens, and monotone
> can't reorder anything.
>
> It is not free.

Reply:

> Five passes took my corpus from 37 ordering wins to 34 and opened an attack
> leak. Four gave 35 and still leaked.
>
> Monotone preserves order in arithmetic, not in floats. Repeated application
> saturates toward 0 and 1 until answers that differed become *equal* — and an
> equal pair is a lost pair.

Reply:

> Three passes is the ceiling. Finding it also fixed a profile that had lost the
> same three fixtures across three unrelated rebuilds: it was running four.
>
> 38/38 on the corpus now, 14/14 attacks held.

---

## Save for when the numbers land

- The miner's first non-zero score, next to the `label_field` fix that caused it.
- Any registration that comes back champion.
- Total Telegraph calls by the end of Track 3 — post it as a count with the
  contract address beside it, because that is the number being weighed.
