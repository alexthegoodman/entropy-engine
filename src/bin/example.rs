use std::env;

/// Single entrypoint for every studio-bundle example, replacing one `src/bin/example_*.rs`
/// stub per example. Pick one with `cargo run --bin example -- <name>`.
#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    {
        let name = env::args().nth(1);

        let app = match name.as_deref() {
            Some("canvas-surface-demo") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/canvas_surfaces.js")
                .with_hot_reload(true)
                .with_title("Canvas Surfaces")
                .with_window_size(1400.0, 900.0)
                // Same reasoning as cc-manager's own with_data_dir below: a standalone
                // EntropyApp has neither a dev data_dir nor a loaded project by default, so
                // Entropy.IO.save/load (see canvas_surface_addon.ts's Save/Load Scene buttons)
                // would silently no-op without this.
                .with_data_dir(env::var("ENTROPY_CANVAS_BDD_DATA").unwrap_or_else(|_| "../canvas-surfaces-data".to_string())),
            Some("cc-manager") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/cc_manager.js")
                .with_hot_reload(true)
                .with_title("CC Manager")
                .with_window_size(1240.0, 800.0)
                // `tasks.json` lands at `<repo root>/cc-manager/tasks.json` - a plain,
                // predictable path a Claude Code session can read/edit directly (see
                // `Entropy.IO.save`/`.load` in cc_manager_addon.ts and op_addon_save_data's
                // dev-controlled-data_dir path in src/deno/addon_ops.rs).
                .with_data_dir("../cc-manager"),
            Some("daw") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/daw.js")
                .with_title("DAW")
                .with_window_size(1400.0, 900.0)
                // Without a data_dir a standalone EntropyApp has nowhere for Entropy.IO.save/load
                // to go, so the DAW project (and any hosted plugin's saved patch) silently never
                // persisted. ENTROPY_DAW_BDD_DATA lets tests/vst3_live start from a clean folder.
                .with_data_dir(env::var("ENTROPY_DAW_BDD_DATA").unwrap_or_else(|_| "../daw-data".to_string())),
            Some("doc-editor-demo") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/doc_editor_demo.js")
                .with_hot_reload(true)
                .with_title("Document Editor Demo")
                .with_window_size(1000.0, 820.0),
            Some("fft-river") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/fft_river.js")
                .with_title("FFT River")
                .with_window_size(1600.0, 900.0),
            Some("fft-water") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/fft_water.js")
                .with_hot_reload(true)
                .with_title("FFT Water")
                .with_window_size(1600.0, 900.0)
                .with_window_icon("public/water1.png"),
            Some("game2d") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/game2d.js")
                .with_title("Entropy 2D Arena")
                .with_window_size(1280.0, 800.0),
            Some("level-editor-2d") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/level_editor_2d.js")
                .with_title("Entropy 2D Level Editor")
                .with_window_size(1300.0, 900.0)
                .with_data_dir("examples/studio-bundle/data/level_editor_2d"),
            Some("light-hive") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/light_hive.js")
                .with_title("Light Hive")
                .with_window_size(1600.0, 900.0)
                // The demo scene loads a real .glb (better shows off the point-light shader
                // presets than flat primitives) - points Entropy.Model.load straight at this
                // folder, no project-id indirection. See EntropyApp::with_art_assets_dir's doc.
                .with_art_assets_dir(
                    r"C:\Users\alext\Documents\CommonOS\midpoint\projects\cmk7vjg1n000004jrh8ajdbyb\models",
                ),
            Some("mcp-tools-demo") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/mcp_demo.js")
                .with_title("MCP Tools Demo")
                .with_window_size(1000.0, 700.0),
            Some("html-ui-demo") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/html_ui_demo.js")
                .with_hot_reload(true)
                .with_title("HTML UI Experiment")
                .with_window_size(1600.0, 900.0),
            Some("keyframe-tracks-demo") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/keyframe_tracks_demo.js")
                .with_hot_reload(true)
                .with_title("Clip & Curve Editor")
                .with_window_size(1100.0, 760.0),
            Some("media-player") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/media_player.js")
                .with_title("Entropy Media Player")
                .with_window_size(1280.0, 760.0),
            Some("ml-graph-demo") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/ml_graph_demo.js")
                .with_hot_reload(true)
                .with_title("ML Graph Trainer")
                .with_window_size(1220.0, 780.0),
            Some("node-graph") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/node_graph.js")
                .with_hot_reload(true)
                .with_title("Nocode Calculator")
                .with_window_size(1100.0, 700.0),
            Some("stylus-drawing") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/stylus_drawing.js")
                .with_title("Stylus Drawing")
                .with_window_size(1280.0, 800.0),
            Some("theme-gallery") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/theme_gallery.js")
                .with_hot_reload(true)
                .with_title("Theme Gallery")
                .with_window_size(1000.0, 700.0),
            Some("video-export-demo") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/video_export_demo.js")
                .with_title("Video Export Demo")
                .with_window_size(1280.0, 720.0),
            other => {
                if let Some(name) = other {
                    eprintln!("Unknown example \"{name}\".\n");
                }
                eprintln!("Usage: cargo run --bin example -- <name>\n");
                eprintln!("Available examples:");
                for name in EXAMPLES {
                    eprintln!("  {name}");
                }
                std::process::exit(1);
            }
        };

        app.run().expect("Couldn't run app");
    }
}

#[cfg(target_os = "windows")]
const EXAMPLES: &[&str] = &[
    "canvas-surface-demo",
    "cc-manager",
    "daw",
    "doc-editor-demo",
    "fft-river",
    "fft-water",
    "game2d",
    "html-ui-demo",
    "keyframe-tracks-demo",
    "level-editor-2d",
    "light-hive",
    "mcp-tools-demo",
    "media-player",
    "ml-graph-demo",
    "node-graph",
    "stylus-drawing",
    "theme-gallery",
    "video-export-demo",
];
