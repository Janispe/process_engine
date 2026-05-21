from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Callable

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime
from frappe.utils.file_manager import save_file

# Phase 8 Review-Fixes 3: paperless_export ist hookbasiert — Consumer-Apps
# (z.B. hausverwaltung) registrieren ihre Paperless-Export-Funktion via
# `process_engine_paperless_export_handler`. process_engine selbst hat
# keinen harten paperless-Import mehr.


def _get_paperless_export_handler():
	"""Liefert die erste registrierte Paperless-Export-Callable.

	Erwartete Signatur:
		handler(*, doctype, docname, file_url, title, tag_names) -> dict
		Return-dict muss "link" enthalten (das Paperless-Doc).

	Wenn kein Hook registriert ist, wirft sie eine klare Fehlermeldung statt
	stillschweigend nichts zu tun.
	"""
	for path in frappe.get_hooks("process_engine_paperless_export_handler") or []:
		p = (path or "").strip()
		if not p:
			continue
		try:
			return frappe.get_attr(p)
		except Exception:
			frappe.log_error(
				title=f"process_engine: paperless export handler lookup failed ({p})",
				message=frappe.get_traceback(),
			)
	return None

TASK_TYPE_MANUAL_CHECK = "manual_check"
TASK_TYPE_FILE_UPLOAD = "file_upload"
TASK_TYPE_PYTHON_ACTION = "python_action"
TASK_TYPE_PRINT_DOCUMENT = "print_document"
TASK_TYPE_PAPERLESS_EXPORT = "paperless_export"
TASK_TYPE_EMAIL_DRAFT = "email_draft"
TASK_TYPE_CREATE_LINKED_DOC = "create_linked_doc"
TASK_TYPE_DERIVE = "derive"

SUPPORTED_TASK_TYPES = (
	TASK_TYPE_MANUAL_CHECK,
	TASK_TYPE_FILE_UPLOAD,
	TASK_TYPE_PYTHON_ACTION,
	TASK_TYPE_PRINT_DOCUMENT,
	TASK_TYPE_PAPERLESS_EXPORT,
	TASK_TYPE_EMAIL_DRAFT,
	TASK_TYPE_CREATE_LINKED_DOC,
	TASK_TYPE_DERIVE,
)


def normalize_task_type(value: str | None) -> str:
	raw = (value or "").strip()
	if not raw:
		return TASK_TYPE_MANUAL_CHECK
	if raw in SUPPORTED_TASK_TYPES:
		return raw
	return TASK_TYPE_MANUAL_CHECK


def extract_task_config(step_or_task) -> dict:
	# Phase 10: Laufzeit-Aufgaben (Prozess Aufgabe) tragen KEINE eigene Config mehr
	# (Snapshot entfernt). Ihre Config wird live aus der referenzierten Prozess Version
	# aufgeloest. Vorlagen-Schritte (Prozess Schritt) und Seed-Dicts lesen weiter inline
	# aus konfig_json. Diese Engstelle haelt alle Aufrufer (auch Consumer-Apps) unveraendert.
	if getattr(step_or_task, "doctype", None) == "Prozess Aufgabe":
		return _resolve_runtime_task_config(step_or_task)

	config = {}
	raw = (getattr(step_or_task, "konfig_json", None) or "").strip()
	if raw:
		try:
			parsed = json.loads(raw)
			if isinstance(parsed, dict):
				config.update(parsed)
		except Exception:
			pass

	if getattr(step_or_task, "dokument_typ_tag", None):
		config.setdefault("dokument_typ_tag", (step_or_task.dokument_typ_tag or "").strip())
	if getattr(step_or_task, "print_format", None):
		config.setdefault("print_format", (step_or_task.print_format or "").strip())
	if getattr(step_or_task, "handler_key", None):
		config.setdefault("handler_key", (step_or_task.handler_key or "").strip())

	return config


def _resolve_runtime_task_config(task_row) -> dict:
	"""Loest die Config einer Laufzeit-Aufgabe live aus ihrer Prozess Version auf
	(Instanz -> prozess_version -> Schritt nach step_key -> konfig_json).

	ANNAHME: nur der generische Runtime-Doctype "Prozess Instanz" wird unterstuetzt
	(aktuell der einzige). Bei einem anderen, Consumer-spezifischen Runtime-Doctype
	wird BEWUSST laut geworfen statt still {} zurueckzugeben — sonst verloeren dessen
	Tasks unbemerkt ihre Config. Fehlt parent/step_key (z.B. unsaved Row), wird benigne
	{} zurueckgegeben."""
	parent = getattr(task_row, "parent", None)
	parenttype = (getattr(task_row, "parenttype", None) or "").strip()
	step_key = (getattr(task_row, "step_key", None) or "").strip()
	if not parent or not step_key:
		return {}
	if parenttype != "Prozess Instanz":
		frappe.throw(
			_(
				"Live-Config-Aufloesung ist nur fuer den Runtime-Doctype 'Prozess Instanz' "
				"implementiert, nicht fuer '{0}'."
			).format(parenttype)
		)
	try:
		instance = frappe.get_cached_doc("Prozess Instanz", parent)
		version_name = (instance.get("prozess_version") or "").strip()
		if not version_name:
			return {}
		version = frappe.get_cached_doc("Prozess Version", version_name)
	except frappe.DoesNotExistError:
		return {}
	for step in version.get("schritte") or []:
		if (step.get("step_key") or "").strip() == step_key:
			return extract_task_config(step)
	return {}


def dump_task_config(config: dict) -> str:
	if not config:
		return "{}"
	return json.dumps(config, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


@dataclass
class TaskCheckResult:
	fulfilled: bool
	meta: dict = field(default_factory=dict)


@dataclass(frozen=True)
class TaskHandlerContext:
	runtime_doctype: str | None = None
	file_detail_doctype: str | None = None
	file_detail_doctype_field: str | None = None
	file_detail_name_field: str | None = None
	print_detail_doctype: str | None = None
	print_detail_doctype_field: str | None = None
	print_detail_name_field: str | None = None
	tag_builder: Callable[[Document, str], list[str]] | None = None
	custom_handlers: dict[str, "BaseTaskHandler"] = field(default_factory=dict)


class BaseTaskHandler:
	task_type = TASK_TYPE_MANUAL_CHECK

	def validate_config(self, step_or_task) -> None:
		return None

	def seed_detail(self, context: TaskHandlerContext, doc: Document, task_row, config: dict) -> None:
		return None

	def is_fulfilled(self, context: TaskHandlerContext, doc: Document, task_row) -> TaskCheckResult:
		return TaskCheckResult(fulfilled=(task_row.status or "") == "Erledigt")

	def export(self, context: TaskHandlerContext, doc: Document, task_row) -> dict:
		frappe.throw(_("Task-Export wird fuer diesen Aufgabentyp nicht unterstuetzt."))

	def generate_pdf(self, context: TaskHandlerContext, doc: Document, task_row) -> dict:
		frappe.throw(_("PDF-Generierung wird fuer diesen Aufgabentyp nicht unterstuetzt."))

	def confirm_filed(self, context: TaskHandlerContext, doc: Document, task_row, confirmed: int) -> dict:
		frappe.throw(_("Bestaetigung wird fuer diesen Aufgabentyp nicht unterstuetzt."))

	def get_detail_ref(self, context: TaskHandlerContext, doc: Document, task_row) -> dict:
		return {}

	def run_action(self, context: TaskHandlerContext, doc: Document, task_row, payload: dict | None = None) -> dict:
		frappe.throw(_("Ausfuehrung wird fuer diesen Aufgabentyp nicht unterstuetzt."))

	def config_schema(self) -> dict | None:
		"""Phase 13: Selbstbeschreibung der Definitions-Config. None -> roher konfig_json-
		Editor (permanenter Fallback). Sonst {"fields": [ConfigField, ...]} mit
		ConfigField = {key, label, fieldtype, options?, reqd?, widget?}; widget default
		"control", sonst "payload_field_select" | "doc_field_mapping" (Editor-seitig dynamisch)."""
		return None

	def runtime_actions(self, context: TaskHandlerContext, doc: Document, task_row) -> list[dict]:
		"""Phase 13: Selbstbeschreibung der Laufzeit-Aktionen (Klick in der Aufgabe).
		Descriptor = {key, label, primary?, disabled?, reason?, dialog?, ignore_lock?,
		_dispatch, _params}. `key`/`dialog` sind client-facing; `_dispatch` (eine allowlistete
		ACTION_*) + `_params` bleiben serverseitig (run_task_action mappt key -> _dispatch).
		Basis = Status-Toggle (gilt fuer alle Typen); Subklassen ergaenzen via super()."""
		done = (task_row.status or "") == "Erledigt"
		if done:
			return [{
				"key": "reopen", "label": _("Wieder oeffnen"), "ignore_lock": True,
				"_dispatch": "set_task_status", "_params": {"status": "Offen"},
			}]
		return [{
			"key": "set_done", "label": _("Erledigt"), "primary": True,
			"_dispatch": "set_task_status", "_params": {"status": "Erledigt"},
		}]

	def action_dialog_fields(self, context: TaskHandlerContext, doc: Document, task_row, action_key: str) -> dict:
		"""Phase C: Felddefinitionen fuer einen generischen Laufzeit-Dialog einer Action.

		Eine runtime_actions-Action mit `"dialog": "<name>"` ohne client-seitig registrierten
		Custom-Dialog laesst den Client einen generischen frappe.ui.Dialog aus diesen Feldern
		bauen. Submit ruft run_task_action(action_key, {"user_values": <dialog-werte>}) — der
		Handler liest die Werte in run_action/seiner Dispatch-Methode aus payload["user_values"].

		Rueckgabe: {"fields": [frappe-fielddef, ...], "title"?, "primary_label"?, ...beliebige
		Zusatzkeys fuer Custom-Dialoge}. Leeres `fields` -> kein Dialog noetig (Client fuehrt
		die Action direkt aus)."""
		return {"fields": []}

	def task_view(self, context: TaskHandlerContext, doc: Document, task_row) -> dict | None:
		"""Phase E: optionale Custom-Client-Component fuer die Darstellung dieser Aufgabe.

		None -> generisches Rendering (Standard-Buttons aus runtime_actions). Sonst
		{"component": "<registry-name>", "bundle"?: "/assets/<app>/js/<file>.js", "props"?: {...}}.
		Der Client laedt `bundle` (falls gesetzt) lazy via frappe.require, schlaegt `component`
		in window.process_engine.task_views nach und mountet es in einen Per-Aufgabe-Slot.
		Es wird NIE Code aus diesem Descriptor ausgefuehrt — nur ein Name aufgeloest."""
		return None

	def can_auto_run(self, context: TaskHandlerContext, doc: Document, task_row) -> bool:
		"""Nur fuer is_auto-Handler relevant: ob der Auto-Run JETZT laufen darf (Inputs da).
		Default True; Auto-Handler (z.B. derive) ueberschreiben das, um auf vorhandene
		Quell-Inputs zu warten, statt mit leerem Input vorzeitig abzuschliessen."""
		return True

	def declared_outputs(self, config: dict) -> list[dict]:
		"""Welche Payload-Felder PRODUZIERT dieser Aufgabentyp (aus seiner Config)?

		Outputs sind typ-getrieben — der Nutzer deklariert sie NICHT manuell. Rueckgabe:
		[{fieldname, fieldtype, options}]. Die Version-Validierung legt daraus automatisch
		payload_field_specs (Name+Typ, auto_output=1) + payload_output-I/O an und entfernt
		veraltete. Default: keine Outputs (manual_check, print_document, ...)."""
		return []


class ManualCheckTaskHandler(BaseTaskHandler):
	task_type = TASK_TYPE_MANUAL_CHECK


class PythonActionTaskHandler(BaseTaskHandler):
	task_type = TASK_TYPE_PYTHON_ACTION

	def config_schema(self) -> dict | None:
		# Variante A: python_action ist der einzige "beliebige" Typ -> der Dev deklariert
		# seine Outputs explizit in der Config (JSON-Liste), damit sie ebenfalls typ-getrieben
		# sind (kein manuelles Output-Anlegen am Knoten).
		return {
			"fields": [
				{
					"key": "outputs",
					"label": _("Outputs (JSON-Liste)"),
					"fieldtype": "Code",
					"description": _('z.B. [{"fieldname": "neuer_vertrag", "fieldtype": "Link", "options": "Mietvertrag"}]'),
				},
			]
		}

	def validate_config(self, step_or_task) -> None:
		config = extract_task_config(step_or_task)
		handler_key = (config.get("handler_key") or getattr(step_or_task, "handler_key", None) or "").strip()
		if not handler_key:
			frappe.throw(_("Aufgabentyp python_action erfordert handler_key."))

	def declared_outputs(self, config: dict) -> list[dict]:
		raw = config.get("outputs")
		if isinstance(raw, str):
			raw = raw.strip()
			if not raw:
				return []
			try:
				raw = json.loads(raw)
			except (ValueError, TypeError):
				return []
		if not isinstance(raw, list):
			return []
		out: list[dict] = []
		for o in raw:
			if not isinstance(o, dict):
				continue
			fn = (o.get("fieldname") or "").strip()
			if not fn:
				continue
			out.append({
				"fieldname": fn,
				"fieldtype": (o.get("fieldtype") or "Data").strip() or "Data",
				"options": (o.get("options") or "").strip(),
			})
		return out

	def run_action(self, context: TaskHandlerContext, doc: Document, task_row, payload: dict | None = None) -> dict:
		frappe.throw(_("Kein Python-Handler fuer diese Aufgabe registriert."))

	def runtime_actions(self, context: TaskHandlerContext, doc: Document, task_row) -> list[dict]:
		actions = super().runtime_actions(context, doc, task_row)
		actions.append({
			"key": "run_python", "label": _("Ausfuehren"), "primary": True,
			"_dispatch": "run_python_task", "_params": {},
		})
		return actions


class PaperlessExportTaskHandler(BaseTaskHandler):
	task_type = TASK_TYPE_PAPERLESS_EXPORT

	def config_schema(self) -> dict | None:
		return {
			"fields": [
				{"key": "dokument_typ_tag", "label": _("Dokument-Typ-Tag"), "fieldtype": "Data", "reqd": 1},
			]
		}

	def runtime_actions(self, context: TaskHandlerContext, doc: Document, task_row) -> list[dict]:
		actions = super().runtime_actions(context, doc, task_row)
		# Detail-Row existiert bereits aus seed_detail -> ensure_* ist hier reiner Read.
		detail = ensure_file_detail(context, doc.name, task_row.name)
		export = {
			"key": "export_file", "label": _("Nach Paperless"), "primary": True,
			"_dispatch": "export_file_task", "_params": {},
		}
		if not (detail.file_url or "").strip():
			export["disabled"] = True
			export["reason"] = _("Bitte zuerst eine Datei hochladen.")
		actions.append(export)
		return actions

	def validate_config(self, step_or_task) -> None:
		config = extract_task_config(step_or_task)
		if not (config.get("dokument_typ_tag") or "").strip():
			frappe.throw(_("Aufgabentyp paperless_export erfordert dokument_typ_tag."))

	def seed_detail(self, context: TaskHandlerContext, doc: Document, task_row, config: dict) -> None:
		ensure_file_detail(context, doc.name, task_row.name)

	def is_fulfilled(self, context: TaskHandlerContext, doc: Document, task_row) -> TaskCheckResult:
		detail = ensure_file_detail(context, doc.name, task_row.name)
		has_file = bool((detail.file_url or "").strip())
		has_export = bool((detail.paperless_link or "").strip()) and (detail.paperless_status or "") == "Exportiert"
		return TaskCheckResult(
			fulfilled=has_file and has_export,
			meta={
				"has_file": has_file,
				"has_export": has_export,
				"paperless_status": detail.paperless_status,
			},
		)

	def export(self, context: TaskHandlerContext, doc: Document, task_row) -> dict:
		detail = ensure_file_detail(context, doc.name, task_row.name)
		file_url = (detail.file_url or "").strip()
		if not file_url:
			frappe.throw(_("Bitte zuerst eine Datei fuer diese Aufgabe hochladen."))

		config = extract_task_config(task_row)
		variant = (config.get("dokument_typ_tag") or task_row.aufgabe or "Dokument").strip()
		tag_builder = context.tag_builder or _default_tag_builder
		handler = _get_paperless_export_handler()
		if handler is None:
			frappe.throw(
				_(
					"Paperless-Export ist nicht konfiguriert. Eine Consumer-App "
					"muss via Hook `process_engine_paperless_export_handler` eine "
					"Export-Funktion registrieren."
				)
			)
		res = handler(
			doctype=doc.doctype,
			docname=doc.name,
			file_url=file_url,
			title=f"{doc.doctype} {doc.name} - {variant}",
			tag_names=tag_builder(doc, variant),
		)
		link = (res.get("link") or "").strip()
		if not link:
			frappe.throw(_("Paperless-Link wurde nicht zurueckgegeben."))

		detail.paperless_link = link
		detail.paperless_status = "Exportiert"
		detail.paperless_error = ""
		detail.save(ignore_permissions=True)
		return {"link": link, "detail": detail.name}

	def get_detail_ref(self, context: TaskHandlerContext, doc: Document, task_row) -> dict:
		detail = ensure_file_detail(context, doc.name, task_row.name)
		return {"doctype": detail.doctype, "name": detail.name}


class PrintDocumentTaskHandler(BaseTaskHandler):
	task_type = TASK_TYPE_PRINT_DOCUMENT

	def config_schema(self) -> dict | None:
		# widget "print_format_picker" (Consumer-Asset) rendert ein Link-Control auf
		# "Print Format" mit Preview-Link + Doc-Type-Pille. Ist das Asset nicht geladen,
		# faellt der Editor sichtbar auf den Raw-JSON-Editor zurueck (Daten bleiben heil);
		# fieldtype/options bleiben als Fallback-Metadaten erhalten.
		return {
			"fields": [
				{"key": "print_format", "label": _("Print Format"), "fieldtype": "Link",
				 "options": "Print Format", "widget": "print_format_picker", "reqd": 1},
			]
		}

	def runtime_actions(self, context: TaskHandlerContext, doc: Document, task_row) -> list[dict]:
		actions = super().runtime_actions(context, doc, task_row)
		actions.append({
			"key": "generate_print", "label": _("PDF generieren"), "primary": True,
			"_dispatch": "generate_print_task", "_params": {},
		})
		actions.append({
			"key": "confirm_filed", "label": _("Abheften bestaetigen"),
			"_dispatch": "confirm_print_task", "_params": {"confirmed": 1},
		})
		return actions

	def validate_config(self, step_or_task) -> None:
		config = extract_task_config(step_or_task)
		if not (config.get("print_format") or "").strip():
			frappe.throw(_("Aufgabentyp print_document erfordert print_format."))

	def seed_detail(self, context: TaskHandlerContext, doc: Document, task_row, config: dict) -> None:
		print_format = (config.get("print_format") or "").strip()
		ensure_print_detail(context, doc.name, task_row.name, print_format=print_format)

	def is_fulfilled(self, context: TaskHandlerContext, doc: Document, task_row) -> TaskCheckResult:
		detail = ensure_print_detail(
			context, doc.name, task_row.name, print_format=_print_format_from_row(task_row)
		)
		has_pdf = bool((detail.generated_file_url or "").strip())
		confirmed = bool(detail.manuell_abgeheftet)
		return TaskCheckResult(fulfilled=has_pdf and confirmed, meta={"has_pdf": has_pdf, "confirmed": confirmed})

	def generate_pdf(self, context: TaskHandlerContext, doc: Document, task_row) -> dict:
		row_pf = _print_format_from_row(task_row)
		detail = ensure_print_detail(context, doc.name, task_row.name, print_format=row_pf)
		print_format = (detail.print_format or "").strip() or row_pf
		if not print_format:
			frappe.throw(_("Print Format fehlt fuer diese Druckaufgabe."))

		pdf_bytes = frappe.get_print(doc.doctype, doc.name, print_format=print_format, as_pdf=True)
		filename = f"{frappe.scrub(doc.name)}-{frappe.scrub(task_row.aufgabe or 'druck')}.pdf"
		file_doc = save_file(filename, pdf_bytes, doc.doctype, doc.name, is_private=0)

		detail.print_format = print_format
		detail.generated_file_url = file_doc.file_url
		detail.generated_at = now_datetime()
		detail.generated_by = frappe.session.user
		detail.save(ignore_permissions=True)
		return {"file_url": file_doc.file_url, "detail": detail.name}

	def confirm_filed(self, context: TaskHandlerContext, doc: Document, task_row, confirmed: int) -> dict:
		detail = ensure_print_detail(
			context, doc.name, task_row.name, print_format=_print_format_from_row(task_row)
		)
		is_confirmed = int(confirmed or 0) == 1
		detail.manuell_abgeheftet = 1 if is_confirmed else 0
		if is_confirmed:
			detail.bestaetigt_am = now_datetime()
			detail.bestaetigt_von = frappe.session.user
		else:
			detail.bestaetigt_am = None
			detail.bestaetigt_von = None
		detail.save(ignore_permissions=True)
		return {"confirmed": bool(is_confirmed), "detail": detail.name}

	def get_detail_ref(self, context: TaskHandlerContext, doc: Document, task_row) -> dict:
		detail = ensure_print_detail(
			context, doc.name, task_row.name, print_format=_print_format_from_row(task_row)
		)
		return {"doctype": detail.doctype, "name": detail.name}


class CreateLinkedDocTaskHandler(BaseTaskHandler):
	"""Phase 5c: Aufgabe „Neuen Vertrag anlegen"-artig.

	Konfig (konfig_json der Vorlage, zur Laufzeit live aufgeloest):
	  - target_doctype: Ziel-DocType (z.B. "Mietvertrag")
	  - store_in_payload_field: payload_json-Key, in den der neue Doc-Name geschrieben wird
	  - dialog_fields: Liste von Field-Defs fuer den Erstellungs-Dialog (Single Source of Truth)
	  - prefill_mapping: Jinja-Template pro Field, ausgewertet gegen {payload, doc}
	"""

	task_type = TASK_TYPE_CREATE_LINKED_DOC

	def config_schema(self) -> dict | None:
		# Stufe 2: target_doctype + store_in_payload_field als normale Controls; das
		# eigentliche Feld-Mapping (welches Ziel-Feld woher: Input/Manuell/Fest) rendert der
		# Editor ueber das doc_field_mapping-Widget. Kompiliert nach dialog_fields +
		# prefill_mapping in konfig_json; Reverse-Parse beim Oeffnen.
		return {
			"fields": [
				{"key": "target_doctype", "label": _("Ziel-Doctype"), "fieldtype": "Link", "options": "DocType", "reqd": 1},
				{"key": "store_in_payload_field", "label": _("Ergebnis-Feld (Name)"), "fieldtype": "Data", "reqd": 1},
				{"key": "doc_field_mapping", "label": _("Feld-Mapping"), "fieldtype": "Data", "widget": "doc_field_mapping"},
			]
		}

	def validate_config(self, step_or_task) -> None:
		config = extract_task_config(step_or_task)
		if not (config.get("target_doctype") or "").strip():
			frappe.throw(_("create_linked_doc erfordert target_doctype in der Konfig."))
		if not (config.get("store_in_payload_field") or "").strip():
			frappe.throw(_("create_linked_doc erfordert store_in_payload_field in der Konfig."))

	def declared_outputs(self, config: dict) -> list[dict]:
		field = (config.get("store_in_payload_field") or "").strip()
		if not field:
			return []
		target = (config.get("target_doctype") or "").strip()
		return [{"fieldname": field, "fieldtype": "Link" if target else "Data", "options": target}]

	def runtime_actions(self, context: TaskHandlerContext, doc: Document, task_row) -> list[dict]:
		actions = super().runtime_actions(context, doc, task_row)
		actions.append({
			"key": "create_linked", "label": _("Neu anlegen"), "primary": True,
			"dialog": "create_linked",
			"_dispatch": "create_linked_doc", "_params": {},
		})
		return actions

	def action_dialog_fields(self, context: TaskHandlerContext, doc: Document, task_row, action_key: str) -> dict:
		"""Dialog-Felder fuer den 'Neu anlegen'-Dialog (Phase C: generischer Dialog-Pfad).

		Single Source of Truth: `dialog_fields` aus der Task-Config — wir raten nichts aus
		Target-Doctype-Meta, weil Pflicht-Logik in Frappe oft an depends_on/Domain-Validatoren
		haengt. prefill_mapping-Jinja-Templates werden gegen payload_json + doc ausgewertet und
		als `default` in die Field-Defs gemerged."""
		import json as _json

		if action_key != "create_linked":
			return {"fields": []}
		config = extract_task_config(task_row)
		dialog_fields = list(config.get("dialog_fields") or [])
		prefill = config.get("prefill_mapping") or {}
		try:
			payload = _json.loads(getattr(doc, "payload_json", None) or "{}")
			if not isinstance(payload, dict):
				payload = {}
		except (ValueError, TypeError):
			payload = {}
		rendered_defaults: dict = {}
		for k, v in prefill.items():
			if isinstance(v, str) and "{{" in v:
				rendered = frappe.render_template(v, {"payload": payload, "doc": doc})
				val = (rendered or "").strip()
				# Jinja-Artefakte filtern, damit sie nicht als Default auf Date-/Link-Felder
				# landen: "None" (Python None), "null"/"undefined" (JS), unrenderter "{{...}}".
				if val.lower() in ("none", "null", "undefined") or "{{" in val:
					val = ""
				rendered_defaults[k] = val or None
			else:
				rendered_defaults[k] = v
		for fld in dialog_fields:
			fn = fld.get("fieldname")
			if fn and fn in rendered_defaults and rendered_defaults[fn] is not None:
				fld["default"] = rendered_defaults[fn]
		target_doctype = (config.get("target_doctype") or "").strip()
		return {
			"fields": dialog_fields,
			"target_doctype": target_doctype,
			"title": _("Neu anlegen: {0}").format(target_doctype) if target_doctype else _("Neu anlegen"),
			"primary_label": _("Anlegen"),
		}

	def is_fulfilled(self, context: TaskHandlerContext, doc: Document, task_row) -> TaskCheckResult:
		config = extract_task_config(task_row)
		field = (config.get("store_in_payload_field") or "").strip()
		if hasattr(doc, "payload") and callable(doc.payload):
			value = doc.payload(field)
		else:
			value = doc.get(field)
		return TaskCheckResult(fulfilled=bool(value), meta={"value": value, "field": field})

	def create_linked_doc(self, context: TaskHandlerContext, doc: Document, task_row, user_values: dict | None = None) -> dict:
		"""Erstellt target_doc mit user_values + Pre-Fill aus Payload."""
		import json as _json

		config = extract_task_config(task_row)
		target_doctype = (config.get("target_doctype") or "").strip()
		field = (config.get("store_in_payload_field") or "").strip()
		prefill_template = config.get("prefill_mapping") or {}
		if not target_doctype or not field:
			frappe.throw(_("create_linked_doc-Task ist nicht korrekt konfiguriert."))

		# Pre-Fill via Jinja-Eval gegen doc.payload
		payload: dict = {}
		raw_payload = getattr(doc, "payload_json", None)
		if raw_payload:
			try:
				parsed = _json.loads(raw_payload)
				if isinstance(parsed, dict):
					payload = parsed
			except (ValueError, TypeError):
				pass
		prefilled: dict = {}
		for k, v_template in prefill_template.items():
			if isinstance(v_template, str) and "{{" in v_template:
				rendered = frappe.render_template(v_template, {"payload": payload, "doc": doc})
				prefilled[k] = (rendered or "").strip() or None
			else:
				prefilled[k] = v_template

		new_doc_data = {**prefilled, **(user_values or {})}
		new_doc_data["doctype"] = target_doctype
		new_doc = frappe.get_doc(new_doc_data).insert(ignore_permissions=False)

		# Zurueckschreiben in payload + Task auf Erledigt
		if hasattr(doc, "payload_set") and callable(doc.payload_set):
			doc.payload_set(field, new_doc.name)
		else:
			doc.set(field, new_doc.name)
		task_row.status = "Erledigt"
		task_row.result_json = frappe.as_json({"created": new_doc.name})
		doc.save(ignore_permissions=True)
		return {"created_doctype": target_doctype, "created_name": new_doc.name}


class DeriveTaskHandler(BaseTaskHandler):
	"""Auto-Run-Node: leitet einen Wert aus einem Payload-Objekt ueber einen Pfad ab.

	Config (konfig_json):
	  - source_field: Payload-Feld, das den Quell-Docname haelt (Link-Feld-Spec)
	  - source_doctype: Doctype des Quell-Objekts (vom Pfad-Picker aus der Feld-Spec gesetzt)
	  - path: Punkt-Pfad im Quell-Doctype (z.B. "wohnung" oder "wohnung.immobilie"),
	    virtuell-bewusst aufgeloest (siehe path_resolver).
	  - store_in_payload_field: Payload-Feld fuer das Ergebnis

	Laeuft automatisch (kein Mensch): die Engine fuehrt run_action aus, sobald das
	source_field im Payload vorhanden ist (Auto-Run). `is_auto` markiert das fuer den
	Run-/Abschluss-Pfad; im UI erscheint kein „Erledigt"-Klick.
	"""

	task_type = TASK_TYPE_DERIVE
	is_auto = True

	def config_schema(self) -> dict | None:
		return {
			"fields": [
				{"key": "source_field", "label": _("Quelle (Payload-Feld)"), "fieldtype": "Data", "widget": "payload_field_select", "reqd": 1},
				{"key": "path", "label": _("Pfad"), "fieldtype": "Data", "widget": "path_picker", "reqd": 1},
				{"key": "store_in_payload_field", "label": _("Ergebnis-Feld (Name)"), "fieldtype": "Data", "reqd": 1},
			]
		}

	def declared_outputs(self, config: dict) -> list[dict]:
		from process_engine.process_engine.processes.path_resolver import path_terminal_type

		field = (config.get("store_in_payload_field") or "").strip()
		if not field:
			return []
		source_doctype = (config.get("source_doctype") or "").strip()
		path = (config.get("path") or "").strip()
		fieldtype, options = path_terminal_type(source_doctype, path) if (source_doctype and path) else ("Data", "")
		return [{"fieldname": field, "fieldtype": fieldtype, "options": options}]

	def validate_config(self, step_or_task) -> None:
		config = extract_task_config(step_or_task)
		for key in ("source_field", "path", "store_in_payload_field", "source_doctype"):
			if not (config.get(key) or "").strip():
				frappe.throw(_("derive erfordert '{0}' in der Konfig.").format(key))

		source_doctype = config["source_doctype"].strip()
		# Pfad gegen Meta validieren -> kaputte Pfade fallen beim Speichern auf, nicht erst
		# zur Laufzeit als geloggter Auto-Run-Fehler.
		from process_engine.process_engine.processes.path_resolver import validate_path

		validate_path(source_doctype, config["path"].strip())

		# Best-effort Cross-Check gegen die Versions-Feldspecs: prozess_version.py setzt sie als
		# row.flags.version_payload_specs. Im Temporal-/Seed-Pfad (frappe._dict) fehlt das -> skip.
		specs = None
		flags = getattr(step_or_task, "flags", None)
		if flags is not None:
			try:
				specs = flags.get("version_payload_specs")
			except Exception:
				specs = None
		if specs is not None:
			# Nur die QUELLE wird gegen die Specs geprueft (sie ist ein vom Nutzer deklarierter
			# Start-Input). Das Ergebnis-Feld (store_in_payload_field) wird NICHT geprueft — es
			# wird typ-getrieben automatisch angelegt (declared_outputs + _sync_declared_outputs).
			by_name = {(s.get("fieldname") or "").strip(): s for s in specs}
			src_field = config["source_field"].strip()
			src_spec = by_name.get(src_field)
			if src_spec is None:
				frappe.throw(_("derive: source_field '{0}' ist kein deklariertes Payload-Feld.").format(src_field))
			if (src_spec.get("fieldtype") or "") != "Link" or (src_spec.get("options") or "").strip() != source_doctype:
				frappe.throw(
					_("derive: source_field '{0}' muss ein Link auf {1} sein (laut Payload-Feld-Spec).").format(
						src_field, source_doctype
					)
				)

	def runtime_actions(self, context: TaskHandlerContext, doc: Document, task_row) -> list[dict]:
		# Auto-Run-Knoten: kein manueller "Erledigt"-Klick. Die Engine fuehrt run_action
		# automatisch aus, sobald die Inputs vorhanden sind (_run_auto_steps).
		return []

	def can_auto_run(self, context: TaskHandlerContext, doc: Document, task_row) -> bool:
		# Erst ableiten, wenn die Quelle wirklich im Payload steht. Sonst wuerde ein leerer
		# Auto-Run den Output auf None setzen + den Schritt faelschlich abschliessen — und ein
		# spaeter eintreffender Input wuerde nie mehr verarbeitet (Status bleibt Erledigt).
		config = extract_task_config(task_row)
		source_field = (config.get("source_field") or "").strip()
		if not source_field:
			return False
		if hasattr(doc, "payload") and callable(doc.payload):
			val = doc.payload(source_field)
		else:
			val = doc.get(source_field)
		return bool(str(val).strip()) if val is not None else False

	def run_action(self, context: TaskHandlerContext, doc: Document, task_row, payload: dict | None = None) -> dict:
		# Lazy-Import: path_resolver ist ein Leaf-Modul; lokaler Import vermeidet jede
		# Import-Reihenfolge-Abhaengigkeit beim App-Boot.
		from process_engine.process_engine.processes.path_resolver import resolve_path

		config = extract_task_config(task_row)
		source_field = (config.get("source_field") or "").strip()
		source_doctype = (config.get("source_doctype") or "").strip()
		path = (config.get("path") or "").strip()
		out_field = (config.get("store_in_payload_field") or "").strip()
		if not (source_field and source_doctype and path and out_field):
			frappe.throw(_("derive-Task ist nicht korrekt konfiguriert."))

		if hasattr(doc, "payload") and callable(doc.payload):
			source_name = doc.payload(source_field)
		else:
			source_name = doc.get(source_field)
		source_name = "" if source_name is None else str(source_name).strip()
		if not source_name:
			# Quelle (noch) nicht vorhanden -> nichts ableiten und den Schritt NICHT abschliessen,
			# damit ein spaeter eintreffender Input noch verarbeitet wird (Defense-in-Depth zu
			# can_auto_run, das diesen Fall im Auto-Run bereits abfaengt).
			return {"field": out_field, "value": None, "skipped": True}
		value = resolve_path(source_doctype, source_name, path)
		if value is None or value == "":
			# Quelle da, aber der (Zwischen-)Wert ist noch nicht aufloesbar — z.B.
			# wohnung.aktueller_mietvertrag, bevor ein Vertrag existiert. NICHT abschliessen und
			# keinen Output setzen, damit es bei einem spaeteren Save erneut laeuft. (0/False
			# gelten bewusst als gueltige Ergebnisse und schliessen ab.)
			return {"field": out_field, "value": value, "skipped": True}

		if hasattr(doc, "payload_set") and callable(doc.payload_set):
			doc.payload_set(out_field, value)
		else:
			doc.set(out_field, value)
		task_row.status = "Erledigt"
		task_row.result_json = frappe.as_json({"derived": value, "field": out_field, "path": path})
		return {"field": out_field, "value": value}


class TaskHandlerRegistry:
	def __init__(self):
		self._handlers = {
			TASK_TYPE_MANUAL_CHECK: ManualCheckTaskHandler(),
			TASK_TYPE_PYTHON_ACTION: PythonActionTaskHandler(),
			TASK_TYPE_PAPERLESS_EXPORT: PaperlessExportTaskHandler(),
			TASK_TYPE_PRINT_DOCUMENT: PrintDocumentTaskHandler(),
			TASK_TYPE_CREATE_LINKED_DOC: CreateLinkedDocTaskHandler(),
			TASK_TYPE_DERIVE: DeriveTaskHandler(),
		}

	def get_handler(self, *, handler_key: str | None = None, task_type: str | None = None, context: TaskHandlerContext | None = None) -> BaseTaskHandler:
		key = (handler_key or "").strip()
		if key and context and key in context.custom_handlers:
			return context.custom_handlers[key]
		if key and key in self._handlers:
			return self._handlers[key]
		return self._handlers.get(normalize_task_type(task_type), self._handlers[TASK_TYPE_MANUAL_CHECK])


def ensure_file_detail(context: TaskHandlerContext, docname: str, aufgabe_row_name: str):
	doctype = (context.file_detail_doctype or "").strip()
	doctype_field = (context.file_detail_doctype_field or "").strip()
	name_field = (context.file_detail_name_field or "").strip()
	if not doctype or not doctype_field or not name_field:
		frappe.throw(_("Datei-Detail-Doctype ist fuer diesen Prozess nicht konfiguriert."))

	name = frappe.db.get_value(
		doctype,
		{doctype_field: (context.runtime_doctype or "").strip(), name_field: docname, "aufgabe_row_name": aufgabe_row_name},
		"name",
	)
	if name:
		return frappe.get_doc(doctype, name)

	detail = frappe.get_doc(
		{
			"doctype": doctype,
			doctype_field: (context.runtime_doctype or "").strip(),
			name_field: docname,
			"aufgabe_row_name": aufgabe_row_name,
			"paperless_status": "Offen",
		}
	)
	detail.insert(ignore_permissions=True, ignore_links=True)
	return detail


def ensure_print_detail(
	context: TaskHandlerContext,
	docname: str,
	aufgabe_row_name: str,
	*,
	print_format: str = "",
):
	doctype = (context.print_detail_doctype or "").strip()
	doctype_field = (context.print_detail_doctype_field or "").strip()
	name_field = (context.print_detail_name_field or "").strip()
	if not doctype or not doctype_field or not name_field:
		frappe.throw(_("Druck-Detail-Doctype ist fuer diesen Prozess nicht konfiguriert."))

	name = frappe.db.get_value(
		doctype,
		{doctype_field: (context.runtime_doctype or "").strip(), name_field: docname, "aufgabe_row_name": aufgabe_row_name},
		"name",
	)
	if name:
		return frappe.get_doc(doctype, name)

	payload = {
		"doctype": doctype,
		doctype_field: (context.runtime_doctype or "").strip(),
		name_field: docname,
		"aufgabe_row_name": aufgabe_row_name,
	}
	pf = (print_format or "").strip()
	if pf:
		payload["print_format"] = pf
	detail = frappe.get_doc(payload)
	detail.insert(ignore_permissions=True, ignore_links=True)
	return detail


def _print_format_from_row(task_row) -> str:
	return (extract_task_config(task_row).get("print_format") or "").strip()


def _default_tag_builder(doc: Document, variant: str) -> list[str]:
	return [f"{doc.doctype}", f"{doc.doctype} {doc.name}", f"{doc.doctype} Dokument {variant}"]
