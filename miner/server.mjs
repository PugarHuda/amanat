// Standalone HTTP miner — what Docker and `npm run miner` run.
// The logic lives in lib/forecast.mjs; this is transport only.

import { createServer } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { forecast, hoursIn } from "./lib/forecast.mjs";
import { locate } from "./lib/geocode.mjs";
import { assessRoute } from "./lib/route.mjs";
import { bucket, ttlCache } from "./lib/cache.mjs";
import { drawCard } from "./lib/card.mjs";

/** Where this deployment lives, for the absolute URLs crawlers require. */
const SITE = process.env.AMANAT_SITE_URL ?? "https://amanat-miner.vercel.app";

/** Rendered cards, keyed on the board they were drawn from. */
const CARDS = ttlCache({ ttlMs: 30 * 60_000, max: 4 });
import { book, policies } from "./lib/book.mjs";

/**
 * What one instance will spend on route requests in a minute.
 *
 * Twenty is far more than a person clicking a form and far less than what it
 * takes to burn 10 000 upstream calls in a day.
 */
const routeBudget = bucket({ perMinute: Number(process.env.AMANAT_ROUTE_PER_MINUTE ?? 20) });

// Where the scheduled agent publishes. An orphan branch, so a data refresh
// carries no source changes and triggers no build.
const BOARD_URL = process.env.AMANAT_BOARD_URL
  ?? "https://raw.githubusercontent.com/PugarHuda/amanat/board/board.json";

// Callers name the question field differently and the protocol does not fix
// one. Accepting the whole set costs a lookup and turns "unsupported request"
// into an answer.
const QUESTION_FIELDS = ["question", "q", "query", "prompt", "text", "input", "place", "location", "city"];

/**
 * One end of a route: a place name, "lat, lon", or { lat, lon }.
 *
 * Named so the error says which end failed. "no place found" is a much worse
 * message when the caller gave two places and one of them was fine.
 */
async function endpointOf(spec, which) {
  if (spec && typeof spec === "object" && spec.lat !== undefined && spec.lon !== undefined) {
    const lat = Number(spec.lat);
    const lon = Number(spec.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new RangeError(`${which} has non-numeric coordinates`);
    return { lat, lon, place: `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
  }
  if (typeof spec !== "string" || spec.trim() === "") {
    throw new RangeError(`${which} is required — a place name, "lat, lon", or {lat, lon}`);
  }
  const hit = await locate(spec);
  if (!hit) throw new RangeError(`no place found for ${which}: "${spec.slice(0, 80)}"`);
  return hit;
}

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

    // The social preview card, drawn from the live board.
    //
    // A quarter of the hackathon score is engagement on X, and until now every
    // link posted there rendered as a bare URL. The card is generated rather
    // than committed because the interesting version is the real one: today's
    // lanes, at today's risk, against the line that pays.
    if (pathname === "/card.png") {
      const board = await fetch(BOARD_URL, { signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      // Rendered bytes are cached, not just the board: a card that trends gets
      // fetched by every crawler that sees it, and redrawing 750 000 pixels for
      // each of them is work nobody asked for.
      const key = board?.generated_at ?? "empty";
      const png = await CARDS.through(key, async () => drawCard(board?.lanes ?? []));

      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png.length,
        "Cache-Control": "public, max-age=1800",
      });
      return res.end(png);
    }

    // Crawlers ask for these by name and a 404 is a worse answer than a short
    // one. The favicon is inline in the page as an SVG data URI; this is for
    // the readers that only ever ask for /favicon.ico.
    if (pathname === "/robots.txt") {
      const body = `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      return res.end(body);
    }
    if (pathname === "/sitemap.xml") {
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url><loc>${SITE}/</loc><changefreq>hourly</changefreq></url>\n` +
        `</urlset>\n`;
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      return res.end(body);
    }
    if (pathname === "/favicon.ico") {
      res.writeHead(302, { Location: "/card.png" });
      return res.end();
    }

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

    // The storm board, as the scheduled agent last published it.
    //
    // Fetched from the branch rather than read off disk: the file is written by
    // a workflow every twelve hours, and a deployment bundles whatever existed
    // at build time. Reading it here means the board is current without a
    // redeploy, which matters more than it sounds — the free tier allows a
    // hundred deployments a day, and a data refresh must never cost one.
    if (pathname === "/api/board") {
      const upstream = await fetch(BOARD_URL, { signal: AbortSignal.timeout(8000) });
      if (upstream.status === 404) {
        return send(res, 503, { error: "the board has not been published yet — the schedule writes it every 12 hours" });
      }
      if (!upstream.ok) throw new Error(`board ${upstream.status}`);

      const board = await upstream.json();
      res.writeHead(200, {
        "Content-Type": "application/json",
        // Half the publish interval: fresh enough to be current, long enough
        // that a busy page does not hammer the branch.
        "Cache-Control": "public, max-age=1800",
      });
      return res.end(JSON.stringify(board));
    }

    // Storm risk along a route. A shipment is not exposed to the weather at its
    // origin, so each leg is forecast for the hour the cargo reaches it.
    if (pathname === "/api/route") {
      // A route is the only endpoint that turns one request into many upstream
      // calls — twelve legs and two geocoded endpoints is twenty — so it is the
      // only one that can exhaust the day's quota. When that goes, /forecast
      // goes with it, and /forecast is what the network scores. A convenience
      // endpoint must never be able to take the miner off the network.
      if (!routeBudget.take()) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
        return res.end(JSON.stringify({
          error: "too many route requests this minute — the upstream quota is shared with /forecast, " +
            "which the network scores. Try again shortly, or ask about one point at a time.",
        }));
      }

      const body = req.method === "POST" ? await readJson(req) : {};
      const from = await endpointOf(body.from ?? searchParams.get("from"), "from");
      const to = await endpointOf(body.to ?? searchParams.get("to"), "to");

      const speedKmh = Number(body.speed_kmh ?? searchParams.get("speed_kmh") ?? 37);
      // Each leg costs an upstream call, and Open-Meteo's free tier is what
      // pays for it. The ceiling is a real limit, not a round number.
      const max = Math.min(12, Math.max(2, Number(body.max_legs ?? searchParams.get("max_legs") ?? 8)));

      return send(res, 200, await assessRoute({
        from, to, speedKmh, max,
        read: ({ lat, lon, hours }) => forecast({ lat, lon, hours }),
      }));
    }

    send(res, 404, { error: "not found", endpoints: ["/forecast", "/api/route", "/api/board", "/health"] });
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
