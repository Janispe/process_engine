// Mount entry point for the bundled editor.
//
// esbuild compiles this to an IIFE exposing window.ProcessEditorReact.
// Use ProcessEditorReact.mount(container, props) from prozess_version.js.

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./editor-shell.jsx";

const mountedRoots = new WeakMap();

export function mount(container, props) {
  if (!container) {
    throw new Error("ProcessEditorReact.mount: container is required");
  }
  // If we already mounted into this container, unmount first to avoid the
  // "createRoot() called twice" warning. The host (prozess_version.js) calls
  // _render_visual_editor repeatedly after data changes — re-mounting is the
  // normal path.
  const existing = mountedRoots.get(container);
  if (existing) {
    existing.unmount();
    mountedRoots.delete(container);
  }
  const root = ReactDOM.createRoot(container);
  root.render(<App {...props} />);
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
