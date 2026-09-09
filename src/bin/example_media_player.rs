#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/media_player.js")
        .with_title("Entropy Media Player")
        .with_window_size(1280.0, 760.0)
        .run()
        .expect("Couldn't run app");
}
