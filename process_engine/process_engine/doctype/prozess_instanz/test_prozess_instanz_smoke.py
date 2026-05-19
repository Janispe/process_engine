"""Smoke-Tests fuer Prozess Instanz ohne Domain-Wissen.

Domain-spezifische Tests (Mieterwechsel, Eigentuemerwechsel, ...) gehoeren in
die jeweilige Consumer-App (z.B. hausverwaltung_peters). process_engine wird
hier nur in seiner generischen Form geprueft:
- DocTypes existieren nach migrate
- Engine-API laesst sich importieren
- ein triviales Prozess Typ + Version + Instanz laesst sich ohne Validatoren
  durch den Engine-Path fuehren
"""

from __future__ import annotations

import uuid

import frappe
from frappe.tests.utils import FrappeTestCase


class TestProzessInstanzSmoke(FrappeTestCase):
	def test_doctype_module_is_process_engine(self):
		for dt in (
			"Prozess Typ",
			"Prozess Version",
			"Prozess Instanz",
			"Prozess Schritt",
			"Prozess Aufgabe",
			"Prozess Field Spec",
		):
			self.assertTrue(frappe.db.exists("DocType", dt), f"Missing DocType: {dt}")
			self.assertEqual(
				frappe.db.get_value("DocType", dt, "module"),
				"Process Engine",
				f"{dt}.module should be 'Process Engine'",
			)

	def test_engine_api_imports(self):
		from process_engine.process_engine.processes import (  # noqa: F401
			BaseProcessDocument,
			ProcessEngine,
			ProcessRuntimeConfig,
			ensure_process_runtimes_registered,
			get_process_runtime_config,
		)

	def test_minimal_prozess_typ_roundtrip(self):
		"""Lege einen trivialen Prozess Typ + Version + Instanz an. Kein
		Domain-Plugin, keine Triggers — nur das Engine-Skeleton.
		"""
		typ_name = f"_smoketest_{uuid.uuid4().hex[:8]}"
		typ = frappe.get_doc(
			{
				"doctype": "Prozess Typ",
				"name1": typ_name,
				"label": "Smoke Test",
				"is_active": 1,
				"default_process_type": "Beide",
			}
		).insert(ignore_permissions=True)

		try:
			from process_engine.process_engine.processes import (
				ensure_process_runtimes_registered,
				get_runtime_config_for_typ,
				register_process_runtime,
			)

			ensure_process_runtimes_registered()
			cfg = get_runtime_config_for_typ(typ_name)
			self.assertIsNotNone(cfg)
			self.assertEqual(cfg.doctype, "Prozess Instanz")
			register_process_runtime(cfg)

			version = frappe.get_doc(
				{
					"doctype": "Prozess Version",
					"version_key": f"v1-{typ_name}",
					"titel": "Smoke v1",
					"prozess_typ": typ_name,
					"runtime_doctype": "Prozess Instanz",
					"is_active": 1,
					"schritte": [
						{
							"step_key": "step_a",
							"titel": "Step A",
							"pflicht": 1,
							"task_type": "manual_check",
							"sichtbar_fuer_prozess_typ": "Beide",
							"reihenfolge": 10,
						}
					],
				}
			).insert(ignore_permissions=True)

			try:
				inst = frappe.get_doc(
					{
						"doctype": "Prozess Instanz",
						"prozess_typ": typ_name,
						"payload_json": "{}",
					}
				).insert(ignore_permissions=True)
				try:
					self.assertEqual(len(inst.aufgaben or []), 1)
					self.assertEqual(inst.aufgaben[0].step_key, "step_a")
				finally:
					frappe.delete_doc("Prozess Instanz", inst.name, force=True, ignore_permissions=True)
			finally:
				frappe.delete_doc("Prozess Version", version.name, force=True, ignore_permissions=True)
		finally:
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)
			frappe.db.commit()
