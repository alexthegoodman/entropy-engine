use entropy_engine::startup;
use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
    startup::run_game()
}
