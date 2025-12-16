#[cfg(target_os = "windows")]
use entropy_engine::startup;

use std::error::Error;
use std::env;

#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    startup::run(None).expect("Couldn't run editor");
}