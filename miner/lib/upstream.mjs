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
    e = { calls: 0, failures: 0, last_ok_at: null, last_fail_at: null, last_error: null, last_ms: null };
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
 * Run a fetch-shaped task and record it. The task's own errors still
 * propagate; this only watches.
 */
export async function watched(name, task) {
  const t0 = performance.now();
  try {
    const out = await task();
    note(name, true, performance.now() - t0);
    return out;
  } catch (e) {
    note(name, false, performance.now() - t0, e);
    throw e;
  }
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
