import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Event, EventInput, RunEndReason } from "@polylogue/schema";
import { AgentLoop, type AgentLoopOptions } from "../agent/agent-loop.ts";
import { realClock, type Clock } from "../clock.ts";
import { Blackboard } from "../comm/blackboard.ts";
import { Bus } from "../comm/bus.ts";
import { CONDITIONS, rootPromptAfterFork, systemPrompt, type Condition } from "../conditions.ts";
import { configHash, type RunConfig } from "../config.ts";
import { Controller } from "../control/controller.ts";
import type { EventLog } from "../log/event-log.ts";
import { checkServer, makeModelRuntime, samplingRecord } from "../model/provider.ts";
import { childForkResult, directionMessage } from "../fork/texts.ts";
import { buildForkTools, buildTools } from "../tools/build-tools.ts";
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
  /** The agents that exist: all of them from the start, or in a fork run the root until it has forked. */
  const loops: AgentLoop[] = [];
  const byId = (id: string) => loops.find((l) => l.id === id)!;
  const ctx: RunContext = { log, controller, bus, board, dir: { ids: () => loops.map((l) => l.id), status: (id) => byId(id).status, phase: (id) => byId(id).phase } };
  const runtime = makeModelRuntime(cfg.model);

  log({ kind: "run_started", condition: cfg.condition, n: cond.n, taskId: task.id, task: task.prompt, pool, wallClockMs: cfg.wallClockMs, config: cfg, taskFingerprint: task.fingerprint });
  const seedOf = (id: string) => cfg.seed * 100 + ids.indexOf(id);
  const logStarted = (id: string, tools: AgentTool<any>[]) =>
    log({ kind: "agent_started", agent: id, index: ids.indexOf(id), seed: seedOf(id), systemPrompt: systemPrompt(cond, id, ids), tools: tools.map((t) => t.name) });
  /** Constructs a loop and registers it with the bus and the controller; it is started by the caller. */
  const addLoop = (id: string, tools: AgentTool<any>[], more: Partial<AgentLoopOptions> = {}): AgentLoop => {
    const loop = new AgentLoop({ id, systemPrompt: systemPrompt(cond, id, ids), tools, runtime, seed: seedOf(id), canBeWoken: cond.messaging, ctx, clock, ...more });
    loops.push(loop);
    bus.add(loop);
    controller.register(loop);
    return loop;
  };

  if (cond.fork) {
    const rootId = ids[0]!;
    const beforeFork = buildForkTools(cond, rootId, ctx, task.tools, "root-before");
    logStarted(rootId, beforeFork);
    const root = addLoop(rootId, beforeFork, {
      root: { tools: { beforeFork, afterFork: buildForkTools(cond, rootId, ctx, task.tools, "after") }, promptAfterFork: rootPromptAfterFork(cond, ids) },
    });
    let forked = false;
    /** Grows the team from the root's transcript (spec §4.4). Does nothing once the run has ended, so no copy exists or calls after the end. */
    const grow = (children: string[], directions: string[], fallback: boolean, call: number, forkCallId: string | undefined) => {
      if (controller.ended) return;
      const history = root.messages();
      const inherited = root.lastCallTokenCount;
      const tools = children.map((id) => buildForkTools(cond, id, ctx, task.tools, "after"));
      children.forEach((id, i) => logStarted(id, tools[i]!));
      log({ kind: "fork", agent: rootId, call, children, directions, fallback });
      // All three are registered with the bus and the controller before any starts, so a message to a sibling that has not called yet is kept.
      const copies = children.map((id, i) => addLoop(id, tools[i]!, { initialMessages: copyHistory(history, forkCallId, id, directions[i]!, clock.now()), initialCallTokens: inherited }));
      for (const c of copies) void c.resume();
      root.afterFork();
    };
    ctx.forked = () => forked;
    ctx.fork = (parent, directions, o) => {
      if (controller.ended) return [];
      if (forked) throw new Error("You have already forked.");
      if (parent !== rootId) throw new Error(`agent ${parent} is not the fork root`);
      forked = true;
      const children = ids.slice(1);
      const call = root.callCount - 1;
      if (o.fallback) {
        // Made at the root's turn boundary, so its last turn is complete.
        grow(children, directions, true, call, undefined);
      } else {
        // Made by the fork tool, inside the root's turn. The copies are made once the turn's other tool calls have run too, so they
        // inherit every result of that turn (Review Focus 2); the fork call's own result is replaced by the copy's.
        const forkCallId = unansweredForkCall(root.messages());
        root.atTurnEnd(() => grow(children, directions, false, call, forkCallId));
      }
      return children;
    };
  } else {
    for (const id of ids) {
      const tools = buildTools(cond, id, ctx, task.tools);
      logStarted(id, tools);
      addLoop(id, tools);
    }
  }

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

/** The id of the fork call that is running: the first fork call of the last assistant message that has no result yet. */
function unansweredForkCall(messages: AgentMessage[]): string | undefined {
  const turn = messages.findLastIndex((m) => m.role === "assistant");
  const m = messages[turn] as { content: { type: string; id?: string; name?: string }[] } | undefined;
  if (!m) return undefined;
  const answered = new Set(messages.slice(turn + 1).flatMap((r) => (r.role === "toolResult" ? [r.toolCallId] : [])));
  return m.content.find((b) => b.type === "toolCall" && b.name === "fork" && !answered.has(b.id ?? ""))?.id;
}

/**
 * A copy's starting transcript: the root's, with the copy's own result for the fork call (the root's says "Forked. Three copies…"),
 * then its direction as a user message. On a fallback there is no fork call to answer.
 */
function copyHistory(messages: AgentMessage[], forkCallId: string | undefined, childId: string, direction: string, now: number): AgentMessage[] {
  let answered = false;
  const out = messages.map((m) => {
    if (forkCallId === undefined || m.role !== "toolResult" || m.toolCallId !== forkCallId) return m;
    answered = true;
    return { ...m, content: [{ type: "text", text: childForkResult(childId) }], details: {}, isError: false } as AgentMessage;
  });
  // The copies are made at the end of the fork turn, when the fork call has its result; a missing one is a programming error.
  if (forkCallId !== undefined && !answered) throw new Error(`fork call ${forkCallId} has no result in the root's transcript`);
  out.push({ role: "user", content: directionMessage(direction), timestamp: now } as AgentMessage);
  return out;
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
