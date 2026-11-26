import json
import unittest
from datetime import date

from .conditions import matches, parse


class TestConditions(unittest.TestCase):
	def check(self, op, value=None, *, field="payload.value", expected=True, actual=None):
		rule = {"field": field, "op": op}
		if op not in {"is_empty", "is_not_empty"}:
			rule["value"] = value
		self.assertEqual(matches(parse(json.dumps({"all": [rule]})), {"child": {"value": actual}}, {"value": actual}), expected)

	def test_comparisons(self):
		for op, actual, value in (
			("==", "an", "an"), ("!=", "an", "aus"), ("contains", "Email", "mail"),
			("not_contains", "Email", "x"), ("contains", [1, 2], 2),
			("starts_with", "Email", "Em"), ("ends_with", "Email", "il"), ("in", "DE", ["DE", "AT"]),
			(">", 10, 2), ("<", date(2026, 11, 26), "2026-12-01"),
			(">=", "2026-11-26", "2026-11-26"), ("<=", "a", "b"),
		):
			with self.subTest(op=op):
				self.check(op, value, actual=actual)
		self.check(">", 2, actual="10", expected=False)
		self.check("==", 1, actual=True, expected=False)
		self.check("contains", "Email", actual="mail", expected=False)
		self.check("==", "verschachtelt", field="doc.child.value", actual="verschachtelt")

	def test_missing_and_empty(self):
		self.check("is_empty", actual="")
		self.check("is_empty", field="payload.missing")
		self.check("is_not_empty", actual=0)
		self.check("is_not_empty", field="payload.missing", expected=False)
		self.check("!=", "x", field="payload.missing", expected=False)

	def test_groups_and_validation(self):
		rules = [{"field": "doc.x", "op": "==", "value": 1}, {"field": "doc.x", "op": "==", "value": 2}]
		self.assertTrue(matches(parse(json.dumps({"any": rules})), {"x": 2}, {}))
		self.assertFalse(matches(parse(json.dumps({"all": rules})), {"x": 2}, {}))
		for raw in (None, "  ", '{"all":[]}', '{"any":[]}'):
			self.assertTrue(matches(parse(raw), {}, {}))
		for raw in ("{", "null", "{}", '{"all":[{"field":"payload._private","op":"is_empty"}]}',
			'{"any":[{"field":"doc.value","op":"in","value":"abc"}]}',
			'{"all":[{"field":"doc.value","op":"python","value":"1"}]}'):
			with self.subTest(raw=raw), self.assertRaises(ValueError):
				parse(raw)
