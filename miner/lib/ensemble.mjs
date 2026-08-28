// How sure the forecast is, from the ensemble.
//
// A single risk number hides the thing an underwriter prices: whether the
// model is confident or guessing. ECMWF runs its forecast 51 times from
// slightly different starting states, and Open-Meteo publishes every member.
// Scoring each one with the same thresholds gives a distribution of risk for
// the hour, not a point — and "the risk is 0.48, and 51 runs put it between
// 0.31 and 0.62, 4% of them over the trigger" is a reading a policy can be
// priced on. Free, keyless, one call per point.

import { ttlCache } from "./cache.mjs";
import { riskScore } from "./forecast.mjs";

const ENSEMBLE = "https://ensemble-api.open-meteo.com/v1/ensemble";
const MODEL = "ecmwf_ifs025";

// Same ten minutes as the deterministic series, for the same reason.
const RUNS = ttlCache({ ttlMs: 10 * 60_000, max: 400 });

/** Members of one variable at one index, as a sorted array of numbers. */
function members(hourly, name, i) {
  const out = [];
  for (const k of Object.keys(hourly)) {
    if (k === name || k.startsWith(name + "_member")) {
      const v = hourly[k][i];
      if (Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

/**
 * Risk across the members at one hour. Pure.
 *
 * Sea state and cyclone proximity are not ensembled — one reading each — so
 * they are applied to every member alike, and the spread is the atmosphere's.
 */
export function band(hourly, i, { wave_m = null, cyclone = 0 } = {}) {
  const wind = members(hourly, "wind_speed_10m", i);
  const gust = members(hourly, "wind_gusts_10m", i);
  const rain = members(hourly, "precipitation", i);
  const n = Math.min(wind.length, gust.length, rain.length);
  if (n < 5) return null;

  const risks = [];
  for (let m = 0; m < n; m++) {
    risks.push(riskScore({ wind_kmh: wind[m], gust_kmh: gust[m], precip_mm: rain[m], wave_m, cyclone }));
  }
  risks.sort((a, b) => a - b);
  const q = (p) => risks[Math.min(n - 1, Math.floor(p * n))];
  return {
    model: MODEL,
    members: n,
    p10: q(0.10),
    p50: q(0.50),
    p90: q(0.90),
    // The single worst run — with 51 members the top decile sits below it,
    // and the worst run is the one a policy is written against.
    max: risks[n - 1],
    // The share of runs at or over the trigger: the probability the cover pays,
    // as the model sees it.
    breach_probability: Math.round((risks.filter((r) => r >= 0.75).length / n) * 100) / 100,
  };
}

/** The member series for a point, from the cache or from the ensemble API. */
export async function ensembleSeries({ lat, lon }) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  return RUNS.through(key, async () => {
    const url = `${ENSEMBLE}?latitude=${lat}&longitude=${lon}&models=${MODEL}` +
      `&hourly=wind_speed_10m,wind_gusts_10m,precipitation&forecast_days=8&timezone=UTC`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`open-meteo ensemble ${res.status}`);
    return (await res.json()).hourly ?? {};
  });
}

/** The band for a point at an hour ("YYYY-MM-DDTHH:00"), or null when it cannot be read. */
export async function ensembleBand({ lat, lon, at, wave_m, cyclone }) {
  const hourly = await ensembleSeries({ lat, lon });
  const i = hourly.time?.indexOf(at) ?? -1;
  if (i < 0) return null;
  return band(hourly, i, { wave_m, cyclone });
}
