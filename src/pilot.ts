/**
 * "Bring your own questions" pilot: a builder sends their real questions, we
 * run each one through Cheap First and through the premium model alone, and
 * write a side-by-side report they can read.
 *
 * This file holds the parts that call no model: reading the questions file,
 * the judge prompt, the summary and the HTML report. scripts/pilot.ts runs it.
 *
 * Customer questions and answers stay in pilots/, which is gitignored. Nothing
 * here writes to data/, the live stats or the public site.
 */
import { costOf, type ModelSpec } from "./models.js";

export interface PilotQuestion {
  id: string;
  question: string;
  /** The answer the customer says is right. Optional; the judge compares against it when present. */
  reference?: string;
}

export interface PilotSide {
  answer: string;
  costUsd: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
}

/** One answer as the judge saw it. `ok` means correct (with a reference) or acceptable (without one). */
export interface PilotVerdict {
  ok: boolean;
  reason: string;
}

export interface PilotJudgement {
  basis: "reference" | "premium";
  cheap: PilotVerdict;
  premium: PilotVerdict;
  /** Without a reference: the judge thinks the cheap answer serves the user noticeably worse than the premium one. */
  cheapWorse: boolean;
  costUsd: number;
}

export interface PilotRow {
  id: string;
  question: string;
  reference?: string;
  answeredBy: "cheap" | "premium";
  checkScore: number;
  checkReason: string;
  checkSignal: string;
  cheap: PilotSide;
  checkCostUsd: number;
  /** What Cheap First returned and spent: cheap answer + check (+ premium when escalated). */
  cheapFirst: { answer: string; costUsd: number; ms: number };
  /** Always-premium baseline. When Cheap First escalated, this is the same premium call. */
  premium: PilotSide;
  judge: PilotJudgement | null;
}

export interface PilotFailure {
  id: string;
  error: string;
}

export interface PilotFile {
  pilot: string;
  customer?: string;
  ranAt: string;
  mode: string;
  passMark: number;
  models: { cheap: string; checker: string; premium: string; judge: string | null };
  /** The customer's own premium model, priced from their published rates, when it is not on SERV. */
  theirModel?: { label: string; inputPerM: number; outputPerM: number };
  monthlyQuestions?: number;
  expected: number;
  rows: PilotRow[];
  failures: PilotFailure[];
}

// ---------------------------------------------------------------- input files

/**
 * Reads the questions file. Accepted:
 *   .csv / .tsv  a header row with a `question` (or `prompt`) column and an
 *                optional `reference` (or `expected`, `answer`, `gold`) column
 *   .jsonl       one {"question": "...", "reference": "..."} per line
 *   .json        an array of those, or of plain strings
 *   anything else  plain text: one question per line, or questions separated
 *                by a line holding only --- when a question has several lines
 * Blank questions are skipped. Ids are q001, q002, ... in file order, unless
 * the file has an `id` column.
 */
export function parseQuestions(text: string, filename: string): PilotQuestion[] {
  const lower = filename.toLowerCase();
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let raw: { id?: string; question: string; reference?: string }[];
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
    raw = fromTable(parseDelimited(clean, lower.endsWith(".tsv") ? "\t" : ","));
  } else if (lower.endsWith(".jsonl")) {
    raw = clean
      .split("\n")
      .filter((line) => line.trim())
      .map((line, i) => fromJson(JSON.parse(line), i + 1));
  } else if (lower.endsWith(".json")) {
    const parsed = JSON.parse(clean) as unknown;
    if (!Array.isArray(parsed)) throw new Error("A .json questions file must be an array.");
    raw = parsed.map((item, i) => fromJson(item, i + 1));
  } else {
    const blocks = /^\s*---\s*$/m.test(clean) ? clean.split(/^\s*---\s*$/m) : clean.split("\n");
    raw = blocks.map((question) => ({ question }));
  }
  const out: PilotQuestion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const question = item.question.trim();
    if (!question) continue;
    const id = (item.id ?? "").trim() || `q${String(out.length + 1).padStart(3, "0")}`;
    if (seen.has(id)) throw new Error(`The id ${id} appears twice in the questions file.`);
    seen.add(id);
    const reference = item.reference?.trim();
    out.push(reference ? { id, question, reference } : { id, question });
  }
  return out;
}

function fromJson(item: unknown, line: number): { id?: string; question: string; reference?: string } {
  if (typeof item === "string") return { question: item };
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    const question = o.question ?? o.prompt;
    if (typeof question === "string") {
      const reference = o.reference ?? o.expected ?? o.answer ?? o.gold;
      return {
        id: o.id === undefined ? undefined : String(o.id),
        question,
        reference: reference === undefined || reference === null ? undefined : String(reference),
      };
    }
  }
  throw new Error(`Item ${line} has no "question" text.`);
}

const QUESTION_COLUMNS = ["question", "questions", "prompt", "input", "query"];
const REFERENCE_COLUMNS = ["reference", "expected", "expected answer", "answer", "gold", "correct answer"];

function fromTable(rows: string[][]): { id?: string; question: string; reference?: string }[] {
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const q = header.findIndex((h) => QUESTION_COLUMNS.includes(h));
  if (q < 0) {
    // No header we recognise: a single column of questions, header row included only if it isn't a label.
    return rows.map((r) => ({ question: r[0] ?? "" }));
  }
  const ref = header.findIndex((h) => REFERENCE_COLUMNS.includes(h));
  const id = header.indexOf("id");
  return rows.slice(1).map((r) => ({
    id: id >= 0 ? r[id] : undefined,
    question: r[q] ?? "",
    reference: ref >= 0 ? r[ref] : undefined,
  }));
}

/** RFC 4180 style: quoted fields may hold commas, quotes ("") and newlines. */
export function parseDelimited(text: string, sep = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

// ---------------------------------------------------------------- the judge

/**
 * The judge is a separate model from the checker. It never decides routing:
 * it only reads the finished answers afterwards, for the report. It sees the
 * two answers as A and B in an order set by `cheapFirstInA`, so it cannot
 * tell which one is the cheap model's.
 */
export function judgePrompt(q: PilotQuestion, cheap: string, premium: string, cheapFirstInA: boolean): { system: string; user: string } {
  const [a, b] = cheapFirstInA ? [cheap, premium] : [premium, cheap];
  const withRef = !!q.reference;
  const rules =
    "You compare two AI answers to the same question for a cost report. Be strict and fair.\n" +
    (withRef
      ? "A reference answer is given. An answer is ok when it reaches the same result as the reference and follows the question's explicit instructions. Different wording, or the same value in another format, is fine unless the question asked for that format. A wrong figure, a wrong choice, or an invented fact is not ok.\n"
      : "There is no reference answer. An answer is ok when, as far as you can tell, it is correct, follows the question's explicit instructions, and invents nothing. Say so plainly when you cannot verify a claim.\n") +
    "Also say whether answer A serves the person who asked noticeably worse than answer B, or B noticeably worse than A. Style and length alone are not worse unless the question asked for them.\n" +
    "Reply with one JSON object and nothing else, using exactly these five keys:\n" +
    '{"a_ok": true, "a_reason": "one sentence", "b_ok": false, "b_reason": "one sentence", "worse": "b"}\n' +
    'a_ok and b_ok are true or false. worse is "a", "b" or "neither".';
  // The rules come after the material. With them in the system message, SERV's models often
  // made up their own JSON keys or answered the question themselves.
  const user =
    `Question:\n${q.question.slice(0, 20_000)}\n\n` +
    (withRef ? `Reference answer:\n${q.reference!.slice(0, 10_000)}\n\n` : "") +
    `Answer A:\n${a.slice(0, 20_000)}\n\nAnswer B:\n${b.slice(0, 20_000)}\n\n---\nInstructions:\n${rules}`;
  return { system: "You are a careful grader. Output only the JSON object the user message asks for.", user };
}

/** Reads the judge's reply. Returns null when it can't be read, so nothing is guessed. */
export function readJudgement(text: string, cheapFirstInA: boolean, basis: PilotJudgement["basis"], costUsd: number): PilotJudgement | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const p = JSON.parse(match[0]) as { a_ok?: unknown; a_reason?: unknown; b_ok?: unknown; b_reason?: unknown; worse?: unknown };
    const aOk = yesNo(p.a_ok);
    const bOk = yesNo(p.b_ok);
    if (aOk === null || bOk === null) return null;
    const a: PilotVerdict = { ok: aOk, reason: String(p.a_reason ?? "") };
    const b: PilotVerdict = { ok: bOk, reason: String(p.b_reason ?? "") };
    const worse = String(p.worse ?? "neither").toLowerCase();
    return {
      basis,
      cheap: cheapFirstInA ? a : b,
      premium: cheapFirstInA ? b : a,
      cheapWorse: worse === (cheapFirstInA ? "a" : "b"),
      costUsd,
    };
  } catch {
    return null;
  }
}

/** true / false, also written as a string. Anything else is unreadable. */
function yesNo(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

// ---------------------------------------------------------------- summary

export interface PilotSummary {
  questions: number;
  expected: number;
  failed: number;
  costUsd: { cheapFirst: number; premium: number; theirModel: number | null };
  /** Percent cheaper than always-premium, one decimal. Null when the premium cost is 0. */
  savingPct: number | null;
  savingPctTheirModel: number | null;
  stayedCheap: number;
  escalated: number;
  blankEscalations: number;
  /** Questions the judge could score. */
  judged: number;
  withReference: number;
  ok: { cheapAlone: number; cheapFirst: number; premium: number };
  /** Escalated, the cheap answer was not ok, and the answer returned is ok. */
  catches: number;
  /** Escalated, but the cheap answer was already ok. */
  falseAlarms: number;
  /** Stayed on the cheap model, and the judge marked that answer not ok. */
  missed: number;
  /** Missed, and the premium answer was ok: what always-premium would have got right that Cheap First didn't. */
  missedPremiumRight: number;
  /** No reference: stayed cheap, and the judge thought the cheap answer was noticeably worse than premium. */
  cheapWorse: number;
  /** Escalated, and the answer returned is still not ok. */
  escalatedStillWrong: number;
  latencyMs: { cheapFirst: { median: number; p90: number }; premium: { median: number; p90: number } };
  /** What the pilot itself cost us to run: Cheap First + the premium baseline + the judge. */
  pilotCostUsd: number;
  monthly: { questions: number; cheapFirst: number; premium: number; theirModel: number | null } | null;
}

export function summarizePilot(file: Pick<PilotFile, "rows" | "failures" | "expected" | "theirModel" | "monthlyQuestions">): PilotSummary {
  const rows = file.rows;
  const n = rows.length;
  const cheapFirst = sum(rows.map((r) => r.cheapFirst.costUsd));
  const premium = sum(rows.map((r) => r.premium.costUsd));
  const their = file.theirModel
    ? sum(rows.map((r) => costOf(asSpec(file.theirModel!), r.premium.inputTokens, r.premium.outputTokens)))
    : null;
  const judged = rows.filter((r) => r.judge);
  const okCheap = (r: PilotRow) => !!r.judge?.cheap.ok;
  const okPremium = (r: PilotRow) => !!r.judge?.premium.ok;
  const okCheapFirst = (r: PilotRow) => (r.answeredBy === "cheap" ? okCheap(r) : okPremium(r));
  const escalatedRows = rows.filter((r) => r.answeredBy === "premium");
  const cheapRows = rows.filter((r) => r.answeredBy === "cheap");
  const blank = (r: PilotRow) => !r.cheap.answer.trim();
  const scale = file.monthlyQuestions && n ? file.monthlyQuestions / n : null;
  return {
    questions: n,
    expected: file.expected,
    failed: file.failures.length,
    costUsd: { cheapFirst, premium, theirModel: their },
    savingPct: pct(cheapFirst, premium),
    savingPctTheirModel: their === null ? null : pct(cheapFirst, their),
    stayedCheap: cheapRows.length,
    escalated: escalatedRows.length,
    blankEscalations: escalatedRows.filter(blank).length,
    judged: judged.length,
    withReference: judged.filter((r) => r.judge!.basis === "reference").length,
    ok: {
      cheapAlone: judged.filter(okCheap).length,
      cheapFirst: judged.filter(okCheapFirst).length,
      premium: judged.filter(okPremium).length,
    },
    catches: judged.filter((r) => r.answeredBy === "premium" && !blank(r) && !okCheap(r) && okPremium(r)).length,
    falseAlarms: judged.filter((r) => r.answeredBy === "premium" && okCheap(r)).length,
    missed: judged.filter((r) => r.answeredBy === "cheap" && !okCheap(r)).length,
    missedPremiumRight: judged.filter((r) => r.answeredBy === "cheap" && !okCheap(r) && okPremium(r)).length,
    cheapWorse: judged.filter((r) => r.answeredBy === "cheap" && r.judge!.cheapWorse).length,
    escalatedStillWrong: judged.filter((r) => r.answeredBy === "premium" && !okPremium(r)).length,
    latencyMs: {
      cheapFirst: spread(rows.map((r) => r.cheapFirst.ms)),
      premium: spread(rows.map((r) => r.premium.ms)),
    },
    pilotCostUsd: sum(rows.map((r) => r.cheapFirst.costUsd + (r.answeredBy === "cheap" ? r.premium.costUsd : 0) + (r.judge?.costUsd ?? 0))),
    monthly: scale
      ? { questions: file.monthlyQuestions!, cheapFirst: cheapFirst * scale, premium: premium * scale, theirModel: their === null ? null : their * scale }
      : null,
  };
}

/** Rows a person should look at: possible misses first, then escalations, then anything the judge couldn't score. */
export function reviewList(rows: PilotRow[]): { row: PilotRow; why: string }[] {
  const out: { row: PilotRow; why: string }[] = [];
  for (const r of rows) {
    if (r.answeredBy === "cheap" && r.judge && !r.judge.cheap.ok) out.push({ row: r, why: "Possible miss: stayed on the cheap model, and the judge marked the answer not ok." });
    else if (r.answeredBy === "cheap" && r.judge?.cheapWorse) out.push({ row: r, why: "Stayed cheap, but the judge thought the premium answer was noticeably better." });
  }
  for (const r of rows) {
    if (r.answeredBy === "premium") out.push({ row: r, why: `Escalated: check score ${r.checkScore}. ${r.checkReason}`.trim() });
  }
  for (const r of rows) if (!r.judge) out.push({ row: r, why: "The judge's reply could not be read, so this answer was not scored." });
  return out;
}

function asSpec(m: { label: string; inputPerM: number; outputPerM: number }): ModelSpec {
  return { label: m.label, provider: "serv", model: m.label, inputPerM: m.inputPerM, outputPerM: m.outputPerM };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function pct(cheap: number, premium: number): number | null {
  return premium > 0 ? Math.round((1 - cheap / premium) * 1000) / 10 : null;
}

function spread(xs: number[]): { median: number; p90: number } {
  if (!xs.length) return { median: 0, p90: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const p90 = s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
  return { median: Math.round(median), p90: Math.round(p90) };
}

// ---------------------------------------------------------------- cost estimate

export interface EstimateAssumptions {
  /** Output tokens per answer, including hidden reasoning. */
  answerTokens: number;
  judgeOutputTokens: number;
}

export const DEFAULT_ASSUMPTIONS: EstimateAssumptions = { answerTokens: 800, judgeOutputTokens: 1500 };

/** Rough tokens for a piece of text: about four characters per token, plus room for the system prompt. */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 4) + 120;
}

/**
 * What a pilot will roughly cost before it runs. The premium baseline is most
 * of it, because every question is sent to the premium model.
 */
export function estimatePilotCost(
  questions: PilotQuestion[],
  models: { cheap: ModelSpec; checker: ModelSpec; premium: ModelSpec; judge: ModelSpec | null },
  a: EstimateAssumptions = DEFAULT_ASSUMPTIONS,
): { cheapAndCheck: number; premium: number; judge: number; total: number } {
  let cheapAndCheck = 0;
  let premium = 0;
  let judge = 0;
  for (const q of questions) {
    const tin = roughTokens(q.question);
    cheapAndCheck += 2 * costOf(models.cheap, tin, a.answerTokens) + costOf(models.checker, tin + a.answerTokens, 200);
    premium += costOf(models.premium, tin, a.answerTokens);
    if (models.judge) judge += costOf(models.judge, tin + 2 * a.answerTokens + roughTokens(q.reference ?? ""), a.judgeOutputTokens);
  }
  return { cheapAndCheck, premium, judge, total: cheapAndCheck + premium + judge };
}

// ---------------------------------------------------------------- HTML report

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Dollars: three places from $1, more below so a tenth of a cent doesn't show as $0.000. */
export function dollars(n: number): string {
  if (n >= 100) return `$${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  if (n === 0) return "$0";
  return `$${n.toPrecision(2)}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function short(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface RenderOptions {
  /** false leaves out every question and answer, for a summary the customer agrees can be shared. */
  full: boolean;
}

/**
 * One self-contained HTML page (no scripts, no outside files), so it can be
 * emailed, opened offline or printed to PDF from the browser.
 */
export function renderPilotReport(file: PilotFile, options: RenderOptions): string {
  const s = summarizePilot(file);
  const who = file.customer ? esc(file.customer) : "your questions";
  const date = file.ranAt.slice(0, 10);
  const premiumName = esc(file.models.premium);
  const refMode = s.withReference === s.judged && s.judged > 0 ? "reference" : s.withReference === 0 ? "premium" : "mixed";

  const tiles = [
    tile("Cheap First", dollars(s.costUsd.cheapFirst), `for ${plural(s.questions, "question")}`),
    tile(`Always ${premiumName}`, dollars(s.costUsd.premium), "the same questions"),
    tile("Saving", s.savingPct === null ? "n/a" : `${s.savingPct.toFixed(1)}%`, "measured on this run", "good"),
    tile("Stayed on the cheap model", `${s.stayedCheap} of ${s.questions}`, `${plural(s.escalated, "escalation")} to ${premiumName}`),
  ];
  if (s.costUsd.theirModel !== null && file.theirModel) {
    tiles.push(
      tile(
        `If you pay ${esc(file.theirModel.label)} rates`,
        dollars(s.costUsd.theirModel),
        `saving ${s.savingPctTheirModel === null ? "n/a" : `${s.savingPctTheirModel.toFixed(1)}%`} (estimate)`,
      ),
    );
  }

  const qualityLines: string[] = [];
  if (s.judged) {
    const basis =
      refMode === "reference"
        ? "against the reference answers you sent"
        : refMode === "premium"
          ? "with no reference answers, so the judge used its own reading and compared the two answers"
          : `against your reference answers for ${s.withReference} questions, and on its own reading for the other ${s.judged - s.withReference}`;
    qualityLines.push(
      `<p>A separate judge model (${esc(file.models.judge ?? "")}) read every finished answer ${basis}. It never decided which model answered. It sees the two answers unlabelled and in a random order.</p>`,
      `<table class="grid"><thead><tr><th></th><th>Answers marked ok</th></tr></thead><tbody>`,
      `<tr><td>Cheap model alone</td><td>${s.ok.cheapAlone} of ${s.judged}</td></tr>`,
      `<tr class="hl"><td>Cheap First</td><td>${s.ok.cheapFirst} of ${s.judged}</td></tr>`,
      `<tr><td>Always ${premiumName}</td><td>${s.ok.premium} of ${s.judged}</td></tr>`,
      `</tbody></table>`,
      `<ul class="facts">`,
      `<li><b>${s.catches}</b> real ${s.catches === 1 ? "catch" : "catches"}: the cheap answer was not ok, Cheap First escalated, and the answer returned was ok.</li>`,
      `<li><b>${s.missed}</b> ${s.missed === 1 ? "miss" : "misses"}: the cheap answer was not ok and it was returned anyway.${s.missedPremiumRight ? ` On ${s.missedPremiumRight} of ${s.missed === 1 ? "it" : "them"} the premium model was ok.` : ""}</li>`,
      `<li><b>${s.falseAlarms}</b> false ${s.falseAlarms === 1 ? "alarm" : "alarms"}: escalated although the cheap answer was already ok. These cost money but not quality.</li>`,
      s.escalatedStillWrong ? `<li><b>${s.escalatedStillWrong}</b> escalated and still not ok.</li>` : "",
      refMode !== "reference" && s.cheapWorse ? `<li><b>${s.cheapWorse}</b> stayed cheap where the judge thought the premium answer was noticeably better.</li>` : "",
      s.blankEscalations ? `<li><b>${s.blankEscalations}</b> escalated because the cheap model returned nothing.</li>` : "",
      `</ul>`,
    );
    if (s.judged < s.questions) qualityLines.push(`<p class="muted">${s.questions - s.judged} answers could not be scored by the judge and are left out of these counts.</p>`);
  } else {
    qualityLines.push(
      file.models.judge
        ? `<p>The judge's replies could not be read, so no answer was scored. This report shows cost and routing only. Every escalated question is listed below for you to review.</p>`
        : `<p>No judge ran on this pilot, so this report shows cost and routing only. Every escalated question is listed below for you to review.</p>`,
    );
  }

  const limits = [
    `This is ${plural(s.questions, "question")} from you, run once on ${date}. A different mix of questions, or the same ones on another day, can route and score differently.`,
    `Cheap First is slower: median ${seconds(s.latencyMs.cheapFirst.median)} against ${seconds(s.latencyMs.premium.median)} for ${premiumName} alone (90th percentile ${seconds(s.latencyMs.cheapFirst.p90)} against ${seconds(s.latencyMs.premium.p90)}).`,
    s.missed
      ? `The checker let ${plural(s.missed, "answer")} through that the judge marked not ok. They are listed first below.`
      : s.judged
        ? "The judge found no cheap answer that was returned while not ok on this run. That is this sample, not a guarantee."
        : "",
    refMode === "reference"
      ? "Accuracy is judged against your reference answers by a model, not by you. Check the list below."
      : "Without reference answers, ok means the judge believed the answer was right. A model can be wrong about that, so treat the quality counts as a second opinion and check the list below.",
    "Costs are what the providers billed per token on this run. Cheap First's figure includes the cheap answer, the check, and the premium answer whenever it escalated.",
    file.theirModel ? `The ${esc(file.theirModel.label)} figure prices the premium model's token counts at the rates given (${dollars(file.theirModel.inputPerM)} in, ${dollars(file.theirModel.outputPerM)} out per million tokens). That model did not answer these questions, so it is an estimate.` : "",
    s.failed ? `${plural(s.failed, "question")} failed to run and ${s.failed === 1 ? "is" : "are"} not in any figure.` : "",
  ].filter(Boolean);

  const monthly = s.monthly
    ? `<p class="proj">At ${s.monthly.questions.toLocaleString("en-GB")} questions a month like these, that is about <b>${dollars(s.monthly.cheapFirst)}</b> a month with Cheap First against <b>${dollars(s.monthly.premium)}</b> always using ${premiumName}${
        s.monthly.theirModel !== null && file.theirModel ? ` (or ${dollars(s.monthly.theirModel)} at ${esc(file.theirModel.label)} rates)` : ""
      }. That is a straight projection of this run, not a quote.</p>`
    : "";

  const review = reviewList(file.rows);
  const reviewHtml = options.full
    ? review.length
      ? `<h2>Worth a look (${review.length})</h2><p class="muted">Possible misses first, then every escalation.</p>${review.map(({ row, why }) => detail(row, why, premiumName, true)).join("")}`
      : `<h2>Worth a look</h2><p>Nothing flagged: no escalations and no possible misses.</p>`
    : "";

  const allHtml = options.full
    ? `<h2>Every question</h2><table class="grid all"><thead><tr><th>#</th><th>Question</th><th>Answered by</th><th>Check</th><th>Judge</th><th>Cheap First</th><th>Always premium</th></tr></thead><tbody>${file.rows
        .map(
          (r) =>
            `<tr><td>${esc(r.id)}</td><td>${esc(short(r.question, 110))}</td><td>${r.answeredBy === "cheap" ? "cheap" : `<span class="tag warn">premium</span>`}</td><td>${r.checkScore}</td><td>${verdictTag(r)}</td><td>${dollars(r.cheapFirst.costUsd)}</td><td>${dollars(r.premium.costUsd)}</td></tr>`,
        )
        .join("")}</tbody></table><h2>Answers side by side</h2>${file.rows.map((r) => detail(r, "", premiumName, false)).join("")}`
    : `<p class="muted">This is the shareable summary. It leaves out every question and answer.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cheap First pilot: ${who}</title>
<style>${CSS}</style></head><body><main>
<header><div class="brand">Cheap First · savings pilot</div><h1>What Cheap First would have saved on ${who}</h1>
<p class="muted">${plural(s.questions, "question")}${s.expected !== s.questions ? ` of ${s.expected} sent` : ""} · run ${date} · ${esc(file.mode)} mode (pass mark ${file.passMark})</p></header>
<section class="tiles">${tiles.join("")}</section>
${monthly}
<h2>How it worked</h2>
<p>Each question went to <b>${esc(file.models.cheap)}</b> first. <b>${esc(file.models.checker)}</b> checked that answer (number and multiple-choice questions are checked by a second cheap answer instead). An answer scoring under ${file.passMark} went to <b>${premiumName}</b>. Separately, every question was also sent to ${premiumName} on its own, to give the always-premium cost and answer to compare with.</p>
<h2>Quality</h2>
${qualityLines.join("\n")}
<h2>Limits of this result</h2>
<ul class="limits">${limits.map((l) => `<li>${l}</li>`).join("")}</ul>
${reviewHtml}
${allHtml}
<footer><p>Cheap First · <a href="https://cheapfirst.designimp.com">cheapfirst.designimp.com</a>. Your questions and answers are kept privately for this pilot and are not published or used for anything else.</p></footer>
</main></body></html>
`;
}

function tile(label: string, value: string, sub: string, kind = ""): string {
  return `<div class="tile ${kind}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function verdictTag(r: PilotRow): string {
  if (!r.judge) return `<span class="tag">not scored</span>`;
  const ok = r.answeredBy === "cheap" ? r.judge.cheap.ok : r.judge.premium.ok;
  if (r.answeredBy === "cheap" && !ok) return `<span class="tag bad">possible miss</span>`;
  return ok ? `<span class="tag good">ok</span>` : `<span class="tag bad">not ok</span>`;
}

function detail(r: PilotRow, why: string, premiumName: string, open: boolean): string {
  const j = r.judge;
  const cheapNote = j ? `<div class="jn">Judge: ${j.cheap.ok ? "ok" : "not ok"}. ${esc(j.cheap.reason)}</div>` : "";
  const premNote = j ? `<div class="jn">Judge: ${j.premium.ok ? "ok" : "not ok"}. ${esc(j.premium.reason)}</div>` : "";
  return `<details${open ? " open" : ""}><summary><b>${esc(r.id)}</b> ${esc(short(r.question, 120))}</summary>
${why ? `<p class="why">${esc(why)}</p>` : ""}
<div class="q"><div class="label">Question</div><pre>${esc(r.question)}</pre>${r.reference ? `<div class="label">Your reference answer</div><pre>${esc(r.reference)}</pre>` : ""}</div>
<div class="pair"><div><div class="label">Cheap model${r.answeredBy === "cheap" ? " (returned by Cheap First)" : ""} · check ${r.checkScore} · ${dollars(r.cheap.costUsd + r.checkCostUsd)}</div><pre>${esc(r.cheap.answer || "(no answer)")}</pre>${cheapNote}</div>
<div><div class="label">${premiumName}${r.answeredBy === "premium" ? " (returned by Cheap First)" : ""} · ${dollars(r.premium.costUsd)}</div><pre>${esc(r.premium.answer || "(no answer)")}</pre>${premNote}</div></div>
<p class="muted">Check said: ${esc(r.checkReason || "(no reason given)")}</p></details>`;
}

const CSS = `
:root{--bg:#f7f8fb;--card:#fff;--text:#141824;--muted:#5d6577;--line:#e2e6ef;--accent:#0a8fb0;--good:#0d9f6e;--good-soft:#e5f7ef;--warn:#b26b00;--warn-soft:#fff3df;--bad:#c62f4b;--bad-soft:#fde8ec}
@media (prefers-color-scheme:dark){:root{--bg:#0b0e15;--card:#141925;--text:#e8ecf6;--muted:#97a0b5;--line:#262d3d;--accent:#4fe3ff;--good:#2ef2a4;--good-soft:rgba(46,242,164,.12);--warn:#ffb547;--warn-soft:rgba(255,181,71,.12);--bad:#ff4d6d;--bad-soft:rgba(255,77,109,.12)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.8rem;line-height:1.2;margin:.2em 0}h2{margin-top:2em;font-size:1.25rem}
.brand{color:var(--accent);font-weight:600;letter-spacing:.02em;text-transform:uppercase;font-size:.8rem}.muted{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:24px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.tile .label{color:var(--muted);font-size:.85rem}
.tile .value{font-size:1.7rem;font-weight:700;margin:4px 0}.tile .sub{color:var(--muted);font-size:.85rem}.tile.good .value{color:var(--good)}
.proj{background:var(--card);border-left:4px solid var(--accent);padding:12px 16px;border-radius:8px}
table.grid{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:.92rem}
.grid th,.grid td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}.grid tr.hl td{font-weight:700}
.all{display:block;overflow-x:auto}.facts li,.limits li{margin:.4em 0}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.8rem;background:var(--line)}.tag.good{background:var(--good-soft);color:var(--good)}
.tag.warn{background:var(--warn-soft);color:var(--warn)}.tag.bad{background:var(--bad-soft);color:var(--bad)}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:10px 0}summary{cursor:pointer}
.why{color:var(--warn);font-weight:600}.label{color:var(--muted);font-size:.8rem;margin-top:8px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin:4px 0;font:13px/1.5 ui-monospace,Menlo,monospace;max-height:420px;overflow:auto}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:700px){.pair{grid-template-columns:1fr}}
.jn{font-size:.85rem;color:var(--muted)}footer{margin-top:48px;color:var(--muted);font-size:.85rem}a{color:var(--accent)}
@media print{body{background:#fff;color:#000}details{break-inside:avoid}pre{max-height:none}details:not([open]) > *:not(summary){display:block}}
`;
