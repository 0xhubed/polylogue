/** Fixed values of the fork mechanism (phase 2, spec §4). Set a priori; not tuned in the pilot. */
/** The fork is called for when the tokens charged to the pool reach this fraction of it. */
export const FORK_AT = 0.1;
/** A direction is one short paragraph. */
export const MAX_DIRECTION_CHARS = 300;
/** Model calls the root gets after being told to fork; if it has not forked by then, the runtime forks for it. */
export const FORK_GRACE_CALLS = 2;
/** The direction all three copies get when the runtime forks for the root. */
export const GENERIC_DIRECTION = "Take a different approach from your siblings.";

/** The user message that tells the root to fork now. */
export function forkInstruction(): string {
  return `Fork now: call fork with three different directions, one for each of three copies of you. Each direction is one short paragraph of at most ${MAX_DIRECTION_CHARS} characters, for example one clue or one hypothesis each. If you already have an answer, a direction can be a way to check it. The copies start from everything you have done so far. After the split, all four of you can claim.`;
}

/** The root's tool result for its fork call. */
export function parentForkResult(children: string[], directions: string[]): string {
  const lines = children.map((id, i) => `${id}: ${directions[i]}`);
  return `Forked. Three copies of you now work on the task, each with the direction you gave it:\n${lines.join("\n")}\nYou continue as the fourth agent. Claiming is now open.`;
}

/** The result a copy sees for the fork call it inherited from the root. */
export function childForkResult(childId: string): string {
  return `Forked. You are ${childId}, a copy of the agent that made this call. Your direction follows in the next message. Claiming is now open.`;
}

/** The user message that gives a copy its own direction. */
export function directionMessage(direction: string): string {
  return `Your direction: ${direction}`;
}

/** The note the root gets when the runtime forked for it. */
export function fallbackNotice(children: string[]): string {
  return `You did not fork in time, so the runtime forked for you. ${children.join(", ")} are copies of you, and each was told: "${GENERIC_DIRECTION}" You continue as the fourth agent. Claiming is now open.`;
}
