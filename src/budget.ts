/**
 * Guards against one expensive question (or many) draining the SERV balance.
 *
 * Every paid or free answer costs us the cheap answer plus a check, which is
 * tiny. An escalation to the premium model can cost far more than the
 * $0.005 we charge (in the benchmark, one escalated answer cost $0.19). So
 * escalations are capped two ways:
 *   - each premium answer is limited to PREMIUM_MAX_TOKENS tokens
 *   - each server instance stops escalating after spending the daily budget
 *     on the premium model, until the next day (UTC)
 *
 * The budget is kept in memory, so it's per server instance and resets when
 * Vercel starts a fresh one. It's a backstop, not an exact account.
 */
export const PREMIUM_MAX_TOKENS = Number(process.env.CF_PREMIUM_MAX_TOKENS) || 2000;

export class DailyBudget {
  private day = "";
  private spent = 0;
  constructor(readonly limitUsd: number) {}

  private roll(now: Date): void {
    const d = now.toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.spent = 0;
    }
  }

  /** True while there's budget left today. */
  hasRoom(now = new Date()): boolean {
    this.roll(now);
    return this.spent < this.limitUsd;
  }

  add(usd: number, now = new Date()): void {
    this.roll(now);
    this.spent += usd;
  }

  get spentToday(): number {
    return this.spent;
  }
}
