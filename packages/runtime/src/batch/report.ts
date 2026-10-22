import type { Event } from "@polylogue/schema";
import type { SuiteId } from "../config.ts";
import type { EventLog } from "../log/event-log.ts";
import { expandMatrix, type Cell, type Matrix } from "./matrix.ts";

export interface Outcome {
  cell: Cell;
  runId: string;
  reason: string;
  solved: boolean;
  /** The first claim passed: the team-answer score (equal to solved where the first claim ends the run; isolated's primary score). */
  firstClaimSolved: boolean;
  tokens: number;
  wallMs: number;
  messages: number;
  agents: number;
  reads: number;
  sharedReads: number;
  /** tool results that said "The Python sandbox is unavailable" */
  sandboxFailures: number;
  failedClaims: { agent: string; answer: string; detail: string }[];
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
export const SANDBOX_UNAVAILABLE = "The Python sandbox is unavailable";
const up1000 = (x: number) => Math.max(1000, Math.ceil(x / 1000) * 1000);

function outcome(cell: Cell, runId: string, events: Event[]): Outcome | null {
  const end = events.find((e) => e.kind === "run_finished");
  if (!end || end.kind !== "run_finished") return null;
  const agents = events.filter((e) => e.kind === "agent_started").length || 1;
  // a read_doc call whose result was an error (wrong id or page) read nothing
  const failed = new Set(events.flatMap((e) => (e.kind === "tool_result" && e.tool === "read_doc" && e.isError ? [`${e.agent}|${e.callId}`] : [])));
  const readers = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.kind === "tool_call" && e.tool === "read_doc" && !failed.has(`${e.agent}|${e.callId}`)) {
      const id = String((e.args as { id?: unknown })?.id ?? "");
      readers.set(id, (readers.get(id) ?? new Set()).add(e.agent));
    }
  }
  const claims = new Map<string, string>();
  const failedClaims: Outcome["failedClaims"] = [];
  for (const e of events) {
    if (e.kind === "claim_submitted") claims.set(e.agent, e.answer);
    if (e.kind === "verification" && !e.passed) failedClaims.push({ agent: e.claimOf, answer: claims.get(e.claimOf) ?? "", detail: e.detail ?? "" });
  }
  const first = events.find((e) => e.kind === "verification");
  return {
    cell, runId, reason: end.reason, solved: end.solved, firstClaimSolved: first?.kind === "verification" && first.passed, tokens: end.totalTokens, wallMs: end.wallMs,
    messages: events.filter((e) => e.kind === "message").length, agents,
    reads: readers.size, sharedReads: [...readers.values()].filter((s) => s.size > 1).length,
    sandboxFailures: events.filter((e) => e.kind === "tool_result" && e.text.includes(SANDBOX_UNAVAILABLE)).length, failedClaims,
  };
}

export function collectOutcomes(m: Matrix, log: EventLog, list: (suite: SuiteId, split: "pilot" | "scored") => string[]): Outcome[] {
  const out: Outcome[] = [];
  for (const cell of expandMatrix(m, list)) {
    const base = log.run(cell.id);
    const re = log.run(`${cell.id}-r1`);
    const runId = base?.status === "infra_error" && re ? re.id : base?.id;
    if (!runId) continue;
    const o = outcome(cell, runId, log.events(runId).map((s) => s.event));
    if (o) out.push(o);
  }
  return out;
}

export interface BudgetProposal {
  B: number;
  solved: number;
  runs: number;
  floor: boolean;
  /** infra_error runs: counted in `runs`, left out of the token medians */
  infra: number;
}

export function proposeBudget(outcomes: Outcome[]): Record<string, BudgetProposal> {
  const res: Record<string, BudgetProposal> = {};
  for (const suite of new Set(outcomes.map((o) => o.cell.suite))) {
    const single = outcomes.filter((o) => o.cell.suite === suite && o.cell.condition === "single");
    if (single.length === 0) continue;
    const per = (o: Outcome) => o.tokens / o.agents;
    const measured = single.filter((o) => o.reason !== "infra_error");
    const solved = measured.filter((o) => o.solved);
    const floor = solved.length < 3;
    res[suite] = {
      B: floor ? up1000(median(measured.map(per))) : up1000(1.5 * median(solved.map(per))),
      solved: solved.length,
      runs: single.length,
      floor,
      infra: single.length - measured.length,
    };
  }
  return res;
}

export function proposeWallClock(outcomes: Outcome[]): Record<string, number | null> {
  const res: Record<string, number | null> = {};
  for (const suite of new Set(outcomes.filter((o) => o.cell.condition === "single").map((o) => o.cell.suite))) {
    const solved = outcomes.filter((o) => o.cell.suite === suite && o.cell.condition === "single" && o.solved);
    res[suite] = solved.length ? 3 * Math.max(...solved.map((o) => o.wallMs)) : null;
  }
  return res;
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");

/** `expected` is expandMatrix(m, …): the cells the matrix asks for, so cells without a finished run show up as missing. */
export function renderReport(m: Matrix, outcomes: Outcome[], expected: Cell[]): string {
  const lines = [`# Pilot report: ${m.name}`, "", "Contains answers and claims; keep it under data/ (git-ignored).", "", "## Runs", "",
    "| suite | condition | runs | solved | solve rate | first claim solves | median tokens (run total) | median wall (s) | messages per agent | shared-read share |", "|---|---|---|---|---|---|---|---|---|---|"];
  const groups = new Map<string, Outcome[]>();
  for (const o of outcomes) groups.set(`${o.cell.suite}|${o.cell.condition}`, [...(groups.get(`${o.cell.suite}|${o.cell.condition}`) ?? []), o]);
  for (const [key, os] of groups) {
    const [suite, condition] = key.split("|");
    const solved = os.filter((o) => o.solved).length;
    const reads = os.reduce((n, o) => n + o.reads, 0);
    const shared = os.reduce((n, o) => n + o.sharedReads, 0);
    lines.push(`| ${suite} | ${condition} | ${os.length} | ${solved} | ${pct(solved, os.length)} | ${pct(os.filter((o) => o.firstClaimSolved).length, os.length)} | ${Math.round(median(os.map((o) => o.tokens)))} | ${Math.round(median(os.map((o) => o.wallMs)) / 1000)} | ${(os.reduce((n, o) => n + o.messages / o.agents, 0) / os.length).toFixed(1)} | ${pct(shared, reads)} |`);
  }
  lines.push("", "## Completeness", "");
  for (const suite of new Set(expected.map((c) => c.suite))) {
    const want = expected.filter((c) => c.suite === suite).length;
    const done = outcomes.filter((o) => o.cell.suite === suite);
    const ended = (reason: string) => done.filter((o) => o.reason === reason).length;
    lines.push(`- ${suite}: cells: ${want} expected, ${done.length} finished, ${ended("infra_error")} ended in infra_error, ${ended("killed")} ended killed, ${want - done.length} missing`);
  }
  const sandbox = outcomes.filter((o) => o.sandboxFailures > 0);
  lines.push("", "## Sandbox failures", "", sandbox.length ? `Runs with tool results saying "${SANDBOX_UNAVAILABLE}" (Docker or the image was down; consider rerunning them):` : "none");
  if (sandbox.length) lines.push("", ...sandbox.map((o) => `- ${o.runId} (${o.sandboxFailures} tool result${o.sandboxFailures === 1 ? "" : "s"})`));
  const budget = proposeBudget(outcomes);
  const wall = proposeWallClock(outcomes);
  lines.push("", "## Proposed budget B per agent (P0 rule; informational outside P0)", "", "Rule: 1.5 × median tokens per agent of solved `single` runs; with fewer than 3 solved, the median of all `single` runs (floor). infra_error runs are left out of the medians.", "");
  for (const [suite, b] of Object.entries(budget)) lines.push(`- ${suite}: B = ${b.B} (${b.solved} of ${b.runs} solved${b.floor ? "; FLOOR: fewer than 3 solved, B is the median of all runs" : ""}${b.infra ? `; ${b.infra} infra_error left out of the medians` : ""})`);
  lines.push("", "## Proposed wall-clock limit (3 × slowest solved `single` run)", "");
  for (const [suite, w] of Object.entries(wall)) lines.push(`- ${suite}: ${w === null ? "no solved single run" : `${w} ms`}`);
  if (m.suites.some((s) => s.suite === "bcp")) {
    const bcp = outcomes.filter((o) => o.cell.suite === "bcp");
    const complete = m.conditions.every((c) => bcp.some((o) => o.cell.condition === c));
    const floored = m.conditions.every((c) => bcp.filter((o) => o.cell.condition === c && o.solved).length < 2);
    lines.push("", !complete ? "Floor check (bcp): not enough runs yet" : floored ? "Floor check (bcp): FAILED — every condition solved fewer than 2 runs; consider the dense-retriever fallback (spec §7)." : "Floor check (bcp): passed");
  }
  const failed = outcomes.flatMap((o) => o.failedClaims.map((f) => ({ runId: o.runId, ...f })));
  lines.push("", "## Failed claims (alias review)", "", "| run | agent | claim | verifier |", "|---|---|---|---|");
  for (const f of failed) lines.push(`| ${f.runId} | ${f.agent} | ${f.answer.replace(/\|/g, "/").replace(/\n/g, " ")} | ${f.detail.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
  return `${lines.join("\n")}\n`;
}
