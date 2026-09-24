//! A whole bowed instrument: its strings (bowed and sympathetic), one shared bridge and body, and a
//! small "player" per string that turns notes into what a violinist's hands would do - pick a
//! string, stop it with a finger, draw the bow, slur, add vibrato, lift the bow.
//!
//! The engine is plain Rust with no audio-backend dependency: `super::PhysModVoice` wraps it as a
//! `rodio::Source`, the offline renderer drives it directly, and the tests drive it sample by
//! sample. It runs its strings and coupled body modes at [`OVERSAMPLE`] times the output rate and
//! decimates on the way out.
//!
//! Notes are assigned to strings the way a player would: the highest string whose open pitch is at
//! or below the note; if that string is already sounding a held note, the next string down that can
//! reach it (a double stop); if none is free, the note is slurred on the chosen string (legato: the
//! finger moves, the bow keeps going). A new stroke on a string that is releasing reverses the bow.

use super::body::{Body, BodySpec, COUPLED_MODES};
use super::dsp::{DcBlock, Decimator2, Noise, OnePole};
use super::friction::FrictionCurve;
use super::string::{BowedString, Excitation, StringSpec};
use std::f32::consts::TAU;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

pub const OVERSAMPLE: usize = 2;
/// Bowed (playable) strings.
pub const MAX_STRINGS: usize = 4;
/// Extra unbowed strings that only ring in sympathy (a viola d'amore's, a Hardanger fiddle's).
pub const MAX_SYMPATHETIC: usize = 6;
pub const MAX_ALL_STRINGS: usize = MAX_STRINGS + MAX_SYMPATHETIC;
/// Base-rate samples between control updates (finger position, vibrato, bow smoothing targets).
const CONTROL_EVERY: u32 = 8;
/// Periods of guided stick-slip at the start of a stroke, and how many more to fade it over.
const GUIDE_PERIODS: f32 = 3.0;
const GUIDE_FADE: f32 = 2.0;
/// Notes starting within this many seconds of a held note form a chord (double stop) with it;
/// later ones slur from it.
const CHORD_WINDOW: f32 = 0.04;
/// How quickly (seconds) the player's ear pulls a bowed note back in tune.
const INTONATION_TAU: f32 = 0.08;
/// Fraction of the guided slip spent ramping in (and out).
const GUIDE_RAMP: f32 = 0.15;
/// The default instrument: a violin, G3 D4 A4 E5.
pub const VIOLIN_TUNING: [f32; MAX_STRINGS] = [196.0, 293.66, 440.0, 659.25];

// ------------------------------------------------------------------------------------------
// What a note is played with
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Articulation {
    /// Bowed.
    #[default]
    Arco,
    /// Plucked with a finger.
    Pizzicato,
    /// Struck with the wood of the bow.
    ColLegno,
}

impl Articulation {
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "arco" => Some(Self::Arco),
            "pizzicato" | "pizz" => Some(Self::Pizzicato),
            "colLegno" | "col_legno" | "col legno" => Some(Self::ColLegno),
            _ => None,
        }
    }
}

/// Everything a note is played with. The first group are the performer's controls, the second the
/// instrument's construction (the "instrument laboratory" dimensions). Construction settings are
/// taken from the most recent note-on, since they belong to the instrument rather than to a note.
#[derive(Clone, Copy, Debug)]
pub struct PhysModParams {
    pub freq: f32,
    /// 0..1: the MIDI velocity, read as dynamics - it scales bow speed and force together, so a
    /// louder note stays in the same part of the playable window rather than just getting louder.
    pub velocity: f32,
    pub gain: f32,
    /// 0..1: bow force on a logarithmic scale (0.5 is a normal *mezzo* force for this instrument at
    /// the default bow position). Too little for the bow position gives the airy, whistling
    /// "surface sound"; too much gives a raucous, crunchy tone - the two edges of Schelleng's
    /// playable window, emerging from the friction model rather than being added on.
    pub bow_force: f32,
    /// 0..1: bow speed, logarithmic (0.5 is ~0.15 m/s). Faster is louder at the same force.
    pub bow_velocity: f32,
    /// 0.02..0.5: bow contact point as a fraction of the vibrating length from the bridge. Near the
    /// bridge (sul ponticello) is bright and needs more force; toward the fingerboard (sul tasto) is
    /// soft and flute-like.
    pub bow_position: f32,
    pub vibrato_rate: f32,
    /// Cents.
    pub vibrato_depth: f32,
    /// Seconds after note-on before vibrato fades in, the way players let a note speak first.
    pub vibrato_delay: f32,
    /// 0..1: extra damping on the strings (a light left-hand mute).
    pub damping: f32,
    /// 0..1: the string material's high-frequency loss - low is a dark gut string, high bright steel.
    pub brightness: f32,
    /// Instrument size: 0 is a violin body, ~0.13 a viola, ~0.72 a cello, 1 a bass. Values outside
    /// 0..1 keep going (a tiny violino piccolo, a giant octobass).
    pub body_size: f32,
    /// 0..1: how much of the body's radiated sound versus the raw bridge force (an electric,
    /// bodiless string) is heard.
    pub body_mix: f32,
    /// Seconds for the bow to get up to speed / to lift.
    pub attack: f32,
    pub release: f32,
    /// Seconds to hold before releasing. Ignored when the note has a gate (held until note-off).
    pub duration: f32,
    pub articulation: Articulation,
    /// 0..1: after the bow lifts, how freely the note rings on (1) versus being stopped by the bow
    /// and a lifting finger (0).
    pub ring: f32,
    /// Seconds for a slurred (legato) note's finger to slide to its new pitch.
    pub slide: f32,
    /// 0..1: how cleanly the player starts a stroke. A bowed note's first few periods are chaotic -
    /// the string can fall into double slipping or crunch before settling (in this model as on a
    /// real violin: it is why beginners squeak). At 1 the player guides the contact through an
    /// ideal stick-slip cycle for the first few periods (a "perfect attack" in Guettler's sense)
    /// and then lets friction take over completely; at 0 the start is left entirely to the
    /// friction physics.
    pub attack_skill: f32,

    // ---------------------------------------------------------------- construction
    /// Open-string pitches, low to high; unused slots are 0. All zero means a violin.
    pub strings: [f32; MAX_STRINGS],
    /// Sympathetic strings' pitches (0 = none).
    pub sympathetic: [f32; MAX_SYMPATHETIC],
    /// 0..1: string mass/tension (impedance), 0.5 normal. A heavier string needs more bow force and
    /// speaks more slowly.
    pub string_mass: f32,
    /// 0..1: bending stiffness; high values stretch the partials sharp, like a metal bar.
    pub stiffness: f32,
    /// 0..1: rosin character; higher is grippier (larger static/dynamic friction gap), which widens
    /// the playable window and sharpens the attack.
    pub rosin: f32,
    /// 0..1: bow-hair noise (rosin grit).
    pub bow_noise: f32,
    /// 0..1: how strongly the bridge couples strings to the body and to each other (0.35 is a normal
    /// instrument). High values bring out sympathetic ringing - and wolf notes.
    pub coupling: f32,
    /// 0..1: body mode Q, 0.5 normal.
    pub body_resonance: f32,
    /// Picks the body's high-frequency mode field (a different maker, same family).
    pub body_seed: u32,
}

impl Default for PhysModParams {
    fn default() -> Self {
        Self {
            freq: 440.0,
            velocity: 0.8,
            gain: 0.6,
            bow_force: 0.5,
            bow_velocity: 0.5,
            bow_position: 0.12,
            vibrato_rate: 5.5,
            vibrato_depth: 15.0,
            vibrato_delay: 0.15,
            damping: 0.0,
            brightness: 0.5,
            body_size: 0.0,
            body_mix: 0.85,
            attack: 0.06,
            release: 0.15,
            duration: 0.6,
            articulation: Articulation::Arco,
            ring: 0.35,
            slide: 0.06,
            attack_skill: 0.9,
            strings: [0.0; MAX_STRINGS],
            sympathetic: [0.0; MAX_SYMPATHETIC],
            string_mass: 0.5,
            stiffness: 0.0,
            rosin: 0.5,
            bow_noise: 0.15,
            coupling: 0.35,
            body_resonance: 0.5,
            body_seed: 1,
        }
    }
}

/// Body frequency divisor for a `body_size`: 4^size, so 0 -> 1 (violin), 1 -> 4 (bass).
pub fn body_scale(body_size: f32) -> f32 {
    4f32.powf(body_size.clamp(-1.0, 2.5))
}

/// A string's impedance (kg/s) for its open pitch on an instrument of `body_size`: lower strings
/// are heavier, bigger instruments' strings heavier still. Close to the `sqrt(T mu)` figures for
/// real violin (0.16-0.31 kg/s, E to G) through bass strings (~1.4 kg/s on the E).
pub fn string_impedance(open_freq: f32, body_size: f32, string_mass: f32) -> f32 {
    let size = body_scale(body_size);
    let mass = 4f32.powf((string_mass.clamp(0.0, 1.0) - 0.5) * 2.0);
    0.2 * (440.0 / open_freq.max(10.0)).powf(0.55) * size.powf(0.45) * mass
}

/// The instrument's reference impedance: what 0.5 on the force knob is scaled against, so the same
/// knob position is a sensible force on a violin and on a bass. Deliberately *not* the individual
/// string's own impedance - within one instrument, a heavier string (or a heavier `string_mass`)
/// genuinely needs more force, which is part of what the model should teach.
pub fn reference_impedance(body_size: f32) -> f32 {
    string_impedance(330.0, body_size, 0.5)
}

/// Bow speed in m/s for the 0..1 control: 0.03 .. 0.75 m/s, logarithmic.
pub fn bow_speed(knob: f32) -> f32 {
    0.03 * 25f32.powf(knob.clamp(0.0, 1.0))
}

/// Bow force in newtons for the 0..1 control on an instrument of reference impedance `z_ref`:
/// two decades, logarithmic, centred on a normal playing force.
pub fn bow_newtons(knob: f32, z_ref: f32) -> f32 {
    FORCE_AT_MID * (z_ref / 0.23) * 10f32.powf((knob.clamp(0.0, 1.0) - 0.5) * 2.0)
}

/// Force (N) at the middle of the knob on a violin-weight string. Calibrated so that at the default
/// bow speed and position it sits near the geometric middle of the measured playable window (see
/// `tests/physmod_synth_bdd.rs` and the Schelleng measurement in this module's tests).
pub const FORCE_AT_MID: f32 = 0.35;

impl PhysModParams {
    pub fn open_strings(&self) -> ([f32; MAX_STRINGS], usize) {
        let n = self.strings.iter().take_while(|f| **f > 0.0).count();
        if n == 0 { (VIOLIN_TUNING, MAX_STRINGS) } else { (self.strings, n) }
    }

    fn friction(&self) -> FrictionCurve {
        let r = self.rosin.clamp(0.0, 1.0);
        FrictionCurve { mu_s: 0.55 + 0.5 * r, mu_d: 0.3, v0: 0.2 - 0.18 * r }
    }

    fn body_spec(&self) -> BodySpec {
        BodySpec {
            size: body_scale(self.body_size),
            resonance: 4f32.powf((self.body_resonance.clamp(0.0, 1.0) - 0.5) * 2.0),
            coupling: self.coupling.clamp(0.0, 1.0) / 0.35,
            brightness: self.brightness.clamp(0.0, 1.0),
            seed: self.body_seed,
            spread: 0.6,
        }
    }

    fn string_spec(&self, open: f32) -> StringSpec {
        let b = self.brightness.clamp(0.0, 1.0);
        StringSpec {
            open_freq: open,
            impedance: string_impedance(open, self.body_size, self.string_mass),
            // Bigger, heavier strings ring longer.
            t60: 1.6 * body_scale(self.body_size).powf(0.3),
            loss_hz: 2500.0 * 8f32.powf(b),
            stiffness: self.stiffness.clamp(0.0, 1.0),
        }
    }
}

// ------------------------------------------------------------------------------------------
// Live controls for a held note
// ------------------------------------------------------------------------------------------

/// Controls a held note reads every control tick, so a drag in the 3D view, a knob, automation or
/// an AI tool call all steer the same sounding note. Values are the same 0..1 / fraction / cents
/// units as the matching `PhysModParams` fields.
pub struct PhysModLive {
    pub bow_force: AtomicU32,
    pub bow_velocity: AtomicU32,
    pub bow_position: AtomicU32,
    pub vibrato_depth: AtomicU32,
}

impl PhysModLive {
    pub fn from_params(p: &PhysModParams) -> Self {
        Self {
            bow_force: AtomicU32::new(p.bow_force.to_bits()),
            bow_velocity: AtomicU32::new(p.bow_velocity.to_bits()),
            bow_position: AtomicU32::new(p.bow_position.to_bits()),
            vibrato_depth: AtomicU32::new(p.vibrato_depth.to_bits()),
        }
    }

    fn read(&self) -> (f32, f32, f32, f32) {
        (
            f32::from_bits(self.bow_force.load(Ordering::Relaxed)),
            f32::from_bits(self.bow_velocity.load(Ordering::Relaxed)),
            f32::from_bits(self.bow_position.load(Ordering::Relaxed)),
            f32::from_bits(self.vibrato_depth.load(Ordering::Relaxed)),
        )
    }
}

// ------------------------------------------------------------------------------------------
// The per-string player
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// No note: the string rings freely (in sympathy, or the tail of an old note).
    Idle,
    /// The bow is on the string and a note is held.
    Bowing,
    /// The bow is lifting.
    Releasing,
    /// A pluck or strike is in progress / its note is held.
    Plucked,
}

struct Player {
    phase: Phase,
    note_id: u64,
    p: PhysModParams,
    live: Option<Arc<PhysModLive>>,
    /// Base-rate samples left before a timed note releases.
    hold_left: Option<u64>,
    /// Signed bow speed and force actually applied (m/s, N), chasing their targets.
    v_bow: f32,
    f_bow: f32,
    /// Bow direction for the current stroke, +1 down-bow / -1 up-bow.
    dir: f32,
    /// Extra force at the start of a stroke (the "bite" of an accented attack), decaying.
    bite: f32,
    /// Seconds since the current note started (for vibrato onset).
    t_note: f32,
    /// Seconds since release started.
    t_release: f32,
    vib_phase: f32,
    /// Glide coefficient per oversampled tick for the finger (fast for vibrato, slower for slurs).
    glide: f32,
    /// Oversampled ticks into the current pluck/strike, and its shape.
    pluck_t: u32,
    pluck_len: u32,
    pluck_force: f32,
    /// Oversampled ticks since the current stroke began (for the guided attack), or u32::MAX.
    guide_t: u32,
    /// Engine clock (output samples) when the current note began.
    started_at: u64,
    /// The player's intonation correction: a factor on the finger's pitch (see `control`).
    intonation: f32,
    /// Low-passed noise for the bow-hair grit.
    grit_lp: OnePole,
    /// Whether the finger has been lifted after the note ended (the string is back to open).
    finger_lifted: bool,
}

impl Player {
    fn new() -> Self {
        Self {
            phase: Phase::Idle,
            note_id: 0,
            p: PhysModParams::default(),
            live: None,
            hold_left: None,
            v_bow: 0.0,
            f_bow: 0.0,
            dir: 1.0,
            bite: 0.0,
            t_note: 0.0,
            t_release: 0.0,
            vib_phase: 0.0,
            glide: 0.02,
            pluck_t: 0,
            pluck_len: 0,
            pluck_force: 0.0,
            guide_t: u32::MAX,
            started_at: 0,
            intonation: 1.0,
            grit_lp: OnePole::default(),
            finger_lifted: true,
        }
    }

    fn held(&self) -> bool {
        matches!(self.phase, Phase::Bowing) || (self.phase == Phase::Plucked && self.note_id != 0)
    }

    /// The performer controls, from the live handle when there is one.
    fn controls(&self) -> (f32, f32, f32, f32) {
        match &self.live {
            Some(l) => l.read(),
            None => (self.p.bow_force, self.p.bow_velocity, self.p.bow_position, self.p.vibrato_depth),
        }
    }
}

// ------------------------------------------------------------------------------------------
// What the engine reports
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default)]
pub struct StringReport {
    pub open_freq: f32,
    /// The pitch the finger is stopping, Hz.
    pub freq: f32,
    /// Bow contact as a fraction of the vibrating length from the bridge.
    pub beta: f32,
    pub bowed: bool,
    pub sympathetic: bool,
    pub phase_active: bool,
    /// Bow speed (m/s) and force (N) actually applied.
    pub bow_velocity: f32,
    pub bow_force: f32,
    /// Fraction of bowed samples spent sticking since the last report.
    pub stick_fraction: f32,
    /// Stick-to-slip releases per fundamental period since the last report: ~1 is clean Helmholtz
    /// motion; more is multiple slipping (too little force); erratic is raucous (too much).
    pub slips_per_period: f32,
    /// How much the string is vibrating (arbitrary units, for glow).
    pub level: f32,
    /// Where the Schelleng window sits for the current bow speed/position on this string, N.
    pub force_min: f32,
    pub force_max: f32,
}

// ------------------------------------------------------------------------------------------
// The engine
// ------------------------------------------------------------------------------------------

pub struct Engine {
    sr: f32,
    sr_os: f32,
    strings: Vec<BowedString>,
    players: Vec<Player>,
    n_bowed: usize,
    n_symp: usize,
    body: Body,
    instrument: PhysModParams,
    dec_f: Decimator2,
    dec_l: Decimator2,
    dec_r: Decimator2,
    dc_direct: DcBlock,
    dc_l: DcBlock,
    dc_r: DcBlock,
    noise: Noise,
    control_countdown: u32,
    /// Output gain of the most recent note (smoothed).
    gain: f32,
    body_mix: f32,
    /// Running level of the output, for idleness detection.
    out_level: f32,
    pub last_bridge_force: f32,
    /// Accumulated for reports (reset by `report`).
    stats_samples: u32,
    /// Output samples rendered so far.
    clock: u64,
}

/// Gains that put the three output paths at comparable loudness for a mid-register mezzo note
/// (measured, see the calibration test at the bottom of this file).
const COUPLED_OUT: f32 = 140.0;
const RADIATING_OUT: f32 = 4.4;
const DIRECT_OUT: f32 = 1.4;

impl Engine {
    pub fn new(sr: f32, instrument: &PhysModParams) -> Self {
        let sr_os = sr * OVERSAMPLE as f32;
        let (open, n_bowed) = instrument.open_strings();
        let mut strings = Vec::with_capacity(MAX_ALL_STRINGS);
        let mut players = Vec::with_capacity(MAX_ALL_STRINGS);
        for &f in open.iter().take(n_bowed) {
            strings.push(BowedString::new(instrument.string_spec(f), sr_os));
            players.push(Player::new());
        }
        let symp: Vec<f32> = instrument.sympathetic.iter().copied().filter(|f| *f > 0.0).collect();
        for &f in &symp {
            let mut spec = instrument.string_spec(f);
            // Sympathetic strings are thin and lightly loaded.
            spec.impedance *= 0.5;
            strings.push(BowedString::new(spec, sr_os));
            players.push(Player::new());
        }
        let mut e = Self {
            sr,
            sr_os,
            n_bowed,
            n_symp: symp.len(),
            strings,
            players,
            body: Body::new(instrument.body_spec(), sr_os, sr),
            instrument: *instrument,
            dec_f: Decimator2::new(),
            dec_l: Decimator2::new(),
            dec_r: Decimator2::new(),
            dc_direct: DcBlock::default(),
            dc_l: DcBlock::default(),
            dc_r: DcBlock::default(),
            noise: Noise(0x1234_5678),
            control_countdown: 0,
            gain: instrument.gain,
            body_mix: instrument.body_mix,
            out_level: 0.0,
            last_bridge_force: 0.0,
            stats_samples: 0,
            clock: 0,
        };
        e.apply_construction(instrument);
        e
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    /// Whether this engine was built for the same set of strings (count and tuning) as `p` asks
    /// for. When it wasn't, a caller should build a new engine rather than reuse this one.
    pub fn same_strings(&self, p: &PhysModParams) -> bool {
        let (open, n) = p.open_strings();
        let symp: Vec<f32> = p.sympathetic.iter().copied().filter(|f| *f > 0.0).collect();
        n == self.n_bowed && symp.len() == self.n_symp && open.iter().take(n).zip(self.strings.iter()).all(|(f, s)| (f - s.spec.open_freq).abs() < 1.0e-3) && symp.iter().zip(self.strings[self.n_bowed..].iter()).all(|(f, s)| (f - s.spec.open_freq).abs() < 1.0e-3)
    }

    /// Takes the instrument-level settings (body, string construction, rosin) from `p`. Safe on
    /// the audio thread.
    fn apply_construction(&mut self, p: &PhysModParams) {
        self.instrument = *p;
        let spec = p.body_spec();
        if spec != self.body.spec {
            self.body.configure(spec);
        }
        let curve = p.friction();
        for (i, s) in self.strings.iter_mut().enumerate() {
            let open = s.spec.open_freq;
            let mut spec = p.string_spec(open);
            if i >= self.n_bowed {
                spec.impedance *= 0.5;
            }
            s.set_spec(spec);
            s.set_friction(curve);
        }
    }

    pub fn string_count(&self) -> (usize, usize) {
        (self.n_bowed, self.n_symp)
    }

    pub fn string(&self, i: usize) -> &BowedString {
        &self.strings[i]
    }

    pub fn body(&self) -> &Body {
        &self.body
    }

    /// Which string a note of `freq` goes to (see the module doc).
    pub fn choose_string(&self, freq: f32) -> usize {
        // No allocation: this runs on the audio thread when notes arrive through a live voice.
        let reach = |i: usize| self.strings[i].spec.open_freq <= freq * 1.0005;
        let Some(highest) = (0..self.n_bowed).rev().find(|&i| reach(i)) else { return 0 };
        // Highest reachable string that is free, else slur on the highest reachable one.
        (0..=highest).rev().find(|&i| !self.players[i].held()).unwrap_or(highest)
    }

    /// The highest string that can reach `freq`, busy or not.
    fn highest_reaching(&self, freq: f32) -> usize {
        (0..self.n_bowed).rev().find(|&i| self.strings[i].spec.open_freq <= freq * 1.0005).unwrap_or(0)
    }

    /// Starts a note. `id` is the caller's handle for `note_off` (0 means "no handle": the note must
    /// be timed by `p.duration`). Returns the string it went to.
    pub fn note_on(&mut self, id: u64, p: PhysModParams, gated: bool, live: Option<Arc<PhysModLive>>) -> usize {
        self.apply_construction(&p);
        self.gain = p.gain;
        self.body_mix = p.body_mix.clamp(0.0, 1.0);
        let sr = self.sr;
        let now = self.clock;

        // Chord or slur? A note that arrives while another bowed note is held is a double stop if
        // it comes (nearly) with it, and a slur - the bow keeps going - if it comes later, the
        // way overlapping notes are played legato on a monophonic MIDI instrument.
        let prev = (0..self.n_bowed).filter(|&i| self.players[i].phase == Phase::Bowing && self.players[i].note_id != 0).max_by_key(|&i| self.players[i].started_at);
        let chord = prev.is_some_and(|i| now.saturating_sub(self.players[i].started_at) < (CHORD_WINDOW * sr) as u64);
        let slur_from = if p.articulation == Articulation::Arco && !chord { prev } else { None };
        let s = if slur_from.is_some() { self.highest_reaching(p.freq) } else { self.choose_string(p.freq) };
        // A slur onto another string is a string crossing: the bow leaves the old string (which
        // rings on) and carries on, same direction, on the new one.
        let mut carried_dir = None;
        if let Some(from) = slur_from.filter(|&f| f != s) {
            carried_dir = Some(self.players[from].dir);
            Self::begin_release(&mut self.players[from]);
        }
        let pl = &mut self.players[s];
        pl.started_at = now;
        let legato = slur_from == Some(s);
        let reverse = !legato && carried_dir.is_none() && (matches!(pl.phase, Phase::Bowing | Phase::Releasing) || pl.v_bow.abs() > 1.0e-3);
        if let Some(d) = carried_dir {
            pl.dir = d;
        }
        pl.p = p;
        pl.live = live;
        pl.note_id = id;
        pl.hold_left = if gated { None } else { Some((p.duration.max(0.0) * sr) as u64) };
        pl.finger_lifted = false;
        pl.t_release = 0.0;
        let string = &mut self.strings[s];
        string.set_extra_damping(p.damping);

        let slide_secs = if legato { p.slide.max(0.002) } else { 0.0015 };
        pl.glide = 1.0 - (-1.0 / (slide_secs * self.sr_os / 3.0)).exp();

        match p.articulation {
            Articulation::Arco => {
                pl.phase = Phase::Bowing;
                if !legato {
                    pl.t_note = 0.0;
                    if reverse {
                        pl.dir = -pl.dir;
                    }
                    // Accents: a harder note-on bites into the string with extra initial force
                    // (not on a string crossing inside a slur, which is smooth by intent).
                    pl.bite = if carried_dir.is_some() { 0.0 } else { 0.8 * p.velocity.clamp(0.0, 1.0).powi(2) };
                    pl.guide_t = 0;
                }
                string.retune(p.freq, p.bow_position);
                if !legato && string.level < 1.0e-4 {
                    string.snap();
                }
            }
            Articulation::Pizzicato | Articulation::ColLegno => {
                pl.phase = Phase::Plucked;
                pl.t_note = 0.0;
                pl.v_bow = 0.0;
                pl.f_bow = 0.0;
                string.retune(p.freq, p.bow_position.max(0.08));
                string.snap();
                let dyn_ = 0.25 + 0.75 * p.velocity.clamp(0.0, 1.0);
                let z = string.spec.impedance;
                if p.articulation == Articulation::Pizzicato {
                    // The finger pulls the string aside (force building over a few ms) then lets go.
                    pl.pluck_len = (0.006 * self.sr_os) as u32;
                    pl.pluck_force = 6.0 * z * dyn_;
                } else {
                    // The bow stick's wood: a hard, very short hit.
                    pl.pluck_len = (0.0006 * self.sr_os) as u32;
                    pl.pluck_force = 30.0 * z * dyn_;
                }
                pl.pluck_t = 0;
            }
        }
        s
    }

    /// Releases the note started with `id` (if it is still the note on its string).
    pub fn note_off(&mut self, id: u64) {
        if id == 0 {
            return;
        }
        for pl in self.players.iter_mut() {
            if pl.note_id == id {
                Self::begin_release(pl);
            }
        }
    }

    fn begin_release(pl: &mut Player) {
        pl.note_id = 0;
        pl.hold_left = None;
        pl.t_release = 0.0;
        if pl.phase == Phase::Bowing {
            pl.phase = Phase::Releasing;
        }
        // A plucked note has nothing to lift; the finger lifting is handled in `control`.
    }

    /// Releases everything.
    pub fn all_notes_off(&mut self) {
        for pl in self.players.iter_mut() {
            if pl.phase != Phase::Idle {
                Self::begin_release(pl);
            }
        }
    }

    /// True when no note is held or releasing and everything has rung down to silence.
    pub fn is_silent(&self) -> bool {
        self.players.iter().all(|p| p.phase == Phase::Idle) && self.out_level < 2.0e-5
    }

    /// True while any note is held (bowing or a held pluck) or a bow is still lifting.
    pub fn is_playing(&self) -> bool {
        self.players.iter().any(|p| p.phase != Phase::Idle)
    }

    /// Control-rate update for one string's player: targets for the bow, the finger, vibrato, and
    /// the release/finger-lift sequence.
    fn control(&mut self, s: usize, dt: f32) {
        let pl = &mut self.players[s];
        let string = &mut self.strings[s];
        if pl.phase == Phase::Idle {
            // Back to open once the old note has rung down (unless it is meant to ring).
            if !pl.finger_lifted && (string.level < 2.0e-4 || pl.p.ring < 0.999) {
                let quiet = string.level < 2.0e-4;
                if quiet {
                    string.set_extra_damping(pl.p.damping);
                    let open = string.spec.open_freq;
                    string.retune(open, string.beta());
                    string.snap();
                    pl.finger_lifted = true;
                } else {
                    // The note is over: a lifting finger (or the resting bow) damps what is left,
                    // more the lower `ring` is. Open strings have no finger to lift, so they ring
                    // on longer at the same setting.
                    let stopped = string.stopped();
                    let d = (1.0 - pl.p.ring.clamp(0.0, 1.0)).powf(0.3) * if stopped { 0.95 } else { 0.6 };
                    string.set_extra_damping(pl.p.damping.max(d));
                }
            }
            return;
        }
        pl.t_note += dt;
        if let Some(left) = pl.hold_left.as_mut() {
            *left = left.saturating_sub(CONTROL_EVERY as u64);
            if *left == 0 {
                Self::begin_release(pl);
            }
        }
        let (force_knob, speed_knob, beta, vib_depth) = pl.controls();
        let p = pl.p;

        // Finger: pitch with delayed-onset vibrato (none on an open string - there is no finger).
        let stopped_note = p.freq > string.spec.open_freq * 1.0005;
        let vib_on = ((pl.t_note - p.vibrato_delay) / 0.35).clamp(0.0, 1.0);
        pl.vib_phase = (pl.vib_phase + p.vibrato_rate.max(0.0) * dt).fract();
        let cents = if stopped_note && matches!(pl.phase, Phase::Bowing | Phase::Plucked) { vib_depth * vib_on * (TAU * pl.vib_phase).sin() } else { 0.0 };
        // The player's ear: while the string is in Helmholtz motion, compare the period it is
        // actually vibrating at with the one the note wants, and ease the finger to fix it - the
        // way a violinist corrects intonation by ear. It matters because the bowed pitch is not
        // exactly the free string's: in this model the friction sharpens a clean stroke by a few
        // cents (up to ~10 at the top of the E string), heavy force flattens it.
        let wanted = p.freq * 2f32.powf(cents / 1200.0);
        // (Only for stopped notes: an open string has no finger to move.)
        if pl.phase == Phase::Bowing && stopped_note && string.period_estimate > 0.0 && string.helmholtz_confidence > 0.9 {
            let actual_freq = string.sample_rate() / string.period_estimate;
            let err = (wanted / actual_freq).ln();
            pl.intonation = (pl.intonation * (err * dt / INTONATION_TAU).exp()).clamp(0.97, 1.03);
        } else if pl.phase != Phase::Bowing {
            pl.intonation = 1.0;
        }
        let freq = wanted * pl.intonation;
        if (freq - string.freq()).abs() > 1.0e-4 * freq || (beta - string.beta()).abs() > 1.0e-4 {
            string.retune(freq, beta);
        }

        // Bow targets. Dynamics scale speed and force together (see `PhysModParams::velocity`).
        let dyn_ = 0.3 + 0.7 * p.velocity.clamp(0.0, 1.0);
        let v_target_mag = bow_speed(speed_knob) * dyn_;
        // Force is scaled per string by its *nominal* weight (a player leans harder on the G than
        // the E without thinking about it), but not by the `string_mass` construction setting - a
        // string made heavier in the lab genuinely needs more force, and should be heard to.
        let z_nominal = string_impedance(string.spec.open_freq, self.instrument.body_size, 0.5);
        let f_target_mag = bow_newtons(force_knob, z_nominal) * dyn_;
        let attack = p.attack.max(0.003);
        let release = p.release.max(0.01);
        let ring = p.ring.clamp(0.0, 1.0);
        let (v_target, f_target, tau_v, tau_f) = match pl.phase {
            // Speed ramps up over the attack; force arrives faster (plus any accent bite), so the
            // bow is gripping by the time it is moving.
            Phase::Bowing => (pl.dir * v_target_mag, f_target_mag * (1.0 + pl.bite), attack / 3.0, attack / 6.0),
            // Lifting: with a ringing release the bow leaves while still moving (force first);
            // with a stopped release the bow stops on the string and damps it (speed first).
            Phase::Releasing => (0.0, 0.0, release * (0.25 + 0.75 * ring), release * (1.0 - 0.75 * ring)),
            _ => (0.0, 0.0, 0.01, 0.01),
        };
        pl.bite *= (-dt / attack.max(0.02)).exp();
        let kv = 1.0 - (-dt / tau_v.max(1.0e-4)).exp();
        let kf = 1.0 - (-dt / tau_f.max(1.0e-4)).exp();
        pl.v_bow += (v_target - pl.v_bow) * kv;
        pl.f_bow += (f_target - pl.f_bow) * kf;

        if pl.phase == Phase::Releasing {
            pl.t_release += dt;
            if pl.t_release > release * 1.2 || (pl.f_bow < 1.0e-4 && pl.v_bow.abs() < 1.0e-4) {
                pl.phase = Phase::Idle;
                pl.f_bow = 0.0;
                pl.v_bow = 0.0;
            }
        }
        if pl.phase == Phase::Plucked && pl.note_id == 0 && pl.hold_left.is_none() && pl.pluck_t >= pl.pluck_len {
            pl.phase = Phase::Idle;
        }
    }

    /// Renders one output frame (left, right).
    pub fn next_frame(&mut self) -> [f32; 2] {
        self.clock += 1;
        if self.control_countdown == 0 {
            let dt = CONTROL_EVERY as f32 / self.sr;
            for s in 0..self.n_bowed {
                self.control(s, dt);
            }
            self.control_countdown = CONTROL_EVERY;
        }
        self.control_countdown -= 1;

        let n_all = self.strings.len();
        let bow_noise = self.instrument.bow_noise.clamp(0.0, 1.0);
        let grit_a = OnePole::coef_for(1800.0, self.sr_os);
        let mut forces = [0.0f32; OVERSAMPLE];
        let mut cl = [0.0f32; OVERSAMPLE];
        let mut cr = [0.0f32; OVERSAMPLE];
        for k in 0..OVERSAMPLE {
            let v_bridge = self.body.bridge_velocity;
            let mut total = 0.0;
            for s in 0..n_all {
                let mut ex = Excitation::default();
                let mut glide = 0.02;
                if s < self.n_bowed {
                    let pl = &mut self.players[s];
                    glide = pl.glide;
                    if pl.f_bow > 0.0 {
                        let n = self.noise.bipolar();
                        let grit = pl.grit_lp.process(n, grit_a);
                        ex.bow_force = pl.f_bow * (1.0 + bow_noise * 1.2 * grit).max(0.0);
                        ex.bow_velocity = pl.v_bow;
                    }
                    if pl.guide_t != u32::MAX {
                        // The guided attack: an ideal Helmholtz stick-slip cycle at the bow point
                        // (stuck to the bow for 1 - beta of each period, one smooth slip pulse for
                        // beta of it, zero mean), imposed for GUIDE_PERIODS then faded out.
                        let string = &self.strings[s];
                        let period = self.sr_os / string.freq();
                        let beta = string.beta();
                        let n_per = pl.guide_t as f32 / period;
                        let w = pl.p.attack_skill.clamp(0.0, 1.0) * (1.0 - (n_per - GUIDE_PERIODS) / GUIDE_FADE).clamp(0.0, 1.0);
                        if w <= 0.0 || pl.phase != Phase::Bowing {
                            pl.guide_t = u32::MAX;
                        } else {
                            let frac = n_per.fract();
                            let vb = pl.v_bow;
                            let stuck = frac < 1.0 - beta;
                            let v = if stuck {
                                vb
                            } else {
                                // A flat-topped slip with short ramps (an ideal Helmholtz slip
                                // is flat; the ramps only keep it band-limited), scaled so the
                                // cycle's mean velocity is zero.
                                let x = (frac - (1.0 - beta)) / beta;
                                let shape = (x.min(1.0 - x) / GUIDE_RAMP).clamp(0.0, 1.0);
                                vb - vb / (beta * (1.0 - GUIDE_RAMP)) * shape
                            };
                            ex.guide_velocity = v;
                            ex.guide_weight = w;
                            ex.guide_stuck = stuck;
                            pl.guide_t += 1;
                        }
                    }
                    if pl.pluck_t < pl.pluck_len {
                        let t = pl.pluck_t as f32 / pl.pluck_len as f32;
                        ex.external_force = match pl.p.articulation {
                            // A ramp then a sudden let-go (the step is what launches the wave).
                            Articulation::Pizzicato => pl.pluck_force * t,
                            _ => pl.pluck_force * (std::f32::consts::PI * t).sin(),
                        };
                        pl.pluck_t += 1;
                    }
                }
                total += self.strings[s].tick(ex, v_bridge, glide);
            }
            forces[k] = total;
            let (l, r) = self.body.tick_coupled(total);
            cl[k] = l;
            cr[k] = r;
        }
        self.stats_samples += 1;
        let f = self.dec_f.process(forces[0], forces[1]);
        let cl = self.dec_l.process(cl[0], cl[1]);
        let cr = self.dec_r.process(cr[0], cr[1]);
        self.last_bridge_force = f;
        let (rl, rr) = self.body.tick_radiating(f);
        let direct = self.dc_direct.process(f, 0.9995) * DIRECT_OUT;
        let mix = self.body_mix;
        let l = mix * (cl * COUPLED_OUT + rl * RADIATING_OUT) + (1.0 - mix) * direct;
        let r = mix * (cr * COUPLED_OUT + rr * RADIATING_OUT) + (1.0 - mix) * direct;
        // Bridge force grows with string impedance; normalise by the instrument's reference weight so
        // a bass is not 15 dB louder than a violin at the same settings.
        let norm = self.gain * 0.23 / reference_impedance(self.instrument.body_size);
        let l = self.dc_l.process(l, 0.9995) * norm;
        let r = self.dc_r.process(r, 0.9995) * norm;
        self.out_level += (l.abs().max(r.abs()) - self.out_level) * 0.002;
        [l.clamp(-4.0, 4.0), r.clamp(-4.0, 4.0)]
    }

    /// Per-string state for visualization and tests. Resets the contact statistics.
    pub fn report(&mut self, out: &mut [StringReport; MAX_ALL_STRINGS]) -> usize {
        let curve = self.instrument.friction();
        for (i, s) in self.strings.iter_mut().enumerate() {
            let bowed = i < self.n_bowed;
            let (active, v, f) = if bowed {
                let pl = &self.players[i];
                (pl.phase != Phase::Idle, pl.v_bow, pl.f_bow)
            } else {
                (false, 0.0, 0.0)
            };
            let st = s.stats;
            let secs = st.samples as f32 / self.sr_os;
            let periods = (secs * s.freq()).max(1.0e-6);
            let (fmin, fmax) = schelleng_window(v.abs().max(1.0e-4), s.beta(), s.spec.impedance, &curve, s.freq());
            out[i] = StringReport {
                open_freq: s.spec.open_freq,
                freq: s.freq(),
                beta: s.beta(),
                bowed,
                sympathetic: !bowed,
                phase_active: active,
                bow_velocity: v,
                bow_force: f,
                stick_fraction: if st.samples > 0 { st.stuck as f32 / st.samples as f32 } else { 0.0 },
                slips_per_period: if st.samples > 0 { st.releases as f32 / periods } else { 0.0 },
                level: s.level,
                force_min: fmin,
                force_max: fmax,
            };
            s.stats = Default::default();
        }
        self.stats_samples = 0;
        self.strings.len()
    }

    /// The coupled body modes' frequencies and current ringing levels.
    pub fn body_modes(&self) -> ([f32; COUPLED_MODES], [f32; COUPLED_MODES]) {
        let f = self.body.mode_frequencies();
        let mut e = [0.0; COUPLED_MODES];
        for (i, v) in e.iter_mut().enumerate() {
            *v = self.body.mode_energy(i);
        }
        (f, e)
    }

    /// Shape of string `i` (see `BowedString::shape`).
    pub fn string_shape(&self, i: usize, out: &mut [f32]) {
        if let Some(s) = self.strings.get(i) {
            s.shape(out);
        }
    }

    /// Which string (if any) is playing note `id`.
    pub fn string_of(&self, id: u64) -> Option<usize> {
        self.players.iter().position(|p| p.note_id == id && id != 0)
    }
}

/// Schelleng's playable window for bow speed `v_b` (m/s) at relative position `beta` on a string of
/// impedance `z` sounding `freq`: the least bow force (N) that sustains Helmholtz motion, and the most
/// before it breaks into raucous motion.
///
/// The shapes are Schelleng's - `F_max ~ 2 Z v_b / (beta (mu_s - mu_d))`, `F_min ~ Z^2 v_b / (beta^2
/// R (mu_s - mu_d))` - with the constants (and the frequency dependence standing in for the loss
/// resistance `R`) fitted to what this model actually does: 90 measured windows across the four
/// violin strings, five bow positions and three bow speeds (steady-state stick/slip classification,
/// see the `window` sweep described in `docs/PHYS_MOD_SYNTH.md`). Fitting the exponents freely gave
/// `F_min ~ beta^-1.9` and `F_max ~ beta^-1.2`, against Schelleng's -2 and -1. The fit is to within
/// about x1.2 for the minimum and x1.6 for the maximum, which is what the view's diagram shows.
pub fn schelleng_window(v_b: f32, beta: f32, z: f32, curve: &FrictionCurve, freq: f32) -> (f32, f32) {
    let dmu = (curve.mu_s - curve.mu_d).max(0.05);
    let beta = beta.clamp(0.01, 0.5);
    let f = freq.max(10.0);
    let v = v_b.max(1.0e-4);
    let f_max = 0.5 * 2.0 * z * v / (beta * dmu) * (440.0 / f).powf(0.67);
    let f_min = 0.0547 * z * z * v.powf(1.5) / (beta * beta * dmu) * (440.0 / f);
    (f_min, f_max)
}
