//! Live tier for the DAW's analyzer: launches the real compiled DAW (`example daw`) against a clean
//! data folder, plays through the machine's real output device, and lets the in-engine driver play
//! `tests/features/daw_analyzer_live.feature` into it.
//!
//! What is asserted is the audio, not how it looks: each `I record the analysis` step reads the
//! audio engine's own taps (peak, RMS, strongest frequency, brightness) at that moment and writes
//! them into the run's result. The screenshots are the visual record of the same moments, checked
//! only for being real, populated, and different from each other. Audibility is not asserted - that
//! needs a person - but the numbers below can only be true if the mix really reached the master bus.

use std::{collections::HashSet, fs, path::Path, process::Command};

fn run_daw(root: &Path, data: &Path) -> serde_json::Value {
    let result_path = root.join("result-analyzer.json");
    let _ = fs::remove_file(&result_path);
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", data)
        .env("ENTROPY_DAW_BDD_FEATURE", "analyzer")
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
            panic!("the DAW analyzer run timed out before the engine finished its feature");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "the DAW exited with {status}");
    serde_json::from_slice(&fs::read(&result_path).expect("result json")).expect("valid result json")
}

fn f(v: &serde_json::Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or_else(|| panic!("no number {key} in {v}"))
}

fn peak_db(a: &serde_json::Value) -> f64 {
    f(a, "peakL").max(f(a, "peakR"))
}

fn rms_db(a: &serde_json::Value) -> f64 {
    f(a, "rmsL").max(f(a, "rmsR"))
}

#[test]
fn daw_analyzer_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-analyzer-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();

    let result = run_daw(&root, &data);
    assert_eq!(result["status"], "passed", "{result:#}");
    let a = &result["analysis"];
    for name in ["idle-master", "song-master", "stopped-master", "lead-c4-track", "lead-c4-master", "bass-c2-track"] {
        let x = &a[name];
        println!(
            "  {name:16} peak {:7.1} dBFS  rms {:7.1} dBFS  strongest {:8.1} Hz at {:6.1} dB  brightness {:7.0} Hz  frames {}",
            peak_db(x), rms_db(x), f(x, "peakHz"), f(x, "peakDb"), f(x, "centroidHz"), x["framesWritten"]
        );
    }

    // ---- The audio thread runs continuously, in real time, with nothing playing ----
    let idle = &a["idle-master"];
    assert!(f(idle, "framesWritten") > 0.0, "the master tap never advanced: the audio thread is not running");
    assert!(peak_db(idle) < -80.0, "a DAW that has not been asked to play must be silent, got {} dBFS", peak_db(idle));

    // ---- The starter song reaches the master bus and its own track's tap ----
    // Levels are asserted over the whole time the song played, not at one instant: a drum track
    // spends most of its time between hits, and one 93 ms window landed in a gap on a re-run.
    let m = &result["measurements"];
    let master_peak = m["song-master-peak"]["peakDb"].as_f64().unwrap();
    let drums_peak = m["song-drums"]["peakDb"].as_f64().unwrap();
    println!("  over the ~1.8 s the song played: master peak {master_peak:.1} dBFS ({} frames covered), drums peak {drums_peak:.1} dBFS", m["song-master-peak"]["framesCovered"]);
    assert!(master_peak > -40.0 && master_peak < 3.0, "the song's peak should be a real level, got {master_peak} dBFS");
    assert!(drums_peak > -50.0, "the drum track's own tap stayed silent while the song played: {drums_peak} dBFS");
    assert!(m["song-master-peak"]["framesCovered"].as_u64().unwrap() > 44100, "the measurement covered too little audio to mean anything");
    let song = &a["song-master"];

    // The taps count real audio frames: between the two reads the song played for about 1.8 s of
    // wall-clock time plus the driver's frames, so the counter must have moved by roughly that
    // many frames at 44.1 kHz. A tap that were being fed faster or slower than real time would not.
    let advanced = f(song, "framesWritten") - f(idle, "framesWritten");
    println!("  the master tap advanced {advanced} frames between the idle and song reads ({:.2} s at 44.1 kHz)", advanced / 44100.0);
    assert!(advanced > 44100.0 * 1.5 && advanced < 44100.0 * 6.0, "{advanced} frames is not a real-time amount of audio for this feature");

    // ---- Stopping lets the audio decay to silence ----
    let stopped = &a["stopped-master"];
    assert!(peak_db(stopped) < -60.0, "after stopping and waiting for the release the master should be silent, got {} dBFS", peak_db(stopped));

    // ---- A previewed note has the pitch of its row ----
    // Lead is a square wave rooted at C4 (261.63 Hz); Bass is a saw rooted at C2 (65.41 Hz). Row 0 is
    // the root of each track's scale. 4096 frames at 44.1 kHz resolve 10.8 Hz per bin; the analyzer
    // interpolates to well inside that.
    let lead = &a["lead-c4-track"];
    assert!((f(lead, "peakHz") - 261.63).abs() < 4.0, "the Lead's row 0 sounds at {} Hz, expected C4 = 261.63", f(lead, "peakHz"));
    assert!(peak_db(lead) > -40.0, "the lead note is too quiet to trust: {} dBFS", peak_db(lead));
    let lead_master = &a["lead-c4-master"];
    assert!((f(lead_master, "peakHz") - f(lead, "peakHz")).abs() < 2.0, "with only one track sounding, the master should hear what that track does");
    let bass = &a["bass-c2-track"];
    assert!((f(bass, "peakHz") - 65.41).abs() < 4.0, "the Bass's row 0 sounds at {} Hz, expected C2 = 65.41", f(bass, "peakHz"));
    assert!(f(bass, "centroidHz") < f(lead, "centroidHz"), "the bass ({} Hz) should be darker than the lead ({} Hz)", f(bass, "centroidHz"), f(lead, "centroidHz"));

    // ---- Screenshots: real, populated, and each one different from the last ----
    let artifacts: Vec<String> = result["artifacts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(artifacts.len(), 6, "{artifacts:#?}");
    let mut hashes = HashSet::new();
    let mut mint_pixels = Vec::new();
    for path in &artifacts {
        let bytes = fs::read(path).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{path} is not a PNG");
        let image = image::load_from_memory(&bytes).expect("decodable PNG").to_rgba8();
        let colours: HashSet<[u8; 4]> = image.pixels().map(|p| p.0).collect();
        // Trace and fill pixels: green-heavy, unlike the grey UI chrome.
        let mint = image.pixels().filter(|p| p[1] > 130 && p[2] > 100 && (p[1] as i32 - p[0] as i32) > 60).count();
        mint_pixels.push(mint);
        println!("  {}: {}x{}, {} colours, {} trace-coloured pixels", Path::new(path).file_name().unwrap().to_string_lossy(), image.width(), image.height(), colours.len(), mint);
        assert!(image.width() >= 1000 && image.height() >= 600, "{path} is only {}x{}", image.width(), image.height());
        assert!(colours.len() > 400, "{path} looks blank: {} colours", colours.len());
        assert!(hashes.insert(bytes), "{path} is byte-identical to an earlier capture, so nothing on screen changed between steps");
    }
    // The idle capture has no signal to draw; the playing captures must have a lot more trace on screen.
    assert!(mint_pixels[1] > mint_pixels[0] + 500, "the analyzer drew no more while the song played ({} vs {} trace pixels)", mint_pixels[1], mint_pixels[0]);

    println!("DAW analyzer live BDD passed; artifacts: {}", root.display());
}
