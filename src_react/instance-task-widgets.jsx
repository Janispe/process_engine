// instance-task-widgets.jsx — Bespoke Aktions-UIs pro task_type (ESM).
//
// Vertrag: jede Komponente bekommt
//   { step, statusRec, version, payload, onComplete, helpers? }
//
// `helpers` kommt aus dem `mount()`-Aufruf der Bridge. Erwartete Form:
//   helpers = {
//     getMeta(doctype) → { fields: [...] } | undefined
//     mailTemplates    → { [name]: { subject, body } }
//   }
//
// App-Code (außerhalb des Bundles) registriert eigene Widgets via
//   window.process_engine.register_task_action_widget(task_type, Component)
// — siehe index-instance.jsx, das die Registry an window spiegelt.

import React, { useState, useRef, useMemo } from "react";
import { fmtDateTime, fmtPayloadValue } from "./instance-data.js";

// ---------- Registry (module-level) ----------------------------------------

const REGISTRY = new Map();

export function registerTaskActionWidget(task_type, Component) {
  REGISTRY.set(task_type, Component);
}
export function getTaskActionWidget(task_type) {
  return REGISTRY.get(task_type) || null;
}
export const taskActionRegistry = REGISTRY;

// ---------- Shared bits -----------------------------------------------------

function cfgOf(step) {
  try { return JSON.parse(step.konfig_json || "{}"); } catch { return {}; }
}

function ActionFooter({ children }) {
  return (
    <div className="td-footer" style={{ marginLeft: -14, marginRight: -14, marginBottom: -14, marginTop: 14 }}>
      {children}
    </div>
  );
}

function TemplateBody({ value, onChange, payload, readOnly }) {
  const re = /\{\{\s*payload\.(\w+)\s*\}\}/g;
  const parts = [];
  let last = 0, m, s = value;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ t: s.slice(last, m.index) });
    const name = m[1];
    const has = payload[name] != null && payload[name] !== "";
    parts.push({ token: true, name, has, raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ t: s.slice(last) });

  return (
    <div className="mail-body">
      <pre aria-hidden="true" className="mail-body-shadow">
        {parts.map((p, i) =>
          p.token ? (
            <span key={i} className={`tok${p.has ? " ok" : " miss"}`}>{p.raw}</span>
          ) : (
            <span key={i}>{p.t}</span>
          )
        )}
        {value.endsWith("\n") ? "\n" : null}
      </pre>
      <textarea
        className="mail-body-input"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ============================================================================
// MANUAL_CHECK
// ============================================================================

export function ManualCheckWidget({ step, version, payload, onComplete }) {
  const [checked, setChecked] = useState(false);
  const myOutputs = version.schritt_io.filter(
    (r) => r.step_key === step.step_key && r.kind === "payload_output"
  );
  const specByName = Object.fromEntries(version.payload_field_specs.map((f) => [f.fieldname, f]));
  const [outVals, setOutVals] = useState(() => {
    const o = {};
    for (const r of myOutputs) o[r.target] = payload[r.target] ?? "";
    return o;
  });

  return (
    <>
      {myOutputs.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="td-section-h">Output dieses Schritts</div>
          {myOutputs.map((r) => {
            const spec = specByName[r.target] || { fieldtype: "Data", label: r.target };
            return (
              <div key={r.target} style={{ marginBottom: 8 }}>
                <label style={{ display: "block", fontSize: 11, color: "var(--ink-3)", marginBottom: 3 }}>
                  {spec.label} <code style={{ fontFamily: "var(--font-mono)", color: "var(--ink-4)" }}>{r.target}</code>
                </label>
                {spec.fieldtype === "Check" ? (
                  <div
                    className={`act-checkbox${outVals[r.target] ? " checked" : ""}`}
                    onClick={() => setOutVals((o) => ({ ...o, [r.target]: o[r.target] ? 0 : 1 }))}
                  >
                    <div className="box">{outVals[r.target] ? "✓" : ""}</div>
                    <div className="l">Bestätigt</div>
                  </div>
                ) : spec.fieldtype === "Small Text" || spec.fieldtype === "Long Text" ? (
                  <textarea
                    className="act-textarea"
                    value={outVals[r.target] || ""}
                    onChange={(e) => setOutVals((o) => ({ ...o, [r.target]: e.target.value }))}
                    placeholder={spec.description || "Eintrag…"}
                  />
                ) : (
                  <input
                    className="act-input"
                    type="text"
                    value={outVals[r.target] || ""}
                    onChange={(e) => setOutVals((o) => ({ ...o, [r.target]: e.target.value }))}
                    placeholder={spec.description || ""}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="td-section-h">Bestätigung</div>
      <div
        className={`act-checkbox${checked ? " checked" : ""}`}
        onClick={() => setChecked((c) => !c)}
      >
        <div className="box">{checked ? "✓" : ""}</div>
        <div className="l">
          Schritt erledigt
          <div className="h">{step.titel} ist abgeschlossen.</div>
        </div>
      </div>

      <ActionFooter>
        <button className="btn ghost">Notiz hinzufügen</button>
        <div className="spacer"></div>
        <button
          className="btn success"
          disabled={!checked}
          onClick={() => onComplete({ outputs: outVals })}
        >
          <span className="glyph">✓</span>
          Erledigt
        </button>
      </ActionFooter>
    </>
  );
}

// ============================================================================
// FILE_UPLOAD
// ============================================================================

export function FileUploadWidget({ step, statusRec, version, payload, onComplete }) {
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const myOutput = version.schritt_io.find(
    (r) => r.step_key === step.step_key && r.kind === "payload_output"
  );
  const existing = myOutput ? payload[myOutput.target] : null;
  const cfg = cfgOf(step);

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  }

  return (
    <>
      <div className="upload-meta">
        <span className="meta-pill">
          <span className="dot"></span>
          {step.dokument_typ_tag || "Dokument"}
        </span>
        {cfg.accept && <span className="meta-mono">akzeptiert {cfg.accept}</span>}
        {cfg.max_size_mb && <span className="meta-mono">max {cfg.max_size_mb} MB</span>}
      </div>

      {existing && !file ? (
        <div className="upload-existing">
          <div className="file-pill-lg">
            <div className="ico">PDF</div>
            <div className="meta">
              <strong>{existing}</strong>
              <small>hochgeladen am {fmtDateTime(statusRec.erledigt_am)}</small>
            </div>
            <div className="acts">
              <button className="iconbtn" title="Vorschau">👁</button>
              <button className="iconbtn" title="Herunterladen">↓</button>
              <button className="iconbtn" title="Ersetzen" onClick={() => fileRef.current?.click()}>↻</button>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6, textAlign: "center" }}>
            Eine neue Datei hochladen ersetzt die bestehende. Audit-Verlauf bleibt erhalten.
          </div>
        </div>
      ) : (
        <div
          className={`drop-zone${dragOver ? " over" : ""}${file ? " has-file" : ""}`}
          onClick={() => !file && fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {file ? (
            <div className="drop-staged">
              <div className="ico">{file.name.split(".").pop()?.toUpperCase().slice(0, 4) || "FILE"}</div>
              <div className="meta">
                <strong>{file.name}</strong>
                <small>{(file.size / 1024).toFixed(0)} KB · bereit zum Hochladen</small>
              </div>
              <button className="iconbtn" title="Entfernen" onClick={(e) => { e.stopPropagation(); setFile(null); }}>×</button>
            </div>
          ) : (
            <>
              <div className="dz-glyph">⇪</div>
              <div className="dz-h">{dragOver ? "Loslassen zum Hochladen" : "Datei hierher ziehen"}</div>
              <div className="dz-s">oder klicken zum Auswählen</div>
            </>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        style={{ display: "none" }}
        accept={cfg.accept || ""}
        onChange={(e) => setFile(e.target.files?.[0] || null)}
      />

      <ActionFooter>
        <button className="btn ghost">Notiz</button>
        <div className="spacer"></div>
        <button
          className="btn success"
          disabled={!file && !existing}
          onClick={() => onComplete({ file, filename: file?.name || existing })}
        >
          <span className="glyph">⇧</span>
          Hochladen & Erledigen
        </button>
      </ActionFooter>
    </>
  );
}

// ============================================================================
// PRINT_DOCUMENT
// ============================================================================

export function PrintDocumentWidget({ step, version, payload, onComplete }) {
  const cfg = cfgOf(step);
  const [fmt, setFmt] = useState(cfg.print_format || step.print_format || "");
  const [copies, setCopies] = useState(1);

  const myInputs = version.schritt_io.filter(
    (r) => r.step_key === step.step_key && r.kind === "payload_input"
  );
  const specByName = Object.fromEntries(version.payload_field_specs.map((f) => [f.fieldname, f]));

  return (
    <>
      <div className="print-preview">
        <div className="pp-paper">
          <div className="pp-corner">{fmt || "Print Format"}</div>
          <div className="pp-h">{(step.dokument_typ_tag || "dokument").replace(/_/g, " ").toUpperCase()}</div>
          <div className="pp-rule"></div>
          {myInputs.slice(0, 4).map((r) => {
            const spec = specByName[r.target];
            const val = fmtPayloadValue(payload[r.target], spec);
            return (
              <div key={r.target} className="pp-row">
                <span>{spec?.label || r.target}</span>
                <strong>{val ?? "—"}</strong>
              </div>
            );
          })}
          <div className="pp-rule short"></div>
          <div className="pp-sig">
            <div className="line"></div>
            <span>Unterschrift</span>
          </div>
        </div>
        <div className="pp-aside">
          <div className="pp-aside-row">
            <span className="l">Format</span>
            <input
              className="act-input"
              type="text"
              value={fmt}
              onChange={(e) => setFmt(e.target.value)}
              placeholder="Print Format Name"
            />
          </div>
          <div className="pp-aside-row">
            <span className="l">Kopien</span>
            <div className="copies">
              <button onClick={() => setCopies((c) => Math.max(1, c - 1))}>−</button>
              <span>{copies}</span>
              <button onClick={() => setCopies((c) => Math.min(9, c + 1))}>+</button>
            </div>
          </div>
          <div className="pp-aside-row">
            <span className="l">Seitenformat</span>
            <span className="v mono">A4 · Hochformat</span>
          </div>
        </div>
      </div>

      <ActionFooter>
        <button className="btn ghost">
          <span className="glyph">👁</span>
          Vorschau
        </button>
        <button className="btn">
          <span className="glyph">↓</span>
          PDF speichern
        </button>
        <div className="spacer"></div>
        <button className="btn primary" onClick={() => onComplete({ print_format: fmt, copies })}>
          <span className="glyph">⎙</span>
          Jetzt drucken
        </button>
      </ActionFooter>
    </>
  );
}

// ============================================================================
// PYTHON_ACTION
// ============================================================================

export function PythonActionWidget({ step, version, payload, onComplete }) {
  const cfg = cfgOf(step);
  const [log, setLog] = useState(null);
  const [running, setRunning] = useState(false);

  const myInputs = version.schritt_io.filter(
    (r) => r.step_key === step.step_key && r.kind === "payload_input"
  );

  function runDry() {
    setRunning(true);
    setLog(["Starte Trockenlauf …"]);
    const lines = [
      `> python_action.run(dry_run=True)`,
      `[INFO] handler_key = ${step.handler_key}`,
      `[INFO] step_key    = ${step.step_key}`,
      "[INFO] reading payload inputs:",
      ...myInputs.map((r) => {
        const v = payload[r.target];
        return `  · ${r.target.padEnd(20)} = ${v == null ? "null" : JSON.stringify(v)}`;
      }),
      "[INFO] config:",
      ...Object.entries(cfg).map(([k, v]) => `  · ${k.padEnd(20)} = ${JSON.stringify(v)}`),
      "[ OK ] Trockenlauf erfolgreich. Keine Schreiboperation ausgeführt.",
    ];
    let i = 0;
    const tick = () => {
      i++;
      setLog(lines.slice(0, i));
      if (i < lines.length) setTimeout(tick, 70);
      else setRunning(false);
    };
    setTimeout(tick, 200);
  }

  return (
    <>
      <div className="py-handler">
        <div className="py-handler-l">
          <div className="py-handler-h">Handler</div>
          <code className="py-handler-name">{step.handler_key || "(nicht gesetzt)"}</code>
        </div>
        <div className="py-handler-r">
          <div className="py-handler-h">Konfiguration</div>
          {Object.keys(cfg).length === 0 ? (
            <span style={{ color: "var(--ink-3)", fontSize: 12, fontStyle: "italic" }}>(keine)</span>
          ) : (
            <div className="py-cfg-list">
              {Object.entries(cfg).map(([k, v]) => (
                <div key={k} className="py-cfg-row">
                  <span className="k">{k}</span>
                  <span className="v">{JSON.stringify(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="terminal">
        <div className="terminal-bar">
          <span className="t-dot r"></span>
          <span className="t-dot y"></span>
          <span className="t-dot g"></span>
          <span className="t-title">stdout · {step.handler_key}</span>
        </div>
        <div className="terminal-body">
          {log == null ? (
            <span className="t-muted">— „Trockenlauf" drücken um die Eingaben zu prüfen —</span>
          ) : (
            log.map((l, i) => {
              const lvl = l.startsWith("[ OK ]") ? "ok"
                : l.startsWith("[INFO]") ? "info"
                : l.startsWith("[ERR") ? "err"
                : l.startsWith(">") ? "prompt" : "plain";
              return <div key={i} className={`t-line t-${lvl}`}>{l}</div>;
            })
          )}
          {running && <div className="t-line t-info t-blink">█</div>}
        </div>
      </div>

      <ActionFooter>
        <button className="btn ghost" onClick={runDry} disabled={running}>
          <span className="glyph">▶</span>
          Trockenlauf
        </button>
        <div className="spacer"></div>
        <button
          className="btn primary"
          onClick={() => onComplete({})}
          disabled={running}
        >
          <span className="glyph">λ</span>
          Handler ausführen
        </button>
      </ActionFooter>
    </>
  );
}

// ============================================================================
// PAPERLESS_EXPORT
// ============================================================================

export function PaperlessExportWidget({ step, version, payload, onComplete }) {
  const cfg = cfgOf(step);
  const tag = cfg.dokument_typ_tag || step.dokument_typ_tag || "dokument";

  const sourceInput = version.schritt_io.find(
    (r) => r.step_key === step.step_key && r.kind === "payload_input"
  );
  const filename = sourceInput ? payload[sourceInput.target] : null;

  return (
    <>
      <div className="paperless-route">
        <div className="pr-end source">
          <div className="pr-icon">PDF</div>
          <div className="pr-meta">
            <strong>{filename || "(keine Datei)"}</strong>
            <small>aus Payload <code>{sourceInput?.target}</code></small>
          </div>
        </div>

        <div className="pr-arrow">
          <span></span>
          <em>Paperless-ngx</em>
        </div>

        <div className="pr-end dest">
          <div className="pr-icon" style={{ background: "oklch(96% 0.06 200)", color: "oklch(40% 0.13 200)", borderColor: "oklch(70% 0.13 200)" }}>📥</div>
          <div className="pr-meta">
            <strong>Archiv</strong>
            <small>paperless.intern</small>
          </div>
        </div>
      </div>

      <div className="paperless-tags">
        <div className="td-section-h">Tags & Metadaten</div>
        <div className="tag-grid">
          <span className="tag-chip primary">
            <span className="k">document_type</span>
            <span className="v">{tag}</span>
          </span>
          <span className="tag-chip">
            <span className="k">prozess</span>
            <span className="v">{version.prozess_typ}</span>
          </span>
          {payload.wohnung_id && (
            <span className="tag-chip">
              <span className="k">wohnung</span>
              <span className="v">{payload.wohnung_id}</span>
            </span>
          )}
          <span className="tag-chip">
            <span className="k">jahr</span>
            <span className="v">{new Date().getFullYear()}</span>
          </span>
        </div>
      </div>

      <ActionFooter>
        <button className="btn ghost">Tags anpassen</button>
        <div className="spacer"></div>
        <button className="btn primary" disabled={!filename} onClick={() => onComplete({})}>
          <span className="glyph">→</span>
          Zu Paperless senden
        </button>
      </ActionFooter>
    </>
  );
}

// ============================================================================
// EMAIL_DRAFT
// ============================================================================

const DEFAULT_TEMPLATES = {
  welcome_de: {
    subject: "Willkommen in Ihrer neuen Wohnung",
    body: `Sehr geehrte/r Frau/Herr,

herzlich willkommen in Ihrem neuen Zuhause in der {{ payload.wohnung_id }}.

Anbei senden wir Ihnen den unterschriebenen Mietvertrag sowie die Übergabe-Unterlagen.

Bei Fragen erreichen Sie uns jederzeit per Mail oder unter +49 30 1234-567.

Herzliche Grüße
Ihre Hausverwaltung`,
  },
};

export function EmailDraftWidget({ step, version, payload, onComplete, helpers }) {
  const cfg = cfgOf(step);
  const templates = (helpers && helpers.mailTemplates) || DEFAULT_TEMPLATES;
  const tpl = templates[cfg.template] || { subject: cfg.subject || "", body: "" };
  const [subject, setSubject] = useState(cfg.subject || tpl.subject || "");
  const [body, setBody] = useState(tpl.body || "");

  const recipientField = cfg.recipient_field;
  const recipientDoc = recipientField ? payload[recipientField] : null;

  const attachments = [];
  for (const r of version.schritt_io) {
    if (r.kind === "payload_output") {
      const spec = version.payload_field_specs.find((f) => f.fieldname === r.target);
      if (spec?.fieldtype === "Data" && /pdf|file/i.test(r.target) && payload[r.target]) {
        attachments.push({ name: payload[r.target], from: r.step_key });
      }
    }
  }

  return (
    <>
      <div className="mail-frame">
        <div className="mail-hdr">
          <div className="mail-row">
            <span className="l">An</span>
            <div className="v">
              {recipientDoc ? (
                <span className="mail-recipient">
                  <span className="avatar">{String(recipientDoc).slice(0, 2).toUpperCase()}</span>
                  <span>
                    <strong>{recipientDoc}</strong>
                    <small>aus <code>{recipientField}</code></small>
                  </span>
                </span>
              ) : (
                <span className="mail-recipient miss">
                  <span className="avatar">?</span>
                  <span>
                    <strong>(nicht aufgelöst)</strong>
                    <small>Payload-Feld <code>{recipientField}</code> ist leer</small>
                  </span>
                </span>
              )}
            </div>
          </div>
          <div className="mail-row">
            <span className="l">Betreff</span>
            <input
              className="mail-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
        </div>

        <TemplateBody value={body} onChange={setBody} payload={payload} readOnly={false} />

        {attachments.length > 0 && (
          <div className="mail-attach">
            <div className="ma-h">Anhänge</div>
            {attachments.map((a, i) => (
              <div key={i} className="ma-item">
                <span className="ico">PDF</span>
                <span className="name">{a.name}</span>
                <small>aus {a.from}</small>
              </div>
            ))}
          </div>
        )}

        <div className="mail-foot">
          <span className="mail-template">Vorlage: <code>{cfg.template || "—"}</code></span>
          <span className="mail-vars">
            <span className="dot ok"></span>aufgelöst &nbsp;
            <span className="dot miss"></span>fehlend
          </span>
        </div>
      </div>

      <ActionFooter>
        <button className="btn ghost">Vorschau</button>
        <button className="btn">Entwurf speichern</button>
        <div className="spacer"></div>
        <button
          className="btn primary"
          disabled={!recipientDoc || !subject.trim()}
          onClick={() => onComplete({ subject, body })}
        >
          <span className="glyph">✉</span>
          Entwurf erstellen & senden
        </button>
      </ActionFooter>
    </>
  );
}

// ============================================================================
// CREATE_LINKED_DOC
// ============================================================================

export function CreateLinkedDocWidget({ step, version, payload, onComplete, helpers }) {
  const cfg = cfgOf(step);
  const getMeta = (helpers && helpers.getMeta) || (() => ({ fields: [] }));
  const meta = getMeta(cfg.target_doctype) || { fields: [] };

  const initial = useMemo(() => {
    const v = {};
    for (const f of meta.fields) v[f.fieldname] = "";
    for (const f of cfg.dialog_fields || []) v[f.fieldname] = "";
    for (const [k, tmpl] of Object.entries(cfg.prefill_mapping || {})) {
      const m = String(tmpl).match(/\{\{\s*payload\.(\w+)\s*\}\}/);
      v[k] = m ? (payload[m[1]] ?? "") : tmpl;
    }
    return v;
  }, []);
  const [vals, setVals] = useState(initial);

  const dialogKeys = new Set((cfg.dialog_fields || []).map((d) => d.fieldname));
  const mappedKeys = new Set(Object.keys(cfg.prefill_mapping || {}));

  const visibleFields = meta.fields.filter(
    (f) => dialogKeys.has(f.fieldname) || mappedKeys.has(f.fieldname) || f.reqd
  );

  const initials = (vals.name1 || vals.fullname || vals.email || "—")
    .toString().split(/[ @]/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  const reqdMissing = (cfg.dialog_fields || []).some((f) => f.reqd && !vals[f.fieldname]);

  return (
    <>
      <div className="cld-split">
        <div className="cld-form">
          <div className="td-section-h">Neuer {cfg.target_doctype}</div>
          {visibleFields.map((f) => {
            const isDialog = dialogKeys.has(f.fieldname);
            const isMapped = mappedKeys.has(f.fieldname);
            return (
              <div key={f.fieldname} className="cld-field">
                <label>
                  <span>{f.label || f.fieldname}{f.reqd && <span className="reqd">*</span>}</span>
                  <span className={`cld-src ${isMapped ? "mapped" : isDialog ? "input" : ""}`}>
                    {isMapped ? "← Mapping" : isDialog ? "Eingabe" : ""}
                  </span>
                </label>
                <input
                  className={`act-input${isMapped ? " mono" : ""}`}
                  type="text"
                  value={vals[f.fieldname] || ""}
                  onChange={(e) => setVals((v) => ({ ...v, [f.fieldname]: e.target.value }))}
                  disabled={!isDialog && !isMapped}
                  placeholder={f.fieldtype === "Link" ? `(${f.options})` : ""}
                  readOnly={isMapped}
                  style={isMapped ? { background: "var(--accent-soft)", borderColor: "color-mix(in oklch, var(--accent) 25%, var(--border))" } : {}}
                />
              </div>
            );
          })}
        </div>

        <div className="cld-preview">
          <div className="td-section-h">Vorschau</div>
          <div className="cld-card">
            <div className="cld-card-h">
              <div className="cld-avatar">{initials || "—"}</div>
              <div className="cld-card-title">
                <strong>{vals.name1 || vals.fullname || vals.email || <em style={{ color: "var(--ink-3)" }}>Neu</em>}</strong>
                <small>{cfg.target_doctype}</small>
              </div>
              <span className="cld-card-badge">neu</span>
            </div>
            <div className="cld-card-body">
              {meta.fields
                .filter((f) => vals[f.fieldname])
                .slice(0, 6)
                .map((f) => (
                  <div key={f.fieldname} className="cld-card-row">
                    <span className="k">{f.label}</span>
                    <span className="v">{vals[f.fieldname]}</span>
                  </div>
                ))}
            </div>
            <div className="cld-card-foot">
              gespeichert in Payload-Feld <code>{cfg.store_in_payload_field}</code>
            </div>
          </div>
        </div>
      </div>

      <ActionFooter>
        <button className="btn ghost">Existierenden verlinken</button>
        <div className="spacer"></div>
        <button
          className="btn primary"
          disabled={reqdMissing}
          onClick={() => onComplete({ created: vals })}
        >
          <span className="glyph">+</span>
          {cfg.target_doctype} anlegen
        </button>
      </ActionFooter>
    </>
  );
}

// ---------- Register built-ins ---------------------------------------------

registerTaskActionWidget("manual_check",      ManualCheckWidget);
registerTaskActionWidget("file_upload",       FileUploadWidget);
registerTaskActionWidget("print_document",    PrintDocumentWidget);
registerTaskActionWidget("python_action",     PythonActionWidget);
registerTaskActionWidget("paperless_export",  PaperlessExportWidget);
registerTaskActionWidget("email_draft",       EmailDraftWidget);
registerTaskActionWidget("create_linked_doc", CreateLinkedDocWidget);
