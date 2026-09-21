//! The guitar-to-MIDI engine core: conditioning, onset and gate, length-adaptive pitch detection and
//! the note tracker, driven one buffer at a time. No audio device, no UI, no allocation after
//! `new` (spec 4.12), so the same code runs on the audio thread and in an offline replay.

use super::config::GuitarConfig;
use super::dsp::{amp_to_db, BandGuard, Biquad, DcBlocker, Ring};
use super::events::EventSink;
use super::pitch::{PitchDetector, PitchEstimate, TierDetector};
use super::tracker::{HopInput, Tracker, TrackerState, TrackerStats, Want};
use realfft::RealFftPlanner;

/// Lowest note of the shortest window. Below this the next window length takes over.
const FIRST_TIER_HZ: f32 = 330.0;
/// A tier reports notes down to `tier_min * TIER_HEADROOM`'s period; a following note may bend below its start.
const FOLLOW_HEADROOM: f32 = 1.3;
/// A verifying window must reach this many periods of the estimate to see whether the true period is longer.
const VERIFY_PERIODS: f32 = 2.05;
/// The guard looks at energy under this fraction of a tier's lowest frequency.
const GUARD_CUTOFF_RATIO: f32 = 0.6;
/// Time constant of the guard's energy averages, seconds.
const GUARD_TIME_CONSTANT_S: f32 = 0.006;
/// Length of the RMS window that defines level, milliseconds. Must span a full period of the lowest
/// note (14.3 ms at 70 Hz): shorter, and a low string with weak fundamental ripples by more than the
/// onset threshold within every cycle and looks like a new pick each time.
const LEVEL_WINDOW_MS: f32 = 15.0;
/// Hops of level history kept to find the floor an onset rises from.
const LEVEL_HISTORY: usize = 10;
/// Milliseconds after a pick skipped before a window may start, to leave the pick click out.
const ATTACK_SKIP_MS: f32 = 1.0;
/// DC blocker corner, Hz. Well under the lowest detectable note.
const DC_CORNER_HZ: f32 = 20.0;

/// What the engine measured and decided, for the diagnostics panel (DIA-1). Plain data, copied out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Diagnostics {
    /// 15 ms RMS, dBFS, after input gain.
    pub level_db: f32,
    /// Largest absolute sample seen since the last `take_peak`, 0..1+.
    pub input_peak: f32,
    pub clipping: bool,
    pub freq_hz: f32,
    pub confidence: f32,
    /// Which window length produced the last estimate.
    pub tier: u8,
    pub note: Option<u8>,
    pub cents: f32,
    pub state: TrackerState,
    pub velocity: u8,
    pub bend: u16,
    /// Samples from the last Note On's pick to the moment it was emitted.
    pub last_latency_samples: u64,
    pub stats: TrackerStats,
    /// The analysis hop ran long enough to matter for the real-time budget: hops that took longer
    /// than one hop of audio is worth. Filled in by the live wrapper, which owns a clock.
    pub overruns: u64,
}

pub struct GuitarEngine {
    cfg: GuitarConfig,
    input_gain: f32,
    dc: DcBlocker,
    lowpass: Option<Biquad>,
    ring: Ring,
    tiers: Vec<TierDetector>,
    guards: Vec<BandGuard>,
    seg: Vec<f32>,
    tracker: Tracker,
    hop: usize,
    hop_fill: usize,
    level_window: usize,
    attack_skip: u64,
    history: [f32; LEVEL_HISTORY],
    history_len: usize,
    history_pos: usize,
    last_level_db: f32,
    peak_since_take: f32,
    diag: Diagnostics,
}

impl GuitarEngine {
    pub fn new(cfg: GuitarConfig) -> Self {
        let fs = cfg.sample_rate;
        let hop = cfg.hop.max(16);

        let mut planner = RealFftPlanner::<f32>::new();
        let mut tiers = Vec::new();
        let mut guards = Vec::new();
        let mut lo = FIRST_TIER_HZ.max(cfg.min_hz);
        loop {
            let last = lo <= cfg.min_hz * 1.001;
            tiers.push(TierDetector::new(&mut planner, cfg.algorithm, fs, lo, cfg.max_hz, cfg.window_ratio, tiers.len() as u8));
            if last {
                break;
            }
            guards.push(BandGuard::new(fs, lo * GUARD_CUTOFF_RATIO, GUARD_TIME_CONSTANT_S));
            lo = (lo / cfg.tier_step.max(1.05)).max(cfg.min_hz);
            // Do not spend a window on a range the previous one already covers to within 15%.
            if lo < cfg.min_hz * 1.15 {
                lo = cfg.min_hz;
            }
        }
        for t in tiers.iter_mut() {
            t.set_subharmonic_check(cfg.subharmonic_check);
        }
        let longest = tiers.last().map_or(0, |t| t.window_len());
        let level_window = ((LEVEL_WINDOW_MS * fs / 1000.0) as usize).max(hop);

        let tracker = Tracker::new(&cfg);
        let diag = Diagnostics {
            level_db: -120.0,
            input_peak: 0.0,
            clipping: false,
            freq_hz: 0.0,
            confidence: 0.0,
            tier: 0,
            note: None,
            cents: 0.0,
            state: TrackerState::Silent,
            velocity: 0,
            bend: 8192,
            last_latency_samples: 0,
            stats: TrackerStats::default(),
            overruns: 0,
        };
        GuitarEngine {
            input_gain: 10f32.powf(cfg.input_gain_db / 20.0),
            dc: DcBlocker::new(fs, DC_CORNER_HZ),
            lowpass: (cfg.lowpass_hz > 0.0).then(|| Biquad::lowpass(fs, cfg.lowpass_hz, 0.7071)),
            ring: Ring::new(longest.max(level_window) + hop),
            seg: vec![0.0; longest],
            tiers,
            guards,
            tracker,
            hop,
            hop_fill: 0,
            level_window,
            attack_skip: (ATTACK_SKIP_MS * fs / 1000.0) as u64,
            // As if silence came before the first sample: a note that starts in the first hop is a
            // rise from nothing, not a baseline to measure later rises against.
            history: [-120.0; LEVEL_HISTORY],
            history_len: LEVEL_HISTORY,
            history_pos: 0,
            last_level_db: -120.0,
            peak_since_take: 0.0,
            diag,
            cfg,
        }
    }

    pub fn config(&self) -> &GuitarConfig {
        &self.cfg
    }

    /// Applies runtime-changeable settings. Allocation free, so it is safe on the audio thread.
    pub fn set_tunables(&mut self, t: &super::config::Tunables) {
        self.cfg.apply_tunables(t);
        self.input_gain = 10f32.powf(self.cfg.input_gain_db / 20.0);
        self.tracker.reconfigure(&self.cfg);
    }

    /// Window lengths in samples, shortest first. For diagnostics and tests.
    pub fn tier_lengths(&self) -> Vec<usize> {
        self.tiers.iter().map(|t| t.window_len()).collect()
    }

    pub fn tier_ranges_hz(&self) -> Vec<(f32, f32)> {
        self.tiers.iter().map(|t| t.range_hz()).collect()
    }

    /// Total samples processed.
    pub fn position(&self) -> u64 {
        self.ring.written()
    }

    pub fn diagnostics(&self) -> Diagnostics {
        self.diag
    }

    /// Largest absolute input sample since the previous call, for the level meter and clip light.
    pub fn take_peak(&mut self) -> f32 {
        std::mem::take(&mut self.peak_since_take)
    }

    /// Releases any note and centers the bend (EVT-6). Call on stop, device change and exit.
    pub fn release_all(&mut self, sink: &mut impl EventSink) {
        let now = self.ring.written();
        self.tracker.release_all(now, sink);
        self.refresh_diagnostics();
    }

    /// Clears every filter and the tracker, releasing notes first.
    pub fn reset(&mut self, sink: &mut impl EventSink) {
        self.release_all(sink);
        self.dc.reset();
        if let Some(lp) = self.lowpass.as_mut() {
            lp.reset();
        }
        self.guards.iter_mut().for_each(|g| g.reset());
        self.ring.clear();
        self.hop_fill = 0;
        self.history = [-120.0; LEVEL_HISTORY];
        self.history_len = LEVEL_HISTORY;
        self.history_pos = 0;
        self.tracker = Tracker::new(&self.cfg);
    }

    /// Feeds mono samples in `[-1, 1]`. Events go to `sink` as they are decided.
    pub fn process(&mut self, block: &[f32], sink: &mut impl EventSink) {
        for &raw in block {
            let raw = if raw.is_finite() { raw } else { 0.0 };
            let x = raw * self.input_gain;
            self.peak_since_take = self.peak_since_take.max(x.abs());
            let mut y = self.dc.process(x);
            if let Some(lp) = self.lowpass.as_mut() {
                y = lp.process(y);
            }
            for g in self.guards.iter_mut() {
                g.process(y);
            }
            self.ring.push(y);
            self.hop_fill += 1;
            if self.hop_fill == self.hop {
                self.hop_fill = 0;
                self.on_hop(sink);
            }
        }
    }

    fn level_db(&self) -> f32 {
        let n = self.level_window.min(self.ring.written() as usize).max(1);
        amp_to_db((self.ring.energy(n) / n as f32).sqrt())
    }

    /// A pick is a rise of `onset_db` over the lowest level of the last few hops, on a signal loud
    /// enough to be a note (DSP-4).
    fn detect_onset(&mut self, level_db: f32) -> (bool, f32) {
        let floor = if self.history_len == 0 { level_db } else { self.history[..self.history_len].iter().copied().fold(f32::MAX, f32::min) };
        let threshold = self.cfg.onset_db - (self.cfg.sensitivity - 0.5) * 4.0;
        let onset = level_db >= self.cfg.gate_open_db && level_db - floor >= threshold;
        self.history[self.history_pos] = level_db;
        self.history_pos = (self.history_pos + 1) % LEVEL_HISTORY;
        self.history_len = (self.history_len + 1).min(LEVEL_HISTORY);
        (onset, floor)
    }

    fn on_hop(&mut self, sink: &mut impl EventSink) {
        let now = self.ring.written();
        let level_db = self.level_db();
        let (onset, onset_floor_db) = self.detect_onset(level_db);
        self.last_level_db = level_db;

        let estimate = match self.tracker.want() {
            Want::Nothing => None,
            Want::Search { onset_sample } => self.search(onset_sample, now),
            Want::Follow { hz, onset_sample } => self.follow(hz, onset_sample, now),
        };

        let input = HopInput {
            sample: now,
            level_db,
            onset,
            // The 15 ms level window lags the pick by up to a hop or two; the rise is first visible one hop back.
            onset_sample: now.saturating_sub(self.hop as u64),
            onset_floor_db,
            estimate,
        };
        self.tracker.step(&input, sink);
        if let Some(e) = estimate {
            self.diag.freq_hz = e.freq_hz;
            self.diag.confidence = e.confidence;
            self.diag.tier = e.tier;
        }
        self.refresh_diagnostics();
    }

    fn refresh_diagnostics(&mut self) {
        self.diag.level_db = self.last_level_db;
        self.diag.input_peak = self.peak_since_take;
        self.diag.clipping = self.diag.input_peak >= db_to_clip();
        self.diag.state = self.tracker.state();
        self.diag.note = self.tracker.active_note();
        self.diag.cents = self.tracker.cents();
        self.diag.velocity = self.tracker.velocity();
        self.diag.bend = self.tracker.bend();
        self.diag.stats = self.tracker.stats();
        if let Some((emitted, picked)) = self.tracker.last_note_on() {
            self.diag.last_latency_samples = emitted.saturating_sub(picked);
        }
    }

    /// Tries window lengths from short to long, using only the signal since the pick. A window that
    /// reaches lower than the signal has been playing is not tried yet, and one whose guard hears energy
    /// under its own range defers to a longer one, so a low string is not read an octave up by a window
    /// too short to hold its period (PIT-6).
    fn search(&mut self, onset_sample: u64, now: u64) -> Option<PitchEstimate> {
        let since = now.saturating_sub(onset_sample + self.attack_skip) as usize;
        let last = self.tiers.len() - 1;
        let min_conf = self.cfg.min_confidence();
        let mut best: Option<PitchEstimate> = None;
        for k in 0..self.tiers.len() {
            let len = self.tiers[k].window_len();
            if len > since {
                break;
            }
            if self.cfg.guard && k < last && self.guards[k].ratio() > self.cfg.guard_ratio {
                continue;
            }
            self.ring.latest(&mut self.seg[..len]);
            if let Some(mut e) = self.tiers[k].estimate(&self.seg[..len]) {
                e.sample_pos = now;
                if e.confidence >= min_conf {
                    if e.confidence >= self.cfg.verify_below_confidence {
                        return Some(e);
                    }
                    // Not sure enough to trust a window that cannot see two of its own periods.
                    return self.verify(e, since, now);
                }
                if best.map_or(true, |b| e.confidence > b.confidence) {
                    best = Some(e);
                }
            }
        }
        best
    }

    /// Re-reads an unsure estimate with the shortest window that holds twice its period. Until that
    /// window has enough signal there is no answer, and the note waits.
    fn verify(&mut self, first: PitchEstimate, since: usize, now: u64) -> Option<PitchEstimate> {
        let tau = self.cfg.sample_rate / first.freq_hz;
        let Some(j) = self.tiers.iter().position(|t| t.tau_max() as f32 >= tau * VERIFY_PERIODS) else {
            // Nothing longer exists: the lowest notes are as verified as they can be.
            return Some(first);
        };
        let len = self.tiers[j].window_len();
        if len > since {
            return None;
        }
        self.ring.latest(&mut self.seg[..len]);
        let mut e = self.tiers[j].estimate(&self.seg[..len])?;
        e.sample_pos = now;
        (e.confidence >= self.cfg.min_confidence()).then_some(e)
    }

    /// One detection at the window length that fits the held note, with room to bend below it.
    fn follow(&mut self, hz: f32, onset_sample: u64, now: u64) -> Option<PitchEstimate> {
        let since = now.saturating_sub(onset_sample + self.attack_skip) as usize;
        let tau = self.cfg.sample_rate / hz.max(1.0);
        let mut k = self.tiers.iter().position(|t| t.tau_max() as f32 >= tau * FOLLOW_HEADROOM).unwrap_or(self.tiers.len() - 1);
        while k > 0 && self.tiers[k].window_len() > since {
            k -= 1;
        }
        let len = self.tiers[k].window_len();
        if len > since {
            return None;
        }
        self.ring.latest(&mut self.seg[..len]);
        let mut e = self.tiers[k].estimate(&self.seg[..len])?;
        e.sample_pos = now;
        Some(e)
    }
}

/// -1 dBFS, the clip warning (spec 3.1).
fn db_to_clip() -> f32 {
    0.891
}
