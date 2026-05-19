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
