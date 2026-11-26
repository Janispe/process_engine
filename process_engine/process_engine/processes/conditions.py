"""Declarative conditions over document and payload values."""

import json
import operator
import re
from collections.abc import Mapping
from datetime import date, datetime
from math import isfinite

_ORDER = {">": operator.gt, "<": operator.lt, ">=": operator.ge, "<=": operator.le}
_EMPTY = {"is_empty", "is_not_empty"}
_OPERATORS = _EMPTY | _ORDER.keys() | {
	"==", "!=", "contains", "not_contains", "starts_with", "ends_with", "in",
}
_FIELD = re.compile(r"(doc|payload)(\.[A-Za-z][A-Za-z0-9_]*)+")
_MISSING = object()


def _scalar(value):
	return type(value) in (str, bool, int, type(None)) or (
		type(value) is float and isfinite(value)
	)


def parse(raw):
	if raw is None or isinstance(raw, str) and not raw.strip():
		return "all", []
	try:
		data = json.loads(raw)
	except (ValueError, TypeError, RecursionError) as exc:
		raise ValueError("Gültiges JSON erwartet.") from exc
	if not isinstance(data, dict) or len(data) != 1:
		raise ValueError("Ein Objekt mit genau einer Verknüpfung (all oder any) erwartet.")
	group, rules = next(iter(data.items()))
	if group not in {"all", "any"} or not isinstance(rules, list):
		raise ValueError("all oder any muss eine Liste von Bedingungen enthalten.")
	for index, rule in enumerate(rules, 1):
		prefix = f"Bedingung {index}"
		if not isinstance(rule, dict):
			raise ValueError(f"{prefix}: Objekt erwartet.")
		field, op = rule.get("field"), rule.get("op")
		if not isinstance(field, str) or not _FIELD.fullmatch(field):
			raise ValueError(f"{prefix}: Feldpfad doc.<feld> oder payload.<feld> erwartet.")
		if not isinstance(op, str) or op not in _OPERATORS:
			raise ValueError(f"{prefix}: Unbekannter Operator.")
		keys = {"field", "op"} if op in _EMPTY else {"field", "op", "value"}
		if set(rule) != keys:
			raise ValueError(f"{prefix}: Erwartete Felder: {', '.join(sorted(keys))}.")
		value = rule.get("value")
		if op == "in":
			valid = isinstance(value, list) and all(_scalar(item) for item in value)
		elif op in {"starts_with", "ends_with"}:
			valid = isinstance(value, str)
		elif op in _ORDER:
			valid = _scalar(value) and type(value) in (str, int, float)
		else:
			valid = _scalar(value)
		if not valid:
			raise ValueError(f"{prefix}: Ungültiger Vergleichswert für {op}.")
	return group, rules


def validate_row(row, *fields):
	import frappe

	for field in fields:
		try:
			parse(row.get(field))
		except ValueError as exc:
			frappe.throw(f"Zeile {row.idx} ({row.get('step_key') or row.get('key')}), {field}: {exc}")


def _lookup(document, payload, path):
	root, *keys = path.split(".")
	value = document if root == "doc" else payload
	for key in keys:
		if not isinstance(value, Mapping):
			return _MISSING
		value = value.get(key, _MISSING)
	return value


def _comparable(left, right):
	if isinstance(left, datetime):
		return left, datetime.fromisoformat(right) if isinstance(right, str) else right
	if isinstance(left, date):
		return left, date.fromisoformat(right) if isinstance(right, str) else right
	if isinstance(left, str) and isinstance(right, str):
		if re.fullmatch(r"\d{4}-\d{2}-\d{2}", left) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", right):
			return date.fromisoformat(left), date.fromisoformat(right)
		return left, right
	return left, right


def _equal(left, right):
	try:
		left, right = _comparable(left, right)
	except ValueError:
		return False
	if type(left) is bool or type(right) is bool:
		return type(left) is type(right) and left == right
	return left == right


def _matches(document, payload, rule):
	left = _lookup(document, payload, rule["field"])
	op = rule["op"]
	empty = left is _MISSING or left is None or left == "" or left == [] or left == {}
	if op in _EMPTY:
		return empty if op == "is_empty" else not empty
	if left is _MISSING:
		return False
	right = rule["value"]
	if op in _ORDER:
		try:
			left, right = _comparable(left, right)
			if isinstance(left, (str, date)) or type(left) in (int, float) and type(right) in (int, float):
				return _ORDER[op](left, right)
		except (TypeError, ValueError):
			pass
		return False
	if op in {"==", "!="}:
		return _equal(left, right) if op == "==" else not _equal(left, right)
	if op == "in":
		return any(_equal(left, item) for item in right)
	if op in {"starts_with", "ends_with"}:
		return isinstance(left, str) and (
			left.startswith(right) if op == "starts_with" else left.endswith(right)
		)
	if isinstance(left, str) and isinstance(right, str):
		contains = right in left
	elif isinstance(left, list):
		contains = any(_equal(item, right) for item in left)
	else:
		return False
	return contains if op == "contains" else not contains


def matches(condition, document, payload):
	group, rules = condition
	return not rules or (all if group == "all" else any)(
		_matches(document, payload, rule) for rule in rules
	)


def document_values(doc):
	# Frappe's stored fields, including nested child data.
	return doc.as_dict() if hasattr(doc, "as_dict") else doc


def process_payload(doc):
	raw = doc.get("payload_json")
	if not raw:
		return {}
	try:
		payload = json.loads(raw) if isinstance(raw, str) else raw
	except ValueError:
		return {}
	return payload if isinstance(payload, dict) else {}
