use std::env;

/// Single entrypoint for every studio-bundle example, replacing one `src/bin/example_*.rs`
/// stub per example. Pick one with `cargo run --bin example -- <name>`.
#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    {
        let name = env::args().nth(1);

        let app = match name.as_deref() {
            Some("daw") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/daw.js"),
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
            Some("media-player") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/media_player.js")
                .with_title("Entropy Media Player")
                .with_window_size(1280.0, 760.0),
            Some("node-graph") => entropy_engine::EntropyApp::new()
                .with_bundle("examples/studio-bundle/dist/node_graph.js")
                .with_hot_reload(true)
                .with_title("Nocode Calculator")
                .with_window_size(1100.0, 700.0),
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
    "daw",
    "fft-river",
    "fft-water",
    "game2d",
    "level-editor-2d",
    "light-hive",
    "mcp-tools-demo",
    "media-player",
    "node-graph",
    "theme-gallery",
    "video-export-demo",
];
