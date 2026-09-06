// Drive the MCP server the way a client does: newline-delimited JSON-RPC over
// stdio, in order, and check what comes back.
//
//   node mcp/test.mjs
//
// Real calls to the live miner, like every other test in this repo. The point of
// an MCP server is that somebody else's agent can rely on it, and a mocked
// transport would not have caught the thing this actually caught: a response to
// a notification, which is a protocol error.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));

/** Send every frame, collect every reply, and return them ordered by id. */
function session(frames, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
    const seen = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no answer within ${timeoutMs}ms after ${seen.length} replies`));
    }, timeoutMs);

    const wanted = frames.filter((f) => f.id !== undefined).length;
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      seen.push(JSON.parse(line));
      if (seen.length >= wanted) {
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        // By id, not by arrival. The calls run concurrently and a cached place
        // answers before a cold one, so reading them positionally paired the
        // route's reply with the reading's assertions.
        resolve(seen.slice().sort((a, b) => Number(a.id) - Number(b.id)));
      }
    });

    child.on("error", reject);
    for (const f of frames) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...f }) + "\n");
  });
}

const call = (id, name, args = {}) => ({ id, method: "tools/call", params: { name, arguments: args } });

// ── handshake, listing, and the notification that must stay silent ──────────
{
  const out = await session([
    { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
  ]);

  assert.equal(out.length, 2, "a notification must not be answered");
  const [init, list] = out;
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, "amanat");
  assert.ok(init.result.capabilities.tools, "tools capability must be declared");

  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["backtest", "route_risk", "storm_risk", "telegraph_onchain_jobable"]);
  for (const t of list.result.tools) {
    assert.ok(t.description.length > 40, `${t.name} needs a description a model can route on`);
    assert.equal(t.inputSchema.type, "object", `${t.name} needs an object schema`);
  }
}
console.log("mcp: handshake, tool list, and a notification answered with silence");

// ── the tools, against the live miner ───────────────────────────────────────
{
  const [risk, route, audit, refusal] = await session([
    call(1, "storm_risk", { place: "Cebu" }),
    call(2, "route_risk", { from: "Cebu", to: "Manila", legs: 2 }),
    call(3, "telegraph_onchain_jobable"),
    call(4, "storm_risk", { place: "a sentence with no place in it at all" }),
  ]);

  // A 5xx from Open-Meteo is not a fault in this server, and the suite says so
  // rather than going red on it — the same stance playwright.config.mjs takes:
  // what is tolerated is the third party, not the miner. Anything else that
  // arrives as an error still fails, because that would be ours.
  //
  // `timeout` as well as `timed out`: Node's own AbortSignal.timeout says "The
  // operation was aborted due to timeout", which this pattern did not match. The
  // result was worse than a red build — the reading below was parsed as JSON and
  // the suite died on a SyntaxError naming neither the tool nor the upstream.
  const text = (r) => r.result?.content?.[0]?.text ?? "";
  const upstreamDown = (r) =>
    r.result?.isError === true && /[45]\d\d|timed out|timeout|aborted|fetch failed|upstream/i.test(text(r));

  // An isError result is never a reading, so it must never reach JSON.parse.
  // One that is not an upstream refusal is ours, and says so with the text.
  const readingOf = (r, what) => {
    if (r.result?.isError) assert.fail(`${what} came back as an error: ${text(r)}`);
    return JSON.parse(text(r));
  };

  if (upstreamDown(risk)) {
    console.log(`mcp: skipped the reading — upstream is down (${risk.result.content[0].text.slice(0, 60)})`);
  } else {
    const reading = readingOf(risk, "storm_risk");
    assert.ok(reading.risk >= 0 && reading.risk <= 1, `risk out of range: ${reading.risk}`);
    assert.equal(reading.trigger, 0.75);
    assert.equal(reading.breach, reading.risk >= 0.75, "breach must agree with the trigger");
    assert.ok(/Cebu/i.test(reading.place), `wrong place: ${reading.place}`);
  }

  if (upstreamDown(route)) {
    console.log("mcp: skipped the route — upstream is down");
  } else {
    const legs = readingOf(route, "route_risk");
    assert.ok(legs.legs.length >= 2, "a route is at least two legs");
    // `worst` is null when no leg could be read, which is what an upstream
    // outage looks like through a 200. The invariant is not "there is always a
    // worst leg" — it is that a missing one is explained by a leg that has no
    // risk, rather than quietly dropped.
    const unread = legs.legs.filter((l) => typeof l.risk !== "number").length;
    if (legs.worst) {
      assert.ok(legs.worst.risk >= 0 && legs.worst.risk <= 1, `worst out of range: ${legs.worst.risk}`);
    } else {
      assert.ok(unread > 0, "a route with no worst leg must say which legs it could not read");
      console.log(`mcp: route had no worst leg — ${unread} of ${legs.legs.length} legs unread upstream`);
    }
  }

  const jobable = readingOf(audit, "telegraph_onchain_jobable");
  assert.ok(Array.isArray(jobable.closed), "closed[] is a list");
  assert.ok(Array.isArray(jobable.unauditable), "unauditable[] is a list");
  assert.equal(jobable.confirmed_closed, jobable.closed.length, "the count must match the list");
  assert.ok(jobable.scored_intents > 0, "the audit reports how many intents it looked at");
  // The shape changed under this tool once already: `dead` was split into
  // confirmed and unknown, and the tool went on reading the old field and
  // returning undefined. Assert the fields it actually claims to return.
  assert.ok(jobable.jobable_by_intent, "who can receive a job, per intent");
  // Summarising only the closures is what let the prose around this audit say
  // three times that every auditable leader was closed — nothing in the payload
  // could contradict it. An agent reading this tool would conclude the same, so
  // the open ones and the ones with no leader are counted here too.
  assert.equal(typeof jobable.open, "number", "open leaders are counted, not just closed ones");
  assert.equal(typeof jobable.no_leader_in_this_read, "number", "intents whose leader we did not see are counted");
  assert.equal(jobable.open, jobable.openable.length, "the open count must match the list");

  // A miner refusal has to arrive as a tool error the model can read and act
  // on, not as a dead session.
  assert.equal(refusal.result.isError, true, "a refusal is an isError result");
  assert.ok(/no place/i.test(refusal.result.content[0].text), refusal.result.content[0].text);
  assert.equal(refusal.error, undefined, "a refusal is not a JSON-RPC error");
}
console.log("mcp: four tools answer from the live miner, and a refusal stays a result");

// ── an unknown tool is a protocol error, not a crash ────────────────────────
{
  const [out] = await session([call(1, "does_not_exist")]);
  assert.equal(out.error.code, -32602, JSON.stringify(out));
}
console.log("mcp: an unknown tool is refused by name");

// ── one intent, not the whole audit ─────────────────────────────────────────
// The full audit is tens of kilobytes; a caller deciding whether to put their
// contract on the rail has one question. The trap the HTTP endpoint already
// walked into is answering `false` for an intent nobody can check.
{
  const [, verdict] = await session([
    call(1, "storm_risk", { place: "0,0" }),
    call(2, "telegraph_onchain_jobable", { intent: "storm_alert" }),
  ]);
  const v = JSON.parse(verdict.result.content[0].text);
  assert.equal(v.intent, "STORM_ALERT", "the intent is normalised, so a lowercase argument works");
  assert.ok(["closed", "open", "unknown", "no_leader_in_this_read", "not_scored"].includes(v.state), v.state);
  if (v.state === "unknown" || v.state === "no_leader_in_this_read" || v.state === "not_scored") {
    assert.equal(v.can_receive_a_job, null, "an intent nobody can check is null, never false");
  } else {
    assert.equal(v.can_receive_a_job, v.state === "open");
  }
  assert.ok(Array.isArray(v.jobable_miners), "who could receive one anyway");
}
console.log("mcp: one intent's verdict, and 'cannot check' never reads as 'no'");
