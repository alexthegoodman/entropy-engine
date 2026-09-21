//! Wavetable synthesis with a table you sculpt as terrain.
//!
//! A wavetable is a stack of single-cycle waveforms ("frames"). A voice plays one cycle at the
//! note's pitch and moves through the stack as it sounds, so the stack is a timbre that changes over
//! time. Seen from the side the stack is a height field: phase across, frame into the screen, level
//! up. `entropy_gui::WavetableView` draws and edits exactly this data. It is deliberately not the
//! engine's landscape heightfield: a landscape is a mesh with levels of detail for a 3D scene, and
//! this is audio-rate data (2048 samples per cycle) that is periodic along one axis and has to be
//! readable from the audio thread without a lock.
//!
//! Three pieces, split by which thread touches them:
//!
//! * [`Wavetable`] lives on the main thread. It owns the editable time-domain frames, the brush
//!   ([`Stamp`]), undo, presets and serialisation. Changing a frame rebuilds that frame's mips.
//! * [`WavetableShared`] is what the audio thread reads: for every frame, [`MIP_LEVELS`] band-limited
//!   copies, in a flat array of `AtomicU32` (f32 bits). Writing and reading are relaxed loads and
//!   stores, so there is no lock, no allocation and no waiting on either side, and an edit is heard
//!   on the very next sample of a note that is already sounding. A read that lands mid-update can
//!   splice old and new samples of one frame, for as long as the rebuild of that frame takes. Each
//!   float is atomic, so that is not undefined behaviour and a sample is never torn, but a splice is
//!   a step in the waveform and may be audible as a click; how often that happens has not been
//!   measured (`tests/wavetable_no_alloc.rs` checks only that the output stays finite and bounded).
//! * [`WavetableVoice`] is a `rodio::Source` built on the main thread at note-on and dropped by the
//!   mixer when its release ends.
//!
//! Aliasing is the classic wavetable failure, so every frame is stored at half-octave band limits:
//! a note reads the level whose highest harmonic still fits under Nyquist ([`level_for`]).

use std::collections::HashMap;
use std::f32::consts::{PI, TAU};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine as _;
use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use rodio::Source;

use super::analysis::ENGINE_SAMPLE_RATE;

/// Samples in one cycle of one frame.
pub const TABLE_SIZE: usize = 2048;
const MASK: usize = TABLE_SIZE - 1;
pub const DEFAULT_FRAMES: usize = 32;
pub const MIN_FRAMES: usize = 2;
pub const MAX_FRAMES: usize = 64;
/// Band-limited copies per frame, two per octave.
pub const MIP_LEVELS: usize = 20;
/// Width of the terrain in world units (phase 0..1 maps to x -1..1) and its depth (frame 0 to the
/// last frame maps to z +depth/2..-depth/2). The brush is measured in these, so a round brush is
/// round on screen whatever the frame count.
pub const WORLD_WIDTH: f32 = 2.0;
pub const WORLD_DEPTH: f32 = 1.6;
pub const MAX_UNISON: usize = 7;
const UNDO_DEPTH: usize = 40;

// ------------------------------------------------------------------------------------------
// Band limits
// ------------------------------------------------------------------------------------------

/// Highest harmonic kept at `level`. Level 0 keeps everything the table can hold; each step down
/// divides the bandwidth by the square root of two, and the last level is a bare sine.
pub fn level_harmonics(level: usize) -> usize {
    let max = (TABLE_SIZE / 2 - 1) as f32;
    ((max / 2f32.powf(level as f32 * 0.5)).floor() as usize).max(1)
}

/// The most detailed level that stays under Nyquist at `freq`: the harmonics it keeps all fit.
pub fn level_for(freq: f32, sample_rate: f32) -> usize {
    let fits = ((sample_rate * 0.5) / freq.max(1.0)).floor() as usize;
    (0..MIP_LEVELS).find(|&l| level_harmonics(l) <= fits.max(1)).unwrap_or(MIP_LEVELS - 1)
}

struct Bandlimiter {
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    time: Vec<f32>,
    spec: Vec<Complex<f32>>,
    work: Vec<Complex<f32>>,
    out: Vec<f32>,
    scratch_fwd: Vec<Complex<f32>>,
    scratch_inv: Vec<Complex<f32>>,
}

impl Bandlimiter {
    fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(TABLE_SIZE);
        let inv = planner.plan_fft_inverse(TABLE_SIZE);
        Self {
            time: fwd.make_input_vec(),
            spec: fwd.make_output_vec(),
            work: inv.make_input_vec(),
            out: inv.make_output_vec(),
            scratch_fwd: fwd.make_scratch_vec(),
            scratch_inv: inv.make_scratch_vec(),
            fwd,
            inv,
        }
    }

    /// Transforms one frame; `level_into` then reads any number of levels out of it.
    fn analyze(&mut self, frame: &[f32]) {
        self.time.copy_from_slice(frame);
        self.fwd.process_with_scratch(&mut self.time, &mut self.spec, &mut self.scratch_fwd).expect("fft sizes come from the plan");
    }

    /// The analysed frame with everything above `level`'s highest harmonic removed, and DC removed.
    /// The top fifth of the kept harmonics is tapered so the cut does not ring.
    fn level_into(&mut self, level: usize, dst: &mut [f32]) {
        let h = level_harmonics(level);
        let taper_from = (h as f32 * 0.8) as usize;
        let inv_n = 1.0 / TABLE_SIZE as f32;
        for (k, w) in self.work.iter_mut().enumerate() {
            *w = if k == 0 || k > h {
                Complex::new(0.0, 0.0)
            } else {
                let g = if h >= 6 && k > taper_from { 0.5 * (1.0 + (PI * (k - taper_from) as f32 / (h - taper_from + 1) as f32).cos()) } else { 1.0 };
                self.spec[k] * (g * inv_n)
            };
        }
        self.inv.process_with_scratch(&mut self.work, &mut self.out, &mut self.scratch_inv).expect("fft sizes come from the plan");
        dst.copy_from_slice(&self.out);
    }

    /// One cycle from harmonic amplitudes and phases: `sum amp[h-1] * sin(2 pi h t + phase[h-1])`.
    fn synth(&mut self, amps: &[f32], phases: &[f32]) -> Vec<f32> {
        for w in self.work.iter_mut() {
            *w = Complex::new(0.0, 0.0);
        }
        for h in 1..(TABLE_SIZE / 2).min(amps.len() + 1) {
            let (a, p) = (amps[h - 1], phases.get(h - 1).copied().unwrap_or(0.0));
            // 2 Re(X e^{i theta}) = a sin(theta + p) for X = (a/2)(sin p - i cos p).
            self.work[h] = Complex::new(0.5 * a * p.sin(), -0.5 * a * p.cos());
        }
        self.inv.process_with_scratch(&mut self.work, &mut self.out, &mut self.scratch_inv).expect("fft sizes come from the plan");
        self.out.clone()
    }
}

// ------------------------------------------------------------------------------------------
// What the audio thread reads
// ------------------------------------------------------------------------------------------

pub struct WavetableShared {
    frames: usize,
    mips: Box<[AtomicU32]>,
    version: AtomicU64,
    /// Where the most recently sounding voice is reading, 0..1 across the frames (f32 bits).
    last_pos: AtomicU32,
    /// Recent output level of the voices reading this table (f32 bits), for the editor's glow.
    energy: AtomicU32,
    active: AtomicU32,
}

impl WavetableShared {
    fn new(frames: usize) -> Self {
        let n = MIP_LEVELS * frames * TABLE_SIZE;
        Self {
            frames,
            mips: (0..n).map(|_| AtomicU32::new(0)).collect::<Vec<_>>().into_boxed_slice(),
            version: AtomicU64::new(0),
            last_pos: AtomicU32::new(0),
            energy: AtomicU32::new(0),
            active: AtomicU32::new(0),
        }
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    /// Bumped every time any frame is rebuilt.
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    #[inline]
    fn base(&self, level: usize, frame: usize) -> usize {
        (level * self.frames + frame) * TABLE_SIZE
    }

    /// Cubic (Catmull-Rom) read of one frame at `phase` cycles (0..1, wraps).
    #[inline]
    fn read_frame(&self, level: usize, frame: usize, phase: f32) -> f32 {
        let base = self.base(level, frame);
        let x = phase * TABLE_SIZE as f32;
        let xi = x.floor();
        let t = x - xi;
        let i = (xi as i64 as usize) & MASK;
        let g = |k: usize| f32::from_bits(self.mips[base + (k & MASK)].load(Ordering::Relaxed));
        let (y0, y1, y2, y3) = (g(i.wrapping_sub(1)), g(i), g(i + 1), g(i + 2));
        let c1 = 0.5 * (y2 - y0);
        let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
        let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        ((c3 * t + c2) * t + c1) * t + y1
    }

    /// One sample of the table at `position` (0..1 across frames, blended between the two nearest)
    /// and `phase` cycles, from band-limit `level`.
    #[inline]
    pub fn read(&self, level: usize, position: f32, phase: f32) -> f32 {
        let fpos = position.clamp(0.0, 1.0) * (self.frames - 1) as f32;
        let f0 = (fpos.floor() as usize).min(self.frames - 1);
        let f1 = (f0 + 1).min(self.frames - 1);
        let mix = fpos - f0 as f32;
        let a = self.read_frame(level, f0, phase);
        if mix < 1.0e-4 || f0 == f1 {
            return a;
        }
        a + (self.read_frame(level, f1, phase) - a) * mix
    }

    /// Where the most recent voice is reading (0..1) and how loud the voices on this table are
    /// right now; `None` when nothing is sounding.
    pub fn activity(&self) -> Option<(f32, f32)> {
        if self.active.load(Ordering::Relaxed) == 0 {
            return None;
        }
        Some((f32::from_bits(self.last_pos.load(Ordering::Relaxed)), f32::from_bits(self.energy.load(Ordering::Relaxed))))
    }

    pub fn active_voices(&self) -> u32 {
        self.active.load(Ordering::Relaxed)
    }

    /// A voice that outlives its notes (the guitar's) counts itself in while a note sounds, so the
    /// editor's glow follows it too.
    pub(crate) fn voice_started(&self) {
        self.active.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn voice_ended(&self) {
        if self.active.fetch_sub(1, Ordering::Relaxed) == 1 {
            self.energy.store(0f32.to_bits(), Ordering::Relaxed);
        }
    }

    pub(crate) fn publish_activity(&self, position: f32, energy: f32) {
        self.last_pos.store(position.to_bits(), Ordering::Relaxed);
        self.energy.store(energy.to_bits(), Ordering::Relaxed);
    }
}

// ------------------------------------------------------------------------------------------
// The brush
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrushTool {
    Raise,
    Lower,
    /// Blends toward the neighbourhood average, in phase and across frames.
    Smooth,
    /// Blends toward `Stamp::target`.
    Level,
}

impl BrushTool {
    pub fn name(self) -> &'static str {
        match self {
            BrushTool::Raise => "raise",
            BrushTool::Lower => "lower",
            BrushTool::Smooth => "smooth",
            BrushTool::Level => "level",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "raise" => BrushTool::Raise,
            "lower" => BrushTool::Lower,
            "smooth" => BrushTool::Smooth,
            "level" => BrushTool::Level,
            _ => return None,
        })
    }
}

/// One dab of the brush. Positions are in table space (a fractional frame, phase in cycles) and the
/// footprint is measured in world units, so it looks the same however many frames there are.
#[derive(Clone, Copy, Debug)]
pub struct Stamp {
    pub tool: BrushTool,
    pub frame: f32,
    pub phase: f32,
    /// Geometric-mean radius of the footprint, in world units.
    pub radius: f32,
    /// 1 is round. Above 1 the footprint is stretched along `angle` and squeezed across it, keeping
    /// its area: a pen leaning over drags a longer, thinner dab.
    pub aspect: f32,
    /// Direction of the long axis in the world's (phase, frame) plane, radians from +phase.
    pub angle: f32,
    /// How much this dab changes the surface, 0..1 (already scaled by pressure and time).
    pub amount: f32,
    /// The height `Level` pulls toward.
    pub target: f32,
}

impl Stamp {
    pub fn new(tool: BrushTool, frame: f32, phase: f32) -> Self {
        Self { tool, frame, phase, radius: 0.16, aspect: 1.0, angle: 0.0, amount: 0.1, target: 0.0 }
    }

    /// Semi-axes (long, short) of the footprint, world units.
    pub fn axes(&self) -> (f32, f32) {
        let s = self.aspect.max(1.0).sqrt();
        (self.radius * s, self.radius / s)
    }
}

/// The weight of a dab at normalised distance `d` from its centre: a cosine bell, 1 at the centre,
/// 0 at the edge, smooth in between so a dab never leaves a step.
pub fn falloff(d: f32) -> f32 {
    if d >= 1.0 { 0.0 } else { 0.5 * (1.0 + (PI * d).cos()) }
}

fn wrap_phase_delta(d: f32) -> f32 {
    d - d.round()
}

// ------------------------------------------------------------------------------------------
// Presets
// ------------------------------------------------------------------------------------------

pub const PRESET_NAMES: [&str; 8] = ["sine", "saw", "square", "pwm", "vowels", "bell", "terrain", "glass"];

/// A short label for a preset, for buttons.
pub fn preset_label(name: &str) -> &'static str {
    match name {
        "sine" => "Sine",
        "saw" => "Sine to Saw",
        "square" => "Sine to Square",
        "pwm" => "Pulse Width",
        "vowels" => "Vowels",
        "bell" => "FM Bell",
        "terrain" => "Terrain",
        "glass" => "Glass",
        _ => "Custom",
    }
}

fn hash01(a: u32, b: u32) -> f32 {
    let mut h = a.wrapping_mul(0x9E37_79B1) ^ b.wrapping_mul(0x85EB_CA77) ^ 0xC2B2_AE3D;
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297A_2D39);
    h ^= h >> 15;
    (h & 0x00FF_FFFF) as f32 / 0x0100_0000 as f32
}

/// Smooth 2D value noise in 0..1.
fn value_noise(x: f32, y: f32) -> f32 {
    let (xi, yi) = (x.floor(), y.floor());
    let (tx, ty) = (x - xi, y - yi);
    let (sx, sy) = (tx * tx * (3.0 - 2.0 * tx), ty * ty * (3.0 - 2.0 * ty));
    let at = |dx: i32, dy: i32| hash01((xi as i32 + dx) as u32, (yi as i32 + dy) as u32);
    let (a, b, c, d) = (at(0, 0), at(1, 0), at(0, 1), at(1, 1));
    (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy
}

fn normalise_peak(frame: &mut [f32], peak: f32) {
    let m = frame.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if m > 1.0e-6 {
        let g = peak / m;
        for v in frame.iter_mut() {
            *v *= g;
        }
    }
}

// ------------------------------------------------------------------------------------------
// The editable table
// ------------------------------------------------------------------------------------------

/// Bilinear height of `data` (frames x `TABLE_SIZE`) at a fractional frame and a phase in cycles.
pub fn value_in(data: &[f32], frames: usize, frame: f32, phase: f32) -> f32 {
    let f = frame.clamp(0.0, (frames - 1) as f32);
    let f0 = f.floor() as usize;
    let f1 = (f0 + 1).min(frames - 1);
    let tf = f - f0 as f32;
    let x = phase.rem_euclid(1.0) * TABLE_SIZE as f32;
    let i0 = x.floor() as usize & MASK;
    let i1 = (i0 + 1) & MASK;
    let tx = x - x.floor();
    let row = |r: usize| {
        let base = r * TABLE_SIZE;
        data[base + i0] * (1.0 - tx) + data[base + i1] * tx
    };
    row(f0) * (1.0 - tf) + row(f1) * tf
}

/// The (fractional) frame at world depth z for a table of `frames` frames.
pub fn frame_at_z(frames: usize, z: f32) -> f32 {
    ((0.5 - z / WORLD_DEPTH) * (frames - 1) as f32).clamp(0.0, (frames - 1) as f32)
}

/// A surface something can be picked against: the live table, or a frozen copy of it.
pub trait Heights {
    fn frames(&self) -> usize;
    fn value_at(&self, frame: f32, phase: f32) -> f32;
}

impl Heights for Wavetable {
    fn frames(&self) -> usize {
        self.frames
    }
    fn value_at(&self, frame: f32, phase: f32) -> f32 {
        Wavetable::value_at(self, frame, phase)
    }
}

/// A frozen copy of a table's heights. A brush stroke aims against the surface as it was when the
/// stroke began: aimed at the live surface, raising it would move the surface under the pointer and
/// the brush would creep toward the camera as it worked.
pub struct Surface {
    frames: usize,
    data: Vec<f32>,
}

impl Surface {
    pub fn of(table: &Wavetable) -> Self {
        Self { frames: table.frames, data: table.data.clone() }
    }
}

impl Heights for Surface {
    fn frames(&self) -> usize {
        self.frames
    }
    fn value_at(&self, frame: f32, phase: f32) -> f32 {
        value_in(&self.data, self.frames, frame, phase)
    }
}

pub struct Wavetable {
    frames: usize,
    data: Vec<f32>,
    shared: Arc<WavetableShared>,
    band: Bandlimiter,
    undo: Vec<Vec<f32>>,
    redo: Vec<Vec<f32>>,
    editing: bool,
    /// Bumped on every change to `data`, whether or not the mips have been rebuilt yet.
    revision: u64,
}

impl Wavetable {
    /// A table of `frames` sines, ready to sound.
    pub fn new(frames: usize) -> Self {
        let frames = frames.clamp(MIN_FRAMES, MAX_FRAMES);
        let mut t = Self {
            frames,
            data: vec![0.0; frames * TABLE_SIZE],
            shared: Arc::new(WavetableShared::new(frames)),
            band: Bandlimiter::new(),
            undo: Vec::new(),
            redo: Vec::new(),
            editing: false,
            revision: 0,
        };
        t.load_preset("sine");
        t
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn data(&self) -> &[f32] {
        &self.data
    }

    pub fn frame(&self, k: usize) -> &[f32] {
        let k = k.min(self.frames - 1);
        &self.data[k * TABLE_SIZE..(k + 1) * TABLE_SIZE]
    }

    pub fn shared(&self) -> Arc<WavetableShared> {
        self.shared.clone()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// World x of a phase and world z of a frame.
    pub fn world_x(phase: f32) -> f32 {
        (phase - 0.5) * WORLD_WIDTH
    }

    /// Frame 0 is at the front of the terrain (positive z, nearest the default camera) and the last
    /// frame at the back, so the timbre recedes as the position rises.
    pub fn world_z(&self, frame: f32) -> f32 {
        (0.5 - frame / (self.frames - 1) as f32) * WORLD_DEPTH
    }

    /// The (fractional) frame at world depth `z`; the inverse of `world_z`.
    pub fn frame_at_z(&self, z: f32) -> f32 {
        frame_at_z(self.frames, z)
    }

    /// Distance between two neighbouring frames, world units.
    pub fn frame_pitch(&self) -> f32 {
        WORLD_DEPTH / (self.frames - 1) as f32
    }

    /// Bilinear height at a fractional frame and a phase in cycles. Drawing and picking use this.
    pub fn value_at(&self, frame: f32, phase: f32) -> f32 {
        value_in(&self.data, self.frames, frame, phase)
    }

    // --- rebuilding what the audio thread reads ---

    /// Rebuilds the band-limited copies of frames `a..=b` and publishes them.
    pub fn commit(&mut self, a: usize, b: usize) {
        let b = b.min(self.frames - 1);
        let mut buf = vec![0.0f32; TABLE_SIZE];
        for f in a.min(b)..=b {
            self.band.analyze(&self.data[f * TABLE_SIZE..(f + 1) * TABLE_SIZE]);
            for level in 0..MIP_LEVELS {
                self.band.level_into(level, &mut buf);
                let base = self.shared.base(level, f);
                for (i, v) in buf.iter().enumerate() {
                    self.shared.mips[base + i].store(v.to_bits(), Ordering::Relaxed);
                }
            }
        }
        self.shared.version.fetch_add(1, Ordering::Release);
    }

    pub fn commit_all(&mut self) {
        self.commit(0, self.frames - 1);
    }

    // --- brush ---

    /// Applies one dab to the time-domain data and returns the inclusive range of frames it
    /// changed, or `None` if it reached none. Call `commit` with that range to make it audible;
    /// a stroke can apply many dabs and commit once.
    pub fn stamp(&mut self, s: &Stamp) -> Option<(usize, usize)> {
        let (a, b) = s.axes();
        let reach = a.max(b);
        let pitch = self.frame_pitch();
        let f_lo = ((s.frame - reach / pitch).floor().max(0.0)) as usize;
        let f_hi = ((s.frame + reach / pitch).ceil().min((self.frames - 1) as f32)) as usize;
        if s.frame + reach / pitch < 0.0 || s.frame - reach / pitch > (self.frames - 1) as f32 {
            return None;
        }
        let half = ((reach / WORLD_WIDTH) * TABLE_SIZE as f32).ceil() as usize;
        let half = half.min(TABLE_SIZE / 2);
        let centre = (s.phase.rem_euclid(1.0) * TABLE_SIZE as f32).round() as i64;
        let (sin_a, cos_a) = s.angle.sin_cos();
        let weight = |frame: usize, sample_offset: i64| -> f32 {
            let dx = sample_offset as f32 / TABLE_SIZE as f32 * WORLD_WIDTH;
            let dz = (frame as f32 - s.frame) * pitch;
            let u = dx * cos_a + dz * sin_a;
            let v = -dx * sin_a + dz * cos_a;
            falloff(((u / a).powi(2) + (v / b).powi(2)).sqrt())
        };
        let amount = s.amount;

        match s.tool {
            BrushTool::Raise | BrushTool::Lower => {
                let sign = if s.tool == BrushTool::Raise { 1.0 } else { -1.0 };
                for f in f_lo..=f_hi {
                    for off in -(half as i64)..=(half as i64) {
                        let w = weight(f, off);
                        if w > 0.0 {
                            let i = ((centre + off).rem_euclid(TABLE_SIZE as i64)) as usize;
                            let cell = &mut self.data[f * TABLE_SIZE + i];
                            *cell = (*cell + sign * amount * w).clamp(-1.0, 1.0);
                        }
                    }
                }
            }
            BrushTool::Level => {
                for f in f_lo..=f_hi {
                    for off in -(half as i64)..=(half as i64) {
                        let w = weight(f, off);
                        if w > 0.0 {
                            let i = ((centre + off).rem_euclid(TABLE_SIZE as i64)) as usize;
                            let cell = &mut self.data[f * TABLE_SIZE + i];
                            *cell += (s.target - *cell) * (amount * w).min(1.0);
                        }
                    }
                }
            }
            BrushTool::Smooth => self.smooth_region(s, f_lo, f_hi, centre, half, &weight),
        }
        self.revision += 1;
        Some((f_lo, f_hi))
    }

    /// Blends the region toward a local average: a box blur along phase (a width tied to the dab's
    /// size, so a big brush smooths broad features and a small one only takes off the edge) and a
    /// 1-2-1 blur across neighbouring frames.
    fn smooth_region(&mut self, s: &Stamp, f_lo: usize, f_hi: usize, centre: i64, half: usize, weight: &dyn Fn(usize, i64) -> f32) {
        let k = ((half as f32 * 0.22) as i64).clamp(1, 96);
        let span = 2 * half + 1 + 2 * k as usize;
        let start = centre - half as i64 - k;
        // Phase-blurred copy of every row we read: the changed rows plus one either side.
        let r_lo = f_lo.saturating_sub(1);
        let r_hi = (f_hi + 1).min(self.frames - 1);
        let mut blurred: Vec<Vec<f32>> = Vec::with_capacity(r_hi - r_lo + 1);
        for r in r_lo..=r_hi {
            let mut prefix = vec![0.0f32; span + 1];
            for j in 0..span {
                let i = ((start + j as i64).rem_euclid(TABLE_SIZE as i64)) as usize;
                prefix[j + 1] = prefix[j] + self.data[r * TABLE_SIZE + i];
            }
            let mut row = vec![0.0f32; 2 * half + 1];
            for (n, out) in row.iter_mut().enumerate() {
                let j = n + k as usize;
                *out = (prefix[j + k as usize + 1] - prefix[j - k as usize]) / (2 * k + 1) as f32;
            }
            blurred.push(row);
        }
        for f in f_lo..=f_hi {
            for n in 0..=(2 * half) {
                let off = n as i64 - half as i64;
                let w = weight(f, off);
                if w <= 0.0 {
                    continue;
                }
                let at = |r: usize| blurred[r.clamp(r_lo, r_hi) - r_lo][n];
                let avg = 0.25 * at(f.saturating_sub(1)) + 0.5 * at(f) + 0.25 * at(f + 1);
                let i = ((centre + off).rem_euclid(TABLE_SIZE as i64)) as usize;
                let cell = &mut self.data[f * TABLE_SIZE + i];
                *cell += (avg - *cell) * (s.amount * w).min(1.0);
            }
        }
    }

    /// Draws a straight segment into one frame, `p0` to `p1` in cycles (0..1, no wrapping) and
    /// values `v0` to `v1`, blending neighbouring frames in with a falloff of `spread` frames.
    /// This is the single-cycle editor's pen. Returns the frames touched.
    pub fn draw_segment(&mut self, frame: usize, p0: f32, v0: f32, p1: f32, v1: f32, spread: f32) -> (usize, usize) {
        let frame = frame.min(self.frames - 1);
        let (mut pa, mut va, mut pb, mut vb) = (p0.clamp(0.0, 0.9999), v0, p1.clamp(0.0, 0.9999), v1);
        if pa > pb {
            std::mem::swap(&mut pa, &mut pb);
            std::mem::swap(&mut va, &mut vb);
        }
        let ia = (pa * TABLE_SIZE as f32).round() as usize;
        let ib = ((pb * TABLE_SIZE as f32).round() as usize).min(TABLE_SIZE - 1);
        let reach = spread.max(0.0).ceil() as usize;
        let f_lo = frame.saturating_sub(reach);
        let f_hi = (frame + reach).min(self.frames - 1);
        for f in f_lo..=f_hi {
            let w = if f == frame { 1.0 } else { falloff((f as f32 - frame as f32).abs() / (spread.max(0.5) + 0.5)) };
            if w <= 0.0 {
                continue;
            }
            for i in ia..=ib {
                let t = if ib == ia { 0.0 } else { (i - ia) as f32 / (ib - ia) as f32 };
                let target = (va + (vb - va) * t).clamp(-1.0, 1.0);
                let cell = &mut self.data[f * TABLE_SIZE + i];
                *cell += (target - *cell) * w;
            }
        }
        self.revision += 1;
        (f_lo, f_hi)
    }

    // --- undo ---

    /// Starts one undoable edit (a brush stroke, a pen stroke, an operation).
    pub fn begin_edit(&mut self) {
        if self.editing {
            return;
        }
        self.editing = true;
        self.undo.push(self.data.clone());
        if self.undo.len() > UNDO_DEPTH {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    /// Ends it. An edit that changed nothing leaves no undo step behind.
    pub fn end_edit(&mut self) {
        if !self.editing {
            return;
        }
        self.editing = false;
        if self.undo.last().is_some_and(|before| *before == self.data) {
            self.undo.pop();
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn undo(&mut self) -> bool {
        let Some(before) = self.undo.pop() else { return false };
        self.redo.push(std::mem::replace(&mut self.data, before));
        self.revision += 1;
        self.commit_all();
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(after) = self.redo.pop() else { return false };
        self.undo.push(std::mem::replace(&mut self.data, after));
        self.revision += 1;
        self.commit_all();
        true
    }

    // --- whole-table operations (each is one undo step and is committed) ---

    fn edit_all(&mut self, op: impl FnOnce(&mut Vec<f32>, usize)) {
        self.begin_edit();
        let frames = self.frames;
        op(&mut self.data, frames);
        self.end_edit();
        self.revision += 1;
        self.commit_all();
    }

    /// Scales every frame so its own peak reaches `peak`, so no frame is louder than another.
    pub fn normalize(&mut self, peak: f32) {
        self.edit_all(|data, frames| {
            for f in 0..frames {
                normalise_peak(&mut data[f * TABLE_SIZE..(f + 1) * TABLE_SIZE], peak);
            }
        });
    }

    /// Blends every value with its neighbours in phase and across frames, `passes` times.
    pub fn smooth_all(&mut self, passes: usize) {
        self.edit_all(|data, frames| {
            for _ in 0..passes.max(1) {
                let src = data.clone();
                for f in 0..frames {
                    for i in 0..TABLE_SIZE {
                        let at = |ff: usize, ii: usize| src[ff * TABLE_SIZE + (ii & MASK)];
                        let (fm, fp) = (f.saturating_sub(1), (f + 1).min(frames - 1));
                        let row = |ff: usize| 0.25 * at(ff, i.wrapping_sub(1)) + 0.5 * at(ff, i) + 0.25 * at(ff, i + 1);
                        data[f * TABLE_SIZE + i] = 0.25 * row(fm) + 0.5 * row(f) + 0.25 * row(fp);
                    }
                }
            }
        });
    }

    /// Flips every wave upside down. The sound changes phase, not timbre.
    pub fn invert(&mut self) {
        self.edit_all(|data, _| data.iter_mut().for_each(|v| *v = -*v));
    }

    /// Plays every cycle backwards.
    pub fn reverse(&mut self) {
        self.edit_all(|data, frames| {
            for f in 0..frames {
                data[f * TABLE_SIZE..(f + 1) * TABLE_SIZE].reverse();
            }
        });
    }

    /// Reverses the order of the frames: the timbre plays backwards as the position rises.
    pub fn flip_frames(&mut self) {
        self.edit_all(|data, frames| {
            let src = data.clone();
            for f in 0..frames {
                let from = (frames - 1 - f) * TABLE_SIZE;
                data[f * TABLE_SIZE..(f + 1) * TABLE_SIZE].copy_from_slice(&src[from..from + TABLE_SIZE]);
            }
        });
    }

    /// Replaces every frame with random-ish harmonic content. Deterministic for a given `seed`.
    pub fn randomize(&mut self, seed: u32) {
        self.begin_edit();
        for f in 0..self.frames {
            let amps: Vec<f32> = (1..=40u32)
                .map(|h| {
                    let base = 1.0 / (h as f32).powf(1.1);
                    let n = value_noise(h as f32 * 0.7 + seed as f32 * 3.1, f as f32 * 0.4 + seed as f32);
                    base * (0.15 + n)
                })
                .collect();
            let phases: Vec<f32> = (1..=40u32).map(|h| hash01(h, seed.wrapping_add(f as u32 / 4)) * TAU).collect();
            let mut frame = self.band.synth(&amps, &phases);
            normalise_peak(&mut frame, 0.9);
            self.data[f * TABLE_SIZE..(f + 1) * TABLE_SIZE].copy_from_slice(&frame);
        }
        self.end_edit();
        self.revision += 1;
        self.commit_all();
    }

    /// Overwrites one frame (used to import a single cycle). Not undoable on its own.
    pub fn set_frame(&mut self, k: usize, samples: &[f32]) {
        let k = k.min(self.frames - 1);
        for i in 0..TABLE_SIZE {
            let x = i as f32 / TABLE_SIZE as f32 * samples.len() as f32;
            let (a, b) = (samples[(x.floor() as usize) % samples.len()], samples[(x.floor() as usize + 1) % samples.len()]);
            self.data[k * TABLE_SIZE + i] = (a + (b - a) * (x - x.floor())).clamp(-1.0, 1.0);
        }
        self.revision += 1;
        self.commit(k, k);
    }

    // --- presets ---

    /// Replaces the whole table with a named preset. Unknown names leave it alone and return false.
    /// One undo step.
    pub fn load_preset(&mut self, name: &str) -> bool {
        if !PRESET_NAMES.contains(&name) {
            return false;
        }
        let had_data = self.data.iter().any(|v| *v != 0.0);
        if had_data {
            self.begin_edit();
        }
        for f in 0..self.frames {
            let t = f as f32 / (self.frames - 1) as f32;
            let frame = match name {
                "bell" => bell_frame(t),
                _ => {
                    let (amps, phases) = preset_harmonics(name, t, f);
                    self.band.synth(&amps, &phases)
                }
            };
            let mut frame = frame;
            normalise_peak(&mut frame, 0.9);
            self.data[f * TABLE_SIZE..(f + 1) * TABLE_SIZE].copy_from_slice(&frame);
        }
        if had_data {
            self.end_edit();
        }
        self.revision += 1;
        self.commit_all();
        true
    }

    // --- saving ---

    /// The whole table as base64 of a small header (`WVT1`, frames, size) and 16-bit samples.
    pub fn export(&self) -> String {
        let mut bytes = Vec::with_capacity(8 + self.data.len() * 2);
        bytes.extend_from_slice(b"WVT1");
        bytes.extend_from_slice(&(self.frames as u16).to_le_bytes());
        bytes.extend_from_slice(&(TABLE_SIZE as u16).to_le_bytes());
        for v in &self.data {
            bytes.extend_from_slice(&((v.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
        }
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// Replaces the table with an `export`ed one, and commits it. The frame count comes from the
    /// data, so a table saved with a different count loads as saved.
    pub fn import(&mut self, encoded: &str) -> Result<(), String> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).map_err(|e| format!("not base64: {e}"))?;
        if bytes.len() < 8 || &bytes[0..4] != b"WVT1" {
            return Err("not a wavetable (missing WVT1 header)".into());
        }
        let frames = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
        let size = u16::from_le_bytes([bytes[6], bytes[7]]) as usize;
        if size != TABLE_SIZE || !(MIN_FRAMES..=MAX_FRAMES).contains(&frames) {
            return Err(format!("unsupported table: {frames} frames of {size} samples"));
        }
        if bytes.len() != 8 + frames * TABLE_SIZE * 2 {
            return Err("the table is truncated".into());
        }
        if frames != self.frames {
            self.frames = frames;
            self.shared = Arc::new(WavetableShared::new(frames));
            self.undo.clear();
            self.redo.clear();
        } else {
            self.begin_edit();
        }
        self.data = bytes[8..].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32767.0).collect();
        self.end_edit();
        self.revision += 1;
        self.commit_all();
        Ok(())
    }
}

/// Harmonic amplitudes and phases of preset `name` at morph position `t` (0..1).
fn preset_harmonics(name: &str, t: f32, frame: usize) -> (Vec<f32>, Vec<f32>) {
    let mut amps = vec![0.0f32; 160];
    let mut phases = vec![0.0f32; 160];
    match name {
        "saw" => {
            let top = (1.0 + t * 63.0).round() as usize;
            for h in 1..=top {
                // Lanczos sigma factor: a soft top edge, so the morph brightens without ringing.
                let x = PI * h as f32 / (top as f32 + 1.0);
                amps[h - 1] = (1.0 / h as f32) * if top > 1 { x.sin() / x } else { 1.0 };
            }
        }
        "square" => {
            let top = (1.0 + t * 63.0).round() as usize;
            for h in (1..=top).step_by(2) {
                let x = PI * h as f32 / (top as f32 + 2.0);
                amps[h - 1] = (1.0 / h as f32) * if top > 1 { x.sin() / x } else { 1.0 };
            }
        }
        "pwm" => {
            // A pulse of width w has harmonics (2 / pi h) sin(pi h w) as a cosine series.
            let w = 0.5 - t * 0.44;
            for h in 1..=120usize {
                amps[h - 1] = (2.0 / (PI * h as f32)) * (PI * h as f32 * w).sin();
                phases[h - 1] = PI / 2.0;
            }
        }
        "vowels" => {
            // Formants (Hz) of A E I O U; morph between neighbours with a smoothed blend.
            const V: [[f32; 3]; 5] = [[800.0, 1150.0, 2900.0], [400.0, 1600.0, 2700.0], [350.0, 1700.0, 2700.0], [450.0, 800.0, 2830.0], [325.0, 700.0, 2530.0]];
            let x = t * 4.0;
            let i = (x.floor() as usize).min(3);
            let m = x - i as f32;
            let m = m * m * (3.0 - 2.0 * m);
            let f0 = 130.0f32;
            let gains = [1.0f32, 0.55, 0.28];
            let widths = [110.0f32, 140.0, 190.0];
            for h in 1..=110usize {
                let hz = h as f32 * f0;
                let mut a = 0.10 / (h as f32).sqrt();
                for j in 0..3 {
                    let centre = V[i][j] + (V[i + 1][j] - V[i][j]) * m;
                    a += gains[j] * (-0.5 * ((hz - centre) / widths[j]).powi(2)).exp();
                }
                amps[h - 1] = a;
            }
        }
        "terrain" => {
            for h in 1..=48usize {
                let n = value_noise(h as f32 * 0.45, t * 3.2 + 7.0);
                amps[h - 1] = (1.0 / (h as f32).powf(0.9)) * (0.25 + 0.75 * n);
                phases[h - 1] = hash01(h as u32, 91) * TAU + t * (0.6 + 2.4 * hash01(h as u32, 17)) * 3.0;
            }
        }
        "glass" => {
            // Odd-ish partials with a moving comb: bright, hollow, slightly inharmonic to the ear.
            for h in 1..=64usize {
                let comb = 0.5 + 0.5 * (h as f32 * (0.35 + t * 1.6)).cos();
                let odd = if h % 2 == 1 { 1.0 } else { 0.35 };
                amps[h - 1] = odd * comb / (h as f32).powf(0.8);
                phases[h - 1] = (h * h) as f32 * 0.05 * (1.0 + t);
            }
        }
        _ => {
            amps[0] = 1.0;
        }
    }
    let _ = frame;
    (amps, phases)
}

/// Two-operator FM cycle whose index rises with `t`, written straight into the table.
fn bell_frame(t: f32) -> Vec<f32> {
    let index = t * 7.0;
    (0..TABLE_SIZE)
        .map(|i| {
            let p = TAU * i as f32 / TABLE_SIZE as f32;
            (p + index * (3.0 * p).sin()).sin()
        })
        .collect()
}

// ------------------------------------------------------------------------------------------
// Voice
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct WavetableParams {
    pub freq: f32,
    /// 0..1.
    pub velocity: f32,
    pub gain: f32,
    /// Where in the table the note starts and rests, 0..1.
    pub position: f32,
    /// Sweeps the position by `lfo_depth` (a fraction of the whole table) at `lfo_rate` Hz.
    pub lfo_rate: f32,
    pub lfo_depth: f32,
    /// Adds `sweep` to the position at note-on and lets it fall away over `sweep_time` seconds.
    pub sweep: f32,
    pub sweep_time: f32,
    /// How far full velocity moves the position beyond half velocity.
    pub vel_to_position: f32,
    pub unison: u8,
    pub detune_cents: f32,
    /// 0 keeps every unison voice in the centre, 1 spreads them across the field.
    pub spread: f32,
    pub cutoff: f32,
    pub resonance: f32,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
    /// Seconds to hold before releasing. Ignored when the voice has a gate.
    pub duration: f32,
}

impl Default for WavetableParams {
    fn default() -> Self {
        Self {
            freq: 440.0,
            velocity: 0.8,
            gain: 0.25,
            position: 0.0,
            lfo_rate: 0.0,
            lfo_depth: 0.0,
            sweep: 0.0,
            sweep_time: 0.6,
            vel_to_position: 0.0,
            unison: 1,
            detune_cents: 12.0,
            spread: 0.6,
            cutoff: 20_000.0,
            resonance: 0.8,
            attack: 0.005,
            decay: 0.15,
            sustain: 0.8,
            release: 0.15,
            duration: 0.5,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Attack,
    Decay,
    Sustain,
    Release,
    Done,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Svf {
    ic1: f32,
    ic2: f32,
}

impl Svf {
    #[inline]
    pub(crate) fn lowpass(&mut self, x: f32, a1: f32, a2: f32, a3: f32) -> f32 {
        let v3 = x - self.ic2;
        let v1 = a1 * self.ic1 + a2 * v3;
        let v2 = self.ic2 + a2 * self.ic1 + a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        v2
    }
}

/// One sounding note. Stereo, 44.1 kHz, like every other voice on a track bus.
pub struct WavetableVoice {
    table: Arc<WavetableShared>,
    p: WavetableParams,
    level: usize,
    unison: usize,
    phases: [f32; MAX_UNISON],
    incs: [f32; MAX_UNISON],
    gl: [f32; MAX_UNISON],
    gr: [f32; MAX_UNISON],
    lfo_phase: f32,
    samples: u64,
    hold_left: Option<u64>,
    gate: Option<Arc<AtomicBool>>,
    /// When set, the note's resting position is read from here every sample instead of from the
    /// params, so a slider can move a held note through the table.
    live_position: Option<Arc<AtomicU32>>,
    stage: Stage,
    env: f32,
    release_step: f32,
    filter: [Svf; 2],
    coef: Option<(f32, f32, f32)>,
    block_frames: u32,
    block_energy: f32,
    smoothed: f32,
    buf: [f32; 2],
    buf_idx: u8,
}

impl WavetableVoice {
    /// `gate`, if given, holds the note for as long as it reads true; otherwise the note is held
    /// for `params.duration` seconds. Either way it then releases and ends by itself.
    pub fn new(table: Arc<WavetableShared>, params: WavetableParams, gate: Option<Arc<AtomicBool>>) -> Self {
        let sr = ENGINE_SAMPLE_RATE as f32;
        let unison = (params.unison as usize).clamp(1, MAX_UNISON);
        let detune = params.detune_cents.clamp(0.0, 100.0);
        let mut phases = [0.0; MAX_UNISON];
        let mut incs = [0.0; MAX_UNISON];
        let mut gl = [0.0; MAX_UNISON];
        let mut gr = [0.0; MAX_UNISON];
        let mut top_freq = params.freq;
        let norm = 1.0 / (unison as f32).sqrt();
        for u in 0..unison {
            let x = if unison == 1 { 0.0 } else { u as f32 / (unison - 1) as f32 * 2.0 - 1.0 };
            let freq = params.freq * 2f32.powf(x * detune / 1200.0);
            top_freq = top_freq.max(freq);
            incs[u] = freq / sr;
            // Unison voices start at spread-out phases so they do not begin as one loud comb.
            phases[u] = if u == 0 { 0.0 } else { (u as f32 * 0.381_966) % 1.0 };
            let angle = (x * params.spread.clamp(0.0, 1.0) + 1.0) * PI / 4.0;
            gl[u] = angle.cos() * norm;
            gr[u] = angle.sin() * norm;
        }
        table.active.fetch_add(1, Ordering::Relaxed);
        let hold_left = if gate.is_some() { None } else { Some((params.duration.max(0.0) * sr) as u64) };
        Self {
            level: level_for(top_freq, sr),
            table,
            p: params,
            unison,
            phases,
            incs,
            gl,
            gr,
            lfo_phase: 0.0,
            samples: 0,
            hold_left,
            gate,
            live_position: None,
            stage: Stage::Attack,
            env: 0.0,
            release_step: 0.0,
            filter: [Svf::default(); 2],
            coef: filter_coefficients(params.cutoff, params.resonance, sr),
            block_frames: 0,
            block_energy: 0.0,
            smoothed: 0.0,
            buf: [0.0; 2],
            buf_idx: 0,
        }
    }

    /// Reads a fixed band-limit level instead of the one that suits the pitch. A diagnostic: level 0
    /// keeps every harmonic the table holds, so a high note read from it aliases, which is exactly
    /// what the band limits exist to prevent (and how a test proves they matter).
    pub fn with_level(mut self, level: usize) -> Self {
        self.level = level.min(MIP_LEVELS - 1);
        self
    }

    /// Lets `position` be moved while the note sounds: the voice reads the f32 bits stored in `live`.
    pub fn with_live_position(mut self, live: Arc<AtomicU32>) -> Self {
        self.live_position = Some(live);
        self
    }

    /// Where in the table this note is reading `t` seconds after it started.
    pub fn position_at(p: &WavetableParams, t: f32, lfo_phase: f32) -> f32 {
        let vel = (p.velocity.clamp(0.0, 1.0) - 0.5) * p.vel_to_position;
        let sweep = p.sweep * (-t / p.sweep_time.max(0.005)).exp();
        (p.position + vel + sweep + p.lfo_depth * 0.5 * (TAU * lfo_phase).sin()).clamp(0.0, 1.0)
    }

    fn advance_envelope(&mut self, sr: f32) {
        let a = self.p.attack.max(0.001);
        let d = self.p.decay.max(0.001);
        let s = self.p.sustain.clamp(0.0, 1.0);
        let r = self.p.release.max(0.005);
        let releasing = match &self.gate {
            Some(g) => !g.load(Ordering::Relaxed),
            None => self.hold_left == Some(0),
        };
        if releasing && !matches!(self.stage, Stage::Release | Stage::Done) {
            self.stage = Stage::Release;
            self.release_step = self.env / (r * sr);
        }
        match self.stage {
            Stage::Attack => {
                self.env += 1.0 / (a * sr);
                if self.env >= 1.0 {
                    self.env = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.env -= (1.0 - s) / (d * sr);
                if self.env <= s {
                    self.env = s;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => {}
            Stage::Release => {
                self.env -= self.release_step;
                if self.env <= 0.0 {
                    self.env = 0.0;
                    self.stage = Stage::Done;
                }
            }
            Stage::Done => {}
        }
        if let Some(left) = self.hold_left.as_mut() {
            *left = left.saturating_sub(1);
        }
    }

    fn next_frame(&mut self) -> Option<[f32; 2]> {
        let sr = ENGINE_SAMPLE_RATE as f32;
        if self.stage == Stage::Done {
            return None;
        }
        self.advance_envelope(sr);

        let t = self.samples as f32 / sr;
        let mut p = self.p;
        if let Some(live) = &self.live_position {
            p.position = f32::from_bits(live.load(Ordering::Relaxed));
        }
        let pos = Self::position_at(&p, t, self.lfo_phase);
        self.lfo_phase = (self.lfo_phase + self.p.lfo_rate.max(0.0) / sr).fract();

        let (mut l, mut r) = (0.0f32, 0.0f32);
        for u in 0..self.unison {
            let s = self.table.read(self.level, pos, self.phases[u]);
            l += s * self.gl[u];
            r += s * self.gr[u];
            self.phases[u] += self.incs[u];
            if self.phases[u] >= 1.0 {
                self.phases[u] -= 1.0;
            }
        }
        if let Some((a1, a2, a3)) = self.coef {
            l = self.filter[0].lowpass(l, a1, a2, a3);
            r = self.filter[1].lowpass(r, a1, a2, a3);
        }
        let amp = self.env * self.p.gain * (0.25 + 0.75 * self.p.velocity.clamp(0.0, 1.0));
        let out = [l * amp, r * amp];

        self.samples += 1;
        self.block_energy += out[0] * out[0] + out[1] * out[1];
        self.block_frames += 1;
        if self.block_frames >= 256 {
            let rms = (self.block_energy / (2.0 * self.block_frames as f32)).sqrt();
            self.smoothed += (rms - self.smoothed) * 0.5;
            self.table.last_pos.store(pos.to_bits(), Ordering::Relaxed);
            self.table.energy.store(self.smoothed.to_bits(), Ordering::Relaxed);
            self.block_frames = 0;
            self.block_energy = 0.0;
        }
        Some(out)
    }
}

impl Drop for WavetableVoice {
    fn drop(&mut self) {
        if self.table.active.fetch_sub(1, Ordering::Relaxed) == 1 {
            self.table.energy.store(0f32.to_bits(), Ordering::Relaxed);
        }
    }
}

pub(crate) fn filter_coefficients(cutoff: f32, resonance: f32, sr: f32) -> Option<(f32, f32, f32)> {
    if cutoff >= 19_000.0 {
        return None;
    }
    let g = (PI * cutoff.clamp(20.0, sr * 0.45) / sr).tan();
    let k = 1.0 / resonance.clamp(0.5, 12.0);
    let a1 = 1.0 / (1.0 + g * (g + k));
    let a2 = g * a1;
    Some((a1, a2, g * a2))
}

impl Iterator for WavetableVoice {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.buf_idx == 0 {
            self.buf = self.next_frame()?;
        }
        let v = self.buf[self.buf_idx as usize];
        self.buf_idx = (self.buf_idx + 1) % 2;
        Some(v)
    }
}

impl Source for WavetableVoice {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        2
    }
    fn sample_rate(&self) -> u32 {
        ENGINE_SAMPLE_RATE
    }
    fn total_duration(&self) -> Option<std::time::Duration> {
        None
    }
}

/// Renders one note to interleaved stereo samples, entirely offline. `seconds` is only a safety
/// limit for a gated note; a timed one ends by itself.
pub fn render_note(table: Arc<WavetableShared>, params: WavetableParams, seconds: f32) -> Vec<f32> {
    let limit = (seconds.max(0.0) * ENGINE_SAMPLE_RATE as f32) as usize * 2;
    WavetableVoice::new(table, params, None).take(limit).collect()
}

// ------------------------------------------------------------------------------------------
// The registry: tables by id
// ------------------------------------------------------------------------------------------
//
// Every caller is on the main thread (the JS ops, the editor widget and note-on), so a mutex per
// table is uncontended; the audio thread never touches it, it holds the `WavetableShared`.

pub type SharedTable = Arc<Mutex<Wavetable>>;

fn registry() -> &'static Mutex<HashMap<String, SharedTable>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, SharedTable>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn lock_table(table: &SharedTable) -> std::sync::MutexGuard<'_, Wavetable> {
    table.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The table called `id`, made (as a sine stack) if there is none.
pub fn ensure_table(id: &str) -> SharedTable {
    let mut reg = registry().lock().unwrap_or_else(|p| p.into_inner());
    reg.entry(id.to_string()).or_insert_with(|| Arc::new(Mutex::new(Wavetable::new(DEFAULT_FRAMES)))).clone()
}

/// Registers `table` under `id`, replacing any table already there.
pub fn insert_table(id: &str, table: SharedTable) {
    registry().lock().unwrap_or_else(|p| p.into_inner()).insert(id.to_string(), table);
}

pub fn get_table(id: &str) -> Option<SharedTable> {
    registry().lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned()
}

pub fn remove_table(id: &str) -> bool {
    registry().lock().unwrap_or_else(|p| p.into_inner()).remove(id).is_some()
}

/// What a voice reads, for the table called `id`.
pub fn shared_for(id: &str) -> Option<Arc<WavetableShared>> {
    get_table(id).map(|t| lock_table(&t).shared())
}

// ------------------------------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn spectrum(samples: &[f32]) -> Vec<f32> {
        let n = samples.len();
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(n);
        let mut input: Vec<f32> = samples.iter().enumerate().map(|(i, v)| v * (0.5 - 0.5 * (TAU * i as f32 / n as f32).cos())).collect();
        let mut out = fft.make_output_vec();
        fft.process(&mut input, &mut out).unwrap();
        out.iter().map(|c| c.norm()).collect()
    }

    #[test]
    fn levels_get_narrower_and_never_exceed_nyquist() {
        assert_eq!(level_harmonics(0), 1023);
        assert!(level_harmonics(19) <= 2);
        for l in 1..MIP_LEVELS {
            assert!(level_harmonics(l) <= level_harmonics(l - 1));
        }
        for &f in &[27.5f32, 110.0, 440.0, 1760.0, 7040.0, 15000.0] {
            let l = level_for(f, 44_100.0);
            assert!(level_harmonics(l) as f32 * f <= 22_050.0 + 1.0, "level {l} at {f} Hz keeps harmonics past Nyquist");
        }
    }

    #[test]
    fn a_new_table_is_a_stack_of_sines() {
        let t = Wavetable::new(8);
        let peak = t.frame(3).iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.9).abs() < 1.0e-3, "peak {peak}");
        let s = spectrum(t.frame(3));
        let fundamental = s[1..8].iter().cloned().fold(0.0, f32::max);
        let rest = s[8..].iter().cloned().fold(0.0, f32::max);
        assert!(rest < fundamental * 1.0e-3, "a sine should be one harmonic: {fundamental} vs {rest}");
    }

    #[test]
    fn a_stamp_raises_the_surface_under_it_and_only_there() {
        let mut t = Wavetable::new(16);
        let before = t.value_at(8.0, 0.1);
        let mut s = Stamp::new(BrushTool::Raise, 8.0, 0.1);
        s.radius = 0.2;
        s.amount = 0.3;
        let touched = t.stamp(&s).expect("a stamp inside the table touches frames");
        assert!(touched.0 <= 8 && touched.1 >= 8);
        assert!(t.value_at(8.0, 0.1) > before + 0.1, "raised only {}", t.value_at(8.0, 0.1) - before);
        let far = Wavetable::new(16).value_at(8.0, 0.75);
        assert!((t.value_at(8.0, 0.75) - far).abs() < 1.0e-6, "a dab leaked to the other side of the cycle");
        assert!((t.value_at(0.0, 0.1) - Wavetable::new(16).value_at(0.0, 0.1)).abs() < 1.0e-6, "a dab leaked to a distant frame");
    }

    #[test]
    fn the_brush_wraps_around_the_cycle_edge() {
        let mut t = Wavetable::new(8);
        let mut s = Stamp::new(BrushTool::Raise, 4.0, 0.0);
        s.radius = 0.2;
        s.amount = 0.3;
        let (a, b) = (t.value_at(4.0, 0.99), t.value_at(4.0, 0.01));
        t.stamp(&s);
        assert!(t.value_at(4.0, 0.99) > a + 0.05 && t.value_at(4.0, 0.01) > b + 0.05, "a cycle is periodic, so an edit at 0 must reach 1");
    }

    #[test]
    fn a_leaning_pen_makes_a_longer_thinner_dab() {
        let mut round = Wavetable::new(16);
        let mut long = Wavetable::new(16);
        let mut s = Stamp::new(BrushTool::Raise, 8.0, 0.5);
        s.radius = 0.2;
        s.amount = 0.4;
        round.stamp(&s);
        s.aspect = 3.0;
        s.angle = 0.0;
        long.stamp(&s);
        let base = Wavetable::new(16);
        let reach = |t: &Wavetable, df: f32, dp: f32| (t.value_at(8.0 + df, 0.5 + dp) - base.value_at(8.0 + df, 0.5 + dp)).abs();
        // Along +phase the long dab reaches further than the round one, across the frames it reaches less.
        assert!(reach(&long, 0.0, 0.08) > reach(&round, 0.0, 0.08) + 0.02, "{} vs {}", reach(&long, 0.0, 0.08), reach(&round, 0.0, 0.08));
        assert!(reach(&long, 1.5, 0.0) < reach(&round, 1.5, 0.0) - 0.02, "{} vs {}", reach(&long, 1.5, 0.0), reach(&round, 1.5, 0.0));
    }

    #[test]
    fn smoothing_takes_off_a_spike_without_moving_the_average_much() {
        let mut t = Wavetable::new(8);
        let mut s = Stamp::new(BrushTool::Raise, 4.0, 0.5);
        s.radius = 0.05;
        s.amount = 0.9;
        t.stamp(&s);
        let peak_before = t.value_at(4.0, 0.5);
        let mut sm = Stamp::new(BrushTool::Smooth, 4.0, 0.5);
        sm.radius = 0.3;
        sm.amount = 0.8;
        for _ in 0..4 {
            t.stamp(&sm);
        }
        assert!(t.value_at(4.0, 0.5) < peak_before - 0.1, "smoothing did not lower the spike");
    }

    #[test]
    fn level_pulls_toward_the_target() {
        let mut t = Wavetable::new(8);
        let mut s = Stamp::new(BrushTool::Level, 4.0, 0.3);
        s.radius = 0.3;
        s.amount = 1.0;
        s.target = 0.5;
        t.stamp(&s);
        assert!((t.value_at(4.0, 0.3) - 0.5).abs() < 0.02, "level reached {}", t.value_at(4.0, 0.3));
    }

    #[test]
    fn undo_and_redo_restore_exactly_and_an_empty_edit_leaves_nothing() {
        let mut t = Wavetable::new(8);
        let original = t.data().to_vec();
        t.begin_edit();
        let mut s = Stamp::new(BrushTool::Raise, 4.0, 0.5);
        s.amount = 0.5;
        t.stamp(&s);
        t.end_edit();
        assert_ne!(t.data(), &original[..]);
        assert!(t.undo());
        assert_eq!(t.data(), &original[..]);
        assert!(t.redo());
        assert_ne!(t.data(), &original[..]);
        t.undo();
        t.begin_edit();
        t.end_edit();
        assert!(!t.can_undo(), "an edit that changed nothing must not leave an undo step");
    }

    #[test]
    fn export_and_import_round_trip_within_quantisation() {
        let mut a = Wavetable::new(12);
        a.load_preset("vowels");
        let mut b = Wavetable::new(4);
        b.import(&a.export()).unwrap();
        assert_eq!(b.frames(), 12);
        let worst = a.data().iter().zip(b.data()).fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
        assert!(worst < 1.0 / 16384.0, "worst error {worst}");
        assert!(b.import("not a table").is_err());
    }

    #[test]
    fn a_timed_note_ends_by_itself_and_a_gated_note_waits_for_its_gate() {
        let t = Wavetable::new(8);
        let mut p = WavetableParams::default();
        p.duration = 0.1;
        p.release = 0.05;
        let timed = render_note(t.shared(), p, 5.0);
        let secs = timed.len() as f32 / 2.0 / ENGINE_SAMPLE_RATE as f32;
        assert!((0.14..0.2).contains(&secs), "0.1 s held + 0.05 s release should end near 0.15 s, got {secs}");

        let gate = Arc::new(AtomicBool::new(true));
        let mut voice = WavetableVoice::new(t.shared(), p, Some(gate.clone()));
        let held: Vec<f32> = voice.by_ref().take(2 * 44_100).collect();
        assert_eq!(held.len(), 2 * 44_100, "a held gate must keep the note alive");
        gate.store(false, Ordering::Relaxed);
        let tail = voice.count();
        assert!(tail < 2 * 44_100 / 10, "the note should release once the gate drops ({tail} samples)");
    }

    #[test]
    fn a_held_note_follows_a_live_position() {
        let mut t = Wavetable::new(16);
        t.load_preset("saw");
        let live = Arc::new(AtomicU32::new(0.0f32.to_bits()));
        let gate = Arc::new(AtomicBool::new(true));
        let mut p = WavetableParams::default();
        p.freq = 110.0;
        let mut voice = WavetableVoice::new(t.shared(), p, Some(gate)).with_live_position(live.clone());
        // Second differences: tiny for a sine, large at the edge of a saw. (Total variation is the same for both.)
        let bright = |v: &[f32]| {
            let left: Vec<f32> = v.iter().step_by(2).cloned().collect();
            left.windows(3).map(|w| (w[2] - 2.0 * w[1] + w[0]).abs()).sum::<f32>() / left.len() as f32
        };
        let _ = voice.by_ref().take(2 * 4410).count();
        let dull: Vec<f32> = voice.by_ref().take(2 * 4410).collect();
        live.store(1.0f32.to_bits(), Ordering::Relaxed);
        let _ = voice.by_ref().take(2 * 512).count();
        let sharp: Vec<f32> = voice.by_ref().take(2 * 4410).collect();
        assert!(bright(&sharp) > bright(&dull) * 2.0, "moving the position from a sine to a saw should brighten the note: {} then {}", bright(&dull), bright(&sharp));
    }

    #[test]
    fn sculpting_while_a_note_sounds_is_heard_on_the_next_samples() {
        let mut t = Wavetable::new(8);
        let mut p = WavetableParams::default();
        p.freq = 220.0;
        p.duration = 2.0;
        let mut voice = WavetableVoice::new(t.shared(), p, None);
        let before: Vec<f32> = voice.by_ref().take(2 * 4410).collect();
        let rms = |v: &[f32]| (v.iter().map(|x| x * x).sum::<f32>() / v.len() as f32).sqrt();
        // Silence the whole table while the voice is mid-note.
        let mut s = Stamp::new(BrushTool::Level, 3.5, 0.5);
        s.radius = 5.0;
        s.amount = 1.0;
        s.target = 0.0;
        t.begin_edit();
        for _ in 0..8 {
            t.stamp(&s);
        }
        t.end_edit();
        t.commit_all();
        let _ = voice.by_ref().take(64).count();
        let after: Vec<f32> = voice.by_ref().take(2 * 4410).collect();
        assert!(rms(&before) > 0.02, "the note was not sounding before the edit");
        assert!(rms(&after) < rms(&before) * 0.05, "the edit was not heard: {} then {}", rms(&before), rms(&after));
    }
}
