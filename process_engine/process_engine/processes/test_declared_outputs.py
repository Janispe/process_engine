from __future__ import annotations

import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from process_engine.process_engine.processes.task_registry import (
	CreateLinkedDocTaskHandler,
	DeriveTaskHandler,
	PythonActionTaskHandler,
)


class TestDeclaredOutputs(FrappeTestCase):
	"""Unit: jeder Aufgabentyp leitet seine Outputs aus der Config ab (typ-getrieben)."""

	def test_create_linked_doc(self):
		outs = CreateLinkedDocTaskHandler().declared_outputs(
			{"store_in_payload_field": "neuer_vertrag", "target_doctype": "Mietvertrag"}
		)
		self.assertEqual(outs, [{"fieldname": "neuer_vertrag", "fieldtype": "Link", "options": "Mietvertrag"}])

	def test_create_linked_doc_empty(self):
		self.assertEqual(CreateLinkedDocTaskHandler().declared_outputs({}), [])

	def test_derive_type_from_path(self):
		# DocType.module ist Link->Module Def -> Output erbt diesen Typ.
		outs = DeriveTaskHandler().declared_outputs(
			{"store_in_payload_field": "modul", "source_doctype": "DocType", "path": "module"}
		)
		self.assertEqual(outs, [{"fieldname": "modul", "fieldtype": "Link", "options": "Module Def"}])

	def test_python_action_outputs_json(self):
		outs = PythonActionTaskHandler().declared_outputs(
			{"outputs": json.dumps([{"fieldname": "a", "fieldtype": "Date"}, {"bad": 1}])}
		)
		self.assertEqual(outs, [{"fieldname": "a", "fieldtype": "Date", "options": ""}])

	def test_python_action_outputs_invalid(self):
		self.assertEqual(PythonActionTaskHandler().declared_outputs({"outputs": "{kaputt"}), [])
		self.assertEqual(PythonActionTaskHandler().declared_outputs({}), [])


class TestSyncDeclaredOutputs(FrappeTestCase):
	"""Integration: beim Versions-Speichern entstehen Output-Spec (auto_output=1) + payload_output
	automatisch aus der Schritt-Config — ohne manuelles Feld-Anlegen; veraltete werden entfernt."""

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

	def _make(self, store_field):
		typ_name = f"_do_{uuid.uuid4().hex[:8]}"
		typ = frappe.get_doc({
			"doctype": "Prozess Typ", "name1": typ_name, "label": "DO",
			"is_active": 1, "default_process_type": "Beide",
		}).insert(ignore_permissions=True)
		version = frappe.get_doc({
			"doctype": "Prozess Version", "version_key": f"v1-{typ_name}", "titel": "DO v1",
			"prozess_typ": typ_name, "runtime_doctype": "Prozess Instanz", "is_active": 0,
			# KEINE payload_field_specs, KEINE schritt_io -> muessen aus der Config entstehen
			"schritte": [{
				"step_key": "anlegen", "titel": "Anlegen", "task_type": "create_linked_doc",
				"pflicht": 1, "sichtbar_fuer_prozess_typ": "Beide", "reihenfolge": 10,
				"konfig_json": json.dumps({"target_doctype": "ToDo", "store_in_payload_field": store_field}),
			}],
		}).insert(ignore_permissions=True)
		return typ, version

	def test_output_spec_and_io_auto_created(self):
		typ, version = self._make("erzeugte_aufgabe")
		try:
			version.reload()
			specs = {s.fieldname: s for s in version.payload_field_specs}
			self.assertIn("erzeugte_aufgabe", specs, "Output-Spec wurde nicht automatisch angelegt")
			self.assertEqual(specs["erzeugte_aufgabe"].fieldtype, "Link")
			self.assertEqual(specs["erzeugte_aufgabe"].options, "ToDo")
			self.assertEqual(int(specs["erzeugte_aufgabe"].auto_output), 1)
			io = [(r.step_key, r.kind, r.target) for r in version.schritt_io]
			self.assertIn(("anlegen", "payload_output", "erzeugte_aufgabe"), io)
		finally:
			frappe.delete_doc("Prozess Version", version.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)

	def test_stale_output_removed_on_config_change(self):
		typ, version = self._make("alt_feld")
		try:
			version.reload()
			self.assertIn("alt_feld", {s.fieldname for s in version.payload_field_specs})
			# Config aendern: anderer Output-Name
			version.schritte[0].konfig_json = json.dumps({"target_doctype": "ToDo", "store_in_payload_field": "neu_feld"})
			version.save(ignore_permissions=True)
			version.reload()
			names = {s.fieldname for s in version.payload_field_specs}
			self.assertNotIn("alt_feld", names, "veraltetes Auto-Output blieb stehen")
			self.assertIn("neu_feld", names)
			io_targets = {(r.step_key, r.target) for r in version.schritt_io if r.kind == "payload_output"}
			self.assertIn(("anlegen", "neu_feld"), io_targets)
			self.assertNotIn(("anlegen", "alt_feld"), io_targets)
		finally:
			frappe.delete_doc("Prozess Version", version.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)

	def test_manual_payload_output_preserved(self):
		# Regression: ein Handler OHNE declared_outputs (python_action) mit MANUELL deklariertem
		# payload_output (auto_output=0) darf von _sync NICHT entfernt werden (sonst bricht z.B.
		# die set_flag-Validierung 'target_field muss payload_output sein').
		typ_name = f"_do_{uuid.uuid4().hex[:8]}"
		typ = frappe.get_doc({
			"doctype": "Prozess Typ", "name1": typ_name, "label": "DO",
			"is_active": 1, "default_process_type": "Beide",
		}).insert(ignore_permissions=True)
		version = frappe.get_doc({
			"doctype": "Prozess Version", "version_key": f"v1-{typ_name}", "titel": "DO v1",
			"prozess_typ": typ_name, "runtime_doctype": "Prozess Instanz", "is_active": 0,
			"payload_field_specs": [
				{"fieldname": "manuelles_flag", "label": "Flag", "fieldtype": "Check"},
			],
			"schritte": [{
				"step_key": "py", "titel": "Py", "task_type": "python_action", "handler_key": "test.set_flag",
				"pflicht": 1, "sichtbar_fuer_prozess_typ": "Beide", "reihenfolge": 10,
				"konfig_json": json.dumps({"target_field": "manuelles_flag"}),
			}],
			# set_flag-Validierung verlangt target_field als payload_output -> muss _sync ueberleben.
			"schritt_io": [{"step_key": "py", "kind": "payload_output", "target": "manuelles_flag"}],
		}).insert(ignore_permissions=True)
		try:
			version.reload()
			io = [(r.step_key, r.kind, r.target) for r in version.schritt_io]
			self.assertIn(("py", "payload_output", "manuelles_flag"), io, "manueller Output wurde entfernt")
			specs = {s.fieldname: s for s in version.payload_field_specs}
			self.assertEqual(int(specs["manuelles_flag"].auto_output or 0), 0, "manuell darf nicht auto_output werden")
		finally:
			frappe.delete_doc("Prozess Version", version.name, force=True, ignore_permissions=True)
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)
