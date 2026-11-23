/**
 * The three models Cheap First uses, all called through OpenAI-compatible
 * chat completion APIs:
 *
 *   cheap    Dolphin's DeepSeek V4.1 Flash (https://dphn.ai/docs/dphn-api)
 *   checker  a small model on SERV Reasoning that grades the cheap answer
 *   premium  a frontier model on SERV Reasoning, used only when the check fails
 *
 * Every call returns its token usage and its cost in US dollars, so the
 * savings shown on the site come from real usage, not estimates.
 */

export interface ModelSpec {
  /** Short label shown on the site. */
  label: string;
  provider: "dolphin" | "serv";
  model: string;
  /** US dollars per million input / output tokens. */
  inputPerM: number;
  outputPerM: number;
  /**
   * Sent as `reasoning_effort` when set. Both models think before they answer,
   * and that hidden thinking is most of the wait (see reasoningEffort below).
   */
  reasoningEffort?: string;
}

export interface CallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
}

const DOLPHIN_URL = "https://lighthouse.dphn.ai/run/text-v/v1/chat/completions";
const SERV_URL = "https://inference-api.openserv.ai/v1/chat/completions";
const SERV_MODELS_URL = "https://inference-api.openserv.ai/v1/models";

/**
 * How hard a model thinks before answering, from an environment variable.
 * Unset gives `fallback`; "default" sends nothing, so the provider decides.
 */
export function reasoningEffort(envValue: string | undefined, fallback: string | undefined): string | undefined {
  const value = (envValue ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return value === "default" ? undefined : value;
}

/**
 * Dolphin's published price: $0.01 in / $0.07 out per million tokens.
 *
 * DeepSeek V4.1 Flash thinks before it answers, and on Dolphin's default
 * setting it sometimes thinks for thousands of tokens. "low" scored the same
 * 288 of 300 on the published public questions, with the slowest answer
 * 8.3 s instead of 28.8 s and a third fewer output tokens. Turning thinking
 * off was faster still but scored 284. Set CF_CHEAP_REASONING=default to undo.
 */
export const CHEAP: ModelSpec = {
  label: "Dolphin · DeepSeek V4.1 Flash",
  provider: "dolphin",
  model: "deepseek-ai/DeepSeek-V4.1-Flash",
  inputPerM: 0.01,
  outputPerM: 0.07,
  reasoningEffort: reasoningEffort(process.env.CF_CHEAP_REASONING, "low"),
};

export function dolphinKey(): string | undefined {
  // The key was saved once as DOLHPIN_API_KEY, so accept both spellings.
  return process.env.DOLPHIN_API_KEY || process.env.DOLHPIN_API_KEY;
}

type ServList = { items: { modelId: string; pricing: { input: number; output: number } }[] };

let servList: Promise<ServList> | null = null;

/**
 * SERV's model list, fetched once per server instance and shared by every
 * model looked up from it. Fetching it once per model added about a second
 * to every cold start. A failed fetch is forgotten, so the next call retries.
 */
function servModelList(): Promise<ServList> {
  servList ??= (async () => {
    const res = await fetch(SERV_MODELS_URL, { headers: { Authorization: `Bearer ${process.env.SERV_API_KEY}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`SERV model list returned ${res.status}`);
    return (await res.json()) as ServList;
  })();
  servList.catch(() => {
    servList = null;
  });
  return servList;
}

/**
 * Looks up a SERV model's price from SERV's own model list. SERV lists
 * prices in US cents per million tokens.
 */
export async function servModel(label: string, model: string): Promise<ModelSpec> {
  const body = await servModelList();
  const found = body.items.find((m) => m.modelId === model);
  if (!found) throw new Error(`SERV has no model ${model}`);
  return { label, provider: "serv", model, inputPerM: found.pricing.input / 100, outputPerM: found.pricing.output / 100 };
}

/**
 * Waits before each retry when Dolphin says too many requests are running.
 * About 9 seconds in all, so a cheap answer still comes back sooner than
 * one 10-second wait did; after that the caller's fallback takes over.
 */
export const DOLPHIN_BUSY_WAITS_MS = [250, 500, 750, 1000, 1500, 2000, 3000];

/** Room for long answers (and reasoning tokens) without hitting any model's cap. */
const MAX_TOKENS = Number(process.env.CF_MAX_TOKENS) || 16_000;
const TIMEOUT_MS = 5 * 60_000;

export function costOf(spec: ModelSpec, inputTokens: number, outputTokens: number): number {
  return (inputTokens * spec.inputPerM + outputTokens * spec.outputPerM) / 1_000_000;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** `maxTokens` caps the answer length (and so its cost) for this one call. */
export async function chat(spec: ModelSpec, system: string, user: string, maxTokens = MAX_TOKENS, temperature?: number): Promise<CallResult> {
  return chatMessages(
    spec,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    maxTokens,
    temperature,
  );
}

/** Like `chat`, but with a whole conversation (system, user and assistant turns). */
export async function chatMessages(spec: ModelSpec, messages: ChatMessage[], maxTokens = MAX_TOKENS, temperature?: number): Promise<CallResult> {
  const key = spec.provider === "dolphin" ? dolphinKey() : process.env.SERV_API_KEY;
  if (!key) throw new Error(spec.provider === "dolphin" ? "DOLPHIN_API_KEY is not set" : "SERV_API_KEY is not set");
  const url = spec.provider === "dolphin" ? DOLPHIN_URL : SERV_URL;
  const request = () =>
    fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // Never hang forever on a stuck connection.
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: spec.model,
        // Set explicitly: SERV's own default can exceed the model's limit and fail with a 400.
        // SERV's OpenAI models want the newer parameter name.
        ...(spec.provider === "serv" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
        // Omitted by default so a normal answer keeps the provider's own sampling.
        ...(temperature !== undefined ? { temperature } : {}),
        ...(spec.reasoningEffort ? { reasoning_effort: spec.reasoningEffort } : {}),
        messages,
      }),
    });
  const started = Date.now();
  let res = await request();
  // Both APIs can return a brief 429 or 5xx; back off and retry a few times.
  // Dolphin's 429 is a cap on requests running at once ("retry after one
  // finishes"), and a slot is usually free within a second, so it is retried
  // quickly instead of waiting the 10 seconds its retry-after header asks for.
  const dolphin = spec.provider === "dolphin";
  for (let attempt = 0; ; attempt++) {
    const busy = dolphin && res.status === 429;
    if (!(res.status === 429 || res.status >= 500) || attempt >= (busy ? DOLPHIN_BUSY_WAITS_MS.length : 3)) break;
    const wait = busy ? DOLPHIN_BUSY_WAITS_MS[attempt] + Math.random() * 250 : Number(res.headers.get("retry-after")) * 1000 || (attempt + 1) * 5000;
    await res.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, wait));
    res = await request();
  }
  if (!res.ok) throw new Error(`${spec.label} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as {
    choices: { message: { content: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const inputTokens = body.usage?.prompt_tokens ?? 0;
  const outputTokens = body.usage?.completion_tokens ?? 0;
  return {
    text: body.choices[0]?.message.content ?? "",
    inputTokens,
    outputTokens,
    costUsd: costOf(spec, inputTokens, outputTokens),
    ms: Date.now() - started,
  };
}
