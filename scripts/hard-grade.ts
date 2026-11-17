/**
 * Grades an answer to a question in data/hard-questions.json against its
 * known correct answer, with code instead of a model. That keeps the hard
 * benchmark honest: the checker that decides when to escalate is never the
 * one that decides whether the final answer was right.
 */

export type Expect =
  | { kind: "number"; value: number; tol: number }
  | { kind: "text"; accept: string[]; reject: string[] }
  | { kind: "all"; tokens: string[] }
  | { kind: "exact"; value: string }
  | { kind: "digits"; value: string }
  | { kind: "lines"; value: string[] }
  | { kind: "kk"; value: Record<string, string> }
  | { kind: "tool"; status: string | string[]; answer: number | string | string[] | null }
  | { kind: "json-map"; value: Record<string, number>; tol: number }
  | ({ kind: "rule"; rule: string } & Record<string, unknown>);

export interface Grade {
  correct: boolean;
  note: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[*`_]/g, "").replace(/\s+/g, " ").trim();

/** The text after the last `FINAL:`, or the last non-empty line if there is none. */
export function finalLine(answer: string): { value: string; found: boolean } {
  const matches = [...answer.matchAll(/FINAL:\s*(.+)/gi)];
  if (matches.length) return { value: matches[matches.length - 1][1].trim(), found: true };
  const lines = answer.split("\n").map((l) => l.trim()).filter(Boolean);
  return { value: lines[lines.length - 1] ?? "", found: false };
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

function rawJson(answer: string): unknown {
  // Lenient on a code fence here: the tool tests are about the status, not the wrapping.
  const t = answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(t);
}

const RULES: Record<string, (answer: string, e: Record<string, unknown>) => Grade> = {
  "word-count": (a, e) => {
    const n = words(a).length;
    return { correct: n === e.count, note: `${n} words` };
  },
  alphabet: (a, e) => {
    const w = words(a).map((x) => x.replace(/^[^A-Za-z]+/, "").toLowerCase());
    const ok = w.length === e.count && w.every((x, i) => x[0] === "abcdefghijklmnopqrstuvwxyz"[i]);
    return { correct: ok, note: `initials ${w.map((x) => x[0]).join("")}` };
  },
  palindrome: (a, e) => {
    const letters = a.toLowerCase().replace(/[^a-z0-9]/g, "");
    const ok = words(a).length >= Number(e.minWords) && letters.length > 0 && letters === [...letters].reverse().join("") && letters !== e.banned;
    return { correct: ok, note: `${words(a).length} words, palindrome ${letters === [...letters].reverse().join("")}` };
  },
  ladder: (a, e) => {
    const counts = a.trim().split("\n").filter((l) => l.trim()).map((l) => words(l).length);
    return { correct: counts.length === e.count && counts.every((c, i) => c === i + 1), note: `word counts ${counts.join(",")}` };
  },
  "sentence-words": (a, e) => {
    const sentences = a.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    const counts = sentences.map((s) => words(s).length);
    const ok = sentences.length === e.sentences && counts.every((c) => c === e.words);
    return { correct: ok, note: `${sentences.length} sentences with ${counts.join(", ")} words` };
  },
  "no-letter": (a, e) => {
    const n = words(a).length;
    const hits = (a.match(new RegExp(String(e.letter), "gi")) ?? []).length;
    return { correct: hits === 0 && n >= Number(e.min) && n <= Number(e.max), note: `${n} words, ${hits} letter "${e.letter}"` };
  },
  "review-json": (a) => {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(a.trim());
    } catch {
      return { correct: false, note: "not raw JSON" };
    }
    const keys = Object.keys(j).sort().join(",");
    const lower = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x === x.toLowerCase());
    const ok =
      keys === "cons,pros,sentiment,would_rebuy" &&
      j.sentiment === "mixed" &&
      lower(j.pros) &&
      (j.pros as string[]).length >= 2 &&
      lower(j.cons) &&
      j.would_rebuy === true;
    return { correct: ok, note: ok ? "valid" : `keys ${keys}, sentiment ${String(j.sentiment)}, would_rebuy ${String(j.would_rebuy)}` };
  },
  acrostic: (a, e) => {
    const lines = a.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const initials = lines.map((l) => l.replace(/^[^A-Za-z]+/, "")[0]?.toUpperCase() ?? "").join("");
    const counts = lines.map((l) => words(l).length);
    return { correct: initials === e.word && counts.every((c) => c === e.words), note: `${initials}, ${counts.join("/")} words` };
  },
  bullets: (a, e) => {
    const lines = a.trim().split("\n").filter((l) => l.trim());
    const ok =
      lines.length === e.count &&
      lines.every((l) => l.startsWith("- ") && words(l.slice(2)).length <= Number(e.maxWords)) &&
      a === a.toLowerCase();
    return { correct: ok, note: `${lines.length} lines, lowercase ${a === a.toLowerCase()}` };
  },
  "word-chain": (a, e) => {
    const w = words(a.trim());
    const ok =
      w.length === e.count && w.every((x) => /^[a-z]+$/.test(x)) && w.every((x, i) => i === 0 || x[0] === w[i - 1][w[i - 1].length - 1]);
    return { correct: ok, note: w.join(" ") };
  },
  growing: (a, e) => {
    const lens = words(a).map((x) => x.replace(/[^A-Za-z']/g, "").length);
    const ok = lens.length === e.count && lens.every((n, i) => n === i + 1);
    return { correct: ok, note: `lengths ${lens.join(",")}` };
  },
  "spanish-two": (a, e) => {
    const sentences = a.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    const lower = ` ${a.toLowerCase().replace(/[^a-záéíóúñü ]/g, " ")} `;
    const banned = new RegExp(`\\b${e.banned}\\b`, "i").test(a);
    const english = / (the|and|is|you|your|to|of) /.test(lower);
    const spanish = / (el|la|los|las|de|que|es|para|calor|cuerpo) /.test(lower);
    return { correct: sentences.length === 2 && !banned && !english && spanish, note: `${sentences.length} sentences, banned word ${banned}, english ${english}` };
  },
};

export function grade(answer: string, expect: Expect): Grade {
  if (!answer.trim()) return { correct: false, note: "blank answer" };
  switch (expect.kind) {
    case "number": {
      // Any number on the final line counts, so "18 points, total value 104" is read as 104.
      const f = finalLine(answer);
      const nums = (f.value.replace(/,(?=\d{3})/g, "").match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      return { correct: nums.some((n) => Math.abs(n - expect.value) <= expect.tol + 1e-9), note: `got ${f.value}, want ${expect.value}` };
    }
    case "text": {
      const f = norm(finalLine(answer).value);
      const ok = expect.accept.some((x) => f.includes(norm(x))) && !expect.reject.some((x) => f.includes(norm(x)));
      return { correct: ok, note: `got ${f}, want ${expect.accept[0]}` };
    }
    case "all": {
      const f = norm(finalLine(answer).value).replace(/(\d),(?=\d{3})/g, "$1").replace(/(\d)(am|pm)\b/g, "$1 $2");
      const got = new Set(
        f.split(/[\s,;()]+/).map((t) => t.replace(/^\$/, "").replace(/\.$/, "").replace(/^(\d+)(st|nd|rd|th)$/, "$1")),
      );
      return { correct: expect.tokens.every((t) => got.has(t)), note: `got ${f}, want ${expect.tokens.join(" ")}` };
    }
    case "digits": {
      // Too big for a JavaScript number, so compare the digits as text.
      const f = finalLine(answer).value.replace(/[^0-9]/g, "");
      return { correct: f === expect.value, note: `got ${f}, want ${expect.value}` };
    }
    case "exact":
      return { correct: answer.trim() === expect.value, note: `got ${answer.trim().slice(0, 80)}` };
    case "lines": {
      const got = answer.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      return { correct: got.join("|") === expect.value.join("|"), note: `got ${got.join(", ").slice(0, 120)}` };
    }
    case "kk": {
      const f = norm(finalLine(answer).value);
      const ok = Object.entries(expect.value).every(([who, type]) => new RegExp(`\\b${who.toLowerCase()}\\b[^a-z]*(is )?(a )?${type}`).test(f));
      return { correct: ok, note: `got ${f}` };
    }
    case "tool": {
      let j: { status?: string; answer?: unknown };
      try {
        j = rawJson(answer) as typeof j;
      } catch {
        return { correct: false, note: "not JSON" };
      }
      const statuses = ([] as string[]).concat(expect.status);
      if (!statuses.includes(String(j.status))) return { correct: false, note: `status ${j.status}, want ${expect.status}` };
      if (expect.answer === null) return { correct: true, note: `status ${j.status}` };
      if (typeof expect.answer === "number") {
        // Any number in the answer will do, so "250 EUR is 271.05 USD" counts.
        const nums = typeof j.answer === "number" ? [j.answer] : (String(j.answer ?? "").replace(/,(?=\d{3})/g, "").match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        const want = expect.answer;
        return { correct: nums.some((n) => Math.abs(n - want) <= 0.5), note: `answer ${JSON.stringify(j.answer)}` };
      }
      const said = JSON.stringify(j.answer ?? "").toLowerCase();
      const want = ([] as string[]).concat(expect.answer);
      return { correct: want.every((w) => said.includes(w)), note: `answer ${JSON.stringify(j.answer)}` };
    }
    case "json-map": {
      let j: Record<string, unknown>;
      try {
        j = rawJson(answer) as Record<string, unknown>;
      } catch {
        return { correct: false, note: "not JSON" };
      }
      const keys = Object.keys(expect.value);
      const ok =
        Object.keys(j).length === keys.length && keys.every((k) => typeof j[k] === "number" && Math.abs((j[k] as number) - expect.value[k]) <= expect.tol);
      return { correct: ok, note: `got ${JSON.stringify(j)}` };
    }
    case "rule":
      return RULES[expect.rule](answer, expect);
  }
}
