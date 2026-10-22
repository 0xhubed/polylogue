# Polylogue Runtime and Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript runtime that runs the five phase-1 conditions (single, isolated, stigmergic, polylogue, polylogue-bare) with pi agents against an OpenAI-compatible vLLM server, logs every event to SQLite, serves the log read-only, and a React viewer that replays or follows a run.

**Architecture:** npm-workspaces monorepo with three packages. `@polylogue/schema` holds the zod event schema shared by runtime and viewer. `@polylogue/runtime` runs one Node process per run: N `AgentLoop`s (each wrapping one pi `Agent`), an in-process message `Bus` and `Blackboard`, a `Controller` for budget, limits, claims and run end, and an append-only `EventLog`. `@polylogue/viewer` is a Vite + React + React Flow app whose whole view is a pure function `stateAt(events, t)`.

**Tech Stack:** Node 22, TypeScript 6.0.3 (type-check only; code runs through tsx/vitest/vite), npm workspaces, `@earendil-works/pi-agent-core` + `pi-ai` 1.1.0, typebox 1.3.27, zod 4.6.5, better-sqlite3 13.0.3, vitest 5.0.2, vite 8.3.1, React 19.3.0, @xyflow/react 12.12.0, @playwright/test 1.62.0.

**Spec:** `docs/superpowers/specs/2026-10-11-polylogue-runtime-design.md` (approved 2026-10-11). Read it before your task.

## Global Constraints

- Node 22 (`>=22.19.0`, required by pi 1.1.0). ESM everywhere (`"type": "module"`). Relative imports carry the `.ts` extension.
- Exact dependency versions (no `^`), as listed in Task 1. `.npmrc` sets `legacy-peer-deps=true`: npm 10.9.4 crashes (`Cannot read properties of null (reading 'edgesOut')`) resolving vitest's peer set otherwise. Measured 2026-10-11.
- pi is pinned at 1.1.0. Pi Durable is out of scope. Do not use pi's `transformContext` (no compaction).
- Every pi `Agent`: `toolExecution: "sequential"`, `steeringMode: "all"`, `followUpMode: "all"`, `thinkingLevel: "off"` (thinking is set per request through `chat_template_kwargs`).
- Every request: `temperature: 0`, `seed: runSeed * 100 + agentIndex` (agentIndex 0-based, agent ids `a1…aN`), `chat_template_kwargs: { reasoning_effort: <config> }`, `maxRetries` and `timeoutMs` from config. pi does not retry unless `maxRetries` is set (measured: 1 attempt by default, 4 with `maxRetries: 3`).
- Model compat flags for vLLM: `supportsDeveloperRole: false`, `supportsReasoningEffort: false`.
- Conditions differ only in tool set, system prompt text and N (spec §4). The agent loop, model settings and task prompt are identical across conditions.
- One blind claim per agent; the claim tool's result text is always `Claim submitted.` whether the answer passed or not.
- Events are append-only: the `events` table rejects UPDATE and DELETE by trigger. Every event is zod-validated on write and on read.
- The server is read-only and binds to `127.0.0.1` unless `--host` is given. No auth.
- Commit after every task on branch `spec/runtime` (the branch this plan lives on). Never commit to `main`. Do not push.
- `.gitignore` is a Python template that ignores every `lib/` directory: do not create directories named `lib`.

## Review Focus

1. **A message to an agent that has already finished** (claimed, or out of context): a person expects the sender to be told (tool error naming the agent) and the message not to be delivered; `publish` reports how many live agents it reached. Test added to Task 5.
2. **A model that calls an unknown tool or sends malformed arguments**: the run must not crash; pi returns an error tool result, the call is logged as a `tool_result` with `isError: true`, and the agent's next request carries that error. Test added to Task 6.
3. **Events after the end**: once `run_finished` is logged, nothing else is logged for that run, and no `claim_submitted` follows a passing `verification`. Test (event-order invariant over every end-to-end run) added to Task 7.
4. **Empty or self-addressed messages, unknown recipients**: tool errors with a plain explanation, nothing logged as `message`. Test added to Task 5.
5. **A run that is still going (no `run_finished`) or an unknown run id in the viewer**: `stateAt` works on a partial log (duration = last event, no end reason), and the viewer shows "Run not found" for an unknown id instead of a blank page. Tests added to Tasks 9 and 10.

## Rulings made while planning (beyond the spec)

- **Two extra event kinds.** `run_started` (condition, N, task text, pool, wall-clock limit) makes the log self-contained for context rebuilding and lets the viewer show tokens against the pool; `idle` marks when an agent stops working, for the swimlanes and `all_idle`. The spec lists the IDEA kinds plus four; these are the only additions. Cost if wrong: a schema change before any scored run, cheap.
- **Status lines are derived, not a tool.** The spec has a status line per agent but no tool to set it; the loop sets it to the first non-empty line of the agent's latest text output (≤ 140 chars) and logs a `status` event. Cost if wrong: add a `set_status` tool later; the event already exists.
- **Delivery through `prepareNextTurnWithContext`, not `steer`.** Both inject after the tool round; this hook lets us build one block, urgent first, at the moment of delivery (measured 2026-10-11 against pi 1.1.0). `followUp` + `continue()` wakes an idle agent, as the spec says.
- **Context estimate** for the `context` limit: last call's prompt+completion tokens + new characters / 3 + `maxTokens`. Conservative; vLLM would otherwise reject the request and the run would end as `infra_error`.
- **Run-end policy.** `solved`, `killed` and `infra_error` abort in-flight calls (logged with `stopReason: "aborted"`, zero tokens); `budget` and `all_idle` let them finish and be charged (spec §5: "Calls already in flight finish, are charged and are logged").
- **`agent_finished` reasons** are `claimed`, `idle` (only where nothing can wake the agent), `context`, and `run_ended` for agents still running when the run ends.

---

## File structure

```
package.json, .npmrc, tsconfig.base.json, tsconfig.json, vitest.config.ts, README.md
configs/smoke-zgx.json                         example run config (live smoke, later)
packages/schema/
  package.json
  src/events.ts          Event zod schema, EventInput, Of<K>, enums
  src/run.ts             RunRow, RunStatus
  src/inbox.ts           InboxMessage, orderBlock, formatBlock
  src/index.ts           re-exports
  src/events.test.ts
packages/runtime/
  package.json
  src/clock.ts           Clock, realClock, FakeClock
  src/log/event-log.ts   EventLog (SQLite)
  src/log/event-log.test.ts
  src/model/provider.ts  ModelConfig, makeModelRuntime, checkServer, samplingRecord
  src/model/provider.test.ts
  src/testing/fake-openai.ts   fake OpenAI-compatible server for tests
  src/control/controller.ts    Controller
  src/control/controller.test.ts
  src/comm/bus.ts, src/comm/blackboard.ts
  src/conditions.ts      CONDITIONS, NORMS, systemPrompt, toolNames
  src/run/context.ts     RunContext, AgentDirectory (interfaces)
  src/tools/work-tool.ts, comm-tools.ts, blackboard-tools.ts, claim-tool.ts, build-tools.ts
  src/toy/vault.ts       toy task, read_shard, verifier
  src/comm/comm.test.ts  bus, blackboard, tools, conditions
  src/agent/estimate.ts  messageText, estimatePromptTokens
  src/agent/agent-loop.ts AgentLoop
  src/agent/context.ts   CtxMsg, contextBeforeCall, normalizeOpenAIMessages
  src/agent/agent-loop.test.ts
  src/config.ts          RunConfig, parseConfig, configHash
  src/run/run.ts         runOnce
  src/run/run.test.ts    end-to-end per condition + end reasons
  src/server/server.ts   createServer
  src/server/server.test.ts
  src/cli.ts             polylogue run | serve
packages/viewer/
  package.json, index.html, vite.config.ts, tsconfig.json, playwright.config.ts
  src/sim.ts, src/sim.test.ts       seeded event simulator
  src/state.ts, src/state.test.ts   stateAt
  src/source.ts                     load replay / live / simulated events
  src/App.tsx, src/main.tsx, src/styles.css
  src/views/TeamGraph.tsx, Swimlanes.tsx, ChatFeed.tsx, BlackboardView.tsx, Counters.tsx, Scrubber.tsx
  e2e/viewer.spec.ts
```

---

### Task 1: Monorepo scaffold and event schema

**Files:**
- Create: `package.json`, `.npmrc`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`
- Modify: `.gitignore` (append)
- Create: `packages/schema/package.json`, `packages/schema/src/events.ts`, `packages/schema/src/run.ts`, `packages/schema/src/inbox.ts`, `packages/schema/src/index.ts`
- Create: `packages/runtime/package.json`, `packages/viewer/package.json` (dependencies only; code comes later)
- Test: `packages/schema/src/events.test.ts`

**Interfaces:**
- Produces: `Event` (zod schema and type), `EventInput`, `Of<K>`, `EventKind`, `ConditionName`, `RunEndReason`, `AgentEndReason`, `Recipient`, `RunRow`, `RunStatus`, `InboxMessage`, `orderBlock(msgs)`, `formatBlock(msgs)`, all exported from `@polylogue/schema`.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "polylogue",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.19.0" },
  "workspaces": ["packages/schema", "packages/runtime", "packages/viewer"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json && tsc -p packages/viewer/tsconfig.json",
    "polylogue": "tsx packages/runtime/src/cli.ts",
    "viewer:build": "npm run build -w @polylogue/viewer",
    "test:e2e": "playwright test -c packages/viewer/playwright.config.ts"
  },
  "devDependencies": {
    "@playwright/test": "1.62.0",
    "@types/node": "22.20.5",
    "@vitejs/plugin-react": "6.1.1",
    "tsx": "4.23.15",
    "typescript": "6.0.3",
    "vite": "8.3.1",
    "vitest": "5.0.2"
  }
}
```

`.npmrc`:
```
legacy-peer-deps=true
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  }
}
```

`tsconfig.json`:
```json
{ "extends": "./tsconfig.base.json", "include": ["packages/schema/src", "packages/runtime/src"] }
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
```

Append to `.gitignore`:
```
# Node / polylogue
node_modules/
packages/viewer/dist/
test-results/
playwright-report/
*.sqlite
*.sqlite-wal
*.sqlite-shm
```

- [ ] **Step 2: Package manifests**

`packages/schema/package.json`:
```json
{
  "name": "@polylogue/schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "4.6.5" }
}
```

`packages/runtime/package.json`:
```json
{
  "name": "@polylogue/runtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@earendil-works/pi-agent-core": "1.1.0",
    "@earendil-works/pi-ai": "1.1.0",
    "@polylogue/schema": "0.0.0",
    "better-sqlite3": "13.0.3",
    "typebox": "1.3.27",
    "zod": "4.6.5"
  },
  "devDependencies": { "@types/better-sqlite3": "9.6.0" }
}
```

`packages/viewer/package.json`:
```json
{
  "name": "@polylogue/viewer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": {
    "@polylogue/schema": "0.0.0",
    "@xyflow/react": "12.12.0",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "devDependencies": { "@types/react": "19.3.0", "@types/react-dom": "19.3.0" }
}
```

Run: `npm install`
Expected: `found 0 vulnerabilities` (or a vulnerability count) and no `npm error`. `node -e "require('better-sqlite3')" ` from `packages/runtime` must not throw (v13 ships a linux-x64 prebuild; no compiler needed).

- [ ] **Step 3: Write the failing schema test**

`packages/schema/src/events.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Event, formatBlock, orderBlock, type InboxMessage } from "./index.ts";

describe("Event schema", () => {
  it("accepts every kind with its fields", () => {
    const samples: unknown[] = [
      { kind: "run_started", t: 0, condition: "polylogue", n: 4, taskId: "toy-vault", task: "Find it.", pool: 4000, wallClockMs: 60000 },
      { kind: "agent_started", t: 0, agent: "a1", index: 0, seed: 700, systemPrompt: "You are agent a1.", tools: ["read_shard", "claim"] },
      { kind: "status", t: 5, agent: "a1", text: "reading shard 1" },
      { kind: "model_call", t: 900, agent: "a1", call: 0, content: "", reasoning: "hm", toolCalls: [{ id: "c1", name: "read_shard", args: { shard: 1 } }], tokensIn: 400, tokensOut: 40, ms: 880, stopReason: "toolUse" },
      { kind: "tool_call", t: 901, agent: "a1", callId: "c1", tool: "read_shard", args: { shard: 1 } },
      { kind: "tool_result", t: 950, agent: "a1", callId: "c1", tool: "read_shard", isError: false, text: "The first digit is 4.", ms: 49 },
      { kind: "message", t: 960, id: "m0", from: "a1", to: "a2", text: "digit 1 is 4", urgent: false },
      { kind: "message", t: 961, id: "m1", from: "a1", to: { topic: "all" }, text: "stop", urgent: true },
      { kind: "message_delivered", t: 970, agent: "a2", messageId: "m0", delivery: 0 },
      { kind: "idle", t: 980, agent: "a3" },
      { kind: "wake", t: 990, agent: "a3", reason: "message" },
      { kind: "blackboard", t: 995, agent: "a1", text: "digit 1 = 4" },
      { kind: "claim_submitted", t: 1000, agent: "a1", answer: "4719", evidence: "shards 1,3,5,7" },
      { kind: "verification", t: 1000, claimOf: "a1", passed: true },
      { kind: "agent_finished", t: 1001, agent: "a1", reason: "claimed" },
      { kind: "run_finished", t: 1002, reason: "solved", solved: true, wallMs: 1002, totalTokens: 440 },
    ];
    for (const s of samples) expect(() => Event.parse(s)).not.toThrow();
  });

  it("rejects unknown kinds, bad agent ids and unknown end reasons", () => {
    expect(() => Event.parse({ kind: "nope", t: 0 })).toThrow();
    expect(() => Event.parse({ kind: "idle", t: 0, agent: "bob" })).toThrow();
    expect(() => Event.parse({ kind: "run_finished", t: 1, reason: "bored", solved: false, wallMs: 1, totalTokens: 0 })).toThrow();
    expect(() => Event.parse({ kind: "idle", t: -1, agent: "a1" })).toThrow();
  });
});

describe("inbox blocks", () => {
  const msgs: InboxMessage[] = [
    { id: "m0", from: "a2", to: "a1", text: "hello", urgent: false },
    { id: "m1", from: "a3", to: { topic: "all" }, text: "solved, stop", urgent: true },
    { id: "m2", from: "a4", to: "a1", text: "digit 3 is 1", urgent: false },
  ];

  it("puts urgent messages first and keeps arrival order otherwise", () => {
    expect(orderBlock(msgs).map((m) => m.id)).toEqual(["m1", "m0", "m2"]);
  });

  it("formats one line per message", () => {
    expect(formatBlock(msgs)).toBe(
      "[URGENT from a3 on #all] solved, stop\n[from a2] hello\n[from a4] digit 3 is 1",
    );
  });

  it("is stable when applied twice", () => {
    expect(orderBlock(orderBlock(msgs))).toEqual(orderBlock(msgs));
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run packages/schema`
Expected: FAIL, `Failed to resolve import "./index.ts"`.

- [ ] **Step 5: Implement the schema**

`packages/schema/src/events.ts`:
```ts
import { z } from "zod";

export const AgentId = z.string().regex(/^a\d+$/);
const T = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();

export const ConditionName = z.enum(["single", "isolated", "stigmergic", "polylogue", "polylogue-bare"]);
export type ConditionName = z.infer<typeof ConditionName>;

export const RunEndReason = z.enum(["solved", "budget", "killed", "all_idle", "infra_error"]);
export type RunEndReason = z.infer<typeof RunEndReason>;

export const AgentEndReason = z.enum(["claimed", "idle", "context", "run_ended"]);
export type AgentEndReason = z.infer<typeof AgentEndReason>;

export const Recipient = z.union([AgentId, z.object({ topic: z.string().min(1) })]);
export type Recipient = z.infer<typeof Recipient>;

export const ToolCallInfo = z.object({ id: z.string(), name: z.string(), args: z.unknown() });

export const Event = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run_started"), t: T, condition: ConditionName, n: z.number().int().positive(), taskId: z.string(), task: z.string(), pool: z.number().int().positive(), wallClockMs: z.number().int().positive() }),
  z.object({ kind: z.literal("agent_started"), t: T, agent: AgentId, index: Count, seed: z.number().int(), systemPrompt: z.string(), tools: z.array(z.string()) }),
  z.object({ kind: z.literal("status"), t: T, agent: AgentId, text: z.string() }),
  z.object({ kind: z.literal("model_call"), t: T, agent: AgentId, call: Count, content: z.string(), reasoning: z.string(), toolCalls: z.array(ToolCallInfo), tokensIn: Count, tokensOut: Count, ms: Count, stopReason: z.string(), error: z.string().optional() }),
  z.object({ kind: z.literal("tool_call"), t: T, agent: AgentId, callId: z.string(), tool: z.string(), args: z.unknown() }),
  z.object({ kind: z.literal("tool_result"), t: T, agent: AgentId, callId: z.string(), tool: z.string(), isError: z.boolean(), text: z.string(), ms: Count }),
  z.object({ kind: z.literal("message"), t: T, id: z.string(), from: AgentId, to: Recipient, text: z.string(), urgent: z.boolean() }),
  z.object({ kind: z.literal("message_delivered"), t: T, agent: AgentId, messageId: z.string(), delivery: Count }),
  z.object({ kind: z.literal("idle"), t: T, agent: AgentId }),
  z.object({ kind: z.literal("wake"), t: T, agent: AgentId, reason: z.literal("message") }),
  z.object({ kind: z.literal("blackboard"), t: T, agent: AgentId, text: z.string() }),
  z.object({ kind: z.literal("claim_submitted"), t: T, agent: AgentId, answer: z.string(), evidence: z.string() }),
  z.object({ kind: z.literal("verification"), t: T, claimOf: AgentId, passed: z.boolean(), detail: z.string().optional() }),
  z.object({ kind: z.literal("agent_finished"), t: T, agent: AgentId, reason: AgentEndReason }),
  z.object({ kind: z.literal("run_finished"), t: T, reason: RunEndReason, solved: z.boolean(), wallMs: Count, totalTokens: Count }),
]);
export type Event = z.infer<typeof Event>;
export type EventKind = Event["kind"];
export type Of<K extends EventKind> = Extract<Event, { kind: K }>;
/** An event before the log stamps its time. */
export type EventInput = Event extends infer E ? (E extends Event ? Omit<E, "t"> : never) : never;
```

`packages/schema/src/run.ts`:
```ts
import { z } from "zod";
import { ConditionName, RunEndReason } from "./events.ts";

export const RunStatus = z.enum(["running", "solved", "unsolved", "infra_error"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunRow = z.object({
  id: z.string(),
  condition: ConditionName,
  n: z.number().int().positive(),
  taskId: z.string(),
  seed: z.number().int().nonnegative(),
  model: z.string(),
  revision: z.string(),
  sampling: z.record(z.string(), z.unknown()),
  configHash: z.string(),
  gitSha: z.string().nullable(),
  status: RunStatus,
  endReason: RunEndReason.nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type RunRow = z.infer<typeof RunRow>;
```

`packages/schema/src/inbox.ts`:
```ts
export interface InboxMessage {
  id: string;
  from: string;
  to: string | { topic: string };
  text: string;
  urgent: boolean;
}

/** Urgent messages first; arrival order is kept within each group. */
export function orderBlock(msgs: readonly InboxMessage[]): InboxMessage[] {
  return [...msgs.filter((m) => m.urgent), ...msgs.filter((m) => !m.urgent)];
}

/** The exact text an agent receives as one user message at a turn boundary. */
export function formatBlock(msgs: readonly InboxMessage[]): string {
  return orderBlock(msgs)
    .map((m) => `[${m.urgent ? "URGENT " : ""}from ${m.from}${typeof m.to === "string" ? "" : ` on #${m.to.topic}`}] ${m.text}`)
    .join("\n");
}
```

`packages/schema/src/index.ts`:
```ts
export * from "./events.ts";
export * from "./run.ts";
export * from "./inbox.ts";
```

- [ ] **Step 6: Run tests and type-check**

Run: `npx vitest run packages/schema && npx tsc -p tsconfig.json`
Expected: 5 tests PASS; tsc prints nothing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .npmrc .gitignore tsconfig.base.json tsconfig.json vitest.config.ts packages
git commit -m "Monorepo scaffold and event schema"
```

---

### Task 2: Clock and EventLog

**Files:**
- Create: `packages/runtime/src/clock.ts`, `packages/runtime/src/log/event-log.ts`
- Test: `packages/runtime/src/log/event-log.test.ts`

**Interfaces:**
- Consumes: `Event`, `RunRow`, `RunStatus`, `RunEndReason` from `@polylogue/schema`.
- Produces:
  - `interface Clock { now(): number; setTimer(fn: () => void, ms: number): () => void }`, `realClock: Clock`, `class FakeClock implements Clock { advance(ms: number): void }`
  - `type NewRun = Omit<RunRow, "status" | "endReason" | "endedAt">`
  - `interface StoredEvent { runId: string; seq: number; event: Event }`
  - `class EventLog { constructor(path: string, opts?: { readonly?: boolean }); createRun(row: NewRun): void; finishRun(id: string, status: RunStatus, endReason: RunEndReason, endedAt: string): void; append(runId: string, event: Event): number; events(runId: string, fromSeq?: number): StoredEvent[]; runs(): RunRow[]; run(id: string): RunRow | undefined; subscribe(runId: string, fn: (e: StoredEvent) => void): () => void; close(): void }`

- [ ] **Step 1: Write the failing tests**

`packages/runtime/src/log/event-log.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/runtime/src/log`
Expected: FAIL, cannot resolve `./event-log.ts`.

- [ ] **Step 3: Implement**

`packages/runtime/src/clock.ts`:
```ts
export interface Clock {
  now(): number;
  /** Calls fn after ms; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

export class FakeClock implements Clock {
  private t = 0;
  private timers: { at: number; fn: () => void; live: boolean }[] = [];

  now(): number {
    return this.t;
  }

  setTimer(fn: () => void, ms: number): () => void {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.live && x.at <= this.t).sort((a, b) => a.at - b.at);
    for (const x of due) {
      x.live = false;
      x.fn();
    }
  }
}
```

`packages/runtime/src/log/event-log.ts`:
```ts
import Database from "better-sqlite3";
import { Event, RunRow, type RunEndReason, type RunStatus } from "@polylogue/schema";

export type NewRun = Omit<RunRow, "status" | "endReason" | "endedAt">;
export interface StoredEvent {
  runId: string;
  seq: number;
  event: Event;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, condition TEXT NOT NULL, n INTEGER NOT NULL, task_id TEXT NOT NULL, seed INTEGER NOT NULL,
  model TEXT NOT NULL, revision TEXT NOT NULL, sampling TEXT NOT NULL, config_hash TEXT NOT NULL, git_sha TEXT,
  status TEXT NOT NULL, end_reason TEXT, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (run_id, seq)
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;

interface RunDbRow {
  id: string; condition: string; n: number; task_id: string; seed: number; model: string; revision: string;
  sampling: string; config_hash: string; git_sha: string | null; status: string; end_reason: string | null;
  started_at: string; ended_at: string | null;
}

const toRun = (r: RunDbRow): RunRow =>
  RunRow.parse({
    id: r.id, condition: r.condition, n: r.n, taskId: r.task_id, seed: r.seed, model: r.model, revision: r.revision,
    sampling: JSON.parse(r.sampling), configHash: r.config_hash, gitSha: r.git_sha, status: r.status,
    endReason: r.end_reason, startedAt: r.started_at, endedAt: r.ended_at,
  });

export class EventLog {
  private db: Database.Database;
  private nextSeq = new Map<string, number>();
  private listeners = new Map<string, Set<(e: StoredEvent) => void>>();

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    const readonly = opts.readonly ?? false;
    this.db = new Database(path, { readonly, fileMustExist: readonly });
    if (!readonly) {
      this.db.pragma("journal_mode = WAL");
      this.db.exec(SCHEMA);
    }
  }

  createRun(row: NewRun): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, condition, n, task_id, seed, model, revision, sampling, config_hash, git_sha, status, end_reason, started_at, ended_at)
         VALUES (@id, @condition, @n, @taskId, @seed, @model, @revision, @sampling, @configHash, @gitSha, 'running', NULL, @startedAt, NULL)`,
      )
      .run({ ...row, sampling: JSON.stringify(row.sampling) });
  }

  finishRun(id: string, status: RunStatus, endReason: RunEndReason, endedAt: string): void {
    this.db.prepare("UPDATE runs SET status = ?, end_reason = ?, ended_at = ? WHERE id = ?").run(status, endReason, endedAt, id);
  }

  append(runId: string, event: Event): number {
    const e = Event.parse(event);
    const seq = this.seqFor(runId);
    this.db
      .prepare("INSERT INTO events (run_id, seq, t, kind, payload) VALUES (?, ?, ?, ?, ?)")
      .run(runId, seq, e.t, e.kind, JSON.stringify(e));
    this.nextSeq.set(runId, seq + 1);
    const stored = { runId, seq, event: e };
    for (const fn of this.listeners.get(runId) ?? []) fn(stored);
    return seq;
  }

  events(runId: string, fromSeq = 0): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT seq, payload FROM events WHERE run_id = ? AND seq >= ? ORDER BY seq")
      .all(runId, fromSeq) as { seq: number; payload: string }[];
    return rows.map((r) => ({ runId, seq: r.seq, event: Event.parse(JSON.parse(r.payload)) }));
  }

  runs(): RunRow[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY started_at").all() as RunDbRow[]).map(toRun);
  }

  run(id: string): RunRow | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunDbRow | undefined;
    return r && toRun(r);
  }

  subscribe(runId: string, fn: (e: StoredEvent) => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(fn);
    this.listeners.set(runId, set);
    return () => set.delete(fn);
  }

  close(): void {
    this.db.close();
  }

  private seqFor(runId: string): number {
    const known = this.nextSeq.get(runId);
    if (known !== undefined) return known;
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM events WHERE run_id = ?").get(runId) as { m: number | null };
    return r.m === null ? 0 : r.m + 1;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/runtime/src/log && npx tsc -p tsconfig.json`
Expected: 7 tests PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/clock.ts packages/runtime/src/log
git commit -m "Clock and append-only SQLite event log"
```

---

### Task 3: Fake OpenAI server and the model provider

**Files:**
- Create: `packages/runtime/src/testing/fake-openai.ts`, `packages/runtime/src/model/provider.ts`
- Test: `packages/runtime/src/model/provider.test.ts`

**Interfaces:**
- Produces:
  - `interface ModelConfig { baseUrl: string; id: string; hfRepo: string; revision: string; contextWindow: number; maxTokens: number; reasoningEffort: "low" | "medium" | "high" | "xhigh"; timeoutMs: number; maxRetries: number }`
  - `interface ModelRuntime { model: Model<"openai-completions">; streamFor(seed: number): StreamFn }`, `makeModelRuntime(cfg: ModelConfig): ModelRuntime`
  - `checkServer(cfg: ModelConfig, fetchFn?: typeof fetch): Promise<void>` (throws with a readable message)
  - `samplingRecord(cfg: ModelConfig): Record<string, unknown>`
  - Testing: `interface FakeReply { content?: string; reasoning?: string; toolCalls?: { name: string; args: unknown }[]; delayMs?: number; status?: number; usage?: { in: number; out: number } }`, `interface FakeRequest { agentIndex: number; call: number; body: any }`, `type Policy = (req: FakeRequest) => FakeReply`, `startFakeOpenAI(policy: Policy, opts?: { modelId?: string; root?: string }): Promise<FakeServer>` with `FakeServer { baseUrl: string; requests: FakeRequest[]; close(): Promise<void> }`, `testModelConfig(baseUrl: string, over?: Partial<ModelConfig>): ModelConfig`.

The fake server identifies the agent by `seed % 100` (the agent index) and counts calls per agent, so scripted policies stay deterministic however the agents interleave. Retries count as calls.

- [ ] **Step 1: Write the fake server**

`packages/runtime/src/testing/fake-openai.ts`:
```ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelConfig } from "../model/provider.ts";

export interface FakeReply {
  content?: string;
  reasoning?: string;
  toolCalls?: { name: string; args: unknown }[];
  delayMs?: number;
  status?: number;
  usage?: { in: number; out: number };
}
export interface FakeRequest {
  agentIndex: number;
  call: number;
  // biome-ignore lint: request bodies are arbitrary JSON
  body: any;
}
export type Policy = (req: FakeRequest) => FakeReply;
export interface FakeServer {
  baseUrl: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeOpenAI(
  policy: Policy,
  opts: { modelId?: string; root?: string } = {},
): Promise<FakeServer> {
  const modelId = opts.modelId ?? "qwen3.8-27b";
  const root = opts.root ?? "unsloth/Qwen3.8-27B-NVFP4";
  const requests: FakeRequest[] = [];
  const perAgent = new Map<number, number>();

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model", root }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const agentIndex = typeof body.seed === "number" ? body.seed % 100 : -1;
    const call = perAgent.get(agentIndex) ?? 0;
    perAgent.set(agentIndex, call + 1);
    const request = { agentIndex, call, body };
    requests.push(request);
    const reply = policy(request);
    if (reply.delayMs) await sleep(reply.delayMs);
    if (reply.status && reply.status >= 400) {
      res.statusCode = reply.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: `fake error ${reply.status}` } }));
      return;
    }
    const usage = { prompt_tokens: reply.usage?.in ?? 100, completion_tokens: reply.usage?.out ?? 20 };
    const id = `fake-${agentIndex}-${call}`;
    const toolCalls = (reply.toolCalls ?? []).map((tc, i) => ({
      index: i,
      id: `call_${agentIndex}_${call}_${i}`,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
    res.setHeader("content-type", "text/event-stream");
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const base = { id, object: "chat.completion.chunk", model: modelId };
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant" } }] });
    if (reply.reasoning) send({ ...base, choices: [{ index: 0, delta: { reasoning_content: reply.reasoning } }] });
    if (reply.content) send({ ...base, choices: [{ index: 0, delta: { content: reply.content } }] });
    for (const tc of toolCalls) send({ ...base, choices: [{ index: 0, delta: { tool_calls: [tc] } }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" }] });
    send({ ...base, choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
    res.end("data: [DONE]\n\n");
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

export function testModelConfig(baseUrl: string, over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    baseUrl,
    id: "qwen3.8-27b",
    hfRepo: "unsloth/Qwen3.8-27B-NVFP4",
    revision: "7d6f8d4d72f56b92b3cdbf22f156b90e1bab0108",
    contextWindow: 262144,
    maxTokens: 4096,
    reasoningEffort: "medium",
    timeoutMs: 30_000,
    maxRetries: 0,
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing provider tests**

`packages/runtime/src/model/provider.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { checkServer, makeModelRuntime, samplingRecord } from "./provider.ts";
import { startFakeOpenAI, testModelConfig, type FakeServer } from "../testing/fake-openai.ts";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("model provider", () => {
  it("sends temperature 0, the agent's seed and the pinned chat_template_kwargs", async () => {
    fake = await startFakeOpenAI(() => ({ content: "hello" }));
    const rt = makeModelRuntime(testModelConfig(fake.baseUrl, { reasoningEffort: "medium" }));
    const agent = new Agent({ initialState: { systemPrompt: "You are a1.", model: rt.model, thinkingLevel: "off", tools: [] }, streamFn: rt.streamFor(1702) });
    await agent.prompt("hi");
    const body = fake.requests[0]!.body;
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(1702);
    expect(body.chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
    expect(body.model).toBe("qwen3.8-27b");
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a1." });
    expect(fake.requests[0]!.agentIndex).toBe(2);
    const last = agent.state.messages.at(-1) as { usage: { input: number; output: number } };
    expect(last.usage.input).toBe(100);
    expect(last.usage.output).toBe(20);
  });

  it("retries transport errors maxRetries times, then reports an error message", async () => {
    fake = await startFakeOpenAI(() => ({ status: 500 }));
    const rt = makeModelRuntime(testModelConfig(fake.baseUrl, { maxRetries: 2 }));
    const agent = new Agent({ initialState: { systemPrompt: "s", model: rt.model, thinkingLevel: "off", tools: [] }, streamFn: rt.streamFor(100) });
    await agent.prompt("hi");
    expect(fake.requests).toHaveLength(3);
    expect((agent.state.messages.at(-1) as { stopReason: string }).stopReason).toBe("error");
  });

  it("checks the served model id and repository", async () => {
    fake = await startFakeOpenAI(() => ({}), { modelId: "qwen3.8-27b", root: "unsloth/Qwen3.8-27B-NVFP4" });
    await expect(checkServer(testModelConfig(fake.baseUrl))).resolves.toBeUndefined();
    await expect(checkServer(testModelConfig(fake.baseUrl, { id: "other" }))).rejects.toThrow(/does not serve "other"/);
    await expect(checkServer(testModelConfig(fake.baseUrl, { hfRepo: "x/y" }))).rejects.toThrow(/serves unsloth\/Qwen3.8-27B-NVFP4, expected x\/y/);
  });

  it("records the sampling settings", () => {
    expect(samplingRecord(testModelConfig("http://x/v1"))).toEqual({ temperature: 0, reasoningEffort: "medium", maxTokens: 4096, maxRetries: 0, timeoutMs: 30000 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run packages/runtime/src/model`
Expected: FAIL, cannot resolve `./provider.ts`.

- [ ] **Step 4: Implement the provider**

`packages/runtime/src/model/provider.ts`:
```ts
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export interface ModelConfig {
  baseUrl: string;
  id: string;
  hfRepo: string;
  revision: string;
  contextWindow: number;
  maxTokens: number;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  timeoutMs: number;
  maxRetries: number;
}

export interface ModelRuntime {
  model: Model<"openai-completions">;
  streamFor(seed: number): StreamFn;
}

const PROVIDER = "spark";

export function makeModelRuntime(cfg: ModelConfig): ModelRuntime {
  const model: Model<"openai-completions"> = {
    id: cfg.id,
    name: cfg.id,
    api: "openai-completions",
    provider: PROVIDER,
    baseUrl: cfg.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: PROVIDER,
      name: "DGX Spark (vLLM)",
      baseUrl: cfg.baseUrl,
      auth: { apiKey: { name: "vLLM", resolve: async () => ({ auth: {} }) } },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  return {
    model,
    streamFor: (seed) => (m, context, options) =>
      models.streamSimple(m, context, {
        ...options,
        apiKey: "none",
        temperature: 0,
        maxRetries: cfg.maxRetries,
        timeoutMs: cfg.timeoutMs,
        onPayload: (payload) => ({
          ...(payload as Record<string, unknown>),
          seed,
          chat_template_kwargs: { reasoning_effort: cfg.reasoningEffort },
        }),
      }),
  };
}

export async function checkServer(cfg: ModelConfig, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(`${cfg.baseUrl}/models`);
  if (!res.ok) throw new Error(`model server at ${cfg.baseUrl} answered ${res.status}`);
  const body = (await res.json()) as { data: { id: string; root?: string }[] };
  const served = body.data.find((m) => m.id === cfg.id);
  if (!served) throw new Error(`model server at ${cfg.baseUrl} does not serve "${cfg.id}" (serves ${body.data.map((m) => m.id).join(", ")})`);
  if (served.root !== cfg.hfRepo) throw new Error(`model "${cfg.id}" serves ${served.root}, expected ${cfg.hfRepo}`);
}

export function samplingRecord(cfg: ModelConfig): Record<string, unknown> {
  return { temperature: 0, reasoningEffort: cfg.reasoningEffort, maxTokens: cfg.maxTokens, maxRetries: cfg.maxRetries, timeoutMs: cfg.timeoutMs };
}
```

If `tsc` rejects the arrow returned by `streamFor` against `StreamFn` because of the option types, keep the runtime behaviour and annotate the parameters with the types `StreamFn` declares (`Parameters<StreamFn>`); do not cast the whole function to `any`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/runtime/src/model && npx tsc -p tsconfig.json`
Expected: 4 tests PASS (the retry test takes ~2 s because of pi's backoff), tsc silent.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/testing packages/runtime/src/model
git commit -m "Model provider on pi-ai and a fake OpenAI server for tests"
```

---

### Task 4: Controller

**Files:**
- Create: `packages/runtime/src/control/controller.ts`
- Test: `packages/runtime/src/control/controller.test.ts`

**Interfaces:**
- Consumes: `Clock` (Task 2), `EventInput`, `RunEndReason` (Task 1).
- Produces:
  - `type Refusal = "budget" | "context" | "ended"`
  - `interface ControlledAgent { id: string; isFinished(): boolean; isIdleWithNothingPending(): boolean }`
  - `interface ControllerConfig { pool: number; wallClockMs: number; messagesPerMinute: number; maxMessageChars: number; contextWindow: number }`
  - `interface ControllerDeps { log(e: EventInput): void; clock: Clock; verify(answer: string): { passed: boolean; detail?: string } }`
  - `class Controller { used: number; ended: RunEndReason | null; done: Promise<RunEndReason>; register(a: ControlledAgent): void; start(): void; charge(tokens: number): void; admitCall(estimate: number): Refusal | null; checkMessage(agentId: string, text: string): string | null; claim(agentId: string, answer: string, evidence: string): string; checkAllIdle(): void; infraError(detail: string): void; end(reason: RunEndReason): void }`

Rules (spec §5): the pool is checked before each call; a call is refused with `budget` once `used >= pool`, and that refusal ends the run with `budget`. A call whose estimated prompt plus answer exceeds `contextWindow` is refused with `context` (the run goes on). After the end every call is refused with `ended`. Rate limit: at most `messagesPerMinute` messages per agent in any 60 000 ms window, and at most `maxMessageChars` characters. `end` is idempotent; the first reason wins. `claim` throws on a second claim by the same agent or after the end; otherwise it logs `claim_submitted` and `verification`, ends the run with `solved` on a pass, and returns `Claim submitted.` either way.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/src/control/controller.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { EventInput } from "@polylogue/schema";
import { Controller, type ControlledAgent } from "./controller.ts";
import { FakeClock } from "../clock.ts";

function setup(over: Partial<{ pool: number; wallClockMs: number; messagesPerMinute: number; maxMessageChars: number; contextWindow: number }> = {}) {
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
    expect(c.admitCall(10)).toBeNull();
    c.charge(60);
    expect(c.admitCall(10)).toBeNull();
    c.charge(60);
    expect(c.admitCall(10)).toBe("budget");
    expect(await c.done).toBe("budget");
    expect(c.admitCall(10)).toBe("ended");
  });

  it("refuses a call whose estimate exceeds the context window without ending the run", () => {
    const { c } = setup({ contextWindow: 5000 });
    expect(c.admitCall(5001)).toBe("context");
    expect(c.ended).toBeNull();
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

  it("logs claim and verification, tells the agent nothing, and ends solved on a pass", async () => {
    const { c, logged } = setup();
    expect(c.claim("a1", "1234", "guess")).toBe("Claim submitted.");
    expect(c.ended).toBeNull();
    expect(() => c.claim("a1", "4719", "again")).toThrow(/already submitted a claim/);
    expect(c.claim("a2", " 4719 ", "shards")).toBe("Claim submitted.");
    expect(await c.done).toBe("solved");
    expect(logged).toEqual([
      { kind: "claim_submitted", agent: "a1", answer: "1234", evidence: "guess" },
      { kind: "verification", claimOf: "a1", passed: false, detail: "wrong code" },
      { kind: "claim_submitted", agent: "a2", answer: " 4719 ", evidence: "shards" },
      { kind: "verification", claimOf: "a2", passed: true },
    ]);
    expect(() => c.claim("a3", "4719", "late")).toThrow(/run has ended/);
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/runtime/src/control`
Expected: FAIL, cannot resolve `./controller.ts`.

- [ ] **Step 3: Implement**

`packages/runtime/src/control/controller.ts`:
```ts
import type { EventInput, RunEndReason } from "@polylogue/schema";
import type { Clock } from "../clock.ts";

export type Refusal = "budget" | "context" | "ended";

export interface ControlledAgent {
  id: string;
  isFinished(): boolean;
  isIdleWithNothingPending(): boolean;
}

export interface ControllerConfig {
  pool: number;
  wallClockMs: number;
  messagesPerMinute: number;
  maxMessageChars: number;
  contextWindow: number;
}

export interface ControllerDeps {
  log(e: EventInput): void;
  clock: Clock;
  verify(answer: string): { passed: boolean; detail?: string };
}

const MINUTE = 60_000;

export class Controller {
  used = 0;
  ended: RunEndReason | null = null;
  readonly done: Promise<RunEndReason>;
  private resolveDone!: (r: RunEndReason) => void;
  private agents: ControlledAgent[] = [];
  private claimed = new Set<string>();
  private sent = new Map<string, number[]>();
  private cancelTimer: () => void = () => {};

  constructor(
    private readonly cfg: ControllerConfig,
    private readonly deps: ControllerDeps,
  ) {
    this.done = new Promise((r) => {
      this.resolveDone = r;
    });
  }

  register(a: ControlledAgent): void {
    this.agents.push(a);
  }

  start(): void {
    this.cancelTimer = this.deps.clock.setTimer(() => this.end("killed"), this.cfg.wallClockMs);
  }

  charge(tokens: number): void {
    this.used += tokens;
  }

  admitCall(estimate: number): Refusal | null {
    if (this.ended) return "ended";
    if (this.used >= this.cfg.pool) {
      this.end("budget");
      return "budget";
    }
    if (estimate > this.cfg.contextWindow) return "context";
    return null;
  }

  /** Returns an error text for the agent, or null when the message may be sent. */
  checkMessage(agentId: string, text: string): string | null {
    if (text.length > this.cfg.maxMessageChars) return `Messages can be at most ${this.cfg.maxMessageChars} characters; yours has ${text.length}.`;
    const now = this.deps.clock.now();
    const recent = (this.sent.get(agentId) ?? []).filter((t) => now - t < MINUTE);
    if (recent.length >= this.cfg.messagesPerMinute) {
      this.sent.set(agentId, recent);
      return `You can send at most ${this.cfg.messagesPerMinute} messages per minute. Try again later.`;
    }
    recent.push(now);
    this.sent.set(agentId, recent);
    return null;
  }

  claim(agentId: string, answer: string, evidence: string): string {
    if (this.ended) throw new Error("The run has ended.");
    if (this.claimed.has(agentId)) throw new Error("You have already submitted a claim.");
    this.claimed.add(agentId);
    this.deps.log({ kind: "claim_submitted", agent: agentId, answer, evidence });
    const v = this.deps.verify(answer);
    this.deps.log(v.detail === undefined ? { kind: "verification", claimOf: agentId, passed: v.passed } : { kind: "verification", claimOf: agentId, passed: v.passed, detail: v.detail });
    if (v.passed) this.end("solved");
    return "Claim submitted.";
  }

  checkAllIdle(): void {
    if (this.ended || this.agents.length === 0) return;
    if (this.agents.every((a) => a.isFinished() || a.isIdleWithNothingPending())) this.end("all_idle");
  }

  infraError(_detail: string): void {
    this.end("infra_error");
  }

  end(reason: RunEndReason): void {
    if (this.ended) return;
    this.ended = reason;
    this.cancelTimer();
    this.resolveDone(reason);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/runtime/src/control && npx tsc -p tsconfig.json`
Expected: 7 tests PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/control
git commit -m "Controller: token pool, context guard, wall clock, rate limits, blind claims"
```

---

### Task 5: Bus, blackboard, conditions, tools and the toy task

**Files:**
- Create: `packages/runtime/src/run/context.ts`, `packages/runtime/src/comm/bus.ts`, `packages/runtime/src/comm/blackboard.ts`, `packages/runtime/src/conditions.ts`, `packages/runtime/src/tools/work-tool.ts`, `packages/runtime/src/tools/comm-tools.ts`, `packages/runtime/src/tools/blackboard-tools.ts`, `packages/runtime/src/tools/claim-tool.ts`, `packages/runtime/src/tools/build-tools.ts`, `packages/runtime/src/toy/vault.ts`
- Test: `packages/runtime/src/comm/comm.test.ts`

**Interfaces:**
- Consumes: `Controller` (Task 4), `InboxMessage`, `EventInput`, `ConditionName` (Task 1).
- Produces:
  - `run/context.ts`: `type AgentPhase = "new" | "working" | "idle" | "finished"`; `interface AgentDirectory { ids(): string[]; status(id: string): string; phase(id: string): AgentPhase }`; `interface RunContext { log(e: EventInput): void; controller: Controller; bus: Bus; board: Blackboard; dir: AgentDirectory }`
  - `comm/bus.ts`: `interface BusMember { id: string; receive(msg: InboxMessage): void; isFinished(): boolean }`; `class Bus { constructor(log: (e: EventInput) => void); add(m: BusMember): void; has(id: string): boolean; isFinished(id: string): boolean; ids(): string[]; subscribe(agentId: string, topic: string): void; post(from: string, to: string | { topic: string }, text: string, urgent: boolean): { id: string; recipients: string[] } }`
  - `comm/blackboard.ts`: `class Blackboard { constructor(log: (e: EventInput) => void); append(agent: string, text: string): void; read(): string }`
  - `conditions.ts`: `interface Condition { name: ConditionName; n: number; blackboard: boolean; messaging: boolean; norms: boolean }`; `CONDITIONS: Record<ConditionName, Condition>`; `NORMS: string`; `systemPrompt(c: Condition, agentId: string, ids: string[]): string`; `toolNames(c: Condition, workTools: string[]): string[]`
  - `tools/work-tool.ts`: `interface WorkTool { name: string; description: string; parameters: TSchema; run(args: any, signal?: AbortSignal): Promise<string> }`; `toAgentTool(w: WorkTool): AgentTool<any>`
  - `tools/build-tools.ts`: `buildTools(c: Condition, agentId: string, ctx: RunContext, work: WorkTool[]): AgentTool<any>[]` (order: work tools, `claim`, then blackboard tools, then `send`, `publish`, `subscribe`, `roster`)
  - `toy/vault.ts`: `interface ToyTask { id: string; prompt: string; shards: Record<number, string>; verify(answer: string): { passed: boolean; detail?: string } }`; `VAULT: ToyTask`; `TASKS: Record<string, ToyTask>`; `readShardTool(task: ToyTask, delayMs: number): WorkTool`

Tool error convention: a tool that refuses throws `new Error(<plain sentence>)`; pi turns it into an error tool result (measured 2026-10-11: `isError: true`, the text reaches the model as the tool message).

- [ ] **Step 1: Write the failing tests**

`packages/runtime/src/comm/comm.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventInput, InboxMessage } from "@polylogue/schema";
import { Bus, type BusMember } from "./bus.ts";
import { Blackboard } from "./blackboard.ts";
import { CONDITIONS, NORMS, systemPrompt, toolNames } from "../conditions.ts";
import { buildTools } from "../tools/build-tools.ts";
import { Controller } from "../control/controller.ts";
import { FakeClock } from "../clock.ts";
import { VAULT, readShardTool } from "../toy/vault.ts";
import type { AgentDirectory, RunContext } from "../run/context.ts";

function member(id: string, finished = false): BusMember & { got: InboxMessage[]; done: boolean } {
  const m = { id, got: [] as InboxMessage[], done: finished, receive(msg: InboxMessage) { m.got.push(msg); }, isFinished: () => m.done };
  return m;
}

function world(condition: keyof typeof CONDITIONS = "polylogue") {
  const logged: EventInput[] = [];
  const log = (e: EventInput) => logged.push(e);
  const clock = new FakeClock();
  const controller = new Controller({ pool: 1e6, wallClockMs: 1e6, messagesPerMinute: 3, maxMessageChars: 50, contextWindow: 1e6 }, { log, clock, verify: VAULT.verify });
  const bus = new Bus(log);
  const board = new Blackboard(log);
  const members = ["a1", "a2", "a3", "a4"].map((id) => member(id));
  for (const m of members) bus.add(m);
  const dir: AgentDirectory = { ids: () => members.map((m) => m.id), status: (id) => (id === "a2" ? "reading shard 3" : ""), phase: (id) => (members.find((m) => m.id === id)!.done ? "finished" : "working") };
  const ctx: RunContext = { log, controller, bus, board, dir };
  return { logged, bus, board, members, ctx, controller };
}

const call = async (tools: AgentTool<any>[], name: string, args: unknown) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  const r = await t.execute("id", args as never);
  return r.content.map((c) => ("text" in c ? c.text : "")).join("");
};

describe("Bus", () => {
  it("delivers direct messages to one agent and topics to subscribers except the sender", () => {
    const { bus, members, logged } = world();
    bus.subscribe("a3", "frontend");
    expect(bus.post("a1", "a2", "hi", false)).toEqual({ id: "m0", recipients: ["a2"] });
    expect(bus.post("a1", { topic: "all" }, "everyone", true).recipients).toEqual(["a2", "a3", "a4"]);
    expect(bus.post("a2", { topic: "frontend" }, "fe", false).recipients).toEqual(["a3"]);
    expect(members[1]!.got.map((m) => m.id)).toEqual(["m0", "m1"]);
    expect(members[2]!.got.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(logged.filter((e) => e.kind === "message")).toHaveLength(3);
  });

  it("does not deliver to finished agents", () => {
    const { bus, members } = world();
    members[3]!.done = true;
    expect(bus.post("a1", { topic: "all" }, "x", false).recipients).toEqual(["a2", "a3"]);
    expect(members[3]!.got).toEqual([]);
  });
});

describe("Blackboard", () => {
  it("appends entries with their author and logs each", () => {
    const { board, logged } = world();
    expect(board.read()).toBe("(the blackboard is empty)");
    board.append("a1", "digit 1 = 4");
    board.append("a2", "digit 3 = 1");
    expect(board.read()).toBe("[a1] digit 1 = 4\n[a2] digit 3 = 1");
    expect(logged).toEqual([{ kind: "blackboard", agent: "a1", text: "digit 1 = 4" }, { kind: "blackboard", agent: "a2", text: "digit 3 = 1" }]);
  });
});

describe("conditions", () => {
  it("gives each condition exactly its tool set", () => {
    const work = ["read_shard"];
    expect(toolNames(CONDITIONS.single, work)).toEqual(["read_shard", "claim"]);
    expect(toolNames(CONDITIONS.isolated, work)).toEqual(["read_shard", "claim"]);
    expect(toolNames(CONDITIONS.stigmergic, work)).toEqual(["read_shard", "claim", "read_blackboard", "append_blackboard"]);
    const comm = ["read_shard", "claim", "read_blackboard", "append_blackboard", "send", "publish", "subscribe", "roster"];
    expect(toolNames(CONDITIONS.polylogue, work)).toEqual(comm);
    expect(toolNames(CONDITIONS["polylogue-bare"], work)).toEqual(comm);
    expect([1, 4, 4, 4, 4]).toEqual(["single", "isolated", "stigmergic", "polylogue", "polylogue-bare"].map((n) => CONDITIONS[n as keyof typeof CONDITIONS].n));
  });

  it("puts the norms in the polylogue prompt only", () => {
    const ids = ["a1", "a2", "a3", "a4"];
    expect(systemPrompt(CONDITIONS.polylogue, "a2", ids)).toContain(NORMS);
    for (const c of ["single", "isolated", "stigmergic", "polylogue-bare"] as const) expect(systemPrompt(CONDITIONS[c], "a2", ids)).not.toContain(NORMS);
    expect(systemPrompt(CONDITIONS["polylogue-bare"], "a2", ids)).toBe(systemPrompt(CONDITIONS.polylogue, "a2", ids).replace(`\n\n${NORMS}`, ""));
  });

  it("builds tools in the documented order", () => {
    const { ctx } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, [readShardTool(VAULT, 0)]);
    expect(tools.map((t) => t.name)).toEqual(toolNames(CONDITIONS.polylogue, ["read_shard"]));
  });
});

describe("communication tools", () => {
  it("send delivers, and refuses self, unknown, finished and empty messages", async () => {
    const { ctx, members, logged } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    expect(await call(tools, "send", { to: "a2", text: "digit 1 is 4" })).toBe("Sent to a2.");
    expect(members[1]!.got[0]).toMatchObject({ from: "a1", to: "a2", text: "digit 1 is 4", urgent: false });
    await expect(call(tools, "send", { to: "a1", text: "me" })).rejects.toThrow(/cannot message yourself/);
    await expect(call(tools, "send", { to: "a9", text: "x" })).rejects.toThrow(/no agent a9.*a1, a2, a3, a4/);
    await expect(call(tools, "send", { to: "a2", text: "   " })).rejects.toThrow(/empty/);
    members[2]!.done = true;
    await expect(call(tools, "send", { to: "a3", text: "x" })).rejects.toThrow(/a3 has finished/);
    expect(logged.filter((e) => e.kind === "message")).toHaveLength(1);
  });

  it("publish reports how many live agents it reached; urgent is passed through", async () => {
    const { ctx, members } = world();
    members[3]!.done = true;
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    expect(await call(tools, "publish", { topic: "all", text: "stop", urgent: true })).toBe("Published to #all (2 agents).");
    expect(members[1]!.got[0]!.urgent).toBe(true);
  });

  it("rate limits surface as tool errors", async () => {
    const { ctx } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    for (let i = 0; i < 3; i++) await call(tools, "send", { to: "a2", text: `m${i}` });
    await expect(call(tools, "send", { to: "a2", text: "m3" })).rejects.toThrow(/at most 3 messages per minute/);
    await expect(call(tools, "publish", { topic: "all", text: "x".repeat(51) })).rejects.toThrow(/at most 50 characters/);
  });

  it("subscribe and roster", async () => {
    const { ctx, bus } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    expect(await call(tools, "subscribe", { topic: "math" })).toBe("Subscribed to #math.");
    expect(bus.post("a2", { topic: "math" }, "x", false).recipients).toEqual(["a1"]);
    expect(await call(tools, "roster", {})).toBe("a1 (you): working\na2: working — reading shard 3\na3: working\na4: working");
  });

  it("claim is blind and single", async () => {
    const { ctx, controller } = world();
    const tools = buildTools(CONDITIONS.polylogue, "a1", ctx, []);
    expect(await call(tools, "claim", { answer: "1111", evidence: "guess" })).toBe("Claim submitted.");
    await expect(call(tools, "claim", { answer: "4719", evidence: "x" })).rejects.toThrow(/already submitted/);
    const t2 = buildTools(CONDITIONS.polylogue, "a2", ctx, []);
    expect(await call(t2, "claim", { answer: "4719", evidence: "shards" })).toBe("Claim submitted.");
    expect(controller.ended).toBe("solved");
  });
});

describe("toy vault task", () => {
  it("reads shards and verifies the code", async () => {
    const shard = readShardTool(VAULT, 0);
    expect(await shard.run({ shard: 1 })).toBe(VAULT.shards[1]);
    await expect(shard.run({ shard: 99 })).rejects.toThrow(/Shards are numbered 1 to 8/);
    expect(VAULT.verify("4719")).toEqual({ passed: true });
    expect(VAULT.verify(" code: 4-7-1-9 ")).toEqual({ passed: true });
    expect(VAULT.verify("4791")).toEqual({ passed: false, detail: "expected 4719, got 4791" });
  });

  it("read_shard honours abort", async () => {
    const shard = readShardTool(VAULT, 5_000);
    const ac = new AbortController();
    const p = shard.run({ shard: 1 }, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/runtime/src/comm`
Expected: FAIL, cannot resolve `./bus.ts`.

- [ ] **Step 3: Implement**

`packages/runtime/src/run/context.ts`:
```ts
import type { EventInput } from "@polylogue/schema";
import type { Controller } from "../control/controller.ts";
import type { Bus } from "../comm/bus.ts";
import type { Blackboard } from "../comm/blackboard.ts";

export type AgentPhase = "new" | "working" | "idle" | "finished";

export interface AgentDirectory {
  ids(): string[];
  status(id: string): string;
  phase(id: string): AgentPhase;
}

export interface RunContext {
  log(e: EventInput): void;
  controller: Controller;
  bus: Bus;
  board: Blackboard;
  dir: AgentDirectory;
}
```

`packages/runtime/src/comm/bus.ts`:
```ts
import type { EventInput, InboxMessage } from "@polylogue/schema";

export interface BusMember {
  id: string;
  receive(msg: InboxMessage): void;
  isFinished(): boolean;
}

export class Bus {
  private members = new Map<string, BusMember>();
  private subs = new Map<string, Set<string>>();
  private count = 0;

  constructor(private readonly log: (e: EventInput) => void) {}

  add(m: BusMember): void {
    this.members.set(m.id, m);
    this.subscribe(m.id, "all");
  }

  has(id: string): boolean {
    return this.members.has(id);
  }

  isFinished(id: string): boolean {
    return this.members.get(id)?.isFinished() ?? true;
  }

  ids(): string[] {
    return [...this.members.keys()];
  }

  subscribe(agentId: string, topic: string): void {
    const set = this.subs.get(topic) ?? new Set<string>();
    set.add(agentId);
    this.subs.set(topic, set);
  }

  /** Logs the message, then hands it to every live recipient. Validation is the caller's job. */
  post(from: string, to: string | { topic: string }, text: string, urgent: boolean): { id: string; recipients: string[] } {
    const id = `m${this.count++}`;
    this.log({ kind: "message", id, from, to, text, urgent });
    const targets = typeof to === "string" ? [to] : [...(this.subs.get(to.topic) ?? [])].filter((a) => a !== from);
    const recipients = targets.filter((a) => this.members.has(a) && !this.members.get(a)!.isFinished());
    const msg: InboxMessage = { id, from, to, text, urgent };
    for (const a of recipients) this.members.get(a)!.receive(msg);
    return { id, recipients };
  }
}
```

`packages/runtime/src/comm/blackboard.ts`:
```ts
import type { EventInput } from "@polylogue/schema";

export class Blackboard {
  private entries: { agent: string; text: string }[] = [];

  constructor(private readonly log: (e: EventInput) => void) {}

  append(agent: string, text: string): void {
    this.entries.push({ agent, text });
    this.log({ kind: "blackboard", agent, text });
  }

  read(): string {
    if (this.entries.length === 0) return "(the blackboard is empty)";
    return this.entries.map((e) => `[${e.agent}] ${e.text}`).join("\n");
  }
}
```

`packages/runtime/src/conditions.ts`:
```ts
import type { ConditionName } from "@polylogue/schema";

export interface Condition {
  name: ConditionName;
  n: number;
  blackboard: boolean;
  messaging: boolean;
  norms: boolean;
}

export const CONDITIONS: Record<ConditionName, Condition> = {
  single: { name: "single", n: 1, blackboard: false, messaging: false, norms: false },
  isolated: { name: "isolated", n: 4, blackboard: false, messaging: false, norms: false },
  stigmergic: { name: "stigmergic", n: 4, blackboard: true, messaging: false, norms: false },
  polylogue: { name: "polylogue", n: 4, blackboard: true, messaging: true, norms: true },
  "polylogue-bare": { name: "polylogue-bare", n: 4, blackboard: true, messaging: true, norms: false },
};

/** Protocol norms from IDEA.md §5, adapted to this tool set (findings.md is the blackboard). */
export const NORMS = [
  "Team norms:",
  "1. Check roster and read_blackboard before you start work.",
  "2. Every claim you share comes with evidence: a quote, a tool result or a derivation.",
  "3. Ask instead of guessing. If nobody answers before you need it, state your assumption and continue.",
  '4. Share conclusions, not reasoning traces ("X ruled out because Y").',
].join("\n");

const CLAIM_RULE =
  "When you know the answer, call claim with the answer and your evidence. You can claim only once, claiming ends your work, and you will not be told whether the answer was correct.";

export function systemPrompt(c: Condition, agentId: string, ids: string[]): string {
  const others = ids.filter((id) => id !== agentId).join(", ");
  const parts = [`You are agent ${agentId}.`];
  if (c.name === "single") parts.push("You work alone on the task below.");
  else if (!c.blackboard && !c.messaging) parts.push(`${c.n} agents work on the task below independently. You cannot contact the others.`);
  else if (!c.messaging) parts.push(`You are one of ${c.n} agents working on the task below; the others are ${others}. You share a blackboard: read_blackboard shows every entry, append_blackboard adds one. There is no other way to reach the others.`);
  else parts.push(`You are one of ${c.n} agents working on the task below; the others are ${others}. send messages one agent, publish messages a topic (every agent hears #all; subscribe to hear other topics), roster shows the team and what each agent is doing, and the blackboard (read_blackboard, append_blackboard) keeps shared notes. Messages from others arrive between your steps. If you have nothing to do, end your turn without a tool call; a new message will wake you.`);
  if (!c.messaging) parts.push("Ending your turn without a tool call ends your work.");
  parts.push(CLAIM_RULE);
  const prompt = parts.join(" ");
  return c.norms ? `${prompt}\n\n${NORMS}` : prompt;
}

export function toolNames(c: Condition, workTools: string[]): string[] {
  return [
    ...workTools,
    "claim",
    ...(c.blackboard ? ["read_blackboard", "append_blackboard"] : []),
    ...(c.messaging ? ["send", "publish", "subscribe", "roster"] : []),
  ];
}
```

`packages/runtime/src/tools/work-tool.ts`:
```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export interface WorkTool {
  name: string;
  description: string;
  parameters: TSchema;
  // biome-ignore lint: arguments are validated by pi against `parameters`
  run(args: any, signal?: AbortSignal): Promise<string>;
}

export const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

export function toAgentTool(w: WorkTool): AgentTool<any> {
  return { name: w.name, label: w.name, description: w.description, parameters: w.parameters, execute: async (_id, args, signal) => text(await w.run(args, signal)) };
}
```

`packages/runtime/src/tools/claim-tool.ts`:
```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { RunContext } from "../run/context.ts";
import { text } from "./work-tool.ts";

export function claimTool(agentId: string, ctx: RunContext): AgentTool<any> {
  return {
    name: "claim",
    label: "claim",
    description: "Submit your final answer with your evidence. You can do this once; it ends your work. You will not be told whether it was correct.",
    parameters: Type.Object({ answer: Type.String(), evidence: Type.String() }),
    execute: async (_id, p: { answer: string; evidence: string }) => text(ctx.controller.claim(agentId, p.answer, p.evidence)),
  };
}
```

`packages/runtime/src/tools/blackboard-tools.ts`:
```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { RunContext } from "../run/context.ts";
import { text } from "./work-tool.ts";

export function blackboardTools(agentId: string, ctx: RunContext): AgentTool<any>[] {
  return [
    {
      name: "read_blackboard",
      label: "read_blackboard",
      description: "Read every entry on the shared blackboard.",
      parameters: Type.Object({}),
      execute: async () => text(ctx.board.read()),
    },
    {
      name: "append_blackboard",
      label: "append_blackboard",
      description: "Add one entry to the shared blackboard.",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, p: { text: string }) => {
        if (!p.text.trim()) throw new Error("The entry is empty.");
        ctx.board.append(agentId, p.text);
        return text("Appended.");
      },
    },
  ];
}
```

`packages/runtime/src/tools/comm-tools.ts`:
```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { RunContext } from "../run/context.ts";
import { text } from "./work-tool.ts";

function checkText(agentId: string, ctx: RunContext, body: string): void {
  if (!body.trim()) throw new Error("The message is empty.");
  const err = ctx.controller.checkMessage(agentId, body);
  if (err) throw new Error(err);
}

export function commTools(agentId: string, ctx: RunContext): AgentTool<any>[] {
  return [
    {
      name: "send",
      label: "send",
      description: "Send a message to one agent. It arrives between that agent's steps. Set urgent for messages that must come first.",
      parameters: Type.Object({ to: Type.String(), text: Type.String(), urgent: Type.Optional(Type.Boolean()) }),
      execute: async (_id, p: { to: string; text: string; urgent?: boolean }) => {
        if (p.to === agentId) throw new Error("You cannot message yourself.");
        if (!ctx.bus.has(p.to)) throw new Error(`There is no agent ${p.to}. Agents: ${ctx.dir.ids().join(", ")}.`);
        if (ctx.bus.isFinished(p.to)) throw new Error(`${p.to} has finished and cannot receive messages.`);
        checkText(agentId, ctx, p.text);
        ctx.bus.post(agentId, p.to, p.text, p.urgent ?? false);
        return text(`Sent to ${p.to}.`);
      },
    },
    {
      name: "publish",
      label: "publish",
      description: "Send a message to every agent subscribed to a topic. Every agent hears #all.",
      parameters: Type.Object({ topic: Type.String(), text: Type.String(), urgent: Type.Optional(Type.Boolean()) }),
      execute: async (_id, p: { topic: string; text: string; urgent?: boolean }) => {
        const topic = p.topic.replace(/^#/, "").trim();
        if (!topic) throw new Error("The topic is empty.");
        checkText(agentId, ctx, p.text);
        const { recipients } = ctx.bus.post(agentId, { topic }, p.text, p.urgent ?? false);
        return text(`Published to #${topic} (${recipients.length} agent${recipients.length === 1 ? "" : "s"}).`);
      },
    },
    {
      name: "subscribe",
      label: "subscribe",
      description: "Start hearing messages published to a topic.",
      parameters: Type.Object({ topic: Type.String() }),
      execute: async (_id, p: { topic: string }) => {
        const topic = p.topic.replace(/^#/, "").trim();
        if (!topic) throw new Error("The topic is empty.");
        ctx.bus.subscribe(agentId, topic);
        return text(`Subscribed to #${topic}.`);
      },
    },
    {
      name: "roster",
      label: "roster",
      description: "List the agents, whether each is working, idle or finished, and its latest status line.",
      parameters: Type.Object({}),
      execute: async () =>
        text(
          ctx.dir
            .ids()
            .map((id) => {
              const status = ctx.dir.status(id);
              return `${id}${id === agentId ? " (you)" : ""}: ${ctx.dir.phase(id)}${status ? ` — ${status}` : ""}`;
            })
            .join("\n"),
        ),
    },
  ];
}
```

`packages/runtime/src/tools/build-tools.ts`:
```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Condition } from "../conditions.ts";
import type { RunContext } from "../run/context.ts";
import { blackboardTools } from "./blackboard-tools.ts";
import { claimTool } from "./claim-tool.ts";
import { commTools } from "./comm-tools.ts";
import { toAgentTool, type WorkTool } from "./work-tool.ts";

export function buildTools(c: Condition, agentId: string, ctx: RunContext, work: WorkTool[]): AgentTool<any>[] {
  return [
    ...work.map(toAgentTool),
    claimTool(agentId, ctx),
    ...(c.blackboard ? blackboardTools(agentId, ctx) : []),
    ...(c.messaging ? commTools(agentId, ctx) : []),
  ];
}
```

`packages/runtime/src/toy/vault.ts`:
```ts
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/runtime/src/comm && npx tsc -p tsconfig.json`
Expected: 13 tests PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/run/context.ts packages/runtime/src/comm packages/runtime/src/conditions.ts packages/runtime/src/tools packages/runtime/src/toy
git commit -m "Bus, blackboard, conditions as data, tools and the toy vault task"
```

---

### Task 6: AgentLoop and context reconstruction

**Files:**
- Create: `packages/runtime/src/agent/estimate.ts`, `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/context.ts`
- Test: `packages/runtime/src/agent/agent-loop.test.ts`

**Interfaces:**
- Consumes: `ModelRuntime` (Task 3), `RunContext`, `AgentPhase`, `BusMember`, `buildTools`, `CONDITIONS`, `systemPrompt`, `VAULT`, `readShardTool` (Task 5), `Controller`, `ControlledAgent`, `Refusal` (Task 4), `formatBlock`, `orderBlock`, `InboxMessage`, `Event` (Task 1), fake server (Task 3).
- Produces:
  - `estimate.ts`: `messageText(m: AgentMessage): string`; `estimatePromptTokens(messages: AgentMessage[], lastCallTokens: number, maxTokens: number): number`
  - `agent-loop.ts`: `interface AgentLoopOptions { id: string; systemPrompt: string; tools: AgentTool<any>[]; runtime: ModelRuntime; seed: number; canBeWoken: boolean; ctx: RunContext; clock: Clock }`; `class AgentLoop implements BusMember, ControlledAgent { phase: AgentPhase; status: string; constructor(o: AgentLoopOptions); start(task: string): Promise<void>; receive(msg: InboxMessage): void; isFinished(): boolean; isIdleWithNothingPending(): boolean; stop(): Promise<void>; settled(): Promise<void>; finishOnRunEnd(): void }`
  - `context.ts`: `interface CtxMsg { role: "system" | "user" | "assistant" | "tool"; text: string; reasoning?: string; toolCalls?: { id: string; name: string; args: unknown }[]; toolCallId?: string }`; `contextBeforeCall(events: Event[], agent: string, call: number): CtxMsg[]`; `normalizeOpenAIMessages(messages: any[]): CtxMsg[]`

**How the loop works (implement exactly this):**

- One pi `Agent` per loop, options: `initialState { systemPrompt, model: runtime.model, thinkingLevel: "off", tools, messages: [] }`, `streamFn: runtime.streamFor(seed)`, `toolExecution: "sequential"`, `steeringMode: "all"`, `followUpMode: "all"`, plus four hooks:
  - `prepareRequest: ({ context }) => …` computes `estimatePromptTokens(context.messages, lastCallTokens, runtime.model.maxTokens)`, asks `ctx.controller.admitCall(estimate)`. On a refusal it stores it in `this.refused` and throws `new Error("call refused: " + refusal)` (pi then ends the run with an error message and sends no request; measured 2026-10-11). Otherwise it records `requestStartedAt = clock.now()`.
  - `beforeToolCall: async () => ctx.controller.ended ? { block: true, reason: "The run has ended." } : undefined`.
  - `finishTurn: async ({ toolResults }) => toolResults.some(r => r.toolName === "claim" && !r.isError) ? { action: "end" } : undefined`.
  - `prepareNextTurnWithContext: () => this.takeBlock()`: the delivery point for a working agent (called after the tool results, before the next request; measured 2026-10-11).
- `takeBlock()`: if `pending` is empty return `undefined`; else order with `orderBlock`, log one `message_delivered` per message (same `delivery` number), increment `deliveries`, and return `{ messages: [{ role: "user", content: formatBlock(msgs), timestamp: clock.now() }] }`.
- Events from pi (`agent.subscribe`):
  - `message_end` with `role === "assistant"`: if `this.refused` is set, log nothing (no request was sent). Else log `model_call` (`call` = running count, `content` = text blocks joined, `reasoning` = thinking blocks joined, `toolCalls` from toolCall blocks, `tokensIn`/`tokensOut` from usage, `ms = round(now - requestStartedAt)`, `stopReason`, `error` = `errorMessage` if set), `controller.charge(input + output)`, set `lastCallTokens = input + output`, and if the text has a first non-empty line, set `status` to it (≤ 140 chars) and log `status`. If `stopReason === "error"` and the controller has not ended, call `controller.infraError(errorMessage)`.
  - `tool_execution_start`: remember the start time, log `tool_call`.
  - `tool_execution_end`: log `tool_result` (`text` = text content joined, `isError`, `ms`); if `toolName === "claim"` and not an error, set `claimed = true`.
- `drive(step)` runs `step()` (a pi `prompt` or `continue`) and then, in a loop: if `phase === "finished"` stop; if `refused === "context"` → `finish("context")`; if `refused` is anything else, stop (the run end handles it); if `claimed` → `finish("claimed")`; if the controller has ended, stop; if the last assistant message stopped with `error` or `aborted`, stop; if `pending` is non-empty → `agent.followUp(block)` then `await agent.continue()` and loop; otherwise set `phase = "idle"`, log `idle`, `finish("idle")` when `!canBeWoken`, and `controller.checkAllIdle()`.
- `receive(msg)`: ignore when finished; push to `pending`; if `phase === "idle"`: set `phase = "working"`, log `wake`, and `drive(() => { agent.followUp(block); return agent.continue(); })`.
- `finish(reason)`: set `phase = "finished"`, log `agent_finished`, `controller.checkAllIdle()`.
- `stop()`: `agent.abort()` then `await settled()`. `settled()`: await the current drive promise, then `agent.waitForIdle()`. `finishOnRunEnd()`: if not finished, `phase = "finished"` and log `agent_finished` with `run_ended`.

**Estimate:** characters of every message after the last assistant message (all messages, plus the system prompt, when there is none yet), divided by 3 and rounded up, plus the last call's input+output tokens, plus `maxTokens`.

**Context reconstruction** (`contextBeforeCall(events, agent, call)`): walk the events in order; start with `system` = the agent's `agent_started.systemPrompt` and `user` = `run_started.task`; for that agent append `assistant` per `model_call` (text = `content`, `reasoning` when non-empty, `toolCalls` when non-empty), `tool` per `tool_result` (`toolCallId = callId`, text), and one `user` per group of consecutive `message_delivered` events with the same `delivery` number (text = `formatBlock` of those messages, looked up by id from the `message` events). Stop before the `call`-th `model_call` of that agent. `normalizeOpenAIMessages` maps a request body's `messages` to the same shape: content strings, or arrays of `{type:"text"}` parts joined with `""`; `null` content → `""`; `reasoning_content` → `reasoning` (omitted when empty); `tool_calls` → `{ id, name, args: JSON.parse(arguments) }`; `tool_call_id` → `toolCallId`. Drop `reasoning`/`toolCalls` keys when empty so both sides compare equal.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/src/agent/agent-loop.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import type { Event, EventInput } from "@polylogue/schema";
import { AgentLoop } from "./agent-loop.ts";
import { contextBeforeCall, normalizeOpenAIMessages } from "./context.ts";
import { estimatePromptTokens } from "./estimate.ts";
import { makeModelRuntime } from "../model/provider.ts";
import { startFakeOpenAI, testModelConfig, type FakeServer, type Policy } from "../testing/fake-openai.ts";
import { Controller } from "../control/controller.ts";
import { Bus } from "../comm/bus.ts";
import { Blackboard } from "../comm/blackboard.ts";
import { CONDITIONS, systemPrompt } from "../conditions.ts";
import { buildTools } from "../tools/build-tools.ts";
import { VAULT, readShardTool } from "../toy/vault.ts";
import { realClock } from "../clock.ts";
import type { RunContext } from "../run/context.ts";
import type { ConditionName } from "@polylogue/schema";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** Builds N loops wired like a run, without the run orchestrator (Task 7). */
async function team(policy: Policy, condition: ConditionName, opts: { toolDelayMs?: number; pool?: number; contextWindow?: number } = {}) {
  fake = await startFakeOpenAI(policy);
  const cond = CONDITIONS[condition];
  const events: Event[] = [];
  const t0 = Date.now();
  const log = (e: EventInput) => events.push({ ...e, t: Date.now() - t0 } as Event);
  const ids = Array.from({ length: cond.n }, (_, i) => `a${i + 1}`);
  const runtime = makeModelRuntime(testModelConfig(fake.baseUrl, { contextWindow: opts.contextWindow ?? 262144, maxTokens: 100 }));
  const controller = new Controller({ pool: opts.pool ?? 1e9, wallClockMs: 60_000, messagesPerMinute: 30, maxMessageChars: 2000, contextWindow: opts.contextWindow ?? 262144 }, { log, clock: realClock, verify: VAULT.verify });
  const bus = new Bus(log);
  const board = new Blackboard(log);
  const loops: AgentLoop[] = [];
  const ctx: RunContext = {
    log, controller, bus, board,
    dir: { ids: () => ids, status: (id) => loops.find((l) => l.id === id)!.status, phase: (id) => loops.find((l) => l.id === id)!.phase },
  };
  log({ kind: "run_started", condition, n: cond.n, taskId: VAULT.id, task: VAULT.prompt, pool: opts.pool ?? 1e9, wallClockMs: 60_000 });
  ids.forEach((id, i) => {
    const prompt = systemPrompt(cond, id, ids);
    const tools = buildTools(cond, id, ctx, [readShardTool(VAULT, opts.toolDelayMs ?? 0)]);
    log({ kind: "agent_started", agent: id, index: i, seed: 700 + i, systemPrompt: prompt, tools: tools.map((t) => t.name) });
    const loop = new AgentLoop({ id, systemPrompt: prompt, tools, runtime, seed: 700 + i, canBeWoken: cond.messaging, ctx, clock: realClock });
    loops.push(loop);
    bus.add(loop);
    controller.register(loop);
  });
  return { events, loops, controller, fake: fake! };
}

const kinds = (events: Event[], agent?: string) => events.filter((e) => !agent || ("agent" in e && e.agent === agent)).map((e) => e.kind);

describe("estimatePromptTokens", () => {
  it("counts characters after the last assistant message, plus the last call and the answer budget", () => {
    const msgs = [
      { role: "user", content: "x".repeat(30), timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 0, output: 0 }, stopReason: "stop", timestamp: 0 },
      { role: "user", content: "y".repeat(9), timestamp: 0 },
    ] as never;
    expect(estimatePromptTokens(msgs, 500, 100)).toBe(500 + 3 + 100);
  });
});

describe("AgentLoop", () => {
  it("delivers a message that arrives during a slow tool after the tool result, urgent first, as one block", async () => {
    const { events, loops, fake } = await team(({ agentIndex, call }) => {
      if (agentIndex === 0) return call === 0 ? { toolCalls: [{ name: "read_shard", args: { shard: 1 } }] } : { content: "thanks" };
      if (call === 0) return { toolCalls: [{ name: "send", args: { to: "a1", text: "digit 3 is 1" } }, { name: "publish", args: { topic: "all", text: "urgent: digit 2 is 7", urgent: true } }] };
      return { content: "done" };
    }, "polylogue", { toolDelayMs: 300 });
    const a1 = loops[0]!.start(VAULT.prompt);
    await new Promise((r) => setTimeout(r, 50));
    await loops[1]!.start(VAULT.prompt);
    await a1;
    const a1Requests = fake.requests.filter((r) => r.agentIndex === 0);
    const second = normalizeOpenAIMessages(a1Requests[1]!.body.messages);
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(second.at(-1)!.text).toBe("[URGENT from a2 on #all] urgent: digit 2 is 7\n[from a2] digit 3 is 1");
    const a1Kinds = kinds(events, "a1");
    expect(a1Kinds.indexOf("message_delivered")).toBeGreaterThan(a1Kinds.indexOf("tool_result"));
    expect(events.filter((e) => e.kind === "message_delivered" && e.agent === "a1").map((e) => (e as { delivery: number }).delivery)).toEqual([0, 0]);
  });

  it("wakes an idle agent on a direct message and on a subscribed topic, not on other topics", async () => {
    const { events, loops } = await team(({ agentIndex, call }) => {
      if (agentIndex === 0) return call === 0 ? { toolCalls: [{ name: "subscribe", args: { topic: "math" } }] } : { content: "waiting" };
      return { content: "idle" };
    }, "polylogue");
    await loops[0]!.start(VAULT.prompt);
    expect(loops[0]!.phase).toBe("idle");
    const bus = (loops[0] as unknown as { o: { ctx: RunContext } }).o.ctx.bus;
    bus.post("a2", { topic: "frontend" }, "not for you", false);
    expect(loops[0]!.phase).toBe("idle");
    bus.post("a2", { topic: "math" }, "for you", false);
    expect(loops[0]!.phase).toBe("working");
    await loops[0]!.settled();
    bus.post("a3", "a1", "direct", false);
    await loops[0]!.settled();
    expect(events.filter((e) => e.kind === "wake" && e.agent === "a1")).toHaveLength(2);
  });

  it("an idle agent is finished where nothing can wake it", async () => {
    const { events, loops } = await team(() => ({ content: "I give up" }), "isolated");
    await loops[0]!.start(VAULT.prompt);
    expect(loops[0]!.phase).toBe("finished");
    expect(events.filter((e) => e.kind === "agent_finished")).toEqual([expect.objectContaining({ agent: "a1", reason: "idle" })]);
  });

  it("ends the agent after a claim, blind to the result", async () => {
    const { events, loops, fake } = await team(({ call }) => (call === 0 ? { toolCalls: [{ name: "claim", args: { answer: "1111", evidence: "guess" } }] } : { content: "should not happen" }), "single");
    await loops[0]!.start(VAULT.prompt);
    expect(fake.requests).toHaveLength(1);
    expect(events.find((e) => e.kind === "tool_result")).toMatchObject({ tool: "claim", isError: false, text: "Claim submitted." });
    expect(events.find((e) => e.kind === "agent_finished")).toMatchObject({ reason: "claimed" });
  });

  it("logs an unknown tool as an error result and keeps going", async () => {
    const { events, loops, fake } = await team(({ call }) => (call === 0 ? { toolCalls: [{ name: "teleport", args: { where: "vault" } }] } : { content: "ok" }), "single");
    await loops[0]!.start(VAULT.prompt);
    expect(fake.requests).toHaveLength(2);
    const last = normalizeOpenAIMessages(fake.requests[1]!.body.messages).at(-1)!;
    expect(last.role).toBe("tool");
    expect(last.toolCallId).toBe("call_0_0_0");
    const err = events.find((e) => e.kind === "tool_result");
    if (err) expect(err).toMatchObject({ tool: "teleport", isError: true });
  });

  it("refuses a call over the context window, sends no request and finishes with context", async () => {
    const { events, loops, fake } = await team(() => ({ content: "x" }), "single", { contextWindow: 50 });
    await loops[0]!.start(VAULT.prompt);
    expect(fake.requests).toHaveLength(0);
    expect(events.filter((e) => e.kind === "model_call")).toHaveLength(0);
    expect(events.find((e) => e.kind === "agent_finished")).toMatchObject({ reason: "context" });
  });

  it("rebuilds every request's context from the log", async () => {
    const { events, loops, fake } = await team(({ agentIndex, call }) => {
      if (agentIndex === 1 && call === 0) return { reasoning: "tell a1", toolCalls: [{ name: "send", args: { to: "a1", text: "shard 5 has digit 2" } }] };
      if (agentIndex === 0 && call < 2) return { reasoning: `step ${call}`, content: `reading ${call + 1}`, toolCalls: [{ name: "read_shard", args: { shard: call + 1 } }] };
      return { content: "done" };
    }, "polylogue", { toolDelayMs: 100 });
    await Promise.all([loops[0]!.start(VAULT.prompt), loops[1]!.start(VAULT.prompt)]);
    for (const agentIndex of [0, 1]) {
      const reqs = fake.requests.filter((r) => r.agentIndex === agentIndex);
      reqs.forEach((r, call) => expect(contextBeforeCall(events, `a${agentIndex + 1}`, call)).toEqual(normalizeOpenAIMessages(r.body.messages)));
    }
  });

  it("all agents idle with nothing pending ends the run all_idle", async () => {
    const { loops, controller } = await team(() => ({ content: "nothing to do" }), "polylogue");
    await Promise.all(loops.map((l) => l.start(VAULT.prompt)));
    expect(await controller.done).toBe("all_idle");
  });
});
```

The unknown-tool test checks the request path for sure, and the logged `tool_result` only if pi emits tool execution events for unknown tools; if it does not, add a `tool_result` from the `message_end` of the `toolResult` message instead, so Review Focus item 2 holds (`isError: true` logged), and make the `if (err)` unconditional.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/runtime/src/agent`
Expected: FAIL, cannot resolve `./agent-loop.ts`.

- [ ] **Step 3: Implement `estimate.ts`**

```ts
import type { AgentMessage } from "@earendil-works/pi-agent-core";

type Block = { type: string; text?: string; thinking?: string };

export function messageText(m: AgentMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((b) => (b.type === "text" ? (b.text ?? "") : b.type === "thinking" ? (b.thinking ?? "") : "")).join("");
}

export function estimatePromptTokens(messages: AgentMessage[], lastCallTokens: number, maxTokens: number): number {
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if ((m as { role?: string }).role === "assistant") lastAssistant = i;
  });
  const tail = messages.slice(lastAssistant + 1);
  const chars = tail.reduce((n, m) => n + messageText(m).length, 0);
  return lastCallTokens + Math.ceil(chars / 3) + maxTokens;
}
```

The system prompt is a system message inside `context.messages` in pi 1.1.0 (AgentOptions: "systemPrompt and tools become the leading system message"), so the first call counts it automatically.

- [ ] **Step 4: Implement `agent-loop.ts`**

```ts
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { formatBlock, orderBlock, type InboxMessage } from "@polylogue/schema";
import type { Clock } from "../clock.ts";
import type { BusMember } from "../comm/bus.ts";
import type { ControlledAgent, Refusal } from "../control/controller.ts";
import type { ModelRuntime } from "../model/provider.ts";
import type { AgentPhase, RunContext } from "../run/context.ts";
import { estimatePromptTokens } from "./estimate.ts";

export interface AgentLoopOptions {
  id: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  runtime: ModelRuntime;
  seed: number;
  canBeWoken: boolean;
  ctx: RunContext;
  clock: Clock;
}

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
interface Assistant {
  role: "assistant";
  content: Block[];
  usage: { input: number; output: number };
  stopReason: string;
  errorMessage?: string;
}

export class AgentLoop implements BusMember, ControlledAgent {
  readonly id: string;
  phase: AgentPhase = "new";
  status = "";
  private readonly agent: Agent;
  private pending: InboxMessage[] = [];
  private deliveries = 0;
  private calls = 0;
  private lastCallTokens = 0;
  private requestStartedAt = 0;
  private refused: Refusal | null = null;
  private claimed = false;
  private lastStop = "";
  private toolStarted = new Map<string, number>();
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly o: AgentLoopOptions) {
    this.id = o.id;
    this.agent = new Agent({
      initialState: { systemPrompt: o.systemPrompt, model: o.runtime.model, thinkingLevel: "off", tools: o.tools, messages: [] },
      streamFn: o.runtime.streamFor(o.seed),
      toolExecution: "sequential",
      steeringMode: "all",
      followUpMode: "all",
      prepareRequest: ({ context }) => {
        const estimate = estimatePromptTokens(context.messages, this.lastCallTokens, o.runtime.model.maxTokens);
        const refusal = o.ctx.controller.admitCall(estimate);
        if (refusal) {
          this.refused = refusal;
          throw new Error(`call refused: ${refusal}`);
        }
        this.requestStartedAt = o.clock.now();
      },
      beforeToolCall: async () => (o.ctx.controller.ended ? { block: true, reason: "The run has ended." } : undefined),
      finishTurn: async ({ toolResults }) =>
        toolResults.some((r) => (r as { toolName?: string; isError?: boolean }).toolName === "claim" && !(r as { isError?: boolean }).isError)
          ? { action: "end" }
          : undefined,
      prepareNextTurnWithContext: () => this.takeBlock(),
    });
    this.agent.subscribe((e) => this.onEvent(e));
  }

  start(task: string): Promise<void> {
    this.phase = "working";
    return this.drive(() => this.agent.prompt(task));
  }

  receive(msg: InboxMessage): void {
    if (this.phase === "finished") return;
    this.pending.push(msg);
    if (this.phase !== "idle") return;
    this.phase = "working";
    this.o.ctx.log({ kind: "wake", agent: this.id, reason: "message" });
    void this.drive(() => this.continueWithBlock());
  }

  isFinished(): boolean {
    return this.phase === "finished";
  }

  isIdleWithNothingPending(): boolean {
    return this.phase === "idle" && this.pending.length === 0;
  }

  async stop(): Promise<void> {
    this.agent.abort();
    await this.settled();
  }

  async settled(): Promise<void> {
    await this.running;
    await this.agent.waitForIdle();
  }

  finishOnRunEnd(): void {
    if (this.phase === "finished") return;
    this.phase = "finished";
    this.o.ctx.log({ kind: "agent_finished", agent: this.id, reason: "run_ended" });
  }

  private drive(step: () => Promise<void>): Promise<void> {
    this.running = (async () => {
      await step();
      for (;;) {
        if (this.phase === "finished") return;
        if (this.refused === "context") return this.finish("context");
        if (this.refused) return;
        if (this.claimed) return this.finish("claimed");
        if (this.o.ctx.controller.ended) return;
        if (this.lastStop === "error" || this.lastStop === "aborted") return;
        if (this.pending.length > 0) {
          await this.continueWithBlock();
          continue;
        }
        this.phase = "idle";
        this.o.ctx.log({ kind: "idle", agent: this.id });
        if (!this.o.canBeWoken) return this.finish("idle");
        this.o.ctx.controller.checkAllIdle();
        return;
      }
    })();
    return this.running;
  }

  private async continueWithBlock(): Promise<void> {
    const block = this.takeBlock();
    if (!block) return;
    this.agent.followUp(block.messages[0]!);
    await this.agent.continue();
  }

  private takeBlock(): { messages: AgentMessage[] } | undefined {
    if (this.pending.length === 0) return undefined;
    const msgs = orderBlock(this.pending.splice(0));
    const delivery = this.deliveries++;
    for (const m of msgs) this.o.ctx.log({ kind: "message_delivered", agent: this.id, messageId: m.id, delivery });
    return { messages: [{ role: "user", content: formatBlock(msgs), timestamp: this.o.clock.now() } as AgentMessage] };
  }

  private finish(reason: "claimed" | "idle" | "context"): void {
    this.phase = "finished";
    this.o.ctx.log({ kind: "agent_finished", agent: this.id, reason });
    this.o.ctx.controller.checkAllIdle();
  }

  private onEvent(e: AgentEvent): void {
    const { ctx, clock } = this.o;
    if (e.type === "message_end" && (e.message as { role?: string }).role === "assistant") {
      const m = e.message as unknown as Assistant;
      this.lastStop = m.stopReason;
      if (this.refused) return;
      const content = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const reasoning = m.content.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("");
      const toolCalls = m.content.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id ?? "", name: b.name ?? "", args: b.arguments ?? {} }));
      const tokens = m.usage.input + m.usage.output;
      ctx.log({
        kind: "model_call", agent: this.id, call: this.calls++, content, reasoning, toolCalls,
        tokensIn: m.usage.input, tokensOut: m.usage.output, ms: Math.max(0, Math.round(clock.now() - this.requestStartedAt)),
        stopReason: m.stopReason, ...(m.errorMessage ? { error: m.errorMessage } : {}),
      });
      ctx.controller.charge(tokens);
      this.lastCallTokens = tokens;
      const line = content.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
      if (line) {
        this.status = line.slice(0, 140);
        ctx.log({ kind: "status", agent: this.id, text: this.status });
      }
      if (m.stopReason === "error" && !ctx.controller.ended) ctx.controller.infraError(m.errorMessage ?? "model error");
      return;
    }
    if (e.type === "tool_execution_start") {
      this.toolStarted.set(e.toolCallId, clock.now());
      ctx.log({ kind: "tool_call", agent: this.id, callId: e.toolCallId, tool: e.toolName, args: e.args ?? {} });
      return;
    }
    if (e.type === "tool_execution_end") {
      const started = this.toolStarted.get(e.toolCallId) ?? clock.now();
      const result = e.result as { content?: Block[] } | undefined;
      const text = (result?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      ctx.log({ kind: "tool_result", agent: this.id, callId: e.toolCallId, tool: e.toolName, isError: e.isError, text, ms: Math.max(0, Math.round(clock.now() - started)) });
      if (e.toolName === "claim" && !e.isError) this.claimed = true;
    }
  }
}
```

- [ ] **Step 5: Implement `context.ts`**

```ts
import { formatBlock, type Event, type InboxMessage, type Of } from "@polylogue/schema";

export interface CtxMsg {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
}

function assistant(text: string, reasoning: string, toolCalls: { id: string; name: string; args: unknown }[]): CtxMsg {
  const m: CtxMsg = { role: "assistant", text };
  if (reasoning) m.reasoning = reasoning;
  if (toolCalls.length) m.toolCalls = toolCalls;
  return m;
}

export function contextBeforeCall(events: Event[], agent: string, call: number): CtxMsg[] {
  const run = events.find((e): e is Of<"run_started"> => e.kind === "run_started");
  const start = events.find((e): e is Of<"agent_started"> => e.kind === "agent_started" && e.agent === agent);
  if (!run || !start) throw new Error(`no run_started/agent_started for ${agent}`);
  const messages = new Map<string, InboxMessage>();
  const out: CtxMsg[] = [{ role: "system", text: start.systemPrompt }, { role: "user", text: run.task }];
  let group: { delivery: number; msgs: InboxMessage[] } | null = null;
  const flush = () => {
    if (group) out.push({ role: "user", text: formatBlock(group.msgs) });
    group = null;
  };
  for (const e of events) {
    if (e.kind === "message") messages.set(e.id, { id: e.id, from: e.from, to: e.to, text: e.text, urgent: e.urgent });
    if (!("agent" in e) || e.agent !== agent) continue;
    if (e.kind === "message_delivered") {
      if (group && group.delivery !== e.delivery) flush();
      group ??= { delivery: e.delivery, msgs: [] };
      group.msgs.push(messages.get(e.messageId)!);
      continue;
    }
    if (e.kind === "model_call") {
      flush();
      if (e.call === call) return out;
      out.push(assistant(e.content, e.reasoning, e.toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.args }))));
    } else if (e.kind === "tool_result") {
      flush();
      out.push({ role: "tool", text: e.text, toolCallId: e.callId });
    }
  }
  flush();
  return out;
}

type Part = { type?: string; text?: string };
// biome-ignore lint: request bodies are arbitrary JSON
export function normalizeOpenAIMessages(messages: any[]): CtxMsg[] {
  return messages.map((m) => {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as Part[]).map((p) => p.text ?? "").join("") : "";
    if (m.role === "assistant") {
      const calls = (m.tool_calls ?? []).map((tc: { id: string; function: { name: string; arguments: string } }) => ({ id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") }));
      return assistant(text, m.reasoning_content ?? "", calls);
    }
    if (m.role === "tool") return { role: "tool", text, toolCallId: m.tool_call_id };
    return { role: m.role, text };
  });
}
```

If the rebuild test shows a systematic difference in how pi encodes a message (for example an assistant message with no text sent as `content: null` vs `""`, or tool result text wrapped differently), fix it in `normalizeOpenAIMessages` only when it is pure encoding; a difference in *content* (a message missing, out of order, or with other text) is a bug in the loop and must be fixed there.

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/runtime/src/agent && npx tsc -p tsconfig.json`
Expected: 9 tests PASS, tsc silent.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/agent
git commit -m "AgentLoop on pi: turn-boundary delivery, wake, claims, context guard; context rebuilt from the log"
```

---

### Task 7: Run orchestrator, config and `polylogue run`

**Files:**
- Create: `packages/runtime/src/config.ts`, `packages/runtime/src/run/run.ts`, `packages/runtime/src/cli.ts`, `configs/smoke-zgx.json`
- Test: `packages/runtime/src/run/run.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces:
  - `config.ts`: `RunConfig` (zod schema and type), `parseConfig(raw: unknown): RunConfig`, `stableJson(v: unknown): string`, `configHash(cfg: RunConfig): string` (`"sha256:" + hex`)
  - `run.ts`: `interface RunSummary { runId: string; reason: RunEndReason; solved: boolean; totalTokens: number; wallMs: number }`; `interface RunDeps { log: EventLog; clock?: Clock; gitSha?: string | null; tasks?: Record<string, ToyTask> }`; `runOnce(cfg: RunConfig, deps: RunDeps): Promise<RunSummary>`
  - `cli.ts`: `polylogue run <config.json> [--db runs.sqlite]` prints the summary as JSON.

**Run end policy:** `solved`, `killed` and `infra_error` stop every agent (`loop.stop()`, which aborts in-flight calls; those are logged with `stopReason: "aborted"`). `budget` and `all_idle` let in-flight calls finish, be charged and logged (`loop.settled()`); after the end every new call is refused and every tool call is blocked. Then `finishOnRunEnd()` on every loop, then `run_finished` (totals from `controller.used`), then `finishRun` on the row (`solved` → `solved`, `infra_error` → `infra_error`, else `unsolved`).

- [ ] **Step 1: Write the failing tests**

`packages/runtime/src/run/run.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConditionName, Event } from "@polylogue/schema";
import { runOnce } from "./run.ts";
import { parseConfig, configHash, type RunConfig } from "../config.ts";
import { EventLog } from "../log/event-log.ts";
import { CONDITIONS, NORMS } from "../conditions.ts";
import { startFakeOpenAI, type FakeServer, type Policy } from "../testing/fake-openai.ts";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const dbPath = () => join(mkdtempSync(join(tmpdir(), "polylogue-run-")), "runs.sqlite");

function config(baseUrl: string, condition: ConditionName, over: Partial<RunConfig> = {}): RunConfig {
  return parseConfig({
    condition, taskId: "toy-vault", seed: 7,
    budget: { tokensPerAgent: 100_000 }, wallClockMs: 20_000,
    rate: { messagesPerMinute: 30, maxMessageChars: 2000 }, toolDelayMs: 0, checkServer: true,
    model: { baseUrl, id: "qwen3.8-27b", hfRepo: "unsloth/Qwen3.8-27B-NVFP4", revision: "7d6f8d4d72f56b92b3cdbf22f156b90e1bab0108", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 30_000, maxRetries: 1 },
    ...over,
  });
}

/** Agent 1 reads two shards and claims the right code; the others read one shard each and idle. */
const solver: Policy = ({ agentIndex, call }) => {
  if (agentIndex === 0) {
    if (call === 0) return { toolCalls: [{ name: "read_shard", args: { shard: 1 } }] };
    if (call === 1) return { toolCalls: [{ name: "read_shard", args: { shard: 3 } }] };
    return { toolCalls: [{ name: "claim", args: { answer: "4719", evidence: "shards 1, 3, 5, 7" } }] };
  }
  return call === 0 ? { toolCalls: [{ name: "read_shard", args: { shard: agentIndex + 4 } }] } : { content: "nothing more" };
};

function invariants(events: Event[]): void {
  const end = events.findIndex((e) => e.kind === "run_finished");
  expect(end).toBe(events.length - 1);
  const pass = events.findIndex((e) => e.kind === "verification" && e.passed);
  if (pass >= 0) expect(events.slice(pass + 1).some((e) => e.kind === "claim_submitted")).toBe(false);
  for (const id of new Set(events.flatMap((e) => (e.kind === "agent_started" ? [e.agent] : [])))) {
    expect(events.filter((e) => e.kind === "agent_finished" && e.agent === id)).toHaveLength(1);
  }
}

describe("runOnce", () => {
  for (const condition of Object.keys(CONDITIONS) as ConditionName[]) {
    it(`runs ${condition} end to end with its tool set and prompt`, async () => {
      fake = await startFakeOpenAI(solver);
      const log = new EventLog(dbPath());
      const summary = await runOnce(config(fake.baseUrl, condition), { log, gitSha: "abc123" });
      expect(summary).toMatchObject({ reason: "solved", solved: true });
      const events = log.events(summary.runId).map((s) => s.event);
      invariants(events);
      const starts = events.filter((e) => e.kind === "agent_started");
      expect(starts).toHaveLength(CONDITIONS[condition].n);
      expect(starts[0]!.kind === "agent_started" && starts[0]!.systemPrompt.includes(NORMS)).toBe(condition === "polylogue");
      const toolsSent = fake.requests[0]!.body.tools.map((t: { function: { name: string } }) => t.function.name);
      expect(toolsSent).toEqual(starts[0]!.kind === "agent_started" ? starts[0]!.tools : []);
      for (const r of fake.requests) {
        expect(r.body.temperature).toBe(0);
        expect(r.body.seed).toBe(700 + r.agentIndex);
        expect(r.body.chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
      }
      const row = log.run(summary.runId)!;
      expect(row).toMatchObject({ status: "solved", endReason: "solved", condition, n: CONDITIONS[condition].n, gitSha: "abc123", configHash: configHash(config(fake.baseUrl, condition)) });
    });
  }

  it("a wrong claim is blind and the run goes on; all_idle when nobody is left", async () => {
    fake = await startFakeOpenAI(({ call }) => (call === 0 ? { toolCalls: [{ name: "claim", args: { answer: "1111", evidence: "guess" } }] } : { content: "?" }));
    const log = new EventLog(dbPath());
    const s = await runOnce(config(fake.baseUrl, "isolated"), { log });
    expect(s.reason).toBe("all_idle");
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    expect(events.filter((e) => e.kind === "verification").every((e) => e.kind === "verification" && !e.passed)).toBe(true);
    expect(new Set(events.filter((e) => e.kind === "tool_result" && e.tool === "claim").map((e) => (e as { text: string }).text))).toEqual(new Set(["Claim submitted."]));
    expect(log.run(s.runId)!.status).toBe("unsolved");
  });

  it("a second claim in the same turn is rejected", async () => {
    fake = await startFakeOpenAI(({ call }) => (call === 0 ? { toolCalls: [{ name: "claim", args: { answer: "1", evidence: "a" } }, { name: "claim", args: { answer: "2", evidence: "b" } }] } : { content: "?" }));
    const log = new EventLog(dbPath());
    const s = await runOnce(config(fake.baseUrl, "single"), { log });
    const results = log.events(s.runId).map((x) => x.event).filter((e) => e.kind === "tool_result");
    expect(results.map((e) => e.kind === "tool_result" && e.isError)).toEqual([false, true]);
    expect(log.events(s.runId).filter((x) => x.event.kind === "claim_submitted")).toHaveLength(1);
  });

  it("ends with budget when the pool is spent, charging calls already in flight", async () => {
    fake = await startFakeOpenAI(({ agentIndex }) => ({ toolCalls: [{ name: "read_shard", args: { shard: 2 } }], usage: { in: 400, out: 100 }, delayMs: agentIndex * 30 }));
    const log = new EventLog(dbPath());
    const s = await runOnce(config(fake.baseUrl, "isolated", { budget: { tokensPerAgent: 600 } }), { log });
    expect(s.reason).toBe("budget");
    const events = log.events(s.runId).map((x) => x.event);
    invariants(events);
    const charged = events.reduce((n, e) => n + (e.kind === "model_call" ? e.tokensIn + e.tokensOut : 0), 0);
    expect(s.totalTokens).toBe(charged);
    expect(charged).toBeGreaterThanOrEqual(2400);
    expect(fake.requests.length).toBe(events.filter((e) => e.kind === "model_call").length);
  });

  it("ends with killed at the wall-clock limit and aborts in-flight calls", async () => {
    fake = await startFakeOpenAI(() => ({ content: "slow", delayMs: 3_000 }));
    const log = new EventLog(dbPath());
    const t = Date.now();
    const s = await runOnce(config(fake.baseUrl, "polylogue", { wallClockMs: 300 }), { log });
    expect(s.reason).toBe("killed");
    expect(Date.now() - t).toBeLessThan(2_500);
    invariants(log.events(s.runId).map((x) => x.event));
  });

  it("ends with infra_error after retries are exhausted", async () => {
    fake = await startFakeOpenAI(({ agentIndex }) => (agentIndex === 0 ? { status: 500 } : { content: "fine", delayMs: 2_000 }));
    const log = new EventLog(dbPath());
    const s = await runOnce(config(fake.baseUrl, "isolated"), { log });
    expect(s.reason).toBe("infra_error");
    expect(fake.requests.filter((r) => r.agentIndex === 0)).toHaveLength(2);
    expect(log.run(s.runId)!.status).toBe("infra_error");
    invariants(log.events(s.runId).map((x) => x.event));
  });

  it("refuses to start when the server does not serve the pinned model", async () => {
    fake = await startFakeOpenAI(() => ({}), { modelId: "something-else" });
    const log = new EventLog(dbPath());
    await expect(runOnce(config(fake.baseUrl, "single"), { log })).rejects.toThrow(/does not serve "qwen3.8-27b"/);
    expect(log.runs()).toEqual([]);
  });
});

describe("config", () => {
  it("hashes independently of key order and rejects unknown conditions", () => {
    const a = config("http://x/v1", "single");
    const b = parseConfig(JSON.parse(JSON.stringify({ ...a, model: { ...a.model }, seed: a.seed })));
    expect(configHash(a)).toBe(configHash(b));
    expect(configHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => parseConfig({ ...a, condition: "chaos" })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/runtime/src/run`
Expected: FAIL, cannot resolve `./run.ts`.

- [ ] **Step 3: Implement `config.ts`**

```ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { ConditionName } from "@polylogue/schema";

export const RunConfig = z.object({
  runId: z.string().optional(),
  condition: ConditionName,
  taskId: z.string(),
  seed: z.number().int().nonnegative(),
  budget: z.object({ tokensPerAgent: z.number().int().positive() }),
  wallClockMs: z.number().int().positive(),
  rate: z.object({ messagesPerMinute: z.number().int().positive(), maxMessageChars: z.number().int().positive() }),
  toolDelayMs: z.number().int().nonnegative().default(0),
  checkServer: z.boolean().default(true),
  model: z.object({
    baseUrl: z.string().url(),
    id: z.string(),
    hfRepo: z.string(),
    revision: z.string(),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
  }),
});
export type RunConfig = z.infer<typeof RunConfig>;

export function parseConfig(raw: unknown): RunConfig {
  return RunConfig.parse(raw);
}

export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Hash of everything that defines the run except its id. */
export function configHash(cfg: RunConfig): string {
  const { runId: _ignored, ...rest } = cfg;
  return `sha256:${createHash("sha256").update(stableJson(rest)).digest("hex")}`;
}
```

- [ ] **Step 4: Implement `run.ts`**

```ts
import type { Event, EventInput, RunEndReason } from "@polylogue/schema";
import { AgentLoop } from "../agent/agent-loop.ts";
import { realClock, type Clock } from "../clock.ts";
import { Blackboard } from "../comm/blackboard.ts";
import { Bus } from "../comm/bus.ts";
import { CONDITIONS, systemPrompt } from "../conditions.ts";
import { configHash, type RunConfig } from "../config.ts";
import { Controller } from "../control/controller.ts";
import type { EventLog } from "../log/event-log.ts";
import { checkServer, makeModelRuntime, samplingRecord } from "../model/provider.ts";
import { buildTools } from "../tools/build-tools.ts";
import { TASKS, readShardTool, type ToyTask } from "../toy/vault.ts";
import type { RunContext } from "./context.ts";

export interface RunSummary {
  runId: string;
  reason: RunEndReason;
  solved: boolean;
  totalTokens: number;
  wallMs: number;
}

export interface RunDeps {
  log: EventLog;
  clock?: Clock;
  gitSha?: string | null;
  tasks?: Record<string, ToyTask>;
}

const HARD_STOP: ReadonlySet<RunEndReason> = new Set(["solved", "killed", "infra_error"]);

export async function runOnce(cfg: RunConfig, deps: RunDeps): Promise<RunSummary> {
  const clock = deps.clock ?? realClock;
  const cond = CONDITIONS[cfg.condition];
  const task = (deps.tasks ?? TASKS)[cfg.taskId];
  if (!task) throw new Error(`unknown task "${cfg.taskId}"`);
  if (cfg.checkServer) await checkServer(cfg.model);

  const runId = cfg.runId ?? `${cfg.condition}-${cfg.taskId}-s${cfg.seed}-${Date.now().toString(36)}`;
  const pool = cfg.budget.tokensPerAgent * cond.n;
  deps.log.createRun({
    id: runId, condition: cfg.condition, n: cond.n, taskId: cfg.taskId, seed: cfg.seed, model: cfg.model.id,
    revision: cfg.model.revision, sampling: samplingRecord(cfg.model), configHash: configHash(cfg),
    gitSha: deps.gitSha ?? null, startedAt: new Date().toISOString(),
  });
  const t0 = clock.now();
  const log = (e: EventInput) => {
    deps.log.append(runId, { ...e, t: Math.max(0, Math.round(clock.now() - t0)) } as Event);
  };

  const ids = Array.from({ length: cond.n }, (_, i) => `a${i + 1}`);
  const controller = new Controller(
    { pool, wallClockMs: cfg.wallClockMs, messagesPerMinute: cfg.rate.messagesPerMinute, maxMessageChars: cfg.rate.maxMessageChars, contextWindow: cfg.model.contextWindow },
    { log, clock, verify: (a) => task.verify(a) },
  );
  const bus = new Bus(log);
  const board = new Blackboard(log);
  const loops: AgentLoop[] = [];
  const byId = (id: string) => loops.find((l) => l.id === id)!;
  const ctx: RunContext = { log, controller, bus, board, dir: { ids: () => ids, status: (id) => byId(id).status, phase: (id) => byId(id).phase } };
  const runtime = makeModelRuntime(cfg.model);

  log({ kind: "run_started", condition: cfg.condition, n: cond.n, taskId: task.id, task: task.prompt, pool, wallClockMs: cfg.wallClockMs });
  ids.forEach((id, index) => {
    const seed = cfg.seed * 100 + index;
    const prompt = systemPrompt(cond, id, ids);
    const tools = buildTools(cond, id, ctx, [readShardTool(task, cfg.toolDelayMs)]);
    log({ kind: "agent_started", agent: id, index, seed, systemPrompt: prompt, tools: tools.map((t) => t.name) });
    const loop = new AgentLoop({ id, systemPrompt: prompt, tools, runtime, seed, canBeWoken: cond.messaging, ctx, clock });
    loops.push(loop);
    bus.add(loop);
    controller.register(loop);
  });

  controller.start();
  for (const l of loops) void l.start(task.prompt);
  const reason = await controller.done;
  await Promise.all(loops.map((l) => (HARD_STOP.has(reason) ? l.stop() : l.settled())));
  for (const l of loops) l.finishOnRunEnd();

  const wallMs = Math.max(0, Math.round(clock.now() - t0));
  const solved = reason === "solved";
  log({ kind: "run_finished", reason, solved, wallMs, totalTokens: controller.used });
  deps.log.finishRun(runId, solved ? "solved" : reason === "infra_error" ? "infra_error" : "unsolved", reason, new Date().toISOString());
  return { runId, reason, solved, totalTokens: controller.used, wallMs };
}
```

Note: in the `budget` test the in-flight calls finish and are charged; their tool calls are then blocked by `beforeToolCall` (logged as error `tool_result`s if pi emits them), and their next request is refused with `ended`. If `settled()` hangs because a loop keeps looping after the end, the bug is in `drive` (it must return once `controller.ended` is set), not in the test.

- [ ] **Step 5: Implement `cli.ts` and the example config**

`packages/runtime/src/cli.ts`:
```ts
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseConfig } from "./config.ts";
import { EventLog } from "./log/event-log.ts";
import { runOnce } from "./run/run.ts";

function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

const USAGE = "usage:\n  polylogue run <config.json> [--db runs.sqlite]\n  polylogue serve <runs.sqlite> [--port 4317] [--host 127.0.0.1] [--viewer packages/viewer/dist]";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "run") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { db: { type: "string", default: "runs.sqlite" } } });
    if (positionals.length !== 1) throw new Error(USAGE);
    const cfg = parseConfig(JSON.parse(readFileSync(positionals[0]!, "utf8")));
    const log = new EventLog(values.db!);
    try {
      console.log(JSON.stringify(await runOnce(cfg, { log, gitSha: gitSha() }), null, 2));
    } finally {
      log.close();
    }
    return;
  }
  if (command === "serve") {
    const { serve } = await import("./server/server.ts");
    await serve(rest);
    return;
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
```

`configs/smoke-zgx.json` (for the live smoke run later; not used by tests):
```json
{
  "condition": "polylogue",
  "taskId": "toy-vault",
  "seed": 1,
  "budget": { "tokensPerAgent": 60000 },
  "wallClockMs": 600000,
  "rate": { "messagesPerMinute": 10, "maxMessageChars": 2000 },
  "toolDelayMs": 500,
  "checkServer": true,
  "model": {
    "baseUrl": "http://zgx-40dd.local:8000/v1",
    "id": "qwen3.8-27b",
    "hfRepo": "unsloth/Qwen3.8-27B-NVFP4",
    "revision": "7d6f8d4d72f56b92b3cdbf22f156b90e1bab0108",
    "contextWindow": 262144,
    "maxTokens": 8192,
    "reasoningEffort": "medium",
    "timeoutMs": 1800000,
    "maxRetries": 3
  }
}
```

`serve` is implemented in Task 8; until then `polylogue serve` fails at import, which is fine.

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/runtime && npx tsc -p tsconfig.json`
Expected: all runtime tests PASS (11 new), tsc may report `./server/server.ts` missing: if so, leave the dynamic import and add `// @ts-expect-error implemented in Task 8` above it, then remove that comment in Task 8.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/config.ts packages/runtime/src/run packages/runtime/src/cli.ts configs
git commit -m "runOnce: five conditions end to end, end reasons, polylogue run CLI"
```

---

### Task 8: Read-only server and `polylogue serve`

**Files:**
- Create: `packages/runtime/src/server/server.ts`
- Modify: `packages/runtime/src/cli.ts` (remove the `@ts-expect-error` if Task 7 added it)
- Test: `packages/runtime/src/server/server.test.ts`

**Interfaces:**
- Consumes: `EventLog`, `StoredEvent` (Task 2).
- Produces: `createServer(dbPath: string, opts?: { viewerDir?: string; pollMs?: number }): http.Server`; `serve(args: string[]): Promise<void>` (parses `<db> [--port 4317] [--host 127.0.0.1] [--viewer <dir>]`, listens, prints the URL).

Routes (GET only; anything else 405):
- `/runs` → `RunRow[]` JSON.
- `/runs/:id` → `RunRow` JSON or 404 `{ "error": "Run not found" }`.
- `/runs/:id/events?from=N` → `StoredEvent[]` JSON (404 for an unknown run).
- `/runs/:id/stream?from=N` → `text/event-stream`. Sends each stored event as `id: <seq>\ndata: <StoredEvent JSON>\n\n`, then polls every `pollMs` (default 500) for new ones; after sending `run_finished` it sends `event: end\ndata: {}\n\n` and closes. Clears its timer when the client disconnects.
- Anything else: if `viewerDir` is set, serve the file under it (resolved path must stay inside `viewerDir`, else 404), falling back to `index.html` for paths without an extension; otherwise 404.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/src/server/server.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type http from "node:http";
import { createServer } from "./server.ts";
import { EventLog } from "../log/event-log.ts";

let server: http.Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "polylogue-srv-"));
  const db = join(dir, "runs.sqlite");
  const log = new EventLog(db);
  log.createRun({ id: "r1", condition: "single", n: 1, taskId: "toy-vault", seed: 1, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
  log.append("r1", { kind: "idle", t: 1, agent: "a1" });
  const viewer = join(dir, "viewer");
  mkdirSync(viewer);
  writeFileSync(join(viewer, "index.html"), "<!doctype html><title>viewer</title>");
  writeFileSync(join(dir, "secret.txt"), "nope");
  return { db, log, viewer };
}

async function listen(s: http.Server): Promise<string> {
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("server", () => {
  it("serves runs, a run, and its events", async () => {
    const { db } = fixture();
    server = createServer(db);
    const base = await listen(server);
    expect((await (await fetch(`${base}/runs`)).json()).map((r: { id: string }) => r.id)).toEqual(["r1"]);
    expect((await (await fetch(`${base}/runs/r1`)).json()).status).toBe("running");
    expect((await (await fetch(`${base}/runs/r1/events`)).json())[0]).toMatchObject({ seq: 0, event: { kind: "idle" } });
    expect((await (await fetch(`${base}/runs/r1/events?from=1`)).json())).toEqual([]);
    const missing = await fetch(`${base}/runs/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Run not found" });
    expect((await fetch(`${base}/runs`, { method: "POST" })).status).toBe(405);
  });

  it("streams existing and new events, then ends after run_finished", async () => {
    const { db, log } = fixture();
    server = createServer(db, { pollMs: 20 });
    const base = await listen(server);
    const res = await fetch(`${base}/runs/r1/stream`);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    setTimeout(() => {
      log.append("r1", { kind: "wake", t: 2, agent: "a1", reason: "message" });
      log.append("r1", { kind: "run_finished", t: 3, reason: "all_idle", solved: false, wallMs: 3, totalTokens: 0 });
    }, 50);
    const body = await res.text();
    const seqs = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(seqs).toEqual([0, 1, 2]);
    expect(body).toContain("event: end");
  });

  it("serves the viewer with an index fallback and refuses paths outside it", async () => {
    const { db, viewer } = fixture();
    server = createServer(db, { viewerDir: viewer });
    const base = await listen(server);
    expect(await (await fetch(`${base}/`)).text()).toContain("<title>viewer</title>");
    expect(await (await fetch(`${base}/replay/r1`)).text()).toContain("<title>viewer</title>");
    expect((await fetch(`${base}/..%2fsecret.txt`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/runtime/src/server`
Expected: FAIL, cannot resolve `./server.ts`.

- [ ] **Step 3: Implement**

`packages/runtime/src/server/server.ts`:
```ts
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { EventLog } from "../log/event-log.ts";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createServer(dbPath: string, opts: { viewerDir?: string; pollMs?: number } = {}): http.Server {
  const log = new EventLog(dbPath, { readonly: true });
  const pollMs = opts.pollMs ?? 500;
  const viewerDir = opts.viewerDir ? resolve(opts.viewerDir) : undefined;

  const server = http.createServer((req, res) => {
    if (req.method !== "GET") return json(res, 405, { error: "Read-only server: only GET is allowed" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const from = Number(url.searchParams.get("from") ?? 0) || 0;

    if (parts[0] === "runs") {
      if (parts.length === 1) return json(res, 200, log.runs());
      const run = log.run(parts[1]!);
      if (!run) return json(res, 404, { error: "Run not found" });
      if (parts.length === 2) return json(res, 200, run);
      if (parts[2] === "events" && parts.length === 3) return json(res, 200, log.events(run.id, from));
      if (parts[2] === "stream" && parts.length === 3) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        let next = from;
        let timer: NodeJS.Timeout | undefined;
        const pump = () => {
          for (const s of log.events(run.id, next)) {
            res.write(`id: ${s.seq}\ndata: ${JSON.stringify(s)}\n\n`);
            next = s.seq + 1;
            if (s.event.kind === "run_finished") {
              res.end("event: end\ndata: {}\n\n");
              return;
            }
          }
          timer = setTimeout(pump, pollMs);
        };
        req.on("close", () => clearTimeout(timer));
        pump();
        return;
      }
      return json(res, 404, { error: "Not found" });
    }

    if (viewerDir) {
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      let file = resolve(viewerDir, rel);
      if (file !== viewerDir && !file.startsWith(viewerDir + sep)) return json(res, 404, { error: "Not found" });
      if (!existsSync(file) || !statSync(file).isFile()) {
        if (extname(rel)) return json(res, 404, { error: "Not found" });
        file = join(viewerDir, "index.html");
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
      return;
    }
    json(res, 404, { error: "Not found" });
  });
  server.on("close", () => log.close());
  return server;
}

export async function serve(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: "string", default: "4317" }, host: { type: "string", default: "127.0.0.1" }, viewer: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error("usage: polylogue serve <runs.sqlite> [--port 4317] [--host 127.0.0.1] [--viewer <dir>]");
  const server = createServer(positionals[0]!, { viewerDir: values.viewer });
  await new Promise<void>((ok) => server.listen(Number(values.port), values.host, ok));
  console.log(`polylogue: serving ${positionals[0]} at http://${values.host}:${values.port}/`);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/runtime && npx tsc -p tsconfig.json`
Expected: all PASS (3 new), tsc silent.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/server packages/runtime/src/cli.ts
git commit -m "Read-only server: runs, events, SSE stream, viewer files"
```

---

### Task 9: Viewer core: simulator and `stateAt`

**Files:**
- Create: `packages/viewer/tsconfig.json`, `packages/viewer/src/sim.ts`, `packages/viewer/src/state.ts`
- Test: `packages/viewer/src/sim.test.ts`, `packages/viewer/src/state.test.ts`

**Interfaces:**
- Consumes: `Event`, `Of`, `ConditionName` (Task 1).
- Produces:
  - `simulate(condition: ConditionName, seed: number): Event[]` — sorted by `t`, valid schema events, deterministic per seed, exactly one `run_finished`, last.
  - `state.ts`: `type Phase = "thinking" | "tool" | "working" | "idle" | "finished"`; `interface AgentView { id: string; status: string; phase: Phase; tokens: number; sent: number; finishedReason?: string }`; `interface Segment { kind: "model" | "tool" | "idle"; start: number; end: number }`; `interface Lane { agent: string; segments: Segment[]; marks: { kind: "sent" | "received" | "blackboard" | "claim"; t: number }[] }`; `interface EdgeView { from: string; to: string; count: number; lastT: number; active: boolean }`; `interface Counters { tokens: number; pool: number; wallMs: number; messages: number; messagesPerMinute: number }`; `interface ViewState { t: number; duration: number; run?: Of<"run_started">; ended?: Of<"run_finished">; agents: AgentView[]; edges: EdgeView[]; lanes: Lane[]; chat: Of<"message">[]; blackboard: Of<"blackboard">[]; counters: Counters }`; `stateAt(events: Event[], t: number): ViewState`; `ACTIVE_EDGE_MS = 3000`.

`stateAt` rules: only events with `event.t <= t` count, except that model-call segments are taken from every event whose start (`t - ms`) is ≤ `t` (a call is logged when it ends); `duration` = the largest `t` in `events` (0 when empty). Model segment = `[model_call.t - ms, model_call.t]`; tool segment = `[tool_call.t, matching tool_result.t]` (open segments end at `t`); idle segment = `[idle.t, next wake/agent_finished of that agent or t]`. A segment that starts after `t` is left out; one that ends after `t` is cut at `t`. Phase at `t`: `finished` if an `agent_finished` ≤ t; else the kind of the segment containing `t` (`model` → `thinking`, `tool` → `tool`, `idle` → `idle`); else `working`. Edges: a direct message adds `from → to`; a topic message adds `from → every other started agent`. `active` = `t - lastT <= ACTIVE_EDGE_MS`. `messagesPerMinute` = messages with `t - 60000 < m.t <= t`. Agents appear in `agent_started` order.

The simulator plays a believable run of the condition: each agent alternates model calls (1.5–6 s, tokens growing with the call number) and `read_shard` tool calls; in `stigmergic`/`polylogue*` some steps append to the blackboard; in `polylogue*` some steps send a direct or `#all` message, delivered to live recipients 0.2–2 s later; one agent claims the right code with probability 0.8 (else a wrong claim and the run ends `all_idle`); after a solve, other agents get `agent_finished: run_ended` and nothing later. Use a seeded PRNG (mulberry32); never `Math.random`.

- [ ] **Step 1: Viewer tsconfig**

`packages/viewer/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "types": ["vite/client"]
  },
  "include": ["src", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

- [ ] **Step 2: Write the failing tests**

`packages/viewer/src/sim.test.ts`:
```ts
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
```

`packages/viewer/src/state.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Event } from "@polylogue/schema";
import { stateAt } from "./state.ts";
import { simulate } from "./sim.ts";

const base: Event[] = [
  { kind: "run_started", t: 0, condition: "polylogue", n: 2, taskId: "toy-vault", task: "Find it.", pool: 1000, wallClockMs: 60000 },
  { kind: "agent_started", t: 0, agent: "a1", index: 0, seed: 100, systemPrompt: "s", tools: [] },
  { kind: "agent_started", t: 0, agent: "a2", index: 1, seed: 101, systemPrompt: "s", tools: [] },
  { kind: "model_call", t: 1000, agent: "a1", call: 0, content: "reading", reasoning: "", toolCalls: [], tokensIn: 300, tokensOut: 50, ms: 800, stopReason: "toolUse" },
  { kind: "status", t: 1000, agent: "a1", text: "reading" },
  { kind: "tool_call", t: 1000, agent: "a1", callId: "c1", tool: "read_shard", args: { shard: 1 } },
  { kind: "tool_result", t: 1500, agent: "a1", callId: "c1", tool: "read_shard", isError: false, text: "x", ms: 500 },
  { kind: "idle", t: 1200, agent: "a2" },
  { kind: "message", t: 1600, id: "m0", from: "a1", to: "a2", text: "digit 1 is 4", urgent: false },
  { kind: "wake", t: 1600, agent: "a2", reason: "message" },
  { kind: "message", t: 1700, id: "m1", from: "a1", to: { topic: "all" }, text: "fyi", urgent: false },
  { kind: "blackboard", t: 1800, agent: "a1", text: "digit 1 = 4" },
  { kind: "agent_finished", t: 9000, agent: "a1", reason: "claimed" },
];

describe("stateAt", () => {
  it("shows phases at given times", () => {
    expect(stateAt(base, 500).agents.find((a) => a.id === "a1")!.phase).toBe("thinking");
    expect(stateAt(base, 1200).agents.find((a) => a.id === "a1")!.phase).toBe("tool");
    expect(stateAt(base, 1300).agents.find((a) => a.id === "a2")!.phase).toBe("idle");
    expect(stateAt(base, 1650).agents.find((a) => a.id === "a2")!.phase).toBe("working");
    expect(stateAt(base, 9000).agents.find((a) => a.id === "a1")!.phase).toBe("finished");
  });

  it("counts tokens, messages and status only up to t", () => {
    const early = stateAt(base, 999);
    expect(early.counters).toMatchObject({ tokens: 0, pool: 1000, messages: 0, wallMs: 999 });
    expect(early.agents[0]!.status).toBe("");
    const later = stateAt(base, 2000);
    expect(later.counters).toMatchObject({ tokens: 350, messages: 2, messagesPerMinute: 2 });
    expect(later.agents[0]).toMatchObject({ status: "reading", tokens: 350, sent: 2 });
    expect(later.chat.map((m) => m.id)).toEqual(["m0", "m1"]);
    expect(later.blackboard).toHaveLength(1);
  });

  it("builds edges for direct and topic messages and marks recent ones active", () => {
    const s = stateAt(base, 2000);
    expect(s.edges).toEqual([{ from: "a1", to: "a2", count: 2, lastT: 1700, active: true }]);
    expect(stateAt(base, 1700 + 3001).edges[0]!.active).toBe(false);
  });

  it("cuts lanes at t", () => {
    const lane = stateAt(base, 1200).lanes.find((l) => l.agent === "a1")!;
    expect(lane.segments).toEqual([{ kind: "model", start: 200, end: 1000 }, { kind: "tool", start: 1000, end: 1200 }]);
  });

  it("works on a run that has not finished", () => {
    const s = stateAt(base, 2000);
    expect(s.duration).toBe(9000);
    expect(s.ended).toBeUndefined();
    expect(stateAt([], 0)).toMatchObject({ duration: 0, agents: [], counters: { tokens: 0, pool: 0 } });
  });

  it("ends with the run_finished reason on a simulated run", () => {
    const events = simulate("polylogue", 2);
    const s = stateAt(events, events.at(-1)!.t);
    expect(s.ended?.kind).toBe("run_finished");
    expect(s.agents.every((a) => a.phase === "finished")).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run packages/viewer`
Expected: FAIL, cannot resolve `./sim.ts`.

- [ ] **Step 4: Implement `state.ts`**

```ts
import type { Event, Of } from "@polylogue/schema";

export type Phase = "thinking" | "tool" | "working" | "idle" | "finished";
export interface AgentView { id: string; status: string; phase: Phase; tokens: number; sent: number; finishedReason?: string }
export interface Segment { kind: "model" | "tool" | "idle"; start: number; end: number }
export interface Lane { agent: string; segments: Segment[]; marks: { kind: "sent" | "received" | "blackboard" | "claim"; t: number }[] }
export interface EdgeView { from: string; to: string; count: number; lastT: number; active: boolean }
export interface Counters { tokens: number; pool: number; wallMs: number; messages: number; messagesPerMinute: number }
export interface ViewState {
  t: number;
  duration: number;
  run?: Of<"run_started">;
  ended?: Of<"run_finished">;
  agents: AgentView[];
  edges: EdgeView[];
  lanes: Lane[];
  chat: Of<"message">[];
  blackboard: Of<"blackboard">[];
  counters: Counters;
}

export const ACTIVE_EDGE_MS = 3000;

export function stateAt(events: Event[], t: number): ViewState {
  const duration = events.reduce((m, e) => Math.max(m, e.t), 0);
  const seen = events.filter((e) => e.t <= t);
  const run = seen.find((e): e is Of<"run_started"> => e.kind === "run_started");
  const ended = seen.find((e): e is Of<"run_finished"> => e.kind === "run_finished");
  const ids = seen.flatMap((e) => (e.kind === "agent_started" ? [e.agent] : []));
  const agents = new Map<string, AgentView>(ids.map((id) => [id, { id, status: "", phase: "working" as Phase, tokens: 0, sent: 0 }]));
  const lanes = new Map<string, Lane>(ids.map((id) => [id, { agent: id, segments: [], marks: [] }]));
  const edges = new Map<string, EdgeView>();
  const chat: Of<"message">[] = [];
  const blackboard: Of<"blackboard">[] = [];
  const openTools = new Map<string, number>();
  const openIdle = new Map<string, number>();
  let tokens = 0;

  const addSegment = (agent: string, kind: Segment["kind"], start: number, end: number) => {
    if (start > t) return;
    lanes.get(agent)?.segments.push({ kind, start, end: Math.min(end, t) });
  };
  const closeIdle = (agent: string, at: number) => {
    const start = openIdle.get(agent);
    if (start !== undefined) addSegment(agent, "idle", start, at);
    openIdle.delete(agent);
  };
  const addEdge = (from: string, to: string, at: number) => {
    const key = `${from}->${to}`;
    const e = edges.get(key) ?? { from, to, count: 0, lastT: at, active: false };
    e.count += 1;
    e.lastT = at;
    edges.set(key, e);
  };

  // A model call is logged when it ends; its segment starts at t - ms, so take it from all events.
  for (const e of events) if (e.kind === "model_call") addSegment(e.agent, "model", Math.max(0, e.t - e.ms), e.t);

  for (const e of seen) {
    switch (e.kind) {
      case "status":
        agents.get(e.agent)!.status = e.text;
        break;
      case "model_call":
        tokens += e.tokensIn + e.tokensOut;
        agents.get(e.agent)!.tokens += e.tokensIn + e.tokensOut;
        break;
      case "tool_call":
        openTools.set(e.callId, e.t);
        break;
      case "tool_result": {
        const start = openTools.get(e.callId) ?? e.t - e.ms;
        openTools.delete(e.callId);
        addSegment(e.agent, "tool", start, e.t);
        if (e.tool === "claim") lanes.get(e.agent)?.marks.push({ kind: "claim", t: e.t });
        break;
      }
      case "idle":
        openIdle.set(e.agent, e.t);
        break;
      case "wake":
        closeIdle(e.agent, e.t);
        break;
      case "message": {
        chat.push(e);
        agents.get(e.from)!.sent += 1;
        lanes.get(e.from)?.marks.push({ kind: "sent", t: e.t });
        const targets = typeof e.to === "string" ? [e.to] : ids.filter((id) => id !== e.from);
        for (const to of targets) addEdge(e.from, to, e.t);
        break;
      }
      case "message_delivered":
        lanes.get(e.agent)?.marks.push({ kind: "received", t: e.t });
        break;
      case "blackboard":
        blackboard.push(e);
        lanes.get(e.agent)?.marks.push({ kind: "blackboard", t: e.t });
        break;
      case "agent_finished": {
        closeIdle(e.agent, e.t);
        const a = agents.get(e.agent)!;
        a.phase = "finished";
        a.finishedReason = e.reason;
        break;
      }
      default:
        break;
    }
  }
  for (const [callId, start] of openTools) {
    const call = seen.find((e) => e.kind === "tool_call" && e.callId === callId) as Of<"tool_call"> | undefined;
    if (call) addSegment(call.agent, "tool", start, t);
  }
  for (const agent of [...openIdle.keys()]) closeIdle(agent, t);

  for (const lane of lanes.values()) lane.segments.sort((a, b) => a.start - b.start);
  for (const a of agents.values()) {
    if (a.phase === "finished") continue;
    const current = lanes.get(a.id)!.segments.filter((s) => s.start <= t && t <= s.end).at(-1);
    a.phase = current ? (current.kind === "model" ? "thinking" : current.kind) : "working";
  }

  for (const e of edges.values()) e.active = t - e.lastT <= ACTIVE_EDGE_MS;
  const messagesPerMinute = chat.filter((m) => t - 60_000 < m.t && m.t <= t).length;
  return {
    t, duration, run, ended,
    agents: [...agents.values()],
    edges: [...edges.values()],
    lanes: [...lanes.values()],
    chat, blackboard,
    counters: { tokens, pool: run?.pool ?? 0, wallMs: t, messages: chat.length, messagesPerMinute },
  };
}
```

Phase rule check against the tests: at `t = 500`, a1's model call (logged at 1000 with `ms: 800`) already has the segment `[200, 500]`, so a1 is `thinking`: model segments come from *all* events because a call is only logged when it ends; tokens still count only once the call has ended. At `t = 1650`, a2's idle segment is `[1200, 1600]`, which ends before `t`, so a2 is `working`. At `t = 1200`, a1's tool segment `[1000, 1200]` contains `t` (cut at `t`; the result comes at 1500), so a1 is `tool`. For a live run this means a call in flight shows as `working` until it is logged; that is expected.

- [ ] **Step 5: Implement `sim.ts`**

```ts
import type { ConditionName, Event, EventInput } from "@polylogue/schema";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const N: Record<ConditionName, number> = { single: 1, isolated: 4, stigmergic: 4, polylogue: 4, "polylogue-bare": 4 };
const STATUSES = ["reading the case file", "checking shard digits", "comparing notes", "ruling out the retired code", "assembling the code"];

export function simulate(condition: ConditionName, seed: number): Event[] {
  const rnd = mulberry32(seed * 7919 + condition.length);
  const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo));
  const n = N[condition];
  const ids = Array.from({ length: n }, (_, i) => `a${i + 1}`);
  const blackboard = condition !== "single" && condition !== "isolated";
  const messaging = condition.startsWith("polylogue");
  const out: Event[] = [];
  const push = (t: number, e: EventInput) => out.push({ ...e, t } as Event);
  let msgCount = 0;
  const deliveries = new Map<string, number>();

  push(0, { kind: "run_started", condition, n, taskId: "toy-vault", task: "Find the 4-digit vault code.", pool: 60000 * n, wallClockMs: 600000 });
  ids.forEach((id, i) => push(0, { kind: "agent_started", agent: id, index: i, seed: seed * 100 + i, systemPrompt: `You are agent ${id}.`, tools: ["read_shard", "claim"] }));

  const plans = ids.map((id) => {
    const steps = between(3, 6);
    let cursor = between(0, 400);
    const callIds: string[] = [];
    for (let k = 0; k < steps; k++) {
      const ms = between(1500, 6000);
      cursor += ms;
      const callId = `${id}-c${k}`;
      callIds.push(callId);
      push(cursor, { kind: "model_call", agent: id, call: k, content: STATUSES[k % STATUSES.length]!, reasoning: "", toolCalls: [{ id: callId, name: "read_shard", args: { shard: k + 1 } }], tokensIn: 900 + 450 * k, tokensOut: between(40, 260), ms, stopReason: "toolUse" });
      push(cursor, { kind: "status", agent: id, text: STATUSES[k % STATUSES.length]! });
      push(cursor, { kind: "tool_call", agent: id, callId, tool: "read_shard", args: { shard: k + 1 } });
      const toolMs = between(200, 1500);
      cursor += toolMs;
      push(cursor, { kind: "tool_result", agent: id, callId, tool: "read_shard", isError: false, text: `shard ${k + 1}`, ms: toolMs });
      if (blackboard && rnd() < 0.35) push(cursor, { kind: "blackboard", agent: id, text: `shard ${k + 1} read` });
      if (messaging && n > 1 && (rnd() < 0.5 || (id === "a1" && k === 0))) {
        const id2 = `m${msgCount++}`;
        const direct = rnd() < 0.6;
        const others = ids.filter((x) => x !== id);
        const to = direct ? others[between(0, others.length - 1)]! : { topic: "all" };
        push(cursor, { kind: "message", id: id2, from: id, to, text: `shard ${k + 1} says digit ${k + 1}`, urgent: rnd() < 0.1 });
        for (const r of typeof to === "string" ? [to] : others) {
          const d = deliveries.get(r) ?? 0;
          deliveries.set(r, d + 1);
          push(cursor + between(200, 2000), { kind: "message_delivered", agent: r, messageId: id2, delivery: d });
        }
      }
    }
    return { id, claimAt: cursor + between(800, 3000) };
  });

  const solved = rnd() < 0.8;
  const first = plans.reduce((a, b) => (b.claimAt < a.claimAt ? b : a));
  const endT = first.claimAt + 1;
  for (const p of plans) {
    if (p.claimAt > first.claimAt) continue;
    push(p.claimAt, { kind: "claim_submitted", agent: p.id, answer: solved ? "4719" : "4791", evidence: "shards 1, 3, 5, 7" });
    push(p.claimAt, solved ? { kind: "verification", claimOf: p.id, passed: true } : { kind: "verification", claimOf: p.id, passed: false, detail: "expected 4719, got 4791" });
    push(p.claimAt, { kind: "agent_finished", agent: p.id, reason: "claimed" });
  }
  const kept = out.filter((e) => e.t <= endT || e.kind === "agent_started" || e.kind === "run_started");
  for (const p of plans) if (p.id !== first.id) kept.push({ kind: "agent_finished", t: endT, agent: p.id, reason: "run_ended" } as Event);
  const tokens = kept.reduce((s, e) => s + (e.kind === "model_call" ? e.tokensIn + e.tokensOut : 0), 0);
  kept.push({ kind: "run_finished", t: endT, reason: solved ? "solved" : "all_idle", solved, wallMs: endT, totalTokens: tokens } as Event);
  return kept.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map(({ e }) => e);
}
```

The sort is stable on insertion order for equal `t`, and `run_finished` is pushed last at the largest `t`, so it stays last. If two agents have the same `claimAt`, both claims precede the end; keep that.

- [ ] **Step 6: Run tests and type-check**

Run: `npx vitest run packages/viewer && npx tsc -p packages/viewer/tsconfig.json`
Expected: 13 tests PASS. tsc may complain about missing `src/main.tsx` imports only after Task 10; it must be silent now.

- [ ] **Step 7: Commit**

```bash
git add packages/viewer/tsconfig.json packages/viewer/src/sim.ts packages/viewer/src/sim.test.ts packages/viewer/src/state.ts packages/viewer/src/state.test.ts
git commit -m "Viewer core: seeded event simulator and stateAt"
```

---

### Task 10: Viewer UI and the Playwright check

**Files:**
- Create: `packages/viewer/index.html`, `packages/viewer/vite.config.ts`, `packages/viewer/playwright.config.ts`, `packages/viewer/src/main.tsx`, `packages/viewer/src/App.tsx`, `packages/viewer/src/source.ts`, `packages/viewer/src/styles.css`, `packages/viewer/src/views/TeamGraph.tsx`, `packages/viewer/src/views/Swimlanes.tsx`, `packages/viewer/src/views/ChatFeed.tsx`, `packages/viewer/src/views/BlackboardView.tsx`, `packages/viewer/src/views/Counters.tsx`, `packages/viewer/src/views/Scrubber.tsx`
- Test: `packages/viewer/e2e/viewer.spec.ts`

**Interfaces:**
- Consumes: `simulate`, `stateAt`, `ViewState` (Task 9); server routes (Task 8).
- Produces: a page that reads its source from the URL:
  - `?sim=<condition>&seed=<n>` → simulated run (replay).
  - `?run=<id>` → `GET /runs/<id>`; 404 → shows `Run not found: <id>`; otherwise loads `/runs/<id>/events`, and when the run's status is `running`, follows `/runs/<id>/stream?from=<next seq>` (EventSource) and keeps `t` at the newest event while "Follow live" is checked.
  - no parameters → lists `/runs` as links, plus links to one simulated run per condition (the list request may fail when no server is behind the page; then only the simulated links show).
- Test ids (the Playwright check relies on them): `team-graph`, `swimlanes`, `chat-feed`, `blackboard`, `counters`, `counter-tokens`, `scrubber`, `run-error`.

- [ ] **Step 1: Build config and entry**

`packages/viewer/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Polylogue viewer</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/viewer/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/runs": "http://127.0.0.1:4317" } },
});
```

`packages/viewer/src/main.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 2: Data source**

`packages/viewer/src/source.ts`:
```ts
import { ConditionName, Event, type RunRow } from "@polylogue/schema";
import { simulate } from "./sim.ts";

export type Source =
  | { kind: "sim"; condition: ConditionName; seed: number }
  | { kind: "run"; id: string }
  | { kind: "index" };

export function sourceFromUrl(search: string): Source {
  const p = new URLSearchParams(search);
  const sim = ConditionName.safeParse(p.get("sim"));
  if (sim.success) return { kind: "sim", condition: sim.data, seed: Number(p.get("seed") ?? 1) || 1 };
  const run = p.get("run");
  if (run) return { kind: "run", id: run };
  return { kind: "index" };
}

export function simulatedEvents(condition: ConditionName, seed: number): Event[] {
  return simulate(condition, seed);
}

export async function loadRun(id: string): Promise<{ run: RunRow; events: { seq: number; event: Event }[] } | null> {
  const res = await fetch(`/runs/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  const run = (await res.json()) as RunRow;
  const events = (await (await fetch(`/runs/${encodeURIComponent(id)}/events`)).json()) as { seq: number; event: unknown }[];
  return { run, events: events.map((s) => ({ seq: s.seq, event: Event.parse(s.event) })) };
}

export function followRun(id: string, fromSeq: number, onEvent: (e: Event) => void): () => void {
  const es = new EventSource(`/runs/${encodeURIComponent(id)}/stream?from=${fromSeq}`);
  es.onmessage = (m) => onEvent(Event.parse(JSON.parse(m.data).event));
  es.addEventListener("end", () => es.close());
  return () => es.close();
}

export async function listRuns(): Promise<RunRow[]> {
  try {
    const res = await fetch("/runs");
    return res.ok ? ((await res.json()) as RunRow[]) : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Views**

`packages/viewer/src/views/Counters.tsx`:
```tsx
import type { ViewState } from "../state.ts";

const fmt = (n: number) => n.toLocaleString("en-US");
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function Counters({ s }: { s: ViewState }) {
  return (
    <section className="counters" data-testid="counters" aria-label="Counters">
      <div><span className="label">Tokens</span><span className="value" data-testid="counter-tokens">{fmt(s.counters.tokens)}</span><span className="sub">of {fmt(s.counters.pool)}</span></div>
      <div><span className="label">Wall clock</span><span className="value">{clock(s.counters.wallMs)}</span></div>
      <div><span className="label">Messages</span><span className="value">{fmt(s.counters.messages)}</span><span className="sub">{s.counters.messagesPerMinute}/min</span></div>
      <div><span className="label">Result</span><span className="value">{s.ended ? (s.ended.solved ? "solved" : s.ended.reason) : "running"}</span></div>
    </section>
  );
}
```

`packages/viewer/src/views/TeamGraph.tsx`:
```tsx
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import type { ViewState } from "../state.ts";

export function TeamGraph({ s }: { s: ViewState }) {
  const r = 140;
  const nodes: Node[] = s.agents.map((a, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, s.agents.length) - Math.PI / 2;
    return {
      id: a.id,
      position: { x: 180 + r * Math.cos(angle), y: 160 + r * Math.sin(angle) },
      data: { label: <div className={`node ${a.phase}`}><strong>{a.id}</strong> <em>{a.phase}</em><div className="status">{a.status || "—"}</div></div> },
      draggable: false,
    };
  });
  const edges: Edge[] = s.edges.map((e) => ({
    id: `${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    label: String(e.count),
    animated: e.active,
    style: { strokeWidth: Math.min(6, 1 + e.count), opacity: e.active ? 1 : 0.45 },
  }));
  return (
    <section className="panel graph" data-testid="team-graph" aria-label="Team graph">
      <h2>Team</h2>
      <div className="graph-canvas">
        <ReactFlow nodes={nodes} edges={edges} fitView nodesConnectable={false} proOptions={{ hideAttribution: true }} />
      </div>
    </section>
  );
}
```

`packages/viewer/src/views/Swimlanes.tsx`:
```tsx
import type { ViewState } from "../state.ts";

export function Swimlanes({ s }: { s: ViewState }) {
  const width = Math.max(1, s.duration);
  const row = 28;
  return (
    <section className="panel" data-testid="swimlanes" aria-label="Swimlanes">
      <h2>Timeline</h2>
      <svg viewBox={`0 0 1000 ${s.lanes.length * row + 4}`} preserveAspectRatio="none" className="lanes" role="img" aria-label="Agent timelines">
        {s.lanes.map((lane, i) => (
          <g key={lane.agent} transform={`translate(0 ${i * row + 2})`}>
            <rect x={0} y={0} width={1000} height={row - 6} className="lane-bg" />
            {lane.segments.map((seg, k) => (
              <rect key={k} x={(seg.start / width) * 1000} y={0} width={Math.max(1, ((seg.end - seg.start) / width) * 1000)} height={row - 6} className={`seg ${seg.kind}`} />
            ))}
            {lane.marks.map((m, k) => (
              <rect key={`m${k}`} x={(m.t / width) * 1000 - 1} y={0} width={2} height={row - 6} className={`mark ${m.kind}`} />
            ))}
            <text x={6} y={row / 2} className="lane-label">{lane.agent}</text>
          </g>
        ))}
        <line x1={(s.t / width) * 1000} x2={(s.t / width) * 1000} y1={0} y2={s.lanes.length * row + 4} className="cursor" />
      </svg>
      <p className="legend"><span className="key model" /> model call <span className="key tool" /> tool <span className="key idle" /> idle</p>
    </section>
  );
}
```

`packages/viewer/src/views/ChatFeed.tsx`:
```tsx
import type { ViewState } from "../state.ts";

export function ChatFeed({ s }: { s: ViewState }) {
  return (
    <section className="panel" data-testid="chat-feed" aria-label="Messages">
      <h2>Messages</h2>
      {s.chat.length === 0 ? <p className="empty">No messages yet.</p> : (
        <ol className="chat">
          {s.chat.map((m) => (
            <li key={m.id}>
              <span className="who">{m.from} → {typeof m.to === "string" ? m.to : `#${m.to.topic}`}</span>
              {m.urgent && <span className="urgent">urgent</span>}
              <span className="text">{m.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

`packages/viewer/src/views/BlackboardView.tsx`:
```tsx
import type { ViewState } from "../state.ts";

export function BlackboardView({ s }: { s: ViewState }) {
  return (
    <section className="panel" data-testid="blackboard" aria-label="Blackboard">
      <h2>Blackboard</h2>
      {s.blackboard.length === 0 ? <p className="empty">Nothing written yet.</p> : (
        <ol className="board">
          {s.blackboard.map((b, i) => <li key={i}><span className="who">{b.agent}</span> {b.text}</li>)}
        </ol>
      )}
    </section>
  );
}
```

`packages/viewer/src/views/Scrubber.tsx`:
```tsx
export function Scrubber(props: { t: number; duration: number; live: boolean; canFollow: boolean; playing: boolean; onT(t: number): void; onPlay(): void; onLive(v: boolean): void }) {
  return (
    <section className="scrubber" aria-label="Replay">
      <button type="button" onClick={props.onPlay}>{props.playing ? "Pause" : "Play"}</button>
      <input
        data-testid="scrubber"
        type="range"
        min={0}
        max={Math.max(1, props.duration)}
        step={50}
        value={props.t}
        onChange={(e) => props.onT(Number(e.currentTarget.value))}
        aria-label="Time in the run"
      />
      <span className="time">{(props.t / 1000).toFixed(1)} s / {(props.duration / 1000).toFixed(1)} s</span>
      {props.canFollow && (
        <label><input type="checkbox" checked={props.live} onChange={(e) => props.onLive(e.currentTarget.checked)} /> Follow live</label>
      )}
    </section>
  );
}
```

- [ ] **Step 4: App**

`packages/viewer/src/App.tsx`:
```tsx
import { useEffect, useMemo, useState } from "react";
import type { Event, RunRow } from "@polylogue/schema";
import { ConditionName } from "@polylogue/schema";
import { stateAt } from "./state.ts";
import { followRun, listRuns, loadRun, simulatedEvents, sourceFromUrl } from "./source.ts";
import { Counters } from "./views/Counters.tsx";
import { TeamGraph } from "./views/TeamGraph.tsx";
import { Swimlanes } from "./views/Swimlanes.tsx";
import { ChatFeed } from "./views/ChatFeed.tsx";
import { BlackboardView } from "./views/BlackboardView.tsx";
import { Scrubber } from "./views/Scrubber.tsx";

export function App() {
  const source = useMemo(() => sourceFromUrl(window.location.search), []);
  const [events, setEvents] = useState<Event[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [t, setT] = useState(0);
  const [live, setLive] = useState(false);
  const [canFollow, setCanFollow] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (source.kind === "sim") {
      const ev = simulatedEvents(source.condition, source.seed);
      setEvents(ev);
      setT(ev.at(-1)?.t ?? 0);
      setTitle(`Simulated ${source.condition} run (seed ${source.seed})`);
      return;
    }
    if (source.kind === "index") {
      void listRuns().then(setRuns);
      return;
    }
    let stop = () => {};
    loadRun(source.id)
      .then((r) => {
        if (!r) return setError(`Run not found: ${source.id}`);
        setTitle(`${r.run.id} · ${r.run.condition} · ${r.run.status}`);
        const ev = r.events.map((s) => s.event);
        setEvents(ev);
        setT(ev.at(-1)?.t ?? 0);
        if (r.run.status === "running") {
          setCanFollow(true);
          setLive(true);
          stop = followRun(source.id, (r.events.at(-1)?.seq ?? -1) + 1, (e) => setEvents((prev) => [...prev, e]));
        }
      })
      .catch((e: Error) => setError(`Could not load run ${source.id}: ${e.message}`));
    return () => stop();
  }, [source]);

  const duration = events.reduce((m, e) => Math.max(m, e.t), 0);
  useEffect(() => {
    if (live) setT(duration);
  }, [live, duration]);
  useEffect(() => {
    if (!playing) return;
    const h = setInterval(() => setT((x) => Math.min(duration, x + 400)), 100);
    return () => clearInterval(h);
  }, [playing, duration]);
  useEffect(() => {
    if (playing && t >= duration) setPlaying(false);
  }, [playing, t, duration]);

  const s = useMemo(() => stateAt(events, t), [events, t]);

  if (error) return <main className="page"><p className="error" data-testid="run-error">{error}</p><p><a href="./">All runs</a></p></main>;
  if (source.kind === "index") {
    return (
      <main className="page">
        <h1>Polylogue runs</h1>
        {runs.length > 0 ? (
          <ul className="runs">{runs.map((r) => <li key={r.id}><a href={`?run=${encodeURIComponent(r.id)}`}>{r.id}</a> · {r.condition} · {r.status}</li>)}</ul>
        ) : <p className="empty">No recorded runs on this server.</p>}
        <h2>Simulated runs</h2>
        <ul className="runs">{ConditionName.options.map((c) => <li key={c}><a href={`?sim=${c}&seed=1`}>{c}</a></li>)}</ul>
      </main>
    );
  }
  return (
    <main className="page">
      <header className="top"><h1>{title || "Loading…"}</h1><a href="./">All runs</a></header>
      <Counters s={s} />
      <div className="grid">
        <TeamGraph s={s} />
        <Swimlanes s={s} />
        <ChatFeed s={s} />
        <BlackboardView s={s} />
      </div>
      <Scrubber t={t} duration={duration} live={live} canFollow={canFollow} playing={playing}
        onT={(v) => { setLive(false); setT(v); }} onPlay={() => { setLive(false); setPlaying((p) => !p); }} onLive={setLive} />
    </main>
  );
}
```

`packages/viewer/src/styles.css`:
```css
:root {
  --bg: #f6f7f8; --panel: #ffffff; --fg: #1b2026; --muted: #5d6873; --line: #d8dde2;
  --model: #3d6fb6; --tool: #c98a1b; --idle: #b9c1c9; --accent: #1f7a6b; --urgent: #b4232f;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg);
}
body { margin: 0; }
.page { max-width: 1200px; margin: 0 auto; padding: 16px; display: grid; gap: 12px; }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 1.15rem; margin: 0; }
h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 8px; }
.counters { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.counters > div { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; display: grid; }
.counters .label { font-size: 0.75rem; color: var(--muted); }
.counters .value { font-size: 1.3rem; font-variant-numeric: tabular-nums; }
.counters .sub { font-size: 0.75rem; color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 520px), 1fr)); gap: 12px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px; min-width: 0; }
.graph-canvas { height: 320px; }
.node { font-size: 12px; text-align: left; }
.node em { color: var(--muted); font-style: normal; }
.node .status { color: var(--muted); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node.finished { opacity: 0.55; }
.lanes { width: 100%; height: auto; display: block; }
.lane-bg { fill: #eef1f4; }
.seg.model { fill: var(--model); } .seg.tool { fill: var(--tool); } .seg.idle { fill: var(--idle); }
.mark.sent { fill: var(--accent); } .mark.received { fill: #6b4fb3; } .mark.blackboard { fill: #2c2c2c; } .mark.claim { fill: var(--urgent); }
.lane-label { font-size: 12px; fill: #fff; dominant-baseline: middle; }
.cursor { stroke: var(--urgent); stroke-width: 2; }
.legend { font-size: 0.75rem; color: var(--muted); }
.key { display: inline-block; width: 10px; height: 10px; margin: 0 4px 0 10px; }
.key.model { background: var(--model); } .key.tool { background: var(--tool); } .key.idle { background: var(--idle); }
.chat, .board, .runs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; max-height: 300px; overflow: auto; }
.chat li, .board li { font-size: 0.9rem; }
.who { font-weight: 600; margin-right: 6px; }
.urgent { color: var(--urgent); font-size: 0.75rem; margin-right: 6px; text-transform: uppercase; }
.empty { color: var(--muted); }
.error { color: var(--urgent); }
.scrubber { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; position: sticky; bottom: 0; }
.scrubber input[type="range"] { flex: 1 1 240px; }
.time { font-variant-numeric: tabular-nums; color: var(--muted); }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

- [ ] **Step 5: Write the Playwright check**

`packages/viewer/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:4318", channel: "chrome" },
  webServer: {
    command: "npx vite build && npx vite preview --port 4318 --strictPort --host 127.0.0.1",
    cwd: ".",
    url: "http://127.0.0.1:4318",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
```

`packages/viewer/e2e/viewer.spec.ts`:
```ts
import { expect, test } from "@playwright/test";

test("replays a simulated run in every view, and the scrubber changes the counters", async ({ page }) => {
  await page.goto("/?sim=polylogue&seed=1");
  for (const id of ["team-graph", "swimlanes", "chat-feed", "blackboard", "counters", "scrubber"]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  const atEnd = await page.getByTestId("counter-tokens").textContent();
  expect(Number(atEnd!.replace(/,/g, ""))).toBeGreaterThan(0);
  await page.getByTestId("scrubber").focus();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("counter-tokens")).toHaveText("0");
});

test("an unknown run shows an error instead of a blank page", async ({ page }) => {
  await page.goto("/?run=does-not-exist");
  await expect(page.getByTestId("run-error")).toContainText(/Run not found: does-not-exist|Could not load run does-not-exist/);
});
```

(`vite preview` has no `/runs` API, so the unknown-run test sees a 404 from the static server and shows "Run not found"; against `polylogue serve --viewer` it gets the API's 404, same text.)

- [ ] **Step 6: Run everything**

Run: `npm run viewer:build && npm run test:e2e && npm test && npm run typecheck`
Expected: build succeeds; 2 Playwright tests PASS (Chrome channel; `/usr/bin/google-chrome` exists on the ThinkCentre); all vitest tests PASS; both tsc runs silent.

- [ ] **Step 7: Commit**

```bash
git add packages/viewer
git commit -m "Viewer: team graph, swimlanes, chat, blackboard, counters, scrubber; live follow; Playwright check"
```

---

### Task 11: README and the live smoke instructions

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the README**

Replace `README.md` with:
````markdown
# polylogue

Does letting agents talk to each other help? A runtime for the experiment in [IDEA.md](IDEA.md): N agents (pi, on a local vLLM server) under five conditions, every event logged to SQLite, and a viewer that replays or follows a run.

Design: [docs/superpowers/specs/2026-10-11-polylogue-runtime-design.md](docs/superpowers/specs/2026-10-11-polylogue-runtime-design.md)

## Setup

Node 22.19 or newer.

```bash
npm install
npm test
npm run typecheck
```

## Run one experiment run

```bash
npm run polylogue -- run configs/smoke-zgx.json --db runs.sqlite
```

The config names the condition (`single`, `isolated`, `stigmergic`, `polylogue`, `polylogue-bare`), the task, the seed, the team's token budget per agent, the wall-clock limit, rate limits and the pinned model. The run refuses to start if the server does not serve the pinned model. The server needs tool calling: `--enable-auto-tool-choice --tool-call-parser=qwen3_coder` (see `serving/gb10/qwen38-27b.sh` in the agent-engineering-experiments repo).

## Watch runs

```bash
npm run viewer:build
npm run polylogue -- serve runs.sqlite --viewer packages/viewer/dist
```

Open http://127.0.0.1:4317/. A running run is followed live; a finished one replays with the scrubber. `?sim=polylogue&seed=1` shows a simulated run without a server. Add `--host 0.0.0.0` only on a trusted network: the server has no auth.

## Layout

- `packages/schema`: event schema shared by runtime and viewer.
- `packages/runtime`: agent loop (pi), message bus, blackboard, controller, event log, server, CLI.
- `packages/viewer`: React viewer.
````

- [ ] **Step 2: Final check and commit**

Run: `npm test && npm run typecheck`
Expected: all PASS.

```bash
git add README.md
git commit -m "README: setup, running, watching"
```

The live smoke run against zgx-40dd (`configs/smoke-zgx.json`) is not part of this plan's acceptance (spec §1.4). Run it only after Daniel's go-ahead, and report the summary and the viewer link.
