// What the visuals react to, reduced from raw audio: log-spaced spectrum bands, a short waveform,
// the overall level, bass/mid/treble energy and a beat pulse.
//
// `FeatureTracker::update` is fed "the audio up to now" and how much time passed since the last
// call. The live preview calls it once per GUI frame with the master tap's latest samples and the
// real frame time; the export calls it once per video frame with a window cut from the bounced WAV
// and `1 / fps`. Every smoothing constant is a time constant in seconds applied through `dt`, so
// the two move the same way even though one runs at 60 Hz and the other at 24/30/60.
use std::f32::consts::PI;

use crate::audio::analysis::{to_db, SpectrumAnalyzer};
use crate::music_video::settings::VisualizerSettings;

/// Bands every style samples from (a style with fewer bars averages neighbours).
pub const ANALYSIS_BANDS: usize = 128;
/// Points in `AudioFeatures::waveform`.
pub const WAVE_POINTS: usize = 384;
/// The FFT behind the bands. 2048 at 44.1 kHz is ~46 ms: quick enough to hit on a kick drum,
/// with ~21 Hz bins (the lowest bands interpolate between them).
pub const FEATURE_FFT: usize = 2048;
/// How much audio the waveform spans, in seconds.
pub const WAVE_SECONDS: f32 = 0.035;
/// Band edges.
pub const MIN_HZ: f32 = 32.0;
pub const MAX_HZ: f32 = 16_000.0;
/// Where a band reads 0 and 1, in dBFS before sensitivity and tilt.
const FLOOR_DB: f32 = -66.0;
const CEIL_DB: f32 = -8.0;
/// Music falls off with frequency; tilting the display up by this much per octave above 1 kHz
/// (and down below it) keeps the treble bars from looking dead next to the bass.
const TILT_DB_PER_OCTAVE: f32 = 3.0;
const BASS_MAX_HZ: f32 = 150.0;
const MID_MAX_HZ: f32 = 2_000.0;
/// A beat needs the bass this many dB over its own recent average...
const BEAT_RISE_DB: f32 = 4.5;
/// ...and at least this long since the last one (caps detection at 300 BPM).
const BEAT_REFRACTORY_S: f32 = 0.2;
/// The waveform's automatic gain never boosts more than 1 / this (so hiss stays hiss).
const WAVE_GAIN_FLOOR: f32 = 0.08;
/// Bass energy below this counts as silence for beat detection.
const BASS_FLOOR_DB: f32 = -60.0;

#[derive(Clone, Debug)]
pub struct AudioFeatures {
    /// 0..1 per log band from `MIN_HZ` to `MAX_HZ`, smoothed.
    pub bands: Vec<f32>,
    /// The mid (L+R)/2 signal over the last `WAVE_SECONDS`, -1..1 (times sensitivity), unsmoothed.
    pub waveform: Vec<f32>,
    /// Overall loudness, 0..1, smoothed.
    pub level: f32,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    /// Jumps to 1 on a detected beat and decays over ~0.2 s.
    pub beat: f32,
    /// Beats detected so far: styles that spawn something per beat compare against it.
    pub beat_count: u32,
    /// True on exactly the update that detected a beat.
    pub onset: bool,
}

impl Default for AudioFeatures {
    fn default() -> Self {
        Self {
            bands: vec![0.0; ANALYSIS_BANDS],
            waveform: vec![0.0; WAVE_POINTS],
            level: 0.0,
            bass: 0.0,
            mid: 0.0,
            treble: 0.0,
            beat: 0.0,
            beat_count: 0,
            onset: false,
        }
    }
}

/// Center frequency of analysis band `i`.
pub fn band_hz(i: usize) -> f32 {
    let frac = (i as f32 + 0.5) / ANALYSIS_BANDS as f32;
    MIN_HZ * (MAX_HZ / MIN_HZ).powf(frac)
}

/// `1 - e^(-dt/tau)`: the share of the way to a target a first-order follower moves in `dt`.
fn follow(dt: f32, tau: f32) -> f32 {
    if tau <= 0.0 { 1.0 } else { 1.0 - (-dt / tau).exp() }
}

pub struct FeatureTracker {
    analyzer: SpectrumAnalyzer,
    sample_rate: f32,
    features: AudioFeatures,
    /// Unsmoothed band values from this update, before attack/release.
    raw_bands: Vec<f32>,
    bass_slow_db: f32,
    /// Recent waveform peak, for the waveform's automatic gain.
    wave_peak: f32,
    since_beat: f32,
    primed: bool,
}

impl FeatureTracker {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            analyzer: SpectrumAnalyzer::new(),
            sample_rate: sample_rate.max(1.0),
            features: AudioFeatures::default(),
            raw_bands: vec![0.0; ANALYSIS_BANDS],
            bass_slow_db: BASS_FLOOR_DB,
            wave_peak: 0.0,
            since_beat: f32::INFINITY,
            primed: false,
        }
    }

    pub fn features(&self) -> &AudioFeatures {
        &self.features
    }

    /// Advances by `dt` seconds given the audio up to now (`left`/`right`, oldest first; only the
    /// last `FEATURE_FFT` frames are read). Shorter input reads as preceded by silence.
    pub fn update(&mut self, left: &[f32], right: &[f32], dt: f32, settings: &VisualizerSettings) -> &AudioFeatures {
        let dt = if dt.is_finite() { dt.clamp(0.0, 0.25) } else { 0.0 };
        let gain_db = 20.0 * settings.sensitivity.max(0.01).log10();
        let spectrum = self.analyzer.analyze(left, right, FEATURE_FFT, self.sample_rate);
        let bin_hz = spectrum.bin_hz().max(1e-6);
        let bins = &spectrum.bins_db;

        // Bands: interpolate where a band is narrower than a bin (the bass), otherwise average the
        // power of the bins it covers. The mean (not the loudest bin, which rises with the number
        // of bins a noisy band spans) plus the tilt makes pink noise - roughly how music is
        // balanced - read level from bass to treble.
        let edge = |k: f32| MIN_HZ * (MAX_HZ / MIN_HZ).powf(k / ANALYSIS_BANDS as f32);
        for i in 0..ANALYSIS_BANDS {
            let (lo, hi) = (edge(i as f32) / bin_hz, edge(i as f32 + 1.0) / bin_hz);
            let db = if hi - lo < 1.0 {
                let pos = ((lo + hi) * 0.5).min((bins.len() - 1) as f32);
                let (a, frac) = (pos.floor() as usize, pos.fract());
                let b = (a + 1).min(bins.len() - 1);
                bins[a] * (1.0 - frac) + bins[b] * frac
            } else {
                let (a, b) = (lo.ceil() as usize, (hi.floor() as usize).min(bins.len() - 1));
                let covered = &bins[a.min(b)..=b];
                let power = covered.iter().map(|db| 10f32.powf(db / 10.0)).sum::<f32>() / covered.len() as f32;
                10.0 * power.max(1e-12).log10()
            };
            let tilt = TILT_DB_PER_OCTAVE * (band_hz(i) / 1000.0).log2();
            self.raw_bands[i] = ((db + gain_db + tilt - FLOOR_DB) / (CEIL_DB - FLOOR_DB)).clamp(0.0, 1.0);
        }

        // Attack is always quick; `smoothing` stretches the release.
        let s = settings.smoothing;
        let up = if self.primed { follow(dt, 0.012 + 0.03 * s) } else { 1.0 };
        let down = if self.primed { follow(dt, 0.04 + 0.45 * s) } else { 1.0 };
        let smooth = |current: &mut f32, target: f32| {
            let k = if target > *current { up } else { down };
            *current += (target - *current) * k;
        };
        for (band, raw) in self.features.bands.iter_mut().zip(&self.raw_bands) {
            smooth(band, *raw);
        }

        let mean_over = |max_hz: f32, min_hz: f32, bands: &[f32]| {
            let picked: Vec<f32> = (0..ANALYSIS_BANDS).filter(|i| band_hz(*i) >= min_hz && band_hz(*i) < max_hz).map(|i| bands[i]).collect();
            if picked.is_empty() { 0.0 } else { picked.iter().sum::<f32>() / picked.len() as f32 }
        };
        let (bass, mid, treble) = (
            mean_over(BASS_MAX_HZ, 0.0, &self.raw_bands),
            mean_over(MID_MAX_HZ, BASS_MAX_HZ, &self.raw_bands),
            mean_over(f32::INFINITY, MID_MAX_HZ, &self.raw_bands),
        );
        smooth(&mut self.features.bass, bass);
        smooth(&mut self.features.mid, mid);
        smooth(&mut self.features.treble, treble);

        // Level: RMS of the newest ~23 ms, on a -48..0 dB scale.
        let n = (self.sample_rate * 0.023) as usize;
        let tail = |c: &[f32]| c[c.len().saturating_sub(n)..].iter().map(|x| x * x).sum::<f32>();
        let count = left.len().min(n).max(1) as f32;
        let rms = ((tail(left) + tail(right)) / (2.0 * count)).sqrt();
        smooth(&mut self.features.level, ((to_db(rms) + gain_db + 48.0) / 48.0).clamp(0.0, 1.0));

        // Beat: the bass energy jumping clear of its own recent average.
        let bass_power: f32 = (1..bins.len())
            .filter(|k| (*k as f32) * bin_hz < BASS_MAX_HZ)
            .map(|k| 10f32.powf(bins[k] / 10.0))
            .sum();
        // Floored, so a kick out of silence isn't measured against -120 dB, and followed with a
        // quick rise and slow fall: the average catches up with a hit within the refractory time,
        // then stays above its decaying tail instead of re-triggering on it.
        let bass_db = (10.0 * bass_power.max(1e-12).log10()).max(BASS_FLOOR_DB);
        self.since_beat += dt;
        let onset = self.primed && bass_db > BASS_FLOOR_DB + 10.0 && bass_db > self.bass_slow_db + BEAT_RISE_DB && self.since_beat >= BEAT_REFRACTORY_S;
        let tau = if bass_db > self.bass_slow_db { 0.08 } else { 0.6 };
        self.bass_slow_db += (bass_db - self.bass_slow_db) * if self.primed { follow(dt, tau) } else { 1.0 };
        self.features.onset = onset;
        if onset {
            self.since_beat = 0.0;
            self.features.beat = 1.0;
            self.features.beat_count += 1;
        } else {
            self.features.beat *= (-dt / 0.2).exp();
        }

        // Waveform: the newest WAVE_SECONDS of the mid signal, resampled with a raised-cosine
        // taper at the ends so the line meets the centre instead of jumping off-screen. An
        // automatic gain (quick to duck, slow to recover) scales a quiet mix up to fill the frame.
        let span = ((self.sample_rate * WAVE_SECONDS) as usize).max(2);
        let start = left.len().min(right.len()).saturating_sub(span);
        let available = left.len().min(right.len()) - start;
        let peak = (0..available).map(|k| (0.5 * (left[start + k] + right[start + k])).abs()).fold(0.0, f32::max);
        let k = if !self.primed || peak > self.wave_peak { follow(dt, 0.02) } else { follow(dt, 1.5) };
        self.wave_peak += (peak - self.wave_peak) * if self.primed { k } else { 1.0 };
        let wave_gain = settings.sensitivity.sqrt() * 0.8 / self.wave_peak.max(WAVE_GAIN_FLOOR);
        for (p, out) in self.features.waveform.iter_mut().enumerate() {
            let frac = p as f32 / (WAVE_POINTS - 1) as f32;
            let taper = (0.5 - 0.5 * (2.0 * PI * frac).cos()).powf(0.35);
            // Missing audio (shorter input) is the silence *before* what we have.
            let pos = frac * (span - 1) as f32 - (span - available) as f32;
            let v = if pos < 0.0 {
                0.0
            } else {
                let (a, t) = (pos.floor() as usize, pos.fract());
                let b = (a + 1).min(available - 1);
                let mid = |k: usize| 0.5 * (left[start + k] + right[start + k]);
                mid(a) * (1.0 - t) + mid(b) * t
            };
            *out = (v * wave_gain * taper).clamp(-1.0, 1.0);
        }

        self.primed = true;
        &self.features
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 44_100.0;

    fn sine(hz: f32, seconds: f32, amp: f32) -> Vec<f32> {
        (0..(SR * seconds) as usize).map(|i| amp * (2.0 * PI * hz * i as f32 / SR).sin()).collect()
    }

    #[test]
    fn silence_reads_as_nothing() {
        let mut t = FeatureTracker::new(SR);
        let quiet = vec![0.0; FEATURE_FFT];
        let f = t.update(&quiet, &quiet, 1.0 / 30.0, &VisualizerSettings::default());
        assert!(f.bands.iter().all(|b| *b == 0.0));
        assert_eq!(f.level, 0.0);
        assert_eq!(f.beat_count, 0);
    }

    #[test]
    fn a_tone_lights_the_band_it_sits_in() {
        let mut t = FeatureTracker::new(SR);
        let tone = sine(1000.0, 0.1, 0.5);
        let f = t.update(&tone, &tone, 1.0 / 30.0, &VisualizerSettings::default());
        let loudest = (0..ANALYSIS_BANDS).max_by(|a, b| f.bands[*a].total_cmp(&f.bands[*b])).unwrap();
        let hz = band_hz(loudest);
        assert!((800.0..1250.0).contains(&hz), "loudest band at {hz} Hz");
        assert!(f.level > 0.5);
        assert!(f.mid > f.bass && f.mid > f.treble);
    }

    #[test]
    fn kicks_at_120_bpm_are_counted_as_beats() {
        // A decaying 55 Hz thump every 0.5 s for 4 s, analysed at 30 fps like an export.
        let seconds = 4.0;
        let mut audio = vec![0.0f32; (SR * seconds) as usize];
        for kick in 0..8 {
            let start = (kick as f32 * 0.5 * SR) as usize;
            for i in 0..(0.25 * SR) as usize {
                let t = i as f32 / SR;
                if let Some(s) = audio.get_mut(start + i) {
                    *s += 0.8 * (2.0 * PI * 55.0 * t).sin() * (-t * 14.0).exp();
                }
            }
        }
        let mut tracker = FeatureTracker::new(SR);
        let settings = VisualizerSettings::default();
        let fps = 30.0;
        let mut onsets = 0;
        for frame in 0..(seconds * fps) as usize {
            let end = (((frame as f32 / fps) * SR) as usize + FEATURE_FFT / 2).min(audio.len());
            let window = &audio[..end];
            if tracker.update(window, window, 1.0 / fps, &settings).onset {
                onsets += 1;
            }
        }
        assert!((7..=8).contains(&onsets), "{onsets} beats detected for 8 kicks");
    }

    #[test]
    fn waveform_follows_the_signal_and_tapers_at_the_ends() {
        let mut t = FeatureTracker::new(SR);
        let tone = sine(220.0, 0.1, 0.8);
        let f = t.update(&tone, &tone, 1.0 / 30.0, &VisualizerSettings::default());
        assert_eq!(f.waveform.len(), WAVE_POINTS);
        assert_eq!(f.waveform[0], 0.0);
        assert!(f.waveform.iter().any(|v| v.abs() > 0.5));
    }

    #[test]
    fn pink_noise_reads_level_from_bass_to_treble() {
        // White noise through Paul Kellet's pink filter: equal energy per octave, like a mix.
        let mut seed = 0x1234_5678u32;
        let (mut b0, mut b1, mut b2, mut b3, mut b4, mut b5, mut b6) = (0f32, 0f32, 0f32, 0f32, 0f32, 0f32, 0f32);
        let pink: Vec<f32> = (0..FEATURE_FFT * 4)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let white = (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0;
                b0 = 0.99886 * b0 + white * 0.0555179;
                b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.96900 * b2 + white * 0.1538520;
                b3 = 0.86650 * b3 + white * 0.3104856;
                b4 = 0.55000 * b4 + white * 0.5329522;
                b5 = -0.7616 * b5 - white * 0.0168980;
                let out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
                b6 = white * 0.115926;
                out * 0.05
            })
            .collect();
        let mut t = FeatureTracker::new(SR);
        let f = t.update(&pink, &pink, 1.0 / 30.0, &VisualizerSettings::default());
        let mean = |r: std::ops::Range<usize>| r.clone().map(|i| f.bands[i]).sum::<f32>() / r.len() as f32;
        let (low, high) = (mean(20..50), mean(90..120));
        assert!(low > 0.1, "pink noise barely registers: {low}");
        // Within ~7 dB of each other on the 58 dB band scale.
        assert!((low - high).abs() < 0.12, "bass {low} vs treble {high}");
    }

    #[test]
    fn a_quiet_mix_still_fills_the_waveform() {
        let mut t = FeatureTracker::new(SR);
        let quiet = sine(220.0, 0.1, 0.1);
        let f = t.update(&quiet, &quiet, 1.0 / 30.0, &VisualizerSettings::default());
        let peak = f.waveform.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak > 0.6, "waveform peak {peak}");
    }

    #[test]
    fn smoothing_slows_the_release() {
        let tone = sine(440.0, 0.1, 0.5);
        let quiet = vec![0.0; FEATURE_FFT];
        let fall_after = |smoothing: f32| {
            let settings = VisualizerSettings { smoothing, ..Default::default() };
            let mut t = FeatureTracker::new(SR);
            t.update(&tone, &tone, 1.0 / 30.0, &settings);
            t.update(&quiet, &quiet, 1.0 / 30.0, &settings).level
        };
        assert!(fall_after(1.0) > fall_after(0.0));
    }
}
