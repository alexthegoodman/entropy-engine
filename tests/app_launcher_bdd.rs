//! App launcher BDD entrypoint, in the two tiers browser_bdd.rs established.
//!
//! The fast tier below is a pure model of the launcher's install list, its two-post feed panel
//! and the launch allow-list - no window, no engine. After it passes, the live tier starts the
//! real `app-launcher` executable in the engine's scripted test mode and then reads the captured
//! frames back: the point of that tier is proving the frosted panels sample the real blurred
//! scene rather than a flat fill, and that `System.launchExample` really created a process.

use cucumber::{given, then, when, World as _};
use std::process::Command;

#[derive(Debug, Default, cucumber::World)]
struct LauncherWorld {
    installed: Vec<String>,
    feed_xml: String,
    shown: Vec<String>,
    launch_refused: Option<bool>,
}

/// The launcher's own catalog is in TypeScript; the fast tier only needs enough of it to say what
/// Discover would offer.
const CATALOG: &[&str] = &["daw", "canvas-surface-demo", "cc-manager", "stylus-drawing", "theme-gallery"];

/// The same two fields `parseFeed` reads in app_launcher_addon.ts, capped the same way.
fn feed_titles(xml: &str, limit: usize) -> Vec<String> {
    xml.split("<item>")
        .skip(1)
        .filter_map(|block| block.split_once("</item>").map(|(inner, _)| inner))
        .filter_map(|inner| inner.split_once("<title>").and_then(|(_, rest)| rest.split_once("</title>")).map(|(title, _)| title.trim().to_string()))
        .take(limit)
        .collect()
}

#[given(expr = "the launcher has installed {string}")]
fn has_installed(world: &mut LauncherWorld, name: String) {
    world.installed = vec![name];
}

#[given(expr = "the feed has {int} posts")]
fn feed_has_posts(world: &mut LauncherWorld, count: usize) {
    let items: String = (1..=count)
        .map(|index| format!("<item><title>Post {index}</title><link>https://example.test/{index}</link><pubDate>Mon, 21 Sep 2026 00:00:00 GMT</pubDate></item>"))
        .collect();
    world.feed_xml = format!("<rss><channel><title>Indie Machine</title>{items}</channel></rss>");
}

#[when(expr = "the launcher installs {string}")]
fn installs(world: &mut LauncherWorld, name: String) {
    if !world.installed.contains(&name) {
        world.installed.push(name);
    }
}

#[when(expr = "the launcher removes {string}")]
fn removes(world: &mut LauncherWorld, name: String) {
    world.installed.retain(|installed| *installed != name);
}

#[when("the launcher reads the feed")]
fn reads_the_feed(world: &mut LauncherWorld) {
    world.shown = feed_titles(&world.feed_xml, 2);
}

#[when(expr = "the launcher tries to launch {string}")]
fn tries_to_launch(world: &mut LauncherWorld, name: String) {
    world.launch_refused = Some(!entropy_engine::LAUNCHABLE_EXAMPLES.contains(&name.as_str()));
}

#[then(expr = "{string} is installed")]
fn is_installed(world: &mut LauncherWorld, name: String) {
    assert!(world.installed.contains(&name), "{:?}", world.installed);
}

#[then(expr = "{string} is not installed")]
fn is_not_installed(world: &mut LauncherWorld, name: String) {
    assert!(!world.installed.contains(&name), "{:?}", world.installed);
}

#[then(expr = "the home grid has {int} apps")]
fn home_grid_has(world: &mut LauncherWorld, count: usize) {
    assert_eq!(world.installed.len(), count, "{:?}", world.installed);
}

#[then(expr = "{string} is offered in Discover")]
fn offered_in_discover(world: &mut LauncherWorld, name: String) {
    assert!(CATALOG.contains(&name.as_str()) && !world.installed.contains(&name));
}

#[then(expr = "{string} is not offered in Discover")]
fn not_offered_in_discover(world: &mut LauncherWorld, name: String) {
    assert!(world.installed.contains(&name));
}

#[then(expr = "the feed panel shows {int} posts")]
fn feed_panel_shows(world: &mut LauncherWorld, count: usize) {
    assert_eq!(world.shown.len(), count, "{:?}", world.shown);
}

#[then(expr = "the first feed post is {string}")]
fn first_feed_post_is(world: &mut LauncherWorld, title: String) {
    assert_eq!(world.shown.first().map(String::as_str), Some(title.as_str()));
}

#[then("the launch is refused")]
fn launch_is_refused(world: &mut LauncherWorld) {
    assert_eq!(world.launch_refused, Some(true));
}

#[then("the launch is allowed")]
fn launch_is_allowed(world: &mut LauncherWorld) {
    assert_eq!(world.launch_refused, Some(false));
}

/// Mean and spread of one rectangle of a capture, in physical pixels.
fn region_stats(path: &str, rect: (u32, u32, u32, u32)) -> (f64, f64) {
    let image = image::open(path).expect("capture decodes").to_luma8();
    let (width, height) = image.dimensions();
    let (x0, y0, x1, y1) = rect;
    assert!(x1 <= width && y1 <= height, "{rect:?} is outside the {width}x{height} capture");
    let mut values = Vec::new();
    for y in y0..y1 {
        for x in x0..x1 {
            values.push(image.get_pixel(x, y).0[0] as f64);
        }
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
    (mean, variance.sqrt())
}

/// Mean absolute per-pixel difference over one rectangle of two same-sized captures.
fn region_difference(a: &str, b: &str, rect: (u32, u32, u32, u32)) -> f64 {
    let (a, b) = (image::open(a).unwrap().to_luma8(), image::open(b).unwrap().to_luma8());
    assert_eq!(a.dimensions(), b.dimensions());
    let (x0, y0, x1, y1) = rect;
    let (mut sum, mut count) = (0u64, 0u64);
    for y in y0..y1 {
        for x in x0..x1 {
            sum += (a.get_pixel(x, y).0[0] as i32 - b.get_pixel(x, y).0[0] as i32).unsigned_abs() as u64;
            count += 1;
        }
    }
    sum as f64 / count.max(1) as f64
}

#[tokio::main]
async fn main() {
    LauncherWorld::run("tests/features/app_launcher_loop.feature").await;

    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("app-launcher-bdd-{}", std::process::id()));
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let _ = std::fs::remove_file(&result_path);

    let example = std::env::var_os("CARGO_BIN_EXE_example").expect("Cargo must provide the real example binary");
    let status = Command::new(example)
        .arg("app-launcher")
        .env("ENTROPY_LAUNCHER_BDD_RESULT", &result_path)
        .env("ENTROPY_LAUNCHER_BDD_DATA", &data)
        .status()
        .expect("launch the real Entropy app launcher");
    assert!(status.success(), "the live app launcher must exit cleanly: {status}");

    let result: serde_json::Value = serde_json::from_slice(&std::fs::read(&result_path).expect("live result JSON")).expect("valid result JSON");
    assert_eq!(result["status"], "passed", "{result:#}");

    // System.launchExample really created a process (the last live scenario clicks "Open" on
    // theme-gallery), and it keeps running as its own window after this test's own driven window
    // has already closed. Kill it now, before any assertion below can panic: every assertion
    // after this point used to run first, so a failure among them (as happened the first time
    // this test was run for real - see the glass-panel assertion below) left that real window
    // stranded on the desktop with nothing left in this process to close it.
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("App Launcher.json")).expect("persisted launcher state")).unwrap();
    let launched_pid = saved["lastLaunch"]["pid"].as_u64().map(|pid| pid as u32);
    let killed = launched_pid.map(|pid| Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output().expect("taskkill runs"));

    let artifacts: Vec<String> = result["artifacts"].as_array().expect("artifact array").iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(artifacts.len(), 5, "{artifacts:?}");
    for artifact in &artifacts {
        assert!(std::path::Path::new(artifact).is_file(), "missing artifact {artifact}");
    }
    let shot = |name: &str| artifacts.iter().find(|a| a.ends_with(&format!("{name}.png"))).unwrap_or_else(|| panic!("no capture {name}")).clone();

    // Captures are physical pixels; the windows were placed in points.
    let scale = result["actions"].as_array().unwrap().iter()
        .find_map(|action| action["scaleFactor"].as_f64())
        .expect("the driver records the scale factor with every capture");
    // The bottom of the launcher's "Indie Machine" panel (placed at 610,32, sized 290x260): far
    // enough below its title, two posts and separator that nothing but the panel's own
    // background is there.
    let px = |x: f64, y: f64| ((x * scale).round() as u32, (y * scale).round() as u32);
    let (x0, y0) = px(620.0, 234.0);
    let (x1, y1) = px(890.0, 284.0);
    let rect = (x0, y0, x1, y1);

    let (mean, spread) = region_stats(&shot("launcher-01-home"), rect);
    let drift = region_difference(&shot("launcher-01-home"), &shot("launcher-02-drifted"), rect);
    println!("\n[Live app launcher BDD]");
    println!("  glass panel body: mean luma {mean:.1}, standard deviation {spread:.2}, change after the camera drifted {drift:.2}");
    // Drift, not spread, is the reliable signal here: a flat theme fill never changes when the
    // camera moves (measured exactly 0.00 against the placeholder-pipeline bug this scenario
    // caught), while any real blurred content does, even where this specific sampled patch
    // happens to sit over a smooth part of the backdrop's own gradient and so has only modest
    // local contrast (measured 0.89 against this test's own >1.5 spread bar, which is why that
    // bar was dropped - a scene-position-dependent number, unlike drift, isn't a good invariant).
    assert!(spread > 0.3, "the glass panel's body is perfectly flat ({spread:.2}) - it is not sampling the blur target at all");
    assert!(drift > 0.3, "the glass panel did not change when the scene behind it moved ({drift:.2})");

    // The launcher persisted the pid it got back from launchExample, and the taskkill run above
    // (before any of the assertions above this point could panic and strand it) proves that pid
    // was a real, live process.
    assert_eq!(saved["installed"].as_array().unwrap().iter().filter(|n| *n == "stylus-drawing").count(), 1, "Install must persist: {saved:#}");
    assert_eq!(saved["lastLaunch"]["name"], "theme-gallery", "{saved:#}");
    let pid = launched_pid.expect("a pid");
    assert!(pid > 0);
    let killed = killed.expect("a pid was present, so taskkill must have run");
    assert!(killed.status.success(), "pid {pid} was not a live process: {}", String::from_utf8_lossy(&killed.stderr));

    println!("  ✔ {} composed PNG checkpoints written", artifacts.len());
    println!("  ✔ launchExample started theme-gallery as pid {pid}, verified alive and killed");
    println!("  ✔ artifacts: {}", root.display());
    println!("[Summary] 1 live-ui feature (passed)");
}
