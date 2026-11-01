import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConditionName, Event } from "@polylogue/schema";
import { runOnce } from "./run.ts";
import { parseConfig, configHash, type RunConfig } from "../config.ts";
import { EventLog } from "../log/event-log.ts";
import { Controller } from "../control/controller.ts";
import { CONDITIONS, NORMS, PHASE1_CONDITIONS, rootPromptAfterFork, systemPrompt } from "../conditions.ts";
import { GENERIC_DIRECTION, childForkResult, directionMessage, fallbackNotice, forkInstruction, parentForkResult } from "../fork/texts.ts";
import { contextBeforeCall, normalizeOpenAIMessages } from "../agent/context.ts";
import { VAULT } from "../toy/vault.ts";
import { startFakeOpenAI, type FakeServer, type Policy } from "../testing/fake-openai.ts";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const dbPath = () => join(mkdtempSync(join(tmpdir(), "polylogue-run-")), "runs.sqlite");

function config(baseUrl: string, condition: ConditionName, over: Partial<RunConfig> = {}): RunConfig {
  return parseConfig({
    condition, taskId: "toy-vault", seed: 7,
    budget: { tokensPerAgent: 100_000 }, wallClockMs: 20_000,
    rate: { messagesPerMinute: 30, maxMessageChars: 2000 }, toolDelayMs: 0, checkServer: true,
    model: { baseUrl, id: "qwen3.8-27b", hfRepo: "unsloth/Qwen3.8-27B-NVFP4", revision: "7d6f8d4d72f56b92b3cdbf22f156b90e1bab0108", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 30_000, maxRetries: 1 },
    ...over,
  });
}

/** Agent 1 reads two shards and claims the right code; the others read one shard each and idle. */
const solver: Policy = ({ agentIndex, call }) => {
  if (agentIndex === 0) {
    if (call === 0) return { toolCalls: [{ name: "read_shard", args: { shard: 1 } }] };
    if (call === 1) return { toolCalls: [{ name: "read_shard", args: { shard: 3 } }] };
    return { toolCalls: [{ name: "claim", args: { answer: "4719", evidence: "shards 1, 3, 5, 7" } }] };
  }
  return call === 0 ? { toolCalls: [{ name: "read_shard", args: { shard: agentIndex + 4 } }] } : { content: "nothing more" };
};

function invariants(events: Event[]): void {
  const end = events.findIndex((e) => e.kind === "run_finished");
  expect(end).toBe(events.length - 1);
  const pass = events.findIndex((e) => e.kind === "verification" && e.passed);
  if (pass >= 0) expect(events.slice(pass + 1).some((e) => e.kind === "claim_submitted")).toBe(false);
  for (const id of new Set(events.flatMap((e) => (e.kind === "agent_started" ? [e.agent] : [])))) {
    expect(events.filter((e) => e.kind === "agent_finished" && e.agent === id)).toHaveLength(1);
  }
}

describe("runOnce", () => {
  for (const condition of PHASE1_CONDITIONS) {
    it(`runs ${condition} end to end with its tool set and prompt`, async () => {
      fake = await startFakeOpenAI(solver);
      const log = new EventLog(dbPath());
      const summary = await runOnce(config(fake.baseUrl, condition), { log, gitSha: "abc123" });
      expect(summary).toMatchObject({ reason: "solved", solved: true });
      const events = log.events(summary.runId).map((s) => s.event);
      invariants(events);
      expect(events[0]).toMatchObject({ kind: "run_started", config: { condition, seed: 7 } });
      const starts = events.filter((e) => e.kind === "agent_started");
      expect(starts).toHaveLength(CONDITIONS[condition].n);
      expect(starts[0]!.kind === "agent_started" && starts[0]!.systemPrompt.includes(NORMS)).toBe(condition === "polylogue");
      const toolsSent = fake.requests[0]!.body.tools.map((t: { function: { name: string } }) => t.function.name);
      expect(toolsSent).toEqual(starts[0]!.kind === "agent_started" ? starts[0]!.tools : []);
      for (const r of fake.requests) {
        expect(r.body).toMatchObject({ temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 });
        expect(r.body.seed).toBe(700 + r.agentIndex);
        expect(r.body.chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
      }
      const row = log.run(summary.runId)!;
      expect(row).toMatchObject({ status: "solved", endReason: "solved", condition, n: CONDITIONS[condition].n, gitSha: "abc123", configHash: configHash(config(fake.baseUrl, condition)) });
    });
  }

  it("isolated: a wrong claim is blind and the run goes on (scored both ways later); all_idle when nobody is left", async () => {
    fake = await startFakeOpenAI(({ call }) => (call === 0 ? { toolCalls: [{ name: "claim", args: { answer: "1111", evidence: "guess" } }] } : { content: "?" }));
    const log = new EventLog(dbPath());
    const s = await runOnce(config(fake.baseUrl, "isolated"), { log });
    expect(s.reason).toBe("all_idle");
    expect(log.events(s.runId).filter((x) => x.event.kind === "verification")).toHaveLength(4);
  });

  it("a wrong first claim is blind and ends a team's run with wrong_claim", async () => {
    fake = await startFakeOpenAI(({ call }) => (call === 0 ? { toolCalls: [{ name: "claim", args: { answer: "1111", evidence: "guess" } }] } : { content: "?" }));
    const log = new EventLog(dbPath());
    const s = await runOnce(config(fake.baseUrl, "stigmergic"), { log });
    expect(s.reason).toBe("wrong_claim");
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    expect(events.filter((e) => e.kind === "verification")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "verification").every((e) => e.kind === "verification" && !e.passed)).toBe(true);
    expect(new Set(events.filter((e) => e.kind === "tool_result" && e.tool === "claim").map((e) => (e as { text: string }).text))).toEqual(new Set(["Claim submitted."]));
    expect(log.run(s.runId)!.status).toBe("unsolved");
  });

  it("a second claim in the same turn never reaches the verifier: the first one ended the run", async () => {
    fake = await startFakeOpenAI(({ call }) => (call === 0 ? { toolCalls: [{ name: "claim", args: { answer: "1", evidence: "a" } }, { name: "claim", args: { answer: "2", evidence: "b" } }] } : { content: "?" }));
    const log = new EventLog(dbPath());
    const s = await runOnce(config(fake.baseUrl, "single"), { log });
    expect(s.reason).toBe("wrong_claim");
    expect(log.events(s.runId).filter((x) => x.event.kind === "claim_submitted")).toHaveLength(1);
  });

  it("ends with budget when the next call no longer fits the pool, and a team never charges beyond it", async () => {
    fake = await startFakeOpenAI(({ agentIndex }) => ({ toolCalls: [{ name: "read_shard", args: { shard: 2 } }], usage: { in: 400, out: 100 }, delayMs: agentIndex * 30 }));
    const log = new EventLog(dbPath());
    const s = await runOnce(config(fake.baseUrl, "isolated", { budget: { tokensPerAgent: 600 } }), { log });
    expect(s.reason).toBe("budget");
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    const charged = events.reduce((n, e) => n + (e.kind === "model_call" ? e.tokensIn + e.tokensOut : 0), 0);
    expect(s.totalTokens).toBe(charged);
    expect(charged).toBeLessThanOrEqual(2400);
    expect(charged).toBeGreaterThan(0);
    expect(fake.requests.length).toBe(events.filter((e) => e.kind === "model_call").length);
  });

  it("after a budget end, a call still in flight at the wall-clock deadline is stopped", async () => {
    fake = await startFakeOpenAI(({ agentIndex }) =>
      agentIndex === 0 ? { toolCalls: [{ name: "read_shard", args: { shard: 1 } }], usage: { in: 3000, out: 10 } } : { content: "slow", delayMs: 5_000 },
    );
    const log = new EventLog(dbPath());
    const t = Date.now();
    const s = await runOnce(config(fake.baseUrl, "isolated", { budget: { tokensPerAgent: 600 }, wallClockMs: 500 }), { log });
    expect(s.reason).toBe("budget");
    expect(Date.now() - t).toBeLessThan(2_500);
    invariants(log.events(s.runId).map((x) => x.event));
  });

  it("charges and logs the whole prompt when the server reports cached prompt tokens", async () => {
    fake = await startFakeOpenAI(({ call }) =>
      call === 0
        ? { toolCalls: [{ name: "claim", args: { answer: "4719", evidence: "x" } }], usage: { in: 1000, out: 50, cached: 800 } }
        : { content: "?" },
    );
    const log = new EventLog(dbPath());
    const s = await runOnce(config(fake.baseUrl, "single"), { log });
    const calls = log.events(s.runId).map((x) => x.event).filter((e) => e.kind === "model_call");
    expect(calls).toEqual([expect.objectContaining({ tokensIn: 1000, tokensOut: 50 })]);
    expect(s.totalTokens).toBe(1050);
  });

  it("ends with killed at the wall-clock limit and aborts in-flight calls", async () => {
    fake = await startFakeOpenAI(() => ({ content: "slow", delayMs: 3_000 }));
    const log = new EventLog(dbPath());
    const t = Date.now();
    const s = await runOnce(config(fake.baseUrl, "polylogue", { wallClockMs: 300 }), { log });
    expect(s.reason).toBe("killed");
    expect(Date.now() - t).toBeLessThan(2_500);
    invariants(log.events(s.runId).map((x) => x.event));
  });

  it("ends with infra_error after retries are exhausted", async () => {
    fake = await startFakeOpenAI(({ agentIndex }) => (agentIndex === 0 ? { status: 500 } : { content: "fine", delayMs: 2_000 }));
    const log = new EventLog(dbPath());
    const s = await runOnce(config(fake.baseUrl, "isolated"), { log });
    expect(s.reason).toBe("infra_error");
    expect(fake.requests.filter((r) => r.agentIndex === 0)).toHaveLength(2);
    expect(log.run(s.runId)!.status).toBe("infra_error");
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    const end = events.at(-1)!;
    expect(end.kind === "run_finished" && end.detail).toMatch(/\S/);
  });

  it("refuses to start when the server does not serve the pinned model", async () => {
    fake = await startFakeOpenAI(() => ({}), { modelId: "something-else" });
    const log = new EventLog(dbPath());
    await expect(runOnce(config(fake.baseUrl, "single"), { log })).rejects.toThrow(/does not serve "qwen3.8-27b"/);
    expect(log.runs()).toEqual([]);
  });
});

describe("config", () => {
  it("hashes independently of key order and rejects unknown conditions", () => {
    const a = config("http://x/v1", "single");
    const b = parseConfig(JSON.parse(JSON.stringify({ ...a, model: { ...a.model }, seed: a.seed })));
    expect(configHash(a)).toBe(configHash(b));
    expect(configHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => parseConfig({ ...a, condition: "chaos" })).toThrow();
  });
});

// biome-ignore lint: request bodies are arbitrary JSON
type Req = { agentIndex: number; call: number; body: any };
const toolNamesOf = (r: Req): string[] => (r.body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
const ctxOf = (r: Req) => normalizeOpenAIMessages(r.body.messages);
const told = (r: Req) => {
  const last = ctxOf(r).at(-1);
  return last?.role === "user" && last.text === forkInstruction();
};
const lastUserText = (r: Req) => ctxOf(r).filter((m) => m.role === "user").at(-1)?.text ?? "";
// biome-ignore lint: request bodies are arbitrary JSON
const systemCount = (r: Req) => r.body.messages.filter((m: any) => m.role === "system" || m.role === "developer").length;
const DIRECTIONS = ["Start from shard 1.", "Start from shard 4.", "Start from shard 7."];
const COPIES = ["a2", "a3", "a4"];
const AFTER_SILENT = ["read_shard", "claim"];
const AFTER_MESSAGING = ["read_shard", "claim", "send", "publish", "subscribe", "roster"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pool 400k, so the fork is due at 40k: the root's calls cost 20.1k each, so it is told after its second call (request 2). */
function forkConfig(baseUrl: string, condition: ConditionName, over: Partial<RunConfig> = {}): RunConfig {
  return config(baseUrl, condition, over);
}

/** The root searches until it is told to fork, then forks; a2 claims the right code with its first call; a3 and a4 are slow. */
const forker =
  (opts: { forkTurn?: { name: string; args: unknown }[]; copy?: Policy } = {}): Policy =>
  (r) => {
    if (r.agentIndex === 0) {
      if (told(r)) return { toolCalls: opts.forkTurn ?? [{ name: "fork", args: { directions: DIRECTIONS } }], usage: { in: 20_000, out: 100 } };
      if (toolNamesOf(r).includes("claim")) return { content: "waiting", delayMs: 300 };
      return { toolCalls: [{ name: "read_shard", args: { shard: r.call + 1 } }], usage: { in: 20_000, out: 100 } };
    }
    if (opts.copy) return opts.copy(r);
    // a2 waits a little, so that its siblings' first requests have reached the server when its claim ends the run.
    if (r.agentIndex === 1) return { toolCalls: [{ name: "claim", args: { answer: "4719", evidence: "shards" } }], delayMs: 200 };
    return { content: "slow", delayMs: 3_000 };
  };

/** The root reads shards and never forks, so the runtime forks for it; a2 claims with its first call; a3 and a4 are slow. */
const neverForks: Policy = (r) => {
  if (r.agentIndex === 0) {
    if (toolNamesOf(r).includes("claim")) return { content: "waiting", delayMs: 300 };
    return { toolCalls: [{ name: "read_shard", args: { shard: 2 } }], usage: { in: 20_000, out: 100 } };
  }
  if (r.agentIndex === 1) return { toolCalls: [{ name: "claim", args: { answer: "4719", evidence: "x" } }], delayMs: 200 };
  return { content: "slow", delayMs: 3_000 };
};

const ofKind = <K extends Event["kind"]>(events: Event[], kind: K) => events.filter((e): e is Extract<Event, { kind: K }> => e.kind === kind);

describe("runOnce fork", () => {
  it("fork runs end to end", async () => {
    fake = await startFakeOpenAI(forker());
    const log = new EventLog(dbPath());
    const s = await runOnce(forkConfig(fake.baseUrl, "fork"), { log });
    expect(s).toMatchObject({ reason: "solved", solved: true });
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    const cond = CONDITIONS.fork;
    const ids = ["a1", ...COPIES];
    const starts = ofKind(events, "agent_started");
    expect(starts.map((e) => [e.agent, e.index, e.seed])).toEqual([["a1", 0, 700], ["a2", 1, 701], ["a3", 2, 702], ["a4", 3, 703]]);
    expect(starts[0]!.tools).toEqual(["read_shard"]);
    expect(starts[0]!.systemPrompt).toBe(systemPrompt(cond, "a1", ids));
    for (const [i, id] of COPIES.entries()) {
      expect(starts[i + 1]!.tools).toEqual(AFTER_MESSAGING);
      expect(starts[i + 1]!.systemPrompt).toBe(systemPrompt(cond, id, ids));
    }
    const forks = ofKind(events, "fork");
    expect(forks).toEqual([expect.objectContaining({ agent: "a1", call: 2, children: COPIES, directions: DIRECTIONS, fallback: false })]);
    // The copies' agent_started come after the root's fork call, then the fork event, all before any copy's first call.
    const at = (p: (e: Event) => boolean) => events.findIndex(p);
    const forkCall = at((e) => e.kind === "model_call" && e.agent === "a1" && e.call === 2);
    const firstStart = at((e) => e.kind === "agent_started" && e.agent === "a2");
    const forkEvent = at((e) => e.kind === "fork");
    const firstCopyCall = at((e) => e.kind === "model_call" && e.agent !== "a1");
    expect(forkCall).toBeLessThan(firstStart);
    expect(at((e) => e.kind === "agent_started" && e.agent === "a4")).toBeLessThan(forkEvent);
    expect(forkEvent).toBeLessThan(firstCopyCall);

    const reqs = fake.requests;
    for (const r of reqs) expect(r.body.seed).toBe(700 + r.agentIndex);
    const rootFork = reqs.find((r) => r.agentIndex === 0 && r.call === 2)!;
    expect(told(rootFork)).toBe(true);
    const rootCtx = ctxOf(rootFork);
    for (const [i, id] of COPIES.entries()) {
      const first = reqs.find((r) => r.agentIndex === i + 1 && r.call === 0)!;
      expect(systemCount(first)).toBe(1);
      expect(toolNamesOf(first)).toEqual(AFTER_MESSAGING);
      const c = ctxOf(first);
      expect(c[0]).toEqual({ role: "system", text: systemPrompt(cond, id, ids) });
      expect(c.slice(1, rootCtx.length)).toEqual(rootCtx.slice(1));
      const rest = c.slice(rootCtx.length);
      expect(rest).toHaveLength(3);
      expect(rest[0]).toMatchObject({ role: "assistant", toolCalls: [{ name: "fork", args: { directions: DIRECTIONS } }] });
      expect(rest[1]).toEqual({ role: "tool", text: childForkResult(id), toolCallId: rest[0]!.toolCalls![0]!.id });
      expect(rest[2]).toEqual({ role: "user", text: directionMessage(DIRECTIONS[i]!) });
    }
    expect(ofKind(events, "claim_submitted").map((e) => e.agent)).toEqual(["a2"]);
  });

  it("the root works alone before the fork, then with the after-fork tools and prompt", async () => {
    fake = await startFakeOpenAI(forker({ copy: (r) => (r.agentIndex === 1 ? { toolCalls: [{ name: "claim", args: { answer: "4719", evidence: "x" } }], delayMs: 600 } : { content: "slow", delayMs: 3_000 }) }));
    const log = new EventLog(dbPath());
    const s = await runOnce(forkConfig(fake.baseUrl, "fork"), { log });
    expect(s.reason).toBe("solved");
    const root = fake.requests.filter((r) => r.agentIndex === 0);
    expect(root.map(told)).toEqual([false, false, true, false]);
    expect(root.slice(0, 2).map(toolNamesOf)).toEqual([["read_shard"], ["read_shard"]]);
    expect(toolNamesOf(root[2]!)).toEqual(["read_shard", "fork"]);
    expect(toolNamesOf(root[3]!)).toEqual(AFTER_MESSAGING);
    expect(systemCount(root[3]!)).toBe(1);
    expect(ctxOf(root[3]!)[0]).toEqual({ role: "system", text: rootPromptAfterFork(CONDITIONS.fork, ["a1", ...COPIES]) });
    expect(ctxOf(root[3]!).at(-1)).toMatchObject({ role: "tool", text: parentForkResult(COPIES, DIRECTIONS) });
  });

  it("a copy's first call reserves for the context it inherited", async () => {
    // The root's fork call costs 30,100 tokens; its earlier calls 20,100. Every call after the fork carries the root's whole context.
    const base = forker();
    fake = await startFakeOpenAI((r) => (r.agentIndex === 0 && told(r) ? { ...base(r), usage: { in: 30_000, out: 100 } } : base(r)));
    const admit = vi.spyOn(Controller.prototype, "admitCall");
    try {
      const log = new EventLog(dbPath());
      const s = await runOnce(forkConfig(fake.baseUrl, "fork-silent"), { log });
      expect(s.reason).toBe("solved");
      const prompts = admit.mock.calls.map(([, prompt]) => prompt);
      // Three root calls before the fork, then a1's next call and the copies' first calls (a2 claims with its first).
      expect(prompts.length).toBeGreaterThanOrEqual(7);
      expect(prompts.slice(0, 3).every((p) => p < 30_100)).toBe(true);
      for (const p of prompts.slice(3)) expect(p).toBeGreaterThanOrEqual(30_100);
    } finally {
      admit.mockRestore();
    }
  });

  it("a copy whose inherited context does not fit the window is refused before it calls", async () => {
    const base = forker();
    fake = await startFakeOpenAI((r) => (r.agentIndex === 0 && told(r) ? { ...base(r), usage: { in: 30_000, out: 100 } } : base(r)));
    const c = forkConfig(fake.baseUrl, "fork-silent");
    const log = new EventLog(dbPath());
    // The root's calls are estimated at about 24k (20,100 + tail + 4096); after the fork every call needs over 34k.
    const s = await runOnce({ ...c, model: { ...c.model, contextWindow: 30_000 } }, { log });
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    expect(ofKind(events, "fork")).toHaveLength(1);
    expect(fake.requests.filter((r) => r.agentIndex > 0)).toEqual([]);
    expect(ofKind(events, "agent_finished").filter((e) => e.agent !== "a1").map((e) => e.reason)).toEqual(["context", "context", "context"]);
    expect(s.reason).toBe("all_idle");
  });

  it("fork-silent copies have no communication tools", async () => {
    fake = await startFakeOpenAI(forker());
    const log = new EventLog(dbPath());
    const s = await runOnce(forkConfig(fake.baseUrl, "fork-silent"), { log });
    expect(s.reason).toBe("solved");
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    const starts = ofKind(events, "agent_started");
    expect(starts.map((e) => e.tools)).toEqual([["read_shard"], AFTER_SILENT, AFTER_SILENT, AFTER_SILENT]);
    for (const r of fake.requests.filter((r) => r.agentIndex > 0)) expect(toolNamesOf(r)).toEqual(AFTER_SILENT);
    for (const e of starts.slice(1)) expect(e.systemPrompt).not.toMatch(/\bsend\b|publish|roster/);
  });

  it("copies inherit every tool result of the fork turn", async () => {
    const forkTurn = [
      { name: "read_shard", args: { shard: 3 } },
      { name: "fork", args: { directions: DIRECTIONS } },
      { name: "read_shard", args: { shard: 5 } },
    ];
    fake = await startFakeOpenAI(forker({ forkTurn }));
    const log = new EventLog(dbPath());
    const s = await runOnce(forkConfig(fake.baseUrl, "fork-silent"), { log });
    expect(s.reason).toBe("solved");
    invariants(log.events(s.runId).map((x) => x.event));
    for (const [i, id] of COPIES.entries()) {
      const first = fake.requests.find((r) => r.agentIndex === i + 1 && r.call === 0)!;
      expect(systemCount(first)).toBe(1);
      const c = ctxOf(first);
      const turn = c.findLastIndex((m) => m.role === "assistant");
      const calls = c[turn]!.toolCalls!;
      expect(calls.map((t) => t.name)).toEqual(["read_shard", "fork", "read_shard"]);
      expect(c.slice(turn + 1)).toEqual([
        { role: "tool", text: VAULT.shards[3], toolCallId: calls[0]!.id },
        { role: "tool", text: childForkResult(id), toolCallId: calls[1]!.id },
        { role: "tool", text: VAULT.shards[5], toolCallId: calls[2]!.id },
        { role: "user", text: directionMessage(DIRECTIONS[i]!) },
      ]);
    }
  });

  it("a message sent before a sibling's first call is delivered", async () => {
    const note = "Shard 7 gives the fourth digit: 9.";
    fake = await startFakeOpenAI(
      forker({
        copy: (r) => {
          if (r.agentIndex === 1) return r.call === 0 ? { toolCalls: [{ name: "send", args: { to: "a4", text: note } }] } : { content: "done" };
          if (r.agentIndex === 3) {
            if (r.call === 0) return { toolCalls: [{ name: "read_shard", args: { shard: 2 } }], delayMs: 400 };
            return lastUserText(r).includes(note) ? { toolCalls: [{ name: "claim", args: { answer: "4719", evidence: "a2's message" } }] } : { content: "?" };
          }
          return { content: "nothing" };
        },
      }),
    );
    const log = new EventLog(dbPath());
    const s = await runOnce(forkConfig(fake.baseUrl, "fork"), { log });
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    expect(ofKind(events, "fork")).toHaveLength(1);
    const sent = ofKind(events, "message").find((e) => e.from === "a2")!;
    expect(sent).toMatchObject({ to: "a4", recipients: ["a4"] });
    // a4 had not finished its first call when the message was sent.
    expect(events.indexOf(sent)).toBeLessThan(events.findIndex((e) => e.kind === "model_call" && e.agent === "a4"));
    expect(ofKind(events, "message_delivered").filter((e) => e.agent === "a4").map((e) => e.messageId)).toEqual([sent.id]);
    expect(s.reason).toBe("solved");
  });

  it("no copy calls after the run ends during the fork turn", async () => {
    fake = await startFakeOpenAI((r) => {
      if (r.agentIndex !== 0) return { content: "copy" };
      if (told(r)) return { toolCalls: [{ name: "fork", args: { directions: DIRECTIONS } }, { name: "read_shard", args: { shard: 1 } }] };
      return { content: "thinking" };
    });
    const log = new EventLog(dbPath());
    const t = Date.now();
    const s = await runOnce(forkConfig(fake.baseUrl, "fork", { wallClockMs: 400, toolDelayMs: 3_000 }), { log });
    expect(s.reason).toBe("killed");
    expect(Date.now() - t).toBeLessThan(2_500);
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    expect(ofKind(events, "agent_started").map((e) => e.agent)).toEqual(["a1"]);
    expect(ofKind(events, "fork")).toEqual([]);
    const n = fake.requests.length;
    await sleep(300);
    expect(fake.requests.length).toBe(n);
    expect(fake.requests.every((r) => r.agentIndex === 0)).toBe(true);
  });

  it("no copy calls after the run ends while the copies' first calls are in flight", async () => {
    fake = await startFakeOpenAI((r) => {
      if (r.agentIndex !== 0) return { content: "copy", delayMs: 3_000 };
      if (told(r)) return { toolCalls: [{ name: "fork", args: { directions: DIRECTIONS } }] };
      if (toolNamesOf(r).includes("claim")) return { content: "waiting", delayMs: 3_000 };
      return { content: "thinking" };
    });
    const log = new EventLog(dbPath());
    const t = Date.now();
    const s = await runOnce(forkConfig(fake.baseUrl, "fork", { wallClockMs: 500 }), { log });
    expect(s.reason).toBe("killed");
    expect(Date.now() - t).toBeLessThan(2_500);
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    expect(ofKind(events, "agent_started").map((e) => e.agent)).toEqual(["a1", ...COPIES]);
    expect(ofKind(events, "fork")).toHaveLength(1);
    expect(ofKind(events, "agent_finished").map((e) => e.agent).sort()).toEqual(["a1", ...COPIES]);
    const n = fake.requests.length;
    await sleep(300);
    expect(fake.requests.length).toBe(n);
    expect(fake.requests.filter((r) => r.agentIndex > 0).map((r) => r.call)).toEqual([0, 0, 0]);
  });

  it("fallback fork run", async () => {
    fake = await startFakeOpenAI(neverForks);
    const log = new EventLog(dbPath());
    const s = await runOnce(forkConfig(fake.baseUrl, "fork"), { log });
    expect(s.reason).toBe("solved");
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    const generic = [GENERIC_DIRECTION, GENERIC_DIRECTION, GENERIC_DIRECTION];
    expect(ofKind(events, "fork")).toEqual([expect.objectContaining({ agent: "a1", call: 3, children: COPIES, directions: generic, fallback: true })]);
    const lastRootCall = ofKind(events, "model_call").filter((e) => e.agent === "a1" && events.indexOf(e) < events.findIndex((x) => x.kind === "fork")).at(-1)!;
    expect(lastRootCall.call).toBe(3);
    for (const i of [1, 2, 3]) {
      const first = fake.requests.find((r) => r.agentIndex === i && r.call === 0)!;
      expect(systemCount(first)).toBe(1);
      const c = ctxOf(first);
      expect(c.at(-1)).toEqual({ role: "user", text: directionMessage(GENERIC_DIRECTION) });
      expect(c.at(-2)).toMatchObject({ role: "tool", text: VAULT.shards[2] });
      expect(c.some((m) => m.toolCalls?.some((t) => t.name === "fork"))).toBe(false);
    }
    expect(ofKind(events, "runtime_note").map((e) => e.text)).toEqual([forkInstruction(), fallbackNotice(COPIES)]);
  });
});

const VALID_FORK = { name: "fork", args: { directions: DIRECTIONS } };
const MSG_TO_A4 = "Shard 7 gives the fourth digit: 9.";
/** After the fork, a2 messages a4 and the root; a4 claims once a2's message is in its context; the root keeps waiting. */
const messagesAfterFork = forker({
  copy: (r) => {
    if (r.agentIndex === 1) return r.call === 0 ? { toolCalls: [{ name: "send", args: { to: "a4", text: MSG_TO_A4 } }, { name: "send", args: { to: "a1", text: "a2 is on shard 1." } }] } : { content: "done" };
    if (r.agentIndex === 3) {
      if (r.call === 0) return { toolCalls: [{ name: "read_shard", args: { shard: 2 } }], delayMs: 1500 };
      return lastUserText(r).includes(MSG_TO_A4) ? { toolCalls: [{ name: "claim", args: { answer: "4719", evidence: "a2's message" } }] } : { content: "?" };
    }
    return { content: "nothing" };
  },
});

describe("rebuilds every agent's context in fork and fork-silent runs", () => {
  const cases: { name: string; condition: ConditionName; policy: Policy; over?: Partial<RunConfig>; check: (events: Event[]) => void }[] = [
    { name: "fork", condition: "fork", policy: forker(), check: (ev) => expect(ofKind(ev, "fork")).toEqual([expect.objectContaining({ call: 2, fallback: false })]) },
    { name: "fork-silent", condition: "fork-silent", policy: forker(), check: (ev) => expect(ofKind(ev, "fork")).toEqual([expect.objectContaining({ call: 2, fallback: false })]) },
    { name: "a fallback", condition: "fork", policy: neverForks, check: (ev) => expect(ofKind(ev, "fork")).toEqual([expect.objectContaining({ call: 3, fallback: true })]) },
    { name: "a fork turn [fork, read_shard]", condition: "fork-silent", policy: forker({ forkTurn: [VALID_FORK, { name: "read_shard", args: { shard: 5 } }] }), check: (ev) => expect(ofKind(ev, "fork")).toHaveLength(1) },
    { name: "a fork turn [read_shard, fork]", condition: "fork", policy: forker({ forkTurn: [{ name: "read_shard", args: { shard: 3 } }, VALID_FORK] }), check: (ev) => expect(ofKind(ev, "fork")).toHaveLength(1) },
    {
      name: "a fork turn with a malformed fork before the valid one",
      condition: "fork-silent",
      policy: forker({ forkTurn: [{ name: "fork", args: { directions: ["one", "two"] } }, VALID_FORK] }),
      check: (ev) => {
        expect(ofKind(ev, "fork")).toEqual([expect.objectContaining({ fallback: false })]);
        expect(ofKind(ev, "tool_result").filter((e) => e.tool === "fork").map((e) => e.isError)).toEqual([true, false]);
      },
    },
    {
      name: "messages delivered after the fork",
      condition: "fork",
      policy: messagesAfterFork,
      check: (ev) => expect(new Set(ofKind(ev, "message_delivered").map((e) => e.agent))).toEqual(new Set(["a1", "a4"])),
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      fake = await startFakeOpenAI(c.policy);
      const log = new EventLog(dbPath());
      const s = await runOnce(forkConfig(fake.baseUrl, c.condition, c.over), { log });
      expect(s.reason).toBe("solved");
      const events = log.events(s.runId).map((x) => x.event);
      invariants(events);
      c.check(events);
      const reqs = fake.requests;
      // Every agent made a request, and the root made one after the fork, under its after-fork prompt.
      expect(new Set(reqs.map((r) => r.agentIndex))).toEqual(new Set([0, 1, 2, 3]));
      const fork = ofKind(events, "fork")[0]!;
      expect(reqs.some((r) => r.agentIndex === 0 && r.call > fork.call)).toBe(true);
      for (const r of reqs) expect(contextBeforeCall(events, `a${r.agentIndex + 1}`, r.call), `a${r.agentIndex + 1} call ${r.call}`).toEqual(ctxOf(r));
    });
  }

  it("a run that ends during the fork turn (the root's fork result, but no fork event)", async () => {
    fake = await startFakeOpenAI((r) => {
      if (told(r)) return { toolCalls: [VALID_FORK, { name: "read_shard", args: { shard: 1 } }] };
      return { content: "thinking" };
    });
    const log = new EventLog(dbPath());
    const s = await runOnce(forkConfig(fake.baseUrl, "fork", { wallClockMs: 400, toolDelayMs: 3_000 }), { log });
    expect(s.reason).toBe("killed");
    const events = log.events(s.runId).map((x) => x.event);
    expect(ofKind(events, "fork")).toEqual([]);
    expect(ofKind(events, "tool_result").filter((e) => e.tool === "fork").map((e) => e.text)).toEqual([parentForkResult(COPIES, DIRECTIONS)]);
    const reqs = fake.requests;
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) expect(contextBeforeCall(events, `a${r.agentIndex + 1}`, r.call), `a${r.agentIndex + 1} call ${r.call}`).toEqual(ctxOf(r));
  });
});
