import type { ConditionName, Event, EventInput } from "@polylogue/schema";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const N: Record<ConditionName, number> = { single: 1, isolated: 4, stigmergic: 4, polylogue: 4, "polylogue-bare": 4 };
const STATUSES = ["reading the case file", "checking shard digits", "comparing notes", "ruling out the retired code", "assembling the code"];

export function simulate(condition: ConditionName, seed: number): Event[] {
  const rnd = mulberry32(seed * 7919 + condition.length);
  const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo));
  const n = N[condition];
  const ids = Array.from({ length: n }, (_, i) => `a${i + 1}`);
  const blackboard = condition !== "single" && condition !== "isolated";
  const messaging = condition.startsWith("polylogue");
  const out: Event[] = [];
  const push = (t: number, e: EventInput) => out.push({ ...e, t } as Event);
  let msgCount = 0;
  const deliveries = new Map<string, number>();

  push(0, { kind: "run_started", condition, n, taskId: "toy-vault", task: "Find the 4-digit vault code.", pool: 60000 * n, wallClockMs: 600000 });
  ids.forEach((id, i) => push(0, { kind: "agent_started", agent: id, index: i, seed: seed * 100 + i, systemPrompt: `You are agent ${id}.`, tools: ["read_shard", "claim"] }));

  const plans = ids.map((id) => {
    const steps = between(3, 6);
    let cursor = between(0, 400);
    for (let k = 0; k < steps; k++) {
      const ms = between(1500, 6000);
      cursor += ms;
      const callId = `${id}-c${k}`;
      push(cursor, { kind: "model_call", agent: id, call: k, content: STATUSES[k % STATUSES.length]!, reasoning: "", toolCalls: [{ id: callId, name: "read_shard", args: { shard: k + 1 } }], tokensIn: 900 + 450 * k, tokensOut: between(40, 260), ms, stopReason: "toolUse" });
      push(cursor, { kind: "status", agent: id, text: STATUSES[k % STATUSES.length]! });
      push(cursor, { kind: "tool_call", agent: id, callId, tool: "read_shard", args: { shard: k + 1 } });
      const toolMs = between(200, 1500);
      cursor += toolMs;
      push(cursor, { kind: "tool_result", agent: id, callId, tool: "read_shard", isError: false, text: `shard ${k + 1}`, ms: toolMs });
      if (blackboard && rnd() < 0.35) push(cursor, { kind: "blackboard", agent: id, text: `shard ${k + 1} read` });
      if (messaging && n > 1 && (rnd() < 0.5 || (id === "a1" && k === 0))) {
        const id2 = `m${msgCount++}`;
        const direct = rnd() < 0.6;
        const others = ids.filter((x) => x !== id);
        const to = direct ? others[between(0, others.length - 1)]! : { topic: "all" };
        const recipients = typeof to === "string" ? [to] : others;
        push(cursor, { kind: "message", id: id2, from: id, to, recipients, text: `shard ${k + 1} says digit ${k + 1}`, urgent: rnd() < 0.1 });
        for (const r of recipients) {
          const d = deliveries.get(r) ?? 0;
          deliveries.set(r, d + 1);
          push(cursor + between(200, 2000), { kind: "message_delivered", agent: r, messageId: id2, delivery: d });
        }
      }
    }
    return { id, claimAt: cursor + between(800, 3000) };
  });

  const solved = rnd() < 0.8;
  const first = plans.reduce((a, b) => (b.claimAt < a.claimAt ? b : a));
  const endT = first.claimAt + 1;
  for (const p of plans) {
    if (p.claimAt > first.claimAt) continue;
    push(p.claimAt, { kind: "claim_submitted", agent: p.id, answer: solved ? "4719" : "4791", evidence: "shards 1, 3, 5, 7" });
    push(p.claimAt, solved ? { kind: "verification", claimOf: p.id, passed: true } : { kind: "verification", claimOf: p.id, passed: false, detail: "expected 4719, got 4791" });
    push(p.claimAt, { kind: "agent_finished", agent: p.id, reason: "claimed" });
  }
  const kept = out.filter((e) => e.t <= endT || e.kind === "agent_started" || e.kind === "run_started");
  for (const p of plans) if (p.id !== first.id) kept.push({ kind: "agent_finished", t: endT, agent: p.id, reason: "run_ended" } as Event);
  const tokens = kept.reduce((s, e) => s + (e.kind === "model_call" ? e.tokensIn + e.tokensOut : 0), 0);
  kept.push({ kind: "run_finished", t: endT, reason: solved ? "solved" : "all_idle", solved, wallMs: endT, totalTokens: tokens } as Event);
  return kept.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map(({ e }) => e);
}
