import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitSha } from "./git.ts";
import { startFakeOpenAI, testModelConfig, type FakeServer } from "./testing/fake-openai.ts";

const root = resolve(import.meta.dirname, "../../..");
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("gitSha", () => {
  it("is HEAD in a clean tree, HEAD-dirty with uncommitted changes, null outside a repository", () => {
    const dir = tmp("polylogue-git-");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir }).toString().trim();
    expect(gitSha(dir)).toBeNull();
    git("init", "-q");
    writeFileSync(join(dir, "a.txt"), "a");
    git("add", "a.txt");
    git("commit", "-qm", "a");
    const head = git("rev-parse", "HEAD");
    expect(gitSha(dir)).toBe(head);
    writeFileSync(join(dir, "b.txt"), "b");
    expect(gitSha(dir)).toBe(`${head}-dirty`);
  });
});

describe("polylogue run", () => {
  it("prints the summary and exits with 2 when the run ends as infra_error", async () => {
    fake = await startFakeOpenAI(() => ({ status: 500 }));
    const dir = tmp("polylogue-cli-");
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({
      condition: "single", taskId: "toy-vault", seed: 1, budget: { tokensPerAgent: 10_000 }, wallClockMs: 10_000,
      rate: { messagesPerMinute: 30, maxMessageChars: 2000 }, toolDelayMs: 0, checkServer: true, model: testModelConfig(fake.baseUrl),
    }));
    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((ok) => {
      const child = execFile(join(root, "node_modules/.bin/tsx"), [join(root, "packages/runtime/src/cli.ts"), "run", cfgPath, "--db", join(dir, "runs.sqlite")], { cwd: root }, (_err, out) => ok({ code: child.exitCode, stdout: out }));
    });
    expect(JSON.parse(stdout)).toMatchObject({ reason: "infra_error", solved: false });
    expect(code).toBe(2);
  });
});
