/**
 * Cheap First as an agent on the OpenServ marketplace.
 *
 * The agent's endpoint is https://<this site>/openserv (vercel.json rewrites
 * /openserv, /openserv/health and /openserv/tools/<name> here). See
 * src/openserv.ts for how OpenServ calls it and docs/openserv.md for setup.
 *
 * Marketplace users don't pay us per answer, so this has its own daily caps:
 * a number of answers per day, and a premium budget for escalations.
 */
import { waitUntil } from "@vercel/functions";
import { DailyBudget, PREMIUM_MAX_TOKENS } from "../src/budget.js";
import { cheapFirst, defaultModels, EscalationBlocked, MODES, modeFrom, savings, type Models } from "../src/cheapFirst.js";
import { handleOpenServ, type AgentSpec } from "../src/openserv.js";
import { incrBy } from "../src/store.js";

const MAX_QUESTION = 2000;
/** Answers per day (UTC) for OpenServ users together. */
const DAILY_ANSWERS = Number(process.env.CF_OPENSERV_DAILY_ANSWERS) || 300;
const premiumBudget = new DailyBudget("openserv", Number(process.env.CF_OPENSERV_PREMIUM_BUDGET_USD) || 1);
let models: Models | null = null;

const usd = (n: number) => (n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(5)}`);

export const AGENT: AgentSpec = {
  systemPrompt:
    "You are Cheap First, an agent that answers questions at a fraction of the usual cost. For any question or writing request, call the answer_cheaply tool with the user's full request and return its answer to the user, keeping the line about who answered and what it cost. Don't answer from your own knowledge.",
  capabilities: [
    {
      name: "answer_cheaply",
      description:
        "Answers a question or writing request cheaply: Dolphin's low-cost model answers first, SERV Reasoning checks the answer, and a premium model rewrites it only if the check fails. Returns the answer plus who answered, the check score and the cost saved.",
      schema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The full question or request, up to 2,000 characters" },
          mode: { type: "string", enum: ["strict", "balanced", "budget"], description: "strict escalates to the premium model more often, budget less often. Default balanced." },
        },
        required: ["question"],
      },
      async run(args) {
        const question = String(args.question ?? "").trim();
        if (!question) return "Please include a question.";
        if (question.length > MAX_QUESTION) return `Please keep the question under ${MAX_QUESTION} characters.`;
        const day = new Date().toISOString().slice(0, 10);
        if ((await incrBy(`cf:openserv:answers:${day}`, 1, 2 * 86_400)) > DAILY_ANSWERS) {
          return "Cheap First has answered its daily limit of free questions on OpenServ. Try again tomorrow, or pay per answer at https://cheap-first.vercel.app/api/pay.";
        }
        const mode = modeFrom(args.mode);
        models ??= await defaultModels();
        const m = models;
        try {
          const r = await cheapFirst(question, m, undefined, {
            premiumMaxTokens: PREMIUM_MAX_TOKENS,
            canEscalate: () => premiumBudget.hasRoom(),
            passMark: MODES[mode],
          });
          if (r.premium) await premiumBudget.add(r.premium.costUsd);
          const { premiumOnlyUsd, savedUsd } = savings(r, m);
          const who = r.answeredBy === "cheap" ? `${m.cheap.label} (the cheap model)` : `${m.premium.label} (escalated after the check scored the cheap answer ${r.check.score}/100)`;
          return `${r.answer}\n\n---\nAnswered by ${who}. Check score ${r.check.score}/100. Cost ${usd(r.costUsd)} instead of ${usd(premiumOnlyUsd)}, saving ${usd(savedUsd)}.`;
        } catch (e) {
          if (e instanceof EscalationBlocked) return "This question needs the premium model, which has hit today's limit on OpenServ. Please try again tomorrow.";
          throw e;
        }
      },
    },
  ],
};

async function handle(request: Request): Promise<Response> {
  const sub = new URL(request.url).searchParams.get("path") ?? "";
  return handleOpenServ(request, sub, AGENT, waitUntil);
}

export const GET = handle;
export const POST = handle;
