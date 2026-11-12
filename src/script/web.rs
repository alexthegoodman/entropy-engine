//! The browser entry point. The page loads the engine's WASM and calls `start(app, canvasId)`;
//! everything after that is Rust and the app's Rhai script. Apps are compiled into the WASM
//! ([`super::apps`]), so the page never hands the engine code to run.

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[global_allocator]
static ALLOCATOR: talc::TalckWasm = unsafe { talc::TalckWasm::new_global() };

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// The apps this build can start, by name.
#[wasm_bindgen]
pub fn apps() -> Vec<String> {
    super::apps::NAMES.iter().map(|s| s.to_string()).collect()
}

/// Starts `app` drawing into the canvas with id `canvas_id`.
#[wasm_bindgen]
pub fn start(app: &str, canvas_id: &str) -> Result<(), JsValue> {
    let Some(app) = super::apps::by_name(app) else {
        return Err(JsValue::from_str(&format!("no app {app:?}; this build has {:?}", super::apps::NAMES)));
    };
    app.with_canvas_id(canvas_id).run().map_err(|e| JsValue::from_str(&e))
}

/// Frame timing as JSON: `{frames, script_ms, render_ms, frame_ms}` (smoothed milliseconds).
#[wasm_bindgen]
pub fn stats() -> String {
    serde_json::to_string(&super::app::STATS.with(|s| s.get())).unwrap_or_default()
}

/// Runs an app's script headless for `frames` frames (no window, no GPU) and reports the median
/// and 90th-percentile milliseconds a frame: how fast the interpreter is in this browser.
#[wasm_bindgen]
pub fn bench_script(app: &str, frames: u32) -> Result<String, JsValue> {
    use super::state::{EngineState, InputEvent};
    let sources = match app {
        "nebula-kingdom" => super::apps::nebula_kingdom_sources(),
        "hello" => super::apps::hello_sources(),
        _ => return Err(JsValue::from_str("unknown app")),
    };
    let perf = web_sys::window().and_then(|w| w.performance());
    let now = || perf.as_ref().map(|p| p.now()).unwrap_or(0.0);
    let state = EngineState::shared(super::store::Store::none());
    state.borrow_mut().window_size = [1280, 720];
    let mut host = super::host::Host::new(state.clone(), &sources).map_err(|e| JsValue::from_str(&e))?;
    host.call_tool("nebula_start", serde_json::json!({ "region": "cradle" }));
    host.call("on_key_down", vec!["w".into()]);
    let mut times = Vec::new();
    for i in 0..frames {
        if i == frames / 2 {
            state.borrow_mut().input.push_back(InputEvent::MouseDown { button: 0, x: 640.0, y: 360.0 });
            host.call("on_mouse_down", vec![0i64.into(), rhai::Dynamic::from_float(640.0), rhai::Dynamic::from_float(360.0)]);
        }
        let t = now();
        host.call("update", vec![rhai::Dynamic::from_float(1.0 / 60.0)]);
        state.borrow_mut().commands.clear();
        state.borrow_mut().time += 1.0 / 60.0;
        times.push(now() - t);
    }
    times.sort_by(|a, b| a.total_cmp(b));
    let n = times.len().max(1);
    Ok(format!("{{\"median_ms\":{:.2},\"p90_ms\":{:.2},\"errors\":{}}}", times[n / 2], times[n * 9 / 10], host.errors.len()))
}

pub fn canvas(id: &str) -> web_sys::HtmlCanvasElement {
    let document = web_sys::window().and_then(|w| w.document()).expect("a document");
    if let Some(c) = document.get_element_by_id(id).and_then(|e| e.dyn_into::<web_sys::HtmlCanvasElement>().ok()) {
        return c;
    }
    let c: web_sys::HtmlCanvasElement = document.create_element("canvas").expect("a canvas").dyn_into().expect("a canvas element");
    c.set_id(id);
    document.body().expect("a body").append_child(&c).expect("canvas appended");
    c
}

pub fn focus(id: &str) {
    if let Some(c) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.get_element_by_id(id)).and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok()) {
        let _ = c.focus();
    }
}

/// Shows a fatal error in the page's `#entropy-status` element (WebGPU missing, mostly).
pub fn show_fatal(msg: &str) {
    if let Some(el) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.get_element_by_id("entropy-status")) {
        el.set_text_content(Some(msg));
        let _ = el.set_attribute("data-state", "error");
    }
}
