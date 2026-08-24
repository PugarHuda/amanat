// Self-check for the Amanat miner. One runnable file, no framework.
//   node miner/test.mjs
import assert from "node:assert/strict";
import { riskScore, summarise, forecast } from "./lib/forecast.mjs";
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

server.close();
console.log("miner ok —", body.summary);

// `hours` is measured from now, not from midnight — the bug this asserts against
// silently returned a forecast for a time already in the past.
const now = Date.now();
const at = Date.parse(body.valid_at);
assert.ok(at >= now - 3600e3, `valid_at ${body.valid_at} must not be in the past`);
assert.ok(Math.abs(at - (now + 3 * 3600e3)) <= 3600e3, `hours=3 must land ~3h ahead, got ${body.valid_at}`);
console.log("hours offset ok —", body.valid_at);
