// What each upstream last did, for /health.
//
// The miner leans on six free services — Open-Meteo's weather, marine,
// ensemble, archive and geocoding models, and GDACS — and a health report
// that says "ok" while one of them has been returning 503 for an hour is not
// a health report. Every fetch to any of them records its outcome here: the
// last success, the last failure and its message, a rolling count. /health
// prints the ledger and turns "degraded" when the weather model, the one the
// network scores, failed more recently than it succeeded.
//
// Per instance, in memory. A serverless host keeps one ledger per warm
// instance, which is the right scope: the question is whether *this* miner
// can answer now.

const LEDGER = new Map();

function entry(name) {
  let e = LEDGER.get(name);
  if (!e) {
    e = { calls: 0, failures: 0, retries: 0, last_ok_at: null, last_fail_at: null, last_error: null, last_ms: null };
    LEDGER.set(name, e);
  }
  return e;
}

/** Record one call. `ok` is whether it returned usable data. */
export function note(name, ok, ms, error) {
  const e = entry(name);
  e.calls++;
  e.last_ms = Math.round(ms);
  if (ok) {
    e.last_ok_at = new Date().toISOString();
  } else {
    e.failures++;
    e.last_fail_at = new Date().toISOString();
    e.last_error = String(error?.message ?? error ?? "failed").slice(0, 160);
  }
}

/**
 * Run a fetch-shaped task, retry it once, and record the outcome.
 *
 * Every upstream call goes through here, so this is the one place a transient
 * failure can be absorbed for all six of them. It is worth absorbing: these are
 * free public services with per-IP quotas, a 429 or a 5xx from one of them
 * currently becomes a 502 on `/forecast`, and the network records that as a
 * miner which could not answer. CI proved the same thing from the other side —
 * the suite hammers Open-Meteo from a shared GitHub runner IP and the question
 * tests failed intermittently on exactly this.
 *
 * One retry, not a loop: the requests are idempotent GETs so repeating is safe,
 * but the failure mode being guarded against is often a rate limit, and
 * hammering a service that just asked us to slow down earns a longer block. The
 * pause is short enough to stay inside the caller's own timeout budget.
 */
export async function watched(name, task, { retries = 1, pauseMs = 500, retryTimeouts = false } = {}) {
  const t0 = performance.now();
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      entry(name).retries++;
      await new Promise((r) => setTimeout(r, pauseMs));
    }
    try {
      const out = await task();
      note(name, true, performance.now() - t0);
      return out;
    } catch (e) {
      last = e;
      // Never retry a timeout. The caller's own AbortSignal.timeout has already
      // spent its whole budget waiting, so a second attempt doubles the delay
      // to reach the same answer — and the retry is meant to cost a few hundred
      // milliseconds, not another fifteen seconds. This was measured: retrying
      // the marine and ensemble calls at the boundary coordinates pushed that
      // end-to-end test past its limit. A quick refusal (429, 5xx) is the case
      // worth repeating; a service too slow to answer is not.
      // ... unless the caller says this one is worth waiting for twice. That is
      // a judgement about what the failure costs, not about the error. The
      // secondary upstreams each have a `.catch()` and the answer degrades
      // without them, so a second 15- or 20-second wait buys a nicety. Geocoding
      // is load-bearing: without it a question naming a place cannot be answered
      // at all, and its timeout is 8 seconds, so the retry is affordable.
      if (!retryTimeouts && (e?.name === "TimeoutError" || e?.name === "AbortError")) break;
    }
  }
  note(name, false, performance.now() - t0, last);
  throw last;
}

/** The ledger as /health prints it, plus whether the scored path is healthy. */
export function report() {
  const upstreams = {};
  for (const [name, e] of LEDGER) upstreams[name] = { ...e };
  const weather = LEDGER.get("open-meteo");
  // Degraded means the last thing the weather model did was fail. Before any
  // call at all there is nothing to report against, and that is "ok": the
  // node's liveness check runs before the first forecast on a cold instance.
  const degraded = Boolean(weather && weather.last_fail_at && (!weather.last_ok_at || weather.last_fail_at > weather.last_ok_at));
  return { upstreams, degraded };
}
