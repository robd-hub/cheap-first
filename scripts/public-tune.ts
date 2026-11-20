/**
 * Tuning sample for the check. Not the reported 300.
 *
 * Seed 20261121, 40 GSM8K + 20 ARC-Challenge, with every reported id removed
 * before the draw. Each question is answered by the cheap model, by two extra
 * cheap samples, by the premium model, and by the old grader. The pass-mark
 * grid is then computed from those stored calls, so reading it again is free.
 *
 *   npm run public-tune -- --dry-run     # download, prove the sets are disjoint, no model calls
 *   npm run public-tune                  # writes data/public-tuning.json
 *   npm run public-tune -- --grid        # reprint the grid from that file, no model calls
 *
 * data/public-benchmark.json is not read for labels and is not modified.
 * Do not choose a threshold from the reported 300. If the grid says the
 * default bands are a poor trade, change SCORE in src/checkSignals.ts and
 * rerun npm run public-compare on the published file.
 */
import fs from "node:fs";
import { AUDIT_MAX_TOKENS, AUDIT_SYSTEM, AUDIT_TEMPERATURE } from "../src/checkSignals.js";
import { checkAnswer, defaultModels, MODES, SYSTEM_PROMPT } from "../src/cheapFirst.js";
import { chat, CHEAP, type CallResult } from "../src/models.js";
import { gradeArc, gradeGsm8kNumber } from "../src/publicGrade.js";
import { TUNING_ARC_SIZE, TUNING_GSM8K_SIZE, TUNING_SEED } from "../src/publicSets.js";
import { modeGrid, type TuneRow } from "../src/tuneReport.js";
import { loadPopulations, tuningItems, type PublicItem } from "./public-load.js";

interface StoredRow extends TuneRow {
  gold: string;
  labels?: string[];
  premiumAnswer: string;
  lunaReason: string;
}

interface Stored {
  seed?: number;
  gsm8k?: number;
  arc?: number;
  rows?: StoredRow[];
  failures?: { id: string; error: string }[];
}

const OUT = "data/public-tuning.json";
const CONCURRENCY = 4;
const args = process.argv.slice(2);
const PASS_MARKS = [MODES.budget, MODES.balanced, MODES.strict];

async function oneAudit(prompt: string): Promise<CallResult> {
  try {
    return await chat(CHEAP, AUDIT_SYSTEM, prompt, AUDIT_MAX_TOKENS, AUDIT_TEMPERATURE);
  } catch (e) {
    if (!/returned 400/.test((e as Error).message)) throw e;
    return chat(CHEAP, AUDIT_SYSTEM, prompt, AUDIT_MAX_TOKENS);
  }
}

function correctOf(item: PublicItem, answer: string): boolean {
  return item.dataset === "gsm8k" ? gradeGsm8kNumber(answer, item.gold).correct : gradeArc(answer, item.gold, item.labels ?? []).correct;
}

function readOut(): Stored {
  if (!fs.existsSync(OUT)) return { rows: [] };
  return JSON.parse(fs.readFileSync(OUT, "utf8")) as Stored;
}

function writeOut(items: PublicItem[], rows: StoredRow[], failures: { id: string; error: string }[]): void {
  const order = new Map(items.map((item, index) => [item.id, index]));
  const kept = rows.filter((row) => order.has(row.id)).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const missing = new Set(items.map((item) => item.id).filter((id) => !kept.some((row) => row.id === id)));
  const out = {
    benchmark: "public-tuning",
    ranAt: new Date().toISOString(),
    seed: TUNING_SEED,
    gsm8k: TUNING_GSM8K_SIZE,
    arc: TUNING_ARC_SIZE,
    reportedSeed: 20261120,
    disjointFromReported: true,
    complete: missing.size === 0,
    note: "Threshold sample only. Not the reported 300. The grid is computed from these rows.",
    grid: modeGrid(kept, PASS_MARKS),
    failures: failures.filter((failure) => missing.has(failure.id)),
    rows: kept,
  };
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}

async function main(): Promise<void> {
  const items = tuningItems(await loadPopulations());
  const reportedNote = `${items.length} questions (GSM8K ${TUNING_GSM8K_SIZE}, ARC-Challenge ${TUNING_ARC_SIZE}), seed ${TUNING_SEED}, disjoint from the reported seed 20261120.`;
  console.log(`Tuning sample: ${reportedNote}`);
  if (args.includes("--dry-run")) {
    for (const dataset of ["gsm8k", "arc"] as const) {
      const ids = items.filter((item) => item.dataset === dataset).map((item) => item.id);
      console.log(`${dataset}: ${ids.length} ids, first ${ids[0]}, last ${ids[ids.length - 1]}`);
    }
    console.log("Each question would call the cheap model 3 times, the premium model once, and the grader once.");
    console.log("Dry run only. No model calls, and data/public-tuning.json was not written. data/public-benchmark.json was not touched.");
    return;
  }
  const previous = readOut();
  if (args.includes("--grid")) {
    if (!previous.rows?.length) throw new Error(`${OUT} has no rows. Run npm run public-tune first.`);
    console.log(JSON.stringify(modeGrid(previous.rows, PASS_MARKS), null, 2));
    return;
  }
  if (previous.rows?.length && (previous.seed !== TUNING_SEED || previous.gsm8k !== TUNING_GSM8K_SIZE || previous.arc !== TUNING_ARC_SIZE) && !args.includes("--rerun")) {
    throw new Error(`${OUT} was produced with a different tuning pin. Pass --rerun to replace it. It was not overwritten.`);
  }

  const only = args.filter((arg) => !arg.startsWith("--"));
  const todo = items.filter((item) => only.length === 0 || only.includes(item.id));
  if (only.length && todo.length !== only.length) {
    const known = new Set(items.map((item) => item.id));
    throw new Error(`Unknown question ids: ${only.filter((id) => !known.has(id)).join(", ")}`);
  }
  const models = await defaultModels();
  const rows = (previous.seed === TUNING_SEED ? (previous.rows ?? []) : []).filter((row) => !todo.some((item) => item.id === row.id));
  const failures = (previous.failures ?? []).filter((failure) => !todo.some((item) => item.id === failure.id));
  console.log(`Running ${todo.length} questions. Each one calls the cheap model three times, the premium model once, and the grader once.`);
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          const [cheap, auditA, auditB, premium] = await Promise.all([
            chat(models.cheap, SYSTEM_PROMPT, item.prompt),
            oneAudit(item.prompt),
            oneAudit(item.prompt),
            chat(models.premium, SYSTEM_PROMPT, item.prompt),
          ]);
          const luna = cheap.text.trim()
            ? await checkAnswer(models.checker, item.prompt, cheap.text)
            : { score: 0, reason: "blank", call: { costUsd: 0 } };
          const row: StoredRow = {
            id: item.id,
            dataset: item.dataset,
            prompt: item.prompt,
            gold: item.gold,
            labels: item.labels,
            cheapAnswer: cheap.text,
            premiumAnswer: premium.text,
            audits: [auditA.text, auditB.text],
            cheapCorrect: correctOf(item, cheap.text),
            premiumCorrect: correctOf(item, premium.text),
            lunaScore: luna.score,
            lunaReason: luna.reason,
            costUsd: {
              cheap: cheap.costUsd,
              audits: [auditA.costUsd, auditB.costUsd],
              premium: premium.costUsd,
              luna: luna.call.costUsd,
            },
          };
          rows.push(row);
          console.log(`${row.id}: cheap ${row.cheapCorrect ? "right" : "wrong"}, premium ${row.premiumCorrect ? "right" : "wrong"}, luna ${row.lunaScore}`);
        } catch (e) {
          const error = (e as Error).message;
          failures.push({ id: item.id, error });
          console.log(`${item.id}: failed (${error})`);
        }
        writeOut(items, rows, failures);
      }
    }),
  );
  const saved = readOut();
  console.log(JSON.stringify({ complete: (saved.rows ?? []).length === items.length, grid: modeGrid(saved.rows ?? [], PASS_MARKS) }, null, 2));
  if ((saved.rows ?? []).length !== items.length) {
    throw new Error(`${items.length - (saved.rows ?? []).length} questions failed. ${OUT} is incomplete and is not a tuning result.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
