import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DOCKER_SPAWN, HOST_GRACE_MS, PYTHON_DEFAULTS, pythonSandboxReady, pythonTool, sandboxArgs, sweepSandboxContainers } from "./python-tool.ts";

const ready = await pythonSandboxReady();
if (!ready) console.warn("python-tool tests skipped: start Docker and run `npm run sandbox:build`");
const leftovers = () => execFileSync("docker", ["ps", "-q", "--filter", "name=polylogue-py-"]).toString().trim();

describe("sandboxArgs", () => {
  it("has no logs, an init process, no capabilities and an in-container hard time limit", () => {
    const argv = sandboxArgs("polylogue-py-x", { ...PYTHON_DEFAULTS, timeoutMs: 2000 }).join(" ");
    for (const part of ["--log-driver none", "--init", "--cap-drop ALL", "--security-opt no-new-privileges", "--network none", "timeout -k 2 2 python -"]) expect(argv).toContain(part);
    expect(sandboxArgs("polylogue-py-x", { ...PYTHON_DEFAULTS, timeoutMs: 2500 }).join(" ")).toContain("timeout -k 2 3 python -");
  });

  it("keeps a Ctrl-C in the terminal away from the container: no signal proxy, docker in its own process group", () => {
    expect(sandboxArgs("polylogue-py-x", PYTHON_DEFAULTS)).toContain("--sig-proxy=false");
    expect(DOCKER_SPAWN).toEqual({ detached: true });
  });

  it("gives the host timer an 8 s start-up allowance over the in-container limit", () => {
    expect(HOST_GRACE_MS).toBe(8000);
    expect(PYTHON_DEFAULTS.hostGraceMs).toBe(HOST_GRACE_MS);
  });
});

describe.skipIf(!ready)("run_python", () => {
  it("runs code with sympy and returns stdout", async () => {
    const out = await pythonTool().run({ code: "import sympy\nprint(sympy.factorint(391))" });
    expect(out).toBe("exit code: 0\n--- stdout ---\n{17: 1, 23: 1}\n\n--- stderr ---\n");
  });

  it("reports errors on stderr with the exit code", async () => {
    const out = await pythonTool().run({ code: "raise ValueError('nope')" });
    expect(out.startsWith("exit code: 1\n")).toBe(true);
    expect(out).toContain("ValueError: nope");
  });

  it("has no network", async () => {
    const out = await pythonTool().run({ code: "import urllib.request\nurllib.request.urlopen('http://example.com', timeout=3)" });
    expect(out).toMatch(/URLError|Errno/);
  });

  it("stops an endless loop at the in-container limit (well before the host timer) and leaves no container behind", async () => {
    const t0 = Date.now();
    const out = await pythonTool({ timeoutMs: 2000 }).run({ code: "while True:\n    pass" });
    expect(out.split("\n")[0]).toBe("Timed out after 2 s; the process was stopped.");
    expect(Date.now() - t0).toBeLessThan(2000 + HOST_GRACE_MS - 2000);
    expect(leftovers()).toBe("");
  }, 15_000);

  it("the host timer still stops the container and reports a timeout when the in-container limit has not fired", async () => {
    const t0 = Date.now();
    const out = await pythonTool({ timeoutMs: 4000, hostGraceMs: -2500 }).run({ code: "while True:\n    pass" });
    expect(out.split("\n")[0]).toBe("Timed out after 4 s; the process was stopped.");
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(leftovers()).toBe("");
  }, 15_000);

  it("reports code that ignores SIGTERM past the limit as a timeout, not a memory kill (timeout -k exits 137)", async () => {
    const out = await pythonTool({ timeoutMs: 2000 }).run({ code: "import signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nwhile True:\n    pass" });
    expect(out.split("\n")[0]).toBe("Timed out after 2 s; the process was stopped.");
    expect(leftovers()).toBe("");
  }, 15_000);

  it("reports a program that exits with 124 on its own as an exit code, not a timeout", async () => {
    const out = await pythonTool().run({ code: "import sys\nsys.exit(124)" });
    expect(out.split("\n")[0]).toBe("exit code: 124");
  });

  it("finishes a program that prints far more than the cut, instead of blocking it until the time limit", async () => {
    const t0 = Date.now();
    const out = await pythonTool().run({ code: "import sys\nfor _ in range(64):\n    sys.stdout.write('y' * 16384)\nprint('done', file=sys.stderr)" });
    expect(out.split("\n")[0]).toBe("exit code: 0");
    expect(out).toContain("[… cut at 4000 characters]");
    expect(out).toContain("done");
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 15_000);

  it("stops the flood early: output is cut and the call ends soon after the in-container limit", async () => {
    const t0 = Date.now();
    const out = await pythonTool({ timeoutMs: 3000 }).run({ code: "import sys\nwhile True:\n    sys.stdout.write('x' * 65536)" });
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(out.split("\n")[0]).toBe("Timed out after 3 s; the process was stopped.");
    expect(out).toContain("[… cut at 4000 characters]");
    expect(out.length).toBeLessThan(140_000);
    expect(leftovers()).toBe("");
  }, 15_000);

  it("cuts flooding output and survives a fork bomb attempt", async () => {
    const flood = await pythonTool().run({ code: "print('x' * 100000)" });
    expect(flood).toContain("[… cut at 4000 characters]");
    expect(flood.length).toBeLessThan(4300);
    const fork = await pythonTool({ timeoutMs: 4000 }).run({ code: "import os\nfor _ in range(1000):\n    try:\n        os.fork()\n    except OSError as e:\n        print('fork failed', e.errno)\n        break" });
    expect(fork).toMatch(/fork failed|Timed out/);
    expect(leftovers()).toBe("");
  });

  it("enforces the memory limit", async () => {
    const out = await pythonTool().run({ code: "b = b'x' * (1024 ** 3)\nprint(len(b))" });
    expect(out.split("\n")[0]).toBe("Killed (memory limit 512 MB).");
  });

  it("runs a math task end to end: run_python, then a numeric claim", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { makeSuiteFixture } = await import("../testing/suite-fixture.ts");
    const { parseConfig } = await import("../config.ts");
    const { runOnce } = await import("../run/run.ts");
    const { EventLog } = await import("../log/event-log.ts");
    const { startFakeOpenAI } = await import("../testing/fake-openai.ts");
    const fake = await startFakeOpenAI(({ call }) => (call === 0 ? { toolCalls: [{ name: "run_python", args: { code: "print(6 * 7)" } }] } : { toolCalls: [{ name: "claim", args: { answer: "42", evidence: "computed" } }] }));
    try {
      const dataDir = makeSuiteFixture("math", [{ id: "math-001", prompt: "What is 6 times 7?", answer: "42", match: "numeric" }]);
      const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-math-")), "runs.sqlite"));
      const s = await runOnce(parseConfig({
        condition: "single", suite: "math", taskId: "math-001", dataDir, seed: 1, budget: { tokensPerAgent: 100_000 }, wallClockMs: 30_000,
        rate: { messagesPerMinute: 30, maxMessageChars: 2000 },
        model: { baseUrl: fake.baseUrl, id: "qwen3.8-27b", hfRepo: "unsloth/Qwen3.8-27B-NVFP4", revision: "r", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 30_000, maxRetries: 0 },
      }), { log });
      expect(s.reason).toBe("solved");
      const py = log.events(s.runId).map((e) => e.event).find((e) => e.kind === "tool_result" && e.tool === "run_python");
      expect(py && "text" in py && py.text).toContain("42");
    } finally {
      await fake.close();
    }
  });

  it("rejects with 'aborted' when the signal fires mid-run, and leaves no container", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const t0 = Date.now();
    await expect(pythonTool().run({ code: "while True:\n    pass" }, ac.signal)).rejects.toThrow(/aborted/);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(leftovers()).toBe("");
  });

  it("rejects at once, without starting docker, when the signal is already aborted", async () => {
    const t0 = Date.now();
    await expect(pythonTool().run({ code: "while True:\n    pass" }, AbortSignal.abort())).rejects.toThrow(/aborted/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(leftovers()).toBe("");
  });

  it("sweeps leftover sandbox containers", async () => {
    execFileSync("docker", ["run", "-d", "--name", `polylogue-py-sweeptest-${randomUUID()}`, "polylogue-python:1", "sleep", "60"]);
    expect(await sweepSandboxContainers()).toBeGreaterThanOrEqual(1);
    expect(leftovers()).toBe("");
    expect(await sweepSandboxContainers()).toBe(0);
  });

  it("is an error when the image does not exist", async () => {
    await expect(pythonTool({ image: "polylogue-python:does-not-exist" }).run({ code: "print(1)" })).rejects.toThrow(/The Python sandbox is unavailable/);
  });
});
