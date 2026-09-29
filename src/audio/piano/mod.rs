//! Physically modelled grand piano instrument: felt hammers, 88-key string harp
//! with stretched Railsback inharmonicity and coupled unisons, spruce soundboard plate with bridge
//! admittance, individual dampers, and sympathetic sustain pedal resonance.
//!
//! Submodules:
//! * [`hammer`]: Nonlinear felt hammer contact dynamics with escapement and catch.
//! * [`string`]: Digital waveguide unisons, inharmonic stiffness allpass dispersion, loop losses, dampers.
//! * [`soundboard`]: 2D spruce plate modal resonators with stereo radiation and bridge admittance feedback.
//! * [`pedal`]: Sustain pedal (damper lift -> sympathetic wash), una corda (soft felt shift), sostenuto.
//! * [`engine`]: 88-key physical engine, 2x oversampling, active voice pooling, presets, quality tiers.
//! * [`analysis`]: Audio descriptors, inharmonicity estimation, Railsback tuning verification, prompt/aftersound ratio.

pub mod analysis;
pub mod engine;
pub mod hammer;
pub mod pedal;
pub mod soundboard;
pub mod string;
#[cfg(test)]
mod tests;

pub use analysis::{analyze_note, measure, PianoAnalysis};
pub use engine::{freq_to_key, railsback_frequency, PianoEngine, PianoKey, PianoParams, PianoPreset, KEY_COUNT};
pub use hammer::{Hammer, HammerSpec, HammerState};
pub use pedal::PedalState;
pub use soundboard::{Soundboard, SoundboardMode};
pub use string::{PianoStringSpec, PianoUnison, SinglePianoString};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rodio::Source;
use crate::audio::analysis::ENGINE_SAMPLE_RATE;

fn load_f32(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}

fn store_f32(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed)
}

/// Published real-time state for one of the 88 piano keys.
pub struct SharedKey {
    pub key_down: AtomicBool,
    pub damper_down: AtomicBool,
    pub energy: AtomicU32,
    pub hammer_pos: AtomicU32,
}

impl Default for SharedKey {
    fn default() -> Self {
        Self {
            key_down: AtomicBool::new(false),
            damper_down: AtomicBool::new(true),
            energy: AtomicU32::new(0),
            hammer_pos: AtomicU32::new(0),
        }
    }
}

/// Lock-free state published by the audio thread and read by the UI widget.
pub struct PianoShared {
    pub active_voices: AtomicU32,
    pub sustain_pedal: AtomicU32,
    pub una_corda: AtomicU32,
    pub soundboard_energy: AtomicU32,
    pub bridge_velocity: AtomicU32,
    pub latest_contact_time: AtomicU32,
    pub latest_peak_force: AtomicU32,
    pub keys: [SharedKey; KEY_COUNT],
}

impl Default for PianoShared {
    fn default() -> Self {
        let keys = std::array::from_fn(|_| SharedKey::default());
        Self {
            active_voices: AtomicU32::new(0),
            sustain_pedal: AtomicU32::new(0),
            una_corda: AtomicU32::new(0),
            soundboard_energy: AtomicU32::new(0),
            bridge_velocity: AtomicU32::new(0),
            latest_contact_time: AtomicU32::new(0),
            latest_peak_force: AtomicU32::new(0),
            keys,
        }
    }
}

impl PianoShared {
    pub fn publish(&self, engine: &PianoEngine, out_energy: f32) {
        store_f32(&self.sustain_pedal, engine.pedals.sustain);
        store_f32(&self.una_corda, engine.pedals.una_corda);
        store_f32(&self.soundboard_energy, out_energy);
        store_f32(&self.bridge_velocity, engine.soundboard.bridge_velocity);

        let mut active = 0u32;
        for (i, key) in engine.keys.iter().enumerate() {
            let shared_key = &self.keys[i];
            shared_key.key_down.store(key.key_down, Ordering::Relaxed);
            shared_key.damper_down.store(key.unison.is_damper_down(), Ordering::Relaxed);
            store_f32(&shared_key.energy, key.unison.energy);
            store_f32(&shared_key.hammer_pos, key.hammer.pos);

            if key.is_active() {
                active += 1;
                if key.hammer.contact_time > 0.0 {
                    store_f32(&self.latest_contact_time, key.hammer.contact_time * 1000.0);
                    store_f32(&self.latest_peak_force, key.hammer.peak_force);
                }
            }
        }
        self.active_voices.store(active, Ordering::Relaxed);
    }
}

// Global registry of shared states
static SHARED_REGISTRY: OnceLock<Mutex<HashMap<String, Arc<PianoShared>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Arc<PianoShared>>> {
    SHARED_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn shared_for(id: &str) -> Arc<PianoShared> {
    let mut reg = registry().lock().unwrap();
    reg.entry(id.to_string())
        .or_insert_with(|| Arc::new(PianoShared::default()))
        .clone()
}

pub fn get_shared(id: &str) -> Option<Arc<PianoShared>> {
    let reg = registry().lock().unwrap();
    reg.get(id).cloned()
}

pub fn remove_shared(id: &str) -> bool {
    let mut reg = registry().lock().unwrap();
    reg.remove(id).is_some()
}

/// Commands sent to a live long-lived grand piano instrument voice.
pub enum PianoCommand {
    NoteOn { id: u64, freq: f32, velocity: f32 },
    NoteOff { id: u64, freq: f32 },
    SetPedal { sustain: f32, una_corda: f32 },
    AllNotesOff,
    TimedNote { id: u64, freq: f32, velocity: f32, duration: f32 },
}

struct CommandQueue {
    commands: Vec<PianoCommand>,
    alive: bool,
}

/// Handle allowing caller threads to send commands to the running piano voice.
#[derive(Clone)]
pub struct PianoHandle {
    queue: Arc<Mutex<CommandQueue>>,
    pub params: PianoParams,
    stopped: Arc<AtomicBool>,
}

impl PianoHandle {
    pub fn stop(&self) { self.stopped.store(true,Ordering::Relaxed); }
    pub fn timed_note(&self,id:u64,freq:f32,velocity:f32,duration:f32) {
        let mut q=self.queue.lock().unwrap();
        if q.commands.len()<256 {q.commands.push(PianoCommand::TimedNote{id,freq,velocity,duration});}
    }
    pub fn same_model(&self,p:&PianoParams)->bool {
        let mut a=self.params; let mut b=*p;
        for p in [&mut a,&mut b] {p.freq=440.0;p.velocity=1.0;p.duration=1.0;p.sustain_pedal=0.0;p.una_corda=0.0;}
        a==b
    }
    pub fn note_on(&self, id: u64, freq: f32, velocity: f32) {
        let mut q = self.queue.lock().unwrap();
        if q.commands.len() < 256 { q.commands.push(PianoCommand::NoteOn { id, freq, velocity }); }
    }

    pub fn note_off(&self, id: u64, freq: f32) {
        let mut q = self.queue.lock().unwrap();
        if q.commands.len() < 256 { q.commands.push(PianoCommand::NoteOff { id, freq }); }
    }

    pub fn set_pedal(&self, sustain: f32, una_corda: f32) {
        let mut q = self.queue.lock().unwrap();
        if q.commands.len() < 256 { q.commands.push(PianoCommand::SetPedal { sustain, una_corda }); }
    }

    pub fn all_notes_off(&self) {
        let mut q = self.queue.lock().unwrap();
        if q.commands.len() < 256 { q.commands.push(PianoCommand::AllNotesOff); }
    }
}

/// Long-lived instrument voice sitting on a DAW track's bus.
pub struct PianoInstrumentVoice {
    engine: PianoEngine,
    shared: Arc<PianoShared>,
    handle: PianoHandle,
    buf: [f32; 2],
    buf_idx: u8,
    idle_count: u32,
    publish_countdown: u32,
    release_at: [u64; KEY_COUNT],
    ids: [u64; KEY_COUNT],
    frame: u64,
    stop_frames: u32,
}

impl PianoInstrumentVoice {
    pub fn new(shared: Arc<PianoShared>, params: &PianoParams) -> (Self, PianoHandle) {
        let sr = ENGINE_SAMPLE_RATE as f32;
        let engine = PianoEngine::new(sr, params);
        let queue = Arc::new(Mutex::new(CommandQueue {
            commands: Vec::with_capacity(256),
            alive: true,
        }));
        let handle = PianoHandle { queue, params: *params, stopped: Arc::new(AtomicBool::new(false)) };

        let voice = Self {
            engine,
            shared,
            handle: handle.clone(),
            buf: [0.0; 2],
            buf_idx: 0,
            idle_count: 0,
            publish_countdown: 512,
            release_at: [u64::MAX; KEY_COUNT], ids: [0; KEY_COUNT], frame: 0, stop_frames: 0,
        };

        (voice, handle)
    }

    fn drain_commands(&mut self) {
        let mut q = match self.handle.queue.try_lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        for cmd in q.commands.drain(..) {
            match cmd {
                PianoCommand::NoteOn { id, freq, velocity } => {
                    let k=freq_to_key(freq); self.ids[k]=id; self.release_at[k]=u64::MAX;
                    self.engine.note_on(freq, velocity);
                    self.idle_count = 0;
                }
                PianoCommand::NoteOff { id, freq } => {
                    let k=freq_to_key(freq);
                    if id==0 || self.ids[k]==id { self.engine.note_off(freq); self.release_at[k]=u64::MAX; }
                }
                PianoCommand::SetPedal { sustain, una_corda } => {
                    self.engine.set_sustain_pedal(sustain);
                    self.engine.set_una_corda(una_corda);
                }
                PianoCommand::TimedNote {id,freq,velocity,duration} => {
                    let k=freq_to_key(freq); self.ids[k]=id;
                    self.release_at[k]=self.frame+(duration.max(0.01)*ENGINE_SAMPLE_RATE as f32) as u64;
                    self.engine.note_on(freq,velocity);
                }
                PianoCommand::AllNotesOff => {
                    self.release_at.fill(u64::MAX);
                    self.engine.set_sustain_pedal(0.0);
                    self.engine.all_notes_off();
                }
            }
        }
    }

    fn next_frame(&mut self) -> [f32; 2] {
        if self.publish_countdown % 64 == 0 {
            self.drain_commands();
        }

        for k in 0..KEY_COUNT {
            if self.frame>=self.release_at[k] {
                self.engine.note_off(railsback_frequency(k)); self.release_at[k]=u64::MAX;
            }
        }
        self.frame+=1;
        let mut frame = self.engine.next_frame();
        if self.handle.stopped.load(Ordering::Relaxed) {
            self.stop_frames+=1;
            let fade=(1.0-self.stop_frames as f32/882.0).max(0.0);
            frame[0]*=fade; frame[1]*=fade;
        }

        if self.publish_countdown == 0 {
            let energy = frame[0].abs().max(frame[1].abs());
            self.shared.publish(&self.engine, energy);
            self.publish_countdown = 512;
        } else {
            self.publish_countdown -= 1;
        }

        frame
    }
}

impl Iterator for PianoInstrumentVoice {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.stop_frames>=882 {return None;}
        if self.buf_idx == 0 {
            self.buf = self.next_frame();
        }
        let v = self.buf[self.buf_idx as usize];
        self.buf_idx = (self.buf_idx + 1) % 2;
        Some(v)
    }
}

impl Source for PianoInstrumentVoice {
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

/// A single-note rodio Source for one-shot rendering.
pub struct PianoVoice {
    engine: PianoEngine,
    buf: [f32; 2],
    buf_idx: u8,
    samples_left: usize,
    note_off_sample: usize,
    current_sample: usize,
    freq: f32,
}

impl PianoVoice {
    pub fn new(params: &PianoParams, duration: f32) -> Self {
        let sr = ENGINE_SAMPLE_RATE as f32;
        let mut engine = PianoEngine::new(sr, params);
        engine.note_on(params.freq, params.velocity);

        let note_off_sample = (duration * sr) as usize;
        // Tail past note off to allow ringing
        let total_samples = ((duration + 4.0) * sr) as usize;

        Self {
            engine,
            buf: [0.0; 2],
            buf_idx: 0,
            samples_left: total_samples * 2,
            note_off_sample,
            current_sample: 0,
            freq: params.freq,
        }
    }
}

impl Iterator for PianoVoice {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.samples_left == 0 {
            return None;
        }

        if self.buf_idx == 0 {
            if self.current_sample == self.note_off_sample {
                self.engine.note_off(self.freq);
            }
            self.buf = self.engine.next_frame();
            self.current_sample += 1;
        }

        let v = self.buf[self.buf_idx as usize];
        self.buf_idx = (self.buf_idx + 1) % 2;
        self.samples_left -= 1;
        Some(v)
    }
}

impl Source for PianoVoice {
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

/// Renders a single piano note offline into an interleaved stereo buffer.
pub fn render_note(params: &PianoParams, tail: f32) -> Vec<f32> {
    let sr = ENGINE_SAMPLE_RATE as f32;
    let mut engine = PianoEngine::new(sr, params);
    engine.note_on(params.freq, params.velocity);

    let dur_samples = (params.duration * sr) as usize;
    let tail_samples = (tail * sr) as usize;
    let total_samples = dur_samples + tail_samples;

    let mut out = Vec::with_capacity(total_samples * 2);

    for s in 0..total_samples {
        if s == dur_samples {
            engine.note_off(params.freq);
        }
        let [l, r] = engine.next_frame();
        out.push(l);
        out.push(r);
    }

    out
}

/// One scheduled note in an offline piano performance.
#[derive(Clone, Copy, Debug)]
pub struct PerformedPianoNote {
    pub start: f64,
    pub params: PianoParams,
}

/// Renders a sequence of piano notes offline through a single shared piano engine.
pub fn render_performance(notes: &[PerformedPianoNote], tail: f32) -> Vec<f32> {
    if notes.is_empty() {
        return Vec::new();
    }
    let sr = ENGINE_SAMPLE_RATE as f32;

    let mut events: Vec<(u64, bool, usize)> = Vec::with_capacity(notes.len() * 2);
    for (i, n) in notes.iter().enumerate() {
        let on = (n.start.max(0.0) * sr as f64).round() as u64;
        let off = on + (n.params.duration.max(0.01) * sr) as u64;
        events.push((on, true, i));
        events.push((off, false, i));
    }

    events.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let first = &notes[0].params;
    let mut engine = PianoEngine::new(sr, first);

    let last_off = events.iter().map(|e| e.0).max().unwrap_or(0);
    let hard_end = last_off + (tail.max(0.5) * sr) as u64;
    let mut out = Vec::with_capacity((hard_end as usize).min(sr as usize * 300) * 2);

    let mut owners=[usize::MAX;KEY_COUNT];
    let mut next_idx = 0;
    let mut t = 0u64;

    while t < hard_end {
        while next_idx < events.len() && events[next_idx].0 <= t {
            let (_, is_on, note_idx) = events[next_idx];
            let note = &notes[note_idx];
            let k=freq_to_key(note.params.freq);
            if is_on {
                owners[k]=note_idx;
                engine.set_sustain_pedal(note.params.sustain_pedal);
                engine.set_una_corda(note.params.una_corda);
                engine.note_on(note.params.freq, note.params.velocity);
            } else if owners[k]==note_idx {
                engine.note_off(note.params.freq);
            }
            next_idx += 1;
        }

        let [l, r] = engine.next_frame();
        out.push(l);
        out.push(r);
        t += 1;

        if next_idx >= events.len() && engine.is_silent() {
            break;
        }
    }

    out
}
