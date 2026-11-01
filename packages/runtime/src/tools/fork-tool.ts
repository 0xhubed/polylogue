import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { RunContext } from "../run/context.ts";
import { MAX_DIRECTION_CHARS, parentForkResult } from "../fork/texts.ts";
import { defineTool, text } from "./work-tool.ts";

const COPIES = 3;

/** Checks the fork call's directions: exactly three non-empty, distinct strings of at most MAX_DIRECTION_CHARS each. Returns them trimmed. */
export function validateDirections(x: unknown): { ok: true; directions: string[] } | { ok: false; error: string } {
  if (!Array.isArray(x) || x.length !== COPIES) return { ok: false, error: `Give exactly ${COPIES} directions, one for each copy.` };
  if (x.some((d) => typeof d !== "string")) return { ok: false, error: "Each direction must be a string." };
  const directions = (x as string[]).map((d) => d.trim());
  if (directions.some((d) => d === "")) return { ok: false, error: "A direction is empty." };
  const long = directions.find((d) => d.length > MAX_DIRECTION_CHARS);
  if (long !== undefined) return { ok: false, error: `A direction is ${long.length} characters; the limit is ${MAX_DIRECTION_CHARS}.` };
  if (new Set(directions.map((d) => d.toLowerCase())).size !== COPIES) return { ok: false, error: "The directions must be different from each other." };
  return { ok: true, directions };
}

/** The `directions` parameter arrives as an array of strings, or (from a server that hands arrays over as text) as a string holding a JSON array of strings. */
export function parseDirections(x: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof x !== "string") return { ok: true, value: x };
  const bad = { ok: false as const, error: "directions must be an array of strings, or a string holding a JSON array of strings, for example [\"first direction\", \"second direction\", \"third direction\"]." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(x);
  } catch {
    return bad;
  }
  return Array.isArray(parsed) && parsed.every((d) => typeof d === "string") ? { ok: true, value: parsed } : bad;
}

export function forkTool(agentId: string, ctx: RunContext): AgentTool<any> {
  return defineTool({
    name: "fork",
    label: "fork",
    description: `Split into ${COPIES} copies of yourself, each starting from everything you have done so far with its own direction. Give exactly ${COPIES} different directions, each one short paragraph of at most ${MAX_DIRECTION_CHARS} characters. You can do this once.`,
    parameters: Type.Object({ directions: Type.Union([Type.Array(Type.String()), Type.String()]) }),
    execute: async (_id, p) => {
      if (!ctx.fork || !ctx.forked) throw new Error("Forking is not available in this run.");
      if (ctx.forked()) throw new Error("You have already forked.");
      const parsed = parseDirections(p.directions);
      if (!parsed.ok) throw new Error(parsed.error);
      const v = validateDirections(parsed.value);
      if (!v.ok) throw new Error(v.error);
      const children = ctx.fork(agentId, v.directions, { fallback: false });
      return text(parentForkResult(children, v.directions));
    },
  });
}
