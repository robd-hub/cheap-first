/**
 * Guards against one expensive question (or many) draining the SERV balance.
 *
 * Every paid or free answer costs us the cheap answer plus a check, which is
 * tiny. An escalation to the premium model can cost far more than the
 * $0.005 we charge (in the benchmark, one escalated answer cost $0.19). So
 * escalations are capped two ways:
 *   - each premium answer is limited to PREMIUM_MAX_TOKENS tokens
 *   - escalations stop once the day's premium budget is spent, until the
 *     next day (UTC)
 *
 * With the shared store connected (see store.ts) the budget covers every
 * server instance together; without it, each instance keeps its own.
 */
import { getNumber, incrBy } from "./store.js";

export const PREMIUM_MAX_TOKENS = Number(process.env.CF_PREMIUM_MAX_TOKENS) || 2000;

const DAY_SECONDS = 86_400;

export class DailyBudget {
  constructor(
    readonly name: string,
    readonly limitUsd: number,
  ) {}

  private key(now: Date): string {
    return `cf:premium:${this.name}:${now.toISOString().slice(0, 10)}`;
  }

  /** True while there's budget left today. */
  async hasRoom(now = new Date()): Promise<boolean> {
    return (await getNumber(this.key(now))) < this.limitUsd;
  }

  async add(usd: number, now = new Date()): Promise<void> {
    if (usd > 0) await incrBy(this.key(now), usd, 2 * DAY_SECONDS);
  }
}

/** Shared by every paid endpoint, so together they stay within one daily budget. */
export const paidPremiumBudget = new DailyBudget("paid", Number(process.env.CF_PAID_PREMIUM_BUDGET_USD) || 2);
/** The free demo's own, smaller budget. */
export const demoPremiumBudget = new DailyBudget("demo", Number(process.env.CF_DEMO_PREMIUM_BUDGET_USD) || 1);

/**
 * Daily cap on every API key's model spend together: the cheap answer, the
 * check, and the premium model. This sits on top of the premium budgets
 * above, which still limit escalations on their own. x402 calls are not
 * counted here.
 *
 * Checked before the model call. Requests already in flight can finish, so
 * the stored total can land a little over the cap; the next request is refused.
 */
export function dailyKeySpendCapUsd(): number {
  const n = Number(process.env.CF_DAILY_SPEND_CAP_USD);
  if (!Number.isFinite(n) || n <= 0) return 3;
  return n;
}

function keySpendKey(now: Date): string {
  return `cf:keyspend:${now.toISOString().slice(0, 10)}`;
}

/** True while today's key-path model spend is under the cap. */
export async function keySpendHasRoom(now = new Date()): Promise<boolean> {
  return (await getNumber(keySpendKey(now))) < dailyKeySpendCapUsd();
}

export async function addKeySpend(usd: number, now = new Date()): Promise<void> {
  if (usd > 0) await incrBy(keySpendKey(now), usd, 2 * DAY_SECONDS);
}
