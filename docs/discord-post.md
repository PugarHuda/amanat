# What to post in the Hackathon Discord

Rule 06 makes joining mandatory and says staying active is expected. It is also
10% of the Track 2 score outright — "Community Engagement & Adoption: mentions,
feedback, and actual adoption of your script by others" — and adoption only
happens if people know the thing exists.

**Telegram is not mentioned anywhere in the rules.** Not in the timeline, not in
the criteria, not in the six rules. Nothing needs posting there.

Post the finding, not the project. The finding is useful to every other team;
the project is only useful to us. Anyone who wants to know who found it can
click once.

---

## The post

> **Heads up if you are building anything on the on-chain rail (ERC-8183 jobs)**
>
> Four jobs from our contract, two different intents, all four came back as a TLS
> certificate error — to a contract asking for a storm risk:
>
> ```
> reason: No hostname was supplied with this request, so the TLS/SSL
>         certificate could not be analyzed.
> ```
>
> It is not a bug in the miner that answered and it is not malformed params.
> The job is routed by rank, and nothing in that path checks whether the miner
> it lands on declares an `on_chain.request` mapping in its YAML. Without one
> the node has nothing to map the job's parameters onto, so the call falls back
> to that miner's *first* endpoint with nothing in it.
>
> On STORM_ALERT the rank-1 miner has ten endpoints and no `on_chain` block, so
> every job for that intent lands there. The same miner answers the same
> question correctly through the Engine minutes apart, from its `/storm-alert`
> endpoint, at a risk over our payout trigger. That policy would have paid.
>
> It is not one intent. Crossing the public YAMLs against the live scoreboard:
> **14 of 15 scored name-hashed intents have a rank-1 miner that cannot receive
> a job.** And rank is what causes it — rank is earned on the off-chain rail,
> where a generalist serving fifteen intents does well, and that same rank then
> routes on-chain jobs to a miner that cannot serve one.
>
> Check it yourself, it is one call and no wallet:
> `curl -s https://amanat-miner.vercel.app/api/jobable`
>
> `dead[]` is the intents that are closed. `jobable_by_intent` is who on each one
> can actually receive a job — on STORM_ALERT that is two miners out of seven.
>
> If you are a miner and you want on-chain traffic to reach you, the fix on your
> side is an `on_chain.request` block in your registration YAML. The fix on the
> protocol side is a filter: route on-chain jobs only among miners that declare
> one. That set is computable from public data in one pass.
>
> Full write-up with the four job ids and the decode steps:
> https://github.com/PugarHuda/amanat/blob/main/docs/bug-report.md

---

## Why it is written that way

- **It leads with what breaks their work, not ours.** Anyone building a Track 3
  app on jobs is about to lose the same four jobs we did.
- **Every claim is one command.** The `curl` returns the number in the post. A
  claim nobody can check is a claim nobody repeats.
- **It names the fix on both sides.** A bug report that only complains is noise;
  one that tells a miner what to add to their YAML gets acted on.
- **One link, at the end.** The repo is the citation, not the pitch.

## What not to post

- The rank table. It reads as "look where we are", and our rank is not the point.
- Anything about the scoring module. Different audience, different thread — and
  Track 2's adoption points come from people *using* the module, which means
  posting when there is something for them to use, not when there is something
  for them to admire.
- A second message if the first gets no replies. Once is a contribution; twice
  is marketing.
