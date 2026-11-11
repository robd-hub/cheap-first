/**
 * Builds the public results page (out/index.html) from data/results.json.
 * No API keys are needed: the page is plain HTML built from saved results.
 */
import fs from "node:fs";

interface Side {
  answer: string;
  score: number;
  reason: string;
  costUsd: number;
}
interface Row {
  category: string;
  id: string;
  prompt: string;
  answeredBy: "cheap" | "premium";
  cheap: Side;
  checkCostUsd: number;
  cheapFirst: Side;
  premium: Side;
}
interface Results {
  ranAt: string;
  passMark: number;
  models: Record<"cheap" | "checker" | "premium", { label: string; inputPerM: number; outputPerM: number }>;
  rows: Row[];
}

interface CheckerTest {
  checker: string;
  rows: { prompt: string; wrongAnswer: string; score: number; reason: string; caught: boolean }[];
}

const REPO = "https://github.com/robd-hub/cheap-first";
/** Where the live "try it" box sends questions. Same-origin on Vercel; set ASK_URL for other hosts. */
const ASK_URL = process.env.ASK_URL || "/api/ask";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : n >= 0.0001 ? `$${n.toFixed(4)}` : `$${n.toFixed(6)}`);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function page(r: Results | null, ct: CheckerTest | null): string {
  const rows = r?.rows ?? [];
  const n = rows.length;
  const cfCost = rows.reduce((a, x) => a + x.cheapFirst.costUsd, 0);
  const prCost = rows.reduce((a, x) => a + x.premium.costUsd, 0);
  const saved = prCost > 0 ? (1 - cfCost / prCost) * 100 : 0;
  const byCheap = rows.filter((x) => x.answeredBy === "cheap").length;
  const cfQ = avg(rows.map((x) => x.cheapFirst.score));
  const prQ = avg(rows.map((x) => x.premium.score));
  const savedOn = (xs: Row[]) => {
    const p = xs.reduce((a, x) => a + x.premium.costUsd, 0);
    return p > 0 ? (1 - xs.reduce((a, x) => a + x.cheapFirst.costUsd, 0) / p) * 100 : 0;
  };
  const stress = rows.filter((x) => x.category === "stress test");
  const everyday = rows.filter((x) => x.category !== "stress test");
  const split = stress.length && everyday.length
    ? `<div class="lbl split">${savedOn(everyday).toFixed(0)}% on ${everyday.length} everyday questions, ${savedOn(stress).toFixed(0)}% on ${stress.length} stress tests</div>`
    : "";
  const per1000 = (c: number) => (n ? (c / n) * 1000 : 0);

  const tiles = n
    ? `
    <div class="tiles">
      <div class="tile accent"><div class="big">${saved.toFixed(0)}%</div><div class="lbl">cheaper than sending everything to ${esc(r!.models.premium.label.replace("SERV · ", ""))}</div>${split}</div>
      <div class="tile"><div class="big">${byCheap}/${n}</div><div class="lbl">questions answered by Dolphin alone</div></div>
      <div class="tile"><div class="big">${cfQ.toFixed(0)} <span class="vs">vs ${prQ.toFixed(0)}</span></div><div class="lbl">average quality score, Cheap First vs premium only (0 to 100)</div></div>
      <div class="tile"><div class="big">${usd(per1000(cfCost))} <span class="vs">vs ${usd(per1000(prCost))}</span></div><div class="lbl">cost per 1,000 questions at these rates</div></div>
    </div>`
    : `<p class="empty">No benchmark results yet.</p>`;

  const table = rows
    .map((x) => {
      const badge = x.answeredBy === "cheap" ? `<span class="pill cheap">DOLPHIN</span>` : `<span class="pill prem">ESCALATED</span>`;
      return `
      <details class="row" data-cat="${esc(x.category)}" data-by="${x.answeredBy}" data-text="${esc((x.prompt + " " + x.category).toLowerCase())}">
        <summary>
          <span class="cat">${esc(x.category)}</span>
          <span class="q">${esc(x.prompt)}</span>
          ${badge}
          <span class="num">${x.cheapFirst.score}</span>
          <span class="num cost">${usd(x.cheapFirst.costUsd)}</span>
          <span class="num cost muted">${usd(x.premium.costUsd)}</span>
        </summary>
        <div class="detail">
          <div><h4>Dolphin's answer <small>check ${x.cheap.score}/100 · ${usd(x.cheap.costUsd)}</small></h4><pre>${esc(x.cheap.answer)}</pre><p class="why">${esc(x.cheap.reason)}</p></div>
          <div><h4>Premium answer <small>check ${x.premium.score}/100 · ${usd(x.premium.costUsd)}</small></h4><pre>${esc(x.premium.answer)}</pre><p class="why">${esc(x.premium.reason)}</p></div>
        </div>
      </details>`;
    })
    .join("");

  const escalated = rows.filter((x) => x.answeredBy === "premium");
  const escalations = escalated.length
    ? `
<h2>Questions that were escalated</h2>
<p class="sub">The checker scored Dolphin's answer below ${r!.passMark} on ${escalated.length === 1 ? "this question" : `these ${escalated.length} questions`}, so Cheap First paid for the premium model instead. This is the safety net at work. The checker can also be wrong, so read both answers.</p>
${escalated
  .map(
    (x) => `
<div class="esc">
  <p class="q2">${esc(x.prompt.split("\n")[0])}</p>
  <div class="detail tight">
    <div><h4>Dolphin <small>check ${x.cheap.score}/100</small></h4><pre>${esc(x.cheap.answer)}</pre><p class="why">${esc(x.cheap.reason)}</p></div>
    <div><h4>Premium, after escalation <small>check ${x.premium.score}/100</small></h4><pre>${esc(x.premium.answer)}</pre><p class="why">${esc(x.premium.reason)}</p></div>
  </div>
</div>`,
  )
  .join("")}`
    : "";

  const caught = ct ? ct.rows.filter((x) => x.caught).length : 0;
  const checkerTest = ct
    ? `
<h2>Does the checker really catch mistakes?</h2>
<p class="sub">We gave the checker ${ct.rows.length} deliberately wrong answers. It failed <b>${caught} of ${ct.rows.length}</b>, so each would have been sent on to the premium model.</p>
<div class="ct">
${ct.rows
  .map(
    (x) => `<div class="ctrow"><div class="ctq">${esc(x.prompt)}</div><div class="cta">Wrong answer: <code>${esc(x.wrongAnswer)}</code></div><div class="ctv"><span class="pill ${x.caught ? "prem" : "cheap"}">${x.caught ? "Caught" : "Missed"} · ${x.score}/100</span> ${esc(x.reason)}</div></div>`,
  )
  .join("")}
</div>`
    : "";

  const cats = [...new Set(rows.map((x) => x.category))];
  const filters = n
    ? `
<div class="filters">
  <input id="search" type="search" placeholder="Search questions" aria-label="Search questions">
  <div class="chips" role="group" aria-label="Filter">
    <button class="chip on" data-f="all">All (${n})</button>
    <button class="chip" data-f="by:cheap">Answered by Dolphin (${byCheap})</button>
    <button class="chip" data-f="by:premium">Escalated (${n - byCheap})</button>
    ${cats.map((c) => `<button class="chip cap" data-f="cat:${esc(c)}">${esc(c)}</button>`).join("")}
  </div>
  <p id="shown" class="sub"></p>
</div>`
    : "";

  const calc = n
    ? `
<div class="calc">
  <label for="volume">Questions a month <input id="volume" type="number" min="0" step="1000" value="100000"></label>
  <div class="calcout"><span>Cheap First<b id="cf"></b></span><span>Premium only<b id="pr"></b></span><span class="save">You save each month<b id="sv"></b></span></div>
  <p class="sub">Based on the average real cost per question in this benchmark (${usd(cfCost / n)} vs ${usd(prCost / n)}).</p>
</div>
<script>
(function(){var cf=${cfCost / Math.max(n, 1)},pr=${prCost / Math.max(n, 1)},v=document.getElementById("volume");
function f(x){return "$"+x.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
function u(){var q=Math.max(0,+v.value||0);document.getElementById("cf").textContent=f(q*cf);document.getElementById("pr").textContent=f(q*pr);document.getElementById("sv").textContent=f(q*(pr-cf))}
v.addEventListener("input",u);u();})();
</script>`
    : "";

  const m = r?.models;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cheap First</title>
<meta name="description" content="Answer with Dolphin's cheap model first, check with SERV Reasoning, and only pay for a frontier model when the check fails.">
<meta property="og:title" content="Cheap First: frontier quality at cheap-model prices">
<meta property="og:description" content="${n ? `${saved.toFixed(0)}% cheaper than always using a frontier model, across ${n} questions.` : "Cheap model first, frontier model only when needed."}">
<meta name="theme-color" content="#06080d">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%234fe3ff'/%3E%3Cstop offset='1' stop-color='%232ef2a4'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='8' fill='url(%23g)'/%3E%3Ctext x='16' y='22.5' font-family='Arial' font-weight='700' font-size='18' text-anchor='middle' fill='%2306080d'%3EC%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#06080d;--card:#11151f;--card2:rgba(18,22,34,.72);--text:#e8ecf6;--muted:#8b93a7;--soft:#b8bfd0;--line:rgba(140,160,210,.14);--line2:rgba(140,160,210,.28);--cyan:#4fe3ff;--green:#2ef2a4;--violet:#9b7bff;--accent:#4fe3ff;--good:#2ef2a4;--good-soft:rgba(46,242,164,.12);--warn:#ffb547;--warn-soft:rgba(255,181,71,.12);--bad:#ff4d6d;
--sans:"Space Grotesk",system-ui,-apple-system,Segoe UI,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:72px}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
.bg{position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(900px 500px at 15% -10%,rgba(79,227,255,.16),transparent 60%),radial-gradient(800px 500px at 95% 10%,rgba(46,242,164,.12),transparent 60%),linear-gradient(var(--line) 1px,transparent 1px) 0 0/48px 48px,linear-gradient(90deg,var(--line) 1px,transparent 1px) 0 0/48px 48px;-webkit-mask-image:linear-gradient(to bottom,#000 0%,rgba(0,0,0,.35) 60%,transparent 100%);mask-image:linear-gradient(to bottom,#000 0%,rgba(0,0,0,.35) 60%,transparent 100%)}
a{color:var(--cyan)}
.nav{position:sticky;top:0;z-index:10;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px max(16px,calc((100vw - 1040px)/2));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);background:rgba(6,8,13,.6);border-bottom:1px solid var(--line)}
.logo{display:flex;align-items:center;gap:10px;font-weight:600;text-decoration:none;color:var(--text)}
.logo-mark{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;font-weight:700;color:#06080d;background:linear-gradient(135deg,var(--cyan),var(--green));box-shadow:0 0 18px rgba(79,227,255,.4)}
.nav nav{display:flex;gap:20px;font-size:.9rem}.nav nav a{text-decoration:none;color:var(--muted);transition:color .2s}.nav nav a:hover{color:var(--text)}
.wrap{max-width:1040px;margin:0 auto;padding:24px 16px 64px}
section{margin:64px 0}
h1,h2,h3{letter-spacing:-.02em;line-height:1.1}
.hero{margin-top:40px}
.kicker{display:inline-flex;align-items:center;gap:8px;font:500 .78rem var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--cyan)}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(46,242,164,.6)}70%{box-shadow:0 0 0 10px rgba(46,242,164,0)}100%{box-shadow:0 0 0 0 rgba(46,242,164,0)}}
.hero h1{font-size:clamp(2.4rem,7vw,4.6rem);font-weight:700;margin:16px 0}
.grad{background:linear-gradient(90deg,var(--cyan),var(--green) 75%);-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{max-width:640px;font-size:1.1rem;color:var(--soft);margin:0 0 28px}
.ctas{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 8px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:12px;font-weight:600;text-decoration:none;font-size:.95rem}
.btn.primary{background:linear-gradient(135deg,var(--cyan),var(--green));color:#06080d}
.btn.ghost{border:1px solid var(--line2);color:var(--text);background:var(--card2)}
.mono{font-family:var(--mono)}
.flow{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.step{background:var(--card2);border:1px solid var(--line);border-radius:16px;padding:20px}
.step .n{font:500 .8rem var(--mono);color:var(--cyan)}
.step b{display:block;font-size:1.1rem;margin:10px 0 6px}.step span{color:var(--muted);font-size:.92rem}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin:36px 0 0;border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--line)}
.tile{background:var(--card);padding:18px 20px}
.tile.accent{background:linear-gradient(160deg,rgba(79,227,255,.12),rgba(46,242,164,.08)),var(--card)}
.big{font-size:2rem;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.tile.accent .big{font-size:2.6rem;line-height:1.15}
.vs{font-size:1rem;color:var(--muted);font-weight:500}
.lbl{color:var(--muted);font-size:.85rem;line-height:1.35}.split{margin-top:8px;font-size:.8rem;font-family:var(--mono);color:var(--green)}
h2{font-size:1.6rem;margin:0 0 10px}
.eyebrow{font:500 .75rem var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--cyan);margin:0 0 8px}
.sub{color:var(--muted);margin:0 0 18px;max-width:720px}
.calc{background:var(--card2);border:1px solid var(--line);border-radius:16px;padding:20px;margin-top:12px}
.calc label{color:var(--soft)}
.calc input{font:600 1rem var(--mono);width:150px;padding:8px 10px;border:1px solid var(--line2);border-radius:10px;background:var(--bg);color:var(--text)}
.calcout{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0 6px}
.calcout span{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px 14px;color:var(--muted);font-size:.85rem;display:flex;flex-direction:column}
.calcout b{color:var(--text);font:600 1.4rem var(--mono)}.save b{color:var(--green)}
.calc .sub{margin:8px 0 0;font-size:.82rem}
.head,.row summary{display:grid;grid-template-columns:110px 1fr 96px 56px 88px 88px;gap:12px;align-items:center}
.head{font:500 .7rem var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted);padding:0 16px 8px}
.head .num{text-align:right}
.row{background:var(--card2);border:1px solid var(--line);border-radius:14px;margin:0 0 8px;min-width:0;transition:border-color .2s}
.row:hover,.row[open]{border-color:var(--line2)}
.row summary{padding:14px 16px;cursor:pointer;list-style:none}.row summary::-webkit-details-marker{display:none}
.cat{font:500 .7rem var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.q{min-width:0;overflow-wrap:anywhere}.q2,.ctq,.cta,.why{overflow-wrap:anywhere}
.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}.cost{font-size:.85rem}.muted{color:var(--muted)}
.pill{font:600 .7rem var(--mono);letter-spacing:.04em;padding:4px 8px;border-radius:999px;text-align:center;border:1px solid transparent}
.pill.cheap{background:var(--good-soft);color:var(--good);border-color:rgba(46,242,164,.3)}.pill.prem{background:var(--warn-soft);color:var(--warn);border-color:rgba(255,181,71,.3)}
.detail{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:0 16px 16px}
.detail h4{margin:8px 0 6px;font-size:.9rem}.detail small{color:var(--muted);font-weight:400;font-family:var(--mono);font-size:.75rem}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;font:13px/1.5 var(--mono);max-height:320px;overflow:auto;margin:0;color:var(--soft)}
.why{color:var(--muted);font-size:.85rem;margin:8px 0 0}
.esc{background:var(--card2);border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:14px;margin:0 0 12px;padding:16px 0 4px}
.q2{margin:0 16px 6px;font-weight:600}.detail.tight{padding-top:0}
.ct{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.ctrow{background:var(--card2);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.ctq{font-weight:600;margin-bottom:6px;font-size:.95rem}.cta{font-size:.85rem;margin-bottom:8px;color:var(--soft)}.ctv{font-size:.82rem;color:var(--muted)}
code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font:12px var(--mono);word-break:break-word;color:var(--text)}
.filters{margin:0 0 14px}.filters input{font:inherit;width:100%;max-width:380px;padding:10px 14px;border:1px solid var(--line2);border-radius:12px;background:var(--card);color:var(--text);margin-bottom:12px}
.filters input:focus,.calc input:focus{outline:2px solid var(--cyan);outline-offset:1px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.chip{font:500 .8rem var(--sans);padding:6px 12px;border-radius:999px;border:1px solid var(--line2);background:var(--card);color:var(--soft);cursor:pointer;transition:all .15s}.chip:hover{color:var(--text)}.chip.cap{text-transform:capitalize}
.chip.on{background:linear-gradient(135deg,var(--cyan),var(--green));border-color:transparent;color:#06080d}
.filters .sub{margin:0;font:.78rem var(--mono)}
.models{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 14px}
.model{background:var(--card2);border:1px solid var(--line);border-radius:14px;padding:16px}
.model .role{font:500 .7rem var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--cyan)}
.model b{display:block;margin:8px 0 4px}.model span{color:var(--muted);font-size:.85rem;font-family:var(--mono)}
.notes{color:var(--muted);font-size:.9rem;padding-left:18px}.notes li{margin:4px 0}
footer{margin-top:64px;padding:24px max(16px,calc((100vw - 1040px)/2));border-top:1px solid var(--line);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;color:var(--muted);font-size:.85rem}
footer a{color:var(--soft)}
.empty{color:var(--muted)}
.ask{background:var(--card2);border:1px solid var(--line2);border-radius:16px;padding:14px}
.ask textarea{width:100%;font:16px/1.5 var(--sans);background:transparent;border:0;color:var(--text);resize:vertical;min-height:72px;outline:none}
.askbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:12px}
.examples{display:flex;flex-wrap:wrap;gap:6px}.btn{border:0;cursor:pointer;font-family:var(--sans)}.btn:disabled{opacity:.6;cursor:wait}
.answer{margin-top:12px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
.ahead{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:.8rem}
.ameta{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:10px;color:var(--muted);font-size:.85rem}.ameta b{color:var(--text);font-family:var(--mono)}
.steps{display:flex;gap:16px;flex-wrap:wrap;font:.8rem var(--mono);color:var(--muted)}.steps .on{color:var(--cyan)}.steps .on::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--cyan);margin-right:8px;animation:pulse 1.4s infinite}
.err{color:var(--warn);margin:0}.rej{margin-top:10px;color:var(--muted);font-size:.85rem}.rej summary{cursor:pointer}.rej pre{margin-top:8px}

@media (max-width:820px){.tiles{grid-template-columns:1fr 1fr}.tile.accent,.tile:last-child{grid-column:1/-1}.flow,.models,.ct,.calcout{grid-template-columns:1fr}}
@media (max-width:720px){.nav nav a:not(.gh){display:none}.head{display:none}.row summary{grid-template-columns:1fr auto;grid-template-areas:"cat pill" "q q" "num cost"}.row summary .cat{grid-area:cat}.row summary .pill{grid-area:pill}.row summary .q{grid-area:q}.row summary .num:not(.cost){grid-area:num;text-align:left}.row summary .cost:not(.muted){grid-area:cost}.row summary .muted{display:none}.detail{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="bg"></div>
<header class="nav">
  <a class="logo" href="#top"><span class="logo-mark">C</span>Cheap First</a>
  <nav><a href="#try">Try it</a><a href="#how">How it works</a><a href="#escalated">Escalations</a><a href="#results">All results</a><a class="gh" href="${REPO}">GitHub</a></nav>
</header>
<main class="wrap" id="top">
<section class="hero">
  <span class="kicker"><span class="pulse"></span>Live · SERV Hackathon 02 · Dolphin track</span>
  <h1>Frontier quality,<br><span class="grad">cheap-model prices.</span></h1>
  <p class="lede">Most questions don't need a frontier model. Cheap First answers with Dolphin's very cheap model, has SERV Reasoning check the answer, and only pays for a premium model when the check fails.</p>
  <div class="ctas"><a class="btn primary" href="#try">Try it live</a><a class="btn ghost" href="#calc">Work out your savings</a><a class="btn ghost" href="#escalated">See the safety net</a></div>
  ${tiles}
</section>
<section id="try">
  <p class="eyebrow">Try it live</p>
  <h2>Ask your own question.</h2>
  <p class="sub">It runs for real: Dolphin answers, SERV checks, and the premium model steps in only if the check fails. You'll see who answered and what it cost.</p>
  <form class="ask" id="ask">
    <textarea id="askq" maxlength="600" rows="3" placeholder="e.g. How many times does the letter r appear in strawberry?" aria-label="Your question"></textarea>
    <div class="askbar">
      <div class="examples">
        <button type="button" class="chip ex">What is 17% of 2,450?</button>
        <button type="button" class="chip ex">Explain x402 in two sentences.</button>
        <button type="button" class="chip ex">Write a haiku about cheap tokens.</button>
      </div>
      <button class="btn primary" id="askbtn" type="submit">Ask</button>
    </div>
  </form>
  <div class="answer" id="askout" hidden></div>
</section>
<script>
(function(){var URL=${JSON.stringify(ASK_URL)},f=document.getElementById("ask"),q=document.getElementById("askq"),b=document.getElementById("askbtn"),o=document.getElementById("askout");
function esc(t){return String(t).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function money(x){return x>=0.01?"$"+x.toFixed(2):x>=0.0001?"$"+x.toFixed(4):"$"+x.toFixed(6)}
[].forEach.call(document.querySelectorAll(".chip.ex"),function(c){c.addEventListener("click",function(){q.value=c.textContent;q.focus()})});
f.addEventListener("submit",function(e){e.preventDefault();var v=q.value.trim();if(!v){q.focus();return}
b.disabled=true;b.textContent="Thinking…";o.hidden=false;o.innerHTML='<div class="steps"><span class="on">Dolphin is answering</span><span>SERV is checking</span></div>';
var t=setTimeout(function(){var s=o.querySelectorAll(".steps span");if(s[1])s[1].className="on"},2500);
fetch(URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question:v})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){var j=x.j;
if(!x.ok){o.innerHTML='<p class="err">'+esc(j.error||"Something went wrong.")+'</p>';return}
var prem=j.answeredBy==="premium";
o.innerHTML='<div class="ahead"><span class="pill '+(prem?"prem":"cheap")+'">'+(prem?"ESCALATED":"DOLPHIN")+'</span><span class="mono muted">'+esc(j.model)+'</span></div>'+
'<pre>'+esc(j.answer)+'</pre>'+
'<div class="ameta"><span>'+(prem?"Dolphin's check":"Check")+' <b>'+j.check.score+'/100</b></span><span>Cost <b>'+money(j.costUsd)+'</b></span><span>Time <b>'+(j.ms/1000).toFixed(1)+'s</b></span></div>'+
'<p class="why">'+(prem?"Why Dolphin's answer was rejected: ":"")+esc(j.check.reason)+'</p>'+(prem&&j.cheapAnswer?'<details class="rej"><summary>Dolphin\\'s rejected answer</summary><pre>'+esc(j.cheapAnswer)+'</pre></details>':"")
}).catch(function(){o.innerHTML='<p class="err">Couldn\\'t reach the live demo. Please try again in a moment.</p>'}).then(function(){clearTimeout(t);b.disabled=false;b.textContent="Ask"})});})();
</script>
<section id="how">
  <p class="eyebrow">How it works</p>
  <h2>Cheap first. Premium only when it matters.</h2>
  <p class="sub">Every question takes the same three steps. Almost all of them stop at step two.</p>
  <div class="flow">
    <div class="step"><span class="n">01</span><b>Dolphin answers</b><span>DeepSeek V4.1 Flash on the Dolphin network, about $0.07 per million output tokens.</span></div>
    <div class="step"><span class="n">02</span><b>SERV checks</b><span>A small SERV Reasoning model scores the answer from 0 to 100 for correctness, instructions and anything made up.</span></div>
    <div class="step"><span class="n">03</span><b>Escalate only if needed</b><span>Below ${r?.passMark ?? 75}, the question goes to a frontier model on SERV instead.</span></div>
  </div>
</section>
<section id="calc">
  <p class="eyebrow">Savings calculator</p>
  <h2>What would you save?</h2>

${calc}
</section>
${escalations ? `<section id="escalated"><p class="eyebrow">The safety net</p>${escalations}</section>` : ""}
${checkerTest ? `<section id="checker"><p class="eyebrow">Checker test</p>${checkerTest}</section>` : ""}
<section id="results">
<p class="eyebrow">All results</p>
<h2>Every question, both ways</h2>
<p class="sub">Tap a question to see both answers and what the checker said.</p>
${filters}
<div class="head"><span>Type</span><span>Question</span><span>Answered by</span><span class="num">Quality</span><span class="num">Cheap First</span><span class="num">Premium only</span></div>
<div id="rows">${table}</div>
<p id="none" class="sub" hidden>No questions match.</p>
<script>
(function(){var f="all",q="",rows=[].slice.call(document.querySelectorAll("#rows .row")),s=document.getElementById("search");
function apply(){var n=0;rows.forEach(function(r){var ok=(f==="all"||(f.indexOf("by:")===0&&r.dataset.by===f.slice(3))||(f.indexOf("cat:")===0&&r.dataset.cat===f.slice(4)))&&(!q||r.dataset.text.indexOf(q)>=0);r.hidden=!ok;if(ok)n++});
document.getElementById("shown").textContent="Showing "+n+" of "+rows.length;document.getElementById("none").hidden=n>0}
[].forEach.call(document.querySelectorAll(".filters .chip"),function(b){b.addEventListener("click",function(){[].forEach.call(document.querySelectorAll(".filters .chip"),function(c){c.classList.remove("on")});b.classList.add("on");f=b.dataset.f;apply()})});
if(s)s.addEventListener("input",function(){q=s.value.trim().toLowerCase();apply()});apply();})();
</script>
</section>
<section id="measured">
<p class="eyebrow">Method</p>
<h2>How it was measured</h2>
${m ? `<div class="models">
  <div class="model"><span class="role">Cheap</span><b>${esc(m.cheap.label)}</b><span>$${m.cheap.inputPerM} in · $${m.cheap.outputPerM} out / M tokens</span></div>
  <div class="model"><span class="role">Checker</span><b>${esc(m.checker.label.replace(" (checker)", ""))}</b><span>$${m.checker.inputPerM} in · $${m.checker.outputPerM} out / M tokens</span></div>
  <div class="model"><span class="role">Premium</span><b>${esc(m.premium.label)}</b><span>$${m.premium.inputPerM} in · $${m.premium.outputPerM} out / M tokens</span></div>
</div>` : ""}
<ul class="notes">
  <li>Every cost comes from the token counts each API returned, nothing is estimated. The checker's cost is included in Cheap First's total.</li>
  <li>Both final answers are scored by the same checker against the same written criteria.</li>
  ${r ? `<li>Last run ${esc(r.ranAt.slice(0, 16).replace("T", " "))} UTC.</li>` : ""}
</ul>
</section>
</main>
<footer><span>Cheap First</span><span>Built for SERV Hackathon 02 · Dolphin + SERV Reasoning · <a href="${REPO}">GitHub</a></span></footer>
</body></html>
`;
}

const results = fs.existsSync("data/results.json") ? (JSON.parse(fs.readFileSync("data/results.json", "utf8")) as Results) : null;
const checkerTest = fs.existsSync("data/checker-test.json") ? (JSON.parse(fs.readFileSync("data/checker-test.json", "utf8")) as CheckerTest) : null;
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/index.html", page(results, checkerTest));
console.log(`Built out/index.html from ${results?.rows.length ?? 0} results.`);
