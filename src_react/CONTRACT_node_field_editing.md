# Editor-Vertrag: Felder nur über Knoten (Variante 1)

Ziel: **keine separate „Felder"-Liste.** Payload-Felder existieren ausschließlich, weil ein
Knoten sie deklariert (Start-Knoten = Input, produzierender Knoten = Output). Die Typ-Tabelle
`payload_field_specs` bleibt als **unsichtbarer Speicher** und wird **ausschließlich** über
Knoten-Aktionen gepflegt. Kein Backend-Umbau nötig — alle Bridge-Callbacks existieren bereits.

---

## Datenmodell (was im `frm.doc` liegt)

- `payload_field_specs: [{ fieldname, label, fieldtype, options, reqd }]`
  Der Typ-Speicher. `fieldtype` z.B. `Data | Link | Date | …`; bei `Link` ist `options` der
  Ziel-Doctype. **Du zeigst diese Liste NICHT als Panel** — sie ist nur Backing-Store.
- `schritt_io: [{ step_key, kind, target }]` mit `kind ∈ {payload_input, payload_output, step_input}`.
  `target` = Feldname (für payload_*) bzw. Vorgänger-step_key (für step_input).

### Abgeleitete Sichten (rein im Editor berechnen, nichts speichern)
- **Produzierte Felder** = `{ target | row.kind === "payload_output" }`.
- **Start-Inputs** = alle `payload_field_specs.fieldname`, die **nicht** produziert werden.
  (Das ist die Menge, die der Start-/Process-Inputs-Knoten anzeigt — `getProcessInputFields`
  in `editor-node.jsx` macht das heute schon.)
- **Typ eines Feldes** = `payload_field_specs[fieldname].fieldtype/options`.

---

## Bridge-Callbacks (existieren in `prozess_version.js`, NICHT ändern)

| Callback | Wirkung |
|---|---|
| `onAddField({fieldname, label, fieldtype, options?, reqd?})` | legt Spec an; lehnt doppelten `fieldname` ab |
| `onPatchField(fieldname, {fieldtype?, options?, label?, reqd?})` | ändert Spec |
| `onDeleteField(fieldname)` | entfernt Spec **und kaskadierend alle** `payload_input`/`payload_output` mit diesem `target` |
| `onAddIO({step_key, kind, target})` | legt eine I/O-Zeile an (idempotent) |
| `onRemoveIO({step_key, kind, target})` | entfernt genau diese I/O-Zeile |

---

## Knoten-Aktionen → Daten

### 1. Start-Knoten: „+ Input"
User gibt **Feldname, Label, Typ** (+ Ziel-Doctype bei Link) ein.
```js
onAddField({ fieldname, label, fieldtype, options /* nur bei Link */, reqd });
```
Damit existiert das Feld als Start-Input (Spec ohne Producer). Mehr nicht.

**Start-Input entfernen:**
```js
onDeleteField(fieldname);   // kaskadiert: entfernt auch payload_input/output auf das Feld
```

**Start-Input-Typ ändern:**
```js
onPatchField(fieldname, { fieldtype, options });
```

### 2. Produzierenden Knoten: „Output deklarieren"
User gibt **Feldname + Typ** am Output-Port an.
```js
// Feld existiert noch nicht -> Spec anlegen:
onAddField({ fieldname, label, fieldtype, options });
// und diesen Knoten als Producer markieren:
onAddIO({ step_key, kind: "payload_output", target: fieldname });
```
Existiert das Feld **schon** (anderswo deklariert): nur das `onAddIO(payload_output)` —
**kein** zweites `onAddField`. (Server erzwingt: genau **ein** Producer pro Feld.)

**Output entfernen:**
```js
onRemoveIO({ step_key, kind: "payload_output", target: fieldname });
// optional: wenn das Feld danach von keinem Knoten mehr referenziert wird -> onDeleteField(fieldname)
```

### 3. Input-Port verdrahten (Konsument liest ein Feld)
Nur Felder anbieten, die **schon deklariert** sind (Start-Input oder produziert).
```js
onAddIO({ step_key, kind: "payload_input", target: fieldname });
```
Entfernen: `onRemoveIO({ step_key, kind: "payload_input", target: fieldname })`.

### 4. „Felder"-Panel
**Entfernen** (oder auf Read-only-Übersicht reduzieren). Sämtliches Feld-CRUD läuft über 1–3.
Betroffen: `FieldsPanel` in `editor-panels.jsx` + der „Felder"-Button/`panelMode==="fields"`
in `editor-shell.jsx`.

---

## Garantien vom Backend (must NOT be re-implemented im Frontend)
`prozess_version.py::_validate_schritt_io` erzwingt beim Speichern:
- jedes `payload_input`/`payload_output`-`target` ist ein deklariertes `payload_field_specs`
  → lege nie eine I/O-Zeile für ein Feld an, das es nicht (mehr) gibt;
- **ein** Producer pro Feld (zweites `payload_output` auf dasselbe Feld = harter Fehler);
- DAG/Zyklus-Checks.

Daraus folgt die Invariante deines Modells **automatisch**: ein Feld kann nur existieren/
referenziert werden, wenn ein Knoten es deklariert — es gibt keine „verwaisten" Felder, weil
du Felder ausschließlich über `onAddField` (= eine Knoten-Aktion) anlegst und `onDeleteField`
kaskadiert.

---

## Konsumenten (bleiben unverändert, lesen weiter `payload_field_specs`)
- Pfad-Picker (`path_picker.js`) — Quell-Doctype aus dem Link-Spec des `source_field`.
- Trigger-Input-Mapping (`get_payload_field_specs`).
- Laufzeit-Kontext-Panel (`get_instance_payload_view`).
- Neue-Instanz-/Trigger-Flow.

Weil der Speicher (`payload_field_specs`) bleibt, funktionieren diese ohne Änderung weiter —
nur die **Bearbeitung** wandert von der Liste in die Knoten.
