#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/light_hive.js")
        .with_title("Light Hive")
        .with_window_size(1600.0, 900.0)
        // The demo scene loads a real .glb (better shows off the point-light shader presets
        // than flat primitives) from this MidPoint asset project - see
        // EntropyApp::with_art_assets_project's doc comment for what this id actually is.
        .with_art_assets_project("cmk7vjg1n000004jrh8ajdbyb")
        .run()
        .expect("Couldn't run app");
}
