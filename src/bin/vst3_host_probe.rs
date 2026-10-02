//! VST3 discovery probe process for `audio::vst3`'s background scan.
//!
//! A tiny, single-shot binary that takes one `.vst3` path, runs the library's normal in-process
//! introspection (`vst3_host::get_detailed_plugin_info`) on it, and prints the result as one line
//! of JSON on stdout. `vst3_host::discovery::discover_plugins_safe` spawns this once per plugin so
//! a plugin that `abort()`s or makes a pure-virtual call during init kills *this* process instead
//! of the DAW. It mirrors the vendored `vst3-host` crate's own `vst3-host-probe` bin, but is built
//! here so it lands beside the other Entropy binaries (`cargo build` builds it; deployed builds
//! ship it next to the app executable).

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: vst3-host-probe <path-to-plugin.vst3>");
        return ExitCode::from(2);
    };
    let path = PathBuf::from(path);

    match vst3_host::get_detailed_plugin_info(&path) {
        Ok(info) => match serde_json::to_string(&info) {
            Ok(json) => {
                // One JSON object on one line - the parent reads exactly this.
                println!("{json}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("failed to serialize plugin info: {e}");
                ExitCode::from(3)
            }
        },
        Err(e) => {
            eprintln!("failed to introspect {}: {e}", path.display());
            ExitCode::FAILURE
        }
    }
}
