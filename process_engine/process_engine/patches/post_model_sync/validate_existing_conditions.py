import frappe

from process_engine.process_engine.processes.conditions import parse


def execute():
	invalid = []
	for doctype, fields in (
		("Prozess Schritt", ("sichtbar_wenn", "freigabe_wenn")),
		("Prozess Trigger Definition", ("visibility_when",)),
	):
		for row in frappe.get_all(doctype, fields=["name", "parent", "idx", *fields]):
			for field in fields:
				try:
					parse(row.get(field))
				except ValueError as exc:
					invalid.append(f"{doctype} {row.parent}, Zeile {row.idx} ({row.name}), {field}: {exc}")
	if invalid:
		raise ValueError("Vorhandene Prozessbedingungen müssen vor der Migration korrigiert werden:\n" + "\n".join(invalid))
