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
the third pass. On our own corpus that trades a little margin (0.4950 → 0.4782)
for a tighter spread (stddev 0.3588 → 0.3300), which is the shape of less
saturation. Our corpus is not the node fixture set, so this is a reasoned bet,
not a prediction.

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
