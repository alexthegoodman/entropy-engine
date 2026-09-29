//! Live BDD for the piano editor. Requires a desktop session and an audio output device.
//! `cargo test --test daw_piano_live -- --nocapture`

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
fn daw_piano_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-piano-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result-piano.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", &data)
        .env("ENTROPY_DAW_BDD_FEATURE", "piano")
        .spawn()
        .expect("launch the DAW");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(240) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the DAW piano run timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "the DAW exited with {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).expect("result json")).expect("valid result json");
    assert_eq!(result["status"], "passed", "{result:#}");

    let analysis = |name: &str| &result["analysis"][name];
    let key=analysis("key-c4");
    assert!(peak_db(key)>-40.0,"silent keyboard: {key}");
    let released=analysis("released");
    assert!(peak_db(released)<peak_db(key)-18.0,"release failed: {key} -> {released}");
    let ring=analysis("pedal-ring");
    assert!(peak_db(ring)>peak_db(released)+12.0,"pedal did not sustain: {ring}");
    assert!(peak_db(analysis("pedal-released"))<peak_db(ring)-15.0,"pedal did not damp");
    let tools=result["tools"].as_array().unwrap();
    for t in tools {assert_eq!(t["result"]["success"],true,"{t}");}
    let warm=&tools[4]["result"]; let bright=&tools[6]["result"];
    assert!(num(bright,"brightnessHz")>num(warm,"brightnessHz")*1.05,"presets: {warm} {bright}");
    assert!(num(&result["measurements"]["song"],"peakDb") > -40.0);
    let artifacts=result["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(),5);
    let mut hashes=HashSet::new();
    for a in artifacts {
        let bytes=fs::read(a.as_str().unwrap()).unwrap();
        let img=image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert!(img.width()>=900 && img.height()>=500);
        assert!(img.pixels().map(|p|p.0).collect::<HashSet<_>>().len()>400);
        assert!(hashes.insert(bytes));
    }
    let saved=daw_saved::open_song(&data);
    let lead=saved["tracks"].as_array().unwrap().iter().find(|t|t["id"]=="trk-lead").unwrap();
    assert_eq!(lead["voice"]["waveform"],"piano");
    assert_eq!(lead["piano"]["preset"],"BrightGrand");
    println!("Piano native BDD: {}\n{result:#}",root.display());
}
