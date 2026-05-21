# Process Editor — React-Bundle Integration

Drop-in zum bestehenden `process_engine`-App. Ersetzt den Drawflow-Editor in
`prozess_version.js` durch das React-Bundle.

## Verzeichnis-Struktur (im Repo)

```
process_engine/
├── process_engine/                              ← App-Code
│   ├── public/
│   │   ├── js/
│   │   │   └── process_editor_react.bundle.js  ← Build-Output (esbuild)
│   │   └── css/
│   │       └── process_editor_react.css        ← Build-Output (copy)
│   └── doctype/prozess_version/prozess_version.js  ← anpassen (siehe unten)
└── src_react/                                   ← Source (dieses Verzeichnis)
    ├── package.json
    ├── build.mjs
    ├── index.jsx
    ├── editor-shell.jsx
    ├── editor-node.jsx
    ├── editor-edges.jsx
    ├── editor-panels.jsx
    ├── data.js
    └── styles.css
```

## Build

```bash
cd src_react
npm install
npm run build          # einmaliges Production-Bundle
# oder
npm run watch          # während Entwicklung
```

Das Output landet automatisch in `../process_engine/public/{js,css}/`.

## Was im Repo committen

- **`src_react/`** komplett (außer `node_modules/`)
- **`process_engine/public/js/process_editor_react.bundle.js`** (committen, damit
  Bench-Deploys ohne Node-Build funktionieren)
- **`process_engine/public/css/process_editor_react.css`**

Wenn deine CI Node hat, kannst du den Build alternativ als Pre-Deploy-Step laufen
lassen und das Bundle aus `.gitignore` ausschließen — sonst einfach mit-committen.

## Anpassung von `prozess_version.js`

Ersetze die bestehende `_render_visual_editor`-Funktion durch:

```javascript
async function _render_visual_editor(frm) {
	const field = frm.get_field("editor_html");
	if (!field) return;
	const is_locked = _is_version_locked(frm);

	await new Promise((r) =>
		frappe.require("/assets/process_engine/js/process_editor_react.bundle.js", r)
	);
	await _loadCssOnce("/assets/process_engine/css/process_editor_react.css");

	// Reset wrapper, prepare a sized container for React
	field.$wrapper.empty();
	const container = document.createElement("div");
	container.style.cssText =
		"position: relative; height: 800px; border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden;";
	field.$wrapper.append(container);

	window.ProcessEditorReact.mount(container, {
		// ---- Data ----
		schritte: frm.doc.schritte || [],
		schritt_io: frm.doc.schritt_io || [],
		payload_field_specs: frm.doc.payload_field_specs || [],

		// ---- Metadata ----
		versionLabel: frm.doc.titel || frm.doc.name,
		versionKey: frm.doc.version_key || "",
		isActive: !!frm.doc.is_active,
		prozess_typ: frm.doc.prozess_typ || "",
		read_only: is_locked,

		// Frappe form — durchgereicht an Custom-Config-Widgets, die via
		// window.process_engine.register_config_widget(name, fn) registriert sind.
		frm: frm,

		// ---- Mutations: bridge to frappe.model ----
		onPatchStep(step_key, patch) {
			const row = (frm.doc.schritte || []).find((r) => (r.step_key || "").trim() === step_key);
			if (!row) return;
			for (const [k, v] of Object.entries(patch)) {
				frappe.model.set_value(row.doctype, row.name, k, v);
			}
		},
		onAddStep(spec) {
			const existing = new Set((frm.doc.schritte || []).map((r) => r.step_key));
			if (existing.has(spec.step_key)) {
				frappe.msgprint(__("Step Key bereits vergeben: {0}", [spec.step_key]));
				return;
			}
			const row = frappe.model.add_child(frm.doc, "Prozess Schritt", "schritte");
			Object.assign(row, spec);
			frm.refresh_field("schritte");
			frm.dirty();
			_render_dag_preview(frm);
			_render_visual_editor(frm);
		},
		onDeleteStep(step_key) {
			// Re-uses your existing cascade logic
			_delete_step(frm, null, step_key);
			_render_visual_editor(frm);
		},
		onAddIO(spec) {
			const exists = (frm.doc.schritt_io || []).some(
				(r) => r.step_key === spec.step_key && r.kind === spec.kind && r.target === spec.target
			);
			if (exists) return;
			const row = frappe.model.add_child(frm.doc, "Prozess Schritt IO", "schritt_io");
			row.step_key = spec.step_key;
			row.kind = spec.kind;
			row.target = spec.target;
			frm.refresh_field("schritt_io");
			frm.dirty();
			_render_dag_preview(frm);
			_render_visual_editor(frm);
		},
		onRemoveIO(spec) {
			frm.doc.schritt_io = (frm.doc.schritt_io || []).filter(
				(r) => !(r.step_key === spec.step_key && r.kind === spec.kind && r.target === spec.target)
			);
			frm.refresh_field("schritt_io");
			frm.dirty();
			_render_dag_preview(frm);
			_render_visual_editor(frm);
		},
		onPatchField(fieldname, patch) {
			const row = (frm.doc.payload_field_specs || []).find(
				(r) => (r.fieldname || "").trim() === fieldname
			);
			if (!row) return;
			for (const [k, v] of Object.entries(patch)) {
				frappe.model.set_value(row.doctype, row.name, k, v);
			}
		},
		onDeleteField(fieldname) {
			// Cascade into schritt_io
			frm.doc.payload_field_specs = (frm.doc.payload_field_specs || []).filter(
				(r) => (r.fieldname || "").trim() !== fieldname
			);
			frm.doc.schritt_io = (frm.doc.schritt_io || []).filter(
				(r) => !((r.kind === "payload_input" || r.kind === "payload_output") && r.target === fieldname)
			);
			frm.refresh_field("payload_field_specs");
			frm.refresh_field("schritt_io");
			frm.dirty();
			_render_dag_preview(frm);
			_render_visual_editor(frm);
		},
		onAddField(spec) {
			const existing = new Set((frm.doc.payload_field_specs || []).map((r) => r.fieldname));
			if (existing.has(spec.fieldname)) {
				frappe.msgprint(__("Feldname bereits vergeben: {0}", [spec.fieldname]));
				return;
			}
			const row = frappe.model.add_child(frm.doc, "Prozess Field Spec", "payload_field_specs");
			Object.assign(row, spec);
			frm.refresh_field("payload_field_specs");
			frm.dirty();
			_render_visual_editor(frm);
		},

		// ---- Server calls ----
		async fetchMeta(doctype) {
			await frappe.model.with_doctype(doctype);
			return frappe.get_meta(doctype) || { fields: [] };
		},
		async fetchSchema(task_type, handler_key) {
			const r = await frappe.call({
				method: "process_engine.process_engine.doctype.prozess_version.prozess_version.get_task_config_schema",
				args: { prozess_typ: frm.doc.prozess_typ, task_type, handler_key },
			});
			return r.message;
		},

		// ---- UX integration ----
		onToast(msg, kind) {
			frappe.show_alert({ message: msg, indicator: kind === "err" ? "red" : "blue" }, 3);
		},
	});
}
```

## Workflow

```bash
# Beim Code-Ändern in src_react/:
npm run build

git add process_engine/public/js/process_editor_react.bundle.js \
        process_engine/public/css/process_editor_react.css \
        src_react/
git commit -m "Update process editor bundle"
git push

# Im Bench:
bench --site <SITE> clear-cache
# Hard-Reload im Browser (Cmd+Shift+R)
```

## Hinweise

- **Re-Mount nach Mutation:** der Bridge ruft nach jedem Add/Delete `_render_visual_editor(frm)`
  erneut auf. React reconciles — kein voller Reset, lokaler UI-State
  (Selektion, Pan/Zoom) bleibt erhalten. Wenn das zu chatty wird, kannst du
  Position-Updates aus `onPatchStep` rausfiltern und nur ein finales Re-render
  triggern.
- **Lock-Modus:** wenn `read_only={true}` ist, ignoriert App alle Mutations-Callbacks
  client-seitig. Doppelte Sicherheit zusätzlich zum Server-Lock in
  `_enforce_active_immutability`.
- **PI-Position** ist UI-only. Wenn du sie persistieren willst, schick sie als
  Prop rein und reagiere auf einen zusätzlichen Callback (z.B. einen verstecktes
  Custom-Feld auf Prozess Version).
- **Tweaks** (Edge-Style, Density, Grid, Labels) sind aktuell hardcoded als Props
  in der `_render_visual_editor`. Wenn du sie aus einem Tweaks-Panel füttern
  willst, gib sie als zusätzliche Props mit.

## Custom Config-Widgets

Eingebaute Widgets im Bundle: `control` (generisches Frappe-Control), `payload_field_select`,
`doc_field_mapping`. Alles andere wird gegen die globale Registry `window.process_engine.config_widgets`
aufgelöst — derselbe Mechanismus wie in deinem bestehenden `prozess_version.js`.

```python
# Server: Handler nennt das Widget
class MyTaskHandler(BaseTaskHandler):
    def config_schema(self):
        return {"fields": [
            {"key": "zielfeld", "label": "Zielfeld",
             "widget": "mw_target_field_select", "reqd": 1},
        ]}
```

```javascript
// Client (App-Bundle, vor oder nach dem Editor-Bundle geladen):
window.process_engine = window.process_engine || {};
window.process_engine.config_widgets = window.process_engine.config_widgets || new Map();
window.process_engine.register_config_widget = function (name, fn) {
    window.process_engine.config_widgets.set(name, fn);
};

window.process_engine.register_config_widget("mw_target_field_select", function (ctx) {
    const { frm, def, container, commit } = ctx;
    const ctrl = frappe.ui.form.make_control({
        df: { fieldname: def.key, label: def.label, fieldtype: "Select",
              options: ["", "neue_adresse_altmieter_erfasst", "zaehler_geprueft"].join("\n") },
        parent: $("<div>").appendTo(container).get(0),
        render_input: true,
    });
    ctrl.set_value(ctx.cfg[def.key] || "");
    ctrl.$input.on("change", () => commit(def.key, ctrl.get_value()));
});
```

Der Editor übergibt jedem Widget folgenden Kontext:

| Key | Wert |
|---|---|
| `frm` | Das Frappe-Form-Objekt der Prozess Version (aus dem `mount(container, {frm})`-Aufruf) |
| `row` | Der aktuelle Schritt (`step`-Objekt mit `step_key`, `task_type`, `konfig_json`, …) |
| `def` | Die Feld-Definition aus `config_schema().fields[*]` (`key`, `label`, `fieldtype`, `widget`, …) |
| `cfg` | Live-Getter auf die aktuelle Config (geparst aus `konfig_json`) |
| `container` | DOM-Element, in das das Widget rendern soll. Wird beim Re-Render geleert. |
| `readOnly` | `true` wenn die Version gelockt ist |
| `commit(key, value)` | Schreibt einen Wert zurück: aktualisiert `konfig_json` über den Bridge → `frappe.model.set_value` |

**Wichtig:** Widgets, die `frappe.ui.form.make_control` benutzen, brauchen das `frm`-Objekt
(insb. für Link-Felder mit Filtern). Stelle sicher, dass es im `mount()`-Aufruf mitgegeben wird
(siehe Bridge-Snippet oben).

Ist ein Widget-Name nicht registriert, zeigt der Editor eine warnende Inline-Box mit
Widget-Namen + dem Hinweis „App-Bundle muss `register_config_widget(...)` aufrufen". Daten
gehen nie verloren — der „JSON"-Button öffnet immer den vollen Raw-Editor.
