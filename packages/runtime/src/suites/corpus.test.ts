import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Corpus, LIST_PAGE, PAGE_CHARS, corpusTools, ftsQuery } from "./corpus.ts";
import { makeSuiteFixture, type FixtureDoc } from "../testing/suite-fixture.ts";

const docs: FixtureDoc[] = [
  { id: "d1", title: "Harbour report", body: "The ferry to Ghent was delayed by fog." },
  { id: "d2", title: "Supplier memo", body: "Kessler AG supplied copper wire to the vault project in Lyon." },
  { id: "d3", title: "Long document", body: "x".repeat(PAGE_CHARS * 2 + 10) },
  { id: "d4", title: "Band history", body: "The Who played their first concert in a pub." },
  ...Array.from({ length: 60 }, (_, i) => ({ id: `f${i}`, title: `Filler ${i}`, body: "Nothing relevant here." })),
];
let open: Corpus[] = [];
afterEach(() => {
  for (const c of open) c.close();
  open = [];
});
function corpus(): Corpus {
  const dir = makeSuiteFixture("bcp", [], { "corpus.sqlite": docs });
  const c = new Corpus(join(dir, "bcp", "corpus.sqlite"));
  open.push(c);
  return c;
}
const run = (c: Corpus, name: string, args: unknown) => corpusTools(c, ["search", "read_doc", "list_docs"]).find((t) => t.name === name)!.run(args);

describe("ftsQuery", () => {
  it("turns any text into quoted words joined by OR, without English stopwords", () => {
    expect(ftsQuery('who "supplied" copper AND NOT (wire*) title:vault -lyon')).toBe('"supplied" OR "copper" OR "wire" OR "title" OR "vault" OR "lyon"');
    expect(ftsQuery("  ?!  ")).toBeNull();
  });

  it("drops stopwords before the 12-word cap, so the content words of a long question survive", () => {
    const q = "In which year was the hospital that is on the island founded by the nun who later became a saint of the church?";
    expect(ftsQuery(q)).toBe('"year" OR "hospital" OR "island" OR "founded" OR "nun" OR "later" OR "became" OR "saint" OR "church"');
    const many = Array.from({ length: 15 }, (_, i) => `the word${i}`).join(" ");
    expect(ftsQuery(many)!.split(" OR ")).toHaveLength(12);
    expect(ftsQuery(many)!.startsWith('"word0" OR')).toBe(true);
  });

  it("keeps the original words when the query is only stopwords", () => {
    expect(ftsQuery("The Who")).toBe('"the" OR "who"');
    expect(ftsQuery("What is it?")).toBe('"what" OR "is" OR "it"');
  });
});

describe("Corpus tools", () => {
  it("search finds a band named only with stopwords", async () => {
    const c = corpus();
    expect((await run(c, "search", { query: "The Who" })).split("\n")[0]).toBe("1. [d4] Band history");
  });

  it("search ranks by BM25 and formats hits", async () => {
    const out = await run(corpus(), "search", { query: "Kessler copper" });
    expect(out.split("\n")[0]).toBe("1. [d2] Supplier memo");
    expect(out).toContain("Kessler AG supplied copper");
    expect(out.split("\n").filter((l) => /^\d+\. \[/.test(l)).length).toBeLessThanOrEqual(10);
  });

  it("search treats FTS5 syntax as plain words and never throws an SQLite error", async () => {
    const c = corpus();
    for (const q of ['"unbalanced', "AND OR NOT", "copper*", "(ghent", "title:harbour", "-fog", "NEAR(a b)"]) {
      await expect(run(c, "search", { query: q })).resolves.toBeTypeOf("string");
    }
    await expect(run(c, "search", { query: "zzzz" })).resolves.toBe("No documents match.");
    await expect(run(c, "search", { query: "!!!" })).rejects.toThrow("The query has no words.");
  });

  it("read_doc pages long documents and explains bad ids and pages", async () => {
    const c = corpus();
    expect(await run(c, "read_doc", { id: "d1" })).toBe("Document d1: Harbour report (page 1 of 1)\n\nThe ferry to Ghent was delayed by fog.");
    const p3 = await run(c, "read_doc", { id: "d3", page: 3 });
    expect(p3.startsWith("Document d3: Long document (page 3 of 3)\n\n")).toBe(true);
    expect(p3.length).toBe("Document d3: Long document (page 3 of 3)\n\n".length + 10);
    await expect(run(c, "read_doc", { id: "nope" })).rejects.toThrow('There is no document "nope".');
    await expect(run(c, "read_doc", { id: "d3", page: 0 })).rejects.toThrow("Document d3 has pages 1 to 3.");
    await expect(run(c, "read_doc", { id: "d3", page: 4 })).rejects.toThrow("Document d3 has pages 1 to 3.");
  });

  it("list_docs lists 50 per page in order", async () => {
    const c = corpus();
    const p1 = (await run(c, "list_docs", {})).split("\n");
    expect(p1[0]).toBe(`Documents 1–${LIST_PAGE} of 64 (page 1 of 2):`);
    expect(p1[1]).toBe("[d1] Harbour report");
    expect(p1).toHaveLength(LIST_PAGE + 1);
    expect((await run(c, "list_docs", { page: 2 })).split("\n")[0]).toBe("Documents 51–64 of 64 (page 2 of 2):");
    await expect(run(c, "list_docs", { page: 3 })).rejects.toThrow("The list has pages 1 to 2.");
  });
});
