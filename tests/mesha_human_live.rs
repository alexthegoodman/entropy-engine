//! People in Mesha, in the real window: tests/features/mesha_human_live.feature played through
//! startup.rs's Gherkin driver (ENTROPY_MESHA_BDD_FEATURE=human), mostly via Mesha's MCP tools.
//! Checks what the app built, persisted and exported. On a headless Linux box run it under
//! `xvfb-run -a`. The pure-TypeScript tier is examples/studio-bundle/tests/mesha_human.test.ts.
use std::{fs, process::Command};

#[test]
fn mesha_human_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("mesha-human-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("mesha")
        .env("ENTROPY_MESHA_BDD_FEATURE", "human")
        .env("ENTROPY_MESHA_BDD_RESULT", &result_path)
        .env("ENTROPY_MESHA_BDD_DATA", &data)
        .spawn()
        .expect("launch Mesha");
    // Each person is built (body, draped clothes, settled hair) in seconds: allow for a gallery.
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(900) {
            let _ = child.kill(); let _ = child.wait();
            panic!("Mesha people live BDD timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Mesha failed: {status}");
    let read = |path: &std::path::Path| -> serde_json::Value { serde_json::from_slice(&fs::read(path).unwrap()).unwrap() };
    let result = read(&result_path);
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts = result["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 11, "one screenshot per capture step");
    for artifact in artifacts {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    let tools = result["tools"].as_array().unwrap();
    let reply = |name: &str, nth: usize| -> &serde_json::Value {
        &tools.iter().filter(|t| t["tool"] == name).nth(nth).unwrap_or_else(|| panic!("no {name} reply #{nth}"))["result"]
    };

    // The first person: the Weekend preset, a full body with hair and clothes, and no broken rules.
    let first = &reply("mesha_state", 0)["instances"][0];
    assert_eq!(first["objectId"], "people.human");
    assert_eq!(first["values"]["hairStyle"], "long");
    assert!(first["triangles"].as_u64().unwrap() > 200_000, "{first:#}");
    assert_eq!(first["violations"].as_array().unwrap().len(), 0);

    // Restyled and redressed: the values took, and a skirt and boots replaced jeans and sneakers.
    let restyled = &reply("mesha_set", 0)["instance"];
    assert_eq!(restyled["values"]["hairStyle"], "bob");
    assert_eq!(restyled["values"]["top"], "sweater");
    assert_eq!(restyled["values"]["bottom"], "skirt");
    assert_eq!(restyled["values"]["shoes"], "boots");

    // The gallery: six people, each from its preset, and what the app persisted matches.
    let state = reply("mesha_state", 1);
    let people = state["instances"].as_array().unwrap();
    assert_eq!(people.len(), 6);
    assert!(people.iter().all(|p| p["objectId"] == "people.human"));
    let styles: Vec<&str> = people.iter().map(|p| p["values"]["hairStyle"].as_str().unwrap()).collect();
    assert_eq!(styles, ["bob", "ponytail", "short", "bob", "short", "afro"]);
    assert_eq!(people[1]["values"]["wind"], 5);
    let session = read(&data.join("Mesha").join("session.json"));
    assert_eq!(session["scene"]["instances"].as_array().unwrap().len(), 6);

    // The export: a GLB with every person's materials as separate meshes.
    let export = reply("mesha_export", 0);
    let glb = fs::read(export["path"].as_str().unwrap()).unwrap();
    assert_eq!(&glb[..4], b"glTF");
    assert!(export["triangles"].as_u64().unwrap() > 1_000_000);
    let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let gltf: serde_json::Value = serde_json::from_slice(&glb[20..20 + json_len]).unwrap();
    assert_eq!(gltf["meshes"].as_array().unwrap().len() as u64, export["meshes"].as_u64().unwrap());
}
