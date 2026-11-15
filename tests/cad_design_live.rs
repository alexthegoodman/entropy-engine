//! Contour Design in the real window, driven by tests/features/cad_design_live.feature through
//! startup.rs's Gherkin driver (the real pointer for drawing, the real buttons, and the app's MCP
//! tools). Checks what the kernel built, what the app persisted and what it exported, not the
//! driver's list of queued events. On a headless Linux box run it under `xvfb-run -a`.
//! The kernel's own tier is crates/entropy-cad; the TypeScript tier is tests/cad_doc.test.ts.
use std::{fs, process::Command};

#[test]
fn cad_design_live_feature() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("cad-design-bdd-{}", std::process::id()));
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_example"))
        .arg("cad-design")
        .env("ENTROPY_CAD_BDD_RESULT", &result_path)
        .env("ENTROPY_CAD_BDD_DATA", &data)
        .spawn()
        .expect("launch Contour Design");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if started.elapsed() > std::time::Duration::from_secs(300) {
            let _ = child.kill(); let _ = child.wait();
            panic!("Contour Design live BDD timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    assert!(status.success(), "Contour Design failed: {status}");
    let read = |path: &std::path::Path| -> serde_json::Value { serde_json::from_slice(&fs::read(path).unwrap()).unwrap() };
    let result = read(&result_path);
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts = result["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 10);
    for artifact in artifacts {
        let bytes = fs::read(artifact.as_str().unwrap()).expect("screenshot exists");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
    let tools = result["tools"].as_array().unwrap();
    for t in tools { assert_eq!(t["result"]["success"], true, "{} failed: {:#}", t["tool"], t["result"]); }
    let reply = |name: &str, nth: usize| -> &serde_json::Value {
        &tools.iter().filter(|t| t["tool"] == name).nth(nth).unwrap_or_else(|| panic!("no {name} reply #{nth}"))["result"]
    };
    let volume = |state: &serde_json::Value| state["bodies"][0]["volume"].as_f64().unwrap();
    let no_issues = |state: &serde_json::Value| assert_eq!(state["issues"].as_array().unwrap().len(), 0, "{:#}", state["issues"]);

    // The Skiff: fourteen features, one body, nothing wrong with any of them.
    let skiff = reply("cad_state", 0);
    no_issues(skiff);
    assert_eq!(skiff["features"].as_array().unwrap().len(), 14);
    assert_eq!(skiff["bodies"].as_array().unwrap().len(), 1);
    assert_eq!(skiff["bodies"][0]["name"], "Hull");
    assert!((1.0e6..1.5e6).contains(&volume(skiff)), "{}", volume(skiff));

    // Changing the thruster's lobes and tipping a hull section, both mid-history, rebuilt the body.
    let reshaped = reply("cad_state", 1);
    no_issues(reshaped);
    assert_eq!(reshaped["selected"], "r1");
    assert!((volume(reshaped) - volume(skiff)).abs() > 1000.0, "the edits changed nothing");
    assert_eq!(reply("cad_update", 0)["feature"]["lobes"], 9);

    // The pointer drew one closed curve: a profile, no loose ends.
    let drawn = reply("cad_state", 2);
    assert_eq!(drawn["editing"], "s1");
    let sketch = &drawn["sketches"][0];
    assert_eq!(sketch["curves"], 1);
    assert_eq!(sketch["regions"].as_array().unwrap().len(), 1);
    assert_eq!(sketch["chains"].as_array().unwrap().len(), 0);
    let area = sketch["regions"][0]["area"].as_f64().unwrap();
    assert!((3000.0..12000.0).contains(&area), "{area}");

    // The Extrude button made a body from it; both sides took their own shape.
    let raised = reply("cad_state", 3);
    no_issues(raised);
    assert_eq!(raised["editing"], serde_json::Value::Null, "Done left the sketch");
    let body = &raised["bodies"][0];
    assert_eq!(body["id"], "x1");
    assert_eq!(body["min"][1], -12.0);
    assert_eq!(body["max"][1], 60.0);
    assert!(volume(raised) > area * 30.0 && volume(raised) < area * 80.0, "{}", volume(raised));

    // The Loft button joined the drawn curve to the ellipse on the tipped plane...
    let lofted = reply("cad_state", 4);
    no_issues(lofted);
    assert_eq!(lofted["features"].as_array().unwrap().iter().map(|f| f["type"].as_str().unwrap()).collect::<Vec<_>>(), ["sketch", "sketch", "loft"]);
    assert_eq!(reply("cad_remove", 0)["removed"], serde_json::json!(["x1"]));
    // ...and the twist and the uneven mirror kept it one body, wider on the mirrored side.
    let finished = reply("cad_state", 5);
    no_issues(finished);
    assert_eq!(finished["bodies"].as_array().unwrap().len(), 1);
    assert!(volume(finished) > volume(lofted) * 1.5, "{} vs {}", volume(finished), volume(lofted));

    // Undo took the mirror's change back; redo restored it.
    assert!((volume(reply("cad_undo", 0)) - volume(finished)).abs() > 1.0);
    assert!((volume(reply("cad_undo", 1)) - volume(finished)).abs() < 1e-6);

    // Exports: a binary STL with every triangle, and an OBJ.
    let stl = fs::read("test-artifacts/cad-design-live.stl").unwrap();
    let triangles = finished["bodies"][0]["triangles"].as_u64().unwrap() as usize;
    assert_eq!(stl.len(), 84 + triangles * 50);
    assert_eq!(reply("cad_export", 0)["bytes"], stl.len());
    let obj = fs::read_to_string("test-artifacts/cad-design-live.obj").unwrap();
    assert_eq!(obj.lines().filter(|l| l.starts_with("f ")).count(), triangles);

    // What the app persisted is the document it reported.
    let session = read(&data.join("Contour Design").join("session.json"));
    assert_eq!(session["doc"], reply("cad_document", 0)["document"]);
    assert_eq!(session["doc"]["features"].as_array().unwrap().len(), 5);
}
