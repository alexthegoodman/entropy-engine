//! True Error in the real window: tests/features/true_error_live.feature (Mission 1, the Central
//! Spire) and then tests/features/true_error_noctis.feature (Mission 2, Noctis, through
//! ENTROPY_TRUE_ERROR_BDD_FEATURE), each played through startup.rs's Gherkin driver
//! (ENTROPY_TRUE_ERROR_BDD_RESULT), one after the other. On a headless Linux box run it under
//! `xvfb-run -a`. Needs the game assets (examples/studio-bundle: `npm run true-error:assets`) and the
//! bundle (`npm run build-true-error`). The pure-TypeScript tier is examples/studio-bundle/tests/true_error_*.test.ts.
use std::{fs, path::PathBuf, process::Command};

/// Plays one feature (None: the built-in true_error_live.feature) and checks its result and captures.
fn play(name: &str, feature: Option<&str>) {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("true-error-bdd-{name}-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut command = Command::new(env!("CARGO_BIN_EXE_example"));
    command.arg("true-error").env("ENTROPY_TRUE_ERROR_BDD_RESULT", &result_path).env("ENTROPY_TRUE_ERROR_BDD_DATA", &data);
    if let Some(feature) = feature {
        let path: PathBuf = std::env::current_dir().unwrap().join(feature);
        command.env("ENTROPY_TRUE_ERROR_BDD_FEATURE", path);
    }
    let mut child = command.spawn().expect("launch True Error");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(1200) {
            let _ = child.kill(); let _ = child.wait();
            panic!("True Error live BDD ({name}) timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "True Error ({name}) failed: {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
    assert_eq!(result["status"], "passed", "{name}: {result:#}");
    for artifact in result["artifacts"].as_array().unwrap() {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
}

#[test]
fn true_error_live_feature() {
    play("spire", None);
    play("noctis", Some("tests/features/true_error_noctis.feature"));
}
