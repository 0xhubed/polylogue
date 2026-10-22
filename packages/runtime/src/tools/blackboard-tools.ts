import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { RunContext } from "../run/context.ts";
import { defineTool, text } from "./work-tool.ts";

export function blackboardTools(agentId: string, ctx: RunContext): AgentTool<any>[] {
  return [
    defineTool({
      name: "read_blackboard",
      label: "read_blackboard",
      description: "Read every entry on the shared blackboard.",
      parameters: Type.Object({}),
      execute: async () => text(ctx.board.read()),
    }),
    defineTool({
      name: "append_blackboard",
      label: "append_blackboard",
      description: "Add one entry to the shared blackboard.",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, p) => {
        if (!p.text.trim()) throw new Error("The entry is empty.");
        ctx.board.append(agentId, p.text);
        return text("Appended.");
      },
    }),
  ];
}
