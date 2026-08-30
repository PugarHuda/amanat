// A bounded cache with a deadline, and nothing else.
//
// The miner answers from Open-Meteo's free tier: 10 000 calls a day, shared by
// every visitor, every route, and every validator scoring this miner. One
// request to /api/route can ask for twelve legs and geocode two endpoints, so
// twenty upstream calls can come out of a single HTTP request — five hundred of
// those exhausts the day. When the quota goes, /forecast goes with it, and
// /forecast is what the network scores. A convenience endpoint must not be able
// to take the miner off the network.
//
// Caching is the honest half of the fix: the same point asked about twice in
// ten minutes has the same answer, so asking twice is waste rather than
// diligence. It does not stop somebody deliberately varying coordinates — see
// the budget in server.mjs for that — but it removes nearly all of the load
// that ordinary use creates.

/**
 * A map that forgets: entries expire, and the oldest go first when it is full.
 *
 * Bounded on purpose. A serverless instance can live for hours across many
 * requests, and an unbounded cache keyed on user-supplied coordinates is a
 * memory leak with a nice name.
 */
export function ttlCache({ ttlMs, max = 500, staleMs = ttlMs * 6 }) {
  // Last known-good value per key, kept past its TTL purely so a failed
  // refresh can be answered from it instead of thrown.
  const good = new Map();
  const entries = new Map(); // insertion-ordered, which is the eviction order

  const live = (e) => e && e.expires > Date.now();

  return {
    get(key) {
      const e = entries.get(key);
      if (!live(e)) {
        entries.delete(key);
        return undefined;
      }
      // Refresh position so a hot key is not evicted for being old.
      entries.delete(key);
      entries.set(key, e);
      return e.value;
    },

    /** Whether a live entry exists, without touching its position. */
    has(key) {
      return live(entries.get(key));
    },

    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + ttlMs });
      while (entries.size > max) entries.delete(entries.keys().next().value);
      return value;
    },

    /**
     * Fetch through the cache, and share one in-flight request.
     *
     * The promise is stored, not the result. Storing the result leaves a window
     * between the miss and the write in which every concurrent caller misses
     * too — a route asking about eight legs at once would send eight identical
     * upstream requests and cache the last one. Storing the promise means the
     * second caller waits for the first caller's request.
     *
     * A rejected promise is evicted, so a failure is not cached as an answer.
     */
    async through(key, produce) {
      const hit = this.get(key);
      if (hit !== undefined) return hit;

      const pending = produce().then((v) => {
        good.set(key, { value: v, at: Date.now() });
        // The stale shelf is bounded the same way the cache is; without this it
        // is a second copy of every key that never expires.
        if (good.size > max) good.delete(good.keys().next().value);
        return v;
      }).catch((err) => {
        // Only evict our own entry. A slow produce that fails after a later
        // caller already stored a good value would otherwise delete that value.
        const e = entries.get(key);
        if (e && e.value === pending) entries.delete(key);
        // A ten-minute-old reading is a better answer than a 502. The network
        // scores what this endpoint returns, and one upstream hiccup should not
        // be recorded as a miner that could not answer. Bounded: past the stale
        // window the error is the honest answer, because old weather is wrong
        // weather.
        const held = good.get(key);
        if (held && Date.now() - held.at <= staleMs) return held.value;
        throw err;
      });
      this.set(key, pending);
      return pending;
    },

    get size() {
      return entries.size;
    },
  };
}


/**
 * A refilling bucket of permissions, per server instance.
 *
 * The route endpoint is the only one that turns a single HTTP request into many
 * upstream calls, so it is the only one that can exhaust the day's quota — and
 * when that goes, /forecast goes with it. /forecast is what the network scores.
 * The caches above absorb ordinary repetition; this is for somebody varying the
 * coordinates on purpose, where a cache is no help at all.
 *
 * Honest about what it is not: serverless runs many instances and this counts
 * within one, so a distributed flood gets through in proportion to how many
 * instances it warms. It raises the cost of the attack rather than removing it,
 * and a shared counter would need a database this miner deliberately does not
 * have. What it does guarantee is that no single client talking to one instance
 * can quietly drain the quota that the scored endpoint depends on.
 *
 * Tokens refill continuously rather than resetting on a window boundary, so a
 * caller who waits is served rather than punished for arriving at :59.
 */
export function bucket({ perMinute }) {
  // `Number("twenty")` is NaN, and `NaN < 1` is false — so a mistyped env var
  // would make every take() succeed and quietly delete the only control
  // protecting the scored endpoint. Fail closed to the default, not open.
  if (!Number.isFinite(perMinute) || perMinute <= 0) perMinute = 20;
  let tokens = perMinute;
  let refilled = Date.now();

  return {
    take() {
      const elapsed = Date.now() - refilled;
      if (elapsed > 0) {
        tokens = Math.min(perMinute, tokens + (elapsed / 60_000) * perMinute);
        refilled = Date.now();
      }
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },

    /** What is left, for a test or a health report. Does not consume. */
    get available() {
      return tokens;
    },
  };
}
