//! Live tier for the Guitar Tabs app: spawns the real compiled `example guitar-tabs` binary in
//! scripted test mode (see `tests/features/guitar_tabs_live.feature` and `BrowserBddDriver` in
//! src/startup.rs), then checks the driver's result.json: the screenshots, and what the app's own
//! `tabs_state` tool reported after each part of the run. The logic under it is covered without a
//! window by examples/studio-bundle/tests/guitar_tabs.test.ts; the neck by tests/fretboard_view.rs.
//! This proves the real bundle, the Rust<->JS event wiring and the widget work together.

use std::process::Command;

fn main() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("guitar-tabs-bdd-{}", std::process::id()));
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let _ = std::fs::remove_file(&result_path);

    let example = std::env::var_os("CARGO_BIN_EXE_example").expect("Cargo must provide the real example binary");
    let status = Command::new(example)
        .arg("guitar-tabs")
        .env("ENTROPY_TABS_BDD_RESULT", &result_path)
        .env("ENTROPY_TABS_BDD_DATA", &data)
        .status()
        .expect("launch the real Guitar Tabs app");
    assert!(status.success(), "the live Guitar Tabs app must exit cleanly: {status}");

    let result: serde_json::Value = serde_json::from_slice(&std::fs::read(&result_path).expect("live result JSON")).expect("valid result JSON");
    assert_eq!(result["status"], "passed", "{result:#}");

    let artifacts: Vec<String> = result["artifacts"].as_array().expect("artifact array").iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(artifacts.len(), 6, "{artifacts:?}");
    for artifact in &artifacts {
        let bytes = std::fs::read(artifact).unwrap_or_else(|_| panic!("missing artifact {artifact}"));
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{artifact} is not a PNG");
    }

    let tools = result["tools"].as_array().expect("tool replies");
    assert_eq!(tools.len(), 4, "{tools:#?}");
    println!("\n[Live Guitar Tabs BDD]");

    // Own pace, Ode to Joy: E4, E4 hit; F#4 was wrong; F4 hit.
    let own = &tools[0]["result"]["practice"];
    println!("  own pace: {own}");
    assert_eq!(own["mode"], "wait", "{own:#}");
    assert_eq!(own["hits"], 3, "{own:#}");
    assert_eq!(own["wrong"], 1, "{own:#}");
    assert_eq!(own["currentStep"], 4, "{own:#}");

    // The chord tab: read as two chords (C, then G), graded in chord mode; the C was played.
    let loaded = &tools[1]["result"];
    println!("  loaded: {loaded}");
    assert_eq!(loaded["success"], true, "{loaded:#}");
    assert_eq!(loaded["steps"], 2, "{loaded:#}");
    let chord = &tools[2]["result"];
    assert_eq!(chord["steps"][0]["notes"], serde_json::json!(["C3", "E3", "G3", "C4", "E4"]), "{chord:#}");
    assert_eq!(chord["steps"][0]["playAs"], "chord", "{chord:#}");
    assert_eq!(chord["practice"]["hits"], 1, "{chord:#}");
    assert_eq!(chord["practice"]["currentStep"], 2, "{chord:#}");

    // Real time: 3.8 s in at 80 BPM with a four-beat count-in (3 s), the song is running and the C
    // (never played) has been missed.
    let realtime = &tools[3]["result"]["practice"];
    println!("  real time: {realtime}");
    assert_eq!(realtime["mode"], "realtime", "{realtime:#}");
    assert_eq!(realtime["misses"], 1, "{realtime:#}");

    println!("  ✔ paste, review, own-pace grading, chord mode and a real-time run all worked in the real app");
    println!("  ✔ artifacts: {}", root.display());
    println!("[Summary] 1 live-ui feature (passed)");
}
