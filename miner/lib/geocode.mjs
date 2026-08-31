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

import { ttlCache } from "./cache.mjs";
import { watched } from "./upstream.mjs";

const GEOCODING = "https://geocoding-api.open-meteo.com/v1/search";

/**
 * Where places are.
 *
 * Six hours, because Cebu does not move. locate() tries up to four candidates
 * per name and a route resolves two ends, so eight lookups can come out of one
 * route request — and the misses are worth caching as hard as the hits, since
 * "Will" and "Storm" are asked about far more often than any real place.
 */
const PLACES = ttlCache({ ttlMs: 6 * 3600_000, max: 600 });

/** How many names are held, for the health report. */
export const placeCacheSize = () => PLACES.size;

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

/**
 * Capitalised runs that are a climate phenomenon rather than the place a
 * question is about.
 *
 * The node's weather intents are fed by a news collector, and a large share of
 * what arrives is a question about El Nino: "Will El Nino disrupt Panama Canal
 * traffic?", "Will France see severe agricultural damage from El Nino?". There
 * is a village called El Nino in Baja California and a town called El Nido in
 * the Philippines, and both resolve — so a sentence whose subject is the Panama
 * Canal was answered about a village in Mexico, with the question restated
 * around it so it read as a confident correct answer. Another miner on the same
 * question answered about El Nido.
 *
 * A phrase, checked before the words are offered separately: dropping "nino" as
 * a word would leave "El" behind, and "El" resolves too. "El Paso" and "El
 * Salvador" are untouched, because only the whole run is matched.
 *
 * ponytail: two phrases, not a climate glossary. These are the ones the feed
 * actually sends; add another when a question is seen losing to it.
 */
const NOT_A_PLACE_PHRASE = new Set(["el niño", "la niña"]);

/** A pair of decimals in the text is already an answer — no lookup needed. */
export function coordinatesIn(text) {
  // The separator is required, not optional. With `[,;]?` any two loose
  // decimals in a sentence became a coordinate pair and beat every place name,
  // so "Will it exceed 30.5 40.5 today?" was answered for the Saudi desert —
  // with the question restated, so it read as a confident correct answer. This
  // module exists to prevent exactly that. The registered schema documents the
  // form as "lat,lon", so a comma or semicolon is what a caller sends.
  const pairs = [...String(text).matchAll(/(-?\d{1,3}\.\d+)\s*[,;]\s*(-?\d{1,3}\.\d+)/g)];
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
  // NFC once, up front. The capitalised-run regex matches letters, and a
  // combining tilde is a mark, not a letter — so a decomposed "Nino" broke the
  // run in the middle and offered "El Nin" as a place name.
  const s = String(text).normalize("NFC");
  const seen = new Set();
  const out = [];
  const add = (c) => {
    const key = c.toLowerCase();
    if (c.length >= 3 && !seen.has(key)) { seen.add(key); out.push(c); }
  };

  // Unicode, not A-Z. An ASCII-only run stops at the first accented letter, so
  // "São Paulo" yielded "Paulo" and was answered about Jalisco, Mexico;
  // "Málaga" yielded "Laga" and was answered about the Congo. Answering
  // confidently about the wrong continent is the failure this miner exists to
  // avoid, and it was reachable by any question naming a place the way most of
  // the world spells it.
  for (const [, run] of s.matchAll(/(?<!\p{L})(\p{Lu}[\p{L}]*(?:[ -]\p{Lu}[\p{L}]*){0,2})/gu)) {
    // A sentence begins with a capital, so "Will Riyadh exceed…" yields the run
    // "Will Riyadh". Trim the words that are not places off both ends and what
    // remains is the place: looking up "Will Riyadh" finds nothing, "Riyadh"
    // finds Saudi Arabia.
    const kept = run.split(/[ -]/);
    while (kept.length && NOT_A_PLACE.has(kept[0].toLowerCase())) kept.shift();
    while (kept.length && NOT_A_PLACE.has(kept[kept.length - 1].toLowerCase())) kept.pop();
    if (!kept.length) continue;
    if (NOT_A_PLACE_PHRASE.has(kept.join(" ").toLowerCase())) continue;

    add(kept.join(" "));
    // And each capitalised word alone: "Cebu Port Terminal" does not resolve,
    // "Cebu" does.
    for (const w of kept) if (!NOT_A_PLACE.has(w.toLowerCase())) add(w);
  }

  // Lower-case names are a last resort and only when nothing capitalised
  // resolved, because "see" in "see heavy rain" is a town in Germany and
  // "evening" is a town in Arkansas. Anything the sentence capitalised is more
  // likely to be the place than anything it did not.
  for (const word of s.split(/[^\p{L}]+/u)) {
    if (/^\p{Lu}/u.test(word)) continue;
    if (!NOT_A_PLACE.has(word.toLowerCase())) add(word);
  }

  // A name straight after a locative preposition outranks one that merely came
  // first in the sentence. "Wie ist das Wetter in Zürich?" offers "Wie" before
  // "Zürich", and "Wie" resolves — to Wiesbaden. The word after "in" is the
  // place being asked about; the sentence-initial capital rarely is.
  const after = new Set();
  // "en", "em", "di" and "à" cost nothing here — each must still be followed by
  // a capitalised word — and they cover the languages a question is most likely
  // to arrive in after English.
  // A lookbehind, not \b: "à" is not an ASCII word character, so \b before it
  // does not mean what it appears to and the French case silently never matched.
  for (const [, name] of s.matchAll(/(?<!\p{L})(?:in|at|for|near|around|over|en|em|di|à)\s+(\p{Lu}[\p{L}]*(?:[ -]\p{Lu}[\p{L}]*){0,2})/gu)) {
    after.add(name.toLowerCase());
    for (const w of name.split(/[ -]/)) after.add(w.toLowerCase());
  }
  if (!after.size) return out;
  return [
    ...out.filter((c) => after.has(c.toLowerCase())),
    ...out.filter((c) => !after.has(c.toLowerCase())),
  ];
}

/** Resolve one name. Returns null when the API knows no such place. */
async function lookup(name) {
  // retryTimeouts: this is the one upstream the answer cannot do without. The
  // weather, marine, ensemble and cyclone calls all degrade to null and the
  // forecast still goes out; a question naming a place that never resolves is a
  // question we refuse. Eight seconds is also the cheapest timeout of the six,
  // so trying twice costs less than any of the others would.
  return PLACES.through(name.toLowerCase(), () => watched("open-meteo-geocoding", async () => {
    const url = `${GEOCODING}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`geocoding ${res.status}`);

    const [hit] = (await res.json()).results ?? [];
    // A miss is cached as hard as a hit. locate() walks up to four candidates
    // per question and most of them are words like "Will" and "Storm" that will
    // never be places — those repeat far more often than any real name does.
    if (!hit) return null;
    return {
      lat: hit.latitude,
      lon: hit.longitude,
      place: [hit.name, hit.admin1, hit.country].filter(Boolean).join(", "),
    };
  }, { retryTimeouts: true }));
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

  // "The geocoder says no such place" and "the geocoder could not be reached"
  // are different answers, and swallowing the second into the first is how a
  // miner tells the network that Manila does not exist. That is a confidently
  // wrong answer on the scored path, and it is the failure the whole module was
  // written to avoid. So the reason is kept: a lookup that threw is an upstream
  // fault, and only an empty result is a genuine miss.
  let upstreamFailed = null;
  for (const candidate of placeCandidates(text).slice(0, 4)) {
    const hit = await lookup(candidate).catch((e) => { upstreamFailed = e; return null; });
    if (hit) return { ...hit, source: "geocoded" };
  }
  if (upstreamFailed) {
    throw new Error(`the geocoding service could not be reached, so this place could not be resolved (${upstreamFailed.message})`);
  }
  return null;
}
