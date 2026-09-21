//! Pitch detection (PIT-1..PIT-7). YIN and McLeod's MPM share one front end: the windowed
//! autocorrelation of the newest samples, computed with an FFT, plus running energies. From those
//! come YIN's difference function and MPM's normalized square difference (NSDF), so choosing between
//! them is a choice of what to do with the same arrays.
//!
//! A `TierDetector` looks at one window length. The engine keeps several, short to long, because a
//! detector needs about two periods of the note: a high E4 is 6 ms of signal, a low E2 is 24 ms
//! (PIT-6). Nothing allocates after construction (RT-1, RT-2).

use super::config::Algorithm;
use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

/// One pitch estimate (PIT-2).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PitchEstimate {
    pub freq_hz: f32,
    /// 0..1. YIN: 1 - CMND at the chosen lag. MPM: the NSDF peak height.
    pub confidence: f32,
    /// RMS of the analysed window.
    pub amplitude: f32,
    /// Input sample position of the end of the analysed window.
    pub sample_pos: u64,
    /// Index of the window length that produced this estimate.
    pub tier: u8,
    /// Samples the estimate was read from. The pitch it reports belongs to the middle of that window.
    pub window_len: u32,
}

impl PitchEstimate {
    /// The input sample this estimate describes: the middle of its window.
    pub fn center_sample(&self) -> u64 {
        self.sample_pos.saturating_sub(self.window_len as u64 / 2)
    }
}

/// The detector interface (PIT-5).
pub trait PitchDetector {
    /// Samples the detector needs; `estimate` reads the newest ones.
    fn window_len(&self) -> usize;
    /// Lowest and highest frequency this detector can report.
    fn range_hz(&self) -> (f32, f32);
    /// `samples` is at least `window_len()` long, oldest first; only its last `window_len()` are read.
    fn estimate(&mut self, samples: &[f32]) -> Option<PitchEstimate>;
}

/// YIN's absolute threshold on the cumulative mean normalized difference.
const YIN_THRESHOLD: f32 = 0.15;
/// Anything above this CMND minimum is not reported at all.
const YIN_GIVE_UP: f32 = 0.5;
/// McLeod's peak-picking constant.
const MPM_K: f32 = 0.93;
/// A first dip shallower than this may be a sub-multiple of the true period: a waveform with weak odd
/// partials repeats at half its period nearly as well as at the whole. Deeper than this is clean.
const SUBHARMONIC_SUSPECT: f32 = 0.06;
/// A dip at a multiple of the lag must be this fraction of the first dip's depth to replace it.
const SUBHARMONIC_DEPTH_RATIO: f32 = 0.5;

pub struct TierDetector {
    algorithm: Algorithm,
    sample_rate: f32,
    tier: u8,
    /// Integration window `W` and largest lag.
    w: usize,
    tau_min: usize,
    tau_max: usize,
    /// `W + tau_max`, the samples read.
    len: usize,
    n: usize,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    buf_a: Vec<f32>,
    buf_b: Vec<f32>,
    spec_a: Vec<Complex<f32>>,
    spec_b: Vec<Complex<f32>>,
    scratch_f: Vec<Complex<f32>>,
    scratch_i: Vec<Complex<f32>>,
    acf: Vec<f32>,
    /// Prefix sums of squares over the window read, `len + 1` long.
    prefix: Vec<f32>,
    /// CMND for YIN, NSDF for MPM, indexed by lag, `tau_max + 2` long.
    curve: Vec<f32>,
    /// Let a much deeper dip at 2x, 3x or 4x the first dip's lag replace it (YIN only).
    subharmonic_check: bool,
}

impl TierDetector {
    /// `min_hz` sets the largest lag and `max_hz` the smallest.
    pub fn new(planner: &mut RealFftPlanner<f32>, algorithm: Algorithm, sample_rate: f32, min_hz: f32, max_hz: f32, window_ratio: f32, tier: u8) -> Self {
        let tau_max = (sample_rate / min_hz).ceil() as usize;
        let tau_min = ((sample_rate / max_hz).floor() as usize).max(2);
        let w = ((tau_max as f32 * window_ratio.clamp(0.4, 1.0)) as usize).max(tau_min * 2);
        let len = w + tau_max;
        let n = len.next_power_of_two();
        let fwd = planner.plan_fft_forward(n);
        let inv = planner.plan_fft_inverse(n);
        let scratch_f = fwd.make_scratch_vec();
        let scratch_i = inv.make_scratch_vec();
        TierDetector {
            algorithm,
            sample_rate,
            tier,
            w,
            tau_min,
            tau_max,
            len,
            n,
            spec_a: fwd.make_output_vec(),
            spec_b: fwd.make_output_vec(),
            fwd,
            inv,
            buf_a: vec![0.0; n],
            buf_b: vec![0.0; n],
            scratch_f,
            scratch_i,
            acf: vec![0.0; n],
            prefix: vec![0.0; len + 1],
            curve: vec![0.0; tau_max + 2],
            subharmonic_check: true,
        }
    }

    pub fn set_subharmonic_check(&mut self, on: bool) {
        self.subharmonic_check = on;
    }

    pub fn tau_max(&self) -> usize {
        self.tau_max
    }

    pub fn tau_min(&self) -> usize {
        self.tau_min
    }

    /// Fills `acf` (lags 0..=tau_max over the window `W`), `prefix` and returns the window energy.
    fn correlate(&mut self, x: &[f32]) -> f32 {
        let (w, len, n) = (self.w, self.len, self.n);
        self.buf_a[..w].copy_from_slice(&x[..w]);
        self.buf_a[w..].iter_mut().for_each(|v| *v = 0.0);
        self.buf_b[..len].copy_from_slice(&x[..len]);
        self.buf_b[len..].iter_mut().for_each(|v| *v = 0.0);

        // Lengths are fixed at construction, so these cannot fail.
        self.fwd.process_with_scratch(&mut self.buf_a, &mut self.spec_a, &mut self.scratch_f).expect("fft length");
        self.fwd.process_with_scratch(&mut self.buf_b, &mut self.spec_b, &mut self.scratch_f).expect("fft length");
        for (a, b) in self.spec_a.iter_mut().zip(self.spec_b.iter()) {
            *a = a.conj() * *b;
        }
        self.spec_a[0].im = 0.0;
        let last = self.spec_a.len() - 1;
        self.spec_a[last].im = 0.0;
        self.inv.process_with_scratch(&mut self.spec_a, &mut self.acf, &mut self.scratch_i).expect("fft length");
        let scale = 1.0 / n as f32;
        self.acf[..=self.tau_max].iter_mut().for_each(|v| *v *= scale);

        let mut acc = 0.0f64;
        self.prefix[0] = 0.0;
        for (i, &v) in x[..len].iter().enumerate() {
            acc += (v as f64) * (v as f64);
            self.prefix[i + 1] = acc as f32;
        }
        self.prefix[w]
    }

    fn yin(&mut self, e0: f32) -> Option<(f32, f32)> {
        let (w, tau_max) = (self.w, self.tau_max);
        self.curve[0] = 1.0;
        let mut running = 0.0f32;
        for tau in 1..=tau_max {
            let e1 = self.prefix[w + tau] - self.prefix[tau];
            let d = (e0 + e1 - 2.0 * self.acf[tau]).max(0.0);
            running += d;
            self.curve[tau] = if running > 0.0 { d * tau as f32 / running } else { 1.0 };
        }
        self.curve[tau_max + 1] = 1.0;

        let mut best: Option<usize> = None;
        let mut global = (self.tau_min, f32::MAX);
        let mut tau = self.tau_min;
        while tau <= tau_max {
            let c = self.curve[tau];
            if c < global.1 {
                global = (tau, c);
            }
            if c < YIN_THRESHOLD {
                while tau < tau_max && self.curve[tau + 1] < self.curve[tau] {
                    tau += 1;
                }
                best = Some(tau);
                break;
            }
            tau += 1;
        }
        let mut tau = best.or(if global.1 < YIN_GIVE_UP { Some(global.0) } else { None })?;
        if self.subharmonic_check && self.curve[tau] >= SUBHARMONIC_SUSPECT {
            if let Some(deeper) = self.deeper_multiple(tau) {
                tau = deeper;
            }
        }
        let c = self.curve[tau];
        let refined = parabolic(self.curve[tau - 1], c, self.curve[tau + 1], tau);
        Some((refined, (1.0 - c).clamp(0.0, 1.0)))
    }

    /// The lag of a clearly deeper dip near 2, 3 or 4 times `tau`, if the window is long enough to hold one.
    fn deeper_multiple(&self, tau: usize) -> Option<usize> {
        let shallow = self.curve[tau];
        for m in 2..=4usize {
            let centre = tau * m;
            let slack = (centre / 30).max(1);
            let (lo, hi) = (centre.saturating_sub(slack).max(self.tau_min), (centre + slack).min(self.tau_max));
            if lo >= hi {
                break;
            }
            let mut at = lo;
            for t in lo..=hi {
                if self.curve[t] < self.curve[at] {
                    at = t;
                }
            }
            if self.curve[at] < YIN_THRESHOLD && self.curve[at] < shallow * SUBHARMONIC_DEPTH_RATIO {
                return Some(at);
            }
        }
        None
    }

    fn mpm(&mut self, e0: f32) -> Option<(f32, f32)> {
        let (w, tau_max) = (self.w, self.tau_max);
        for tau in 0..=tau_max {
            let e1 = self.prefix[w + tau] - self.prefix[tau];
            let m = e0 + e1;
            self.curve[tau] = if m > 1e-12 { 2.0 * self.acf[tau] / m } else { 0.0 };
        }
        self.curve[tau_max + 1] = -1.0;

        // Key maxima: the highest point of each positive lobe after the first dip below zero.
        let mut tau = 1;
        while tau <= tau_max && self.curve[tau] > 0.0 {
            tau += 1;
        }
        let mut peaks: [(usize, f32); 24] = [(0, 0.0); 24];
        let mut count = 0;
        let mut global = 0.0f32;
        while tau <= tau_max && count < peaks.len() {
            while tau <= tau_max && self.curve[tau] <= 0.0 {
                tau += 1;
            }
            let mut top = (0usize, f32::MIN);
            while tau <= tau_max && self.curve[tau] > 0.0 {
                if self.curve[tau] > top.1 {
                    top = (tau, self.curve[tau]);
                }
                tau += 1;
            }
            if top.0 >= self.tau_min && top.1 > 0.0 {
                peaks[count] = top;
                count += 1;
                global = global.max(top.1);
            }
        }
        if count == 0 {
            return None;
        }
        let cutoff = MPM_K * global;
        let (tau, height) = peaks[..count].iter().copied().find(|p| p.1 >= cutoff)?;
        if tau + 1 > tau_max {
            return Some((tau as f32, height.clamp(0.0, 1.0)));
        }
        let refined = parabolic_max(self.curve[tau - 1], height, self.curve[tau + 1], tau);
        Some((refined, height.clamp(0.0, 1.0)))
    }

    /// The RMS over the analysed window, for callers that want the level the detector saw.
    pub fn window_rms(&self) -> f32 {
        (self.prefix[self.w] / self.w as f32).sqrt()
    }
}

/// Vertex of the parabola through three points at lags `tau-1, tau, tau+1`, minimum form.
fn parabolic(y0: f32, y1: f32, y2: f32, tau: usize) -> f32 {
    let denom = y0 - 2.0 * y1 + y2;
    if denom.abs() < 1e-12 {
        return tau as f32;
    }
    let delta = (0.5 * (y0 - y2) / denom).clamp(-1.0, 1.0);
    tau as f32 + delta
}

/// Same, for a maximum.
fn parabolic_max(y0: f32, y1: f32, y2: f32, tau: usize) -> f32 {
    parabolic(-y0, -y1, -y2, tau)
}

impl PitchDetector for TierDetector {
    fn window_len(&self) -> usize {
        self.len
    }

    fn range_hz(&self) -> (f32, f32) {
        (self.sample_rate / self.tau_max as f32, self.sample_rate / self.tau_min as f32)
    }

    fn estimate(&mut self, samples: &[f32]) -> Option<PitchEstimate> {
        if samples.len() < self.len {
            return None;
        }
        let x = &samples[samples.len() - self.len..];
        let e0 = self.correlate(x);
        let amplitude = (e0 / self.w as f32).sqrt();
        if e0 < 1e-10 {
            return None;
        }
        let (tau, confidence) = match self.algorithm {
            Algorithm::Yin => self.yin(e0)?,
            Algorithm::Mpm => self.mpm(e0)?,
        };
        Some(PitchEstimate {
            freq_hz: self.sample_rate / tau,
            confidence,
            amplitude,
            sample_pos: 0,
            tier: self.tier,
            window_len: self.len as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn detector(algo: Algorithm, min_hz: f32, max_hz: f32) -> TierDetector {
        TierDetector::new(&mut RealFftPlanner::new(), algo, 48_000.0, min_hz, max_hz, 1.0, 0)
    }

    fn harmonic(f0: f32, harmonics: &[f32], n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f32 / 48_000.0;
                harmonics.iter().enumerate().map(|(h, a)| a * (2.0 * PI * f0 * (h + 1) as f32 * t).sin()).sum()
            })
            .collect()
    }

    fn cents(a: f32, b: f32) -> f32 {
        1200.0 * (a / b).log2()
    }

    #[test]
    fn both_algorithms_read_a_pure_sine_within_a_cent() {
        for algo in [Algorithm::Yin, Algorithm::Mpm] {
            let mut d = detector(algo, 70.0, 1400.0);
            for f in [82.41f32, 110.0, 196.0, 329.63, 659.26, 1318.5] {
                let x = harmonic(f, &[1.0], d.window_len());
                let e = d.estimate(&x).unwrap_or_else(|| panic!("{algo:?} found nothing at {f}"));
                assert!(cents(e.freq_hz, f).abs() < 1.0, "{algo:?} {f} Hz read {} Hz", e.freq_hz);
                assert!(e.confidence > 0.95, "{algo:?} {f} Hz confidence {}", e.confidence);
            }
        }
    }

    #[test]
    fn a_missing_fundamental_reads_as_the_fundamental() {
        // Harmonics 2, 3 and 4 of 110 Hz only. The waveform still repeats every 110 Hz period.
        for algo in [Algorithm::Yin, Algorithm::Mpm] {
            let mut d = detector(algo, 70.0, 1400.0);
            let x = harmonic(110.0, &[0.0, 1.0, 0.8, 0.6], d.window_len());
            let e = d.estimate(&x).expect("estimate");
            assert!(cents(e.freq_hz, 110.0).abs() < 3.0, "{algo:?} read {}", e.freq_hz);
        }
    }

    #[test]
    fn silence_and_noise_do_not_report_a_pitch() {
        let mut d = detector(Algorithm::Yin, 70.0, 1400.0);
        assert!(d.estimate(&vec![0.0; d.window_len()]).is_none());
        let mut s = 12345u32;
        let noise: Vec<f32> = (0..d.window_len())
            .map(|_| {
                s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                (s >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
            })
            .collect();
        let e = d.estimate(&noise);
        assert!(e.map_or(true, |e| e.confidence < 0.85), "white noise read as a pitch: {e:?}");
    }

    #[test]
    fn range_matches_what_was_asked_for() {
        let d = detector(Algorithm::Yin, 147.0, 1400.0);
        let (lo, hi) = d.range_hz();
        assert!((lo - 147.0).abs() < 1.0, "{lo}");
        assert!(hi > 1350.0 && hi < 1500.0, "{hi}");
        assert_eq!(d.window_len(), 2 * d.tau_max());
        let short = TierDetector::new(&mut RealFftPlanner::new(), Algorithm::Yin, 48_000.0, 147.0, 1400.0, 0.6, 0);
        assert!(short.window_len() < d.window_len());
    }

    #[test]
    fn a_window_too_short_to_hold_a_period_does_not_guess_low() {
        // A 82 Hz note in a window sized for 330 Hz and up: the detector must not claim 82 Hz.
        let mut d = detector(Algorithm::Yin, 330.0, 1400.0);
        let x = harmonic(82.41, &[1.0, 0.5], d.window_len());
        if let Some(e) = d.estimate(&x) {
            assert!(e.freq_hz > 300.0, "read {} Hz", e.freq_hz);
        }
    }
}
