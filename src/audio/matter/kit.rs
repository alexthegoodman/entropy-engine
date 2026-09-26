//! A drum kit: every drum and cymbal in one place, ringing in the same air.
//!
//! The pieces are the drums and cymbals of `drum` and `cymbal`, set up where a kit puts them
//! ([`placement`]): the kick on the floor facing the listener, the snare between the drummer's
//! knees, a rack tom over the kick, the floor tom to the right, the cymbals on stands above. The
//! same layout is what the 3D view draws and what the pieces hear of each other: sound leaves each
//! piece and reaches every drum's heads after the time it takes to cross the distance between them,
//! weakened by that distance, so a tom hit makes the snare's wires buzz and a loud kick shakes the
//! toms - the sympathetic ringing of a real kit, from the same `add_pressure` a drum's own air uses,
//! not a separate effect.
//!
//! The kit runs in blocks of [`BLOCK`] samples. No two pieces are closer than a block's worth of
//! sound travel, so within a block every piece depends only on what the others did in earlier
//! blocks: the coupling is exact, and the pieces run side by side, on the audio thread and a few
//! parked worker threads the kit owns (a groove with the cymbals ringing takes more than one core).
//! Each thread always renders the same pieces, so the result is the same however they are timed. A piece that has fallen
//! silent (nothing striking it, its sound below -100 dB of full scale, its energy gone) sleeps and
//! costs nothing until something strikes it or sound loud enough to move it arrives.
//!
//! Nothing here allocates after construction.

use super::contact::StrikeReport;
use super::cymbal::{Cymbal, CymbalSpec};
use super::drum::{Drum, DrumSpec, Strike, StrikerSpec, FULL_SCALE_PA};
use super::membrane::C_AIR;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// Samples per block. Sound crosses `BLOCK / sr` seconds' worth of distance (25 cm at 44.1 kHz)
/// before any piece can hear another, which the layout keeps.
pub const BLOCK: usize = 32;
/// Pieces in a kit.
pub const PIECES: usize = 7;
/// Samples of each piece's sound kept for the others to hear (11.6 ms at 44.1 kHz: 4 m).
const HISTORY: usize = 512;
/// Strikes waiting for the next block, per piece.
const MAX_PENDING: usize = 8;
/// A sleeping drum wakes when sound this loud (Pa) reaches it: about 60 dB SPL, far below anything
/// that could move snare wires (they lift at tens of pascals), well above the noise floor of the
/// modes' arithmetic.
pub const WAKE_PA: f32 = 0.02;
/// A piece falls asleep after this long with its output below `SLEEP_LEVEL` (of full scale) and its
/// energy below `SLEEP_ENERGY` (J), and nothing striking it.
const SLEEP_SECONDS: f32 = 0.05;
const SLEEP_LEVEL: f32 = 1.0e-5;
const SLEEP_ENERGY: f32 = 1.0e-10;
/// A cymbal's von Karman coupling rests once the stretching holds less than this fraction of the
/// plate's energy (see `Cymbal::set_nonlinear_floor`; the tests measure what it changes).
pub const NONLINEAR_FLOOR: f32 = 3.0e-3;
/// Output gain of the kit before the track's own: a hard backbeat peaks near full scale.
pub const KIT_GAIN: f32 = 0.35;

/// Points of the view's field over each head or plate: the centre, then `FIELD_RINGS` rings of
/// `FIELD_SPOKES` points each.
pub const FIELD_RINGS: usize = 6;
pub const FIELD_SPOKES: usize = 24;
pub const FIELD: usize = 1 + FIELD_RINGS * FIELD_SPOKES;
/// Modes the field is drawn from (the lowest of each body: the visible pattern).
const FIELD_MODES: usize = 64;
/// Modes published per piece for the view's spectrum.
pub const SPECTRUM: usize = 48;
/// Samples of the latest strike's contact force kept (46 ms at 44.1 kHz: a kick beater's long
/// contact fits).
pub const TRACE_CAPTURE: usize = 2048;

/// Where field point `i` is: (radius as a fraction of the body's, angle in radians).
pub fn field_point(i: usize) -> (f32, f32) {
    if i == 0 {
        return (0.0, 0.0);
    }
    let ring = (i - 1) / FIELD_SPOKES;
    let spoke = (i - 1) % FIELD_SPOKES;
    ((ring + 1) as f32 / FIELD_RINGS as f32, std::f32::consts::TAU * spoke as f32 / FIELD_SPOKES as f32)
}

/// A piece of the kit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Piece {
    Kick,
    Snare,
    RackTom,
    FloorTom,
    Crash,
    Ride,
    Splash,
}

impl Piece {
    pub const ALL: [Piece; PIECES] = [Piece::Kick, Piece::Snare, Piece::RackTom, Piece::FloorTom, Piece::Crash, Piece::Ride, Piece::Splash];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn from_index(i: usize) -> Piece {
        Self::ALL[i.min(PIECES - 1)]
    }

    pub fn name(self) -> &'static str {
        match self {
            Piece::Kick => "kick",
            Piece::Snare => "snare",
            Piece::RackTom => "rack-tom",
            Piece::FloorTom => "floor-tom",
            Piece::Crash => "crash",
            Piece::Ride => "ride",
            Piece::Splash => "splash",
        }
    }

    pub fn from_name(name: &str) -> Option<Piece> {
        Self::ALL.iter().copied().find(|p| p.name() == name)
    }

    pub fn is_cymbal(self) -> bool {
        matches!(self, Piece::Crash | Piece::Ride | Piece::Splash)
    }

    /// What usually strikes it.
    pub fn default_striker(self) -> StrikerSpec {
        match self {
            Piece::Kick => StrikerSpec::felt_beater(),
            Piece::Crash => StrikerSpec::stick_shoulder(),
            _ => StrikerSpec::stick(),
        }
    }
}

/// A striker by name: "stick", "shoulder" (a stick's taper, as crashes are played), "felt" and
/// "plastic" (kick beaters), "mallet" and "hard-mallet" (timpani mallets), "yarn" (a soft cymbal
/// mallet).
pub fn striker_named(name: &str) -> Option<StrikerSpec> {
    Some(match name {
        "stick" => StrikerSpec::stick(),
        "shoulder" => StrikerSpec::stick_shoulder(),
        "felt" => StrikerSpec::felt_beater(),
        "plastic" => StrikerSpec::plastic_beater(),
        "mallet" => StrikerSpec::timpani_mallet(),
        "hard-mallet" => StrikerSpec::hard_mallet(),
        "yarn" => StrikerSpec::yarn_mallet(),
        _ => return None,
    })
}

/// A striker's name (see [`striker_named`]); "custom" for any other.
pub fn striker_name(s: &StrikerSpec) -> &'static str {
    for n in ["stick", "shoulder", "felt", "plastic", "mallet", "hard-mallet", "yarn"] {
        if striker_named(n).as_ref() == Some(s) {
            return n;
        }
    }
    "custom"
}

/// Where a piece stands, metres: `y` up, `z` toward the listener (the drummer sits behind the kit,
/// at negative `z`), `x` to the listener's right... as the view shows it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    /// Centre of the struck face: the batter head, or the cymbal's plate.
    pub centre: [f32; 3],
    /// Unit normal of the struck face, pointing out of the drum (toward the stick).
    pub normal: [f32; 3],
    pub radius: f32,
    /// Shell depth (the resonant head is `depth` behind the batter), 0 for a cymbal.
    pub depth: f32,
}

impl Placement {
    /// Centre of the resonant head.
    pub fn reso_centre(&self) -> [f32; 3] {
        let (c, n) = (self.centre, self.normal);
        [c[0] - n[0] * self.depth, c[1] - n[1] * self.depth, c[2] - n[2] * self.depth]
    }

    /// Where its sound comes from (the middle of the shell, or the plate).
    pub fn source(&self) -> [f32; 3] {
        let (c, n) = (self.centre, self.normal);
        let d = 0.5 * self.depth;
        [c[0] - n[0] * d, c[1] - n[1] * d, c[2] - n[2] * d]
    }
}

fn unit(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    [v[0] / l, v[1] / l, v[2] / l]
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// The kit's layout: one description for the sound (distances between pieces) and the view. The
/// sizes are the presets' own (22" kick, 14" snare, 12" and 16" toms, 16" crash, 20" ride, 10"
/// splash).
pub fn placement(piece: Piece) -> Placement {
    match piece {
        Piece::Kick => Placement { centre: [0.0, 0.30, -0.23], normal: [0.0, 0.0, -1.0], radius: 0.2794, depth: 0.457 },
        Piece::Snare => Placement { centre: [-0.40, 0.66, -0.40], normal: unit([0.0, 0.97, -0.24]), radius: 0.1778, depth: 0.14 },
        Piece::RackTom => Placement { centre: [-0.14, 0.88, -0.12], normal: unit([0.15, 0.85, -0.5]), radius: 0.1524, depth: 0.229 },
        Piece::FloorTom => Placement { centre: [0.47, 0.62, -0.34], normal: [0.0, 1.0, 0.0], radius: 0.2032, depth: 0.406 },
        Piece::Crash => Placement { centre: [-0.64, 1.20, 0.0], normal: unit([0.22, 0.95, -0.25]), radius: 0.2032, depth: 0.0 },
        Piece::Ride => Placement { centre: [0.68, 1.06, -0.04], normal: unit([-0.16, 0.96, -0.22]), radius: 0.254, depth: 0.0 },
        Piece::Splash => Placement { centre: [0.16, 1.22, 0.08], normal: unit([0.0, 0.97, -0.25]), radius: 0.127, depth: 0.0 },
    }
}

/// Left and right gains of a piece: panned by where it stands, as a listener in front hears it.
pub fn pan(piece: Piece) -> (f32, f32) {
    let x = (placement(piece).centre[0] / 0.9).clamp(-1.0, 1.0);
    let a = (x + 1.0) * std::f32::consts::FRAC_PI_4;
    (a.cos(), a.sin())
}

/// The kit as it is built: the tunings and the settings that change the drums themselves. A change
/// here builds a new kit; strikes (speed, place, striker) are per hit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KitSpec {
    /// Batter-head fundamentals, Hz (see `DrumSpec::kick`, `snare`, `rack_tom`, `floor_tom`).
    pub kick: f32,
    pub snare: f32,
    pub rack_tom: f32,
    pub floor_tom: f32,
    /// 0: an open kick; 1: a pillow against the batter (the preset's). The batter's loss runs from
    /// the resonant head's 4/s to 25/s.
    pub kick_muffling: f32,
    /// Snare wires on, and how hard the strainer presses them (N).
    pub snares: bool,
    pub snare_tension: f32,
    /// Whether the pieces hear each other (see the module notes). Not part of the build: a running
    /// kit switches it.
    pub sympathetic: bool,
}

impl Default for KitSpec {
    fn default() -> Self {
        Self { kick: 55.0, snare: 220.0, rack_tom: 140.0, floor_tom: 82.0, kick_muffling: 1.0, snares: true, snare_tension: 0.15, sympathetic: true }
    }
}

impl KitSpec {
    /// Kept in range (a saved song or an addon can ask for anything).
    pub fn clamped(self) -> Self {
        let f = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        let d = Self::default();
        Self {
            kick: f(self.kick, 35.0, 90.0, d.kick),
            snare: f(self.snare, 140.0, 360.0, d.snare),
            rack_tom: f(self.rack_tom, 90.0, 260.0, d.rack_tom),
            floor_tom: f(self.floor_tom, 55.0, 160.0, d.floor_tom),
            kick_muffling: f(self.kick_muffling, 0.0, 1.0, d.kick_muffling),
            snares: self.snares,
            snare_tension: f(self.snare_tension, 0.03, 1.5, d.snare_tension),
            sympathetic: self.sympathetic,
        }
    }

    /// Whether `other` builds the same drums (only `sympathetic` may differ).
    pub fn same_build(&self, other: &KitSpec) -> bool {
        KitSpec { sympathetic: true, ..*self } == KitSpec { sympathetic: true, ..*other }
    }

    /// The drum a piece is, or `None` for a cymbal.
    pub fn drum(&self, piece: Piece) -> Option<DrumSpec> {
        Some(match piece {
            Piece::Kick => {
                let mut s = DrumSpec::kick(self.kick);
                s.batter.loss = 4.0 + 21.0 * self.kick_muffling.clamp(0.0, 1.0);
                s
            }
            Piece::Snare => {
                let s = DrumSpec::snare(self.snare);
                if !self.snares {
                    s.snares_off()
                } else {
                    let mut s = s;
                    if let Some(w) = s.snares.as_mut() {
                        w.preload = self.snare_tension;
                    }
                    s
                }
            }
            Piece::RackTom => DrumSpec::rack_tom(self.rack_tom),
            Piece::FloorTom => DrumSpec::floor_tom(self.floor_tom),
            _ => return None,
        })
    }

    /// The cymbal a piece is, or `None` for a drum.
    pub fn cymbal(&self, piece: Piece) -> Option<CymbalSpec> {
        match piece {
            Piece::Crash => Some(CymbalSpec::crash()),
            Piece::Ride => Some(CymbalSpec::ride()),
            Piece::Splash => Some(CymbalSpec::splash()),
            _ => None,
        }
    }
}

/// A playing piece: a drum or a cymbal.
pub enum Body {
    Drum(Box<Drum>),
    Cymbal(Box<Cymbal>),
}

impl Body {
    /// Builds a piece of `spec`.
    pub fn build(spec: &KitSpec, piece: Piece, sr: f32) -> Body {
        match (spec.drum(piece), spec.cymbal(piece)) {
            (Some(d), _) => Body::Drum(Box::new(Drum::new(d, sr))),
            (_, Some(c)) => {
                let mut c = Cymbal::new(c, sr);
                c.set_nonlinear_floor(NONLINEAR_FLOOR);
                Body::Cymbal(Box::new(c))
            }
            _ => unreachable!("every piece is a drum or a cymbal"),
        }
    }

    pub fn strike(&mut self, s: Strike) {
        match self {
            Body::Drum(d) => d.strike(s),
            Body::Cymbal(c) => c.strike(s),
        }
    }

    #[inline]
    pub fn next_sample(&mut self) -> f32 {
        match self {
            Body::Drum(d) => d.next_sample(),
            Body::Cymbal(c) => c.next_sample(),
        }
    }

    pub fn striking(&self) -> bool {
        match self {
            Body::Drum(d) => d.striking(),
            Body::Cymbal(c) => c.striking(),
        }
    }

    pub fn energy(&self) -> f32 {
        match self {
            Body::Drum(d) => d.energy(),
            Body::Cymbal(c) => c.energy(),
        }
    }

    pub fn report(&self) -> StrikeReport {
        match self {
            Body::Drum(d) => d.report,
            Body::Cymbal(c) => c.report,
        }
    }

    pub fn last_force(&self) -> f32 {
        match self {
            Body::Drum(d) => d.last_force,
            Body::Cymbal(c) => c.last_force,
        }
    }

    /// The struck body's modes: (frequency scale now, the body).
    fn struck_body(&self) -> &super::modal::ModalBody {
        match self {
            Body::Drum(d) => d.head_body(0).expect("a drum has a batter head"),
            Body::Cymbal(c) => c.body(),
        }
    }

    /// Each field point's shape values for the lowest `FIELD_MODES` modes, point after point.
    fn field_shapes(&self) -> (Vec<f32>, usize) {
        let n = self.struck_body().len();
        let k = n.min(FIELD_MODES);
        let mut full = vec![0.0; n];
        let mut out = Vec::with_capacity(FIELD * k);
        for i in 0..FIELD {
            let (r, theta) = field_point(i);
            match self {
                Body::Drum(d) => d.head(0).expect("batter").shape_at(r, theta, &mut full),
                Body::Cymbal(c) => c.plate().shape_at(r.min(0.999), theta, &mut full),
            }
            out.extend_from_slice(&full[..k]);
        }
        (out, k)
    }
}

/// What the view and the ops read of one piece.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PieceState {
    pub awake: bool,
    /// Vibrational energy, J.
    pub energy: f32,
    /// Peak output (of full scale) over the last block.
    pub level: f32,
    pub report: StrikeReport,
    /// How far the struck head's pitch is above its rest pitch now, cents (a hard hit's glide).
    pub glide_cents: f32,
    /// Snare wire groups off the head now, and landings so far.
    pub wires_lifted: u32,
    pub wire_landings: u32,
    /// Whether a cymbal's von Karman coupling is running (it rests once the plate is back to small
    /// amplitudes).
    pub nonlinear: bool,
}

/// One piece as the kit runs it. Each sits behind its own lock so the pieces can be rendered on
/// different threads; the locks are only ever taken by one thread at a time (the block's owner of
/// the piece, then the audio thread between blocks), so they never wait.
struct Part {
    piece: Piece,
    body: Body,
    awake: bool,
    quiet_blocks: u32,
    history: Vec<f32>,
    pending: [(usize, Strike); MAX_PENDING],
    n_pending: usize,
    /// What it hears this block: pressure on the batter and resonant heads, Pa.
    incident: [[f32; BLOCK]; 2],
    heard: bool,
    drive: bool,
    out: [f32; BLOCK],
    level: f32,
    field: Vec<f32>,
    field_modes: usize,
    /// The latest strike's contact force, sample by sample from the strike.
    trace: Vec<f32>,
    trace_len: usize,
}

impl Part {
    /// Renders one block (see `Kit::render_block`), writing the output into the history at `base`.
    fn render(&mut self, base: usize, sleep_blocks: u32) {
        if !self.awake && (self.n_pending > 0 || self.heard) {
            self.awake = true;
            self.quiet_blocks = 0;
        }
        if !self.awake {
            self.out = [0.0; BLOCK];
            self.level = 0.0;
        } else {
            let mut next = 0;
            let mut peak = 0.0f32;
            for i in 0..BLOCK {
                while next < self.n_pending && self.pending[next].0 <= i {
                    self.body.strike(self.pending[next].1);
                    self.trace_len = 0;
                    next += 1;
                }
                if self.drive {
                    if let Body::Drum(d) = &mut self.body {
                        d.add_pressure(self.incident[0][i], self.incident[1][i]);
                    }
                }
                let v = self.body.next_sample();
                self.out[i] = v;
                peak = peak.max(v.abs());
                if self.trace_len < TRACE_CAPTURE {
                    self.trace[self.trace_len] = self.body.last_force();
                    self.trace_len += 1;
                }
            }
            self.n_pending = 0;
            self.level = peak;
            if peak < SLEEP_LEVEL && !self.body.striking() && !self.heard && self.body.energy() < SLEEP_ENERGY {
                self.quiet_blocks += 1;
                if self.quiet_blocks >= sleep_blocks {
                    self.awake = false;
                }
            } else {
                self.quiet_blocks = 0;
            }
        }
        let mask = HISTORY - 1;
        for (i, v) in self.out.iter().enumerate() {
            self.history[(base + i) & mask] = *v;
        }
    }

    fn needs_render(&self) -> bool {
        self.awake || self.n_pending > 0 || self.heard
    }
}

fn lock(p: &Mutex<Part>) -> MutexGuard<'_, Part> {
    p.lock().unwrap_or_else(|e| e.into_inner())
}

/// One piece hearing another: the delays (samples) and gains (Pa per unit of the source's output)
/// to the target's batter and resonant heads.
#[derive(Clone, Copy, Debug)]
struct Link {
    source: usize,
    target: usize,
    delay: [usize; 2],
    gain: [f32; 2],
}

/// The threads that render some of the pieces while the audio thread renders the rest.
struct Pool {
    shared: Arc<PoolShared>,
    threads: Vec<std::thread::Thread>,
    /// Pieces each worker renders.
    jobs: Vec<Vec<usize>>,
}

struct PoolShared {
    /// Per worker: bumped to hand it a block.
    go: Vec<AtomicU64>,
    /// Workers finished with the current block.
    done: AtomicUsize,
    base: AtomicUsize,
    quit: AtomicBool,
}

/// Rough cost of each piece while it rings (percent of a core, release builds): how the pieces
/// are shared out between threads.
fn weight(p: Piece) -> u32 {
    match p {
        Piece::Kick => 7,
        Piece::Snare => 13,
        Piece::RackTom => 4,
        Piece::FloorTom => 6,
        Piece::Crash => 56,
        Piece::Ride => 63,
        Piece::Splash => 29,
    }
}

/// A playing kit. See the module notes.
pub struct Kit {
    pub spec: KitSpec,
    sr: f32,
    parts: Vec<Arc<Mutex<Part>>>,
    links: Vec<Link>,
    /// Pieces the audio thread renders itself.
    own: Vec<usize>,
    pool: Option<Pool>,
    /// Where the coming block is written in each history.
    hist_pos: usize,
    frames: [[f32; 2]; BLOCK],
    cursor: usize,
    sleep_blocks: u32,
    gains: [(f32, f32); PIECES],
    /// Each piece's level in the mix (see `set_mix`).
    mix: [f32; PIECES],
    /// Whether each piece rendered anything last block (so the others can skip hearing it).
    sounding: [bool; PIECES],
    focus: Piece,
}

impl Kit {
    /// Builds every piece (in parallel: the first build of a drum or cymbal takes a fraction of a
    /// second; after that it comes from the cache) and the threads it plays on: as many as the
    /// machine has cores to spare, up to three. Call off the audio thread.
    pub fn new(spec: KitSpec, sr: f32) -> Self {
        let spare = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).saturating_sub(1);
        Self::with_workers(spec, sr, spare.min(3))
    }

    /// A kit rendered on the calling thread and `workers` more (0: all on the calling thread).
    pub fn with_workers(spec: KitSpec, sr: f32, workers: usize) -> Self {
        let spec = spec.clamped();
        let bodies: Vec<Body> = std::thread::scope(|s| {
            let handles: Vec<_> = Piece::ALL.iter().map(|&p| s.spawn(move || Body::build(&spec, p, sr))).collect();
            handles.into_iter().map(|h| h.join().expect("building a kit piece")).collect()
        });
        let parts: Vec<Arc<Mutex<Part>>> = bodies
            .into_iter()
            .zip(Piece::ALL)
            .map(|(body, piece)| {
                let (field, field_modes) = body.field_shapes();
                let rest = Strike { velocity: 0.0, position: 0.0, angle: 0.0, striker: StrikerSpec::stick() };
                Arc::new(Mutex::new(Part { piece, body, awake: false, quiet_blocks: 0, history: vec![0.0; HISTORY], pending: [(0, rest); MAX_PENDING], n_pending: 0, incident: [[0.0; BLOCK]; 2], heard: false, drive: false, out: [0.0; BLOCK], level: 0.0, field, field_modes, trace: vec![0.0; TRACE_CAPTURE], trace_len: 0 }))
            })
            .collect();
        let mut links = Vec::new();
        for (t, target) in Piece::ALL.iter().enumerate() {
            if target.is_cymbal() {
                continue;
            }
            let tp = placement(*target);
            for (s, source) in Piece::ALL.iter().enumerate() {
                if s == t {
                    continue;
                }
                let from = placement(*source).source();
                let mut delay = [0; 2];
                let mut gain = [0.0; 2];
                for (h, at) in [tp.centre, tp.reso_centre()].into_iter().enumerate() {
                    let d = distance(from, at).max(0.25);
                    delay[h] = ((d / C_AIR * sr).round() as usize).clamp(BLOCK, HISTORY - BLOCK);
                    gain[h] = FULL_SCALE_PA / d;
                }
                links.push(Link { source: s, target: t, delay, gain });
            }
        }
        // Share the pieces out, heaviest first, each to the lightest thread so far; the audio
        // thread keeps the lightest share.
        let bins = workers + 1;
        let mut order: Vec<Piece> = Piece::ALL.to_vec();
        order.sort_by_key(|p| std::cmp::Reverse(weight(*p)));
        let mut load = vec![0u32; bins];
        let mut assigned: Vec<Vec<usize>> = vec![Vec::new(); bins];
        for p in order {
            let b = (0..bins).min_by_key(|&b| load[b]).unwrap_or(0);
            load[b] += weight(p);
            assigned[b].push(p.index());
        }
        let lightest = (0..bins).min_by_key(|&b| load[b]).unwrap_or(0);
        let own = assigned.remove(lightest);
        let pool = (workers > 0).then(|| {
            let shared = Arc::new(PoolShared { go: (0..workers).map(|_| AtomicU64::new(0)).collect(), done: AtomicUsize::new(0), base: AtomicUsize::new(0), quit: AtomicBool::new(false) });
            let sleep_blocks = ((SLEEP_SECONDS * sr) as usize / BLOCK).max(1) as u32;
            let threads = assigned
                .iter()
                .enumerate()
                .map(|(w, job)| {
                    let (shared, mine) = (shared.clone(), job.iter().map(|&i| parts[i].clone()).collect::<Vec<_>>());
                    std::thread::Builder::new()
                        .name(format!("matter-kit-{w}"))
                        .spawn(move || {
                            let mut seen = 0u64;
                            loop {
                                let g = shared.go[w].load(Ordering::Acquire);
                                if shared.quit.load(Ordering::Acquire) {
                                    return;
                                }
                                if g == seen {
                                    std::thread::park();
                                    continue;
                                }
                                seen = g;
                                let base = shared.base.load(Ordering::Acquire);
                                for p in &mine {
                                    lock(p).render(base, sleep_blocks);
                                }
                                shared.done.fetch_add(1, Ordering::AcqRel);
                            }
                        })
                        .expect("starting a kit thread")
                        .thread()
                        .clone()
                })
                .collect();
            Pool { shared, threads, jobs: assigned }
        });
        let sleep_blocks = ((SLEEP_SECONDS * sr) as usize / BLOCK).max(1) as u32;
        let gains = std::array::from_fn(|i| pan(Piece::from_index(i)));
        Self { spec, sr, parts, links, own, pool, hist_pos: 0, frames: [[0.0; 2]; BLOCK], cursor: BLOCK, sleep_blocks, gains, mix: [1.0; PIECES], sounding: [false; PIECES], focus: Piece::Snare }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    /// Threads besides the caller's that render pieces.
    pub fn workers(&self) -> usize {
        self.pool.as_ref().map_or(0, |p| p.threads.len())
    }

    /// The smallest delay between two pieces, samples (at least `BLOCK`: see the module notes).
    pub fn min_delay(&self) -> usize {
        self.links.iter().flat_map(|l| l.delay).min().unwrap_or(BLOCK)
    }

    /// Switches whether the pieces hear each other.
    pub fn set_sympathetic(&mut self, on: bool) {
        self.spec.sympathetic = on;
    }

    /// Each piece's level in the kit's output (1: as it radiates). A balance for the ears - the
    /// microphones of a recorded kit - that changes nothing the pieces hear of each other.
    pub fn set_mix(&mut self, mix: [f32; PIECES]) {
        self.mix = mix.map(|m| if m.is_finite() { m.clamp(0.0, 8.0) } else { 1.0 });
    }

    /// Strikes `piece` at the start of the next block to be rendered.
    pub fn strike(&mut self, piece: Piece, s: Strike) {
        self.schedule(piece, s, 0);
    }

    /// Strikes `piece` `offset` samples into the next block to be rendered (sample-accurate offline
    /// rendering). A piece holds a few strikes per block; beyond that the earliest is dropped.
    pub fn schedule(&mut self, piece: Piece, s: Strike, offset: usize) {
        let mut p = lock(&self.parts[piece.index()]);
        let offset = offset.min(BLOCK - 1);
        if p.n_pending == MAX_PENDING {
            p.pending.copy_within(1.., 0);
            p.n_pending -= 1;
        }
        let n = p.n_pending;
        p.pending[n] = (offset, s);
        p.n_pending += 1;
        self.focus = piece;
    }

    /// The next frame of the kit (stereo), rendering a block when the last is used up.
    #[inline]
    pub fn next_frame(&mut self) -> [f32; 2] {
        if self.cursor >= BLOCK {
            self.render_block();
            self.cursor = 0;
        }
        let f = self.frames[self.cursor];
        self.cursor += 1;
        f
    }

    /// Whether the next frame starts a new block.
    pub fn at_block_start(&self) -> bool {
        self.cursor >= BLOCK
    }

    /// Whether every piece is asleep.
    pub fn is_silent(&self) -> bool {
        self.parts.iter().all(|p| !lock(p).needs_render())
    }

    /// Pieces awake now.
    pub fn awake(&self) -> usize {
        self.parts.iter().filter(|p| lock(p).awake).count()
    }

    /// The piece struck most recently.
    pub fn focus(&self) -> Piece {
        self.focus
    }

    /// Runs `f` on a piece's body.
    pub fn with_body<R>(&self, piece: Piece, f: impl FnOnce(&mut Body) -> R) -> R {
        f(&mut lock(&self.parts[piece.index()]).body)
    }

    pub fn state(&self, piece: Piece) -> PieceState {
        let p = lock(&self.parts[piece.index()]);
        let mut s = PieceState { awake: p.awake, energy: p.body.energy(), level: p.level, report: p.body.report(), ..Default::default() };
        match &p.body {
            Body::Drum(d) => {
                s.glide_cents = 1200.0 * d.head_body(0).map_or(1.0, |b| b.scale()).max(1.0e-6).log2();
                s.wires_lifted = d.wires_lifted() as u32;
                s.wire_landings = d.wire_landings();
            }
            Body::Cymbal(c) => s.nonlinear = c.spec.every > 0 && !c.nonlinear_resting(),
        }
        s
    }

    /// The struck face's displacement at every field point (m), into `out` (length `FIELD`). The
    /// lowest modes only: the pattern the eye can see.
    pub fn field(&self, piece: Piece, out: &mut [f32]) {
        let p = lock(&self.parts[piece.index()]);
        let body = p.body.struck_body();
        let k = p.field_modes;
        for (i, o) in out.iter_mut().take(FIELD).enumerate() {
            let shape = &p.field[i * k..(i + 1) * k];
            let mut acc = 0.0;
            for (m, s) in shape.iter().enumerate() {
                acc += s * body.q(m);
            }
            *o = acc;
        }
    }

    /// The struck body's lowest modes now: frequency (Hz, with any glide) and amplitude (m, its
    /// cycle's RMS), into `hz` and `amp`. Returns how many were written.
    pub fn modes(&self, piece: Piece, hz: &mut [f32], amp: &mut [f32]) -> usize {
        let p = lock(&self.parts[piece.index()]);
        let body = p.body.struck_body();
        let n = body.len().min(hz.len()).min(amp.len());
        let scale = body.scale();
        for k in 0..n {
            hz[k] = body.specs()[k].freq * scale;
            amp[k] = body.mean_square(k).sqrt();
        }
        n
    }

    /// The latest strike on `piece`: its contact force (N) sample by sample from the strike, into
    /// `out`. Returns how many samples were written.
    pub fn trace(&self, piece: Piece, out: &mut [f32]) -> usize {
        let p = lock(&self.parts[piece.index()]);
        let n = p.trace_len.min(out.len());
        out[..n].copy_from_slice(&p.trace[..n]);
        n
    }

    fn render_block(&mut self) {
        let mask = HISTORY - 1;
        let base = self.hist_pos;
        // What each drum hears this block: every other piece's sound from earlier blocks.
        for p in &self.parts {
            let mut p = lock(p);
            p.incident = [[0.0; BLOCK]; 2];
            p.heard = false;
            p.drive = false;
        }
        if self.spec.sympathetic {
            let mut heard = [[0.0f32; BLOCK]; 2];
            for l in &self.links {
                if !self.sounding[l.source] {
                    continue;
                }
                {
                    let src = lock(&self.parts[l.source]);
                    for h in 0..2 {
                        let start = base + HISTORY - l.delay[h];
                        for (i, v) in heard[h].iter_mut().enumerate() {
                            *v = l.gain[h] * src.history[(start + i) & mask];
                        }
                    }
                }
                let mut t = lock(&self.parts[l.target]);
                for h in 0..2 {
                    for i in 0..BLOCK {
                        t.incident[h][i] += heard[h][i];
                    }
                }
                t.drive = true;
            }
            for p in &self.parts {
                let mut p = lock(p);
                p.heard = p.drive && p.incident.iter().any(|h| h.iter().any(|v| v.abs() > WAKE_PA));
            }
        }
        // Hand the workers their pieces, render ours, and wait for theirs.
        let mut dispatched = 0;
        if let Some(pool) = &self.pool {
            pool.shared.done.store(0, Ordering::Release);
            pool.shared.base.store(base, Ordering::Release);
            for (w, job) in pool.jobs.iter().enumerate() {
                if job.iter().any(|&i| lock(&self.parts[i]).needs_render()) {
                    pool.shared.go[w].fetch_add(1, Ordering::AcqRel);
                    pool.threads[w].unpark();
                    dispatched += 1;
                } else {
                    // Nothing to do: its pieces are asleep, so their block is silence.
                    for &i in job {
                        lock(&self.parts[i]).render(base, self.sleep_blocks);
                    }
                }
            }
        }
        for &i in &self.own {
            lock(&self.parts[i]).render(base, self.sleep_blocks);
        }
        if let Some(pool) = &self.pool {
            let mut spins = 0u32;
            while pool.shared.done.load(Ordering::Acquire) < dispatched {
                spins += 1;
                if spins < 4096 {
                    std::hint::spin_loop();
                } else {
                    std::thread::yield_now();
                }
            }
        }
        self.hist_pos = (base + BLOCK) & mask;
        self.frames = [[0.0; 2]; BLOCK];
        for (pi, p) in self.parts.iter().enumerate() {
            let p = lock(p);
            self.sounding[pi] = p.level > 0.0;
            let (gl, gr) = self.gains[pi];
            let (gl, gr) = (gl * self.mix[pi], gr * self.mix[pi]);
            for (f, v) in self.frames.iter_mut().zip(p.out.iter()) {
                f[0] += v * gl * KIT_GAIN;
                f[1] += v * gr * KIT_GAIN;
            }
        }
    }
}

impl Drop for Kit {
    fn drop(&mut self) {
        if let Some(pool) = &self.pool {
            pool.shared.quit.store(true, Ordering::Release);
            for t in &pool.threads {
                t.unpark();
            }
        }
    }
}

/// A hit on a piece of the kit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KitHit {
    pub piece: Piece,
    pub strike: Strike,
}

impl KitHit {
    /// A hit at `speed` m/s where `piece` is usually played, with its usual striker.
    pub fn at(piece: Piece, speed: f32, position: f32) -> Self {
        Self { piece, strike: Strike { velocity: speed, position, angle: 0.0, striker: piece.default_striker() } }
    }
}
