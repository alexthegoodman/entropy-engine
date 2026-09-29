//! QuadPlanet in the real window, driven by tests/features/quadplanet_live.feature through
//! startup.rs's Gherkin driver: real key presses walk the astronaut to the ship and fly it, the
//! addon's MCP tools start the autopilot and report state, and the composed frame is captured.
//! Checks what the app itself reported (mode, planet, altitude, quadtree depth) and what reached
//! the screen (a blue day sky over green Verdant, black space between planets, red Ember, the
//! LOD view's colors). On a headless Linux box run it under `xvfb-run -a`. The pure-TypeScript
//! tier is examples/studio-bundle/tests/quadplanet.test.ts.
use std::{fs, process::Command};

type Rgb = [u8; 3];

/// Share of pixels in the region (fractions of the frame) passing `test`.
fn share(path: &str, region: (f32, f32, f32, f32), test: &dyn Fn(Rgb) -> bool) -> f64 {
    let img = image::open(path).unwrap_or_else(|e| panic!("{path}: {e}")).to_rgb8();
    let (w, h) = img.dimensions();
    let (x0, y0) = ((region.0 * w as f32) as u32, (region.1 * h as f32) as u32);
    let (x1, y1) = ((region.2 * w as f32) as u32, (region.3 * h as f32) as u32);
    let (mut hit, mut total) = (0u64, 0u64);
    for y in (y0..y1).step_by(2) {
        for x in (x0..x1).step_by(2) {
            total += 1;
            if test(img.get_pixel(x, y).0) { hit += 1; }
        }
    }
    hit as f64 / total as f64
}

fn green(p: Rgb) -> bool { p[1] as i32 > p[0] as i32 + 15 && p[1] as i32 > p[2] as i32 + 15 }
fn sky_blue(p: Rgb) -> bool { p[2] as i32 > p[0] as i32 + 25 && p[2] as i32 > p[1] as i32 + 5 }
fn orange(p: Rgb) -> bool { p[0] as i32 > p[1] as i32 + 30 && p[1] as i32 > p[2] as i32 + 10 }
fn dark(p: Rgb) -> bool { p.iter().all(|&c| c < 40) }

/// The HUD card sits top-left; measure the scene to its right.
const SCENE: (f32, f32, f32, f32) = (0.32, 0.0, 1.0, 1.0);

#[test]
fn quadplanet_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("quadplanet-bdd-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("quadplanet")
        .env("ENTROPY_QUADPLANET_BDD_RESULT", &result_path)
        .spawn()
        .expect("launch QuadPlanet");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        // Kilometer-scale planets are ~2M triangles of textured terrain: several minutes under
        // a software Vulkan driver (the in-app budget is 600 s, startup.rs).
        if started.elapsed() > std::time::Duration::from_secs(660) {
            let _ = child.kill(); let _ = child.wait();
            panic!("QuadPlanet live BDD timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "QuadPlanet failed: {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts: Vec<String> = result["artifacts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    for artifact in &artifacts {
        let bytes = fs::read(artifact).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    let find = |name: &str| artifacts.iter().find(|a| a.ends_with(&format!("{name}.png"))).unwrap_or_else(|| panic!("no {name} capture")).clone();
    let states: Vec<&serde_json::Value> = result["tools"].as_array().unwrap().iter()
        .filter(|t| t["tool"] == "quadplanet_state").map(|t| &t["result"]).collect();
    assert_eq!(states.len(), 12, "one state reply per checkpoint");
    let f = |v: &serde_json::Value| v.as_f64().unwrap();
    let planet_chunks = |s: &serde_json::Value, name: &str| -> (u64, u64, u64) {
        let p = s["chunks"]["planets"].as_array().unwrap().iter().find(|p| p["name"] == name).unwrap();
        (p["chunks"].as_u64().unwrap(), p["deepestLevel"].as_u64().unwrap(), p["maxLevel"].as_u64().unwrap())
    };

    // Standing on Verdant: on the ground, the ship a short walk away, and the quadtree streamed all
    // the way down to its deepest level around the camera, coarse on the other planets.
    let start = states[0];
    assert_eq!(start["mode"], "walk");
    assert_eq!(start["planet"], "Verdant");
    assert_eq!(start["grounded"], true);
    assert!(f(&start["altitude"]).abs() < 0.1);
    assert!(f(&start["shipDistance"]) > 9.0 && f(&start["shipDistance"]) < 20.0, "{start:#}");
    assert_eq!(start["chunks"]["pending"], 0, "streaming should settle in 120 frames: {start:#}");
    let (verdant_chunks, deepest, max) = planet_chunks(start, "Verdant");
    assert_eq!(deepest, max, "the chunks under your feet are the finest level");
    let (ember_chunks, ember_deepest, _) = planet_chunks(start, "Ember");
    assert!(verdant_chunks > 5 * ember_chunks && ember_deepest <= 2, "far planets stay coarse: {start:#}");

    // Holding W for 40 frames walked 40 x (1/30 s) x 5 m/s along the curved ground to the ship.
    let walked = states[1];
    assert!((f(&walked["walked"]) - 6.66).abs() < 0.1, "{walked:#}");
    assert!(f(&walked["shipDistance"]) < 9.0);
    assert_eq!(walked["grounded"], true);
    assert!(f(&walked["altitude"]).abs() < 0.1);

    // E boards; Space then W lifts off and flies.
    assert_eq!(states[2]["mode"], "ship");
    let flying = states[3];
    assert_eq!(flying["shipLanded"], false);
    assert!(f(&flying["altitude"]) > 20.0, "{flying:#}");
    assert!(f(&flying["speed"]) > 10.0);

    // Mid-flight: out in space between the planets, kilometers up at kilometers per second.
    let cruise = states[4];
    let progress = f(&cruise["autopilot"]["progress"]);
    assert!(progress > 0.2 && progress < 0.8, "{cruise:#}");
    assert_eq!(cruise["autopilot"]["target"], "Ember");
    assert!(f(&cruise["altitude"]) > 20_000.0 && f(&cruise["speed"]) > 5_000.0, "{cruise:#}");

    // Landed on Ember, where the quadtree now goes deepest.
    let landed = states[5];
    assert_eq!(landed["planet"], "Ember");
    assert_eq!(landed["shipLanded"], true);
    assert!(landed["autopilot"].is_null());
    assert!(f(&landed["altitude"]).abs() < 0.1);
    let (_, ember_deepest, ember_max) = planet_chunks(landed, "Ember");
    assert_eq!(ember_deepest, ember_max, "{landed:#}");
    assert!(planet_chunks(landed, "Verdant").1 <= 2, "Verdant is coarse again from Ember");

    // Stepped out and walked on Ember.
    let ember = states[6];
    assert_eq!(ember["mode"], "walk");
    assert_eq!(ember["planet"], "Ember");
    assert_eq!(ember["walker"]["planet"], "Ember");
    assert!(f(&ember["walked"]) > f(&walked["walked"]) + 5.0, "{ember:#}");
    assert_eq!(ember["grounded"], true);
    assert!(ember["visited"].as_array().unwrap().iter().any(|v| v == "ember"));

    // The orbit view with the LOD tint on.
    assert_eq!(states[7]["debugLod"], true);
    // Back to the chase camera; the streamer refines Ember around the walker again.
    assert_eq!(states[8]["mode"], "walk");

    // Walked back, boarded again, and the autopilot crossed to Glacia (from Ember this time).
    assert_eq!(states[9]["mode"], "ship");
    assert_eq!(states[9]["planet"], "Ember");
    let glacia = states[10];
    assert_eq!(glacia["planet"], "Glacia");
    assert_eq!(glacia["shipLanded"], true);
    let (_, glacia_deepest, glacia_max) = planet_chunks(glacia, "Glacia");
    assert_eq!(glacia_deepest, glacia_max, "{glacia:#}");
    let on_ice = states[11];
    assert_eq!(on_ice["mode"], "walk");
    assert_eq!(on_ice["walker"]["planet"], "Glacia");
    assert!(f(&on_ice["walked"]) > f(&states[9]["walked"]) + 5.0, "{on_ice:#}");
    assert!(f(&on_ice["altitude"]).abs() < 0.1);
    for planet in ["verdant", "ember", "glacia"] {
        assert!(on_ice["visited"].as_array().unwrap().iter().any(|v| v == planet), "{on_ice:#}");
    }

    // What reached the screen.
    let verdant = find("01-standing-on-verdant");
    let sky = share(&verdant, (0.35, 0.0, 1.0, 0.2), &sky_blue);
    let grass = share(&verdant, (0.0, 0.72, 1.0, 1.0), &green);
    println!("01 sky-blue top {sky:.3}, green ground {grass:.3}");
    assert!(sky > 0.5, "Verdant's day sky should be blue ({sky:.3})");
    assert!(grass > 0.5, "Verdant's ground should be green ({grass:.3})");

    let space = find("04-between-planets");
    let black = share(&space, SCENE, &dark);
    let red_planet = share(&space, SCENE, &orange);
    println!("04 dark {black:.3}, orange {red_planet:.3}");
    // (Mid-arc, Ember's disc and the ship cover a good part of the rest.)
    assert!(black > 0.25, "between planets much of the frame is black space ({black:.3})");
    // Whether Ember is in frame at this moment depends on where the landing site puts the arc, so
    // the flight itself is checked through the state replies above rather than by its pixels.

    for name in ["05-landed-on-ember", "06-walking-on-ember"] {
        let ground = share(&find(name), (0.0, 0.75, 1.0, 1.0), &orange);
        println!("{name} orange ground {ground:.3}");
        assert!(ground > 0.5, "{name}: Ember's ground should be orange-red ({ground:.3})");
    }

    // The LOD view colors each quadtree level differently.
    let hue_buckets = |path: &str| -> usize {
        let img = image::open(path).unwrap().to_rgb8();
        let (w, h) = img.dimensions();
        let mut buckets = std::collections::HashSet::new();
        for y in (0..h).step_by(8) {
            for x in ((w * 32 / 100)..w).step_by(8) {
                let p = img.get_pixel(x, y).0;
                let (mx, mn) = (*p.iter().max().unwrap() as f32, *p.iter().min().unwrap() as f32);
                if mx < 60.0 || mx - mn < 40.0 { continue; }
                let (r, g, b) = (p[0] as f32, p[1] as f32, p[2] as f32);
                let hue = if mx == r { ((g - b) / (mx - mn)).rem_euclid(6.0) } else if mx == g { (b - r) / (mx - mn) + 2.0 } else { (r - g) / (mx - mn) + 4.0 };
                buckets.insert((hue * 2.0) as i32);
            }
        }
        buckets.len()
    };
    let lod = find("07-ember-quadtree-from-orbit");
    let hues = hue_buckets(&lod);
    println!("07 distinct hue buckets {hues}");
    assert!(hues >= 3, "the LOD view should show several level colors ({hues})");
    // No cracks: the planet fills this frame, so a gap between chunks would show the black space
    // behind it. Chunks of different levels meet here (the colors above).
    let gaps = share(&lod, (0.35, 0.05, 0.97, 0.95), &|p| p.iter().all(|&c| c < 30));
    println!("07 black (crack) pixels {gaps:.5}");
    assert!(gaps < 0.0005, "space showing through the terrain: cracks between chunks ({gaps:.5})");

    // Straight down on the walker with levels colored and chunks outlined in white: the rings of
    // detail tighten around you (several levels, plus the drawn outlines).
    let rings = find("01b-detail-rings-around-you");
    let ring_hues = hue_buckets(&rings);
    let outlines = share(&rings, SCENE, &|p| p.iter().all(|&c| c > 225));
    println!("01b distinct hue buckets {ring_hues}, outline pixels {outlines:.4}");
    assert!(ring_hues >= 3 && outlines > 0.0001,"the overhead LOD view should show several levels and chunk outlines");
    assert!(f(&start["chunks"]["stitched"]) > 20.0, "chunks meeting coarser neighbours are stitched: {start:#}");

    // Glacia's ground is ice and snow: bright and cool.
    for name in ["10-landed-on-glacia", "11-walking-on-glacia"] {
        let ice = share(&find(name), (0.0, 0.75, 1.0, 1.0), &|p| p.iter().all(|&c| c > 150) && p[2] >= p[0]);
        println!("{name} icy ground {ice:.3}");
        assert!(ice > 0.6, "{name}: Glacia's ground should be ice and snow ({ice:.3})");
    }

    let orbit = find("08-verdant-from-orbit");
    let (space_share, ocean, land) = (share(&orbit, SCENE, &dark), share(&orbit, SCENE, &|p| p[2] as i32 > p[0] as i32 + 40 && p[2] as i32 > p[1] as i32), share(&orbit, SCENE, &green));
    println!("08 dark {space_share:.3}, ocean {ocean:.3}, land {land:.3}");
    assert!(space_share > 0.1 && ocean > 0.08 && land > 0.08, "Verdant from orbit: space, oceans and continents");
    println!("QuadPlanet live BDD: {}", root.display());
}
