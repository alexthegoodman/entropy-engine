#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/level_editor_2d.js")
        .with_title("Entropy 2D Level Editor")
        .with_window_size(1300.0, 900.0)
        .with_data_dir("examples/studio-bundle/data/level_editor_2d")
        .run()
        .expect("Couldn't run app");
}
