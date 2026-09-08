#[cfg(target_os = "windows")]
use entropy_engine::startup;

#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/fft_water.js")
        .run()
        .expect("Couldn't run app");
}
