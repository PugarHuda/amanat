#!/usr/bin/env node
// storm — a command line over the live Amanat miner.
//
// The contract is not the only thing that can act on a verified reading. This
// is the same miner, consumed over plain HTTP by anything with a shell: a
// place in, a storm risk out, the trigger stated, and the signature checked
// with Node's own crypto. No install, no dependencies, no key, no wallet.
//
// Exit codes are the interface as much as the text is: 0 means the miner
// answered, 1 means it could not (or a signature did not verify), 2 means the
// arguments were wrong. Nothing here invents a reading.

import { parseArgs } from "node:util";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { pathToFileURL } from "node:url";

const BASE = (process.env.AMANAT_MINER ?? "https://amanat-miner.vercel.app").replace(/\/+$/, "");
const TRIGGER = 0.75;

/** A failure we can explain. `code` is the process exit code. */
export class Fail extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const usage = (m) => new Fail(m, 2);

/**
 * One call to the miner.
 *
 * Whatever it says is what gets reported — a 400 carries the reason it refused,
 * a 429 means the day's upstream quota is spent. Swallowing either and
 * substituting a plausible number would defeat the point of a signed answer.
 */
export async function api(path, init = {}) {
  let res;
  try {
    res = await fetch(BASE + path, { signal: AbortSignal.timeout(60_000), ...init });
  } catch (e) {
    throw new Fail(`cannot reach ${BASE}${path}: ${e.message}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch { /* reported below */ }

  if (!res.ok) {
    const said = body?.error ?? (text.trim().slice(0, 300) || "(empty body)");
    throw new Fail(`miner ${res.status} on ${path}: ${said}`);
  }
  if (body === null) throw new Fail(`miner ${res.status} on ${path}: response was not JSON`);
  return body;
}

/** "10.3, 123.9" -> a point; anything else -> null, and the miner geocodes it. */
export function asPoint(s) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s ?? "");
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** A reading for a place name, a question, or a coordinate pair. */
export async function reading(target, hours) {
  if (!target) throw usage('give a place name or "lat,lon"');
  const body = asPoint(target) ?? { question: target };
  if (hours !== undefined) body.hours = hours;
  return api("/forecast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---- formatting -------------------------------------------------------------

const f3 = (n) => (typeof n === "number" ? n.toFixed(3) : "?");
const pct = (n) => (typeof n === "number" ? `${Math.round(n * 100)}%` : "?");
const where = (o) => `${o.lat}, ${o.lon}`;

function wrap(text, width = 78) {
  const out = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.join("\n");
}

function triggerLine(risk) {
  return risk >= TRIGGER
    ? `trigger  ${f3(risk)} >= ${TRIGGER} — CROSSED, the payout condition is met`
    : `trigger  ${f3(risk)} <  ${TRIGGER} — not crossed, ${f3(TRIGGER - risk)} to go`;
}

function bandLine(band) {
  if (!band) return "band     no ensemble band on this reading";
  return `band     ${f3(band.p10)}–${f3(band.p90)} (p10–p90 of ${band.members} ${band.model} members), ` +
    `${pct(band.breach_probability)} over trigger`;
}

/** 168 hourly numbers do not fit a terminal line; the shape of them does. */
function spark(series, width = 72) {
  const blocks = "▁▂▃▄▅▆▇█";
  if (!series?.length) return "";
  const per = Math.ceil(series.length / width);
  let out = "";
  for (let i = 0; i < series.length; i += per) {
    const peak = Math.max(...series.slice(i, i + per).map((p) => p.risk ?? 0));
    out += blocks[Math.min(blocks.length - 1, Math.floor(peak * blocks.length))];
  }
  return out;
}

// ---- commands ---------------------------------------------------------------

async function cmdRead(target, opts) {
  const a = await reading(target, opts.hours);
  const head = [a.place ?? where(a), where(a), `valid ${a.valid_at} (+${a.hours}h)`].join("  —  ");
  return {
    json: a,
    text: [head, "", wrap(a.summary), "", bandLine(a.risk_band), triggerLine(a.risk)].join("\n"),
  };
}

async function cmdRoute(from, to, opts) {
  if (!from || !to) throw usage("route needs a from and a to");
  const q = new URLSearchParams({ from, to });
  if (opts.legs !== undefined) q.set("legs", String(opts.legs));
  if (opts.speed !== undefined) q.set("speed", String(opts.speed));
  const r = await api(`/api/route?${q}`);

  const lines = [
    `${r.from.place ?? where(r.from)}  ->  ${r.to.place ?? where(r.to)}`,
    `${r.distance_km} km at ${r.speed_kmh} km/h, ${r.duration_hours} h under way`,
    "",
    ...r.legs.map((l) =>
      `${String(l.km_from_start).padStart(5)} km  +${String(l.eta_hours).padStart(3)}h  ` +
      `risk ${f3(l.risk)}  ${l.condition ?? ""}`.trimEnd()),
    "",
    `worst    ${f3(r.worst?.risk)} at hour ${r.worst?.eta_hours} (${where(r.worst ?? {})})`,
    triggerLine(r.worst?.risk ?? 0),
    wrap(r.verdict ?? ""),
  ];
  if (r.unread) lines.push(`note     ${r.unread} leg(s) could not be read`);
  return { json: r, text: lines.join("\n") };
}

async function cmdBacktest(target, start, end) {
  if (!target || !start || !end) throw usage("backtest needs a place, a start date and an end date");
  for (const d of [start, end]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw usage(`dates must be YYYY-MM-DD, got "${d}"`);
  }
  // The archive route takes coordinates only, so a place name is resolved by
  // the miner's own geocoder — one extra call, still nothing but this miner.
  const point = asPoint(target) ?? await reading(target).then((a) => ({ lat: a.lat, lon: a.lon, place: a.place }));
  const q = new URLSearchParams({ lat: String(point.lat), lon: String(point.lon), start, end });
  const b = await api(`/api/backtest?${q}`);

  const peak = b.peak
    ? `peak     ${f3(b.peak.risk)} at ${b.peak.at} — wind ${b.peak.wind_kmh} km/h, gusts ` +
      `${b.peak.gust_kmh} km/h, rain ${b.peak.precip_mm} mm`
    : "peak     no hours returned";
  return {
    json: b,
    text: [
      `${point.place ?? where(b)}  —  ${where(b)}  —  ${b.start} to ${b.end} (${b.hours} h, trigger ${b.trigger})`,
      "",
      spark(b.series),
      "",
      peak,
      b.breach
        ? `verdict  breached — ${b.hours_above_trigger} h at or above the trigger, the policy would have paid`
        : `verdict  never breached — 0 h at or above the trigger, no payout`,
      `source   ${b.source ?? "?"}`,
    ].join("\n"),
  };
}

async function cmdBoard() {
  const b = await api("/api/board");
  const width = Math.max(...b.lanes.map((l) => l.name.length));
  return {
    json: b,
    text: [
      `Storm board — published ${b.generated_at}, rail: ${b.rail}, trigger ${b.trigger}`,
      "",
      ...b.lanes.map((l) =>
        `${l.name.padEnd(width)}  worst ${f3(l.worst?.risk)}  ${l.breach ? "BREACH" : "  ok  "}  ${l.verdict}`),
    ].join("\n"),
  };
}

/**
 * Fetch a reading and check its Ed25519 attestation.
 *
 * The interesting checks are the two that a naive verifier skips: that the
 * signed bytes are the answer's own fields rather than some other numbers, and
 * that the key that signed them is the key published at /.well-known. Without
 * both, a valid signature proves nothing about the reading printed above it.
 */
async function cmdVerify(target, opts) {
  const [a, wk] = await Promise.all([
    reading(target ?? "Cebu", opts.hours),
    api("/.well-known/amanat.json"),
  ]);
  const att = a.attestation;
  if (!att) throw new Fail("the reading carried no attestation");

  const rebuilt = JSON.stringify(Object.fromEntries((att.signed_fields ?? []).map((k) => [k, a[k] ?? null])));
  const checks = [
    ["algorithm is ed25519", att.algorithm === "ed25519"],
    ["signed fields are the published set",
      JSON.stringify(att.signed_fields) === JSON.stringify(wk.signing?.signed_fields)],
    ["public key matches /.well-known/amanat.json", att.public_key === wk.signing?.public_key],
    ["canonical bytes are the answer's own fields", rebuilt === att.canonical],
    ["sha256 matches the canonical bytes",
      createHash("sha256").update(att.canonical).digest("hex") === att.sha256],
    ["Ed25519 signature verifies", (() => {
      try {
        const pub = createPublicKey({ key: Buffer.from(att.public_key, "base64"), format: "der", type: "spki" });
        return edVerify(null, Buffer.from(att.canonical), pub, Buffer.from(att.signature, "base64"));
      } catch {
        return false;
      }
    })()],
    ["key is persistent, not per-instance", att.key_persistent === true],
  ];
  const ok = checks.every(([, pass]) => pass);

  return {
    json: { ok, place: a.place, risk: a.risk, breach: a.breach, checks: Object.fromEntries(checks), attestation: att },
    code: ok ? 0 : 1,
    text: [
      `${a.place ?? where(a)}  —  risk ${f3(a.risk)}, breach ${a.breach}, valid ${a.valid_at}`,
      `key ${att.public_key}`,
      "",
      ...checks.map(([label, pass]) => `  ${pass ? "ok  " : "FAIL"}  ${label}`),
      "",
      ok
        ? "verified — this miner signed these exact numbers, and the key is the published one."
        : "NOT VERIFIED — do not act on this reading.",
    ].join("\n"),
  };
}

// ---- argv -------------------------------------------------------------------

const HELP = `storm — read the Amanat miner (${BASE})

  node app/storm.mjs <place|"lat,lon"> [--hours N]   storm risk for a point
  node app/storm.mjs route <from> <to> [--legs N] [--speed KMH]
  node app/storm.mjs backtest <place> <start> <end>  would the trigger have fired
  node app/storm.mjs board                           the published lane board
  node app/storm.mjs verify [place]                  check the Ed25519 attestation

  --json    the miner's own JSON, unaltered
  --hours   0..168, hours from now (default: read from the question)

Exit 0 answered, 1 the miner could not answer or a signature failed, 2 bad arguments.
Set AMANAT_MINER to point at another instance.`;

const COMMANDS = new Set(["read", "route", "backtest", "board", "verify", "help"]);

function num(v, name, { min, max, int = false }) {
  if (v === undefined) return undefined;
  const n = Number(v);
  const bad = !Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n));
  if (bad) throw usage(`--${name} must be ${int ? "an integer" : "a number"} between ${min} and ${max}`);
  return n;
}

/** Parse argv and run one command. Returns { text, json, code }. */
export async function run(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        hours: { type: "string" },
        legs: { type: "string" },
        speed: { type: "string" },
      },
    });
  } catch (e) {
    throw usage(e.message);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals[0] === "help") return { text: HELP, json: null };

  const opts = {
    hours: num(values.hours, "hours", { min: 0, max: 168, int: true }),
    legs: num(values.legs, "legs", { min: 2, max: 12, int: true }),
    speed: num(values.speed, "speed", { min: 1, max: 2000 }),
  };

  const cmd = COMMANDS.has(positionals[0]) ? positionals[0] : "read";
  const rest = cmd === positionals[0] ? positionals.slice(1) : positionals;

  const out = await (async () => {
    switch (cmd) {
      case "read": return cmdRead(rest.join(" ").trim(), opts);
      case "route": return cmdRoute(rest[0], rest[1], opts);
      case "backtest": return cmdBacktest(rest[0], rest[1], rest[2]);
      case "board": return cmdBoard();
      default: return cmdVerify(rest.join(" ").trim() || undefined, opts);
    }
  })();

  if (values.json && out.json) out.text = JSON.stringify(out.json, null, 2);
  return out;
}

async function main() {
  try {
    const { text, code = 0 } = await run(process.argv.slice(2));
    console.log(text);
    return code;
  } catch (e) {
    console.error(e instanceof Fail ? `storm: ${e.message}` : `storm: unexpected: ${e.stack}`);
    return e instanceof Fail ? e.code : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
