import type { EventInput, RunEndReason } from "@polylogue/schema";
import type { Clock } from "../clock.ts";

export type Refusal = "budget" | "context" | "ended";

export interface ControlledAgent {
  id: string;
  isFinished(): boolean;
  isIdleWithNothingPending(): boolean;
}

export interface ControllerConfig {
  pool: number;
  wallClockMs: number;
  messagesPerMinute: number;
  maxMessageChars: number;
  contextWindow: number;
  /** The first claim ends the run, right or wrong (default); false for isolated, which ends only on a passing claim. */
  firstClaimEnds?: boolean;
}

export interface ControllerDeps {
  log(e: EventInput): void;
  clock: Clock;
  verify(answer: string): { passed: boolean; detail?: string };
}

const MINUTE = 60_000;

export class Controller {
  used = 0;
  private reserved = 0;
  private inFlight = 0;
  private waiting: (() => void)[] = [];
  ended: RunEndReason | null = null;
  endDetail: string | undefined;
  readonly done: Promise<RunEndReason>;
  private resolveDone!: (r: RunEndReason) => void;
  private agents: ControlledAgent[] = [];
  private claimed = new Set<string>();
  private sent = new Map<string, number[]>();
  private cancelTimer: () => void = () => {};

  constructor(
    private readonly cfg: ControllerConfig,
    private readonly deps: ControllerDeps,
  ) {
    this.done = new Promise((r) => {
      this.resolveDone = r;
    });
  }

  /** The run's token pool: the hard budget that every model call is charged against. */
  get pool(): number {
    return this.cfg.pool;
  }

  register(a: ControlledAgent): void {
    this.agents.push(a);
  }

  start(): void {
    this.cancelTimer = this.deps.clock.setTimer(() => this.end("killed"), this.cfg.wallClockMs);
  }

  /**
   * Admits a model call against the pool (hard budget) and returns its output cap, or a refusal. Each admitted call reserves
   * prompt + cap until `settle`. A call whose prompt and full maxTokens fit gets maxTokens. Otherwise it waits while other calls are
   * in flight, because their reservations may come back unused; alone, it gets what is left after its prompt, and a prompt that
   * does not fit ends the run with budget. So a call capped below maxTokens means the pool is spent, and calls that run at the
   * same time cannot jointly overshoot it (only the prompt estimate can be off).
   */
  async admitCall(estimate: number, prompt: number, maxTokens: number): Promise<Refusal | number> {
    for (;;) {
      if (this.ended) return "ended";
      if (estimate > this.cfg.contextWindow) return "context";
      const free = this.cfg.pool - this.used - this.reserved;
      if (prompt + maxTokens <= free || (this.inFlight === 0 && prompt < free)) {
        const cap = Math.min(maxTokens, free - prompt);
        this.reserved += prompt + cap;
        this.inFlight++;
        return cap;
      }
      if (this.inFlight === 0) {
        this.end("budget");
        return "budget";
      }
      await new Promise<void>((r) => this.waiting.push(r));
    }
  }

  /** Ends an admitted call: releases its reservation, charges what it actually used, and lets waiting calls try again. */
  settle(reservation: number, tokens: number): void {
    this.reserved -= reservation;
    this.inFlight--;
    this.used += tokens;
    this.wakeWaiting();
  }

  private wakeWaiting(): void {
    const w = this.waiting;
    this.waiting = [];
    for (const r of w) r();
  }

  /** Returns an error text for the agent, or null when the message may be sent. */
  checkMessage(agentId: string, text: string): string | null {
    if (text.length > this.cfg.maxMessageChars) return `Messages can be at most ${this.cfg.maxMessageChars} characters; yours has ${text.length}.`;
    const now = this.deps.clock.now();
    const recent = (this.sent.get(agentId) ?? []).filter((t) => now - t < MINUTE);
    if (recent.length >= this.cfg.messagesPerMinute) {
      this.sent.set(agentId, recent);
      return `You can send at most ${this.cfg.messagesPerMinute} messages per minute. Try again later.`;
    }
    recent.push(now);
    this.sent.set(agentId, recent);
    return null;
  }

  claim(agentId: string, answer: string, evidence: string): string {
    if (this.ended) throw new Error("The run has ended.");
    if (this.claimed.has(agentId)) throw new Error("You have already submitted a claim.");
    this.claimed.add(agentId);
    this.deps.log({ kind: "claim_submitted", agent: agentId, answer, evidence });
    const v = this.deps.verify(answer);
    this.deps.log(v.detail === undefined ? { kind: "verification", claimOf: agentId, passed: v.passed } : { kind: "verification", claimOf: agentId, passed: v.passed, detail: v.detail });
    if (v.passed) this.end("solved");
    else if (this.cfg.firstClaimEnds ?? true) this.end("wrong_claim"); // the first claim is the team's answer
    return "Claim submitted.";
  }

  checkAllIdle(): void {
    if (this.ended || this.agents.length === 0) return;
    if (this.agents.every((a) => a.isFinished() || a.isIdleWithNothingPending())) this.end("all_idle");
  }

  /** Ends the run as infra_error; the detail of the error that ended it is kept in endDetail. */
  infraError(detail: string): void {
    if (this.ended) return;
    this.endDetail = detail;
    this.end("infra_error");
  }

  end(reason: RunEndReason): void {
    if (this.ended) return;
    this.ended = reason;
    this.cancelTimer();
    this.resolveDone(reason);
    this.wakeWaiting();
  }
}
