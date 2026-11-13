//! The Material Lab in the real window: tests/features/material_lab_live.feature played through
//! startup.rs's Gherkin driver (ENTROPY_MATERIALLAB_BDD_RESULT). Captures land beside the result
//! under test-artifacts/. On a headless Linux box run it under `xvfb-run -a`.
use std::{fs, process::Command};

#[test]
fn material_lab_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("material-lab-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let result_path = root.join("result.json");
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_example"));
    cmd.arg("material-lab").env("ENTROPY_MATERIALLAB_BDD_RESULT", &result_path);
    // ENTROPY_MATERIALLAB_BDD_FEATURE (a path) plays another feature file without rebuilding.
    let mut child = cmd.spawn().expect("launch the Material Lab");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(600) {
            let _ = child.kill(); let _ = child.wait();
            panic!("Material Lab live BDD timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Material Lab failed: {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts = result["artifacts"].as_array().unwrap();
    assert!(!artifacts.is_empty(), "no captures");
    for artifact in artifacts {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }

    // Score each tracer against the slow reference, pose by pose: mean absolute error per channel
    // (0-255) over the frame. The refined tracer must be closer to the reference than the classic
    // one in every pose, and the frames must not be blank.
    let find = |name: &str| -> image::RgbImage {
        let path = artifacts.iter().map(|a| a.as_str().unwrap()).find(|a| a.ends_with(&format!("{name}.png"))).unwrap_or_else(|| panic!("no {name} capture"));
        image::open(path).unwrap().to_rgb8()
    };
    let error = |a: &image::RgbImage, b: &image::RgbImage| -> f64 {
        assert_eq!(a.dimensions(), b.dimensions());
        let sum: u64 = a.as_raw().iter().zip(b.as_raw()).map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs() as u64).sum();
        sum as f64 / a.as_raw().len() as f64
    };
    let mut table = String::from("pose      classic  refined  (mean abs error vs ultra, 0-255)\n");
    for pose in ["straight", "slant", "grazing"] {
        let reference = find(&format!("{pose}-ultra"));
        let mean: f64 = reference.as_raw().iter().map(|v| *v as f64).sum::<f64>() / reference.as_raw().len() as f64;
        assert!(mean > 20.0, "{pose}: the reference frame is nearly black ({mean:.1})");
        let (classic, refined) = (error(&find(&format!("{pose}-classic")), &reference), error(&find(&format!("{pose}-refined")), &reference));
        table += &format!("{pose:<9} {classic:>7.2}  {refined:>7.2}\n");
        assert!(refined < classic, "{pose}: refined ({refined:.2}) should be closer to the reference than classic ({classic:.2})");
    }
    // Every material at the slant: the same ordering, and a bounded error.
    table += "\nmaterial            classic  refined\n";
    for mat in ["fieldstone", "brick-red", "sandstone-blocks", "concrete", "granite", "stucco", "roof-clay", "roof-cedar", "metal-corrugated", "wood-oak", "asphalt", "soil", "snow"] {
        let reference = find(&format!("mat-{mat}-ultra"));
        let mean: f64 = reference.as_raw().iter().map(|v| *v as f64).sum::<f64>() / reference.as_raw().len() as f64;
        assert!(mean > 15.0, "{mat}: the reference frame is nearly black ({mean:.1})");
        let (classic, refined) = (error(&find(&format!("mat-{mat}-classic")), &reference), error(&find(&format!("mat-{mat}-refined")), &reference));
        table += &format!("{mat:<20}{classic:>7.2}  {refined:>7.2}\n");
        assert!(refined <= classic + 0.05, "{mat}: refined ({refined:.2}) is further from the reference than classic ({classic:.2})");
    }
    // Depth written: the pole's edge follows the relief, so the two frames differ near it.
    let (flat, deep) = (find("pole-flat"), find("pole-depth"));
    let differing = flat.pixels().zip(deep.pixels()).filter(|(a, b)| a.0.iter().zip(b.0.iter()).any(|(x, y)| (*x as i32 - *y as i32).abs() > 40)).count();
    table += &format!("\npole: {differing} pixels change when depth is written\n");
    assert!(differing > 2000, "writing depth should change the pole's intersection with the wall ({differing} pixels)");
    println!("{table}");
    fs::write(root.join("scores.txt"), &table).unwrap();
}
