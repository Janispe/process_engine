"""Phase 10: dauerhafter Content-Lock ab erster Aktivierung (wurde_aktiviert).

Setzt das neue Lifecycle-Flag wurde_aktiviert=1 fuer alle aktuell aktiven
Prozess-Versionen, damit der dauerhafte Lock ab sofort greift.

Deckt nur is_active=1 ab. Frueher aktive, inzwischen deaktivierte Versionen, die von
einer Prozess Instanz referenziert werden, lockt der Folge-Patch
set_wurde_aktiviert_for_referenced_versions — noetig, seit der Laufzeit-Config-Snapshot
entfernt wurde (Instanzen lesen ihre Config nun live aus der Version, f9d2263).

post_model_sync: laeuft NACH dem Schema-Sync, das Feld wurde_aktiviert existiert
also bereits. Idempotent (set_value nur fuer noch nicht gesetzte Flags).
"""

from __future__ import annotations

import frappe


def execute():
	active_names = frappe.get_all(
		"Prozess Version",
		filters={"is_active": 1, "wurde_aktiviert": 0},
		pluck="name",
	)
	for name in active_names:
		frappe.db.set_value(
			"Prozess Version", name, "wurde_aktiviert", 1, update_modified=False
		)
