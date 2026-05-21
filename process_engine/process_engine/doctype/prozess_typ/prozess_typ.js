// Phase 8.1: Versionen-Uebersicht auf Prozess Typ.
//
// Rendert eine Tabelle aller Prozess Versionen, die diesen Typ referenzieren.
// Klick auf Zeile → Version oeffnen. Mit Button "Neue Version anlegen".

frappe.ui.form.on("Prozess Typ", {
	async refresh(frm) {
		if (frm.is_new()) {
			frm.get_field("versions_html").$wrapper.html(
				`<p class="text-muted">${__("Erst speichern, dann erscheinen die Versionen.")}</p>`
			);
			return;
		}
		await _render_versions_table(frm);
	},
});


// Phase 3b: Komfort-Editor fuer das deklarative Trigger-Input-Mapping.
// Pro Payload-Feld (aus der aktiven Version) waehlt man die Quelle: Pfad vom
// Quell-Objekt (path_resolver/get_path_options), fester Wert, oder manuell.
// Speichert nach input_mapping_json; der Raw-JSON-Code-Editor bleibt als Escape-Hatch.
frappe.ui.form.on("Prozess Trigger Definition", {
	edit_input_mapping(frm, cdt, cdn) {
		_open_trigger_mapping_dialog(frm, locals[cdt][cdn]);
	},
});

function _open_trigger_mapping_dialog(frm, row) {
	const source = (row.source_doctype || "").trim();
	if (!source) {
		frappe.msgprint(__("Bitte zuerst den Quell-Doctype der Trigger-Zeile setzen."));
		return;
	}
	Promise.all([
		frappe.call({
			method: "process_engine.process_engine.processes.triggers.get_payload_field_specs",
			args: { prozess_typ: frm.doc.name },
		}),
		frappe.call({
			method: "process_engine.process_engine.processes.path_resolver.get_path_options",
			args: { doctype: source },
		}),
	]).then(([pfRes, poRes]) => {
		const payloadFields = pfRes.message || [];
		const pathOpts = (poRes.message && poRes.message.fields) || [];
		if (!payloadFields.length) {
			frappe.msgprint(
				__("Keine Payload-Felder gefunden. Lege zuerst eine aktive Prozess-Version mit Payload-Feldern an.")
			);
			return;
		}
		let current = {};
		try {
			current = JSON.parse(row.input_mapping_json || "{}") || {};
		} catch (e) {
			current = {};
		}

		const pathOptionsHtml = (selected) =>
			['<option value="">— Feld wählen —</option>']
				.concat(
					pathOpts.map((f) => {
						const tags =
							f.fieldtype + (f.is_link ? ` → ${f.options}` : "") + (f.is_virtual ? " · virtuell" : "");
						const sel = selected === f.fieldname ? " selected" : "";
						return `<option value="${frappe.utils.escape_html(f.fieldname)}"${sel}>${frappe.utils.escape_html(
							f.fieldname
						)} (${frappe.utils.escape_html(tags)})</option>`;
					})
				)
				.join("");

		const valueCell = (kind, spec) => {
			if (kind === "path") {
				// Mehrteilige Pfade (Drilldown) bleiben via Freitext editierbar; das Select
				// deckt die Top-Level-Felder ab (haeufigster Fall, z.B. aktueller_mietvertrag).
				const known = pathOpts.some((f) => f.fieldname === (spec.path || ""));
				const sel = `<select class="form-control input-xs tm-path-sel">${pathOptionsHtml(
					known ? spec.path : ""
				)}</select>`;
				const txt = `<input type="text" class="form-control input-xs tm-path-txt" placeholder="oder Pfad (z.B. wohnung.immobilie)" value="${frappe.utils.escape_html(
					spec.path || ""
				)}" style="margin-top:3px;">`;
				return sel + txt;
			}
			if (kind === "fixed") {
				return `<input type="text" class="form-control input-xs tm-fixed" value="${frappe.utils.escape_html(
					spec.value != null ? String(spec.value) : ""
				)}">`;
			}
			return '<span class="text-muted">—</span>';
		};

		const kindSelect = (kind) =>
			`<select class="form-control input-xs tm-kind">
				<option value=""${kind === "" ? " selected" : ""}>—</option>
				<option value="path"${kind === "path" ? " selected" : ""}>${__("Pfad vom Objekt")}</option>
				<option value="fixed"${kind === "fixed" ? " selected" : ""}>${__("Fester Wert")}</option>
				<option value="manual"${kind === "manual" ? " selected" : ""}>${__("Manuell (User)")}</option>
			</select>`;

		const rowsHtml = payloadFields
			.map((pf) => {
				const spec = current[pf.fieldname] || {};
				const kind = (spec.kind || "").trim();
				return `<tr data-field="${frappe.utils.escape_html(pf.fieldname)}">
					<td><div>${frappe.utils.escape_html(pf.label || pf.fieldname)}</div>
						<code style="font-size:0.85em;">${frappe.utils.escape_html(pf.fieldname)}</code>
						<span class="text-muted"> ${frappe.utils.escape_html(pf.fieldtype)}</span></td>
					<td style="width:150px;">${kindSelect(kind)}</td>
					<td class="tm-val" style="width:240px;">${valueCell(kind, spec)}</td>
				</tr>`;
			})
			.join("");

		const d = new frappe.ui.Dialog({
			title: __("Input-Mapping: {0} → {1}", [source, frm.doc.name]),
			size: "large",
			fields: [
				{
					fieldname: "tbl",
					fieldtype: "HTML",
					options: `
						<table class="table table-bordered" style="font-size:0.9em;">
							<thead><tr>
								<th>${__("Payload-Feld")}</th><th>${__("Quelle")}</th><th>${__("Wert / Pfad")}</th>
							</tr></thead>
							<tbody class="tm-body">${rowsHtml}</tbody>
						</table>
						<p class="text-muted"><small>${__(
							"Pfad: Wert kommt aus dem Quell-Objekt (z.B. aktueller_mietvertrag, auch verkettet wie wohnung.immobilie). Manuell/leer: Feld bleibt offen und wird beim Start ausgefüllt."
						)}</small></p>
					`,
				},
			],
			primary_action_label: __("Übernehmen"),
			primary_action() {
				const $body = d.fields_dict.tbl.$wrapper;
				const mapping = {};
				$body.find("tr[data-field]").each(function () {
					const $tr = $(this);
					const field = $tr.attr("data-field");
					const kind = $tr.find(".tm-kind").val();
					if (kind === "path") {
						const p =
							($tr.find(".tm-path-txt").val() || "").trim() ||
							($tr.find(".tm-path-sel").val() || "").trim();
						if (p) mapping[field] = { kind: "path", path: p };
					} else if (kind === "fixed") {
						mapping[field] = { kind: "fixed", value: $tr.find(".tm-fixed").val() };
					} else if (kind === "manual") {
						mapping[field] = { kind: "manual" };
					}
				});
				frappe.model.set_value(
					row.doctype,
					row.name,
					"input_mapping_json",
					Object.keys(mapping).length ? JSON.stringify(mapping, null, 2) : ""
				);
				frm.dirty();
				d.hide();
				frappe.show_alert({ message: __("Input-Mapping aktualisiert"), indicator: "green" }, 3);
			},
		});
		d.show();

		// Quelle-Wechsel → Wert-Zelle neu rendern.
		d.fields_dict.tbl.$wrapper.on("change", ".tm-kind", function () {
			const $tr = $(this).closest("tr");
			$tr.find(".tm-val").html(valueCell($(this).val(), {}));
		});
	});
}


async function _render_versions_table(frm) {
	const field = frm.get_field("versions_html");
	if (!field) return;
	let versions = [];
	try {
		const r = await frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "Prozess Version",
				filters: { prozess_typ: frm.doc.name },
				fields: ["name", "version_key", "titel", "is_active", "gueltig_ab", "gueltig_bis", "modified"],
				order_by: "is_active desc, modified desc",
				limit_page_length: 0,
			},
		});
		versions = r.message || [];
	} catch (err) {
		console.error("prozess_typ: versions fetch failed", err);
		field.$wrapper.html(
			`<p class="text-danger">${__("Versionen konnten nicht geladen werden.")}</p>`
		);
		return;
	}

	const new_version_btn = `
		<button class="btn btn-xs btn-default" data-action="new-version" style="margin-bottom:8px;">
			${frappe.utils.icon("add", "xs")} ${__("Neue Version anlegen")}
		</button>
	`;

	if (!versions.length) {
		field.$wrapper.html(`
			${new_version_btn}
			<p class="text-muted">${__("Keine Versionen vorhanden.")}</p>
		`);
		_wire_actions(frm);
		return;
	}

	const rows = versions
		.map((v) => {
			const active_badge = v.is_active
				? `<span class="indicator-pill green">${__("Aktiv")}</span>`
				: `<span class="indicator-pill gray">${__("Inaktiv")}</span>`;
			const gueltig = (v.gueltig_ab || v.gueltig_bis)
				? `${v.gueltig_ab || "—"} → ${v.gueltig_bis || "—"}`
				: "—";
			return `
				<tr data-name="${frappe.utils.escape_html(v.name)}" style="cursor:pointer;">
					<td><code>${frappe.utils.escape_html(v.version_key || v.name)}</code></td>
					<td>${frappe.utils.escape_html(v.titel || "")}</td>
					<td>${active_badge}</td>
					<td class="text-muted">${gueltig}</td>
					<td class="text-muted">${frappe.datetime.comment_when(v.modified)}</td>
				</tr>
			`;
		})
		.join("");

	field.$wrapper.html(`
		${new_version_btn}
		<table class="table table-condensed table-bordered" style="margin-top:0;">
			<thead>
				<tr>
					<th>${__("Version Key")}</th>
					<th>${__("Titel")}</th>
					<th>${__("Status")}</th>
					<th>${__("Gueltig")}</th>
					<th>${__("Geaendert")}</th>
				</tr>
			</thead>
			<tbody>${rows}</tbody>
		</table>
	`);
	_wire_actions(frm);
}


function _wire_actions(frm) {
	const field = frm.get_field("versions_html");
	if (!field) return;
	field.$wrapper.off("click.hv_versions");
	field.$wrapper.on("click.hv_versions", "tr[data-name]", (e) => {
		const name = $(e.currentTarget).data("name");
		if (name) frappe.set_route("Form", "Prozess Version", String(name));
	});
	field.$wrapper.on("click.hv_versions", '[data-action="new-version"]', (e) => {
		e.preventDefault();
		frappe.new_doc("Prozess Version", {
			prozess_typ: frm.doc.name,
			runtime_doctype: "Prozess Instanz",
		});
	});
}
