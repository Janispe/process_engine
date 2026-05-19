"""Spiegelt alte Patch-Log-Eintraege auf die neuen process_engine-Pfade.

Nach dem App-Extraction-Refactor wurden Patches von
`hausverwaltung.hausverwaltung.patches.post_model_sync.<name>` auf
`process_engine.process_engine.patches.post_model_sync.<name>` umgehaengt.
Ohne dieses Mirroring wuerde Frappe sie auf bestehenden Sites unter neuem
Pfad als "noch nicht ausgefuehrt" sehen und nochmal anstossen.

Idempotent + sicher fuer fresh installs: spiegelt nur, wenn der alte
Eintrag im Patch Log tatsaechlich existiert.
"""
from __future__ import annotations

import frappe


OLD_TO_NEW = {
	"hausverwaltung.hausverwaltung.patches.post_model_sync.move_payload_specs_to_version":
		"process_engine.process_engine.patches.post_model_sync.move_payload_specs_to_version",
}


def execute():
	for old, new in OLD_TO_NEW.items():
		if not frappe.db.exists("Patch Log", {"patch": old}):
			continue
		if frappe.db.exists("Patch Log", {"patch": new}):
			continue
		frappe.get_doc({"doctype": "Patch Log", "patch": new}).insert(ignore_permissions=True)
	frappe.db.commit()
