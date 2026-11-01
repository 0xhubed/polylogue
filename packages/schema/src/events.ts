import { z } from "zod";

export const AgentId = z.string().regex(/^a\d+$/);
const T = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();

export const ConditionName = z.enum(["single", "isolated", "stigmergic", "polylogue", "polylogue-bare", "fork", "fork-silent"]);
export type ConditionName = z.infer<typeof ConditionName>;

export const RunEndReason = z.enum(["solved", "wrong_claim", "budget", "killed", "all_idle", "infra_error"]);
export type RunEndReason = z.infer<typeof RunEndReason>;

export const AgentEndReason = z.enum(["claimed", "idle", "context", "run_ended"]);
export type AgentEndReason = z.infer<typeof AgentEndReason>;

export const Recipient = z.union([AgentId, z.object({ topic: z.string().min(1) })]);
export type Recipient = z.infer<typeof Recipient>;

export const ToolCallInfo = z.object({ id: z.string(), name: z.string(), args: z.unknown() });

export const Event = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run_started"), t: T, condition: ConditionName, n: z.number().int().positive(), taskId: z.string(), task: z.string(), pool: z.number().int().positive(), wallClockMs: z.number().int().positive(), config: z.unknown().optional(), taskFingerprint: z.string().optional() }),
  z.object({ kind: z.literal("agent_started"), t: T, agent: AgentId, index: Count, seed: z.number().int(), systemPrompt: z.string(), tools: z.array(z.string()) }),
  z.object({ kind: z.literal("status"), t: T, agent: AgentId, text: z.string() }),
  z.object({ kind: z.literal("model_call"), t: T, agent: AgentId, call: Count, content: z.string(), reasoning: z.string(), toolCalls: z.array(ToolCallInfo), tokensIn: Count, tokensOut: Count, ms: Count, stopReason: z.string(), error: z.string().optional() }),
  z.object({ kind: z.literal("tool_call"), t: T, agent: AgentId, callId: z.string(), tool: z.string(), args: z.unknown() }),
  z.object({ kind: z.literal("tool_result"), t: T, agent: AgentId, callId: z.string(), tool: z.string(), isError: z.boolean(), text: z.string(), ms: Count }),
  z.object({ kind: z.literal("message"), t: T, id: z.string(), from: AgentId, to: Recipient, recipients: z.array(AgentId), text: z.string(), urgent: z.boolean() }),
  z.object({ kind: z.literal("message_delivered"), t: T, agent: AgentId, messageId: z.string(), delivery: Count }),
  z.object({ kind: z.literal("idle"), t: T, agent: AgentId }),
  z.object({ kind: z.literal("wake"), t: T, agent: AgentId, reason: z.literal("message") }),
  z.object({ kind: z.literal("blackboard"), t: T, agent: AgentId, text: z.string() }),
  z.object({ kind: z.literal("claim_submitted"), t: T, agent: AgentId, answer: z.string(), evidence: z.string() }),
  z.object({ kind: z.literal("verification"), t: T, claimOf: AgentId, passed: z.boolean(), detail: z.string().optional() }),
  z.object({ kind: z.literal("agent_finished"), t: T, agent: AgentId, reason: AgentEndReason }),
  /** The root forked into three copies. `call` is the index of the root's model_call that made the fork call (of its last model call for a fallback). */
  z.object({ kind: z.literal("fork"), t: T, agent: AgentId, call: Count, children: z.array(AgentId).length(3), directions: z.array(z.string()).length(3), fallback: z.boolean() }),
  /** A user message the runtime inserted into that agent's context (not from another agent). */
  z.object({ kind: z.literal("runtime_note"), t: T, agent: AgentId, text: z.string() }),
  z.object({ kind: z.literal("run_finished"), t: T, reason: RunEndReason, solved: z.boolean(), wallMs: Count, totalTokens: Count, detail: z.string().optional() }),
]);
export type Event = z.infer<typeof Event>;
export type EventKind = Event["kind"];
export type Of<K extends EventKind> = Extract<Event, { kind: K }>;
/** An event before the log stamps its time. */
export type EventInput = Event extends infer E ? (E extends Event ? Omit<E, "t"> : never) : never;
