import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { readFileSync } from "node:fs";

export interface ModelConfig {
  baseUrl: string;
  id: string;
  hfRepo: string;
  revision: string;
  contextWindow: number;
  maxTokens: number;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  timeoutMs: number;
  maxRetries: number;
}

export interface ModelRuntime {
  model: Model<"openai-completions">;
  /** `maxTokens`, when given, is read per call (the hard budget); otherwise every call may use the model's maxTokens. */
  streamFor(seed: number, maxTokens?: () => number): StreamFn;
}

const PROVIDER = "spark";

/** Sampling for every call, shared with the oracle screen (prep/polyprep/model.py) through suites/sampling.json. */
export const SAMPLING = (({ temperature, top_p, top_k, min_p }) => ({ temperature, top_p, top_k, min_p }))(
  JSON.parse(readFileSync(new URL("../../../../suites/sampling.json", import.meta.url), "utf8")) as { temperature: number; top_p: number; top_k: number; min_p: number },
);

export function makeModelRuntime(cfg: ModelConfig): ModelRuntime {
  const model: Model<"openai-completions"> = {
    id: cfg.id,
    name: cfg.id,
    api: "openai-completions",
    provider: PROVIDER,
    baseUrl: cfg.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: PROVIDER,
      name: "DGX Spark (vLLM)",
      baseUrl: cfg.baseUrl,
      auth: { apiKey: { name: "vLLM", resolve: async () => ({ auth: {} }) } },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  return {
    model,
    streamFor: (seed, maxTokens) => (m, context, options) =>
      models.streamSimple(m, context, {
        ...options,
        ...(maxTokens ? { maxTokens: maxTokens() } : {}),
        apiKey: "none",
        temperature: SAMPLING.temperature,
        maxRetries: cfg.maxRetries,
        timeoutMs: cfg.timeoutMs,
        onPayload: (payload) => ({
          ...(payload as Record<string, unknown>),
          top_p: SAMPLING.top_p,
          top_k: SAMPLING.top_k,
          min_p: SAMPLING.min_p,
          seed,
          chat_template_kwargs: { reasoning_effort: cfg.reasoningEffort },
        }),
      }),
  };
}

const PREFLIGHT_TIMEOUT_MS = 10_000;

export async function checkServer(cfg: ModelConfig, fetchFn: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(`${cfg.baseUrl}/models`, { signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    const cause = err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message;
    throw new Error(`model server at ${cfg.baseUrl} is unreachable: ${cause}`);
  }
  if (!res.ok) throw new Error(`model server at ${cfg.baseUrl} answered ${res.status}`);
  let body: { data?: unknown };
  try {
    body = (await res.json()) as { data?: unknown };
  } catch {
    throw new Error(`model server at ${cfg.baseUrl} answered with a body that is not JSON`);
  }
  if (!body || !Array.isArray(body.data)) {
    throw new Error(`model server at ${cfg.baseUrl} answered /models without a "data" list`);
  }
  const models = body.data as { id: string; root?: string }[];
  const served = models.find((m) => m.id === cfg.id);
  if (!served) throw new Error(`model server at ${cfg.baseUrl} does not serve "${cfg.id}" (serves ${models.map((m) => m.id).join(", ")})`);
  if (served.root !== cfg.hfRepo) throw new Error(`model "${cfg.id}" serves ${served.root}, expected ${cfg.hfRepo}`);
}

export function samplingRecord(cfg: ModelConfig): Record<string, unknown> {
  return { ...SAMPLING, reasoningEffort: cfg.reasoningEffort, maxTokens: cfg.maxTokens, maxRetries: cfg.maxRetries, timeoutMs: cfg.timeoutMs };
}
