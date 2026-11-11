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
  const per1000 = (c: number) => (n ? (c / n) * 1000 : 0);

  const tiles = n
    ? `
    <div class="tiles">
      <div class="tile accent"><div class="big">${saved.toFixed(0)}%</div><div class="lbl">cheaper than sending everything to ${esc(r!.models.premium.label.replace("SERV · ", ""))}</div></div>
      <div class="tile"><div class="big">${byCheap}/${n}</div><div class="lbl">questions answered by Dolphin alone</div></div>
      <div class="tile"><div class="big">${cfQ.toFixed(0)} <span class="vs">vs ${prQ.toFixed(0)}</span></div><div class="lbl">average quality score, Cheap First vs premium only (0 to 100)</div></div>
      <div class="tile"><div class="big">${usd(per1000(cfCost))} <span class="vs">vs ${usd(per1000(prCost))}</span></div><div class="lbl">cost per 1,000 questions at these rates</div></div>
    </div>`
    : `<p class="empty">No benchmark results yet.</p>`;

  const table = rows
    .map((x) => {
      const badge = x.answeredBy === "cheap" ? `<span class="pill cheap">Dolphin</span>` : `<span class="pill prem">Escalated</span>`;
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
  <label for="volume"><b>Your traffic:</b> <input id="volume" type="number" min="0" step="1000" value="100000"> questions a month</label>
  <div class="calcout"><span>Cheap First <b id="cf"></b></span><span>Premium only <b id="pr"></b></span><span class="save">You save <b id="sv"></b> a month</span></div>
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
<style>
:root{--bg:#f7f8fb;--card:#fff;--text:#14161c;--muted:#5d6475;--line:#e3e6ee;--accent:#3d5afe;--accent-soft:#e8ecff;--good:#0f8a5f;--good-soft:#e2f5ec;--warn:#a15c00;--warn-soft:#fdf0dc}
@media (prefers-color-scheme:dark){:root{--bg:#0e1015;--card:#171a22;--text:#e8eaf0;--muted:#9aa1b2;--line:#2a2f3b;--accent:#7b8cff;--accent-soft:#1f2547;--good:#3fd09a;--good-soft:#123326;--warn:#f0b35a;--warn-soft:#3a2a12}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:clamp(32px,6vw,52px);margin:0 0 8px;letter-spacing:-.02em}
.lede{font-size:19px;color:var(--muted);max-width:720px;margin:0 0 28px}
.flow{display:flex;gap:10px;flex-wrap:wrap;align-items:stretch;margin:0 0 32px}
.step{flex:1 1 200px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.step b{display:block;margin-bottom:4px}.step span{color:var(--muted);font-size:14px}
.arrow{align-self:center;color:var(--muted);font-size:22px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:0 0 36px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.tile.accent{background:var(--accent-soft);border-color:transparent}
.big{font-size:34px;font-weight:700;letter-spacing:-.02em}.vs{font-size:18px;color:var(--muted);font-weight:500}
.lbl{color:var(--muted);font-size:14px}
h2{font-size:22px;margin:36px 0 12px}
.head,.row summary{display:grid;grid-template-columns:96px 1fr 96px 52px 84px 84px;gap:10px;align-items:center}
.head{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding:0 14px 6px}
.head .num{text-align:right}
.row{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 8px}
.row summary{padding:12px 14px;cursor:pointer;list-style:none}.row summary::-webkit-details-marker{display:none}
.cat{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.q{min-width:0}.num{text-align:right;font-variant-numeric:tabular-nums}.cost{font-size:14px}.muted{color:var(--muted)}
.pill{font-size:12px;padding:3px 8px;border-radius:999px;text-align:center;font-weight:600}
.pill.cheap{background:var(--good-soft);color:var(--good)}.pill.prem{background:var(--warn-soft);color:var(--warn)}
.detail{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:0 14px 14px}
.detail h4{margin:8px 0 6px;font-size:14px}.detail small{color:var(--muted);font-weight:400}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:13px;max-height:320px;overflow:auto;margin:0}
.why{color:var(--muted);font-size:13px;margin:6px 0 0}
.models{color:var(--muted);font-size:14px}.models li{margin:4px 0}
a{color:var(--accent)}footer{margin-top:40px;color:var(--muted);font-size:14px}
.empty{color:var(--muted)}
.sub{color:var(--muted);margin:-4px 0 14px}
.calc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:-12px 0 8px}
.calc input{font:inherit;width:130px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
.calcout{display:flex;flex-wrap:wrap;gap:8px 24px;margin:12px 0 4px;font-size:17px}.calcout b{font-variant-numeric:tabular-nums}.save b{color:var(--good)}
.calc .sub{margin:6px 0 0;font-size:13px}
.esc{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:12px;margin:0 0 12px;padding:12px 0 2px}
.q2{margin:0 14px 4px;font-weight:600}.detail.tight{padding-top:0}
.ct{display:grid;gap:8px}.ctrow{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.ctq{font-weight:600;margin-bottom:4px}.cta{font-size:14px;margin-bottom:6px}.ctv{font-size:13px;color:var(--muted)}
code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 5px;font-size:13px;word-break:break-word}
.filters{margin:0 0 12px}.filters input{font:inherit;width:100%;max-width:360px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);margin-bottom:10px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chip{font:inherit;font-size:13px;padding:5px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}.chip.cap{text-transform:capitalize}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.filters .sub{margin:0;font-size:13px}
@media (max-width:720px){.head{display:none}.row summary{grid-template-columns:1fr auto;grid-template-areas:"cat pill" "q q" "num cost"}.row summary .cat{grid-area:cat}.row summary .pill{grid-area:pill}.row summary .q{grid-area:q}.row summary .num:not(.cost){grid-area:num;text-align:left}.row summary .cost:not(.muted){grid-area:cost}.row summary .muted{display:none}.detail{grid-template-columns:1fr}.arrow{display:none}}
</style>
</head>
<body><div class="wrap">
<h1>Cheap First</h1>
<p class="lede">Most questions don't need a frontier model. Cheap First answers with Dolphin's very cheap model, has SERV Reasoning check the answer, and only pays for a premium model when the check fails.</p>
<div class="flow">
  <div class="step"><b>1. Dolphin answers</b><span>DeepSeek V4.1 Flash on the Dolphin network, about $0.07 per million output tokens.</span></div>
  <div class="arrow">→</div>
  <div class="step"><b>2. SERV checks</b><span>A small SERV Reasoning model scores the answer from 0 to 100.</span></div>
  <div class="arrow">→</div>
  <div class="step"><b>3. Escalate only if needed</b><span>Below ${r?.passMark ?? 75}, the question goes to a frontier model on SERV instead.</span></div>
</div>
${tiles}
${calc}
${escalations}
${checkerTest}
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
[].forEach.call(document.querySelectorAll(".chip"),function(b){b.addEventListener("click",function(){[].forEach.call(document.querySelectorAll(".chip"),function(c){c.classList.remove("on")});b.classList.add("on");f=b.dataset.f;apply()})});
if(s)s.addEventListener("input",function(){q=s.value.trim().toLowerCase();apply()});apply();})();
</script>
<h2>How it was measured</h2>
<ul class="models">
  ${m ? `<li><b>Cheap:</b> ${esc(m.cheap.label)}, $${m.cheap.inputPerM} in / $${m.cheap.outputPerM} out per million tokens.</li>
  <li><b>Checker:</b> ${esc(m.checker.label)}, $${m.checker.inputPerM} / $${m.checker.outputPerM}. Its cost is included in Cheap First's total.</li>
  <li><b>Premium:</b> ${esc(m.premium.label)}, $${m.premium.inputPerM} / $${m.premium.outputPerM}.</li>` : ""}
  <li>Every cost comes from the token counts each API returned. Both final answers are scored by the same checker against the same criteria.</li>
  ${r ? `<li>Last run ${esc(r.ranAt.slice(0, 16).replace("T", " "))} UTC.</li>` : ""}
</ul>
<footer>Built for SERV Hackathon 02 (Dolphin track). Code: <a href="${REPO}">${REPO.replace("https://", "")}</a></footer>
</div></body></html>
`;
}

const results = fs.existsSync("data/results.json") ? (JSON.parse(fs.readFileSync("data/results.json", "utf8")) as Results) : null;
const checkerTest = fs.existsSync("data/checker-test.json") ? (JSON.parse(fs.readFileSync("data/checker-test.json", "utf8")) as CheckerTest) : null;
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/index.html", page(results, checkerTest));
console.log(`Built out/index.html from ${results?.rows.length ?? 0} results.`);
