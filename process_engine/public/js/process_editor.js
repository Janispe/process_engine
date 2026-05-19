// Phase 10: Visual Process Editor via Drawflow
//
// Drawflow: v0.0.59 (MIT), Source: https://github.com/jerosoler/Drawflow
// Bundle: process_engine/public/js/lib/drawflow.min.js (~46 KB)
// CSS: process_engine/public/css/drawflow.min.css + process_editor.css
//
// API:
//   window.process_engine.editor.render({
//     container,                  // HTMLElement fuer Drawflow
//     schritte,                   // Liste der Schritt-Zeilen aus frm.doc.schritte
//     schritt_io,                 // Liste der IO-Zeilen aus frm.doc.schritt_io
//     payload_field_specs,        // Liste der Field-Spec-Zeilen
//     read_only,                  // Boolean: bei aktiver Version true
//     on_save_position(step_key, x, y),
//     on_create_edge(src_meta, dst_meta),  // meta = {kind, target, step_key}
//     on_delete_edge(src_meta, dst_meta),
//     on_select_node(step_key),
//   })

(function () {
	window.process_engine = window.process_engine || {};
	const ns = (window.process_engine.editor = window.process_engine.editor || {});

	const PROCESS_INPUTS_NODE = "__process_inputs__";

	function _loadCssOnce(href) {
		// frappe.require() fuer CSS ist version-abhaengig wackelig — eigener Loader.
		const existing = document.querySelector(`link[href="${href}"]`);
		if (existing) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const link = document.createElement("link");
			link.rel = "stylesheet";
			link.href = href;
			link.onload = () => resolve();
			link.onerror = () => reject(new Error(`Failed to load CSS ${href}`));
			document.head.appendChild(link);
		});
	}

	async function _ensureDrawflow() {
		if (window.Drawflow) return;
		await new Promise((r) =>
			frappe.require("/assets/process_engine/js/lib/drawflow.min.js", r)
		);
		await _loadCssOnce("/assets/process_engine/css/drawflow.min.css");
		await _loadCssOnce("/assets/process_engine/css/process_editor.css");
	}

	function _toast(msg, indicator = "orange") {
		try {
			frappe.show_alert({ message: msg, indicator }, 4);
		} catch (e) {
			console.warn("process_editor:", msg);
		}
	}

	// Topologische Sortierung: Spalten = DAG-Tiefe, Zeilen = Index in Spalte.
	function _topological_layout(schritte, schritt_io) {
		const step_keys = schritte.map((s) => (s.step_key || "").trim()).filter(Boolean);
		const deps = {};
		for (const sk of step_keys) deps[sk] = new Set();

		// payload_inputs → producer-Edges
		const producer_by_field = {};
		for (const r of schritt_io) {
			if ((r.kind || "") === "payload_output") {
				producer_by_field[r.target] = r.step_key;
			}
		}
		for (const r of schritt_io) {
			const sk = r.step_key;
			if (!step_keys.includes(sk)) continue;
			if ((r.kind || "") === "payload_input") {
				const producer = producer_by_field[r.target];
				if (producer && producer !== sk && step_keys.includes(producer)) {
					deps[sk].add(producer);
				}
			} else if ((r.kind || "") === "step_input") {
				if (r.target && r.target !== sk && step_keys.includes(r.target)) {
					deps[sk].add(r.target);
				}
			}
		}

		// Layer-Berechnung via Longest-Path
		const layer = {};
		for (const sk of step_keys) layer[sk] = 0;
		let changed = true;
		let safety = 100;
		while (changed && safety > 0) {
			changed = false;
			safety--;
			for (const sk of step_keys) {
				for (const dep of deps[sk]) {
					if (layer[dep] + 1 > layer[sk]) {
						layer[sk] = layer[dep] + 1;
						changed = true;
					}
				}
			}
		}

		// Pro Layer: Index zum Stride berechnen
		const layer_buckets = {};
		for (const sk of step_keys) {
			const l = layer[sk];
			layer_buckets[l] = layer_buckets[l] || [];
			layer_buckets[l].push(sk);
		}
		const STRIDE_X = 280;
		const STRIDE_Y = 140;
		const OFFSET_X = 280; // Platz fuer Process-Inputs-Knoten links
		const result = {};
		for (const [layer_str, sks] of Object.entries(layer_buckets)) {
			const l = parseInt(layer_str, 10);
			sks.forEach((sk, idx) => {
				result[sk] = { x: OFFSET_X + l * STRIDE_X, y: 40 + idx * STRIDE_Y };
			});
		}
		return result;
	}

	function _build_port_meta(step_key, schritt_io, all_input_fields) {
		// Phase 10-Fix: ALLE payload_field_specs werden als input-Ports gerendert
		// (Reihenfolge: alphabetisch). Aktive Ports = mit payload_input-Zeile in schritt_io,
		// leere Ports = "open" (User kann drauf droppen, um neue payload_input-Zeile zu erzeugen).
		// outputs bleiben "nur aktive Felder + generic step_done" — neuer payload_output
		// kommt weiterhin ueber das Grid.
		const my_io = schritt_io.filter((r) => r.step_key === step_key);
		const active_inputs = new Set(
			my_io.filter((r) => r.kind === "payload_input").map((r) => r.target)
		);
		const payload_outputs = my_io
			.filter((r) => r.kind === "payload_output")
			.map((r) => r.target)
			.sort();

		const meta = { inputs: {}, outputs: {} };
		all_input_fields.forEach((f, i) => {
			meta.inputs[`input_${i + 1}`] = {
				kind: "payload_input",
				target: f,
				active: active_inputs.has(f),
			};
		});
		meta.inputs[`input_${all_input_fields.length + 1}`] = { kind: "step_input", target: null };

		payload_outputs.forEach((f, i) => {
			meta.outputs[`output_${i + 1}`] = { kind: "payload_output", target: f };
		});
		meta.outputs[`output_${payload_outputs.length + 1}`] = { kind: "step_done", target: null };

		return { meta, all_input_fields, payload_outputs, active_inputs };
	}

	function _node_html(step) {
		return `
			<div class="pe-node-body">
				<div class="pe-node-header">
					<strong>${frappe.utils.escape_html(step.titel || step.step_key)}</strong>
					<span class="pe-badge">${frappe.utils.escape_html(step.task_type || "")}</span>
				</div>
				<div class="pe-node-step-key">${frappe.utils.escape_html(step.step_key || "")}</div>
			</div>
		`;
	}

	function _process_inputs_html(fields) {
		const list = fields
			.map((f) => `<div class="pe-kv">${frappe.utils.escape_html(f)}</div>`)
			.join("");
		return `
			<div class="pe-node-body">
				<div class="pe-node-header">
					<strong>${__("Process Inputs")}</strong>
				</div>
				<div class="pe-node-step-key">${frappe.utils.escape_html(PROCESS_INPUTS_NODE)}</div>
				${list}
			</div>
		`;
	}

	ns.render = async function ({
		container,
		schritte,
		schritt_io,
		payload_field_specs,
		read_only,
		on_save_position,
		on_create_edge,
		on_delete_edge,
		on_select_node,
	}) {
		if (!container) return;
		await _ensureDrawflow();

		// Container fuer Drawflow muss eindeutig erkennbar sein.
		container.innerHTML = "";
		container.classList.add("drawflow");
		const editor = new window.Drawflow(container);
		editor.start();
		if (read_only) editor.editor_mode = "fixed";

		// Auto-Layout fuer Knoten ohne editor_x
		const need_auto_layout = schritte.some((s) => s.editor_x == null || s.editor_y == null);
		const auto_pos = need_auto_layout ? _topological_layout(schritte, schritt_io) : {};

		// Alle in payload_field_specs deklarierten Felder, alphabetisch sortiert —
		// das ist die Grundlage fuer die Input-Ports JEDES Tasks (Phase-10-Fix B):
		// jeder Task bekommt einen Port pro Feld; "aktiv" wenn eine payload_input-Zeile
		// existiert, sonst "open" (drag-droppable).
		const all_input_fields = (payload_field_specs || [])
			.map((s) => (s.fieldname || "").trim())
			.filter(Boolean)
			.slice()
			.sort();

		// Process-Inputs sammeln: alle payload_field_specs, die kein Task als output deklariert.
		const output_fields = new Set(
			schritt_io.filter((r) => r.kind === "payload_output").map((r) => r.target)
		);
		const process_input_fields = (payload_field_specs || [])
			.map((s) => (s.fieldname || "").trim())
			.filter((f) => f && !output_fields.has(f));

		// Build port_meta_by_node — wichtigste Schicht fuer Edge-Lookup
		const port_meta_by_node = {};
		const node_id_by_step = {};

		// 1. Process-Inputs-Knoten (links, x=20).
		// WICHTIG: pi_outputs, payload_outputs und HTML muessen dieselbe Reihenfolge nutzen,
		// sonst landet die Edge auf einem falschen Drawflow-Port.
		const sorted_pi_fields = process_input_fields.slice().sort();
		if (sorted_pi_fields.length) {
			const pi_outputs = {};
			sorted_pi_fields.forEach((f, i) => {
				pi_outputs[`output_${i + 1}`] = { kind: "process_input", target: f };
			});
			port_meta_by_node[PROCESS_INPUTS_NODE] = {
				inputs: {},
				outputs: pi_outputs,
				is_process_inputs: true,
				payload_outputs: sorted_pi_fields,
			};
			const html = _process_inputs_html(sorted_pi_fields);
			const id = editor.addNode(
				PROCESS_INPUTS_NODE,
				0,
				sorted_pi_fields.length,
				20,
				40,
				"pe-process-inputs",
				{ step_key: PROCESS_INPUTS_NODE, is_process_inputs: true },
				html
			);
			node_id_by_step[PROCESS_INPUTS_NODE] = id;
		}

		// 2. Schritt-Knoten — input-Ports = all_input_fields + step_input,
		// output-Ports = aktive payload_outputs + step_done.
		const node_port_meta_for_styling = {};
		for (const step of schritte) {
			const sk = (step.step_key || "").trim();
			if (!sk) continue;
			const { meta, payload_outputs, active_inputs } = _build_port_meta(
				sk,
				schritt_io,
				all_input_fields
			);
			port_meta_by_node[sk] = { ...meta, all_input_fields, payload_outputs };
			const x = step.editor_x != null ? step.editor_x : (auto_pos[sk]?.x ?? 300);
			const y = step.editor_y != null ? step.editor_y : (auto_pos[sk]?.y ?? 40);
			const html = _node_html(step);
			const id = editor.addNode(
				sk,
				all_input_fields.length + 1, // +1 fuer generic step_input
				payload_outputs.length + 1, // +1 fuer generic step_done
				x,
				y,
				"pe-node",
				{ step_key: sk },
				html
			);
			node_id_by_step[sk] = id;
			node_port_meta_for_styling[id] = { active_inputs, payload_outputs };
		}

		// 3. Edges aus schritt_io ableiten
		const producer_by_field = {};
		for (const r of schritt_io) {
			if (r.kind === "payload_output") producer_by_field[r.target] = r.step_key;
		}
		// 3a. payload_input → producer-Edge oder Process-Inputs-Edge.
		// dst-Port-Index richtet sich nach all_input_fields (stabil pro Task).
		for (const r of schritt_io) {
			if (r.kind !== "payload_input") continue;
			const dst_node_id = node_id_by_step[r.step_key];
			if (!dst_node_id) continue;
			const dst_port_idx = all_input_fields.indexOf(r.target);
			if (dst_port_idx < 0) continue;
			const dst_class = `input_${dst_port_idx + 1}`;

			const producer = producer_by_field[r.target];
			let src_node_id, src_class;
			if (producer && node_id_by_step[producer]) {
				src_node_id = node_id_by_step[producer];
				const src_meta = port_meta_by_node[producer];
				const src_port_idx = src_meta.payload_outputs.indexOf(r.target);
				if (src_port_idx < 0) continue;
				src_class = `output_${src_port_idx + 1}`;
			} else if (node_id_by_step[PROCESS_INPUTS_NODE]) {
				src_node_id = node_id_by_step[PROCESS_INPUTS_NODE];
				const pi_outputs = port_meta_by_node[PROCESS_INPUTS_NODE].payload_outputs;
				const src_port_idx = pi_outputs.indexOf(r.target);
				if (src_port_idx < 0) continue;
				src_class = `output_${src_port_idx + 1}`;
			} else {
				continue;
			}
			try {
				editor.addConnection(src_node_id, dst_node_id, src_class, dst_class);
			} catch (e) {
				console.warn("process_editor: addConnection failed", e);
			}
		}
		// 3b. step_input → step_done-Edge (generic ports am Ende der Port-Liste).
		for (const r of schritt_io) {
			if (r.kind !== "step_input") continue;
			const src_node_id = node_id_by_step[r.target];
			const dst_node_id = node_id_by_step[r.step_key];
			if (!src_node_id || !dst_node_id) continue;
			const src_meta = port_meta_by_node[r.target];
			const src_class = `output_${src_meta.payload_outputs.length + 1}`;
			const dst_class = `input_${all_input_fields.length + 1}`;
			try {
				editor.addConnection(src_node_id, dst_node_id, src_class, dst_class);
			} catch (e) {
				console.warn("process_editor: addConnection (step_input) failed", e);
			}
		}

		// 3c. Port-Styling: leere payload_input-Ports markieren + Titel-Tooltips setzen.
		// Drawflow rendert Ports als <div class="input input_N"></div> ohne Field-Bezug,
		// daher walken wir die DOM-Elemente nach addNode.
		for (const [id, info] of Object.entries(node_port_meta_for_styling)) {
			const node_el = container.querySelector(`#node-${id}`);
			if (!node_el) continue;
			const input_divs = node_el.querySelectorAll(".inputs > .input");
			input_divs.forEach((el, i) => {
				if (i < all_input_fields.length) {
					const f = all_input_fields[i];
					el.setAttribute("title", `payload_input: ${f}`);
					if (!info.active_inputs.has(f)) el.classList.add("pe-port-empty");
				} else {
					el.setAttribute("title", "step_input");
					el.classList.add("pe-port-generic");
				}
			});
			const output_divs = node_el.querySelectorAll(".outputs > .output");
			output_divs.forEach((el, i) => {
				if (i < info.payload_outputs.length) {
					el.setAttribute("title", `payload_output: ${info.payload_outputs[i]}`);
				} else {
					el.setAttribute("title", "step_done");
					el.classList.add("pe-port-generic");
				}
			});
		}

		// 4. Event-Handler
		let _position_save_timers = {};
		editor.on("nodeMoved", (id) => {
			const node = editor.getNodeFromId(id);
			const sk = node?.data?.step_key;
			if (!sk || sk === PROCESS_INPUTS_NODE) return;
			// Debounce 300ms pro Knoten
			clearTimeout(_position_save_timers[sk]);
			_position_save_timers[sk] = setTimeout(() => {
				on_save_position && on_save_position(sk, node.pos_x, node.pos_y);
			}, 300);
		});

		// Event-Handler werden BEWUSST nach den addConnection-Aufrufen oben registriert,
		// damit die initial-gezeichneten Edges keinen connectionCreated-Event ausloesen.
		const _reject_connection = (info, msg) => {
			if (msg) _toast(msg, "red");
			try {
				editor.removeSingleConnection(
					info.output_id,
					info.input_id,
					info.output_class,
					info.input_class
				);
			} catch (e) {
				console.warn("process_editor: removeSingleConnection failed", e);
			}
		};
		const _set_input_port_empty = (input_id, input_class, is_empty) => {
			const el = container.querySelector(`#node-${input_id} .inputs > .input.${input_class}`);
			if (!el) return;
			if (is_empty) el.classList.add("pe-port-empty");
			else el.classList.remove("pe-port-empty");
		};

		editor.on("connectionCreated", (info) => {
			if (read_only) {
				_reject_connection(info, __("Aktive Version — Edits sind nicht erlaubt."));
				return;
			}
			const src_node = editor.getNodeFromId(info.output_id);
			const dst_node = editor.getNodeFromId(info.input_id);
			const src_step = src_node?.data?.step_key;
			const dst_step = dst_node?.data?.step_key;
			const src_meta_node = port_meta_by_node[src_step];
			const dst_meta_node = port_meta_by_node[dst_step];
			if (!src_meta_node || !dst_meta_node) {
				_reject_connection(info);
				return;
			}
			const src_meta = src_meta_node.outputs[info.output_class];
			const dst_meta = dst_meta_node.inputs[info.input_class];
			if (!src_meta || !dst_meta) {
				_reject_connection(info);
				return;
			}

			// payload_output → payload_input: Field muss matchen,
			// dann idempotent payload_input-Zeile beim consumer anlegen.
			if (src_meta.kind === "payload_output" && dst_meta.kind === "payload_input") {
				if (src_meta.target !== dst_meta.target) {
					_reject_connection(
						info,
						__("Field-Mismatch: Output erzeugt '{0}', Input erwartet '{1}'.", [
							src_meta.target,
							dst_meta.target,
						])
					);
					return;
				}
				on_create_edge &&
					on_create_edge(
						{ kind: "payload_output", step_key: src_step, target: src_meta.target },
						{ kind: "payload_input", step_key: dst_step, target: dst_meta.target }
					);
				dst_meta.active = true;
				_set_input_port_empty(info.input_id, info.input_class, false);
				return;
			}
			// process_input → payload_input: Field muss matchen.
			if (src_meta.kind === "process_input" && dst_meta.kind === "payload_input") {
				if (src_meta.target !== dst_meta.target) {
					_reject_connection(
						info,
						__("Field-Mismatch: Process Input '{0}' passt nicht zu Input '{1}'.", [
							src_meta.target,
							dst_meta.target,
						])
					);
					return;
				}
				on_create_edge &&
					on_create_edge(
						{ kind: "process_input", step_key: PROCESS_INPUTS_NODE, target: src_meta.target },
						{ kind: "payload_input", step_key: dst_step, target: dst_meta.target }
					);
				dst_meta.active = true;
				_set_input_port_empty(info.input_id, info.input_class, false);
				return;
			}
			// step_done → step_input
			if (src_meta.kind === "step_done" && dst_meta.kind === "step_input") {
				on_create_edge &&
					on_create_edge(
						{ kind: "step_done", step_key: src_step },
						{ kind: "step_input", step_key: dst_step, target: src_step }
					);
				return;
			}
			_reject_connection(info, __("Diese Port-Kombination ist nicht erlaubt."));
		});

		editor.on("connectionRemoved", (info) => {
			if (read_only) return;
			const src_node = editor.getNodeFromId(info.output_id);
			const dst_node = editor.getNodeFromId(info.input_id);
			const src_step = src_node?.data?.step_key;
			const dst_step = dst_node?.data?.step_key;
			const src_meta_node = port_meta_by_node[src_step];
			const dst_meta_node = port_meta_by_node[dst_step];
			if (!src_meta_node || !dst_meta_node) return;
			const src_meta = src_meta_node.outputs[info.output_class];
			const dst_meta = dst_meta_node.inputs[info.input_class];
			if (!src_meta || !dst_meta) return;

			// payload_output → payload_input: payload_input-Zeile entfernen.
			// Der Producer-Output bleibt — er kann weitere Consumer haben.
			if (src_meta.kind === "payload_output" && dst_meta.kind === "payload_input") {
				on_delete_edge &&
					on_delete_edge(
						{ kind: "payload_output", step_key: src_step, target: src_meta.target },
						{ kind: "payload_input", step_key: dst_step, target: dst_meta.target }
					);
				dst_meta.active = false;
				_set_input_port_empty(info.input_id, info.input_class, true);
				return;
			}
			// process_input → payload_input: payload_input-Zeile entfernen.
			if (src_meta.kind === "process_input" && dst_meta.kind === "payload_input") {
				on_delete_edge &&
					on_delete_edge(
						{ kind: "process_input", step_key: PROCESS_INPUTS_NODE, target: src_meta.target },
						{ kind: "payload_input", step_key: dst_step, target: dst_meta.target }
					);
				dst_meta.active = false;
				_set_input_port_empty(info.input_id, info.input_class, true);
				return;
			}
			// step_done → step_input
			if (src_meta.kind === "step_done" && dst_meta.kind === "step_input") {
				on_delete_edge &&
					on_delete_edge(
						{ kind: "step_done", step_key: src_step },
						{ kind: "step_input", step_key: dst_step, target: src_step }
					);
			}
		});

		editor.on("nodeSelected", (id) => {
			const node = editor.getNodeFromId(id);
			const sk = node?.data?.step_key;
			if (sk && sk !== PROCESS_INPUTS_NODE && on_select_node) on_select_node(sk);
		});

		return { editor, port_meta_by_node };
	};
})();
