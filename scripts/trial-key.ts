/**
 * Create one trial cf_ key in the shared store.
 *
 *   npm run trial-key -- --answers 200 --label ada
 *
 * Needs KV_REST_API_URL and KV_REST_API_TOKEN (or the UPSTASH_REDIS_REST pair).
 * Prints the key once. Only a hash is stored. Does not turn Stripe on.
 */
import { existsSync } from "node:fs";
import { dailyKeySpendCapUsd } from "../src/budget.js";
import { issueTrialKey, keyRatePerMin, keysAvailable, parseAnswerCap, parseLabel } from "../src/keys.js";

export function parseTrialArgs(argv: string[]): { answers?: unknown; label?: unknown; help?: boolean; error?: string } {
  let answers: unknown;
  let label: unknown;
  const take = (i: number, name: string): { used: number; value?: string; missing?: boolean } | null => {
    const arg = argv[i];
    const prefix = `--${name}=`;
    if (arg === `--${name}`) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { used: 1, missing: true };
      return { used: 2, value };
    }
    if (arg.startsWith(prefix)) return { used: 1, value: arg.slice(prefix.length) };
    return null;
  };
  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    const answersValue = take(i, "answers");
    if (answersValue) {
      if (answersValue.missing || answersValue.value === "") return { error: "Pass a number after --answers." };
      answers = answersValue.value;
      i += answersValue.used;
      continue;
    }
    const labelValue = take(i, "label");
    if (labelValue) {
      if (labelValue.missing) return { error: "Pass text after --label." };
      label = labelValue.value;
      i += labelValue.used;
      continue;
    }
    return { error: `Unknown argument ${arg}.` };
  }
  return { answers, label };
}

function usage(): string {
  return `Usage: npm run trial-key -- [--answers 200] [--label name]

Creates a trial cf_ key in Upstash. Needs KV_REST_API_URL and KV_REST_API_TOKEN
(or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN). answers defaults to 200.`;
}

async function main(): Promise<void> {
  const envFile = new URL("../.env", import.meta.url);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const parsed = parseTrialArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return;
  }
  if (parsed.error) {
    console.error(parsed.error);
    console.error(usage());
    process.exit(1);
  }
  const answers = parseAnswerCap(parsed.answers);
  if (typeof answers === "string") {
    console.error(answers);
    process.exit(1);
  }
  const label = parseLabel(parsed.label);
  if (label === "invalid") {
    console.error("label must be text.");
    process.exit(1);
  }
  if (!keysAvailable()) {
    console.error("Trial keys need Upstash. Set KV_REST_API_URL and KV_REST_API_TOKEN (or the UPSTASH_REDIS_REST pair).");
    process.exit(1);
  }
  const issued = await issueTrialKey({ answers, label });
  console.log(issued.key);
  const note = issued.label ? ` Label: ${issued.label}.` : "";
  console.log(`${issued.answers} answers.${note} Rate limit ${keyRatePerMin()}/min. Daily key spend cap $${dailyKeySpendCapUsd()}.`);
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("trial-key.ts") || entry.endsWith("trial-key.js")) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
