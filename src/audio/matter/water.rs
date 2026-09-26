//! Water, put together: open water to drip into, and offline renders of every kind of water sound
//! the family has (drips, glasses, pouring, sloshing, brooks, surf, rain on things).
//!
//! The pieces are `bubble` (the bubbles that are most of water's voice), `drop` (droplets as
//! strikers: on water, entraining bubbles; on solids, splashing), `vessel` (the air over water in a
//! container, pouring, glasses tuned by their water), `waves` (a coarse simulation of the surface
//! whose breaking drives bubble populations) and `rain` (a flux of real raindrop sizes onto any body).
//! Here they are given a place to happen and a listener.
//!
//! Every function returns interleaved stereo in pascals at the listener; [`WATER_FULL_SCALE_PA`] is
//! the level the live voice maps to full scale (water is quiet: a drip's plink at half a metre is a
//! few hundredths of a pascal, a drum hit hundreds of times more).

use super::bubble::{Birth, BubbleBank, Rng};
use super::drop::{entrain, Drop};
use super::drum::StrikerSpec;
use super::rain::{Rain, RainTarget};
use super::vessel::{GlassSpec, Pour, Vessel, VesselSpec};
use super::waves::{Waves, WavesSpec};

/// Pressure (Pa) the live voice maps to full scale.
pub const WATER_FULL_SCALE_PA: f32 = 0.5;

/// Open water - a basin, a pond - with a listener above it: where drips land and bubbles ring.
pub struct Pond {
    sr: f32,
    bubbles: BubbleBank,
    rng: Rng,
    births: [Birth; 2],
    /// Depth of the water, m, and the listener's height above it, m.
    pub depth: f32,
    pub listener: f32,
    /// Drops landed so far, and the last one: where it landed (m to the listener's right) and what
    /// it was.
    pub drops: u64,
    pub last_x: f32,
    pub last_drop: Option<Drop>,
}

impl Pond {
    pub fn new(depth: f32, listener: f32, sr: f32) -> Self {
        let mut bubbles = BubbleBank::with_capacity(96, sr);
        bubbles.water_depth = depth;
        Self { sr, bubbles, rng: Rng::new(11), births: [Birth::new(1.0e-3, 1.0e-3); 2], depth, listener, drops: 0, last_x: 0.0, last_drop: None }
    }

    pub fn bubbles(&self) -> &BubbleBank {
        &self.bubbles
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    /// A drop lands at `x` m to the listener's right (0 below them). Returns the frequency the
    /// bubble it entrains rings at when born, if it entrains one.
    pub fn drip(&mut self, drop: Drop, x: f32) -> Option<f32> {
        let dist = (x * x + self.listener * self.listener).sqrt().max(0.05);
        let pan = x / dist;
        self.drops += 1;
        self.last_x = x;
        self.last_drop = Some(drop);
        let n = entrain(drop, self.depth, &mut self.rng, &mut self.births);
        let mut freq = None;
        for i in 0..n {
            let mut b = self.births[i];
            b.pan = pan;
            b.distance = dist;
            if self.bubbles.spawn(b) {
                freq = Some(self.bubbles.last_freq);
            }
        }
        freq
    }

    /// Makes a bubble of `radius` ring at `depth` under the surface directly (a bubble released from
    /// below: an air stone, a sunken bottle's glug).
    pub fn release(&mut self, radius: f32, depth: f32, x: f32) -> bool {
        let dist = (x * x + self.listener * self.listener).sqrt().max(0.05);
        let mut b = Birth::new(radius, depth);
        b.pan = x / dist;
        b.distance = dist;
        self.bubbles.spawn(b)
    }

    pub fn busy(&self) -> bool {
        !self.bubbles.is_silent()
    }

    /// Where a bubble born with `pan` is, m to the listener's right (the inverse of the pan a drop
    /// landing at `x` is given).
    pub fn x_of(&self, pan: f32) -> f32 {
        let p = pan.clamp(-0.999, 0.999);
        p * self.listener / (1.0 - p * p).sqrt()
    }

    /// One sample, `[left, right]` in pascals.
    pub fn next_frame(&mut self) -> [f32; 2] {
        self.bubbles.next().0
    }
}

fn run(seconds: f32, sr: f32, mut f: impl FnMut(usize) -> [f32; 2]) -> Vec<f32> {
    let n = (seconds * sr) as usize;
    let mut out = Vec::with_capacity(2 * n);
    for i in 0..n {
        let [l, r] = f(i);
        out.push(l);
        out.push(r);
    }
    out
}

/// Drops `(seconds, drop, x)` into a basin 10 cm deep, heard from 40 cm above it.
pub fn render_drips(drips: &[(f32, Drop, f32)], sr: f32, tail: f32) -> Vec<f32> {
    let mut pond = Pond::new(0.1, 0.4, sr);
    let mut order: Vec<&(f32, Drop, f32)> = drips.iter().collect();
    order.sort_by(|a, b| a.0.total_cmp(&b.0));
    let end = order.last().map_or(0.0, |d| d.0) + tail;
    let mut next = 0;
    run(end, sr, |i| {
        while next < order.len() && (order[next].0 * sr) as usize <= i {
            pond.drip(order[next].1, order[next].2);
            next += 1;
        }
        pond.next_frame()
    })
}

/// A glass tuned by its water to each note `(seconds, pitch Hz, speed m/s)`, struck with `striker`
/// on the rim, heard from 50 cm: a glass harp. Each note gets the glass [`GlassSpec::tuned`] gives it.
pub fn render_glasses(notes: &[(f32, f32, f32)], striker: StrikerSpec, sr: f32, tail: f32) -> Vec<f32> {
    let mut glasses: Vec<(f32, Vessel)> = Vec::new();
    let mut order: Vec<&(f32, f32, f32)> = notes.iter().collect();
    order.sort_by(|a, b| a.0.total_cmp(&b.0));
    for &&(_, pitch, _) in &order {
        if !glasses.iter().any(|(p, _)| *p == pitch) {
            let (g, level) = GlassSpec::tuned(pitch);
            let mut v = Vessel::new(g.vessel, level, 0.5, sr);
            v.pan = ((pitch.log2() - 9.0) * 0.3).clamp(-0.8, 0.8);
            glasses.push((pitch, v));
        }
    }
    let end = order.last().map_or(0.0, |d| d.0) + tail;
    let mut next = 0;
    run(end, sr, |i| {
        while next < order.len() && (order[next].0 * sr) as usize <= i {
            let (_, pitch, speed) = *order[next];
            if let Some((_, v)) = glasses.iter_mut().find(|(p, _)| *p == pitch) {
                v.strike(speed, striker);
            }
            next += 1;
        }
        let mut out = [0.0f32; 2];
        for (_, v) in glasses.iter_mut() {
            let [l, r] = v.next_frame();
            out[0] += l;
            out[1] += r;
        }
        out
    })
}

/// Pours into `vessel` (from `level` m) as `pour` says, heard from 40 cm; renders `tail` s past the
/// end of the pour. Also returns the level at the end.
pub fn render_pour(vessel: VesselSpec, level: f32, pour: Pour, sr: f32, tail: f32) -> (Vec<f32>, f32) {
    let mut v = Vessel::new(vessel, level, 0.4, sr);
    v.pour(pour);
    let out = run(pour.duration + tail, sr, |_| v.next_frame());
    (out, v.level())
}

/// Moving water (a tub shaken, a brook, surf) for `seconds`.
pub fn render_waves(spec: WavesSpec, sr: f32, seconds: f32) -> Vec<f32> {
    let mut w = Waves::new(spec, sr);
    run(seconds, sr, |_| w.next_frame())
}

/// Rain of `rate` mm/h on `target` for `seconds`, heard from `distance` m (for the lake: the radius
/// of water around the listener).
pub fn render_rain(target: RainTarget, rate: f32, distance: f32, sr: f32, seconds: f32) -> Vec<f32> {
    let mut r = Rain::new(target, rate, distance, 5, sr);
    run(seconds, sr, |_| r.next_frame())
}
