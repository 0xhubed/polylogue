import { z } from "zod";
import { ConditionName } from "@polylogue/schema";
import { RunConfig, SuiteId, parseConfig } from "../config.ts";

export const Matrix = z.object({
  name: z.string().min(1),
  orderSeed: z.number().int(),
  dataDir: z.string().default("data"),
  servers: z.array(z.string().url()).min(1),
  conditions: z.array(ConditionName).min(1),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  suites: z
    .array(
      z.object({
        suite: SuiteId,
        split: z.enum(["pilot", "scored"]),
        tasks: z.array(z.string()).optional(),
        tokensPerAgent: z.number().int().positive(),
        wallClockMs: z.number().int().positive(),
      }),
    )
    .min(1),
  rate: RunConfig.shape.rate,
  toolDelayMs: z.number().int().nonnegative().default(0),
  model: RunConfig.shape.model.omit({ baseUrl: true }),
}).superRefine((m, ctx) => {
  const dup = m.servers.find((s, i) => m.servers.indexOf(s) !== i);
  if (dup) ctx.addIssue({ code: "custom", path: ["servers"], message: `duplicate server ${dup}: each server gets one worker, list it once` });
});
export type Matrix = z.infer<typeof Matrix>;

export interface Cell {
  id: string;
  suite: SuiteId;
  taskId: string;
  condition: ConditionName;
  seed: number;
  tokensPerAgent: number;
  wallClockMs: number;
}

export function expandMatrix(m: Matrix, list: (suite: SuiteId, split: "pilot" | "scored") => string[]): Cell[] {
  const cells: Cell[] = [];
  for (const s of m.suites) {
    for (const taskId of s.tasks ?? list(s.suite, s.split)) {
      for (const condition of m.conditions) {
        for (const seed of m.seeds) {
          cells.push({ id: `${s.suite}-${taskId}-${condition}-s${seed}`, suite: s.suite, taskId, condition, seed, tokensPerAgent: s.tokensPerAgent, wallClockMs: s.wallClockMs });
        }
      }
    }
  }
  const seen = new Set<string>();
  for (const c of cells) {
    if (seen.has(c.id)) throw new Error(`Duplicate cell ${c.id}: a suite, task, condition or seed is listed twice in the matrix.`);
    seen.add(c.id);
  }
  return cells;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function toRunConfig(m: Matrix, cell: Cell, baseUrl: string, runId: string): RunConfig {
  return parseConfig({
    runId, condition: cell.condition, suite: cell.suite, taskId: cell.taskId, dataDir: m.dataDir, seed: cell.seed,
    budget: { tokensPerAgent: cell.tokensPerAgent }, wallClockMs: cell.wallClockMs, rate: m.rate, toolDelayMs: m.toolDelayMs,
    checkServer: true, model: { ...m.model, baseUrl },
  });
}
