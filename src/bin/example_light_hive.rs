#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/light_hive.js")
        .with_title("Light Hive")
        .with_window_size(1600.0, 900.0)
        // The demo scene loads a real .glb (better shows off the point-light shader presets
        // than flat primitives) - points Entropy.Model.load straight at this folder, no
        // project-id indirection. See EntropyApp::with_art_assets_dir's doc comment.
        .with_art_assets_dir(r"C:\Users\alext\Documents\CommonOS\midpoint\projects\cmk7vjg1n000004jrh8ajdbyb\models")
        .run()
        .expect("Couldn't run app");
}
