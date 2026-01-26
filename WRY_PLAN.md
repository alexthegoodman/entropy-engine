# Wry Implementation Strategy

We need to embed Wry for a Lexical RTE in this native Rust app, particularly the Sophia / Writing workspace. It will need to pass initial markdown in, and collect it out.

The architectural strategy is **"The Overlay Approach."** Since `wry` creates a native OS webview (which has its own HWND/NSView/XID), it cannot be rendered *inside* the `wgpu` render pass (like a texture). Instead, it sits **on top** of your `wgpu` window.

You must manually synchronize the webview's position and size with a specific "placeholder" rectangle in your `egui` layout.

### The Architecture

1. **Windowing:** Use `winit` (or `tao`) to create the main window.
2. **Webview:** Use `wry::WebViewBuilder::build_as_child(&window)` to attach the webview to the main window.
3. **Layout Sync:** In your `egui` update loop, calculate the screen coordinates of the UI area where you want the webview to appear. Pass these coordinates to `webview.set_bounds()`.
4. **Communication:**
* **In (Rust  JS):** Use `webview.evaluate_script()`.
* **Out (JS  Rust):** Use `webview.with_ipc_handler()`.