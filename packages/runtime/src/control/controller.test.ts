import { describe, expect, it } from "vitest";
import type { EventInput } from "@polylogue/schema";
import { Controller, type ControlledAgent } from "./controller.ts";
import { FakeClock } from "../clock.ts";

function setup(over: Partial<{ pool: number; wallClockMs: number; messagesPerMinute: number; maxMessageChars: number; contextWindow: number; firstClaimEnds: boolean }> = {}) {
  const clock = new FakeClock();
  const logged: EventInput[] = [];
  const c = new Controller(
    { pool: 1000, wallClockMs: 60_000, messagesPerMinute: 2, maxMessageChars: 20, contextWindow: 5000, ...over },
    { log: (e) => logged.push(e), clock, verify: (a) => ({ passed: a.trim() === "4719", detail: a.trim() === "4719" ? undefined : "wrong code" }) },
  );
  return { c, clock, logged };
}
const agent = (id: string, s: { finished?: boolean; idle?: boolean }): ControlledAgent => ({
  id, isFinished: () => s.finished ?? false, isIdleWithNothingPending: () => s.idle ?? false,
});

describe("Controller", () => {
  it("refuses calls once the pool is spent and ends the run with budget", async () => {
    const { c } = setup({ pool: 100 });
    expect(await c.admitCall(10, 10, 20)).toBe(20);
    c.settle(30, 60);
    expect(await c.admitCall(10, 10, 20)).toBe(20);
    c.settle(30, 60);
    expect(await c.admitCall(10, 10, 20)).toBe("budget");
    expect(await c.done).toBe("budget");
    expect(await c.admitCall(10, 10, 20)).toBe("ended");
  });

  it("refuses a call whose estimate exceeds the context window without ending the run", async () => {
    const { c } = setup({ contextWindow: 5000 });
    expect(await c.admitCall(5001, 4000, 1001)).toBe("context");
    expect(c.ended).toBeNull();
  });

  it("alone, a call gets what the pool has left after its prompt; a prompt that does not fit ends the run with budget", async () => {
    const { c } = setup({ pool: 100 });
    expect(await c.admitCall(1020, 20, 1000)).toBe(80);
    c.settle(100, 70);
    expect(await c.admitCall(1030, 30, 1000)).toBe("budget");
    expect(await c.done).toBe("budget");
  });

  it("reserves prompt and output: with calls in flight, a call that does not fit waits for them, then takes what is left", async () => {
    const { c } = setup({ pool: 1000 });
    expect(await c.admitCall(800, 300, 500)).toBe(500);
    let second: number | string | undefined;
    const waiting = c.admitCall(800, 300, 500).then((r) => (second = r));
    await Promise.resolve();
    expect(second).toBeUndefined();
    c.settle(800, 400);
    await waiting;
    expect(second).toBe(300);
  });

  it("a call waiting for room is told when the run ends", async () => {
    const { c } = setup({ pool: 1000 });
    await c.admitCall(800, 300, 500);
    const waiting = c.admitCall(800, 300, 500);
    c.end("killed");
    expect(await waiting).toBe("ended");
  });

  it("ends the run with killed at the wall-clock limit", async () => {
    const { c, clock } = setup({ wallClockMs: 1000 });
    c.start();
    clock.advance(999);
    expect(c.ended).toBeNull();
    clock.advance(1);
    expect(await c.done).toBe("killed");
  });

  it("rate-limits messages per agent per minute and by length", () => {
    const { c, clock } = setup({ messagesPerMinute: 2, maxMessageChars: 20 });
    expect(c.checkMessage("a1", "x".repeat(21))).toMatch(/at most 20 characters/);
    expect(c.checkMessage("a1", "one")).toBeNull();
    expect(c.checkMessage("a1", "two")).toBeNull();
    expect(c.checkMessage("a1", "three")).toMatch(/at most 2 messages per minute/);
    expect(c.checkMessage("a2", "other agent")).toBeNull();
    clock.advance(60_000);
    expect(c.checkMessage("a1", "later")).toBeNull();
  });

  it("without a team answer (isolated: agents cannot see each other), a wrong claim does not end the run and a later pass solves it", async () => {
    const { c, logged } = setup({ firstClaimEnds: false });
    expect(c.claim("a1", "1234", "guess")).toBe("Claim submitted.");
    expect(c.ended).toBeNull();
    expect(() => c.claim("a1", "4719", "again")).toThrow(/already submitted a claim/);
    expect(c.claim("a2", "4719", "shards")).toBe("Claim submitted.");
    expect(await c.done).toBe("solved");
    expect(logged.filter((e) => e.kind === "verification")).toHaveLength(2);
  });

  it("the first claim ends the run: solved when it passes, wrong_claim when it does not; the agent is told nothing", async () => {
    const pass = setup();
    expect(pass.c.claim("a2", " 4719 ", "shards")).toBe("Claim submitted.");
    expect(await pass.c.done).toBe("solved");
    expect(pass.logged).toEqual([
      { kind: "claim_submitted", agent: "a2", answer: " 4719 ", evidence: "shards" },
      { kind: "verification", claimOf: "a2", passed: true },
    ]);
    const fail = setup();
    expect(fail.c.claim("a1", "1234", "guess")).toBe("Claim submitted.");
    expect(await fail.c.done).toBe("wrong_claim");
    expect(fail.logged).toEqual([
      { kind: "claim_submitted", agent: "a1", answer: "1234", evidence: "guess" },
      { kind: "verification", claimOf: "a1", passed: false, detail: "wrong code" },
    ]);
    expect(() => fail.c.claim("a2", "4719", "late")).toThrow(/run has ended/);
  });

  it("ends all_idle only when every agent is finished or idle with nothing pending", async () => {
    const { c } = setup();
    const s1 = { finished: true }, s2 = { idle: true }, s3 = { idle: false };
    c.register(agent("a1", s1));
    c.register(agent("a2", s2));
    c.register(agent("a3", s3));
    c.checkAllIdle();
    expect(c.ended).toBeNull();
    s3.idle = true;
    c.checkAllIdle();
    expect(await c.done).toBe("all_idle");
  });

  it("keeps the first end reason", async () => {
    const { c } = setup();
    c.infraError("boom");
    c.end("solved");
    expect(await c.done).toBe("infra_error");
    expect(c.ended).toBe("infra_error");
  });
});
