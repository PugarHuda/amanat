// Standalone HTTP miner — what Docker and `npm run miner` run.
// The logic lives in lib/forecast.mjs; this is transport only.

import { createServer } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { forecast, hoursIn } from "./lib/forecast.mjs";
import { locate } from "./lib/geocode.mjs";
import { book, policies } from "./lib/book.mjs";

// Callers name the question field differently and the protocol does not fix
// one. Accepting the whole set costs a lookup and turns "unsupported request"
// into an answer.
const QUESTION_FIELDS = ["question", "q", "query", "prompt", "text", "input", "place", "location", "city"];

const HERE = dirname(fileURLToPath(import.meta.url));
// One file, read once. The page is static and the server has no build step.
const PAGE = readFileSync(join(HERE, "public/index.html"));

const PORT = Number(process.env.PORT ?? 8787);

function send(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new RangeError("body too large");
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export const server = createServer(async (req, res) => {
  try {
    const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": PAGE.length });
      return res.end(PAGE);
    }

    if (pathname === "/health") return send(res, 200, { status: "ok", miner: "amanat", time: new Date().toISOString() });

    // What the contract is carrying, read straight off chain for the page.
    if (pathname === "/api/book") return send(res, 200, await book());

    // Every policy the contract has written. Nothing on the page is typed in.
    if (pathname === "/api/policies") return send(res, 200, await policies({ limit: 40 }));

    if (pathname === "/forecast") {
      const body = req.method === "POST" ? await readJson(req) : {};
      const field = (name) => {
        const raw = body[name] ?? searchParams.get(name);
        return raw === undefined || raw === null || raw === "" ? undefined : raw;
      };

      // Absent is not zero. Number(null) and Number(undefined ?? null) both
      // collapse to 0, which turned a request with no coordinates into a
      // confident forecast for Null Island — the exact failure this miner
      // exists to avoid. Say what is missing instead.
      const rawLat = field("lat");
      const rawLon = field("lon");
      const question = QUESTION_FIELDS.map(field).find((v) => typeof v === "string" && v.trim() !== "");

      let lat, lon, place;
      if (rawLat !== undefined || rawLon !== undefined) {
        if (rawLat === undefined) throw new RangeError("lat is required alongside lon");
        if (rawLon === undefined) throw new RangeError("lon is required alongside lat");
        lat = Number(rawLat);
        lon = Number(rawLon);
      } else if (question !== undefined) {
        // The epoch tournament puts one sentence to every miner on an intent.
        // Refusing it because it is not a coordinate pair scores zero however
        // good the forecast behind it would have been.
        const hit = await locate(question);
        if (!hit) throw new RangeError(`no place found in "${String(question).slice(0, 120)}"`);
        ({ lat, lon, place } = hit);
      } else {
        throw new RangeError("lat and lon are required, or a question naming a place");
      }

      const rawHours = field("hours");
      const hours = rawHours !== undefined ? Number(rawHours)
        : question !== undefined ? hoursIn(question)
        : 0;
      return send(res, 200, await forecast({ lat, lon, hours, place }));
    }

    send(res, 404, { error: "not found", endpoints: ["/forecast", "/health"] });
  } catch (e) {
    // A validation mistake is the caller's; anything else is ours. Both are
    // real HTTP errors so Telegraph does not charge for them or store a signal.
    const client = e instanceof RangeError || e instanceof SyntaxError;
    send(res, client ? 400 : 502, { error: e.message });
  }
});

// Vercel imports this module and expects the default export to be the server;
// running it locally or in Docker goes through listen() below. Both paths, one
// server object.
export default server;

// Listen when run as a program, and whenever a host hands us a PORT — Vercel
// launches this file itself, and a guard that only fires for argv[1] leaves the
// deployment silently dead.
const RUN_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (RUN_DIRECTLY || process.env.PORT) {
  server.listen(PORT, () => console.log(`amanat miner on :${PORT}`));
}
