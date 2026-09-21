//! Live tier for the DAW's wavetable synth: launches the real compiled DAW (`example daw`) against a
//! clean data folder and lets the in-engine driver play `tests/features/daw_wavetable_live.feature`
//! into it, through the machine's real output device and the real renderer.
//!
//! Four independent things are checked. What the audio taps heard: a key pressed through the real
//! widget event plays its own pitch on the track's bus and stops when released, and a latched note
//! brightens when its position moves. What the engine says a note sounds like (the "hear" tool plays
//! a note offline through the same voice and reads it back): sculpting the table changes it. The
//! project the addon persisted, including the table's real on-disk format. And the screenshots (real
//! PNGs of the real window, not blank, each different from the last). Needs a real desktop session
//! and audio device, like the other live suites. Audibility to a person is not asserted.

use std::{collections::HashSet, fs, path::Path, process::Command};

fn run_daw(root: &Path, data: &Path) -> serde_json::Value {
    let result_path = root.join("result-wavetable.json");
    let _ = fs::remove_file(&result_path);
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", data)
        .env("ENTROPY_DAW_BDD_FEATURE", "wavetable")
        .spawn()
        .expect("launch the DAW");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > std::time::Duration::from_secs(240) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the DAW wavetable run timed out before the engine finished its feature");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "the DAW exited with {status}");
    serde_json::from_slice(&fs::read(&result_path).expect("result json")).expect("valid result json")
}

fn num(v: &serde_json::Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or_else(|| panic!("no number {key} in {v}"))
}

fn peak_db(a: &serde_json::Value) -> f64 {
    num(a, "peakL").max(num(a, "peakR"))
}

#[test]
fn daw_wavetable_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-wavetable-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();

    let result = run_daw(&root, &data);
    assert_eq!(result["status"], "passed", "{result:#}");
    let a = |name: &str| result["analysis"][name].clone();

    // ---- A key pressed on the terrain's keyboard plays its own pitch, and stops when released ----
    let key = a("key-c4");
    println!("  key-c4: {:.1} Hz at {:.1} dBFS, brightness {:.0} Hz", num(&key, "peakHz"), peak_db(&key), num(&key, "centroidHz"));
    assert!((num(&key, "peakHz") - 261.63).abs() < 8.0, "C4 sounded at {:.1} Hz", num(&key, "peakHz"));
    assert!(peak_db(&key) > -35.0, "the held key is only {:.1} dBFS", peak_db(&key));
    let gone = a("after-release");
    println!("  after-release: {:.1} dBFS", peak_db(&gone));
    assert!(peak_db(&gone) < peak_db(&key) - 25.0, "the note did not stop when the key came up: {:.1} dBFS then {:.1}", peak_db(&key), peak_db(&gone));

    // ---- A latched note follows the position through the table ----
    let (low, high) = (a("latched-low"), a("latched-high"));
    println!("  latched at position 0.05: {:.0} Hz bright, at 0.95: {:.0} Hz bright", num(&low, "centroidHz"), num(&high, "centroidHz"));
    assert!(peak_db(&low) > -35.0 && peak_db(&high) > -35.0, "the latched note was not sounding");
    assert!(num(&high, "centroidHz") > num(&low, "centroidHz") * 1.5, "moving a held note from the sine end to the saw end of the table did not brighten it");

    // ---- Sculpting the table changes what a note sounds like ----
    let tool = |i: usize| result["tools"][i]["result"].clone();
    for (i, expected) in [(0, "daw_set_track_params"), (3, "daw_wavetable"), (5, "daw_wavetable"), (7, "daw_wavetable")] {
        assert_eq!(result["tools"][i]["tool"], expected, "tool call {i}: {:#}", result["tools"][i]);
    }
    let (before, after) = (tool(4), tool(6));
    assert_eq!(before["success"], true, "{before:#}");
    println!("  a sine at 220 Hz: {:.0} Hz bright; after a spike is sculpted into the table: {:.0} Hz bright", num(&before, "brightnessHz"), num(&after, "brightnessHz"));
    assert!((num(&before, "strongestHz") - 220.0).abs() < 6.0, "the sine table's note is at {:.1} Hz", num(&before, "strongestHz"));
    assert!(num(&after, "brightnessHz") > num(&before, "brightnessHz") + 150.0, "sculpting a spike into the table did not make the note brighter");
    let touched = tool(5);
    assert_eq!(touched["success"], true, "{touched:#}");
    assert!(touched["touchedFrames"].is_array(), "the sculpt reported no frames: {touched:#}");
    let harmonics = tool(7);
    let h = harmonics["harmonics"].as_array().expect("info reports harmonics");
    assert!(h.len() >= 8 && h.iter().skip(2).any(|v| v.as_f64().unwrap() > 0.02), "a spike should put energy into the upper harmonics of its frames: {h:?}");

    // ---- The vowels table moves through formants ----
    let vowel = |i: usize| num(&tool(i), "brightnessHz");
    let (v0, v1, v2) = (vowel(9), vowel(10), vowel(11));
    println!("  vowels at 0.0 / 0.5 / 1.0: {v0:.0} / {v1:.0} / {v2:.0} Hz bright");
    let spread = v0.max(v1).max(v2) - v0.min(v1).min(v2);
    assert!(spread > 60.0, "the vowels table sounds the same at three positions: {v0:.0} {v1:.0} {v2:.0}");

    // ---- The song plays the wavetable through the track's own bus ----
    let song = result["measurements"]["song-lead"]["peakDb"].as_f64().unwrap();
    println!("  the lead peaked at {song:.1} dBFS over the song interval");
    assert!(song > -40.0, "the wavetable lead was nearly silent while the song played: {song:.1} dBFS");

    // ---- Screenshots ----
    let artifacts: Vec<String> = result["artifacts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(artifacts.len(), 7, "{artifacts:#?}");
    let mut hashes = HashSet::new();
    for path in &artifacts {
        let bytes = fs::read(path).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{path} is not a PNG");
        let image = image::load_from_memory(&bytes).expect("decodable PNG").to_rgba8();
        let colours: HashSet<[u8; 4]> = image.pixels().map(|p| p.0).collect();
        println!("  {}: {}x{}, {} colours", Path::new(path).file_name().unwrap().to_string_lossy(), image.width(), image.height(), colours.len());
        assert!(image.width() >= 1000 && image.height() >= 600, "{path} is only {}x{}", image.width(), image.height());
        assert!(colours.len() > 400, "{path} looks blank: {} colours", colours.len());
        assert!(hashes.insert(bytes), "{path} is byte-identical to an earlier capture, so nothing on screen changed between steps");
    }

    // ---- The project the addon persisted ----
    let project: serde_json::Value = serde_json::from_slice(&fs::read(data.join("DAW.json")).expect("DAW.json saved")).unwrap();
    let lead = project["tracks"].as_array().unwrap().iter().find(|t| t["id"] == "trk-lead").expect("the lead track");
    assert_eq!(lead["voice"]["waveform"], "wavetable");
    let wt = &lead["wavetable"];
    assert_eq!(wt["preset"], "terrain", "the last preset chosen: {wt:#}");
    let encoded = wt["data"].as_str().expect("the saved table");
    // "WVT1" in base64 is "V1ZUM"; 32 frames of 2048 16-bit samples plus the header is 131,080 bytes.
    assert!(encoded.starts_with("V1ZUM"), "the saved table does not start with the WVT1 header: {}", &encoded[..16.min(encoded.len())]);
    assert!(encoded.len() > 170_000, "a 32-frame table saves as about 175,000 base64 characters, got {}", encoded.len());

    println!("DAW wavetable live BDD passed; artifacts: {}", root.display());
}
