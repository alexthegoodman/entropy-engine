//! Live tier for the DAW's drum rack: launches the real compiled DAW (`example daw`) against a clean
//! data folder and a generated Music folder, and lets the in-engine driver play
//! `tests/features/daw_rack_live.feature` into it - the same widget events a tree row click and a pad
//! click push, plus composited-frame screenshots and readings from the audio engine's own taps.
//! No OS input automation is involved.
//!
//! Three independent things are checked: what the audio taps heard (each pad plays its own file's
//! frequency, on the preview bus, on the track, and in the running song), the project the addon
//! persisted, and the screenshots (real PNGs, not blank, each different from the last). Needs a real
//! desktop session and audio device, like the other live suites. Audibility to a person is not asserted.

use std::{collections::HashSet, fs, path::Path, process::Command};

const KICK_HZ: f64 = 300.0;
const SNARE_HZ: f64 = 900.0;
const HAT_HZ: f64 = 4000.0;

fn write_wav(path: &Path, rate: u32, hz: f64, ms: u64) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let spec = hound::WavSpec { channels: 1, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    let frames = rate as u64 * ms / 1000;
    for n in 0..frames {
        // A drum-like decay (down about 13 dB over the file) so the pad thumbnails show a shape
        // instead of a flat block; the frequency stays constant, which is what the taps are asked for.
        let envelope = (-1.5 * n as f64 / frames as f64).exp();
        let v = 0.6 * envelope * (2.0 * std::f64::consts::PI * hz * n as f64 / rate as f64).sin();
        w.write_sample((v * i16::MAX as f64) as i16).unwrap();
    }
    w.finalize().unwrap();
}

fn run_daw(root: &Path, data: &Path, music: &Path) -> serde_json::Value {
    let result_path = root.join("result-rack.json");
    let _ = fs::remove_file(&result_path);
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", data)
        .env("ENTROPY_DAW_BDD_FEATURE", "rack")
        .env("ENTROPY_MUSIC_DIR", music)
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
            panic!("the DAW rack run timed out before the engine finished its feature");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "the DAW exited with {status}");
    serde_json::from_slice(&fs::read(&result_path).expect("result json")).expect("valid result json")
}

fn near(actual: f64, expected: f64, tolerance: f64, what: &str) {
    assert!((actual - expected).abs() <= tolerance, "{what}: {actual:.1} Hz, expected {expected} +/- {tolerance}");
}

#[test]
fn daw_rack_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-rack-{}", std::process::id()));
    let data = root.join("data");
    let music = root.join("music");
    fs::create_dir_all(&data).unwrap();
    write_wav(&music.join("Drum Kit").join("kick_a.wav"), 44_100, KICK_HZ, 600);
    write_wav(&music.join("Drum Kit").join("snare_b.wav"), 44_100, SNARE_HZ, 450);
    write_wav(&music.join("Drum Kit").join("hat_c.wav"), 44_100, HAT_HZ, 150);
    write_wav(&music.join("Album").join("whole_song.wav"), 8_000, 220.0, 14_000);
    fs::write(music.join("Album").join("cover.jpg"), "not audio").unwrap();

    let result = run_daw(&root, &data, &music);
    assert_eq!(result["status"], "passed", "{result:#}");

    // ---- What the audio engine's own taps heard ----
    let peak_hz = |name: &str| result["analysis"][name]["peakHz"].as_f64().unwrap_or_else(|| panic!("no analysis {name}: {:#}", result["analysis"]));
    let peak_db = |name: &str| result["analysis"][name]["peakL"].as_f64().unwrap().max(result["analysis"][name]["peakR"].as_f64().unwrap());
    near(peak_hz("audition-kick"), KICK_HZ, 12.0, "the audition of the kick on the preview bus");
    near(peak_hz("kick-pad"), KICK_HZ, 12.0, "the kick pad");
    near(peak_hz("snare-pad"), SNARE_HZ, 25.0, "the snare pad");
    near(peak_hz("hat-pad"), HAT_HZ, 90.0, "the hat pad");
    for name in ["audition-kick", "kick-pad", "snare-pad", "hat-pad"] {
        println!("  {name}: {:.1} Hz at {:.1} dBFS", peak_hz(name), peak_db(name));
        assert!(peak_db(name) > -20.0, "{name} is only {:.1} dBFS", peak_db(name));
    }

    // The song plays the samples, not the synth voices: every audible reading sits on one of the three
    // sample frequencies (a built-in kick is a 55 Hz thump, the hat is noise), and something is audible.
    let mut audible = 0;
    for name in ["song-a", "song-b", "song-c"] {
        if peak_db(name) < -40.0 {
            println!("  {name}: between hits");
            continue;
        }
        audible += 1;
        let hz = peak_hz(name);
        println!("  {name}: {hz:.1} Hz at {:.1} dBFS", peak_db(name));
        let closest = [KICK_HZ, SNARE_HZ, HAT_HZ].into_iter().map(|f| (hz - f).abs() / f).fold(f64::MAX, f64::min);
        assert!(closest < 0.06, "{name} peaks at {hz:.1} Hz, which is none of the three sample frequencies");
    }
    assert!(audible >= 1, "the song was silent for all three readings");
    let song = result["measurements"]["song-drums"]["peakDb"].as_f64().unwrap();
    println!("  the drums track peaked at {song:.1} dBFS over the song interval");
    assert!(song > -30.0, "the drums track was nearly silent while the song played: {song:.1} dBFS");

    // ---- Screenshots: real, populated, and each one different from the last ----
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
    let drums = project["tracks"].as_array().unwrap().iter().find(|t| t["id"] == "trk-drums").expect("the drums track");
    let rack = drums["rack"].as_array().expect("the drums track has a rack");
    assert_eq!(rack.len(), 6, "five built-in pads plus the one added: {rack:#?}");
    assert_eq!(drums["rows"], 6);
    let file_of = |i: usize| rack[i]["sample"]["path"].as_str().map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned());
    assert_eq!(file_of(0).as_deref(), Some("kick_a.wav"));
    assert_eq!(file_of(1).as_deref(), Some("snare_b.wav"));
    assert_eq!(file_of(2).as_deref(), Some("hat_c.wav"));
    assert_eq!(file_of(3), None, "the clap was never touched");
    assert_eq!(rack[3]["voice"], "clap");
    assert_eq!(file_of(5).as_deref(), Some("whole_song.wav"), "the new pad took the long file");
    assert_eq!(rack[5]["name"], "whole_song", "a pad still called Pad N takes the file's name");

    println!("DAW rack live BDD passed; artifacts: {}", root.display());
}
