import type { ViewState } from "../state.ts";

const ROW = 28;
const LANE_H = ROW - 6;

export function Swimlanes({ s }: { s: ViewState }) {
  const width = Math.max(1, s.duration);
  const x = (t: number) => (t / width) * 1000;
  const height = s.lanes.length * ROW + 4;
  return (
    <section className="panel" data-testid="swimlanes" aria-label="Swimlanes">
      <h2>Timeline</h2>
      <div className="lanes-wrap">
        <div className="lane-names" style={{ height, paddingTop: 2 }}>
          {s.lanes.map((lane) => <div key={lane.agent} style={{ height: ROW }}>{lane.agent}</div>)}
        </div>
        <svg viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none" className="lanes" style={{ height }} role="img" aria-label="Agent timelines">
          {s.lanes.map((lane, i) => (
            <g key={lane.agent} transform={`translate(0 ${i * ROW + 2})`}>
              <rect x={0} y={0} width={1000} height={LANE_H} className="lane-bg" />
              {lane.segments.map((seg, k) => (
                <rect key={k} x={x(seg.start)} y={0} width={Math.max(1, x(seg.end) - x(seg.start))} height={LANE_H} className={`seg ${seg.kind}`} />
              ))}
              {lane.marks.map((m, k) => (
                <g key={`m${k}`}>
                  <line x1={x(m.t)} x2={x(m.t)} y1={0} y2={LANE_H} className="mark-halo" />
                  <line x1={x(m.t)} x2={x(m.t)} y1={0} y2={LANE_H} className={`mark ${m.kind}`} />
                </g>
              ))}
            </g>
          ))}
          <line x1={x(s.t)} x2={x(s.t)} y1={0} y2={height} className="cursor" />
        </svg>
      </div>
      <p className="legend">
        <span className="key model" /> model call <span className="key tool" /> tool <span className="key idle" /> idle
        <span className="key-line sent" /> sent <span className="key-line received" /> received <span className="key-line blackboard" /> blackboard <span className="key-line claim" /> claim <span className="key-line fork" /> fork
      </p>
    </section>
  );
}
