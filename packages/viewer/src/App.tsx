import { useEffect, useMemo, useState } from "react";
import type { Event, RunRow } from "@polylogue/schema";
import { ConditionName } from "@polylogue/schema";
import { stateAt } from "./state.ts";
import { followRun, listRuns, loadRun, simulatedEvents, sourceFromUrl } from "./source.ts";
import { Counters } from "./views/Counters.tsx";
import { TeamGraph } from "./views/TeamGraph.tsx";
import { Swimlanes } from "./views/Swimlanes.tsx";
import { ChatFeed } from "./views/ChatFeed.tsx";
import { BlackboardView } from "./views/BlackboardView.tsx";
import { Scrubber } from "./views/Scrubber.tsx";

export function App() {
  const source = useMemo(() => sourceFromUrl(window.location.search), []);
  const [events, setEvents] = useState<Event[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [t, setT] = useState(0);
  const [live, setLive] = useState(false);
  const [canFollow, setCanFollow] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (source.kind === "sim") {
      const ev = simulatedEvents(source.condition, source.seed);
      setEvents(ev);
      setT(ev.at(-1)?.t ?? 0);
      setTitle(`Simulated ${source.condition} run (seed ${source.seed})`);
      return;
    }
    if (source.kind === "index") {
      void listRuns().then(setRuns);
      return;
    }
    let stop = () => {};
    loadRun(source.id)
      .then((r) => {
        if (!r) return setError(`Run not found: ${source.id}`);
        setTitle(`${r.run.id} · ${r.run.condition} · ${r.run.status}`);
        const ev = r.events.map((s) => s.event);
        setEvents(ev);
        setT(ev.at(-1)?.t ?? 0);
        if (r.run.status === "running") {
          setCanFollow(true);
          setLive(true);
          stop = followRun(source.id, r.events.at(-1)?.seq ?? -1, (e) => setEvents((prev) => [...prev, e]));
        }
      })
      .catch((e: Error) => setError(`Could not load run ${source.id}: ${e.message}`));
    return () => stop();
  }, [source]);

  const duration = events.reduce((m, e) => Math.max(m, e.t), 0);
  useEffect(() => {
    if (live) setT(duration);
  }, [live, duration]);
  useEffect(() => {
    if (!playing) return;
    const h = setInterval(() => setT((x) => Math.min(duration, x + 400)), 100);
    return () => clearInterval(h);
  }, [playing, duration]);
  useEffect(() => {
    if (playing && t >= duration) setPlaying(false);
  }, [playing, t, duration]);

  const s = useMemo(() => stateAt(events, t), [events, t]);

  if (error) return <main className="page"><p className="error" data-testid="run-error">{error}</p><p><a href="./">All runs</a></p></main>;
  if (source.kind === "index") {
    return (
      <main className="page">
        <h1>Polylogue runs</h1>
        {runs.length > 0 ? (
          <ul className="runs">{runs.map((r) => <li key={r.id}><a href={`?run=${encodeURIComponent(r.id)}`}>{r.id}</a> · {r.condition} · {r.status}</li>)}</ul>
        ) : <p className="empty">No recorded runs on this server.</p>}
        <h2>Simulated runs</h2>
        <ul className="runs">{ConditionName.options.map((c) => <li key={c}><a href={`?sim=${c}&seed=1`}>{c}</a></li>)}</ul>
      </main>
    );
  }
  return (
    <main className="page">
      <header className="top"><h1>{title || "Loading…"}</h1><a href="./">All runs</a></header>
      <Counters s={s} />
      <div className="grid">
        <TeamGraph s={s} />
        <Swimlanes s={s} />
        <ChatFeed s={s} />
        <BlackboardView s={s} />
      </div>
      <Scrubber t={t} duration={duration} live={live} canFollow={canFollow} playing={playing}
        onT={(v) => { setLive(false); setT(v); }} onPlay={() => { setLive(false); if (!playing && t >= duration) setT(0); setPlaying((p) => !p); }} onLive={setLive} />
    </main>
  );
}
