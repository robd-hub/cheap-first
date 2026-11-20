/**
 * POST /api/v1/chat/completions
 *
 * Cheap First behind the OpenAI chat completions format, so an app that
 * already uses an OpenAI-style client only changes its base URL to
 * https://cheapfirst.designimp.com/api/v1 (and pays with x402, like /api/pay).
 *
 * Supports the parts most apps use: `messages` (system, user and assistant
 * turns), `model` and `stream`. Models:
 *   cheap-first          the default pass mark (75)
 *   cheap-first-strict   escalates more often (85)
 *   cheap-first-budget   escalates less often (60)
 * Any other model name is treated as "cheap-first". Other parameters
 * (temperature, tools, ...) are ignored. With stream: true the whole answer
 * arrives as one chunk, because it's only released after the check.
 *
 * Each reply also carries a `cheap_first` field: who answered, the check
 * score, what it cost and what it saved against the premium model alone.
 */
import { paidPremiumBudget as premiumBudget, PREMIUM_MAX_TOKENS } from "../../../src/budget.js";
import { cheapFirst, defaultModels, EscalationBlocked, MODES, savings, type Mode, type Models } from "../../../src/cheapFirst.js";
import { noteCheapFirst } from "../../../src/liveStats.js";
import type { ChatMessage } from "../../../src/models.js";
import { json, paidCall, PAID_CORS, unpaidChallenge } from "../../../src/paid.js";
import type { Offer } from "../../../src/x402.js";

/** Total characters across all messages. Long conversations are pricey on the premium model. */
const MAX_CHARS = 6000;
const MAX_MESSAGES = 40;
let models: Models | null = null;

export const MODEL_MODES: Record<string, Mode> = {
  "cheap-first": "balanced",
  "cheap-first-strict": "strict",
  "cheap-first-budget": "budget",
};

export const OFFER: Offer = {
  description: "One OpenAI-style chat completion from Cheap First: Dolphin answers, SERV checks, and a premium model steps in only if the check fails.",
  example: {
    body: { model: "cheap-first", messages: [{ role: "user", content: "What is the capital of Australia?" }] },
    output: { object: "chat.completion", model: "cheap-first", choices: [{ index: 0, message: { role: "assistant", content: "Canberra." }, finish_reason: "stop" }] },
  },
  outputSchema: {
    input: {
      type: "http",
      method: "POST",
      bodyType: "json",
      bodyFields: {
        messages: { type: "array", required: true, description: "OpenAI-style messages (system, user, assistant), up to 6,000 characters in total" },
        model: { type: "string", required: false, description: "cheap-first, cheap-first-strict or cheap-first-budget" },
        stream: { type: "boolean", required: false },
      },
    },
    output: { object: "chat.completion", choices: "array", usage: "object", cheap_first: "object" },
  },
};

/** OpenAI-style error body. */
function error(message: string, status: number, type = "invalid_request_error"): Response {
  return json({ error: { message, type } }, status);
}

/** Reads and checks the messages. Returns an error message instead if they aren't usable. */
export function parseMessages(raw: unknown): ChatMessage[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "`messages` must be a non-empty array.";
  if (raw.length > MAX_MESSAGES) return `Send at most ${MAX_MESSAGES} messages.`;
  const out: ChatMessage[] = [];
  for (const m of raw) {
    const role = (m as { role?: unknown })?.role;
    let content = (m as { content?: unknown })?.content;
    // Accept the newer "content parts" form, text parts only.
    if (Array.isArray(content)) {
      content = content
        .map((p) => ((p as { type?: unknown })?.type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
        .join("");
    }
    if (role === "developer") out.push({ role: "system", content: String(content ?? "") });
    else if (role === "system" || role === "user" || role === "assistant") out.push({ role, content: String(content ?? "") });
    else return "Only system, user and assistant messages are supported.";
  }
  if (out.at(-1)?.role !== "user") return "The last message must be from the user.";
  const chars = out.reduce((n, m) => n + m.content.length, 0);
  if (chars > MAX_CHARS) return `Keep the conversation under ${MAX_CHARS} characters in total.`;
  if (!out.some((m) => m.role === "user" && m.content.trim())) return "Include a user message.";
  return out;
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: PAID_CORS });
}

export async function POST(request: Request): Promise<Response> {
  const unpaid = unpaidChallenge(request, OFFER);
  if (unpaid) return unpaid;
  let body: { messages?: unknown; model?: unknown; stream?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Send a JSON body with `messages`.", 400);
  }
  const messages = parseMessages(body.messages);
  if (typeof messages === "string") return error(messages, 400);
  const modelName = typeof body.model === "string" && body.model in MODEL_MODES ? body.model : "cheap-first";
  const mode = MODEL_MODES[modelName];
  const stream = body.stream === true;

  return paidCall(request, OFFER, async () => {
    try {
      models ??= await defaultModels();
      const m = models;
      const r = await cheapFirst(messages, m, undefined, {
        premiumMaxTokens: PREMIUM_MAX_TOKENS,
        canEscalate: () => premiumBudget.hasRoom(),
        passMark: MODES[mode],
      });
      if (r.premium) await premiumBudget.add(r.premium.costUsd);
      const used = r.premium ?? r.cheap;
      const { premiumOnlyUsd, savedUsd } = savings(r, m);
      const id = `chatcmpl-cf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);
      const extra = {
        answered_by: r.answeredBy,
        answered_by_model: r.answeredBy === "cheap" ? m.cheap.label : m.premium.label,
        mode,
        check: { score: r.check.score, reason: r.check.reason },
        cost_usd: r.costUsd,
        premium_only_usd: premiumOnlyUsd,
        saved_usd: savedUsd,
      };
      const usage = { prompt_tokens: used.inputTokens, completion_tokens: used.outputTokens, total_tokens: used.inputTokens + used.outputTokens };
      return {
        respond: (paid, headers) => {
          noteCheapFirst("chat", r, m, MODES[mode]);
          if (!stream) {
            return json(
              {
                id,
                object: "chat.completion",
                created,
                model: modelName,
                choices: [{ index: 0, message: { role: "assistant", content: r.answer }, finish_reason: "stop" }],
                usage,
                cheap_first: { ...extra, paid },
              },
              200,
              headers,
            );
          }
          const chunk = (delta: unknown, finish: string | null, more: Record<string, unknown> = {}) =>
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: modelName, choices: [{ index: 0, delta, finish_reason: finish }], ...more })}\n\n`;
          const sse =
            chunk({ role: "assistant", content: r.answer }, null) +
            chunk({}, "stop", { usage, cheap_first: { ...extra, paid } }) +
            "data: [DONE]\n\n";
          return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...PAID_CORS, ...headers } });
        },
      };
    } catch (e) {
      if (e instanceof EscalationBlocked) {
        return error("This request needs the premium model, which has hit today's limit. You haven't been charged. Please try again tomorrow.", 503, "server_error");
      }
      console.error(e);
      return error("Something went wrong reaching the models. You haven't been charged. Please try again.", 502, "server_error");
    }
  });
}
