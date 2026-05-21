// Build script for the React-based visual editor.
//
// Usage (in src_react/):
//   npm install
//   npm run build       # one-shot production bundle
//   npm run watch       # watch mode (for development)
//
// Output:
//   ../process_engine/public/js/process_editor_react.bundle.js
//   ../process_engine/public/css/process_editor_react.css
//
// The bundle exposes a global ProcessEditorReact with .mount(container, props)
// — see prozess_version.js wiring in INTEGRATION.md.

import esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outJs = "../process_engine/public/js/process_editor_react.bundle.js";
const outCss = "../process_engine/public/css/process_editor_react.css";

const opts = {
  entryPoints: ["./index.jsx"],
  bundle: true,
  format: "iife",
  globalName: "ProcessEditorReact",
  loader: { ".jsx": "jsx" },
  jsx: "automatic",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  target: ["es2019"],
  outfile: outJs,
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  logLevel: "info",
};

await mkdir("../process_engine/public/js", { recursive: true });
await mkdir("../process_engine/public/css", { recursive: true });

async function copyCss() {
  await copyFile("./styles.css", outCss);
  console.log(`  → ${outCss}`);
}

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  await copyCss();
  console.log("Watching src_react/…  (Ctrl+C to stop)");
} else {
  await esbuild.build(opts);
  await copyCss();
  console.log("Built successfully.");
}
