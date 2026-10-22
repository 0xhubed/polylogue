import type { Event, EventInput, RunEndReason } from "@polylogue/schema";
import { AgentLoop } from "../agent/agent-loop.ts";
import { realClock, type Clock } from "../clock.ts";
import { Blackboard } from "../comm/blackboard.ts";
import { Bus } from "../comm/bus.ts";
import { CONDITIONS, systemPrompt, type Condition } from "../conditions.ts";
import { configHash, type RunConfig } from "../config.ts";
import { Controller } from "../control/controller.ts";
import type { EventLog } from "../log/event-log.ts";
import { checkServer, makeModelRuntime, samplingRecord } from "../model/provider.ts";
import { buildTools } from "../tools/build-tools.ts";
import { loadTask, type LoadedTask } from "../suites/registry.ts";
import type { ToyTask } from "../toy/vault.ts";
import type { RunContext } from "./context.ts";

export interface RunSummary {
  runId: string;
  reason: RunEndReason;
  solved: boolean;
  totalTokens: number;
  wallMs: number;
}

export interface RunDeps {
  log: EventLog;
  clock?: Clock;
  gitSha?: string | null;
  tasks?: Record<string, ToyTask>;
}

const HARD_STOP: ReadonlySet<RunEndReason> = new Set(["solved", "wrong_claim", "killed", "infra_error"]);

export async function runOnce(cfg: RunConfig, deps: RunDeps): Promise<RunSummary> {
  const clock = deps.clock ?? realClock;
  const cond = CONDITIONS[cfg.condition];
  const task = loadTask(cfg.suite, cfg.taskId, { dataDir: cfg.dataDir, toolDelayMs: cfg.toolDelayMs, toyTasks: deps.tasks });
  try {
    if (cfg.checkServer) await checkServer(cfg.model);
    return await runLoaded(cfg, deps, task, clock, cond);
  } finally {
    task.close();
  }
}

async function runLoaded(cfg: RunConfig, deps: RunDeps, task: LoadedTask, clock: Clock, cond: Condition): Promise<RunSummary> {
  const runId = cfg.runId ?? `${cfg.condition}-${cfg.taskId}-s${cfg.seed}-${Date.now().toString(36)}`;
  const pool = cfg.budget.tokensPerAgent * cond.n;
  deps.log.createRun({
    id: runId, condition: cfg.condition, n: cond.n, taskId: cfg.taskId, seed: cfg.seed, model: cfg.model.id,
    revision: cfg.model.revision, sampling: samplingRecord(cfg.model), configHash: configHash(cfg),
    gitSha: deps.gitSha ?? null, startedAt: new Date().toISOString(),
  });
  const t0 = clock.now();
  const log = (e: EventInput) => {
    deps.log.append(runId, { ...e, t: Math.max(0, Math.round(clock.now() - t0)) } as Event);
  };

  const ids = Array.from({ length: cond.n }, (_, i) => `a${i + 1}`);
  const controller = new Controller(
    { pool, wallClockMs: cfg.wallClockMs, messagesPerMinute: cfg.rate.messagesPerMinute, maxMessageChars: cfg.rate.maxMessageChars, contextWindow: cfg.model.contextWindow, firstClaimEnds: cond.firstClaimEnds },
    { log, clock, verify: (a) => task.verify(a) },
  );
  const bus = new Bus(log);
  const board = new Blackboard(log);
  const loops: AgentLoop[] = [];
  const byId = (id: string) => loops.find((l) => l.id === id)!;
  const ctx: RunContext = { log, controller, bus, board, dir: { ids: () => ids, status: (id) => byId(id).status, phase: (id) => byId(id).phase } };
  const runtime = makeModelRuntime(cfg.model);

  log({ kind: "run_started", condition: cfg.condition, n: cond.n, taskId: task.id, task: task.prompt, pool, wallClockMs: cfg.wallClockMs, config: cfg, taskFingerprint: task.fingerprint });
  ids.forEach((id, index) => {
    const seed = cfg.seed * 100 + index;
    const prompt = systemPrompt(cond, id, ids);
    const tools = buildTools(cond, id, ctx, task.tools);
    log({ kind: "agent_started", agent: id, index, seed, systemPrompt: prompt, tools: tools.map((t) => t.name) });
    const loop = new AgentLoop({ id, systemPrompt: prompt, tools, runtime, seed, canBeWoken: cond.messaging, ctx, clock });
    loops.push(loop);
    bus.add(loop);
    controller.register(loop);
  });

  controller.start();
  for (const l of loops) void l.start(task.prompt);
  const reason = await controller.done;
  if (HARD_STOP.has(reason)) await Promise.all(loops.map((l) => l.stop()));
  else await settleByDeadline(loops, clock, t0 + cfg.wallClockMs);
  for (const l of loops) l.finishOnRunEnd();

  const wallMs = Math.max(0, Math.round(clock.now() - t0));
  const solved = reason === "solved";
  const detail = controller.endDetail;
  log({ kind: "run_finished", reason, solved, wallMs, totalTokens: controller.used, ...(detail !== undefined ? { detail } : {}) });
  deps.log.finishRun(runId, solved ? "solved" : reason === "infra_error" ? "infra_error" : "unsolved", reason, new Date().toISOString());
  return { runId, reason, solved, totalTokens: controller.used, wallMs };
}

/**
 * budget and all_idle let in-flight calls finish, but not past the run's wall-clock deadline:
 * pi's timeout bounds only the time to response headers, so a stalled stream would hang the run.
 */
async function settleByDeadline(loops: AgentLoop[], clock: Clock, deadline: number): Promise<void> {
  let cancel = () => {};
  const late = new Promise<"late">((r) => {
    cancel = clock.setTimer(() => r("late"), Math.max(0, deadline - clock.now()));
  });
  const settled = Promise.all(loops.map((l) => l.settled())).then(() => "settled" as const);
  const first = await Promise.race([settled, late]);
  cancel();
  if (first === "late") await Promise.all(loops.map((l) => l.stop()));
}
