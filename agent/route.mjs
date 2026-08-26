// Storm risk along a route, asked of the Telegraph network leg by leg.
//
//   node --env-file=.env agent/route.mjs "Cebu" "Manila" --dry
//   node --env-file=.env agent/route.mjs "Cebu" "Manila" --speed 37 --legs 6
//   node --env-file=.env agent/route.mjs "10.32,123.89" "Rotterdam" --legs 10
//
// This is the Track 3 rail: a shipper asks one question and the network is
// asked several, because a route genuinely has several places and several
// hours in it. Every leg is a real paid call carrying its own signal hash, so
// the volume is a by-product of doing the work rather than the point of it.
//
// --dry runs the identical assessment against the miner's own HTTP endpoint,
// which costs nothing and settles nothing. Use it to see the shape of an answer
// before paying for one.

import { NODE, wallet, ask, askDirect, readRisk } from "./telegraph.mjs";
import { assessRoute } from "../miner/lib/route.mjs";
import { flag, has, positionals, reject } from "./args.mjs";

const MINER = process.env.AMANAT_MINER_URL ?? "https://amanat-miner.vercel.app";
const SCHEMA_MINER = process.env.AMANAT_SCHEMA_MINER ?? "20260821";

/** Resolve one end of the route through the miner's own geocoding. */
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

/** The free rail: the miner's HTTP endpoint, unpaid and unverified. */
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
 * The paid rail: ask the network, and let it pick the miner.
 *
 * Routing is what the protocol is for, so each leg goes through the Engine
 * rather than to a miner we choose. When the routed answer states no figure
 * this can settle on, the leg falls back to a miner that publishes an
 * output_schema — the same discipline agent/run.mjs uses, for the same reason:
 * a cent already spent on an unreadable answer buys nothing.
 */
function readPaid(signer, ledger) {
  return async ({ lat, lon, hours }) => {
    // "in 0 hours" is bad English and worse as a parameter: the Engine turns
    // the sentence into upstream query params, and at least one miner on this
    // intent rejects forecast_hours=0 outright. The departure leg is asking
    // about now, so ask about now.
    const when = hours === 0 ? "right now" : `in ${hours} hours`;
    const question =
      `What is the storm risk at latitude ${lat}, longitude ${lon} ${when}? ` +
      `Report wind speed, gusts, precipitation and an overall risk between 0 and 1.`;

    let answer = null;
    let why = null;
    try {
      answer = await ask(question, { signer });
      ledger.calls++;
      ledger.spent += Number(answer.cost_usd ?? 0.01);

      const risk = readRisk(answer.result);
      if (risk !== null) {
        ledger.rails.routed++;
        return { ...answer.result, risk, signal_hash: answer.signal_hash, miner: answer.miner_name };
      }
      why = `${answer.miner_name} stated no readable risk`;
    } catch (e) {
      // The routed miner refused the call — its own input constraints, not
      // ours. One miner's limits must not cost us the leg.
      why = `routing failed: ${e.message.slice(0, 90)}`;
    }

    const fallback = await askDirect(SCHEMA_MINER, {
      endpoint: "/forecast",
      payload: { lat, lon, hours },
      signer,
    });
    ledger.calls++;
    ledger.spent += Number(fallback.cost_usd ?? 0.01);
    ledger.rails.direct++;
    return {
      ...fallback.result,
      risk: readRisk(fallback.result),
      signal_hash: fallback.signal_hash,
      miner: `schema fallback (${why})`,
    };
  };
}

async function main() {
  reject(process.argv.slice(2), ["--dry", "--speed", "--legs", "--max-spend"]);
  const [from, to] = positionals(process.argv.slice(2), ["--speed", "--legs", "--max-spend"]);
  if (!from || !to) throw new Error('two places are required: agent/route.mjs "Cebu" "Manila"');

  const dry = has(process.argv, "--dry");
  const speedKmh = Number(flag(process.argv, "--speed", 37));
  const legs = Number(flag(process.argv, "--legs", 6));
  const maxSpend = Number(flag(process.argv, "--max-spend", 0.25));

  const a = await resolve(from);
  const b = await resolve(to);

  const ledger = { calls: 0, spent: 0, rails: { routed: 0, direct: 0 } };
  const signer = dry ? null : wallet();

  // A route is priced before it is bought. Two calls per leg is the worst case
  // — one routed, one fallback — and a cap that only triggers halfway through
  // leaves you with half a route and no refund.
  if (!dry) {
    const worstCase = legs * 2 * 0.01;
    console.log(`node       ${NODE}`);
    console.log(`wallet     ${await signer.getAddress()}`);
    console.log(`budget     $${maxSpend.toFixed(2)}, worst case for ${legs} legs is $${worstCase.toFixed(2)}`);
    if (worstCase > maxSpend) {
      throw new Error(
        `${legs} legs could cost $${worstCase.toFixed(2)}, over the $${maxSpend.toFixed(2)} cap — ` +
        `raise it with --max-spend or ask for fewer legs`,
      );
    }
  }

  console.log(`\n${a.place}  →  ${b.place}`);
  console.log(dry ? "rail       free (miner HTTP, unverified, costs nothing)" : "rail       paid (Telegraph Engine, verified)");

  const route = await assessRoute({
    from: a, to: b, speedKmh, max: legs,
    read: dry ? readFree : readPaid(signer, ledger),
  });

  console.log(`distance   ${route.distance_km} km at ${route.speed_kmh} km/h — ${route.duration_hours} h underway\n`);
  for (const leg of route.legs) {
    const risk = leg.risk === null ? (leg.beyond_horizon ? "beyond horizon" : "unread") : leg.risk.toFixed(3);
    console.log(
      `  km ${String(leg.km_from_start).padStart(5)}  h+${String(leg.eta_hours).padStart(3)}  ` +
      `${String(leg.lat).padStart(8)},${String(leg.lon).padEnd(9)} risk ${risk.padEnd(14)} ` +
      `${leg.condition ?? ""}${leg.signal_hash ? "  " + leg.signal_hash.slice(0, 12) + "…" : ""}`,
    );
    if (leg.error) console.log(`         ${leg.error}`);
  }

  console.log(`\n${route.verdict}`);
  if (!dry) {
    console.log(
      `\ntelegraph  ${ledger.calls} calls, $${ledger.spent.toFixed(2)} — ` +
      `${ledger.rails.routed} answered by the routed miner, ${ledger.rails.direct} needed the schema fallback`,
    );
  }
}

main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
