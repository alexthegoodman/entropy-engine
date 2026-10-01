use std::{fs, process::Command, time::{Duration, Instant}};

#[test]
fn live_kanban_pointer_drag_reaches_addon() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("app-pointer-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let board_path = data.join("tasks.json");
    fs::write(&board_path, serde_json::to_vec_pretty(&serde_json::json!({
        "columns": [
            { "id": "backlog", "title": "Backlog", "cards": [{ "id": "drag-me", "title": "Drag me", "description": "", "tags": [] }] },
            { "id": "in_progress", "title": "In Progress", "cards": [] },
            { "id": "review", "title": "Review", "cards": [] },
            { "id": "done", "title": "Done", "cards": [] }
        ]
    })).unwrap()).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("special-bundle")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_FEATURE", "app-pointer")
        .env("ENTROPY_BUNDLE_BDD_DATA", &data)
        .spawn()
        .expect("launch creative suite pointer BDD");
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > Duration::from_secs(180) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("app pointer BDD timed out");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(status.success(), "app pointer BDD exited with {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).expect("BDD result")).unwrap();
    assert_eq!(result["status"], "passed", "{result:#}");
    let board: serde_json::Value = serde_json::from_slice(&fs::read(&board_path).expect("saved board")).unwrap();
    assert_eq!(board["columns"][0]["cards"].as_array().unwrap().len(), 0, "{board:#}");
    assert_eq!(board["columns"][1]["cards"][0]["id"], "drag-me", "{board:#}");
    let song_path = fs::read_dir(data.join("DAW").join("songs")).unwrap()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|ext| ext == "json"))
        .expect("DAW song saved after track click");
    let song: serde_json::Value = serde_json::from_slice(&fs::read(song_path).unwrap()).unwrap();
    assert_eq!(song["project"]["activeTrackId"], "trk-bass", "{song:#}");
    let bass_clip = song["project"]["arrangement"].as_array().unwrap().iter()
        .find(|clip| clip["id"] == "clip-bass-2").expect("starter bass clip");
    assert_eq!(bass_clip["startStep"], 0, "{song:#}");
}
