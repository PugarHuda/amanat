# What to post in the Hackathon Discord

**Updated 6 September with jobs 35 and 36, and measured again: 1 990 of
Discord's 2 000. There is no room left.**

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

**1 990 characters. Discord's free limit is 2 000, so there is no room left —
an earlier draft was 2 043 and would have been silently refused. Re-measure
before adding a word.**

> **Heads up if you're building on the on-chain rail (ERC-8183 jobs)**
>
> Six jobs from our contract, two intents, seventeen days apart, none of which reached a miner that could answer. In August four came back as a TLS certificate error, to a contract asking for a storm risk. On 6 September, with a typhoon 95 km off Naha, jobs 35 and 36 came back from a block explorer:
>
> ```
> status: invalid_input
> summary: I cannot look up this transaction because no
>          transaction hash was supplied.
> ```
>
> An hour apart, character for character. Off chain the same question lands on a different miner almost every run; on chain it does not move.
>
> It is not a bug in the miner that answered, and not malformed params. Jobs are routed by rank, and nothing in that path checks whether the miner it lands on declares an `on_chain.request` mapping in its YAML. Without one there is nothing to map the parameters onto, so the call falls back to that miner's **first** endpoint with nothing in it.
>
> And it is not one intent. Crossing the public YAMLs against the live scoreboard, this read: **5 of the 6 intents whose rank-1 miner I can read are closed.** On the other 9 of 15 nobody outside the node can check — 32 of 130 miners publish their YAML at http://127.0.0.1:8099/.
>
> One call, no wallet:
> `curl -s https://amanat-miner.vercel.app/api/jobable`
>
> `closed` names them with the evidence. `jobable_by_intent` is who can actually receive one — on STORM_ALERT that is skywire-storm-alert and us.
>
> Miners: add an `on_chain.request` block to your YAML. Protocol side: route on-chain jobs only among miners that declare one.
>
> Our contract read both answers, found no risk in them, and declined rather than paying on a shape it could not interpret: <https://sepolia.basescan.org/tx/0xf25259c5c39d5c9cc9372c885a1869d5a87b704df6584cbf85c09ee959848cfb>
>
> Job ids and decode steps: <https://github.com/PugarHuda/amanat/blob/main/docs/bug-report.md>
> Same readings in your own agent, no key and no wallet: `npx -y amanat-mcp`

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
