#[cfg(target_os = "windows")]
use entropy_engine::startup;

use std::error::Error;
use std::env;

fn main() -> Result<(), Box<dyn Error>> {
    #[cfg(target_os = "windows")]
    startup::run(None)?;

    #[cfg(not(target_os = "windows"))]
    Ok(())
}