#[cfg(target_os = "windows")]
use entropy_engine::startup;

use std::error::Error;
use std::env;

#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
           .with_bundle("examples/studio-bundle/dist/daw.js")
           .run()
           .expect("Couldn't run app");
}