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
