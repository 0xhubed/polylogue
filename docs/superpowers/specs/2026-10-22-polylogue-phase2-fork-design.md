# Polylogue phase 2: forking — design

**Date:** 2026-10-22 · **Status:** approved by Daniel, 2026-10-22 (after a builder check)
**Inputs:** phase-1 results (`agent-engineering-experiments/results/polylogue`, verdict ONLY PARALLELISM); Noam Brown's account of OpenAI's multi-agent system (IDEA §2); this conversation (Daniel, 2026-10-22).

## 1. Intent

Phase 1 found that four Qwen3.8-27B agents that can message each other do not beat four agents working alone at the same budget, and that they barely used the channel. All four agents started from the same prompt and did the same thing: about 40% of the documents an `isolated` team read were read by two or more of its agents, and 29 of the 30 unsolved `isolated` runs on bcp ended because the budget ran out.

Brown's system does two things phase 1 did not: agents **fork** (a helper starts as a copy of its parent's full context, not from a task description), and there is **no coordinator**, only flat messaging. Brown also says that good coordination comes from training and that untrained agents collapse into independent solving, which is what phase 1 measured.

Phase 2 tests the forking half of Brown's design on the same untrained model: **do helpers that start from a shared understanding, with directions the agent chose itself, beat four independent starts at the same budget?** Training comes later (phase 3: fine-tuning on successful team runs, then RL only if fine-tuning shows a signal).

## 2. Goals, non-goals, anti-goals

**Goals**
- A `fork` condition and a `fork-silent` control, run against a fresh `isolated` baseline on the phase-1 tasks, pre-registered before the scored run.
- A clean answer to the primary question, plus a mechanism check (did forking reduce duplicated work?).

**Non-goals**
- When to fork as the agent's own decision (fixed in this phase; a later variant or phase 3).
- Forks that fork again, teams larger than 4, a coordinator that assigns tasks, any training.
- New task suites.

**Anti-goals** (would make phase 2 a failure even if everything runs)
- A `fork` condition in which forking mostly does not happen, so that it degenerates into one agent with four times the budget (phase 1's lesson: this model does not use optional coordination tools).
- Tuning anything on outcomes: the fork point and prompts are fixed before the pilot, and the pilot checks only that the mechanics work.
- Changing any frozen phase-1 artifact.

## 3. Conditions (Daniel, 2026-10-22)

| Condition | What it is |
|---|---|
| `fork` | One root agent works alone; at a fixed point it must fork into 3 copies with directions it writes itself; the 4 agents then work on with flat messaging. |
| `fork-silent` | The same fork, but no messaging after it. Same claim rule as `fork` (the agents are told the first claim is the team's answer), so the only difference from `fork` is messaging. Separates the shared start from talking afterwards. (my call) |
| `isolated` | As in phase 1 (4 agents, no contact, scored by first claim; best-of-4 as a reference). Rerun so all three conditions share one runtime version and the same days. |

## 4. The fork mechanism (Daniel agreed: forced timing, agent-written directions)

1. **Root alone.** The run starts with one agent, `a1`, with the work tools only. **It cannot claim before it has forked** (Daniel, 2026-10-22): `claim` becomes available to all four agents after the fork. So forking always happens. If `a1` already has an answer at the fork point, its directions can be ways to check it (Brown's peer review). Its system prompt says it will split the work with three copies of itself and that claiming opens after the split. In phase-1 `single` runs, 27% of math runs and 17% of bcp runs had claimed by the time they used 10% of a team pool, so without this rule those runs would never have forked.
2. **Fork point.** When the tokens charged to the pool reach **10% of the pool** (bcp: 32k of 320k; math: about 15k of 152k), the runtime, at `a1`'s next turn boundary, tells it to fork now and gives it the `fork` tool. The 10% is fixed a priori and is not tuned in the pilot.
3. **The fork call.** `fork(directions)` takes exactly 3 directions, each one short paragraph (at most 300 characters), and they must differ. `a1` chooses them, for example one clue each or one hypothesis each.
4. **Copies.** Agents `a2`–`a4` each start with `a1`'s full message history up to and including the fork call, plus their own direction as a new user message, and a system prompt that names them, their siblings, and (in `fork`) the messaging tools. `a1` gets a tool result listing the three directions and continues as the fourth agent.
5. **After the fork.** `fork`: messaging tools only (send, publish, subscribe, roster). There is no blackboard, unlike phase-1 `polylogue-bare`, and no norms, because Brown uses primitive tools and no rules. The messaging prompt drops its blackboard sentence. `fork-silent`: no communication tools.
6. **Budget and end.** One pool of 4 × B for the whole run, B as in phase 1 (bcp 80k, math 38k per agent), with reservations as in phase 1; `a1`'s pre-fork tokens count against it. Copies re-reading the inherited context is part of the cost of forking and is charged. The first claim ends the run. 30-minute wall clock, per-call cap 32,768, same sampling and model.
7. **Edge cases (my calls):**
   - `a1` does not call `fork` within 2 calls after being told: the runtime forks for it with the generic direction "take a different approach from your siblings" for all three, and logs a `fork_fallback` event. The fallback rate is reported; above 20% of pilot runs, phase 2 stops for a redesign (anti-goal 1).
   - A malformed `fork` call (wrong count, duplicates, too long) gets an error result and counts as one of the 2 calls.

## 5. Hypotheses (my proposal; same standards as phase 1)

- **F1, primary (bcp):** `fork` solves ≥ 10 points more tasks than `isolated` by first claim, 95% task-clustered bootstrap interval excluding 0 → **FORKING HELPS**; interval entirely below 0 → **FORKING HURTS**; otherwise **NO GAIN**. Exact McNemar reported with Holm.
- **F2:** `fork` − `fork-silent` (does talking after the fork add anything?), both suites pooled, same standard as F1: ≥ 10 points with the interval excluding 0 → TALK ADDS, otherwise no gain. (my call)
- **Multiple testing:** Holm over F1 (McNemar), F2 (McNemar) and F3 (bootstrap one-sided p). (my call)
- **Scoring:** runs are scored as assigned (intention to treat). A run that ends before it forks (budget or wall clock only, since claiming is closed until the fork) stays in its condition, and the rate of such runs is reported. (my call)
- **F3, domain:** the `fork` − `isolated` gain is larger on bcp than on math (as phase-1 H3).
- **Mechanism check (descriptive, with intervals):** duplicate reads (bcp) and duplicate code (math) per team are lower in `fork` and `fork-silent` than in `isolated`. The frozen definitions (`docs/pilot-definitions.md`) apply unchanged over the whole run: `a1`'s reads before the fork count once, and a copy re-reading a document it inherited counts as a duplicate, since that content is already in its context. A post-fork-only share is reported next to it. Also reported: whether the directions in each run are distinct, and the fallback rate. (my call)
- **Cost:** tokens per solved task by condition.

## 6. Tasks, sample, schedule

The same 60 scored tasks as phase 1 (30 bcp, 30 math) and the same 10 pilot tasks; nothing is trained on them, and reuse allows task-by-task comparison with phase 1. 3 conditions × 60 tasks × 2 seeds = **360 runs**, about 3 days on one Spark.

1. Build and test (runtime, viewer, analysis).
2. Pilot P2 on the 10 pilot tasks, `fork` and `fork-silent`, 2 seeds (40 runs): mechanics only (fork happens, directions distinct, context inheritance correct, fallback rate, no crashes).
3. Pre-registration `preregistrations/08-polylogue-forking.md` in agent-engineering-experiments, committed before the scored run.
4. Main run and frozen analysis. The write-up (a phase-2 section on the multi-agent-talk Lab page) is separate work after the results, not part of this build. (my call)

## 7. What the builder has to change

- **Schema:** a `fork` event (parent, call index, the three directions, child ids) and a `fork_fallback` event; new condition names.
- **Runtime:** a team that grows from 1 to 4 agents mid-run; cloning a pi `Agent`'s message history into new agents; the forced-fork turn and the `fork` tool; the condition table and prompts. The phase-1 decision not to build `fork` (it changes team size mid-run) is reversed: the shared 4 × B pool keeps compute equal across conditions.
- **Invariant:** every agent's context must still be rebuildable from the event log alone; for a copy that means the parent's events up to the fork plus its own.
- **Viewer:** show the fork (a branch point in the timeline).
- **Analysis:** `polyprep.analysis` extended for F1–F3 and the mechanism check; the phase-1 code paths unchanged.
- **Tests:** a scripted fake model covering the fork point, a correct fork, a malformed fork, the fallback, a claim before the fork, and context inheritance.

Left to the builder: how cloning is implemented in pi, prompt wording (reviewed by Daniel before the pilot), event and tool argument names, viewer layout.
