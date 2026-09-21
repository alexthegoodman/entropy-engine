//! Note tracker (TRK-1..TRK-8) and event translator (EVT, BND). A pitch estimate never becomes an
//! event directly: it goes through Silent -> Attack -> Playing -> Release -> Silent, and a Note On
//! needs an onset and a pitch that held still for the mode's stability window.
//!
//! Pure state machine. It sees one `HopInput` per analysis hop and knows nothing about audio
//! buffers, FFTs or devices, so it is tested by feeding it numbers.

use super::config::GuitarConfig;
use super::events::{bend_value, hz_to_midi, midi_to_hz, EventSink, GuitarEvent, GuitarEventKind, BEND_CENTER};
use super::pitch::PitchEstimate;

/// Consecutive estimates within this many cents of each other count as one held pitch.
const STABLE_TOLERANCE_CENTS: f32 = 45.0;
/// How long a candidate note may look for a stable pitch before it is written off as noise.
const ATTACK_TIMEOUT_MS: f32 = 150.0;
/// An estimate this close to a whole number of octaves away from the held note is an octave error, not a bend.
const OCTAVE_WINDOW_CENTS: f32 = 150.0;
/// Cents past the configured bend range that still count as a bend (the message clamps at full scale).
/// A whole-tone bend on a +-2 semitone range lands exactly on the edge; jitter there must not start a note.
const BEND_OVERSHOOT_CENTS: f32 = 30.0;
/// A pick over a ringing note of the SAME pitch only replaces it if, this long after the onset, the
/// level is still this far over what it was before the pick. A slap or thump reads as an onset and
/// leaves the old pitch behind once it is gone; a real re-pick keeps the string louder. The wait is
/// longer than the level window plus a slap, so the window has slid clear of the burst. A pick of a
/// different pitch needs neither: nothing else explains it.
const REPICK_SUSTAIN_DB: f32 = 3.0;
const REPICK_CONFIRM_MS: f32 = 35.0;
/// Pitches this close (cents) count as the ringing note.
const SAME_PITCH_CENTS: f32 = 60.0;
/// The envelope falling this far under its recent maximum is a muted string, however loud the note was.
const MUTE_DROP_DB: f32 = 18.0;
/// How fast that recent maximum is allowed to fall back, dB per millisecond. A natural decay is far
/// slower than this and a mute far faster.
const RECENT_MAX_FALL_DB_PER_MS: f32 = 0.15;
/// Bend smoothing time constant.
const BEND_SMOOTHING_MS: f32 = 1.5;
/// A pitch outside the bend range must hold still this long to become the next note. Longer than the
/// stability window on purpose: a slide sweeps through many semitones, and only where it stops is a note.
const SLIDE_SETTLE_MS: f32 = 25.0;
/// A lower octave that stays confidently and consistently there this long means the Note On was an octave high.
const OCTAVE_CORRECTION_MS: f32 = 30.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackerState {
    Silent,
    Attack,
    Playing,
    /// The envelope is under the release threshold; the note ends if it stays there.
    Release,
}

impl TrackerState {
    pub fn name(self) -> &'static str {
        match self {
            TrackerState::Silent => "silent",
            TrackerState::Attack => "attack",
            TrackerState::Playing => "playing",
            TrackerState::Release => "release",
        }
    }
}

/// What the tracker needs from the detector this hop.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Want {
    Nothing,
    /// A new note is being looked for from this onset. Window lengths are limited to the signal since then.
    Search { onset_sample: u64 },
    /// A note is sounding; look for its pitch near `hz`.
    Follow { hz: f32, onset_sample: u64 },
}

#[derive(Clone, Copy, Debug)]
pub struct HopInput {
    /// Input sample count at the end of this hop.
    pub sample: u64,
    /// RMS over the level window (15 ms), dBFS.
    pub level_db: f32,
    pub onset: bool,
    /// Best estimate of where the pick landed, meaningful when `onset`.
    pub onset_sample: u64,
    /// The lowest recent level, which an onset is measured against.
    pub onset_floor_db: f32,
    pub estimate: Option<PitchEstimate>,
}

/// Counters for diagnostics (DIA-1, DIA-3).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TrackerStats {
    pub notes: u64,
    /// Attacks that never found a stable pitch: pick clicks, handling noise (TRK-6).
    pub noise_rejects: u64,
    /// Estimates thrown away as an octave up from the held note (TRK-5).
    pub octave_rejects: u64,
    /// Notes re-issued because the first Note On was an octave high.
    pub octave_corrections: u64,
    /// Notes started by a pitch that left the bend range without a pick (TRK-4).
    pub slides: u64,
    pub repicks: u64,
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    onset_sample: u64,
    started: u64,
    mean_midi: f32,
    count: u32,
    /// Loudest level since the pick, dBFS.
    peak_db: f32,
    /// The level the pick rose from.
    floor_db: f32,
}

impl Candidate {
    fn new(onset_sample: u64, now: u64, level_db: f32, floor_db: f32) -> Self {
        Candidate { onset_sample, started: now, mean_midi: 0.0, count: 0, peak_db: level_db, floor_db }
    }

    /// Adds one estimate; returns the run length of estimates that agree.
    fn feed(&mut self, midi: f32) -> u32 {
        if self.count > 0 && (midi - self.mean_midi).abs() * 100.0 <= STABLE_TOLERANCE_CENTS {
            self.mean_midi = (self.mean_midi * self.count as f32 + midi) / (self.count + 1) as f32;
            self.count += 1;
        } else {
            self.mean_midi = midi;
            self.count = 1;
        }
        self.count
    }
}

#[derive(Clone, Copy, Debug)]
struct Sounding {
    note: u8,
    velocity: u8,
    onset_sample: u64,
    smoothed_cents: f32,
    raw: [f32; 3],
    raw_filled: u8,
    bend_sent: u16,
    bend_sent_sample: u64,
    recent_max_db: f32,
    below_hops: u32,
    /// The first sample the envelope was under the release threshold, for the Note Off's source time.
    below_since: u64,
    /// A pitch outside the bend range that might be the next note.
    retarget: Option<Candidate>,
    lower_octave_hops: u32,
    /// A pick while this note rings. It replaces the note only if it finds a pitch.
    pending: Option<Candidate>,
}

#[derive(Clone, Copy, Debug)]
enum Phase {
    Silent,
    Attack(Candidate),
    Playing(Sounding),
}

pub struct Tracker {
    cfg: GuitarConfig,
    phase: Phase,
    stats: TrackerStats,
    hop_ms: f32,
    stability_hops: u32,
    slide_hops: u32,
    repick_confirm_samples: u64,
    release_hops: u32,
    octave_correction_hops: u32,
    min_confidence: f32,
    refractory_samples: u64,
    attack_timeout_samples: u64,
    bend_min_interval_samples: u64,
    smoothing_alpha: f32,
    bend_range_cents: f32,
    last_onset: Option<u64>,
    /// The latest reading, for diagnostics.
    last_estimate: Option<PitchEstimate>,
    last_velocity: u8,
    /// Emit sample and pick sample of the latest Note On.
    last_note_on: Option<(u64, u64)>,
}

impl Tracker {
    pub fn new(cfg: &GuitarConfig) -> Self {
        let mode = cfg.mode.params();
        let hop_ms = cfg.hop_ms();
        let fs = cfg.sample_rate;
        Tracker {
            cfg: cfg.clone(),
            phase: Phase::Silent,
            stats: TrackerStats::default(),
            hop_ms,
            stability_hops: (mode.stability_ms / hop_ms).ceil().max(1.0) as u32,
            slide_hops: (SLIDE_SETTLE_MS / hop_ms).ceil().max(1.0) as u32,
            repick_confirm_samples: (REPICK_CONFIRM_MS * fs / 1000.0) as u64,
            release_hops: (mode.release_ms / hop_ms).ceil().max(1.0) as u32,
            octave_correction_hops: (OCTAVE_CORRECTION_MS / hop_ms).ceil().max(1.0) as u32,
            min_confidence: cfg.min_confidence(),
            refractory_samples: (mode.refractory_ms * fs / 1000.0) as u64,
            attack_timeout_samples: (ATTACK_TIMEOUT_MS * fs / 1000.0) as u64,
            bend_min_interval_samples: (fs / cfg.bend_max_rate_hz.max(1.0)) as u64,
            smoothing_alpha: 1.0 - (-hop_ms / BEND_SMOOTHING_MS).exp(),
            bend_range_cents: cfg.bend_range_clamped() * 100.0,
            last_onset: None,
            last_estimate: None,
            last_velocity: 0,
            last_note_on: None,
        }
    }

    /// `(emitted, picked)` sample of the latest Note On.
    pub fn last_note_on(&self) -> Option<(u64, u64)> {
        self.last_note_on
    }

    /// Adopts new settings (mode, thresholds, bend range) without touching what is sounding.
    pub fn reconfigure(&mut self, cfg: &GuitarConfig) {
        let mut next = Tracker::new(cfg);
        next.phase = self.phase;
        next.stats = self.stats;
        next.last_onset = self.last_onset;
        next.last_estimate = self.last_estimate;
        next.last_velocity = self.last_velocity;
        next.last_note_on = self.last_note_on;
        *self = next;
    }

    pub fn state(&self) -> TrackerState {
        match &self.phase {
            Phase::Silent => TrackerState::Silent,
            Phase::Attack(_) => TrackerState::Attack,
            Phase::Playing(s) if s.below_hops > 0 => TrackerState::Release,
            Phase::Playing(_) => TrackerState::Playing,
        }
    }

    pub fn stats(&self) -> TrackerStats {
        self.stats
    }

    /// The sounding note, if any.
    pub fn active_note(&self) -> Option<u8> {
        match &self.phase {
            Phase::Playing(s) => Some(s.note),
            _ => None,
        }
    }

    pub fn velocity(&self) -> u8 {
        self.last_velocity
    }

    /// Bend currently sent, 8192 when centered or silent.
    pub fn bend(&self) -> u16 {
        match &self.phase {
            Phase::Playing(s) => s.bend_sent,
            _ => BEND_CENTER,
        }
    }

    /// Cents between the last estimate and the held note (or nearest note), for the diagnostics view.
    pub fn cents(&self) -> f32 {
        match (&self.phase, self.last_estimate) {
            (Phase::Playing(s), _) => s.smoothed_cents,
            (_, Some(e)) => {
                let m = hz_to_midi(e.freq_hz, self.cfg.reference_pitch);
                (m - m.round()) * 100.0
            }
            _ => 0.0,
        }
    }

    pub fn last_estimate(&self) -> Option<PitchEstimate> {
        self.last_estimate
    }

    pub fn want(&self) -> Want {
        match &self.phase {
            Phase::Silent => Want::Nothing,
            Phase::Attack(a) => Want::Search { onset_sample: a.onset_sample },
            Phase::Playing(s) => match &s.pending {
                Some(p) => Want::Search { onset_sample: p.onset_sample },
                None => Want::Follow {
                    hz: midi_to_hz(s.note as f32 + s.smoothed_cents / 100.0, self.cfg.reference_pitch),
                    onset_sample: s.onset_sample,
                },
            },
        }
    }

    /// Releases whatever is sounding and centers the bend (EVT-6).
    pub fn release_all(&mut self, sample: u64, sink: &mut impl EventSink) {
        if let Phase::Playing(s) = self.phase {
            Self::end_note(&s, sample, sample, sink);
        }
        self.phase = Phase::Silent;
    }

    fn emit(sink: &mut impl EventSink, kind: GuitarEventKind, sample: u64, source_sample: u64) {
        sink.push(GuitarEvent { kind, sample, source_sample });
    }

    /// Note Off, then the bend back to center if it was off it (EVT-4).
    fn end_note(s: &Sounding, sample: u64, source_sample: u64, sink: &mut impl EventSink) {
        Self::emit(sink, GuitarEventKind::NoteOff { note: s.note }, sample, source_sample);
        if s.bend_sent != BEND_CENTER {
            Self::emit(sink, GuitarEventKind::PitchBend { value: BEND_CENTER }, sample, source_sample);
        }
    }

    fn velocity_for(&self, peak_db: f32) -> u8 {
        let span = (self.cfg.velocity_ceil_db - self.cfg.velocity_floor_db).max(1.0);
        let t = ((peak_db - self.cfg.velocity_floor_db) / span).clamp(0.0, 1.0);
        (1.0 + 126.0 * t.powf(self.cfg.velocity_gamma)).round().clamp(1.0, 127.0) as u8
    }

    fn onset_allowed(&self, input: &HopInput) -> bool {
        input.onset && self.last_onset.map_or(true, |t| input.sample.saturating_sub(t) >= self.refractory_samples)
    }

    pub fn step(&mut self, input: &HopInput, sink: &mut impl EventSink) {
        let estimate = input.estimate.filter(|e| e.confidence >= self.min_confidence);
        if let Some(e) = input.estimate {
            self.last_estimate = Some(e);
        }
        let new_onset = self.onset_allowed(input);
        if new_onset {
            self.last_onset = Some(input.sample);
        }

        self.phase = match self.phase {
            Phase::Silent => {
                if new_onset {
                    Phase::Attack(Candidate::new(input.onset_sample, input.sample, input.level_db, input.onset_floor_db))
                } else {
                    Phase::Silent
                }
            }
            Phase::Attack(a) => self.step_attack(a, input, estimate, new_onset, sink),
            Phase::Playing(s) => self.step_playing(s, input, estimate, new_onset, sink),
        };
    }

    fn step_attack(&mut self, mut a: Candidate, input: &HopInput, estimate: Option<PitchEstimate>, new_onset: bool, sink: &mut impl EventSink) -> Phase {
        if new_onset {
            // A second pick before the first found a pitch: the first was a click or a fret-hand thump.
            self.stats.noise_rejects += 1;
            return Phase::Attack(Candidate::new(input.onset_sample, input.sample, input.level_db, input.onset_floor_db));
        }
        a.peak_db = a.peak_db.max(input.level_db);
        if input.level_db < self.cfg.gate_close_db || input.sample.saturating_sub(a.started) > self.attack_timeout_samples {
            self.stats.noise_rejects += 1;
            return Phase::Silent;
        }
        match estimate {
            Some(e) => {
                let midi = hz_to_midi(e.freq_hz, self.cfg.reference_pitch);
                if a.feed(midi) >= self.stability_hops {
                    let note = a.mean_midi.round().clamp(0.0, 127.0) as u8;
                    let velocity = self.velocity_for(a.peak_db);
                    return self.start_note(note, velocity, a.mean_midi, a.onset_sample, input, sink);
                }
            }
            None => a.count = 0,
        }
        Phase::Attack(a)
    }

    /// Emits Note On for `note` and enters Playing, with the bend already sitting at the pitch the
    /// candidate agreed on.
    fn start_note(&mut self, note: u8, velocity: u8, mean_midi: f32, onset_sample: u64, input: &HopInput, sink: &mut impl EventSink) -> Phase {
        Self::emit(sink, GuitarEventKind::NoteOn { note, velocity }, input.sample, onset_sample);
        self.stats.notes += 1;
        self.last_velocity = velocity;
        self.last_note_on = Some((input.sample, onset_sample));
        let cents = (mean_midi - note as f32) * 100.0;
        let mut s = Sounding {
            note,
            velocity,
            onset_sample,
            smoothed_cents: cents,
            raw: [cents; 3],
            raw_filled: 3,
            bend_sent: BEND_CENTER,
            bend_sent_sample: input.sample.saturating_sub(self.bend_min_interval_samples),
            recent_max_db: input.level_db,
            below_hops: 0,
            below_since: input.sample,
            retarget: None,
            lower_octave_hops: 0,
            pending: None,
        };
        self.maybe_send_bend(&mut s, input.sample, onset_sample, sink);
        Phase::Playing(s)
    }

    fn maybe_send_bend(&self, s: &mut Sounding, sample: u64, source_sample: u64, sink: &mut impl EventSink) {
        let value = bend_value(s.smoothed_cents, self.cfg.bend_range_clamped());
        if value == s.bend_sent || sample.saturating_sub(s.bend_sent_sample) < self.bend_min_interval_samples {
            return;
        }
        let delta_cents = (value as f32 - s.bend_sent as f32).abs() / BEND_CENTER as f32 * self.bend_range_cents;
        if delta_cents < self.cfg.bend_min_delta_cents {
            return;
        }
        s.bend_sent = value;
        s.bend_sent_sample = sample;
        Self::emit(sink, GuitarEventKind::PitchBend { value }, sample, source_sample.min(sample));
    }

    fn step_playing(&mut self, mut s: Sounding, input: &HopInput, estimate: Option<PitchEstimate>, new_onset: bool, sink: &mut impl EventSink) -> Phase {
        // --- A pick while the note rings: look for the new pitch without dropping the old note yet.
        if new_onset {
            s.pending = Some(Candidate::new(input.onset_sample, input.sample, input.level_db, input.onset_floor_db));
            s.below_hops = 0;
            s.recent_max_db = s.recent_max_db.max(input.level_db);
        }

        // --- Envelope: is the string still sounding?
        let fall = RECENT_MAX_FALL_DB_PER_MS * self.hop_ms;
        s.recent_max_db = input.level_db.max(s.recent_max_db - fall);
        let quiet = input.level_db < self.cfg.gate_close_db || input.level_db < s.recent_max_db - MUTE_DROP_DB;
        if quiet && s.pending.is_none() {
            if s.below_hops == 0 {
                s.below_since = input.sample;
            }
            s.below_hops += 1;
            if s.below_hops >= self.release_hops {
                Self::end_note(&s, input.sample, s.below_since, sink);
                return Phase::Silent;
            }
        } else {
            s.below_hops = 0;
        }

        // --- Pending re-pick.
        if let Some(mut p) = s.pending {
            p.peak_db = p.peak_db.max(input.level_db);
            if !new_onset {
                if input.level_db < self.cfg.gate_close_db || input.sample.saturating_sub(p.started) > self.attack_timeout_samples {
                    self.stats.noise_rejects += 1;
                    s.pending = None;
                    return Phase::Playing(s);
                }
                match estimate {
                    Some(e) => {
                        let held = p.feed(hz_to_midi(e.freq_hz, self.cfg.reference_pitch));
                        let ringing = s.note as f32 + s.smoothed_cents / 100.0;
                        let same_pitch = (p.mean_midi - ringing).abs() * 100.0 < SAME_PITCH_CENTS;
                        let confirmed = !same_pitch
                            || (input.sample.saturating_sub(p.started) >= self.repick_confirm_samples && input.level_db >= p.floor_db + REPICK_SUSTAIN_DB);
                        if held >= self.stability_hops && confirmed {
                            Self::end_note(&s, input.sample, p.onset_sample, sink);
                            self.stats.repicks += 1;
                            let note = p.mean_midi.round().clamp(0.0, 127.0) as u8;
                            let velocity = self.velocity_for(p.peak_db);
                            return self.start_note(note, velocity, p.mean_midi, p.onset_sample, input, sink);
                        }
                    }
                    None => p.count = 0,
                }
            }
            s.pending = Some(p);
            return Phase::Playing(s);
        }

        // --- Follow the pitch.
        let Some(e) = estimate else { return Phase::Playing(s) };
        let midi = hz_to_midi(e.freq_hz, self.cfg.reference_pitch);
        let dev = (midi - s.note as f32) * 100.0;

        let octaves = (dev / 1200.0).round();
        let octave_off = (dev - octaves * 1200.0).abs() < OCTAVE_WINDOW_CENTS && octaves != 0.0;
        if octave_off {
            if octaves > 0.0 {
                // The fundamental fades before its harmonics do. The note has not changed.
                self.stats.octave_rejects += 1;
                s.lower_octave_hops = 0;
            } else {
                // An octave or more below: only believed after it persists, and then it is a correction.
                s.lower_octave_hops += 1;
                if s.lower_octave_hops >= self.octave_correction_hops && e.confidence >= self.min_confidence + 0.05 {
                    self.stats.octave_corrections += 1;
                    Self::end_note(&s, input.sample, input.sample, sink);
                    let note = midi.round().clamp(0.0, 127.0) as u8;
                    return self.start_note(note, s.velocity, midi, input.sample, input, sink);
                }
            }
            return Phase::Playing(s);
        }
        s.lower_octave_hops = 0;

        if dev.abs() <= self.bend_range_cents + BEND_OVERSHOOT_CENTS {
            s.retarget = None;
            s.raw = [s.raw[1], s.raw[2], dev];
            s.raw_filled = (s.raw_filled + 1).min(3);
            let median = median3(s.raw);
            s.smoothed_cents += self.smoothing_alpha * (median - s.smoothed_cents);
            self.maybe_send_bend(&mut s, input.sample, e.center_sample(), sink);
            return Phase::Playing(s);
        }

        // Past the bend range without a pick: a slide. It becomes a new note once it holds still.
        let mut c = s.retarget.unwrap_or_else(|| Candidate::new(input.sample, input.sample, input.level_db, input.level_db));
        if c.feed(midi) >= self.slide_hops.max(self.stability_hops) {
            self.stats.slides += 1;
            Self::end_note(&s, input.sample, c.started, sink);
            let note = c.mean_midi.round().clamp(0.0, 127.0) as u8;
            return self.start_note(note, s.velocity, c.mean_midi, c.started, input, sink);
        }
        s.retarget = Some(c);
        Phase::Playing(s)
    }
}

fn median3(v: [f32; 3]) -> f32 {
    let [a, b, c] = v;
    a.max(b).min(a.min(b).max(c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guitar::config::Mode;

    fn cfg() -> GuitarConfig {
        GuitarConfig { mode: Mode::Balanced, ..GuitarConfig::default() }
    }

    fn est(hz: f32, conf: f32, sample: u64) -> PitchEstimate {
        PitchEstimate { freq_hz: hz, confidence: conf, amplitude: 0.1, sample_pos: sample, tier: 0, window_len: 512 }
    }

    /// Drives the tracker with a scripted signal: `level_db(hop)`, `pitch(hop)` and onsets.
    struct Rig {
        t: Tracker,
        events: Vec<GuitarEvent>,
        hop: u64,
        n: u64,
        /// The level an onset is reported as having risen from.
        floor_db: f32,
    }

    impl Rig {
        fn new(cfg: GuitarConfig) -> Self {
            let hop = cfg.hop as u64;
            Rig { t: Tracker::new(&cfg), events: Vec::new(), hop, n: 0, floor_db: -60.0 }
        }

        fn hop(&mut self, level_db: f32, onset: bool, hz: Option<f32>) {
            self.n += self.hop;
            let sample = self.n;
            let estimate = match self.t.want() {
                Want::Nothing => None,
                _ => hz.map(|h| est(h, 0.97, sample)),
            };
            let input = HopInput { sample, level_db, onset, onset_sample: sample - self.hop, onset_floor_db: self.floor_db, estimate };
            self.t.step(&input, &mut self.events);
        }

        fn run(&mut self, hops: usize, level_db: f32, hz: Option<f32>) {
            for _ in 0..hops {
                self.hop(level_db, false, hz);
            }
        }

        fn kinds(&self) -> Vec<GuitarEventKind> {
            self.events.iter().map(|e| e.kind).collect()
        }
    }

    const E2: f32 = 82.4069;
    const A2: f32 = 110.0;

    #[test]
    fn a_stable_pitch_after_an_onset_becomes_one_note_on() {
        let mut r = Rig::new(cfg());
        r.hop(-20.0, true, Some(E2));
        assert_eq!(r.t.state(), TrackerState::Attack);
        r.run(8, -20.0, Some(E2));
        let kinds = r.kinds();
        assert_eq!(kinds.len(), 1, "{kinds:?}");
        assert!(matches!(kinds[0], GuitarEventKind::NoteOn { note: 40, .. }));
        assert_eq!(r.t.state(), TrackerState::Playing);
    }

    #[test]
    fn no_onset_means_no_note_however_clean_the_pitch() {
        let mut r = Rig::new(cfg());
        r.run(50, -20.0, Some(E2));
        assert!(r.events.is_empty());
        assert_eq!(r.t.state(), TrackerState::Silent);
    }

    #[test]
    fn an_onset_with_no_pitch_is_rejected_as_noise() {
        let mut r = Rig::new(cfg());
        r.hop(-30.0, true, None);
        r.run(200, -30.0, None);
        assert!(r.events.is_empty());
        assert_eq!(r.t.state(), TrackerState::Silent);
        assert_eq!(r.t.stats().noise_rejects, 1);
    }

    #[test]
    fn a_pitch_that_wanders_never_commits() {
        let mut r = Rig::new(cfg());
        r.hop(-20.0, true, Some(E2));
        for i in 0..60 {
            // Alternates a tone apart every hop, never agreeing twice in a row.
            r.hop(-20.0, false, Some(if i % 2 == 0 { E2 } else { E2 * 1.122 }));
        }
        assert!(r.events.is_empty(), "{:?}", r.kinds());
    }

    #[test]
    fn a_held_note_emits_exactly_one_on_and_one_off() {
        let mut r = Rig::new(cfg());
        r.hop(-18.0, true, Some(A2));
        // Five seconds of natural decay: -18 dB down to just above the gate, 0.01 dB per ms.
        let mut level = -18.0f32;
        for _ in 0..(5000.0 / r.t.cfg.hop_ms()) as usize {
            level = (level - 0.01 * r.t.cfg.hop_ms()).max(-50.0);
            r.hop(level, false, Some(A2));
        }
        r.run(80, -70.0, Some(A2));
        let kinds = r.kinds();
        let ons = kinds.iter().filter(|k| matches!(k, GuitarEventKind::NoteOn { .. })).count();
        let offs = kinds.iter().filter(|k| matches!(k, GuitarEventKind::NoteOff { .. })).count();
        assert_eq!((ons, offs), (1, 1), "{kinds:?}");
        assert_eq!(r.t.state(), TrackerState::Silent);
    }

    #[test]
    fn muting_the_string_ends_the_note_quickly_even_when_it_was_loud() {
        let mut r = Rig::new(cfg());
        r.hop(-10.0, true, Some(A2));
        r.run(60, -10.0, Some(A2));
        let mute_at = r.n;
        // Level falls 40 dB in about 20 ms and stays low but above the gate.
        for i in 0..15 {
            r.hop(-10.0 - (i as f32 * 3.0), false, Some(A2));
        }
        r.run(80, -44.0, None);
        let off = r.events.iter().find(|e| matches!(e.kind, GuitarEventKind::NoteOff { .. })).expect("a note off");
        let ms = (off.sample - mute_at) as f32 / 48.0;
        assert!(ms < 120.0, "note off {ms} ms after the mute began");
    }

    #[test]
    fn a_repick_of_the_same_pitch_is_an_off_then_an_on() {
        let mut r = Rig::new(cfg());
        r.hop(-20.0, true, Some(A2));
        r.run(60, -22.0, Some(A2));
        r.floor_db = -22.0;
        r.hop(-14.0, true, Some(A2));
        r.run(60, -15.0, Some(A2));
        let kinds = r.kinds();
        assert!(matches!(kinds[0], GuitarEventKind::NoteOn { note: 45, .. }), "{kinds:?}");
        assert!(matches!(kinds[1], GuitarEventKind::NoteOff { note: 45 }), "{kinds:?}");
        assert!(matches!(kinds[2], GuitarEventKind::NoteOn { note: 45, .. }), "{kinds:?}");
        assert_eq!(kinds.len(), 3, "{kinds:?}");
    }

    #[test]
    fn a_click_during_a_held_note_does_not_cut_it() {
        let mut r = Rig::new(cfg());
        r.hop(-20.0, true, Some(A2));
        r.run(60, -22.0, Some(A2));
        // A handling thump: a rise the level falls straight back from. The string is still ringing
        // its old pitch when the thump leaves the window, but the level says nothing was plucked.
        r.floor_db = -22.0;
        r.hop(-16.0, true, None);
        for _ in 0..200 {
            r.hop(-22.0, false, Some(A2));
        }
        let kinds = r.kinds();
        assert_eq!(kinds.len(), 1, "{kinds:?}");
        assert_eq!(r.t.state(), TrackerState::Playing);
    }

    #[test]
    fn vibrato_moves_the_bend_and_never_the_note() {
        let mut r = Rig::new(cfg());
        r.hop(-18.0, true, Some(A2));
        r.run(10, -18.0, Some(A2));
        // +-50 cents at 6 Hz for two seconds.
        let hop_s = r.t.cfg.hop_ms() / 1000.0;
        for i in 0..1500 {
            let cents = 50.0 * (2.0 * std::f32::consts::PI * 6.0 * i as f32 * hop_s).sin();
            r.hop(-18.0, false, Some(A2 * 2f32.powf(cents / 1200.0)));
        }
        let ons = r.kinds().iter().filter(|k| matches!(k, GuitarEventKind::NoteOn { .. })).count();
        assert_eq!(ons, 1, "vibrato retriggered: {:?}", r.kinds());
        let bends: Vec<u16> = r.events.iter().filter_map(|e| if let GuitarEventKind::PitchBend { value } = e.kind { Some(value) } else { None }).collect();
        assert!(bends.len() > 50, "only {} bend messages", bends.len());
        let (lo, hi) = (*bends.iter().min().unwrap(), *bends.iter().max().unwrap());
        assert!(hi > BEND_CENTER + 1500 && lo < BEND_CENTER - 1500, "bend swing {lo}..{hi}");
    }

    #[test]
    fn bend_messages_respect_the_rate_limit() {
        let mut r = Rig::new(cfg());
        r.hop(-18.0, true, Some(A2));
        r.run(10, -18.0, Some(A2));
        let hop_s = r.t.cfg.hop_ms() / 1000.0;
        for i in 0..3000 {
            let cents = 60.0 * (2.0 * std::f32::consts::PI * 8.0 * i as f32 * hop_s).sin();
            r.hop(-18.0, false, Some(A2 * 2f32.powf(cents / 1200.0)));
        }
        let times: Vec<u64> = r.events.iter().filter(|e| matches!(e.kind, GuitarEventKind::PitchBend { .. })).map(|e| e.sample).collect();
        let secs = 3000.0 * r.t.cfg.hop_ms() / 1000.0;
        let rate = times.len() as f32 / secs;
        assert!(rate <= 200.0, "{rate} bend messages/s");
        for w in times.windows(2) {
            assert!(w[1] - w[0] >= 240, "two bends {} samples apart", w[1] - w[0]);
        }
    }

    #[test]
    fn a_whole_tone_bend_rises_monotonically_without_retriggering() {
        let mut r = Rig::new(cfg());
        r.hop(-18.0, true, Some(A2));
        r.run(10, -18.0, Some(A2));
        // Bend up 200 cents over 300 ms then hold.
        let hops = (300.0 / r.t.cfg.hop_ms()) as usize;
        for i in 0..hops {
            let cents = 200.0 * i as f32 / hops as f32;
            r.hop(-18.0, false, Some(A2 * 2f32.powf(cents / 1200.0)));
        }
        r.run(100, -18.0, Some(A2 * 2f32.powf(200.0 / 1200.0)));
        let ons = r.kinds().iter().filter(|k| matches!(k, GuitarEventKind::NoteOn { .. })).count();
        assert_eq!(ons, 1);
        let bends: Vec<u16> = r.events.iter().filter_map(|e| if let GuitarEventKind::PitchBend { value } = e.kind { Some(value) } else { None }).collect();
        assert!(bends.windows(2).all(|w| w[1] >= w[0]), "not monotonic: {bends:?}");
        let last = *bends.last().unwrap();
        // A whole tone on a +-2 semitone range is full scale; within 10 cents is 410 steps.
        assert!(last >= 16383 - 410, "settled at {last}");
    }

    #[test]
    fn a_slide_past_the_bend_range_starts_a_new_note_with_the_bend_centered_first() {
        let mut r = Rig::new(cfg());
        r.hop(-18.0, true, Some(A2));
        r.run(10, -18.0, Some(A2));
        // Slide up a whole 5 semitones and hold there.
        let target = A2 * 2f32.powf(5.0 / 12.0);
        let hops = 60;
        for i in 0..hops {
            r.hop(-18.0, false, Some(A2 * (target / A2).powf(i as f32 / hops as f32)));
        }
        r.run(40, -18.0, Some(target));
        let kinds = r.kinds();
        let on_notes: Vec<u8> = kinds.iter().filter_map(|k| if let GuitarEventKind::NoteOn { note, .. } = k { Some(*note) } else { None }).collect();
        assert_eq!(on_notes, vec![45, 50], "{kinds:?}");
        assert_eq!(r.t.stats().slides, 1);
        // Order at the changeover: NoteOff, bend center, NoteOn.
        let off_idx = kinds.iter().position(|k| matches!(k, GuitarEventKind::NoteOff { .. })).unwrap();
        assert!(matches!(kinds[off_idx + 1], GuitarEventKind::PitchBend { value: BEND_CENTER }), "{kinds:?}");
        assert!(matches!(kinds[off_idx + 2], GuitarEventKind::NoteOn { note: 50, .. }), "{kinds:?}");
    }

    #[test]
    fn a_sudden_octave_up_is_ignored_without_a_pick() {
        let mut r = Rig::new(cfg());
        r.hop(-18.0, true, Some(A2));
        r.run(10, -18.0, Some(A2));
        r.run(100, -20.0, Some(A2 * 2.0));
        assert_eq!(r.kinds().iter().filter(|k| matches!(k, GuitarEventKind::NoteOn { .. })).count(), 1);
        assert!(r.t.stats().octave_rejects > 50);
    }

    #[test]
    fn an_octave_high_note_on_is_corrected_when_the_lower_octave_persists() {
        let mut r = Rig::new(cfg());
        r.hop(-18.0, true, Some(A2 * 2.0));
        r.run(10, -18.0, Some(A2 * 2.0));
        r.run(80, -18.0, Some(A2));
        let notes: Vec<u8> = r.kinds().iter().filter_map(|k| if let GuitarEventKind::NoteOn { note, .. } = k { Some(*note) } else { None }).collect();
        assert_eq!(notes, vec![57, 45], "{:?}", r.kinds());
        assert_eq!(r.t.stats().octave_corrections, 1);
    }

    #[test]
    fn release_all_offs_the_note_and_centers_the_bend() {
        let mut r = Rig::new(cfg());
        r.hop(-18.0, true, Some(A2));
        r.run(10, -18.0, Some(A2));
        let hop_s = r.t.cfg.hop_ms() / 1000.0;
        for i in 0..200 {
            let cents = 60.0 * (i as f32 * hop_s * 20.0).min(1.0);
            r.hop(-18.0, false, Some(A2 * 2f32.powf(cents / 1200.0)));
        }
        assert_ne!(r.t.bend(), BEND_CENTER);
        let n = r.n;
        r.t.release_all(n, &mut r.events);
        let tail: Vec<_> = r.kinds().into_iter().rev().take(2).collect();
        assert!(matches!(tail[1], GuitarEventKind::NoteOff { note: 45 }), "{tail:?}");
        assert!(matches!(tail[0], GuitarEventKind::PitchBend { value: BEND_CENTER }), "{tail:?}");
        assert_eq!(r.t.state(), TrackerState::Silent);
        // Idempotent: nothing is left to release.
        let before = r.events.len();
        r.t.release_all(n, &mut r.events);
        assert_eq!(r.events.len(), before);
    }

    #[test]
    fn harder_picks_are_louder_velocities() {
        let vel = |level: f32| {
            let mut r = Rig::new(cfg());
            r.hop(level, true, Some(A2));
            r.run(10, level, Some(A2));
            match r.events[0].kind {
                GuitarEventKind::NoteOn { velocity, .. } => velocity,
                k => panic!("{k:?}"),
            }
        };
        let (soft, mid, hard) = (vel(-40.0), vel(-25.0), vel(-10.0));
        assert!(soft < mid && mid < hard, "{soft} {mid} {hard}");
        assert_eq!(hard, 127);
        assert!(soft >= 1);
    }

    #[test]
    fn the_note_on_carries_the_pick_time_not_the_emit_time() {
        let mut r = Rig::new(cfg());
        r.hop(-20.0, true, Some(E2));
        let pick = r.n - r.hop;
        r.run(10, -20.0, Some(E2));
        let on = r.events[0];
        assert_eq!(on.source_sample, pick);
        assert!(on.sample > on.source_sample);
    }

    #[test]
    fn fast_mode_commits_sooner_than_accurate() {
        let latency = |mode: Mode| {
            let mut r = Rig::new(GuitarConfig { mode, ..cfg() });
            r.hop(-20.0, true, Some(A2));
            r.run(60, -20.0, Some(A2));
            r.events[0].sample - r.events[0].source_sample
        };
        assert!(latency(Mode::Fast) < latency(Mode::Balanced));
        assert!(latency(Mode::Balanced) < latency(Mode::Accurate));
    }
}
