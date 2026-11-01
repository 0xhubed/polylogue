# Polylogue phase 2 (forking) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `fork` and `fork-silent` conditions (one root agent that is forced to fork into three copies of itself at 10% of the team pool) to the runtime, viewer, pilot report and analysis, and prepare pilot P2.

**Architecture:** The root is an ordinary `AgentLoop` whose tools and prompts change at the fork. A run-level `forker` in `RunContext` clones the root's pi message history into three new `AgentLoop`s, registers them with the bus and the controller, and starts them. Runtime-injected user messages are logged as `runtime_note` events and the fork itself as a `fork` event, so every agent's context stays rebuildable from the log. Everything else (pool reservations, the claim rule, the verifier, budgets) is phase 1 unchanged.

**Tech Stack:** TypeScript (Node 22, vitest, zod, pi `@earendil-works/pi-agent-core`/`pi-ai` 1.1.0), React viewer, Python 3.12 (`prep/`, pytest, standard library only for analysis).

**Spec:** `docs/superpowers/specs/2026-10-22-polylogue-phase2-fork-design.md` (approved 2026-10-22). Read it first.

## Global Constraints

- Phase-1 frozen artifacts are not changed: `suites/*/frozen.json`, `configs/main.json`, `docs/pilot-definitions.md`, and phase-1 code paths in `polyprep.analysis`. Every phase-1 test keeps passing.
- Team of 4: root `a1` plus exactly 3 copies `a2`–`a4`. Copies never get the `fork` tool (no recursive forks).
- Fork point: tokens charged to the pool ≥ `FORK_AT = 0.10` × pool, checked at the root's turn boundaries. Not tuned.
- `fork(directions)`: exactly 3 strings, each 1–300 characters after trimming, pairwise distinct (case-insensitive, after trimming).
- The root cannot claim before the fork: no `claim` tool before it; `claim` for all four agents after it.
- Fallback: if the root has not made a valid `fork` call within 2 model calls after the fork instruction, the runtime forks with `GENERIC_DIRECTION = "Take a different approach from your siblings."` for all three; the `fork` event has `fallback: true`.
- `fork`: after the fork, messaging tools only (send, publish, subscribe, roster); no blackboard, no norms. `fork-silent`: no communication tools. Both: the first claim ends the run, and agents are told so.
- Budgets as phase 1: pool 4 × B (bcp 80,000, math 38,000 per agent), reservations, 30-minute wall clock, per-call cap 32,768, `suites/sampling.json`.
- Seeds: agent with index i (a1 = 0) gets `cfg.seed * 100 + i`, as phase 1. The fake server maps requests to agents by `seed % 100`.
- Toolchain: npm 10 with `.npmrc legacy-peer-deps=true`; Python via `uv run --project prep`; grep is ugrep.

## Review Focus

1. The root ends a turn without a tool call before the fork. Expected: the runtime gives the fork instruction then (making the fork due early), not an `idle` that ends the run. Test in Task 4.
2. The root's fork turn also contains other tool calls (e.g. `fork` and `search`). Expected: every tool result of that turn is in the copies' context before their direction message, so the request pi sends is valid. Test in Task 5.
3. The root calls `fork` a second time after forking. Expected: an error result ("You have already forked."), no new agents. Test in Task 3.
4. A copy sends a message before a sibling has made its first call. Expected: the sibling receives it at its first turn boundary (all three are registered with the bus before any starts). Test in Task 5.
5. The run ends (wall clock, budget, a sibling's claim) while the fork is being created or a copy is starting. Expected: no copy makes a call after the end; each copy still gets exactly one `agent_finished`. Test in Task 5.

---

### Task 1: Schema — conditions and events

**Files:**
- Modify: `packages/schema/src/events.ts`
- Test: `packages/schema/src/events.test.ts`

**Interfaces:**
- Produces: `ConditionName` adds `"fork"`, `"fork-silent"`. New event `{ kind: "fork", t, agent: AgentId, call: Count, children: AgentId[] /* length 3 */, directions: string[] /* length 3 */, fallback: boolean }`. `agent` is the root; `call` is the index of the root's `model_call` that made the fork call, or of its last model call for a fallback. New event `{ kind: "runtime_note", t, agent: AgentId, text: string }`: a user message the runtime inserted into that agent's context.

- [ ] **Step 1: Write failing tests** `parses a fork event`, which accepts a valid fork event and rejects 2 children or 2 directions; and `parses a runtime_note event` and `accepts the fork and fork-silent condition names`.
- [ ] **Step 2: Run** `npx vitest run packages/schema`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the two `z.object` members to `Event` and the two names to `ConditionName`, with `children` and `directions` as `z.array(...).length(3)`.
- [ ] **Step 4: Run** `npx vitest run packages/schema && npx tsc --noEmit -p .`. Expected: PASS. Typecheck errors in exhaustive switches elsewhere are fixed in their owning tasks. Here, add a `default` case only where tsc requires it.
- [ ] **Step 5: Commit** `Schema: fork and fork-silent conditions; fork and runtime_note events`.

### Task 2: Conditions, prompts and fork texts

**Files:**
- Modify: `packages/runtime/src/conditions.ts`
- Create: `packages/runtime/src/fork/texts.ts`
- Test: `packages/runtime/src/fork/texts.test.ts`, `packages/runtime/src/comm/comm.test.ts`

**Interfaces:**
- Produces:
  - `Condition` gains `fork: boolean`. `CONDITIONS.fork = { n: 4, blackboard: false, messaging: true, norms: false, firstClaimEnds: true, fork: true }`. `CONDITIONS["fork-silent"]` is the same with `messaging: false`. The phase-1 entries get `fork: false`.
  - `PHASE1_CONDITIONS: ConditionName[]`, the five phase-1 names.
  - `FORK_AT = 0.10`, `MAX_DIRECTION_CHARS = 300`, `FORK_GRACE_CALLS = 2`, `GENERIC_DIRECTION`.
  - `systemPrompt(c, agentId, ids)` keeps its signature. For fork conditions it returns:
    - for `a1`, the pre-fork root prompt: it works alone first, will be told when to split the work with three copies of itself by calling `fork` with three different directions, and can claim only after the split;
    - for `a2`–`a4`, a copy's prompt naming the copy and its siblings; in `fork`, the messaging sentence of phase-1 polylogue-bare without its blackboard part; the team claim rule.
  - `rootPromptAfterFork(c, ids)`: the root's prompt after the fork. It replaces the system prompt by assigning `agent.state.systemPrompt`.
  - In `fork/texts.ts`:
    - `forkInstruction(): string`, the instruction to fork now;
    - `parentForkResult(children, directions): string`, the root's tool result for `fork`;
    - `childForkResult(childId): string`, the result a copy sees for the inherited fork call;
    - `directionMessage(direction): string`;
    - `fallbackNotice(children): string`, the root's note after a fallback.

  The wording is the builder's; Daniel reviews it before the pilot. These functions are pure, and Task 6 rebuilds contexts from them.

- [ ] **Step 1: Write failing tests:**
  - `fork prompts`: the a1 prompt contains "fork" and states that claiming opens after the split; copy prompts name the copy and its siblings; the `fork` copy prompt mentions `send` and does not mention `blackboard`; the `fork-silent` copy prompt mentions neither; both contain the team claim rule.
  - `phase-1 prompts are unchanged`: `systemPrompt` for the five phase-1 conditions (agent a2 of a1–a4) equals literal strings copied from the current output before any change.
  - `texts are deterministic`.
- [ ] **Step 2: Run** `npx vitest run packages/runtime/src/fork packages/runtime/src/comm`. Expected: FAIL.
- [ ] **Step 3: Implement** in `conditions.ts` and `fork/texts.ts`. `toolNames` stays as it is for phase-1 conditions. Fork tool sets are built in Task 4.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `Conditions: fork and fork-silent, prompts and fork texts`.

### Task 3: The fork tool and validation

**Files:**
- Create: `packages/runtime/src/tools/fork-tool.ts`
- Modify: `packages/runtime/src/run/context.ts`
- Test: `packages/runtime/src/tools/fork-tool.test.ts`

**Interfaces:**
- Consumes: `MAX_DIRECTION_CHARS` and `parentForkResult` (Task 2).
- Produces:
  - `validateDirections(x: unknown): { ok: true; directions: string[] } | { ok: false; error: string }`, which returns the directions trimmed.
  - `forkTool(agentId: string, ctx: RunContext): AgentTool`. Its name is `fork`; its parameters are `{ directions: string[] }`. On a valid call it calls `ctx.fork(agentId, directions, { fallback: false })` and returns `parentForkResult(...)`. On an invalid call, or once `ctx.forked()` is true, it throws, so the result is an error.
  - `RunContext` gains `fork(parent: string, directions: string[], o: { fallback: boolean }): string[]`, which returns the child ids, and `forked(): boolean`.

- [ ] **Step 1: Write failing tests:**
  - `validateDirections`: accepts 3 distinct strings; rejects 2 or 4 strings, an empty string, a 301-character string, and `["A", "a ", "b"]` as duplicates; trims.
  - `fork tool calls ctx.fork once`.
  - `a second fork call is an error`, matching `/already forked/` (Review Focus 3).
- [ ] **Step 2: Run** `npx vitest run packages/runtime/src/tools/fork-tool.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** using a fake `RunContext` in the test.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `Fork tool with direction validation`.

### Task 4: AgentLoop — the root's fork turn

**Files:**
- Modify: `packages/runtime/src/agent/agent-loop.ts`
- Test: `packages/runtime/src/agent/agent-loop.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `AgentLoopOptions` gains `initialMessages?: AgentMessage[]` (pi's `state.messages` copies the array) and `root?: { tools: { beforeFork: AgentTool[]; afterFork: AgentTool[] }; promptAfterFork: string }`.
  - `AgentLoop` gains `messages(): AgentMessage[]`, which returns a copy of `agent.state.messages`; `afterFork(): void`, which swaps in the after-fork tools and prompt; and `noteForRoot(text: string): void`, which queues a runtime note for the next turn boundary.
- Behaviour (root only):
  - At each turn boundary, it checks `ctx.controller.used >= FORK_AT * pool`. At the first boundary where this holds, it adds the `fork` tool to the current tools, logs `runtime_note { text: forkInstruction() }` and delivers it as a user message.
  - If the root ends a turn without a tool call before the fork, the instruction is given at that point (Review Focus 1).
  - After the instruction, if `FORK_GRACE_CALLS` model calls complete without a successful `fork` tool result, it calls `ctx.fork(id, [GENERIC_DIRECTION × 3], { fallback: true })`, then `afterFork()`, then `noteForRoot(fallbackNotice(children))`.
  - Runtime notes are delivered before any message block at the same boundary.
- `estimatePromptTokens`, admission and charging are unchanged.

- [ ] **Step 1: Write failing tests,** using the existing `team()` harness with a root-only fake team:
  - `the root has no claim tool before the fork`: the tool names in request 0 do not include `claim`.
  - `the fork instruction arrives at the first boundary at or past 10% of the pool`: pool 10,000; usage `{ in: 600, out: 100 }` per call. The instruction appears in request 2, not request 1, and a `runtime_note` is logged.
  - `a root that ends a turn without a tool call before the fork is told to fork` (Review Focus 1).
  - `fallback after two calls without a valid fork`: the policy ignores the instruction. `ctx.fork` is called with three generic directions and `fallback: true`.
  - `a malformed fork counts as one of the two calls`.
- [ ] **Step 2: Run** `npx vitest run packages/runtime/src/agent`. Expected: the new tests FAIL and the old ones PASS.
- [ ] **Step 3: Implement.** Use `prepareNextTurnWithContext` for the boundary check and for delivering notes. Swap tools and the prompt by assigning `agent.state.tools` and `agent.state.systemPrompt`.
- [ ] **Step 4: Run** all `packages/runtime` tests. Expected: PASS.
- [ ] **Step 5: Commit** `AgentLoop: forced fork turn, fallback, runtime notes`.

### Task 5: Run orchestration — growing the team

**Files:**
- Modify: `packages/runtime/src/run/run.ts`, `packages/runtime/src/tools/build-tools.ts`
- Test: `packages/runtime/src/run/run.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `buildForkTools(c, agentId, ctx, work, phase: "root-before" | "after"): AgentTool[]`. `root-before` gives `work`. `after` gives `work`, then `claim`, then `commTools` if `c.messaging`.
  - `runLoaded`, for `c.fork`, starts only `a1` and implements `ctx.fork`. `ctx.fork`:
    1. clones `a1.messages()`;
    2. for each child, appends `childForkResult` as the tool result of every fork tool call that has no result yet (none on a fallback), then `directionMessage(direction)`;
    3. logs `agent_started` for each child, then one `fork` event;
    4. constructs, registers (bus, controller) and only then starts the three loops, so their first calls come after all three are registered;
    5. calls `a1.afterFork()`.

    If `controller.ended` is set, it creates nothing and returns `[]`. `dir.ids()` returns the current team.
  - The phase-1 generic test loop `runs ${condition} end to end` iterates `PHASE1_CONDITIONS`.

- [ ] **Step 1: Write failing tests,** using a scripted fake policy that searches until it receives the fork instruction, then forks with three directions, after which a copy claims:
  - `fork runs end to end`: 4 `agent_started` events and one `fork` event; each copy's first request body has the root's messages as a prefix, then the fork result and its own direction; the first claim ends the run.
  - `fork-silent copies have no communication tools`.
  - `copies inherit every tool result of the fork turn` (Review Focus 2): the fork turn also calls `search`.
  - `a message sent before a sibling's first call is delivered` (Review Focus 4).
  - `no copy calls after the run ends during the fork` (Review Focus 5): the wall clock ends during the fork turn; the invariants hold and no request is made after `run_finished`.
  - `fallback fork run`: a `fork` event with `fallback: true`, and the copies' directions are generic.
- [ ] **Step 2: Run** `npx vitest run packages/runtime/src/run`. Expected: FAIL.
- [ ] **Step 3: Implement** in `run.ts`, `build-tools.ts`, and `cli.ts` if conditions are listed there.
- [ ] **Step 4: Run** `npx vitest run --exclude "**/node_modules/**" && npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `Run: fork and fork-silent teams that grow from one root`.

### Task 6: Context rebuild for forked agents

**Files:**
- Modify: `packages/runtime/src/agent/context.ts`
- Test: `packages/runtime/src/agent/agent-loop.test.ts` (the existing rebuild test) and `packages/runtime/src/run/run.test.ts`

**Interfaces:**
- Consumes: the `fork` and `runtime_note` events, and `childForkResult` and `directionMessage` (Task 2).
- Produces: `contextBeforeCall(events, agent, call)` that is correct for every agent of a fork run.
  - **Root:** `runtime_note` events add a user message at their position.
  - **Copy:** the system message is the copy's own `agent_started.systemPrompt`. It is followed by the root's context as it stood when the `fork` event was logged, minus the root's system message. Next come a tool result `childForkResult(copy)` for each unanswered fork tool call, then `directionMessage(direction)`, then the copy's own events.
  - **Root after the fork:** its system message for calls after `fork.t` is `rootPromptAfterFork(CONDITIONS[run.condition], ids)`. This is deterministic, so it needs no event.

- [ ] **Step 1: Write failing test** `rebuilds every agent's context in fork and fork-silent runs`: for every request the fake server recorded, `normalizeOpenAIMessages(request.body.messages)` equals `contextBeforeCall(events, agent, call)`. Include a fallback run and a run whose fork turn has two tool calls.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all runtime tests. Expected: PASS, including the phase-1 rebuild test.
- [ ] **Step 5: Commit** `Context rebuild for forked agents`.

### Task 7: Pilot report, P2 matrix, runbook

**Files:**
- Modify: `packages/runtime/src/batch/report.ts`, `docs/pilot-runbook.md`
- Create: `configs/pilot-p2.json`
- Test: `packages/runtime/src/batch/report.test.ts`

**Interfaces:**
- Produces: in the report, a `## Fork` section per suite and condition with:
  - runs that forked;
  - fallback forks;
  - runs that ended before the fork;
  - runs whose three directions are distinct (case-insensitive);
  - the median tokens used before the fork.

  The line `Fallback rate above 20%: STOP (spec §4.7)` is printed when fallbacks divided by fork-condition runs exceed 0.20; otherwise `Fallback rate: ok`.
- `configs/pilot-p2.json`: copy `configs/pilot-p1b.json` with name `pilot-p2`, conditions `["fork", "fork-silent"]`, seeds `[1, 2]`, split `pilot`, bcp 80,000 and math 38,000 per agent, `wallClockMs` 1,800,000. That makes 40 runs.
- Runbook: a "Phase 2" section with the P2 command (into `data/pilot-p2.sqlite`), the go/no-go reading of the Fork section, prompt review by Daniel before the pilot, the pre-registration (`preregistrations/08-polylogue-forking.md`) before the main run, and the main matrix `configs/phase2.json` (`fork`, `fork-silent`, `isolated`; `scored`; seeds `[1, 2]`; 360 runs) written at the freeze.

- [ ] **Step 1: Write failing tests** `reports fork, fallback and distinct-direction counts` and `flags a fallback rate above 20%`, on synthetic logs with the existing `fakeRun` helper extended to emit `fork` events.
- [ ] **Step 2: Run** `npx vitest run packages/runtime/src/batch`. Expected: FAIL.
- [ ] **Step 3: Implement,** and write the config and the runbook section.
- [ ] **Step 4: Run** the batch tests, including a new test `pilot-p2 matrix expands to 40 cells`, which parses `configs/pilot-p2.json` with `Matrix` and expands it with 5 pilot tasks per suite. Expected: PASS.
- [ ] **Step 5: Commit** `Pilot P2: fork section in the report, matrix, runbook`.

### Task 8: Viewer — show the fork

**Files:**
- Modify: `packages/viewer/src/state.ts`, `packages/viewer/src/views/TeamGraph.tsx`, `packages/viewer/src/views/Swimlanes.tsx`, `packages/viewer/src/sim.ts`
- Test: `packages/viewer/src/state.test.ts`, `packages/viewer/src/sim.test.ts`

**Interfaces:**
- Produces:
  - `ViewState` gains `forks: { parent: string; children: string[]; t: number; fallback: boolean }[]`.
  - `Lane.marks` kinds gain `"fork"`. The parent's lane gets a mark at `fork.t`.
  - `TeamGraph` draws a dashed parent-to-child edge for each fork.
  - `sim.ts` can generate a fork run (`simulate({ condition: "fork" })`, or the existing option shape).

- [ ] **Step 1: Write failing tests:**
  - `stateAt shows copies only after the fork`: 1 agent before `fork.t` and 4 from `fork.t` on.
  - `fork marks the parent lane`.
  - `the simulated fork run is valid against the schema`.
- [ ] **Step 2: Run** `npx vitest run packages/viewer`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the viewer tests and `npm run test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `Viewer: fork branch points`.

### Task 9: Analysis — phase-2 hypotheses and mechanism check

**Files:**
- Modify: `prep/polyprep/analysis.py`
- Test: `prep/tests/test_analysis.py`

**Interfaces:**
- Consumes: the `fork` events in the log.
- Produces: `analyse()` detects phase 2 when the matrix conditions include `"fork"`. It then writes a phase-2 block instead of the phase-1 H-block. The phase-1 path is unchanged.
  - **F1, bcp:** `paired_diff(fork, isolated)` by first claim. Verdict via `fork_verdict(d) -> "FORKING HELPS" | "FORKING HURTS" | "NO GAIN"`:
    - HELPS when the effect is ≥ 10 and `lo` > 0;
    - HURTS when `hi` < 0;
    - otherwise NO GAIN.
  - **F2:** `paired_diff(fork, fork-silent)` over both suites. `talk_verdict(d) -> "TALK ADDS" | "NO GAIN"`, with the same bar as HELPS.
  - **F3:** `_h3` generalised to any pair of conditions: `_domain(runs, a, b)`.
  - **Holm** over the McNemar p of F1 and F2 and the one-sided p of F3.
  - **Mechanism check,** per suite and condition:
    - duplicate reads and duplicate code over the whole run (existing functions);
    - `post_fork_duplicate_reads(events)` and `post_fork_duplicate_python(events)`, counting only calls after the `fork` event but matching against everything read or run before it;
    - fork rate, fallback rate, runs that ended before the fork, and distinct-direction rate.
  - **Cost:** tokens per solved task for `fork` / `isolated`.
  - `CONDITIONS` in the module adds `"fork"` and `"fork-silent"`.

- [ ] **Step 1: Write failing tests:**
  - `fork_verdict` at its boundaries: (10.0, 0.1, 20) is HELPS; (10.0, 0.0, 20) is NO GAIN; (−12, −20, −0.1) is HURTS; (−12, −20, 0.0) is NO GAIN.
  - `talk_verdict` boundaries.
  - `post-fork duplicates count reads of documents the root read before the fork`.
  - `phase-2 analysis on a synthetic log`: three conditions, all cells present, verdict keys `F1`, `F2`, `F3`, and `holm` with three entries.
  - `the phase-1 analysis output is unchanged`: the P1b reproduction test still passes, and a phase-1 synthetic analysis has no F-keys.
- [ ] **Step 2: Run** `uv run --project prep python -m pytest -q prep/tests/test_analysis.py`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole prep suite. Expected: PASS.
- [ ] **Step 5: Commit** `Analysis: phase-2 hypotheses F1–F3 and fork mechanism check`.
