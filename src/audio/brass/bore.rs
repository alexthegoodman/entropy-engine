//! The bore: the air column's shape, as radius along its length. One description drives both the
//! acoustics (the transfer-matrix reference in [`super::impedance`] and the runtime waveguide in
//! [`super::airbore`]) and, later, the drawn instrument.
//!
//! A bore is split into three runs, because the runtime model treats them differently:
//!
//! * the **front** - mouthpiece cup, throat, backbore and leadpipe: short, strongly varying
//!   sections, modelled cell by cell;
//! * the **cylinder** - the long run of constant bore (tuning slide, trombone slide, valve tubing),
//!   modelled as a pair of fractional delay lines whose length can change while the note sounds;
//!   this is also where the wave steepens at high levels (see `airbore`'s nonlinear propagation);
//! * the **bell** - the gradual taper out of the cylinder and the flare, cell by cell, ending in the
//!   radiation load at the mouth.
//!
//! Stock profiles use published approximate dimensions of the instruments. Like the violin body's
//! modes they are illustrative defaults, not a measurement of any one instrument. What they are
//! judged by is what good instruments share: resonances that line up with a harmonic series.

/// A piece of the bore from radius `r0` to radius `r1` (metres) over `length` metres. `gamma` 0 is a
/// straight taper (a cone, or a cylinder when the radii match); above 0 it is a Bessel-horn flare,
/// `r(d) = B (d + d0)^-gamma` with `d` the distance to the section's wide end - the classic shape of a
/// brass bell, flaring faster and faster toward the mouth.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Section {
    pub length: f32,
    pub r0: f32,
    pub r1: f32,
    pub gamma: f32,
}

impl Section {
    pub const fn cone(length: f32, r0: f32, r1: f32) -> Self {
        Self { length, r0, r1, gamma: 0.0 }
    }
    pub const fn cylinder(length: f32, r: f32) -> Self {
        Self { length, r0: r, r1: r, gamma: 0.0 }
    }
    pub const fn flare(length: f32, r0: f32, r1: f32, gamma: f32) -> Self {
        Self { length, r0, r1, gamma }
    }

    /// Radius a fraction `t` (0..1) of the way along.
    pub fn radius(&self, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        if self.gamma <= 0.0 || (self.r1 - self.r0).abs() < 1.0e-7 || self.r1 <= self.r0 {
            return self.r0 + (self.r1 - self.r0) * t;
        }
        // r(d) = B (d + d0)^-g with d = distance from the wide end: r(0) = r1, r(L) = r0.
        let g = self.gamma as f64;
        let l = self.length as f64;
        let ratio = (self.r1 as f64 / self.r0 as f64).powf(1.0 / g);
        let d0 = l / (ratio - 1.0);
        let d = l * (1.0 - t as f64);
        (self.r1 as f64 * (d0 / (d + d0)).powf(g)) as f32
    }
}

/// A whole instrument's bore.
#[derive(Clone, Debug, PartialEq)]
pub struct BoreProfile {
    /// Mouthpiece and leadpipe, from the lips inward. Ends at `cylinder_radius`.
    pub front: Vec<Section>,
    pub cylinder_radius: f32,
    /// Length of the cylindrical run with the slide closed and no valves down, metres.
    pub cylinder_length: f32,
    /// Bell taper and flare, from the end of the cylinder out to the mouth. Starts at
    /// `cylinder_radius`.
    pub bell: Vec<Section>,
    /// The most tube the slide (or the longest valve combination) can add, metres.
    pub slide_max: f32,
    /// The nominal fundamental (Hz) of the series the instrument is pitched in with the slide
    /// closed: B♭1 for a tenor trombone.
    pub nominal_fundamental: f32,
}

impl BoreProfile {
    /// A tenor trombone in B♭ with a .547" (13.9 mm) bore and an 8.5" bell, slide closed: about
    /// 2.8 m of tube. The mouthpiece is roughly a medium 5G-style cup. The bell stem and flare were
    /// chosen the way a maker would - by adjusting them until the resonances line up: peaks 2-16
    /// fall within about 12 cents of the B♭ series except the 5th (+28 cents; real trombones have
    /// their own such quirks), while the first sits far below it, at about 0.68 of the fundamental,
    /// as on every real trombone (it is why the pedal note is special).
    pub fn tenor_trombone() -> Self {
        Self {
            front: vec![
                // Cup: rim to throat, a rounded bowl (two cones).
                Section::cone(0.006, 0.0127, 0.0100),
                Section::cone(0.006, 0.0100, 0.0045),
                Section::cone(0.003, 0.0045, 0.0035),
                // Throat.
                Section::cylinder(0.007, 0.0035),
                // Backbore.
                Section::cone(0.051, 0.0035, 0.0055),
                // Leadpipe (inside the inner slide).
                Section::cone(0.230, 0.0055, 0.00695),
            ],
            cylinder_radius: 0.00695,
            cylinder_length: 1.534,
            bell: vec![
                // The bell's conical tail (gooseneck and bell stem).
                Section::cone(0.411, 0.00695, 0.0120),
                // The flare, out to an 8.5" (216 mm) mouth.
                Section::flare(0.572, 0.0120, 0.108, 0.923),
            ],
            // Seventh position: six semitones down, 2^(6/12) - 1 of the whole length.
            slide_max: 1.16,
            nominal_fundamental: 58.27,
        }
    }

    pub fn front_length(&self) -> f32 {
        self.front.iter().map(|s| s.length).sum()
    }

    pub fn bell_length(&self) -> f32 {
        self.bell.iter().map(|s| s.length).sum()
    }

    /// Whole air column with `extra` metres of slide/valve tube added.
    pub fn total_length(&self, extra: f32) -> f32 {
        self.front_length() + self.cylinder_length + extra + self.bell_length()
    }

    pub fn mouth_radius(&self) -> f32 {
        self.bell.last().map(|s| s.r1).unwrap_or(self.cylinder_radius)
    }

    /// Radius at `x` metres from the lips, with `extra` metres of slide added.
    pub fn radius_at(&self, x: f32, extra: f32) -> f32 {
        let mut x = x.max(0.0);
        for s in &self.front {
            if x <= s.length {
                return s.radius(x / s.length.max(1.0e-9));
            }
            x -= s.length;
        }
        let cyl = self.cylinder_length + extra;
        if x <= cyl {
            return self.cylinder_radius;
        }
        x -= cyl;
        for s in &self.bell {
            if x <= s.length {
                return s.radius(x / s.length.max(1.0e-9));
            }
            x -= s.length;
        }
        self.mouth_radius()
    }

    /// Mean cross-section area over `[x0, x1]` (m²), integrated finely: what a cell of a staircase
    /// model should have so it holds the same volume of air as the bore it stands for.
    pub fn mean_area(&self, x0: f32, x1: f32, extra: f32) -> f32 {
        let n = (((x1 - x0) / 0.0002).ceil() as usize).clamp(1, 400);
        let dx = (x1 - x0) / n as f32;
        let mut a = 0.0;
        for i in 0..n {
            let r = self.radius_at(x0 + (i as f32 + 0.5) * dx, extra);
            a += std::f32::consts::PI * r * r;
        }
        a / n as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flare_meets_its_end_radii_and_grows_fastest_at_the_mouth() {
        let s = Section::flare(0.572, 0.0120, 0.108, 0.923);
        assert!((s.radius(0.0) - 0.0120).abs() < 1.0e-6);
        assert!((s.radius(1.0) - 0.108).abs() < 1.0e-6);
        let first = s.radius(0.1) - s.radius(0.0);
        let last = s.radius(1.0) - s.radius(0.9);
        assert!(last > 5.0 * first, "a bell flares toward the mouth: {first} vs {last}");
    }

    #[test]
    fn the_trombone_is_about_the_right_length_and_continuous() {
        let b = BoreProfile::tenor_trombone();
        let l = b.total_length(0.0);
        assert!((2.6..3.0).contains(&l), "{l}");
        // No jumps where the runs meet.
        let at = |x: f32| b.radius_at(x, 0.0);
        let f = b.front_length();
        assert!((at(f - 1.0e-4) - at(f + 1.0e-4)).abs() < 1.0e-4);
        let c = f + b.cylinder_length;
        assert!((at(c - 1.0e-4) - at(c + 1.0e-4)).abs() < 1.0e-4);
    }
}
