import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export interface WorkTool {
  name: string;
  description: string;
  parameters: TSchema;
  // biome-ignore lint: arguments are validated by pi against `parameters`
  run(args: any, signal?: AbortSignal): Promise<string>;
}

export const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

/** Infers the parameter types from the schema (pi 1.1.0 types `execute`'s params as `Static<TParameters>`; `AgentTool<any>` would make them `unknown`). */
export function defineTool<P extends TSchema>(t: AgentTool<P>): AgentTool<any> {
  return t as AgentTool<any>;
}

export function toAgentTool(w: WorkTool): AgentTool<any> {
  return { name: w.name, label: w.name, description: w.description, parameters: w.parameters, execute: async (_id, args, signal) => text(await w.run(args, signal)) };
}
