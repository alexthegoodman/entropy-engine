//! The window and the frame loop around a Rhai [`Host`]: winit for the window and input (a
//! canvas in a browser), wgpu for drawing (WebGPU in a browser), gilrs for gamepads, cpal for
//! sound.
//!
//! ```no_run
//! entropy_engine::script::ScriptApp::new("my-game")
//!     .with_title("My Game")
//!     .with_script("main.rhai", include_str!("main.rhai"))
//!     .run()
//!     .expect("couldn't run");
//! ```
//!
//! Natively, `ENTROPY_SCRIPT_DRIVE` names a JSON file of steps that drive the app for a test
//! (see [`DriveStep`]): call a script's tools, press keys, capture PNG screenshots, then exit.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use web_time::Instant;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

use super::audio::Audio;
use super::gpu::Gpu;
use super::host::Host;
use super::state::{EngineState, InputEvent, Shared};
use super::store::Store;
use rhai::Dynamic;

/// Frame timing, for tuning: milliseconds per frame in the script (input callbacks and `update`)
/// and in building the frame for the GPU, smoothed. In a browser, `stats()` returns it as JSON.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct FrameStats {
    pub frames: u64,
    pub script_ms: f64,
    pub render_ms: f64,
    pub frame_ms: f64,
}

thread_local! {
    pub static STATS: std::cell::Cell<FrameStats> = std::cell::Cell::new(FrameStats::default());
}

fn smooth(old: f64, new: f64) -> f64 {
    if old == 0.0 { new } else { old * 0.9 + new * 0.1 }
}

/// A script's files, compiled in this order into one script.
pub type ScriptSources = Vec<(String, String)>;

pub struct ScriptApp {
    name: String,
    title: String,
    size: (f64, f64),
    sources: ScriptSources,
    #[cfg(not(target_arch = "wasm32"))]
    data_dir: Option<std::path::PathBuf>,
    #[cfg(target_arch = "wasm32")]
    canvas_id: String,
}

impl ScriptApp {
    /// `name` keys the app's store (a data folder natively, `localStorage` in a browser).
    pub fn new(name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            title: name.clone(),
            name,
            size: (1280.0, 720.0),
            sources: Vec::new(),
            #[cfg(not(target_arch = "wasm32"))]
            data_dir: None,
            #[cfg(target_arch = "wasm32")]
            canvas_id: "entropy-canvas".into(),
        }
    }

    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = title.into();
        self
    }

    pub fn with_window_size(mut self, w: f64, h: f64) -> Self {
        self.size = (w, h);
        self
    }

    /// Adds a script file. Files are compiled in the order added and combined into one script.
    pub fn with_script(mut self, name: impl Into<String>, source: impl Into<String>) -> Self {
        self.sources.push((name.into(), source.into()));
        self
    }

    pub fn with_scripts(mut self, sources: ScriptSources) -> Self {
        self.sources.extend(sources);
        self
    }

    /// Where the app's store keeps its documents (natively). Without it, writes fail.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn with_data_dir(mut self, dir: impl Into<std::path::PathBuf>) -> Self {
        self.data_dir = Some(dir.into());
        self
    }

    /// The id of the `<canvas>` to draw into (default `entropy-canvas`); made if missing.
    #[cfg(target_arch = "wasm32")]
    pub fn with_canvas_id(mut self, id: impl Into<String>) -> Self {
        self.canvas_id = id.into();
        self
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn run(self) -> Result<(), Box<dyn std::error::Error>> {
        let store = Store::new(self.data_dir.clone(), &self.name);
        let drive = match std::env::var("ENTROPY_SCRIPT_DRIVE") {
            Ok(path) => Some(Drive::load(&path)?),
            Err(_) => None,
        };
        let event_loop = EventLoop::new()?;
        let mut app = App::new(self, store);
        app.drive = drive;
        event_loop.run_app(&mut app)?;
        if let Some(code) = app.exit_code {
            if code != 0 {
                return Err(format!("script app exited with errors: {}", app.host.as_ref().map(|h| h.errors.join("; ")).unwrap_or_default()).into());
            }
        }
        Ok(())
    }

    /// Starts the app in the page (returns at once; the browser drives the loop).
    #[cfg(target_arch = "wasm32")]
    pub fn run(self) -> Result<(), String> {
        use winit::platform::web::EventLoopExtWebSys;
        let store = Store::new(&self.name);
        let event_loop = EventLoop::new().map_err(|e| e.to_string())?;
        event_loop.spawn_app(App::new(self, store));
        Ok(())
    }
}

/// One step of a native test drive (`ENTROPY_SCRIPT_DRIVE`), run at the start of `frame`.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveStep {
    pub frame: u64,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub args: Option<serde_json::Value>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub down: Option<bool>,
    #[serde(default)]
    pub capture: Option<String>,
    #[serde(default)]
    pub exit: bool,
}

#[cfg(not(target_arch = "wasm32"))]
struct Drive {
    steps: Vec<DriveStep>,
    /// Every tool result, written as JSON lines to `ENTROPY_SCRIPT_DRIVE_OUT` when set.
    results: Vec<serde_json::Value>,
}

#[cfg(not(target_arch = "wasm32"))]
impl Drive {
    fn load(path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let steps: Vec<DriveStep> = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        Ok(Self { steps, results: Vec::new() })
    }
}

struct Surface {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
}

struct App {
    config: ScriptApp,
    store: Option<Store>,
    state: Shared,
    window: Option<Arc<Window>>,
    gpu: Rc<RefCell<Option<(Gpu, Surface)>>>,
    host: Option<Host>,
    audio: Audio,
    gilrs: Option<gilrs::Gilrs>,
    started: Instant,
    last: Option<Instant>,
    cursor: (f32, f32),
    /// Device pixels per window pixel (a HiDPI browser window).
    scale: f64,
    #[cfg(not(target_arch = "wasm32"))]
    drive: Option<Drive>,
    exit_code: Option<i32>,
    failed: Option<String>,
}

fn key_name(key: &Key) -> Option<String> {
    match key {
        Key::Character(c) => Some(c.to_string()),
        Key::Named(n) => Some(
            match n {
                NamedKey::Enter => "Enter",
                NamedKey::ArrowUp => "ArrowUp",
                NamedKey::ArrowDown => "ArrowDown",
                NamedKey::ArrowLeft => "ArrowLeft",
                NamedKey::ArrowRight => "ArrowRight",
                NamedKey::Space => " ",
                NamedKey::Delete => "Delete",
                NamedKey::Escape => "Escape",
                NamedKey::Tab => "Tab",
                NamedKey::Backspace => "Backspace",
                NamedKey::Shift => "Shift",
                NamedKey::Control => "Control",
                NamedKey::Alt => "Alt",
                _ => return None,
            }
            .to_string(),
        ),
        _ => None,
    }
}

fn gamepad_name(b: gilrs::Button) -> Option<&'static str> {
    use gilrs::Button::*;
    Some(match b {
        South => "South",
        East => "East",
        North => "North",
        West => "West",
        DPadUp => "DPadUp",
        DPadDown => "DPadDown",
        DPadLeft => "DPadLeft",
        DPadRight => "DPadRight",
        Start => "Start",
        Select => "Select",
        LeftThumb => "LeftThumb",
        RightThumb => "RightThumb",
        RightTrigger2 => "RightTrigger2",
        LeftTrigger2 => "LeftTrigger2",
        LeftTrigger => "LeftTrigger",
        RightTrigger => "RightTrigger",
        _ => return None,
    })
}

fn pick_format(caps: &wgpu::SurfaceCapabilities) -> wgpu::TextureFormat {
    // Scripts' shaders write display values themselves, as Studio's swapchain expects: no sRGB.
    caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0])
}

impl App {
    fn new(config: ScriptApp, store: Store) -> Self {
        let state = EngineState::shared(Store::none());
        Self {
            config,
            store: Some(store),
            state,
            window: None,
            gpu: Rc::new(RefCell::new(None)),
            host: None,
            audio: Audio::new(),
            gilrs: gilrs::Gilrs::new().ok(),
            started: Instant::now(),
            last: None,
            cursor: (0.0, 0.0),
            scale: 1.0,
            #[cfg(not(target_arch = "wasm32"))]
            drive: None,
            exit_code: None,
            failed: None,
        }
    }

    fn logical(&self, physical: [u32; 2]) -> [u32; 2] {
        [((physical[0] as f64 / self.scale).round() as u32).max(1), ((physical[1] as f64 / self.scale).round() as u32).max(1)]
    }

    fn start_host(&mut self) {
        if self.host.is_some() || self.failed.is_some() {
            return;
        }
        if let Some(store) = self.store.take() {
            self.state.borrow_mut().store = store;
        }
        match Host::new(self.state.clone(), &self.config.sources) {
            Ok(h) => self.host = Some(h),
            Err(e) => {
                let msg = format!("[script] failed to start: {e}");
                self.state.borrow_mut().println(msg.clone());
                self.show_error(&msg);
                self.failed = Some(msg);
            }
        }
    }

    /// Puts a fatal script error on screen (the console is not where a player looks).
    fn show_error(&mut self, msg: &str) {
        let mut s = self.state.borrow_mut();
        let size = s.window_size;
        s.ui.rects.clear();
        s.ui.texts.clear();
        s.ui.texts.push(super::state::UiText {
            text: msg.to_string(),
            pos: [24.0, 24.0],
            size: [size[0] as f32 - 48.0, size[1] as f32 - 48.0],
            font_size: 16.0,
            color: [1.0, 0.5, 0.45, 1.0],
            font: "Play".into(),
            background: [0.08, 0.02, 0.03, 0.92],
        });
        s.ui.version += 1;
    }

    fn input(&mut self, e: InputEvent) {
        // A browser opens audio only from a gesture.
        if matches!(e, InputEvent::KeyDown(_) | InputEvent::MouseDown { .. } | InputEvent::GamepadButton { pressed: true, .. }) {
            self.audio.start();
        }
        self.state.borrow_mut().input.push_back(e);
    }

    fn dispatch_input(&mut self) {
        let events: Vec<InputEvent> = self.state.borrow_mut().input.drain(..).collect();
        let Some(host) = self.host.as_mut() else { return };
        let fl = |v: f32| Dynamic::from_float(v as f64);
        let pair = |v: [f32; 2]| Dynamic::from_array(vec![fl(v[0]), fl(v[1])]);
        for e in events {
            match e {
                InputEvent::KeyDown(k) => host.call("on_key_down", vec![k.into()]),
                InputEvent::KeyUp(k) => host.call("on_key_up", vec![k.into()]),
                InputEvent::MouseDown { button, x, y } => host.call("on_mouse_down", vec![(button as i64).into(), fl(x), fl(y)]),
                InputEvent::MouseUp { button, x, y } => host.call("on_mouse_up", vec![(button as i64).into(), fl(x), fl(y)]),
                InputEvent::MouseMove { x, y } => host.call("on_mouse_move", vec![fl(x), fl(y)]),
                InputEvent::MouseWheel { dx, dy } => host.call("on_mouse_wheel", vec![fl(dx), fl(dy)]),
                InputEvent::GamepadButton { button, pressed } => host.call("on_gamepad_button", vec![button.into(), pressed.into()]),
                InputEvent::GamepadAxis { left, right, triggers } => host.call("on_gamepad_axis", vec![pair(left), pair(right), pair(triggers)]),
            };
        }
    }

    fn poll_gamepad(&mut self) {
        let Some(gilrs) = self.gilrs.as_mut() else { return };
        let mut events = Vec::new();
        while let Some(gilrs::Event { event, .. }) = gilrs.next_event() {
            match event {
                gilrs::EventType::ButtonPressed(b, _) => {
                    if let Some(n) = gamepad_name(b) {
                        events.push(InputEvent::GamepadButton { button: n.into(), pressed: true });
                    }
                }
                gilrs::EventType::ButtonReleased(b, _) => {
                    if let Some(n) = gamepad_name(b) {
                        events.push(InputEvent::GamepadButton { button: n.into(), pressed: false });
                    }
                }
                _ => {}
            }
        }
        if let Some((_, pad)) = gilrs.gamepads().next() {
            use gilrs::{Axis, Button};
            let trigger = |b: Button, a: Axis| pad.button_data(b).map(|d| d.value()).unwrap_or(0.0).max(pad.value(a).max(0.0)).clamp(0.0, 1.0);
            events.push(InputEvent::GamepadAxis {
                left: [pad.value(Axis::LeftStickX), pad.value(Axis::LeftStickY)],
                right: [pad.value(Axis::RightStickX), pad.value(Axis::RightStickY)],
                triggers: [trigger(Button::LeftTrigger2, Axis::LeftZ), trigger(Button::RightTrigger2, Axis::RightZ)],
            });
        }
        for e in events {
            self.input(e);
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn run_drive(&mut self, event_loop: &ActiveEventLoop) {
        let frame = self.state.borrow().frame;
        let Some(drive) = self.drive.as_mut() else { return };
        let due: Vec<DriveStep> = drive.steps.iter().filter(|s| s.frame == frame).cloned().collect();
        drive.steps.retain(|s| s.frame != frame);
        for step in due {
            if let (Some(tool), Some(host)) = (&step.tool, self.host.as_mut()) {
                let r = host.call_tool(tool, step.args.clone().unwrap_or(serde_json::json!({})));
                println!("[drive] frame {frame} {tool}: {r}");
                if let Some(d) = self.drive.as_mut() {
                    d.results.push(serde_json::json!({ "frame": frame, "tool": tool, "result": r }));
                }
            }
            if let Some(k) = &step.key {
                let e = if step.down.unwrap_or(true) { InputEvent::KeyDown(k.clone()) } else { InputEvent::KeyUp(k.clone()) };
                self.input(e);
            }
            if let Some(path) = &step.capture {
                self.capture(path);
            }
            if step.exit {
                if let (Ok(out), Some(d)) = (std::env::var("ENTROPY_SCRIPT_DRIVE_OUT"), self.drive.as_ref()) {
                    let lines: Vec<String> = d.results.iter().map(|r| r.to_string()).collect();
                    let _ = std::fs::write(out, lines.join("\n"));
                }
                let errors = self.host.as_ref().map(|h| h.errors.len()).unwrap_or(1) + self.failed.iter().count();
                self.exit_code = Some(if errors > 0 { 1 } else { 0 });
                event_loop.exit();
            }
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn capture(&mut self, path: &str) {
        let mut slot = self.gpu.borrow_mut();
        let Some((gpu, surface)) = slot.as_mut() else { return };
        let size = [surface.config.width, surface.config.height];
        let pixels = gpu.capture(&mut self.state.borrow_mut(), size);
        match image::RgbaImage::from_raw(size[0], size[1], pixels) {
            Some(img) => match img.save(path) {
                Ok(()) => println!("[drive] captured {path}"),
                Err(e) => println!("[drive] capture {path} failed: {e}"),
            },
            None => println!("[drive] capture {path} failed: bad size"),
        }
    }

    fn frame(&mut self, _event_loop: &ActiveEventLoop) {
        let now = Instant::now();
        let dt = self.last.map(|l| (now - l).as_secs_f64()).unwrap_or(1.0 / 60.0).clamp(0.0, 0.25);
        self.last = Some(now);
        let physical = {
            let mut slot = self.gpu.borrow_mut();
            let Some((gpu, s)) = slot.as_mut() else {
                return; // still waiting for the GPU (a browser grants it asynchronously)
            };
            // The window's size can change before the GPU is ready (a browser lays the canvas out
            // after the surface was made), so the surface follows the window every frame.
            if let Some(w) = &self.window {
                let size = w.inner_size();
                if size.width > 0 && size.height > 0 && (size.width != s.config.width || size.height != s.config.height) {
                    s.config.width = size.width;
                    s.config.height = size.height;
                    s.surface.configure(&gpu.device, &s.config);
                }
            }
            [s.config.width, s.config.height]
        };
        let logical = self.logical(physical);
        {
            let mut s = self.state.borrow_mut();
            s.window_size = logical;
            s.time = (now - self.started).as_secs_f64();
        }
        self.start_host();
        #[cfg(not(target_arch = "wasm32"))]
        self.run_drive(_event_loop);
        self.poll_gamepad();
        let script_start = Instant::now();
        self.dispatch_input();
        if let Some(h) = self.host.as_mut() {
            h.call("update", vec![Dynamic::from_float(dt)]);
        }
        let script_ms = script_start.elapsed().as_secs_f64() * 1000.0;
        let notes: Vec<_> = self.state.borrow_mut().notes.drain(..).collect();
        for (wave, p, pan) in notes {
            self.audio.play(&wave, p, pan);
        }
        let mut slot = self.gpu.borrow_mut();
        let Some((gpu, surface)) = slot.as_mut() else { return };
        let frame = match surface.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Outdated) | Err(wgpu::SurfaceError::Lost) => {
                surface.surface.configure(&gpu.device, &surface.config);
                return;
            }
            Err(e) => {
                log::warn!("surface: {e}");
                return;
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let render_start = Instant::now();
        gpu.render(&mut self.state.borrow_mut(), &view, logical, physical);
        let render_ms = render_start.elapsed().as_secs_f64() * 1000.0;
        frame.present();
        self.state.borrow_mut().frame += 1;
        STATS.with(|st| {
            let o = st.get();
            st.set(FrameStats { frames: o.frames + 1, script_ms: smooth(o.script_ms, script_ms), render_ms: smooth(o.render_ms, render_ms), frame_ms: smooth(o.frame_ms, dt * 1000.0) });
        });
    }

    fn init_gpu(&mut self, window: Arc<Window>) {
        let slot = self.gpu.clone();
        let size = window.inner_size();
        let fut = async move {
            let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
            let surface = match instance.create_surface(window.clone()) {
                Ok(s) => s,
                Err(e) => return Err(format!("no drawing surface: {e}")),
            };
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: Some(&surface), force_fallback_adapter: false })
                .await
                .map_err(|e| format!("no GPU adapter (does this browser support WebGPU?): {e}"))?;
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor { label: Some("entropy script"), required_limits: adapter.limits(), ..Default::default() })
                .await
                .map_err(|e| format!("no GPU device: {e}"))?;
            let caps = surface.get_capabilities(&adapter);
            let format = pick_format(&caps);
            let config = wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format,
                width: size.width.max(1),
                height: size.height.max(1),
                present_mode: wgpu::PresentMode::Fifo,
                alpha_mode: caps.alpha_modes[0],
                view_formats: vec![],
                desired_maximum_frame_latency: 2,
            };
            surface.configure(&device, &config);
            *slot.borrow_mut() = Some((Gpu::new(device, queue, format), Surface { surface, config }));
            window.request_redraw();
            Ok::<(), String>(())
        };
        #[cfg(not(target_arch = "wasm32"))]
        if let Err(e) = pollster::block_on(fut) {
            panic!("{e}");
        }
        #[cfg(target_arch = "wasm32")]
        {
            let state = self.state.clone();
            wasm_bindgen_futures::spawn_local(async move {
                if let Err(e) = fut.await {
                    state.borrow_mut().println(format!("[script] {e}"));
                    super::web::show_fatal(&e);
                }
            });
        }
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        #[allow(unused_mut)]
        let mut attrs = Window::default_attributes().with_title(self.config.title.clone());
        #[cfg(not(target_arch = "wasm32"))]
        {
            attrs = attrs.with_inner_size(winit::dpi::LogicalSize::new(self.config.size.0, self.config.size.1));
        }
        #[cfg(target_arch = "wasm32")]
        {
            use winit::platform::web::WindowAttributesExtWebSys;
            attrs = attrs.with_canvas(Some(super::web::canvas(&self.config.canvas_id))).with_prevent_default(true).with_focusable(true);
        }
        let window = Arc::new(event_loop.create_window(attrs).expect("couldn't create a window"));
        self.scale = if cfg!(target_arch = "wasm32") { window.scale_factor().max(1.0) } else { 1.0 };
        #[cfg(target_arch = "wasm32")]
        super::web::focus(&self.config.canvas_id);
        self.window = Some(window.clone());
        self.init_gpu(window);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                self.exit_code.get_or_insert(0);
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                if let Some((gpu, s)) = self.gpu.borrow_mut().as_mut() {
                    s.config.width = size.width.max(1);
                    s.config.height = size.height.max(1);
                    s.surface.configure(&gpu.device, &s.config);
                }
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                if cfg!(target_arch = "wasm32") {
                    self.scale = scale_factor.max(1.0);
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if let Some(k) = key_name(&event.logical_key) {
                    let e = if event.state == ElementState::Pressed { InputEvent::KeyDown(k) } else { InputEvent::KeyUp(k) };
                    self.input(e);
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                let (x, y) = ((position.x / self.scale) as f32, (position.y / self.scale) as f32);
                self.cursor = (x, y);
                self.input(InputEvent::MouseMove { x, y });
            }
            WindowEvent::MouseInput { state, button, .. } => {
                let b = match button {
                    MouseButton::Left => 0,
                    MouseButton::Right => 2,
                    MouseButton::Middle => 1,
                    MouseButton::Back => 3,
                    MouseButton::Forward => 4,
                    MouseButton::Other(n) => n as u32,
                };
                let (x, y) = self.cursor;
                self.input(if state == ElementState::Pressed { InputEvent::MouseDown { button: b, x, y } } else { InputEvent::MouseUp { button: b, x, y } });
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (x, y),
                    MouseScrollDelta::PixelDelta(p) => ((p.x / 20.0) as f32, (p.y / 20.0) as f32),
                };
                self.input(InputEvent::MouseWheel { dx, dy });
            }
            WindowEvent::RedrawRequested => {
                self.frame(event_loop);
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }
            _ => {}
        }
    }
}
