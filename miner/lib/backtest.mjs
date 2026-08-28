// Would this cover have paid? Run the risk score over what actually happened.
//
// The same thresholds the live forecast uses, applied hour by hour to
// Open-Meteo's reanalysis archive for a point and a date range. A parametric
// trigger is only worth anything if it fires on the storms that mattered and
// stays quiet on the ones that did not, and the archive is where that can be
// checked without waiting for the next typhoon: Rai (Odette) crossed Cebu on
// 16 December 2021 with 170 km/h gusts, and the same day Manila saw 51.
//
// Free, keyless, ~5 days behind real time.

import { ttlCache } from "./cache.mjs";
import { riskScore } from "./forecast.mjs";

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";

// A day: the archive does not change once written.
const RUNS = ttlCache({ ttlMs: 24 * 60 * 60_000, max: 200 });

/** At most this many days per run — a month is 744 hours, enough for any storm. */
export const MAX_DAYS = 31;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a range: ISO dates, in order, within MAX_DAYS, and old enough for
 * the archive to have it. Throws RangeError with the reason.
 */
export function range(start, end) {
  if (!DATE.test(String(start)) || !DATE.test(String(end))) throw new RangeError("start and end must be YYYY-MM-DD");
  const s = Date.parse(start + "T00:00:00Z");
  const e = Date.parse(end + "T00:00:00Z");
  if (!Number.isFinite(s) || !Number.isFinite(e)) throw new RangeError("start and end must be real dates");
  if (e < s) throw new RangeError("end must not be before start");
  const days = (e - s) / 86_400_000 + 1;
  if (days > MAX_DAYS) throw new RangeError(`at most ${MAX_DAYS} days per run`);
  // The archive trails real time by about five days; asking for yesterday
  // returns nulls, which would read as a calm day.
  if (e > Date.now() - 6 * 86_400_000) throw new RangeError("end must be at least six days ago — the archive trails real time");
  return { start, end, days };
}

/**
 * Risk per hour from an archive series, and the hour that mattered.
 * Pure, so the shape of the answer can be pinned without the network.
 */
export function assess(hourly) {
  const series = [];
  let peak = null;
  let above = 0;
  for (let i = 0; i < (hourly.time?.length ?? 0); i++) {
    const wind_kmh = hourly.wind_speed_10m[i];
    const gust_kmh = hourly.wind_gusts_10m[i];
    const precip_mm = hourly.precipitation[i];
    // A null hour is an hour the archive does not have. It is left out rather
    // than read as zero wind, which would be a calm hour that never happened.
    if (![wind_kmh, gust_kmh, precip_mm].every(Number.isFinite)) continue;
    const risk = riskScore({ wind_kmh, gust_kmh, precip_mm });
    const at = hourly.time[i] + "Z";
    series.push({ at, risk });
    if (risk >= 0.75) above++;
    if (peak === null || risk > peak.risk) peak = { at, risk, wind_kmh, gust_kmh, precip_mm };
  }
  return { hours: series.length, peak, breach: peak !== null && peak.risk >= 0.75, hours_above_trigger: above, series };
}

export async function backtest({ lat, lon, start, end }) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError("lat must be between -90 and 90");
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new RangeError("lon must be between -180 and 180");
  const r = range(start, end);

  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${r.start},${r.end}`;
  const hourly = await RUNS.through(key, async () => {
    const url = `${ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${r.start}&end_date=${r.end}` +
      `&hourly=wind_speed_10m,wind_gusts_10m,precipitation&timezone=UTC`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`open-meteo archive ${res.status}`);
    return (await res.json()).hourly ?? {};
  });

  return { lat, lon, start: r.start, end: r.end, trigger: 0.75, ...assess(hourly), source: "open-meteo archive (ERA5)" };
}
