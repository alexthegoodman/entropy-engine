//! The browser entry point. The page loads the engine's WASM and calls `start(app, canvasId)`;
//! everything after that is Rust and the app's Rhai script. Apps are compiled into the WASM
//! ([`super::apps`]), so the page never hands the engine code to run.

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

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
