import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelConfig } from "../model/provider.ts";

export interface FakeReply {
  content?: string;
  reasoning?: string;
  toolCalls?: { name: string; args: unknown }[];
  delayMs?: number;
  /** finish_reason to report; default "tool_calls" with tool calls, else "stop". */
  finishReason?: string;
  status?: number;
  /** in = prompt_tokens; cached, when set, is reported as prompt_tokens_details.cached_tokens. */
  usage?: { in: number; out: number; cached?: number };
}
export interface FakeRequest {
  agentIndex: number;
  call: number;
  // biome-ignore lint: request bodies are arbitrary JSON
  body: any;
}
export type Policy = (req: FakeRequest) => FakeReply;
export interface FakeServer {
  baseUrl: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeOpenAI(
  policy: Policy,
  opts: { modelId?: string; root?: string } = {},
): Promise<FakeServer> {
  const modelId = opts.modelId ?? "qwen3.8-27b";
  const root = opts.root ?? "unsloth/Qwen3.8-27B-NVFP4";
  const requests: FakeRequest[] = [];
  const perAgent = new Map<number, number>();

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model", root }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const agentIndex = typeof body.seed === "number" ? body.seed % 100 : -1;
    const call = perAgent.get(agentIndex) ?? 0;
    perAgent.set(agentIndex, call + 1);
    const request = { agentIndex, call, body };
    requests.push(request);
    const reply = policy(request);
    if (reply.delayMs) await sleep(reply.delayMs);
    if (reply.status && reply.status >= 400) {
      res.statusCode = reply.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: `fake error ${reply.status}` } }));
      return;
    }
    const usage = {
      prompt_tokens: reply.usage?.in ?? 100,
      completion_tokens: reply.usage?.out ?? 20,
      ...(reply.usage?.cached !== undefined ? { prompt_tokens_details: { cached_tokens: reply.usage.cached } } : {}),
    };
    const id = `fake-${agentIndex}-${call}`;
    const toolCalls = (reply.toolCalls ?? []).map((tc, i) => ({
      index: i,
      id: `call_${agentIndex}_${call}_${i}`,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
    res.setHeader("content-type", "text/event-stream");
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const base = { id, object: "chat.completion.chunk", model: modelId };
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant" } }] });
    if (reply.reasoning) send({ ...base, choices: [{ index: 0, delta: { reasoning_content: reply.reasoning } }] });
    if (reply.content) send({ ...base, choices: [{ index: 0, delta: { content: reply.content } }] });
    for (const tc of toolCalls) send({ ...base, choices: [{ index: 0, delta: { tool_calls: [tc] } }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason ?? (toolCalls.length ? "tool_calls" : "stop") }] });
    send({ ...base, choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
    res.end("data: [DONE]\n\n");
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

export function testModelConfig(baseUrl: string, over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    baseUrl,
    id: "qwen3.8-27b",
    hfRepo: "unsloth/Qwen3.8-27B-NVFP4",
    revision: "7d6f8d4d72f56b92b3cdbf22f156b90e1bab0108",
    contextWindow: 262144,
    maxTokens: 4096,
    reasoningEffort: "medium",
    timeoutMs: 30_000,
    maxRetries: 0,
    ...over,
  };
}
