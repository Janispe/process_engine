"""Setzt tabDocType.module = 'Process Engine' fuer alle vom Engine-Refactoring
betroffenen DocTypes. Auf bestehenden Sites lagen sie bisher unter
module='Hausverwaltung'.

Idempotent: prueft pro DocType, ob die Aenderung noetig ist.
"""
from __future__ import annotations

import frappe


ENGINE_DOCTYPES = (
	"Prozess Aufgabe",
	"Prozess Aufgabe Datei",
	"Prozess Aufgabe Druck",
	"Prozess Field Spec",
	"Prozess Instanz",
	"Prozess Plugin Reference",
	"Prozess Schritt",
	"Prozess Schritt Kante",
	"Prozess Trigger Definition",
	"Prozess Typ",
	"Prozess Version",
)


def execute():
	for dt in ENGINE_DOCTYPES:
		if not frappe.db.exists("DocType", dt):
			continue
		if frappe.db.get_value("DocType", dt, "module") == "Process Engine":
			continue
		frappe.db.set_value("DocType", dt, "module", "Process Engine", update_modified=False)
	frappe.db.commit()
