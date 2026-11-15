/**
 * Card payments through Stripe, with no Stripe library: the only call is
 * reading a Checkout Session to confirm it was paid.
 *
 * Setup (once Stripe is set up): make a Stripe Payment Link, set its
 * "after payment" redirect to
 *   https://cheap-first.vercel.app/api/key?session={CHECKOUT_SESSION_ID}
 * and add STRIPE_SECRET_KEY (a restricted key with "Checkout Sessions: read"
 * is enough) to the Vercel project.
 */
const API = "https://api.stripe.com/v1";

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export interface PaidSession {
  id: string;
  /** In the smallest currency unit, e.g. cents. */
  amountTotal: number;
  currency: string;
  created: Date;
}

/** Stripe Checkout Session ids look like cs_live_... or cs_test_... */
export function isSessionId(text: string): boolean {
  return /^cs_(live|test)_[A-Za-z0-9]{10,200}$/.test(text);
}

/** Returns the session if Stripe says it's paid, otherwise a reason it isn't. */
export async function paidSession(id: string): Promise<PaidSession | { error: string }> {
  if (!stripeConfigured()) return { error: "Card payments aren't switched on yet." };
  if (!isSessionId(id)) return { error: "That isn't a Stripe checkout id." };
  const res = await fetch(`${API}/checkout/sessions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return { error: "Stripe doesn't know that checkout." };
  if (!res.ok) return { error: `Stripe returned ${res.status}.` };
  const s = (await res.json()) as { id: string; payment_status?: string; amount_total?: number; currency?: string; created?: number };
  if (s.payment_status !== "paid") return { error: "That checkout hasn't been paid." };
  return { id: s.id, amountTotal: s.amount_total ?? 0, currency: (s.currency ?? "").toLowerCase(), created: new Date((s.created ?? 0) * 1000) };
}
