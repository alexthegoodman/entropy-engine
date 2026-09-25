//! The brass instrument and its player: one air column, one pair of lips, and the small virtual
//! player who turns notes into slide positions, lip settings, breath and tonguing.
//!
//! Every note has to be *found*. For a target pitch the player picks a resonance (a partial) and a
//! slide position that together give it, from the instrument's own resonances (the reference
//! impedance in `impedance`, computed once per instrument). They set their lips a little below that
//! resonance - how far below depends on how hard they blow, by a law fitted from sweeps of this
//! model (`lip_center`) - give the air column the breath, and let the tongue go. What sounds is up
//! to the physics: a player who sets up badly (`attack_skill` low) can land on the neighbouring
//! partial, as real players crack notes. Once the note speaks, the player listens to its pitch and
//! eases the slide to put it in tune, as trombonists do.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use super::airbore::AirBore;
use super::bore::{BoreProfile, Obstruction};
use super::impedance::Reference;
use super::lips::{LipSpec, Lips};
use crate::audio::physmod::dsp::{DcBlock, Decimator2, Noise, OnePole};

/// The model runs at twice the engine rate (cells then stand for ~3.9 mm of bore).
pub const OVERSAMPLE: usize = 2;
/// Player decisions every this many output samples.
const CONTROL_EVERY: u32 = 32;
/// Mouth pressure range of the breath control, Pa: the knob is logarithmic between them.
pub const PRESSURE_MIN: f32 = 500.0;
pub const PRESSURE_MAX: f32 = 16000.0;
/// The radiated far-field pressure (Pa at 1 m) that maps to full scale before `gain`.
pub const OUTPUT_REF: f32 = 12.0;
/// The highest resonance kept in an instrument's table (a horn plays up to its 16th partial).
const HIGHEST_PARTIAL: usize = 16;
/// How far (cents) a valved player can trim a note with valve slides and lipping - the slide's
/// continuous travel is the trombone's alone.
const VALVE_TRIM_CENTS: f32 = 45.0;
/// Cents of preference against each valve pressed, all else equal (players use the simplest
/// fingering that is in tune).
const VALVE_COST_CENTS: f32 = 4.0;
/// Cents first position is left sharp by the tuning slide (room to tune by extending).
const FIRST_POSITION_HEADROOM: f32 = 25.0;
/// How far above a first-position resonance a note can still be played there (lipped up).
const FIRST_POSITION_LIP_UP: f32 = 1.03;
/// How firmly the guide holds the lips each tick (at full strength, before fading).
const GUIDE_STRENGTH: f32 = 0.05;
/// Periods of the note the lips are guided through at the start (at `attack_skill` 1).
const GUIDE_PERIODS: f32 = 6.0;
/// Lips are bent this many cents per cent the note has to come up (the pitch follows the lips only
/// weakly - about a sixth - which is why a note can only be lipped up a little).
const LIP_BEND_RATIO: f32 = 6.0;
/// A settled note this far (cents) from the one meant has cracked onto a neighbouring partial.
const REFIND_CENTS: f32 = 100.0;
/// How far toward the meant partial the lips move per try, as a share of the interval heard.
const REFIND_SHARE: f32 = 0.6;
/// Tries a fully skilled player makes to find a cracked note.
const REFIND_TRIES: u32 = 3;
/// A note counts as speaking once the mouthpiece's AC pressure is this fraction of the breath.
const SPEAKING_LEVEL: f32 = 0.15;
/// Slide or valve extensions in the resonance table.
const TABLE_STEPS: usize = 49;

// ------------------------------------------------------------------------------------------
// Fitted laws
// ------------------------------------------------------------------------------------------

/// Where the player sets their lip resonance for a note on a resonance of `peak_hz`, blowing
/// `pressure` Pa. Fitted from sweeps of this model over partials 2-12 and 0.7-12 kPa (with the lip
/// mass following `lip_mass`): the lip frequencies that lock onto a resonance when a note starts
/// form a window - the "slot" brass players talk about - roughly ±8% wide, centred at about 0.85 of
/// the resonance at *pp* and moving down as `pressure^-0.073`, about the same for every partial.
/// Notes speak fastest a little above the centre, so the player aims 3% high.
pub fn lip_center(peak_hz: f32, pressure: f32) -> f32 {
    peak_hz * 0.875 * (pressure.max(100.0) / 700.0).powf(-0.073)
}

/// How much of the lips vibrates for a note at `hz`, kg/m²: more lip in the mouthpiece for low
/// notes, less for high ones (keeping the lips' stiffness about constant). With one mass for every
/// note, low partials refuse to sound loudly and high ones softly; with the mass following
/// `1 / f²` every partial of the trombone plays from *pp* to *fff*.
pub fn lip_mass(hz: f32) -> f32 {
    (3.0 * (233.0 / hz.max(20.0)).powi(2)).clamp(0.5, 20.0)
}

/// How far above its resonance a note sounds, cents (a first guess the player refines by ear).
/// The one-mass outward-striking lip plays sharp of the air column, by about 80 cents on the low
/// partials and 55 on the higher ones, a little more when blown harder.
pub fn sounding_offset(partial: usize, pressure: f32) -> f32 {
    let base = if partial <= 5 { 75.0 } else { 55.0 };
    base + 6.0 * (pressure.max(100.0) / 700.0).log2()
}

/// Mouth pressure for a 0..1 breath knob, Pa.
pub fn breath_pressure(knob: f32) -> f32 {
    PRESSURE_MIN * (PRESSURE_MAX / PRESSURE_MIN).powf(knob.clamp(0.0, 1.0))
}

// ------------------------------------------------------------------------------------------
// Parameters
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrassInstrument {
    TenorTrombone,
    Trumpet,
    /// A double horn: the B♭ side, and the F side through the thumb valve.
    Horn,
    Tuba,
}

/// How an instrument changes its tube length.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mechanism {
    /// A slide: any length up to the profile's `slide_max`.
    Slide,
    /// Valves, each switching in the tube that lowers the open instrument by so many semitones
    /// (combinations simply add their tubes, so they come out sharp, as on real valves). A double
    /// horn's F side is another "valve" of five semitones whose own valves are longer.
    Valves { semitones: &'static [f32], f_side: bool },
}

impl BrassInstrument {
    pub const ALL: [BrassInstrument; 4] = [Self::TenorTrombone, Self::Trumpet, Self::Horn, Self::Tuba];

    pub fn profile(self) -> BoreProfile {
        match self {
            Self::TenorTrombone => BoreProfile::tenor_trombone(),
            Self::Trumpet => BoreProfile::trumpet(),
            Self::Horn => BoreProfile::horn(),
            Self::Tuba => BoreProfile::tuba(),
        }
    }
    pub fn lips(self) -> LipSpec {
        match self {
            Self::TenorTrombone => LipSpec::trombone(),
            Self::Trumpet => LipSpec { width: 0.009, ..LipSpec::trombone() },
            Self::Horn => LipSpec { width: 0.009, ..LipSpec::trombone() },
            Self::Tuba => LipSpec { width: 0.018, ..LipSpec::trombone() },
        }
    }
    pub fn mechanism(self) -> Mechanism {
        match self {
            Self::TenorTrombone => Mechanism::Slide,
            Self::Trumpet => Mechanism::Valves { semitones: &[2.0, 1.0, 3.0], f_side: false },
            Self::Horn => Mechanism::Valves { semitones: &[2.0, 1.0, 3.0], f_side: true },
            Self::Tuba => Mechanism::Valves { semitones: &[2.0, 1.0, 3.0, 5.0], f_side: false },
        }
    }
    /// The partials the player uses: a tuba's conical bore makes its fundamental playable; a horn
    /// plays high in its series.
    pub fn partials(self) -> (usize, usize) {
        match self {
            Self::TenorTrombone => (2, 12),
            Self::Trumpet => (2, 10),
            Self::Horn => (2, 16),
            Self::Tuba => (1, 9),
        }
    }
    /// Where this instrument's slots sit relative to `lip_center` (which was fitted on the
    /// trombone): the same sweep on each instrument puts a trumpet's and a horn's slots lower -
    /// their narrower mouthpieces and lips - and a tuba's lowest partials lower. Fitted at 1, 3 and
    /// 8 kPa over partials 2-12.
    pub fn lip_aim(self, partial: usize) -> f32 {
        match self {
            Self::TenorTrombone => 1.0,
            Self::Trumpet => 0.94,
            Self::Horn => if partial <= 6 { 0.97 } else { 0.92 },
            Self::Tuba => if partial <= 2 { 0.88 } else { 1.0 },
        }
    }

    /// Where the bell points, 0 (away from the listener) .. 0.5 (sideways: the radiated power
    /// alone) .. 1 (straight at the listener): trombones and trumpets forward, a horn backward past
    /// the player, a tuba up.
    pub fn default_bell_facing(self) -> f32 {
        match self {
            Self::TenorTrombone => 0.55,
            Self::Trumpet => 0.6,
            Self::Horn => 0.15,
            Self::Tuba => 0.35,
        }
    }
    /// How far into the bell the player's hand is by default (a horn player's hand always is).
    pub fn default_hand(self) -> f32 {
        match self {
            Self::Horn => 0.35,
            _ => 0.0,
        }
    }
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "trombone" | "tenorTrombone" => Some(Self::TenorTrombone),
            "trumpet" => Some(Self::Trumpet),
            "horn" | "frenchHorn" => Some(Self::Horn),
            "tuba" => Some(Self::Tuba),
            _ => None,
        }
    }

    /// A stable number for publishing (see `from_index`).
    pub fn index(self) -> u32 {
        match self {
            Self::TenorTrombone => 0,
            Self::Trumpet => 1,
            Self::Horn => 2,
            Self::Tuba => 3,
        }
    }

    pub fn from_index(i: u32) -> Self {
        match i {
            1 => Self::Trumpet,
            2 => Self::Horn,
            3 => Self::Tuba,
            _ => Self::TenorTrombone,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::TenorTrombone => "trombone",
            Self::Trumpet => "trumpet",
            Self::Horn => "horn",
            Self::Tuba => "tuba",
        }
    }
}

/// A mute in the bell. Its cork seal narrows the bell (an `Obstruction`, so it moves the
/// resonances as a real mute does); the mute's own body then colours what leaves it - that part is
/// a filter on the radiated sound for now (see `docs/PHYS_MOD_BRASS.md`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mute {
    #[default]
    Open,
    Straight,
    Cup,
    Harmon,
}

impl Mute {
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "open" | "none" => Some(Self::Open),
            "straight" => Some(Self::Straight),
            "cup" => Some(Self::Cup),
            "harmon" => Some(Self::Harmon),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Straight => "straight",
            Self::Cup => "cup",
            Self::Harmon => "harmon",
        }
    }
    pub fn index(self) -> u32 {
        match self {
            Self::Open => 0,
            Self::Straight => 1,
            Self::Cup => 2,
            Self::Harmon => 3,
        }
    }
    pub fn from_index(i: u32) -> Self {
        match i {
            1 => Self::Straight,
            2 => Self::Cup,
            3 => Self::Harmon,
            _ => Self::Open,
        }
    }
}

/// What narrows the bell for a mute or a hand. `bell` is the mouth radius (mutes are sized to
/// the bell); a mute is used in preference to the hand if both are given.
pub fn obstruction(mute: Mute, hand: f32, bell: f32) -> Option<Obstruction> {
    let s = bell / 0.108;
    match mute {
        // Corks seal all but a thin ring: what is left is a fraction of the radius there.
        Mute::Straight => Some(Obstruction { from_mouth: 0.14 * s, length: 0.025 * s, open: 0.35 }),
        Mute::Cup => Some(Obstruction { from_mouth: 0.10 * s, length: 0.03 * s, open: 0.5 }),
        Mute::Harmon => Some(Obstruction { from_mouth: 0.13 * s, length: 0.025 * s, open: 0.28 }),
        // The hand sits in the bell's throat, about 10 cm in on a horn; fully in, it all but seals
        // it. Stopped this way the horn's upper resonances each get a neighbour about a semitone
        // above them (measured on the reference: +100..+145 cents for partials 9-16) - the reason a
        // stopped note, played with the same lips, comes out a semitone high.
        Mute::Open if hand > 0.01 => Some(Obstruction { from_mouth: 0.07 * s, length: 0.042 * s, open: 1.0 - 0.8 * hand.clamp(0.0, 1.0) }),
        Mute::Open => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Articulation {
    /// "ta": the tongue stops the air and lets it go.
    Tongued,
    /// A slur: no tongue. Between slide positions a soft "da" keeps it from sounding as a smear,
    /// the way trombonists slur; between partials on one position it is a lip slur.
    Legato,
    /// A slur with no tongue at all: the slide's glide is heard.
    Glissando,
}

impl Articulation {
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "tongued" => Some(Self::Tongued),
            "legato" => Some(Self::Legato),
            "glissando" | "gliss" => Some(Self::Glissando),
            _ => None,
        }
    }
}

/// Everything a note is played with.
#[derive(Clone, Copy, Debug)]
pub struct BrassParams {
    pub freq: f32,
    /// 0..1: MIDI velocity, read as dynamics (it moves the breath around the `breath` setting).
    pub velocity: f32,
    pub gain: f32,
    /// 0..1: mouth pressure on a logarithmic scale from 0.5 kPa (0) to 16 kPa (1); 0.5 is about
    /// 2.8 kPa, a comfortable *mezzo*. Higher is louder and - past a few kPa, as the wave in the
    /// bore steepens toward a shock - much brighter.
    pub breath: f32,
    /// -1..1: the lips' tension relative to where the player would set them for the note. Low is
    /// loose and dark and falls toward the partial below; high is pinched and pops up to the next.
    pub lip_tension: f32,
    /// 0..1: the lips' rest opening; small is focused, large is airy and fat. 0.5 is normal.
    pub aperture: f32,
    pub vibrato_rate: f32,
    /// Cents (slide vibrato on the trombone).
    pub vibrato_depth: f32,
    pub vibrato_delay: f32,
    /// Seconds for the tongue to release the air: a few milliseconds is a clean "ta"; tens of
    /// milliseconds a soft "da" or a breath attack.
    pub attack: f32,
    pub release: f32,
    /// Seconds to hold before releasing. Ignored when the note has a gate.
    pub duration: f32,
    pub articulation: Articulation,
    /// 0..1: how precisely the player starts a note. Two things, as with the bow's `attack_skill`:
    /// a player who hears the note before playing it starts the lips buzzing at its pitch - at 1
    /// the lips are guided through that buzz for the first few periods and then left entirely to
    /// the physics, so the note speaks at once; at 0 they start from rest at their own resonance
    /// and the air column has to pull them round (a slow bloom). And the lip setting: at 1 it is
    /// in the note's slot; lower, it misses by up to ~12% and is corrected over the first tenth of
    /// a second - enough, on high partials where slots are narrow, to crack onto the next one.
    pub attack_skill: f32,
    /// 0..1: turbulent noise in the breath.
    pub breath_noise: f32,
    /// Seconds for the slide to move to a new position.
    pub slide_time: f32,
    /// 0..2: the air's nonlinearity (1 is real air). A laboratory setting: 0 removes brassiness,
    /// 2 doubles it.
    pub brassiness: f32,
    pub instrument: BrassInstrument,
    pub mute: Mute,
    /// 0..1: how far the player's hand is in the bell (0 out, 1 stopping it). `None` is the
    /// instrument's normal hand (a horn player's hand is always partly in).
    pub hand: Option<f32>,
    /// 0 (the bell pointing away from the listener) .. 1 (straight at them). `None` is the
    /// instrument's usual direction.
    pub bell_facing: Option<f32>,
}

impl Default for BrassParams {
    fn default() -> Self {
        Self {
            freq: 233.08,
            velocity: 0.8,
            gain: 0.6,
            breath: 0.5,
            lip_tension: 0.0,
            aperture: 0.5,
            vibrato_rate: 5.0,
            vibrato_depth: 0.0,
            vibrato_delay: 0.3,
            attack: 0.004,
            release: 0.08,
            duration: 0.6,
            articulation: Articulation::Tongued,
            attack_skill: 1.0,
            breath_noise: 0.1,
            slide_time: 0.07,
            brassiness: 1.0,
            instrument: BrassInstrument::TenorTrombone,
            mute: Mute::Open,
            hand: None,
            bell_facing: None,
        }
    }
}

impl BrassParams {
    /// The hand in the bell, the instrument's default unless given.
    pub fn hand(&self) -> f32 {
        self.hand.unwrap_or_else(|| self.instrument.default_hand()).clamp(0.0, 1.0)
    }

    pub fn bell_facing(&self) -> f32 {
        self.bell_facing.unwrap_or_else(|| self.instrument.default_bell_facing()).clamp(0.0, 1.0)
    }

    /// The bore construction a player is built for: instrument, mute, hand (to a twentieth). Notes
    /// that differ in these need a different air column (a new player).
    pub fn construction(&self) -> (BrassInstrument, Mute, u32) {
        (self.instrument, self.mute, (self.hand() * 20.0).round() as u32)
    }

    /// Mouth pressure the note asks for, Pa: the breath knob moved by velocity.
    pub fn mouth_pressure(&self) -> f32 {
        breath_pressure(self.breath + 0.6 * (self.velocity.clamp(0.0, 1.0) - 0.75))
    }
}

// ------------------------------------------------------------------------------------------
// Live controls for a held note
// ------------------------------------------------------------------------------------------

/// Controls a held note reads every control tick, so a breath controller, a drag in the view, a
/// knob, automation or an AI tool call all play the same sounding note. Same units as the matching
/// `BrassParams` fields; `bend` is in cents (on the trombone it moves the slide).
pub struct BrassLive {
    pub breath: AtomicU32,
    pub lip_tension: AtomicU32,
    pub vibrato_depth: AtomicU32,
    pub bend: AtomicU32,
}

impl BrassLive {
    pub fn from_params(p: &BrassParams) -> Self {
        Self {
            breath: AtomicU32::new(p.breath.to_bits()),
            lip_tension: AtomicU32::new(p.lip_tension.to_bits()),
            vibrato_depth: AtomicU32::new(p.vibrato_depth.to_bits()),
            bend: AtomicU32::new(0f32.to_bits()),
        }
    }

    /// Sets a control by name: "breath", "lipTension", "vibratoDepth" or "bend". Unknown names are
    /// ignored.
    pub fn set(&self, which: &str, value: f32) {
        let (slot, v) = match which {
            "breath" => (&self.breath, value.clamp(0.0, 1.0)),
            "lipTension" => (&self.lip_tension, value.clamp(-1.0, 1.0)),
            "vibratoDepth" => (&self.vibrato_depth, value.clamp(0.0, 100.0)),
            "bend" => (&self.bend, value.clamp(-1200.0, 1200.0)),
            _ => return,
        };
        slot.store(v.to_bits(), Ordering::Relaxed);
    }

    fn get(a: &AtomicU32) -> f32 {
        f32::from_bits(a.load(Ordering::Relaxed))
    }

    /// `p` with the live controls applied, and the bend in cents.
    fn apply(&self, p: BrassParams) -> (BrassParams, f32) {
        (BrassParams { breath: Self::get(&self.breath), lip_tension: Self::get(&self.lip_tension), vibrato_depth: Self::get(&self.vibrato_depth), ..p }, Self::get(&self.bend))
    }
}

// ------------------------------------------------------------------------------------------
// The instrument's resonances, per slide position
// ------------------------------------------------------------------------------------------

/// Impedance peaks of the air column at evenly spaced slide extensions, from the reference model.
pub struct ResonanceTable {
    pub extras: [f32; TABLE_STEPS],
    /// `peaks[j][n - 1]`: partial `n` at `extras[j]`, Hz.
    pub peaks: [[f32; HIGHEST_PARTIAL + 1]; TABLE_STEPS],
    /// The same peaks' impedance magnitudes, Pa·s/m³.
    pub magnitudes: [[f32; HIGHEST_PARTIAL + 1]; TABLE_STEPS],
}

impl ResonanceTable {
    fn build(profile: &BoreProfile, tuning: f32) -> Self {
        let f1 = profile.nominal_fundamental;
        let reference = Reference::new(profile, (0.4 * f1).max(10.0), (f1 * (HIGHEST_PARTIAL as f32 + 2.0)).min(2400.0), (f1 / 100.0).min(0.5));
        let mut extras = [0.0; TABLE_STEPS];
        let mut peaks = [[0.0; HIGHEST_PARTIAL + 1]; TABLE_STEPS];
        let mut magnitudes = [[0.0; HIGHEST_PARTIAL + 1]; TABLE_STEPS];
        for j in 0..TABLE_STEPS {
            let e = profile.slide_max * j as f32 / (TABLE_STEPS - 1) as f32;
            extras[j] = e;
            for (n, pk) in reference.peaks(tuning + e).iter().take(HIGHEST_PARTIAL + 1).enumerate() {
                peaks[j][n] = pk.freq;
                magnitudes[j][n] = pk.magnitude;
            }
        }
        Self { extras, peaks, magnitudes }
    }

    /// Resonance `n` (1-based) at slide extension `e`, interpolated.
    pub fn peak(&self, n: usize, e: f32) -> f32 {
        let n = n.clamp(1, HIGHEST_PARTIAL + 1) - 1;
        let step = self.extras[1] - self.extras[0];
        let x = (e / step).clamp(0.0, (TABLE_STEPS - 1) as f32);
        let i = (x.floor() as usize).min(TABLE_STEPS - 2);
        let t = x - i as f32;
        let (a, b) = (self.peaks[i][n], self.peaks[i + 1][n]);
        if a <= 0.0 || b <= 0.0 {
            return a.max(b);
        }
        a * (b / a).powf(t)
    }

    /// Impedance magnitude of resonance `n` (1-based) at slide extension `e`, interpolated.
    pub fn magnitude(&self, n: usize, e: f32) -> f32 {
        let n = n.clamp(1, HIGHEST_PARTIAL + 1) - 1;
        let step = self.extras[1] - self.extras[0];
        let x = (e / step).clamp(0.0, (TABLE_STEPS - 1) as f32);
        let i = (x.floor() as usize).min(TABLE_STEPS - 2);
        let t = x - i as f32;
        self.magnitudes[i][n] + (self.magnitudes[i + 1][n] - self.magnitudes[i][n]) * t
    }

    /// Resonances in the table (partials 1 up to this).
    pub const PARTIALS: usize = HIGHEST_PARTIAL + 1;

    /// The slide extension at which resonance `n` sits at `hz`, if the slide can reach it.
    pub fn extension_for(&self, n: usize, hz: f32) -> Option<f32> {
        let k = n.clamp(1, HIGHEST_PARTIAL + 1) - 1;
        if self.peaks[0][k] <= 0.0 || self.peaks[TABLE_STEPS - 1][k] <= 0.0 {
            return None;
        }
        // A little above first position is still playable: the player lips it up.
        if hz > self.peaks[0][k] {
            return (hz < self.peaks[0][k] * FIRST_POSITION_LIP_UP).then_some(0.0);
        }
        if hz < self.peaks[TABLE_STEPS - 1][k] {
            return None;
        }
        for j in 0..TABLE_STEPS - 1 {
            let (a, b) = (self.peaks[j][k], self.peaks[j + 1][k]);
            if hz <= a && hz >= b {
                let t = (a / hz).ln() / (a / b).ln().max(1.0e-9);
                return Some(self.extras[j] + t * (self.extras[j + 1] - self.extras[j]));
            }
        }
        None
    }
}

/// Resonance tables, one per construction (instrument, mute, hand), built once per process (a table
/// takes a fraction of a second: many reference evaluations).
fn table_for(key: (BrassInstrument, Mute, u32), profile: &BoreProfile, tuning: f32) -> Arc<ResonanceTable> {
    type Key = (BrassInstrument, Mute, u32);
    static TABLES: OnceLock<Mutex<Vec<(Key, Arc<ResonanceTable>)>>> = OnceLock::new();
    let tables = TABLES.get_or_init(|| Mutex::new(Vec::new()));
    let mut t = tables.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, table)) = t.iter().find(|(k, _)| *k == key) {
        return table.clone();
    }
    let table = Arc::new(ResonanceTable::build(profile, tuning));
    t.push((key, table.clone()));
    table
}

// ------------------------------------------------------------------------------------------
// Valves, mutes and the bell's direction
// ------------------------------------------------------------------------------------------

/// Every valve combination (a bitmask, see `Fingering::valves`) and the tube it adds, for an
/// instrument whose open tube is `open` metres. Each valve's tube lowers the *open* instrument by
/// its interval, so combinations come out sharp (their tubes add, but each was cut for the open
/// length), which players correct by trimming - as on real valves. A double horn's F side adds the
/// tube for a fourth, and its valves are cut for the longer F horn.
pub fn valve_combos(mechanism: Mechanism, open: f32) -> Vec<(u32, f32)> {
    let Mechanism::Valves { semitones, f_side } = mechanism else { return Vec::new() };
    let mut out = Vec::new();
    let sides: &[bool] = if f_side { &[false, true] } else { &[false] };
    for &f in sides {
        let side_open = if f { open * 2f32.powf(5.0 / 12.0) } else { open };
        for mask in 0u32..(1 << semitones.len()) {
            let mut e = side_open - open;
            for (k, &st) in semitones.iter().enumerate() {
                if mask & (1 << k) != 0 {
                    e += side_open * (2f32.powf(st / 12.0) - 1.0);
                }
            }
            out.push((mask | if f { F_SIDE } else { 0 }, e));
        }
    }
    out
}

/// A biquad (RBJ cookbook), for the mute body's colour.
#[derive(Clone, Copy, Default)]
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
    x: [f32; 2],
    y: [f32; 2],
}

impl Biquad {
    fn highpass(f: f32, q: f32, sr: f32) -> Self {
        let w = std::f32::consts::TAU * f / sr;
        let (sn, cs) = w.sin_cos();
        let al = sn / (2.0 * q);
        let a0 = 1.0 + al;
        Self { b: [(1.0 + cs) / 2.0 / a0, -(1.0 + cs) / a0, (1.0 + cs) / 2.0 / a0], a: [-2.0 * cs / a0, (1.0 - al) / a0], ..Default::default() }
    }
    fn lowpass(f: f32, q: f32, sr: f32) -> Self {
        let w = std::f32::consts::TAU * f / sr;
        let (sn, cs) = w.sin_cos();
        let al = sn / (2.0 * q);
        let a0 = 1.0 + al;
        Self { b: [(1.0 - cs) / 2.0 / a0, (1.0 - cs) / a0, (1.0 - cs) / 2.0 / a0], a: [-2.0 * cs / a0, (1.0 - al) / a0], ..Default::default() }
    }
    fn peak(f: f32, q: f32, db: f32, sr: f32) -> Self {
        let w = std::f32::consts::TAU * f / sr;
        let (sn, cs) = w.sin_cos();
        let al = sn / (2.0 * q);
        let g = 10f32.powf(db / 40.0);
        let a0 = 1.0 + al / g;
        Self { b: [(1.0 + al * g) / a0, -2.0 * cs / a0, (1.0 - al * g) / a0], a: [-2.0 * cs / a0, (1.0 - al / g) / a0], ..Default::default() }
    }
    fn identity() -> Self {
        Self { b: [1.0, 0.0, 0.0], ..Default::default() }
    }
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1] - self.a[0] * self.y[0] - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

/// What a mute's body does to the sound leaving it: a straight mute's cone passes the highs and
/// rings around 1.8 kHz (on a trombone's bell size) - thin and nasal; a cup mute's cup darkens and
/// hollows; a harmon's cavity rings strongly - the buzzy "wah" colour. The frequencies scale with
/// the bell (a trumpet's mutes are smaller, so higher).
struct MuteColour {
    stages: [Biquad; 2],
    gain: f32,
}

impl MuteColour {
    fn new(mute: Mute, bell: f32, sr: f32) -> Self {
        let s = 0.108 / bell.max(0.02);
        let (stages, db) = match mute {
            Mute::Open => ([Biquad::identity(), Biquad::identity()], 0.0),
            Mute::Straight => ([Biquad::highpass(450.0 * s, 0.7, sr), Biquad::peak(1800.0 * s, 2.0, 7.0, sr)], -4.0),
            Mute::Cup => ([Biquad::lowpass(2200.0 * s, 0.7, sr), Biquad::peak(650.0 * s, 1.5, 5.0, sr)], -6.0),
            Mute::Harmon => ([Biquad::highpass(700.0 * s, 0.8, sr), Biquad::peak(1600.0 * s, 3.5, 11.0, sr)], -9.0),
        };
        Self { stages, gain: 10f32.powf(db / 20.0) }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.stages[0].process(x);
        self.stages[1].process(y) * self.gain
    }
}

/// Cutoff of the shadow a bell pointing away from the listener casts (the player's body and the
/// bell's own rim in the way of the highs it beams).
const AWAY_CUTOFF_HZ: f32 = 900.0;

// ------------------------------------------------------------------------------------------
// The player
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    /// A note is held.
    Playing,
    /// The breath is stopping.
    Releasing,
}

/// How the player means to play a note: which resonance, where the slide goes or which valves
/// are down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fingering {
    pub partial: usize,
    /// Extra tube, metres: the slide's extension beyond first position, or the valves' tubing
    /// (plus a little trim).
    pub extension: f32,
    /// The resonance the note sits on at that extension, Hz.
    pub resonance: f32,
    /// Valves down: bit `k` is valve `k + 1`; `F_SIDE` is a double horn's F side.
    pub valves: u32,
}

/// The `Fingering::valves` bit for a double horn's F side.
pub const F_SIDE: u32 = 1 << 7;

/// What the engine reports about the note in progress (for tests, analysis and the view).
#[derive(Clone, Copy, Debug, Default)]
pub struct BrassReport {
    pub playing: bool,
    pub partial: usize,
    /// Slide extension beyond first position, metres, and as a position number 1..7.
    pub extension: f32,
    pub position: f32,
    /// Mouth pressure now, Pa.
    pub mouth_pressure: f32,
    /// Lip resonance now, Hz, and the lips' opening, metres.
    pub lip_freq: f32,
    pub lip_opening: f32,
    /// Sounding frequency the player hears, Hz (0 if not yet known).
    pub sounding: f32,
    /// Largest wavefront slope at the bell since the last report, Pa/s.
    pub wave_steepness: f32,
    /// AC level of the mouthpiece pressure, Pa (rms, smoothed).
    pub mouthpiece_level: f32,
    /// The note meant (with any live bend), Hz, and the resonance it is played on, Hz.
    pub target: f32,
    pub resonance: f32,
    /// The controls in effect (live values when the note has them): breath and lip tension knobs.
    pub breath: f32,
    pub lip_tension: f32,
    /// Valves held down (bit i is valve i+1; `F_SIDE` the horn's thumb valve), the mute, the
    /// horn player's hand in the bell (0 open .. 1 stopped) and where the bell points.
    pub valves: u32,
    pub mute: Mute,
    pub hand: f32,
    pub bell_facing: f32,
}

struct Player {
    phase: Phase,
    note_id: u64,
    p: BrassParams,
    fingering: Fingering,
    hold_left: Option<u64>,
    /// Mouth pressure applied, Pa (chasing its target).
    p_mouth: f32,
    /// Tongue opening: 0 stops the air, 1 lets it through.
    tongue: f32,
    /// Seconds for which the tongue stays shut before it releases (a re-articulation).
    tongue_hold: f32,
    t_note: f32,
    t_release: f32,
    vib_phase: f32,
    /// Slide extension applied, metres (gliding toward the fingering's).
    slide: f32,
    /// Lip-setting error from an imprecise attack, as a factor, decaying toward 1.
    lip_miss: f32,
    /// Intonation correction, cents of slide (positive: longer).
    fix: f32,
    /// Cents the lips are bent up when the slide can't go any shorter (lipping a note up).
    lip_bend: f32,
    /// Extra breath (a factor) while a note that hasn't spoken is being coaxed out.
    boost: f32,
    /// Guided attack: strength now (0 once released to the physics), phase of the guiding buzz
    /// (cycles), and oversampled ticks of guiding left.
    guide: f32,
    guide_phase: f32,
    guide_left: u32,
    live: Option<Arc<BrassLive>>,
    /// A cracked note being found again: a factor on the lip setting, the tries left, and the time
    /// until the next one may be made.
    refind: f32,
    refind_tries: u32,
    refind_wait: f32,
}

impl Player {
    fn new() -> Self {
        Self {
            phase: Phase::Idle,
            note_id: 0,
            p: BrassParams::default(),
            fingering: Fingering { partial: 4, extension: 0.0, resonance: 233.0, valves: 0 },
            hold_left: None,
            p_mouth: 0.0,
            tongue: 0.0,
            tongue_hold: 0.0,
            t_note: 0.0,
            t_release: 0.0,
            vib_phase: 0.0,
            slide: 0.0,
            lip_miss: 1.0,
            fix: 0.0,
            lip_bend: 0.0,
            boost: 1.0,
            guide: 0.0,
            guide_phase: 0.0,
            guide_left: 0,
            live: None,
            refind: 1.0,
            refind_tries: 0,
            refind_wait: 0.0,
        }
    }

    /// The note's parameters with any live controls applied, and the live bend (cents).
    fn effective(&self) -> (BrassParams, f32) {
        match &self.live {
            Some(l) => l.apply(self.p),
            None => (self.p, 0.0),
        }
    }
}

/// Follows the sounding pitch the way the player hears it: upward zero crossings of the low-passed
/// mouthpiece pressure, timed to a fraction of a sample.
#[derive(Default)]
struct PitchEar {
    lp: OnePole,
    lp2: OnePole,
    dc: DcBlock,
    last: f32,
    since: f32,
    period: f32,
    confidence: u32,
}

impl PitchEar {
    fn reset(&mut self) {
        *self = Self::default();
    }

    #[inline]
    fn listen(&mut self, x: f32, a: f32) {
        let y = self.dc.process(x, 0.999);
        let y = self.lp2.process(self.lp.process(y, a), a);
        self.since += 1.0;
        if self.last < 0.0 && y >= 0.0 {
            let frac = -self.last / (y - self.last).max(1.0e-12);
            let t = self.since - 1.0 + frac;
            if t > 4.0 {
                if self.period > 0.0 && (t / self.period - 1.0).abs() < 0.15 {
                    self.period += (t - self.period) * 0.3;
                    self.confidence = (self.confidence + 1).min(1000);
                } else {
                    self.period = t;
                    self.confidence = 0;
                }
            }
            self.since = 1.0 - frac;
        }
        self.last = y;
    }
}

// ------------------------------------------------------------------------------------------
// The engine
// ------------------------------------------------------------------------------------------

pub struct Engine {
    sr: f32,
    sr_os: f32,
    instrument: BrassInstrument,
    construction: (BrassInstrument, Mute, u32),
    /// Every valve combination and the tube it adds (empty for a slide).
    combos: Vec<(u32, f32)>,
    /// Where the bell points (see `BrassParams::bell_facing`), the mute's colouring, and the
    /// shadow of a bell pointed away.
    facing: f32,
    colour: MuteColour,
    away: [OnePole; 2],
    bore: AirBore,
    lips: Lips,
    lip_spec: LipSpec,
    table: Arc<ResonanceTable>,
    /// The player's tuning slide: extra tube (metres) so first position plays in tune.
    tuning: f32,
    player: Player,
    ear: PitchEar,
    dec: Decimator2,
    dec_axis: Decimator2,
    dc: DcBlock,
    noise: Noise,
    noise_lp: OnePole,
    control_countdown: u32,
    gain: f32,
    out_level: f32,
    mp_level: f32,
    /// Mean-square AC mouthpiece pressure (for "has the note spoken"), and its DC tracker.
    mp_ac: f32,
    mp_dc: DcBlock,
    /// The last `TRACE_RING` output samples of mouthpiece pressure and lip opening, for the view.
    mp_ring: Box<[f32; TRACE_RING]>,
    lip_ring: Box<[f32; TRACE_RING]>,
    ring_pos: usize,
    clock: u64,
}

/// Samples of mouthpiece pressure and lip opening kept for the view (a period of the lowest note
/// fits several times over).
pub const TRACE_RING: usize = 2048;

impl Engine {
    /// Builds the instrument (off the audio thread: the first build of an instrument computes its
    /// resonance table).
    pub fn new(sr: f32, p: &BrassParams) -> Self {
        let instrument = p.instrument;
        let base = instrument.profile();
        let profile = base.obstructed(obstruction(p.mute, p.hand(), base.mouth_radius()));
        // The one-mass lip plays sharp of the air column (see `sounding_offset`); the player pulls
        // the tuning slide out to allow for it - leaving first position a little sharp, so that
        // every note can be put in tune by moving the slide out, the only way it can move.
        let total = profile.total_length(0.0);
        let pull = sounding_offset(4, breath_pressure(0.5)) - FIRST_POSITION_HEADROOM;
        let tuning = total * (2f32.powf(pull / 1200.0) - 1.0);
        let mut bore_profile = profile.clone();
        bore_profile.cylinder_length += tuning;
        let table = table_for(p.construction(), &profile, tuning);
        let sr_os = sr * OVERSAMPLE as f32;
        let lip_spec = instrument.lips();
        let combos = valve_combos(instrument.mechanism(), total + tuning);
        Self {
            sr,
            sr_os,
            instrument,
            construction: p.construction(),
            combos,
            facing: p.bell_facing(),
            colour: MuteColour::new(p.mute, base.mouth_radius(), sr),
            away: [OnePole::default(); 2],
            bore: AirBore::new(&bore_profile, sr_os),
            lips: Lips::new(lip_spec),
            lip_spec,
            table,
            tuning,
            player: Player::new(),
            ear: PitchEar::default(),
            dec: Decimator2::new(),
            dec_axis: Decimator2::new(),
            dc: DcBlock::default(),
            noise: Noise(0x2545_f491),
            noise_lp: OnePole::default(),
            control_countdown: 0,
            gain: p.gain,
            out_level: 0.0,
            mp_level: 0.0,
            mp_ac: 0.0,
            mp_dc: DcBlock::default(),
            mp_ring: Box::new([0.0; TRACE_RING]),
            lip_ring: Box::new([0.0; TRACE_RING]),
            ring_pos: 0,
            clock: 0,
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    pub fn instrument(&self) -> BrassInstrument {
        self.instrument
    }

    pub fn table(&self) -> &ResonanceTable {
        &self.table
    }

    pub fn bore(&self) -> &AirBore {
        &self.bore
    }

    /// How the player would play `hz` blowing `pressure` Pa: the resonance (partial) and the slide
    /// position or valves.
    pub fn choose_fingering(&self, hz: f32, pressure: f32) -> Fingering {
        match self.instrument.mechanism() {
            Mechanism::Slide => self.slide_fingering(hz, pressure),
            Mechanism::Valves { .. } => self.valve_fingering(hz, pressure),
        }
    }

    /// On a slide: the position nearest first (closed) that puts a resonance where the note needs
    /// it, as trombonists prefer.
    fn slide_fingering(&self, hz: f32, pressure: f32) -> Fingering {
        let (lo, hi) = self.instrument.partials();
        let mut best: Option<Fingering> = None;
        let mut nearest: Option<(f32, Fingering)> = None;
        for n in lo..=hi {
            let resonance = hz / 2f32.powf(sounding_offset(n, pressure) / 1200.0);
            match self.table.extension_for(n, resonance) {
                Some(e) => {
                    if best.map_or(true, |b| e < b.extension) {
                        best = Some(Fingering { partial: n, extension: e, resonance, valves: 0 });
                    }
                }
                None => {
                    // Out of the slide's reach on this partial: remember how far, in case no
                    // partial can reach the note (it is then played on the closest, out of tune).
                    let (low, high) = (self.table.peak(n, self.table.extras[TABLE_STEPS - 1]), self.table.peak(n, 0.0));
                    let (miss, e) = if resonance > high { ((resonance / high).ln(), 0.0) } else { ((low / resonance).ln(), self.table.extras[TABLE_STEPS - 1]) };
                    if nearest.map_or(true, |(m, _)| miss < m) {
                        nearest = Some((miss, Fingering { partial: n, extension: e, resonance: self.table.peak(n, e), valves: 0 }));
                    }
                }
            }
        }
        best.or(nearest.map(|(_, f)| f)).unwrap_or(Fingering { partial: 4, extension: 0.0, resonance: hz, valves: 0 })
    }

    /// On valves: the fingering chart. Partial `n` of the open instrument, lowered by the semitones
    /// the valves add, nearest the note - fewer valves preferred, the out-of-tune partials (7, 11,
    /// 13, 14) avoided, and on a double horn the F side low and the B♭ side high, as players choose.
    /// Then trimmed toward the air column's real resonance (valve slides, lipping), up to
    /// `VALVE_TRIM_CENTS`; the ear does the rest.
    fn valve_fingering(&self, hz: f32, pressure: f32) -> Fingering {
        let (lo, hi) = self.instrument.partials();
        let Mechanism::Valves { semitones, .. } = self.instrument.mechanism() else { return self.slide_fingering(hz, pressure) };
        let f1 = self.bore.profile().nominal_fundamental;
        let has_f_side = self.combos.iter().any(|c| c.0 & F_SIDE != 0);
        let mut best: Option<(f32, u32, usize, f32)> = None;
        for &(mask, e) in &self.combos {
            let f_side = mask & F_SIDE != 0;
            let open = if f_side { f1 * 2f32.powf(-5.0 / 12.0) } else { f1 };
            let lowered: f32 = semitones.iter().enumerate().filter(|(k, _)| mask & (1 << k) != 0).map(|(_, s)| s).sum();
            for n in lo..=hi {
                let nominal = open * n as f32 * 2f32.powf(-lowered / 12.0);
                let off = (1200.0 * (hz / nominal).log2()).abs();
                if off > 60.0 {
                    continue;
                }
                let avoided = if matches!(n, 7 | 11 | 13 | 14) { 30.0 } else { 0.0 };
                let side = if has_f_side && (f_side != (hz < 330.0)) { 12.0 } else { 0.0 };
                let cost = off + VALVE_COST_CENTS * (mask & !F_SIDE).count_ones() as f32 + avoided + side;
                if best.map_or(true, |b| cost < b.0) {
                    best = Some((cost, mask, n, e));
                }
            }
        }
        let Some((_, mask, n, e)) = best else { return Fingering { partial: 4, extension: 0.0, resonance: hz, valves: 0 } };
        // Trim toward where the air column really puts the note (sounding a little sharp of its
        // resonance, as the lips do).
        let res = self.table.peak(n, e);
        let err = if res > 0.0 { 1200.0 * (hz / (res * 2f32.powf(sounding_offset(n, pressure) / 1200.0))).log2() } else { 0.0 };
        let total = self.bore.profile().total_length(e);
        let trim = err.clamp(-VALVE_TRIM_CENTS, VALVE_TRIM_CENTS);
        let extension = (e + total * (2f32.powf(-trim / 1200.0) - 1.0)).max(0.0);
        Fingering { partial: n, extension, resonance: self.table.peak(n, extension), valves: mask }
    }

    /// The bore construction this engine was built for (see `BrassParams::construction`).
    pub fn construction(&self) -> (BrassInstrument, Mute, u32) {
        self.construction
    }

    /// Starts a note. A note arriving while another is held is a slur (or a re-tongued note, for
    /// `Tongued`).
    pub fn note_on(&mut self, id: u64, p: BrassParams, gated: bool, live: Option<Arc<BrassLive>>) {
        let pressure = p.mouth_pressure();
        let fingering = self.choose_fingering(p.freq, pressure);
        let miss = (1.0 - p.attack_skill.clamp(0.0, 1.0)) * 0.12 * if self.noise.bipolar() >= 0.0 { 1.0 } else { -1.0 };
        let slide = self.instrument.mechanism() == Mechanism::Slide;
        let pl = &mut self.player;
        let was_playing = pl.phase == Phase::Playing;
        pl.p = p;
        pl.live = live;
        pl.note_id = id;
        pl.hold_left = if gated { None } else { Some((p.duration.max(0.0) * self.sr) as u64) };
        pl.t_note = 0.0;
        pl.t_release = 0.0;
        let moved = (fingering.extension - pl.fingering.extension).abs();
        // The player remembers where the last note sat: the same note again starts with the
        // same slide correction (a repeated note is in tune from its first period).
        let same_note = fingering.partial == pl.fingering.partial && moved < 0.001;
        pl.fingering = fingering;
        if !same_note {
            pl.fix = 0.0;
        }
        // (Lips bent up to lip a note into tune are set afresh for each attack; a fresh attack
        // from lips left bent would start them above the slot.)
        if !same_note || !was_playing {
            pl.lip_bend = 0.0;
        }
        pl.boost = 1.0;
        pl.lip_miss = 1.0 + miss;
        pl.refind = 1.0;
        pl.refind_tries = (p.attack_skill.clamp(0.0, 1.0) * REFIND_TRIES as f32).round() as u32;
        pl.refind_wait = 0.0;
        self.ear.reset();
        if !was_playing {
            // A fresh note: slide already in place, lips set, tongue shut; the breath builds
            // behind the tongue and the tongue lets it go.
            pl.slide = fingering.extension;
            pl.tongue = 0.0;
            pl.tongue_hold = 0.006;
            pl.vib_phase = 0.0;
            self.bore.set_extra(pl.slide);
            self.lips.freq = lip_center(fingering.resonance, pressure) * self.instrument.lip_aim(fingering.partial) * pl.lip_miss;
            self.lips.spec = LipSpec { mu: lip_mass(fingering.resonance), ..self.lip_spec };
            self.lips.reset();
            self.bore.clear();
            self.mp_ac = 0.0;
            pl.guide = 0.0;
            pl.guide_phase = 0.0;
            pl.guide_left = 0;
        } else {
            match p.articulation {
                // Re-tongued: the tongue stops the air for a moment between the notes.
                Articulation::Tongued => pl.tongue_hold = 0.012,
                // A trombonist's slur across slide positions: a soft "da", just long enough to
                // hide the slide's travel. (Valves need none: they switch in a few milliseconds.)
                Articulation::Legato if moved > 0.01 && slide => pl.tongue_hold = 0.004,
                _ => {}
            }
        }
        pl.phase = Phase::Playing;
        self.bore.set_tuning(fingering.resonance);
        self.bore.nonlinearity = p.brassiness.clamp(0.0, 4.0);
        self.gain = p.gain;
        self.facing = p.bell_facing();
    }

    pub fn note_off(&mut self, id: u64) {
        if self.player.note_id == id && self.player.phase == Phase::Playing {
            self.player.phase = Phase::Releasing;
            self.player.t_release = 0.0;
        }
    }

    pub fn all_notes_off(&mut self) {
        if self.player.phase == Phase::Playing {
            self.player.phase = Phase::Releasing;
            self.player.t_release = 0.0;
        }
    }

    pub fn is_playing(&self) -> bool {
        self.player.phase != Phase::Idle
    }

    pub fn is_silent(&self) -> bool {
        self.player.phase == Phase::Idle && self.out_level < 2.0e-5
    }

    fn control(&mut self, dt: f32) {
        let pl = &mut self.player;
        if pl.phase == Phase::Idle {
            pl.p_mouth *= (-dt / 0.01).exp();
            return;
        }
        pl.t_note += dt;
        if let Some(left) = pl.hold_left.as_mut() {
            *left = left.saturating_sub(CONTROL_EVERY as u64);
            if *left == 0 && pl.phase == Phase::Playing {
                pl.phase = Phase::Releasing;
                pl.t_release = 0.0;
            }
        }
        let (p, bend) = pl.effective();
        let target = pl.fingering;

        // Breath.
        let pressure = p.mouth_pressure() * pl.boost;
        // The breath builds behind the closed tongue, so it is there when the tongue lets go.
        let (p_target, tau) = match pl.phase {
            Phase::Playing if pl.tongue_hold > 0.0 => (pressure, 0.003),
            Phase::Playing => (pressure, p.attack.max(0.002) * 1.5),
            _ => (0.0, p.release.max(0.005) / 3.0),
        };
        pl.p_mouth += (p_target - pl.p_mouth) * (1.0 - (-dt / tau).exp());

        // Tongue: held shut for a moment on a re-articulation, then released over the attack.
        if pl.tongue_hold > 0.0 {
            pl.tongue_hold -= dt;
            pl.tongue *= (-dt / 0.002).exp();
            if pl.tongue_hold <= 0.0 && pl.phase == Phase::Playing {
                // The tongue lets go: a skilled player's lips are already buzzing the note - when
                // they are set for it (lips deliberately set off with `lip_tension` aren't).
                let set_for_it = (1.0 - 2.0 * p.lip_tension.abs()).max(0.0);
                pl.guide = p.attack_skill.clamp(0.0, 1.0) * set_for_it;
                pl.guide_left = (GUIDE_PERIODS * self.sr_os / p.freq.max(20.0)) as u32;
            }
        } else {
            let k = 1.0 - (-dt / (p.attack.max(0.001) / 2.5)).exp();
            pl.tongue += (1.0 - pl.tongue) * k;
        }

        // Slide: glide to the fingering's position plus the intonation fix, with slide vibrato.
        let total = self.bore.profile().total_length(target.extension);
        let vib_on = ((pl.t_note - p.vibrato_delay) / 0.3).clamp(0.0, 1.0);
        pl.vib_phase = (pl.vib_phase + p.vibrato_rate.max(0.0) * dt).fract();
        let vib = p.vibrato_depth * vib_on * (std::f32::consts::TAU * pl.vib_phase).sin();
        // The slide travels to the fingering's position (at the speed asked) - valves switch in a
        // few milliseconds; the ear's small corrections and the vibrato are quick adjustments
        // around where it is.
        let slide = self.instrument.mechanism() == Mechanism::Slide;
        let glide = if !slide { 0.003 } else if pl.phase == Phase::Playing { p.slide_time.max(0.005) / 3.0 } else { 0.05 };
        pl.slide += (target.extension - pl.slide) * (1.0 - (-dt / glide).exp());
        let arrived = (target.extension - pl.slide).abs() < 0.015;
        // A bend (pitch bend, or a drag on the slide) moves the slide: up is shorter. On valves the
        // same bend is lipping and valve slides together.
        let fix_len = (total + pl.slide) * (2f32.powf((pl.fix - bend) / 1200.0) - 1.0);
        let vib_len = (total + pl.slide) * (2f32.powf(vib / 1200.0) - 1.0);
        let slide_max = self.bore.profile().slide_max;
        // Where the tube can go no shorter (first position, or valves trimmed all they can be) - or
        // on valves no longer - the lips take over.
        let (fix_lo, fix_hi) = if slide { (-300.0, 300.0) } else { (-VALVE_TRIM_CENTS, VALVE_TRIM_CENTS) };
        let at_stop = pl.slide + fix_len < 0.0 || pl.fix <= fix_lo + 0.5;
        let at_far = pl.fix >= fix_hi - 0.5;
        self.bore.set_extra((pl.slide + fix_len + vib_len).clamp(0.0, slide_max));

        // Lips: set for the resonance and the breath, the attack's miss fading as the player
        // corrects it, bent by the tension control.
        pl.lip_miss = 1.0 + (pl.lip_miss - 1.0) * (-dt / 0.08).exp();
        let lip_up = 2f32.powf(pl.lip_bend * LIP_BEND_RATIO / 1200.0);
        let aim = self.instrument.lip_aim(target.partial);
        let lip = lip_center(target.resonance, pl.p_mouth.max(pressure * 0.3)) * aim * pl.refind * pl.lip_miss * lip_up * 2f32.powf(p.lip_tension.clamp(-1.0, 1.0) * 0.35);
        self.lips.freq += (lip - self.lips.freq) * (1.0 - (-dt / 0.02).exp());
        self.lips.spec.mu += (lip_mass(target.resonance) - self.lips.spec.mu) * (1.0 - (-dt / 0.03).exp());

        // Attack assist: a note that hasn't spoken a moment after the tongue let go gets a little
        // more air, as much as the player's skill allows, easing off once it speaks. (The lips
        // stay where they were set: moving them would leave the slot for the neighbouring one.)
        let speaking = self.mp_ac.sqrt() > SPEAKING_LEVEL * pl.p_mouth.max(1.0);
        if pl.phase == Phase::Playing && pl.t_note > 0.05 && pl.t_note < 0.6 && !speaking {
            let k = p.attack_skill.clamp(0.0, 1.0) * dt / 0.1;
            pl.boost = (pl.boost * (1.0 + 0.3 * k)).min(1.35);
        } else if speaking {
            pl.boost = 1.0 + (pl.boost - 1.0) * (-dt / 0.3).exp();
        }

        // A cracked note: the player hears the note has landed on a neighbouring partial and moves
        // the lips part of the way toward the one meant (what a skilled player does a moment into
        // a split note). Lips deliberately set off (`lip_tension`) are left alone.
        pl.refind_wait -= dt;
        if pl.phase == Phase::Playing && pl.t_note > 0.07 && pl.refind_tries > 0 && pl.refind_wait <= 0.0 && self.ear.confidence > 6 && p.lip_tension.abs() < 0.25 {
            let heard = self.sr_os / self.ear.period;
            let off = 1200.0 * (heard / (p.freq * 2f32.powf(bend / 1200.0))).log2();
            if off.abs() > REFIND_CENTS {
                pl.refind *= 2f32.powf(-off * REFIND_SHARE / 1200.0);
                pl.refind_tries -= 1;
                pl.refind_wait = 0.06;
                self.ear.confidence = 0;
            }
        }

        // Ear: once the note has spoken and the slide has arrived, ease the slide to put it in
        // tune - and where the slide can go no shorter, bend the lips up a little instead. Only
        // while the note is on the partial meant (a cracked note is not tuned onto the right pitch
        // by the slide).
        if pl.phase == Phase::Playing && pl.t_note > 0.06 && arrived && self.ear.confidence > 4 {
            let heard = self.sr_os / self.ear.period;
            // Measured against the note as meant, vibrato included (the player doesn't correct
            // their own vibrato away).
            let err = 1200.0 * (heard / p.freq).log2() - bend + vib;
            if err.abs() < 150.0 {
                let k = (dt / 0.05).min(1.0);
                if (at_stop && err < 0.0) || (at_far && err > 0.0) {
                    pl.lip_bend = (pl.lip_bend - err * k).clamp(-60.0, 60.0);
                } else {
                    // Lips first back to where they sit naturally, then the tube.
                    if pl.lip_bend * err > 0.0 {
                        pl.lip_bend -= err.signum() * (err.abs() * k).min(pl.lip_bend.abs());
                    } else {
                        pl.fix = (pl.fix + err * k).clamp(fix_lo, fix_hi);
                    }
                }
            }
        }

        if pl.phase == Phase::Releasing {
            pl.t_release += dt;
            if pl.t_release > p.release.max(0.005) * 2.0 {
                pl.phase = Phase::Idle;
            }
        }
    }

    /// Renders one output frame (left, right).
    pub fn next_frame(&mut self) -> [f32; 2] {
        self.clock += 1;
        if self.control_countdown == 0 {
            self.control(CONTROL_EVERY as f32 / self.sr);
            self.control_countdown = CONTROL_EVERY;
        }
        self.control_countdown -= 1;

        let dt = 1.0 / self.sr_os;
        let (p, _) = self.player.effective();
        let aperture = 2f32.powf((p.aperture.clamp(0.0, 1.0) - 0.5) * 2.0);
        let ear_a = OnePole::coef_for(self.player.fingering.resonance * 1.6, self.sr_os);
        let noise_a = OnePole::coef_for(3000.0, self.sr_os);
        let mut out = [0.0f32; OVERSAMPLE];
        let mut axis = [0.0f32; OVERSAMPLE];
        for (o, ax) in out.iter_mut().zip(axis.iter_mut()) {
            let incoming = self.bore.incoming();
            let z0 = self.bore.z_in();
            // The tongue behind the lips gates the flow; breath noise rides on it.
            let turb = self.noise_lp.process(self.noise.bipolar(), noise_a);
            let pm = self.player.p_mouth * (1.0 + p.breath_noise.clamp(0.0, 1.0) * 0.15 * turb);
            let tongue = self.player.tongue;
            let inject = self.lips.tick(pm * tongue, incoming, z0, dt, aperture);
            self.bore.step(inject);
            if self.player.guide_left > 0 {
                // Guided attack: the lips follow a buzz at the note's pitch around the opening the
                // breath holds them at, the guide fading out over its periods.
                let pl = &mut self.player;
                let total = (GUIDE_PERIODS * self.sr_os / p.freq.max(20.0)).max(1.0);
                let fade = pl.guide_left as f32 / total;
                let w = std::f32::consts::TAU * p.freq;
                let wl = std::f32::consts::TAU * self.lips.freq;
                let open = (self.lip_spec.h0 * aperture + pm * tongue / (self.lips.spec.mu * wl * wl)).max(0.0);
                pl.guide_phase = (pl.guide_phase + p.freq * dt).fract();
                let (s, c) = (std::f32::consts::TAU * pl.guide_phase).sin_cos();
                let (h, v) = (open * (1.0 - c), open * w * s);
                self.lips.steer(h, v, GUIDE_STRENGTH * pl.guide * fade);
                pl.guide_left -= 1;
            }
            self.ear.listen(self.lips.pressure, ear_a);
            *o = self.bore.radiated;
            *ax = self.bore.radiated_on_axis;
        }
        let power = self.dec.process(out[0], out[1]);
        let on_axis = self.dec_axis.process(axis[0], axis[1]);
        // Where the bell points: toward the listener adds the highs it beams on its axis; away,
        // they are shaded (the player and the bell's rim in the way); sideways is the power alone.
        let f = self.facing;
        let y = if f >= 0.5 {
            power + (f - 0.5) * 2.0 * (on_axis - power)
        } else {
            let a = OnePole::coef_for(AWAY_CUTOFF_HZ, self.sr);
            let first = self.away[0].process(power, a);
            let shaded = self.away[1].process(first, a);
            shaded + (power - shaded) * f * 2.0
        };
        let y = self.colour.process(y);
        let y = self.dc.process(y, 0.9995) / OUTPUT_REF * self.gain;
        let y = if y.is_finite() { y.clamp(-4.0, 4.0) } else { 0.0 };
        let mp = self.mp_dc.process(self.lips.pressure, 0.999);
        self.mp_level += (mp * mp - self.mp_level) * 0.001;
        self.mp_ac += (mp * mp - self.mp_ac) * 0.004;
        self.out_level += (y.abs() - self.out_level) * 0.001;
        self.mp_ring[self.ring_pos] = mp;
        self.lip_ring[self.ring_pos] = self.lips.h;
        self.ring_pos = (self.ring_pos + 1) % TRACE_RING;
        [y, y]
    }

    /// One period of the mouthpiece pressure (Pa, AC) and of the lips' opening (m), each resampled
    /// to `out.len()` points, starting at an upward zero crossing of the pressure so a view drawing
    /// it frame after frame shows a standing picture. False (and nothing written) when no period
    /// can be found.
    pub fn traces(&self, pressure: &mut [f32], opening: &mut [f32]) -> bool {
        let pl = &self.player;
        let hz = if self.ear.confidence > 2 { self.sr_os / self.ear.period } else { pl.p.freq };
        let period = self.sr / hz.max(20.0);
        if period < 4.0 || period * 2.0 > TRACE_RING as f32 - 4.0 {
            return false;
        }
        let at = |ring: &[f32; TRACE_RING], back: f32| {
            // `back` samples before the newest, linearly interpolated.
            let b = back.max(0.0);
            let i = b.floor() as usize;
            let f = b - i as f32;
            let idx = |k: usize| (self.ring_pos + TRACE_RING - 1 - k.min(TRACE_RING - 1)) % TRACE_RING;
            ring[idx(i)] * (1.0 - f) + ring[idx(i + 1)] * f
        };
        // The latest upward crossing at least one period back.
        let mut start = None;
        let mut k = period.ceil() as usize;
        while (k as f32) < period * 2.0 + 2.0 && k + 1 < TRACE_RING {
            let (newer, older) = (at(&self.mp_ring, k as f32), at(&self.mp_ring, k as f32 + 1.0));
            if older < 0.0 && newer >= 0.0 {
                start = Some(k as f32 + older / (older - newer));
                break;
            }
            k += 1;
        }
        let Some(start) = start else { return false };
        let n = pressure.len().min(opening.len());
        for j in 0..n {
            let back = start - period * j as f32 / n as f32;
            pressure[j] = at(&self.mp_ring, back);
            opening[j] = at(&self.lip_ring, back);
        }
        true
    }

    /// Acoustic pressure along the air column, lips to bell, at `out.len()` evenly spaced points.
    pub fn bore_pressure(&self, out: &mut [f32]) {
        self.bore.pressure_along(out);
    }

    /// The air column's resonances where the slide is now: frequencies (Hz) and impedance
    /// magnitudes, partial 1 upward. Returns how many were written.
    pub fn ladder(&self, freqs: &mut [f32], mags: &mut [f32]) -> usize {
        let e = self.bore.extra();
        let n = freqs.len().min(mags.len()).min(ResonanceTable::PARTIALS);
        for i in 0..n {
            freqs[i] = self.table.peak(i + 1, e);
            mags[i] = self.table.magnitude(i + 1, e);
        }
        n
    }

    /// A snapshot of the note in progress.
    pub fn report(&mut self) -> BrassReport {
        let pl = &self.player;
        let (p, bend) = pl.effective();
        let total0 = self.bore.profile().total_length(0.0);
        let ext = self.bore.extra();
        let semis = 12.0 * ((total0 + ext) / total0).log2();
        BrassReport {
            playing: pl.phase != Phase::Idle,
            partial: pl.fingering.partial,
            extension: ext,
            position: 1.0 + semis,
            mouth_pressure: pl.p_mouth,
            lip_freq: self.lips.freq,
            lip_opening: self.lips.h,
            sounding: if self.ear.confidence > 2 { self.sr_os / self.ear.period } else { 0.0 },
            wave_steepness: self.bore.take_peak_slope(),
            mouthpiece_level: self.mp_level.sqrt(),
            target: p.freq * 2f32.powf(bend / 1200.0),
            resonance: pl.fingering.resonance,
            breath: p.breath,
            lip_tension: p.lip_tension,
            valves: pl.fingering.valves,
            mute: self.construction.1,
            hand: self.construction.2 as f32 / 20.0,
            bell_facing: self.facing,
        }
    }

    /// Output samples rendered so far.
    pub fn clock(&self) -> u64 {
        self.clock
    }

    /// The tuning slide's pull, metres.
    pub fn tuning_slide(&self) -> f32 {
        self.tuning
    }
}
