#[cfg(not(target_arch = "wasm32"))]
use entropy_engine::startup;

use std::error::Error;
use std::env;

#[tokio::main]
async fn main() {
    #[cfg(not(target_arch = "wasm32"))]
    startup::run(None).expect("Couldn't run editor");
}