from __future__ import annotations

import json
import uuid
from unittest.mock import patch

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

	def __init__(self, config: dict, version_specs=None):
		self.konfig_json = json.dumps(config)
		self.task_type = TASK_TYPE_DERIVE
		self.status = "Offen"
		self.result_json = None
		self.flags = frappe._dict()
		if version_specs is not None:
			self.flags.version_payload_specs = version_specs


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
			"input_doctype": "DocType",
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
			"input_doctype": "DocType",
			"path": "module.name",
			"store_in_payload_field": "out",
		})
		DeriveTaskHandler().run_action(None, doc, row)
		self.assertEqual(doc.payload("out"), "Core")

	def test_run_action_none_result_does_not_complete(self):
		# Finding 5: Quelle da, aber resolve_path liefert None (z.B. wohnung.aktueller_mietvertrag
		# vor Vertragsanlage) -> NICHT abschliessen, kein Output, damit es spaeter erneut laeuft.
		doc = _FakeDoc({"src": "User"})
		row = _FakeRow({
			"source_field": "src",
			"input_doctype": "DocType",
			"path": "module.some_missing_link",
			"store_in_payload_field": "out",
		})
		with patch(
			"process_engine.process_engine.processes.path_resolver.resolve_path",
			return_value=None,
		):
			res = DeriveTaskHandler().run_action(None, doc, row)
		self.assertTrue(res.get("skipped"))
		self.assertIsNone(doc.payload("out"))
		self.assertEqual(row.status, "Offen")  # nicht abgeschlossen

	def test_run_action_falsy_zero_completes(self):
		# 0/False sind gueltige Ergebnisse -> Schritt schliesst ab.
		doc = _FakeDoc({"src": "User"})
		row = _FakeRow({
			"source_field": "src",
			"input_doctype": "DocType",
			"path": "irgendwas",
			"store_in_payload_field": "out",
		})
		with patch(
			"process_engine.process_engine.processes.path_resolver.resolve_path",
			return_value=0,
		):
			res = DeriveTaskHandler().run_action(None, doc, row)
		self.assertFalse(res.get("skipped"))
		self.assertEqual(doc.payload("out"), 0)
		self.assertEqual(row.status, "Erledigt")

	def test_run_action_missing_source_value_yields_none(self):
		# Quelle (noch) leer -> Ergebnis None, kein Fehler (Auto-Run wartet sonst nicht).
		doc = _FakeDoc({})
		row = _FakeRow({
			"source_field": "src",
			"input_doctype": "DocType",
			"path": "module",
			"store_in_payload_field": "out",
		})
		res = DeriveTaskHandler().run_action(None, doc, row)
		self.assertIsNone(res["value"])
		self.assertIsNone(doc.payload("out"))

	def test_validate_config_requires_input_doctype(self):
		row = _FakeRow({
			"source_field": "src",
			"path": "module",
			"store_in_payload_field": "out",
		})  # input_doctype fehlt (wird in der Config gewaehlt)
		with self.assertRaises(frappe.ValidationError):
			DeriveTaskHandler().validate_config(row)

	def test_validate_config_ok(self):
		row = _FakeRow({
			"source_field": "src",
			"input_doctype": "DocType",
			"path": "module",
			"store_in_payload_field": "out",
		})
		# Wirft nicht.
		DeriveTaskHandler().validate_config(row)

	def test_validate_config_rejects_invalid_path(self):
		# Finding 4: Pfad gegen Meta validieren -> kaputter Pfad faellt beim Save auf.
		row = _FakeRow({
			"source_field": "src",
			"input_doctype": "DocType",
			"path": "gibt_es_nicht_xyz",
			"store_in_payload_field": "out",
		})
		with self.assertRaises(frappe.ValidationError):
			DeriveTaskHandler().validate_config(row)

	def test_validate_config_cross_check_source_field_must_be_link(self):
		# Finding 4: mit Versions-Specs (Flag) wird geprueft, dass source_field ein Link auf
		# input_doctype ist. Hier ist src als Data deklariert -> Fehler.
		row = _FakeRow(
			{
				"source_field": "src",
				"input_doctype": "DocType",
				"path": "module",
				"store_in_payload_field": "out",
			},
			version_specs=[
				{"fieldname": "src", "fieldtype": "Data", "options": ""},
				{"fieldname": "out", "fieldtype": "Data", "options": ""},
			],
		)
		with self.assertRaises(frappe.ValidationError):
			DeriveTaskHandler().validate_config(row)

	def test_validate_config_cross_check_ok_with_link_spec(self):
		row = _FakeRow(
			{
				"source_field": "src",
				"input_doctype": "DocType",
				"path": "module",
				"store_in_payload_field": "out",
			},
			version_specs=[
				{"fieldname": "src", "fieldtype": "Link", "options": "DocType"},
				{"fieldname": "out", "fieldtype": "Data", "options": ""},
			],
		)
		# Wirft nicht: src ist Link->DocType, out deklariert.
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

	def _build(self, src_value="User"):
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
					"source_field": "src_doc", "input_doctype": "DocType",
					"path": "module", "store_in_payload_field": "out_val",
				}),
			}],
			"schritt_io": [
				{"step_key": "step_derive", "kind": "payload_input", "target": "src_doc"},
				{"step_key": "step_derive", "kind": "payload_output", "target": "out_val"},
			],
		}).insert(ignore_permissions=True)
		# DocType "User" liegt im Modul "Core" -> deterministisch ableitbar.
		payload = {"src_doc": src_value} if src_value else {}
		inst = frappe.get_doc({
			"doctype": "Prozess Instanz", "prozess_typ": typ_name,
			"payload_json": json.dumps(payload),
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

	def test_derive_waits_for_source_then_runs(self):
		# Finding 2: ohne Quelle darf der Derive NICHT laufen/abschliessen; kommt die Quelle
		# spaeter, laeuft er beim naechsten Save.
		typ, version, inst = self._build(src_value=None)
		try:
			inst.reload()
			inst.save(ignore_permissions=True)
			inst.reload()
			derive_row = next(r for r in inst.aufgaben if (r.step_key or "") == "step_derive")
			self.assertNotEqual((derive_row.status or "").strip(), "Erledigt", "Derive lief ohne Quelle")
			self.assertIsNone(inst.payload("out_val"))

			# Quelle nachliefern -> jetzt muss der Derive laufen.
			inst.payload_set("src_doc", "User")
			inst.save(ignore_permissions=True)
			inst.reload()
			self.assertEqual(inst.payload("out_val"), "Core")
			derive_row = next(r for r in inst.aufgaben if (r.step_key or "") == "step_derive")
			self.assertEqual((derive_row.status or "").strip(), "Erledigt")
		finally:
			frappe.delete_doc("Prozess Instanz", inst.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Version", version.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)
