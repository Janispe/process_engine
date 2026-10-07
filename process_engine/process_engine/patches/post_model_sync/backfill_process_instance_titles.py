"""Populate distinct process display titles without saving workflow documents."""

from __future__ import annotations

import frappe

from process_engine.process_engine.patches.post_model_sync.configure_document_titles import _configure_display
from process_engine.process_engine.processes.instance_titles import build_instance_title


def execute():
	_configure_display(
		"Prozess Instanz", "prozess_instanz", "bezeichnung", "bezeichnung,prozess_typ,quelle_name"
	)
	for row in frappe.get_all(
		"Prozess Instanz",
		fields=[
			"name",
			"prozess_typ",
			"label_cached",
			"quelle_doctype",
			"quelle_name",
			"payload_json",
			"bezeichnung",
		],
	):
		title = build_instance_title(row)
		if row.bezeichnung != title:
			# No save/submit: do not run workflow, archive or other document hooks.
			frappe.db.set_value("Prozess Instanz", row.name, "bezeichnung", title, update_modified=False)
