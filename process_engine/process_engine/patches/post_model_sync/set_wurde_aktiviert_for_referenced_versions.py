"""Phase 10: dauerhafter Content-Lock auch fuer referenzierte (nicht nur aktive) Versionen.

Seit der Laufzeit-Config-Snapshot entfernt wurde, lesen Prozess Instanzen ihre Config
LIVE aus der referenzierten Prozess Version. Damit eine laufende/abgeschlossene Instanz
nicht durch nachtraegliche Edits ihrer Version rueckwirkend veraendert wird, muss JEDE
von einer Instanz referenzierte Version dauerhaft gelockt sein.

set_wurde_aktiviert_for_active_versions deckt nur is_active=1 ab. Eine frueher aktive,
inzwischen deaktivierte, aber von einer Instanz referenzierte Version koennte sonst
(wurde_aktiviert=0) noch editiert werden. Dieser Patch schliesst die historische Luecke.

Forward ist abgedeckt: neue Instanzen referenzieren die aktive (= bereits gelockte)
Version; activate_version lockt; der Delete-Guard verhindert Loeschen.

post_model_sync, idempotent (set_value nur fuer noch nicht gesetzte Flags).
"""

from __future__ import annotations

import frappe


def execute():
	refs = frappe.get_all("Prozess Instanz", pluck="prozess_version")
	for name in {(r or "").strip() for r in refs if (r or "").strip()}:
		if frappe.db.exists("Prozess Version", name) and not frappe.db.get_value(
			"Prozess Version", name, "wurde_aktiviert"
		):
			frappe.db.set_value(
				"Prozess Version", name, "wurde_aktiviert", 1, update_modified=False
			)
