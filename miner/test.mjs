// Self-check for the Amanat miner. One runnable file, no framework.
//   node miner/test.mjs
import assert from "node:assert/strict";
import { riskScore, summarise, forecast, hoursIn, condition } from "./lib/forecast.mjs";
import { placeCandidates, coordinatesIn } from "./lib/geocode.mjs";
import { greatCircleKm, waypoints, assessRoute } from "./lib/route.mjs";
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


// The same point asked for two ways has to read back one way.
{
  const byCoords = await fetch(`http://127.0.0.1:${port2}/forecast`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat: 14.6, lon: 120.98 }),
  });
  const byText = await fetch(`http://127.0.0.1:${port2}/forecast`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "14.6, 120.98" }),
  });
  const a = (await byCoords.json()).summary;
  const b = (await byText.json()).summary;
  assert.ok(a.includes("14.60, 120.98"), `bare coordinates: ${a}`);
  assert.ok(b.includes("14.60, 120.98"), `coordinates in text: ${b}`);
}
console.log("both routes name the point identically");

// A condition word and a daily range: the part of "what is the weather" that a
// list of scalars does not answer.
{
  const r = await fetch(`http://127.0.0.1:${port2}/forecast`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat: 10.32, lon: 123.89, hours: 6 }),
  });
  const j = await r.json();
  assert.equal(typeof j.condition, "string", "condition must be named");
  assert.ok(Number.isFinite(j.temp_min_c) && Number.isFinite(j.temp_max_c), "daily range must be present");
  assert.ok(j.temp_min_c <= j.temp_max_c, "min must not exceed max");
  assert.ok(j.summary.startsWith(j.valid_at.slice(0, 10)), `summary must lead with the day: ${j.summary}`);
  assert.ok(j.summary.includes(j.condition), "summary must name the condition");
  assert.equal(condition(95), "Thunderstorm");
  assert.equal(condition(4242), null, "an unknown code names nothing rather than guessing");
}
console.log("condition and daily range reported");

// ── routes ──────────────────────────────────────────────────────────────────
const CEBU = { lat: 10.32, lon: 123.89 };
const MANILA = { lat: 14.60, lon: 120.98 };
const ROTTERDAM = { lat: 51.92, lon: 4.48 };

// Known distances, to about a percent.
assert.ok(Math.abs(greatCircleKm(CEBU, MANILA) - 571) < 12, String(greatCircleKm(CEBU, MANILA)));
assert.ok(Math.abs(greatCircleKm(CEBU, ROTTERDAM) - 11012) < 120);
assert.equal(greatCircleKm(CEBU, CEBU), 0);

// Endpoints are included exactly, and the samples run in order.
const w = waypoints(CEBU, MANILA, { max: 4 });
assert.equal(w.length, 4);
assert.ok(Math.abs(w[0].lat - CEBU.lat) < 0.05 && Math.abs(w[3].lat - MANILA.lat) < 0.05);
assert.equal(w[0].km_from_start, 0);
for (let i = 1; i < w.length; i++) assert.ok(w[i].km_from_start > w[i - 1].km_from_start);

// The sphere is the point. A linear average puts the Cebu-Rotterdam midpoint in
// Afghanistan; the great circle puts it in the Altai, nearly 2000 km away.
const mid = waypoints(CEBU, ROTTERDAM, { max: 3 })[1];
const naive = { lat: (CEBU.lat + ROTTERDAM.lat) / 2, lon: (CEBU.lon + ROTTERDAM.lon) / 2 };
assert.ok(greatCircleKm(mid, naive) > 1000, "great circle must not be a linear average: " + JSON.stringify(mid));

// Coincident endpoints have no bearing to interpolate along.
assert.equal(waypoints(CEBU, CEBU).length, 1);
await assert.rejects(() => assessRoute({ from: CEBU, to: MANILA, speedKmh: 0, read: async () => ({}) }), RangeError);

// A leg past the forecast horizon is reported as such, never clamped to hour
// 168 and served as a reading of next Tuesday.
const far = await assessRoute({
  from: CEBU, to: ROTTERDAM, speedKmh: 37, max: 4,
  read: async ({ hours }) => { assert.ok(hours <= 168, "must not read beyond the horizon: " + hours); return { risk: 0.1 }; },
});
assert.ok(far.legs.some((l) => l.beyond_horizon), "a 297-hour route must have legs beyond the horizon");
assert.ok(far.legs.filter((l) => l.beyond_horizon).every((l) => l.risk === null));
assert.ok(far.unread > 0);

// A leg that could not be read is not a calm leg.
const broken = await assessRoute({
  from: CEBU, to: MANILA, speedKmh: 37, max: 3,
  read: async ({ hours }) => { if (hours > 0) throw new Error("upstream down"); return { risk: 0.9 }; },
});
assert.equal(broken.unread, 2);
assert.equal(broken.worst.risk, 0.9, "the worst leg is the worst READ leg");
assert.ok(broken.verdict.includes("2 of 3 legs could not be read"));

// The verdict is about the worst point, not the average: one severe hour in an
// otherwise calm crossing is the hour the cargo has to survive.
const spiky = await assessRoute({
  from: CEBU, to: MANILA, speedKmh: 37, max: 3,
  read: async ({ hours }) => ({ risk: hours === 8 ? 0.88 : 0.01 }),
});
assert.equal(spiky.breach, true, "one severe leg breaches the whole route");
assert.ok(spiky.verdict.startsWith("Severe"));

// Live, through the miner: the forecast hour moves with the cargo.
{
  const live = await fetch("http://127.0.0.1:" + port2 + "/api/route", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Cebu", to: "Manila", speed_kmh: 37, max_legs: 4 }),
  });
  assert.equal(live.status, 200);
  const lr = await live.json();
  assert.equal(lr.legs.length, 4);
  assert.equal(lr.legs[0].eta_hours, 0);
  assert.ok(lr.legs[3].eta_hours > 0, "later legs are forecast later");
  for (const leg of lr.legs) assert.equal(typeof leg.risk, "number", "every leg of a short route should read");
  assert.ok(lr.verdict.length > 20);

  for (const bad of [{}, { from: "Cebu" }, { from: "Cebu", to: "zzzqqq" }]) {
    const r = await fetch("http://127.0.0.1:" + port2 + "/api/route", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bad),
    });
    assert.equal(r.status, 400, "route must refuse " + JSON.stringify(bad));
  }
}
console.log("routes assessed leg by leg");


server.close();
