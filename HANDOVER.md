# Handover

Current as of 24 Nov 2026. `main` is `c08a562` ([PR #42](https://github.com/robd-hub/cheap-first/pull/42)). There was no handover file in the repo. `AGENTS.md` is the agent source of truth; its "Open work" section is stale (see [Known gaps](#known-gaps)).

## What Cheap First is

Cheap First answers with a cheap model, checks that answer, and calls a frontier model only when the check fails. Rob Doughty ([robd-hub](https://github.com/robd-hub)) built it for OpenServ SERV Hackathon 02. The aim is best in class, improved continuously, and eventually commercial.

The loop is `src/cheapFirst.ts`. API calls are `src/models.ts`. Quote a saving with the accuracy gap and the speed. On the published public run that is about **95.5% cheaper** and **2 points behind** the premium model (96.0% vs 98.0%), and slower (median 6.1s vs 2.7s). Never write "same quality".

## Live URLs

Both hosts serve the same results site. The API runs on Vercel.

| URL | Role |
|---|---|
| https://cheap-first.vercel.app | API and site. OpenAI base URL `https://cheap-first.vercel.app/api/v1`. MCP at `/mcp`. |
| https://cheapfirst.designimp.com | Same deployment. `api/v1/chat/completions.ts` names this host as the client base URL (`/api/v1`). |
| https://robd-hub.github.io/cheap-first/ | GitHub Pages rebuild of the results site from `main`. The Try it box posts to the Vercel `/api/ask`. |

## Models

| Role | Model | Key | Model id |
|---|---|---|---|
| Cheap | Dolphin · DeepSeek V4.1 Flash | `DOLPHIN_API_KEY` (`DOLHPIN_API_KEY` is also read) | `deepseek-ai/DeepSeek-V4.1-Flash` |
| Checker | SERV · GPT-6 Luna | `SERV_API_KEY` | `gpt-6-luna` |
| Premium | SERV · Claude Opus 5.5 | `SERV_API_KEY` | `claude-opus-5.5` |

Dolphin's published rates in `src/models.ts` are $0.01 in and $0.07 out per million tokens. SERV prices are read from SERV's model list once per server instance. Leave `CF_CHECKER` unset so GPT-6 Luna grades. `CF_CHECKER=dolphin` makes the cheap model grade itself.

Pass marks: `strict` 85, `balanced` 75 (default), `budget` 60. Below the mark, or when Dolphin returns nothing, the premium model answers.

Since [PR #30](https://github.com/robd-hub/cheap-first/pull/30) (merged): a number or a multiple-choice question is checked by one extra cheap sample (two in strict) plus an arithmetic check of equations in the answer. Anything else is still scored by GPT-6 Luna. The published `data/public-benchmark.json` was not regenerated, so its 0 real catches are the old grader.

## Endpoints

Vercel Hobby allows 12 serverless functions. `api/` is already at 12 (`ask`, `discovery`, `key`, `mcp`, `near`, `openapi`, `openserv`, `pay`, `stats`, `v1/chat/completions`, `v1/models`, `verify`). Do not add a thirteenth file there. Extra paths are rewrites in `vercel.json`.

| Path | What it does |
|---|---|
| `POST /api/v1/chat/completions` | OpenAI chat completions. Models `cheap-first`, `cheap-first-strict`, `cheap-first-budget`. Any other name is treated as `cheap-first`. Up to 40 messages and 6,000 characters. Reply includes `cheap_first` (who answered, check, cost, saving). |
| `GET /api/v1/models` | Lists those model names. |
| `POST /api/ask` | Free demo behind the Try it box. 600 characters, 10 an hour per IP (`CF_PER_IP_PER_HOUR`), 300 a day (`CF_DAILY_CAP`). |
| `POST /mcp` and `POST /api/mcp` | Stateless Streamable HTTP MCP. Tools: `ask_cheap_first` (`question`, optional `mode`) and `cheap_first_stats` (published JSON only, no model call). Free calls share the `/api/ask` limits. `npm run mcp` is a local stdin bridge to the hosted endpoint. |
| `GET /api/key` | With `Authorization: Bearer cf_...`, answers left. With `?session=` it would mint a Stripe key. Stripe is off, so that path is unused. |
| `POST /api/key` and `POST /api/admin/keys` | Mint a trial key. The admin URL rewrites to `api/key.ts`. |
| `POST /api/pay` | Paid answer, $0.005. Body `question` (up to 2,000 characters) and optional `mode`. |
| `GET /stats` and `GET /api/stats` | Live totals only. `?format=json` forces JSON. No prompts or keys are stored. |
| `GET /openapi.json` | Rewrites to `/api/openapi`, so x402scan can find the paid routes. |

Also on the same deployment, not the main product path: `POST /api/verify` (and `/quick`, `/free`), `POST /api/openserv` (also `/openserv`), `POST /api/near`, `GET /.well-known/x402` (rewrite to `/api/discovery`), and `/visits` (cookie-free counter, served by `api/stats.ts`).

## Payments

Three ways to pay for an answer. Card checkout is deliberately off.

- **x402, USDC on Base** (`eip155:8453`). No `Authorization` header gets **402** with the challenge. Price is $0.005 (`PRICE_USDC_MICRO` 5000). Settled after a successful answer. Wallet and facilitator names are in `.env.example` (`PAY_TO_ADDRESS`, `X402_FACILITATOR_URL`, optional CDP keys).
- **Prepaid or trial `cf_` keys.** `Authorization: Bearer cf_...` on `/api/v1/chat/completions`, `/api/pay`, and MCP. One credit per answer. A failed answer refunds the credit. Only a hash is stored. Plaintext is shown once.
- **Stripe is off.** Do not set `STRIPE_SECRET_KEY` or `CF_CARD_LINK`. Nothing in the trial-key work turns them on. The card section in the README is the switch-on procedure, not the live setup.

## Trial keys

`CF_ADMIN_TOKEN` is set in the Vercel project as of 24 Nov 2026. The value is not in the repo and must not be committed. Unset, `POST /api/admin/keys` returns 503.

Mint 200 answers (the default) for someone:

```bash
curl -sS -X POST https://cheap-first.vercel.app/api/admin/keys \
  -H "Authorization: Bearer $CF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"answers":200,"label":"ada"}'
```

Same mint against the Upstash store in the environment:

```bash
npm run trial-key -- --answers 200 --label ada
```

`answers` may be omitted (`CF_TRIAL_ANSWERS`, default 200, max 10,000). `label` is an optional note, stored with the hash. The JSON response includes `key`, `answers`, `ratePerMinute`, and `dailySpendCapUsd`. Trial keys use the same counters as a card key. They need Upstash (`KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`). A request with no key still gets the x402 402.

## Limits and environment variables

Names only. Values live in Vercel or a gitignored `.env`. The list is `.env.example`.

| Variable | Default | What it caps |
|---|---|---|
| `CF_TRIAL_ANSWERS` | 200 | Answers when a mint omits `answers`. |
| `CF_KEY_RATE_PER_MIN` | 20 | Requests per key per minute. A limited request does not take a credit. |
| `CF_DAILY_SPEND_CAP_USD` | 3 | Cheap + checker + premium spend for every API key together, per UTC day. Sits on top of the premium budget. x402 calls are not counted. A request already in flight can finish, so the stored total can land a little over the cap; the next request is refused. |
| `CF_PAID_PREMIUM_BUDGET_USD` | 2 | Daily premium-model spend shared by paid endpoints. After this, a paid request that needs the premium model is 503 and is not charged. |
| `CF_DEMO_PREMIUM_BUDGET_USD` | 1 | Same cap for the free demo and free MCP. |
| `CF_PREMIUM_MAX_TOKENS` | 2000 | Each premium answer, so one escalation stays near $0.05. |
| `CF_PER_IP_PER_HOUR` | 10 | Free demo and free MCP, per IP. |
| `CF_DAILY_CAP` | 300 | Free demo and free MCP, per day. |
| `CF_MAX_TOKENS` | 16000 | Reply length cap for each model call. |
| `CF_CHEAP_REASONING` | `low` | Cheap-model thinking. `default` sends nothing. |
| `CF_CHEAP_HEDGE_MS` | 8000 | Second cheap request if the first has not answered. `0` turns it off. |

Model keys: `DOLPHIN_API_KEY`, `SERV_API_KEY`. Admin: `CF_ADMIN_TOKEN`. Store: the KV or Upstash pair above. Without the store, `/stats` stays empty and keys refuse to work.

## OpenAI-format error codes

`POST /api/v1/chat/completions` returns `{error:{message,type,code}}`.

| Case | Status | `error.type` | `error.code` |
|---|---|---|---|
| Bearer token that is not an issued `cf_` key | 401 | `invalid_request_error` | `invalid_api_key` |
| Answer cap used up | 429 | `insufficient_quota` | `insufficient_quota` |
| Per-key rate limit | 429 | `rate_limit_error` | `rate_limit_exceeded` |
| Daily key spend cap | 429 | `insufficient_quota` | `spend_cap_exceeded` |
| No key and no x402 payment | 402 | x402 challenge, unchanged | |
| Premium budget used up | 503 | `server_error` | `premium_budget` |
| Key store unavailable | 503 | `server_error` | `keys_unavailable` |
| Model call failed | 502 | `server_error` | `server_error` |
| Bad JSON or messages | 400 | `invalid_request_error` | `invalid_request_error` |

`/api/pay` and MCP use the same statuses for a key. There the `error` field is still a string, so an MCP client can show it.

## Published numbers

Take display strings from `data/public-benchmark.json` via `src/publicReport.ts`. Do not type a new rounding.

The file is `complete: true`, `expected: 300`, seed `20261120`, `ranAt` `2026-11-20T13:24:49.531Z`. GSM8K test 200 of 1,319, ARC-Challenge test 100 of 1,172. Code grades the finals. The checker did not see the answer key.

- Correct: cheap alone 288, Cheap First 288, premium 294. Shown as 96.0% and 98.0%.
- Cost: Cheap First **$0.088**, premium **$1.945**. `savingPct` **95.5**.
- Escalated 5, catches 0, missed 11, false alarms 4, one escalation still wrong.
- Latency: Cheap First mean 12.7s and median 6.1s; premium mean 2.7s and median 2.7s.

The in-house 143 (`data/results.json`, about 80% cheaper) and the hard 97 (`docs/hard-benchmark.md`) are different runs. Do not quote them as the public result.

## Known gaps

- **Streaming is one chunk.** `stream: true` is accepted. The answer is held until the check finishes, then sent as one SSE content chunk, a stop chunk, and `[DONE]`. It is not token streaming.
- **Text only.** Content parts keep `type: "text"`. Images and other parts are dropped. `temperature`, tools, and other OpenAI parameters are ignored.
- **Homepage SDK snippet for a trial key is not on the page.** Both live homepages already show an x402 OpenAI example under "Use it in your app" (`baseURL` `https://cheap-first.vercel.app/api/v1`, `apiKey` `"x402"`, `fetch` wrapped with `x402-fetch`). They do not show `apiKey: "cf_..."`. That example exists only in the Stripe success HTML in `api/key.ts`, and Stripe is off, so a developer with a trial key does not see it on the homepage or in the README.
- **PR #30 results are not published.** The check is on `main`, and `npm run public-tune` and `npm run public-compare` are in `package.json`. `data/public-tuning.json` and `data/public-compare.json` are not in the repo. Those runs have not been done. `AGENTS.md` still says PR #30 is unmerged and that the scripts are not on `main`.

## Next steps

1. With `DOLPHIN_API_KEY` and `SERV_API_KEY` exported, run `npm run public-tune` (seed `20261121`, 40 GSM8K and 20 ARC-Challenge, drawn only after every id from the reported 300 is removed) and then `npm run public-compare` (reuses cached cheap and premium answers; does not modify `data/public-benchmark.json`). Commit only `data/public-tuning.json` and `data/public-compare.json`. Quote `summary` next to `published`. Do not hand-write an accuracy figure. If the tuning grid is a poor trade, change `SCORE` in `src/checkSignals.ts` and rescore with `npm run public-compare -- --rescore`. Do not pick that number from the reported 300.
2. Add a homepage (and README) OpenAI snippet that uses a trial `cf_` key as `apiKey`, and say in the same place that streaming is one chunk and input is text only.
3. Bring the "Open work" section of `AGENTS.md` in line with `main`.
4. Leave Stripe off unless Rob asks for card payments.
5. [PR #41](https://github.com/robd-hub/cheap-first/pull/41) (Cheap First Local, on-device Gemini) is an open draft. It is not on `main`.

## Working in the repo

```bash
npm install
npm run typecheck
npm test
npm run build
```

CI (`.github/workflows/ci.yml`) is Node 22: `npm ci`, typecheck, test, build. No API keys. `npm run ask -- "question"` needs `DOLPHIN_API_KEY` and `SERV_API_KEY`.

Never commit secrets. `.env` is gitignored. Customer pilot questions stay in gitignored `pilots/`.
