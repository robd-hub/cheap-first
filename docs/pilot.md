# Savings pilot: "bring your own questions"

A builder sends about 100 of their real questions. We run each one through Cheap First and through the premium model on its own, and send back a report: what each way cost, how many questions stayed on the cheap model, how many escalated, and what a separate judge model thought of every answer.

## Run one

1. Save the builder's questions in the repo folder, for example `acme.csv`. Accepted:
   - a CSV with a `question` column, and optionally `reference` (the answer they expect) and `id` columns ([example](pilot-sample.csv))
   - a plain `.txt` file with one question per line, or questions separated by a line holding only `---`
   - `.jsonl` or `.json` with `{"question": "...", "reference": "..."}`
2. Check the cost first. This reads the file and calls no model:
   ```bash
   npm run pilot -- acme.csv --dry-run
   ```
3. Run it:
   ```bash
   npm run pilot -- acme.csv --customer "Acme" --monthly 50000
   ```
4. Send `pilots/acme/report.html` to the builder. It is one file with no scripts or outside links. It opens in any browser and prints to PDF.

If anything fails part way, run the same command again. Finished answers are kept and only the missing ones run.

Useful options:

| Option | What it does |
| --- | --- |
| `--monthly 50000` | Adds "at 50,000 questions a month, about $X against $Y". A straight projection, labelled as one. |
| `--their-model "GPT-5.5" --their-price 6.5,39` | Also prices the premium answers at the builder's own model's published rates (dollars per million input, output tokens). Labelled as an estimate, because that model did not answer. |
| `--premium gpt-5.5` | Use another SERV model as the premium baseline and escalation model, when the builder uses one SERV has. Default `claude-opus-5.5`. |
| `--system prompt.txt` | The builder's own system prompt, sent to both paths. |
| `--mode strict` | Cheap First's pass mark: `strict` 85, `balanced` 75 (default), `budget` 60. |
| `--judge <SERV model>` / `--no-judge` | The model that reads the answers for the report (default `gemini-3.1-pro-preview`), or none. |
| `--rejudge` | Read every saved answer again with the judge. No new answers. |
| `--report-only` | Rewrite the report from saved answers. No model calls. |
| `--max-usd 15` | Refuses to start when the estimate is over this, and stops starting new questions once the run has spent it. Default $15. |

## What it costs us

Every question is answered three ways: Cheap First (cheap answer and check, plus premium when it escalates), the premium model on its own for the baseline, and the judge. The premium baseline is most of the bill.

- Measured on the 12 short questions in `pilot-sample.csv` (2026-11-23): $0.098 in all, about **$0.82 per 100 questions**.
- The `--dry-run` estimate assumes about 800 output tokens per answer, which gives about **$5 per 100** for short questions. Long answers or long questions cost more, so run `--dry-run` on the real file every time.

## What the report says, and doesn't

- Costs are what the providers billed per token on this run.
- The judge is a different model from the checker. It never decides routing. It sees the two answers as A and B in a random order. With a reference answer it judges against that; without one it gives its own reading, and the report says that is a second opinion, not proof.
- Misses (a cheap answer returned that the judge marked not ok) are counted and listed first, then every escalation, so the builder can check them.
- The report always states that Cheap First is slower, with the median and 90th percentile times.
- It never says "same quality".

## Privacy

Everything is written to `pilots/<name>/`, which is gitignored. Customer questions never go in `data/`, the live stats, the site or a commit. `summary.html` leaves out every question and answer, for sharing only with the builder's permission. Delete the folder when the pilot is over.
