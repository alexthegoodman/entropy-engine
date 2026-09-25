//! A physically modeled bowed-string instrument: strings as digital waveguides, a bow that grips
//! them through a real friction law, a bridge and a resonant body they all share, and a small
//! virtual player that turns notes into bow strokes and fingerings.
//!
//! The pieces, from the bottom up:
//!
//! * [`dsp`] - fractional delay lines, termination filters, the decimator.
//! * [`friction`] - the bow-string contact: rosin friction solved against the string's impedance
//!   with stick/slip hysteresis (McIntyre-Schumacher-Woodhouse). Helmholtz motion, Schelleng's
//!   playable window, surface sound and raucous crunch all come out of this, not out of tuning.
//! * [`string`] - one string: four delay lines (finger-bow and bow-bridge segments, both
//!   directions), losses, stiffness, and the displacement shape the visualization draws.
//! * [`body`] - coupled low body modes (the bridge's motion, fed back into every string - so open
//!   strings ring in sympathy, and wolf notes appear when coupling is pushed) plus a denser
//!   radiating mode field for the body's colour.
//! * [`engine`] - the whole instrument and its player: string choice, legato, double stops,
//!   vibrato, bow strokes, pizzicato, release.
//!
//! This module adds what the rest of the engine needs: [`PhysModShared`] (what the audio thread
//! publishes and the 3D widget reads, lock-free), [`PhysModVoice`] (one self-contained note as a
//! `rodio::Source`), [`PhysModInstrumentVoice`] (a long-lived instrument per track that notes are
//! sent to, so they share strings and a body), and offline rendering.

pub mod analysis;
pub mod body;
pub mod dsp;
pub mod engine;
pub mod friction;
pub mod string;

pub use engine::{
    body_scale, bow_newtons, bow_speed, schelleng_window, string_impedance, Articulation, Engine, PhysModLive, PhysModParams, StringReport, MAX_ALL_STRINGS, MAX_STRINGS,
    MAX_SYMPATHETIC, VIOLIN_TUNING,
};

use body::COUPLED_MODES;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rodio::Source;

use super::analysis::ENGINE_SAMPLE_RATE;

/// Lowest note the strings can hold at the engine rate (see `string::LINE_CAPACITY`).
pub const MIN_FREQ: f32 = 12.0;
/// How many points of each string's shape are published for the visualization.
pub const SHAPE_POINTS: usize = 64;
/// How often (in output samples) a voice publishes to `PhysModShared` (~86 times a second).
const PUBLISH_EVERY: u32 = 512;
/// A live instrument with nothing sounding shuts itself down after this long.
const INSTRUMENT_IDLE_SECS: f32 = 3.0;
/// A single-note voice never rings on for longer than this after its release.
const MAX_TAIL_SECS: f32 = 6.0;

// ------------------------------------------------------------------------------------------
// What the audio thread publishes
// ------------------------------------------------------------------------------------------

fn load(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}
fn store(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed)
}

/// One string's published state.
pub struct SharedString {
    open_freq: AtomicU32,
    freq: AtomicU32,
    beta: AtomicU32,
    level: AtomicU32,
    stick_fraction: AtomicU32,
    slips_per_period: AtomicU32,
    bow_force: AtomicU32,
    bow_velocity: AtomicU32,
    force_min: AtomicU32,
    force_max: AtomicU32,
    force_min_knob: AtomicU32,
    force_max_knob: AtomicU32,
    bow_force_knob: AtomicU32,
    /// bit 0 bowed (playable), bit 1 sympathetic, bit 2 a note is on it.
    flags: AtomicU32,
    shape: [AtomicU32; SHAPE_POINTS],
}

impl Default for SharedString {
    fn default() -> Self {
        Self {
            open_freq: AtomicU32::new(0),
            freq: AtomicU32::new(0),
            beta: AtomicU32::new(0),
            level: AtomicU32::new(0),
            stick_fraction: AtomicU32::new(0),
            slips_per_period: AtomicU32::new(0),
            bow_force: AtomicU32::new(0),
            bow_velocity: AtomicU32::new(0),
            force_min: AtomicU32::new(0),
            force_max: AtomicU32::new(0),
            force_min_knob: AtomicU32::new(0),
            force_max_knob: AtomicU32::new(0),
            bow_force_knob: AtomicU32::new(0),
            flags: AtomicU32::new(0),
            shape: std::array::from_fn(|_| AtomicU32::new(0)),
        }
    }
}

/// A snapshot of one string, read by the widget.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StringInfo {
    pub open_freq: f32,
    /// The pitch the finger stops, Hz.
    pub freq: f32,
    /// Where the finger is, as a fraction of the open string's length from the nut (0 = open).
    pub finger: f32,
    /// Bow contact as a fraction of the vibrating length from the bridge.
    pub beta: f32,
    pub level: f32,
    pub stick_fraction: f32,
    pub slips_per_period: f32,
    /// Bow force (N) and speed (m/s) actually applied.
    pub bow_force: f32,
    pub bow_velocity: f32,
    /// The Schelleng window for the current bow speed and position, N.
    pub force_min: f32,
    pub force_max: f32,
    /// The window and the bow force in the 0..1 units of the force control.
    pub force_min_knob: f32,
    pub force_max_knob: f32,
    pub bow_force_knob: f32,
    pub bowed: bool,
    pub sympathetic: bool,
    pub playing: bool,
}

/// What kind of motion a bowed string is in, read off its stick/slip statistics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BowRegime {
    /// The bow is off the string.
    Free,
    /// One clean stick-slip per period: the normal bowed tone.
    Helmholtz,
    /// More than one slip per period: too little force for the bow position (airy, whistly).
    SurfaceSound,
    /// Irregular or overlong sticking: too much force (crunchy, raucous).
    Raucous,
}

impl StringInfo {
    /// The regime, from the stick/slip statistics: one release per period is Helmholtz motion;
    /// anything else is surface sound if the bow force sits in the lower half of the (estimated)
    /// playable window or below it, and raucous if in the upper half or above.
    pub fn regime(&self) -> BowRegime {
        if self.bow_force <= 1.0e-4 {
            BowRegime::Free
        } else if (self.slips_per_period - 1.0).abs() <= 0.12 {
            BowRegime::Helmholtz
        } else if self.force_min > 0.0 && self.force_max > 0.0 {
            if self.bow_force < (self.force_min * self.force_max).sqrt() { BowRegime::SurfaceSound } else { BowRegime::Raucous }
        } else if self.slips_per_period > 1.0 {
            BowRegime::SurfaceSound
        } else {
            BowRegime::Raucous
        }
    }
}

pub struct PhysModShared {
    active: AtomicU32,
    energy: AtomicU32,
    bow_position: AtomicU32,
    bow_force: AtomicU32,
    bow_velocity: AtomicU32,
    /// The most recently played string's shape (kept for callers that only want one string).
    shape: [AtomicU32; SHAPE_POINTS],
    shape_version: AtomicU64,
    strings: [SharedString; MAX_ALL_STRINGS],
    string_count: AtomicUsize,
    active_string: AtomicUsize,
    mode_freq: [AtomicU32; COUPLED_MODES],
    mode_level: [AtomicU32; COUPLED_MODES],
    bridge_force: AtomicU32,
}

impl Default for PhysModShared {
    fn default() -> Self {
        Self {
            active: AtomicU32::new(0),
            energy: AtomicU32::new(0),
            bow_position: AtomicU32::new(0.12f32.to_bits()),
            bow_force: AtomicU32::new(0.5f32.to_bits()),
            bow_velocity: AtomicU32::new(0.5f32.to_bits()),
            shape: std::array::from_fn(|_| AtomicU32::new(0)),
            shape_version: AtomicU64::new(0),
            strings: std::array::from_fn(|_| SharedString::default()),
            string_count: AtomicUsize::new(0),
            active_string: AtomicUsize::new(usize::MAX),
            mode_freq: std::array::from_fn(|_| AtomicU32::new(0)),
            mode_level: std::array::from_fn(|_| AtomicU32::new(0)),
            bridge_force: AtomicU32::new(0),
        }
    }
}

impl PhysModShared {
    pub fn active_voices(&self) -> u32 {
        self.active.load(Ordering::Relaxed)
    }

    /// `None` when nothing is sounding. Otherwise the current bow controls (position, force and
    /// velocity as the 0..1 / fraction values a note was played with) and the output energy.
    pub fn activity(&self) -> Option<(f32, f32, f32, f32)> {
        if self.active.load(Ordering::Relaxed) == 0 {
            return None;
        }
        Some((load(&self.bow_position), load(&self.bow_force), load(&self.bow_velocity), load(&self.energy)))
    }

    pub fn shape_version(&self) -> u64 {
        self.shape_version.load(Ordering::Acquire)
    }

    /// The most recently played string's shape.
    pub fn shape_at(&self, i: usize) -> f32 {
        load(&self.shape[i.min(SHAPE_POINTS - 1)])
    }

    /// How many strings (bowed + sympathetic) the instrument has published.
    pub fn string_count(&self) -> usize {
        self.string_count.load(Ordering::Relaxed).min(MAX_ALL_STRINGS)
    }

    /// The string the most recent note went to.
    pub fn active_string(&self) -> Option<usize> {
        let i = self.active_string.load(Ordering::Relaxed);
        (i < MAX_ALL_STRINGS).then_some(i)
    }

    pub fn string_info(&self, i: usize) -> StringInfo {
        let s = &self.strings[i.min(MAX_ALL_STRINGS - 1)];
        let flags = s.flags.load(Ordering::Relaxed);
        let open = load(&s.open_freq);
        let freq = load(&s.freq);
        StringInfo {
            open_freq: open,
            freq,
            finger: if freq > open * 1.0005 && freq > 0.0 { 1.0 - open / freq } else { 0.0 },
            beta: load(&s.beta),
            level: load(&s.level),
            stick_fraction: load(&s.stick_fraction),
            slips_per_period: load(&s.slips_per_period),
            bow_force: load(&s.bow_force),
            bow_velocity: load(&s.bow_velocity),
            force_min: load(&s.force_min),
            force_max: load(&s.force_max),
            force_min_knob: load(&s.force_min_knob),
            force_max_knob: load(&s.force_max_knob),
            bow_force_knob: load(&s.bow_force_knob),
            bowed: flags & 1 != 0,
            sympathetic: flags & 2 != 0,
            playing: flags & 4 != 0,
        }
    }

    /// String `i`'s displacement at point `k` of `SHAPE_POINTS`, finger (0) to bridge.
    pub fn string_shape_at(&self, i: usize, k: usize) -> f32 {
        load(&self.strings[i.min(MAX_ALL_STRINGS - 1)].shape[k.min(SHAPE_POINTS - 1)])
    }

    /// Body mode `i`: its frequency (Hz) and how hard it is ringing (bridge velocity share, m/s).
    pub fn body_mode(&self, i: usize) -> (f32, f32) {
        let i = i.min(COUPLED_MODES - 1);
        (load(&self.mode_freq[i]), load(&self.mode_level[i]))
    }

    pub fn body_mode_count(&self) -> usize {
        COUPLED_MODES
    }

    /// Recent bridge force magnitude, N.
    pub fn bridge_force(&self) -> f32 {
        load(&self.bridge_force)
    }

    fn publish(&self, engine: &mut Engine, controls: (f32, f32, f32), active_string: Option<usize>, energy: f32, scratch: &mut Scratch) {
        let n = engine.report(&mut scratch.reports);
        for i in 0..n {
            let r = &scratch.reports[i];
            let s = &self.strings[i];
            store(&s.open_freq, r.open_freq);
            store(&s.freq, r.freq);
            store(&s.beta, r.beta);
            store(&s.level, r.level);
            store(&s.stick_fraction, r.stick_fraction);
            store(&s.slips_per_period, r.slips_per_period);
            store(&s.bow_force, r.bow_force);
            store(&s.bow_velocity, r.bow_velocity);
            store(&s.force_min, r.force_min);
            store(&s.force_max, r.force_max);
            store(&s.force_min_knob, r.force_min_knob);
            store(&s.force_max_knob, r.force_max_knob);
            store(&s.bow_force_knob, r.bow_force_knob);
            let flags = (r.bowed as u32) | ((r.sympathetic as u32) << 1) | ((r.phase_active as u32) << 2);
            s.flags.store(flags, Ordering::Relaxed);
            engine.string_shape(i, &mut scratch.shape);
            for (slot, v) in s.shape.iter().zip(scratch.shape.iter()) {
                store(slot, *v);
            }
            if Some(i) == active_string {
                for (slot, v) in self.shape.iter().zip(scratch.shape.iter()) {
                    store(slot, *v);
                }
            }
        }
        self.string_count.store(n, Ordering::Relaxed);
        if let Some(a) = active_string {
            self.active_string.store(a, Ordering::Relaxed);
        }
        let (freqs, levels) = engine.body_modes();
        for i in 0..COUPLED_MODES {
            store(&self.mode_freq[i], freqs[i]);
            store(&self.mode_level[i], levels[i]);
        }
        store(&self.bridge_force, engine.last_bridge_force.abs());
        store(&self.bow_position, controls.0);
        store(&self.bow_force, controls.1);
        store(&self.bow_velocity, controls.2);
        store(&self.energy, energy);
        self.shape_version.fetch_add(1, Ordering::Release);
    }
}

/// Fixed-size buffers for publishing, so the audio thread never allocates.
struct Scratch {
    reports: [StringReport; MAX_ALL_STRINGS],
    shape: [f32; SHAPE_POINTS],
}

impl Default for Scratch {
    fn default() -> Self {
        Self { reports: [StringReport::default(); MAX_ALL_STRINGS], shape: [0.0; SHAPE_POINTS] }
    }
}

// ------------------------------------------------------------------------------------------
// A single self-contained note
// ------------------------------------------------------------------------------------------

/// One note on its own instrument (strings, body and all), as a `rodio::Source`. This is the
/// simple path: a note that shares nothing with any other. Notes that should share strings and a
/// body - so they slur, double-stop and ring in each other's sympathy - go through
/// [`PhysModInstrumentVoice`].
pub struct PhysModVoice {
    engine: Engine,
    shared: Arc<PhysModShared>,
    p: PhysModParams,
    gate: Option<Arc<AtomicBool>>,
    live: Option<Arc<PhysModLive>>,
    string: usize,
    released: bool,
    tail: u32,
    done: bool,
    publish_countdown: u32,
    scratch: Scratch,
    buf: [f32; 2],
    buf_idx: u8,
    started: bool,
}

impl PhysModVoice {
    pub fn new(shared: Arc<PhysModShared>, params: PhysModParams, gate: Option<Arc<AtomicBool>>) -> Self {
        shared.active.fetch_add(1, Ordering::Relaxed);
        let engine = Engine::new(ENGINE_SAMPLE_RATE as f32, &params);
        Self { engine, shared, p: params, gate, live: None, string: 0, released: false, tail: 0, done: false, publish_countdown: 0, scratch: Scratch::default(), buf: [0.0; 2], buf_idx: 0, started: false }
    }

    /// Lets bow force, speed, position and vibrato depth be moved while the note sounds.
    pub fn with_live_bow(mut self, live: Arc<PhysModLive>) -> Self {
        self.live = Some(live);
        self
    }

    fn next_frame(&mut self) -> Option<[f32; 2]> {
        if self.done {
            return None;
        }
        if !self.started {
            self.started = true;
            self.string = self.engine.note_on(1, self.p, self.gate.is_some(), self.live.clone());
        }
        if let Some(g) = &self.gate {
            if !self.released && !g.load(Ordering::Relaxed) {
                self.released = true;
                self.engine.note_off(1);
            }
        } else if !self.released && !self.engine.is_playing() {
            self.released = true;
        }
        let frame = self.engine.next_frame();
        if self.released || !self.engine.is_playing() {
            self.tail += 1;
            let silent = !self.engine.is_playing() && self.engine.is_silent();
            if silent || self.tail as f32 > MAX_TAIL_SECS * ENGINE_SAMPLE_RATE as f32 {
                self.done = true;
            }
        }
        if self.publish_countdown == 0 {
            let controls = match &self.live {
                Some(l) => (load(&l.bow_position), load(&l.bow_force), load(&l.bow_velocity)),
                None => (self.p.bow_position, self.p.bow_force, self.p.bow_velocity),
            };
            let energy = frame[0].abs().max(frame[1].abs());
            self.shared.publish(&mut self.engine, controls, Some(self.string), energy, &mut self.scratch);
            self.publish_countdown = PUBLISH_EVERY;
        }
        self.publish_countdown -= 1;
        Some(frame)
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

/// Renders one note to interleaved stereo samples, entirely offline. The render stops at `seconds`
/// or when the note has finished and rung down, whichever is first.
pub fn render_note(shared: Arc<PhysModShared>, params: PhysModParams, seconds: f32) -> Vec<f32> {
    let limit = (seconds.max(0.0) * ENGINE_SAMPLE_RATE as f32) as usize * 2;
    PhysModVoice::new(shared, params, None).take(limit).collect()
}

// ------------------------------------------------------------------------------------------
// A long-lived instrument that notes are sent to
// ------------------------------------------------------------------------------------------

/// A command for a live instrument.
pub enum InstrumentCommand {
    NoteOn { id: u64, params: PhysModParams, gated: bool, live: Option<Arc<PhysModLive>> },
    NoteOff { id: u64 },
    AllNotesOff,
}

/// The caller's side of a live instrument: where commands are queued, and whether the audio side
/// is still running. Commands are queued under a mutex the audio thread only ever `try_lock`s, so
/// it never blocks on the caller.
pub struct InstrumentHandle {
    queue: Mutex<InstrumentQueue>,
    /// The string tuning the running engine was built for.
    tuning: Mutex<([f32; MAX_STRINGS], [f32; MAX_SYMPATHETIC])>,
}

struct InstrumentQueue {
    commands: Vec<InstrumentCommand>,
    /// False once the audio side has shut down; a new voice must be started for further notes.
    alive: bool,
}

impl InstrumentHandle {
    /// Queues a command, or hands it back if the audio side has stopped (so the caller can start a
    /// fresh voice with it).
    pub fn send(&self, cmd: InstrumentCommand) -> Result<(), InstrumentCommand> {
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

    /// Whether the running engine was built for the same strings as `p` wants.
    pub fn same_tuning(&self, p: &PhysModParams) -> bool {
        let t = self.tuning.lock().unwrap_or_else(|p| p.into_inner());
        t.0 == p.open_strings().0 && t.1 == p.sympathetic
    }

    /// Asks the running voice to let everything ring out and stop.
    pub fn retire(&self) {
        let _ = self.send(InstrumentCommand::AllNotesOff);
        let mut q = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        q.alive = false;
    }
}

/// An instrument as a `rodio::Source` that stays on a track's bus while it is used: notes arrive
/// through its [`InstrumentHandle`] and share its strings and body. It stops itself (and marks the
/// handle dead) after [`INSTRUMENT_IDLE_SECS`] of silence, or once retired and silent.
pub struct PhysModInstrumentVoice {
    engine: Engine,
    shared: Arc<PhysModShared>,
    handle: Arc<InstrumentHandle>,
    pending: Vec<InstrumentCommand>,
    idle: u32,
    active_string: Option<usize>,
    controls: (f32, f32, f32),
    live: Option<Arc<PhysModLive>>,
    publish_countdown: u32,
    scratch: Scratch,
    buf: [f32; 2],
    buf_idx: u8,
    retiring: bool,
    done: bool,
}

impl PhysModInstrumentVoice {
    /// A new instrument built for `p`'s strings and body, plus the handle to play it with.
    pub fn new(shared: Arc<PhysModShared>, p: &PhysModParams) -> (Self, Arc<InstrumentHandle>) {
        shared.active.fetch_add(1, Ordering::Relaxed);
        let handle = Arc::new(InstrumentHandle {
            queue: Mutex::new(InstrumentQueue { commands: Vec::with_capacity(64), alive: true }),
            tuning: Mutex::new((p.open_strings().0, p.sympathetic)),
        });
        let voice = Self {
            engine: Engine::new(ENGINE_SAMPLE_RATE as f32, p),
            shared,
            handle: handle.clone(),
            pending: Vec::with_capacity(64),
            idle: 0,
            active_string: None,
            controls: (p.bow_position, p.bow_force, p.bow_velocity),
            live: None,
            publish_countdown: 0,
            scratch: Scratch::default(),
            buf: [0.0; 2],
            buf_idx: 0,
            retiring: false,
            done: false,
        };
        (voice, handle)
    }

    fn drain(&mut self) {
        // Swap the queue out without blocking and without allocating (both vecs keep capacity).
        if let Ok(mut q) = self.handle.queue.try_lock() {
            std::mem::swap(&mut q.commands, &mut self.pending);
            if !q.alive {
                self.retiring = true;
            }
        }
        for cmd in self.pending.drain(..) {
            match cmd {
                InstrumentCommand::NoteOn { id, params, gated, live } => {
                    self.controls = (params.bow_position, params.bow_force, params.bow_velocity);
                    self.live = live.clone();
                    self.active_string = Some(self.engine.note_on(id, params, gated, live));
                    self.idle = 0;
                }
                InstrumentCommand::NoteOff { id } => self.engine.note_off(id),
                InstrumentCommand::AllNotesOff => self.engine.all_notes_off(),
            }
        }
    }

    fn next_frame(&mut self) -> Option<[f32; 2]> {
        if self.done {
            return None;
        }
        if self.publish_countdown % 64 == 0 {
            self.drain();
        }
        let frame = self.engine.next_frame();
        if self.engine.is_playing() || !self.engine.is_silent() {
            self.idle = 0;
        } else {
            self.idle += 1;
        }
        let idle_limit = if self.retiring { 1 } else { (INSTRUMENT_IDLE_SECS * ENGINE_SAMPLE_RATE as f32) as u32 };
        if self.idle >= idle_limit {
            // Shut down only if nothing arrived in the meantime; marking the handle dead under the
            // same lock the caller queues under means no note can slip in and be lost.
            let mut q = self.handle.queue.lock().unwrap_or_else(|p| p.into_inner());
            if q.commands.is_empty() || self.retiring {
                q.alive = false;
                self.done = true;
                return None;
            }
        }
        if self.publish_countdown == 0 {
            let controls = match &self.live {
                Some(l) => (load(&l.bow_position), load(&l.bow_force), load(&l.bow_velocity)),
                None => self.controls,
            };
            let energy = frame[0].abs().max(frame[1].abs());
            self.shared.publish(&mut self.engine, controls, self.active_string, energy, &mut self.scratch);
            self.publish_countdown = PUBLISH_EVERY;
        }
        self.publish_countdown -= 1;
        Some(frame)
    }
}

impl Drop for PhysModInstrumentVoice {
    fn drop(&mut self) {
        self.shared.active.fetch_sub(1, Ordering::Relaxed);
        let mut q = self.handle.queue.lock().unwrap_or_else(|p| p.into_inner());
        q.alive = false;
    }
}

impl Iterator for PhysModInstrumentVoice {
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

impl Source for PhysModInstrumentVoice {
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
// Offline performance rendering
// ------------------------------------------------------------------------------------------

/// One note of a performance: when it starts (seconds) and what it is played with. It is held for
/// `params.duration` seconds.
#[derive(Clone, Copy, Debug)]
pub struct PerformedNote {
    pub start: f64,
    pub params: PhysModParams,
}

/// Renders a sequence of notes through ONE instrument, the way they would be played on it: notes
/// that overlap on a string slur, notes on different strings double-stop, and everything shares a
/// body and rings in sympathy. Sample-accurate note timing. Returns interleaved stereo at the engine
/// rate, running until the last note has rung down (capped at `tail` seconds past its release).
pub fn render_performance(notes: &[PerformedNote], tail: f32) -> Vec<f32> {
    if notes.is_empty() {
        return Vec::new();
    }
    let sr = ENGINE_SAMPLE_RATE as f32;
    let mut order: Vec<usize> = (0..notes.len()).collect();
    order.sort_by(|&a, &b| notes[a].start.total_cmp(&notes[b].start));
    // (sample, is_on, note index)
    let mut events: Vec<(u64, bool, usize)> = Vec::with_capacity(notes.len() * 2);
    for &i in &order {
        let n = &notes[i];
        let on = (n.start.max(0.0) * sr as f64).round() as u64;
        let off = on + (n.params.duration.max(0.0) * sr) as u64;
        events.push((on, true, i));
        events.push((off, false, i));
    }
    // Offs before ons at the same sample, so a repeated note re-strikes rather than being cut.
    events.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let first = &notes[order[0]].params;
    let mut engine = Engine::new(sr, first);
    let last_off = events.iter().map(|e| e.0).max().unwrap_or(0);
    let hard_end = last_off + (tail.max(0.0) * sr) as u64;
    let mut out = Vec::with_capacity((hard_end as usize).min(sr as usize * 600) * 2);
    let mut next = 0;
    let mut t = 0u64;
    loop {
        while next < events.len() && events[next].0 <= t {
            let (_, on, i) = events[next];
            let id = i as u64 + 1;
            if on {
                engine.note_on(id, notes[i].params, true, None);
            } else {
                engine.note_off(id);
            }
            next += 1;
        }
        let [l, r] = engine.next_frame();
        out.push(l);
        out.push(r);
        t += 1;
        if next >= events.len() && (engine.is_silent() || t >= hard_end) {
            break;
        }
    }
    out
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

#[cfg(test)]
mod tests;
