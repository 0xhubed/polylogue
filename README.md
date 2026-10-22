# polylogue

Does letting agents talk to each other help? A runtime for the experiment in [IDEA.md](IDEA.md): N agents (pi, on a local vLLM server) under five conditions, every event logged to SQLite, and a viewer that replays or follows a run.

Design: [docs/superpowers/specs/2026-10-11-polylogue-runtime-design.md](docs/superpowers/specs/2026-10-11-polylogue-runtime-design.md)

## Provenance

This repository is a public snapshot of the harness, taken on 2026-10-22 after the phase-1 main run. The pre-registration ([agent-engineering-experiments/preregistrations/07-multi-agent-communication.md](https://github.com/0xhubed/agent-engineering-experiments/blob/main/preregistrations/07-multi-agent-communication.md)) cites the freeze commit `de104a5` of the private working repository. That history stays private because a few early test examples used real BrowseComp-Plus answers. This snapshot replaces them with invented names, so its history starts here. The frozen tasks (`suites/*/frozen.json`) and the budgets and limits (`configs/main.json`) are byte-identical to `de104a5`. The definitions (`docs/pilot-definitions.md`) carry one dated amendment, made before any outcome was looked at and recorded in the pre-registration. The other changes after the freeze are the analysis plan and code, also written before any outcome was seen, and the test examples above. The private history is available on request.

Results: [agent-engineering-experiments/results/polylogue](https://github.com/0xhubed/agent-engineering-experiments/tree/main/results/polylogue).

`frozen.json` stores unsalted SHA-256 hashes of the normalized answers, as frozen. A short answer can be recovered from its hash by trial. The BrowseComp-Plus questions and answers are obfuscated upstream to keep them out of training data, and this repository contains neither in plain text. The answer keys and the corpus are built locally under `data/` (git-ignored) by `prep/`.

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

The config names the condition (`single`, `isolated`, `stigmergic`, `polylogue`, `polylogue-bare`), the task, the seed, the team's token budget per agent, the wall-clock limit, rate limits and the pinned model. The run refuses to start if the server does not serve the configured model id from the configured Hugging Face repository; the revision is recorded with the run but not verified (vLLM's model list does not report it). The server needs tool calling: `--enable-auto-tool-choice --tool-call-parser=qwen3_coder` (see `serving/gb10/qwen38-27b.sh` in the agent-engineering-experiments repo).

## Task suites and batches

Three suites: `bcp` (BrowseComp-Plus over its fixed corpus, BM25 search), `ledger` (generated records whose evidence exceeds one agent's budget) and `math` (competition problems with a sandboxed Python tool). Their data is built under `data/` (git-ignored) by the Python package in `prep/`:

```bash
uv sync --project prep
npm run test:prep
npm run sandbox:build
```

`polylogue batch <matrix.json>` runs a matrix of suites × tasks × conditions × seeds in shuffled order on one worker per model server, resumes after a crash and reruns an infrastructure failure once. `polylogue pilot-report` summarizes a batch. The pilot steps, with the points that need a go-ahead, are in [docs/pilot-runbook.md](docs/pilot-runbook.md). Design: [docs/superpowers/specs/2026-10-11-polylogue-task-suites-design.md](docs/superpowers/specs/2026-10-11-polylogue-task-suites-design.md).

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
