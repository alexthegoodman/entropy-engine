// The prelude of a game translated from TypeScript by scripts/ts2rhai.mjs: it stands in for the
// parts of the TypeScript `Entropy` API that register callbacks (an addon's lifecycle hooks, input
// listeners, MCP tools) and connects them to the Rhai host's entry points (init, update, on_*).
// The generated script's module state lives in `G::__V`, created here; `__module_init()` (in the
// generated script) fills it, as running the TypeScript bundle's top level would.

const __V = obj();

fn init() {
    G::__V.__hooks = obj(#{
        init: list(), update: list(), keyDown: list(), keyUp: list(), mouseDown: list(), mouseUp: list(),
        mouseMove: list(), mouseWheel: list(), gamepadButton: list(), gamepadAxis: list(),
    });
    G::__V.__tools = obj();
    __module_init();
    for f in G::__V.__hooks.init { f.call(); }
}

fn update(dt) {
    for f in G::__V.__hooks.update { f.call(); }
}

fn on_key_down(k) { for f in G::__V.__hooks.keyDown { f.call(k); } }
fn on_key_up(k) { for f in G::__V.__hooks.keyUp { f.call(k); } }
fn on_mouse_down(b, x, y) { for f in G::__V.__hooks.mouseDown { f.call(b.to_float(), x, y); } }
fn on_mouse_up(b, x, y) { for f in G::__V.__hooks.mouseUp { f.call(b.to_float()); } }
fn on_mouse_move(x, y) { for f in G::__V.__hooks.mouseMove { f.call(x, y); } }
fn on_mouse_wheel(dx, dy) { for f in G::__V.__hooks.mouseWheel { f.call(dx, dy); } }
fn on_gamepad_button(b, down) { for f in G::__V.__hooks.gamepadButton { f.call(b, down); } }
fn on_gamepad_axis(l, r, t) { for f in G::__V.__hooks.gamepadAxis { f.call(list(l), list(r), list(t)); } }

fn __hook(kind, f) { G::__V.__hooks[kind].push(f); }
fn __hook_init(f) { __hook("init", f); }
fn __hook_update(name, f) { __hook("update", f); }
fn __hook_update1(f) { __hook("update", f); }
fn __hook_key_down(f) { __hook("keyDown", f); }
fn __hook_key_up(f) { __hook("keyUp", f); }
fn __hook_mouse_down(f) { __hook("mouseDown", f); }
fn __hook_mouse_up(f) { __hook("mouseUp", f); }
fn __hook_mouse_move(f) { __hook("mouseMove", f); }
fn __hook_mouse_wheel(f) { __hook("mouseWheel", f); }
fn __hook_gamepad_button(f) { __hook("gamepadButton", f); }
fn __hook_gamepad_axis(f) { __hook("gamepadAxis", f); }

/// `Entropy.Addon.register` / `AddonAtom.register`: the addon object, with its UI drawing API.
fn __addon_register(meta) {
    obj(#{
        name: meta.name,
        UI: obj(#{
            clear: || Entropy::UI::clear(),
            drawRect: |c| Entropy::UI::drawRect(js_plain(c)),
            drawText: |c| Entropy::UI::drawText(js_plain(c)),
        }),
    })
}

fn __tool_register(def, f) {
    G::__V.__tools[def.name] = f;
    Entropy::registerTool(def.name, def.description ?? "");
}

fn __call_tool(name, args) {
    let f = G::__V.__tools[name];
    if js_is_nullish(f) { return obj(#{ success: false, error: "no tool " + name }); }
    f.call(args)
}

fn __window_size() {
    let s = Entropy::Window::getSize();
    list([s[0].to_float(), s[1].to_float()])
}

fn __store_read(path) {
    Entropy::Store::read(path)
}
