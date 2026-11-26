import json
from unittest.mock import patch
from uuid import uuid4

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from . import automatic
from .engine import ProcessEngine
from .task_registry import PaperlessExportTaskHandler


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
			frappe.db.delete("Prozess Aufgabe Datei", {"prozess_name": self.instance.name})
			frappe.db.delete("Prozess Aufgabe", {"parent": self.instance.name})
			frappe.db.delete("Prozess Instanz", {"name": self.instance.name})
		if self.version:
			for field in self.version.meta.get_table_fields():
				frappe.db.delete(field.options, {"parent": self.version.name})
			frappe.db.delete("Prozess Version", {"name": self.version.name})
		frappe.db.delete("Prozess Typ", {"name": self.typ.name})
		frappe.db.commit()

	def make_version(self, error=None):
		step = "paperless_export"
		steps = [
			{"step_key": "derive", "titel": "Datei ableiten", "task_type": "derive",
			 "konfig_json": json.dumps({"source_field": "source_user", "input_doctype": "User",
				"derivations": [{"path": "first_name", "field": "derived_name"}]})},
			{"step_key": "export", "titel": "Export", "task_type": step, "automatisch": 1,
			 "konfig_json": json.dumps({"dokument_typ_tag": "Test", "file_url_field": "attachment"}),
			 "freigabe_wenn": error or '{"all":[{"field":"payload.derived_name","op":"is_not_empty"}]}'},
			{"step_key": "manual", "titel": "Prüfen", "task_type": "manual_check", "pflicht": 1},
			{"step_key": "hidden", "titel": "Überspringen", "task_type": "manual_check", "pflicht": 1,
			 "sichtbar_wenn": '{"all":[{"field":"payload.missing","op":"is_not_empty"}]}'},
		]
		specs = [
			{"fieldname": "source_user", "label": "Quelle", "fieldtype": "Link", "link_doctype": "User"},
			{"fieldname": "attachment", "label": "Datei", "fieldtype": "Data"},
		]
		io = [
			{"step_key": "export", "kind": "payload_input", "target": "derived_name"},
			{"step_key": "manual", "kind": "step_input", "target": "export"},
		]
		self.version = frappe.get_doc({
			"doctype": "Prozess Version", "version_key": f"v1-{self.typ.name}", "titel": "Automatik",
			"prozess_typ": self.typ.name, "runtime_doctype": "Prozess Instanz", "is_active": 1,
			"schritte": steps, "payload_field_specs": specs, "schritt_io": io,
		}).insert()
		return self.version

	def make_instance(self):
		self.make_version()
		self.instance = frappe.get_doc({
			"doctype": "Prozess Instanz", "prozess_typ": self.typ.name, "orchestrator_backend": "local",
			"payload_json": json.dumps({"source_user": "Administrator", "attachment": "/private/files/test.pdf"}),
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

	def test_error_backoff_notification_and_manual_retry(self):
		with (
			patch.object(PaperlessExportTaskHandler, "_request_export", side_effect=ValueError("Testfehler")) as export,
			patch.object(automatic, "_notify") as notify,
		):
			instance = self.make_instance()
			frappe.db.commit()
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
			self.assertFalse(row.ausfuehrung_faellig)
			key = row.ausfuehrung_key
			export.side_effect = None
			export.return_value = {"link": "https://paperless.example/documents/2"}
			automatic.retry(instance.doctype, instance.name, row.name)
			frappe.db.commit()
			self.run_export()
			self.assertEqual(self.task().ausfuehrungsstatus, automatic.DONE)
			self.assertEqual(self.task().ausfuehrung_key, key)

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

	def test_rejects_invalid_version_and_trigger_conditions(self):
		with self.assertRaisesRegex(frappe.ValidationError, "freigabe_wenn"):
			self.make_version(error="{")
		self.typ.append("triggers", {
			"key": "test", "source_doctype": "ToDo", "button_label": "Start", "visibility_when": "{",
		})
		with self.assertRaisesRegex(frappe.ValidationError, "visibility_when"):
			self.typ.save()
