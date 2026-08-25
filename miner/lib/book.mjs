// Read the contract's own numbers for the page, over plain JSON-RPC.
//
// Only two calls, and both return a bare uint256, so there is no ABI decoding
// worth the name and no dependency to add: `nextPolicyId()` on the book and
// `escrowBalance(address)` on the Diamond. Anything with dynamic types would
// need a real decoder, and the page does not need one.

const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";
const AMANAT = process.env.AMANAT_CONTRACT ?? "0x1649ce04B8b9D56285a62Afb2b442602EE0bBc6e";
const DIAMOND = process.env.TELEGRAPH_DIAMOND ?? "0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8";

// keccak256 of the signatures, first four bytes.
const NEXT_POLICY_ID = "0xcad0b8db";
const ESCROW_BALANCE = "0x55af6353";

async function call(to, data) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return BigInt(body.result);
}

const pad = (addr) => "000000000000000000000000" + addr.replace(/^0x/, "").toLowerCase();

/** Policies written so far, and what is left to spend on jobs. */
export async function book() {
  const [next, escrow] = await Promise.all([
    call(AMANAT, NEXT_POLICY_ID),
    call(DIAMOND, ESCROW_BALANCE + pad(AMANAT)),
  ]);
  return {
    contract: AMANAT,
    policies: Number(next - 1n),
    jobBudget: (Number(escrow) / 1e6).toFixed(2),
  };
}
