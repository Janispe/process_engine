// instance-shell.jsx — Top-level App für die Prozess-Instanz-Ansicht (ESM).
//
// Bekommt seine Daten als Props vom Bridge-Code (prozess_instanz.js), der
// `mount(container, props)` aufruft.
//
// Erwartete Props:
//   instance          — die geladene Prozess Instanz (frm.doc)
//   version           — die zugehörige Prozess Version (Schritte + I/O + Field-Specs)
//   statusMap         — { [step_key]: { status, verantwortlich, faelligkeit_am, erledigt_am, kommentar } }
//   payload           — { [fieldname]: value }
//   density           — "compact" | "comfortable"   (optional, default "comfortable")
//   layout            — "split" | "graph-first" | "tasks-first"  (optional, default "split")
//
// Callbacks (Bridge schreibt zurück in frappe.model):
//   onCompleteStep(stepKey, data) → Promise<{ statusMap, payload, events }>
//   helpers           — Frei wählbare Hilfsobjekte für Widgets:
//                       { getMeta(doctype), mailTemplates, fetchMeta, frm, ... }

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { InstanceGraph } from "./instance-graph.jsx";
import { TaskPane } from "./instance-tasks.jsx";
import {
  STEP_STATUS,
  statusStyle,
  computeFortschritt,
  recomputeReadiness,
  fmtDue,
  fmtDateTime,
  getProcessInputFields,
} from "./instance-data.js";

const PI_W = 220;

function StatusPill({ status }) {
  return (
    <span className={`inst-status-pill ${status}`}>
      <span className="dot"></span>
      <span>{status[0].toUpperCase() + status.slice(1)}</span>
    </span>
  );
}

function InstHeader({ instance, version, fortschritt, statusCounts, instanceStatus, onOpenVersion }) {
  const subjLabel = instance.subject?.label || instance.subject?.name || instance.name;
  const subjL2Parts = [];
  if (instance.subject?.altmieter) subjL2Parts.push(instance.subject.altmieter);
  if (instance.subject?.neumieter_intended) subjL2Parts.push(instance.subject.neumieter_intended);
  const sub2 = subjL2Parts.join(" → ");
  const uebergabe = instance.subject?.uebergabe_geplant
    ? new Date(instance.subject.uebergabe_geplant).toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" })
    : null;

  return (
    <header className="inst-header">
      <div className="brand">
        <div className="brand-mark"></div>
        <div className="brand-name">Process Engine <small>· Instanz</small></div>
      </div>

      <div className="inst-subject">
        <div className="subj-l1">
          <span>{subjLabel}</span>
          <span className="pi-id">{instance.name}</span>
        </div>
        {(sub2 || uebergabe) && (
          <div className="subj-l2">
            {sub2}
            {sub2 && uebergabe && <span className="arrow">·</span>}
            {uebergabe && <>Übergabe {uebergabe}</>}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }}></div>

      <div className="inst-due">
        <span>Nächste Fälligkeit</span>
        <strong>{statusCounts.nextDue || "—"}</strong>
      </div>

      <div className="inst-progress">
        <div className="meta">
          <span>Fortschritt</span>
          <strong>{statusCounts.done} / {version.schritte.length} · {fortschritt}%</strong>
        </div>
        <div className="bar"><div className="fill" style={{ width: fortschritt + "%" }}></div></div>
      </div>

      <StatusPill status={instanceStatus} />

      {onOpenVersion && (
        <button
          title="Prozess Version öffnen"
          className="btn ghost"
          style={{ height: 32, padding: "0 11px" }}
          onClick={onOpenVersion}
        >
          <span style={{ fontSize: 12 }}>↗</span>
          Version
        </button>
      )}
    </header>
  );
}

export function InstanceApp(props) {
  const {
    version,
    instance: instanceProp,
    statusMap: statusMapProp,
    payload: payloadProp,
    density = "comfortable",
    layout = "split",
    helpers,
    onCompleteStep,
    onOpenVersion,
  } = props;

  // We mirror the props in local state so the App can show the result of an
  // optimistic completion before the bridge round-trip lands. The bridge can
  // then call back with the canonical state via onCompleteStep's returned
  // value.
  const [instance, setInstance] = useState(instanceProp);
  const [statusMap, setStatusMap] = useState(statusMapProp || {});
  const [payload, setPayload] = useState(payloadProp || {});

  // Keep local copies in sync if parent re-renders with new props.
  useEffect(() => setInstance(instanceProp), [instanceProp]);
  useEffect(() => setStatusMap(statusMapProp || {}), [statusMapProp]);
  useEffect(() => setPayload(payloadProp || {}), [payloadProp]);

  const [selectedKey, setSelectedKey] = useState(() => {
    const m = statusMapProp || {};
    for (const p of ["in_progress", "ready"]) {
      const k = Object.keys(m).find((sk) => m[sk]?.status === p);
      if (k) return k;
    }
    return null;
  });

  // PI fields + position
  const piFields = useMemo(
    () => getProcessInputFields(version.schritt_io, version.payload_field_specs),
    [version.schritt_io, version.payload_field_specs]
  );
  const piPosition = useMemo(() => {
    if (!version.schritte.length) return { x: 0, y: 0 };
    const minX = Math.min(...version.schritte.map((s) => s.editor_x || 0));
    const minY = Math.min(...version.schritte.map((s) => s.editor_y || 0));
    return { x: minX - (PI_W + 80), y: minY };
  }, [version.schritte]);

  const fortschritt = useMemo(() => computeFortschritt(statusMap), [statusMap]);

  const statusCounts = useMemo(() => {
    const out = { done: 0, ready: 0, in_progress: 0, blocked: 0, pending: 0, nextDue: null };
    let nextDate = null, nextLabel = null;
    for (const sk of Object.keys(statusMap)) {
      const rec = statusMap[sk];
      out[rec.status] = (out[rec.status] || 0) + 1;
      if (rec.status === "ready" || rec.status === "in_progress") {
        if (rec.faelligkeit_am) {
          const d = new Date(rec.faelligkeit_am);
          if (!nextDate || d < nextDate) {
            nextDate = d;
            const step = version.schritte.find((s) => s.step_key === sk);
            nextLabel = `${fmtDue(rec.faelligkeit_am)} · ${step?.titel || sk}`;
          }
        }
      }
    }
    out.nextDue = nextLabel;
    return out;
  }, [statusMap, version.schritte]);

  // Complete handler: optimistically apply, then let bridge persist.
  const handleComplete = useCallback(async (stepKey, data = {}) => {
    // Optimistic local update — bridge can overwrite with canonical state if it
    // returns one.
    let newStatus = statusMap, newPayload = payload, newEvents = instance.events || [];
    const step = version.schritte.find((s) => s.step_key === stepKey);
    const rec = statusMap[stepKey];
    if (step && rec) {
      newStatus = {
        ...statusMap,
        [stepKey]: { ...rec, status: "done", erledigt_am: new Date().toISOString().slice(0, 19) },
      };
      newPayload = { ...payload };
      const outputs = version.schritt_io.filter(
        (r) => r.step_key === stepKey && r.kind === "payload_output"
      );
      for (const o of outputs) {
        if (data.outputs && data.outputs[o.target] !== undefined) {
          newPayload[o.target] = data.outputs[o.target];
        } else if (data.filename) {
          newPayload[o.target] = data.filename;
        } else if (data.created) {
          newPayload[o.target] = `${(() => { try { return JSON.parse(step.konfig_json || "{}").target_doctype || "Doc"; } catch { return "Doc"; } })()}-${Date.now().toString(36)}`;
        } else if (newPayload[o.target] == null) {
          newPayload[o.target] = `${o.target}_filled`;
        }
      }
      newStatus = recomputeReadiness(version, newStatus, newPayload);
      newEvents = [
        ...newEvents,
        {
          ts: new Date().toISOString().slice(0, 19),
          who: rec.verantwortlich?.name || "User",
          what: `Schritt „${step.titel}" erledigt.`,
        },
      ];
      setStatusMap(newStatus);
      setPayload(newPayload);
      setInstance((i) => ({ ...i, events: newEvents }));
    }

    // Auto-advance selection
    const nextReady = version.schritte.find(
      (s) => newStatus[s.step_key]?.status === "ready" || newStatus[s.step_key]?.status === "in_progress"
    );
    if (nextReady) setSelectedKey(nextReady.step_key);

    // Notify bridge (Frappe). The bridge does the server round-trip and may
    // return canonical state; if so, we re-sync.
    if (onCompleteStep) {
      try {
        const result = await onCompleteStep(stepKey, data);
        if (result) {
          if (result.statusMap) setStatusMap(result.statusMap);
          if (result.payload)   setPayload(result.payload);
          if (result.events)    setInstance((i) => ({ ...i, events: result.events }));
        }
      } catch (err) {
        // Roll back? For now: just log; user sees the optimistic state. The
        // bridge should `frappe.show_alert` on its own.
        console.error("onCompleteStep failed:", err);
      }
    }
  }, [statusMap, payload, instance, version, onCompleteStep]);

  const layoutClass =
    layout === "tasks-first" ? "layout-tasks" :
    layout === "graph-first" ? "layout-graph" : "layout-split";

  return (
    <div className={`inst-app${density === "compact" ? " density-compact" : ""}`}>
      <InstHeader
        instance={instance}
        version={version}
        fortschritt={fortschritt}
        statusCounts={statusCounts}
        instanceStatus={instance.status || "laufend"}
        onOpenVersion={onOpenVersion}
      />

      <div className={`inst-ws ${layoutClass}`}>
        <div className="pane left">
          <InstanceGraph
            version={version}
            statusMap={statusMap}
            payload={payload}
            selectedKey={selectedKey}
            onSelectStep={(k) => setSelectedKey(k)}
            density={density}
            piPosition={piPosition}
            piFields={piFields}
            edgeMode="all"
          />
        </div>
        <div className="pane right">
          <TaskPane
            version={version}
            statusMap={statusMap}
            payload={payload}
            instance={instance}
            selectedKey={selectedKey}
            onSelectStep={(k) => setSelectedKey(k)}
            onComplete={handleComplete}
            helpers={helpers}
          />
        </div>
      </div>

      <div className="statusbar">
        <span className="stat"><strong>{statusCounts.done || 0}</strong> erledigt</span>
        <span className="sep">·</span>
        <span className="stat"><strong>{statusCounts.ready || 0}</strong> bereit</span>
        <span className="sep">·</span>
        <span className="stat"><strong>{statusCounts.in_progress || 0}</strong> in Bearbeitung</span>
        <span className="sep">·</span>
        <span className="stat"><strong>{statusCounts.pending || 0}</strong> wartend</span>
        {statusCounts.blocked ? <>
          <span className="sep">·</span>
          <span className="stat" style={{ color: "var(--danger)" }}><strong>{statusCounts.blocked}</strong> blockiert</span>
        </> : null}
        <div className="spacer"></div>
        <span className="stat">{instance.name} · {version.version_key}</span>
      </div>
    </div>
  );
}
