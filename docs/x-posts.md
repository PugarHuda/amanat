# X posts

Single posts, in the order they happened. One a day, not all at once — the
criterion is consistency, and a burst reads like a dump. Tag
`@Telegraphprotoc` in every one.

Each post stands alone: someone landing on post 7 should understand it without
having read post 1. Every claim is checkable — a registration id, a
transaction, a number from `/api/wasm`, or a page that loads.

A claim that was true in August and is not true today is worse than no post.
Anything below that quotes a rank, a score or a slot is anchored to the epoch or
the date it was read, because all three move.

## The MCP launch post (31 August)

`amanat-mcp` is on npm and listed in the official MCP registry as
`io.github.PugarHuda/amanat`. This is the post that turns a published package
into users, which is the half of Track 3's 45% we otherwise score nothing on.

No image needed — the command *is* the call to action, and a card would push the
one line people have to copy below the fold.

**A — the one-liner, 255 characters.** Leads with what they get and what it
costs them, which is nothing.

> Storm risk for any point on earth, in your agent, in one line:
> 
> npx -y amanat-mcp
> 
> Four tools, no API key, no wallet. Risk 0-1 with the 51-member ECMWF band behind it, route risk leg by leg, and a reanalysis backtest.
> 
> Reads a live @Telegraphprotoc miner.

**B — the odd tool, 266 characters.** For a more technical timeline. The
weather is the boring half; the interesting half is that the tool audits the
network it runs on, and the five failed jobs are the receipt.

> Shipped an MCP server for storm risk: npx -y amanat-mcp
> 
> No key, no wallet. The fourth tool is the odd one — it tells you which @Telegraphprotoc intents an on-chain job can actually reach.
> 
> Five of my jobs came back as TLS certificate errors. Now it's one tool call.

---

## The try-it post (31 August)

Attach `https://amanat-miner.vercel.app/card.png` as an image rather than
trusting the link preview: X caches OG images, ours changed today, and the card
is drawn from the live board — so the picture is that morning's ten lanes with
the worst one pinned in the red. It redraws itself, which means this post can be
run again in a fortnight and the image is new without anyone editing anything.

**269 characters.** The limit is 280 and the first draft was 284; the sentence
that went was "no sign-up".

> Type a place. Get a storm risk, the 51-member ensemble band behind it, and the
> line a contract pays on.
>
> Free, no wallet:
> amanat-miner.vercel.app
>
> Ten shipping lanes screened through @Telegraphprotoc every six hours. A pin in
> the red is a claim the contract settles itself.

**Alternate, 261 — leads with the film** (attach `media/amanat-demo.mp4`, X takes
video up to 2:20 and this is 1:04):

> 84 seconds, cut from five real sessions against the live miner. No mockups.
>
> A reading, a route, the on-chain ledger, and the audit that says every
> @Telegraphprotoc intent it can check is closed to on-chain jobs.
>
> Try it yourself: amanat-miner.vercel.app

**Alternate, 169 — the one-liner**, for a reply or a quote-tweet:

> A contract that buys its own storm reading from @Telegraphprotoc and pays the
> claim itself when it crosses 0.75.
>
> Read any point free, no wallet: amanat-miner.vercel.app

---

## What to post next

Re-checked against the live node on **4 September**, and reordered: Tracks 1
and 2 are closed, so every post between now and the 7th is working for Track 3,
where X is 25% and real users are most of the 45%. That changes the ordering —
posts that ask for a visit or an install now outrank posts that report a
finding, and the finding posts are the ones that make a stranger trust the
thing enough to click.

The 31 August ordering led with post 31, which has since gone false. Do not
post it; see the note there.

1. **36 — routing is a coin toss.** The replacement, and the strongest thing we
   have that nobody else is publishing: which miner the Engine actually picked,
   measured by an application that pays for the answers. Track 3 in one post —
   it is only sayable by someone whose app really uses the network.
2. **12 — something you can click.** Asks for a visit rather than a read.
   Straight at the 45%, and it should not wait behind three technical posts.
3. **The MCP launch post** (top of this file) if it has not gone out. `npx -y
   amanat-mcp` is the only line here that turns a reader into a user, and npm
   downloads say the package has had no organic installs since 2 September.
4. **30 — the contract paid claims on a field it could not name.** The Track 3
   argument in three lines, and still true.
5. **37 — my own board lied to me for two days.** Publishing your own failure is
   what makes the usage numbers in the other posts believable.
6. **32 — the champion scorer is near-binary.** Explains every weather score on
   the board at once, and anyone can reproduce it from the published `wasm_url`.
7. **33 — the hypothesis I falsified myself.** A negative result nobody had to
   publish. Rare, and it costs nothing to check: registration 2072 is on the API.
8. **35 — an outage wearing a 400.** One concrete bug with a general lesson for
   every miner on the network, which is what makes it worth other people's time.
9. **9 — the escrow has no exit.** Still unanswered, and it is a protocol
   finding rather than a project one.
10. **34 — a shared stylesheet turns the design gate off.** Off the Telegraph
    topic, so last — but it is a reproducible finding about a tool other people
    run.

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
> On 21 August: 139 miner registrations, and six ERC-8183 jobs created in the
> chain's entire lifetime.
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
> 0.7415 → 0.8355, and registration 188 took the STORM_ALERT slot on 22 August.
> It lasted a day: the 23 August evaluator change superseded every slot on the
> board, mine included.
>
> The rejection taught more than the pass did.

---

**6 — the loop closes**

> Amanat settled an insurance claim on @Telegraphprotoc with nobody in the loop.
>
> The contract opened an ERC-8183 job, the protocol picked the miner, validators
> finalised it, and the callback declined the claim on what came back.
>
> Six ERC-8183 jobs existed on this chain before mine. Of the fourteen that
> exist now, eight are mine and five settled through the callback.

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

> My @Telegraphprotoc miner had served 289 requests without an error and scored
> 0 on every intent it was registered for.
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

**18 — the diagnosis**

> Found it. My @Telegraphprotoc miner scored 0 on three intents while serving
> 296 requests without a single error.
>
> Validators run an epoch tournament: one question, put to every miner on the
> intent. The questions are sentences.
>
> My miner took latitude and longitude. It answered 400 to all of them.

---

**19 — first place, and what it was worth**

> Epoch 276: 0.000, rank 6.
> Epoch 277: 0.009192, rank 1 on STORM_ALERT.
>
> The fix was not a better forecast. It was answering the question in the form
> it was asked.
>
> At epoch 295 that intent scores six miners and I am 4th. A rank on
> @Telegraphprotoc is a reading, not a standing.

---

**20 — what actually changed**

> Two things, both about reading the question rather than the coordinates:
>
> "Will Riyadh exceed 40 degrees in the next 24 hours?"
>
> → a sentence starts with a capital, so the naive read is "Will Riyadh", which
> geocodes to nowhere. Trim the non-places off each end.
> → "in the next six hours" is hour 6, not now.
>
> @Telegraphprotoc

---

**21 — and one thing about the answer**

> The miners that scored led with a condition and a daily range. Mine led with
> wind speed.
>
> "31.4 °C with 0.1 mm precipitation" and "Light drizzle" describe the same
> hour. Only one of them answers what a person asked.
>
> Same API call, same cost. It just says the thing first. @Telegraphprotoc

---

**22 — the rejection with no reason**

> "YAML schema validation failed: []."
>
> An empty list. The cause was mine — a comma inside a { } flow mapping, so the
> file did not parse at all — but nothing in that message could tell me.
>
> updateMiner deregisters the old entry first. My miner was off the network for
> 15 minutes learning this. @Telegraphprotoc

---

**23 — the check I did not have**

> I had five pre-flight checks before spending gas on a registration: hash
> matches, endpoints answer, intents canonical, call simulates.
>
> None of them parsed the YAML. I was scraping it with regexes, which happily
> match a file no parser accepts.
>
> It parses first now. @Telegraphprotoc

---

**24 — a point forecast is the wrong shape**

> A shipment is not exposed to the weather at the port it left.
>
> Cebu → Manila at 20 knots: 0.468 at the quay, 0.524 on arrival fifteen hours
> later. Each leg is forecast for the hour the cargo actually gets there.
>
> The time axis moves with the cargo. Built on @Telegraphprotoc.

---

**25 — the shortcut that puts you in Afghanistan**

> To sample a route you interpolate between two points. Averaging the latitude
> and longitude is the obvious way and it is wrong.
>
> Cebu → Rotterdam: the average lands in Afghanistan. The great circle lands in
> the Altai. Nearly 2000 km off any path a ship takes.
>
> @Telegraphprotoc

---


**26 — a gauge that cost every visitor five API calls**

> My landing page asked the miner about five cities on every page load.
>
> Open-Meteo gives 10,000 calls a day. That is two thousand visits before the
> miner stops answering anyone — including the validators scoring it.
>
> The ceiling on how many people could use the site was the decoration.
> @Telegraphprotoc

---

**27 — what replaced it**

> Now it reads a board screened through @Telegraphprotoc every six hours.
>
> One cached request instead of five live ones, and every column has a signal
> hash behind it instead of an unverified reading.
>
> 15 paid calls buy something thousands of people can read for free.

---

**28 — every weather miner scored zero**

> Epoch 280 on @Telegraphprotoc scored 141 miner-intent pairs. 46 came back
> above zero — TASK_COMPLETION at 0.996.
>
> All 20 weather pairs came back 0.000000. Not near zero. Exactly zero.
>
> The leaderboard still ranked them 1 to 9 on top of that. They score above zero
> again now — what a rank means when they do not is the part worth keeping.

---

**29 — a rank is not a result**

> Epoch 295 on @Telegraphprotoc, WEATHER_CHECK. Rank 7 scored 0.013939 and
> rank 8 — mine — scored 0.013936. Three millionths of a point decided a place.
>
> On WEATHER_FORECAST the same epoch, five of the thirteen miners scored exactly
> 0.000000, so being 2nd there is mostly being non-zero.
>
> The rank is real. It is just not measuring what it looks like it measures.

---

**30 — the contract paid claims on a field it could not name**

> My contract read bools[0] from a miner answer as "storm breached" and paid out.
>
> But @Telegraphprotoc picks the miner. bools[0] is whatever that miner put
> first — on the registry today, as likely "is AI generated" as anything about
> weather.
>
> It declines what it cannot identify now. A wrong payout is funded by the next
> policyholder.

---

**31 — the busiest miner on the network** — ~~do not post~~, overtaken 4 Sep

> `/api/miners` on @Telegraphprotoc lists 127 live miners, each with a
> `total_requests_served`.
>
> Amanat is first at 389. The next busiest, onlookout-weather, has served 304.
>
> One curl, no wallet, no login:
> devnode.telegraphprotocol.com/api/miners

**Dead on 4 September.** DegenLens serves 1,346 and Amanat 553, so first place
is no longer ours and the runner-up named here is no longer the runner-up.
Nothing rewrites into a post worth making: "second busiest" is not a claim.
Post 36 is what replaced it — the same rail, measured where we are actually
first, and it is a fact about the network rather than a placing.

---

**32 — the scoring module is a hit or a miss, not a grade**

> Loaded the three seated weather champions on @Telegraphprotoc locally, the way
> a validator loads them, and scored one answer against several ground truths.
>
> Covers it: 0.996 to 0.999. Misses it: 0.003 to 0.013. Almost nothing lands
> in between.
>
> Live, the whole weather board sits between 0.005 and 0.017 — the miss end. So
> nobody is hitting it, and the ranking is of near-misses.

---

**33 — a hypothesis I published, then killed**

> My scoring module's source said `TEXT_AUTHENTICITY_CHECK` lost three fixtures
> because repeated contrast passes saturate mid-quality answers into ties.
>
> Registration 2072 tested it with one pass fewer. It broke none of the three —
> 13 of 15, the same as every build before it — and the margin fell 0.3808 to
> 0.3455 against a bar of 0.6667.
>
> The comment says FALSIFIED now. The scorer just ranks those three wrong.
> @Telegraphprotoc

---

**34 — a shared stylesheet turns the design gate off**

> The detector I gate this page with scans the file you hand it.
>
> `background-clip: text` over a gradient, inside a `<style>` block: caught.
> The same declaration moved to a linked stylesheet, scanning the HTML: zero
> findings. It does not follow the `<link>`.
>
> Same page my @Telegraphprotoc miner serves. Point it at the CSS too.

---

**35 — an outage wearing a 400**

> My miner answered "no place found" for Manila.
>
> Manila resolves fine. The geocoder had timed out, a catch turned the throw into
> an empty result, and the miner told @Telegraphprotoc that the city does not
> exist — confidently, on the scored path.
>
> "No such place" and "could not reach the geocoder" are different answers. It
> says which one now.

---

**36 — routing is a coin toss, and the caller pays for it**

Replaces the dead post 31. Same rail, measured somewhere we are still first:
nobody else publishes which miner the Engine picked, because nobody else was
recording it. Checkable — the tally is in the board every six hours.

> Ten shipping lanes screened through @Telegraphprotoc every six hours. 30 paid
> calls a run, and the board names who answered each one.
>
> One run: all 30 routed to a single on-chain intelligence miner and every
> answer read. The next run: not one did.
>
> Same question both times.

---

**37 — my own board lied to me for two days**

The strongest thing an application can say in a week where everyone is claiming
usage: here is ours, here is where it broke, here is the receipt. It is also
the honest version of a number we would otherwise be quoting wrong.

> My storm board published "paid rail, verified" over a run that made zero paid
> calls.
>
> Thirty legs failed every six hours saying only "unread". The reason was
> recorded the whole time — the line that publishes a leg dropped the field.
>
> It reports the failure now, and what it cost.

---

## Hold these until the numbers land

- The board of live shipping lanes, once the schedule has run long enough to show a storm move across it.
- Any registration that comes back champion. As of 31 August we hold none: the
  `GAME_RESULT` slot lasted about forty minutes before registration 1265 took it
  back, and there is nothing to claim until a new one lands.
- Total Telegraph calls by the end of Track 3, as a count with the contract
  address beside it — that is the number being weighed.
