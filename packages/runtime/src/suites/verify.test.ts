import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeText, numericKey, numericValue, verifyClaim, type MatchKind } from "./verify.ts";

interface Vectors {
  cases: { match: MatchKind; answer: string; aliases: string[]; claim: string; passed: boolean }[];
  normalize: { in: string; out: string }[];
}
const vectors = JSON.parse(readFileSync(new URL("../../../../suites/verify-vectors.json", import.meta.url), "utf8")) as Vectors;

describe("verifier vectors (shared with prep/polyprep/verify.py)", () => {
  for (const c of vectors.cases) {
    it(`${c.match}: ${JSON.stringify(c.claim)} vs ${JSON.stringify(c.answer)} → ${c.passed}`, () => {
      expect(verifyClaim({ answer: c.answer, aliases: c.aliases, match: c.match }, c.claim).passed).toBe(c.passed);
    });
  }
  for (const n of vectors.normalize) {
    it(`normalizes ${JSON.stringify(n.in)}`, () => expect(normalizeText(n.in)).toBe(n.out));
  }
});

describe("verifier details", () => {
  it("reduces fractions", () => {
    expect(numericValue("6/8")).toEqual({ n: 3n, d: 4n });
    expect(numericValue("-\\frac{2}{4}")).toEqual({ n: -1n, d: 2n });
  });

  it("explains failures without leaking anything to agents (detail is for the log only)", () => {
    expect(verifyClaim({ answer: "204", aliases: [], match: "numeric" }, "between 200 and 210")).toEqual({ passed: false, detail: "no single number in the claim: between 200 and 210" });
    expect(verifyClaim({ answer: "Lyon", aliases: [], match: "exact" }, "Ghent")).toEqual({ passed: false, detail: "expected Lyon, got Ghent" });
  });
});

describe("numericKey", () => {
  it("accepts a key that is exactly one number", () => {
    expect(numericKey("204")).toEqual({ n: 204n, d: 1n });
    expect(numericKey(" 3/4 ")).toEqual({ n: 3n, d: 4n });
    expect(numericKey("-\\frac{1}{2}")).toEqual({ n: -1n, d: 2n });
    expect(numericKey("1,000")).toEqual({ n: 1000n, d: 1n });
  });
  it("trims like JavaScript: the BOM goes, the file separator does not", () => {
    expect(numericKey("\ufeff5")).toEqual({ n: 5n, d: 1n });
    expect(numericKey("\x1c5")).toBeNull();
  });
  it("refuses a key with anything else in it", () => {
    for (const k of ["x^2", "2x+1", "between 1 and 2", ""]) expect(numericKey(k)).toBeNull();
  });
});
