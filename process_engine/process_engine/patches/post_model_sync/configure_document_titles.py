"""Show readable process titles while keeping document IDs and references stable."""

from __future__ import annotations

import frappe


def execute():
	_configure_display("Prozess Instanz", "prozess_instanz", "label_cached", "label_cached,prozess_typ,quelle_name")
	_configure_display("Prozess Version", "prozess_version", "titel", "titel,version_key,prozess_typ")

	# Fill only missing cached labels; save/submit would run process side effects.
	for row in frappe.get_all(
		"Prozess Instanz", filters={"label_cached": ["is", "not set"]}, fields=["name", "prozess_typ"]
	):
		label = frappe.db.get_value("Prozess Typ", row.prozess_typ, "label") if row.prozess_typ else None
		if label:
			frappe.db.set_value("Prozess Instanz", row.name, "label_cached", label, update_modified=False)


def _configure_display(doctype, docname, title_field, search_fields):
	frappe.reload_doc("process_engine", "doctype", docname, force=True)
	properties = {
		"title_field": (title_field, "Data"),
		"show_title_field_in_link": ("1", "Check"),
		"search_fields": (search_fields, "Data"),
	}
	# Existing overrides must agree with these display properties. Keep their IDs
	# and unrelated customizations intact instead of deleting Property Setters.
	for row in frappe.get_all(
		"Property Setter",
		filters={"doc_type": doctype, "doctype_or_field": "DocType", "property": ["in", list(properties)]},
		fields=["name", "property", "value", "property_type"],
	):
		value, property_type = properties[row.property]
		if str(row.value or "") != value or row.property_type != property_type:
			frappe.db.set_value(
				"Property Setter", row.name, {"value": value, "property_type": property_type}, update_modified=False
			)
	frappe.clear_cache(doctype=doctype)
