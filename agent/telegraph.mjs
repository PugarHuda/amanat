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

export const NODE = process.env.TELEGRAPH_NODE ?? "https://devnode.telegraphprotocol.com";
export const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
export const DIAMOND = process.env.TELEGRAPH_DIAMOND ?? "0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8";
export const USDC = process.env.USDC ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export const DIAMOND_ABI = [
  "function createJob(bytes32 intentId, (address[] addresses, uint256[] integers, string[] strings, bool[] bools) params, address callback) returns (uint256 jobId)",
  "function getJob(uint256 jobId) view returns (address agent, bytes32 intentId, address callback, uint256 budget, uint256 minerShare, uint256 fee, uint8 state, uint256 createdAt)",
  "function depositUSDC(uint256 amount)",
  "function escrowBalance(address account) view returns (uint256)",
  "function getJobBasePrice() view returns (uint256)",
  "function usdcToken() view returns (address)",
  "event JobCreated(uint256 indexed jobId, address indexed agent, bytes32 intentId, address callback)",
];

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

/** Job lifecycle states as the Diamond reports them. */
export const JOB_STATE = ["Funded", "Terminal", "Cancelled"];

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

/** Signals the Daemon produced on its own. No payment, no auth. */
export async function daemonSignals({ limit = 20, intent } = {}) {
  const res = await fetch(`${NODE}/daemon/api/questions?limit=${limit}`);
  if (!res.ok) throw new Error(`daemon feed ${res.status}`);
  const { results = [] } = await res.json();
  return intent ? results.filter((r) => r.routing?.intent === intent) : results;
}

/** Live miner catalogue, filtered server-side. */
export async function miners({ intent } = {}) {
  const q = intent ? `?intent=${encodeURIComponent(intent)}` : "";
  const res = await fetch(`${NODE}/api/miners${q}`);
  if (!res.ok) throw new Error(`miner catalogue ${res.status}`);
  return res.json();
}

// ── Paid rail: a fresh answer over HTTP ─────────────────────────────────────

/**
 * Ask the Engine and let it route. Needs an x402-capable fetch — pass one in
 * from `@x402/fetch` — because the first call always comes back 402.
 *
 * Returns the node's envelope: miner_id, intent, result, cost_usd, signal_hash.
 */
export async function ask(query, { fetchImpl = fetch, context } = {}) {
  const res = await fetchImpl(`${NODE}/engine/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(context ? { query, context } : { query }),
  });
  if (res.status === 402) {
    throw new Error("402 unpaid — wrap fetch with @x402/fetch and fund the wallet with Base Sepolia USDC");
  }
  if (!res.ok) throw new Error(`engine ask ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── On-chain rail ───────────────────────────────────────────────────────────

/** Top up the agent's USDC escrow on the Diamond. Approve first, then deposit. */
export async function fundEscrow(signer, amountUsdc) {
  const amount = ethers.parseUnits(String(amountUsdc), 6);
  const approve = await usdc(signer).approve(DIAMOND, amount);
  await approve.wait();
  const deposit = await diamond(signer).depositUSDC(amount);
  return deposit.wait();
}

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
