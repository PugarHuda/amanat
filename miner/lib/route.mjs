// Storm risk along a route, not at a point.
//
// A point forecast is the wrong shape for the decision people actually make.
// A shipment, a flight, a convoy — none of them sit still, and the question is
// not "what is the weather at the port" but "what will this cargo meet on the
// way, and when". A vessel leaving Cebu for Manila is not exposed to Cebu's
// weather; it is exposed to whatever sits over the Sibuyan Sea in eighteen
// hours' time.
//
// So the route is sampled, and each sample is forecast for the hour the vehicle
// actually arrives there. That is the whole idea: the time axis moves with the
// cargo. A route assessed entirely at hour zero is a weather report, not a risk
// assessment.

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in kilometres. */
export function greatCircleKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * EARTH_KM;
}

/**
 * Points along the great circle from `a` to `b`, endpoints included.
 *
 * Interpolating the latitude and longitude linearly is the tempting shortcut
 * and it is wrong: on a sphere that is not the path anything travels, and the
 * error grows with distance and latitude. Cebu to Rotterdam would be sampled
 * across the wrong ocean. This is spherical interpolation, so the samples sit
 * on the route a vessel actually takes.
 *
 * `max` is a cost ceiling as much as a sampling choice — each waypoint is a
 * paid question on the Telegraph rail.
 */
export function waypoints(a, b, { everyKm = 250, max = 12 } = {}) {
  const km = greatCircleKm(a, b);
  const count = Math.max(2, Math.min(max, Math.ceil(km / everyKm) + 1));

  const d = km / EARTH_KM; // angular distance
  // Coincident endpoints have no bearing to interpolate along, and sin(0) below
  // would divide by zero.
  if (d < 1e-9) return [{ ...a, km_from_start: 0 }];

  const φ1 = rad(a.lat), λ1 = rad(a.lon);
  const φ2 = rad(b.lat), λ2 = rad(b.lon);

  const out = [];
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);

    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);

    out.push({
      lat: Number(deg(Math.atan2(z, Math.hypot(x, y))).toFixed(4)),
      lon: Number(deg(Math.atan2(y, x)).toFixed(4)),
      km_from_start: Math.round(km * f),
    });
  }
  return out;
}

/**
 * Assess a route.
 *
 * `read` takes { lat, lon, hours } and returns a forecast — the free rail passes
 * the local forecast function, the paid rail passes one that asks Telegraph, and
 * the routing logic here does not care which. Both callers are real; this is the
 * seam between them, not a hook for a caller that does not exist.
 *
 * A leg beyond the 168-hour forecast horizon is reported as unforecastable
 * rather than clamped to hour 168 and presented as a reading. Clamping would
 * answer a question about next Tuesday with next Monday's weather and say
 * nothing about having done so.
 */
export async function assessRoute({ from, to, speedKmh = 37, everyKm = 250, max = 12, read }) {
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) {
    throw new RangeError("speed_kmh must be a positive number");
  }

  const points = waypoints(from, to, { everyKm, max });
  const totalKm = greatCircleKm(from, to);

  const legs = [];
  for (const point of points) {
    const etaHours = Math.round(point.km_from_start / speedKmh);

    if (etaHours > 168) {
      legs.push({ ...point, eta_hours: etaHours, beyond_horizon: true, risk: null });
      continue;
    }

    try {
      const reading = await read({ lat: point.lat, lon: point.lon, hours: etaHours });
      legs.push({
        ...point,
        eta_hours: etaHours,
        risk: reading.risk,
        condition: reading.condition ?? null,
        temp_c: reading.temp_c,
        wind_kmh: reading.wind_kmh,
        gust_kmh: reading.gust_kmh,
        precip_mm: reading.precip_mm,
        valid_at: reading.valid_at,
        summary: reading.summary,
        signal_hash: reading.signal_hash ?? null,
      });
    } catch (e) {
      // One unreachable waypoint must not discard the rest of the route. It is
      // reported as unread, never as calm — a leg with no reading is exactly
      // the leg you should not assume is safe.
      legs.push({ ...point, eta_hours: etaHours, risk: null, error: e.message });
    }
  }

  const read_legs = legs.filter((l) => typeof l.risk === "number");
  const worst = read_legs.reduce((w, l) => (w === null || l.risk > w.risk ? l : w), null);
  const unread = legs.length - read_legs.length;

  return {
    from,
    to,
    distance_km: Math.round(totalKm),
    speed_kmh: speedKmh,
    duration_hours: Math.round(totalKm / speedKmh),
    legs,
    worst,
    unread,
    // The verdict is about the worst point on the way, because that is what the
    // cargo has to survive. An average would hide the one hour that matters.
    breach: worst ? worst.risk >= 0.75 : false,
    verdict: verdictFor(worst, unread, legs.length),
  };
}

function verdictFor(worst, unread, total) {
  if (!worst) return "No leg of this route could be read. Nothing here is a forecast.";

  const where = `${worst.lat}, ${worst.lon} at hour ${worst.eta_hours}`;
  const caveat = unread ? ` ${unread} of ${total} legs could not be read.` : "";

  if (worst.risk >= 0.75) {
    return `Severe: risk ${worst.risk.toFixed(3)} at ${where}. This crosses the payout threshold — a policy on this route would settle.${caveat}`;
  }
  if (worst.risk >= 0.45) {
    return `Elevated: risk ${worst.risk.toFixed(3)} at ${where}. Worth covering, below the trigger.${caveat}`;
  }
  return `Low: worst leg is ${worst.risk.toFixed(3)} at ${where}.${caveat}`;
}
