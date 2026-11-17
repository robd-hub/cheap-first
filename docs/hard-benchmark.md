# The hard benchmark

The main benchmark has a fair criticism: 139 of its 143 answers never needed the premium model,
so maybe the questions were just easy. It also lets the checker see a guide to the right answer,
and the same checker grades the final answers. This benchmark fixes all three:

- **Harder, real-world style questions.** 97 of them, in two rounds (below).
- **Graded by code, against known answers.** Every correct answer is computed by a script, not
  typed in, and every answer is marked right or wrong by code (`scripts/hard-grade.ts`). No model
  grades the results.
- **The checker gets no answer key.** Just like in real use, it only sees the question and the answer.

Run on 17 November 2026 with the live setup: Dolphin's DeepSeek V4.1 Flash answers, SERV's GPT-6
Luna checks (pass mark 75), Claude Opus 5.5 on SERV is the premium model.

## Headline

| 97 hard questions | Cheap First | Premium only |
|---|---|---|
| Correct answers (checked by code) | **97 of 97** | 97 of 97 |
| Total cost | **$0.27** | $1.42 |
| Saving | **81%** | |
| Answered by Dolphin alone | **94 of 97** | |

And the test the sceptics really want, the checker against **real** mistakes:

| 290 answers from 3 weaker models | |
|---|---|
| Wrong answers | 124 |
| Caught by the checker | **115 (93%)** |
| Let through | 9, of which 5 were only the wrong status label (no made-up data) |
| False alarms on right answers | 13 of 166 (8%) |

## Round 1: 60 hard questions

Five groups of 12, written to be realistic and hard:

- **Reasoning:** loan payments, FIFO stock costs, overtime pay, critical-path scheduling, a logic grid,
  time zones across a clock change, probability.
- **Trick facts:** facts that are often answered wrong (most time zones: France; closest US state to
  Africa: Maine; planet closest to Earth on average: Mercury).
- **Strict instructions:** exact sentence and word counts, no letter "e", raw JSON only, acrostics,
  sorting names, counting letters.
- **Tool failures:** an agent gets a tool result and must answer in JSON with a status. Half the
  tools failed (503 error, empty result, truncated JSON, wrong ticker, stale price, rate limit,
  two people called Sam) and half worked, including one with a prompt injection hidden in a web page.
- **Messy data:** invoices with discounts and tax, a CSV with dirty category names, logs, a
  timesheet across midnight, a bill split, semantic version sorting.

**Result: Dolphin got all 60 right.** The checker passed every one and nothing escalated. Cheap
First cost $0.014 against $0.65 for premium only, a 98% saving, with the same 60 of 60 correct.

That's good news for the savings claim, but it means round 1 never tested the safety net.

## Round 2: 37 "breaking point" questions

So round 2 went after the things small models are known to get wrong: a 30-year mortgage balance
after 37 payments (cent rounding each month), a 20-digit multiplication, adding 40 amounts, a
knapsack problem, business days with holidays, cron schedules, three cities across clock changes,
deduplicating Gmail addresses, IP subnets, tracing tricky Python, a regex, shortest paths, counting
"the" in a 320-word text, reversing a string, exactly 100 words, palindromes, and more tool traps
(paginated results, units in metres, a refund "SYSTEM OVERRIDE" injection, a partial batch failure,
a forecast for the wrong dates).

Every question that was written was run and is in the results. None were dropped.

**Result:**

| 37 stress questions | Cheap First | Premium only |
|---|---|---|
| Correct (checked by code) | **37 of 37** | 37 of 37 |
| Dolphin alone | 36 of 37 | |
| Cost | **$0.25** | $0.77 |
| Saving | **67%** | |

Three questions escalated:

- **Mortgage balance: a real catch.** Dolphin returned a blank answer, which goes straight to the
  premium model without a check. Opus got it right ($239,688.79).
- **Q3 transactions: a false alarm.** Dolphin's "18" was right, but it gave only the final line and
  the checker marked it down for not showing its work.
- **80 to 100 words without "e": a false alarm.** Dolphin's text had no "e" at all, but the checker
  said it did. Counting letters is a known weak spot for language models, and that includes checkers.

The two false alarms are where the stress-set saving drops from 98% to 67%: a false alarm pays for
Dolphin, the check and the premium answer.

## Round 3: the checker against real mistakes

Dolphin was too good to give the checker much to catch, so round 3 asked three weaker, older models
on SERV (GPT-5.4 Nano, Gemini 3.1 Flash Lite and SERV Nano) to answer all 97 questions, and asked
the checker about each answer with no answer key. That gave 290 answers (one call failed), of which
124 were wrong, checked by code.

**The checker caught 115 of the 124 wrong answers (93%).** The 9 it let through:

- **5 were only the wrong status label.** A tool failed, and the model said `needs_clarification`
  where `unavailable` was expected. None of them made up data.
- **4 were real wrong answers:**
  - South Africa has 11 official languages. It has 12 since 2023, and the checker believed the old fact too.
  - Two wrong counts of US states with a land border with Canada (11 and 13; the answer is 10,
    because Michigan, Ohio and Pennsylvania meet Canada only across water). The question is a trap
    and many websites say 13.
  - A cron schedule that skipped two runs before the weekend.

So about 3% of wrong answers would have reached a user with something truly wrong. The pattern is
clear: the checker misses mistakes it shares, like outdated or commonly repeated facts.

It also raised **13 false alarms on 166 right answers (8%)**. Those cost money but never cost quality.

## What this shows, and what it doesn't

- **The savings hold on hard questions.** 81% cheaper across 97 hard questions with no loss of
  correctness. Most of the saving comes from Dolphin being much stronger than its price suggests.
- **The checker is the right design, and it is not perfect.** It caught 93% of real mistakes from
  weaker models, and in an earlier test 29 of 30 planted wrong answers. Its blind spots are shared
  facts and exact letter counting.
- **Dolphin's own failures were rare.** In 97 hard questions it got one wrong, and that was a blank
  answer, which Cheap First escalates without needing the checker. So the end-to-end escalation path
  on Dolphin's real answers is still only lightly tested.
- **The questions were written for this test** by the AI that helped build Cheap First, not taken from a public benchmark.
  The script that builds them is in the repo so anyone can check the answers or add more.

Honest notes on grading: after the first run, four grading rules were fixed. The Canada question's
answer was corrected from 13 to 10 (it asks about land borders), "250 euros is 271.05 dollars" was
being read as 250, `not_found` was allowed alongside `unavailable` for the wrong-ticker case, and a
number anywhere on the final line now counts (so "18 points, value 104" reads as 104). Each fix made
a correct answer count as correct, for every model alike.

## Run it yourself

```bash
python3 scripts/make-hard-set.py                   # builds data/hard-questions.json (60)
python3 scripts/make-stress-set.py                 # builds data/stress-questions.json (37)
npm run hard-benchmark                             # round 1, saves data/hard-results.json
npm run hard-benchmark -- --set stress             # round 2, saves data/stress-results.json
npm run hard-benchmark -- --regrade                # re-grade saved answers, no API calls
NODE_USE_ENV_PROXY=1 npx tsx scripts/real-mistakes.ts   # round 3, saves data/real-mistakes.json
```

All three rounds together cost about $1.60 in API calls.
