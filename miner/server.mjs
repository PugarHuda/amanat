// Amanat — Telegraph miner (Track 1).
//
// Wraps Open-Meteo (free, no API key) and returns a weather answer in two
// shapes at once:
//
//   summary   one plain sentence, because Telegraph's scoring modules compare
//             TEXT. A miner that answers with bare JSON scores near zero today
//             (rank 1 on WEATHER_CHECK scored 0.0206 in epoch 240).
//   fields    scalars a smart contract can act on, mapped through the YAML's
//             on_chain.fields block so an ERC-8183 job can settle against them.
//
// Serving both is the point of this miner: the same answer has to be legible to
// a text scorer and to a contract, or the on-chain rail cannot use it.
//
//   node miner/server.mjs            # listens on $PORT (default 8787)
//   node miner/test.mjs              # self-check

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT ?? 8787);
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

/** Storm risk in [0,1] from wind, gust and precipitation. */
export function riskScore({ wind_kmh, gust_kmh, precip_mm }) {
  // ponytail: linear ramps against thresholds a reinsurer would recognise
  // (Beaufort 8 = 62 km/h, 30 mm/h is a severe-rain warning in most services).
  // Deliberately not a model — the point is a number a contract can compare.
  const w = Math.min(wind_kmh / 62, 1);
  const g = Math.min(gust_kmh / 90, 1);
  const p = Math.min(precip_mm / 30, 1);
  return Math.round(Math.max(w, g, p) * 1000) / 1000;
}

export function summarise({ lat, lon, temp_c, wind_kmh, precip_mm, gust_kmh, risk, valid_at }) {
  const level = risk >= 0.75 ? "severe" : risk >= 0.45 ? "elevated" : "low";
  return (
    `At ${valid_at} the forecast for ${lat.toFixed(2)}, ${lon.toFixed(2)} is ` +
    `${temp_c.toFixed(1)} °C with wind ${wind_kmh.toFixed(1)} km/h, ` +
    `gusts ${gust_kmh.toFixed(1)} km/h and ${precip_mm.toFixed(1)} mm precipitation. ` +
    `Storm risk is ${level} (${risk.toFixed(3)}).`
  );
}

export async function forecast({ lat, lon, hours = 0 }) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError("lat must be between -90 and 90");
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new RangeError("lon must be between -180 and 180");
  if (!Number.isInteger(hours) || hours < 0 || hours > 168) throw new RangeError("hours must be an integer 0..168");

  const url = `${OPEN_METEO}?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation&forecast_days=8&timezone=UTC`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const d = await res.json();

  // Open-Meteo indexes hourly from 00:00 UTC today, so `hours` has to be
  // measured from the current hour, not from the start of the array.
  const nowHour = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  const base = d.hourly?.time?.findIndex((t) => t.slice(0, 13) === nowHour);
  if (base === undefined || base < 0) throw new Error("open-meteo returned no hour matching now");

  const i = base + hours;
  const at = d.hourly.time[i];
  if (at === undefined) throw new Error("open-meteo returned no hour at that offset");

  const temp_c = d.hourly.temperature_2m[i];
  const wind_kmh = d.hourly.wind_speed_10m[i];
  const gust_kmh = d.hourly.wind_gusts_10m[i];
  const precip_mm = d.hourly.precipitation[i];
  const risk = riskScore({ wind_kmh, gust_kmh, precip_mm });

  return {
    summary: summarise({ lat, lon, temp_c, wind_kmh, precip_mm, gust_kmh, risk, valid_at: at + "Z" }),
    temp_c, wind_kmh, gust_kmh, precip_mm,
    risk,
    breach: risk >= 0.75,
    valid_at: at + "Z",
    source: "open-meteo",
  };
}

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

    if (pathname === "/health") return send(res, 200, { status: "ok", miner: "amanat", time: new Date().toISOString() });

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => console.log(`amanat miner on :${PORT}`));
}
