// Phase 5 UI-Schicht fuer Prozess Instanz:
// 5a — Payload-Form-Renderer (dynamische Controls statt JSON-Textarea)
// 5b — Per-Task-Action-Buttons (PDF, Paperless, Python-Action, ...)
// 5c — create_linked_doc Dialog-Flow
// Phase 6 — Progress-Graph (Mermaid) im progress_html-Feld

frappe.ui.form.on("Prozess Instanz", {
	async refresh(frm) {
		// payload_json wird via DocField-Property versteckt (kein DOM-Eingriff).
		// Power-User-Toggle weiter unten kann es bei Bedarf wieder einblenden.
		frm.set_df_property("payload_json", "hidden", 1);
		_add_raw_json_toggle(frm);

		if (frm.is_new() && !frm.doc.prozess_typ) {
			return;
		}
		await _render_payload_form(frm);
		await _render_task_action_panel(frm);
		_wire_task_actions(frm);
		await _render_task_views(frm);
		_render_progress_graph(frm);
	},
	prozess_typ(frm) {
		_render_payload_form(frm);
	},
	prozess_version(frm) {
		// Phase 7: Specs leben pro Version, daher auch bei version-change re-rendern.
		_render_payload_form(frm);
	},
});

frappe.ui.form.on("Prozess Aufgabe", {
	// Action-Panel + Graph zusammen aktualisieren — sonst zeigt der Graph alten Status
	// bis zum naechsten reload_doc().
	status(frm) {
		_render_task_action_panel(frm);
		_render_progress_graph(frm);
	},
	erfuellt(frm) {
		_render_task_action_panel(frm);
		_render_progress_graph(frm);
	},
});

// ==================== 5a: Payload-Form-Renderer ====================

async function _render_payload_form(frm) {
	const field = frm.get_field("payload_form_html");
	if (!field) return;
	// Phase 7: ohne typ UND ohne version koennen wir nichts holen.
	if (!frm.doc.prozess_typ && !frm.doc.prozess_version) {
		field.$wrapper.html("");
		return;
	}
	let specs = [];
	try {
		const r = await frappe.call({
			method: "process_engine.process_engine.processes.triggers.get_payload_field_specs",
			args: {
				// Phase 7: Specs leben pro Version. prozess_typ als Fallback fuer
				// new-doc-Form vor dem ersten Save (Server faellt auf aktive Version).
				prozess_version: frm.doc.prozess_version || "",
				prozess_typ: frm.doc.prozess_typ || "",
			},
		});
		specs = r.message || [];
	} catch (err) {
		console.error("get_payload_field_specs failed", err);
		field.$wrapper.html(`<p class="text-danger">${__("Payload-Specs konnten nicht geladen werden.")}</p>`);
		return;
	}
	if (!specs.length) {
		field.$wrapper.html(`<p class="text-muted">${__("Keine Payload-Felder konfiguriert.")}</p>`);
		return;
	}

	let state = {};
	try {
		state = JSON.parse(frm.doc.payload_json || "{}");
		if (!state || typeof state !== "object") state = {};
	} catch (e) {
		state = {};
	}

	const $container = $('<div class="payload-dynamic-form row"></div>');
	field.$wrapper.empty().append($container);

	for (const spec of specs) {
		const $col = $('<div class="form-column col-sm-6" style="margin-bottom:8px;"></div>');
		$container.append($col);
		const df = {
			fieldname: spec.fieldname,
			label: spec.label,
			fieldtype: spec.fieldtype,
			options: spec.options || undefined,
			reqd: spec.reqd,
			description: spec.description || undefined,
		};
		const ctrl = frappe.ui.form.make_control({
			df,
			parent: $col.get(0),
			render_input: true,
		});
		const current_val = state[spec.fieldname] ?? null;
		if (current_val !== null && current_val !== undefined) {
			ctrl.set_value(current_val);
		}
		ctrl.df.onchange = () => {
			const new_state = { ...state, [spec.fieldname]: ctrl.get_value() };
			state = new_state;
			frm.set_value("payload_json", JSON.stringify(new_state));
		};
	}
}

function _add_raw_json_toggle(frm) {
	if (frm.is_new()) return;
	if (frm.__hv_raw_json_toggle_added) return;
	frm.__hv_raw_json_toggle_added = true;
	frm.add_custom_button(__("Raw JSON anzeigen"), () => {
		frm.set_df_property("payload_json", "hidden", 0);
		frm.refresh_field("payload_json");
	}, __("Power-User"));
}

// ==================== 5b: Per-Task-Action-Buttons ====================

async function _render_task_action_panel(frm) {
	const field = frm.get_field("task_actions_html");
	if (!field) return;
	const rows = frm.doc.aufgaben || [];
	if (!rows.length) {
		field.$wrapper.html(`<p class="text-muted">${__("Keine Aufgaben.")}</p>`);
		return;
	}
	// Phase 13 B: Buttons kommen aus der Handler-Selbstbeschreibung (Server), nicht
	// mehr aus einem Per-Typ-Switch im Client. Server liefert pro Aufgabe key/label/
	// primary/dialog + disabled/reason (Lock-/Status-Gates).
	let actions_by_row = {};
	if (!frm.is_new()) {
		try {
			const r = await frappe.call({
				method: "process_engine.process_engine.doctype.prozess_instanz.prozess_instanz.get_task_runtime_actions",
				args: { docname: frm.doc.name },
			});
			actions_by_row = r.message || {};
		} catch (err) {
			console.error("get_task_runtime_actions failed", err);
		}
	}
	const items = rows.map((r) => _render_task_row(frm, r, actions_by_row[r.name] || [])).join("");
	field.$wrapper.html(`<div class="task-action-panel" style="margin-top:8px;">${items}</div>`);
}

function _render_task_row(frm, row, actions) {
	const locked = row.pflicht && !_is_task_unlocked_client(frm, row);
	const buttons = _render_action_buttons(row, actions);
	const status = row.status || "Offen";
	const status_class = status === "Erledigt" ? "green" : (locked ? "gray" : "blue");
	const status_badge = `<span class="indicator-pill ${status_class}">${frappe.utils.escape_html(status)}</span>`;
	const pflicht = row.pflicht ? `<span class="indicator-pill orange">${__("Pflicht")}</span>` : "";
	const lock_hint = locked ? `<span class="text-muted" style="margin-left:6px;">(${__("Vorgaenger offen")})</span>` : "";
	return `
		<div class="task-row" data-row-name="${row.name}" style="border:1px solid #d1d8dd; padding:8px 12px; margin-bottom:6px; border-radius:4px; ${locked ? "opacity:0.7;" : ""}">
			<div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
				<div>
					<strong>${frappe.utils.escape_html(row.aufgabe || row.step_key || "")}</strong>
					${pflicht} ${status_badge}${lock_hint}
				</div>
				<div class="task-actions" style="display:flex; gap:4px;">${buttons}</div>
			</div>
			<div class="pe-task-view-slot"></div>
		</div>
	`;
}

function _is_task_unlocked_client(frm, row) {
	// UX-Approximation: prueft NUR direkte depends_on. Server (_is_task_unlocked
	// in engine.py) macht das TRANSITIV. Hier nur fuer den Disabled-State.
	let deps = [];
	try { deps = JSON.parse(row.depends_on_json || "[]"); } catch (e) { deps = []; }
	if (!Array.isArray(deps) || !deps.length) return true;
	const by_key = {};
	for (const r of (frm.doc.aufgaben || [])) {
		const k = (r.step_key || "").trim();
		if (k) by_key[k] = r;
	}
	for (const d of deps) {
		const parent = by_key[(d || "").trim()];
		if (parent && !parent.erfuellt) return false;
	}
	return true;
}

function _render_action_buttons(row, actions) {
	if (!actions || !actions.length) return "";
	return actions
		.map((a) => {
			const cls = a.primary ? "btn-primary" : "btn-default";
			const disabled = a.disabled ? "disabled" : "";
			const title = a.disabled && a.reason ? ` title="${frappe.utils.escape_html(a.reason)}"` : "";
			const dialog = a.dialog ? ` data-dialog="${frappe.utils.escape_html(a.dialog)}"` : "";
			// Phase D: navigate (serverseitig validierter Descriptor) + has_action (ob es ein
			// Dispatch-Ziel gibt) als Daten-Attribute. JSON wird escaped, beim Klick re-geparsed.
			const navigate = a.navigate
				? ` data-navigate="${frappe.utils.escape_html(JSON.stringify(a.navigate))}"`
				: "";
			const hasAction = a.has_action ? ` data-has-action="1"` : "";
			return `<button class="btn btn-xs ${cls}" data-action-key="${frappe.utils.escape_html(a.key)}" data-row="${row.name}"${dialog}${navigate}${hasAction}${title} ${disabled}>${frappe.utils.escape_html(a.label)}</button>`;
		})
		.join(" ");
}

function _wire_task_actions(frm) {
	const field = frm.get_field("task_actions_html");
	if (!field) return;
	// off() entfernt frueher gebundene Handler beim Refresh. Delegation am Wrapper
	// ueberlebt das innerHTML-Re-Render der Buttons.
	field.$wrapper.off("click.hv_task_actions").on("click.hv_task_actions", "button[data-action-key]", async (e) => {
		const $btn = $(e.currentTarget);
		const action_key = $btn.data("action-key");
		const row_name = $btn.data("row");
		const dialog = $btn.data("dialog");
		const has_action = !!$btn.data("has-action");
		let navigate = null;
		const nav_raw = $btn.attr("data-navigate");
		if (nav_raw) {
			try {
				navigate = JSON.parse(nav_raw);
			} catch (e) {
				navigate = null;
			}
		}
		await _dispatch_task_action(frm, action_key, row_name, dialog, navigate, has_action);
	});
}

async function _dispatch_task_action(frm, action_key, row_name, dialog, navigate, has_action) {
	// Dialog-Actions sammeln erst Nutzereingaben. Consumer-Apps koennen einen Custom-Dialog
	// unter window.process_engine.action_dialogs registrieren; sonst generischer Server-Dialog
	// (handler.action_dialog_fields). create_linked laeuft ueber denselben generischen Pfad.
	if (dialog) {
		const reg = window.process_engine && window.process_engine.action_dialogs;
		const custom = reg && reg.get(dialog);
		if (custom) {
			return custom({
				frm,
				row_name,
				action_key,
				dialog,
				navigate,
				// Helfer fuer Custom-Dialoge: Action ausfuehren, neu laden, optional navigieren.
				run: async (payload) => {
					try {
						const r = await _pe_call_run_task_action(frm, action_key, row_name, payload);
						await frm.reload_doc();
						if (navigate) _pe_navigate(navigate);
						return r;
					} catch (err) {
						_pe_action_error(err);
						throw err;
					}
				},
			});
		}
		return _open_generic_action_dialog(frm, action_key, row_name, navigate);
	}
	// Reine Navigations-Action (kein Dispatch-Ziel) -> nur navigieren, kein Server-Call.
	if (!has_action && navigate) {
		return _pe_navigate(navigate);
	}
	// Standard: Client schickt nur den semantischen key — Server mappt ihn (Allowlist) auf die
	// Dispatch-Action und prueft die Gates erneut. Danach reload + optionale Navigation.
	try {
		await _pe_call_run_task_action(frm, action_key, row_name, null);
		await frm.reload_doc();
		if (navigate) _pe_navigate(navigate);
	} catch (err) {
		_pe_action_error(err);
	}
}

// Low-level run_task_action-Aufruf. Wirft bei Fehler (Aufrufer entscheidet ueber UX).
async function _pe_call_run_task_action(frm, action_key, row_name, payload) {
	const args = { docname: frm.doc.name, row_name, action_key };
	if (payload) args.payload_json = JSON.stringify(payload);
	return frappe.call({
		method: "process_engine.process_engine.doctype.prozess_instanz.prozess_instanz.run_task_action",
		args,
		freeze: true,
	});
}

function _pe_action_error(err) {
	const msg =
		(err && err.message) ||
		(frappe.last_response && frappe.last_response._server_messages) ||
		String(err);
	frappe.msgprint({ title: __("Aktion fehlgeschlagen"), message: msg, indicator: "red" });
}

// Phase D: Navigation. Allowlist spiegelt _ALLOWED_NAVIGATE_KINDS serverseitig — der Server
// liefert nur validierte Descriptoren, der Client kennt nur diese drei Arten.
function _pe_navigate(nav) {
	if (!nav || !nav.kind) return;
	const t = nav.target;
	if (nav.kind === "route" && Array.isArray(t)) frappe.set_route.apply(frappe, t);
	else if (nav.kind === "form" && t && t.doctype && t.name) frappe.set_route("Form", t.doctype, t.name);
	else if (nav.kind === "url" && typeof t === "string") window.open(t, "_blank");
}

// ==================== Phase C: Generischer Laufzeit-Dialog ====================
// Felder kommen vom Server (handler.action_dialog_fields). Leeres fields -> kein Dialog
// noetig, Action direkt ausfuehren. Submit -> run_task_action({user_values: <werte>}); der
// Handler liest die Werte aus payload["user_values"]. Loest create_linked + Consumer-Dialoge.
async function _open_generic_action_dialog(frm, action_key, row_name, navigate) {
	let spec = {};
	try {
		const r = await frappe.call({
			method: "process_engine.process_engine.doctype.prozess_instanz.prozess_instanz.get_task_action_dialog",
			args: { docname: frm.doc.name, row_name, action_key },
		});
		spec = r.message || {};
	} catch (err) {
		frappe.msgprint({
			title: __("Dialog konnte nicht geoeffnet werden"),
			message: (err && err.message) || String(err),
			indicator: "red",
		});
		return;
	}
	const fields = spec.fields || [];
	if (!fields.length) {
		// Kein Dialog noetig -> direkt ausfuehren (mit optionaler Navigation danach).
		try {
			await _pe_call_run_task_action(frm, action_key, row_name, null);
			await frm.reload_doc();
			if (navigate) _pe_navigate(navigate);
		} catch (err) {
			_pe_action_error(err);
		}
		return;
	}
	const dialog = new frappe.ui.Dialog({
		title: spec.title || __("Aktion"),
		fields,
		primary_action_label: spec.primary_label || __("OK"),
		primary_action: async (values) => {
			try {
				const r = await _pe_call_run_task_action(frm, action_key, row_name, { user_values: values });
				dialog.hide();
				// dispatch_local wickelt das Handler-Result in {ok, status, ..., meta: {...}}.
				const meta = (r.message && r.message.meta) || {};
				if (meta.created_name) {
					frappe.show_alert({ message: __("Angelegt: {0}", [meta.created_name]), indicator: "green" });
				}
				await frm.reload_doc();
				if (navigate) _pe_navigate(navigate);
			} catch (err) {
				_pe_action_error(err);
			}
		},
	});
	dialog.show();
}

// ==================== Phase E: Custom Task-Views ====================
// Pro Aufgabe kann der Handler (task_view) eine Custom-Client-Component deklarieren. Diese
// wird in den .pe-task-view-slot der jeweiligen Task-Zeile gemountet. `component` wird in
// window.process_engine.task_views aufgeloest; ein optionales `bundle` wird vorher lazy via
// frappe.require geladen (so kann eine Consumer-App ihren Component-Code mitliefern, ohne ihn
// global einzubinden). Es wird NIE Code aus dem Server-Descriptor ausgefuehrt.
async function _render_task_views(frm) {
	if (frm.is_new()) return;
	const reg = window.process_engine && window.process_engine.task_views;
	const field = frm.get_field("task_actions_html");
	if (!reg || !field) return;
	// Lifecycle: vor jedem (Re-)Mount die Cleanups der vorigen Runde ausfuehren, damit
	// Components Timer/globale Handler abraeumen koennen und nichts doppelt haengt.
	_pe_run_task_view_cleanups(frm);
	let views = {};
	try {
		const r = await frappe.call({
			method: "process_engine.process_engine.doctype.prozess_instanz.prozess_instanz.get_task_views",
			args: { docname: frm.doc.name },
		});
		views = r.message || {};
	} catch (err) {
		console.error("[process_engine] get_task_views failed", err);
		return;
	}
	for (const row of frm.doc.aufgaben || []) {
		const view = views[row.name];
		if (!view || !view.component) continue;
		const slot = field.$wrapper
			.find(`.task-row[data-row-name="${row.name}"] .pe-task-view-slot`)
			.get(0);
		if (!slot) continue;
		_pe_mount_task_view(frm, row, view, slot, reg);
	}
}

function _pe_run_task_view_cleanups(frm) {
	const list = frm.__pe_task_view_cleanups || [];
	for (const fn of list) {
		try {
			fn();
		} catch (e) {
			console.error("[process_engine] task_view cleanup failed", e);
		}
	}
	frm.__pe_task_view_cleanups = [];
}

// Sicherheits-Boundary: nur lokale App-Assets als Bundle zulassen, keine externen URLs.
// (Server sanitisiert ebenfalls in get_task_views — defense in depth.)
function _pe_is_safe_bundle(url) {
	return typeof url === "string" && url.indexOf("/assets/") === 0;
}

function _pe_mount_task_view(frm, row, view, slot, reg) {
	const mount = (fn) => {
		try {
			const cleanup = fn({
				frm,
				row,
				config: view.props || {},
				container: slot,
				refresh: () => frm.reload_doc(),
				// Generischer Action-Runner fuer die Component (gleiche Server-Boundary).
				runAction: async (action_key, payload) => {
					try {
						const r = await _pe_call_run_task_action(frm, action_key, row.name, payload || null);
						await frm.reload_doc();
						return r;
					} catch (err) {
						_pe_action_error(err);
						throw err;
					}
				},
			});
			// Lifecycle-Contract: mount(ctx) darf eine Cleanup-Funktion zurueckgeben.
			if (typeof cleanup === "function") {
				frm.__pe_task_view_cleanups = frm.__pe_task_view_cleanups || [];
				frm.__pe_task_view_cleanups.push(cleanup);
			}
		} catch (e) {
			console.error("[process_engine] task_view mount failed:", view.component, e);
			$(slot).html(
				`<span class="text-danger">${__("Task-View-Fehler: ")}${frappe.utils.escape_html(view.component)}</span>`
			);
		}
	};
	const comp = reg.get(view.component);
	if (comp) {
		mount(comp);
		return;
	}
	// Bundle nur laden, wenn es ein lokales App-Asset ist.
	if (view.bundle && _pe_is_safe_bundle(view.bundle)) {
		frappe.require(view.bundle, () => {
			const c2 = reg.get(view.component);
			if (c2) {
				mount(c2);
			} else {
				console.warn(
					`[process_engine] task_view '${view.component}' nicht registriert (Bundle ${view.bundle} geladen). Tippfehler oder Registrierung fehlt?`
				);
				$(slot).html(
					`<span class="text-muted">${__("Task-View nicht gefunden: ")}${frappe.utils.escape_html(view.component)}</span>`
				);
			}
		});
		return;
	}
	if (view.bundle) {
		console.warn(`[process_engine] task_view-Bundle abgelehnt (nur /assets/... erlaubt): ${view.bundle}`);
	}
	console.warn(`[process_engine] task_view '${view.component}' nicht registriert und kein gueltiges Bundle.`);
	$(slot).html(
		`<span class="text-muted">${__("Task-View nicht registriert: ")}${frappe.utils.escape_html(view.component)}</span>`
	);
}

// ==================== Phase 6: Progress-Graph (Mermaid) ====================

function _render_progress_graph(frm) {
	const field = frm.get_field("progress_html");
	if (!field) return;
	const rows = frm.doc.aufgaben || [];
	if (!rows.length) {
		field.$wrapper.html(`<p class="text-muted">${__("Keine Aufgaben.")}</p>`);
		return;
	}
	const nodes = rows
		.map((r) => ({
			step_key: (r.step_key || "").trim(),
			titel: r.aufgabe || r.step_key,
			pflicht: !!r.pflicht,
		}))
		.filter((n) => n.step_key);
	const edges = [];
	for (const r of rows) {
		const sk = (r.step_key || "").trim();
		let deps = [];
		try {
			deps = JSON.parse(r.depends_on_json || "[]");
		} catch (e) {
			deps = [];
		}
		for (const d of deps || []) {
			const dep = (d || "").trim();
			if (sk && dep) edges.push({ from: dep, to: sk });
		}
	}
	const status_by_step = {};
	for (const r of rows) {
		const sk = (r.step_key || "").trim();
		if (!sk) continue;
		const status = (r.status || "").trim();
		if (status === "Erledigt") status_by_step[sk] = "done";
		else if (r.pflicht && !_is_task_unlocked_client(frm, r)) status_by_step[sk] = "locked";
		else if (status === "In Arbeit") status_by_step[sk] = "wip";
		else status_by_step[sk] = "open";
	}

	const legend = `<div class="text-muted" style="margin-top:6px; font-size:0.85em;">
		<span style="display:inline-block;width:10px;height:10px;background:#17a2b8;margin-right:4px;vertical-align:middle;"></span>${__("Offen")}
		<span style="display:inline-block;width:10px;height:10px;background:#ffc107;margin:0 4px 0 12px;vertical-align:middle;"></span>${__("In Arbeit")}
		<span style="display:inline-block;width:10px;height:10px;background:#28a745;margin:0 4px 0 12px;vertical-align:middle;"></span>${__("Erledigt")}
		<span style="display:inline-block;width:10px;height:10px;background:#adb5bd;margin:0 4px 0 12px;vertical-align:middle;"></span>${__("Vorgaenger offen")}
	</div>`;

	field.$wrapper.html(
		`<div class="progress-graph-container" style="margin-top:8px;"></div>${legend}`
	);

	frappe.require("/assets/process_engine/js/dag_mermaid.js", () => {
		const container = field.$wrapper.find(".progress-graph-container").get(0);
		if (!container) return;
		window.process_engine.dag.renderDag({
			container,
			nodes,
			edges,
			status_by_step,
			on_click: (stepKey) => _on_graph_node_click(frm, stepKey),
		});
	});
}

function _on_graph_node_click(frm, step_key) {
	// Bei create_linked_doc-Tasks (offen + freigegeben) direkt den Anlege-Dialog.
	// Sonst nur scroll zur Row in der Aufgaben-Tabelle.
	const row = (frm.doc.aufgaben || []).find(
		(r) => (r.step_key || "").trim() === step_key
	);
	if (!row) return;
	const status = (row.status || "").trim();
	const locked = row.pflicht && !_is_task_unlocked_client(frm, row);
	if ((row.task_type || "") === "create_linked_doc" && status !== "Erledigt" && !locked) {
		_open_generic_action_dialog(frm, "create_linked", row.name, null);
		return;
	}
	_scroll_to_task_row(frm, step_key);
}

function _scroll_to_task_row(frm, step_key) {
	const fld = frm.get_field("aufgaben");
	if (!fld || !fld.grid) return;
	const grid = fld.grid;
	const row = (frm.doc.aufgaben || []).find((r) => (r.step_key || "").trim() === step_key);
	if (!row) return;
	try {
		grid.toggle_view(row.name, true);
	} catch (e) {
		// Falls Grid noch nicht initialisiert: Scroll-only-Fallback
	}
	const $row = grid.$wrapper.find(`[data-name="${row.name}"]`);
	if ($row.length) {
		$row[0].scrollIntoView({ behavior: "smooth", block: "center" });
	}
}
