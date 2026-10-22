# Polylogue phase 1: analysis plan

**Status:** agreed 2026-10-18, written while the main run (`configs/main.json` → `data/main.sqlite`) is in progress. The analysis must be fixed before any main-run outcome is looked at. While the run is going, only completeness (runs finished, infra errors) is checked. The code is written and tested on pilot data (`data/pilot-p1b.sqlite`) and on synthetic logs, then committed before the main run ends.

Source of the hypotheses: the pre-registration (`agent-engineering-experiments/preregistrations/07-multi-agent-communication.md`, §3 and §6–7). This plan makes them computable. Where it has to choose something the pre-registration leaves open, the choice is marked **(choice)**.

## 1. Data

- **Runs:** one row per cell of `configs/main.json`: 2 suites × 30 scored tasks × 5 conditions × 2 seeds = 600. A cell whose run ended `infra_error` uses its rerun `<cell>-r1`. A cell whose rerun also failed counts as unsolved (pre-registration §7), and the report lists it.
- **Completeness gate:** the analysis refuses to produce verdicts while any cell is missing, and prints what is missing.
- **Fingerprints:** every run's `run_started.taskFingerprint` must equal the task's `task_sha256` in `suites/<suite>/frozen.json`. A mismatch stops the analysis.
- **Scores per run:**
  - `solved`: any claim passed (`run_finished.solved`).
  - `first`: the first claim passed. This is the primary score for every condition. It equals `solved` everywhere except `isolated`, whose run goes on after a wrong claim.
  - `best`: `isolated`'s best-of-N with the verifier, equal to `solved`. Reported as a reference only.

## 2. Primary test: H2 (`bcp`)

The unit is a (task, seed) pair: 60 pairs for `polylogue` against `isolated` on `bcp`. Both use the `first` score.

- **Effect:** the difference in solve rate, `polylogue` − `isolated`, in percentage points.
- **Interval:** 95% percentile bootstrap, clustered by task. Resample the 30 tasks with replacement and keep both seeds of each drawn task: 10,000 resamples, generator seed 20261017 **(choice)**.
- **Test:** exact McNemar (two-sided binomial test on the discordant pairs), reported with its Holm-adjusted p (§5).
- **Verdict** (pre-registration wording):
  - **TALK HELPS** if the effect is ≥ +10 points and the 95% interval excludes 0.
  - Otherwise **ONLY PARALLELISM** if `isolated` − `single` is ≥ +10 points and its 95% interval excludes 0 (the same standard as H2; Daniel, 2026-10-18).
  - Otherwise **NO GAIN**.
- **Holm against the interval (Daniel, 2026-10-18):** the verdict follows the interval, as the pre-registration states it. If the Holm-adjusted McNemar p is ≥ 0.05 while the interval excludes 0, the report says so next to the verdict.
- **Manipulation check:** the share of `polylogue` `bcp` runs with at least one substantive message (`docs/pilot-definitions.md`), and messages per agent for every condition, are printed in the same block as the verdict. There is no threshold.

## 3. Secondary hypotheses

- **H1, speed.** Pairs are the (task, seed) pairs that both `polylogue` and `isolated` solved on `bcp` by their first claim. Time is the `t` of the passing verification event. Statistic: the ratio of median times, `polylogue` / `isolated`, with a 95% task-clustered bootstrap interval. Test: one-sided Wilcoxon signed-rank on the paired log times. H1 holds if the ratio is ≤ 0.8. With fewer than 10 such pairs, H1 is reported as not testable.
- **H3, domain.** `(poly − iso)_bcp − (poly − iso)_math`, first-claim scores. The bootstrap resamples tasks within each suite independently. The one-sided p is the share of resamples ≤ 0. H3 holds if the point estimate is > 0 and the one-sided 95% bound is > 0.
- **H4, collapse without norms.** Across `polylogue-bare` runs on both suites, pooled (Daniel, 2026-10-18): the share of agents that send at least one substantive message, and the solve-rate difference `polylogue-bare` − `isolated` with its interval. H4 holds if that share is < 30% and the point estimate of the difference is within ±5 points. Per-suite values are reported next to it.
- **H5, cost.** For each suite and condition, tokens per solved task = the sum of `totalTokens` over all its runs divided by the number solved (first score). The ratio `polylogue` / `isolated`, with a bootstrap interval, is compared with 1.5. No verdict depends on it.
- **Secondary comparisons,** each a difference with its interval and no verdict: `stigmergic` − `polylogue`, `polylogue` − `polylogue-bare` (the norms), `isolated` − `single`, and `isolated` best-of-N − `isolated` first-claim.

## 4. Descriptive metrics (per suite and condition)

| Metric | Computed from |
|---|---|
| Messages per agent | `message` events / agents |
| Substantive-message share | definition in `docs/pilot-definitions.md`, matched with the verifier's normalization |
| Time to first substantive message | `t` of that message; runs without one are reported as a count |
| Idle time per agent | time from `idle` to the next `wake`, or to the end of the run |
| Duplicate work | `bcp`: share of read documents read by ≥ 2 agents; `math`: share of `run_python` calls whose code, stripped of whitespace and comments, matches code another agent ran earlier |
| Wrong consensus | wrong claims whose answer another agent had stated earlier in a message or on the blackboard (normalized match) |
| Claims per run, false-claim rate | `claim_submitted`, `verification` |
| End reasons | `run_finished.reason` |
| Tokens, wall clock | `run_finished` |

## 5. Multiple testing

Holm over three tests, at a family-wise α of 0.05: H2 (McNemar), H1 (Wilcoxon), H3 (bootstrap one-sided p). H4 and H5 are descriptive criteria without p-values.

## 6. Exclusions and answer keys

- **Aliases are frozen;** nothing is added after the main run.
- **Wrong answer keys:** failed claims are listed after the run. A task is removed from every condition only if its answer key is shown to be wrong by its source. This is decided before the conditions are compared, by looking at the claims without their condition labels. Every removal is reported. No other exclusions.

## 7. Implementation

- **Code:** `prep/polyprep/analysis.py` (Python, the standard library only, so the numbers do not depend on a statistics package) reads the event log, `configs/main.json` and `suites/*/frozen.json`. It writes `data/reports/main-analysis.md` and `data/reports/main-analysis.json`.
- **CLI:** `uv run --project prep python -m polyprep.analysis --db data/main.sqlite --matrix configs/main.json`. `--allow-incomplete` lets it run on pilot data; it then prints no verdicts.
- **Tests:**
  - exact McNemar against hand-computed values;
  - the bootstrap is deterministic for a fixed seed;
  - the verdict rules on constructed tables, including every boundary (+10 exactly, an interval touching 0);
  - the substantive-message and duplicate-work matchers on constructed logs;
  - the completeness and fingerprint gates;
  - a run on `data/pilot-p1b.sqlite` with `--allow-incomplete`, which must reproduce the pilot report's solve counts.
- **Commit:** spec and code are committed before the main run ends. The report (it contains answers) stays in `data/`; the verdict summary, without answers, goes into the write-up.
