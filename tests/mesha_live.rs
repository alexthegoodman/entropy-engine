//! Mesha in the real window, driven by tests/features/mesha_live.feature through startup.rs's
//! Gherkin driver (mostly via Mesha's own MCP tools). Checks what the app itself persisted and
//! exported, not the driver's list of queued events. On a headless Linux box run it under
//! `xvfb-run -a`. The pure-TypeScript tier is examples/studio-bundle/tests/mesha.test.ts.
use std::{fs, process::Command};

#[test]
fn mesha_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("mesha-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("mesha")
        .env("ENTROPY_MESHA_BDD_RESULT", &result_path)
        .env("ENTROPY_MESHA_BDD_DATA", &data)
        .spawn()
        .expect("launch Mesha");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(420) {
            let _ = child.kill(); let _ = child.wait();
            panic!("Mesha live BDD timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Mesha failed: {status}");
    let read = |path: &std::path::Path| -> serde_json::Value { serde_json::from_slice(&fs::read(path).unwrap()).unwrap() };
    let result = read(&result_path);
    assert_eq!(result["status"], "passed", "{result:#}");
    for artifact in result["artifacts"].as_array().unwrap() {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    let tools = result["tools"].as_array().unwrap();
    let reply = |name: &str, nth: usize| -> &serde_json::Value {
        &tools.iter().filter(|t| t["tool"] == name).nth(nth).unwrap_or_else(|| panic!("no {name} reply #{nth}"))["result"]
    };

    // Variation moved the chair but never what was locked (a parameter, and the whole Materials group).
    let varied = &reply("mesha_vary", 0)["instance"];
    assert_eq!(varied["values"]["seatHeight"], 0.47, "a locked parameter moved");
    assert_eq!(varied["values"]["upholstery"], "fabric.charcoal", "a locked group moved");
    assert!(reply("mesha_vary", 0)["changed"].as_array().unwrap().len() >= 3, "Variation barely changed anything");
    assert_eq!(varied["violations"].as_array().unwrap().len(), 0, "Variation broke a rule: {varied:#}");
    // The toolbar-free path: the real Variation button changed the design again.
    let after_button = &reply("mesha_state", 0)["instances"][0]["values"];
    assert_ne!(after_button, &varied["values"], "clicking Variation did nothing");
    assert_eq!(after_button["seatHeight"], 0.47);

    // Four legs instead of casters: fewer triangles, and the definition says wheels hide then.
    let legs = &reply("mesha_set", 0)["instance"];
    assert_eq!(legs["values"]["base"], "legs");
    assert!(legs["triangles"].as_u64().unwrap() < varied["triangles"].as_u64().unwrap());
    let definition = &reply("mesha_describe", 0)["definition"];
    let spokes = definition["params"].as_array().unwrap().iter().find(|p| p["id"] == "spokes").unwrap();
    assert_eq!(spokes["visibleIf"], "=base == 'star'");

    // The composed scene, after an undo and a redo of the last add.
    assert_eq!(reply("mesha_undo", 0)["instances"].as_array().unwrap().len(), 3);
    let state = reply("mesha_state", 1);
    let instances = state["instances"].as_array().unwrap();
    let ids: Vec<&str> = instances.iter().map(|i| i["objectId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["furniture.office_chair", "furniture.table", "household.bottle", "nature.rock"]);
    assert_eq!(instances[2]["position"][1], 0.74, "the bottle stands on the table top");
    assert_eq!(instances[1]["values"]["topShape"], "round", "the table took its preset");
    assert_eq!(state["lighting"], "warm");

    // What the app persisted: that scene, plus the facade, lamps, coffee makers, domes, houses, a door and the plants.
    let session = read(&data.join("Mesha").join("session.json"));
    let saved = session["scene"]["instances"].as_array().unwrap();
    assert_eq!(saved.len(), 29);
    assert_eq!(saved[4]["objectId"], "architecture.facade");
    assert_eq!(saved[4]["values"]["windowCount"], 6);
    let lamp = &reply("mesha_vary", 1)["instance"];
    assert_eq!(lamp["values"]["height"], 0.34);
    assert_eq!(lamp["values"]["shadeFinish"], "paint.sage");
    assert_eq!(lamp["values"]["baseFinish"], "paint.sage");
    assert!(reply("mesha_vary", 1)["changed"].as_array().unwrap().len() >= 2);
    assert_eq!(lamp["violations"].as_array().unwrap().len(), 0);
    assert_eq!(saved[5]["values"], lamp["values"]);
    assert_eq!(saved[6]["objectId"], "household.table_lamp");
    assert_eq!(saved[6]["values"]["baseShape"], "spindle");
    assert_eq!(saved[6]["values"]["baseFinish"], "wood.walnut");
    let lamp_glb = fs::read(reply("mesha_export", 1)["path"].as_str().unwrap()).unwrap();
    assert_eq!(&lamp_glb[..4], b"glTF");
    assert!(reply("mesha_export", 1)["triangles"].as_u64().unwrap() > reply("mesha_export", 0)["triangles"].as_u64().unwrap());

    // The wide cafe machine has two groups; narrowing it clamps to one before variation.
    let cafe = &reply("mesha_add", 7)["instance"];
    assert_eq!(cafe["objectId"], "household.coffee_maker");
    assert_eq!(cafe["values"]["groups"], 2);
    let compact = &reply("mesha_set", 3)["instance"];
    assert_eq!(compact["values"]["groups"], 1);
    assert!(compact["triangles"].as_u64().unwrap() < cafe["triangles"].as_u64().unwrap());
    let coffee = &reply("mesha_vary", 2)["instance"];
    for key in ["width", "height", "depth", "rounding", "bodyFinish", "metalFinish", "handleFinish"] {
        assert_eq!(coffee["values"][key], compact["values"][key], "locked coffee control moved: {key}");
    }
    assert!(reply("mesha_vary", 2)["changed"].as_array().unwrap().len() >= 2);
    assert_eq!(coffee["violations"].as_array().unwrap().len(), 0);
    assert_eq!(saved[8]["values"], coffee["values"]);
    assert_eq!(saved[9]["values"]["metalFinish"], "metal.brass");
    let coffee_export = reply("mesha_export", 2);
    let coffee_glb = fs::read(coffee_export["path"].as_str().unwrap()).unwrap();
    assert_eq!(&coffee_glb[..4], b"glTF");
    let coffee_json_len = u32::from_le_bytes(coffee_glb[12..16].try_into().unwrap()) as usize;
    let coffee_gltf: serde_json::Value = serde_json::from_slice(&coffee_glb[20..20 + coffee_json_len]).unwrap();
    assert_eq!(coffee_gltf["meshes"].as_array().unwrap().len() as u64, coffee_export["meshes"].as_u64().unwrap());
    assert!(coffee_export["triangles"].as_u64().unwrap() > reply("mesha_export", 1)["triangles"].as_u64().unwrap());

    let civic = &reply("mesha_add", 9)["instance"];
    let cutaway = &reply("mesha_set", 4)["instance"];
    assert_eq!(cutaway["values"]["roofVisible"], false);
    assert!(cutaway["triangles"].as_u64().unwrap() < civic["triangles"].as_u64().unwrap());
    assert_eq!(saved[10]["values"]["roofVisible"], true);
    assert_eq!(saved[10]["values"]["doorWidth"], 4);
    let alien = &reply("mesha_add", 10)["instance"];
    let dome_varied = &reply("mesha_vary", 3)["instance"];
    for key in ["doorWidth", "doorHeight", "radius", "wall", "roofFinish", "wallFinish"] {
        assert_eq!(dome_varied["values"][key], alien["values"][key], "locked dome control moved: {key}");
    }
    assert!(reply("mesha_vary", 3)["changed"].as_array().unwrap().len() >= 2);
    assert_eq!(saved[11]["values"], dome_varied["values"]);
    assert_eq!(saved[12]["values"]["oculus"], 0);
    let dome_glb = fs::read(reply("mesha_export", 3)["path"].as_str().unwrap()).unwrap();
    assert_eq!(&dome_glb[..4], b"glTF");
    assert!(reply("mesha_export", 3)["triangles"].as_u64().unwrap() > coffee_export["triangles"].as_u64().unwrap());

    // The house: lifting the roof and cutting away the top storey each remove geometry; a third
    // storey and a hip roof add it. Variation restyles the farmhouse outside but keeps its plan,
    // stair and finishes.
    let colonial = &reply("mesha_add", 12)["instance"];
    assert_eq!(colonial["objectId"], "architecture.house");
    assert_eq!(colonial["violations"].as_array().unwrap().len(), 0);
    let roofless = &reply("mesha_set", 6)["instance"];
    assert_eq!(roofless["values"]["roofVisible"], false);
    assert!(roofless["triangles"].as_u64().unwrap() < colonial["triangles"].as_u64().unwrap());
    let ground = &reply("mesha_set", 7)["instance"];
    assert_eq!(ground["values"]["cutaway"], 1);
    assert!(ground["triangles"].as_u64().unwrap() < roofless["triangles"].as_u64().unwrap() * 3 / 5);
    let taller = &reply("mesha_set", 8)["instance"];
    assert_eq!(taller["values"]["storeys"], 3);
    assert_eq!(taller["violations"].as_array().unwrap().len(), 0, "{taller:#}");
    assert!(taller["triangles"].as_u64().unwrap() > colonial["triangles"].as_u64().unwrap());
    assert_eq!(saved[13]["values"]["roofStyle"], "hip");
    assert_eq!(saved[13]["values"]["cutaway"], 0);
    let farmhouse = &reply("mesha_add", 13)["instance"];
    let farm_varied = &reply("mesha_vary", 4)["instance"];
    for key in ["width", "depth", "storeys", "storeyHeight", "hallWidth", "stairWidth", "stairSide", "wallFinish", "roofFinish", "floorFinish"] {
        assert_eq!(farm_varied["values"][key], farmhouse["values"][key], "locked house control moved: {key}");
    }
    assert!(reply("mesha_vary", 4)["changed"].as_array().unwrap().len() >= 3);
    assert_eq!(farm_varied["violations"].as_array().unwrap().len(), 0);
    assert_eq!(saved[14]["values"], farm_varied["values"]);
    let door = &reply("mesha_set", 9)["instance"];
    assert_eq!(door["objectId"], "architecture.door");
    assert_eq!(door["values"]["exterior"], true);
    assert_eq!(saved[15]["values"]["openAngle"], 70);
    let house_export = reply("mesha_export", 4);
    let house_glb = fs::read(house_export["path"].as_str().unwrap()).unwrap();
    assert_eq!(&house_glb[..4], b"glTF");
    assert!(house_export["triangles"].as_u64().unwrap() > reply("mesha_export", 3)["triangles"].as_u64().unwrap());

    // Trees: the oak takes new leaf, second-colour and canopy settings; a locked Variation keeps the
    // willow's size and finishes; the export is double-sided so open leaf sheets survive a viewer's back-face culling.
    let oak = &reply("mesha_add", 15)["instance"];
    assert_eq!(oak["objectId"], "nature.tree");
    assert_eq!(oak["violations"].as_array().unwrap().len(), 0, "{oak:#}");
    assert!(oak["triangles"].as_u64().unwrap() > 10_000, "a leafy crown is thousands of triangles");
    let autumn = &reply("mesha_set", 10)["instance"];
    assert_eq!(autumn["values"]["leafShape"], "maple");
    assert_eq!(autumn["values"]["secondShare"], 0.5);
    assert_ne!(autumn["triangles"], oak["triangles"]);
    let open = &reply("mesha_set", 11)["instance"];
    assert_eq!(open["values"]["canopyMass"], 0.1);
    assert_eq!(saved[16]["values"]["crownShape"], "vase");
    assert_eq!(saved[16]["values"]["secondShare"], 0);
    assert_eq!(saved[17]["values"]["extra"], "blossom");
    let willow = &reply("mesha_add", 17)["instance"];
    let willow_varied = &reply("mesha_vary", 5)["instance"];
    for key in ["height", "crownWidth", "leafFinish", "barkFinish", "secondFinish", "extraFinish"] {
        assert_eq!(willow_varied["values"][key], willow["values"][key], "locked tree control moved: {key}");
    }
    assert!(reply("mesha_vary", 5)["changed"].as_array().unwrap().len() >= 3);
    assert_eq!(willow_varied["violations"].as_array().unwrap().len(), 0, "{willow_varied:#}");
    assert_eq!(saved[18]["values"], willow_varied["values"]);
    let tree_export = reply("mesha_export", 5);
    let tree_glb = fs::read(tree_export["path"].as_str().unwrap()).unwrap();
    assert_eq!(&tree_glb[..4], b"glTF");
    let tree_json_len = u32::from_le_bytes(tree_glb[12..16].try_into().unwrap()) as usize;
    let tree_gltf: serde_json::Value = serde_json::from_slice(&tree_glb[20..20 + tree_json_len]).unwrap();
    assert!(tree_gltf["materials"].as_array().unwrap().iter().all(|m| m["doubleSided"] == true), "leaf sheets must export double-sided");
    assert!(tree_export["triangles"].as_u64().unwrap() > house_export["triangles"].as_u64().unwrap());

    // Evergreens and palms.
    let spruce = &reply("mesha_add", 18)["instance"];
    assert_eq!(spruce["objectId"], "nature.conifer");
    assert_eq!(spruce["violations"].as_array().unwrap().len(), 0, "{spruce:#}");
    let fir = &reply("mesha_set", 12)["instance"];
    assert_eq!(fir["values"]["shape"], "fir");
    assert_eq!(fir["values"]["cones"], 14);
    assert_ne!(fir["triangles"], spruce["triangles"]);
    assert_eq!(saved[19]["values"]["needleFinish"], "leaf.blue");
    assert_eq!(saved[20]["values"]["shape"], "pine");
    let coconut = &reply("mesha_add", 20)["instance"];
    assert_eq!(coconut["values"]["fruitKind"], "coconuts");
    let fan = &reply("mesha_set", 13)["instance"];
    assert_eq!(fan["values"]["frondStyle"], "fan");
    assert_ne!(fan["triangles"], coconut["triangles"]);
    assert_eq!(saved[21]["values"]["fruitKind"], "none");
    let conifer_export = reply("mesha_export", 6);
    assert_eq!(&fs::read(conifer_export["path"].as_str().unwrap()).unwrap()[..4], b"glTF");
    assert!(conifer_export["triangles"].as_u64().unwrap() > tree_export["triangles"].as_u64().unwrap());

    // Undergrowth: ferns, flowers, grass and shrubs, and a locked Variation of the hedge.
    let fern = &reply("mesha_add", 21)["instance"];
    assert_eq!(fern["violations"].as_array().unwrap().len(), 0);
    assert_eq!(reply("mesha_set", 14)["instance"]["values"]["upright"], 0.9);
    assert_eq!(saved[22]["values"]["fronds"], 20);
    assert_eq!(reply("mesha_add", 22)["instance"]["objectId"], "nature.flower");
    assert_eq!(saved[24]["values"]["height"], 0.22);
    assert_eq!(saved[24]["values"]["layers"], 4);
    assert_eq!(reply("mesha_set", 16)["instance"]["values"]["height"], 0.24);
    assert_eq!(saved[26]["objectId"], "nature.grass");
    assert_eq!(saved[26]["values"]["flowers"], 5);
    assert_eq!(saved[27]["values"]["blooms"], "flowers");
    let hedge = &reply("mesha_add", 27)["instance"];
    let hedge_varied = &reply("mesha_vary", 6)["instance"];
    for key in ["form", "width", "height", "depth", "leafFinish"] {
        assert_eq!(hedge_varied["values"][key], hedge["values"][key], "locked hedge control moved: {key}");
    }
    assert!(reply("mesha_vary", 6)["changed"].as_array().unwrap().len() >= 2);
    assert_eq!(hedge_varied["violations"].as_array().unwrap().len(), 0, "{hedge_varied:#}");
    assert_eq!(saved[28]["values"], hedge_varied["values"]);
    let plants_export = reply("mesha_export", 7);
    assert_eq!(&fs::read(plants_export["path"].as_str().unwrap()).unwrap()[..4], b"glTF");
    assert!(plants_export["triangles"].as_u64().unwrap() > conifer_export["triangles"].as_u64().unwrap());

    // The GLB: a real glTF binary with one mesh per object material.
    let export = reply("mesha_export", 0);
    let glb = fs::read(export["path"].as_str().unwrap()).expect("GLB written");
    assert_eq!(&glb[..4], b"glTF");
    let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let gltf: serde_json::Value = serde_json::from_slice(&glb[20..20 + json_len]).unwrap();
    assert_eq!(gltf["meshes"].as_array().unwrap().len() as u64, export["meshes"].as_u64().unwrap());
    assert!(export["triangles"].as_u64().unwrap() > 20_000);

    // Window count 4 -> 6: the facade's composed windows follow its parameter.
    let four = &reply("mesha_add", 3)["instance"];
    let six = &reply("mesha_set", 1)["instance"];
    assert_eq!(four["objectId"], "architecture.facade");
    assert_eq!(six["values"]["windowCount"], 6);
    assert!(six["triangles"].as_u64().unwrap() > four["triangles"].as_u64().unwrap() * 5 / 4, "two more windows should add geometry");

    // Screenshots: Variation visibly changed the chair in the viewport (between the side panels).
    let artifacts: Vec<String> = result["artifacts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    let find = |name: &str| artifacts.iter().find(|a| a.ends_with(&format!("{name}.png"))).unwrap_or_else(|| panic!("no {name} capture")).clone();
    let a = image::open(find("01-office-chair")).unwrap().to_rgb8();
    let b = image::open(find("02-variation")).unwrap().to_rgb8();
    let (w, h) = a.dimensions();
    let (mut changed, mut total) = (0u64, 0u64);
    for y in (h / 8)..(h * 7 / 8) {
        for x in (w / 4)..(w * 3 / 4) {
            total += 1;
            let (p, q) = (a.get_pixel(x, y).0, b.get_pixel(x, y).0);
            if (0..3).any(|c| (p[c] as i32 - q[c] as i32).abs() > 24) { changed += 1; }
        }
    }
    assert!(changed * 50 > total, "the viewport barely changed after Variation ({changed}/{total} pixels)");
    // The plants really are drawn with the foliage shader: leaves show up as green in the oak, and as
    // red and orange after it turns to autumn maple; the spruce is a dark green cone.
    let share = |name: &str, hit: &dyn Fn([u8; 3]) -> bool| -> f64 {
        let img = image::open(find(name)).unwrap().to_rgb8();
        let (w, h) = img.dimensions();
        let (mut n, mut total) = (0u64, 0u64);
        for y in (h / 8)..(h * 7 / 8) {
            for x in (w / 4)..(w * 3 / 4) {
                total += 1;
                if hit(img.get_pixel(x, y).0) { n += 1; }
            }
        }
        n as f64 / total as f64
    };
    let green = |p: [u8; 3]| p[1] as i32 > p[0] as i32 + 12 && p[1] as i32 > p[2] as i32 + 12;
    let autumn_red = |p: [u8; 3]| p[0] as i32 > p[1] as i32 + 40 && p[0] as i32 > p[2] as i32 + 40;
    assert!(share("31-tree-oak", &green) > 0.02, "the oak's leaves are not green in the viewport");
    assert!(share("32-tree-autumn-maple", &autumn_red) > 0.01, "the autumn maple has no red or orange leaves");
    assert!(share("32-tree-autumn-maple", &autumn_red) > share("31-tree-oak", &autumn_red) * 3.0);
    assert!(share("37-conifer-spruce", &green) > 0.005, "the spruce is not green in the viewport");
    assert!(share("42-fern", &green) > 0.02, "the fern is not green in the viewport");
    println!("Mesha live BDD: {}", root.display());
}
