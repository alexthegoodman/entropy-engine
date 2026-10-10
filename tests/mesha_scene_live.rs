//! A procedural scene in the real Mesha window: tests/features/mesha_scene_live.feature played
//! through startup.rs's Gherkin driver (ENTROPY_MESHA_BDD_FEATURE=scene). Builds The Road to the
//! Dome from the Library, changes its mood and dome, and checks what the app built and persisted.
//! On a headless Linux box run it under `xvfb-run -a`. The pure-TypeScript tier is
//! examples/studio-bundle/tests/mesha_scenes.test.ts.
use std::{fs, process::Command};

#[test]
fn mesha_scene_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("mesha-scene-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("mesha")
        .env("ENTROPY_MESHA_BDD_FEATURE", "scene")
        .env("ENTROPY_MESHA_BDD_RESULT", &result_path)
        .env("ENTROPY_MESHA_BDD_DATA", &data)
        .spawn()
        .expect("launch Mesha");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(600) {
            let _ = child.kill(); let _ = child.wait();
            panic!("Mesha scene live BDD timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Mesha failed: {status}");
    let read = |path: &std::path::Path| -> serde_json::Value { serde_json::from_slice(&fs::read(path).unwrap()).unwrap() };
    let result = read(&result_path);
    assert_eq!(result["status"], "passed", "{result:#}");
    for artifact in result["artifacts"].as_array().unwrap() {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    let tools = result["tools"].as_array().unwrap();
    let reply = |name: &str, nth: usize| -> &serde_json::Value {
        &tools.iter().filter(|t| t["tool"] == name).nth(nth).unwrap_or_else(|| panic!("no {name} reply #{nth}"))["result"]
    };

    // The Library's Build button placed the whole level, under its own lighting.
    let built = reply("mesha_state", 0);
    assert_eq!(built["generator"]["sceneId"], "scene.road_to_the_dome");
    assert_eq!(built["lighting"], "ashen");
    let instances = built["instances"].as_array().unwrap();
    assert!(instances.len() > 30, "only {} objects", instances.len());
    let dome = instances.iter().find(|i| i["objectId"] == "architecture.rust_dome").expect("the dome");
    assert_eq!(dome["values"]["storeys"], 5);
    for id in ["street.wasteland_ground", "transport.wreck_car", "transport.container", "architecture.ruin", "street.utility_pole", "architecture.wasteland_depot"] {
        assert!(instances.iter().any(|i| i["objectId"] == id), "no {id}");
    }

    // Moods switch the lighting; the last change rebuilt the dome in place, seven storeys tall.
    assert_eq!(reply("mesha_scene", 0)["lighting"], "toxic");
    assert_eq!(reply("mesha_scene", 1)["lighting"], "night");
    let last = reply("mesha_state", 1);
    assert_eq!(last["lighting"], "ashen");
    let tall = last["instances"].as_array().unwrap().iter().find(|i| i["objectId"] == "architecture.rust_dome").unwrap();
    assert_eq!(tall["values"]["storeys"], 7);
    assert_eq!(tall["id"], dome["id"], "the dome was replaced instead of updated");

    // What the app persisted.
    let session = read(&data.join("Mesha").join("session.json"));
    assert_eq!(session["scene"]["generator"]["values"]["domeStoreys"], 7);
    assert!(reply("mesha_scenes", 0)["scenes"].as_array().unwrap().iter().any(|s| s["id"] == "scene.road_to_the_dome"));
}
