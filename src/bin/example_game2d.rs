#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/game2d.js")
        .with_title("Entropy 2D Arena")
        .with_window_size(1280.0, 800.0)
        .run()
        .expect("Couldn't run app");
}
