//! The Rhai host: one engine, one script (its files compiled and combined), one app object.
//!
//! A script is a set of functions and constants. The host calls these, each as a *method on the
//! app object* (so `this` is the app's state, kept between calls), and only if the script defines
//! them:
//!
//! | function | when |
//! |---|---|
//! | `init()` | once, after the script's top level ran |
//! | `update(dt)` | every frame, `dt` in seconds |
//! | `on_key_down(key)` / `on_key_up(key)` | keys, named as in TypeScript (`"w"`, `"ArrowUp"`, `" "`, `"Shift"`) |
//! | `on_mouse_down(button, x, y)` / `on_mouse_up(button, x, y)` / `on_mouse_move(x, y)` / `on_mouse_wheel(dx, dy)` | the pointer, in window pixels |
//! | `on_gamepad_button(name, down)` / `on_gamepad_axis(left, right, triggers)` | the first gamepad |
//!
//! The engine API lives in the `Entropy` module (`Entropy::Camera::setTransform(...)`), named
//! after the TypeScript `Entropy` object it mirrors; the fast helpers of [`super::rmath`] are
//! global functions.
//!
//! Sandbox: a script reaches nothing but what is registered here. Each call is capped in
//! operations, call depth and data sizes, so a runaway loop ends in an error instead of a hung
//! page, and an error in one callback is reported (once per message) without stopping the app.

use std::collections::HashSet;

use rhai::module_resolvers::DummyModuleResolver;
use rhai::{Array, CallFnOptions, Dynamic, Engine, FnPtr, ImmutableString, Map, Module, Scope, AST, FLOAT, INT};

use super::audio::NoteParams;
use super::rmath::{self, num, v3, Floats, RResult};
use super::state::{BindingEntryDef, BindingKind, EngineState, GpuCommand, MeshBinding, MeshData, PipelineDesc, Shared, ToolInfo, UiRect, UiText, VERTEX_FLOATS};

/// Operations one callback may run before it is stopped.
pub const MAX_OPERATIONS: u64 = 200_000_000;

pub struct Host {
    pub engine: Engine,
    ast: AST,
    scope: Scope<'static>,
    app: Dynamic,
    defined: HashSet<String>,
    reported: HashSet<String>,
    pub state: Shared,
    pub errors: Vec<String>,
}

fn s(m: &Map, k: &str) -> Option<String> {
    m.get(k).and_then(|v| v.clone().into_string().ok())
}
fn b(m: &Map, k: &str) -> bool {
    m.get(k).and_then(|v| v.as_bool().ok()).unwrap_or(false)
}
fn f(m: &Map, k: &str) -> Option<f64> {
    m.get(k).filter(|v| v.is_float() || v.is_int()).map(num)
}
fn arr(m: &Map, k: &str) -> Option<Array> {
    m.get(k).and_then(|v| v.clone().try_cast::<Array>())
}
fn color(a: Option<Array>, d: [f32; 4]) -> [f32; 4] {
    match a {
        Some(a) => [0, 1, 2, 3].map(|i| a.get(i).map(|v| num(v) as f32).unwrap_or(if i == 3 { 1.0 } else { 0.0 })),
        None => d,
    }
}
fn pair(a: Option<Array>) -> [f32; 2] {
    a.map(|a| [a.first().map(num).unwrap_or(0.0) as f32, a.get(1).map(num).unwrap_or(0.0) as f32]).unwrap_or([0.0, 0.0])
}
fn f3(a: &Array) -> [f32; 3] {
    let v = v3(a);
    [v[0] as f32, v[1] as f32, v[2] as f32]
}

/// Dynamic -> JSON (for `Json::stringify` and tool results).
pub fn to_json(v: &Dynamic) -> serde_json::Value {
    rhai::serde::from_dynamic::<serde_json::Value>(v).unwrap_or(serde_json::Value::Null)
}

pub fn from_json(v: &serde_json::Value) -> Dynamic {
    rhai::serde::to_dynamic(v).unwrap_or(Dynamic::UNIT)
}

fn mesh_from_map(m: &Map) -> RResult<MeshData> {
    let vertices: Vec<f32> = arr(m, "vertexData").ok_or("mesh needs vertexData")?.iter().map(|v| num(v) as f32).collect();
    let indices: Vec<u32> = arr(m, "indexData").ok_or("mesh needs indexData")?.iter().map(|v| num(v) as u32).collect();
    if vertices.len() % VERTEX_FLOATS != 0 {
        return Err(format!("vertexData must be {VERTEX_FLOATS} floats a vertex").into());
    }
    Ok(MeshData { vertices, indices })
}

/// The engine's own primitives (fast to build natively; a script would take seconds).
pub mod meshes {
    use super::MeshData;
    use std::collections::HashMap;

    fn pack(positions: &[[f32; 3]], normals: &[[f32; 3]], uvs: &[[f32; 2]], indices: Vec<u32>) -> MeshData {
        let mut vertices = Vec::with_capacity(positions.len() * 12);
        for i in 0..positions.len() {
            vertices.extend_from_slice(&positions[i]);
            vertices.extend_from_slice(&normals[i]);
            vertices.extend_from_slice(&uvs[i]);
            vertices.extend_from_slice(&[1.0, 1.0, 1.0, 1.0]);
        }
        MeshData { vertices, indices }
    }

    /// A unit icosphere subdivided `level` times; `inside` turns it to be seen from within.
    pub fn icosphere(level: u32, inside: bool) -> MeshData {
        let t = (1.0 + 5f64.sqrt()) / 2.0;
        let mut verts: Vec<[f64; 3]> = [[-1.0, t, 0.0], [1.0, t, 0.0], [-1.0, -t, 0.0], [1.0, -t, 0.0], [0.0, -1.0, t], [0.0, 1.0, t], [0.0, -1.0, -t], [0.0, 1.0, -t], [t, 0.0, -1.0], [t, 0.0, 1.0], [-t, 0.0, -1.0], [-t, 0.0, 1.0]]
            .iter()
            .map(|v| {
                let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                [v[0] / l, v[1] / l, v[2] / l]
            })
            .collect();
        let mut faces: Vec<[usize; 3]> = vec![[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
        for _ in 0..level.min(7) {
            let mut cache: HashMap<(usize, usize), usize> = HashMap::new();
            let mut next = Vec::with_capacity(faces.len() * 4);
            let mut mid = |a: usize, b: usize, verts: &mut Vec<[f64; 3]>| -> usize {
                let key = if a < b { (a, b) } else { (b, a) };
                if let Some(&i) = cache.get(&key) {
                    return i;
                }
                let m = [verts[a][0] + verts[b][0], verts[a][1] + verts[b][1], verts[a][2] + verts[b][2]];
                let l = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
                verts.push([m[0] / l, m[1] / l, m[2] / l]);
                cache.insert(key, verts.len() - 1);
                verts.len() - 1
            };
            for [a, b, c] in faces {
                let ab = mid(a, b, &mut verts);
                let bc = mid(b, c, &mut verts);
                let ca = mid(c, a, &mut verts);
                next.extend_from_slice(&[[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]);
            }
            faces = next;
        }
        let positions: Vec<[f32; 3]> = verts.iter().map(|v| [v[0] as f32, v[1] as f32, v[2] as f32]).collect();
        let normals: Vec<[f32; 3]> = positions.iter().map(|v| if inside { [-v[0], -v[1], -v[2]] } else { *v }).collect();
        let uvs: Vec<[f32; 2]> = verts
            .iter()
            .map(|v| [(v[2].atan2(v[0]) / (std::f64::consts::PI * 2.0) + 0.5) as f32, (v[1].asin() / std::f64::consts::PI + 0.5) as f32])
            .collect();
        let indices = faces.iter().flat_map(|&[a, b, c]| if inside { [a as u32, c as u32, b as u32] } else { [a as u32, b as u32, c as u32] }).collect();
        pack(&positions, &normals, &uvs, indices)
    }

    /// A quad from -1 to 1 in x and y, facing +z.
    pub fn quad() -> MeshData {
        pack(&[[-1.0, -1.0, 0.0], [1.0, -1.0, 0.0], [1.0, 1.0, 0.0], [-1.0, 1.0, 0.0]], &[[0.0, 0.0, 1.0]; 4], &[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]], vec![0, 1, 2, 0, 2, 3])
    }

    /// A cone: base of radius 1 at z = 0, apex at z = 1, with its base capped.
    pub fn cone(segments: u32) -> MeshData {
        let n = segments.max(3);
        let slope = std::f32::consts::FRAC_1_SQRT_2;
        let (mut p, mut nn, mut uv, mut idx) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for i in 0..n {
            let a0 = i as f32 / n as f32 * std::f32::consts::TAU;
            let a1 = (i + 1) as f32 / n as f32 * std::f32::consts::TAU;
            let am = (a0 + a1) / 2.0;
            let base = p.len() as u32;
            p.extend_from_slice(&[[a0.cos(), a0.sin(), 0.0], [a1.cos(), a1.sin(), 0.0], [0.0, 0.0, 1.0]]);
            nn.extend_from_slice(&[[a0.cos() * slope, a0.sin() * slope, slope], [a1.cos() * slope, a1.sin() * slope, slope], [am.cos() * slope, am.sin() * slope, slope]]);
            uv.extend_from_slice(&[[i as f32 / n as f32, 0.0], [(i + 1) as f32 / n as f32, 0.0], [(i as f32 + 0.5) / n as f32, 1.0]]);
            idx.extend_from_slice(&[base, base + 1, base + 2]);
            let cap = p.len() as u32;
            p.extend_from_slice(&[[0.0, 0.0, 0.0], [a1.cos(), a1.sin(), 0.0], [a0.cos(), a0.sin(), 0.0]]);
            nn.extend_from_slice(&[[0.0, 0.0, -1.0]; 3]);
            uv.extend_from_slice(&[[0.5, 0.5], [1.0, 1.0], [0.0, 1.0]]);
            idx.extend_from_slice(&[cap, cap + 1, cap + 2]);
        }
        pack(&p, &nn, &uv, idx)
    }
}

/// A mesh built in Rust, handed to `MeshCache.put` without a round trip through script arrays.
#[derive(Clone)]
pub struct MeshHandle(pub std::rc::Rc<MeshData>);

fn note_from_map(m: &Map) -> (String, NoteParams, f32) {
    let d = NoteParams::default();
    let g = |k: &str, v: f32| f(m, k).map(|x| x as f32).unwrap_or(v);
    let p = NoteParams {
        freq: g("freq", d.freq),
        duration: g("duration", d.duration),
        gain: g("gain", d.gain),
        attack: g("attack", d.attack),
        decay: g("decay", d.decay),
        sustain: g("sustain", d.sustain),
        release: g("release", d.release),
        cutoff: g("cutoff", d.cutoff),
        resonance: g("resonance", d.resonance),
        delay_time: g("delayTime", d.delay_time),
        delay_feedback: g("delayFeedback", d.delay_feedback),
        delay_mix: g("delayMix", d.delay_mix),
        reverb_mix: g("reverbMix", d.reverb_mix),
        reverb_room_size: g("reverbRoomSize", d.reverb_room_size),
        reverb_time: g("reverbTime", d.reverb_time),
        muffle: g("muffle", d.muffle),
    };
    (s(m, "waveform").unwrap_or_else(|| "sine".into()), p, g("pan", 0.0))
}

fn pipeline_from_map(m: &Map) -> PipelineDesc {
    let mut extra_groups = Vec::new();
    for g in arr(m, "extraBindGroups").unwrap_or_default() {
        let Some(g) = g.try_cast::<Map>() else { continue };
        let mut entries = Vec::new();
        for e in arr(&g, "entries").unwrap_or_default() {
            let Some(e) = e.try_cast::<Map>() else { continue };
            let vis: Vec<String> = arr(&e, "visibility").unwrap_or_default().into_iter().filter_map(|v| v.into_string().ok()).collect();
            let kind = match s(&e, "resourceType").as_deref() {
                Some("StorageReadOnly") | Some("Storage") => BindingKind::StorageRead,
                _ => BindingKind::Uniform,
            };
            entries.push(BindingEntryDef {
                binding: f(&e, "binding").unwrap_or(0.0) as u32,
                vertex: vis.iter().any(|v| v.eq_ignore_ascii_case("vertex")),
                fragment: vis.iter().any(|v| v.eq_ignore_ascii_case("fragment")),
                kind,
            });
        }
        extra_groups.push(entries);
    }
    PipelineDesc {
        name: s(m, "name").unwrap_or_else(|| "script pipeline".into()),
        vertex_shader: s(m, "vertexShader"),
        fragment_shader: s(m, "fragmentShader"),
        extra_groups,
        transparent: b(m, "transparent"),
        additive: b(m, "additive"),
        double_sided: b(m, "doubleSided"),
    }
}

fn bindings_from(list: Array) -> Vec<MeshBinding> {
    let mut out = Vec::new();
    for v in list {
        let Some(m) = v.try_cast::<Map>() else { continue };
        // {group, binding, buffer} or the TypeScript shape {group, binding, resource: {type: "Buffer", value: {id}}}.
        let buffer = s(&m, "buffer").or_else(|| {
            let r = m.get("resource")?.clone().try_cast::<Map>()?;
            let v = r.get("value")?.clone().try_cast::<Map>()?;
            s(&v, "id")
        });
        if let Some(buffer) = buffer {
            out.push(MeshBinding { group: f(&m, "group").unwrap_or(2.0) as u32, binding: f(&m, "binding").unwrap_or(0.0) as u32, buffer });
        }
    }
    out
}

fn register_api(engine: &mut Engine, state: &Shared) {
    let mut entropy = Module::new();

    {
        let st = state.clone();
        entropy.set_native_fn("println", move |text: Dynamic| {
            st.borrow_mut().println(text.to_string());
            Ok(())
        });
        // The TypeScript API's game-mode switch has nothing to switch here.
        entropy.set_native_fn("setGameMode", |_on: bool| Ok(()));
        let st = state.clone();
        entropy.set_native_fn("registerTool", move |name: ImmutableString, description: ImmutableString| {
            let mut s = st.borrow_mut();
            s.tools.retain(|t| t.name != name.as_str());
            s.tools.push(ToolInfo { name: name.to_string(), description: description.to_string() });
            Ok(())
        });
    }

    let mut window = Module::new();
    let st = state.clone();
    window.set_native_fn("getSize", move || {
        let s = st.borrow().window_size;
        Ok(vec![Dynamic::from_int(s[0] as INT), Dynamic::from_int(s[1] as INT)])
    });
    entropy.set_sub_module("Window", window);

    let mut time = Module::new();
    let st = state.clone();
    time.set_native_fn("now", move || Ok(st.borrow().time as FLOAT));
    let st = state.clone();
    time.set_native_fn("frame", move || Ok(st.borrow().frame as INT));
    entropy.set_sub_module("Time", time);

    let mut camera = Module::new();
    let st = state.clone();
    camera.set_native_fn("setTransform", move |pos: Array, target: Array, up: Array| {
        let mut s = st.borrow_mut();
        s.camera.position = f3(&pos);
        s.camera.target = f3(&target);
        s.camera.up = f3(&up);
        Ok(())
    });
    let st = state.clone();
    camera.set_native_fn("setFov", move |deg: FLOAT| {
        st.borrow_mut().camera.fov = if deg > 0.0 { deg as f32 } else { 60.0 };
        Ok(())
    });
    let st = state.clone();
    camera.set_native_fn("setFov", move |deg: INT| {
        st.borrow_mut().camera.fov = if deg > 0 { deg as f32 } else { 60.0 };
        Ok(())
    });
    entropy.set_sub_module("Camera", camera);

    let mut lighting = Module::new();
    let st = state.clone();
    lighting.set_native_fn("setClearColor", move |c: Array| {
        let c = color(Some(c), [0.0, 0.0, 0.0, 1.0]);
        st.borrow_mut().clear_color = c.map(|x| x as f64);
        Ok(())
    });
    // No deferred lighting here: the sun's horizon color clears the frame, the rest is ignored
    // (scripts light their own pipelines).
    let st = state.clone();
    lighting.set_native_fn("updateSun", move |m: Map| {
        if let Some(c) = arr(&m, "horizonColor") {
            let c = color(Some(c), [0.0, 0.0, 0.0, 1.0]);
            st.borrow_mut().clear_color = [c[0] as f64, c[1] as f64, c[2] as f64, 1.0];
        }
        Ok(())
    });
    entropy.set_sub_module("Lighting", lighting);

    let mut pipeline = Module::new();
    let st = state.clone();
    pipeline.set_native_fn("create", move |m: Map| {
        let mut s = st.borrow_mut();
        let id = s.next_id("pipeline");
        s.commands.push(GpuCommand::CreatePipeline { id: id.clone(), desc: pipeline_from_map(&m) });
        Ok(id)
    });
    entropy.set_sub_module("Pipeline", pipeline);

    let mut buffer = Module::new();
    let st = state.clone();
    buffer.set_native_fn("create", move |m: Map| {
        let size = f(&m, "size").unwrap_or(16.0).max(16.0) as u64;
        if size > 256 << 20 {
            return Err("Buffer.create: at most 256 MB".into());
        }
        let storage = matches!(s(&m, "usage").as_deref(), Some("Storage") | Some("StorageReadOnly"));
        let mut s = st.borrow_mut();
        let id = s.next_id("buffer");
        s.commands.push(GpuCommand::CreateBuffer { id: id.clone(), size, storage });
        Ok(id)
    });
    let st = state.clone();
    buffer.set_native_fn("write", move |id: ImmutableString, data: Floats| {
        let bytes = bytemuck::cast_slice(&data.0.borrow()).to_vec();
        st.borrow_mut().commands.push(GpuCommand::WriteBuffer { id: id.to_string(), offset: 0, data: bytes });
        Ok(())
    });
    let st = state.clone();
    buffer.set_native_fn("write", move |id: ImmutableString, data: Array| {
        let v: Vec<f32> = data.iter().map(|x| num(x) as f32).collect();
        st.borrow_mut().commands.push(GpuCommand::WriteBuffer { id: id.to_string(), offset: 0, data: bytemuck::cast_slice(&v).to_vec() });
        Ok(())
    });
    let st = state.clone();
    buffer.set_native_fn("destroy", move |id: ImmutableString| {
        st.borrow_mut().commands.push(GpuCommand::DestroyBuffer { id: id.to_string() });
        Ok(())
    });
    entropy.set_sub_module("Buffer", buffer);

    let mut mesh = Module::new();
    mesh.set_native_fn("icosphere", |level: INT, inside: bool| Ok(MeshHandle(std::rc::Rc::new(meshes::icosphere(level.clamp(0, 7) as u32, inside)))));
    mesh.set_native_fn("quad", || Ok(MeshHandle(std::rc::Rc::new(meshes::quad()))));
    mesh.set_native_fn("cone", |segments: INT| Ok(MeshHandle(std::rc::Rc::new(meshes::cone(segments.clamp(3, 256) as u32)))));
    mesh.set_native_fn("fromArrays", |m: Map| Ok(MeshHandle(std::rc::Rc::new(mesh_from_map(&m)?))));
    entropy.set_sub_module("Mesh", mesh);

    let mut cache = Module::new();
    let st = state.clone();
    cache.set_native_fn("status", move |ns: ImmutableString, key: ImmutableString| {
        Ok(if st.borrow().mesh_cache.contains_key(&EngineState::cache_key(&ns, &key)) { "ready" } else { "missing" }.to_string())
    });
    let st = state.clone();
    cache.set_native_fn("put", move |ns: ImmutableString, key: ImmutableString, m: MeshHandle| {
        st.borrow_mut().mesh_cache.insert(EngineState::cache_key(&ns, &key), m.0);
        Ok(())
    });
    let st = state.clone();
    cache.set_native_fn("put", move |ns: ImmutableString, key: ImmutableString, m: Map| {
        let mesh = mesh_from_map(&m)?;
        st.borrow_mut().mesh_cache.insert(EngineState::cache_key(&ns, &key), std::rc::Rc::new(mesh));
        Ok(())
    });
    let st = state.clone();
    cache.set_native_fn("createMesh", move |ns: ImmutableString, key: ImmutableString, m: Map| {
        let mut s = st.borrow_mut();
        let Some(mesh) = s.mesh_cache.get(&EngineState::cache_key(&ns, &key)).cloned() else { return Ok(false) };
        let id = s.clone_id(&m);
        let pipeline = self::s(&m, "pipelineId").unwrap_or_default();
        let instances = f(&m, "instanceCount").unwrap_or(1.0) as u32;
        let bindings = bindings_from(arr(&m, "bindings").unwrap_or_default());
        s.commands.push(GpuCommand::CreateMesh { id, mesh, pipeline, instances, bindings });
        Ok(true)
    });
    entropy.set_sub_module("MeshCache", cache);

    let mut model = Module::new();
    let st = state.clone();
    model.set_native_fn("clearMesh", move |id: ImmutableString| {
        st.borrow_mut().commands.push(GpuCommand::ClearMesh { id: id.to_string() });
        Ok(())
    });
    let st = state.clone();
    model.set_native_fn("setInstanceCount", move |id: ImmutableString, n: INT| {
        st.borrow_mut().commands.push(GpuCommand::SetInstanceCount { id: id.to_string(), count: n.max(0) as u32 });
        Ok(())
    });
    let st = state.clone();
    model.set_native_fn("setBounds", move |id: ImmutableString, center: Dynamic, radius: FLOAT| {
        let bounds = center.try_cast::<Array>().filter(|_| radius >= 0.0).map(|c| (f3(&c), radius as f32));
        st.borrow_mut().commands.push(GpuCommand::SetBounds { id: id.to_string(), bounds });
        Ok(())
    });
    entropy.set_sub_module("Model", model);

    let mut ui = Module::new();
    let st = state.clone();
    ui.set_native_fn("clear", move || {
        let mut s = st.borrow_mut();
        if !s.ui.rects.is_empty() || !s.ui.texts.is_empty() {
            s.ui.rects.clear();
            s.ui.texts.clear();
            s.ui.version += 1;
        }
        Ok(())
    });
    let st = state.clone();
    ui.set_native_fn("drawRect", move |m: Map| {
        let mut s = st.borrow_mut();
        s.ui.rects.push(UiRect {
            pos: pair(arr(&m, "position")),
            size: pair(arr(&m, "size")),
            color: color(arr(&m, "color"), [1.0; 4]),
            stroke: f(&m, "strokeThickness").unwrap_or(0.0) as f32,
            stroke_color: color(arr(&m, "strokeColor"), [0.0; 4]),
        });
        s.ui.version += 1;
        Ok(())
    });
    let st = state.clone();
    ui.set_native_fn("drawText", move |m: Map| {
        let mut s = st.borrow_mut();
        s.ui.texts.push(UiText {
            text: self::s(&m, "text").unwrap_or_default(),
            pos: pair(arr(&m, "position")),
            size: pair(arr(&m, "dimensions")),
            font_size: f(&m, "fontSize").unwrap_or(16.0) as f32,
            color: color(arr(&m, "color"), [1.0; 4]),
            font: self::s(&m, "fontFamily").unwrap_or_else(|| "Play".into()),
            background: color(arr(&m, "backgroundFill"), [0.0; 4]),
        });
        s.ui.version += 1;
        Ok(())
    });
    // Positional forms, cheaper than building a map per call.
    let st = state.clone();
    ui.set_native_fn("rect", move |x: FLOAT, y: FLOAT, w: FLOAT, h: FLOAT, c: Array| {
        let mut s = st.borrow_mut();
        s.ui.rects.push(UiRect { pos: [x as f32, y as f32], size: [w as f32, h as f32], color: color(Some(c), [1.0; 4]), stroke: 0.0, stroke_color: [0.0; 4] });
        s.ui.version += 1;
        Ok(())
    });
    let st = state.clone();
    ui.set_native_fn("rectStroked", move |x: FLOAT, y: FLOAT, w: FLOAT, h: FLOAT, c: Array, sw: FLOAT, sc: Array| {
        let mut s = st.borrow_mut();
        s.ui.rects.push(UiRect { pos: [x as f32, y as f32], size: [w as f32, h as f32], color: color(Some(c), [1.0; 4]), stroke: sw as f32, stroke_color: color(Some(sc), [0.0; 4]) });
        s.ui.version += 1;
        Ok(())
    });
    let st = state.clone();
    ui.set_native_fn("text", move |text: ImmutableString, x: FLOAT, y: FLOAT, w: FLOAT, h: FLOAT, size: FLOAT, c: Array, font: ImmutableString, bg: Array| {
        let mut s = st.borrow_mut();
        s.ui.texts.push(UiText { text: text.to_string(), pos: [x as f32, y as f32], size: [w as f32, h as f32], font_size: size as f32, color: color(Some(c), [1.0; 4]), font: font.to_string(), background: color(Some(bg), [0.0; 4]) });
        s.ui.version += 1;
        Ok(())
    });
    // Text width estimate is the script's own business; this measures it exactly.
    ui.set_native_fn("measure", |text: ImmutableString, size: FLOAT, font: ImmutableString| {
        let fonts = super::fonts::Fonts::get();
        let fnt = &fonts.fonts[super::fonts::Fonts::index(&font)];
        let w: f32 = text.chars().map(|c| fnt.metrics(c, size as f32).advance_width).sum();
        Ok(w as FLOAT)
    });
    entropy.set_sub_module("UI", ui);

    let mut audio = Module::new();
    let st = state.clone();
    audio.set_native_fn("playNote", move |m: Map| {
        let note = note_from_map(&m);
        let mut s = st.borrow_mut();
        if s.notes.len() < 256 {
            s.notes.push(note);
        }
        Ok(())
    });
    entropy.set_sub_module("Audio", audio);

    let mut store = Module::new();
    let st = state.clone();
    store.set_native_fn("read", move |path: ImmutableString| -> RResult<Dynamic> {
        match st.borrow().store.read(&path)? {
            Some(t) => Ok(t.into()),
            None => Ok(Dynamic::UNIT),
        }
    });
    let st = state.clone();
    store.set_native_fn("write", move |path: ImmutableString, text: ImmutableString| {
        if text.len() > 4 << 20 {
            return Err("Store.write: at most 4 MB a document".into());
        }
        st.borrow().store.write(&path, &text)?;
        Ok(())
    });
    let st = state.clone();
    store.set_native_fn("remove", move |path: ImmutableString| Ok(st.borrow().store.remove(&path)?));
    entropy.set_sub_module("Store", store);

    let mut json = Module::new();
    json.set_native_fn("parse", |text: ImmutableString| -> RResult<Dynamic> {
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Json.parse: {e}"))?;
        Ok(from_json(&v))
    });
    json.set_native_fn("stringify", |v: Dynamic| Ok(to_json(&v).to_string()));
    entropy.set_sub_module("Json", json);

    engine.register_static_module("Entropy", entropy.into());
    engine.register_type_with_name::<MeshHandle>("Mesh");
}

impl EngineState {
    fn clone_id(&mut self, m: &Map) -> String {
        s(m, "id").unwrap_or_else(|| self.next_id("mesh"))
    }
}

impl Host {
    /// Compiles `sources` (name, text) in order into one script and runs its top level.
    pub fn new(state: Shared, sources: &[(String, String)]) -> Result<Self, String> {
        let mut engine = Engine::new();
        engine.set_module_resolver(DummyModuleResolver::new());
        engine.set_max_operations(MAX_OPERATIONS);
        engine.set_max_call_levels(96);
        engine.set_max_expr_depths(256, 128);
        engine.set_max_string_size(8 << 20);
        engine.set_max_array_size(1 << 20);
        engine.set_max_map_size(1 << 16);
        engine.set_optimization_level(rhai::OptimizationLevel::Simple);
        engine.set_fast_operators(true);
        let st = state.clone();
        engine.on_print(move |text| st.borrow_mut().println(text.to_string()));
        let st = state.clone();
        engine.on_debug(move |text, src, pos| st.borrow_mut().println(format!("[debug {src:?} {pos}] {text}")));
        rmath::register(&mut engine, state.clone());
        super::jsrt::register(&mut engine);
        register_api(&mut engine, &state);

        let mut ast = AST::empty();
        for (name, src) in sources {
            let part = engine.compile(src).map_err(|e| format!("{name}: {e}"))?;
            ast = ast.merge(&part);
        }
        let defined: HashSet<String> = ast.iter_functions().map(|f| f.name.to_string()).collect();
        let mut scope = Scope::new();
        engine.run_ast_with_scope(&mut scope, &ast).map_err(|e| format!("top level: {e}"))?;
        // The top level's job was to declare constants. Rhai functions cannot see the top level,
        // so its names are published as the module `G` (`G::FACTIONS`), shared so that reading
        // a big table never copies it.
        let mut globals = Module::new();
        for (name, _, value) in scope.iter_raw() {
            globals.set_var(name, value.clone().into_shared());
        }
        engine.register_static_module("G", globals.into());
        let scope = Scope::new();
        let ast = ast.clone_functions_only();
        let mut host = Self { engine, ast, scope, app: Map::new().into(), defined, reported: HashSet::new(), state, errors: Vec::new() };
        host.call("init", vec![]);
        Ok(host)
    }

    pub fn has(&self, name: &str) -> bool {
        self.defined.contains(name)
    }

    /// Calls a script function as a method on the app (absent ones are skipped). Errors are
    /// logged once per distinct message and returned as `None`.
    pub fn call(&mut self, name: &str, args: Vec<Dynamic>) -> Option<Dynamic> {
        if !self.defined.contains(name) {
            return None;
        }
        let opts = CallFnOptions::new().eval_ast(false).rewind_scope(true).bind_this_ptr(&mut self.app);
        match self.engine.call_fn_with_options::<Dynamic>(opts, &mut self.scope, &self.ast, name, args) {
            Ok(v) => Some(v),
            Err(e) => {
                let msg = format!("[script] {name}: {e}");
                if self.reported.insert(msg.clone()) {
                    self.state.borrow_mut().println(msg.clone());
                    self.errors.push(msg);
                }
                None
            }
        }
    }

    pub fn call_fn_ptr(&mut self, f: &FnPtr, args: Vec<Dynamic>) -> Option<Dynamic> {
        self.call(f.fn_name(), args)
    }

    /// A tool registered with `Entropy::registerTool(name, ...)` runs the script's `tool_<name>(args)`.
    pub fn call_tool(&mut self, name: &str, args: serde_json::Value) -> serde_json::Value {
        let f = format!("tool_{name}");
        if !self.has(&f) {
            return serde_json::json!({ "success": false, "error": format!("no tool {name}") });
        }
        let before = self.errors.len();
        match self.call(&f, vec![from_json(&args)]) {
            Some(v) => to_json(&v),
            None => serde_json::json!({ "success": false, "error": self.errors.get(before).cloned().unwrap_or_default() }),
        }
    }

    /// The app object (`this` in every callback).
    pub fn app(&self) -> &Dynamic {
        &self.app
    }
}
