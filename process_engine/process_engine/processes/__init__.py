from process_engine.process_engine.processes.engine import (
	BACKEND_LOCAL,
	BACKEND_TEMPORAL,
	STATUS_ABGESCHLOSSEN,
	STATUS_ABGESCHLOSSEN_BYPASS,
	STATUS_ABSCHLUSSPRUEFUNG,
	STATUS_IN_BEARBEITUNG,
	BaseProcessDocument,
	CompletionCheckResult,
	ProcessEngine,
	ProcessPluginRegistry,
	ProcessRuntimeConfig,
	ProcessTrigger,
	get_process_runtime_config,
	get_runtime_config_for_typ,
	register_process_runtime,
)


def ensure_process_runtimes_registered() -> None:
	"""Consumer-Apps registrieren ihre Process-Runtimes via Hook
	`process_engine_runtimes`. Beispiel in consumer-app hooks.py:

		process_engine_runtimes = [
			"hausverwaltung_peters.process_definitions.mieterwechsel.get_mieterwechsel_runtime",
		]

	Idempotenz wird vom registrierten Callable selbst gewaehrleistet
	(Modul-Level-Cache via `_RUNTIME = register_process_runtime(...)`).
	"""
	import frappe

	for callable_path in frappe.get_hooks("process_engine_runtimes") or []:
		path = (callable_path or "").strip()
		if not path:
			continue
		try:
			frappe.get_attr(path)()
		except Exception:
			frappe.log_error(
				title=f"process_engine: runtime registration failed ({path})",
				message=frappe.get_traceback(),
			)


__all__ = [
	"BACKEND_LOCAL",
	"BACKEND_TEMPORAL",
	"STATUS_ABGESCHLOSSEN",
	"STATUS_ABGESCHLOSSEN_BYPASS",
	"STATUS_ABSCHLUSSPRUEFUNG",
	"STATUS_IN_BEARBEITUNG",
	"BaseProcessDocument",
	"CompletionCheckResult",
	"ProcessEngine",
	"ProcessPluginRegistry",
	"ProcessRuntimeConfig",
	"ProcessTrigger",
	"ensure_process_runtimes_registered",
	"get_process_runtime_config",
	"get_runtime_config_for_typ",
	"register_process_runtime",
]
