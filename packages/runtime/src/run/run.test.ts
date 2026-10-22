import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConditionName, Event } from "@polylogue/schema";
import { runOnce } from "./run.ts";
import { parseConfig, configHash, type RunConfig } from "../config.ts";
import { EventLog } from "../log/event-log.ts";
import { CONDITIONS, NORMS } from "../conditions.ts";
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
  for (const condition of Object.keys(CONDITIONS) as ConditionName[]) {
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
