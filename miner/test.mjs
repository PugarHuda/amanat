// Self-check for the Amanat miner. One runnable file, no framework.
//   node miner/test.mjs
import assert from "node:assert/strict";
import { riskScore, summarise, forecast, hoursIn } from "./lib/forecast.mjs";
import { placeCandidates, coordinatesIn } from "./lib/geocode.mjs";
import { server } from "./server.mjs";

// risk: each driver alone can reach the ceiling, and the worst one wins.
assert.equal(riskScore({ wind_kmh: 0, gust_kmh: 0, precip_mm: 0 }), 0);
assert.equal(riskScore({ wind_kmh: 62, gust_kmh: 0, precip_mm: 0 }), 1);
assert.equal(riskScore({ wind_kmh: 0, gust_kmh: 90, precip_mm: 0 }), 1);
assert.equal(riskScore({ wind_kmh: 0, gust_kmh: 0, precip_mm: 30 }), 1);
assert.equal(riskScore({ wind_kmh: 200, gust_kmh: 300, precip_mm: 99 }), 1, "clamps at 1");
assert.ok(riskScore({ wind_kmh: 31, gust_kmh: 0, precip_mm: 0 }) === 0.5);

// summary carries the numbers a text scorer needs to see.
const s = summarise({ lat: -6.2, lon: 106.8, temp_c: 31.4, wind_kmh: 12.5, precip_mm: 0.4, gust_kmh: 22.1, risk: 0.246, valid_at: "2026-08-21T06:00Z" });
for (const needle of ["31.4", "12.5", "22.1", "0.4", "0.246", "low", "-6.20", "106.80"]) {
  assert.ok(s.includes(needle), `summary must mention ${needle}: ${s}`);
}
assert.ok(summarise({ lat: 0, lon: 0, temp_c: 0, wind_kmh: 0, precip_mm: 0, gust_kmh: 0, risk: 0.8, valid_at: "x" }).includes("severe"));

// input validation happens before any upstream call.
for (const bad of [{ lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: NaN, lon: 0 }, { lat: 0, lon: 0, hours: 999 }, { lat: 0, lon: 0, hours: 1.5 }]) {
  await assert.rejects(() => forecast(bad), RangeError, `should reject ${JSON.stringify(bad)}`);
}

// live end-to-end through the HTTP surface (Jakarta).
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const res = await fetch(`http://127.0.0.1:${port}/forecast`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ lat: -6.2, lon: 106.8, hours: 3 }),
});
assert.equal(res.status, 200);
const body = await res.json();
for (const k of ["summary", "temp_c", "wind_kmh", "gust_kmh", "precip_mm", "risk", "breach", "valid_at", "source"]) {
  assert.ok(k in body, `response missing ${k}`);
}
assert.equal(typeof body.summary, "string");
assert.equal(typeof body.breach, "boolean");
assert.ok(body.risk >= 0 && body.risk <= 1);
assert.ok(body.summary.includes(body.temp_c.toFixed(1)), "summary and fields must agree");

// a bad request is a real 4xx, so Telegraph never settles payment for it.
const bad = await fetch(`http://127.0.0.1:${port}/forecast`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat: 999, lon: 0 }),
});
assert.equal(bad.status, 400);
assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);

console.log("miner ok —", body.summary);

// `hours` is measured from now, not from midnight — the bug this asserts against
// silently returned a forecast for a time already in the past.
const now = Date.now();
const at = Date.parse(body.valid_at);
assert.ok(at >= now - 3600e3, `valid_at ${body.valid_at} must not be in the past`);
assert.ok(Math.abs(at - (now + 3 * 3600e3)) <= 3600e3, `hours=3 must land ~3h ahead, got ${body.valid_at}`);
console.log("hours offset ok —", body.valid_at);

const port2 = port;

// Absent is not zero. Number(null) is 0, and a request with no coordinates was
// answering with a confident forecast for Null Island instead of failing.
for (const missing of [{}, { lon: 10 }, { lat: 10 }, { lat: null, lon: null }, { lat: "", lon: "" }]) {
  const r = await fetch(`http://127.0.0.1:${port2}/forecast`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(missing),
  });
  assert.equal(r.status, 400, `missing coordinates must be refused: ${JSON.stringify(missing)}`);
  assert.match((await r.json()).error, /required/, "and must say which field");
}
console.log("missing coordinates refused");

// The epoch tournament asks in sentences. A miner that only takes coordinates
// answers 400 to every one of them and scores zero on the whole intent, which
// is what happened here across three intents at epoch 276.
assert.equal(hoursIn("What is the storm risk in the next six hours?"), 6);
assert.equal(hoursIn("Will it rain in 24 hours?"), 24);
assert.equal(hoursIn("Will it be hot tomorrow?"), 24);
assert.equal(hoursIn("How much rain tonight?"), 6);
assert.equal(hoursIn("What is the weather in New York City?"), 0, "no time named means now");
assert.equal(hoursIn("in 900 hours"), 168, "clamped to the forecast horizon");

// "Will Riyadh exceed…" starts a sentence, so "Will" is capitalised too and the
// naive capitalised-run reading looks up "Will Riyadh", which is nowhere.
assert.deepEqual(placeCandidates("Will Riyadh exceed 40 degrees?").slice(0, 1), ["Riyadh"]);
assert.ok(placeCandidates("Is a storm expected in Cebu Port this evening?").includes("Cebu"));
assert.deepEqual(coordinatesIn("storm risk at 10.32, 123.89 tonight"), { lat: 10.32, lon: 123.89 });
assert.equal(coordinatesIn("no numbers here"), null);
assert.equal(coordinatesIn("at 91.5, 200.1"), null, "out-of-range pairs are not coordinates");

for (const [field, question, expect] of [
  ["question", "Will Riyadh exceed 40 degrees in the next 24 hours?", /Riyadh/],
  ["q", "What is the storm risk at 10.32, 123.89 in the next six hours?", /10\.32, 123\.89/],
  ["prompt", "Is there a severe weather warning for Manila today?", /Manila/],
]) {
  const r = await fetch(`http://127.0.0.1:${port2}/forecast`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [field]: question }),
  });
  assert.equal(r.status, 200, `${field} must be answered: ${question}`);
  const j = await r.json();
  assert.match(j.summary, expect, `summary must name where it answered about: ${j.summary}`);
  assert.match(j.summary, /Storm risk is (low|elevated|severe)/);
  assert.ok(j.risk >= 0 && j.risk <= 1);
}
console.log("questions answered");

// A question naming no place is refused rather than answered about somewhere
// invented. Guessing is worse than saying no.
for (const q of ["Will it storm?", "zzzqqq", "   "]) {
  const r = await fetch(`http://127.0.0.1:${port2}/forecast`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }),
  });
  assert.equal(r.status, 400, `placeless question must be refused: ${q}`);
}
console.log("placeless questions refused");

server.close();
