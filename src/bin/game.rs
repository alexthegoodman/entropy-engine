#[cfg(not(target_arch = "wasm32"))]
use entropy_engine::startup;

use std::error::Error;
use std::env;

#[tokio::main]
async fn main() {
    let project_id = Some("cmk7vjg1n000004jrh8ajdbyb".to_string());
    
    #[cfg(not(target_arch = "wasm32"))]
    startup::run_game(project_id, None).expect("Couldn't run game");
}
