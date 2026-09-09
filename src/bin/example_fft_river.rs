#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/fft_river.js")
        .with_title("FFT River")
        .with_window_size(1600.0, 900.0)
        .run()
        .expect("Couldn't run app");
}
