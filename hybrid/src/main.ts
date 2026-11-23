import "./style.css";
import { gradeArc, gradeGsm8kNumber } from "../../src/publicGrade.js";
import {
  configured,
  defaultMode,
  deviceStatus,
  getModels,
  initializeDeviceModel,
  loadRemoteConfig,
  recordOutcome,
  watchTotals,
  type DeviceStatus,
} from "./firebase";
import { askCheapFirst, type Mode, type Outcome } from "./router";
import questions from "./questions.json";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const session = { asked: 0, local: 0, cloud: 0, saved: 0 };
let status: DeviceStatus = "no-api";
let deviceReady = false;

// ---------- Device status ----------

const STATUS_TEXT: Record<DeviceStatus, string> = {
  available: "Gemini Nano ready on this device",
  downloadable: "Gemini Nano can be downloaded",
  downloading: "Gemini Nano is downloading",
  unavailable: "No on-device model here: answers come from the cloud",
  "no-api": "This browser has no on-device AI: answers come from the cloud",
};

async function refreshStatus() {
  status = await deviceStatus();
  const pill = $("device");
  pill.textContent = STATUS_TEXT[status];
  pill.dataset.state = status === "available" ? "ok" : status === "downloadable" || status === "downloading" ? "wait" : "off";
  $("enable").hidden = deviceReady || !(status === "downloadable" || status === "downloading" || status === "available");
  if (status === "available") $("enable").textContent = "Turn on on-device AI";
}

async function enableDevice() {
  const box = $("download");
  const bar = box.querySelector("span") as HTMLElement;
  const label = box.querySelector("small") as HTMLElement;
  box.hidden = status === "available";
  label.textContent = "Starting…";
  try {
    await initializeDeviceModel((fraction) => {
      box.hidden = false;
      bar.style.width = `${Math.round(fraction * 100)}%`;
      label.textContent = `Downloading Gemini Nano: ${Math.round(fraction * 100)}%`;
    });
    deviceReady = true;
    box.hidden = true;
  } catch (error) {
    label.textContent = `Could not start the on-device model: ${error instanceof Error ? error.message : error}`;
  }
  await refreshStatus();
}

// ---------- Asking ----------

function currentMode(): Mode {
  const picked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return (picked?.value as Mode) ?? "balanced";
}

async function ensureDevice() {
  // initializeDeviceModel must follow a click. Asking is a click too.
  if (!deviceReady && status !== "no-api" && status !== "unavailable") await enableDevice();
}

function count(outcome: Outcome) {
  session.asked++;
  if (outcome.answeredBy === "device") {
    session.local++;
    session.saved++;
  }
  session.cloud += outcome.cloudCalls;
  $("s-asked").textContent = String(session.asked);
  $("s-local").textContent = String(session.local);
  $("s-cloud").textContent = String(session.cloud);
  $("s-saved").textContent = String(session.saved);
  void recordOutcome(outcome);
}

const VERDICT: Record<Outcome["answeredBy"], { title: string; cls: string }> = {
  device: { title: "Answered on your device · free · private", cls: "ok" },
  "cloud-escalated": { title: "Checked, then sent to a stronger cloud model", cls: "up" },
  "cloud-no-device": { title: "Answered in the cloud (no on-device model here)", cls: "off" },
};

function renderOutcome(o: Outcome): string {
  const v = VERDICT[o.answeredBy];
  const check = o.check
    ? `<p class="check"><b>Check ${o.check.score}/100</b> (pass mark ${o.passMark}, ${o.mode}): ${esc(o.check.reason)}</p>`
    : "";
  const replaced = o.deviceAnswer
    ? `<details><summary>The on-device answer it replaced</summary><div class="answer muted-answer">${esc(o.deviceAnswer)}</div></details>`
    : "";
  const steps = o.steps
    .map((s) => `<li><span class="where ${s.where === "ON_DEVICE" ? "dev" : "cld"}">${s.where === "ON_DEVICE" ? "device" : "cloud"}</span>${esc(s.what)} <small>${(s.ms / 1000).toFixed(1)}s</small></li>`)
    .join("");
  return `
    <div class="verdict ${v.cls}">${v.title}</div>
    <div class="answer">${esc(o.answer)}</div>
    ${check}
    ${replaced}
    <ol class="steps">${steps}</ol>
    <p class="muted">${o.deviceCalls} on-device call${o.deviceCalls === 1 ? "" : "s"}, ${o.cloudCalls} cloud call${o.cloudCalls === 1 ? "" : "s"}, ${(o.ms / 1000).toFixed(1)}s in all.</p>`;
}

async function onAsk(event: Event) {
  event.preventDefault();
  const question = ($("q") as HTMLTextAreaElement).value.trim();
  if (!question) return;
  const go = $("go") as HTMLButtonElement;
  const out = $("result");
  go.disabled = true;
  out.hidden = false;
  out.innerHTML = `<p class="muted">Thinking on this device…</p>`;
  try {
    await ensureDevice();
    const outcome = await askCheapFirst(question, getModels(), { mode: currentMode() });
    out.innerHTML = renderOutcome(outcome);
    count(outcome);
  } catch (error) {
    out.innerHTML = `<p class="error">Something went wrong: ${esc(error instanceof Error ? error.message : String(error))}</p>`;
  } finally {
    go.disabled = false;
  }
}

// ---------- Benchmark ----------

type Q = { id: string; dataset: string; prompt: string; gold: string; labels?: string[] };
const SETS = questions.sets as Record<string, { title: string; note: string; questions: Q[] }>;

function grade(q: Q, answer: string) {
  return q.dataset === "gsm8k" ? gradeGsm8kNumber(answer, q.gold) : gradeArc(answer, q.gold, q.labels ?? ["A", "B", "C", "D"]);
}

async function runBench() {
  const set = SETS[($("set") as HTMLSelectElement).value];
  const run = $("run") as HTMLButtonElement;
  const body = $("bench-table").querySelector("tbody")!;
  const summary = $("bench-summary");
  run.disabled = true;
  body.innerHTML = "";
  $("bench-table").hidden = false;
  summary.hidden = false;
  const tally = { done: 0, right: 0, local: 0, localRight: 0, escalated: 0, escalatedRight: 0, noDevice: 0, cloudCalls: 0 };
  const mode = currentMode();
  try {
    await ensureDevice();
    for (const [i, q] of set.questions.entries()) {
      summary.textContent = `Question ${i + 1} of ${set.questions.length}…`;
      let outcome: Outcome;
      try {
        outcome = await askCheapFirst(q.prompt, getModels(), { mode });
      } catch (error) {
        body.insertAdjacentHTML("beforeend", `<tr><td>${i + 1}</td><td>${esc(q.prompt.split("\n")[0].slice(0, 90))}</td><td colspan="3" class="error">${esc(String(error))}</td></tr>`);
        continue;
      }
      count(outcome);
      const g = grade(q, outcome.answer);
      tally.done++;
      tally.cloudCalls += outcome.cloudCalls;
      if (g.correct) tally.right++;
      if (outcome.answeredBy === "device") {
        tally.local++;
        if (g.correct) tally.localRight++;
      } else if (outcome.answeredBy === "cloud-escalated") {
        tally.escalated++;
        if (g.correct) tally.escalatedRight++;
      } else tally.noDevice++;
      const where = outcome.answeredBy === "device" ? "device" : outcome.answeredBy === "cloud-escalated" ? "cloud (escalated)" : "cloud (no device)";
      body.insertAdjacentHTML(
        "beforeend",
        `<tr><td>${i + 1}</td><td title="${esc(q.prompt)}">${esc(q.prompt.split("\n")[0].slice(0, 90))}</td><td>${where}</td><td>${outcome.check ? outcome.check.score : "–"}</td><td class="${g.correct ? "yes" : "no"}">${g.correct ? "✓" : "✗"} <small>${esc(g.note)}</small></td></tr>`,
      );
    }
    summary.innerHTML =
      `<b>${tally.right} of ${tally.done} right</b> (${mode}). ` +
      `${tally.local} answered on this device (${tally.localRight} right), ` +
      `${tally.escalated} sent to the cloud by the check (${tally.escalatedRight} right)` +
      (tally.noDevice ? `, ${tally.noDevice} in the cloud because this device has no model` : "") +
      `. ${tally.cloudCalls} cloud calls in all.`;
  } finally {
    run.disabled = false;
  }
}

// ---------- Start ----------

async function start() {
  if (!configured) {
    $("device").textContent = "Firebase isn't configured yet (see README)";
    $("device").dataset.state = "off";
    ($("go") as HTMLButtonElement).disabled = true;
    ($("run") as HTMLButtonElement).disabled = true;
  }
  const select = $("set") as HTMLSelectElement;
  for (const [key, set] of Object.entries(SETS)) select.add(new Option(set.title, key));
  const note = () => ($("set-note").textContent = SETS[select.value].note);
  select.addEventListener("change", note);
  note();

  $("enable").addEventListener("click", enableDevice);
  $("ask").addEventListener("submit", onAsk);
  $("run").addEventListener("click", runBench);
  if (!configured) return;
  await refreshStatus();

  await loadRemoteConfig();
  const mode = defaultMode();
  const radio = document.querySelector<HTMLInputElement>(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;

  watchTotals((t) => {
    if (!t.questions) return;
    const el = $("community");
    el.hidden = false;
    el.textContent = `Everyone so far: ${t.questions} questions, ${t.onDevice} answered on device, ${t.escalated} escalated by the check, ${t.noDevice} on devices without a model.`;
  });
}

void start();
