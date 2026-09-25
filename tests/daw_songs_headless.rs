//! The real, bundled DAW (`examples/studio-bundle/dist/daw.js`, built by `npm run build-daw`) started
//! in the engine's V8 runtime without a window, against a data folder: once on a folder holding an
//! old single-file `DAW.json`, then again on what that run left. Checks the song library's files on
//! disk, not the addon's own view of them. The UI flows are covered by daw_songs_bdd.test.ts.

use entropy_engine::deno::addon_engine::AddonEngine;
use std::{fs, path::{Path, PathBuf}};

#[path = "common/daw_saved.rs"]
mod daw_saved;

fn daw_bundle() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/studio-bundle/dist/daw.js");
    fs::read_to_string(&path).unwrap_or_else(|_| panic!("{} is missing: run `npm run build-daw` in examples/studio-bundle", path.display()))
}

fn start_daw(data: &Path) {
    let mut engine = AddonEngine::new(None, Some(data.to_path_buf()), None);
    let bundle: &'static str = Box::leak(daw_bundle().into_boxed_str());
    engine.load_bundle_sync("daw.js", bundle).expect("the DAW bundle starts");
}

fn json(path: PathBuf) -> serde_json::Value {
    serde_json::from_slice(&fs::read(&path).unwrap_or_else(|_| panic!("{} exists", path.display()))).unwrap()
}

#[test]
fn an_old_daw_json_becomes_the_first_song_and_the_library_survives_a_restart() {
    let data = std::env::temp_dir().join(format!("entropy-daw-songs-{}", std::process::id()));
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(&data).unwrap();
    let old = serde_json::json!({
        "bpm": 111, "stepsPerBeat": 4, "songBars": 8, "snap": "bar", "arrangement": [], "activeTrackId": "t1",
        "tracks": [{ "id": "t1", "name": "Keys", "kind": "synth", "rootNote": 60, "scale": "major", "rows": 7, "gain": 0.3,
            "muted": false, "solo": false, "channel": 0, "colorIndex": 0,
            "voice": { "waveform": "saw", "cutoff": 4000, "resonance": 1, "attack": 0.01, "decay": 0.1, "sustain": 0.5, "release": 0.1,
                "delayTime": 0, "delayFeedback": 0.3, "delayMix": 0, "reverbRoomSize": 10, "reverbTime": 1, "reverbDamping": 0.5, "reverbMix": 0 },
            "patterns": [{ "id": "p1", "name": "A", "steps": 16, "notes": [] }], "activePatternId": "p1" }]
    });
    let old_text = serde_json::to_string(&old).unwrap();
    fs::write(data.join("DAW.json"), &old_text).unwrap();

    start_daw(&data);
    let library = json(data.join("DAW/library.json"));
    assert_eq!(library["format"], "entropy-daw-library");
    let songs = library["songs"].as_array().unwrap();
    assert_eq!(songs.len(), 1, "{library:#}");
    assert_eq!(songs[0]["name"], "My song");
    let song = daw_saved::open_song(&data);
    assert_eq!(song["bpm"], 111);
    assert_eq!(song["tracks"][0]["name"], "Keys");
    assert_eq!(fs::read_to_string(data.join("DAW.json")).unwrap(), old_text, "the old file is left exactly as it was");

    let id = songs[0]["id"].as_str().unwrap();
    let history = json(data.join(format!("DAW/versions/{id}/index.json")));
    let versions = history["versions"].as_array().unwrap();
    assert_eq!(versions.len(), 1, "{history:#}");
    assert_eq!(versions[0]["kind"], "imported");
    let version_file = data.join(format!("DAW/versions/{id}/{}.json", versions[0]["id"].as_str().unwrap()));
    assert_eq!(json(version_file)["project"]["bpm"], 111);

    // A second start opens the same song and adds no duplicate version of unchanged content.
    start_daw(&data);
    let again = json(data.join("DAW/library.json"));
    assert_eq!(again["currentSongId"], id);
    assert_eq!(again["songs"].as_array().unwrap().len(), 1);
    assert_eq!(json(data.join(format!("DAW/versions/{id}/index.json")))["versions"].as_array().unwrap().len(), 1);
    let leftovers: Vec<_> = fs::read_dir(data.join("DAW/songs")).unwrap().flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with('.')).collect();
    assert!(leftovers.is_empty(), "no temporary files left behind: {leftovers:?}");
    let _ = fs::remove_dir_all(&data);
}

#[test]
fn a_fresh_data_folder_starts_the_demo_song() {
    let data = std::env::temp_dir().join(format!("entropy-daw-fresh-{}", std::process::id()));
    let _ = fs::remove_dir_all(&data);
    start_daw(&data);
    let library = json(data.join("DAW/library.json"));
    assert_eq!(library["songs"][0]["name"], "Demo song", "{library:#}");
    assert_eq!(daw_saved::open_song(&data)["bpm"], 96);
    assert!(!data.join("DAW.json").exists(), "the old single file is no longer written");
    let _ = fs::remove_dir_all(&data);
}
