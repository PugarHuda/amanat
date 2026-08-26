// Ask two independent miners about the same place, and report where they part.
//
//   node --env-file=.env agent/crosscheck.mjs "Cebu"
//   node --env-file=.env agent/crosscheck.mjs "10.32, 123.89" --hours 6
//   node --env-file=.env agent/crosscheck.mjs "Manila" --dry
//
// A contract about to pay a claim on one number should know whether a second
// source agrees with it. One reading is a measurement; two readings are a
// measurement and a confidence, and the difference between them is the part
// nobody can see from inside a single answer.
//
// The two rails are deliberately different:
//
//   routed   the Engine classifies the question and picks the miner. Which one
//            is not ours to choose, and that is the point — it is the network's
//            own judgement about who is best at this.
//   second   a different miner on the same intent, called directly. Chosen as
//            the highest-ranked miner that is NOT the one the router picked, so
//            the two answers cannot come from the same place.
//
// Agreement is not proof, and this does not pretend otherwise: two miners
// wrapping the same upstream API will agree while both being wrong. What it
// catches is the case that matters for settlement — one source drifting, or
// answering about somewhere else, while the money is about to move.

import { NODE, wallet, ask, askDirect, readRisk, miners } from "./telegraph.mjs";
import { flag, has, positionals, reject } from "./args.mjs";
import { pathToFileURL } from "node:url";

const MINER = process.env.AMANAT_MINER_URL ?? "https://amanat-miner.vercel.app";
const WEATHER_INTENTS = ["STORM_ALERT", "WEATHER_FORECAST", "WEATHER_CHECK"];

/**
 * How far apart two readings may be before a claim should not settle on either.
 *
 * The contract pays at 0.75 and the band between "elevated" and "severe" is
 * 0.30 wide, so a tenth is a third of the band a decision actually turns on —
 * far enough that the two sources are describing different weather.
 */
const TOLERANCE = Number(process.env.AMANAT_CROSSCHECK_TOLERANCE ?? 0.1);

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

/** Active miners on a weather intent, best-ranked first. */
async function weatherMiners() {
  const all = await miners();
  return all
    .filter((m) => m.activation_status === "active")
    .filter((m) => (m.supported_intents ?? []).some((i) => WEATHER_INTENTS.includes(i)))
    .map((m) => {
      const scores = (m.scores ?? []).filter((s) => WEATHER_INTENTS.includes(s.intent_id));
      const best = scores.reduce((a, s) => Math.max(a, s.score ?? 0), 0);
      return {
        id: String(m.id),
        slug: m.slug,
        score: best,
        endpoints: (m.endpoints ?? []).map((e) => ({ path: e.path, method: (e.method ?? "POST").toUpperCase() })),
        schema: m.input_schema ?? {},
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Build a request body from what a miner says it accepts.
 *
 * The first version of this sent `{lat, lon, hours}` to everybody and the
 * top-ranked weather miner answered "Parameter q is missing." — it takes a
 * place name and nothing else. That was the same mistake the contract is
 * careful not to make: assuming a field layout because ours happens to have it.
 *
 * The catalogue publishes every miner's `input_schema`, so there is no need to
 * guess. Each concept is offered under the names miners actually use, and only
 * the ones a miner declares are sent. A miner whose required fields we cannot
 * fill is skipped rather than called with a body it will reject — oathcast
 * wants a start, an end and a threshold, which is a different product, not a
 * weather reading.
 */
export function payloadFor(schema, { lat, lon, place, hours }) {
  const declared = schema?.properties ?? {};
  const days = Math.max(1, Math.ceil((hours + 1) / 24));
  const short = String(place ?? "").split(",")[0].trim() || place;

  // Concept -> the names miners give it, in the order we would rather use.
  const offers = {
    latitude: [["lat", lat], ["latitude", lat]],
    longitude: [["lon", lon], ["longitude", lon]],
    // The bare name, not the full geocoded label. Our own geocoder returns
    // "Cebu, Central Visayas, Philippines", and openweathermap answers that
    // with "city not found" — the qualifiers that make a label unambiguous to
    // a person make it unfindable to a place lookup.
    place: [["q", short], ["query", short], ["location", short], ["name", short], ["question", place]],
    hours: [["hours", hours], ["forecast_hours", hours]],
    days: [["days", days], ["forecast_days", days]],
  };

  const body = {};
  for (const names of Object.values(offers)) {
    for (const [name, value] of names) {
      if (name in declared && value !== undefined && value !== null) {
        body[name] = value;
        break; // one name per concept; sending two is asking twice
      }
    }
  }

  // A schema that declares nothing is not a refusal — several miners publish an
  // empty one and still take coordinates.
  if (!Object.keys(declared).length) return { lat, lon, hours };

  const missing = (schema.required ?? []).filter((r) => !(r in body));
  return missing.length ? { missing } : body;
}

function verdict(a, b) {
  if (a === null && b === null) return { agree: null, text: "Neither source produced a reading. Nothing here is a forecast." };
  if (a === null || b === null) {
    return { agree: null, text: "Only one source answered. A single reading is a measurement without a confidence." };
  }

  const spread = Math.abs(a - b);
  const crossing = (a >= 0.75) !== (b >= 0.75);

  // Straddling the trigger is worse than any spread: one source would pay the
  // claim and the other would decline it.
  if (crossing) {
    return {
      agree: false,
      spread,
      text: `The sources straddle the payout line: ${a.toFixed(3)} and ${b.toFixed(3)}. ` +
        `One of them would settle this claim and the other would refuse it. Do not settle on either.`,
    };
  }
  if (spread > TOLERANCE) {
    return {
      agree: false,
      spread,
      text: `The sources disagree by ${spread.toFixed(3)}, past the ${TOLERANCE} tolerance. ` +
        `Both are below the line, so nothing pays either way — but one of them is describing different weather.`,
    };
  }
  return {
    agree: true,
    spread,
    text: `Both sources agree within ${spread.toFixed(3)}. ` +
      (Math.max(a, b) >= 0.75
        ? "Above the line, and two independent readings say so."
        : "Below the line, and two independent readings say so."),
  };
}

async function main() {
  reject(process.argv.slice(2), ["--dry", "--hours", "--max-spend"]);
  const [where] = positionals(process.argv.slice(2), ["--hours", "--max-spend"]);
  if (!where) throw new Error('a place is required: agent/crosscheck.mjs "Cebu"');

  const dry = has(process.argv, "--dry");
  const hours = Number(flag(process.argv, "--hours", 6));
  const maxSpend = Number(flag(process.argv, "--max-spend", 0.05));

  const at = await resolve(where);
  console.log(`\n${at.place}  (${at.lat}, ${at.lon}) at hour ${hours}\n`);

  const field = await weatherMiners();
  if (dry) {
    console.log(`${field.length} active miners serve a weather intent. Best ranked:`);
    for (const m of field.slice(0, 6)) console.log(`  ${String(m.id).padEnd(9)} ${m.slug.padEnd(26)} ${m.score.toFixed(6)}`);
    console.log(`\n--dry: nothing asked, nothing spent. A real run costs about $0.02.`);
    return;
  }

  if (maxSpend < 0.02) throw new Error(`two calls cost about $0.02, over the $${maxSpend.toFixed(2)} cap`);

  const signer = wallet();
  console.log(`node       ${NODE}`);
  console.log(`wallet     ${await signer.getAddress()}\n`);

  // Rail one: let the network choose.
  let routed = null;
  try {
    const answer = await ask(
      `What is the storm risk at latitude ${at.lat}, longitude ${at.lon} in ${hours} hours? ` +
      `Report wind speed, gusts, precipitation and an overall risk between 0 and 1.`,
      { signer },
    );
    routed = { miner: answer.miner_name, slug: answer.miner_slug, risk: readRisk(answer.result), hash: answer.signal_hash };
  } catch (e) {
    console.log(`routed     failed: ${e.message.slice(0, 110)}`);
  }

  // Rail two: the best-ranked miner that is not the one just used, so the
  // second reading cannot come from the same source as the first.
  const already = String(routed?.slug ?? "").toLowerCase();
  const candidates = field
    .filter((m) => m.slug.toLowerCase() !== already && m.endpoints.length)
    .map((m) => ({ ...m, payload: payloadFor(m.schema, { lat: at.lat, lon: at.lon, place: at.place, hours }) }));

  const askable = candidates.filter((m) => !m.payload.missing);
  for (const m of candidates.filter((c) => c.payload.missing)) {
    console.log(`skipped    ${m.slug} needs ${m.payload.missing.join(", ")} — a different product, not a reading`);
  }

  // Walk the field until a second source gives a figure this can compare, or
  // the budget runs out. Stopping at the first miner that answers is not the
  // same as getting a second reading: weatherapi replies, and its reply states
  // no risk at all. An answer in an incomparable shape is not a cross-check,
  // and treating it as one would be the invention this whole tool exists to
  // catch.
  let second = null;
  let spent = 0.01; // the routed call above
  const tried = [];

  for (const other of askable) {
    if (spent + 0.01 > maxSpend) {
      console.log(`second     stopped at the ${maxSpend.toFixed(2)} cap after ${tried.length} tried`);
      break;
    }
    try {
      // The method comes from the catalogue, not from a default. Ours is the
      // only weather miner declaring POST; everyone else is GET, and a POST to
      // a GET endpoint arrives with none of its parameters — which is exactly
      // how this asked the top-ranked miner and was told its own question was
      // missing.
      const { path, method } = other.endpoints[0];
      const answer = await askDirect(other.id, { method, endpoint: path, payload: other.payload, signer });
      spent += 0.01;
      const risk = readRisk(answer.result);
      tried.push(other.slug);

      if (risk !== null) {
        second = { miner: other.slug, risk, hash: answer.signal_hash };
        break;
      }
      console.log(`         ${other.slug} answered but stated no risk this can read`);
    } catch (e) {
      spent += 0.01;
      tried.push(other.slug);
      console.log(`         ${other.slug} refused: ${e.message.slice(0, 90)}`);
    }
  }
  if (!askable.length) console.log("second     no other active weather miner takes a request we can build");

  const show = (label, r) => {
    if (!r) return console.log(`${label.padEnd(10)} no reading`);
    console.log(
      `${label.padEnd(10)} ${String(r.miner).padEnd(28)} ` +
      `${r.risk === null ? "unreadable" : r.risk.toFixed(3).padEnd(10)} ${r.hash ? r.hash.slice(0, 12) + "…" : ""}`,
    );
  };
  show("routed", routed);
  show("second", second);

  const v = verdict(routed?.risk ?? null, second?.risk ?? null);
  console.log(`\n${v.text}`);
  // The tally is what was sent, not what was planned. A run that walked four
  // miners looking for a comparable figure spent four times what a run that
  // found one on the first try would, and reporting a constant would hide it.
  console.log(`\ntelegraph  ${tried.length + 1} calls, about $${spent.toFixed(2)}`);
  if (!second && tried.length) {
    console.log(
      `\nNo other weather miner on this network publishes a risk figure between 0 and 1.\n` +
      `${tried.length} were asked and every one answered about the weather without scoring it.\n` +
      `That is worth knowing on its own: a contract settling on a storm reading has, today,\n` +
      `exactly one source of that reading.`,
    );
  }

  // A disagreement is the finding, so it is worth an exit code a script can read.
  return v.agree === false ? 1 : 0;
}

// Only run when invoked as a program. payloadFor is the interesting part to
// test, and importing a module should never start asking the network questions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code ?? 0; })
    .catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(2); });
}
