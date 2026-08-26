# X posts

Single posts, in the order they happened. One a day, not all at once — the
criterion is consistency, and a burst reads like a dump. Tag
`@Telegraphprotoc` in every one.

Each post stands alone: someone landing on post 7 should understand it without
having read post 1. Every claim is checkable — a registration id, a
transaction, a number from `/api/wasm`, or a page that loads.

---

**1 — the start**

> Registered for the @Telegraphprotoc hackathon.
>
> Building Amanat: parametric weather cover where the smart contract is the
> customer of the intelligence, not a dashboard someone reads it on. It buys a
> storm reading, and if the reading crosses the line it pays the claim itself.
>
> All three tracks, one codebase.

---

**2 — what the network looked like before I wrote anything**

> Before building on @Telegraphprotoc I read the live network instead of the
> docs.
>
> 139 miner registrations. Six ERC-8183 jobs created in the chain's entire
> lifetime.
>
> Everyone is building on the HTTP rail. The on-chain rail — the thing the
> protocol is actually for — is empty.

---

**3 — the miner**

> Amanat's miner is live on @Telegraphprotoc, serving WEATHER_FORECAST,
> WEATHER_CHECK and STORM_ALERT.
>
> Every answer comes back in two shapes at once: a sentence a scoring module can
> grade, and scalars a contract can act on.
>
> Serving only one of those is why the on-chain rail is empty.

---

**4 — losing by 0.017**

> First scoring module I registered on @Telegraphprotoc lost.
>
> margin 0.74155 against the champion's 0.75854. Ordering tied 32/32. Beaten on
> separation by 0.017.
>
> Ordering was already perfect, so the fix wasn't judgement. It was contrast.

---

**5 — winning it**

> Fixed it by repeating a strictly increasing curve: it widens the gap between a
> good answer and a bad one and cannot reorder them, so ordering is safe by
> construction.
>
> 0.7415 → 0.8355. Champion on STORM_ALERT.
>
> The rejection taught more than a pass would have.

---

**6 — the loop closes**

> Amanat settled an insurance claim on @Telegraphprotoc with nobody in the loop.
>
> The contract opened an ERC-8183 job, the protocol picked the miner, validators
> finalised it, and the callback declined the claim on what came back.
>
> Before this the chain had seen 6 jobs ever. I've now run 5.

---

**7 — what a job costs, and what that buys**

> A job on @Telegraphprotoc is $1. An Engine call over x402 is $0.01.
>
> So the agent asks a hundred cheap questions before it asks one expensive one:
> it screens every open policy over HTTP, and only goes on-chain when a policy is
> near its trigger.
>
> 42 screens, one escalation, $1.42.

---

**8 — a bug worth reporting properly**

> Two ERC-8183 jobs on @Telegraphprotoc. Different coordinates stored on-chain.
> Byte-identical answers, both about 0.00, 0.00.
>
> On one of them it changed the outcome: the HTTP screen read risk 0.488, the job
> came back 0.361, and the contract declined a claim on a reading of somewhere
> else.

---

**9 — the escrow has no exit**

> Spent a while looking for how to get USDC back out of the @Telegraphprotoc
> escrow on Base Sepolia.
>
> There isn't a way. `depositUSDC` and `escrowBalance` are on the Diamond;
> nothing that takes USDC out is.
>
> 21 facets, 182 selectors, checked against 420 withdrawal-shaped names.

---

**10 — why your miner might be scoring zero**

> My @Telegraphprotoc miner served 289 requests in one epoch — more than any
> other recently registered miner but one — and scored 0.
>
> `signal_mapping.label_field` is the field a validator reads as your answer.
> Mine pointed at a boolean.
>
> If you're scoring zero with traffic, check that line first.

---

**11 — the trick has a ceiling**

> Repeating that contrast curve looks free: monotone can't reorder anything.
>
> It is not free. Five passes took my corpus from 37 ordering wins to 34.
>
> Monotone preserves order in arithmetic, not in floats — repeat it enough and
> answers that differed become equal. An equal pair is a lost pair.

---

**12 — something you can click**

> Amanat is live: read a storm risk for any point on earth. No wallet, no
> sign-up.
>
> It's the same call the contract makes on @Telegraphprotoc before it spends
> anything — and if the reading crosses 0.75, the contract pays the claim itself.
>
> amanat-miner.vercel.app

---

**13 — testing my own work**

> Ran Playwright over my own @Telegraphprotoc miner, walking the unhappy paths.
>
> A request with no coordinates answered 200 with a confident forecast for Null
> Island. Number(null) is 0.
>
> I'd filed a bug about the node sending 0,0. Turns out my own miner was turning
> nothing into zero.

---

**14 — scoring zero while serving 296 requests correctly**

> My @Telegraphprotoc miner scored 0 on three intents at once. It had served 296
> requests without an error.
>
> Validators run an epoch tournament: one question, put to every miner on the
> intent. The questions are sentences.
>
> My miner took latitude and longitude. It answered 400 to all of them.

---

**15 — teaching it to read the question**

> "Will Riyadh exceed 40 degrees in the next 24 hours?"
>
> A sentence starts with a capital, so the naive read is the phrase "Will
> Riyadh" — which geocodes to nowhere.
>
> Trim the non-places off each end and Riyadh is what is left. It also reads
> "in the next six hours" as hour 6.

---

**16 — the reason field was empty**

> Registration rejected: "YAML schema validation failed: []."
>
> An empty list. The cause was mine — a description with a comma inside a { }
> flow mapping, so the file did not parse at all — but nothing in the message
> could tell me that.
>
> updateMiner deregisters the old entry first. My miner was off @Telegraphprotoc
> for 15 minutes to learn it.

---

**17 — the check that would have caught it**

> I had five pre-flight checks before spending gas on a registration. Hash
> matches, endpoints answer, intents canonical, call simulates.
>
> None of them parsed the YAML. I was scraping it with regexes, which happily
> match a file no parser accepts.
>
> Now it parses first. @Telegraphprotoc

---

## Hold these until the numbers land

- The miner's first non-zero score, next to the `label_field` fix that caused it.
- Any registration that comes back champion.
- Total Telegraph calls by the end of Track 3, as a count with the contract
  address beside it — that is the number being weighed.
