#!/usr/bin/env node
// Amanat as an MCP server: four tools over stdio, no dependencies, no wallet.
//
//   npx -y github:PugarHuda/amanat amanat-mcp
//   node mcp/server.mjs
//
// Add it to any MCP client:
//
//   { "mcpServers": { "amanat": { "command": "node",
//     "args": ["/path/to/amanat/mcp/server.mjs"] } } }
//
// Every tool is a read of the live miner over plain HTTPS. Nothing here signs
// anything, spends anything or needs a key — the paid rails live in agent/, and
// an agent that wants a validator-verified answer should go through the
// Telegraph Engine rather than through this.
//
// ponytail: JSON-RPC by hand rather than @modelcontextprotocol/sdk. The protocol
// is four methods over newline-delimited JSON, the miner has no dependencies and
// keeps none, and a transport this small is easier to read than to configure.
// Swap in the SDK if this ever needs sampling, resources or prompts.

import { createInterface } from "node:readline";

const BASE = (process.env.AMANAT_MINER ?? "https://amanat-miner.vercel.app").replace(/\/+$/, "");
const NAME = "amanat";
const VERSION = "0.1.0";

// The revision this speaks. A client asking for a different one still gets a
// working session — every method here has been stable across them — so the
// answer echoes what was asked for rather than insisting.
const PROTOCOL = "2024-11-05";

const TOOLS = [
  {
    name: "storm_risk",
    description:
      "Storm risk for a place or coordinate, 0 to 1, with the reading behind it: wind, gusts, " +
      "precipitation, sea state, the nearest named cyclone, and a band across 51 ECMWF ensemble " +
      "members. 0.75 is the line a parametric cover pays on. Accepts a place name, a whole " +
      "question naming one, or \"lat,lon\".",
    inputSchema: {
      type: "object",
      properties: {
        place: { type: "string", description: 'A place name, a question naming one, or "lat,lon".' },
        hours: {
          type: "integer",
          minimum: 0,
          maximum: 168,
          description: "Hours ahead, 0 to 168. Omit to read it from the question, or 0 for now.",
        },
      },
      required: ["place"],
    },
  },
  {
    name: "route_risk",
    description:
      "Storm risk along a route, each leg read at the hour a vehicle travelling at `speed` " +
      "actually reaches it — not one reading for the whole voyage. Returns the worst leg and " +
      "whether it crosses the 0.75 trigger.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Origin place name." },
        to: { type: "string", description: "Destination place name." },
        speed: { type: "number", description: "Speed in km/h. Default 37, about 20 knots." },
        legs: { type: "integer", minimum: 2, maximum: 12, description: "Waypoints. Default 3." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "backtest",
    description:
      "Would the 0.75 trigger have fired at this place over this date range? Read from the " +
      "ERA5 reanalysis archive, so it is what actually happened rather than a forecast. " +
      "Typhoon Rai at Cebu, 2021-12-15 to 2021-12-18, reads 1.000.",
    inputSchema: {
      type: "object",
      properties: {
        place: { type: "string", description: 'Place name or "lat,lon".' },
        start: { type: "string", description: "ISO date, e.g. 2021-12-15." },
        end: { type: "string", description: "ISO date, e.g. 2021-12-18." },
      },
      required: ["place", "start", "end"],
    },
  },
  {
    name: "telegraph_onchain_jobable",
    description:
      "Which Telegraph intents an ERC-8183 on-chain job cannot survive, and which miners on each " +
      "one can actually receive a job. A job is routed by rank and nothing in that path checks " +
      "whether the miner it lands on declares an `on_chain.request` mapping — so on most intents " +
      "the job is answered from that miner's first endpoint with no parameters. Read this before " +
      "putting a contract on the on-chain rail.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** A place that may be "lat,lon" becomes coordinates; anything else is a question. */
function asTarget(place) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(place ?? "");
  if (!m) return { question: place };
  return { lat: Number(m[1]), lon: Number(m[2]) };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(60_000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `miner ${res.status} on ${path}`);
  return body;
}

async function post(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `miner ${res.status} on ${path}`);
  return body;
}

const CALLS = {
  async storm_risk({ place, hours }) {
    const body = asTarget(place);
    if (hours !== undefined) body.hours = hours;
    const a = await post("/forecast", body);
    return {
      place: a.place ?? `${a.lat}, ${a.lon}`,
      lat: a.lat,
      lon: a.lon,
      valid_at: a.valid_at,
      risk: a.risk,
      trigger: 0.75,
      // The whole reason this exists: a number a contract can act on, and the
      // sentence a person can check it against.
      breach: a.breach,
      band: a.risk_band,
      summary: a.summary,
      attribution: a.attribution,
    };
  },

  async route_risk({ from, to, speed, legs }) {
    const q = new URLSearchParams({ from, to });
    if (speed !== undefined) q.set("speed", String(speed));
    if (legs !== undefined) q.set("legs", String(legs));
    const r = await get(`/api/route?${q}`);
    return {
      from: r.from,
      to: r.to,
      distance_km: r.distance_km,
      duration_hours: r.duration_hours,
      worst: r.worst,
      breach: r.breach,
      verdict: r.verdict,
      legs: r.legs,
    };
  },

  async backtest({ place, start, end }) {
    const t = asTarget(place);
    const q = new URLSearchParams({ start, end });
    if (t.question) q.set("place", t.question);
    else { q.set("lat", String(t.lat)); q.set("lon", String(t.lon)); }
    return get(`/api/backtest?${q}`);
  },

  async telegraph_onchain_jobable() {
    const j = await get("/api/jobable");
    return {
      read_at: j.read_at,
      closed_intents: j.dead?.length,
      scored_intents: j.scored_name_hashed_intents,
      dead: j.dead,
      jobable_by_intent: j.jobable_by_intent,
    };
  },
};

// ── JSON-RPC ────────────────────────────────────────────────────────────────

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  // A notification has no id and must never be answered — a response to one is
  // a protocol error, and some clients close the session over it.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return; // nothing to say, and saying it would be wrong

    case "ping":
      return reply(id, {});

    case "tools/list":
      return reply(id, { tools: TOOLS });

    case "tools/call": {
      const fn = CALLS[params?.name];
      if (!fn) return fail(id, -32602, `no tool called ${params?.name}`);
      try {
        const out = await fn(params.arguments ?? {});
        return reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        // A refusal from the miner is a result, not a transport failure: the
        // model should see "no place found in ..." and try a different place,
        // not watch the session die.
        return reply(id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
      }
    }

    default:
      if (isNotification) return;
      return fail(id, -32601, `unknown method ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return fail(null, -32700, "parse error");
  }
  handle(msg).catch((e) => {
    if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, e.message);
  });
});

// stdin closing is the client leaving. Exit quietly; an MCP server that logs to
// stdout on the way out corrupts the last frame the client is still reading.
process.stdin.on("close", () => process.exit(0));
