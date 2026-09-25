//! Bessel functions of the first kind, `J_m(x)`, and their zeros: the mode shapes and frequencies of
//! a circular membrane (and later a plate). Build time only - nothing here runs on the audio thread.
//!
//! `J_m` is computed by Miller's backward recurrence (start well above the order and the argument,
//! recur downwards, normalize with `J_0 + 2 (J_2 + J_4 + ...) = 1`), which is stable for every order
//! and argument the membrane needs and costs a few hundred multiply-adds, no transcendental calls.

/// `J_m(x)` for `x >= 0`.
pub fn jn(m: u32, x: f64) -> f64 {
    let x = x.abs();
    if x < 1.0e-12 {
        return if m == 0 { 1.0 } else { 0.0 };
    }
    let top = (m as f64).max(x);
    // Start order: comfortably above both the order and the argument (Numerical Recipes' rule, with
    // margin), and even so the normalization sum lines up.
    let mut n0 = (top + 30.0 + (60.0 * top).sqrt()) as u32;
    n0 += n0 & 1;
    let (mut jp, mut j) = (0.0f64, 1.0e-30f64);
    let mut sum = 0.0f64;
    let mut out = 0.0f64;
    let inv = 2.0 / x;
    let mut k = n0;
    while k > 0 {
        let jm = k as f64 * inv * j - jp;
        jp = j;
        j = jm;
        k -= 1;
        // `j` is now the (unnormalized) J_k.
        if k == m {
            out = j;
        }
        if k > 0 && k % 2 == 0 {
            sum += j;
        }
        if j.abs() > 1.0e200 {
            j *= 1.0e-200;
            jp *= 1.0e-200;
            sum *= 1.0e-200;
            out *= 1.0e-200;
        }
    }
    let norm = j + 2.0 * sum;
    out / norm
}

/// `J_m'(x)`.
pub fn jn_prime(m: u32, x: f64) -> f64 {
    if m == 0 {
        -jn(1, x)
    } else {
        0.5 * (jn(m - 1, x) - jn(m + 1, x))
    }
}

/// The first `count` positive zeros of `J_m`, by a scan and bisection.
pub fn jn_zeros(m: u32, count: usize) -> Vec<f64> {
    let mut zeros = Vec::with_capacity(count);
    // The first zero lies above `m`; zeros are spaced by about pi, so a step of 0.1 cannot jump one.
    let mut x = (m as f64).max(0.5);
    let mut fx = jn(m, x);
    while zeros.len() < count {
        let x2 = x + 0.1;
        let f2 = jn(m, x2);
        if fx == 0.0 {
            zeros.push(x);
        } else if fx * f2 < 0.0 {
            let (mut lo, mut hi, mut flo) = (x, x2, fx);
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                let fm = jn(m, mid);
                if fm * flo <= 0.0 {
                    hi = mid;
                } else {
                    lo = mid;
                    flo = fm;
                }
            }
            zeros.push(0.5 * (lo + hi));
        }
        x = x2;
        fx = f2;
    }
    zeros
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bessel_values_match_tables() {
        // Abramowitz & Stegun, table 9.1; J_2(50) from the recurrence (2/x) J_1 - J_0.
        let cases = [(0, 1.0, 0.765_197_686_6), (1, 2.5, 0.497_094_102_5), (0, 10.0, -0.245_935_764_5), (5, 3.0, 0.043_028_434_9), (2, 50.0, -0.059_712_800_8), (0, 50.0, 0.055_812_327_7)];
        for (m, x, want) in cases {
            let got = jn(m, x);
            assert!((got - want).abs() < 1.0e-8, "J_{m}({x}) = {got}, want {want}");
        }
    }

    #[test]
    fn bessel_zeros_match_tables() {
        let z0 = jn_zeros(0, 3);
        let z1 = jn_zeros(1, 2);
        let z2 = jn_zeros(2, 1);
        for (got, want) in [(z0[0], 2.404_825_557_7), (z0[1], 5.520_078_110_3), (z0[2], 8.653_727_912_9), (z1[0], 3.831_705_970_2), (z1[1], 7.015_586_669_8), (z2[0], 5.135_622_301_8)] {
            assert!((got - want).abs() < 1.0e-8, "{got} vs {want}");
        }
    }
}
