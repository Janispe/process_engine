// Custom Config-Widget: Multi-Pfad-Picker für den Derive-Node (ein Eingang -> viele Ausgänge).
//
// Registriert "derive_paths" auf window.process_engine.config_widgets. Der React-Editor ruft es
// auf, wenn ein Handler in config_schema() ein Feld mit "widget": "derive_paths" deklariert
// (siehe DeriveTaskHandler).
//
// Funktion: ausgehend vom Quell-Doctype (cfg.input_doctype) drillt man wie im path_picker durch
// Link-Felder. "Hinzufügen" hängt einen Pfad an cfg.derivations = [{path, field}] an; der
// Ergebnis-Feldname wird automatisch aus dem Pfad abgeleitet (letztes Segment, dedupliziert gegen
// bestehende Ableitungen UND alle Payload-Felder, damit kein Multi-Producer-Konflikt entsteht).
// Jeder Eintrag wird nach dem Speichern zu einem eigenen Output-Port. Das konkrete Objekt kommt
// zur Laufzeit über den verdrahteten Objekt-Input-Port (source_field), nicht hier gewählt.
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
	const WEAK = new Set(["name", "title", "value", "status", "label"]);

	// Spiegelt DeriveTaskHandler._auto_field_name (Python) — Editor persistiert den Namen,
	// das Backend liest ihn nur. Beide Seiten konsistent halten.
	function autoFieldName(path, taken) {
		const segs = (path || "").split(".").map((s) => s.trim()).filter(Boolean);
		let base = segs.length ? segs[segs.length - 1] : "wert";
		if (WEAK.has(base) && segs.length >= 2) base = segs[segs.length - 2] + "_" + base;
		base = base.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "wert";
		let cand = base;
		let i = 2;
		while (taken.has(cand)) { cand = base + "_" + i; i += 1; }
		return cand;
	}

	function currentDerivations(cfg) {
		const raw = cfg && cfg.derivations;
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((d) => d && typeof d === "object" && (d.path || "").trim())
			.map((d) => ({ path: (d.path || "").trim(), field: (d.field || "").trim() }));
	}

	// Alle bereits vergebenen Payload-Feldnamen (für Dedupe): andere Ableitungen dieses Knotens
	// + alle payload_field_specs der Version (Start-Inputs und Outputs anderer Knoten).
	function takenNames(ctx, derivations) {
		const taken = new Set();
		for (const d of derivations) if (d.field) taken.add(d.field);
		const specs = (ctx.frm && ctx.frm.doc && ctx.frm.doc.payload_field_specs) || [];
		for (const s of specs) {
			const fn = (s.fieldname || "").trim();
			if (fn) taken.add(fn);
		}
		return taken;
	}

	function _render(ctx) {
		const { container, readOnly } = ctx;
		const $box = $('<div class="dpk-widget"></div>').appendTo(container);

		// prefix = bereits gewählte Link-Segmente, in die "hineingedrillt" wurde.
		let prefix = [];

		// Lokaler, anzeige-autoritativer State (Mount-Snapshot aus ctx.cfg). Der Editor
		// re-mountet das Widget bei cfg-Aenderung NICHT; nach commit() ist ctx.cfg deshalb
		// erst beim naechsten React-Render aktuell. Wir fuehren die Liste daher lokal und
		// committen sie zusaetzlich in die Konfig (Persistenz).
		let derivations = currentDerivations(ctx.cfg);

		function persist() {
			ctx.commit("derivations", derivations.map((d) => ({ path: d.path, field: d.field })));
		}

		function addPath(fullPath) {
			if (derivations.some((d) => d.path === fullPath)) {
				frappe.show_alert({ message: __("Pfad bereits hinzugefügt: {0}", [fullPath]), indicator: "orange" });
				return;
			}
			const field = autoFieldName(fullPath, takenNames(ctx, derivations));
			derivations = derivations.concat([{ path: fullPath, field }]);
			persist();
			prefix = [];
			rebuild();
		}

		function removePath(idx) {
			derivations = derivations.filter((_, i) => i !== idx);
			persist();
			rebuild();
		}

		function rebuild() {
			$box.empty();
			const cfg = ctx.cfg || {};
			const baseDoctype = (cfg.input_doctype || "").trim();
			if (!baseDoctype) {
				$box.append('<div class="dpk-hint">Bitte zuerst den <b>Quell-Doctype</b> wählen.</div>');
				_addReload();
				return;
			}

			$box.append(
				`<div class="dpk-head">Quelle: <code>${frappe.utils.escape_html(baseDoctype)}</code> · ein Eingang → viele Ausgänge</div>`
			);

			// Bestehende Ableitungen (= Output-Ports nach dem Speichern) — aus lokalem State.
			const $chosen = $('<div class="dpk-chosen"></div>').appendTo($box);
			if (!derivations.length) {
				$chosen.append('<div class="dpk-hint">Noch keine Ableitung. Unten einen Pfad hinzufügen.</div>');
			} else {
				derivations.forEach((d, idx) => {
					const $row = $(
						`<div class="dpk-chosen-row">` +
						`<span class="dpk-path"><code>${frappe.utils.escape_html(d.path)}</code></span>` +
						`<span class="dpk-arrow">→</span>` +
						`<span class="dpk-field"><code>${frappe.utils.escape_html(d.field)}</code></span>` +
						(readOnly ? "" : `<button class="btn btn-xs dpk-del" title="Entfernen">✕</button>`) +
						`</div>`
					).appendTo($chosen);
					$row.find(".dpk-del").on("click", () => removePath(idx));
				});
			}

			if (readOnly) { _addReload(); return; }

			// Picker zum Hinzufügen (drill-down wie path_picker)
			$box.append('<div class="dpk-sub">Pfad hinzufügen</div>');
			if (prefix.length) {
				const $bc = $('<div class="dpk-bc"></div>').appendTo($box);
				$bc.append(`<span class="dpk-muted">${frappe.utils.escape_html(baseDoctype)}</span>`);
				prefix.forEach((seg) => $bc.append(` › <code>${frappe.utils.escape_html(seg)}</code>`));
				$('<button class="btn btn-xs dpk-back">‹ zurück</button>')
					.appendTo($bc)
					.on("click", () => { prefix.pop(); rebuild(); });
			}

			const $list = $('<div class="dpk-list">Lade Felder…</div>').appendTo($box);
			frappe.call({
				method: GET_OPTS,
				args: { doctype: baseDoctype, path_prefix: prefix.join(".") },
			}).then((r) => {
				const fields = (r.message && r.message.fields) || [];
				$list.empty();
				if (!fields.length) {
					$list.append('<div class="dpk-hint">Keine Felder.</div>');
					return;
				}
				fields.forEach((f) => {
					const full = prefix.concat(f.fieldname).join(".");
					const badges =
						`<span class="dpk-type">${frappe.utils.escape_html(f.fieldtype)}</span>` +
						(f.is_link ? ` <span class="dpk-link">→ ${frappe.utils.escape_html(f.options || "")}</span>` : "") +
						(f.is_virtual ? ' <span class="dpk-virt">virtuell</span>' : "");
					const $row = $(
						`<div class="dpk-row">` +
						`<button class="dpk-pick" title="Diesen Pfad als Ausgang hinzufügen"><code>${frappe.utils.escape_html(f.fieldname)}</code> ${badges}</button>` +
						(f.is_link ? '<button class="btn btn-xs dpk-drill" title="Tiefer (verketteter Pfad)">›</button>' : "") +
						`</div>`
					).appendTo($list);
					$row.find(".dpk-pick").on("click", () => addPath(full));
					$row.find(".dpk-drill").on("click", () => { prefix.push(f.fieldname); rebuild(); });
				});
			}).catch((e) => {
				$list.empty().append(
					`<div class="dpk-hint dpk-warn">Fehler beim Laden: ${frappe.utils.escape_html((e && e.message) || String(e))}</div>`
				);
			});

			_addReload();
		}

		// Der Editor mountet das Widget bei Änderung von cfg.input_doctype NICHT neu ->
		// manueller "neu laden"-Knopf (liest cfg.input_doctype frisch).
		function _addReload() {
			$('<button class="btn btn-xs dpk-reload">↻ Quelle neu laden</button>')
				.appendTo($box)
				.on("click", () => { prefix = []; rebuild(); });
		}

		rebuild();
	}

	window.process_engine.register_config_widget("derive_paths", _render);

	if (!document.getElementById("dpk-styles")) {
		const css = `
			.dpk-widget { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
			.dpk-head { color: var(--text-muted,#6c757d); }
			.dpk-sub { font-weight: 600; margin-top: 4px; }
			.dpk-chosen { display: flex; flex-direction: column; gap: 3px; }
			.dpk-chosen-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px;
				border: 1px solid var(--border-color,#d1d8dd); border-radius: 6px; background: var(--bg-light-gray,#f7f9fa); }
			.dpk-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.dpk-arrow { color: var(--text-muted,#6c757d); }
			.dpk-field code { color: rgb(20,120,70); }
			.dpk-del { margin-left: auto; }
			.dpk-bc { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
			.dpk-muted { color: var(--text-muted,#6c757d); }
			.dpk-list { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow: auto;
				border: 1px solid var(--border-color,#d1d8dd); border-radius: 6px; padding: 4px; }
			.dpk-row { display: flex; align-items: center; gap: 4px; }
			.dpk-pick { flex: 1; text-align: left; background: transparent; border: 1px solid transparent;
				border-radius: 4px; padding: 3px 6px; cursor: pointer; }
			.dpk-pick:hover { background: var(--bg-light-gray,#f0f3f5); border-color: var(--border-color,#d1d8dd); }
			.dpk-type { color: var(--text-muted,#6c757d); font-size: 10.5px; }
			.dpk-link { color: rgb(20,90,160); font-size: 10.5px; }
			.dpk-virt { color: rgb(150,90,20); font-size: 10.5px; font-weight: 500; }
			.dpk-warn { color: var(--danger,#c0392b); }
			.dpk-hint { color: var(--text-muted,#6c757d); }
		`;
		const style = document.createElement("style");
		style.id = "dpk-styles";
		style.textContent = css;
		document.head.appendChild(style);
	}
})();
