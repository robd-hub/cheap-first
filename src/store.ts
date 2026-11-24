/**
 * A tiny shared counter store, so limits and balances hold across every
 * Vercel server instance instead of resetting with each one.
 *
 * Uses Upstash Redis over its REST API when it's connected (Vercel's
 * Upstash integration sets KV_REST_API_URL / KV_REST_API_TOKEN, or
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN). Without it, or if it
 * can't be reached, falls back to memory in this one instance, which is how
 * the limits worked before.
 */
type Cmd = (string | number)[];

const URL_ = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export function sharedStoreConfigured(): boolean {
  return Boolean(URL_ && TOKEN);
}

const memory = new Map<string, { value: string; expires: number }>();
let memoryOnly = false;

/** Test hook: skip Upstash and use the in-memory store. */
export function forceMemoryStore(on: boolean): void {
  memoryOnly = on;
}

function useRedis(): boolean {
  return sharedStoreConfigured() && !memoryOnly;
}

function memGet(key: string): string | null {
  const v = memory.get(key);
  if (!v) return null;
  if (v.expires && v.expires < Date.now()) {
    memory.delete(key);
    return null;
  }
  return v.value;
}

function memSet(key: string, value: string, ttlSeconds?: number): void {
  const old = memory.get(key);
  memory.set(key, { value, expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : (old?.expires ?? 0) });
}

/** Runs commands in one round trip. Throws if the store can't be reached. */
async function pipeline(cmds: Cmd[]): Promise<unknown[]> {
  const res = await fetch(`${URL_}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Store returned ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: string }[];
  return body.map((r) => {
    if (r.error) throw new Error(`Store error: ${r.error}`);
    return r.result;
  });
}

let warned = false;
function fallback(e: unknown): void {
  if (!warned) console.error(`Shared store unavailable, using memory: ${(e as Error).message}`);
  warned = true;
}

/**
 * Runs commands against Upstash. Returns null when it isn't configured or
 * the request fails. Callers that must not fall back to per-instance memory
 * (the public stats counters) use this and skip the write.
 */
export async function redisPipeline(cmds: Cmd[]): Promise<unknown[] | null> {
  if (!useRedis()) return null;
  try {
    return await pipeline(cmds);
  } catch (e) {
    fallback(e);
    return null;
  }
}

/** Adds `by` to a number and returns the new total. The key expires after `ttlSeconds` (set on first use). */
export async function incrBy(key: string, by: number, ttlSeconds: number): Promise<number> {
  if (useRedis()) {
    try {
      const [total] = await pipeline([["INCRBYFLOAT", key, by], ["EXPIRE", key, ttlSeconds, "NX"]]);
      return Number(total);
    } catch (e) {
      fallback(e);
    }
  }
  const fresh = memGet(key) === null;
  const total = Number(memGet(key) ?? 0) + by;
  memSet(key, String(total), fresh ? ttlSeconds : undefined);
  return total;
}

export async function getNumber(key: string): Promise<number> {
  return Number((await getString(key)) ?? 0);
}

export async function getString(key: string): Promise<string | null> {
  if (useRedis()) {
    try {
      const [v] = await pipeline([["GET", key]]);
      return v === null || v === undefined ? null : String(v);
    } catch (e) {
      fallback(e);
    }
  }
  return memGet(key);
}

/** Sets a value. With `onlyIfNew`, does nothing (and returns false) if the key already exists. */
export async function setString(key: string, value: string, opts: { ttlSeconds?: number; onlyIfNew?: boolean } = {}): Promise<boolean> {
  if (useRedis()) {
    try {
      const cmd: Cmd = ["SET", key, value];
      if (opts.ttlSeconds) cmd.push("EX", opts.ttlSeconds);
      if (opts.onlyIfNew) cmd.push("NX");
      const [r] = await pipeline([cmd]);
      return r === "OK";
    } catch (e) {
      fallback(e);
    }
  }
  if (opts.onlyIfNew && memGet(key) !== null) return false;
  memSet(key, value, opts.ttlSeconds);
  return true;
}

/** Test hook: forget everything kept in memory. */
export function resetMemoryStore(): void {
  memory.clear();
}
