/**
 * Generischer Helper, der "Prozess starten"-Buttons aus der ProcessRuntimeConfig
 * der process_engine-App auf Quell-Doctype-Forms haengt.
 *
 * Verwendung im jeweiligen Quell-Doctype-JS:
 *   frappe.ui.form.on("Mietvertrag", {
 *     refresh(frm) { process_engine.process_triggers.attach_to_form(frm); }
 *   });
 *
 * Der Server-Endpoint get_triggers_for_source liefert pro Quell-Doctype die
 * sichtbaren/erlaubten Trigger; build_trigger_payload baut die new_doc-Defaults
 * fuer den konkreten Source-Doc.
 */
(function () {
	window.process_engine = window.process_engine || {};
	// Backward-Compat-Alias: bestehender hausverwaltung-Code kann weiter ueber
	// window.hausverwaltung.process_triggers darauf zugreifen.
	window.hausverwaltung = window.hausverwaltung || {};

	// Cache-Key = (doctype, name) — pro Form-Instanz einmal laden. Bei Navigation
	// zwischen verschiedenen Docs desselben Doctypes wird neu geholt, da
	// visibility_check pro Source-Doc anders ausfallen kann.
	const trigger_cache = {};

	async function _fetch_triggers(doctype, name) {
		const cache_key = `${doctype}::${name || ""}`;
		if (trigger_cache[cache_key]) return trigger_cache[cache_key];
		const { message } = await frappe.call({
			method: "process_engine.process_engine.processes.triggers.get_triggers_for_source",
			args: { source_doctype: doctype, source_name: name || null },
		});
		trigger_cache[cache_key] = message || [];
		return trigger_cache[cache_key];
	}

	async function attach_to_form(frm) {
		if (!frm || frm.is_new()) return;
		let triggers;
		try {
			triggers = await _fetch_triggers(frm.doctype, frm.doc.name);
		} catch (err) {
			console.error("process_engine.process_triggers: fetch failed", err);
			return;
		}
		for (const t of triggers) {
			frm.add_custom_button(
				__(t.button_label),
				async () => {
					try {
						const { message: payload } = await frappe.call({
							method: "process_engine.process_engine.processes.triggers.build_trigger_payload",
							args: { trigger_id: t.trigger_id, source_name: frm.doc.name },
						});
						frappe.new_doc(t.target_doctype, payload || {});
					} catch (err) {
						console.error("process_engine.process_triggers: build_payload failed", err);
						frappe.show_alert(
							{ message: __("Prozess konnte nicht gestartet werden."), indicator: "red" },
							5
						);
					}
				},
				__(t.button_group || "Workflow")
			);
		}
	}

	const api = { attach_to_form };
	window.process_engine.process_triggers = api;
	// Legacy alias — wird genutzt von Code aus der hausverwaltung-App-Zeit
	window.hausverwaltung.process_triggers = api;

	// Self-Registration: haengt fuer jeden Source-Doctype aus frappe.boot ein
	// refresh-Hook ein, der attach_to_form aufruft. Damit muss kein Source-
	// Doctype-JS mehr explizit attach_to_form() rufen.
	//
	// Race-Safety: zweifacher Aufruf — sofort UND nach after_ajax — mit Set-Dedup.
	const _registered_doctypes = new Set();

	function _register_process_trigger_forms() {
		const source_doctypes = (frappe.boot || {}).process_engine_source_doctypes || [];
		for (const dt of source_doctypes) {
			if (!dt || _registered_doctypes.has(dt)) continue;
			_registered_doctypes.add(dt);
			frappe.ui.form.on(dt, "refresh", (frm) => {
				window.process_engine?.process_triggers?.attach_to_form(frm);
			});
		}
	}

	_register_process_trigger_forms();
	if (typeof frappe.after_ajax === "function") {
		frappe.after_ajax(_register_process_trigger_forms);
	}
})();
