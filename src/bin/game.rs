#[cfg(target_os = "windows")]
use entropy_engine::startup;

use std::error::Error;
use std::env;

#[tokio::main]
async fn main() {
    let project_id = Some("5fa6dd47-4355-4de5-b5a3-a7f61e979fcc".to_string());
    
    #[cfg(target_os = "windows")]
    startup::run_game(project_id).expect("Couldn't run game");
}
