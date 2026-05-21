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
  // REUSE the existing root for this container and just re-render with fresh
  // props. The host (prozess_version.js) calls _render_visual_editor after every
  // structural change (add/delete step/field/IO). Re-using the root lets React
  // reconcile the new data while PRESERVING component state — zoom/pan, selection,
  // open dialogs — instead of tearing the whole tree down (which reset the view,
  // "der Editor lädt neu / der Zoom springt zurück"). createRoot only runs once,
  // on the first mount into a given container (the host keeps the container stable).
  let root = mountedRoots.get(container);
  if (!root) {
    root = ReactDOM.createRoot(container);
    mountedRoots.set(container, root);
  }
  root.render(<App {...props} />);
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
