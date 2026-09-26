//! Live BDD for the drum kit. Requires a desktop session and an audio output device.
//! `cargo test --test daw_matter_live -- --nocapture`

#[path = "common/daw_saved.rs"]
mod daw_saved;

use std::{collections::HashSet, fs, process::Command};

fn num(v: &serde_json::Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or_else(|| panic!("no number {key} in {v}"))
}

fn peak_db(v: &serde_json::Value) -> f64 {
    num(v, "peakL").max(num(v, "peakR"))
}

#[test]
fn daw_matter_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-matter-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result-matter.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", &data)
        .env("ENTROPY_DAW_BDD_FEATURE", "matter")
        .spawn()
        .expect("launch the DAW");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(240) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the DAW kit run timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "the DAW exited with {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).expect("result json")).expect("valid result json");
    assert_eq!(result["status"], "passed", "{result:#}");

    let analysis = |name: &str| &result["analysis"][name];
    for name in ["pad-snare", "click-floor-tom", "tool-strike"] {
        assert!(peak_db(analysis(name)) > -45.0, "{name} is silent: {:#}", analysis(name));
    }

    let tools = result["tools"].as_array().expect("tool results");
    assert_eq!(tools.len(), 4, "{tools:#?}");
    assert_eq!(tools[1]["result"]["settings"]["preset"], "rock");
    assert_eq!(tools[2]["result"]["success"], true, "{:#}", tools[2]);
    assert_eq!(tools[2]["result"]["piece"], "snare");
    assert!(num(&tools[2]["result"], "wireLandings") > 0.0, "the snare's wires should rattle: {:#}", tools[2]);
    assert!(num(&result["measurements"]["song-lead"], "peakDb") > -45.0, "the kit in the song was silent");

    let artifacts = result["artifacts"].as_array().expect("screenshots");
    assert_eq!(artifacts.len(), 6, "{artifacts:#?}");
    let mut hashes = HashSet::new();
    for item in artifacts {
        let path = item.as_str().expect("screenshot path");
        let bytes = fs::read(path).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        let image = image::load_from_memory(&bytes).expect("decodable PNG").to_rgba8();
        let colours: HashSet<[u8; 4]> = image.pixels().map(|p| p.0).collect();
        assert!(image.width() >= 900 && image.height() >= 500 && colours.len() > 400, "{path} looks blank");
        assert!(hashes.insert(bytes), "{path} is identical to an earlier screenshot");
    }

    let project = daw_saved::open_song(&data);
    let lead = project["tracks"].as_array().unwrap().iter().find(|t| t["id"] == "trk-lead").expect("the lead track");
    assert_eq!(lead["voice"]["waveform"], "matter");
    assert_eq!(lead["matter"]["preset"], "rock");
    println!("DAW kit live BDD passed; artifacts: {}", root.display());
}
