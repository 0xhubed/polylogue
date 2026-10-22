import { describe, expect, it } from "vitest";
import type { Event } from "@polylogue/schema";
import { stateAt } from "./state.ts";
import { simulate } from "./sim.ts";

const base: Event[] = [
  { kind: "run_started", t: 0, condition: "polylogue", n: 2, taskId: "toy-vault", task: "Find it.", pool: 1000, wallClockMs: 60000 },
  { kind: "agent_started", t: 0, agent: "a1", index: 0, seed: 100, systemPrompt: "s", tools: [] },
  { kind: "agent_started", t: 0, agent: "a2", index: 1, seed: 101, systemPrompt: "s", tools: [] },
  { kind: "model_call", t: 1000, agent: "a1", call: 0, content: "reading", reasoning: "", toolCalls: [], tokensIn: 300, tokensOut: 50, ms: 800, stopReason: "toolUse" },
  { kind: "status", t: 1000, agent: "a1", text: "reading" },
  { kind: "tool_call", t: 1000, agent: "a1", callId: "c1", tool: "read_shard", args: { shard: 1 } },
  { kind: "tool_result", t: 1500, agent: "a1", callId: "c1", tool: "read_shard", isError: false, text: "x", ms: 500 },
  { kind: "idle", t: 1200, agent: "a2" },
  { kind: "message", t: 1600, id: "m0", from: "a1", to: "a2", recipients: ["a2"], text: "digit 1 is 4", urgent: false },
  { kind: "wake", t: 1600, agent: "a2", reason: "message" },
  { kind: "message", t: 1700, id: "m1", from: "a1", to: { topic: "all" }, recipients: ["a2"], text: "fyi", urgent: false },
  { kind: "blackboard", t: 1800, agent: "a1", text: "digit 1 = 4" },
  { kind: "agent_finished", t: 9000, agent: "a1", reason: "claimed" },
];

describe("stateAt", () => {
  it("shows phases at given times", () => {
    expect(stateAt(base, 500).agents.find((a) => a.id === "a1")!.phase).toBe("thinking");
    expect(stateAt(base, 1200).agents.find((a) => a.id === "a1")!.phase).toBe("tool");
    expect(stateAt(base, 1300).agents.find((a) => a.id === "a2")!.phase).toBe("idle");
    expect(stateAt(base, 1650).agents.find((a) => a.id === "a2")!.phase).toBe("working");
    expect(stateAt(base, 9000).agents.find((a) => a.id === "a1")!.phase).toBe("finished");
  });

  it("counts tokens, messages and status only up to t", () => {
    const early = stateAt(base, 999);
    expect(early.counters).toMatchObject({ tokens: 0, pool: 1000, messages: 0, wallMs: 999 });
    expect(early.agents[0]!.status).toBe("");
    const later = stateAt(base, 2000);
    expect(later.counters).toMatchObject({ tokens: 350, messages: 2, messagesPerMinute: 2 });
    expect(later.agents[0]).toMatchObject({ status: "reading", tokens: 350, sent: 2 });
    expect(later.chat.map((m) => m.id)).toEqual(["m0", "m1"]);
    expect(later.blackboard).toHaveLength(1);
  });

  it("builds edges for direct and topic messages and marks recent ones active", () => {
    const s = stateAt(base, 2000);
    expect(s.edges).toEqual([{ from: "a1", to: "a2", count: 2, lastT: 1700, active: true }]);
    expect(stateAt(base, 1700 + 3001).edges[0]!.active).toBe(false);
  });

  it("draws a topic message only to the agents it reached", () => {
    const four: Event[] = [
      { kind: "run_started", t: 0, condition: "polylogue", n: 4, taskId: "toy-vault", task: "Find it.", pool: 1000, wallClockMs: 60000 },
      ...[1, 2, 3, 4].map((i) => ({ kind: "agent_started", t: 0, agent: `a${i}`, index: i - 1, seed: 100 + i, systemPrompt: "s", tools: [] }) as Event),
      { kind: "agent_finished", t: 100, agent: "a2", reason: "claimed" },
      { kind: "message", t: 200, id: "m0", from: "a1", to: { topic: "math" }, recipients: ["a3"], text: "x", urgent: false },
    ];
    expect(stateAt(four, 300).edges).toEqual([{ from: "a1", to: "a3", count: 1, lastT: 200, active: true }]);
  });

  it("cuts lanes at t", () => {
    const lane = stateAt(base, 1200).lanes.find((l) => l.agent === "a1")!;
    expect(lane.segments).toEqual([{ kind: "model", start: 200, end: 1000 }, { kind: "tool", start: 1000, end: 1200 }]);
  });

  it("works on a run that has not finished", () => {
    const s = stateAt(base, 2000);
    expect(s.duration).toBe(9000);
    expect(s.ended).toBeUndefined();
    expect(stateAt([], 0)).toMatchObject({ duration: 0, agents: [], counters: { tokens: 0, pool: 0 } });
  });

  it("ends with the run_finished reason on a simulated run", () => {
    const events = simulate("polylogue", 2);
    const s = stateAt(events, events.at(-1)!.t);
    expect(s.ended?.kind).toBe("run_finished");
    expect(s.agents.every((a) => a.phase === "finished")).toBe(true);
  });
});
