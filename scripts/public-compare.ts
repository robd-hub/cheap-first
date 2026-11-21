/**
 * Replays the sample-and-arithmetic check on the published 300.
 * The cheap answer and the premium answer are read from data/public-benchmark.json.
 * The only model call is the extra cheap sample (one, the balanced pass mark).
 * The published file is not modified. Results go to data/public-compare.json.
 *
 *   npm run public-compare -- --dry-run
 *   npm run public-compare
 *   npm run public-compare -- gsm8k-0306     # these ids only, keeping the rest
 *   npm run public-compare -- --summary      # reprint the saved summary, no model calls
 *   npm run public-compare -- --rescore      # apply the current score bands to saved samples, no model calls
 */
import fs from "node:fs";
import { AUDIT_MAX_TOKENS, AUDIT_SYSTEM, AUDIT_TEMPERATURE, auditCountFor, scoreSamples, usesSampleCheck } from "../src/checkSignals.js";
import { PASS_MARK } from "../src/cheapFirst.js";
import { chat, CHEAP, type CallResult } from "../src/models.js";
import { summarizePublic, type ScoredRun } from "../src/publicGrade.js";
import { reportedPinMatches } from "./public-load.js";

interface CachedSide {
  answer: string;
  correct: boolean;
  costUsd: number;
  ms: number;
}

interface CachedRow {
  dataset: string;
  id: string;
  prompt: string;
  gold: string;
  labels?: string[];
  answeredBy: "cheap" | "premium";
  checkScore: number;
  cheap: CachedSide;
  premium: CachedSide;
  cheapFirst: { correct: boolean; costUsd: number; ms: number };
}

interface CachedFile {
  complete?: boolean;
  ranAt?: string;
  sample?: { seed?: number; datasets?: { id?: string; sha256?: string; sampleSize?: number }[] };
  summary?: unknown;
  rows?: CachedRow[];
}

interface CompareRow {
  id: string;
  dataset: string;
  gold: string;
  publishedAnsweredBy: "cheap" | "premium";
  publishedCheckScore: number;
  cheapCorrect: boolean;
  premiumCorrect: boolean;
  score: number;
  signal: string;
  reason: string;
  escalated: boolean;
  auditAnswer: string;
  auditCostUsd: number;
  cheapFirstCorrect: boolean;
  cheapFirstCostUsd: number;
  premiumCostUsd: number;
}

const PUBLISHED = "data/public-benchmark.json";
const OUT = "data/public-compare.json";
const CONCURRENCY = 4;
const args = process.argv.slice(2);

function readPublished(): CachedFile {
  if (!fs.existsSync(PUBLISHED)) throw new Error(`${PUBLISHED} is not in this checkout. The replay needs the published run.`);
  return JSON.parse(fs.readFileSync(PUBLISHED, "utf8")) as CachedFile;
}

async function oneAudit(prompt: string): Promise<CallResult> {
  try {
    return await chat(CHEAP, AUDIT_SYSTEM, prompt, AUDIT_MAX_TOKENS, AUDIT_TEMPERATURE);
  } catch (e) {
    if (!/returned 400/.test((e as Error).message)) throw e;
    return chat(CHEAP, AUDIT_SYSTEM, prompt, AUDIT_MAX_TOKENS);
  }
}

function toScored(row: CompareRow & { auditMs?: number }, cached: CachedRow): ScoredRun {
  const auditMs = row.auditMs ?? 0;
  const cheapFirstMs = cached.cheap.ms + auditMs + (row.escalated ? cached.premium.ms : 0);
  return {
    dataset: row.dataset,
    answeredBy: row.escalated ? "premium" : "cheap",
    cheapCorrect: row.cheapCorrect,
    cheapBlank: cached.cheap.answer.trim().length === 0,
    cheapFirstCorrect: row.cheapFirstCorrect,
    premiumCorrect: row.premiumCorrect,
    cheapFirstCostUsd: row.cheapFirstCostUsd,
    premiumCostUsd: row.premiumCostUsd,
    cheapFirstMs,
    premiumMs: cached.premium.ms,
  };
}

interface SavedCompare {
  rows?: (CompareRow & { auditMs?: number })[];
  publishedRanAt?: string;
}

function readOut(): SavedCompare {
  if (!fs.existsSync(OUT)) return { rows: [] };
  return JSON.parse(fs.readFileSync(OUT, "utf8")) as SavedCompare;
}

function writeOut(published: CachedFile, rows: (CompareRow & { auditMs?: number })[], cachedById: Map<string, CachedRow>): void {
  const order = new Map((published.rows ?? []).map((row, index) => [row.id, index]));
  const kept = rows.filter((row) => order.has(row.id)).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const summary = summarizePublic(kept.map((row) => toScored(row, cachedById.get(row.id)!)));
  const out = {
    benchmark: "public-compare",
    ranAt: new Date().toISOString(),
    source: PUBLISHED,
    sourceRanAt: published.ranAt ?? null,
    passMark: PASS_MARK,
    auditsPerQuestion: auditCountFor(PASS_MARK),
    note: "Cheap and premium answers are the published ones. Only the extra cheap sample was called. data/public-benchmark.json was not modified.",
    complete: kept.length === (published.rows ?? []).length,
    published: published.summary ?? null,
    summary,
    rows: kept,
  };
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}

async function main(): Promise<void> {
  const published = readPublished();
  if (!published.complete || !published.rows?.length) throw new Error(`${PUBLISHED} is not a finished run.`);
  if (!reportedPinMatches(published.sample)) throw new Error(`${PUBLISHED} is not the reported sample pin. It was not replayed.`);
  const rows = published.rows;
  const sampleRows = rows.filter((row) => usesSampleCheck(row.prompt));
  console.log(`Published run: ${rows.length} questions, ${sampleRows.length} with a comparable number or choice, pass mark ${PASS_MARK}, ${auditCountFor(PASS_MARK)} extra sample(s) each.`);
  if (args.includes("--dry-run")) {
    console.log("Dry run only. No model calls. data/public-benchmark.json and data/public-compare.json were not written.");
    console.log(`A real run calls the cheap model ${sampleRows.length * auditCountFor(PASS_MARK)} times and does not call the premium model.`);
    return;
  }
  if (args.includes("--summary") || args.includes("--rescore")) {
    const saved = readOut();
    if (!saved.rows?.length) throw new Error(`${OUT} has no rows.`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const source = args.includes("--rescore")
      ? saved.rows.map((row) => {
          const cached = byId.get(row.id);
          if (!cached) return row;
          const audits = row.auditAnswer ? row.auditAnswer.split("\n---\n") : [];
          const scored = cached.cheap.answer.trim()
            ? scoreSamples(cached.prompt, cached.cheap.answer, audits)
            : { score: 0, signal: "blank" as const, reason: "The cached cheap answer is empty." };
          const escalated = !cached.cheap.answer.trim() || scored.score < PASS_MARK;
          return {
            ...row,
            score: scored.score,
            signal: scored.signal,
            reason: scored.reason,
            escalated,
            cheapFirstCorrect: escalated ? cached.premium.correct : cached.cheap.correct,
            cheapFirstCostUsd: cached.cheap.costUsd + row.auditCostUsd + (escalated ? cached.premium.costUsd : 0),
          };
        })
      : saved.rows;
    if (args.includes("--rescore")) writeOut(published, source, byId);
    console.log(JSON.stringify(summarizePublic(source.map((row) => toScored(row, byId.get(row.id)!))), null, 2));
    return;
  }
  if (sampleRows.length !== rows.length) {
    const open = rows.filter((row) => !usesSampleCheck(row.prompt)).map((row) => row.id);
    throw new Error(`These published rows are not number or choice questions, so this replay does not grade them: ${open.join(", ")}`);
  }

  const only = args.filter((arg) => !arg.startsWith("--"));
  const todo = rows.filter((row) => only.length === 0 || only.includes(row.id));
  if (only.length && todo.length !== only.length) {
    const known = new Set(rows.map((row) => row.id));
    throw new Error(`Unknown question ids: ${only.filter((id) => !known.has(id)).join(", ")}`);
  }
  const cachedById = new Map(rows.map((row) => [row.id, row]));
  const done = (readOut().rows ?? []).filter((row) => !todo.some((item) => item.id === row.id));
  const out: (CompareRow & { auditMs?: number })[] = [...done];
  console.log(`Replaying ${todo.length} questions. Cached cheap and premium answers are reused.`);
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const audits: CallResult[] = [];
        for (let n = 0; n < auditCountFor(PASS_MARK); n++) audits.push(await oneAudit(item.prompt));
        const scored = scoreSamples(item.prompt, item.cheap.answer, audits.map((call) => call.text));
        const escalated = !item.cheap.answer.trim() || scored.score < PASS_MARK;
        const auditCostUsd = audits.reduce((sum, call) => sum + call.costUsd, 0);
        const auditMs = audits.reduce((sum, call) => sum + call.ms, 0);
        const row: CompareRow & { auditMs?: number } = {
          id: item.id,
          dataset: item.dataset,
          gold: item.gold,
          publishedAnsweredBy: item.answeredBy,
          publishedCheckScore: item.checkScore,
          cheapCorrect: item.cheap.correct,
          premiumCorrect: item.premium.correct,
          score: item.cheap.answer.trim() ? scored.score : 0,
          signal: item.cheap.answer.trim() ? scored.signal : "blank",
          reason: item.cheap.answer.trim() ? scored.reason : "The cached cheap answer is empty.",
          escalated,
          auditAnswer: audits.map((call) => call.text).join("\n---\n"),
          auditCostUsd,
          auditMs,
          cheapFirstCorrect: escalated ? item.premium.correct : item.cheap.correct,
          cheapFirstCostUsd: item.cheap.costUsd + auditCostUsd + (escalated ? item.premium.costUsd : 0),
          premiumCostUsd: item.premium.costUsd,
        };
        out.push(row);
        console.log(
          `${row.id}: score ${row.score} ${row.signal} -> ${row.escalated ? "premium" : "cheap"} | ` +
            `cheap ${row.cheapCorrect ? "right" : "wrong"}, replay ${row.cheapFirstCorrect ? "right" : "wrong"}, premium ${row.premiumCorrect ? "right" : "wrong"} | ` +
            `$${row.cheapFirstCostUsd.toFixed(5)}`,
        );
        writeOut(published, out, cachedById);
      }
    }),
  );
  const saved = readOut();
  console.log(JSON.stringify({ complete: (saved.rows ?? []).length === rows.length, summary: summarizePublic((saved.rows ?? []).map((row) => toScored(row, cachedById.get(row.id)!))) }, null, 2));
  if ((saved.rows ?? []).length !== rows.length) {
    throw new Error(`${rows.length - (saved.rows ?? []).length} questions failed. ${OUT} is incomplete.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
