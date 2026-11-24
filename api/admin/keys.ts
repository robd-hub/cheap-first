/**
 * POST /api/admin/keys
 *
 * Creates one trial cf_ key. Rob calls this with CF_ADMIN_TOKEN. The plaintext
 * key is in the response and is not stored. Card payments are not involved.
 *
 *   curl -sS -X POST https://cheap-first.vercel.app/api/admin/keys \
 *     -H "Authorization: Bearer $CF_ADMIN_TOKEN" \
 *     -H "Content-Type: application/json" \
 *     -d '{"answers":200,"label":"ada"}'
 *
 * `answers` defaults to 200 (or CF_TRIAL_ANSWERS). `label` is an optional note.
 */
import { dailyKeySpendCapUsd } from "../../src/budget.js";
import { adminTokenMatches, issueTrialKey, keyRatePerMin, keysAvailable, parseAnswerCap, parseLabel } from "../../src/keys.js";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function presentedToken(request: Request): string {
  const header = request.headers.get("x-admin-token");
  if (header?.trim()) return header.trim();
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? "";
}

export async function POST(request: Request): Promise<Response> {
  if (!(process.env.CF_ADMIN_TOKEN ?? "")) {
    return json({ error: "Set CF_ADMIN_TOKEN to issue trial keys." }, 503);
  }
  if (!adminTokenMatches(presentedToken(request))) {
    return json({ error: "Send Authorization: Bearer and the CF_ADMIN_TOKEN value." }, 401);
  }
  if (!keysAvailable()) {
    return json({ error: "Trial keys need Upstash. Set KV_REST_API_URL and KV_REST_API_TOKEN (or the UPSTASH_REDIS_REST pair)." }, 503);
  }

  let body: { answers?: unknown; label?: unknown } = {};
  const text = await request.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return json({ error: 'Send JSON like {"answers":200,"label":"name"}.' }, 400);
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: 'Send JSON like {"answers":200,"label":"name"}.' }, 400);
  }
  const answers = parseAnswerCap(body.answers);
  if (typeof answers === "string") return json({ error: answers }, 400);
  const label = parseLabel(body.label);
  if (label === "invalid") return json({ error: "label must be text." }, 400);

  const issued = await issueTrialKey({ answers, label });
  return json(
    {
      key: issued.key,
      answers: issued.answers,
      ...(issued.label ? { label: issued.label } : {}),
      ratePerMinute: keyRatePerMin(),
      dailySpendCapUsd: dailyKeySpendCapUsd(),
    },
    201,
  );
}
