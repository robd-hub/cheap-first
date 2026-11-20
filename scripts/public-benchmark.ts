/**
 * Public benchmark: Cheap First against always using the premium model,
 * on a fixed sample of GSM8K and ARC-Challenge. Answers are graded by code
 * against the published answer. The checker does not see the answer key.
 *
 *   npm run public-benchmark             # the pinned sample, writes data/public-benchmark.json
 *   npm run public-benchmark -- gsm8k-0007   # rerun these ids, keeping the rest
 *   npm run public-benchmark -- --dry-run    # download, check hashes, print the sample, no model calls
 *   npm run public-benchmark -- --regrade    # apply the grader again, no model calls
 *
 * The sample, seed, and file hashes live in src/publicSets.ts. A results
 * file from a different pin is left untouched.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { inflateRawSync } from "node:zlib";
import { cheapFirst, defaultModels, PASS_MARK, SYSTEM_PROMPT } from "../src/cheapFirst";
import { chat } from "../src/models";
import { arcPrompt, datasetSeed, gradeArc, gradeGsm8kNumber, gsm8kGold, gsm8kPrompt, selectSample, summarizePublic, type Grade, type ScoredRun } from "../src/publicGrade";
import { ARC, GSM8K, PUBLIC_GRADING, SAMPLE_SEED } from "../src/publicSets";

interface Item {
  dataset: "gsm8k" | "arc";
  id: string;
  prompt: string;
  gold: string;
  labels?: string[];
}

interface Side extends Grade {
  answer: string;
  costUsd: number;
  ms: number;
}

interface Row extends Item {
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
  sample?: { seed?: number; datasets?: { id?: string; sha256?: string; sampleSize?: number }[] };
  models?: unknown;
  ranAt?: string;
  rows?: Row[];
  failures?: Failure[];
}

const RESULTS = "data/public-benchmark.json";
const CONCURRENCY = 4;
const args = process.argv.slice(2);

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function expectHash(buf: Buffer, expected: string, label: string): void {
  const got = sha256(buf);
  if (got !== expected) throw new Error(`${label} sha256 is ${got}, expected ${expected}. The pinned file changed or the download was cut off.`);
}

async function download(url: string, headers?: Record<string, string>): Promise<{ status: number; body: Buffer }> {
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

async function loadGsm8k(): Promise<Item[]> {
  const { status, body } = await download(GSM8K.url);
  if (status !== 200) throw new Error(`GSM8K download returned ${status}.`);
  expectHash(body, GSM8K.sha256, "GSM8K test.jsonl");
  const items: Item[] = [];
  for (const line of body.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { question: string; answer: string };
    items.push({
      dataset: "gsm8k",
      id: `gsm8k-${String(items.length).padStart(4, "0")}`,
      prompt: gsm8kPrompt(row.question),
      gold: gsm8kGold(row.answer),
    });
  }
  if (items.length !== GSM8K.population) throw new Error(`GSM8K has ${items.length} questions, expected ${GSM8K.population}.`);
  return selectSample(items, GSM8K.sampleSize, datasetSeed(GSM8K.id), (item) => item.id);
}

async function loadArc(): Promise<Item[]> {
  const end = ARC.rangeStart + ARC.rangeLength - 1;
  const { status, body } = await download(ARC.url, { Range: `bytes=${ARC.rangeStart}-${end}` });
  if (status !== 206) throw new Error(`ARC range request returned ${status}. The full archive is not downloaded.`);
  if (body.length !== ARC.rangeLength) throw new Error(`ARC range was ${body.length} bytes, expected ${ARC.rangeLength}.`);
  const raw = inflateRawSync(body);
  expectHash(raw, ARC.sha256, "ARC-Challenge-Test.jsonl");
  const items: Item[] = [];
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { id: string; answerKey: string; question: { stem: string; choices: { text: string; label: string }[] } };
    const labels = row.question.choices.map((choice) => choice.label);
    items.push({
      dataset: "arc",
      id: `arc:${row.id}`,
      prompt: arcPrompt(row.question.stem, row.question.choices),
      gold: row.answerKey,
      labels,
    });
  }
  if (items.length !== ARC.population) throw new Error(`ARC-Challenge test has ${items.length} questions, expected ${ARC.population}.`);
  return selectSample(items, ARC.sampleSize, datasetSeed(ARC.id), (item) => item.id);
}

function sampleMeta() {
  return {
    seed: SAMPLE_SEED,
    datasets: [
      {
        id: GSM8K.id,
        name: GSM8K.name,
        split: GSM8K.split,
        population: GSM8K.population,
        sampleSize: GSM8K.sampleSize,
        source: GSM8K.url,
        revision: GSM8K.revision,
        sha256: GSM8K.sha256,
      },
      {
        id: ARC.id,
        name: ARC.name,
        split: ARC.split,
        population: ARC.population,
        sampleSize: ARC.sampleSize,
        source: ARC.url,
        member: ARC.member,
        sha256: ARC.sha256,
        byteRange: [ARC.rangeStart, ARC.rangeStart + ARC.rangeLength - 1],
      },
    ],
  };
}

function samePin(prev: Saved): boolean {
  if (prev.sample?.seed !== SAMPLE_SEED) return false;
  const sets = prev.sample.datasets ?? [];
  const gsm = sets.find((d) => d.id === "gsm8k");
  const arc = sets.find((d) => d.id === "arc");
  return gsm?.sha256 === GSM8K.sha256 && gsm.sampleSize === GSM8K.sampleSize && arc?.sha256 === ARC.sha256 && arc.sampleSize === ARC.sampleSize;
}

function gradeText(item: Item, answer: string): Grade {
  return item.dataset === "gsm8k" ? gradeGsm8kNumber(answer, item.gold) : gradeArc(answer, item.gold, item.labels ?? []);
}

function applyGrades(row: Row): Row {
  const item: Item = { dataset: row.dataset, id: row.id, prompt: row.prompt, gold: row.gold, labels: row.labels };
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

function save(items: Item[], rows: Row[], failures: Failure[], models: unknown, ranAt: string): void {
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

async function runOne(item: Item, models: Awaited<ReturnType<typeof defaultModels>>): Promise<Row> {
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
  const items = [...(await loadGsm8k()), ...(await loadArc())];
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
  if (fs.existsSync(RESULTS) && !samePin(previous)) {
    throw new Error(`${RESULTS} was produced with a different sample pin. Delete it to start over. It was not overwritten.`);
  }
  if (args.includes("--regrade")) {
    if (!previous.rows?.length) throw new Error(`${RESULTS} has no rows to regrade.`);
    const rows = previous.rows.map(applyGrades);
    save(items, rows, previous.failures ?? [], previous.models ?? null, previous.ranAt ?? new Date().toISOString());
    console.log(JSON.stringify(summarizePublic(rows.map(toScored)), null, 2));
    return;
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
