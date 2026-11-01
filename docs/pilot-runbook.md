# Pilot runbook (task suites, P0, P1, freeze)

Steps marked **GO-AHEAD** call the live model server and start only when Daniel says so. Everything writes under `data/` (git-ignored; the step-5a calibration directories `data-calib-*/` are git-ignored too) except the freeze commit.

## 0. Once

```bash
npm install
uv sync --project prep
npm run sandbox:build
npx vitest run packages/runtime/src/suites/python-tool.test.ts
```

`package-lock.json` and `prep/uv.lock` pin the Node and Python packages, `prep/.python-version` pins Python 3.12, and `docker/python-sandbox/Dockerfile` pins the `python:3.12-slim` base image by digest, so every step runs against exactly the versions the tests ran against. The last command checks the sandbox (no network, time and memory limits, no leftover containers).

## Stopping and resuming a batch

Applies to every batch (steps 4, 5a and 6).

- Press Ctrl-C once in the batch's terminal: the runs in progress finish, then the batch stops. A planned stop costs nothing; start the same command again to resume.
- Press Ctrl-C twice to exit at once. The interrupted run is closed as an infra error on the next start and rerun once.
- Signalling only the `npm`/`npx` wrapper process (e.g. `kill <npm pid>`) does not reach the batch. Use Ctrl-C in its terminal, or `kill -INT <pid>` with the pid of the node process, which `<db>.lock` records (`cat data/pilot-p0.sqlite.lock`).
- The batch refuses to start while another batch holds `<db>.lock` (for `data/pilot-p0.sqlite`: `data/pilot-p0.sqlite.lock`).
- To add the second Spark: stop with one Ctrl-C, add its URL to `servers` in the matrix, start again.
- Run one batch at a time per host, and no `python-tool.test.ts` while a batch runs: a batch's start and that test remove every `polylogue-py-*` container, including another batch's running math sandboxes.

## 1. bcp data (download, no model)

```bash
uv run --project prep python -m polyprep.bcp_fetch
```
About 3 GB of downloads and a few GB of SQLite under `data/bcp/`. A rerun keeps reviewed aliases and existing pilot/scored splits; `--force` resets the splits to candidate.

## 2. bcp oracle screen — GO-AHEAD

```bash
uv run --project prep python -m polyprep.bcp_screen --server http://zgx-40dd.local:8000/v1 --concurrency 16
```
About 830 calls, about 2.5 hours at `--concurrency 16` (measured 2026-10-12 on one Spark; the default of 4 left the server at about 50 tokens/s, some 15 hours). Then read `data/bcp/screen-failures.md` and add aliases for correct answers the verifier missed (`UPDATE tasks SET aliases = json_insert(aliases, '$[#]', '<alias>') WHERE id = '<id>'` in `data/bcp/tasks.sqlite`); re-running the screen skips screened questions and re-verifies the stored claims with the new aliases, but keeps an existing selection (pilot/scored splits); add `--reselect` to recompute the selection from the updated screen (only before P0 starts: P0 runs the pilot tasks). A rerun needs `--server` again and retries the questions that errored with live calls, so the GO-AHEAD applies to a rerun too. A rerun that retried errored questions keeps the old selection, which was made without them: pass `--reselect` on that rerun (again only before P0) so the retried questions can be selected.

## 3. math pool (by hand, no model)

Enter the candidate problems into `data/math/pool.jsonl`, one JSON object per line with the fields `id`, `source`, `contest_date` (YYYY-MM-DD), `number`, `problem` and `answer` (see `prep/polyprep/math_build.py`): problems 8–15 of AIME 2026 I and II and the harder half of the HMMT February 2026 individual rounds, integer or fraction answers only, from the official problem and answer sources. Then, with Qwen3.8-27B's release date from its model card:

```bash
uv run --project prep python -m polyprep.math_build --model-release YYYY-MM-DD
```

## 4. P0 — GO-AHEAD

```bash
npm run polylogue -- batch configs/pilot-p0.json --db data/pilot-p0.sqlite
npm run polylogue -- pilot-report --db data/pilot-p0.sqlite --matrix configs/pilot-p0.json
```
20 runs. Read `data/reports/pilot-p0.md`: B per suite (the report lists cells expected, finished, infra errors and missing per suite; rerun the batch until none are missing). P0 on 2026-10-14 gave B = 160,000 for bcp and 38,000 for math.

## 5a and 5. ledger (not in phase 1)

Dropped from phase 1 on 2026-10-15 after its calibration (five world sizes, 36 runs at B = 160k, nothing solved; see the task-suites spec, amendments). The generator (`polyprep.ledger_gen`, `--factor`, `--data-dir`) stays for phase 2. The calibration procedure was:

<details><summary>Calibration and generation steps as they were</summary>

### 5a. ledger calibration — GO-AHEAD

Before generating the real ledger suite, pick the size factor F (reading cost of a world = F × B tokens). The runtime charges the whole context on every model call, so the reading cost four agents can actually cover is measured here rather than assumed. Generate three worlds at each of three sizes, one per template (seeds 101, 102 and 103 get C, A and B; no model):

```bash
for F in 0.5 1 2; do
  uv run --project prep python -m polyprep.ledger_gen --budget <B_bcp> --seeds 101-103 --pilot 3 --factor $F --data-dir data-calib-$F
done
```

Write one matrix per size, `configs/ledger-calib-<F>.json` (copy `configs/pilot-p0.json`): name `ledger-calib-<F>`, `dataDir` `data-calib-<F>`, conditions `["single", "isolated"]`, seeds `[1]`, and one suite `{ "suite": "ledger", "split": "pilot", "tokensPerAgent": <B_bcp>, "wallClockMs": 1800000 }`. Run each size with its own database (6 runs per size, 18 in all):

```bash
for F in 0.5 1 2; do
  npm run polylogue -- batch configs/ledger-calib-$F.json --db data/calib-$F.sqlite
  npm run polylogue -- pilot-report --db data/calib-$F.sqlite --matrix configs/ledger-calib-$F.json
done
```

Read `data-calib-<F>/reports/ledger-calib-<F>.md` for each size. Daniel picks F: the size where `single` mostly fails but the evidence is coverable by four agents (the `isolated` runs read most of it between them). The calibration directories and databases are throwaway; they are not the suite.

### 5. ledger data (no model)

With F from step 5a:

```bash
uv run --project prep python -m polyprep.ledger_gen --budget <B_bcp> --factor <F>
```

Each world gets one of the templates A, B, C by seed (seed mod 3: seed 1 gets B, 2 gets C, 3 gets A, and so on). The templates are global, the same for every world, and every answer is a number (a name answer could be guessed by a team that makes several claims): A asks how many units the supplier with the most units received credit for, B for the total units, C how many units the city with the most units got. A and C keep a unique leader within 10% of the runner-up, so the question is well defined. No aliases are stored; numeric claims verify with the `numeric` rule.

</details>

## 6. P1 — GO-AHEAD

P1 uses its own database; never reuse `data/pilot-p0.sqlite`, because cells with the same ids (the `single` runs of bcp and math) would be skipped and P0's runs, made at a different budget, would stand in for P1's.

Copy `configs/pilot-p0.json` to `configs/pilot-p1.json`: name `pilot-p1`, all five conditions, seeds `[1, 2]`, and the two suites, each with its B from the P0 report as `tokensPerAgent` and `wallClockMs` 1800000. Then:

```bash
npm run polylogue -- batch configs/pilot-p1.json --db data/pilot-p1.sqlite
npm run polylogue -- pilot-report --db data/pilot-p1.sqlite --matrix configs/pilot-p1.json
```
100 runs, about a day on one Spark (math runs can take 25 minutes).

P1 on 2026-10-15 (`data/pilot-p1.sqlite`, old norms) showed no messages in any `polylogue` run and `isolated` at 90% on bcp. After the kickoff norm, the one-team-answer rule and a bcp budget sweep (`configs/bcp-sweep-40k.json`, `configs/bcp-sweep-25k.json`), P1 was rerun as P1b with `configs/pilot-p1b.json` (bcp B = 80k) into `data/pilot-p1b.sqlite`. The freeze uses P1b. From the report: wall-clock limits, rate limits, aliases, floor check, and draft definitions of "substantive message" and "duplicate work" (shared reads are a first candidate for the latter).

## 7. Freeze (after Daniel approves the report)

Before the freeze commit, write two files that carry what the pilot decided:

- `configs/main.json`, the main-run matrix: copy `configs/pilot-p1.json` and set name `main`, all five conditions, seeds `[1, 2]`, the two suites with `split: "scored"`, each suite's frozen B as `tokensPerAgent` and its frozen `wallClockMs`, and the frozen `rate` limits.
- `docs/pilot-definitions.md`, the agreed operational definitions of "substantive message" and "duplicate work", so analysis cannot change them after seeing results.

```bash
for s in bcp math; do uv run --project prep python -m polyprep.freeze $s; done
git add suites/*/frozen.json configs/pilot-p1.json configs/main.json docs/pilot-definitions.md
git commit -m "Freeze: tasks, budgets and limits after the pilot"
```
`frozen.json` records, per task, the answer hash and a fingerprint of match, answer, aliases and prompt (`task_sha256`); for ledger also the hash of the task's corpus file (`corpus_sha256`); for bcp the corpus and queries revisions. It holds no question text and no document ids. `python -m polyprep.freeze <suite> --check` verifies `data/` against the committed manifests at any later time. Once a suite has `frozen.json`, `polylogue batch` refuses to start a `scored` cell whose task differs from it (every run also logs its task fingerprint in `run_started`). D5 (primary suite) must be decided before this commit.

## 8. Phase 2 — fork (GO-AHEAD)

Design: `docs/superpowers/specs/2026-10-22-polylogue-phase2-fork-design.md`. Phase 2 reuses the phase-1 tasks (30 bcp, 30 math scored; the same 10 pilot tasks) and budgets (bcp 80k, math 38k per agent), and compares `fork`, `fork-silent` and `isolated`.

Before the pilot: Daniel reviews the prompt wording, the texts in `packages/runtime/src/fork/texts.ts` and `packages/runtime/src/conditions.ts`. Changing a text after the pilot means rerunning it.

P2 uses its own database (`data/pilot-p2.sqlite`; never reuse another pilot's file) and `configs/pilot-p2.json`: `fork` and `fork-silent`, seeds `[1, 2]`, the two pilot suites, bcp 80,000 and math 38,000 tokens per agent, `wallClockMs` 1800000. That is 2 conditions × 10 tasks × 2 seeds = 40 runs. No `isolated` runs: the pilot checks mechanics only.

```bash
npm run polylogue -- batch configs/pilot-p2.json --db data/pilot-p2.sqlite
npm run polylogue -- pilot-report --db data/pilot-p2.sqlite --matrix configs/pilot-p2.json
```

Go/no-go: read the `## Fork` section of the report, per suite and condition.

- Runs that forked, and runs that ended before the fork. A run that ends before the fork never reaches the manipulation; many of them mean the root solves or stops too early, or the budget runs out first.
- Fallback forks. The line `Fallback rate above 20%: STOP (spec §4.7)` means more than a fifth of the fork-condition runs needed the runtime's fallback (the model did not make the fork call); stop and fix the prompt or the tool before going on. `Fallback rate: ok` means go on.
- Distinct directions: the three directions differ after trim and lowercase. Fallback forks count as not distinct, because their three generic directions are identical. This is only a floor: the fork tool already rejects exact duplicates, so the count cannot show whether the directions are genuinely different.
- **Read the directions** (`### Directions`, under the Fork section; each fork run's three texts, cut at 300 characters, with the run's maximum pairwise word-Jaccard; the table above it gives the median per suite and condition). This is an explicit go/no-go step for Daniel: are the three directions of a run genuinely different, or three rewordings of one idea? Near-identical directions mean the copies will repeat each other; no-go, fix the instruction or the tool description and rerun P2 into a new database. The Jaccard figure only helps to sort (1.00 identical word sets; high values are the runs to read first); it has no threshold.
- Median tokens used before the fork: how much of the budget the root has spent when it forks, which is what the children inherit. Next to it, "instructed before 10% of the pool" counts the runs where the root was told to fork before a tenth of the pool was charged (a first turn without a tool call triggers the instruction early; this is planned behaviour, now visible). If it is most runs, the root forks before it has done anything worth inheriting.
- Short inheritance: copies whose first model call has fewer prompt tokens than the root's call that made the fork call. Any entry means the copy did not start from the root's whole history; check those runs before going on.
- The fallback rate leaves infra_error runs out of its denominator and names their count.

Also check by hand that context inheritance is right (a child's first call starts with the root's context up to the fork) and that no run crashed. Go only if all of these look fine; otherwise fix, and rerun P2 into a new database.

Before the main run: write the pre-registration `preregistrations/08-polylogue-forking.md` in agent-engineering-experiments and commit it. At the freeze, write `configs/phase2.json`, the main matrix: copy `configs/pilot-p2.json` and set name `phase2`, conditions `["fork", "fork-silent", "isolated"]`, seeds `[1, 2]`, both suites with `split: "scored"` and the frozen budgets and limits. That is 3 conditions × 60 tasks × 2 seeds = 360 runs, about 3 days on one Spark.
