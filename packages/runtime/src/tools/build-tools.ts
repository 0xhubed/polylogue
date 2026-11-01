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

/**
 * The tools of a fork run (spec §4). `root-before`: the root's work tools before the fork (the root's loop adds the fork tool when it
 * is told to fork). `after`: every agent's tools once forked, the work tools, then claim, then messaging in `fork`. No blackboard.
 */
export function buildForkTools(c: Condition, agentId: string, ctx: RunContext, work: WorkTool[], phase: "root-before" | "after"): AgentTool<any>[] {
  const tools = work.map(toAgentTool);
  if (phase === "root-before") return tools;
  return [...tools, claimTool(agentId, ctx), ...(c.messaging ? commTools(agentId, ctx) : [])];
}
