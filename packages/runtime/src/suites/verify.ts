export type MatchKind = "exact" | "contains" | "numeric";
export interface AnswerKey {
  answer: string;
  aliases: string[];
  match: MatchKind;
}
export interface Verdict {
  passed: boolean;
  detail?: string;
}
export interface Rational {
  n: bigint;
  d: bigint;
}

const ARTICLES = new Set(["a", "an", "the"]);
const BETWEEN_DIGITS = new Set([".", ",", "-", "/", ":"]);
// Thousands separators only in well-formed groups: 1,000 and 12,345,678 — not 0,001, 1,5 or 1,2345.
const THOUSANDS = /(?<![0-9])[1-9][0-9]{0,2}(?:,[0-9]{3})+(?![0-9])/g;
// A number token may not touch a letter or digit on either side (so "abc204", "2nd" and the "-5" in "step-5" are not numbers).
const NUMBER = /(?<![\p{L}\p{N}])(?:-?\\d?frac\{-?[0-9]+\}\{[0-9]+\}|-?[0-9]+\.[0-9]+|-?\.[0-9]+|-?[0-9]+\/[0-9]+|-?[0-9]+)(?![\p{L}\p{N}])/gu;

const prepare = (s: string) => s.normalize("NFKC").replace(/−/g, "-").replace(THOUSANDS, (m) => m.replace(/,/g, ""));
// Letters with no Unicode decomposition that a writer drops the accent from as readily as from é or ş.
const FOLD: Record<string, string> = { ı: "i", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ß: "ss", æ: "ae", œ: "oe" };
/** Diacritics off ("Kış Bahçesi" → "kis bahcesi"): decompose, drop marks, recompose (so Hangul and the like come back whole), then FOLD. Expects lowercase. */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").replace(/[ıøłđðþßæœ]/g, (c) => FOLD[c] ?? c);

/** NFKC, U+2212 → "-", lowercase, no thousands separators, diacritics dropped (fold), other non-letters/digits to spaces
 *  except . , - / : between two digits, articles dropped. Mirrors prep/polyprep/verify.py. */
export function normalizeText(s: string): string {
  const chars = [...fold(prepare(s).toLowerCase())];
  let out = "";
  chars.forEach((ch, i) => {
    if (/\p{M}/u.test(ch)) return;
    if (/[\p{L}\p{N}]/u.test(ch)) out += ch;
    else if (BETWEEN_DIGITS.has(ch) && /[0-9]/.test(chars[i - 1] ?? "") && /[0-9]/.test(chars[i + 1] ?? "")) out += ch;
    else out += " ";
  });
  return out.split(" ").filter((w) => w && !ARTICLES.has(w)).join(" ");
}

const abs = (x: bigint) => (x < 0n ? -x : x);
function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}
function rational(n: bigint, d: bigint): Rational | null {
  if (d === 0n) return null;
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

function parseToken(tok: string): Rational | null {
  let m = /^(-?)\\d?frac\{(-?[0-9]+)\}\{([0-9]+)\}$/.exec(tok);
  if (m) return rational((m[1] ? -1n : 1n) * BigInt(m[2]!), BigInt(m[3]!));
  m = /^(-?[0-9]+)\/([0-9]+)$/.exec(tok);
  if (m) return rational(BigInt(m[1]!), BigInt(m[2]!));
  m = /^(-?)([0-9]*)\.([0-9]+)$/.exec(tok);
  if (m) {
    const n = BigInt((m[2] || "0") + m[3]!);
    return rational(m[1] ? -n : n, 10n ** BigInt(m[3]!.length));
  }
  if (/^-?[0-9]+$/.test(tok)) return rational(BigInt(tok), 1n);
  return null;
}

/** The value of the one number in `s`, or null when there is none or more than one. */
export function numericValue(s: string): Rational | null {
  const tokens = prepare(s).match(NUMBER) ?? [];
  return tokens.length === 1 ? parseToken(tokens[0]!) : null;
}

/** A numeric answer key: the whole trimmed key must be one number token (so "x^2" or "2x+1" are refused). */
export function numericKey(s: string): Rational | null {
  const p = prepare(s).trim();
  const tokens = p.match(NUMBER) ?? [];
  return tokens.length === 1 && tokens[0] === p ? parseToken(tokens[0]) : null;
}

const HEDGES = ["or", "either"];
/** A claim naming alternatives ("Tolkien or Lewis") does not contain an answer, unless the answer itself has that word ("War or Peace"). */
const hedged = (claim: string, target: string) => {
  const c = claim.split(" ");
  const t = target.split(" ");
  return HEDGES.some((h) => c.includes(h) && !t.includes(h));
};

export function verifyClaim(key: AnswerKey, claim: string): Verdict {
  const shown = claim.trim().slice(0, 200);
  const fail = (detail = `expected ${key.answer}, got ${shown}`): Verdict => ({ passed: false, detail });
  const targets = [key.answer, ...key.aliases];
  if (key.match === "numeric") {
    const got = numericValue(claim);
    if (!got) return fail(`no single number in the claim: ${shown}`);
    const hit = targets.some((t) => {
      const want = numericValue(t);
      return want !== null && want.n === got.n && want.d === got.d;
    });
    return hit ? { passed: true } : fail();
  }
  const c = normalizeText(claim);
  if (!c) return fail();
  for (const t of targets.map(normalizeText).filter(Boolean)) {
    if (c === t) return { passed: true };
    if (key.match === "contains" && [...c].length <= 3 * [...t].length && ` ${c} `.includes(` ${t} `) && !hedged(c, t)) return { passed: true };
  }
  return fail();
}
