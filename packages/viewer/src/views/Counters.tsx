import type { ViewState } from "../state.ts";

const fmt = (n: number) => n.toLocaleString("en-US");
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function Counters({ s }: { s: ViewState }) {
  return (
    <section className="counters" data-testid="counters" aria-label="Counters">
      <div><span className="label">Tokens</span><span className="value" data-testid="counter-tokens">{fmt(s.counters.tokens)}</span><span className="sub">of {fmt(s.counters.pool)}</span></div>
      <div><span className="label">Wall clock</span><span className="value">{clock(s.counters.wallMs)}</span></div>
      <div><span className="label">Messages</span><span className="value">{fmt(s.counters.messages)}</span><span className="sub">{s.counters.messagesPerMinute}/min</span></div>
      <div><span className="label">Result</span><span className="value">{s.ended ? (s.ended.solved ? "solved" : s.ended.reason) : "running"}</span></div>
    </section>
  );
}
