# Process Engine

Generic process workflow engine for Frappe (DocTypes, DAG, task handlers,
optional Temporal backend).

Apps register their process definitions via hook:

```python
# in consumer_app/hooks.py
process_engine_runtimes = [
    "consumer_app.process_definitions.my_process.get_my_process_runtime",
]
```

## License

MIT

## Bedingungen und automatische Schritte

Im Prozess-Editor verwenden **Sichtbar wenn** und **Freigabe wenn** dasselbe JSON-Format
wie `visibility_when` in der Trigger-Tabelle am Prozess Typ. Ein leeres Feld oder
eine leere Liste von Regeln ist wahr.

```json
{
  "all": [
    {"field": "payload.betrag", "op": ">=", "value": 100},
    {"field": "doc.status", "op": "in", "value": ["Entwurf", "In Bearbeitung"]},
    {"field": "payload.sperrgrund", "op": "is_empty"}
  ]
}
```

`all` verlangt alle Regeln, `any` mindestens eine. `doc` verweist bei Schritten
auf die Instanz und bei Triggern auf das Quelldokument. `payload` verweist bei
Triggern auf den erzeugten und gemappten Start-Payload. Punktpfade lesen
verschachtelte Objekte. Die Operatoren sind `==`, `!=`, `contains`,
`not_contains`, `starts_with`, `ends_with`, `in`, `is_empty`,
`is_not_empty`, `>`, `<`, `>=` und `<=`. `contains` unterstützt Text
und Listen. `in` erwartet eine Liste als Vergleichswert. `is_empty` und
`is_not_empty` werden ohne `value` geschrieben. Fehlende Felder gelten als leer
und ergeben bei anderen Operatoren falsch. Zahlenwerte werden numerisch
verglichen. Datumswerte verwenden ISO `YYYY-MM-DD`. Textvergleiche unterscheiden
Groß- und Kleinschreibung. Verwendet werden Feldwerte und Literale.

Ausgeblendete Schritte entfallen bei der Abschlussprüfung. Ihre Vorgänger
bleiben für nachgelagerte Schritte relevant. Eine Freigabebedingung gilt
zusätzlich zu den DAG-Voraussetzungen. Trigger-Bedingungen gelten bei der
Anzeige und beim Abruf der Startdaten. Der Migrationspatch listet inkompatible
Altbedingungen auf und stoppt, bis diese korrigiert sind.

Mit **Automatisch** führt der lokale Hintergrund-Worker freigegebene Schritte
nach dem Speichern aus. Für `paperless_export` muss eine Datei in der Aufgabe
liegen oder `file_url_field` auf ihre URL im Payload zeigen. `email_draft`
verwendet `recipient_field`, `subject` und `body` und speichert einen
verknüpften **Prozess E-Mail Entwurf**. `create_linked_doc` verwendet feste und
zugeordnete Eingabefelder des geprüften Erstellpfads. Temporal und KI-Vorschläge
sind mit der automatischen Ausführung unvereinbar.

Registrierte `python_action`-Handler aktivieren `supports_background_execution`
und implementieren `execute_automatic(context, doc, row, execution_key, reconcile)`.
Das Ergebnis kann `outputs` als Mapping für Payload-Werte und `result` als
Aufgabenergebnis enthalten. Der Worker speichert diese am aktuellen Stand der
Instanz. Handler führen keine eigenen Datenbank-Commits aus. Handler mit externer
Wirkung setzen `external_automatic_effect`, verwenden den Ausführungsschlüssel
zur Wiedererkennung und melden unklare Ergebnisse über `UncertainEffect`.
Bei `reconcile=True` gleichen sie den früheren Versuch ab.

Die Aufgabe zeigt den separaten Ausführungsstatus, Zeitpunkt und Fehlertext.
Der Aufräumjob prüft alle fünf Minuten wartende Aufgaben, versäumte Jobs und
abgelaufene Beanspruchungen. Die automatische Ausführung hat drei Versuche.
Nach fünf und danach zehn Minuten wird erneut versucht. Nach einem
unklaren externen Ausgang wird nur abgeglichen. Nach dem letzten Versuch wird
die hinterlegte Standardrolle per Frappe-Benachrichtigung informiert. **Erneut
ausführen** startet bei einem Fehler einen neuen Anlauf mit demselben Schlüssel.
Nach **Wieder öffnen** bleibt eine erfolgreiche Ausführung gespeichert, bis
**Erneut ausführen** ausdrücklich eine neue Generation startet.
