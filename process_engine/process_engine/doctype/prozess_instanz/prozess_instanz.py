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
def get_active_version(prozess_typ: str | None = None) -> dict:
	"""Aktive Prozess Version eines Typs — fuer die Vorbelegung von prozess_version im
	Neu-Formular, damit sie sofort sichtbar ist. Nutzt dieselbe Auflösung wie die
	Instanziierung (engine._get_active_process_version: is_active + prozess_typ +
	Gueltigkeitszeitraum). Leeres Dict, wenn kein Typ/keine aktive Version."""
	from process_engine.process_engine.processes.engine import get_runtime_config_for_typ

	if not prozess_typ:
		return {}
	cfg = get_runtime_config_for_typ(prozess_typ)
	if not cfg:
		return {}
	version = ProcessEngine(cfg)._get_active_process_version(prozess_typ)
	if not version or not version.get("name"):
		return {}
	return {
		"name": version.get("name"),
		"label": (version.get("version_key") or version.get("titel") or "").strip(),
	}


@frappe.whitelist()
def dispatch_workflow_action(
	docname: str, action: str, payload_json: str | None = None, timeout_seconds: int = 5
) -> dict:
	return ProcessEngine.for_doctype_and_docname("Prozess Instanz", docname).dispatch_workflow_action(
		docname, action, payload_json=payload_json, timeout_seconds=timeout_seconds
	)


@frappe.whitelist()
def get_task_action_dialog(docname: str, row_name: str, action_key: str) -> dict:
	"""Phase C: generische Dialog-Felder fuer eine vom Handler deklarierte Laufzeit-Aktion.

	Loest den Handler der Aufgabe auf, prueft dass `action_key` in dessen
	runtime_actions-Selbstbeschreibung steht (Allowlist) und delegiert an
	handler.action_dialog_fields(). Loest create_linked und beliebige Consumer-Dialoge
	ueber denselben Pfad. Rueckgabe: {fields, title?, primary_label?, ...}."""
	doc = frappe.get_doc("Prozess Instanz", docname)
	# write statt read: der Dialog fuehrt i.d.R. zu einer Aenderung an der Prozess Instanz
	doc.check_permission("write")
	engine = ProcessEngine.for_instance(doc)
	ctx = engine.config.task_handler_context
	row = next((r for r in (doc.aufgaben or []) if r.name == row_name), None)
	if not row:
		frappe.throw(_("Aufgabe '{0}' nicht gefunden.").format(row_name))
	handler = engine._get_task_handler(row)
	descriptors = handler.runtime_actions(ctx, doc, row) or []
	if not any(d.get("key") == action_key for d in descriptors):
		frappe.throw(_("Unbekannte oder nicht erlaubte Aktion: {0}").format(action_key))
	return handler.action_dialog_fields(ctx, doc, row, action_key) or {"fields": []}


@frappe.whitelist()
def get_create_linked_dialog_fields(docname: str, row_name: str) -> dict:
	"""Backward-Compat-Wrapper: create_linked-Dialog laeuft jetzt ueber den generischen
	Pfad (get_task_action_dialog -> handler.action_dialog_fields)."""
	return get_task_action_dialog(docname, row_name, "create_linked")


def _sanitize_task_view(view) -> dict | None:
	"""Validiert/saeubert einen task_view-Descriptor. `component` ist Pflicht. `bundle` darf nur
	ein lokales App-Asset sein (/assets/...), keine externe URL — billige, klare Boundary.
	`props` nur als dict. Der Client spiegelt die Bundle-Pruefung (defense in depth)."""
	if not isinstance(view, dict):
		return None
	component = (view.get("component") or "").strip()
	if not component:
		return None
	out: dict = {"component": component}
	bundle = (view.get("bundle") or "").strip()
	if bundle:
		if bundle.startswith("/assets/"):
			out["bundle"] = bundle
		else:
			frappe.log_error(
				title="task_view: unsicheres bundle ignoriert",
				message=f"component={component} bundle={bundle}",
			)
	props = view.get("props")
	if isinstance(props, dict):
		out["props"] = props
	return out


@frappe.whitelist()
def get_task_views(docname: str) -> dict:
	"""Phase E: pro Aufgabe ein optionaler Custom-View-Descriptor (Handler-Selbstbeschreibung).

	Rueckgabe: {row_name: {component, bundle?, props?} | None}. None -> generisches Rendering.
	Der Client laedt `bundle` lazy, schlaegt `component` in window.process_engine.task_views
	nach und mountet es. Es wird nie Code aus dem Descriptor ausgefuehrt — nur ein Name."""
	doc = frappe.get_doc("Prozess Instanz", docname)
	doc.check_permission("read")
	engine = ProcessEngine.for_instance(doc)
	ctx = engine.config.task_handler_context

	result: dict = {}
	for row in doc.aufgaben or []:
		try:
			view = engine._get_task_handler(row).task_view(ctx, doc, row)
		except Exception:
			frappe.log_error(
				title="task_view fehlgeschlagen",
				message=f"Prozess Instanz {doc.name}, Row {row.name}\n{frappe.get_traceback()}",
			)
			view = None
		result[row.name] = _sanitize_task_view(view)
	return result


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
			# Phase D: `navigate` (rein deklarativ, serverseitig berechnet) + `has_action`
			# (ob es ueberhaupt ein Dispatch-Ziel gibt) gehen an den Client. `_dispatch`/
			# `_params` bleiben weiterhin server-only.
			client_actions.append({
				"key": d.get("key"),
				"label": d.get("label"),
				"primary": bool(d.get("primary")),
				"dialog": d.get("dialog") or "",
				"navigate": _sanitize_navigate(d.get("navigate")),
				"has_action": bool((d.get("_dispatch") or "").strip()),
				"disabled": disabled,
				"reason": reason,
			})
		result[row.name] = client_actions
	return result


# Phase D: nur diese Navigations-Arten sind erlaubt. Allowlist serverseitig, damit ein
# Handler den Client nicht zu beliebigen Aktionen verleiten kann; der Client spiegelt sie.
_ALLOWED_NAVIGATE_KINDS = {"route", "url", "form"}


def _sanitize_navigate(navigate) -> dict | None:
	"""Validiert einen navigate-Descriptor aus runtime_actions. Unbekannte/kaputte ->
	None (Button verhaelt sich dann wie eine normale Action ohne Navigation)."""
	if not isinstance(navigate, dict):
		return None
	kind = (navigate.get("kind") or "").strip()
	if kind not in _ALLOWED_NAVIGATE_KINDS:
		return None
	target = navigate.get("target")
	if kind == "route" and not isinstance(target, (list, tuple)):
		return None
	if kind == "form" and not (isinstance(target, dict) and target.get("doctype") and target.get("name")):
		return None
	if kind == "url" and not (isinstance(target, str) and target.strip()):
		return None
	return {"kind": kind, "target": list(target) if isinstance(target, tuple) else target}


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


@frappe.whitelist()
def get_instance_payload_view(docname: str) -> list[dict]:
	"""Laufzeit-Kontext-Panel: aktueller Payload der Instanz, typ-angereichert.

	Joint die Werte (payload_json) mit den Feld-Specs der referenzierten Version. Liefert pro
	Feld {fieldname, label, fieldtype, link_doctype, value, is_set} — Link-Felder kann der
	Client damit als klickbaren Verweis (/app/<doctype>/<value>) rendern, der waehrend des
	Abarbeitens dauerhaft sichtbar bleibt. Genau dafuer sind die typisierten Payload-Felder da.
	"""
	doc = frappe.get_doc("Prozess Instanz", docname)
	doc.check_permission("read")

	try:
		payload = json.loads(doc.payload_json or "{}")
		if not isinstance(payload, dict):
			payload = {}
	except (ValueError, TypeError):
		payload = {}

	# Specs der referenzierten Version; Fallback auf die aktive Version des Typs (z.B. wenn
	# das Versionsfeld bei sehr alten Instanzen leer ist).
	version_name = (doc.get("prozess_version") or "").strip()
	if not version_name:
		version_name = (
			frappe.db.get_value(
				"Prozess Version",
				{"prozess_typ": (doc.get("prozess_typ") or "").strip(), "is_active": 1},
				"name",
			)
			or ""
		)
	specs = []
	if version_name and frappe.db.exists("Prozess Version", version_name):
		specs = frappe.get_cached_doc("Prozess Version", version_name).get("payload_field_specs") or []

	out: list[dict] = []
	for s in specs:
		fn = (s.get("fieldname") or "").strip()
		if not fn:
			continue
		fieldtype = (s.get("fieldtype") or "Data").strip()
		value = payload.get(fn)
		out.append({
			"fieldname": fn,
			"label": (s.get("label") or "").strip() or fn,
			"fieldtype": fieldtype,
			"link_doctype": (s.get("options") or "").strip() if fieldtype == "Link" else "",
			"value": value,
			"is_set": value not in (None, ""),
		})
	return out
