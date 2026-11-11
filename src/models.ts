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

/** Dolphin's published price: $0.01 in / $0.07 out per million tokens. */
export const CHEAP: ModelSpec = {
  label: "Dolphin · DeepSeek V4.1 Flash",
  provider: "dolphin",
  model: "deepseek-ai/DeepSeek-V4.1-Flash",
  inputPerM: 0.01,
  outputPerM: 0.07,
};

export function dolphinKey(): string | undefined {
  // The key was saved once as DOLHPIN_API_KEY, so accept both spellings.
  return process.env.DOLPHIN_API_KEY || process.env.DOLHPIN_API_KEY;
}

/**
 * Looks up a SERV model's price from SERV's own model list. SERV lists
 * prices in US cents per million tokens.
 */
export async function servModel(label: string, model: string): Promise<ModelSpec> {
  const res = await fetch(SERV_MODELS_URL, { headers: { Authorization: `Bearer ${process.env.SERV_API_KEY}` } });
  if (!res.ok) throw new Error(`SERV model list returned ${res.status}`);
  const body = (await res.json()) as { items: { modelId: string; pricing: { input: number; output: number } }[] };
  const found = body.items.find((m) => m.modelId === model);
  if (!found) throw new Error(`SERV has no model ${model}`);
  return { label, provider: "serv", model, inputPerM: found.pricing.input / 100, outputPerM: found.pricing.output / 100 };
}

/** Room for long answers (and reasoning tokens) without hitting any model's cap. */
const MAX_TOKENS = 16_000;
const TIMEOUT_MS = 5 * 60_000;

export function costOf(spec: ModelSpec, inputTokens: number, outputTokens: number): number {
  return (inputTokens * spec.inputPerM + outputTokens * spec.outputPerM) / 1_000_000;
}

export async function chat(spec: ModelSpec, system: string, user: string): Promise<CallResult> {
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
        ...(spec.provider === "serv" ? { max_completion_tokens: MAX_TOKENS } : { max_tokens: MAX_TOKENS }),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  const started = Date.now();
  let res = await request();
  // Both APIs can return a brief 429 or 5xx; back off and retry a few times.
  for (let attempt = 1; attempt <= 3 && (res.status === 429 || res.status >= 500); attempt++) {
    const wait = Number(res.headers.get("retry-after")) * 1000 || attempt * 5000;
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
