//! `Entropy.IO.store` end to end: a real addon script runs in the engine's V8 runtime and uses its
//! own store, and the test reads what landed on disk. The path rules and the atomic write are unit
//! tested in src/helpers/addon_store.rs; this checks the ops are registered, the JS binding passes
//! the right addon folder, null/list/remove come back as JS values, and errors reach JS as throws.
//! No window, GPU or audio device is needed.

use entropy_engine::deno::addon_engine::AddonEngine;
use std::{fs, path::PathBuf};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("entropy-store-js-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

// Writes what it saw through IO.save (`<data>/Store Test.json`), which the test then reads.
const SCRIPT: &str = r#"
const addon = Entropy.Addon.register({ name: "Store Test", version: "1", description: "", author: [], category: "Test", capabilities: { ui: false, needsViewport: false } });
addon.onInit(() => {
    const out = {};
    const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: String(e) }; } };
    out.missing = addon.IO.store.read("songs/none.json");
    addon.IO.store.write("songs/a.json", JSON.stringify({ n: 1 }));
    addon.IO.store.write("songs/a.json", JSON.stringify({ n: 2 }));
    addon.IO.store.write("versions/a/v1.json", "[]");
    out.read = JSON.parse(addon.IO.store.read("songs/a.json"));
    out.top = addon.IO.store.list().map(e => [e.name, e.isDir]);
    out.songs = addon.IO.store.list("songs").map(e => ({ name: e.name, size: e.size, hasTime: e.modifiedMs > 0 }));
    out.removedDir = addon.IO.store.remove("versions/a");
    out.removedAgain = addon.IO.store.remove("versions/a");
    out.escape = attempt(() => addon.IO.store.write("../escape.json", "x"));
    out.hidden = attempt(() => addon.IO.store.read(".secret"));
    addon.IO.save(out);
});
"#;

#[test]
fn an_addon_reads_writes_lists_and_removes_its_own_files() {
    let data = temp_dir("roundtrip");
    let mut engine = AddonEngine::new(None, Some(data.clone()), None);
    engine.load_bundle_sync("store_test.js", SCRIPT).expect("the script runs");

    let seen: serde_json::Value = serde_json::from_slice(&fs::read(data.join("Store Test.json")).expect("the script saved its findings")).unwrap();
    assert_eq!(seen["missing"], serde_json::Value::Null, "{seen:#}");
    assert_eq!(seen["read"]["n"], 2, "{seen:#}");
    assert_eq!(seen["top"], serde_json::json!([["songs", true], ["versions", true]]), "{seen:#}");
    assert_eq!(seen["songs"], serde_json::json!([{ "name": "a.json", "size": 7, "hasTime": true }]), "{seen:#}");
    assert_eq!(seen["removedDir"], true, "{seen:#}");
    assert_eq!(seen["removedAgain"], false, "{seen:#}");
    assert_eq!(seen["escape"]["ok"], false, "{seen:#}");
    assert!(seen["escape"]["error"].as_str().unwrap().contains("not a valid storage path"), "{seen:#}");
    assert_eq!(seen["hidden"]["ok"], false, "{seen:#}");

    // Everything lives in the addon's own folder, and nothing escaped it.
    assert!(data.join("Store Test").join("songs").join("a.json").is_file());
    assert!(!data.join("Store Test").join("versions").join("a").exists());
    assert!(!data.join("escape.json").exists() && !temp_dir("roundtrip").parent().unwrap().join("escape.json").exists());
    let _ = fs::remove_dir_all(&data);
}

#[test]
fn without_a_data_folder_every_call_throws_instead_of_pretending() {
    let mut engine = AddonEngine::new(None, None, None);
    let script = r#"
        const addon = Entropy.Addon.register({ name: "No Data", version: "1", description: "", author: [], category: "Test", capabilities: { ui: false, needsViewport: false } });
        addon.onInit(() => {
            let threw = "";
            try { addon.IO.store.write("a.json", "{}"); } catch (e) { threw = String(e); }
            globalThis.__storeResult = threw;
        });
    "#;
    engine.load_bundle_sync("no_data.js", script).expect("the script runs");
    let result = engine.runtime.execute_script("check.js", "globalThis.__storeResult".to_string()).unwrap();
    let scope = &mut engine.runtime.handle_scope();
    let local = deno_core::v8::Local::new(scope, result);
    let text = local.to_rust_string_lossy(scope);
    assert!(text.contains("no data folder"), "expected a clear error, got {text:?}");
}
