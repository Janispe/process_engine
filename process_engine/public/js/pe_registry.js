// process_engine — zentrale Client-Registries fuer selbstbeschreibende Aufgabentypen.
//
// Designprinzip: Handler beschreiben UI deklarativ (sie nennen NAMEN von Widgets/Dialogen/
// Views in ihrer Python-Selbstbeschreibung). Die Implementierungen leben hier in
// Client-Registries. process_engine traegt seine Built-ins ein; Consumer-Apps ergaenzen
// eigene ueber ihr eigenes JS-Asset (app_include_js). Es wird NIE Code aus einem
// Server-Descriptor ausgefuehrt — der Server liefert nur Namen, der Client loest sie hier
// auf. Das haelt die Sicherheits-Boundary (Client schickt nur keys, Server mappt/prueft).
//
// Bereitgestellte Registries unter window.process_engine + explizite Register-API:
//   register_config_widget(name, fn) : Definitionszeit-Editor (Prozess Version).
//         fn(ctx) -> void;  ctx = {frm, row, def, cfg, container, commit(key, value)}
//   register_action_dialog(name, fn) : Laufzeit-Dialoge (Prozess Instanz).
//         fn(ctx) -> void|Promise;  ctx = {frm, row_name, action_key, dialog, run(payload), navigate}
//   register_task_view(name, fn)     : Voll-Custom-Rendering einer Aufgabe (Prozess Instanz).
//         fn(ctx) -> void | (() => void)  // optionale Cleanup-Funktion (Lifecycle)
//         ctx = {frm, row, config, container, refresh(), runAction(action_key, payload)}

(function () {
	window.process_engine = window.process_engine || {};
	const PE = window.process_engine;

	function makeRegistry(label) {
		const map = {};
		return {
			label,
			register(name, fn) {
				const key = (name || "").trim();
				if (!key || typeof fn !== "function") {
					console.warn(`[process_engine] ${label}.register: ungueltiger Name oder keine Funktion`, name);
					return;
				}
				// Idempotente Re-Registrierung derselben Funktion (Doctype-JS-Re-Eval) ist still.
				// Eine ANDERE Implementierung gleichen Namens ist eine echte Kollision -> sichtbar
				// machen (haeufige Ursache: Asset-Reihenfolge/Tippfehler), aber last-wins zulassen.
				if (map[key] && map[key] !== fn) {
					console.warn(`[process_engine] ${label}: '${key}' wird ueberschrieben (Namenskollision?).`);
				}
				map[key] = fn;
			},
			get(name) {
				return map[(name || "").trim()] || null;
			},
			has(name) {
				return !!map[(name || "").trim()];
			},
			list() {
				return Object.keys(map);
			},
		};
	}

	// Idempotent: bei Re-Eval (frappe.require/Hot-Reload) bestehende Registries behalten,
	// damit bereits registrierte Consumer-Eintraege nicht verloren gehen.
	PE.config_widgets = PE.config_widgets || makeRegistry("config_widgets");
	PE.action_dialogs = PE.action_dialogs || makeRegistry("action_dialogs");
	PE.task_views = PE.task_views || makeRegistry("task_views");

	// Explizite, stabile API fuer Consumer-Apps (robuster als roher Objektzugriff).
	PE.register_config_widget = (name, fn) => PE.config_widgets.register(name, fn);
	PE.register_action_dialog = (name, fn) => PE.action_dialogs.register(name, fn);
	PE.register_task_view = (name, fn) => PE.task_views.register(name, fn);
})();
