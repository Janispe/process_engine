from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase

from process_engine.process_engine.processes.path_resolver import (
	get_path_options,
	resolve_path,
	validate_path,
)

# Deterministische Fixtures aus dem Frappe-Core: jede DocType-Zeile hat ein Link-Feld
# `module` (-> Module Def). Die DocType "User" liegt im Modul "Core". Damit sind
# stored-Link, Drilldown und Standardfeld ohne Domaenen-Daten testbar.


class TestPathResolver(FrappeTestCase):
	def test_stored_link_field(self):
		self.assertEqual(resolve_path("DocType", "User", "module"), "Core")

	def test_standard_field_name(self):
		# `name` steht nicht in meta.get_field(), muss aber als gespeichertes Scalar gehen.
		self.assertEqual(resolve_path("DocType", "User", "name"), "User")

	def test_link_drilldown_to_standard_field(self):
		# Link weiterverfolgen: DocType.module (-> Module Def) .name
		self.assertEqual(resolve_path("DocType", "User", "module.name"), "Core")

	def test_empty_inputs_return_none(self):
		self.assertIsNone(resolve_path("DocType", "", "module"))
		self.assertIsNone(resolve_path("", "User", "module"))
		self.assertIsNone(resolve_path("DocType", "User", ""))

	def test_unknown_field_raises(self):
		with self.assertRaises(frappe.ValidationError):
			resolve_path("DocType", "User", "gibt_es_nicht_xyz")

	def test_non_link_midpath_raises(self):
		# `module` ist Link, aber `autoname` (Data) mitten im Pfad darf nicht gedrillt werden.
		with self.assertRaises(frappe.ValidationError):
			resolve_path("DocType", "User", "autoname.foo")

	def test_get_path_options_lists_link_field(self):
		opts = get_path_options("DocType")
		self.assertEqual(opts["doctype"], "DocType")
		by_name = {f["fieldname"]: f for f in opts["fields"]}
		self.assertIn("module", by_name)
		module = by_name["module"]
		self.assertTrue(module["is_link"])
		self.assertEqual(module["options"], "Module Def")
		# Layout-Felder (Section/Column Break) sind herausgefiltert.
		self.assertFalse(any(f["fieldtype"] in ("Section Break", "Column Break") for f in opts["fields"]))

	def test_get_path_options_drilldown_prefix(self):
		# path_prefix folgt dem Link bis zum Ziel-Doctype.
		opts = get_path_options("DocType", path_prefix="module")
		self.assertEqual(opts["doctype"], "Module Def")

	def test_get_path_options_marks_virtual_when_present(self):
		# is_virtual muss als Flag durchgereicht werden (Doctype mit virtuellem Feld
		# verwenden, falls vorhanden — sonst ueberspringen, kein Core-Garant).
		if not frappe.db.exists("DocType", "Wohnung"):
			self.skipTest("Domaenen-Doctype 'Wohnung' nicht installiert")
		opts = get_path_options("Wohnung")
		am = next((f for f in opts["fields"] if f["fieldname"] == "aktueller_mietvertrag"), None)
		self.assertIsNotNone(am, "aktueller_mietvertrag sollte gelistet sein")
		self.assertEqual(am["is_virtual"], 1)
		self.assertTrue(am["is_link"])
		self.assertEqual(am["options"], "Mietvertrag")

	# ----- validate_path -----

	def test_validate_path_ok(self):
		validate_path("DocType", "module")          # Link, terminal
		validate_path("DocType", "module.name")     # Link -> Standardfeld terminal

	def test_validate_path_unknown_field_raises(self):
		with self.assertRaises(frappe.ValidationError):
			validate_path("DocType", "gibt_es_nicht_xyz")

	def test_validate_path_nonlink_midpath_raises(self):
		with self.assertRaises(frappe.ValidationError):
			validate_path("DocType", "autoname.foo")  # autoname ist Data, kein Link

	def test_validate_path_unknown_doctype_raises(self):
		with self.assertRaises(frappe.ValidationError):
			validate_path("Gibt Es Nicht XYZ", "feld")

	# ----- Permission-Enforcement (Finding High) -----

	def test_resolve_path_denies_without_read_permission(self):
		# Als Guest (keine Read-Permission auf User) muss resolve_path hart werfen,
		# auch fuer gespeicherte Felder (nicht nur virtuelle).
		frappe.set_user("Guest")
		try:
			with self.assertRaises(frappe.PermissionError):
				resolve_path("User", "Administrator", "email")
		finally:
			frappe.set_user("Administrator")
