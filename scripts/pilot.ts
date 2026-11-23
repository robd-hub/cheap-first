/**
 * Savings pilot: run a builder's own questions through Cheap First and through
 * the premium model alone, then write a report they can read.
 *
 *   npm run pilot -- questions.csv --customer "Acme"           # run, then write the report
 *   npm run pilot -- questions.csv --dry-run                    # read the file and estimate the cost, no model calls
 *   npm run pilot -- questions.csv --report-only                # rewrite the report from saved answers, no model calls
 *
 * Options:
 *   --name <folder>          output folder under pilots/ (default: the file name)
 *   --customer "<name>"      shown in the report title
 *   --mode strict|balanced|budget   Cheap First's pass mark (default balanced)
 *   --premium <SERV model>   the always-premium baseline and escalation model (default claude-opus-5.5)
 *   --their-model "<name>" --their-price <in>,<out>
 *                            also price the premium answers at the customer's own model's
 *                            published rates, in dollars per million tokens (an estimate)
 *   --judge <SERV model>     the model that reads answers for the report (default gemini-3.1-pro-preview)
 *   --no-judge               cost and routing only
 *   --rejudge                read every saved answer again with the judge (no new answers)
 *   --system <file>          the customer's own system prompt, sent to both paths
 *   --monthly <n>            project the costs to n questions a month
 *   --max-usd <n>            stop starting new questions once the pilot has spent this much (default 15)
 *
 * Everything is written to pilots/<name>/ (gitignored): results.json with every
 * answer, report.html (full, private to the customer) and summary.html (no
 * questions or answers). A rerun with the same --name keeps finished answers
 * and only runs what is missing.
 */
import fs from "node:fs";
import path from "node:path";
import { cheapFirst, defaultModels, MODES, modeFrom, SYSTEM_PROMPT, type Models } from "../src/cheapFirst";
import { chat, chatMessages, servModel, type ChatMessage, type ModelSpec } from "../src/models";
import {
  estimatePilotCost,
  judgePrompt,
  parseQuestions,
  readJudgement,
  renderPilotReport,
  summarizePilot,
  dollars,
  type PilotFailure,
  type PilotFile,
  type PilotJudgement,
  type PilotQuestion,
  type PilotRow,
} from "../src/pilot";

const CONCURRENCY = 4;
const JUDGE_MAX_TOKENS = 8000;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
function opt(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}
const VALUED = ["--name", "--customer", "--mode", "--premium", "--their-model", "--their-price", "--judge", "--system", "--monthly", "--max-usd"];
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUED.includes(argv[i - 1]));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const input = positional[0];
  if (!input) fail("Give the questions file: npm run pilot -- questions.csv");
  if (!fs.existsSync(input)) fail(`No file at ${input}`);
  const questions = parseQuestions(fs.readFileSync(input, "utf8"), input);
  if (!questions.length) fail(`No questions found in ${input}.`);

  const name = (opt("--name") ?? path.basename(input).replace(/\.[^.]+$/, "")).replace(/[^A-Za-z0-9._-]+/g, "-");
  const dir = path.join("pilots", name);
  const resultsPath = path.join(dir, "results.json");
  const mode = modeFrom(opt("--mode") ?? "balanced");
  const passMark = MODES[mode];
  const premiumId = opt("--premium") ?? "claude-opus-5.5";
  const judgeId = flags.has("--no-judge") ? null : (opt("--judge") ?? "gemini-3.1-pro-preview");
  const monthly = opt("--monthly") ? Number(opt("--monthly")) : undefined;
  const maxUsd = Number(opt("--max-usd") ?? 15);
  const theirModel = readTheirModel();
  const customSystem = opt("--system") ? fs.readFileSync(opt("--system")!, "utf8").trim() : "";
  const withRefs = questions.filter((q) => q.reference).length;

  console.log(`${questions.length} questions from ${input} (${withRefs} with a reference answer). Output: ${dir}/`);

  if (flags.has("--report-only")) {
    if (!fs.existsSync(resultsPath)) fail(`${resultsPath} doesn't exist yet. Run without --report-only first.`);
    writeReports(dir, JSON.parse(fs.readFileSync(resultsPath, "utf8")) as PilotFile);
    return;
  }

  const base = await defaultModels();
  const models: Models = { ...base, premium: premiumId === "claude-opus-5.5" ? base.premium : await servModel(`SERV · ${premiumId}`, premiumId) };
  const judge = judgeId ? await servModel(`SERV · ${judgeId}`, judgeId) : null;

  const estimate = estimatePilotCost(questions, { ...models, judge });
  console.log(
    `Estimated cost: about ${dollars(estimate.total)} (Cheap First ${dollars(estimate.cheapAndCheck)}, premium baseline ${dollars(estimate.premium)}, judge ${dollars(estimate.judge)}). ` +
      `Long answers cost more; this assumes about 800 output tokens per answer.`,
  );
  if (flags.has("--dry-run")) {
    console.log("Dry run only. No model calls were made and nothing was written.");
    return;
  }
  if (estimate.total > maxUsd) fail(`The estimate is over the --max-usd cap of ${dollars(maxUsd)}. Raise it with --max-usd to run anyway.`);

  fs.mkdirSync(dir, { recursive: true });
  const previous = fs.existsSync(resultsPath) ? (JSON.parse(fs.readFileSync(resultsPath, "utf8")) as PilotFile) : null;
  const byId = new Map(questions.map((q) => [q.id, q]));
  // Keep a saved answer only if it is still the same question with the same reference.
  const rows: PilotRow[] = (previous?.rows ?? []).filter((r) => byId.get(r.id)?.question === r.question && byId.get(r.id)?.reference === r.reference);
  const failures: PilotFailure[] = [];
  const done = new Set(rows.map((r) => r.id));
  const todo = questions.filter((q) => !done.has(q.id));
  if (rows.length) console.log(`Keeping ${rows.length} answers from the last run. Running ${todo.length}.`);

  const file: PilotFile = {
    pilot: name,
    customer: opt("--customer") ?? previous?.customer,
    ranAt: previous?.ranAt ?? new Date().toISOString(),
    mode,
    passMark,
    models: { cheap: models.cheap.label, checker: models.checker.label, premium: models.premium.label, judge: judge?.label ?? null },
    theirModel: theirModel ?? previous?.theirModel,
    monthlyQuestions: monthly ?? previous?.monthlyQuestions,
    expected: questions.length,
    rows,
    failures,
  };

  let spent = rows.reduce((sum, r) => sum + r.cheapFirst.costUsd + (r.answeredBy === "cheap" ? r.premium.costUsd : 0) + (r.judge?.costUsd ?? 0), 0);
  const order = new Map(questions.map((q, i) => [q.id, i]));
  const save = () => {
    file.rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    fs.writeFileSync(resultsPath, JSON.stringify(file, null, 2) + "\n");
  };

  // Saved answers the judge couldn't read last time get one more look.
  if (judge) {
    if (flags.has("--rejudge")) for (const r of rows) r.judge = null;
    const unjudged = rows.filter((r) => !r.judge);
    if (unjudged.length) console.log(`Judging ${unjudged.length} saved answers that weren't scored last time.`);
    for (const r of unjudged) {
      const q = byId.get(r.id)!;
      r.judge = await judgeOne(judge, q, r.cheap.answer, r.premium.answer).catch(() => null);
      spent += r.judge?.costUsd ?? 0;
    }
    if (unjudged.length) save();
  }

  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let q = queue.shift(); q; q = queue.shift()) {
        if (spent >= maxUsd) {
          failures.push({ id: q.id, error: `not run: the pilot reached the ${dollars(maxUsd)} spend cap` });
          continue;
        }
        try {
          const row = await runOne(q, models, judge, passMark, customSystem);
          spent += row.cheapFirst.costUsd + (row.answeredBy === "cheap" ? row.premium.costUsd : 0) + (row.judge?.costUsd ?? 0);
          rows.push(row);
          const verdict = row.judge ? (row.answeredBy === "cheap" ? row.judge.cheap.ok : row.judge.premium.ok) ? "ok" : "NOT OK" : "not judged";
          console.log(
            `${row.id}: check ${row.checkScore} -> ${row.answeredBy}, judge ${verdict} | ${dollars(row.cheapFirst.costUsd)} vs ${dollars(row.premium.costUsd)} | spent so far ${dollars(spent)}`,
          );
        } catch (e) {
          failures.push({ id: q.id, error: (e as Error).message });
          console.log(`${q.id}: failed (${(e as Error).message})`);
        }
        save();
      }
    }),
  );
  save();
  writeReports(dir, file);
  if (failures.length) {
    console.log(`${failures.length} questions did not finish. Run the same command again to retry just those.`);
    process.exitCode = 1;
  }
}

function readTheirModel(): PilotFile["theirModel"] {
  const label = opt("--their-model");
  const price = opt("--their-price");
  if (!label && !price) return undefined;
  if (!label || !price) fail("--their-model and --their-price go together, for example --their-model \"GPT-5.5\" --their-price 1.25,10");
  const [inputPerM, outputPerM] = price.split(",").map(Number);
  if (!(inputPerM >= 0) || !(outputPerM >= 0)) fail("--their-price is dollars per million input and output tokens, for example 1.25,10");
  return { label, inputPerM, outputPerM };
}

function messagesFor(q: PilotQuestion, customSystem: string): string | ChatMessage[] {
  return customSystem
    ? [
        { role: "system", content: customSystem },
        { role: "user", content: q.question },
      ]
    : q.question;
}

async function runOne(q: PilotQuestion, models: Models, judge: ModelSpec | null, passMark: number, customSystem: string): Promise<PilotRow> {
  // The reference answer is never passed to Cheap First: the checker must not see it.
  const cf = await cheapFirst(messagesFor(q, customSystem), models, undefined, { fallbackOnCheapError: false, passMark });
  // The always-premium baseline. When Cheap First escalated, its own premium call is the baseline, so it isn't paid twice.
  const system = customSystem ? `${SYSTEM_PROMPT}\n\n${customSystem}` : SYSTEM_PROMPT;
  const premium =
    cf.premium ??
    (await chatMessages(models.premium, [
      { role: "system", content: system },
      { role: "user", content: q.question },
    ]));
  const cfMs = cf.cheap.ms + cf.check.call.ms + (cf.premium?.ms ?? 0);
  return {
    id: q.id,
    question: q.question,
    ...(q.reference ? { reference: q.reference } : {}),
    answeredBy: cf.answeredBy,
    checkScore: cf.check.score,
    checkReason: cf.check.reason,
    checkSignal: cf.check.signal,
    cheap: { answer: cf.cheap.text, costUsd: cf.cheap.costUsd, ms: cf.cheap.ms, inputTokens: cf.cheap.inputTokens, outputTokens: cf.cheap.outputTokens },
    checkCostUsd: cf.check.call.costUsd,
    cheapFirst: { answer: cf.answer, costUsd: cf.costUsd, ms: cfMs },
    premium: { answer: premium.text, costUsd: premium.costUsd, ms: premium.ms, inputTokens: premium.inputTokens, outputTokens: premium.outputTokens },
    judge: judge ? await judgeOne(judge, q, cf.cheap.text, premium.text) : null,
  };
}

/** Two tries. A reply that still can't be read leaves the row unjudged rather than guessing. */
async function judgeOne(judge: ModelSpec, q: PilotQuestion, cheap: string, premium: string): Promise<PilotJudgement | null> {
  let cost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cheapFirstInA = Math.random() < 0.5;
    const { system, user } = judgePrompt(q, cheap, premium, cheapFirstInA);
    const call = await chat(judge, system, user, JUDGE_MAX_TOKENS);
    cost += call.costUsd;
    const read = readJudgement(call.text, cheapFirstInA, q.reference ? "reference" : "premium", cost);
    if (read) return read;
  }
  return null;
}

function writeReports(dir: string, file: PilotFile): void {
  fs.writeFileSync(path.join(dir, "report.html"), renderPilotReport(file, { full: true }));
  fs.writeFileSync(path.join(dir, "summary.html"), renderPilotReport(file, { full: false }));
  const s = summarizePilot(file);
  console.log(
    [
      "",
      `Cheap First ${dollars(s.costUsd.cheapFirst)} vs always-premium ${dollars(s.costUsd.premium)}: ${s.savingPct ?? "n/a"}% cheaper on ${s.questions} questions.`,
      `Stayed cheap ${s.stayedCheap}, escalated ${s.escalated}.`,
      s.judged
        ? `Judge ok: cheap alone ${s.ok.cheapAlone}, Cheap First ${s.ok.cheapFirst}, premium ${s.ok.premium} (of ${s.judged}). Catches ${s.catches}, misses ${s.missed}, false alarms ${s.falseAlarms}.`
        : "No judge ran.",
      `This pilot cost ${dollars(s.pilotCostUsd)} to run.`,
      `Report: ${path.join(dir, "report.html")} (full, send to the customer). Summary without questions: ${path.join(dir, "summary.html")}.`,
    ].join("\n"),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
