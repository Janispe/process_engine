from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document

from process_engine.process_engine.processes.engine import get_process_runtime_config
from process_engine.process_engine.processes.task_registry import (
	TASK_TYPE_MANUAL_CHECK,
	dump_task_config,
	extract_task_config,
)


def _ensure_runtime_registered(runtime_doctype: str):
	if get_process_runtime_config(runtime_doctype):
		return
	# Phase 8: Consumer-Apps registrieren ihre Domain-Runtimes via Hook
	# `process_engine_runtimes`. Kein harter Domain-Import mehr in process_engine.
	from process_engine.process_engine.processes import ensure_process_runtimes_registered

	ensure_process_runtimes_registered()


_LOCKED_SCALAR_FIELDS = (
	"version_key",      # autoname-Field, Umbenennung einer aktiven Version waere katastrophal
	"runtime_doctype",  # Re-Targeting auf anderen Doctype = stiller Identitaetswechsel
	"titel",
	"beschreibung",
	"gueltig_ab",
	"gueltig_bis",
)


class ProzessVersion(Document):
	def validate(self) -> None:
		# Active-Lock zuerst: bei aktiven Versionen soll die schreibgeschuetzt-Botschaft
		# Vorrang haben vor anderen Validierungs-Fehlern (z.B. unregistriertem Runtime-
		# Doctype), denn dem User soll die zentrale Aussage "diese Version ist locked"
		# sofort sichtbar werden, statt einer technischen Sekundaer-Fehlermeldung.
		self._enforce_active_immutability()
		self._validate_runtime_doctype()
		self._normalize_rows()
		self._validate_active_uniqueness()
		self._validate_schritt_io()

	def _enforce_active_immutability(self) -> None:
		if self.is_new():
			return
		# Migration-Patches (z.B. move_payload_specs_to_version) muessen
		# Specs nachtraeglich auf aktive Versionen kopieren koennen.
		if getattr(self.flags, "from_migration", False):
			return
		before = self.get_doc_before_save()
		if not before:
			return
		was_active = bool(before.get("is_active"))
		is_active_now = bool(self.is_active)
		diffs = self._compute_content_diffs(before)

		# Fall 1: Aktivierungs-Uebergang (0 -> 1) muss separat von Content-Edits sein
		if not was_active and is_active_now:
			if diffs:
				frappe.throw(
					_(
						"Aktivierung muss separat erfolgen: bitte erst die Aenderungen "
						"[{0}] speichern, dann in einem zweiten Save aktivieren."
					).format(", ".join(diffs))
				)
			return

		# Fall 2: Deaktivierungs-Uebergang (1 -> 0) muss separat von Content-Edits sein.
		# Sonst koennte man eine aktive Version mutieren und gleichzeitig deaktivieren,
		# was die History/Audit-Aussage "diese Form war einmal aktiv" verfaelscht.
		if was_active and not is_active_now:
			if diffs:
				frappe.throw(
					_(
						"Deaktivierung muss separat erfolgen: bitte zuerst diese Aenderungen "
						"rueckgaengig machen [{0}], dann in einem zweiten Save deaktivieren."
					).format(", ".join(diffs))
				)
			return

		# Fall 3: bleibt inaktiv (0 -> 0)
		if not was_active and not is_active_now:
			return

		# Fall 4: bleibt aktiv (1 -> 1) Content-Lock greift
		if not diffs:
			return
		frappe.throw(
			_(
				"Aktive Prozess-Versionen sind schreibgeschuetzt. "
				"Aenderungen an [{0}] sind nur via 'Bearbeiten als neue Version' moeglich."
			).format(", ".join(diffs))
		)

	def _compute_content_diffs(self, before) -> list[str]:
		diffs: list[str] = []
		for field in _LOCKED_SCALAR_FIELDS:
			if (before.get(field) or "") != (self.get(field) or ""):
				diffs.append(field)
		if self._schritte_fingerprint(before) != self._schritte_fingerprint(self):
			diffs.append("schritte")
		if self._kanten_fingerprint(before) != self._kanten_fingerprint(self):
			diffs.append("schritt_kanten")
		if self._field_specs_fingerprint(before) != self._field_specs_fingerprint(self):
			diffs.append("payload_field_specs")
		if self._schritt_io_fingerprint(before) != self._schritt_io_fingerprint(self):
			diffs.append("schritt_io")
		return diffs

	@staticmethod
	def _schritt_io_fingerprint(doc) -> tuple:
		"""Phase 9: schritt_io ist pro Version eingefroren wie schritte/kanten/specs."""
		rows = []
		for r in doc.get("schritt_io") or []:
			rows.append(
				(
					(r.get("step_key") or "").strip(),
					(r.get("kind") or "").strip(),
					(r.get("target") or "").strip(),
				)
			)
		return tuple(sorted(rows))

	@staticmethod
	def _field_specs_fingerprint(doc) -> tuple:
		"""Phase 7: payload_field_specs sind pro Version eingefroren, identisch
		zum schritte/kanten-Lock. Schema-Aenderungen erfordern eine neue Version."""
		rows = []
		for s in doc.get("payload_field_specs") or []:
			rows.append(
				(
					(s.get("fieldname") or "").strip(),
					(s.get("label") or "").strip(),
					(s.get("fieldtype") or "").strip(),
					(s.get("options") or "").strip(),
					int(s.get("reqd") or 0),
					int(s.get("in_list_view") or 0),
					(s.get("description") or "").strip(),
				)
			)
		return tuple(sorted(rows))

	@staticmethod
	def _schritte_fingerprint(doc) -> tuple:
		"""Fingerprint nimmt RAW-Source-Felder, NICHT das von _normalize_rows
		abgeleitete config_json. Begruendung: _enforce_active_immutability laeuft
		VOR _normalize_rows, config_json ist daher im aktuellen Save noch stale.
		Wenn ein neues Source-Feld auf Prozess Schritt ergaenzt wird, muss es hier mit."""
		rows = []
		for s in doc.get("schritte") or []:
			rows.append(
				(
					(s.get("step_key") or "").strip(),
					(s.get("titel") or "").strip(),
					(s.get("task_type") or "").strip(),
					(s.get("handler_key") or "").strip(),
					int(s.get("pflicht") or 0),
					(s.get("sichtbar_fuer_prozess_typ") or "").strip(),
					(s.get("dokument_typ_tag") or "").strip(),
					(s.get("print_format") or "").strip(),
					(s.get("mapping_flag") or "").strip(),
					(s.get("standard_verantwortlich_rolle") or "").strip(),
					int(s.get("default_faelligkeit_tage") or 0),
					int(s.get("reihenfolge") or 0),
					(s.get("konfig_json") or "").strip(),
					(s.get("sichtbar_wenn") or "").strip(),
					(s.get("freigabe_wenn") or "").strip(),
					# Deprecated, aber Engine liest es weiterhin als dual-read Fallback.
					# Solange dual-read aktiv ist, muss es im Fingerprint gesperrt sein.
					(s.get("parent_step_key") or "").strip(),
				)
			)
		return tuple(sorted(rows))

	@staticmethod
	def _kanten_fingerprint(doc) -> tuple:
		rows = []
		for k in doc.get("schritt_kanten") or []:
			rows.append(
				(
					(k.get("step_key") or "").strip(),
					(k.get("depends_on_step_key") or "").strip(),
				)
			)
		return tuple(sorted(rows))

	def _validate_schritt_io(self) -> None:
		"""Phase 9: Reachability + Cycle + Multi-Producer + Variante.

		Wird bei jedem Save geprueft, mit Ausnahme:
		- Migrations-Pfad (flags.from_migration): bestehende v2/v3 werden
		  schrittweise befuellt, vorher noch leer — kein Pflicht-Check.
		- Versionen ohne schritte (z.B. frischer Entwurf): nichts zu pruefen.
		"""
		if getattr(self.flags, "from_migration", False):
			return
		schritte = self.get("schritte") or []
		if not schritte:
			return
		schritt_io = self.get("schritt_io") or []
		# Pflicht: schritt_io MUSS gepflegt sein, sobald Schritte da sind.
		# schritt_kanten-Fallback existiert NUR fuer Versionen, die durch
		# migrate_to_explicit_io noch nicht befuellt wurden (= zur Save-Zeit
		# nie der Fall, da der Patch bevor User-Save laeuft).
		if not schritt_io:
			frappe.throw(
				_(
					"Phase 9: explizite I/O-Deklarationen sind fuer Versionen mit Schritten erforderlich. "
					"Bitte in 'Schritt I/O' pro Schritt mindestens die Inputs/Outputs eintragen."
				)
			)
		spec_keys = {(s.get("fieldname") or "").strip() for s in (self.get("payload_field_specs") or [])}
		step_keys = {(s.get("step_key") or "").strip() for s in schritte if (s.get("step_key") or "").strip()}

		# Phase 9 / Variante-Aware: globale Strukturen sammeln, dann pro Variante validieren.
		payload_inputs_by_step: dict[str, set[str]] = {}
		payload_outputs_by_step: dict[str, set[str]] = {}
		step_inputs_by_step: dict[str, set[str]] = {}
		producer_by_field: dict[str, str] = {}  # multi-producer ist global ein Fehler

		for row in schritt_io:
			sk = (row.get("step_key") or "").strip()
			kind = (row.get("kind") or "").strip()
			target = (row.get("target") or "").strip()
			if not sk or not kind or not target:
				frappe.throw(_("Schritt I/O: step_key, kind und target sind Pflicht."))
			if sk not in step_keys:
				frappe.throw(
					_("Schritt I/O: step_key '{0}' existiert nicht in den Schritten.").format(sk)
				)
			if kind in ("payload_input", "payload_output"):
				if target not in spec_keys:
					frappe.throw(
						_(
							"Schritt I/O ({0}, {1}): target '{2}' ist kein gueltiges payload_field_specs."
						).format(sk, kind, target)
					)
				if kind == "payload_input":
					payload_inputs_by_step.setdefault(sk, set()).add(target)
				else:
					if target in producer_by_field and producer_by_field[target] != sk:
						frappe.throw(
							_(
								"Multi-Producer-Konflikt: Feld '{0}' wird sowohl von '{1}' als auch '{2}' geschrieben."
							).format(target, producer_by_field[target], sk)
						)
					producer_by_field[target] = sk
					payload_outputs_by_step.setdefault(sk, set()).add(target)
			elif kind == "step_input":
				if target not in step_keys:
					frappe.throw(
						_("Schritt I/O ({0}, step_input): target '{1}' ist kein gueltiger step_key.").format(sk, target)
					)
				if target == sk:
					frappe.throw(
						_("Schritt I/O ({0}, step_input): ein Schritt kann nicht sich selbst als Vorgaenger haben.").format(sk)
					)
				step_inputs_by_step.setdefault(sk, set()).add(target)
			else:
				frappe.throw(_("Schritt I/O: kind '{0}' ist ungueltig.").format(kind))

		# Variante-Map: step_key → sichtbar_fuer_prozess_typ
		variant_of_step: dict[str, str] = {}
		for s in schritte:
			key = (s.get("step_key") or "").strip()
			if key:
				variant_of_step[key] = (s.get("sichtbar_fuer_prozess_typ") or "Beide").strip()

		# Pro Variante (Mieterwechsel + Erstvermietung) Reachability + Cycle validieren.
		# "Beide" zaehlt in jeder Variante als sichtbar.
		for variant in ("Mieterwechsel", "Erstvermietung"):
			visible = {sk for sk in step_keys if variant_of_step.get(sk) in (variant, "Beide")}
			# Variante-spezifischer Producer-Map (nur sichtbare Producer zaehlen)
			variant_producer: dict[str, str] = {
				field: producer
				for field, producer in producer_by_field.items()
				if producer in visible
			}
			# Reachability pro Variante: jeder sichtbare Input muss aufloesbar sein
			for sk in visible:
				for field in payload_inputs_by_step.get(sk, set()):
					if field in variant_producer:
						if variant_producer[field] == sk:
							frappe.throw(
								_(
									"Variante '{0}': Schritt '{1}' liest und schreibt dasselbe Feld '{2}'."
								).format(variant, sk, field)
							)
						continue
					if field in producer_by_field and producer_by_field[field] not in visible:
						frappe.throw(
							_(
								"Variante '{0}': Schritt '{1}' liest Feld '{2}', dessen Producer '{3}' in dieser Variante nicht sichtbar ist."
							).format(variant, sk, field, producer_by_field[field])
						)
					# Sonst: Process-Input (kein Task schreibt es) — OK
			# step_inputs muessen ebenfalls auf sichtbare Steps zeigen
			for sk in visible:
				for target_sk in step_inputs_by_step.get(sk, set()):
					if target_sk not in visible:
						frappe.throw(
							_(
								"Variante '{0}': Schritt '{1}' hat step_input '{2}', der in dieser Variante nicht sichtbar ist."
							).format(variant, sk, target_sk)
						)
			# DAG pro Variante aufbauen + Cycle-Check
			deps: dict[str, set[str]] = {sk: set() for sk in visible}
			for sk in visible:
				for field in payload_inputs_by_step.get(sk, set()):
					producer = variant_producer.get(field)
					if producer and producer != sk:
						deps[sk].add(producer)
				for target_sk in step_inputs_by_step.get(sk, set()):
					if target_sk in visible:
						deps[sk].add(target_sk)
			WHITE, GRAY, BLACK = 0, 1, 2
			color = {sk: WHITE for sk in visible}

			def dfs(node: str, stack: list[str]) -> None:
				color[node] = GRAY
				stack.append(node)
				for nxt in deps.get(node, set()):
					if nxt not in color:
						continue
					if color[nxt] == GRAY:
						cycle_idx = stack.index(nxt)
						cycle_path = " → ".join(stack[cycle_idx:] + [nxt])
						frappe.throw(
							_("Variante '{0}': DAG-Zyklus in schritt_io: {1}").format(variant, cycle_path)
						)
					if color[nxt] == WHITE:
						dfs(nxt, stack)
				stack.pop()
				color[node] = BLACK

			for sk in visible:
				if color.get(sk) == WHITE:
					dfs(sk, [])

		# Handler-Konsistenz: create_linked_doc.konfig.store_in_payload_field
		# und python_action mit set_flag-Handler.konfig.target_field muessen
		# als payload_output des Schritts deklariert sein. Global (nicht variant-spezifisch).
		self._validate_handler_output_consistency(payload_outputs_by_step)

	def _validate_handler_output_consistency(self, payload_outputs_by_step: dict[str, set[str]]) -> None:
		import json as _json

		for schritt in (self.get("schritte") or []):
			sk = (schritt.get("step_key") or "").strip()
			if not sk:
				continue
			task_type = (schritt.get("task_type") or "").strip()
			handler_key = (schritt.get("handler_key") or "").strip()
			raw = (schritt.get("konfig_json") or "").strip()
			if not raw:
				continue
			try:
				cfg = _json.loads(raw)
			except (ValueError, TypeError):
				continue
			if not isinstance(cfg, dict):
				continue
			outputs = payload_outputs_by_step.get(sk, set())

			if task_type == "create_linked_doc":
				field = (cfg.get("store_in_payload_field") or "").strip()
				if field and field not in outputs:
					frappe.throw(
						_(
							"Schritt '{0}' (create_linked_doc): konfig.store_in_payload_field='{1}' muss als payload_output deklariert sein."
						).format(sk, field)
					)
			elif task_type == "python_action" and handler_key.endswith("set_flag"):
				field = (cfg.get("target_field") or "").strip()
				if field and field not in outputs:
					frappe.throw(
						_(
							"Schritt '{0}' (python_action set_flag): konfig.target_field='{1}' muss als payload_output deklariert sein."
						).format(sk, field)
					)

	def _validate_runtime_doctype(self):
		runtime_doctype = (self.runtime_doctype or "").strip()
		if not runtime_doctype:
			frappe.throw(_("Runtime Doctype ist erforderlich."))
		_ensure_runtime_registered(runtime_doctype)
		if not get_process_runtime_config(runtime_doctype):
			frappe.throw(_("Kein Process Runtime fuer Doctype registriert: {0}").format(runtime_doctype))

	def _get_runtime_config(self):
		runtime_doctype = (self.runtime_doctype or "").strip()
		_ensure_runtime_registered(runtime_doctype)
		config = get_process_runtime_config(runtime_doctype)
		if not config:
			frappe.throw(_("Kein Process Runtime fuer Doctype registriert: {0}").format(runtime_doctype))
		return config

	def _normalize_rows(self) -> None:
		import graphlib

		runtime_config = self._get_runtime_config()
		seen_keys: set[str] = set()
		for idx, row in enumerate(self.get("schritte") or [], start=1):
			if not row.reihenfolge:
				row.reihenfolge = idx
			if not (row.step_key or "").strip():
				row.step_key = f"step_{idx:02d}"
			if not (row.task_type or "").strip():
				row.task_type = TASK_TYPE_MANUAL_CHECK
			row.config_json = dump_task_config(extract_task_config(row))
			row.konfig_json = row.config_json
			step_key = (row.step_key or "").strip()
			if step_key in seen_keys:
				frappe.throw(_("Step Key ist doppelt: {0}").format(step_key))
			seen_keys.add(step_key)
		for row in self.get("schritte") or []:
			parent_step_key = (row.parent_step_key or "").strip()
			if parent_step_key and parent_step_key not in seen_keys:
				frappe.throw(_("Parent Step Key existiert nicht: {0}").format(parent_step_key))
			handler = runtime_config.task_handler_registry.get_handler(
				handler_key=(row.handler_key or "").strip(),
				task_type=row.task_type,
				context=runtime_config.task_handler_context,
			)
			handler.validate_config(row)

		# Edge-Validierung (DAG-Kanten in schritt_kanten)
		seen_edges: set[tuple[str, str]] = set()
		for edge in self.get("schritt_kanten") or []:
			sk = (edge.step_key or "").strip()
			dep = (edge.depends_on_step_key or "").strip()
			if not sk or not dep:
				frappe.throw(_("Kante braucht step_key UND depends_on_step_key."))
			if sk not in seen_keys:
				frappe.throw(_("Kante referenziert unbekannten Schritt: {0}").format(sk))
			if dep not in seen_keys:
				frappe.throw(_("Kante referenziert unbekannten Vorgaenger-Schritt: {0}").format(dep))
			if sk == dep:
				frappe.throw(_("Schritt kann nicht von sich selbst abhaengen: {0}").format(sk))
			edge_key = (sk, dep)
			if edge_key in seen_edges:
				frappe.throw(_("Doppelte Kante: {0} haengt mehrfach von {1} ab.").format(sk, dep))
			seen_edges.add(edge_key)

		# Cycle-Detection ueber kombinierten Edge-Set (neue Kanten + legacy parent_step_key)
		edges_combined: dict[str, list[str]] = {}
		for edge in self.get("schritt_kanten") or []:
			sk = (edge.step_key or "").strip()
			dep = (edge.depends_on_step_key or "").strip()
			if sk and dep:
				edges_combined.setdefault(sk, []).append(dep)
		for row in self.get("schritte") or []:
			sk = (row.step_key or "").strip()
			legacy = (row.parent_step_key or "").strip()
			if sk and legacy and legacy not in edges_combined.get(sk, []):
				edges_combined.setdefault(sk, []).append(legacy)
		ts = graphlib.TopologicalSorter()
		for sk in seen_keys:
			ts.add(sk, *edges_combined.get(sk, []))
		try:
			ts.prepare()
		except graphlib.CycleError as e:
			cycle_path = " -> ".join(e.args[1]) if len(e.args) > 1 else str(e)
			frappe.throw(_("Zyklus in Schritt-Abhaengigkeiten: {0}").format(cycle_path))

		if self.get("schritte"):
			self.set("schritte", sorted(self.get("schritte"), key=lambda r: int(r.reihenfolge or 0)))

	def _validate_active_uniqueness(self) -> None:
		if not self.is_active:
			return
		filters = {
			"name": ("!=", self.name or ""),
			"is_active": 1,
			"runtime_doctype": (self.runtime_doctype or "").strip(),
		}
		if frappe.db.exists("Prozess Version", filters):
			frappe.throw(
				_("Es darf nur eine aktive Prozessversion fuer {0} geben.").format(self.runtime_doctype)
			)


@frappe.whitelist()
def duplicate_version(name: str, new_version_key: str | None = None, new_titel: str | None = None) -> str:
	src = frappe.get_doc("Prozess Version", name)
	src.check_permission("read")
	new_doc = frappe.copy_doc(src)
	new_doc.is_active = 0
	new_doc.gueltig_ab = None
	new_doc.gueltig_bis = None
	new_doc.version_key = (new_version_key or "").strip() or f"{src.version_key}-copy"
	new_doc.titel = (new_titel or "").strip() or f"{src.titel} (Kopie)"
	new_doc.insert(ignore_permissions=False)
	return new_doc.name


@frappe.whitelist()
def get_activation_preview(name: str) -> dict:
	doc = frappe.get_doc("Prozess Version", name)
	doc.check_permission("read")
	currently_active = frappe.get_all(
		"Prozess Version",
		filters={
			"is_active": 1,
			"runtime_doctype": (doc.runtime_doctype or "").strip(),
			"name": ("!=", doc.name),
		},
		fields=["name", "titel", "version_key"],
		limit=1,
	)
	return {
		"version_name": doc.name,
		"version_titel": doc.titel,
		"version_key": doc.version_key,
		"schritt_count": len(doc.schritte or []),
		"kanten_count": len(doc.schritt_kanten or []),
		"runtime_doctype": doc.runtime_doctype,
		"currently_active": currently_active[0] if currently_active else None,
	}


@frappe.whitelist()
def activate_version(name: str) -> str:
	doc = frappe.get_doc("Prozess Version", name)
	doc.check_permission("write")
	others = frappe.get_all(
		"Prozess Version",
		filters={
			"is_active": 1,
			"runtime_doctype": (doc.runtime_doctype or "").strip(),
			"name": ("!=", doc.name),
		},
		pluck="name",
	)
	for nm in others:
		frappe.db.set_value("Prozess Version", nm, "is_active", 0, update_modified=False)
	if not doc.is_active:
		doc.db_set("is_active", 1, update_modified=False)
	return doc.name
