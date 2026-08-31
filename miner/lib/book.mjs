// Read the contract's real state for the page, over plain JSON-RPC.
//
// The miner has no dependencies and keeps none, so the ABI decoding is here.
// `policies(uint256)` returns two dynamic strings among six static words, which
// is the only part that needs care: the head holds offsets, not values.
//
// Nothing on the page is typed in by hand. If the ledger shows a policy, the
// chain said so.

const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";
const AMANAT = process.env.AMANAT_CONTRACT ?? "0x4A5ECEBdd8E011C50bE20C8C49988cf0d37B9893";
const DIAMOND = process.env.TELEGRAPH_DIAMOND ?? "0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8";

// First four bytes of keccak256 over each signature.
const NEXT_POLICY_ID = "0xcad0b8db";
const POLICIES = "0xd3e89483";
const ESCROW_BALANCE = "0x55af6353";

const STATUS = ["None", "Active", "Claimed", "Declined", "Expired"];

// keccak256("Declined(uint256,string)"). The reason a check came back unusable
// lives in this event and nowhere in storage, so a policy that has been answered
// and refused looks identical on chain to one nobody has asked about yet.
const DECLINED_TOPIC = "0x066a1d0911cda14ea4cd3220c4d7100f3e30816fc3ec06ab5aa6a05c78b346c1";

// ponytail: 50 000 blocks, because that is the cap this RPC enforces on
// eth_getLogs and paging back further is a loop with a rate limit in it. At two
// seconds a block that is about 28 hours — long enough for the reason a recent
// check failed, and a policy older than that simply shows no note.
const LOG_WINDOW = 49_999;

/**
 * One or many `eth_call`s in a single request.
 *
 * JSON-RPC batching is in the spec and every public endpoint supports it, so a
 * page showing eleven policies costs one round trip rather than eleven. Sending
 * them one at a time was both slow and a good way to get rate-limited by a free
 * endpoint.
 *
 * Returns results positionally, with `null` where that individual call failed —
 * a batch is not all-or-nothing, and pretending otherwise loses ten good answers
 * to one bad one.
 */
async function callMany(calls) {
  if (!calls.length) return [];
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({
      jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"],
    }))),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);

  const body = await res.json();
  const list = Array.isArray(body) ? body : [body];
  const out = new Array(calls.length).fill(null);
  for (const entry of list) {
    if (typeof entry?.id === "number" && entry.result) out[entry.id] = entry.result.replace(/^0x/, "");
  }
  return out;
}

/**
 * The most recent decline reason per policy.
 *
 * Read from logs rather than storage because the contract does not keep it: a
 * declined check leaves `status` Active and `riskReported` zero, which is also
 * what an untouched policy looks like. Without this the ledger showed two
 * policies at risk 0.000 and no way to tell that both had been answered — with
 * a TLS certificate error, which is the most interesting fact on the page.
 *
 * Failures here are swallowed: the reason is a note beside a row, and losing it
 * must not cost the reader the rows themselves.
 */
async function declineReasons() {
  try {
    const head = await rpc("eth_blockNumber", []);
    const from = Math.max(0, parseInt(head, 16) - LOG_WINDOW);
    const logs = await rpc("eth_getLogs", [{
      address: AMANAT,
      fromBlock: "0x" + from.toString(16),
      toBlock: "latest",
      topics: [DECLINED_TOPIC],
    }]);
    const out = {};
    for (const log of logs ?? []) {
      const id = Number(BigInt(log.topics[1]));
      // data is a lone `string`: an offset word, a length word, then the bytes.
      const hex = String(log.data).replace(/^0x/, "");
      const length = Number(BigInt("0x" + word(hex, 1)));
      const bytes = hex.slice(128, 128 + length * 2);
      let reason = "";
      for (let k = 0; k < bytes.length; k += 2) reason += String.fromCharCode(parseInt(bytes.slice(k, k + 2), 16));
      out[id] = reason; // later logs overwrite earlier ones: the newest wins
    }
    return out;
  } catch {
    return {};
  }
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function call(to, data) {
  const [result] = await callMany([{ to, data }]);
  if (result === null) throw new Error("eth_call returned no result");
  return result;
}

const word = (hex, i) => hex.slice(i * 64, i * 64 + 64);
const uint = (hex, i) => BigInt("0x" + word(hex, i));
const uint32 = (hex, i) => Number(uint(hex, i));
const address = (hex, i) => "0x" + word(hex, i).slice(24);
const padAddress = (a) => "000000000000000000000000" + a.replace(/^0x/, "").toLowerCase();
const padUint = (n) => BigInt(n).toString(16).padStart(64, "0");

/**
 * Read a `string` whose head word at `i` is a byte offset into the same blob.
 * Offsets are counted from the start of the returned data, in bytes.
 */
function readString(hex, i) {
  const offset = Number(uint(hex, i)) * 2;      // byte offset -> hex chars
  const length = Number(BigInt("0x" + hex.slice(offset, offset + 64)));
  const bytes = hex.slice(offset + 64, offset + 64 + length * 2);
  let out = "";
  for (let k = 0; k < bytes.length; k += 2) out += String.fromCharCode(parseInt(bytes.slice(k, k + 2), 16));
  return out;
}

/** One policy, decoded from the tuple the contract returns. */
export function decodePolicy(id, hex) {
  return {
    id,
    holder: address(hex, 0),
    lat: readString(hex, 1),
    lon: readString(hex, 2),
    payout: (Number(uint(hex, 3)) / 1e6).toFixed(2),
    status: STATUS[uint32(hex, 4)] ?? `unknown(${uint32(hex, 4)})`,
    openedAt: uint32(hex, 5),
    jobId: uint32(hex, 6),
    // Word 7 is checkedAt and word 8 is riskReported. Reading the risk out of
    // word 7 put a Unix timestamp through `/ 10_000` and printed 178776.515 in
    // the risk column of the public ledger — a number that is not a risk, on a
    // page whose whole argument is that every figure on it is checkable.
    checkedAt: uint32(hex, 7),
    risk: uint32(hex, 8) / 10_000,
  };
}

/**
 * Every policy the contract has written, newest first.
 *
 * Throws when the chain cannot be read at all, and reports per-policy failures
 * separately in `unreadable`. A page that cannot reach the chain and a book with
 * nothing in it are different situations, and returning an empty list for both
 * would tell a reader the wrong one.
 */
export async function policies({ limit = 40 } = {}) {
  const next = Number(uint(await call(AMANAT, NEXT_POLICY_ID), 0));
  const ids = [];
  for (let id = next - 1; id >= 1 && ids.length < limit; id--) ids.push(id);

  const results = await callMany(ids.map((id) => ({ to: AMANAT, data: POLICIES + padUint(id) })));

  const notes = await declineReasons();
  const rows = [];
  let unreadable = 0;
  results.forEach((hex, i) => {
    if (hex === null) { unreadable++; return; }
    try {
      const row = decodePolicy(ids[i], hex);
      if (notes[row.id]) row.note = notes[row.id];
      rows.push(row);
    } catch {
      unreadable++;
    }
  });
  return { total: next - 1, rows, unreadable };
}

/** Policies written so far, and what is left to spend on jobs. */
export async function book() {
  const [nextHex, escrowHex] = await Promise.all([
    call(AMANAT, NEXT_POLICY_ID),
    call(DIAMOND, ESCROW_BALANCE + padAddress(AMANAT)),
  ]);
  return {
    contract: AMANAT,
    policies: Number(uint(nextHex, 0)) - 1,
    jobBudget: (Number(uint(escrowHex, 0)) / 1e6).toFixed(2),
  };
}
