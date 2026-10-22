import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { SuiteId } from "../config.ts";
import type { WorkTool } from "../tools/work-tool.ts";
import { TASKS, readShardTool, type ToyTask } from "../toy/vault.ts";
import { Corpus, corpusTools, type CorpusToolName } from "./corpus.ts";
import { pythonTool } from "./python-tool.ts";
import { numericKey, verifyClaim, type AnswerKey, type MatchKind, type Verdict } from "./verify.ts";

export const SUITE_TOOLS: Record<"bcp" | "ledger", CorpusToolName[]> = {
  bcp: ["search", "read_doc"],
  ledger: ["search", "read_doc", "list_docs"],
};

export interface LoadedTask {
  id: string;
  prompt: string;
  /** taskFingerprint of the task (toy: match "toy", answer "", no aliases); frozen.json records it for every pilot and scored task. */
  fingerprint: string;
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

function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * sha256 (hex) of match, answer, the aliases sorted by code point and joined by U+0001, and the prompt, separated by U+0000, as UTF-8.
 * Mirrors task_fingerprint in prep/polyprep/freeze.py.
 */
export function taskFingerprint(match: string, answer: string, aliases: readonly string[], prompt: string): string {
  const text = [match, answer, [...aliases].sort(byCodePoint).join("\u0001"), prompt].join("\u0000");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface TaskIdentity {
  fingerprint: string;
  /** ledger only: sha256 of the task's corpus file */
  corpusSha256?: string;
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

function readRow(suite: SuiteId, taskId: string, dataDir: string): TaskRow {
  const db = tasksDb(suite, dataDir);
  try {
    const row = db.prepare("SELECT id, prompt, answer, aliases, match, corpus FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!row) throw new Error(`Suite "${suite}" has no task "${taskId}".`);
    return row;
  } finally {
    db.close();
  }
}

const rowFingerprint = (row: TaskRow) => taskFingerprint(row.match, row.answer, JSON.parse(row.aliases) as string[], row.prompt);

/** What frozen.json pins for a task: its fingerprint and, for ledger, the hash of its corpus file. */
export function taskIdentity(suite: SuiteId, taskId: string, dataDir: string): TaskIdentity {
  if (suite === "toy") {
    const toy = TASKS[taskId];
    if (!toy) throw new Error(`unknown task "${taskId}"`);
    return { fingerprint: taskFingerprint("toy", "", [], toy.prompt) };
  }
  const row = readRow(suite, taskId, dataDir);
  if (suite !== "ledger") return { fingerprint: rowFingerprint(row) };
  const path = join(dataDir, suite, row.corpus ?? "");
  if (!row.corpus || !existsSync(path)) throw new Error(`Suite "${suite}" task "${taskId}": ${path} is missing.`);
  return { fingerprint: rowFingerprint(row), corpusSha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

export function loadTask(suite: SuiteId, taskId: string, o: { dataDir: string; toolDelayMs: number; toyTasks?: Record<string, ToyTask> }): LoadedTask {
  if (suite === "toy") {
    const toy = (o.toyTasks ?? TASKS)[taskId];
    if (!toy) throw new Error(`unknown task "${taskId}"`);
    const fingerprint = taskFingerprint("toy", "", [], toy.prompt);
    return { id: toy.id, prompt: toy.prompt, fingerprint, tools: [readShardTool(toy, o.toolDelayMs)], verify: (a) => toy.verify(a), close: () => {} };
  }
  const row = readRow(suite, taskId, o.dataDir);
  const fingerprint = rowFingerprint(row);
  if (row.match === "numeric" && numericKey(row.answer) === null) throw new Error(`Suite "${suite}" task "${taskId}": the numeric answer key has no single number.`);
  const aliases = JSON.parse(row.aliases) as string[];
  if (row.match === "numeric") {
    const bad = aliases.find((a) => numericKey(a) === null);
    if (bad !== undefined) throw new Error(`Suite "${suite}" task "${taskId}": the numeric alias ${JSON.stringify(bad)} has no single number.`);
  }
  const key: AnswerKey = { answer: row.answer, aliases, match: row.match };
  const verify = (a: string) => verifyClaim(key, a);
  if (suite === "math") return { id: row.id, prompt: row.prompt, fingerprint, tools: [pythonTool()], verify, close: () => {} };
  if (!row.corpus) throw new Error(`Task "${taskId}" of suite "${suite}" names no corpus.`);
  const path = join(o.dataDir, suite, row.corpus);
  if (!existsSync(path)) throw new Error(`Suite "${suite}" task "${taskId}": ${path} is missing.`);
  const corpus = new Corpus(path);
  return { id: row.id, prompt: row.prompt, fingerprint, tools: corpusTools(corpus, SUITE_TOOLS[suite]), verify, close: () => corpus.close() };
}
