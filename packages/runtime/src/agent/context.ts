import { formatBlock, type Event, type InboxMessage, type Of } from "@polylogue/schema";
import { CONDITIONS, rootPromptAfterFork } from "../conditions.ts";
import { childForkResult, directionMessage } from "../fork/texts.ts";

export interface CtxMsg {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
}

function assistant(text: string, reasoning: string, toolCalls: { id: string; name: string; args: unknown }[]): CtxMsg {
  const m: CtxMsg = { role: "assistant", text };
  if (reasoning) m.reasoning = reasoning;
  if (toolCalls.length) m.toolCalls = toolCalls;
  return m;
}

/**
 * The context an agent's model call `call` was sent, rebuilt from the log alone. A fork run (spec §4.4):
 * - The root: runtime notes are user messages where they were logged; for its calls after `fork.call` its system message is the
 *   after-fork prompt, which the runtime puts in place of the first (rootPromptAfterFork is deterministic, so no event holds it).
 * - A copy: its own system prompt, then the root's context as it stood when the `fork` event was logged (the copies are made at the
 *   end of the fork turn, so that is every tool result of that turn), with the root's fork result replaced by childForkResult(copy),
 *   then directionMessage(direction), then the copy's own events. A fallback has no fork call, so nothing is replaced.
 */
export function contextBeforeCall(events: Event[], agent: string, call: number): CtxMsg[] {
  const run = events.find((e): e is Of<"run_started"> => e.kind === "run_started");
  const start = events.find((e): e is Of<"agent_started"> => e.kind === "agent_started" && e.agent === agent);
  if (!run || !start) throw new Error(`no run_started/agent_started for ${agent}`);
  const messages = new Map<string, InboxMessage>();
  for (const e of events) if (e.kind === "message") messages.set(e.id, { id: e.id, from: e.from, to: e.to, text: e.text, urgent: e.urgent });
  const system: CtxMsg = { role: "system", text: start.systemPrompt };
  const task: CtxMsg = { role: "user", text: run.task };
  const forkAt = events.findIndex((e) => e.kind === "fork");
  const fork = forkAt >= 0 ? (events[forkAt] as Of<"fork">) : undefined;
  const child = fork ? fork.children.indexOf(agent) : -1;
  if (fork && child >= 0) {
    const before = events.slice(0, forkAt);
    const inherited = replay(before, fork.agent, [task], messages, undefined);
    if (!fork.fallback) {
      // The root's one successful fork call; a malformed or repeated fork call in the same turn is an error and is inherited as it is.
      const result = before.find((e): e is Of<"tool_result"> => e.kind === "tool_result" && e.agent === fork.agent && e.tool === "fork" && !e.isError);
      const at = result ? inherited.findIndex((m) => m.role === "tool" && m.toolCallId === result.callId) : -1;
      if (at < 0) throw new Error(`no result for ${fork.agent}'s fork call before the fork event`);
      inherited[at] = { role: "tool", text: childForkResult(agent), toolCallId: result!.callId };
    }
    const direction: CtxMsg = { role: "user", text: directionMessage(fork.directions[child]!) };
    return replay(events.slice(forkAt + 1), agent, [system, ...inherited, direction], messages, call);
  }
  const out = replay(events, agent, [system, task], messages, call);
  if (fork && agent === fork.agent && call > fork.call) {
    const ids = Array.from({ length: run.n }, (_, i) => `a${i + 1}`);
    out[0] = { role: "system", text: rootPromptAfterFork(CONDITIONS[run.condition], ids) };
  }
  return out;
}

/** Appends `agent`'s events to `out`, up to its model call `call` (all of them if `call` is undefined or not reached). */
function replay(events: Event[], agent: string, out: CtxMsg[], messages: Map<string, InboxMessage>, call: number | undefined): CtxMsg[] {
  let group: { delivery: number; msgs: InboxMessage[] } | null = null;
  const flush = () => {
    if (group) out.push({ role: "user", text: formatBlock(group.msgs) });
    group = null;
  };
  for (const e of events) {
    if (!("agent" in e) || e.agent !== agent) continue;
    if (e.kind === "message_delivered") {
      if (group && group.delivery !== e.delivery) flush();
      group ??= { delivery: e.delivery, msgs: [] };
      group.msgs.push(messages.get(e.messageId)!);
      continue;
    }
    if (e.kind === "runtime_note") {
      // Notes are delivered before any message block at the same boundary.
      flush();
      out.push({ role: "user", text: e.text });
    } else if (e.kind === "model_call") {
      flush();
      if (e.call === call) return out;
      out.push(assistant(e.content, e.reasoning, e.toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.args }))));
    } else if (e.kind === "tool_result") {
      flush();
      out.push({ role: "tool", text: e.text, toolCallId: e.callId });
    }
  }
  flush();
  return out;
}

type Part = { type?: string; text?: string };
// biome-ignore lint: request bodies are arbitrary JSON
export function normalizeOpenAIMessages(messages: any[]): CtxMsg[] {
  return messages.map((m) => {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as Part[]).map((p) => p.text ?? "").join("") : "";
    if (m.role === "assistant") {
      const calls = (m.tool_calls ?? []).map((tc: { id: string; function: { name: string; arguments: string } }) => ({ id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") }));
      return assistant(text, m.reasoning_content ?? "", calls);
    }
    if (m.role === "tool") return { role: "tool", text, toolCallId: m.tool_call_id };
    return { role: m.role, text };
  });
}
