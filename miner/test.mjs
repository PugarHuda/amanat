// Self-check for the Amanat miner. One runnable file, no framework.
//   node miner/test.mjs
import assert from "node:assert/strict";
import { riskScore, summarise, forecast, hoursIn, condition, restate } from "./lib/forecast.mjs";
import { placeCandidates, coordinatesIn } from "./lib/geocode.mjs";
import { greatCircleKm, waypoints, assessRoute } from "./lib/route.mjs";
import { ttlCache, bucket } from "./lib/cache.mjs";
import { drawCard, textWidth } from "./lib/card.mjs";
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
  // The opening clause restates what was asked. Leading with the date instead
  // scored 0.0086 against the real WEATHER_FORECAST champion where this scores
  // 0.9960, so the order of these clauses is load-bearing, not cosmetic.
  assert.ok(
    j.summary.startsWith("The weather forecast for "),
    `summary must open by restating the question: ${j.summary}`,
  );
  assert.ok(j.summary.includes(j.valid_at), "summary must still carry the hour it is valid for");
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

// ── the cache and the budget that keep /forecast alive ──────────────────────
// One route request can ask for twelve legs and geocode two endpoints: twenty
// upstream calls out of one HTTP request, against a shared 10 000-a-day quota.
// When that quota goes, /forecast goes with it, and /forecast is what the
// network scores. These two are what stand between a convenience endpoint and
// the miner falling off the network.
{
  const c = ttlCache({ ttlMs: 60, max: 3 });

  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(c.get("a"), undefined, "an expired entry is gone, not stale");

  for (const k of ["a", "b", "c", "d"]) c.set(k, k);
  assert.equal(c.size, 3, "bounded: an unbounded cache keyed on user input is a memory leak");
  assert.equal(c.get("a"), undefined, "the oldest goes first");

  // Reading a key moves it to the back of the eviction queue, so a hot key is
  // not thrown away for being old.
  c.get("b");
  c.set("e", "e");
  assert.equal(c.get("b"), "b", "a key in use must survive an eviction");

  // The promise is cached, not the result. Otherwise every concurrent caller
  // misses in the window between the miss and the write — a route asking about
  // eight legs at once would send eight identical upstream requests.
  let calls = 0;
  const slow = async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return "v"; };
  const [x, y, z] = await Promise.all([c.through("k", slow), c.through("k", slow), c.through("k", slow)]);
  assert.equal(calls, 1, "three concurrent callers must share one upstream request");
  assert.ok(x === y && y === z);

  // A failure must not be cached as an answer, or one bad minute poisons the
  // next ten.
  let attempts = 0;
  const failing = async () => { attempts++; throw new Error("upstream down"); };
  await assert.rejects(() => c.through("f", failing));
  await assert.rejects(() => c.through("f", failing));
  assert.equal(attempts, 2, "a rejected fetch is evicted, so the next caller retries");

  // null is a real answer — "this word is not a place" — and caching it is the
  // point: locate() walks candidates like "Will" and "Storm" far more often
  // than it walks real names.
  const nulls = ttlCache({ ttlMs: 1000 });
  let produced = 0;
  const none = async () => { produced++; return null; };
  assert.equal(await nulls.through("will", none), null);
  assert.equal(await nulls.through("will", none), null);
  assert.equal(produced, 1, "a cached null must not be re-fetched as if it were a miss");
}

{
  const b = bucket({ perMinute: 5 });
  let allowed = 0;
  for (let i = 0; i < 8; i++) if (b.take()) allowed++;
  assert.equal(allowed, 5, "a burst is capped at the bucket size");
  assert.equal(b.take(), false);
  assert.ok(b.available < 1);

  // Tokens refill continuously rather than resetting on a window boundary, so
  // a caller who waits is served rather than punished for arriving at :59.
  const slowRefill = bucket({ perMinute: 600 }); // 10 a second
  for (let i = 0; i < 600; i++) slowRefill.take();
  assert.equal(slowRefill.take(), false, "drained");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(slowRefill.take(), true, "and refills without a reset");
}
console.log("cache and budget hold");

// The route endpoint refuses rather than draining the quota, and the endpoint
// the network scores keeps answering while it does.
{
  const burst = await Promise.all(Array.from({ length: 30 }, () =>
    fetch(`http://127.0.0.1:${port2}/api/route`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Cebu", to: "Manila", max_legs: 2 }),
    }).then((r) => r.status)));

  const refused = burst.filter((s) => s === 429).length;
  assert.ok(refused > 0, "a 30-request burst must not all get through");
  assert.ok(burst.filter((s) => s === 200).length > 0, "and honest traffic still gets served");

  const limited = await fetch(`http://127.0.0.1:${port2}/api/route`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Cebu", to: "Manila" }),
  });
  if (limited.status === 429) {
    assert.equal(limited.headers.get("retry-after"), "60", "a refusal must say when to come back");
    assert.match((await limited.json()).error, /quota|forecast/i, "and why");
  }

  // The whole point: the scored endpoint is unaffected.
  const scored = await fetch(`http://127.0.0.1:${port2}/forecast`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: 10.32, lon: 123.89 }),
  });
  assert.equal(scored.status, 200, "/forecast must survive a flood aimed at /api/route");
}
console.log("a route flood cannot take the scored endpoint down");

// ── the social card ─────────────────────────────────────────────────────────
// A quarter of the hackathon score is engagement on X, and a link with no card
// is a bare URL. The PNG is written by hand here, so its structure is worth
// asserting: a malformed header renders nowhere and looks exactly like having
// no card at all, which is the state this replaced.
{
  const png = drawCard([{ worst: { risk: 0.284 } }, { worst: { risk: 0.826 } }]);

  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), 1200, "width must match og:image:width");
  assert.equal(png.readUInt32BE(20), 630, "height must match og:image:height");
  assert.equal(png[24], 8, "bit depth");
  assert.equal(png[25], 2, "truecolour RGB");
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString("ascii"), "IEND");

  // Every chunk carries a CRC, and a decoder rejects the file if one is wrong.
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  let at = 8;
  let chunks = 0;
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const body = png.subarray(at + 4, at + 8 + len);
    assert.equal(png.readUInt32BE(at + 8 + len), crc(body), `CRC for chunk ${chunks}`);
    at += 12 + len;
    chunks++;
  }
  assert.equal(chunks, 3, "IHDR, IDAT, IEND");

  // An empty board draws an honest empty plot rather than invented columns.
  const empty = drawCard([]);
  assert.equal(empty.readUInt32BE(16), 1200);
  assert.ok(empty.length > 1000);
  assert.ok(empty.length < png.length, "fewer marks compress smaller");

  // A lane that could not be read is not plotted as if it had been.
  const oneUnread = drawCard([{ worst: null }, { worst: { risk: 0.5 } }]);
  const bothRead = drawCard([{ worst: { risk: 0.5 } }, { worst: { risk: 0.5 } }]);
  assert.notEqual(oneUnread.length, bothRead.length, "an unread lane must not draw a dot");

  assert.equal(textWidth("ABC", 1), 17, "3 glyphs of 5px, 1px tracking, no trailing gap");
  assert.equal(textWidth("A", 2), 10);
}
console.log("the social card is a valid PNG at the promised size");




server.close();

// ── the answer opens with the question that was actually asked ──────────────
{
  // A fixed template only matches a question phrased the way it happens to be
  // written: against the real WEATHER_FORECAST champion it scored 0.9943 on one
  // phrasing and 0.0117 on another. Restating what arrived holds 0.9945-0.9989
  // across all three weather champions, so this is worth a test.
  assert.equal(restate("Weather forecast for Cebu in the next 6 hours?"), "Weather forecast for Cebu in the next 6 hours");
  assert.equal(restate("  spaced\n\nout  here "), "spaced out here");

  // Untrusted input on its way back out. Control characters go, because a
  // summary is read by a scorer, a page and a terminal, and only one of those
  // treats a stray escape as text.
  assert.equal(restate("Cebu weather\u0000\u001b[31m now?"), "Cebu weather [31m now");

  // Refused rather than echoed: too short to be a question, and long enough to
  // be someone using the miner as a mirror.
  assert.equal(restate("hi"), null);
  assert.equal(restate("x".repeat(200)), null);
  assert.equal(restate(undefined), null);
  assert.equal(restate(null), null);

  // With no question the summary still opens by naming what it answers about,
  // and says the place once rather than twice.
  const noQ = summarise({
    lat: 10.32, lon: 123.89, hours: 6, temp_c: 27.1, wind_kmh: 11.4, gust_kmh: 29.9,
    precip_mm: 0, risk: 0.332, valid_at: "2026-08-27T11:00Z", condition: "Overcast",
    temp_min_c: 26.2, temp_max_c: 32.4,
  });
  assert.ok(noQ.startsWith("The weather forecast for 10.32, 123.89 over the next 6 hours is "));
  assert.equal(noQ.match(/10\.32, 123\.89/g).length, 1, `the point is named once: ${noQ}`);

  // With one, it leads with that question and still carries every scalar.
  const asked = summarise({
    lat: 10.32, lon: 123.89, hours: 6, question: "Is there a storm risk at 10.32, 123.89?",
    temp_c: 27.1, wind_kmh: 11.4, gust_kmh: 29.9, precip_mm: 0, risk: 0.332,
    valid_at: "2026-08-27T11:00Z", condition: "Overcast", temp_min_c: 26.2, temp_max_c: 32.4,
  });
  assert.ok(asked.startsWith("Is there a storm risk at 10.32, 123.89: "), asked);
  for (const needle of ["27.1", "11.4", "29.9", "0.0", "0.332", "2026-08-27T11:00Z", "Overcast"]) {
    assert.ok(asked.includes(needle), `restating the question must not drop ${needle}: ${asked}`);
  }
}
console.log("the answer opens with the question that was asked, and drops nothing");
