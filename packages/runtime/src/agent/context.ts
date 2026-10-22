import { formatBlock, type Event, type InboxMessage, type Of } from "@polylogue/schema";

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

export function contextBeforeCall(events: Event[], agent: string, call: number): CtxMsg[] {
  const run = events.find((e): e is Of<"run_started"> => e.kind === "run_started");
  const start = events.find((e): e is Of<"agent_started"> => e.kind === "agent_started" && e.agent === agent);
  if (!run || !start) throw new Error(`no run_started/agent_started for ${agent}`);
  const messages = new Map<string, InboxMessage>();
  const out: CtxMsg[] = [{ role: "system", text: start.systemPrompt }, { role: "user", text: run.task }];
  let group: { delivery: number; msgs: InboxMessage[] } | null = null;
  const flush = () => {
    if (group) out.push({ role: "user", text: formatBlock(group.msgs) });
    group = null;
  };
  for (const e of events) {
    if (e.kind === "message") messages.set(e.id, { id: e.id, from: e.from, to: e.to, text: e.text, urgent: e.urgent });
    if (!("agent" in e) || e.agent !== agent) continue;
    if (e.kind === "message_delivered") {
      if (group && group.delivery !== e.delivery) flush();
      group ??= { delivery: e.delivery, msgs: [] };
      group.msgs.push(messages.get(e.messageId)!);
      continue;
    }
    if (e.kind === "model_call") {
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
