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


def _ensure_runtime_registered(runtime_doctype: str, prozess_typ: str | None = None):
	if get_process_runtime_config(runtime_doctype):
		return
	# Phase 8: Consumer-Apps registrieren ihre Domain-Runtimes via Hook
	# `process_engine_runtimes`. Kein harter Domain-Import mehr in process_engine.
	from process_engine.process_engine.processes import (
		ensure_process_runtimes_registered,
		get_runtime_config_for_typ,
		register_process_runtime,
	)

	ensure_process_runtimes_registered()
	if get_process_runtime_config(runtime_doctype):
		return
	# Phase 10: Die generische, datengetriebene Runtime (z.B. "Prozess Instanz") wird pro
	# prozess_typ gebaut und ist NICHT ueber den Hook registriert (Instanz-Operationen
	# nutzen ProcessEngine.for_instance ohne Registry). Damit eine Prozess Version aber
	# ueber die Desk-UI gespeichert werden kann, registrieren wir die Runtime hier aus dem
	# prozess_typ der Version — gleiches Muster wie die Migrations-Patches.
	typ = (prozess_typ or "").strip()
	if typ:
		cfg = get_runtime_config_for_typ(typ)
		if cfg:
			register_process_runtime(cfg)


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
		self._sync_declared_outputs()
		self._validate_active_uniqueness()
		self._validate_schritt_io()

	def on_trash(self) -> None:
		# Phase 10: Laufzeit-Aufgaben lesen ihre Config live aus der referenzierten
		# Prozess Version (kein Snapshot mehr). Eine Version, die von mindestens einer
		# Prozess Instanz referenziert wird, darf daher nicht geloescht werden — sonst
		# verloeren laufende/abgeschlossene Instanzen ihre Config-Quelle.
		# ANNAHME (wie in _resolve_runtime_task_config): nur der generische Runtime-Doctype
		# "Prozess Instanz" wird geprueft — aktuell der einzige. Ein kuenftiger Consumer-
		# Runtime mit eigenem Doctype braeuchte hier eine eigene Referenz-Pruefung.
		count = frappe.db.count("Prozess Instanz", {"prozess_version": self.name})
		if count:
			frappe.throw(
				_(
					"Diese Prozess Version wird von {0} Prozess Instanz(en) referenziert "
					"und kann nicht geloescht werden. Erst die Instanzen entfernen."
				).format(count)
			)

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
		# Phase 10: dauerhafter Content-Lock ab erster Aktivierung. wurde_aktiviert
		# wird nie zurueckgesetzt — eine einmal aktivierte Version bleibt eingefroren,
		# auch nachdem sie wieder deaktiviert wurde.
		was_ever_active = bool(before.get("wurde_aktiviert"))
		# Monotonie erzwingen: wurde_aktiviert darf nie 1 -> 0 zurueck. Das Feld ist nur
		# UI-readonly; ein API-/Script-Save koennte es sonst (ohne Content-Diff) auf 0
		# setzen und eine ehemals aktive Version wieder editierbar machen. Re-asserten.
		if was_ever_active and not self.wurde_aktiviert:
			self.wurde_aktiviert = 1
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
			# Lifecycle-Flag im normalen Save-Flow setzen (kein db_set in validate).
			# Der direkte DB-Pfad activate_version sichert das zusaetzlich ab.
			self.wurde_aktiviert = 1
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

		# Ab hier: kein is_active-Uebergang (0->0 oder 1->1).
		# Content-Lock greift dauerhaft, sobald die Version jemals aktiviert war
		# (was_ever_active) ODER aktuell aktiv ist. Ein nie aktiviert gewesener
		# Entwurf bleibt frei editierbar.
		if not (was_ever_active or is_active_now):
			return
		if not diffs:
			return
		frappe.throw(
			_(
				"Aktivierte Prozess-Versionen sind dauerhaft schreibgeschuetzt. "
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
		"""Fingerprint nimmt RAW-Source-Felder. konfig_json ist seit Phase 10 die
		einzige Config-Quelle auf der Vorlage (config_json wurde entfernt); es wird
		von _normalize_rows normalisiert, der Fingerprint laeuft aber VOR der
		Normalisierung und vergleicht damit konsistent gespeicherten vs. neuen Wert.
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

		# Variante-Map: step_key → sichtbar_fuer_prozess_typ (App-spezifischer Freetext)
		variant_of_step: dict[str, str] = {}
		for s in schritte:
			key = (s.get("step_key") or "").strip()
			if key:
				variant_of_step[key] = (s.get("sichtbar_fuer_prozess_typ") or "Beide").strip()

		# Phase 9: Varianten dynamisch aus den vorkommenden Werten ableiten —
		# kein Hardcoding mehr von Mieterwechsel/Erstvermietung in der generischen Engine.
		# "Beide" ist der spezielle Universal-Marker und wird selbst NICHT als Variante
		# behandelt — er kennzeichnet nur "in jeder Variante sichtbar".
		distinct_variants = {
			v for v in variant_of_step.values() if v and v != "Beide"
		}
		# Wenn nur "Beide"-Schritte existieren (keine echte Variante): einmaliger
		# Durchlauf mit Pseudo-Variante "__default__" wo alle Schritte sichtbar sind.
		if not distinct_variants:
			distinct_variants = {"__default__"}

		for variant in sorted(distinct_variants):
			if variant == "__default__":
				visible = set(step_keys)
			else:
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
		_ensure_runtime_registered(runtime_doctype, self.get("prozess_typ"))
		if not get_process_runtime_config(runtime_doctype):
			frappe.throw(_("Kein Process Runtime fuer Doctype registriert: {0}").format(runtime_doctype))

	def _get_runtime_config(self):
		runtime_doctype = (self.runtime_doctype or "").strip()
		_ensure_runtime_registered(runtime_doctype, self.get("prozess_typ"))
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
			# Phase 10: konfig_json ist die einzige Config-Quelle auf der Vorlage
			# (config_json wurde entfernt). extract_task_config liest jetzt konfig_json.
			row.konfig_json = dump_task_config(extract_task_config(row))
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
			# Versions-Kontext fuer Handler-Validierungen mitgeben (z.B. derive prueft, dass
			# source_field ein Link-Spec mit passendem Ziel-Doctype ist). Best-effort: Handler,
			# die es nicht brauchen, ignorieren das Flag.
			row.flags.version_payload_specs = self.get("payload_field_specs") or []
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

	def _sync_declared_outputs(self) -> None:
		"""Outputs sind typ-getrieben: jeder Schritt-Handler deklariert via declared_outputs(config),
		welche Payload-Felder er produziert. Daraus werden payload_field_specs (Name+Typ,
		auto_output=1) UND payload_output-I/O automatisch angelegt/aktualisiert; veraltete werden
		entfernt. Der Nutzer deklariert nur Start-Inputs (manuell, auto_output=0).
		"""
		# Gesperrte (aktive/aktivierte) Versionen sind eingefroren — nicht anfassen; ihr
		# Output-Stand wurde als Entwurf synchronisiert. Beim ERSTEN Insert (is_new) trotzdem
		# syncen, falls eine Version direkt aktiv angelegt wird (z.B. Bootstrap).
		if not self.is_new() and (self.get("is_active") or self.get("wurde_aktiviert")):
			return
		runtime_config = self._get_runtime_config()

		# 1. Deklarierte Outputs je Schritt einsammeln.
		declared_all: dict[str, dict] = {}
		declared_by_step: dict[str, set[str]] = {}
		for row in self.get("schritte") or []:
			sk = (row.step_key or "").strip()
			if not sk:
				continue
			handler = runtime_config.task_handler_registry.get_handler(
				handler_key=(row.handler_key or "").strip(),
				task_type=row.task_type,
				context=runtime_config.task_handler_context,
			)
			names: set[str] = set()
			for out in (handler.declared_outputs(extract_task_config(row)) or []):
				fn = (out.get("fieldname") or "").strip()
				if not fn:
					continue
				names.add(fn)
				declared_all[fn] = out
			declared_by_step[sk] = names

		# 2. payload_output-I/O syncen: veraltete entfernen, fehlende anlegen.
		existing_out: set[tuple[str, str]] = set()
		kept_io = []
		for r in (self.get("schritt_io") or []):
			if (r.kind or "").strip() == "payload_output":
				sk = (r.step_key or "").strip()
				tgt = (r.target or "").strip()
				if tgt not in declared_by_step.get(sk, set()):
					continue  # veraltet
				existing_out.add((sk, tgt))
			kept_io.append(r)
		self.set("schritt_io", kept_io)
		for sk, names in declared_by_step.items():
			for fn in names:
				if (sk, fn) not in existing_out:
					self.append("schritt_io", {"step_key": sk, "kind": "payload_output", "target": fn})

		# 3. Output-Specs (auto_output=1) anlegen/aktualisieren — Handler ist die Wahrheit.
		spec_by_name = {(s.fieldname or "").strip(): s for s in (self.get("payload_field_specs") or [])}
		for fn, out in declared_all.items():
			spec = spec_by_name.get(fn)
			if spec is None:
				spec = self.append("payload_field_specs", {"fieldname": fn, "label": fn})
				spec_by_name[fn] = spec
			spec.fieldtype = (out.get("fieldtype") or "Data").strip() or "Data"
			spec.options = (out.get("options") or "").strip()
			spec.auto_output = 1
			if not (spec.label or "").strip():
				spec.label = fn

		# 4. Veraltete auto_output-Specs: entfernen, wenn nicht (mehr) konsumiert; sonst zu
		#    Start-Input degradieren (auto_output=0), damit ein Konsument sie extern bekommt.
		consumed = {
			(r.target or "").strip()
			for r in (self.get("schritt_io") or [])
			if (r.kind or "").strip() == "payload_input"
		}
		kept_specs = []
		for s in (self.get("payload_field_specs") or []):
			fn = (s.fieldname or "").strip()
			if int(s.get("auto_output") or 0) == 1 and fn not in declared_all:
				if fn in consumed:
					s.auto_output = 0
					kept_specs.append(s)
				# sonst: verwaistes Auto-Output -> droppen
			else:
				kept_specs.append(s)
		self.set("payload_field_specs", kept_specs)

	def _validate_active_uniqueness(self) -> None:
		if not self.is_active:
			return
		filters = _active_version_scope_filters(self)
		filters["name"] = ("!=", self.name or "")
		if frappe.db.exists("Prozess Version", filters):
			scope = self.runtime_doctype
			if filters.get("prozess_typ"):
				scope = _("{0} / Prozess Typ {1}").format(self.runtime_doctype, filters["prozess_typ"])
			frappe.throw(
				_("Es darf nur eine aktive Prozessversion fuer {0} geben.").format(scope)
			)


def _active_version_scope_filters(doc) -> dict:
	filters = {
		"is_active": 1,
		"runtime_doctype": (doc.get("runtime_doctype") or "").strip(),
	}
	# Prozess Instanz ist ein generischer Runtime-Doctype; die Engine waehlt aktive
	# Versionen zusaetzlich pro Prozess Typ aus (process_typ_filter).
	if filters["runtime_doctype"] == "Prozess Instanz":
		prozess_typ = (doc.get("prozess_typ") or "").strip()
		if prozess_typ:
			filters["prozess_typ"] = prozess_typ
	return filters


@frappe.whitelist()
def duplicate_version(name: str, new_version_key: str | None = None, new_titel: str | None = None) -> str:
	src = frappe.get_doc("Prozess Version", name)
	src.check_permission("read")
	new_doc = frappe.copy_doc(src)
	new_doc.is_active = 0
	# Lifecycle-Flag MUSS zuruecksetzen — sonst erbt die Kopie einer jemals aktiven
	# Version den dauerhaften Content-Lock und "Bearbeiten als neue Version" liefert
	# eine sofort gesperrte (uneditierbare) Kopie. (Feld ist zusaetzlich no_copy.)
	new_doc.wurde_aktiviert = 0
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
	filters = _active_version_scope_filters(doc)
	filters["name"] = ("!=", doc.name)
	currently_active = frappe.get_all(
		"Prozess Version",
		filters=filters,
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
		"prozess_typ": filters.get("prozess_typ"),
		"currently_active": currently_active[0] if currently_active else None,
	}


@frappe.whitelist()
def activate_version(name: str) -> str:
	doc = frappe.get_doc("Prozess Version", name)
	doc.check_permission("write")
	filters = _active_version_scope_filters(doc)
	filters["name"] = ("!=", doc.name)
	others = frappe.get_all(
		"Prozess Version",
		filters=filters,
		pluck="name",
	)
	for nm in others:
		frappe.db.set_value("Prozess Version", nm, "is_active", 0, update_modified=False)
	if not doc.is_active:
		doc.db_set("is_active", 1, update_modified=False)
	# Lifecycle-Flag dauerhaft setzen (dieser direkte DB-Pfad umgeht validate).
	if not doc.wurde_aktiviert:
		doc.db_set("wurde_aktiviert", 1, update_modified=False)
	return doc.name


@frappe.whitelist()
def get_task_config_schema(prozess_typ: str | None = None, task_type: str | None = None, handler_key: str | None = None):
	"""Phase 13: liefert das Config-Schema eines Aufgabentyps (Handler-Selbstbeschreibung)
	fuer den Editor. Handler-bezogen (kein persistierter Step noetig — der Editor arbeitet
	auf frm.doc). prozess_typ optional, um Consumer-/Custom-Handler aufzuloesen; sonst
	Default-Registry (Built-in-Handler)."""
	from process_engine.process_engine.processes.task_registry import TaskHandlerRegistry

	tt = (task_type or "").strip()
	hk = (handler_key or "").strip()
	typ = (prozess_typ or "").strip()
	handler = None
	if typ:
		from process_engine.process_engine.processes.engine import get_runtime_config_for_typ

		cfg = get_runtime_config_for_typ(typ)
		if cfg:
			handler = cfg.task_handler_registry.get_handler(
				handler_key=hk, task_type=tt, context=cfg.task_handler_context
			)
	if handler is None:
		handler = TaskHandlerRegistry().get_handler(handler_key=hk, task_type=tt)
	return handler.config_schema()
