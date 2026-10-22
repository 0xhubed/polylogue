import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Matrix, expandMatrix, shuffle, type Cell } from "./matrix.ts";
import { acquireLock } from "./lock.ts";
import { BatchError, closeStale, runBatch } from "./runner.ts";
import { EventLog } from "../log/event-log.ts";
import { makeSuiteFixture } from "../testing/suite-fixture.ts";
import { startFakeOpenAI, type FakeServer } from "../testing/fake-openai.ts";
import type { RunConfig } from "../config.ts";
import type { RunSummary } from "../run/run.ts";
import { taskFingerprint } from "../suites/registry.ts";

let fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
});
const dbPath = () => join(mkdtempSync(join(tmpdir(), "polylogue-batch-")), "runs.sqlite");
const MODEL = { id: "qwen3.8-27b", hfRepo: "unsloth/Qwen3.8-27B-NVFP4", revision: "r", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 30_000, maxRetries: 0 };

function dataDir(): string {
  return makeSuiteFixture(
    "bcp",
    [
      { id: "bcp-1", split: "pilot", prompt: "Who supplied copper?", answer: "Kessler AG", match: "contains", corpus: "corpus.sqlite" },
      { id: "bcp-2", split: "pilot", prompt: "Where did the ferry go?", answer: "Ghent", match: "contains", corpus: "corpus.sqlite" },
    ],
    { "corpus.sqlite": [{ id: "d1", title: "Memo", body: "Kessler AG supplied copper. The ferry went to Ghent." }] },
  );
}
function matrix(over: Record<string, unknown> = {}): Matrix {
  return Matrix.parse({
    name: "t", orderSeed: 1, dataDir: dataDir(), servers: ["http://127.0.0.1:1/v1"], conditions: ["single", "isolated"], seeds: [1, 2],
    suites: [{ suite: "bcp", split: "pilot", tokensPerAgent: 50_000, wallClockMs: 20_000 }],
    rate: { messagesPerMinute: 30, maxMessageChars: 2000 }, model: MODEL, ...over,
  });
}
/** Stub runner: writes a finished row like runOnce would, with a chosen reason per run id. */
function stubRun(log: EventLog, reasons: Record<string, RunSummary["reason"]> = {}, seen: string[] = []) {
  return async (cfg: RunConfig): Promise<RunSummary> => {
    const id = cfg.runId!;
    seen.push(id);
    log.createRun({ id, condition: cfg.condition, n: 1, taskId: cfg.taskId, seed: cfg.seed, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
    const reason = reasons[id] ?? "solved";
    log.append(id, { kind: "run_finished", t: 1, reason, solved: reason === "solved", wallMs: 1, totalTokens: 0 });
    log.finishRun(id, reason === "solved" ? "solved" : reason === "infra_error" ? "infra_error" : "unsolved", reason, "2026-10-11T00:00:01Z");
    return { runId: id, reason, solved: reason === "solved", totalTokens: 0, wallMs: 1 };
  };
}

describe("matrix", () => {
  it("expands suites × tasks × conditions × seeds with spec run ids", () => {
    const m = matrix();
    const cells = expandMatrix(m, () => ["bcp-1", "bcp-2"]);
    expect(cells).toHaveLength(8);
    expect(cells[0]).toEqual({ id: "bcp-bcp-1-single-s1", suite: "bcp", taskId: "bcp-1", condition: "single", seed: 1, tokensPerAgent: 50_000, wallClockMs: 20_000 } satisfies Cell);
    expect(new Set(cells.map((c) => c.id)).size).toBe(8);
  });

  it("shuffles reproducibly per seed", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(xs, 1)).toEqual(shuffle(xs, 1));
    expect(shuffle(xs, 1)).not.toEqual(shuffle(xs, 2));
    expect([...shuffle(xs, 1)].sort((a, b) => a - b)).toEqual(xs);
  });
});

describe("runBatch", () => {
  it("runs every cell once in shuffled order and skips finished cells on a second call", async () => {
    const log = new EventLog(dbPath());
    const seen: string[] = [];
    const m = matrix();
    let swept = 0;
    const r1 = await runBatch(m, { log, run: stubRun(log, {}, seen), sweep: async () => (swept++, 1) });
    expect(swept).toBe(0); // no math cells: no sandbox sweep
    expect(r1.ran).toHaveLength(8);
    expect(seen).toEqual(shuffle(expandMatrix(m, () => ["bcp-1", "bcp-2"]), 1).map((c) => c.id));
    const r2 = await runBatch(m, { log, run: stubRun(log, {}, seen) });
    expect(r2.ran).toEqual([]);
    expect(r2.skipped).toHaveLength(8);
  });

  it("closes a run left running by a crash, reruns it once as -r1, and counts a second failure", async () => {
    const log = new EventLog(dbPath());
    const crashed = "bcp-bcp-1-single-s1";
    log.createRun({ id: crashed, condition: "single", n: 1, taskId: "bcp-1", seed: 1, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
    log.append(crashed, { kind: "model_call", t: 500, agent: "a1", call: 0, content: "", reasoning: "", toolCalls: [], tokensIn: 100, tokensOut: 20, ms: 400, stopReason: "stop" });
    const seen: string[] = [];
    const r = await runBatch(matrix(), { log, run: stubRun(log, { "bcp-bcp-2-isolated-s2": "infra_error", "bcp-bcp-2-isolated-s2-r1": "infra_error" }, seen) });
    expect(r.closed).toEqual([crashed]);
    expect(log.run(crashed)).toMatchObject({ status: "infra_error", endReason: "infra_error" });
    expect(log.events(crashed).at(-1)!.event).toMatchObject({ kind: "run_finished", reason: "infra_error", totalTokens: 120, wallMs: 500, detail: "interrupted; closed when the batch resumed" });
    expect(seen).toContain(`${crashed}-r1`);
    expect(seen).not.toContain(crashed);
    expect(seen.filter((x) => x.startsWith("bcp-bcp-2-isolated-s2"))).toEqual(["bcp-bcp-2-isolated-s2", "bcp-bcp-2-isolated-s2-r1"]);
    expect(r.failedTwice).toEqual(["bcp-bcp-2-isolated-s2"]);
    const again = await runBatch(matrix(), { log, run: stubRun(log, {}, seen) });
    expect(again.ran).toEqual([]);
  });

  it("closeStale leaves an already finished run's events alone and takes its status from them; runBatch then skips it", async () => {
    const log = new EventLog(dbPath());
    log.createRun({ id: "x", condition: "single", n: 1, taskId: "t", seed: 1, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
    log.append("x", { kind: "run_finished", t: 3, reason: "budget", solved: false, wallMs: 3, totalTokens: 9 });
    closeStale(log, "x");
    expect(log.events("x")).toHaveLength(1);
    expect(log.run("x")).toMatchObject({ status: "unsolved", endReason: "budget" });

    const m = matrix({ conditions: ["single"], seeds: [1], suites: [{ suite: "bcp", split: "pilot", tasks: ["bcp-1"], tokensPerAgent: 1000, wallClockMs: 1000 }] });
    const id = "bcp-bcp-1-single-s1";
    log.createRun({ id, condition: "single", n: 1, taskId: "bcp-1", seed: 1, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
    log.append(id, { kind: "run_finished", t: 3, reason: "budget", solved: false, wallMs: 3, totalTokens: 9 });
    const seen: string[] = [];
    const r = await runBatch(m, { log, run: stubRun(log, {}, seen) });
    expect(r.closed).toEqual([id]);
    expect(seen).toEqual([]);
    expect(r.skipped).toEqual([id]);
    expect(log.run(id)).toMatchObject({ status: "unsolved", endReason: "budget" });
  });

  it("refuses a math batch when the Python sandbox is not ready", async () => {
    const log = new EventLog(dbPath());
    const m = matrix({ suites: [{ suite: "math", split: "pilot", tokensPerAgent: 1000, wallClockMs: 1000 }] });
    await expect(runBatch(m, { log, list: () => ["math-1"], run: stubRun(log), sandboxReady: async () => false })).rejects.toThrow(/Python sandbox is not ready/);
  });

  it("sweeps leftover sandbox containers once before the first run of a math batch and reports the count", async () => {
    const log = new EventLog(dbPath());
    const order: string[] = [];
    const lines: string[] = [];
    const inner = stubRun(log);
    const m = matrix({
      dataDir: makeSuiteFixture("math", [{ id: "math-1", split: "pilot", prompt: "What is 2+2?", answer: "4", match: "numeric" }]),
      suites: [{ suite: "math", split: "pilot", tokensPerAgent: 1000, wallClockMs: 1000 }],
      conditions: ["single"], seeds: [1, 2],
    });
    const r = await runBatch(m, {
      log,
      sandboxReady: async () => true,
      sweep: async () => {
        order.push("sweep");
        return 3;
      },
      run: async (cfg) => {
        order.push("run");
        return inner(cfg);
      },
      onRun: (line) => lines.push(line),
    });
    expect(r.ran).toHaveLength(2);
    expect(order).toEqual(["sweep", "run", "run"]);
    expect(lines[0]).toBe("removed 3 leftover sandbox containers");
  });

  it("stops taking jobs once shouldStop is true, lets the run in progress finish, and reports the rest as notStarted", async () => {
    const log = new EventLog(dbPath());
    const seen: string[] = [];
    const m = matrix();
    const r = await runBatch(m, { log, run: stubRun(log, {}, seen), shouldStop: () => seen.length >= 1 });
    expect(r.ran).toHaveLength(1);
    expect(r.notStarted).toHaveLength(7);
    expect(new Set([...r.ran, ...r.notStarted]).size).toBe(8);
    expect(log.runs().filter((x) => x.status === "running")).toEqual([]);
    const resumed = await runBatch(m, { log, run: stubRun(log, {}, seen) });
    expect(resumed.ran).toHaveLength(7);
    expect(resumed.skipped).toHaveLength(1);
  });

  it("reports a dead server and finishes the matrix on the healthy one", async () => {
    const log = new EventLog(dbPath());
    const good = "http://127.0.0.1:2/v1";
    const bad = "http://127.0.0.1:1/v1";
    const inner = stubRun(log);
    const lines: string[] = [];
    const r = await runBatch(matrix({ servers: [bad, good] }), {
      log,
      run: async (cfg) => {
        if (cfg.model.baseUrl === bad) throw new Error("connection refused");
        return inner(cfg);
      },
      onRun: (l) => lines.push(l),
    });
    expect(r.deadServers).toEqual([{ server: bad, error: "connection refused" }]);
    expect(r.ran).toHaveLength(8);
    expect(new Set(r.ran).size).toBe(8);
    expect(r.notStarted).toEqual([]);
    expect(lines).toContain(`server ${bad} stopped: connection refused`);
    expect(lines.filter((l) => l.includes(` on ${good}: solved`))).toHaveLength(8);
  });

  it("closes a run that threw after it started, queues its -r1 and stops the worker", async () => {
    const log = new EventLog(dbPath());
    let first = true;
    const inner = stubRun(log);
    const seen: string[] = [];
    const m = matrix({ conditions: ["single"], seeds: [1], suites: [{ suite: "bcp", split: "pilot", tasks: ["bcp-1"], tokensPerAgent: 1000, wallClockMs: 1000 }] });
    const r = await runBatch(m, {
      log,
      run: async (cfg) => {
        if (first) {
          first = false;
          log.createRun({ id: cfg.runId!, condition: "single", n: 1, taskId: "bcp-1", seed: 1, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
          throw new Error("boom");
        }
        seen.push(cfg.runId!);
        return inner(cfg);
      },
    }).catch((e: unknown) => e as BatchError);
    expect(r).toBeInstanceOf(BatchError);
    const res = (r as BatchError).result;
    expect(res.closed).toEqual(["bcp-bcp-1-single-s1"]);
    expect(res.notStarted).toEqual(["bcp-bcp-1-single-s1-r1"]);
    expect(res.deadServers).toHaveLength(1);
    expect(log.run("bcp-bcp-1-single-s1")).toMatchObject({ status: "infra_error" });
    expect(seen).toEqual([]);
  });

  it("refuses duplicate servers and duplicate cells with a readable message", () => {
    const dup = Matrix.safeParse({ ...matrix(), servers: ["http://a:1/v1", "http://a:1/v1"] });
    expect(dup.success).toBe(false);
    expect(JSON.stringify(dup.error!.issues)).toMatch(/duplicate server http:\/\/a:1\/v1/);
    expect(() => expandMatrix(matrix({ seeds: [1, 1] }), () => ["bcp-1"])).toThrow(/Duplicate cell bcp-bcp-1-single-s1/);
  });

  it("stops with a readable error and keeps the cell when the server check fails", async () => {
    const log = new EventLog(dbPath());
    const run = async (): Promise<RunSummary> => {
      throw new Error("model server at http://127.0.0.1:1/v1 is unreachable: fetch failed");
    };
    await expect(runBatch(matrix(), { log, run })).rejects.toThrow(/Batch stopped with 8 runs left: model server .* unreachable/);
    expect(log.runs()).toEqual([]);
  });

  it("runs end to end on two servers with real runOnce, each cell exactly once", async () => {
    const policy = () => ({ toolCalls: [{ name: "claim", args: { answer: "Kessler AG", evidence: "d1" } }] });
    fakes = [await startFakeOpenAI(policy), await startFakeOpenAI(policy)];
    const log = new EventLog(dbPath());
    const m = matrix({ servers: fakes.map((f) => f.baseUrl), suites: [{ suite: "bcp", split: "pilot", tasks: ["bcp-1"], tokensPerAgent: 50_000, wallClockMs: 20_000 }] });
    const r = await runBatch(m, { log });
    expect(r.ran.sort()).toEqual(["bcp-bcp-1-isolated-s1", "bcp-bcp-1-isolated-s2", "bcp-bcp-1-single-s1", "bcp-bcp-1-single-s2"]);
    expect(log.runs().map((x) => x.status)).toEqual(["solved", "solved", "solved", "solved"]);
    expect(fakes.every((f) => f.requests.length > 0)).toBe(true);
    const servers = r.ran.map((id) => (log.events(id)[0]!.event as { config: { model: { baseUrl: string } } }).config.model.baseUrl);
    expect(new Set(servers)).toEqual(new Set(fakes.map((f) => f.baseUrl)));
  });
});

describe("acquireLock", () => {
  const lockedDb = () => dbPath();
  const deadPid = () => {
    for (let pid = 999_999; pid > 900_000; pid--) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
      }
    }
    throw new Error("no free pid");
  };

  it("refuses a live owner on this host", () => {
    const db = lockedDb();
    writeFileSync(`${db}.lock`, JSON.stringify({ host: hostname(), pid: process.pid, startedAt: "2026-10-11T00:00:00Z" }));
    expect(() => acquireLock(db)).toThrow(new RegExp(`Another batch \\(pid ${process.pid}, started 2026-10-11T00:00:00Z\\) is using .*runs.sqlite. Stop it first.`));
  });

  it("replaces the lock of a dead owner", () => {
    const db = lockedDb();
    writeFileSync(`${db}.lock`, JSON.stringify({ host: hostname(), pid: deadPid(), startedAt: "2026-10-11T00:00:00Z" }));
    const release = acquireLock(db);
    expect(existsSync(`${db}.lock`)).toBe(true);
    release();
  });

  it("names the host when another host holds the lock", () => {
    const db = lockedDb();
    writeFileSync(`${db}.lock`, JSON.stringify({ host: "other-host", pid: 1, startedAt: "2026-10-11T00:00:00Z" }));
    expect(() => acquireLock(db)).toThrow(/other-host/);
  });

  it("release removes the file, and the lock can be taken again", () => {
    const db = lockedDb();
    const release = acquireLock(db);
    expect(existsSync(`${db}.lock`)).toBe(true);
    release();
    expect(existsSync(`${db}.lock`)).toBe(false);
    acquireLock(db)();
  });
});

describe("frozen manifests", () => {
  const ledgerTask = { id: "ledger-001", split: "scored" as const, prompt: "How many units?", answer: "120", match: "numeric" as const, corpus: "corpus-ledger-001.sqlite" };
  function setup(over: { prompt?: string; corpusSha?: string } = {}) {
    const bcpDir = makeSuiteFixture("bcp", [{ id: "bcp-1", split: "scored", prompt: "Who supplied copper?", answer: "Kessler AG", match: "contains", corpus: "corpus.sqlite" }], {
      "corpus.sqlite": [{ id: "d1", title: "Memo", body: "Kessler AG supplied copper." }],
    });
    const ledgerDir = makeSuiteFixture("ledger", [ledgerTask], { "corpus-ledger-001.sqlite": [{ id: "D-0001", title: "Memo", body: "b" }] });
    const frozenDir = mkdtempSync(join(tmpdir(), "polylogue-frozen-"));
    const write = (suite: string, tasks: unknown[]) => {
      mkdirSync(join(frozenDir, suite), { recursive: true });
      writeFileSync(join(frozenDir, suite, "frozen.json"), JSON.stringify({ suite, tasks }));
    };
    write("bcp", [{ id: "bcp-1", split: "scored", task_sha256: taskFingerprint("contains", "Kessler AG", [], over.prompt ?? "Who supplied copper?") }]);
    const corpus = createHash("sha256").update(readFileSync(join(ledgerDir, "ledger", ledgerTask.corpus))).digest("hex");
    write("ledger", [{ id: "ledger-001", split: "scored", task_sha256: taskFingerprint("numeric", "120", [], "How many units?"), corpus_sha256: over.corpusSha ?? corpus }]);
    const m = (dataDir: string, suite: "bcp" | "ledger", split: "pilot" | "scored" = "scored") =>
      matrix({ dataDir, conditions: ["single"], seeds: [1], suites: [{ suite, split, tokensPerAgent: 1000, wallClockMs: 1000 }] });
    return { bcpDir, ledgerDir, frozenDir, m };
  }

  it("runs scored cells whose tasks match frozen.json", async () => {
    const { bcpDir, ledgerDir, frozenDir, m } = setup();
    for (const [dir, suite] of [[bcpDir, "bcp"], [ledgerDir, "ledger"]] as const) {
      const log = new EventLog(dbPath());
      expect((await runBatch(m(dir, suite), { log, run: stubRun(log), frozenDir })).ran).toHaveLength(1);
    }
  });

  it("refuses to start when a scored task's fingerprint differs from frozen.json, naming the task", async () => {
    const { bcpDir, frozenDir, m } = setup({ prompt: "Who supplied the copper?" });
    const log = new EventLog(dbPath());
    const seen: string[] = [];
    await expect(runBatch(m(bcpDir, "bcp"), { log, run: stubRun(log, {}, seen), frozenDir })).rejects.toThrow(/Task "bcp-1" of suite "bcp" differs from .*frozen\.json/);
    expect(seen).toEqual([]);
    // pilot cells are not held to the manifest
    expect((await runBatch(m(bcpDir, "bcp", "pilot"), { log, run: stubRun(log), list: () => ["bcp-1"], frozenDir })).ran).toHaveLength(1);
  });

  it("refuses a ledger task whose corpus file differs, and a task the manifest does not list", async () => {
    const { ledgerDir, frozenDir, m } = setup({ corpusSha: "0".repeat(64) });
    const log = new EventLog(dbPath());
    await expect(runBatch(m(ledgerDir, "ledger"), { log, run: stubRun(log), frozenDir })).rejects.toThrow(/Task "ledger-001" of suite "ledger": its corpus file differs from .*frozen\.json/);
    const other = setup();
    const unlisted = matrix({ dataDir: other.bcpDir, conditions: ["single"], seeds: [1], suites: [{ suite: "bcp", split: "scored", tasks: ["bcp-1", "bcp-9"], tokensPerAgent: 1000, wallClockMs: 1000 }] });
    await expect(runBatch(unlisted, { log, run: stubRun(log), frozenDir: other.frozenDir })).rejects.toThrow(/Task "bcp-9" of suite "bcp" is not a scored task in .*frozen\.json/);
  });

  it("checks nothing before the freeze (no frozen.json)", async () => {
    const { bcpDir, m } = setup({ prompt: "changed" });
    const log = new EventLog(dbPath());
    const empty = mkdtempSync(join(tmpdir(), "polylogue-nofrozen-"));
    expect((await runBatch(m(bcpDir, "bcp"), { log, run: stubRun(log), frozenDir: empty })).ran).toHaveLength(1);
  });
});

describe("resume with a changed matrix", () => {
  /** Like stubRun, and logs run_started with the run's config, as runOnce does. */
  function configRun(log: EventLog, reasons: Record<string, RunSummary["reason"]> = {}) {
    return async (cfg: RunConfig): Promise<RunSummary> => {
      const id = cfg.runId!;
      log.createRun({ id, condition: cfg.condition, n: 1, taskId: cfg.taskId, seed: cfg.seed, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
      log.append(id, { kind: "run_started", t: 0, condition: cfg.condition, n: 1, taskId: cfg.taskId, task: "q", pool: 1000, wallClockMs: 1000, config: cfg });
      const reason = reasons[id] ?? "solved";
      log.append(id, { kind: "run_finished", t: 1, reason, solved: reason === "solved", wallMs: 1, totalTokens: 0 });
      log.finishRun(id, reason === "solved" ? "solved" : reason === "infra_error" ? "infra_error" : "unsolved", reason, "2026-10-11T00:00:01Z");
      return { runId: id, reason, solved: reason === "solved", totalTokens: 0, wallMs: 1 };
    };
  }
  const one = (over: Record<string, unknown> = {}, dir = dataDir()) =>
    matrix({ dataDir: dir, conditions: ["single"], seeds: [1], suites: [{ suite: "bcp", split: "pilot", tasks: ["bcp-1"], tokensPerAgent: 1000, wallClockMs: 1000 }], ...over });

  it("refuses to resume when a finished cell was run with a different config, naming the key and the cell", async () => {
    const log = new EventLog(dbPath());
    const dir = dataDir();
    await runBatch(one({}, dir), { log, run: configRun(log) });
    const changed = one({ suites: [{ suite: "bcp", split: "pilot", tasks: ["bcp-1"], tokensPerAgent: 2000, wallClockMs: 1000 }] }, dir);
    await expect(runBatch(changed, { log, run: configRun(log) })).rejects.toThrow(/bcp-bcp-1-single-s1.*budget\.tokensPerAgent/);
    await expect(runBatch(one({ model: { ...MODEL, reasoningEffort: "high" } }, dir), { log, run: configRun(log) })).rejects.toThrow(/model\.reasoningEffort/);
  });

  it("ignores the server, the run id and the data directory", async () => {
    const log = new EventLog(dbPath());
    await runBatch(one(), { log, run: configRun(log) });
    const r = await runBatch(one({ servers: ["http://127.0.0.1:2/v1"] }), { log, run: configRun(log) }); // one() also gives a new dataDir
    expect(r.skipped).toEqual(["bcp-bcp-1-single-s1"]);
  });

  it("checks the -r1 rerun's base row too", async () => {
    const log = new EventLog(dbPath());
    const dir = dataDir();
    await runBatch(one({}, dir), { log, run: configRun(log, { "bcp-bcp-1-single-s1": "infra_error", "bcp-bcp-1-single-s1-r1": "infra_error" }) });
    await expect(runBatch(one({ rate: { messagesPerMinute: 5, maxMessageChars: 2000 } }, dir), { log, run: configRun(log) })).rejects.toThrow(/bcp-bcp-1-single-s1.*rate\.messagesPerMinute/);
  });
});
