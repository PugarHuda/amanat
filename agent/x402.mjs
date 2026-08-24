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

export function decodeChallenge(header) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

/** Sign the eip155 option of a challenge. Returns the PAYMENT-SIGNATURE value. */
export async function signPayment(challenge, wallet, chainId = 84532) {
  const accept = challenge.accepts?.find((a) => a.network?.startsWith("eip155:"));
  if (!accept) throw new Error("no eip155 option in the 402 challenge");

  const acceptChain = Number(accept.network.split(":")[1]);
  if (acceptChain !== chainId) throw new Error(`challenge is for chain ${acceptChain}, we are on ${chainId}`);

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
export async function fetchWithPayment(url, init, wallet, { chainId = 84532 } = {}) {
  const first = await fetch(url, init);
  if (first.status !== 402) return { response: first, paid: false };

  const header = first.headers.get("payment-required");
  if (!header) throw new Error("402 without a PAYMENT-REQUIRED header — nothing to sign");

  const challenge = decodeChallenge(header);
  const payment = await signPayment(challenge, wallet, chainId);

  const retry = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), "PAYMENT-SIGNATURE": payment.header },
  });

  // A second 402 means the facilitator rejected the payment. It looks identical
  // to never having paid, so say which one it was.
  if (retry.status === 402) {
    throw new Error(
      `payment was signed and refused: the facilitator did not accept it ` +
      `(${payment.amount} of ${payment.asset} to ${payment.payTo})`,
    );
  }

  return {
    response: retry,
    paid: true,
    amount: payment.amount,
    settlement: retry.headers.get("payment-response") ?? retry.headers.get("x-payment-settle-response"),
  };
}
