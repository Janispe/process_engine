"""Tests fuer die selbstbeschreibende Task-UI (Phasen A-E).

Unit-Tests fuer die reinen Funktionen (Handler-Defaults, navigate/task_view-Sanitizing,
create_linked-Dialogfelder) + ein Integrationstest, der eine minimale Prozess Instanz baut
und die Whitelist-Endpoints prueft (runtime_actions-Shape, get_task_views, Dialog-Allowlist).
"""

from __future__ import annotations

import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from process_engine.process_engine.doctype.prozess_instanz.prozess_instanz import (
	_sanitize_navigate,
	_sanitize_task_view,
	get_task_action_dialog,
	get_task_runtime_actions,
	get_task_views,
)
from process_engine.process_engine.processes.task_registry import (
	BaseTaskHandler,
	CreateLinkedDocTaskHandler,
)


class TestTaskSelfDescriptionUnit(FrappeTestCase):
	def test_base_handler_defaults(self):
		h = BaseTaskHandler()
		self.assertEqual(h.action_dialog_fields(None, None, None, "x"), {"fields": []})
		self.assertIsNone(h.task_view(None, None, None))

	def test_sanitize_navigate_allowlist(self):
		# Gueltige Arten
		self.assertEqual(
			_sanitize_navigate({"kind": "route", "target": ["List", "ToDo"]}),
			{"kind": "route", "target": ["List", "ToDo"]},
		)
		self.assertEqual(
			_sanitize_navigate({"kind": "form", "target": {"doctype": "ToDo", "name": "X"}}),
			{"kind": "form", "target": {"doctype": "ToDo", "name": "X"}},
		)
		self.assertEqual(
			_sanitize_navigate({"kind": "url", "target": "/app/todo"}),
			{"kind": "url", "target": "/app/todo"},
		)
		# Ungueltig -> None
		self.assertIsNone(_sanitize_navigate(None))
		self.assertIsNone(_sanitize_navigate({"kind": "exec", "target": "x"}))  # nicht in Allowlist
		self.assertIsNone(_sanitize_navigate({"kind": "route", "target": "kein-array"}))
		self.assertIsNone(_sanitize_navigate({"kind": "form", "target": {"doctype": "ToDo"}}))  # name fehlt
		self.assertIsNone(_sanitize_navigate({"kind": "url", "target": ""}))

	def test_sanitize_task_view(self):
		# component Pflicht
		self.assertIsNone(_sanitize_task_view(None))
		self.assertIsNone(_sanitize_task_view({"bundle": "/assets/x.js"}))
		# lokales Bundle erlaubt, props nur als dict
		self.assertEqual(
			_sanitize_task_view({"component": "c", "bundle": "/assets/app/js/x.js", "props": {"a": 1}}),
			{"component": "c", "bundle": "/assets/app/js/x.js", "props": {"a": 1}},
		)
		# externe URL als Bundle wird verworfen (component bleibt)
		out = _sanitize_task_view({"component": "c", "bundle": "https://evil.example/x.js"})
		self.assertEqual(out, {"component": "c"})
		# props nicht-dict wird ignoriert
		out2 = _sanitize_task_view({"component": "c", "props": "nope"})
		self.assertEqual(out2, {"component": "c"})

	def test_create_linked_action_dialog_fields(self):
		"""CreateLinkedDocTaskHandler.action_dialog_fields liest dialog_fields aus der Config und
		rendert prefill_mapping (Jinja) gegen payload_json als Defaults."""
		task_row = frappe._dict(
			doctype="Prozess Schritt",  # != 'Prozess Aufgabe' -> extract_task_config liest konfig_json
			konfig_json=json.dumps(
				{
					"target_doctype": "ToDo",
					"store_in_payload_field": "created_todo",
					"dialog_fields": [
						{"fieldname": "description", "fieldtype": "Data", "label": "Beschreibung"}
					],
					"prefill_mapping": {"description": "{{ payload.foo }}"},
				}
			),
		)
		doc = frappe._dict(payload_json=json.dumps({"foo": "bar"}))
		res = CreateLinkedDocTaskHandler().action_dialog_fields(None, doc, task_row, "create_linked")
		self.assertEqual(res["target_doctype"], "ToDo")
		self.assertEqual(len(res["fields"]), 1)
		self.assertEqual(res["fields"][0]["fieldname"], "description")
		self.assertEqual(res["fields"][0]["default"], "bar")  # Jinja-prefill gerendert
		# Falscher action_key -> keine Felder
		self.assertEqual(
			CreateLinkedDocTaskHandler().action_dialog_fields(None, doc, task_row, "andere")["fields"],
			[],
		)


class TestTaskSelfDescriptionIntegration(FrappeTestCase):
	def setUp(self):
		super().setUp()
		self._temporal_backup = {
			k: frappe.conf.get(k) for k in ("hv_temporal_enabled", "hv_temporal_enabled_doctypes")
		}
		frappe.conf.hv_temporal_enabled = False
		frappe.conf.hv_temporal_enabled_doctypes = ""

	def tearDown(self):
		for k, v in self._temporal_backup.items():
			if v is None:
				frappe.conf.pop(k, None)
			else:
				frappe.conf[k] = v
		super().tearDown()

	def _build_instance(self):
		typ_name = f"_selfdesc_{uuid.uuid4().hex[:8]}"
		typ = frappe.get_doc(
			{
				"doctype": "Prozess Typ",
				"name1": typ_name,
				"label": "Self-Desc Test",
				"is_active": 1,
				"default_process_type": "Beide",
			}
		).insert(ignore_permissions=True)
		version = frappe.get_doc(
			{
				"doctype": "Prozess Version",
				"version_key": f"v1-{typ_name}",
				"titel": "Self-Desc v1",
				"prozess_typ": typ_name,
				"runtime_doctype": "Prozess Instanz",
				"is_active": 1,
				"payload_field_specs": [
					{"fieldname": "sd_input", "label": "SD Input", "fieldtype": "Data"}
				],
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
				# Phase 9: Versionen mit Schritten brauchen explizite I/O-Deklarationen.
				"schritt_io": [
					{"step_key": "step_a", "kind": "payload_input", "target": "sd_input"}
				],
			}
		).insert(ignore_permissions=True)
		inst = frappe.get_doc(
			{"doctype": "Prozess Instanz", "prozess_typ": typ_name, "payload_json": "{}"}
		).insert(ignore_permissions=True)
		return typ, version, inst

	def test_runtime_actions_shape_and_views_and_dialog_allowlist(self):
		typ, version, inst = self._build_instance()
		try:
			row_name = inst.aufgaben[0].name

			# runtime_actions: jede Action traegt navigate + has_action (Phase D-Shape)
			actions = get_task_runtime_actions(inst.name)
			self.assertIn(row_name, actions)
			self.assertTrue(actions[row_name], "manual_check sollte mind. eine Action haben")
			for a in actions[row_name]:
				self.assertIn("navigate", a)
				self.assertIn("has_action", a)
			# Status-Toggle hat ein Dispatch-Ziel -> has_action True, keine Navigation
			set_done = next((a for a in actions[row_name] if a["key"] == "set_done"), None)
			self.assertIsNotNone(set_done)
			self.assertTrue(set_done["has_action"])
			self.assertIsNone(set_done["navigate"])

			# get_task_views: manual_check hat keine Custom-View -> None
			views = get_task_views(inst.name)
			self.assertIn(row_name, views)
			self.assertIsNone(views[row_name])

			# Dialog-Allowlist: unbekannter action_key wird abgelehnt
			with self.assertRaises(frappe.exceptions.ValidationError):
				get_task_action_dialog(inst.name, row_name, "bogus_action_xyz")
		finally:
			frappe.delete_doc("Prozess Instanz", inst.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Version", version.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)
