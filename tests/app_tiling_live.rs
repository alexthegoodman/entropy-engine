use std::{fs, process::Command, time::{Duration, Instant}};

#[test]
fn app_tiling_multitasking_and_floating_windows() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("app-tiling-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("special-bundle")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_FEATURE", "app-tiling")
        .env("ENTROPY_BUNDLE_BDD_DATA", &data)
        .spawn()
        .expect("launch special bundle with app-tiling feature");
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > Duration::from_secs(180) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("app tiling BDD timed out");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(status.success(), "app tiling exited with {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).expect("BDD result")).unwrap();
    assert_eq!(result["status"], "passed", "{result:#}");
    for artifact in result["artifacts"].as_array().unwrap() {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
}
