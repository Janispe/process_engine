from __future__ import annotations

import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from process_engine.process_engine.processes.task_registry import (
	TASK_TYPE_FILL_FIELDS,
	FillFieldsTaskHandler,
	TaskHandlerRegistry,
)


class _FakeDoc:
	def __init__(self, payload):
		self._p = dict(payload or {})

	def payload(self, key, default=None):
		return self._p.get(key, default)

	def save(self, *a, **k):
		pass


class _FakeRow:
	def __init__(self, config):
		self.konfig_json = json.dumps(config)
		self.task_type = TASK_TYPE_FILL_FIELDS
		self.status = "Offen"
		self.result_json = None


class TestFillFieldsHandler(FrappeTestCase):
	def test_registered(self):
		h = TaskHandlerRegistry().get_handler(task_type=TASK_TYPE_FILL_FIELDS)
		self.assertIsInstance(h, FillFieldsTaskHandler)

	def test_declared_inputs(self):
		h = FillFieldsTaskHandler()
		self.assertEqual(h.declared_inputs({"source_field": "alter_mietvertrag"}), ["alter_mietvertrag"])
		self.assertEqual(h.declared_inputs({}), [])

	def test_check_uses_not_null_fields(self):
		# ToDo: description gesetzt, date leer -> deterministisch.
		todo = frappe.get_doc({"doctype": "ToDo", "description": "x"}).insert(ignore_permissions=True)
		try:
			h = FillFieldsTaskHandler()
			doc = _FakeDoc({"obj": todo.name})

			# not_null auf leerem Feld (reference_name, kein Default) -> nicht erfuellt + run_action wirft
			row_missing = _FakeRow({
				"source_field": "obj", "input_doctype": "ToDo",
				"fields": [{"fieldname": "reference_name", "not_null": 1}],
			})
			self.assertFalse(h.is_fulfilled(None, doc, row_missing).fulfilled)
			with self.assertRaises(frappe.ValidationError):
				h.run_action(None, doc, row_missing)
			self.assertNotEqual(row_missing.status, "Erledigt")

			# not_null auf gesetztem Feld (description) -> erfuellt + run_action schliesst ab
			row_ok = _FakeRow({
				"source_field": "obj", "input_doctype": "ToDo",
				"fields": [{"fieldname": "description", "not_null": 1}],
			})
			self.assertTrue(h.is_fulfilled(None, doc, row_ok).fulfilled)
			res = h.run_action(None, doc, row_ok)
			self.assertTrue(res.get("ok"))
			self.assertEqual(row_ok.status, "Erledigt")
		finally:
			frappe.delete_doc("ToDo", todo.name, force=True, ignore_permissions=True)

	def test_not_marked_fields_not_enforced(self):
		todo = frappe.get_doc({"doctype": "ToDo", "description": "x"}).insert(ignore_permissions=True)
		try:
			h = FillFieldsTaskHandler()
			doc = _FakeDoc({"obj": todo.name})
			# reference_name leer, aber not_null=0 -> nicht erzwungen -> erfuellt
			row = _FakeRow({
				"source_field": "obj", "input_doctype": "ToDo",
				"fields": [{"fieldname": "reference_name", "not_null": 0}],
			})
			self.assertTrue(h.is_fulfilled(None, doc, row).fulfilled)
		finally:
			frappe.delete_doc("ToDo", todo.name, force=True, ignore_permissions=True)

	def test_runtime_actions_navigate_and_complete(self):
		todo = frappe.get_doc({"doctype": "ToDo", "description": "x"}).insert(ignore_permissions=True)
		try:
			h = FillFieldsTaskHandler()
			doc = _FakeDoc({"obj": todo.name})
			row = _FakeRow({
				"source_field": "obj", "input_doctype": "ToDo",
				"fields": [{"fieldname": "date", "not_null": 1}],
			})
			actions = h.runtime_actions(None, doc, row)
			keys = {a["key"] for a in actions}
			self.assertIn("open_object", keys)
			self.assertIn("complete", keys)
			nav = next(a for a in actions if a["key"] == "open_object")
			self.assertEqual(nav["navigate"]["target"], {"doctype": "ToDo", "name": todo.name})
			comp = next(a for a in actions if a["key"] == "complete")
			self.assertEqual(comp["_dispatch"], "run_python_task")
		finally:
			frappe.delete_doc("ToDo", todo.name, force=True, ignore_permissions=True)


class TestFillFieldsInputSync(FrappeTestCase):
	"""declared_inputs -> beim Speichern wird payload_input automatisch angelegt."""

	def setUp(self):
		super().setUp()
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

	def test_payload_input_auto_created(self):
		typ_name = f"_ff_{uuid.uuid4().hex[:8]}"
		typ = frappe.get_doc({
			"doctype": "Prozess Typ", "name1": typ_name, "label": "FF",
			"is_active": 1, "default_process_type": "Beide",
		}).insert(ignore_permissions=True)
		version = frappe.get_doc({
			"doctype": "Prozess Version", "version_key": f"v1-{typ_name}", "titel": "FF v1",
			"prozess_typ": typ_name, "runtime_doctype": "Prozess Instanz", "is_active": 0,
			"payload_field_specs": [
				{"fieldname": "obj", "label": "Objekt", "fieldtype": "Link", "options": "ToDo"},
			],
			"schritte": [{
				"step_key": "fill", "titel": "Ausfuellen", "task_type": TASK_TYPE_FILL_FIELDS,
				"pflicht": 1, "sichtbar_fuer_prozess_typ": "Beide", "reihenfolge": 10,
				"konfig_json": json.dumps({
					"source_field": "obj", "input_doctype": "ToDo",
					"fields": [{"fieldname": "date", "not_null": 1}],
				}),
			}],
			# KEINE schritt_io -> payload_input(obj) muss automatisch entstehen
		}).insert(ignore_permissions=True)
		try:
			version.reload()
			io = [(r.step_key, r.kind, r.target) for r in version.schritt_io]
			self.assertIn(("fill", "payload_input", "obj"), io)
		finally:
			frappe.delete_doc("Prozess Version", version.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)
