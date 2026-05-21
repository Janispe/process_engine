// editor-edges.jsx — Edge derivation, path math, EdgesLayer, MiniMap

import React from "react";
import { TASK_TYPES } from "./data.js";
import {
  PROCESS_INPUTS_NODE,
  getNodePorts,
  getNodeWidth,
  getNodeHeight,
  getPortPos,
  getPIPortPos,
  getPITriggerPos,
  getRootStepKeys,
} from "./editor-node.jsx";

export function deriveEdges(schritte, io, piFields) {
  const byKey = {};
  for (const s of schritte) byKey[s.step_key] = s;
  const producer = {};
  for (const r of io) {
    if (r.kind === "payload_output") producer[r.target] = r.step_key;
  }
  const piFieldSet = new Set(piFields || []);
  const edges = [];
  for (const r of io) {
    if (r.kind === "payload_input") {
      const prod = producer[r.target];
      if (prod && prod !== r.step_key && byKey[prod] && byKey[r.step_key]) {
        edges.push({
          id: `payload:${prod}:${r.step_key}:${r.target}`,
          kind: "payload",
          src: { node: prod, port: `out:${r.target}` },
          dst: { node: r.step_key, port: `in:${r.target}` },
          field: r.target,
        });
      } else if (!prod && piFieldSet.has(r.target) && byKey[r.step_key]) {
        edges.push({
          id: `pi:${r.target}:${r.step_key}`,
          kind: "process_input",
          src: { node: PROCESS_INPUTS_NODE, port: `out:${r.target}` },
          dst: { node: r.step_key, port: `in:${r.target}` },
          field: r.target,
        });
      }
    } else if (r.kind === "step_input") {
      if (r.target && r.target !== r.step_key && byKey[r.target] && byKey[r.step_key]) {
        edges.push({
          id: `step:${r.target}:${r.step_key}`,
          kind: "step",
          src: { node: r.target, port: "step-out" },
          dst: { node: r.step_key, port: "step-in" },
        });
      }
    }
  }
  // Trigger edges: every root step (no incoming connection of any kind) gets a
  // visual trigger line from the Start node.
  for (const sk of getRootStepKeys(schritte, io)) {
    edges.push({
      id: `trigger:${sk}`,
      kind: "trigger",
      src: { node: PROCESS_INPUTS_NODE, port: "trigger-out" },
      dst: { node: sk, port: "step-in" },
    });
  }
  return edges;
}

export function makeEdgePath(p1, p2, style) {
  const dx = p2.x - p1.x;
  if (style === "orthogonal") {
    const mx = p1.x + Math.max(40, dx / 2);
    return `M ${p1.x},${p1.y} L ${mx},${p1.y} L ${mx},${p2.y} L ${p2.x},${p2.y}`;
  }
  if (style === "straight") {
    return `M ${p1.x},${p1.y} L ${p2.x},${p2.y}`;
  }
  const offset = Math.max(60, Math.abs(dx) * 0.55);
  const c1x = p1.x + (p1.side === "right" ? offset : -offset);
  const c1y = p1.y;
  const c2x = p2.x + (p2.side === "left" ? -offset : offset);
  const c2y = p2.y;
  return `M ${p1.x},${p1.y} C ${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
}

export const EDGE_LAYER_OFFSET = 8000;

export function EdgesLayer({
  schritte,
  io,
  hovered,
  selectedEdgeId,
  density,
  edgeStyle,
  showLabels,
  onEdgeClick,
  onEdgeMouseEnter,
  onEdgeMouseLeave,
  onDeleteEdge,
  hiddenEdgeId,
  piFields,
  piPosition,
}) {
  const edges = React.useMemo(() => deriveEdges(schritte, io, piFields), [schritte, io, piFields]);
  const nodeByKey = React.useMemo(() => {
    const m = {};
    for (const s of schritte) m[s.step_key] = s;
    return m;
  }, [schritte]);
  const portsByKey = React.useMemo(() => {
    const m = {};
    for (const s of schritte) m[s.step_key] = getNodePorts(s.step_key, io);
    return m;
  }, [schritte, io]);

  function endpoint(side) {
    if (side.node === PROCESS_INPUTS_NODE) {
      if (side.port === "trigger-out") {
        const p = getPITriggerPos();
        return {
          x: (piPosition?.x || 0) + p.x + EDGE_LAYER_OFFSET,
          y: (piPosition?.y || 0) + p.y + EDGE_LAYER_OFFSET,
          side: p.side,
        };
      }
      const sep = side.port.indexOf(":");
      const field = side.port.slice(sep + 1);
      const p = getPIPortPos(field, piFields || []);
      return {
        x: (piPosition?.x || 0) + p.x + EDGE_LAYER_OFFSET,
        y: (piPosition?.y || 0) + p.y + EDGE_LAYER_OFFSET,
        side: p.side,
      };
    }
    const n = nodeByKey[side.node];
    if (!n) return null;
    const p = getPortPos(side.port, portsByKey[side.node], density);
    return {
      x: n.editor_x + p.x + EDGE_LAYER_OFFSET,
      y: n.editor_y + p.y + EDGE_LAYER_OFFSET,
      side: p.side,
    };
  }

  return (
    <div className="edge-layer">
      <svg>
        <defs>
          <marker id="arrow-payload" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0,0 L 10,5 L 0,10 z" fill="var(--accent)" />
          </marker>
          <marker id="arrow-step" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0,0 L 10,5 L 0,10 z" fill="var(--ink-3)" />
          </marker>
          <marker id="arrow-payload-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0,0 L 10,5 L 0,10 z" fill="var(--warn)" />
          </marker>
        </defs>
        {edges.map((e) => {
          if (e.id === hiddenEdgeId) return null;
          const p1 = endpoint(e.src);
          const p2 = endpoint(e.dst);
          if (!p1 || !p2) return null;
          const d = makeEdgePath(p1, p2, edgeStyle);
          const isStep = e.kind === "step";
          const isTrigger = e.kind === "trigger";
          const hi = e.id === hovered || e.id === selectedEdgeId;
          let stroke;
          if (isTrigger) stroke = hi ? "var(--warn)" : "var(--ink-3)";
          else if (isStep) stroke = "var(--ink-3)";
          else stroke = hi ? "var(--warn)" : "var(--accent)";
          const sw = hi ? 2.2 : (isTrigger ? 1.2 : 1.6);
          const dasharray = isTrigger ? "3 4" : (isStep ? "5 5" : "");
          const marker = isStep || isTrigger
            ? "url(#arrow-step)"
            : (hi ? "url(#arrow-payload-hi)" : "url(#arrow-payload)");
          const midX = (p1.x + p2.x) / 2;
          const midY = (p1.y + p2.y) / 2;
          return (
            <g key={e.id} style={{ pointerEvents: "auto" }}
               onMouseEnter={() => onEdgeMouseEnter && onEdgeMouseEnter(e.id)}
               onMouseLeave={() => onEdgeMouseLeave && onEdgeMouseLeave(e.id)}
               onClick={(ev) => { ev.stopPropagation(); onEdgeClick && onEdgeClick(e.id); }}>
              <path d={d} stroke="transparent" strokeWidth="18" fill="none" style={{ cursor: "pointer" }} />
              <path
                d={d}
                stroke={stroke}
                strokeWidth={sw}
                fill="none"
                strokeDasharray={dasharray}
                markerEnd={marker}
                style={{ transition: "stroke .12s, stroke-width .12s" }}
              />
              {showLabels && (e.kind === "payload" || e.kind === "process_input") && (
                <g style={{ pointerEvents: "none" }}>
                  <rect
                    x={midX - (e.field.length * 3.4 + 8)}
                    y={midY - 9}
                    width={e.field.length * 6.8 + 16}
                    height={18}
                    rx="4"
                    fill="var(--surface)"
                    stroke={hi ? "var(--warn)" : "var(--border)"}
                  />
                  <text
                    x={midX}
                    y={midY + 4}
                    fontSize="10.5"
                    textAnchor="middle"
                    fill={hi ? "var(--warn)" : "var(--ink-2)"}
                    fontFamily="JetBrains Mono, monospace"
                  >{e.field}</text>
                </g>
              )}
              {hi && !isTrigger && (
                <g style={{ pointerEvents: "auto", cursor: "pointer" }}
                   onClick={(ev) => { ev.stopPropagation(); onDeleteEdge && onDeleteEdge(e.id); }}>
                  <circle cx={midX} cy={midY - 14} r="9" fill="var(--surface)" stroke="var(--danger)" strokeWidth="1.2" />
                  <path d={`M ${midX - 3.2},${midY - 17.2} L ${midX + 3.2},${midY - 10.8} M ${midX + 3.2},${midY - 17.2} L ${midX - 3.2},${midY - 10.8}`} stroke="var(--danger)" strokeWidth="1.6" />
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function PreviewEdge({ from, to, edgeStyle, valid }) {
  if (!from || !to) return null;
  const p1 = { x: from.x + EDGE_LAYER_OFFSET, y: from.y + EDGE_LAYER_OFFSET, side: from.side };
  const p2 = { x: to.x + EDGE_LAYER_OFFSET,   y: to.y + EDGE_LAYER_OFFSET,   side: to.side };
  const d = makeEdgePath(p1, p2, edgeStyle);
  const color = valid === false ? "var(--danger)" : "var(--accent)";
  return (
    <div className="edge-layer">
      <svg>
        <path d={d} stroke={color} strokeWidth="1.8" fill="none" strokeDasharray="4 4" opacity="0.85" />
      </svg>
    </div>
  );
}

export function MiniMap({ schritte, io, viewport, density, onNavigate }) {
  const w = 200, h = 130;
  if (!schritte.length) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const sizes = {};
  for (const s of schritte) {
    const ports = getNodePorts(s.step_key, io);
    const ww = getNodeWidth(density);
    const hh = getNodeHeight(ports);
    sizes[s.step_key] = { w: ww, h: hh };
    minX = Math.min(minX, s.editor_x);
    minY = Math.min(minY, s.editor_y);
    maxX = Math.max(maxX, s.editor_x + ww);
    maxY = Math.max(maxY, s.editor_y + hh);
  }
  const pad = 80;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const worldW = maxX - minX;
  const worldH = maxY - minY;
  const sx = (w - 12) / worldW;
  const sy = (h - 12) / worldH;
  const s = Math.min(sx, sy);
  const offX = (w - worldW * s) / 2;
  const offY = (h - worldH * s) / 2;

  const vpX = (viewport.x1 - minX) * s + offX;
  const vpY = (viewport.y1 - minY) * s + offY;
  const vpW = (viewport.x2 - viewport.x1) * s;
  const vpH = (viewport.y2 - viewport.y1) * s;

  return (
    <div className="minimap" onClick={(e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const wx = (cx - offX) / s + minX;
      const wy = (cy - offY) / s + minY;
      onNavigate && onNavigate(wx, wy);
    }}>
      <div className="mm-label">Overview</div>
      <svg className="mm-canvas" viewBox={`0 0 ${w} ${h}`}>
        {schritte.map((n) => {
          const sz = sizes[n.step_key];
          const tt = TASK_TYPES[n.task_type] || { hue: 0, chroma: 0 };
          return (
            <rect
              key={n.step_key}
              x={(n.editor_x - minX) * s + offX}
              y={(n.editor_y - minY) * s + offY}
              width={Math.max(3, sz.w * s)}
              height={Math.max(2, sz.h * s)}
              rx="1.5"
              fill={`oklch(74% ${tt.chroma * 0.6} ${tt.hue})`}
              stroke={`oklch(50% ${tt.chroma} ${tt.hue})`}
              strokeWidth="0.5"
              opacity="0.85"
            />
          );
        })}
      </svg>
      <div
        className="mm-viewport"
        style={{
          left: Math.max(0, vpX),
          top: Math.max(0, vpY),
          width: Math.min(w, vpW),
          height: Math.min(h, vpH),
        }}
      />
    </div>
  );
}
