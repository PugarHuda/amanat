// Self-check for the agent side. One runnable file, no framework, no network.
//   node agent/test.mjs
//
// The x402 signing path moves USDC and had no test at all. An EIP-3009
// authorization is a bearer instrument: once signed, the facilitator can submit
// it and the transfer lands without asking us again. So the checks here are
// about what we are willing to put a signature on, and about proving the typed
// data is right without paying anything to find out.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { signPayment, decodeChallenge, DEFAULT_MAX_AMOUNT } from "./x402.mjs";
import { intentId, NAME_HASHED_INTENTS, readRisk, POLICY_STATUS } from "./telegraph.mjs";
import { flag, has, positionals, reject } from "./args.mjs";
import { payloadFor } from "./crosscheck.mjs";
import { rank } from "./survey.mjs";
import { split } from "./impact.mjs";
import { readPaid } from "./board.mjs";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8";

// A throwaway key: this signs test authorizations that are never submitted, and
// the account holds nothing on any chain.
const signer = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)));

const challenge = (over = {}) => ({
  x402Version: 2,
  accepts: [{
    scheme: "exact",
    network: "eip155:84532",
    asset: USDC,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...over,
  }],
});

// ── the signature is the product, so check it recovers ──────────────────────
{
  const { header, amount, payTo, asset } = await signPayment(challenge(), signer, { asset: USDC });
  assert.equal(amount, "10000");
  assert.equal(payTo, PAY_TO);
  assert.equal(asset, USDC);

  const payload = decodeChallenge(header);
  assert.equal(payload.scheme, "exact");
  assert.equal(payload.network, "eip155:84532");

  const a = payload.payload.authorization;
  assert.equal(a.from, await signer.getAddress());
  assert.equal(a.to, ethers.getAddress(PAY_TO));
  assert.equal(a.value, "10000");
  assert.match(a.nonce, /^0x[0-9a-f]{64}$/, "the nonce must be 32 fresh bytes");

  // The whole point of the domain and type list: if either is wrong the
  // facilitator recovers a different address and the payment is refused with a
  // bare 402 that looks exactly like never having paid. Recovering it here is
  // what proves it without spending a cent.
  const recovered = ethers.verifyTypedData(
    { name: "USDC", version: "2", chainId: 84532, verifyingContract: ethers.getAddress(USDC) },
    {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    {
      from: a.from, to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
    payload.payload.signature,
  );
  assert.equal(recovered, await signer.getAddress(), "the signature must recover to the payer");

  // The window has to be open now and closed later, or the facilitator cannot
  // land it.
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Number(a.validAfter) <= now, "validAfter must already have passed");
  assert.ok(Number(a.validBefore) > now + 60, "validBefore must leave time to settle");
}

// Two nonces in a row must differ, or a replay is our own doing.
{
  const one = decodeChallenge((await signPayment(challenge(), signer, { asset: USDC })).header);
  const two = decodeChallenge((await signPayment(challenge(), signer, { asset: USDC })).header);
  assert.notEqual(one.payload.authorization.nonce, two.payload.authorization.nonce);
}
console.log("x402 signature recovers to the payer");

// ── what we refuse to sign ──────────────────────────────────────────────────
// The challenge is written by the party being paid. Every one of these would
// have been signed without complaint before the ceiling and asset checks.
await assert.rejects(
  () => signPayment(challenge({ amount: "999000000" }), signer, { asset: USDC, maxAmount: DEFAULT_MAX_AMOUNT }),
  /over the .* ceiling/,
  "999 USDC must not be signed because a server asked nicely",
);
await assert.rejects(
  () => signPayment(challenge({ asset: "0x1111111111111111111111111111111111111111" }), signer, { asset: USDC }),
  /not the expected/,
  "a challenge naming a different token must be refused",
);
await assert.rejects(
  () => signPayment(challenge({ amount: "0" }), signer, { asset: USDC }),
  /not a payable amount/,
);
await assert.rejects(
  () => signPayment(challenge({ network: "eip155:1" }), signer, { asset: USDC }),
  /challenge is for chain 1/,
  "a mainnet challenge must never be signed by a testnet agent",
);
await assert.rejects(
  () => signPayment({ x402Version: 2, accepts: [{ network: "solana:xyz", amount: "10000" }] }, signer, { asset: USDC }),
  /no eip155 option/,
);
// The ceiling is inclusive at the boundary and exclusive past it.
await signPayment(challenge({ amount: "1000000" }), signer, { asset: USDC, maxAmount: 1_000_000n });
await assert.rejects(
  () => signPayment(challenge({ amount: "1000001" }), signer, { asset: USDC, maxAmount: 1_000_000n }),
  /ceiling/,
);
console.log("x402 refuses what it should refuse");

// ── reading answers whose shape is not ours to assume ───────────────────────
assert.equal(readRisk({ risk: 0.42 }), 0.42);
assert.equal(readRisk({ risk: 1 }), 1);
assert.equal(readRisk({ risk: 0 }), 0, "zero is a reading, not a missing one");
assert.equal(readRisk({}), null, "no figure means no reading, never zero");
assert.equal(readRisk(null), null);
assert.equal(readRisk({ risk: 42 }), null, "a field out of range is not a risk");
assert.equal(readRisk({ risk: "0.5" }), 0.5, "a stringified figure is still stated in the answer");
assert.equal(readRisk({ answer: "storm risk is 0.63 with 0.11 mm rain" }), 0.63, "the largest stated figure");
assert.equal(readRisk({ answer: "no numbers at all" }), null);
// A bare integer in an unrelated field is not a risk reading. Before this was
// tightened, {"precip_mm": 0} answered "risk 0" — calm, invented from nothing.
assert.equal(readRisk({ precip_mm: 0, wind_kmh: 12 }), null, "a bare 0 is not a risk");
assert.equal(readRisk({ answer: "1 storm expected" }), null, "a bare 1 is not a risk");
assert.equal(readRisk({ answer: "26.7-32.6 C, gusts 41 km/h" }), null, "temperatures are not risks");
assert.equal(readRisk({ answer: "risk 1.0, take shelter" }), 1, "a stated 1.0 is a reading");
assert.equal(readRisk({ answer: "risk .5" }), 0.5, "a leading dot is still a figure");
assert.equal(readRisk({ answer: "2026-08-26: Drizzle, 26.7-32.6 C" }), null, "a date is not a risk");
console.log("risk is read, never invented");

// ── intents ─────────────────────────────────────────────────────────────────
assert.equal(intentId("STORM_ALERT"), ethers.keccak256(ethers.toUtf8Bytes("STORM_ALERT")));
for (const name of NAME_HASHED_INTENTS) assert.match(intentId(name), /^0x[0-9a-f]{64}$/);
assert.throws(() => intentId("CRYPTO_PRICE"), /no name-derived intentId/);
assert.throws(() => intentId(""), /no name-derived intentId/);
assert.equal(POLICY_STATUS[1], "Active");
console.log("intents resolve by name only where that is safe");

// ── argument parsing, which every script trusts ─────────────────────────────
assert.equal(flag(["--speed", "37"], "--speed", 1), "37");
assert.equal(flag([], "--speed", 37), 37, "an absent flag falls back");
assert.equal(has(["--dry"], "--dry"), true);
assert.equal(has([], "--dry"), false);
// A flag's value must never be mistaken for a positional — "--policy 1" once
// parsed 1 as the first positional and acted on the wrong policy.
assert.deepEqual(positionals(["Cebu", "--speed", "37", "Manila"], ["--speed"]), ["Cebu", "Manila"]);
assert.deepEqual(positionals(["--dry", "Cebu"], []), ["Cebu"]);
assert.throws(() => reject(["--nope"], ["--dry"]), /--nope/, "an unknown flag is a typo, not an intention");
reject(["--dry"], ["--dry"]);
console.log("arguments parse the way every script assumes");

console.log("\nagent ok");

// ── building a request from what a miner says it accepts ────────────────────
// Sending {lat, lon} to everybody is the same mistake the contract avoids:
// assuming a field layout because ours happens to have it. The top-ranked
// weather miner takes a place name and nothing else, and answered "Parameter q
// is missing" until this read the catalogue instead of guessing.
{
  const at = { lat: 10.33, lon: 123.75, place: "Cebu, Central Visayas, Philippines", hours: 6 };

  assert.deepEqual(
    payloadFor({ properties: { days: {}, q: {} }, required: ["q"] }, at),
    { q: "Cebu", days: 1 },
    "a miner that wants a name gets a name",
  );
  assert.deepEqual(
    payloadFor({ properties: { latitude: {}, longitude: {}, hours: {} }, required: ["latitude", "longitude"] }, at),
    { latitude: 10.33, longitude: 123.75, hours: 6 },
    "latitude/longitude is the same concept under another name",
  );
  assert.deepEqual(
    payloadFor({ properties: { lat: {}, lon: {}, forecast_hours: {} } }, at),
    { lat: 10.33, lon: 123.75, forecast_hours: 6 },
  );

  // The bare name, not the full label. "Cebu, Central Visayas, Philippines" is
  // what our geocoder returns and what openweathermap answers "city not found"
  // to — the qualifiers that disambiguate for a person break a place lookup.
  assert.equal(payloadFor({ properties: { q: {} } }, at).q, "Cebu");

  // One name per concept. Sending both lat and latitude asks twice.
  const both = payloadFor({ properties: { lat: {}, latitude: {}, lon: {}, longitude: {} } }, at);
  assert.deepEqual(Object.keys(both).sort(), ["lat", "lon"]);

  // A miner whose required fields we cannot fill is skipped, not called with a
  // body it will reject.
  assert.deepEqual(
    payloadFor({ properties: { lat: {}, lon: {}, start: {}, end: {} }, required: ["lat", "lon", "start", "end"] }, at).missing,
    ["start", "end"],
  );

  // An empty schema is not a refusal — several miners publish one and still
  // take coordinates.
  assert.deepEqual(payloadFor({}, at), { lat: 10.33, lon: 123.75, hours: 6 });

  // Days are derived from hours, and a same-day request is still one day.
  assert.equal(payloadFor({ properties: { days: {} } }, { ...at, hours: 0 }).days, 1);
  assert.equal(payloadFor({ properties: { days: {} } }, { ...at, hours: 30 }).days, 2);
}
console.log("requests are built from what a miner declares, not from what ours has");

// ── a risk is read from the field that names it, never from a confidence ────
{
  // livecert's shape: the number is under risk_score, and a regex finds it too.
  assert.equal(readRisk({ risk_score: 0.8, verdict: "high", confidence: 1, max_wind_gust_kmh: 72.4 }), 0.8);
  // onlookout's shape: no risk field at all, a confidence of 0.9575, and a
  // canonical string carrying "c0.958". The old reading — the largest fraction
  // in the JSON — returned 0.9575 and would have paid a claim on it.
  assert.equal(readRisk({ answer: "Cebu forecast: today high 31C low 28C overcast.", confidence: 0.9575, canonical: "WEATHER_FORECAST|10.2988,123.8489|c0.958", risk_flags: ["none"] }), null);
  // A declared risk beside a higher confidence: the risk wins.
  assert.equal(readRisk({ risk_score: 0.2, confidence: 0.96 }), 0.2);
  // Ours.
  assert.equal(readRisk({ risk: 0.332, breach: false }), 0.332);
}
console.log("a risk is read from the field that names it, never from a confidence");

// ── the survey ranks by a winnable slot, not by a loud number ────────────────
{
  const champ = {
    WEAK: { eval: 0.53, registration: 636, author: "0xaaa" },
    STRONG: { eval: 0.99, registration: 453, author: "0xaaa" },
    ORPHAN: null,
  };
  const scores = { WEAK: [0.0089, 0], STRONG: [0.008, 0.001, 0] };
  const rows = rank(champ, scores);

  // Weakest incumbent first — that is the whole point of the ordering.
  assert.deepEqual(rows.map((r) => r.intent), ["WEAK", "STRONG", "ORPHAN"]);

  // An intent nobody holds sorts last. Read as eval 0 it would top the list of
  // things to attack, which is the opposite of true: nothing scores it at all.
  assert.equal(rows.at(-1).intent, "ORPHAN");

  // `best` is the live ceiling, and an intent with no scores has none — not a
  // zero, which would claim every miner tried and failed.
  assert.equal(rows[0].live.best, 0.0089);
  assert.equal(rows.at(-1).live.best, null);

  // Zeros count as scored but not as nonzero: "nobody was graded above zero" and
  // "nobody was graded" are the distinction this whole survey exists to make.
  assert.equal(rows[1].live.scored, 3);
  assert.equal(rows[1].live.nonzero, 2);
}
console.log("the survey ranks intents by how winnable the slot is");

// ── impact splits epochs by when the slot changed hands, not by number ───────
{
  const since = "2026-08-27T04:04:00Z";
  const rows = [
    { slug: "a", epoch: 286, rank: 1, score: 0.4, at: "2026-08-27T09:10:00Z" },
    { slug: "b", epoch: 286, rank: 2, score: 0.2, at: "2026-08-27T09:10:00Z" },
    { slug: "a", epoch: 285, rank: 1, score: 0.0169, at: "2026-08-27T00:47:40Z" },
  ];
  const out = split(rows, since);

  // Newest first, and the epoch scored after the handover is the only one ours.
  assert.deepEqual(out.map((e) => e.epoch), [286, 285]);
  assert.equal(out[0].ours, true);
  assert.equal(out[1].ours, false);

  // Grouped, not flattened: an epoch is one row per miner and the comparison is
  // between epochs, so losing the grouping loses the measurement.
  assert.equal(out[0].rows.length, 2);

  // An epoch scored at the instant of the handover counts as ours; the boundary
  // has to fall somewhere and "graded by the new module" is the useful side.
  assert.equal(split([{ ...rows[0], at: since }], since)[0].ours, true);

  // No handover timestamp means nothing can be claimed as ours, rather than
  // everything being claimed by an unparsed date comparing false-y.
  assert.equal(split(rows, "")[0].ours, false);
}
console.log("impact separates the epochs our module scored from the ones it did not");

// ── the board spends money per leg, so the paths that spend it are checked ──
//
// Every assertion here is about a run that already happened on the live rail:
// thirty legs answered and none readable, thirty legs that never got a call at
// all, and a board that published "paid (Telegraph Engine, verified)" over a
// run of zero. None of it costs anything to check — the two paid calls are
// injected.
{
  const fresh = (budget = 1.00) =>
    ({ calls: 0, spent: 0, routed: 0, direct: 0, budget, answered: {}, crossDomain: 0, unreadable: 0 });

  const answer = (name, result) => async () => ({ miner_name: name, result, cost_usd: 0.01 });
  const readable = { risk: 0.42, condition: "squalls" };
  const unreadable = { confidence: 0.96, summary: "no number this board acts on" };
  const never = async () => { throw new Error("direct call should not have happened"); };

  // One readable answer is one call. Nothing retries, nothing falls back.
  {
    const ledger = fresh();
    const read = readPaid(null, ledger, { engine: answer("ChainSight", readable), direct: never });
    const out = await read({ lat: 1, lon: 103, hours: 0 });
    assert.equal(out.risk, 0.42);
    assert.equal(out.miner, "ChainSight");
    assert.deepEqual([ledger.calls, ledger.routed, ledger.unreadable, ledger.direct], [1, 1, 0, 0]);
  }

  // The retry is the point: an unreadable first answer asks the Engine again
  // rather than paying our own miner, and the second one lands. Two routed
  // calls, no schema fallback — this is the case that used to cost the same
  // money and buy a direct call the network never sees.
  {
    const ledger = fresh();
    let n = 0;
    const engine = async () => (++n === 1
      ? { miner_name: "SkyWire", result: unreadable, cost_usd: 0.01 }
      : { miner_name: "ChainSight", result: readable, cost_usd: 0.01 });
    const out = await readPaid(null, ledger, { engine, direct: never })({ lat: 1, lon: 103, hours: 6 });
    assert.equal(out.risk, 0.42);
    assert.deepEqual([ledger.calls, ledger.routed, ledger.unreadable, ledger.direct], [2, 1, 1, 0]);
    // Both miners are named, including the one whose answer could not be used.
    // Recording only the readable path is what published `answered_by: {}` on a
    // run where thirty answers were bought and paid for.
    assert.deepEqual(ledger.answered, { SkyWire: 1, ChainSight: 1 });
  }

  // Two unreadable answers, then the schema miner. Three calls, and the reason
  // the fallback happened is carried into the miner label rather than lost.
  {
    const ledger = fresh();
    const direct = async () => ({ result: { risk: 0.1 }, cost_usd: 0.01 });
    const read = readPaid(null, ledger, { engine: answer("SkyWire", unreadable), direct });
    const out = await read({ lat: 1, lon: 103, hours: 6 });
    assert.equal(out.risk, 0.1);
    assert.match(out.miner, /^schema fallback \(SkyWire stated no readable risk\)$/);
    assert.deepEqual([ledger.calls, ledger.routed, ledger.unreadable, ledger.direct], [3, 0, 2, 1]);
  }

  // An Engine that throws is a routing failure, not an unreadable answer, and
  // it must not be billed: the run of 3 September logged zero calls precisely
  // because nothing came back to charge for.
  {
    const ledger = fresh();
    const engine = async () => { throw new Error("socket hang up"); };
    const direct = async () => ({ result: { risk: 0.1 }, cost_usd: 0.01 });
    const out = await readPaid(null, ledger, { engine, direct })({ lat: 1, lon: 103, hours: 0 });
    assert.match(out.miner, /routing failed: socket hang up/);
    assert.deepEqual([ledger.calls, ledger.spent, ledger.unreadable], [1, 0.01, 0]);
  }

  // The cap is checked before each call, so a budget with one call left buys
  // one call and then stops — it never discovers the overspend afterwards.
  {
    const ledger = fresh(0.01);
    const read = readPaid(null, ledger, { engine: answer("SkyWire", unreadable), direct: never });
    await assert.rejects(read({ lat: 1, lon: 103, hours: 0 }), /run budget reached/);
    assert.equal(ledger.calls, 1);
    assert.ok(ledger.spent <= ledger.budget, `spent ${ledger.spent} over budget ${ledger.budget}`);
  }
}
console.log("the board retries the Engine before paying itself, and bills only what answered");
