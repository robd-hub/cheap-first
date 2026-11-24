/**
 * Prepaid API keys, including free trial keys the owner hands out.
 *
 * A card payment (see stripe.ts) is turned into a key worth one answer per
 * $0.005 paid. A trial key is the same kind of key, created by the owner,
 * with its own answer cap (default 200). The key is sent as
 * "Authorization: Bearer cf_..." to /api/pay or /api/v1/chat/completions,
 * and each answer takes one credit. A failed answer gives the credit back.
 *
 * Balances must survive restarts, so keys only work with the shared store
 * (Upstash) connected; we keep only a hash of each key. Issuing a trial key
 * does not turn Stripe on.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dailyKeySpendCapUsd, keySpendHasRoom } from "./budget.js";
import { getString, incrBy, setString, sharedStoreConfigured } from "./store.js";
import { PRICE_MICRO } from "./x402.js";

const KEEP_SECONDS = 2 * 365 * 86_400;
const RATE_TTL_SECONDS = 120;

export const DEFAULT_TRIAL_ANSWERS = 200;
export const MAX_TRIAL_ANSWERS = 10_000;

let keysOverride: boolean | null = null;

/** Test hook. `null` uses the real store check. */
export function setKeysAvailableForTests(value: boolean | null): void {
  keysOverride = value;
}

export function keysAvailable(): boolean {
  if (keysOverride !== null) return keysOverride;
  return sharedStoreConfigured();
}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const creditsKey = (key: string) => `cf:key:${hash(key)}`;
const metaKey = (key: string) => `cf:keymeta:${hash(key)}`;

export function isApiKey(text: string): boolean {
  return /^cf_[A-Za-z0-9_-]{20,80}$/.test(text);
}

export type PresentedAuth = { kind: "none" } | { kind: "key"; key: string } | { kind: "invalid" };

/**
 * What Authorization carries. No header is "none" (an x402 probe still
 * applies). A Bearer token that isn't a cf_ key is "invalid".
 */
export function presentedAuth(request: Request): PresentedAuth {
  const header = request.headers.get("authorization");
  if (!header) return { kind: "none" };
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return { kind: "invalid" };
  if (isApiKey(match[1])) return { kind: "key", key: match[1] };
  return { kind: "invalid" };
}

/** Reads "Authorization: Bearer cf_..." from a request, if present. */
export function keyFrom(request: Request): string | null {
  const presented = presentedAuth(request);
  return presented.kind === "key" ? presented.key : null;
}

/** How many answers a payment buys: one per PRICE_MICRO (in USDC micro-units, so cents x 10,000). */
export function creditsFor(amountCents: number): number {
  return Math.floor((amountCents * 10_000) / Number(PRICE_MICRO));
}

export interface KeyMeta {
  kind: "trial" | "paid";
  answers: number;
  label?: string;
  issuedAt: string;
}

function mintKey(): string {
  return `cf_${randomBytes(24).toString("base64url")}`;
}

async function remember(key: string, meta: KeyMeta): Promise<void> {
  await setString(metaKey(key), JSON.stringify(meta), { ttlSeconds: KEEP_SECONDS });
}

export async function readKeyMeta(key: string): Promise<KeyMeta | null> {
  const raw = await getString(metaKey(key));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as KeyMeta;
    if ((parsed.kind !== "trial" && parsed.kind !== "paid") || !Number.isFinite(parsed.answers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Turns a paid checkout into a new key, once. Returns null if this checkout
 * was already redeemed (so refreshing the page can't mint a second key).
 */
export async function issueKey(sessionId: string, credits: number): Promise<string | null> {
  const key = mintKey();
  const claimed = await setString(`cf:session:${sessionId}`, hash(key), { onlyIfNew: true, ttlSeconds: KEEP_SECONDS });
  if (!claimed) return null;
  await incrBy(creditsKey(key), credits, KEEP_SECONDS);
  await remember(key, { kind: "paid", answers: credits, issuedAt: new Date().toISOString() });
  return key;
}

/** Answers on a trial key when the request doesn't set one. `CF_TRIAL_ANSWERS` overrides 200. */
export function defaultTrialAnswers(): number {
  const n = Number(process.env.CF_TRIAL_ANSWERS);
  return Number.isInteger(n) && n >= 1 && n <= MAX_TRIAL_ANSWERS ? n : DEFAULT_TRIAL_ANSWERS;
}

/** The answer cap, or an error message. A missing value uses the default. */
export function parseAnswerCap(raw: unknown): number | string {
  if (raw === undefined || raw === null || raw === "") return defaultTrialAnswers();
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_TRIAL_ANSWERS) {
    return `answers must be a whole number from 1 to ${MAX_TRIAL_ANSWERS}.`;
  }
  return n;
}

/** A short note stored with the key, or "invalid" when the value isn't text. */
export function parseLabel(raw: unknown): string | undefined | "invalid" {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return "invalid";
  const label = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return label || undefined;
}

/**
 * Creates a trial key worth `answers` replies (default 200). The plaintext
 * key is returned once; only its hash is stored.
 */
export async function issueTrialKey(opts: { answers?: number; label?: string; now?: Date } = {}): Promise<{ key: string; answers: number; label?: string }> {
  const answers = opts.answers ?? defaultTrialAnswers();
  const key = mintKey();
  await incrBy(creditsKey(key), answers, KEEP_SECONDS);
  await remember(key, {
    kind: "trial",
    answers,
    issuedAt: (opts.now ?? new Date()).toISOString(),
    ...(opts.label ? { label: opts.label } : {}),
  });
  return { key, answers, ...(opts.label ? { label: opts.label } : {}) };
}

export async function creditsLeft(key: string): Promise<number> {
  return Number((await getString(creditsKey(key))) ?? 0);
}

type Standing = "unknown" | "active" | "empty";

/** "unknown" leaves no counter behind, so a guessed key isn't stored. */
async function standingOf(key: string): Promise<Standing> {
  const raw = await getString(creditsKey(key));
  if (raw === null) return "unknown";
  return Number(raw) > 0 ? "active" : "empty";
}

/** Takes one credit. Returns false (and takes nothing) if the key is empty or unknown. */
export async function spendCredit(key: string): Promise<boolean> {
  if ((await standingOf(key)) !== "active") return false;
  const left = await incrBy(creditsKey(key), -1, KEEP_SECONDS);
  if (left >= 0) return true;
  await incrBy(creditsKey(key), 1, KEEP_SECONDS);
  return false;
}

export async function refundCredit(key: string): Promise<void> {
  await incrBy(creditsKey(key), 1, KEEP_SECONDS);
}

/** Requests each key may make in one minute. `CF_KEY_RATE_PER_MIN`, default 20. */
export function keyRatePerMin(): number {
  const n = Number(process.env.CF_KEY_RATE_PER_MIN);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.floor(n);
}

/**
 * Test hook: fill this minute and the next, so a following request is over
 * the limit whichever minute it lands in.
 */
export async function saturateKeyRate(key: string, now = new Date()): Promise<void> {
  const limit = keyRatePerMin();
  for (const at of [now, new Date(now.getTime() + 60_000)]) {
    await incrBy(`cf:keyrate:${hash(key)}:${at.toISOString().slice(0, 16)}`, limit, RATE_TTL_SECONDS);
  }
}

export interface KeyDenial {
  status: 401 | 429 | 503;
  type: string;
  code: string;
  message: string;
  retryAfter?: number;
}

function secondsLeftInMinute(now: Date): number {
  return Math.max(1, 60 - now.getUTCSeconds());
}

function secondsUntilUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Checks a key and, when it may answer, takes one credit.
 * The rate limit and the daily spend cap refuse without taking a credit.
 */
export async function claimKey(key: string, now = new Date()): Promise<{ ok: true } | { ok: false; denial: KeyDenial }> {
  if (!keysAvailable()) {
    return {
      ok: false,
      denial: {
        status: 503,
        type: "server_error",
        code: "keys_unavailable",
        message: "Prepaid keys aren't available right now. Please try again later.",
      },
    };
  }
  const standing = await standingOf(key);
  if (standing === "unknown") {
    return {
      ok: false,
      denial: {
        status: 401,
        type: "invalid_request_error",
        code: "invalid_api_key",
        message: "Invalid API key. It isn't a key Cheap First issued.",
      },
    };
  }
  if (standing === "empty") {
    return {
      ok: false,
      denial: {
        status: 429,
        type: "insufficient_quota",
        code: "insufficient_quota",
        message: "This key has used all of its answers.",
      },
    };
  }
  if (!(await keySpendHasRoom(now))) {
    return {
      ok: false,
      denial: {
        status: 429,
        type: "insufficient_quota",
        code: "spend_cap_exceeded",
        message: `Cheap First has hit today's spend cap for API keys ($${dailyKeySpendCapUsd()}). You haven't been charged. Try again tomorrow.`,
        retryAfter: secondsUntilUtcDay(now),
      },
    };
  }
  const limit = keyRatePerMin();
  const used = await incrBy(`cf:keyrate:${hash(key)}:${now.toISOString().slice(0, 16)}`, 1, RATE_TTL_SECONDS);
  if (used > limit) {
    const retryAfter = secondsLeftInMinute(now);
    return {
      ok: false,
      denial: {
        status: 429,
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        message: `This key is limited to ${limit} requests a minute. You haven't been charged. Try again in ${retryAfter} seconds.`,
        retryAfter,
      },
    };
  }
  if (!(await spendCredit(key))) {
    return {
      ok: false,
      denial: {
        status: 429,
        type: "insufficient_quota",
        code: "insufficient_quota",
        message: "This key has used all of its answers.",
      },
    };
  }
  return { ok: true };
}

/** True when `given` is the `CF_ADMIN_TOKEN` value. Unset or blank never matches. */
export function adminTokenMatches(given: string): boolean {
  const expected = process.env.CF_ADMIN_TOKEN ?? "";
  if (!expected || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
