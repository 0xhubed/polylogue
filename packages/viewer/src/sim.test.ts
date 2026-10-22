import { describe, expect, it } from "vitest";
import { Event, type ConditionName } from "@polylogue/schema";
import { simulate } from "./sim.ts";

const CONDS: ConditionName[] = ["single", "isolated", "stigmergic", "polylogue", "polylogue-bare"];

describe("simulate", () => {
  for (const c of CONDS) {
    it(`produces a valid, ordered, finished ${c} run`, () => {
      const events = simulate(c, 3);
      for (const e of events) expect(() => Event.parse(e)).not.toThrow();
      expect(events.map((e) => e.t)).toEqual([...events.map((e) => e.t)].sort((a, b) => a - b));
      expect(events.filter((e) => e.kind === "run_finished")).toHaveLength(1);
      expect(events.at(-1)!.kind).toBe("run_finished");
      const fin = events.at(-1)!;
      const tokens = events.reduce((n, e) => n + (e.kind === "model_call" ? e.tokensIn + e.tokensOut : 0), 0);
      expect(fin.kind === "run_finished" && fin.totalTokens).toBe(tokens);
      const hasMessages = events.some((e) => e.kind === "message");
      const hasBoard = events.some((e) => e.kind === "blackboard");
      expect(hasMessages).toBe(c.startsWith("polylogue"));
      if (c === "single" || c === "isolated") expect(hasBoard).toBe(false);
    });
  }

  it("is deterministic per seed and differs across seeds", () => {
    expect(simulate("polylogue", 5)).toEqual(simulate("polylogue", 5));
    expect(simulate("polylogue", 5)).not.toEqual(simulate("polylogue", 6));
  });
});
