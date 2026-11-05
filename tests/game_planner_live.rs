//! The Game World Planner in the real window: tests/features/game_planner_live.feature played
//! through startup.rs's Gherkin driver (ENTROPY_PLANNER_BDD_RESULT). Drives the map tools with real
//! pointer input, opens the Codex and Agent tabs (whose multiline text fields used to freeze the
//! app), sketches design intents and runs the agent loop on them (the built-in Planner Agent, and an
//! external agent over MCP), runs the terrain tools, and checks what the planner reported and saved.
//! On a headless Linux box run it under `xvfb-run -a`; build the bundle first
//! (`npm run build-game-planner` in examples/studio-bundle). The pure-TypeScript tier is
//! examples/studio-bundle/tests/game_planner.test.ts.
use std::{fs, process::Command};

#[test]
fn game_planner_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("game-planner-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("game-planner")
        .env("ENTROPY_PLANNER_BDD_RESULT", &result_path)
        .env("ENTROPY_PLANNER_BDD_DATA", &data)
        .spawn()
        .expect("launch the Game World Planner");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > std::time::Duration::from_secs(600) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Game World Planner live BDD timed out (a frozen app looks like this)");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Game World Planner failed: {status}");
    let read = |path: &std::path::Path| -> serde_json::Value { serde_json::from_slice(&fs::read(path).unwrap()).unwrap() };
    let result = read(&result_path);
    assert_eq!(result["status"], "passed", "{result:#}");
    for artifact in result["artifacts"].as_array().unwrap() {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    let states: Vec<&serde_json::Value> = result["tools"].as_array().unwrap().iter().filter(|t| t["tool"] == "game_planner_state").map(|t| &t["result"]).collect();
    assert_eq!(states.len(), 12, "one state per checkpoint");
    let spot = |state: &serde_json::Value, id: &str| -> serde_json::Value { state["spots"].as_array().unwrap().iter().find(|s| s["id"] == id).cloned().unwrap_or_else(|| panic!("no spot {id}")) };
    let num = |v: &serde_json::Value| v.as_f64().unwrap();

    // The preset loaded with its five spots and the relief view.
    assert_eq!(states[0]["counts"]["spots"], 5);
    assert_eq!(states[0]["terrainStyle"], "relief");

    // A click on Iron Gate Fortress selected it (map clicks used to be dropped before reaching the addon).
    assert_eq!(states[1]["selectedId"], "spot_iron_gate_keep");

    // Dragging Oakhaven moved it and put it on the ground at its new place.
    let before = spot(states[0], "spot_oakhaven");
    let after = spot(states[2], "spot_oakhaven");
    assert_eq!(states[2]["selectedId"], "spot_oakhaven");
    assert!((num(&after["x"]) - num(&before["x"])).abs() > 1.0 && (num(&after["y"]) - num(&before["y"])).abs() > 1.0, "moved: {after}");
    assert_ne!(after["elevation"], before["elevation"], "elevation re-read from the terrain");
    assert!(states[2]["canUndo"].as_bool().unwrap());

    // The Spot tool placed a new town on land, with the ground's elevation.
    assert_eq!(states[3]["counts"]["spots"], 6);
    let placed = states[3]["spots"].as_array().unwrap().last().unwrap();
    assert_eq!(placed["spotType"], "town");
    assert!(num(&placed["elevation"]) > 0.0, "placed on land: {placed}");
    assert!((num(&placed["x"]) - 2.0).abs() < 0.11 && (num(&placed["y"]) + 2.0).abs() < 0.11, "snapped near [2, -2]: {placed}");

    // Drawing a path: three points, the last one snapped onto Drake's Caldera.
    let pending = states[4]["pendingPathPoints"].as_array().unwrap();
    assert_eq!(pending.len(), 3);
    assert_eq!(pending[2], serde_json::json!([8.5, -6]));
    assert_eq!(states[5]["counts"]["paths"], 4);
    assert_eq!(states[5]["activeTool"], "select");
    assert_eq!(states[5]["paths"].as_array().unwrap().last().unwrap()["pathType"], "road");

    // Measuring from the capital to the caldera, both ends snapped to the spots.
    assert_eq!(states[6]["measurePoints"]["p1"], serde_json::json!([0, 6.5]));
    assert_eq!(states[6]["measurePoints"]["p2"], serde_json::json!([8.5, -6]));
    let km = num(&states[6]["travel"]["distanceKm"]);
    assert!((km - 15.12).abs() < 0.05, "distance {km}");

    // An intent area sketched with real clicks, drafted by the Planner Agent and accepted: two new
    // villages inside it, and the intent's live check now passes.
    let farms = &states[7]["intents"][0];
    assert_eq!(farms["kind"], "settle");
    assert_eq!(farms["shape"], "area");
    assert_eq!(farms["status"], "done", "{farms}");
    assert_eq!(farms["evaluation"]["satisfied"], true, "{farms}");
    assert_eq!(states[7]["counts"]["spots"], 8);
    assert_eq!(states[7]["counts"]["pendingProposals"], 0);
    assert_eq!(states[7]["health"]["met"], 1);

    // A route between two spots with a four-hour target: too long now; the agent proposes a way.
    let pacing = &states[8]["intents"][1];
    assert_eq!(pacing["kind"], "pacing");
    assert_eq!(pacing["evaluation"]["satisfied"], false);
    assert_eq!(pacing["status"], "proposed");
    let pacing_prop = &states[8]["proposals"][1];
    assert_eq!(pacing_prop["intentId"], pacing["id"]);
    assert_eq!(pacing_prop["changes"][0]["changeType"], "add_path");

    // An external agent claimed the pinned intent by number and proposed a ruin and a codex entry
    // (its invalid third change was reported, not filed); accepting them met the intent. The
    // rejected pacing proposal left its intent open and the world without that path.
    let tool = |name: &str| result["tools"].as_array().unwrap().iter().find(|t| t["tool"] == name).map(|t| t["result"].clone()).unwrap();
    assert!(tool("game_planner_list_intents")["intents"].as_array().unwrap().len() >= 2);
    assert_eq!(tool("game_planner_claim_intent")["intent"]["status"], "claimed");
    let filed = tool("game_planner_propose_revision");
    assert_eq!(filed["filed"].as_array().unwrap().len(), 2, "{filed}");
    assert_eq!(filed["errors"].as_array().unwrap().len(), 1, "{filed}");
    let after = &states[9];
    assert_eq!(after["intents"][2]["status"], "done", "{}", after["intents"]);
    assert_eq!(after["intents"][1]["status"], "open", "{}", after["intents"]);
    assert_eq!(after["counts"]["spots"], 9);
    assert_eq!(after["counts"]["codex"], num(&states[7]["counts"]["codex"]) as u64 + 1);
    assert_eq!(after["counts"]["paths"], states[7]["counts"]["paths"], "the rejected trail was not built");
    assert_eq!(after["counts"]["pendingProposals"], 0);

    // The terrain tools added settlements, roads, rivers and points of interest.
    assert!(num(&states[10]["counts"]["spots"]) > 10.0, "{}", states[10]["counts"]);
    assert!(num(&states[10]["counts"]["paths"]) > 6.0, "{}", states[10]["counts"]);

    // Switching presets loaded the Crimson Expanse.
    assert_eq!(states[11]["counts"]["spots"], 5);
    assert_eq!(states[11]["activeTab"], "map");

    // What the planner saved: the world with its heightfield.
    let saved = read(&data.join("game-world-planner.json"));
    let terrain = &saved["terrain"];
    let (cols, rows) = (terrain["cols"].as_u64().unwrap(), terrain["rows"].as_u64().unwrap());
    assert!(cols >= 65 && rows >= 65);
    assert_eq!(terrain["data"].as_array().unwrap().len() as u64, cols * rows);
    assert!(saved["intents"].is_array(), "worlds save their intents");
}
