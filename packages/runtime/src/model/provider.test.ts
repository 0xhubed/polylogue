import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { checkServer, makeModelRuntime, samplingRecord } from "./provider.ts";
import { startFakeOpenAI, testModelConfig, type FakeServer } from "../testing/fake-openai.ts";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("model provider", () => {
  it("sends the pinned sampling (T 0.6, top_p 0.95, top_k 20, min_p 0), the agent's seed and the pinned chat_template_kwargs", async () => {
    fake = await startFakeOpenAI(() => ({ content: "hello" }));
    const rt = makeModelRuntime(testModelConfig(fake.baseUrl, { reasoningEffort: "medium" }));
    const agent = new Agent({ initialState: { systemPrompt: "You are a1.", model: rt.model, thinkingLevel: "off", tools: [] }, streamFn: rt.streamFor(1702) });
    await agent.prompt("hi");
    const body = fake.requests[0]!.body;
    expect(body.temperature).toBe(0.6);
    expect(body.top_p).toBe(0.95);
    expect(body.top_k).toBe(20);
    expect(body.min_p).toBe(0);
    expect(body.seed).toBe(1702);
    expect(body.chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
    expect(body.model).toBe("qwen3.8-27b");
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a1." });
    expect(fake.requests[0]!.agentIndex).toBe(2);
    const last = agent.state.messages.at(-1) as { usage: { input: number; output: number } };
    expect(last.usage.input).toBe(100);
    expect(last.usage.output).toBe(20);
  });

  it("retries transport errors maxRetries times, then reports an error message", async () => {
    fake = await startFakeOpenAI(() => ({ status: 500 }));
    const rt = makeModelRuntime(testModelConfig(fake.baseUrl, { maxRetries: 2 }));
    const agent = new Agent({ initialState: { systemPrompt: "s", model: rt.model, thinkingLevel: "off", tools: [] }, streamFn: rt.streamFor(100) });
    await agent.prompt("hi");
    expect(fake.requests).toHaveLength(3);
    expect((agent.state.messages.at(-1) as { stopReason: string }).stopReason).toBe("error");
  });

  it("checks the served model id and repository", async () => {
    fake = await startFakeOpenAI(() => ({}), { modelId: "qwen3.8-27b", root: "unsloth/Qwen3.8-27B-NVFP4" });
    await expect(checkServer(testModelConfig(fake.baseUrl))).resolves.toBeUndefined();
    await expect(checkServer(testModelConfig(fake.baseUrl, { id: "other" }))).rejects.toThrow(/does not serve "other"/);
    await expect(checkServer(testModelConfig(fake.baseUrl, { hfRepo: "x/y" }))).rejects.toThrow(/serves unsloth\/Qwen3.8-27B-NVFP4, expected x\/y/);
  });

  it("explains an unreachable or malformed model server", async () => {
    const cfg = testModelConfig("http://x/v1");
    const down = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });
    }) as typeof fetch;
    await expect(checkServer(cfg, down)).rejects.toThrow(/model server at http:\/\/x\/v1 is unreachable: fetch failed: connect ECONNREFUSED/);
    const notJson = (async () => new Response("<html>nope</html>")) as typeof fetch;
    await expect(checkServer(cfg, notJson)).rejects.toThrow(/not JSON/);
    const noData = (async () => new Response("{}")) as typeof fetch;
    await expect(checkServer(cfg, noData)).rejects.toThrow(/without a "data" list/);
    const nullBody = (async () => new Response("null")) as typeof fetch;
    await expect(checkServer(cfg, nullBody)).rejects.toThrow(/without a "data" list/);
  });

  it("records the sampling settings", () => {
    expect(samplingRecord(testModelConfig("http://x/v1"))).toEqual({ temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, reasoningEffort: "medium", maxTokens: 4096, maxRetries: 0, timeoutMs: 30000 });
  });
});
