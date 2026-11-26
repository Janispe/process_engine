"""Commit-backed execution of automatic process tasks."""

from hashlib import sha256
from uuid import uuid4

import frappe
from redis.exceptions import RedisError
from frappe import _
from frappe.utils import add_to_date, get_datetime, now_datetime

from . import linked_create
from .task_registry import (
	CreateLinkedDocTaskHandler,
	EmailDraftTaskHandler,
	PaperlessExportTaskHandler,
	TASK_TYPE_CREATE_LINKED_DOC,
	TASK_TYPE_EMAIL_DRAFT,
	TASK_TYPE_PAPERLESS_EXPORT,
	TASK_TYPE_PYTHON_ACTION,
	extract_task_config,
)

WAITING = "Wartet"
RUNNING = "Läuft"
DONE = "Erledigt"
FAILED = "Fehler"
MAX_ATTEMPTS = 3
JOB_TIMEOUT = 300
LEASE_SECONDS = 900
JOB = "process_engine.process_engine.processes.automatic.execute"
FIELDS = (
	"ausfuehrungsstatus", "ausfuehrungsfehler", "ausfuehrung_am", "ausfuehrung_faellig",
	"ausfuehrung_ablauf", "ausfuehrung_versuche", "ausfuehrung_generation", "ausfuehrung_key",
	"ausfuehrung_actor", "ausfuehrung_ungeklaert", "ausfuehrung_token", "ausfuehrung_input",
)


class UncertainEffect(Exception):
	"""The effect may have happened. Future attempts may only reconcile it."""


def validate_step(step, handler):
	config = extract_task_config(step)
	if config.get("allow_ai_proposals"):
		frappe.throw(_("Schritt {0}: KI-Vorschläge und automatische Ausführung schließen sich aus.").format(step.step_key))
	built_in = {
		TASK_TYPE_CREATE_LINKED_DOC: CreateLinkedDocTaskHandler,
		TASK_TYPE_EMAIL_DRAFT: EmailDraftTaskHandler,
		TASK_TYPE_PAPERLESS_EXPORT: PaperlessExportTaskHandler,
	}
	supported = (
		handler.supports_background_execution
		if step.task_type == TASK_TYPE_PYTHON_ACTION
		else type(handler) is built_in.get(step.task_type)
	)
	if not supported:
		frappe.throw(_("Schritt {0}: Der Handler unterstützt keine automatische Ausführung.").format(step.step_key))
	handler.validate_automatic_config(step)


def enabled(engine, doc, row):
	step = engine.step_definition(doc, row)
	return bool(step and step.get("automatisch"))


def prepare(engine, doc):
	rows = doc.get(engine.config.task_fieldname) or []
	previous = doc.get_doc_before_save()
	previous_rows = {row.name: row for row in previous.get(engine.config.task_fieldname) or []} if previous else {}
	current_names = {row.name for row in rows}
	for row in rows:
		old = previous_rows.get(row.name)
		step = engine.step_definition(doc, row)
		if not step or not step.get("automatisch"):
			if old and old.get("ausfuehrungsstatus"):
				frappe.throw(_("Eine automatische Aufgabe darf nicht umgewidmet werden."))
			for field in FIELDS:
				if row.get(field) is not None:
					row.set(field, None)
			continue
		if engine.is_temporal_backend(doc):
			frappe.throw(_("Automatische Aufgaben werden mit Temporal nicht unterstützt."))
		if (
			sum(other.step_key == row.step_key for other in rows) != 1
			or row.task_type != step.task_type
			or (row.handler_key or row.task_type) != (step.handler_key or step.task_type)
		):
			frappe.throw(_("Der Schlüssel einer automatischen Aufgabe muss eindeutig und unveränderlich sein."))
		if not doc.flags.automatic_execution:
			for field in FIELDS:
				row.set(field, old.get(field) if old else None)
		if not row.ausfuehrungsstatus:
			row.ausfuehrungsstatus = WAITING
			row.ausfuehrung_am = now_datetime()
			row.ausfuehrung_actor = frappe.session.user
		if row.status == DONE and (
			row.ausfuehrungsstatus != DONE
			or not doc.flags.automatic_execution and (not old or old.status != DONE)
		):
			row.status = "Offen"
		row.erfuellt = int(row.ausfuehrungsstatus == DONE and row.status == DONE)
		if not row.erfuellt:
			row.erfuellt_am = None
			row.erfuellt_von = None
	if any(
		old.get("ausfuehrungsstatus") and old.name not in current_names
		for old in previous_rows.values()
	):
		frappe.throw(_("Automatische Aufgaben dürfen nicht ersetzt werden."))


def _enqueue(doctype, name, row_name):
	try:
		frappe.enqueue(
			JOB, doctype=doctype, name=name, row_name=row_name, timeout=JOB_TIMEOUT,
			enqueue_after_commit=True,
		)
	except RedisError:
		# The task is persisted independently and can be found by the sweeper.
		frappe.logger().warning("Automatic process job queue unavailable for %s", row_name)


def _active(doc):
	return doc.docstatus == 0 and doc.get("status") not in {"Abgeschlossen", "Abgeschlossen (Bypass)"}


def _due(value):
	return not value or get_datetime(value) <= now_datetime()


def _eligible(row):
	status = row.ausfuehrungsstatus
	return (
		status == WAITING
		or status == FAILED and row.ausfuehrung_faellig and _due(row.ausfuehrung_faellig)
		or status == RUNNING and _due(row.ausfuehrung_ablauf)
	)


def _ready(engine, doc, row):
	handler = engine._get_task_handler(row)
	return engine._is_task_unlocked(doc, row) and handler.can_auto_run(engine.config.task_handler_context, doc, row)


def enqueue_ready(engine, doc):
	if not _active(doc):
		return
	for row in doc.get(engine.config.task_fieldname) or []:
		if row.get("ausfuehrungsstatus") == WAITING and _ready(engine, doc, row):
			_enqueue(doc.doctype, doc.name, row.name)


def sweep():
	"""Recover missing queue entries, due retries and abandoned claims."""
	from .engine import ProcessEngine

	for row in frappe.get_all(
		"Prozess Aufgabe", filters={"ausfuehrungsstatus": ["in", [WAITING, RUNNING, FAILED]]},
		fields=["name", "parent", "parenttype", "ausfuehrungsstatus", "ausfuehrung_ablauf", "ausfuehrung_faellig"],
	):
		if not _eligible(row):
			continue
		try:
			doc = frappe.get_doc(row.parenttype, row.parent)
			engine = ProcessEngine.for_instance(doc) if doc.doctype == linked_create.INSTANCE else ProcessEngine.for_doctype(doc.doctype)
			task = engine.get_task_row(doc, row.name)
			if _active(doc) and enabled(engine, doc, task) and (
				row.ausfuehrungsstatus == RUNNING or task.ausfuehrung_ungeklaert or _ready(engine, doc, task)
			):
				_enqueue(row.parenttype, row.parent, row.name)
		except (frappe.DoesNotExistError, frappe.ValidationError):
			continue


def _load(doctype, name, row_name, *, lock=False):
	from .engine import ProcessEngine

	doc = frappe.get_doc(doctype, name, for_update=lock)
	engine = ProcessEngine.for_instance(doc) if doctype == linked_create.INSTANCE else ProcessEngine.for_doctype(doctype)
	row = engine.get_task_row(doc, row_name)
	return engine, doc, row


def _update(row, **values):
	row.update(values)
	frappe.db.set_value(row.doctype, row.name, values, update_modified=False)


def _execution_key(doc, row):
	return sha256(f"{doc.doctype}\0{doc.name}\0{row.step_key}\0{row.ausfuehrung_generation or 0}".encode()).hexdigest()


def _claim(engine, doc, row):
	if not _active(doc) or engine.is_temporal_backend(doc) or not enabled(engine, doc, row) or not _eligible(row):
		return False
	recover = row.ausfuehrungsstatus == RUNNING or bool(row.ausfuehrung_ungeklaert)
	if not recover and not _ready(engine, doc, row):
		return False
	handler = engine._get_task_handler(row)
	input_value = row.ausfuehrung_input
	if input_value is None and not recover:
		input_value = handler.automatic_input(engine.config.task_handler_context, doc, row)
	_update(
		row, ausfuehrungsstatus=RUNNING, ausfuehrung_am=now_datetime(),
		ausfuehrung_ablauf=add_to_date(now_datetime(), seconds=LEASE_SECONDS),
		ausfuehrung_faellig=None, ausfuehrung_key=row.ausfuehrung_key or _execution_key(doc, row),
		ausfuehrung_versuche=(row.ausfuehrung_versuche or 0) + 1,
		ausfuehrung_ungeklaert=int(recover), ausfuehrung_token=uuid4().hex, ausfuehrung_input=input_value,
	)
	return True


def _expired_without_retry(engine, row):
	if row.ausfuehrungsstatus != RUNNING or not _due(row.ausfuehrung_ablauf):
		return False
	if (row.ausfuehrung_versuche or 0) < MAX_ATTEMPTS:
		return False
	# The last external attempt may have succeeded before the worker died.
	# Permit one final reconciliation, fenced by the existing recovery flag.
	return row.ausfuehrung_ungeklaert or not engine._get_task_handler(row).external_automatic_effect


def execute(doctype, name, row_name):
	try:
		engine, doc, row = _load(doctype, name, row_name, lock=True)
	except frappe.DoesNotExistError:
		return
	if _active(doc) and enabled(engine, doc, row) and _expired_without_retry(engine, row):
		_set_failure(engine, doc, row, _("Der Worker hat die Ausführung nicht abgeschlossen."),
			uncertain=engine._get_task_handler(row).external_automatic_effect)
		frappe.db.commit()
		return
	if not _claim(engine, doc, row):
		frappe.db.rollback()
		return
	token = row.ausfuehrung_token
	frappe.db.commit()
	worker = frappe.session.user
	external_effect_completed = False
	try:
		frappe.set_user(row.ausfuehrung_actor or worker)
		doc.check_permission("write")
		handler = engine._get_task_handler(row)
		ctx = engine.config.task_handler_context
		with linked_create.request_transaction():
			data = handler.execute_automatic(ctx, doc, row, row.ausfuehrung_key, bool(row.ausfuehrung_ungeklaert))
			external_effect_completed = handler.external_automatic_effect
			engine, doc, row = _load(doctype, name, row_name, lock=True)
			if row.ausfuehrungsstatus != RUNNING or row.ausfuehrung_token != token:
				frappe.db.rollback()
				return
			doc.flags.automatic_execution = True
			row.ausfuehrungsstatus = DONE
			row.ausfuehrung_am = now_datetime()
			row.ausfuehrungsfehler = None
			row.ausfuehrung_ablauf = None
			row.ausfuehrung_ungeklaert = 0
			row.ausfuehrung_token = None
			row.status = DONE
			row.erfuellt = 1
			row.erfuellt_am = now_datetime()
			row.erfuellt_von = frappe.session.user
			handler.persist_automatic(ctx, doc, row, data)
			doc.save(ignore_permissions=True)
		frappe.db.commit()
	except Exception as exc:
		frappe.db.rollback()
		frappe.set_user(worker)
		_record_failure(doctype, name, row_name, token, exc, external_effect_completed)
	finally:
		frappe.set_user(worker)


def _record_failure(doctype, name, row_name, token, error, external_effect_completed):
	engine, doc, row = _load(doctype, name, row_name, lock=True)
	if row.ausfuehrungsstatus != RUNNING or row.ausfuehrung_token != token:
		frappe.db.rollback()
		return
	uncertain = isinstance(error, UncertainEffect) or bool(row.ausfuehrung_ungeklaert) or external_effect_completed
	_set_failure(engine, doc, row, str(error)[:1000] or type(error).__name__, uncertain=uncertain)
	frappe.db.commit()


def _set_failure(engine, doc, row, message, *, uncertain):
	attempts = row.ausfuehrung_versuche or 0
	# Inconclusive results can retry reconciliation within the same attempt budget.
	next_attempt = add_to_date(now_datetime(), minutes=5 * 2 ** (attempts - 1)) if attempts < MAX_ATTEMPTS else None
	_update(
		row, ausfuehrungsstatus=FAILED, ausfuehrung_am=now_datetime(), ausfuehrungsfehler=message,
		ausfuehrung_faellig=next_attempt, ausfuehrung_ablauf=None, ausfuehrung_token=None,
		ausfuehrung_ungeklaert=int(uncertain),
		ausfuehrung_input=row.ausfuehrung_input if uncertain else None,
	)
	if next_attempt is None:
		_notify(engine, doc, row)


def _notify(engine, doc, row):
	step = engine.step_definition(doc, row)
	role = step.get("standard_verantwortlich_rolle")
	if not role:
		return
	users = frappe.get_all("Has Role", filters={"role": role, "parenttype": "User"}, pluck="parent", distinct=True)
	for user in frappe.get_all("User", filters={"name": ["in", users], "enabled": 1}, pluck="name") if users else []:
		frappe.get_doc({
			"doctype": "Notification Log", "for_user": user, "type": "Alert",
			"subject": _("Automatische Prozessaufgabe fehlgeschlagen"),
			"document_type": doc.doctype, "document_name": doc.name,
		}).insert(ignore_permissions=True)


def retry(doctype, name, row_name):
	engine, doc, row = _load(doctype, name, row_name, lock=True)
	doc.check_permission("write")
	if not (_active(doc) and enabled(engine, doc, row) and (row.ausfuehrung_ungeklaert or _ready(engine, doc, row))):
		frappe.throw(_("Diese Aufgabe kann derzeit nicht erneut ausgeführt werden."))
	if row.ausfuehrungsstatus == DONE and row.status != DONE:
		_update(
			row, ausfuehrungsstatus=WAITING, ausfuehrung_generation=(row.ausfuehrung_generation or 0) + 1,
			ausfuehrung_key=None, ausfuehrung_input=None, ausfuehrung_versuche=0,
			ausfuehrung_actor=frappe.session.user, ausfuehrung_am=now_datetime(),
		)
	elif row.ausfuehrungsstatus == FAILED:
		_update(row, ausfuehrung_faellig=now_datetime(), ausfuehrung_actor=frappe.session.user, ausfuehrung_versuche=0)
	else:
		frappe.throw(_("Diese Aufgabe ist bereits erledigt oder zur Ausführung vorgesehen."))
	_enqueue(doctype, name, row_name)
	return {"ok": True}


def actions(row):
	if row.ausfuehrungsstatus == DONE and row.status == DONE:
		return [{
			"key": "reopen", "label": _("Wieder öffnen"), "ignore_lock": True,
			"_dispatch": "set_task_status", "_params": {"status": "Offen"},
		}]
	if row.ausfuehrungsstatus == FAILED or row.ausfuehrungsstatus == DONE:
		return [{"key": "retry_automatic", "label": _("Erneut ausführen"), "_dispatch": "retry_automatic", "primary": True}]
	return []
