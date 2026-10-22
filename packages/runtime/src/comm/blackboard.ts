import type { EventInput } from "@polylogue/schema";

export class Blackboard {
  private entries: { agent: string; text: string }[] = [];

  constructor(private readonly log: (e: EventInput) => void) {}

  append(agent: string, text: string): void {
    this.entries.push({ agent, text });
    this.log({ kind: "blackboard", agent, text });
  }

  read(): string {
    if (this.entries.length === 0) return "(the blackboard is empty)";
    return this.entries.map((e) => `[${e.agent}] ${e.text}`).join("\n");
  }
}
