import type { AgentMessage } from "@earendil-works/pi-agent-core";

type Block = { type: string; text?: string; thinking?: string };

export function messageText(m: AgentMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((b) => (b.type === "text" ? (b.text ?? "") : b.type === "thinking" ? (b.thinking ?? "") : "")).join("");
}

export function estimatePromptTokens(messages: AgentMessage[], lastCallTokens: number, maxTokens: number): number {
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if ((m as { role?: string }).role === "assistant") lastAssistant = i;
  });
  const tail = messages.slice(lastAssistant + 1);
  const chars = tail.reduce((n, m) => n + messageText(m).length, 0);
  return lastCallTokens + Math.ceil(chars / 3) + maxTokens;
}
