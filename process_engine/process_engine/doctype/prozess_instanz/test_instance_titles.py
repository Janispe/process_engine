"""Context titles distinguish processes without changing accounting references."""

from __future__ import annotations

import json
import unittest
import uuid
from contextlib import ExitStack, contextmanager
from copy import deepcopy
from unittest.mock import patch

import frappe

from process_engine.process_engine.doctype.prozess_instanz.prozess_instanz import ProzessInstanz
from process_engine.process_engine.patches.post_model_sync import backfill_process_instance_titles
from process_engine.process_engine.processes.instance_titles import build_instance_title


class TestInstanceTitles(unittest.TestCase):
	def _values(self, **changes):
		values = {
			"doctype": "Prozess Instanz",
			"name": "PI-2026-0023",
			"prozess_typ": "mieterwechsel",
			"label_cached": "Mieterwechsel",
			"quelle_doctype": "Wohnung",
			"quelle_name": "WHG-00042",
			"payload_json": "{}",
		}
		values.update(changes)
		return frappe._dict(values)

	def test_normal_insert_and_save_persist_title_with_allocated_instance_id(self):
		key = "_title_test_" + uuid.uuid4().hex[:8]
		frappe.db.savepoint(key)
		try:
			with patch.object(frappe.db, "commit", side_effect=AssertionError("test must not commit")):
				typ = frappe.get_doc(
					{
						"doctype": "Prozess Typ",
						"name1": key,
						"label": "Titeltest",
						"is_active": 1,
						"default_process_type": "Beide",
					}
				).insert(ignore_permissions=True)
				frappe.get_doc(
					{
						"doctype": "Prozess Version",
						"version_key": "v1-" + key,
						"titel": "Titeltest v1",
						"prozess_typ": typ.name,
						"runtime_doctype": "Prozess Instanz",
						"is_active": 1,
						"payload_field_specs": [
							{"fieldname": "wohnung", "label": "Wohnung", "fieldtype": "Data"}
						],
						"schritte": [
							{
								"step_key": "check",
								"titel": "Prüfung",
								"pflicht": 1,
								"task_type": "manual_check",
								"sichtbar_fuer_prozess_typ": "Beide",
								"reihenfolge": 10,
							}
						],
						"schritt_io": [{"step_key": "check", "kind": "payload_input", "target": "wohnung"}],
					}
				).insert(ignore_permissions=True)
				instances = [
					frappe.get_doc(
						{
							"doctype": "Prozess Instanz",
							"prozess_typ": typ.name,
							"payload_json": json.dumps({"wohnung": "WHG-00042"}),
						}
					).insert(ignore_permissions=True)
					for _ in range(2)
				]
				self.assertNotEqual(instances[0].bezeichnung, instances[1].bezeichnung)
				for instance in instances:
					self.assertEqual(instance.label_cached, "Titeltest")
					self.assertEqual(instance.bezeichnung, f"Titeltest · Wohnung WHG-00042 · {instance.name}")
					self.assertEqual(
						frappe.db.get_value("Prozess Instanz", instance.name, "bezeichnung"),
						instance.bezeichnung,
					)
				instance = instances[0]
				original_name = instance.name
				instance.payload_json = json.dumps({"wohnung": "WHG-00043"})
				instance.save(ignore_permissions=True)
				instance.reload()
				self.assertEqual(instance.name, original_name)
				self.assertEqual(instance.label_cached, "Titeltest")
				self.assertEqual(instance.bezeichnung, f"Titeltest · Wohnung WHG-00043 · {original_name}")
		finally:
			frappe.db.rollback(save_point=key)

	def test_same_process_type_and_context_still_has_distinct_document_titles(self):
		first = frappe.get_doc(self._values())
		second = frappe.get_doc(self._values(name="PI-2026-0024"))
		self.assertIsInstance(first, ProzessInstanz)
		self.assertIsInstance(second, ProzessInstanz)

		# These are real, unsaved Frappe documents. The builder must need no lookup.
		with (
			patch.object(frappe, "db") as database,
			patch.object(
				frappe, "get_doc", side_effect=AssertionError("title builder loaded another document")
			),
		):
			first_title = build_instance_title(first)
			second_title = build_instance_title(second)
			database.assert_not_called()
			self.assertEqual(database.mock_calls, [])

		self.assertNotEqual(first_title, second_title)
		for doc, title in ((first, first_title), (second, second_title)):
			self.assertIn("Mieterwechsel", title)
			self.assertIn("Wohnung", title)
			self.assertIn("WHG-00042", title)
			self.assertTrue(title.endswith(doc.name), title)
			self.assertEqual(doc.label_cached, "Mieterwechsel")

	def test_complete_source_pair_takes_precedence_over_payload_context(self):
		doc = self._values(payload_json=json.dumps({"wohnung": "WHG-OTHER"}))
		title = build_instance_title(doc)
		self.assertIn("Wohnung", title)
		self.assertIn("WHG-00042", title)
		self.assertNotIn("WHG-OTHER", title)
		self.assertTrue(title.endswith(doc.name))

	def test_missing_or_partial_source_uses_string_payload_apartment(self):
		for source in (
			{"quelle_doctype": None, "quelle_name": None},
			{"quelle_doctype": "Wohnung", "quelle_name": None},
			{"quelle_doctype": None, "quelle_name": "UNPAIRED-SOURCE"},
		):
			with self.subTest(source=source):
				doc = self._values(**source, payload_json=json.dumps({"wohnung": "WHG-00043"}))
				title = build_instance_title(doc)
				self.assertIn("WHG-00043", title)
				self.assertNotIn("UNPAIRED-SOURCE", title)
				self.assertTrue(title.endswith(doc.name))

	def test_invalid_or_non_string_payload_context_does_not_become_a_title(self):
		for payload in (
			None,
			"",
			"{broken",
			"[]",
			"null",
			"17",
			json.dumps("WHG-NOT-AN-OBJECT"),
			json.dumps({"wohnung": None}),
			json.dumps({"wohnung": 42}),
			json.dumps({"wohnung": ["WHG-NOT-A-STRING"]}),
			json.dumps({"wohnung": {"name": "WHG-NOT-A-STRING"}}),
		):
			with self.subTest(payload=payload):
				doc = self._values(quelle_doctype=None, quelle_name=None, payload_json=payload)
				self.assertEqual(build_instance_title(doc), f"Mieterwechsel · {doc.name}")

	def test_missing_label_falls_back_to_process_key_then_generic_label(self):
		for label, process_type, expected_label in (
			(None, "mieterwechsel", "mieterwechsel"),
			("", "mieterwechsel", "mieterwechsel"),
			(None, None, "Prozess"),
		):
			with self.subTest(label=label, process_type=process_type):
				doc = self._values(
					label_cached=label,
					prozess_typ=process_type,
					quelle_doctype=None,
					quelle_name=None,
				)
				self.assertEqual(build_instance_title(doc), f"{expected_label} · {doc.name}")

	def test_long_title_keeps_full_instance_id_within_data_field_limit(self):
		for label, source_type, source_name in (
			("Mieterwechsel", "Wohnung", "Wohnung-" + "ä" * 200),
			("Ü" * 200, "Wohnung", "WHG-00042"),
			("Mieterwechsel", "Quelltyp-" + "ß" * 200, "WHG-00042"),
		):
			with self.subTest(label_length=len(label), source_type_length=len(source_type)):
				doc = self._values(
					name="PI-2026-1234567890",
					label_cached=label,
					quelle_doctype=source_type,
					quelle_name=source_name,
				)
				title = build_instance_title(doc)
				self.assertLessEqual(len(title), 140)
				self.assertTrue(title.endswith(doc.name), title)
				self.assertEqual(title.count(doc.name), 1)

	def test_title_lifecycle_hooks_change_only_title_and_do_not_run_engine_or_save(self):
		for lifecycle in ("before_save", "before_submit", "before_update_after_submit"):
			with self.subTest(lifecycle=lifecycle):
				doc = frappe.get_doc(
					self._values(
						bezeichnung="Old display title",
						modified="2026-10-01 10:00:00",
						creation="2026-09-01 09:00:00",
						status="Aktiv",
						docstatus=1 if lifecycle == "before_update_after_submit" else 0,
					)
				)
				before = deepcopy(doc.as_dict())
				with ExitStack() as stack:
					for method in ("save", "run_method", "_engine"):
						stack.enter_context(
							patch.object(doc, method, side_effect=AssertionError(f"unexpected {method}"))
						)
					engine = stack.enter_context(
						patch("process_engine.process_engine.processes.engine.ProcessEngine")
					)
					database = stack.enter_context(patch.object(frappe, "db"))
					getattr(doc, lifecycle)()
					self.assertEqual(engine.mock_calls, [])
					self.assertEqual(database.mock_calls, [])
				self.assertEqual(doc.bezeichnung, build_instance_title(doc))
				after = doc.as_dict()
				before.pop("bezeichnung", None)
				after.pop("bezeichnung", None)
				self.assertEqual(after, before)

	def test_backfill_repetition_does_not_write_or_change_identity_references_and_timestamps(self):
		rows = [
			self._values(
				bezeichnung=None,
				creation="2026-09-01 09:00:00",
				modified="2026-10-01 10:00:00",
				status="Aktiv",
				docstatus=0,
				prozess_version="mieterwechsel-v1",
			),
			self._values(
				name="PI-2026-0024",
				bezeichnung="Old display title",
				creation="2026-09-02 09:00:00",
				modified="2026-10-02 10:00:00",
				status="Abgeschlossen",
				docstatus=1,
				prozess_version="mieterwechsel-v1",
			),
		]
		before = deepcopy(rows)

		def get_all(doctype, **kwargs):
			if doctype == "Property Setter":
				return []
			self.assertEqual(doctype, "Prozess Instanz")
			self.assertEqual(
				set(kwargs["fields"]),
				{
					"name",
					"prozess_typ",
					"label_cached",
					"quelle_doctype",
					"quelle_name",
					"payload_json",
					"bezeichnung",
				},
			)
			return deepcopy(rows)

		def set_value(doctype, name, field, value, **kwargs):
			self.assertEqual(doctype, "Prozess Instanz")
			self.assertEqual(field, "bezeichnung")
			self.assertEqual(kwargs, {"update_modified": False})
			row = next(row for row in rows if row.name == name)
			row.bezeichnung = value

		with self._mock_patch_io(get_all, set_value) as mocks:
			backfill_process_instance_titles.execute()
			self.assertEqual(mocks["set_value"].call_count, 2)
			for row in rows:
				self.assertIn("WHG-00042", row.bezeichnung)
				self.assertTrue(row.bezeichnung.endswith(row.name))
			mocks["set_value"].reset_mock()
			backfill_process_instance_titles.execute()
			mocks["set_value"].assert_not_called()
			self.assertEqual(mocks["reload_doc"].call_count, 2)

		for original, migrated in zip(before, rows):
			original.pop("bezeichnung", None)
			migrated_without_title = dict(migrated)
			migrated_without_title.pop("bezeichnung", None)
			self.assertEqual(original, migrated_without_title)

	def test_backfill_aligns_existing_display_overrides_without_deleting_them(self):
		rows = [
			frappe._dict(name="PS-title", property="title_field", value="label_cached", property_type="Data"),
			frappe._dict(
				name="PS-links", property="show_title_field_in_link", value="0", property_type="Check"
			),
			frappe._dict(
				name="PS-search", property="search_fields", value="label_cached", property_type="Data"
			),
		]
		original_names = [row.name for row in rows]

		def get_all(doctype, **kwargs):
			if doctype == "Prozess Instanz":
				return []
			self.assertEqual(doctype, "Property Setter")
			self.assertEqual(kwargs["filters"]["doc_type"], "Prozess Instanz")
			self.assertEqual(kwargs["filters"]["doctype_or_field"], "DocType")
			self.assertEqual(
				set(kwargs["filters"]["property"][1]),
				{"title_field", "show_title_field_in_link", "search_fields"},
			)
			return deepcopy(rows)

		def set_value(doctype, name, values, **kwargs):
			self.assertEqual(doctype, "Property Setter")
			self.assertEqual(set(values), {"value", "property_type"})
			self.assertEqual(kwargs, {"update_modified": False})
			next(row for row in rows if row.name == name).update(values)

		with self._mock_patch_io(get_all, set_value) as mocks:
			backfill_process_instance_titles.execute()
			mocks["reload_doc"].assert_called_once_with(
				"process_engine", "doctype", "prozess_instanz", force=True
			)
			mocks["clear_cache"].assert_called_once_with(doctype="Prozess Instanz")
			mocks["set_value"].reset_mock()
			backfill_process_instance_titles.execute()
			mocks["set_value"].assert_not_called()

		self.assertEqual([row.name for row in rows], original_names)
		by_property = {row.property: row for row in rows}
		self.assertEqual(by_property["title_field"].value, "bezeichnung")
		self.assertEqual(by_property["show_title_field_in_link"].value, "1")
		self.assertIn("bezeichnung", by_property["search_fields"].value.split(","))

	@contextmanager
	def _mock_patch_io(self, get_all, set_value):
		"""Exercise the actual patch and display helper with strictly bounded writes."""
		with ExitStack() as stack:
			mocks = {}
			for attribute in ("reload_doc", "clear_cache"):
				mocks[attribute] = stack.enter_context(patch.object(frappe, attribute))
			stack.enter_context(patch.object(frappe, "get_all", side_effect=get_all))
			mocks["set_value"] = stack.enter_context(
				patch.object(frappe.db, "set_value", side_effect=set_value)
			)
			for attribute in ("get_doc", "get_cached_doc", "delete_doc"):
				stack.enter_context(
					patch.object(
						frappe, attribute, side_effect=AssertionError(f"patch must not call {attribute}")
					)
				)
			for attribute in ("get_value", "sql", "commit"):
				stack.enter_context(
					patch.object(
						frappe.db,
						attribute,
						side_effect=AssertionError(f"patch must not call db.{attribute}"),
					)
				)
			stack.enter_context(
				patch(
					"frappe.model.document.Document.save", side_effect=AssertionError("patch must not save")
				)
			)
			stack.enter_context(
				patch(
					"frappe.model.document.Document.run_method",
					side_effect=AssertionError("patch must not run hooks"),
				)
			)
			yield mocks
