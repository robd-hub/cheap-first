/**
 * Display figures for the public benchmark, taken from data/public-benchmark.json.
 *
 * Dollars are shown to the thousandth ($0.088, not $0.09). A cent would
 * move the cheap total by more than it actually was. Accuracy and latency
 * are shown to one decimal. Counts stay exact. savingPct is the value
 * already stored in the file.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PublicSummary } from "./publicGrade.js";

export const PUBLIC_JSON_URL = "https://github.com/robd-hub/cheap-first/blob/main/data/public-benchmark.json";

export interface PublicDatasetMeta {
  id: string;
  name: string;
  population: number;
  sampleSize: number;
  revision?: string;
  sha256?: string;
}

export interface PublicBenchmarkFile {
  complete?: boolean;
  ranAt?: string;
  models?: Record<"cheap" | "checker" | "premium", { label: string }>;
  sample?: { seed?: number; datasets?: PublicDatasetMeta[] };
  summary?: PublicSummary;
}

export interface PublicSetLine {
  id: string;
  name: string;
  sampleSize: number;
  population: number;
  correctCheapFirst: number;
  correctPremium: number;
  correctCheapAlone: number;
  costCheapFirst: string;
  costPremium: string;
}

export interface PublicReport {
  /** For example: "About 95.5% cheaper, 2 points behind the premium model on 300 public questions." */
  claim: string;
  ranAt: string;
  ranAtLabel: string;
  seed: number;
  models: { cheap: string; checker: string; premium: string };
  questions: number;
  correctCheapAlone: number;
  correctCheapFirst: number;
  correctPremium: number;
  accuracyCheapAlone: string;
  accuracyCheapFirst: string;
  accuracyPremium: string;
  /** "2 points behind", "1 point ahead of", or "level with". The claim adds "the premium model" after it. */
  gap: string;
  costCheapFirst: string;
  costPremium: string;
  savingPct: number;
  escalated: number;
  escalationPct: string;
  medianCheapFirst: string;
  medianPremium: string;
  meanCheapFirst: string;
  meanPremium: string;
  catches: number;
  missed: number;
  falseAlarms: number;
  escalatedStillWrong: number;
  blankEscalations: number;
  sets: PublicSetLine[];
  /** One paragraph an agent can quote without dropping the misses. */
  summary: string;
  /** The limits of this run: slower, behind, and the checker did not lift accuracy. */
  limits: string;
  jsonUrl: string;
}

export function publicDollars(n: number): string {
  return `$${n.toFixed(3)}`;
}

export function publicPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function publicSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function ranAtLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

/** Difference of the one-decimal accuracy percentages, in points. */
function gapPoints(cheapFirst: number, premium: number): number {
  const shown = (n: number) => Math.round(n * 1000) / 10;
  return Math.round((shown(premium) - shown(cheapFirst)) * 10) / 10;
}

function gapPhrase(points: number): string {
  if (points === 0) return "level with";
  const abs = Math.abs(points);
  const label = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  const unit = abs === 1 ? "point" : "points";
  return points > 0 ? `${label} ${unit} behind` : `${label} ${unit} ahead of`;
}

export function publicReportFrom(file: PublicBenchmarkFile): PublicReport | null {
  const summary = file.summary;
  const cheap = file.models?.cheap?.label;
  const checker = file.models?.checker?.label;
  const premium = file.models?.premium?.label;
  const datasets = file.sample?.datasets ?? [];
  if (!file.complete || !summary || summary.questions < 1 || !file.ranAt || !cheap || !checker || !premium) return null;
  if (file.sample?.seed == null || !datasets.length) return null;
  if (summary.accuracy.cheapFirst == null || summary.accuracy.premium == null || summary.accuracy.cheapAlone == null) return null;
  if (summary.savingPct == null || summary.escalationRate == null) return null;

  const gap = gapPhrase(gapPoints(summary.accuracy.cheapFirst, summary.accuracy.premium));
  const savingPct = summary.savingPct;
  const questions = summary.questions;
  const claim = `About ${savingPct}% cheaper, ${gap} the premium model on ${questions} public questions.`;
  const accuracyCheapFirst = publicPercent(summary.accuracy.cheapFirst);
  const accuracyPremium = publicPercent(summary.accuracy.premium);
  const accuracyCheapAlone = publicPercent(summary.accuracy.cheapAlone);
  const costCheapFirst = publicDollars(summary.costUsd.cheapFirst);
  const costPremium = publicDollars(summary.costUsd.premium);
  const escalationPct = publicPercent(summary.escalationRate);
  const medianCheapFirst = publicSeconds(summary.latencyMs.cheapFirst.median);
  const medianPremium = publicSeconds(summary.latencyMs.premium.median);
  const meanCheapFirst = publicSeconds(summary.latencyMs.cheapFirst.mean);
  const meanPremium = publicSeconds(summary.latencyMs.premium.mean);
  const still =
    summary.escalatedStillWrong === 1
      ? "1 escalation was still wrong."
      : `${summary.escalatedStillWrong} escalations were still wrong.`;
  const blanks = summary.blankEscalations ? ` ${summary.blankEscalations} escalations were blank replies from the cheap model.` : "";
  const behind = `It is ${gap} the premium model (${accuracyCheapFirst} vs ${accuracyPremium}).`;
  const limits =
    `Cheap First is slower: median ${medianCheapFirst} vs ${medianPremium}, mean ${meanCheapFirst} vs ${meanPremium}. ` +
    `${behind} It scored the same as the cheap model alone, ${summary.correct.cheapAlone} of ${questions}. ` +
    `The checker made ${summary.catches} real catches, let ${summary.missed} wrong cheap answers through, ` +
    `and ${summary.falseAlarms} of the ${summary.escalated} escalations were false alarms on answers the cheap model already had right. ${still}${blanks}`;

  const sets = datasets.map((dataset) => {
    const scored = summary.byDataset[dataset.id];
    if (!scored) throw new Error(`Public benchmark summary has no ${dataset.id} rows.`);
    return {
      id: dataset.id,
      name: dataset.name,
      sampleSize: dataset.sampleSize,
      population: dataset.population,
      correctCheapFirst: scored.correct.cheapFirst,
      correctPremium: scored.correct.premium,
      correctCheapAlone: scored.correct.cheapAlone,
      costCheapFirst: publicDollars(scored.costUsd.cheapFirst),
      costPremium: publicDollars(scored.costUsd.premium),
    };
  });

  const setBits = sets.map((set) => `${set.name} ${set.correctCheapFirst} vs ${set.correctPremium} of ${set.sampleSize}, ${set.costCheapFirst} vs ${set.costPremium}`).join("; ");
  const summaryText =
    `${claim} Cheap First ${summary.correct.cheapFirst}/${questions} (${accuracyCheapFirst}) vs ${premium} ${summary.correct.premium}/${questions} (${accuracyPremium}). ` +
    `Cost ${costCheapFirst} vs ${costPremium}. Escalated ${summary.escalated}/${questions} (${escalationPct}). ` +
    `Median latency ${medianCheapFirst} vs ${medianPremium} (mean ${meanCheapFirst} vs ${meanPremium}). ${setBits}. ${limits}`;

  return {
    claim,
    ranAt: file.ranAt,
    ranAtLabel: ranAtLabel(file.ranAt),
    seed: file.sample.seed,
    models: { cheap, checker, premium },
    questions,
    correctCheapAlone: summary.correct.cheapAlone,
    correctCheapFirst: summary.correct.cheapFirst,
    correctPremium: summary.correct.premium,
    accuracyCheapAlone,
    accuracyCheapFirst,
    accuracyPremium,
    gap,
    costCheapFirst,
    costPremium,
    savingPct,
    escalated: summary.escalated,
    escalationPct,
    medianCheapFirst,
    medianPremium,
    meanCheapFirst,
    meanPremium,
    catches: summary.catches,
    missed: summary.missed,
    falseAlarms: summary.falseAlarms,
    escalatedStillWrong: summary.escalatedStillWrong,
    blankEscalations: summary.blankEscalations,
    sets,
    summary: summaryText,
    limits,
    jsonUrl: PUBLIC_JSON_URL,
  };
}

export function loadPublicBenchmarkFile(): PublicBenchmarkFile | null {
  const path = fileURLToPath(new URL("../data/public-benchmark.json", import.meta.url));
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as PublicBenchmarkFile;
}

export function loadPublicReport(): PublicReport | null {
  const file = loadPublicBenchmarkFile();
  return file ? publicReportFrom(file) : null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Markdown block for the README. The committed README must contain this text. */
export function publicResultsMarkdown(report: PublicReport): string {
  const setRows = report.sets
    .map(
      (set) =>
        `| ${set.name} test, ${set.sampleSize} of ${set.population.toLocaleString("en-US")} | ${set.correctCheapFirst}/${set.sampleSize} | ${set.correctPremium}/${set.sampleSize} | ${set.costCheapFirst} vs ${set.costPremium} |`,
    )
    .join("\n");
  return `### Public questions

The 143 questions above were written for this project. The table below is a fixed public sample, graded by code against the published answers. The checker did not see the answer key, and it does not mark the final answers.

**${report.claim}**

| | Cheap First | Premium only (${report.models.premium}) |
|---|---|---|
| Correct, graded by code | **${report.correctCheapFirst}/${report.questions} (${report.accuracyCheapFirst})** | ${report.correctPremium}/${report.questions} (${report.accuracyPremium}) |
| Cheap model alone (${report.models.cheap}) | ${report.correctCheapAlone}/${report.questions} (${report.accuracyCheapAlone}) | |
| Total cost | **${report.costCheapFirst}** | ${report.costPremium} |
| Saving | **${report.savingPct}%** | |
| Escalated | ${report.escalated} of ${report.questions} (${report.escalationPct}) | |
| Median latency | ${report.medianCheapFirst} | ${report.medianPremium} |
| Mean latency | ${report.meanCheapFirst} | ${report.meanPremium} |

| Set | Cheap First | Premium only | Cost |
|---|---|---|---|
${setRows}

${report.limits}

Seed ${report.seed}. Models: ${report.models.cheap} answers, ${report.models.checker} checks, ${report.models.premium} is the premium model. Run ${report.ranAtLabel}. Full rows: [data/public-benchmark.json](${report.jsonUrl}).`;
}

/** The public-results block on the homepage. */
export function publicResultsHtml(report: PublicReport): string {
  const setItems = report.sets
    .map(
      (set) =>
        `<li>${esc(set.name)} test, ${set.sampleSize} of ${set.population.toLocaleString("en-US")}: Cheap First ${set.correctCheapFirst}/${set.sampleSize}, premium ${set.correctPremium}/${set.sampleSize}, ${esc(set.costCheapFirst)} vs ${esc(set.costPremium)}.</li>`,
    )
    .join("");
  return `<section id="public">
<p class="eyebrow">Public questions</p>
<h2>${esc(report.claim)}</h2>
<p class="sub">GSM8K and ARC-Challenge, seed ${report.seed}, graded by code against the published answers. The checker did not see the answer key. Cheap model: ${esc(report.models.cheap)}. Checker: ${esc(report.models.checker)}. Premium: ${esc(report.models.premium)}. Run ${esc(report.ranAtLabel)}.</p>
<div class="tiles">
  <div class="tile accent"><div class="big">${report.savingPct}%</div><div class="lbl">cheaper on ${report.questions} public questions (${esc(report.costCheapFirst)} vs ${esc(report.costPremium)}), and ${esc(report.gap)} the premium model</div></div>
  <div class="tile"><div class="big">${report.correctCheapFirst}/${report.questions}</div><div class="lbl">correct for Cheap First (${esc(report.accuracyCheapFirst)}), and ${report.correctPremium}/${report.questions} for premium only (${esc(report.accuracyPremium)})</div></div>
  <div class="tile"><div class="big">${esc(report.escalationPct)}</div><div class="lbl">${report.escalated} of ${report.questions} escalated. ${report.catches} real catches, ${report.missed} wrong cheap answers kept, ${report.falseAlarms} false alarms</div></div>
  <div class="tile"><div class="big">${esc(report.medianCheapFirst)}</div><div class="lbl">median Cheap First latency, vs ${esc(report.medianPremium)} premium only. Mean ${esc(report.meanCheapFirst)} vs ${esc(report.meanPremium)}</div></div>
</div>
<ul class="notes">
  <li>${esc(report.limits)}</li>
  ${setItems}
  <li>Full rows: <a href="${esc(report.jsonUrl)}">data/public-benchmark.json</a>.</li>
</ul>
</section>`;
}
