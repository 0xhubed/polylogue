import type { ViewState } from "../state.ts";

export function BlackboardView({ s }: { s: ViewState }) {
  return (
    <section className="panel" data-testid="blackboard" aria-label="Blackboard">
      <h2>Blackboard</h2>
      {s.blackboard.length === 0 ? <p className="empty">Nothing written yet.</p> : (
        <ol className="board">
          {s.blackboard.map((b, i) => <li key={i}><span className="who">{b.agent}</span> {b.text}</li>)}
        </ol>
      )}
    </section>
  );
}
