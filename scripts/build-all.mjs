import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const studio = path.join(root, "examples", "studio-bundle");
const dist = path.join(studio, "dist");
const cargoArgs = process.argv.slice(2);
const bundleJobs = Number(process.env.ENTROPY_BUNDLE_JOBS ?? 3);

if (!Number.isSafeInteger(bundleJobs) || bundleJobs < 1) {
  console.error("ENTROPY_BUNDLE_JOBS must be a positive integer.");
  process.exit(1);
}

// Keep this list aligned with the bundle paths in src/bin/example.rs.
const bundles = [
  ["app-launcher", "src/apps/app_launcher_addon.ts", "app_launcher.js"],
  ["canvas-surface-demo", "src/apps/canvas_surfaces/canvas_surface_addon.ts", "canvas_surfaces.js"],
  ["cc-manager", "src/apps/cc_manager_addon.ts", "cc_manager.js"],
  ["daw", "src/apps/daw_synth_addon.ts", "daw.js"],
  ["doc-editor-demo", "src/apps/doc_editor_demo_addon.ts", "doc_editor_demo.js"],
  ["fft-river", "src/apps/fft_river_water_addon.ts", "fft_river.js"],
  ["fft-water", "src/apps/fft_water_addon.ts", "fft_water.js"],
  ["game2d", "src/games/game2d/index.ts", "game2d.js"],
  ["guitar-tabs", "src/apps/tabs/tabs_addon.ts", "guitar_tabs.js"],
  ["html-ui-demo", "src/apps/html_ui_demo_addon.ts", "html_ui_demo.js"],
  ["keyframe-tracks-demo", "src/apps/keyframe_tracks_demo_addon.ts", "keyframe_tracks_demo.js"],
  ["level-editor-2d", "src/games/level_editor_2d/index.ts", "level_editor_2d.js"],
  ["light-hive", "src/apps/light_hive_addon.ts", "light_hive.js"],
  ["mcp-tools-demo", "src/apps/mcp_tools_demo_addon.ts", "mcp_demo.js"],
  ["media-player", "src/apps/media_player_addon.ts", "media_player.js"],
  ["mesha", "src/apps/mesha/mesha_addon.ts", "mesha.js"],
  ["ml-graph-demo", "src/apps/ml_graph_demo_addon.ts", "ml_graph_demo.js"],
  ["node-graph", "src/apps/node_graph_addon.ts", "node_graph.js"],
  ["quadplanet", "src/apps/quadplanet/quadplanet_addon.ts", "quadplanet.js"],
  ["sheet", "src/apps/sheet/sheet_addon.ts", "sheet.js"],
  ["special-bundle", "src/special_bundle.ts", "special_bundle.js"],
  ["stylus-drawing", "src/apps/stylus_drawing_addon.ts", "stylus_drawing.js"],
  ["theme-gallery", "src/apps/theme_gallery_addon.ts", "theme_gallery.js"],
  ["video-export-demo", "src/apps/video_export_demo_addon.ts", "video_export_demo.js"],
];

function run(command, args, cwd, label) {
  console.log(`[${label}] ${command} ${args.join(" ")}`);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", (error) => {
      console.error(`[${label}] ${error.message}`);
      resolve(false);
    });
    child.once("exit", (code, signal) => {
      if (code !== 0) console.error(`[${label}] failed (${signal ?? `exit ${code}`})`);
      resolve(code === 0);
    });
  });
}

async function bundle(label, entry, output) {
  const destination = path.join(dist, output);
  const temporary = path.join(dist, `.${output}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    if (!(await run("deno", ["bundle", entry, "--output", temporary], studio, label))) return false;
    await rename(temporary, destination);
    return true;
  } catch (error) {
    console.error(`[${label}] ${error.message}`);
    return false;
  } finally {
    await rm(temporary, { force: true });
  }
}

await mkdir(dist, { recursive: true });

// Rust embeds this bundle with include_str!, so it must finish before Cargo starts.
if (!(await bundle("studio", "src/index.ts", "bundle.js"))) {
  console.error("Default Studio bundle failed; Cargo was not started.");
  process.exitCode = 1;
} else {
  const failures = [];
  const cargo = run("cargo", ["build", ...cargoArgs], root, "cargo").then((ok) => {
    if (!ok) failures.push("cargo build");
  });

  let next = 0;
  async function worker() {
    while (next < bundles.length) {
      const [label, entry, output] = bundles[next++];
      if (!(await bundle(label, entry, output))) failures.push(label);
    }
  }

  await Promise.all([cargo, ...Array.from({ length: Math.min(bundleJobs, bundles.length) }, worker)]);
  if (failures.length) {
    console.error(`Build failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Build complete: Cargo and ${bundles.length + 1} addon bundles.`);
  }
}
