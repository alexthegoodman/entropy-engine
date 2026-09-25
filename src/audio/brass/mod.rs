//! A physically modeled brass instrument: a player's lips, blown open by the breath, driving an air
//! column built from the instrument's real bore profile, radiating through its bell. See
//! `docs/PHYS_MOD_BRASS.md` for the plan this follows.
//!
//! The pieces, from the bottom up:
//!
//! * [`bore`] - the air column's shape: mouthpiece, leadpipe, cylinder (slide), bell. One
//!   description drives the acoustics and (later) the drawn instrument.
//! * [`impedance`] - the reference acoustics: the bore's input impedance by the transfer-matrix
//!   method, with wall losses and the mouth's radiation load. Where the resonances are, and how well
//!   they line up. Build time only.
//! * [`airbore`] - the same bore at audio rate: scattering cells for the mouthpiece and bell,
//!   fractional delay lines for the slide, lumped wall losses, the radiation load, and
//!   pressure-dependent propagation in the cylinder - the steepening wavefront that makes loud brass
//!   *brassy*.
//! * [`lips`] - the outward-striking lip valve and its Bernoulli flow, solved against the mouthpiece
//!   each sample.
//! * [`engine`] - the instrument and its player: partial and slide choice, lip setting, breath,
//!   tonguing, slurs, slide vibrato, intonation by ear, attack skill (and cracked notes).
//!
//! This module adds what the rest of the engine needs, the same way `physmod` does for the strings:
//! [`BrassShared`] (what the audio thread publishes and the 3D widget reads, lock-free),
//! [`BrassVoice`] (one self-contained note as a `rodio::Source`), [`BrassInstrumentVoice`] (a
//! long-lived player per track that notes are sent to, so they slur into each other), offline
//! performance rendering, and a registry of shared states by instrument id.
//!
//! As with the strings, nothing here was tuned by listening: every behaviour is measured from
//! rendered audio in [`tests`](self), and the laws the player uses (`engine::lip_center`,
//! `engine::lip_mass`) were fitted from sweeps of the model itself.

pub mod airbore;
pub mod analysis;
pub mod bore;
pub mod engine;
pub mod impedance;
pub mod lips;

#[cfg(test)]
mod tests;

pub use engine::{breath_pressure, lip_center, lip_mass, Articulation, BrassInstrument, BrassLive, BrassParams, BrassReport, Engine, Fingering, ResonanceTable};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rodio::Source;

use super::analysis::ENGINE_SAMPLE_RATE;

/// Renders one note offline at `sr` Hz for `seconds` (held for the note's `duration`, then
/// released), mono. Also returns a report of the note taken just before its release.
pub fn render_note(p: &BrassParams, sr: f32, seconds: f32) -> (Vec<f32>, BrassReport) {
    let mut engine = Engine::new(sr, p);
    engine.note_on(1, *p, false, None);
    let n = (seconds * sr) as usize;
    let report_at = ((p.duration * sr) as usize).saturating_sub(64).min(n.saturating_sub(1));
    let mut report = BrassReport::default();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        out.push(engine.next_frame()[0]);
        if i == report_at {
            report = engine.report();
        }
    }
    (out, report)
}

/// A sequence of notes played by one player (so they can slur), for offline rendering.
#[derive(Clone, Copy, Debug)]
pub struct PerformedNote {
    /// Seconds from the start.
    pub start: f32,
    pub params: BrassParams,
}

/// Renders a phrase through one instrument, mono. Notes that overlap the previous one are slurred
/// into (or re-tongued, for `Articulation::Tongued`).
pub fn render_phrase(notes: &[PerformedNote], sr: f32, tail: f32) -> Vec<f32> {
    let Some(first) = notes.first() else { return Vec::new() };
    let mut engine = Engine::new(sr, &first.params);
    let end = notes.iter().map(|n| n.start + n.params.duration).fold(0.0f32, f32::max) + tail;
    let n = (end * sr) as usize;
    let mut out = Vec::with_capacity(n);
    let mut next = 0;
    let mut offs: Vec<(usize, u64)> = notes.iter().enumerate().map(|(i, n)| (((n.start + n.params.duration) * sr) as usize, i as u64 + 1)).collect();
    offs.sort_by_key(|o| o.0);
    let mut next_off = 0;
    for i in 0..n {
        while next < notes.len() && (notes[next].start * sr) as usize <= i {
            engine.note_on(next as u64 + 1, notes[next].params, true, None);
            next += 1;
        }
        while next_off < offs.len() && offs[next_off].0 <= i {
            engine.note_off(offs[next_off].1);
            next_off += 1;
        }
        out.push(engine.next_frame()[0]);
    }
    out
}

// ------------------------------------------------------------------------------------------
// What the audio thread publishes
// ------------------------------------------------------------------------------------------

/// Points of the bore's pressure profile published for the view.
pub const BORE_POINTS: usize = 96;
/// Points of one period of mouthpiece pressure / lip opening published for the view.
pub const TRACE_POINTS: usize = 64;
/// Resonances published (partial 1 upward).
pub const LADDER_POINTS: usize = ResonanceTable::PARTIALS;
/// How often (in output samples) a voice publishes (~86 times a second).
const PUBLISH_EVERY: u32 = 512;
/// A live instrument with nothing sounding shuts itself down after this long.
const INSTRUMENT_IDLE_SECS: f32 = 3.0;
/// A single-note voice never rings on for longer than this after its release.
const MAX_TAIL_SECS: f32 = 3.0;

fn load(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}
fn store(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed)
}
fn atomics<const N: usize>() -> [AtomicU32; N] {
    std::array::from_fn(|_| AtomicU32::new(0))
}

/// A snapshot of the player and instrument, read by the widget and the ops.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BrassState {
    pub instrument: u32,
    pub playing: bool,
    pub partial: usize,
    /// Slide extension beyond first position (metres, and as a position number 1..7).
    pub extension: f32,
    pub position: f32,
    pub slide_max: f32,
    /// The player's tuning-slide pull, metres (the bore is that much longer than the stock profile).
    pub tuning: f32,
    pub mouth_pressure: f32,
    pub breath: f32,
    pub lip_tension: f32,
    pub lip_freq: f32,
    pub lip_opening: f32,
    pub target: f32,
    pub resonance: f32,
    pub sounding: f32,
    pub wave_steepness: f32,
    pub mouthpiece_level: f32,
    pub energy: f32,
}

pub struct BrassShared {
    active: AtomicU32,
    version: AtomicU64,
    instrument: AtomicU32,
    playing: AtomicBool,
    partial: AtomicU32,
    extension: AtomicU32,
    position: AtomicU32,
    slide_max: AtomicU32,
    tuning: AtomicU32,
    mouth_pressure: AtomicU32,
    breath: AtomicU32,
    lip_tension: AtomicU32,
    lip_freq: AtomicU32,
    lip_opening: AtomicU32,
    target: AtomicU32,
    resonance: AtomicU32,
    sounding: AtomicU32,
    steepness: AtomicU32,
    mp_level: AtomicU32,
    energy: AtomicU32,
    bore: [AtomicU32; BORE_POINTS],
    mp_trace: [AtomicU32; TRACE_POINTS],
    lip_trace: [AtomicU32; TRACE_POINTS],
    ladder_hz: [AtomicU32; LADDER_POINTS],
    ladder_mag: [AtomicU32; LADDER_POINTS],
}

impl Default for BrassShared {
    fn default() -> Self {
        Self {
            active: AtomicU32::new(0),
            version: AtomicU64::new(0),
            instrument: AtomicU32::new(0),
            playing: AtomicBool::new(false),
            partial: AtomicU32::new(0),
            extension: AtomicU32::new(0),
            position: AtomicU32::new(1f32.to_bits()),
            slide_max: AtomicU32::new(BrassInstrument::TenorTrombone.profile().slide_max.to_bits()),
            tuning: AtomicU32::new(0),
            mouth_pressure: AtomicU32::new(0),
            breath: AtomicU32::new(0.5f32.to_bits()),
            lip_tension: AtomicU32::new(0),
            lip_freq: AtomicU32::new(0),
            lip_opening: AtomicU32::new(0),
            target: AtomicU32::new(0),
            resonance: AtomicU32::new(0),
            sounding: AtomicU32::new(0),
            steepness: AtomicU32::new(0),
            mp_level: AtomicU32::new(0),
            energy: AtomicU32::new(0),
            bore: atomics(),
            mp_trace: atomics(),
            lip_trace: atomics(),
            ladder_hz: atomics(),
            ladder_mag: atomics(),
        }
    }
}

/// Fixed-size buffers for publishing, so the audio thread never allocates.
struct Scratch {
    bore: [f32; BORE_POINTS],
    mp: [f32; TRACE_POINTS],
    lip: [f32; TRACE_POINTS],
    hz: [f32; LADDER_POINTS],
    mag: [f32; LADDER_POINTS],
}

impl Default for Scratch {
    fn default() -> Self {
        Self { bore: [0.0; BORE_POINTS], mp: [0.0; TRACE_POINTS], lip: [0.0; TRACE_POINTS], hz: [0.0; LADDER_POINTS], mag: [0.0; LADDER_POINTS] }
    }
}

impl BrassShared {
    /// Voices currently publishing here.
    pub fn active_voices(&self) -> u32 {
        self.active.load(Ordering::Relaxed)
    }

    /// Bumped on every publish.
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    pub fn state(&self) -> BrassState {
        BrassState {
            instrument: self.instrument.load(Ordering::Relaxed),
            playing: self.playing.load(Ordering::Relaxed),
            partial: self.partial.load(Ordering::Relaxed) as usize,
            extension: load(&self.extension),
            position: load(&self.position),
            slide_max: load(&self.slide_max),
            tuning: load(&self.tuning),
            mouth_pressure: load(&self.mouth_pressure),
            breath: load(&self.breath),
            lip_tension: load(&self.lip_tension),
            lip_freq: load(&self.lip_freq),
            lip_opening: load(&self.lip_opening),
            target: load(&self.target),
            resonance: load(&self.resonance),
            sounding: load(&self.sounding),
            wave_steepness: load(&self.steepness),
            mouthpiece_level: load(&self.mp_level),
            energy: load(&self.energy),
        }
    }

    /// The instrument published, as the engine knows it.
    pub fn instrument(&self) -> BrassInstrument {
        BrassInstrument::from_index(self.instrument.load(Ordering::Relaxed))
    }

    /// Pressure (Pa) at point `i` of `BORE_POINTS` from the lips to the bell.
    pub fn bore_pressure(&self, i: usize) -> f32 {
        load(&self.bore[i.min(BORE_POINTS - 1)])
    }

    /// Mouthpiece pressure (Pa, AC) and lip opening (m) at point `i` of one period.
    pub fn trace(&self, i: usize) -> (f32, f32) {
        let i = i.min(TRACE_POINTS - 1);
        (load(&self.mp_trace[i]), load(&self.lip_trace[i]))
    }

    /// Resonance `n` (1-based) of the air column where the slide is now: (Hz, |Z|).
    pub fn resonance(&self, n: usize) -> (f32, f32) {
        let i = n.clamp(1, LADDER_POINTS) - 1;
        (load(&self.ladder_hz[i]), load(&self.ladder_mag[i]))
    }

    fn publish(&self, engine: &mut Engine, energy: f32, scratch: &mut Scratch) {
        let r = engine.report();
        self.instrument.store(engine.instrument().index(), Ordering::Relaxed);
        self.playing.store(r.playing, Ordering::Relaxed);
        self.partial.store(r.partial as u32, Ordering::Relaxed);
        store(&self.extension, r.extension);
        store(&self.position, r.position);
        store(&self.slide_max, engine.bore().profile().slide_max);
        store(&self.tuning, engine.tuning_slide());
        store(&self.mouth_pressure, r.mouth_pressure);
        store(&self.breath, r.breath);
        store(&self.lip_tension, r.lip_tension);
        store(&self.lip_freq, r.lip_freq);
        store(&self.lip_opening, r.lip_opening);
        store(&self.target, r.target);
        store(&self.resonance, r.resonance);
        store(&self.sounding, r.sounding);
        store(&self.steepness, r.wave_steepness);
        store(&self.mp_level, r.mouthpiece_level);
        store(&self.energy, energy);
        engine.bore_pressure(&mut scratch.bore);
        for (slot, v) in self.bore.iter().zip(scratch.bore.iter()) {
            store(slot, *v);
        }
        if engine.traces(&mut scratch.mp, &mut scratch.lip) {
            for (slot, v) in self.mp_trace.iter().zip(scratch.mp.iter()) {
                store(slot, *v);
            }
            for (slot, v) in self.lip_trace.iter().zip(scratch.lip.iter()) {
                store(slot, *v);
            }
        }
        let n = engine.ladder(&mut scratch.hz, &mut scratch.mag);
        for i in 0..n {
            store(&self.ladder_hz[i], scratch.hz[i]);
            store(&self.ladder_mag[i], scratch.mag[i]);
        }
        self.version.fetch_add(1, Ordering::Release);
    }
}

// ------------------------------------------------------------------------------------------
// A single self-contained note
// ------------------------------------------------------------------------------------------

/// One note on its own instrument, as a `rodio::Source` (interleaved stereo at the engine rate).
/// Notes that should slur into each other go through [`BrassInstrumentVoice`].
pub struct BrassVoice {
    engine: Engine,
    shared: Arc<BrassShared>,
    p: BrassParams,
    gate: Option<Arc<AtomicBool>>,
    live: Option<Arc<BrassLive>>,
    started: bool,
    released: bool,
    tail: u32,
    done: bool,
    publish_countdown: u32,
    scratch: Scratch,
    buf: [f32; 2],
    buf_idx: u8,
}

impl BrassVoice {
    pub fn new(shared: Arc<BrassShared>, params: BrassParams, gate: Option<Arc<AtomicBool>>) -> Self {
        shared.active.fetch_add(1, Ordering::Relaxed);
        let engine = Engine::new(ENGINE_SAMPLE_RATE as f32, &params);
        Self { engine, shared, p: params, gate, live: None, started: false, released: false, tail: 0, done: false, publish_countdown: 0, scratch: Scratch::default(), buf: [0.0; 2], buf_idx: 0 }
    }

    /// Lets breath, lip tension, vibrato depth and bend be moved while the note sounds.
    pub fn with_live(mut self, live: Arc<BrassLive>) -> Self {
        self.live = Some(live);
        self
    }

    fn next_frame(&mut self) -> Option<[f32; 2]> {
        if self.done {
            return None;
        }
        if !self.started {
            self.started = true;
            self.engine.note_on(1, self.p, self.gate.is_some(), self.live.clone());
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
            if self.engine.is_silent() || self.tail as f32 > MAX_TAIL_SECS * ENGINE_SAMPLE_RATE as f32 {
                self.done = true;
            }
        }
        if self.publish_countdown == 0 {
            self.shared.publish(&mut self.engine, frame[0].abs(), &mut self.scratch);
            self.publish_countdown = PUBLISH_EVERY;
        }
        self.publish_countdown -= 1;
        Some(frame)
    }
}

impl Drop for BrassVoice {
    fn drop(&mut self) {
        self.shared.active.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Iterator for BrassVoice {
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

impl Source for BrassVoice {
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
// A long-lived player that notes are sent to
// ------------------------------------------------------------------------------------------

/// A command for a live brass player.
pub enum BrassCommand {
    NoteOn { id: u64, params: BrassParams, gated: bool, live: Option<Arc<BrassLive>> },
    NoteOff { id: u64 },
    AllNotesOff,
}

/// The caller's side of a live brass player. Commands are queued under a mutex the audio thread
/// only ever `try_lock`s, so it never blocks on the caller (the same scheme as the strings).
pub struct BrassHandle {
    queue: Mutex<BrassQueue>,
    instrument: BrassInstrument,
}

struct BrassQueue {
    commands: Vec<BrassCommand>,
    /// False once the audio side has shut down; a new voice must be started for further notes.
    alive: bool,
}

impl BrassHandle {
    /// Queues a command, or hands it back if the audio side has stopped.
    pub fn send(&self, cmd: BrassCommand) -> Result<(), BrassCommand> {
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

    /// Whether the running player plays the instrument `p` asks for.
    pub fn same_instrument(&self, p: &BrassParams) -> bool {
        self.instrument == p.instrument
    }

    /// Asks the running voice to let the note go and stop.
    pub fn retire(&self) {
        let _ = self.send(BrassCommand::AllNotesOff);
        self.queue.lock().unwrap_or_else(|p| p.into_inner()).alive = false;
    }
}

/// A brass player on a track's bus: notes arrive through its [`BrassHandle`] and are played one
/// after another by the same lips on the same instrument, so an overlapping note slurs. It stops
/// itself (and marks the handle dead) after [`INSTRUMENT_IDLE_SECS`] of silence, or once retired.
pub struct BrassInstrumentVoice {
    engine: Engine,
    shared: Arc<BrassShared>,
    handle: Arc<BrassHandle>,
    pending: Vec<BrassCommand>,
    idle: u32,
    publish_countdown: u32,
    scratch: Scratch,
    buf: [f32; 2],
    buf_idx: u8,
    retiring: bool,
    done: bool,
}

impl BrassInstrumentVoice {
    pub fn new(shared: Arc<BrassShared>, p: &BrassParams) -> (Self, Arc<BrassHandle>) {
        shared.active.fetch_add(1, Ordering::Relaxed);
        let handle = Arc::new(BrassHandle { queue: Mutex::new(BrassQueue { commands: Vec::with_capacity(64), alive: true }), instrument: p.instrument });
        let voice = Self {
            engine: Engine::new(ENGINE_SAMPLE_RATE as f32, p),
            shared,
            handle: handle.clone(),
            pending: Vec::with_capacity(64),
            idle: 0,
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
                BrassCommand::NoteOn { id, params, gated, live } => {
                    self.engine.note_on(id, params, gated, live);
                    self.idle = 0;
                }
                BrassCommand::NoteOff { id } => self.engine.note_off(id),
                BrassCommand::AllNotesOff => self.engine.all_notes_off(),
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
            // Shut down only if nothing arrived meanwhile; marking the handle dead under the lock
            // the caller queues under means no note can slip in and be lost.
            let mut q = self.handle.queue.lock().unwrap_or_else(|p| p.into_inner());
            if q.commands.is_empty() || self.retiring {
                q.alive = false;
                self.done = true;
                return None;
            }
        }
        if self.publish_countdown == 0 {
            self.shared.publish(&mut self.engine, frame[0].abs(), &mut self.scratch);
            self.publish_countdown = PUBLISH_EVERY;
        }
        self.publish_countdown -= 1;
        Some(frame)
    }
}

impl Drop for BrassInstrumentVoice {
    fn drop(&mut self) {
        self.shared.active.fetch_sub(1, Ordering::Relaxed);
        self.shared.playing.store(false, Ordering::Relaxed);
        self.handle.queue.lock().unwrap_or_else(|p| p.into_inner()).alive = false;
    }
}

impl Iterator for BrassInstrumentVoice {
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

impl Source for BrassInstrumentVoice {
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

/// Renders notes (start in seconds, each held for its `duration`) through ONE player, the way a
/// track plays them: a note starting before the last one ends slurs into it. Sample-accurate.
/// Returns interleaved stereo at the engine rate, running until the last note has rung down
/// (capped at `tail` seconds past its release).
pub fn render_performance(notes: &[(f64, BrassParams)], tail: f32) -> Vec<f32> {
    if notes.is_empty() {
        return Vec::new();
    }
    let sr = ENGINE_SAMPLE_RATE as f32;
    let mut order: Vec<usize> = (0..notes.len()).collect();
    order.sort_by(|&a, &b| notes[a].0.total_cmp(&notes[b].0));
    // (sample, is_on, note index); offs before ons at the same sample, so a repeated note
    // re-tongues rather than being cut.
    let mut events: Vec<(u64, bool, usize)> = Vec::with_capacity(notes.len() * 2);
    for &i in &order {
        let (start, p) = &notes[i];
        let on = (start.max(0.0) * sr as f64).round() as u64;
        events.push((on, true, i));
        events.push((on + (p.duration.max(0.0) * sr) as u64, false, i));
    }
    events.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut engine = Engine::new(sr, &notes[order[0]].1);
    let last_off = events.iter().map(|e| e.0).max().unwrap_or(0);
    let hard_end = last_off + (tail.max(0.0) * sr) as u64;
    let mut out = Vec::with_capacity((hard_end as usize).min(sr as usize * 600) * 2);
    let (mut next, mut t) = (0, 0u64);
    loop {
        while next < events.len() && events[next].0 <= t {
            let (_, on, i) = events[next];
            if on {
                engine.note_on(i as u64 + 1, notes[i].1, true, None);
            } else {
                engine.note_off(i as u64 + 1);
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
// Registry: one BrassShared per instrument id (a track), for the visualization to read
// ------------------------------------------------------------------------------------------

fn registry() -> &'static Mutex<HashMap<String, Arc<BrassShared>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<BrassShared>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn shared_for(id: &str) -> Arc<BrassShared> {
    registry().lock().unwrap_or_else(|p| p.into_inner()).entry(id.to_string()).or_insert_with(|| Arc::new(BrassShared::default())).clone()
}

pub fn get_shared(id: &str) -> Option<Arc<BrassShared>> {
    registry().lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned()
}

pub fn remove_shared(id: &str) -> bool {
    registry().lock().unwrap_or_else(|p| p.into_inner()).remove(id).is_some()
}
