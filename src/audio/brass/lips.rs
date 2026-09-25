//! The player's lips: a mass-spring valve that the breath blows open.
//!
//! The lips are one damped oscillator per unit area (the "outward-striking" or "swinging door"
//! valve of brass acoustics). Their opening `h` is pushed open by the difference between the mouth
//! pressure `p_m` and the mouthpiece pressure `p`, and pulled back toward its rest opening `h0` by
//! the lip tissue's stiffness:
//!
//! ```text
//! h'' + (w_l / Q_l) h' + w_l^2 (h - h0) = (p_m - p) / mu
//! ```
//!
//! Air goes through the slit as a Bernoulli jet, `U = w h sqrt(2 |p_m - p| / rho)` (width `w`),
//! whose kinetic energy is lost as turbulence in the cup. The mouthpiece pressure depends on the
//! flow (the air column's impedance), so the two are solved together each sample, in closed form -
//! the same kind of solve the bow does against the string. When the lips close (`h` reaches 0)
//! the flow stops and they meet a stiff, lossy contact instead of passing through each other.
//!
//! Nothing here sets a pitch. The lips' own resonance (`w_l`, which the player controls with lip
//! tension) decides which of the air column's resonances they fall in with, and the column's
//! feedback does the rest: the oscillation's threshold, its pitch, its spectrum and how it changes
//! with breath all come from this coupling.

use super::impedance::RHO;

/// A player's lips for one instrument (physical units).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LipSpec {
    /// Mass per unit area, kg/m².
    pub mu: f32,
    /// Quality factor of the lips' own resonance (they are heavily damped: a few).
    pub q: f32,
    /// Width of the lip opening, metres.
    pub width: f32,
    /// Opening at rest (no pressure difference), metres.
    pub h0: f32,
}

impl LipSpec {
    /// A trombonist's lips (after the one-mass model values used in the brass-acoustics
    /// literature: a few kg/m², a Q of several, a slit about 12 mm wide). The mass is set per note by
    /// the player (see `engine::lip_mass`).
    pub const fn trombone() -> Self {
        Self { mu: 1.5, q: 7.0, width: 0.012, h0: 1.0e-4 }
    }
}

/// Contact stiffness and damping when the lips meet, relative to their own resonance.
const CONTACT_STIFFNESS: f32 = 16.0;
const CONTACT_DAMPING: f32 = 1.5;

#[derive(Clone, Copy, Debug)]
pub struct Lips {
    pub spec: LipSpec,
    /// Lip resonance, Hz.
    pub freq: f32,
    /// Opening, metres, and its rate of change.
    pub h: f32,
    pub v: f32,
    /// This sample's flow (m³/s) and mouthpiece pressure (Pa).
    pub flow: f32,
    pub pressure: f32,
}

impl Lips {
    pub fn new(spec: LipSpec) -> Self {
        Self { spec, freq: 200.0, h: spec.h0, v: 0.0, flow: 0.0, pressure: 0.0 }
    }

    pub fn reset(&mut self) {
        self.h = self.spec.h0;
        self.v = 0.0;
        self.flow = 0.0;
        self.pressure = 0.0;
    }

    /// One sample. `incoming` is the wave arriving at the lips from the air column and `z0` the
    /// column's impedance there. Returns the wave to send into the column. `rest_scale` multiplies
    /// the rest opening (the player's aperture; 0 is lips pressed shut, as behind the tongue).
    #[inline]
    pub fn tick(&mut self, p_mouth: f32, incoming: f32, z0: f32, dt: f32, rest_scale: f32) -> f32 {
        // Flow and mouthpiece pressure together: with P = p_m - 2 incoming and U = K sqrt(dp),
        // dp = P - z0 U gives a quadratic in sqrt(|dp|).
        let k = self.spec.width * self.h.max(0.0) * (2.0 / RHO as f32).sqrt();
        let big_p = p_mouth - 2.0 * incoming;
        let zk = z0 * k;
        let s = 0.5 * (-zk + (zk * zk + 4.0 * big_p.abs()).sqrt());
        let u = big_p.signum() * k * s;
        let p = 2.0 * incoming + z0 * u;
        self.flow = u;
        self.pressure = p;

        // The lips move under the pressure difference (semi-implicit Euler).
        let w = std::f32::consts::TAU * self.freq;
        let dp = p_mouth - p;
        let mut a = dp / self.spec.mu - (w / self.spec.q) * self.v - w * w * (self.h - self.spec.h0 * rest_scale);
        if self.h < 0.0 {
            let wc = w * CONTACT_STIFFNESS.sqrt();
            a += -wc * wc * self.h - 2.0 * CONTACT_DAMPING * wc * self.v;
        }
        self.v += a * dt;
        self.h += self.v * dt;
        incoming + z0 * u
    }

    /// Steers the lips a fraction `g` (0..1) of the way toward an opening and speed - the player
    /// guiding the first periods of a note (see `engine`'s guided attack). 0 leaves them alone.
    #[inline]
    pub fn steer(&mut self, h: f32, v: f32, g: f32) {
        self.h += (h - self.h) * g;
        self.v += (v - self.v) * g;
    }
}
