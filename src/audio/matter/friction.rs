//! Friction between any two surfaces, and the roughness of the surface slid over.
//!
//! **The friction law is the bow's** (`physmod::friction`): a coefficient that falls from its static
//! value `mu_s` toward its sliding value `mu_d` as the relative speed grows,
//! `mu(v) = mu_d + (mu_s - mu_d) v0 / (v0 + |v|)`, times the normal force, with stick-slip
//! hysteresis, solved every sample against how the two sides move under a force. What generalizes
//! it from bow-on-string to anything-on-anything is where the numbers come from: the normal force is
//! no longer a bow force the player sets but whatever the contact model (`contact`) solves between
//! the two bodies that sample, so it jumps when the tip lands on a bump and vanishes when it leaves
//! the surface; and the pair's coefficients are the pair's ([`FrictionPair`]).
//!
//! **Roughness** ([`Roughness`]) is the surface's height along the path the tip takes. Real surfaces
//! are rough at every scale down to the grain of the material, with a power-law spectrum (the
//! "fractal" surfaces of tribology): here as a sum of octaves of smooth gradient noise, from a
//! longest wavelength (`correlation`) down, each octave's height falling as `wavelength^hurst`,
//! scaled to a total RMS height. Two physical limits cut it off at the short end:
//!
//! * **The tip can't follow what is sharper than itself.** A sphere of radius `R` rides over a
//!   ripple of height `A` and wavenumber `k` only while the ripple's curvature `A k^2` is below
//!   `1 / R`; beyond that it bridges the valleys. So each octave's height is capped at `1 / (R k^2)`:
//!   a fine steel wire feels much more of a coated head's grain than a fingertip does.
//! * **A wavelength shorter than the tip travels in two samples can't be represented** - the
//!   surface's version of "a mode above Nyquist is simply dropped". Those octaves fade out as the
//!   tip speeds up.
//!
//! Grooves ([`Grooves`]: a washboard, a guiro, the ridges of a ratchet) are a periodic profile on
//! top: asymmetric ramps, band-limited the same way.
//!
//! The surface's slope matters as much as its height: the contact force acts along the surface's
//! normal, so where the tip climbs a bump of slope `z'` the normal force pushes it back by `N z'`
//! and friction pushes the surface down by `F z'`. That is the coupling between the tangential
//! stick-slip and the normal motion that makes the sound, and on a rougher surface it is stronger.

use crate::audio::physmod::friction::FrictionCurve;

/// Friction coefficients of a pair of surfaces, dry unless named otherwise. Typical values from the
/// tribology literature (static and kinetic coefficients as tabulated for these pairs; the
/// Stribeck velocity `v0` of a few cm/s for dry contacts, larger for lubricated or compliant ones),
/// not tuned by ear.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrictionPair {
    pub curve: FrictionCurve,
}

impl FrictionPair {
    pub const fn new(mu_s: f32, mu_d: f32, v0: f32) -> Self {
        Self { curve: FrictionCurve { mu_s, mu_d, v0 } }
    }
    /// Rubber on clean glass: grips hard, then lets go.
    pub const RUBBER_GLASS: FrictionPair = FrictionPair::new(1.2, 0.8, 0.05);
    /// A clean, wet fingertip on glass (the glass harp): a strong drop from static to sliding.
    pub const WET_FINGER_GLASS: FrictionPair = FrictionPair::new(0.9, 0.35, 0.02);
    /// A dry fingertip on a smooth surface.
    pub const FINGER: FrictionPair = FrictionPair::new(0.6, 0.45, 0.1);
    /// Steel on steel, dry.
    pub const STEEL_STEEL: FrictionPair = FrictionPair::new(0.75, 0.5, 0.02);
    /// Steel wire on a drumhead's coating (a brush): the coating's grit.
    pub const STEEL_COATED_HEAD: FrictionPair = FrictionPair::new(0.45, 0.3, 0.1);
    /// Steel on smooth polyester film.
    pub const STEEL_FILM: FrictionPair = FrictionPair::new(0.3, 0.22, 0.1);
    /// Steel on bronze (a brush or a rod on a cymbal).
    pub const STEEL_BRONZE: FrictionPair = FrictionPair::new(0.5, 0.35, 0.05);
    /// Wood on wood, dry.
    pub const WOOD_WOOD: FrictionPair = FrictionPair::new(0.5, 0.3, 0.05);
    /// Wood on metal.
    pub const WOOD_METAL: FrictionPair = FrictionPair::new(0.4, 0.3, 0.05);
    /// Stone on stone.
    pub const STONE_STONE: FrictionPair = FrictionPair::new(0.7, 0.55, 0.05);

    /// The coefficient while sliding at relative speed `v` (m/s).
    pub fn mu(&self, v: f32) -> f32 {
        let c = self.curve;
        c.mu_d + (c.mu_s - c.mu_d) * c.v0 / (c.v0 + v.abs())
    }
}

/// A periodic profile of ridges: a washboard, a guiro, a file.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grooves {
    /// Distance between ridges, m.
    pub period: f32,
    /// Ridge height, m.
    pub depth: f32,
}

/// The surface's height profile along a path. See the module notes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Roughness {
    /// RMS height of the random part, m (a coated drumhead's grain is some microns; polished glass a
    /// few nanometres).
    pub rms: f32,
    /// Its longest wavelength, m.
    pub correlation: f32,
    /// Its shortest wavelength, m (the material's own grain; beyond it the surface is smooth).
    pub grain: f32,
    /// How the height falls with wavelength (0..1; about 0.8 for most machined and coated surfaces).
    pub hurst: f32,
    pub grooves: Option<Grooves>,
    pub seed: u32,
}

impl Roughness {
    /// No texture at all.
    pub const SMOOTH: Roughness = Roughness { rms: 0.0, correlation: 1.0e-3, grain: 1.0e-5, hurst: 0.8, grooves: None, seed: 1 };
    /// Polished float glass.
    pub const GLASS: Roughness = Roughness { rms: 5.0e-9, correlation: 2.0e-3, grain: 2.0e-6, hurst: 0.8, grooves: None, seed: 1 };
    /// A coated drumhead: a sprayed, gritty layer on the film - what a brush needs to be heard.
    pub const COATED_HEAD: Roughness = Roughness { rms: 6.0e-6, correlation: 2.0e-3, grain: 2.0e-5, hurst: 0.8, grooves: None, seed: 1 };
    /// A clear (uncoated) head: smooth film.
    pub const CLEAR_HEAD: Roughness = Roughness { rms: 0.2e-6, correlation: 2.0e-3, grain: 2.0e-5, hurst: 0.8, grooves: None, seed: 1 };
    /// A lathed, hammered cymbal: the tonal grooves and hammer marks.
    pub const CYMBAL: Roughness = Roughness { rms: 4.0e-6, correlation: 4.0e-3, grain: 5.0e-5, hurst: 0.7, grooves: Some(Grooves { period: 1.0e-3, depth: 5.0e-6 }), seed: 1 };
    /// Sawn wood across the grain.
    pub const WOOD: Roughness = Roughness { rms: 15.0e-6, correlation: 3.0e-3, grain: 3.0e-5, hurst: 0.75, grooves: None, seed: 1 };
    /// Coarse sandpaper (P60).
    pub const SANDPAPER: Roughness = Roughness { rms: 80.0e-6, correlation: 1.5e-3, grain: 5.0e-5, hurst: 0.6, grooves: None, seed: 1 };

    /// The same surface `factor` times as rough (its heights scaled).
    pub fn scaled(self, factor: f32) -> Self {
        Self { rms: self.rms * factor, grooves: self.grooves.map(|g| Grooves { depth: g.depth * factor, ..g }), ..self }
    }

    /// Another patch of the same surface (a different, equally rough profile).
    pub fn seeded(self, seed: u32) -> Self {
        Self { seed, ..self }
    }
}

/// Octaves of roughness at most (from `correlation` down by halves).
const OCTAVES: usize = 14;
/// Harmonics of the grooves' sawtooth at most.
const GROOVE_HARMONICS: usize = 12;

/// A [`Roughness`] ready to be evaluated along a path, for a tip of a given size.
#[derive(Clone, Debug)]
pub struct Profile {
    /// Per octave: wavenumber (rad/m), height (m, after the tip's limit), and an offset along the
    /// path decorrelating the octaves.
    k: [f32; OCTAVES],
    amp: [f32; OCTAVES],
    shift: [f64; OCTAVES],
    octaves: usize,
    seed: u32,
    grooves: Option<Grooves>,
    /// Height of the grooves' harmonics, after the tip's limit.
    harm: [f32; GROOVE_HARMONICS],
}

/// Gradient noise: a smooth random function of `x` (in cells) with slope; value about -0.5..0.5.
#[inline]
fn noise(x: f64, seed: u32) -> (f32, f32) {
    let i = x.floor();
    let f = (x - i) as f32;
    let i = i as i64 as i32;
    let g = |c: i32| -> f32 {
        let mut h = (c as u32).wrapping_mul(0x9E37_79B1) ^ seed.wrapping_mul(0x85EB_CA77);
        h ^= h >> 15;
        h = h.wrapping_mul(0x2C1B_3C6D);
        h ^= h >> 12;
        (h >> 8) as f32 / (1u32 << 23) as f32 - 1.0
    };
    let (g0, g1) = (g(i), g(i + 1));
    let (a, b) = (g0 * f, g1 * (f - 1.0));
    // Quintic fade: the slope is continuous.
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f - 1.0) * (f - 1.0);
    (a + u * (b - a), g0 + u * (g1 - g0) + du * (b - a))
}

/// RMS of `noise` over many cells (measured once: the gradient noise's own spread).
fn noise_rms() -> f32 {
    static RMS: std::sync::OnceLock<f32> = std::sync::OnceLock::new();
    *RMS.get_or_init(|| {
        let n = 200_000;
        let s: f64 = (0..n).map(|i| noise(i as f64 * 0.0137 + 0.5, 7).0 as f64).map(|v| v * v).sum();
        (s / n as f64).sqrt() as f32
    })
}

impl Profile {
    /// `r` for a tip of radius `tip_radius` m (0: a point, which follows everything).
    pub fn new(r: Roughness, tip_radius: f32) -> Self {
        let mut p = Profile { k: [0.0; OCTAVES], amp: [0.0; OCTAVES], shift: [0.0; OCTAVES], octaves: 0, seed: r.seed, grooves: r.grooves, harm: [0.0; GROOVE_HARMONICS] };
        let curvature_limit = |k: f32| if tip_radius > 0.0 { 1.0 / (tip_radius * k * k) } else { f32::MAX };
        if r.rms > 0.0 && r.correlation > 0.0 {
            let mut lambda = r.correlation;
            let mut sum = 0.0f32;
            while p.octaves < OCTAVES && lambda >= r.grain.max(1.0e-9) {
                let o = p.octaves;
                p.k[o] = std::f32::consts::TAU / lambda;
                p.amp[o] = (lambda / r.correlation).powf(r.hurst);
                sum += p.amp[o] * p.amp[o];
                let mut h = r.seed.wrapping_mul(747_796_405).wrapping_add(o as u32 * 2_891_336_453);
                h ^= h >> 16;
                p.shift[o] = (h % 1000) as f64 * 1.0e-3;
                p.octaves += 1;
                lambda *= 0.5;
            }
            // Scale the octaves to the RMS height asked for, then let the tip bridge what it can't
            // follow. (The noise of one octave has period one cell = its wavelength.)
            let scale = r.rms / (sum.sqrt() * noise_rms()).max(1.0e-30);
            for o in 0..p.octaves {
                let a = p.amp[o] * scale;
                // Peak height of the octave is about twice its RMS.
                let rms_o = a * noise_rms();
                p.amp[o] = a * (curvature_limit(p.k[o]) / (2.0 * rms_o).max(1.0e-30)).min(1.0);
            }
        }
        if let Some(g) = r.grooves {
            // A sawtooth ridge: slow climb, sharp drop (a ratchet's teeth), as a Fourier series.
            let k1 = std::f32::consts::TAU / g.period.max(1.0e-6);
            for n in 0..GROOVE_HARMONICS {
                let kn = k1 * (n + 1) as f32;
                let a = g.depth / (std::f32::consts::PI * (n + 1) as f32);
                p.harm[n] = a.min(curvature_limit(kn));
            }
        }
        p
    }

    /// Height (m) and slope at distance `s` (m) along the path, leaving out wavelengths shorter than
    /// `shortest` m (see the module notes: `2 |v| h` for a tip moving at `v`). Octaves fade out over
    /// the octave above the cut, so a change of speed doesn't click.
    pub fn at(&self, s: f64, shortest: f32) -> (f32, f32) {
        let (mut z, mut dz) = (0.0f32, 0.0f32);
        let tau = std::f32::consts::TAU;
        for o in 0..self.octaves {
            let lambda = tau / self.k[o];
            let fade = ((lambda / shortest.max(1.0e-12) - 1.0).clamp(0.0, 1.0)) * self.amp[o];
            if fade == 0.0 {
                break;
            }
            let cells = s / lambda as f64 + self.shift[o];
            let (v, d) = noise(cells, self.seed.wrapping_add(o as u32 * 101));
            z += fade * v;
            dz += fade * d / lambda;
        }
        if let Some(g) = self.grooves {
            let k1 = tau / g.period.max(1.0e-6);
            for (n, &a) in self.harm.iter().enumerate() {
                let kn = k1 * (n + 1) as f32;
                let lambda = tau / kn;
                let fade = (lambda / shortest.max(1.0e-12) - 1.0).clamp(0.0, 1.0) * a;
                if fade == 0.0 {
                    break;
                }
                let (sn, cs) = ((kn as f64 * s).rem_euclid(std::f64::consts::TAU) as f32).sin_cos();
                z -= fade * sn;
                dz -= fade * kn * cs;
            }
        }
        (z, dz)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measured(p: &Profile, shortest: f32, length: f32, step: f32) -> (f32, f32) {
        let n = (length / step) as usize;
        let (mut zz, mut dd) = (0.0f64, 0.0f64);
        for i in 0..n {
            let (z, d) = p.at(i as f64 * step as f64, shortest);
            zz += (z as f64).powi(2);
            dd += (d as f64).powi(2);
        }
        (((zz / n as f64).sqrt()) as f32, ((dd / n as f64).sqrt()) as f32)
    }

    #[test]
    fn a_profile_has_the_rms_height_asked_for() {
        let p = Profile::new(Roughness::COATED_HEAD, 0.0);
        let (rms, _) = measured(&p, 0.0, 2.0, 1.0e-6);
        assert!((rms / Roughness::COATED_HEAD.rms - 1.0).abs() < 0.1, "{rms}");
    }

    #[test]
    fn the_slope_is_the_derivative_of_the_height() {
        let p = Profile::new(Roughness { grooves: Some(Grooves { period: 2.0e-3, depth: 3.0e-5 }), ..Roughness::WOOD }, 0.0);
        let e = 1.0e-7;
        for i in 0..200 {
            let s = i as f64 * 3.7e-4 + 0.01;
            let (_, d) = p.at(s, 0.0);
            let fd = (p.at(s + e, 0.0).0 as f64 - p.at(s - e, 0.0).0 as f64) / (2.0 * e);
            assert!((d as f64 - fd).abs() < 0.02 * d.abs().max(0.01) as f64 + 1.0e-3, "at {s}: {d} vs {fd}");
        }
    }

    #[test]
    fn a_blunt_tip_feels_less_of_the_fine_grain_and_speed_cuts_the_finest() {
        let sharp = Profile::new(Roughness::COATED_HEAD, 0.15e-3);
        let blunt = Profile::new(Roughness::COATED_HEAD, 8.0e-3);
        let (_, slope_sharp) = measured(&sharp, 0.0, 0.2, 1.0e-6);
        let (_, slope_blunt) = measured(&blunt, 0.0, 0.2, 1.0e-6);
        assert!(slope_blunt < 0.5 * slope_sharp, "{slope_blunt} vs {slope_sharp}");
        let (_, slow) = measured(&sharp, 2.0 * 0.05 / 44_100.0, 0.2, 1.0e-6);
        let (_, fast) = measured(&sharp, 2.0 * 2.0 / 44_100.0, 0.2, 1.0e-6);
        assert!(fast < slow, "{fast} vs {slow}");
    }
}
