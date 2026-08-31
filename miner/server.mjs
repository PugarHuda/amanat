// Standalone HTTP miner — what Docker and `npm run miner` run.
// The logic lives in lib/forecast.mjs; this is transport only.

import { createServer } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { forecast, hoursIn, windowIn, seriesCacheSize, seaCacheSize } from "./lib/forecast.mjs";
import { backtest, isCached as backtestCached } from "./lib/backtest.mjs";
import { report as upstreamReport } from "./lib/upstream.mjs";
import { publicKey, keyIsPersistent, SIGNED_FIELDS } from "./lib/sign.mjs";
import { locate, placeCacheSize } from "./lib/geocode.mjs";
import { assessRoute } from "./lib/route.mjs";
import { bucket, ttlCache } from "./lib/cache.mjs";
import { drawCard } from "./lib/card.mjs";
import { book, policies } from "./lib/book.mjs";

/** Where this deployment lives, for the absolute URLs crawlers require. */
const SITE = process.env.AMANAT_SITE_URL ?? "https://amanat-miner.vercel.app";

/** Rendered cards, keyed on the board they were drawn from. */
const CARDS = ttlCache({ ttlMs: 30 * 60_000, max: 4 });

/**
 * What one instance will spend on route requests in a minute.
 *
 * Twenty is far more than a person clicking a form and far less than what it
 * takes to burn 10 000 upstream calls in a day.
 */
const routeBudget = bucket({ perMinute: Number(process.env.AMANAT_ROUTE_PER_MINUTE ?? 20) });
// The archive shares Open-Meteo's per-IP quota with the forecast the network
// scores, and a backtest is one archive call per point and date range. Cached
// a day once read; the budget bounds what a stranger can make this instance
// fetch fresh in a minute.
const backtestBudget = bucket({ perMinute: Number(process.env.AMANAT_BACKTEST_PER_MINUTE ?? 30) });

// Where the scheduled agent publishes. An orphan branch, so a data refresh
// carries no source changes and triggers no build.
const BOARD_URL = process.env.AMANAT_BOARD_URL
  ?? "https://raw.githubusercontent.com/PugarHuda/amanat/board/board.json";

// The same branch carries the network survey. It costs nothing to produce —
// both catalogues are public reads — so it refreshes on the board's schedule.
const SURVEY_URL = process.env.AMANAT_SURVEY_URL
  ?? "https://raw.githubusercontent.com/PugarHuda/amanat/board/survey.json";

// `cache: "no-store"` on every fetch of these three, because the freshness that
// matters is decided here and not upstream. The board published ten lanes at
// 12:25 and this endpoint was still serving the five-lane copy from 05:12 eight
// minutes later, while a curl of the same raw URL from a laptop returned the new
// one — so something between the function and the branch was holding a copy
// longer than its own max-age=300. Downstream callers still get the
// Cache-Control this route sets; that is the layer where caching belongs.
//
// And the on-chain audit: which intents an ERC-8183 job cannot survive, and who
// on each one can actually receive one. Same branch, same schedule, same reason
// — it reads every registered YAML on the network, which is not a thing to do
// per request.
const JOBABLE_URL = process.env.AMANAT_JOBABLE_URL
  ?? "https://raw.githubusercontent.com/PugarHuda/amanat/board/jobable.json";

// Callers name the question field differently and the protocol does not fix
// one. Accepting the whole set costs a lookup and turns "unsupported request"
// into an answer.
const QUESTION_FIELDS = ["question", "q", "query", "prompt", "text", "input", "place", "location", "city"];

/**
 * The last questions this miner was asked, newest first.
 *
 * Epoch 286 scored the restated summary at 0.0079 where the champion binary,
 * run locally on the same answer, scored 0.99. The gap means the node is
 * grading something other than what was reasoned about here, and from outside
 * there was no way to see what it sends: not the field it uses, not the
 * phrasing, not whether it names a place or a coordinate. This keeps the last
 * fifty, with the field the question arrived in, so `/api/asked` can show
 * exactly what the tournament asks rather than what the docs say it asks.
 *
 * A serverless instance keeps its own fifty and forgets them when it is
 * recycled. That is enough: the question is what the node asks, not how often.
 */
const ASKED_MAX = 50;
const ASKED = [];
export const asked = () => ASKED.slice();
function recordAsk({ field, question, lat, lon, hours, ua }) {
  ASKED.unshift({ at: new Date().toISOString(), field, question: question?.slice(0, 200) ?? null, lat, lon, hours, ua: ua?.slice(0, 80) ?? null });
  if (ASKED.length > ASKED_MAX) ASKED.length = ASKED_MAX;
}

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
const USE = readFileSync(join(HERE, "public/use.html"));
const SLIDES = readFileSync(join(HERE, "public/slides.html"));
const LOGO = readFileSync(join(HERE, "public/logo.svg"));
const OPENAPI = readFileSync(join(HERE, "public/openapi.json"));
const LLMS = readFileSync(join(HERE, "public/llms.txt"));

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
  const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  // `JSON.parse("null")` is null, and a bare scalar is not a body. Every caller
  // reads named fields off this, so anything else is a TypeError deep inside a
  // handler — which `send` maps to 502, a server fault, on the endpoint the
  // network scores. Four bytes should not do that. Arrays are left alone: they
  // carry no named fields and already fail as a missing-argument 400.
  return parsed !== null && typeof parsed === "object" ? parsed : {};
}

// A miner that stops answering is deregistered, so an unhandled rejection must
// not be allowed to end the process. Node's default is to exit; for a service
// whose whole job is to still be there when the node calls, staying up and
// reporting the fault is the right trade. The /api/survey path proved this was
// reachable: a header written before an await, and one bad upstream body took
// the whole miner down instead of one request.
process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection (request dropped, miner stays up):", err);
});

export const server = createServer(async (req, res) => {
  try {
    const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": PAGE.length });
      return res.end(PAGE);
    }

    // The four ways in, on their own plate. It is the one section written for a
    // builder rather than a judge, and the front page has to prove the loop
    // closes inside a minute — so this is the section that can afford a click.
    if (pathname === "/use" || pathname === "/use.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": USE.length });
      return res.end(USE);
    }

    // The deck. Nine slides, the same design system, no framework — a judge with
    // three minutes reads this, a judge with thirty reads the front page. It is
    // static like the other two, so it costs a file read and nothing else.
    if (pathname === "/slides" || pathname === "/slides.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": SLIDES.length });
      return res.end(SLIDES);
    }

    // Health, with enough in it to act on.
    //
    // "ok" alone answers one question — is the process up — and none of the
    // ones that actually take this miner off the network: whether the upstream
    // quota is being eaten, whether the board has stopped refreshing, whether
    // the caches are absorbing anything. The node's own liveness check only
    // reads `status`, so the rest costs nothing it cares about.
    if (pathname === "/health") {
      const board = await fetch(BOARD_URL, { signal: AbortSignal.timeout(4000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const ageHours = board ? (Date.now() - Date.parse(board.generated_at)) / 3600e3 : null;
      // The ledger of every upstream this instance has called: last success,
      // last failure and why. "degraded" means the weather model — the one
      // route the network scores — failed more recently than it succeeded.
      // Still HTTP 200: the node's liveness check reads the status word, and a
      // miner that answers 503 while its upstream hiccups is a miner that gets
      // deregistered for someone else's outage.
      const { upstreams, degraded } = upstreamReport();
      return send(res, 200, {
        status: degraded ? "degraded" : "ok",
        miner: "amanat",
        time: new Date().toISOString(),
        board: board
          ? {
              generated_at: board.generated_at,
              age_hours: Number(ageHours.toFixed(1)),
              // The schedule runs every twelve hours, so past a day the run has
              // stopped rather than merely been slow.
              stale: ageHours > 26,
              lanes: board.lanes?.length ?? 0,
            }
          : { published: false },
        upstream: {
          // What one instance has left before it starts refusing route requests.
          // The forecast endpoint the network scores is never rate limited; this
          // is the budget that keeps it that way.
          route_requests_available: Math.floor(routeBudget.available),
          backtest_requests_available: Math.floor(backtestBudget.available),
          calls: upstreams,
          cached_points: seriesCacheSize(),
          cached_sea_points: seaCacheSize(),
          // An ephemeral key means each serverless instance signs with its
          // own; set AMANAT_SIGNING_KEY to make the attestation checkable
          // across restarts. Reported rather than hidden.
          signing_key_persistent: keyIsPersistent,
          cached_places: placeCacheSize(),
        },
      });
    }

    // The social preview card, drawn from the live board.
    //
    // A quarter of the hackathon score is engagement on X, and until now every
    // link posted there rendered as a bare URL. The card is generated rather
    // than committed because the interesting version is the real one: today's
    // lanes, at today's risk, against the line that pays.
    if (pathname === "/card.png") {
      const board = await fetch(BOARD_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) })
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
        `  <url><loc>${SITE}/use</loc><changefreq>monthly</changefreq></url>\n` +
        `</urlset>\n`;
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      return res.end(body);
    }
    // The mark itself, as a file rather than only a data URI, so it can be
    // linked from a README or a post.
    if (pathname === "/logo.svg") {
      res.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Length": LOGO.length,
        "Cache-Control": "public, max-age=86400",
      });
      return res.end(LOGO);
    }
    // /card.png is 1200x630, which is a social card and a poor favicon.
    if (pathname === "/favicon.ico") {
      res.writeHead(302, { Location: "/logo.svg" });
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
      const askedField = QUESTION_FIELDS.find((f) => { const v = field(f); return typeof v === "string" && v.trim() !== ""; });
      const question = askedField === undefined ? undefined : field(askedField);

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
      recordAsk({ field: askedField ?? (rawLat !== undefined ? "lat/lon" : null), question, lat, lon, hours, ua: req.headers["user-agent"] });
      // The hours came from the question, so they describe a window, not an
      // instant. Explicit `hours` from a caller — the contract path — stays an
      // exact hour, because that is what the on-chain mapping was written for.
      const window = rawHours === undefined && question !== undefined && hours > 0 && windowIn(question);
      return send(res, 200, await forecast({ lat, lon, hours, place, question, window }));
    }

    // What the network actually asks. Read this before reasoning about what a
    // scorer sees, because the docs and the tournament do not agree.
    if (pathname === "/api/asked") return send(res, 200, { count: ASKED.length, max: ASKED_MAX, asked: ASKED });

    // Would the trigger have fired? The live thresholds over the archive.
    if (pathname === "/api/backtest") {
      const wanted = { lat: Number(searchParams.get("lat")), lon: Number(searchParams.get("lon")), start: searchParams.get("start"), end: searchParams.get("end") };
      // Only a fresh archive read costs budget; a cached run costs nothing and
      // is never refused. The board's five ports are cached after the first
      // visitor of the day.
      if (!backtestCached(wanted) && !backtestBudget.take()) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
        return res.end(JSON.stringify({ error: "too many backtests this minute — the archive shares its quota with /forecast. Try again shortly." }));
      }
      const num = (k) => { const v = searchParams.get(k); return v === null || v === "" ? NaN : Number(v); };
      const lat = num("lat"), lon = num("lon");
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new RangeError("lat and lon are required");
      const out = await backtest({ lat, lon, start: searchParams.get("start"), end: searchParams.get("end") });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" });
      return res.end(JSON.stringify(out));
    }

    // Machine-readable descriptions of this miner, for agents that read them.
    if (pathname === "/openapi.json") {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": OPENAPI.length, "Cache-Control": "public, max-age=3600" });
      return res.end(OPENAPI);
    }
    if (pathname === "/llms.txt") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": LLMS.length, "Cache-Control": "public, max-age=3600" });
      return res.end(LLMS);
    }
    if (pathname === "/.well-known/amanat.json") {
      return send(res, 200, {
        name: "amanat-weather-risk",
        signing: { algorithm: "ed25519", public_key: publicKey, persistent: keyIsPersistent, signed_fields: SIGNED_FIELDS,
          verify: "Node: crypto.verify(null, Buffer.from(attestation.canonical), crypto.createPublicKey({ key: Buffer.from(public_key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(attestation.signature, 'base64'))" },
        openapi: `${SITE}/openapi.json`,
        llms: `${SITE}/llms.txt`,
        source: "https://github.com/PugarHuda/amanat",
      });
    }

    // The storm board, as the scheduled agent last published it.
    //
    // Fetched from the branch rather than read off disk: the file is written by
    // a workflow every twelve hours, and a deployment bundles whatever existed
    // at build time. Reading it here means the board is current without a
    // redeploy, which matters more than it sounds — the free tier allows a
    // hundred deployments a day, and a data refresh must never cost one.
    // What the network scores, and what the board claims about it. Served from
    // the branch rather than computed per request: the two upstream catalogues
    // are large, and a page refresh must not turn into two megabytes of fetch.
    if (pathname === "/api/survey") {
      const upstream = await fetch(SURVEY_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (upstream.status === 404) {
        return send(res, 503, { error: "the survey has not been published yet — the schedule writes it every 12 hours" });
      }
      if (!upstream.ok) throw new Error(`survey ${upstream.status}`);
      // Read the body before the headers go out. `await upstream.json()` after
      // `writeHead` throws ERR_HTTP_HEADERS_SENT from inside the catch when the
      // branch serves an HTML error page or a truncated file — an unhandled
      // rejection, which takes the whole process down rather than one request.
      const survey = await upstream.json();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" });
      return res.end(JSON.stringify(survey));
    }

    // Which intents an on-chain job cannot survive. A job is routed by rank and
    // nothing in that path checks whether the miner it lands on declares an
    // `on_chain.request` mapping — so on an intent whose rank-1 miner has none,
    // every job comes back as whatever that miner's first endpoint says when
    // handed no parameters. Measured on jobs 15–18; 14 of 15 scored intents.
    // Published because a builder deciding whether to put a contract on this
    // rail should not have to find it the way we did.
    if (pathname === "/api/jobable") {
      const upstream = await fetch(JOBABLE_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (upstream.status === 404) {
        return send(res, 503, { error: "the audit has not been published yet — the schedule writes it every 12 hours" });
      }
      if (!upstream.ok) throw new Error(`jobable ${upstream.status}`);
      const audit = await upstream.json();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" });
      return res.end(JSON.stringify(audit));
    }

    if (pathname === "/api/board") {
      const upstream = await fetch(BOARD_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
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
      const body = req.method === "POST" ? await readJson(req) : {};

      // `speed` and `legs` are what a person types; `speed_kmh` and `max_legs`
      // are what the page sends. Both are accepted, and the spec names both.
      const speedKmh = Number(body.speed_kmh ?? body.speed ?? searchParams.get("speed_kmh") ?? searchParams.get("speed") ?? 37);
      // Each leg costs an upstream call, and Open-Meteo's free tier is what
      // pays for it. The ceiling is a real limit, not a round number.
      // `Number("abc")` is NaN, and NaN through Math.min/max stays NaN: the leg
      // loop then never runs and the route comes back 200 with no legs, no
      // worst point, and `unread: 0` actively claiming nothing was missed. A
      // wrong answer under a success code is worse than a refusal.
      const legsRaw = body.max_legs ?? body.legs ?? searchParams.get("max_legs") ?? searchParams.get("legs") ?? 8;
      if (!Number.isFinite(Number(legsRaw))) throw new RangeError("legs must be a number between 2 and 12");
      const max = Math.min(12, Math.max(2, Number(legsRaw)));

      // Only now spend a token. Everything above is free: it reads the request
      // and refuses what is malformed. Taking the token first let a stream of
      // junk requests drain the budget that protects the scored endpoint,
      // without a single upstream call being made on their behalf.
      if (!routeBudget.take()) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
        return res.end(JSON.stringify({
          error: "too many route requests this minute — the upstream quota is shared with /forecast, " +
            "which the network scores. Try again shortly, or ask about one point at a time.",
        }));
      }

      // Geocoding is the first thing that costs an upstream call, so it sits
      // below the budget, not above it.
      const from = await endpointOf(body.from ?? searchParams.get("from"), "from");
      const to = await endpointOf(body.to ?? searchParams.get("to"), "to");

      return send(res, 200, await assessRoute({
        from, to, speedKmh, max,
        read: ({ lat, lon, hours }) => forecast({ lat, lon, hours }),
      }));
    }

    send(res, 404, { error: "not found", endpoints: ["/forecast", "/api/route", "/api/backtest", "/api/board", "/api/survey", "/api/jobable", "/api/asked", "/openapi.json", "/llms.txt", "/health"] });
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
