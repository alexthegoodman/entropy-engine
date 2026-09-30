//! Tests for addon floating window stacking order and click-to-raise.
//!
//! Verifies:
//! 1. Windows are tracked in creation order (stable across runs, not sorted by random UUID).
//! 2. `creation_order` is recorded on `UiWindowConfig`.
//! 3. `Entropy.UI.setWindowVisible(id, true)` raises the window to the top of `window_order`.

use entropy_engine::deno::addon_engine::AddonEngine;

const SCRIPT: &str = r#"
const addon = Entropy.Addon.register({
    name: "WindowStackingTest",
    version: "1.0.0",
    description: "Tests window stacking order",
    author: [],
    category: "Test",
    capabilities: { ui: false, needsViewport: false }
});

globalThis.win1 = null;
globalThis.win2 = null;
globalThis.win3 = null;

addon.onInit(() => {
    globalThis.win1 = Entropy.UI.createWindow({ title: "FirstWindow", onRender: () => {} });
    globalThis.win2 = Entropy.UI.createWindow({ title: "SecondWindow", onRender: () => {} });
    globalThis.win3 = Entropy.UI.createWindow({ title: "ThirdWindow", onRender: () => {} });
});
"#;

#[test]
fn addon_windows_preserve_creation_order_and_raise_on_visibility() {
    let mut engine = AddonEngine::new(None, None, None);
    engine.load_bundle_sync("window_stacking_test.js", SCRIPT).expect("the script runs");

    let (id1, id2, id3) = {
        let op_state = engine.runtime.op_state();
        let op_state = op_state.borrow();
        let ctx = op_state.borrow::<entropy_engine::deno::addon_ops::AddonContext>();

        // 1. Verify window_order has 3 windows in creation order
        assert_eq!(ctx.window_order.len(), 3);
        let id1 = ctx.window_order[0].clone();
        let id2 = ctx.window_order[1].clone();
        let id3 = ctx.window_order[2].clone();

        assert_eq!(ctx.ui_windows[&id1].0.title, "FirstWindow");
        assert_eq!(ctx.ui_windows[&id2].0.title, "SecondWindow");
        assert_eq!(ctx.ui_windows[&id3].0.title, "ThirdWindow");

        // 2. Verify creation_order on configs
        assert_eq!(ctx.ui_windows[&id1].0.creation_order, 0);
        assert_eq!(ctx.ui_windows[&id2].0.creation_order, 1);
        assert_eq!(ctx.ui_windows[&id3].0.creation_order, 2);

        (id1, id2, id3)
    };

    // 3. Call Entropy.UI.setWindowVisible(win1, true) from JS - raises win1 to top of window_order
    engine.runtime.execute_script("raise_win1.js", "Entropy.UI.setWindowVisible(globalThis.win1, true);").expect("execute setWindowVisible");

    {
        let op_state = engine.runtime.op_state();
        let op_state = op_state.borrow();
        let ctx = op_state.borrow::<entropy_engine::deno::addon_ops::AddonContext>();
        assert_eq!(ctx.window_order, vec![id2.clone(), id3.clone(), id1.clone()]);
        assert_eq!(ctx.window_order.last().unwrap(), &id1);
    }

    // 4. Call Entropy.UI.setWindowVisible(win2, true) from JS - raises win2 to top of window_order
    engine.runtime.execute_script("raise_win2.js", "Entropy.UI.setWindowVisible(globalThis.win2, true);").expect("execute setWindowVisible");

    {
        let op_state = engine.runtime.op_state();
        let op_state = op_state.borrow();
        let ctx = op_state.borrow::<entropy_engine::deno::addon_ops::AddonContext>();
        assert_eq!(ctx.window_order, vec![id3.clone(), id1.clone(), id2.clone()]);
        assert_eq!(ctx.window_order.last().unwrap(), &id2);
    }
}
