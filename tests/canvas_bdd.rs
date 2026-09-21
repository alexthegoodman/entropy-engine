//! Reuses startup.rs's Gherkin-driven widget event and composed-frame BDD driver.
//! The callback tier lives in examples/studio-bundle/tests/canvas_animation_bdd.test.ts.
use std::{fs, process::Command};

#[test]
fn canvas_logic_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("canvas-logic-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("canvas-surface-demo")
        .env("ENTROPY_CANVAS_BDD_RESULT", &result_path)
        .env("ENTROPY_CANVAS_BDD_FEATURE", "logic")
        .env("ENTROPY_CANVAS_BDD_DATA", &data)
        .spawn().expect("launch Canvas logic");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(120) {
            let _ = child.kill(); let _ = child.wait(); panic!("Canvas logic live BDD timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Canvas logic failed: {status}");
    let read = |path: &std::path::Path| -> serde_json::Value { serde_json::from_slice(&fs::read(path).unwrap()).unwrap() };
    let result = read(&result_path);
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts = result["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 8);
    for artifact in artifacts {
        let bytes = fs::read(artifact.as_str().unwrap()).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    let index = read(&data.join("Canvas Surfaces.json"));
    let painted = read(&data.join(format!("GlobalGameState_{}.json", index["scenes"][0]["key"].as_str().unwrap())));
    assert_eq!(painted["surfaces"].as_array().unwrap().len(), 2);
    assert_eq!(painted["surfaces"][0]["strokes"].as_array().unwrap().len(), 1, "live pointer path must paint a retained stroke");
    let scene = read(&data.join(format!("GlobalGameState_{}.json", index["scenes"][1]["key"].as_str().unwrap())));
    assert_eq!(scene["logic"]["nodes"].as_array().unwrap().len(), 7);
    assert_eq!(scene["logic"]["connections"].as_array().unwrap().len(), 5);
    assert_eq!(scene["logic"]["nodes"][2]["target"], scene["surfaces"][1]["id"]);
    assert_eq!(scene["logic"]["nodes"][4]["target"], scene["clips"][0]["id"]);
    println!("Canvas logic BDD: {}", root.display());
}

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
    assert_eq!(artifacts.len(), 9);
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

/// Mean brightness (0-255) of the top `rows` rows of a screenshot, right of the 360 px sidebar: the sky
/// and fog at the horizon, which is what a change of lighting preset moves the most.
fn sky_luma(path: &str, rows: u32) -> f64 {
    let image = image::open(path).expect("screenshot decodes").to_luma8();
    let (w, h) = image.dimensions();
    let (mut sum, mut count) = (0u64, 0u64);
    for y in 0..rows.min(h) { for x in 360.min(w)..w { sum += image.get_pixel(x, y).0[0] as u64; count += 1; } }
    sum as f64 / count.max(1) as f64
}

/// Mean absolute per-pixel difference between two screenshots of the same size, right of the sidebar.
fn mean_difference(a: &str, b: &str) -> f64 {
    let (a, b) = (image::open(a).unwrap().to_luma8(), image::open(b).unwrap().to_luma8());
    assert_eq!(a.dimensions(), b.dimensions());
    let (w, h) = a.dimensions();
    let (mut sum, mut count) = (0u64, 0u64);
    for y in 0..h { for x in 360.min(w)..w { sum += (a.get_pixel(x, y).0[0] as i32 - b.get_pixel(x, y).0[0] as i32).unsigned_abs() as u64; count += 1; } }
    sum as f64 / count.max(1) as f64
}

#[test]
fn canvas_world_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("canvas-world-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("canvas-surface-demo")
        .env("ENTROPY_CANVAS_BDD_RESULT", &result_path)
        .env("ENTROPY_CANVAS_BDD_FEATURE", "world")
        .env("ENTROPY_CANVAS_BDD_DATA", &data)
        .spawn().expect("launch Canvas world");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(120) {
            let _ = child.kill(); let _ = child.wait(); panic!("Canvas world live BDD timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Canvas world failed: {status}");
    let read = |path: &std::path::Path| -> serde_json::Value { serde_json::from_slice(&fs::read(path).unwrap()).unwrap() };
    let result = read(&result_path);
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts: Vec<String> = result["artifacts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(artifacts.len(), 6);
    for artifact in &artifacts {
        let bytes = fs::read(artifact).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    let shot = |name: &str| artifacts.iter().find(|a| a.ends_with(&format!("{name}.png"))).unwrap_or_else(|| panic!("no capture {name}")).clone();
    // The lighting buffer reaches the shader: the same village is much darker at night, and lit differently at golden hour.
    let (golden, night) = (sky_luma(&shot("world-golden-hour"), 120), sky_luma(&shot("world-night"), 120));
    let changed = mean_difference(&shot("world-golden-hour"), &shot("world-night"));
    println!("sky luma (top 120 rows): golden hour {golden:.1}, night {night:.1}; mean per-pixel difference {changed:.1}");
    assert!(golden > night + 40.0, "the night sky ({night}) should be much darker than golden hour ({golden})");
    assert!(golden > 60.0, "golden hour should not render black: {golden}");
    assert!(changed > 15.0, "the whole picture should change with the lighting: {changed}");
    // Real Play followed the player and the edit view came back after Stop.
    assert_ne!(fs::read(shot("world-play-start")).unwrap(), fs::read(shot("world-play-walked")).unwrap(), "the camera should follow the walking player");
    // What every tool call returned, in order.
    let tools = result["tools"].as_array().unwrap();
    let reply = |name: &str| tools.iter().filter(|t| t["tool"] == name).last().unwrap_or_else(|| panic!("no call to {name}"))["result"].clone();
    let playtest = reply("canvas_playtest");
    assert_eq!(playtest["passed"], true, "{playtest:#}");
    assert_eq!(playtest["counters"]["herbs"], 3);
    assert!(playtest["messages"].as_array().unwrap().iter().any(|m| m == "Thank you! The gate is open."));
    let stats = reply("canvas_world_stats");
    assert!(stats["estimatedSaveMB"].as_f64().unwrap() < 8.0, "{stats:#}");
    let state = reply("canvas_get_play_state");
    assert_eq!(state["playing"], true);
    assert_eq!(state["counters"]["herbs"], 1, "walking right for 40 frames passes the first herb: {state:#}");
    assert!(state["player"][0].as_f64().unwrap() > 3.0, "{state:#}");
    // Persisted scene: the world settings survive, and unpainted surfaces are stored as colours, not megabytes of pixels.
    let index = read(&data.join("Canvas Surfaces.json"));
    let key = index["scenes"][0]["key"].as_str().unwrap();
    let path = data.join(format!("GlobalGameState_{key}.json"));
    let scene = read(&path);
    assert_eq!(scene["version"], 3);
    assert!(scene["world"]["player"].is_string());
    assert_eq!(scene["world"]["lighting"]["sunIntensity"], 0.95);
    let groups = scene["groups"].as_array().unwrap();
    let hero = groups.iter().find(|g| g["name"] == "Hero").unwrap();
    assert_eq!(scene["world"]["player"], hero["id"]);
    let start: Vec<f64> = hero["position"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    assert_eq!(start, vec![0.0, 0.0, 0.0], "Play must not leave the player where it walked");
    let surfaces = scene["surfaces"].as_array().unwrap();
    assert!(surfaces.len() > 30, "{}", surfaces.len());
    assert!(surfaces.iter().all(|s| s["visible"] == true), "Play must restore every surface the game hid");
    assert!(surfaces.iter().flat_map(|s| s["layers"].as_array().unwrap()).all(|l| l["pixelsFill"].is_array()));
    let size = fs::metadata(&path).unwrap().len();
    println!("Canvas world BDD: {} surfaces saved in {} KB; screenshots: {}", surfaces.len(), size / 1024, root.display());
    assert!(size < 6 * 1024 * 1024, "{size}");
}
