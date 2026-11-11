# Cheap First

**Most questions don't need a frontier model.** Cheap First answers every question with
[Dolphin](https://dphn.ai)'s very cheap model first, has [SERV Reasoning](https://www.openserv.ai/)
check the answer, and only pays for a frontier model when the check fails.

**Live results:** https://robd-hub.github.io/cheap-first/

Built for [SERV Hackathon 02](https://www.openserv.ai/hackathon-2), Dolphin track.

## How it works

1. **Dolphin answers.** DeepSeek V4.1 Flash on the Dolphin network, at $0.01 in and $0.07 out per million tokens.
2. **SERV checks.** A small SERV Reasoning model (GPT-6 Luna) scores the answer from 0 to 100 for correctness,
   whether it followed the instructions, and whether anything was made up.
3. **Escalate only if needed.** If the score is below 75, the question goes to a frontier model
   on SERV (Claude Opus 5.5) and that answer is returned instead.

The check costs a fraction of a cent, so even after paying for it on every question,
Cheap First costs far less than sending everything to the frontier model, while keeping its quality.

## The benchmark

`data/questions.json` holds 143 questions, from everyday ones to hard maths, logic and code traps plus 39 "stress tests", across facts, maths, code, writing, reasoning,
honesty ("don't make things up") and instruction-following. `npm run benchmark` runs each one two ways:

- **Cheap First**, as above.
- **Premium only**, sending every question to the frontier model.

Both final answers are scored by the same checker against the same criteria, so quality and cost
can be compared side by side. Every cost comes from the token counts each API returned, priced
at Dolphin's published rate and SERV's own model list. Results are saved to `data/results.json`
and published at the link above.

## Use it

```bash
npm install
export DOLPHIN_API_KEY=...   # from app.dphn.ai → API Keys
export SERV_API_KEY=...      # from console.openserv.ai
npm run ask -- "How many seconds are there in 3.5 hours?"
```

It prints the answer, which model gave it, the check score and what it cost.
In your own code:

```ts
import { cheapFirst, defaultModels } from "./src/cheapFirst";

const result = await cheapFirst("Summarise this email in one line: ...", await defaultModels());
console.log(result.answer, result.answeredBy, result.costUsd);
```

| Command | What it does |
|---|---|
| `npm run ask -- "question"` | Answer one question the Cheap First way |
| `npm run benchmark` | Run the benchmark (pass question ids to run just those) and save `data/results.json` |
| `npx tsx scripts/check-sanity.ts` | Feed the checker deliberately wrong answers to show it catches them |
| `npm run build` | Build the results page into `out/` (no keys needed) |

## Public site

`.github/workflows/pages.yml` rebuilds the results page on GitHub Pages every time `main` changes.
The page is plain HTML built from `data/results.json`, so no keys are ever used or exposed there.

## Helper scripts

| Command | What it does |
|---|---|
| `npx tsx scripts/probe.ts file.json [out.json]` | Try questions on Dolphin + the checker only, in parallel, to find ones Dolphin gets wrong |
| `npx tsx scripts/check-sanity.ts` | Grade deliberately wrong answers and save `data/checker-test.json` for the site |
