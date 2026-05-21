// Custom Config-Widget: Print-Format-/Serienbrief-Vorlage-Auswahl
//
// Registriert ein Widget namens "print_format_picker" auf dem globalen
// `window.process_engine.config_widgets`-Registry. Wird vom React-Editor
// (process_editor_react.bundle.js) aufgerufen, wenn ein Schritt-Handler in
// `config_schema()` ein Feld mit `"widget": "print_format_picker"` deklariert.
//
// Schema-Feld-Beispiel (im Server-Handler):
//   {
//     "key": "print_format",
//     "label": "Serienbrief-Vorlage",
//     "widget": "print_format_picker",
//     "reqd": 1,
//     "filters": {"disabled": 0}    // optional
//   }
//
// Lade-Reihenfolge: einfach via hooks.py:
//   app_include_js = ["public/js/print_format_picker.js"]
//
// Hängt nicht vom React-Bundle ab — pure jQuery/Frappe-UI. Funktioniert auch
// in der bisherigen Drawflow-Variante (prozess_version.js) parallel.

(function () {
	// Registry-Namespace defensiv anlegen, falls dieses File vor dem Editor lädt.
	if (!window.process_engine) window.process_engine = {};
	if (!window.process_engine.config_widgets) {
		window.process_engine.config_widgets = new Map();
	}
	if (typeof window.process_engine.register_config_widget !== "function") {
		window.process_engine.register_config_widget = function (name, fn) {
			window.process_engine.config_widgets.set(name, fn);
		};
	}

	function _renderPrintFormatPicker(ctx) {
		const { frm, def, container, commit, readOnly } = ctx;
		const $box = $('<div class="pfp-widget"></div>').appendTo(container);

		// Filter mergen: Default = nur nicht-disabled; Schema kann überschreiben/erweitern.
		const filters = Object.assign({ disabled: 0 }, def.filters || {});

		// Frappe-natives Link-Control nutzen: kommt mit Awesomplete-Autocomplete + Validierung.
		// get_query erlaubt das benutzerdefinierte Filter-Dict; description landet
		// als Hint unter dem Feld.
		const ctrl = frappe.ui.form.make_control({
			df: {
				fieldname: def.key,
				label: def.label || __("Print Format"),
				fieldtype: "Link",
				options: "Print Format",
				reqd: !!def.reqd,
				description: def.description || __("Diese Vorlage wird beim Drucken der Aufgabe verwendet."),
				get_query: () => ({ filters: Object.assign({}, filters) }),
			},
			parent: $('<div class="pfp-control"></div>').appendTo($box).get(0),
			render_input: true,
		});

		const current = (ctx.cfg && ctx.cfg[def.key]) || "";
		ctrl.set_value(current);
		if (readOnly) {
			ctrl.df.read_only = 1;
			try { ctrl.refresh && ctrl.refresh(); } catch (_) {}
		}

		// Live-Preview-Link + Meta-Zeile unter dem Control.
		const $meta = $('<div class="pfp-meta"></div>').appendTo($box);

		function refreshMeta() {
			const value = (ctrl.get_value() || "").trim();
			$meta.empty();
			if (!value) return;
			const linkUrl = `/app/print-format/${encodeURIComponent(value)}`;
			$meta.append(
				`<a href="${linkUrl}" target="_blank" class="pfp-preview-link">` +
				`${frappe.utils.icon("link-url", "xs")} ${__("Vorlage anzeigen")}</a>`
			);
			// Live nachladen, welcher Doc-Type zur Vorlage gehört.
			frappe.db.get_value("Print Format", value, ["doc_type", "standard"]).then((r) => {
				const v = (r && r.message) || {};
				if (v.doc_type) {
					$meta.append(`<span class="pfp-meta-pill">${frappe.utils.escape_html(v.doc_type)}</span>`);
				}
				if (v.standard) {
					$meta.append(`<span class="pfp-meta-pill pfp-standard">${__("Standard")}</span>`);
				}
			});
		}
		refreshMeta();

		// Frappe-Link-Controls feuern 'change' auf $input bei Auswahl.
		if (ctrl.$input && ctrl.$input.length) {
			ctrl.$input.on("change", () => {
				const val = (ctrl.get_value() || "").trim();
				commit(def.key, val);
				refreshMeta();
			});
		} else {
			ctrl.df.onchange = () => {
				const val = (ctrl.get_value() || "").trim();
				commit(def.key, val);
				refreshMeta();
			};
		}

		// Cleanup-Hook ist nicht zwingend nötig — der Editor leert `container` beim
		// Re-Mount. Falls jemand außerhalb des Editors wiederverwenden will, könnte
		// hier eine destroy()-Funktion zurückgegeben werden.
	}

	window.process_engine.register_config_widget("print_format_picker", _renderPrintFormatPicker);

	// Minimal-Styling. Bewusst nicht zu viel — Frappe's Standard-Look bleibt sichtbar.
	if (!document.getElementById("pfp-styles")) {
		const css = `
			.pfp-widget { display: flex; flex-direction: column; gap: 6px; }
			.pfp-meta {
				display: flex; align-items: center; gap: 6px;
				font-size: 11.5px; color: var(--text-muted, #6c757d);
			}
			.pfp-preview-link {
				display: inline-flex; align-items: center; gap: 4px;
				color: var(--text-color, inherit);
				text-decoration: none;
			}
			.pfp-preview-link:hover { text-decoration: underline; }
			.pfp-meta-pill {
				display: inline-flex; align-items: center; height: 16px;
				padding: 0 6px; border-radius: 8px;
				font-size: 10.5px; font-weight: 500;
				background: var(--bg-light-gray, #f0f3f5);
				color: var(--text-muted, #6c757d);
			}
			.pfp-meta-pill.pfp-standard {
				background: rgba(40, 167, 69, 0.12);
				color: rgb(20, 110, 50);
			}
		`;
		const style = document.createElement("style");
		style.id = "pfp-styles";
		style.textContent = css;
		document.head.appendChild(style);
	}
})();
