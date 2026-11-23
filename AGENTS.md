# Cheap First

Cheap First answers with a cheap model, checks that answer, and calls a frontier model only when the check fails. The aim is best in class, improved continuously, and eventually commercial. Rob Doughty ([robd-hub](https://github.com/robd-hub)) built it for OpenServ SERV Hackathon 02.

Quote the saving and the accuracy gap together. On the published public run that is about 95.5% cheaper and 2 points behind the premium model. Never write "same quality": `src/publicReport.test.ts` and `src/mcp.test.ts` reject that phrase in the public summary.

## How a question is answered

`src/cheapFirst.ts` is the loop. `src/models.ts` calls the APIs. `defaultModels()` chooses the three models:

| Role | Model | Key | Model id |
|---|---|---|---|
| Cheap | Dolphin · DeepSeek V4.1 Flash | `DOLPHIN_API_KEY` (the typo `DOLHPIN_API_KEY` is also read) | `deepseek-ai/DeepSeek-V4.1-Flash` |
| Checker | SERV · GPT-6 Luna | `SERV_API_KEY` | `gpt-6-luna` |
| Premium | SERV · Claude Opus 5.5 | `SERV_API_KEY` | `claude-opus-5.5` |

The checker scores 0 to 100. The default pass mark is 75 (`balanced`). `strict` is 85 and `budget` is 60. Below the mark, or when Dolphin returns nothing, the premium model answers. `CF_CHECKER=dolphin` makes the cheap model grade itself; leave it unset for GPT-6 Luna. SERV prices are read from SERV's model list once per server instance (`sharedModels`, started when an endpoint file loads). Dolphin's published rates in `src/models.ts` are $0.01 in and $0.07 out per million tokens.

Speed settings: the cheap model is sent `reasoning_effort` `low` (`CF_CHEAP_REASONING`; `default` sends nothing). Dolphin's 429 means too many requests are running at once, so it is retried after short waits (`DOLPHIN_BUSY_WAITS_MS`, about 9 seconds in all) instead of its 10-second `retry-after`. If the cheap answer hasn't arrived after `CF_CHEAP_HEDGE_MS` (8000), a second copy is sent and the first answer wins (`hedged`). The checker keeps SERV's default effort: `low` let a planted error through once on `scripts/trap-test.ts` cases.

## Live stats

`src/liveStats.ts` stores totals only, in the Upstash Redis hash `cf:live:v1`. The env pair is `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (`src/store.ts`). Prompts, answers, and keys are not accepted by these functions and are not written. With neither pair set, the page stays empty and records nothing.

`api/stats.ts` serves `/stats` and `/api/stats`. `vercel.json` rewrites `/stats` to `/api/stats`. `?format=json` forces JSON. A real catch is a non-blank cheap answer scored under that request's pass mark, so the premium model answered. The text is not kept, so a catch is the checker's decision, not a stored proof the cheap answer was wrong.

## MCP

`src/mcp.ts` and `api/mcp.ts` are a stateless Streamable HTTP server, also mounted at `/mcp` (`https://cheap-first.vercel.app/mcp`). Two tools:

- `ask_cheap_first` takes `question` and an optional `mode` of `strict`, `balanced` (default), or `budget`. It returns `answer`, `escalated`, `checkScore`, `costUsd`, and `savedUsd`.
- `cheap_first_stats` takes nothing. It returns published benchmark figures from the saved JSON and does not call a model.

`npm run mcp` (`src/mcpStdio.ts`) reads stdin and posts to the hosted endpoint. Free calls share the `/api/ask` demo limits: 600 characters, 10 an hour per IP, and 300 a day.

## Run, test, benchmarks

CI (`.github/workflows/ci.yml`) is Node 22: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. No API keys.

```bash
npm install
export DOLPHIN_API_KEY=...   # app.dphn.ai → API Keys
export SERV_API_KEY=...      # console.openserv.ai
npm run ask -- "How many seconds are there in 3.5 hours?"
```

`npm test` runs `src/limits.test.ts`, `src/mcp.test.ts`, `src/mcpStdio.test.ts`, `src/publicGrade.test.ts`, `src/publicReport.test.ts`, `src/liveStats.test.ts`, `src/checkSignals.test.ts`, `src/cheapFirst.test.ts`, `src/speed.test.ts`, `src/visits.test.ts`, and `src/pilot.test.ts`. `npm run build` writes the results site to `out/` from the JSON.

Commands in `package.json`:

| Command | What it writes |
|---|---|
| `npm run public-benchmark` | `data/public-benchmark.json`. Pins and hashes are in `src/publicSets.ts` (seed `20261120`). `-- --dry-run` checks the files and calls no model. `-- --regrade` regrades saved answers. Other arguments are question ids to rerun. |
| `npm run benchmark` | `data/results.json`, from the 143 questions in `data/questions.json`. Pass ids to run a subset. |
| `npm run pilot -- <questions file>` | `pilots/<name>/` (gitignored): a builder's own questions through Cheap First and premium alone, judged, with `report.html` and `summary.html`. See `docs/pilot.md`. Never commit customer questions. |
| `npm run hard-benchmark` | `data/hard-results.json` from `data/hard-questions.json` (60). `-- --set stress` writes `data/stress-results.json` from `data/stress-questions.json` (37). `-- --regrade` skips model calls. |

The published hard headline is both rounds together: 97 questions in `docs/hard-benchmark.md`. `src/stats.ts` sums those two summaries for `cheap_first_stats`. Also in `package.json`: `latency` (times ten everyday questions end to end; median and slowest), `compare-checkers`, `reppo-sample`, `verify-test`, `near-test`. Not wired as npm scripts: `npx tsx scripts/check-sanity.ts` and `npx tsx scripts/probe.ts`.

## Published public numbers

Take figures from `data/public-benchmark.json`. Do not type a new rounding. `src/publicReport.ts` formats display strings: dollars to three places (`publicDollars`), accuracy and latency to one decimal, and `savingPct` as stored. The README's public section has to match `publicResultsMarkdown`.

The file is `complete: true`, `expected: 300`, seed `20261120`, `ranAt` `2026-11-20T13:24:49.531Z`. GSM8K test, 200 of 1,319. ARC-Challenge test, 100 of 1,172. Code grades the finals (GSM8K compares the number, ARC-Challenge the choice label). The checker does not see the answer key and does not mark those finals.

From `summary`:

- `correct`: cheap alone 288, Cheap First 288, premium 294. `accuracy`: 0.96, 0.96, 0.98, shown as 96.0% and 98.0%.
- `costUsd.cheapFirst` is `0.08763382999999998` and `costUsd.premium` is `1.9453392000000007`, shown as **$0.088** and **$1.945**. `savingPct` is **95.5**.
- `escalated` 5, `catches` 0, `missed` 11, `falseAlarms` 4, `escalatedStillWrong` 1, `blankEscalations` 0.
- Latency, milliseconds: Cheap First mean 12665 and median 6108; premium mean 2722 and median 2673. Shown as mean 12.7s vs 2.7s and median 6.1s vs 2.7s.
- GSM8K: Cheap First 194/200, premium 198/200. ARC-Challenge: 94/100 and 96/100.

State the limits with the saving. Cheap First is slower, 2 points behind the premium model (96.0% vs 98.0%), and it scored the same as the cheap model alone: the checker made 0 real catches, let 11 wrong cheap answers through, and 4 of the 5 escalations were false alarms. One escalation was still wrong.

The in-house 143 in `data/results.json` is a different run. The checker scores it, and on some questions it sees a written guide. Do not quote those figures as the public result.

## Open work

[PR #30](https://github.com/robd-hub/cheap-first/pull/30), branch `cursor/checker-escalation-d10e`, replaces grading for number and multiple-choice questions with sample agreement plus an arithmetic check. Other prompts stay with GPT-6 Luna. That branch does not modify `data/public-benchmark.json`.

It is waiting on Rob, on that branch, before merge:

```bash
npm run public-tune -- --dry-run
npm run public-tune          # writes data/public-tuning.json
npm run public-compare -- --dry-run
npm run public-compare       # writes data/public-compare.json
```

Those two scripts are not on `main`. The tuning sample is seed `20261121`, 40 GSM8K and 20 ARC-Challenge, drawn only after every id from the reported 300 is removed. Commit `data/public-tuning.json` and `data/public-compare.json` from those runs. Quote `summary` in the compare file next to its `published` field. Do not hand-write an accuracy figure.

## Rules

- Never claim "same quality".
- State the limits in the same breath as a saving: slower, behind on this sample, and what the checker missed.
- Published numbers come from the generated JSON. Use `src/publicReport.ts` when a display string is required.
- A tuning set must never overlap the reported 300 (seed `20261120`).
- Never commit secrets. `.env` is gitignored. Names are listed in `.env.example`.
- British English is fine.
