import { afterEach, describe, expect, it, vi } from "vitest";
import { followRun } from "./source.ts";

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((m: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener() {}
  close() { this.closed = true; }
  push(seq: number, event: unknown) { this.onmessage?.({ data: JSON.stringify({ runId: "r", seq, event }) }); }
}

const status = (t: number) => ({ t, kind: "status", agent: "a1", text: `s${t}` });

afterEach(() => vi.unstubAllGlobals());

describe("followRun", () => {
  it("starts after the newest loaded seq and drops replayed or out-of-order events", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const got: number[] = [];
    followRun("r", 4, (e) => got.push(e.t));
    const es = FakeEventSource.last;
    expect(es.url).toBe("/runs/r/stream?from=5");
    es.push(5, status(50));
    es.push(6, status(60));
    es.push(5, status(50)); // reconnect replay
    es.push(6, status(60));
    es.push(7, status(70));
    expect(got).toEqual([50, 60, 70]);
  });

  it("ignores a malformed event without throwing and keeps following", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const got: number[] = [];
    followRun("r", -1, (e) => got.push(e.t));
    const es = FakeEventSource.last;
    es.push(0, { nonsense: true });
    es.push(1, status(10));
    expect(got).toEqual([10]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
