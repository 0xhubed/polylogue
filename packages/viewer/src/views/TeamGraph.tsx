import { BaseEdge, Handle, MarkerType, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import type { AgentView, ViewState } from "../state.ts";

const NODE_W = 150;
const NODE_H = 62;
const CURVE = 30;

type AgentNode = Node<{ agent: AgentView }, "agent">;
type FlowEdge = Edge<{ text: string }, "directed">;

const hidden = { top: "50%", left: "50%", transform: "none", width: 1, height: 1, minWidth: 0, minHeight: 0, opacity: 0, border: 0 } as const;

function AgentNodeView({ data }: NodeProps<AgentNode>) {
  const a = data.agent;
  return (
    <div className={`node ${a.phase}`} style={{ width: NODE_W, height: NODE_H }}>
      <Handle type="target" position={Position.Top} isConnectable={false} style={hidden} />
      <Handle type="source" position={Position.Top} isConnectable={false} style={hidden} />
      <div><strong>{a.id}</strong> <em>{a.phase}</em></div>
      <div className="status">{a.status || "—"}</div>
      <div className="tok">{a.tokens.toLocaleString("en-US")} tok</div>
    </div>
  );
}

// A curve from the edge of the source box to the edge of the target box, bent to the left of the direction of travel,
// so the two directions of a pair run on opposite sides and each keeps its own arrowhead and label.
function DirectedEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, data }: EdgeProps<FlowEdge>) {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const reach = (Math.min(NODE_W / 2 / Math.max(Math.abs(ux), 1e-6), NODE_H / 2 / Math.max(Math.abs(uy), 1e-6))) + 4;
  const sx = sourceX + ux * reach;
  const sy = sourceY + uy * reach;
  const tx = targetX - ux * reach;
  const ty = targetY - uy * reach;
  const px = -uy;
  const py = ux;
  const cx = (sx + tx) / 2 + px * CURVE * 2;
  const cy = (sy + ty) / 2 + py * CURVE * 2;
  // The curve's midpoint is halfway between the chord and the control point.
  const lx = (sx + tx) / 2 + px * CURVE;
  const ly = (sy + ty) / 2 + py * CURVE;
  return (
    <>
      <BaseEdge id={id} path={`M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`} markerEnd={markerEnd} style={style} />
      <text x={lx} y={ly} className="edge-label" textAnchor="middle" dominantBaseline="middle">{data?.text}</text>
    </>
  );
}

const nodeTypes = { agent: AgentNodeView };
const edgeTypes = { directed: DirectedEdge };

export function TeamGraph({ s }: { s: ViewState }) {
  const rx = 240;
  const ry = 150;
  const nodes: AgentNode[] = s.agents.map((a, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, s.agents.length) - Math.PI / 2;
    return {
      id: a.id,
      type: "agent",
      position: { x: 270 + rx * Math.cos(angle) - NODE_W / 2, y: 180 + ry * Math.sin(angle) - NODE_H / 2 },
      data: { agent: a },
      draggable: false,
    };
  });
  const edges: FlowEdge[] = s.edges
    .filter((e) => e.from !== e.to)
    .map((e) => ({
      id: `${e.from}-${e.to}`,
      type: "directed",
      source: e.from,
      target: e.to,
      data: { text: `${e.from}→${e.to} ${e.count}` },
      animated: e.active,
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: e.active ? "#1f7a6b" : "#7a8590" },
      style: { strokeWidth: Math.min(5, 1 + e.count / 2), opacity: e.active ? 1 : 0.7, stroke: e.active ? "#1f7a6b" : "#7a8590" },
    }));
  return (
    <section className="panel graph" data-testid="team-graph" aria-label="Team graph">
      <h2>Team</h2>
      <div className="graph-canvas">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView nodesConnectable={false} proOptions={{ hideAttribution: true }} />
      </div>
    </section>
  );
}
