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

/// The prelude every game translated from TypeScript runs on (scripts/ts2rhai.mjs).
pub fn ts_prelude() -> (String, String) {
    ("ts_prelude.rhai".to_string(), include_str!("../../examples/rhai/ts_prelude.rhai").to_string())
}

/// Nebula Kingdom, translated from examples/studio-bundle/src/games/nebula (the TypeScript game
/// is the source; regenerate with `node scripts/ts2rhai.mjs examples/rhai/nebula_kingdom/ts2rhai.json`),
/// with its renderer on the engine's native instance batches.
pub fn nebula_kingdom_sources() -> ScriptSources {
    let mut s = vec![ts_prelude()];
    s.extend(files!("nebula_kingdom": "nk_render_native.rhai", "nebula_kingdom.gen.rhai"));
    s
}

pub fn by_name(name: &str) -> Option<ScriptApp> {
    match name {
        "hello" => Some(ScriptApp::new("hello").with_title("Hello, Rhai").with_scripts(hello_sources())),
        "nebula-kingdom" => Some(ScriptApp::new("nebula-kingdom").with_title("NEBULA KINGDOM").with_window_size(1600.0, 900.0).with_scripts(nebula_kingdom_sources())),
        _ => None,
    }
}
