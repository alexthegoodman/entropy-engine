//! Signal conditioning primitives (DSP-1..DSP-5). Everything here is allocation-free after
//! construction and flushes tiny values to zero so recursive filters never go denormal (RT-4).

use std::f32::consts::PI;

pub fn amp_to_db(amp: f32) -> f32 {
    20.0 * amp.max(1e-9).log10()
}

pub fn db_to_amp(db: f32) -> f32 {
    10.0f32.powf(db / 20.0)
}

#[inline]
fn flush(x: f32) -> f32 {
    if x.abs() < 1e-20 { 0.0 } else { x }
}

/// One-pole high-pass, `y[n] = x[n] - x[n-1] + r*y[n-1]`. Removes DC and rumble (DSP-1).
#[derive(Clone, Copy, Debug)]
pub struct DcBlocker {
    r: f32,
    x1: f32,
    y1: f32,
}

impl DcBlocker {
    pub fn new(sample_rate: f32, cutoff_hz: f32) -> Self {
        DcBlocker { r: (1.0 - 2.0 * PI * cutoff_hz / sample_rate).clamp(0.9, 0.99999), x1: 0.0, y1: 0.0 }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = x - self.x1 + self.r * self.y1;
        self.x1 = x;
        self.y1 = flush(y);
        y
    }

    pub fn reset(&mut self) {
        self.x1 = 0.0;
        self.y1 = 0.0;
    }
}

/// RBJ biquad, transposed direct form II.
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    pub fn lowpass(sample_rate: f32, cutoff_hz: f32, q: f32) -> Self {
        let w0 = 2.0 * PI * (cutoff_hz / sample_rate).clamp(1e-4, 0.49);
        let (s, c) = w0.sin_cos();
        let alpha = s / (2.0 * q);
        let a0 = 1.0 + alpha;
        Biquad {
            b0: (1.0 - c) / 2.0 / a0,
            b1: (1.0 - c) / a0,
            b2: (1.0 - c) / 2.0 / a0,
            a1: -2.0 * c / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = flush(self.b1 * x - self.a1 * y + self.z2);
        self.z2 = flush(self.b2 * x - self.a2 * y);
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// 4th-order Butterworth low-pass (two sections), used for the sub-band guard where a steep skirt
/// matters more than phase.
#[derive(Clone, Copy, Debug)]
pub struct Lowpass4 {
    a: Biquad,
    b: Biquad,
}

impl Lowpass4 {
    pub fn new(sample_rate: f32, cutoff_hz: f32) -> Self {
        // Butterworth 4th order pole Qs.
        Lowpass4 { a: Biquad::lowpass(sample_rate, cutoff_hz, 0.5412), b: Biquad::lowpass(sample_rate, cutoff_hz, 1.3066) }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        self.b.process(self.a.process(x))
    }

    pub fn reset(&mut self) {
        self.a.reset();
        self.b.reset();
    }
}

/// Smoothed energy of the signal under a cutoff, against the smoothed total. The engine keeps one per
/// tier so a short window can tell that the string is playing something it cannot see.
#[derive(Clone, Copy, Debug)]
pub struct BandGuard {
    lp: Lowpass4,
    e_low: f32,
    e_all: f32,
    alpha: f32,
}

impl BandGuard {
    pub fn new(sample_rate: f32, cutoff_hz: f32, time_constant_s: f32) -> Self {
        BandGuard {
            lp: Lowpass4::new(sample_rate, cutoff_hz),
            e_low: 0.0,
            e_all: 0.0,
            alpha: 1.0 - (-1.0 / (time_constant_s * sample_rate)).exp(),
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) {
        let y = self.lp.process(x);
        self.e_low += self.alpha * (y * y - self.e_low);
        self.e_all += self.alpha * (x * x - self.e_all);
        self.e_low = flush(self.e_low);
        self.e_all = flush(self.e_all);
    }

    /// Share of the energy below the cutoff, 0..1. Quiet signals report 0 rather than noise.
    pub fn ratio(&self) -> f32 {
        if self.e_all < 1e-12 { 0.0 } else { (self.e_low / self.e_all).clamp(0.0, 1.0) }
    }

    pub fn reset(&mut self) {
        self.lp.reset();
        self.e_low = 0.0;
        self.e_all = 0.0;
    }
}

/// Fixed-size ring of the newest samples. Preallocated; `latest` copies out a contiguous run.
#[derive(Clone, Debug)]
pub struct Ring {
    buf: Vec<f32>,
    mask: usize,
    /// Total samples ever written.
    written: u64,
}

impl Ring {
    pub fn new(min_len: usize) -> Self {
        let len = min_len.next_power_of_two();
        Ring { buf: vec![0.0; len], mask: len - 1, written: 0 }
    }

    #[inline]
    pub fn push(&mut self, x: f32) {
        self.buf[(self.written as usize) & self.mask] = x;
        self.written += 1;
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    /// Copies the newest `out.len()` samples, oldest first. Samples from before the start read as zero.
    pub fn latest(&self, out: &mut [f32]) {
        let n = out.len();
        assert!(n <= self.buf.len(), "ring is smaller than the window asked of it");
        if self.written < n as u64 {
            let missing = n - self.written as usize;
            out[..missing].iter_mut().for_each(|o| *o = 0.0);
            for (i, o) in out[missing..].iter_mut().enumerate() {
                *o = self.buf[i & self.mask];
            }
            return;
        }
        let start = ((self.written - n as u64) as usize) & self.mask;
        let first = (self.buf.len() - start).min(n);
        out[..first].copy_from_slice(&self.buf[start..start + first]);
        out[first..].copy_from_slice(&self.buf[..n - first]);
    }

    /// Sum of squares of the newest `n` samples.
    pub fn energy(&self, n: usize) -> f32 {
        let n = n.min(self.buf.len()).min(self.written as usize);
        let mut sum = 0.0f32;
        let start = self.written - n as u64;
        for i in 0..n as u64 {
            let v = self.buf[((start + i) as usize) & self.mask];
            sum += v * v;
        }
        sum
    }

    pub fn peak(&self, n: usize) -> f32 {
        let n = n.min(self.buf.len()).min(self.written as usize);
        let mut p = 0.0f32;
        let start = self.written - n as u64;
        for i in 0..n as u64 {
            p = p.max(self.buf[((start + i) as usize) & self.mask].abs());
        }
        p
    }

    /// Zeroes the samples but keeps counting, so positions stay monotonic across a restart.
    pub fn clear(&mut self) {
        self.buf.iter_mut().for_each(|s| *s = 0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, fs: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * PI * hz * i as f32 / fs).sin()).collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn dc_blocker_removes_offset_and_keeps_the_lowest_string() {
        let mut dc = DcBlocker::new(48_000.0, 20.0);
        let low: Vec<f32> = sine(70.0, 48_000.0, 48_000).iter().map(|s| s * 0.5 + 0.3).collect();
        let out: Vec<f32> = low.iter().map(|&x| dc.process(x)).collect();
        let tail = &out[24_000..];
        let mean = tail.iter().sum::<f32>() / tail.len() as f32;
        assert!(mean.abs() < 0.01, "DC left: {mean}");
        // 70 Hz through a 20 Hz corner loses under 0.6 dB.
        let gain_db = amp_to_db(rms(tail) / (0.5 / 2.0f32.sqrt()));
        assert!(gain_db > -0.6, "low string attenuated by {gain_db} dB");
    }

    #[test]
    fn lowpass_passes_below_and_stops_above() {
        let mut lp = Biquad::lowpass(48_000.0, 3000.0, 0.7071);
        let pass: Vec<f32> = sine(500.0, 48_000.0, 9600).iter().map(|&x| lp.process(x)).collect();
        lp.reset();
        let stop: Vec<f32> = sine(12_000.0, 48_000.0, 9600).iter().map(|&x| lp.process(x)).collect();
        assert!(rms(&pass[4800..]) > 0.69);
        assert!(rms(&stop[4800..]) < 0.06);
    }

    #[test]
    fn band_guard_sees_a_low_note_and_ignores_a_high_one() {
        let fs = 48_000.0;
        let mut low = BandGuard::new(fs, 200.0, 0.005);
        let mut high = BandGuard::new(fs, 200.0, 0.005);
        for x in sine(82.4, fs, 9600) {
            low.process(x);
        }
        for x in sine(660.0, fs, 9600) {
            high.process(x);
        }
        assert!(low.ratio() > 0.9, "82 Hz ratio {}", low.ratio());
        assert!(high.ratio() < 0.02, "660 Hz ratio {}", high.ratio());
    }

    #[test]
    fn ring_returns_the_newest_samples_in_order_across_the_wrap() {
        let mut ring = Ring::new(8);
        for i in 0..20 {
            ring.push(i as f32);
        }
        let mut out = [0.0f32; 5];
        ring.latest(&mut out);
        assert_eq!(out, [15.0, 16.0, 17.0, 18.0, 19.0]);
        assert_eq!(ring.energy(2), 18.0 * 18.0 + 19.0 * 19.0);
        assert_eq!(ring.peak(3), 19.0);
    }

    #[test]
    fn clearing_the_ring_keeps_the_sample_count_running() {
        let mut ring = Ring::new(8);
        for i in 0..5 {
            ring.push(i as f32 + 1.0);
        }
        ring.clear();
        assert_eq!(ring.written(), 5);
        let mut out = [9.0f32; 3];
        ring.latest(&mut out);
        assert_eq!(out, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn ring_reads_zeros_before_the_first_sample() {
        let mut ring = Ring::new(8);
        ring.push(1.0);
        ring.push(2.0);
        let mut out = [9.0f32; 4];
        ring.latest(&mut out);
        assert_eq!(out, [0.0, 0.0, 1.0, 2.0]);
    }
}
