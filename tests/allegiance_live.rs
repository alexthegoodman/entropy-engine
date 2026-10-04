//! Allegiance in the real window, driven by tests/features/allegiance_live.feature (and
//! allegiance_travel_live.feature) through startup.rs's Gherkin driver: the addon's MCP tools start
//! a campaign in London, run the loading screen, give a speech, talk to a passer-by, open every
//! console tab, fight a squad and win, and the composed frames are captured. Checks what the game
//! reported (modes, crowds, pathing pedestrians, the speech result, the battle, the outcome) and
//! what reached the screen. On a headless Linux box run it under `xvfb-run -a`. The TypeScript
//! tiers are examples/studio-bundle/tests/allegiance_*.test.ts.
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

fn red(p: Rgb) -> bool { p[0] > 150 && (p[1] as i32) < 60 && (p[2] as i32) < 60 }
fn cream(p: Rgb) -> bool { p[0] > 190 && p[1] > 170 && p[2] > 130 && p[0] >= p[2] }
fn dark(p: Rgb) -> bool { p.iter().all(|&c| c < 50) }

/// Runs the game on a feature file and returns (result JSON, artifacts).
fn run(name: &str, feature: Option<&str>) -> (serde_json::Value, Vec<String>, std::path::PathBuf) {
    run_with_data(name, feature, None)
}

fn run_with_data(name: &str, feature: Option<&str>, data: Option<&std::path::Path>) -> (serde_json::Value, Vec<String>, std::path::PathBuf) {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("allegiance-{name}-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let result_path = root.join("result.json");
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_example"));
    cmd.arg("allegiance")
        .env("ENTROPY_ALLEGIANCE_BDD_RESULT", &result_path)
        .env("ENTROPY_ALLEGIANCE_BDD_DATA", data.map(std::path::Path::to_path_buf).unwrap_or_else(|| root.join("data")))
        .env("ENTROPY_BDD_BUDGET_SECS", "1500");
    if let Some(f) = feature { cmd.env("ENTROPY_ALLEGIANCE_BDD_FEATURE", f); }
    let mut child = cmd.spawn().expect("launch Allegiance");
    let started = std::time::Instant::now();
    let mut completed = None;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        // Completed gameplay must also tear down normally; a forced close is a test failure.
        if result_path.exists() {
            let finished = completed.get_or_insert_with(std::time::Instant::now);
            if finished.elapsed() > std::time::Duration::from_secs(10) {
                child.kill().expect("stop hung Allegiance shutdown");
                child.wait().expect("reap hung Allegiance shutdown");
                panic!("Allegiance completed its feature but failed to close within 10 seconds");
            }
        }
        if started.elapsed() > std::time::Duration::from_secs(1600) {
            let _ = child.kill(); let _ = child.wait();
            panic!("Allegiance live BDD timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Allegiance failed: {status}");
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts: Vec<String> = result["artifacts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    for artifact in &artifacts {
        let bytes = fs::read(artifact).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    (result, artifacts, root)
}

fn states(result: &serde_json::Value) -> Vec<serde_json::Value> {
    result["tools"].as_array().unwrap().iter().filter(|t| t["tool"] == "allegiance_state").map(|t| t["result"].clone()).collect()
}

fn find(artifacts: &[String], name: &str) -> String {
    artifacts.iter().find(|a| a.ends_with(&format!("{name}.png"))).unwrap_or_else(|| panic!("no {name} capture")).clone()
}

fn f(v: &serde_json::Value) -> f64 { v.as_f64().unwrap_or_else(|| panic!("not a number: {v}")) }

#[test]
fn allegiance_people_live_feature() {
    let (result, artifacts, root) = run("people", Some("tests/features/allegiance_people_live.feature"));
    let s = states(&result);
    assert_eq!(s.len(), 4);
    assert_eq!(s[0]["mode"], "play");
    assert_eq!(s[0]["people"]["generated"], 2);
    assert!(s[1]["people"]["lod0"].as_u64().unwrap() >= 2, "player and nearby Mesha human: {}", s[1]["people"]);
    assert!(s[0]["people"]["lod1"].as_u64().unwrap() + s[0]["people"]["lod2"].as_u64().unwrap() > 0,
        "distant people use simpler meshes: {}", s[0]["people"]);
    assert_eq!(s[3]["people"]["generated"], s[0]["people"]["generated"], "returning does not regenerate bodies");
    assert!(s[3]["people"]["cache"]["hits"].as_u64().unwrap() > s[0]["people"]["cache"]["hits"].as_u64().unwrap());
    assert_eq!(artifacts.len(), 3);
    let (warm, _, _) = run_with_data("people-warm", Some("tests/features/allegiance_people_live.feature"), Some(&root.join("data")));
    for state in states(&warm) {
        assert_eq!(state["people"]["generated"], 0, "a new process reads the people from disk");
        assert!(state["people"]["cache"]["hits"].as_u64().unwrap() > 0);
    }
}

#[test]
fn allegiance_live_feature() {
    let (result, artifacts, root) = run("main", None);
    let s = states(&result);
    assert_eq!(s.len(), 10, "one state reply per checkpoint");

    // The loading screen while London streams in, then the street.
    assert_eq!(s[0]["mode"], "loading");
    let street = &s[1];
    assert_eq!(street["mode"], "play");
    assert_eq!(street["region"]["name"], "London");
    assert_eq!(street["campaign"]["party"], "Dawn Front");
    let online = street["terrain"]["city"]["buildings"].as_u64().unwrap_or(0) > 0;
    println!("city online: {online}, nav {}", street["nav"]);
    if online { assert!(street["nav"]["buildings"].as_u64().unwrap() > 50, "the street map holds London's buildings: {street:#}"); }
    assert!(street["street"]["civilians"].as_u64().unwrap() >= 20, "{street:#}");
    assert!(street["street"]["walking"].as_u64().unwrap() > 0, "pedestrians walk their paths: {street:#}");

    // Holding W walked you down the street (sliding along a wall counts: buildings stop you).
    let walked = &s[2];
    let moved = ((f(&walked["player"]["x"]) - f(&street["player"]["x"])).powi(2) + (f(&walked["player"]["z"]) - f(&street["player"]["z"])).powi(2)).sqrt();
    assert!(moved > 1.0, "walked {moved:.2} m: {walked:#}");

    // A speech: a crowd gathers around you, and a perfect delivery wins it over.
    let gathering = &s[3];
    assert_eq!(gathering["mode"], "speech");
    assert!(gathering["street"]["listeners"].as_u64().unwrap() >= 3, "{gathering:#}");
    let done = &s[4];
    assert_eq!(done["speech"]["phase"], "done");
    assert!(f(&done["speech"]["result"]["score"]) > 0.8, "{done:#}");
    assert!(done["speech"]["result"]["joined"].as_u64().unwrap() > 0);
    let after = &s[5];
    assert_eq!(after["mode"], "play");
    assert!(f(&after["region"]["partyShare"]) > f(&street["region"]["partyShare"]), "the speech raised support: {after:#}");
    assert!(after["campaign"]["members"].as_u64().unwrap() > street["campaign"]["members"].as_u64().unwrap());

    // Talking to a passer-by.
    assert_eq!(s[6]["mode"], "dialogue");
    assert!(s[6]["dialogue"]["name"].as_str().unwrap().len() > 3);

    // The street battle: soldiers came, your followers fought with you.
    let battle = &s[8];
    assert!(battle["street"]["followers"].as_u64().unwrap() >= 1, "{battle:#}");
    assert!(battle["street"]["soldiers"].as_u64().unwrap() >= 1 || battle["campaign"]["stats"]["kills"].as_u64().unwrap() >= 1, "{battle:#}");

    // Taking the planet.
    let end = &s[9];
    assert_eq!(end["mode"], "outcome");
    assert_eq!(end["campaign"]["outcome"]["kind"], "victory");

    // What reached the screen.
    let title = find(&artifacts, "01-title");
    let banner = share(&title, (0.25, 0.27, 0.75, 0.4), &red);
    println!("01 red banner {banner:.3}");
    assert!(banner > 0.4, "the title's red banner ({banner:.3})");
    let world = share(&find(&artifacts, "04-street"), (0.3, 0.15, 0.75, 0.85), &|p| !dark(p));
    println!("04 lit scene {world:.3}");
    assert!(world > 0.7, "London is drawn ({world:.3})");
    let hud = share(&find(&artifacts, "04-street"), (0.0, 0.0, 0.25, 0.09), &dark);
    assert!(hud > 0.4, "the party panel ({hud:.3})");
    let cards = share(&find(&artifacts, "06-speech-cards"), (0.2, 0.8, 0.8, 0.92), &cream);
    println!("06 speech cards {cards:.3}");
    assert!(cards > 0.4, "three paper speech cards ({cards:.3})");
    let console = share(&find(&artifacts, "12-console-overview"), (0.0, 0.1, 1.0, 1.0), &dark);
    assert!(console > 0.6, "the command console ({console:.3})");
    let map = find(&artifacts, "14-console-territory");
    let (land, sea) = (share(&map, (0.02, 0.12, 0.66, 0.5), &|p| p[0] > 170 && p[1] > 150 && p[2] > 110), share(&map, (0.02, 0.12, 0.66, 0.5), &|p| p[2] as i32 > p[0] as i32 + 15 && p[2] < 90));
    println!("14 map land {land:.3}, sea {sea:.3}");
    assert!(land > 0.15 && sea > 0.3, "the world map: continents on the sea");
    let victory = share(&find(&artifacts, "19-victory"), (0.22, 0.28, 0.78, 0.38), &red);
    assert!(victory > 0.5, "the victory poster ({victory:.3})");
    println!("Allegiance live BDD: {}", root.display());
}

#[test]
fn allegiance_travel_live_feature() {
    let (result, artifacts, root) = run("travel", Some("tests/features/allegiance_travel_live.feature"));
    let s = states(&result);
    assert_eq!(s.len(), 7, "one state reply per checkpoint");
    // A rival rally drew a crowd; you confronted the orator and out-argued them.
    assert!(s[0]["street"]["rally"].is_object(), "{:#}", s[0]);
    assert!(s[0]["street"]["listeners"].as_u64().unwrap() >= 3, "the rival drew listeners: {:#}", s[0]);
    assert_eq!(s[1]["mode"], "dialogue");
    assert_eq!(s[2]["mode"], "speech");
    assert!(s[2]["speech"]["rival"].is_string(), "a debate against the orator: {:#}", s[2]);
    let debate = &s[3]["speech"]["result"]["rival"];
    assert_eq!(debate["won"], true, "{:#}", s[3]);
    // Paris: a day on the road, the loading screen, then the new city.
    assert_eq!(s[4]["mode"], "loading");
    assert_eq!(s[4]["region"]["name"], "Paris");
    assert_eq!(s[4]["campaign"]["day"], 1);
    assert_eq!(s[5]["mode"], "play");
    assert_eq!(s[5]["region"]["name"], "Paris");
    assert!(s[5]["street"]["civilians"].as_u64().unwrap() >= 20);
    // Saved, back to the title, continued: the same campaign in the same place.
    let back = &s[6];
    assert_eq!(back["mode"], "play");
    assert_eq!(back["region"]["name"], "Paris");
    assert_eq!(back["campaign"]["party"], "Dawn Front");
    assert_eq!(back["campaign"]["members"], s[5]["campaign"]["members"]);
    let paris = share(&find(&artifacts, "t6-paris"), (0.3, 0.15, 0.75, 0.85), &|p| !dark(p));
    assert!(paris > 0.7, "Paris is drawn ({paris:.3})");
    println!("Allegiance travel live BDD: {}", root.display());
}

#[test]
fn allegiance_iteration1_live_feature() {
    let (result, artifacts, _) = run("iteration1", Some("tests/features/allegiance_iteration1_live.feature"));
    let s = states(&result);
    assert_eq!(s.len(), 5);
    assert_eq!(s[0]["mode"], "setup", "controller opens New Campaign");
    assert_eq!(s[1]["mode"], "play");
    assert_eq!(s[1]["region"]["name"], "Levittown");
    assert_eq!(s[1]["region"]["country"], "The Workers States of America");
    assert_eq!(s[1]["flyingCar"]["state"], "parked");
    assert!(f(&s[1]["flyingCar"]["distance"]) < 6.0, "player starts beside their car");
    assert!(s[1]["settlements"].as_array().unwrap().iter().any(|d| d["name"] == "Levittown"));
    assert_ne!(s[1]["player"]["yaw"], s[2]["player"]["yaw"], "right stick turns the player camera");
    assert_eq!(s[3]["mode"], "console");
    assert_eq!(s[3]["tab"], "territory", "shoulders navigate console tabs");
    assert_eq!(s[4]["region"]["id"], s[1]["region"]["id"], "save restores independent hometown identity");
    assert_eq!(s[4]["mode"], "play");
    assert_eq!(s[4]["flyingCar"]["state"], "parked", "saved car is restored");
    let traffic = s[1]["traffic"]["count"].as_u64().unwrap();
    assert!(traffic <= 12);
    if s[1]["terrain"]["city"]["houses"].as_u64().unwrap_or(0) > 50 { assert!(traffic > 0); }
    assert_eq!(artifacts.len(), 4);
}

#[test]
fn allegiance_car_live_feature() {
    let (result, artifacts, _) = run("car", Some("tests/features/allegiance_car_live.feature"));
    let s = states(&result);
    assert_eq!(s.len(), 9);
    assert_eq!(s[0]["flyingCar"]["state"], "parked");
    assert_eq!(s[0]["flyingCar"]["piloting"], false);
    assert_eq!(s[1]["flyingCar"]["piloting"], true, "E boards the nearby car");
    assert_eq!(s[2]["flyingCar"]["state"], "hovering");
    assert!(f(&s[2]["flyingCar"]["altitude"]) > 8.0, "controller takes off");
    assert_eq!(s[3]["flyingCar"]["piloting"], true, "cannot exit airborne");
    assert_eq!(s[4]["flyingCar"]["piloting"], true, "resume aboard");
    assert!((f(&s[4]["flyingCar"]["altitude"]) - f(&s[2]["flyingCar"]["altitude"])).abs() < 1.0, "resume at saved altitude");
    let moved = (f(&s[5]["flyingCar"]["x"]) - f(&s[4]["flyingCar"]["x"])).hypot(f(&s[5]["flyingCar"]["z"]) - f(&s[4]["flyingCar"]["z"]));
    assert!(moved > 1.0, "keyboard flies the car horizontally");
    assert!(f(&s[6]["flyingCar"]["z"]) > f(&s[5]["flyingCar"]["z"]) + 1.0, "positive left-stick Y flies forward");
    assert!(f(&s[6]["player"]["yaw"]) > f(&s[5]["player"]["yaw"]), "right stick steers the car");
    assert_eq!(s[7]["flyingCar"]["state"], "parked", "controller autolands");
    assert!(f(&s[7]["flyingCar"]["altitude"]).abs() < 0.1);
    assert_eq!(s[8]["flyingCar"]["piloting"], false, "controller exits");
    assert!((3.5..6.0).contains(&f(&s[8]["flyingCar"]["distance"])), "exit beside the rotors");
    assert_eq!(artifacts.len(), 3);
}
