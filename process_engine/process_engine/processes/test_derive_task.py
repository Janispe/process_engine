from __future__ import annotations

import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from process_engine.process_engine.processes.task_registry import (
	TASK_TYPE_DERIVE,
	DeriveTaskHandler,
	TaskHandlerRegistry,
)


class _FakeDoc:
	"""Minimaler Payload-Container mit derselben API wie Prozess Instanz."""

	def __init__(self, payload: dict | None = None):
		self._p = dict(payload or {})

	def payload(self, key, default=None):
		return self._p.get(key, default)

	def payload_set(self, key, value):
		self._p[key] = value


class _FakeRow:
	"""Tut so, als waere es ein Vorlagen-Schritt (liest Config aus konfig_json)."""

	def __init__(self, config: dict):
		self.konfig_json = json.dumps(config)
		self.task_type = TASK_TYPE_DERIVE
		self.status = "Offen"
		self.result_json = None


class TestDeriveTaskHandler(FrappeTestCase):
	def test_registered_in_registry(self):
		handler = TaskHandlerRegistry().get_handler(task_type=TASK_TYPE_DERIVE)
		self.assertIsInstance(handler, DeriveTaskHandler)
		self.assertTrue(getattr(handler, "is_auto", False))

	def test_run_action_derives_stored_link(self):
		# DocType "User" liegt im Modul "Core" -> deterministisch, ohne Domaenen-Daten.
		doc = _FakeDoc({"src": "User"})
		row = _FakeRow({
			"source_field": "src",
			"source_doctype": "DocType",
			"path": "module",
			"store_in_payload_field": "out",
		})
		res = DeriveTaskHandler().run_action(None, doc, row)
		self.assertEqual(res["value"], "Core")
		self.assertEqual(doc.payload("out"), "Core")
		self.assertEqual(row.status, "Erledigt")
		self.assertIn("derived", json.loads(row.result_json))

	def test_run_action_drilldown(self):
		doc = _FakeDoc({"src": "User"})
		row = _FakeRow({
			"source_field": "src",
			"source_doctype": "DocType",
			"path": "module.name",
			"store_in_payload_field": "out",
		})
		DeriveTaskHandler().run_action(None, doc, row)
		self.assertEqual(doc.payload("out"), "Core")

	def test_run_action_missing_source_value_yields_none(self):
		# Quelle (noch) leer -> Ergebnis None, kein Fehler (Auto-Run wartet sonst nicht).
		doc = _FakeDoc({})
		row = _FakeRow({
			"source_field": "src",
			"source_doctype": "DocType",
			"path": "module",
			"store_in_payload_field": "out",
		})
		res = DeriveTaskHandler().run_action(None, doc, row)
		self.assertIsNone(res["value"])
		self.assertIsNone(doc.payload("out"))

	def test_validate_config_requires_source_doctype(self):
		row = _FakeRow({
			"source_field": "src",
			"path": "module",
			"store_in_payload_field": "out",
		})  # source_doctype fehlt (Pfad-Picker setzt es normalerweise)
		with self.assertRaises(frappe.ValidationError):
			DeriveTaskHandler().validate_config(row)

	def test_validate_config_ok(self):
		row = _FakeRow({
			"source_field": "src",
			"source_doctype": "DocType",
			"path": "module",
			"store_in_payload_field": "out",
		})
		# Wirft nicht.
		DeriveTaskHandler().validate_config(row)


class TestDeriveAutoRunIntegration(FrappeTestCase):
	"""End-to-end: ein derive-Schritt leitet beim Save automatisch ab (Auto-Run)."""

	def setUp(self):
		super().setUp()
		# Temporal aus -> lokaler Backend (sonst wuerde dispatch ueber Temporal laufen).
		self._tb = {k: frappe.conf.get(k) for k in ("hv_temporal_enabled", "hv_temporal_enabled_doctypes")}
		frappe.conf.hv_temporal_enabled = False
		frappe.conf.hv_temporal_enabled_doctypes = ""

	def tearDown(self):
		for k, v in self._tb.items():
			if v is None:
				frappe.conf.pop(k, None)
			else:
				frappe.conf[k] = v
		super().tearDown()

	def _build(self):
		typ_name = f"_derive_{uuid.uuid4().hex[:8]}"
		typ = frappe.get_doc({
			"doctype": "Prozess Typ", "name1": typ_name, "label": "Derive Test",
			"is_active": 1, "default_process_type": "Beide",
		}).insert(ignore_permissions=True)
		version = frappe.get_doc({
			"doctype": "Prozess Version",
			"version_key": f"v1-{typ_name}", "titel": "Derive v1",
			"prozess_typ": typ_name, "runtime_doctype": "Prozess Instanz", "is_active": 1,
			"payload_field_specs": [
				{"fieldname": "src_doc", "label": "Quelle", "fieldtype": "Link", "options": "DocType"},
				{"fieldname": "out_val", "label": "Ergebnis", "fieldtype": "Data"},
			],
			"schritte": [{
				"step_key": "step_derive", "titel": "Modul ableiten", "pflicht": 1,
				"task_type": TASK_TYPE_DERIVE, "sichtbar_fuer_prozess_typ": "Beide", "reihenfolge": 10,
				"konfig_json": json.dumps({
					"source_field": "src_doc", "source_doctype": "DocType",
					"path": "module", "store_in_payload_field": "out_val",
				}),
			}],
			"schritt_io": [
				{"step_key": "step_derive", "kind": "payload_input", "target": "src_doc"},
				{"step_key": "step_derive", "kind": "payload_output", "target": "out_val"},
			],
		}).insert(ignore_permissions=True)
		# DocType "User" liegt im Modul "Core" -> deterministisch ableitbar.
		inst = frappe.get_doc({
			"doctype": "Prozess Instanz", "prozess_typ": typ_name,
			"payload_json": json.dumps({"src_doc": "User"}),
		}).insert(ignore_permissions=True)
		return typ, version, inst

	def test_derive_auto_runs_on_save(self):
		typ, version, inst = self._build()
		try:
			# Erster Insert ueberspringt Auto-Run (doc.is_new-Guard). Naechster Save fuehrt aus.
			inst.reload()
			inst.save(ignore_permissions=True)
			inst.reload()

			self.assertEqual(inst.payload("out_val"), "Core")
			derive_row = next(r for r in inst.aufgaben if (r.step_key or "") == "step_derive")
			self.assertEqual((derive_row.status or "").strip(), "Erledigt")
			self.assertTrue(derive_row.erfuellt)
		finally:
			frappe.delete_doc("Prozess Instanz", inst.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Version", version.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)
