# Polylogue runtime and viewer: design

**Date:** 2026-10-11 · **Status:** approved by Daniel, 2026-10-11
**Scope:** IDEA.md §10 steps 1–3: event schema and agent loop, message bus with communication tools and an N-agent scheduler, and a viewer built against a simulated event stream.
**Inputs:** `IDEA.md` (research question, hypotheses, system design) and pre-registration draft 7 in the agent-engineering repo (`docs/experiments/drafts/07-multi-agent-communication.md`): five conditions, N = 4, equal total compute, verification outside the agents.

## 1. Goal and success criteria

Build a runtime that can run every phase-1 condition with N = 4 agents on the pinned Qwen3.8-27B, record every event in SQLite, and show a run live or as a replay.

Done means:

1. A scripted fake model drives all five conditions end to end on a toy task, and the tests in §8 pass.
2. Every agent's model context can be rebuilt from the event log alone, and a test checks that the rebuilt context equals what was sent.
3. The viewer replays a simulated run in all five views, and the scrubber changes what is shown.
4. A live smoke run against a real vLLM server happens after the build, only once Daniel has approved which Spark to use. It is not part of this spec's acceptance.

## 2. Decisions already made

| Decision | Ruling | Source |
|---|---|---|
| Model | Pinned Qwen3.8-27B (as in Tree RAG) | Daniel, D1, 2026-10-11 |
| `polylogue-bare` | In phase 1 | Daniel, D3, 2026-10-11 |
| Scope | Runtime and viewer only. Task suites, verifiers and the pilot get their own spec after D2 (research suite) | Daniel, 2026-10-11 |
| `fork(task)` | Not built in phase 1: it changes team size mid-run and breaks the equal-compute comparison | Daniel, 2026-10-11 |
| Tool calls | Native OpenAI-style tool calls. The server needs `--enable-auto-tool-choice` and a Qwen tool-call parser; Daniel checks the flags after the Tree RAG run | Daniel, 2026-10-11 |
| Process model | One Node process, with the agents as async tasks; the bus is in-process and written synchronously to SQLite | Daniel, design section 1 |
| Claims | One blind claim per agent | Daniel, design section 2 |
| Agent loop | pi: `@earendil-works/pi-agent-core` + `pi-ai`, pinned at 1.1.0. Not Pi Durable: it is experimental ("API changes without notice"), its crash recovery is not needed for ~10-minute runs, and its own compaction and transcript store would compete with our log | Daniel, 2026-10-11 |

## 3. Architecture

TypeScript monorepo (npm workspaces), Node 22.

```
packages/schema    Event and run types, zod validators. Shared by runtime and viewer.
packages/runtime   CLI: `polylogue run <config>` and `polylogue serve <db>`
  model/           pi-ai provider for the Spark (OpenAI-compatible), pinned settings
  log/             EventLog: append-only SQLite (runs, events); inbox cursor per agent
  agent/           AgentLoop: wraps one pi `Agent`; maps pi events to log events; delivery
  tools/           communication tools, claim, WorkTool interface
  control/         Controller: token pool, wall-clock limit, rate limits, verifier, stop
  conditions/      the five conditions as data (tool set, prompt, N)
  toy/             toy parallel task and verifier
  server/          read-only HTTP: replay JSON and SSE
packages/viewer    Vite + React + React Flow; replay or live; event simulator
```

Each unit has one job and a small interface:

- **Model provider** (`model/`): a pi-ai `createProvider` for the Spark with `api: openai-completions` and `compat: {supportsDeveloperRole: false, supportsReasoningEffort: false}`. The stream function fixes temperature 0 and adds `seed` and `chat_template_kwargs` (reasoning effort as in Tree RAG) through pi-ai's `onPayload`. The run checks the server's model list against the pinned model and revision before starting. Tests point the same provider at a **fake OpenAI-compatible server** that replays a scripted policy per agent and records every request body, so tests exercise pi's real request path.
- **EventLog**: `append(event) → seq`, `events(runId, fromSeq?)`, `subscribe(runId, fn)`. It is the only writer, and it never updates or deletes rows.
- **AgentLoop**: wraps one pi `Agent` (`toolExecution: "sequential"`, `steeringMode: "all"`, `followUpMode: "all"`, no `transformContext`). It subscribes to pi's events and writes them to the log (`message_end` → `model_call`, `tool_execution_start`/`_end` → `tool_call`/`tool_result`). Pi's hooks carry the control rules: `prepareRequest` asks the controller before every model request (throwing ends the agent without a request), `finishTurn` returns `end` after `claim`. It does not know which condition it is in, only which tools and system prompt it was given.
- **Controller**: decides whether a model call may run (pool and limits), applies rate limits, sends claims to the verifier and stops the run.
- **Clock**: injected. Wall-clock in real runs, fake in tests.

## 4. Conditions

A condition is data: which tools the agents get, whether the protocol norms (IDEA §5) are in the system prompt, and N. The agent loop, model settings and task prompt are identical across conditions, so conditions differ only where intended.

| Condition | N | work + `claim` | blackboard (`read_blackboard`, `append_blackboard`) | `send`, `publish`, `subscribe`, `roster` | norms in prompt |
|---|---|---|---|---|---|
| `single` | 1 | ✓ | | | |
| `isolated` | 4 | ✓ | | | |
| `stigmergic` | 4 | ✓ | ✓ | | |
| `polylogue` | 4 | ✓ | ✓ | ✓ | ✓ |
| `polylogue-bare` | 4 | ✓ | ✓ | ✓ | |

`subscribe(topic)` is the one tool not named in IDEA §5. It is needed so that `publish` reaches only interested agents. Every agent is subscribed to `all` at start.

## 5. Agent loop and control rules

**Turn.** Deliver the inbox → one model call → run that call's tool calls in order → repeat (pi's loop). A model reply with no tool call makes the agent **idle**: it makes no model calls until a message is delivered to it.

**Delivery.** Messages are delivered only at turn boundaries, never during a model call or a tool call. To a working agent they go through pi's `steer` (injected after the current tool round, before the next request); to an idle agent through `followUp` plus `continue()`, which wakes it. A message that arrives during a long tool call is queued until the call finishes. Pending messages are delivered as one block, `urgent` ones first, and a `message_delivered` event is logged for each. (Checked offline against pi 1.1.0 on 2026-10-11: a message steered during a slow tool appeared after the tool result in the next request, and `followUp` woke an idle agent.)

**Waiting.** There is no `wait` tool: an agent waits by ending its turn. Any message delivered to it (direct, or on a subscribed topic) wakes it, with a `wake` event. In `single`, `isolated` and `stigmergic` nothing can wake an idle agent, so idle there means finished. If every unfinished agent is idle and no message is pending, the run ends unsolved (`all_idle`), since nothing else can happen.

**Claims.** `claim(answer, evidence)` submits the agent's final answer. Each agent may claim once, and claiming ends the agent. The agent is told only that the claim was submitted, not whether it passed, so it cannot guess repeatedly against the answer key. The verifier runs outside the agents. The first passing claim ends the run as solved; every claim and its verification are logged (claims per run and the false-claim rate are reported, draft 7 §8).

**Budget.** The team shares one token pool: B for `single`, N·B for the others (draft 7 §5). Each model call is charged prompt plus completion tokens as the server reports them, so messages cost tokens by entering contexts. The controller checks the pool before each call. If the pool is empty, `prepareRequest` refuses the call (no request is sent) and the run ends unsolved with reason `budget`. Calls already in flight finish, are charged and are logged.

**Limits.** A global wall-clock limit ends the run (`killed`). An agent whose next prompt would exceed the model's context ends (`context`). There is no context compaction in phase 1.

**Rate limits.** Messages per agent per minute, and a maximum message length. A message over either limit is rejected with a tool error, which is logged. The values are configurable and get frozen after the pilot, before any scored run.

**Run end.** A run ends at the first verified claim (`solved`), when the pool is empty, at the wall-clock limit, when every agent has finished or is idle with nothing pending (`all_idle`), or on an infrastructure failure.

**Reasoning in context.** pi sends earlier turns' reasoning back to the server as `reasoning_content`; the chat template decides what the model sees. This is the same in every condition and is recorded, not changed.

**Seeds.** Agent i's seed is `runSeed · 100 + i`. The run row records model, revision, sampling settings and seeds.

**Failures.** Transport errors are retried with backoff. Once the retries are exhausted, the run ends with status `infra_error` (draft 7 §7 reruns these once, then counts them as unsolved).

## 6. Event log

SQLite file, two tables:

- `runs`: id, condition, n, task_id, seed, model, revision, sampling (JSON), config hash, git SHA, status (`running`/`solved`/`unsolved`/`infra_error`), end reason, started_at, ended_at.
- `events`: run_id, seq (gap-free per run), t (ms since run start), kind, payload (JSON). Append-only.

Event kinds are the IDEA §5 sketch plus four: `tool_result`, `message_delivered`, `wake`, `claim_submitted` (separate from `verification`). `agent_finished.reason` adds `context` to IDEA's list, and `run_finished` carries the end reason (`solved`, `budget`, `killed`, `all_idle`, `infra_error`). `model_call` stores the assistant output (content, reasoning, tool calls) and token usage, but not the prompt. The prompt is rebuilt from the system prompt, the task and the agent's events. A test checks that this rebuilt context equals the request body the fake server received.

All events are validated with the zod schema on write and on read.

## 7. Server and viewer

**Server.** `polylogue serve runs.sqlite` is read-only and serves three endpoints:

- `GET /runs`: the run list
- `GET /runs/:id/events`: the full log, for replay
- `GET /runs/:id/stream`: SSE that follows a running run

It binds to localhost by default; Tailscale access is opt-in with a flag. There is no auth.

**Viewer.** Vite + React + React Flow. The whole view is a pure function `stateAt(events, t)`. Live mode and replay use the same code: live mode follows the newest event, replay sets `t` from the scrubber. The views:

- **Team graph:** agents as nodes with their status lines; messages as edges that briefly highlight. It shows who talks to whom and whether a hierarchy emerges.
- **Swimlanes:** one per agent, showing thinking, tool calls, waiting and messages.
- **Chat feed:** all messages in one channel.
- **Blackboard:** the current contents and their history.
- **Counters:** tokens per agent and against the pool, wall-clock time, messages per minute.
- **Replay scrubber.**

**Simulator.** A seeded generator of plausible event streams for each condition. Its output is valid schema events. The viewer is built against it first (IDEA §10 step 3), and it doubles as a test fixture.

## 8. Testing

Vitest throughout. Runtime tests run pi against the fake OpenAI-compatible server with scripted per-agent policies, so they are deterministic. Required tests:

- Each condition runs end to end on the toy task, with the right tool set and with norms present or absent in the prompt.
- Messages are delivered only at turn boundaries, including during a long tool call; `urgent` ones come first in the block.
- An idle agent wakes on a direct message and on a subscribed topic, not on other topics; all agents idle with nothing pending ends the run (`all_idle`).
- One blind claim per agent: a second claim is rejected, a failed claim tells the agent nothing, and the first passing claim stops the run.
- Pool exhaustion, the wall-clock kill, the context limit, rate limits and `infra_error` after retries.
- Every agent's context rebuilt from the log equals the request body the fake server received.
- Each request carries temperature 0, the agent's seed and the pinned `chat_template_kwargs`.
- Schema round trip: write, read, validate.
- `stateAt` unit tests (graph, lanes, counters at given times).
- One Playwright check: the viewer loads a simulated run, renders all views, and moving the scrubber changes the counters.

The toy task spreads facts over shards that a `read_shard` work tool returns. The answer needs facts from several shards, so it can be split up among agents. It also serves the later live smoke run.

## 9. Out of scope

`fork`; Pi Durable; task suites and verifiers beyond the toy one (separate spec after D2); context compaction; tuning for N > 4; auth on the server; the frontier verifier (D4); any scored run.

## 10. Open items for later specs

- D2: the high-parallelism suite (BrowseComp-Plus or another offline set).
- D4: a frontier model as an independent verifier.
- Pilot definitions frozen before the main run: "substantive message", "duplicate work", the rate-limit values and the budget B.
- ~~Server flags and a live check of pi-ai against vLLM~~ **Done 2026-10-11 on zgx-40dd** (pinned image and revision, launch flags as `serving/gb10/qwen38-27b.sh` in the experiments repo, which include `--enable-auto-tool-choice --tool-call-parser=qwen3_coder`): tool calls parsed, usage reported, reasoning returned, `store: false` accepted, and a message steered during a 1.5 s tool call arrived after the tool result in the next request.
