// editor-node.jsx — Node component, port geometry, helpers
//
// ESM module — bundled by esbuild into process_editor_react.bundle.js.

import React from "react";
import { TASK_TYPES } from "./data.js";

export const NODE_W = 280;
export const NODE_W_COMPACT = 240;

// Task-Typen, deren Quell-Objekt per Verdrahtung kommt (Objekt-Input-Port statt Payload-Dropdown).
// Diese Knoten zeigen einen obj-in-Port, solange nichts ans Objekt verdrahtet ist.
export const OBJ_INPUT_TASK_TYPES = new Set(["fill_fields", "derive"]);
// HEADER_H accounts for: 1px node border-top + actual header content height (~53px).
// Measured against rendered DOM rather than computed from padding+content alone.
export const HEADER_H = 54;
export const ROW_H = 22;
export const COL_LABEL_H = 19;
export const COL_PAD_TOP = 8;
export const FOOTER_H = 30;

export function getNodeWidth(density) {
  return density === "compact" ? NODE_W_COMPACT : NODE_W;
}

// Erkennt {{ payload.X }} -> Quell-Feld X eines gemappten Ziel-Felds.
export const PAYLOAD_TPL_RE = /\{\{\s*payload\.([a-zA-Z0-9_]+)\s*\}\}/;

// Liest die Mapping-Inputs eines create_linked_doc-Schritts: pro Ziel-Feld (cfg.map_inputs)
// ein {target, source}, wobei source aus prefill_mapping[target] = "{{ payload.X }}" stammt
// (leer = noch nicht belegt).
export function getMapInputs(step) {
  if (!step || step.task_type !== "create_linked_doc") return [];
  let cfg = {};
  try { cfg = JSON.parse(step.konfig_json || "{}") || {}; } catch (_) { cfg = {}; }
  const prefill = (cfg.prefill_mapping && typeof cfg.prefill_mapping === "object") ? cfg.prefill_mapping : {};
  const targets = Array.isArray(cfg.map_inputs) ? cfg.map_inputs.slice() : [];
  // Backward-compat: bestehende {{ payload.X }}-Mappings ohne map_inputs trotzdem als Input zeigen.
  for (const [t, v] of Object.entries(prefill)) {
    if (PAYLOAD_TPL_RE.test(String(v)) && !targets.includes(t)) targets.push(t);
  }
  return targets.map((t) => {
    const m = String(prefill[t] || "").match(PAYLOAD_TPL_RE);
    return { target: t, source: m ? m[1] : "" };
  });
}

export function getNodePorts(stepKey, io, step) {
  const payloadIn = [];
  const payloadOut = [];
  const stepIn = [];
  for (const r of io) {
    if ((r.step_key || "") !== stepKey) continue;
    if (r.kind === "payload_input") payloadIn.push(r.target);
    else if (r.kind === "payload_output") payloadOut.push(r.target);
    else if (r.kind === "step_input") stepIn.push(r.target);
  }
  // create_linked_doc: die Inputs sind die gemappten Ziel-Felder (map_inputs), nicht die
  // generischen payload_input-Ports — die Quelle steht in der Ziel-Zeile (min:<target>).
  const mapIn = getMapInputs(step);
  if (mapIn.length || (step && step.task_type === "create_linked_doc")) {
    return { payloadIn: [], payloadOut, stepIn, mapIn };
  }
  return { payloadIn, payloadOut, stepIn, mapIn: [] };
}

export function getNodeHeight(ports) {
  const inCount = ports.payloadIn.length + (ports.mapIn ? ports.mapIn.length : 0);
  const rows = Math.max(1, inCount, ports.payloadOut.length);
  const bodyH = COL_PAD_TOP + COL_LABEL_H + rows * ROW_H + 10;
  return HEADER_H + bodyH + FOOTER_H;
}

// Returns {x, y} in node-local coordinates (top-left = 0,0) for the dot center.
export function getPortPos(portId, ports, density) {
  const w = getNodeWidth(density);
  if (portId === "step-in")  return { x: 0, y: HEADER_H / 2, side: "left",  kind: "step" };
  if (portId === "step-out") return { x: w, y: HEADER_H / 2, side: "right", kind: "step" };
  // Objekt-Input-Port (fill_fields/derive): liegt auf derselben Hoehe wie die erste Input-Zeile,
  // damit Dot, Kante und Vorschau exakt mit der Inputs-Spalte fluchten.
  if (portId === "obj-in")   return { x: 0, y: HEADER_H + COL_PAD_TOP + COL_LABEL_H + ROW_H / 2, side: "left", kind: "obj" };
  // Mapping-Input (create_linked_doc): eine Zeile pro gemapptem Ziel-Feld, linke Spalte.
  if (portId.startsWith("min:")) {
    const t = portId.slice(4);
    const idx = (ports.mapIn || []).findIndex((m) => m.target === t);
    const y = HEADER_H + COL_PAD_TOP + COL_LABEL_H + (Math.max(0, idx) * ROW_H) + ROW_H / 2;
    return { x: 0, y, side: "left", kind: "map", target: t };
  }
  const sep = portId.indexOf(":");
  const side = portId.slice(0, sep);
  const field = portId.slice(sep + 1);
  if (side === "in") {
    const idx = ports.payloadIn.indexOf(field);
    const y = HEADER_H + COL_PAD_TOP + COL_LABEL_H + (Math.max(0, idx) * ROW_H) + ROW_H / 2;
    return { x: 0, y, side: "left", kind: "payload", field };
  }
  if (side === "out") {
    const idx = ports.payloadOut.indexOf(field);
    const y = HEADER_H + COL_PAD_TOP + COL_LABEL_H + (Math.max(0, idx) * ROW_H) + ROW_H / 2;
    return { x: w, y, side: "right", kind: "payload", field };
  }
  return { x: 0, y: 0, side: "left", kind: "unknown" };
}

export function ttStyle(taskType) {
  const tt = TASK_TYPES[taskType];
  if (!tt) return {};
  const hue = tt.hue;
  const c = tt.chroma;
  return {
    "--tt-fg":     `oklch(38% ${c * 0.9} ${hue})`,
    "--tt-soft":   `oklch(95% ${Math.min(c * 0.25, 0.05)} ${hue})`,
    "--tt-border": `oklch(82% ${Math.min(c * 0.4, 0.08)} ${hue})`,
    "--tt-strong": `oklch(58% ${c} ${hue})`,
  };
}

export function portColor(field) {
  // Stable hash from fieldname → hue, so the same field always renders with the same color.
  if (!field) return "oklch(60% 0.012 60)";
  let h = 0;
  for (let i = 0; i < field.length; i++) h = (h * 31 + field.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `oklch(58% 0.13 ${hue})`;
}

export function Node({
  node,
  ports,
  density,
  selected,
  dimmed,
  searchHit,
  dragging,
  readOnly,
  onMouseDownHeader,
  onSelect,
  onPortMouseDown,
  onPortMouseUp,
  onPortMouseEnter,
  hotPort,
  validTarget,
}) {
  const tt = TASK_TYPES[node.task_type] || { label: node.task_type, glyph: "?", hue: 0, chroma: 0 };
  const w = getNodeWidth(density);
  const style = {
    ...ttStyle(node.task_type),
    left: node.editor_x,
    top: node.editor_y,
    width: w,
  };

  const cls = [
    "node",
    density === "compact" ? "compact" : "",
    selected ? "selected" : "",
    dimmed ? "dimmed" : "",
    searchHit ? "search-hit" : "",
    dragging ? "dragging" : "",
  ].filter(Boolean).join(" ");

  // Objekt-Input: Knoten, deren Quelle per Verdrahtung kommt (fill_fields, derive), zeigen
  // — solange nichts verdrahtet ist — eine echte Input-Zeile "← Objekt: <Doctype>" statt
  // "no inputs". So fluchtet der Port mit der Inputs-Spalte und ist als ganze Zeile droppbar.
  const objInActive = OBJ_INPUT_TASK_TYPES.has(node.task_type) && ports.payloadIn.length === 0;
  let objDt = "";
  if (objInActive) { try { objDt = JSON.parse(node.konfig_json || "{}").input_doctype || ""; } catch (_) { objDt = ""; } }
  const objHot = hotPort && hotPort.node === node.step_key && hotPort.port === "obj-in";

  const renderPayloadCol = (side) => {
    const list = side === "left" ? ports.payloadIn : ports.payloadOut;
    const label = side === "left" ? "Inputs" : "Outputs";
    const portSide = side === "left" ? "left" : "right";
    const portKind = side === "left" ? "in" : "out";

    return (
      <div className="col">
        <div className="col-label">{label}</div>
        {side === "left" && objInActive && (
          <div
            className={`port left obj-in${objHot ? " hot" : ""}`}
            title={`Objekt-Input — ziehe ein Payload-Link-Feld${objDt ? " (" + objDt + ")" : ""} hierher`}
            onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp && onPortMouseUp(e, node.step_key, "obj-in"); }}
          >
            <span
              className={`dot${objHot ? " hot" : ""}${validTarget === "valid" ? " valid-target" : ""}`}
              style={{ "--port-color": "var(--accent, #6366f1)", borderStyle: "dashed" }}
              onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown && onPortMouseDown(e, node.step_key, "obj-in"); }}
              onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp && onPortMouseUp(e, node.step_key, "obj-in"); }}
            />
            <span className="port-name">← Objekt{objDt ? ": " + objDt : ""}</span>
          </div>
        )}
        {/* create_linked_doc: ein Input-Port pro gemapptem Ziel-Feld; Quelle per Drag belegen. */}
        {side === "left" && (ports.mapIn || []).map((m) => {
          const portId = `min:${m.target}`;
          const isHot = hotPort && hotPort.node === node.step_key && hotPort.port === portId;
          const bound = !!m.source;
          return (
            <div
              className={`port left map-in${isHot ? " hot" : ""}${bound ? "" : " unbound"}`}
              key={portId}
              title={bound ? `${m.target} ← payload.${m.source}` : `${m.target} — Quelle hierher ziehen`}
              onMouseEnter={() => onPortMouseEnter && onPortMouseEnter(node.step_key, portId)}
              onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp && onPortMouseUp(e, node.step_key, portId); }}
            >
              <span
                className={`dot${isHot ? " hot" : ""}${bound ? " connected" : ""}${validTarget === "valid" ? " valid-target" : ""}`}
                style={{ "--port-color": bound ? "var(--accent, #6366f1)" : "var(--ink-4)", ...(bound ? {} : { borderStyle: "dashed" }) }}
                onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown && onPortMouseDown(e, node.step_key, portId); }}
                onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp && onPortMouseUp(e, node.step_key, portId); }}
              />
              <span className="port-name">{m.target} <span className="map-src">{bound ? "← " + m.source : "← ziehen"}</span></span>
            </div>
          );
        })}
        {list.length === 0 && !(side === "left" && objInActive) && !(side === "left" && (ports.mapIn || []).length) && (
          <div className="port empty">
            {side === "left" ? "no inputs" : "no outputs"}
          </div>
        )}
        {list.map((field) => {
          const portId = `${portKind}:${field}`;
          const color = portColor(field);
          const isHot = hotPort && hotPort.node === node.step_key && hotPort.port === portId;
          return (
            <div className={`port ${portSide}`} key={portId} title={field}>
              <span
                className={`dot${isHot ? " hot" : ""}${validTarget === "valid" ? " valid-target" : ""}${validTarget === "invalid" ? " invalid-target" : ""}`}
                style={{ "--port-color": color }}
                onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown && onPortMouseDown(e, node.step_key, portId); }}
                onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp && onPortMouseUp(e, node.step_key, portId); }}
              />
              <span className="port-name">{field}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div
      className={cls}
      style={style}
      onMouseDown={(e) => { e.stopPropagation(); onSelect && onSelect(node.step_key); }}
    >
      <span className="port-anchor step-in-anchor" style={{ position: "absolute", left: 0, top: HEADER_H / 2 }}>
        <span
          className={`dot${hotPort && hotPort.node === node.step_key && hotPort.port === "step-in" ? " hot" : ""}${validTarget === "valid" ? " valid-target" : ""}`}
          style={{
            position: "absolute", left: -7, top: -7, width: 14, height: 14,
            borderRadius: "50%", background: "var(--surface)",
            border: "2px dashed var(--ink-3)", cursor: "crosshair", zIndex: 3,
          }}
          title="Predecessor (step_input)"
          onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown && onPortMouseDown(e, node.step_key, "step-in"); }}
          onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp && onPortMouseUp(e, node.step_key, "step-in"); }}
        />
      </span>
      <span className="port-anchor step-out-anchor" style={{ position: "absolute", right: 0, top: HEADER_H / 2 }}>
        <span
          className={`dot${hotPort && hotPort.node === node.step_key && hotPort.port === "step-out" ? " hot" : ""}${validTarget === "valid" ? " valid-target" : ""}`}
          style={{
            position: "absolute", right: -7, top: -7, width: 14, height: 14,
            borderRadius: "50%", background: "var(--surface)",
            border: "2px dashed var(--ink-3)", cursor: "crosshair", zIndex: 3,
          }}
          title="Successor (step_output)"
          onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown && onPortMouseDown(e, node.step_key, "step-out"); }}
          onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp && onPortMouseUp(e, node.step_key, "step-out"); }}
        />
      </span>

      <div
        className="node-header"
        onMouseDown={(e) => { if (readOnly) return; e.stopPropagation(); onMouseDownHeader && onMouseDownHeader(e, node.step_key); }}
      >
        <span className="node-glyph">{tt.glyph}</span>
        <div className="node-title">
          <span className="ttl">{node.titel || node.step_key}</span>
          <span className="key">{node.step_key}</span>
        </div>
        <span className="node-tt-chip">{tt.label}</span>
      </div>

      <div className="node-ports">
        {renderPayloadCol("left")}
        {renderPayloadCol("right")}
      </div>

      <div className="node-footer">
        {node.pflicht ? <span className="badge pflicht">Pflicht</span> : <span className="badge">Optional</span>}
        {node.sichtbar_fuer_prozess_typ && node.sichtbar_fuer_prozess_typ !== "Beide" && (
          <span className="badge">{node.sichtbar_fuer_prozess_typ}</span>
        )}
        {node.handler_key && <span className="badge handler">{node.handler_key}</span>}
        {node.print_format && <span className="badge print">{node.print_format}</span>}
      </div>
    </div>
  );
}

// Process-Inputs pseudo-node — mirrors __process_inputs__ in process_editor.js.
export const PROCESS_INPUTS_NODE = "__process_inputs__";
export const PI_W = 220;

export function getProcessInputFields(io, fieldSpecs) {
  const producers = new Set();
  for (const r of io) if (r.kind === "payload_output" && r.target) producers.add(r.target);
  const consumedOrDeclared = new Set();
  for (const f of fieldSpecs || []) if (f.fieldname) consumedOrDeclared.add(f.fieldname);
  for (const r of io) if (r.kind === "payload_input" && r.target) consumedOrDeclared.add(r.target);
  return [...consumedOrDeclared].filter((f) => f && !producers.has(f)).sort();
}

export function getPIHeight(piFields) {
  return HEADER_H + COL_LABEL_H + Math.max(1, piFields.length) * ROW_H + 16;
}

export function getPIPortPos(field, piFields) {
  const idx = piFields.indexOf(field);
  const y = HEADER_H + COL_PAD_TOP + COL_LABEL_H + (Math.max(0, idx) * ROW_H) + ROW_H / 2;
  return { x: PI_W, y, side: "right", kind: "process_input", field };
}

export function getPITriggerPos() {
  return { x: PI_W, y: HEADER_H / 2, side: "right" };
}

export function getRootStepKeys(schritte, io) {
  const hasIncoming = new Set();
  for (const r of io) {
    if (r.kind === "payload_input" || r.kind === "step_input") {
      hasIncoming.add(r.step_key);
    }
  }
  return schritte.map((s) => s.step_key).filter((k) => k && !hasIncoming.has(k));
}

export function ProcessInputsNode({
  position,
  piFields,
  io,
  selected,
  dragging,
  readOnly,
  onSelect,
  onMouseDownHeader,
  onPortMouseDown,
  onPortMouseUp,
  onAddInput,
  onDeleteInput,
  onEditInput,
  hotPort,
  validTarget,
}) {
  const consumed = new Set();
  for (const r of io) if (r.kind === "payload_input" && r.target) consumed.add(r.target);
  const triggerHot = hotPort && hotPort.node === PROCESS_INPUTS_NODE && hotPort.port === "trigger-out";

  return (
    <div
      className={`node pi-node${selected ? " selected" : ""}${dragging ? " dragging" : ""}`}
      style={{ left: position.x, top: position.y, width: PI_W }}
      onMouseDown={(e) => { e.stopPropagation(); onSelect && onSelect(PROCESS_INPUTS_NODE); }}
    >
      <div
        className="node-header pi-header"
        onMouseDown={(e) => { e.stopPropagation(); onMouseDownHeader && onMouseDownHeader(e, PROCESS_INPUTS_NODE); }}
      >
        <span className="pi-glyph">▶</span>
        <div className="node-title">
          <span className="ttl">Start</span>
          <span className="key">__process_inputs__</span>
        </div>
        <span
          className={`pi-trigger-dot${triggerHot ? " hot" : ""}`}
          title="Trigger — ziehe auf einen Schritt, um ihn als Start-Schritt zu markieren"
          onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown && onPortMouseDown(e, PROCESS_INPUTS_NODE, "trigger-out"); }}
          onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp && onPortMouseUp(e, PROCESS_INPUTS_NODE, "trigger-out"); }}
        />
      </div>

      <div className="node-ports pi-ports">
        <div className="col pi-col">
          <div className="col-label">Externe Felder</div>
          {piFields.length === 0 && (
            <div className="port empty">keine Process Inputs</div>
          )}
          {piFields.map((field) => {
            const portId = `out:${field}`;
            const color = portColor(field);
            const isHot = hotPort && hotPort.node === PROCESS_INPUTS_NODE && hotPort.port === portId;
            const unused = !consumed.has(field);
            return (
              <div
                className={`port right${unused ? " unwired" : ""}`}
                key={portId}
                title={unused ? `${field} — declared, aber nicht gelesen` : field}
              >
                {!readOnly && (
                  <button
                    className="pi-field-del"
                    title="Input entfernen"
                    style={{ border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "0 4px 0 0" }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onDeleteInput && onDeleteInput(field); }}
                  >×</button>
                )}
                <span
                  className="port-name"
                  style={!readOnly ? { cursor: "pointer" } : undefined}
                  title={!readOnly ? "Typ/Label bearbeiten" : undefined}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { if (!readOnly && onEditInput) { e.stopPropagation(); onEditInput(field); } }}
                >{field}</span>
                <span
                  className={`dot${isHot ? " hot" : ""}${validTarget === "valid" ? " valid-target" : ""}${unused ? " unwired" : ""}`}
                  style={{ "--port-color": unused ? "var(--ink-4)" : color }}
                  onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown && onPortMouseDown(e, PROCESS_INPUTS_NODE, portId); }}
                  onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp && onPortMouseUp(e, PROCESS_INPUTS_NODE, portId); }}
                />
              </div>
            );
          })}
          {!readOnly && (
            <button
              className="pi-add-input"
              style={{ marginTop: 6, width: "100%", height: 24, border: "1px dashed var(--border-strong)", borderRadius: 5, background: "transparent", color: "var(--ink-2)", fontFamily: "inherit", fontSize: 11.5, fontWeight: 500, cursor: "pointer" }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onAddInput && onAddInput(); }}
            >+ Input</button>
          )}
        </div>
      </div>
    </div>
  );
}
