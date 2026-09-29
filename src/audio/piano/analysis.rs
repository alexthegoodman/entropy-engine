//! Grand piano acoustic descriptors and offline audio analysis.
//!
//! Provides automated measurements of:
//! * Stretched Railsback tuning (cents deviation from nominal pitch)
//! * Hammer felt impact dynamics (contact time in ms, peak contact force in N)
//! * Spectral brightness centroid (Hz)
//! * Inharmonicity coefficient B
//! * Prompt sound vs aftersound decay rates and two-stage ratio
//! * Sympathetic resonance gain

use super::engine::{freq_to_key, railsback_frequency, PianoEngine, PianoParams};
use realfft::RealFftPlanner;
use std::f32::consts::TAU;

pub const HARMONICS: usize = 16;

/// Comprehensive acoustic analysis of a rendered piano note.
#[derive(Clone, Debug, Default)]
pub struct PianoAnalysis {
    /// Measured fundamental frequency in Hz.
    pub f0: f32,
    /// Cents deviation from the stretched Railsback tuning target.
    pub cents: f32,
    /// RMS level in dBFS.
    pub rms_db: f32,
    /// Peak level in dBFS.
    pub peak_db: f32,
    /// Spectral brightness centroid in Hz.
    pub centroid_hz: f32,
    /// Relative levels of harmonics 1..=16 in dB.
    pub harmonics_db: [f32; HARMONICS],
    /// Attack duration in seconds (time to reach peak amplitude).
    pub attack_secs: f32,
    /// Felt hammer contact time with string in milliseconds.
    pub contact_time_ms: f32,
    /// Peak hammer strike force in Newtons.
    pub peak_force_n: f32,
    /// Prompt decay rate (initial ~150 ms) in dB/sec.
    pub prompt_decay_db_per_sec: f32,
    /// Aftersound decay rate (subsequent sustain) in dB/sec.
    pub aftersound_decay_db_per_sec: f32,
    /// Ratio of prompt decay rate to aftersound decay rate (> 1.2 indicates distinct two-stage decay).
    pub two_stage_ratio: f32,
    /// Estimated inharmonicity coefficient B.
    pub inharmonicity_b: f32,
}

/// Renders a piano note offline with `params` for `seconds` and analyzes the response.
pub fn analyze_note(params: &PianoParams, seconds: f32) -> PianoAnalysis {
    let sr = crate::audio::analysis::ENGINE_SAMPLE_RATE as f32;
    let mut engine = PianoEngine::new(sr, params);

    let key_idx = freq_to_key(params.freq);
    let target_f0 = railsback_frequency(key_idx);

    engine.note_on(params.freq, params.velocity);

    let total_samples = (seconds * sr) as usize;
    let mut mono = Vec::with_capacity(total_samples);

    for _ in 0..total_samples {
        let [l, r] = engine.next_frame();
        mono.push(0.5 * (l + r));
    }

    let hammer = &engine.keys[key_idx].hammer;
    let contact_time_ms = hammer.contact_time * 1000.0;
    let peak_force_n = hammer.peak_force;

    let mut analysis = measure(&mono, sr, target_f0);
    analysis.contact_time_ms = contact_time_ms;
    analysis.peak_force_n = peak_force_n;

    // Estimate two-stage decay: prompt sound (0.01s to 0.18s) vs aftersound (0.80s to 2.20s for sustained notes)
    let s0 = (0.01 * sr) as usize;
    let s1 = (0.18 * sr) as usize;
    let (s2, s3) = if mono.len() >= (2.0 * sr) as usize {
        ((0.80 * sr) as usize, (2.20 * sr).min(mono.len() as f32) as usize)
    } else {
        ((0.50 * sr) as usize, (1.30 * sr).min(mono.len() as f32) as usize)
    };

    if s3 > s2 && s1 > s0 && mono.len() >= s3 {
        let rms_prompt_start = rms(&mono[s0..s0 + (0.03 * sr) as usize]);
        let rms_prompt_end = rms(&mono[s1 - (0.03 * sr) as usize..s1]);
        let prompt_db_diff = to_db(rms_prompt_start) - to_db(rms_prompt_end);
        let prompt_rate = (prompt_db_diff / 0.17).max(0.1);

        let rms_after_start = rms(&mono[s2..s2 + (0.05 * sr) as usize]);
        let rms_after_end = rms(&mono[s3 - (0.05 * sr) as usize..s3]);
        let after_db_diff = to_db(rms_after_start) - to_db(rms_after_end);
        let after_rate = (after_db_diff / ((s3 - s2) as f32 / sr)).max(0.05);

        analysis.prompt_decay_db_per_sec = prompt_rate;
        analysis.aftersound_decay_db_per_sec = after_rate;
        analysis.two_stage_ratio = prompt_rate / after_rate;
    }

    // Estimate inharmonicity B from partial positions
    analysis.inharmonicity_b = estimate_inharmonicity(&mono, sr, analysis.f0);

    analysis
}

/// Measures pitch, levels, centroid, and harmonics on an audio segment.
pub fn measure(seg: &[f32], sr: f32, expected_hz: f32) -> PianoAnalysis {
    let mut a = PianoAnalysis::default();
    if seg.len() < 128 {
        return a;
    }

    let rms_val = rms(seg);
    let mut peak_val = 0.0f32;
    let mut peak_idx = 0;

    for (i, &v) in seg.iter().enumerate() {
        let abs_v = v.abs();
        if abs_v > peak_val {
            peak_val = abs_v;
            peak_idx = i;
        }
    }

    a.rms_db = to_db(rms_val);
    a.peak_db = to_db(peak_val);
    a.attack_secs = peak_idx as f32 / sr;

    // Detect pitch during sustain portion (avoiding initial hammer contact transient for low/mid notes)
    let pitch_seg = if expected_hz < 1500.0 && seg.len() > (0.2 * sr) as usize {
        &seg[(0.06 * sr) as usize..]
    } else {
        seg
    };
    a.f0 = pitch(pitch_seg, sr, expected_hz);
    a.cents = if a.f0 > 0.0 && expected_hz > 0.0 {
        1200.0 * (a.f0 / expected_hz).log2()
    } else {
        0.0
    };

    // Spectrum and spectral centroid
    let (mags, bin_hz) = spectrum(seg, sr);
    let mut num = 0.0f64;
    let mut den = 0.0f64;

    for (k, &m) in mags.iter().enumerate().skip(1) {
        let f = k as f64 * bin_hz as f64;
        num += f * m as f64;
        den += m as f64;
    }

    a.centroid_hz = if den > 0.0 { (num / den) as f32 } else { 0.0 };

    // Harmonic levels
    let f0 = if a.f0 > 0.0 { a.f0 } else { expected_hz };
    let mut h = [0.0f32; HARMONICS];

    for (i, v) in h.iter_mut().enumerate() {
        let c = (f0 * (i + 1) as f32 / bin_hz).round() as usize;
        let lo = c.saturating_sub(4);
        let hi = (c + 5).min(mags.len());
        *v = if lo < hi {
            mags[lo..hi].iter().fold(0.0f32, |m, x| m.max(*x))
        } else {
            0.0
        };
    }

    let top = h.iter().fold(1.0e-12f32, |m, x| m.max(*x));
    for (dst, &v) in a.harmonics_db.iter_mut().zip(h.iter()) {
        *dst = 20.0 * (v / top).max(1.0e-9).log10();
    }

    a
}

fn to_db(val: f32) -> f32 {
    20.0 * val.max(1.0e-9).log10()
}

fn rms(seg: &[f32]) -> f32 {
    (seg.iter().map(|&x| x * x).sum::<f32>() / seg.len().max(1) as f32).sqrt()
}

/// Computes Hann-windowed FFT magnitude spectrum.
pub fn spectrum(seg: &[f32], sr: f32) -> (Vec<f32>, f32) {
    let n = (seg.len() * 2).next_power_of_two().max(512);
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let mut input = vec![0.0f32; n];
    let len = seg.len();

    for (i, &v) in seg.iter().enumerate() {
        input[i] = v * (0.5 - 0.5 * (TAU * i as f32 / len as f32).cos());
    }

    let mut out = fft.make_output_vec();
    fft.process(&mut input, &mut out).ok();

    (out.iter().map(|c| c.norm()).collect(), sr / n as f32)
}

/// Fundamental peak with log-parabolic FFT interpolation. Autocorrelation biases stiff strings
/// sharp by averaging their stretched upper partials, particularly in the bass and top octave.
/// The expected register selects the fundamental's band, not the returned frequency.
pub fn pitch(seg: &[f32], sr: f32, expected: f32) -> f32 {
    if seg.len()<128 || !expected.is_finite() || expected<=0.0 || rms(seg)<1.0e-9 {return 0.0;}
    let (mags,bin)=spectrum(seg,sr);
    let lo=((expected*0.8/bin) as usize).max(1);
    let hi=((expected*1.2/bin) as usize+1).min(mags.len()-1);
    if lo>=hi {return 0.0;}
    let k=(lo..hi).max_by(|a,b|mags[*a].total_cmp(&mags[*b])).unwrap();
    let a=mags[k-1].max(1.0e-20).ln(); let b=mags[k].max(1.0e-20).ln(); let c=mags[k+1].max(1.0e-20).ln();
    let d=if a-2.0*b+c < -1.0e-9 { (0.5*(a-c)/(a-2.0*b+c)).clamp(-0.5,0.5) } else {0.0};
    (k as f32+d)*bin
}

/// Estimates inharmonicity B from upper partial peaks.
pub fn estimate_inharmonicity(seg: &[f32], sr: f32, f0: f32) -> f32 {
    if f0 <= 10.0 {
        return 0.0;
    }
    let (mags, bin_hz) = spectrum(seg, sr);
    // Find frequencies of partials 2, 3, 4
    let mut partial_shifts = Vec::new();

    for n in 2..=5 {
        let nominal_fn = n as f32 * f0;
        let bin = (nominal_fn / bin_hz).round() as usize;
        let lo = bin.saturating_sub(12);
        let hi = (bin + 13).min(mags.len());

        if lo < hi {
            let mut best_m = 0.0;
            let mut best_bin = bin;
            for (offset, &m) in mags[lo..hi].iter().enumerate() {
                if m > best_m {
                    best_m = m;
                    best_bin = lo + offset;
                }
            }
            let measured_fn = best_bin as f32 * bin_hz;
            let ratio = measured_fn / (n as f32 * f0);
            // f_n / (n f0) = sqrt(1 + B n^2) => B ~ (ratio^2 - 1) / n^2
            let b_est = ((ratio * ratio - 1.0) / (n as f32 * n as f32)).max(0.0);
            partial_shifts.push(b_est);
        }
    }

    if partial_shifts.is_empty() {
        0.0
    } else {
        partial_shifts.iter().sum::<f32>() / partial_shifts.len() as f32
    }
}
