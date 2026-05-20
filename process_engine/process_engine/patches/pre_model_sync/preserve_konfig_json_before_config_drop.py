"""Phase 10: config_json wird von Prozess Schritt (Vorlage) entfernt — konfig_json
ist ab jetzt die einzige Config-Quelle pro Schritt.

Bisher las extract_task_config config_json ZUERST, wodurch config_json den sichtbaren
konfig_json ueberschattete. Der tatsaechlich wirksame Wert ist daher config_json. Bevor
die Spalte fällt, retten wir diesen wirksamen Wert nach konfig_json, falls er semantisch
von konfig_json abweicht — sonst ginge er verloren.

Anschliessend wird die Spalte explizit gedroppt: Frappe entfernt beim Schema-Sync KEINE
verwaisten Spalten automatisch, also muessen wir es selbst tun.

pre_model_sync: laeuft VOR dem Schema-Sync, daher existiert die config_json-Spalte
noch und ist per SQL lesbar. Idempotent: fehlt die Spalte bereits → No-op.
"""

from __future__ import annotations

import json

import frappe


def execute():
	# Frische Site: Tabelle existiert vor dem DocType-Sync evtl. noch nicht —
	# get_table_columns wuerde sonst TableMissingError werfen.
	if not frappe.db.table_exists("Prozess Schritt"):
		return
	# Spalte koennte (bei erneutem Lauf) bereits fehlen.
	if "config_json" not in frappe.db.get_table_columns("Prozess Schritt"):
		return

	rows = frappe.db.sql(
		"""SELECT name, config_json, konfig_json FROM `tabProzess Schritt`""",
		as_dict=True,
	)
	for row in rows:
		raw_config = (row.get("config_json") or "").strip()
		if not raw_config:
			continue
		try:
			cfg = json.loads(raw_config)
		except (ValueError, TypeError):
			continue
		if not isinstance(cfg, dict) or not cfg:
			continue

		raw_konfig = (row.get("konfig_json") or "").strip()
		konfig = None
		if raw_konfig:
			try:
				konfig = json.loads(raw_konfig)
			except (ValueError, TypeError):
				konfig = None

		# Nur retten, wenn der wirksame config_json semantisch abweicht (kein Churn).
		if konfig == cfg:
			continue

		frappe.db.set_value(
			"Prozess Schritt",
			row["name"],
			"konfig_json",
			raw_config,
			update_modified=False,
		)

	# Verwaiste Spalte entfernen (Frappe droppt sie beim Sync nicht automatisch).
	frappe.db.sql_ddl("ALTER TABLE `tabProzess Schritt` DROP COLUMN `config_json`")
