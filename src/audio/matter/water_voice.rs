//! Water on a track: one instrument that plays every kind of water sound the family has, the live
//! voice a track's notes go to ([`WaterVoice`] and its [`WaterHandle`]), what it publishes for the
//! view and the ops ([`WaterShared`]), and offline rendering of a track's notes
//! ([`render_water_performance`]) - the kit's arrangement (`live`), for water.
//!
//! A note is a physical action, and what makes it musical is solved from its pitch before it reaches
//! the audio thread ([`WaterAction::command`]): a **drip** is the drop whose bubble is born ringing
//! at the note; a **glass** is struck on the glass (from a rack of eight) that its water tunes to
//! the note; a **fill** pours into a bottle scaled so that its air column rises a fifth to the note
//! as the note lasts. The rest are textures a note holds: **rain** on the track's surface (its
//! intensity from the velocity), a **brook**, **surf**, a **tub** shaken.
//!
//! Everything is built with the instrument (the rain's body, a brook and a beach already flowing),
//! off the audio thread; playing it allocates nothing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rodio::Source as RodioSource;

use super::drop::Drop as Droplet;
use super::drum::StrikerSpec;
use super::rain::{Rain, RainTarget};
use super::vessel::{air_modes, soft_mallet, spoon, AirMode, GlassSpec, Pour, Vessel, VesselSpec};
use super::water::{Pond, WATER_FULL_SCALE_PA};
use super::waves::{Motion, Waves, WavesSpec};
use crate::audio::analysis::ENGINE_SAMPLE_RATE;

/// The kinds of water sound, each with its own level in the track's mix (its "microphone").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Source {
    Drip,
    Glass,
    Fill,
    Rain,
    Brook,
    Surf,
    Slosh,
}

pub const SOURCES: usize = 7;

impl Source {
    pub const ALL: [Source; SOURCES] = [Source::Drip, Source::Glass, Source::Fill, Source::Rain, Source::Brook, Source::Surf, Source::Slosh];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn name(self) -> &'static str {
        match self {
            Source::Drip => "drip",
            Source::Glass => "glass",
            Source::Fill => "fill",
            Source::Rain => "rain",
            Source::Brook => "brook",
            Source::Surf => "surf",
            Source::Slosh => "slosh",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|s| s.name() == name)
    }

    /// Whether its notes have a pitch.
    pub fn pitched(self) -> bool {
        matches!(self, Source::Drip | Source::Glass | Source::Fill)
    }
}

/// Microphone levels that bring the sources near each other (each is a gain on what it radiates at
/// its listening distance). Measured at unity (`water_mix_report`), a tuned drip peaks at -19 to
/// -25 dBFS, a mallet on a glass at -15 (0.5 m/s), a fill's fizz at -17 to -22 with its rms near
/// -30, a brook, surf and a shaken tub at -15 to -18 rms: these bring peaks to about -6 dBFS and
/// the textures to about -20 rms.
pub const DEFAULT_MIX: [f32; SOURCES] = [5.0, 1.5, 4.0, 1.0, 0.7, 0.5, 0.5];

/// The rain's microphone for each surface it can fall on, bringing 8 mm/h to about -24 dBFS rms
/// (measured at unity: a lake -39, a window -51, a roof -48, a tent -28, a cymbal -58, a drum -36).
/// Each is where the ear would be for that surface - the cymbal and the window are quiet bodies.
pub fn rain_gain(target: RainTarget) -> f32 {
    match target {
        RainTarget::Lake => 5.6,
        RainTarget::Window => 22.0,
        RainTarget::Roof => 16.0,
        RainTarget::Tent => 1.6,
        RainTarget::Cymbal => 50.0,
        RainTarget::Drum => 4.0,
    }
}

/// What a water track is built with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WaterSpec {
    /// What its rain falls on.
    pub rain: RainTarget,
    /// What its fills pour into (scaled to each note).
    pub vessel: VesselKind,
}

impl Default for WaterSpec {
    fn default() -> Self {
        Self { rain: RainTarget::Lake, vessel: VesselKind::Bottle }
    }
}

impl WaterSpec {
    /// Whether two specs build the same instrument (only the rain's body is built; the vessel is
    /// chosen per note).
    pub fn same_build(&self, other: &WaterSpec) -> bool {
        self.rain == other.rain
    }
}

/// A shape of vessel to fill.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VesselKind {
    Bottle,
    Vase,
    Jug,
}

impl VesselKind {
    pub const ALL: [VesselKind; 3] = [VesselKind::Bottle, VesselKind::Vase, VesselKind::Jug];

    pub fn name(self) -> &'static str {
        match self {
            VesselKind::Bottle => "bottle",
            VesselKind::Vase => "vase",
            VesselKind::Jug => "jug",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|s| s.name() == name)
    }

    pub fn spec(self) -> VesselSpec {
        match self {
            VesselKind::Bottle => VesselSpec::bottle(),
            VesselKind::Vase => VesselSpec::vase(),
            VesselKind::Jug => VesselSpec::jug(),
        }
    }
}

/// `spec` with every length times `s` (its air column's pitches divide by `s`).
pub fn scaled(spec: VesselSpec, s: f32) -> VesselSpec {
    VesselSpec { radius: spec.radius * s, height: spec.height * s, neck_radius: spec.neck_radius * s, neck_length: spec.neck_length * s, wall_thickness: spec.wall_thickness * s, ..spec }
}

fn air_pitch(spec: &VesselSpec, level: f32) -> f32 {
    let mut m = [AirMode::default(); 1];
    air_modes(spec, level, 1.0e6, &mut m);
    m[0].freq
}

/// How to fill a vessel of `kind` so that its air column rises by `glide` semitones to `pitch` Hz:
/// the vessel scaled so that `pitch` is reached with the body 85% full, and the levels to pour from
/// and to (m). The scale is kept between a quarter and four times the vessel's own size; beyond,
/// the glide ends where it can.
pub fn fill_plan(kind: VesselKind, pitch: f32, glide: f32) -> (VesselSpec, f32, f32) {
    let base = kind.spec();
    let full = 0.85 * base.height;
    let s = (air_pitch(&base, full) / pitch.max(1.0)).clamp(0.25, 4.0);
    let spec = scaled(base, s);
    let to = 0.85 * spec.height;
    let start = air_pitch(&spec, to) * 2.0f32.powf(-glide.max(0.0) / 12.0);
    // The level whose column rings at `start` (the pitch rises with the level).
    let (mut lo, mut hi) = (0.0f32, to);
    if air_pitch(&spec, 0.0) >= start {
        return (spec, 0.0, to);
    }
    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        if air_pitch(&spec, mid) < start {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (spec, 0.5 * (lo + hi), to)
}

/// One note's action, as a track plays it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WaterAction {
    /// A drip ringing at `pitch` Hz (0: a tap's own drip, falling 7 cm), `x` m across (-0.5..0.5).
    Drip { pitch: f32, x: f32 },
    /// A glass tuned to `pitch` Hz, struck at `speed` m/s with a spoon or a soft mallet.
    Glass { pitch: f32, speed: f32, spoon: bool },
    /// A vessel filled so its air column rises a fifth to `pitch` Hz over `duration` s.
    Fill { pitch: f32, duration: f32 },
    /// Rain of `rate` mm/h for `duration` s.
    Rain { rate: f32, duration: f32 },
    /// The brook running at `speed` m/s, heard for `duration` s.
    Brook { speed: f32, duration: f32 },
    /// Surf of waves `height` m high, heard for `duration` s.
    Surf { height: f32, duration: f32 },
    /// The tub shaken with `strength` (0..1, 1 about as hard as it takes to slop over) for `duration` s.
    Slosh { strength: f32, duration: f32 },
}

impl WaterAction {
    pub fn source(&self) -> Source {
        match self {
            WaterAction::Drip { .. } => Source::Drip,
            WaterAction::Glass { .. } => Source::Glass,
            WaterAction::Fill { .. } => Source::Fill,
            WaterAction::Rain { .. } => Source::Rain,
            WaterAction::Brook { .. } => Source::Brook,
            WaterAction::Surf { .. } => Source::Surf,
            WaterAction::Slosh { .. } => Source::Slosh,
        }
    }

    /// The physical command for the instrument: whatever needs solving (the drop for a note, the
    /// glass and its level, the vessel and its pour) is solved here, off the audio thread.
    pub fn command(&self, spec: &WaterSpec) -> WaterCommand {
        match *self {
            WaterAction::Drip { pitch, x } => {
                let drop = if pitch > 0.0 { Droplet::ringing_at(pitch.clamp(150.0, 12_000.0)) } else { Droplet::from_tap(2.0e-3, 0.07) };
                WaterCommand::Drip { drop, x: x.clamp(-1.0, 1.0) }
            }
            WaterAction::Glass { pitch, speed, spoon: s } => {
                let (glass, level) = GlassSpec::tuned(pitch.clamp(80.0, 4000.0));
                WaterCommand::Glass { pitch, vessel: glass.vessel, level, speed: speed.clamp(0.0, 3.0), striker: if s { spoon() } else { soft_mallet() } }
            }
            WaterAction::Fill { pitch, duration } => {
                let (vessel, from, to) = fill_plan(spec.vessel, pitch.clamp(40.0, 3000.0), 7.0);
                let duration = duration.clamp(0.1, 60.0);
                let flow = (vessel.volume_to(to) - vessel.volume_to(from)).max(1.0e-9) / duration;
                let pour = Pour { flow, height: vessel.total_height() + 0.15, spout_speed: 0.5, duration };
                WaterCommand::Fill { vessel, from, pour }
            }
            WaterAction::Rain { rate, duration } => WaterCommand::Rain { rate: rate.clamp(0.0, 150.0), duration: duration.clamp(0.0, 600.0) },
            WaterAction::Brook { speed, duration } => WaterCommand::Brook { speed: speed.clamp(0.05, 1.5), duration: duration.clamp(0.0, 600.0) },
            WaterAction::Surf { height, duration } => WaterCommand::Surf { height: height.clamp(0.1, 2.5), duration: duration.clamp(0.0, 600.0) },
            WaterAction::Slosh { strength, duration } => WaterCommand::Slosh { strength: strength.clamp(0.0, 2.0), duration: duration.clamp(0.0, 600.0) },
        }
    }
}

/// What the instrument is told (see [`WaterAction::command`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WaterCommand {
    Drip { drop: Droplet, x: f32 },
    Glass { pitch: f32, vessel: VesselSpec, level: f32, speed: f32, striker: StrikerSpec },
    Fill { vessel: VesselSpec, from: f32, pour: Pour },
    Rain { rate: f32, duration: f32 },
    Brook { speed: f32, duration: f32 },
    Surf { height: f32, duration: f32 },
    Slosh { strength: f32, duration: f32 },
    /// Each source's level.
    Mix([f32; SOURCES]),
}

/// Glasses in the rack, and vessels that can be filling at once.
pub const GLASSES: usize = 8;
pub const FILLS: usize = 2;
/// Seconds a brook or the surf runs before it is first heard (so it is already flowing).
const BROOK_PREROLL: f32 = 3.0;
const SURF_PREROLL: f32 = 20.0;

/// A texture held for a while: how long is left (samples), and its fader (0..1) for the textures
/// that fade in and out (brook, surf) as the listener walks up to and away from them.
#[derive(Clone, Copy, Debug, Default)]
struct Held {
    left: u64,
    fader: f32,
}

/// What the instrument is doing, for the view and the ops.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WaterState {
    pub levels: [f32; SOURCES],
    pub last_drip: f32,
    pub drips: u64,
    pub bubbles: usize,
    /// Glasses: their pitches (0: none) and how loudly each still rings (J).
    pub glass_pitch: [f32; GLASSES],
    pub glass_energy: [f32; GLASSES],
    pub glass_level: [f32; GLASSES],
    pub glass_height: [f32; GLASSES],
    /// Fills: level (fraction of the vessel's height), the air column's pitch, whether pouring.
    pub fill_level: [f32; FILLS],
    pub fill_pitch: [f32; FILLS],
    pub filling: [bool; FILLS],
    pub rain_rate: f32,
    pub raindrops: f64,
    pub brook_speed: f32,
    pub brook_dissipation: f32,
    pub surf_height: f32,
    pub surf_breakers: u64,
    pub slosh: f32,
    pub slosh_bores: u32,
}

/// Every kind of water sound, on one track. See the module notes.
pub struct Water {
    pub spec: WaterSpec,
    sr: f32,
    pond: Pond,
    glasses: Vec<Vessel>,
    glass_pitch: [f32; GLASSES],
    fills: Vec<Vessel>,
    rain: Rain,
    brook: Waves,
    surf: Waves,
    tub: Waves,
    rain_held: Held,
    brook_held: Held,
    surf_held: Held,
    slosh_held: Held,
    mix: [f32; SOURCES],
    levels: [f32; SOURCES],
    level_decay: f32,
    fader_step: [f32; 2],
}

impl Water {
    /// Builds the instrument (a second or so: the rain's body, and a brook and a beach set flowing).
    pub fn new(spec: WaterSpec, sr: f32) -> Self {
        let glasses = (0..GLASSES).map(|_| Vessel::new(VesselSpec::tumbler(), 0.0, 0.5, sr)).collect();
        let fills = (0..FILLS).map(|_| Vessel::new(VesselSpec::bottle(), 0.0, 0.4, sr)).collect();
        let mut brook = Waves::new(WavesSpec::brook(0.5), sr);
        for _ in 0..(BROOK_PREROLL * sr) as usize {
            brook.next_frame();
        }
        let mut surf = Waves::new(WavesSpec::surf(1.0, 8.0), sr);
        for _ in 0..(SURF_PREROLL * sr) as usize {
            surf.next_frame();
        }
        let mut tub = WavesSpec::tub();
        tub.motion = Motion::Still;
        Self {
            spec,
            sr,
            pond: Pond::new(0.1, 0.4, sr),
            glasses,
            glass_pitch: [0.0; GLASSES],
            fills,
            rain: Rain::new(spec.rain, 0.0, if spec.rain == RainTarget::Lake { 6.0 } else { 1.5 }, 17, sr),
            brook,
            surf,
            tub: Waves::new(tub, sr),
            rain_held: Held::default(),
            brook_held: Held::default(),
            surf_held: Held::default(),
            slosh_held: Held::default(),
            mix: DEFAULT_MIX,
            levels: [0.0; SOURCES],
            level_decay: (-1.0 / (0.3 * sr)).exp(),
            // The brook fades in over a quarter second, out over one; the surf over one and three.
            fader_step: [1.0 / (0.25 * sr), 1.0 / (1.5 * sr)],
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    pub fn set_mix(&mut self, mix: [f32; SOURCES]) {
        self.mix = mix;
    }

    /// Plays a command (allocates nothing).
    pub fn command(&mut self, cmd: WaterCommand) {
        let sr = self.sr;
        let samples = |d: f32| (d.max(0.0) * sr) as u64;
        match cmd {
            WaterCommand::Drip { drop, x } => {
                self.pond.drip(drop, x * 0.5);
            }
            WaterCommand::Glass { pitch, vessel, level, speed, striker } => {
                let k = match self.glass_pitch.iter().position(|&p| p == pitch) {
                    Some(k) => k,
                    None => {
                        // The quietest glass in the rack is retuned (emptied and refilled).
                        let k = (0..GLASSES).min_by(|&a, &b| self.glasses[a].wall_energy().total_cmp(&self.glasses[b].wall_energy())).unwrap_or(0);
                        let g = &mut self.glasses[k];
                        g.pan = ((pitch.max(1.0).log2() - 9.0) * 0.35).clamp(-0.8, 0.8);
                        g.reshape(vessel, level);
                        self.glass_pitch[k] = pitch;
                        k
                    }
                };
                self.glasses[k].strike(speed, striker);
            }
            WaterCommand::Fill { vessel, from, pour } => {
                let k = (0..FILLS).find(|&k| !self.fills[k].busy()).unwrap_or_else(|| (0..FILLS).find(|&k| !self.fills[k].pouring()).unwrap_or(0));
                let v = &mut self.fills[k];
                v.reshape(vessel, from);
                v.pour(pour);
            }
            WaterCommand::Rain { rate, duration } => {
                let r = if self.rain_held.left > 0 { self.rain.rate().max(rate) } else { rate };
                self.rain.set_rate(r);
                self.rain_held.left = self.rain_held.left.max(samples(duration));
            }
            WaterCommand::Brook { speed, duration } => {
                self.brook.set_inflow(self.brook.spec.depth * speed);
                self.brook_held.left = self.brook_held.left.max(samples(duration));
            }
            WaterCommand::Surf { height, duration } => {
                self.surf.set_sea(height, 8.0);
                self.surf_held.left = self.surf_held.left.max(samples(duration));
            }
            WaterCommand::Slosh { strength, duration } => {
                let WavesSpec { length, depth, .. } = self.tub.spec;
                let k = std::f32::consts::PI / length;
                let f = (super::bubble::G * k * (k * depth).tanh()).sqrt() / std::f32::consts::TAU;
                self.tub.set_motion(Motion::Shake { amplitude: 0.012 * strength, freq: f });
                self.slosh_held.left = self.slosh_held.left.max(samples(duration));
            }
            WaterCommand::Mix(m) => self.mix = m,
        }
    }

    /// Whether nothing can be heard or is about to be.
    pub fn is_silent(&self) -> bool {
        !self.pond.busy()
            && self.glasses.iter().all(|g| g.wall_energy() < 1.0e-14 && !g.busy())
            && self.fills.iter().all(|f| !f.busy())
            && !self.rain.busy()
            && self.brook_held.left == 0
            && self.brook_held.fader == 0.0
            && self.surf_held.left == 0
            && self.surf_held.fader == 0.0
            && self.slosh_held.left == 0
            && !self.tub.busy()
    }

    /// One sample, `[left, right]`, full scale at [`WATER_FULL_SCALE_PA`].
    pub fn next_frame(&mut self) -> [f32; 2] {
        let mut out = [0.0f32; 2];
        let mut add = |src: Source, v: [f32; 2], levels: &mut [f32; SOURCES], mix: &[f32; SOURCES], decay: f32| {
            let g = mix[src.index()];
            let (l, r) = (v[0] * g, v[1] * g);
            out[0] += l;
            out[1] += r;
            let i = src.index();
            levels[i] = (levels[i] * decay).max(l.abs().max(r.abs()));
        };
        let (mix, decay) = (self.mix, self.level_decay);
        let mut levels = self.levels;

        if self.pond.busy() {
            add(Source::Drip, self.pond.next_frame(), &mut levels, &mix, decay);
        }
        let mut glass = [0.0f32; 2];
        for g in self.glasses.iter_mut() {
            if g.busy() || g.wall_energy() > 1.0e-14 {
                let [l, r] = g.next_frame();
                glass[0] += l;
                glass[1] += r;
            }
        }
        add(Source::Glass, glass, &mut levels, &mix, decay);
        let mut fill = [0.0f32; 2];
        for f in self.fills.iter_mut() {
            if f.busy() {
                let [l, r] = f.next_frame();
                fill[0] += l;
                fill[1] += r;
            }
        }
        add(Source::Fill, fill, &mut levels, &mix, decay);

        // Rain stops when its notes run out; the drops already landed ring on.
        if self.rain_held.left > 0 {
            self.rain_held.left -= 1;
            if self.rain_held.left == 0 {
                self.rain.set_rate(0.0);
            }
        }
        if self.rain.busy() {
            let g = rain_gain(self.rain.target);
            let [l, r] = self.rain.next_frame();
            add(Source::Rain, [l * g, r * g], &mut levels, &mix, decay);
        }

        // The brook and the surf keep flowing; the listener walks up to them for a note.
        let [up, down] = self.fader_step;
        for (held, waves, src, slow) in [(&mut self.brook_held, &mut self.brook, Source::Brook, 1.0f32), (&mut self.surf_held, &mut self.surf, Source::Surf, 0.25)] {
            let target = if held.left > 0 { 1.0 } else { 0.0 };
            held.left = held.left.saturating_sub(1);
            held.fader = if target > held.fader { (held.fader + up * slow).min(1.0) } else { (held.fader - down * slow).max(0.0) };
            if held.fader > 0.0 {
                let [l, r] = waves.next_frame();
                add(src, [l * held.fader, r * held.fader], &mut levels, &mix, decay);
            }
        }

        // The tub is shaken while its notes last, then settles.
        if self.slosh_held.left > 0 {
            self.slosh_held.left -= 1;
            if self.slosh_held.left == 0 {
                self.tub.set_motion(Motion::Still);
            }
        }
        if self.slosh_held.left > 0 || self.tub.busy() {
            add(Source::Slosh, self.tub.next_frame(), &mut levels, &mix, decay);
        }
        self.levels = levels;
        [out[0] / WATER_FULL_SCALE_PA, out[1] / WATER_FULL_SCALE_PA]
    }

    /// What it is doing now.
    pub fn state(&self) -> WaterState {
        let mut s = WaterState { levels: self.levels.map(|v| v / WATER_FULL_SCALE_PA), last_drip: self.pond.bubbles().last_freq, drips: self.pond.drops, bubbles: self.pond.bubbles().ringing(), ..Default::default() };
        for (k, g) in self.glasses.iter().enumerate() {
            s.glass_pitch[k] = self.glass_pitch[k];
            s.glass_energy[k] = g.wall_energy();
            s.glass_level[k] = g.level();
            s.glass_height[k] = g.spec.height;
        }
        for (k, f) in self.fills.iter().enumerate() {
            s.fill_level[k] = f.level() / f.spec.total_height().max(1.0e-6);
            s.fill_pitch[k] = f.air_pitch();
            s.filling[k] = f.pouring();
        }
        s.rain_rate = self.rain.rate();
        s.raindrops = self.rain.report.landed;
        s.brook_speed = if self.brook_held.fader > 0.0 { self.brook.velocity(self.brook.cells() / 2).abs() } else { 0.0 };
        s.brook_dissipation = self.brook.report.dissipation;
        s.surf_height = if let super::waves::End::Sea { height, .. } = self.surf.spec.left { height * self.surf_held.fader } else { 0.0 };
        s.surf_breakers = self.surf.report.breakers;
        s.slosh = if let Motion::Shake { amplitude, .. } = self.tub.spec.motion { amplitude / 0.012 } else { 0.0 };
        s.slosh_bores = self.tub.report.bores;
        s
    }

    /// The tub's surface (for the view): heights above the still level at `n` points along it, m.
    pub fn tub_surface(&self, out: &mut [f32]) {
        let n = out.len().max(1);
        let cells = self.tub.cells();
        for (i, o) in out.iter_mut().enumerate() {
            let c = (i * cells / n).min(cells - 1);
            *o = self.tub.surface(c) - self.tub.spec.depth;
        }
    }
}

// ------------------------------------------------------------------------------------------
// What the view reads
// ------------------------------------------------------------------------------------------

fn load(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}
fn store(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed)
}

/// What a live water track publishes, lock-free.
#[derive(Default)]
pub struct WaterShared {
    active: AtomicU32,
    version: AtomicU64,
    levels: [AtomicU32; SOURCES],
    last_drip: AtomicU32,
    drips: AtomicU64,
    bubbles: AtomicU32,
    glass: [[AtomicU32; 4]; GLASSES],
    fill: [[AtomicU32; 2]; FILLS],
    filling: [AtomicBool; FILLS],
    rain: [AtomicU32; 2],
    brook: [AtomicU32; 2],
    surf: [AtomicU32; 2],
    slosh: [AtomicU32; 2],
}

impl WaterShared {
    pub fn active_voices(&self) -> u32 {
        self.active.load(Ordering::Relaxed)
    }

    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    fn publish(&self, s: &WaterState) {
        for (a, v) in self.levels.iter().zip(s.levels) {
            store(a, v);
        }
        store(&self.last_drip, s.last_drip);
        self.drips.store(s.drips, Ordering::Relaxed);
        self.bubbles.store(s.bubbles as u32, Ordering::Relaxed);
        for k in 0..GLASSES {
            for (a, v) in self.glass[k].iter().zip([s.glass_pitch[k], s.glass_energy[k], s.glass_level[k], s.glass_height[k]]) {
                store(a, v);
            }
        }
        for k in 0..FILLS {
            store(&self.fill[k][0], s.fill_level[k]);
            store(&self.fill[k][1], s.fill_pitch[k]);
            self.filling[k].store(s.filling[k], Ordering::Relaxed);
        }
        store(&self.rain[0], s.rain_rate);
        store(&self.rain[1], s.raindrops as f32);
        store(&self.brook[0], s.brook_speed);
        store(&self.brook[1], s.brook_dissipation);
        store(&self.surf[0], s.surf_height);
        store(&self.surf[1], s.surf_breakers as f32);
        store(&self.slosh[0], s.slosh);
        store(&self.slosh[1], s.slosh_bores as f32);
        self.version.fetch_add(1, Ordering::Release);
    }

    /// What was last published.
    pub fn state(&self) -> WaterState {
        let mut s = WaterState { levels: std::array::from_fn(|i| load(&self.levels[i])), last_drip: load(&self.last_drip), drips: self.drips.load(Ordering::Relaxed), bubbles: self.bubbles.load(Ordering::Relaxed) as usize, ..Default::default() };
        for k in 0..GLASSES {
            s.glass_pitch[k] = load(&self.glass[k][0]);
            s.glass_energy[k] = load(&self.glass[k][1]);
            s.glass_level[k] = load(&self.glass[k][2]);
            s.glass_height[k] = load(&self.glass[k][3]);
        }
        for k in 0..FILLS {
            s.fill_level[k] = load(&self.fill[k][0]);
            s.fill_pitch[k] = load(&self.fill[k][1]);
            s.filling[k] = self.filling[k].load(Ordering::Relaxed);
        }
        s.rain_rate = load(&self.rain[0]);
        s.raindrops = load(&self.rain[1]) as f64;
        s.brook_speed = load(&self.brook[0]);
        s.brook_dissipation = load(&self.brook[1]);
        s.surf_height = load(&self.surf[0]);
        s.surf_breakers = load(&self.surf[1]) as u64;
        s.slosh = load(&self.slosh[0]);
        s.slosh_bores = load(&self.slosh[1]) as u32;
        s
    }
}

// ------------------------------------------------------------------------------------------
// The live voice
// ------------------------------------------------------------------------------------------

/// How often (output samples) the voice publishes.
const PUBLISH_EVERY: u32 = 1024;

/// The caller's side of a live water track (as `KitHandle`).
pub struct WaterHandle {
    queue: Mutex<(Vec<WaterCommand>, bool)>,
    spec: WaterSpec,
}

impl WaterHandle {
    pub fn send(&self, cmd: WaterCommand) -> Result<(), WaterCommand> {
        let mut q = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        if !q.1 {
            return Err(cmd);
        }
        q.0.push(cmd);
        Ok(())
    }

    pub fn is_alive(&self) -> bool {
        self.queue.lock().unwrap_or_else(|p| p.into_inner()).1
    }

    pub fn spec(&self) -> WaterSpec {
        self.spec
    }

    pub fn retire(&self) {
        self.queue.lock().unwrap_or_else(|p| p.into_inner()).1 = false;
    }
}

/// A water instrument on a track's bus, as a `rodio::Source` (interleaved stereo at the engine rate).
pub struct WaterVoice {
    water: Water,
    shared: Arc<WaterShared>,
    handle: Arc<WaterHandle>,
    pending: Vec<WaterCommand>,
    countdown: u32,
    buf: [f32; 2],
    idx: u8,
    done: bool,
}

impl WaterVoice {
    pub fn new(shared: Arc<WaterShared>, water: Water) -> (Self, Arc<WaterHandle>) {
        shared.active.fetch_add(1, Ordering::Relaxed);
        let handle = Arc::new(WaterHandle { queue: Mutex::new((Vec::with_capacity(256), true)), spec: water.spec });
        (Self { water, shared, handle: handle.clone(), pending: Vec::with_capacity(256), countdown: 0, buf: [0.0; 2], idx: 0, done: false }, handle)
    }

    fn next_frame(&mut self) -> Option<[f32; 2]> {
        if self.countdown % 32 == 0 {
            if let Ok(mut q) = self.handle.queue.try_lock() {
                std::mem::swap(&mut q.0, &mut self.pending);
                if !q.1 {
                    self.done = true;
                }
            }
            for cmd in self.pending.drain(..) {
                self.water.command(cmd);
            }
        }
        if self.done {
            return None;
        }
        let frame = self.water.next_frame();
        if self.countdown == 0 {
            self.shared.publish(&self.water.state());
            self.countdown = PUBLISH_EVERY;
        }
        self.countdown -= 1;
        Some(frame)
    }
}

impl std::ops::Drop for WaterVoice {
    fn drop(&mut self) {
        self.shared.active.fetch_sub(1, Ordering::Relaxed);
        self.handle.queue.lock().unwrap_or_else(|p| p.into_inner()).1 = false;
    }
}

impl Iterator for WaterVoice {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.idx == 0 {
            self.buf = self.next_frame()?;
        }
        let v = self.buf[self.idx as usize];
        self.idx = (self.idx + 1) % 2;
        Some(v)
    }
}

impl RodioSource for WaterVoice {
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

/// Renders a track's notes (seconds from the start, already solved into commands) on one water
/// instrument, the way the track plays them live. Interleaved stereo at the engine rate, until the
/// water is silent (at most `tail` s past the last note's end).
pub fn render_water_performance(spec: WaterSpec, mix: [f32; SOURCES], notes: &[(f64, WaterCommand)], tail: f32) -> Vec<f32> {
    if notes.is_empty() {
        return Vec::new();
    }
    let sr = ENGINE_SAMPLE_RATE as f32;
    let mut order: Vec<(u64, WaterCommand)> = notes.iter().map(|(t, c)| ((t.max(0.0) * sr as f64).round() as u64, *c)).collect();
    order.sort_by_key(|n| n.0);
    let length = |c: &WaterCommand| match *c {
        WaterCommand::Fill { pour, .. } => pour.duration,
        WaterCommand::Rain { duration, .. } | WaterCommand::Brook { duration, .. } | WaterCommand::Surf { duration, .. } | WaterCommand::Slosh { duration, .. } => duration,
        _ => 0.0,
    };
    let last = order.iter().map(|(at, c)| at + (length(c) * sr) as u64).max().unwrap_or(0);
    let hard_end = last + (tail.max(0.0) * sr) as u64;
    let mut water = Water::new(spec, sr);
    water.set_mix(mix);
    let mut out = Vec::with_capacity(((last as f32 + sr) as usize).min(sr as usize * 600) * 2);
    let (mut next, mut t) = (0, 0u64);
    loop {
        while next < order.len() && order[next].0 <= t {
            water.command(order[next].1);
            next += 1;
        }
        let [l, r] = water.next_frame();
        out.push(l);
        out.push(r);
        t += 1;
        if next >= order.len() && (t >= hard_end || (t > last && t % 1024 == 0 && water.is_silent())) {
            break;
        }
    }
    out
}

// ------------------------------------------------------------------------------------------
// Registry: one WaterShared per id (a track)
// ------------------------------------------------------------------------------------------

fn registry() -> &'static Mutex<HashMap<String, Arc<WaterShared>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<WaterShared>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn shared_for(id: &str) -> Arc<WaterShared> {
    registry().lock().unwrap_or_else(|p| p.into_inner()).entry(id.to_string()).or_default().clone()
}

pub fn get_shared(id: &str) -> Option<Arc<WaterShared>> {
    registry().lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned()
}

pub fn remove_shared(id: &str) -> bool {
    registry().lock().unwrap_or_else(|p| p.into_inner()).remove(id).is_some()
}
