// Prozess Instanz — Sachbearbeiter-Ansicht via React-Bundle (process_instance_react).
//
// Ersetzt die fruehere JS-UI (Payload-Form, Task-Action-Panel, Mermaid-Graph): rendert
// stattdessen den gebuendelten Instance-Viewer auf dem progress_html-Feld.
//
// READ-Pfad:  aufgaben (Child-Table) -> statusMap, payload_json -> payload, Prozess Version
//             (schritte/schritt_io/payload_field_specs) -> version.
// WRITE-Pfad: onCompleteStep(stepKey, data) -> get_task_runtime_actions liefert die echten
//             Handler-Deskriptoren; wir loesen die PRIMAERE Aktion der Aufgabe via
//             run_task_action aus (= derselbe Server-Pfad wie der frühere Primaer-Button)
//             und reload_doc'en -> refresh() re-mountet mit kanonischem State.

// Top-level mit var statt const: Frappe evaluiert das Doctype-Controller-Skript ggf.
// mehrfach im selben Scope (ScriptManager.setup) — Top-Level-const wuerfe dann
// "already declared". var (wie function-Deklarationen) ist redeklarations-tolerant.
var PE_INSTANCE_BUNDLE = "/assets/process_engine/js/process_instance_react.bundle.js";
var PE_INSTANCE_CSS = "/assets/process_engine/css/process_instance_react.css";
var PE_RUN_ACTION =
	"process_engine.process_engine.doctype.prozess_instanz.prozess_instanz.run_task_action";
var PE_GET_ACTIONS =
	"process_engine.process_engine.doctype.prozess_instanz.prozess_instanz.get_task_runtime_actions";

// Legacy-HTML-Felder + Roh-Tabellen, die der Viewer ersetzt -> ausblenden.
var PE_HIDDEN_FIELDS = [
	"payload_json",
	"payload_form_html",
	"task_actions_html",
	"blocker_hinweise_html",
	"aufgaben",
	"section_payload",
	"section_aufgaben",
];

frappe.ui.form.on("Prozess Instanz", {
	async refresh(frm) {
		for (const f of PE_HIDDEN_FIELDS) frm.set_df_property(f, "hidden", 1);
		_pe_add_raw_json_toggle(frm);
		if (frm.is_new() || !frm.doc.prozess_version) {
			const field = frm.get_field("progress_html");
			if (field) {
				field.$wrapper.html(
					`<p class="text-muted">${__("Noch keine Prozess Version zugeordnet.")}</p>`
				);
			}
			return;
		}
		await _pe_render_instance_view(frm);
	},

	prozess_version(frm) {
		if (!frm.is_new() && frm.doc.prozess_version) _pe_render_instance_view(frm);
	},
});

async function _pe_render_instance_view(frm) {
	const field = frm.get_field("progress_html");
	if (!field) return;

	await new Promise((r) => frappe.require(PE_INSTANCE_BUNDLE, r));
	await _pe_load_css_once(PE_INSTANCE_CSS);

	field.$wrapper.empty();
	const container = document.createElement("div");
	container.style.cssText =
		"position:relative;height:840px;border:1px solid var(--border-color);border-radius:8px;overflow:hidden;";
	field.$wrapper.append(container);

	// Version (eine pro Instanz) + Action-Deskriptoren parallel laden.
	const [version, actionsByRow] = await Promise.all([
		frappe.db.get_doc("Prozess Version", frm.doc.prozess_version),
		_pe_get_actions(frm),
	]);

	let payload = {};
	try {
		payload = JSON.parse(frm.doc.payload_json || "{}") || {};
	} catch (e) {
		payload = {};
	}

	// statusMap + step_key -> aufgaben-Row.
	const rowByStep = {};
	const statusMap = {};
	for (const row of frm.doc.aufgaben || []) {
		const sk = (row.step_key || "").trim();
		if (!sk) continue;
		rowByStep[sk] = row;
		statusMap[sk] = {
			status: _pe_status_token(frm, row),
			faelligkeit_am: row.faellig_am || null,
			erledigt_am: row.erfuellt_am || null,
			kommentar: "",
			verantwortlich: row.verantwortlich
				? { name: row.verantwortlich, rolle: "", initials: _pe_initials(row.verantwortlich) }
				: null,
		};
	}
	// Schritte ohne Aufgaben-Row -> als wartend zeigen, statt unsichtbar.
	for (const s of version.schritte || []) {
		const sk = (s.step_key || "").trim();
		if (sk && !statusMap[sk]) statusMap[sk] = { status: "pending" };
	}

	window.ProcessInstanceReact.mount(container, {
		version: {
			version_key: version.version_key,
			titel: version.titel,
			prozess_typ: version.prozess_typ,
			schritte: version.schritte || [],
			schritt_io: version.schritt_io || [],
			payload_field_specs: version.payload_field_specs || [],
		},
		instance: {
			name: frm.doc.name,
			status: frm.doc.status || "laufend",
			prozess_typ: frm.doc.prozess_typ,
			subject: { label: frm.doc.title || frm.doc.name, name: frm.doc.name },
			events: [],
		},
		statusMap,
		payload,
		density: "comfortable",
		layout: "split",

		helpers: {
			frm,
			getMeta(doctype) {
				return frappe.get_meta(doctype) || { fields: [] };
			},
			async fetchMeta(doctype) {
				await frappe.model.with_doctype(doctype);
				return frappe.get_meta(doctype) || { fields: [] };
			},
			mailTemplates: (window.process_engine && window.process_engine.mail_templates) || {},
		},

		onOpenVersion() {
			frappe.set_route("Form", "Prozess Version", frm.doc.prozess_version);
		},

		async onCompleteStep(stepKey, data) {
			const row = rowByStep[stepKey];
			if (!row) {
				frappe.show_alert({ message: __("Keine Aufgabe für {0}", [stepKey]), indicator: "red" });
				return null;
			}
			const descriptors = actionsByRow[row.name] || [];
			// Primaere, freigegebene, ausfuehrbare Aktion = die "Erledigen"-Aktion des Handlers.
			const desc =
				descriptors.find((d) => d.primary && !d.disabled && d.has_action) ||
				descriptors.find((d) => !d.disabled && d.has_action);
			if (!desc) {
				const blocked = descriptors.find((d) => d.disabled && d.reason);
				frappe.show_alert({
					message: blocked ? blocked.reason : __("Keine ausführbare Aktion für diese Aufgabe."),
					indicator: "orange",
				});
				return null;
			}

			try {
				// file_upload: Datei an die Instanz anhaengen + URL ins payload_output-Feld
				// schreiben, BEVOR der Schritt erledigt wird (das Widget liefert ein File-Objekt).
				if (row.task_type === "file_upload" && data && data.file instanceof File) {
					await _pe_handle_file_upload(frm, version, stepKey, data.file);
				}

				const userValues = _pe_user_values(row.task_type, data);
				const payloadJson = userValues ? JSON.stringify({ user_values: userValues }) : null;
				await frappe.call({
					method: PE_RUN_ACTION,
					args: { docname: frm.doc.name, row_name: row.name, action_key: desc.key, payload_json: payloadJson },
				});
				await frm.reload_doc(); // refresh() re-mountet mit kanonischem Server-State
			} catch (err) {
				frappe.show_alert({
					message: (err && err.message) || __("Aktion fehlgeschlagen."),
					indicator: "red",
				});
				// Optimistischen Shell-Zustand verwerfen -> echten Server-State re-mounten,
				// sonst zeigt die UI faelschlich "erledigt" obwohl der Call fehlschlug.
				try {
					await frm.reload_doc();
				} catch (e) {
					/* noop */
				}
			}
			return null;
		},
	});
}

// ---- Status: DE-Aufgaben-Status -> Viewer-Tokens -------------------------------

function _pe_status_token(frm, row) {
	if (row.erfuellt || (row.status || "") === "Erledigt") return "done";
	if ((row.status || "") === "In Arbeit") return "in_progress";
	// Offen: freigeschaltet (direkte Vorgaenger erfuellt) -> ready, sonst wartend.
	return _pe_task_unlocked(frm, row) ? "ready" : "pending";
}

// UX-Approximation (direkte deps); Server entscheidet transitiv. Genuegt fuers Token.
function _pe_task_unlocked(frm, row) {
	let deps = [];
	try {
		deps = JSON.parse(row.depends_on_json || "[]");
	} catch (e) {
		deps = [];
	}
	if (!Array.isArray(deps) || !deps.length) return true;
	const byStep = {};
	for (const r of frm.doc.aufgaben || []) {
		const k = (r.step_key || "").trim();
		if (k) byStep[k] = r;
	}
	return deps.every((d) => {
		const p = byStep[(d || "").trim()];
		return !p || p.erfuellt;
	});
}

// ---- file_upload: Datei anhaengen + Payload-Feld setzen ------------------------

async function _pe_handle_file_upload(frm, version, stepKey, file) {
	const step = (version.schritte || []).find((s) => s.step_key === stepKey);
	let cfg = {};
	try {
		cfg = JSON.parse((step && step.konfig_json) || "{}") || {};
	} catch (e) {
		cfg = {};
	}
	if (cfg.max_size_mb && file.size > cfg.max_size_mb * 1024 * 1024) {
		throw new Error(__("Datei zu groß (max {0} MB).", [cfg.max_size_mb]));
	}

	const uploaded = await _pe_upload_file(file, frm.doc.name);
	const fileUrl = uploaded && (uploaded.file_url || uploaded.file_name);
	if (!fileUrl) throw new Error(__("Upload lieferte keine Datei-URL."));

	// URL ins payload_output-Feld des Schritts schreiben (= das Feld, das dieser Schritt
	// produziert). Direkt via set_value -> Server-Save, ohne mitten im Flow neu zu mounten.
	const outRow = (version.schritt_io || []).find(
		(r) => r.step_key === stepKey && r.kind === "payload_output"
	);
	if (outRow && outRow.target) {
		let pj = {};
		try {
			pj = JSON.parse(frm.doc.payload_json || "{}") || {};
		} catch (e) {
			pj = {};
		}
		pj[outRow.target] = fileUrl;
		await frappe.db.set_value("Prozess Instanz", frm.doc.name, "payload_json", JSON.stringify(pj));
	}
	return fileUrl;
}

// Laedt ein File-Objekt via Frappes upload_file-Endpoint hoch und haengt es an die
// Prozess Instanz an (erscheint in den Anhaengen). FormData -> kein frappe.call.
async function _pe_upload_file(file, docname) {
	const fd = new FormData();
	fd.append("file", file, file.name);
	fd.append("is_private", "1");
	fd.append("folder", "Home");
	fd.append("doctype", "Prozess Instanz");
	fd.append("docname", docname);
	const res = await fetch("/api/method/upload_file", {
		method: "POST",
		headers: { "X-Frappe-CSRF-Token": frappe.csrf_token },
		body: fd,
	});
	if (!res.ok) {
		let msg = "HTTP " + res.status;
		try {
			const j = await res.json();
			msg = (j._server_messages && JSON.parse(j._server_messages).join(" ")) || j.message || msg;
		} catch (e) {
			/* keep msg */
		}
		throw new Error(__("Upload fehlgeschlagen: {0}", [msg]));
	}
	const json = await res.json();
	return json.message;
}

// ---- Widget-Daten -> run_task_action user_values -------------------------------

function _pe_user_values(taskType, data) {
	if (!data) return null;
	switch (taskType) {
		case "create_linked_doc":
			return data.created || {};
		case "email_draft":
			return { subject: data.subject, body: data.body };
		case "manual_check":
			return data.outputs || null;
		case "print_document":
			return { print_format: data.print_format, copies: data.copies };
		default:
			return null;
	}
}

// ---- Helpers -------------------------------------------------------------------

function _pe_get_actions(frm) {
	return frappe
		.call({ method: PE_GET_ACTIONS, args: { docname: frm.doc.name } })
		.then((r) => r.message || {})
		.catch((err) => {
			console.error("get_task_runtime_actions failed", err);
			return {};
		});
}

function _pe_initials(name) {
	return (name || "?")
		.split(/[ @._-]/)
		.map((p) => p[0])
		.filter(Boolean)
		.slice(0, 2)
		.join("")
		.toUpperCase();
}

function _pe_add_raw_json_toggle(frm) {
	frm.add_custom_button(
		__("Raw JSON anzeigen"),
		() => {
			frm.set_df_property("payload_json", "hidden", 0);
			frm.refresh_field("payload_json");
		},
		__("Power-User")
	);
}

async function _pe_load_css_once(href) {
	if (document.querySelector(`link[href="${href}"]`)) return;
	return new Promise((resolve) => {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		link.onload = resolve;
		link.onerror = resolve;
		document.head.appendChild(link);
	});
}
