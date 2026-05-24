// editor-panels.jsx — KonfigEditor, FieldsPanel, DocFieldMapping, dialogs, Legend

import React, { useState, useEffect, useMemo, useRef } from "react";
import { FIELD_TYPES } from "./data.js";

// ========== Custom config widget bridge ==========
//
// Mirrors prozess_version.js' _render_config_fields dispatch:
//   const fn = window.process_engine.config_widgets.get(def.widget || "control");
//   fn({ frm, row, def, cfg, container, commit(key, value) });
//
// For unknown widget names, the editor mounts the registered function into a
// per-widget DOM slot via useRef + useEffect. cfg/onPatchKonfig are held in a
// ref so the widget's commit() always sees current state without re-mounting
// on every keystroke.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function CustomConfigWidget({ widgetName, frm, step, def, cfg, readOnly, onPatchKonfig }) {
  const slotRef = useRef(null);
  // Always read latest cfg / onPatchKonfig at commit time — without
  // forcing a re-mount on every keystroke.
  const liveRef = useRef({ cfg, onPatchKonfig });
  liveRef.current = { cfg, onPatchKonfig };

  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;

    const ns = (typeof window !== "undefined" && window.process_engine) || null;
    const registry = ns && ns.config_widgets;
    let widgetFn = null;
    if (registry) {
      widgetFn = typeof registry.get === "function" ? registry.get(widgetName) : registry[widgetName];
    }

    if (typeof widgetFn !== "function") {
      el.innerHTML = `
        <div class="custom-widget-missing">
          Widget <code>${escapeHtml(widgetName)}</code> nicht registriert.
          <div class="hint">App-Bundle muss <code>window.process_engine.register_config_widget("${escapeHtml(widgetName)}", fn)</code> aufrufen. Bis dahin: „JSON"-Button benutzen.</div>
        </div>
      `;
      // eslint-disable-next-line no-console
      console.warn(`[process_editor] config widget not registered: "${widgetName}"`);
      return () => { el.innerHTML = ""; };
    }

    el.innerHTML = "";
    const ctx = {
      frm,
      row: step,
      def,
      // Latest cfg via getter, so widgets that read ctx.cfg multiple times
      // always see the current persisted state.
      get cfg() { return liveRef.current.cfg || {}; },
      container: el,
      readOnly,
      commit(key, value) {
        const next = { ...(liveRef.current.cfg || {}), [key]: value };
        liveRef.current.onPatchKonfig(JSON.stringify(next));
      },
      // Mehrere Keys atomar schreiben — zwei aufeinanderfolgende commit()-Aufrufe
      // wuerden sonst beide das (noch nicht re-gerenderte) alte cfg lesen und sich
      // gegenseitig ueberschreiben.
      commitMany(patch) {
        const next = { ...(liveRef.current.cfg || {}), ...(patch || {}) };
        liveRef.current.onPatchKonfig(JSON.stringify(next));
      },
    };
    try {
      widgetFn(ctx);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[process_editor] config widget "${widgetName}" threw:`, e);
      el.innerHTML = `<div class="custom-widget-missing" style="border-color:var(--danger);color:var(--danger)">Fehler im Widget <code>${escapeHtml(widgetName)}</code>: ${escapeHtml(e && e.message || String(e))}</div>`;
    }

    return () => {
      try { el.innerHTML = ""; } catch (_) {}
    };
    // Re-mount only when widget identity or owning step changes — not on
    // every cfg keystroke. Widgets manage their own internal state and
    // call commit() to write back.
  }, [widgetName, step.step_key, def.key, readOnly, frm]);

  return (
    <div className="insp-field custom-config-widget">
      <label>{def.label || def.key}{def.reqd ? " *" : ""}</label>
      <div ref={slotRef} className="custom-widget-slot" />
    </div>
  );
}

// ========== Konfig editor (schema-driven, with raw JSON escape hatch) ==========

export function KonfigEditor({
  step,
  fieldSpecs,
  readOnly,
  frm,                        // optional Frappe form, weitergereicht an Custom-Widgets
  fetchSchema,                // async (task_type, handler_key) => {fields: [...]} | null
  onPatchKonfig,
  onOpenRawJson,
  onOpenMapping,
}) {
  let cfg = {};
  try { cfg = JSON.parse(step.konfig_json || "{}") || {}; } catch (e) { cfg = {}; }
  if (!cfg || typeof cfg !== "object") cfg = {};

  // Fetch schema for this task_type/handler_key. Re-fetches if either changes.
  const [schema, setSchema] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.resolve(fetchSchema(step.task_type, step.handler_key || ""))
      .then((s) => { if (!cancelled) { setSchema(s); setLoading(false); } })
      .catch(() => { if (!cancelled) { setSchema(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [step.task_type, step.handler_key, fetchSchema]);

  const fields = schema && Array.isArray(schema.fields) ? schema.fields : [];

  const setKey = (k, v) => {
    const next = { ...cfg, [k]: v };
    onPatchKonfig(JSON.stringify(next));
  };

  const handler = step.handler_key ? `${step.handler_key} (custom handler)` : `${step.task_type} handler`;

  // Built-in widget types we render natively. Everything else dispatches to the
  // global window.process_engine.config_widgets registry — that's the same mechanism
  // your existing prozess_version.js uses (Stufe 3: app-spezifische Custom-Widgets).
  const BUILTIN_WIDGETS = new Set(["", "control", "payload_field_select", "doc_field_mapping"]);

  return (
    <div className="konfig-editor">
      <div className="insp-section-h" style={{ marginBottom: 8 }}>
        Konfig
        <button className="konfig-raw" title="Rohes JSON bearbeiten" onClick={onOpenRawJson}>JSON</button>
      </div>
      <div className="schema-source" title="get_task_config_schema(task_type, handler_key) → handler.config_schema()">
        <span className="schema-source-dot"></span>
        <span className="schema-source-text">
          {loading
            ? <>Lade Schema von <code>{handler}</code>…</>
            : fields.length > 0
              ? <>Schema: <code>{handler}.config_schema()</code> — <strong>{fields.length}</strong> Feld{fields.length !== 1 ? "er" : ""}</>
              : <>Kein Schema deklariert von <code>{handler}</code> — roher JSON-Editor</>
          }
        </span>
      </div>
      {!loading && fields.length === 0 && (
        <pre className="konfig-pre">{(step.konfig_json || "").trim() || "{}"}</pre>
      )}
      {fields.map((def) => {
        // Custom widget from the global registry — beliebiges JS aus deinem App-Bundle.
        if (def.widget && !BUILTIN_WIDGETS.has(def.widget)) {
          return (
            <CustomConfigWidget
              key={def.key}
              widgetName={def.widget}
              frm={frm}
              step={step}
              def={def}
              cfg={cfg}
              readOnly={readOnly}
              onPatchKonfig={onPatchKonfig}
            />
          );
        }
        if (def.widget === "doc_field_mapping") {
          const dfCount = Array.isArray(cfg.dialog_fields) ? cfg.dialog_fields.length : 0;
          const pmCount = (cfg.prefill_mapping && typeof cfg.prefill_mapping === "object")
            ? Object.keys(cfg.prefill_mapping).length : 0;
          const target = (cfg.target_doctype || "").trim();
          return (
            <div className="insp-field konfig-mapping" key={def.key}>
              <label>{def.label || "Feld-Mapping"}</label>
              <div className="mapping-summary">
                {target
                  ? <><strong>{dfCount}</strong> manuell, <strong>{pmCount}</strong> vorbelegt</>
                  : <span className="muted">Erst Ziel-Doctype wählen</span>}
              </div>
              <button
                className="mapping-edit"
                disabled={readOnly || !target}
                onClick={() => onOpenMapping(cfg)}
              >Feld-Mapping bearbeiten →</button>
            </div>
          );
        }
        if (def.widget === "payload_field_select") {
          return (
            <div className="insp-field" key={def.key}>
              <label>{def.label}</label>
              <select
                value={cfg[def.key] != null ? cfg[def.key] : ""}
                disabled={readOnly}
                onChange={(e) => setKey(def.key, e.target.value)}
              >
                <option value="">—</option>
                {fieldSpecs.map((f) => (
                  <option key={f.fieldname} value={f.fieldname}>{f.fieldname}</option>
                ))}
              </select>
            </div>
          );
        }
        const ft = def.fieldtype || "Data";
        const cur = cfg[def.key];
        if (ft === "Check") {
          return (
            <div className="insp-field" key={def.key}>
              <div className={`insp-toggle${cur ? " on" : ""}`} onClick={() => !readOnly && setKey(def.key, cur ? 0 : 1)} style={{ opacity: readOnly ? 0.6 : 1 }}>
                <span className="switch"></span>
                <span className="l">{def.label}</span>
              </div>
            </div>
          );
        }
        if (ft === "Int" || ft === "Float" || ft === "Currency") {
          return (
            <div className="insp-field" key={def.key}>
              <label>{def.label}</label>
              <input
                type="number"
                value={cur != null ? cur : ""}
                disabled={readOnly}
                onChange={(e) => setKey(def.key, e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
          );
        }
        if (ft === "Select" && def.options) {
          const opts = def.options.split("\n");
          return (
            <div className="insp-field" key={def.key}>
              <label>{def.label}</label>
              <select value={cur != null ? cur : ""} disabled={readOnly} onChange={(e) => setKey(def.key, e.target.value)}>
                <option value="">—</option>
                {opts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          );
        }
        return (
          <div className="insp-field" key={def.key}>
            <label>{def.label}</label>
            <input
              type="text"
              value={cur != null ? cur : ""}
              disabled={readOnly}
              onChange={(e) => setKey(def.key, e.target.value)}
            />
          </div>
        );
      })}
    </div>
  );
}

// ========== Raw JSON dialog ==========

export function RawJsonDialog({ open, value, title, onCancel, onSave }) {
  const [text, setText] = useState(value || "{}");
  const [err, setErr] = useState("");
  useEffect(() => { if (open) { setText(value || "{}"); setErr(""); } }, [open, value]);
  if (!open) return null;
  return (
    <div className="popover-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="popover" style={{ width: 540 }}>
        <div className="ph">
          <h3>{title || "JSON bearbeiten"}</h3>
          <p>Rohes JSON. Wird beim Übernehmen validiert.</p>
        </div>
        <div className="pb">
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setErr(""); }}
            style={{
              width: "100%", minHeight: 220, fontFamily: "JetBrains Mono, monospace", fontSize: 12.5,
              border: "1px solid var(--border)", borderRadius: 6, padding: 10, outline: "none",
              resize: "vertical",
            }}
          />
          {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
        </div>
        <div className="pf">
          <button onClick={onCancel}>Abbrechen</button>
          <button className="primary" onClick={() => {
            try { JSON.parse(text); onSave(text); }
            catch (e) { setErr("Ungültiges JSON: " + String(e.message || e)); }
          }}>Übernehmen</button>
        </div>
      </div>
    </div>
  );
}

// ========== Output deklarieren dialog ==========

export function OutputDeclareDialog({ open, stepKey, availableFields, existingNames, onCancel, onDeclare, onDeclareNew }) {
  const [mode, setMode] = useState("existing");
  const [target, setTarget] = useState("");
  const [fieldname, setFieldname] = useState("");
  const [label, setLabel] = useState("");
  const [fieldtype, setFieldtype] = useState("Data");
  const [options, setOptions] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode(availableFields.length > 0 ? "existing" : "new");
    setTarget(availableFields[0] || "");
    setFieldname(""); setLabel(""); setFieldtype("Data"); setOptions("");
  }, [open, availableFields]);

  if (!open) return null;

  const validName = /^[a-z][a-z0-9_]*$/.test(fieldname.trim());
  const takenNew = existingNames && existingNames.has(fieldname.trim());
  const newValid = validName && !takenNew && label.trim();
  const canDeclare = mode === "existing" ? !!target : newValid;

  return (
    <div className="popover-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="popover" style={{ width: 460 }}>
        <div className="ph">
          <h3>Output deklarieren — {stepKey}</h3>
          <p>Dieser Schritt produziert ein Payload-Feld. Bestehendes wählen oder neu anlegen.</p>
        </div>
        <div className="pb">
          <div className="insp-row" style={{ marginBottom: 8 }}>
            <button className={mode === "existing" ? "tb-btn primary" : "tb-btn ghost"}
                    disabled={availableFields.length === 0}
                    onClick={() => setMode("existing")}>Bestehendes Feld</button>
            <button className={mode === "new" ? "tb-btn primary" : "tb-btn ghost"}
                    onClick={() => setMode("new")}>Neues Feld</button>
          </div>
          {mode === "existing" ? (
            availableFields.length === 0 ? (
              <div style={{ color: "var(--ink-3)", fontSize: 13 }}>
                Alle Payload-Felder haben schon einen Producer. Lege ein neues Feld an.
              </div>
            ) : (
              <div className="insp-field">
                <label>Payload-Feld</label>
                <select className="mono" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {availableFields.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            )
          ) : (
            <>
              <div className="insp-row">
                <div className="insp-field">
                  <label>Feldname (snake_case)</label>
                  <input autoFocus className="mono" type="text" value={fieldname}
                         onChange={(e) => setFieldname(e.target.value)} placeholder="z.B. neuer_mietvertrag" />
                  {fieldname && !validName && (
                    <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 3 }}>nur Kleinbuchstaben, Zahlen, Unterstrich, Start-Buchstabe</div>
                  )}
                  {takenNew && <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 3 }}>Feldname bereits vergeben</div>}
                </div>
                <div className="insp-field">
                  <label>Label</label>
                  <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z.B. Neuer Mietvertrag" />
                </div>
              </div>
              <div className="insp-row">
                <div className="insp-field">
                  <label>Feld-Typ</label>
                  <select value={fieldtype} onChange={(e) => setFieldtype(e.target.value)}>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="insp-field">
                  <label>Optionen</label>
                  <input type="text" value={options} onChange={(e) => setOptions(e.target.value)}
                         placeholder={fieldtype === "Link" ? "Ziel-Doctype" : "—"} />
                </div>
              </div>
            </>
          )}
        </div>
        <div className="pf">
          <button onClick={onCancel}>Abbrechen</button>
          <button className="primary" disabled={!canDeclare}
                  style={{ opacity: canDeclare ? 1 : 0.5, cursor: canDeclare ? "pointer" : "not-allowed" }}
                  onClick={() => {
                    if (mode === "existing") onDeclare(target);
                    else onDeclareNew({ fieldname: fieldname.trim(), label: label.trim(), fieldtype, options, reqd: 0, in_list_view: 0, description: "" });
                  }}>Deklarieren</button>
        </div>
      </div>
    </div>
  );
}

// ========== Add Payload-Feld dialog ==========

export function AddFieldDialog({ open, existingNames, editing, onCancel, onAdd, onSave }) {
  const isEdit = !!editing;
  const [fieldname, setFieldname] = useState("");
  const [label, setLabel] = useState("");
  const [fieldtype, setFieldtype] = useState("Data");
  const [options, setOptions] = useState("");
  const [reqd, setReqd] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setFieldname(editing.fieldname || ""); setLabel(editing.label || "");
      setFieldtype(editing.fieldtype || "Data"); setOptions(editing.options || ""); setReqd(!!editing.reqd);
    } else {
      setFieldname(""); setLabel(""); setFieldtype("Data"); setOptions(""); setReqd(false);
    }
  }, [open, editing]);

  if (!open) return null;

  const validName = /^[a-z][a-z0-9_]*$/.test(fieldname.trim());
  const taken = !isEdit && existingNames.has(fieldname.trim());
  const valid = (isEdit || (validName && !taken)) && label.trim();

  return (
    <div className="popover-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="popover" style={{ width: 460 }}>
        <div className="ph">
          <h3>{isEdit ? "Payload-Feld bearbeiten" : "Payload-Feld hinzufügen"}</h3>
          <p>Diese Felder werden je Prozess-Instanz in <code>payload_json</code> gespeichert.</p>
        </div>
        <div className="pb">
          <div className="insp-row">
            <div className="insp-field">
              <label>Feldname (snake_case)</label>
              <input
                autoFocus
                className="mono"
                type="text"
                value={fieldname}
                disabled={isEdit}
                onChange={(e) => setFieldname(e.target.value)}
                placeholder="z.B. kaution_betrag"
              />
              {fieldname && !validName && (
                <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 3 }}>nur Kleinbuchstaben, Zahlen, Unterstrich, Start-Buchstabe</div>
              )}
              {taken && <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 3 }}>Feldname bereits vergeben</div>}
            </div>
            <div className="insp-field">
              <label>Label</label>
              <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z.B. Kautionsbetrag" />
            </div>
          </div>
          <div className="insp-row">
            <div className="insp-field">
              <label>Feld-Typ</label>
              <select value={fieldtype} onChange={(e) => setFieldtype(e.target.value)}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="insp-field">
              <label>Optionen</label>
              <input
                type="text"
                value={options}
                onChange={(e) => setOptions(e.target.value)}
                placeholder={fieldtype === "Link" ? "Ziel-Doctype" : fieldtype === "Select" ? "eins\\nzwei" : "—"}
              />
            </div>
          </div>
          <div className={`insp-toggle${reqd ? " on" : ""}`} onClick={() => setReqd(!reqd)} style={{ marginTop: 6 }}>
            <span className="switch"></span>
            <span className="l">Pflichtfeld</span>
          </div>
        </div>
        <div className="pf">
          <button onClick={onCancel}>Abbrechen</button>
          <button
            className="primary"
            disabled={!valid}
            style={{ opacity: valid ? 1 : 0.5, cursor: valid ? "pointer" : "not-allowed" }}
            onClick={() => {
              if (isEdit) {
                onSave({ label: label.trim(), fieldtype, options, reqd: reqd ? 1 : 0 });
              } else {
                onAdd({
                  fieldname: fieldname.trim(), label: label.trim(), fieldtype, options,
                  reqd: reqd ? 1 : 0, in_list_view: 0, description: "",
                });
              }
            }}
          >{isEdit ? "Speichern" : "Hinzufügen"}</button>
        </div>
      </div>
    </div>
  );
}

// ========== Fields Panel (manages payload_field_specs) ==========

export function FieldsPanel({ open, fieldSpecs, io, readOnly, onClose, onPatchField, onDeleteField, onAddFieldClick }) {
  const usage = useMemo(() => {
    const m = {};
    for (const f of fieldSpecs) m[f.fieldname] = { producers: 0, consumers: 0 };
    for (const r of io) {
      if (!m[r.target]) continue;
      if (r.kind === "payload_output") m[r.target].producers += 1;
      else if (r.kind === "payload_input") m[r.target].consumers += 1;
    }
    return m;
  }, [fieldSpecs, io]);

  return (
    <aside className={`inspector${open ? "" : " closed"}`}>
      <div className="insp-header">
        <span className="insp-glyph" style={{ background: "var(--accent-soft)", color: "var(--accent)", borderColor: "color-mix(in oklch, var(--accent) 25%, transparent)" }}>F</span>
        <div className="insp-title">
          <h2>Payload-Felder</h2>
          <div className="sub">{fieldSpecs.length} Feld{fieldSpecs.length !== 1 ? "er" : ""} · Schema dieser Version</div>
        </div>
        <button className="close-x" onClick={onClose} title="Schließen">×</button>
      </div>
      <div className="insp-body">
        {!readOnly && (
          <button
            onClick={onAddFieldClick}
            style={{
              width: "100%", height: 36, marginBottom: 12,
              border: "1px dashed var(--border-strong)", borderRadius: 6,
              background: "transparent", color: "var(--ink-2)",
              fontFamily: "inherit", fontSize: 13, fontWeight: 500, cursor: "pointer",
            }}
          >+ Neues Payload-Feld</button>
        )}
        {fieldSpecs.length === 0 && (
          <div style={{ color: "var(--ink-3)", fontSize: 13, padding: "12px 0" }}>
            Noch keine Payload-Felder. Lege eins an, um es danach als Output an einem Schritt zu deklarieren.
          </div>
        )}
        {fieldSpecs.map((spec) => {
          const u = usage[spec.fieldname] || { producers: 0, consumers: 0 };
          const isExternal = u.consumers > 0 && u.producers === 0;
          return (
            <div className="field-card" key={spec.fieldname}>
              <div className="field-card-head">
                <code>{spec.fieldname}</code>
                <span style={{ flex: 1 }}></span>
                <span className="field-usage">
                  <span title="Producers (payload_output)">
                    <span className="dot prod"></span>{u.producers}
                  </span>
                  <span title="Consumers (payload_input)">
                    <span className="dot cons"></span>{u.consumers}
                  </span>
                  {isExternal && <span className="ext-badge" title="Wird gelesen, aber von keinem Schritt produziert → Process Input">EXT</span>}
                </span>
                {!readOnly && (
                  <button className="field-del" title="Feld löschen" onClick={() => onDeleteField(spec.fieldname)}>×</button>
                )}
              </div>
              <div className="insp-field">
                <label>Label</label>
                <input type="text" value={spec.label || ""} disabled={readOnly} onChange={(e) => onPatchField(spec.fieldname, { label: e.target.value })} />
              </div>
              <div className="insp-row">
                <div className="insp-field">
                  <label>Feld-Typ</label>
                  <select value={spec.fieldtype} disabled={readOnly} onChange={(e) => onPatchField(spec.fieldname, { fieldtype: e.target.value })}>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="insp-field">
                  <label>Optionen</label>
                  <input type="text" value={spec.options || ""} disabled={readOnly} onChange={(e) => onPatchField(spec.fieldname, { options: e.target.value })} placeholder={spec.fieldtype === "Link" ? "Ziel-Doctype" : "—"} />
                </div>
              </div>
              <div className="insp-row">
                <div
                  className={`insp-toggle${spec.reqd ? " on" : ""}`}
                  style={{ opacity: readOnly ? 0.6 : 1 }}
                  onClick={() => !readOnly && onPatchField(spec.fieldname, { reqd: spec.reqd ? 0 : 1 })}
                >
                  <span className="switch"></span>
                  <span className="l">Pflicht</span>
                </div>
                <div
                  className={`insp-toggle${spec.in_list_view ? " on" : ""}`}
                  style={{ opacity: readOnly ? 0.6 : 1 }}
                  onClick={() => !readOnly && onPatchField(spec.fieldname, { in_list_view: spec.in_list_view ? 0 : 1 })}
                >
                  <span className="switch"></span>
                  <span className="l">In Liste</span>
                </div>
              </div>
              <div className="insp-field">
                <label>Beschreibung</label>
                <input type="text" value={spec.description || ""} disabled={readOnly} onChange={(e) => onPatchField(spec.fieldname, { description: e.target.value })} placeholder="(optional)" />
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ========== Doc Field Mapping Dialog (create_linked_doc) ==========

export const PAYLOAD_RE = /^\{\{\s*payload\.([A-Za-z0-9_]+)\s*\}\}$/;

function parseSrc(prefillVal, hasDialogField) {
  if (hasDialogField) return { src: "manual" };
  if (prefillVal == null) return { src: "" };
  const m = String(prefillVal).match(PAYLOAD_RE);
  if (m) return { src: "input", payload: m[1] };
  return { src: "fixed", literal: prefillVal };
}

// Skip-list (matches _pe_is_settable_meta_field in prozess_version.js)
const SKIP_META_TYPES = new Set([
  "Section Break", "Column Break", "Tab Break", "HTML", "Table", "Table MultiSelect",
  "Button", "Heading", "Image", "Fold", "Geolocation", "Signature", "Barcode",
]);
function isSettableMetaField(df) {
  if (!df || !df.fieldname) return false;
  if (SKIP_META_TYPES.has(df.fieldtype)) return false;
  if (df.read_only || df.is_virtual || df.hidden) return false;
  if (["naming_series", "amended_from"].includes(df.fieldname)) return false;
  return true;
}

export function DocFieldMappingDialog({ open, cfg, payloadFields, fetchMeta, onCancel, onSave }) {
  const target = (cfg && cfg.target_doctype || "").trim();

  // Fetch meta for target doctype
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || !target) { setMeta(null); return; }
    let cancelled = false;
    setLoading(true);
    Promise.resolve(fetchMeta(target))
      .then((m) => { if (!cancelled) { setMeta(m); setLoading(false); } })
      .catch(() => { if (!cancelled) { setMeta(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [open, target, fetchMeta]);

  const settableFields = useMemo(() => {
    if (!meta || !Array.isArray(meta.fields)) return [];
    return meta.fields.filter(isSettableMetaField);
  }, [meta]);

  const initialRows = useMemo(() => {
    if (!open || !settableFields.length) return [];
    const dialogFields = Array.isArray(cfg.dialog_fields) ? cfg.dialog_fields : [];
    const dialogByFn = {};
    for (const f of dialogFields) if (f && f.fieldname) dialogByFn[f.fieldname] = f;
    const prefill = (cfg.prefill_mapping && typeof cfg.prefill_mapping === "object") ? cfg.prefill_mapping : {};
    const mapInputs = new Set(Array.isArray(cfg.map_inputs) ? cfg.map_inputs : []);
    return settableFields.map((df) => {
      const cur = parseSrc(prefill[df.fieldname], !!dialogByFn[df.fieldname]);
      // "Aus Input" gilt auch fuer noch unbelegte Ziel-Felder (in map_inputs, aber ohne prefill).
      const src = (cur.src === "" && mapInputs.has(df.fieldname)) ? "input" : cur.src;
      return {
        fieldname: df.fieldname,
        label: df.label || df.fieldname,
        fieldtype: df.fieldtype || "Data",
        reqd: !!df.reqd,
        src,
        payload: cur.payload || "",
        literal: cur.literal != null ? String(cur.literal) : "",
        originalDef: dialogByFn[df.fieldname] || {
          fieldname: df.fieldname,
          fieldtype: df.fieldtype || "Data",
          label: df.label || df.fieldname,
          ...(df.reqd ? { reqd: 1 } : {}),
          ...(df.options ? { options: df.options } : {}),
        },
      };
    });
  }, [open, cfg, settableFields]);

  const [rows, setRows] = useState([]);
  useEffect(() => { setRows(initialRows); }, [initialRows]);

  if (!open) return null;
  if (loading || !meta) {
    return (
      <div className="popover-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
        <div className="popover" style={{ width: 480 }}>
          <div className="ph">
            <h3>Feld-Mapping — <span className="mono" style={{ fontSize: 14 }}>{target || "(leer)"}</span></h3>
            <p>{loading ? "Lade Meta…" : `Ziel-Doctype ${target} nicht gefunden.`}</p>
          </div>
          <div className="pf"><button onClick={onCancel}>Schließen</button></div>
        </div>
      </div>
    );
  }

  const setRow = (idx, patch) => setRows((rs) => rs.map((r, i) => i === idx ? { ...r, ...patch } : r));

  const save = () => {
    const dialog_fields = [];
    const prefill_mapping = {};
    const map_inputs = [];
    const orig = (cfg.prefill_mapping && typeof cfg.prefill_mapping === "object") ? cfg.prefill_mapping : {};
    for (const r of rows) {
      if (r.src === "manual") {
        // Manuell = reine User-Eingabe zur Laufzeit -> KEIN Payload-Prefill und damit KEIN
        // Input. Ein evtl. altes {{ payload.X }} (z.B. nach Umschalten von "Aus Input")
        // wird bewusst verworfen, sonst gilt das Feld faelschlich weiter als payload_input.
        dialog_fields.push(r.originalDef);
      } else if (r.src === "input") {
        // "Aus Input" -> Input-Port am Knoten; Quelle wird per Drag belegt (nicht hier).
        // Bestehende Belegung ({{ payload.X }}) erhalten.
        map_inputs.push(r.fieldname);
        if (r.fieldname in orig) prefill_mapping[r.fieldname] = orig[r.fieldname];
      } else if (r.src === "fixed" && r.literal !== "") {
        prefill_mapping[r.fieldname] = r.literal;
      }
    }
    onSave({ ...cfg, dialog_fields, prefill_mapping, map_inputs });
  };

  return (
    <div className="popover-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="popover" style={{ width: "min(1100px, 92vw)", maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
        <div className="ph">
          <h3>Feld-Mapping — <span className="mono" style={{ fontWeight: 500, fontSize: 14 }}>{target}</span></h3>
          <p>Pro Ziel-Feld die Quelle wählen: aus Input (Port am Knoten, per Drag belegen), manuell zur Laufzeit, oder fester Wert.</p>
        </div>
        <div className="pb" style={{ overflow: "auto", flex: 1 }}>
          <table className="mapping-table">
            <thead>
              <tr>
                <th>Ziel-Feld</th>
                <th style={{ width: 130 }}>Quelle</th>
                <th style={{ width: 240 }}>Wert</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={r.fieldname}>
                  <td>
                    <div className="mapping-cell-target">
                      <span className="mtl">{r.label}{r.reqd && <span className="reqd">*</span>}</span>
                      <span className="mtb"><code>{r.fieldname}</code> <span className="mtype">{r.fieldtype}</span></span>
                    </div>
                  </td>
                  <td>
                    <select className="mapping-src" value={r.src} onChange={(e) => setRow(idx, { src: e.target.value })}>
                      <option value="">—</option>
                      <option value="input">Aus Input</option>
                      <option value="manual">Manuell</option>
                      <option value="fixed">Fest</option>
                    </select>
                  </td>
                  <td>
                    {r.src === "input" && (
                      r.payload
                        ? <span style={{ fontSize: 12 }}>Input-Port belegt mit <code>{r.payload}</code></span>
                        : <span className="muted" style={{ fontSize: 12 }}>Input-Port am Knoten — Quelle dort hinziehen</span>
                    )}
                    {r.src === "fixed" && (
                      <input className="mapping-val" type="text" value={r.literal} onChange={(e) => setRow(idx, { literal: e.target.value })} placeholder="Literal-Wert" />
                    )}
                    {r.src === "manual" && (
                      <span className="muted" style={{ fontSize: 12 }}>User-Eingabe zur Laufzeit</span>
                    )}
                    {r.src === "" && <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 12, fontSize: 11.5 }}>
            <strong>Aus Input:</strong> erzeugt einen Input-Port am Knoten; die Quelle ziehst du im
            Canvas auf diesen Port.
            &nbsp;<strong>Manuell:</strong> User gibt zur Laufzeit ein.
            &nbsp;<strong>Fest:</strong> fester Literal-Wert.
          </p>
        </div>
        <div className="pf">
          <button onClick={onCancel}>Abbrechen</button>
          <button className="primary" onClick={save}>Übernehmen</button>
        </div>
      </div>
    </div>
  );
}

// ========== Legend ==========

export function Legend() {
  return (
    <div className="legend">
      <span className="legend-item">
        <span className="legend-line data"></span>
        Daten (liest Wert)
      </span>
      <span className="legend-item">
        <span className="legend-line order"></span>
        Reihenfolge (kommt nach)
      </span>
      <span className="legend-item">
        <span className="legend-line trigger"></span>
        Trigger (Start-Schritt)
      </span>
      <span className="legend-item">
        <span className="legend-dot ext"></span>
        Input ungenutzt (extern)
      </span>
    </div>
  );
}
