from __future__ import annotations

import json

import frappe
from frappe import _

from process_engine.process_engine.processes import BaseProcessDocument, ProcessEngine


class ProzessInstanz(BaseProcessDocument):
	"""Generischer Prozess-Doctype. Domain-spezifische Daten in payload_json.

	Die Runtime-Config wird nicht aus _PROCESS_RUNTIMES, sondern aus dem
	prozess_typ-Doc geladen (siehe engine.py:get_runtime_config_for_typ)."""

	def payload(self, key: str, default=None):
		"""Convenience-Accessor fuer payload_json-Felder. In Print-Formaten verwendbar
		als {{ doc.payload('wohnung') }}."""
		raw = (self.payload_json or "").strip()
		if not raw:
			return default
		try:
			data = json.loads(raw)
		except (ValueError, TypeError):
			return default
		if not isinstance(data, dict):
			return default
		return data.get(key, default)

	def payload_set(self, key: str, value) -> None:
		"""Convenience-Setter — schreibt zurueck in payload_json."""
		raw = (self.payload_json or "").strip()
		try:
			data = json.loads(raw) if raw else {}
		except (ValueError, TypeError):
			data = {}
		if not isinstance(data, dict):
			data = {}
		data[key] = value
		self.payload_json = json.dumps(data, ensure_ascii=False)


@frappe.whitelist()
def get_completion_blockers(docname: str) -> dict:
	return ProcessEngine.for_doctype_and_docname("Prozess Instanz", docname).get_completion_blockers(docname)


@frappe.whitelist()
def get_seed_tasks_preview(prozess_typ: str | None = None) -> dict:
	from process_engine.process_engine.processes.engine import get_runtime_config_for_typ

	if not prozess_typ:
		frappe.throw("prozess_typ ist Pflicht.")
	cfg = get_runtime_config_for_typ(prozess_typ)
	if not cfg:
		frappe.throw(f"Kein aktiver Prozess Typ '{prozess_typ}' gefunden.")
	return ProcessEngine(cfg).get_seed_tasks_preview(prozess_typ)


@frappe.whitelist()
def dispatch_workflow_action(
	docname: str, action: str, payload_json: str | None = None, timeout_seconds: int = 5
) -> dict:
	return ProcessEngine.for_doctype_and_docname("Prozess Instanz", docname).dispatch_workflow_action(
		docname, action, payload_json=payload_json, timeout_seconds=timeout_seconds
	)


@frappe.whitelist()
def get_create_linked_dialog_fields(docname: str, row_name: str) -> dict:
	"""Liefert die Dialog-Field-Definitionen fuer eine create_linked_doc-Aufgabe.

	Single Source of Truth: `dialog_fields` aus der Task-Config. Wir raten nichts
	aus Target-Doctype-Meta — weil Pflicht-Logik in Frappe oft an depends_on/
	Domain-Validatoren haengt und nicht zuverlaessig ableitbar ist.

	prefill_mapping-Jinja-Templates werden gegen das aktuelle payload_json + doc
	ausgewertet und als `default`-Werte in die Field-Defs gemerged.
	"""
	import json as _json

	doc = frappe.get_doc("Prozess Instanz", docname)
	# write statt read: der Dialog fuehrt zu einer Aenderung an der Prozess Instanz
	doc.check_permission("write")
	row = next((r for r in (doc.aufgaben or []) if r.name == row_name), None)
	if not row:
		frappe.throw(f"Task-Row '{row_name}' nicht gefunden.")
	# Phase 10: Aufgaben tragen keine eigene Config mehr — live aus der Prozess Version
	# aufloesen (extract_task_config erkennt die Aufgabe und resolved Version->Schritt).
	from process_engine.process_engine.processes.task_registry import extract_task_config

	config = extract_task_config(row)
	dialog_fields = list(config.get("dialog_fields") or [])
	prefill = config.get("prefill_mapping") or {}
	try:
		payload = _json.loads(doc.payload_json or "{}")
		if not isinstance(payload, dict):
			payload = {}
	except (ValueError, TypeError):
		payload = {}
	rendered_defaults: dict = {}
	for k, v in prefill.items():
		if isinstance(v, str) and "{{" in v:
			rendered = frappe.render_template(v, {"payload": payload, "doc": doc})
			val = (rendered or "").strip()
			# Jinja-Artefakte filtern, damit das nicht als Default auf Form-Fields
			# landet und z.B. den Date-Picker mit "undefined, NaN" verwirrt:
			#   - "None"      → payload[key] war Python None
			#   - "null" / "undefined" → JS-Artefakte
			#   - String enthaelt "{{" → Frappe's render_template gibt bei fehlendem
			#     dict-key einen unrenderten Platzhalter zurueck
			if val.lower() in ("none", "null", "undefined") or "{{" in val:
				val = ""
			rendered_defaults[k] = val or None
		else:
			rendered_defaults[k] = v
	for fld in dialog_fields:
		fn = fld.get("fieldname")
		if fn and fn in rendered_defaults and rendered_defaults[fn] is not None:
			fld["default"] = rendered_defaults[fn]
	return {"fields": dialog_fields, "target_doctype": (config.get("target_doctype") or "")}


# ==================== Phase 13 B: Selbstbeschreibende Laufzeit-Aktionen ====================
#
# Der Aufgabentyp-Handler (runtime_actions) ist Single Source of Truth fuer die
# anzeigbaren/erlaubten Laufzeit-Aktionen einer Aufgabe. Der Client rendert sie nur
# generisch und schickt beim Klick NUR den semantischen `action_key` zurueck — nie einen
# Handler-Methoden- oder Dispatch-Namen. run_task_action schlaegt den key in der
# Handler-Selbstbeschreibung nach, prueft Gates erneut serverseitig und mappt ihn auf die
# bereits whitelistete ACTION_*-Dispatch-Action (dispatch_workflow_action -> dispatch_local).


def _instance_lock_reason(doc) -> str:
	"""Grund, warum eine ganze Prozess Instanz keine Aufgaben-Aktionen mehr zulaesst
	(abgeschlossen / eingereicht / storniert). Leerer String = nicht gesperrt."""
	from process_engine.process_engine.processes.engine import (
		STATUS_ABGESCHLOSSEN,
		STATUS_ABGESCHLOSSEN_BYPASS,
	)

	if int(doc.docstatus or 0) != 0:
		return _("Prozess Instanz ist nicht mehr aenderbar.")
	if (doc.get("status") or "").strip() in {STATUS_ABGESCHLOSSEN, STATUS_ABGESCHLOSSEN_BYPASS}:
		return _("Prozess Instanz ist abgeschlossen.")
	return ""


def _apply_action_gates(engine, doc, row, descriptor: dict, instance_lock_reason: str) -> tuple[bool, str]:
	"""Berechnet (disabled, reason) fuer eine Action — gleiche Logik fuer Anzeige (Batch)
	und Ausfuehrung. Reihenfolge: (1) Handler-eigenes disabled, (2) Instanz-Lock
	(abgeschlossen/eingereicht) gilt fuer ALLE Actions, (3) `ignore_lock` ueberspringt nur
	den Task-Vorgaenger-Lock (z.B. Wieder oeffnen), (4) Vorgaenger-Lock. ignore_lock darf den
	Instanz-Lock NICHT umgehen — sonst liesse sich z.B. eine abgeschlossene Instanz reopen-en."""
	if descriptor.get("disabled"):
		return True, (descriptor.get("reason") or _("Aktion ist derzeit nicht erlaubt."))
	if instance_lock_reason:
		return True, instance_lock_reason
	if descriptor.get("ignore_lock"):
		return False, ""
	if bool(getattr(row, "pflicht", 0)) and not engine._is_task_unlocked(doc, row):
		return True, _("Vorgaenger noch nicht freigegeben.")
	return False, ""


@frappe.whitelist()
def get_task_runtime_actions(docname: str) -> dict:
	"""Pro Aufgabe die client-tauglichen Laufzeit-Aktionen (aus der Handler-Selbstbeschreibung).

	Rueckgabe: {row_name: [{key, label, primary, dialog, disabled, reason}, ...]}.
	Server-only Felder (`_dispatch`/`_params`/`ignore_lock`) werden gestrippt — der Client
	sieht nie ein Dispatch-Ziel."""
	doc = frappe.get_doc("Prozess Instanz", docname)
	doc.check_permission("read")
	engine = ProcessEngine.for_instance(doc)
	ctx = engine.config.task_handler_context
	instance_lock_reason = _instance_lock_reason(doc)

	result: dict = {}
	for row in doc.aufgaben or []:
		try:
			descriptors = engine._get_task_handler(row).runtime_actions(ctx, doc, row) or []
		except Exception:
			frappe.log_error(
				title="runtime_actions fehlgeschlagen",
				message=f"Prozess Instanz {doc.name}, Row {row.name}\n{frappe.get_traceback()}",
			)
			descriptors = []
		client_actions = []
		for d in descriptors:
			disabled, reason = _apply_action_gates(engine, doc, row, d, instance_lock_reason)
			client_actions.append({
				"key": d.get("key"),
				"label": d.get("label"),
				"primary": bool(d.get("primary")),
				"dialog": d.get("dialog") or "",
				"disabled": disabled,
				"reason": reason,
			})
		result[row.name] = client_actions
	return result


@frappe.whitelist()
def run_task_action(docname: str, row_name: str, action_key: str, payload_json: str | None = None) -> dict:
	"""Fuehrt eine vom Handler deklarierte Laufzeit-Aktion aus.

	Sicherheit: Der Client schickt nur `action_key`. Wir laden die Handler-Selbstbeschreibung
	fuer GENAU diese Aufgabe, suchen den passenden Descriptor (Allowlist — unbekannte keys ->
	Throw), pruefen die Gates erneut serverseitig und mappen `_dispatch` (eine ACTION_*-
	Konstante) auf dispatch_workflow_action. _params (serverseitig deklariert) werden mit dem
	Client-payload gemerged; row_name wird immer serverseitig gesetzt."""
	doc = frappe.get_doc("Prozess Instanz", docname)
	doc.check_permission("write")
	engine = ProcessEngine.for_instance(doc)
	ctx = engine.config.task_handler_context

	row = next((r for r in (doc.aufgaben or []) if r.name == row_name), None)
	if not row:
		frappe.throw(_("Aufgabe '{0}' nicht gefunden.").format(row_name))

	descriptors = engine._get_task_handler(row).runtime_actions(ctx, doc, row) or []
	descriptor = next((d for d in descriptors if d.get("key") == action_key), None)
	if descriptor is None:
		frappe.throw(_("Unbekannte oder nicht erlaubte Aktion: {0}").format(action_key))

	disabled, reason = _apply_action_gates(engine, doc, row, descriptor, _instance_lock_reason(doc))
	if disabled:
		frappe.throw(reason)

	dispatch_action = (descriptor.get("_dispatch") or "").strip()
	if not dispatch_action:
		frappe.throw(_("Aktion '{0}' hat kein Dispatch-Ziel.").format(action_key))

	params = dict(descriptor.get("_params") or {})
	if payload_json:
		try:
			extra = json.loads(payload_json)
			if isinstance(extra, dict):
				params.update(extra)
		except (ValueError, TypeError):
			pass
	params["row_name"] = row_name
	return engine.dispatch_workflow_action(docname, dispatch_action, payload_json=json.dumps(params))
