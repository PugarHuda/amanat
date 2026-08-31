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

  const reading = JSON.parse(risk.result.content[0].text);
  assert.ok(reading.risk >= 0 && reading.risk <= 1, `risk out of range: ${reading.risk}`);
  assert.equal(reading.trigger, 0.75);
  assert.equal(reading.breach, reading.risk >= 0.75, "breach must agree with the trigger");
  assert.ok(/Cebu/i.test(reading.place), `wrong place: ${reading.place}`);

  const legs = JSON.parse(route.result.content[0].text);
  assert.ok(legs.legs.length >= 2, "a route is at least two legs");
  assert.ok(legs.worst, "a route reports its worst leg");

  const jobable = JSON.parse(audit.result.content[0].text);
  assert.ok(Array.isArray(jobable.closed), "closed[] is a list");
  assert.ok(Array.isArray(jobable.unauditable), "unauditable[] is a list");
  assert.equal(jobable.confirmed_closed, jobable.closed.length, "the count must match the list");
  assert.ok(jobable.scored_intents > 0, "the audit reports how many intents it looked at");
  // The shape changed under this tool once already: `dead` was split into
  // confirmed and unknown, and the tool went on reading the old field and
  // returning undefined. Assert the fields it actually claims to return.
  assert.ok(jobable.jobable_by_intent, "who can receive a job, per intent");

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
