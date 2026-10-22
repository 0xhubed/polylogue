# Polylogue Task Suites, Batch Runner and Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three task suites (`bcp`, `ledger`, `math`) with their work tools and verifiers, the Python data preparation that builds them, a batch runner for the run matrix, and a pilot report, so the pilot can run and freeze budgets, limits and tasks.

**Architecture:** Python scripts under `prep/` (package `polyprep`, run with `uv`) build git-ignored SQLite files under `data/<suite>/`: `tasks.sqlite` (prompt, answer key, match rule) and corpus files with an FTS5 index. The TypeScript runtime reads them through a suite registry that gives `runOnce` a task prompt, work tools and a verifier; everything else in the runtime is unchanged. `polylogue batch` expands a matrix into run cells, shuffles them, and runs them on one worker per model server with resume and a single rerun of infrastructure failures; `polylogue pilot-report` summarizes a batch as Markdown.

**Tech Stack:** Existing runtime (Node 22, TypeScript 6.0.3, better-sqlite3 13.0.3 with FTS5, zod 4.6.5, typebox 1.3.27, pi 1.1.0, vitest 5.0.2). Python 3.12 with uv; datasets 5.1.0, huggingface_hub 2.2.0, tokenizers 0.23.3, pytest 9.1.1, hatchling 1.32.4. Docker image `polylogue-python:1` (python:3.12-slim + sympy 1.14.0 + numpy 2.5.4).

**Spec:** `docs/superpowers/specs/2026-10-11-polylogue-task-suites-design.md` (approved by Daniel 2026-10-11). Read it before your task. The runtime it extends was built from `docs/superpowers/plans/2026-10-11-polylogue-runtime.md`.

## Global Constraints

- Answer keys and decrypted BrowseComp-Plus text never enter git. `/data/` is git-ignored; `suites/<suite>/frozen.json` holds only SHA-256 hashes of normalized answers. Reports that show answers go to `data/reports/`.
- The verifier rules (spec §6) are implemented twice, in TypeScript (`packages/runtime/src/suites/verify.ts`) and Python (`prep/polyprep/verify.py`). Both must pass every case in `suites/verify-vectors.json`; change that file and both implementations together.
- Tool limits (spec §4): `search` returns the top 10 BM25 hits with a snippet of about 200 characters; `read_doc` pages are 8,000 characters (about 2,000 tokens); `list_docs` lists 50 ids per page; `run_python` runs in `docker run --rm --network none --memory 512m --cpus 1` with a 10-second limit and returns stdout and stderr cut at 4,000 characters each.
- Conditions differ only in tool set, system prompt text and N. A suite changes only the task prompt, the work tools and the verifier; the agent loop, controller, communication tools, claim and log are unchanged.
- Runtime constraints carry over from the runtime plan: Node `>=22.19.0`, ESM, relative imports with `.ts`, exact dependency versions, no directories named `lib` (the Python `.gitignore` template ignores every `lib/`).
- Python: 3.12 via `uv`, exact pins as in Tech Stack. Run prep code as `uv run --project prep python -m polyprep.<module>` and tests as `uv run --project prep pytest -q prep/tests` from the repo root.
- Pinned upstream sources: BrowseComp-Plus decrypt script at commit `046949032b0328319cc9a02663a759ec601d9402` of `texttron/BrowseComp-Plus`; dataset `Tevatron/browsecomp-plus` at revision `144cff8e35b5eaef7e526346aa60774a9deb941f`; corpus `Tevatron/browsecomp-plus-corpus` at revision `b27b02bc3e45511b8b82a13e6f90ce761df726f6`; tokenizer `unsloth/Qwen3.8-27B-NVFP4` at revision `7d6f8d4d72f56b92b3cdbf22f156b90e1bab0108`.
- Tests never contact a live model server (zgx-40dd.local) or download datasets. Steps that do (the oracle screen, P0, P1) start only on Daniel's go-ahead; they are listed in the runbook (Task 9), not run by implementers.
- Commit after every task on branch `spec/runtime`. Never commit to `main`. Do not push.

## Review Focus

1. **Agent search queries with FTS5 syntax** (`"`, `AND`, `NOT`, `*`, `-`, parentheses, `title:`): a person expects them to be searched as plain words, never an SQLite syntax error. Test added to Task 2.
2. **`read_doc` with a wrong id, page 0 or a page past the end**: a tool error naming the valid range; the run goes on. Test added to Task 2.
3. **`run_python` code that floods stdout, forks, or loops forever**: truncated output, "Timed out", and no container left running afterwards. Test added to Task 3.
4. **A batch killed mid-run and restarted**: the half-finished run is closed as `infra_error` (not resumed, not duplicated), rerun once as `-r1`, and the matrix completes. Test added to Task 8.
5. **Claims with formatting** (`**Answer:** 204`, `$\frac{3}{4}$`, `1,000`, a trailing period, `The answer is Tolkien`): verified identically in TypeScript and Python. Vectors in Task 1, checked by both Task 1 and Task 4.

## Rulings made while planning (beyond the spec)

- **`ledger` name answers use the `contains` rule** like `bcp` (spec §4.2 said exact). An agent writing "The answer is Ghent" should pass in both research suites alike. Numeric `ledger` answers use `numeric`. Cost if wrong: one field per task, changeable before the freeze.
- **A numeric claim must contain exactly one number.** "between 200 and 210" fails with "no single number in the claim".
- **One corpus file per `ledger` task** (`data/ledger/corpus-<task>.sqlite`), so BM25 statistics come from that task's world only; `bcp` has one shared `data/bcp/corpus.sqlite`.
- **Prep scripts are modules** (`python -m polyprep.bcp_fetch`, …) instead of loose `prep/<name>.py` files, so they share code and tests import them. Names match the spec.
- **`configHash` ignores `dataDir`** (a location, not part of the run's definition).
- **Sandbox hardening beyond the spec's flags:** `--memory-swap 512m --pids-limit 64 --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534`, container name `polylogue-py-<uuid>` so a timeout can `docker kill` it.
- **A stale `running` row is closed with an appended `run_finished`** (`infra_error`, detail "interrupted; closed when the batch resumed"). Such a run has no `agent_finished` events; analysis treats it as unsolved, like any infra error rerun.
- **Batch ids follow the spec** (`<suite>-<task>-<condition>-s<seed>`), even though task ids already start with the suite.
- **`ledger` documents get a handling paragraph** (8–14 filler sentences, about 400 tokens per shipment record), so the corpus reaches its reading cost with a few hundred records, as the spec describes.

---

## File structure

```
.gitignore                                   + /data/
package.json                                 + scripts sandbox:build, test:prep
suites/schema.sql                            tasks table (shared by Python and TypeScript)
suites/corpus.sql                            docs + docs_fts (FTS5, porter unicode61)
suites/verify-vectors.json                   verifier cases both implementations must pass
docker/python-sandbox/Dockerfile             polylogue-python:1
configs/pilot-p0.json                        P0 matrix
docs/pilot-runbook.md                        live steps in order, with the go-ahead gates
packages/runtime/src/
  config.ts                                  + SuiteId, suite, dataDir; configHash ignores dataDir
  run/run.ts                                 task from the suite registry
  suites/verify.ts, verify.test.ts           verifier
  suites/corpus.ts, corpus.test.ts           Corpus (read-only SQLite) + search/read_doc/list_docs tools
  suites/registry.ts, registry.test.ts       loadTask, listTasks
  suites/python-tool.ts, python-tool.test.ts run_python, pythonSandboxReady
  testing/suite-fixture.ts                   builds fixture data dirs for tests
  batch/matrix.ts, batch/runner.ts, batch/batch.test.ts
  batch/report.ts, batch/report.test.ts
  cli.ts                                     + batch, pilot-report
prep/
  pyproject.toml
  polyprep/__init__.py                       ROOT, DATA
  polyprep/verify.py                         normalize_text, numeric_value, verify_claim, answer_hash
  polyprep/store.py                          open_tasks, put_task, write_corpus
  polyprep/model.py                          check_server, chat (OpenAI-compatible, urllib)
  polyprep/tokens.py                         qwen_counter, char_counter
  polyprep/freeze.py                         frozen manifest, --check
  polyprep/ledger.py                         world model, rendering, questions, calibration
  polyprep/ledger_parse.py                   parses rendered documents back (tests only use it)
  polyprep/ledger_gen.py                     CLI: builds the ledger suite
  polyprep/bcp_fetch.py, polyprep/bcp.py, polyprep/bcp_screen.py
  polyprep/mathgen.py, polyprep/math_build.py
  tests/test_verify.py, test_store.py, test_freeze.py, test_ledger.py, test_bcp.py, test_math.py
```

---

### Task 1: Shared suite format and the TypeScript verifier

**Files:**
- Create: `suites/schema.sql`, `suites/corpus.sql`, `suites/verify-vectors.json`, `packages/runtime/src/suites/verify.ts`
- Modify: `.gitignore` (append)
- Test: `packages/runtime/src/suites/verify.test.ts`

**Interfaces:**
- Produces: `type MatchKind = "exact" | "contains" | "numeric"`; `interface AnswerKey { answer: string; aliases: string[]; match: MatchKind }`; `interface Verdict { passed: boolean; detail?: string }`; `normalizeText(s: string): string`; `numericValue(s: string): { n: bigint; d: bigint } | null`; `verifyClaim(key: AnswerKey, claim: string): Verdict`. The SQL files are the storage contract for every later task.

- [ ] **Step 1: Shared files**

Append to `.gitignore`:
```
# polylogue suite data (answer keys, decrypted benchmark text)
/data/
```

`suites/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  split TEXT NOT NULL CHECK (split IN ('candidate', 'pilot', 'scored')),
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  match TEXT NOT NULL CHECK (match IN ('exact', 'contains', 'numeric')),
  corpus TEXT,
  info TEXT NOT NULL DEFAULT '{}'
);
```

`suites/corpus.sql`:
```sql
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title, body, content='docs', content_rowid='rowid', tokenize='porter unicode61');
```

`tasks.corpus` is a file name relative to `data/<suite>/` (`corpus.sqlite`, `corpus-ledger-007.sqlite`) or NULL (math). `aliases` is a JSON array of strings, `info` a JSON object.

`suites/verify-vectors.json`:
```json
{
  "cases": [
    { "match": "exact", "answer": "Kessler AG", "aliases": [], "claim": "kessler ag.", "passed": true },
    { "match": "exact", "answer": "The Hobbit", "aliases": [], "claim": "Hobbit", "passed": true },
    { "match": "exact", "answer": "Ghent", "aliases": [], "claim": "The answer is Ghent", "passed": false },
    { "match": "exact", "answer": "Café Noir", "aliases": [], "claim": "CAFÉ NOIR", "passed": true },
    { "match": "exact", "answer": "abc", "aliases": [], "claim": "ＡＢＣ", "passed": true },
    { "match": "exact", "answer": "Ghent", "aliases": [], "claim": "", "passed": false },
    { "match": "contains", "answer": "J. R. R. Tolkien", "aliases": ["Tolkien"], "claim": "The answer is Tolkien", "passed": true },
    { "match": "contains", "answer": "Tolkien", "aliases": [], "claim": "Candidates: Tolkien, Lewis, Williams, Barfield", "passed": false },
    { "match": "contains", "answer": "Lyon", "aliases": [], "claim": "Lyonnais", "passed": false },
    { "match": "contains", "answer": "Lyon", "aliases": [], "claim": "It was delivered to Lyon.", "passed": false },
    { "match": "contains", "answer": "Brandt Logistics", "aliases": [], "claim": "Answer: Brandt Logistics", "passed": true },
    { "match": "contains", "answer": "1,250 units", "aliases": [], "claim": "1250 units", "passed": true },
    { "match": "numeric", "answer": "204", "aliases": [], "claim": "**Answer:** 204", "passed": true },
    { "match": "numeric", "answer": "3/4", "aliases": [], "claim": "$\\frac{3}{4}$", "passed": true },
    { "match": "numeric", "answer": "3/4", "aliases": [], "claim": "0.75", "passed": true },
    { "match": "numeric", "answer": "3/4", "aliases": [], "claim": "6/8", "passed": true },
    { "match": "numeric", "answer": "1000", "aliases": [], "claim": "1,000", "passed": true },
    { "match": "numeric", "answer": "0.5", "aliases": [], "claim": ".5", "passed": true },
    { "match": "numeric", "answer": "-5", "aliases": [], "claim": "x = -5", "passed": true },
    { "match": "numeric", "answer": "204", "aliases": [], "claim": "between 200 and 210", "passed": false },
    { "match": "numeric", "answer": "204", "aliases": [], "claim": "205", "passed": false },
    { "match": "numeric", "answer": "2024", "aliases": [], "claim": "2024-03-01", "passed": false },
    { "match": "numeric", "answer": "7", "aliases": [], "claim": "seven", "passed": false }
  ],
  "normalize": [
    { "in": "The  Lord of the Rings!", "out": "lord of rings" },
    { "in": "1,000,000 units", "out": "1000000 units" },
    { "in": "Ｆｕｌｌ－ｗｉｄｔｈ", "out": "full width" },
    { "in": "An apple a day", "out": "apple day" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`packages/runtime/src/suites/verify.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeText, numericValue, verifyClaim, type MatchKind } from "./verify.ts";

interface Vectors {
  cases: { match: MatchKind; answer: string; aliases: string[]; claim: string; passed: boolean }[];
  normalize: { in: string; out: string }[];
}
const vectors = JSON.parse(readFileSync(new URL("../../../../suites/verify-vectors.json", import.meta.url), "utf8")) as Vectors;

describe("verifier vectors (shared with prep/polyprep/verify.py)", () => {
  for (const c of vectors.cases) {
    it(`${c.match}: ${JSON.stringify(c.claim)} vs ${JSON.stringify(c.answer)} → ${c.passed}`, () => {
      expect(verifyClaim({ answer: c.answer, aliases: c.aliases, match: c.match }, c.claim).passed).toBe(c.passed);
    });
  }
  for (const n of vectors.normalize) {
    it(`normalizes ${JSON.stringify(n.in)}`, () => expect(normalizeText(n.in)).toBe(n.out));
  }
});

describe("verifier details", () => {
  it("reduces fractions", () => {
    expect(numericValue("6/8")).toEqual({ n: 3n, d: 4n });
    expect(numericValue("-\\frac{2}{4}")).toEqual({ n: -1n, d: 2n });
  });

  it("explains failures without leaking anything to agents (detail is for the log only)", () => {
    expect(verifyClaim({ answer: "204", aliases: [], match: "numeric" }, "between 200 and 210")).toEqual({ passed: false, detail: "no single number in the claim: between 200 and 210" });
    expect(verifyClaim({ answer: "Lyon", aliases: [], match: "exact" }, "Ghent")).toEqual({ passed: false, detail: "expected Lyon, got Ghent" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/runtime/src/suites/verify.test.ts`
Expected: FAIL, `Failed to resolve import "./verify.ts"`.

- [ ] **Step 4: Implement**

`packages/runtime/src/suites/verify.ts`:
```ts
export type MatchKind = "exact" | "contains" | "numeric";
export interface AnswerKey {
  answer: string;
  aliases: string[];
  match: MatchKind;
}
export interface Verdict {
  passed: boolean;
  detail?: string;
}
export interface Rational {
  n: bigint;
  d: bigint;
}

const ARTICLES = new Set(["a", "an", "the"]);
const THOUSANDS = /([0-9]),(?=[0-9]{3}(?![0-9]))/g;
const NUMBER = /-?\\d?frac\{-?[0-9]+\}\{[0-9]+\}|-?[0-9]+\.[0-9]+|-?\.[0-9]+|-?[0-9]+\/[0-9]+|-?[0-9]+/g;

/** NFKC, lowercase, no thousands separators, punctuation to spaces, articles dropped. Mirrors prep/polyprep/verify.py. */
export function normalizeText(s: string): string {
  const t = s.normalize("NFKC").toLowerCase().replace(THOUSANDS, "$1").replace(/[^\p{L}\p{N}]+/gu, " ");
  return t
    .split(" ")
    .filter((w) => w && !ARTICLES.has(w))
    .join(" ");
}

const abs = (x: bigint) => (x < 0n ? -x : x);
function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}
function rational(n: bigint, d: bigint): Rational | null {
  if (d === 0n) return null;
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

function parseToken(tok: string): Rational | null {
  let m = /^(-?)\\d?frac\{(-?[0-9]+)\}\{([0-9]+)\}$/.exec(tok);
  if (m) return rational((m[1] ? -1n : 1n) * BigInt(m[2]!), BigInt(m[3]!));
  m = /^(-?[0-9]+)\/([0-9]+)$/.exec(tok);
  if (m) return rational(BigInt(m[1]!), BigInt(m[2]!));
  m = /^(-?)([0-9]*)\.([0-9]+)$/.exec(tok);
  if (m) {
    const n = BigInt((m[2] || "0") + m[3]!);
    return rational(m[1] ? -n : n, 10n ** BigInt(m[3]!.length));
  }
  if (/^-?[0-9]+$/.test(tok)) return rational(BigInt(tok), 1n);
  return null;
}

/** The value of the one number in `s`, or null when there is none or more than one. */
export function numericValue(s: string): Rational | null {
  const tokens = s.normalize("NFKC").replace(THOUSANDS, "$1").match(NUMBER) ?? [];
  return tokens.length === 1 ? parseToken(tokens[0]!) : null;
}

export function verifyClaim(key: AnswerKey, claim: string): Verdict {
  const shown = claim.trim().slice(0, 200);
  const fail = (detail = `expected ${key.answer}, got ${shown}`): Verdict => ({ passed: false, detail });
  const targets = [key.answer, ...key.aliases];
  if (key.match === "numeric") {
    const got = numericValue(claim);
    if (!got) return fail(`no single number in the claim: ${shown}`);
    const hit = targets.some((t) => {
      const want = numericValue(t);
      return want !== null && want.n === got.n && want.d === got.d;
    });
    return hit ? { passed: true } : fail();
  }
  const c = normalizeText(claim);
  if (!c) return fail();
  for (const t of targets.map(normalizeText).filter(Boolean)) {
    if (c === t) return { passed: true };
    if (key.match === "contains" && c.length <= 3 * t.length && ` ${c} `.includes(` ${t} `)) return { passed: true };
  }
  return fail();
}
```

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run packages/runtime/src/suites/verify.test.ts && npx tsc -p tsconfig.json`
Expected: 29 tests PASS (23 cases + 4 normalize + 2 details), tsc silent.

- [ ] **Step 6: Commit**

```bash
git add .gitignore suites packages/runtime/src/suites/verify.ts packages/runtime/src/suites/verify.test.ts
git commit -m "Suite data format and the answer verifier (shared vectors)"
```

---

### Task 2: Corpus tools, suite registry and `runOnce` integration

**Files:**
- Create: `packages/runtime/src/suites/corpus.ts`, `packages/runtime/src/suites/registry.ts`, `packages/runtime/src/testing/suite-fixture.ts`
- Modify: `packages/runtime/src/config.ts`, `packages/runtime/src/run/run.ts`
- Test: `packages/runtime/src/suites/corpus.test.ts`, `packages/runtime/src/suites/registry.test.ts`

**Interfaces:**
- Consumes: `verifyClaim`, `AnswerKey`, `Verdict`, `MatchKind` (Task 1); `WorkTool` (`tools/work-tool.ts`); `VAULT`, `TASKS`, `readShardTool`, `ToyTask` (`toy/vault.ts`).
- Produces:
  - `corpus.ts`: `PAGE_CHARS = 8000`, `LIST_PAGE = 50`, `HITS = 10`; `ftsQuery(q: string): string | null`; `class Corpus { constructor(path: string); search(q: string): { id: string; title: string; snippet: string }[]; page(id: string, page: number): string; list(page: number): string; close(): void }`; `type CorpusToolName = "search" | "read_doc" | "list_docs"`; `corpusTools(c: Corpus, names: CorpusToolName[]): WorkTool[]`.
  - `registry.ts`: `SUITE_TOOLS: Record<"bcp" | "ledger", CorpusToolName[]>`; `interface LoadedTask { id: string; prompt: string; tools: WorkTool[]; verify(answer: string): Verdict; close(): void }`; `loadTask(suite: SuiteId, taskId: string, o: { dataDir: string; toolDelayMs: number; toyTasks?: Record<string, ToyTask> }): LoadedTask`; `listTasks(suite: SuiteId, split: "candidate" | "pilot" | "scored", dataDir: string): string[]`.
  - `config.ts`: `SuiteId = z.enum(["toy", "bcp", "ledger", "math"])`, `RunConfig.suite` (default `"toy"`), `RunConfig.dataDir` (default `"data"`).
  - `testing/suite-fixture.ts`: `interface FixtureTask { id: string; split?: "candidate" | "pilot" | "scored"; prompt: string; answer: string; aliases?: string[]; match: MatchKind; corpus?: string | null }`; `interface FixtureDoc { id: string; title: string; body: string }`; `makeSuiteFixture(suite: "bcp" | "ledger" | "math", tasks: FixtureTask[], corpora?: Record<string, FixtureDoc[]>): string` (returns a fresh `dataDir`).

Tool texts (exact):
- `search`: one line pair per hit, `"<i>. [<id>] <title>\n   <snippet>"`, joined with `\n`; no hits → `No documents match.`; a query with no letters or digits → tool error `The query has no words.`
- `read_doc`: `"Document <id>: <title> (page <p> of <n>)\n\n<text>"`; unknown id → error `There is no document "<id>".`; bad page → error `Document <id> has pages 1 to <n>.`
- `list_docs`: `"Documents <a>–<b> of <total> (page <p> of <n>):\n[<id>] <title>\n…"`; bad page → error `The list has pages 1 to <n>.`

- [ ] **Step 1: The fixture helper**

`packages/runtime/src/testing/suite-fixture.ts`:
```ts
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { MatchKind } from "../suites/verify.ts";

const ROOT = new URL("../../../../", import.meta.url);
const SQL = (name: string) => readFileSync(new URL(`suites/${name}`, ROOT), "utf8");

export interface FixtureTask {
  id: string;
  split?: "candidate" | "pilot" | "scored";
  prompt: string;
  answer: string;
  aliases?: string[];
  match: MatchKind;
  corpus?: string | null;
}
export interface FixtureDoc {
  id: string;
  title: string;
  body: string;
}

/** Builds data/<suite>/tasks.sqlite and its corpus files in a fresh temp dir, with the same SQL as prep/. Returns the dataDir. */
export function makeSuiteFixture(suite: "bcp" | "ledger" | "math", tasks: FixtureTask[], corpora: Record<string, FixtureDoc[]> = {}): string {
  const dataDir = mkdtempSync(join(tmpdir(), "polylogue-suite-"));
  const dir = join(dataDir, suite);
  mkdirSync(dir);
  const t = new Database(join(dir, "tasks.sqlite"));
  t.exec(SQL("schema.sql"));
  const put = t.prepare("INSERT INTO tasks (id, split, prompt, answer, aliases, match, corpus, info) VALUES (?, ?, ?, ?, ?, ?, ?, '{}')");
  for (const x of tasks) put.run(x.id, x.split ?? "pilot", x.prompt, x.answer, JSON.stringify(x.aliases ?? []), x.match, x.corpus ?? null);
  t.close();
  for (const [file, docs] of Object.entries(corpora)) {
    const c = new Database(join(dir, file));
    c.exec(SQL("corpus.sql"));
    const ins = c.prepare("INSERT INTO docs (id, ord, title, body) VALUES (?, ?, ?, ?)");
    docs.forEach((d, i) => ins.run(d.id, i, d.title, d.body));
    c.exec("INSERT INTO docs_fts(docs_fts) VALUES ('rebuild')");
    c.close();
  }
  return dataDir;
}
```

- [ ] **Step 2: Write the failing tests**

`packages/runtime/src/suites/corpus.test.ts`:
```ts
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Corpus, LIST_PAGE, PAGE_CHARS, corpusTools, ftsQuery } from "./corpus.ts";
import { makeSuiteFixture, type FixtureDoc } from "../testing/suite-fixture.ts";

const docs: FixtureDoc[] = [
  { id: "d1", title: "Harbour report", body: "The ferry to Ghent was delayed by fog." },
  { id: "d2", title: "Supplier memo", body: "Kessler AG supplied copper wire to the vault project in Lyon." },
  { id: "d3", title: "Long document", body: "x".repeat(PAGE_CHARS * 2 + 10) },
  ...Array.from({ length: 60 }, (_, i) => ({ id: `f${i}`, title: `Filler ${i}`, body: "Nothing relevant here." })),
];
let open: Corpus[] = [];
afterEach(() => {
  for (const c of open) c.close();
  open = [];
});
function corpus(): Corpus {
  const dir = makeSuiteFixture("bcp", [], { "corpus.sqlite": docs });
  const c = new Corpus(join(dir, "bcp", "corpus.sqlite"));
  open.push(c);
  return c;
}
const run = (c: Corpus, name: string, args: unknown) => corpusTools(c, ["search", "read_doc", "list_docs"]).find((t) => t.name === name)!.run(args);

describe("ftsQuery", () => {
  it("turns any text into quoted words joined by OR", () => {
    expect(ftsQuery('who "supplied" copper AND NOT (wire*) title:vault -lyon')).toBe('"who" OR "supplied" OR "copper" OR "and" OR "not" OR "wire" OR "title" OR "vault" OR "lyon"');
    expect(ftsQuery("  ?!  ")).toBeNull();
  });
});

describe("Corpus tools", () => {
  it("search ranks by BM25 and formats hits", async () => {
    const out = await run(corpus(), "search", { query: "Kessler copper" });
    expect(out.split("\n")[0]).toBe("1. [d2] Supplier memo");
    expect(out).toContain("Kessler AG supplied copper");
    expect(out.split("\n").filter((l) => /^\d+\. \[/.test(l)).length).toBeLessThanOrEqual(10);
  });

  it("search treats FTS5 syntax as plain words and never throws an SQLite error", async () => {
    const c = corpus();
    for (const q of ['"unbalanced', "AND OR NOT", "copper*", "(ghent", "title:harbour", "-fog", "NEAR(a b)"]) {
      await expect(run(c, "search", { query: q })).resolves.toBeTypeOf("string");
    }
    await expect(run(c, "search", { query: "zzzz" })).resolves.toBe("No documents match.");
    await expect(run(c, "search", { query: "!!!" })).rejects.toThrow("The query has no words.");
  });

  it("read_doc pages long documents and explains bad ids and pages", async () => {
    const c = corpus();
    expect(await run(c, "read_doc", { id: "d1" })).toBe("Document d1: Harbour report (page 1 of 1)\n\nThe ferry to Ghent was delayed by fog.");
    const p3 = await run(c, "read_doc", { id: "d3", page: 3 });
    expect(p3.startsWith("Document d3: Long document (page 3 of 3)\n\n")).toBe(true);
    expect(p3.length).toBe("Document d3: Long document (page 3 of 3)\n\n".length + 10);
    await expect(run(c, "read_doc", { id: "nope" })).rejects.toThrow('There is no document "nope".');
    await expect(run(c, "read_doc", { id: "d3", page: 0 })).rejects.toThrow("Document d3 has pages 1 to 3.");
    await expect(run(c, "read_doc", { id: "d3", page: 4 })).rejects.toThrow("Document d3 has pages 1 to 3.");
  });

  it("list_docs lists 50 per page in order", async () => {
    const c = corpus();
    const p1 = (await run(c, "list_docs", {})).split("\n");
    expect(p1[0]).toBe(`Documents 1–${LIST_PAGE} of 63 (page 1 of 2):`);
    expect(p1[1]).toBe("[d1] Harbour report");
    expect(p1).toHaveLength(LIST_PAGE + 1);
    expect((await run(c, "list_docs", { page: 2 })).split("\n")[0]).toBe("Documents 51–63 of 63 (page 2 of 2):");
    await expect(run(c, "list_docs", { page: 3 })).rejects.toThrow("The list has pages 1 to 2.");
  });
});
```

`packages/runtime/src/suites/registry.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listTasks, loadTask } from "./registry.ts";
import { makeSuiteFixture } from "../testing/suite-fixture.ts";
import { parseConfig, configHash } from "../config.ts";
import { runOnce } from "../run/run.ts";
import { EventLog } from "../log/event-log.ts";
import { startFakeOpenAI, type FakeServer } from "../testing/fake-openai.ts";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const bcpData = () =>
  makeSuiteFixture(
    "bcp",
    [
      { id: "bcp-1", split: "pilot", prompt: "Which company supplied copper wire to the vault project?", answer: "Kessler AG", match: "contains", corpus: "corpus.sqlite" },
      { id: "bcp-2", split: "scored", prompt: "Where was the ferry going?", answer: "Ghent", match: "contains", corpus: "corpus.sqlite" },
      { id: "bcp-3", split: "candidate", prompt: "x", answer: "y", match: "exact", corpus: "corpus.sqlite" },
    ],
    {
      "corpus.sqlite": [
        { id: "d1", title: "Harbour report", body: "The ferry to Ghent was delayed by fog." },
        { id: "d2", title: "Supplier memo", body: "Kessler AG supplied copper wire to the vault project in Lyon." },
      ],
    },
  );

describe("suite registry", () => {
  it("lists tasks by split", () => {
    const dir = bcpData();
    expect(listTasks("bcp", "pilot", dir)).toEqual(["bcp-1"]);
    expect(listTasks("bcp", "scored", dir)).toEqual(["bcp-2"]);
    expect(listTasks("toy", "pilot", dir)).toEqual(["toy-vault"]);
  });

  it("loads a task with its prompt, tools and verifier", () => {
    const t = loadTask("bcp", "bcp-1", { dataDir: bcpData(), toolDelayMs: 0 });
    expect(t.prompt).toBe("Which company supplied copper wire to the vault project?");
    expect(t.tools.map((x) => x.name)).toEqual(["search", "read_doc"]);
    expect(t.verify("The answer is Kessler AG")).toEqual({ passed: true });
    expect(t.verify("Lyon").passed).toBe(false);
    t.close();
  });

  it("gives ledger tasks list_docs too and the toy suite its shard tool", () => {
    const dir = makeSuiteFixture("ledger", [{ id: "ledger-001", prompt: "q", answer: "Ghent", match: "contains", corpus: "corpus-ledger-001.sqlite" }], {
      "corpus-ledger-001.sqlite": [{ id: "D-0001", title: "Shipment record SH-0001", body: "b" }],
    });
    expect(loadTask("ledger", "ledger-001", { dataDir: dir, toolDelayMs: 0 }).tools.map((x) => x.name)).toEqual(["search", "read_doc", "list_docs"]);
    expect(loadTask("toy", "toy-vault", { dataDir: dir, toolDelayMs: 0 }).tools.map((x) => x.name)).toEqual(["read_shard"]);
  });

  it("refuses missing data, unknown tasks and missing corpus files with readable messages", () => {
    const empty = mkdtempSync(join(tmpdir(), "polylogue-empty-"));
    expect(() => loadTask("bcp", "bcp-1", { dataDir: empty, toolDelayMs: 0 })).toThrow(/Suite "bcp" has no data: .*tasks\.sqlite is missing/);
    expect(() => loadTask("bcp", "bcp-9", { dataDir: bcpData(), toolDelayMs: 0 })).toThrow('Suite "bcp" has no task "bcp-9".');
    const noCorpus = makeSuiteFixture("bcp", [{ id: "bcp-1", prompt: "q", answer: "a", match: "exact", corpus: "corpus.sqlite" }]);
    expect(() => loadTask("bcp", "bcp-1", { dataDir: noCorpus, toolDelayMs: 0 })).toThrow(/corpus\.sqlite is missing/);
  });

  it("config defaults to the toy suite and the hash ignores dataDir", () => {
    const base = { condition: "single", taskId: "toy-vault", seed: 1, budget: { tokensPerAgent: 1000 }, wallClockMs: 1000, rate: { messagesPerMinute: 1, maxMessageChars: 10 }, model: { baseUrl: "http://x/v1", id: "m", hfRepo: "r", revision: "v", contextWindow: 1000, maxTokens: 10, reasoningEffort: "medium", timeoutMs: 1000, maxRetries: 0 } };
    expect(parseConfig(base)).toMatchObject({ suite: "toy", dataDir: "data" });
    expect(configHash(parseConfig({ ...base, dataDir: "/a" }))).toBe(configHash(parseConfig({ ...base, dataDir: "/b" })));
    expect(() => parseConfig({ ...base, suite: "chess" })).toThrow();
  });

  it("runOnce runs bcp and ledger tasks end to end in single and polylogue", async () => {
    const ledgerData = () =>
      makeSuiteFixture("ledger", [{ id: "ledger-001", prompt: "Which city got the copper?", answer: "Ghent", match: "contains", corpus: "corpus-ledger-001.sqlite" }], {
        "corpus-ledger-001.sqlite": [{ id: "D-0001", title: "Shipment record SH-0001", body: "On 3 March 2024, Kessler AG dispatched 140 units of copper wire to Ghent." }],
      });
    const cases = [
      { suite: "bcp", taskId: "bcp-1", data: bcpData, steps: [{ name: "search", args: { query: "copper vault" } }, { name: "read_doc", args: { id: "d2" } }], answer: "The answer is Kessler AG", seen: "[d2] Supplier memo" },
      { suite: "ledger", taskId: "ledger-001", data: ledgerData, steps: [{ name: "list_docs", args: {} }, { name: "read_doc", args: { id: "D-0001" } }], answer: "Ghent", seen: "[D-0001] Shipment record SH-0001" },
    ] as const;
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-suite-run-")), "runs.sqlite"));
    for (const c of cases) {
      for (const condition of ["single", "polylogue"] as const) {
        fake = await startFakeOpenAI(({ agentIndex, call }) => {
          if (agentIndex !== 0) return { content: "nothing" };
          const step = c.steps[call];
          return step ? { toolCalls: [step] } : { toolCalls: [{ name: "claim", args: { answer: c.answer, evidence: "read it" } }] };
        });
        const cfg = parseConfig({
          condition, suite: c.suite, taskId: c.taskId, dataDir: c.data(), seed: 3,
          budget: { tokensPerAgent: 100_000 }, wallClockMs: 20_000, rate: { messagesPerMinute: 30, maxMessageChars: 2000 },
          model: { baseUrl: fake.baseUrl, id: "qwen3.8-27b", hfRepo: "unsloth/Qwen3.8-27B-NVFP4", revision: "r", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 30_000, maxRetries: 0 },
        });
        const s = await runOnce(cfg, { log });
        await fake.close();
        fake = undefined;
        expect(s).toMatchObject({ reason: "solved", solved: true });
        const events = log.events(s.runId).map((e) => e.event);
        expect(events[0]).toMatchObject({ kind: "run_started", config: { suite: c.suite } });
        expect(events.filter((e) => e.kind === "tool_result").map((e) => ("text" in e ? e.text : "")).join("\n")).toContain(c.seen);
        expect(events.at(-1)!.kind).toBe("run_finished");
        const agents = events.filter((e) => e.kind === "agent_started").map((e) => ("agent" in e ? e.agent : ""));
        for (const a of agents) expect(events.filter((e) => e.kind === "agent_finished" && e.agent === a)).toHaveLength(1);
      }
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run packages/runtime/src/suites`
Expected: FAIL, cannot resolve `./corpus.ts` / `./registry.ts`.

- [ ] **Step 4: Implement `corpus.ts`**

`packages/runtime/src/suites/corpus.ts`:
```ts
import Database from "better-sqlite3";
import { Type } from "typebox";
import type { WorkTool } from "../tools/work-tool.ts";

export const PAGE_CHARS = 8000;
export const LIST_PAGE = 50;
export const HITS = 10;
const MAX_WORDS = 12;

/** Any text → an FTS5 query of quoted words joined by OR, so agent input can never be FTS5 syntax. */
export function ftsQuery(q: string): string | null {
  const words = q.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(words)].slice(0, MAX_WORDS);
  return unique.length ? unique.map((w) => `"${w}"`).join(" OR ") : null;
}

const pages = (len: number, size: number) => Math.max(1, Math.ceil(len / size));

export class Corpus {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true, fileMustExist: true });
  }

  search(q: string): { id: string; title: string; snippet: string }[] {
    const query = ftsQuery(q);
    if (!query) throw new Error("The query has no words.");
    return this.db
      .prepare(
        `SELECT d.id AS id, d.title AS title, snippet(docs_fts, 1, '', '', ' … ', 24) AS snippet
         FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
         WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ${HITS}`,
      )
      .all(query) as { id: string; title: string; snippet: string }[];
  }

  page(id: string, page: number): string {
    const doc = this.db.prepare("SELECT title, body FROM docs WHERE id = ?").get(id) as { title: string; body: string } | undefined;
    if (!doc) throw new Error(`There is no document "${id}".`);
    const n = pages(doc.body.length, PAGE_CHARS);
    if (!Number.isInteger(page) || page < 1 || page > n) throw new Error(`Document ${id} has pages 1 to ${n}.`);
    return `Document ${id}: ${doc.title} (page ${page} of ${n})\n\n${doc.body.slice((page - 1) * PAGE_CHARS, page * PAGE_CHARS)}`;
  }

  list(page: number): string {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM docs").get() as { c: number }).c;
    const n = pages(total, LIST_PAGE);
    if (!Number.isInteger(page) || page < 1 || page > n) throw new Error(`The list has pages 1 to ${n}.`);
    const rows = this.db.prepare("SELECT id, title FROM docs ORDER BY ord LIMIT ? OFFSET ?").all(LIST_PAGE, (page - 1) * LIST_PAGE) as { id: string; title: string }[];
    const a = (page - 1) * LIST_PAGE + 1;
    return [`Documents ${a}–${a + rows.length - 1} of ${total} (page ${page} of ${n}):`, ...rows.map((r) => `[${r.id}] ${r.title}`)].join("\n");
  }

  close(): void {
    this.db.close();
  }
}

export type CorpusToolName = "search" | "read_doc" | "list_docs";

export function corpusTools(c: Corpus, names: CorpusToolName[]): WorkTool[] {
  const all: Record<CorpusToolName, WorkTool> = {
    search: {
      name: "search",
      description: `Search the document collection by keywords. Returns the ${HITS} best matches with their ids and a snippet.`,
      parameters: Type.Object({ query: Type.String() }),
      run: async (a: { query: string }) => {
        const hits = c.search(a.query);
        if (hits.length === 0) return "No documents match.";
        return hits.map((h, i) => `${i + 1}. [${h.id}] ${h.title}\n   ${h.snippet.replace(/\s+/g, " ").trim()}`).join("\n");
      },
    },
    read_doc: {
      name: "read_doc",
      description: `Read one page (about 2,000 tokens) of a document by its id. Pages start at 1.`,
      parameters: Type.Object({ id: Type.String(), page: Type.Optional(Type.Integer()) }),
      run: async (a: { id: string; page?: number }) => c.page(a.id, a.page ?? 1),
    },
    list_docs: {
      name: "list_docs",
      description: `List the documents in order, ${LIST_PAGE} per page, with their ids and titles. Pages start at 1.`,
      parameters: Type.Object({ page: Type.Optional(Type.Integer()) }),
      run: async (a: { page?: number }) => c.list(a.page ?? 1),
    },
  };
  return names.map((n) => all[n]);
}
```

- [ ] **Step 5: Implement `config.ts` changes and `registry.ts`**

In `packages/runtime/src/config.ts`, add above `RunConfig`:
```ts
export const SuiteId = z.enum(["toy", "bcp", "ledger", "math"]);
export type SuiteId = z.infer<typeof SuiteId>;
```
add two fields to the `RunConfig` object (after `taskId`):
```ts
  suite: SuiteId.default("toy"),
  dataDir: z.string().default("data"),
```
and change `configHash` to:
```ts
/** Hash of everything that defines the run except its id and where its data lives. */
export function configHash(cfg: RunConfig): string {
  const { runId: _id, dataDir: _dir, ...rest } = cfg;
  return `sha256:${createHash("sha256").update(stableJson(rest)).digest("hex")}`;
}
```

`packages/runtime/src/suites/registry.ts`:
```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { SuiteId } from "../config.ts";
import type { WorkTool } from "../tools/work-tool.ts";
import { TASKS, readShardTool, type ToyTask } from "../toy/vault.ts";
import { Corpus, corpusTools, type CorpusToolName } from "./corpus.ts";
import { verifyClaim, type AnswerKey, type MatchKind, type Verdict } from "./verify.ts";

export const SUITE_TOOLS: Record<"bcp" | "ledger", CorpusToolName[]> = {
  bcp: ["search", "read_doc"],
  ledger: ["search", "read_doc", "list_docs"],
};

export interface LoadedTask {
  id: string;
  prompt: string;
  tools: WorkTool[];
  verify(answer: string): Verdict;
  close(): void;
}

interface TaskRow {
  id: string;
  prompt: string;
  answer: string;
  aliases: string;
  match: MatchKind;
  corpus: string | null;
}

function tasksDb(suite: SuiteId, dataDir: string): Database.Database {
  const path = join(dataDir, suite, "tasks.sqlite");
  if (!existsSync(path)) throw new Error(`Suite "${suite}" has no data: ${path} is missing. Run its prep step (docs/pilot-runbook.md).`);
  return new Database(path, { readonly: true, fileMustExist: true });
}

export function listTasks(suite: SuiteId, split: "candidate" | "pilot" | "scored", dataDir: string): string[] {
  if (suite === "toy") return Object.keys(TASKS);
  const db = tasksDb(suite, dataDir);
  try {
    return (db.prepare("SELECT id FROM tasks WHERE split = ? ORDER BY id").all(split) as { id: string }[]).map((r) => r.id);
  } finally {
    db.close();
  }
}

export function loadTask(suite: SuiteId, taskId: string, o: { dataDir: string; toolDelayMs: number; toyTasks?: Record<string, ToyTask> }): LoadedTask {
  if (suite === "toy") {
    const toy = (o.toyTasks ?? TASKS)[taskId];
    if (!toy) throw new Error(`unknown task "${taskId}"`);
    return { id: toy.id, prompt: toy.prompt, tools: [readShardTool(toy, o.toolDelayMs)], verify: (a) => toy.verify(a), close: () => {} };
  }
  const db = tasksDb(suite, o.dataDir);
  let row: TaskRow | undefined;
  try {
    row = db.prepare("SELECT id, prompt, answer, aliases, match, corpus FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
  } finally {
    db.close();
  }
  if (!row) throw new Error(`Suite "${suite}" has no task "${taskId}".`);
  const key: AnswerKey = { answer: row.answer, aliases: JSON.parse(row.aliases) as string[], match: row.match };
  const verify = (a: string) => verifyClaim(key, a);
  if (suite === "math") return { id: row.id, prompt: row.prompt, tools: [], verify, close: () => {} };
  if (!row.corpus) throw new Error(`Task "${taskId}" of suite "${suite}" names no corpus.`);
  const path = join(o.dataDir, suite, row.corpus);
  if (!existsSync(path)) throw new Error(`Suite "${suite}" task "${taskId}": ${path} is missing.`);
  const corpus = new Corpus(path);
  return { id: row.id, prompt: row.prompt, tools: corpusTools(corpus, SUITE_TOOLS[suite]), verify, close: () => corpus.close() };
}
```

(Task 3 replaces the `math` line to add `run_python`.)

- [ ] **Step 6: Use the registry in `runOnce`**

In `packages/runtime/src/run/run.ts`:
- Replace the import `import { TASKS, readShardTool, type ToyTask } from "../toy/vault.ts";` with `import type { ToyTask } from "../toy/vault.ts";` and add `import { loadTask } from "../suites/registry.ts";`.
- Replace
  ```ts
  const task = (deps.tasks ?? TASKS)[cfg.taskId];
  if (!task) throw new Error(`unknown task "${cfg.taskId}"`);
  if (cfg.checkServer) await checkServer(cfg.model);
  ```
  with
  ```ts
  const task = loadTask(cfg.suite, cfg.taskId, { dataDir: cfg.dataDir, toolDelayMs: cfg.toolDelayMs, toyTasks: deps.tasks });
  try {
    if (cfg.checkServer) await checkServer(cfg.model);
    return await runLoaded(cfg, deps, task, clock, cond);
  } finally {
    task.close();
  }
}

async function runLoaded(cfg: RunConfig, deps: RunDeps, task: LoadedTask, clock: Clock, cond: Condition): Promise<RunSummary> {
  ```
  so that everything from `const runId = …` to the final `return` becomes the body of `runLoaded` (unchanged except below). Add `import type { LoadedTask } from "../suites/registry.ts";` and `import type { Condition } from "../conditions.ts";` (merge with the existing `CONDITIONS, systemPrompt` import).
- In `runLoaded`, change the agent tool line to use the task's tools:
  ```ts
  const tools = buildTools(cond, id, ctx, task.tools);
  ```
- Keep `{ log, clock, verify: (a) => task.verify(a) }` and `task: task.prompt` as they are; `task.id` in `run_started.taskId` stays `task.id`.

The existing run tests use `taskId: "toy-vault"` without `suite`, so they now go through the `toy` branch of `loadTask`; they must pass unchanged.

- [ ] **Step 7: Run tests and type-check**

Run: `npx vitest run packages/runtime && npx tsc -p tsconfig.json`
Expected: all runtime tests PASS (11 new: 5 corpus, 6 registry; earlier ones unchanged), tsc silent. The end-to-end test covers `bcp` and `ledger` in `single` and `polylogue`; `math` gets its end-to-end test in Task 3.

- [ ] **Step 8: Commit**

```bash
git add packages/runtime/src/suites packages/runtime/src/testing/suite-fixture.ts packages/runtime/src/config.ts packages/runtime/src/run/run.ts
git commit -m "Suite registry: corpus tools (BM25 search, paged reading, listing) and suite tasks in runOnce"
```

---

### Task 3: `run_python` sandbox and the math suite's tool

**Files:**
- Create: `docker/python-sandbox/Dockerfile`, `packages/runtime/src/suites/python-tool.ts`
- Modify: `package.json` (script `sandbox:build`), `packages/runtime/src/suites/registry.ts` (math gets `run_python`)
- Test: `packages/runtime/src/suites/python-tool.test.ts`

**Interfaces:**
- Consumes: `WorkTool` (`tools/work-tool.ts`), `loadTask` (Task 2).
- Produces: `SANDBOX_IMAGE = "polylogue-python:1"`; `interface PythonToolOptions { image: string; timeoutMs: number; memoryMb: number; maxChars: number }`; `PYTHON_DEFAULTS: PythonToolOptions` (`10_000` ms, `512` MB, `4000` chars); `pythonTool(o?: Partial<PythonToolOptions>): WorkTool`; `pythonSandboxReady(image?: string): Promise<boolean>`.

Result text (exact): `"exit code: <c>\n--- stdout ---\n<out>\n--- stderr ---\n<err>"`, where each stream is cut at `maxChars` with the line `[… cut at 4000 characters]` appended. On timeout the first line is `Timed out after <s> s; the process was stopped.` instead of `exit code: …`. Exit code 137 without a timeout → first line `Killed (memory limit <m> MB).`. Docker missing or failing to start → tool error `The Python sandbox is unavailable: <reason>`.

- [ ] **Step 1: The image**

`docker/python-sandbox/Dockerfile`:
```dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir sympy==1.14.0 numpy==2.5.4
USER nobody
```

In root `package.json` add to `scripts`:
```json
"sandbox:build": "docker build -t polylogue-python:1 docker/python-sandbox",
```

Run: `npm run sandbox:build`
Expected: image built (about 1 minute the first time). Measured 2026-10-11: one sandbox call takes about 0.75 s.

- [ ] **Step 2: Write the failing tests**

`packages/runtime/src/suites/python-tool.test.ts`:
```ts
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { pythonSandboxReady, pythonTool } from "./python-tool.ts";

const ready = await pythonSandboxReady();
if (!ready) console.warn("python-tool tests skipped: start Docker and run `npm run sandbox:build`");
const leftovers = () => execFileSync("docker", ["ps", "-q", "--filter", "name=polylogue-py-"]).toString().trim();

describe.skipIf(!ready)("run_python", () => {
  it("runs code with sympy and returns stdout", async () => {
    const out = await pythonTool().run({ code: "import sympy\nprint(sympy.factorint(391))" });
    expect(out).toBe("exit code: 0\n--- stdout ---\n{17: 1, 23: 1}\n\n--- stderr ---\n");
  });

  it("reports errors on stderr with the exit code", async () => {
    const out = await pythonTool().run({ code: "raise ValueError('nope')" });
    expect(out.startsWith("exit code: 1\n")).toBe(true);
    expect(out).toContain("ValueError: nope");
  });

  it("has no network", async () => {
    const out = await pythonTool().run({ code: "import urllib.request\nurllib.request.urlopen('http://example.com', timeout=3)" });
    expect(out).toMatch(/URLError|Errno/);
  });

  it("stops an endless loop at the timeout and leaves no container behind", async () => {
    const out = await pythonTool({ timeoutMs: 2000 }).run({ code: "while True:\n    pass" });
    expect(out.split("\n")[0]).toBe("Timed out after 2 s; the process was stopped.");
    expect(leftovers()).toBe("");
  });

  it("cuts flooding output and survives a fork bomb attempt", async () => {
    const flood = await pythonTool().run({ code: "print('x' * 100000)" });
    expect(flood).toContain("[… cut at 4000 characters]");
    expect(flood.length).toBeLessThan(4300);
    const fork = await pythonTool({ timeoutMs: 4000 }).run({ code: "import os\nfor _ in range(1000):\n    try:\n        os.fork()\n    except OSError as e:\n        print('fork failed', e.errno)\n        break" });
    expect(fork).toMatch(/fork failed|Timed out/);
    expect(leftovers()).toBe("");
  });

  it("enforces the memory limit", async () => {
    const out = await pythonTool().run({ code: "b = b'x' * (1024 ** 3)\nprint(len(b))" });
    expect(out.split("\n")[0]).toMatch(/^Killed \(memory limit 512 MB\)\.$|^exit code: 1$/);
    if (out.startsWith("exit code: 1")) expect(out).toContain("MemoryError");
  });

  it("runs a math task end to end: run_python, then a numeric claim", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { makeSuiteFixture } = await import("../testing/suite-fixture.ts");
    const { parseConfig } = await import("../config.ts");
    const { runOnce } = await import("../run/run.ts");
    const { EventLog } = await import("../log/event-log.ts");
    const { startFakeOpenAI } = await import("../testing/fake-openai.ts");
    const fake = await startFakeOpenAI(({ call }) => (call === 0 ? { toolCalls: [{ name: "run_python", args: { code: "print(6 * 7)" } }] } : { toolCalls: [{ name: "claim", args: { answer: "42", evidence: "computed" } }] }));
    try {
      const dataDir = makeSuiteFixture("math", [{ id: "math-001", prompt: "What is 6 times 7?", answer: "42", match: "numeric" }]);
      const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-math-")), "runs.sqlite"));
      const s = await runOnce(parseConfig({
        condition: "single", suite: "math", taskId: "math-001", dataDir, seed: 1, budget: { tokensPerAgent: 100_000 }, wallClockMs: 30_000,
        rate: { messagesPerMinute: 30, maxMessageChars: 2000 },
        model: { baseUrl: fake.baseUrl, id: "qwen3.8-27b", hfRepo: "unsloth/Qwen3.8-27B-NVFP4", revision: "r", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 30_000, maxRetries: 0 },
      }), { log });
      expect(s.reason).toBe("solved");
      const py = log.events(s.runId).map((e) => e.event).find((e) => e.kind === "tool_result" && e.tool === "run_python");
      expect(py && "text" in py && py.text).toContain("42");
    } finally {
      await fake.close();
    }
  });

  it("is an error when the image does not exist", async () => {
    await expect(pythonTool({ image: "polylogue-python:does-not-exist" }).run({ code: "print(1)" })).rejects.toThrow(/The Python sandbox is unavailable/);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run packages/runtime/src/suites/python-tool.test.ts`
Expected: FAIL, cannot resolve `./python-tool.ts`.

- [ ] **Step 4: Implement**

`packages/runtime/src/suites/python-tool.ts`:
```ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { WorkTool } from "../tools/work-tool.ts";

export const SANDBOX_IMAGE = "polylogue-python:1";

export interface PythonToolOptions {
  image: string;
  timeoutMs: number;
  memoryMb: number;
  maxChars: number;
}
export const PYTHON_DEFAULTS: PythonToolOptions = { image: SANDBOX_IMAGE, timeoutMs: 10_000, memoryMb: 512, maxChars: 4000 };

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("error", () => resolve(-1));
    p.on("close", (code) => resolve(code ?? -1));
  });
}

export async function pythonSandboxReady(image = SANDBOX_IMAGE): Promise<boolean> {
  return (await run("docker", ["image", "inspect", image])) === 0;
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[… cut at ${max} characters]`;
}

export function pythonTool(over: Partial<PythonToolOptions> = {}): WorkTool {
  const o = { ...PYTHON_DEFAULTS, ...over };
  return {
    name: "run_python",
    description: `Run Python 3.12 code (sympy and numpy installed; no network; ${o.timeoutMs / 1000} s and ${o.memoryMb} MB per call). Returns the exit code, stdout and stderr.`,
    parameters: Type.Object({ code: Type.String() }),
    run: (a: { code: string }, signal) =>
      new Promise((resolve, reject) => {
        const name = `polylogue-py-${randomUUID()}`;
        const mem = `${o.memoryMb}m`;
        const p = spawn("docker", [
          "run", "--rm", "-i", "--name", name, "--network", "none", "--memory", mem, "--memory-swap", mem, "--cpus", "1",
          "--pids-limit", "64", "--read-only", "--tmpfs", "/tmp:rw,size=64m", "--user", "65534:65534", o.image, "python", "-",
        ]);
        let out = "";
        let err = "";
        let timedOut = false;
        const keep = (s: string, chunk: Buffer) => (s.length > o.maxChars + 1 ? s : s + chunk.toString());
        p.stdout.on("data", (c: Buffer) => (out = keep(out, c)));
        p.stderr.on("data", (c: Buffer) => (err = keep(err, c)));
        const stop = () => void run("docker", ["kill", name]);
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, o.timeoutMs);
        signal?.addEventListener("abort", stop, { once: true });
        p.on("error", (e) => {
          clearTimeout(timer);
          reject(new Error(`The Python sandbox is unavailable: ${e.message}`));
        });
        p.on("close", (code) => {
          clearTimeout(timer);
          if (code === 125) return reject(new Error(`The Python sandbox is unavailable: ${err.trim().split("\n").at(-1) ?? "docker run failed"}`));
          const head = timedOut
            ? `Timed out after ${o.timeoutMs / 1000} s; the process was stopped.`
            : code === 137
              ? `Killed (memory limit ${o.memoryMb} MB).`
              : `exit code: ${code}`;
          resolve(`${head}\n--- stdout ---\n${cut(out, o.maxChars)}\n--- stderr ---\n${cut(err, o.maxChars)}`);
        });
        p.stdin.on("error", () => {}); // docker may exit before reading stdin (e.g. missing image)
        p.stdin.end(a.code);
      }),
  };
}
```

(Docker exits 125 when it cannot start the container, for example a missing image.)

In `packages/runtime/src/suites/registry.ts`, import `import { pythonTool } from "./python-tool.ts";` and replace the math line with:
```ts
  if (suite === "math") return { id: row.id, prompt: row.prompt, tools: [pythonTool()], verify, close: () => {} };
```
and add to `registry.test.ts`:
```ts
  it("gives math tasks run_python", () => {
    const dir = makeSuiteFixture("math", [{ id: "math-001", prompt: "What is 6 times 7?", answer: "42", match: "numeric" }]);
    const t = loadTask("math", "math-001", { dataDir: dir, toolDelayMs: 0 });
    expect(t.tools.map((x) => x.name)).toEqual(["run_python"]);
    expect(t.verify("The answer is 42.")).toEqual({ passed: true });
  });
```

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run packages/runtime/src/suites && npx tsc -p tsconfig.json`
Expected: 8 python-tool tests PASS (or skip with the warning when Docker is unavailable), 7 registry tests PASS, tsc silent. Then `docker ps -a --filter name=polylogue-py-` lists nothing.

- [ ] **Step 6: Commit**

```bash
git add docker package.json packages/runtime/src/suites
git commit -m "run_python: throwaway Docker sandbox (no network, 10 s, 512 MB) for the math suite"
```

---

### Task 4: Python prep package: verifier, store, model client, tokens, freeze

**Files:**
- Create: `prep/pyproject.toml`, `prep/polyprep/__init__.py`, `prep/polyprep/verify.py`, `prep/polyprep/store.py`, `prep/polyprep/model.py`, `prep/polyprep/tokens.py`, `prep/polyprep/freeze.py`
- Modify: root `package.json` (script `test:prep`)
- Test: `prep/tests/test_verify.py`, `prep/tests/test_store.py`, `prep/tests/test_freeze.py`

**Interfaces:**
- Consumes: `suites/schema.sql`, `suites/corpus.sql`, `suites/verify-vectors.json` (Task 1).
- Produces:
  - `polyprep`: `ROOT: Path` (repo root), `DATA: Path` (`ROOT / "data"`).
  - `verify.py`: `normalize_text(s) -> str`; `numeric_value(s) -> Fraction | None`; `verify_claim(answer, aliases, match, claim) -> tuple[bool, str | None]`; `answer_hash(answer, match) -> str` (hex SHA-256 of `normalize_text(answer)`, or of `"<num>/<den>"` for numeric).
  - `store.py`: `open_tasks(path: Path) -> sqlite3.Connection`; `put_task(con, *, id, split, prompt, answer, match, aliases=(), corpus=None, info=None) -> None` (insert or replace); `set_split(con, task_id, split) -> None`; `write_corpus(path: Path, docs: Iterable[tuple[str, str, str]]) -> int` (replaces the file; returns the doc count); `set_meta(con, key, value)`.
  - `model.py`: `check_server(server, model_id, hf_repo) -> None`; `chat(server, model_id, messages, *, seed, max_tokens, reasoning_effort, timeout=1800, retries=3) -> dict` with keys `content`, `reasoning`, `usage`.
  - `tokens.py`: `Counter = Callable[[str], int]`; `char_counter(s) -> int` (`ceil(len/3)`); `qwen_counter() -> Counter` (pinned tokenizer).
  - `freeze.py`: `manifest(suite: str, tasks_db: Path) -> dict`; CLI `python -m polyprep.freeze <suite> [--check]` writing or checking `suites/<suite>/frozen.json`.

- [ ] **Step 1: Package files**

`prep/pyproject.toml`:
```toml
[project]
name = "polyprep"
version = "0.0.0"
requires-python = ">=3.12"
dependencies = ["datasets==5.1.0", "huggingface_hub==2.2.0", "tokenizers==0.23.3"]

[dependency-groups]
dev = ["pytest==9.1.1"]

[build-system]
requires = ["hatchling==1.32.4"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["polyprep"]
```

`prep/polyprep/__init__.py`:
```python
"""Data preparation for the polylogue task suites. Writes only under data/ (git-ignored)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
```

Root `package.json` scripts, add:
```json
"test:prep": "uv run --project prep pytest -q prep/tests",
```

Run: `uv sync --project prep`
Expected: a `prep/.venv` (git-ignored by the `.venv` rule) with the pinned packages. Measured 2026-10-11: these pins resolve and install.

- [ ] **Step 2: Write the failing tests**

`prep/tests/test_verify.py`:
```python
import json
from fractions import Fraction

import pytest

from polyprep import ROOT
from polyprep.verify import answer_hash, normalize_text, numeric_value, verify_claim

VECTORS = json.loads((ROOT / "suites" / "verify-vectors.json").read_text())


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: f"{c['match']}:{c['claim']!r}")
def test_vectors_match_the_typescript_verifier(case):
    passed, _ = verify_claim(case["answer"], case["aliases"], case["match"], case["claim"])
    assert passed is case["passed"]


@pytest.mark.parametrize("case", VECTORS["normalize"], ids=lambda c: c["in"])
def test_normalize_vectors(case):
    assert normalize_text(case["in"]) == case["out"]


def test_numeric_value_and_hash():
    assert numeric_value("-\\frac{2}{4}") == Fraction(-1, 2)
    assert numeric_value("1 and 2") is None
    assert answer_hash("3/4", "numeric") == answer_hash("0.75", "numeric")
    assert answer_hash("The Hobbit", "exact") == answer_hash("hobbit", "contains")
    assert len(answer_hash("x", "exact")) == 64


def test_failure_details():
    assert verify_claim("204", [], "numeric", "between 200 and 210") == (False, "no single number in the claim: between 200 and 210")
    assert verify_claim("Lyon", [], "exact", "Ghent") == (False, "expected Lyon, got Ghent")
```

`prep/tests/test_store.py`:
```python
import json
import sqlite3

from polyprep.store import open_tasks, put_task, set_split, write_corpus


def test_tasks_round_trip(tmp_path):
    con = open_tasks(tmp_path / "bcp" / "tasks.sqlite")
    put_task(con, id="bcp-1", split="candidate", prompt="Q?", answer="A", match="contains", aliases=["a1"], corpus="corpus.sqlite", info={"query_id": "1"})
    set_split(con, "bcp-1", "pilot")
    row = con.execute("SELECT split, aliases, info, corpus FROM tasks WHERE id = 'bcp-1'").fetchone()
    assert row == ("pilot", '["a1"]', '{"query_id": "1"}', "corpus.sqlite")


def test_corpus_has_a_working_fts_index(tmp_path):
    path = tmp_path / "corpus.sqlite"
    n = write_corpus(path, [("d1", "Harbour", "The ferry to Ghent was delayed."), ("d2", "Memo", "Kessler AG supplied copper wire.")])
    assert n == 2
    con = sqlite3.connect(path)
    hits = con.execute("SELECT d.id FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid WHERE docs_fts MATCH '\"copper\"' ORDER BY bm25(docs_fts)").fetchall()
    assert hits == [("d2",)]
    assert write_corpus(path, [("d9", "Only", "one")]) == 1  # replaces the file
```

`prep/tests/test_freeze.py`:
```python
import json

import pytest

from polyprep import DATA, ROOT
from polyprep.freeze import manifest
from polyprep.store import open_tasks, put_task
from polyprep.verify import answer_hash


def test_manifest_has_hashes_not_answers(tmp_path):
    db = tmp_path / "tasks.sqlite"
    con = open_tasks(db)
    put_task(con, id="m-2", split="scored", prompt="p", answer="42", match="numeric", info={"source": "AIME 2026 I"})
    put_task(con, id="m-1", split="pilot", prompt="p", answer="7", match="numeric")
    put_task(con, id="m-0", split="candidate", prompt="p", answer="1", match="numeric")
    con.commit()
    m = manifest("math", db)
    assert [t["id"] for t in m["tasks"]] == ["m-1", "m-2"]
    assert m["tasks"][1] == {"id": "m-2", "split": "scored", "match": "numeric", "answer_sha256": answer_hash("42", "numeric"), "info": {"source": "AIME 2026 I"}}
    assert "answer" not in m["tasks"][1]


@pytest.mark.parametrize("suite", ["bcp", "ledger", "math"])
def test_frozen_manifests_match_data(suite):
    frozen = ROOT / "suites" / suite / "frozen.json"
    db = DATA / suite / "tasks.sqlite"
    if not frozen.exists() or not db.exists():
        pytest.skip(f"{suite}: no frozen.json or no data/ (only checked after the freeze, where data/ exists)")
    assert manifest(suite, db)["tasks"] == json.loads(frozen.read_text())["tasks"]
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm run test:prep`
Expected: FAIL, `ModuleNotFoundError: No module named 'polyprep.verify'`.

- [ ] **Step 4: Implement**

`prep/polyprep/verify.py`:
```python
"""Answer verification. Mirrors packages/runtime/src/suites/verify.ts; both pass suites/verify-vectors.json."""
from __future__ import annotations

import hashlib
import re
import unicodedata
from fractions import Fraction

ARTICLES = {"a", "an", "the"}
THOUSANDS = re.compile(r"([0-9]),(?=[0-9]{3}(?![0-9]))")
NUMBER = re.compile(r"-?\\d?frac\{-?[0-9]+\}\{[0-9]+\}|-?[0-9]+\.[0-9]+|-?\.[0-9]+|-?[0-9]+/[0-9]+|-?[0-9]+")


def normalize_text(s: str) -> str:
    s = THOUSANDS.sub(r"\1", unicodedata.normalize("NFKC", s).lower())
    s = "".join(ch if (ch.isalpha() or ch.isnumeric()) else " " for ch in s)
    return " ".join(w for w in s.split() if w not in ARTICLES)


def _parse(tok: str) -> Fraction | None:
    if m := re.fullmatch(r"(-?)\\d?frac\{(-?[0-9]+)\}\{([0-9]+)\}", tok):
        return None if int(m[3]) == 0 else Fraction((-1 if m[1] else 1) * int(m[2]), int(m[3]))
    if m := re.fullmatch(r"(-?[0-9]+)/([0-9]+)", tok):
        return None if int(m[2]) == 0 else Fraction(int(m[1]), int(m[2]))
    if m := re.fullmatch(r"(-?)([0-9]*)\.([0-9]+)", tok):
        n = int((m[2] or "0") + m[3])
        return Fraction(-n if m[1] else n, 10 ** len(m[3]))
    if re.fullmatch(r"-?[0-9]+", tok):
        return Fraction(int(tok))
    return None


def numeric_value(s: str) -> Fraction | None:
    tokens = NUMBER.findall(THOUSANDS.sub(r"\1", unicodedata.normalize("NFKC", s)))
    return _parse(tokens[0]) if len(tokens) == 1 else None


def verify_claim(answer: str, aliases: list[str], match: str, claim: str) -> tuple[bool, str | None]:
    shown = claim.strip()[:200]
    targets = [answer, *aliases]
    if match == "numeric":
        got = numeric_value(claim)
        if got is None:
            return False, f"no single number in the claim: {shown}"
        return (True, None) if any(numeric_value(t) == got for t in targets) else (False, f"expected {answer}, got {shown}")
    c = normalize_text(claim)
    if c:
        for t in (normalize_text(x) for x in targets):
            if not t:
                continue
            if c == t:
                return True, None
            if match == "contains" and len(c) <= 3 * len(t) and f" {t} " in f" {c} ":
                return True, None
    return False, f"expected {answer}, got {shown}"


def answer_hash(answer: str, match: str) -> str:
    if match == "numeric":
        v = numeric_value(answer)
        if v is None:
            raise ValueError(f"numeric answer {answer!r} has no single number")
        key = f"{v.numerator}/{v.denominator}"
    else:
        key = normalize_text(answer)
    return hashlib.sha256(key.encode()).hexdigest()
```

`prep/polyprep/store.py`:
```python
"""SQLite files under data/<suite>/, with the shared SQL in suites/."""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from pathlib import Path

from polyprep import ROOT

SCHEMA = (ROOT / "suites" / "schema.sql").read_text()
CORPUS = (ROOT / "suites" / "corpus.sql").read_text()


def open_tasks(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    return con


def put_task(con, *, id, split, prompt, answer, match, aliases=(), corpus=None, info=None) -> None:
    con.execute(
        "INSERT OR REPLACE INTO tasks (id, split, prompt, answer, aliases, match, corpus, info) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (id, split, prompt, answer, json.dumps(list(aliases)), match, corpus, json.dumps(info or {})),
    )
    con.commit()


def set_split(con, task_id: str, split: str) -> None:
    con.execute("UPDATE tasks SET split = ? WHERE id = ?", (split, task_id))
    con.commit()


def set_meta(con, key: str, value: str) -> None:
    con.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))
    con.commit()


def write_corpus(path: Path, docs: Iterable[tuple[str, str, str]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    for p in (path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")):
        p.unlink(missing_ok=True)
    con = sqlite3.connect(path)
    con.executescript(CORPUS)
    n = 0
    batch = []
    for doc_id, title, body in docs:
        batch.append((doc_id, n, title, body))
        n += 1
        if len(batch) == 5000:
            con.executemany("INSERT INTO docs (id, ord, title, body) VALUES (?, ?, ?, ?)", batch)
            batch = []
    con.executemany("INSERT INTO docs (id, ord, title, body) VALUES (?, ?, ?, ?)", batch)
    con.execute("INSERT INTO docs_fts(docs_fts) VALUES ('rebuild')")
    con.commit()
    con.close()
    return n
```

`prep/polyprep/model.py`:
```python
"""Minimal OpenAI-compatible client for the oracle screen (same sampling rules as runs: temperature 0, seed, chat_template_kwargs)."""
from __future__ import annotations

import json
import time
import urllib.request


def _get(url: str, timeout: float) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def check_server(server: str, model_id: str, hf_repo: str) -> None:
    try:
        body = _get(f"{server}/models", 10)
    except OSError as e:
        raise RuntimeError(f"model server at {server} is unreachable: {e}") from e
    served = next((m for m in body.get("data", []) if m.get("id") == model_id), None)
    if served is None:
        raise RuntimeError(f'model server at {server} does not serve "{model_id}"')
    if served.get("root") != hf_repo:
        raise RuntimeError(f'model "{model_id}" serves {served.get("root")}, expected {hf_repo}')


def chat(server, model_id, messages, *, seed, max_tokens, reasoning_effort, timeout=1800, retries=3) -> dict:
    payload = {
        "model": model_id,
        "messages": messages,
        "temperature": 0,
        "seed": seed,
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"reasoning_effort": reasoning_effort},
    }
    req = urllib.request.Request(f"{server}/chat/completions", data=json.dumps(payload).encode(), headers={"content-type": "application/json"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = json.load(r)
            msg = body["choices"][0]["message"]
            return {"content": msg.get("content") or "", "reasoning": msg.get("reasoning_content") or msg.get("reasoning") or "", "usage": body.get("usage", {})}
        except OSError:
            if attempt == retries:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")
```

`prep/polyprep/tokens.py`:
```python
"""Token counters for sizing the ledger corpus."""
from __future__ import annotations

import math
from collections.abc import Callable

Counter = Callable[[str], int]
TOKENIZER_REPO = "unsloth/Qwen3.8-27B-NVFP4"
TOKENIZER_REVISION = "7d6f8d4d72f56b92b3cdbf22f156b90e1bab0108"


def char_counter(s: str) -> int:
    """Rough stand-in for tests: about 3 characters per token (measured on ledger prose with the Qwen tokenizer)."""
    return math.ceil(len(s) / 3)


def qwen_counter() -> Counter:
    from tokenizers import Tokenizer

    tok = Tokenizer.from_pretrained(TOKENIZER_REPO, revision=TOKENIZER_REVISION)
    return lambda s: len(tok.encode(s).ids)
```

`prep/polyprep/freeze.py`:
```python
"""Writes or checks suites/<suite>/frozen.json: task ids, splits and answer hashes, never answers."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from polyprep import DATA, ROOT
from polyprep.verify import answer_hash


def manifest(suite: str, tasks_db: Path) -> dict:
    con = sqlite3.connect(tasks_db)
    rows = con.execute("SELECT id, split, match, answer, info FROM tasks WHERE split IN ('pilot', 'scored') ORDER BY id").fetchall()
    con.close()
    return {
        "suite": suite,
        "tasks": [{"id": i, "split": s, "match": m, "answer_sha256": answer_hash(a, m), "info": json.loads(info)} for i, s, m, a, info in rows],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("suite", choices=["bcp", "ledger", "math"])
    ap.add_argument("--check", action="store_true", help="compare data/ against the committed frozen.json")
    a = ap.parse_args(argv)
    m = manifest(a.suite, DATA / a.suite / "tasks.sqlite")
    out = ROOT / "suites" / a.suite / "frozen.json"
    if a.check:
        ok = out.exists() and json.loads(out.read_text())["tasks"] == m["tasks"]
        print(f"{a.suite}: frozen.json {'matches' if ok else 'does NOT match'} data/")
        return 0 if ok else 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {out} ({len(m['tasks'])} tasks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Run tests**

Run: `npm run test:prep`
Expected: 32 passed, 3 skipped (23 + 4 vectors, 2 verify, 2 store, 1 freeze; the 3 frozen-vs-data checks skip until the freeze).

- [ ] **Step 6: Commit**

```bash
git add prep package.json
git commit -m "Prep package: verifier mirror, suite store, model client, token counters, freeze"
```

---

### Task 5: The `ledger` generator

**Files:**
- Create: `prep/polyprep/ledger.py`, `prep/polyprep/ledger_parse.py`, `prep/polyprep/ledger_gen.py`
- Test: `prep/tests/test_ledger.py`

**Interfaces:**
- Consumes: `store.open_tasks/put_task/write_corpus`, `tokens.char_counter/qwen_counter`, `verify.verify_claim` (Task 4).
- Produces:
  - `ledger.py`: `GENERATOR_VERSION = "ledger-1"`; dataclasses `Shipment(id, date, supplier, product, batch, city, qty)`, `Correction(shipment, field, old, new, date)`, `Transfer(old, new, date)`, `Records(shipments, recalls, corrections, transfers)`; `effective(r: Records) -> list[Shipment]`; `owner(r, s) -> str`; `Question(template, text, answer, match)`; `ask(r: Records, template: str, rng) -> Question | None`; `render(r: Records, rng) -> list[tuple[str, str, str]]` (doc id, title, body); `generate(seed: int, target_tokens: int, count: Counter) -> World` where `World(records, question, docs, tokens, shipments)`; `prompt(question_text) -> str`.
  - `ledger_parse.py`: `parse(docs) -> Records`.
  - `ledger_gen.py`: CLI `python -m polyprep.ledger_gen --budget B [--seeds 1-35] [--pilot 5] [--split-seed 2026]` writing `data/ledger/tasks.sqlite` and `data/ledger/corpus-ledger-<NNN>.sqlite`.

World rules (implement exactly):
- `rng = random.Random(seed)`. 8 suppliers, 10 cities, 5 products sampled from the fixed lists below; 2 batches per (supplier, product) pair, ids `B-001…`.
- `n` shipments `SH-0001…`: random supplier, product, one of its two batches, random city, a date in 2024 (`2024-01-01` + 0..365 days), quantity 10..500.
- Recalls: `max(1, len(batches) // 10)` batches. Corrections: `max(2, n // 12)` shipments, each changing either `city` (to another city) or `qty` (to another value 10..500), dated 5..60 days after the shipment. Transfers: 2, old suppliers distinct, new supplier not one of the olds, dated `2024-03-01` + 0..213 days.
- `effective`: apply corrections in date order (a later correction of the same field wins), then drop shipments whose batch is recalled. `owner(s)`: the transfer's new supplier when `s.supplier` is a transfer's old supplier and `s.date >= transfer.date`; otherwise `s.supplier`.
- Template by `seed % 3`: `A` (supplier with the most distinct cities, by owner; answer must be a unique maximum; match `contains`), `B` (units of one product delivered to one city; candidates tried in random order; needs a positive answer that differs from the count without corrections and recalls; match `numeric`), `C` (city with the largest total quantity from the supplier that took over one old supplier's contracts, counting shipments owned by that new supplier dated on or after the takeover; unique maximum; match `contains`).
- If `ask` returns `None`, the world is rebuilt from `random.Random(seed * 1000 + attempt)` for attempt 1..49; after 50 failures `generate` raises.
- Size: start at `n = 60`; render, count tokens over every title and body, and if not within ±5% of `target_tokens`, set `n = max(20, round(n * target / tokens))` and rebuild; at most 8 rounds. The final world is stored whatever its size; the test checks ±10%.
- Documents: one per shipment, correction, recall and transfer, plus `max(3, n // 10)` memos; shuffled with the render rng; ids `D-0001…` in shuffled order; `ord` = that order.

- [ ] **Step 1: Write the failing tests**

`prep/tests/test_ledger.py`:
```python
import random

import pytest

from polyprep.ledger import effective, generate, owner, prompt
from polyprep.ledger_parse import parse
from polyprep.ledger import ask
from polyprep.tokens import char_counter
from polyprep.verify import verify_claim

TARGET = 30_000


@pytest.fixture(scope="module", params=[1, 2, 3])
def world(request):
    return generate(request.param, TARGET, char_counter)


def test_deterministic_per_seed():
    a = generate(7, TARGET, char_counter)
    b = generate(7, TARGET, char_counter)
    assert a.docs == b.docs and a.question == b.question
    assert generate(8, TARGET, char_counter).docs != a.docs


def test_size_within_ten_percent(world):
    assert abs(world.tokens - TARGET) / TARGET <= 0.10


def test_answer_recomputed_from_the_documents(world):
    parsed = parse(world.docs)
    assert len(parsed.shipments) == world.shipments
    again = ask(parsed, world.question.template, random.Random(0), fixed=world.question)
    assert again is not None
    assert again.answer == world.question.answer
    ok, _ = verify_claim(world.question.answer, [], world.question.match, world.question.answer)
    assert ok


def test_corrections_override_and_recalls_exclude():
    w = generate(4, TARGET, char_counter)
    r = parse(w.docs)
    eff = {s.id: s for s in effective(r)}
    for c in r.corrections:
        s = eff.get(c.shipment)
        if s is None:
            continue
        later = [x for x in r.corrections if x.shipment == c.shipment and x.field == c.field and x.date > c.date]
        if not later:
            assert getattr(s, c.field) == c.new
    recalled = set(r.recalls)
    assert all(s.batch not in recalled for s in eff.values())


def test_transfers_change_owner_only_from_their_date():
    w = generate(5, TARGET, char_counter)
    r = parse(w.docs)
    for t in r.transfers:
        for s in r.shipments:
            if s.supplier == t.old:
                assert owner(r, s) == (t.new if s.date >= t.date else s.supplier)


def test_templates_cover_all_three_and_prompt_mentions_tools():
    templates = {generate(s, 8_000, char_counter).question.template for s in (3, 4, 5)}
    assert templates == {"A", "B", "C"}
    p = prompt("Which city?")
    assert "search(query)" in p and "list_docs(page)" in p and p.endswith("Question: Which city?")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run --project prep pytest -q prep/tests/test_ledger.py`
Expected: FAIL, `ModuleNotFoundError: No module named 'polyprep.ledger'`.

- [ ] **Step 3: Implement `ledger.py`**

`prep/polyprep/ledger.py`:
```python
"""Seeded generator for the `ledger` suite: a trading company's 2024 records as prose documents.

Every agent can read every document, but reading all of them costs about twice one agent's budget,
so one agent cannot cover the evidence and four can if they split it (spec §4.2).
"""
from __future__ import annotations

import datetime as dt
import random
from collections import defaultdict
from dataclasses import dataclass, replace

from polyprep.tokens import Counter

GENERATOR_VERSION = "ledger-1"

SUPPLIERS = ["Kessler AG", "Brandt Logistics", "Halvorsen & Daughters", "Marchetti Trading", "Okafor Freight", "Lindqvist Supply",
             "Duarte Hermanos", "Novak & Sons", "Ashworth Metals", "Tanaka Shoji", "Petrov Industrial", "Moreau Export"]
CITIES = ["Lyon", "Ghent", "Porto", "Gdansk", "Bilbao", "Turin", "Leipzig", "Aarhus", "Brno", "Graz", "Tampere", "Cork", "Utrecht", "Malmo"]
PRODUCTS = ["copper wire", "steel brackets", "ceramic insulators", "pump housings", "valve seals", "cable drums", "bearing kits", "fuse panels"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
# Filler must not contain digits, ids, supplier, city or product names (ledger_parse relies on that).
FILLER = [
    "The driver reported light traffic on the ring road.",
    "Customs paperwork was completed without remarks.",
    "The pallets were wrapped twice because rain was forecast.",
    "A forklift at the receiving dock was out of service for the morning.",
    "The receiving clerk countersigned the delivery note on arrival.",
    "Seals on the container were intact when it was opened.",
    "The consignment waited briefly at the gate for a security check.",
    "Two crates were restacked after a strap came loose in transit.",
    "The carrier's tracking feed lagged behind the truck for most of the trip.",
    "Unloading took longer than usual because the yard was crowded.",
    "The warehouse team logged the goods into the incoming zone first.",
    "A spot check found the labels legible and the packaging dry.",
    "The haulier asked for an earlier slot next time.",
    "Paper copies of the invoice travelled with the load.",
    "The dock supervisor noted a short delay at the weighbridge.",
    "The goods were moved to racking before the end of the shift.",
    "No damage was recorded on the condition report.",
    "The trailer was swept and returned the same afternoon.",
    "The route avoided the bridge works announced the week before.",
    "The temperature log stayed within the agreed range.",
    "A replacement driver took over at the border crossing.",
    "Handling instructions were printed on every outer carton.",
    "The night shift confirmed the count against the manifest.",
    "Stacking height limits were respected throughout.",
    "The receiving bay was cleaned before the trailer reversed in.",
    "Shrink wrap on one pallet was patched at the dock.",
    "The transport planner flagged the trip as routine.",
    "The delivery window was met with time to spare.",
    "A photo of the open trailer was attached to the file.",
    "The quality team saw no need for a second inspection.",
]
MEMO_TOPICS = ["Office move", "Parking rules", "Holiday rota", "Printer replacement", "Canteen hours", "Safety briefing", "Visitor badges", "Archive cleanup"]


@dataclass(frozen=True)
class Shipment:
    id: str
    date: dt.date
    supplier: str
    product: str
    batch: str
    city: str
    qty: int


@dataclass(frozen=True)
class Correction:
    shipment: str
    field: str  # "city" | "qty"
    old: str | int
    new: str | int
    date: dt.date


@dataclass(frozen=True)
class Transfer:
    old: str
    new: str
    date: dt.date


@dataclass(frozen=True)
class Records:
    shipments: list[Shipment]
    recalls: list[str]
    corrections: list[Correction]
    transfers: list[Transfer]


@dataclass(frozen=True)
class Question:
    template: str
    text: str
    answer: str
    match: str
    params: tuple = ()


@dataclass(frozen=True)
class World:
    records: Records
    question: Question
    docs: list[tuple[str, str, str]]
    tokens: int
    shipments: int


def fmt(d: dt.date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def build(seed: int, n: int) -> Records:
    rng = random.Random(seed)
    suppliers = rng.sample(SUPPLIERS, 8)
    cities = rng.sample(CITIES, 10)
    products = rng.sample(PRODUCTS, 5)
    batches: dict[tuple[str, str], list[str]] = {}
    k = 0
    for s in suppliers:
        for p in products:
            batches[(s, p)] = [f"B-{k + 1:03d}", f"B-{k + 2:03d}"]
            k += 2
    start = dt.date(2024, 1, 1)
    shipments = []
    for i in range(n):
        s, p = rng.choice(suppliers), rng.choice(products)
        shipments.append(Shipment(f"SH-{i + 1:04d}", start + dt.timedelta(days=rng.randint(0, 365)), s, p, rng.choice(batches[(s, p)]), rng.choice(cities), rng.randint(10, 500)))
    all_batches = [b for bs in batches.values() for b in bs]
    recalls = sorted(rng.sample(all_batches, max(1, len(all_batches) // 10)))
    corrections = []
    for s in rng.sample(shipments, max(2, n // 12)):
        when = s.date + dt.timedelta(days=rng.randint(5, 60))
        if rng.random() < 0.5:
            corrections.append(Correction(s.id, "city", s.city, rng.choice([c for c in cities if c != s.city]), when))
        else:
            corrections.append(Correction(s.id, "qty", s.qty, rng.choice([q for q in range(10, 501) if q != s.qty]), when))
    olds = rng.sample(suppliers, 2)
    transfers = [Transfer(o, rng.choice([x for x in suppliers if x not in olds]), dt.date(2024, 3, 1) + dt.timedelta(days=rng.randint(0, 213))) for o in olds]
    return Records(shipments, recalls, corrections, transfers)


def effective(r: Records) -> list[Shipment]:
    by_id = {s.id: s for s in r.shipments}
    for c in sorted(r.corrections, key=lambda c: c.date):
        if c.shipment in by_id:
            by_id[c.shipment] = replace(by_id[c.shipment], **{c.field: c.new})
    recalled = set(r.recalls)
    return [s for s in by_id.values() if s.batch not in recalled]


def owner(r: Records, s: Shipment) -> str:
    for t in r.transfers:
        if s.supplier == t.old and s.date >= t.date:
            return t.new
    return s.supplier


def _unique_max(scores: dict[str, int]) -> str | None:
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    if not ranked or (len(ranked) > 1 and ranked[0][1] == ranked[1][1]):
        return None
    return ranked[0][0]


def ask(r: Records, template: str, rng: random.Random, fixed: Question | None = None) -> Question | None:
    eff = effective(r)
    if template == "A":
        cities: dict[str, set[str]] = defaultdict(set)
        for s in eff:
            cities[owner(r, s)].add(s.city)
        best = _unique_max({k: len(v) for k, v in cities.items()})
        if best is None:
            return None
        text = ("Which supplier delivered to the most distinct cities in 2024? Apply every correction, leave out shipments from recalled batches, "
                "and count a shipment made under a transferred contract on or after the transfer date for the supplier that took the contract over. "
                "Answer with the supplier's name.")
        return Question("A", text, best, "contains")
    if template == "B":
        pairs = sorted({(s.product, s.city) for s in r.shipments})
        if fixed is not None:
            pairs = [fixed.params]
        else:
            rng.shuffle(pairs)
        for product, city in pairs:
            true = sum(s.qty for s in eff if s.product == product and s.city == city)
            naive = sum(s.qty for s in r.shipments if s.product == product and s.city == city)
            if true > 0 and (true != naive or fixed is not None):
                text = f"How many units of {product} were delivered to {city} in 2024? Apply every correction and leave out shipments from recalled batches. Answer with a number."
                return Question("B", text, str(true), "numeric", (product, city))
        return None
    if template == "C":
        t = r.transfers[0] if fixed is None else next(x for x in r.transfers if x.old == fixed.params[0])
        totals: dict[str, int] = defaultdict(int)
        for s in eff:
            if owner(r, s) == t.new and s.date >= t.date:
                totals[s.city] += s.qty
        best = _unique_max(totals)
        if best is None:
            return None
        text = (f"Which city received the largest total quantity from the supplier that took over {t.old}'s contracts, counting only shipments "
                "on or after the takeover date (its own and those under the transferred contracts)? Apply every correction and leave out "
                "recalled batches. Answer with the city's name.")
        return Question("C", text, best, "contains", (t.old,))
    raise ValueError(template)


def _filler(rng: random.Random, lo: int, hi: int) -> str:
    return " ".join(rng.sample(FILLER, rng.randint(lo, hi)))


def render(r: Records, rng: random.Random) -> list[tuple[str, str, str]]:
    docs: list[tuple[str, str]] = []
    for s in r.shipments:
        d = fmt(s.date)
        body = rng.choice([
            f"On {d}, {s.supplier} dispatched {s.qty} units of {s.product} to {s.city}. The consignment, recorded as shipment {s.id}, came from batch {s.batch}.",
            f"Shipment {s.id} ({s.product}, batch {s.batch}) left the {s.supplier} yard and reached {s.city} on {d}. It carried {s.qty} units.",
            f"{s.city} received {s.qty} units of {s.product} on {d} under shipment {s.id}. Supplier: {s.supplier}. Batch reference: {s.batch}.",
            f"Logged {d}: {s.supplier}, shipment {s.id}, {s.qty} units of {s.product}, batch {s.batch}, delivered to {s.city}.",
        ])
        docs.append((f"Shipment record {s.id}", f"{body}\n\nHandling report. {_filler(rng, 8, 14)}"))
    for c in r.corrections:
        what = f"was delivered to {c.new}, not {c.old}" if c.field == "city" else f"carried {c.new} units, not {c.old}"
        docs.append((f"Correction to {c.shipment}", f"Correction issued {fmt(c.date)}: shipment {c.shipment} {what} as first recorded. {_filler(rng, 2, 4)}"))
    for b in r.recalls:
        docs.append((f"Recall notice for {b}", f"Recall notice: batch {b} is withdrawn. Every shipment from batch {b} is void for delivery statistics. {_filler(rng, 2, 4)}"))
    for t in r.transfers:
        docs.append((f"Contract transfer: {t.old}", f"Contract transfer: from {fmt(t.date)}, {t.new} took over all contracts of {t.old}. Shipments under those contracts on or after that date count for {t.new}. {_filler(rng, 2, 4)}"))
    for _ in range(max(3, len(r.shipments) // 10)):
        docs.append((f"Memo: {rng.choice(MEMO_TOPICS)}", _filler(rng, 6, 10)))
    rng.shuffle(docs)
    return [(f"D-{i + 1:04d}", title, body) for i, (title, body) in enumerate(docs)]


def _world(seed: int, n: int) -> tuple[Records, Question]:
    template = "ABC"[seed % 3]
    for attempt in range(50):
        r = build(seed if attempt == 0 else seed * 1000 + attempt, n)
        q = ask(r, template, random.Random(seed * 31 + attempt))
        if q is not None:
            return r, q
    raise RuntimeError(f"ledger seed {seed}: no valid question after 50 worlds")


def generate(seed: int, target_tokens: int, count: Counter) -> World:
    n = 60
    for _ in range(8):
        r, q = _world(seed, n)
        docs = render(r, random.Random(seed * 7919 + n))
        tokens = sum(count(t) + count(b) for _, t, b in docs)
        if abs(tokens - target_tokens) / target_tokens <= 0.05:
            break
        n = max(20, round(n * target_tokens / tokens))
    return World(r, q, docs, tokens, len(r.shipments))


def prompt(question: str) -> str:
    return ("The documents in this collection are the 2024 records of a trading company: shipments, corrections, recall notices, contract "
            "transfers and memos. search(query) finds documents by keywords, read_doc(id, page) reads one, and list_docs(page) lists them all "
            f"in order.\n\nQuestion: {question}")
```

Note `test_answer_recomputed_from_the_documents` passes `fixed=world.question` so templates B and C recompute the same product/city or the same transfer from the parsed records.

- [ ] **Step 4: Implement `ledger_parse.py` and `ledger_gen.py`**

`prep/polyprep/ledger_parse.py`:
```python
"""Reads rendered ledger documents back into Records. Used by tests to check that the answer follows from the text."""
from __future__ import annotations

import datetime as dt
import re

from polyprep.ledger import CITIES, MONTHS, PRODUCTS, SUPPLIERS, Correction, Records, Shipment, Transfer

DATE = re.compile(r"(\d{1,2}) (" + "|".join(MONTHS) + r") (\d{4})")


def _date(text: str) -> dt.date:
    m = DATE.search(text)
    assert m, text
    return dt.date(int(m[3]), MONTHS.index(m[2]) + 1, int(m[1]))


def _one(text: str, names: list[str]) -> str:
    found = [n for n in names if n in text]
    assert len(found) == 1, (found, text)
    return found[0]


def parse(docs: list[tuple[str, str, str]]) -> Records:
    shipments, recalls, corrections, transfers = [], [], [], []
    for _, title, body in docs:
        head = body.split("\n\nHandling report.")[0]
        if title.startswith("Shipment record "):
            shipments.append(Shipment(
                re.search(r"SH-\d{4}", head)[0], _date(head), _one(head, SUPPLIERS), _one(head, PRODUCTS),
                re.search(r"B-\d{3}", head)[0], _one(head, CITIES), int(re.search(r"(\d+) units", head)[1]),
            ))
        elif title.startswith("Correction to "):
            sid = re.search(r"shipment (SH-\d{4})", body)[1]
            if m := re.search(r"was delivered to (.+?), not (.+?) as first recorded", body):
                corrections.append(Correction(sid, "city", m[2], m[1], _date(body)))
            else:
                m = re.search(r"carried (\d+) units, not (\d+) as first recorded", body)
                corrections.append(Correction(sid, "qty", int(m[2]), int(m[1]), _date(body)))
        elif title.startswith("Recall notice for "):
            recalls.append(re.search(r"B-\d{3}", body)[0])
        elif title.startswith("Contract transfer: "):
            m = re.search(r"from (.+?), (.+?) took over all contracts of (.+?)\. ", body)
            transfers.append(Transfer(m[3], m[2], _date(m[1])))
    shipments.sort(key=lambda s: s.id)
    order = {t.old: i for i, t in enumerate(transfers)}
    return Records(shipments, sorted(recalls), corrections, sorted(transfers, key=lambda t: order[t.old]))
```

Because `render` shuffles documents, the parsed transfer order can differ from the generated one; `ask` with `fixed` finds template C's transfer by its old supplier, and templates A and B do not depend on transfer order (owner lookups use every transfer). `owner` returns the first matching transfer; the two old suppliers are distinct, so at most one matches.

`prep/polyprep/ledger_gen.py`:
```python
"""Builds the ledger suite: one generated world per task, at a target reading cost of about 2 × B tokens (spec §4.2, §5)."""
from __future__ import annotations

import argparse
import random
import sys

from polyprep import DATA
from polyprep.ledger import GENERATOR_VERSION, generate, prompt
from polyprep.store import open_tasks, put_task, set_meta, write_corpus
from polyprep.tokens import qwen_counter


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--budget", type=int, required=True, help="B for ledger (= B_bcp from P0)")
    ap.add_argument("--seeds", default="1-35")
    ap.add_argument("--pilot", type=int, default=5)
    ap.add_argument("--split-seed", type=int, default=2026)
    a = ap.parse_args(argv)
    lo, hi = (int(x) for x in a.seeds.split("-"))
    seeds = list(range(lo, hi + 1))
    count = qwen_counter()
    con = open_tasks(DATA / "ledger" / "tasks.sqlite")
    con.execute("DELETE FROM tasks")
    order = seeds[:]
    random.Random(a.split_seed).shuffle(order)
    pilot = set(order[: a.pilot])
    for seed in seeds:
        w = generate(seed, 2 * a.budget, count)
        tid = f"ledger-{seed:03d}"
        corpus = f"corpus-{tid}.sqlite"
        write_corpus(DATA / "ledger" / corpus, w.docs)
        put_task(con, id=tid, split="pilot" if seed in pilot else "scored", prompt=prompt(w.question.text), answer=w.question.answer,
                 match=w.question.match, corpus=corpus,
                 info={"generator": GENERATOR_VERSION, "seed": seed, "budget": a.budget, "template": w.question.template, "tokens": w.tokens, "shipments": w.shipments, "docs": len(w.docs)})
        print(f"{tid}: template {w.question.template}, {w.shipments} shipments, {len(w.docs)} docs, {w.tokens} tokens")
    set_meta(con, "generator", GENERATOR_VERSION)
    set_meta(con, "budget", str(a.budget))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Run tests**

Run: `uv run --project prep pytest -q prep/tests/test_ledger.py`
Expected: 10 passed (deterministic, 3 × size, 3 × recompute, corrections, transfers, templates). If a world's question cannot be made valid for one of the fixed test seeds, the error names the seed; fix the generator, not the test.

- [ ] **Step 6: Commit**

```bash
git add prep/polyprep/ledger.py prep/polyprep/ledger_parse.py prep/polyprep/ledger_gen.py prep/tests/test_ledger.py
git commit -m "ledger suite generator: seeded worlds, prose records, questions with exact answers, size calibration"
```

---

### Task 6: BrowseComp-Plus fetch and oracle screen

**Files:**
- Create: `prep/polyprep/bcp.py`, `prep/polyprep/bcp_fetch.py`, `prep/polyprep/bcp_screen.py`
- Test: `prep/tests/test_bcp.py`

**Interfaces:**
- Consumes: `store` (Task 4), `model.chat/check_server` (Task 4), `verify.verify_claim` (Task 4).
- Produces:
  - `bcp.py`: `DECRYPT_COMMIT`, `QUERIES_REVISION`, `CORPUS_REVISION` (Global Constraints values); `title_of(text: str, url: str) -> str`; `compose_prompt(question: str) -> str`; `oracle_messages(question: str, gold: list[tuple[str, str, str]]) -> list[dict]`; `select(screened: list[tuple[str, bool, int]], *, take=35, pilot=5, seed=2026) -> dict[str, str]` (task id → `"pilot"` | `"scored"`).
  - `bcp_fetch.py`: CLI `python -m polyprep.bcp_fetch` → `data/bcp/corpus.sqlite`, `data/bcp/tasks.sqlite` (all 830 as `candidate`).
  - `bcp_screen.py`: CLI `python -m polyprep.bcp_screen --server URL [--model-id qwen3.8-27b] [--hf-repo unsloth/Qwen3.8-27B-NVFP4] [--concurrency 4] [--max-tokens 8192] [--reasoning medium] [--seed 1] [--limit N]` → table `screen` in `tasks.sqlite`, splits set on 35 tasks, `data/bcp/screen-failures.md`.

Prompt (exact):
```
Answer the question below using the document collection. search(query) finds documents by keywords; read_doc(id, page) reads one page of a document.

Question: <question>

Answer with a short exact answer (a name, title, date or number).
```

- [ ] **Step 1: Write the failing tests**

`prep/tests/test_bcp.py`:
```python
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from polyprep.bcp import compose_prompt, oracle_messages, select, title_of
from polyprep.bcp_screen import screen
from polyprep.store import open_tasks, put_task, write_corpus


def test_title_from_front_matter_url_or_first_line():
    assert title_of("---\ntitle: Arwa University holds annual cultural activities\nauthor: x\n---\nBody", "https://y") == "Arwa University holds annual cultural activities"
    assert title_of("No front matter here\nsecond line", "https://example.com/page") == "https://example.com/page"
    assert title_of("First line only", "") == "First line only"
    assert len(title_of("---\ntitle: " + "x" * 400 + "\n---", "")) == 160


def test_prompt_and_oracle_messages():
    p = compose_prompt("Who wrote it?")
    assert p.startswith("Answer the question below using the document collection.")
    assert "Question: Who wrote it?" in p and p.endswith("(a name, title, date or number).")
    msgs = oracle_messages("Who wrote it?", [("d1", "T", "x" * 50_000)])
    assert msgs[0]["role"] == "system" and "only the final short answer" in msgs[0]["content"]
    assert len(msgs[1]["content"]) < 41_000 and "[d1] T" in msgs[1]["content"] and msgs[1]["content"].endswith("Question: Who wrote it?")


def test_select_ranks_by_spread_and_splits_reproducibly():
    screened = [(f"bcp-{i}", i % 4 != 0, i % 9) for i in range(100)]
    a = select(screened, take=35, pilot=5, seed=2026)
    assert len(a) == 35 and sorted(a.values()).count("pilot") == 5
    assert all(t in {x[0] for x in screened if x[1]} for t in a)
    kept_spread = min(next(x[2] for x in screened if x[0] == t) for t in a)
    assert all(x[2] <= kept_spread for x in screened if x[1] and x[0] not in a)
    assert select(screened, take=35, pilot=5, seed=2026) == a
    assert select(screened, take=35, pilot=5, seed=1) != a


class _Fake(BaseHTTPRequestHandler):
    def do_GET(self):
        self._send({"data": [{"id": "qwen3.8-27b", "root": "unsloth/Qwen3.8-27B-NVFP4"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        q = body["messages"][1]["content"]
        assert body["temperature"] == 0 and body["chat_template_kwargs"] == {"reasoning_effort": "medium"}
        self._send({"choices": [{"message": {"content": "Kessler AG" if "copper" in q else "no idea"}}], "usage": {"prompt_tokens": 10, "completion_tokens": 2}})

    def _send(self, obj):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


def test_screen_against_a_stub_server(tmp_path):
    srv = HTTPServer(("127.0.0.1", 0), _Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        data = tmp_path / "data"
        write_corpus(data / "bcp" / "corpus.sqlite", [("d1", "Memo", "Kessler AG supplied copper wire."), ("d2", "Ferry", "The ferry went to Ghent.")])
        con = open_tasks(data / "bcp" / "tasks.sqlite")
        for i in range(8):
            copper = i % 2 == 0
            put_task(con, id=f"bcp-{i}", split="candidate", prompt=compose_prompt("Who supplied copper?" if copper else "Where did the ferry go?"),
                     answer="Kessler AG" if copper else "Ghent", match="contains", corpus="corpus.sqlite",
                     info={"query": "Who supplied copper?" if copper else "Where did the ferry go?", "gold": ["d1" if copper else "d2"], "evidence": ["d1"] * (i + 1)})
        result = screen(data, server=f"http://127.0.0.1:{srv.server_port}/v1", model_id="qwen3.8-27b", hf_repo="unsloth/Qwen3.8-27B-NVFP4",
                        concurrency=2, max_tokens=64, reasoning="medium", seed=1, take=3, pilot=1, split_seed=2026)
        assert result == {"screened": 8, "passed": 4, "selected": 3}
        splits = dict(con.execute("SELECT id, split FROM tasks").fetchall())
        assert sorted(i for i, s in splits.items() if s != "candidate") == ["bcp-2", "bcp-4", "bcp-6"]
        assert (data / "bcp" / "screen-failures.md").read_text().count("| bcp-") == 4
        assert screen(data, server=f"http://127.0.0.1:{srv.server_port}/v1", model_id="qwen3.8-27b", hf_repo="unsloth/Qwen3.8-27B-NVFP4",
                      concurrency=2, max_tokens=64, reasoning="medium", seed=1, take=3, pilot=1, split_seed=2026)["screened"] == 8  # resumes, no new calls
    finally:
        srv.shutdown()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run --project prep pytest -q prep/tests/test_bcp.py`
Expected: FAIL, `ModuleNotFoundError: No module named 'polyprep.bcp'`.

- [ ] **Step 3: Implement `bcp.py`**

`prep/polyprep/bcp.py`:
```python
"""BrowseComp-Plus: pinned sources, prompts and the task selection rule (spec §4.1, §5)."""
from __future__ import annotations

import random

DECRYPT_COMMIT = "046949032b0328319cc9a02663a759ec601d9402"
DECRYPT_URL = f"https://raw.githubusercontent.com/texttron/BrowseComp-Plus/{DECRYPT_COMMIT}/scripts_build_index/decrypt_dataset.py"
QUERIES_REVISION = "144cff8e35b5eaef7e526346aa60774a9deb941f"
CORPUS_REVISION = "b27b02bc3e45511b8b82a13e6f90ce761df726f6"
ORACLE_DOC_CHARS = 40_000


def title_of(text: str, url: str) -> str:
    if text.startswith("---\n"):
        for line in text.split("\n")[1:]:
            if line == "---":
                break
            if line.startswith("title:"):
                return line[len("title:"):].strip()[:160]
    if url:
        return url[:160]
    return next((l.strip() for l in text.split("\n") if l.strip()), "(untitled)")[:160]


def compose_prompt(question: str) -> str:
    return ("Answer the question below using the document collection. search(query) finds documents by keywords; read_doc(id, page) reads one page of a document.\n\n"
            f"Question: {question}\n\nAnswer with a short exact answer (a name, title, date or number).")


def oracle_messages(question: str, gold: list[tuple[str, str, str]]) -> list[dict]:
    docs = "\n\n".join(f"[{i}] {t}\n{b[:ORACLE_DOC_CHARS // max(1, len(gold))]}" for i, t, b in gold)
    return [
        {"role": "system", "content": "You are given documents and a question. Reply with only the final short answer (a name, title, date or number)."},
        {"role": "user", "content": f"{docs}\n\nQuestion: {question}"},
    ]


def select(screened: list[tuple[str, bool, int]], *, take: int = 35, pilot: int = 5, seed: int = 2026) -> dict[str, str]:
    """Survivors of the oracle screen, most evidence documents first (ties by id), then a seeded pilot/scored split."""
    survivors = sorted((x for x in screened if x[1]), key=lambda x: (-x[2], x[0]))[:take]
    ids = [x[0] for x in survivors]
    order = sorted(ids)
    random.Random(seed).shuffle(order)
    return {t: ("pilot" if i < pilot else "scored") for i, t in enumerate(order)}
```

- [ ] **Step 4: Implement `bcp_screen.py` and `bcp_fetch.py`**

`prep/polyprep/bcp_screen.py`:
```python
"""Oracle screen: keep the questions the pinned model answers when handed the gold documents; then select 35 by evidence spread."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from polyprep import DATA
from polyprep.bcp import oracle_messages, select
from polyprep.model import chat, check_server
from polyprep.store import set_split
from polyprep.verify import verify_claim


def screen(data: Path, *, server, model_id, hf_repo, concurrency, max_tokens, reasoning, seed, take=35, pilot=5, split_seed=2026, limit=None) -> dict:
    check_server(server, model_id, hf_repo)
    db = data / "bcp" / "tasks.sqlite"
    con = sqlite3.connect(db, check_same_thread=False)
    con.execute("CREATE TABLE IF NOT EXISTS screen (task_id TEXT PRIMARY KEY, passed INTEGER NOT NULL, claim TEXT NOT NULL, detail TEXT, ms INTEGER NOT NULL, tokens INTEGER NOT NULL)")
    corpus = sqlite3.connect(data / "bcp" / "corpus.sqlite", check_same_thread=False)
    rows = con.execute("SELECT id, answer, aliases, match, info FROM tasks WHERE id NOT IN (SELECT task_id FROM screen) ORDER BY id").fetchall()
    if limit is not None:
        rows = rows[:limit]

    def one(row):
        tid, answer, aliases, match, info = row
        info = json.loads(info)
        gold = [corpus.execute("SELECT id, title, body FROM docs WHERE id = ?", (d,)).fetchone() for d in info["gold"]]
        t0 = time.monotonic()
        r = chat(server, model_id, oracle_messages(info["query"], [g for g in gold if g]), seed=seed, max_tokens=max_tokens, reasoning_effort=reasoning)
        ok, detail = verify_claim(answer, json.loads(aliases), match, r["content"])
        tokens = int(r["usage"].get("prompt_tokens", 0)) + int(r["usage"].get("completion_tokens", 0))
        return tid, ok, r["content"].strip()[:500], detail, round((time.monotonic() - t0) * 1000), tokens

    with ThreadPoolExecutor(concurrency) as pool:
        for tid, ok, claim, detail, ms, tokens in pool.map(one, rows):
            con.execute("INSERT INTO screen VALUES (?, ?, ?, ?, ?, ?)", (tid, int(ok), claim, detail, ms, tokens))
            con.commit()

    screened = [(tid, bool(p), len(json.loads(info)["evidence"])) for tid, p, info in con.execute("SELECT s.task_id, s.passed, t.info FROM screen s JOIN tasks t ON t.id = s.task_id")]
    chosen = select(screened, take=take, pilot=pilot, seed=split_seed)
    con.execute("UPDATE tasks SET split = 'candidate'")
    for tid, split in chosen.items():
        set_split(con, tid, split)
    failures = con.execute("SELECT s.task_id, t.answer, s.claim FROM screen s JOIN tasks t ON t.id = s.task_id WHERE s.passed = 0 ORDER BY s.task_id").fetchall()
    lines = ["# Oracle screen failures (for alias review; contains answers, stays in data/)", "", "| task | answer | model said |", "|---|---|---|"]
    lines += [f"| {t} | {a} | {c.replace('|', '/').replace(chr(10), ' ')} |" for t, a, c in failures]
    (data / "bcp" / "screen-failures.md").write_text("\n".join(lines) + "\n")
    return {"screened": len(screened), "passed": sum(1 for x in screened if x[1]), "selected": len(chosen)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--server", required=True)
    ap.add_argument("--model-id", default="qwen3.8-27b")
    ap.add_argument("--hf-repo", default="unsloth/Qwen3.8-27B-NVFP4")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--max-tokens", type=int, default=8192)
    ap.add_argument("--reasoning", default="medium")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--limit", type=int)
    a = ap.parse_args(argv)
    print(screen(DATA, server=a.server, model_id=a.model_id, hf_repo=a.hf_repo, concurrency=a.concurrency, max_tokens=a.max_tokens, reasoning=a.reasoning, seed=a.seed, limit=a.limit))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

`prep/polyprep/bcp_fetch.py`:
```python
"""Downloads BrowseComp-Plus, decrypts the questions with the authors' script (pinned commit), and builds data/bcp/."""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.request

from polyprep import DATA
from polyprep.bcp import CORPUS_REVISION, DECRYPT_URL, QUERIES_REVISION, compose_prompt, title_of
from polyprep.store import open_tasks, put_task, set_meta, write_corpus


def main() -> int:
    from datasets import load_dataset

    raw = DATA / "bcp" / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    script = raw / "decrypt_dataset.py"
    urllib.request.urlretrieve(DECRYPT_URL, script)
    decrypted = raw / "decrypted.jsonl"
    subprocess.run([sys.executable, str(script), "--output", str(decrypted)], check=True, cwd=raw)

    corpus = load_dataset("Tevatron/browsecomp-plus-corpus", split="train", revision=CORPUS_REVISION)
    ids = set()

    def docs():
        for r in corpus:
            ids.add(r["docid"])
            yield r["docid"], title_of(r["text"], r["url"] or ""), r["text"]

    n = write_corpus(DATA / "bcp" / "corpus.sqlite", docs())
    con = open_tasks(DATA / "bcp" / "tasks.sqlite")
    count = 0
    with decrypted.open() as f:
        for line in f:
            q = json.loads(line)
            gold = [d["docid"] for d in q["gold_docs"]]
            evidence = [d["docid"] for d in q["evidence_docs"]]
            missing = [d for d in gold + evidence if d not in ids]
            if missing:
                raise SystemExit(f"query {q['query_id']}: documents missing from the corpus: {missing[:5]}")
            put_task(con, id=f"bcp-{q['query_id']}", split="candidate", prompt=compose_prompt(q["query"]), answer=q["answer"], match="contains",
                     corpus="corpus.sqlite", info={"query_id": q["query_id"], "query": q["query"], "gold": gold, "evidence": evidence})
            count += 1
    set_meta(con, "queries_revision", QUERIES_REVISION)
    set_meta(con, "corpus_revision", CORPUS_REVISION)
    print(f"corpus: {n} documents; questions: {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

The authors' script loads `Tevatron/browsecomp-plus` itself; `QUERIES_REVISION` records the revision that was current when this plan was written. `bcp_fetch` is not unit-tested (it is network plus the authors' code); it is run in the runbook.

- [ ] **Step 5: Run tests**

Run: `uv run --project prep pytest -q prep/tests/test_bcp.py`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add prep/polyprep/bcp.py prep/polyprep/bcp_fetch.py prep/polyprep/bcp_screen.py prep/tests/test_bcp.py
git commit -m "bcp suite: pinned fetch and decrypt, BM25 corpus, oracle screen and spread selection"
```

---

### Task 7: The `math` suite

**Files:**
- Create: `prep/polyprep/mathgen.py`, `prep/polyprep/math_build.py`
- Test: `prep/tests/test_math.py`

**Interfaces:**
- Consumes: `store`, `verify.numeric_value` (Task 4).
- Produces:
  - `mathgen.py`: `generated(seed: int) -> dict` with keys `id`, `problem`, `answer` (integer as string), `kind` (template name); deterministic per seed; answers computed by brute force or exact formulas in code.
  - `math_build.py`: `build(pool: list[dict], *, model_release: date, need=35, pilot=5, split_seed=2026) -> list[dict]` (each with `id`, `split`, `prompt`, `answer`, `info`); CLI `python -m polyprep.math_build --pool data/math/pool.jsonl --model-release YYYY-MM-DD` writing `data/math/tasks.sqlite`.
  - Pool line format (`data/math/pool.jsonl`, entered by hand from the official problem and answer sources): `{"id": "aime2026-1-08", "source": "AIME 2026 I", "contest_date": "2026-02-05", "number": 8, "problem": "…", "answer": "204"}`.

Prompt (exact):
```
Solve the problem below. run_python(code) runs Python with sympy and numpy (no network, 10 s per call).

Problem: <problem>

The answer is an integer or a fraction. Claim it in that form.
```

- [ ] **Step 1: Write the failing tests**

`prep/tests/test_math.py`:
```python
import datetime as dt
import math

import pytest

from polyprep.math_build import build
from polyprep.mathgen import generated
from polyprep.verify import numeric_value

POOL = [
    {"id": f"aime2026-1-{n:02d}", "source": "AIME 2026 I", "contest_date": "2026-02-05", "number": n, "problem": f"P{n}", "answer": str(n * 7)} for n in range(8, 16)
] + [
    {"id": f"old-{n}", "source": "AIME 2025 I", "contest_date": "2025-02-06", "number": n, "problem": "old", "answer": "1"} for n in range(8, 16)
]


def test_generated_problems_are_deterministic_and_checked():
    for seed in range(1, 41):
        g = generated(seed)
        assert g == generated(seed)
        assert numeric_value(g["answer"]) is not None
    kinds = {generated(s)["kind"] for s in range(1, 41)}
    assert kinds == {"coprime_residue", "lattice_paths", "last_digits", "bounded_triples"}


def test_last_digits_matches_python_pow():
    g = next(generated(s) for s in range(1, 100) if generated(s)["kind"] == "last_digits")
    assert 0 <= int(g["answer"]) <= 999


def test_build_admits_only_contests_after_release_and_fills_with_generated():
    tasks = build(POOL, model_release=dt.date(2025, 12, 1), need=35, pilot=5, split_seed=2026)
    assert len(tasks) == 35
    contest = [t for t in tasks if not t["info"]["generated"]]
    assert {t["info"]["source"] for t in contest} == {"AIME 2026 I"} and len(contest) == 8
    assert sum(1 for t in tasks if t["split"] == "pilot") == 5
    assert all(t["prompt"].startswith("Solve the problem below.") and t["prompt"].endswith("Claim it in that form.") for t in tasks)
    assert build(POOL, model_release=dt.date(2025, 12, 1), need=35, pilot=5, split_seed=2026) == tasks


def test_build_rejects_non_numeric_answers():
    bad = [dict(POOL[0], answer="x^2 + 1")]
    with pytest.raises(ValueError, match="aime2026-1-08"):
        build(bad, model_release=dt.date(2025, 1, 1), need=1, pilot=0, split_seed=1)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run --project prep pytest -q prep/tests/test_math.py`
Expected: FAIL, `ModuleNotFoundError: No module named 'polyprep.math_build'`.

- [ ] **Step 3: Implement**

`prep/polyprep/mathgen.py`:
```python
"""Fallback math problems with answers computed in code (spec §4.3). Used only when too few contest problems qualify."""
from __future__ import annotations

import math
import random

KINDS = ["coprime_residue", "lattice_paths", "last_digits", "bounded_triples"]


def generated(seed: int) -> dict:
    rng = random.Random(seed)
    kind = KINDS[seed % len(KINDS)]
    if kind == "coprime_residue":
        n, m, k = rng.randint(2000, 9000), rng.choice([30, 42, 60, 66, 70, 78, 84, 90]), rng.randint(5, 13)
        r = rng.randint(0, k - 1)
        ans = sum(1 for x in range(1, n + 1) if math.gcd(x, m) == 1 and x % k == r)
        text = f"How many integers n with 1 ≤ n ≤ {n} satisfy gcd(n, {m}) = 1 and n ≡ {r} (mod {k})?"
    elif kind == "lattice_paths":
        a, b = rng.randint(7, 11), rng.randint(7, 11)
        blocked = sorted({(rng.randint(1, a - 1), rng.randint(1, b - 1)) for _ in range(rng.randint(3, 6))})
        ways = [[0] * (b + 1) for _ in range(a + 1)]
        for x in range(a + 1):
            for y in range(b + 1):
                if (x, y) in blocked:
                    continue
                ways[x][y] = 1 if (x, y) == (0, 0) else (ways[x - 1][y] if x else 0) + (ways[x][y - 1] if y else 0)
        ans = ways[a][b]
        cells = ", ".join(f"({x}, {y})" for x, y in blocked)
        text = f"A path from (0, 0) to ({a}, {b}) moves one unit right or one unit up at each step and never visits the points {cells}. How many such paths are there?"
    elif kind == "last_digits":
        p, q, r, s = rng.randint(7, 97), rng.randint(100, 10_000), rng.randint(7, 97), rng.randint(100, 10_000)
        ans = (pow(p, q, 1000) + pow(r, s, 1000)) % 1000
        text = f"What are the last three digits of {p}^{q} + {r}^{s}? Give the number they form (0 to 999)."
    else:
        u, n = rng.randint(6, 15), rng.randint(15, 40)
        ans = sum(1 for x in range(u + 1) for y in range(u + 1) for z in range(u + 1) if x + 2 * y + 3 * z == n)
        text = f"How many ordered triples (x, y, z) of integers with 0 ≤ x, y, z ≤ {u} satisfy x + 2y + 3z = {n}?"
    return {"id": f"gen-{seed:03d}", "problem": text, "answer": str(ans), "kind": kind}
```

`prep/polyprep/math_build.py`:
```python
"""Builds the math suite: post-release contest problems first, generated problems to fill up to 35 (spec §4.3, §5)."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import sys
from pathlib import Path

from polyprep import DATA
from polyprep.mathgen import generated
from polyprep.store import open_tasks, put_task
from polyprep.verify import numeric_value


def compose_prompt(problem: str) -> str:
    return ("Solve the problem below. run_python(code) runs Python with sympy and numpy (no network, 10 s per call).\n\n"
            f"Problem: {problem}\n\nThe answer is an integer or a fraction. Claim it in that form.")


def build(pool: list[dict], *, model_release: dt.date, need: int = 35, pilot: int = 5, split_seed: int = 2026) -> list[dict]:
    for p in pool:
        if numeric_value(p["answer"]) is None:
            raise ValueError(f"{p['id']}: answer {p['answer']!r} is not an integer or a fraction")
    admitted = sorted((p for p in pool if dt.date.fromisoformat(p["contest_date"]) > model_release), key=lambda p: p["id"])[:need]
    items = [{"id": f"math-{p['id']}", "problem": p["problem"], "answer": p["answer"],
              "info": {"generated": False, "source": p["source"], "number": p["number"], "contest_date": p["contest_date"], "model_release": model_release.isoformat()}}
             for p in admitted]
    seed = 1
    while len(items) < need:
        g = generated(seed)
        items.append({"id": f"math-{g['id']}", "problem": g["problem"], "answer": g["answer"], "info": {"generated": True, "kind": g["kind"], "seed": seed}})
        seed += 1
    order = [x["id"] for x in items]
    random.Random(split_seed).shuffle(order)
    pilot_ids = set(order[:pilot])
    return [{"id": x["id"], "split": "pilot" if x["id"] in pilot_ids else "scored", "prompt": compose_prompt(x["problem"]), "answer": x["answer"], "info": x["info"]} for x in items]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pool", type=Path, default=DATA / "math" / "pool.jsonl")
    ap.add_argument("--model-release", required=True, help="Qwen3.8-27B release date from its model card (YYYY-MM-DD)")
    ap.add_argument("--split-seed", type=int, default=2026)
    a = ap.parse_args(argv)
    pool = [json.loads(l) for l in a.pool.read_text().splitlines() if l.strip()]
    tasks = build(pool, model_release=dt.date.fromisoformat(a.model_release), split_seed=a.split_seed)
    con = open_tasks(DATA / "math" / "tasks.sqlite")
    con.execute("DELETE FROM tasks")
    for t in tasks:
        put_task(con, id=t["id"], split=t["split"], prompt=t["prompt"], answer=t["answer"], match="numeric", info=t["info"])
    print(f"{sum(not t['info']['generated'] for t in tasks)} contest problems, {sum(t['info']['generated'] for t in tasks)} generated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests**

Run: `uv run --project prep pytest -q prep/tests/test_math.py`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add prep/polyprep/mathgen.py prep/polyprep/math_build.py prep/tests/test_math.py
git commit -m "math suite: post-release contest pool with generated fallback problems"
```

---

### Task 8: The batch runner and `polylogue batch`

**Files:**
- Create: `packages/runtime/src/batch/matrix.ts`, `packages/runtime/src/batch/runner.ts`
- Modify: `packages/runtime/src/cli.ts`
- Test: `packages/runtime/src/batch/batch.test.ts`

**Interfaces:**
- Consumes: `RunConfig`, `parseConfig`, `SuiteId` (Task 2); `runOnce`, `RunSummary`, `RunDeps` (`run/run.ts`); `listTasks` (Task 2); `pythonSandboxReady` (Task 3); `EventLog` (`log/event-log.ts`); `makeSuiteFixture` (Task 2).
- Produces:
  - `matrix.ts`: `Matrix` (zod schema and type, fields below); `interface Cell { id: string; suite: SuiteId; taskId: string; condition: ConditionName; seed: number; tokensPerAgent: number; wallClockMs: number }`; `expandMatrix(m: Matrix, list: (suite: SuiteId, split: "pilot" | "scored") => string[]): Cell[]` (unshuffled, in suites × tasks × conditions × seeds order); `shuffle<T>(xs: T[], seed: number): T[]` (mulberry32 Fisher–Yates, returns a new array); `toRunConfig(m: Matrix, cell: Cell, baseUrl: string, runId: string): RunConfig`.
  - `runner.ts`: `interface BatchDeps { log: EventLog; list?: (suite: SuiteId, split: "pilot" | "scored") => string[]; run?: (cfg: RunConfig, deps: RunDeps) => Promise<RunSummary>; gitSha?: string | null; sandboxReady?: () => Promise<boolean>; onRun?: (line: string) => void }`; `interface BatchResult { ran: string[]; skipped: string[]; closed: string[]; failedTwice: string[] }`; `closeStale(log: EventLog, runId: string): void`; `runBatch(m: Matrix, deps: BatchDeps): Promise<BatchResult>`.
  - CLI: `polylogue batch <matrix.json> [--db runs.sqlite]`, printing one line per finished run and a JSON summary.

Matrix JSON (example, also the shape of `configs/pilot-p0.json` in Task 9):
```json
{
  "name": "pilot-p0", "orderSeed": 1, "dataDir": "data",
  "servers": ["http://zgx-40dd.local:8000/v1"],
  "conditions": ["single"], "seeds": [1, 2],
  "suites": [{ "suite": "bcp", "split": "pilot", "tokensPerAgent": 200000, "wallClockMs": 1800000 }],
  "rate": { "messagesPerMinute": 10, "maxMessageChars": 2000 },
  "model": { "id": "qwen3.8-27b", "hfRepo": "unsloth/Qwen3.8-27B-NVFP4", "revision": "7d6f8d4d72f56b92b3cdbf22f156b90e1bab0108", "contextWindow": 262144, "maxTokens": 8192, "reasoningEffort": "medium", "timeoutMs": 1800000, "maxRetries": 3 }
}
```

- [ ] **Step 1: Write the failing tests**

`packages/runtime/src/batch/batch.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Matrix, expandMatrix, shuffle, type Cell } from "./matrix.ts";
import { closeStale, runBatch } from "./runner.ts";
import { EventLog } from "../log/event-log.ts";
import { makeSuiteFixture } from "../testing/suite-fixture.ts";
import { startFakeOpenAI, type FakeServer } from "../testing/fake-openai.ts";
import type { RunConfig } from "../config.ts";
import type { RunSummary } from "../run/run.ts";

let fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
});
const dbPath = () => join(mkdtempSync(join(tmpdir(), "polylogue-batch-")), "runs.sqlite");
const MODEL = { id: "qwen3.8-27b", hfRepo: "unsloth/Qwen3.8-27B-NVFP4", revision: "r", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 30_000, maxRetries: 0 };

function dataDir(): string {
  return makeSuiteFixture(
    "bcp",
    [
      { id: "bcp-1", split: "pilot", prompt: "Who supplied copper?", answer: "Kessler AG", match: "contains", corpus: "corpus.sqlite" },
      { id: "bcp-2", split: "pilot", prompt: "Where did the ferry go?", answer: "Ghent", match: "contains", corpus: "corpus.sqlite" },
    ],
    { "corpus.sqlite": [{ id: "d1", title: "Memo", body: "Kessler AG supplied copper. The ferry went to Ghent." }] },
  );
}
function matrix(over: Record<string, unknown> = {}): Matrix {
  return Matrix.parse({
    name: "t", orderSeed: 1, dataDir: dataDir(), servers: ["http://127.0.0.1:1/v1"], conditions: ["single", "isolated"], seeds: [1, 2],
    suites: [{ suite: "bcp", split: "pilot", tokensPerAgent: 50_000, wallClockMs: 20_000 }],
    rate: { messagesPerMinute: 30, maxMessageChars: 2000 }, model: MODEL, ...over,
  });
}
/** Stub runner: writes a finished row like runOnce would, with a chosen reason per run id. */
function stubRun(log: EventLog, reasons: Record<string, RunSummary["reason"]> = {}, seen: string[] = []) {
  return async (cfg: RunConfig): Promise<RunSummary> => {
    const id = cfg.runId!;
    seen.push(id);
    log.createRun({ id, condition: cfg.condition, n: 1, taskId: cfg.taskId, seed: cfg.seed, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
    const reason = reasons[id] ?? "solved";
    log.append(id, { kind: "run_finished", t: 1, reason, solved: reason === "solved", wallMs: 1, totalTokens: 0 });
    log.finishRun(id, reason === "solved" ? "solved" : reason === "infra_error" ? "infra_error" : "unsolved", reason, "2026-10-11T00:00:01Z");
    return { runId: id, reason, solved: reason === "solved", totalTokens: 0, wallMs: 1 };
  };
}

describe("matrix", () => {
  it("expands suites × tasks × conditions × seeds with spec run ids", () => {
    const m = matrix();
    const cells = expandMatrix(m, () => ["bcp-1", "bcp-2"]);
    expect(cells).toHaveLength(8);
    expect(cells[0]).toEqual({ id: "bcp-bcp-1-single-s1", suite: "bcp", taskId: "bcp-1", condition: "single", seed: 1, tokensPerAgent: 50_000, wallClockMs: 20_000 } satisfies Cell);
    expect(new Set(cells.map((c) => c.id)).size).toBe(8);
  });

  it("shuffles reproducibly per seed", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(xs, 1)).toEqual(shuffle(xs, 1));
    expect(shuffle(xs, 1)).not.toEqual(shuffle(xs, 2));
    expect([...shuffle(xs, 1)].sort((a, b) => a - b)).toEqual(xs);
  });
});

describe("runBatch", () => {
  it("runs every cell once in shuffled order and skips finished cells on a second call", async () => {
    const log = new EventLog(dbPath());
    const seen: string[] = [];
    const m = matrix();
    const r1 = await runBatch(m, { log, run: stubRun(log, {}, seen) });
    expect(r1.ran).toHaveLength(8);
    expect(seen).toEqual(shuffle(expandMatrix(m, () => ["bcp-1", "bcp-2"]), 1).map((c) => c.id));
    const r2 = await runBatch(m, { log, run: stubRun(log, {}, seen) });
    expect(r2.ran).toEqual([]);
    expect(r2.skipped).toHaveLength(8);
  });

  it("closes a run left running by a crash, reruns it once as -r1, and counts a second failure", async () => {
    const log = new EventLog(dbPath());
    const crashed = "bcp-bcp-1-single-s1";
    log.createRun({ id: crashed, condition: "single", n: 1, taskId: "bcp-1", seed: 1, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
    log.append(crashed, { kind: "model_call", t: 500, agent: "a1", call: 0, content: "", reasoning: "", toolCalls: [], tokensIn: 100, tokensOut: 20, ms: 400, stopReason: "stop" });
    const seen: string[] = [];
    const r = await runBatch(matrix(), { log, run: stubRun(log, { "bcp-bcp-2-isolated-s2": "infra_error", "bcp-bcp-2-isolated-s2-r1": "infra_error" }, seen) });
    expect(r.closed).toEqual([crashed]);
    expect(log.run(crashed)).toMatchObject({ status: "infra_error", endReason: "infra_error" });
    expect(log.events(crashed).at(-1)!.event).toMatchObject({ kind: "run_finished", reason: "infra_error", totalTokens: 120, wallMs: 500, detail: "interrupted; closed when the batch resumed" });
    expect(seen).toContain(`${crashed}-r1`);
    expect(seen).not.toContain(crashed);
    expect(seen.filter((x) => x.startsWith("bcp-bcp-2-isolated-s2"))).toEqual(["bcp-bcp-2-isolated-s2", "bcp-bcp-2-isolated-s2-r1"]);
    expect(r.failedTwice).toEqual(["bcp-bcp-2-isolated-s2"]);
    const again = await runBatch(matrix(), { log, run: stubRun(log, {}, seen) });
    expect(again.ran).toEqual([]);
  });

  it("closeStale leaves an already finished run's events alone", () => {
    const log = new EventLog(dbPath());
    log.createRun({ id: "x", condition: "single", n: 1, taskId: "t", seed: 1, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
    log.append("x", { kind: "run_finished", t: 3, reason: "budget", solved: false, wallMs: 3, totalTokens: 9 });
    closeStale(log, "x");
    expect(log.events("x")).toHaveLength(1);
    expect(log.run("x")!.status).toBe("infra_error");
  });

  it("refuses a math batch when the Python sandbox is not ready", async () => {
    const log = new EventLog(dbPath());
    const m = matrix({ suites: [{ suite: "math", split: "pilot", tokensPerAgent: 1000, wallClockMs: 1000 }] });
    await expect(runBatch(m, { log, list: () => ["math-1"], run: stubRun(log), sandboxReady: async () => false })).rejects.toThrow(/Python sandbox is not ready/);
  });

  it("stops with a readable error and keeps the cell when the server check fails", async () => {
    const log = new EventLog(dbPath());
    const run = async (): Promise<RunSummary> => {
      throw new Error("model server at http://127.0.0.1:1/v1 is unreachable: fetch failed");
    };
    await expect(runBatch(matrix(), { log, run })).rejects.toThrow(/Batch stopped with 8 runs left: model server .* unreachable/);
    expect(log.runs()).toEqual([]);
  });

  it("runs end to end on two servers with real runOnce, each cell exactly once", async () => {
    const policy = () => ({ toolCalls: [{ name: "claim", args: { answer: "Kessler AG", evidence: "d1" } }] });
    fakes = [await startFakeOpenAI(policy), await startFakeOpenAI(policy)];
    const log = new EventLog(dbPath());
    const m = matrix({ servers: fakes.map((f) => f.baseUrl), suites: [{ suite: "bcp", split: "pilot", tasks: ["bcp-1"], tokensPerAgent: 50_000, wallClockMs: 20_000 }] });
    const r = await runBatch(m, { log });
    expect(r.ran.sort()).toEqual(["bcp-bcp-1-isolated-s1", "bcp-bcp-1-isolated-s2", "bcp-bcp-1-single-s1", "bcp-bcp-1-single-s2"]);
    expect(log.runs().map((x) => x.status)).toEqual(["solved", "solved", "solved", "solved"]);
    expect(fakes.every((f) => f.requests.length > 0)).toBe(true);
    const servers = r.ran.map((id) => (log.events(id)[0]!.event as { config: { model: { baseUrl: string } } }).config.model.baseUrl);
    expect(new Set(servers)).toEqual(new Set(fakes.map((f) => f.baseUrl)));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/runtime/src/batch`
Expected: FAIL, cannot resolve `./matrix.ts`.

- [ ] **Step 3: Implement `matrix.ts`**

`packages/runtime/src/batch/matrix.ts`:
```ts
import { z } from "zod";
import { ConditionName } from "@polylogue/schema";
import { RunConfig, SuiteId, parseConfig } from "../config.ts";

export const Matrix = z.object({
  name: z.string().min(1),
  orderSeed: z.number().int(),
  dataDir: z.string().default("data"),
  servers: z.array(z.string().url()).min(1),
  conditions: z.array(ConditionName).min(1),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  suites: z
    .array(
      z.object({
        suite: SuiteId,
        split: z.enum(["pilot", "scored"]),
        tasks: z.array(z.string()).optional(),
        tokensPerAgent: z.number().int().positive(),
        wallClockMs: z.number().int().positive(),
      }),
    )
    .min(1),
  rate: RunConfig.shape.rate,
  toolDelayMs: z.number().int().nonnegative().default(0),
  model: RunConfig.shape.model.omit({ baseUrl: true }),
});
export type Matrix = z.infer<typeof Matrix>;

export interface Cell {
  id: string;
  suite: SuiteId;
  taskId: string;
  condition: ConditionName;
  seed: number;
  tokensPerAgent: number;
  wallClockMs: number;
}

export function expandMatrix(m: Matrix, list: (suite: SuiteId, split: "pilot" | "scored") => string[]): Cell[] {
  const cells: Cell[] = [];
  for (const s of m.suites) {
    for (const taskId of s.tasks ?? list(s.suite, s.split)) {
      for (const condition of m.conditions) {
        for (const seed of m.seeds) {
          cells.push({ id: `${s.suite}-${taskId}-${condition}-s${seed}`, suite: s.suite, taskId, condition, seed, tokensPerAgent: s.tokensPerAgent, wallClockMs: s.wallClockMs });
        }
      }
    }
  }
  return cells;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function toRunConfig(m: Matrix, cell: Cell, baseUrl: string, runId: string): RunConfig {
  return parseConfig({
    runId, condition: cell.condition, suite: cell.suite, taskId: cell.taskId, dataDir: m.dataDir, seed: cell.seed,
    budget: { tokensPerAgent: cell.tokensPerAgent }, wallClockMs: cell.wallClockMs, rate: m.rate, toolDelayMs: m.toolDelayMs,
    checkServer: true, model: { ...m.model, baseUrl },
  });
}
```

- [ ] **Step 4: Implement `runner.ts`**

`packages/runtime/src/batch/runner.ts`:
```ts
import type { RunConfig, SuiteId } from "../config.ts";
import type { EventLog } from "../log/event-log.ts";
import { runOnce, type RunDeps, type RunSummary } from "../run/run.ts";
import { pythonSandboxReady } from "../suites/python-tool.ts";
import { listTasks } from "../suites/registry.ts";
import { expandMatrix, shuffle, toRunConfig, type Cell, type Matrix } from "./matrix.ts";

export interface BatchDeps {
  log: EventLog;
  list?: (suite: SuiteId, split: "pilot" | "scored") => string[];
  run?: (cfg: RunConfig, deps: RunDeps) => Promise<RunSummary>;
  gitSha?: string | null;
  sandboxReady?: () => Promise<boolean>;
  onRun?: (line: string) => void;
}
export interface BatchResult {
  ran: string[];
  skipped: string[];
  closed: string[];
  failedTwice: string[];
}

/** Closes a run row left `running` by a crash: appends run_finished (infra_error) unless present, and finishes the row. */
export function closeStale(log: EventLog, runId: string): void {
  const events = log.events(runId).map((s) => s.event);
  if (!events.some((e) => e.kind === "run_finished")) {
    const tokens = events.reduce((n, e) => n + (e.kind === "model_call" ? e.tokensIn + e.tokensOut : 0), 0);
    const wallMs = events.at(-1)?.t ?? 0;
    log.append(runId, { kind: "run_finished", t: wallMs, reason: "infra_error", solved: false, wallMs, totalTokens: tokens, detail: "interrupted; closed when the batch resumed" });
  }
  log.finishRun(runId, "infra_error", "infra_error", new Date().toISOString());
}

export async function runBatch(m: Matrix, deps: BatchDeps): Promise<BatchResult> {
  const list = deps.list ?? ((suite, split) => listTasks(suite, split, m.dataDir));
  const run = deps.run ?? runOnce;
  const cells = shuffle(expandMatrix(m, list), m.orderSeed);
  if (cells.some((c) => c.suite === "math") && !(await (deps.sandboxReady ?? pythonSandboxReady)())) {
    throw new Error("This batch has math tasks, but the Python sandbox is not ready: start Docker and run `npm run sandbox:build`.");
  }
  const result: BatchResult = { ran: [], skipped: [], closed: [], failedTwice: [] };
  const queue: { cell: Cell; runId: string; rerun: boolean }[] = [];
  for (const cell of cells) {
    const base = cell.id;
    const re = `${cell.id}-r1`;
    for (const id of [base, re]) {
      if (deps.log.run(id)?.status === "running") {
        closeStale(deps.log, id);
        result.closed.push(id);
      }
    }
    const b = deps.log.run(base);
    const r = deps.log.run(re);
    if (!b) queue.push({ cell, runId: base, rerun: false });
    else if (b.status !== "infra_error") result.skipped.push(base);
    else if (!r) queue.push({ cell, runId: re, rerun: true });
    else {
      result.skipped.push(re);
      if (r.status === "infra_error") result.failedTwice.push(cell.id);
    }
  }

  const errors: Error[] = [];
  const worker = async (server: string) => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      let summary: RunSummary;
      try {
        summary = await run(toRunConfig(m, job.cell, server, job.runId), { log: deps.log, gitSha: deps.gitSha ?? null });
      } catch (err) {
        queue.unshift(job);
        errors.push(err as Error);
        return;
      }
      result.ran.push(job.runId);
      deps.onRun?.(`${job.runId}: ${summary.reason} (${summary.totalTokens} tokens, ${Math.round(summary.wallMs / 1000)} s)`);
      if (summary.reason === "infra_error") {
        if (job.rerun) result.failedTwice.push(job.cell.id);
        else queue.push({ cell: job.cell, runId: `${job.cell.id}-r1`, rerun: true });
      }
    }
  };
  await Promise.all(m.servers.map(worker));
  if (queue.length > 0) throw new Error(`Batch stopped with ${queue.length} runs left: ${errors[0]?.message ?? "unknown error"}`);
  return result;
}
```

- [ ] **Step 5: Add `polylogue batch` to the CLI**

In `packages/runtime/src/cli.ts`, extend `USAGE` with the line `\n  polylogue batch <matrix.json> [--db runs.sqlite]` and add before the `serve` branch:
```ts
  if (command === "batch") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { db: { type: "string", default: "runs.sqlite" } } });
    if (positionals.length !== 1) throw new Error(USAGE);
    const { Matrix } = await import("./batch/matrix.ts");
    const { runBatch } = await import("./batch/runner.ts");
    const m = Matrix.parse(JSON.parse(readFileSync(positionals[0]!, "utf8")));
    const log = new EventLog(values.db!);
    try {
      const result = await runBatch(m, { log, gitSha: gitSha(), onRun: (line) => console.log(line) });
      console.log(JSON.stringify({ ran: result.ran.length, skipped: result.skipped.length, closed: result.closed, failedTwice: result.failedTwice }, null, 2));
    } finally {
      log.close();
    }
    return;
  }
```

- [ ] **Step 6: Run tests and type-check**

Run: `npx vitest run packages/runtime && npx tsc -p tsconfig.json`
Expected: all runtime tests PASS (8 new batch tests), tsc silent.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/batch packages/runtime/src/cli.ts
git commit -m "Batch runner: shuffled matrix, one worker per server, resume, one rerun of infra errors"
```

---

### Task 9: Pilot report, P0 matrix, runbook and README

**Files:**
- Create: `packages/runtime/src/batch/report.ts`, `configs/pilot-p0.json`, `docs/pilot-runbook.md`
- Modify: `packages/runtime/src/cli.ts`, `README.md`
- Test: `packages/runtime/src/batch/report.test.ts`

**Interfaces:**
- Consumes: `Matrix`, `Cell`, `expandMatrix` (Task 8); `listTasks` (Task 2); `EventLog` (`log/event-log.ts`); `Event`, `Of` (`@polylogue/schema`).
- Produces:
  - `report.ts`: `interface Outcome { cell: Cell; runId: string; reason: string; solved: boolean; tokens: number; wallMs: number; messages: number; agents: number; reads: number; sharedReads: number; failedClaims: { agent: string; answer: string; detail: string }[] }`; `collectOutcomes(m: Matrix, log: EventLog, list: (suite, split) => string[]): Outcome[]` (uses the `-r1` run when the base run was an infra error; a cell with no finished run is left out); `proposeBudget(outcomes: Outcome[]): Record<string, { B: number; solved: number; runs: number; floor: boolean }>`; `proposeWallClock(outcomes: Outcome[]): Record<string, number | null>`; `renderReport(m: Matrix, outcomes: Outcome[]): string`.
  - CLI `polylogue pilot-report --db runs.sqlite --matrix <matrix.json> [--out data/reports/<name>.md]`.

Rules (spec §7):
- **Budget (P0):** per suite, from `single` outcomes: if at least 3 solved, B = 1.5 × median tokens of solved runs, rounded up to a multiple of 1,000; otherwise B = median tokens of all runs rounded up to 1,000, with `floor: true`. Tokens are the run's `totalTokens` divided by the number of agents (1 for `single`).
- **Wall clock:** per suite, 3 × the slowest solved `single` run's `wallMs`, or `null` if none solved.
- **Shared reads** (a first candidate for "duplicate work"): per run, the number of distinct `read_doc` ids (any page) read by two or more agents; `reads` = distinct ids read by anyone.
- **Floor check:** for `bcp`, when every condition solves fewer than 2 of its runs, the report recommends the dense-retriever fallback.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/src/batch/report.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventInput, Event } from "@polylogue/schema";
import { Matrix } from "./matrix.ts";
import { collectOutcomes, proposeBudget, proposeWallClock, renderReport } from "./report.ts";
import { EventLog } from "../log/event-log.ts";

const MODEL = { id: "m", hfRepo: "r", revision: "v", contextWindow: 262144, maxTokens: 4096, reasoningEffort: "medium", timeoutMs: 1000, maxRetries: 0 };
const m = Matrix.parse({
  name: "pilot-p0", orderSeed: 1, servers: ["http://x/v1"], conditions: ["single"], seeds: [1, 2],
  suites: [{ suite: "bcp", split: "pilot", tokensPerAgent: 200_000, wallClockMs: 1_800_000 }, { suite: "math", split: "pilot", tokensPerAgent: 200_000, wallClockMs: 1_800_000 }],
  rate: { messagesPerMinute: 10, maxMessageChars: 2000 }, model: MODEL,
});
const tasks = { bcp: ["bcp-1", "bcp-2"], math: ["math-1", "math-2"] } as Record<string, string[]>;

function fakeRun(log: EventLog, id: string, o: { solved: boolean; tokens: number; wallMs: number; reads?: [string, string][]; claim?: string; reason?: "solved" | "budget" | "infra_error" | "all_idle" }) {
  const reason = o.reason ?? (o.solved ? "solved" : "budget");
  log.createRun({ id, condition: "single", n: 1, taskId: "t", seed: 1, model: "m", revision: "v", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
  const ev = (e: EventInput, t: number) => log.append(id, { ...e, t } as Event);
  ev({ kind: "agent_started", agent: "a1", index: 0, seed: 100, systemPrompt: "s", tools: [] }, 0);
  (o.reads ?? []).forEach(([agent, doc], i) => ev({ kind: "tool_call", agent, callId: `c${i}`, tool: "read_doc", args: { id: doc } }, 1));
  if (o.claim) {
    ev({ kind: "claim_submitted", agent: "a1", answer: o.claim, evidence: "e" }, 2);
    ev({ kind: "verification", claimOf: "a1", passed: o.solved, ...(o.solved ? {} : { detail: `expected Ghent, got ${o.claim}` }) }, 2);
  }
  ev({ kind: "run_finished", reason, solved: o.solved, wallMs: o.wallMs, totalTokens: o.tokens }, o.wallMs);
  log.finishRun(id, o.solved ? "solved" : reason === "infra_error" ? "infra_error" : "unsolved", reason, "2026-10-11T00:01:00Z");
}

function fixture(): EventLog {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
  fakeRun(log, "bcp-bcp-1-single-s1", { solved: true, tokens: 40_000, wallMs: 100_000, reads: [["a1", "d1"], ["a1", "d1"]] });
  fakeRun(log, "bcp-bcp-1-single-s2", { solved: true, tokens: 60_000, wallMs: 300_000 });
  fakeRun(log, "bcp-bcp-2-single-s1", { solved: true, tokens: 50_001, wallMs: 200_000 });
  fakeRun(log, "bcp-bcp-2-single-s2", { solved: false, tokens: 200_000, wallMs: 900_000, claim: "Lyon" });
  fakeRun(log, "math-math-1-single-s1", { solved: false, tokens: 10_000, wallMs: 50_000, reason: "infra_error" });
  fakeRun(log, "math-math-1-single-s1-r1", { solved: true, tokens: 12_000, wallMs: 60_000 });
  fakeRun(log, "math-math-1-single-s2", { solved: false, tokens: 30_000, wallMs: 70_000 });
  fakeRun(log, "math-math-2-single-s1", { solved: false, tokens: 31_000, wallMs: 70_000 });
  return log; // math-math-2-single-s2 has no run yet
}

describe("pilot report", () => {
  it("collects outcomes, preferring the -r1 rerun and skipping cells without a finished run", () => {
    const out = collectOutcomes(m, fixture(), (s) => tasks[s]!);
    expect(out).toHaveLength(7);
    expect(out.find((o) => o.cell.id === "math-math-1-single-s1")).toMatchObject({ runId: "math-math-1-single-s1-r1", solved: true, tokens: 12_000 });
    expect(out.find((o) => o.runId === "bcp-bcp-2-single-s2")!.failedClaims).toEqual([{ agent: "a1", answer: "Lyon", detail: "expected Ghent, got Lyon" }]);
  });

  it("proposes B by the P0 rule and flags a floor", () => {
    const b = proposeBudget(collectOutcomes(m, fixture(), (s) => tasks[s]!));
    expect(b.bcp).toEqual({ B: 76_000, solved: 3, runs: 4, floor: false }); // median 50,001 × 1.5 = 75,001.5 → 76,000
    expect(b.math).toEqual({ B: 30_000, solved: 1, runs: 3, floor: true });
  });

  it("proposes wall-clock limits from the slowest solved single run", () => {
    expect(proposeWallClock(collectOutcomes(m, fixture(), (s) => tasks[s]!))).toEqual({ bcp: 900_000, math: 180_000 });
  });

  it("renders Markdown with the tables, the floor check and failed claims", () => {
    const md = renderReport(m, collectOutcomes(m, fixture(), (s) => tasks[s]!));
    expect(md.split("\n")[0]).toBe("# Pilot report: pilot-p0");
    expect(md).toContain("| bcp | single | 4 | 3 | 75% |");
    expect(md).toContain("ledger uses bcp's B");
    expect(md).toContain("| bcp-bcp-2-single-s2 | a1 | Lyon | expected Ghent, got Lyon |");
    expect(md).toContain("Floor check (bcp): passed");
  });

  it("counts documents read by more than one agent", () => {
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "polylogue-report-")), "runs.sqlite"));
    fakeRun(log, "bcp-bcp-1-single-s1", { solved: true, tokens: 1, wallMs: 1, reads: [["a1", "d1"], ["a2", "d1"], ["a2", "d2"], ["a3", "d1"], ["a1", "d3"], ["a3", "d3"]] });
    const o = collectOutcomes(m, log, (s) => (s === "bcp" ? ["bcp-1"] : []))[0]!;
    expect(o).toMatchObject({ reads: 3, sharedReads: 2 });
  });
});
```

Worked numbers for these tests: the solved `bcp` tokens are 40,000, 60,000 and 50,001, so B = ⌈1.5 × 50,001 / 1,000⌉ × 1,000 = 76,000. `math` has one solved run (the `-r1` rerun), so it is a floor: B = median(12,000, 30,000, 31,000) = 30,000. Wall clock: `bcp` 3 × 300,000 = 900,000; `math` 3 × 60,000 = 180,000.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/runtime/src/batch/report.test.ts`
Expected: FAIL, cannot resolve `./report.ts`.

- [ ] **Step 3: Implement `report.ts`**

`packages/runtime/src/batch/report.ts`:
```ts
import type { Event } from "@polylogue/schema";
import type { SuiteId } from "../config.ts";
import type { EventLog } from "../log/event-log.ts";
import { expandMatrix, type Cell, type Matrix } from "./matrix.ts";

export interface Outcome {
  cell: Cell;
  runId: string;
  reason: string;
  solved: boolean;
  tokens: number;
  wallMs: number;
  messages: number;
  agents: number;
  reads: number;
  sharedReads: number;
  failedClaims: { agent: string; answer: string; detail: string }[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const up1000 = (x: number) => Math.ceil(x / 1000) * 1000;

function outcome(cell: Cell, runId: string, events: Event[]): Outcome | null {
  const end = events.find((e) => e.kind === "run_finished");
  if (!end || end.kind !== "run_finished") return null;
  const agents = events.filter((e) => e.kind === "agent_started").length || 1;
  const readers = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.kind === "tool_call" && e.tool === "read_doc") {
      const id = String((e.args as { id?: unknown })?.id ?? "");
      readers.set(id, (readers.get(id) ?? new Set()).add(e.agent));
    }
  }
  const claims = new Map<string, string>();
  const failedClaims: Outcome["failedClaims"] = [];
  for (const e of events) {
    if (e.kind === "claim_submitted") claims.set(e.agent, e.answer);
    if (e.kind === "verification" && !e.passed) failedClaims.push({ agent: e.claimOf, answer: claims.get(e.claimOf) ?? "", detail: e.detail ?? "" });
  }
  return {
    cell, runId, reason: end.reason, solved: end.solved, tokens: end.totalTokens, wallMs: end.wallMs,
    messages: events.filter((e) => e.kind === "message").length, agents,
    reads: readers.size, sharedReads: [...readers.values()].filter((s) => s.size > 1).length, failedClaims,
  };
}

export function collectOutcomes(m: Matrix, log: EventLog, list: (suite: SuiteId, split: "pilot" | "scored") => string[]): Outcome[] {
  const out: Outcome[] = [];
  for (const cell of expandMatrix(m, list)) {
    const base = log.run(cell.id);
    const re = log.run(`${cell.id}-r1`);
    const runId = base?.status === "infra_error" && re ? re.id : base?.id;
    if (!runId) continue;
    const o = outcome(cell, runId, log.events(runId).map((s) => s.event));
    if (o) out.push(o);
  }
  return out;
}

export function proposeBudget(outcomes: Outcome[]): Record<string, { B: number; solved: number; runs: number; floor: boolean }> {
  const res: Record<string, { B: number; solved: number; runs: number; floor: boolean }> = {};
  for (const suite of new Set(outcomes.map((o) => o.cell.suite))) {
    const single = outcomes.filter((o) => o.cell.suite === suite && o.cell.condition === "single");
    if (single.length === 0) continue;
    const per = (o: Outcome) => o.tokens / o.agents;
    const solved = single.filter((o) => o.solved);
    const floor = solved.length < 3;
    res[suite] = { B: floor ? up1000(median(single.map(per))) : up1000(1.5 * median(solved.map(per))), solved: solved.length, runs: single.length, floor };
  }
  return res;
}

export function proposeWallClock(outcomes: Outcome[]): Record<string, number | null> {
  const res: Record<string, number | null> = {};
  for (const suite of new Set(outcomes.map((o) => o.cell.suite))) {
    const solved = outcomes.filter((o) => o.cell.suite === suite && o.cell.condition === "single" && o.solved);
    res[suite] = solved.length ? 3 * Math.max(...solved.map((o) => o.wallMs)) : null;
  }
  return res;
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");

export function renderReport(m: Matrix, outcomes: Outcome[]): string {
  const lines = [`# Pilot report: ${m.name}`, "", "Contains answers and claims; keep it under data/ (git-ignored).", "", "## Runs", "",
    "| suite | condition | runs | solved | solve rate | median tokens | median wall (s) | messages per agent | shared-read share |", "|---|---|---|---|---|---|---|---|---|"];
  const groups = new Map<string, Outcome[]>();
  for (const o of outcomes) groups.set(`${o.cell.suite}|${o.cell.condition}`, [...(groups.get(`${o.cell.suite}|${o.cell.condition}`) ?? []), o]);
  for (const [key, os] of groups) {
    const [suite, condition] = key.split("|");
    const solved = os.filter((o) => o.solved).length;
    const reads = os.reduce((n, o) => n + o.reads, 0);
    const shared = os.reduce((n, o) => n + o.sharedReads, 0);
    lines.push(`| ${suite} | ${condition} | ${os.length} | ${solved} | ${pct(solved, os.length)} | ${Math.round(median(os.map((o) => o.tokens)))} | ${Math.round(median(os.map((o) => o.wallMs)) / 1000)} | ${(os.reduce((n, o) => n + o.messages / o.agents, 0) / os.length).toFixed(1)} | ${pct(shared, reads)} |`);
  }
  const budget = proposeBudget(outcomes);
  const wall = proposeWallClock(outcomes);
  lines.push("", "## Proposed budget B per agent (P0 rule: 1.5 × median tokens of solved `single` runs)", "");
  for (const [suite, b] of Object.entries(budget)) lines.push(`- ${suite}: B = ${b.B} (${b.solved} of ${b.runs} solved${b.floor ? "; FLOOR: fewer than 3 solved, B is the median of all runs" : ""})`);
  if (budget.bcp) lines.push(`- ledger uses bcp's B (${budget.bcp.B}); generate its worlds with \`--budget ${budget.bcp.B}\`.`);
  lines.push("", "## Proposed wall-clock limit (3 × slowest solved `single` run)", "");
  for (const [suite, w] of Object.entries(wall)) lines.push(`- ${suite}: ${w === null ? "no solved single run" : `${w} ms`}`);
  const bcp = outcomes.filter((o) => o.cell.suite === "bcp");
  if (bcp.length) {
    const conds = new Set(bcp.map((o) => o.cell.condition));
    const floored = [...conds].every((c) => bcp.filter((o) => o.cell.condition === c && o.solved).length < 2);
    lines.push("", floored ? "Floor check (bcp): FAILED — every condition solved fewer than 2 runs; consider the dense-retriever fallback (spec §7)." : "Floor check (bcp): passed");
  }
  const failed = outcomes.flatMap((o) => o.failedClaims.map((f) => ({ runId: o.runId, ...f })));
  lines.push("", "## Failed claims (alias review)", "", "| run | agent | claim | verifier |", "|---|---|---|---|");
  for (const f of failed) lines.push(`| ${f.runId} | ${f.agent} | ${f.answer.replace(/\|/g, "/").replace(/\n/g, " ")} | ${f.detail.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: CLI, P0 matrix, runbook, README**

In `packages/runtime/src/cli.ts`, extend `USAGE` with `\n  polylogue pilot-report --db runs.sqlite --matrix <matrix.json> [--out data/reports/<name>.md]` and add:
```ts
  if (command === "pilot-report") {
    const { values } = parseArgs({ args: rest, options: { db: { type: "string", default: "runs.sqlite" }, matrix: { type: "string" }, out: { type: "string" } } });
    if (!values.matrix) throw new Error(USAGE);
    const { Matrix } = await import("./batch/matrix.ts");
    const { collectOutcomes, renderReport } = await import("./batch/report.ts");
    const { listTasks } = await import("./suites/registry.ts");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const m = Matrix.parse(JSON.parse(readFileSync(values.matrix, "utf8")));
    const log = new EventLog(values.db!, { readonly: true });
    try {
      const out = values.out ?? `${m.dataDir}/reports/${m.name}.md`;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, renderReport(m, collectOutcomes(m, log, (s, split) => listTasks(s, split, m.dataDir))));
      console.log(`wrote ${out}`);
    } finally {
      log.close();
    }
    return;
  }
```

`configs/pilot-p0.json`:
```json
{
  "name": "pilot-p0",
  "orderSeed": 1,
  "dataDir": "data",
  "servers": ["http://zgx-40dd.local:8000/v1"],
  "conditions": ["single"],
  "seeds": [1, 2],
  "suites": [
    { "suite": "bcp", "split": "pilot", "tokensPerAgent": 200000, "wallClockMs": 1800000 },
    { "suite": "math", "split": "pilot", "tokensPerAgent": 200000, "wallClockMs": 1800000 }
  ],
  "rate": { "messagesPerMinute": 10, "maxMessageChars": 2000 },
  "model": {
    "id": "qwen3.8-27b",
    "hfRepo": "unsloth/Qwen3.8-27B-NVFP4",
    "revision": "7d6f8d4d72f56b92b3cdbf22f156b90e1bab0108",
    "contextWindow": 262144,
    "maxTokens": 8192,
    "reasoningEffort": "medium",
    "timeoutMs": 1800000,
    "maxRetries": 3
  }
}
```

`docs/pilot-runbook.md`:
````markdown
# Pilot runbook (task suites, P0, P1, freeze)

Steps marked **GO-AHEAD** call the live model server and start only when Daniel says so. Everything writes under `data/` (git-ignored) except the freeze commit.

## 0. Once

```bash
uv sync --project prep
npm run sandbox:build
```

## 1. bcp data (download, no model)

```bash
uv run --project prep python -m polyprep.bcp_fetch
```
About 3 GB of downloads and a few GB of SQLite under `data/bcp/`.

## 2. bcp oracle screen — GO-AHEAD

```bash
uv run --project prep python -m polyprep.bcp_screen --server http://zgx-40dd.local:8000/v1
```
About 830 calls, an hour or two. Then read `data/bcp/screen-failures.md` and add aliases for correct answers the verifier missed (`UPDATE tasks SET aliases = json_insert(aliases, '$[#]', '<alias>') WHERE id = '<id>'` in `data/bcp/tasks.sqlite`); re-running the screen skips screened questions and recomputes the selection.

## 3. math pool (by hand, no model)

Enter the candidate problems into `data/math/pool.jsonl` (format in `prep/polyprep/math_build.py`): problems 8–15 of AIME 2026 I and II and the harder half of the HMMT February 2026 individual rounds, integer or fraction answers only, from the official problem and answer sources. Then, with Qwen3.8-27B's release date from its model card:

```bash
uv run --project prep python -m polyprep.math_build --model-release YYYY-MM-DD
```

## 4. P0 — GO-AHEAD

```bash
npm run polylogue -- batch configs/pilot-p0.json --db data/pilot.sqlite
npm run polylogue -- pilot-report --db data/pilot.sqlite --matrix configs/pilot-p0.json
```
20 runs. Read `data/reports/pilot-p0.md`: B per suite; ledger takes bcp's B.

## 5. ledger data (no model)

```bash
uv run --project prep python -m polyprep.ledger_gen --budget <B_bcp>
```

## 6. P1 — GO-AHEAD

Copy `configs/pilot-p0.json` to `configs/pilot-p1.json`: name `pilot-p1`, all five conditions, the three suites with their B as `tokensPerAgent`, `wallClockMs` 1800000. Then:

```bash
npm run polylogue -- batch configs/pilot-p1.json --db data/pilot.sqlite
npm run polylogue -- pilot-report --db data/pilot.sqlite --matrix configs/pilot-p1.json
```
150 runs, about a day on one Spark. From the report: wall-clock limits, rate limits, aliases, floor check, and draft definitions of "substantive message" and "duplicate work".

## 7. Freeze (after Daniel approves the report)

```bash
for s in bcp ledger math; do uv run --project prep python -m polyprep.freeze $s; done
git add suites/*/frozen.json configs/pilot-p1.json
git commit -m "Freeze: tasks, budgets and limits after the pilot"
```
`python -m polyprep.freeze <suite> --check` verifies `data/` against the committed manifests at any later time. D5 (primary suite) must be decided before this commit.
````

In `README.md`, add after the "Run one experiment run" section:
````markdown
## Task suites and batches

Three suites: `bcp` (BrowseComp-Plus over its fixed corpus, BM25 search), `ledger` (generated records whose evidence exceeds one agent's budget) and `math` (competition problems with a sandboxed Python tool). Their data is built under `data/` (git-ignored) by the Python package in `prep/`:

```bash
uv sync --project prep
npm run test:prep
npm run sandbox:build
```

`polylogue batch <matrix.json>` runs a matrix of suites × tasks × conditions × seeds in shuffled order on one worker per model server, resumes after a crash and reruns an infrastructure failure once. `polylogue pilot-report` summarizes a batch. The pilot steps, with the points that need a go-ahead, are in [docs/pilot-runbook.md](docs/pilot-runbook.md). Design: [docs/superpowers/specs/2026-10-11-polylogue-task-suites-design.md](docs/superpowers/specs/2026-10-11-polylogue-task-suites-design.md).
````

- [ ] **Step 5: Run everything**

Run: `npx vitest run && npm run typecheck && npm run test:prep`
Expected: all vitest tests PASS (5 new report tests), both tsc runs silent, prep tests pass (3 skipped).

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/batch/report.ts packages/runtime/src/batch/report.test.ts packages/runtime/src/cli.ts configs/pilot-p0.json docs/pilot-runbook.md README.md
git commit -m "Pilot report (budgets, wall clock, floor check, failed claims), P0 matrix and runbook"
```

---

The live steps (runbook 1–7) are not part of this plan's tasks: steps 2, 4 and 6 need Daniel's go-ahead, step 3 is manual data entry, and step 7 needs his approval of the report and the D5 decision.
