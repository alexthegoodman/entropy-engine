use entropy_engine::startup;
use std::error::Error;
use std::env;

fn main() -> Result<(), Box<dyn Error>> {
    let project_id = Some("5fa6dd47-4355-4de5-b5a3-a7f61e979fcc".to_string());
    startup::run_game(project_id)
}
