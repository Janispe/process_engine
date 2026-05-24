// Static constants + format helpers for the instance UI. No SEED data —
// the App receives schritt_status / payload / events as props (see
// index-instance.jsx → ProcessInstanceReact.mount).

// ---------- Status tokens (UI) ---------------------------------------------

export const STEP_STATUS = {
  pending:     { label: "Wartend",        hue: 60,  chroma: 0,    glyph: "·", order: 5 },
  ready:       { label: "Bereit",         hue: 245, chroma: 0.13, glyph: "▶", order: 1 },
  in_progress: { label: "In Bearbeitung", hue: 60,  chroma: 0.13, glyph: "◐", order: 2 },
  done:        { label: "Erledigt",       hue: 150, chroma: 0.13, glyph: "✓", order: 4 },
  blocked:     { label: "Blockiert",      hue: 25,  chroma: 0.16, glyph: "!", order: 3 },
  failed:      { label: "Fehlgeschlagen", hue: 25,  chroma: 0.18, glyph: "×", order: 3 },
  skipped:     { label: "Übersprungen",   hue: 60,  chroma: 0,    glyph: "/", order: 6 },
};

export function statusStyle(status) {
  const st = STEP_STATUS[status] || STEP_STATUS.pending;
  if (st.chroma === 0) {
    return {
      "--st-fg":     "oklch(45% 0 0)",
      "--st-soft":   "oklch(95.5% 0.004 80)",
      "--st-border": "oklch(82% 0.008 80)",
      "--st-ring":   "oklch(82% 0.008 80 / 0.35)",
    };
  }
  return {
    "--st-fg":     `oklch(45% ${st.chroma} ${st.hue})`,
    "--st-soft":   `oklch(96% ${Math.min(st.chroma * 0.32, 0.04)} ${st.hue})`,
    "--st-border": `oklch(78% ${st.chroma * 0.55} ${st.hue})`,
    "--st-ring":   `oklch(78% ${st.chroma * 0.55} ${st.hue} / 0.4)`,
  };
}

// ---------- Helpers --------------------------------------------------------

export function computeFortschritt(statusMap) {
  const vals = Object.values(statusMap || {});
  if (!vals.length) return 0;
  const done = vals.filter((r) => r.status === "done" || r.status === "skipped").length;
  return Math.round((done / vals.length) * 100);
}

// Berechnet den Status eines Schritts aufgrund seiner Abhängigkeiten:
// - alle payload_input-Felder sind im payload != null/empty
// - alle step_input-Vorgänger sind "done"
// Wenn pending/blocked + Bedingungen erfüllt → "ready".
export function recomputeReadiness(version, statusMap, payload) {
  const next = { ...statusMap };
  for (const s of version.schritte) {
    const r = next[s.step_key];
    if (!r) continue;
    if (r.status !== "pending" && r.status !== "blocked") continue;
    const myInputs = (version.schritt_io || []).filter(
      (io) => io.step_key === s.step_key && io.kind === "payload_input"
    );
    const allDataOk = myInputs.every((io) => payload[io.target] != null && payload[io.target] !== "");
    const myStepIns = (version.schritt_io || []).filter(
      (io) => io.step_key === s.step_key && io.kind === "step_input"
    );
    const allStepsOk = myStepIns.every((io) => next[io.target]?.status === "done");
    if (allDataOk && allStepsOk) next[s.step_key] = { ...r, status: "ready" };
  }
  return next;
}

// Formats an ISO date relative to `today` (DE).
export function fmtDue(iso, today = new Date()) {
  if (!iso) return "—";
  const d = new Date(iso);
  const ms = d - today;
  const dayMs = 24 * 3600 * 1000;
  const diff = Math.round(ms / dayMs);
  if (diff < 0) return `vor ${Math.abs(diff)} Tag${Math.abs(diff) === 1 ? "" : "en"}`;
  if (diff === 0) return "heute";
  if (diff === 1) return "morgen";
  if (diff < 7)   return `in ${diff} Tagen`;
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }) +
    " · " +
    d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

export function fmtPayloadValue(value, fieldspec) {
  if (value === null || value === undefined || value === "") return null;
  if (!fieldspec) return String(value);
  switch (fieldspec.fieldtype) {
    case "Check":
      return value ? "Ja" : "Nein";
    case "Currency":
      return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(value);
    case "Date":
    case "Datetime":
      return new Date(value).toLocaleDateString("de-DE");
    default:
      return String(value);
  }
}

// Sammelt Felder, die als payload_input deklariert sind aber von keinem Schritt
// als payload_output erzeugt werden — das sind die Process Inputs (extern).
export function getProcessInputFields(schritt_io, fieldSpecs) {
  const producer = new Set();
  for (const r of schritt_io || []) if (r.kind === "payload_output") producer.add(r.target);
  const consumers = new Set();
  for (const r of schritt_io || []) if (r.kind === "payload_input") consumers.add(r.target);
  const known = new Set((fieldSpecs || []).map((f) => f.fieldname));
  return [...consumers].filter((f) => !producer.has(f) && (known.size === 0 || known.has(f)));
}
