// instance-graph.jsx — Read-only Graph für Prozess-Instanz (ESM).
//
// Props:
//   version          — { schritte, schritt_io, payload_field_specs }
//   statusMap        — { [step_key]: { status, verantwortlich, faelligkeit_am, erledigt_am, kommentar } }
//   payload          — { [fieldname]: value }
//   selectedKey      — step_key | null
//   onSelectStep(k)
//   density          — "comfortable" | "compact"
//   piPosition       — { x, y }
//   piFields         — string[]    (fieldnames)
//   edgeMode         — "all" | "selected" | "unsatisfied"

import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { TASK_TYPES } from "./data.js";
import { STEP_STATUS, statusStyle, fmtPayloadValue, fmtDue } from "./instance-data.js";

const INODE_W = 248;
const INODE_W_COMPACT = 220;
const INODE_H = 110;

const PI_W = 220;
const PI_H_HEADER = 42;
const PI_ROW_H = 22;
const PI_BODY_VPAD = 16;

function getNodeW(density) {
  return density === "compact" ? INODE_W_COMPACT : INODE_W;
}

function getPiHeight(piFields) {
  return PI_H_HEADER + PI_BODY_VPAD + piFields.length * PI_ROW_H;
}

// ---- Visuals ---------------------------------------------------------------

function InstanceNode({ step, statusRec, onSelect, selected, density }) {
  const tt = TASK_TYPES[step.task_type] || { glyph: "?", label: step.task_type };
  const st = STEP_STATUS[statusRec.status] || STEP_STATUS.pending;
  const due = fmtDue(statusRec.faelligkeit_am);
  const dueClass =
    statusRec.faelligkeit_am && new Date(statusRec.faelligkeit_am) < new Date()
      ? "overdue"
      : due === "heute"
      ? "today"
      : "";

  const stStyle = statusStyle(statusRec.status);
  const w = getNodeW(density);

  return (
    <div
      className={`inode s-${statusRec.status}${selected ? " selected" : ""}${density === "compact" ? " compact" : ""}`}
      style={{ left: step.editor_x, top: step.editor_y, width: w, ...stStyle }}
      onClick={(e) => { e.stopPropagation(); onSelect(step.step_key); }}
    >
      <div className="st-rail"></div>
      <div className="inode-head">
        <div className="inode-glyph" title={st.label}>{st.glyph}</div>
        <div className="inode-title">
          <div className="ttl">{step.titel}</div>
          <div className="key">{step.step_key}</div>
        </div>
        <div className="inode-stat"><span>{st.label}</span></div>
      </div>
      <div className="inode-foot">
        <div className="avatar" title={statusRec.verantwortlich?.name}>
          {statusRec.verantwortlich?.initials || "?"}
        </div>
        <span className="who">{statusRec.verantwortlich?.name?.split(" ")[0] || "—"}</span>
        <span className="sep">·</span>
        <span className={`due ${dueClass}`}>
          {statusRec.status === "done"
            ? `erledigt ${fmtDue(statusRec.erledigt_am)}`
            : `fällig ${due}`}
        </span>
      </div>
    </div>
  );
}

function ProcessInputsBox({ piFields, payload, fieldSpecs, position }) {
  return (
    <div className="inode pi" style={{ left: position.x, top: position.y, width: PI_W }}>
      <div className="inode-head">
        <div className="pi-glyph">PI</div>
        <div className="inode-title">
          <div className="ttl">Process Inputs</div>
          <div className="key">extern · {piFields.length} Felder</div>
        </div>
      </div>
      <div className="pi-body">
        {piFields.map((fn) => {
          const spec = fieldSpecs.find((f) => f.fieldname === fn);
          const raw = payload[fn];
          const v = fmtPayloadValue(raw, spec);
          return (
            <div className="pi-row" key={fn}>
              <span className="fld" title={fn}>{fn}</span>
              <span className={`val${v == null ? " empty" : ""}`} title={String(v ?? "")}>
                {v == null ? "leer" : v}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Edges -----------------------------------------------------------------

function deriveInstanceEdges(version, statusMap, payload) {
  const stepByKey = Object.fromEntries(version.schritte.map((s) => [s.step_key, s]));
  const producer = {};
  for (const r of version.schritt_io) if (r.kind === "payload_output") producer[r.target] = r.step_key;

  const out = [];
  for (const r of version.schritt_io) {
    const dst = stepByKey[r.step_key];
    if (!dst) continue;
    if (r.kind === "payload_input") {
      const p = producer[r.target];
      const fulfilled = payload[r.target] != null && payload[r.target] !== "";
      if (p && stepByKey[p]) {
        out.push({
          id: `data:${p}:${r.step_key}:${r.target}`,
          src: p, dst: r.step_key,
          kind: fulfilled ? "consumed" : "dataflow",
          target: r.target,
        });
      } else {
        out.push({
          id: `pi:${r.target}:${r.step_key}`,
          src: "__pi__", dst: r.step_key,
          kind: fulfilled ? "consumed" : "dataflow",
          target: r.target,
        });
      }
    } else if (r.kind === "step_input") {
      if (stepByKey[r.target]) {
        out.push({
          id: `order:${r.target}:${r.step_key}`,
          src: r.target, dst: r.step_key,
          kind: "order", target: null,
        });
      }
    }
  }
  return out;
}

function bezierPath(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

function nodeEdgeAnchor(step, side, density) {
  const w = getNodeW(density);
  const x = side === "right" ? step.editor_x + w : step.editor_x;
  const y = step.editor_y + INODE_H / 2;
  return { x, y };
}

function piEdgeAnchor(piPos, fieldIndex) {
  const y = piPos.y + PI_H_HEADER + 12 + fieldIndex * PI_ROW_H;
  return { x: piPos.x + PI_W, y };
}

// ---- InstanceGraph ---------------------------------------------------------

export function InstanceGraph({
  version,
  statusMap,
  payload,
  selectedKey,
  onSelectStep,
  density,
  piPosition,
  piFields,
  edgeMode,
}) {
  const rootRef = useRef(null);
  const [view, setView] = useState({ tx: 60, ty: 40, scale: 0.85 });
  const [vp, setVp] = useState({ w: 1, h: 1 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);

  useEffect(() => {
    if (!rootRef.current) return;
    const ro = new ResizeObserver((es) => {
      const r = es[0].contentRect;
      setVp({ w: r.width, h: r.height });
    });
    ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, []);

  const didFit = useRef(false);
  const fitToScreen = useCallback(() => {
    if (!version.schritte.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of version.schritte) {
      minX = Math.min(minX, s.editor_x);
      minY = Math.min(minY, s.editor_y);
      maxX = Math.max(maxX, s.editor_x + getNodeW(density));
      maxY = Math.max(maxY, s.editor_y + INODE_H);
    }
    if (piFields.length > 0) {
      const piH = getPiHeight(piFields);
      minX = Math.min(minX, piPosition.x);
      minY = Math.min(minY, piPosition.y);
      maxX = Math.max(maxX, piPosition.x + PI_W);
      maxY = Math.max(maxY, piPosition.y + piH);
    }
    const pad = 60;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const sx = vp.w / (maxX - minX);
    const sy = vp.h / (maxY - minY);
    const scale = Math.min(1.0, sx, sy);
    setView({
      scale,
      tx: -minX * scale + (vp.w - (maxX - minX) * scale) / 2,
      ty: -minY * scale + (vp.h - (maxY - minY) * scale) / 2,
    });
  }, [version.schritte, vp, density, piFields, piPosition]);

  useEffect(() => {
    if (didFit.current) return;
    if (vp.w < 100) return;
    didFit.current = true;
    setTimeout(fitToScreen, 0);
  }, [vp.w, vp.h, fitToScreen]);

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest(".inode")) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty };
    setDragging(true);
  }
  useEffect(() => {
    if (!dragging) return;
    function onMove(e) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setView((v) => ({ ...v, tx: dragRef.current.tx + dx, ty: dragRef.current.ty + dy }));
    }
    function onUp() { setDragging(false); dragRef.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const ns = Math.max(0.25, Math.min(2.0, v.scale * factor));
      const ratio = ns / v.scale;
      return { scale: ns, tx: mx - (mx - v.tx) * ratio, ty: my - (my - v.ty) * ratio };
    });
  }

  const edges = useMemo(
    () => deriveInstanceEdges(version, statusMap, payload),
    [version, statusMap, payload]
  );

  const edgePaths = useMemo(() => {
    const out = [];
    const stepByKey = Object.fromEntries(version.schritte.map((s) => [s.step_key, s]));
    for (const e of edges) {
      const dstStep = stepByKey[e.dst];
      if (!dstStep) continue;
      const dstAnchor = nodeEdgeAnchor(dstStep, "left", density);
      let srcAnchor;
      if (e.src === "__pi__") {
        const idx = piFields.indexOf(e.target);
        srcAnchor = piEdgeAnchor(piPosition, idx);
      } else {
        const srcStep = stepByKey[e.src];
        if (!srcStep) continue;
        srcAnchor = nodeEdgeAnchor(srcStep, "right", density);
      }
      const dim = (() => {
        if (edgeMode === "selected" && selectedKey) return e.src !== selectedKey && e.dst !== selectedKey;
        if (edgeMode === "unsatisfied") return e.kind === "consumed" || e.kind === "order";
        return false;
      })();
      out.push({
        id: e.id,
        d: bezierPath(srcAnchor.x, srcAnchor.y, dstAnchor.x, dstAnchor.y),
        cls: e.kind,
        dim,
      });
    }
    return out;
  }, [edges, version.schritte, density, piPosition, piFields, selectedKey, edgeMode]);

  return (
    <div
      ref={rootRef}
      className={`gp${dragging ? " dragging" : ""}`}
      onMouseDown={onMouseDown}
      onWheel={onWheel}
    >
      <div
        className="gp-grid"
        style={{
          backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
          backgroundPosition: `${view.tx % (24 * view.scale)}px ${view.ty % (24 * view.scale)}px`,
        }}
      ></div>

      <div className="gp-pane-title">Graph · Status-Übersicht</div>

      <div
        className="gp-stage"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        <div className="gp-edge-layer">
          <svg>
            {edgePaths.map((p) => (
              <path key={p.id} className={`edge-line ${p.cls}${p.dim ? " dim" : ""}`} d={p.d} />
            ))}
          </svg>
        </div>

        {piFields.length > 0 && (
          <ProcessInputsBox
            piFields={piFields}
            payload={payload}
            fieldSpecs={version.payload_field_specs}
            position={piPosition}
          />
        )}

        {version.schritte.map((s) => {
          const rec = statusMap[s.step_key] || { status: "pending" };
          return (
            <InstanceNode
              key={s.step_key}
              step={s}
              statusRec={rec}
              selected={selectedKey === s.step_key}
              density={density}
              onSelect={onSelectStep}
            />
          );
        })}
      </div>

      <div className="gp-controls">
        <button title="Zoom out" onClick={() => setView((v) => ({ ...v, scale: Math.max(0.25, v.scale / 1.15) }))}>−</button>
        <span className="zoom-level">{Math.round(view.scale * 100)}%</span>
        <button title="Zoom in" onClick={() => setView((v) => ({ ...v, scale: Math.min(2.0, v.scale * 1.15) }))}>+</button>
        <button title="Fit to screen" onClick={fitToScreen}>⤢</button>
      </div>

      <div className="gp-legend">
        {["ready", "in_progress", "done", "pending", "blocked"].map((k) => (
          <span className="lg-item" key={k}>
            <span className="lg-chip" style={statusStyle(k)}></span>
            <span>{STEP_STATUS[k].label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
