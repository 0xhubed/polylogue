import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventInput, Event } from "@polylogue/schema";
import { Matrix, expandMatrix } from "./matrix.ts";
import { collectOutcomes, maxPairwiseJaccard, proposeBudget, proposeWallClock, renderReport } from "./report.ts";
import { EventLog } from "../log/event-log.ts";
import { forkInstruction } from "../fork/texts.ts";

const MODEL = { id: "m", hfRepo: "r", revision: "v", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 1000, maxRetries: 0 };
const m = Matrix.parse({
  name: "pilot-p0", orderSeed: 1, servers: ["http://x/v1"], conditions: ["single"], seeds: [1, 2],
  suites: [{ suite: "bcp", split: "pilot", tokensPerAgent: 200_000, wallClockMs: 1_800_000 }, { suite: "math", split: "pilot", tokensPerAgent: 200_000, wallClockMs: 1_800_000 }],
  rate: { messagesPerMinute: 10, maxMessageChars: 2000 }, model: MODEL,
});
const tasks = { bcp: ["bcp-1", "bcp-2"], math: ["math-1", "math-2"] } as Record<string, string[]>;

function fakeRun(log: EventLog, id: string, o: { solved: boolean; tokens: number; wallMs: number; reads?: ([string, string] | [string, string, "error"])[]; claim?: string; claims?: [string, string, boolean][]; reason?: "solved" | "budget" | "infra_error" | "all_idle" | "killed"; sandboxDown?: boolean; modelCalls?: [number, number, number][]; fork?: { t: number; directions?: string[]; fallback?: boolean; call?: number }; pool?: number; instructedAfterCalls?: number; afterFork?: { agent: string; call: number; tokensIn: number; t?: number; stopReason?: "aborted" | "error" }[] }) {
  const reason = o.reason ?? (o.solved ? "solved" : "budget");
  log.createRun({ id, condition: "single", n: 1, taskId: "t", seed: 1, model: "m", revision: "v", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
  const ev = (e: EventInput, t: number) => log.append(id, { ...e, t } as Event);
  ev({ kind: "agent_started", agent: "a1", index: 0, seed: 100, systemPrompt: "s", tools: [] }, 0);
  if (o.pool) ev({ kind: "run_started", condition: "fork", n: 4, taskId: "t", task: "q", pool: o.pool, wallClockMs: 1 }, 0);
  const modelCall = (agent: string, call: number, t: number, tokensIn: number, tokensOut: number, stopReason: "stop" | "aborted" | "error" = "stop") =>
    ev({ kind: "model_call", agent, call, content: "", reasoning: "", toolCalls: [], tokensIn, tokensOut, ms: 1, stopReason }, t);
  const calls = o.modelCalls ?? [];
  if (o.instructedAfterCalls === 0) ev({ kind: "runtime_note", agent: "a1", text: forkInstruction() }, 0);
  calls.forEach(([t, tokensIn, tokensOut], i) => {
    modelCall("a1", i, t, tokensIn, tokensOut);
    if (o.instructedAfterCalls === i + 1) ev({ kind: "runtime_note", agent: "a1", text: forkInstruction() }, t);
  });
  if (o.fork) {
    const f = o.fork;
    ev({ kind: "fork", agent: "a1", call: f.call ?? 0, children: ["a2", "a3", "a4"], directions: f.directions ?? ["Search the archives", "Check the news", "Ask the registry"], fallback: f.fallback ?? false }, f.t);
  }
  for (const c of o.afterFork ?? []) modelCall(c.agent, c.call, c.t ?? 30, c.tokensIn, 1, c.stopReason);
  (o.reads ?? []).forEach(([agent, doc, error], i) => {
    ev({ kind: "tool_call", agent, callId: `c${i}`, tool: "read_doc", args: { id: doc } }, 1);
    ev({ kind: "tool_result", agent, callId: `c${i}`, tool: "read_doc", isError: error === "error", text: error ? `There is no document "${doc}".` : "text", ms: 1 }, 1);
  });
  if (o.sandboxDown) {
    ev({ kind: "tool_call", agent: "a1", callId: "py", tool: "run_python", args: { code: "print(1)" } }, 1);
    ev({ kind: "tool_result", agent: "a1", callId: "py", tool: "run_python", isError: true, text: "The Python sandbox is unavailable: Cannot connect to the Docker daemon", ms: 1 }, 1);
  }
  for (const [agent, answer, passed] of o.claims ?? []) {
    ev({ kind: "claim_submitted", agent, answer, evidence: "e" }, 2);
    ev({ kind: "verification", claimOf: agent, passed, ...(passed ? {} : { detail: `expected Ghent, got ${answer}` }) }, 2);
  }
  if (o.claim) {
    ev({ kind: "claim_submitted", agent: "a1", answer: o.claim, evidence: "e" }, 2);
    ev({ kind: "verification", claimOf: "a1", passed: o.solved, ...(o.solved ? {} : { detail: `expected Ghent, got ${o.claim}` }) }, 2);
  }
  ev({ kind: "run_finished", reason, solved: o.solved, wallMs: o.wallMs, totalTokens: o.tokens }, o.wallMs);
  log.finishRun(id, o.solved ? "solved" : reason === "infra_error" ? "infra_error" : "unsolved", reason, "2026-10-11T00:01:00Z");
}

function fixture(): EventLog {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
  fakeRun(log, "bcp-bcp-1-single-s1", { solved: true, tokens: 40_000, wallMs: 100_000, reads: [["a1", "d1"], ["a1", "d1"]] });
  fakeRun(log, "bcp-bcp-1-single-s2", { solved: true, tokens: 60_000, wallMs: 300_000 });
  fakeRun(log, "bcp-bcp-2-single-s1", { solved: true, tokens: 50_001, wallMs: 200_000 });
  fakeRun(log, "bcp-bcp-2-single-s2", { solved: false, tokens: 200_000, wallMs: 900_000, claim: "Lyon" });
  fakeRun(log, "math-math-1-single-s1", { solved: false, tokens: 10_000, wallMs: 50_000, reason: "infra_error" });
  fakeRun(log, "math-math-1-single-s1-r1", { solved: true, tokens: 12_000, wallMs: 60_000 });
  fakeRun(log, "math-math-1-single-s2", { solved: false, tokens: 30_000, wallMs: 70_000 });
  fakeRun(log, "math-math-2-single-s1", { solved: false, tokens: 31_000, wallMs: 70_000 });
  return log; // math-math-2-single-s2 has no run yet
}

const render = (mx: Matrix, log: EventLog) => renderReport(mx, collectOutcomes(mx, log, (s) => tasks[s] ?? []), expandMatrix(mx, (s) => tasks[s] ?? []));

describe("pilot report", () => {
  it("collects outcomes, preferring the -r1 rerun and skipping cells without a finished run", () => {
    const out = collectOutcomes(m, fixture(), (s) => tasks[s]!);
    expect(out).toHaveLength(7);
    expect(out.find((o) => o.cell.id === "math-math-1-single-s1")).toMatchObject({ runId: "math-math-1-single-s1-r1", solved: true, tokens: 12_000 });
    expect(out.find((o) => o.runId === "bcp-bcp-2-single-s2")!.failedClaims).toEqual([{ agent: "a1", answer: "Lyon", detail: "expected Ghent, got Lyon" }]);
  });

  it("proposes B by the P0 rule and flags a floor", () => {
    const b = proposeBudget(collectOutcomes(m, fixture(), (s) => tasks[s]!));
    expect(b.bcp).toEqual({ B: 76_000, solved: 3, runs: 4, floor: false, infra: 0 }); // median 50,001 × 1.5 = 75,001.5 → 76,000
    expect(b.math).toEqual({ B: 30_000, solved: 1, runs: 3, floor: true, infra: 0 });
  });

  it("proposes wall-clock limits from the slowest solved single run", () => {
    expect(proposeWallClock(collectOutcomes(m, fixture(), (s) => tasks[s]!))).toEqual({ bcp: 900_000, math: 180_000 });
  });

  it("renders Markdown with the tables, the floor check and failed claims", () => {
    const md = render(m, fixture());
    expect(md.split("\n")[0]).toBe("# Pilot report: pilot-p0");
    expect(md).toContain("| bcp | single | 4 | 3 | 75% |");
    expect(md).not.toContain("ledger");
    expect(md).toContain("| bcp-bcp-2-single-s2 | a1 | Lyon | expected Ghent, got Lyon |");
    expect(md).toContain("Floor check (bcp): passed");
    expect(md).toContain("median tokens (run total)");
  });

  it("scores the first claim apart from any passing claim (isolated keeps going after a wrong claim)", () => {
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
    fakeRun(log, "bcp-bcp-1-single-s1", { solved: true, tokens: 1, wallMs: 1, claims: [["a1", "Lyon", false], ["a2", "Ghent", true]] });
    fakeRun(log, "bcp-bcp-1-single-s2", { solved: true, tokens: 1, wallMs: 1, claims: [["a1", "Ghent", true]] });
    const md = render(m, log);
    expect(md).toContain("first claim solves");
    expect(md).toContain("| bcp | single | 2 | 2 | 100% | 50% |");
  });

  it("lists no wall-clock limit for a suite without single runs", () => {
    const out = collectOutcomes(m, fixture(), (s) => tasks[s]!);
    const ledgerOnly = { ...out[0]!, cell: { ...out[0]!.cell, suite: "ledger" as const, condition: "isolated" as const } };
    expect(proposeWallClock([...out, ledgerOnly])).toEqual({ bcp: 900_000, math: 180_000 });
  });

  it("states how many cells were expected, finished, infra errors and missing", () => {
    const md = render(m, fixture());
    expect(md).toContain("- bcp: cells: 4 expected, 4 finished, 0 ended in infra_error, 0 ended killed, 0 missing");
    expect(md).toContain("- math: cells: 4 expected, 3 finished, 0 ended in infra_error, 0 ended killed, 1 missing");
  });

  it("leaves infra_error runs out of the token medians but counts them as runs", () => {
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
    fakeRun(log, "math-math-1-single-s1", { solved: true, tokens: 12_000, wallMs: 60_000 });
    fakeRun(log, "math-math-1-single-s2", { solved: false, tokens: 30_000, wallMs: 70_000 });
    fakeRun(log, "math-math-2-single-s1", { solved: false, tokens: 31_000, wallMs: 70_000 });
    fakeRun(log, "math-math-2-single-s2", { solved: false, tokens: 900_000, wallMs: 5_000, reason: "infra_error" });
    const out = collectOutcomes(m, log, (s) => tasks[s] ?? []);
    expect(proposeBudget(out).math).toEqual({ B: 30_000, solved: 1, runs: 4, floor: true, infra: 1 });
    const md = render(m, log);
    expect(md).toContain("- math: cells: 4 expected, 4 finished, 1 ended in infra_error, 0 ended killed, 0 missing");
    expect(md).toContain("| math | single | 4 | 1 | 25% |");
  });

  it("never proposes a budget below 1,000", () => {
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
    fakeRun(log, "bcp-bcp-1-single-s1", { solved: true, tokens: 1, wallMs: 1 });
    expect(proposeBudget(collectOutcomes(m, log, (s) => tasks[s] ?? [])).bcp!.B).toBe(1000);
  });

  it("does not judge the bcp floor until every condition has a finished bcp run", () => {
    const two = Matrix.parse({ ...m, conditions: ["single", "isolated"] });
    expect(render(two, fixture())).toContain("Floor check (bcp): not enough runs yet");
    expect(render(two, fixture())).not.toContain("FAILED");
  });

  it("counts documents read by more than one agent", () => {
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
    fakeRun(log, "bcp-bcp-1-single-s1", { solved: true, tokens: 1, wallMs: 1, reads: [["a1", "d1"], ["a2", "d1"], ["a2", "d2"], ["a3", "d1"], ["a1", "d3"], ["a3", "d3"]] });
    const o = collectOutcomes(m, log, (s) => (s === "bcp" ? ["bcp-1"] : []))[0]!;
    expect(o).toMatchObject({ reads: 3, sharedReads: 2 });
  });

  it("does not count a read_doc call that failed as a read", () => {
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
    fakeRun(log, "bcp-bcp-1-single-s1", { solved: true, tokens: 1, wallMs: 1, reads: [["a1", "d1"], ["a2", "d1", "error"], ["a2", "nope", "error"], ["a3", "nope", "error"], ["a1", "d3"], ["a3", "d3"]] });
    const o = collectOutcomes(m, log, (s) => (s === "bcp" ? ["bcp-1"] : []))[0]!;
    expect(o).toMatchObject({ reads: 2, sharedReads: 1 });
  });

  it("lists runs that hit an unavailable sandbox and counts killed runs per suite", () => {
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
    fakeRun(log, "math-math-1-single-s1", { solved: false, tokens: 10, wallMs: 10, sandboxDown: true });
    fakeRun(log, "math-math-1-single-s2", { solved: false, tokens: 10, wallMs: 10, reason: "killed" });
    fakeRun(log, "math-math-2-single-s1", { solved: true, tokens: 10, wallMs: 10 });
    const md = render(m, log);
    expect(md).toContain("- math: cells: 4 expected, 3 finished, 0 ended in infra_error, 1 ended killed, 1 missing");
    const section = md.slice(md.indexOf("## Sandbox failures"));
    expect(section.split("\n").slice(0, 6).join("\n")).toContain("- math-math-1-single-s1 (1 tool result)");
    expect(section).not.toContain("math-math-2-single-s1");
    expect(render(m, fixture())).toContain("## Sandbox failures\n\nnone");
  });

  const forkM = Matrix.parse({ ...m, name: "pilot-p2", conditions: ["fork", "fork-silent"], seeds: [1, 2] });
  const forkTasks = { bcp: ["bcp-1"], math: [] } as Record<string, string[]>;
  const forkMatrix = Matrix.parse({ ...forkM, suites: [forkM.suites[0]] });
  const renderFork = (log: EventLog) => renderReport(forkMatrix, collectOutcomes(forkMatrix, log, (s) => forkTasks[s] ?? []), expandMatrix(forkMatrix, (s) => forkTasks[s] ?? []));

  it("reports fork, fallback and distinct-direction counts", () => {
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
    // fork: s1 forks with distinct directions after 1,000 + 500 tokens (the later call is after the fork in the log, though its timestamp is
    // earlier than the fork's: positions decide, not milliseconds), s2 ends before the fork
    fakeRun(log, "bcp-bcp-1-fork-s1", { solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 600, 400], [3, 400, 100]], fork: { t: 5 }, afterFork: [{ agent: "a1", call: 2, tokensIn: 5000, t: 2 }] });
    fakeRun(log, "bcp-bcp-1-fork-s2", { solved: false, tokens: 9, wallMs: 10, modelCalls: [[1, 100, 100]] });
    // fork-silent: s1 forks with directions that differ only by case and spaces (not distinct), s2 is a fallback fork
    fakeRun(log, "bcp-bcp-1-fork-silent-s1", { solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 3000, 0]], fork: { t: 5, directions: ["Search", " search ", "Other"] } });
    fakeRun(log, "bcp-bcp-1-fork-silent-s2", { solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 1000, 1000]], fork: { t: 5, fallback: true, directions: ["Try a different approach", "Try a different approach", "Try a different approach"] } });
    const md = renderFork(log);
    const section = md.slice(md.indexOf("## Fork"), md.indexOf("## Proposed budget"));
    expect(section).toContain("fallback forks count as not distinct");
    expect(section).toContain("| bcp | fork | 2 | 1 | 0 | 1 | 1 | 1500 |");
    expect(section).toContain("| bcp | fork-silent | 2 | 2 | 1 | 0 | 0 | 2500 |");
  });

  const forkLog = () => new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
  const forkSectionOf = (log: EventLog) => {
    const md = renderFork(log);
    return md.slice(md.indexOf("## Fork"), md.indexOf("## Proposed budget"));
  };

  it("counts a call logged in the same millisecond as the fork before it, by position", () => {
    const log = forkLog();
    fakeRun(log, "bcp-bcp-1-fork-s1", { solved: true, tokens: 9, wallMs: 10, modelCalls: [[5, 100, 100], [5, 50, 50]], fork: { t: 5 }, afterFork: [{ agent: "a1", call: 2, tokensIn: 9000, t: 5 }] });
    expect(collectOutcomes(forkMatrix, log, (s) => forkTasks[s] ?? [])[0]!.tokensBeforeFork).toBe(300);
  });

  it("lists each fork run's three directions, cut at 300 characters, with the near-duplicate measure", () => {
    const log = forkLog();
    const long = "x".repeat(350);
    fakeRun(log, "bcp-bcp-1-fork-s1", { solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 10, 10]], fork: { t: 5, directions: ["Search the archive for the film", "Search the archive for the series", long] } });
    fakeRun(log, "bcp-bcp-1-fork-s2", { solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 10, 10]], fork: { t: 5, directions: ["Check dates", "Ask the registry", "Run the numbers"] } });
    fakeRun(log, "bcp-bcp-1-fork-silent-s1", { solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 10, 10]], fork: { t: 5, fallback: true, directions: ["Try a different approach", "Try a different approach", "Try a different approach"] } });
    const section = forkSectionOf(log);
    expect(section).toContain("### Directions");
    expect(section).toContain("genuinely different");
    expect(section).toContain("- bcp-bcp-1-fork-s1 (bcp, fork; max word-Jaccard 0.67)\n  1. Search the archive for the film\n  2. Search the archive for the series\n  3. " + "x".repeat(300) + "…\n");
    expect(section).not.toContain("x".repeat(301));
    expect(section).toContain("- bcp-bcp-1-fork-silent-s1 (bcp, fork-silent, fallback; max word-Jaccard 1.00)");
    // medians over forked runs: fork has 0.67 and 0.20 (the shared "the"), fork-silent 1.00
    expect(section).toContain("| bcp | fork | 0 | 0 | 0.43 | 0 |");
    expect(section).toContain("| bcp | fork-silent | 0 | 0 | 1.00 | 0 |");
  });

  it("maxPairwiseJaccard: lowercased word sets, punctuation ignored, stopwords kept", () => {
    expect(maxPairwiseJaccard(["a b c", "A, b; c!", "x y"])).toBe(1);
    expect(maxPairwiseJaccard(["a b", "c d", "e f"])).toBe(0);
    expect(maxPairwiseJaccard(["the cat sat", "the cat ran", "dog"])).toBeCloseTo(0.5);
    expect(maxPairwiseJaccard(["Doc 42", "doc 42 again", "Ghent"])).toBeCloseTo(2 / 3);
    expect(maxPairwiseJaccard(["snake_case word", "snake case word", "x"])).toBe(1); // an underscore splits, as in analysis.py
  });

  it("counts runs told to fork before 10% of the pool", () => {
    const log = forkLog();
    // pool 10,000: s1 told after 200 charged tokens (early), s2 after 1,500 (not early), s3 never told
    fakeRun(log, "bcp-bcp-1-fork-s1", { solved: true, tokens: 9, wallMs: 10, pool: 10_000, modelCalls: [[1, 100, 100]], instructedAfterCalls: 1, fork: { t: 5 } });
    fakeRun(log, "bcp-bcp-1-fork-s2", { solved: true, tokens: 9, wallMs: 10, pool: 10_000, modelCalls: [[1, 1000, 500]], instructedAfterCalls: 1, fork: { t: 5 } });
    const section = forkSectionOf(log);
    expect(section).toContain("| bcp | fork | 2 | 1 |");
    const log2 = forkLog();
    fakeRun(log2, "bcp-bcp-1-fork-s1", { solved: true, tokens: 9, wallMs: 10, pool: 10_000, modelCalls: [[1, 1000, 0]], instructedAfterCalls: 1, fork: { t: 5 } }); // exactly 10%: not early
    fakeRun(log2, "bcp-bcp-1-fork-s2", { solved: true, tokens: 9, wallMs: 10, pool: 10_000, modelCalls: [[1, 100, 100]] });
    expect(forkSectionOf(log2)).toContain("| bcp | fork | 1 | 0 |");
  });

  it("flags copies whose first call has fewer prompt tokens than the root's fork call", () => {
    const log = forkLog();
    fakeRun(log, "bcp-bcp-1-fork-s1", {
      solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 300, 10], [3, 600, 10]], fork: { t: 5, call: 1 },
      afterFork: [{ agent: "a2", call: 0, tokensIn: 500 }, { agent: "a3", call: 0, tokensIn: 700 }, { agent: "a4", call: 0, tokensIn: 600 }, { agent: "a2", call: 1, tokensIn: 100 }],
    });
    fakeRun(log, "bcp-bcp-1-fork-s2", { solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 300, 10]], fork: { t: 5, call: 0 }, afterFork: [{ agent: "a2", call: 0, tokensIn: 400 }] });
    const section = forkSectionOf(log);
    expect(section).toContain("| 1 (bcp-bcp-1-fork-s1: a2) |");
    expect(collectOutcomes(forkMatrix, log, (s) => forkTasks[s] ?? []).find((o) => o.runId === "bcp-bcp-1-fork-s2")!.shortInheritance).toEqual([]);
  });

  it("skips a copy's aborted or failed calls when checking inheritance", () => {
    // a claim or an infra error ends the run while a copy's first call is in flight: that call is logged with 0 prompt tokens
    const log = forkLog();
    fakeRun(log, "bcp-bcp-1-fork-s1", {
      solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 300, 10]], fork: { t: 5, call: 0 },
      afterFork: [{ agent: "a2", call: 0, tokensIn: 0, stopReason: "aborted" }, { agent: "a3", call: 0, tokensIn: 0, stopReason: "error" }, { agent: "a3", call: 1, tokensIn: 200 }, { agent: "a4", call: 0, tokensIn: 400 }],
    });
    expect(collectOutcomes(forkMatrix, log, (s) => forkTasks[s] ?? []).find((o) => o.runId === "bcp-bcp-1-fork-s1")!.shortInheritance).toEqual(["a3"]);
  });

  it("leaves infra_error runs out of the fallback-rate denominator and counts them", () => {
    const five = Matrix.parse({ ...forkMatrix, conditions: ["fork"], seeds: [1, 2, 3, 4, 5] });
    const log = forkLog();
    fakeRun(log, "bcp-bcp-1-fork-s1", { solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 10, 10]], fork: { t: 5, fallback: true } });
    for (const s of [2, 3, 4]) fakeRun(log, `bcp-bcp-1-fork-s${s}`, { solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 10, 10]], fork: { t: 5 } });
    fakeRun(log, "bcp-bcp-1-fork-s5", { solved: false, tokens: 9, wallMs: 10, reason: "infra_error" });
    const md = renderReport(five, collectOutcomes(five, log, (x) => forkTasks[x] ?? []), expandMatrix(five, (x) => forkTasks[x] ?? []));
    // 1 of 4 measured = 25% is above 20%, though 1 of 5 would not be
    expect(md).toContain("Fallback rate above 20%: STOP (spec §4.7) — 1 of 4 fork-condition runs (1 infra_error run left out of the denominator), 25%");
  });

  it("flags a fallback rate above 20%", () => {
    const five = Matrix.parse({ ...forkMatrix, conditions: ["fork"], seeds: [1, 2, 3, 4, 5] });
    const mk = (fallbacks: number) => {
      const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
      for (let s = 1; s <= 5; s++) fakeRun(log, `bcp-bcp-1-fork-s${s}`, { solved: true, tokens: 9, wallMs: 10, modelCalls: [[1, 10, 10]], fork: { t: 5, fallback: s <= fallbacks } });
      return renderReport(five, collectOutcomes(five, log, (x) => forkTasks[x] ?? []), expandMatrix(five, (x) => forkTasks[x] ?? []));
    };
    expect(mk(1)).toContain("Fallback rate: ok"); // 1 of 5 = 20%, not above
    expect(mk(1)).not.toContain("STOP");
    expect(mk(2)).toContain("Fallback rate above 20%: STOP (spec §4.7)"); // 2 of 5 = 40%
    expect(mk(2)).not.toContain("Fallback rate: ok");
  });

  it("pilot-p2 matrix expands to 40 cells", () => {
    const mx = Matrix.parse(JSON.parse(readFileSync(new URL("../../../../configs/pilot-p2.json", import.meta.url), "utf8")));
    expect(mx.name).toBe("pilot-p2");
    expect(mx.conditions).toEqual(["fork", "fork-silent"]);
    expect(expandMatrix(mx, () => ["t1", "t2", "t3", "t4", "t5"])).toHaveLength(40);
    expect(mx.suites.map((s) => [s.suite, s.split, s.tokensPerAgent, s.wallClockMs])).toEqual([["bcp", "pilot", 80_000, 1_800_000], ["math", "pilot", 38_000, 1_800_000]]);
  });
});
