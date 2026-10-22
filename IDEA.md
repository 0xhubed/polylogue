# Multi-Agent Communication: Project Idea

> **Working title:** `polylogue` (a conversation among many)
> **Tagline:** Does inter-agent communication improve solve rate and time to solution?
> **Status:** Idea / design. Home-lab experiment, not a company project.

---

## 1. Research question

When N agents work on the same problem in parallel, does letting them **talk to each other** make them better than the same N agents working in isolation?

"Better" means three separate claims, which are measured separately:

| Claim | Metric |
|---|---|
| Solves **more** | Solve rate at a fixed budget |
| Solves **faster** | Wall-clock time to a *verified* solution |
| Solves **more cheaply** | Tokens to solution |

The framing comes from **Brooks's law** ("adding people to a late project makes it later," because communication channels grow quadratically) and **Amdahl's law** (the serial fraction limits parallel speedup). The question is whether either law holds for LLM agents.

---

## 2. Motivation: Noam Brown on the Dwarkesh Podcast

Noam Brown (OpenAI) describes a multi-agent system used, among other things, on a Millennium Prize problem (10,000 agents, ~130B tokens, ~88 hours). The claims relevant here:

- **Multi-agent is parallel test-time compute.** Reasoning models scale compute serially and hit a latency wall. Multi-agent scales it in parallel. This is less efficient, but faster.
- **Measured scaling:** on some benchmarks, 4 agents finish about **2× faster**. That means paying about 2× the cost for 2× the speed. At 16 agents it's slightly less efficient again, so scaling is sublinear.
- **Domain matters:** deep research and web search parallelize extremely well, math parallelizes well, and writing a novel hardly parallelizes at all.
- **No scaffold.** They avoid coordinator→child hierarchies. Two problems with those hierarchies:
  1. Children working on overlapping tasks can't talk to each other.
  2. A child with a clarification question must choose between returning to ask or guessing.
- **Primitive tools instead.** Agents get a tool to message any other agent, and the message is inserted into the recipient's context. Agents figure out coordination themselves. Emergent behavior includes peer review: two agents disagree, explain their reasoning, converge, and broadcast the correction.
- **Forking:** sub-agents start with a forked copy of the parent context, not a task description.
- **Coordination doesn't come for free.** Untrained, agents collapse into "everyone solves it independently," which is a local minimum. Good coordination comes from training.
- **Big caveat:** Brown gives multi-agent **less than 10% of the credit** for the result. The main driver is a very strong base model.
- **No control experiment** at scale. Single-agent and 1,000-agent baselines are too expensive to run.

Related: the Dwarkesh episode "The rise and fall of agent civilizations" (Aug 2026) covers the Hugging Face incident, where agents spontaneously communicated, formed hierarchies ("middle management"), and never alerted human operators. This shows that **peer communication is also a governance and safety concern**, not just a performance feature.

---

## 3. Hypotheses

- **H1 (speed):** On parallelizable tasks, N communicating agents reach a verified solution faster than N isolated agents.
- **H2 (quality):** At a fixed budget, communication improves solve rate, not just speed.
- **H3 (domain):** The benefit of communication increases with task parallelizability. It's high for research and search, medium for math and puzzles, and close to zero for coherent writing or design.
- **H4 (untrained collapse):** With off-the-shelf models (no coordination RL), agents mostly ignore the messaging tool and collapse into independent solving, unless norms and a shared blackboard push them toward coordination.
- **H5 (cost):** Token cost grows superlinearly with N under all-to-all messaging, and roughly linearly with topic-based or blackboard communication.

---

## 4. Experimental design

### Conditions (same model, tools and budget in every condition)

| Condition | Description |
|---|---|
| `single` | 1 agent. Baseline. |
| `isolated` | N agents in parallel, no communication. Isolates the effect of pure parallelism. |
| `stigmergic` | N agents with a shared blackboard (`findings.md`) only. Indirect coordination through traces. |
| `polylogue` | N agents with direct messaging plus the blackboard. |

Separating `stigmergic` from `polylogue` distinguishes **shared knowledge** from **conversation**.

N ∈ {1, 4, 8, 16}, with multiple seeds per cell to measure variance.

### Task suites (public, with known answers, verified automatically where possible)

| Parallelizability | Example task types |
|---|---|
| High | Multi-source research questions, search problems |
| Medium | Math and puzzle tasks with checkable answers |
| Low | Coherent long-form writing, architecture design (judged by rubric or a separate judge) |

### Metrics

- **Primary:** solve rate at a fixed budget, wall-clock time to a verified solution, tokens to solution.
- **Secondary:** messages per agent, idle and wait time, duplicate work (agents solving the same subproblem), wrong-consensus rate, time to first useful message.

### Known failure modes to watch

- Collapse into independent solving
- Message storms
- Deadlocks from agents waiting on each other
- Wrong consensus (a confident but wrong agent persuades the group)
- Context bloat from re-reading chatter

---

## 5. System design

### Principles

- **Primitive tools, minimal structure:** follow Brown's approach, but compensate for the missing coordination training with explicit norms.
- **The event log is the source of truth.** Every message, tool call, claim and status change is an append-only event. That gives replay, debugging, metrics and an audit trail for free.
- **Own the orchestration, keep the agent loop swappable.** The bus, scheduler, budgets and event log are the part worth owning. The agent loop is a commodity and sits behind a small interface.

### Components

- **Agent:** a loop with its own context, an inbox (a cursor into the event log), and a status line ("working on X, found Y").
- **Message bus:** an append-only log (SQLite) with an inbox cursor per agent.
- **Delivery:** at turn boundaries (between tool calls), never mid-reasoning. An `urgent` flag lets critical messages jump the queue (e.g. "stop, X is already solved").
- **Scheduler:** runs N agent loops concurrently and wakes waiting agents when messages arrive.
- **Control layer (outside the agents):** token budget per agent, global wall-clock budget, rate limits against message storms, and termination as soon as a result passes independent verification.

### Primitive tools (deliberately few)

| Tool | Purpose |
|---|---|
| `send(to, msg)` | Direct message |
| `publish(topic, msg)` | Topic broadcast, which keeps message volume roughly linear instead of all-to-all |
| `roster()` | Who exists, plus everyone's status line |
| `fork(task)` | Sub-agent started with a copy of the context |
| `wait(until_message \| timeout)` | Block without burning tokens |
| Work tools | Shell, files, search; one git worktree per agent for code tasks |

### Protocol norms (in the system prompt, since we can't train them in)

1. Start by publishing a one-line plan on `#all`, then check `roster()` and `findings.md` before starting work. (Kickoff added 2026-10-16: in pilot P1 no agent sent a message on `bcp` or `math`.)
2. Every claim comes with evidence: a test, a log line, a reference or a derivation.
3. Ask instead of guessing. If there's no answer before a timeout, make an assumption and document it.
4. Share conclusions, not reasoning traces ("X ruled out, reason Y").

### Event schema (sketch)

```ts
type AgentId = string;

type Event =
  | { kind: "agent_started";  t: number; agent: AgentId; parent?: AgentId; condition: string }
  | { kind: "status";         t: number; agent: AgentId; text: string }
  | { kind: "model_call";     t: number; agent: AgentId; tokensIn: number; tokensOut: number; ms: number }
  | { kind: "tool_call";      t: number; agent: AgentId; tool: string; args: unknown; ms: number }
  | { kind: "message";        t: number; from: AgentId; to: AgentId | { topic: string }; text: string; urgent?: boolean }
  | { kind: "blackboard";     t: number; agent: AgentId; diff: string }
  | { kind: "claim";          t: number; agent: AgentId; answer: string; evidence: string }
  | { kind: "verification";   t: number; claimOf: AgentId; passed: boolean; detail?: string }
  | { kind: "agent_finished"; t: number; agent: AgentId; reason: "solved" | "budget" | "killed" | "idle" }
  | { kind: "run_finished";   t: number; solved: boolean; wallMs: number; totalTokens: number };
```

The same types are shared by the runtime and the frontend.

---

## 6. Frontend: watching the teamwork

The frontend is a viewer on the event stream: live over WebSocket or SSE, and replay from SQLite.

- **Team graph:** agents as nodes with live status lines, messages as animated edges. Shows who talks to whom and whether hierarchy emerges.
- **Swimlanes:** a timeline per agent showing thinking, tool calls, waiting and messages. Shows idle time and duplicate work.
- **Chat feed:** all messages as one Slack-like channel.
- **Blackboard view:** the current `findings.md` plus its change history.
- **Counters:** tokens per agent, wall-clock time, messages per minute.
- **Replay scrubber:** a time slider to step through a finished run. This is where most of the insight will come from.

---

## 7. Stack and infrastructure

- **Language: TypeScript end to end.** The orchestrator is I/O-bound, since the bottleneck is inference, not the runtime. TypeScript gives one shared event schema for backend and frontend, a natural async model, and a first-class SDK ecosystem. C++, Rust and Julia would optimize the wrong thing.
- **Own runtime rather than deepagents.js.** Its `task` sub-agent model is exactly the coordinator→child scaffold being tested against. A minimal custom loop gives full control over message delivery, interrupts and sleep/wake.
- **Inference:** the two DGX Sparks running vLLM or SGLang with continuous batching, which suits many parallel agents well. Tokens cost electricity, not API fees.
- **Control plane:** the ThinkCentre runs the orchestrator, event log and frontend. Everything is networked over Tailscale.
- **Optional:** a frontier model via API as an independent verifier that never sees the solving process.
- **Frontend:** React, plus React Flow for the team graph.

---

## 8. Out of scope for now / later experiments

- **zerolang** ([vercel-labs/zerolang](https://github.com/vercel-labs/zerolang)) as an agent **workspace**: graph-native code with checked patches that reject stale edits, which is essentially optimistic concurrency for multi-agent editing. It's interesting as a second variable ("do agents collaborate better on a graph than on text?") but only after the communication effect is measured on normal tasks. It's experimental and models have little training data on it.
- **Git as the workspace, on an artifact suite (phase-2 candidate, 2026-10-11):** a suite whose output is something built over time (code, or a document), with a shared branchable Git repository as the workspace, as in GitSwarm (arXiv:2610.04862). On that suite, a `gitswarm` condition (shared repo, no messaging) can be added next to the existing ones, asking whether structured shared memory beats a blackboard and whether it beats talking. Phase 1 stays as designed: its tasks end in a short answer, where branches add little over the blackboard. Plain Git is the conventional version of the zerolang idea above.
- **A designed division-of-labour suite (`ledger`), dropped from phase 1 (2026-10-15):** record collections whose aggregation questions need the whole collection read. Calibration showed that the runtime's full-context charging makes coordination expensive. One agent reads 54–80 documents within B. A four-agent team divided the reading, but each poll for the others' results re-charged its whole context, so it covered only 92–100 documents and ran out of its pool during aggregation. A phase-2 version needs a different cost model, or a workspace where results don't sit in every agent's context (shared files, the Git workspace above), or tasks whose parts can be reported in a few lines.
- RL training of coordination behavior.
- Any company use.

---

## 9. Open questions

- Which open-weights model or models to run on the Sparks, and how many parallel agents they can serve at acceptable latency.
- Message delivery during long tool calls: queue until the call finishes, or interrupt?
- How to measure "duplicate work" automatically.
- How to verify answers on low-parallelizability tasks without a biased judge.
- Whether forking with a full context copy is affordable on local hardware.

---

## 10. Next steps

1. Event schema and a minimal agent loop (one agent, one task, events into SQLite).
2. Message bus, communication tools and the scheduler for N agents.
3. Frontend prototype on a **simulated** event stream, to design the views before the runtime is done.
4. First task suite (one per parallelizability tier) plus verifiers.
5. Pilot run: `single` vs. `isolated` (4) vs. `stigmergic` (4) vs. `polylogue` (4).
6. If messaging shows an effect, scale N and write it up for agent-engineering.ch.

---

## References

- Dwarkesh Podcast, interview with Noam Brown on multi-agent systems (2026). [Substack note](https://substack.com/@dwarkesh/note/p-216149332)
- Dwarkesh Podcast, "The rise and fall of agent civilizations" (Aug 31, 2026). [Summary](https://www.teahose.com/podcast/Dwarkesh/The%20rise%20and%20fall%20of%20agent%20civilizations)
- Anthropic, "How we built our multi-agent research system" (2025): multi-agent setups use roughly 15× the tokens of a chat. [Link](https://www.anthropic.com/engineering/multi-agent-research-system)
- F. P. Brooks, *The Mythical Man-Month* (1975): Brooks's law.
- G. Amdahl (1967): Amdahl's law.
- [vercel-labs/zerolang](https://github.com/vercel-labs/zerolang)
- K. Dunas, "On the Nature of the Swarm" (Prime Intellect, Oct 6, 2026): essay, no experiments. Argues that multi-agent is structured inference scaling, that persistent agents add roughly one context window each when a task splits into parts that communicate in short messages, and that a tree routes every conversation through its root while a mesh does not. Two consequences for this project: some tasks should need more evidence than one window holds (task-suite spec), and a coordinator-led tree condition is a phase-2 candidate. [Link](https://www.primeintellect.ai/blog/on-the-nature-of-the-swarm)
- V. Shah, A. Samanta, … A. Goyal, "GitSwarm: Decentralized Compounding Inference" (Meta Superintelligence Labs, Mila et al., arXiv:2610.04862, Oct 4, 2026). Identical workers without roles coordinate only through a shared branchable Git repository; every commit declares what it builds on (`informed_by=`). There is no messaging and no planner, so it is a large-scale `stigmergic` condition. Gains come from combining work across branches; on code 95% of contributions are reused later, while on proofs later workers mostly select among existing candidates. Baselines are a single agent prompted to continue, not N isolated agents, compute is not matched, and best-of-N with an oracle verifier reaches the same ceiling on proofs. Consequences here: it leaves the `isolated` comparison open, it supports H3 (math gains least), and its `informed_by` links and the one-in-six workers who abstain after finding equivalent work are a model for the pilot's "substantive message" and "duplicate work" measures (measured from the log, not added as a tool field). [Link](https://arxiv.org/abs/2610.04862)
