app_name = "process_engine"
app_title = "Process Engine"
app_publisher = "janis"
app_description = (
	"Generic process workflow engine for Frappe (DocTypes, DAG, task handlers, Temporal backend)"
)
app_email = "janispe10@gmail.com"
app_license = "MIT"
app_version = "0.0.1"


# Boot-Session: registriert die App-Trigger-Buttons im Frontend.
boot_session = "process_engine.process_engine.processes.triggers.add_to_boot"


# Global eingebunden in jeder Desk-Session — process_triggers.js liest die
# bootinfo-Trigger und haengt "Prozess starten"-Buttons an die jeweiligen
# Source-Doctypes (Mietvertrag, Wohnung, ...).
# pe_registry.js MUSS zuerst laden: legt window.process_engine.{config_widgets,
# action_dialogs, task_views} an, in die Doctype-JS und Consumer-Apps eintragen.
# print_format_picker.js registriert ein Config-Widget und MUSS nach pe_registry.js laden.
# Das React-Editor-Bundle wird NICHT global eingebunden, sondern lazy via frappe.require
# in prozess_version.js (analog dag_mermaid.js).
app_include_js = [
	"/assets/process_engine/js/pe_registry.js",
	"/assets/process_engine/js/process_triggers.js",
	"/assets/process_engine/js/print_format_picker.js",
	"/assets/process_engine/js/path_picker.js",
	"/assets/process_engine/js/derive_paths.js",
	"/assets/process_engine/js/fill_fields_picker.js",
]


app_include_css = [
	"/assets/process_engine/css/process_editor_react.css",
]


# Doctype-JS: prozess-spezifische Form-Skripte. JS-Asset-Pfade muessen mit
# /assets/process_engine/... beginnen, weil die App jetzt eigenstaendig ist.
doctype_js = {
	"Prozess Instanz": "process_engine/doctype/prozess_instanz/prozess_instanz.js",
	"Prozess Typ": "process_engine/doctype/prozess_typ/prozess_typ.js",
	"Prozess Version": "process_engine/doctype/prozess_version/prozess_version.js",
}


# Hook fuer Consumer-Apps: jede App, die ein Process-Runtime registrieren will,
# listet hier eine Callable. Process Engine ruft alle beim ersten Engine-Zugriff
# pro Request (idempotent).
#
# Beispiel-Eintrag in consumer_app/hooks.py:
#     process_engine_runtimes = [
#         "consumer_app.process_definitions.foo.get_foo_runtime",
#     ]
process_engine_runtimes = []
