from __future__ import annotations

import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from process_engine.process_engine.processes.engine import (
	ProcessTrigger,
	get_runtime_config_for_typ,
)
from process_engine.process_engine.processes.triggers import _apply_trigger_input_mapping

# Deterministisch ohne Domaenen-Daten: DocType "User" liegt im Modul "Core".


class TestTriggerInputMapping(FrappeTestCase):
	def _trigger(self, mapping):
		return ProcessTrigger(key="t", source_doctype="DocType", button_label="x", input_mapping=mapping)

	def test_path_fixed_manual_none(self):
		t = self._trigger({
			"a": {"kind": "path", "path": "module"},
			"b": {"kind": "fixed", "value": 42},
			"c": {"kind": "manual"},
			"d": {"kind": "none"},
		})
		out = _apply_trigger_input_mapping(t, "User", {"base": 1})
		self.assertEqual(out["base"], 1)   # payload_builder-Basis bleibt erhalten
		self.assertEqual(out["a"], "Core")  # path -> resolve_path(DocType, User, module)
		self.assertEqual(out["b"], 42)      # fixed
		self.assertNotIn("c", out)          # manual -> nicht gesetzt
		self.assertNotIn("d", out)          # none -> nicht gesetzt

	def test_path_drilldown(self):
		t = self._trigger({"x": {"kind": "path", "path": "module.name"}})
		out = _apply_trigger_input_mapping(t, "User", {})
		self.assertEqual(out["x"], "Core")

	def test_mapping_overrides_builder(self):
		t = self._trigger({"a": {"kind": "fixed", "value": "MAP"}})
		out = _apply_trigger_input_mapping(t, "User", {"a": "BUILDER"})
		self.assertEqual(out["a"], "MAP")

	def test_no_mapping_passthrough(self):
		t = ProcessTrigger(key="t", source_doctype="DocType", button_label="x")
		out = _apply_trigger_input_mapping(t, "User", {"a": 1})
		self.assertEqual(out, {"a": 1})

	def test_manual_removes_builder_value(self):
		t = self._trigger({"a": {"kind": "manual"}})
		out = _apply_trigger_input_mapping(t, "User", {"a": "BUILDER", "b": 2})
		self.assertNotIn("a", out)   # manual -> Builder-Wert entfernt
		self.assertEqual(out["b"], 2)

	def test_none_removes_builder_value(self):
		t = self._trigger({"a": {"kind": "none"}})
		out = _apply_trigger_input_mapping(t, "User", {"a": "BUILDER"})
		self.assertNotIn("a", out)

	def test_empty_kind_keeps_builder_value(self):
		t = self._trigger({"a": {"kind": ""}})
		out = _apply_trigger_input_mapping(t, "User", {"a": "BUILDER"})
		self.assertEqual(out["a"], "BUILDER")  # No-Op


class TestDbTriggerInputMapping(FrappeTestCase):
	"""DB-Trigger (Prozess Typ): input_mapping_json wird in ProcessTrigger.input_mapping geparst."""

	def test_get_runtime_config_parses_input_mapping_json(self):
		typ_name = f"_tim_{uuid.uuid4().hex[:8]}"
		typ = frappe.get_doc({
			"doctype": "Prozess Typ", "name1": typ_name, "label": "TIM Test",
			"is_active": 1, "default_process_type": "Beide",
			"triggers": [{
				"key": "from_wohnung", "source_doctype": "Wohnung", "button_label": "Start",
				"input_mapping_json": json.dumps({
					"alter_mietvertrag": {"kind": "path", "path": "aktueller_mietvertrag"},
					"prozess_typ": {"kind": "fixed", "value": "mieterwechsel"},
				}),
			}],
		}).insert(ignore_permissions=True)
		try:
			cfg = get_runtime_config_for_typ(typ.name)
			self.assertIsNotNone(cfg)
			trig = next(t for t in cfg.triggers if t.key == "from_wohnung")
			self.assertEqual(trig.input_mapping["alter_mietvertrag"], {"kind": "path", "path": "aktueller_mietvertrag"})
			self.assertEqual(trig.input_mapping["prozess_typ"], {"kind": "fixed", "value": "mieterwechsel"})
		finally:
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)

	def test_invalid_input_mapping_json_is_none(self):
		typ_name = f"_tim_{uuid.uuid4().hex[:8]}"
		typ = frappe.get_doc({
			"doctype": "Prozess Typ", "name1": typ_name, "label": "TIM Bad",
			"is_active": 1, "default_process_type": "Beide",
			"triggers": [{
				"key": "from_wohnung", "source_doctype": "Wohnung", "button_label": "Start",
				"input_mapping_json": "{ kaputt",  # ungueltiges JSON
			}],
		}).insert(ignore_permissions=True)
		try:
			cfg = get_runtime_config_for_typ(typ.name)
			trig = next(t for t in cfg.triggers if t.key == "from_wohnung")
			self.assertIsNone(trig.input_mapping)
		finally:
			frappe.delete_doc("Prozess Typ", typ.name, force=True, ignore_permissions=True)
