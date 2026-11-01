import { describe, expect, it } from "vitest";
import type { RunContext } from "../run/context.ts";
import { MAX_DIRECTION_CHARS } from "../fork/texts.ts";
import { forkTool, parseDirections, validateDirections } from "./fork-tool.ts";

function fakeCtx() {
  const calls: { parent: string; directions: string[]; fallback: boolean }[] = [];
  let did = false;
  const ctx = {
    fork(parent: string, directions: string[], o: { fallback: boolean }) {
      calls.push({ parent, directions, fallback: o.fallback });
      did = true;
      return ["a1", "a2", "a3"];
    },
    forked: () => did,
  } as unknown as RunContext;
  return { ctx, calls };
}

describe("validateDirections", () => {
  it("accepts three distinct strings and trims them", () => {
    expect(validateDirections(["  one ", "two", "three  "])).toEqual({ ok: true, directions: ["one", "two", "three"] });
  });
  it("rejects two or four strings", () => {
    expect(validateDirections(["a", "b"]).ok).toBe(false);
    expect(validateDirections(["a", "b", "c", "d"]).ok).toBe(false);
  });
  it("rejects a non-array", () => {
    expect(validateDirections("a").ok).toBe(false);
    expect(validateDirections(undefined).ok).toBe(false);
  });
  it("rejects a non-string entry", () => {
    expect(validateDirections(["a", "b", 3]).ok).toBe(false);
  });
  it("rejects an empty or blank string", () => {
    expect(validateDirections(["a", "", "c"]).ok).toBe(false);
    expect(validateDirections(["a", "   ", "c"]).ok).toBe(false);
  });
  it("accepts exactly the maximum length and rejects one more", () => {
    expect(validateDirections(["a".repeat(MAX_DIRECTION_CHARS), "b", "c"]).ok).toBe(true);
    const r = validateDirections(["a".repeat(MAX_DIRECTION_CHARS + 1), "b", "c"]);
    expect(r.ok).toBe(false);
    expect(MAX_DIRECTION_CHARS).toBe(300);
  });
  it("rejects duplicates, ignoring case and surrounding whitespace", () => {
    const r = validateDirections(["A", "a ", "b"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/different|distinct|duplicate/i);
  });
  it("keeps the original case", () => {
    expect(validateDirections(["Alpha", "Beta", "Gamma"])).toEqual({ ok: true, directions: ["Alpha", "Beta", "Gamma"] });
  });
});

describe("parseDirections", () => {
  it("passes an array through", () => {
    expect(parseDirections(["a", "b", "c"])).toEqual({ ok: true, value: ["a", "b", "c"] });
  });
  it("parses a string holding a JSON array of strings", () => {
    expect(parseDirections('["a", "b", "c"]')).toEqual({ ok: true, value: ["a", "b", "c"] });
    expect(parseDirections('  ["a","b","c"]  ')).toEqual({ ok: true, value: ["a", "b", "c"] });
  });
  it("rejects a string that is not JSON", () => {
    const r = parseDirections("one, two, three");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON array of strings/);
  });
  it("rejects a JSON string that is not an array of strings", () => {
    expect(parseDirections('{"a": 1}').ok).toBe(false);
    expect(parseDirections('["a", 2, "c"]').ok).toBe(false);
    expect(parseDirections('"just a string"').ok).toBe(false);
  });
});

describe("forkTool", () => {
  it("is named fork", () => {
    expect(forkTool("a0", fakeCtx().ctx).name).toBe("fork");
  });

  it("fork tool calls ctx.fork once", async () => {
    const { ctx, calls } = fakeCtx();
    const tool = forkTool("a0", ctx);
    const res = await tool.execute("id", { directions: [" x ", "y", "z"] });
    expect(calls).toEqual([{ parent: "a0", directions: ["x", "y", "z"], fallback: false }]);
    const out = (res.content[0] as { text: string }).text;
    expect(out).toContain("a1: x");
    expect(out).toContain("a3: z");
  });

  it("accepts the directions as a string holding a JSON array", async () => {
    const { ctx, calls } = fakeCtx();
    const res = await forkTool("a0", ctx).execute("id", { directions: '[" x ", "y", "z"]' });
    expect(calls).toEqual([{ parent: "a0", directions: ["x", "y", "z"], fallback: false }]);
    expect((res.content[0] as { text: string }).text).toContain("a2: y");
  });

  it("a string that is not a JSON array of strings is an error with a clear message and does not fork", async () => {
    const { ctx, calls } = fakeCtx();
    await expect(forkTool("a0", ctx).execute("id", { directions: "look at docs, check dates, run numbers" })).rejects.toThrow(/JSON array of strings/);
    expect(calls).toHaveLength(0);
  });

  it("the schema accepts both an array and a string", () => {
    const schema = JSON.stringify(forkTool("a0", fakeCtx().ctx).parameters);
    expect(schema).toContain('"array"');
    expect(schema).toContain('"string"');
  });

  it("a second fork call is an error", async () => {
    const { ctx, calls } = fakeCtx();
    const tool = forkTool("a0", ctx);
    await tool.execute("id", { directions: ["x", "y", "z"] });
    await expect(tool.execute("id", { directions: ["x", "y", "z"] })).rejects.toThrow(/already forked/);
    expect(calls).toHaveLength(1);
  });

  it("an invalid call is an error and does not fork", async () => {
    const { ctx, calls } = fakeCtx();
    await expect(forkTool("a0", ctx).execute("id", { directions: ["x", "y"] })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("is an error when the context cannot fork", async () => {
    const ctx = {} as unknown as RunContext;
    await expect(forkTool("a0", ctx).execute("id", { directions: ["x", "y", "z"] })).rejects.toThrow(/fork/i);
  });
});
