/**
 * A tiny visit counter for the Cheap First and Agent Report Card sites, so we
 * can see which posts and links bring people in. No cookies and no third-party
 * script. Each page sends one beacon (VISIT_SNIPPET) to /api/hit.
 *
 * Stored per UTC day in the shared Upstash store (src/store.ts):
 * - page views by site and page,
 * - where visits came from: the link tag (?ref=, ?from= or ?utm_source=) or,
 *   without one, the referring website's name,
 * - a daily visitor estimate: a HyperLogLog of a one-way hash of
 *   (day, IP, browser), so no IP or browser string is ever stored.
 * Everything expires after KEEP_DAYS. Nothing is recorded without Upstash.
 */
import { createHash } from "node:crypto";
import { redisPipeline } from "./store.js";

export const SITES = { cf: "Cheap First", arc: "Agent Report Card" } as const;
export type SiteId = keyof typeof SITES;
export const HIT_URL = "https://cheap-first.vercel.app/api/hit";
export const KEEP_DAYS = 120;
const BOT = /bot|crawl|spider|slurp|preview|fetch|headless|lighthouse|monitor|curl|wget|python|node-fetch|axios/i;

export interface Hit {
  site: SiteId;
  path: string;
  /** The link tag, or "site:<host>" for a referring website, or "direct". */
  source: string;
}

function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._\-/]/g, "")
    .slice(0, max);
}

/** Reads a beacon body into a hit, or null when it isn't one we count. */
export function parseHit(body: unknown, userAgent: string): Hit | null {
  if (!body || typeof body !== "object" || BOT.test(userAgent) || !userAgent) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.s !== "string" || !(b.s in SITES)) return null;
  const path = "/" + clean(b.p, 80).replace(/^\/+/, "").replace(/\/+$/, "");
  const tag = clean(b.r, 40);
  let source = tag ? `tag:${tag}` : "direct";
  if (!tag && typeof b.h === "string" && b.h) {
    const host = clean(b.h, 60).replace(/^www\./, "");
    // Visits from our own pages are moves around the site, not new arrivals.
    if (host && !/(^|\.)(vercel\.app|github\.io|designimp\.com)$/.test(host)) source = `site:${host}`;
    else if (host) source = "internal";
  }
  return { site: b.s as SiteId, path, source };
}

export function day(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Records one hit. Returns false when the store isn't set up or failed. */
export async function recordHit(hit: Hit, ip: string, userAgent: string, now = new Date()): Promise<boolean> {
  const d = day(now);
  const ttl = KEEP_DAYS * 86400;
  const who = createHash("sha256").update(`${d}|${ip}|${userAgent}`).digest("hex").slice(0, 16);
  const views = `visits:${d}:views`;
  const sources = `visits:${d}:sources`;
  const people = `visits:${d}:people:${hit.site}`;
  const cmds: (string | number)[][] = [
    ["HINCRBY", views, `${hit.site}|${hit.path}`, 1],
    ["EXPIRE", views, ttl],
    ["PFADD", people, who],
    ["EXPIRE", people, ttl],
  ];
  if (hit.source !== "internal") cmds.push(["HINCRBY", sources, `${hit.site}|${hit.source}`, 1], ["EXPIRE", sources, ttl]);
  return (await redisPipeline(cmds)) !== null;
}

export interface DayTotals {
  day: string;
  views: Record<string, number>;
  sources: Record<string, number>;
  people: Record<SiteId, number>;
}

function pairs(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(x)) for (let i = 0; i + 1 < x.length; i += 2) out[String(x[i])] = Number(x[i + 1]);
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) out[k] = Number(v);
  return out;
}

/** The last `days` days, newest first. Null when the store isn't set up. */
export async function readDays(days: number, now = new Date()): Promise<DayTotals[] | null> {
  const list = Array.from({ length: days }, (_, i) => day(new Date(now.getTime() - i * 86400_000)));
  const cmds = list.flatMap((d) => [
    ["HGETALL", `visits:${d}:views`],
    ["HGETALL", `visits:${d}:sources`],
    ...Object.keys(SITES).map((s) => ["PFCOUNT", `visits:${d}:people:${s}`]),
  ]);
  const res = await redisPipeline(cmds);
  if (!res) return null;
  const per = 2 + Object.keys(SITES).length;
  return list.map((d, i) => {
    const r = res.slice(i * per, (i + 1) * per);
    const people = {} as Record<SiteId, number>;
    Object.keys(SITES).forEach((s, j) => (people[s as SiteId] = Number(r[2 + j] ?? 0)));
    return { day: d, views: pairs(r[0]), sources: pairs(r[1]), people };
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function top(rows: Record<string, number>[], site: SiteId, n: number): [string, number][] {
  const sum: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (k.startsWith(site + "|")) sum[k.slice(site.length + 1)] = (sum[k.slice(site.length + 1)] ?? 0) + v;
  return Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function sourceLabel(s: string): string {
  if (s.startsWith("tag:")) return `Link tag "${s.slice(4)}"`;
  if (s.startsWith("site:")) return s.slice(5);
  return "Typed in or no referrer";
}

/** A plain page: visitors per day for each site, top pages and where visits came from. */
export function renderVisitsPage(days: DayTotals[] | null): string {
  const body = !days
    ? "<p>The shared store isn't connected, so nothing is being counted.</p>"
    : (Object.keys(SITES) as SiteId[])
        .map((site) => {
          const week = days.slice(0, 7);
          const visitors = (ds: DayTotals[]) => ds.reduce((n, d) => n + (d.people[site] ?? 0), 0);
          const views = (ds: DayTotals[]) => ds.reduce((n, d) => n + Object.entries(d.views).filter(([k]) => k.startsWith(site + "|")).reduce((m, [, v]) => m + v, 0), 0);
          const rows = (list: [string, number][], label: (s: string) => string) =>
            list.length ? list.map(([k, v]) => `<tr><td>${esc(label(k))}</td><td>${v}</td></tr>`).join("") : `<tr><td colspan="2" class="muted">None yet</td></tr>`;
          const daily = days
            .slice(0, 14)
            .map((d) => `<tr><td>${d.day}</td><td>${d.people[site] ?? 0}</td></tr>`)
            .join("");
          return `<section><h2>${SITES[site]}</h2>
<p class="big"><b>${visitors(week)}</b> visitors and <b>${views(week)}</b> landings in the last 7 days · ${visitors(days)} visitors in ${days.length} days</p>
<div class="grid">
<table><tr><th>Where visits came from (30 days)</th><th>Visits</th></tr>${rows(top(days.map((d) => d.sources), site, 12), sourceLabel)}</table>
<table><tr><th>Pages people landed on (30 days)</th><th>Visits</th></tr>${rows(top(days.map((d) => d.views), site, 12), (p) => p)}</table>
<table><tr><th>Day (UTC)</th><th>Visitors</th></tr>${daily}</table>
</div></section>`;
        })
        .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Site visits</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:24px 16px;color:#111;background:#fff}h1{margin:0 0 4px}.muted{color:#666}.big{font-size:17px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #eee}td:last-child,th:last-child{text-align:right}section{margin-top:28px}@media(prefers-color-scheme:dark){body{background:#0b0f14;color:#e6e6e6}th,td{border-color:#222}.muted{color:#999}}</style></head>
<body><h1>Site visits</h1><p class="muted">Counted without cookies. Visitors are a daily estimate from a one-way hash, so no IP address is stored. Bots are left out. Tag your links with <code>?ref=name</code> to see them here.</p>${body}</body></html>`;
}

/** The beacon each page includes. `site` is "cf" or "arc". */
export function visitSnippet(site: SiteId, hitUrl = HIT_URL): string {
  return `<script>(function(){try{var q=new URLSearchParams(location.search),r=q.get("ref")||q.get("from")||q.get("utm_source")||"",h="";try{h=document.referrer?new URL(document.referrer).hostname:""}catch(e){}var b=JSON.stringify({s:${JSON.stringify(site)},p:location.pathname,r:r,h:h===location.hostname?"":h});if(navigator.sendBeacon)navigator.sendBeacon(${JSON.stringify(hitUrl)},b);else fetch(${JSON.stringify(hitUrl)},{method:"POST",body:b,keepalive:true,mode:"no-cors"})}catch(e){}})();</script>`;
}
