"""Normalisiert derive-Schritte vom Alt-Schema (path + store_in_payload_field) auf das
neue Schema (derivations = [{path, field}]) — ein Eingang, viele Ausgaenge.

Hintergrund: Der derive-Node leitet jetzt ueber mehrere Pfade mehrere Ausgaenge ab. Das
Editor-Widget liest cfg.derivations; ein alter Einzelpfad in cfg.path waere dort unsichtbar
(obwohl der Handler ihn rueckwaerts-kompatibel weiter laeuft). Dieser Patch schreibt die
alten Configs einmalig in die neue Form, damit sie im Editor erscheinen.

Idempotent + sicher:
- Nur derive-Schritte mit cfg.path UND ohne cfg.derivations werden angefasst.
- Feldnamen kommen aus DeriveTaskHandler._derivations (= dieselbe Auto-Name-Logik wie
  Backend/Editor) -> store_in_payload_field bleibt erhalten, fehlende werden abgeleitet.
- Active-Lock-Bypass via doc.flags.from_migration (semantisch identisch, nur Schema-Form).
"""
from __future__ import annotations

import json

import frappe


def execute():
	if not frappe.db.exists("DocType", "Prozess Version"):
		return

	from process_engine.process_engine.processes import ensure_process_runtimes_registered
	from process_engine.process_engine.processes.engine import (
		get_runtime_config_for_typ,
		register_process_runtime,
	)
	from process_engine.process_engine.processes.task_registry import (
		TASK_TYPE_DERIVE,
		DeriveTaskHandler,
	)

	# Runtime registrieren, damit der Version-Save (validate) durchlaeuft (analog Phase 9).
	ensure_process_runtimes_registered()
	for typ_name in frappe.get_all("Prozess Typ", pluck="name"):
		cfg = get_runtime_config_for_typ(typ_name)
		if cfg:
			register_process_runtime(cfg)
			break

	for v_name in frappe.get_all("Prozess Version", pluck="name"):
		v = frappe.get_doc("Prozess Version", v_name)
		changed = False
		for schritt in v.get("schritte") or []:
			if (schritt.get("task_type") or "").strip() != TASK_TYPE_DERIVE:
				continue
			raw = (schritt.get("konfig_json") or "").strip()
			if not raw:
				continue
			try:
				konfig = json.loads(raw)
			except (ValueError, TypeError):
				continue
			if not isinstance(konfig, dict):
				continue
			# Schon migriert oder kein Alt-Pfad -> nichts zu tun.
			if konfig.get("derivations") or not (konfig.get("path") or "").strip():
				continue

			derivations = DeriveTaskHandler._derivations(konfig)
			if not derivations:
				continue
			konfig["derivations"] = derivations
			konfig.pop("path", None)
			konfig.pop("store_in_payload_field", None)
			schritt.konfig_json = json.dumps(konfig)
			changed = True

		if changed:
			v.flags.from_migration = True
			v.save(ignore_permissions=True)

	frappe.db.commit()
