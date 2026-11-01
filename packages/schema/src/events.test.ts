import { describe, expect, it } from "vitest";
import { Event, formatBlock, orderBlock, type InboxMessage } from "./index.ts";

describe("Event schema", () => {
  it("accepts every kind with its fields", () => {
    const samples: unknown[] = [
      { kind: "run_started", t: 0, condition: "polylogue", n: 4, taskId: "toy-vault", task: "Find it.", pool: 4000, wallClockMs: 60000 },
      { kind: "agent_started", t: 0, agent: "a1", index: 0, seed: 700, systemPrompt: "You are agent a1.", tools: ["read_shard", "claim"] },
      { kind: "status", t: 5, agent: "a1", text: "reading shard 1" },
      { kind: "model_call", t: 900, agent: "a1", call: 0, content: "", reasoning: "hm", toolCalls: [{ id: "c1", name: "read_shard", args: { shard: 1 } }], tokensIn: 400, tokensOut: 40, ms: 880, stopReason: "toolUse" },
      { kind: "tool_call", t: 901, agent: "a1", callId: "c1", tool: "read_shard", args: { shard: 1 } },
      { kind: "tool_result", t: 950, agent: "a1", callId: "c1", tool: "read_shard", isError: false, text: "The first digit is 4.", ms: 49 },
      { kind: "message", t: 960, id: "m0", from: "a1", to: "a2", recipients: ["a2"], text: "digit 1 is 4", urgent: false },
      { kind: "message", t: 961, id: "m1", from: "a1", to: { topic: "all" }, recipients: ["a2", "a3"], text: "stop", urgent: true },
      { kind: "message_delivered", t: 970, agent: "a2", messageId: "m0", delivery: 0 },
      { kind: "idle", t: 980, agent: "a3" },
      { kind: "wake", t: 990, agent: "a3", reason: "message" },
      { kind: "blackboard", t: 995, agent: "a1", text: "digit 1 = 4" },
      { kind: "claim_submitted", t: 1000, agent: "a1", answer: "4719", evidence: "shards 1,3,5,7" },
      { kind: "verification", t: 1000, claimOf: "a1", passed: true },
      { kind: "agent_finished", t: 1001, agent: "a1", reason: "claimed" },
      { kind: "run_finished", t: 1002, reason: "solved", solved: true, wallMs: 1002, totalTokens: 440 },
      { kind: "run_finished", t: 1002, reason: "infra_error", solved: false, wallMs: 1002, totalTokens: 440, detail: "500 fake error 500" },
    ];
    for (const s of samples) expect(() => Event.parse(s)).not.toThrow();
  });

  it("keeps an optional task fingerprint on run_started", () => {
    const base = { kind: "run_started", t: 0, condition: "single", n: 1, taskId: "bcp-1", task: "Q?", pool: 1000, wallClockMs: 1000 };
    expect(Event.parse({ ...base, taskFingerprint: "ab12" })).toMatchObject({ taskFingerprint: "ab12" });
    expect(() => Event.parse(base)).not.toThrow();
    expect(() => Event.parse({ ...base, taskFingerprint: 12 })).toThrow();
  });

  it("parses a fork event", () => {
    const ok = { kind: "fork", t: 5000, agent: "a1", call: 7, children: ["a2", "a3", "a4"], directions: ["Check clue 1.", "Check clue 2.", "Check clue 3."], fallback: false };
    expect(Event.parse(ok)).toEqual(ok);
    expect(() => Event.parse({ ...ok, fallback: true })).not.toThrow();
    expect(() => Event.parse({ ...ok, children: ["a2", "a3"] })).toThrow();
    expect(() => Event.parse({ ...ok, directions: ["x", "y"] })).toThrow();
    expect(() => Event.parse({ ...ok, children: ["a2", "a3", "bob"] })).toThrow();
    expect(() => Event.parse({ ...ok, fallback: undefined })).toThrow();
  });

  it("parses a runtime_note event", () => {
    const ok = { kind: "runtime_note", t: 6000, agent: "a1", text: "Fork now." };
    expect(Event.parse(ok)).toEqual(ok);
    expect(() => Event.parse({ ...ok, agent: "bob" })).toThrow();
    expect(() => Event.parse({ kind: "runtime_note", t: 6000, agent: "a1" })).toThrow();
  });

  it("accepts the fork and fork-silent condition names", () => {
    const base = { kind: "run_started", t: 0, n: 4, taskId: "bcp-1", task: "Q?", pool: 1000, wallClockMs: 1000 };
    for (const condition of ["fork", "fork-silent"]) expect(Event.parse({ ...base, condition })).toMatchObject({ condition });
    expect(() => Event.parse({ ...base, condition: "fork-loud" })).toThrow();
  });

  it("rejects unknown kinds, bad agent ids and unknown end reasons", () => {
    expect(() => Event.parse({ kind: "nope", t: 0 })).toThrow();
    expect(() => Event.parse({ kind: "idle", t: 0, agent: "bob" })).toThrow();
    expect(() => Event.parse({ kind: "run_finished", t: 1, reason: "bored", solved: false, wallMs: 1, totalTokens: 0 })).toThrow();
    expect(() => Event.parse({ kind: "idle", t: -1, agent: "a1" })).toThrow();
  });
});

describe("inbox blocks", () => {
  const msgs: InboxMessage[] = [
    { id: "m0", from: "a2", to: "a1", text: "hello", urgent: false },
    { id: "m1", from: "a3", to: { topic: "all" }, text: "solved, stop", urgent: true },
    { id: "m2", from: "a4", to: "a1", text: "digit 3 is 1", urgent: false },
  ];

  it("puts urgent messages first and keeps arrival order otherwise", () => {
    expect(orderBlock(msgs).map((m) => m.id)).toEqual(["m1", "m0", "m2"]);
  });

  it("formats one line per message", () => {
    expect(formatBlock(msgs)).toBe(
      "[URGENT from a3 on #all] solved, stop\n[from a2] hello\n[from a4] digit 3 is 1",
    );
  });

  it("is stable when applied twice", () => {
    expect(orderBlock(orderBlock(msgs))).toEqual(orderBlock(msgs));
  });
});
