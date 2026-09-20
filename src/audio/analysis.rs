//! Audio analysis: lock-free taps on the mix, and the DSP that turns a tap's samples into what
//! the oscilloscope, spectrum and level-meter widgets draw.
//!
//! The audio thread's whole contribution is `AudioTap::push`: two relaxed atomic stores and one
//! release store per frame. Everything else (copying a window out, windowing, the FFT, peak and
//! RMS) happens on the UI thread, on demand, and only for a source a widget actually asks about.
//! A tap nobody reads costs the audio thread those three stores and nothing more.

use std::collections::HashMap;
use std::sync::atomic::{fence, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use realfft::{RealFftPlanner, RealToComplex};

/// The rate every bus in `AudioEngine` runs at.
pub const ENGINE_SAMPLE_RATE: u32 = 44_100;

/// Frames a tap remembers. A power of two so the write index is a mask, and long enough (about
/// 371 ms) for the largest FFT the widgets offer plus the slack a level meter needs when the UI
/// frame is late.
pub const TAP_FRAMES: usize = 1 << 14;

/// A reader never asks for more than half the ring in one copy. The writer keeps running while
/// a copy is in flight; with at most half the ring in play it would need to lap the reader by
/// `TAP_FRAMES / 2` frames (186 ms) mid-copy before a sample could be overwritten under it.
pub const MAX_SNAPSHOT_FRAMES: usize = TAP_FRAMES / 2;

/// A stereo ring buffer the audio thread writes and the UI thread reads, with no lock between
/// them. Samples are stored as `f32` bit patterns in atomics, so there is no `unsafe` and no
/// torn `f32`; the release store on `written` publishes the frame that precedes it.
pub struct AudioTap {
    left: Box<[AtomicU32]>,
    right: Box<[AtomicU32]>,
    /// Total frames ever written, never reset. Readers use it as a clock: a difference of two
    /// reads is exactly how many frames went by, which is what a peak meter needs to avoid
    /// missing a transient between UI frames.
    written: AtomicU64,
}

impl Default for AudioTap {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioTap {
    pub fn new() -> Self {
        let ring = || (0..TAP_FRAMES).map(|_| AtomicU32::new(0)).collect::<Vec<_>>().into_boxed_slice();
        AudioTap { left: ring(), right: ring(), written: AtomicU64::new(0) }
    }

    /// Records one frame. Single writer only: the audio thread that owns the bus this tap sits
    /// on. (Two writers would race on `written`; nothing here needs that and nothing does it.)
    #[inline]
    pub fn push(&self, l: f32, r: f32) {
        let w = self.written.load(Ordering::Relaxed);
        // `written == w` already says "frame w may be mid-write". This fence keeps that
        // publication ordered before the slot stores below, as a seqlock writer's "odd" marker
        // must be; a reader that sees the new sample then also sees the counter that goes with it.
        fence(Ordering::Release);
        let i = (w as usize) & (TAP_FRAMES - 1);
        self.left[i].store(l.to_bits(), Ordering::Relaxed);
        self.right[i].store(r.to_bits(), Ordering::Relaxed);
        self.written.store(w + 1, Ordering::Release);
    }

    pub fn frames_written(&self) -> u64 {
        self.written.load(Ordering::Acquire)
    }

    /// Copies the newest `frames_for(end)` frames and proves the copy is intact: the writer keeps
    /// going while we read, so afterwards we check how far it got (a seqlock's "did the version
    /// change" test). Frame `g` is only ever overwritten once the counter reaches `g + TAP_FRAMES`,
    /// so a copy is torn exactly when `written - start >= TAP_FRAMES`.
    ///
    /// A torn copy is retaken a few times. If the writer still laps every attempt (only a test
    /// writer running flat out does; in the engine a lap is 371 ms of audio), the copy is trimmed
    /// to the suffix that provably survived, frames newer than `written - TAP_FRAMES`, rather than
    /// returned whole: a shorter window is a fine answer and a window with a splice in it is not.
    fn read(&self, frames_for: impl Fn(u64) -> usize) -> (Vec<f32>, Vec<f32>, u64) {
        let mut last = (Vec::new(), Vec::new(), 0u64);
        for attempt in 0..3 {
            let end = self.written.load(Ordering::Acquire);
            let n = frames_for(end).min(MAX_SNAPSHOT_FRAMES).min(end as usize);
            let start = end - n as u64;
            let mut left = Vec::with_capacity(n);
            let mut right = Vec::with_capacity(n);
            for f in start..end {
                let i = (f as usize) & (TAP_FRAMES - 1);
                let l = f32::from_bits(self.left[i].load(Ordering::Relaxed));
                let r = f32::from_bits(self.right[i].load(Ordering::Relaxed));
                // A NaN or infinity out of a misbehaving plugin must not reach the FFT, where it
                // would turn every bin into NaN for as long as it stays in the window.
                left.push(if l.is_finite() { l } else { 0.0 });
                right.push(if r.is_finite() { r } else { 0.0 });
            }
            // Without this fence the relaxed sample loads above may be ordered after the counter
            // load below, and a lapped copy would pass the check.
            fence(Ordering::Acquire);
            let now = self.written.load(Ordering::Relaxed);
            if now - start < TAP_FRAMES as u64 {
                return (left, right, end);
            }
            if attempt == 2 {
                let first_safe = now + 1 - TAP_FRAMES as u64;
                let drop = ((first_safe.saturating_sub(start)) as usize).min(left.len());
                left.drain(..drop);
                right.drain(..drop);
            }
            last = (left, right, end);
        }
        last
    }

    /// The most recent `frames` frames in time order (oldest first). Returns fewer when the tap
    /// has not been written that much yet, and at most `MAX_SNAPSHOT_FRAMES`.
    pub fn snapshot(&self, frames: usize) -> TapSnapshot {
        let (left, right, end) = self.read(|_| frames);
        TapSnapshot { left, right, end }
    }

    /// Peak and RMS of every frame written since `cursor` (a previous `frames_written`), plus
    /// the new cursor. `None` is a first read and looks back `first_read_frames`. (It is an
    /// `Option` and not "0 means never read" because a first read can genuinely happen before
    /// the audio thread has produced a frame, and the cursor it returns is then really 0.)
    ///
    /// Measuring since the last read instead of over a fixed trailing window is the point: a
    /// kick that lasts 10 ms is over before a meter that only looks at the last 20 ms has
    /// drawn it twice, and a UI frame that runs long would drop it entirely.
    pub fn levels_since(&self, cursor: Option<u64>, first_read_frames: usize) -> (Levels, u64) {
        let (left, right, end) = self.read(|end| match cursor {
            None => first_read_frames,
            Some(c) => end.saturating_sub(c) as usize,
        });
        (Levels::of(&left, &right), end)
    }
}

/// A copy of the most recent frames of a tap. `end` is the tap's `frames_written` at capture.
#[derive(Clone, Debug, Default)]
pub struct TapSnapshot {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub end: u64,
}

impl TapSnapshot {
    pub fn len(&self) -> usize {
        self.left.len()
    }
    pub fn is_empty(&self) -> bool {
        self.left.is_empty()
    }
}

/// Linear peak and RMS per channel over some run of frames.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Levels {
    pub peak: [f32; 2],
    pub rms: [f32; 2],
    pub frames: usize,
}

impl Levels {
    pub fn of(left: &[f32], right: &[f32]) -> Levels {
        let n = left.len().min(right.len());
        if n == 0 {
            return Levels::default();
        }
        let (mut pl, mut pr, mut sl, mut sr) = (0.0f32, 0.0f32, 0.0f64, 0.0f64);
        for i in 0..n {
            pl = pl.max(left[i].abs());
            pr = pr.max(right[i].abs());
            sl += (left[i] as f64) * (left[i] as f64);
            sr += (right[i] as f64) * (right[i] as f64);
        }
        Levels { peak: [pl, pr], rms: [(sl / n as f64).sqrt() as f32, (sr / n as f64).sqrt() as f32], frames: n }
    }
}

/// Linear amplitude to dBFS, floored at -120 so silence is a number a widget can plot.
pub fn to_db(amp: f32) -> f32 {
    if amp <= 1.0e-6 { -120.0 } else { 20.0 * amp.log10() }
}

/// The headline numbers about a source, without any drawing: what `Entropy.Audio.analyze` returns
/// to an addon or an AI tool that wants to check what a mix actually sounds like.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSummary {
    /// Peak and RMS in dBFS over the analysed window (-120 for silence).
    pub peak_l: f32,
    pub peak_r: f32,
    pub rms_l: f32,
    pub rms_r: f32,
    /// Strongest frequency above 20 Hz and its level, and the spectral centroid ("brightness").
    pub peak_hz: f32,
    pub peak_db: f32,
    pub centroid_hz: f32,
    /// Frames the tap has produced since it was created: proof the audio thread is running.
    pub frames_written: u64,
    pub window_frames: usize,
}

/// One analysed window: magnitudes in dBFS for bins 0..=N/2, plus the headline numbers the
/// AI tools and the live tests read without drawing anything.
#[derive(Clone, Debug, Default)]
pub struct Spectrum {
    pub bins_db: Vec<f32>,
    pub sample_rate: f32,
    pub fft_size: usize,
    /// Strongest bin above 20 Hz, refined by parabolic interpolation between its neighbours.
    pub peak_hz: f32,
    pub peak_db: f32,
    /// Magnitude-weighted mean frequency above 20 Hz: the "brightness" of the window.
    pub centroid_hz: f32,
}

impl Spectrum {
    pub fn bin_hz(&self) -> f32 {
        if self.fft_size == 0 { 0.0 } else { self.sample_rate / self.fft_size as f32 }
    }
}

struct Plan {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    /// `sum(window) / 2`: the peak-bin magnitude of a unit-amplitude sine. Dividing by it puts a
    /// full-scale sine at 0 dBFS, which is what a meter-style spectrum is expected to read.
    norm: f32,
}

/// Windowed real FFT with plans and window tables cached per size.
pub struct SpectrumAnalyzer {
    planner: RealFftPlanner<f32>,
    plans: HashMap<usize, Plan>,
}

impl Default for SpectrumAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

/// FFT sizes the widgets offer. Anything else is rounded to the nearest of these.
pub const FFT_SIZES: [usize; 4] = [1024, 2048, 4096, 8192];

pub fn nearest_fft_size(requested: usize) -> usize {
    *FFT_SIZES.iter().min_by_key(|s| (**s as i64 - requested as i64).abs()).unwrap()
}

impl SpectrumAnalyzer {
    pub fn new() -> Self {
        SpectrumAnalyzer { planner: RealFftPlanner::new(), plans: HashMap::new() }
    }

    fn plan(&mut self, n: usize) -> &Plan {
        if !self.plans.contains_key(&n) {
            let fft = self.planner.plan_fft_forward(n);
            // Periodic Hann (denominator N, not N-1): the right window for spectral analysis,
            // where the frame is one period of an implied periodic signal.
            let window: Vec<f32> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos()).collect();
            let norm = window.iter().sum::<f32>() / 2.0;
            self.plans.insert(n, Plan { fft, window, norm });
        }
        &self.plans[&n]
    }

    /// Spectrum of the most recent `fft_size` frames of `left`/`right`. A shorter input is
    /// treated as preceded by silence. The two channels are combined as
    /// `sqrt((|L|^2 + |R|^2) / 2)` per bin, so a mono signal (L == R) reads the same as either
    /// channel alone and a hard-panned one is not 6 dB down the way it would be in (L + R) / 2.
    pub fn analyze(&mut self, left: &[f32], right: &[f32], fft_size: usize, sample_rate: f32) -> Spectrum {
        let n = nearest_fft_size(fft_size);
        let plan = self.plan(n);
        let fft = plan.fft.clone();
        let norm = plan.norm;

        let mut power = vec![0.0f32; n / 2 + 1];
        for channel in [left, right] {
            let take = channel.len().min(n);
            let tail = &channel[channel.len() - take..];
            let mut input = fft.make_input_vec();
            let offset = n - take;
            let plan = &self.plans[&n];
            for (i, s) in tail.iter().enumerate() {
                input[offset + i] = s * plan.window[offset + i];
            }
            let mut output = fft.make_output_vec();
            fft.process(&mut input, &mut output).expect("fft buffers are sized by the plan");
            for (p, c) in power.iter_mut().zip(output.iter()) {
                *p += (c.re * c.re + c.im * c.im) * 0.5;
            }
        }

        let mags: Vec<f32> = power.iter().map(|p| p.sqrt() / norm).collect();
        let bins_db: Vec<f32> = mags.iter().map(|m| to_db(*m)).collect();
        let bin_hz = sample_rate / n as f32;
        let first = ((20.0 / bin_hz).ceil() as usize).max(1);

        let (mut peak_k, mut peak_m) = (first, 0.0f32);
        let (mut weighted, mut total) = (0.0f64, 0.0f64);
        for k in first..mags.len() {
            if mags[k] > peak_m {
                peak_m = mags[k];
                peak_k = k;
            }
            weighted += (k as f64) * (bin_hz as f64) * (mags[k] as f64);
            total += mags[k] as f64;
        }

        // Parabolic interpolation on the dB values of the peak and its neighbours. A Hann main
        // lobe is close enough to a parabola in dB that this lands well inside one bin.
        let mut peak_hz = peak_k as f32 * bin_hz;
        if peak_k > 0 && peak_k + 1 < bins_db.len() && peak_m > 0.0 {
            let (a, b, c) = (bins_db[peak_k - 1], bins_db[peak_k], bins_db[peak_k + 1]);
            let denom = a - 2.0 * b + c;
            if denom.abs() > 1.0e-6 {
                peak_hz += (0.5 * (a - c) / denom).clamp(-0.5, 0.5) * bin_hz;
            }
        }

        Spectrum {
            peak_db: bins_db[peak_k],
            centroid_hz: if total > 0.0 { (weighted / total) as f32 } else { 0.0 },
            peak_hz: if peak_m > 0.0 { peak_hz } else { 0.0 },
            bins_db,
            sample_rate,
            fft_size: n,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, amp: f32, frames: usize, phase: f32) -> Vec<f32> {
        (0..frames).map(|i| amp * (2.0 * std::f32::consts::PI * freq * i as f32 / ENGINE_SAMPLE_RATE as f32 + phase).sin()).collect()
    }

    #[test]
    fn a_full_scale_sine_at_a_bin_centre_reads_zero_dbfs() {
        let bin_hz = ENGINE_SAMPLE_RATE as f32 / 4096.0;
        let f = bin_hz * 93.0;
        let s = sine(f, 1.0, 4096, 0.3);
        let spec = SpectrumAnalyzer::new().analyze(&s, &s, 4096, ENGINE_SAMPLE_RATE as f32);
        assert!(spec.peak_db.abs() < 0.05, "peak {} dB", spec.peak_db);
        assert!((spec.peak_hz - f).abs() < 0.5, "peak {} Hz for {} Hz", spec.peak_hz, f);
    }

    #[test]
    fn amplitude_scales_in_db() {
        let bin_hz = ENGINE_SAMPLE_RATE as f32 / 4096.0;
        let f = bin_hz * 200.0;
        let s = sine(f, 0.25, 4096, 0.0);
        let spec = SpectrumAnalyzer::new().analyze(&s, &s, 4096, ENGINE_SAMPLE_RATE as f32);
        assert!((spec.peak_db - (-12.04)).abs() < 0.1, "a 0.25 sine should read -12.04 dBFS, got {}", spec.peak_db);
    }

    #[test]
    fn an_off_centre_sine_is_within_hann_scalloping_and_a_bin_of_its_frequency() {
        // Worst case for a Hann window is a tone exactly between two bins.
        let bin_hz = ENGINE_SAMPLE_RATE as f32 / 4096.0;
        let f = bin_hz * 92.5;
        let s = sine(f, 1.0, 4096, 1.1);
        let spec = SpectrumAnalyzer::new().analyze(&s, &s, 4096, ENGINE_SAMPLE_RATE as f32);
        assert!(spec.peak_db < 0.05 && spec.peak_db > -1.6, "scalloping loss {} dB", spec.peak_db);
        assert!((spec.peak_hz - f).abs() < 0.3 * bin_hz, "estimated {} Hz for {} Hz", spec.peak_hz, f);
    }

    #[test]
    fn one_kilohertz_is_found_to_within_one_hertz_at_every_fft_size() {
        for size in FFT_SIZES {
            let s = sine(1000.0, 0.8, size, 0.7);
            let spec = SpectrumAnalyzer::new().analyze(&s, &s, size, ENGINE_SAMPLE_RATE as f32);
            let tol = ENGINE_SAMPLE_RATE as f32 / size as f32 * 0.25;
            assert!((spec.peak_hz - 1000.0).abs() < tol.max(1.0), "size {size}: {} Hz", spec.peak_hz);
        }
    }

    #[test]
    fn silence_is_at_the_floor_and_has_no_peak() {
        let z = vec![0.0f32; 4096];
        let spec = SpectrumAnalyzer::new().analyze(&z, &z, 4096, ENGINE_SAMPLE_RATE as f32);
        assert!(spec.bins_db.iter().all(|d| *d <= -119.9));
        assert_eq!(spec.peak_hz, 0.0);
        assert_eq!(spec.centroid_hz, 0.0);
    }

    #[test]
    fn a_hard_panned_tone_is_not_six_db_down() {
        let bin_hz = ENGINE_SAMPLE_RATE as f32 / 4096.0;
        let f = bin_hz * 120.0;
        let s = sine(f, 1.0, 4096, 0.0);
        let zero = vec![0.0f32; 4096];
        let spec = SpectrumAnalyzer::new().analyze(&s, &zero, 4096, ENGINE_SAMPLE_RATE as f32);
        // Power-average of a single channel: sqrt((1 + 0) / 2) = -3.01 dB, and (L+R)/2 would say -6.02.
        assert!((spec.peak_db - (-3.01)).abs() < 0.1, "{} dB", spec.peak_db);
    }

    #[test]
    fn a_non_finite_sample_cannot_poison_the_spectrum() {
        let tap = AudioTap::new();
        for i in 0..4096 {
            let v = if i == 100 { f32::NAN } else if i == 200 { f32::INFINITY } else { 0.5 * (i as f32 * 0.05).sin() };
            tap.push(v, v);
        }
        let snap = tap.snapshot(4096);
        assert!(snap.left.iter().chain(snap.right.iter()).all(|v| v.is_finite()));
        let spec = SpectrumAnalyzer::new().analyze(&snap.left, &snap.right, 4096, ENGINE_SAMPLE_RATE as f32);
        assert!(spec.bins_db.iter().all(|d| d.is_finite()));
    }

    #[test]
    fn a_short_window_is_padded_with_silence_not_stretched() {
        let s = sine(1000.0, 1.0, 1000, 0.0);
        let spec = SpectrumAnalyzer::new().analyze(&s, &s, 4096, ENGINE_SAMPLE_RATE as f32);
        assert!((spec.peak_hz - 1000.0).abs() < 20.0);
        assert!(spec.peak_db < 0.0, "a quarter-full window must read lower than a full one");
    }

    #[test]
    fn centroid_follows_brightness() {
        let dark = sine(200.0, 0.5, 4096, 0.0);
        let bright: Vec<f32> = dark.iter().zip(sine(6000.0, 0.5, 4096, 0.0)).map(|(a, b)| a + b).collect();
        let mut an = SpectrumAnalyzer::new();
        let a = an.analyze(&dark, &dark, 4096, ENGINE_SAMPLE_RATE as f32);
        let b = an.analyze(&bright, &bright, 4096, ENGINE_SAMPLE_RATE as f32);
        assert!(a.centroid_hz < 400.0, "{}", a.centroid_hz);
        assert!(b.centroid_hz > 2500.0 && b.centroid_hz < 3500.0, "two equal tones average near 3100 Hz, got {}", b.centroid_hz);
    }

    #[test]
    fn the_tap_returns_frames_in_time_order_across_a_wrap() {
        let tap = AudioTap::new();
        let total = TAP_FRAMES + 1234;
        for i in 0..total {
            tap.push(i as f32, -(i as f32));
        }
        let snap = tap.snapshot(1000);
        assert_eq!(snap.len(), 1000);
        assert_eq!(snap.end, total as u64);
        for (k, v) in snap.left.iter().enumerate() {
            assert_eq!(*v, (total - 1000 + k) as f32);
            assert_eq!(snap.right[k], -(*v));
        }
    }

    #[test]
    fn a_snapshot_is_capped_and_a_young_tap_returns_what_it_has() {
        let tap = AudioTap::new();
        assert!(tap.snapshot(500).is_empty());
        for i in 0..300 {
            tap.push(i as f32, 0.0);
        }
        assert_eq!(tap.snapshot(500).len(), 300);
        for _ in 0..TAP_FRAMES {
            tap.push(0.0, 0.0);
        }
        assert_eq!(tap.snapshot(TAP_FRAMES).len(), MAX_SNAPSHOT_FRAMES);
    }

    #[test]
    fn levels_since_a_cursor_catch_a_transient_a_fixed_window_would_miss() {
        let tap = AudioTap::new();
        let (_, cursor) = tap.levels_since(None, 512);
        // A 4-frame click of full scale, then 3000 frames of near silence: a reader that only
        // looks at the last 512 frames would see none of it.
        for _ in 0..4 {
            tap.push(1.0, -0.5);
        }
        for _ in 0..3000 {
            tap.push(0.001, 0.001);
        }
        let (since, next) = tap.levels_since(Some(cursor), 512);
        assert_eq!(since.peak[0], 1.0);
        assert_eq!(since.peak[1], 0.5);
        assert_eq!(next, tap.frames_written());
        let trailing = Levels::of(&tap.snapshot(512).left, &tap.snapshot(512).right);
        assert!(trailing.peak[0] < 0.01, "the trailing window really does miss it: {}", trailing.peak[0]);
    }

    #[test]
    fn a_first_read_made_before_any_audio_still_measures_everything_after_it() {
        // The bug this pins down: a meter that first reads while the tap is still empty gets
        // cursor 0 back, and a "0 means never read" reader then treats its second read as a first.
        let tap = AudioTap::new();
        let (_, cursor) = tap.levels_since(None, 735);
        assert_eq!(cursor, 0);
        for _ in 0..2000 {
            tap.push(0.0, 0.0);
        }
        tap.push(0.9, 0.0);
        for _ in 0..2000 {
            tap.push(0.0, 0.0);
        }
        let (since, _) = tap.levels_since(Some(cursor), 735);
        assert_eq!(since.frames, 4001);
        assert_eq!(since.peak[0], 0.9);
    }

    #[test]
    fn rms_of_a_full_scale_sine_is_minus_three_db() {
        let s = sine(441.0, 1.0, 44100, 0.0);
        let lv = Levels::of(&s, &s);
        assert!((to_db(lv.rms[0]) - (-3.01)).abs() < 0.02);
        assert!((to_db(lv.peak[0]) - 0.0).abs() < 0.01);
    }

    /// Runs a writer emitting a ramp that wraps every 1,000,000 frames while this thread takes
    /// maximum-size snapshots for 600 ms. Every snapshot, whatever its length, must be a run of
    /// consecutive ramp values: a copy the writer overwrote partway through shows a jump.
    /// `pace` frames between yields sets how fast the writer runs (0 = flat out, which laps the
    /// 16,384-frame ring in tens of microseconds, far faster than a reader can copy 8,192 frames).
    fn hammer(pace: usize) -> (u32, u32) {
        const WRAP: u32 = 1_000_000;
        let tap = Arc::new(AudioTap::new());
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = {
            let (tap, stop) = (tap.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut i = 0u32;
                let mut since_yield = 0usize;
                while !stop.load(Ordering::Relaxed) {
                    tap.push(i as f32, i as f32);
                    i = (i + 1) % WRAP;
                    since_yield += 1;
                    if pace > 0 && since_yield >= pace {
                        since_yield = 0;
                        std::thread::yield_now();
                    }
                }
            })
        };
        let started = std::time::Instant::now();
        let (mut full, mut short) = (0u32, 0u32);
        while started.elapsed() < std::time::Duration::from_millis(600) {
            let snap = tap.snapshot(MAX_SNAPSHOT_FRAMES);
            for w in snap.left.windows(2) {
                let step = w[1] - w[0];
                assert!(step == 1.0 || step == -((WRAP - 1) as f32), "torn snapshot ending at frame {} (pace {pace}): {} then {}", snap.end, w[0], w[1]);
            }
            if snap.len() == MAX_SNAPSHOT_FRAMES { full += 1 } else { short += 1 }
        }
        stop.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        (full, short)
    }

    #[test]
    fn a_paced_writer_never_tears_a_snapshot() {
        let (full, _) = hammer(256);
        assert!(full > 100, "only {full} full snapshots were checked");
    }

    #[test]
    fn a_flat_out_writer_that_laps_the_reader_still_never_tears_one() {
        let (full, short) = hammer(0);
        println!("flat-out writer: {full} full and {short} trimmed snapshots, none torn");
        assert!(full + short > 100);
    }
}
