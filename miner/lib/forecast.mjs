// The miner's logic, with no transport attached.
//
// Vercel treats every .mjs at the deploy root as a function entry point, so a
// module that exports helpers rather than a handler crashes the whole
// deployment with "Invalid export found". Keeping the logic here means the HTTP
// server and the serverless handlers are two thin entry points over one
// implementation, instead of two implementations.

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
