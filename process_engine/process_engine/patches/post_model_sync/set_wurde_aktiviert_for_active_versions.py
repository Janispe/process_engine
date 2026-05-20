"""Phase 10: dauerhafter Content-Lock ab erster Aktivierung (wurde_aktiviert).

Setzt das neue Lifecycle-Flag wurde_aktiviert=1 fuer alle aktuell aktiven
Prozess-Versionen, damit der dauerhafte Lock ab sofort greift.

Grenze: Versionen, die frueher aktiv waren und bereits deaktiviert wurden, sind
nicht rueckwirkend erkennbar (es gibt keine Historie) und bleiben editierbar.
Akzeptabel — laufende Instanzen sind durch ihren Config-Snapshot ohnehin geschuetzt.

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
