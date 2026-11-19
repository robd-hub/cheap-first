/**
 * Shared limits for the free demo and the paid endpoints.
 *
 * /api/ask and free MCP calls use the same counters, so the MCP server cannot
 * offer a wider free tier than the public demo. Paid MCP calls use the same
 * length cap as /api/pay.
 */
import { incrBy } from "./store.js";

/** Free questions, on the demo and on free MCP calls. */
export const DEMO_MAX_QUESTION = 600;
/** Paid questions, on /api/pay and on paid MCP calls. */
export const PAID_MAX_QUESTION = 2000;

export function demoLimits(): { perIpPerHour: number; dailyCap: number } {
  return {
    perIpPerHour: Number(process.env.CF_PER_IP_PER_HOUR) || 10,
    dailyCap: Number(process.env.CF_DAILY_CAP) || 300,
  };
}

export type DemoSlot = { ok: true } | { ok: false; status: 429; error: string };

/**
 * Counts one free question against the hourly and daily demo caps.
 * A refused question still counts, which is fine for a demo.
 */
export async function takeDemoSlot(request: Request, now = new Date()): Promise<DemoSlot> {
  const { perIpPerHour, dailyCap } = demoLimits();
  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim().slice(0, 64);
  const hour = now.toISOString().slice(0, 13);
  const day = now.toISOString().slice(0, 10);
  const [mine, all] = await Promise.all([incrBy(`cf:demo:ip:${ip}:${hour}`, 1, 3600), incrBy(`cf:demo:day:${day}`, 1, 2 * 86_400)]);
  if (mine > perIpPerHour) return { ok: false, status: 429, error: `That's ${perIpPerHour} questions this hour. Try again later.` };
  if (all > dailyCap) return { ok: false, status: 429, error: "The demo has hit today's limit. Try again tomorrow." };
  return { ok: true };
}
