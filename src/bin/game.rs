#[cfg(target_os = "windows")]
use entropy_engine::startup;

use std::error::Error;
use std::env;

#[tokio::main]
async fn main() {
    let project_id = Some("cmk7vjg1n000004jrh8ajdbyb".to_string());
    
    #[cfg(target_os = "windows")]
    startup::run_game(project_id).expect("Couldn't run game");
}
