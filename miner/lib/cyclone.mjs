// Named tropical cyclones, from GDACS.
//
// A wind-speed ramp knows a point is windy. It does not know that the wind is
// the outer band of a named storm whose centre is 200 km away and closing, and
// that is the single fact a parametric cover most wants: reinsurers write
// "cat-in-a-box" cover on exactly this — the storm centre passing within a
// radius at or above an intensity. The Global Disaster Alert and Coordination
// System publishes every active tropical cyclone worldwide, with its current
// position and maximum wind, free and without a key. NOAA's NHC feed is the
// better-known one and covers only the Atlantic and eastern Pacific; the lanes
// on the board are in the western Pacific.

import { ttlCache } from "./cache.mjs";
import { greatCircleKm } from "./route.mjs";
import { watched } from "./upstream.mjs";

const GDACS = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventtypes=TC&alertlevel=Green;Orange;Red";

// Half an hour. Advisories are issued every six hours and the position moves
// tens of kilometres between them; a finer cache buys nothing and a coarser
// one can hold a storm where it was a quarter of a day ago.
const ACTIVE = ttlCache({ ttlMs: 30 * 60_000, max: 1 });

/** A cyclone counts as near a point inside this radius. */
export const NEAR_KM = 500;

/**
 * The GDACS feature list, reduced to what a reading needs.
 *
 * `iscurrent` is GDACS's own word for an event still being tracked; the search
 * also returns storms that dissipated recently, and a dead storm 100 km away is
 * not a risk.
 */
export function parse(featureCollection) {
  const out = [];
  for (const f of featureCollection?.features ?? []) {
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry?.coordinates ?? [];

    // The search endpoint ignores its own `eventtypes` filter: asked for TC it
    // returns wildfires, earthquakes and floods alongside. The first live run
    // reported "Tropical cyclone  (6069 km/h)" 314 km from Jakarta — a forest
    // fire of 6069 hectares — and raised the storm risk on the strength of it.
    // The type is checked per feature, and so is the unit of the severity.
    if (p.eventtype !== "TC") continue;
    // `iscurrent` arrives as the string "true" or "false", and a string "false"
    // is truthy. Compared as text, or a dissipated storm stays on the map.
    if (String(p.iscurrent) !== "true") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const sev = p.severitydata ?? {};
    const wind = sev.severityunit === "km/h" ? Number(sev.severity) : NaN;
    out.push({
      name: String(p.eventname || p.name || `TC-${p.eventid ?? "?"}`),
      alert: String(p.alertlevel ?? "Green"),
      max_wind_kmh: Number.isFinite(wind) ? Math.round(wind) : null,
      lat, lon,
      as_of: p.todate ? `${p.todate}Z` : null,
      report: p.url?.report ?? null,
    });
  }
  return out;
}

/** Every active cyclone, from the cache or from GDACS. */
export async function activeCyclones() {
  return ACTIVE.through("tc", () => watched("gdacs", async () => {
    const res = await fetch(GDACS, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`gdacs ${res.status}`);
    return parse(await res.json());
  }));
}

/**
 * The closest active cyclone to a point, with its distance, or null when none
 * is within NEAR_KM.
 *
 * The position is where the storm is now, not where it will be at the hour
 * being forecast — GDACS does not publish a track in this feed, and pretending
 * to extrapolate one would be a guess dressed as a reading. The field is named
 * `cyclone_km_now` in the response for that reason.
 */
export function nearest(cyclones, point) {
  let best = null;
  for (const c of cyclones) {
    const km = greatCircleKm(point, c);
    if (km <= NEAR_KM && (best === null || km < best.distance_km)) {
      best = { ...c, distance_km: Math.round(km) };
    }
  }
  return best;
}

/**
 * How much a nearby cyclone contributes to storm risk, in [0, 1].
 *
 * Intensity scaled against 118 km/h — the typhoon / hurricane threshold, the
 * line most parametric triggers are written at — then discounted linearly with
 * distance out to NEAR_KM. A typhoon overhead is 1; a tropical storm at 74 km/h
 * 250 km away is 0.31. Pure function so it can be pinned in a test.
 */
export function cycloneRisk(near) {
  if (!near) return 0;
  const intensity = Math.min((near.max_wind_kmh ?? 0) / 118, 1);
  const proximity = Math.max(0, 1 - near.distance_km / NEAR_KM);
  return Math.round(intensity * proximity * 1000) / 1000;
}
