// The miner's logic, with no transport attached.
//
// Vercel treats every .mjs at the deploy root as a function entry point, so a
// module that exports helpers rather than a handler crashes the whole
// deployment with "Invalid export found". Keeping the logic here means the HTTP
// server and the serverless handlers are two thin entry points over one
// implementation, instead of two implementations.

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

/**
 * WMO 4677 present-weather codes, the vocabulary Open-Meteo reports conditions
 * in. Naming the condition is what a person asking about the weather actually
 * wants first, and it is the part a numeric-only answer was missing: "31.1 °C
 * with 0.2 mm precipitation" and "Drizzle" describe the same hour, but only one
 * of them answers the question as it was asked.
 */
const WMO = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snowfall", 73: "Snowfall", 75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers", 81: "Rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

/** The condition a WMO code names, or null when the code is one we do not know. */
export function condition(code) {
  return WMO[code] ?? null;
}

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

export function summarise({ lat, lon, place, temp_c, wind_kmh, precip_mm, gust_kmh, risk, valid_at, condition: cond, temp_min_c, temp_max_c }) {
  const level = risk >= 0.75 ? "severe" : risk >= 0.45 ? "elevated" : "low";

  // Lead with the day, the condition and the range — the shape of an answer to
  // "what is the weather", before the detail a contract settles on.
  const day = String(valid_at).slice(0, 10);
  const range = Number.isFinite(temp_min_c) && Number.isFinite(temp_max_c)
    ? `, ${temp_min_c.toFixed(1)}-${temp_max_c.toFixed(1)} °C`
    : "";
  const lead = cond ? `${day}: ${cond}${range}. ` : "";
  // Name the place when the caller named one. A question about Riyadh answered
  // with "24.69, 46.72" is correct and reads as an answer to something else.
  const where = place ?? `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  return (
    lead +
    `At ${valid_at} the forecast for ${where} is ` +
    `${temp_c.toFixed(1)} °C with wind ${wind_kmh.toFixed(1)} km/h, ` +
    `gusts ${gust_kmh.toFixed(1)} km/h and ${precip_mm.toFixed(1)} mm precipitation. ` +
    `Storm risk is ${level} (${risk.toFixed(3)}).`
  );
}

/**
 * The forecast offset a question asks for, in hours.
 *
 * "…in the next six hours" wants hour 6, not hour 0. Reading it off the
 * question is the difference between answering what was asked and answering
 * something adjacent to it, and the tournament grades on the former.
 */
const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, twenty: 20,
  twentyfour: 24, "twenty-four": 24, thirtysix: 36, "thirty-six": 36,
  fortyeight: 48, "forty-eight": 48, seventytwo: 72, "seventy-two": 72,
};

export function hoursIn(text) {
  const s = String(text ?? "").toLowerCase();

  const digits = s.match(/(\d{1,3})\s*(?:h\b|hour)/);
  if (digits) return clampHours(Number(digits[1]));

  const worded = s.match(/\b([a-z]+(?:-[a-z]+)?)\s+hours?\b/);
  if (worded && worded[1] in WORD_NUMBERS) return clampHours(WORD_NUMBERS[worded[1]]);

  if (/\bday after tomorrow\b/.test(s)) return 48;
  if (/\btomorrow\b/.test(s)) return 24;
  if (/\btonight\b|\bthis evening\b/.test(s)) return 6;
  if (/\bnext week\b/.test(s)) return 168;
  return 0;
}

function clampHours(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(168, Math.round(n)));
}

export async function forecast({ lat, lon, hours = 0, place }) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError("lat must be between -90 and 90");
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new RangeError("lon must be between -180 and 180");
  if (!Number.isInteger(hours) || hours < 0 || hours > 168) throw new RangeError("hours must be an integer 0..168");

  const url = `${OPEN_METEO}?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min&forecast_days=8&timezone=UTC`;
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
  const code = d.hourly.weather_code?.[i];
  const cond = condition(code);

  // The daily range is indexed by day, not by hour, so it has to be looked up
  // by the date the chosen hour falls on rather than by position.
  const day = at.slice(0, 10);
  const dayIdx = d.daily?.time?.indexOf(day) ?? -1;
  const temp_max_c = dayIdx >= 0 ? d.daily.temperature_2m_max[dayIdx] : undefined;
  const temp_min_c = dayIdx >= 0 ? d.daily.temperature_2m_min[dayIdx] : undefined;

  return {
    summary: summarise({
      lat, lon, place, temp_c, wind_kmh, precip_mm, gust_kmh, risk,
      valid_at: at + "Z", condition: cond, temp_min_c, temp_max_c,
    }),
    condition: cond,
    weather_code: code ?? null,
    temp_min_c: temp_min_c ?? null,
    temp_max_c: temp_max_c ?? null,
    place: place ?? null,
    lat, lon, hours,
    temp_c, wind_kmh, gust_kmh, precip_mm,
    risk,
    breach: risk >= 0.75,
    valid_at: at + "Z",
    source: "open-meteo",
  };
}
