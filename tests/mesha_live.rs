//! Mesha in the real window, driven by tests/features/mesha_live.feature through startup.rs's
//! Gherkin driver (mostly via Mesha's own MCP tools). Checks what the app itself persisted and
//! exported, not the driver's list of queued events. On a headless Linux box run it under
//! `xvfb-run -a`. The pure-TypeScript tier is examples/studio-bundle/tests/mesha.test.ts.
use std::{fs, process::Command};

#[test]
fn mesha_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("mesha-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("mesha")
        .env("ENTROPY_MESHA_BDD_RESULT", &result_path)
        .env("ENTROPY_MESHA_BDD_DATA", &data)
        .spawn()
        .expect("launch Mesha");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(180) {
            let _ = child.kill(); let _ = child.wait();
            panic!("Mesha live BDD timed out");
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

    // Variation moved the chair but never what was locked (a parameter, and the whole Materials group).
    let varied = &reply("mesha_vary", 0)["instance"];
    assert_eq!(varied["values"]["seatHeight"], 0.47, "a locked parameter moved");
    assert_eq!(varied["values"]["upholstery"], "fabric.charcoal", "a locked group moved");
    assert!(reply("mesha_vary", 0)["changed"].as_array().unwrap().len() >= 3, "Variation barely changed anything");
    assert_eq!(varied["violations"].as_array().unwrap().len(), 0, "Variation broke a rule: {varied:#}");
    // The toolbar-free path: the real Variation button changed the design again.
    let after_button = &reply("mesha_state", 0)["instances"][0]["values"];
    assert_ne!(after_button, &varied["values"], "clicking Variation did nothing");
    assert_eq!(after_button["seatHeight"], 0.47);

    // Four legs instead of casters: fewer triangles, and the definition says wheels hide then.
    let legs = &reply("mesha_set", 0)["instance"];
    assert_eq!(legs["values"]["base"], "legs");
    assert!(legs["triangles"].as_u64().unwrap() < varied["triangles"].as_u64().unwrap());
    let definition = &reply("mesha_describe", 0)["definition"];
    let spokes = definition["params"].as_array().unwrap().iter().find(|p| p["id"] == "spokes").unwrap();
    assert_eq!(spokes["visibleIf"], "=base == 'star'");

    // The composed scene, after an undo and a redo of the last add.
    assert_eq!(reply("mesha_undo", 0)["instances"].as_array().unwrap().len(), 3);
    let state = reply("mesha_state", 1);
    let instances = state["instances"].as_array().unwrap();
    let ids: Vec<&str> = instances.iter().map(|i| i["objectId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["furniture.office_chair", "furniture.table", "household.bottle", "nature.rock"]);
    assert_eq!(instances[2]["position"][1], 0.74, "the bottle stands on the table top");
    assert_eq!(instances[1]["values"]["topShape"], "round", "the table took its preset");
    assert_eq!(state["lighting"], "warm");

    // What the app persisted: that scene, plus the facade the last scenario added and edited.
    let session = read(&data.join("Mesha").join("session.json"));
    let saved = session["scene"]["instances"].as_array().unwrap();
    assert_eq!(saved.len(), 5);
    assert_eq!(saved[4]["objectId"], "architecture.facade");
    assert_eq!(saved[4]["values"]["windowCount"], 6);

    // The GLB: a real glTF binary with one mesh per object material.
    let export = reply("mesha_export", 0);
    let glb = fs::read(export["path"].as_str().unwrap()).expect("GLB written");
    assert_eq!(&glb[..4], b"glTF");
    let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let gltf: serde_json::Value = serde_json::from_slice(&glb[20..20 + json_len]).unwrap();
    assert_eq!(gltf["meshes"].as_array().unwrap().len() as u64, export["meshes"].as_u64().unwrap());
    assert!(export["triangles"].as_u64().unwrap() > 20_000);

    // Window count 4 -> 6: the facade's composed windows follow its parameter.
    let four = &reply("mesha_add", 3)["instance"];
    let six = &reply("mesha_set", 1)["instance"];
    assert_eq!(four["objectId"], "architecture.facade");
    assert_eq!(six["values"]["windowCount"], 6);
    assert!(six["triangles"].as_u64().unwrap() > four["triangles"].as_u64().unwrap() * 5 / 4, "two more windows should add geometry");

    // Screenshots: Variation visibly changed the chair in the viewport (between the side panels).
    let artifacts: Vec<String> = result["artifacts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    let find = |name: &str| artifacts.iter().find(|a| a.ends_with(&format!("{name}.png"))).unwrap_or_else(|| panic!("no {name} capture")).clone();
    let a = image::open(find("01-office-chair")).unwrap().to_rgb8();
    let b = image::open(find("02-variation")).unwrap().to_rgb8();
    let (w, h) = a.dimensions();
    let (mut changed, mut total) = (0u64, 0u64);
    for y in (h / 8)..(h * 7 / 8) {
        for x in (w / 4)..(w * 3 / 4) {
            total += 1;
            let (p, q) = (a.get_pixel(x, y).0, b.get_pixel(x, y).0);
            if (0..3).any(|c| (p[c] as i32 - q[c] as i32).abs() > 24) { changed += 1; }
        }
    }
    assert!(changed * 50 > total, "the viewport barely changed after Variation ({changed}/{total} pixels)");
    println!("Mesha live BDD: {}", root.display());
}
