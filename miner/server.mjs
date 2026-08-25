// Standalone HTTP miner — what Docker and `npm run miner` run.
// The logic lives in lib/forecast.mjs; this is transport only.

import { createServer } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { forecast } from "./lib/forecast.mjs";
import { book } from "./lib/book.mjs";

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

    if (pathname === "/forecast") {
      const body = req.method === "POST" ? await readJson(req) : {};
      const lat = Number(body.lat ?? searchParams.get("lat"));
      const lon = Number(body.lon ?? searchParams.get("lon"));
      const hours = Number(body.hours ?? searchParams.get("hours") ?? 0);
      return send(res, 200, await forecast({ lat, lon, hours }));
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
