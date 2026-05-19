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

		if (frm.doc.is_active) {
			// A2: aktive Version visuell sperren (Server-Lock in A1 ist source of truth)
			for (const fname of locked_fields) {
				frm.set_df_property(fname, "read_only", 1);
			}
			frm.dashboard.clear_headline();
			frm.dashboard.set_headline(
				__("Aktive Version — schreibgeschuetzt. Aenderungen erfordern eine neue Version."),
				"orange"
			);
			frm.add_custom_button(__("Bearbeiten als neue Version"), () => {
				_open_duplicate_dialog(frm);
			}).addClass("btn-primary");
		} else {
			// Felder editierbar lassen (defensiv falls jemand die Form vorher in aktivem
			// Zustand geoeffnet hatte und der Refresh nicht ganz frisch ist)
			for (const fname of locked_fields) {
				frm.set_df_property(fname, "read_only", 0);
			}
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

// A4 + B-min: Live-Refresh bei Edit der Schritte / Kanten
// Add/Remove sind Parent-Form-Events (Frappe-Konvention), Field-Changes sind Child-Events.
frappe.ui.form.on("Prozess Version", {
	schritte_add: (frm) => _render_dag_preview(frm),
	schritte_remove: (frm) => _render_dag_preview(frm),
	schritt_kanten_add: (frm) => _render_dag_preview(frm),
	schritt_kanten_remove: (frm) => _render_dag_preview(frm),
});

frappe.ui.form.on("Prozess Schritt", {
	titel: (frm) => _render_dag_preview(frm),
	step_key: (frm) => _render_dag_preview(frm),
});

frappe.ui.form.on("Prozess Schritt Kante", {
	step_key: (frm) => _render_dag_preview(frm),
	depends_on_step_key: (frm) => _render_dag_preview(frm),
});

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
		const replaces = p.currently_active
			? `<p>${__("Ersetzt aktuell aktive Version:")} <b>${frappe.utils.escape_html(p.currently_active.titel)}</b> (<code>${frappe.utils.escape_html(p.currently_active.version_key)}</code>)</p>`
			: `<p>${__("Aktuell ist keine Version fuer")} <b>${frappe.utils.escape_html(p.runtime_doctype || "")}</b> ${__("aktiv.")}</p>`;
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

function _validate_dag_locally(frm) {
	const schritte = frm.doc.schritte || [];
	const kanten = frm.doc.schritt_kanten || [];
	const step_keys = new Set(schritte.map((s) => (s.step_key || "").trim()).filter(Boolean));
	const errors = [];

	for (const k of kanten) {
		const sk = (k.step_key || "").trim();
		const dep = (k.depends_on_step_key || "").trim();
		if (sk && dep && sk === dep) {
			errors.push(__("Schritt kann nicht von sich selbst abhaengen: {0}", [sk]));
		}
	}
	for (const k of kanten) {
		const sk = (k.step_key || "").trim();
		const dep = (k.depends_on_step_key || "").trim();
		if (sk && !step_keys.has(sk)) errors.push(__("Kante referenziert unbekannten Schritt: {0}", [sk]));
		if (dep && !step_keys.has(dep)) errors.push(__("Kante referenziert unbekannten Vorgaenger-Schritt: {0}", [dep]));
	}
	const seen_edges = new Set();
	for (const k of kanten) {
		const sk = (k.step_key || "").trim();
		const dep = (k.depends_on_step_key || "").trim();
		if (!sk || !dep) continue;
		const key = sk + "\0" + dep;
		if (seen_edges.has(key)) errors.push(__("Doppelte Kante: {0} haengt mehrfach von {1} ab.", [sk, dep]));
		seen_edges.add(key);
	}

	// Cycle detection via DFS with coloring
	const adj = {};
	for (const sk of step_keys) adj[sk] = [];
	for (const k of kanten) {
		const sk = (k.step_key || "").trim();
		const dep = (k.depends_on_step_key || "").trim();
		if (sk && dep && step_keys.has(sk) && step_keys.has(dep)) {
			adj[sk].push(dep);
		}
	}
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
	const kanten = frm.doc.schritt_kanten || [];
	if (!schritte.length) {
		field.$wrapper.html(`<p class="text-muted">${__("Noch keine Schritte definiert.")}</p>`);
		return;
	}
	const deps_by_step = {};
	for (const k of kanten) {
		const sk = (k.step_key || "").trim();
		const dep = (k.depends_on_step_key || "").trim();
		if (!sk || !dep) continue;
		deps_by_step[sk] = deps_by_step[sk] || [];
		deps_by_step[sk].push(dep);
	}
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
	const edges = kanten
		.map((k) => ({
			from: (k.depends_on_step_key || "").trim(),
			to: (k.step_key || "").trim(),
		}))
		.filter((e) => e.from && e.to);
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
	const $wrapper = field.$wrapper;
	const shell_class = frm.doc.is_active ? "pe-editor-shell pe-readonly" : "pe-editor-shell";
	$wrapper.html(`
		<div class="${shell_class}" style="margin-top: ${frm.doc.is_active ? "32px" : "0"};">
			<div class="pe-canvas"></div>
			<div class="pe-inspector"></div>
		</div>
	`);
	const canvas = $wrapper.find(".pe-canvas").get(0);
	const inspector_el = $wrapper.find(".pe-inspector").get(0);
	if (!canvas || !inspector_el) return;
	await new Promise((r) => frappe.require("/assets/process_engine/js/process_editor.js", r));
	await window.process_engine.editor.render({
		container: canvas,
		schritte: frm.doc.schritte || [],
		schritt_io: frm.doc.schritt_io || [],
		payload_field_specs: frm.doc.payload_field_specs || [],
		read_only: !!frm.doc.is_active,
		on_save_position(step_key, x, y) {
			const row = (frm.doc.schritte || []).find((r) => (r.step_key || "").trim() === step_key);
			if (!row) return;
			frappe.model.set_value(row.doctype, row.name, "editor_x", x);
			frappe.model.set_value(row.doctype, row.name, "editor_y", y);
		},
		on_create_edge(src, dst) {
			// Aktuell nur step_done → step_input wird zur Save-Logik durchgereicht.
			if (dst.kind === "step_input" && dst.target) {
				const existing = (frm.doc.schritt_io || []).find(
					(r) =>
						(r.step_key || "").trim() === dst.step_key &&
						(r.kind || "").trim() === "step_input" &&
						(r.target || "").trim() === dst.target
				);
				if (existing) return;
				const new_row = frappe.model.add_child(frm.doc, "Prozess Schritt IO", "schritt_io");
				new_row.step_key = dst.step_key;
				new_row.kind = "step_input";
				new_row.target = dst.target;
				frm.refresh_field("schritt_io");
				frm.dirty();
			}
		},
		on_delete_edge(src, dst) {
			if (dst.kind === "step_input" && dst.target) {
				const remaining = (frm.doc.schritt_io || []).filter(
					(r) =>
						!(
							(r.step_key || "").trim() === dst.step_key &&
							(r.kind || "").trim() === "step_input" &&
							(r.target || "").trim() === dst.target
						)
				);
				frm.clear_table("schritt_io");
				for (const r of remaining) {
					const new_row = frappe.model.add_child(frm.doc, "Prozess Schritt IO", "schritt_io");
					new_row.step_key = r.step_key;
					new_row.kind = r.kind;
					new_row.target = r.target;
				}
				frm.refresh_field("schritt_io");
				frm.dirty();
			}
		},
		on_select_node(step_key) {
			_open_inspector(frm, inspector_el, step_key);
		},
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
	const read_only = !!frm.doc.is_active;
	const io_list = io_rows
		.map(
			(r) =>
				`<div class="pe-kv"><b>${frappe.utils.escape_html(r.kind)}</b> → <code>${frappe.utils.escape_html(r.target || "")}</code></div>`
		)
		.join("");
	$inspector.html(`
		<div class="pe-inspector-header">
			<strong>${frappe.utils.escape_html(row.titel || row.step_key)}</strong>
			<button class="pe-inspector-close" title="${__("Schliessen")}">&times;</button>
		</div>
		<div class="pe-inspector-section">
			<h6>${__("Schritt")}</h6>
			<div class="pe-kv"><b>step_key:</b> <code>${frappe.utils.escape_html(row.step_key || "")}</code></div>
			<div class="pe-kv"><b>task_type:</b> ${frappe.utils.escape_html(row.task_type || "")}</div>
			<div class="pe-kv"><b>pflicht:</b> ${row.pflicht ? "ja" : "nein"}</div>
			<div class="pe-kv"><b>sichtbar:</b> ${frappe.utils.escape_html(row.sichtbar_fuer_prozess_typ || "")}</div>
			${row.handler_key ? `<div class="pe-kv"><b>handler_key:</b> <code>${frappe.utils.escape_html(row.handler_key)}</code></div>` : ""}
			${row.print_format ? `<div class="pe-kv"><b>print_format:</b> ${frappe.utils.escape_html(row.print_format)}</div>` : ""}
		</div>
		<div class="pe-inspector-section">
			<h6>${__("I/O")} (${io_rows.length})</h6>
			${io_list || `<div class="text-muted">${__("Keine I/O")}</div>`}
		</div>
		${
			read_only
				? `<div class="text-warning"><small>${__("Aktive Version — Edit nur via duplizieren.")}</small></div>`
				: `<div class="pe-inspector-section"><button class="btn btn-xs btn-default" data-action="open-grid">${__("Im Grid bearbeiten")}</button></div>`
		}
	`);
	$inspector.addClass("pe-open");
	$inspector.find(".pe-inspector-close").off("click").on("click", () => {
		$inspector.removeClass("pe-open").empty();
	});
	$inspector.find('[data-action="open-grid"]').off("click").on("click", () => {
		// Scrollen zum Schritte-Grid und Row oeffnen
		frm.scroll_to_field("schritte");
		const grid = frm.get_field("schritte").grid;
		if (grid && row.name) {
			try {
				grid.toggle_view(row.name, true);
			} catch (e) {}
		}
	});
}
