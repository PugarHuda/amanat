// Everything Amanat needs to talk to Telegraph, in one place.
//
// Three rails, cheapest first — that ordering is the whole cost strategy:
//
//   daemon feed   free       signals the Daemon already produced
//   engine x402   $0.01      a fresh answer over HTTP, paid per call
//   ERC-8183 job  $1.00      an answer delivered to a contract, on-chain
//
// A job costs 100x an HTTP call, so nothing opens a job until the cheap rails
// say a policy is worth settling.

import { ethers } from "ethers";
import { fetchWithPayment } from "./x402.mjs";

export const NODE = process.env.TELEGRAPH_NODE ?? "https://devnode.telegraphprotocol.com";
export const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
export const DIAMOND = process.env.TELEGRAPH_DIAMOND ?? "0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8";
export const USDC = process.env.USDC ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const DIAMOND_ABI = [
  "function createJob(bytes32 intentId, (address[] addresses, uint256[] integers, string[] strings, bool[] bools) params, address callback) returns (uint256 jobId)",
  "function getJob(uint256 jobId) view returns (address agent, bytes32 intentId, address callback, uint256 budget, uint256 minerShare, uint256 fee, uint8 state, uint256 createdAt)",
  "function depositUSDC(uint256 amount)",
  "function escrowBalance(address account) view returns (uint256)",
  "function getJobBasePrice() view returns (uint256)",
  "function usdcToken() view returns (address)",
  "event JobCreated(uint256 indexed jobId, address indexed agent, bytes32 intentId, address callback)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

/** Job lifecycle states as the Diamond reports them. */
const JOB_STATE = ["Funded", "Terminal", "Cancelled"];

/**
 * Policy states, in the order Amanat.sol declares them.
 *
 * The miner serves a copy of this in lib/book.mjs rather than importing it:
 * only `miner/` is deployed to Vercel, so an import across that boundary would
 * work locally and break in production. Two copies, one boundary, stated here so
 * the second one is a decision rather than an accident.
 */
export const POLICY_STATUS = ["None", "Active", "Claimed", "Declined", "Expired"];

/**
 * Intents whose id is simply the hash of their name. For these the protocol
 * picks the miner, which is the point: an agent that pins its own miner is
 * grading its own homework.
 */
export const NAME_HASHED_INTENTS = [
  "LANGUAGE_GENERATION", "CHAT_COMPLETION", "WEATHER_CHECK", "STORM_ALERT",
  "WEATHER_FORECAST", "TASK_COMPLETION", "AGENT_TASK", "WEB_SEARCH",
  "NEWS_SEARCH", "FACT_CHECK", "AI_TEXT_DETECTION", "CONTENT_VERIFICATION",
  "DEEPFAKE_DETECTION", "MEDIA_AUTHENTICITY_CHECK", "IMAGE_VERIFICATION",
  "VIDEO_VERIFICATION",
];

export function intentId(name) {
  if (!NAME_HASHED_INTENTS.includes(name)) {
    throw new Error(
      `${name} has no name-derived intentId. Targeting it means reading one miner's ` +
      `registration id, which pins the job to that miner — see README, "Why we only use name-hashed intents".`
    );
  }
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

export const provider = () => new ethers.JsonRpcProvider(RPC, 84532);

export function wallet() {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error("AGENT_PRIVATE_KEY is not set — copy .env.example to .env and fill it in");
  return new ethers.Wallet(key, provider());
}

export const diamond = (runner) => new ethers.Contract(DIAMOND, DIAMOND_ABI, runner);
export const usdc = (runner) => new ethers.Contract(USDC, ERC20_ABI, runner);

// ── Free rail: what the Daemon already knows ────────────────────────────────

/** Live miner catalogue, filtered server-side. */
export async function miners({ intent } = {}) {
  const q = intent ? `?intent=${encodeURIComponent(intent)}` : "";
  const res = await fetch(`${NODE}/api/miners${q}`);
  if (!res.ok) throw new Error(`miner catalogue ${res.status}`);
  return res.json();
}

// ── Paid rail: a fresh answer over HTTP ─────────────────────────────────────

/**
 * Ask the Engine and let it route, paying the 402 as it comes.
 *
 * Returns the node's envelope — miner_id, intent, result, cost_usd,
 * signal_hash — plus the settlement receipt, so a caller can prove what it
 * bought rather than assert it.
 */
export async function ask(query, { signer, context } = {}) {
  const w = signer ?? wallet();
  const { response, paid, amount, settlement } = await fetchWithPayment(
    `${NODE}/engine/v1/ask`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context ? { query, context } : { query }),
    },
    w,
  );
  if (!response.ok) {
    throw new Error(`engine ask ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = await response.json();
  return { ...body, paid, paidAmount: amount, receipt: decodeSettlement(settlement) };
}

/**
 * Call one miner by id, skipping the router.
 *
 * Auto-routing classifies your sentence and picks a miner, which is right when
 * you want the network's judgement and wrong when you already know the shape of
 * the call you need. This is the escape hatch: same payment, no routing, and the
 * endpoint and payload are yours to name.
 *
 * The node validates a direct call against the miner's declared limits *before*
 * charging, and refuses with 422 rather than taking payment — so a refusal here
 * costs nothing and carries the reason.
 */
export async function askDirect(minerId, { method = "POST", endpoint, payload, signer, acknowledgeWarnings = false } = {}) {
  const w = signer ?? wallet();
  const body = { method, endpoint, payload };
  if (acknowledgeWarnings) body.acknowledge_warnings = true;

  const { response, paid, amount, settlement } = await fetchWithPayment(
    `${NODE}/engine/v1/ask/${minerId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    w,
  );

  if (response.status === 422) {
    const refusal = await response.json();
    const err = new Error(`the node predicted this call would fail: ${(refusal.warnings ?? []).join("; ")}`);
    err.refusal = refusal;
    err.chargeable = false; // 422 settles nothing
    throw err;
  }
  if (!response.ok) throw new Error(`direct ask ${response.status}: ${(await response.text()).slice(0, 200)}`);

  const out = await response.json();
  return { ...out, paid, paidAmount: amount, receipt: decodeSettlement(settlement) };
}

/**
 * The Daemon's own signals, filtered to what a caller can use.
 *
 * This rail costs nothing: the Daemon generates and answers its own questions on
 * a schedule whether or not anyone asks. A signal here is minutes to hours old,
 * so it is worth reading before paying for a fresh one — and worth ignoring once
 * it is stale.
 */
export async function recentSignals({ intents = [], maxAgeMinutes = 240, limit = 50 } = {}) {
  const res = await fetch(`${NODE}/daemon/api/questions?limit=${limit}`);
  if (!res.ok) throw new Error(`daemon feed ${res.status}`);
  const { results = [] } = await res.json();
  const cutoff = Date.now() - maxAgeMinutes * 60_000;

  return results
    .filter((r) => r.status === "success")
    // The feed carries the Daemon's own questions alongside direct results from
    // paid callers. Only the former are free intelligence; a direct result is
    // someone else's answer to a question we did not ask.
    .filter((r) => r.type === "daemon" && r.routing?.intent)
    .filter((r) => !intents.length || intents.includes(r.routing.intent))
    .filter((r) => Date.parse(r.created_at) >= cutoff)
    .map((r) => ({
      intent: r.routing?.intent,
      miner: r.routing?.miner_slug ?? r.routing?.subnet_name,
      question: r.question?.text ?? "",
      result: r.execution?.result,
      signalHash: r.signal_hash,
      at: r.created_at,
    }));
}

/** The settlement header is base64 JSON: who paid, and the transaction that did it. */
function decodeSettlement(header) {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { raw: header.slice(0, 120) };
  }
}

// ── On-chain rail ───────────────────────────────────────────────────────────

/** Poll a job until it leaves Funded, or give up. Returns the decoded record. */
export async function waitForJob(jobId, { timeoutMs = 20 * 60_000, everyMs = 15_000 } = {}) {
  const d = diamond(provider());
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await d.getJob(jobId);
    const state = JOB_STATE[Number(job[6])] ?? `unknown(${job[6]})`;
    if (state !== "Funded") return { state, job };
    if (Date.now() > deadline) return { state, job, timedOut: true };
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
