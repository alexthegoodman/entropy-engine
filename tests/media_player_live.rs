//! Live Media Player BDD: runs the compiled app with the four public MP4s.
use std::process::Command;

#[test]
fn media_player_live() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("media-bdd-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let result_path = root.join("result.json");
    let example = std::env::var_os("CARGO_BIN_EXE_example").expect("Cargo must provide the example binary");
    let status = Command::new(example).arg("media-player")
        .env("ENTROPY_MEDIA_BDD_RESULT", &result_path)
        .status().expect("launch the real Media Player");
    assert!(status.success(), "media player exited with {status}");
    let result: serde_json::Value = serde_json::from_slice(&std::fs::read(&result_path).expect("live result JSON")).unwrap();
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts = result["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 11, "{result:#}");
    for artifact in artifacts { assert!(std::path::Path::new(artifact.as_str().unwrap()).is_file()); }
    let captures = result["actions"].as_array().unwrap();
    let named = |name: &str| captures.iter().find(|action| action["kind"] == "capture" && action["name"] == name)
        .unwrap_or_else(|| panic!("capture {name} missing: {result:#}"));
    let seek = named("media-seek-caption");
    assert_eq!(seek["media"]["playing"], false, "seek should preserve pause: {seek:#}");
    assert!(seek["media"]["timeMs"].as_i64().unwrap() >= 5000, "seek did not reach 5 seconds: {seek:#}");
    let controls = named("media-controls");
    assert_eq!(controls["media"]["speed"], 2.0, "speed did not reach decoder: {controls:#}");
    let volume = controls["media"]["volume"].as_f64().unwrap();
    assert!((volume - 0.35).abs() < 0.001, "volume did not reach sink: {controls:#}");
    let next = named("media-next");
    assert_eq!(next["media"]["hasAudio"], true, "second clip should have AAC audio: {next:#}");
    assert_eq!(next["media"]["audioSinkActive"], true, "second clip should have a live audio sink: {next:#}");
    let delta = named("media-speed-clock")["media"]["timeMs"].as_i64().unwrap() - next["media"]["timeMs"].as_i64().unwrap();
    assert!((750..=1800).contains(&delta), "2x playback should advance about 1 second over 500 ms: {delta}");
    assert_eq!(named("media-fullscreen")["fullscreen"], true, "OS window did not enter fullscreen");
    assert_eq!(named("media-windowed")["fullscreen"], false, "OS window did not exit fullscreen");
    assert_eq!(named("media-added")["media"]["hasAudio"], false, "the added sample is video-only");
    println!("Media Player live BDD passed with {} screenshots in {}", artifacts.len(), root.display());
}
