import { createHash } from "node:crypto";
import { z } from "zod";
import { ConditionName } from "@polylogue/schema";

export const SuiteId = z.enum(["toy", "bcp", "ledger", "math"]);
export type SuiteId = z.infer<typeof SuiteId>;

export const RunConfig = z.object({
  runId: z.string().optional(),
  condition: ConditionName,
  taskId: z.string(),
  suite: SuiteId.default("toy"),
  dataDir: z.string().default("data"),
  seed: z.number().int().nonnegative(),
  budget: z.object({ tokensPerAgent: z.number().int().positive() }),
  wallClockMs: z.number().int().positive(),
  rate: z.object({ messagesPerMinute: z.number().int().positive(), maxMessageChars: z.number().int().positive() }),
  toolDelayMs: z.number().int().nonnegative().default(0),
  checkServer: z.boolean().default(true),
  model: z.object({
    baseUrl: z.string().url(),
    id: z.string(),
    hfRepo: z.string(),
    revision: z.string(),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
  }),
});
export type RunConfig = z.infer<typeof RunConfig>;

export function parseConfig(raw: unknown): RunConfig {
  return RunConfig.parse(raw);
}

export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Hash of everything that defines the run except its id and where its data lives. */
export function configHash(cfg: RunConfig): string {
  const { runId: _id, dataDir: _dir, ...rest } = cfg;
  return `sha256:${createHash("sha256").update(stableJson(rest)).digest("hex")}`;
}
