use std::{fs, process::Command, time::{Duration, Instant}};

#[test]
fn special_bundle_windows_follow_taskbar_selection() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("special-bundle-windows-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("special-bundle")
        .env("ENTROPY_DAW_BDD_RESULT", &result_path)
        .env("ENTROPY_DAW_BDD_FEATURE", "special-bundle")
        .env("ENTROPY_BUNDLE_BDD_DATA", &data)
        .spawn()
        .expect("launch special bundle");
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > Duration::from_secs(180) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("special bundle BDD timed out");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(status.success(), "special bundle exited with {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).expect("BDD result")).unwrap();
    assert_eq!(result["status"], "passed", "{result:#}");
    for artifact in result["artifacts"].as_array().unwrap() {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }

    let center_luma = |name: &str| -> f64 {
        let path = root.join(format!("{name}.png"));
        let image = image::open(&path).expect("decode screenshot").to_rgb8();
        let (width, height) = image.dimensions();
        let (mut sum, mut count) = (0u64, 0u64);
        for y in height / 4..height * 2 / 3 {
            for x in width * 7 / 20..width * 13 / 20 {
                let pixel = image.get_pixel(x, y);
                sum += (u64::from(pixel[0]) + u64::from(pixel[1]) + u64::from(pixel[2])) / 3;
                count += 1;
            }
        }
        sum as f64 / count as f64
    };
    assert!(center_luma("02-mesha") > 60.0, "Mesha scene did not render on selection");
    assert!(center_luma("05-mesha-restored") > 60.0, "Mesha scene did not render after returning");
    assert!(center_luma("03-cc-manager") < 40.0, "Mesha scene leaked into CC Manager");
}
