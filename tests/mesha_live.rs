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
        if started.elapsed() > std::time::Duration::from_secs(300) {
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

    // What the app persisted: that scene, plus the facade, lamps, coffee makers, domes, houses, a
    // door, the foliage (trees, conifers, palms, ferns, shrubs, grasses, flowers, pots and a garden)
    // and the themed buildings: hab lodges, wasteland depots and arcane emporiums.
    let session = read(&data.join("Mesha").join("session.json"));
    let saved = session["scene"]["instances"].as_array().unwrap();
    assert_eq!(saved.len(), 44);
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

    // Foliage. Trees are full crowns of leaves; the winter maple drops them, and Variation reshapes
    // the maple's branching while its size, finishes and canopy stay locked.
    let oak = &reply("mesha_add", 15)["instance"];
    assert_eq!(oak["objectId"], "nature.tree");
    assert_eq!(oak["violations"].as_array().unwrap().len(), 0);
    assert!(oak["triangles"].as_u64().unwrap() > 50_000, "an oak crown needs thousands of leaves: {oak:#}");
    assert_eq!(reply("mesha_add", 16)["instance"]["values"]["droop"], 2.0);
    let maple = &reply("mesha_add", 17)["instance"];
    let winter = &reply("mesha_set", 10)["instance"];
    assert_eq!(winter["values"]["canopy"], "bare");
    assert!(winter["triangles"].as_u64().unwrap() * 4 < maple["triangles"].as_u64().unwrap(), "bare branches should shed the leaves");
    let leafy = &reply("mesha_set", 11)["instance"];
    let tree_varied = &reply("mesha_vary", 5)["instance"];
    for key in ["height", "trunkRadius", "barkFinish", "leafFinish", "canopy"] {
        assert_eq!(tree_varied["values"][key], leafy["values"][key], "locked tree control moved: {key}");
    }
    assert!(reply("mesha_vary", 5)["changed"].as_array().unwrap().len() >= 3);
    assert_eq!(tree_varied["violations"].as_array().unwrap().len(), 0);
    assert_eq!(saved[18]["values"], tree_varied["values"]);
    // Stylized tiers replace thousands of needle sprays with a few jagged cones.
    let spruce = &reply("mesha_add", 18)["instance"];
    let tiers = &reply("mesha_set", 12)["instance"];
    assert_eq!(tiers["values"]["foliage"], "tiers");
    assert!(tiers["triangles"].as_u64().unwrap() * 10 < spruce["triangles"].as_u64().unwrap());
    for (n, id) in [(19, "nature.conifer"), (20, "nature.palm"), (21, "nature.fern"), (22, "nature.fern"), (23, "nature.shrub"), (24, "nature.shrub"), (25, "nature.grass"), (26, "nature.grass"), (27, "nature.flowers"), (28, "nature.flowers"), (29, "household.potted_plant")] {
        let added = &reply("mesha_add", n)["instance"];
        assert_eq!(added["objectId"], id);
        assert_eq!(added["violations"].as_array().unwrap().len(), 0, "{added:#}");
    }
    assert_eq!(reply("mesha_set", 13)["instance"]["values"]["flowerFinish"], "flower.pink");
    let succulent = &reply("mesha_set", 14)["instance"];
    assert_eq!(succulent["values"]["plant"], "succulent");
    assert_eq!(saved[30]["values"]["potShape"], "bowl");
    let foliage_export = reply("mesha_export", 5);
    let foliage_glb = fs::read(foliage_export["path"].as_str().unwrap()).unwrap();
    assert_eq!(&foliage_glb[..4], b"glTF");
    assert!(foliage_export["triangles"].as_u64().unwrap() > house_export["triangles"].as_u64().unwrap());

    // Hab lodge: lifting the crown and hiding the top deck each strip geometry away; Variation
    // restyles the Mars inn's airlock, viewports and systems but keeps its hull, cabins and finishes.
    let orbital = &reply("mesha_add", 36)["instance"];
    assert_eq!(orbital["objectId"], "architecture.hab_lodge");
    assert_eq!(orbital["violations"].as_array().unwrap().len(), 0, "{orbital:#}");
    let hab_open = &reply("mesha_set", 15)["instance"];
    assert!(hab_open["triangles"].as_u64().unwrap() < orbital["triangles"].as_u64().unwrap());
    let hab_cut = &reply("mesha_set", 16)["instance"];
    assert_eq!(hab_cut["values"]["cutaway"], 1);
    assert!(hab_cut["triangles"].as_u64().unwrap() * 10 < hab_open["triangles"].as_u64().unwrap() * 7);
    assert_eq!(saved[37]["values"]["roofVisible"], false);
    let mars = &reply("mesha_add", 37)["instance"];
    let mars_varied = &reply("mesha_vary", 6)["instance"];
    for key in ["decks", "beam", "lounge", "cabins", "cabinWidth", "corridor", "hullFinish", "glowFinish", "padFinish"] {
        assert_eq!(mars_varied["values"][key], mars["values"][key], "locked hab control moved: {key}");
    }
    assert!(reply("mesha_vary", 6)["changed"].as_array().unwrap().len() >= 2);
    assert_eq!(mars_varied["violations"].as_array().unwrap().len(), 0, "{mars_varied:#}");
    assert_eq!(saved[38]["values"], mars_varied["values"]);
    assert_eq!(saved[39]["values"]["legs"], "eight");

    // Wasteland depot: stripping the roof removes sheets; shutting the roller door and wrecking the
    // roof are persisted; Variation keeps the shed's size and finishes.
    let depot = &reply("mesha_add", 39)["instance"];
    assert_eq!(depot["objectId"], "architecture.wasteland_depot");
    assert_eq!(depot["violations"].as_array().unwrap().len(), 0, "{depot:#}");
    let stripped = &reply("mesha_set", 17)["instance"];
    assert!(stripped["triangles"].as_u64().unwrap() < depot["triangles"].as_u64().unwrap());
    let shut = &reply("mesha_set", 18)["instance"];
    assert!(shut["triangles"].as_u64().unwrap() > stripped["triangles"].as_u64().unwrap());
    assert_eq!(saved[40]["values"]["rollerOpen"], 0);
    assert_eq!(saved[40]["values"]["roofDamage"], 0.8);
    let factory = &reply("mesha_add", 40)["instance"];
    let factory_varied = &reply("mesha_vary", 7)["instance"];
    for key in ["width", "bays", "bayLength", "eave", "pitch", "claddingFinish", "roofFinish", "frameFinish"] {
        assert_eq!(factory_varied["values"][key], factory["values"][key], "locked depot control moved: {key}");
    }
    assert!(reply("mesha_vary", 7)["changed"].as_array().unwrap().len() >= 2);
    assert_eq!(factory_varied["violations"].as_array().unwrap().len(), 0, "{factory_varied:#}");
    assert_eq!(saved[41]["values"], factory_varied["values"]);

    // Arcane emporium: more crystals add geometry, lifting the roofs and cutting away the upper
    // floor take it away; Variation keeps the shop's size, tower and finishes (the tower's radius sets
    // the least depth, so it is locked with the size).
    let twilight = &reply("mesha_add", 41)["instance"];
    assert_eq!(twilight["objectId"], "architecture.arcane_emporium");
    assert_eq!(twilight["violations"].as_array().unwrap().len(), 0, "{twilight:#}");
    let lit = &reply("mesha_set", 19)["instance"];
    assert_eq!(lit["values"]["litWindows"], true);
    assert!(lit["triangles"].as_u64().unwrap() > twilight["triangles"].as_u64().unwrap());
    let roofless_shop = &reply("mesha_set", 20)["instance"];
    assert!(roofless_shop["triangles"].as_u64().unwrap() < lit["triangles"].as_u64().unwrap());
    let ground_shop = &reply("mesha_set", 21)["instance"];
    assert!(ground_shop["triangles"].as_u64().unwrap() * 10 < roofless_shop["triangles"].as_u64().unwrap() * 7);
    assert_eq!(saved[42]["values"]["cutaway"], true);
    let apothecary = &reply("mesha_add", 42)["instance"];
    let apothecary_varied = &reply("mesha_vary", 8)["instance"];
    for key in ["width", "depth", "storeyHeight", "jetty", "pitch", "whimsy", "towerRadius", "hatHeight", "stoneFinish", "roofFinish", "hatFinish", "glowFinish"] {
        assert_eq!(apothecary_varied["values"][key], apothecary["values"][key], "locked emporium control moved: {key}");
    }
    assert!(reply("mesha_vary", 8)["changed"].as_array().unwrap().len() >= 2);
    assert_eq!(apothecary_varied["violations"].as_array().unwrap().len(), 0, "{apothecary_varied:#}");
    assert_eq!(saved[43]["values"], apothecary_varied["values"]);
    let themed_export = reply("mesha_export", 6);
    let themed_glb = fs::read(themed_export["path"].as_str().unwrap()).unwrap();
    assert_eq!(&themed_glb[..4], b"glTF");
    assert!(themed_export["triangles"].as_u64().unwrap() > foliage_export["triangles"].as_u64().unwrap());

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

    // The foliage shading reached the screen: a green oak crown, an orange back-lit maple.
    let share = |name: &str, test: &dyn Fn([u8; 3]) -> bool| -> f64 {
        let img = image::open(find(name)).unwrap().to_rgb8();
        let (w, h) = img.dimensions();
        let (mut hit, mut total) = (0u64, 0u64);
        for y in (h / 8)..(h * 7 / 8) {
            for x in (w / 4)..(w * 3 / 4) {
                total += 1;
                if test(img.get_pixel(x, y).0) { hit += 1; }
            }
        }
        hit as f64 / total as f64
    };
    let green = share("31-tree-oak", &|p| p[1] as i32 > p[0] as i32 + 12 && p[1] as i32 > p[2] as i32 + 12);
    assert!(green > 0.04, "the oak's crown is barely green on screen ({green:.3})");
    let orange = share("33-tree-autumn-backlit", &|p| p[0] as i32 > p[1] as i32 + 30 && p[1] as i32 > p[2] as i32);
    assert!(orange > 0.03, "the autumn maple is barely orange on screen ({orange:.3})");
    println!("Mesha live BDD: {}", root.display());
}
