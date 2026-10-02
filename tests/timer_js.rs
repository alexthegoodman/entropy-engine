//! Tests for Entropy.setTimeout, clearTimeout, flushTimeout, and key-based auto-cancel on Rust side.

use entropy_engine::deno::addon_engine::AddonEngine;
use std::{fs, path::PathBuf, thread, time::Duration};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("entropy-timer-js-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn test_timer_auto_cancel_by_key_and_execution() {
    let data = temp_dir("timer_test");
    let mut engine = AddonEngine::new(None, Some(data.clone()), None);

    const SCRIPT: &str = r#"
    const addon = Entropy.Addon.register({
        name: "Timer Test",
        version: "1",
        description: "",
        author: [],
        category: "Test",
        capabilities: { ui: false, needsViewport: false }
    });

    globalThis.testResults = {
        firstFired: false,
        secondFired: false,
        clearedFired: false,
        flushedFired: false
    };

    addon.onInit(() => {
        // 1. Key-based auto-cancellation: setting key "same_key" twice
        Entropy.setTimeout(() => {
            globalThis.testResults.firstFired = true;
        }, 10, "same_key");

        // Immediately replace with same key: Rust side should replace the callback
        Entropy.setTimeout(() => {
            globalThis.testResults.secondFired = true;
            addon.IO.save(globalThis.testResults);
        }, 10, "same_key");

        // 2. Clear timeout
        Entropy.setTimeout(() => {
            globalThis.testResults.clearedFired = true;
        }, 10, "cancel_me");
        Entropy.clearTimeout("cancel_me");

        // 3. Flush timeout
        Entropy.setTimeout(() => {
            globalThis.testResults.flushedFired = true;
        }, 1000, "flush_me");
        Entropy.flushTimeout("flush_me");
    });
    "#;

    engine.load_bundle_sync("timer_test.js", SCRIPT).expect("the script runs");

    // Before delay has passed:
    engine.run_expired_timers();

    // Wait for the 10ms timer to expire
    thread::sleep(Duration::from_millis(25));
    engine.run_expired_timers();

    let saved: serde_json::Value = serde_json::from_slice(
        &fs::read(data.join("Timer Test.json")).expect("saved file exists")
    ).unwrap();

    // firstFired MUST be false because it was auto-cancelled by key
    assert_eq!(saved["firstFired"], false, "First timer with duplicate key should have been cancelled by Rust");
    // secondFired MUST be true
    assert_eq!(saved["secondFired"], true, "Second timer with duplicate key should have executed");
    // clearedFired MUST be false
    assert_eq!(saved["clearedFired"], false, "Explicitly cleared timer should not fire");
    // flushedFired MUST be true
    assert_eq!(saved["flushedFired"], true, "Flushed timer should have executed");

    let _ = fs::remove_dir_all(&data);
}

#[test]
fn test_save_debounced_with_rust_timers() {
    let data = temp_dir("debounce_save");
    let mut engine = AddonEngine::new(None, Some(data.clone()), None);

    const SCRIPT: &str = r#"
    const addon = Entropy.Addon.register({
        name: "Debounce Save Test",
        version: "1",
        description: "",
        author: [],
        category: "Test",
        capabilities: { ui: false, needsViewport: false }
    });

    addon.onInit(() => {
        // Rapid succession saves: only the last data should be saved
        addon.IO.saveDebounced({ count: 1 }, 20);
        addon.IO.saveDebounced({ count: 2 }, 20);
        addon.IO.saveDebounced({ count: 3 }, 20);
    });
    "#;

    engine.load_bundle_sync("debounce_save.js", SCRIPT).expect("the script runs");

    // Before timer expiration, file should not exist yet
    assert!(!data.join("Debounce Save Test.json").exists(), "File should not exist before timer expiration");

    // Wait for debounce delay
    thread::sleep(Duration::from_millis(35));
    engine.run_expired_timers();

    // Now file should exist with count = 3
    let saved: serde_json::Value = serde_json::from_slice(
        &fs::read(data.join("Debounce Save Test.json")).expect("saved file exists after expiration")
    ).unwrap();
    assert_eq!(saved["count"], 3, "Debounced save should preserve the final batched state");

    let _ = fs::remove_dir_all(&data);
}

#[test]
fn test_debounce_function_with_rust_timers() {
    let data = temp_dir("debounce_fn");
    let mut engine = AddonEngine::new(None, Some(data.clone()), None);

    const SCRIPT: &str = r#"
    const addon = Entropy.Addon.register({
        name: "Debounce Fn Test",
        version: "1",
        description: "",
        author: [],
        category: "Test",
        capabilities: { ui: false, needsViewport: false }
    });

    let calls = 0;
    const debouncedFn = Entropy.debounce((val) => {
        calls += val;
        addon.IO.save({ calls });
    }, 20);

    addon.onInit(() => {
        debouncedFn(1);
        debouncedFn(2);
        debouncedFn(10);
    });
    "#;

    engine.load_bundle_sync("debounce_fn.js", SCRIPT).expect("the script runs");

    assert!(!data.join("Debounce Fn Test.json").exists(), "Debounced function should not fire synchronously");

    thread::sleep(Duration::from_millis(35));
    engine.run_expired_timers();

    let saved: serde_json::Value = serde_json::from_slice(
        &fs::read(data.join("Debounce Fn Test.json")).expect("saved file exists")
    ).unwrap();
    // Only the last call (val = 10) should have executed
    assert_eq!(saved["calls"], 10, "Debounced function should execute only once with the latest argument");

    let _ = fs::remove_dir_all(&data);
}
