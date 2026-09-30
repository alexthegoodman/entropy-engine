//! The polyphonic engine: several strings at once, for chords, arpeggios left to ring and anything
//! else where one note does not stop when the next starts. `GuitarEngine` runs it when the config asks
//! for `Polyphony::Poly`; it takes the same samples and gives the same events as the monophonic engine,
//! except that several notes can be on together and there is no pitch bend (one bend cannot follow six
//! strings; per-note bend is MPE, a later phase).
//!
//! ```text
//! samples -> DC -> level + spectral-flux onset -> chord detector (poly.rs) every hop -> tracker -> events
//! ```
//!
//! A pick is heard as new energy appearing in the spectrum (spectral flux), not as the overall level
//! rising: a string picked while louder ones ring barely moves the level but lights up bins that were
//! quiet. After a pick the detector reads only the signal since it, once there is enough of it (the
//! mode's `chord_wait_ms`), so a chord that was muted as the next was struck does not bleed into it.
//! Notes that turn up soon after the pick are that pick's notes; a note that turns up later with no pick
//! of its own (a hammer-on) must hold for a while first.
//!
//! Nothing allocates after `new` (RT-1, RT-2).

use super::config::{GuitarConfig, Mode};
use super::dsp::{amp_to_db, DcBlocker, Ring};
use super::engine::Diagnostics;
use super::events::{EventSink, GuitarEvent, GuitarEventKind};
use super::poly::{harmonic_above, NoteSet, PolyDetector, PolyFrame, MAX_NOTES};
use super::tracker::{TrackerState, TrackerStats};
use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

/// Analysis hop, milliseconds (256 samples at 48 kHz).
const HOP_MS: f32 = 5.334;
/// Longest analysis window, milliseconds (4096 samples at 48 kHz). Long enough to tell the low strings'
/// partials apart; any longer and a string muted while others ring would take too long to drop out.
const MAX_WINDOW_MS: f32 = 85.4;
/// The onset detector's window, milliseconds (1024 samples at 48 kHz).
const FLUX_WINDOW_MS: f32 = 21.3;
/// Flux is measured from here up to `TOP_HZ`.
const FLUX_LO_HZ: f32 = 60.0;
const FLUX_TOP_HZ: f32 = 5000.0;
/// A rise in dB summed over bins at least this large is a pick, at neutral sensitivity. A string picked
/// at -34 dBFS scores about 150, a slap or a thump far more, a held chord's beating and decay up to 25.
/// The first string of a strum over a chord being muted can score only about 50, so a chord change may
/// be heard a string or two late; lower than 60 and a ringing chord starts setting it off.
const ONSET_FLUX: f32 = 60.0;
/// The pick click is left out of the chord detector's window.
const ATTACK_SKIP_MS: f32 = 3.0;
/// Picks closer than this to the previous one belong to the same strum.
const STRUM_MERGE_MS: f32 = 35.0;
/// A strum is never longer than this, however many picks chain on.
const STRUM_MAX_MS: f32 = 120.0;
/// A note first found this long after its strum began is still that strum's.
const LATE_NOTE_MS: f32 = 90.0;
/// A note found with no pick must be found this long before it is believed (a hammer-on, a pull-off),
/// and be no more than `LEGATO_BELOW_DB` quieter than the loudest note sounding.
const LEGATO_MS: f32 = 50.0;
const LEGATO_BELOW_DB: f32 = 6.0;
/// Windows shorter than this are "short": new notes in them must clear bars this many times higher.
const SETTLED_WINDOW_MS: f32 = 62.0;
const SHORT_WINDOW_STRICTNESS: f32 = 1.6;
/// A note held over a strum found this many dB under its level before the strum was muted.
const MUTED_DROP_DB: f32 = 12.0;
/// A sounding note whose fundamental is within this many dB of the note's strength is still ringing.
const LINGER_DROP_DB: f32 = 10.0;
/// Windows shorter than this after a pick do not end a sounding note by missing it.
const SETTLE_MS: f32 = 75.0;
/// A sounding note may be missing from this many milliseconds of frames more than the mode's release
/// time before it ends: a quiet string in a loud chord drops out of a frame now and then.
const DROPOUT_MS: f32 = 30.0;
/// A ringing note whose own partials come back this much louder after a pick was picked again.
const REPICK_DB: f32 = 4.0;
/// The level falling this far under its recent maximum is a hand muting every string.
const MUTE_DROP_DB: f32 = 18.0;
/// How fast that recent maximum may fall, dB per millisecond (as in the monophonic tracker).
const RECENT_MAX_FALL_DB_PER_MS: f32 = 0.15;
/// Level window, as in the monophonic engine.
const LEVEL_WINDOW_MS: f32 = 15.0;
const DC_CORNER_HZ: f32 = 20.0;
/// At most this many notes are held at once. Six strings, and room for one to be replaced.
const MAX_VOICES: usize = 8;

/// Spectral-flux onset detector: the summed rise in dB, bin by bin, against the louder of the two
/// previous frames with each bin allowed its neighbours' level (so vibrato and a slight drift in pitch
/// do not count as new energy).
struct FluxOnset {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    /// dB per bin for this frame and the two before it.
    frames: [Vec<f32>; 3],
    newest: usize,
    lo: usize,
    hi: usize,
    filled: u8,
}

impl FluxOnset {
    fn new(planner: &mut RealFftPlanner<f32>, sample_rate: f32) -> Self {
        let len = ((FLUX_WINDOW_MS * sample_rate / 1000.0) as usize).next_power_of_two();
        let fft = planner.plan_fft_forward(len);
        let bin_hz = sample_rate / len as f32;
        let bins = len / 2 + 1;
        FluxOnset {
            window: (0..len).map(|n| 0.5 - 0.5 * (std::f32::consts::TAU * (n as f32 + 0.5) / len as f32).cos()).collect(),
            input: fft.make_input_vec(),
            spectrum: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
            frames: [vec![0.0; bins], vec![0.0; bins], vec![0.0; bins]],
            newest: 0,
            lo: ((FLUX_LO_HZ / bin_hz) as usize).max(1),
            hi: ((FLUX_TOP_HZ.min(sample_rate * 0.45) / bin_hz) as usize).min(bins - 2),
            filled: 0,
        }
    }

    fn len(&self) -> usize {
        self.window.len()
    }

    /// Flux of the newest `len()` samples against the frames before. `floor_db` is where quiet stops
    /// counting, so noise under the gate adds nothing.
    fn step(&mut self, x: &[f32], floor_db: f32) -> f32 {
        let len = self.len();
        for (o, (s, w)) in self.input.iter_mut().zip(x.iter().zip(self.window.iter())) {
            *o = s * w;
        }
        self.fft.process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch).expect("fft length");
        let scale = 4.0 / len as f32;
        self.newest = (self.newest + 1) % 3;
        let (a, b, c) = (self.newest, (self.newest + 2) % 3, (self.newest + 1) % 3);
        for (d, z) in self.frames[a].iter_mut().zip(self.spectrum.iter()) {
            *d = amp_to_db(z.norm() * scale).max(floor_db);
        }
        if self.filled < 2 {
            self.filled += 1;
            return 0.0;
        }
        let (now, prev1, prev2) = (&self.frames[a], &self.frames[b], &self.frames[c]);
        let mut flux = 0.0;
        for k in self.lo..=self.hi {
            let reference = prev1[k - 1].max(prev1[k]).max(prev1[k + 1]).max(prev2[k - 1]).max(prev2[k]).max(prev2[k + 1]);
            flux += (now[k] - reference).max(0.0);
        }
        flux
    }

    fn reset(&mut self) {
        self.filled = 0;
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Voice {
    note: u8,
    velocity: u8,
    /// Strength (dBFS) in the latest frame that found it.
    strength_db: f32,
    /// Its strength just before the latest strum, for telling a re-pick from a string left ringing.
    pre_db: f32,
    /// A re-pick is still possible in this strum.
    repick_armed: bool,
    missing_hops: u32,
    /// Missing from the latest frame.
    missing: bool,
    missing_since: u64,
}

#[derive(Clone, Copy, Debug)]
struct Strum {
    start: u64,
    last: u64,
    /// No frame has been read since it began.
    fresh: bool,
    notes: u32,
}

#[derive(Clone, Copy, Debug, Default)]
struct Legato {
    note: u8,
    hops: u32,
    since: u64,
}

/// One hop of what the engine measured.
#[derive(Clone, Copy, Debug)]
pub struct PolyHop<'a> {
    pub sample: u64,
    pub level_db: f32,
    /// A pick, and where it landed.
    pub onset: Option<u64>,
    /// The notes found this hop, or `None` while the window since the last pick is still too short to read.
    pub frame: Option<&'a PolyFrame>,
    /// Sounding notes whose fundamental is still plainly in the spectrum, found or not.
    pub lingering: NoteSet,
}

/// Turns frames of notes into Note On and Note Off events. Pure state machine: it sees one `PolyHop`
/// per analysis hop and is tested by feeding it frames.
pub struct PolyTracker {
    cfg: GuitarConfig,
    voices: [Voice; MAX_VOICES],
    count: usize,
    strum: Option<Strum>,
    legato: [Legato; MAX_NOTES],
    stats: TrackerStats,
    hop_ms: f32,
    wait_samples: u64,
    release_hops: u32,
    /// Frames a sounding note may be missing from before it ends.
    missing_hops: u32,
    /// Frames running a new note must be found in.
    confirm_frames: u32,
    late_samples: u64,
    /// Before this long after a pick, a sounding note missing from a frame is not held against it.
    settle_samples: u64,
    merge_samples: u64,
    strum_max_samples: u64,
    legato_hops: u32,
    recent_max_db: f32,
    quiet_hops: u32,
    quiet_since: u64,
    last_velocity: u8,
    last_note_on: Option<(u64, u64)>,
}

impl PolyTracker {
    pub fn new(cfg: &GuitarConfig, hop: usize) -> Self {
        let mode = cfg.mode.params();
        let fs = cfg.sample_rate;
        let hop_ms = hop as f32 / fs * 1000.0;
        let ms = |v: f32| (v * fs / 1000.0) as u64;
        PolyTracker {
            cfg: cfg.clone(),
            voices: [Voice::default(); MAX_VOICES],
            count: 0,
            strum: None,
            legato: [Legato::default(); MAX_NOTES],
            stats: TrackerStats::default(),
            hop_ms,
            wait_samples: ms(mode.chord_wait_ms),
            release_hops: (mode.release_ms / hop_ms).ceil().max(1.0) as u32,
            missing_hops: ((mode.release_ms + DROPOUT_MS) / hop_ms).ceil().max(1.0) as u32,
            confirm_frames: match cfg.mode {
                Mode::Fast => 2,
                Mode::Balanced => 3,
                Mode::Accurate => 4,
            },
            late_samples: ms(mode.chord_wait_ms + LATE_NOTE_MS),
            merge_samples: ms(STRUM_MERGE_MS),
            settle_samples: ms(SETTLE_MS.max(mode.chord_wait_ms)),
            strum_max_samples: ms(STRUM_MAX_MS),
            legato_hops: (LEGATO_MS / hop_ms).ceil().max(1.0) as u32,
            recent_max_db: -120.0,
            quiet_hops: 0,
            quiet_since: 0,
            last_velocity: 0,
            last_note_on: None,
        }
    }

    /// Adopts new settings without touching what is sounding.
    pub fn reconfigure(&mut self, cfg: &GuitarConfig, hop: usize) {
        let mut next = PolyTracker::new(cfg, hop);
        next.voices = self.voices;
        next.count = self.count;
        next.strum = self.strum;
        next.legato = self.legato;
        next.stats = self.stats;
        next.recent_max_db = self.recent_max_db;
        next.last_velocity = self.last_velocity;
        next.last_note_on = self.last_note_on;
        *self = next;
    }

    /// The notes sounding.
    pub fn active(&self) -> NoteSet {
        let mut s = NoteSet::default();
        for v in &self.voices[..self.count] {
            s.insert(v.note);
        }
        s
    }

    /// The strength (dBFS) a sounding note had when last found; -120 if it is not sounding.
    pub fn strength_of(&self, note: u8) -> f32 {
        self.voices[..self.count].iter().find(|v| v.note == note).map_or(-120.0, |v| v.strength_db)
    }

    /// The notes the detector should give the benefit of the doubt: those sounding, except the ones held
    /// over from before the latest strum that have not yet shown they are still ringing. A string muted
    /// for a chord change must not be kept alive by the new chord's partials.
    pub fn trusted(&self) -> NoteSet {
        let mut s = NoteSet::default();
        for v in self.voices[..self.count].iter().filter(|v| !v.repick_armed) {
            s.insert(v.note);
        }
        s
    }

    /// The loudest note sounding.
    pub fn loudest(&self) -> Option<u8> {
        self.voices[..self.count].iter().max_by(|a, b| a.strength_db.total_cmp(&b.strength_db)).map(|v| v.note)
    }

    pub fn stats(&self) -> TrackerStats {
        self.stats
    }

    pub fn velocity(&self) -> u8 {
        self.last_velocity
    }

    pub fn last_note_on(&self) -> Option<(u64, u64)> {
        self.last_note_on
    }

    /// Where the window the detector should read begins, and whether it holds enough to read yet.
    pub fn window_start(&self, now: u64, attack_skip: u64, max_window: u64) -> (u64, bool) {
        match self.strum {
            Some(s) if now.saturating_sub(s.start) < max_window + attack_skip => (s.start + attack_skip, now >= s.start + self.wait_samples),
            _ => (now.saturating_sub(max_window), true),
        }
    }

    pub fn state(&self) -> TrackerState {
        match (self.count, self.strum) {
            (_, Some(s)) if s.fresh => TrackerState::Attack,
            (0, _) => TrackerState::Silent,
            _ if self.quiet_hops > 0 => TrackerState::Release,
            _ => TrackerState::Playing,
        }
    }

    fn velocity_for(&self, db: f32) -> u8 {
        let span = (self.cfg.velocity_ceil_db - self.cfg.velocity_floor_db).max(1.0);
        let t = ((db - self.cfg.velocity_floor_db) / span).clamp(0.0, 1.0);
        (1.0 + 126.0 * t.powf(self.cfg.velocity_gamma)).round().clamp(1.0, 127.0) as u8
    }

    fn emit(sink: &mut impl EventSink, kind: GuitarEventKind, sample: u64, source_sample: u64) {
        sink.push(GuitarEvent { kind, sample, source_sample: source_sample.min(sample) });
    }

    fn off(&mut self, i: usize, sample: u64, source: u64, sink: &mut impl EventSink) {
        Self::emit(sink, GuitarEventKind::NoteOff { note: self.voices[i].note }, sample, source);
        self.voices[i] = self.voices[self.count - 1];
        self.count -= 1;
    }

    fn on(&mut self, note: u8, strength_db: f32, sample: u64, source: u64, sink: &mut impl EventSink) {
        if self.count == MAX_VOICES {
            return;
        }
        let velocity = self.velocity_for(strength_db);
        Self::emit(sink, GuitarEventKind::NoteOn { note, velocity }, sample, source);
        self.stats.notes += 1;
        self.last_velocity = velocity;
        self.last_note_on = Some((sample, source));
        self.voices[self.count] = Voice { note, velocity, strength_db, pre_db: strength_db, repick_armed: false, missing_hops: 0, missing: false, missing_since: sample };
        self.count += 1;
    }

    /// Releases every note (EVT-6).
    pub fn release_all(&mut self, sample: u64, sink: &mut impl EventSink) {
        while self.count > 0 {
            self.off(self.count - 1, sample, sample, sink);
        }
        self.strum = None;
    }

    pub fn step(&mut self, input: &PolyHop, sink: &mut impl EventSink) {
        let now = input.sample;

        // --- A pick: part of the strum under way, or a new one.
        if let Some(at) = input.onset {
            match self.strum.as_mut() {
                Some(s) if at.saturating_sub(s.last) <= self.merge_samples && at.saturating_sub(s.start) <= self.strum_max_samples => s.last = at,
                _ => {
                    if let Some(s) = self.strum {
                        if s.notes == 0 && !s.fresh {
                            self.stats.noise_rejects += 1;
                        }
                    }
                    self.strum = Some(Strum { start: at, last: at, fresh: true, notes: 0 });
                    for v in self.voices[..self.count].iter_mut() {
                        v.pre_db = v.strength_db;
                        v.repick_armed = true;
                    }
                }
            }
            self.quiet_hops = 0;
        }

        // --- A hand over every string: the level falls far and fast.
        let fall = RECENT_MAX_FALL_DB_PER_MS * self.hop_ms;
        self.recent_max_db = input.level_db.max(self.recent_max_db - fall);
        let quiet = input.level_db < self.cfg.gate_close_db || input.level_db < self.recent_max_db - MUTE_DROP_DB;
        if quiet && self.count > 0 {
            if self.quiet_hops == 0 {
                self.quiet_since = now;
            }
            self.quiet_hops += 1;
            if self.quiet_hops >= self.release_hops {
                let since = self.quiet_since;
                while self.count > 0 {
                    self.off(self.count - 1, now, since, sink);
                }
                self.quiet_hops = 0;
            }
        } else {
            self.quiet_hops = 0;
        }

        let Some(frame) = input.frame else { return };
        let strum = self.strum;
        let in_strum = strum.map_or(false, |s| now.saturating_sub(s.start) <= self.late_samples);
        let first_frame = strum.map_or(false, |s| s.fresh);
        let short_window = strum.map_or(false, |s| now.saturating_sub(s.start) < self.settle_samples);
        if let Some(s) = self.strum.as_mut() {
            s.fresh = false;
        }

        // --- Notes that were sounding.
        let mut i = 0;
        while i < self.count {
            let v = self.voices[i];
            // A string left ringing through a strum cannot lose much in a tenth of a second. Found far
            // under where it was before the strum, it was muted, and what was found is its dying tail
            // at the start of the window, or other strings' partials.
            let found = frame.get(v.note).filter(|f| !(in_strum && v.repick_armed && f.strength_db < v.pre_db - MUTED_DROP_DB));
            match found {
                Some(found) => {
                    let voice = &mut self.voices[i];
                    voice.strength_db = found.strength_db;
                    voice.missing_hops = 0;
                    voice.missing = false;
                    if voice.repick_armed && in_strum {
                        if found.strength_db >= v.pre_db + REPICK_DB {
                            let source = strum.map_or(now, |s| s.start);
                            self.off(i, now, source, sink);
                            self.on(v.note, found.strength_db, now, source, sink);
                            self.stats.repicks += 1;
                            if let Some(s) = self.strum.as_mut() {
                                s.notes += 1;
                            }
                            // `on` appended it at the end; the voice that took slot i is next.
                            continue;
                        }
                    } else {
                        voice.repick_armed = false;
                    }
                }
                None => {
                    let voice = &mut self.voices[i];
                    if !voice.missing {
                        // Gone from the first window after a pick: gone since the pick.
                        voice.missing = true;
                        voice.missing_since = if first_frame { strum.map_or(now, |s| s.start) } else { now };
                    }
                    // The first windows after a pick are short, and a quiet string ringing under a loud new
                    // one drops out of them. They do not count against it while its fundamental is still
                    // there; a muted string's is not.
                    let ringing = input.lingering.contains(v.note);
                    if short_window && ringing {
                        i += 1;
                        continue;
                    }
                    // Missing from the first window after a pick with nothing left at its fundamental: the
                    // hand muted it for the new chord. No reason to wait.
                    if first_frame && !ringing {
                        let since = voice.missing_since;
                        self.off(i, now, since, sink);
                        continue;
                    }
                    voice.missing_hops += 1;
                    if voice.missing_hops >= self.missing_hops {
                        // Never found again since the strum: it stopped at the strum.
                        let since = if voice.repick_armed { strum.map_or(voice.missing_since, |s| s.start.min(voice.missing_since)) } else { voice.missing_since };
                        self.off(i, now, since, sink);
                        continue;
                    }
                }
            }
            i += 1;
        }

        // --- Notes that are new. Each must be found in several frames running before it is believed:
        // what is left over when a chord is taken apart comes and goes from one frame to the next.
        let active = self.active();
        let loudest_active = self.voices[..self.count].iter().map(|v| v.strength_db).fold(f32::MIN, f32::max);
        let mut seen = [Legato::default(); MAX_NOTES];
        let mut kept = 0;
        for n in frame.iter() {
            if active.contains(n.note) {
                continue;
            }
            let before = self.legato.iter().find(|l| l.hops > 0 && l.note == n.note).copied();
            let mut l = before.unwrap_or(Legato { note: n.note, hops: 0, since: now });
            l.hops += 1;
            let start = if in_strum && l.hops >= self.confirm_frames {
                // Picked in this strum.
                Some(strum.map_or(now, |s| s.start))
            } else if !in_strum
                && l.hops >= self.legato_hops
                && self.count > 0
                && n.strength_db >= loudest_active - LEGATO_BELOW_DB
                && !active.iter().any(|a| harmonic_above(a, n.note) || a.abs_diff(n.note) == 1)
            {
                // No pick of its own (a hammer-on, a pull-off): it held long enough, beside a note
                // already sounding, nearly as loud, and not where leftovers of that note would land.
                self.stats.slides += 1;
                Some(l.since)
            } else {
                None
            };
            match start {
                Some(source) => {
                    self.on(n.note, n.strength_db, now, source, sink);
                    if let Some(s) = self.strum.as_mut() {
                        s.notes += 1;
                    }
                }
                None if kept < seen.len() => {
                    seen[kept] = l;
                    kept += 1;
                }
                None => {}
            }
        }
        self.legato = seen;
    }
}

pub struct PolyEngine {
    cfg: GuitarConfig,
    input_gain: f32,
    dc: DcBlocker,
    ring: Ring,
    seg: Vec<f32>,
    flux_seg: Vec<f32>,
    flux: FluxOnset,
    detector: PolyDetector,
    tracker: PolyTracker,
    frame: PolyFrame,
    hop: usize,
    hop_fill: usize,
    level_window: usize,
    max_window: usize,
    attack_skip: u64,
    /// Windows shorter than this read new notes more sceptically.
    settled_window: usize,
    refractory: u64,
    last_onset: Option<u64>,
    last_flux: f32,
    last_level_db: f32,
    peak_since_take: f32,
    diag: Diagnostics,
}

impl PolyEngine {
    pub fn new(cfg: GuitarConfig) -> Self {
        let fs = cfg.sample_rate;
        let hop = ((HOP_MS * fs / 1000.0).round() as usize).max(16);
        let max_window = (MAX_WINDOW_MS * fs / 1000.0) as usize;
        let mut planner = RealFftPlanner::new();
        let detector = PolyDetector::new(&mut planner, fs, cfg.min_hz, cfg.max_hz, cfg.reference_pitch, cfg.tuning, cfg.frets, max_window);
        let max_window = detector.max_window();
        let flux = FluxOnset::new(&mut planner, fs);
        let level_window = ((LEVEL_WINDOW_MS * fs / 1000.0) as usize).max(hop);
        let mut engine = PolyEngine {
            input_gain: 10f32.powf(cfg.input_gain_db / 20.0),
            dc: DcBlocker::new(fs, DC_CORNER_HZ),
            ring: Ring::new(max_window.max(flux.len()).max(level_window) + 2 * hop),
            seg: vec![0.0; max_window],
            flux_seg: vec![0.0; flux.len()],
            flux,
            detector,
            tracker: PolyTracker::new(&cfg, hop),
            frame: PolyFrame::default(),
            hop,
            hop_fill: 0,
            level_window,
            max_window,
            attack_skip: (ATTACK_SKIP_MS * fs / 1000.0) as u64,
            settled_window: (SETTLED_WINDOW_MS * fs / 1000.0) as usize,
            refractory: (cfg.mode.params().refractory_ms * fs / 1000.0) as u64,
            last_onset: None,
            last_flux: 0.0,
            last_level_db: -120.0,
            peak_since_take: 0.0,
            diag: Diagnostics::silent(),
            cfg,
        };
        engine.diag.polyphonic = true;
        engine
    }

    pub fn config(&self) -> &GuitarConfig {
        &self.cfg
    }

    pub fn set_tunables(&mut self, t: &super::config::Tunables) {
        self.cfg.apply_tunables(t);
        self.input_gain = 10f32.powf(self.cfg.input_gain_db / 20.0);
        self.refractory = (self.cfg.mode.params().refractory_ms * self.cfg.sample_rate / 1000.0) as u64;
        self.detector.set_reference(self.cfg.reference_pitch);
        self.tracker.reconfigure(&self.cfg, self.hop);
    }

    pub fn detector(&self) -> &PolyDetector {
        &self.detector
    }

    pub fn detector_mut(&mut self) -> &mut PolyDetector {
        &mut self.detector
    }

    pub fn hop(&self) -> usize {
        self.hop
    }

    pub fn position(&self) -> u64 {
        self.ring.written()
    }

    pub fn diagnostics(&self) -> Diagnostics {
        self.diag
    }

    pub fn take_peak(&mut self) -> f32 {
        std::mem::take(&mut self.peak_since_take)
    }

    /// The last onset strength, for tuning.
    pub fn last_flux(&self) -> f32 {
        self.last_flux
    }

    pub fn release_all(&mut self, sink: &mut impl EventSink) {
        let now = self.ring.written();
        self.tracker.release_all(now, sink);
        self.refresh_diagnostics();
    }

    pub fn reset(&mut self, sink: &mut impl EventSink) {
        self.release_all(sink);
        self.dc.reset();
        self.ring.clear();
        self.flux.reset();
        self.hop_fill = 0;
        self.last_onset = None;
        self.tracker = PolyTracker::new(&self.cfg, self.hop);
    }

    pub fn process(&mut self, block: &[f32], sink: &mut impl EventSink) {
        for &raw in block {
            let raw = if raw.is_finite() { raw } else { 0.0 };
            let x = raw * self.input_gain;
            self.peak_since_take = self.peak_since_take.max(x.abs());
            let y = self.dc.process(x);
            self.ring.push(y);
            self.hop_fill += 1;
            if self.hop_fill == self.hop {
                self.hop_fill = 0;
                self.on_hop(sink);
            }
        }
    }

    fn on_hop(&mut self, sink: &mut impl EventSink) {
        let now = self.ring.written();
        let n = self.level_window.min(now as usize).max(1);
        let level_db = amp_to_db((self.ring.energy(n) / n as f32).sqrt());
        self.last_level_db = level_db;

        // --- Onset.
        self.ring.latest(&mut self.flux_seg);
        let flux = self.flux.step(&self.flux_seg, self.cfg.gate_close_db);
        self.last_flux = flux;
        let threshold = ONSET_FLUX * (1.0 - (self.cfg.sensitivity - 0.5) * 0.8);
        let refractory_ok = self.last_onset.map_or(true, |t| now.saturating_sub(t) >= self.refractory);
        let onset = (flux >= threshold && level_db >= self.cfg.gate_open_db && refractory_ok).then(|| {
            self.last_onset = Some(now);
            // The attack entered the onset window during this hop.
            now.saturating_sub(self.hop as u64)
        });

        // --- Onset first, so a pick this hop starts its own window before anything is read.
        let pre = PolyHop { sample: now, level_db, onset, frame: None, lingering: NoteSet::default() };
        self.tracker.step(&pre, sink);

        // --- The notes in the window since the last pick (or the longest window, if it was long ago).
        let (start, ready) = self.tracker.window_start(now, self.attack_skip, self.max_window as u64);
        if ready {
            let available = now.saturating_sub(start) as usize;
            if level_db < self.cfg.gate_close_db {
                self.frame = PolyFrame::default();
            } else {
                let len = self.detector.window_for(available.min(self.max_window));
                self.ring.latest(&mut self.seg[..len]);
                self.detector.set_strictness(if len < self.settled_window { SHORT_WINDOW_STRICTNESS } else { 1.0 });
                self.detector.analyze(&self.seg[..len], self.tracker.trusted(), &mut self.frame);
            }
            let mut lingering = NoteSet::default();
            for note in self.tracker.active().iter() {
                let f0 = super::events::midi_to_hz(note as f32, self.cfg.reference_pitch);
                // A fundamental that another note found also has a partial on says nothing about this one.
                let lobe = self.cfg.sample_rate / self.detector.last_window().max(1) as f32;
                let explained = self.frame.iter().any(|n| {
                    let h = (f0 / n.freq_hz).round().max(1.0);
                    n.note != note && (h * n.freq_hz - f0).abs() < lobe
                });
                if !explained && level_db >= self.cfg.gate_close_db && self.detector.fundamental_db(f0) >= self.tracker.strength_of(note) - LINGER_DROP_DB {
                    lingering.insert(note);
                }
            }
            let frame = self.frame;
            let hop = PolyHop { sample: now, level_db, onset: None, frame: Some(&frame), lingering };
            self.tracker.step(&hop, sink);
        }
        self.refresh_diagnostics();
    }

    fn refresh_diagnostics(&mut self) {
        let d = &mut self.diag;
        d.level_db = self.last_level_db;
        d.input_peak = self.peak_since_take;
        d.clipping = d.input_peak >= 0.891;
        d.state = self.tracker.state();
        d.notes = self.tracker.active();
        d.note = self.tracker.loudest();
        if let Some(loud) = self.frame.iter().max_by(|a, b| a.strength_db.total_cmp(&b.strength_db)) {
            d.freq_hz = loud.freq_hz;
            d.confidence = loud.salience.min(1.0);
            d.cents = 1200.0 * (loud.freq_hz / super::events::midi_to_hz(loud.note as f32, self.cfg.reference_pitch)).log2();
        }
        d.velocity = self.tracker.velocity();
        d.stats = self.tracker.stats();
        if let Some((emitted, picked)) = self.tracker.last_note_on() {
            d.last_latency_samples = emitted.saturating_sub(picked);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guitar::config::Polyphony;
    use crate::guitar::poly::PolyNote;

    fn cfg() -> GuitarConfig {
        GuitarConfig { mode: Mode::Balanced, polyphony: Polyphony::Poly, ..GuitarConfig::default() }
    }

    fn frame(notes: &[(u8, f32)]) -> PolyFrame {
        let mut f = PolyFrame::default();
        for &(note, db) in notes {
            f.notes[f.count] = PolyNote { note, freq_hz: 0.0, strength_db: db, salience: 1.0 };
            f.count += 1;
        }
        f
    }

    struct Rig {
        t: PolyTracker,
        events: Vec<GuitarEvent>,
        n: u64,
    }

    impl Rig {
        fn new() -> Self {
            Rig { t: PolyTracker::new(&cfg(), 256), events: Vec::new(), n: 0 }
        }

        fn hop(&mut self, level_db: f32, onset: bool, notes: &[(u8, f32)]) {
            self.n += 256;
            let f = frame(notes);
            let pre = PolyHop { sample: self.n, level_db, onset: onset.then_some(self.n - 256), frame: None, lingering: NoteSet::default() };
            self.t.step(&pre, &mut self.events);
            let (_, ready) = self.t.window_start(self.n, 144, 4096);
            if ready {
                // A note the frame lost is still ringing when it is quieter than the loudest by less than 20 dB.
                let lingering = self.t.active();
                self.t.step(&PolyHop { sample: self.n, level_db, onset: None, frame: Some(&f), lingering }, &mut self.events);
            }
        }

        fn run(&mut self, hops: usize, level_db: f32, notes: &[(u8, f32)]) {
            for _ in 0..hops {
                self.hop(level_db, false, notes);
            }
        }

        fn ons(&self) -> Vec<u8> {
            self.events.iter().filter_map(|e| if let GuitarEventKind::NoteOn { note, .. } = e.kind { Some(note) } else { None }).collect()
        }

        fn offs(&self) -> Vec<u8> {
            self.events.iter().filter_map(|e| if let GuitarEventKind::NoteOff { note } = e.kind { Some(note) } else { None }).collect()
        }
    }

    const E_MAJOR: [(u8, f32); 4] = [(40, -24.0), (47, -26.0), (52, -27.0), (56, -28.0)];
    const A_MINOR: [(u8, f32); 4] = [(45, -24.0), (52, -26.0), (57, -27.0), (60, -28.0)];

    #[test]
    fn a_strummed_chord_is_one_note_on_per_string_after_the_wait() {
        let mut r = Rig::new();
        r.hop(-20.0, true, &E_MAJOR);
        // Balanced waits 60 ms, then wants three frames running: nothing at 11 hops (59 ms).
        r.run(10, -20.0, &E_MAJOR);
        assert!(r.events.is_empty(), "{:?}", r.events);
        r.run(4, -20.0, &E_MAJOR);
        let mut ons = r.ons();
        ons.sort();
        assert_eq!(ons, vec![40, 47, 52, 56]);
        // Each describes the pick, not the moment it was decided.
        assert!(r.events.iter().all(|e| e.source_sample == 0 && e.sample > e.source_sample));
    }

    #[test]
    fn no_pick_no_chord() {
        let mut r = Rig::new();
        r.run(100, -20.0, &E_MAJOR);
        assert!(r.events.is_empty());
    }

    #[test]
    fn a_chord_change_ends_the_old_notes_and_starts_the_new() {
        let mut r = Rig::new();
        r.hop(-20.0, true, &E_MAJOR);
        r.run(60, -20.0, &E_MAJOR);
        r.hop(-20.0, true, &A_MINOR);
        r.run(30, -20.0, &A_MINOR);
        let offs = r.offs();
        // E3 (52) is in both: it was not picked harder, so it rings on.
        for n in [40, 47, 56] {
            assert!(offs.contains(&n), "{n} not released: {offs:?}");
        }
        assert!(!offs.contains(&52));
        let ons = r.ons();
        for n in [45, 57, 60] {
            assert!(ons.contains(&n), "{n} not started: {ons:?}");
        }
        assert_eq!(r.t.active().len(), 4);
    }

    #[test]
    fn a_string_picked_again_is_off_then_on() {
        let mut r = Rig::new();
        r.hop(-20.0, true, &[(52, -30.0)]);
        r.run(60, -26.0, &[(52, -34.0)]);
        r.hop(-20.0, true, &[(52, -34.0)]);
        r.run(30, -20.0, &[(52, -24.0)]);
        assert_eq!(r.ons(), vec![52, 52]);
        assert_eq!(r.offs(), vec![52]);
        assert_eq!(r.t.stats().repicks, 1);
    }

    #[test]
    fn a_pick_that_does_not_raise_a_ringing_string_leaves_it_alone() {
        let mut r = Rig::new();
        r.hop(-20.0, true, &[(52, -30.0)]);
        r.run(60, -26.0, &[(52, -30.0)]);
        // A second string joins; the first carries on at its own level.
        r.hop(-20.0, true, &[(52, -31.0)]);
        r.run(30, -20.0, &[(52, -31.0), (59, -28.0)]);
        assert_eq!(r.ons(), vec![52, 59]);
        assert!(r.offs().is_empty());
    }

    #[test]
    fn a_hand_mute_ends_every_note() {
        let mut r = Rig::new();
        r.hop(-20.0, true, &E_MAJOR);
        r.run(60, -20.0, &E_MAJOR);
        r.run(20, -60.0, &[]);
        let mut offs = r.offs();
        offs.sort();
        assert_eq!(offs, vec![40, 47, 52, 56]);
    }

    #[test]
    fn one_string_stopping_while_the_rest_ring_ends_only_that_note() {
        let mut r = Rig::new();
        r.hop(-20.0, true, &E_MAJOR);
        r.run(60, -20.0, &E_MAJOR);
        r.run(20, -21.0, &E_MAJOR[..3]);
        assert_eq!(r.offs(), vec![56]);
    }

    #[test]
    fn a_hammer_on_is_a_new_note_once_it_holds() {
        let mut r = Rig::new();
        r.hop(-20.0, true, &[(57, -24.0)]);
        r.run(60, -22.0, &[(57, -24.0)]);
        r.run(40, -22.0, &[(59, -25.0)]);
        assert_eq!(r.ons(), vec![57, 59]);
        assert_eq!(r.offs(), vec![57]);
    }

    #[test]
    fn a_quiet_flicker_with_no_pick_is_not_a_note() {
        let mut r = Rig::new();
        r.hop(-20.0, true, &[(57, -24.0)]);
        r.run(60, -22.0, &[(57, -24.0)]);
        for i in 0..40 {
            if i % 2 == 0 {
                r.hop(-22.0, false, &[(57, -24.0), (64, -30.0)]);
            } else {
                r.hop(-22.0, false, &[(57, -24.0)]);
            }
        }
        // A ghost too quiet and too brief: never a note.
        r.run(40, -22.0, &[(57, -24.0), (69, -45.0)]);
        assert_eq!(r.ons(), vec![57]);
    }

    #[test]
    fn release_all_ends_everything() {
        let mut r = Rig::new();
        r.hop(-20.0, true, &E_MAJOR);
        r.run(20, -20.0, &E_MAJOR);
        let n = r.n;
        r.t.release_all(n, &mut r.events);
        assert_eq!(r.offs().len(), 4);
        assert!(r.t.active().is_empty());
    }
}

