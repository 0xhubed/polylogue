import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { RunContext } from "../run/context.ts";
import { defineTool, text } from "./work-tool.ts";

function checkText(agentId: string, ctx: RunContext, body: string): void {
  if (!body.trim()) throw new Error("The message is empty.");
  const err = ctx.controller.checkMessage(agentId, body);
  if (err) throw new Error(err);
}

/** " #all " → "all"; an empty topic is a tool error. */
function normTopic(raw: string): string {
  const topic = raw.trim().replace(/^#/, "").trim();
  if (!topic) throw new Error("The topic is empty.");
  return topic;
}

export function commTools(agentId: string, ctx: RunContext): AgentTool<any>[] {
  return [
    defineTool({
      name: "send",
      label: "send",
      description: "Send a message to one agent. It arrives between that agent's steps. Set urgent for messages that must come first.",
      parameters: Type.Object({ to: Type.String(), text: Type.String(), urgent: Type.Optional(Type.Boolean()) }),
      execute: async (_id, p) => {
        if (p.to === agentId) throw new Error("You cannot message yourself.");
        if (!ctx.bus.has(p.to)) throw new Error(`There is no agent ${p.to}. Agents: ${ctx.dir.ids().join(", ")}.`);
        if (ctx.bus.isFinished(p.to)) throw new Error(`${p.to} has finished and cannot receive messages.`);
        checkText(agentId, ctx, p.text);
        ctx.bus.post(agentId, p.to, p.text, p.urgent ?? false);
        return text(`Sent to ${p.to}.`);
      },
    }),
    defineTool({
      name: "publish",
      label: "publish",
      description: "Send a message to every agent subscribed to a topic. Every agent hears #all.",
      parameters: Type.Object({ topic: Type.String(), text: Type.String(), urgent: Type.Optional(Type.Boolean()) }),
      execute: async (_id, p) => {
        const topic = normTopic(p.topic);
        checkText(agentId, ctx, p.text);
        const { recipients } = ctx.bus.post(agentId, { topic }, p.text, p.urgent ?? false);
        return text(`Published to #${topic} (${recipients.length} agent${recipients.length === 1 ? "" : "s"}).`);
      },
    }),
    defineTool({
      name: "subscribe",
      label: "subscribe",
      description: "Start hearing messages published to a topic.",
      parameters: Type.Object({ topic: Type.String() }),
      execute: async (_id, p) => {
        const topic = normTopic(p.topic);
        ctx.bus.subscribe(agentId, topic);
        return text(`Subscribed to #${topic}.`);
      },
    }),
    defineTool({
      name: "roster",
      label: "roster",
      description: "List the agents, whether each is working, idle or finished, and its latest status line.",
      parameters: Type.Object({}),
      execute: async () =>
        text(
          ctx.dir
            .ids()
            .map((id) => {
              const status = ctx.dir.status(id);
              return `${id}${id === agentId ? " (you)" : ""}: ${ctx.dir.phase(id)}${status ? ` — ${status}` : ""}`;
            })
            .join("\n"),
        ),
    }),
  ];
}
