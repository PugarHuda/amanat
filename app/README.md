# storm — a command line over the Amanat miner

A second consumer of the same live miner the contract uses, over plain HTTP.
ESM, Node 20 or newer (the repo's `engines` floor; the runs below are Node
v26.3.0), **zero dependencies** — `node:` builtins and `fetch`, nothing else.
No install, no wallet, no key.

```sh
node app/storm.mjs "Cebu"
```

Point it elsewhere with `AMANAT_MINER=http://localhost:8080`. The root
`package.json` declares `bin: { storm }`, so `npm link` puts `storm` on PATH;
the file is executable with its own shebang too (`./app/storm.mjs Cebu`).

Every command takes `--json` and prints the miner's own object, unaltered.

`--telegraph` is the exception to all of the above: it asks the *network*
rather than this miner, and the node routes the question to whichever miner it
ranks best on the intent. That costs $0.01 in Base Sepolia USDC and needs
`AGENT_PRIVATE_KEY`, so it is never the default — and the answer is often not
ours. Two consecutive calls with the same question went to TxLens and then to
LiveCert, which is what probabilistic routing looks like from outside.

```
$ node app/storm.mjs "Cebu" --telegraph
routed by Telegraph to LiveCert Operational Signals  —  $0.01  —  0x463bef69…

Regarding what is the storm risk in Cebu right now? … Wind speed: sustained
winds of 17.2 km/h … Overall risk: 0.34 on a scale of 0 to 1, graded low.
```

A bare place name is turned into a question first. Asked the literal string
"Cebu", the router sent it to a miner that answered "no location was supplied"
— the classifier needs a sentence, and paying $0.01 to find that out is the
kind of thing this flag is for.

Exit codes: **0** it answered, **1** the miner could not answer or a signature
did not verify, **2** the arguments were wrong.

All output below is pasted from a real run on 2026-08-31 against
<https://amanat-miner.vercel.app>.

---

### `storm <place|"lat,lon">` — the reading, its band, and the trigger

```
$ node app/storm.mjs "Cebu"
Cebu, Central Visayas, Philippines  —  10.33333, 123.75  —  valid 2026-08-31T03:00Z (+0h)

Cebu: the temperature in Cebu, Central Visayas, Philippines is 30.5 °C (87 °F)
and it feels like 33.5 °C, humidity 55%, Light drizzle, cloud cover 89%, wind
18.6 km/h (5.2 m/s) from the south-west, gusts 47.2 km/h, precipitation 0.1 mm
(61% chance of rain), valid at 2026-08-31T03:00Z. 2026-08-31 forecast: today
high 31C low 24C thunderstorm, 94% chance of rain; tomorrow high 31C low 23C
light drizzle, 84% chance of rain. Waves 0.5 m, sea level +1.4 m against mean.
Storm risk is elevated (0.524); across 51 ensemble runs it ranges 0.41 to
0.51, 0% of them over the trigger.

band     0.412–0.508 (p10–p90 of 51 ecmwf_ifs025 members), 0% over trigger
trigger  0.524 <  0.75 — not crossed, 0.226 to go
```

`--hours 0..168` asks for a later hour; a bare `"10.3,123.9"` skips the geocoder.

### `storm route <from> <to>` — risk along the way, at the hour you get there

```
$ node app/storm.mjs route "Cebu" "Manila" --legs 4
Cebu, Central Visayas, Philippines  ->  Manila, National Capital Region, Philippines
562 km at 37 km/h, 15 h under way

    0 km  +  0h  risk 0.524  Light drizzle
  187 km  +  5h  risk 0.156  Overcast
  375 km  + 10h  risk 0.440  Overcast
  562 km  + 15h  risk 0.556  Drizzle

worst    0.556 at hour 15 (14.6042, 120.9822)
trigger  0.556 <  0.75 — not crossed, 0.194 to go
Elevated: risk 0.556 at 14.6042, 120.9822 at hour 15. Worth covering, below
the trigger.
```

### `storm backtest <place> <start> <end>` — would the trigger have fired?

```
$ node app/storm.mjs backtest "Cebu" 2026-08-01 2026-08-14
Cebu, Central Visayas, Philippines  —  10.33333, 123.75  —  2026-08-01 to 2026-08-14 (336 h, trigger 0.75)

▂▂▂▁▂▃▃▂▂▃▄▃▃▂▄▄▄▃▃▄▅▄▃▃▅▅▄▃▄▆▅▄▃▄▅▅▄▅▅▅▅▄▃▄▅▄▄▃▅▄▃▃▃▅▅▃▃▄▄▄▃▂▄▄▄▂▂▃

peak     0.648 at 2026-08-07T04:00Z — wind 22.8 km/h, gusts 58.3 km/h, rain 0 mm
verdict  never breached — 0 h at or above the trigger, no payout
source   open-meteo archive (ERA5)
```

### `storm board` — the published lane board

```
$ node app/storm.mjs board
Storm board — published 2026-08-30T16:34:00.257Z, rail: paid (Telegraph Engine, verified), trigger 0.75

Singapore → Jakarta        worst 0.250    ok    Low: worst leg is 0.250 at -6.2146, 106.8451 at hour 24.
Cebu → Manila              worst 0.600    ok    Elevated: risk 0.600 at 14.6042, 120.9822 at hour 15. Worth covering, below the trigger.
Hong Kong → Kaohsiung      worst 0.700    ok    Elevated: risk 0.700 at 22.6163, 120.3133 at hour 17. Worth covering, below the trigger.
Surabaya → Makassar        worst 0.350    ok    Low: worst leg is 0.350 at -5.1486, 119.4319 at hour 21.
Ho Chi Minh City → Manila  worst 0.630    ok    Elevated: risk 0.630 at 14.6042, 120.9822 at hour 44. Worth covering, below the trigger.
```

### `storm verify [place]` — check the Ed25519 attestation yourself

```
$ node app/storm.mjs verify "Manila"
Manila, National Capital Region, Philippines  —  risk 0.668, breach false, valid 2026-08-31T03:00Z
key MCowBQYDK2VwAyEAJf1zypC6xONEg667cOTBayCo/E4U2V3xKhm7DKPpdKQ=

  ok    algorithm is ed25519
  ok    signed fields are the published set
  ok    public key matches /.well-known/amanat.json
  ok    canonical bytes are the answer's own fields
  ok    sha256 matches the canonical bytes
  ok    Ed25519 signature verifies
  ok    key is persistent, not per-instance

verified — this miner signed these exact numbers, and the key is the published one.
```

Two of those checks are the ones a lazy verifier skips: that the signed bytes
are *this answer's* fields, and that the key is the one published at
`/.well-known/amanat.json`. Without both, a valid signature proves nothing
about the numbers printed above it. A reading with either broken exits 1.

### When the miner cannot answer

It says so, and the exit code says so. Nothing is invented.

```
$ node app/storm.mjs "asdfqwerzz"
storm: miner 400 on /forecast: no place found in "asdfqwerzz"
$ echo $?
1
```

---

## The check

```sh
node app/test.mjs      # also runs as part of `npm test`
```

Argument parsing, the 400 / 429 / 502 / non-JSON / unreachable paths against a
stubbed `fetch`, the verifier against a keypair generated in the test (a
tampered risk, a foreign key and a forged signature must all fail), and one
real call to the live miner.

## What it proves

The miner is consumable by anything that speaks HTTP — not just our contract.
Same endpoints, no SDK, no dependency on this repo's code, and the answer it
returns can be verified by the consumer with Node's own crypto rather than
taken on trust.
