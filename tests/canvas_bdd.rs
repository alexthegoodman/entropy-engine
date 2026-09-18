//! Reuses startup.rs's Gherkin-driven widget event and composed-frame BDD driver.
//! The callback tier lives in examples/studio-bundle/tests/canvas_animation_bdd.test.ts.
use std::{fs, process::Command};

#[test]
fn canvas_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("canvas-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("canvas-surface-demo")
        .env("ENTROPY_CANVAS_BDD_RESULT", &result_path)
        .env("ENTROPY_CANVAS_BDD_DATA", &data)
        .spawn().expect("launch Canvas Surfaces");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(120) {
            let _ = child.kill(); let _ = child.wait();
            panic!("Canvas live BDD timed out before the engine completed its feature");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Canvas demo failed: {status}");
    let read = |path: &std::path::Path| -> serde_json::Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    };
    let result = read(&result_path);
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts = result["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 6);
    for artifact in artifacts {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("rendered screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    // Verify actual persisted addon state, not the driver's list of queued events.
    let index = read(&data.join("Canvas Surfaces.json"));
    let entry = &index["scenes"][0];
    assert_eq!(entry["name"], "BDD animated creation");
    let scene = read(&data.join(format!("GlobalGameState_{}.json", entry["key"].as_str().unwrap())));
    assert_eq!(scene["version"], 3);
    assert_eq!(scene["groups"].as_array().unwrap().len(), 1);
    let group = &scene["groups"][0];
    assert_eq!(group["name"], "Arm");
    assert_eq!(group["pivot"][1], 3.0);
    assert_eq!(group["rotation"], serde_json::json!([0, 0, 0]), "preview must not overwrite the editing pose");
    assert_eq!(scene["surfaces"][0]["parentId"], group["id"]);
    let clip = &scene["clips"][0];
    assert_eq!(clip["name"], "Wave");
    let track = &clip["tracks"][0];
    assert_eq!(track["targetId"], group["id"]);
    assert_eq!(track["channel"], "roll");
    assert_eq!(track["keys"].as_array().unwrap().len(), 2);
    assert_eq!(track["keys"][0]["time"], 0.0);
    assert_eq!(track["keys"][1]["time"], 1.0);
    assert!((track["keys"][1]["value"].as_f64().unwrap() - std::f64::consts::FRAC_PI_2).abs() < 1e-6);
    let character_entry = &index["scenes"][1];
    assert_eq!(character_entry["name"], "Drawn character");
    let character = read(&data.join(format!("GlobalGameState_{}.json", character_entry["key"].as_str().unwrap())));
    assert_eq!(character["surfaces"].as_array().unwrap().len(), 6);
    assert_eq!(character["groups"].as_array().unwrap().len(), 2);
    assert_eq!(character["groups"][1]["parentId"], character["groups"][0]["id"]);
    assert_eq!(character["clips"][0]["name"], "Wave and smile");
    assert_eq!(character["clips"][0]["tracks"].as_array().unwrap().len(), 2);
    let face = character["surfaces"].as_array().unwrap().iter().find(|s| s["name"] == "Face").unwrap();
    assert_eq!(face["strokes"].as_array().unwrap().len(), 3);
    println!("Canvas live BDD: persisted hierarchy and animation verified; screenshots: {}", root.display());
}
