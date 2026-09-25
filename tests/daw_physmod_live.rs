//! Live tier for the DAW's bowed-string synth: launches the real compiled DAW (`example daw`)
//! against a clean data folder and lets the in-engine driver play
//! `tests/features/daw_physmod_live.feature` into it, through the machine's real output device and
//! real renderer. Same shape as `daw_wavetable_live.rs`.
//!
//! Checked: a key pressed through the real widget event plays its own pitch on the track's bus and
//! stops when released; a latched note brightens as bow force rises (both through a knob-equivalent
//! tool call and a direct widget bow-drag event); switching instrument changes a note's timbre even
//! at the same requested pitch; the song plays the bowed string through the track's own bus; and the
//! screenshots (real PNGs of the real window, not blank, each different from the last). Audibility to
//! a person is not asserted.

#[path = "common/daw_saved.rs"]
mod daw_saved;

use std::{collections::HashSet, fs, path::Path, process::Command};

fn run_daw(root: &Path, data: &Path) -> serde_json::Value {
    let result_path = root.join("result-physmod.json");
    let _ = fs::remove_file(&result_path);
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", data)
        .env("ENTROPY_DAW_BDD_FEATURE", "physmod")
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
            panic!("the DAW physmod run timed out before the engine finished its feature");
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
fn daw_physmod_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-physmod-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();

    let result = run_daw(&root, &data);
    assert_eq!(result["status"], "passed", "{result:#}");
    let a = |name: &str| result["analysis"][name].clone();

    // ---- A key pressed on the string's keyboard plays its own pitch, and stops when released ----
    let key = a("key-c4");
    println!("  key-c4: {:.1} Hz at {:.1} dBFS, brightness {:.0} Hz", num(&key, "peakHz"), peak_db(&key), num(&key, "centroidHz"));
    assert!((num(&key, "peakHz") - 261.63).abs() < 15.0, "C4 sounded at {:.1} Hz", num(&key, "peakHz"));
    assert!(peak_db(&key) > -35.0, "the held key is only {:.1} dBFS", peak_db(&key));
    let gone = a("after-release");
    println!("  after-release: {:.1} dBFS", peak_db(&gone));
    assert!(peak_db(&gone) < peak_db(&key) - 20.0, "the note did not stop when the key came up: {:.1} dBFS then {:.1}", peak_db(&key), peak_db(&gone));

    // ---- A latched note brightens as bow force rises, through a tool call ----
    let (soft, hard) = (a("latched-soft"), a("latched-hard"));
    println!("  latched at bowForce 0.1: {:.0} Hz bright, at 0.95: {:.0} Hz bright", num(&soft, "centroidHz"), num(&hard, "centroidHz"));
    assert!(peak_db(&soft) > -40.0 && peak_db(&hard) > -40.0, "the latched note was not sounding");
    assert!(num(&hard, "centroidHz") > num(&soft, "centroidHz"), "raising bow force from 0.1 to 0.95 did not brighten the held note");

    // ---- Dragging the bow in the view moves the same held note ----
    let dragged = a("bow-dragged");
    println!("  after a bow drag: {:.1} dBFS, {:.0} Hz bright", peak_db(&dragged), num(&dragged, "centroidHz"));
    assert!(peak_db(&dragged) > -40.0, "the note was not sounding after the bow was dragged");

    // ---- Switching instrument changes the tone at the same requested pitch ----
    let tool = |i: usize| result["tools"][i]["result"].clone();
    for (i, expected) in [(0, "daw_set_track_params"), (3, "daw_physmod"), (4, "daw_physmod"), (5, "daw_physmod"), (6, "daw_physmod")] {
        assert_eq!(result["tools"][i]["tool"], expected, "tool call {i}: {:#}", result["tools"][i]);
    }
    let (violin, cello) = (tool(4), tool(6));
    assert_eq!(violin["success"], true, "{violin:#}");
    assert_eq!(cello["success"], true, "{cello:#}");
    println!("  A3 on violin: {:.1} Hz, {:.0} Hz bright; on cello: {:.1} Hz, {:.0} Hz bright", num(&violin, "strongestHz"), num(&violin, "brightnessHz"), num(&cello, "strongestHz"), num(&cello, "brightnessHz"));
    assert!((num(&violin, "strongestHz") - 220.0).abs() / 220.0 < 0.1, "A3 on the violin sounded at {:.1} Hz", num(&violin, "strongestHz"));
    assert!((num(&cello, "strongestHz") - 220.0).abs() / 220.0 < 0.1, "A3 on the cello sounded at {:.1} Hz", num(&cello, "strongestHz"));
    assert!((num(&violin, "brightnessHz") - num(&cello, "brightnessHz")).abs() > 10.0, "the same note on a violin and a cello should not sound identical: {:.0} vs {:.0} Hz bright", num(&violin, "brightnessHz"), num(&cello, "brightnessHz"));

    // ---- The song plays the bowed string through the track's own bus ----
    let song = result["measurements"]["song-lead"]["peakDb"].as_f64().unwrap();
    println!("  the lead peaked at {song:.1} dBFS over the song interval");
    assert!(song > -40.0, "the bowed-string lead was nearly silent while the song played: {song:.1} dBFS");

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
        assert!(image.width() >= 900 && image.height() >= 500, "{path} is only {}x{}", image.width(), image.height());
        assert!(colours.len() > 400, "{path} looks blank: {} colours", colours.len());
        assert!(hashes.insert(bytes), "{path} is byte-identical to an earlier capture, so nothing on screen changed between steps");
    }

    // ---- The project the addon persisted ----
    let project: serde_json::Value = daw_saved::open_song(&data);
    let lead = project["tracks"].as_array().unwrap().iter().find(|t| t["id"] == "trk-lead").expect("the lead track");
    assert_eq!(lead["voice"]["waveform"], "physmod");
    let pm = &lead["physmod"];
    assert_eq!(pm["instrument"], "violin", "the last instrument chosen: {pm:#}");

    println!("DAW physmod live BDD passed; artifacts: {}", root.display());
}
