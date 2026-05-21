// Custom Config-Widget: Felder am Objekt-Doctype zum Ausfuellen waehlen (fill_fields).
//
// Registriert "fill_fields_picker" auf window.process_engine.config_widgets. Der React-Editor
// ruft es auf, wenn ein Handler in config_schema() ein Feld mit "widget": "fill_fields_picker"
// deklariert (siehe FillFieldsTaskHandler).
//
// Ableitung des Ziel-Doctype: aus dem in cfg.source_field gewaehlten Payload-Feld (muss Link
// sein, options = Ziel-Doctype). Listet dessen setzbare Felder; pro Feld waehlbar + "nicht null".
// Auswahl committet { source_doctype, fields: [{fieldname, not_null}] } atomar (commitMany).
//
// Ladereihenfolge via hooks.py: nach pe_registry.js.

(function () {
	if (!window.process_engine) window.process_engine = {};
	if (!window.process_engine.config_widgets) window.process_engine.config_widgets = new Map();
	if (typeof window.process_engine.register_config_widget !== "function") {
		window.process_engine.register_config_widget = function (n, fn) {
			window.process_engine.config_widgets.set(n, fn);
		};
	}

	const SKIP = new Set([
		"Section Break", "Column Break", "Tab Break", "HTML", "Table", "Table MultiSelect",
		"Button", "Heading", "Image", "Fold", "Geolocation", "Signature", "Barcode",
	]);
	function settable(df) {
		if (!df || !df.fieldname) return false;
		if (SKIP.has(df.fieldtype)) return false;
		if (df.read_only || df.is_virtual || df.hidden) return false;
		if (["naming_series", "amended_from"].includes(df.fieldname)) return false;
		return true;
	}

	function sourceDoctype(frm, sourceField) {
		const specs = (frm && frm.doc && frm.doc.payload_field_specs) || [];
		const spec = specs.find((s) => (s.fieldname || "").trim() === (sourceField || "").trim());
		if (!spec) return { doctype: "", reason: "Objekt-Feld nicht in den Payload-Feldern gefunden." };
		if ((spec.fieldtype || "") !== "Link" || !(spec.options || "").trim()) {
			return { doctype: "", reason: `Objekt-Feld '${sourceField}' ist kein Link-Feld.` };
		}
		return { doctype: (spec.options || "").trim(), reason: "" };
	}

	function render(ctx) {
		const { frm, container } = ctx;
		const $box = $('<div class="ffp-widget"></div>').appendTo(container);

		function addReload() {
			$('<button class="btn btn-xs ffp-reload">↻ Objekt neu laden</button>')
				.appendTo($box)
				.on("click", () => rebuild());
		}

		function rebuild() {
			$box.empty();
			const cfg = ctx.cfg || {};
			const doctype = (cfg.input_doctype || "").trim();
			if (!doctype) {
				$box.append('<div class="ffp-hint">Bitte zuerst den <b>Objekt-Doctype</b> oben wählen.</div>');
				addReload();
				return;
			}
			$box.append(`<div class="ffp-head">Objekt: <code>${frappe.utils.escape_html(doctype)}</code> · Felder zum Ausfüllen wählen</div>`);
			const $list = $('<div class="ffp-list">Lade Felder…</div>').appendTo($box);

			frappe.model.with_doctype(doctype, () => {
				const meta = frappe.get_meta(doctype);
				const fields = (meta && meta.fields ? meta.fields : []).filter(settable);
				const current = {};
				for (const f of (cfg.fields || [])) if (f && f.fieldname) current[f.fieldname] = !!f.not_null;

				$list.empty();
				if (!fields.length) {
					$list.append('<div class="ffp-hint">Keine setzbaren Felder.</div>');
					return;
				}
				fields.forEach((df) => {
					const fn = df.fieldname;
					const checked = fn in current;
					const nn = !!current[fn];
					const $row = $(
						`<div class="ffp-row">
							<label class="ffp-sel"><input type="checkbox" class="ffp-include"${checked ? " checked" : ""}>
								<span><code>${frappe.utils.escape_html(fn)}</code>
								<span class="ffp-meta">${frappe.utils.escape_html(df.label || "")} · ${frappe.utils.escape_html(df.fieldtype)}</span></span></label>
							<label class="ffp-nn"><input type="checkbox" class="ffp-notnull"${nn ? " checked" : ""}${checked ? "" : " disabled"}> nicht null</label>
						</div>`
					).appendTo($list);
					$row.data("fn", fn);
				});

				function collect() {
					const out = [];
					$list.find(".ffp-row").each(function () {
						const $r = $(this);
						if ($r.find(".ffp-include").is(":checked")) {
							out.push({ fieldname: $r.data("fn"), not_null: $r.find(".ffp-notnull").is(":checked") ? 1 : 0 });
						}
					});
					ctx.commit("fields", out);
				}
				$list.on("change", ".ffp-include", function () {
					const $r = $(this).closest(".ffp-row");
					const on = $(this).is(":checked");
					$r.find(".ffp-notnull").prop("disabled", !on);
					if (!on) $r.find(".ffp-notnull").prop("checked", false);
					collect();
				});
				$list.on("change", ".ffp-notnull", collect);
			});

			addReload();
		}

		rebuild();
	}

	window.process_engine.register_config_widget("fill_fields_picker", render);

	if (!document.getElementById("ffp-styles")) {
		const css = `
			.ffp-widget { display:flex; flex-direction:column; gap:6px; font-size:12px; }
			.ffp-head { color: var(--text-muted,#6c757d); }
			.ffp-list { display:flex; flex-direction:column; gap:2px; max-height:260px; overflow:auto;
				border:1px solid var(--border-color,#d1d8dd); border-radius:6px; padding:4px; }
			.ffp-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:2px 4px; }
			.ffp-sel { display:flex; align-items:center; gap:6px; cursor:pointer; flex:1; margin:0; }
			.ffp-meta { color: var(--text-muted,#6c757d); font-size:10.5px; }
			.ffp-nn { display:flex; align-items:center; gap:4px; cursor:pointer; font-size:10.5px; color: var(--text-muted,#6c757d); margin:0; white-space:nowrap; }
			.ffp-warn { color: var(--danger,#c0392b); }
			.ffp-hint { color: var(--text-muted,#6c757d); }
		`;
		const st = document.createElement("style");
		st.id = "ffp-styles";
		st.textContent = css;
		document.head.appendChild(st);
	}
})();
