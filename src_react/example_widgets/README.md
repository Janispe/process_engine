# Beispiel-Custom-Widget — Print-Format-Picker

Konkretes Custom-Config-Widget, das eine **Serienbrief-/Print-Format-Vorlage** für
einen Druck-Schritt aussucht. Demonstriert die `register_config_widget`-Mechanik
1:1 — du kannst die Datei direkt in deiner App ablegen oder als Vorlage für eigene
Widgets nehmen.

## Was es macht

Im Editor erscheint statt eines generischen Link-Feldes ein Dropdown der
verfügbaren Print Formats inkl.:

- **Filter** auf `disabled = 0` (nur aktive Vorlagen) — überschreibbar via Schema
- **Vorschau-Link** zum direkten Öffnen der Vorlage im Frappe-Standard-Editor
- **Doc-Type-Hinweis** bei der Auswahl

## Installation in deiner App

1. `print_format_picker.js` nach `<deine_app>/public/js/print_format_picker.js`
   kopieren.
2. In `hooks.py` registrieren, damit Frappe es im Desk lädt:

   ```python
   app_include_js = [
       "public/js/print_format_picker.js",
   ]
   ```

3. Im Server-Handler das Widget deklarieren:

   ```python
   class PrintDocumentTaskHandler(BaseTaskHandler):
       def config_schema(self):
           return {"fields": [
               {
                   "key": "print_format",
                   "label": _("Serienbrief-Vorlage"),
                   "widget": "print_format_picker",
                   "reqd": 1,
                   # Optional: zusätzliche Filter überschreiben den Default
                   # "filters": {"doc_type": "Sales Invoice"},
               },
           ]}
   ```

4. Bench-Cache leeren, Hard-Reload — fertig.

## Schema-Felder

Das Widget liest aus der Schema-Feld-Def:

| Key       | Bedeutung |
|-----------|-----------|
| `key`     | Der `konfig_json`-Schlüssel, in den der Vorlagen-Name geschrieben wird |
| `label`   | Anzeige-Label über dem Dropdown (Default: "Print Format") |
| `reqd`    | Pflichtfeld-Markierung (`*` neben Label) |
| `filters` | Optionales Filter-Dict für `frappe.db.get_list`. Standard: `{disabled: 0}` |

## Was du anpassen musst, wenn du einen anderen DocType hast

Wenn deine App z.B. ein eigenes „Serienbrief Vorlage"-DocType hat statt Frappes
Print Format, kopier' die Datei und ändere:

- `frappe.db.get_list("Print Format", ...)` → dein DocType-Name
- Die `fields`-Liste (welche Spalten du anzeigen willst)
- Den `/app/print-format/…`-Link-Pfad auf deinen DocType-Slug

## Reicht das?

Das ist ein **Beispiel** — keine fertige Default-Implementierung. Die existierende
`PrintDocumentTaskHandler.config_schema()` nutzt schon ein generisches Link-Feld
mit `options: "Print Format"`, was ohne Custom-Widget identisch funktioniert.
Der Mehrwert hier ist das hübschere UX (Vorschau-Link, Filter, evtl. später eine
Live-Vorschau des gerenderten HTMLs).
