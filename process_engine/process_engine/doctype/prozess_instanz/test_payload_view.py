from __future__ import annotations

import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from process_engine.process_engine.doctype.prozess_instanz.prozess_instanz import (
	get_instance_payload_view,
)


class TestInstancePayloadView(FrappeTestCase):
	"""Laufzeit-Kontext-Panel: get_instance_payload_view joint Werte + Typen."""

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

	def test_payload_view_joins_values_and_types(self):
		typ_name = f"_pv_{uuid.uuid4().hex[:8]}"
		typ = frappe.get_doc({
			"doctype": "Prozess Typ", "name1": typ_name, "label": "PV",
			"is_active": 1, "default_process_type": "Beide",
		}).insert(ignore_permissions=True)
		version = frappe.get_doc({
			"doctype": "Prozess Version", "version_key": f"v1-{typ_name}", "titel": "PV v1",
			"prozess_typ": typ_name, "runtime_doctype": "Prozess Instanz", "is_active": 1,
			"payload_field_specs": [
				{"fieldname": "alter_mietvertrag", "label": "Alter Vertrag", "fieldtype": "Link", "options": "DocType"},
				{"fieldname": "notiz", "label": "Notiz", "fieldtype": "Data"},
			],
			"schritte": [{
				"step_key": "s1", "titel": "Check", "task_type": "manual_check",
				"pflicht": 1, "sichtbar_fuer_prozess_typ": "Beide", "reihenfolge": 10,
			}],
			"schritt_io": [
				{"step_key": "s1", "kind": "payload_input", "target": "alter_mietvertrag"},
				{"step_key": "s1", "kind": "payload_input", "target": "notiz"},
			],
		}).insert(ignore_permissions=True)
		inst = frappe.get_doc({
			"doctype": "Prozess Instanz", "prozess_typ": typ_name,
			"payload_json": json.dumps({"alter_mietvertrag": "User"}),  # notiz bewusst leer
		}).insert(ignore_permissions=True)
		try:
			view = get_instance_payload_view(inst.name)
			by = {e["fieldname"]: e for e in view}

			# Link-Feld: typ-angereichert + klickbar-bereit
			self.assertEqual(by["alter_mietvertrag"]["fieldtype"], "Link")
			self.assertEqual(by["alter_mietvertrag"]["link_doctype"], "DocType")
			self.assertEqual(by["alter_mietvertrag"]["value"], "User")
			self.assertTrue(by["alter_mietvertrag"]["is_set"])

			# Scalar, nicht gesetzt
			self.assertEqual(by["notiz"]["fieldtype"], "Data")
			self.assertEqual(by["notiz"]["link_doctype"], "")
			self.assertFalse(by["notiz"]["is_set"])
		finally:
			frappe.delete_doc("Prozess Instanz", inst.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Version", version.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)
