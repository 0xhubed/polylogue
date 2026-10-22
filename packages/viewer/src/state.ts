import type { Event, Of } from "@polylogue/schema";

export type Phase = "thinking" | "tool" | "working" | "idle" | "finished";
export interface AgentView { id: string; status: string; phase: Phase; tokens: number; sent: number; finishedReason?: string }
export interface Segment { kind: "model" | "tool" | "idle"; start: number; end: number }
export interface Lane { agent: string; segments: Segment[]; marks: { kind: "sent" | "received" | "blackboard" | "claim"; t: number }[] }
export interface EdgeView { from: string; to: string; count: number; lastT: number; active: boolean }
export interface Counters { tokens: number; pool: number; wallMs: number; messages: number; messagesPerMinute: number }
export interface ViewState {
  t: number;
  duration: number;
  run?: Of<"run_started">;
  ended?: Of<"run_finished">;
  agents: AgentView[];
  edges: EdgeView[];
  lanes: Lane[];
  chat: Of<"message">[];
  blackboard: Of<"blackboard">[];
  counters: Counters;
}

export const ACTIVE_EDGE_MS = 3000;

export function stateAt(events: Event[], t: number): ViewState {
  const duration = events.reduce((m, e) => Math.max(m, e.t), 0);
  const seen = events.filter((e) => e.t <= t);
  const run = seen.find((e): e is Of<"run_started"> => e.kind === "run_started");
  const ended = seen.find((e): e is Of<"run_finished"> => e.kind === "run_finished");
  const ids = seen.flatMap((e) => (e.kind === "agent_started" ? [e.agent] : []));
  const agents = new Map<string, AgentView>(ids.map((id) => [id, { id, status: "", phase: "working" as Phase, tokens: 0, sent: 0 }]));
  const lanes = new Map<string, Lane>(ids.map((id) => [id, { agent: id, segments: [], marks: [] }]));
  const edges = new Map<string, EdgeView>();
  const chat: Of<"message">[] = [];
  const blackboard: Of<"blackboard">[] = [];
  const openTools = new Map<string, number>();
  const openIdle = new Map<string, number>();
  let tokens = 0;

  const addSegment = (agent: string, kind: Segment["kind"], start: number, end: number) => {
    if (start > t) return;
    lanes.get(agent)?.segments.push({ kind, start, end: Math.min(end, t) });
  };
  const closeIdle = (agent: string, at: number) => {
    const start = openIdle.get(agent);
    if (start !== undefined) addSegment(agent, "idle", start, at);
    openIdle.delete(agent);
  };
  const addEdge = (from: string, to: string, at: number) => {
    const key = `${from}->${to}`;
    const e = edges.get(key) ?? { from, to, count: 0, lastT: at, active: false };
    e.count += 1;
    e.lastT = at;
    edges.set(key, e);
  };

  // A model call is logged when it ends; its segment starts at t - ms, so take it from all events.
  for (const e of events) if (e.kind === "model_call") addSegment(e.agent, "model", Math.max(0, e.t - e.ms), e.t);

  for (const e of seen) {
    switch (e.kind) {
      case "status":
        agents.get(e.agent)!.status = e.text;
        break;
      case "model_call":
        tokens += e.tokensIn + e.tokensOut;
        agents.get(e.agent)!.tokens += e.tokensIn + e.tokensOut;
        break;
      case "tool_call":
        openTools.set(e.callId, e.t);
        break;
      case "tool_result": {
        const start = openTools.get(e.callId) ?? e.t - e.ms;
        openTools.delete(e.callId);
        addSegment(e.agent, "tool", start, e.t);
        if (e.tool === "claim") lanes.get(e.agent)?.marks.push({ kind: "claim", t: e.t });
        break;
      }
      case "idle":
        openIdle.set(e.agent, e.t);
        break;
      case "wake":
        closeIdle(e.agent, e.t);
        break;
      case "message": {
        chat.push(e);
        agents.get(e.from)!.sent += 1;
        lanes.get(e.from)?.marks.push({ kind: "sent", t: e.t });
        for (const to of e.recipients) addEdge(e.from, to, e.t);
        break;
      }
      case "message_delivered":
        lanes.get(e.agent)?.marks.push({ kind: "received", t: e.t });
        break;
      case "blackboard":
        blackboard.push(e);
        lanes.get(e.agent)?.marks.push({ kind: "blackboard", t: e.t });
        break;
      case "agent_finished": {
        closeIdle(e.agent, e.t);
        const a = agents.get(e.agent)!;
        a.phase = "finished";
        a.finishedReason = e.reason;
        break;
      }
      default:
        break;
    }
  }
  for (const [callId, start] of openTools) {
    const call = seen.find((e) => e.kind === "tool_call" && e.callId === callId) as Of<"tool_call"> | undefined;
    if (call) addSegment(call.agent, "tool", start, t);
  }
  for (const agent of [...openIdle.keys()]) closeIdle(agent, t);

  for (const lane of lanes.values()) lane.segments.sort((a, b) => a.start - b.start);
  for (const a of agents.values()) {
    if (a.phase === "finished") continue;
    const current = lanes.get(a.id)!.segments.filter((s) => s.start <= t && t <= s.end).at(-1);
    a.phase = current ? (current.kind === "model" ? "thinking" : current.kind) : "working";
  }

  for (const e of edges.values()) e.active = t - e.lastT <= ACTIVE_EDGE_MS;
  const messagesPerMinute = chat.filter((m) => t - 60_000 < m.t && m.t <= t).length;
  return {
    t, duration, run, ended,
    agents: [...agents.values()],
    edges: [...edges.values()],
    lanes: [...lanes.values()],
    chat, blackboard,
    counters: { tokens, pool: run?.pool ?? 0, wallMs: t, messages: chat.length, messagesPerMinute },
  };
}
