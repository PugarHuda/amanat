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
