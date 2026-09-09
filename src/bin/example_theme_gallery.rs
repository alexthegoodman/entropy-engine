#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/theme_gallery.js")
        .with_hot_reload(true)
        .with_title("Theme Gallery")
        .with_window_size(1000.0, 700.0)
        .run()
        .expect("Couldn't run app");
}
