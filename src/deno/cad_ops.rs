//! `Entropy.Cad`: the entropy-cad geometry kernel (crates/entropy-cad) for addons.
//!
//! An addon keeps its CAD document as plain JSON (so undo, persistence and MCP tools are ordinary
//! TypeScript) and hands it to a kernel session to evaluate. The session caches what it builds, so
//! a drag re-evaluates only the feature being dragged. Geometry stays on the Rust side: bodies,
//! sketch region fills and line ribbons are queued straight into the engine as meshes (as
//! `Entropy.MeshCache.createMesh` does); only small things cross into JavaScript - summaries,
//! sketch polylines for hit testing, pick results.
//!
//! Everything is in document units; the addon's pipeline scales to the world.

use std::cell::RefCell;
use std::collections::HashMap;

use deno_core::{op2, OpState};
use deno_error::JsErrorBox;
use serde::{Deserialize, Serialize};

use entropy_cad::features::{Document, Evaluation, Evaluator, FeatureKind, Options};
use entropy_cad::math::{v2, v3, V2, V3};
use entropy_cad::mesh::{triangulate, Bvh};
use entropy_cad::nurbs::Tolerance;
use entropy_cad::sketch::curvature_comb;

use crate::deno::addon_engine::AddonEngine;
use crate::deno::addon_ops::{AddonContext, BindingConfig, MeshConfig};

fn err(e: impl Into<String>) -> JsErrorBox { JsErrorBox::generic(e.into()) }

#[derive(Default)]
struct Session {
    evaluator: Evaluator,
    doc: Document,
    eval: Evaluation,
    /// Ray-cast hierarchies per body, rebuilt when the body's key changes.
    bvh: HashMap<String, (u64, Bvh)>,
}

#[derive(Default)]
struct CadState {
    sessions: HashMap<String, Session>,
    /// Line batches collected by `op_cad_lines_add` for the next "lines" spawn.
    lines: Vec<f32>,
}

thread_local! { static CAD: RefCell<CadState> = RefCell::new(CadState::default()); }

fn with_session<T>(id: &str, f: impl FnOnce(&mut Session) -> Result<T, JsErrorBox>) -> Result<T, JsErrorBox> {
    CAD.with(|c| f(c.borrow_mut().sessions.get_mut(id).ok_or_else(|| err(format!("no CAD session {id}")))?))
}

#[op2]
#[string]
pub fn op_cad_open() -> String {
    let id = uuid::Uuid::new_v4().to_string();
    CAD.with(|c| c.borrow_mut().sessions.insert(id.clone(), Session::default()));
    id
}

#[op2(fast)]
pub fn op_cad_close(#[string] id: String) {
    CAD.with(|c| c.borrow_mut().sessions.remove(&id));
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EvaluateOptions {
    /// How far a flattened curve may stray from the true one, in document units.
    chord: Option<f64>,
    /// The most neighbouring facets may turn, in degrees.
    angle: Option<f64>,
    /// Coarser, for geometry rebuilt on every frame of a drag.
    draft: bool,
    /// Only sketches (bodies keep their last evaluation): for drawing.
    sketches_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodySummary {
    id: String,
    name: String,
    /// Changes when the geometry does.
    key: String,
    triangles: usize,
    min: [f64; 3],
    max: [f64; 3],
    volume: f64,
    area: f64,
    centroid: [f64; 3],
    faces: Vec<entropy_cad::mesh::FaceTag>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySummary { id: String, closed: bool, construction: bool, /// Flattened curve in sketch coordinates: x, y, x, y...
    points: Vec<f64> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionSummary { key: String, area: f64, centroid: [f64; 2], holes: usize }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchSummary {
    id: String,
    origin: [f64; 3],
    x: [f64; 3],
    y: [f64; 3],
    normal: [f64; 3],
    entities: Vec<EntitySummary>,
    regions: Vec<RegionSummary>,
    /// Open runs of curves joined end to end (paths to sweep along), as entity ids.
    chains: Vec<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    ms: f64,
    /// Bodies rebuilt (rather than reused) by this evaluation.
    built: usize,
    issues: Vec<entropy_cad::features::Issue>,
    bodies: Vec<BodySummary>,
    sketches: Vec<SketchSummary>,
}

fn summarize(s: &Session, ms: f64) -> Summary {
    Summary {
        ms,
        built: s.evaluator.built,
        issues: s.eval.issues.clone(),
        bodies: s.eval.bodies.iter().map(|b| {
            let bounds = b.mesh.bounds();
            BodySummary {
                id: b.id.clone(), name: b.name.clone(), key: format!("{:016x}", b.key), triangles: b.mesh.tris.len(),
                min: bounds.min.arr(), max: bounds.max.arr(), volume: b.mesh.volume(), area: b.mesh.area(), centroid: b.mesh.centroid().arr(),
                faces: b.mesh.faces.clone(),
            }
        }).collect(),
        sketches: s.eval.sketches.iter().map(|k| SketchSummary {
            id: k.id.clone(), origin: k.frame.o.arr(), x: k.frame.x.arr(), y: k.frame.y.arr(), normal: k.frame.z.arr(),
            entities: k.geom.entities.iter().map(|e| EntitySummary { id: e.id.clone(), closed: e.closed, construction: e.construction, points: e.poly.iter().flat_map(|p| [p.1.x, p.1.y]).collect() }).collect(),
            regions: k.geom.regions.iter().map(|r| RegionSummary { key: r.key.clone(), area: r.area, centroid: r.centroid.arr(), holes: r.holes.len() }).collect(),
            chains: k.geom.chains.iter().map(|c| c.entities.clone()).collect(),
        }).collect(),
    }
}

/// Evaluates a document (JSON text). Problems with individual features come back as `issues`;
/// only a document that is not valid JSON of the right shape is an error.
#[op2]
#[serde]
pub fn op_cad_evaluate(#[string] id: String, #[string] doc: String, #[serde] options: Option<EvaluateOptions>) -> Result<Summary, JsErrorBox> {
    let options = options.unwrap_or_default();
    let doc: Document = serde_json::from_str(&doc).map_err(|e| err(format!("not a CAD document: {e}")))?;
    let mut tolerance = Tolerance::default();
    if let Some(c) = options.chord { if c > 0.0 { tolerance.chord = c; } }
    if let Some(a) = options.angle { if a > 0.0 { tolerance.angle = a.to_radians(); } }
    if options.draft { tolerance = tolerance.draft(); }
    with_session(&id, |s| {
        let started = std::time::Instant::now();
        let mut eval = s.evaluator.evaluate(&doc, &Options { tolerance, sketches_only: options.sketches_only });
        if options.sketches_only { eval.bodies = std::mem::take(&mut s.eval.bodies); }
        s.eval = eval;
        s.doc = doc;
        let live: std::collections::HashSet<&str> = s.eval.bodies.iter().map(|b| b.id.as_str()).collect();
        s.bvh.retain(|k, _| live.contains(k.as_str()));
        Ok(summarize(s, started.elapsed().as_secs_f64() * 1000.0))
    })
}

/// What to spawn as an engine mesh.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpawnWhat {
    /// A body's surface. `uv.x` of each vertex is its face's index in the body summary's `faces`.
    Body { body: String },
    /// The closed regions of a sketch, filled flat.
    Regions { sketch: String, color: [f32; 4] },
    /// The batches added with `op_cad_lines_add` since the last spawn, as screen-space ribbons.
    Lines,
}

/// Everything `Entropy.Model.createMesh` takes except the geometry.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnConfig {
    #[serde(default)]
    id: Option<String>,
    pipeline_id: String,
    #[serde(default)]
    bindings: Option<Vec<BindingConfig>>,
}

fn push_vertex(out: &mut Vec<f32>, p: V3, n: V3, uv: [f32; 2], color: [f32; 4]) {
    out.extend_from_slice(&[p.x as f32, p.y as f32, p.z as f32, n.x as f32, n.y as f32, n.z as f32, uv[0], uv[1], color[0], color[1], color[2], color[3]]);
}

/// Queues a mesh built by the kernel straight into the engine. Returns false (spawning nothing)
/// when there is nothing to draw.
#[op2]
pub fn op_cad_spawn(state: &mut OpState, #[string] addon_name: String, #[string] id: String, #[serde] what: SpawnWhat, #[serde] config: SpawnConfig) -> Result<bool, JsErrorBox> {
    let (vertices, indices): (Vec<f32>, Vec<u32>) = match what {
        SpawnWhat::Lines => CAD.with(|c| {
            let lines = std::mem::take(&mut c.borrow_mut().lines);
            let quads = lines.len() / 48;
            let indices = (0..quads as u32).flat_map(|q| [q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3]).collect();
            (lines, indices)
        }),
        SpawnWhat::Body { body } => with_session(&id, |s| {
            let b = s.eval.bodies.iter().find(|b| b.id == body).ok_or_else(|| err(format!("no body {body}")))?;
            let m = &b.mesh;
            // Faces are per triangle; vertices are shared within a face only, so each vertex has one.
            let mut face = vec![0u32; m.positions.len()];
            for (t, tri) in m.tris.iter().enumerate() { for v in tri { face[*v as usize] = m.face[t]; } }
            let mut vertices = Vec::with_capacity(m.positions.len() * 12);
            for i in 0..m.positions.len() { push_vertex(&mut vertices, m.positions[i], m.normals[i], [face[i] as f32, 0.0], [1.0; 4]); }
            Ok((vertices, m.tris.iter().flatten().copied().collect()))
        })?,
        SpawnWhat::Regions { sketch, color } => with_session(&id, |s| {
            let k = s.eval.sketches.iter().find(|k| k.id == sketch).ok_or_else(|| err(format!("no sketch {sketch}")))?;
            let (mut vertices, mut indices) = (Vec::new(), Vec::new());
            for r in &k.geom.regions {
                let holes: Vec<Vec<V2>> = r.holes.iter().map(|h| h.pts.clone()).collect();
                let base = (vertices.len() / 12) as u32;
                for p in r.outer.pts.iter().chain(holes.iter().flatten()) { push_vertex(&mut vertices, k.frame.point(*p), k.frame.z, [0.0, 0.0], color); }
                for t in triangulate(&r.outer.pts, &holes) { indices.extend(t.map(|i| base + i as u32)); }
            }
            Ok((vertices, indices))
        })?,
    };
    if indices.is_empty() { return Ok(false); }
    if !AddonEngine::is_render_allowed(&addon_name) { return Ok(true); }
    let ctx = state.try_borrow_mut::<AddonContext>().ok_or_else(|| err("addon context unavailable"))?;
    ctx.pending_meshes.push((addon_name, MeshConfig {
        id: config.id,
        position: [0.0; 3],
        rotation: None,
        scale: None,
        vertex_data: vertices,
        index_data: indices,
        shared_geometry: None,
        bounds: None,
        pipeline_id: config.pipeline_id,
        render_role: None,
        instance_count: Some(1),
        bindings: config.bindings,
        physics: None,
        behavior_id: None,
        yumon_id: None,
        is_npc: None,
        player: None,
    }));
    Ok(true)
}

/// Forgets line batches added but never spawned.
#[op2(fast)]
pub fn op_cad_lines_begin() {
    CAD.with(|c| c.borrow_mut().lines.clear());
}

/// Adds segments (x, y, z, x, y, z per segment, as Float32Array bytes) to the next "lines" spawn.
///
/// Each becomes a quad of four vertices in the engine's `mesh` layout, for a shader that widens it
/// on screen: `position` is the vertex's own end, `normal` the other end, `uv.x` the side (-1 or 1)
/// times `width` (pixels), `uv.y` 0 at the segment's start and 1 at its end (plus 2 when dashed).
#[op2(fast)]
pub fn op_cad_lines_add(#[buffer] segments: &[u8], r: f32, g: f32, b: f32, a: f32, width: f32, dashed: bool) {
    let dash = if dashed { 2.0 } else { 0.0 };
    CAD.with(|c| {
        let lines = &mut c.borrow_mut().lines;
        lines.reserve(segments.len() / 24 * 48);
        for seg in segments.chunks_exact(24) {
            let f: Vec<f32> = seg.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
            let (p, q) = ([f[0], f[1], f[2]], [f[3], f[4], f[5]]);
            for (own, other, end) in [(p, q, 0.0), (q, p, 1.0)] {
                for side in [-1.0f32, 1.0] {
                    lines.extend_from_slice(&[own[0], own[1], own[2], other[0], other[1], other[2], side * width, end + dash, r, g, b, a]);
                }
            }
        }
    });
}

/// Which line segments to read back.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SegmentsWhat {
    /// A body's sharp edges and seams.
    BodyEdges { body: String },
    /// A sketch's curves in space; one entity's if `entity` is given, else all (optionally only
    /// construction or only real geometry).
    Sketch { sketch: String, #[serde(default)] entity: Option<String>, #[serde(default)] construction: Option<bool> },
    /// The boundaries of a sketch's closed regions.
    Regions { sketch: String },
    /// An entity's curvature comb: quills, then the line through their tips.
    Comb { sketch: String, entity: String, scale: f64, #[serde(default)] quills: Option<usize> },
}

/// Line segments in document space (x, y, z, x, y, z each) as Float32Array bytes.
#[op2]
#[buffer]
pub fn op_cad_segments(#[string] id: String, #[serde] what: SegmentsWhat) -> Result<Vec<u8>, JsErrorBox> {
    with_session(&id, |s| {
        let mut out: Vec<f32> = Vec::new();
        let mut push = |a: V3, b: V3| out.extend_from_slice(&[a.x as f32, a.y as f32, a.z as f32, b.x as f32, b.y as f32, b.z as f32]);
        let sketch = |sid: &str| s.eval.sketches.iter().find(|k| k.id == sid).ok_or_else(|| err(format!("no sketch {sid}")));
        match &what {
            SegmentsWhat::BodyEdges { body } => {
                let b = s.eval.bodies.iter().find(|b| b.id == *body).ok_or_else(|| err(format!("no body {body}")))?;
                for e in &b.mesh.edges { push(e[0], e[1]); }
            }
            SegmentsWhat::Sketch { sketch: sid, entity, construction } => {
                let k = sketch(sid)?;
                for e in &k.geom.entities {
                    if entity.as_ref().map_or(false, |id| *id != e.id) || construction.map_or(false, |c| c != e.construction) { continue; }
                    for w in e.poly.windows(2) { push(k.frame.point(w[0].1), k.frame.point(w[1].1)); }
                }
            }
            SegmentsWhat::Regions { sketch: sid } => {
                let k = sketch(sid)?;
                for r in &k.geom.regions {
                    for path in std::iter::once(&r.outer).chain(r.holes.iter()) {
                        for i in 0..path.pts.len() { push(k.frame.point(path.pts[i]), k.frame.point(path.pts[(i + 1) % path.pts.len()])); }
                    }
                }
            }
            SegmentsWhat::Comb { sketch: sid, entity, scale, quills } => {
                let k = sketch(sid)?;
                let e = k.geom.entities.iter().find(|e| e.id == *entity).ok_or_else(|| err(format!("no entity {entity}")))?;
                let (lines, tips) = curvature_comb(e, *scale, quills.unwrap_or(48).clamp(2, 512));
                for l in &lines { push(k.frame.point(l[0]), k.frame.point(l[1])); }
                for w in tips.windows(2) { push(k.frame.point(w[0]), k.frame.point(w[1])); }
            }
        }
        Ok(out.iter().flat_map(|f| f.to_le_bytes()).collect())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickHit {
    body: String,
    /// Index into the body summary's `faces`, and the face itself.
    face_index: u32,
    feature: String,
    part: String,
    point: [f64; 3],
    normal: [f64; 3],
    distance: f64,
}

/// The nearest body surface along a ray (document space).
#[op2]
#[serde]
pub fn op_cad_pick(#[string] id: String, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64) -> Result<Option<PickHit>, JsErrorBox> {
    with_session(&id, |s| {
        let (origin, dir) = (v3(ox, oy, oz), v3(dx, dy, dz).norm());
        let mut best: Option<PickHit> = None;
        for b in &s.eval.bodies {
            let fresh = s.bvh.get(&b.id).map_or(false, |e| e.0 == b.key);
            if !fresh { s.bvh.insert(b.id.clone(), (b.key, Bvh::build(&b.mesh))); }
            let Some((t, tri)) = s.bvh[&b.id].1.nearest(&b.mesh, origin, dir) else { continue };
            if best.as_ref().map_or(false, |h| h.distance <= t) { continue; }
            let [p, q, r] = b.mesh.tri(tri);
            let mut n = (q - p).cross(r - p).norm();
            if n.dot(dir) > 0.0 { n = -n; }
            let tag = &b.mesh.faces[b.mesh.face[tri] as usize];
            best = Some(PickHit { body: b.id.clone(), face_index: b.mesh.face[tri], feature: tag.feature.clone(), part: tag.part.clone(), point: (origin + dir * t).arr(), normal: n.arr(), distance: t });
        }
        Ok(best)
    })
}

/// Where a ray (document space) meets a sketch's plane, in sketch coordinates; null if it misses.
#[op2]
#[serde]
pub fn op_cad_sketch_point(#[string] id: String, #[string] sketch: String, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64) -> Result<Option<[f64; 2]>, JsErrorBox> {
    with_session(&id, |s| {
        let k = s.eval.sketches.iter().find(|k| k.id == sketch).ok_or_else(|| err(format!("no sketch {sketch}")))?;
        Ok(k.frame.intersect_ray(v3(ox, oy, oz), v3(dx, dy, dz)).map(|p| p.arr()))
    })
}

/// What is under a point of a sketch within `radius`, and where to snap to: an existing point
/// first, then a line's midpoint, then the nearest spot on a curve. `skip` are point ids to ignore
/// (the ones being dragged).
#[op2]
#[serde]
pub fn op_cad_sketch_hit(#[string] id: String, #[string] sketch: String, x: f64, y: f64, radius: f64, #[serde] skip: Vec<String>) -> Result<entropy_cad::sketch::Hit, JsErrorBox> {
    with_session(&id, |s| {
        let k = s.eval.sketches.iter().find(|k| k.id == sketch).ok_or_else(|| err(format!("no sketch {sketch}")))?;
        let source = s.doc.features.iter().find_map(|f| match &f.kind { FeatureKind::Sketch(sk) if f.id == sketch => Some(&sk.sketch), _ => None }).ok_or_else(|| err(format!("no sketch {sketch}")))?;
        Ok(source.hit(&k.geom, v2(x, y), radius, &skip))
    })
}

#[derive(Serialize)]
pub struct ExportResult { success: bool, path: String, bytes: usize, error: Option<String> }

/// Writes every body to `path` as "stl" (binary) or "obj".
#[op2]
#[serde]
pub fn op_cad_export(#[string] id: String, #[string] format: String, #[string] path: String) -> Result<ExportResult, JsErrorBox> {
    with_session(&id, |s| {
        let data = match format.as_str() {
            "stl" => entropy_cad::export::stl(&s.eval.bodies),
            "obj" => entropy_cad::export::obj(&s.eval.bodies).into_bytes(),
            other => return Err(err(format!("unknown export format {other}: use stl or obj"))),
        };
        if let Some(dir) = std::path::Path::new(&path).parent() { if !dir.as_os_str().is_empty() { let _ = std::fs::create_dir_all(dir); } }
        Ok(match std::fs::write(&path, &data) {
            Ok(()) => ExportResult { success: true, path, bytes: data.len(), error: None },
            Err(e) => ExportResult { success: false, path, bytes: 0, error: Some(e.to_string()) },
        })
    })
}
