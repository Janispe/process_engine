"""Process display titles based on explicit references and the instance's own ID."""

from __future__ import annotations

import json

from frappe.utils import cstr

TITLE_MAX_LENGTH = 140
SEPARATOR = " · "


def build_instance_title(doc) -> str:
	"""Build a display value without resolving, modifying or guessing references.

	Source IDs are stable. Source titles deliberately are not fetched, so changing
	a property or tenant label does not leave this cached title out of date.
	"""
	process_label = _text(doc.get("label_cached")) or _text(doc.get("prozess_typ")) or "Prozess"
	source_type = _text(doc.get("quelle_doctype"))
	source_name = _text(doc.get("quelle_name"))
	if source_type and source_name:
		context = f"{source_type} {source_name}"
	else:
		wohnung = _explicit_wohnung(doc.get("payload_json"))
		context = f"Wohnung {wohnung}" if wohnung else ""

	prefix = SEPARATOR.join(part for part in (process_label, context) if part)
	identifier = cstr(doc.get("name")).strip()
	if not identifier:
		return prefix[:TITLE_MAX_LENGTH].rstrip()

	# Preserve the complete ID even when an old source name or type label is long.
	available = TITLE_MAX_LENGTH - len(identifier) - len(SEPARATOR)
	if available <= 0:
		return identifier
	return prefix[:available].rstrip() + SEPARATOR + identifier


def _text(value) -> str:
	return " ".join(cstr(value).split())


def _explicit_wohnung(raw) -> str:
	if not isinstance(raw, str) or not raw.strip():
		return ""
	try:
		payload = json.loads(raw)
	except ValueError:
		return ""
	if not isinstance(payload, dict):
		return ""
	wohnung = payload.get("wohnung")
	return _text(wohnung) if isinstance(wohnung, str) else ""
