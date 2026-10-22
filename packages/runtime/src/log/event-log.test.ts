import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { EventLog, type NewRun } from "./event-log.ts";
import { FakeClock } from "../clock.ts";

const run = (id: string): NewRun => ({
  id, condition: "polylogue", n: 4, taskId: "toy-vault", seed: 7, model: "qwen3.8-27b",
  revision: "7d6f8d4", sampling: { temperature: 0 }, configHash: "sha256:x", gitSha: null, startedAt: "2026-10-11T00:00:00Z",
});
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "polylogue-")), "runs.sqlite");

describe("EventLog", () => {
  it("round-trips runs and events with gap-free seq per run", () => {
    const log = new EventLog(tmpDb());
    log.createRun(run("r1"));
    log.createRun(run("r2"));
    expect(log.append("r1", { kind: "idle", t: 1, agent: "a1" })).toBe(0);
    expect(log.append("r2", { kind: "idle", t: 1, agent: "a2" })).toBe(0);
    expect(log.append("r1", { kind: "wake", t: 2, agent: "a1", reason: "message" })).toBe(1);
    expect(log.events("r1").map((e) => [e.seq, e.event.kind])).toEqual([[0, "idle"], [1, "wake"]]);
    expect(log.events("r1", 1).map((e) => e.seq)).toEqual([1]);
    expect(log.run("r1")?.status).toBe("running");
    log.finishRun("r1", "solved", "solved", "2026-10-11T00:01:00Z");
    expect(log.run("r1")).toMatchObject({ status: "solved", endReason: "solved", sampling: { temperature: 0 } });
    expect(log.runs().map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("continues seq after reopening the file", () => {
    const path = tmpDb();
    const a = new EventLog(path);
    a.createRun(run("r1"));
    a.append("r1", { kind: "idle", t: 1, agent: "a1" });
    a.close();
    const b = new EventLog(path);
    expect(b.append("r1", { kind: "idle", t: 2, agent: "a2" })).toBe(1);
  });

  it("rejects invalid events on write and on read", () => {
    const path = tmpDb();
    const log = new EventLog(path);
    log.createRun(run("r1"));
    expect(() => log.append("r1", { kind: "idle", t: 1, agent: "bob" } as never)).toThrow();
    const raw = new Database(path);
    raw.prepare("INSERT INTO events (run_id, seq, t, kind, payload) VALUES ('r1', 0, 0, 'idle', '{\"kind\":\"idle\"}')").run();
    raw.close();
    expect(() => log.events("r1")).toThrow();
  });

  it("refuses UPDATE and DELETE on events", () => {
    const path = tmpDb();
    const log = new EventLog(path);
    log.createRun(run("r1"));
    log.append("r1", { kind: "idle", t: 1, agent: "a1" });
    const raw = new Database(path);
    expect(() => raw.prepare("UPDATE events SET t = 5").run()).toThrow(/append-only/);
    expect(() => raw.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    raw.close();
  });

  it("notifies subscribers of new events for their run only", () => {
    const log = new EventLog(tmpDb());
    log.createRun(run("r1"));
    log.createRun(run("r2"));
    const seen: number[] = [];
    const off = log.subscribe("r1", (e) => seen.push(e.seq));
    log.append("r1", { kind: "idle", t: 1, agent: "a1" });
    log.append("r2", { kind: "idle", t: 1, agent: "a1" });
    off();
    log.append("r1", { kind: "idle", t: 2, agent: "a1" });
    expect(seen).toEqual([0]);
  });

  it("opens read-only for serving", () => {
    const path = tmpDb();
    const w = new EventLog(path);
    w.createRun(run("r1"));
    w.append("r1", { kind: "idle", t: 1, agent: "a1" });
    const r = new EventLog(path, { readonly: true });
    expect(r.events("r1")).toHaveLength(1);
    expect(() => r.append("r1", { kind: "idle", t: 2, agent: "a1" })).toThrow();
  });
});

describe("FakeClock", () => {
  it("fires timers when advanced past them, and cancelled timers never", () => {
    const c = new FakeClock();
    const fired: string[] = [];
    c.setTimer(() => fired.push("a"), 100);
    const cancel = c.setTimer(() => fired.push("b"), 50);
    cancel();
    c.advance(99);
    expect(fired).toEqual([]);
    c.advance(1);
    expect(fired).toEqual(["a"]);
    expect(c.now()).toBe(100);
  });

  it("reports each timer's due time inside its callback", () => {
    const c = new FakeClock();
    const seen: number[] = [];
    c.setTimer(() => seen.push(c.now()), 100);
    c.advance(250);
    expect(seen).toEqual([100]);
    expect(c.now()).toBe(250);
  });

  it("fires a timer armed inside a callback when it falls inside the same advance", () => {
    const c = new FakeClock();
    const fired: string[] = [];
    c.setTimer(() => {
      fired.push(`outer@${c.now()}`);
      c.setTimer(() => fired.push(`inner@${c.now()}`), 30);
    }, 100);
    c.advance(200);
    expect(fired).toEqual(["outer@100", "inner@130"]);
    expect(c.now()).toBe(200);
  });
});
