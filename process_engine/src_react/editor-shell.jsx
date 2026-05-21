// editor-shell.jsx — Top-level App, Toolbar, Inspector, AddStepDialog
//
// ESM module. App takes data as props and emits mutations via callbacks;
// the consumer (prozess_version.js) bridges those into frappe.model.

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { TASK_TYPES, TASK_TYPE_KEYS } from "./data.js";
import {
  Node,
  ProcessInputsNode,
  PROCESS_INPUTS_NODE,
  PI_W,
  getNodePorts,
  getNodeHeight,
  getNodeWidth,
  getPortPos,
  getPIPortPos,
  getPITriggerPos,
  getProcessInputFields,
  getPIHeight,
  ttStyle,
} from "./editor-node.jsx";
import { EdgesLayer, PreviewEdge, MiniMap, deriveEdges } from "./editor-edges.jsx";
import {
  KonfigEditor,
  FieldsPanel,
  RawJsonDialog,
  OutputDeclareDialog,
  AddFieldDialog,
  DocFieldMappingDialog,
  Legend,
  PAYLOAD_RE,
} from "./editor-panels.jsx";

// ========== Validation (mirrors prozess_version.py / .js) ==========

export function validateGraph(schritte, io) {
  const errors = [];
  const stepKeys = new Set(schritte.map((s) => s.step_key));
  const producer = {};
  for (const r of io) if (r.kind === "payload_output") producer[r.target] = r.step_key;

  const deps = {};
  for (const sk of stepKeys) deps[sk] = new Set();
  for (const r of io) {
    if (!stepKeys.has(r.step_key)) continue;
    if (r.kind === "step_input") {
      if (r.step_key === r.target) errors.push(`${r.step_key} hängt von sich selbst ab`);
      if (r.target && stepKeys.has(r.target)) deps[r.step_key].add(r.target);
    } else if (r.kind === "payload_input") {
      const p = producer[r.target];
      if (p && p === r.step_key) errors.push(`${r.step_key} liest eigenen output '${r.target}'`);
      if (p && p !== r.step_key && stepKeys.has(p)) deps[r.step_key].add(p);
    }
  }
  // Cycle detection
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  for (const sk of stepKeys) color[sk] = WHITE;
  let cycle = null;
  function dfs(n, path) {
    if (color[n] === GRAY) {
      cycle = path.slice(path.indexOf(n)).concat(n);
      return true;
    }
    if (color[n] === BLACK) return false;
    color[n] = GRAY;
    for (const x of deps[n] || []) {
      if (dfs(x, path.concat(n))) return true;
    }
    color[n] = BLACK;
    return false;
  }
  for (const sk of stepKeys) {
    if (color[sk] === WHITE && dfs(sk, [])) {
      errors.push(`Zyklus: ${cycle.join(" → ")}`);
      break;
    }
  }
  return errors;
}

// ========== Toolbar ==========

function Toolbar({
  versionLabel,
  versionKey,
  isActive,
  isLocked,
  search, setSearch,
  validationErrors,
  panelMode,
  onAddStep,
  onAutoLayout,
  onFitToScreen,
  onToggleFieldsPanel,
}) {
  const ok = validationErrors.length === 0;
  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-mark"></span>
        <span className="brand-name">Process Engine <small>· Visual Editor</small></span>
      </div>

      <div className={`version-pill ${isActive ? "active" : ""}`} title="Prozess Version">
        <span className="dot"></span>
        <span>{versionLabel}</span>
        {versionKey && <span className="vk">{versionKey}</span>}
      </div>

      {isLocked && (
        <div className="lock-banner">
          <span className="glyph">⚿</span>
          <span>Aktiv — schreibgeschützt</span>
        </div>
      )}

      <div className="spacer"></div>

      <div className={`validation-badge ${ok ? "ok" : "err"}`} title={ok ? "Graph ist valide" : validationErrors.join(", ")}>
        <span className="led"></span>
        {ok ? "DAG ok" : `${validationErrors.length} Fehler`}
      </div>

      <div className="search">
        <span className="ico"></span>
        <input type="text" placeholder="Schritt suchen…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <button className="icon-btn" title="Auto-Layout" onClick={onAutoLayout}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1.5" y="2" width="4" height="3" rx="0.5" />
          <rect x="1.5" y="7" width="4" height="3" rx="0.5" />
          <rect x="1.5" y="12" width="4" height="2.5" rx="0.5" />
          <rect x="10.5" y="4.5" width="4" height="3" rx="0.5" />
          <rect x="10.5" y="9.5" width="4" height="3" rx="0.5" />
          <path d="M 5.5,3.5 L 10.5,6 M 5.5,8.5 L 10.5,6 M 5.5,8.5 L 10.5,11 M 5.5,13 L 10.5,11" />
        </svg>
      </button>
      <button className="icon-btn" title="Fit to screen" onClick={onFitToScreen}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M 1,5 V 1 H 5 M 11,1 H 15 V 5 M 15,11 V 15 H 11 M 5,15 H 1 V 11" strokeLinecap="round" />
        </svg>
      </button>

      <button
        className="tb-btn ghost"
        style={panelMode === "fields" ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" } : {}}
        onClick={onToggleFieldsPanel}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="12" height="2.5" rx="0.5" />
          <rect x="2" y="6.75" width="12" height="2.5" rx="0.5" />
          <rect x="2" y="10.5" width="12" height="2.5" rx="0.5" />
        </svg>
        Felder
      </button>

      <button className="tb-btn primary" onClick={onAddStep} disabled={isLocked}>
        <span className="plus"></span>
        Schritt hinzufügen
      </button>
    </div>
  );
}

// ========== Inspector ==========

function Inspector({
  open, step, io, fieldSpecs, readOnly,
  frm,
  fetchSchema,
  onClose, onPatchStep, onDeleteStep, onDeleteIO,
  onOpenOutputDialog, onOpenRawJson, onOpenMapping,
}) {
  if (!step) return <aside className="inspector closed" />;
  const tt = TASK_TYPES[step.task_type] || { glyph: "?", label: step.task_type };
  const myIO = io.filter((r) => r.step_key === step.step_key);

  return (
    <aside className={`inspector${open ? "" : " closed"}`} style={ttStyle(step.task_type)}>
      <div className="insp-header">
        <span className="insp-glyph">{tt.glyph}</span>
        <div className="insp-title">
          <h2>{step.titel || step.step_key}</h2>
          <div className="sub">{step.step_key} · {tt.label}</div>
        </div>
        <button className="close-x" onClick={onClose} title="Schließen">×</button>
      </div>
      <div className="insp-body">
        <div className="insp-section">
          <div className="insp-section-h">Schritt</div>
          <div className="insp-field">
            <label>Titel</label>
            <input type="text" value={step.titel || ""} disabled={readOnly}
                   onChange={(e) => onPatchStep({ titel: e.target.value })} />
          </div>
          <div className="insp-row">
            <div className="insp-field">
              <label>Step Key</label>
              <input className="mono" type="text" value={step.step_key} disabled />
            </div>
            <div className="insp-field">
              <label>Reihenfolge</label>
              <input type="number" value={step.reihenfolge || 0} disabled={readOnly}
                     onChange={(e) => onPatchStep({ reihenfolge: parseInt(e.target.value, 10) || 0 })} />
            </div>
          </div>
          <div className="insp-row">
            <div className="insp-field">
              <label>Task Type</label>
              <select value={step.task_type} disabled={readOnly}
                      onChange={(e) => onPatchStep({ task_type: e.target.value })}>
                {TASK_TYPE_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div className="insp-field">
              <label>Sichtbar für</label>
              <input type="text" value={step.sichtbar_fuer_prozess_typ || "Beide"} disabled={readOnly}
                     onChange={(e) => onPatchStep({ sichtbar_fuer_prozess_typ: e.target.value })} />
            </div>
          </div>
          <div className="insp-field">
            <label>Handler Key</label>
            <input className="mono" type="text" value={step.handler_key || ""} placeholder="(optional)"
                   disabled={readOnly}
                   onChange={(e) => onPatchStep({ handler_key: e.target.value })} />
          </div>
          <div className={`insp-toggle${step.pflicht ? " on" : ""}`}
               onClick={() => !readOnly && onPatchStep({ pflicht: step.pflicht ? 0 : 1 })}
               style={{ opacity: readOnly ? 0.6 : 1 }}>
            <span className="switch"></span>
            <span className="l">
              Pflicht-Schritt
              <div className="h">Muss erledigt werden bevor der Prozess abgeschlossen wird</div>
            </span>
          </div>
        </div>

        <div className="insp-section">
          <div className="insp-section-h">Verantwortlichkeit & Defaults</div>
          <div className="insp-row">
            <div className="insp-field">
              <label>Verantwortlich-Rolle</label>
              <input type="text" value={step.standard_verantwortlich_rolle || ""} disabled={readOnly}
                     placeholder="(Rolle)"
                     onChange={(e) => onPatchStep({ standard_verantwortlich_rolle: e.target.value })} />
            </div>
            <div className="insp-field">
              <label>Fälligkeit (Tage)</label>
              <input type="number" value={step.default_faelligkeit_tage || 0} disabled={readOnly}
                     onChange={(e) => onPatchStep({ default_faelligkeit_tage: parseInt(e.target.value, 10) || 0 })} />
            </div>
          </div>
          <div className="insp-field">
            <label>Dokument-Typ-Tag</label>
            <input type="text" value={step.dokument_typ_tag || ""} disabled={readOnly}
                   placeholder="(z.B. mietvertrag)"
                   onChange={(e) => onPatchStep({ dokument_typ_tag: e.target.value })} />
          </div>
        </div>

        <div className="insp-section">
          <KonfigEditor
            step={step}
            fieldSpecs={fieldSpecs}
            readOnly={readOnly}
            frm={frm}
            fetchSchema={fetchSchema}
            onPatchKonfig={(json) => onPatchStep({ konfig_json: json })}
            onOpenRawJson={() => onOpenRawJson({
              value: step.konfig_json || "{}",
              title: `Konfig (JSON) — ${step.step_key}`,
              onSave: (raw) => onPatchStep({ konfig_json: raw }),
            })}
            onOpenMapping={(cfg) => onOpenMapping({ stepKey: step.step_key, cfg })}
          />
        </div>

        <div className="insp-section">
          <div className="insp-section-h">
            I/O Verbindungen
            <span className="count">{myIO.length}</span>
          </div>
          {myIO.length === 0 && (
            <div style={{ color: "var(--ink-3)", fontSize: 12, padding: "4px 0 6px" }}>
              Noch keine I/O. Verbindungen entstehen, wenn du im Canvas Ports zieht.
            </div>
          )}
          {myIO.map((r, i) => {
            const kindLabel = r.kind === "payload_output" ? "OUT" : r.kind === "payload_input" ? "IN" : "STEP";
            const kindCls = r.kind === "payload_output" ? "out" : r.kind === "payload_input" ? "in" : "step";
            return (
              <div className="io-row" key={`${r.kind}:${r.target}:${i}`}>
                <span className={`kind ${kindCls}`}>{kindLabel}</span>
                <span className="tgt">{r.target}</span>
                {!readOnly && (
                  <button className="x" title="Entfernen"
                          onClick={() => onDeleteIO({ step_key: r.step_key, kind: r.kind, target: r.target })}>×</button>
                )}
              </div>
            );
          })}
          {!readOnly && (
            <button onClick={onOpenOutputDialog}
                    style={{
                      width: "100%", height: 32, marginTop: 8,
                      border: "1px dashed var(--border-strong)", borderRadius: 6,
                      background: "transparent", color: "var(--ink-2)",
                      fontFamily: "inherit", fontSize: 12.5, fontWeight: 500, cursor: "pointer",
                    }}>+ Output deklarieren</button>
          )}
        </div>
      </div>
      {!readOnly && (
        <div className="insp-footer">
          <button onClick={onClose}>Schließen</button>
          <button className="danger" title="Schritt löschen" onClick={onDeleteStep}>🗑</button>
        </div>
      )}
    </aside>
  );
}

// ========== Add Step Dialog ==========

function AddStepDialog({ open, existingKeys, onCancel, onAdd }) {
  const [titel, setTitel] = useState("");
  const [stepKey, setStepKey] = useState("");
  const [taskType, setTaskType] = useState("manual_check");
  const [pflicht, setPflicht] = useState(true);

  useEffect(() => {
    if (open) {
      let i = existingKeys.size + 1;
      const pad = (n) => `step_${String(n).padStart(2, "0")}`;
      while (existingKeys.has(pad(i))) i++;
      setStepKey(pad(i));
      setTitel("");
      setTaskType("manual_check");
      setPflicht(true);
    }
  }, [open, existingKeys]);

  if (!open) return null;
  const valid = titel.trim() && stepKey.trim() && !existingKeys.has(stepKey.trim());

  return (
    <div className="popover-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="popover">
        <div className="ph">
          <h3>Neuen Schritt anlegen</h3>
          <p>Fügt einen Knoten zum Graph hinzu. I/O verbindest du danach im Canvas.</p>
        </div>
        <div className="pb">
          <div className="insp-field">
            <label>Titel</label>
            <input autoFocus type="text" value={titel} onChange={(e) => setTitel(e.target.value)}
                   placeholder="z.B. Mietvertrag drucken" />
          </div>
          <div className="insp-row">
            <div className="insp-field">
              <label>Step Key</label>
              <input className="mono" type="text" value={stepKey} onChange={(e) => setStepKey(e.target.value)} />
              {existingKeys.has(stepKey.trim()) && (
                <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 3 }}>Step Key bereits vergeben</div>
              )}
            </div>
            <div className="insp-field" style={{ alignSelf: "flex-end" }}>
              <label>&nbsp;</label>
              <div className={`insp-toggle${pflicht ? " on" : ""}`} style={{ height: 32 }}
                   onClick={() => setPflicht(!pflicht)}>
                <span className="switch"></span>
                <span className="l" style={{ fontSize: 12 }}>Pflicht</span>
              </div>
            </div>
          </div>
          <div className="insp-field">
            <label>Task Type</label>
            <div className="tt-grid">
              {TASK_TYPE_KEYS.map((k) => {
                const tt = TASK_TYPES[k];
                return (
                  <button key={k} className={taskType === k ? "selected" : ""}
                          onClick={() => setTaskType(k)} style={ttStyle(k)}>
                    <span className="tt-dot" style={{
                      background: "var(--tt-soft)", color: "var(--tt-fg)",
                      border: "1px solid var(--tt-border)",
                    }}>{tt.glyph}</span>
                    <span>{k}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="pf">
          <button onClick={onCancel}>Abbrechen</button>
          <button className="primary" disabled={!valid}
                  style={{ opacity: valid ? 1 : 0.5, cursor: valid ? "pointer" : "not-allowed" }}
                  onClick={() => onAdd({
                    step_key: stepKey.trim(),
                    titel: titel.trim(),
                    task_type: taskType,
                    pflicht: pflicht ? 1 : 0,
                    sichtbar_fuer_prozess_typ: "Beide",
                    handler_key: "",
                  })}>Anlegen</button>
        </div>
      </div>
    </div>
  );
}

// ========== Auto-layout ==========

function computeAutoLayout(schritte, io, density) {
  const keys = new Set(schritte.map((s) => s.step_key));
  const producer = {};
  for (const r of io) if (r.kind === "payload_output") producer[r.target] = r.step_key;
  const deps = {};
  for (const sk of keys) deps[sk] = new Set();
  for (const r of io) {
    if (!keys.has(r.step_key)) continue;
    if (r.kind === "step_input" && r.target && keys.has(r.target)) deps[r.step_key].add(r.target);
    if (r.kind === "payload_input") {
      const p = producer[r.target];
      if (p && p !== r.step_key && keys.has(p)) deps[r.step_key].add(p);
    }
  }
  const layer = {};
  function lvl(sk, seen = new Set()) {
    if (sk in layer) return layer[sk];
    if (seen.has(sk)) return 0;
    seen.add(sk);
    let m = 0;
    for (const d of deps[sk]) m = Math.max(m, lvl(d, seen) + 1);
    layer[sk] = m;
    return m;
  }
  for (const s of schritte) lvl(s.step_key);
  const byLayer = {};
  for (const s of schritte) {
    const l = layer[s.step_key];
    (byLayer[l] = byLayer[l] || []).push(s.step_key);
  }
  const colW = density === "compact" ? 320 : 360;
  const rowH = 280;
  const out = {};
  Object.keys(byLayer).sort((a, b) => +a - +b).forEach((l) => {
    byLayer[l].forEach((sk, i) => {
      out[sk] = { editor_x: 80 + (+l) * colW, editor_y: 60 + i * rowH };
    });
  });
  return out;
}

// ========== Default schema/meta fetchers (fallbacks if host doesn't provide them) ==========

async function defaultFetchSchema() { return null; }
async function defaultFetchMeta(doctype) { throw new Error(`fetchMeta not provided (target: ${doctype})`); }

// ========== Main App ==========

export function App({
  // Required data props (typically from frm.doc)
  schritte = [],
  schritt_io = [],
  payload_field_specs = [],

  // Metadata for the toolbar
  versionLabel = "Prozess-Version",
  versionKey = "",
  isActive = false,
  prozess_typ = "",

  // Read-only mode: skip mutating callbacks
  read_only = false,

  // Frappe form object — threaded down so custom config widgets that need
  // frm (legacy frappe.ui.form.make_control etc.) keep working.
  frm = null,

  // Mutation callbacks (host wires these to frappe.model)
  onPatchStep,           // (step_key, patch) => void
  onAddStep,             // (newStepData) => void
  onDeleteStep,          // (step_key) => void
  onAddIO,               // ({step_key, kind, target}) => void
  onRemoveIO,            // ({step_key, kind, target}) => void
  onPatchField,          // (fieldname, patch) => void
  onDeleteField,         // (fieldname) => void
  onAddField,            // (spec) => void

  // Async server calls
  fetchSchema = defaultFetchSchema,   // async (task_type, handler_key) => schema | null
  fetchMeta = defaultFetchMeta,       // async (doctype) => {fields:[...]}

  // Optional host toast (defaults to console.log)
  onToast = (msg, kind) => console.log(`[${kind || "info"}]`, msg),

  // Visual tweaks (could come from URL params or be hardcoded)
  edgeStyle = "bezier",
  density = "comfortable",
  showGrid = true,
  showEdgeLabels = true,
}) {
  const isLocked = read_only;

  // ===== UI-only state =====
  const [selectedKey, setSelectedKey] = useState(null);
  const [panelMode, setPanelMode] = useState(null);  // "step" | "fields" | null
  const [search, setSearch] = useState("");

  // Pan / zoom
  const [view, setView] = useState({ tx: 60, ty: 40, scale: 0.85 });
  const [vpSize, setVpSize] = useState({ w: 1, h: 1 });
  const wsRef = useRef(null);

  // Drag
  const [dragNode, setDragNode] = useState(null);
  const [panning, setPanning] = useState(false);
  const panRef = useRef(null);

  // Connect
  const [connect, setConnect] = useState(null);
  const [hotTarget, setHotTarget] = useState(null);
  const [hoverEdge, setHoverEdge] = useState(null);

  // Dialogs
  const [addOpen, setAddOpen] = useState(false);
  const [rawJsonDialog, setRawJsonDialog] = useState(null);
  const [outputDialog, setOutputDialog] = useState(null);
  const [mappingDialog, setMappingDialog] = useState(null);
  const [addFieldOpen, setAddFieldOpen] = useState(false);

  // PI position (UI-only; persists locally per mount)
  const [piPosition, setPiPosition] = useState({ x: -260, y: 60 });
  const didInitialPiAnchor = useRef(false);

  // Toasts
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((msg, kind = "ok") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2400);
    onToast(msg, kind);
  }, [onToast]);

  // ===== Resize observer =====
  useEffect(() => {
    if (!wsRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setVpSize({ w: r.width, h: r.height });
    });
    ro.observe(wsRef.current);
    return () => ro.disconnect();
  }, []);

  // ===== Derived =====
  const errors = useMemo(() => validateGraph(schritte, schritt_io), [schritte, schritt_io]);
  const producerByField = useMemo(() => {
    const m = {};
    for (const r of schritt_io) if (r.kind === "payload_output" && r.target) m[r.target] = r.step_key;
    return m;
  }, [schritt_io]);
  const piFields = useMemo(
    () => getProcessInputFields(schritt_io, payload_field_specs),
    [schritt_io, payload_field_specs]
  );
  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return new Set();
    return new Set(schritte.filter((s) =>
      (s.titel || "").toLowerCase().includes(q) ||
      (s.step_key || "").toLowerCase().includes(q) ||
      (s.task_type || "").toLowerCase().includes(q)
    ).map((s) => s.step_key));
  }, [search, schritte]);

  // ===== Auto-fit + PI anchor on first mount =====
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (didInitialFit.current) return;
    if (vpSize.w < 100 || !schritte.length) return;
    didInitialFit.current = true;
    setTimeout(() => onFitToScreen(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vpSize.w, vpSize.h]);

  useEffect(() => {
    if (didInitialPiAnchor.current) return;
    if (!schritte.length) return;
    didInitialPiAnchor.current = true;
    const minX = Math.min(...schritte.map((s) => s.editor_x));
    const minY = Math.min(...schritte.map((s) => s.editor_y));
    setPiPosition({ x: minX - (PI_W + 80), y: minY });
  }, [schritte]);

  // ===== Panel helpers =====
  const selectStep = useCallback((sk) => { setSelectedKey(sk); setPanelMode("step"); }, []);
  const closePanel = useCallback(() => { setSelectedKey(null); setPanelMode(null); }, []);
  const toggleFieldsPanel = useCallback(() => {
    setPanelMode((m) => m === "fields" ? null : "fields");
    setSelectedKey(null);
  }, []);

  // ===== Mutations: delegate to host callbacks =====
  const patchStep = (sk, patch) => { if (isLocked || !onPatchStep) return; onPatchStep(sk, patch); };
  const addStep = (s) => { if (isLocked || !onAddStep) return; onAddStep(s); };
  const deleteStep = (sk) => {
    if (isLocked || !onDeleteStep) return;
    onDeleteStep(sk);
    setSelectedKey(null);
    setPanelMode(null);
    toast(`Schritt ${sk} entfernt`);
  };
  const addIO = (row) => { if (isLocked || !onAddIO) return; onAddIO(row); };
  const removeIO = (row) => { if (isLocked || !onRemoveIO) return; onRemoveIO(row); };

  const deleteEdge = useCallback((edgeId) => {
    if (isLocked) return;
    const parts = edgeId.split(":");
    if (parts[0] === "payload") {
      const [, , cons, field] = parts;
      removeIO({ step_key: cons, kind: "payload_input", target: field });
      toast(`Verbindung ${field} entfernt`);
    } else if (parts[0] === "pi") {
      const [, field, cons] = parts;
      removeIO({ step_key: cons, kind: "payload_input", target: field });
      toast(`Process-Input ${field} nicht mehr gelesen`);
    } else if (parts[0] === "step") {
      const [, target, sk] = parts;
      removeIO({ step_key: sk, kind: "step_input", target });
      toast(`Ordering ${target} → ${sk} entfernt`);
    }
    // edges of kind "trigger" are not stored — derived only, can't be deleted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocked]);

  // ===== Pan/zoom + drag/connect handlers =====
  function onCanvasMouseDown(e) {
    if (e.button !== 0) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty };
    setPanning(true);
    closePanel();
  }
  useEffect(() => {
    function onMove(e) {
      if (panning && panRef.current) {
        const dx = e.clientX - panRef.current.startX;
        const dy = e.clientY - panRef.current.startY;
        setView((v) => ({ ...v, tx: panRef.current.tx + dx, ty: panRef.current.ty + dy }));
      }
      if (dragNode) {
        const rect = wsRef.current.getBoundingClientRect();
        const wx = (e.clientX - rect.left - view.tx) / view.scale;
        const wy = (e.clientY - rect.top - view.ty) / view.scale;
        if (dragNode.key === PROCESS_INPUTS_NODE) {
          setPiPosition({
            x: Math.round(wx - dragNode.offsetX),
            y: Math.round(wy - dragNode.offsetY),
          });
        } else {
          patchStep(dragNode.key, {
            editor_x: Math.round(wx - dragNode.offsetX),
            editor_y: Math.round(wy - dragNode.offsetY),
          });
        }
      }
      if (connect) {
        const rect = wsRef.current.getBoundingClientRect();
        const wx = (e.clientX - rect.left - view.tx) / view.scale;
        const wy = (e.clientY - rect.top - view.ty) / view.scale;
        setConnect((c) => c ? { ...c, mouseX: wx, mouseY: wy } : c);
      }
    }
    function onUp() {
      setPanning(false);
      panRef.current = null;
      setDragNode(null);
      if (connect) {
        if (hotTarget) finalizeConnection(connect, hotTarget);
        setConnect(null);
        setHotTarget(null);
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [panning, dragNode, view, connect, hotTarget]);

  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = wsRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const newScale = Math.max(0.25, Math.min(2.5, v.scale * factor));
      const ratio = newScale / v.scale;
      return {
        scale: newScale,
        tx: mx - (mx - v.tx) * ratio,
        ty: my - (my - v.ty) * ratio,
      };
    });
  }

  function finalizeConnection(src, dst) {
    if (isLocked) return;
    if (src.srcPort === "trigger-out" || dst.port === "trigger-out") {
      toast("Trigger-Linien sind automatisch — verbinde I/O statt Trigger zu ziehen", "err");
      return;
    }
    if (src.srcNode === PROCESS_INPUTS_NODE && src.srcPort.startsWith("out:")) {
      if (dst.node === PROCESS_INPUTS_NODE) return;
      if (!dst.port.startsWith("in:")) { toast("PI-Port nur auf Input-Port droppen", "err"); return; }
      const field = src.srcPort.slice(4);
      if (dst.port.slice(3) !== field) {
        toast(`Feldnamen müssen übereinstimmen (${field} ≠ ${dst.port.slice(3)})`, "err");
        return;
      }
      addIO({ step_key: dst.node, kind: "payload_input", target: field });
      toast(`Process Input gelesen: ${field}`);
      return;
    }
    if (dst.node === PROCESS_INPUTS_NODE && dst.port.startsWith("out:")) {
      if (src.srcNode === PROCESS_INPUTS_NODE) return;
      if (!src.srcPort.startsWith("in:")) return;
      const field = dst.port.slice(4);
      if (src.srcPort.slice(3) !== field) return;
      addIO({ step_key: src.srcNode, kind: "payload_input", target: field });
      toast(`Process Input gelesen: ${field}`);
      return;
    }
    if (src.srcPort === "step-out" && dst.port === "step-in") {
      if (src.srcNode === dst.node) return;
      addIO({ step_key: dst.node, kind: "step_input", target: src.srcNode });
      toast(`Ordering: ${src.srcNode} → ${dst.node}`);
      return;
    }
    if (src.srcPort === "step-in" && dst.port === "step-out") {
      if (src.srcNode === dst.node) return;
      addIO({ step_key: src.srcNode, kind: "step_input", target: dst.node });
      toast(`Ordering: ${dst.node} → ${src.srcNode}`);
      return;
    }
    function payloadEdge(prod, prodField, cons, consField) {
      if (prod === cons) return;
      if (prodField !== consField) {
        toast(`Feldnamen müssen übereinstimmen (${prodField} ≠ ${consField})`, "err");
        return;
      }
      addIO({ step_key: prod, kind: "payload_output", target: prodField });
      addIO({ step_key: cons, kind: "payload_input", target: prodField });
      toast(`Verbunden: ${prodField}`);
    }
    if (src.srcPort.startsWith("out:") && dst.port.startsWith("in:")) {
      payloadEdge(src.srcNode, src.srcPort.slice(4), dst.node, dst.port.slice(3));
    } else if (src.srcPort.startsWith("in:") && dst.port.startsWith("out:")) {
      payloadEdge(dst.node, dst.port.slice(4), src.srcNode, src.srcPort.slice(3));
    } else {
      toast("Ungültige Verbindung", "err");
    }
  }

  function onPortMouseDown(e, nodeKey, portId) {
    if (isLocked) return;
    if (e.button !== 0) return;
    if (nodeKey === PROCESS_INPUTS_NODE) {
      let p;
      if (portId === "trigger-out") p = getPITriggerPos();
      else {
        const sep = portId.indexOf(":");
        const field = portId.slice(sep + 1);
        p = getPIPortPos(field, piFields);
      }
      const rect = wsRef.current.getBoundingClientRect();
      const wx = (e.clientX - rect.left - view.tx) / view.scale;
      const wy = (e.clientY - rect.top - view.ty) / view.scale;
      setConnect({
        srcNode: PROCESS_INPUTS_NODE, srcPort: portId, srcSide: p.side,
        srcKind: portId === "trigger-out" ? "trigger" : "process_input",
        startX: piPosition.x + p.x, startY: piPosition.y + p.y,
        mouseX: wx, mouseY: wy,
      });
      return;
    }
    const node = schritte.find((s) => s.step_key === nodeKey);
    if (!node) return;
    const ports = getNodePorts(nodeKey, schritt_io);
    const p = getPortPos(portId, ports, density);
    const rect = wsRef.current.getBoundingClientRect();
    const wx = (e.clientX - rect.left - view.tx) / view.scale;
    const wy = (e.clientY - rect.top - view.ty) / view.scale;
    setConnect({
      srcNode: nodeKey, srcPort: portId, srcSide: p.side, srcKind: p.kind,
      startX: node.editor_x + p.x, startY: node.editor_y + p.y,
      mouseX: wx, mouseY: wy,
    });
  }

  function onPortMouseUp(e, nodeKey, portId) {
    if (!connect) return;
    setHotTarget({ node: nodeKey, port: portId });
  }

  function onNodeMouseDownHeader(e, nodeKey) {
    if (isLocked) return;
    const node = schritte.find((s) => s.step_key === nodeKey);
    if (!node) return;
    const rect = wsRef.current.getBoundingClientRect();
    const wx = (e.clientX - rect.left - view.tx) / view.scale;
    const wy = (e.clientY - rect.top - view.ty) / view.scale;
    setDragNode({ key: nodeKey, offsetX: wx - node.editor_x, offsetY: wy - node.editor_y });
    selectStep(nodeKey);
  }

  function onAutoLayout() {
    if (isLocked) return;
    const result = computeAutoLayout(schritte, schritt_io, density);
    for (const [sk, pos] of Object.entries(result)) {
      patchStep(sk, pos);
    }
    setTimeout(onFitToScreen, 50);
    toast("Auto-Layout angewendet");
  }

  function onFitToScreen() {
    if (!schritte.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of schritte) {
      const ports = getNodePorts(s.step_key, schritt_io);
      const w = getNodeWidth(density);
      const h = getNodeHeight(ports);
      minX = Math.min(minX, s.editor_x);
      minY = Math.min(minY, s.editor_y);
      maxX = Math.max(maxX, s.editor_x + w);
      maxY = Math.max(maxY, s.editor_y + h);
    }
    if (piFields.length > 0) {
      const piH = getPIHeight(piFields);
      minX = Math.min(minX, piPosition.x);
      minY = Math.min(minY, piPosition.y);
      maxX = Math.max(maxX, piPosition.x + PI_W);
      maxY = Math.max(maxY, piPosition.y + piH);
    }
    const pad = 60;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const sx = vpSize.w / (maxX - minX);
    const sy = vpSize.h / (maxY - minY);
    const scale = Math.min(1.4, sx, sy);
    setView({
      scale,
      tx: -minX * scale + (vpSize.w - (maxX - minX) * scale) / 2,
      ty: -minY * scale + (vpSize.h - (maxY - minY) * scale) / 2,
    });
  }

  const viewport = useMemo(() => ({
    x1: -view.tx / view.scale,
    y1: -view.ty / view.scale,
    x2: (-view.tx + vpSize.w) / view.scale,
    y2: (-view.ty + vpSize.h) / view.scale,
  }), [view, vpSize]);

  function onMinimapNavigate(wx, wy) {
    setView((v) => ({
      ...v,
      tx: -wx * v.scale + vpSize.w / 2,
      ty: -wy * v.scale + vpSize.h / 2,
    }));
  }

  // Preview-edge endpoints
  const previewFrom = connect ? { x: connect.startX, y: connect.startY, side: connect.srcSide } : null;
  const previewTo = connect ? (() => {
    if (hotTarget) {
      if (hotTarget.node === PROCESS_INPUTS_NODE) {
        const sep = hotTarget.port.indexOf(":");
        const field = hotTarget.port.slice(sep + 1);
        const p = getPIPortPos(field, piFields);
        return { x: piPosition.x + p.x, y: piPosition.y + p.y, side: p.side };
      }
      const node = schritte.find((s) => s.step_key === hotTarget.node);
      if (node) {
        const ports = getNodePorts(hotTarget.node, schritt_io);
        const p = getPortPos(hotTarget.port, ports, density);
        return { x: node.editor_x + p.x, y: node.editor_y + p.y, side: p.side };
      }
    }
    return { x: connect.mouseX, y: connect.mouseY, side: connect.srcSide === "left" ? "right" : "left" };
  })() : null;

  const gridStyle = useMemo(() => {
    const size = 24 * view.scale;
    return {
      backgroundImage: showGrid
        ? "radial-gradient(circle, oklch(80% 0.008 80) 1px, transparent 1.4px)"
        : "none",
      backgroundSize: `${size}px ${size}px`,
      backgroundPosition: `${view.tx % size}px ${view.ty % size}px`,
    };
  }, [view, showGrid]);

  const selectedStep = selectedKey ? schritte.find((s) => s.step_key === selectedKey) : null;
  const existingKeys = useMemo(() => new Set(schritte.map((s) => s.step_key)), [schritte]);

  // ===== Sync I/O for create_linked_doc mapping save =====
  function syncMappingIO(stepKey, nextCfg) {
    const out = (nextCfg.store_in_payload_field || "").trim();
    const ins = new Set();
    for (const v of Object.values(nextCfg.prefill_mapping || {})) {
      const m = String(v).match(PAYLOAD_RE);
      if (m) ins.add(m[1]);
    }
    // Remove all existing payload_* rows for this step, then add new ones
    const existing = schritt_io.filter((r) => r.step_key === stepKey && (r.kind === "payload_input" || r.kind === "payload_output"));
    for (const r of existing) removeIO({ step_key: r.step_key, kind: r.kind, target: r.target });
    if (out) addIO({ step_key: stepKey, kind: "payload_output", target: out });
    for (const f of ins) addIO({ step_key: stepKey, kind: "payload_input", target: f });
  }

  return (
    <div className="app">
      <Toolbar
        versionLabel={versionLabel}
        versionKey={versionKey}
        isActive={isActive}
        isLocked={isLocked}
        search={search} setSearch={setSearch}
        validationErrors={errors}
        panelMode={panelMode}
        onAddStep={() => setAddOpen(true)}
        onAutoLayout={onAutoLayout}
        onFitToScreen={onFitToScreen}
        onToggleFieldsPanel={toggleFieldsPanel}
      />

      <div className="workspace" ref={wsRef}>
        <div className={`canvas${panning ? " panning" : ""}${connect ? " connecting" : ""}`}
             onMouseDown={onCanvasMouseDown} onWheel={onWheel}>
          <div className="canvas-grid" style={gridStyle}></div>

          <div className="canvas-stage"
               style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}>
            <EdgesLayer
              schritte={schritte}
              io={schritt_io}
              hovered={hoverEdge}
              density={density}
              edgeStyle={edgeStyle}
              showLabels={showEdgeLabels}
              piFields={piFields}
              piPosition={piPosition}
              onEdgeMouseEnter={(id) => setHoverEdge(id)}
              onEdgeMouseLeave={() => setHoverEdge(null)}
              onDeleteEdge={deleteEdge}
            />

            {piFields.length > 0 && (
              <ProcessInputsNode
                position={piPosition}
                piFields={piFields}
                io={schritt_io}
                selected={panelMode === "fields"}
                dragging={dragNode && dragNode.key === PROCESS_INPUTS_NODE}
                hotPort={hotTarget && hotTarget.node === PROCESS_INPUTS_NODE ? hotTarget : null}
                validTarget={connect && connect.srcNode !== PROCESS_INPUTS_NODE ? "valid" : null}
                onSelect={() => { setSelectedKey(null); setPanelMode("fields"); }}
                onMouseDownHeader={(e) => {
                  if (isLocked) return;
                  const rect = wsRef.current.getBoundingClientRect();
                  const wx = (e.clientX - rect.left - view.tx) / view.scale;
                  const wy = (e.clientY - rect.top - view.ty) / view.scale;
                  setDragNode({
                    key: PROCESS_INPUTS_NODE,
                    offsetX: wx - piPosition.x,
                    offsetY: wy - piPosition.y,
                  });
                }}
                onPortMouseDown={onPortMouseDown}
                onPortMouseUp={onPortMouseUp}
              />
            )}

            {schritte.map((s) => {
              const ports = getNodePorts(s.step_key, schritt_io);
              const dimmed = search && !searchHits.has(s.step_key);
              const validTarget = connect && connect.srcNode !== s.step_key ? "valid" : null;
              return (
                <div key={s.step_key}
                     onMouseEnter={() => connect && setHotTarget((h) => h || { node: s.step_key, port: "step-in" })}
                     style={{ position: "absolute" }}>
                  <Node
                    node={s}
                    ports={ports}
                    density={density}
                    selected={selectedKey === s.step_key && panelMode === "step"}
                    dimmed={dimmed}
                    searchHit={search && searchHits.has(s.step_key)}
                    dragging={dragNode && dragNode.key === s.step_key}
                    readOnly={isLocked}
                    hotPort={hotTarget && hotTarget.node === s.step_key ? hotTarget : null}
                    validTarget={validTarget}
                    onSelect={(k) => selectStep(k)}
                    onMouseDownHeader={onNodeMouseDownHeader}
                    onPortMouseDown={onPortMouseDown}
                    onPortMouseUp={onPortMouseUp}
                  />
                </div>
              );
            })}

            {connect && <PreviewEdge from={previewFrom} to={previewTo} edgeStyle={edgeStyle} />}
          </div>

          {!schritte.length && (
            <div className="canvas-empty">
              Noch keine Schritte. Klicke „Schritt hinzufügen".
            </div>
          )}
        </div>

        <div className="canvas-controls">
          <button title="Zoom out" onClick={() => setView((v) => ({ ...v, scale: Math.max(0.25, v.scale / 1.15) }))}>−</button>
          <span className="zoom-level">{Math.round(view.scale * 100)}%</span>
          <button title="Zoom in" onClick={() => setView((v) => ({ ...v, scale: Math.min(2.5, v.scale * 1.15) }))}>+</button>
          <button title="Reset" onClick={() => setView({ tx: 60, ty: 40, scale: 1 })}>⟲</button>
        </div>

        <MiniMap schritte={schritte} io={schritt_io} viewport={viewport}
                 density={density} onNavigate={onMinimapNavigate} />

        <Inspector
          open={panelMode === "step" && !!selectedStep}
          step={selectedStep}
          io={schritt_io}
          fieldSpecs={payload_field_specs}
          readOnly={isLocked}
          frm={frm}
          fetchSchema={fetchSchema}
          onClose={closePanel}
          onPatchStep={(patch) => patchStep(selectedKey, patch)}
          onDeleteStep={() => deleteStep(selectedKey)}
          onDeleteIO={removeIO}
          onOpenOutputDialog={() => setOutputDialog({ stepKey: selectedKey })}
          onOpenRawJson={(payload) => setRawJsonDialog(payload)}
          onOpenMapping={(payload) => setMappingDialog(payload)}
        />

        <FieldsPanel
          open={panelMode === "fields"}
          fieldSpecs={payload_field_specs}
          io={schritt_io}
          readOnly={isLocked}
          onClose={closePanel}
          onPatchField={(fn, patch) => { if (!isLocked && onPatchField) onPatchField(fn, patch); }}
          onDeleteField={(fn) => { if (!isLocked && onDeleteField) onDeleteField(fn); }}
          onAddFieldClick={() => setAddFieldOpen(true)}
        />

        <Legend />

        <AddStepDialog
          open={addOpen}
          existingKeys={existingKeys}
          onCancel={() => setAddOpen(false)}
          onAdd={(s) => {
            const maxX = schritte.reduce((m, x) => Math.max(m, x.editor_x || 0), 0);
            const newX = maxX ? maxX + 340 : 80;
            const maxOrd = schritte.reduce((m, x) => Math.max(m, x.reihenfolge || 0), 0);
            addStep({
              ...s,
              reihenfolge: maxOrd + 10,
              dokument_typ_tag: "",
              print_format: "",
              standard_verantwortlich_rolle: "",
              default_faelligkeit_tage: 7,
              konfig_json: "{}",
              editor_x: newX,
              editor_y: 80,
            });
            setAddOpen(false);
            selectStep(s.step_key);
            toast(`Schritt ${s.step_key} angelegt`);
          }}
        />

        <AddFieldDialog
          open={addFieldOpen}
          existingNames={new Set(payload_field_specs.map((f) => f.fieldname))}
          onCancel={() => setAddFieldOpen(false)}
          onAdd={(spec) => {
            if (!isLocked && onAddField) onAddField(spec);
            setAddFieldOpen(false);
          }}
        />

        <OutputDeclareDialog
          open={!!outputDialog}
          stepKey={outputDialog ? outputDialog.stepKey : ""}
          availableFields={
            outputDialog
              ? payload_field_specs.map((f) => f.fieldname)
                  .filter((fn) => !schritt_io.some((r) => r.kind === "payload_output" && r.target === fn))
              : []
          }
          onCancel={() => setOutputDialog(null)}
          onDeclare={(target) => {
            addIO({ step_key: outputDialog.stepKey, kind: "payload_output", target });
            toast(`Output ${target} deklariert`);
            setOutputDialog(null);
          }}
        />

        <DocFieldMappingDialog
          open={!!mappingDialog}
          cfg={mappingDialog ? mappingDialog.cfg : {}}
          payloadFields={payload_field_specs.map((f) => f.fieldname)}
          fetchMeta={fetchMeta}
          onCancel={() => setMappingDialog(null)}
          onSave={(nextCfg) => {
            const sk = mappingDialog.stepKey;
            patchStep(sk, { konfig_json: JSON.stringify(nextCfg) });
            syncMappingIO(sk, nextCfg);
            setMappingDialog(null);
            toast("Feld-Mapping aktualisiert");
          }}
        />

        <RawJsonDialog
          open={!!rawJsonDialog}
          value={rawJsonDialog ? rawJsonDialog.value : ""}
          title={rawJsonDialog ? rawJsonDialog.title : ""}
          onCancel={() => setRawJsonDialog(null)}
          onSave={(raw) => { rawJsonDialog.onSave(raw); setRawJsonDialog(null); }}
        />

        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
          ))}
        </div>
      </div>

      <div className="statusbar">
        <span className="stat"><strong>{schritte.length}</strong> Schritte</span>
        <span className="sep">·</span>
        <span className="stat"><strong>{schritt_io.length}</strong> I/O-Zeilen</span>
        <span className="sep">·</span>
        <span className="stat"><strong>{deriveEdges(schritte, schritt_io, piFields).length}</strong> Edges</span>
        <span className="sep">·</span>
        <span className="stat">{payload_field_specs.length} payload fields</span>
        <div className="spacer"></div>
        <span className="stat">Ctrl+Scroll zum Zoomen · Drag auf Canvas zum Pannen · Port → Port verbinden</span>
      </div>
    </div>
  );
}
