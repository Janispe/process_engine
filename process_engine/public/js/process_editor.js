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
	// port_count = Anzahl Input-Ports pro Knoten (steuert den vertikalen Stride,
	// damit hohe Knoten mit vielen payload-Ports nicht ueberlappen).
	function _topological_layout(schritte, schritt_io, port_count) {
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
		const STRIDE_X = 320;
		// Knotenhoehe ~ Header (50px) + Ports * 22px. Stride mit Puffer, min 150.
		const STRIDE_Y = Math.max(150, 70 + ((port_count || 0) + 1) * 22);
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
		// outputs = aktive payload_outputs + generic step_done. Ein neuer payload_output
		// (Producer) wird im Step-Inspector deklariert ("+ Output deklarieren") und erscheint
		// danach hier als Output-Port.
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

	// Taggt eine Drawflow-Verbindung als Daten- bzw. Reihenfolge-Kante.
	// Drawflow vergibt der Connection-SVG die Klassen
	//   connection node_out_node-<srcId> node_in_node-<dstId> <srcClass> <dstClass>
	// Wir escapen jedes Klassen-Token komplett (CSS.escape), nicht nur Teile davon, sonst
	// zerbricht ein Token wie "node_out_node-3". Findet der Selector nichts (z.B. Drawflow-
	// Upgrade), ist es ein stiller No-op — die Kante bleibt neutral statt zu werfen.
	function _classify_edge(container, srcId, dstId, srcClass, dstClass, kind) {
		const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s));
		const cls = (t) => "." + esc(t);
		const sel =
			".connection" +
			cls("node_out_node-" + srcId) +
			cls("node_in_node-" + dstId) +
			cls(srcClass) +
			cls(dstClass);
		let el = null;
		try {
			el = container.querySelector(sel);
		} catch (e) {
			return;
		}
		if (el) el.classList.add(kind === "order" ? "pe-edge-order" : "pe-edge-data");
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

		// Auto-Layout: Frappe Float-Felder defaulten auf 0 (NICHT null), daher gilt ein
		// Knoten nur als manuell positioniert, wenn editor_x ODER editor_y != 0 ist.
		// Sonst landen alle Knoten auf 0,0 (gestapelt). auto_pos wird immer berechnet
		// (billig fuer kleine Graphen), damit auch einzelne ungesetzte Knoten Platz kriegen.
		const _has_saved_pos = (s) => Boolean(Number(s.editor_x)) || Boolean(Number(s.editor_y));

		// all_input_fields = Union aus deklarierten payload_field_specs UND den in schritt_io
		// tatsaechlich referenzierten payload-Feldern. Robust auch wenn payload_field_specs
		// (noch) leer ist — dann zeigt der Editor trotzdem den realen Datenfluss.
		const spec_fields = (payload_field_specs || [])
			.map((s) => (s.fieldname || "").trim())
			.filter(Boolean);
		const io_payload_fields = schritt_io
			.filter((r) => r.kind === "payload_input" || r.kind === "payload_output")
			.map((r) => (r.target || "").trim())
			.filter(Boolean);
		const all_input_fields = Array.from(new Set([...spec_fields, ...io_payload_fields])).sort();

		// auto_pos immer berechnen (billig); vertikaler Stride richtet sich nach Port-Zahl.
		const auto_pos = _topological_layout(schritte, schritt_io, all_input_fields.length);

		// Process-Inputs: Felder die irgendwo konsumiert/deklariert sind, aber von keinem
		// Task als payload_output produziert werden (= externe Eingaben).
		const output_fields = new Set(
			schritt_io.filter((r) => r.kind === "payload_output").map((r) => (r.target || "").trim())
		);
		const consumed_or_declared = new Set([
			...spec_fields,
			...schritt_io
				.filter((r) => r.kind === "payload_input")
				.map((r) => (r.target || "").trim()),
		]);
		const process_input_fields = Array.from(consumed_or_declared).filter(
			(f) => f && !output_fields.has(f)
		);

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
			const saved = _has_saved_pos(step);
			const x = saved ? Number(step.editor_x) : (auto_pos[sk]?.x ?? 300);
			const y = saved ? Number(step.editor_y) : (auto_pos[sk]?.y ?? 40);
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
			node_port_meta_for_styling[id] = { active_inputs, payload_outputs, step_key: sk };
		}

		// Schritte ohne jegliche I/O-Deklaration markieren (visueller "verdrahten"-Hinweis).
		const io_step_keys = new Set(
			schritt_io.map((r) => (r.step_key || "").trim()).filter(Boolean)
		);

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
				_classify_edge(container, src_node_id, dst_node_id, src_class, dst_class, "data");
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
				_classify_edge(container, src_node_id, dst_node_id, src_class, dst_class, "order");
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
			// data-step-key ermoeglicht In-place-Label-Updates aus dem Inspector
			// (ohne kompletten Canvas-Re-render), siehe prozess_version.js.
			if (info.step_key) node_el.setAttribute("data-step-key", info.step_key);
			// Im fixed-Mode (read_only) feuert Drawflow kein nodeSelected — fuer das
			// read-only Inspizieren gesperrter Versionen Node-Klick manuell verdrahten.
			if (read_only && info.step_key && on_select_node) {
				node_el.addEventListener("click", () => on_select_node(info.step_key));
			}
			if (info.step_key && !io_step_keys.has(info.step_key)) {
				node_el.classList.add("pe-node-no-io");
			}
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

		// 3d. Process-Inputs-Ports: ungelesene Inputs (kein Schritt fuehrt sie als
		// payload_input) markieren — sie bleiben sichtbar (Drag-to-wire), aber als
		// "verfuegbar, ungenutzt" gekennzeichnet statt als lose Enden. Reihenfolge der
		// Output-Ports + Body-.pe-kv entspricht sorted_pi_fields.
		const pi_id = node_id_by_step[PROCESS_INPUTS_NODE];
		if (pi_id != null) {
			const consumed_inputs = new Set(
				schritt_io
					.filter((r) => r.kind === "payload_input")
					.map((r) => (r.target || "").trim())
					.filter(Boolean)
			);
			const pi_node_el = container.querySelector(`#node-${pi_id}`);
			if (pi_node_el) {
				pi_node_el.querySelectorAll(".outputs > .output").forEach((el, i) => {
					const f = sorted_pi_fields[i];
					if (f && !consumed_inputs.has(f)) {
						el.classList.add("pe-port-unused");
						el.setAttribute("title", `process_input (nicht gelesen): ${f}`);
					}
				});
				pi_node_el.querySelectorAll(".pe-node-body .pe-kv").forEach((el, i) => {
					const f = sorted_pi_fields[i];
					if (f && !consumed_inputs.has(f)) el.classList.add("pe-input-unused");
				});
			}
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
				_classify_edge(container, info.output_id, info.input_id, info.output_class, info.input_class, "data");
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
				_classify_edge(container, info.output_id, info.input_id, info.output_class, info.input_class, "data");
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
				_classify_edge(container, info.output_id, info.input_id, info.output_class, info.input_class, "order");
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
