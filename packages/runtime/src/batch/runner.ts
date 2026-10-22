import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson, type RunConfig, type SuiteId } from "../config.ts";
import type { EventLog } from "../log/event-log.ts";
import { runOnce, type RunDeps, type RunSummary } from "../run/run.ts";
import { pythonSandboxReady, sweepSandboxContainers } from "../suites/python-tool.ts";
import { listTasks, taskIdentity, type TaskIdentity } from "../suites/registry.ts";
import { expandMatrix, shuffle, toRunConfig, type Cell, type Matrix } from "./matrix.ts";

export interface BatchDeps {
  log: EventLog;
  list?: (suite: SuiteId, split: "pilot" | "scored") => string[];
  run?: (cfg: RunConfig, deps: RunDeps) => Promise<RunSummary>;
  gitSha?: string | null;
  sandboxReady?: () => Promise<boolean>;
  /** Removes leftover sandbox containers of a crashed batch; called once before the first run of a batch with math cells. */
  sweep?: () => Promise<number>;
  onRun?: (line: string) => void;
  /** Checked before a worker takes its next job; when true the batch drains (in-flight runs finish) and returns. */
  shouldStop?: () => boolean;
  /** Holds <suite>/frozen.json (default: the repo's suites/). Once a suite has one, its scored cells must match it. */
  frozenDir?: string;
  identity?: (suite: SuiteId, taskId: string) => TaskIdentity;
}

const REPO_SUITES = fileURLToPath(new URL("../../../../suites/", import.meta.url));

interface FrozenTask {
  id: string;
  split: string;
  task_sha256?: string;
  corpus_sha256?: string;
}

/** Refuses a batch whose scored tasks differ from the committed freeze: the main run must provably use the frozen data. */
function checkFrozen(m: Matrix, list: (suite: SuiteId, split: "pilot" | "scored") => string[], frozenDir: string, identity: (suite: SuiteId, taskId: string) => TaskIdentity): void {
  for (const s of m.suites) {
    if (s.split !== "scored") continue;
    const path = join(frozenDir, s.suite, "frozen.json");
    if (!existsSync(path)) continue;
    const frozen = new Map((JSON.parse(readFileSync(path, "utf8")) as { tasks: FrozenTask[] }).tasks.map((t) => [t.id, t]));
    for (const taskId of s.tasks ?? list(s.suite, "scored")) {
      const want = frozen.get(taskId);
      if (!want || want.split !== "scored") throw new Error(`Task "${taskId}" of suite "${s.suite}" is not a scored task in ${path}; refusing to start.`);
      const got = identity(s.suite, taskId);
      if (got.fingerprint !== want.task_sha256) {
        throw new Error(`Task "${taskId}" of suite "${s.suite}" differs from ${path} (its prompt, answer, aliases or match changed since the freeze); refusing to start.`);
      }
      if (want.corpus_sha256 !== undefined && got.corpusSha256 !== want.corpus_sha256) {
        throw new Error(`Task "${taskId}" of suite "${s.suite}": its corpus file differs from ${path}; refusing to start.`);
      }
    }
  }
}
export interface BatchResult {
  ran: string[];
  skipped: string[];
  closed: string[];
  failedTwice: string[];
  /** Run ids still queued when the batch stopped (graceful stop, or every worker died). */
  notStarted: string[];
  /** Servers whose worker stopped because `run` threw. */
  deadServers: { server: string; error: string }[];
}

/** Thrown when a batch cannot finish its queue; `result` holds what happened before. */
export class BatchError extends Error {
  constructor(message: string, readonly result: BatchResult) {
    super(message);
  }
}

/** Closes a run row left `running` by a crash. With no run_finished event it appends one (infra_error); otherwise the row takes its status from that event. */
export function closeStale(log: EventLog, runId: string): void {
  const events = log.events(runId).map((s) => s.event);
  let finished = events.find((e) => e.kind === "run_finished");
  if (!finished) {
    const tokens = events.reduce((n, e) => n + (e.kind === "model_call" ? e.tokensIn + e.tokensOut : 0), 0);
    const wallMs = events.at(-1)?.t ?? 0;
    log.append(runId, { kind: "run_finished", t: wallMs, reason: "infra_error", solved: false, wallMs, totalTokens: tokens, detail: "interrupted; closed when the batch resumed" });
    finished = { kind: "run_finished", t: wallMs, reason: "infra_error", solved: false, wallMs, totalTokens: tokens };
  }
  const reason = finished.reason;
  const status = reason === "solved" ? "solved" : reason === "infra_error" ? "infra_error" : "unsolved";
  log.finishRun(runId, status, reason, new Date().toISOString());
}

/** A config as compared on resume: without where the run's data lives, its id and its server. */
function comparable(cfg: unknown): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(cfg ?? {})) as Record<string, unknown> & { model?: Record<string, unknown> };
  delete c.runId;
  delete c.dataDir;
  if (c.model && typeof c.model === "object") delete c.model.baseUrl;
  return c;
}

/** The first key path (e.g. "budget.tokensPerAgent") where two JSON values differ, or null. */
function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
      const d = firstDifference(x[k], y[k], path ? `${path}.${k}` : k);
      if (d !== null) return d;
    }
    return null;
  }
  return stableJson(a) === stableJson(b) ? null : path || "(the whole config)";
}

/** Refuses to resume a cell whose finished run was made with another config: one cell's runs must not mix configurations. */
function checkResumable(log: EventLog, cell: Cell, runId: string, expected: RunConfig): void {
  const started = log.firstOfKind(runId, "run_started");
  if (!started || started.config === undefined) return; // closed before it started, or a run without a recorded config
  const diff = firstDifference(comparable(started.config), comparable(expected));
  if (diff !== null) {
    throw new Error(`Cell ${cell.id}: run ${runId} was made with a different config (first difference: ${diff}). Resuming would mix configurations; restore the matrix or use a new --db.`);
  }
}

export async function runBatch(m: Matrix, deps: BatchDeps): Promise<BatchResult> {
  const list = deps.list ?? ((suite, split) => listTasks(suite, split, m.dataDir));
  const run = deps.run ?? runOnce;
  checkFrozen(m, list, deps.frozenDir ?? REPO_SUITES, deps.identity ?? ((suite, taskId) => taskIdentity(suite, taskId, m.dataDir)));
  const cells = shuffle(expandMatrix(m, list), m.orderSeed);
  if (cells.some((c) => c.suite === "math")) {
    if (!(await (deps.sandboxReady ?? pythonSandboxReady)())) {
      throw new Error("This batch has math tasks, but the Python sandbox is not ready: start Docker and run `npm run sandbox:build`.");
    }
    const removed = await (deps.sweep ?? sweepSandboxContainers)();
    if (removed > 0) deps.onRun?.(`removed ${removed} leftover sandbox containers`);
  }
  const result: BatchResult = { ran: [], skipped: [], closed: [], failedTwice: [], notStarted: [], deadServers: [] };
  const queue: { cell: Cell; runId: string; rerun: boolean }[] = [];
  for (const cell of cells) {
    const base = cell.id;
    const re = `${cell.id}-r1`;
    for (const id of [base, re]) {
      if (deps.log.run(id)?.status === "running") {
        closeStale(deps.log, id);
        result.closed.push(id);
      }
    }
    const b = deps.log.run(base);
    const r = deps.log.run(re);
    for (const row of [b, r]) if (row) checkResumable(deps.log, cell, row.id, toRunConfig(m, cell, m.servers[0]!, row.id));
    if (!b) queue.push({ cell, runId: base, rerun: false });
    else if (b.status !== "infra_error") result.skipped.push(base);
    else if (!r) queue.push({ cell, runId: re, rerun: true });
    else {
      result.skipped.push(re);
      if (r.status === "infra_error") result.failedTwice.push(cell.id);
    }
  }

  /** After an infra_error: queue the one rerun, or count a second failure. */
  const afterInfraError = (job: { cell: Cell; rerun: boolean }) => {
    if (job.rerun) result.failedTwice.push(job.cell.id);
    else queue.push({ cell: job.cell, runId: `${job.cell.id}-r1`, rerun: true });
  };

  const errors: Error[] = [];
  const worker = async (server: string) => {
    for (;;) {
      if (deps.shouldStop?.()) return;
      const job = queue.shift();
      if (!job) return;
      let summary: RunSummary;
      try {
        summary = await run(toRunConfig(m, job.cell, server, job.runId), { log: deps.log, gitSha: deps.gitSha ?? null });
      } catch (err) {
        const message = (err as Error).message;
        errors.push(err as Error);
        result.deadServers.push({ server, error: message });
        deps.onRun?.(`server ${server} stopped: ${message}`);
        const row = deps.log.run(job.runId);
        if (!row) {
          queue.unshift(job);
        } else {
          // the run threw after it had started: do not reuse its id
          if (row.status === "running") {
            closeStale(deps.log, job.runId);
            result.closed.push(job.runId);
          }
          if (deps.log.run(job.runId)!.status === "infra_error") afterInfraError(job);
        }
        return;
      }
      result.ran.push(job.runId);
      deps.onRun?.(`${job.runId} on ${server}: ${summary.reason} (${summary.totalTokens} tokens, ${Math.round(summary.wallMs / 1000)} s)`);
      if (summary.reason === "infra_error") afterInfraError(job);
    }
  };
  await Promise.all(m.servers.map(worker));
  result.notStarted = queue.map((j) => j.runId);
  if (queue.length > 0 && !deps.shouldStop?.()) {
    throw new BatchError(`Batch stopped with ${queue.length} runs left: ${errors[0]?.message ?? "unknown error"}`, result);
  }
  return result;
}
