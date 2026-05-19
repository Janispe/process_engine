"""Phase 9: befuellt schritt_io fuer alle existierenden Prozess Versionen.

Idempotent + sicher:
- Skip wenn die Version bereits schritt_io-Zeilen hat.
- Active-Lock-Bypass via doc.flags.from_migration (siehe
  prozess_version._enforce_active_immutability).
- Liest mapping_flag (deprecated) und konfig_json.{store_in_payload_field,
  target_field} direkt aus den vorhandenen Schritten als Heuristik.

Mieterwechsel-Schritte werden uebersteuert durch das Hard-Mapping in
hausverwaltung_peters.process_definitions.mieterwechsel_seed_data (falls
diese App installiert ist). Damit bleibt der Migrationsstand exakt
deckungsgleich mit dem Bootstrap-Stand.
"""
from __future__ import annotations

import json

import frappe


def execute():
	if not frappe.db.exists("DocType", "Prozess Version"):
		return
	if not frappe.db.exists("DocType", "Prozess Schritt IO"):
		# Schema noch nicht synct, wird beim naechsten migrate retried
		return

	# Runtime fuer "Prozess Instanz" registrieren (sonst wirft _validate_runtime_doctype
	# beim Save). Analog zu Phase 7-Patches.
	from process_engine.process_engine.processes import ensure_process_runtimes_registered
	from process_engine.process_engine.processes.engine import (
		get_runtime_config_for_typ,
		register_process_runtime,
	)

	ensure_process_runtimes_registered()
	for typ_name in frappe.get_all("Prozess Typ", pluck="name"):
		cfg = get_runtime_config_for_typ(typ_name)
		if cfg:
			register_process_runtime(cfg)
			break  # Eine Registrierung reicht — alle nutzen "Prozess Instanz" als doctype

	# Mieterwechsel-Hard-Mapping (falls peters installiert ist)
	mieterwechsel_io_by_step: dict[str, list[dict]] = {}
	try:
		from hausverwaltung_peters.process_definitions.mieterwechsel_seed_data import (
			MIETERWECHSEL_DEFAULT_SCHRITTE,
		)

		for s in MIETERWECHSEL_DEFAULT_SCHRITTE:
			mieterwechsel_io_by_step[s["step_key"]] = list(s.get("io") or [])
	except ImportError:
		pass

	versions = frappe.get_all("Prozess Version", pluck="name")
	for v_name in versions:
		v = frappe.get_doc("Prozess Version", v_name)
		if v.get("schritt_io"):
			continue  # bereits migriert

		is_mw = (v.get("prozess_typ") or "").strip() == "mieterwechsel"
		io_rows: list[dict] = []
		for schritt in v.get("schritte") or []:
			step_key = (schritt.get("step_key") or "").strip()
			if not step_key:
				continue

			if is_mw and step_key in mieterwechsel_io_by_step:
				# Hard-Mapping aus seed_data uebernehmen
				for io in mieterwechsel_io_by_step[step_key]:
					io_rows.append(
						{
							"step_key": step_key,
							"kind": io["kind"],
							"target": io["target"],
						}
					)
				continue

			# Heuristik: Output aus konfig_json + mapping_flag ableiten
			konfig = {}
			raw = (schritt.get("konfig_json") or "").strip()
			if raw:
				try:
					konfig = json.loads(raw)
				except (ValueError, TypeError):
					konfig = {}

			# create_linked_doc → store_in_payload_field als payload_output
			store_field = (konfig.get("store_in_payload_field") or "").strip()
			if store_field:
				io_rows.append(
					{
						"step_key": step_key,
						"kind": "payload_output",
						"target": store_field,
					}
				)

			# python_action mit set_flag → target_field als payload_output
			target_field = (konfig.get("target_field") or "").strip()
			if target_field and target_field != store_field:
				io_rows.append(
					{
						"step_key": step_key,
						"kind": "payload_output",
						"target": target_field,
					}
				)

			# mapping_flag (deprecated) als Fallback fuer payload_output
			mapping_flag = (schritt.get("mapping_flag") or "").strip()
			if mapping_flag and mapping_flag != store_field and mapping_flag != target_field:
				io_rows.append(
					{
						"step_key": step_key,
						"kind": "payload_output",
						"target": mapping_flag,
					}
				)

		if not io_rows:
			# Version hat keinen ableitbaren I/O. Phase 9 verbietet das fuer
			# kuenftige Saves (siehe prozess_version._validate_schritt_io) —
			# diese Version muss manuell nachgepflegt werden, sonst wirft sie
			# beim naechsten User-Save. Wir loggen sie deutlich.
			frappe.log_error(
				title=f"Phase 9 Migration: Version '{v_name}' ohne ableitbare I/O",
				message=(
					f"Version '{v_name}' (prozess_typ='{v.get('prozess_typ')}') hat schritte, aber "
					"keine ableitbare schritt_io. Manuelles Nachpflegen erforderlich, sonst "
					"verweigert die Engine kuenftige Saves dieser Version."
				),
			)
			print(
				f"[Phase 9] WARN: Version '{v_name}' (typ='{v.get('prozess_typ')}') hat keine "
				"ableitbare I/O — bitte manuell nachpflegen."
			)
			continue

		for row in io_rows:
			v.append("schritt_io", row)
		v.flags.from_migration = True
		v.save(ignore_permissions=True)
	frappe.db.commit()
