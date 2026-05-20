frappe.ui.form.on("Prozess Version", {
	refresh(frm) {
		if (frm.is_new()) {
			return;
		}

		// Must match _LOCKED_SCALAR_FIELDS in prozess_version.py (+ Child-Tables).
		// payload_field_specs ist seit Phase 7 ein Pro-Version-Schema und
		// ebenfalls gelockt — siehe _field_specs_fingerprint.
		const locked_fields = [
			"version_key",
			"runtime_doctype",
			"titel",
			"beschreibung",
			"gueltig_ab",
			"gueltig_bis",
			"payload_field_specs",
			"schritte",
			"schritt_io",
			"schritt_kanten",
		];

		// Phase 10: dauerhafter Content-Lock ab erster Aktivierung — Editierbarkeit
		// haengt am gemeinsamen Praedikat _is_version_locked, nicht mehr nur an is_active.
		const is_locked = _is_version_locked(frm);
		for (const fname of locked_fields) {
			frm.set_df_property(fname, "read_only", is_locked ? 1 : 0);
		}

		// Editor-only: die Child-Grids werden komplett ueber den visuellen Editor
		// verwaltet (Schritte/I/O via Canvas+Inspector, Payload-Felder via "Felder"-Panel).
		// Daten + Save bleiben unveraendert (hidden-Felder werden weiter persistiert).
		for (const f of [
			"payload_field_specs",
			"schritte",
			"schritt_io",
			"section_payload_specs",
			"section_schritt_io",
		]) {
			frm.set_df_property(f, "hidden", 1);
		}

		if (is_locked) {
			frm.dashboard.clear_headline();
			frm.dashboard.set_headline(
				frm.doc.is_active
					? __("Aktive Version — schreibgeschuetzt. Aenderungen erfordern eine neue Version.")
					: __("Bereits aktiviert gewesen — dauerhaft schreibgeschuetzt. Aenderungen erfordern eine neue Version."),
				"orange"
			);
			frm.add_custom_button(__("Bearbeiten als neue Version"), () => {
				_open_duplicate_dialog(frm);
			}).addClass("btn-primary");
		}
		// "Aktivieren" auch fuer eine eingefrorene, aber gerade inaktive Version
		// anbieten (Rollback auf eine alte Version).
		if (!frm.doc.is_active) {
			frm.add_custom_button(__("Aktivieren"), () => _open_activation_dialog(frm));
		}

		frm.add_custom_button(__("Version duplizieren"), () => _open_duplicate_dialog(frm));

		_render_dag_preview(frm);
		_render_visual_editor(frm);
	},

	before_save(frm) {
		const errors = _validate_dag_locally(frm);
		if (errors.length) {
			frappe.validated = false;
			frappe.msgprint({
				title: __("DAG-Validierung fehlgeschlagen"),
				message: errors.map((e) => `<li>${frappe.utils.escape_html(e)}</li>`).join(""),
				indicator: "red",
				as_list: true,
			});
		}
	},
});

// Phase 9+: DAG wird aus schritt_io abgeleitet. schritt_kanten ist deprecated (hidden).
// Add/Remove sind Parent-Form-Events (Frappe-Konvention), Field-Changes sind Child-Events.
frappe.ui.form.on("Prozess Version", {
	schritte_add: (frm) => _render_dag_preview(frm),
	schritte_remove: (frm) => _render_dag_preview(frm),
	schritt_io_add: (frm) => _render_dag_preview(frm),
	schritt_io_remove: (frm) => _render_dag_preview(frm),
});

frappe.ui.form.on("Prozess Schritt", {
	titel: (frm) => _render_dag_preview(frm),
	step_key: (frm) => _render_dag_preview(frm),
});

frappe.ui.form.on("Prozess Schritt IO", {
	step_key: (frm) => _render_dag_preview(frm),
	kind: (frm) => _render_dag_preview(frm),
	target: (frm) => _render_dag_preview(frm),
});

function _is_version_locked(frm) {
	// Phase 10: dauerhafter Content-Lock — aktiv ODER jemals aktiviert gewesen.
	// Spiegelt das Server-Praedikat in _enforce_active_immutability.
	return !!(frm.doc.is_active || frm.doc.wurde_aktiviert);
}

function _open_duplicate_dialog(frm) {
	frappe.prompt(
		[
			{
				fieldname: "new_version_key",
				fieldtype: "Data",
				label: __("Neuer Version Key"),
				reqd: 1,
				default: (frm.doc.version_key || "") + "-v2",
			},
			{
				fieldname: "new_titel",
				fieldtype: "Data",
				label: __("Neuer Titel"),
				reqd: 1,
				default: frm.doc.titel,
			},
		],
		(values) => {
			frappe.call({
				method: "process_engine.process_engine.doctype.prozess_version.prozess_version.duplicate_version",
				args: {
					name: frm.doc.name,
					new_version_key: values.new_version_key,
					new_titel: values.new_titel,
				},
			}).then((r) => {
				if (r.message) frappe.set_route("Form", "Prozess Version", r.message);
			});
		},
		__("Version duplizieren"),
		__("Anlegen und oeffnen")
	);
}

function _open_activation_dialog(frm) {
	frappe.call({
		method: "process_engine.process_engine.doctype.prozess_version.prozess_version.get_activation_preview",
		args: { name: frm.doc.name },
	}).then((r) => {
		const p = r.message || {};
		// Scope-Label: bei generischem Runtime-Doctype (Prozess Instanz) zusaetzlich den
		// prozess_typ nennen — sonst suggeriert "keine Version aktiv" faelschlich, dass
		// gar keine aktiv ist, obwohl ein ANDERER Prozess Typ eine aktive Version haben kann.
		const scope = p.prozess_typ
			? `${frappe.utils.escape_html(p.runtime_doctype || "")} / ${__("Prozess Typ")} ${frappe.utils.escape_html(p.prozess_typ)}`
			: frappe.utils.escape_html(p.runtime_doctype || "");
		const replaces = p.currently_active
			? `<p>${__("Ersetzt aktuell aktive Version:")} <b>${frappe.utils.escape_html(p.currently_active.titel)}</b> (<code>${frappe.utils.escape_html(p.currently_active.version_key)}</code>)</p>`
			: `<p>${__("Aktuell ist keine Version fuer")} <b>${scope}</b> ${__("aktiv.")}</p>`;
		const html = `
			<h4>${frappe.utils.escape_html(p.version_titel || "")} <small class="text-muted">${frappe.utils.escape_html(p.version_key || "")}</small></h4>
			<p>${__("Schritte:")} <b>${p.schritt_count || 0}</b>, ${__("Abhaengigkeiten:")} <b>${p.kanten_count || 0}</b></p>
			${replaces}
			<p class="text-muted"><i>${__("Bestehende")} ${frappe.utils.escape_html(p.runtime_doctype || "")}${__("-Instanzen behalten ihre gespeicherte Prozess-Version und sind nicht betroffen.")}</i></p>
		`;
		frappe.confirm(html, () => {
			frappe.call({
				method: "process_engine.process_engine.doctype.prozess_version.prozess_version.activate_version",
				args: { name: frm.doc.name },
				freeze: true,
			}).then(() => frm.reload_doc());
		});
	});
}

function _derive_deps_from_io(schritte, schritt_io) {
	// Phase 9: DAG wird aus schritt_io abgeleitet (payload_input → Producer, step_input → target).
	const step_keys = new Set(schritte.map((s) => (s.step_key || "").trim()).filter(Boolean));
	const producer_by_field = {};
	for (const r of schritt_io) {
		if ((r.kind || "") === "payload_output") {
			const t = (r.target || "").trim();
			if (t) producer_by_field[t] = (r.step_key || "").trim();
		}
	}
	const deps_set_by_step = {};
	for (const sk of step_keys) deps_set_by_step[sk] = new Set();
	for (const r of schritt_io) {
		const sk = (r.step_key || "").trim();
		if (!step_keys.has(sk)) continue;
		const kind = (r.kind || "").trim();
		const target = (r.target || "").trim();
		if (kind === "payload_input") {
			const producer = producer_by_field[target];
			if (producer && producer !== sk && step_keys.has(producer)) {
				deps_set_by_step[sk].add(producer);
			}
		} else if (kind === "step_input") {
			if (target && target !== sk && step_keys.has(target)) {
				deps_set_by_step[sk].add(target);
			}
		}
	}
	const deps_by_step = {};
	for (const [sk, set] of Object.entries(deps_set_by_step)) {
		deps_by_step[sk] = Array.from(set);
	}
	return { step_keys, deps_by_step, producer_by_field };
}

function _validate_dag_locally(frm) {
	const schritte = frm.doc.schritte || [];
	const schritt_io = frm.doc.schritt_io || [];
	const { step_keys, deps_by_step, producer_by_field } = _derive_deps_from_io(schritte, schritt_io);
	const errors = [];

	// step_input: Self-Loop + unbekannter Target
	for (const r of schritt_io) {
		const sk = (r.step_key || "").trim();
		const kind = (r.kind || "").trim();
		const target = (r.target || "").trim();
		if (!sk) continue;
		if (kind === "step_input") {
			if (sk === target) errors.push(__("Schritt kann nicht von sich selbst abhaengen: {0}", [sk]));
			if (target && !step_keys.has(target)) {
				errors.push(__("step_input referenziert unbekannten Schritt: {0} → {1}", [sk, target]));
			}
		}
		if (kind === "payload_input" && target) {
			// payload_input ohne Producer ist erlaubt — es ist ein Process Input
			// (extern via payload_field_specs bereitgestellt). Phase 9 erlaubt das
			// bewusst; serverseitig prueft validate_schritt_io das Detail.
			const producer = producer_by_field[target];
			if (producer && producer === sk) {
				errors.push(__("Schritt {0} liest seinen eigenen payload_output '{1}'.", [sk, target]));
			}
		}
	}

	// Cycle detection via DFS with coloring
	const adj = {};
	for (const sk of step_keys) adj[sk] = (deps_by_step[sk] || []).slice();
	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = {};
	for (const sk of step_keys) color[sk] = WHITE;
	let cycle_path = null;
	function dfs(node, path) {
		if (color[node] === GRAY) {
			cycle_path = path.slice(path.indexOf(node)).concat(node);
			return true;
		}
		if (color[node] === BLACK) return false;
		color[node] = GRAY;
		for (const nxt of adj[node] || []) {
			if (dfs(nxt, path.concat(node))) return true;
		}
		color[node] = BLACK;
		return false;
	}
	for (const sk of step_keys) {
		if (color[sk] === WHITE && dfs(sk, [])) {
			errors.push(__("Zyklus in Schritt-Abhaengigkeiten: {0}", [cycle_path.join(" -> ")]));
			break;
		}
	}

	return errors;
}

function _render_dag_preview(frm) {
	const field = frm.get_field("dag_preview_html");
	if (!field) return;
	const schritte = frm.doc.schritte || [];
	const schritt_io = frm.doc.schritt_io || [];
	if (!schritte.length) {
		field.$wrapper.html(`<p class="text-muted">${__("Noch keine Schritte definiert.")}</p>`);
		return;
	}
	const { deps_by_step } = _derive_deps_from_io(schritte, schritt_io);
	const errors = _validate_dag_locally(frm);
	const errors_html = errors.length
		? `<div class="alert alert-danger"><b>${__("Probleme:")}</b><ul>${errors
				.map((e) => `<li>${frappe.utils.escape_html(e)}</li>`)
				.join("")}</ul></div>`
		: "";
	const rows = schritte
		.map((s) => {
			const sk = (s.step_key || "").trim();
			const titel = frappe.utils.escape_html(s.titel || sk);
			const deps = deps_by_step[sk] || [];
			const deps_html = deps.length
				? deps.map((d) => `<code>${frappe.utils.escape_html(d)}</code>`).join(", ")
				: `<i class="text-muted">${__("(keine Vorgaenger)")}</i>`;
			const pflicht = s.pflicht ? ` <span class="badge badge-warning">${__("Pflicht")}</span>` : "";
			return `<tr>
				<td><code>${frappe.utils.escape_html(sk)}</code></td>
				<td>${titel}${pflicht}</td>
				<td>${deps_html}</td>
			</tr>`;
		})
		.join("");
	field.$wrapper.html(`
		${errors_html}
		<div class="dag-graph-container" style="margin: 8px 0 12px 0;"></div>
		<table class="table table-condensed table-bordered" style="margin-top:8px;">
			<thead><tr><th>${__("Step-Key")}</th><th>${__("Titel")}</th><th>${__("Haengt ab von")}</th></tr></thead>
			<tbody>${rows}</tbody>
		</table>
	`);

	// Mermaid-Graph oberhalb der Tabelle (lazy via frappe.require)
	const nodes = schritte
		.map((s) => ({
			step_key: (s.step_key || "").trim(),
			titel: s.titel || s.step_key,
			pflicht: !!s.pflicht,
		}))
		.filter((n) => n.step_key);
	const edges = [];
	for (const [sk, deps] of Object.entries(deps_by_step)) {
		for (const dep of deps) {
			if (sk && dep) edges.push({ from: dep, to: sk });
		}
	}
	frappe.require("/assets/process_engine/js/dag_mermaid.js", () => {
		const container = field.$wrapper.find(".dag-graph-container").get(0);
		if (!container) return;
		window.process_engine.dag.renderDag({ container, nodes, edges });
	});
}


// ==================== Phase 10: Visual Editor ====================

async function _render_visual_editor(frm) {
	const field = frm.get_field("editor_html");
	if (!field) return;
	const is_locked = _is_version_locked(frm);
	const $wrapper = field.$wrapper;
	const shell_class = is_locked ? "pe-editor-shell pe-readonly" : "pe-editor-shell";
	// Toolbar als absolut positioniertes Overlay. Auf gesperrten Versionen bleibt nur
	// der "Felder"-Button (read-only Panel zum Ansehen), unterhalb des Readonly-Banners.
	const toolbar_html = `<div class="pe-toolbar${is_locked ? " pe-toolbar-locked" : ""}">
			${is_locked ? "" : `<button class="btn btn-xs pe-add-step">+ ${__("Schritt")}</button>`}
			<button class="btn btn-xs pe-manage-fields">${__("Felder")}</button>
		</div>`;
	$wrapper.html(`
		<div class="${shell_class}" style="margin-top: ${is_locked ? "32px" : "0"};">
			${toolbar_html}
			<div class="pe-canvas"></div>
			<div class="pe-inspector"></div>
		</div>
	`);
	const canvas = $wrapper.find(".pe-canvas").get(0);
	const inspector_el = $wrapper.find(".pe-inspector").get(0);
	if (!canvas || !inspector_el) return;
	// "Felder"-Panel auch auf gesperrten Versionen (read-only); "+ Schritt" nur editierbar.
	$wrapper.find(".pe-manage-fields").off("click").on("click", () => _open_fields_panel(frm, inspector_el));
	if (!is_locked) {
		$wrapper.find(".pe-add-step").off("click").on("click", () => _open_add_step_dialog(frm));
	}
	await new Promise((r) => frappe.require("/assets/process_engine/js/process_editor.js", r));
	await window.process_engine.editor.render({
		container: canvas,
		schritte: frm.doc.schritte || [],
		schritt_io: frm.doc.schritt_io || [],
		payload_field_specs: frm.doc.payload_field_specs || [],
		read_only: is_locked,
		on_save_position(step_key, x, y) {
			const row = (frm.doc.schritte || []).find((r) => (r.step_key || "").trim() === step_key);
			if (!row) return;
			frappe.model.set_value(row.doctype, row.name, "editor_x", x);
			frappe.model.set_value(row.doctype, row.name, "editor_y", y);
		},
		on_create_edge(src, dst) {
			if (is_locked) return;
			// dst.kind ist entweder "payload_input" oder "step_input" — beide erzeugen
			// eine schritt_io-Zeile mit demselben Schema (step_key, kind, target).
			if (!dst.kind || !dst.target || !dst.step_key) return;
			const existing = (frm.doc.schritt_io || []).find(
				(r) =>
					(r.step_key || "").trim() === dst.step_key &&
					(r.kind || "").trim() === dst.kind &&
					(r.target || "").trim() === dst.target
			);
			if (existing) return;
			const new_row = frappe.model.add_child(frm.doc, "Prozess Schritt IO", "schritt_io");
			new_row.step_key = dst.step_key;
			new_row.kind = dst.kind;
			new_row.target = dst.target;
			frm.refresh_field("schritt_io");
			frm.dirty();
			_render_dag_preview(frm);
		},
		on_delete_edge(src, dst) {
			if (is_locked) return;
			if (!dst.kind || !dst.target || !dst.step_key) return;
			const before = frm.doc.schritt_io || [];
			const remaining = before.filter(
				(r) =>
					!(
						(r.step_key || "").trim() === dst.step_key &&
						(r.kind || "").trim() === dst.kind &&
						(r.target || "").trim() === dst.target
					)
			);
			if (remaining.length === before.length) return;
			// Volle Zeilen behalten (inkl. optionalem description) — clear_table + Re-Add
			// mit nur step_key/kind/target wuerde description aller Zeilen verlieren.
			frm.doc.schritt_io = remaining;
			frm.refresh_field("schritt_io");
			frm.dirty();
			_render_dag_preview(frm);
		},
		on_select_node(step_key) {
			_open_inspector(frm, inspector_el, step_key);
		},
	});
}

// Task-Type-Optionen identisch zum DocType-Select (prozess_schritt.json).
// Als Funktion (nicht top-level const): Doctype-JS teilt sich den globalen Scope,
// ein erneut evaluiertes top-level `const` wuerde "already declared" werfen.
function _pe_task_types() {
	return [
		"manual_check",
		"file_upload",
		"python_action",
		"print_document",
		"paperless_export",
		"email_draft",
		"create_linked_doc",
	];
}

function _open_add_step_dialog(frm) {
	const existing_keys = new Set(
		(frm.doc.schritte || []).map((r) => (r.step_key || "").trim()).filter(Boolean)
	);
	// step_key-Default wie Server: step_NN mit naechstem freien Index.
	let idx = (frm.doc.schritte || []).length + 1;
	const _key_for = (n) => `step_${String(n).padStart(2, "0")}`;
	while (existing_keys.has(_key_for(idx))) idx += 1;

	const d = new frappe.ui.Dialog({
		title: __("Schritt hinzufügen"),
		fields: [
			{ fieldname: "titel", fieldtype: "Data", label: __("Titel"), reqd: 1 },
			{
				fieldname: "step_key",
				fieldtype: "Data",
				label: __("Step Key"),
				reqd: 1,
				default: _key_for(idx),
			},
			{
				fieldname: "task_type",
				fieldtype: "Select",
				label: __("Task Type"),
				reqd: 1,
				options: _pe_task_types().join("\n"),
				default: "manual_check",
			},
		],
		primary_action_label: __("Hinzufügen"),
		primary_action(values) {
			const step_key = (values.step_key || "").trim();
			if (!step_key) {
				frappe.msgprint(__("Step Key ist erforderlich."));
				return;
			}
			if (existing_keys.has(step_key)) {
				frappe.msgprint(__("Step Key ist bereits vergeben: {0}", [step_key]));
				return;
			}
			// Freie Canvas-Position rechts neben dem rechtesten vorhandenen Node.
			const max_x = (frm.doc.schritte || []).reduce(
				(m, r) => Math.max(m, Number(r.editor_x) || 0),
				0
			);
			const new_x = max_x ? max_x + 320 : 300;
			// reihenfolge ans Ende: groesster vorhandener Wert + 10, VOR add_child berechnet
			// (sonst zaehlt die neue Zeile mit). .length waere falsch bei Luecken/nach Loeschen,
			// da _normalize_rows nur leere reihenfolge fuellt, bestehende NICHT umnummeriert.
			const max_ord = (frm.doc.schritte || []).reduce((m, r) => Math.max(m, cint(r.reihenfolge)), 0);

			const row = frappe.model.add_child(frm.doc, "Prozess Schritt", "schritte");
			row.titel = (values.titel || "").trim();
			row.step_key = step_key;
			row.task_type = values.task_type || "manual_check";
			row.sichtbar_fuer_prozess_typ = "Beide";
			row.pflicht = 1;
			row.reihenfolge = max_ord + 10;
			row.editor_x = new_x;
			row.editor_y = 40;
			frm.refresh_field("schritte");
			frm.dirty();
			d.hide();
			_render_dag_preview(frm);
			_render_visual_editor(frm);
			frappe.show_alert(
				{
					message: __("Schritt angelegt — I/O über die Ports verbinden."),
					indicator: "blue",
				},
				5
			);
		},
	});
	d.show();
}

function _delete_step(frm, inspector_el, step_key) {
	if (_is_version_locked(frm)) return;
	const sk = (step_key || "").trim();
	if (!sk) return;
	const all_io = frm.doc.schritt_io || [];

	// Felder, die dieser Schritt als payload_output produziert …
	const my_outputs = all_io
		.filter((r) => (r.step_key || "").trim() === sk && (r.kind || "").trim() === "payload_output")
		.map((r) => (r.target || "").trim());
	// … und davon jene, die andere Schritte als payload_input konsumieren →
	// die verlieren ihren Producer und werden fortan als Process Input interpretiert.
	const orphaned = my_outputs.filter((f) =>
		all_io.some(
			(r) =>
				(r.kind || "").trim() === "payload_input" &&
				(r.target || "").trim() === f &&
				(r.step_key || "").trim() !== sk
		)
	);
	// Schritte, die diesen Schritt als step_input-Vorgaenger haben → Reihenfolge entfaellt.
	const dependents = all_io
		.filter((r) => (r.kind || "").trim() === "step_input" && (r.target || "").trim() === sk)
		.map((r) => (r.step_key || "").trim());

	let warn = "";
	if (orphaned.length) {
		warn += `<p class="text-warning"><b>${__("Achtung:")}</b> ${__(
			"Folgende Felder verlieren ihren Producer und werden zu Process Inputs:"
		)} ${orphaned.map((f) => `<code>${frappe.utils.escape_html(f)}</code>`).join(", ")}</p>`;
	}
	if (dependents.length) {
		warn += `<p class="text-muted">${__("Vorgaenger-Abhaengigkeit entfaellt fuer:")} ${dependents
			.map((d) => `<code>${frappe.utils.escape_html(d)}</code>`)
			.join(", ")}</p>`;
	}

	const msg = `<p>${__("Schritt {0} wirklich loeschen?", [`<code>${frappe.utils.escape_html(sk)}</code>`])}</p>${warn}`;
	frappe.confirm(msg, () => {
		// schritte-Zeile entfernen
		frm.doc.schritte = (frm.doc.schritte || []).filter((r) => (r.step_key || "").trim() !== sk);
		// Cascade: alle I/O dieses Schritts + step_inputs, die auf ihn zeigen.
		// Consumer-payload_inputs anderer Schritte bleiben bewusst erhalten (siehe Warnung).
		frm.doc.schritt_io = (frm.doc.schritt_io || []).filter((r) => {
			const rsk = (r.step_key || "").trim();
			const kind = (r.kind || "").trim();
			const tgt = (r.target || "").trim();
			if (rsk === sk) return false;
			if (kind === "step_input" && tgt === sk) return false;
			return true;
		});
		frm.refresh_field("schritte");
		frm.refresh_field("schritt_io");
		frm.dirty();
		$(inspector_el).removeClass("pe-open").empty();
		_render_dag_preview(frm);
		_render_visual_editor(frm);
	});
}

function _open_inspector(frm, inspector_el, step_key) {
	const $inspector = $(inspector_el);
	const row = (frm.doc.schritte || []).find((r) => (r.step_key || "").trim() === step_key);
	if (!row) {
		$inspector.removeClass("pe-open").empty();
		return;
	}
	const io_rows = (frm.doc.schritt_io || []).filter((r) => (r.step_key || "").trim() === step_key);
	const read_only = _is_version_locked(frm);
	const io_list = io_rows
		.map(
			(r) =>
				`<div class="pe-kv"><b>${frappe.utils.escape_html(r.kind)}</b> → <code>${frappe.utils.escape_html(r.target || "")}</code></div>`
		)
		.join("");
	$inspector.html(`
		<div class="pe-inspector-header">
			<strong>${frappe.utils.escape_html(row.titel || row.step_key)}</strong>
			<span class="pe-inspector-actions">
				${read_only ? "" : `<button class="pe-inspector-delete btn btn-xs" title="${__("Schritt löschen")}">${__("Löschen")}</button>`}
				<button class="pe-inspector-close" title="${__("Schliessen")}">&times;</button>
			</span>
		</div>
		<div class="pe-inspector-section">
			<h6>${__("Schritt")}</h6>
			<div class="pe-kv"><b>step_key:</b> <code>${frappe.utils.escape_html(row.step_key || "")}</code></div>
			<div class="pe-fields"></div>
			<div class="pe-konfig"></div>
		</div>
		<div class="pe-inspector-section">
			<h6>${__("I/O")} (${io_rows.length})</h6>
			${io_list || `<div class="text-muted">${__("Keine I/O")}</div>`}
		</div>
		${
			read_only
				? `<div class="text-warning"><small>${__("Schreibgeschuetzt — Edit nur via 'Bearbeiten als neue Version'.")}</small></div>`
				: ""
		}
	`);
	$inspector.addClass("pe-open");
	$inspector.find(".pe-inspector-close").off("click").on("click", () => {
		$inspector.removeClass("pe-open").empty();
	});
	$inspector.find(".pe-inspector-delete").off("click").on("click", () => {
		_delete_step(frm, inspector_el, step_key);
	});

	const fields_el = $inspector.find(".pe-fields").get(0);
	const konfig_el = $inspector.find(".pe-konfig").get(0);
	const _kv = (k, v) => (v ? `<div class="pe-kv"><b>${k}:</b> ${frappe.utils.escape_html(String(v))}</div>` : "");
	if (read_only) {
		$(fields_el).html(`
			${_kv("task_type", row.task_type)}
			<div class="pe-kv"><b>pflicht:</b> ${row.pflicht ? "ja" : "nein"}</div>
			${_kv("sichtbar", row.sichtbar_fuer_prozess_typ)}
			${_kv("handler_key", row.handler_key)}
			${_kv("dokument_typ_tag", row.dokument_typ_tag)}
			${_kv("print_format", row.print_format)}
			${_kv("verantwortlich_rolle", row.standard_verantwortlich_rolle)}
		`);
		$(konfig_el).html(
			row.konfig_json && row.konfig_json.trim() !== "{}"
				? `<div class="pe-kv"><b>konfig_json:</b></div><pre class="pe-konfig-pre">${frappe.utils.escape_html(row.konfig_json)}</pre>`
				: ""
		);
	} else {
		_render_inspector_fields(frm, inspector_el, row, fields_el);
		_render_konfig_editor(frm, inspector_el, row, konfig_el);
	}
}

// konfig_json (Task-Config, rohes JSON) via Dialog editieren — vermeidet das
// unzuverlaessige Inline-Binding eines Code/Ace-Controls. Nach Stufe 0 ist konfig_json
// die einzige Config-Quelle; _normalize_rows/validate_config greifen beim Save.
function _render_konfig_editor(frm, inspector_el, row, container) {
	const cur = (row.konfig_json || "").trim();
	const preview = cur && cur !== "{}" ? cur : "{}";
	$(container).html(`
		<div class="pe-kv" style="margin-top:6px;"><b>${__("Konfig (JSON)")}</b></div>
		<pre class="pe-konfig-pre">${frappe.utils.escape_html(preview)}</pre>
		<button class="btn btn-xs btn-default pe-konfig-edit">${__("Konfig bearbeiten")}</button>
	`);
	$(container).find(".pe-konfig-edit").off("click").on("click", () => {
		const d = new frappe.ui.Dialog({
			title: __("Konfig (JSON): {0}", [row.step_key || ""]),
			fields: [
				{
					fieldname: "konfig_json",
					fieldtype: "Code",
					label: __("Konfig JSON"),
					options: "JSON",
					default: cur || "{}",
				},
			],
			primary_action_label: __("Übernehmen"),
			primary_action(values) {
				const raw = (values.konfig_json || "").trim() || "{}";
				try {
					JSON.parse(raw);
				} catch (e) {
					frappe.msgprint(__("Ungültiges JSON: {0}", [String(e)]));
					return;
				}
				frappe.model.set_value(row.doctype, row.name, "konfig_json", raw);
				frm.dirty();
				d.hide();
				// Vorschau aktualisieren (kein Canvas-Re-render noetig).
				_render_konfig_editor(frm, inspector_el, row, container);
			},
		});
		d.show();
	});
}

// Phase 10 / Stufe 3: einfache Schrittfelder inline via make_control editierbar.
// Muster analog prozess_instanz.js. step_key bewusst NICHT editierbar (String-FK in
// schritt_io). konfig_json bleibt im Grid.
function _render_inspector_fields(frm, inspector_el, row, container) {
	const defs = [
		{ fieldname: "titel", fieldtype: "Data", label: __("Titel"), reqd: 1 },
		{
			fieldname: "task_type",
			fieldtype: "Select",
			label: __("Task Type"),
			options: _pe_task_types().join("\n"),
		},
		{ fieldname: "pflicht", fieldtype: "Check", label: __("Pflicht") },
		{ fieldname: "sichtbar_fuer_prozess_typ", fieldtype: "Data", label: __("Sichtbar fuer Prozess-Typ") },
		{ fieldname: "handler_key", fieldtype: "Data", label: __("Handler Key") },
		{ fieldname: "reihenfolge", fieldtype: "Int", label: __("Reihenfolge") },
		{ fieldname: "dokument_typ_tag", fieldtype: "Data", label: __("Dokument Typ Tag") },
		{ fieldname: "print_format", fieldtype: "Link", label: __("Print Format"), options: "Print Format" },
		{ fieldname: "standard_verantwortlich_rolle", fieldtype: "Link", label: __("Verantwortlich Rolle"), options: "Role" },
		{ fieldname: "default_faelligkeit_tage", fieldtype: "Int", label: __("Faelligkeit (Tage)") },
	];
	for (const def of defs) {
		const $col = $('<div class="pe-field" style="margin-bottom:8px;"></div>');
		$(container).append($col);
		const ctrl = frappe.ui.form.make_control({
			df: {
				fieldname: def.fieldname,
				label: def.label,
				fieldtype: def.fieldtype,
				options: def.options || undefined,
				reqd: def.reqd || 0,
			},
			parent: $col.get(0),
			render_input: true,
		});
		if (def.fieldtype === "Check") {
			ctrl.set_value(cint(row[def.fieldname]));
		} else {
			ctrl.set_value(row[def.fieldname] || "");
		}
		// Direkt am Input lauschen statt auf Frappes df.onchange: dessen Change-Pipeline
		// (base_control) greift bei make_controls, die NACH einem Editor-Re-render erzeugt
		// werden, nicht zuverlaessig. change feuert auf blur (Data) bzw. sofort (Select/Check)
		// — also nicht pro Tastendruck, kein Springen des Inspectors.
		const _apply = () => {
			let val = ctrl.get_value();
			if (def.fieldtype === "Check" || def.fieldtype === "Int") val = cint(val);
			frappe.model.set_value(row.doctype, row.name, def.fieldname, val);
			frm.dirty();
			if (def.fieldname === "titel" || def.fieldname === "task_type") {
				// In-place Node-Label patchen statt Full-Re-render (Fokus bleibt).
				_patch_node_label(inspector_el, row.step_key, def.fieldname, val);
				if (def.fieldname === "titel") {
					$(inspector_el)
						.find(".pe-inspector-header > strong")
						.text(val || row.step_key);
				}
				_render_dag_preview(frm);
			}
		};
		if (ctrl.$input && ctrl.$input.length) {
			ctrl.$input.on("change", _apply);
		} else {
			ctrl.df.onchange = _apply;
		}
	}
}

// Aktualisiert Titel/Badge eines Nodes direkt im Canvas-DOM (data-step-key wird vom
// Editor gesetzt), ohne den Canvas neu zu zeichnen.
function _patch_node_label(inspector_el, step_key, fieldname, val) {
	const sk = (step_key || "").trim();
	if (!sk) return;
	// step_key ist freier Data-Text und kann Sonderzeichen (inkl. Spaces) enthalten, die
	// den Attribut-Selektor sonst zerbrechen. Primaer CSS.escape (unquoted), Fallback ist
	// die quoted-Form mit escapeten Quotes/Backslashes — beide vertragen Spaces.
	const $shell = $(inspector_el).closest(".pe-editor-shell");
	const $node =
		window.CSS && CSS.escape
			? $shell.find(`.pe-canvas .drawflow-node[data-step-key=${CSS.escape(sk)}]`)
			: $shell.find(`.pe-canvas .drawflow-node[data-step-key="${sk.replace(/(["\\])/g, "\\$1")}"]`);
	if (!$node.length) return;
	if (fieldname === "titel") {
		$node.find(".pe-node-header strong").text(val || sk);
	} else if (fieldname === "task_type") {
		$node.find(".pe-node-header .pe-badge").text(val || "");
	}
}

// ==================== Phase 11: Payload-Felder im Editor ====================

// Feld-Typen identisch zum Select in prozess_field_spec.json.
function _pe_field_types() {
	return [
		"Data",
		"Link",
		"Date",
		"Datetime",
		"Int",
		"Float",
		"Currency",
		"Check",
		"Select",
		"Small Text",
		"Long Text",
	];
}

// Panel im Inspector neu oeffnen, nachdem _render_visual_editor den .pe-inspector
// neu aufgebaut hat (neues DOM-Element).
function _reopen_fields_panel(frm) {
	const field = frm.get_field("editor_html");
	const el = field && field.$wrapper.find(".pe-inspector").get(0);
	if (el) _open_fields_panel(frm, el);
}

function _open_fields_panel(frm, inspector_el) {
	const $inspector = $(inspector_el);
	const read_only = _is_version_locked(frm);
	const specs = frm.doc.payload_field_specs || [];
	$inspector.html(`
		<div class="pe-inspector-header">
			<strong>${__("Payload-Felder")} (${specs.length})</strong>
			<span class="pe-inspector-actions">
				${read_only ? "" : `<button class="pe-add-field btn btn-xs" title="${__("Feld hinzufügen")}">+ ${__("Feld")}</button>`}
				<button class="pe-inspector-close" title="${__("Schliessen")}">&times;</button>
			</span>
		</div>
		<div class="pe-fields-list"></div>
		${read_only ? `<div class="text-warning"><small>${__("Schreibgeschuetzt — Edit nur via 'Bearbeiten als neue Version'.")}</small></div>` : ""}
	`);
	$inspector.addClass("pe-open");
	$inspector.find(".pe-inspector-close").off("click").on("click", () => {
		$inspector.removeClass("pe-open").empty();
	});
	$inspector.find(".pe-add-field").off("click").on("click", () => _open_add_field_dialog(frm, inspector_el));

	const $list = $inspector.find(".pe-fields-list");
	if (!specs.length) {
		$list.html(`<div class="text-muted">${__("Noch keine Payload-Felder.")}</div>`);
		return;
	}
	for (const spec of specs) {
		const $row = $(`
			<div class="pe-field-row">
				<div class="pe-field-row-head">
					<code>${frappe.utils.escape_html(spec.fieldname || "")}</code>
					${read_only ? "" : `<button class="pe-field-del btn btn-xs" title="${__("Feld löschen")}">${__("Löschen")}</button>`}
				</div>
				<div class="pe-field-ctrls"></div>
			</div>
		`);
		$list.append($row);
		const ctrls_el = $row.find(".pe-field-ctrls").get(0);
		if (read_only) {
			$(ctrls_el).html(`
				<div class="pe-kv"><b>label:</b> ${frappe.utils.escape_html(spec.label || "")}</div>
				<div class="pe-kv"><b>fieldtype:</b> ${frappe.utils.escape_html(spec.fieldtype || "")}</div>
				${spec.options ? `<div class="pe-kv"><b>options:</b> ${frappe.utils.escape_html(spec.options)}</div>` : ""}
				<div class="pe-kv"><b>reqd:</b> ${spec.reqd ? "ja" : "nein"} · <b>list:</b> ${spec.in_list_view ? "ja" : "nein"}</div>
				${spec.description ? `<div class="pe-kv"><b>description:</b> ${frappe.utils.escape_html(spec.description)}</div>` : ""}
			`);
		} else {
			_render_field_spec_controls(frm, spec, ctrls_el);
			$row.find(".pe-field-del").off("click").on("click", () => _delete_field(frm, inspector_el, spec.fieldname));
		}
	}
}

// fieldname bewusst NICHT editierbar (String-FK in schritt_io.target) — Rename nur via Grid.
function _render_field_spec_controls(frm, spec, container) {
	const defs = [
		{ fieldname: "label", fieldtype: "Data", label: __("Label") },
		{ fieldname: "fieldtype", fieldtype: "Select", label: __("Feld-Typ"), options: _pe_field_types().join("\n") },
		{ fieldname: "options", fieldtype: "Small Text", label: __("Optionen (Link: DocType / Select: je Zeile)") },
		{ fieldname: "reqd", fieldtype: "Check", label: __("Pflicht") },
		{ fieldname: "in_list_view", fieldtype: "Check", label: __("In Liste") },
		{ fieldname: "description", fieldtype: "Data", label: __("Beschreibung") },
	];
	for (const def of defs) {
		const $col = $('<div class="pe-field" style="margin-bottom:6px;"></div>');
		$(container).append($col);
		const ctrl = frappe.ui.form.make_control({
			df: { fieldname: def.fieldname, label: def.label, fieldtype: def.fieldtype, options: def.options || undefined },
			parent: $col.get(0),
			render_input: true,
		});
		if (def.fieldtype === "Check") ctrl.set_value(cint(spec[def.fieldname]));
		else ctrl.set_value(spec[def.fieldname] || "");
		// Edits an label/fieldtype/options/reqd aendern die Port-Menge NICHT (Ports = fieldname)
		// -> kein Canvas-Re-render noetig, nur Modell + dirty.
		const _apply = () => {
			let val = ctrl.get_value();
			if (def.fieldtype === "Check") val = cint(val);
			frappe.model.set_value(spec.doctype, spec.name, def.fieldname, val);
			frm.dirty();
		};
		if (ctrl.$input && ctrl.$input.length) ctrl.$input.on("change", _apply);
		else ctrl.df.onchange = _apply;
	}
}

function _open_add_field_dialog(frm, inspector_el) {
	const existing = new Set(
		(frm.doc.payload_field_specs || []).map((s) => (s.fieldname || "").trim()).filter(Boolean)
	);
	const d = new frappe.ui.Dialog({
		title: __("Payload-Feld hinzufügen"),
		fields: [
			{ fieldname: "fieldname", fieldtype: "Data", label: __("Feldname (technisch)"), reqd: 1 },
			{ fieldname: "label", fieldtype: "Data", label: __("Label"), reqd: 1 },
			{ fieldname: "fieldtype", fieldtype: "Select", label: __("Feld-Typ"), reqd: 1, options: _pe_field_types().join("\n"), default: "Data" },
			{
				fieldname: "options",
				fieldtype: "Small Text",
				label: __("Optionen"),
				description: __("Bei Link: Ziel-DocType. Bei Select: Optionen je Zeile."),
				depends_on: "eval:['Link','Select'].includes(doc.fieldtype)",
			},
			{ fieldname: "reqd", fieldtype: "Check", label: __("Pflicht") },
			{ fieldname: "in_list_view", fieldtype: "Check", label: __("In Liste anzeigen") },
			{ fieldname: "description", fieldtype: "Small Text", label: __("Beschreibung (optional)") },
		],
		primary_action_label: __("Hinzufügen"),
		primary_action(values) {
			const fn = (values.fieldname || "").trim();
			if (!fn) {
				frappe.msgprint(__("Feldname ist erforderlich."));
				return;
			}
			if (existing.has(fn)) {
				frappe.msgprint(__("Feldname ist bereits vergeben: {0}", [fn]));
				return;
			}
			const row = frappe.model.add_child(frm.doc, "Prozess Field Spec", "payload_field_specs");
			row.fieldname = fn;
			row.label = (values.label || "").trim();
			row.fieldtype = values.fieldtype || "Data";
			row.options = (values.options || "").trim();
			row.reqd = cint(values.reqd);
			row.in_list_view = cint(values.in_list_view);
			row.description = (values.description || "").trim();
			frm.refresh_field("payload_field_specs");
			frm.dirty();
			d.hide();
			// Neues Feld -> neuer Port -> Canvas + DAG neu zeichnen, Panel neu oeffnen.
			_render_dag_preview(frm);
			_render_visual_editor(frm).then(() => _reopen_fields_panel(frm));
		},
	});
	d.show();
}

function _delete_field(frm, inspector_el, fieldname) {
	if (_is_version_locked(frm)) return;
	const fn = (fieldname || "").trim();
	if (!fn) return;
	const io = frm.doc.schritt_io || [];
	const _is_ref = (r) =>
		["payload_input", "payload_output"].includes((r.kind || "").trim()) &&
		(r.target || "").trim() === fn;
	const refSteps = Array.from(new Set(io.filter(_is_ref).map((r) => (r.step_key || "").trim())));
	let warn = "";
	if (refSteps.length) {
		warn = `<p class="text-warning"><b>${__("Achtung:")}</b> ${__(
			"Folgende Schritte nutzen dieses Feld; ihre I/O-Verbindungen werden mit entfernt:"
		)} ${refSteps.map((s) => `<code>${frappe.utils.escape_html(s)}</code>`).join(", ")}</p>`;
	}
	const msg = `<p>${__("Payload-Feld {0} wirklich loeschen?", [`<code>${frappe.utils.escape_html(fn)}</code>`])}</p>${warn}`;
	frappe.confirm(msg, () => {
		frm.doc.payload_field_specs = (frm.doc.payload_field_specs || []).filter(
			(s) => (s.fieldname || "").trim() !== fn
		);
		// Cascade: referenzierende schritt_io-Zeilen mit-entfernen (sonst wirft
		// _validate_schritt_io: target ist kein gueltiges payload_field_specs).
		frm.doc.schritt_io = io.filter((r) => !_is_ref(r));
		frm.refresh_field("payload_field_specs");
		frm.refresh_field("schritt_io");
		frm.dirty();
		_render_dag_preview(frm);
		_render_visual_editor(frm).then(() => _reopen_fields_panel(frm));
	});
}
