import {
  Agent,
  type AgentContext,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type AgentTool,
  type AgentTurnContext,
  type AgentTurnDecision,
} from "@earendil-works/pi-agent-core";
import { formatBlock, orderBlock, type InboxMessage } from "@polylogue/schema";
import type { Clock } from "../clock.ts";
import type { BusMember } from "../comm/bus.ts";
import type { ControlledAgent, Refusal } from "../control/controller.ts";
import type { ModelRuntime } from "../model/provider.ts";
import type { AgentPhase, RunContext } from "../run/context.ts";
import { FORK_AT, FORK_GRACE_CALLS, GENERIC_DIRECTION, fallbackNotice, forkInstruction } from "../fork/texts.ts";
import { forkTool } from "../tools/fork-tool.ts";
import { estimatePromptTokens } from "./estimate.ts";

/** What makes a loop a fork run's root (spec §4): it works alone, is told to fork, and changes tools and prompt once it has forked. */
export interface RootOptions {
  /** `beforeFork` are the root's tools from the start (the fork tool is added when it is told to fork); `afterFork` replace them once it has forked. */
  tools: { beforeFork: AgentTool<any>[]; afterFork: AgentTool<any>[] };
  /** Replaces the root's system prompt once it has forked. */
  promptAfterFork: string;
}

export interface AgentLoopOptions {
  id: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  runtime: ModelRuntime;
  seed: number;
  canBeWoken: boolean;
  ctx: RunContext;
  clock: Clock;
  /** A transcript to start from (a fork's copies start from the root's). Its system messages are dropped, so `systemPrompt` and `tools` lead. */
  initialMessages?: AgentMessage[];
  /**
   * Tokens of the call that wrote `initialMessages`' last assistant message (a copy: the root's last call). The prompt estimate counts
   * the last call's tokens plus the text after it, so without this a copy's first call would leave out the whole inherited context.
   */
  initialCallTokens?: number;
  /** Set only for a fork run's root; its tools are then `root.tools.beforeFork`, not `tools`. */
  root?: RootOptions;
}

type Turn = AgentTurnContext["message"];
const hasToolCall = (m: Turn) => m.content.some((b) => b.type === "toolCall");

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
interface Assistant {
  role: "assistant";
  content: Block[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  stopReason: string;
  errorMessage?: string;
}

export class AgentLoop implements BusMember, ControlledAgent {
  readonly id: string;
  phase: AgentPhase = "new";
  status = "";
  private readonly agent: Agent;
  private pending: InboxMessage[] = [];
  private deliveries = 0;
  private calls = 0;
  private lastCallTokens = 0;
  /** This call's output limit and its reservation against the pool, set when the call is admitted (Controller.admitCall). */
  private callCap = 0;
  private reservation: number | null = null;
  private requestStartedAt = 0;
  private refused: Refusal | null = null;
  private claimed = false;
  private lastStop = "";
  private toolStarted = new Map<string, number>();
  private running: Promise<void> = Promise.resolve();
  /** Runtime notes for the next turn boundary, delivered before any message block. */
  private notes: string[] = [];
  /** Root only: told to fork, forked, model calls completed since the instruction. */
  private instructed = false;
  private forked = false;
  private callsSinceInstruction = 0;
  /** Tools or the system prompt changed in agent.state; the running pi loop takes them over at the next turn boundary. */
  private stateChanged = false;
  /** Run once the current turn's tool calls have all run (see atTurnEnd). */
  private turnEnd: (() => void)[] = [];

  constructor(private readonly o: AgentLoopOptions) {
    this.id = o.id;
    this.lastCallTokens = o.initialCallTokens ?? 0;
    this.agent = new Agent({
      initialState: {
        systemPrompt: o.systemPrompt,
        model: o.runtime.model,
        thinkingLevel: "off",
        tools: o.root?.tools.beforeFork ?? o.tools,
        messages: (o.initialMessages ?? []).filter((m) => m.role !== "system"),
      },
      streamFn: o.runtime.streamFor(o.seed, () => this.callCap),
      toolExecution: "sequential",
      steeringMode: "all",
      followUpMode: "all",
      prepareRequest: async ({ context }) => {
        const maxTokens = o.runtime.model.maxTokens;
        const estimate = estimatePromptTokens(context.messages, this.lastCallTokens, maxTokens);
        const prompt = estimate - maxTokens;
        const admitted = await o.ctx.controller.admitCall(estimate, prompt, maxTokens);
        if (typeof admitted !== "number") {
          this.refused = admitted;
          throw new Error(`call refused: ${admitted}`);
        }
        this.callCap = admitted;
        this.reservation = prompt + admitted;
        this.requestStartedAt = o.clock.now();
      },
      beforeToolCall: async () => (o.ctx.controller.ended ? { block: true, reason: "The run has ended." } : undefined),
      finishTurn: async (turn) => this.finishTurn(turn),
      prepareNextTurnWithContext: (turn) => this.nextTurn(turn),
    });
    this.agent.subscribe((e) => this.onEvent(e));
  }

  start(task: string): Promise<void> {
    this.phase = "working";
    return this.drive(() => this.agent.prompt(task));
  }

  /** Starts from the transcript it was given (`initialMessages`) without a new user message: a fork's copy, whose history ends with its direction. */
  resume(): Promise<void> {
    this.phase = "working";
    return this.drive(() => this.agent.continue());
  }

  receive(msg: InboxMessage): void {
    if (this.phase === "finished" || this.o.ctx.controller.ended) return;
    this.pending.push(msg);
    if (this.phase !== "idle") return;
    this.phase = "working";
    this.o.ctx.log({ kind: "wake", agent: this.id, reason: "message" });
    void this.drive(() => this.continueWithPending());
  }

  isFinished(): boolean {
    return this.phase === "finished";
  }

  isIdleWithNothingPending(): boolean {
    return this.phase === "idle" && this.pending.length === 0 && this.notes.length === 0;
  }

  /** A copy of the transcript as pi holds it (leading system message included). */
  messages(): AgentMessage[] {
    return this.agent.state.messages.slice();
  }

  /** Root only, called by ctx.fork once the copies exist: swaps in the after-fork tools and prompt. Idempotent. */
  afterFork(): void {
    const root = this.o.root;
    if (!root) throw new Error(`agent ${this.id} is not a fork root`);
    if (this.forked) return;
    this.forked = true;
    this.agent.state.tools = root.tools.afterFork;
    this.agent.state.messages = withSystemPrompt(this.agent.state.messages, root.promptAfterFork);
    this.stateChanged = true;
  }

  /** Tokens (prompt and output) of this loop's last model call; a copy inherits it as `initialCallTokens`. */
  get lastCallTokenCount(): number {
    return this.lastCallTokens;
  }

  /** Model calls completed so far; the last one's model_call index is `callCount - 1`. */
  get callCount(): number {
    return this.calls;
  }

  /**
   * Runs `fn` once the current turn's tool calls have all run and their results are in the transcript, before the turn's claim check.
   * For a tool that needs its whole turn (the fork: its copies inherit every result of that turn). Call it only from a running tool.
   */
  atTurnEnd(fn: () => void): void {
    this.turnEnd.push(fn);
  }

  /**
   * Queues a runtime note: a user message for the next turn boundary, logged as runtime_note when it is delivered.
   * Call it only from inside a running turn (the root's turn boundary does): a note queued on an idle loop does not wake it, and
   * would keep isIdleWithNothingPending false, so the run would not end as all_idle.
   */
  noteForRoot(text: string): void {
    this.notes.push(text);
  }

  async stop(): Promise<void> {
    this.agent.abort();
    await this.settled();
  }

  async settled(): Promise<void> {
    await this.running;
    await this.agent.waitForIdle();
  }

  finishOnRunEnd(): void {
    if (this.phase === "finished") return;
    this.phase = "finished";
    this.o.ctx.log({ kind: "agent_finished", agent: this.id, reason: "run_ended" });
  }

  /** Never rejects: a failure inside the drive ends the run as infra_error. */
  private drive(step: () => Promise<void>): Promise<void> {
    this.running = this.driveSteps(step).catch((e: unknown) => {
      const message = `agent ${this.id} failed: ${e instanceof Error ? e.message : String(e)}`;
      console.error(message);
      this.o.ctx.controller.infraError(message);
    });
    return this.running;
  }

  private async driveSteps(step: () => Promise<void>): Promise<void> {
    await step();
    for (;;) {
      if (this.phase === "finished") return;
      if (this.refused === "context") return this.finish("context");
      if (this.refused) return;
      if (this.claimed) return this.finish("claimed");
      if (this.o.ctx.controller.ended) return;
      if (this.lastStop === "error" || this.lastStop === "aborted") return;
      // Cut short by the budget cap (Controller.admitCall), not by the model's own maxTokens: the team has spent its pool.
      if (this.lastStop === "length" && this.callCap < this.o.runtime.model.maxTokens) return this.o.ctx.controller.end("budget");
      if (this.pending.length > 0 || this.notes.length > 0) {
        await this.continueWithPending();
        continue;
      }
      this.phase = "idle";
      this.o.ctx.log({ kind: "idle", agent: this.id });
      if (!this.o.canBeWoken) return this.finish("idle");
      this.o.ctx.controller.checkAllIdle();
      return;
    }
  }

  private async continueWithPending(): Promise<void> {
    const messages = this.takeMessages();
    if (messages.length === 0) return;
    for (const m of messages) this.agent.followUp(m);
    await this.agent.continue();
  }

  /** The user messages for the next turn: runtime notes first (each logged as runtime_note), then the message block. None once the run has ended. */
  private takeMessages(): AgentMessage[] {
    if (this.o.ctx.controller.ended) return [];
    const now = this.o.clock.now();
    const out = this.notes.splice(0).map((text) => {
      this.o.ctx.log({ kind: "runtime_note", agent: this.id, text });
      return { role: "user", content: text, timestamp: now } as AgentMessage;
    });
    const block = this.takeBlock();
    if (block) out.push(block);
    return out;
  }

  private takeBlock(): AgentMessage | undefined {
    if (this.pending.length === 0) return undefined;
    const msgs = orderBlock(this.pending.splice(0));
    const delivery = this.deliveries++;
    for (const m of msgs) this.o.ctx.log({ kind: "message_delivered", agent: this.id, messageId: m.id, delivery });
    return { role: "user", content: formatBlock(msgs), timestamp: this.o.clock.now() } as AgentMessage;
  }

  private finishTurn({ message, toolResults }: AgentTurnContext): AgentTurnDecision | undefined {
    for (const fn of this.turnEnd.splice(0)) fn();
    if (toolResults.some((r) => r.toolName === "claim" && !r.isError)) return { action: "end" };
    // A root must not go idle before its fork, and a queued note needs a turn: run one more, which the boundary fills (nextTurn).
    if (this.o.root && !hasToolCall(message) && (!this.forked || this.notes.length > 0) && this.mayGoOn(message)) return { action: "continue" };
    return undefined;
  }

  /** False where driveSteps ends the agent or the run anyway: the run has ended, the call failed, or the budget cap cut it. */
  private mayGoOn(m: Turn): boolean {
    if (this.o.ctx.controller.ended || m.stopReason === "error" || m.stopReason === "aborted") return false;
    return !(m.stopReason === "length" && this.callCap < this.o.runtime.model.maxTokens);
  }

  /** A turn boundary inside a pi run: the root's fork steps, then notes and the message block, and any tool or prompt change. */
  private nextTurn(turn: AgentTurnContext): AgentLoopTurnUpdate | undefined {
    if (this.o.ctx.controller.ended) return undefined;
    if (this.o.root) this.rootBoundary(turn.message);
    const messages = this.takeMessages();
    const context = this.stateChanged ? this.syncedContext(turn.context) : undefined;
    this.stateChanged = false;
    if (!context && messages.length === 0) return undefined;
    return { ...(context ? { context } : {}), messages };
  }

  /**
   * The root before its fork, after each model call. The first boundary at or past FORK_AT of the pool, or the first turn without a
   * tool call, brings the fork tool and the instruction. FORK_GRACE_CALLS calls after it without a fork, the runtime forks for the root.
   */
  private rootBoundary(m: Turn): void {
    if (this.forked) return;
    const { ctx } = this.o;
    if (!this.instructed) {
      if (hasToolCall(m) && ctx.controller.used < FORK_AT * ctx.controller.pool) return;
      this.instructed = true;
      this.agent.state.tools = [...this.agent.state.tools, forkTool(this.id, ctx)];
      this.stateChanged = true;
      this.noteForRoot(forkInstruction());
      return;
    }
    if (++this.callsSinceInstruction < FORK_GRACE_CALLS) {
      // A turn without a tool call needs a new user message to go on; the instruction is the one that applies.
      if (!hasToolCall(m)) this.noteForRoot(forkInstruction());
      return;
    }
    if (!ctx.fork) throw new Error(`agent ${this.id} cannot fork: the run has no fork mechanism`);
    // ctx.fork calls afterFork; the fallback does not route through the fork tool, whose check would reject three equal directions.
    const children = ctx.fork(this.id, [GENERIC_DIRECTION, GENERIC_DIRECTION, GENERIC_DIRECTION], { fallback: true });
    this.noteForRoot(fallbackNotice(children));
  }

  /** The running loop's context with agent.state's tools and, once forked, the after-fork system prompt. */
  private syncedContext(context: AgentContext): AgentContext {
    const messages = this.forked && this.o.root ? withSystemPrompt(context.messages, this.o.root.promptAfterFork) : context.messages;
    return { ...context, messages, tools: this.agent.state.tools };
  }

  private finish(reason: "claimed" | "idle" | "context"): void {
    this.phase = "finished";
    this.o.ctx.log({ kind: "agent_finished", agent: this.id, reason });
    this.o.ctx.controller.checkAllIdle();
  }

  private onEvent(e: AgentEvent): void {
    const { ctx, clock } = this.o;
    if (e.type === "message_end" && (e.message as { role?: string }).role === "assistant") {
      const m = e.message as unknown as Assistant;
      this.lastStop = m.stopReason;
      const held = this.reservation;
      this.reservation = null;
      if (this.refused) return;
      const content = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const reasoning = m.content.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("");
      const toolCalls = m.content.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id ?? "", name: b.name ?? "", args: b.arguments ?? {} }));
      // pi reports cached prompt tokens apart from input; the whole prompt counts against the pool and the context.
      const tokensIn = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
      const tokens = tokensIn + m.usage.output;
      ctx.log({
        kind: "model_call", agent: this.id, call: this.calls++, content, reasoning, toolCalls,
        tokensIn, tokensOut: m.usage.output, ms: Math.max(0, Math.round(clock.now() - this.requestStartedAt)),
        stopReason: m.stopReason, ...(m.errorMessage ? { error: m.errorMessage } : {}),
      });
      if (held !== null) ctx.controller.settle(held, tokens);
      this.lastCallTokens = tokens;
      const line = content.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
      if (line) {
        this.status = line.slice(0, 140);
        ctx.log({ kind: "status", agent: this.id, text: this.status });
      }
      if (m.stopReason === "error" && !ctx.controller.ended) ctx.controller.infraError(m.errorMessage ?? "model error");
      return;
    }
    if (e.type === "tool_execution_start") {
      this.toolStarted.set(e.toolCallId, clock.now());
      ctx.log({ kind: "tool_call", agent: this.id, callId: e.toolCallId, tool: e.toolName, args: e.args ?? {} });
      return;
    }
    if (e.type === "tool_execution_end") {
      const started = this.toolStarted.get(e.toolCallId) ?? clock.now();
      const result = e.result as { content?: Block[] } | undefined;
      const text = (result?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      ctx.log({ kind: "tool_result", agent: this.id, callId: e.toolCallId, tool: e.toolName, isError: e.isError, text, ms: Math.max(0, Math.round(clock.now() - started)) });
      if (e.toolName === "claim" && !e.isError) this.claimed = true;
    }
  }
}

/**
 * Replaces the leading system message's prompt. pi appends later system content to the leading prompt (it has no replace), and
 * the provider collapses system messages into one, so the prompt is changed in place; the tool declarations it carries stay.
 */
function withSystemPrompt(messages: AgentMessage[], prompt: string): AgentMessage[] {
  const [head, ...rest] = messages;
  if (head?.role !== "system") return [{ role: "system", content: prompt, timestamp: 0 } as AgentMessage, ...messages];
  return [{ ...head, content: prompt } as AgentMessage, ...rest];
}
