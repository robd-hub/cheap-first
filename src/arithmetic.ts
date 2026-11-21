/**
 * Safe arithmetic for the cheap answer's own equations.
 *
 * The model writes things like `282 × 4 = 1128` and then answers 18.8.
 * This file evaluates only numbers and + - * / ( ), so a bad equation can
 * force an escalation without sending the text to another model, and without
 * `eval` or any other way to run code.
 */

const MAX_EXPRESSION = 200;
const MAX_DIGITS = 12;

export function numbersAgree(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-3 * scale;
}

/** Turns the latex and currency the cheap model actually writes into plain operators. */
export function normalizeMath(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "(($1)/($2))");
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/\\times/g, "*")
    .replace(/\\cdot/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\\%/g, "%")
    .replace(/[×✕⋅]/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/\\\$/g, "")
    .replace(/\$/g, "")
    .replace(/\\[()[\]]/g, "")
    .replace(/[{}]/g, "");
}

type Tok = { t: "n"; v: number } | { t: "op"; v: "+" | "-" | "*" | "/" } | { t: "(" } | { t: ")" };

function tokenize(expression: string): Tok[] | null {
  // "10. 2 + 2" must not become "10.2+2" by deleting the space.
  if (/\d\s+\.|\.\s+\d|\d\s+\d/.test(expression)) return null;
  const s = expression.replace(/\s+/g, "");
  if (!s || s.length > MAX_EXPRESSION) return null;
  if (/[^0-9.+\-*/()]/.test(s)) return null;
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "(") {
      toks.push({ t: "(" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: ")" });
      i++;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/") {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    const m = s.slice(i).match(/^\d+(?:\.\d+)?/);
    if (!m) return null;
    const digits = m[0].replace(".", "");
    if (digits.length > MAX_DIGITS) return null;
    const v = Number(m[0]);
    if (!Number.isFinite(v)) return null;
    toks.push({ t: "n", v });
    i += m[0].length;
  }
  return toks.length ? toks : null;
}

/** Evaluates one expression. Returns null when it is not safe arithmetic. */
export function safeEval(expression: string): number | null {
  const tokens = tokenize(stripThousands(expression));
  if (!tokens) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const parseExpr = (): number | null => {
    let value = parseTerm();
    if (value === null) return null;
    while (peek()?.t === "op" && (peek() as { v: string }).v !== "*" && (peek() as { v: string }).v !== "/") {
      const op = (tokens[pos++] as { v: "+" | "-" }).v;
      const right = parseTerm();
      if (right === null) return null;
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const parseTerm = (): number | null => {
    let value = parseFactor();
    if (value === null) return null;
    while (peek()?.t === "op" && ((peek() as { v: string }).v === "*" || (peek() as { v: string }).v === "/")) {
      const op = (tokens[pos++] as { v: "*" | "/" }).v;
      const right = parseFactor();
      if (right === null) return null;
      if (op === "/" && right === 0) return null;
      value = op === "*" ? value * right : value / right;
    }
    return value;
  };
  const parseFactor = (): number | null => {
    const tok = peek();
    if (!tok) return null;
    if (tok.t === "op" && (tok.v === "+" || tok.v === "-")) {
      pos++;
      const inner = parseFactor();
      if (inner === null) return null;
      return tok.v === "-" ? -inner : inner;
    }
    let value: number | null;
    if (tok.t === "n") {
      pos++;
      value = tok.v;
    } else if (tok.t === "(") {
      pos++;
      value = parseExpr();
      if (value === null || peek()?.t !== ")") return null;
      pos++;
    } else {
      return null;
    }
    // `2(5)` and `(2)(3)` are multiplication. No other implicit joins.
    while (peek()?.t === "(" || peek()?.t === "n") {
      const rest = parseFactor();
      if (rest === null) return null;
      value *= rest;
    }
    return value;
  };
  const value = parseExpr();
  if (value === null || pos !== tokens.length || !Number.isFinite(value)) return null;
  return value;
}

function stripThousands(expression: string): string {
  return expression.replace(/(\d),(?=\d{3}(?:\D|$))/g, "$1");
}

export interface ParsedEquation {
  raw: string;
  lhs: number;
  rhs: number;
  /** The left side evaluates to the number written on the right. */
  consistent: boolean;
}

/**
 * Equations in an answer. A side we cannot parse is skipped, not failed:
 * prose like `40% of 200 GB = 80` is not a claim this checker can test.
 */
/** A side of an equation, including a trailing percent (`40%`). Stops at the next `=`. */
function readSide(norm: string, start: number): string {
  let k = start;
  while (k < norm.length && norm[k] !== "=" && norm[k] !== "\n" && norm[k] !== "\r" && /[0-9.+\-*/(),\s%]/.test(norm[k])) k++;
  return norm.slice(start, k).trim().replace(/^[+\-*/]+(?=\s|$)|[+\-*/]+$/g, "").trim();
}

function sideValue(raw: string): { value: number; percent: boolean } | null {
  const trimmed = raw.trim().replace(/[.,;:]+$/g, "").trim();
  const percent = /%$/.test(trimmed);
  const body = (percent ? trimmed.slice(0, -1) : trimmed).trim();
  // A percent in the middle (`20% * 20`) is not a plain expression. Skip it.
  if (!body || /%/.test(body)) return null;
  const value = safeEval(body);
  if (value === null) return null;
  return { value, percent };
}

function equationAgrees(lhs: { value: number; percent: boolean }, rhs: { value: number; percent: boolean }): boolean {
  if (numbersAgree(lhs.value, rhs.value)) return true;
  // `1/4 = 25%` and `40/100 = 40%` are the same claim written two ways.
  if (rhs.percent && (numbersAgree(lhs.value * 100, rhs.value) || numbersAgree(lhs.value, rhs.value / 100))) return true;
  if (lhs.percent && (numbersAgree(rhs.value * 100, lhs.value) || numbersAgree(rhs.value, lhs.value / 100))) return true;
  return false;
}

export function equationsIn(text: string): ParsedEquation[] {
  const norm = normalizeMath(text);
  const found: ParsedEquation[] = [];
  for (let i = 0; i < norm.length; i++) {
    if (norm[i] !== "=") continue;
    const rhsRaw = readSide(norm, i + 1);
    let j = i - 1;
    while (j >= 0 && /\s/.test(norm[j])) j--;
    const end = j + 1;
    while (j >= 0 && norm[j] !== "=" && norm[j] !== "\n" && norm[j] !== "\r" && /[0-9.+\-*/(),\s%]/.test(norm[j])) j--;
    let lhsRaw = norm.slice(j + 1, end).trim();
    // Stopped on a letter or a backslash: this is the tail of a word or a latex command
    // (`\frac13(15)`, `x + 5`), not a complete equation.
    const stopper = j >= 0 ? norm[j] : "";
    if (/[A-Za-z\\]/.test(stopper)) continue;
    // A leading + or * is the same kind of fragment.
    if (/^[+*/]/.test(lhsRaw)) continue;
    if (!lhsRaw || lhsRaw.length > MAX_EXPRESSION || !/[+\-*/()]/.test(lhsRaw)) continue;
    const lhs = sideValue(lhsRaw);
    const rhs = sideValue(rhsRaw);
    if (!lhs || !rhs) continue;
    found.push({
      raw: `${lhsRaw} = ${rhsRaw}`,
      lhs: lhs.value,
      rhs: rhs.value,
      consistent: equationAgrees(lhs, rhs),
    });
  }
  return found;
}

export interface ArithmeticReport {
  /** An equation whose left side does not equal the number on its right. */
  broken: ParsedEquation[];
  /** The last equation that did evaluate, when there is one. */
  last: ParsedEquation | null;
  /**
   * That last equation is a different number from the answer the model stated.
   * Intermediate equations are allowed to differ; only the last one is the total.
   */
  finalMismatch: boolean;
}

export function auditArithmetic(answer: string, finalNumber: string | null): ArithmeticReport {
  const equations = equationsIn(answer);
  const broken = equations.filter((eq) => !eq.consistent);
  const last = equations.length ? equations[equations.length - 1] : null;
  const stated = finalNumber === null ? null : Number(finalNumber);
  const finalMismatch = Boolean(
    last && last.consistent && stated !== null && Number.isFinite(stated) && !numbersAgree(last.lhs, stated),
  );
  return { broken, last, finalMismatch };
}
