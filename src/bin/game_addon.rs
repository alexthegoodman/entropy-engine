#[cfg(target_os = "windows")]
use entropy_engine::startup;

use std::error::Error;
use std::env;

#[tokio::main]
async fn main() {
    // We launch "The Fractured Realm" (fps_rpg) directly
    let addon_name = Some("The Fractured Realm".to_string());

    // used for file storage and reading, may remove later for another approach
    let project_id = Some("cmk7vjg1n000004jrh8ajdbyb".to_string());
    
    #[cfg(target_os = "windows")]
    startup::run_game(project_id, addon_name).expect("Couldn't run game addon");
}
