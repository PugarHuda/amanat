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
 */
function readPaid(signer, ledger) {
  return async ({ lat, lon, hours }) => {
    if (ledger.spent + 0.01 > ledger.budget) throw new Error("run budget reached");

    const when = hours === 0 ? "right now" : `in ${hours} hours`;
    let answer = null;
    let why = null;
    try {
      answer = await ask(
        `What is the storm risk at latitude ${lat}, longitude ${lon} ${when}? ` +
        `Report wind speed, gusts, precipitation and an overall risk between 0 and 1.`,
        { signer },
      );
      ledger.calls++;
      ledger.spent += Number(answer.cost_usd ?? 0.01);

      const risk = readRisk(answer.result);
      if (risk !== null) {
        ledger.routed++;
        return { ...answer.result, risk, signal_hash: answer.signal_hash, miner: answer.miner_name };
      }
      why = `${answer.miner_name} stated no readable risk`;
    } catch (e) {
      if (e.message === "run budget reached") throw e;
      why = `routing failed: ${e.message.slice(0, 80)}`;
    }

    if (ledger.spent + 0.01 > ledger.budget) throw new Error("run budget reached");
    const fallback = await askDirect(SCHEMA_MINER, { endpoint: "/forecast", payload: { lat, lon, hours }, signer });
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

async function main() {
  reject(process.argv.slice(2), ["--dry", "--budget", "--legs"]);
  const dry = has(process.argv, "--dry");
  const legs = Number(flag(process.argv, "--legs", 3));
  const budget = Number(flag(process.argv, "--budget", 0.35));

  const signer = dry ? null : wallet();
  const ledger = { calls: 0, spent: 0, routed: 0, direct: 0, budget };

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
        })),
      });
      const worst = route.worst ? route.worst.risk.toFixed(3) : "unread";
      console.log(`  ${lane.name.padEnd(28)} ${route.distance_km} km  worst ${worst}${route.unread ? `  (${route.unread} legs unread)` : ""}`);
    } catch (e) {
      // One lane failing must not cost the board the others, and a lane that
      // was not read is published as unread rather than quietly dropped.
      lanes.push({ name: lane.name, from: lane.from, to: lane.to, error: e.message, legs: [], worst: null, breach: false });
      console.log(`  ${lane.name.padEnd(28)} could not be read — ${e.message}`);
    }
  }

  const board = {
    generated_at: new Date().toISOString(),
    rail: dry ? "free (miner HTTP, unverified)" : "paid (Telegraph Engine, verified)",
    trigger: 0.75,
    lanes,
    telegraph: dry ? null : { calls: ledger.calls, spent_usd: Number(ledger.spent.toFixed(4)), routed: ledger.routed, schema_fallback: ledger.direct },
  };

  await writeFile(OUT, JSON.stringify(board, null, 2) + "\n");
  console.log(`\nwrote      board.json — ${lanes.filter((l) => l.worst).length} of ${lanes.length} lanes read`);
  if (!dry) {
    console.log(`telegraph  ${ledger.calls} calls, $${ledger.spent.toFixed(2)} — ${ledger.routed} routed, ${ledger.direct} schema fallback`);
  }
}

main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
