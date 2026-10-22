import type { EventInput, InboxMessage } from "@polylogue/schema";

export interface BusMember {
  id: string;
  receive(msg: InboxMessage): void;
  isFinished(): boolean;
}

export class Bus {
  private members = new Map<string, BusMember>();
  private subs = new Map<string, Set<string>>();
  private count = 0;

  constructor(private readonly log: (e: EventInput) => void) {}

  add(m: BusMember): void {
    this.members.set(m.id, m);
    this.subscribe(m.id, "all");
  }

  has(id: string): boolean {
    return this.members.has(id);
  }

  isFinished(id: string): boolean {
    return this.members.get(id)?.isFinished() ?? true;
  }

  ids(): string[] {
    return [...this.members.keys()];
  }

  subscribe(agentId: string, topic: string): void {
    const set = this.subs.get(topic) ?? new Set<string>();
    set.add(agentId);
    this.subs.set(topic, set);
  }

  /** Logs the message with its live recipients, then hands it to every live recipient. Validation is the caller's job. */
  post(from: string, to: string | { topic: string }, text: string, urgent: boolean): { id: string; recipients: string[] } {
    const id = `m${this.count++}`;
    const targets = typeof to === "string" ? [to] : [...(this.subs.get(to.topic) ?? [])].filter((a) => a !== from);
    const recipients = targets.filter((a) => this.members.has(a) && !this.members.get(a)!.isFinished());
    this.log({ kind: "message", id, from, to, recipients, text, urgent });
    const msg: InboxMessage = { id, from, to, text, urgent };
    for (const a of recipients) this.members.get(a)!.receive(msg);
    return { id, recipients };
  }
}
