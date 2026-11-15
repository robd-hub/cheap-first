/**
 * An independent check of the benchmark's quality numbers. The benchmark's
 * scores come from the same checker that decides when to escalate, so here
 * Reppo's panel of independent judges scores a sample of questions both ways:
 * the answer Cheap First gave, and the answer the premium model gave.
 *
 * The sample is one or two questions from each category, picked the same way
 * every time, only where Cheap First kept the cheap answer (where it escalated,
 * both answers are the same premium answer, so there's nothing to compare).
 *
 *   npm run reppo-sample          # 10 questions = 20 Reppo evaluations (440 credits each)
 *   npm run reppo-sample -- 6     # a smaller sample
 *
 * Needs REPPO_API_KEY. Saves data/reppo-sample.json, which the results page shows.
 */
import fs from "node:fs";

const REPPO = (process.env.REPPO_API_URL || "https://eval.reppo.xyz/api/v1").replace(/\/$/, "");
const KEY = process.env.REPPO_API_KEY;
const OUT = "data/reppo-sample.json";
const MAX_IN_FLIGHT = 4;

interface ResultRow {
  id: string;
  category: string;
  prompt: string;
  criteria: string;
  answeredBy: "cheap" | "premium";
  cheapFirst: { answer: string; score: number };
  premium: { answer: string; score: number };
}

interface Job {
  id: string;
  side: "cheapFirst" | "premium";
  input: string;
  evalId?: string;
  score?: number;
  decision?: string;
  reason?: string;
  error?: string;
}

function headers() {
  return { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
}

/** Picks a fixed, spread-out sample: round-robin over categories, in file order. */
export function pickSample(rows: ResultRow[], n: number): ResultRow[] {
  const byCat = new Map<string, ResultRow[]>();
  for (const r of rows.filter((r) => r.answeredBy === "cheap")) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  const cats = [...byCat.keys()].sort();
  const out: ResultRow[] = [];
  for (let round = 0; out.length < n; round++) {
    let added = false;
    for (const c of cats) {
      const r = byCat.get(c)![round];
      if (r && out.length < n) {
        out.push(r);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

async function submit(job: Job): Promise<"ok" | "busy" | "stop"> {
  const res = await fetch(`${REPPO}/agents/evals`, { method: "POST", headers: headers(), body: JSON.stringify({ taskType: "response", input: job.input.slice(0, 50_000) }) });
  if (res.status === 409) return "busy";
  if (res.status === 402) {
    job.error = "Out of Reppo credits";
    return "stop";
  }
  if (!res.ok) {
    job.error = `Reppo returned ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return "ok";
  }
  job.evalId = ((await res.json()) as { id?: string }).id;
  if (!job.evalId) job.error = "Reppo gave no id";
  return "ok";
}

async function poll(job: Job): Promise<boolean> {
  const res = await fetch(`${REPPO}/agents/evals/${job.evalId}`, { headers: headers() });
  if (!res.ok) return false;
  const body = (await res.json()) as { status: string; result?: { score?: number; decision?: string; reason?: string }; error?: unknown };
  if (body.status === "FAILED") {
    job.error = `Reppo evaluation failed: ${JSON.stringify(body.error ?? "")}`.slice(0, 300);
    return true;
  }
  if (body.status !== "COMPLETED" || !body.result || typeof body.result.score !== "number") return false;
  job.score = Math.round(body.result.score);
  job.decision = body.result.decision;
  job.reason = body.result.reason;
  return true;
}

async function main() {
  if (!KEY) throw new Error("REPPO_API_KEY is not set");
  const n = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a))) || 10;
  const rows = (JSON.parse(fs.readFileSync("data/results.json", "utf8")) as { rows: ResultRow[] }).rows;
  const sample = pickSample(rows, n);
  const jobs: Job[] = sample.flatMap((r) =>
    (["cheapFirst", "premium"] as const).map((side) => ({
      id: r.id,
      side,
      input: `User prompt: ${r.prompt}\n\nWhat a good answer looks like: ${r.criteria}\n\nAI response: ${r[side].answer || "(empty answer)"}`,
    })),
  );
  console.log(`Sending ${jobs.length} answers (${sample.length} questions) to Reppo.`);

  let stopped = false;
  while (jobs.some((j) => j.score === undefined && !j.error)) {
    for (const j of jobs.filter((j) => j.evalId && j.score === undefined && !j.error)) {
      if (await poll(j)) console.log(`  ${j.id} / ${j.side}: ${j.error ?? `${j.score}/100 (${j.decision ?? "no decision"})`}`);
    }
    const inFlight = jobs.filter((j) => j.evalId && j.score === undefined && !j.error).length;
    for (const j of jobs.filter((j) => !j.evalId && !j.error).slice(0, Math.max(0, MAX_IN_FLIGHT - inFlight))) {
      if (stopped) break;
      const r = await submit(j);
      if (r === "busy") break;
      if (r === "stop") {
        stopped = true;
        for (const k of jobs.filter((k) => !k.evalId && !k.error)) k.error = "Out of Reppo credits";
      }
    }
    if (jobs.some((j) => j.score === undefined && !j.error)) await new Promise((r) => setTimeout(r, 15_000));
  }

  const questions = sample.map((r) => {
    const cf = jobs.find((j) => j.id === r.id && j.side === "cheapFirst")!;
    const pr = jobs.find((j) => j.id === r.id && j.side === "premium")!;
    return {
      id: r.id,
      category: r.category,
      prompt: r.prompt,
      cheapFirst: { score: cf.score ?? null, decision: cf.decision ?? null, reason: cf.reason ?? cf.error ?? null, checkerScore: r.cheapFirst.score },
      premium: { score: pr.score ?? null, decision: pr.decision ?? null, reason: pr.reason ?? pr.error ?? null, checkerScore: r.premium.score },
    };
  });
  const both = questions.filter((q) => q.cheapFirst.score !== null && q.premium.score !== null);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const out = {
    ranAt: new Date().toISOString(),
    judged: both.length,
    cheapFirstAvg: avg(both.map((q) => q.cheapFirst.score!)),
    premiumAvg: avg(both.map((q) => q.premium.score!)),
    questions,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nReppo judges, ${both.length} questions: Cheap First ${out.cheapFirstAvg} vs premium only ${out.premiumAvg}. Saved ${OUT}.`);
}

if (process.argv[1]?.endsWith("reppo-sample.ts")) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
