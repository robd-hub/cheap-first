/**
 * Aggregate counters for the public /stats page.
 *
 * Only totals are stored: how many answers came back, how many escalated,
 * how many of those were the checker rejecting a cheap answer, and the
 * dollars spent versus the premium price. The question, the answer, and
 * any API key are not accepted by these functions and are not written.
 *
 * Persistence is the shared Upstash Redis the rest of the server already
 * uses (KV_REST_API_URL / KV_REST_API_TOKEN, or the UPSTASH_REDIS_REST_*
 * pair). Without it, nothing is recorded and the page says so. Per-instance
 * memory is intentionally not used: those numbers would reset with each
 * serverless instance and would not be the deployment's traffic.
 */
import { waitUntil } from "@vercel/functions";
import { savings, type CheapFirstResult, type Models } from "./cheapFirst.js";
import { redisPipeline, sharedStoreConfigured } from "./store.js";

export const LIVE_KEY = "cf:live:v1";
export const STATS_PAGE_URL = "https://cheap-first.vercel.app/stats";
export const STATS_JSON_URL = "https://cheap-first.vercel.app/api/stats?format=json";
const NANO = 1_000_000_000;

export const LIVE_SOURCES = ["demo", "pay", "chat", "mcp", "openserv"] as const;
export type LiveSource = (typeof LIVE_SOURCES)[number];

export const SOURCE_LABELS: Record<LiveSource, string> = {
  demo: "Try it (/api/ask)",
  pay: "Paid (/api/pay)",
  chat: "OpenAI-compatible (/api/v1)",
  mcp: "MCP (ask_cheap_first)",
  openserv: "OpenServ",
};

export interface LiveObservation {
  source: LiveSource;
  answeredBy: "cheap" | "premium";
  /** Dolphin returned non-blank text. An outage or empty reply is false. */
  cheapAnswered: boolean;
  checkScore: number;
  /** The pass mark used for this request (strict, balanced, or budget). */
  passMark: number;
  costUsd: number;
  /** Premium-model price for this answer, from the same helper the API returns. */
  premiumOnlyUsd: number;
}

export interface LiveSnapshot {
  /** The Upstash env vars are set. */
  configured: boolean;
  /** A read against that store succeeded. False when it is down, or not configured. */
  reachable: boolean;
  /** ISO time of the first recorded answer. Null until then. */
  since: string | null;
  requests: number;
  escalated: number;
  /** Checker rejected a non-blank cheap answer and the premium model answered. */
  realCatches: number;
  /** Escalated because Dolphin returned nothing. */
  blankEscalations: number;
  costUsd: number;
  premiumOnlyUsd: number;
  savedUsd: number;
  sources: Record<LiveSource, number>;
}

export function emptySources(): Record<LiveSource, number> {
  return { demo: 0, pay: 0, chat: 0, mcp: 0, openserv: 0 };
}

export function emptySnapshot(configured: boolean, reachable = false): LiveSnapshot {
  return {
    configured,
    reachable,
    since: null,
    requests: 0,
    escalated: 0,
    realCatches: 0,
    blankEscalations: 0,
    costUsd: 0,
    premiumOnlyUsd: 0,
    savedUsd: 0,
    sources: emptySources(),
  };
}

export function classify(obs: LiveObservation): { escalated: boolean; realCatch: boolean; blankEscalation: boolean } {
  const escalated = obs.answeredBy === "premium";
  const realCatch = escalated && obs.cheapAnswered && obs.checkScore < obs.passMark;
  const blankEscalation = escalated && !obs.cheapAnswered;
  return { escalated, realCatch, blankEscalation };
}

/** Dollars as integer nano-dollars, so the counter does not drift. */
export function toNano(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("A live-stats amount must be a finite, non-negative number.");
  return Math.round(usd * NANO);
}

type Cmd = (string | number)[];

/** The Redis writes for one delivered answer. `sinceIso` sticks only on the first one (HSETNX). */
export function commandsFor(obs: LiveObservation, sinceIso: string): Cmd[] {
  if (!LIVE_SOURCES.includes(obs.source)) throw new Error("Unknown live-stats source.");
  const kind = classify(obs);
  const cmds: Cmd[] = [
    ["HSETNX", LIVE_KEY, "since", sinceIso],
    ["HINCRBY", LIVE_KEY, "requests", 1],
    ["HINCRBY", LIVE_KEY, "costNano", toNano(obs.costUsd)],
    ["HINCRBY", LIVE_KEY, "premiumOnlyNano", toNano(obs.premiumOnlyUsd)],
    ["HINCRBY", LIVE_KEY, `src:${obs.source}`, 1],
  ];
  if (kind.escalated) cmds.push(["HINCRBY", LIVE_KEY, "escalated", 1]);
  if (kind.realCatch) cmds.push(["HINCRBY", LIVE_KEY, "realCatches", 1]);
  if (kind.blankEscalation) cmds.push(["HINCRBY", LIVE_KEY, "blankEscalations", 1]);
  return cmds;
}

/**
 * Builds the counter update from a finished Cheap First call.
 * Returns null when the amounts are not usable, so the caller skips them
 * instead of writing a bad total. The prompt is not read.
 */
export function observationFrom(source: LiveSource, result: CheapFirstResult, models: Models, passMark: number): LiveObservation | null {
  const { premiumOnlyUsd } = savings(result, models);
  const obs: LiveObservation = {
    source,
    answeredBy: result.answeredBy,
    cheapAnswered: result.cheap.text.trim().length > 0,
    checkScore: result.check.score,
    passMark,
    costUsd: result.costUsd,
    premiumOnlyUsd,
  };
  if (!Number.isFinite(obs.checkScore) || obs.costUsd < 0 || obs.premiumOnlyUsd < 0) return null;
  if (!Number.isFinite(obs.costUsd) || !Number.isFinite(obs.premiumOnlyUsd)) return null;
  return obs;
}

/** Records one delivered answer. Never throws. Does nothing when Upstash is not configured. */
export async function recordLive(obs: LiveObservation): Promise<void> {
  if (!sharedStoreConfigured()) return;
  let cmds: Cmd[];
  try {
    cmds = commandsFor(obs, new Date().toISOString());
  } catch (e) {
    console.error(`Live stats were not recorded: ${(e as Error).message}`);
    return;
  }
  await redisPipeline(cmds);
}

/**
 * Fire-and-forget record. On Vercel, `waitUntil` keeps the instance alive
 * until the write finishes. A stats failure must not change the answer.
 */
export function noteAnswer(obs: LiveObservation | null): void {
  if (!obs) return;
  try {
    const pending = recordLive(obs).catch((e) => {
      console.error(`Live stats were not recorded: ${(e as Error).message}`);
    });
    try {
      waitUntil(pending);
    } catch {
      // Outside a Vercel request this is a no-op; the promise is already running.
    }
  } catch (e) {
    console.error(`Live stats were not recorded: ${(e as Error).message}`);
  }
}

/** Records a delivered answer. Never throws, so a stats problem cannot change the response. */
export function noteCheapFirst(source: LiveSource, result: CheapFirstResult, models: Models, passMark: number): void {
  try {
    noteAnswer(observationFrom(source, result, models, passMark));
  } catch (e) {
    console.error(`Live stats were not recorded: ${(e as Error).message}`);
  }
}

export async function readLive(): Promise<LiveSnapshot> {
  if (!sharedStoreConfigured()) return emptySnapshot(false, false);
  const rows = await redisPipeline([["HGETALL", LIVE_KEY]]);
  if (!rows) return emptySnapshot(true, false);
  return snapshotFromHash(true, rows[0]);
}

export function snapshotFromHash(configured: boolean, flat: unknown): LiveSnapshot {
  const map = new Map<string, string>();
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) map.set(String(flat[i]), String(flat[i + 1]));
  } else if (flat && typeof flat === "object") {
    for (const [key, value] of Object.entries(flat as Record<string, unknown>)) {
      if (value !== null && value !== undefined) map.set(key, String(value));
    }
  }
  const num = (key: string) => {
    const n = Number(map.get(key) ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const costUsd = num("costNano") / NANO;
  const premiumOnlyUsd = num("premiumOnlyNano") / NANO;
  const sources = emptySources();
  for (const source of LIVE_SOURCES) sources[source] = num(`src:${source}`);
  const since = map.get("since") || null;
  return {
    configured,
    reachable: true,
    since,
    requests: num("requests"),
    escalated: num("escalated"),
    realCatches: num("realCatches"),
    blankEscalations: num("blankEscalations"),
    costUsd,
    premiumOnlyUsd,
    savedUsd: premiumOnlyUsd - costUsd,
    sources,
  };
}

export interface StatsBody extends LiveSnapshot {
  savingPct: number | null;
  escalationRate: number | null;
  privacy: string;
}

export const PRIVACY = "Aggregates only. Question text, answers, and API keys are not stored.";

export function statsBody(snapshot: LiveSnapshot): StatsBody {
  return {
    ...snapshot,
    savingPct: snapshot.premiumOnlyUsd > 0 ? Math.round((1 - snapshot.costUsd / snapshot.premiumOnlyUsd) * 1000) / 10 : null,
    escalationRate: snapshot.requests > 0 ? Math.round((snapshot.escalated / snapshot.requests) * 10_000) / 10_000 : null,
    privacy: PRIVACY,
  };
}

export function renderStatsJson(snapshot: LiveSnapshot): string {
  return JSON.stringify(statsBody(snapshot), null, 2);
}

/** Browsers get the page. `format=json` forces the counters. curl's default accept gets JSON. */
export function wantsHtml(accept: string | null, format: string | null): boolean {
  if (format === "json") return false;
  if (format === "html") return true;
  return (accept ?? "").toLowerCase().includes("text/html");
}

export function sinceLabel(since: string | null): string {
  if (!since) return "—";
  const date = new Date(since);
  if (Number.isNaN(date.getTime())) return "—";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

export function formatUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v === 0) return "$0.00";
  if (v >= 0.01) return `${sign}$${v.toFixed(2)}`;
  if (v >= 0.0001) return `${sign}$${v.toFixed(4)}`;
  return `${sign}$${v.toFixed(6)}`;
}

function rateLabel(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderStatsPage(snapshot: LiveSnapshot): string {
  const since = sinceLabel(snapshot.since);
  let banner: string;
  if (!snapshot.configured) {
    banner = `<p class="banner">Live totals need the shared store. Set <code>KV_REST_API_URL</code> and <code>KV_REST_API_TOKEN</code> (or <code>UPSTASH_REDIS_REST_URL</code> and <code>UPSTASH_REDIS_REST_TOKEN</code>) on the Vercel project. That is the same free Upstash Redis prepaid keys already use. Until those are set, nothing is recorded. <b>Since —</b> because counting has not started.</p>`;
  } else if (!snapshot.reachable) {
    banner = `<p class="banner">The store is configured, and this read did not succeed. Totals are hidden so a failed read is not shown as zero traffic. Reload in a moment.</p>`;
  } else if (snapshot.requests === 0) {
    banner = `<p class="banner">The store is connected. No production answers have been recorded yet. <b>Since —</b> until the first answer; that timestamp is when counting starts, and earlier traffic was not backfilled.</p>`;
  } else {
    banner = `<p class="banner">Counted answers since the first one this store recorded. Earlier traffic was not backfilled. ${esc(PRIVACY)}</p>`;
  }

  const showNumbers = snapshot.configured && snapshot.reachable;
  const savingPct = snapshot.premiumOnlyUsd > 0 ? Math.round((1 - snapshot.costUsd / snapshot.premiumOnlyUsd) * 1000) / 10 : null;
  const savedClass = snapshot.savedUsd < 0 ? "bad" : "";
  const numbers = showNumbers
    ? `
    <div class="tiles">
      <div class="tile"><div class="big">${snapshot.requests.toLocaleString("en-US")}</div><div class="lbl">answers returned</div></div>
      <div class="tile"><div class="big">${rateLabel(snapshot.escalated, snapshot.requests)}</div><div class="lbl">${snapshot.escalated.toLocaleString("en-US")} escalated to the premium model</div></div>
      <div class="tile ${savedClass}"><div class="big">${formatUsd(snapshot.savedUsd)}</div><div class="lbl">saved against always-premium pricing${savingPct === null ? "" : ` (${savingPct}%)`}</div></div>
      <div class="tile"><div class="big">${snapshot.realCatches.toLocaleString("en-US")}</div><div class="lbl">real catches: cheap answer rejected, premium model used</div></div>
    </div>
    <div class="split">
      <p>Spent <b>${formatUsd(snapshot.costUsd)}</b> · always-premium pricing <b>${formatUsd(snapshot.premiumOnlyUsd)}</b></p>
      <p>${snapshot.blankEscalations.toLocaleString("en-US")} escalations happened because Dolphin returned nothing. Those are included in the escalation rate and are not counted as real catches.</p>
    </div>
    ${sourcesTable(snapshot)}`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cheap First live stats</title>
<meta name="description" content="Aggregate production stats for Cheap First: requests, escalations, savings, and checker catches. No question text is stored.">
<meta name="theme-color" content="#06080d">
<link rel="icon" href="/icon.png">
<style>
:root{--bg:#06080d;--card:#11151f;--text:#e8ecf6;--muted:#8b93a7;--soft:#b8bfd0;--line:rgba(140,160,210,.16);--cyan:#4fe3ff;--green:#2ef2a4;--warn:#ffb547}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 "Segoe UI",system-ui,sans-serif}
a{color:var(--cyan)}
.wrap{max-width:880px;margin:0 auto;padding:28px 16px 64px}
.nav{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:28px}
.logo{color:var(--text);text-decoration:none;font-weight:700}
h1{font-size:clamp(2rem,6vw,3.2rem);line-height:1.1;margin:8px 0}
.kicker{font:600 .75rem ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--cyan)}
.since{font-size:1.15rem;margin:8px 0 0}
.since b{font-variant-numeric:tabular-nums}
.banner{background:#161b28;border:1px solid var(--line);border-radius:14px;padding:14px 16px;color:var(--soft)}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
.big{font-size:2rem;font-weight:650;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.lbl{color:var(--muted);font-size:.9rem}
.tile.bad .big{color:var(--warn)}
.split{color:var(--muted);font-size:.92rem}
.split b{color:var(--text);font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;margin:8px 0 18px}
th,td{text-align:left;padding:8px 0;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
th{color:var(--muted);font-weight:600;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase}
code{font-family:ui-monospace,monospace;font-size:.86em}
.notes{color:var(--muted);font-size:.92rem;padding-left:18px}
.notes li{margin:6px 0}
footer{margin-top:28px;color:var(--muted);font-size:.85rem}
@media(max-width:640px){.tiles{grid-template-columns:1fr}}
</style>
</head>
<body>
<main class="wrap">
  <div class="nav"><a class="logo" href="/">Cheap First</a><a href="/api/stats?format=json">JSON</a></div>
  <p class="kicker">Production</p>
  <h1>Live stats</h1>
  <p class="since">Since <b>${esc(since)}</b></p>
  ${banner}
  ${numbers}
  <h2>What a real catch is</h2>
  <ul class="notes">
    <li>A real catch is an answer where Dolphin returned text, the checker scored it below that request's pass mark, and the premium model answered instead.</li>
    <li>That is the checker's decision. The question and both answers are not stored, so this page cannot show that the cheap answer was factually wrong.</li>
    <li>Money saved uses the same premium price the API already returns. For an answer Dolphin kept, that price is applied to the cheap call's token counts. It is not a second call to the premium model. An escalation can cost more than the premium model alone, and the saving is then negative.</li>
    <li>Failed requests, rate limits, and answers that were never delivered are not counted.</li>
  </ul>
  <footer><a href="/">Cheap First</a> · <a href="https://github.com/robd-hub/cheap-first#public-questions">Public benchmark</a> · <a href="/api/stats?format=json">JSON</a></footer>
</main>
</body>
</html>`;
}

function sourcesTable(snapshot: LiveSnapshot): string {
  const rows = LIVE_SOURCES.filter((source) => snapshot.sources[source] > 0).map(
    (source) => `<tr><td>${esc(SOURCE_LABELS[source])}</td><td>${snapshot.sources[source].toLocaleString("en-US")}</td></tr>`,
  );
  if (!rows.length) return "";
  return `<h2>Where the answers came from</h2><table><thead><tr><th>Path</th><th>Answers</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
