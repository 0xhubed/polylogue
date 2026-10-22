import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { formatBlock, orderBlock, type InboxMessage } from "@polylogue/schema";
import type { Clock } from "../clock.ts";
import type { BusMember } from "../comm/bus.ts";
import type { ControlledAgent, Refusal } from "../control/controller.ts";
import type { ModelRuntime } from "../model/provider.ts";
import type { AgentPhase, RunContext } from "../run/context.ts";
import { estimatePromptTokens } from "./estimate.ts";

export interface AgentLoopOptions {
  id: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  runtime: ModelRuntime;
  seed: number;
  canBeWoken: boolean;
  ctx: RunContext;
  clock: Clock;
}

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

  constructor(private readonly o: AgentLoopOptions) {
    this.id = o.id;
    this.agent = new Agent({
      initialState: { systemPrompt: o.systemPrompt, model: o.runtime.model, thinkingLevel: "off", tools: o.tools, messages: [] },
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
      finishTurn: async ({ toolResults }) =>
        toolResults.some((r) => (r as { toolName?: string; isError?: boolean }).toolName === "claim" && !(r as { isError?: boolean }).isError)
          ? { action: "end" }
          : undefined,
      prepareNextTurnWithContext: () => this.takeBlock(),
    });
    this.agent.subscribe((e) => this.onEvent(e));
  }

  start(task: string): Promise<void> {
    this.phase = "working";
    return this.drive(() => this.agent.prompt(task));
  }

  receive(msg: InboxMessage): void {
    if (this.phase === "finished" || this.o.ctx.controller.ended) return;
    this.pending.push(msg);
    if (this.phase !== "idle") return;
    this.phase = "working";
    this.o.ctx.log({ kind: "wake", agent: this.id, reason: "message" });
    void this.drive(() => this.continueWithBlock());
  }

  isFinished(): boolean {
    return this.phase === "finished";
  }

  isIdleWithNothingPending(): boolean {
    return this.phase === "idle" && this.pending.length === 0;
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
      if (this.pending.length > 0) {
        await this.continueWithBlock();
        continue;
      }
      this.phase = "idle";
      this.o.ctx.log({ kind: "idle", agent: this.id });
      if (!this.o.canBeWoken) return this.finish("idle");
      this.o.ctx.controller.checkAllIdle();
      return;
    }
  }

  private async continueWithBlock(): Promise<void> {
    const block = this.takeBlock();
    if (!block) return;
    this.agent.followUp(block.messages[0]!);
    await this.agent.continue();
  }

  private takeBlock(): { messages: AgentMessage[] } | undefined {
    if (this.pending.length === 0 || this.o.ctx.controller.ended) return undefined;
    const msgs = orderBlock(this.pending.splice(0));
    const delivery = this.deliveries++;
    for (const m of msgs) this.o.ctx.log({ kind: "message_delivered", agent: this.id, messageId: m.id, delivery });
    return { messages: [{ role: "user", content: formatBlock(msgs), timestamp: this.o.clock.now() } as AgentMessage] };
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
