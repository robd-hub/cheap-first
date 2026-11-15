/**
 * Prepaid API keys for people who'd rather pay by card than with x402.
 *
 * A card payment (see stripe.ts) is turned into a key worth one answer per
 * $0.005 paid. The key is sent as "Authorization: Bearer cf_..." to
 * /api/pay or /api/v1/chat/completions, and each answer takes one credit.
 * A failed answer gives the credit back.
 *
 * Balances must survive restarts, so keys only work with the shared store
 * (Upstash) connected; we keep only a hash of each key.
 */
import { createHash, randomBytes } from "node:crypto";
import { PRICE_MICRO } from "./x402.js";
import { getNumber, incrBy, setString, sharedStoreConfigured } from "./store.js";

const KEEP_SECONDS = 2 * 365 * 86_400;

export function keysAvailable(): boolean {
  return sharedStoreConfigured();
}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const creditsKey = (key: string) => `cf:key:${hash(key)}`;

export function isApiKey(text: string): boolean {
  return /^cf_[A-Za-z0-9_-]{20,80}$/.test(text);
}

/** Reads "Authorization: Bearer cf_..." from a request, if present. */
export function keyFrom(request: Request): string | null {
  const m = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  return m && isApiKey(m[1]) ? m[1] : null;
}

/** How many answers a payment buys: one per PRICE_MICRO (in USDC micro-units, so cents x 10,000). */
export function creditsFor(amountCents: number): number {
  return Math.floor((amountCents * 10_000) / Number(PRICE_MICRO));
}

/**
 * Turns a paid checkout into a new key, once. Returns null if this checkout
 * was already redeemed (so refreshing the page can't mint a second key).
 */
export async function issueKey(sessionId: string, credits: number): Promise<string | null> {
  const key = `cf_${randomBytes(24).toString("base64url")}`;
  const claimed = await setString(`cf:session:${sessionId}`, hash(key), { onlyIfNew: true, ttlSeconds: KEEP_SECONDS });
  if (!claimed) return null;
  await incrBy(creditsKey(key), credits, KEEP_SECONDS);
  return key;
}

export async function creditsLeft(key: string): Promise<number> {
  return getNumber(creditsKey(key));
}

/** Takes one credit. Returns false (and takes nothing) if the key is empty or unknown. */
export async function spendCredit(key: string): Promise<boolean> {
  const left = await incrBy(creditsKey(key), -1, KEEP_SECONDS);
  if (left >= 0) return true;
  await incrBy(creditsKey(key), 1, KEEP_SECONDS);
  return false;
}

export async function refundCredit(key: string): Promise<void> {
  await incrBy(creditsKey(key), 1, KEEP_SECONDS);
}
