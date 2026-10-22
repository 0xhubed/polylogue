import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Condition } from "../conditions.ts";
import type { RunContext } from "../run/context.ts";
import { blackboardTools } from "./blackboard-tools.ts";
import { claimTool } from "./claim-tool.ts";
import { commTools } from "./comm-tools.ts";
import { toAgentTool, type WorkTool } from "./work-tool.ts";

export function buildTools(c: Condition, agentId: string, ctx: RunContext, work: WorkTool[]): AgentTool<any>[] {
  return [
    ...work.map(toAgentTool),
    claimTool(agentId, ctx),
    ...(c.blackboard ? blackboardTools(agentId, ctx) : []),
    ...(c.messaging ? commTools(agentId, ctx) : []),
  ];
}
