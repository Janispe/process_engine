# Process Instance Viewer — React-Bundle Integration

Drop-in zum bestehenden `process_engine`-App. Rendert die Sicht eines Sachbearbeiters
auf eine laufende **Prozess Instanz** (DAG-Status + „Jetzt zu tun"-Liste +
Aktions-UI pro `task_type`).

Parallel zum Editor-Bundle (`process_editor_react.bundle.js`) — beide werden
aus `src_react/` gebaut.

## Verzeichnis-Struktur (im Repo)

```
process_engine/
├── process_engine/
│   ├── public/
│   │   ├── js/
│   │   │   ├── process_editor_react.bundle.js     ← (vorhandener Editor)
│   │   │   └── process_instance_react.bundle.js   ← NEU
│   │   └── css/
│   │       ├── process_editor_react.css           ← (vorhandener Editor)
│   │       └── process_instance_react.css         ← NEU
│   └── doctype/prozess_instanz/prozess_instanz.js ← NEU oder anpassen
└── src_react/
    ├── package.json
    ├── build.mjs                       ← baut jetzt BEIDE Bundles
    ├── styles.css                      ← gemeinsame Tokens
    ├── instance.css                    ← NEU: Instanz-spezifische Styles
    ├── index.jsx                       ← Editor-Mount
    ├── index-instance.jsx              ← NEU: Instanz-Mount
    ├── editor-*.jsx, data.js           ← (Editor unverändert)
    ├── instance-data.js                ← NEU: Status-Tokens + Helpers
    ├── instance-graph.jsx              ← NEU
    ├── instance-task-widgets.jsx       ← NEU
    ├── instance-tasks.jsx              ← NEU
    └── instance-shell.jsx              ← NEU
```

## Build

```bash
cd src_react
npm install
npm run build          # baut Editor + Instance in einem Lauf
# oder
npm run watch          # watch-Modus für Development
```

`build.mjs` produziert pro Target:
- `process_engine/public/js/process_{editor,instance}_react.bundle.js`
- `process_engine/public/css/process_{editor,instance}_react.css`

Die Instance-CSS ist die Konkatenation von `styles.css` + `instance.css`, damit
deine App nur **eine** Datei einbinden muss.

## Was im Repo committen

- **`src_react/`** komplett (außer `node_modules/`)
- **Beide bundle.js**:
  `process_engine/public/js/process_editor_react.bundle.js`
  `process_engine/public/js/process_instance_react.bundle.js`
- **Beide css**:
  `process_engine/public/css/process_editor_react.css`
  `process_engine/public/css/process_instance_react.css`

## Anpassung von `prozess_instanz.js`

Setze einen Form-Refresh, der das React-Bundle auf einem HTML-Feld mountet
(z.B. `editor_html` auf dem `Prozess Instanz`-Doctype):

```javascript
frappe.ui.form.on("Prozess Instanz", {
    async refresh(frm) {
        await _render_instance_view(frm);
    },

    // Wenn dein Server beim Erledigen eines Schritts schreibt → Re-Mount
    // damit das Bundle die neuen Status sieht (siehe auch onCompleteStep
    // unten — die Bridge kann statt Re-Mount auch optimistisch updaten).
    schritt_status(frm) { _render_instance_view(frm); },
    payload_state(frm)  { _render_instance_view(frm); },
});

async function _render_instance_view(frm) {
    const field = frm.get_field("editor_html");
    if (!field) return;

    await new Promise((r) =>
        frappe.require("/assets/process_engine/js/process_instance_react.bundle.js", r)
    );
    await _loadCssOnce("/assets/process_engine/css/process_instance_react.css");

    // Reset wrapper, prepare a sized container for React
    field.$wrapper.empty();
    const container = document.createElement("div");
    container.style.cssText =
        "position: relative; height: 800px; border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden;";
    field.$wrapper.append(container);

    // Lade die Prozess Version (lazy — eine pro Instanz)
    const version = await frappe.db.get_doc("Prozess Version", frm.doc.prozess_version);

    // Baue statusMap und payload aus den child-tables. Die genauen Felder
    // hängen vom DocType ab — pass an, falls dein Schema anders aussieht.
    const statusMap = {};
    for (const row of (frm.doc.schritt_status || [])) {
        statusMap[row.step_key] = {
            status:           row.status,
            faelligkeit_am:   row.faelligkeit_am,
            erledigt_am:      row.erledigt_am,
            kommentar:        row.kommentar,
            verantwortlich: {
                name:     row.verantwortlich_user_fullname || row.verantwortlich_user,
                rolle:    row.verantwortlich_rolle,
                initials: _initialsOf(row.verantwortlich_user_fullname || row.verantwortlich_user),
            },
        };
    }
    const payload = {};
    for (const row of (frm.doc.payload_state || [])) {
        payload[row.fieldname] = row.value_json
            ? JSON.parse(row.value_json)
            : row.value;
    }

    window.ProcessInstanceReact.mount(container, {
        // ---- Statische Daten ----
        version: {
            version_key:          version.version_key,
            titel:                version.titel,
            prozess_typ:          version.prozess_typ,
            schritte:             version.schritte,
            schritt_io:           version.schritt_io,
            payload_field_specs:  version.payload_field_specs,
        },
        instance: {
            name:                 frm.doc.name,
            status:               frm.doc.status,            // "laufend" | "pausiert" | …
            prozess_typ:          frm.doc.prozess_typ,
            subject: {
                doctype:           frm.doc.subject_doctype,
                name:              frm.doc.subject_name,
                label:             frm.doc.subject_label,
                altmieter:         frm.doc.altmieter_name,   // optional, Domain-spezifisch
                neumieter_intended:frm.doc.neumieter_name,
                uebergabe_geplant: frm.doc.uebergabe_geplant,
            },
            events:               frm.doc.audit_events || [],
        },
        statusMap,
        payload,

        // ---- Layout / Density ----
        layout:  frm.doc.ui_layout  || "split",
        density: frm.doc.ui_density || "comfortable",

        // ---- Widget-Helpers (an Action-Widgets durchgereicht) ----
        helpers: {
            frm,
            getMeta(doctype) {
                return frappe.get_meta(doctype) || { fields: [] };
            },
            async fetchMeta(doctype) {
                await frappe.model.with_doctype(doctype);
                return frappe.get_meta(doctype) || { fields: [] };
            },
            mailTemplates: window.process_engine?.mail_templates || {},
        },

        // ---- Sprung zur Version ----
        onOpenVersion() {
            frappe.set_route("Form", "Prozess Version", frm.doc.prozess_version);
        },

        // ---- Schritt erledigen → Server-Roundtrip ----
        async onCompleteStep(stepKey, data) {
            const r = await frappe.call({
                method: "process_engine.process_engine.doctype.prozess_instanz.prozess_instanz.complete_step",
                args: {
                    instanz:   frm.doc.name,
                    step_key:  stepKey,
                    payload:   data,
                },
            });
            // Server soll den kanonischen State zurückgeben — App synchronisiert
            // optimistic state mit dem, was die DB sagt.
            if (r && r.message) {
                // Trigger frm reload damit refresh() durchläuft und Re-Mount macht
                await frm.reload_doc();
                return null; // setzt nichts mehr im Bundle — refresh() re-mountet
            }
            return null;
        },
    });
}

function _initialsOf(name) {
    return (name || "?").split(" ").map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

async function _loadCssOnce(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    return new Promise((r) => { link.onload = r; document.head.appendChild(link); });
}
```

### Server-Side: `complete_step`

Der Bridge ruft `process_engine.…prozess_instanz.complete_step` auf. Dort
solltest du:
1. Berechtigung prüfen (User darf den Schritt erledigen)
2. `task_type`-spezifische Aktion ausführen (Datei speichern, Doc anlegen, Handler triggern, …)
3. `schritt_status[stepKey].status = "done"` setzen + `erledigt_am` stempeln
4. `payload`-Outputs des Schritts schreiben (aus `data`)
5. Downstream-Schritte neu bewerten (`pending → ready` wenn alle Vorgänger erfüllt)
6. Audit-Event anhängen
7. `frm.reload_doc()` clientseitig — alternativ kanonischen State direkt zurückgeben

```python
@frappe.whitelist()
def complete_step(instanz: str, step_key: str, payload: dict | None = None):
    doc = frappe.get_doc("Prozess Instanz", instanz)
    doc.complete_step(step_key, payload=payload or {})
    doc.save()
    return {"ok": True}
```

## Workflow

```bash
# Beim Code-Ändern in src_react/:
npm run build

git add process_engine/public/js/process_editor_react.bundle.js \
        process_engine/public/js/process_instance_react.bundle.js \
        process_engine/public/css/process_editor_react.css \
        process_engine/public/css/process_instance_react.css \
        src_react/
git commit -m "Update process engine UI bundles"
git push

bench --site <SITE> clear-cache
# Hard-Reload im Browser (Cmd+Shift+R)
```

## Custom Task-Action-Widgets

Eingebaute Action-Widgets im Bundle decken alle 7 task_types ab:
`manual_check`, `file_upload`, `print_document`, `python_action`,
`paperless_export`, `email_draft`, `create_linked_doc`.

Du kannst zusätzliche `task_type`s registrieren oder eingebaute überschreiben —
**ohne das Bundle zu rebuilden** — via globaler Registry:

```javascript
// app-bundle.js (geladen nach process_instance_react.bundle.js)
window.process_engine.register_task_action_widget(
    "dunning_letter",                 // dein neuer task_type
    function DunningLetterWidget({ step, statusRec, version, payload, onComplete, helpers }) {
        return (
            <div>
                <p>Mahnung an Mieter <code>{payload.mieter_doc}</code></p>
                <button className="btn primary" onClick={() => onComplete({})}>
                    Mahnung erzeugen
                </button>
            </div>
        );
    }
);
```

Jedes Widget bekommt:

| Prop | Wert |
|---|---|
| `step` | Der Prozess-Schritt-Record (step_key, titel, task_type, konfig_json, …) |
| `statusRec` | Aktueller Status-Record dieser Instanz für diesen Schritt |
| `version` | Die geladene Prozess Version (schritte + schritt_io + payload_field_specs) |
| `payload` | Aktueller Payload-State (live, nach jedem `onComplete` re-evaluiert) |
| `onComplete(data)` | Erledigen — `data` wird zur Bridge → `complete_step` weitergereicht |
| `helpers` | Vom Bridge-Code in `mount({helpers})` übergeben — `frm`, `getMeta`, `mailTemplates`, … |

Wichtig:
- `onComplete` wird ohne `stepKey` aufgerufen — der wird im Detail-Wrapper bereits gebunden
- Das Widget rendert nur, wenn `statusRec.status === "ready"` oder `"in_progress"`.
  Für `done` / `blocked` / `pending` zeigt die Shell eigene Banner.

## Hinweise

- **Re-Mount nach Server-Update:** ähnlich wie beim Editor — `_render_instance_view`
  wird nach `reload_doc()` neu aufgerufen. Lokaler UI-State (Tab, Selektion,
  Pan/Zoom) bleibt erhalten dank React-Reconciliation.
- **Optimistisches Update:** der Shell ändert `statusMap`/`payload` clientseitig
  sofort beim `onComplete`, bevor der Server antwortet. Das fühlt sich snappy an,
  aber wenn der Server den Schritt ablehnt (z.B. fehlende Berechtigung), zeig
  via `frappe.show_alert` Fehler und triggere `frm.reload_doc()` — der Re-Mount
  resetiert dann den optimistic state.
- **Lock-Modus:** Wenn die Instanz `status === "abgeschlossen"` ist, sollte der
  Server `complete_step` ablehnen. Im UI kannst du zusätzlich `onCompleteStep`
  vorzeitig abfangen.
- **Domain-spezifische Felder im Header** (Altmieter / Neumieter / Übergabe-Datum)
  sind Beispiel — pass `instance.subject.*` an dein eigenes Schema an oder lass
  die Felder leer; die Shell rendert dann ohne diese Zeile.
