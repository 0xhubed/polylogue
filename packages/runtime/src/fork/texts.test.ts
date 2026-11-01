import { describe, expect, it } from "vitest";
import { FORK_AT, FORK_GRACE_CALLS, GENERIC_DIRECTION, MAX_DIRECTION_CHARS, childForkResult, directionMessage, fallbackNotice, forkInstruction, parentForkResult } from "./texts.ts";

const children = ["a2", "a3", "a4"];
const directions = ["Check clue 1 first.", "Check clue 2 first.", "Try to disprove the leading answer."];

describe("fork constants", () => {
  it("are the pre-registered values", () => {
    expect([FORK_AT, MAX_DIRECTION_CHARS, FORK_GRACE_CALLS]).toEqual([0.1, 300, 2]);
    expect(GENERIC_DIRECTION).toBe("Take a different approach from your siblings.");
    expect(GENERIC_DIRECTION.length).toBeLessThanOrEqual(MAX_DIRECTION_CHARS);
  });
});

describe("fork texts", () => {
  it("are deterministic", () => {
    expect(forkInstruction()).toBe(forkInstruction());
    expect(parentForkResult(children, directions)).toBe(parentForkResult(children, directions));
    expect(childForkResult("a3")).toBe(childForkResult("a3"));
    expect(directionMessage(directions[0]!)).toBe(directionMessage(directions[0]!));
    expect(fallbackNotice(children)).toBe(fallbackNotice(children));
  });

  it("tell the root to fork now with three directions of bounded length", () => {
    const t = forkInstruction();
    expect(t).toContain("fork");
    expect(t).toContain("three");
    expect(t).toContain(String(MAX_DIRECTION_CHARS));
  });

  it("list every child with its direction in the root's fork result", () => {
    const t = parentForkResult(children, directions);
    children.forEach((c, i) => expect(t).toContain(`${c}: ${directions[i]}`));
  });

  it("tell a copy who it is and carry its direction in the next message", () => {
    expect(childForkResult("a3")).toContain("a3");
    expect(directionMessage(directions[1]!)).toContain(directions[1]!);
  });

  it("tell the root after a fallback which copies exist and what they were told", () => {
    const t = fallbackNotice(children);
    for (const c of children) expect(t).toContain(c);
    expect(t).toContain(GENERIC_DIRECTION);
  });
});
