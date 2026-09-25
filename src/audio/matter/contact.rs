//! Contact between two bodies: **Object A <-> contact geometry <-> Object B**.
//!
//! Each side of a contact answers two questions about its point of contact (see
//! `ModalBody::predict` and [`Striker::predict`]): where the point will be after the coming sample if
//! no new force acts, and how far one newton held over that sample moves it (its one-step
//! driving-point compliance). The penetration after the step is then a straight line in the contact
//! force, `delta(F) = free_gap - (C_a + C_b) F`, and the force obeys the Hunt-Crossley law
//!
//! ```text
//! F = K delta^alpha (1 + lambda d(delta)/dt)      for delta > 0, else 0
//! ```
//!
//! so the force for the step is the root of one monotone scalar equation, found each sample with a
//! bracketed Newton iteration (never guessed, never a one-sample impulse). `K` and `alpha` come from
//! the two surfaces: Hertz's law for elastic solids (a sphere of radius `R` on a flat, `alpha = 3/2`,
//! `K = 4/3 E* sqrt(R)` with `E*` from both Young's moduli and Poisson ratios), or a stiffening power
//! law for felt, as for piano hammers. `lambda` follows Flores et al. (2011), `8 (1 - e) / (5 e v_in)`
//! for a coefficient of restitution `e` and the approach speed `v_in` at first touch - accurate over
//! the whole range of `e`, where Hunt and Crossley's own `3 (1 - e) / (2 v_in)` holds only for small
//! losses - so the contact loses the right fraction of its energy whatever the speed.
//!
//! What a player controls is physical - the striker's mass, speed, tip size and material - and the
//! rest comes out of the solve: a faster hit is a shorter contact (Hertz: `t ~ v^(-1/5)`), a harder or
//! lighter striker is shorter and brighter, a slack surface throws the striker back later, and a
//! striker can bounce more than once.

/// An elastic material, SI units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Material {
    /// Young's modulus, Pa.
    pub young: f32,
    pub poisson: f32,
    /// Density, kg/m^3.
    pub density: f32,
}

impl Material {
    pub const HICKORY: Material = Material { young: 15.0e9, poisson: 0.3, density: 820.0 };
    pub const NYLON: Material = Material { young: 3.0e9, poisson: 0.39, density: 1150.0 };
    pub const MYLAR: Material = Material { young: 4.5e9, poisson: 0.38, density: 1390.0 };
    pub const PLASTIC: Material = Material { young: 2.3e9, poisson: 0.35, density: 1050.0 };
    pub const RUBBER: Material = Material { young: 0.01e9, poisson: 0.49, density: 1100.0 };
    pub const STEEL: Material = Material { young: 200.0e9, poisson: 0.29, density: 7850.0 };
    pub const BRASS: Material = Material { young: 100.0e9, poisson: 0.34, density: 8500.0 };
    pub const GLASS: Material = Material { young: 70.0e9, poisson: 0.22, density: 2500.0 };

    /// The combined modulus `E*` of two materials in contact.
    pub fn combined(a: Material, b: Material) -> f32 {
        1.0 / ((1.0 - a.poisson * a.poisson) / a.young + (1.0 - b.poisson * b.poisson) / b.young)
    }
}

/// The striking end of a striker.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tip {
    /// An elastic sphere of `radius` metres (a stick's bead, a hard mallet, a pebble).
    Solid { radius: f32, material: Material },
    /// A felt covering: `F = stiffness * delta^exponent` (N, with delta in metres). Felt stiffens as
    /// it compresses, which is why a soft mallet is dark when played gently and brightens when played
    /// hard.
    Felt { stiffness: f32, exponent: f32 },
}

/// The law of one contact: `F = k delta^alpha (1 + lambda delta')`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContactLaw {
    pub k: f32,
    pub alpha: f32,
    /// Coefficient of restitution of the pair (1 = perfectly elastic).
    pub restitution: f32,
}

impl ContactLaw {
    /// The law between a tip and a flat surface of `surface`.
    pub fn between(tip: Tip, surface: Material, restitution: f32) -> ContactLaw {
        match tip {
            Tip::Solid { radius, material } => ContactLaw { k: 4.0 / 3.0 * Material::combined(material, surface) * radius.max(1.0e-5).sqrt(), alpha: 1.5, restitution },
            Tip::Felt { stiffness, exponent } => ContactLaw { k: stiffness, alpha: exponent, restitution },
        }
    }

    /// `delta^(alpha - 1)`, with Hertz's `alpha = 3/2` as a square root.
    #[inline]
    fn power_less_one(&self, delta: f32) -> f32 {
        if self.alpha == 1.5 { delta.sqrt() } else { delta.powf(self.alpha - 1.0) }
    }
}

/// The state of one contact between two bodies.
#[derive(Clone, Copy, Debug)]
pub struct Contact {
    pub law: ContactLaw,
    lambda: f32,
    /// Penetration after the last step (negative: the gap).
    pub delta: f32,
    /// The force over the last step, N.
    pub force: f32,
    pub touching: bool,
    /// Number of separate touches so far (a bounce makes it 2).
    pub touches: u32,
    /// Keep `lambda` as set rather than deriving it from each touch's approach speed.
    fixed_lambda: bool,
}

impl Contact {
    /// A contact whose bodies start apart. `solve` must then be called every step, from before the
    /// first touch, so it sees the approach.
    pub fn new(law: ContactLaw) -> Self {
        Self { law, lambda: 0.0, delta: f32::NEG_INFINITY, force: 0.0, touching: false, touches: 0, fixed_lambda: false }
    }

    /// A contact that starts pressed together with penetration `delta` (a snare wire lying on its
    /// head, a book on a table). Its losses are fixed from the restitution at `speed` (m/s), the
    /// typical speed of the touches it will see, since a resting contact has no approach to measure.
    pub fn resting(law: ContactLaw, delta: f32, speed: f32) -> Self {
        let e = law.restitution.clamp(0.05, 1.0);
        let force = if delta > 0.0 { law.k * delta.powf(law.alpha) } else { 0.0 };
        Self { law, lambda: 1.6 * (1.0 - e) / (e * speed.max(0.01)), delta, force, touching: delta > 0.0, touches: 1, fixed_lambda: true }
    }

    /// Solves the force for the coming step. `free_gap` is the penetration after the step if no
    /// contact force acted (position of A's point minus B's, along the direction A moves into B),
    /// `compliance` the sum of both sides' one-step compliances (m/N), `h` the step (s). Returns the
    /// force (>= 0) that A pushes B with; the caller applies `-F` to A and `+F` to B.
    pub fn solve(&mut self, free_gap: f32, compliance: f32, h: f32) -> f32 {
        let prev = self.delta;
        if free_gap <= 0.0 {
            self.delta = free_gap;
            self.force = 0.0;
            self.touching = false;
            return 0.0;
        }
        if !self.touching && self.fixed_lambda {
            self.touching = true;
            self.touches += 1;
        } else if !self.touching {
            // First touch: the approach speed sets Hunt-Crossley's damping.
            let travel = if prev.is_finite() { free_gap - prev } else { free_gap };
            let v_in = (travel / h).max(0.01);
            let e = self.law.restitution.clamp(0.05, 1.0);
            self.lambda = 1.6 * (1.0 - e) / (e * v_in);
            self.touching = true;
            self.touches += 1;
        }
        let base = prev.max(0.0);
        let c = compliance.max(0.0);
        let law = self.law;
        let lambda = self.lambda;
        // The law at force f and its slope d(law)/dF (through delta(F) = free_gap - c F).
        let at = |f: f32| -> (f32, f32) {
            let d = free_gap - c * f;
            if d <= 0.0 {
                return (0.0, 0.0);
            }
            let pm1 = law.power_less_one(d);
            let damp = 1.0 + lambda * (d - base) / h;
            let v = law.k * pm1 * d * damp;
            if v <= 0.0 {
                return (0.0, 0.0);
            }
            let dv_dd = law.k * (law.alpha * pm1 * damp + pm1 * d * lambda / h);
            (v, -c * dv_dd)
        };
        // g(F) = F - law(delta(F)) is increasing in F: g(0) <= 0 and g(hi) >= 0.
        let mut lo = 0.0f32;
        let mut hi = at(0.0).0;
        if hi <= 0.0 {
            self.delta = free_gap;
            self.force = 0.0;
            return 0.0;
        }
        let mut f = if self.force > 0.0 && self.force < hi { self.force } else { 0.5 * hi };
        for _ in 0..40 {
            let (v, slope) = at(f);
            let g = f - v;
            if g > 0.0 {
                hi = f;
            } else {
                lo = f;
            }
            // Newton step on the analytic slope, kept inside the bracket.
            let dg = 1.0 - slope;
            let mut next = if dg > 1.0e-9 { f - g / dg } else { 0.5 * (lo + hi) };
            if !(next > lo && next < hi) {
                next = 0.5 * (lo + hi);
            }
            let done = (next - f).abs() <= 1.0e-5 * f.max(1.0e-9) || hi - lo <= 1.0e-5 * hi;
            f = next;
            if done {
                break;
            }
        }
        self.delta = free_gap - c * f;
        self.force = f;
        if self.delta <= 0.0 {
            self.touching = false;
        }
        f
    }
}

/// A striker: a mass with a tip, thrown at a surface (a stick, a beater, a mallet, a pebble, a
/// drop). `y` is measured along the direction of the strike.
#[derive(Clone, Copy, Debug)]
pub struct Striker {
    /// Effective mass at the tip, kg (a stick pivoting in the hand weighs about a third of itself
    /// there).
    pub mass: f32,
    pub tip: Tip,
    pub y: f32,
    pub v: f32,
}

impl Striker {
    /// Position after the coming step with no force, and the one-step compliance `h^2 / m`.
    #[inline]
    pub fn predict(&self, h: f32) -> (f32, f32) {
        (self.y + self.v * h, h * h / self.mass)
    }

    /// Advances the striker one step under the contact force `f` pushing it back.
    #[inline]
    pub fn apply(&mut self, f: f32, h: f32) {
        self.v -= f * h / self.mass;
        self.y += self.v * h;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A striker against a rigid, fixed wall: (contact time, peak force, rebound speed).
    fn against_wall(striker: Striker, law: ContactLaw, sr: f32) -> (f32, f32, f32) {
        let h = 1.0 / sr;
        let mut s = Striker { y: -striker.v * h * 2.37, ..striker };
        let mut c = Contact::new(law);
        let (mut t, mut peak) = (0usize, 0.0f32);
        for _ in 0..(sr as usize) {
            let (free, comp) = s.predict(h);
            let f = c.solve(free, comp, h);
            s.apply(f, h);
            if f > 0.0 {
                t += 1;
            }
            peak = peak.max(f);
            if s.v < 0.0 && c.touches > 0 && !c.touching {
                break;
            }
        }
        (t as f32 / sr, peak, -s.v)
    }

    fn felt() -> Striker {
        Striker { mass: 0.03, tip: Tip::Felt { stiffness: 3.0e8, exponent: 2.5 }, y: 0.0, v: 2.0 }
    }

    #[test]
    fn a_contact_is_resolved_at_the_audio_rate() {
        // The same hit at 44.1 kHz and at a 4x finer step: contact time and peak force agree.
        let law = ContactLaw::between(felt().tip, Material::MYLAR, 0.8);
        let (t1, f1, _) = against_wall(felt(), law, 44_100.0);
        let (t4, f4, _) = against_wall(felt(), law, 176_400.0);
        assert!((t1 / t4 - 1.0).abs() < 0.06, "contact {t1} s vs {t4} s");
        assert!((f1 / f4 - 1.0).abs() < 0.05, "peak {f1} N vs {f4} N");
    }

    #[test]
    fn hertz_contact_time_falls_as_the_fifth_root_of_speed() {
        // A 20 g steel ball on steel: t ~ v^(-1/5) for alpha = 3/2. Run at a fine step, as a real
        // steel-on-steel contact lasts tens of microseconds.
        let tip = Tip::Solid { radius: 0.01, material: Material::STEEL };
        let law = ContactLaw::between(tip, Material::STEEL, 1.0);
        let ball = |v| Striker { mass: 0.02, tip, y: 0.0, v };
        let sr = 20.0e6;
        let (ta, _, _) = against_wall(ball(0.5), law, sr);
        let (tb, _, _) = against_wall(ball(8.0), law, sr);
        let want = 16.0f32.powf(-0.2);
        assert!(((tb / ta) / want - 1.0).abs() < 0.04, "ratio {} vs {want}", tb / ta);
        // Hertz's closed form for the duration: 2.943 (m^2 / (K^2 v))^(1/5) with m* = m.
        let exact = 2.943 * (0.02f32 * 0.02 / (law.k * law.k * 0.5)).powf(0.2) * (1.25f32).powf(0.4);
        assert!((ta / exact - 1.0).abs() < 0.05, "{ta} vs Hertz {exact}");
    }

    #[test]
    fn restitution_sets_the_rebound() {
        for e in [0.3f32, 0.6, 0.9] {
            let law = ContactLaw { restitution: e, ..ContactLaw::between(felt().tip, Material::MYLAR, e) };
            let (_, _, v_out) = against_wall(felt(), law, 176_400.0);
            assert!((v_out / 2.0 - e).abs() < 0.05, "e {e}: rebound {}", v_out / 2.0);
        }
    }

    #[test]
    fn a_harder_or_lighter_striker_has_a_shorter_contact() {
        let soft = felt();
        let hard = Striker { tip: Tip::Felt { stiffness: 3.0e9, exponent: 2.5 }, ..soft };
        let light = Striker { mass: 0.01, ..soft };
        let t = |s: Striker| against_wall(s, ContactLaw::between(s.tip, Material::MYLAR, 0.8), 176_400.0).0;
        let (ts, th, tl) = (t(soft), t(hard), t(light));
        assert!(th < ts * 0.8, "hard {th} vs soft {ts}");
        assert!(tl < ts * 0.8, "light {tl} vs heavy {ts}");
        // A timpani-style felt mallet at a moderate speed is in contact for a few milliseconds.
        assert!(ts > 0.001 && ts < 0.006, "{ts}");
    }
}
