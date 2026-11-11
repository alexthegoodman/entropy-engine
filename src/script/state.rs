//! What scripts change, shared between the Rhai host (which writes it) and the app (which applies
//! it to the GPU, the window and the speakers once per frame).
//!
//! Calls that create something answer at once with an id (as the TypeScript API does) and queue
//! the GPU work as a [`GpuCommand`]; the renderer applies the queue in order before it draws, so a
//! script may create a buffer, write it and spawn a mesh on it in one frame.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use super::audio::NoteParams;
use super::store::Store;

/// The `mesh` vertex layout: position, normal, uv, color (12 floats).
pub const VERTEX_FLOATS: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BindingKind {
    Uniform,
    StorageRead,
}

#[derive(Clone, Debug)]
pub struct BindingEntryDef {
    pub binding: u32,
    pub vertex: bool,
    pub fragment: bool,
    pub kind: BindingKind,
}

#[derive(Clone, Debug, Default)]
pub struct PipelineDesc {
    pub name: String,
    pub vertex_shader: Option<String>,
    pub fragment_shader: Option<String>,
    /// Bind groups after camera (0) and model (1), numbered from 2.
    pub extra_groups: Vec<Vec<BindingEntryDef>>,
    pub transparent: bool,
    pub additive: bool,
    pub double_sided: bool,
}

/// CPU-side geometry: `VERTEX_FLOATS` floats per vertex and triangle-list indices.
#[derive(Clone, Debug, Default)]
pub struct MeshData {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct MeshBinding {
    pub group: u32,
    pub binding: u32,
    pub buffer: String,
}

#[derive(Clone, Debug)]
pub enum GpuCommand {
    CreatePipeline { id: String, desc: PipelineDesc },
    CreateBuffer { id: String, size: u64, storage: bool },
    WriteBuffer { id: String, offset: u64, data: Vec<u8> },
    DestroyBuffer { id: String },
    CreateMesh { id: String, mesh: Rc<MeshData>, pipeline: String, instances: u32, bindings: Vec<MeshBinding> },
    ClearMesh { id: String },
    SetInstanceCount { id: String, count: u32 },
    SetBounds { id: String, bounds: Option<([f32; 3], f32)> },
}

#[derive(Clone, Copy, Debug)]
pub struct CameraState {
    pub position: [f32; 3],
    pub target: [f32; 3],
    pub up: [f32; 3],
    /// Vertical field of view in degrees.
    pub fov: f32,
}

impl Default for CameraState {
    fn default() -> Self {
        Self { position: [0.0, 0.0, 5.0], target: [0.0, 0.0, 0.0], up: [0.0, 1.0, 0.0], fov: 60.0 }
    }
}

#[derive(Clone, Debug)]
pub struct UiRect {
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub color: [f32; 4],
    pub stroke: f32,
    pub stroke_color: [f32; 4],
}

#[derive(Clone, Debug)]
pub struct UiText {
    pub text: String,
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub font_size: f32,
    pub color: [f32; 4],
    pub font: String,
    pub background: [f32; 4],
}

/// The retained UI: kept until a script clears it. The engine draws every rect, then every text
/// (each text's background right before it), as Studio's UI layer does.
#[derive(Default, Debug)]
pub struct UiState {
    pub rects: Vec<UiRect>,
    pub texts: Vec<UiText>,
    /// Bumped on every change, so the renderer rebuilds its vertices only then.
    pub version: u64,
}

#[derive(Clone, Debug)]
pub enum InputEvent {
    KeyDown(String),
    KeyUp(String),
    MouseDown { button: u32, x: f32, y: f32 },
    MouseUp { button: u32, x: f32, y: f32 },
    MouseMove { x: f32, y: f32 },
    MouseWheel { dx: f32, dy: f32 },
    GamepadButton { button: String, pressed: bool },
    GamepadAxis { left: [f32; 2], right: [f32; 2], triggers: [f32; 2] },
}

/// An addon-registered tool (the MCP tools of the Deno host): tests and embedders call it by name.
#[derive(Clone, Debug)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
}

pub struct EngineState {
    serial: u64,
    pub commands: Vec<GpuCommand>,
    pub mesh_cache: HashMap<String, Rc<MeshData>>,
    pub camera: CameraState,
    pub ui: UiState,
    pub window_size: [u32; 2],
    pub clear_color: [f64; 4],
    pub input: VecDeque<InputEvent>,
    pub notes: Vec<(String, NoteParams, f32)>,
    pub store: Store,
    pub log: Vec<String>,
    /// Seconds since the app started.
    pub time: f64,
    pub frame: u64,
    /// Set by a script to ask the app to quit (native) or stop the loop (web).
    pub quit: bool,
    pub tools: Vec<ToolInfo>,
}

pub type Shared = Rc<RefCell<EngineState>>;

impl EngineState {
    pub fn new(store: Store) -> Self {
        Self {
            serial: 0,
            commands: Vec::new(),
            mesh_cache: HashMap::new(),
            camera: CameraState::default(),
            ui: UiState::default(),
            window_size: [1280, 720],
            clear_color: [0.0, 0.0, 0.0, 1.0],
            input: VecDeque::new(),
            notes: Vec::new(),
            store,
            log: Vec::new(),
            time: 0.0,
            frame: 0,
            quit: false,
            tools: Vec::new(),
        }
    }

    pub fn shared(store: Store) -> Shared {
        Rc::new(RefCell::new(Self::new(store)))
    }

    pub fn next_id(&mut self, prefix: &str) -> String {
        self.serial += 1;
        format!("{prefix}-{}", self.serial)
    }

    pub fn cache_key(namespace: &str, key: &str) -> String {
        format!("{namespace}/{key}")
    }

    pub fn println(&mut self, line: String) {
        log::info!("{line}");
        #[cfg(not(target_arch = "wasm32"))]
        println!("{line}");
        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(&line.clone().into());
        self.log.push(line);
        if self.log.len() > 200 {
            self.log.drain(..100);
        }
    }
}
