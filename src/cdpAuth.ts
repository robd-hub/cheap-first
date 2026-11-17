/**
 * Sign-in for Coinbase's hosted x402 facilitator (CDP).
 *
 * Coinbase's facilitator is the one Agentic.market and the Bazaar read from:
 * when it settles a payment whose offer carries the "bazaar" extension, it
 * lists the endpoint automatically. Each call needs a short-lived JWT signed
 * with a CDP API key (made for free at portal.cdp.coinbase.com).
 *
 * This mirrors @coinbase/cdp-sdk's generateJwt with node:crypto only, so no
 * extra dependency: claims { sub, iss: "cdp", uris: ["POST host/path"] },
 * header { alg, kid, typ: "JWT", nonce }, valid for 120 seconds. Both key
 * types CDP issues work: Ed25519 (base64, 64 bytes, the default) and EC
 * (PEM, ES256).
 */
import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";

export const CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";

/** True when both CDP_API_KEY_ID and CDP_API_KEY_SECRET are set. */
export function cdpConfigured(): boolean {
  return Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function loadKey(secret: string): { key: KeyObject; alg: "EdDSA" | "ES256" } {
  // Vercel env values sometimes keep literal "\n" from a pasted PEM.
  const text = secret.includes("\\n") ? secret.replace(/\\n/g, "\n") : secret;
  if (text.includes("BEGIN")) return { key: createPrivateKey(text), alg: "ES256" };
  const raw = Buffer.from(text.trim(), "base64");
  if (raw.length !== 64) throw new Error("CDP_API_KEY_SECRET must be a PEM EC key or a base64 Ed25519 key (64 bytes).");
  const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", d: b64url(raw.subarray(0, 32)), x: b64url(raw.subarray(32)) } });
  return { key, alg: "EdDSA" };
}

/** A Bearer token for one POST to the CDP facilitator, e.g. path "/platform/v2/x402/settle". */
export function cdpAuthHeader(method: string, url: string, keyId = process.env.CDP_API_KEY_ID ?? "", secret = process.env.CDP_API_KEY_SECRET ?? ""): string {
  if (!keyId || !secret) throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set.");
  const { host, pathname } = new URL(url);
  const { key, alg } = loadKey(secret);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg, kid: keyId, typ: "JWT", nonce: randomBytes(16).toString("hex") };
  const claims = { sub: keyId, iss: "cdp", uris: [`${method.toUpperCase()} ${host}${pathname}`], iat: now, nbf: now, exp: now + 120 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = alg === "EdDSA" ? sign(null, Buffer.from(input), key) : sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `Bearer ${input}.${b64url(sig)}`;
}
