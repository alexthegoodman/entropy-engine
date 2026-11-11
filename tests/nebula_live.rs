//! Nebula Kingdom in the real window: tests/features/nebula_live.feature played through startup.rs's
//! Gherkin driver (ENTROPY_NEBULA_BDD_RESULT). On a headless Linux box run it under `xvfb-run -a`.
//! The pure-TypeScript tier is examples/studio-bundle/tests/nebula_*.test.ts.
use std::{fs, process::Command};

#[test]
fn nebula_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("nebula-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("nebula-kingdom")
        .env("ENTROPY_NEBULA_BDD_RESULT", &result_path)
        .env("ENTROPY_NEBULA_BDD_DATA", &data)
        .spawn()
        .expect("launch Nebula Kingdom");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(1800) {
            let _ = child.kill(); let _ = child.wait();
            panic!("Nebula Kingdom live BDD timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Nebula Kingdom failed: {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
    assert_eq!(result["status"], "passed", "{result:#}");
    for artifact in result["artifacts"].as_array().unwrap() {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
}
