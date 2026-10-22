export function Scrubber(props: { t: number; duration: number; live: boolean; canFollow: boolean; playing: boolean; onT(t: number): void; onPlay(): void; onLive(v: boolean): void }) {
  return (
    <section className="scrubber" aria-label="Replay">
      <button type="button" onClick={props.onPlay}>{props.playing ? "Pause" : "Play"}</button>
      <input
        data-testid="scrubber"
        type="range"
        min={0}
        max={Math.max(1, props.duration)}
        step={1}
        value={props.t}
        onChange={(e) => props.onT(Number(e.currentTarget.value))}
        aria-label="Time in the run"
      />
      <span className="time">{(props.t / 1000).toFixed(1)} s / {(props.duration / 1000).toFixed(1)} s</span>
      {props.canFollow && (
        <label><input type="checkbox" checked={props.live} onChange={(e) => props.onLive(e.currentTarget.checked)} /> Follow live</label>
      )}
    </section>
  );
}
