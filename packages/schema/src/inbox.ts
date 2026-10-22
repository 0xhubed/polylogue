export interface InboxMessage {
  id: string;
  from: string;
  to: string | { topic: string };
  text: string;
  urgent: boolean;
}

/** Urgent messages first; arrival order is kept within each group. */
export function orderBlock(msgs: readonly InboxMessage[]): InboxMessage[] {
  return [...msgs.filter((m) => m.urgent), ...msgs.filter((m) => !m.urgent)];
}

/** The exact text an agent receives as one user message at a turn boundary. */
export function formatBlock(msgs: readonly InboxMessage[]): string {
  return orderBlock(msgs)
    .map((m) => `[${m.urgent ? "URGENT " : ""}from ${m.from}${typeof m.to === "string" ? "" : ` on #${m.to.topic}`}] ${m.text}`)
    .join("\n");
}
