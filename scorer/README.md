# The scoring module, and what it is up against

`amanat_scorer` reads the *quantities* out of an answer and grades them as
measurements rather than as text. `38.2 °C`, `100.8 F` and `311.35 K` are the
same reading; being 0.3° out is right and being 30° out is wrong. 1 411 lines of
`no_std` Rust, no allocator, no imports, every buffer static — about 16 KB of
WASM.

```bash
cargo test                       # 27 unit tests
npm run build:profiles           # eight profile builds into scorer/dist/
npm run bench                    # every module against every champion we hold
npm run attacks                  # each attack must score below the honest answer
node scorer/harness.mjs --agreement <ours.wasm> <champion.wasm>
```

## What registration 1112 taught us

Submitted to `WEATHER_FORECAST` on 26 August. Rejected, and the numbers are
worth more than the slot would have been:

```
candidate_margin           0.8207     champion_margin  0.9900
candidate_wins             15         champion_wins    15
worst_self_match           1.0
historical_rows_evaluated  0
```

Three things follow.

**Our own benchmark understates us.** `scorer/bench.json` put the same binary at
0.5988. The node measured 0.8207 on its own fifteen cases. The corpora disagree
enough that a local margin is a direction, not a number — worth remembering
before reading too much into `npm run bench`.

**`eval_score` in `/api/wasm` is not what it looks like.** It is the margin that
registration achieved *against whoever was champion at the time*, not the
module's current strength. Reading it as absolute made `WEATHER_FORECAST` look
like the weakest weather intent at 0.530 when the incumbent actually measures
0.9900 today. That misreading is what sent 1112.

**We lost on separation alone.** Wins tied at 15, self-match perfect. The gate
was how far apart the module pushes a good answer from a bad one.

## Why separation cannot simply be turned up

`smoothstep` is applied `CONTRAST_PASSES` times. It is strictly increasing, so
it widens the gap between good and bad without ever reordering them — which is
exactly what separation measures and why raising it is the obvious move.

It is capped at three, and the reason in the source used to be float saturation:
smoothstep has zero gradient at both ends, so a fourth pass pushed values close
enough to 0 and 1 that answers which differed became equal, and an equal pair is
a lost pair.

That reason is fixable — blending a sliver of the input back in each pass bounds
the gradient away from zero, so ties cannot be manufactured however hard the
curve is driven. It was tried. The tests still failed at four passes, for a
second reason the comment did not mention: the curve is applied *inside one
factor of a product* (`smoothstep(...) * verdict`), and different answers take
different branches. More contrast shrinks small values far more than large ones,
so it changes comparisons **across** branches even though it preserves order
within one. `a_missing_figure_is_not_a_wrong_figure` and
`the_first_verdict_is_the_answer` both invert.

So three is the ceiling, and the lever is genuinely exhausted. Closing a 0.82 to
0.99 gap needs a different mechanism, not a sharper curve.

## What the incumbents are

Every one of the 45 champion slots on the network is held by a single author.
The weather binaries are 24–29 MB — embedded transformer weights, from
`telegraph-salience-scorer`. Ours is 16 KB of arithmetic.

That is not a complaint. It is the thing to know before spending another
registration: a binary is burned per (address, binary) across all intents, so
every blind attempt costs one permanently. **No unused build remains** — all
seven earlier binaries are spent across 23 registrations, so another attempt
needs a genuinely new build first, differing in bytes rather than in filename.
`authenticity2` is the eighth, built for one measured reason rather than a
guess: TEXT_AUTHENTICITY_CHECK rejected three of our attempts on the *ordering*
gate at 12-13 of 14, never on separation, and the same three fixtures were lost
across three builds. A tie is a lost pair, and contrast passes are what create
ties by saturating mid-quality answers toward 0 and 1 — so this profile drops
the third pass. On our own corpus that traded a little margin (0.4950 → 0.4782)
for a tighter spread (stddev 0.3588 → 0.3300), which is the shape of less
saturation.

**It was refused, and the bet is worth reading.** Registration 2072, 30 August:
13 of 15 — the same count as every earlier attempt — with the margin down to
0.3455 against a bar of 0.6667. Dropping a contrast pass broke none of the three
fixtures it was aimed at, so saturation was not making those ties. This scorer
simply ranks those three the wrong way round, and it is 0.32 of margin short as
well as one win. TEXT_AUTHENTICITY_CHECK needs a different reading of authorship
evidence, not another constant. Recorded here because the next person to look at
this intent should not spend a ninth binary re-testing it.

## GAME_RESULT: what the champion cannot see, and what it cost to prove

31 August 2026. `npm run survey` put `GAME_RESULT` at the lowest measured bar on
the board (0.5172), so it got looked at properly, and the first thing measured
was not a bar at all.

**Both modules are blind to who won.** Fifteen cases built from what the three
live `GAME_RESULT` miners actually return — sportwire's "X beat Y 5-1 (final)",
scorewire's home/away object, fourcast's canonical score string — and this
module and the reigning champion lost the same four. Every one was the same
shape: the right two teams, the right two figures, credited the wrong way round.
"Boston Celtics beat the New York Knicks 112-108" scores **1.0000** on the
champion against a ground truth where the Knicks won. It is not a near miss in
its reading; it cannot see the difference at all.

So `game` added attribution: the words before a result verb name the winner,
`lost to` and `fell to` reverse it, names compared word by word because a truth
says "New York Knicks" and an honest answer says "New York". `game2` added the
answer that names a winner with no verb — "Arsenal, 3-0. A clean sheet against
Chelsea" — by pairing each name with the figure after it and crediting the
largest, which reads "Boston 108, New York 112" correctly where taking the first
name does not.

On 31 cases (the fifteen live shapes plus sixteen harder ones probed afterwards
— a one-word answer, passive voice, a draw, an aggregate, a paraphrase sharing
no vocabulary, a correct answer carrying more figures than the truth):

| module | margin | wins | self-match |
|---|---|---|---|
| `amanat_scorer_game2` | **0.3617** | **24/31** | 1.0000 |
| `amanat_scorer_game` | 0.1412 | 17/31 | 1.0000 |
| `amanat_scorer` (default) | −0.0597 | 13/31 | 1.0000 |
| champion reg 1265 | −0.0490 | 15/31 | 1.0000 |

A negative margin is the number to read twice. Averaged over these shapes the
seated champion **scores wrong answers above right ones**, and so does our own
general profile — this is not a claim about their module against ours, it is
what happens to any scorer that grades a result question on vocabulary and
figures without reading the direction of the verb.

**Two registrations, both refused, and the refusals agree with each other.**

| Reg | Profile | Our margin | Bar | Wins | Verdict |
|---|---|---|---|---|---|
| 2650 | `game` | 0.6222 | 0.5573 | 14/15 | rejected — ordering |
| 2652 | `game2` | 0.6452 | 0.5573 | 14/15 | rejected — ordering |

Separation was never the problem: both cleared the bar by about a tenth, and
`game2` improved the margin without changing the win count. `historical_rows_
evaluated: 0` both times, so the agreement gate never ran.

**And then the ordering column, read against our own earlier registration on the
same intent, said something worth more than either rejection:**

| Reg | Attribution | Margin | Ordering |
|---|---|---|---|
| 1253 | no | 0.7007 | **15/15** |
| 2650 | verb rule | 0.6221 | 14/15 |
| 2652 | verb rule + scoreline | 0.6451 | 14/15 |

All three were measured over fifteen comparable cases. **The module without
attribution ordered all fifteen correctly; both modules with it lose one.** On
our own corpus attribution is worth seven ordering wins and a margin of 0.0969
to 0.3617 against the champion; on the node's it costs one.

Only two readings fit. Either the node's fifteen contain a case where crediting
the winner is the wrong call — a draw, an aggregate, a forfeit, a result stated
about a side that lost — or the rule fires on an answer that is actually right.
The loose verbs are where that would happen: `took` is a result in "took it 3-2"
and not one in "took a beating", and `won` picks the nearest name before it, so
"Boston, who won last week, lost to New York 108-112" credits Boston. Both are
reachable in ordinary sportswriting and neither is in our fifteen.

**It was a hypothesis with a cost attached, and the cost was one binary. Spent,
and it paid.** Restricting the rule to unambiguous verbs is `game3`: a relative
pronoun between a name and a verb ends the claim on that name, and `took` counts
as a result only when what follows it is `it` or a figure. On the four shapes
built to provoke exactly those two mistakes, `game2` scores **−0.4248 and 1 of
4** — it was not merely missing them, it was ranking the wrong answer higher.
`game3` scores **+0.6374 and 3 of 4**, and the fourth is a tie rather than an
inversion.

On the full corpus, now 35 cases:

| module | margin | wins |
|---|---|---|
| `amanat_scorer_game3` | **0.4175** | **28/35** |
| `amanat_scorer_game2` | 0.2719 | 25/35 |
| `amanat_scorer_verdict` (the profile reg 1253 used) | −0.0471 | 15/35 |
| champion reg 1265 | −0.0435 | 15/35 |

The lesson is the one the earlier paragraphs were circling without saying: **a
rule that reads the world correctly can still be wrong about the sentence in
front of it.** "Took" is a result in *took it 3-2* and its opposite in *took a
beating*, and nothing about knowing who won tells you which you are looking at. Sixteen further shapes were probed and none is a case the champion
wins and we lose, so a third attempt would be guessing at a fixture nobody
outside the node can see — which is the mistake registration 1112 paid for once
already. What is worth keeping is the measurement: **a mechanism can be plainly
right on every case you can construct and still cost you a case you cannot.**

## The gates, in the order they bite

1. **Structural** — no host imports, `alloc`/`dealloc`/`rank_answer` exported,
   instantiates in a bare sandbox. `npm run build:profiles` checks all of it.
2. **Self-match** — the ground truth scored against itself must clear ~0.75.
   Ours is 1.0.
3. **Wins** — must be at least the champion's on the comparable cases.
4. **Separation** — average margin must *beat* the champion's, not tie it.
   Registration 186 tied 32/32 and lost by 0.017.
5. **Rank agreement** — Spearman against the incumbent on historical traffic,
   floor ~0.60, and undocumented. It only applies when there is traffic:
   registration 1112 saw `historical_rows_evaluated: 0`, so it never ran.
   `--agreement` estimates it locally; ours measures 0.91 against reg 636.
