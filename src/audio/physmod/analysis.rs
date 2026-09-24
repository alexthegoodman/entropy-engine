//! Listening by numbers: renders a note through the instrument and measures what a musician would
//! hear and what a physicist would check - pitch in cents, loudness, brightness, the harmonic
//! balance, and what the bow is doing (clean Helmholtz motion, surface sound, raucous crunch, and how
//! long the attack took to settle). The same measurements back the tests, the AI tool
//! (`Entropy.PhysMod.analyzeNote`) and the model report, so what they claim is one computation.

use super::engine::{Engine, PhysModParams};
use super::BowRegime;
use realfft::RealFftPlanner;
use std::f32::consts::TAU;

/// Harmonics reported, fundamental first.
pub const HARMONICS: usize = 16;

#[derive(Clone, Debug, Default)]
pub struct NoteAnalysis {
    /// Measured fundamental, Hz (autocorrelation with parabolic refinement).
    pub f0: f32,
    /// How far `f0` is from the requested pitch, cents.
    pub cents: f32,
    pub rms_db: f32,
    pub peak_db: f32,
    /// Spectral centroid, Hz.
    pub centroid_hz: f32,
    /// Level of harmonics 1..=HARMONICS relative to the strongest, dB.
    pub harmonics_db: [f32; HARMONICS],
    /// Contact statistics of the played string over the analysis window.
    pub slips_per_period: f32,
    pub stick_fraction: f32,
    pub regime: Option<BowRegime>,
    /// Seconds from note-on until the stick-slip settles into one release per period (10 periods
    /// in a row within 6% of the period), `None` if it never did in the render.
    pub attack_secs: Option<f32>,
    /// The string the note was played on.
    pub string: usize,
}

/// Renders `p` held for `seconds` and analyses the last `window` seconds of the held part.
pub fn analyze_note(p: &PhysModParams, seconds: f32, window: f32) -> NoteAnalysis {
    let sr = super::ENGINE_SAMPLE_RATE as f32;
    let mut p = *p;
    p.duration = seconds + 1.0;
    let mut e = Engine::new(sr, &p);
    let s = e.note_on(1, p, false, None);
    let n = (seconds * sr) as usize;
    let w0 = n.saturating_sub((window * sr) as usize);
    let mut left = Vec::with_capacity(n);
    let period = sr / p.freq.max(1.0);
    let (mut prev_stuck, mut last_rel, mut run, mut run_start) = (true, None::<usize>, 0u32, 0usize);
    let mut attack = None;
    let mut reports = [Default::default(); super::MAX_ALL_STRINGS];
    for i in 0..n {
        if i == w0 {
            e.report(&mut reports);
        }
        let [l, _] = e.next_frame();
        left.push(l);
        let stuck = e.string(s).contact.is_stuck();
        if attack.is_none() && prev_stuck && !stuck {
            if let Some(lr) = last_rel {
                let iv = (i - lr) as f32;
                if (iv / period - 1.0).abs() < 0.06 {
                    if run == 0 {
                        run_start = lr;
                    }
                    run += 1;
                    if run >= 10 {
                        attack = Some(run_start as f32 / sr);
                    }
                } else {
                    run = 0;
                }
            }
            last_rel = Some(i);
        }
        prev_stuck = stuck;
    }
    e.report(&mut reports);
    let r = reports[s];
    let seg = &left[w0..];
    let mut a = measure(seg, sr, p.freq);
    a.slips_per_period = r.slips_per_period;
    a.stick_fraction = r.stick_fraction;
    a.attack_secs = attack;
    a.string = s;
    let info = super::StringInfo { bow_force: r.bow_force, slips_per_period: r.slips_per_period, force_min: r.force_min, force_max: r.force_max, ..Default::default() };
    a.regime = Some(info.regime());
    a
}

/// Pitch, level and spectrum of a mono segment, relative to `expected` Hz.
pub fn measure(seg: &[f32], sr: f32, expected: f32) -> NoteAnalysis {
    let mut a = NoteAnalysis::default();
    if seg.len() < 64 {
        return a;
    }
    let rms = (seg.iter().map(|x| x * x).sum::<f32>() / seg.len() as f32).sqrt();
    let peak = seg.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    a.rms_db = 20.0 * rms.max(1.0e-9).log10();
    a.peak_db = 20.0 * peak.max(1.0e-9).log10();
    a.f0 = pitch(seg, sr, expected);
    a.cents = if a.f0 > 0.0 && expected > 0.0 { 1200.0 * (a.f0 / expected).log2() } else { 0.0 };
    let (mags, bin_hz) = spectrum(seg, sr);
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for (k, m) in mags.iter().enumerate().skip(1) {
        num += (k as f64 * bin_hz as f64) * *m as f64;
        den += *m as f64;
    }
    a.centroid_hz = if den > 0.0 { (num / den) as f32 } else { 0.0 };
    let f0 = if a.f0 > 0.0 { a.f0 } else { expected };
    let mut h = [0.0f32; HARMONICS];
    for (i, v) in h.iter_mut().enumerate() {
        let c = (f0 * (i + 1) as f32 / bin_hz).round() as usize;
        let lo = c.saturating_sub(3);
        let hi = (c + 4).min(mags.len());
        *v = if lo < hi { mags[lo..hi].iter().fold(0.0f32, |m, x| m.max(*x)) } else { 0.0 };
    }
    let top = h.iter().fold(1.0e-12f32, |m, x| m.max(*x));
    for (dst, v) in a.harmonics_db.iter_mut().zip(h.iter()) {
        *dst = 20.0 * (v / top).max(1.0e-9).log10();
    }
    a
}

/// Hann-windowed magnitude spectrum, zero-padded to a power of two (at least 4x the segment).
pub fn spectrum(seg: &[f32], sr: f32) -> (Vec<f32>, f32) {
    let n = (seg.len() * 4).next_power_of_two();
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let mut input = vec![0.0f32; n];
    let len = seg.len();
    for (i, v) in seg.iter().enumerate() {
        input[i] = v * (0.5 - 0.5 * (TAU * i as f32 / len as f32).cos());
    }
    let mut out = fft.make_output_vec();
    fft.process(&mut input, &mut out).ok();
    (out.iter().map(|c| c.norm()).collect(), sr / n as f32)
}

/// Fundamental by normalised autocorrelation, searched within an octave either side of `expected`
/// (so a strong second harmonic can't be mistaken for the pitch), refined parabolically.
pub fn pitch(seg: &[f32], sr: f32, expected: f32) -> f32 {
    let n = seg.len();
    let lag_lo = ((sr / (expected * 2.0)).floor() as usize).max(2);
    let lag_hi = ((sr / (expected * 0.5)).ceil() as usize).min(n / 2);
    if lag_hi <= lag_lo + 2 {
        return 0.0;
    }
    let ac = |lag: usize| -> f32 {
        let m = n - lag;
        let (mut xy, mut xx, mut yy) = (0.0f64, 0.0f64, 0.0f64);
        for i in 0..m {
            let (x, y) = (seg[i] as f64, seg[i + lag] as f64);
            xy += x * y;
            xx += x * x;
            yy += y * y;
        }
        (xy / (xx * yy).sqrt().max(1.0e-20)) as f32
    };
    let vals: Vec<f32> = (lag_lo..=lag_hi).map(ac).collect();
    // The first peak that comes close to the best one: the true period rather than a multiple.
    let best = vals.iter().fold(f32::MIN, |m, v| m.max(*v));
    let mut k = 0;
    for i in 1..vals.len() - 1 {
        if vals[i] >= vals[i - 1] && vals[i] >= vals[i + 1] && vals[i] > best * 0.9 {
            k = i;
            break;
        }
    }
    if k == 0 {
        k = vals.iter().enumerate().fold((0, f32::MIN), |b, (i, v)| if *v > b.1 { (i, *v) } else { b }).0.clamp(1, vals.len() - 2);
    }
    let (a, b, c) = (vals[k - 1], vals[k], vals[k + 1]);
    let denom = a - 2.0 * b + c;
    let d = if denom.abs() > 1.0e-12 { 0.5 * (a - c) / denom } else { 0.0 };
    sr / ((lag_lo + k) as f32 + d)
}
