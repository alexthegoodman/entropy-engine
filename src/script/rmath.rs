//! Native helpers registered into every Rhai script. Rhai interprets a tree, at roughly a few
//! hundred nanoseconds an operation: game rules are fine there, but the inner loops of a frame
//! (vector math, matrices for hundreds of instances, packing their records) belong in Rust. A
//! script calls these like built-ins.
//!
//! - Vectors are arrays `[x, y, z]`: `v_add`, `v_sub`, `v_mul`, `v_dot`, `v_cross`, `v_len`,
//!   `v_dist`, `v_norm`, `v_lerp`, `basis`, `forward_of`, `segment_distance`; and scalar `lerp`,
//!   `clamp`, `smooth`, `approach`.
//! - [`Rng`]: mulberry32, bit-exact with the TypeScript games' `Rng` (the same seed builds the
//!   same world in either language). `hash_string` is their FNV-1a.
//! - [`Floats`]: a shared `f32` array for GPU data (`Buffer.write` takes it without copying
//!   element by element).
//! - [`Batches`]: instanced batches of cached meshes (the TypeScript `InstanceBatches`): add a
//!   record a frame per thing, flush once, and every mesh key is one draw call.
//! - Formatting: `to_fixed`, `locale_int`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use rhai::{Array, Dynamic, Engine, EvalAltResult, ImmutableString, Map, FLOAT, INT};

use super::state::{EngineState, GpuCommand, MeshBinding, Shared};

pub type RResult<T> = Result<T, Box<EvalAltResult>>;

pub fn num(d: &Dynamic) -> f64 {
    if let Ok(f) = d.as_float() {
        f
    } else if let Ok(i) = d.as_int() {
        i as f64
    } else if let Ok(b) = d.as_bool() {
        if b { 1.0 } else { 0.0 }
    } else {
        0.0
    }
}

pub fn v3(a: &Array) -> [f64; 3] {
    [a.first().map(num).unwrap_or(0.0), a.get(1).map(num).unwrap_or(0.0), a.get(2).map(num).unwrap_or(0.0)]
}

pub fn arr3(v: [f64; 3]) -> Array {
    vec![Dynamic::from_float(v[0]), Dynamic::from_float(v[1]), Dynamic::from_float(v[2])]
}

pub fn floats(a: &Array) -> Vec<f64> {
    a.iter().map(num).collect()
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn len(a: [f64; 3]) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}
fn normalize(a: [f64; 3], fallback: [f64; 3]) -> [f64; 3] {
    let l = len(a);
    if l > 1e-12 { [a[0] / l, a[1] / l, a[2] / l] } else { fallback }
}
pub fn basis_of(f: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let mut r = cross([0.0, 1.0, 0.0], f);
    if len(r) < 1e-6 {
        r = [1.0, 0.0, 0.0];
    }
    let r = normalize(r, [0.0, 0.0, 1.0]);
    let u = normalize(cross(f, r), [0.0, 0.0, 1.0]);
    (r, u)
}

/// Scale then translate (no rotation), column-major, as the TypeScript `placed`.
pub fn placed(p: [f64; 3], s: [f64; 3]) -> [f32; 16] {
    [s[0] as f32, 0.0, 0.0, 0.0, 0.0, s[1] as f32, 0.0, 0.0, 0.0, 0.0, s[2] as f32, 0.0, p[0] as f32, p[1] as f32, p[2] as f32, 1.0]
}

/// A frame at `p` whose +Z is `forward` (unit) and whose +Y leans to `up_hint`, scaled per axis,
/// as the TypeScript `oriented`.
pub fn oriented(p: [f64; 3], f: [f64; 3], s: [f64; 3], up_hint: [f64; 3]) -> [f32; 16] {
    let mut r = cross(up_hint, f);
    let rl = len(r);
    r = if rl < 1e-6 { [1.0, 0.0, 0.0] } else { [r[0] / rl, r[1] / rl, r[2] / rl] };
    let u = cross(f, r);
    [
        (r[0] * s[0]) as f32, (r[1] * s[0]) as f32, (r[2] * s[0]) as f32, 0.0,
        (u[0] * s[1]) as f32, (u[1] * s[1]) as f32, (u[2] * s[1]) as f32, 0.0,
        (f[0] * s[2]) as f32, (f[1] * s[2]) as f32, (f[2] * s[2]) as f32, 0.0,
        p[0] as f32, p[1] as f32, p[2] as f32, 1.0,
    ]
}

pub fn hash_string(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    // JavaScript's charCodeAt: UTF-16 code units.
    for c in s.encode_utf16() {
        h ^= c as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

/// mulberry32, as nk_math.ts's `Rng`.
#[derive(Clone)]
pub struct Rng {
    s: Rc<RefCell<u32>>,
}

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self { s: Rc::new(RefCell::new(if seed == 0 { 1 } else { seed })) }
    }
    pub fn next(&self) -> f64 {
        let mut s = self.s.borrow_mut();
        *s = s.wrapping_add(0x6d2b79f5);
        let mut t = *s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
    pub fn range(&self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.next()
    }
    pub fn dir(&self) -> [f64; 3] {
        let z = self.range(-1.0, 1.0);
        let a = self.range(0.0, std::f64::consts::PI * 2.0);
        let r = (1.0 - z * z).sqrt();
        [r * a.cos(), z, r * a.sin()]
    }
}

/// A shared `f32` array: copies are references, so a script can fill one and hand it on.
#[derive(Clone, Default)]
pub struct Floats(pub Rc<RefCell<Vec<f32>>>);

impl Floats {
    pub fn new(n: usize) -> Self {
        Self(Rc::new(RefCell::new(vec![0.0; n])))
    }
}

struct Batch {
    data: Vec<f32>,
    count: usize,
    lo: [f64; 3],
    hi: [f64; 3],
    unbounded: bool,
    mesh_id: String,
    buffer: String,
    gpu_capacity: usize,
    drawn: usize,
    bounds: String,
    idle: u32,
    uploaded: Vec<f32>,
    uploaded_count: usize,
}

/// The TypeScript `InstanceBatches` on `meshCacheInstances`: one engine mesh per cached mesh
/// key, drawing every instance added to it this frame from one storage buffer (group 2, binding
/// 1; the world uniform is binding 0).
pub struct BatchesInner {
    state: Shared,
    namespace: String,
    /// Appended to each key when looking it up in the cache (a mesh version, e.g. "-v1").
    key_suffix: String,
    pipeline: String,
    world_buffer: String,
    record: usize,
    prefix: String,
    idle_frames: u32,
    initial: usize,
    serial: u64,
    rebuilds: u64,
    batches: Vec<(String, Batch)>,
    index: HashMap<String, usize>,
    pub last: Map,
}

#[derive(Clone)]
pub struct Batches(pub Rc<RefCell<BatchesInner>>);

impl Batches {
    pub fn new(state: Shared, opts: &Map) -> RResult<Self> {
        let s = |k: &str| opts.get(k).and_then(|v| v.clone().into_string().ok()).unwrap_or_default();
        let n = |k: &str, d: f64| opts.get(k).map(num).unwrap_or(d);
        let record = n("recordFloats", 28.0) as usize;
        if record == 0 || record % 4 != 0 {
            return Err("Instances.create: recordFloats must be a positive multiple of 4".into());
        }
        Ok(Self(Rc::new(RefCell::new(BatchesInner {
            state,
            namespace: s("namespace"),
            key_suffix: s("keySuffix"),
            pipeline: s("pipelineId"),
            world_buffer: s("worldBuffer"),
            record,
            prefix: { let p = s("prefix"); if p.is_empty() { "instances".into() } else { p } },
            idle_frames: n("idleFrames", 600.0) as u32,
            initial: n("initialCapacity", 16.0).max(1.0) as usize,
            serial: 0,
            rebuilds: 0,
            batches: Vec::new(),
            index: HashMap::new(),
            last: Map::new(),
        }))))
    }
}

impl BatchesInner {
    pub fn begin(&mut self) {
        for (_, b) in self.batches.iter_mut() {
            b.count = 0;
            b.lo = [f64::INFINITY; 3];
            b.hi = [f64::NEG_INFINITY; 3];
            b.unbounded = false;
        }
    }

    /// A fresh record for `key`; returns the slice to fill.
    pub fn add(&mut self, key: &str, sphere: Option<[f64; 4]>) -> &mut [f32] {
        let f = self.record;
        let i = match self.index.get(key) {
            Some(&i) => i,
            None => {
                self.batches.push((key.to_string(), Batch {
                    data: vec![0.0; self.initial * f],
                    count: 0,
                    lo: [f64::INFINITY; 3],
                    hi: [f64::NEG_INFINITY; 3],
                    unbounded: false,
                    mesh_id: String::new(),
                    buffer: String::new(),
                    gpu_capacity: 0,
                    drawn: 0,
                    bounds: String::new(),
                    idle: 0,
                    uploaded: Vec::new(),
                    uploaded_count: 0,
                }));
                self.index.insert(key.to_string(), self.batches.len() - 1);
                self.batches.len() - 1
            }
        };
        let b = &mut self.batches[i].1;
        if (b.count + 1) * f > b.data.len() {
            let n = b.data.len() * 2;
            b.data.resize(n, 0.0);
        }
        match sphere {
            Some(s) => {
                for k in 0..3 {
                    b.lo[k] = b.lo[k].min(s[k] - s[3]);
                    b.hi[k] = b.hi[k].max(s[k] + s[3]);
                }
            }
            None => b.unbounded = true,
        }
        let o = b.count * f;
        b.count += 1;
        let rec = &mut b.data[o..o + f];
        rec.fill(0.0);
        rec
    }

    fn release(state: &mut EngineState, b: &mut Batch) {
        if !b.mesh_id.is_empty() {
            state.commands.push(GpuCommand::ClearMesh { id: std::mem::take(&mut b.mesh_id) });
        }
        if !b.buffer.is_empty() {
            state.commands.push(GpuCommand::DestroyBuffer { id: std::mem::take(&mut b.buffer) });
        }
        b.gpu_capacity = 0;
        b.drawn = 0;
        b.bounds.clear();
        b.uploaded_count = 0;
    }

    fn upload(state: &mut EngineState, b: &mut Batch, f: usize) {
        let n = b.count * f;
        state.commands.push(GpuCommand::WriteBuffer { id: b.buffer.clone(), offset: 0, data: bytemuck::cast_slice(&b.data[..n]).to_vec() });
        b.uploaded.clear();
        b.uploaded.extend_from_slice(&b.data[..n]);
        b.uploaded_count = b.count;
    }

    /// Uploads this frame's records: one buffer write per changed, non-empty batch.
    pub fn flush(&mut self) -> Map {
        let f = self.record;
        let state_rc = self.state.clone();
        let mut state = state_rc.borrow_mut();
        let (mut drawn_batches, mut instances, mut uploads, mut unchanged) = (0, 0, 0, 0);
        let mut dead = Vec::new();
        for (i, (key, b)) in self.batches.iter_mut().enumerate() {
            if b.count == 0 {
                if b.drawn != 0 && !b.mesh_id.is_empty() {
                    state.commands.push(GpuCommand::SetInstanceCount { id: b.mesh_id.clone(), count: 0 });
                    b.drawn = 0;
                }
                b.idle += 1;
                if b.idle > self.idle_frames {
                    Self::release(&mut state, b);
                    dead.push(i);
                }
                continue;
            }
            b.idle = 0;
            let capacity = b.data.len() / f;
            if b.mesh_id.is_empty() || b.gpu_capacity < b.count {
                Self::release(&mut state, b);
                b.buffer = state.next_id("buffer");
                state.commands.push(GpuCommand::CreateBuffer { id: b.buffer.clone(), size: (capacity * f * 4) as u64, storage: true });
                b.gpu_capacity = capacity;
                Self::upload(&mut state, b, f);
                uploads += 1;
                let cache_key = EngineState::cache_key(&self.namespace, &format!("{key}{}", self.key_suffix));
                let Some(mesh) = state.mesh_cache.get(&cache_key).cloned() else {
                    Self::release(&mut state, b);
                    dead.push(i);
                    state.println(format!("[instances] mesh {cache_key} is not cached: nothing drawn for it"));
                    continue;
                };
                self.serial += 1;
                let mesh_id = format!("{}-{}", self.prefix, self.serial);
                let mut bindings = vec![MeshBinding { group: 2, binding: 1, buffer: b.buffer.clone() }];
                if !self.world_buffer.is_empty() {
                    bindings.insert(0, MeshBinding { group: 2, binding: 0, buffer: self.world_buffer.clone() });
                }
                state.commands.push(GpuCommand::CreateMesh { id: mesh_id.clone(), mesh, pipeline: self.pipeline.clone(), instances: b.count as u32, bindings });
                b.mesh_id = mesh_id;
                b.drawn = b.count;
                self.rebuilds += 1;
            } else {
                let n = b.count * f;
                if b.count == b.uploaded_count && b.uploaded.len() >= n && b.uploaded[..n] == b.data[..n] {
                    unchanged += 1;
                } else {
                    Self::upload(&mut state, b, f);
                    uploads += 1;
                }
                if b.drawn != b.count {
                    state.commands.push(GpuCommand::SetInstanceCount { id: b.mesh_id.clone(), count: b.count as u32 });
                    b.drawn = b.count;
                }
            }
            // A sphere around the whole batch lets the renderer skip it out of view.
            let (center, radius) = if !b.unbounded && b.lo[0].is_finite() {
                let c = [(b.lo[0] + b.hi[0]) / 2.0, (b.lo[1] + b.hi[1]) / 2.0, (b.lo[2] + b.hi[2]) / 2.0];
                let r = len([b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]]) / 2.0;
                (Some(c), r)
            } else {
                (None, -1.0)
            };
            let tag = match center {
                Some(c) => format!("{:.2},{:.2},{:.2},{:.2}", c[0], c[1], c[2], radius),
                None => "none".into(),
            };
            if tag != b.bounds {
                b.bounds = tag;
                state.commands.push(GpuCommand::SetBounds {
                    id: b.mesh_id.clone(),
                    bounds: center.map(|c| ([c[0] as f32, c[1] as f32, c[2] as f32], radius as f32)),
                });
            }
            drawn_batches += 1;
            instances += b.count;
        }
        drop(state);
        for &i in dead.iter().rev() {
            self.batches.remove(i);
        }
        if !dead.is_empty() {
            self.index = self.batches.iter().enumerate().map(|(i, (k, _))| (k.clone(), i)).collect();
        }
        let mut m = Map::new();
        m.insert("batches".into(), (self.batches.len() as INT).into());
        m.insert("drawnBatches".into(), (drawn_batches as INT).into());
        m.insert("instances".into(), (instances as INT).into());
        m.insert("uploads".into(), (uploads as INT).into());
        m.insert("unchanged".into(), (unchanged as INT).into());
        m.insert("rebuilds".into(), (self.rebuilds as INT).into());
        self.last = m.clone();
        m
    }

    pub fn clear(&mut self) {
        let state_rc = self.state.clone();
        let mut state = state_rc.borrow_mut();
        for (_, b) in self.batches.iter_mut() {
            Self::release(&mut state, b);
        }
        self.batches.clear();
        self.index.clear();
    }
}

fn vec4(a: &Array, out: &mut [f32]) {
    for (i, o) in out.iter_mut().enumerate().take(4) {
        *o = a.get(i).map(num).unwrap_or(0.0) as f32;
    }
}

fn to_fixed(x: f64, digits: INT) -> String {
    format!("{:.*}", digits.clamp(0, 20) as usize, x)
}

/// `Math.round(n).toLocaleString("en-US")`: thousands separated by commas.
fn locale_int(x: f64) -> String {
    let n = x.round();
    let neg = n < 0.0;
    let digits = format!("{:.0}", n.abs());
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if neg { format!("-{out}") } else { out }
}

thread_local! {
    static PROFILE: RefCell<HashMap<String, (f64, u64)>> = RefCell::new(HashMap::new());
}

/// Inclusive milliseconds and calls per function, from a `--profile` translation.
pub fn profile_report() -> Vec<(String, f64, u64)> {
    let mut v: Vec<_> = PROFILE.with(|p| p.borrow().iter().map(|(k, (ms, n))| (k.clone(), *ms, *n)).collect());
    v.sort_by(|a, b| b.1.total_cmp(&a.1));
    v
}

pub fn profile_reset() {
    PROFILE.with(|p| p.borrow_mut().clear());
}

pub fn register(engine: &mut Engine, state: Shared) {
    let t0 = web_time::Instant::now();
    engine.register_fn("prof_begin", move || t0.elapsed().as_secs_f64() * 1000.0);
    engine.register_fn("prof_end", move |name: ImmutableString, start: FLOAT| {
        let ms = t0.elapsed().as_secs_f64() * 1000.0 - start;
        PROFILE.with(|p| {
            let mut p = p.borrow_mut();
            let e = p.entry(name.to_string()).or_insert((0.0, 0));
            e.0 += ms;
            e.1 += 1;
        });
    });
    // --- scalars ---
    engine.register_fn("lerp", |a: FLOAT, b: FLOAT, t: FLOAT| a + (b - a) * t);
    engine.register_fn("clamp", |v: FLOAT| v.clamp(0.0, 1.0));
    engine.register_fn("clamp", |v: FLOAT, lo: FLOAT, hi: FLOAT| if v < lo { lo } else if v > hi { hi } else { v });
    engine.register_fn("smooth", |a: FLOAT, b: FLOAT, v: FLOAT| {
        let t = ((v - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    });
    engine.register_fn("approach", |a: FLOAT, b: FLOAT, step: FLOAT| if a < b { b.min(a + step) } else { b.max(a - step) });
    engine.register_fn("to_fixed", |x: FLOAT, d: INT| to_fixed(x, d));
    engine.register_fn("to_fixed", |x: INT, d: INT| to_fixed(x as f64, d));
    engine.register_fn("locale_int", |x: FLOAT| locale_int(x));
    engine.register_fn("locale_int", |x: INT| locale_int(x as f64));
    engine.register_fn("hash_string", |s: &str| hash_string(s) as INT);
    // Math.imul and `>>> 0` for ports of 32-bit integer tricks.
    engine.register_fn("imul", |a: INT, b: INT| (a as u32).wrapping_mul(b as u32) as i32 as INT);
    engine.register_fn("u32", |a: INT| (a as u32) as INT);
    engine.register_fn("cbrt", |x: FLOAT| x.cbrt());
    engine.register_fn("hypot", |x: FLOAT, y: FLOAT| x.hypot(y));
    engine.register_fn("atan2", |y: FLOAT, x: FLOAT| y.atan2(x));
    engine.register_fn("sign", |x: FLOAT| if x > 0.0 { 1.0 } else if x < 0.0 { -1.0 } else { 0.0 });
    engine.register_fn("is_finite_num", |x: FLOAT| x.is_finite());

    // --- vectors ---
    engine.register_fn("v_add", |a: Array, b: Array| { let (a, b) = (v3(&a), v3(&b)); arr3([a[0] + b[0], a[1] + b[1], a[2] + b[2]]) });
    engine.register_fn("v_sub", |a: Array, b: Array| { let (a, b) = (v3(&a), v3(&b)); arr3([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) });
    engine.register_fn("v_mul", |a: Array, s: FLOAT| { let a = v3(&a); arr3([a[0] * s, a[1] * s, a[2] * s]) });
    engine.register_fn("v_madd", |a: Array, b: Array, s: FLOAT| { let (a, b) = (v3(&a), v3(&b)); arr3([a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]) });
    engine.register_fn("v_dot", |a: Array, b: Array| { let (a, b) = (v3(&a), v3(&b)); a[0] * b[0] + a[1] * b[1] + a[2] * b[2] });
    engine.register_fn("v_cross", |a: Array, b: Array| arr3(cross(v3(&a), v3(&b))));
    engine.register_fn("v_len", |a: Array| len(v3(&a)));
    engine.register_fn("v_dist", |a: Array, b: Array| { let (a, b) = (v3(&a), v3(&b)); len([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) });
    engine.register_fn("v_norm", |a: Array| arr3(normalize(v3(&a), [0.0, 0.0, 1.0])));
    engine.register_fn("v_norm", |a: Array, fb: Array| arr3(normalize(v3(&a), v3(&fb))));
    engine.register_fn("v_lerp", |a: Array, b: Array, t: FLOAT| { let (a, b) = (v3(&a), v3(&b)); arr3([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]) });
    engine.register_fn("v_copy", |a: Array| arr3(v3(&a)));
    engine.register_fn("forward_of", |yaw: FLOAT, pitch: FLOAT| arr3([yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos()]));
    engine.register_fn("basis", |f: Array| {
        let (r, u) = basis_of(v3(&f));
        let mut m = Map::new();
        m.insert("right".into(), arr3(r).into());
        m.insert("up".into(), arr3(u).into());
        m
    });
    engine.register_fn("segment_distance", |p: Array, a: Array, b: Array| {
        let (p, a, b) = (v3(&p), v3(&a), v3(&b));
        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
        let t = if l2 > 0.0 { (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2).clamp(0.0, 1.0) } else { 0.0 };
        len([p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t])
    });

    // --- RNG ---
    engine.register_type_with_name::<Rng>("Rng");
    engine.register_fn("rng", |seed: INT| Rng::new(seed as u32));
    engine.register_fn("rng", |seed: FLOAT| Rng::new((seed as i64) as u32));
    engine.register_fn("rng", |seed: &str| Rng::new(hash_string(seed)));
    engine.register_fn("next", |r: &mut Rng| r.next());
    engine.register_fn("range", |r: &mut Rng, a: FLOAT, b: FLOAT| r.range(a, b));
    engine.register_fn("int", |r: &mut Rng, a: INT, b: INT| r.range(a as f64, (b + 1) as f64).floor() as INT);
    engine.register_fn("pick", |r: &mut Rng, items: Array| -> Dynamic {
        if items.is_empty() {
            return Dynamic::UNIT;
        }
        let i = ((r.next() * items.len() as f64).floor() as usize).min(items.len() - 1);
        items[i].clone()
    });
    engine.register_fn("dir", |r: &mut Rng| arr3(r.dir()));
    engine.register_fn("ball", |r: &mut Rng| {
        let d = r.dir();
        let k = r.next().cbrt();
        arr3([d[0] * k, d[1] * k, d[2] * k])
    });

    // --- Floats ---
    engine.register_type_with_name::<Floats>("Floats");
    engine.register_fn("floats", |n: INT| Floats::new(n.max(0) as usize));
    engine.register_fn("len", |f: &mut Floats| f.0.borrow().len() as INT);
    engine.register_indexer_get(|f: &mut Floats, i: INT| f.0.borrow().get(i as usize).copied().unwrap_or(0.0) as FLOAT);
    engine.register_indexer_set(|f: &mut Floats, i: INT, v: FLOAT| {
        if let Some(x) = f.0.borrow_mut().get_mut(i as usize) {
            *x = v as f32;
        }
    });
    engine.register_indexer_set(|f: &mut Floats, i: INT, v: INT| {
        if let Some(x) = f.0.borrow_mut().get_mut(i as usize) {
            *x = v as f32;
        }
    });
    engine.register_fn("set4", |f: &mut Floats, i: INT, a: FLOAT, b: FLOAT, c: FLOAT, d: FLOAT| {
        let mut v = f.0.borrow_mut();
        let i = i as usize * 4;
        if i + 4 <= v.len() {
            v[i..i + 4].copy_from_slice(&[a as f32, b as f32, c as f32, d as f32]);
        }
    });
    engine.register_fn("fill", |f: &mut Floats, v: FLOAT| f.0.borrow_mut().fill(v as f32));

    // --- Instance batches ---
    engine.register_type_with_name::<Batches>("Batches");
    let st = state.clone();
    engine.register_fn("instance_batches", move |opts: Map| Batches::new(st.clone(), &opts));
    engine.register_fn("begin", |b: &mut Batches| b.0.borrow_mut().begin());
    engine.register_fn("flush", |b: &mut Batches| b.0.borrow_mut().flush());
    engine.register_fn("clear", |b: &mut Batches| b.0.borrow_mut().clear());
    engine.register_fn("stats", |b: &mut Batches| b.0.borrow().last.clone());
    // A record of [model matrix, then vec4s]: `placed` (scale then translate) ...
    engine.register_fn("add_placed", |b: &mut Batches, key: ImmutableString, p: Array, s: Array, v0: Array, v1: Array, v2: Array| {
        let mut inner = b.0.borrow_mut();
        let rec = inner.add(&key, None);
        rec[..16].copy_from_slice(&placed(v3(&p), v3(&s)));
        write_vecs(rec, &v0, &v1, &v2);
    });
    // ... or `oriented` (+Z along forward, +Y toward up).
    engine.register_fn("add_oriented", |b: &mut Batches, key: ImmutableString, p: Array, fwd: Array, s: Array, up: Array, v0: Array, v1: Array, v2: Array| {
        let mut inner = b.0.borrow_mut();
        let rec = inner.add(&key, None);
        rec[..16].copy_from_slice(&oriented(v3(&p), v3(&fwd), v3(&s), v3(&up)));
        write_vecs(rec, &v0, &v1, &v2);
    });
    // A raw record (any layout).
    engine.register_fn("add_record", |b: &mut Batches, key: ImmutableString, values: Array| {
        let mut inner = b.0.borrow_mut();
        let rec = inner.add(&key, None);
        for (o, v) in rec.iter_mut().zip(values.iter()) {
            *o = num(v) as f32;
        }
    });
}

fn write_vecs(rec: &mut [f32], v0: &Array, v1: &Array, v2: &Array) {
    if rec.len() >= 20 {
        vec4(v0, &mut rec[16..20]);
    }
    if rec.len() >= 24 {
        vec4(v1, &mut rec[20..24]);
    }
    if rec.len() >= 28 {
        vec4(v2, &mut rec[24..28]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_matches_the_typescript_mulberry32() {
        // new Rng(42): first three next() values, from nk_math.ts under Node.
        let r = Rng::new(42);
        let got: Vec<f64> = (0..3).map(|_| r.next()).collect();
        let want = [0.6011037519201636, 0.44829055899754167, 0.8524657934904099];
        for (g, w) in got.iter().zip(want) {
            assert!((g - w).abs() < 1e-15, "{got:?}");
        }
    }

    #[test]
    fn hash_string_is_fnv1a() {
        assert_eq!(hash_string(""), 2166136261);
        assert_eq!(hash_string("a"), 0xe40c292c);
    }

    #[test]
    fn locale_groups_thousands() {
        assert_eq!(locale_int(1234567.4), "1,234,567");
        assert_eq!(locale_int(-999.0), "-999");
        assert_eq!(locale_int(1000.0), "1,000");
    }
}
