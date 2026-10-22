export interface Clock {
  now(): number;
  /** Calls fn after ms; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

export class FakeClock implements Clock {
  private t = 0;
  private timers: { at: number; fn: () => void; live: boolean }[] = [];

  now(): number {
    return this.t;
  }

  setTimer(fn: () => void, ms: number): () => void {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      // Earliest live timer due by target; ties keep insertion order (strict <).
      let next: { at: number; fn: () => void; live: boolean } | undefined;
      for (const x of this.timers) {
        if (x.live && x.at <= target && (next === undefined || x.at < next.at)) next = x;
      }
      if (next === undefined) break;
      this.t = next.at;
      next.live = false;
      next.fn();
    }
    this.t = target;
  }
}
