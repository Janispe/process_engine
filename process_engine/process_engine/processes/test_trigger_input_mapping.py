from __future__ import annotations

from frappe.tests.utils import FrappeTestCase

from process_engine.process_engine.processes.engine import ProcessTrigger
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
