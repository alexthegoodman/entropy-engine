//! Live tier for the DAW's arrangement view: launches the real compiled DAW (`example daw`) against
//! a clean data folder and lets the in-engine driver play `tests/features/daw_arrangement_live.feature`
//! into it - the same widget-level events a click, a clip drag or a piano-roll stroke pushes, plus
//! composited-frame screenshots. No OS input automation is involved.
//!
//! Three independent things are checked: the run's own result (every step ran, every label the
//! feature expected was on screen), the project the addon persisted to disk, and the screenshots
//! themselves (real PNGs, not blank, each different from the last). Needs a real desktop session and
//! audio device, like the other live suites. Audibility is not asserted - that needs a person.

#[path = "common/daw_saved.rs"]
mod daw_saved;

use std::{collections::HashSet, fs, path::Path, process::Command};

fn run_daw(root: &Path, data: &Path) -> serde_json::Value {
    let result_path = root.join("result-arrangement.json");
    let export_path = root.join("arrangement-export.wav");
    let _ = fs::remove_file(&result_path);
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", data)
        .env("ENTROPY_DAW_BDD_FEATURE", "arrangement")
        // Forward slashes keep the path a plain JSON string when the feature's `{export}`
        // placeholder is substituted into the tool arguments; Windows accepts them as-is.
        .env("ENTROPY_DAW_BDD_EXPORT", export_path.to_string_lossy().replace('\\', "/"))
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
            panic!("the DAW arrangement run timed out before the engine finished its feature");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "the DAW exited with {status}");
    serde_json::from_slice(&fs::read(&result_path).expect("result json")).expect("valid result json")
}

fn clip<'a>(project: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
    project["arrangement"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("no clip {id} in the saved project"))
}

fn track<'a>(project: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
    project["tracks"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap_or_else(|| panic!("no track {id} in the saved project"))
}

/// Counts pixels close to the bass track's orange (242, 156, 74) - the colour the piano roll
/// paints its notes. The arrangement live run paints into the bass track, so the roll view's
/// painted notes are the one place this orange shows up as a large block.
fn count_orange(path: &str) -> usize {
    let bytes = fs::read(path).expect("screenshot exists");
    let image = image::load_from_memory(&bytes).expect("decodable PNG").to_rgba8();
    image.pixels().filter(|p| {
        let [r, g, b, _] = p.0;
        r as u32 >= 130 && g as u32 >= 70 && (b as u32) < 130 && r as i32 > g as i32 + 30 && g as i32 > b as i32 + 25
    }).count()
}

#[test]
fn daw_arrangement_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-arrangement-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();

    let result = run_daw(&root, &data);
    assert_eq!(result["status"], "passed", "{result:#}");

    // ---- Screenshots: real, populated, and each one different from the last ----
    let artifacts: Vec<String> = result["artifacts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(artifacts.len(), 11, "{artifacts:#?}");
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

    // ---- The piano roll's painted notes are actually on screen, not just in DAW.json ----
    let roll_capture = artifacts.iter().find(|p| Path::new(p).file_name().unwrap().to_string_lossy() == "arrangement-10-piano-roll.png")
        .expect("the piano-roll capture was written");
    let orange = count_orange(roll_capture);
    println!("  arrangement-10-piano-roll.png: {orange} bass-orange pixels");
    assert!(orange > 1000, "the piano roll's painted bass notes should dominate the roll capture, but only {orange} orange pixels were found");

    // ---- The exported WAV is a real, non-silent render, read back with hound ----
    let tools = result["tools"].as_array().unwrap_or_else(|| panic!("the run reported no tool results: {result:#}"));
    let export = tools.iter().find(|t| t["tool"] == "daw_export_wav").expect("the daw_export_wav tool result");
    let export_result = &export["result"];
    assert_eq!(export_result["success"], true, "{export_result:#}");
    let export_path = root.join("arrangement-export.wav");
    assert_eq!(export_result["path"].as_str().unwrap(), export_path.to_string_lossy().replace('\\', "/"), "{export_result:#}");

    let mut reader = hound::WavReader::open(&export_path).expect("the exported WAV can be read back");
    let spec = reader.spec();
    let n_samples = reader.len() as u64;
    let file_duration = n_samples as f64 / spec.sample_rate as f64 / spec.channels as f64;
    println!("  arrangement-export.wav: {file_duration:.2}s at {} Hz, {} channels", spec.sample_rate, spec.channels);
    // The starter song is 16 bars; at the 128 BPM the feature set, that is 30 s (plus a release tail).
    assert!(file_duration >= 28.0, "the export should cover the whole 30 s arrangement, not {file_duration:.2}s");
    let mut peak: i64 = 0;
    for s in reader.samples::<i16>() {
        let v = s.expect("bad sample") as i64;
        peak = peak.max(v.abs());
    }
    assert!(peak > 1000, "the export is silent (peak {peak})");

    // ---- The project the addon persisted ----
    let project: serde_json::Value = daw_saved::open_song(&data);
    assert_eq!(project["bpm"], 128.0, "the BPM field did not reach the project");

    let tracks = project["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 5, "four starter tracks plus the one drawn onto channel 9");
    let channels: HashSet<u64> = tracks.iter().map(|t| t["channel"].as_u64().unwrap()).collect();
    assert_eq!(channels.len(), 5, "every track sits on its own channel: {channels:?}");
    let drawn = tracks.iter().find(|t| t["channel"] == 8).expect("a track on channel 9 (index 8)");
    let drawn_clips: Vec<_> = project["arrangement"].as_array().unwrap().iter().filter(|c| c["trackId"] == drawn["id"]).collect();
    assert_eq!(drawn_clips.len(), 1, "{drawn_clips:#?}");
    assert_eq!((drawn_clips[0]["startStep"].as_i64(), drawn_clips[0]["lengthSteps"].as_i64()), (Some(32), Some(32)), "3750 ms at 128 BPM is bar 3, two bars long");

    // The duplicated bass pattern is a separate pattern, now what clip-bass-2 plays, with both painted notes.
    let bass = track(&project, "trk-bass");
    let patterns = bass["patterns"].as_array().unwrap();
    assert_eq!(patterns.len(), 3, "Root, Walk and the copy: {patterns:#?}");
    let copy = patterns.iter().find(|p| p["name"] == "Root copy").expect("a duplicated pattern");
    assert_eq!(clip(&project, "clip-bass-2")["patternId"], copy["id"]);
    let notes: Vec<(i64, i64)> = copy["notes"].as_array().unwrap().iter().map(|n| (n["row"].as_i64().unwrap(), n["step"].as_i64().unwrap())).collect();
    assert!(notes.contains(&(5, 6)) && notes.contains(&(3, 10)), "the painted notes are missing: {notes:?}");
    assert_eq!(notes.len(), 6, "four copied notes plus two painted ones: {notes:?}");
    let original = patterns.iter().find(|p| p["name"] == "Root").unwrap();
    assert_eq!(original["notes"].as_array().unwrap().len(), 4, "painting into the copy must not touch the original");

    // Mute/solo reached the project: the pad is muted; the lead's solo was switched on then off again.
    assert_eq!(track(&project, "trk-pad")["muted"], true);
    assert_eq!(track(&project, "trk-lead")["solo"], false);

    println!("DAW arrangement live BDD passed; artifacts: {}", root.display());
}
