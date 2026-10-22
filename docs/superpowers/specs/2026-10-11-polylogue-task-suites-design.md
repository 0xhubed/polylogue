# Polylogue task suites, verifiers, batch runner and pilot: design

**Date:** 2026-10-11 · **Status:** draft for Daniel's review
**Scope:** IDEA.md §10 step 4 and the pilot (step 5): three task suites with their work tools and verifiers, the data preparation that builds them, a batch runner for the run matrix, and the pilot that freezes budgets, limits and definitions before any scored run. Decision D2 of pre-registration draft 7.
**Inputs:** the runtime spec (`2026-10-11-polylogue-runtime-design.md`, §10 open items), pre-registration draft 7 (agent-engineering repo, `docs/experiments/drafts/07-multi-agent-communication.md`), and the smoke run of 2026-10-11 (toy task: every agent read all 8 shards and solved it alone; 0 messages).

## 1. Goal and success criteria

Give the five phase-1 conditions tasks on which splitting the work can pay off, with answers checked automatically, and a way to run the full matrix unattended.

The smoke run is the design constraint: when one agent can read everything it needs within its budget, nobody talks. Following Dunas ("On the Nature of the Swarm"), agents in parallel mainly add context, so at least one suite must need more evidence than one agent's budget can read.

Done means:

1. Three suites (`bcp`, `ledger`, `math`) with 5 pilot and 30 scored tasks each, their work tools and verifiers, built from `prep/` scripts into `data/`.
2. `polylogue batch` runs a matrix of suites × tasks × conditions × seeds on one or more servers, resumes after a crash, and reruns an infrastructure failure once.
3. The tests in §9 pass without a live model.
4. The pilot (§7) has run, `polylogue pilot-report` has produced its summary, and Daniel has approved the freeze. The freeze is the end of this spec's work; the main run and the analysis are not part of it. Every step that calls the live model server (the oracle screen, P0, P1) starts only on Daniel's go-ahead.

## 2. Decisions already made

| Decision | Ruling | Source |
|---|---|---|
| Purpose of the suites | Both comparability and mechanism: one established suite and one designed suite | Daniel, 2026-10-11 |
| Suites and run count | Three suites of 30 scored tasks: BrowseComp-Plus, designed, math. 3 × 30 × 5 conditions × 2 seeds = 900 runs (draft 7 had 600) | Daniel, 2026-10-11 |
| Designed suite | Aggregation over a large generated corpus, with some chain clues. Every agent can read all evidence; reading all of it costs about 2B tokens | Daniel, 2026-10-11 |
| BrowseComp-Plus selection | Oracle screen (the model solves it when given the gold documents), then the most spread-out evidence. Never selected on any condition's results | Daniel, 2026-10-11 |
| Retriever | BM25 in SQLite FTS5. Dense retrieval only as a fallback if the pilot floors | Daniel, 2026-10-11 |
| Math source | Recent competitions (harder half, after the model's release); generated problems as fallback | Daniel, 2026-10-11 |
| Verifier | Normalized match plus listed aliases, local and deterministic. No frontier judge (D4 stays open) | Daniel, 2026-10-11 |
| Math work tool | `run_python` in a throwaway Docker container | Daniel, 2026-10-11 |
| Budget | One per-agent budget B per suite, frozen in the pilot (`ledger` takes `bcp`'s B, §7). The team pool stays N·B (draft 7 §5) | Daniel, 2026-10-11 |
| Scope | Suites, tools, verifiers, data prep, batch runner and pilot. Analysis gets its own spec after the pilot | Daniel, 2026-10-11 |
| Build | Python for data preparation, TypeScript runtime reading the prepared files | Daniel, 2026-10-11 |
| Servers | One Spark (zgx-40dd) now; the runner accepts more, and a second one can join a running batch | Daniel, 2026-10-11 |

## 3. Architecture

```
prep/                     Python, run once on the ThinkCentre
  bcp_fetch.py            download + decrypt BrowseComp-Plus (authors' script), build FTS5 index
  bcp_screen.py           oracle screen against the model server, spread ranking, pilot/scored split
  ledger_gen.py           seeded world generator, questions, answer keys, size calibration
  math_build.py           candidate pool, contamination check, answer keys, fallback generator
  freeze.py               writes suites/<suite>/frozen.json from data/
data/                     git-ignored: decrypted questions, corpora, answer keys
  bcp.sqlite  ledger.sqlite  math.sqlite
suites/<suite>/frozen.json    committed after the pilot: task ids, answer hashes, provenance
packages/runtime/src/
  suites/registry.ts      suite id → loader; the toy vault becomes suite "toy"
  suites/corpus-tools.ts  search, read_doc, list_docs over a suite SQLite file (read-only)
  suites/python-tool.ts   run_python via docker
  suites/verify.ts        normalize, alias match, numeric equality
  batch/                  matrix expansion, workers, resume, rerun
  cli.ts                  + `batch`, `pilot-report`
```

Each suite gives the runtime three things for a task id: the task prompt, its work tools, and a verifier. Conditions, communication tools, `claim`, budgets and the event log are unchanged. The run config gains `suite` and `split` (`pilot` | `scored`); `taskId` keeps its meaning within the suite.

Answer keys and decrypted BrowseComp-Plus text never enter git: the questions are obfuscated upstream to keep them out of training data, and the repo has a GitHub remote. `frozen.json` holds SHA-256 hashes of the normalized answers, so the freeze is verifiable without revealing them.

## 4. The suites

### 4.1 `bcp`: BrowseComp-Plus

- **Source:** `Tevatron/browsecomp-plus` (830 questions, MIT) and `Tevatron/browsecomp-plus-corpus` (100,195 documents, average about 5,200 words). Questions average 6.1 evidence documents and 2.9 gold documents.
- **Tools:** `search(query)` returns the top 10 BM25 hits over the whole corpus, each with doc id, title and a snippet of about 200 characters. `read_doc(id, page)` returns about 2,000 tokens (8,000 characters) per page, headed "page i of n"; an unknown id or page is a tool error.
- **Prompt:** the question, then "Answer with a short exact answer (a name, title, date or number)."
- **Verifier:** §6.

### 4.2 `ledger`: the designed suite

- **Corpus:** each task is a generated world, for example a trading company's records: shipments, suppliers, recalls, contract transfers and corrections, one record per document (a few hundred words each). Records are written as varied prose, not tables, so reading them costs tokens like real documents.
- **Tools:** the same `search` and `read_doc` as `bcp`, plus `list_docs(page)`, which lists 50 doc ids with titles in a fixed order. With the same search tools as `bcp`, the two research suites differ mainly in how the evidence is spread, which helps H3.
- **Questions:** templates combine an aggregation (count, maximum or sum over a filtered set) with exclusions (recalled batches; a later correction overrides an earlier record) and one or two chain clues ("the supplier that took over X's contracts in March"). One question per task. The generator computes the answer from its own data model, not from the prose.
- **Size:** a parameter sets the total reading cost of the corpus to about 2 × B_ledger tokens (measured with the model's tokenizer on the rendered documents). One agent cannot read everything within B; the team, with 4B, can if it splits the reading.
- **Verifier:** exact match after normalization (§6); answers are numbers or names by construction.

### 4.3 `math`: competition problems

- **Pool:** problems 8–15 of AIME 2026 I and II, and the harder half of the HMMT February 2026 individual rounds. Only problems whose answer is an integer or a fraction.
- **Contamination check:** a contest is admitted only if it took place after Qwen3.8-27B's release date (from its model card); the date and the source go into `frozen.json`.
- **Fallback:** if fewer than 35 problems qualify, generated problems (randomized number theory, combinatorics and constraint puzzles with answers computed in code) fill the remainder, flagged per task.
- **Tool:** `run_python(code)` runs the code in `docker run --rm --network none --memory 512m --cpus 1` with a 10-second limit and returns stdout and stderr, each cut at 4,000 characters. A timeout, an error or a memory kill comes back as a normal tool result naming what happened.
- **Verifier:** exact numeric equality (fractions compared as reduced numerator/denominator).

## 5. Data preparation

**`bcp`.** `bcp_fetch.py` downloads both datasets, de-obfuscates them with the authors' script, and writes `data/bcp.sqlite`: the corpus with an FTS5 index (BM25), and the questions with answers and evidence/gold document ids. `bcp_screen.py` then:

1. **Oracle screen:** for each of the 830 questions, one call to the pinned model (same sampling settings as the runs) with only the question and its gold documents (about 20k tokens). It keeps the questions whose answer the verifier accepts. Every failure is listed for a manual look, and a correct answer the matcher missed adds an alias.
2. **Spread ranking:** sorts the survivors by number of evidence documents and takes the top 35.
3. **Split:** 5 pilot and 30 scored, with a fixed seed.

The screen runs against one model server, about 830 calls, an hour or two.

**`ledger`.** `ledger_gen.py <seed> --budget B` builds one world and its question deterministically. All 35 worlds (5 pilot, 30 scored) are generated after P0 (§7) at B_ledger = B_bcp.

**`math`.** `math_build.py` assembles the pool from the official problem and answer sources (entered by hand into a local file, since contests publish PDFs), applies the contamination check, adds fallback problems if needed, and splits 5 pilot / 30 scored with a fixed seed.

**Freeze.** `freeze.py` writes `suites/<suite>/frozen.json`: task ids, split, answer hashes, and provenance (BrowseComp-Plus query ids; generator version and seeds for `ledger`; contest, problem number and date for `math`). After the freeze commit the scored tasks do not change.

## 6. Verification

The verifier ends runs (first passing claim), so it must be fast, local and identical across conditions.

- **Normalization:** Unicode NFKC, lowercase, strip punctuation and the articles "a", "an", "the", collapse whitespace. Numbers: strip thousands separators; `1/2`, `0.5` and `.5` compare equal for numeric answers.
- **Match:** the normalized claim equals the normalized answer or one of its aliases. For `bcp` the claim may also contain the answer as a whole-word substring when the claim is at most 3 times its length (an agent writing "The answer is Tolkien" passes; a list of candidates does not).
- **Aliases** live with the answer key in `data/` and are added only during the screen and the pilot, from a manual look at failed claims. They are frozen with the tasks.

The verifier's error rate is not measured by a second judge (D4 open). Its known bias, failing rephrased correct answers, hits every condition alike.

## 7. Batch runner and pilot

**`polylogue batch <matrix.json> --db runs.sqlite`.**

- **Matrix:** suites × tasks (`pilot` or `scored`) × conditions × seeds, plus the per-suite budget, wall-clock limit and rate limits. Each cell gets a deterministic run id, `<suite>-<task>-<condition>-s<seed>`.
- **Order:** cells are shuffled with a fixed seed, so no condition runs systematically early or late.
- **Servers:** a list of model servers; one worker per server pulls the next open cell and runs it (one run at a time per server). Adding a server to the list and restarting the batch lets it join. Each run records its server (`baseUrl` is already in the config and the run row).
- **Resume:** cells whose run row is finished are skipped. A row left `running` by a crash is closed as `infra_error` (with `run_finished` appended) before the batch continues.
- **Rerun:** an `infra_error` cell is rerun once as `<id>-r1`; if that also fails, the cell counts as unsolved (draft 7 §7).

**Pilot**, on the 5 pilot tasks per suite, one server:

1. **P0, budgets.** `single` only on `bcp` and `math`, budget 200k tokens, 2 seeds (20 runs). Per suite, B = 1.5 × the median tokens of its solved runs, rounded up to 1,000. If a suite has fewer than 3 solved P0 runs, its B is the median over all its P0 runs, and the report flags the floor. `ledger` is not measured, because it is built so that one agent cannot cover it: B_ledger = B_bcp (same tools, same kind of work, so the two research suites differ in how the evidence is spread, not in budget), and the `ledger` worlds are generated at that B after P0.
2. **P1, everything else.** All 5 conditions × 2 seeds at the measured B (150 runs). From these:
   - **Wall-clock limit per suite:** 3 × the slowest solved `single` run in P1, so the token budget binds before time does.
   - **Rate limits:** start at 10 messages per minute per agent and 2,000 characters; raised or lowered if P1 shows storms or truncation.
   - **Definitions:** first operational definitions of "substantive message" and "duplicate work", checked against the P1 logs.
   - **Aliases:** completed from the failed claims.
   - **Floor check:** if `bcp` solves fewer than 2 of 10 pilot runs in every condition, the report recommends the dense-retriever fallback.

`polylogue pilot-report --db runs.sqlite` writes a Markdown summary: solve counts and tokens per suite and condition, messages per agent, the proposed frozen values, the open alias cases and the floor check. Daniel approves it; the freeze commit adds `frozen.json`, B, the limits and the definitions. That same freeze is the point at which draft 7 is frozen.

The main run (900 runs, about 150 hours on one Spark or 75 on two) starts after the freeze and is not part of this spec's acceptance.

## 8. Failures

- A missing `data/<suite>.sqlite` or an unknown task id refuses the run with a message naming the file or id.
- A `math` batch refuses to start when `docker info` fails.
- Suite databases are opened read-only by the runtime.
- `bcp_screen.py` and the pilot use the same server check as runs (`checkServer`).

## 9. Testing

Vitest for the runtime, pytest for `prep/`. No live model.

- **Corpus tools** against a small fixture corpus: BM25 ranking order, snippet length, paging of `read_doc`, `list_docs` order, unknown id and page errors.
- **`run_python`:** output returned, timeout reported, no network (a request fails), memory limit enforced. Skipped with a clear message when Docker is unavailable.
- **Verifier:** normalization, aliases, the substring rule's length cap, numeric equality for fractions and decimals.
- **`ledger` generator (pytest):** deterministic per seed; the answer recomputed from the parsed documents equals the stored key; corrections override earlier records; the size parameter lands within ±10% of its target.
- **Batch runner** against the fake OpenAI server with a 2 × 2 × 2 matrix: shuffled order is reproducible, resume after a simulated crash closes the stale row and skips finished cells, an `infra_error` is rerun exactly once, and two workers never take the same cell.
- **Freeze:** `frozen.json` hashes match `data/` (skipped when `data/` is absent).
- **Suite end to end:** each suite's loader with a fixture database runs `single` and `polylogue` on one task through `runOnce` against the fake server, and the event-order invariants from the runtime tests hold.

## 10. Changes to draft 7

Made in the same change, in the agent-engineering repo (branch `experiments/prereg-drafts`):

- §4: three suites of 30 (BrowseComp-Plus with the oracle screen and spread ranking; the designed `ledger` suite; competition math with a Python tool), 900 runs.
- §5: one budget B per suite, measured in the pilot; the team pool stays N·B.
- §9: about 150 hours on one Spark, 75 on two.
- §10: D2 decided (2026-10-11); new open decision D5: which suite carries the primary H2 test and the H3 contrast (`bcp`, `ledger`, or the two research suites pooled). D5 must be decided before the freeze; it does not change anything this spec builds.
- §3: H3's predicted order of the gain becomes `ledger` ≥ `bcp` > `math`.

## 11. Out of scope

The analysis (McNemar, bootstrap intervals, verdicts; its own spec after the pilot); the low-parallelism suite (phase 2); a dense retriever (fallback only); a frontier judge (D4); the main run itself.

## 12. Amendments (2026-10-12)

Changes made during the build and its final review. The sections above keep their original text; where they disagree with this list, this list holds.

- **§4.2 `ledger` answers are numbers.** All three templates ask for a number: A, how many units the supplier with the most units received credit for; B, the total units; C, how many units the city with the most units got. A and C keep a unique leader within 10% of the runner-up. No name answers and no aliases: a team that makes several claims could otherwise guess a name. The ledger verifier is the `numeric` rule (§6). Templates are assigned by seed (`"ABC"[seed % 3]`).
- **§4.2 and §5 reading cost is a parameter.** `ledger_gen.py --budget B --factor F` sets a world's reading cost to F × B tokens (default 2.0; `--seeds`, `--pilot` and `--data-dir` as in the runbook). F is not fixed in advance: the runtime charges the whole context on every model call, so a calibration step before P1 (runbook step 5a, three sizes × three worlds × `single` and `isolated`) measures it, and Daniel picks F.
- **§6 `contains` rejects hedged claims.** A claim with a standalone "or" or "either" fails the substring rule unless the answer itself contains that word ("Tolkien or Lewis" fails; "War or Peace" passes when that is the answer). The TypeScript and Python verifiers share the test vectors.
- **§5 `frozen.json` fields.** Per task: `id`, `split`, `match`, `answer_sha256`, `task_sha256` (fingerprint of match, answer, aliases and prompt) and `info`, whitelisted per suite (bcp: `query_id` and `n_evidence` only, never question text or document ids; ledger: generator, seed, budget, factor, template; math: source, number, contest date, model release, kind, seed, `generated`). Ledger tasks add `corpus_sha256`; bcp manifests add `corpus_revision` and `queries_revision`. `freeze.py <suite> --check` verifies `data/` against the manifest, and the batch runner refuses a `scored` cell whose task differs from it.
- **§10 D5 decided (Daniel, 2026-10-12): `bcp` carries the primary H2 test.** `ledger` and `math` are secondary; H3 contrasts `bcp` with `math`. The final review advised against `ledger`: it is designed by us to need division of labour, so it should not carry the primary test.
- **§6 normalization drops diacritics (Daniel, 2026-10-12).** After NFKC and lowercasing, text is decomposed, combining marks are dropped and the rest recomposed, and letters without a decomposition are folded (ı→i, ø→o, ł→l, đ/ð→d, þ→th, ß→ss, æ→ae, œ→oe): "Kış Bahçesi" matches "Kis Bahcesi". The oracle screen failed about 7 of 140 correct claims on diacritics alone. Shared vectors cover both verifiers. Answer hashes change with it; nothing was frozen yet.
- **Sampling is Qwen3.8's thinking-mode recommendation, not greedy (Daniel, 2026-10-12).** Every call (runs and oracle screen) uses `suites/sampling.json`: temperature 0.6, top_p 0.95, top_k 20, min_p 0, plus the agent's seed. This replaces temperature 0 in the runtime spec (§ model provider) and §5. P0 at temperature 0 gave identical runs for seeds 1 and 2 (so `isolated` would be four near-copies of one agent) and lost a run to a repetition loop in the reasoning (the model's card warns against greedy decoding in thinking mode). The screen and P0 were redone with the new sampling.
- **§4.3 math is all generated, with harder kinds (Daniel, 2026-10-12).** Qwen/Qwen3.8-27B's repository was created on 2026-08-05, so no AIME or HMMT February 2026 problem qualifies. P0 put the first generator (small, brute-forceable counts) at ceiling: `single` solved 10 of 10 with a median of 3.6k tokens. The generator now has six kinds sized past brute force within run_python's limits (obstacle paths on a grid of about 10^5, inclusion–exclusion coprime counts to 10^13, a floor sum to 10^12, digit DP to 10^17, compositions to 10^18 as a linear recurrence, permutation bitmask DP for n = 13–15). Each kind has a brute-force solver that tests check against. Difficulty is calibrated in a small `single` pilot on problems from seeds 1001 and up (`math_build --first-seed`), which the suite does not use. The target is that `single` solves about 30–60%.
- **Per-call output cap is 32,768 tokens (Daniel, 2026-10-13), up from 8,192.** That is Qwen's recommended output length in thinking mode. In the second math calibration, 11 of 18 runs ended because the first call hit the 8,192 cap mid-reasoning: no tool call, so the agent went idle and the run ended. Each run's token budget still bounds what it spends. The oracle screen re-screened only its 8 answers cut at 8,192, because with seeded sampling every answer that finished under the old cap is unchanged.
- **The token budget is hard (Daniel, 2026-10-13).** A call is refused, and the run ends `budget`, when its estimated prompt alone would spend the rest of the pool. Otherwise its output is capped at min(maxTokens, pool − used − prompt estimate). A call cut by that cap, not by the model's own maxTokens, also ends the run `budget`. Before this, a call was admitted while used < pool and could add a whole call's tokens beyond it. That overshoot was about 10% of B for bcp but up to twice B for math (B ≈ 31k, calls up to 32k). Calls in flight at the same time each see the same remainder, so a team can still overshoot by up to one call per other agent, and only at the very end of the pool.
- **Team pools are exact: calls reserve against the pool (Daniel, 2026-10-14).** An admitted call reserves its prompt estimate plus its output cap until it returns, and is then charged what it actually used. A call whose prompt and full maxTokens fit gets maxTokens. If it does not fit, it waits while other calls are in flight, since their reservations may come back unused. A call that is alone gets what is left after its prompt, and a prompt that does not fit ends the run `budget`. This replaces the residual in the previous item: in the ledger calibration, `isolated` teams spent 657k–766k tokens of a 640k pool, because agents admitted at the same moment each charged prompts of about 45k. The only remaining error is the prompt estimate.
- **`ledger` is dropped from phase 1 (Daniel, 2026-10-15); phase 1 is `bcp` and `math`, 600 runs.** The calibration covered five world sizes (F = 2, 1, 0.5 with `single` and `isolated`; then F = 0.25 and 0.2 also with `polylogue`), 36 runs at B = 160k, and nothing was solved. One agent reads 54–80 documents before its budget runs out. A `polylogue` team agreed on a split within a minute and posted every record to the blackboard, covering 92–100 documents. It then ran out of its pool while polling (`roster`, `read_blackboard`, each re-charging a context of about 25k tokens) and aggregating. The window between what one agent covers and what a team can still aggregate is too narrow to place 30 worlds in. The generator stays for phase 2 (IDEA §8).
- **One team answer, and a kickoff norm (Daniel, 2026-10-16, after P1).** In `stigmergic`, `polylogue` and `polylogue-bare`, the first claim ends the run, right or wrong (new end reason `wrong_claim`), and the prompt says so. `isolated` agents cannot see each other, so their runs go on until a claim passes. Their log gives two scores: the first claim (the primary H2 score, under the same rule as the teams) and best-of-4 with the verifier (secondary, draft 7's cheap-compute reference). The report has a "first claim solves" column. `single` ends at its one claim, as before. The `polylogue` norms now start with a kickoff, "publish a one-line plan on #all", because in P1 none of the 40 `polylogue` and `polylogue-bare` runs sent a single message, and `stigmergic` agents never wrote to the blackboard. P1 also had no wrong claims (56 claims, all correct), so the claim rule does not change P1's numbers. The ceiling on `bcp` (`isolated` 90%, `stigmergic` 100%) comes from parallel search, not from extra guesses.
- **bcp's B is set where `isolated` solves about 50–60% of pilot tasks, not at 1.5 × the `single` median (Daniel, 2026-10-16).** At the P0 rule's 160k, `isolated` solved 9 of 10 pilot tasks, so H2 had no room. A sweep gave 3/10 at 40k and 2/10 at 25k for both `isolated` and `polylogue`. B = 80k, interpolated on a log scale to about 60% for `isolated`, is checked in P1b. `math` keeps the P0 rule (B = 38k), since its team conditions solved 30–40% in P1.
