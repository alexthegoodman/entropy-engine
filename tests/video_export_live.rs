//! Live Video Export BDD: runs the compiled video export demo, clicks Export, and then checks the
//! MP4 it wrote - on non-Windows by decoding it back through the OpenH264 path the media player uses.
use std::process::Command;

#[test]
fn video_export_live() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("export-bdd-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let result_path = root.join("result.json");
    let output = std::path::Path::new("public/video_export_demo.mp4");
    let _ = std::fs::remove_file(output);

    let example = std::env::var_os("CARGO_BIN_EXE_example").expect("Cargo must provide the example binary");
    let status = Command::new(example)
        .arg("video-export-demo")
        .env("ENTROPY_MEDIA_BDD_RESULT", &result_path)
        .env("ENTROPY_MEDIA_BDD_FEATURE", "export")
        .status()
        .expect("launch the real video export demo");
    assert!(status.success(), "video export demo exited with {status}");
    let result: serde_json::Value = serde_json::from_slice(&std::fs::read(&result_path).expect("live result JSON")).unwrap();
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts = result["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 3, "{result:#}");
    for artifact in artifacts {
        assert!(std::path::Path::new(artifact.as_str().unwrap()).is_file());
    }
    assert!(std::fs::metadata(output).map(|m| m.len() > 0).unwrap_or(false), "no MP4 written to {}", output.display());

    #[cfg(not(target_os = "windows"))]
    check_exported_clip(output);
    println!("Video export live BDD passed with {} screenshots in {}", artifacts.len(), root.display());
}

/// 90 frames at 30 fps of the window-sized scene, with a lit cube on screen and the camera moving.
#[cfg(not(target_os = "windows"))]
fn check_exported_clip(path: &std::path::Path) {
    use entropy_engine::openh264_codec::Mp4VideoDecoder;

    let mut decoder = Mp4VideoDecoder::open(path).expect("exported MP4 opens");
    let info = decoder.info();
    assert_eq!(info.duration_ms, 3000, "{info:?}");
    assert!((info.frame_rate - 30.0).abs() < 0.01, "{info:?}");
    assert!(info.width >= 320 && info.height >= 240, "{info:?}");

    let mut rgba = Vec::new();
    let mut frames = Vec::new();
    while let Some(_pts) = decoder.next_frame(&mut rgba).unwrap() {
        frames.push(rgba.clone());
    }
    assert_eq!(frames.len(), 90);

    let (w, h) = (info.width as usize, info.height as usize);
    let pixel = |frame: &[u8], x: usize, y: usize| {
        let i = (y * w + x) * 4;
        [frame[i], frame[i + 1], frame[i + 2]]
    };
    // The orange cube sits at the origin the camera orbits around, i.e. the middle of the frame.
    let [r, g, b] = pixel(&frames[0], w / 2, h / 2);
    assert!(r > g && g > b && r > 80, "expected the orange cube at the center, got {:?}", [r, g, b]);
    let differs = |a: &[u8], b: &[u8]| a.iter().zip(b).filter(|(x, y)| x.abs_diff(**y) > 24).count();
    assert!(differs(&frames[0], &frames[89]) > w * h / 200, "the orbiting camera should change the picture");
}
