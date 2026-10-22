import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { RunContext } from "../run/context.ts";
import { defineTool, text } from "./work-tool.ts";

export function claimTool(agentId: string, ctx: RunContext): AgentTool<any> {
  return defineTool({
    name: "claim",
    label: "claim",
    description: "Submit your final answer with your evidence. You can do this once; it ends your work. You will not be told whether it was correct.",
    parameters: Type.Object({ answer: Type.String(), evidence: Type.String() }),
    execute: async (_id, p) => text(ctx.controller.claim(agentId, p.answer, p.evidence)),
  });
}
