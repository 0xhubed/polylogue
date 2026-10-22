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
import { CONDITIONS, systemPrompt } from "../conditions.ts";
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
