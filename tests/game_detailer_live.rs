//! The Game World Detailer in the real window: tests/features/game_detailer_live.feature played
//! through startup.rs's Gherkin driver (ENTROPY_DETAILER_BDD_RESULT). Starts from an empty Planner
//! library (the sample world is made through the app's own button), waits for Mesha models built in
//! the worker, edits through the app's MCP tools, and checks what the Detailer reported, the
//! exported zip, and - the point of the app - that the Planner's own world file now has the move.
//! On a headless Linux box run it under `xvfb-run -a`; build the bundles first
//! (`npm run build-game-detailer` in examples/studio-bundle). The pure-TypeScript tier is
//! examples/studio-bundle/tests/game_detailer*.test.ts.
use std::{fs, process::Command};

#[test]
fn game_detailer_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("game-detailer-bdd-{}", std::process::id()));
    let data = root.join("data");
    let mesha = root.join("mesha");
    fs::create_dir_all(&data).unwrap();
    let export = std::env::current_dir().unwrap().join("test-artifacts/game-detailer-live/level.zip");
    let _ = fs::remove_file(&export);
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("game-detailer")
        .env("ENTROPY_DETAILER_BDD_RESULT", &result_path)
        .env("ENTROPY_DETAILER_BDD_DATA", &data)
        .env("ENTROPY_MESHA_BDD_DATA", &mesha)
        .env("ENTROPY_BDD_BUDGET_SECS", std::env::var("ENTROPY_BDD_BUDGET_SECS").unwrap_or_else(|_| "1500".into()))
        .spawn()
        .expect("launch the Game World Detailer");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > std::time::Duration::from_secs(1700) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Game World Detailer live BDD timed out (a frozen app looks like this)");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Game World Detailer failed: {status}");
    let read = |path: &std::path::Path| -> serde_json::Value { serde_json::from_slice(&fs::read(path).unwrap()).unwrap() };
    let result = read(&result_path);
    assert_eq!(result["status"], "passed", "{result:#}");
    for artifact in result["artifacts"].as_array().unwrap() {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    let tools = result["tools"].as_array().unwrap();
    let replies = |name: &str| -> Vec<&serde_json::Value> { tools.iter().filter(|t| t["tool"] == name).map(|t| &t["result"]).collect() };
    let states = replies("game_detailer_state");
    assert_eq!(states.len(), 5, "one state per checkpoint");

    // The sample world opened from the Planner's library, full of things to detail.
    assert_eq!(states[0]["world"]["name"], "Shattered Isles (detailed)");
    assert!(states[0]["items"].as_u64().unwrap() > 50, "{}", states[0]);
    // After the wait the worker had built models and they were drawn, instanced: far fewer draws than things.
    let s = &states[1]["stats"];
    assert!(s["instances"].as_u64().unwrap() > 30, "drawn: {s}");
    assert!(s["batches"].as_u64().unwrap() < s["instances"].as_u64().unwrap(), "instanced: {s}");
    assert!(s["tiles"].as_u64().unwrap() > 20, "ground tiles: {s}");
    assert!(states[1]["modelsBuilt"].as_u64().unwrap() > 3);
    // The woods: scatter adds many more instances.
    assert!(states[2]["stats"]["instances"].as_u64().unwrap() > s["instances"].as_u64().unwrap(), "woods: {}", states[2]["stats"]);

    // The house moved, in the plan.
    let selected = replies("game_detailer_select")[0]["selected"].clone();
    assert_eq!(selected["source"], "structure");
    let house_id = selected["sourceId"].as_str().unwrap().to_string();
    let moved = &states[3]["selected"];
    assert_eq!(moved["sourceId"], house_id);
    assert_eq!(moved["yawDeg"], 25);
    // A house is one rect wing: its center moved 12 m east and 4 m north (dz -4: north).
    let dx = moved["positionKm"][0].as_f64().unwrap() - selected["positionKm"][0].as_f64().unwrap();
    let dy = moved["positionKm"][1].as_f64().unwrap() - selected["positionKm"][1].as_f64().unwrap();
    assert!((dx - 0.012).abs() < 0.001 && (dy - 0.004).abs() < 0.001, "moved by {dx}, {dy} km");
    let worlds = data.join("game-world-planner").join("worlds");
    let file = fs::read_dir(&worlds).unwrap().flatten().find(|e| e.file_name().to_string_lossy().ends_with(".world.json")).expect("world file").path();
    let saved = read(&file);
    assert_eq!(saved["savedBy"], "game-world-detailer");
    let structure = saved["world"]["structures"].as_array().unwrap().iter().find(|s| s["id"] == house_id.as_str()).unwrap();
    let x0 = selected["positionKm"][0].as_f64().unwrap();
    // 12 m east (the selection reports a wing's center; the footprint's own x moved the same).
    let footprint_moved = (structure["x"].as_f64().unwrap() - x0).abs() < 0.05;
    assert!(footprint_moved, "structure x {} near {}", structure["x"], x0);
    assert_eq!(structure["rotationDeg"].as_f64().unwrap().round(), 25.0);
    // The Detailer's own section rode along: every inn's model, the prop and the site.
    let detail = &saved["world"]["detail"];
    assert_eq!(detail["models"]["structure:inn"]["objectId"], "architecture.arcane_emporium");
    assert_eq!(detail["props"].as_array().unwrap().len(), 1);
    assert_eq!(detail["sites"][0]["name"], "Capital square");
    assert!(detail["bindings"].as_object().unwrap().values().any(|b| b["model"]["objectId"].is_string()), "the varied house has its own model");
    assert_eq!(states[4]["lighting"], "warm");

    // The export: a zip with the scene, models and lore.
    let exported = &replies("game_detailer_export")[0];
    assert_eq!(exported["success"], true, "{exported}");
    let files: Vec<&str> = exported["files"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
    for needed in ["scene.json", "models/index.json", "terrain/heightmap.png", "materials.json", "lore/game_design_document.md", "README.md"] {
        assert!(files.contains(&needed), "{needed} missing from {files:?}");
    }
    assert!(files.iter().filter(|f| f.ends_with(".glb")).count() > 5);
    let zip = fs::read(&export).expect("the zip was written");
    assert_eq!(&zip[..4], b"PK\x03\x04");
}
