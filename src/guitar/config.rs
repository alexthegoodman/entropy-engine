//! Settings for the guitar-to-MIDI engine. One plain struct, no dependency on the UI, the audio
//! backend or the DAW, so the whole engine can be replayed offline (see `GUITAR_TO_MIDI.md`).

/// Responsiveness mode (spec 4.8): a named set of tracker parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Mode {
    Fast,
    #[default]
    Balanced,
    Accurate,
}

impl Mode {
    pub const ALL: [Mode; 3] = [Mode::Fast, Mode::Balanced, Mode::Accurate];

    pub fn name(self) -> &'static str {
        match self {
            Mode::Fast => "fast",
            Mode::Balanced => "balanced",
            Mode::Accurate => "accurate",
        }
    }

    pub fn from_name(name: &str) -> Option<Mode> {
        match name.to_ascii_lowercase().as_str() {
            "fast" => Some(Mode::Fast),
            "balanced" => Some(Mode::Balanced),
            "accurate" => Some(Mode::Accurate),
            _ => None,
        }
    }

    pub fn params(self) -> ModeParams {
        match self {
            Mode::Fast => ModeParams { stability_ms: 1.0, min_confidence: 0.80, release_ms: 25.0, refractory_ms: 30.0 },
            Mode::Balanced => ModeParams { stability_ms: 2.7, min_confidence: 0.85, release_ms: 40.0, refractory_ms: 45.0 },
            Mode::Accurate => ModeParams { stability_ms: 8.0, min_confidence: 0.90, release_ms: 50.0, refractory_ms: 60.0 },
        }
    }
}

/// What a responsiveness mode changes.
#[derive(Clone, Copy, Debug)]
pub struct ModeParams {
    /// How long consecutive estimates must agree before a Note On is emitted.
    pub stability_ms: f32,
    /// Estimates below this confidence are ignored.
    pub min_confidence: f32,
    /// How long the envelope must stay under the close threshold before Note Off.
    pub release_ms: f32,
    /// Minimum time between two onsets.
    pub refractory_ms: f32,
}

/// Which detector core to run. Both share the same FFT autocorrelation front end.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Algorithm {
    #[default]
    Yin,
    Mpm,
}

#[derive(Clone, Debug)]
pub struct GuitarConfig {
    pub sample_rate: f32,
    pub mode: Mode,
    pub algorithm: Algorithm,
    /// A4 in Hz (EVT-1).
    pub reference_pitch: f32,
    /// Pitch-bend range in semitones each way, 1..=12 (BND-2).
    pub bend_range: f32,
    /// Detection range (PIT-3).
    pub min_hz: f32,
    pub max_hz: f32,
    /// Analysis hop in samples. Every hop the engine measures level, looks for an onset and runs the
    /// detector.
    pub hop: usize,
    /// Gate thresholds in dBFS of the 15 ms RMS, with hysteresis (DSP-2).
    pub gate_open_db: f32,
    pub gate_close_db: f32,
    /// 0..1, 0.5 is neutral. Higher accepts less certain pitches and smaller onsets.
    pub sensitivity: f32,
    /// Input gain applied before everything else, in dB (DSP-5).
    pub input_gain_db: f32,
    /// Low-pass ahead of the detector to tame upper harmonics. 0 disables it.
    pub lowpass_hz: f32,
    /// Level rise (dB of the 15 ms RMS over its recent minimum) that counts as a pick.
    pub onset_db: f32,
    /// Velocity curve: RMS at or below `velocity_floor_db` is velocity 1, at or above
    /// `velocity_ceil_db` is 127 (EVT-3).
    pub velocity_floor_db: f32,
    pub velocity_ceil_db: f32,
    pub velocity_gamma: f32,
    /// Sub-band guard: a short analysis window may not report a pitch while the signal has energy below
    /// what that window can see. Off by default: on the synthetic corpus it never changed a result once
    /// verification was in. Kept switchable until it has been checked against real recordings.
    pub guard: bool,
    /// Each window length reaches this factor lower in pitch than the one before it. Smaller means more
    /// windows and a closer fit to each note's own period, at the price of more of them to run.
    pub tier_step: f32,
    /// Integration window as a fraction of the longest lag a window reaches. 1.0 is classic YIN
    /// (window as long as the lag); shorter reads sooner and gets less certain.
    pub window_ratio: f32,
    /// Fraction of the signal energy under a tier's guard cutoff above which the tier defers.
    pub guard_ratio: f32,
    /// An estimate less sure than this waits for a window long enough to see twice its period before it
    /// counts, so a half-period dip cannot pass as the note. 0 disables the wait.
    pub verify_below_confidence: f32,
    /// Let a much deeper dip at a multiple of the first dip's lag replace it (YIN).
    pub subharmonic_check: bool,
    /// Bend messages are never sent faster than this (BND-4).
    pub bend_max_rate_hz: f32,
    /// A bend change smaller than this many cents is not sent.
    pub bend_min_delta_cents: f32,
}

impl Default for GuitarConfig {
    fn default() -> Self {
        GuitarConfig {
            sample_rate: 48_000.0,
            mode: Mode::Balanced,
            algorithm: Algorithm::Yin,
            reference_pitch: 440.0,
            bend_range: 2.0,
            min_hz: 70.0,
            max_hz: 1400.0,
            hop: 64,
            gate_open_db: -46.0,
            gate_close_db: -54.0,
            sensitivity: 0.5,
            input_gain_db: 0.0,
            lowpass_hz: 3000.0,
            onset_db: 6.0,
            velocity_floor_db: -50.0,
            velocity_ceil_db: -12.0,
            velocity_gamma: 0.8,
            guard: false,
            tier_step: 1.35,
            window_ratio: 0.8,
            guard_ratio: 0.35,
            verify_below_confidence: 0.94,
            subharmonic_check: true,
            bend_max_rate_hz: 200.0,
            bend_min_delta_cents: 0.75,
        }
    }
}

impl GuitarConfig {
    pub fn with_mode(mut self, mode: Mode) -> Self {
        self.mode = mode;
        self
    }

    pub fn with_sample_rate(mut self, sample_rate: f32) -> Self {
        self.sample_rate = sample_rate;
        self
    }

    /// Confidence a pitch estimate must reach: the mode's minimum, moved by sensitivity.
    pub fn min_confidence(&self) -> f32 {
        (self.mode.params().min_confidence - (self.sensitivity - 0.5) * 0.2).clamp(0.5, 0.99)
    }

    pub fn hop_ms(&self) -> f32 {
        self.hop as f32 / self.sample_rate * 1000.0
    }

    /// The bend range clamped to what the spec allows.
    pub fn bend_range_clamped(&self) -> f32 {
        self.bend_range.clamp(1.0, 12.0)
    }
}

/// The settings that can change while the engine runs (spec 3.5: "takes effect immediately"). The
/// rest, such as the detector's algorithm and window layout, need the engine rebuilt.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tunables {
    pub mode: Mode,
    pub sensitivity: f32,
    pub gate_open_db: f32,
    pub gate_close_db: f32,
    pub bend_range: f32,
    pub reference_pitch: f32,
    pub input_gain_db: f32,
    pub onset_db: f32,
    pub velocity_floor_db: f32,
    pub velocity_ceil_db: f32,
    pub velocity_gamma: f32,
}

impl GuitarConfig {
    pub fn tunables(&self) -> Tunables {
        Tunables {
            mode: self.mode,
            sensitivity: self.sensitivity,
            gate_open_db: self.gate_open_db,
            gate_close_db: self.gate_close_db,
            bend_range: self.bend_range,
            reference_pitch: self.reference_pitch,
            input_gain_db: self.input_gain_db,
            onset_db: self.onset_db,
            velocity_floor_db: self.velocity_floor_db,
            velocity_ceil_db: self.velocity_ceil_db,
            velocity_gamma: self.velocity_gamma,
        }
    }

    pub fn apply_tunables(&mut self, t: &Tunables) {
        self.mode = t.mode;
        self.sensitivity = t.sensitivity.clamp(0.0, 1.0);
        self.gate_open_db = t.gate_open_db;
        self.gate_close_db = t.gate_close_db.min(t.gate_open_db);
        self.bend_range = t.bend_range.clamp(1.0, 12.0);
        self.reference_pitch = t.reference_pitch.clamp(392.0, 494.0);
        self.input_gain_db = t.input_gain_db.clamp(-24.0, 48.0);
        self.onset_db = t.onset_db.clamp(2.0, 20.0);
        self.velocity_floor_db = t.velocity_floor_db;
        self.velocity_ceil_db = t.velocity_ceil_db.max(t.velocity_floor_db + 3.0);
        self.velocity_gamma = t.velocity_gamma.clamp(0.3, 3.0);
    }
}
