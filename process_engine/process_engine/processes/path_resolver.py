"""Geteilter Pfad-Resolver fuer deklarative Wert-Quellen.

Ein "Pfad" ist eine punkt-separierte Feldkette ausgehend von einem (doctype, name),
z.B. "wohnung" oder "wohnung.aktueller_mietvertrag" oder "wohnung.immobilie".

Drei Konsumenten teilen sich diesen Kern:
  - der Derive-Node (Vorwaerts-Ableitung im Graph),
  - das Trigger-Input-Mapping (woher kommt jedes Payload-Feld beim Start?),
  - perspektivisch das create_linked_doc-Feld-Mapping.

WICHTIG — virtuelle Felder: `is_virtual`-Felder stehen NICHT in der DB. Ein
`frappe.db.get_value(...)` liefert dort leer. Sie werden ueber den geladenen Doc
(Controller-Property) gelesen. Gespeicherte Felder lesen wir per db.get_value (schnell).
"""

from __future__ import annotations

import frappe
from frappe import _

# Fieldtypes, die einen Ziel-Doctype tragen und weiter aufgeloest werden koennen.
LINK_FIELDTYPES = {"Link"}

# Layout-/Nicht-Daten-Fieldtypes, die im Pfad-Picker nichts verloren haben.
_NON_DATA_FIELDTYPES = {
	"Section Break", "Column Break", "Tab Break", "HTML", "Button",
	"Fold", "Heading", "Image",
}

# Standardfelder stehen nicht in meta.get_field(), sind aber gespeicherte Scalars und
# als Pfad-Endpunkt sinnvoll (vor allem ".name", um auf den Docname zu drillen).
_STANDARD_FIELDS = {
	"name", "owner", "creation", "modified", "modified_by", "docstatus", "idx",
	"parent", "parentfield", "parenttype",
}


def _read_field(doctype: str, name: str, fieldname: str):
	"""Liest ein einzelnes Feld und gibt (value, df) zurueck.

	Virtuelle Felder ueber den geladenen Doc (Property), gespeicherte per db.get_value.
	Standardfelder (name/creation/...) werden als gespeicherte Data-Scalars behandelt.
	"""
	# Read-Permission auf JEDEN besuchten Doc pruefen — auch fuer gespeicherte Felder und
	# Link-Drilldown-Ziele, nicht nur fuer virtuelle. Sonst koennte resolve_path Werte aus
	# Dokumenten lesen (per schnellem db.get_value), die der aktuelle User gar nicht sehen
	# darf. has_permission(doc=name) prueft auch zeilenbasierte User-Permissions.
	if not frappe.has_permission(doctype, ptype="read", doc=name):
		raise frappe.PermissionError(_("Keine Leseberechtigung fuer {0} {1}.").format(doctype, name))
	meta = frappe.get_meta(doctype)
	df = meta.get_field(fieldname)
	if df is None:
		if fieldname in _STANDARD_FIELDS:
			value = frappe.db.get_value(doctype, name, fieldname)
			return value, frappe._dict({"fieldtype": "Data", "options": None, "is_virtual": 0})
		frappe.throw(_("Feld '{0}' existiert nicht in {1}.").format(fieldname, doctype))
	if getattr(df, "is_virtual", 0):
		# Permission bereits oben geprueft; Property ueber den geladenen Doc auswerten.
		doc = frappe.get_doc(doctype, name)
		return getattr(doc, fieldname, None), df
	value = frappe.db.get_value(doctype, name, fieldname)
	return value, df


def validate_path(doctype: str, path: str) -> None:
	"""Validiert einen Punkt-Pfad gegen das Meta (ohne Werte/Permissions zu lesen).

	Wirft bei: unbekanntem Doctype, nicht existierendem Feld, oder einem Nicht-Link mitten
	im Pfad (der nicht weiter aufgeloest werden kann). Wird beim Speichern einer Prozess-
	Version genutzt, damit kaputte Derive-Pfade nicht erst zur Laufzeit auffallen.
	"""
	doctype = (doctype or "").strip()
	path = (path or "").strip()
	if not doctype:
		frappe.throw(_("Pfad-Validierung: kein Quell-Doctype."))
	if not frappe.db.exists("DocType", doctype):
		frappe.throw(_("Pfad-Validierung: Doctype '{0}' existiert nicht.").format(doctype))
	if not path:
		frappe.throw(_("Pfad-Validierung: leerer Pfad."))
	segments = [s.strip() for s in path.split(".") if s.strip()]
	cur = doctype
	for i, seg in enumerate(segments):
		is_last = i == len(segments) - 1
		df = frappe.get_meta(cur).get_field(seg)
		if df is None:
			if is_last and seg in _STANDARD_FIELDS:
				return
			frappe.throw(_("Pfad ungueltig: Feld '{0}' existiert nicht in {1}.").format(seg, cur))
		if not is_last:
			if df.fieldtype not in LINK_FIELDTYPES or not (df.options or "").strip():
				frappe.throw(
					_("Pfad ungueltig: '{0}' ist kein Link und kann nicht weiter aufgeloest werden.").format(seg)
				)
			cur = df.options.strip()


def resolve_path(doctype: str, name: str, path: str):
	"""Loest einen Punkt-Pfad ausgehend von (doctype, name) auf.

	Link-Segmente werden weiterverfolgt (df.options = naechster Doctype, value = naechster
	Docname). Leere Zwischenwerte -> None (kein harter Fehler, der Pfad ist dann einfach
	(noch) nicht aufloesbar). Ein Nicht-Link mitten im Pfad ist hingegen ein Konfig-Fehler.
	"""
	doctype = (doctype or "").strip()
	name = (name or "").strip()
	path = (path or "").strip()
	if not doctype or not path or not name:
		return None

	segments = [s.strip() for s in path.split(".") if s.strip()]
	cur_doctype = doctype
	cur_name = name
	value = None
	for i, seg in enumerate(segments):
		if not cur_name:
			return None
		value, df = _read_field(cur_doctype, cur_name, seg)
		is_last = i == len(segments) - 1
		if not is_last:
			if df.fieldtype not in LINK_FIELDTYPES or not (df.options or "").strip():
				frappe.throw(
					_("Pfad-Segment '{0}' ist kein Link und kann nicht weiter aufgeloest werden.").format(seg)
				)
			cur_doctype = df.options.strip()
			cur_name = (value or "").strip() if isinstance(value, str) else value
	return value


_PAYLOAD_FIELDTYPES = {
	"Data", "Link", "Date", "Datetime", "Int", "Float",
	"Currency", "Check", "Select", "Small Text", "Long Text",
}


def path_terminal_type(doctype: str, path: str) -> tuple[str, str]:
	"""Liefert (fieldtype, options) des End-Segments eines Pfads — fuer die Output-Typ-
	Ableitung des derive-Knotens. Standardfelder/Unbekanntes/Exoten -> ("Data", "")."""
	doctype = (doctype or "").strip()
	path = (path or "").strip()
	if not doctype or not path:
		return ("Data", "")
	segments = [s.strip() for s in path.split(".") if s.strip()]
	cur = doctype
	df = None
	for i, seg in enumerate(segments):
		df = frappe.get_meta(cur).get_field(seg)
		is_last = i == len(segments) - 1
		if df is None:
			return ("Data", "")  # Standardfeld (z.B. name) -> als Data behandeln
		if not is_last:
			if df.fieldtype not in LINK_FIELDTYPES or not (df.options or "").strip():
				return ("Data", "")
			cur = df.options.strip()
	if df is None:
		return ("Data", "")
	ft = df.fieldtype if df.fieldtype in _PAYLOAD_FIELDTYPES else "Data"
	opts = (df.options or "").strip() if ft in LINK_FIELDTYPES else ""
	return (ft, opts)


@frappe.whitelist()
def get_path_options(doctype: str, path_prefix: str = "") -> dict:
	"""Liefert die waehlbaren Felder fuer den Pfad-Picker.

	`path_prefix` ist ein bereits gewaehlter Link-Pfad (z.B. "wohnung"); wir drillen zum
	Ziel-Doctype und listen dessen Felder. Jedes Feld:
	  {fieldname, label, fieldtype, options(=Link-Ziel|None), is_virtual, is_link}.
	"""
	base = (doctype or "").strip()
	if not base:
		return {"doctype": "", "fields": []}
	if not frappe.has_permission(base, ptype="read"):
		frappe.throw(_("Keine Leseberechtigung fuer {0}.").format(base), frappe.PermissionError)

	cur = base
	for seg in [s.strip() for s in (path_prefix or "").split(".") if s.strip()]:
		meta = frappe.get_meta(cur)
		df = meta.get_field(seg)
		if df is None or df.fieldtype not in LINK_FIELDTYPES or not (df.options or "").strip():
			frappe.throw(_("Ungueltiges Pfad-Praefix bei '{0}'.").format(seg))
		cur = df.options.strip()

	meta = frappe.get_meta(cur)
	fields = []
	for df in meta.fields:
		if df.fieldtype in _NON_DATA_FIELDTYPES:
			continue
		is_link = df.fieldtype in LINK_FIELDTYPES
		fields.append({
			"fieldname": df.fieldname,
			"label": df.label or df.fieldname,
			"fieldtype": df.fieldtype,
			"options": df.options if is_link else None,
			"is_virtual": int(getattr(df, "is_virtual", 0) or 0),
			"is_link": is_link,
		})
	return {"doctype": cur, "fields": fields}
