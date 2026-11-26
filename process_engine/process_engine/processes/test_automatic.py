import json
from unittest.mock import patch
from uuid import uuid4

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from . import automatic
from .engine import ProcessEngine, ProcessPluginRegistry
from .task_registry import PaperlessExportTaskHandler, PythonActionTaskHandler
from .triggers import build_trigger_payload, get_triggers_for_source


class TestAutomaticProcessSteps(FrappeTestCase):
	def setUp(self):
		super().setUp()
		identifier = uuid4().hex[:8]
		self.typ = frappe.get_doc({
			"doctype": "Prozess Typ", "name1": f"auto-{identifier}", "label": "Automatik", "is_active": 1,
			"default_process_type": "Beide",
		}).insert()
		self.version = None
		self.instance = None
		self.added_role = None
		self.created_todos = []
		# Queue callbacks are recorded locally. execute still uses real commits and locks.
		self.jobs = []
		self.enqueue = patch.object(frappe, "enqueue", side_effect=self.capture_job)
		self.enqueue.start()
		self.addCleanup(self.enqueue.stop)
		self.addCleanup(self.clean_data)

	def capture_job(self, method, **kwargs):
		if method == automatic.JOB:
			self.assertTrue(kwargs["enqueue_after_commit"])
			frappe.db.after_commit.add(lambda: self.jobs.append((kwargs["doctype"], kwargs["name"], kwargs["row_name"])))

	def clean_data(self):
		frappe.db.rollback()
		if self.instance:
			frappe.db.delete("Notification Log", {"document_name": self.instance.name})
			frappe.db.delete("Prozess E-Mail Entwurf", {"prozess_instanz": self.instance.name})
			frappe.db.delete("Prozess Aufgabe Datei", {"prozess_name": self.instance.name})
			frappe.db.delete("Prozess Aufgabe", {"parent": self.instance.name})
			frappe.db.delete("ToDo", {"reference_name": self.instance.name, "reference_type": self.instance.doctype})
			frappe.db.delete("Prozess Instanz", {"name": self.instance.name})
		if self.version:
			for field in self.version.meta.get_table_fields():
				frappe.db.delete(field.options, {"parent": self.version.name})
			frappe.db.delete("Prozess Version", {"name": self.version.name})
		for name in self.created_todos:
			frappe.db.delete("ToDo", {"name": name})
		for df in self.typ.meta.get_table_fields():
			frappe.db.delete(df.options, {"parent": self.typ.name})
		frappe.db.delete("Prozess Typ", {"name": self.typ.name})
		if self.added_role:
			frappe.db.delete("Has Role", {"name": self.added_role})
		frappe.db.commit()

	def make_version(self, error=None, *, role=None, task_type="paperless_export", config=None, handler_key=None):
		steps = [
			{"step_key": "derive", "titel": "Datei ableiten", "task_type": "derive",
			 "konfig_json": json.dumps({"source_field": "source_user", "input_doctype": "User",
				"derivations": [{"path": "first_name", "field": "derived_name"}]})},
			{"step_key": "export", "titel": "Export", "task_type": task_type, "automatisch": 1,
			 "standard_verantwortlich_rolle": role,
			 "konfig_json": json.dumps({"dokument_typ_tag": "Test", "file_url_field": "attachment"}),
			 "freigabe_wenn": error or '{"all":[{"field":"payload.derived_name","op":"is_not_empty"}]}'},
			{"step_key": "manual", "titel": "Prüfen", "task_type": "manual_check", "pflicht": 1},
			{"step_key": "hidden", "titel": "Überspringen", "task_type": "manual_check", "pflicht": 1,
			 "sichtbar_wenn": '{"all":[{"field":"payload.missing","op":"is_not_empty"}]}'},
		]
		specs = [
			{"fieldname": "source_user", "label": "Quelle", "fieldtype": "Link", "options": "User"},
			{"fieldname": "attachment", "label": "Datei", "fieldtype": "Data"},
		]
		io = [
			{"step_key": "export", "kind": "payload_input", "target": "derived_name"},
			{"step_key": "manual", "kind": "step_input", "target": "export"},
		]
		if config:
			steps[1]["konfig_json"] = json.dumps(config)
		if handler_key:
			steps[1]["handler_key"] = handler_key
		if task_type == "email_draft":
			steps[1]["konfig_json"] = json.dumps({
				"recipient_field": "recipient", "subject": "Testentwurf", "body": "Entwurf ohne Versand",
			})
			specs.append({"fieldname": "recipient", "label": "Empfänger", "fieldtype": "Data"})
		self.version = frappe.get_doc({
			"doctype": "Prozess Version", "version_key": f"v1-{self.typ.name}", "titel": "Automatik",
			"prozess_typ": self.typ.name, "runtime_doctype": "Prozess Instanz", "is_active": 1,
			"schritte": steps, "payload_field_specs": specs, "schritt_io": io,
		}).insert()
		return self.version

	def make_instance(self, **version_options):
		self.make_version(**version_options)
		self.instance = frappe.get_doc({
			"doctype": "Prozess Instanz", "prozess_typ": self.typ.name, "orchestrator_backend": "local",
			"payload_json": json.dumps({"source_user": "Administrator", "attachment": "/private/files/test.pdf", "recipient": "test@example.org"}),
		}).insert()
		return self.instance

	def task(self, key="export"):
		return next(row for row in self.instance.reload().aufgaben if row.step_key == key)

	def run_export(self):
		automatic.execute(self.instance.doctype, self.instance.name, self.task().name)

	def test_commit_chain_lost_job_and_reopen(self):
		with patch.object(PaperlessExportTaskHandler, "_request_export", return_value={"link": "https://paperless.example/documents/1"}) as export:
			instance = self.make_instance()
			self.assertEqual(self.jobs, [])
			export.assert_not_called()
			frappe.db.commit()
			self.assertEqual(len(self.jobs), 1)
			self.jobs.clear()  # Redis lost the job before any worker could claim it.
			automatic.sweep()
			frappe.db.commit()
			self.assertEqual(len(self.jobs), 1)
			automatic.execute(*self.jobs[0])
			automatic.execute(*self.jobs[0])
			instance.reload().save()
			frappe.db.commit()
			automatic.sweep()
			frappe.db.commit()
			self.assertEqual(export.call_count, 1)
			first_key = self.task().ausfuehrung_key
			self.assertEqual(self.task().status, "Erledigt")
			manual = self.task("manual")
			engine = ProcessEngine.for_instance(instance)
			self.assertEqual(manual.status, "Offen")
			self.assertTrue(engine._is_task_unlocked(instance, manual))
			self.assertFalse(engine._task_visible(instance, self.task("hidden")))
			self.assertFalse(any("Überspringen" in blocker for blocker in engine.validate_completion(instance, raise_exception=False).blockers))
			row = self.task()
			row.status = "Offen"
			instance.save()
			frappe.db.commit()
			self.run_export()
			self.assertEqual(self.task().ausfuehrungsstatus, automatic.DONE)
			self.assertEqual(self.task().status, "Offen")
			self.assertEqual(export.call_count, 1)
			automatic.retry(instance.doctype, instance.name, row.name)
			frappe.db.commit()
			self.run_export()
			self.assertEqual(export.call_count, 2)
			self.assertNotEqual(self.task().ausfuehrung_key, first_key)

	def test_automatic_save_does_not_run_legacy_manual_exports(self):
		instance = self.make_instance()
		frappe.db.set_value(instance.doctype, instance.name, "status", "Abschlusspruefung")
		frappe.db.commit()
		with (
			patch.object(PaperlessExportTaskHandler, "_request_export", return_value={"link": "https://paperless.example/documents/3"}),
			patch.object(ProcessEngine, "trigger_paperless_export_for_files") as manual_exports,
		):
			self.run_export()
			self.assertEqual(self.task().ausfuehrungsstatus, automatic.DONE)
			manual_exports.assert_not_called()

	def test_error_backoff_notification_and_manual_retry(self):
		with (
			patch.object(PaperlessExportTaskHandler, "_request_export", side_effect=ValueError("Testfehler")) as export,
			patch.object(automatic, "_notify", wraps=automatic._notify) as notify,
		):
			instance = self.make_instance(role="System Manager")
			recipients = set(frappe.get_all("Has Role", filters={"role": "System Manager", "parenttype": "User"}, pluck="parent"))
			if not recipients:
				# Administrator receives every role implicitly on a fresh Frappe site.
				role = frappe.get_doc({"doctype": "Has Role", "parent": "Administrator", "parenttype": "User",
					"parentfield": "roles", "role": "System Manager"})
				role.db_insert()
				self.added_role = role.name
				recipients = {"Administrator"}
			frappe.db.commit()
			recipients = {user for user in recipients if frappe.db.get_value("User", user, "enabled")}
			self.assertTrue(recipients)
			for attempt in range(1, 4):
				self.run_export()
				row = self.task()
				self.assertEqual(row.ausfuehrungsstatus, automatic.FAILED)
				self.assertFalse(row.erfuellt)
				self.assertEqual(row.status, "Offen")
				self.assertEqual(row.ausfuehrungsfehler, "Testfehler")
				self.assertEqual(row.ausfuehrung_versuche, attempt)
				if attempt < 3:
					self.assertTrue(row.ausfuehrung_faellig)
					notify.assert_not_called()
					frappe.db.set_value(row.doctype, row.name, "ausfuehrung_faellig", now_datetime())
					frappe.db.commit()
			notify.assert_called_once()
			self.assertEqual(set(frappe.get_all("Notification Log", filters={
				"document_name": instance.name, "document_type": instance.doctype,
			}, pluck="for_user")), recipients)
			self.assertFalse(row.ausfuehrung_faellig)
			key = row.ausfuehrung_key
			export.side_effect = None
			export.return_value = {"link": "https://paperless.example/documents/2"}
			automatic.retry(instance.doctype, instance.name, row.name)
			frappe.db.commit()
			self.run_export()
			self.assertEqual(self.task().ausfuehrungsstatus, automatic.DONE)
			self.assertEqual(self.task().ausfuehrung_key, key)

	def test_email_draft_is_saved_without_sending(self):
		instance = self.make_instance(task_type="email_draft")
		frappe.db.commit()
		with patch.object(frappe, "sendmail") as send:
			self.run_export()
			self.run_export()
			send.assert_not_called()
		draft = frappe.get_doc("Prozess E-Mail Entwurf", json.loads(self.task().result_json)["draft"])
		self.assertEqual(draft.prozess_instanz, instance.name)
		self.assertEqual(draft.recipient, "test@example.org")
		self.assertEqual(draft.subject, "Testentwurf")
		self.assertEqual(frappe.db.count(draft.doctype, {"prozess_instanz": instance.name}), 1)

	def test_expired_claim_reconciles_without_replaying(self):
		with patch.object(PaperlessExportTaskHandler, "_request_export", side_effect=automatic.UncertainEffect("Offen")) as export:
			instance = self.make_instance()
			frappe.db.commit()
			engine, doc, row = automatic._load(instance.doctype, instance.name, self.task().name, lock=True)
			self.assertTrue(automatic._claim(engine, doc, row))
			frappe.db.set_value(row.doctype, row.name, "ausfuehrung_ablauf", add_to_date(now_datetime(), minutes=-1))
			frappe.db.commit()
			self.jobs.clear()
			automatic.sweep()
			frappe.db.commit()
			self.assertEqual(len(self.jobs), 1)
			automatic.execute(*self.jobs[0])
			self.assertTrue(export.call_args.kwargs["reconcile_only"])
			self.assertEqual(export.call_args.kwargs["execution_key"], row.ausfuehrung_key)
			self.assertEqual(self.task().ausfuehrungsstatus, automatic.FAILED)

	def test_linked_creation_uses_the_checked_result_path(self):
		description = f"Automatic ToDo {self.typ.name}"
		instance = self.make_instance(task_type="create_linked_doc", config={
			"target_doctype": "ToDo", "store_in_payload_field": "linked_result",
			"prefill_mapping": {"description": description},
		})
		frappe.db.commit()
		self.run_export()
		self.run_export()
		self.created_todos = frappe.get_all("ToDo", filters={"description": description}, pluck="name")
		row = self.task()
		self.assertEqual(row.ausfuehrungsstatus, automatic.DONE, row.ausfuehrungsfehler)
		self.assertEqual(self.created_todos, [instance.payload("linked_result")])
		self.assertEqual(json.loads(row.result_json), {"created": self.created_todos[0]})

	def test_registered_python_action_publishes_outputs_once(self):
		calls = []

		class Handler(PythonActionTaskHandler):
			supports_background_execution = True

			def execute_automatic(self, context, doc, row, execution_key, reconcile):
				calls.append((execution_key, reconcile))
				return {"outputs": {"python_result": "erzeugt"}, "result": {"ok": True}}

		with patch.dict(ProcessPluginRegistry._custom_handlers, {"test_auto_python": Handler()}):
			self.typ.append("custom_task_handlers", {"plugin_key": "test_auto_python"})
			self.typ.save()
			instance = self.make_instance(task_type="python_action", handler_key="test_auto_python", config={
				"outputs": [{"fieldname": "python_result", "fieldtype": "Data"}],
			})
			frappe.db.commit()
			self.assertEqual(calls, [])
			self.run_export()
			self.run_export()
			row = self.task()
			self.assertEqual(row.ausfuehrungsstatus, automatic.DONE, row.ausfuehrungsfehler)
			self.assertEqual(calls, [(row.ausfuehrung_key, False)])
			self.assertEqual(instance.payload("python_result"), "erzeugt")

	def test_rejects_automatic_ai_proposal(self):
		with self.assertRaisesRegex(frappe.ValidationError, "KI-Vorschläge und automatische Ausführung"):
			self.make_version(task_type="create_linked_doc", config={
				"target_doctype": "ToDo", "store_in_payload_field": "ai_result", "allow_ai_proposals": True,
			})

	def test_rejects_invalid_version_and_trigger_conditions(self):
		with self.assertRaisesRegex(frappe.ValidationError, "freigabe_wenn"):
			self.make_version(error="{")
		self.typ.append("triggers", {
			"key": "test", "source_doctype": "ToDo", "button_label": "Start", "visibility_when": "{",
		})
		with self.assertRaisesRegex(frappe.ValidationError, "visibility_when"):
			self.typ.save()

	def test_confirmed_remote_failure_allows_new_upload_attempt_with_same_execution_key(self):
		instance = self.make_instance()
		frappe.db.commit()
		with patch.object(PaperlessExportTaskHandler, "_request_export", side_effect=[
			automatic.UncertainEffect("Unklar"),
			automatic.ConfirmedEffectFailure("Abgebrochen"),
			{"link": "https://paperless.example/documents/4"},
		]) as export:
			self.run_export()
			first = self.task()
			self.assertTrue(first.ausfuehrung_ungeklaert)
			automatic.retry(instance.doctype, instance.name, first.name)
			frappe.db.commit()
			self.run_export()
			second = self.task()
			self.assertFalse(second.ausfuehrung_ungeklaert)
			automatic.retry(instance.doctype, instance.name, second.name)
			frappe.db.commit()
			self.run_export()
			self.assertEqual(self.task().ausfuehrungsstatus, automatic.DONE)
			calls = [call.kwargs for call in export.call_args_list]
		self.assertEqual({call["execution_key"] for call in calls}, {first.ausfuehrung_key})
		self.assertEqual(calls[0]["attempt_key"], calls[1]["attempt_key"])
		self.assertNotEqual(calls[1]["attempt_key"], calls[2]["attempt_key"])
		self.assertEqual([call["reconcile_only"] for call in calls], [False, True, False])

	def test_expired_final_reconciliation_stops_at_attempt_limit(self):
		instance = self.make_instance()
		frappe.db.commit()
		row = self.task()
		frappe.db.set_value(row.doctype, row.name, {
			"ausfuehrungsstatus": automatic.RUNNING,
			"ausfuehrung_ungeklaert": 1,
			"ausfuehrung_ablauf": add_to_date(now_datetime(), minutes=-1),
			"ausfuehrung_versuche": automatic.MAX_ATTEMPTS,
		})
		frappe.db.commit()
		with patch.object(PaperlessExportTaskHandler, "_request_export") as export:
			automatic.execute(instance.doctype, instance.name, row.name)
			export.assert_not_called()
		row = self.task()
		self.assertEqual(row.ausfuehrungsstatus, automatic.FAILED)
		self.assertFalse(row.ausfuehrung_faellig)
		self.assertTrue(row.ausfuehrung_ungeklaert)

	def test_database_trigger_checks_source_and_mapped_payload(self):
		key = self.typ.name
		self.typ.append("triggers", {
			"key": key, "source_doctype": "User", "button_label": "Start",
			"input_mapping_json": json.dumps({"enabled": {"kind": "fixed", "value": True}}),
			"visibility_when": json.dumps({"all": [
				{"field": "doc.name", "op": "==", "value": "Administrator"},
				{"field": "payload.enabled", "op": "==", "value": True},
			]}),
		})
		self.typ.save()
		trigger_id = f"User::{key}"
		self.assertIn(trigger_id, {trigger["trigger_id"] for trigger in get_triggers_for_source("User", "Administrator")})
		self.assertTrue(build_trigger_payload(trigger_id, "Administrator")["enabled"])
		self.assertNotIn(trigger_id, {trigger["trigger_id"] for trigger in get_triggers_for_source("User", "Guest")})
		with self.assertRaises(frappe.PermissionError):
			build_trigger_payload(trigger_id, "Guest")

	def test_automatic_steps_are_rejected_on_temporal(self):
		self.make_version()
		with self.assertRaisesRegex(frappe.ValidationError, "Temporal"):
			frappe.get_doc({
				"doctype": "Prozess Instanz", "prozess_typ": self.typ.name, "orchestrator_backend": "temporal",
			}).insert()
