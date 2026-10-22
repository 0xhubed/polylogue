import type { ConditionName } from "@polylogue/schema";

export interface Condition {
  name: ConditionName;
  n: number;
  blackboard: boolean;
  messaging: boolean;
  norms: boolean;
  /** The first claim ends the run (the team's one answer). Off for isolated: its agents cannot see each other, so the run goes on and is
   *  scored both ways from the log, first claim and best-of-N with the verifier. */
  firstClaimEnds: boolean;
}

export const CONDITIONS: Record<ConditionName, Condition> = {
  single: { name: "single", n: 1, blackboard: false, messaging: false, norms: false, firstClaimEnds: true },
  isolated: { name: "isolated", n: 4, blackboard: false, messaging: false, norms: false, firstClaimEnds: false },
  stigmergic: { name: "stigmergic", n: 4, blackboard: true, messaging: false, norms: false, firstClaimEnds: true },
  polylogue: { name: "polylogue", n: 4, blackboard: true, messaging: true, norms: true, firstClaimEnds: true },
  "polylogue-bare": { name: "polylogue-bare", n: 4, blackboard: true, messaging: true, norms: false, firstClaimEnds: true },
};

/** Protocol norms from IDEA.md §5, adapted to this tool set (findings.md is the blackboard). */
export const NORMS = [
  "Team norms:",
  "1. Start by publishing a one-line plan on #all (what you will do), then check roster and read_blackboard before you start work.",
  "2. Every claim you share comes with evidence: a quote, a tool result or a derivation.",
  "3. Ask instead of guessing. If nobody answers before you need it, state your assumption and continue.",
  '4. Share conclusions, not reasoning traces ("X ruled out because Y").',
].join("\n");

const CLAIM_RULE =
  "When you know the answer, call claim with the answer and your evidence. You can claim only once, claiming ends your work, and you will not be told whether the answer was correct.";

/** One team answer, so a team cannot win by several agents guessing (decided 2026-10-16 after P1); told to every team whose run it ends. */
const TEAM_CLAIM_RULE = "The first claim by any agent is the team's answer and ends the run for everyone.";

export function systemPrompt(c: Condition, agentId: string, ids: string[]): string {
  const others = ids.filter((id) => id !== agentId).join(", ");
  const parts = [`You are agent ${agentId}.`];
  if (c.name === "single") parts.push("You work alone on the task below.");
  else if (!c.blackboard && !c.messaging) parts.push(`${c.n} agents work on the task below independently. You cannot contact the others.`);
  else if (!c.messaging) parts.push(`You are one of ${c.n} agents working on the task below; the others are ${others}. You share a blackboard: read_blackboard shows every entry, append_blackboard adds one. There is no other way to reach the others.`);
  else parts.push(`You are one of ${c.n} agents working on the task below; the others are ${others}. Use send to message one agent and publish to message a topic (every agent hears #all; subscribe to hear other topics); roster shows the team and what each agent is doing, and the blackboard (read_blackboard, append_blackboard) keeps shared notes. Messages from others arrive between your steps. If you have nothing to do, end your turn without a tool call; a new message will wake you.`);
  if (!c.messaging) parts.push("Ending your turn without a tool call ends your work.");
  parts.push(CLAIM_RULE);
  if (c.n > 1 && c.firstClaimEnds) parts.push(TEAM_CLAIM_RULE);
  const prompt = parts.join(" ");
  return c.norms ? `${prompt}\n\n${NORMS}` : prompt;
}

export function toolNames(c: Condition, workTools: string[]): string[] {
  return [
    ...workTools,
    "claim",
    ...(c.blackboard ? ["read_blackboard", "append_blackboard"] : []),
    ...(c.messaging ? ["send", "publish", "subscribe", "roster"] : []),
  ];
}
