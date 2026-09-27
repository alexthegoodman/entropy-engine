//! Live tier for the Reverb & EQ window and the Instruments menu: launches the real compiled DAW
//! (`example daw`) against a clean data folder and lets the in-engine driver play
//! `tests/features/daw_space_live.feature` into it.
//!
//! Asserted: the window really opens over the arrangement and is populated; a reverb preset and two
//! EQ bands visibly reshape it; the live view and the AI tool each draw a different picture; the
//! reverb and EQ are saved with the song; and a window opens from the Instruments menu.

use std::{collections::HashSet, fs, path::Path, process::Command};

#[path = "common/daw_saved.rs"]
mod daw_saved;

fn run_daw(root: &Path, data: &Path) -> serde_json::Value {
    let result_path = root.join("result-space.json");
    let _ = fs::remove_file(&result_path);
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", data)
        .env("ENTROPY_DAW_BDD_FEATURE", "space")
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
            panic!("the DAW space run timed out before the engine finished its feature");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "the DAW exited with {status}");
    serde_json::from_slice(&fs::read(&result_path).expect("result json")).expect("valid result json")
}

fn load(path: &str) -> image::RgbaImage {
    let bytes = fs::read(path).expect("screenshot exists");
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{path} is not a PNG");
    image::load_from_memory(&bytes).expect("decodable PNG").to_rgba8()
}

fn changed_pixels(a: &image::RgbaImage, b: &image::RgbaImage) -> usize {
    a.pixels().zip(b.pixels()).filter(|(p, q)| (0..3).any(|c| (p[c] as i32 - q[c] as i32).abs() > 24)).count()
}

#[test]
fn daw_space_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-space-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();

    let result = run_daw(&root, &data);
    assert_eq!(result["status"], "passed", "{result:#}");

    let artifacts: Vec<String> = result["artifacts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(artifacts.len(), 6, "{artifacts:#?}");
    let shots: Vec<image::RgbaImage> = artifacts.iter().map(|p| load(p)).collect();
    let mut hashes = HashSet::new();
    for (path, image) in artifacts.iter().zip(&shots) {
        let colours: HashSet<[u8; 4]> = image.pixels().map(|p| p.0).collect();
        println!("  {}: {}x{}, {} colours", Path::new(path).file_name().unwrap().to_string_lossy(), image.width(), image.height(), colours.len());
        assert!(image.width() >= 1000 && image.height() >= 600, "{path} is only {}x{}", image.width(), image.height());
        assert!(colours.len() > 400, "{path} looks blank: {} colours", colours.len());
        assert!(hashes.insert(image.as_raw().clone()), "{path} is pixel-identical to an earlier capture");
    }

    // Opening the window covers most of the arrangement with the room and the EQ.
    let opened = changed_pixels(&shots[0], &shots[1]);
    assert!(opened > 100_000, "opening Reverb & EQ changed only {opened} pixels");

    // Every step changed the picture substantially.
    for (a, b) in [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5)] {
        let d = changed_pixels(&shots[a], &shots[b]);
        assert!(d > 4_000, "captures {} and {} are nearly the same ({d} pixels differ)", a + 1, b + 1);
    }

    // The reverb and EQ the tool set are saved with the song.
    let project = daw_saved::open_song(&data);
    let lead = project["tracks"].as_array().unwrap().iter().find(|t| t["id"] == "trk-lead").expect("the lead track is saved");
    assert_eq!(lead["voice"]["reverbRoomSize"], 30.0, "the cathedral's room: {lead:#}");
    let shelf = lead["eq"]["bands"][4]["gain"].as_f64().unwrap_or(0.0);
    assert!(shelf < -5.0, "the darker tail's high shelf was not saved: {:#}", lead["eq"]);

    println!("DAW Reverb & EQ live BDD passed; artifacts: {}", root.display());
}
