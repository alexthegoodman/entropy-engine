//! Live tier for VST3 hosting: launches the real compiled DAW (`example daw`) twice against a clean
//! data folder. The first run is scripted by `tests/features/vst3_live.feature` through the same
//! Gherkin-driven in-engine driver the browser and canvas suites use (`BrowserBddDriver` in
//! `src/startup.rs`); the second, `vst3_live_restore.feature`, reopens what the first one saved.
//!
//! Assertions read three independent things: the hosted plugins' own audio-side counters (peak,
//! blocks rendered, notes received - written into `result.json` by the driver), the project the
//! addon persisted to disk, and the screenshots (composited frames plus native editor windows).
//! Needs a real audio device and an interactive desktop, like the other live suites.

#[path = "common/daw_saved.rs"]
mod daw_saved;

use std::{fs, path::Path, process::Command};

fn run_daw(root: &Path, data: &Path, feature: Option<&str>) -> serde_json::Value {
    let result_path = root.join(format!("result-{}.json", feature.unwrap_or("main")));
    let _ = fs::remove_file(&result_path);
    let mut command = Command::new(env!("CARGO_BIN_EXE_example"));
    command
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", data);
    if let Some(feature) = feature {
        command.env("ENTROPY_DAW_BDD_FEATURE", feature);
    }
    let mut child = command.spawn().expect("launch the DAW");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > std::time::Duration::from_secs(300) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("DAW live BDD ({feature:?}) timed out before the engine finished its feature");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "the DAW exited with {status}");
    serde_json::from_slice(&fs::read(&result_path).expect("result json")).expect("valid result json")
}

fn instrument<'a>(project: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    project["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["instrument"]["name"] == name)
        .unwrap_or_else(|| panic!("no track saved with the {name} instrument"))
}

#[test]
fn vst3_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("vst3-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();

    // ---- Run 1: load, play, edit, save ----
    let result = run_daw(&root, &data, None);
    assert_eq!(result["status"], "passed", "{result:#}");

    for artifact in result["artifacts"].as_array().unwrap() {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{artifact} is not a PNG");
    }

    // Every plugin editor window was really found and really had pixels in it.
    let captures = result["editor_captures"].as_array().unwrap();
    assert_eq!(captures.len(), 3, "{captures:#?}");
    for capture in captures {
        assert_eq!(capture["outcome"], "captured", "{capture:#}");
        assert!(capture["capture"]["distinctColors"].as_u64().unwrap() > 50, "editor looks blank: {capture:#}");
        println!("  editor {} captured via {}: {}x{}, {} colours", capture["name"], capture["capture"]["method"], capture["capture"]["width"], capture["capture"]["height"], capture["capture"]["distinctColors"]);
    }

    // The audio side's own counters: each plugin rendered blocks on the real audio thread and was
    // sent the preview note. Vital and Massive must have produced sound; Maschine has no kit loaded
    // in a fresh project, so it is only required to have been driven, not to be audible.
    let stats = result["vst3"].as_array().unwrap();
    assert_eq!(stats.len(), 3, "{stats:#?}");
    for plugin in stats {
        let name = plugin["plugin"].as_str().unwrap();
        let blocks = plugin["blocks"].as_u64().unwrap();
        let peak = plugin["lifetimePeak"].as_f64().unwrap();
        println!("  {name}: {blocks} blocks, {} skipped, {} notes, peak {peak:.4}", plugin["skippedBlocks"], plugin["notesSent"]);
        assert!(blocks > 100, "{name} was barely pulled by the audio thread: {blocks} blocks");
        match name {
            "Vital" | "Massive" => {
                assert!(plugin["notesSent"].as_u64().unwrap() >= 1, "{name} never got a note");
                assert!(peak > 0.01, "{name} was silent: peak {peak}");
            }
            _ => {}
        }
    }

    // The addon persisted the project with each track's plugin choice and patch state.
    let project: serde_json::Value = daw_saved::open_song(&data);
    for name in ["Vital", "Massive", "Maschine 3"] {
        let saved = instrument(&project, name);
        let state_len = saved["instrument"]["state"].as_str().map(str::len).unwrap_or(0);
        println!("  saved {name}: {state_len} base64 chars of plugin state");
        assert!(state_len > 100, "{name}'s patch state was not saved into the project");
    }

    // ---- Run 2: a fresh process reopens the saved project ----
    let restored = run_daw(&root, &data, Some("restore"));
    assert_eq!(restored["status"], "passed", "{restored:#}");
    let stats = restored["vst3"].as_array().unwrap();
    let names: Vec<&str> = stats.iter().map(|p| p["plugin"].as_str().unwrap()).collect();
    println!("  restored run loaded: {names:?}");
    for name in ["Vital", "Massive", "Maschine 3"] {
        assert!(names.contains(&name), "{name} was not reloaded from the saved project: {names:?}");
    }
    let vital = stats.iter().find(|p| p["plugin"] == "Vital").unwrap();
    assert!(vital["notesSent"].as_u64().unwrap() >= 1);
    assert!(vital["lifetimePeak"].as_f64().unwrap() > 0.01, "the restored Vital was silent");
    assert_eq!(restored["editor_captures"][0]["outcome"], "captured", "{:#}", restored["editor_captures"]);

    println!("VST3 live BDD passed; artifacts: {}", root.display());
}
