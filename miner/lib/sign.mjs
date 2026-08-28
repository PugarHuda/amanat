// Every answer signed, so a contract or an agent can check who said it.
//
// The network returns a `signal_hash` that nobody outside the node can
// re-derive (docs/bug-report.md, finding 10). This is the version that can be:
// a canonical form of the fields a contract settles on, hashed, and signed
// with a key whose public half travels with the answer and sits at
// /.well-known/amanat.json. Verifying takes Node's own crypto and nothing
// else — no ethers, no library, no call back to us.
//
// Ed25519 rather than secp256k1 because Node signs and verifies it natively
// and a miner with no dependencies stays a miner with no dependencies. The
// key is `AMANAT_SIGNING_KEY` (base64 PKCS#8) when set; when it is not, a key
// is generated at start and /health says so, because an ephemeral key on a
// serverless host means each instance signs with its own.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";

function load() {
  const b64 = process.env.AMANAT_SIGNING_KEY;
  if (b64) {
    const key = createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
    return { key, persistent: true };
  }
  return { key: generateKeyPairSync("ed25519").privateKey, persistent: false };
}

const { key: PRIVATE, persistent } = load();
const PUBLIC = createPublicKey(PRIVATE);

/** The public key as base64 SPKI DER — what a verifier needs, in one string. */
export const publicKey = PUBLIC.export({ format: "der", type: "spki" }).toString("base64");
export const keyIsPersistent = persistent;

/** The fields a contract acts on, in a fixed order. Everything else is commentary. */
export const SIGNED_FIELDS = ["lat", "lon", "hours", "valid_at", "temp_c", "wind_kmh", "gust_kmh", "precip_mm", "wave_cm", "cyclone_km", "risk", "breach"];

/**
 * Canonical form: the signed fields, in SIGNED_FIELDS order, as compact JSON.
 * Fixed order rather than sorted keys so the bytes are the same from any
 * language that can print JSON, and no key is silently added or dropped.
 */
export function canonical(answer) {
  const picked = {};
  for (const k of SIGNED_FIELDS) picked[k] = answer[k] ?? null;
  return JSON.stringify(picked);
}

/** The attestation block for an answer. */
export function attest(answer) {
  const payload = canonical(answer);
  const digest = createHash("sha256").update(payload).digest("hex");
  const signature = edSign(null, Buffer.from(payload), PRIVATE).toString("base64");
  return {
    algorithm: "ed25519",
    signed_fields: SIGNED_FIELDS,
    canonical: payload,
    sha256: digest,
    signature,
    public_key: publicKey,
    key_persistent: persistent,
  };
}

/** Check an attestation against its own canonical payload. What a verifier runs. */
export function verify({ canonical: payload, signature, public_key }) {
  const pub = createPublicKey({ key: Buffer.from(public_key, "base64"), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(payload), pub, Buffer.from(signature, "base64"));
}
