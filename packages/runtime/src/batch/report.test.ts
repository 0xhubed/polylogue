import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventInput, Event } from "@polylogue/schema";
import { Matrix, expandMatrix } from "./matrix.ts";
import { collectOutcomes, proposeBudget, proposeWallClock, renderReport } from "./report.ts";
import { EventLog } from "../log/event-log.ts";

const MODEL = { id: "m", hfRepo: "r", revision: "v", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 1000, maxRetries: 0 };
const m = Matrix.parse({
  name: "pilot-p0", orderSeed: 1, servers: ["http://x/v1"], conditions: ["single"], seeds: [1, 2],
  suites: [{ suite: "bcp", split: "pilot", tokensPerAgent: 200_000, wallClockMs: 1_800_000 }, { suite: "math", split: "pilot", tokensPerAgent: 200_000, wallClockMs: 1_800_000 }],
  rate: { messagesPerMinute: 10, maxMessageChars: 2000 }, model: MODEL,
});
const tasks = { bcp: ["bcp-1", "bcp-2"], math: ["math-1", "math-2"] } as Record<string, string[]>;

function fakeRun(log: EventLog, id: string, o: { solved: boolean; tokens: number; wallMs: number; reads?: ([string, string] | [string, string, "error"])[]; claim?: string; claims?: [string, string, boolean][]; reason?: "solved" | "budget" | "infra_error" | "all_idle" | "killed"; sandboxDown?: boolean }) {
  const reason = o.reason ?? (o.solved ? "solved" : "budget");
  log.createRun({ id, condition: "single", n: 1, taskId: "t", seed: 1, model: "m", revision: "v", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
  const ev = (e: EventInput, t: number) => log.append(id, { ...e, t } as Event);
  ev({ kind: "agent_started", agent: "a1", index: 0, seed: 100, systemPrompt: "s", tools: [] }, 0);
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
});
