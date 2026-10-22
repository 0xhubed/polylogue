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
