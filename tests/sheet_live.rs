//! Live tier for the `sheet` addon: spawns the real compiled `example sheet` binary in scripted
//! test mode (see `tests/features/sheet_live.feature` and `BrowserBddDriver` in src/startup.rs),
//! then checks both the driver's own result.json and the document the addon actually persisted
//! to disk. The fast tier (tests/sheet_grid_bdd.rs) already proves entropy_gui::SheetGrid's own
//! interaction logic against real synthetic input in a headless context; this tier instead
//! proves the real bundled dist/sheet.js, the real Rust<->JS event wiring, and real formula
//! evaluation and persistence all actually agree with each other end to end.

use std::process::Command;

#[tokio::main]
async fn main() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("sheet-bdd-{}", std::process::id()));
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let _ = std::fs::remove_file(&result_path);

    let example = std::env::var_os("CARGO_BIN_EXE_example").expect("Cargo must provide the real example binary");
    let status = Command::new(example)
        .arg("sheet")
        .env("ENTROPY_SHEET_BDD_RESULT", &result_path)
        .env("ENTROPY_SHEET_BDD_DATA", &data)
        .status()
        .expect("launch the real Entropy sheet addon");
    assert!(status.success(), "the live sheet addon must exit cleanly: {status}");

    let result: serde_json::Value = serde_json::from_slice(&std::fs::read(&result_path).expect("live result JSON")).expect("valid result JSON");
    assert_eq!(result["status"], "passed", "{result:#}");

    let artifacts: Vec<String> = result["artifacts"].as_array().expect("artifact array").iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(artifacts.len(), 6, "{artifacts:?}");
    for artifact in &artifacts {
        assert!(std::path::Path::new(artifact).is_file(), "missing artifact {artifact}");
    }

    // sheet_addon.ts's addonInfo.name is "sheet", so IO.save writes flat as "<data dir>/sheet.json"
    // (see op_addon_save_data) - a plain, predictable path, the same reasoning CC Manager's own
    // tasks.json uses.
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("sheet.json")).expect("persisted sheet document")).unwrap();
    let cells = saved["cells"].as_object().expect("cells object");

    println!("\n[Live sheet BDD]");
    println!("  {} artifacts captured, persisted document has {} non-empty cells", artifacts.len(), cells.len());

    // Two literal values and a formula that reads them, all set through the formula bar and
    // committed by moving selection away - proves the real bundle's formula bar -> commit ->
    // save path, not just the pure sheet_model.ts engine (already covered by
    // tests/sheet_model.test.ts) or the widget's own rendering (covered by sheet_grid_bdd.rs).
    assert_eq!(cells["0:0"]["raw"], "10", "{saved:#}");
    assert_eq!(cells["0:1"]["raw"], "20", "{saved:#}");
    assert_eq!(cells["0:2"]["raw"], "=A1+B1", "{saved:#}");

    // The border color picker's onChange reached mutateBorder and it was saved as [r,g,b,a].
    let border = cells["0:2"]["border"].as_array().expect("a border was set");
    let b: Vec<f64> = border.iter().map(|v| v.as_f64().unwrap()).collect();
    println!("  border color on 0,2: {b:?}");
    assert!(b[0] > 0.9 && b[1] < 0.1 && b[2] < 0.1 && b[3] > 0.9, "expected a solid red border, got {b:?}");

    // The three SHEET_EDIT_* events (the widget's own inline-editing session, injected here at
    // the event level - see the feature file's own comment on why) committed through exactly
    // the same code path a real double-click/typed edit would.
    assert_eq!(cells["5:0"]["raw"], "inline value", "{saved:#}");

    // Inserting then deleting a row and a column (well away from every populated cell above, so
    // nothing else could have shifted) round-trips the sheet back to its starting shape.
    assert_eq!(saved["rows"], 30, "{saved:#}");
    assert_eq!(saved["cols"], 12, "{saved:#}");

    // Undo reverted the "before undo" commit at 4,4 - and only that one; every assertion above
    // this point already proves the earlier commits (the formula cells, the border, the inline
    // edit, the row/column insert-delete) are all still intact.
    assert!(!cells.contains_key("4:4"), "undo should have reverted cell 4,4 back to empty: {saved:#}");

    println!("  ✔ formulas, border color, inline-edit commit, row/column insert-delete, and undo all persisted correctly");
    println!("  ✔ artifacts: {}", root.display());
    println!("[Summary] 1 live-ui feature (passed)");
}
