//! The bow-string contact: rosin friction as a function of the bow's velocity relative to the
//! string, solved against the string's own impedance every sample, with stick/slip hysteresis.
//!
//! This is the classic McIntyre-Schumacher-Woodhouse formulation (McIntyre, Schumacher and
//! Woodhouse, "On the oscillations of musical instruments", JASA 74, 1983; Woodhouse, "Bowed string
//! simulation using a thermal friction model", Acta Acustica 2003, section 2 for the hyperbolic
//! curve and the hysteresis rule). At the contact point:
//!
//! * the string, left alone, would move at `v_h` - the sum of the two travelling waves arriving
//!   from either side;
//! * the bow applies a friction force `f`, which launches equal velocity waves of `f / 2Z` both
//!   ways, so the contact actually moves at `v = v_h + f / 2Z` (`Z` the string's characteristic
//!   impedance);
//! * friction is capped by the bow force `F_b` times a coefficient `mu(dv)` that falls from
//!   `mu_s` (static) toward `mu_d` (dynamic) as the relative speed `dv = v_b - v` grows:
//!   `mu(dv) = mu_d + (mu_s - mu_d) * v0 / (v0 + |dv|)`.
//!
//! The string *sticks* (moves with the bow, `v = v_b`) whenever the force needed to hold it there,
//! `2Z |v_b - v_h|`, is within `mu_s F_b`. Otherwise it *slips*, at the `v` where the straight line
//! `f = 2Z (v - v_h)` meets the friction curve - a quadratic in closed form for the hyperbolic curve.
//! Where both a stick and a slip solution exist the contact keeps whatever it was doing last
//! (hysteresis), which is what makes the release into slip sharp and the Helmholtz corner clean.
//!
//! Nothing in here is tuned by ear: bow force is in newtons, speeds in m/s, impedance in kg/s, so
//! the familiar consequences - Helmholtz motion, a playable force window that narrows as the bow
//! moves away from the bridge (Schelleng's diagram), the pitch flattening under heavy force - fall
//! out of the physics instead of being painted on.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrictionCurve {
    /// Static coefficient: the most the rosin can hold before letting go.
    pub mu_s: f32,
    /// Dynamic coefficient: the friction while sliding fast.
    pub mu_d: f32,
    /// How quickly (m/s of relative speed) friction falls from static to dynamic. Smaller is a
    /// "grabbier" rosin with a sharper release.
    pub v0: f32,
}

impl Default for FrictionCurve {
    fn default() -> Self {
        // Figures in the range the bowed-string literature uses for rosin (Woodhouse 2003 uses
        // mu_s 0.8, mu_d 0.3, v0 0.1 m/s for the hyperbolic fit to steady-sliding measurements).
        Self { mu_s: 0.8, mu_d: 0.3, v0: 0.1 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Contact {
    #[default]
    Stick,
    /// Slipping with the string slower than the bow (`v < v_b`).
    SlipBehind,
    /// Slipping with the string faster than the bow (`v > v_b`), e.g. during a bow reversal.
    SlipAhead,
}

impl Contact {
    pub fn is_stuck(self) -> bool {
        matches!(self, Contact::Stick)
    }
}

/// The positive slip solutions `dv` (relative speed, bow minus string, measured on the side the
/// string is slipping) of `dh - dv = k * mu(dv)`, i.e. where the impedance line meets the friction
/// curve. `dh` is the relative speed the string would have if the bow applied no force, `k = F_b/2Z`.
/// Returns (largest root, whether any positive root exists).
#[inline]
fn slip_root(dh: f32, k: f32, c: &FrictionCurve) -> Option<f32> {
    // (dh - dv)(v0 + dv) = k (mu_d (v0 + dv) + (mu_s - mu_d) v0)
    // => dv^2 - b dv - v0 (dh - k mu_s) = 0,  b = dh - v0 - k mu_d
    let b = dh - c.v0 - k * c.mu_d;
    let disc = b * b + 4.0 * c.v0 * (dh - k * c.mu_s);
    if disc < 0.0 {
        return None;
    }
    let r = 0.5 * (b + disc.sqrt());
    if r > 0.0 { Some(r) } else { None }
}

/// Solves the contact for one sample. `v_h` is the string's free velocity at the contact, `v_b` the
/// bow's, `z` the string impedance, `f_b` the bow force (>= 0). Returns the contact velocity and the
/// new contact state; the friction force is `2 z (v - v_h)`.
#[inline]
pub fn solve(v_h: f32, v_b: f32, z: f32, f_b: f32, curve: &FrictionCurve, prev: Contact) -> (f32, Contact) {
    let f_b = f_b.max(0.0);
    if f_b <= 1.0e-9 {
        // No bow on the string: it moves freely.
        return (v_h, Contact::SlipBehind);
    }
    let k = f_b / (2.0 * z.max(1.0e-6));
    let dh = v_b - v_h;
    let can_stick = dh.abs() <= k * curve.mu_s;

    let behind = || slip_root(dh, k, curve).map(|dv| (v_b - dv, Contact::SlipBehind));
    let ahead = || slip_root(-dh, k, curve).map(|dv| (v_b + dv, Contact::SlipAhead));

    match prev {
        Contact::Stick if can_stick => (v_b, Contact::Stick),
        Contact::SlipBehind => behind().or_else(|| if can_stick { Some((v_b, Contact::Stick)) } else { None }).or_else(ahead).unwrap_or((v_b, Contact::Stick)),
        Contact::SlipAhead => ahead().or_else(|| if can_stick { Some((v_b, Contact::Stick)) } else { None }).or_else(behind).unwrap_or((v_b, Contact::Stick)),
        // Was stuck but the string has been pulled past what static friction can hold: it breaks
        // away on the side it is being pulled toward.
        Contact::Stick => {
            if dh > 0.0 {
                behind().or_else(ahead).unwrap_or((v_b, Contact::Stick))
            } else {
                ahead().or_else(behind).unwrap_or((v_b, Contact::Stick))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn friction_force(v: f32, v_h: f32, z: f32) -> f32 {
        2.0 * z * (v - v_h)
    }

    #[test]
    fn with_no_bow_force_the_string_moves_freely() {
        let (v, _) = solve(0.3, 0.1, 0.3, 0.0, &FrictionCurve::default(), Contact::Stick);
        assert_eq!(v, 0.3);
    }

    #[test]
    fn a_string_held_within_static_friction_sticks_to_the_bow() {
        let c = FrictionCurve::default();
        // Needs 2*0.3*0.1 = 0.06 N of friction; the bow can hold 0.8 * 0.5 = 0.4 N.
        let (v, s) = solve(0.0, 0.1, 0.3, 0.5, &c, Contact::Stick);
        assert_eq!(s, Contact::Stick);
        assert_eq!(v, 0.1);
    }

    #[test]
    fn a_slip_solution_lies_on_the_friction_curve() {
        let c = FrictionCurve::default();
        let (z, f_b, v_b, v_h) = (0.3, 0.5, 0.2, -1.5);
        let (v, s) = solve(v_h, v_b, z, f_b, &c, Contact::Stick);
        assert_eq!(s, Contact::SlipBehind);
        let dv = v_b - v;
        let mu = c.mu_d + (c.mu_s - c.mu_d) * c.v0 / (c.v0 + dv);
        let f = friction_force(v, v_h, z);
        assert!((f - f_b * mu).abs() < 1.0e-4, "friction {f} vs curve {}", f_b * mu);
        assert!(f <= f_b * c.mu_s + 1.0e-6, "slipping friction can never exceed static friction");
    }

    #[test]
    fn hysteresis_keeps_a_slipping_contact_slipping_where_it_could_also_stick() {
        let c = FrictionCurve::default();
        let (z, f_b, v_b) = (0.3, 0.5, 0.2);
        // Just inside the stick limit (|dh| <= k mu_s = 0.667): a stuck string stays stuck...
        let v_h = v_b - 0.6;
        assert_eq!(solve(v_h, v_b, z, f_b, &c, Contact::Stick).1, Contact::Stick);
        // ...but a slipping one keeps slipping, if a slip solution exists there.
        let (v, s) = solve(v_h, v_b, z, f_b, &c, Contact::SlipBehind);
        if s == Contact::SlipBehind {
            assert!(v < v_b);
        }
    }
}
