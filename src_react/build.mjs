// Build script for the React-based Process Engine UIs.
//
// Builds two bundles:
//   1. Process-Version Editor    — entry: index.jsx          → ProcessEditorReact
//   2. Process-Instance Viewer   — entry: index-instance.jsx → ProcessInstanceReact
//
// Usage (in src_react/):
//   npm install
//   npm run build       # one-shot production bundle for both
//   npm run watch       # watch mode (rebuilds on file change)
//
// Outputs (committed to the app repo so bench deploys don't need Node):
//   ../process_engine/public/js/process_editor_react.bundle.js
//   ../process_engine/public/js/process_instance_react.bundle.js
//   ../process_engine/public/css/process_editor_react.css
//   ../process_engine/public/css/process_instance_react.css
//
// CSS handling: each bundle gets its own CSS file. The instance CSS depends on
// tokens from styles.css, so we concatenate styles.css + instance.css into
// process_instance_react.css so app code only has to include one file.

import esbuild from "esbuild";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const OUT_JS  = "../process_engine/public/js";
const OUT_CSS = "../process_engine/public/css";

const targets = [
  {
    name: "editor",
    entry: "./index.jsx",
    global: "ProcessEditorReact",
    outJs: `${OUT_JS}/process_editor_react.bundle.js`,
    outCss: `${OUT_CSS}/process_editor_react.css`,
    cssSources: ["./styles.css"],
  },
  {
    name: "instance",
    entry: "./index-instance.jsx",
    global: "ProcessInstanceReact",
    outJs: `${OUT_JS}/process_instance_react.bundle.js`,
    outCss: `${OUT_CSS}/process_instance_react.css`,
    cssSources: ["./styles.css", "./instance.css"],
  },
];

await mkdir(OUT_JS, { recursive: true });
await mkdir(OUT_CSS, { recursive: true });

function commonOpts(t) {
  return {
    entryPoints: [t.entry],
    bundle: true,
    format: "iife",
    globalName: t.global,
    loader: { ".jsx": "jsx" },
    jsx: "automatic",
    minify: !watch,
    sourcemap: watch ? "inline" : false,
    target: ["es2019"],
    outfile: t.outJs,
    define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
    logLevel: "info",
  };
}

async function buildCss(t) {
  // Concatenate (in order) so dependent stylesheets can reference tokens
  // defined earlier.
  const parts = await Promise.all(t.cssSources.map((p) => readFile(p, "utf-8")));
  await writeFile(
    t.outCss,
    `/* Built from: ${t.cssSources.join(", ")} — do not edit. */\n${parts.join("\n\n")}`,
    "utf-8"
  );
  console.log(`  → ${t.outCss}`);
}

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context(commonOpts(t));
    await ctx.watch();
    await buildCss(t);
  }
  console.log("Watching src_react/…  (Ctrl+C to stop)");
} else {
  for (const t of targets) {
    console.log(`\nBuilding ${t.name}…`);
    await esbuild.build(commonOpts(t));
    await buildCss(t);
  }
  console.log("\nBuilt successfully.");
}
