//! Live tier for the Analyzer toggle and the Music Video window: launches the real compiled DAW
//! (`example daw`) against a clean data folder and lets the in-engine driver play
//! `tests/features/daw_visualizer_live.feature` into it.
//!
//! Asserted: the Analyzer really leaves the screen and comes back; every visualizer style draws a
//! different, populated preview while the song plays; and the export writes a playable MP4 - an
//! H.264 track at the chosen size and an AAC track that decodes back to the song's audio - through
//! the same save path a person would pick (answered here by ENTROPY_MUSIC_VIDEO_OUTPUT).

use std::{collections::HashSet, fs, path::Path, process::Command};

fn run_daw(root: &Path, data: &Path, video: &Path) -> serde_json::Value {
    let result_path = root.join("result-visualizer.json");
    let _ = fs::remove_file(&result_path);
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("daw")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_DATA", data)
        .env("ENTROPY_DAW_BDD_FEATURE", "visualizer")
        .env("ENTROPY_MUSIC_VIDEO_OUTPUT", video)
        .spawn()
        .expect("launch the DAW");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > std::time::Duration::from_secs(300) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the DAW visualizer run timed out before the engine finished its feature");
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

/// Pixels that differ noticeably between two same-sized captures.
fn changed_pixels(a: &image::RgbaImage, b: &image::RgbaImage) -> usize {
    a.pixels().zip(b.pixels()).filter(|(p, q)| (0..3).any(|c| (p[c] as i32 - q[c] as i32).abs() > 24)).count()
}

#[test]
fn daw_visualizer_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("daw-visualizer-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let video = root.join("starter-song-music-video.mp4");

    let result = run_daw(&root, &data, &video);
    assert_eq!(result["status"], "passed", "{result:#}");

    let artifacts: Vec<String> = result["artifacts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(artifacts.len(), 11, "{artifacts:#?}");
    let shots: Vec<image::RgbaImage> = artifacts.iter().map(|p| load(p)).collect();
    let mut hashes = HashSet::new();
    for (i, (path, image)) in artifacts.iter().zip(&shots).enumerate() {
        let colours: HashSet<[u8; 4]> = image.pixels().map(|p| p.0).collect();
        println!("  {}: {}x{}, {} colours", Path::new(path).file_name().unwrap().to_string_lossy(), image.width(), image.height(), colours.len());
        assert!(image.width() >= 1000 && image.height() >= 600, "{path} is only {}x{}", image.width(), image.height());
        assert!(colours.len() > 400, "{path} looks blank: {} colours", colours.len());
        // Showing the Analyzer again (capture 3) is meant to restore capture 1 exactly.
        if i != 2 {
            assert!(hashes.insert(image.as_raw().clone()), "{path} is pixel-identical to an earlier capture");
        }
    }

    // ---- The Analyzer leaves and comes back ----
    // It sits bottom-right; hiding it changes a window-sized patch of the screen there (and the
    // toggle's own label), and showing it again puts back (nearly) what was there before.
    let (shown, hidden, back) = (&shots[0], &shots[1], &shots[2]);
    let gone = changed_pixels(shown, hidden);
    let returned = changed_pixels(shown, back);
    let (w, h) = shown.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for (x, y, p) in shown.enumerate_pixels() {
        let q = hidden.get_pixel(x, y);
        // Below the transport bar, where the toggle's own label changes too.
        if y > 100 && (0..3).any(|c| (p[c] as i32 - q[c] as i32).abs() > 8) {
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
        }
    }
    println!("  analyzer hidden: {gone} pixels changed, below the toolbar within ({x0},{y0})-({x1},{y1}); shown again: {returned} pixels differ from the first capture");
    assert!(gone > 5_000, "hiding the analyzer changed only {gone} pixels");
    assert!(x0 > w / 2 && y0 > h / 2, "the region that changed ({x0},{y0})-({x1},{y1}) isn't the bottom-right Analyzer");
    assert!(x1 - x0 > 500 && y1 - y0 > 250, "the region that changed ({x0},{y0})-({x1},{y1}) is smaller than the Analyzer window");
    assert!(returned < gone / 3, "showing the analyzer again didn't restore it ({returned} vs {gone} changed pixels)");

    // ---- Each style draws its own picture ----
    for i in 3..9 {
        for j in (i + 1)..9 {
            let d = changed_pixels(&shots[i], &shots[j]);
            assert!(d > 5_000, "captures {} and {} are nearly the same ({d} pixels differ): a style didn't change the preview", i + 1, j + 1);
        }
    }

    // ---- The export: a real MP4 with video at the chosen size and the song's audio ----
    let file = fs::File::open(&video).unwrap_or_else(|e| panic!("the export didn't write {}: {e}", video.display()));
    let size = file.metadata().unwrap().len();
    let reader = mp4::Mp4Reader::read_header(std::io::BufReader::new(file), size).expect("a readable MP4");
    let tracks: Vec<_> = reader.tracks().values().collect();
    assert_eq!(tracks.len(), 2, "video and audio tracks");
    let v = tracks.iter().find(|t| t.track_type().unwrap() == mp4::TrackType::Video).expect("a video track");
    let a = tracks.iter().find(|t| t.track_type().unwrap() == mp4::TrackType::Audio).expect("an audio track");
    let seconds = v.sample_count() as f64 / 30.0;
    println!(
        "  exported {}: {} bytes, {}x{} video, {} frames ({seconds:.1} s at 30 fps), {} AAC frames at {} Hz",
        video.display(), size, v.width(), v.height(), v.sample_count(), a.sample_count(), a.sample_freq_index().unwrap().freq()
    );
    assert_eq!((v.width(), v.height()), (854, 480), "the Small size was chosen");
    // Four bars at 96 BPM is 10 s; the bounce adds the effects' tail.
    assert!((9.5..16.0).contains(&seconds), "the video lasts {seconds} s, not the 4-bar song");
    let audio_seconds = a.sample_count() as f64 * 1024.0 / a.sample_freq_index().unwrap().freq() as f64;
    assert!((audio_seconds - seconds).abs() < 0.3, "audio ({audio_seconds:.2} s) and video ({seconds:.2} s) lengths differ");

    #[cfg(not(target_os = "windows"))]
    {
        let mut decoder = entropy_engine::openh264_codec::Mp4AudioDecoder::open(&video).expect("the AAC track opens");
        let mut peak = 0.0f32;
        let mut samples = 0usize;
        while let Some(chunk) = decoder.next_chunk().unwrap() {
            samples += chunk.len();
            peak = chunk.iter().fold(peak, |m, s| m.max(s.abs()));
        }
        println!("  decoded {samples} audio samples, peak {:.1} dBFS", 20.0 * peak.max(1e-6).log10());
        assert!(peak > 0.05, "the exported audio is silent (peak {peak})");

        let mut decoder = entropy_engine::openh264_codec::Mp4VideoDecoder::open(&video).expect("the H.264 track opens");
        let info = decoder.info();
        assert_eq!((info.width, info.height), (854, 480));
        let mut rgba = Vec::new();
        assert!(decoder.next_frame(&mut rgba).expect("decodes").is_some(), "no first frame");
        let lit = rgba.chunks_exact(4).filter(|p| p[0] > 60 || p[1] > 60 || p[2] > 60).count();
        assert!(lit > 1000, "the first decoded frame is empty ({lit} lit pixels)");
    }

    println!("DAW visualizer live BDD passed; artifacts: {}", root.display());
}
