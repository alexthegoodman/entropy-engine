//! The brass instrument's tubing, laid out from the bore exactly as the DAW's `BrassView` draws it.
//! Lines below the header are copied verbatim from `src/entropy_gui/widgets_brass.rs` (vector
//! helpers, the turtle, each instrument's pieces, `tubing` and `fit_box`), made public here.
#![allow(dead_code)]
use crate::audio::brass::{obstruction, BrassInstrument, Mechanism, Mute, F_SIDE};

pub type V3 = [f32; 3];
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn scale(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> V3 {
    let l = dot(a, a).sqrt().max(1.0e-9);
    scale(a, 1.0 / l)
}


// ------------------------------------------------------------------------------------------
// The tubing, laid out from the bore
// ------------------------------------------------------------------------------------------
//
// Each instrument is a path of straights, bends and coils, walked by a turtle from the mouthpiece
// (at the origin, blowing along +x) to the bell. One piece of each path stretches to make the path
// exactly as long as the air column, so every point sits where that length of bore is, and the
// bore's radius there is the tube's. Valves are detours: each valve's loop is as long as the tube
// it adds, and when the valve is down the path (and the air) goes round it.

/// Length of each slide leg in first position, metres (a tenor trombone's slide is ~0.65 m).
const SLIDE_LEG: f32 = 0.62;
/// Radius of the slide's crook and of the tuning loop behind the player.
const CROOK_R: f32 = 0.05;
const TUNING_R: f32 = 0.09;
/// How far the tubing runs back past the player before the tuning loop.
const BACK_RUN: f32 = 0.30;
/// Drawn radius = `RADIUS_BASE + RADIUS_GAIN * bore radius`: a 7 mm bore would be a hairline at
/// this scale, so narrow tubing is widened more than the bell.
const RADIUS_BASE: f32 = 0.012;
const RADIUS_GAIN: f32 = 1.3;
/// A valve loop: the bends into and out of it, and its U-turn.
const VALVE_BEND: f32 = 0.012;
const VALVE_TURN: f32 = 0.016;
/// Straight between valve casings.
const VALVE_GAP: f32 = 0.018;

/// One sample along the tubing: where it is, which way the air goes, two directions across it,
/// the bore's radius (and the radius left open by a mute or hand there), and how far along the
/// air column (0 = lips, 1 = bell mouth).
#[derive(Clone, Copy, Debug)]
pub struct TubePoint {
    pub pos: V3,
    pub dir: V3,
    pub normal: V3,
    pub binormal: V3,
    pub radius: f32,
    pub open: f32,
    pub along: f32,
}

#[derive(Clone, Copy, Debug)]
enum Piece {
    Straight(f32),
    /// Turn by `angle` (radians, right-handed about `axis`) on a bend of radius `r`.
    Arc { r: f32, angle: f32, axis: V3 },
    /// The stretching piece, as a straight.
    Stretch,
    /// The stretching piece, as `turns` coils about `axis`, advancing `pitch` metres a turn.
    Coil { turns: f32, axis: V3, pitch: f32 },
    /// The valve cluster: loops turned about `axis` (a double horn's F loops about `-axis`).
    Valves { axis: V3 },
}

/// A valve on the drawing: where its casing is, whether it is down, and its name.
#[derive(Clone, Debug)]
pub struct ValveMark {
    pub pos: V3,
    pub down: bool,
    pub label: &'static str,
}

/// The instrument as drawn: the air's path, the valve loops the air isn't in (drawn dim), and the
/// valve casings.
pub struct Tubing {
    pub pts: Vec<TubePoint>,
    pub idle_loops: Vec<Vec<V3>>,
    pub valves: Vec<ValveMark>,
}

fn frame_for(dir: V3) -> (V3, V3) {
    let reference = if dir[2].abs() > 0.9 { [0.0, 1.0, 0.0] } else { [0.0, 0.0, 1.0] };
    let normal = norm(cross(reference, dir));
    (normal, cross(dir, normal))
}

fn rotate(v: V3, axis: V3, angle: f32) -> V3 {
    // Rodrigues, for a unit axis.
    let (s, c) = angle.sin_cos();
    add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1.0 - c)))
}

/// Walks pieces, recording a dense polyline of (position, heading).
struct Turtle {
    pos: V3,
    dir: V3,
    path: Vec<(V3, V3)>,
}

impl Turtle {
    fn new(pos: V3, dir: V3) -> Self {
        Self { pos, dir, path: vec![(pos, dir)] }
    }

    fn straight(&mut self, len: f32) {
        let n = ((len / 0.02).ceil() as usize).max(1);
        for k in 1..=n {
            self.path.push((add(self.pos, scale(self.dir, len * k as f32 / n as f32)), self.dir));
        }
        self.pos = add(self.pos, scale(self.dir, len));
    }

    fn arc(&mut self, r: f32, angle: f32, axis: V3) {
        let side = norm(cross(axis, self.dir));
        let centre = add(self.pos, scale(side, r * angle.signum()));
        let spoke = sub(self.pos, centre);
        let n = ((angle.abs() * r / 0.01).ceil() as usize).clamp(4, 400);
        for k in 1..=n {
            let a = angle * k as f32 / n as f32;
            self.path.push((add(centre, rotate(spoke, axis, a)), rotate(self.dir, axis, a)));
        }
        self.pos = add(centre, rotate(spoke, axis, angle));
        self.dir = rotate(self.dir, axis, angle);
    }

    /// Coils `len` metres into `turns` turns about `axis`, advancing `pitch` a turn, and leaves
    /// heading as it arrived.
    fn coil(&mut self, len: f32, turns: f32, axis: V3, pitch: f32) {
        let per_turn = len / turns.max(0.1);
        let r = (per_turn * per_turn - pitch * pitch).max(1.0e-4).sqrt() / std::f32::consts::TAU;
        let side = norm(cross(axis, self.dir));
        let centre = add(self.pos, scale(side, r));
        let spoke = sub(self.pos, centre);
        let total = std::f32::consts::TAU * turns;
        let n = ((len / 0.01).ceil() as usize).clamp(8, 4000);
        for k in 1..=n {
            let a = total * k as f32 / n as f32;
            let lift = scale(axis, pitch * a / std::f32::consts::TAU);
            self.path.push((add(add(centre, rotate(spoke, axis, a)), lift), rotate(self.dir, axis, a)));
        }
        self.pos = self.path.last().unwrap().0;
        self.dir = rotate(self.dir, axis, total);
    }

    /// A loop of `len` metres turned out along `axis` and back; returns to the line it left,
    /// `valve_width()` further on.
    fn detour(&mut self, len: f32, axis: V3) {
        let pi = std::f32::consts::PI;
        let leg = ((len - pi * (VALVE_BEND + VALVE_TURN)) / 2.0).max(0.0);
        self.arc(VALVE_BEND, pi / 2.0, axis);
        self.straight(leg);
        self.arc(VALVE_TURN, -pi, axis);
        self.straight(leg);
        self.arc(VALVE_BEND, pi / 2.0, axis);
    }
}

/// How far along its line a valve's casing takes (straight through, or round the loop).
fn valve_width() -> f32 {
    2.0 * (VALVE_BEND + VALVE_TURN)
}

/// The valves' loops for an instrument whose open tube is `open` metres: for each valve, its loop
/// on the B♭ (main) side and, on a double horn, on the F side; and the F side's own extra tube.
fn valve_loops(instrument: BrassInstrument, open: f32) -> (Vec<(f32, Option<f32>)>, Option<f32>) {
    let Mechanism::Valves { semitones, f_side } = instrument.mechanism() else { return (Vec::new(), None) };
    let f_open = open * 2f32.powf(5.0 / 12.0);
    let loops = semitones.iter().map(|&st| (open * (2f32.powf(st / 12.0) - 1.0), f_side.then(|| f_open * (2f32.powf(st / 12.0) - 1.0)))).collect();
    (loops, f_side.then(|| f_open - open))
}

const Z: V3 = [0.0, 0.0, 1.0];
const NEG_Z: V3 = [0.0, 0.0, -1.0];
const Y: V3 = [0.0, 1.0, 0.0];

/// The pieces of an instrument's path. On a trombone the slide's legs carry the extension.
fn pieces(instrument: BrassInstrument, extension: f32) -> Vec<Piece> {
    let pi = std::f32::consts::PI;
    match instrument {
        // Mouthpiece, down the inner slide leg, round the crook, back up the outer leg, back past
        // the player to the tuning loop, then forward through the bell section to the mouth.
        BrassInstrument::TenorTrombone => {
            let leg = SLIDE_LEG + extension * 0.5;
            vec![
                Piece::Straight(leg),
                Piece::Arc { r: CROOK_R, angle: pi, axis: Z },
                Piece::Straight(leg + BACK_RUN),
                Piece::Arc { r: TUNING_R, angle: -pi, axis: Z },
                Piece::Stretch,
            ]
        }
        // Leadpipe forward, the tuning slide's crook up and back, the three valves (their slides
        // standing out from the instrument), round the back bow, and the bell forward above.
        BrassInstrument::Trumpet => vec![
            Piece::Straight(0.24),
            Piece::Arc { r: 0.04, angle: pi, axis: Z },
            Piece::Straight(0.03),
            Piece::Valves { axis: Y },
            Piece::Straight(0.03),
            Piece::Arc { r: 0.05, angle: -pi, axis: Z },
            Piece::Stretch,
        ],
        // Leadpipe into the round wrap, the valves (B♭ slides one side, F the other, the thumb
        // valve's long loop), then the bell branch curling down and back: the horn's bell faces
        // behind the player.
        BrassInstrument::Horn => vec![
            Piece::Straight(0.16),
            Piece::Coil { turns: 1.0, axis: Z, pitch: 0.035 },
            Piece::Straight(0.02),
            Piece::Valves { axis: Y },
            Piece::Straight(0.04),
            Piece::Arc { r: 0.2, angle: -pi, axis: Z },
            Piece::Straight(0.2),
        ],
        // Leadpipe, the four valves, the big coils (the bore widening all the way round), and the
        // bell turned upward.
        BrassInstrument::Tuba => vec![
            Piece::Straight(0.14),
            Piece::Valves { axis: NEG_Z },
            Piece::Straight(0.04),
            Piece::Coil { turns: 2.0, axis: Z, pitch: 0.09 },
            Piece::Arc { r: 0.16, angle: pi / 2.0, axis: Z },
            Piece::Straight(0.75),
        ],
    }
}

/// Lays the instrument out for the bore now: `extension` metres added (slide, or valves and
/// their trim), the tuning slide pulled `tuning`, `valves` down (bits as `BrassState::valves`), and
/// the mute or hand the bore carries.
pub fn tubing(instrument: BrassInstrument, extension: f32, tuning: f32, valves: u32, mute: Mute, hand: f32, samples: usize) -> Tubing {
    let base = instrument.profile();
    let profile = base.clone().obstructed(obstruction(mute, hand, base.mouth_radius()));
    let extra = tuning + extension;
    let total = profile.total_length(extra);
    let open = profile.total_length(tuning);
    let (loops, f_loop) = valve_loops(instrument, open);
    let f_side = valves & F_SIDE != 0;
    let pieces = pieces(instrument, extension);
    // How long each piece is, the stretch aside.
    let valve_len = |down: bool, len: f32| if down { len } else { valve_width() };
    let cluster = |loops: &[(f32, Option<f32>)]| -> f32 {
        let mut s = VALVE_GAP * loops.len() as f32;
        for (k, (b, f)) in loops.iter().enumerate() {
            let len = if f_side { f.unwrap_or(*b) } else { *b };
            s += valve_len(valves & (1 << k) != 0, len);
        }
        if let Some(fl) = f_loop {
            s += VALVE_GAP + valve_len(f_side, fl);
        }
        s
    };
    let fixed: f32 = pieces
        .iter()
        .map(|p| match *p {
            Piece::Straight(l) => l,
            Piece::Arc { r, angle, .. } => r * angle.abs(),
            Piece::Valves { .. } => cluster(&loops),
            Piece::Stretch | Piece::Coil { .. } => 0.0,
        })
        .sum();
    let stretch = (total - fixed).max(0.2);

    let mut t = Turtle::new([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]);
    let mut idle_loops = Vec::new();
    let mut marks = Vec::new();
    for p in &pieces {
        match *p {
            Piece::Straight(l) => t.straight(l),
            Piece::Arc { r, angle, axis } => t.arc(r, angle, axis),
            Piece::Stretch => t.straight(stretch),
            Piece::Coil { turns, axis, pitch } => t.coil(stretch, turns, axis, pitch),
            Piece::Valves { axis } => {
                const NAMES: [&str; 4] = ["1", "2", "3", "4"];
                let mut casing = |t: &mut Turtle, down: bool, len: f32, axis: V3, label: &'static str, idle: Option<(f32, V3)>| {
                    t.straight(VALVE_GAP);
                    marks.push(ValveMark { pos: add(t.pos, scale(t.dir, valve_width() * 0.5)), down, label });
                    // A loop the air isn't in is drawn where it hangs, from the same casing.
                    let mut ghost = |len: f32, axis: V3| {
                        let mut g = Turtle::new(t.pos, t.dir);
                        g.detour(len, axis);
                        idle_loops.push(g.path.iter().map(|q| q.0).collect::<Vec<_>>());
                    };
                    if !down {
                        ghost(len, axis);
                    }
                    if let Some((len, axis)) = idle {
                        ghost(len, axis);
                    }
                    if down {
                        t.detour(len, axis);
                    } else {
                        t.straight(valve_width());
                    }
                };
                let other = scale(axis, -1.0);
                for (k, &(b, f)) in loops.iter().enumerate() {
                    let down = valves & (1 << k) != 0;
                    // A double horn's valve has a loop for each side; the air uses the side's own.
                    let (len, ax, idle) = match f {
                        Some(f) if f_side => (f, other, Some((b, axis))),
                        Some(f) => (b, axis, Some((f, other))),
                        None => (b, axis, None),
                    };
                    casing(&mut t, down, len, ax, NAMES[k.min(3)], idle);
                }
                if let Some(fl) = f_loop {
                    casing(&mut t, f_side, fl, other, "T", None);
                }
            }
        }
    }
    // Resample evenly along the path, which is `total` long.
    let mut cum = Vec::with_capacity(t.path.len());
    let mut acc = 0.0f32;
    for (i, q) in t.path.iter().enumerate() {
        if i > 0 {
            let d = sub(q.0, t.path[i - 1].0);
            acc += dot(d, d).sqrt();
        }
        cum.push(acc);
    }
    let path_len = acc.max(1.0e-6);
    let mut j = 0;
    let mut pts: Vec<TubePoint> = (0..samples)
        .map(|k| {
            let u = k as f32 / (samples - 1).max(1) as f32;
            let s = u * path_len;
            while j + 1 < cum.len() - 1 && cum[j + 1] < s {
                j += 1;
            }
            let (a, b) = (t.path[j], t.path[(j + 1).min(t.path.len() - 1)]);
            let span = (cum[(j + 1).min(cum.len() - 1)] - cum[j]).max(1.0e-9);
            let f = ((s - cum[j]) / span).clamp(0.0, 1.0);
            let pos = add(a.0, scale(sub(b.0, a.0), f));
            let dir = norm(add(scale(a.1, 1.0 - f), scale(b.1, f)));
            let (normal, binormal) = frame_for(dir);
            let x = u * total;
            TubePoint { pos, dir, normal, binormal, radius: profile.open_radius_at(x, extra), open: profile.radius_at(x, extra), along: u }
        })
        .collect();
    // Carry the cross-section's frame along the tube (parallel transport), so it turns with the
    // tube instead of flipping where the tube turns out of the instrument's plane.
    for k in 1..pts.len() {
        let (prev, dir) = (pts[k - 1].normal, pts[k].dir);
        let n = sub(prev, scale(dir, dot(prev, dir)));
        if dot(n, n) > 1.0e-8 {
            pts[k].normal = norm(n);
            pts[k].binormal = cross(dir, pts[k].normal);
        }
    }
    Tubing { pts, idle_loops, valves: marks }
}

/// Where the slide's crook is (the handle) for an extension, world units.
pub fn crook_centre(extension: f32) -> V3 {
    [SLIDE_LEG + extension * 0.5 + CROOK_R, CROOK_R, 0.0]
}

pub fn drawn_radius(r: f32) -> f32 {
    RADIUS_BASE + RADIUS_GAIN * r
}

/// The box the camera fits for an instrument: its tubing with every loop, the slide all the way out.
pub fn fit_box(instrument: BrassInstrument) -> (V3, V3) {
    let reach = match instrument.mechanism() {
        Mechanism::Slide => instrument.profile().slide_max,
        Mechanism::Valves { .. } => 0.0,
    };
    let mut lo = [f32::MAX; 3];
    let mut hi = [f32::MIN; 3];
    let mut grow = |p: V3, r: f32| {
        for i in 0..3 {
            lo[i] = lo[i].min(p[i] - r);
            hi[i] = hi[i].max(p[i] + r);
        }
    };
    for e in [0.0, reach] {
        let t = tubing(instrument, e, 0.0, 0, Mute::Open, 0.0, 200);
        for p in &t.pts {
            grow(p.pos, drawn_radius(p.radius));
        }
        for l in &t.idle_loops {
            for p in l {
                grow(*p, RADIUS_BASE);
            }
        }
    }
    grow([-0.05, 0.0, 0.0], 0.03);
    (lo, hi)
}

