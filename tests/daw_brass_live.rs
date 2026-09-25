//! Live BDD for the brass editor. Requires a desktop session and an audio output device.
//! `cargo test --test daw_brass_live -- --nocapture`

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
fn daw_brass_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-brass-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result-brass.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", &data)
        .env("ENTROPY_DAW_BDD_FEATURE", "brass")
        .spawn()
        .expect("launch the DAW");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(240) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the DAW brass run timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "the DAW exited with {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).expect("result json")).expect("valid result json");
    assert_eq!(result["status"], "passed", "{result:#}");

    let analysis = |name: &str| &result["analysis"][name];
    let held = analysis("key-bb3");
    assert!(peak_db(held) > -45.0, "keyboard note is silent: {held:#}");
    assert!((num(held, "peakHz") - 233.08).abs() < 35.0, "B-flat 3 sounded at {} Hz", num(held, "peakHz"));
    let released = analysis("after-release");
    assert!(peak_db(released) < peak_db(held) - 18.0, "the keyboard note did not release: {held:#} then {released:#}");
    for name in ["latched-section", "latched-blazing", "playing-map"] {
        assert!(peak_db(analysis(name)) > -45.0, "{name} is silent: {:#}", analysis(name));
    }

    let tools = result["tools"].as_array().expect("tool results");
    assert_eq!(tools.len(), 5, "{tools:#?}");
    assert_eq!(tools[1]["result"]["settings"]["instrument"], "trumpet");
    assert_eq!(tools[3]["result"]["settings"]["mute"], "cup");
    for i in [2, 4] {
        assert_eq!(tools[i]["result"]["success"], true, "{:#}", tools[i]);
        assert!((num(&tools[i]["result"], "pitchHz") - 466.16).abs() < 35.0, "trumpet B-flat 4: {:#}", tools[i]);
    }
    assert!(num(&result["measurements"]["song-lead"], "peakDb") > -45.0, "the brass song lead was silent");

    let artifacts = result["artifacts"].as_array().expect("screenshots");
    assert_eq!(artifacts.len(), 7, "{artifacts:#?}");
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
    assert_eq!(lead["voice"]["waveform"], "brass");
    assert_eq!(lead["brass"]["instrument"], "trumpet");
    assert_eq!(lead["brass"]["mute"], "cup");
    println!("DAW brass live BDD passed; artifacts: {}", root.display());
}
