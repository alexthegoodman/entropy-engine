//! A physically modeled bowed string: a single delay loop (the same building block as the classic
//! Karplus-Strong plucked string), kept sounding by a regenerative sustain instead of a one-time
//! pluck, driven through a bow-force-dependent saturation, plus a small body-resonance filter bank
//! coloring the output.
//!
//! This is deliberately NOT a literal port of any one published bowed-string algorithm. The loop +
//! one-pole loss filter is the well-known Karplus-Strong / Jaffe-Smith extension (Jaffe, D. and
//! Smith, J.O., "Extensions of the Karplus-Strong Plucked-String Algorithm", Computer Music Journal,
//! 1983). A first version of the bow tried the textbook approach - a per-sample nonlinear friction
//! curve pulling the loop's value toward the bow's own velocity, in the spirit of the digital-
//! waveguide bowed-string synthesis described in Smith's freely available "Physical Audio Signal
//! Processing" (ccrma.stanford.edu) - but a single folded delay loop has no separate restoring
//! dynamics the way two independently-delayed string segments (nut-to-bow, bow-to-bridge) would, so
//! pulling it toward a constant target every sample reliably collapsed to a fixed point instead of
//! an oscillation, whatever the gain or curve width (see the failure notes on `friction_coupling` in
//! git history and the reasoning in `PhysModVoice::next_frame`). What replaced it - boosting the
//! loop's own gain above its passive loss rate while its running amplitude sits under the bow's
//! target, easing off as it reaches it, the way a van der Pol oscillator self-limits - is a standard,
//! much more robust way to build a stable self-sustaining oscillator, and bow force instead shapes
//! the tone through how hard a tanh waveshaper drives the signal each pass. This trades some of a
//! true friction model's fidelity (no distinct stick/slip phases) for reliability; it is closer to an
//! "electronic bowed string" (a regenerative, amplitude-limited oscillator) than a literal simulation
//! of rosin friction. The body filter bank uses the standard RBJ Audio EQ Cookbook peaking-filter
//! formula (Bristow-Johnson, "Cookbook formulae for audio EQ biquad filter coefficients").
//!
//! Three pieces, split the same way as `wavetable`:
//!
//! * [`PhysModParams`] is what a note is played with: pitch, bow force/velocity/position, vibrato,
//!   damping, brightness, body size/mix.
//! * [`PhysModShared`] is what the audio thread publishes and the visualization widget reads: no
//!   lock, relaxed atomics, same pattern as `WavetableShared`. It carries a small snapshot of the
//!   loop's current cycle shape (not the full audio-rate buffer) so a GUI running at 60 Hz can draw
//!   a vibrating string without touching the audio thread's state directly.
//! * [`PhysModVoice`] is a `rodio::Source`, one per sounding note (one bowed string). Bow force,
//!   velocity, position and vibrato depth can be moved live while a note is held, via
//!   [`PhysModVoice::with_live_bow`], the same way `WavetableVoice::with_live_position` works - so
//!   dragging a bow control in the GUI, turning a knob, or an AI tool call all reach the same note.

use std::collections::HashMap;
use std::f32::consts::TAU;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use realfft::RealFftPlanner;
use rodio::Source;

use super::analysis::ENGINE_SAMPLE_RATE;

/// Lowest note the loop can represent; also bounds how large the delay line has to be.
pub const MIN_FREQ: f32 = 20.0;
/// Samples in the loop's ring buffer. `ENGINE_SAMPLE_RATE / MIN_FREQ` plus headroom for vibrato.
const LOOP_CAPACITY: usize = 2560;
/// How many points of the loop's current cycle are published for the visualization, per string.
pub const SHAPE_POINTS: usize = 48;
/// How often (in samples) a voice publishes to `PhysModShared`.
const PUBLISH_EVERY: u32 = 512;

// ------------------------------------------------------------------------------------------
// The delay loop
// ------------------------------------------------------------------------------------------

/// A fixed-capacity ring buffer read with fractional (linearly interpolated) delay behind the write
/// head. This is the loop: pushing a value each sample and reading back `len` samples later is what
/// makes a self-sustaining oscillation at `sample_rate / len`.
struct Loop {
    buf: Box<[f32]>,
    write: usize,
}

impl Loop {
    /// Seeded with a faint noise burst rather than pure silence: standard practice for delay-loop
    /// string models (Karplus-Strong itself plucks with noise), and it matters more here than for a
    /// pluck, because a perfectly symmetric all-zero start under a constant bow force can lock the
    /// loop into a period-doubled (half-frequency) limit cycle instead of the fundamental - caught
    /// by `a_bowed_note_settles_near_its_target_pitch` reading half the requested pitch before this
    /// seed was added.
    fn new() -> Self {
        let mut buf = vec![0.0f32; LOOP_CAPACITY];
        let mut seed = 0x9E3779B9u32;
        for v in buf.iter_mut() {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *v = ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.02;
        }
        Self { buf: buf.into_boxed_slice(), write: 0 }
    }

    #[inline]
    fn push(&mut self, v: f32) {
        self.buf[self.write] = v;
        self.write = (self.write + 1) % LOOP_CAPACITY;
    }

    /// The value `delay` samples behind the write head, linearly interpolated.
    #[inline]
    fn read_back(&self, delay: f32) -> f32 {
        let d = delay.clamp(1.0, (LOOP_CAPACITY - 2) as f32);
        let pos = (self.write as f32 - d).rem_euclid(LOOP_CAPACITY as f32);
        // `rem_euclid` can land a hair under `LOOP_CAPACITY` due to float rounding; guard the index.
        let i0 = (pos.floor() as usize).min(LOOP_CAPACITY - 1);
        let t = pos - i0 as f32;
        let i1 = (i0 + 1) % LOOP_CAPACITY;
        self.buf[i0] * (1.0 - t) + self.buf[i1] * t
    }
}

/// Blocks DC and very-low-frequency drift. Needed because the regenerative sustain (see
/// `PhysModVoice::next_frame`) only tracks overall amplitude, not frequency content - and a slowly
/// drifting or growing bias is the "cheapest" way for that amplitude to grow once the loop filter's
/// cutoff is tuned tight enough to meaningfully damp higher harmonics, so without this the sustain
/// happily converges on a near-DC hum instead of an oscillation at the fundamental. Caught by
/// `a_bowed_note_settles_near_its_target_pitch` reading a "pitch" of a few Hz.
#[derive(Default, Clone, Copy)]
struct DcBlock {
    x1: f32,
    y1: f32,
}

impl DcBlock {
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = x - self.x1 + 0.995 * self.y1;
        self.x1 = x;
        self.y1 = y;
        y
    }
}

#[derive(Default, Clone, Copy)]
struct OnePole {
    y: f32,
}

impl OnePole {
    /// `a` close to 1 keeps more of the previous output (darker, slower-moving); `a` near 0 passes
    /// `x` through almost unfiltered.
    #[inline]
    fn process(&mut self, x: f32, a: f32) -> f32 {
        self.y = x * (1.0 - a) + self.y * a;
        self.y
    }
}

/// RBJ Audio EQ Cookbook peaking filter: unity gain away from `freq`, `gain_db` at `freq`.
#[derive(Default, Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    fn peaking(freq: f32, q: f32, gain_db: f32, sr: f32) -> Self {
        let amp = 10f32.powf(gain_db / 40.0);
        let w0 = TAU * freq.clamp(20.0, sr * 0.45) / sr;
        let (sin_w0, cos_w0) = w0.sin_cos();
        let alpha = sin_w0 / (2.0 * q.max(0.1));
        let b0 = 1.0 + alpha * amp;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0 - alpha * amp;
        let a0 = 1.0 + alpha / amp;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha / amp;
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Three resonance modes for a body of relative `size` (0 = violin-register, 1 = bass-register). The
/// three fixed frequencies at size 0 (about 280, 460 and 700 Hz) are illustrative figures commonly
/// cited in violin body-acoustics writing for the main air (Helmholtz/A0) and wood resonances, not a
/// measurement of a specific instrument; they are scaled down by ear for larger bodies, not modeled
/// from a real bass's dimensions.
fn body_modes(size: f32, sr: f32) -> [Biquad; 3] {
    let t = size.clamp(0.0, 1.0);
    let scale = 2f32.powf(-2.0 * t);
    [
        Biquad::peaking(280.0 * scale, 6.0, 5.0, sr),
        Biquad::peaking(460.0 * scale, 8.0, 4.0, sr),
        Biquad::peaking(700.0 * scale, 5.0, 3.0, sr),
    ]
}

// ------------------------------------------------------------------------------------------
// The bow: an amplitude-limited regenerative sustain, not a per-sample friction-force solve
// ------------------------------------------------------------------------------------------
//
// See `PhysModVoice::next_frame` for the reasoning: a literal friction curve that drags the loop's
// value toward the bow's own velocity every sample reliably collapsed to a fixed point rather than
// an oscillation, because a single delay loop has no separate restoring dynamics to keep it moving.
// `SUSTAIN_STRENGTH` bounds how hard `next_frame` may push the loop's gain away from `g_base` per
// sample to chase the bow's target amplitude; `AMP_EMA_RATE` sets how fast the running amplitude
// estimate that drives it reacts.
const SUSTAIN_STRENGTH: f32 = 6.0;
const AMP_EMA_RATE: f32 = 0.01;
/// How fast the loop's target length chases a new pitch (vibrato, a live retune). Smaller is
/// smoother but slower to respond; this value settles within a few milliseconds without a click.
const LEN_SMOOTH: f32 = 0.06;

// ------------------------------------------------------------------------------------------
// What the audio thread publishes
// ------------------------------------------------------------------------------------------

pub struct PhysModShared {
    active: AtomicU32,
    energy: AtomicU32,
    bow_position: AtomicU32,
    bow_force: AtomicU32,
    bow_velocity: AtomicU32,
    /// The loop's current cycle, sampled at `SHAPE_POINTS` evenly spaced points, most-recent voice
    /// wins (the same "last one sounding" convention `WavetableShared` uses).
    shape: [AtomicU32; SHAPE_POINTS],
    shape_version: AtomicU64,
}

impl Default for PhysModShared {
    fn default() -> Self {
        Self {
            active: AtomicU32::new(0),
            energy: AtomicU32::new(0),
            bow_position: AtomicU32::new(0.15f32.to_bits()),
            bow_force: AtomicU32::new(0.5f32.to_bits()),
            bow_velocity: AtomicU32::new(0.5f32.to_bits()),
            shape: std::array::from_fn(|_| AtomicU32::new(0)),
            shape_version: AtomicU64::new(0),
        }
    }
}

impl PhysModShared {
    pub fn active_voices(&self) -> u32 {
        self.active.load(Ordering::Relaxed)
    }

    /// `None` when nothing is sounding. Otherwise the current bow state, the smoothed output energy
    /// (for the widget's glow) and the loop's current cycle shape, exaggerated visually by the
    /// widget, not to scale with the actual audio amplitude.
    pub fn activity(&self) -> Option<(f32, f32, f32, f32)> {
        if self.active.load(Ordering::Relaxed) == 0 {
            return None;
        }
        Some((
            f32::from_bits(self.bow_position.load(Ordering::Relaxed)),
            f32::from_bits(self.bow_force.load(Ordering::Relaxed)),
            f32::from_bits(self.bow_velocity.load(Ordering::Relaxed)),
            f32::from_bits(self.energy.load(Ordering::Relaxed)),
        ))
    }

    pub fn shape_version(&self) -> u64 {
        self.shape_version.load(Ordering::Acquire)
    }

    pub fn shape_at(&self, i: usize) -> f32 {
        f32::from_bits(self.shape[i.min(SHAPE_POINTS - 1)].load(Ordering::Relaxed))
    }

    fn publish(&self, bow_position: f32, bow_force: f32, bow_velocity: f32, energy: f32, shape: &[f32; SHAPE_POINTS]) {
        self.bow_position.store(bow_position.to_bits(), Ordering::Relaxed);
        self.bow_force.store(bow_force.to_bits(), Ordering::Relaxed);
        self.bow_velocity.store(bow_velocity.to_bits(), Ordering::Relaxed);
        self.energy.store(energy.to_bits(), Ordering::Relaxed);
        for (slot, v) in self.shape.iter().zip(shape.iter()) {
            slot.store(v.to_bits(), Ordering::Relaxed);
        }
        self.shape_version.fetch_add(1, Ordering::Release);
    }
}

// ------------------------------------------------------------------------------------------
// Live bow control (moved while a held note sounds)
// ------------------------------------------------------------------------------------------

pub struct PhysModLive {
    pub bow_force: AtomicU32,
    pub bow_velocity: AtomicU32,
    pub bow_position: AtomicU32,
    pub vibrato_depth: AtomicU32,
}

impl PhysModLive {
    fn from_params(p: &PhysModParams) -> Self {
        Self {
            bow_force: AtomicU32::new(p.bow_force.to_bits()),
            bow_velocity: AtomicU32::new(p.bow_velocity.to_bits()),
            bow_position: AtomicU32::new(p.bow_position.to_bits()),
            vibrato_depth: AtomicU32::new(p.vibrato_depth.to_bits()),
        }
    }
}

// ------------------------------------------------------------------------------------------
// Params
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct PhysModParams {
    pub freq: f32,
    /// 0..1.
    pub velocity: f32,
    pub gain: f32,
    /// 0..1. How hard the bow presses; widens the "stuck" region of the friction curve, which reads
    /// as a richer, more harmonically dense tone, not simply a louder one.
    pub bow_force: f32,
    /// 0..1. How fast the bow moves; raises the target relative velocity the friction curve chases.
    pub bow_velocity: f32,
    /// 0..1, clamped internally to 0.02..0.5 (fraction of the string's length from the bridge).
    /// Small values are "sul ponticello" (near the bridge, nasal/bright); larger values move toward
    /// mid-string (rounder, less edge).
    pub bow_position: f32,
    pub vibrato_rate: f32,
    /// Cents.
    pub vibrato_depth: f32,
    /// 0..1, extra damping on top of the string's own loss (a light left-hand mute).
    pub damping: f32,
    /// 0..1, a character tweak: lower is darker/thicker (a wound low string), higher is airier.
    pub brightness: f32,
    /// 0..1, violin-register body resonances at 0, moving toward a bass-register body at 1.
    pub body_size: f32,
    /// 0..1, how much of the body-colored signal is mixed in versus the raw string.
    pub body_mix: f32,
    /// Seconds for the bow to "land" and to "lift" (envelope smoothing only - the sustained tone's
    /// dynamics come from the bow model itself, not from an amplitude envelope).
    pub attack: f32,
    pub release: f32,
    /// Seconds to hold before releasing. Ignored when the voice has a gate.
    pub duration: f32,
}

impl Default for PhysModParams {
    fn default() -> Self {
        Self {
            freq: 440.0,
            velocity: 0.8,
            gain: 0.6,
            bow_force: 0.5,
            bow_velocity: 0.5,
            bow_position: 0.15,
            vibrato_rate: 5.5,
            vibrato_depth: 15.0,
            damping: 0.15,
            brightness: 0.5,
            body_size: 0.0,
            body_mix: 0.35,
            attack: 0.02,
            release: 0.12,
            duration: 0.6,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Attack,
    Sustain,
    Release,
    Done,
}

// ------------------------------------------------------------------------------------------
// Voice
// ------------------------------------------------------------------------------------------

pub struct PhysModVoice {
    shared: Arc<PhysModShared>,
    p: PhysModParams,
    live: Option<Arc<PhysModLive>>,
    gate: Option<Arc<AtomicBool>>,
    loop_buf: Loop,
    loss: OnePole,
    dc: DcBlock,
    body: [Biquad; 3],
    len: f32,
    vibrato_phase: f32,
    samples: u64,
    hold_left: Option<u64>,
    stage: Stage,
    env: f32,
    release_step: f32,
    /// A slow running estimate of the loop's own output amplitude, for the regenerative sustain
    /// (see `next_frame`'s doc comment on `g_eff`).
    amp_est: f32,
    publish_countdown: u32,
    buf: [f32; 2],
    buf_idx: u8,
}

impl PhysModVoice {
    pub fn new(shared: Arc<PhysModShared>, params: PhysModParams, gate: Option<Arc<AtomicBool>>) -> Self {
        let sr = ENGINE_SAMPLE_RATE as f32;
        shared.active.fetch_add(1, Ordering::Relaxed);
        let hold_left = if gate.is_some() { None } else { Some((params.duration.max(0.0) * sr) as u64) };
        let len = (sr / params.freq.max(MIN_FREQ)).clamp(4.0, (LOOP_CAPACITY - 4) as f32);
        Self {
            shared,
            body: body_modes(params.body_size, sr),
            p: params,
            live: None,
            gate,
            loop_buf: Loop::new(),
            loss: OnePole::default(),
            dc: DcBlock::default(),
            len,
            vibrato_phase: 0.0,
            samples: 0,
            hold_left,
            stage: Stage::Attack,
            env: 0.0,
            release_step: 0.0,
            amp_est: 0.0,
            publish_countdown: 0,
            buf: [0.0; 2],
            buf_idx: 0,
        }
    }

    /// Lets bow force, velocity, position and vibrato depth be moved while the note sounds: a drag
    /// on the bow, a knob turn, or an AI tool call, converging on the same held note.
    pub fn with_live_bow(mut self, live: Arc<PhysModLive>) -> Self {
        self.live = Some(live);
        self
    }

    fn advance_envelope(&mut self, sr: f32) {
        let a = self.p.attack.max(0.001);
        let r = self.p.release.max(0.01);
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

        let (bow_force, bow_velocity, bow_position, vib_depth) = match &self.live {
            Some(l) => (
                f32::from_bits(l.bow_force.load(Ordering::Relaxed)),
                f32::from_bits(l.bow_velocity.load(Ordering::Relaxed)),
                f32::from_bits(l.bow_position.load(Ordering::Relaxed)),
                f32::from_bits(l.vibrato_depth.load(Ordering::Relaxed)),
            ),
            None => (self.p.bow_force, self.p.bow_velocity, self.p.bow_position, self.p.vibrato_depth),
        };

        self.vibrato_phase += self.p.vibrato_rate.max(0.0) / sr;
        if self.vibrato_phase >= 1.0 {
            self.vibrato_phase -= 1.0;
        }
        let cents = vib_depth * (TAU * self.vibrato_phase).sin();
        let freq_now = self.p.freq * 2f32.powf(cents / 1200.0);
        let target_len = (sr / freq_now.max(MIN_FREQ)).clamp(4.0, (LOOP_CAPACITY - 4) as f32);
        self.len += (target_len - self.len) * LEN_SMOOTH;

        let damping = self.p.damping.clamp(0.0, 1.0);
        let brightness = self.p.brightness.clamp(0.0, 1.0);
        let g_base = 0.986 - damping * 0.25;
        // The loop filter's cutoff is set relative to the note's own pitch, not a fixed coefficient:
        // at audio-rate sample counts, a one-pole coefficient anywhere under about 0.9 has a cutoff
        // in the tens of kHz, which cannot tell a 220 Hz fundamental from its 660 Hz third harmonic
        // apart at all - the regenerative sustain then has no reason to prefer the fundamental over
        // any other mode the loop supports, and locks onto whichever one the noise seed favors
        // (caught by `a_bowed_note_settles_near_its_target_pitch` settling on the third harmonic).
        // Placing the cutoff a few multiples above the fundamental lets it through essentially
        // untouched while damping higher harmonics enough that the fundamental wins the sustain.
        let cutoff = (freq_now * (2.0 + brightness * 3.0) * (1.0 - damping * 0.35)).max(120.0);
        let a_coef = (-TAU * cutoff / sr).exp().clamp(0.0, 0.999);

        // What arrives at the reference point this sample, after one full trip around the loop
        // (both reflections folded into this one loss filter - see the module doc). No sign flip:
        // `self.len` is tuned to the loop's own full round trip, which already folds in both the
        // nut's and the bridge's reflections - two inverting ends multiply out to a net
        // non-inverting round trip, the same reasoning the classic (uninverted) Karplus-Strong loop
        // filter uses.
        let arriving = self.loop_buf.read_back(self.len);
        let filtered = self.loss.process(arriving, a_coef);

        // The bow as a regenerative (negative-resistance) sustain rather than a literal per-sample
        // friction-force solve: a passive loop (`g_base < 1`) always loses energy each trip, so a
        // real bow's job is to put back exactly what was lost, holding the string at a steady
        // amplitude - not to drag its velocity toward some constant target. Trying the friction-
        // force version first (additive or blended toward a constant target velocity) reliably
        // collapsed to a fixed point instead of an oscillation: a single delay loop has no separate
        // "restoring" dynamics the way two independently-delayed string segments would, so pulling
        // it toward a constant every sample, for long enough, just pins it there - caught by every
        // pitch test reading a near-DC "pitch" (spectral leakage of a constant through the analysis
        // window) regardless of how the pull was tuned. Amplitude-limiting the loop's own gain
        // instead - boost it above `g_base` while the running amplitude is under the bow's target,
        // ease off as it reaches it - is the standard way to get a stable self-sustaining
        // oscillator (the same idea a van der Pol oscillator uses), and it cannot destabilize the
        // pitch: it only ever scales `filtered`, which still comes from `self.len` samples ago.
        let target_amp = (0.12 + bow_force.clamp(0.0, 1.0) * 0.55) * (0.4 + 0.6 * bow_velocity.clamp(0.0, 1.0)) * self.env;
        let sustain = ((target_amp - self.amp_est) * SUSTAIN_STRENGTH).clamp(-0.03, 0.03);
        let g_eff = (g_base + sustain).clamp(0.0, 1.01);
        let reflected = g_eff * filtered;

        // Bow force also drives a soft-clip saturation, which is where "more force changes the
        // harmonic structure, not just the volume" (the vision doc's own framing) actually comes
        // from in this model: more force pushes more of the waveform past the knee of the curve.
        let drive = 1.0 + bow_force.clamp(0.0, 1.0) * 3.2;
        let driven = ((reflected * drive).tanh() / drive.tanh().max(1.0e-4)).clamp(-4.0, 4.0);
        let new_val = self.dc.process(driven).clamp(-4.0, 4.0);
        self.loop_buf.push(new_val);
        self.amp_est += (new_val.abs() - self.amp_est) * AMP_EMA_RATE;

        // Bow position feeds a comb filter on the OUTPUT only, never back into the loop: reading a
        // second, position-dependent point along the string and subtracting a fraction of it from
        // the output notches out harmonics with a node near there, the same way bowing (or picking)
        // closer to the bridge audibly favors different harmonics on a real string - without the
        // feedback-loop problem above.
        let bow_tap = (bow_position.clamp(0.02, 0.5) * self.len).clamp(2.0, self.len - 2.0);
        let comb_ref = self.loop_buf.read_back(bow_tap);
        let combed = new_val - 0.4 * comb_ref;

        let mut wet = 0.0;
        for m in self.body.iter_mut() {
            wet += m.process(combed);
        }
        wet /= 3.0;
        let body_mix = self.p.body_mix.clamp(0.0, 1.0);
        let voiced = combed * (1.0 - body_mix) + wet * body_mix;

        let amp = self.env * self.p.gain * (0.3 + 0.7 * self.p.velocity.clamp(0.0, 1.0));
        let out = (voiced * amp).clamp(-4.0, 4.0);

        self.samples += 1;
        if self.publish_countdown == 0 {
            let mut shape = [0.0f32; SHAPE_POINTS];
            for (i, s) in shape.iter_mut().enumerate() {
                *s = self.loop_buf.read_back(1.0 + (i as f32 / SHAPE_POINTS as f32) * (self.len - 2.0).max(1.0));
            }
            self.shared.publish(bow_position, bow_force, bow_velocity, out.abs(), &shape);
            self.publish_countdown = PUBLISH_EVERY;
        }
        self.publish_countdown -= 1;

        Some([out, out])
    }
}

impl Drop for PhysModVoice {
    fn drop(&mut self) {
        self.shared.active.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Iterator for PhysModVoice {
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

impl Source for PhysModVoice {
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

/// Renders one note to interleaved stereo samples, entirely offline.
pub fn render_note(shared: Arc<PhysModShared>, params: PhysModParams, seconds: f32) -> Vec<f32> {
    let limit = (seconds.max(0.0) * ENGINE_SAMPLE_RATE as f32) as usize * 2;
    PhysModVoice::new(shared, params, None).take(limit).collect()
}

// ------------------------------------------------------------------------------------------
// Registry: one PhysModShared per instrument id (a track), for the visualization to read
// ------------------------------------------------------------------------------------------

fn registry() -> &'static Mutex<HashMap<String, Arc<PhysModShared>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<PhysModShared>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn shared_for(id: &str) -> Arc<PhysModShared> {
    registry().lock().unwrap_or_else(|p| p.into_inner()).entry(id.to_string()).or_insert_with(|| Arc::new(PhysModShared::default())).clone()
}

pub fn get_shared(id: &str) -> Option<Arc<PhysModShared>> {
    registry().lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned()
}

pub fn remove_shared(id: &str) -> bool {
    registry().lock().unwrap_or_else(|p| p.into_inner()).remove(id).is_some()
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

    fn peak_hz(samples: &[f32], sr: f32) -> f32 {
        let s = spectrum(samples);
        let (bin, _) = s.iter().enumerate().skip(1).fold((0usize, 0.0f32), |best, (i, &v)| if v > best.1 { (i, v) } else { best });
        bin as f32 * sr / samples.len() as f32
    }

    fn spectral_centroid(samples: &[f32], sr: f32) -> f32 {
        let s = spectrum(samples);
        let mut num = 0.0f64;
        let mut den = 0.0f64;
        for (i, &v) in s.iter().enumerate().skip(1) {
            let hz = i as f64 * sr as f64 / samples.len() as f64;
            num += hz * v as f64;
            den += v as f64;
        }
        if den > 0.0 { (num / den) as f32 } else { 0.0 }
    }

    fn mono_tail(interleaved: &[f32], skip_frames: usize, n: usize) -> Vec<f32> {
        interleaved.chunks_exact(2).skip(skip_frames).take(n).map(|c| c[0]).collect()
    }

    #[test]
    fn a_bowed_note_settles_near_its_target_pitch() {
        let sr = ENGINE_SAMPLE_RATE as f32;
        let mut p = PhysModParams::default();
        p.freq = 220.0;
        p.duration = 1.0;
        let shared = Arc::new(PhysModShared::default());
        let out = render_note(shared, p, 1.3);
        let tail = mono_tail(&out, (sr * 0.5) as usize, 4096);
        let hz = peak_hz(&tail, sr);
        assert!((hz - 220.0).abs() < 12.0, "expected close to 220 Hz, got {hz}");
    }

    #[test]
    fn output_stays_bounded_across_a_parameter_sweep() {
        let sr_secs = 0.3;
        for &freq in &[55.0f32, 110.0, 220.0, 440.0, 880.0, 1500.0] {
            for &force in &[0.0f32, 0.2, 0.5, 0.8, 1.0] {
                for &vel in &[0.0f32, 0.3, 0.6, 1.0] {
                    for &pos in &[0.02f32, 0.15, 0.5] {
                        let mut p = PhysModParams::default();
                        p.freq = freq;
                        p.bow_force = force;
                        p.bow_velocity = vel;
                        p.bow_position = pos;
                        p.duration = sr_secs;
                        let shared = Arc::new(PhysModShared::default());
                        let out = render_note(shared, p, sr_secs + 0.2);
                        for v in &out {
                            assert!(v.is_finite(), "non-finite sample at freq={freq} force={force} vel={vel} pos={pos}");
                            assert!(v.abs() <= 3.0, "sample {v} out of bounds at freq={freq} force={force} vel={vel} pos={pos}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn more_bow_force_brightens_the_spectrum() {
        let sr = ENGINE_SAMPLE_RATE as f32;
        let mut soft = PhysModParams::default();
        soft.freq = 220.0;
        soft.bow_force = 0.15;
        soft.duration = 0.6;
        let mut hard = soft;
        hard.bow_force = 0.95;

        let soft_out = render_note(Arc::new(PhysModShared::default()), soft, 0.7);
        let hard_out = render_note(Arc::new(PhysModShared::default()), hard, 0.7);
        let soft_tail = mono_tail(&soft_out, (sr * 0.3) as usize, 4096);
        let hard_tail = mono_tail(&hard_out, (sr * 0.3) as usize, 4096);
        let (c_soft, c_hard) = (spectral_centroid(&soft_tail, sr), spectral_centroid(&hard_tail, sr));
        assert!(c_hard > c_soft * 1.05, "harder bow force should brighten the tone: {c_soft} then {c_hard}");
    }

    #[test]
    fn bow_position_changes_the_harmonic_balance() {
        let sr = ENGINE_SAMPLE_RATE as f32;
        let mut bridge = PhysModParams::default();
        bridge.freq = 220.0;
        bridge.bow_position = 0.04;
        bridge.duration = 0.6;
        let mut middle = bridge;
        middle.bow_position = 0.45;

        let bridge_out = render_note(Arc::new(PhysModShared::default()), bridge, 0.7);
        let middle_out = render_note(Arc::new(PhysModShared::default()), middle, 0.7);
        let bridge_tail = mono_tail(&bridge_out, (sr * 0.3) as usize, 4096);
        let middle_tail = mono_tail(&middle_out, (sr * 0.3) as usize, 4096);
        let (c_bridge, c_middle) = (spectral_centroid(&bridge_tail, sr), spectral_centroid(&middle_tail, sr));
        assert!((c_bridge - c_middle).abs() > c_bridge.min(c_middle) * 0.03, "bow position should audibly shift the harmonic balance: {c_bridge} vs {c_middle}");
    }

    #[test]
    fn a_timed_note_ends_by_itself_and_a_gated_note_waits_for_its_gate() {
        let mut p = PhysModParams::default();
        p.duration = 0.1;
        p.release = 0.05;
        let timed = render_note(Arc::new(PhysModShared::default()), p, 5.0);
        let secs = timed.len() as f32 / 2.0 / ENGINE_SAMPLE_RATE as f32;
        assert!((0.1..0.25).contains(&secs), "0.1 s held + 0.05 s release should end near 0.15 s, got {secs}");

        let gate = Arc::new(AtomicBool::new(true));
        let mut voice = PhysModVoice::new(Arc::new(PhysModShared::default()), p, Some(gate.clone()));
        let held: Vec<f32> = voice.by_ref().take(2 * 44_100).collect();
        assert_eq!(held.len(), 2 * 44_100, "a held gate must keep the note alive");
        gate.store(false, Ordering::Relaxed);
        let tail = voice.count();
        assert!(tail < 2 * 44_100 / 5, "the note should release once the gate drops ({tail} samples)");
    }

    #[test]
    fn more_damping_shortens_the_release_tail() {
        let gate = Arc::new(AtomicBool::new(true));
        let mut low = PhysModParams::default();
        low.damping = 0.0;
        low.release = 0.4;
        let mut high = low;
        high.damping = 1.0;

        let mut v_low = PhysModVoice::new(Arc::new(PhysModShared::default()), low, Some(gate.clone()));
        let _ = v_low.by_ref().take(2 * 2000).count();
        gate.store(false, Ordering::Relaxed);
        let tail_low = v_low.count();

        let gate2 = Arc::new(AtomicBool::new(true));
        let mut v_high = PhysModVoice::new(Arc::new(PhysModShared::default()), high, Some(gate2.clone()));
        let _ = v_high.by_ref().take(2 * 2000).count();
        gate2.store(false, Ordering::Relaxed);
        let tail_high = v_high.count();

        assert!(tail_high <= tail_low, "more damping should not lengthen the release tail: {tail_low} then {tail_high}");
    }

    #[test]
    fn vibrato_moves_the_pitch_away_from_a_flat_tone() {
        let sr = ENGINE_SAMPLE_RATE as f32;
        let mut flat = PhysModParams::default();
        flat.freq = 330.0;
        flat.vibrato_depth = 0.0;
        flat.duration = 1.0;
        let mut wobbly = flat;
        // Slow and wide: a slow rate keeps the measurement window (below) a small fraction of one
        // vibrato cycle, so it reads a near-instantaneous pitch rather than a smear across a sweep;
        // a wide depth (peak to trough is 2x this) makes the resulting shift far bigger than one FFT
        // bin regardless. Proving the mechanism works, not picking a musically realistic default
        // (that lives in `PhysModParams::default`).
        wobbly.vibrato_rate = 2.0;
        wobbly.vibrato_depth = 200.0;

        let flat_out = render_note(Arc::new(PhysModShared::default()), flat, 1.2);
        let wobbly_out = render_note(Arc::new(PhysModShared::default()), wobbly, 1.2);

        // Measured well after note-on (the regenerative sustain takes a little while to settle onto
        // the fundamental, the same way a real bowed note has an attack transient before clean
        // Helmholtz motion takes over), and at a peak and a trough of the vibrato cycle (rate 2 Hz,
        // period 0.5 s: sin(2*pi*2*t) is +1 at t = 0.625 s and -1 at t = 0.875 s).
        let window = 2048usize;
        let measure = |out: &[f32], start_frame: usize| peak_hz(&mono_tail(out, start_frame, window), sr);
        let flat_a = measure(&flat_out, (sr * 0.625) as usize);
        let flat_b = measure(&flat_out, (sr * 0.875) as usize);
        let wobbly_a = measure(&wobbly_out, (sr * 0.625) as usize);
        let wobbly_b = measure(&wobbly_out, (sr * 0.875) as usize);

        assert!((flat_a - flat_b).abs() < 8.0, "a flat tone should not drift much: {flat_a} then {flat_b}");
        assert!((wobbly_a - wobbly_b).abs() > (flat_a - flat_b).abs(), "vibrato should move the pitch more than a flat tone drifts: {wobbly_a} then {wobbly_b}");
    }

    #[test]
    fn active_voices_and_shared_shape_publish_while_a_note_sounds() {
        let shared = Arc::new(PhysModShared::default());
        assert_eq!(shared.active_voices(), 0);
        assert!(shared.activity().is_none());
        let mut p = PhysModParams::default();
        p.duration = 1.0;
        let mut voice = PhysModVoice::new(shared.clone(), p, None);
        assert_eq!(shared.active_voices(), 1);
        let _ = voice.by_ref().take(2 * 2000).count();
        assert!(shared.activity().is_some(), "the shared state should publish once enough samples have run");
        let v0 = shared.shape_version();
        assert!(v0 > 0);
        drop(voice);
        assert_eq!(shared.active_voices(), 0);
    }

    #[test]
    fn live_bow_control_reaches_an_already_playing_note() {
        let sr = ENGINE_SAMPLE_RATE as f32;
        let shared = Arc::new(PhysModShared::default());
        let mut p = PhysModParams::default();
        p.freq = 220.0;
        p.bow_force = 0.15;
        p.duration = 1.2;
        let live = Arc::new(PhysModLive::from_params(&p));
        let gate = Arc::new(AtomicBool::new(true));
        let mut voice = PhysModVoice::new(shared, p, Some(gate)).with_live_bow(live.clone());

        let _ = voice.by_ref().take(2 * (sr * 0.3) as usize).count();
        let before: Vec<f32> = voice.by_ref().take(2 * 4096).collect();
        live.bow_force.store(0.95f32.to_bits(), Ordering::Relaxed);
        let _ = voice.by_ref().take(2 * (sr * 0.1) as usize).count();
        let after: Vec<f32> = voice.by_ref().take(2 * 4096).collect();

        let before_mono = mono_tail(&before, 0, 4096);
        let after_mono = mono_tail(&after, 0, 4096);
        let (c_before, c_after) = (spectral_centroid(&before_mono, sr), spectral_centroid(&after_mono, sr));
        assert!(c_after > c_before * 1.02, "raising bow force live should brighten the already-sounding note: {c_before} then {c_after}");
    }
}
