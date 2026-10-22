import { Type } from "typebox";
import type { WorkTool } from "../tools/work-tool.ts";

export interface ToyTask {
  id: string;
  prompt: string;
  shards: Record<number, string>;
  verify(answer: string): { passed: boolean; detail?: string };
}

const CODE = "4719";

export const VAULT: ToyTask = {
  id: "toy-vault",
  prompt: "Find the 4-digit vault code. The case file has 8 shards, numbered 1 to 8; read them with read_shard. Each digit of the code is stated in one shard; the other shards are irrelevant.",
  shards: {
    1: "The first digit of the vault code is 4.",
    2: "The cafeteria menu changes every Monday.",
    3: "The third digit of the vault code is 1.",
    4: "The old vault code 9999 was retired in 2019 and is no longer valid.",
    5: "The second digit of the vault code is 7.",
    6: "Visitors must sign in at the front desk.",
    7: "The fourth digit of the vault code is 9.",
    8: "The vault is inspected twice a year.",
  },
  verify(answer) {
    const digits = answer.replace(/\D/g, "");
    return digits === CODE ? { passed: true } : { passed: false, detail: `expected ${CODE}, got ${digits || "(no digits)"}` };
  },
};

export const TASKS: Record<string, ToyTask> = { [VAULT.id]: VAULT };

export function readShardTool(task: ToyTask, delayMs: number): WorkTool {
  const count = Object.keys(task.shards).length;
  return {
    name: "read_shard",
    description: `Read one shard of the case file (1 to ${count}).`,
    parameters: Type.Object({ shard: Type.Integer() }),
    run: (args: { shard: number }, signal) =>
      new Promise((resolve, reject) => {
        const body = task.shards[args.shard];
        if (body === undefined) return reject(new Error(`Shards are numbered 1 to ${count}.`));
        if (signal?.aborted) return reject(new Error("aborted"));
        const h = setTimeout(() => resolve(body), delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(h);
          reject(new Error("aborted"));
        });
      }),
  };
}
