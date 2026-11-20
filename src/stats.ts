/**
 * Headline numbers from the saved benchmarks. The MCP stats tool and the
 * site both read these files, so the figures an agent quotes are the ones
 * on the results page.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPublicReport, type PublicReport } from "./publicReport.js";

interface Side {
  score: number;
  costUsd: number;
}
interface Row {
  answeredBy: "cheap" | "premium";
  cheapFirst: Side;
  premium: Side;
}
interface ResultsFile {
  ranAt: string;
  passMark: number;
  models: Record<"cheap" | "checker" | "premium", { label: string }>;
  rows: Row[];
}
interface HardFile {
  summary?: { questions?: number; correct?: { cheapFirst?: number }; costUsd?: { cheapFirst?: number; premium?: number } };
}

export interface UsdPair {
  cheapFirst: number;
  premiumOnly: number;
}

export interface BenchmarkHeadline {
  questions: number;
  /** Rounded to cents, which is how the site and the README quote them. */
  cheapFirstUsd: number;
  premiumOnlyUsd: number;
  savingPct: number;
  answeredByDolphin: number;
  escalated: number;
  averageQuality: number;
  premiumAverageQuality: number;
  ranAt: string;
  passMark: number;
  models: { cheap: string; checker: string; premium: string };
  exactUsd: UsdPair;
  summary: string;
}

export interface HardHeadline {
  questions: number;
  correct: number;
  cheapFirstUsd: number;
  premiumOnlyUsd: number;
  savingPct: number;
  exactUsd: UsdPair;
  summary: string;
}

export interface StatsReport {
  /** The 143-question benchmark on the results page. */
  benchmark: BenchmarkHeadline;
  /** The harder set, graded by code. Null when those files aren't in the build. */
  hardBenchmark: HardHeadline | null;
  /**
   * The public GSM8K and ARC-Challenge run, graded by code.
   * Null when data/public-benchmark.json is missing or incomplete.
   */
  publicBenchmark: PublicReport | null;
  resultsPage: string;
}

const RESULTS_PAGE = "https://robd-hub.github.io/cheap-first/";

export function roundTo(n: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

const dollars = (n: number) => `$${n.toFixed(2)}`;
const points = (n: number) => n.toFixed(1);

function dataFile(name: string): string {
  return fileURLToPath(new URL(`../data/${name}`, import.meta.url));
}

function readJson<T>(name: string): T | null {
  const path = dataFile(name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** The published benchmark, from data/results.json and the hard-benchmark files. */
export function loadBenchmarkReport(): StatsReport {
  const results = readJson<ResultsFile>("results.json");
  if (!results?.rows?.length) throw new Error("data/results.json has no benchmark rows.");
  const hard = ["hard-results.json", "stress-results.json"].map((name) => readJson<HardFile>(name)?.summary).filter((s): s is NonNullable<HardFile["summary"]> => Boolean(s?.questions));
  return { ...reportFrom(results, hard), publicBenchmark: loadPublicReport() };
}

export function reportFrom(results: ResultsFile, hard: NonNullable<HardFile["summary"]>[] = []): StatsReport {
  const rows = results.rows;
  if (!rows.length) throw new Error("Benchmark file has no questions.");
  if (!results.models?.cheap || !results.models.checker || !results.models.premium) throw new Error("Benchmark file is missing model labels.");
  const questions = rows.length;
  const cheapFirst = rows.reduce((sum, row) => sum + row.cheapFirst.costUsd, 0);
  const premiumOnly = rows.reduce((sum, row) => sum + row.premium.costUsd, 0);
  const answeredByDolphin = rows.filter((row) => row.answeredBy === "cheap").length;
  const average = (pick: (row: Row) => number) => rows.reduce((sum, row) => sum + pick(row), 0) / questions;
  const cheapFirstUsd = roundTo(cheapFirst, 2);
  const premiumOnlyUsd = roundTo(premiumOnly, 2);
  const savingPct = premiumOnly > 0 ? Math.round((1 - cheapFirst / premiumOnly) * 100) : 0;
  const averageQuality = roundTo(average((row) => row.cheapFirst.score), 1);
  const premiumAverageQuality = roundTo(average((row) => row.premium.score), 1);
  const benchmark: BenchmarkHeadline = {
    questions,
    cheapFirstUsd,
    premiumOnlyUsd,
    savingPct,
    answeredByDolphin,
    escalated: questions - answeredByDolphin,
    averageQuality,
    premiumAverageQuality,
    ranAt: results.ranAt,
    passMark: results.passMark,
    models: {
      cheap: results.models.cheap.label,
      checker: results.models.checker.label,
      premium: results.models.premium.label,
    },
    exactUsd: { cheapFirst, premiumOnly },
    summary: `${questions} questions cost ${dollars(cheapFirstUsd)} with Cheap First against ${dollars(premiumOnlyUsd)} premium-only (${savingPct}% less). Dolphin answered ${answeredByDolphin} of them. Average quality ${points(averageQuality)} vs ${points(premiumAverageQuality)}.`,
  };

  let hardBenchmark: HardHeadline | null = null;
  if (hard.length) {
    const hardQuestions = hard.reduce((sum, set) => sum + (set.questions ?? 0), 0);
    const correct = hard.reduce((sum, set) => sum + (set.correct?.cheapFirst ?? 0), 0);
    const hardCheap = hard.reduce((sum, set) => sum + (set.costUsd?.cheapFirst ?? 0), 0);
    const hardPremium = hard.reduce((sum, set) => sum + (set.costUsd?.premium ?? 0), 0);
    const hardCheapUsd = roundTo(hardCheap, 2);
    const hardPremiumUsd = roundTo(hardPremium, 2);
    const hardSaving = hardPremium > 0 ? Math.round((1 - hardCheap / hardPremium) * 100) : 0;
    hardBenchmark = {
      questions: hardQuestions,
      correct,
      cheapFirstUsd: hardCheapUsd,
      premiumOnlyUsd: hardPremiumUsd,
      savingPct: hardSaving,
      exactUsd: { cheapFirst: hardCheap, premiumOnly: hardPremium },
      summary: `${hardQuestions} hard questions, ${correct} correct for Cheap First, ${dollars(hardCheapUsd)} against ${dollars(hardPremiumUsd)} premium-only (${hardSaving}% less).`,
    };
  }

  return { benchmark, hardBenchmark, publicBenchmark: null, resultsPage: RESULTS_PAGE };
}
