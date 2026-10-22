import type { EventInput } from "@polylogue/schema";
import type { Controller } from "../control/controller.ts";
import type { Bus } from "../comm/bus.ts";
import type { Blackboard } from "../comm/blackboard.ts";

export type AgentPhase = "new" | "working" | "idle" | "finished";

export interface AgentDirectory {
  ids(): string[];
  status(id: string): string;
  phase(id: string): AgentPhase;
}

export interface RunContext {
  log(e: EventInput): void;
  controller: Controller;
  bus: Bus;
  board: Blackboard;
  dir: AgentDirectory;
}
