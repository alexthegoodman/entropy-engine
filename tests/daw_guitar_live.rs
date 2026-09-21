//! Live tier for the DAW's Guitar Input panel: launches the real compiled DAW (`example daw`) against
//! a clean data folder and lets the in-engine driver play `tests/features/daw_guitar_live.feature`
//! into it. That opens the machine's default input through the real op path (JS, serde_v8, cpal,
//! WASAPI), so it needs an input device and an interactive desktop, like the other live suites.
//!
//! No guitar is assumed. The scenario passes only if the panel's status label reads "listening"
//! after Start, which it does only when the op call succeeded and the stream opened.

use std::{fs, path::Path, process::Command};

fn run_daw(root: &Path, data: &Path) -> serde_json::Value {
    let result_path = root.join("result-guitar.json");
    let _ = fs::remove_file(&result_path);
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", data)
        .env("ENTROPY_DAW_BDD_FEATURE", "guitar")
        .spawn()
        .expect("launch the DAW");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > std::time::Duration::from_secs(240) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the DAW guitar run timed out before the engine finished its feature");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "the DAW exited with {status}");
    serde_json::from_slice(&fs::read(&result_path).expect("result json")).expect("valid result json")
}

#[test]
fn daw_guitar_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-guitar-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();

    let result = run_daw(&root, &data);
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts = result["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 4, "{artifacts:#?}");
    for a in artifacts {
        let path = a.as_str().unwrap();
        let bytes = fs::read(path).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{path} is not a PNG");
        println!("  {path}");
    }
    println!("DAW guitar live BDD passed; artifacts: {}", root.display());
}
