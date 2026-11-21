/**
 * Public benchmark: Cheap First against always using the premium model,
 * on a fixed sample of GSM8K and ARC-Challenge. Answers are graded by code
 * against the published answer. The checker does not see the answer key.
 *
 *   npm run public-benchmark             # the pinned sample, writes data/public-benchmark.json
 *   npm run public-benchmark -- gsm8k-0007   # rerun these ids, keeping the rest
 *   npm run public-benchmark -- --dry-run    # download, check hashes, print the sample, no model calls
 *   npm run public-benchmark -- --regrade    # apply the grader again, no model calls
 *   npm run public-benchmark -- --rerun      # replace a finished file (the published run refuses without this)
 *
 * The sample, seed, and file hashes live in src/publicSets.ts. A results
 * file from a different pin is left untouched.
 */
import fs from "node:fs";
import { cheapFirst, defaultModels, PASS_MARK, SYSTEM_PROMPT } from "../src/cheapFirst";
import { chat } from "../src/models";
import { gradeArc, gradeGsm8kNumber, summarizePublic, type Grade, type ScoredRun } from "../src/publicGrade";
import { ARC, GSM8K, PUBLIC_GRADING, SAMPLE_SEED } from "../src/publicSets";
import { loadPopulations, reportedItems, reportedPinMatches, sampleMeta, type PublicItem } from "./public-load";

interface Side extends Grade {
  answer: string;
  costUsd: number;
  ms: number;
}

interface Row extends PublicItem {
  answeredBy: "cheap" | "premium";
  checkScore: number;
  checkReason: string;
  cheap: Side;
  checkCostUsd: number;
  checkMs: number;
  cheapFirst: Side;
  premium: Side;
}

interface Failure {
  id: string;
  error: string;
}

interface Saved {
  complete?: boolean;
  sample?: { seed?: number; datasets?: { id?: string; sha256?: string; sampleSize?: number }[] };
  models?: unknown;
  ranAt?: string;
  rows?: Row[];
  failures?: Failure[];
}

const RESULTS = "data/public-benchmark.json";
const CONCURRENCY = 4;
const args = process.argv.slice(2);

function gradeText(item: PublicItem, answer: string): Grade {
  return item.dataset === "gsm8k" ? gradeGsm8kNumber(answer, item.gold) : gradeArc(answer, item.gold, item.labels ?? []);
}

function applyGrades(row: Row): Row {
  const item: PublicItem = { dataset: row.dataset, id: row.id, prompt: row.prompt, gold: row.gold, labels: row.labels };
  return {
    ...row,
    cheap: { ...row.cheap, ...gradeText(item, row.cheap.answer) },
    cheapFirst: { ...row.cheapFirst, ...gradeText(item, row.cheapFirst.answer) },
    premium: { ...row.premium, ...gradeText(item, row.premium.answer) },
  };
}

function toScored(row: Row): ScoredRun {
  return {
    dataset: row.dataset,
    answeredBy: row.answeredBy,
    cheapCorrect: row.cheap.correct,
    cheapBlank: row.cheap.answer.trim().length === 0,
    cheapFirstCorrect: row.cheapFirst.correct,
    premiumCorrect: row.premium.correct,
    cheapFirstCostUsd: row.cheapFirst.costUsd,
    premiumCostUsd: row.premium.costUsd,
    cheapFirstMs: row.cheapFirst.ms,
    premiumMs: row.premium.ms,
  };
}

function readSaved(): Saved {
  if (!fs.existsSync(RESULTS)) return { rows: [] };
  return JSON.parse(fs.readFileSync(RESULTS, "utf8")) as Saved;
}

function save(items: PublicItem[], rows: Row[], failures: Failure[], models: unknown, ranAt: string): void {
  const order = new Map(items.map((item, index) => [item.id, index]));
  const kept = rows.filter((row) => order.has(row.id)).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const missing = new Set(items.map((item) => item.id).filter((id) => !kept.some((row) => row.id === id)));
  const open = failures.filter((failure) => missing.has(failure.id));
  const out = {
    benchmark: "public",
    ranAt,
    regradedAt: args.includes("--regrade") ? new Date().toISOString() : undefined,
    complete: missing.size === 0,
    expected: items.length,
    passMark: PASS_MARK,
    grading: PUBLIC_GRADING,
    sample: sampleMeta(),
    models,
    summary: summarizePublic(kept.map(toScored)),
    failures: open,
    rows: kept,
  };
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2) + "\n");
}

async function runOne(item: PublicItem, models: Awaited<ReturnType<typeof defaultModels>>): Promise<Row> {
  const cf = await cheapFirst(item.prompt, models, undefined, { fallbackOnCheapError: false });
  const premium = cf.premium ?? (await chat(models.premium, SYSTEM_PROMPT, item.prompt));
  const cfMs = cf.cheap.ms + cf.check.call.ms + (cf.premium?.ms ?? 0);
  return applyGrades({
    ...item,
    answeredBy: cf.answeredBy,
    checkScore: cf.check.score,
    checkReason: cf.check.reason,
    cheap: { answer: cf.cheap.text, costUsd: cf.cheap.costUsd, ms: cf.cheap.ms, correct: false, note: "" },
    checkCostUsd: cf.check.call.costUsd,
    checkMs: cf.check.call.ms,
    cheapFirst: { answer: cf.answer, costUsd: cf.costUsd, ms: cfMs, correct: false, note: "" },
    premium: { answer: premium.text, costUsd: premium.costUsd, ms: premium.ms, correct: false, note: "" },
  });
}

async function main(): Promise<void> {
  const items = reportedItems(await loadPopulations());
  console.log(
    `Public sample: ${items.length} questions (GSM8K ${GSM8K.sampleSize} of ${GSM8K.population}, ARC-Challenge ${ARC.sampleSize} of ${ARC.population}), seed ${SAMPLE_SEED}.`,
  );
  if (args.includes("--dry-run")) {
    for (const dataset of ["gsm8k", "arc"] as const) {
      const ids = items.filter((item) => item.dataset === dataset).map((item) => item.id);
      console.log(`${dataset}: ${ids.length} ids, first ${ids[0]}, last ${ids[ids.length - 1]}`);
    }
    console.log("Dry run only. No model calls, and data/public-benchmark.json was not written.");
    return;
  }

  const previous = readSaved();
  if (fs.existsSync(RESULTS) && !reportedPinMatches(previous.sample)) {
    throw new Error(`${RESULTS} was produced with a different sample pin. Delete it to start over. It was not overwritten.`);
  }
  if (args.includes("--regrade")) {
    if (!previous.rows?.length) throw new Error(`${RESULTS} has no rows to regrade.`);
    const rows = previous.rows.map(applyGrades);
    save(items, rows, previous.failures ?? [], previous.models ?? null, previous.ranAt ?? new Date().toISOString());
    console.log(JSON.stringify(summarizePublic(rows.map(toScored)), null, 2));
    return;
  }

  if (previous.complete && !args.includes("--rerun")) {
    throw new Error(
      `${RESULTS} is the published ${previous.rows?.length ?? 0}-question run. It was not changed. Replay the check on those cached answers with npm run public-compare. Pass --rerun only to replace that file.`,
    );
  }

  const only = args.filter((arg) => !arg.startsWith("--"));
  const todo = items.filter((item) => only.length === 0 || only.includes(item.id));
  if (only.length && todo.length !== only.length) {
    const known = new Set(items.map((item) => item.id));
    const missing = only.filter((id) => !known.has(id));
    throw new Error(`Unknown question ids: ${missing.join(", ")}`);
  }
  const models = await defaultModels();
  const rows = (previous.rows ?? []).filter((row) => !todo.some((item) => item.id === row.id));
  const failures: Failure[] = (previous.failures ?? []).filter((failure) => !todo.some((item) => item.id === failure.id));
  const ranAt = new Date().toISOString();
  console.log(`Running ${todo.length} questions. Each one calls the cheap model, the checker, and the premium model.`);
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          const row = await runOne(item, models);
          rows.push(row);
          console.log(
            `${row.id}: check ${row.checkScore} -> ${row.answeredBy} | Dolphin ${row.cheap.correct ? "right" : "wrong"}, ` +
              `Cheap First ${row.cheapFirst.correct ? "right" : "wrong"}, premium ${row.premium.correct ? "right" : "wrong"} | ` +
              `$${row.cheapFirst.costUsd.toFixed(5)} vs $${row.premium.costUsd.toFixed(5)} | ${row.cheapFirst.ms}ms vs ${row.premium.ms}ms`,
          );
        } catch (e) {
          const error = (e as Error).message;
          failures.push({ id: item.id, error });
          console.log(`${item.id}: failed (${error})`);
        }
        save(items, rows, failures, models, ranAt);
      }
    }),
  );
  const saved = readSaved();
  const summary = summarizePublic((saved.rows ?? []).map(toScored));
  console.log(JSON.stringify({ complete: (saved.rows ?? []).length === items.length, ...summary }, null, 2));
  if ((saved.rows ?? []).length !== items.length) {
    throw new Error(`${items.length - (saved.rows ?? []).length} questions failed. ${RESULTS} is incomplete and was not treated as a finished run.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
