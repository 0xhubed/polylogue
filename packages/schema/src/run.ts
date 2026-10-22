import { z } from "zod";
import { ConditionName, RunEndReason } from "./events.ts";

export const RunStatus = z.enum(["running", "solved", "unsolved", "infra_error"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunRow = z.object({
  id: z.string(),
  condition: ConditionName,
  n: z.number().int().positive(),
  taskId: z.string(),
  seed: z.number().int().nonnegative(),
  model: z.string(),
  revision: z.string(),
  sampling: z.record(z.string(), z.unknown()),
  configHash: z.string(),
  gitSha: z.string().nullable(),
  status: RunStatus,
  endReason: RunEndReason.nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type RunRow = z.infer<typeof RunRow>;
