//! Small DSP building blocks for the bowed-string model: a fractional delay line (the waveguide's
//! travelling-wave medium), the filters that sit at the string's terminations, and the half-band
//! decimator that brings the oversampled model back to the engine rate. Nothing here allocates after
//! construction, so every piece is safe to run on the audio thread.

use std::f32::consts::{PI, TAU};

// ------------------------------------------------------------------------------------------
// Fractional delay line
// ------------------------------------------------------------------------------------------

/// A ring buffer read back with 4-point (cubic) Lagrange interpolation. Lagrange rather than linear
/// because a linearly interpolated delay is also a lowpass whose cutoff moves with the fractional
/// part of the delay - in a waveguide loop that turns into a note-dependent brightness and decay,
/// and under vibrato into audible "breathing". Cubic Lagrange is flat enough over the audible band
/// at the model's oversampled rate that those artefacts drop well below the string's own losses.
pub struct Delay {
    buf: Box<[f32]>,
    mask: usize,
    write: usize,
}

impl Delay {
    /// `capacity` is rounded up to a power of two so wrapping is a mask, not a modulo.
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(8).next_power_of_two();
        Self { buf: vec![0.0; cap].into_boxed_slice(), mask: cap - 1, write: 0 }
    }

    pub fn clear(&mut self) {
        self.buf.iter_mut().for_each(|v| *v = 0.0);
    }

    /// The longest delay `read` can serve.
    pub fn max_delay(&self) -> f32 {
        (self.buf.len() - 4) as f32
    }

    #[inline]
    pub fn push(&mut self, v: f32) {
        self.buf[self.write] = v;
        self.write = (self.write + 1) & self.mask;
    }

    /// The value pushed `delay` samples ago, read *before* this sample's push: `read(1.0)` is the
    /// previous push, so a line read at `d` then pushed is a pure delay of `d` samples. Clamped to
    /// 2.0 at the short end, the least a centred cubic interpolator can serve.
    #[inline]
    pub fn read(&self, delay: f32) -> f32 {
        let d = delay.clamp(2.0, self.max_delay());
        // Offset 0 is the most recent push (a delay of exactly 1 sample).
        let off = d - 1.0;
        let i = off.floor();
        let t = off - i;
        let i = i as usize;
        let at = |k: usize| self.buf[(self.write.wrapping_sub(1 + k)) & self.mask];
        let (xm1, x0, x1, x2) = (at(i - 1), at(i), at(i + 1), at(i + 2));
        // Lagrange cubic through points at offsets -1, 0, 1, 2 evaluated at t.
        let c0 = -t * (t - 1.0) * (t - 2.0) / 6.0;
        let c1 = (t + 1.0) * (t - 1.0) * (t - 2.0) / 2.0;
        let c2 = -(t + 1.0) * t * (t - 2.0) / 2.0;
        let c3 = (t + 1.0) * t * (t - 1.0) / 6.0;
        c0 * xm1 + c1 * x0 + c2 * x1 + c3 * x2
    }

    /// The sample `k` pushes ago (0 = the most recent), no interpolation: what the visualization
    /// reads to rebuild the string's shape.
    #[inline]
    pub fn tap(&self, k: usize) -> f32 {
        self.buf[(self.write.wrapping_sub(1 + k.min(self.mask))) & self.mask]
    }
}

// ------------------------------------------------------------------------------------------
// Filters
// ------------------------------------------------------------------------------------------

/// `y = (1 - a) x + a y[-1]`: unity gain at DC, `a` near 1 is darker.
#[derive(Default, Clone, Copy)]
pub struct OnePole {
    pub y: f32,
}

impl OnePole {
    #[inline]
    pub fn process(&mut self, x: f32, a: f32) -> f32 {
        self.y = x * (1.0 - a) + self.y * a;
        self.y
    }

    /// The coefficient whose -3 dB point sits at `hz`.
    pub fn coef_for(hz: f32, sr: f32) -> f32 {
        (-TAU * hz.max(1.0) / sr).exp().clamp(0.0, 0.9995)
    }

    /// Phase delay in samples at angular frequency `w` (radians/sample), for tuning compensation.
    pub fn phase_delay(a: f32, w: f32) -> f32 {
        let w = w.max(1.0e-6);
        (a * w.sin()).atan2(1.0 - a * w.cos()) / w
    }
}

/// First-order allpass `(c + z^-1) / (1 + c z^-1)`. A cascade of these in the string loop delays low
/// frequencies more than high ones (for `c < 0`), which is exactly what bending stiffness does to a
/// real string: its higher partials travel faster and land progressively sharp (inharmonicity).
#[derive(Default, Clone, Copy)]
pub struct Allpass1 {
    x1: f32,
    y1: f32,
}

impl Allpass1 {
    #[inline]
    pub fn process(&mut self, x: f32, c: f32) -> f32 {
        let y = c * x + self.x1 - c * self.y1;
        self.x1 = x;
        self.y1 = y;
        y
    }

    /// Phase delay in samples at `w` radians/sample.
    pub fn phase_delay(c: f32, w: f32) -> f32 {
        let w = w.max(1.0e-6);
        // H = (c + e^{-jw}) / (1 + c e^{-jw})
        let (s, co) = w.sin_cos();
        let num = (c + co, -s);
        let den = (1.0 + c * co, -c * s);
        let phase = num.1.atan2(num.0) - den.1.atan2(den.0);
        -phase / w
    }
}

/// DC blocker, cutoff a few Hz.
#[derive(Default, Clone, Copy)]
pub struct DcBlock {
    x1: f32,
    y1: f32,
}

impl DcBlock {
    #[inline]
    pub fn process(&mut self, x: f32, r: f32) -> f32 {
        let y = x - self.x1 + r * self.y1;
        self.x1 = x;
        self.y1 = y;
        y
    }
}

/// A two-pole resonator in the "direct form, bandpass with zeros at DC and Nyquist" shape: unity
/// peak gain at `freq`, bandwidth `freq / q`. Used as one mode of the body (a mass-spring-damper
/// whose velocity response to force has exactly this shape).
#[derive(Default, Clone, Copy)]
pub struct Resonator {
    b0: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    pub y1: f32,
    y2: f32,
}

impl Resonator {
    pub fn set(&mut self, freq: f32, q: f32, sr: f32) {
        let f = freq.clamp(10.0, sr * 0.45);
        let w0 = TAU * f / sr;
        let alpha = w0.sin() / (2.0 * q.max(0.5));
        let a0 = 1.0 + alpha;
        self.b0 = alpha / a0;
        self.a1 = -2.0 * w0.cos() / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    pub fn clear(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * (x - self.x2) - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }

    /// A cheap running measure of how much this mode is ringing (its last two outputs' energy).
    #[inline]
    pub fn energy(&self) -> f32 {
        self.y1 * self.y1 + self.y2 * self.y2
    }
}

// ------------------------------------------------------------------------------------------
// 2x decimator
// ------------------------------------------------------------------------------------------

const HB_TAPS: usize = 31;

/// A windowed-sinc half-band lowpass + drop every other sample: the model runs at twice the engine
/// rate (so short bridge-side segments near the top of the range still get at least a couple of
/// samples of delay, and the friction solve sees a finer time step), and this brings it back down
/// without folding the model's upper partials into audible aliases.
pub struct Decimator2 {
    taps: [f32; HB_TAPS],
    hist: [f32; HB_TAPS],
    pos: usize,
}

impl Decimator2 {
    pub fn new() -> Self {
        let mut taps = [0.0f32; HB_TAPS];
        let mid = (HB_TAPS / 2) as f32;
        let mut sum = 0.0;
        for (i, t) in taps.iter_mut().enumerate() {
            let n = i as f32 - mid;
            let sinc = if n == 0.0 { 1.0 } else { (PI * n * 0.5).sin() / (PI * n * 0.5) };
            // Blackman window.
            let w = 0.42 - 0.5 * (TAU * i as f32 / (HB_TAPS - 1) as f32).cos() + 0.08 * (2.0 * TAU * i as f32 / (HB_TAPS - 1) as f32).cos();
            *t = sinc * w;
            sum += *t;
        }
        for t in taps.iter_mut() {
            *t /= sum;
        }
        Self { taps, hist: [0.0; HB_TAPS], pos: 0 }
    }

    /// Feeds two oversampled samples, returns one at the base rate.
    #[inline]
    pub fn process(&mut self, a: f32, b: f32) -> f32 {
        self.hist[self.pos] = a;
        self.pos = (self.pos + 1) % HB_TAPS;
        self.hist[self.pos] = b;
        self.pos = (self.pos + 1) % HB_TAPS;
        let mut acc = 0.0;
        for k in 0..HB_TAPS {
            acc += self.taps[k] * self.hist[(self.pos + k) % HB_TAPS];
        }
        acc
    }
}

impl Default for Decimator2 {
    fn default() -> Self {
        Self::new()
    }
}

// ------------------------------------------------------------------------------------------
// Deterministic noise
// ------------------------------------------------------------------------------------------

/// xorshift32: deterministic, allocation-free noise, so an offline render is bit-for-bit repeatable
/// and a test can rely on it.
#[derive(Clone, Copy)]
pub struct Noise(pub u32);

impl Noise {
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.0 = s;
        s
    }

    /// Uniform in -1..1.
    #[inline]
    pub fn bipolar(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 23) as f32 - 1.0
    }

    /// Uniform in 0..1.
    #[inline]
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 24) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delay_line_delays_by_the_requested_fractional_amount() {
        let mut d = Delay::new(64);
        // A slow ramp: an exact interpolator reads back the ramp value `delay` samples earlier.
        let mut out = 0.0;
        for n in 0..40 {
            out = d.read(7.25);
            d.push(n as f32);
        }
        // At n = 39 (read before pushing 39) the line returns the value at 39 - 7.25 = 31.75.
        assert!((out - 31.75).abs() < 1.0e-4, "{out}");
    }

    #[test]
    fn the_allpass_is_allpass_and_its_phase_delay_matches_a_measurement() {
        let c = -0.4;
        let w = 0.05f32;
        let mut ap = Allpass1::default();
        let n = 4000;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            out.push(ap.process((w * i as f32).sin(), c));
        }
        // Amplitude stays 1.
        let peak = out[2000..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 1.0).abs() < 0.01, "{peak}");
        // Zero-crossing shift equals the analytic phase delay.
        let pd = Allpass1::phase_delay(c, w);
        let i = (3000..3400).find(|&i| out[i - 1] < 0.0 && out[i] >= 0.0).unwrap();
        let frac = -out[i - 1] / (out[i] - out[i - 1]);
        let crossing = i as f32 - 1.0 + frac;
        let k = (crossing * w / TAU).round();
        let shift = crossing - k * TAU / w;
        assert!((shift - pd).abs() < 0.05, "measured {shift}, analytic {pd}");
    }
}
