// Pay for a Telegraph call over x402, with nothing but ethers.
//
// The exchange is one HTTP round trip plus a signature:
//
//   1. request without payment          -> 402 + base64 challenge in PAYMENT-REQUIRED
//   2. sign an EIP-3009 TransferWithAuthorization for the exact amount
//   3. retry the same request with PAYMENT-SIGNATURE
//
// No gas is spent by us: the facilitator submits the transfer. The signature is
// EIP-712 typed data over the *token's* domain, and the name and version have to
// come from `accepts[].extra` — Base Sepolia USDC is name "USDC", version "2",
// and guessing wrong produces a bare 402 that looks exactly like not paying.

import { ethers } from "ethers";

/** Pull whatever the node or facilitator said about a refusal. */
function describeRefusal(body, settleHeader) {
  const parts = [];
  for (const raw of [body, settleHeader && Buffer.from(settleHeader, "base64").toString("utf8"), settleHeader]) {
    if (!raw) continue;
    try {
      const json = JSON.parse(raw);
      const said = json.errorReason ?? json.error ?? json.message ?? json.reason;
      if (said) parts.push(String(said));
      if (json.success === false && !said) parts.push("facilitator reported success: false");
    } catch {
      const text = String(raw).trim();
      if (text && text.length < 200 && !text.startsWith("ey")) parts.push(text);
    }
  }
  return [...new Set(parts)].join("; ");
}

export function decodeChallenge(header) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

/**
 * One USDC, in the token's six decimals.
 *
 * An Engine call is $0.01 and the dearest thing on the protocol is a $1.00 job,
 * so anything at this ceiling is already a hundred times the going rate.
 */
export const DEFAULT_MAX_AMOUNT = 1_000_000n;

/**
 * Sign the eip155 option of a challenge. Returns the PAYMENT-SIGNATURE value.
 *
 * Two checks stand between a 402 and a signature, and neither is paranoia.
 *
 * The challenge is written by the server being paid. It names the amount and it
 * names the token, and an EIP-3009 authorization is a bearer instrument: once
 * signed, the facilitator can submit it and the transfer lands with no further
 * consent from us. A node that asked for 999 USDC instead of 0.01 would have
 * been signed without complaint, and a node that named a different ERC-20 would
 * have been signed a transfer of that instead. Neither needs malice — a units
 * bug on the far side is enough.
 *
 * So the amount is capped and the asset must be the token the caller expected.
 */
export async function signPayment(challenge, wallet, { chainId = 84532, maxAmount = DEFAULT_MAX_AMOUNT, asset } = {}) {
  const accept = challenge.accepts?.find((a) => a.network?.startsWith("eip155:"));
  if (!accept) throw new Error("no eip155 option in the 402 challenge");

  const acceptChain = Number(accept.network.split(":")[1]);
  if (acceptChain !== chainId) throw new Error(`challenge is for chain ${acceptChain}, we are on ${chainId}`);

  const amount = BigInt(accept.amount);
  if (amount <= 0n) throw new Error(`challenge asks for ${accept.amount}, which is not a payable amount`);
  if (amount > BigInt(maxAmount)) {
    throw new Error(
      `challenge asks for ${ethers.formatUnits(amount, 6)} USDC, over the ` +
      `${ethers.formatUnits(BigInt(maxAmount), 6)} ceiling — refusing to sign. ` +
      `Raise maxAmount only if you meant to pay this.`,
    );
  }
  if (asset && ethers.getAddress(accept.asset) !== ethers.getAddress(asset)) {
    throw new Error(
      `challenge asks to be paid in ${accept.asset}, not the expected ${asset} — refusing to sign`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: ethers.getAddress(wallet.address),
    to: ethers.getAddress(accept.payTo),
    value: accept.amount,
    // A little slack behind us for clock skew, and enough ahead for the
    // facilitator to actually land the transfer.
    validAfter: String(now - 30),
    validBefore: String(now + Math.max(Number(accept.maxTimeoutSeconds ?? 60), 300)),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };

  const signature = await wallet.signTypedData(
    {
      name: accept.extra?.name ?? "USDC",
      version: accept.extra?.version ?? "2",
      chainId: acceptChain,
      verifyingContract: ethers.getAddress(accept.asset),
    },
    {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  );

  const payload = {
    x402Version: challenge.x402Version ?? 2,
    scheme: accept.scheme ?? "exact",
    network: accept.network,
    accepted: accept,
    payload: { signature, authorization },
    extensions: {},
  };

  return {
    header: Buffer.from(JSON.stringify(payload)).toString("base64"),
    amount: accept.amount,
    payTo: accept.payTo,
    asset: accept.asset,
  };
}

/**
 * fetch that pays when asked to. Returns the response plus what it cost, so a
 * caller can keep its own tally rather than trusting a header it never read.
 */
export async function fetchWithPayment(
  url,
  init,
  wallet,
  { chainId = 84532, maxAmount = DEFAULT_MAX_AMOUNT, asset, timeoutMs = 60_000 } = {},
) {
  // Without a deadline a hung node blocks the caller for as long as it likes,
  // and an agent on a schedule simply stops. The paid leg gets its own budget
  // rather than sharing the first one's.
  const first = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (first.status !== 402) return { response: first, paid: false };

  const header = first.headers.get("payment-required");
  if (!header) throw new Error("402 without a PAYMENT-REQUIRED header — nothing to sign");

  const challenge = decodeChallenge(header);
  const payment = await signPayment(challenge, wallet, { chainId, maxAmount, asset });

  // The authorization is now signed and carries a fresh nonce. If this request
  // is lost in flight the facilitator may still have settled it, and a re-run
  // would sign a *new* nonce and pay a second time — there is no way from here
  // to tell a lost response from a refused payment. Callers that retry should
  // treat a network failure at this point as "possibly paid", which is why the
  // agents tally spend from what they sent rather than from what came back.
  const retry = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), "PAYMENT-SIGNATURE": payment.header },
    signal: AbortSignal.timeout(timeoutMs),
  });

  // A second 402 means the facilitator rejected the payment, and it looks
  // identical on the wire to never having paid. Say which it was, and say why:
  // the reason is in the body or the settlement header, and discarding it leaves
  // the caller with "it failed" and nowhere to go.
  if (retry.status === 402) {
    const body = await retry.text().catch(() => "");
    const settle = retry.headers.get("payment-response") ?? retry.headers.get("x-payment-settle-response");
    const reason = describeRefusal(body, settle);
    throw new Error(
      `payment signed and refused${reason ? `: ${reason}` : ""} ` +
      `(${payment.amount} of ${payment.asset} to ${payment.payTo} from ${wallet.address})`,
    );
  }

  return {
    response: retry,
    paid: true,
    amount: payment.amount,
    settlement: retry.headers.get("payment-response") ?? retry.headers.get("x-payment-settle-response"),
  };
}
