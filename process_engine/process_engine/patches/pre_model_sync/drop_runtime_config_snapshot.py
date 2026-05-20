"""Phase 10: Der Config-Snapshot auf der Laufzeit-Aufgabe (Prozess Aufgabe) wird
entfernt. Die Config wird zur Laufzeit live aus der referenzierten Prozess Version
aufgeloest (extract_task_config -> _resolve_runtime_task_config).

config_json war ein Snapshot der Schritt-Config; konfig_snapshot_json ein Duplikat
davon. Beide Spalten werden gedroppt — Frappe entfernt verwaiste Spalten beim
Schema-Sync nicht automatisch. Keine Wert-Rettung noetig: die Config lebt in der
Prozess Version, und der Delete-Guard (Prozess Version.on_trash) stellt sicher, dass
eine referenzierte Version nicht geloescht wird.

pre_model_sync: laeuft vor dem Schema-Sync. Idempotent (Spalten-Check).
"""

from __future__ import annotations

import frappe


def execute():
	if not frappe.db.table_exists("Prozess Aufgabe"):
		return
	cols = frappe.db.get_table_columns("Prozess Aufgabe")
	for col in ("config_json", "konfig_snapshot_json"):
		if col in cols:
			frappe.db.sql_ddl(f"ALTER TABLE `tabProzess Aufgabe` DROP COLUMN `{col}`")
