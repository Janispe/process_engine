// Custom Config-Widget: Pfad-Picker für den Derive-Node.
//
// Registriert ein Widget "path_picker" auf window.process_engine.config_widgets.
// Der React-Editor ruft es auf, wenn ein Schritt-Handler in config_schema() ein Feld
// mit "widget": "path_picker" deklariert (siehe DeriveTaskHandler).
//
// Funktion: ausgehend vom Quell-Doctype (abgeleitet aus dem Payload-Feld in cfg.source_field,
// das ein Link-Feld sein muss) zeigt es alle wählbaren Felder via get_path_options an.
// Link-Felder lassen sich "tiefer" aufklappen (verketteter Pfad, z.B. wohnung.immobilie),
// virtuelle Felder (z.B. aktueller_mietvertrag) sind markiert. Auswahl committet sowohl
// `path` als auch `source_doctype` in die Konfig (atomar via commitMany).
//
// Ladereihenfolge via hooks.py: nach pe_registry.js.

(function () {
	if (!window.process_engine) window.process_engine = {};
	if (!window.process_engine.config_widgets) {
		window.process_engine.config_widgets = new Map();
	}
	if (typeof window.process_engine.register_config_widget !== "function") {
		window.process_engine.register_config_widget = function (name, fn) {
			window.process_engine.config_widgets.set(name, fn);
		};
	}

	const GET_OPTS = "process_engine.process_engine.processes.path_resolver.get_path_options";

	// Quell-Doctype aus dem Payload-Feld (cfg.source_field) ermitteln: dessen Feld-Spec
	// muss ein Link sein, options = Ziel-Doctype.
	function _sourceDoctype(frm, sourceField) {
		const specs = (frm && frm.doc && frm.doc.payload_field_specs) || [];
		const spec = specs.find((s) => (s.fieldname || "").trim() === (sourceField || "").trim());
		if (!spec) return { doctype: "", reason: "Quell-Feld nicht in den Payload-Feldern gefunden." };
		if ((spec.fieldtype || "") !== "Link" || !(spec.options || "").trim()) {
			return { doctype: "", reason: `Quell-Feld '${sourceField}' ist kein Link-Feld (kein Ziel-Doctype).` };
		}
		return { doctype: (spec.options || "").trim(), reason: "" };
	}

	function _renderPathPicker(ctx) {
		const { frm, def, container, readOnly } = ctx;
		const $box = $('<div class="ppk-widget"></div>').appendTo(container);

		// prefix = bereits gewählte Link-Segmente, in die "hineingedrillt" wurde.
		let prefix = [];

		function rebuild() {
			$box.empty();
			const cfg = ctx.cfg || {};
			const sourceField = (cfg.source_field || "").trim();
			if (!sourceField) {
				$box.append('<div class="ppk-hint">Bitte zuerst die <b>Quelle (Payload-Feld)</b> wählen.</div>');
				_addReload();
				return;
			}
			const src = _sourceDoctype(frm, sourceField);
			if (!src.doctype) {
				$box.append(`<div class="ppk-hint ppk-warn">${frappe.utils.escape_html(src.reason)}</div>`);
				_addReload();
				return;
			}

			// Kopf: Quelle + aktueller Pfad
			const pathStr = (cfg.path || "").trim();
			$box.append(
				`<div class="ppk-head">Quelle: <code>${frappe.utils.escape_html(src.doctype)}</code>` +
				(pathStr ? ` · Pfad: <code>${frappe.utils.escape_html(pathStr)}</code>` : " · <span class='ppk-muted'>noch kein Pfad</span>") +
				"</div>"
			);

			// Breadcrumb der gedrillten Link-Segmente + "zurück"
			if (prefix.length) {
				const $bc = $('<div class="ppk-bc"></div>').appendTo($box);
				$bc.append(`<span class="ppk-muted">${frappe.utils.escape_html(src.doctype)}</span>`);
				prefix.forEach((seg) => $bc.append(` › <code>${frappe.utils.escape_html(seg)}</code>`));
				if (!readOnly) {
					$('<button class="btn btn-xs ppk-back">‹ zurück</button>')
						.appendTo($bc)
						.on("click", () => { prefix.pop(); rebuild(); });
				}
			}

			if (readOnly) { _addReload(); return; }

			const $list = $('<div class="ppk-list">Lade Felder…</div>').appendTo($box);
			frappe.call({
				method: GET_OPTS,
				args: { doctype: src.doctype, path_prefix: prefix.join(".") },
			}).then((r) => {
				const fields = (r.message && r.message.fields) || [];
				$list.empty();
				if (!fields.length) {
					$list.append('<div class="ppk-hint">Keine Felder.</div>');
					return;
				}
				fields.forEach((f) => {
					const full = prefix.concat(f.fieldname).join(".");
					const badges =
						`<span class="ppk-type">${frappe.utils.escape_html(f.fieldtype)}</span>` +
						(f.is_link ? ` <span class="ppk-link">→ ${frappe.utils.escape_html(f.options || "")}</span>` : "") +
						(f.is_virtual ? ' <span class="ppk-virt">virtuell</span>' : "");
					const $row = $(
						`<div class="ppk-row">` +
						`<button class="ppk-pick" title="Diesen Pfad ausgeben"><code>${frappe.utils.escape_html(f.fieldname)}</code> ${badges}</button>` +
						(f.is_link ? '<button class="btn btn-xs ppk-drill" title="Tiefer (verketteter Pfad)">›</button>' : "") +
						`</div>`
					).appendTo($list);
					$row.find(".ppk-pick").on("click", () => {
						const patch = { path: full, source_doctype: src.doctype };
						if (typeof ctx.commitMany === "function") ctx.commitMany(patch);
						else { ctx.commit("source_doctype", src.doctype); ctx.commit("path", full); }
						rebuild();
					});
					$row.find(".ppk-drill").on("click", () => { prefix.push(f.fieldname); rebuild(); });
				});
			}).catch((e) => {
				$list.empty().append(
					`<div class="ppk-hint ppk-warn">Fehler beim Laden: ${frappe.utils.escape_html((e && e.message) || String(e))}</div>`
				);
			});

			_addReload();
		}

		// Da der Editor das Widget bei Änderung von cfg.source_field NICHT neu mountet,
		// gibt es einen manuellen "neu laden"-Knopf (liest cfg.source_field frisch).
		function _addReload() {
			$('<button class="btn btn-xs ppk-reload">↻ Quelle neu laden</button>')
				.appendTo($box)
				.on("click", () => { prefix = []; rebuild(); });
		}

		rebuild();
	}

	window.process_engine.register_config_widget("path_picker", _renderPathPicker);

	if (!document.getElementById("ppk-styles")) {
		const css = `
			.ppk-widget { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
			.ppk-head { color: var(--text-muted,#6c757d); }
			.ppk-bc { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
			.ppk-muted { color: var(--text-muted,#6c757d); }
			.ppk-list { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow:auto;
				border: 1px solid var(--border-color,#d1d8dd); border-radius: 6px; padding: 4px; }
			.ppk-row { display: flex; align-items: center; gap: 4px; }
			.ppk-pick { flex: 1; text-align: left; background: transparent; border: 1px solid transparent;
				border-radius: 4px; padding: 3px 6px; cursor: pointer; }
			.ppk-pick:hover { background: var(--bg-light-gray,#f0f3f5); border-color: var(--border-color,#d1d8dd); }
			.ppk-type { color: var(--text-muted,#6c757d); font-size: 10.5px; }
			.ppk-link { color: rgb(20,90,160); font-size: 10.5px; }
			.ppk-virt { color: rgb(150,90,20); font-size: 10.5px; font-weight: 500; }
			.ppk-warn { color: var(--danger,#c0392b); }
			.ppk-hint { color: var(--text-muted,#6c757d); }
		`;
		const style = document.createElement("style");
		style.id = "ppk-styles";
		style.textContent = css;
		document.head.appendChild(style);
	}
})();
