// The storm board: real shipping lanes, screened through Telegraph on a
// schedule, published as one JSON file.
//
//   node --env-file=.env agent/board.mjs --dry     free rail, spends nothing
//   node --env-file=.env agent/board.mjs           paid rail, writes board.json
//   node --env-file=.env agent/board.mjs --budget 0.60 --legs 4
//
// Why this exists as an agent rather than a page: a board that only reads when
// somebody loads it is a board nobody can rely on, and a page that pays per
// visitor is a page that can be drained. Screening on a schedule makes the cost
// predictable, the data current, and the reading free to whoever needs it.
//
// The calls are real work. A lane cannot be reported without asking about the
// places on it at the hours a vessel reaches them, and that is one paid call
// per leg. Nothing here asks a question it does not publish the answer to.

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { NODE, wallet, provider, usdc, ask, askDirect, readRisk } from "./telegraph.mjs";
import { assessRoute } from "../miner/lib/route.mjs";
import { flag, has, reject } from "./args.mjs";

const MINER = process.env.AMANAT_MINER_URL ?? "https://amanat-miner.vercel.app";
const SCHEMA_MINER = process.env.AMANAT_SCHEMA_MINER ?? "20260821";
const OUT = new URL("../board.json", import.meta.url);

/**
 * Lanes worth watching: Southeast and East Asian sea routes that cross the
 * typhoon belt, where a storm is an operational decision rather than a
 * curiosity. Speeds are what the traffic on them actually does — 37 km/h is
 * about 20 knots, a loaded container ship.
 */
const LANES = [
  { name: "Singapore → Jakarta", from: "Singapore", to: "Jakarta", speed: 37 },
  { name: "Cebu → Manila", from: "Cebu", to: "Manila", speed: 37 },
  { name: "Hong Kong → Kaohsiung", from: "Hong Kong", to: "Kaohsiung", speed: 37 },
  { name: "Surabaya → Makassar", from: "Surabaya", to: "Makassar", speed: 37 },
  { name: "Ho Chi Minh City → Manila", from: "Ho Chi Minh City", to: "Manila", speed: 37 },
  // The Luzon Strait is where a Pacific typhoon arrives, and the Bashi Channel
  // is the gap every northbound box ship takes through it.
  { name: "Manila → Kaohsiung", from: "Manila", to: "Kaohsiung", speed: 37 },
  // The recurve. A storm that misses the Philippines turns here.
  { name: "Shanghai → Busan", from: "Shanghai", to: "Busan", speed: 37 },
  // Malacca, at strait speed rather than open-sea speed — the traffic
  // separation scheme is the constraint, not the engine. About 15 knots.
  { name: "Port Klang → Singapore", from: "Port Klang", to: "Singapore", speed: 28 },
  { name: "Da Nang → Hong Kong", from: "Da Nang", to: "Hong Kong", speed: 37 },
  // Ryukyu, the lane a typhoon crosses on its way to the East China Sea.
  { name: "Naha → Kaohsiung", from: "Naha", to: "Kaohsiung", speed: 37 },
];

async function resolve(spec) {
  const res = await fetch(`${MINER}/forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: spec }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${spec}: ${body.error}`);
  return { lat: body.lat, lon: body.lon, place: body.place ?? spec };
}

const readFree = async ({ lat, lon, hours }) => {
  const res = await fetch(`${MINER}/forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lon, hours }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body;
};

/**
 * Ask the network, and stop asking when the budget is gone.
 *
 * The cap is checked before each call rather than after, because a run that
 * notices it overspent has already overspent. A lane cut short is reported as
 * cut short — the board says how much it could not see.
 *
 * `engine` and `direct` are the two paid calls, injectable so the retry and the
 * spend accounting can be checked without buying thirty answers to find out.
 */
export function readPaid(signer, ledger, { engine = ask, direct = askDirect } = {}) {
  /**
   * One paid attempt at the Engine. Returns either a reading or the reason it
   * could not be used; the only thing it throws for is the budget.
   */
  const askEngine = async ({ lat, lon, when }) => {
    if (ledger.spent + 0.01 > ledger.budget) throw new Error("run budget reached");

    let answer;
    try {
      answer = await engine(
        `What is the storm risk at latitude ${lat}, longitude ${lon} ${when}? ` +
        `Report wind speed, gusts, precipitation and an overall risk between 0 and 1.`,
        { signer },
      );
    } catch (e) {
      return { why: `routing failed: ${e.message.slice(0, 80)}` };
    }
    ledger.calls++;
    ledger.spent += Number(answer.cost_usd ?? 0.01);

    // Who answered is recorded whether or not the answer could be read. It used
    // to be recorded only on the readable path, and that is why a run where all
    // thirty legs were answered and none could be read published `answered_by`
    // as empty — discarding the one fact that says which miner took the money.
    const who = answer.miner_name ?? answer.miner_slug ?? "unnamed";
    ledger.answered[who] = (ledger.answered[who] ?? 0) + 1;

    const risk = readRisk(answer.result);
    if (risk !== null) {
      ledger.routed++;
      return { reading: { ...answer.result, risk, signal_hash: answer.signal_hash, miner: who } };
    }
    // Routed, answered, paid for — and the answer states no risk this board
    // can act on. That is not a routing failure and recording it as one made
    // `routed: 0` on a run where all thirty legs routed perfectly.
    //
    // It is usually not the miner's fault either. SkyWire publishes a field
    // called `risk` whose own schema calls it "confidence in the assessment",
    // and declares `confidence_field: risk` in its signal mapping. readRisk
    // refuses it on purpose: reading a confidence as a risk is what makes a
    // contract pay a claim that was never reported.
    ledger.unreadable++;
    return { why: `${who} stated no readable risk` };
  };

  return async ({ lat, lon, hours }) => {
    const when = hours === 0 ? "right now" : `in ${hours} hours`;

    // Two attempts at the Engine before paying our own miner, because routing
    // is probabilistic and the spread is not subtle: one run sent all thirty
    // legs to ChainSight and every answer read, the next sent them somewhere
    // the risk could not be read at all. A second ask costs exactly what the
    // fallback below costs, and unlike the fallback it is a routed call — the
    // network sees it, and it is not this board paying itself.
    let why;
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await askEngine({ lat, lon, when });
      if (out.reading) return out.reading;
      why = out.why;
    }

    if (ledger.spent + 0.01 > ledger.budget) throw new Error("run budget reached");
    const fallback = await direct(SCHEMA_MINER, { endpoint: "/forecast", payload: { lat, lon, hours }, signer });
    ledger.calls++;
    ledger.spent += Number(fallback.cost_usd ?? 0.01);
    ledger.direct++;
    return {
      ...fallback.result,
      risk: readRisk(fallback.result),
      signal_hash: fallback.signal_hash,
      miner: `schema fallback (${why})`,
    };
  };
}

/**
 * The other half of a lane's risk: what the news says, asked once a run.
 *
 * A storm is not the only thing that shuts a shipping lane. A strike, a port
 * closure, a blockade or a grounded ship stops traffic just as hard, and none
 * of it appears in a forecast.
 *
 * The first version of this asked per lane and named the port. Every one of
 * those was routed to a *weather* miner and answered with a forecast — three
 * paid calls a run buying back the number the board already had. Two calls
 * found out why:
 *
 *   "…disruption affecting Manila, Philippines?"        -> LiveCert, a forecast
 *   "…reported in the news over the last 48 hours?"      -> Tavily, search results
 *
 * A place name that can be geocoded outweighs everything else in the sentence
 * when the Engine classifies it. A region does not: naming Southeast Asia and
 * East Asia still routes to search. So the question is regional and asked once,
 * which is a third of the cost and the only version that actually reaches
 * another domain.
 *
 * Still gated on a lane being elevated. If every lane is calm there is nothing
 * to decide, and a board that asks regardless is collecting signals rather than
 * combining them.
 */
const DISRUPTION_FLOOR = 0.5;

async function regionalDisruption(signer, ledger) {
  if (ledger.spent + 0.01 > ledger.budget) return { skipped: "run budget reached" };
  try {
    const answer = await ask(
      "What port closures, dock strikes or shipping blockades were reported in the news " +
      "across Southeast Asia and East Asia over the last 48 hours?",
      { signer },
    );
    ledger.calls++;
    ledger.spent += Number(answer.cost_usd ?? 0.01);
    const who = answer.miner_name ?? answer.miner_slug ?? "unnamed";
    ledger.answered[who] = (ledger.answered[who] ?? 0) + 1;
    ledger.crossDomain++;

    const r = answer.result;
    const said = typeof r === "string" ? r : (r?.summary ?? r?.answer ?? r?.reason ?? JSON.stringify(r));
    return {
      question: "shipping disruption reported across SE and E Asia, last 48h",
      miner: who,
      signal_hash: answer.signal_hash ?? null,
      // Trimmed, never interpreted. The board settles on the weather number and
      // prints the second opinion beside it; deciding what a news answer means
      // for a lane is the reader's job, not this script's.
      reported: String(said ?? "").slice(0, 800),
    };
  } catch (e) {
    return { error: e.message.slice(0, 140) };
  }
}

async function main() {
  reject(process.argv.slice(2), ["--dry", "--budget", "--legs"]);
  const dry = has(process.argv, "--dry");
  const legs = Number(flag(process.argv, "--legs", 3));
  // Ten lanes at three legs is 30 calls, $0.30 — what a run costs when the
  // first ask reads. A leg the Engine answers unusably asks once more and then
  // pays the schema miner, so its worst case is three calls; thirty of those
  // plus the cross-domain question is $0.91. $1.00 covers the worst run
  // outright rather than cutting it short at the twenty-third leg.
  const budget = Number(flag(process.argv, "--budget", 1.00));

  const signer = dry ? null : wallet();
  // `answered` tallies which miner the node actually chose, per routed call.
  // The board was already paying for that answer and throwing the name away —
  // and it is the most interesting thing a routed call produces. Over a week of
  // runs it is a record of how probabilistic routing behaves on this network,
  // which nothing else here or anywhere else publishes.
  //
  // It also settles a fair question about this board: whether screening lanes
  // through the Engine is real demand or a loop paying itself. The tally says
  // who answered, and most of the time it is not us.
  const ledger = { calls: 0, spent: 0, routed: 0, direct: 0, budget, answered: {}, crossDomain: 0, unreadable: 0 };

  if (!dry) {
    const address = await signer.getAddress();
    const balance = await usdc(provider()).balanceOf(address);
    console.log(`node       ${NODE}`);
    console.log(`wallet     ${address}  ${(Number(balance) / 1e6).toFixed(2)} USDC`);
    console.log(`budget     $${budget.toFixed(2)} this run, ${LANES.length} lanes × ${legs} legs`);

    // A run that cannot finish should not start and leave a half-written board.
    if (balance < BigInt(Math.ceil(budget * 1e6))) {
      throw new Error(`wallet holds less than the $${budget.toFixed(2)} this run needs — top it up or lower --budget`);
    }
  }

  const read = dry ? readFree : readPaid(signer, ledger);
  const lanes = [];
  // Distinct reasons legs went unread this run, with counts. Thirty identical
  // failures are one line, not thirty, and the run summary is where a person
  // actually looks.
  const unreadReasons = {};

  for (const lane of LANES) {
    try {
      const [a, b] = await Promise.all([resolve(lane.from), resolve(lane.to)]);
      const route = await assessRoute({ from: a, to: b, speedKmh: lane.speed, max: legs, read });
      lanes.push({
        name: lane.name,
        from: a.place, to: b.place,
        distance_km: route.distance_km,
        duration_hours: route.duration_hours,
        worst: route.worst ? { risk: route.worst.risk, eta_hours: route.worst.eta_hours, lat: route.worst.lat, lon: route.worst.lon } : null,
        breach: route.breach,
        verdict: route.verdict,
        unread: route.unread,
        legs: route.legs.map((l) => ({
          km_from_start: l.km_from_start, eta_hours: l.eta_hours,
          lat: l.lat, lon: l.lon, risk: l.risk ?? null,
          condition: l.condition ?? null, signal_hash: l.signal_hash ?? null,
          // Who the node routed this leg to. Null on the free rail, where
          // nothing was routed and nobody was paid.
          miner: l.miner ?? null,
          // Why a leg has no risk. assessRoute has always recorded this and
          // this map has always dropped it, which is how thirty legs failed
          // every six hours for two days saying only "unread".
          error: l.error ?? null,
        })),
      });
      for (const l of route.legs) {
        if (l.error) unreadReasons[l.error] = (unreadReasons[l.error] ?? 0) + 1;
      }
      const worst = route.worst ? route.worst.risk.toFixed(3) : "unread";
      console.log(`  ${lane.name.padEnd(28)} ${route.distance_km} km  worst ${worst}${route.unread ? `  (${route.unread} legs unread)` : ""}`);
    } catch (e) {
      // One lane failing must not cost the board the others, and a lane that
      // was not read is published as unread rather than quietly dropped.
      lanes.push({ name: lane.name, from: lane.from, to: lane.to, error: e.message, legs: [], worst: null, breach: false });
      console.log(`  ${lane.name.padEnd(28)} could not be read — ${e.message}`);
    }
  }

  // A second intent, once, when any lane is elevated enough for it to matter.
  let disruption = null;
  if (!dry) {
    const elevated = lanes.filter((l) => l.worst && l.worst.risk >= DISRUPTION_FLOOR);
    if (elevated.length) {
      console.log(`\ncross-domain  ${elevated.length} lane(s) at or above ${DISRUPTION_FLOOR} — asking the news rail once`);
      disruption = await regionalDisruption(signer, ledger);
      console.log(`  ${disruption.error ? `could not ask — ${disruption.error}` : disruption.skipped ?? `via ${disruption.miner}`}`);
    }
  }

  const board = {
    generated_at: new Date().toISOString(),
    // A run that paid for nothing must not claim a verified paid rail. The
    // board published `paid (Telegraph Engine, verified)` on a run of zero
    // calls, which is the one thing a board like this cannot say.
    rail: dry ? "free (miner HTTP, unverified)"
      : ledger.calls ? "paid (Telegraph Engine, verified)"
      : "unpaid — every call failed this run",
    trigger: 0.75,
    lanes,
    disruption,
    telegraph: dry ? null : {
      calls: ledger.calls,
      spent_usd: Number(ledger.spent.toFixed(4)),
      routed: ledger.routed,
      // Routed and paid for, but the answer named no risk in a form this board
      // will act on. Counted apart from `routed` so a run of thirty successful
      // routes does not read as zero, and apart from a real routing failure so
      // the two are not confused.
      routed_unreadable: ledger.unreadable,
      schema_fallback: ledger.direct,
      cross_domain_calls: ledger.crossDomain,
      // Miner name -> routed calls it answered this run, most first. Counts
      // every answer the node returned, readable or not.
      answered_by: Object.fromEntries(
        Object.entries(ledger.answered).sort((a, b) => b[1] - a[1]),
      ),
      // Reason -> legs that failed for it. Empty on a clean run.
      unread_reasons: unreadReasons,
    },
  };

  await writeFile(OUT, JSON.stringify(board, null, 2) + "\n");
  console.log(`\nwrote      board.json — ${lanes.filter((l) => l.worst).length} of ${lanes.length} lanes read`);
  if (!dry) {
    console.log(
      `telegraph  ${ledger.calls} calls, $${ledger.spent.toFixed(2)} — ${ledger.routed} routed, ` +
      `${ledger.unreadable} routed but unreadable, ${ledger.direct} schema fallback`,
    );
    const answered = Object.entries(ledger.answered).sort((a, b) => b[1] - a[1]);
    if (answered.length) {
      console.log(`routed to  ${answered.map(([who, n]) => `${who} ${n}`).join(", ")}`);
    }
    for (const [reason, n] of Object.entries(unreadReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`unread     ${String(n).padStart(3)} legs — ${reason}`);
    }
  }
}

// Importing this module must never start screening lanes: every leg of a run
// is a paid call, so an accidental import would spend real USDC.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
}
