//! The document: an ordered history of features (sketches, then the operations that turn them into
//! bodies and reshape those), and its evaluation into meshes.
//!
//! Every solid feature carries the controls for breaking symmetry where it is made, rather than as
//! an afterthought: an extrude has two independent sides, each with its own distance, scale, shift,
//! twist and bulge; a revolve can start and stop anywhere, squash, grow lobes and spiral; a loft
//! joins unlike profiles on unlike planes; a sweep twists and swells along its path; deformers act
//! over any part of a body; and a mirror can scale and shift the half it makes.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::boolean::{boolean, BoolOp};
use crate::math::{polygon_centroid, v2, v3, Frame, V2, V3};
use crate::mesh::{Grid, Mesh};
use crate::nurbs::Tolerance;
use crate::sketch::{Path2, Region, Sketch, SketchGeom};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Document {
    pub features: Vec<Feature>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Feature {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// A suppressed feature stays in the history but is skipped.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub suppressed: bool,
    #[serde(flatten)]
    pub kind: FeatureKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FeatureKind {
    Sketch(SketchFeature),
    Extrude(Extrude),
    Revolve(Revolve),
    Loft(Loft),
    Sweep(Sweep),
    Deform(Deform),
    Mirror(Mirror),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BasePlane {
    /// The ground: x right, y away from the viewer, normal up.
    #[default]
    Top,
    /// Facing the viewer: x right, y up.
    Front,
    /// Facing right: x away from the viewer, y up.
    Side,
}

/// Where a sketch (or a mirror) lies: a base plane, moved along its normal and tipped. Tipped
/// planes are what make lofts lean; nothing requires sections to be parallel.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlaneSpec {
    pub base: BasePlane,
    pub offset: f64,
    /// Degrees about the plane's own x axis, then its y axis, then its normal.
    pub tilt_x: f64,
    pub tilt_y: f64,
    pub spin: f64,
}

impl PlaneSpec {
    pub fn frame(&self) -> Frame {
        let (x, y, z) = match self.base {
            BasePlane::Top => (v3(1.0, 0.0, 0.0), v3(0.0, 0.0, -1.0), v3(0.0, 1.0, 0.0)),
            BasePlane::Front => (v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0)),
            BasePlane::Side => (v3(0.0, 0.0, -1.0), v3(0.0, 1.0, 0.0), v3(1.0, 0.0, 0.0)),
        };
        let mut f = Frame { o: z * self.offset, x, y, z };
        let turn = |f: &mut Frame, axis: V3, deg: f64| {
            if deg == 0.0 { return; }
            let r = deg.to_radians();
            *f = Frame { o: f.o, x: f.x.rotate(axis, r), y: f.y.rotate(axis, r), z: f.z.rotate(axis, r) };
        };
        let x_axis = f.x;
        turn(&mut f, x_axis, self.tilt_x);
        let y_axis = f.y;
        turn(&mut f, y_axis, self.tilt_y);
        let z_axis = f.z;
        turn(&mut f, z_axis, self.spin);
        f
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SketchFeature {
    #[serde(default)]
    pub plane: PlaneSpec,
    #[serde(flatten)]
    pub sketch: Sketch,
}

/// The regions of a sketch a feature uses; none listed means all of them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProfileRef {
    pub sketch: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regions: Vec<String>,
}

/// What a new solid does to the bodies already there.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BodyOp {
    #[default]
    New,
    Add,
    Cut,
    Intersect,
}

/// One direction of an extrude. The profile is scaled (about its centroid), shifted and turned
/// progressively as it travels `distance`; `bulge` swells it mid-way for curved walls.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Side {
    pub distance: f64,
    pub scale: [f64; 2],
    pub shift: [f64; 2],
    /// Degrees.
    pub twist: f64,
    pub bulge: f64,
}

impl Default for Side { fn default() -> Self { Side { distance: 0.0, scale: [1.0, 1.0], shift: [0.0, 0.0], twist: 0.0, bulge: 0.0 } } }

impl Side {
    fn plain(&self) -> bool { self.scale == [1.0, 1.0] && self.shift == [0.0, 0.0] && self.twist == 0.0 && self.bulge == 0.0 }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Extrude {
    pub profile: ProfileRef,
    /// Along the sketch plane's normal.
    pub forward: Side,
    /// Against it.
    pub backward: Side,
    pub op: BodyOp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// A line in the sketch to revolve about: a line entity, or a point and direction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AxisRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
    pub origin: [f64; 2],
    pub dir: [f64; 2],
}

impl Default for AxisRef { fn default() -> Self { AxisRef { entity: None, origin: [0.0, 0.0], dir: [0.0, 1.0] } } }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Revolve {
    pub profile: ProfileRef,
    pub axis: AxisRef,
    /// Degrees; the profile sits at 0. More than a turn is allowed (with `pitch`, a coil).
    pub start: f64,
    pub end: f64,
    /// Travel along the axis per full turn: a spring, a thread.
    pub pitch: f64,
    /// Radius multiplier reached at the end: a shell that widens as it turns.
    pub grow: f64,
    /// Flattens the turning circle into an ellipse (1 is round).
    pub squash: f64,
    /// Ripples around the turn: how many, and how deep as a fraction of the radius.
    pub lobes: u32,
    pub lobe_depth: f64,
    pub op: BodyOp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl Default for Revolve {
    fn default() -> Self {
        Revolve { profile: ProfileRef::default(), axis: AxisRef::default(), start: 0.0, end: 360.0, pitch: 0.0, grow: 1.0, squash: 1.0, lobes: 0, lobe_depth: 0.0, op: BodyOp::New, target: None }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LoftSection {
    pub profile: ProfileRef,
    /// Degrees: turns where around the profile the loft's seam starts, twisting the skin.
    #[serde(default)]
    pub spin: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Loft {
    pub sections: Vec<LoftSection>,
    /// Straight skin between sections instead of a smooth one through them.
    pub ruled: bool,
    /// Join the last section back to the first.
    pub closed: bool,
    pub op: BodyOp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PathRef {
    pub sketch: String,
    /// Any entity of the chain to follow; the sketch's first chain if not given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Sweep {
    pub profile: ProfileRef,
    pub path: PathRef,
    /// Degrees the profile turns about the path over its length.
    pub twist: f64,
    /// Profile scale at the end of the path, and (optionally) half way: a horn, a swelling.
    pub scale_end: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_mid: Option<f64>,
    pub op: BodyOp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl Default for Sweep {
    fn default() -> Self { Sweep { profile: ProfileRef::default(), path: PathRef::default(), twist: 0.0, scale_end: 1.0, scale_mid: None, op: BodyOp::New, target: None } }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Axis3 { X, #[default] Y, Z }

impl Axis3 { fn index(self) -> usize { match self { Axis3::X => 0, Axis3::Y => 1, Axis3::Z => 2 } } }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeformKind { #[default] Twist, Bend, Taper, Shear }

/// Reshapes a body along one of its axes, between `from` and `to` (fractions of its extent, so the
/// effect can cover just one end, and run either way).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Deform {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub kind: DeformKind,
    pub axis: Axis3,
    pub from: f64,
    pub to: f64,
    /// Twist and bend: degrees.
    pub angle: f64,
    /// Bend: the axis the body curls toward.
    pub toward: Axis3,
    /// Taper: cross-section scale reached at `to`, for the two other axes in cyclic order.
    pub scale: [f64; 2],
    /// Shear: cross-section offset reached at `to`.
    pub shift: [f64; 2],
    /// Ease in and out instead of a constant rate.
    pub smooth: bool,
}

impl Default for Deform {
    fn default() -> Self {
        Deform { target: None, kind: DeformKind::Twist, axis: Axis3::Y, from: 0.0, to: 1.0, angle: 0.0, toward: Axis3::X, scale: [1.0, 1.0], shift: [0.0, 0.0], smooth: false }
    }
}

/// Reflects a body across a plane. `scale` and `shift` (in the plane's own axes: x, y in it, z out
/// of it) are applied to the reflected half only, so it stays attached at the plane but need not match.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Mirror {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub plane: PlaneSpec,
    pub scale: [f64; 3],
    pub shift: [f64; 3],
    /// Fuse the reflection into the body; otherwise it becomes a body of its own.
    pub merge: bool,
}

impl Default for Mirror {
    fn default() -> Self { Mirror { target: None, plane: PlaneSpec { base: BasePlane::Side, ..PlaneSpec::default() }, scale: [1.0; 3], shift: [0.0; 3], merge: true } }
}

// --- Evaluation --------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default)]
pub struct Options {
    pub tolerance: Tolerance,
    /// Evaluate sketches only (while one is being drawn); bodies are left out.
    pub sketches_only: bool,
}

#[derive(Clone, Debug)]
pub struct SketchEval { pub id: String, pub frame: Frame, pub geom: Arc<SketchGeom> }

#[derive(Clone, Debug)]
pub struct Body {
    pub id: String,
    pub name: String,
    pub mesh: Arc<Mesh>,
    /// Changes whenever the mesh does: lets a viewer skip re-uploading unchanged bodies.
    pub key: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Issue { pub feature: String, pub message: String }

#[derive(Clone, Debug, Default)]
pub struct Evaluation {
    pub sketches: Vec<SketchEval>,
    pub bodies: Vec<Body>,
    pub issues: Vec<Issue>,
}

/// Evaluates documents, remembering what it built: editing one feature rebuilds only what depends
/// on it, and undo lands on meshes that are still here.
#[derive(Default)]
pub struct Evaluator {
    sketches: HashMap<u64, (Arc<SketchGeom>, u64)>,
    meshes: HashMap<u64, (Arc<Mesh>, u64)>,
    generation: u64,
    /// Meshes built (not reused) by the last evaluation.
    pub built: usize,
}

fn hash_of(parts: &[&dyn Fn(&mut std::collections::hash_map::DefaultHasher)]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for p in parts { p(&mut h); }
    h.finish()
}

impl Evaluator {
    pub fn evaluate(&mut self, doc: &Document, opts: &Options) -> Evaluation {
        self.generation += 1;
        self.built = 0;
        let gen = self.generation;
        let tol_key = (opts.tolerance.chord.to_bits(), opts.tolerance.angle.to_bits());
        let mut out = Evaluation::default();
        let mut sketch_keys: HashMap<&str, u64> = HashMap::new();
        let mut seen = std::collections::HashSet::new();
        for f in &doc.features {
            if !seen.insert(f.id.as_str()) { out.issues.push(Issue { feature: f.id.clone(), message: "another feature already has this id".into() }); continue; }
            if f.suppressed { continue; }
            let text = serde_json::to_string(&f.kind).unwrap_or_default();
            if let FeatureKind::Sketch(s) = &f.kind {
                let key = hash_of(&[&|h| text.hash(h), &|h| tol_key.hash(h)]);
                let geom = match self.sketches.get_mut(&key) {
                    Some(hit) => { hit.1 = gen; hit.0.clone() }
                    None => { let g = Arc::new(s.sketch.evaluate(opts.tolerance)); self.sketches.insert(key, (g.clone(), gen)); g }
                };
                for msg in &geom.issues { out.issues.push(Issue { feature: f.id.clone(), message: msg.clone() }); }
                sketch_keys.insert(&f.id, key);
                out.sketches.push(SketchEval { id: f.id.clone(), frame: s.plane.frame(), geom });
                continue;
            }
            if opts.sketches_only { continue; }
            // Everything this feature's result depends on, hashed: itself, its sketches, its target.
            let (op, target) = match &f.kind {
                FeatureKind::Extrude(e) => (e.op, &e.target),
                FeatureKind::Revolve(r) => (r.op, &r.target),
                FeatureKind::Loft(l) => (l.op, &l.target),
                FeatureKind::Sweep(s) => (s.op, &s.target),
                FeatureKind::Deform(d) => (BodyOp::Add, &d.target),
                FeatureKind::Mirror(m) => (BodyOp::Add, &m.target),
                FeatureKind::Sketch(_) => unreachable!(),
            };
            let modifies = matches!(f.kind, FeatureKind::Deform(_) | FeatureKind::Mirror(_));
            let target_index = match target {
                Some(id) => out.bodies.iter().position(|b| b.id == *id),
                None => out.bodies.len().checked_sub(1),
            };
            if let (Some(id), None) = (target, target_index) {
                out.issues.push(Issue { feature: f.id.clone(), message: format!("there is no body {id} to work on") });
                continue;
            }
            if target_index.is_none() && (modifies || matches!(op, BodyOp::Cut | BodyOp::Intersect)) {
                out.issues.push(Issue { feature: f.id.clone(), message: "there is no body yet to work on".into() });
                continue;
            }
            let used: Vec<u64> = sketch_refs(&f.kind).iter().map(|id| sketch_keys.get(id.as_str()).copied().unwrap_or(0)).collect();
            let tool_key = hash_of(&[&|h| text.hash(h), &|h| tol_key.hash(h), &|h| used.hash(h), &|h| f.id.hash(h)]);
            let joins = !modifies && op != BodyOp::New && target_index.is_some();
            let target_key = if modifies || joins { out.bodies[target_index.unwrap()].key } else { 0 };
            let key = hash_of(&[&|h| tool_key.hash(h), &|h| target_key.hash(h)]);
            let cached = self.meshes.get_mut(&key).map(|hit| { hit.1 = gen; hit.0.clone() });
            let mesh = match cached {
                Some(m) => Ok(m),
                None => {
                    self.built += 1;
                    let built = match &f.kind {
                        FeatureKind::Deform(d) => deform(&out.bodies[target_index.unwrap()].mesh, d, opts.tolerance),
                        FeatureKind::Mirror(m) => Ok(mirror(&out.bodies[target_index.unwrap()].mesh, m)),
                        kind => solid(kind, &f.id, &out.sketches, opts.tolerance).map(|tool| {
                            if !joins { return tool; }
                            let op = match op { BodyOp::Cut => BoolOp::Subtract, BodyOp::Intersect => BoolOp::Intersect, _ => BoolOp::Union };
                            boolean(&out.bodies[target_index.unwrap()].mesh, &tool, op)
                        }),
                    };
                    built.map(|m| { let m = Arc::new(m); self.meshes.insert(key, (m.clone(), gen)); m })
                }
            };
            match mesh {
                Err(message) => out.issues.push(Issue { feature: f.id.clone(), message }),
                Ok(mesh) => {
                    let separate = matches!(&f.kind, FeatureKind::Mirror(m) if !m.merge);
                    if (modifies && !separate) || joins {
                        let b = &mut out.bodies[target_index.unwrap()];
                        b.mesh = mesh;
                        b.key = key;
                    } else {
                        out.bodies.push(Body { id: f.id.clone(), name: f.name.clone(), mesh, key });
                    }
                }
            }
        }
        out.bodies.retain(|b| !b.mesh.is_empty());
        // Keep what the last few evaluations used (undo, redo, a drag back and forth).
        self.sketches.retain(|_, v| v.1 + 8 > gen);
        if self.meshes.len() > 96 { self.meshes.retain(|_, v| v.1 + 8 > gen); }
        out
    }
}

/// Sketch ids a feature reads.
pub fn sketch_refs(kind: &FeatureKind) -> Vec<String> {
    match kind {
        FeatureKind::Extrude(e) => vec![e.profile.sketch.clone()],
        FeatureKind::Revolve(r) => vec![r.profile.sketch.clone()],
        FeatureKind::Loft(l) => l.sections.iter().map(|s| s.profile.sketch.clone()).collect(),
        FeatureKind::Sweep(s) => vec![s.profile.sketch.clone(), s.path.sketch.clone()],
        _ => Vec::new(),
    }
}

fn find<'a>(sketches: &'a [SketchEval], id: &str) -> Result<&'a SketchEval, String> {
    sketches.iter().find(|s| s.id == id).ok_or_else(|| if id.is_empty() { "no sketch chosen".to_string() } else { format!("there is no sketch {id}") })
}

fn regions<'a>(sketches: &'a [SketchEval], profile: &ProfileRef) -> Result<(&'a SketchEval, Vec<&'a Region>), String> {
    let s = find(sketches, &profile.sketch)?;
    let picked: Vec<&Region> = s.geom.regions.iter().filter(|r| profile.regions.is_empty() || profile.regions.contains(&r.key)).collect();
    if picked.is_empty() {
        return Err(if s.geom.regions.is_empty() { "the sketch has no closed profile yet: join its curves end to end, or draw a circle or closed spline".into() } else { "the chosen regions are no longer in the sketch".into() });
    }
    Ok((s, picked))
}

fn solid(kind: &FeatureKind, id: &str, sketches: &[SketchEval], tol: Tolerance) -> Result<Mesh, String> {
    match kind {
        FeatureKind::Extrude(e) => extrude(e, id, sketches),
        FeatureKind::Revolve(r) => revolve(r, id, sketches, tol),
        FeatureKind::Loft(l) => loft(l, id, sketches),
        FeatureKind::Sweep(s) => sweep(s, id, sketches),
        _ => Err("not a solid feature".into()),
    }
}

/// The loops of a region, outer first, with the face each column belongs to.
fn region_loops<'a>(r: &'a Region) -> impl Iterator<Item = &'a Path2> { std::iter::once(&r.outer).chain(r.holes.iter()) }

fn side_faces(mesh: &mut Mesh, id: &str, geom: &SketchGeom, path: &Path2) -> Vec<u32> {
    path.source.iter().map(|s| mesh.face_id(id, format!("side:{}", geom.entities.get(*s as usize).map_or("?", |e| e.id.as_str())))).collect()
}

/// Sweeps every loop of the regions through `place` (ring index, sketch point) -> world, and caps
/// the ends unless the rings wrap.
#[allow(clippy::too_many_arguments)]
fn sweep_regions(mesh: &mut Mesh, id: &str, s: &SketchEval, picked: &[&Region], rows: usize, row_crease: &[bool], closed_v: bool, place: &dyn Fn(usize, V2) -> V3, normals: (V3, V3), reversed: bool, twisting: bool) {
    // A straight edge that turns as it travels sweeps a saddle, which two triangles can't follow.
    let finest = if twisting { picked.iter().map(|r| r.outer.length()).fold(0.0, f64::max) / 96.0 } else { f64::INFINITY };
    for r in picked {
        let mut first: Vec<Vec<V3>> = Vec::new();
        let mut last: Vec<Vec<V3>> = Vec::new();
        let mut flat: Vec<Vec<V2>> = Vec::new();
        for path in region_loops(r) {
            // A profile that faces against its direction of travel is walked the other way round.
            let path = if reversed { path.reversed() } else { path.clone() };
            let path = if twisting { path.densified(finest) } else { path };
            let rings: Vec<Vec<V3>> = (0..rows).map(|i| path.pts.iter().map(|p| place(i, *p)).collect()).collect();
            let col_face = side_faces(mesh, id, &s.geom, &path);
            mesh.add_grid(&Grid { rings: &rings, closed_u: true, closed_v, col_crease: &path.corner, row_crease, col_face: &col_face });
            first.push(rings[0].clone());
            last.push(rings[rows - 1].clone());
            flat.push(path.pts);
        }
        if closed_v { continue; }
        let (start, end) = (mesh.face_id(id, "start"), mesh.face_id(id, "end"));
        let flat: Vec<&[V2]> = flat.iter().map(|l| l.as_slice()).collect();
        mesh.add_cap(&first.iter().map(|l| l.as_slice()).collect::<Vec<_>>(), &flat, normals.0, start, !reversed);
        mesh.add_cap(&last.iter().map(|l| l.as_slice()).collect::<Vec<_>>(), &flat, normals.1, end, reversed);
    }
}

fn profile_center(picked: &[&Region]) -> V2 {
    let area: f64 = picked.iter().map(|r| r.area).sum();
    picked.iter().fold(V2::default(), |c, r| c + r.centroid * r.area) / area.max(1e-300)
}

fn extrude(e: &Extrude, id: &str, sketches: &[SketchEval]) -> Result<Mesh, String> {
    let (s, picked) = regions(sketches, &e.profile)?;
    let (fwd, back) = (e.forward, e.backward);
    if !(fwd.distance >= 0.0 && back.distance >= 0.0) { return Err("distances can't be negative: use the backward side instead".into()); }
    if fwd.distance + back.distance < 1e-9 { return Err("give the extrude a distance".into()); }
    let center = profile_center(&picked);
    // Rings from the far backward end, through the sketch plane, to the far forward end: (height, side, t).
    let layers = |side: &Side| if side.distance < 1e-9 { 0 } else if side.plain() { 1 } else { (((side.twist.abs() / 4.0).ceil() as usize).max(if side.bulge != 0.0 { 20 } else { 1 })).clamp(1, 180) };
    let (nb, nf) = (layers(&back), layers(&fwd));
    let mut rings: Vec<(f64, bool, f64)> = Vec::new();
    for k in (1..=nb).rev() { let t = k as f64 / nb as f64; rings.push((-back.distance * t, false, t)); }
    let through = nb > 0 && nf > 0;
    let seam = through && !(fwd.plain() && back.plain());
    if !through || seam { rings.push((0.0, true, 0.0)); }
    let base = rings.len() - 1;
    for k in 1..=nf { let t = k as f64 / nf as f64; rings.push((fwd.distance * t, true, t)); }
    let mut row_crease = vec![false; rings.len()];
    if seam { row_crease[base] = true; }
    let place = |i: usize, p: V2| -> V3 {
        let (h, forward, t) = rings[i];
        let side = if forward { &fwd } else { &back };
        let swell = side.bulge * (std::f64::consts::PI * t).sin();
        let scale = v2(1.0 + (side.scale[0] - 1.0) * t + swell, 1.0 + (side.scale[1] - 1.0) * t + swell);
        let d = p - center;
        let q = center + v2(d.x * scale.x, d.y * scale.y).rotate((side.twist * t).to_radians()) + V2::from(side.shift) * t;
        s.frame.point(q) + s.frame.z * h
    };
    let mut mesh = Mesh::default();
    sweep_regions(&mut mesh, id, s, &picked, rings.len(), &row_crease, false, &place, (-s.frame.z, s.frame.z), false, fwd.twist != 0.0 || back.twist != 0.0);
    Ok(mesh)
}

fn revolve(r: &Revolve, id: &str, sketches: &[SketchEval], tol: Tolerance) -> Result<Mesh, String> {
    let (s, picked) = regions(sketches, &r.profile)?;
    let (origin, dir) = match &r.axis.entity {
        Some(e) => {
            let eg = s.geom.entities.iter().find(|g| g.id == *e).ok_or_else(|| format!("the axis {e} is no longer in the sketch"))?;
            if eg.curve.degree != 1 { return Err("the axis has to be a straight line".into()); }
            let (a, b) = (eg.curve.start(), eg.curve.end());
            (v2(a.x, a.y), v2(b.x - a.x, b.y - a.y).norm())
        }
        None => (V2::from(r.axis.origin), V2::from(r.axis.dir).norm()),
    };
    if dir.len() < 0.5 { return Err("the axis has no direction".into()); }
    let (start, end) = if r.end >= r.start { (r.start, r.end) } else { (r.end, r.start) };
    let span = end - start;
    if span < 1e-6 { return Err("give the revolve an angle".into()); }
    // Radial direction such that turning from it toward the plane's normal is counter-clockwise about the axis.
    let radial = v2(dir.y, -dir.x);
    let (d3, e3, z3) = (s.frame.x * dir.x + s.frame.y * dir.y, s.frame.x * radial.x + s.frame.y * radial.y, s.frame.z);
    let a3 = s.frame.point(origin);
    let mut crosses = (false, false);
    for reg in &picked { for p in &reg.outer.pts { let rr = (*p - origin).dot(radial); if rr > 1e-6 { crosses.0 = true; } if rr < -1e-6 { crosses.1 = true; } } }
    if crosses.0 && crosses.1 { return Err("the profile crosses the axis: keep it to one side".into()); }
    // On the far side of the axis the same turn carries the profile the other way through space.
    let far_side = crosses.1;
    let closed = span >= 360.0 - 1e-9 && r.pitch == 0.0 && r.grow == 1.0;
    let span = if closed { 360.0 } else { span };
    let per_turn = ((std::f64::consts::TAU / tol.angle).ceil() as usize).max(12).max(r.lobes as usize * 16);
    let steps = ((span / 360.0 * per_turn as f64).ceil() as usize).max(2);
    let rows = if closed { steps } else { steps + 1 };
    let squash = if r.squash > 1e-6 { r.squash } else { 1.0 };
    let spoke = |theta: f64| e3 * theta.cos() + z3 * (theta.sin() * squash);
    let place = |i: usize, p: V2| -> V3 {
        let t = i as f64 / steps as f64;
        let theta = (start + span * t).to_radians();
        let q = p - origin;
        let lobe = 1.0 + r.lobe_depth * (r.lobes as f64 * theta).cos();
        let radius = q.dot(radial) * lobe * (1.0 + (r.grow - 1.0) * t);
        a3 + d3 * (q.dot(dir) + r.pitch * span * t / 360.0) + spoke(theta) * radius
    };
    let forward = |theta: f64| spoke(theta).norm().cross(d3).norm();
    let mut mesh = Mesh::default();
    sweep_regions(&mut mesh, id, s, &picked, rows, &[], closed, &place, if far_side { (forward(start.to_radians()), -forward(end.to_radians())) } else { (-forward(start.to_radians()), forward(end.to_radians())) }, far_side, false);
    Ok(mesh)
}

/// A closed loop re-walked from a chosen start, with every vertex's position along it (0..1).
struct Walk { pts: Vec<V2>, at: Vec<f64>, corners: Vec<f64>, total: f64 }

impl Walk {
    /// `pts` in the order to travel; the walk starts where the ray from `center` at `angle` leaves the loop.
    fn new(pts: &[V2], corner: &[bool], center: V2, angle: f64) -> Walk {
        let n = pts.len();
        let ray = v2(angle.cos(), angle.sin());
        let (mut far, mut seg, mut frac) = (f64::NEG_INFINITY, 0usize, 0.0);
        for i in 0..n {
            let (a, b) = (pts[i] - center, pts[(i + 1) % n] - center);
            let d = b - a;
            let denom = ray.cross(d);
            if denom.abs() < 1e-14 { continue; }
            let (dist, f) = (a.cross(d) / denom, a.cross(ray) / denom);
            if dist > far && (-1e-9..=1.0 + 1e-9).contains(&f) { far = dist; seg = i; frac = f.clamp(0.0, 1.0); }
        }
        let mut out = Walk { pts: Vec::with_capacity(n + 2), at: Vec::new(), corners: Vec::new(), total: 0.0 };
        let mut flags = Vec::with_capacity(n + 2);
        let first = pts[seg].lerp(pts[(seg + 1) % n], frac);
        out.pts.push(first);
        flags.push(false);
        for k in 1..=n {
            let i = (seg + k) % n;
            if pts[i].dist(*out.pts.last().unwrap()) < 1e-9 { if corner[i] { *flags.last_mut().unwrap() = true; } continue; }
            out.pts.push(pts[i]);
            flags.push(corner[i]);
        }
        if out.pts.last().unwrap().dist(first) < 1e-9 { if *flags.last().unwrap() { flags[0] = true; } out.pts.pop(); flags.pop(); }
        let m = out.pts.len();
        let mut run = 0.0;
        for i in 0..m { out.at.push(run); run += out.pts[i].dist(out.pts[(i + 1) % m]); }
        out.total = run.max(1e-300);
        for a in &mut out.at { *a /= out.total; }
        out.corners = (0..m).filter(|i| flags[*i]).map(|i| out.at[i]).collect();
        out
    }

    fn sample(&self, s: f64) -> V2 {
        let m = self.pts.len();
        let i = self.at.partition_point(|a| *a <= s).saturating_sub(1).min(m - 1);
        let next = if i + 1 < m { self.at[i + 1] } else { 1.0 };
        let f = if next - self.at[i] < 1e-15 { 0.0 } else { ((s - self.at[i]) / (next - self.at[i])).clamp(0.0, 1.0) };
        self.pts[i].lerp(self.pts[(i + 1) % m], f)
    }
}

fn loft(l: &Loft, id: &str, sketches: &[SketchEval]) -> Result<Mesh, String> {
    if l.sections.len() < 2 { return Err("a loft needs at least two sections".into()); }
    let mut secs: Vec<(&SketchEval, &Region, f64)> = Vec::new();
    for sec in &l.sections {
        let (s, picked) = regions(sketches, &sec.profile)?;
        secs.push((s, picked[0], sec.spin));
    }
    let k = secs.len();
    let closed = l.closed && k >= 3;
    let centers: Vec<V3> = secs.iter().map(|(s, r, _)| s.frame.point(polygon_centroid(&r.outer.pts))).collect();
    // Each section is walked counter-clockwise about the direction the loft travels through it.
    let faces_travel: Vec<bool> = (0..k).map(|i| {
        let (prev, next) = if closed { ((i + k - 1) % k, (i + 1) % k) } else { (i.saturating_sub(1), (i + 1).min(k - 1)) };
        secs[i].0.frame.z.dot(centers[next] - centers[prev]) >= 0.0
    }).collect();
    let holes = secs.iter().map(|s| s.1.holes.len()).min().unwrap();
    let holes = if secs.iter().all(|s| s.1.holes.len() == holes) { holes } else { 0 };
    // Knots across the sections: centripetal in the distance between their centers.
    let mut knot = vec![0.0f64];
    let spans = if closed { k } else { k - 1 };
    for i in 0..spans { knot.push(knot[i] + centers[i].dist(centers[(i + 1) % k]).sqrt().max(1e-6)); }
    let smooth = !l.ruled && k > 2;
    let per_span = if smooth { 14 } else { 1 };
    let reference = secs[0].0.frame.x;
    let mut mesh = Mesh::default();
    let face = mesh.face_id(id, "side");
    let mut ends: [(Vec<Vec<V3>>, Vec<Vec<V2>>); 2] = [(Vec::new(), Vec::new()), (Vec::new(), Vec::new())];
    for li in 0..=holes {
        // The same loop of every section, resampled at shared positions so columns line up.
        let walks: Vec<Walk> = (0..k).map(|i| {
            let (_, r, spin) = &secs[i];
            let path = if li == 0 { r.outer.clone() } else { r.holes[li - 1].reversed() };
            // Holes run clockwise in the region; here every loop is walked the same way and holes
            // are flipped back when skinned.
            let path = if faces_travel[i] { path } else { path.reversed() };
            // Seams start in the same world direction (the first section's x axis, as seen in each
            // plane), so sketches drawn on turned planes still line up; `spin` turns from there.
            let f = secs[i].0.frame;
            let along = { let d = v2(reference.dot(f.x), reference.dot(f.y)); if d.len() < 1e-6 { 0.0 } else { d.y.atan2(d.x) } };
            let angle = along + spin.to_radians();
            Walk::new(&path.pts, &path.corner, polygon_centroid(&path.pts), angle)
        }).collect();
        let base = walks.iter().map(|w| w.pts.len()).max().unwrap().clamp(24, 480);
        let mut cols: Vec<(f64, bool)> = walks.iter().flat_map(|w| w.corners.iter().map(|c| (*c, true))).collect();
        cols.sort_by(|a, b| a.0.total_cmp(&b.0));
        cols.dedup_by(|a, b| (a.0 - b.0).abs() < 1e-9);
        let corners = cols.clone();
        for j in 0..base {
            let s = j as f64 / base as f64;
            let near = corners.iter().any(|c| { let d = (c.0 - s).abs(); d.min(1.0 - d) < 0.4 / base as f64 });
            if !near { cols.push((s, false)); }
        }
        cols.sort_by(|a, b| a.0.total_cmp(&b.0));
        let section_ring = |i: usize| -> Vec<V3> { cols.iter().map(|c| secs[i].0.frame.point(walks[i].sample(c.0))).collect() };
        let section_rings: Vec<Vec<V3>> = (0..k).map(section_ring).collect();
        let flat = |i: usize| -> Vec<V2> { cols.iter().map(|c| walks[i].sample(c.0)).collect() };
        // Rings between sections: a Catmull-Rom spline through each column.
        let mut rings: Vec<Vec<V3>> = Vec::new();
        let mut row_crease: Vec<bool> = Vec::new();
        for sp in 0..spans {
            let (i1, i2) = (sp, (sp + 1) % k);
            let (i0, i3) = if closed { ((sp + k - 1) % k, (sp + 2) % k) } else { (sp.saturating_sub(1), (sp + 2).min(k - 1)) };
            let (t1, t2) = (knot[sp], knot[sp + 1]);
            let t0 = if closed { t1 - (knot[(sp + spans - 1) % spans + 1] - knot[(sp + spans - 1) % spans]) } else if sp == 0 { t1 - (t2 - t1) } else { knot[sp - 1] };
            let t3 = if closed { t2 + (knot[(sp + 1) % spans + 1] - knot[(sp + 1) % spans]) } else if sp + 2 > spans { t2 + (t2 - t1) } else { knot[sp + 2] };
            for step in 0..per_span {
                let u = step as f64 / per_span as f64;
                row_crease.push(step == 0 && !smooth);
                if step == 0 { rings.push(section_rings[i1].clone()); continue; }
                let t = t1 + (t2 - t1) * u;
                rings.push((0..cols.len()).map(|j| {
                    let (p1, p2) = (section_rings[i1][j], section_rings[i2][j]);
                    // Past an open end, the missing neighbour is the end mirrored through it.
                    let p0 = if !closed && sp == 0 { p1 * 2.0 - p2 } else { section_rings[i0][j] };
                    let p3 = if !closed && sp + 2 > spans { p2 * 2.0 - p1 } else { section_rings[i3][j] };
                    let a1 = p0 * ((t1 - t) / (t1 - t0)) + p1 * ((t - t0) / (t1 - t0));
                    let a2 = p1 * ((t2 - t) / (t2 - t1)) + p2 * ((t - t1) / (t2 - t1));
                    let a3 = p2 * ((t3 - t) / (t3 - t2)) + p3 * ((t - t2) / (t3 - t2));
                    let b1 = a1 * ((t2 - t) / (t2 - t0)) + a2 * ((t - t0) / (t2 - t0));
                    let b2 = a2 * ((t3 - t) / (t3 - t1)) + a3 * ((t - t1) / (t3 - t1));
                    b1 * ((t2 - t) / (t2 - t1)) + b2 * ((t - t1) / (t2 - t1))
                }).collect());
            }
        }
        if !closed { rings.push(section_rings[k - 1].clone()); row_crease.push(false); }
        if li > 0 { for r in &mut rings { r.reverse(); } }
        let mut col_crease: Vec<bool> = cols.iter().map(|c| c.1).collect();
        if li > 0 { col_crease.reverse(); }
        mesh.add_grid(&Grid { rings: &rings, closed_u: true, closed_v: closed, col_crease: &col_crease, row_crease: &row_crease, col_face: &vec![face; cols.len()] });
        for (e, i) in [(0usize, 0usize), (1, k - 1)] {
            let (mut ring3, mut ring2) = (section_rings[i].clone(), flat(i));
            if li > 0 { ring3.reverse(); ring2.reverse(); }
            ends[e].0.push(ring3);
            ends[e].1.push(ring2);
        }
    }
    if !closed {
        let (start, end) = (mesh.face_id(id, "start"), mesh.face_id(id, "end"));
        for (e, i, f) in [(0usize, 0usize, start), (1, k - 1, end)] {
            let z = if faces_travel[i] { secs[i].0.frame.z } else { -secs[i].0.frame.z };
            let l3: Vec<&[V3]> = ends[e].0.iter().map(|l| l.as_slice()).collect();
            let l2: Vec<&[V2]> = ends[e].1.iter().map(|l| l.as_slice()).collect();
            // Triangles come out counter-clockwise in the sketch: that faces +z of its frame.
            let faces_out = (e == 1) == faces_travel[i];
            mesh.add_cap(&l3, &l2, if e == 0 { -z } else { z }, f, !faces_out);
        }
    }
    Ok(mesh)
}

fn sweep(sw: &Sweep, id: &str, sketches: &[SketchEval]) -> Result<Mesh, String> {
    let (s, picked) = regions(sketches, &sw.profile)?;
    let ps = find(sketches, &sw.path.sketch)?;
    if ps.id == s.id { return Err("the path has to be in a different sketch from the profile".into()); }
    // The chain (or closed loop) holding the named entity, else the first there is.
    let wanted = |ids: &[String]| sw.path.entity.as_ref().map_or(true, |e| ids.contains(e));
    let (path, closed) = match ps.geom.chains.iter().find(|c| wanted(&c.entities)) {
        Some(c) => (&c.path, false),
        None => match ps.geom.loops.iter().find(|l| wanted(&l.entities)) {
            Some(l) => (&l.path, true),
            None => return Err("the path sketch has no curve to follow".into()),
        },
    };
    // Start the path where the profile is: at the nearer end of an open path, at the nearest
    // point of a closed one.
    let home = s.frame.point(profile_center(&picked));
    let gap = |p: &V2| ps.frame.point(*p).dist(home);
    let mut path = path.clone();
    if closed {
        let nearest = (0..path.pts.len()).min_by(|a, b| gap(&path.pts[*a]).total_cmp(&gap(&path.pts[*b]))).unwrap();
        path.pts.rotate_left(nearest);
        path.corner.rotate_left(nearest);
        path.source.rotate_left(nearest);
    } else if gap(path.pts.last().unwrap()) < gap(&path.pts[0]) {
        path = path.reversed();
    }
    let n0 = path.pts.len();
    let segs0 = if closed { n0 } else { n0 - 1 };
    let total: f64 = (0..segs0).map(|i| path.pts[i].dist(path.pts[(i + 1) % n0])).sum();
    if total < 1e-9 { return Err("the path has no length".into()); }
    // Straight runs need rings of their own for a twist or a swell to show.
    let varies = sw.scale_end != 1.0 || sw.scale_mid.is_some();
    let pieces = ((sw.twist.abs() / 4.0).ceil() as usize).max(if varies { 32 } else { 1 });
    let step = total / pieces as f64;
    let mut pts: Vec<V3> = Vec::new();
    let mut crease: Vec<bool> = Vec::new();
    for i in 0..segs0 {
        let (a, b) = (ps.frame.point(path.pts[i]), ps.frame.point(path.pts[(i + 1) % n0]));
        let k = (a.dist(b) / step).ceil().max(1.0) as usize;
        for j in 0..k { pts.push(a.lerp(b, j as f64 / k as f64)); crease.push(j == 0 && path.corner[i] && (closed || i > 0)); }
    }
    if !closed { pts.push(ps.frame.point(path.pts[n0 - 1])); crease.push(false); }
    let n = pts.len();
    let tangent = |i: usize| -> V3 {
        let (a, b) = if closed { (pts[(i + n - 1) % n], pts[(i + 1) % n]) } else { (pts[i.saturating_sub(1)], pts[(i + 1).min(n - 1)]) };
        (b - a).norm()
    };
    let mut tangents: Vec<V3> = (0..n).map(tangent).collect();
    if !closed && n >= 3 {
        // An end's own chord lags the curve by half a step: extrapolate from the neighbour's tangent.
        if !crease[1] { tangents[0] = (tangents[0] * 2.0 - tangents[1]).norm(); }
        if !crease[n - 2] { tangents[n - 1] = (tangents[n - 1] * 2.0 - tangents[n - 2]).norm(); }
    }
    // A reference direction carried along the path without spinning about it.
    let mut refs = vec![tangents[0].any_perp()];
    let carry = |r: V3, from: V3, to: V3| -> V3 {
        let axis = from.cross(to);
        let s = axis.len();
        if s < 1e-12 { return r; }
        let turned = r.rotate(axis / s, s.atan2(from.dot(to)));
        (turned - to * turned.dot(to)).norm()
    };
    for i in 1..n { refs.push(carry(refs[i - 1], tangents[i - 1], tangents[i])); }
    let mut along = vec![0.0; n];
    for i in 1..n { along[i] = along[i - 1] + pts[i].dist(pts[i - 1]); }
    let length = along[n - 1] + if closed { pts[n - 1].dist(pts[0]) } else { 0.0 };
    // Round a closed path the carried direction may come back turned: unwind that evenly.
    let unwind = if closed {
        let back = carry(refs[n - 1], tangents[n - 1], tangents[0]);
        -back.cross(refs[0]).dot(tangents[0]).atan2(back.dot(refs[0]))
    } else { 0.0 };
    let (t0, r0) = (tangents[0], refs[0]);
    let s0 = t0.cross(r0);
    let mid = sw.scale_mid.unwrap_or(0.5 * (1.0 + sw.scale_end));
    let place_vec = |i: usize, v: V3, scaled: bool| -> V3 {
        let t = along[i] / length;
        let angle = sw.twist.to_radians() * t + unwind * t;
        let scale = if scaled { 1.0 * (2.0 * t - 1.0) * (t - 1.0) + mid * 4.0 * t * (1.0 - t) + sw.scale_end * t * (2.0 * t - 1.0) } else { 1.0 };
        let (a, b, c) = (v.dot(t0), v.dot(r0), v.dot(s0));
        let (sn, cs) = angle.sin_cos();
        let (b, c) = (b * cs - c * sn, b * sn + c * cs);
        let (ti, ri) = (tangents[i], refs[i]);
        (ti * a + ri * b + ti.cross(ri) * c) * scale
    };
    let place = |i: usize, p: V2| -> V3 { pts[i] + place_vec(i, s.frame.point(p) - pts[0], true) };
    let reversed = s.frame.z.dot(t0) < 0.0;
    let z = if reversed { -s.frame.z } else { s.frame.z };
    let mut mesh = Mesh::default();
    sweep_regions(&mut mesh, id, s, &picked, n, &crease, closed, &place, (-place_vec(0, z, false).norm(), place_vec(n - 1, z, false).norm()), reversed, sw.twist != 0.0);
    Ok(mesh)
}

fn deform(body: &Mesh, d: &Deform, tol: Tolerance) -> Result<Mesh, String> {
    let bounds = body.bounds();
    let axis = d.axis.index();
    let (lo, hi) = (bounds.min.get(axis), bounds.max.get(axis));
    if hi - lo < 1e-9 { return Err("the body has no extent along that axis".into()); }
    let (a0, a1) = (lo + d.from * (hi - lo), lo + d.to * (hi - lo));
    if (a1 - a0).abs() < 1e-9 { return Err("the deformer's range is empty: move From and To apart".into()); }
    let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
    let center = bounds.center();
    let ease = |t: f64| if d.smooth { t * t * (3.0 - 2.0 * t) } else { t };
    let progress = |p: V3| ease(((p.get(axis) - a0) / (a1 - a0)).clamp(0.0, 1.0));
    let toward = { let t = d.toward.index(); if t == axis { u } else { t } };
    let (dir, length) = ((a1 - a0).signum(), (a1 - a0).abs());
    let map = |p: V3| -> V3 {
        let mut q = p;
        match d.kind {
            DeformKind::Twist => {
                let (s, c) = (d.angle.to_radians() * progress(p)).sin_cos();
                let (du, dv) = (p.get(u) - center.get(u), p.get(v) - center.get(v));
                q.set(u, center.get(u) + du * c - dv * s);
                q.set(v, center.get(v) + du * s + dv * c);
            }
            DeformKind::Taper => {
                let t = progress(p);
                q.set(u, center.get(u) + (p.get(u) - center.get(u)) * (1.0 + (d.scale[0] - 1.0) * t));
                q.set(v, center.get(v) + (p.get(v) - center.get(v)) * (1.0 + (d.scale[1] - 1.0) * t));
            }
            DeformKind::Shear => {
                let t = progress(p);
                q.set(u, p.get(u) + d.shift[0] * t);
                q.set(v, p.get(v) + d.shift[1] * t);
            }
            DeformKind::Bend => {
                let total = d.angle.to_radians();
                let s = (p.get(axis) - a0) * dir;
                if total.abs() < 1e-9 || s <= 0.0 { return p; }
                let radius = length / total;
                let w = p.get(toward) - center.get(toward);
                let bent = s.min(length);
                let (sn, cs) = (bent / radius).sin_cos();
                let beyond = s - bent;
                q.set(axis, a0 + dir * (sn * (radius - w) + cs * beyond));
                q.set(toward, center.get(toward) + radius - cs * (radius - w) + sn * beyond);
            }
        }
        q
    };
    // Only the edges the deformation actually curves are divided.
    let mut mesh = body.clone();
    mesh.refine_for(map, (tol.chord * 3.0).max(bounds.diagonal() * 2e-4));
    Ok(mesh.mapped(map))
}

fn mirror(body: &Mesh, m: &Mirror) -> Mesh {
    let f = m.plane.frame();
    let copy = body.mapped(|p| {
        let l = f.local(p);
        f.point3(v3(l.x * m.scale[0] + m.shift[0], l.y * m.scale[1] + m.shift[1], -l.z * m.scale[2] + m.shift[2]))
    });
    if m.merge { boolean(body, &copy, BoolOp::Union) } else { copy }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(v: serde_json::Value) -> Document { serde_json::from_value(v).unwrap() }
    fn eval(d: &Document) -> Evaluation { Evaluator::default().evaluate(d, &Options::default()) }
    fn only(e: &Evaluation) -> &Mesh { assert!(e.issues.is_empty(), "{:?}", e.issues); assert_eq!(e.bodies.len(), 1); &e.bodies[0].mesh }

    fn rect_sketch(id: &str, plane: serde_json::Value, x0: f64, y0: f64, x1: f64, y1: f64) -> serde_json::Value {
        json!({"id": id, "type": "sketch", "plane": plane,
            "points": [{"id":"a","x":x0,"y":y0},{"id":"b","x":x1,"y":y0},{"id":"c","x":x1,"y":y1},{"id":"d","x":x0,"y":y1}],
            "entities": [{"id":"ab","type":"line","a":"a","b":"b"},{"id":"bc","type":"line","a":"b","b":"c"},{"id":"cd","type":"line","a":"c","b":"d"},{"id":"da","type":"line","a":"d","b":"a"}]})
    }
    fn circle_sketch(id: &str, plane: serde_json::Value, x: f64, y: f64, r: f64) -> serde_json::Value {
        json!({"id": id, "type": "sketch", "plane": plane, "points": [{"id":"c","x":x,"y":y}], "entities": [{"id":"ring","type":"circle","center":"c","radius":r}]})
    }
    fn outward(m: &Mesh) {
        for t in 0..m.tris.len() {
            let [a, b, c] = m.tri(t);
            let g = (b - a).cross(c - a).norm();
            for v in m.tris[t] { assert!(g.dot(m.normals[v as usize]) > 0.1, "triangle {t} at {a:?} faces away from its normals ({})", g.dot(m.normals[v as usize])); }
        }
    }

    #[test]
    fn the_base_planes_are_right_handed_and_tilt_about_themselves() {
        for base in [BasePlane::Top, BasePlane::Front, BasePlane::Side] {
            let f = PlaneSpec { base, offset: 7.0, ..PlaneSpec::default() }.frame();
            assert!(f.x.cross(f.y).dist(f.z) < 1e-12);
            assert!(f.o.dist(f.z * 7.0) < 1e-12);
        }
        assert_eq!(PlaneSpec::default().frame().z, v3(0.0, 1.0, 0.0), "the top plane faces up");
        let tipped = PlaneSpec { base: BasePlane::Top, offset: 10.0, tilt_x: 90.0, ..PlaneSpec::default() }.frame();
        assert!(tipped.o.dist(v3(0.0, 10.0, 0.0)) < 1e-12 && tipped.x.dist(v3(1.0, 0.0, 0.0)) < 1e-12);
        assert!(tipped.z.dist(v3(0.0, 0.0, 1.0)) < 1e-12, "{:?}", tipped.z);
    }

    #[test]
    fn an_extrude_goes_both_ways_by_different_amounts() {
        let d = doc(json!({"features": [rect_sketch("s", json!({"base":"top"}), 0.0, 0.0, 20.0, 10.0),
            {"id":"e","type":"extrude","profile":{"sketch":"s"},"forward":{"distance":30},"backward":{"distance":5}}]}));
        let e = eval(&d);
        let m = only(&e);
        assert!((m.volume() - 200.0 * 35.0).abs() < 1e-6);
        assert_eq!(m.open_edges(), 0);
        outward(m);
        let b = m.bounds();
        assert!((b.min.y + 5.0).abs() < 1e-9 && (b.max.y - 30.0).abs() < 1e-9, "up from the ground plane: {b:?}");
        // Faces are named after what made them.
        let parts: Vec<&str> = m.faces.iter().map(|f| f.part.as_str()).collect();
        for p in ["side:ab", "side:bc", "side:cd", "side:da", "start", "end"] { assert!(parts.contains(&p), "{parts:?}"); }
        assert_eq!(m.tris.len(), 12, "plain sides need no ring at the sketch plane");
    }

    #[test]
    fn each_side_of_an_extrude_shapes_itself() {
        let d = doc(json!({"features": [rect_sketch("s", json!({"base":"top"}), -10.0, -10.0, 10.0, 10.0),
            {"id":"e","type":"extrude","profile":{"sketch":"s"},
             "forward":{"distance":40,"scale":[0.5,1.0],"shift":[15,0]},"backward":{"distance":10,"twist":45}}]}));
        let e = eval(&d);
        let m = only(&e);
        assert_eq!(m.open_edges(), 0);
        outward(m);
        // Forward: a frustum from 20x20 to 10x20 (mean area 300); backward: a twist keeps area.
        assert!((m.volume() - (300.0 * 40.0 + 400.0 * 10.0)).abs() < 12.0, "{}", m.volume());
        // The top has slid over by the shift and is half as wide.
        let top: Vec<V3> = m.positions.iter().filter(|p| (p.y - 40.0).abs() < 1e-9).copied().collect();
        let (lo, hi) = top.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, p| (a.0.min(p.x), a.1.max(p.x)));
        assert!((lo - 10.0).abs() < 1e-9 && (hi - 20.0).abs() < 1e-9, "{lo}..{hi}");
        // The bottom is turned an eighth: its corners are on the axes.
        let bottom = m.positions.iter().filter(|p| (p.y + 10.0).abs() < 1e-9).map(|p| p.x.abs().max(p.z.abs())).fold(0.0, f64::max);
        assert!((bottom - 200f64.sqrt()).abs() < 1e-9, "{bottom}");
    }

    #[test]
    fn a_bulge_curves_the_walls() {
        let d = doc(json!({"features": [circle_sketch("s", json!({"base":"top"}), 0.0, 0.0, 10.0),
            {"id":"e","type":"extrude","profile":{"sketch":"s"},"forward":{"distance":40,"bulge":0.5}}]}));
        let e = eval(&d);
        let m = only(&e);
        outward(m);
        assert_eq!(m.open_edges(), 0);
        let widest = m.positions.iter().map(|p| p.x.hypot(p.z)).fold(0.0, f64::max);
        assert!((widest - 15.0).abs() < 0.05, "{widest}");
        // Smooth all the way up: only the two rims are drawn.
        assert!(m.edges.iter().all(|s| (s[0].y - s[1].y).abs() < 1e-9));
    }

    #[test]
    fn a_revolve_makes_a_ring_and_stops_where_asked() {
        // A 4 x 6 rectangle, 10 from the axis.
        let sk = rect_sketch("s", json!({"base":"front"}), 10.0, 0.0, 14.0, 6.0);
        let full = doc(json!({"features": [sk.clone(), {"id":"r","type":"revolve","profile":{"sketch":"s"}}]}));
        let e = eval(&full);
        let m = only(&e);
        let ring = std::f64::consts::PI * (14.0f64.powi(2) - 10.0f64.powi(2)) * 6.0;
        assert!((m.volume() - ring).abs() < ring * 2e-3, "{} vs {ring}", m.volume());
        assert_eq!(m.open_edges(), 0);
        outward(m);
        assert!(!m.faces.iter().any(|f| f.part == "start"), "a full turn has no ends");
        // The same profile drawn on the other side of the axis makes the same ring.
        let other = doc(json!({"features": [rect_sketch("s", json!({"base":"front"}), -14.0, 0.0, -10.0, 6.0), {"id":"r","type":"revolve","profile":{"sketch":"s"},"end":200}]}));
        let e = eval(&other);
        let m = only(&e);
        assert!((m.volume() - ring * 200.0 / 360.0).abs() < ring * 2e-3, "{}", m.volume());
        assert_eq!(m.open_edges(), 0);
        outward(m);
        // From -30 to 150 degrees: half the ring, with flat ends.
        let part = doc(json!({"features": [sk, {"id":"r","type":"revolve","profile":{"sketch":"s"},"start":-30,"end":150}]}));
        let e = eval(&part);
        let m = only(&e);
        assert!((m.volume() - ring / 2.0).abs() < ring * 2e-3);
        assert_eq!(m.open_edges(), 0);
        outward(m);
        assert!(m.faces.iter().any(|f| f.part == "start") && m.faces.iter().any(|f| f.part == "end"));
    }

    #[test]
    fn a_revolve_squashes_lobes_and_coils() {
        let sk = circle_sketch("s", json!({"base":"front"}), 20.0, 0.0, 3.0);
        let squashed = doc(json!({"features": [sk.clone(), {"id":"r","type":"revolve","profile":{"sketch":"s"},"squash":0.5}]}));
        let e = eval(&squashed);
        let b = only(&e).bounds();
        assert!((b.max.x - 23.0).abs() < 0.02 && (b.max.z - 11.5).abs() < 0.02, "an elliptical ring: {b:?}");
        let lobed = doc(json!({"features": [sk.clone(), {"id":"r","type":"revolve","profile":{"sketch":"s"},"lobes":5,"lobeDepth":0.2}]}));
        let e = eval(&lobed);
        let m = only(&e);
        outward(m);
        let radii: Vec<f64> = m.positions.iter().filter(|p| p.y.abs() < 1e-6).map(|p| p.x.hypot(p.z)).collect();
        let (lo, hi) = radii.iter().fold((f64::INFINITY, 0.0f64), |a, r| (a.0.min(*r), a.1.max(*r)));
        assert!((hi - 23.0 * 1.2).abs() < 0.05 && (lo - 17.0 * 0.8).abs() < 0.05, "{lo}..{hi}");
        // Three turns climbing 10 a turn: a coil, capped at both ends.
        let coil = doc(json!({"features": [sk, {"id":"r","type":"revolve","profile":{"sketch":"s"},"end":1080,"pitch":10}]}));
        let e = eval(&coil);
        let m = only(&e);
        assert_eq!(m.open_edges(), 0);
        outward(m);
        let b = m.bounds();
        assert!((b.max.y - 33.0).abs() < 0.05 && (b.min.y + 3.0).abs() < 0.05, "{b:?}");
        let length = 3.0 * ((std::f64::consts::TAU * 20.0).powi(2) + 100.0f64).sqrt();
        let tube = std::f64::consts::PI * 9.0 * length;
        assert!((m.volume() - tube).abs() < tube * 0.01, "{} vs {tube}", m.volume());
    }

    #[test]
    fn a_revolve_refuses_a_profile_across_its_axis() {
        let d = doc(json!({"features": [rect_sketch("s", json!({"base":"front"}), -5.0, 0.0, 5.0, 6.0), {"id":"r","type":"revolve","profile":{"sketch":"s"}}]}));
        let e = eval(&d);
        assert!(e.bodies.is_empty());
        assert!(e.issues[0].message.contains("crosses the axis"));
    }

    #[test]
    fn a_loft_joins_unlike_profiles_on_unlike_planes() {
        // A square on the ground, a circle above it and off to one side on a tipped plane, a small
        // square higher still: nothing lines up, and the skin still closes.
        let d = doc(json!({"features": [
            rect_sketch("s1", json!({"base":"top"}), -20.0, -20.0, 20.0, 20.0),
            circle_sketch("s2", json!({"base":"top","offset":40,"tiltX":20}), 12.0, 0.0, 14.0),
            rect_sketch("s3", json!({"base":"top","offset":80,"tiltY":-15}), -6.0, -6.0, 6.0, 6.0),
            {"id":"l","type":"loft","sections":[{"profile":{"sketch":"s1"}},{"profile":{"sketch":"s2"}},{"profile":{"sketch":"s3"},"spin":45}]}]}));
        let e = eval(&d);
        let m = only(&e);
        assert_eq!(m.open_edges(), 0);
        outward(m);
        assert!(m.volume() > 40000.0 && m.volume() < 110000.0, "{}", m.volume());
        // The base keeps its four sharp corners exactly.
        for c in [v3(20.0, 0.0, 20.0), v3(-20.0, 0.0, 20.0), v3(20.0, 0.0, -20.0), v3(-20.0, 0.0, -20.0)] {
            assert!(m.positions.iter().any(|p| p.dist(c) < 1e-9), "corner {c:?} was rounded off");
        }
        // It passes through the middle section: points of the circle are on the skin.
        let f2 = e.sketches[1].frame;
        let on_circle = f2.point(v2(26.0, 0.0));
        let nearest = m.positions.iter().map(|p| p.dist(on_circle)).fold(f64::INFINITY, f64::min);
        assert!(nearest < 0.6, "{nearest}");
        // Ruled: straight between sections, so less volume than the smooth skin that swells through them.
        let mut ruled = d.clone();
        if let FeatureKind::Loft(l) = &mut ruled.features[3].kind { l.ruled = true; }
        let r = eval(&ruled);
        assert_eq!(only(&r).open_edges(), 0);
        assert!(only(&r).tris.len() < m.tris.len() / 4);
    }

    #[test]
    fn a_loft_does_not_care_which_way_its_planes_face() {
        // The second section is on a plane flipped upside down (tilted 180): same solid.
        let make = |tilt: f64| doc(json!({"features": [
            circle_sketch("s1", json!({"base":"top"}), 0.0, 0.0, 10.0),
            circle_sketch("s2", json!({"base":"top","offset":30,"tiltX":tilt}), 0.0, 0.0, 10.0),
            {"id":"l","type":"loft","sections":[{"profile":{"sketch":"s1"}},{"profile":{"sketch":"s2"}}]}]}));
        let (up, flipped) = (eval(&make(0.0)), eval(&make(180.0)));
        let cyl = std::f64::consts::PI * 100.0 * 30.0;
        for e in [&up, &flipped] {
            let m = only(e);
            assert!((m.volume() - cyl).abs() < cyl * 4e-3, "{}", m.volume());
            assert_eq!(m.open_edges(), 0);
            outward(m);
        }
    }

    #[test]
    fn a_loft_carries_matching_holes_through() {
        let ring = |id: &str, off: f64, r: f64| json!({"id": id, "type": "sketch", "plane": {"base":"top","offset":off},
            "points": [{"id":"c","x":0,"y":0}], "entities": [{"id":"out","type":"circle","center":"c","radius":r},{"id":"in","type":"circle","center":"c","radius":r * 0.5}]});
        let d = doc(json!({"features": [ring("s1", 0.0, 10.0), ring("s2", 20.0, 10.0), {"id":"l","type":"loft","sections":[{"profile":{"sketch":"s1"}},{"profile":{"sketch":"s2"}}]}]}));
        let e = eval(&d);
        let m = only(&e);
        let tube = std::f64::consts::PI * 75.0 * 20.0;
        assert!((m.volume() - tube).abs() < tube * 3e-3, "{} vs {tube}", m.volume());
        assert_eq!(m.open_edges(), 0);
        outward(m);
    }

    fn sweep_doc(path: serde_json::Value, extra: serde_json::Value) -> Document {
        let mut sweep = json!({"id":"w","type":"sweep","profile":{"sketch":"p"},"path":{"sketch":"path"}});
        for (k, v) in extra.as_object().unwrap() { sweep[k] = v.clone(); }
        doc(json!({"features": [circle_sketch("p", json!({"base":"top"}), 0.0, 0.0, 2.0), path, sweep]}))
    }

    #[test]
    fn a_sweep_follows_a_curve_swelling_and_twisting() {
        // Up from the ground then over in a quarter circle of radius 20.
        let path = json!({"id":"path","type":"sketch","plane":{"base":"front"},
            "points":[{"id":"a","x":0,"y":0},{"id":"b","x":0,"y":30},{"id":"m","x":5.857864376269049,"y":44.14213562373095},{"id":"c","x":20,"y":50}],
            "entities":[{"id":"up","type":"line","a":"a","b":"b"},{"id":"over","type":"arc","a":"b","b":"c","via":"m"}]});
        let plain = sweep_doc(path.clone(), json!({}));
        let e = eval(&plain);
        let m = only(&e);
        let length = 30.0 + std::f64::consts::FRAC_PI_2 * 20.0;
        let tube = std::f64::consts::PI * 4.0 * length;
        assert!((m.volume() - tube).abs() < tube * 5e-3, "{} vs {tube}", m.volume());
        assert_eq!(m.open_edges(), 0);
        outward(m);
        // The far end faces along +x where the arc finishes.
        let end = m.faces.iter().position(|f| f.part == "end").unwrap() as u32;
        let t = (0..m.tris.len()).find(|t| m.face[*t] == end).unwrap();
        assert!(m.normals[m.tris[t][0] as usize].dist(v3(1.0, 0.0, 0.0)) < 5e-3, "{:?}", m.normals[m.tris[t][0] as usize]);
        // A horn: three times as thick at the end.
        let horn = sweep_doc(path, json!({"scaleEnd": 3.0, "twist": 90}));
        let e = eval(&horn);
        let m = only(&e);
        assert_eq!(m.open_edges(), 0);
        outward(m);
        let end_radius = m.positions.iter().filter(|p| (p.x - 20.0).abs() < 1e-6).map(|p| (p.y - 50.0).hypot(p.z)).fold(0.0, f64::max);
        assert!((end_radius - 6.0).abs() < 0.02, "{end_radius}");
    }

    #[test]
    fn a_sweep_round_a_closed_path_meets_itself() {
        let path = json!({"id":"path","type":"sketch","plane":{"base":"front"},
            "points":[{"id":"c","x":30,"y":0}], "entities":[{"id":"loop","type":"circle","center":"c","radius":30}]});
        let e = eval(&sweep_doc(path, json!({})));
        let m = only(&e);
        let torus = std::f64::consts::PI * 4.0 * std::f64::consts::TAU * 30.0;
        assert!((m.volume() - torus).abs() < torus * 5e-3, "{} vs {torus}", m.volume());
        assert_eq!(m.open_edges(), 0);
        outward(m);
    }

    #[test]
    fn cuts_and_joins_follow_the_history() {
        let d = doc(json!({"features": [
            rect_sketch("s1", json!({"base":"top"}), 0.0, 0.0, 40.0, 30.0),
            {"id":"block","name":"Block","type":"extrude","profile":{"sketch":"s1"},"forward":{"distance":10}},
            circle_sketch("s2", json!({"base":"top","offset":10}), 20.0, 15.0, 6.0),
            {"id":"bore","type":"extrude","profile":{"sketch":"s2"},"backward":{"distance":4},"op":"cut"},
            {"id":"boss","type":"extrude","profile":{"sketch":"s2"},"forward":{"distance":5,"scale":[0.5,0.5]},"op":"add"}]}));
        let e = eval(&d);
        assert!(e.issues.is_empty(), "{:?}", e.issues);
        assert_eq!(e.bodies.len(), 1);
        assert_eq!((e.bodies[0].id.as_str(), e.bodies[0].name.as_str()), ("block", "Block"));
        let m = &e.bodies[0].mesh;
        assert_eq!(m.open_edges(), 0);
        // The pocket is flush with the top, and the boss stands on the pocket's rim plane.
        let disc = crate::math::polygon_area(&e.sketches[1].geom.regions[0].outer.pts);
        let boss = disc * 5.0 * (1.0 + 0.5 + 0.25) / 3.0;
        assert!((m.volume() - (12000.0 - disc * 4.0 + boss)).abs() < 1.0, "{}", m.volume());
        assert!(m.faces.iter().any(|f| f.feature == "bore") && m.faces.iter().any(|f| f.feature == "boss"));
        // A cut with nothing to cut says so.
        let lonely = doc(json!({"features": [circle_sketch("s", json!({}), 0.0, 0.0, 5.0), {"id":"c","type":"extrude","profile":{"sketch":"s"},"forward":{"distance":5},"op":"cut"}]}));
        assert!(eval(&lonely).issues[0].message.contains("no body yet"));
    }

    #[test]
    fn deformers_reshape_part_of_a_body() {
        let base = json!([rect_sketch("s", json!({"base":"top"}), -5.0, -5.0, 5.0, 5.0), {"id":"bar","type":"extrude","profile":{"sketch":"s"},"forward":{"distance":100}}]);
        let with = |deform: serde_json::Value| { let mut f = base.as_array().unwrap().clone(); f.push(deform); doc(json!({"features": f})) };
        // Twist the top half a quarter turn: the bottom stays square to the axes, volume is kept.
        let e = eval(&with(json!({"id":"t","type":"deform","kind":"twist","axis":"y","angle":90,"from":0.5,"to":1.0})));
        let m = only(&e);
        assert!((m.volume() - 10000.0).abs() < 25.0, "{}", m.volume());
        assert_eq!(m.open_edges(), 0);
        outward(m);
        for p in &m.positions { if p.y < 50.0 { assert!(p.x.abs() <= 5.0 + 1e-9 && p.z.abs() <= 5.0 + 1e-9); } }
        let half = m.positions.iter().filter(|p| (p.y - 75.0).abs() < 1.0).map(|p| p.x.abs().max(p.z.abs())).fold(0.0, f64::max);
        assert!(half > 6.5, "at 45 degrees the corners stick out: {half}");
        // Bend it a right angle toward +x: the far end points along x.
        let e = eval(&with(json!({"id":"b","type":"deform","kind":"bend","axis":"y","toward":"x","angle":90})));
        let m = only(&e);
        assert_eq!(m.open_edges(), 0);
        outward(m);
        assert!((m.volume() - 10000.0).abs() < 60.0, "{}", m.volume());
        let b = m.bounds();
        let radius = 100.0 / std::f64::consts::FRAC_PI_2;
        assert!((b.max.x - radius).abs() < 0.2 && (b.max.y - (radius + 5.0)).abs() < 0.2, "{b:?}");
        // Taper one cross axis only, and shear: both keep it closed.
        let e = eval(&with(json!({"id":"p","type":"deform","kind":"taper","axis":"y","scale":[0.2,1.0]})));
        let m = only(&e);
        assert!((m.volume() - 10000.0 * 0.6).abs() < 30.0, "{}", m.volume());
        let top: Vec<&V3> = m.positions.iter().filter(|p| p.y > 99.999).collect();
        assert!(top.iter().all(|p| p.z.abs() <= 1.0 + 1e-9) && top.iter().any(|p| p.x.abs() > 4.99), "z (the axis after y) narrows, x keeps its width");
        let e = eval(&with(json!({"id":"h","type":"deform","kind":"shear","axis":"y","shift":[0,30],"smooth":true})));
        assert!((only(&e).volume() - 10000.0).abs() < 25.0);
        assert!((only(&e).bounds().max.x - 35.0).abs() < 1e-6);
    }

    #[test]
    fn a_mirror_can_break_its_own_symmetry() {
        let base = json!([rect_sketch("s", json!({"base":"top"}), 0.0, 0.0, 10.0, 10.0), {"id":"b","type":"extrude","profile":{"sketch":"s"},"forward":{"distance":10}}]);
        let with = |m: serde_json::Value| { let mut f = base.as_array().unwrap().clone(); f.push(m); doc(json!({"features": f})) };
        let e = eval(&with(json!({"id":"m","type":"mirror","plane":{"base":"side"}})));
        let m = only(&e);
        assert!((m.volume() - 2000.0).abs() < 1e-6);
        assert_eq!(m.open_edges(), 0);
        assert!((m.bounds().min.x + 10.0).abs() < 1e-9);
        // The reflected half reaches half again as far and stands taller.
        let e = eval(&with(json!({"id":"m","type":"mirror","plane":{"base":"side"},"scale":[1.0,1.5,1.5]})));
        let m = only(&e);
        assert!((m.volume() - (1000.0 + 15.0 * 15.0 * 10.0)).abs() < 1e-6, "{}", m.volume());
        assert_eq!(m.open_edges(), 0);
        outward(m);
        let b = m.bounds();
        assert!((b.min.x + 15.0).abs() < 1e-9 && (b.max.y - 15.0).abs() < 1e-9 && (b.max.x - 10.0).abs() < 1e-9, "{b:?}");
        // Unmerged, the reflection is its own body.
        let e = eval(&with(json!({"id":"m","name":"Twin","type":"mirror","plane":{"base":"side"},"merge":false})));
        assert_eq!(e.bodies.len(), 2);
        assert_eq!(e.bodies[1].id, "m");
        assert!((e.bodies[1].mesh.volume() - 1000.0).abs() < 1e-6);
    }

    #[test]
    fn only_what_changed_is_rebuilt() {
        let mut d = doc(json!({"features": [
            rect_sketch("s1", json!({"base":"top"}), 0.0, 0.0, 40.0, 30.0),
            {"id":"block","type":"extrude","profile":{"sketch":"s1"},"forward":{"distance":10}},
            circle_sketch("s2", json!({"base":"top"}), 60.0, 0.0, 6.0),
            {"id":"post","type":"extrude","profile":{"sketch":"s2"},"forward":{"distance":20}}]}));
        let mut ev = Evaluator::default();
        let first = ev.evaluate(&d, &Options::default());
        assert_eq!((first.bodies.len(), ev.built), (2, 2));
        ev.evaluate(&d, &Options::default());
        assert_eq!(ev.built, 0);
        if let FeatureKind::Extrude(e) = &mut d.features[3].kind { e.forward.distance = 25.0; }
        let second = ev.evaluate(&d, &Options::default());
        assert_eq!(ev.built, 1);
        assert!(Arc::ptr_eq(&first.bodies[0].mesh, &second.bodies[0].mesh), "the untouched body is the same mesh");
        assert_eq!(first.bodies[0].key, second.bodies[0].key);
        assert_ne!(first.bodies[1].key, second.bodies[1].key);
        // Undo: straight back to the first mesh.
        if let FeatureKind::Extrude(e) = &mut d.features[3].kind { e.forward.distance = 20.0; }
        let third = ev.evaluate(&d, &Options::default());
        assert_eq!(ev.built, 0);
        assert!(Arc::ptr_eq(&first.bodies[1].mesh, &third.bodies[1].mesh));
        // Suppressing a feature and sketch-only evaluation.
        d.features[1].suppressed = true;
        assert_eq!(ev.evaluate(&d, &Options::default()).bodies.len(), 1);
        let sketches = ev.evaluate(&d, &Options { sketches_only: true, ..Options::default() });
        assert_eq!((sketches.sketches.len(), sketches.bodies.len()), (2, 0));
    }

    #[test]
    fn documents_round_trip_and_fill_in_defaults() {
        let d = doc(json!({"features": [
            circle_sketch("s", json!({"base":"side","offset":3,"tiltX":10}), 0.0, 0.0, 5.0),
            {"id":"r","name":"Vase","type":"revolve","profile":{"sketch":"s","regions":["ring"]},"axis":{"origin":[9,0]},"end":270,"lobes":3,"lobeDepth":0.1},
            {"id":"d","type":"deform","kind":"bend","angle":30,"toward":"z"},
            {"id":"m","type":"mirror","suppressed":true}]}));
        let text = serde_json::to_string(&d).unwrap();
        assert_eq!(serde_json::from_str::<Document>(&text).unwrap(), d);
        match &d.features[1].kind {
            FeatureKind::Revolve(r) => { assert_eq!((r.start, r.end, r.grow, r.squash, r.axis.dir), (0.0, 270.0, 1.0, 1.0, [0.0, 1.0])); }
            _ => panic!(),
        }
        assert!(text.contains(r#""tiltX":10"#) && text.contains(r#""lobeDepth":0.1"#));
    }
}
