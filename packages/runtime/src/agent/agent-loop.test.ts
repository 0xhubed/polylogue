import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event, EventInput } from "@polylogue/schema";
import { AgentLoop } from "./agent-loop.ts";
import { contextBeforeCall, normalizeOpenAIMessages } from "./context.ts";
import { estimatePromptTokens } from "./estimate.ts";
import { makeModelRuntime } from "../model/provider.ts";
import { startFakeOpenAI, testModelConfig, type FakeServer, type Policy } from "../testing/fake-openai.ts";
import { Controller } from "../control/controller.ts";
import { Bus } from "../comm/bus.ts";
import { Blackboard } from "../comm/blackboard.ts";
import { CONDITIONS, rootPromptAfterFork, systemPrompt } from "../conditions.ts";
import { GENERIC_DIRECTION, fallbackNotice, forkInstruction } from "../fork/texts.ts";
import { claimTool } from "../tools/claim-tool.ts";
import { toAgentTool } from "../tools/work-tool.ts";
import { buildTools } from "../tools/build-tools.ts";
import { VAULT, readShardTool } from "../toy/vault.ts";
import { realClock } from "../clock.ts";
import type { RunContext } from "../run/context.ts";
import type { ConditionName } from "@polylogue/schema";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** Builds N loops wired like a run, without the run orchestrator (Task 7). */
async function team(policy: Policy, condition: ConditionName, opts: { toolDelayMs?: number; pool?: number; contextWindow?: number; logThrowsOn?: string } = {}) {
  fake = await startFakeOpenAI(policy);
  const cond = CONDITIONS[condition];
  const events: Event[] = [];
  const t0 = Date.now();
  const log = (e: EventInput) => {
    if (e.kind === opts.logThrowsOn) throw new Error(`log failed on ${e.kind}`);
    events.push({ ...e, t: Date.now() - t0 } as Event);
  };
  const ids = Array.from({ length: cond.n }, (_, i) => `a${i + 1}`);
  const runtime = makeModelRuntime(testModelConfig(fake.baseUrl, { contextWindow: opts.contextWindow ?? 262144, maxTokens: 100 }));
  const controller = new Controller({ pool: opts.pool ?? 1e9, wallClockMs: 60_000, messagesPerMinute: 30, maxMessageChars: 2000, contextWindow: opts.contextWindow ?? 262144 }, { log, clock: realClock, verify: VAULT.verify });
  const bus = new Bus(log);
  const board = new Blackboard(log);
  const loops: AgentLoop[] = [];
  const ctx: RunContext = {
    log, controller, bus, board,
    dir: { ids: () => ids, status: (id) => loops.find((l) => l.id === id)!.status, phase: (id) => loops.find((l) => l.id === id)!.phase },
  };
  log({ kind: "run_started", condition, n: cond.n, taskId: VAULT.id, task: VAULT.prompt, pool: opts.pool ?? 1e9, wallClockMs: 60_000 });
  ids.forEach((id, i) => {
    const prompt = systemPrompt(cond, id, ids);
    const tools = buildTools(cond, id, ctx, [readShardTool(VAULT, opts.toolDelayMs ?? 0)]);
    log({ kind: "agent_started", agent: id, index: i, seed: 700 + i, systemPrompt: prompt, tools: tools.map((t) => t.name) });
    const loop = new AgentLoop({ id, systemPrompt: prompt, tools, runtime, seed: 700 + i, canBeWoken: cond.messaging, ctx, clock: realClock });
    loops.push(loop);
    bus.add(loop);
    controller.register(loop);
  });
  return { events, loops, controller, bus, fake: fake! };
}

const kinds = (events: Event[], agent?: string) => events.filter((e) => !agent || ("agent" in e && e.agent === agent)).map((e) => e.kind);

describe("estimatePromptTokens", () => {
  it("counts characters after the last assistant message, plus the last call and the answer budget", () => {
    const msgs = [
      { role: "user", content: "x".repeat(30), timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 0, output: 0 }, stopReason: "stop", timestamp: 0 },
      { role: "user", content: "y".repeat(9), timestamp: 0 },
    ] as never;
    expect(estimatePromptTokens(msgs, 500, 100)).toBe(500 + 3 + 100);
  });
});

describe("AgentLoop", () => {
  it("delivers a message that arrives during a slow tool after the tool result, urgent first, as one block", async () => {
    const { events, loops, fake } = await team(({ agentIndex, call }) => {
      if (agentIndex === 0) return call === 0 ? { toolCalls: [{ name: "read_shard", args: { shard: 1 } }] } : { content: "thanks" };
      if (call === 0) return { toolCalls: [{ name: "send", args: { to: "a1", text: "digit 3 is 1" } }, { name: "publish", args: { topic: "all", text: "urgent: digit 2 is 7", urgent: true } }] };
      return { content: "done" };
    }, "polylogue", { toolDelayMs: 300 });
    const a1 = loops[0]!.start(VAULT.prompt);
    await new Promise((r) => setTimeout(r, 50));
    await loops[1]!.start(VAULT.prompt);
    await a1;
    const a1Requests = fake.requests.filter((r) => r.agentIndex === 0);
    const second = normalizeOpenAIMessages(a1Requests[1]!.body.messages);
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(second.at(-1)!.text).toBe("[URGENT from a2 on #all] urgent: digit 2 is 7\n[from a2] digit 3 is 1");
    const a1Kinds = kinds(events, "a1");
    expect(a1Kinds.indexOf("message_delivered")).toBeGreaterThan(a1Kinds.indexOf("tool_result"));
    expect(events.filter((e) => e.kind === "message_delivered" && e.agent === "a1").map((e) => (e as { delivery: number }).delivery)).toEqual([0, 0]);
  });

  it("wakes an idle agent on a direct message and on a subscribed topic, not on other topics", async () => {
    const { events, loops } = await team(({ agentIndex, call }) => {
      if (agentIndex === 0) return call === 0 ? { toolCalls: [{ name: "subscribe", args: { topic: "math" } }] } : { content: "waiting" };
      return { content: "idle" };
    }, "polylogue");
    await loops[0]!.start(VAULT.prompt);
    expect(loops[0]!.phase).toBe("idle");
    const bus = (loops[0] as unknown as { o: { ctx: RunContext } }).o.ctx.bus;
    bus.post("a2", { topic: "frontend" }, "not for you", false);
    expect(loops[0]!.phase).toBe("idle");
    bus.post("a2", { topic: "math" }, "for you", false);
    expect(loops[0]!.phase).toBe("working");
    await loops[0]!.settled();
    bus.post("a3", "a1", "direct", false);
    await loops[0]!.settled();
    expect(events.filter((e) => e.kind === "wake" && e.agent === "a1")).toHaveLength(2);
  });

  it("a message after the run has ended does not wake an idle agent", async () => {
    const { events, loops, controller, bus, fake } = await team(() => ({ content: "waiting" }), "polylogue");
    await loops[0]!.start(VAULT.prompt);
    expect(loops[0]!.phase).toBe("idle");
    controller.end("solved");
    bus.post("a2", "a1", "too late", false);
    await loops[0]!.settled();
    expect(loops[0]!.phase).toBe("idle");
    expect(kinds(events, "a1")).not.toContain("wake");
    expect(kinds(events)).not.toContain("message_delivered");
    expect(fake.requests).toHaveLength(1);
  });

  it("a message pending when the run ends is not delivered", async () => {
    const { events, loops, controller, bus } = await team(({ call }) => (call === 0 ? { toolCalls: [{ name: "read_shard", args: { shard: 1 } }] } : { content: "done" }), "polylogue", { toolDelayMs: 300 });
    const a1 = loops[0]!.start(VAULT.prompt);
    await new Promise((r) => setTimeout(r, 100));
    bus.post("a2", "a1", "pending at the end", false);
    controller.end("budget");
    await a1;
    expect(kinds(events)).not.toContain("message_delivered");
  });

  it("a drive that fails ends the run as infra_error and settles instead of rejecting", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { loops, controller } = await team(() => ({ content: "done" }), "single", { logThrowsOn: "idle" });
      await expect(loops[0]!.start(VAULT.prompt)).resolves.toBeUndefined();
      expect(await controller.done).toBe("infra_error");
      await expect(loops[0]!.settled()).resolves.toBeUndefined();
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]!.join(" "))).toContain("log failed on idle");
    } finally {
      err.mockRestore();
    }
  });

  it("an idle agent is finished where nothing can wake it", async () => {
    const { events, loops } = await team(() => ({ content: "I give up" }), "isolated");
    await loops[0]!.start(VAULT.prompt);
    expect(loops[0]!.phase).toBe("finished");
    expect(events.filter((e) => e.kind === "agent_finished")).toEqual([expect.objectContaining({ agent: "a1", reason: "idle" })]);
  });

  it("ends the agent after a claim, blind to the result", async () => {
    const { events, loops, fake } = await team(({ call }) => (call === 0 ? { toolCalls: [{ name: "claim", args: { answer: "1111", evidence: "guess" } }] } : { content: "should not happen" }), "single");
    await loops[0]!.start(VAULT.prompt);
    expect(fake.requests).toHaveLength(1);
    expect(events.find((e) => e.kind === "tool_result")).toMatchObject({ tool: "claim", isError: false, text: "Claim submitted." });
    expect(events.find((e) => e.kind === "agent_finished")).toMatchObject({ reason: "claimed" });
  });

  it("logs an unknown tool as an error result and keeps going", async () => {
    const { events, loops, fake } = await team(({ call }) => (call === 0 ? { toolCalls: [{ name: "teleport", args: { where: "vault" } }] } : { content: "ok" }), "single");
    await loops[0]!.start(VAULT.prompt);
    expect(fake.requests).toHaveLength(2);
    const last = normalizeOpenAIMessages(fake.requests[1]!.body.messages).at(-1)!;
    expect(last.role).toBe("tool");
    expect(last.toolCallId).toBe("call_0_0_0");
    expect(last.text).toBe("Tool teleport not found");
    expect(events.find((e) => e.kind === "tool_result")).toMatchObject({ tool: "teleport", isError: true, text: "Tool teleport not found" });
  });

  it("logs a known tool with malformed arguments as an error result and keeps going", async () => {
    const { events, loops, fake } = await team(({ call }) => (call === 0 ? { toolCalls: [{ name: "read_shard", args: { shard: "one" } }] } : { content: "ok" }), "single");
    await loops[0]!.start(VAULT.prompt);
    expect(fake.requests).toHaveLength(2);
    const result = events.find((e) => e.kind === "tool_result");
    expect(result).toMatchObject({ tool: "read_shard", isError: true });
    const text = (result as { text: string }).text;
    expect(text).toMatch(/\S/);
    const last = normalizeOpenAIMessages(fake.requests[1]!.body.messages).at(-1)!;
    expect(last).toMatchObject({ role: "tool", toolCallId: "call_0_0_0", text });
    expect(events.find((e) => e.kind === "agent_finished")).toMatchObject({ reason: "idle" });
  });

  it("refuses a call over the context window, sends no request and finishes with context", async () => {
    const { events, loops, fake } = await team(() => ({ content: "x" }), "single", { contextWindow: 50 });
    await loops[0]!.start(VAULT.prompt);
    expect(fake.requests).toHaveLength(0);
    expect(events.filter((e) => e.kind === "model_call")).toHaveLength(0);
    expect(events.find((e) => e.kind === "agent_finished")).toMatchObject({ reason: "context" });
  });

  it("asks for the full maxTokens when the pool has room, and no more than the pool has left after the prompt when it does not", async () => {
    const roomy = await team(() => ({ content: "x" }), "single");
    let prompt = 0;
    const admit = roomy.controller.admitCall.bind(roomy.controller);
    roomy.controller.admitCall = (estimate: number, p: number, max: number) => ((prompt = p), admit(estimate, p, max));
    await roomy.loops[0]!.start(VAULT.prompt);
    expect(roomy.fake.requests[0]!.body.max_completion_tokens).toBe(100);
    expect(prompt).toBeGreaterThan(0);
    await roomy.fake.close();
    const tight = await team(() => ({ content: "x" }), "single", { pool: prompt + 37 });
    await tight.loops[0]!.start(VAULT.prompt);
    expect(tight.fake.requests[0]!.body.max_completion_tokens).toBe(37);
  });

  it("a call cut short by the budget cap ends the run with budget, not idle", async () => {
    const { loops, controller } = await team(() => ({ reasoning: "thinking…", finishReason: "length", usage: { in: 150, out: 40 } }), "single", { pool: 200 });
    await loops[0]!.start(VAULT.prompt);
    expect(await controller.done).toBe("budget");
  });

  it("a call cut at the model's own maxTokens still ends the agent idle", async () => {
    const { events, loops } = await team(() => ({ reasoning: "thinking…", finishReason: "length" }), "single");
    await loops[0]!.start(VAULT.prompt);
    expect(events.find((e) => e.kind === "agent_finished")).toMatchObject({ reason: "idle" });
  });

  it("rebuilds every request's context from the log", async () => {
    const { events, loops, fake } = await team(({ agentIndex, call }) => {
      if (agentIndex === 1 && call === 0) return { reasoning: "tell a1", toolCalls: [{ name: "send", args: { to: "a1", text: "shard 5 has digit 2" } }] };
      if (agentIndex === 0 && call < 2) return { reasoning: `step ${call}`, content: `reading ${call + 1}`, toolCalls: [{ name: "read_shard", args: { shard: call + 1 } }] };
      return { content: "done" };
    }, "polylogue", { toolDelayMs: 100 });
    await Promise.all([loops[0]!.start(VAULT.prompt), loops[1]!.start(VAULT.prompt)]);
    for (const agentIndex of [0, 1]) {
      const reqs = fake.requests.filter((r) => r.agentIndex === agentIndex);
      reqs.forEach((r, call) => expect(contextBeforeCall(events, `a${agentIndex + 1}`, call)).toEqual(normalizeOpenAIMessages(r.body.messages)));
    }
  });

  it("all agents idle with nothing pending ends the run all_idle", async () => {
    const { loops, controller } = await team(() => ({ content: "nothing to do" }), "polylogue");
    await Promise.all(loops.map((l) => l.start(VAULT.prompt)));
    expect(await controller.done).toBe("all_idle");
  });
});

/** A fork run's root alone, wired like Task 5's run will wire it; ctx.fork is a fake that, like the real one, calls afterFork. */
async function rootTeam(policy: Policy, opts: { pool?: number; toolDelayMs?: number } = {}) {
  fake = await startFakeOpenAI(policy);
  const cond = CONDITIONS["fork-silent"];
  const ids = ["a1", "a2", "a3", "a4"];
  const events: Event[] = [];
  const t0 = Date.now();
  const log = (e: EventInput) => {
    events.push({ ...e, t: Date.now() - t0 } as Event);
  };
  const pool = opts.pool ?? 1e9;
  const runtime = makeModelRuntime(testModelConfig(fake.baseUrl, { maxTokens: 100 }));
  const controller = new Controller({ pool, wallClockMs: 60_000, messagesPerMinute: 30, maxMessageChars: 2000, contextWindow: 262144 }, { log, clock: realClock, verify: VAULT.verify });
  const bus = new Bus(log);
  const forkCalls: { parent: string; directions: string[]; fallback: boolean }[] = [];
  let forked = false;
  let loop: AgentLoop | undefined;
  const ctx: RunContext = {
    log, controller, bus, board: new Blackboard(log),
    dir: { ids: () => ids, status: () => "", phase: () => "working" },
    fork: (parent, directions, o) => {
      forkCalls.push({ parent, directions, fallback: o.fallback });
      // Logged as the real run logs it, so the root's context can be rebuilt; no copy is made.
      log({ kind: "fork", agent: parent, call: loop!.callCount - 1, children: ["a2", "a3", "a4"], directions, fallback: o.fallback });
      forked = true;
      loop!.afterFork();
      return ["a2", "a3", "a4"];
    },
    forked: () => forked,
  };
  const work = [toAgentTool(readShardTool(VAULT, opts.toolDelayMs ?? 0))];
  const prompt = systemPrompt(cond, "a1", ids);
  const promptAfterFork = rootPromptAfterFork(cond, ids);
  log({ kind: "run_started", condition: cond.name, n: cond.n, taskId: VAULT.id, task: VAULT.prompt, pool, wallClockMs: 60_000 });
  log({ kind: "agent_started", agent: "a1", index: 0, seed: 700, systemPrompt: prompt, tools: work.map((t) => t.name) });
  loop = new AgentLoop({
    id: "a1", systemPrompt: prompt, tools: work, runtime, seed: 700, canBeWoken: false, ctx, clock: realClock,
    root: { tools: { beforeFork: work, afterFork: [...work, claimTool("a1", ctx)] }, promptAfterFork },
  });
  bus.add(loop);
  controller.register(loop);
  return { events, loop, controller, bus, fake: fake!, forkCalls, prompt, promptAfterFork };
}

// biome-ignore lint: request bodies are arbitrary JSON
const toolNamesOf = (r: { body: any }): string[] => (r.body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
// biome-ignore lint: request bodies are arbitrary JSON
const ctxOf = (r: { body: any }) => normalizeOpenAIMessages(r.body.messages);
// biome-ignore lint: request bodies are arbitrary JSON
const lastUser = (r: { body: any }) => ctxOf(r).filter((m) => m.role === "user").at(-1)?.text;
// biome-ignore lint: request bodies are arbitrary JSON
const told = (r: { body: any }) => {
  const last = ctxOf(r).at(-1);
  return last?.role === "user" && last.text === forkInstruction();
};
/** Every request the root made is the context rebuilt from the log. */
const expectRootRebuilt = (events: Event[], f: FakeServer) =>
  f.requests.forEach((r, call) => expect(contextBeforeCall(events, "a1", call), `a1 call ${call}`).toEqual(ctxOf(r)));
const notes = (events: Event[]) => events.filter((e) => e.kind === "runtime_note").map((e) => (e as { text: string }).text);
const DIRECTIONS = ["Check shard 1 first.", "Check shard 2 first.", "Check shard 3 first."];

describe("AgentLoop root (fork)", () => {
  it("the root has no claim tool before the fork", async () => {
    const { loop, fake } = await rootTeam((r) => {
      if (told(r)) return { toolCalls: [{ name: "fork", args: { directions: DIRECTIONS } }] };
      if (toolNamesOf(r).includes("claim")) return { content: "done" };
      return { toolCalls: [{ name: "read_shard", args: { shard: 1 } }] };
    }, { pool: 2_000 });
    await loop.start(VAULT.prompt);
    expect(toolNamesOf(fake.requests[0]!)).toEqual(["read_shard"]);
    expect(toolNamesOf(fake.requests[1]!)).toEqual(["read_shard"]);
    expect(fake.requests.map(told)).toEqual([false, false, true, false]);
  });

  it("the fork instruction arrives at the first boundary at or past 10% of the pool, with the fork tool, and the fork swaps tools and prompt", async () => {
    const { events, loop, fake, forkCalls, prompt, promptAfterFork } = await rootTeam((r) => {
      if (told(r)) return { toolCalls: [{ name: "fork", args: { directions: DIRECTIONS } }], usage: { in: 600, out: 100 } };
      if (toolNamesOf(r).includes("claim")) return { content: "done", usage: { in: 600, out: 100 } };
      return { toolCalls: [{ name: "read_shard", args: { shard: r.call + 1 } }], usage: { in: 600, out: 100 } };
    }, { pool: 10_000 });
    await loop.start(VAULT.prompt);
    const reqs = fake.requests;
    expect(reqs.map(told)).toEqual([false, false, true, false]);
    expect(toolNamesOf(reqs[1]!)).toEqual(["read_shard"]);
    expect(toolNamesOf(reqs[2]!)).toEqual(["read_shard", "fork"]);
    expect(notes(events)).toEqual([forkInstruction()]);
    expect(forkCalls).toEqual([{ parent: "a1", directions: DIRECTIONS, fallback: false }]);
    expect(toolNamesOf(reqs[3]!)).toEqual(["read_shard", "claim"]);
    expect(ctxOf(reqs[2]!)[0]).toEqual({ role: "system", text: prompt });
    expect(ctxOf(reqs[3]!).filter((m) => m.role === "system")).toEqual([{ role: "system", text: promptAfterFork }]);
    expect(loop.messages()[0]).toMatchObject({ role: "system", content: promptAfterFork });
    expectRootRebuilt(events, fake);
  });

  it("a root that ends a turn without a tool call before the fork is told to fork", async () => {
    const { events, loop, fake, forkCalls } = await rootTeam((r) => {
      if (told(r)) return { toolCalls: [{ name: "fork", args: { directions: DIRECTIONS } }] };
      if (toolNamesOf(r).includes("claim")) return { content: "done" };
      return { content: "The code is 1234." };
    });
    await loop.start(VAULT.prompt);
    const reqs = fake.requests;
    expect(reqs.map(told)).toEqual([false, true, false]);
    expect(toolNamesOf(reqs[1]!)).toContain("fork");
    const a1 = kinds(events, "a1");
    expect(a1.indexOf("runtime_note")).toBeGreaterThan(-1);
    expect(a1.slice(0, a1.indexOf("runtime_note"))).not.toContain("idle");
    expect(forkCalls).toHaveLength(1);
  });

  it("fallback after two calls without a valid fork", async () => {
    const { events, loop, fake, forkCalls, promptAfterFork } = await rootTeam((r) =>
      toolNamesOf(r).includes("claim") ? { content: "done" } : { toolCalls: [{ name: "read_shard", args: { shard: 1 } }], usage: { in: 600, out: 100 } }, { pool: 10_000 });
    await loop.start(VAULT.prompt);
    const reqs = fake.requests;
    expect(reqs.map(told)).toEqual([false, false, true, false, false]);
    expect(forkCalls).toEqual([{ parent: "a1", directions: [GENERIC_DIRECTION, GENERIC_DIRECTION, GENERIC_DIRECTION], fallback: true }]);
    const notice = fallbackNotice(["a2", "a3", "a4"]);
    expect(lastUser(reqs[4]!)).toBe(notice);
    expect(notes(events)).toEqual([forkInstruction(), notice]);
    expect(toolNamesOf(reqs[4]!)).toEqual(["read_shard", "claim"]);
    expect(ctxOf(reqs[4]!)[0]).toEqual({ role: "system", text: promptAfterFork });
    expectRootRebuilt(events, fake);
  });

  it("a malformed fork counts as one of the two calls", async () => {
    const { events, loop, fake, forkCalls } = await rootTeam((r) => {
      if (toolNamesOf(r).includes("claim")) return { content: "done" };
      if (told(r)) return { toolCalls: [{ name: "fork", args: { directions: ["only one", "two"] } }] };
      return { toolCalls: [{ name: "read_shard", args: { shard: 1 } }], usage: { in: 600, out: 100 } };
    }, { pool: 10_000 });
    await loop.start(VAULT.prompt);
    expect(fake.requests.map(told)).toEqual([false, false, true, false, false]);
    expect(events.find((e) => e.kind === "tool_result" && e.tool === "fork")).toMatchObject({ isError: true });
    expect(forkCalls).toEqual([{ parent: "a1", directions: [GENERIC_DIRECTION, GENERIC_DIRECTION, GENERIC_DIRECTION], fallback: true }]);
  });

  it("a root that answers the instruction without a tool call is told again, then forked for", async () => {
    const { events, loop, fake, forkCalls } = await rootTeam((r) => (toolNamesOf(r).includes("claim") ? { content: "done" } : { content: "Still thinking." }));
    await loop.start(VAULT.prompt);
    expect(fake.requests.map(told)).toEqual([false, true, true, false]);
    expect(notes(events)).toEqual([forkInstruction(), forkInstruction(), fallbackNotice(["a2", "a3", "a4"])]);
    expect(forkCalls).toEqual([expect.objectContaining({ fallback: true })]);
    expectRootRebuilt(events, fake);
  });

  it("a loop given initial messages starts from them under its own system prompt", async () => {
    const { loop, fake } = await rootTeam(() => ({ content: "done" }));
    const inherited = loop.messages();
    expect(inherited).toHaveLength(1);
    const ctx = (loop as unknown as { o: { ctx: RunContext } }).o.ctx;
    const runtime = makeModelRuntime(testModelConfig(fake.baseUrl, { maxTokens: 100 }));
    const earlier = [
      ...inherited,
      { role: "user", content: "earlier", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "noted" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 0 },
    ] as never[];
    const copy = new AgentLoop({ id: "a2", systemPrompt: "You are a copy.", tools: [], runtime, seed: 701, canBeWoken: false, ctx, clock: realClock, initialMessages: earlier });
    await copy.start("go on");
    expect(ctxOf(fake.requests[0]!)).toEqual([
      { role: "system", text: "You are a copy." },
      { role: "user", text: "earlier" },
      { role: "assistant", text: "noted" },
      { role: "user", text: "go on" },
    ]);
  });

  it("runtime notes come before a message block at the same boundary", async () => {
    const { events, loop, bus, fake } = await rootTeam((r) => {
      if (r.call > 0) return { content: "done" };
      return { toolCalls: [{ name: "read_shard", args: { shard: 1 } }], usage: { in: 600, out: 1000 } };
    }, { pool: 10_000, toolDelayMs: 200 });
    const run = loop.start(VAULT.prompt);
    await vi.waitFor(() => expect(events.some((e) => e.kind === "tool_call")).toBe(true));
    bus.post("a2", "a1", "hello root", false);
    await run;
    const second = ctxOf(fake.requests[1]!);
    expect(second.slice(-3).map((m) => m.role)).toEqual(["tool", "user", "user"]);
    expect(second.at(-2)!.text).toBe(forkInstruction());
    expect(second.at(-1)!.text).toBe("[from a2] hello root");
    const a1 = kinds(events, "a1");
    expect(a1.indexOf("runtime_note")).toBeLessThan(a1.indexOf("message_delivered"));
    expectRootRebuilt(events, fake);
  });
});
