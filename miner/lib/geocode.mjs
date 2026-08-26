// Turn a place named in a sentence into coordinates.
//
// The miner accepted only numeric lat/lon, which made it unanswerable to the way
// the network actually asks. Validators run an epoch tournament that puts the
// same question to every miner on an intent, and those questions are sentences —
// "Will Riyadh exceed 40 degrees in the next 24 hours?" — not coordinate pairs.
// A miner that answers 400 to the tournament scores zero however good its
// forecasts are, which is what happened across three intents.
//
// Open-Meteo's geocoding API is free, keyless and from the same source as the
// forecast, so a name resolved here and a reading taken there agree about where
// they are.

const GEOCODING = "https://geocoding-api.open-meteo.com/v1/search";

/**
 * Words that look like place names but are not, so a question about the weather
 * does not resolve to a town called Storm. Every one of these is a real
 * settlement somewhere, which is exactly why the list is needed.
 */
const NOT_A_PLACE = new Set([
  "will", "what", "is", "the", "in", "at", "on", "for", "of", "and", "or", "a", "an",
  "storm", "rain", "wind", "weather", "forecast", "risk", "temperature", "degrees",
  "hours", "today", "tomorrow", "tonight", "next", "how", "much", "hot", "cold",
  "exceed", "above", "below", "there", "be", "any", "does", "do", "it", "this",
  "expect", "expected", "chance", "likely", "severe", "warning", "alert", "check",
  "current", "currently", "now", "later", "high", "low", "over", "under", "near",
  "celsius", "fahrenheit", "mm", "km", "speed", "gust", "gusts", "precipitation",
]);

/** A pair of decimals in the text is already an answer — no lookup needed. */
export function coordinatesIn(text) {
  const pairs = [...String(text).matchAll(/(-?\d{1,3}\.\d+)\s*[,;]?\s*(-?\d{1,3}\.\d+)/g)];
  for (const [, a, b] of pairs) {
    const lat = Number(a);
    const lon = Number(b);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon };
  }
  return null;
}

/**
 * The candidate place names in a sentence, best first.
 *
 * Capitalised runs are tried before bare words: "Riyadh" in "Will Riyadh exceed"
 * is capitalised and "exceed" is not, and that distinction does most of the work
 * without a parser.
 */
export function placeCandidates(text) {
  const s = String(text);
  const seen = new Set();
  const out = [];
  const add = (c) => {
    const key = c.toLowerCase();
    if (c.length >= 3 && !seen.has(key)) { seen.add(key); out.push(c); }
  };

  for (const [, run] of s.matchAll(/\b([A-Z][a-zA-Z]+(?:[ -][A-Z][a-zA-Z]+){0,2})/g)) {
    // A sentence begins with a capital, so "Will Riyadh exceed…" yields the run
    // "Will Riyadh". Trim the words that are not places off both ends and what
    // remains is the place: looking up "Will Riyadh" finds nothing, "Riyadh"
    // finds Saudi Arabia.
    const kept = run.split(/[ -]/);
    while (kept.length && NOT_A_PLACE.has(kept[0].toLowerCase())) kept.shift();
    while (kept.length && NOT_A_PLACE.has(kept[kept.length - 1].toLowerCase())) kept.pop();
    if (!kept.length) continue;

    add(kept.join(" "));
    // And each capitalised word alone: "Cebu Port Terminal" does not resolve,
    // "Cebu" does.
    for (const w of kept) if (!NOT_A_PLACE.has(w.toLowerCase())) add(w);
  }

  // Lower-case names are a last resort and only when nothing capitalised
  // resolved, because "see" in "see heavy rain" is a town in Germany and
  // "evening" is a town in Arkansas. Anything the sentence capitalised is more
  // likely to be the place than anything it did not.
  for (const word of s.split(/[^A-Za-z]+/)) {
    if (/^[A-Z]/.test(word)) continue;
    if (!NOT_A_PLACE.has(word.toLowerCase())) add(word);
  }
  return out;
}

/** Resolve one name. Returns null when the API knows no such place. */
export async function lookup(name) {
  const url = `${GEOCODING}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`geocoding ${res.status}`);

  const [hit] = (await res.json()).results ?? [];
  if (!hit) return null;
  return {
    lat: hit.latitude,
    lon: hit.longitude,
    place: [hit.name, hit.admin1, hit.country].filter(Boolean).join(", "),
  };
}

/**
 * Find where a question is about.
 *
 * Coordinates in the text win outright — they are unambiguous and cost nothing.
 * Otherwise each candidate name is looked up in order and the first that
 * resolves is used. Returns null when nothing in the sentence names a place,
 * which the caller must treat as a question it cannot answer rather than
 * guessing at a location.
 */
export async function locate(text) {
  const direct = coordinatesIn(text);
  if (direct) {
    // Two decimals, the same as the sentence built from bare lat/lon. The same
    // point asked for two ways has to read back one way, or the answer looks
    // like it came from somewhere else.
    return {
      ...direct,
      place: `${direct.lat.toFixed(2)}, ${direct.lon.toFixed(2)}`,
      source: "coordinates",
    };
  }

  for (const candidate of placeCandidates(text).slice(0, 4)) {
    const hit = await lookup(candidate).catch(() => null);
    if (hit) return { ...hit, source: "geocoded" };
  }
  return null;
}
