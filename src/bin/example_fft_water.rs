#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/fft_water.js")
        .with_hot_reload(true)
        .with_title("FFT Water")
        .with_window_size(1600.0, 900.0)
        .with_window_icon("public/water1.png")
        .run()
        .expect("Couldn't run app");
}
