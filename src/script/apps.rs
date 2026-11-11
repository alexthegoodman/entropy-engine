//! The Rhai apps compiled into the engine, so a browser build can start them by name without
//! being handed any code. Each is a list of script files, compiled in order into one script.

use super::app::{ScriptApp, ScriptSources};

pub const NAMES: &[&str] = &["hello", "nebula-kingdom"];

macro_rules! files {
    ($dir:literal: $($f:literal),* $(,)?) => {
        vec![$(($f.to_string(), include_str!(concat!("../../examples/rhai/", $dir, "/", $f)).to_string())),*]
    };
}

pub fn hello_sources() -> ScriptSources {
    files!("hello": "main.rhai")
}

pub fn nebula_kingdom_sources() -> ScriptSources {
    files!("nebula_kingdom": "nk_math.rhai", "nk_data.rhai", "nk_world.rhai", "nk_game.rhai", "nk_shader.rhai", "nk_render.rhai", "nk_scene.rhai", "nk_ui.rhai", "nk_hud.rhai", "nk_audio.rhai", "main.rhai")
}

pub fn by_name(name: &str) -> Option<ScriptApp> {
    match name {
        "hello" => Some(ScriptApp::new("hello").with_title("Hello, Rhai").with_scripts(hello_sources())),
        "nebula-kingdom" => Some(ScriptApp::new("nebula-kingdom").with_title("NEBULA KINGDOM").with_window_size(1600.0, 900.0).with_scripts(nebula_kingdom_sources())),
        _ => None,
    }
}
