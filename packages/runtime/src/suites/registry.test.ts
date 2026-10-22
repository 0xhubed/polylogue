import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listTasks, loadTask, taskFingerprint, taskIdentity } from "./registry.ts";
import { TASKS } from "../toy/vault.ts";
import { makeSuiteFixture } from "../testing/suite-fixture.ts";
import { parseConfig, configHash } from "../config.ts";
import { runOnce } from "../run/run.ts";
import { EventLog } from "../log/event-log.ts";
import { startFakeOpenAI, type FakeServer } from "../testing/fake-openai.ts";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const bcpData = () =>
  makeSuiteFixture(
    "bcp",
    [
      { id: "bcp-1", split: "pilot", prompt: "Which company supplied copper wire to the vault project?", answer: "Kessler AG", match: "contains", corpus: "corpus.sqlite" },
      { id: "bcp-2", split: "scored", prompt: "Where was the ferry going?", answer: "Ghent", match: "contains", corpus: "corpus.sqlite" },
      { id: "bcp-3", split: "candidate", prompt: "x", answer: "y", match: "exact", corpus: "corpus.sqlite" },
    ],
    {
      "corpus.sqlite": [
        { id: "d1", title: "Harbour report", body: "The ferry to Ghent was delayed by fog." },
        { id: "d2", title: "Supplier memo", body: "Kessler AG supplied copper wire to the vault project in Lyon." },
      ],
    },
  );

describe("suite registry", () => {
  it("lists tasks by split", () => {
    const dir = bcpData();
    expect(listTasks("bcp", "pilot", dir)).toEqual(["bcp-1"]);
    expect(listTasks("bcp", "scored", dir)).toEqual(["bcp-2"]);
    expect(listTasks("toy", "pilot", dir)).toEqual(["toy-vault"]);
  });

  it("loads a task with its prompt, tools and verifier", () => {
    const t = loadTask("bcp", "bcp-1", { dataDir: bcpData(), toolDelayMs: 0 });
    expect(t.prompt).toBe("Which company supplied copper wire to the vault project?");
    expect(t.tools.map((x) => x.name)).toEqual(["search", "read_doc"]);
    expect(t.verify("The answer is Kessler AG")).toEqual({ passed: true });
    expect(t.verify("Lyon").passed).toBe(false);
    t.close();
  });

  it("gives ledger tasks list_docs too and the toy suite its shard tool", () => {
    const dir = makeSuiteFixture("ledger", [{ id: "ledger-001", prompt: "q", answer: "Ghent", match: "contains", corpus: "corpus-ledger-001.sqlite" }], {
      "corpus-ledger-001.sqlite": [{ id: "D-0001", title: "Shipment record SH-0001", body: "b" }],
    });
    expect(loadTask("ledger", "ledger-001", { dataDir: dir, toolDelayMs: 0 }).tools.map((x) => x.name)).toEqual(["search", "read_doc", "list_docs"]);
    expect(loadTask("toy", "toy-vault", { dataDir: dir, toolDelayMs: 0 }).tools.map((x) => x.name)).toEqual(["read_shard"]);
  });

  it("refuses missing data, unknown tasks and missing corpus files with readable messages", () => {
    const empty = mkdtempSync(join(tmpdir(), "polylogue-empty-"));
    expect(() => loadTask("bcp", "bcp-1", { dataDir: empty, toolDelayMs: 0 })).toThrow(/Suite "bcp" has no data: .*tasks\.sqlite is missing/);
    expect(() => loadTask("bcp", "bcp-9", { dataDir: bcpData(), toolDelayMs: 0 })).toThrow('Suite "bcp" has no task "bcp-9".');
    const noCorpus = makeSuiteFixture("bcp", [{ id: "bcp-1", prompt: "q", answer: "a", match: "exact", corpus: "corpus.sqlite" }]);
    expect(() => loadTask("bcp", "bcp-1", { dataDir: noCorpus, toolDelayMs: 0 })).toThrow(/corpus\.sqlite is missing/);
  });

  it("refuses a numeric task whose answer key has no single number", () => {
    const dir = makeSuiteFixture("math", [
      { id: "math-1", prompt: "q", answer: "x^2", match: "numeric" },
      { id: "math-2", prompt: "q", answer: "2x+1", match: "numeric" },
    ]);
    for (const id of ["math-1", "math-2"]) {
      expect(() => loadTask("math", id, { dataDir: dir, toolDelayMs: 0 })).toThrow(`Suite "math" task "${id}": the numeric answer key has no single number.`);
    }
  });

  it("refuses a numeric task whose alias has no single number", () => {
    const dir = makeSuiteFixture("math", [
      { id: "math-3", prompt: "q", answer: "42", aliases: ["42.0", "x^2"], match: "numeric" },
      { id: "math-4", prompt: "q", answer: "3/4", aliases: ["0.75"], match: "numeric" },
    ]);
    expect(() => loadTask("math", "math-3", { dataDir: dir, toolDelayMs: 0 })).toThrow('Suite "math" task "math-3": the numeric alias "x^2" has no single number.');
    expect(loadTask("math", "math-4", { dataDir: dir, toolDelayMs: 0 }).verify("0.75")).toEqual({ passed: true });
  });

  it("config defaults to the toy suite and the hash ignores dataDir", () => {
    const base = { condition: "single", taskId: "toy-vault", seed: 1, budget: { tokensPerAgent: 1000 }, wallClockMs: 1000, rate: { messagesPerMinute: 1, maxMessageChars: 10 }, model: { baseUrl: "http://x/v1", id: "m", hfRepo: "r", revision: "v", contextWindow: 1000, maxTokens: 10, reasoningEffort: "medium", timeoutMs: 1000, maxRetries: 0 } };
    expect(parseConfig(base)).toMatchObject({ suite: "toy", dataDir: "data" });
    expect(configHash(parseConfig({ ...base, dataDir: "/a" }))).toBe(configHash(parseConfig({ ...base, dataDir: "/b" })));
    expect(() => parseConfig({ ...base, suite: "chess" })).toThrow();
  });

  it("runOnce runs bcp and ledger tasks end to end in single and polylogue", async () => {
    const ledgerData = () =>
      makeSuiteFixture("ledger", [{ id: "ledger-001", prompt: "Which city got the copper?", answer: "Ghent", match: "contains", corpus: "corpus-ledger-001.sqlite" }], {
        "corpus-ledger-001.sqlite": [{ id: "D-0001", title: "Shipment record SH-0001", body: "On 3 March 2024, Kessler AG dispatched 140 units of copper wire to Ghent." }],
      });
    const cases = [
      { suite: "bcp", taskId: "bcp-1", data: bcpData, steps: [{ name: "search", args: { query: "copper vault" } }, { name: "read_doc", args: { id: "d2" } }], answer: "The answer is Kessler AG", seen: "[d2] Supplier memo" },
      { suite: "ledger", taskId: "ledger-001", data: ledgerData, steps: [{ name: "list_docs", args: {} }, { name: "read_doc", args: { id: "D-0001" } }], answer: "Ghent", seen: "[D-0001] Shipment record SH-0001" },
    ] as const;
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-suite-run-")), "runs.sqlite"));
    for (const c of cases) {
      for (const condition of ["single", "polylogue"] as const) {
        fake = await startFakeOpenAI(({ agentIndex, call }) => {
          if (agentIndex !== 0) return { content: "nothing" };
          const step = c.steps[call];
          return step ? { toolCalls: [step] } : { toolCalls: [{ name: "claim", args: { answer: c.answer, evidence: "read it" } }] };
        });
        const cfg = parseConfig({
          condition, suite: c.suite, taskId: c.taskId, dataDir: c.data(), seed: 3,
          budget: { tokensPerAgent: 100_000 }, wallClockMs: 20_000, rate: { messagesPerMinute: 30, maxMessageChars: 2000 },
          model: { baseUrl: fake.baseUrl, id: "qwen3.8-27b", hfRepo: "unsloth/Qwen3.8-27B-NVFP4", revision: "r", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 30_000, maxRetries: 0 },
        });
        const s = await runOnce(cfg, { log });
        await fake.close();
        fake = undefined;
        expect(s).toMatchObject({ reason: "solved", solved: true });
        const events = log.events(s.runId).map((e) => e.event);
        const loaded = loadTask(c.suite, c.taskId, { dataDir: cfg.dataDir, toolDelayMs: 0 });
        loaded.close();
        expect(events[0]).toMatchObject({ kind: "run_started", config: { suite: c.suite }, taskFingerprint: loaded.fingerprint });
        expect(events.filter((e) => e.kind === "tool_result").map((e) => ("text" in e ? e.text : "")).join("\n")).toContain(c.seen);
        expect(events.at(-1)!.kind).toBe("run_finished");
        const agents = events.filter((e) => e.kind === "agent_started").map((e) => ("agent" in e ? e.agent : ""));
        for (const a of agents) expect(events.filter((e) => e.kind === "agent_finished" && e.agent === a)).toHaveLength(1);
      }
    }
  });

  it("gives math tasks run_python", () => {
    const dir = makeSuiteFixture("math", [{ id: "math-001", prompt: "What is 6 times 7?", answer: "42", match: "numeric" }]);
    const t = loadTask("math", "math-001", { dataDir: dir, toolDelayMs: 0 });
    expect(t.tools.map((x) => x.name)).toEqual(["run_python"]);
    expect(t.verify("The answer is 42.")).toEqual({ passed: true });
  });

  it("fingerprints a task exactly like prep/polyprep/freeze.py (same example and hex in prep/tests/test_freeze.py)", () => {
    // aliases sorted by code point: U+FF01 before U+1F600, although UTF-16 order would put the emoji first
    const hex = taskFingerprint("contains", "Tolkien", ["\u{1F600}y", "Tolkien, J.", "\uff01x", "J. R. R. Tolkien"], "Question: Who wrote it?\nAnswer briefly.");
    expect(hex).toBe("5f1855dfd8a6df876f092f6360ee9f7a6fb981b9a3291fca38996727e34e6247");
  });

  it("exposes the fingerprint on loaded tasks and the corpus hash of ledger tasks", () => {
    const dir = bcpData();
    const t = loadTask("bcp", "bcp-2", { dataDir: dir, toolDelayMs: 0 });
    expect(t.fingerprint).toBe(taskFingerprint("contains", "Ghent", [], "Where was the ferry going?"));
    t.close();
    expect(taskIdentity("bcp", "bcp-2", dir)).toEqual({ fingerprint: t.fingerprint });
    const toy = loadTask("toy", "toy-vault", { dataDir: dir, toolDelayMs: 0 });
    expect(toy.fingerprint).toBe(taskFingerprint("toy", "", [], TASKS["toy-vault"]!.prompt));
    const ledger = makeSuiteFixture("ledger", [{ id: "ledger-001", prompt: "q", answer: "12", aliases: ["12.0"], match: "numeric", corpus: "corpus-ledger-001.sqlite" }], {
      "corpus-ledger-001.sqlite": [{ id: "D-0001", title: "Memo", body: "b" }],
    });
    const bytes = readFileSync(join(ledger, "ledger", "corpus-ledger-001.sqlite"));
    expect(taskIdentity("ledger", "ledger-001", ledger)).toEqual({
      fingerprint: taskFingerprint("numeric", "12", ["12.0"], "q"),
      corpusSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });
});
