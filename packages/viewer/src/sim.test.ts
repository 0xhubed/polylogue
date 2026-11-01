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

  for (const c of ["fork", "fork-silent"] as const) {
    describe(`the simulated ${c} run`, () => {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        it(`is valid and has one root, then one fork at about 10% of the run (seed ${seed})`, () => {
          const events = simulate(c, seed);
          for (const e of events) expect(() => Event.parse(e)).not.toThrow();
          expect(events.map((e) => e.t)).toEqual([...events.map((e) => e.t)].sort((a, b) => a - b));
          expect(events.at(-1)!.kind).toBe("run_finished");
          const forks = events.filter((e) => e.kind === "fork");
          expect(forks).toHaveLength(1);
          const fork = forks[0]!;
          if (fork.kind !== "fork") throw new Error("unreachable");
          expect(fork).toMatchObject({ agent: "a1", children: ["a2", "a3", "a4"], fallback: false });
          expect(fork.directions).toHaveLength(3);
          const duration = events.at(-1)!.t;
          expect(fork.t).toBeGreaterThan(0.03 * duration);
          expect(fork.t).toBeLessThan(0.2 * duration);
          const idx = events.indexOf(fork);
          // Only the root exists before the fork; the copies start right before the fork event.
          expect(events.slice(0, idx).filter((e) => e.kind === "agent_started").map((e) => e.kind === "agent_started" && e.agent)).toEqual(["a1", "a2", "a3", "a4"]);
          expect(events.filter((e) => e.kind === "agent_started" && e.t < fork.t).map((e) => e.kind === "agent_started" && e.agent)).toEqual(["a1"]);
          for (const e of events) if ("agent" in e && e.agent !== "a1" && e.kind !== "fork") expect(e.t).toBeGreaterThanOrEqual(fork.t);
          expect(events.some((e) => e.kind === "blackboard")).toBe(false);
          const messages = events.filter((m) => m.kind === "message");
          for (const m of messages) expect(m.t).toBeGreaterThanOrEqual(fork.t);
          const started = events.find((e) => e.kind === "run_started");
          expect(started?.kind === "run_started" && started.condition).toBe(c);
        });
      }
    });
  }

  it("fork has messaging after the fork across seeds; fork-silent has none", () => {
    const count = (c: ConditionName) => [1, 2, 3, 4, 5, 6, 7, 8].reduce((n, s) => n + simulate(c, s).filter((e) => e.kind === "message" || e.kind === "message_delivered").length, 0);
    expect(count("fork")).toBeGreaterThan(0);
    expect(count("fork-silent")).toBe(0);
  });

  it("is deterministic per seed and differs across seeds", () => {
    expect(simulate("polylogue", 5)).toEqual(simulate("polylogue", 5));
    expect(simulate("polylogue", 5)).not.toEqual(simulate("polylogue", 6));
  });
});
