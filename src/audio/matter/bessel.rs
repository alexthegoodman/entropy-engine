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

/// The zeros of `J_m` between `lo` and `hi`, by a scan and bisection.
pub fn jn_zeros_between(m: u32, lo: f64, hi: f64) -> Vec<f64> {
    let mut zeros = Vec::new();
    // No zero of J_m lies below m.
    let mut x = lo.max(m as f64).max(0.5);
    let mut fx = jn(m, x);
    while x < hi {
        let x2 = x + 0.1;
        let f2 = jn(m, x2);
        if fx * f2 < 0.0 {
            let (mut a, mut b, mut fa) = (x, x2, fx);
            for _ in 0..50 {
                let mid = 0.5 * (a + b);
                let fm = jn(m, mid);
                if fm * fa <= 0.0 {
                    b = mid;
                } else {
                    a = mid;
                    fa = fm;
                }
            }
            zeros.push(0.5 * (a + b));
        }
        x = x2;
        fx = f2;
    }
    zeros
}

/// The first `count` zeros of `J_m'`, the radial wavenumbers of a hard-walled cylinder's acoustic
/// modes. For `m = 0` the first is 0 (the uniform mode).
pub fn jn_prime_zeros(m: u32, count: usize) -> Vec<f64> {
    let mut zeros = Vec::with_capacity(count);
    if m == 0 {
        zeros.push(0.0);
    }
    let mut x = if m == 0 { 0.5 } else { (m as f64 * 0.5).max(0.3) };
    let mut fx = jn_prime(m, x);
    while zeros.len() < count {
        let x2 = x + 0.05;
        let f2 = jn_prime(m, x2);
        if fx * f2 < 0.0 {
            let (mut a, mut b, mut fa) = (x, x2, fx);
            for _ in 0..50 {
                let mid = 0.5 * (a + b);
                let fm = jn_prime(m, mid);
                if fm * fa <= 0.0 {
                    b = mid;
                } else {
                    a = mid;
                    fa = fm;
                }
            }
            zeros.push(0.5 * (a + b));
        }
        x = x2;
        fx = f2;
    }
    zeros
}

/// `J_m(x)` for every order `m` in `lo..=hi`, from one backward recurrence, into `out[m - lo]`.
/// Negative orders follow `J_{-m} = (-1)^m J_m`.
pub fn jn_range(lo: i32, hi: i32, x: f64, out: &mut [f64]) {
    let top = lo.unsigned_abs().max(hi.unsigned_abs());
    let mut pos = [0.0f64; MAX_RANGE];
    jn_orders(top, x, &mut pos);
    for m in lo..=hi {
        let v = pos[m.unsigned_abs() as usize];
        out[(m - lo) as usize] = if m < 0 && m % 2 != 0 { -v } else { v };
    }
}

/// Highest order (plus one) the range functions return; they work on the stack, so a mode shape can
/// be evaluated without allocating.
pub const MAX_RANGE: usize = 192;

/// `J_0(x) ..= J_top(x)` into `out` (Miller's recurrence, as [`jn`]).
fn jn_orders(top: u32, x: f64, out: &mut [f64]) {
    assert!((top as usize) < out.len());
    let x = x.abs();
    if x < 1.0e-12 {
        out.iter_mut().enumerate().for_each(|(k, v)| *v = if k == 0 { 1.0 } else { 0.0 });
        return;
    }
    let t = (top as f64).max(x);
    let mut n0 = (t + 30.0 + (60.0 * t).sqrt()) as u32;
    n0 += n0 & 1;
    let (mut jp, mut j) = (0.0f64, 1.0e-30f64);
    let mut sum = 0.0f64;
    let inv = 2.0 / x;
    let mut k = n0;
    while k > 0 {
        let jm = k as f64 * inv * j - jp;
        jp = j;
        j = jm;
        k -= 1;
        if k <= top {
            out[k as usize] = j;
        }
        if k > 0 && k % 2 == 0 {
            sum += j;
        }
        if j.abs() > 1.0e200 {
            j *= 1.0e-200;
            jp *= 1.0e-200;
            sum *= 1.0e-200;
            out[..=top as usize].iter_mut().for_each(|v| *v *= 1.0e-200);
        }
    }
    let norm = j + 2.0 * sum;
    out[..=top as usize].iter_mut().for_each(|v| *v /= norm);
}

/// The modified Bessel functions `I_m(x) e^(-x)` for every order in `lo..=hi` (`I_{-m} = I_m`),
/// into `out[m - lo]`: scaled by `e^(-x)` so a plate's high modes (`x` up to hundreds) stay finite.
///
/// Miller's backward recurrence again (`I_{k-1} = (2k / x) I_k + I_{k+1}`, stable downwards), normalized
/// with `I_0 + 2 (I_1 + I_2 + ...) = e^x`.
pub fn in_scaled_range(lo: i32, hi: i32, x: f64, out: &mut [f64]) {
    let top = lo.unsigned_abs().max(hi.unsigned_abs());
    let x = x.abs();
    assert!((top as usize) < MAX_RANGE);
    let mut pos = [0.0f64; MAX_RANGE];
    if x < 1.0e-12 {
        pos[0] = 1.0;
    } else {
        let t = (top as f64).max(x);
        let n0 = (t + 30.0 + (60.0 * t).sqrt()) as u32;
        let (mut ip, mut i) = (0.0f64, 1.0e-30f64);
        let mut sum = 0.0f64;
        let inv = 2.0 / x;
        let mut k = n0;
        while k > 0 {
            let im = k as f64 * inv * i + ip;
            ip = i;
            i = im;
            k -= 1;
            if k <= top {
                pos[k as usize] = i;
            }
            if k > 0 {
                sum += i;
            }
            if i > 1.0e200 {
                i *= 1.0e-200;
                ip *= 1.0e-200;
                sum *= 1.0e-200;
                pos[..=top as usize].iter_mut().for_each(|v| *v *= 1.0e-200);
            }
        }
        let norm = i + 2.0 * sum;
        pos[..=top as usize].iter_mut().for_each(|v| *v /= norm);
    }
    for m in lo..=hi {
        out[(m - lo) as usize] = pos[m.unsigned_abs() as usize];
    }
}

/// `I_m(x)`.
pub fn in_(m: u32, x: f64) -> f64 {
    let mut v = [0.0f64];
    in_scaled_range(m as i32, m as i32, x, &mut v);
    v[0] * x.abs().exp()
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
    fn derivative_zeros_match_tables() {
        // Abramowitz & Stegun, table 9.5.
        let z0 = jn_prime_zeros(0, 2);
        let z1 = jn_prime_zeros(1, 2);
        let z2 = jn_prime_zeros(2, 1);
        for (got, want) in [(z0[0], 0.0), (z0[1], 3.831_705_970_2), (z1[0], 1.841_183_781_3), (z1[1], 5.331_442_773_5), (z2[0], 3.054_236_928_2)] {
            assert!((got - want).abs() < 1.0e-8, "{got} vs {want}");
        }
    }

    #[test]
    fn modified_bessel_values_match_tables() {
        // Abramowitz & Stegun, tables 9.8 and 9.11.
        let cases = [(0, 1.0, 1.266_065_878), (1, 1.0, 0.565_159_104), (0, 5.0, 27.239_871_82), (2, 2.0, 0.688_948_448), (1, 10.0, 2670.988_304), (5, 3.0, 0.091_206_477_7)];
        for (m, x, want) in cases {
            let got = in_(m, x);
            assert!((got / want - 1.0).abs() < 1.0e-8, "I_{m}({x}) = {got}, want {want}");
        }
        let mut r = [0.0f64; 5];
        jn_range(-2, 2, 2.5, &mut r);
        for (i, m) in (-2i32..=2).enumerate() {
            let want = jn(m.unsigned_abs(), 2.5) * if m < 0 && m % 2 != 0 { -1.0 } else { 1.0 };
            assert!((r[i] - want).abs() < 1.0e-12);
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
