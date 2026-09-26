//! The kit at work: what the audio thread publishes for the view ([`MatterShared`]), the live kit
//! a track's hits go to ([`KitVoice`] and its [`KitHandle`]), offline rendering of a track's hits
//! ([`render_performance`]), and a registry of shared states by kit id - the same arrangement as
//! the strings' and the brass's.
//!
//! A kit takes a moment to build (a second or so the first time, a tenth after: the drums and
//! plates are cached), so it is built off the audio thread and handed to the track's bus when it is
//! ready; the audio thread only ever plays it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rodio::Source;

use super::drum::Strike;
use super::kit::{Kit, KitHit, KitSpec, Piece, BLOCK, FIELD, PIECES, SPECTRUM, TRACE_CAPTURE};
use crate::audio::analysis::ENGINE_SAMPLE_RATE;

/// Points of the latest strike's force pulse published.
pub const TRACE_POINTS: usize = 96;
/// How often (output samples) the voice publishes (~86 times a second).
const PUBLISH_EVERY: u32 = 512;

fn load(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}
fn store(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed)
}
fn atomics<const N: usize>() -> [AtomicU32; N] {
    std::array::from_fn(|_| AtomicU32::new(0))
}

/// One piece as the view reads it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PieceView {
    pub awake: bool,
    pub energy: f32,
    pub level: f32,
    /// Strikes so far (a new number is a new hit).
    pub strikes: u32,
    pub position: f32,
    pub angle: f32,
    pub speed_in: f32,
    pub speed_out: f32,
    pub contact_ms: f32,
    pub peak_force: f32,
    pub gap: f32,
    pub flying: bool,
    pub glide_cents: f32,
    pub wires_lifted: u32,
    pub wire_landings: u32,
    pub nonlinear: bool,
    pub mix: f32,
}

#[derive(Default)]
struct PieceShared {
    awake: AtomicBool,
    energy: AtomicU32,
    level: AtomicU32,
    strikes: AtomicU32,
    position: AtomicU32,
    angle: AtomicU32,
    speed_in: AtomicU32,
    speed_out: AtomicU32,
    contact_ms: AtomicU32,
    peak_force: AtomicU32,
    gap: AtomicU32,
    flying: AtomicBool,
    glide: AtomicU32,
    wires_lifted: AtomicU32,
    wire_landings: AtomicU32,
    nonlinear: AtomicBool,
    mix: AtomicU32,
}

/// What a live kit publishes and the view (and `Entropy.Matter.info`) reads, lock-free.
pub struct MatterShared {
    active: AtomicU32,
    version: AtomicU64,
    focus: AtomicU32,
    workers: AtomicU32,
    spec: [AtomicU32; 7],
    snares: AtomicBool,
    sympathetic: AtomicBool,
    pieces: [PieceShared; PIECES],
    field: Vec<AtomicU32>,
    spec_hz: Vec<AtomicU32>,
    spec_amp: Vec<AtomicU32>,
    trace: [AtomicU32; TRACE_POINTS],
    trace_ms: AtomicU32,
    trace_piece: AtomicU32,
}

impl Default for MatterShared {
    fn default() -> Self {
        let s = Self {
            active: AtomicU32::new(0),
            version: AtomicU64::new(0),
            focus: AtomicU32::new(Piece::Snare.index() as u32),
            workers: AtomicU32::new(0),
            spec: atomics(),
            snares: AtomicBool::new(true),
            sympathetic: AtomicBool::new(true),
            pieces: std::array::from_fn(|_| PieceShared::default()),
            field: (0..PIECES * FIELD).map(|_| AtomicU32::new(0)).collect(),
            spec_hz: (0..PIECES * SPECTRUM).map(|_| AtomicU32::new(0)).collect(),
            spec_amp: (0..PIECES * SPECTRUM).map(|_| AtomicU32::new(0)).collect(),
            trace: atomics(),
            trace_ms: AtomicU32::new(0),
            trace_piece: AtomicU32::new(Piece::Snare.index() as u32),
        };
        s.set_spec(&KitSpec::default());
        for p in &s.pieces {
            store(&p.mix, 1.0);
        }
        s
    }
}

impl MatterShared {
    /// Kits currently publishing here.
    pub fn active_voices(&self) -> u32 {
        self.active.load(Ordering::Relaxed)
    }

    /// Bumped on every publish.
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    /// The piece struck most recently.
    pub fn focus(&self) -> Piece {
        Piece::from_index(self.focus.load(Ordering::Relaxed) as usize)
    }

    /// Threads (besides the audio thread) the kit plays on.
    pub fn workers(&self) -> u32 {
        self.workers.load(Ordering::Relaxed)
    }

    /// The kit as built (its tunings and settings).
    pub fn spec(&self) -> KitSpec {
        KitSpec {
            kick: load(&self.spec[0]),
            snare: load(&self.spec[1]),
            rack_tom: load(&self.spec[2]),
            floor_tom: load(&self.spec[3]),
            kick_muffling: load(&self.spec[4]),
            snare_tension: load(&self.spec[5]),
            snares: self.snares.load(Ordering::Relaxed),
            sympathetic: self.sympathetic.load(Ordering::Relaxed),
        }
    }

    fn set_spec(&self, s: &KitSpec) {
        for (slot, v) in self.spec.iter().zip([s.kick, s.snare, s.rack_tom, s.floor_tom, s.kick_muffling, s.snare_tension, 0.0]) {
            store(slot, v);
        }
        self.snares.store(s.snares, Ordering::Relaxed);
        self.sympathetic.store(s.sympathetic, Ordering::Relaxed);
    }

    pub fn piece(&self, piece: Piece) -> PieceView {
        let p = &self.pieces[piece.index()];
        PieceView {
            awake: p.awake.load(Ordering::Relaxed),
            energy: load(&p.energy),
            level: load(&p.level),
            strikes: p.strikes.load(Ordering::Relaxed),
            position: load(&p.position),
            angle: load(&p.angle),
            speed_in: load(&p.speed_in),
            speed_out: load(&p.speed_out),
            contact_ms: load(&p.contact_ms),
            peak_force: load(&p.peak_force),
            gap: load(&p.gap),
            flying: p.flying.load(Ordering::Relaxed),
            glide_cents: load(&p.glide),
            wires_lifted: p.wires_lifted.load(Ordering::Relaxed),
            wire_landings: p.wire_landings.load(Ordering::Relaxed),
            nonlinear: p.nonlinear.load(Ordering::Relaxed),
            mix: load(&p.mix),
        }
    }

    /// The struck face's displacement (m) at field point `i` (see `kit::field_point`).
    pub fn field(&self, piece: Piece, i: usize) -> f32 {
        load(&self.field[piece.index() * FIELD + i.min(FIELD - 1)])
    }

    /// Mode `k` of the struck face: (Hz, amplitude m).
    pub fn mode(&self, piece: Piece, k: usize) -> (f32, f32) {
        let i = piece.index() * SPECTRUM + k.min(SPECTRUM - 1);
        (load(&self.spec_hz[i]), load(&self.spec_amp[i]))
    }

    /// The latest strike's contact force: which piece, how many milliseconds the pulse spans, and
    /// point `i` of `TRACE_POINTS` over that span (N).
    pub fn trace(&self, i: usize) -> f32 {
        load(&self.trace[i.min(TRACE_POINTS - 1)])
    }

    pub fn trace_span(&self) -> (Piece, f32) {
        (Piece::from_index(self.trace_piece.load(Ordering::Relaxed) as usize), load(&self.trace_ms))
    }

    fn publish(&self, kit: &Kit, mix: &[f32; PIECES], scratch: &mut Scratch) {
        let sr = kit.sample_rate();
        for piece in Piece::ALL {
            let s = kit.state(piece);
            let p = &self.pieces[piece.index()];
            p.awake.store(s.awake, Ordering::Relaxed);
            store(&p.energy, s.energy);
            store(&p.level, s.level);
            p.strikes.store(s.report.count, Ordering::Relaxed);
            store(&p.position, s.report.position);
            store(&p.angle, s.report.angle);
            store(&p.speed_in, s.report.speed_in);
            store(&p.speed_out, s.report.speed_out);
            store(&p.contact_ms, s.report.contact_samples as f32 / sr * 1000.0);
            store(&p.peak_force, s.report.peak_force);
            store(&p.gap, if s.report.gap.is_finite() { s.report.gap } else { 1.0 });
            p.flying.store(s.report.flying, Ordering::Relaxed);
            store(&p.glide, s.glide_cents);
            p.wires_lifted.store(s.wires_lifted, Ordering::Relaxed);
            p.wire_landings.store(s.wire_landings, Ordering::Relaxed);
            p.nonlinear.store(s.nonlinear, Ordering::Relaxed);
            store(&p.mix, mix[piece.index()]);
            if !s.awake && s.level == 0.0 && scratch.published[piece.index()] {
                // Asleep and already drawn as it is: its modes have not moved.
                continue;
            }
            scratch.published[piece.index()] = !s.awake;
            kit.field(piece, &mut scratch.field);
            for (slot, v) in self.field[piece.index() * FIELD..(piece.index() + 1) * FIELD].iter().zip(scratch.field.iter()) {
                store(slot, *v);
            }
            let n = kit.modes(piece, &mut scratch.hz, &mut scratch.amp);
            let base = piece.index() * SPECTRUM;
            for k in 0..SPECTRUM {
                store(&self.spec_hz[base + k], if k < n { scratch.hz[k] } else { 0.0 });
                store(&self.spec_amp[base + k], if k < n { scratch.amp[k] } else { 0.0 });
            }
        }
        let focus = kit.focus();
        self.focus.store(focus.index() as u32, Ordering::Relaxed);
        self.workers.store(kit.workers() as u32, Ordering::Relaxed);
        self.set_spec(&kit.spec);
        // The force pulse: from the strike to a little past the end of the contact, peak-held into
        // the published points.
        let n = kit.trace(focus, &mut scratch.trace);
        let contact = kit.state(focus).report.contact_samples as usize;
        let span = ((contact as f32 * 1.6) as usize).clamp(64, TRACE_CAPTURE).min(n.max(1));
        for i in 0..TRACE_POINTS {
            let (a, b) = (i * span / TRACE_POINTS, ((i + 1) * span / TRACE_POINTS).max(i * span / TRACE_POINTS + 1));
            let v = scratch.trace[a.min(n)..b.min(n)].iter().fold(0.0f32, |m, v| m.max(*v));
            store(&self.trace[i], v);
        }
        store(&self.trace_ms, span as f32 / sr * 1000.0);
        self.trace_piece.store(focus.index() as u32, Ordering::Relaxed);
        self.version.fetch_add(1, Ordering::Release);
    }
}

/// Fixed-size buffers for publishing, so the audio thread never allocates.
struct Scratch {
    field: [f32; FIELD],
    hz: [f32; SPECTRUM],
    amp: [f32; SPECTRUM],
    trace: Vec<f32>,
    published: [bool; PIECES],
}

impl Scratch {
    fn new() -> Self {
        Self { field: [0.0; FIELD], hz: [0.0; SPECTRUM], amp: [0.0; SPECTRUM], trace: vec![0.0; TRACE_CAPTURE], published: [false; PIECES] }
    }
}

// ------------------------------------------------------------------------------------------
// The live kit
// ------------------------------------------------------------------------------------------

/// A command for a live kit.
#[derive(Clone, Copy, Debug)]
pub enum KitCommand {
    Strike(KitHit),
    /// Whether the pieces hear each other.
    Sympathetic(bool),
    /// Each piece's level in the kit's mix (1 as it radiates; the "mics").
    Mix([f32; PIECES]),
}

/// The caller's side of a live kit. Commands are queued under a mutex the audio thread only ever
/// `try_lock`s, so it never waits on the caller.
pub struct KitHandle {
    queue: Mutex<KitQueue>,
    spec: KitSpec,
}

struct KitQueue {
    commands: Vec<KitCommand>,
    alive: bool,
}

impl KitHandle {
    /// Queues a command, or hands it back if the kit has stopped.
    pub fn send(&self, cmd: KitCommand) -> Result<(), KitCommand> {
        let mut q = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        if !q.alive {
            return Err(cmd);
        }
        q.commands.push(cmd);
        Ok(())
    }

    pub fn is_alive(&self) -> bool {
        self.queue.lock().unwrap_or_else(|p| p.into_inner()).alive
    }

    /// The kit it plays.
    pub fn spec(&self) -> KitSpec {
        self.spec
    }

    /// Stops the kit (it lets its sound go at once).
    pub fn retire(&self) {
        self.queue.lock().unwrap_or_else(|p| p.into_inner()).alive = false;
    }
}

/// A kit on a track's bus, as a `rodio::Source` (interleaved stereo at the engine rate). Hits
/// arrive through its [`KitHandle`] and land at the start of the next block (under a millisecond).
/// It plays until retired: a kit whose pieces are all asleep costs next to nothing.
pub struct KitVoice {
    kit: Kit,
    shared: Arc<MatterShared>,
    handle: Arc<KitHandle>,
    pending: Vec<KitCommand>,
    mix: [f32; PIECES],
    publish_countdown: u32,
    scratch: Scratch,
    buf: [f32; 2],
    buf_idx: u8,
    done: bool,
}

impl KitVoice {
    /// Wraps a built kit (see `Kit::new`, off the audio thread).
    pub fn new(shared: Arc<MatterShared>, kit: Kit) -> (Self, Arc<KitHandle>) {
        shared.active.fetch_add(1, Ordering::Relaxed);
        let handle = Arc::new(KitHandle { queue: Mutex::new(KitQueue { commands: Vec::with_capacity(256), alive: true }), spec: kit.spec });
        let voice = Self { kit, shared, handle: handle.clone(), pending: Vec::with_capacity(256), mix: [1.0; PIECES], publish_countdown: 0, scratch: Scratch::new(), buf: [0.0; 2], buf_idx: 0, done: false };
        (voice, handle)
    }

    fn drain(&mut self) {
        // Swap the queue out without blocking and without allocating (both keep their capacity).
        if let Ok(mut q) = self.handle.queue.try_lock() {
            std::mem::swap(&mut q.commands, &mut self.pending);
            if !q.alive {
                self.done = true;
            }
        }
        for cmd in self.pending.drain(..) {
            match cmd {
                KitCommand::Strike(h) => self.kit.strike(h.piece, h.strike),
                KitCommand::Sympathetic(on) => self.kit.set_sympathetic(on),
                KitCommand::Mix(m) => {
                    self.mix = m;
                    self.kit.set_mix(m);
                }
            }
        }
    }

    fn next_frame(&mut self) -> Option<[f32; 2]> {
        if self.kit.at_block_start() {
            self.drain();
        }
        if self.done {
            return None;
        }
        let frame = self.kit.next_frame();
        if self.publish_countdown == 0 {
            self.shared.publish(&self.kit, &self.mix, &mut self.scratch);
            self.publish_countdown = PUBLISH_EVERY;
        }
        self.publish_countdown -= 1;
        Some(frame)
    }
}

impl Drop for KitVoice {
    fn drop(&mut self) {
        self.shared.active.fetch_sub(1, Ordering::Relaxed);
        self.handle.queue.lock().unwrap_or_else(|p| p.into_inner()).alive = false;
    }
}

impl Iterator for KitVoice {
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

impl Source for KitVoice {
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

// ------------------------------------------------------------------------------------------
// Offline
// ------------------------------------------------------------------------------------------

/// Renders a track's hits (seconds from the start) on one kit, the way the track plays them live:
/// sample-accurate, the pieces hearing each other. Returns interleaved stereo at the engine rate,
/// running until the kit has fallen silent (capped at `tail` seconds past the last hit).
pub fn render_performance(spec: KitSpec, mix: [f32; PIECES], hits: &[(f64, KitHit)], tail: f32) -> Vec<f32> {
    if hits.is_empty() {
        return Vec::new();
    }
    let sr = ENGINE_SAMPLE_RATE as f32;
    let mut order: Vec<(u64, KitHit)> = hits.iter().map(|(t, h)| ((t.max(0.0) * sr as f64).round() as u64, *h)).collect();
    order.sort_by_key(|h| h.0);
    let mut kit = Kit::new(spec, sr);
    kit.set_mix(mix);
    let last = order.last().map(|h| h.0).unwrap_or(0);
    let hard_end = last + (tail.max(0.0) * sr) as u64;
    let mut out = Vec::with_capacity((hard_end as usize).min(sr as usize * 600) * 2);
    let (mut next, mut t) = (0, 0u64);
    loop {
        // A block at a time: every hit landing in it is scheduled at its own sample.
        while next < order.len() && order[next].0 < t + BLOCK as u64 {
            let (at, h) = order[next];
            kit.schedule(h.piece, h.strike, at.saturating_sub(t) as usize);
            next += 1;
        }
        for _ in 0..BLOCK {
            let [l, r] = kit.next_frame();
            out.push(l);
            out.push(r);
        }
        t += BLOCK as u64;
        if next >= order.len() && (t >= hard_end || (t > last && kit.is_silent())) {
            break;
        }
    }
    out
}

/// Renders one hit on one piece alone, mono (for measuring it: no kit around it).
pub fn render_piece(spec: KitSpec, hit: KitHit, seconds: f32) -> Vec<f32> {
    let sr = ENGINE_SAMPLE_RATE as f32;
    let mut body = super::kit::Body::build(&spec.clamped(), hit.piece, sr);
    body.strike(hit.strike);
    (0..(seconds * sr) as usize).map(|_| body.next_sample()).collect()
}

/// A strike as the ops describe it.
pub fn strike(speed: f32, position: f32, angle: f32, striker: super::drum::StrikerSpec) -> Strike {
    Strike { velocity: speed.clamp(0.0, 25.0), position: position.clamp(0.0, 1.0), angle, striker }
}

// ------------------------------------------------------------------------------------------
// Registry: one MatterShared per kit id (a track), for the view to read
// ------------------------------------------------------------------------------------------

fn registry() -> &'static Mutex<HashMap<String, Arc<MatterShared>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<MatterShared>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn shared_for(id: &str) -> Arc<MatterShared> {
    registry().lock().unwrap_or_else(|p| p.into_inner()).entry(id.to_string()).or_insert_with(|| Arc::new(MatterShared::default())).clone()
}

pub fn get_shared(id: &str) -> Option<Arc<MatterShared>> {
    registry().lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned()
}

pub fn remove_shared(id: &str) -> bool {
    registry().lock().unwrap_or_else(|p| p.into_inner()).remove(id).is_some()
}
