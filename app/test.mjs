// One check for the CLI: argument parsing, the failure paths against a stubbed
// fetch, the attestation verifier against a key we control, and one real call
// to the live miner so the thing is proven end to end and not only in a mock.
//
//   node app/test.mjs

import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign as edSign } from "node:crypto";
import { asPoint, run, Fail } from "./storm.mjs";

const real = globalThis.fetch;
let calls = [];

/** Answer every request from a table of [pathMatch, status, body]. */
function stub(table) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ path, method: init?.method ?? "GET", body: init?.body });
    const hit = table.find(([m]) => path.startsWith(m));
    if (!hit) throw new Error(`no stub for ${path}`);
    const [, status, body] = hit;
    if (body instanceof Error) throw body;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

async function fails(argv, code, match) {
  try {
    await run(argv);
    assert.fail(`expected ${argv.join(" ")} to fail`);
  } catch (e) {
    assert.ok(e instanceof Fail, `expected a Fail, got ${e}`);
    assert.equal(e.code, code, `${argv.join(" ")}: exit code`);
    assert.match(e.message, match);
  }
}

// ---- a signed reading, built here so the verifier is tested against real bytes

const SIGNED = ["lat", "lon", "hours", "valid_at", "temp_c", "wind_kmh", "gust_kmh",
  "precip_mm", "wave_cm", "cyclone_km", "risk", "breach"];
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");

function signedReading(over = {}) {
  const a = {
    summary: "Cebu: a reading.", place: "Cebu", lat: 10.3, lon: 123.75, hours: 0,
    valid_at: "2026-08-31T03:00Z", temp_c: 30.5, wind_kmh: 18.6, gust_kmh: 47.2,
    precip_mm: 0.1, wave_cm: 46, cyclone_km: 0, risk: 0.524, breach: false,
    risk_band: { model: "ecmwf_ifs025", members: 51, p10: 0.4, p50: 0.45, p90: 0.5, max: 0.52, breach_probability: 0 },
    ...over,
  };
  const canonical = JSON.stringify(Object.fromEntries(SIGNED.map((k) => [k, a[k] ?? null])));
  a.attestation = {
    algorithm: "ed25519", signed_fields: SIGNED, canonical,
    sha256: createHash("sha256").update(canonical).digest("hex"),
    signature: edSign(null, Buffer.from(canonical), privateKey).toString("base64"),
    public_key: pub, key_persistent: true,
  };
  return a;
}

const WELL_KNOWN = { name: "amanat-weather-risk", signing: { algorithm: "ed25519", public_key: pub, signed_fields: SIGNED } };

// ---- argument parsing -------------------------------------------------------

assert.deepEqual(asPoint("10.3, 123.9"), { lat: 10.3, lon: 123.9 });
assert.deepEqual(asPoint("-6.2,106.8"), { lat: -6.2, lon: 106.8 });
assert.equal(asPoint("Cebu"), null, "a place name is not a point");
assert.equal(asPoint("999,0"), null, "out-of-range latitude is not a point");
assert.equal(asPoint(undefined), null);

stub([["/forecast", 200, signedReading()]]);

// A bare place is the default command, and unquoted words join into one place.
let out = await run(["Cebu"]);
assert.match(out.text, /trigger {2}0\.524 < {2}0\.75 — not crossed/);
assert.match(out.text, /band {5}0\.400–0\.500/);
assert.equal(JSON.parse(calls[0].body).question, "Cebu");

await run(["Cebu", "City"]);
assert.equal(JSON.parse(calls[1].body).question, "Cebu City");

// A coordinate pair goes as lat/lon, not as a question, and --hours rides along.
await run(["10.3,123.9", "--hours", "12"]);
assert.deepEqual(JSON.parse(calls[2].body), { lat: 10.3, lon: 123.9, hours: 12 });

// --json hands back the miner's own object, unaltered.
out = await run(["Cebu", "--json"]);
assert.equal(JSON.parse(out.text).risk, 0.524);

// The trigger reads the other way above 0.75.
stub([["/forecast", 200, signedReading({ risk: 0.81, breach: true })]]);
assert.match((await run(["Cebu"])).text, /CROSSED, the payout condition is met/);

// Bad arguments exit 2, before any network call.
stub([]);
await fails([], 2, /place name or "lat,lon"/);
await fails(["--hours", "999", "Cebu"], 2, /--hours must be an integer between 0 and 168/);
await fails(["--legs", "1", "route", "a", "b"], 2, /--legs must be an integer between 2 and 12/);
await fails(["route", "Cebu"], 2, /needs a from and a to/);
await fails(["backtest", "Cebu", "2026-08-01"], 2, /needs a place, a start date and an end date/);
await fails(["backtest", "Cebu", "2026-08-01", "nonsense"], 2, /dates must be YYYY-MM-DD/);
await fails(["--nope"], 2, /nope/);
assert.equal(calls.length, 0, "argument errors must not hit the network");

assert.match((await run(["--help"])).text, /Exit 0 answered/);

// ---- failure paths ----------------------------------------------------------

// Whatever the miner says is what gets reported, never a substituted reading.
stub([["/forecast", 400, { error: 'no place found in "asdfqwerzz"' }]]);
await fails(["asdfqwerzz"], 1, /miner 400 on \/forecast: no place found in "asdfqwerzz"/);

stub([["/forecast", 429, { error: "the day's upstream quota is spent" }]]);
await fails(["Cebu"], 1, /miner 429 .*quota is spent/);

stub([["/api/board", 503, { error: "not published yet" }]]);
await fails(["board"], 1, /miner 503 on \/api\/board: not published yet/);

stub([["/forecast", 502, "<html>upstream gateway error</html>"]]);
await fails(["Cebu"], 1, /miner 502 .*upstream gateway error/);

stub([["/forecast", 200, "not json at all"]]);
await fails(["Cebu"], 1, /response was not JSON/);

stub([["/forecast", 0, new TypeError("fetch failed")]]);
await fails(["Cebu"], 1, /cannot reach .*fetch failed/);

// ---- the verifier -----------------------------------------------------------

stub([["/forecast", 200, signedReading()], ["/.well-known/amanat.json", 200, WELL_KNOWN]]);
out = await run(["verify", "Cebu"]);
assert.equal(out.code, 0);
assert.ok(!out.text.includes("FAIL"), out.text);
assert.match(out.text, /verified — this miner signed these exact numbers/);

// A reading whose printed risk is not the risk that was signed must not pass:
// the signature is still valid, the bytes just are not this answer's fields.
const tampered = signedReading();
tampered.risk = 0.99;
stub([["/forecast", 200, tampered], ["/.well-known/amanat.json", 200, WELL_KNOWN]]);
out = await run(["verify", "Cebu"]);
assert.equal(out.code, 1, "a tampered reading must exit non-zero");
assert.match(out.text, /FAIL {2}canonical bytes are the answer's own fields/);
assert.match(out.text, /NOT VERIFIED/);

// Nor may a valid signature from a key that is not the published one.
const { publicKey: other } = generateKeyPairSync("ed25519");
stub([
  ["/forecast", 200, signedReading()],
  ["/.well-known/amanat.json", 200, { signing: { public_key: other.export({ format: "der", type: "spki" }).toString("base64"), signed_fields: SIGNED } }],
]);
out = await run(["verify", "Cebu"]);
assert.equal(out.code, 1, "a foreign signing key must exit non-zero");
assert.match(out.text, /FAIL {2}public key matches/);

// A forged signature over the right bytes fails the crypto, not just the text.
const forged = signedReading();
forged.attestation.signature = Buffer.alloc(64).toString("base64");
stub([["/forecast", 200, forged], ["/.well-known/amanat.json", 200, WELL_KNOWN]]);
out = await run(["verify", "Cebu"]);
assert.equal(out.code, 1);
assert.match(out.text, /FAIL {2}Ed25519 signature verifies/);

// ---- one real call to the live miner ---------------------------------------

globalThis.fetch = real;
const live = await run(["verify", "Cebu"]);
assert.equal(live.code, 0, `live attestation did not verify:\n${live.text}`);
assert.ok(!live.text.includes("FAIL"), live.text);
assert.match(live.text, /risk 0\.\d+/);

console.log("app/test.mjs: ok");
