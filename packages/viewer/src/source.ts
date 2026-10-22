import { ConditionName, Event, type RunRow } from "@polylogue/schema";
import { simulate } from "./sim.ts";

export type Source =
  | { kind: "sim"; condition: ConditionName; seed: number }
  | { kind: "run"; id: string }
  | { kind: "index" };

export function sourceFromUrl(search: string): Source {
  const p = new URLSearchParams(search);
  const sim = ConditionName.safeParse(p.get("sim"));
  if (sim.success) return { kind: "sim", condition: sim.data, seed: Number(p.get("seed") ?? 1) || 1 };
  const run = p.get("run");
  if (run) return { kind: "run", id: run };
  return { kind: "index" };
}

export function simulatedEvents(condition: ConditionName, seed: number): Event[] {
  return simulate(condition, seed);
}

export async function loadRun(id: string): Promise<{ run: RunRow; events: { seq: number; event: Event }[] } | null> {
  const res = await fetch(`/runs/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  const run = (await res.json()) as RunRow;
  const events = (await (await fetch(`/runs/${encodeURIComponent(id)}/events`)).json()) as { seq: number; event: unknown }[];
  return { run, events: events.map((s) => ({ seq: s.seq, event: Event.parse(s.event) })) };
}

// Follows a running run. `lastSeq` is the newest seq already loaded (-1 for none). The server ignores Last-Event-ID, so an
// EventSource reconnect replays from the original `?from=`; events at or below the newest seq seen are dropped here.
export function followRun(id: string, lastSeq: number, onEvent: (e: Event) => void): () => void {
  let last = lastSeq;
  const es = new EventSource(`/runs/${encodeURIComponent(id)}/stream?from=${lastSeq + 1}`);
  es.onmessage = (m) => {
    try {
      const stored = JSON.parse(m.data) as { seq: number; event: unknown };
      if (typeof stored.seq !== "number" || stored.seq <= last) return;
      const event = Event.parse(stored.event);
      last = stored.seq;
      onEvent(event);
    } catch (err) {
      console.error(`polylogue viewer: ignoring a malformed stream event for run ${id}`, err);
    }
  };
  es.addEventListener("end", () => es.close());
  return () => es.close();
}

export async function listRuns(): Promise<RunRow[]> {
  try {
    const res = await fetch("/runs");
    return res.ok ? ((await res.json()) as RunRow[]) : [];
  } catch {
    return [];
  }
}
