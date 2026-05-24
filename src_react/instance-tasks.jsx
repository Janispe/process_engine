// instance-tasks.jsx — Aufgaben-Panel + Detail + Aktions-UI-Wrapper (ESM).
//
// Props:
//   version, statusMap, payload, instance — Daten
//   selectedKey, onSelectStep              — Auswahl
//   onComplete(stepKey, data)              — wird vom Detail beim Erledigen aufgerufen
//   density                                — "compact" | "comfortable"
//   helpers                                — Bridge-Helpers (an Widgets weitergereicht)

import React, { useState, useMemo, useRef } from "react";
import { TASK_TYPES } from "./data.js";
import { STEP_STATUS, statusStyle, fmtDue, fmtDateTime, fmtPayloadValue } from "./instance-data.js";
import { getTaskActionWidget } from "./instance-task-widgets.jsx";

function ttStyleInst(taskType) {
  const tt = TASK_TYPES[taskType];
  if (!tt) {
    return { "--tt-soft": "var(--surface-2)", "--tt-fg": "var(--ink-2)", "--tt-border": "var(--border)" };
  }
  if (tt.chroma === 0) {
    return {
      "--tt-soft":   "oklch(95% 0 0)",
      "--tt-fg":     "oklch(40% 0 0)",
      "--tt-border": "oklch(82% 0 0)",
    };
  }
  return {
    "--tt-soft":   `oklch(96% ${Math.min(tt.chroma * 0.32, 0.04)} ${tt.hue})`,
    "--tt-fg":     `oklch(45% ${tt.chroma} ${tt.hue})`,
    "--tt-border": `oklch(78% ${tt.chroma * 0.55} ${tt.hue})`,
  };
}

function dueClassFor(rec, today = new Date()) {
  if (!rec || !rec.faelligkeit_am) return "";
  const d = new Date(rec.faelligkeit_am);
  if (d < today) return "overdue";
  if (d.toDateString() === today.toDateString()) return "today";
  return "";
}

// ---------- Task Card ------------------------------------------------------

function TaskCard({ step, statusRec, selected, onSelect }) {
  const tt = TASK_TYPES[step.task_type] || { glyph: "?", label: step.task_type };
  const st = STEP_STATUS[statusRec.status] || STEP_STATUS.pending;
  const stStyle = statusStyle(statusRec.status);
  const due = fmtDue(statusRec.faelligkeit_am);
  const dueCls = dueClassFor(statusRec);

  return (
    <div
      className={`tc s-${statusRec.status}${selected ? " selected" : ""}`}
      style={{ ...stStyle, ...ttStyleInst(step.task_type) }}
      onClick={() => onSelect(step.step_key)}
    >
      <div className="tc-head">
        <div className="tc-glyph">{tt.glyph}</div>
        <div className="tc-title">{step.titel}</div>
        <div className="tc-stat">
          <span className="glyph">{st.glyph}</span>
          <span>{st.label}</span>
        </div>
      </div>
      <div className="tc-meta">
        <span className="avatar" title={statusRec.verantwortlich?.name}>
          {statusRec.verantwortlich?.initials || "?"}
        </span>
        <span className="who">{statusRec.verantwortlich?.name}</span>
        <span className="sep">·</span>
        <span className="tt-chip">{tt.label}</span>
        <span className="sep">·</span>
        <span className={`due ${dueCls}`}>
          {statusRec.status === "done"
            ? `erledigt ${fmtDue(statusRec.erledigt_am)}`
            : `fällig ${due}`}
        </span>
        {step.pflicht ? (
          <>
            <span className="sep">·</span>
            <span className="pflicht-dot" title="Pflicht-Schritt"></span>
            <span style={{ color: "var(--warn)", fontSize: 11, fontWeight: 600 }}>Pflicht</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------- I/O table ------------------------------------------------------

function IOTable({ step, version, payload }) {
  const myInputs = version.schritt_io.filter(
    (r) => r.step_key === step.step_key && r.kind === "payload_input"
  );
  const myOutputs = version.schritt_io.filter(
    (r) => r.step_key === step.step_key && r.kind === "payload_output"
  );
  const producer = {};
  for (const r of version.schritt_io) if (r.kind === "payload_output") producer[r.target] = r.step_key;
  const specByName = Object.fromEntries(version.payload_field_specs.map((f) => [f.fieldname, f]));

  if (!myInputs.length && !myOutputs.length) return null;
  return (
    <table className="io-table">
      <thead>
        <tr>
          <th style={{ width: "40%" }}>Feld</th>
          <th>Wert</th>
          <th style={{ width: "32%" }}>Quelle</th>
        </tr>
      </thead>
      <tbody>
        {myInputs.map((r) => {
          const spec = specByName[r.target];
          const val = fmtPayloadValue(payload[r.target], spec);
          const p = producer[r.target];
          const fulfilled = payload[r.target] != null && payload[r.target] !== "";
          return (
            <tr key={`in:${r.target}`}>
              <td className="fld" title={spec?.label || r.target}>← {r.target}</td>
              <td className={`val${val == null ? " empty" : ""}`}>{val == null ? "—" : val}</td>
              <td className="src">
                {p ? (
                  <span className={fulfilled ? "src-ok" : "src-miss"}>
                    {fulfilled ? "✓" : "·"} {p}
                  </span>
                ) : (
                  <span className={fulfilled ? "src-pi" : "src-miss"}>
                    {fulfilled ? "✓" : "·"} Process Input
                  </span>
                )}
              </td>
            </tr>
          );
        })}
        {myOutputs.map((r) => {
          const spec = specByName[r.target];
          const val = fmtPayloadValue(payload[r.target], spec);
          return (
            <tr key={`out:${r.target}`}>
              <td className="fld" title={spec?.label || r.target}>→ {r.target}</td>
              <td className={`val${val == null ? " empty" : ""}`}>
                {val == null ? "(noch nicht erzeugt)" : val}
              </td>
              <td className="src" style={{ color: "var(--ink-3)" }}>Output</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------- Task Detail ----------------------------------------------------

function TaskDetail({ step, statusRec, version, payload, onComplete, helpers }) {
  const tt = TASK_TYPES[step.task_type] || { glyph: "?", label: step.task_type };
  const st = STEP_STATUS[statusRec.status] || STEP_STATUS.pending;
  const Action = getTaskActionWidget(step.task_type);
  const stStyle = statusStyle(statusRec.status);
  const dueCls = dueClassFor(statusRec);

  const producer = {};
  for (const r of version.schritt_io) if (r.kind === "payload_output") producer[r.target] = r.step_key;
  const myInputs = version.schritt_io.filter(
    (r) => r.step_key === step.step_key && r.kind === "payload_input"
  );
  const missing = myInputs.filter((r) => payload[r.target] == null || payload[r.target] === "");
  const blocked = statusRec.status === "pending" && missing.length > 0;

  return (
    <div className="td" style={{ ...ttStyleInst(step.task_type), ...stStyle }}>
      <div className="td-head">
        <div className="glyph">{tt.glyph}</div>
        <div className="title">
          <h3>{step.titel}</h3>
          <div className="sub">{step.step_key} · {tt.label}</div>
        </div>
        <div className="stat">
          <span>{st.glyph}</span>
          <span>{st.label}</span>
        </div>
      </div>

      <div className="td-meta">
        <div className="cell">
          <div className="l">Verantwortlich</div>
          <div className="v">
            <span className="avatar">{statusRec.verantwortlich?.initials}</span>
            {statusRec.verantwortlich?.name}
            <span style={{ color: "var(--ink-3)", fontSize: 11 }}>· {statusRec.verantwortlich?.rolle}</span>
          </div>
        </div>
        <div className="cell">
          <div className="l">Fällig</div>
          <div className={`v ${dueCls}`}>
            {statusRec.status === "done"
              ? `erledigt am ${fmtDateTime(statusRec.erledigt_am)}`
              : fmtDue(statusRec.faelligkeit_am)}
            {statusRec.status !== "done" && statusRec.faelligkeit_am && (
              <span style={{ color: "var(--ink-3)", fontSize: 11 }}>
                · {new Date(statusRec.faelligkeit_am).toLocaleDateString("de-DE", { day: "2-digit", month: "long" })}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="td-action">
        {(() => {
          const hasIo = version.schritt_io.some(
            (r) => r.step_key === step.step_key && (r.kind === "payload_input" || r.kind === "payload_output")
          );
          if (!hasIo) return null;
          return (
            <div style={{ marginBottom: 14 }}>
              <div className="td-section-h">Daten</div>
              <IOTable step={step} version={version} payload={payload} />
            </div>
          );
        })()}

        {blocked ? (
          <div style={{
            padding: 14,
            background: "var(--warn-soft)",
            border: "1px solid color-mix(in oklch, var(--warn) 28%, transparent)",
            borderRadius: 8,
            color: "var(--ink-2)",
            fontSize: 13,
          }}>
            <div style={{ fontWeight: 600, color: "var(--warn)", marginBottom: 4 }}>
              Wartet auf Vorgänger
            </div>
            <div>
              Diese Aufgabe wird verfügbar, sobald folgende Felder befüllt sind:
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {missing.map((r) => {
                  const p = producer[r.target];
                  return (
                    <li key={r.target}>
                      <code style={{ fontFamily: "var(--font-mono)", color: "var(--ink)" }}>{r.target}</code>
                      {p ? <> · aus <strong>{p}</strong></> : <> · <span style={{ color: "var(--accent)" }}>Process Input</span></>}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        ) : statusRec.status === "done" ? (
          <div style={{
            padding: 14,
            background: "oklch(97% 0.04 150)",
            border: "1px solid color-mix(in oklch, var(--ok) 28%, transparent)",
            borderRadius: 8,
            color: "var(--ink-2)",
            fontSize: 13,
          }}>
            <div style={{ fontWeight: 600, color: "var(--ok)", marginBottom: 4 }}>✓ Erledigt</div>
            <div>
              {statusRec.verantwortlich?.name} · {fmtDateTime(statusRec.erledigt_am)}
              {statusRec.kommentar && (
                <div style={{ marginTop: 6, fontStyle: "italic", color: "var(--ink-3)" }}>
                  „{statusRec.kommentar}"
                </div>
              )}
            </div>
          </div>
        ) : Action ? (
          <Action
            step={step}
            statusRec={statusRec}
            version={version}
            payload={payload}
            helpers={helpers}
            onComplete={(data) => onComplete(step.step_key, data)}
          />
        ) : (
          <div style={{ color: "var(--ink-3)", fontSize: 13 }}>
            Keine Aktion definiert für <code>{step.task_type}</code>. Registriere ein Widget über{" "}
            <code>window.process_engine.register_task_action_widget(...)</code>.
          </div>
        )}

        {statusRec.kommentar && statusRec.status !== "done" && (
          <div style={{
            marginTop: 12,
            padding: 9, background: "var(--surface-2)",
            borderRadius: 6, border: "1px solid var(--border)",
            fontSize: 12, color: "var(--ink-2)",
            fontStyle: "italic",
          }}>
            „{statusRec.kommentar}"
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- All-steps view -------------------------------------------------

function AllStepsView({ version, statusMap, groupBy, selectedKey, onSelectStep }) {
  const groups = useMemo(() => {
    if (groupBy === "order") {
      const sorted = [...version.schritte].sort((a, b) => (a.reihenfolge || 0) - (b.reihenfolge || 0));
      return [{ key: "all", label: "Schritte in Reihenfolge", steps: sorted }];
    }
    if (groupBy === "role") {
      const m = {};
      for (const s of version.schritte) {
        const rec = statusMap[s.step_key] || {};
        const r = rec.verantwortlich?.rolle || "—";
        (m[r] = m[r] || []).push(s);
      }
      return Object.entries(m).map(([k, v]) => ({ key: k, label: k, steps: v }));
    }
    const order = ["in_progress", "ready", "blocked", "failed", "pending", "done", "skipped"];
    const m = {};
    for (const s of version.schritte) {
      const rec = statusMap[s.step_key] || { status: "pending" };
      (m[rec.status] = m[rec.status] || []).push(s);
    }
    return order.filter((k) => m[k] && m[k].length).map((k) => ({
      key: k,
      label: STEP_STATUS[k]?.label || k,
      steps: m[k],
    }));
  }, [version.schritte, statusMap, groupBy]);

  return (
    <>
      {groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 14 }}>
          <div className="tp-section-h">
            {g.label}
            <span className="count">{g.steps.length}</span>
          </div>
          <div className="tp-step-list">
            {g.steps.map((s) => {
              const rec = statusMap[s.step_key] || { status: "pending" };
              const st = STEP_STATUS[rec.status] || STEP_STATUS.pending;
              const stStyle = statusStyle(rec.status);
              const due = fmtDue(rec.faelligkeit_am);
              return (
                <div
                  key={s.step_key}
                  className={`tp-step-row s-${rec.status}${selectedKey === s.step_key ? " selected" : ""}`}
                  style={stStyle}
                  onClick={() => onSelectStep(s.step_key)}
                >
                  <span className="order">{s.reihenfolge}</span>
                  <span className="glyph" title={st.label}>{st.glyph}</span>
                  <span className="ttl">
                    {s.titel}
                    <small>{rec.verantwortlich?.name || "—"} · {s.task_type}</small>
                  </span>
                  <span className="right">
                    {rec.status === "done" ? `✓ ${fmtDue(rec.erledigt_am)}` : due}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------- Task pane (main) -----------------------------------------------

export function TaskPane({
  version, statusMap, payload, instance,
  selectedKey, onSelectStep, onComplete,
  helpers,
}) {
  const [tab, setTab] = useState("ready");
  const [groupBy, setGroupBy] = useState("status");

  const cats = useMemo(() => {
    const m = {};
    for (const s of version.schritte) {
      const rec = statusMap[s.step_key] || { status: "pending" };
      (m[rec.status] = m[rec.status] || []).push(s);
    }
    return m;
  }, [version.schritte, statusMap]);

  const readySteps = [...(cats.in_progress || []), ...(cats.ready || [])];
  const blockedSteps = [...(cats.blocked || []), ...(cats.failed || [])];

  const selectedStep = selectedKey ? version.schritte.find((s) => s.step_key === selectedKey) : null;
  const selectedRec = selectedKey ? (statusMap[selectedKey] || { status: "pending" }) : null;

  return (
    <div className="tp">
      <div className="tp-tabs">
        <button className={`tp-tab${tab === "ready" ? " active" : ""}`} onClick={() => setTab("ready")}>
          Jetzt zu tun
          <span className="cnt">{readySteps.length}</span>
        </button>
        <button className={`tp-tab${tab === "all" ? " active" : ""}`} onClick={() => setTab("all")}>
          Alle Schritte
          <span className="cnt">{version.schritte.length}</span>
        </button>
        <button className={`tp-tab${tab === "history" ? " active" : ""}`} onClick={() => setTab("history")}>
          Verlauf
          <span className="cnt">{(instance.events || []).length}</span>
        </button>
        <div style={{ flex: 1 }}></div>
        {blockedSteps.length > 0 && tab === "ready" && (
          <button className="tp-tab danger" onClick={() => setTab("all")} style={{ marginRight: 8 }}>
            Blockiert
            <span className="cnt">{blockedSteps.length}</span>
          </button>
        )}
      </div>

      <div className="tp-body">
        {tab === "ready" && (
          <>
            {readySteps.length === 0 ? (
              <div className="tp-empty">
                <div className="h">Nichts zu tun 🎯</div>
                <div className="s">
                  Alle bereit-stehenden Schritte sind erledigt — entweder wartet die Instanz auf einen
                  Vorgänger oder sie ist abgeschlossen.
                </div>
              </div>
            ) : (
              <>
                <div className="tp-section-h">
                  Bereit
                  <span className="count">{readySteps.length}</span>
                </div>
                {readySteps.map((s) => (
                  <TaskCard
                    key={s.step_key}
                    step={s}
                    statusRec={statusMap[s.step_key]}
                    selected={selectedKey === s.step_key}
                    onSelect={onSelectStep}
                  />
                ))}
              </>
            )}

            {selectedStep && (statusMap[selectedKey].status === "ready" || statusMap[selectedKey].status === "in_progress") && (
              <div style={{ marginTop: 12 }}>
                <div className="tp-section-h">Detail</div>
                <TaskDetail
                  step={selectedStep}
                  statusRec={selectedRec}
                  version={version}
                  payload={payload}
                  onComplete={onComplete}
                  helpers={helpers}
                />
              </div>
            )}
          </>
        )}

        {tab === "all" && (
          <>
            <div className="tp-controls" style={{ marginLeft: -14, marginRight: -14, marginTop: -12, marginBottom: 8 }}>
              <span className="l">Gruppieren:</span>
              <button className={`tp-chip${groupBy === "status" ? " active" : ""}`} onClick={() => setGroupBy("status")}>Status</button>
              <button className={`tp-chip${groupBy === "role" ? " active" : ""}`} onClick={() => setGroupBy("role")}>Rolle</button>
              <button className={`tp-chip${groupBy === "order" ? " active" : ""}`} onClick={() => setGroupBy("order")}>Reihenfolge</button>
            </div>

            <AllStepsView
              version={version}
              statusMap={statusMap}
              groupBy={groupBy}
              selectedKey={selectedKey}
              onSelectStep={onSelectStep}
            />

            {selectedStep && (
              <div style={{ marginTop: 14 }}>
                <TaskDetail
                  step={selectedStep}
                  statusRec={selectedRec}
                  version={version}
                  payload={payload}
                  onComplete={onComplete}
                  helpers={helpers}
                />
              </div>
            )}
          </>
        )}

        {tab === "history" && (
          <>
            <div className="tp-section-h">Audit-Verlauf</div>
            <div className="ev-list">
              {[...(instance.events || [])].reverse().map((ev, i) => (
                <div className="ev-row" key={i}>
                  <span className="ev-ts">{fmtDateTime(ev.ts)}</span>
                  <span className="ev-body">
                    <span className="who">{ev.who}</span>
                    {ev.what}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
