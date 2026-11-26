"""Deterministic input and write contract for opted-in linked document tasks."""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import json
import re

import frappe
from frappe import _
from frappe.utils import cint, get_datetime, nowdate
from frappe.model import data_fieldtypes

ACTION = "create_linked_doc"
INSTANCE = "Prozess Instanz"
PAYLOAD_INPUT = re.compile(r"{{\s*payload\.([a-zA-Z_][a-zA-Z_0-9]*)\s*}}")
FIELD_TYPES = {"Data": 140, "Link": 140, "Select": 140, "Small Text": 2000, "Text": 4000, "Text Editor": 4000}
RESERVED = {
	"name", "doctype", "owner", "creation", "modified", "modified_by", "docstatus", "idx",
	"parent", "parenttype", "parentfield", "amended_from", "naming_series", "workflow_state", "status",
}
ROW_IDENTITY = (
	"name", "step_key", "task_type", "handler_key", "depends_on_json", "parent_step_key", "pflicht", "todo",
)
ROW_RESULT = ("status", "erfuellt", "erfuellt_von", "erfuellt_am", "result_json")
_active_result = ContextVar("linked_create_result", default=None)


class TaskUnavailable(frappe.ValidationError):
	"""The task or its effective input context can no longer be used."""


class LinkedCreateConflict(frappe.ValidationError):
	http_status_code = 409


def unavailable():
	frappe.throw(_("Die Erstellaufgabe ist in diesem Prozessstand nicht verfügbar."), TaskUnavailable)


def validate_opt_in(step, config, *, complete=False):
	flag = config.get("allow_ai_proposals", False)
	if type(flag) not in (bool, int) or flag not in (0, 1):
		frappe.throw(_("Ungültiger Schalter für KI-Vorschläge."))
	if flag and (step.task_type != ACTION or (step.handler_key or ACTION) != ACTION or
		config.get("handler_key", ACTION) != ACTION):
		frappe.throw(_("KI-Vorschläge benötigen die eingebaute Erstellaufgabe."))
	if flag:
		keys = {"allow_ai_proposals", "target_doctype", "store_in_payload_field", "handler_key",
			"dialog_fields", "prefill_mapping", "map_inputs", "proposal_fields"}
		if config.keys() - keys:
			frappe.throw(_("Nicht unterstützte Konfiguration für KI-Erstellvorschläge."))
		_field_contract(config, complete=complete)


def _mapping_source(value):
	if isinstance(value, str):
		match = PAYLOAD_INPUT.fullmatch(value)
		if match:
			return ("payload", match[1])
		if not any(marker in value for marker in ("{{", "{%", "{#")):
			return ("fixed", value)
	frappe.throw(_("Die Feldzuordnung benötigt einen festen Text oder einen direkten Prozess-Input."))


def mapped_inputs(config):
	return [
		name for source, name in map(_mapping_source, (config.get("prefill_mapping") or {}).values())
		if source == "payload"
	]


def _field_contract(config, *, complete=True, automatic=False):
	target = config.get("target_doctype")
	output = config.get("store_in_payload_field")
	if not isinstance(target, str) or not target or not isinstance(output, str) or not re.fullmatch(r"[a-zA-Z_][a-zA-Z_0-9]*", output):
		frappe.throw(_("Ziel und Ergebnisfeld der Erstellaufgabe fehlen."))
	meta = frappe.get_meta(target)
	if meta.issingle or meta.istable or meta.get("is_virtual"):
		frappe.throw(_("Der Ziel-Doctype unterstützt keine KI-Erstellvorschläge."))
	dialog = config.get("dialog_fields", [])
	mapping = config.get("prefill_mapping", {})
	wired = config.get("map_inputs", [])
	allowed = config.get("proposal_fields", [])
	if not isinstance(dialog, list) or not isinstance(mapping, dict) or not isinstance(wired, list) or not isinstance(allowed, list):
		frappe.throw(_("Ungültige Feldkonfiguration der Erstellaufgabe."))
	if any(not isinstance(item, dict) for item in dialog) or any(not isinstance(key, str) for key in (*allowed, *wired)):
		frappe.throw(_("Ungültige Feldkonfiguration der Erstellaufgabe."))
	manual = {item.get("fieldname"): item for item in dialog if isinstance(item.get("fieldname"), str)}
	if len(manual) != len(dialog) or manual.keys() & mapping.keys() or manual.keys() & set(wired):
		frappe.throw(_("Die Eingabefelder müssen eindeutig einer Quelle zugeordnet sein."))
	if automatic and (manual or allowed):
		frappe.throw(_("Automatische Erstellaufgaben benötigen feste oder zugeordnete Felder."))
	if not automatic and (not allowed or len(set(allowed)) != len(allowed) or not set(allowed) <= manual.keys()):
		frappe.throw(_("Wähle die vorschlagbaren manuellen Felder ausdrücklich aus."))
	if complete and not set(wired) <= mapping.keys():
		unavailable()
	fields = {}
	for key in dict.fromkeys([*manual, *mapping, *wired]):
		field = meta.get_field(key)
		override = manual.get(key, {})
		if (
			key in RESERVED or not field or field.fieldtype not in FIELD_TYPES
			or field.hidden or field.read_only or field.get("is_virtual") or field.get("set_only_once")
			or field.get("fetch_from") or field.get("depends_on") or field.get("mandatory_depends_on")
			or field.get("read_only_depends_on") or override.get("fieldtype", field.fieldtype) != field.fieldtype
			or override.get("options", field.options) != field.options
			or any(override.get(k) for k in ("hidden", "read_only", "depends_on", "mandatory_depends_on", "read_only_depends_on", "default"))
		):
			frappe.throw(_("Feld {0} wird für diese Erstellaufgabe nicht unterstützt.").format(key))
		source, value = _mapping_source(mapping[key]) if key in mapping else ("manual", None)
		limit = min(field.length or FIELD_TYPES[field.fieldtype], FIELD_TYPES[field.fieldtype])
		if field.fieldtype == "Link" and (not field.options or field.options == "[Select]"):
			frappe.throw(_("Nur Links mit festem Ziel werden unterstützt."))
		fields[key] = {
			"fieldname": key, "label": field.label, "fieldtype": field.fieldtype,
			"options": field.options, "reqd": bool(field.reqd or override.get("reqd") or field.default or source != "manual"),
			"length": limit, "permlevel": int(field.permlevel or 0),
			"source": source, "source_value": value, "proposable": key in allowed,
		}
	if complete and any(f.reqd and not f.default and f.fieldname not in fields for f in meta.fields
		if f.fieldtype in data_fieldtypes or f.fieldtype in ("Table", "Table MultiSelect")):
		frappe.throw(_("Ein Pflichtfeld fehlt im Feld-Mapping der Erstellaufgabe."))
	return fields


def _version(doc):
	return frappe.get_doc("Prozess Version", doc.prozess_version) if doc.prozess_version else None


def _opted_steps(version):
	from .task_registry import extract_task_config

	if version:
		for step in version.schritte:
			config = extract_task_config(step)
			if config.get("allow_ai_proposals"):
				yield step, config


def opted_config(doc, row, *, version=None):
	if doc.doctype == INSTANCE:
		for step, config in _opted_steps(version or _version(doc)):
			if step.step_key == row.step_key:
				return config
	return None



def opted_rows(doc):
	if doc.doctype != INSTANCE:
		return []
	keys = {step.step_key for step, _config in _opted_steps(_version(doc))}
	return [row for row in doc.aufgaben if row.step_key in keys]

def _payload(doc):
	try:
		payload = json.loads(doc.payload_json or "{}")
	except (TypeError, ValueError):
		unavailable()
	if not isinstance(payload, dict):
		unavailable()
	return payload


def _check_link(doctype, name):
	frappe.get_doc(doctype, name).check_permission("read")


def _process_value(payload, specs, key):
	value = payload.get(key)
	if not isinstance(value, str) or not value.strip() or len(value) > 4000:
		unavailable()
	spec = specs.get(key)
	if not spec or spec.fieldtype not in FIELD_TYPES:
		unavailable()
	if len(value) > FIELD_TYPES[spec.fieldtype]:
		unavailable()
	if spec.fieldtype == "Select" and value not in (spec.options or "").splitlines():
		unavailable()
	if spec.fieldtype == "Link":
		_check_link(spec.options, value)
	return value



def _system_defaults(target, fields):
	"""Allow static scalar defaults and the site's date, rejecting user-specific additions."""
	meta = frappe.get_meta(target)
	blank = frappe.new_doc(target)
	defaults = {}
	for field in meta.fields:
		key = field.fieldname
		if key in fields or field.fieldtype not in data_fieldtypes:
			continue
		actual = blank.get(key)
		if actual in (None, ""):
			continue
		expected = field.default
		if field.fieldtype == "Date" and expected == "Today":
			expected = nowdate()
		elif field.fieldtype not in ("Select", "Data", "Small Text", "Text"):
			unavailable()
		if actual != expected or field.hidden or field.permlevel or field.read_only or field.get("is_virtual"):
			unavailable()
		defaults[key] = {"label": field.label, "value": actual}
	return defaults


@contextmanager
def request_transaction():
	"""Reject a commit by a nested document hook before the enclosing operation finishes."""
	active = True

	def guard():
		if active:
			frappe.db.before_commit.add(guard)
			frappe.throw(_("Ein Dokument-Hook versuchte, die Erstelltransaktion vorzeitig zu bestätigen."))

	frappe.db.before_commit.add(guard)
	try:
		yield
	finally:
		active = False


def _dependencies(version, rows, step_key):
	steps = {step.step_key: step for step in version.schritte}
	producers = {}
	deps = {key: set() for key in steps}
	inputs = {key: set() for key in steps}
	for port in version.schritt_io:
		if port.kind == "payload_output":
			producers.setdefault(port.target, set()).add(port.step_key)
		elif port.kind == "payload_input":
			inputs[port.step_key].add(port.target)
		elif port.kind == "step_input":
			deps[port.step_key].add(port.target)
	for key, step in steps.items():
		if step.parent_step_key:
			deps[key].add(step.parent_step_key)
		for name in inputs[key]:
			deps[key].update(producers.get(name, set()) - {key})
	if not version.schritt_io:
		for edge in version.schritt_kanten:
			deps[edge.step_key].add(edge.depends_on_step_key)
	pending = list(deps[step_key])
	seen = {step_key}
	context = {}
	while pending:
		key = pending.pop()
		if key in seen:
			continue
		seen.add(key)
		row = rows.get(key)
		if not row or not row.erfuellt or row.status != "Erledigt":
			unavailable()
		context[key] = [row.name, row.status, row.erfuellt_von, str(row.erfuellt_am or "")]
		pending.extend(deps[key])
	return sorted(inputs[step_key]), context


@dataclass(frozen=True)
class LinkedCreateTask:
	doc: object
	row: object
	config: dict
	fields: dict
	fixed: dict
	context: dict

	@property
	def target(self):
		return self.config["target_doctype"]

	@property
	def output(self):
		return self.config["store_in_payload_field"]

	def effective_values(self, values, *, proposal=False, permission="read"):
		"""Validate the supplied subset and return only the values the handler may insert."""
		self.check_fields(permission)
		permitted = {key for key, field in self.fields.items()
			if field["source"] == "manual" and (not proposal or field["proposable"])}
		if not isinstance(values, dict) or not values.keys() <= permitted:
			frappe.throw(_("Nicht freigegebene Eingabe für die Erstellaufgabe."))
		effective = self.fixed | values
		for key, field in self.fields.items():
			value = effective.get(key)
			if value is None or value == "":
				if field["reqd"]:
					frappe.throw(_("Feld {0} ist erforderlich.").format(field["label"]))
				if value is not None and not isinstance(value, str):
					frappe.throw(_("Ungültiger Feldwert."))
				continue
			if not isinstance(value, str) or not value.strip() or len(value) > field["length"]:
				frappe.throw(_("Ungültiger Wert für {0}.").format(field["label"]))
			if field["fieldtype"] == "Text Editor" and ("<" in value or ">" in value):
				frappe.throw(_("Nur Klartext ist für dieses Feld zulässig."))
			if field["fieldtype"] == "Select" and value not in (field["options"] or "").splitlines():
				frappe.throw(_("Ungültige Auswahl für {0}.").format(field["label"]))
			if field["fieldtype"] == "Link":
				_check_link(field["options"], value)
		return effective

	def check_fields(self, permission):
		meta = frappe.get_meta(self.target)
		for key, field in self.fields.items():
			level = field["permlevel"]
			if level and level not in meta.get_permlevel_access(permission, user=frappe.session.user):
				frappe.throw(_("Kein Feldzugriff für die Erstellaufgabe."), frappe.PermissionError)

	def dialog(self):
		self.check_fields("read")
		self.check_fields("write")
		return {"fields": [
			{key: field[key] for key in ("fieldname", "label", "fieldtype", "options", "reqd", "length")}
			| ({"default": self.fixed[name], "read_only": 1} if name in self.fixed else {})
			for name, field in self.fields.items()
		], "target_doctype": self.target, "title": _("Neu anlegen: {0}").format(self.target),
			"primary_label": _("Anlegen")}


def resolve(doc, row, *, automatic=False):
	"""Use the caller's fresh instance. Execution callers hold its database row lock."""
	from .engine import ProcessEngine
	from .task_registry import CreateLinkedDocTaskHandler

	if doc.doctype != INSTANCE or doc.docstatus != 0 or doc.status not in {"Entwurf", "In Bearbeitung", "Abschlusspruefung"}:
		unavailable()
	version = _version(doc)
	config = opted_config(doc, row, version=version) if version else None
	engine = ProcessEngine.for_instance(doc)
	if automatic:
		from .task_registry import extract_task_config

		step = engine.step_definition(doc, row)
		config = extract_task_config(step) if step and step.automatisch else None
	if (not config or version.prozess_typ != doc.prozess_typ or not (version.is_active or version.wurde_aktiviert)
		or row.task_type != ACTION or (row.handler_key or ACTION) != ACTION
		or type(engine._get_task_handler(row)) is not CreateLinkedDocTaskHandler):
		unavailable()
	fields = _field_contract(config, automatic=automatic)
	payload = _payload(doc)
	output = config["store_in_payload_field"]
	if row.status not in {"Offen", "In Arbeit"} or row.erfuellt or (not automatic and (row.result_json or payload.get(output) not in (None, ""))):
		unavailable()
	rows = {task.step_key: task for task in doc.aufgaben}
	if len(rows) != len(doc.aufgaben):
		unavailable()
	if automatic:
		if not engine._is_task_unlocked(doc, row):
			unavailable()
		input_keys = {port.target for port in version.schritt_io if port.step_key == row.step_key and port.kind == "payload_input"}
		predecessors = {}
	else:
		if not engine._task_visible(doc, row) or not engine._task_condition(doc, row, "freigabe_wenn"):
			unavailable()
		input_keys, predecessors = _dependencies(version, rows, row.step_key)
	specs = {spec.fieldname: spec for spec in version.payload_field_specs}
	fixed = {}
	for key, field in fields.items():
		if field["source"] == "payload":
			fixed[key] = _process_value(payload, specs, field["source_value"])
		elif field["source"] == "fixed":
			fixed[key] = field["source_value"]
	if doc.quelle_doctype and doc.quelle_name:
		_check_link(doc.quelle_doctype, doc.quelle_name)
	context = {
		"doctype": doc.doctype, "instance": doc.name, "process_type": doc.prozess_typ,
		"row": row.name, "step_key": row.step_key, "version": version.name,
		"instance_modified": str(doc.modified),
		"backend": doc.orchestrator_backend, "action": ACTION, "status": doc.status,
		"task_status": row.status, "target": config["target_doctype"], "output": output,
		"source": [doc.quelle_doctype, doc.quelle_name],
		"fields": fields, "fixed": fixed, "output_value": payload.get(output),
		"system_defaults": _system_defaults(config["target_doctype"], fields),
		"inputs": {key: _process_value(payload, specs, key) for key in input_keys},
		"predecessors": predecessors,
	}
	return LinkedCreateTask(doc, row, config, fields, fixed, context)


@contextmanager
def persist_result(doc, row, output, name):
	"""Authorize precisely the result produced by the checked handler on this document."""
	token = _active_result.set((doc, row.name, output, name))
	try:
		yield
	finally:
		_active_result.reset(token)



def _row_value(row, key):
	value = row.get(key)
	if key in ("pflicht", "erfuellt"):
		return cint(value)
	if key == "erfuellt_am":
		return get_datetime(value) if value else None
	return value or None

def protect_result(doc, *, before_engine=False):
	"""Protect opt-in task identity and its output in regular Frappe document writes."""
	before = doc.get_doc_before_save()
	steps = list(_opted_steps(_version(before or doc)))
	if not steps:
		return []
	if before and (doc.prozess_typ != before.prozess_typ or doc.prozess_version != before.prozess_version):
		unavailable()
	rows = {row.step_key: row for row in doc.aufgaben}
	old_rows = {row.step_key: row for row in before.aufgaben} if before else {}
	if len(rows) != len(doc.aufgaben):
		unavailable()
	for step, config in steps:
		row = rows.get(step.step_key)
		old = old_rows.get(step.step_key)
		output = config["store_in_payload_field"]
		value = _payload(doc).get(output)
		if row is None and old is None and value in (None, ""):
			continue  # The template step may be invisible for this process variant.
		if not row:
			unavailable()
		active = _active_result.get()
		if active and active[0] is doc and active[1:] == (row.name, output, value):
			if (not old or row.status != "Erledigt" or (not before_engine and not row.erfuellt)
				or json.loads(row.result_json) != {"created": value}):
				unavailable()
			protected = ROW_IDENTITY
		elif not before:
			if (value not in (None, "") or row.todo or row.result_json or row.erfuellt or row.erfuellt_von
				or row.erfuellt_am or row.status != "Offen"):
				unavailable()
			continue
		else:
			if value != _payload(before).get(output):
				unavailable()
			protected = ROW_IDENTITY + ROW_RESULT
		if not old or any(_row_value(row, key) != _row_value(old, key) for key in protected):
			unavailable()

	return [rows[step.step_key] for step, _config in steps if step.step_key in rows]


def protect_version_child(doc, method=None):
	"""Direct child writes must use the version controller's validation and content lock."""
	for row in (doc.get_doc_before_save(), doc):
		if row and row.parenttype == "Prozess Version" and row.parent:
			version = frappe.get_doc("Prozess Version", row.parent)
			if any(_opted_steps(version)):
				unavailable()
	if doc.doctype == "Prozess Schritt":
		from .task_registry import extract_task_config

		if extract_task_config(doc).get("allow_ai_proposals"):
			unavailable()
