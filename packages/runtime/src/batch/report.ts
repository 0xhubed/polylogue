import type { Event } from "@polylogue/schema";
import type { SuiteId } from "../config.ts";
import type { EventLog } from "../log/event-log.ts";
import { FORK_AT, forkInstruction } from "../fork/texts.ts";
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
  /** The root forked (a fork event exists). Only fork-condition runs can. */
  forked: boolean;
  /** The fork was the runtime's fallback (its three generic directions are identical). */
  forkFallback: boolean;
  /** The three directions differ pairwise after trim and lowercase; false for a fallback fork. */
  directionsDistinct: boolean;
  /** Tokens (in + out) of the root's model calls up to the fork, or null without a fork. */
  tokensBeforeFork: number | null;
  /** The three directions of the fork, or null without a fork. */
  directions: string[] | null;
  /** The largest word-Jaccard over the pairs of the three directions (see maxPairwiseJaccard), or null without a fork. */
  maxDirectionJaccard: number | null;
  /** The root was told to fork before the tokens charged to the pool reached FORK_AT of it (the early trigger); null if it was never told to. */
  instructedEarly: boolean | null;
  /** Copies whose first model call has fewer prompt tokens than the root's call that made the fork call: the inheritance looks short. */
  shortInheritance: string[];
}

const words = (d: string) => new Set(d.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** The largest pairwise word-Jaccard over a set of texts: lowercased, split on anything but letters and digits, stopwords kept.
 *  1 for identical texts, 0 for texts without a shared word. A descriptive near-duplicate measure, not a threshold. */
export function maxPairwiseJaccard(texts: string[]): number {
  const sets = texts.map(words);
  let best = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!;
      const b = sets[j]!;
      const union = new Set([...a, ...b]).size;
      const inter = [...a].filter((w) => b.has(w)).length;
      best = Math.max(best, union === 0 ? 1 : inter / union);
    }
  }
  return best;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
export const SANDBOX_UNAVAILABLE = "The Python sandbox is unavailable";
const up1000 = (x: number) => Math.max(1000, Math.ceil(x / 1000) * 1000);

/** The copies whose first model call has fewer prompt tokens than the root's call `fork.call`. A copy starts from the root's whole history
 *  up to the fork call and adds to it, so fewer tokens mean it did not inherit all of it. Aborted and failed calls are skipped: they are
 *  logged with 0 prompt tokens. */
function shortInheritance(events: Event[], fork: Extract<Event, { kind: "fork" }>): string[] {
  const rootCall = events.find((e) => e.kind === "model_call" && e.agent === fork.agent && e.call === fork.call);
  if (rootCall?.kind !== "model_call") return [];
  return fork.children.filter((child) => {
    const first = events.find((e) => e.kind === "model_call" && e.agent === child && e.stopReason !== "aborted" && e.stopReason !== "error");
    return first?.kind === "model_call" && first.tokensIn < rootCall.tokensIn;
  });
}

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
  const forkAt = events.findIndex((e) => e.kind === "fork");
  const fork = forkAt >= 0 ? events[forkAt] : undefined;
  const norm = fork?.kind === "fork" ? fork.directions.map((d) => d.trim().toLowerCase()) : [];
  const pool = events.find((e) => e.kind === "run_started");
  // told to fork before FORK_AT of the pool was charged: the model calls logged before the first fork instruction
  let instructedEarly: boolean | null = null;
  if (pool?.kind === "run_started") {
    let charged = 0;
    for (const e of events) {
      if (e.kind === "model_call") charged += e.tokensIn + e.tokensOut;
      else if (e.kind === "runtime_note" && e.text === forkInstruction()) {
        instructedEarly = charged < FORK_AT * pool.pool;
        break;
      }
    }
  }
  const forkInfo = fork?.kind === "fork"
    ? {
        forked: true, forkFallback: fork.fallback, directionsDistinct: !fork.fallback && new Set(norm).size === norm.length,
        // positions in the run's ordered log, not timestamps: several events can share a millisecond
        tokensBeforeFork: events.reduce((n, e, i) => (e.kind === "model_call" && i < forkAt ? n + e.tokensIn + e.tokensOut : n), 0),
        directions: fork.directions, maxDirectionJaccard: maxPairwiseJaccard(fork.directions), instructedEarly,
        shortInheritance: shortInheritance(events, fork),
      }
    : { forked: false, forkFallback: false, directionsDistinct: false, tokensBeforeFork: null, directions: null, maxDirectionJaccard: null, instructedEarly, shortInheritance: [] };
  return {
    ...forkInfo,
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

const isForkCondition = (o: Outcome) => o.cell.condition === "fork" || o.cell.condition === "fork-silent";

const cut = (d: string, n = 300) => {
  const one = d.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** The `## Fork` section (phase 2): empty when no fork-condition run finished. */
function forkSection(outcomes: Outcome[]): string[] {
  const fork = outcomes.filter(isForkCondition);
  if (fork.length === 0) return [];
  const lines = ["", "## Fork", "",
    "Per suite and condition, over finished runs. \"Ended before the fork\" is a fork-condition run with no fork event. \"Distinct directions\": the three directions differ pairwise after trim and lowercase; fallback forks count as not distinct, because their three generic directions are identical. That is a floor: the fork tool already rejects exact duplicates, so it cannot show whether the directions are genuinely different. Read them below. Tokens before the fork: the root's model calls up to the fork event (median over forked runs).", "",
    "| suite | condition | runs | forked | fallback forks | ended before the fork | distinct directions | median tokens before the fork |", "|---|---|---|---|---|---|---|---|"];
  const groups = new Map<string, Outcome[]>();
  for (const o of fork) groups.set(`${o.cell.suite}|${o.cell.condition}`, [...(groups.get(`${o.cell.suite}|${o.cell.condition}`) ?? []), o]);
  for (const [key, os] of groups) {
    const [suite, condition] = key.split("|");
    const forked = os.filter((o) => o.forked);
    lines.push(`| ${suite} | ${condition} | ${os.length} | ${forked.length} | ${forked.filter((o) => o.forkFallback).length} | ${os.length - forked.length} | ${os.filter((o) => o.directionsDistinct).length} | ${forked.length ? Math.round(median(forked.map((o) => o.tokensBeforeFork ?? 0))) : "–"} |`);
  }
  lines.push("", "Timing and inheritance. \"Instructed before 10% of the pool\": the root was told to fork when fewer than 10% of the pool's tokens had been charged (the first turn without a tool call triggers the instruction early; planned, Review Focus 1). \"Near-duplicate\": the maximum pairwise word-Jaccard over a run's three directions (lowercased, split on non-letters and non-digits, stopwords kept; 1.00 = identical word sets), median over forked runs; descriptive, with no threshold. \"Short inheritance\": copies whose first model call has fewer prompt tokens than the root's call that made the fork call.", "",
    "| suite | condition | instructed to fork | instructed before 10% of the pool | median near-duplicate (max word-Jaccard) | copies with short inheritance |", "|---|---|---|---|---|---|");
  for (const [key, os] of groups) {
    const [suite, condition] = key.split("|");
    const told = os.filter((o) => o.instructedEarly !== null);
    const forked = os.filter((o) => o.forked);
    const flagged = os.filter((o) => o.shortInheritance.length > 0);
    lines.push(`| ${suite} | ${condition} | ${told.length} | ${told.filter((o) => o.instructedEarly).length} | ${forked.length ? median(forked.map((o) => o.maxDirectionJaccard ?? 0)).toFixed(2) : "–"} | ${flagged.reduce((n, o) => n + o.shortInheritance.length, 0)}${flagged.length ? ` (${flagged.map((o) => `${o.runId}: ${o.shortInheritance.join(", ")}`).join("; ")})` : ""} |`);
  }
  const forked = fork.filter((o) => o.forked && o.directions);
  lines.push("", "### Directions", "", forked.length ? "Go/no-go: are the three directions of a run genuinely different from each other? Each is cut at 300 characters." : "No fork yet.");
  for (const o of forked) {
    lines.push("", `- ${o.runId} (${o.cell.suite}, ${o.cell.condition}${o.forkFallback ? ", fallback" : ""}; max word-Jaccard ${(o.maxDirectionJaccard ?? 0).toFixed(2)})`,
      ...o.directions!.map((d, i) => `  ${i + 1}. ${cut(d)}`));
  }
  const measured = fork.filter((o) => o.reason !== "infra_error");
  const infra = fork.length - measured.length;
  const fallbacks = measured.filter((o) => o.forkFallback).length;
  const rate = measured.length ? fallbacks / measured.length : 0;
  const tail = `${fallbacks} of ${measured.length} fork-condition runs${infra ? ` (${infra} infra_error run${infra === 1 ? "" : "s"} left out of the denominator)` : ""}`;
  lines.push("", rate > 0.2 ? `Fallback rate above 20%: STOP (spec §4.7) — ${tail}, ${Math.round(100 * rate)}%` : `Fallback rate: ok — ${tail}`);
  return lines;
}

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
  lines.push(...forkSection(outcomes));
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
