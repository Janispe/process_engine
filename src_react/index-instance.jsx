// Mount entry point for the bundled instance view.
//
// esbuild compiles this to an IIFE exposing window.ProcessInstanceReact.
// Use ProcessInstanceReact.mount(container, props) from prozess_instanz.js.
//
// Also spiegelt die Task-Action-Widget-Registry auf
//   window.process_engine.register_task_action_widget(name, Component)
// damit App-Code (außerhalb des Bundles) eigene Widgets registrieren kann
// — analog zu register_config_widget im Editor.

import React from "react";
import ReactDOM from "react-dom/client";
import { InstanceApp } from "./instance-shell.jsx";
import {
  registerTaskActionWidget,
  getTaskActionWidget,
  taskActionRegistry,
} from "./instance-task-widgets.jsx";

// Expose the registry on the global namespace so app code can plug in custom
// widgets the same way `register_config_widget` works in the editor.
window.process_engine = window.process_engine || {};
window.process_engine.task_action_widgets = taskActionRegistry;
window.process_engine.register_task_action_widget = registerTaskActionWidget;
window.process_engine.get_task_action_widget = getTaskActionWidget;

const mountedRoots = new WeakMap();

export function mount(container, props) {
  if (!container) {
    throw new Error("ProcessInstanceReact.mount: container is required");
  }
  const existing = mountedRoots.get(container);
  if (existing) {
    existing.unmount();
    mountedRoots.delete(container);
  }
  const root = ReactDOM.createRoot(container);
  root.render(<InstanceApp {...props} />);
  mountedRoots.set(container, root);
  return {
    unmount() {
      root.unmount();
      mountedRoots.delete(container);
    },
  };
}

export function unmount(container) {
  const root = mountedRoots.get(container);
  if (root) {
    root.unmount();
    mountedRoots.delete(container);
  }
}

// Re-export the registry hooks so app code can `import { … } from "…"`
// if they bundle on their side.
export { registerTaskActionWidget, getTaskActionWidget };
