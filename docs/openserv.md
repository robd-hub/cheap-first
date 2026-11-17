# Listing on OpenServ, ERC-8004 and x402 directories

## 1. OpenServ marketplace agent

Cheap First answers as an OpenServ agent at `https://cheap-first.vercel.app/api/openserv`
(`api/openserv.ts`, protocol in `src/openserv.ts`). Use that address, not
`/openserv`: OpenServ adds a trailing slash, and `/openserv/` isn't rewritten.
Every task and chat message is answered by Cheap First itself (the usual
answer, plus who answered, the check score and what it saved) and handed back
to OpenServ, rather than left to OpenServ's runtime model, which sometimes
answered on its own without calling the `answer_cheaply` tool.

Marketplace users don't pay us per answer, so it has its own daily caps:

- `CF_OPENSERV_DAILY_ANSWERS` answers per day for all OpenServ users together (default 300)
- `CF_OPENSERV_PREMIUM_BUDGET_USD` for premium escalations per day (default $1)

Vercel settings (Production):

- `OPENSERV_API_KEY`: the agent's secret key (platform.openserv.ai > Developer > Your Agents > Cheap First > Create Secret Key). Needed so the agent can hand tasks back to OpenServ's runtime.
- `OPENSERV_AUTH_TOKEN` (optional): when set, only requests from OpenServ are served.

The agent (4963) and its workspace (14087) were created by the setup script in
the Agent Report Card repository (`npm run openserv -- provision cf`, see its
OPENSERV.md). The workspace has a paid x402 trigger, "Cheap First answer"
($0.01); OpenServ sends those payments to the workspace's own wallet
(`0x9e32d42683Db069cA8F1f033C11af1cfB679367F`), not to `PAY_TO_ADDRESS`.

## 2. ERC-8004 identity

Handled together with Agent Report Card: the card is
`https://robd-hub.github.io/agent-report-card/erc8004/cheap-first.json` and the
signing page is
`https://robd-hub.github.io/agent-report-card/erc8004/register.html`.

## 3. x402 directories

`/api/pay` and `/api/v1/chat/completions` answer a request without payment
(or prepaid key) with a 402 before checking the body, in both x402 versions:
a version 1 JSON body, plus a version 2 `PAYMENT-REQUIRED` header carrying the
"bazaar" discovery extension (the request body as a JSON Schema plus an
example). Payment is accepted in `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2),
and the receipt comes back in `X-PAYMENT-RESPONSE` or `PAYMENT-RESPONSE` to
match. `/.well-known/x402` lists all four paid endpoints, and `/api/verify`
and `/api/verify/quick` behave the same way.

- **x402scan** (x402scan.com): lists only v2 endpoints, and now finds them
  through `/openapi.json` (an OpenAPI document with each price in
  `x-payment-info`), not `/.well-known/x402`. Add `cheap-first.vercel.app`.
- **PayAI's catalogue**: built from the bazaar extension when a payment
  settles through PayAI (the default facilitator), so the endpoints appear
  after the first paid answer.
- **Agentic.market (Coinbase)**: reads Coinbase's Bazaar, which lists an
  endpoint when a payment carrying the bazaar extension settles through
  Coinbase's facilitator. There is no form. To switch to it:
  1. Make a free API key at portal.cdp.coinbase.com (Secret API key, the
     default Ed25519 type is fine).
  2. In Vercel (cheap-first, Production) add `CDP_API_KEY_ID` and
     `CDP_API_KEY_SECRET`, then redeploy. Payments now verify and settle
     through `https://api.cdp.coinbase.com/platform/v2/x402`; without the two
     keys everything stays on PayAI.
  3. Make one paid call to each endpoint (about $0.035 for all four). The
     listing shows within about 30 minutes; check at agentic.market or
     `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`.
