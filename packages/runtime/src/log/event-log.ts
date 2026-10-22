import Database from "better-sqlite3";
import { Event, RunRow, type RunEndReason, type RunStatus } from "@polylogue/schema";

export type NewRun = Omit<RunRow, "status" | "endReason" | "endedAt">;
export interface StoredEvent {
  runId: string;
  seq: number;
  event: Event;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, condition TEXT NOT NULL, n INTEGER NOT NULL, task_id TEXT NOT NULL, seed INTEGER NOT NULL,
  model TEXT NOT NULL, revision TEXT NOT NULL, sampling TEXT NOT NULL, config_hash TEXT NOT NULL, git_sha TEXT,
  status TEXT NOT NULL, end_reason TEXT, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (run_id, seq)
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;

interface RunDbRow {
  id: string; condition: string; n: number; task_id: string; seed: number; model: string; revision: string;
  sampling: string; config_hash: string; git_sha: string | null; status: string; end_reason: string | null;
  started_at: string; ended_at: string | null;
}

const toRun = (r: RunDbRow): RunRow =>
  RunRow.parse({
    id: r.id, condition: r.condition, n: r.n, taskId: r.task_id, seed: r.seed, model: r.model, revision: r.revision,
    sampling: JSON.parse(r.sampling), configHash: r.config_hash, gitSha: r.git_sha, status: r.status,
    endReason: r.end_reason, startedAt: r.started_at, endedAt: r.ended_at,
  });

export class EventLog {
  private db: Database.Database;
  private nextSeq = new Map<string, number>();
  private listeners = new Map<string, Set<(e: StoredEvent) => void>>();

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    const readonly = opts.readonly ?? false;
    this.db = new Database(path, { readonly, fileMustExist: readonly });
    if (!readonly) {
      this.db.pragma("journal_mode = WAL");
      this.db.exec(SCHEMA);
    }
  }

  createRun(row: NewRun): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, condition, n, task_id, seed, model, revision, sampling, config_hash, git_sha, status, end_reason, started_at, ended_at)
         VALUES (@id, @condition, @n, @taskId, @seed, @model, @revision, @sampling, @configHash, @gitSha, 'running', NULL, @startedAt, NULL)`,
      )
      .run({ ...row, sampling: JSON.stringify(row.sampling) });
  }

  finishRun(id: string, status: RunStatus, endReason: RunEndReason, endedAt: string): void {
    this.db.prepare("UPDATE runs SET status = ?, end_reason = ?, ended_at = ? WHERE id = ?").run(status, endReason, endedAt, id);
  }

  append(runId: string, event: Event): number {
    const e = Event.parse(event);
    const seq = this.seqFor(runId);
    this.db
      .prepare("INSERT INTO events (run_id, seq, t, kind, payload) VALUES (?, ?, ?, ?, ?)")
      .run(runId, seq, e.t, e.kind, JSON.stringify(e));
    this.nextSeq.set(runId, seq + 1);
    const stored = { runId, seq, event: e };
    for (const fn of this.listeners.get(runId) ?? []) fn(stored);
    return seq;
  }

  events(runId: string, fromSeq = 0): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT seq, payload FROM events WHERE run_id = ? AND seq >= ? ORDER BY seq")
      .all(runId, fromSeq) as { seq: number; payload: string }[];
    return rows.map((r) => ({ runId, seq: r.seq, event: Event.parse(JSON.parse(r.payload)) }));
  }

  /** The first event of a kind in a run, without reading the rest. */
  firstOfKind<K extends Event["kind"]>(runId: string, kind: K): Extract<Event, { kind: K }> | undefined {
    const r = this.db.prepare("SELECT payload FROM events WHERE run_id = ? AND kind = ? ORDER BY seq LIMIT 1").get(runId, kind) as { payload: string } | undefined;
    return r && (Event.parse(JSON.parse(r.payload)) as Extract<Event, { kind: K }>);
  }

  runs(): RunRow[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY started_at").all() as RunDbRow[]).map(toRun);
  }

  run(id: string): RunRow | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunDbRow | undefined;
    return r && toRun(r);
  }

  subscribe(runId: string, fn: (e: StoredEvent) => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(fn);
    this.listeners.set(runId, set);
    return () => set.delete(fn);
  }

  close(): void {
    this.db.close();
  }

  private seqFor(runId: string): number {
    const known = this.nextSeq.get(runId);
    if (known !== undefined) return known;
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM events WHERE run_id = ?").get(runId) as { m: number | null };
    return r.m === null ? 0 : r.m + 1;
  }
}
