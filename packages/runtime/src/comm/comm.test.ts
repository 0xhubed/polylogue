import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventInput, InboxMessage } from "@polylogue/schema";
import { Bus, type BusMember } from "./bus.ts";
import { Blackboard } from "./blackboard.ts";
import { CONDITIONS, NORMS, systemPrompt, toolNames } from "../conditions.ts";
import { buildTools } from "../tools/build-tools.ts";
import { Controller } from "../control/controller.ts";
import { FakeClock } from "../clock.ts";
import { VAULT, readShardTool } from "../toy/vault.ts";
import type { AgentDirectory, RunContext } from "../run/context.ts";

function member(id: string, finished = false): BusMember & { got: InboxMessage[]; done: boolean } {
  const m = { id, got: [] as InboxMessage[], done: finished, receive(msg: InboxMessage) { m.got.push(msg); }, isFinished: () => m.done };
  return m;
}

function world(condition: keyof typeof CONDITIONS = "polylogue") {
  const logged: EventInput[] = [];
  const log = (e: EventInput) => logged.push(e);
  const clock = new FakeClock();
  const controller = new Controller({ pool: 1e6, wallClockMs: 1e6, messagesPerMinute: 3, maxMessageChars: 50, contextWindow: 1e6 }, { log, clock, verify: VAULT.verify });
  const bus = new Bus(log);
  const board = new Blackboard(log);
  const members = ["a1", "a2", "a3", "a4"].map((id) => member(id));
  for (const m of members) bus.add(m);
  const dir: AgentDirectory = { ids: () => members.map((m) => m.id), status: (id) => (id === "a2" ? "reading shard 3" : ""), phase: (id) => (members.find((m) => m.id === id)!.done ? "finished" : "working") };
  const ctx: RunContext = { log, controller, bus, board, dir };
  return { logged, bus, board, members, ctx, controller };
}

const call = async (tools: AgentTool<any>[], name: string, args: unknown) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  const r = await t.execute("id", args as never);
  return r.content.map((c) => ("text" in c ? c.text : "")).join("");
};

describe("Bus", () => {
  it("delivers direct messages to one agent and topics to subscribers except the sender", () => {
    const { bus, members, logged } = world();
    bus.subscribe("a3", "frontend");
    expect(bus.post("a1", "a2", "hi", false)).toEqual({ id: "m0", recipients: ["a2"] });
    expect(bus.post("a1", { topic: "all" }, "everyone", true).recipients).toEqual(["a2", "a3", "a4"]);
    expect(bus.post("a2", { topic: "frontend" }, "fe", false).recipients).toEqual(["a3"]);
    expect(members[1]!.got.map((m) => m.id)).toEqual(["m0", "m1"]);
    expect(members[2]!.got.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(logged.filter((e) => e.kind === "message")).toHaveLength(3);
  });

  it("logs the message with its live recipients before handing it over", () => {
    const { bus, members, logged } = world();
    members[3]!.done = true;
    const loggedFirst: boolean[] = [];
    members[1]!.receive = (msg) => loggedFirst.push(logged.some((e) => e.kind === "message" && e.id === msg.id));
    bus.post("a1", { topic: "all" }, "x", false);
    expect(logged).toEqual([{ kind: "message", id: "m0", from: "a1", to: { topic: "all" }, recipients: ["a2", "a3"], text: "x", urgent: false }]);
    expect(loggedFirst).toEqual([true]);
  });

  it("does not deliver to finished agents", () => {
    const { bus, members } = world();
    members[3]!.done = true;
    expect(bus.post("a1", { topic: "all" }, "x", false).recipients).toEqual(["a2", "a3"]);
    expect(members[3]!.got).toEqual([]);
  });
});

describe("Blackboard", () => {
  it("appends entries with their author and logs each", () => {
    const { board, logged } = world();
    expect(board.read()).toBe("(the blackboard is empty)");
    board.append("a1", "digit 1 = 4");
    board.append("a2", "digit 3 = 1");
    expect(board.read()).toBe("[a1] digit 1 = 4\n[a2] digit 3 = 1");
    expect(logged).toEqual([{ kind: "blackboard", agent: "a1", text: "digit 1 = 4" }, { kind: "blackboard", agent: "a2", text: "digit 3 = 1" }]);
  });
});

describe("conditions", () => {
  it("gives each condition exactly its tool set", () => {
    const work = ["read_shard"];
    expect(toolNames(CONDITIONS.single, work)).toEqual(["read_shard", "claim"]);
    expect(toolNames(CONDITIONS.isolated, work)).toEqual(["read_shard", "claim"]);
    expect(toolNames(CONDITIONS.stigmergic, work)).toEqual(["read_shard", "claim", "read_blackboard", "append_blackboard"]);
    const comm = ["read_shard", "claim", "read_blackboard", "append_blackboard", "send", "publish", "subscribe", "roster"];
    expect(toolNames(CONDITIONS.polylogue, work)).toEqual(comm);
    expect(toolNames(CONDITIONS["polylogue-bare"], work)).toEqual(comm);
    expect([1, 4, 4, 4, 4]).toEqual(["single", "isolated", "stigmergic", "polylogue", "polylogue-bare"].map((n) => CONDITIONS[n as keyof typeof CONDITIONS].n));
  });

  it("puts the norms in the polylogue prompt only", () => {
    const ids = ["a1", "a2", "a3", "a4"];
    expect(systemPrompt(CONDITIONS.polylogue, "a2", ids)).toContain(NORMS);
    for (const c of ["single", "isolated", "stigmergic", "polylogue-bare"] as const) expect(systemPrompt(CONDITIONS[c], "a2", ids)).not.toContain(NORMS);
    expect(systemPrompt(CONDITIONS["polylogue-bare"], "a2", ids)).toBe(systemPrompt(CONDITIONS.polylogue, "a2", ids).replace(`\n\n${NORMS}`, ""));
  });

  it("tells the teams that can see each other that the first claim is the team's answer; isolated and single keep their own claims", () => {
    const ids = ["a1", "a2", "a3", "a4"];
    const rule = "The first claim by any agent is the team's answer and ends the run for everyone.";
    expect(systemPrompt(CONDITIONS.single, "a1", ["a1"])).not.toContain(rule);
    expect(systemPrompt(CONDITIONS.isolated, "a2", ids)).not.toContain(rule);
    for (const c of ["stigmergic", "polylogue", "polylogue-bare"] as const) expect(systemPrompt(CONDITIONS[c], "a2", ids)).toContain(rule);
    expect([true, false, true, true, true]).toEqual(["single", "isolated", "stigmergic", "polylogue", "polylogue-bare"].map((n) => CONDITIONS[n as keyof typeof CONDITIONS].firstClaimEnds));
  });

  it("the polylogue norms start with a kickoff: a one-line plan on #all before work", () => {
    expect(NORMS.split("\n")[1]).toMatch(/^1\. Start by publishing a one-line plan on #all/);
  });

  it("builds tools in the documented order", () => {
    const { ctx } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, [readShardTool(VAULT, 0)]);
    expect(tools.map((t) => t.name)).toEqual(toolNames(CONDITIONS.polylogue, ["read_shard"]));
  });
});

describe("communication tools", () => {
  it("send delivers, and refuses self, unknown, finished and empty messages", async () => {
    const { ctx, members, logged } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    expect(await call(tools, "send", { to: "a2", text: "digit 1 is 4" })).toBe("Sent to a2.");
    expect(members[1]!.got[0]).toMatchObject({ from: "a1", to: "a2", text: "digit 1 is 4", urgent: false });
    await expect(call(tools, "send", { to: "a1", text: "me" })).rejects.toThrow(/cannot message yourself/);
    await expect(call(tools, "send", { to: "a9", text: "x" })).rejects.toThrow(/no agent a9.*a1, a2, a3, a4/);
    await expect(call(tools, "send", { to: "a2", text: "   " })).rejects.toThrow(/empty/);
    members[2]!.done = true;
    await expect(call(tools, "send", { to: "a3", text: "x" })).rejects.toThrow(/a3 has finished/);
    expect(logged.filter((e) => e.kind === "message")).toHaveLength(1);
  });

  it("publish reports how many live agents it reached; urgent is passed through", async () => {
    const { ctx, members } = world();
    members[3]!.done = true;
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    expect(await call(tools, "publish", { topic: "all", text: "stop", urgent: true })).toBe("Published to #all (2 agents).");
    expect(members[1]!.got[0]!.urgent).toBe(true);
  });

  it("publish and subscribe accept a topic with spaces around a leading #", async () => {
    const { ctx, bus } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    expect(await call(tools, "publish", { topic: " #all ", text: "hi" })).toBe("Published to #all (3 agents).");
    expect(await call(tools, "subscribe", { topic: " #math " })).toBe("Subscribed to #math.");
    expect(bus.post("a2", { topic: "math" }, "x", false).recipients).toEqual(["a1"]);
    await expect(call(tools, "publish", { topic: " # ", text: "hi" })).rejects.toThrow(/The topic is empty/);
  });

  it("rate limits surface as tool errors", async () => {
    const { ctx } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    for (let i = 0; i < 3; i++) await call(tools, "send", { to: "a2", text: `m${i}` });
    await expect(call(tools, "send", { to: "a2", text: "m3" })).rejects.toThrow(/at most 3 messages per minute/);
    await expect(call(tools, "publish", { topic: "all", text: "x".repeat(51) })).rejects.toThrow(/at most 50 characters/);
  });

  it("subscribe and roster", async () => {
    const { ctx, bus } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    expect(await call(tools, "subscribe", { topic: "math" })).toBe("Subscribed to #math.");
    expect(bus.post("a2", { topic: "math" }, "x", false).recipients).toEqual(["a1"]);
    expect(await call(tools, "roster", {})).toBe("a1 (you): working\na2: working — reading shard 3\na3: working\na4: working");
  });

  it("claim is blind, and the first claim of the team ends the run", async () => {
    const { ctx, controller } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    expect(await call(tools, "claim", { answer: "1111", evidence: "guess" })).toBe("Claim submitted.");
    expect(controller.ended).toBe("wrong_claim");
    const t2 = buildTools(CONDITIONS.polylogue, "a2", ctx, []);
    await expect(call(t2, "claim", { answer: "4719", evidence: "shards" })).rejects.toThrow(/run has ended/);
  });
});

describe("toy vault task", () => {
  it("reads shards and verifies the code", async () => {
    const shard = readShardTool(VAULT, 0);
    expect(await shard.run({ shard: 1 })).toBe(VAULT.shards[1]);
    await expect(shard.run({ shard: 99 })).rejects.toThrow(/Shards are numbered 1 to 8/);
    expect(VAULT.verify("4719")).toEqual({ passed: true });
    expect(VAULT.verify(" code: 4-7-1-9 ")).toEqual({ passed: true });
    expect(VAULT.verify("4791")).toEqual({ passed: false, detail: "expected 4719, got 4791" });
  });

  it("read_shard honours abort", async () => {
    const shard = readShardTool(VAULT, 5_000);
    const ac = new AbortController();
    const p = shard.run({ shard: 1 }, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});
