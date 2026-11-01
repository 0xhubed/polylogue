# Analysis: golden

Contains answers in the event log it reads; keep this report under data/ (git-ignored).

Runs: 180 of 180.

## Solve counts (first claim; any claim in brackets where it differs)

| suite | condition | runs | first claim | rate |
|---|---|---|---|---|
| bcp | single | 24 | 17 | 71% |
| bcp | isolated | 24 | 20 | 83% |
| bcp | stigmergic | 24 | 13 | 54% |
| bcp | polylogue | 24 | 20 | 83% |
| bcp | polylogue-bare | 24 | 13 | 54% |
| math | single | 12 | 6 | 50% |
| math | isolated | 12 | 9 | 75% |
| math | stigmergic | 12 | 8 | 67% |
| math | polylogue | 12 | 8 | 67% |
| math | polylogue-bare | 12 | 6 | 50% |

## H2 (primary, bcp): polylogue vs isolated, first claim

**Verdict: NO GAIN.** Effect +0.0 points, 95% interval [-16.7, +16.7], n = 24 pairs; McNemar p = 1.0000 (Holm 1.0000), discordant 4 / 4.
isolated − single: +12.5 points [-4.2, +33.3].
Manipulation check: 24 of 24 polylogue runs with a substantive message; messages per agent isolated 0.00, polylogue 0.25, polylogue-bare 0.25, single 0.00, stigmergic 0.25.

## Secondary hypotheses

- H1 (speed): ratio of median times 1.00 [1.00, 1.33] over 16 pairs, Wilcoxon p = 0.9795 (Holm 1.0000); holds: False
- H3 (domain): difference of differences +8.3 points, one-sided 95% bound -16.7, p = 0.3532 (Holm 1.0000); holds: False
- H4 (collapse without norms): 25% of polylogue-bare agents sent a substantive message; polylogue-bare − isolated -27.8 [-44.4, -11.1]; holds: False
- H5 (cost, polylogue/isolated tokens per solved task): bcp 1.00 [0.82, 1.24]; math 1.12 [0.78, 1.67]

## Secondary comparisons (both suites, first claim)

- stigmergic - polylogue: -19.4 points [-36.1, -2.8]
- polylogue - polylogue-bare: +25.0 points [+8.3, +41.7]
- isolated - single: +16.7 points [-2.8, +36.1]
- isolated best-of-N - first claim: +0.0 points

## Event-log metrics

| suite | condition | msgs/agent | runs with subst. msg | agents with subst. msg | dup reads | dup python | wrong consensus | claims/run | false claims | median tokens | median wall (s) | end reasons |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bcp | isolated | 0.00 | 0/24 | 0/96 | 96/144 | 72/96 | 0 | 1.17 | 8/28 | 169 | 111 | solved 20, wrong_claim 4 |
| bcp | polylogue | 0.25 | 24/24 | 24/96 | 72/72 | 72/96 | 4 | 1.17 | 8/28 | 169 | 132 | solved 20, wrong_claim 4 |
| bcp | polylogue-bare | 0.25 | 24/24 | 24/96 | 72/72 | 72/96 | 11 | 1.46 | 22/35 | 169 | 111 | solved 13, wrong_claim 11 |
| bcp | single | 0.00 | 0/24 | 0/24 | 0/72 | 0/24 | 0 | 1.00 | 7/24 | 166 | 58 | solved 17, wrong_claim 7 |
| bcp | stigmergic | 0.25 | 24/24 | 24/96 | 72/72 | 72/96 | 11 | 1.46 | 22/35 | 169 | 111 | solved 13, wrong_claim 11 |
| math | isolated | 0.00 | 0/12 | 0/48 | 48/72 | 36/48 | 0 | 1.25 | 6/15 | 139 | 111 | solved 9, wrong_claim 3 |
| math | polylogue | 0.25 | 12/12 | 12/48 | 36/36 | 36/48 | 4 | 1.33 | 8/16 | 139 | 111 | solved 8, wrong_claim 4 |
| math | polylogue-bare | 0.25 | 12/12 | 12/48 | 36/36 | 36/48 | 6 | 1.50 | 12/18 | 139 | 111 | solved 6, wrong_claim 6 |
| math | single | 0.00 | 0/12 | 0/12 | 0/36 | 0/12 | 0 | 1.00 | 6/12 | 136 | 58 | solved 6, wrong_claim 6 |
| math | stigmergic | 0.25 | 12/12 | 12/48 | 36/36 | 36/48 | 4 | 1.33 | 8/16 | 139 | 111 | solved 8, wrong_claim 4 |
