//! Polyphonic pitch detection: which notes are sounding in a stretch of signal, several at once.
//!
//! The monophonic detector (`pitch.rs`) asks "what is the period of this waveform?", which has no
//! answer when two strings ring. This one works on the spectrum instead, in the way of Klapuri's
//! iterative estimation and cancellation (2006):
//!
//! 1. Window the newest samples (Hann), zero pad, FFT, and read each bin as a sinusoid amplitude.
//! 2. Score every candidate note by the weighted amplitudes it finds at its partials: its salience.
//! 3. Take the best, measure its partials, smooth them against their neighbours and subtract that
//!    note's spectrum. Repeat on what is left, until what is left is too weak to be a note.
//!
//! The smoothing is what lets a note an octave above another be found at all: every partial of E3 is
//! also a partial of E2, and E2's even partials come out stronger than its odd ones when E3 rings with
//! it. Clipping them to the envelope of their neighbours leaves E3's share behind in the residual.
//!
//! Guitar knowledge narrows the search: only notes the tuning can reach are candidates, and a set of
//! notes that would need two notes on one string is not accepted (`tab::playable`).
//!
//! Nothing allocates after `new` (RT-1, RT-2).

use super::dsp::amp_to_db;
use super::events::midi_to_hz;
use super::tab;
use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

/// Notes above a note found that can hide entirely in its partials, with the frequency ratio. Only the
/// octave: a twelfth or two octaves up is almost always also an octave of another chord tone, and is
/// found from that one; tested directly, they were the commonest false notes.
const DOUBLINGS: [(u8, usize); 1] = [(12, 2)];
/// The shared partials must come out this much stronger, in total, than their neighbours predict.
/// Measured on the synthetic corpus: a string alone 6 to 12%, with its octave 36 to 69%.
const DOUBLING_EXCESS: f32 = 0.25;
/// A candidate with less than this share of its salience on partials of notes found is "clean".
const CLEAN_OVERLAP: f32 = 0.3;
/// Intervals below a note whose partials include all of the note's, with the frequency ratio.
const LOWER_RELATIVES: [(u8, usize); 4] = [(24, 4), (19, 3), (12, 2), (28, 5)];
/// Most notes one frame can report: one per string.
pub const MAX_NOTES: usize = 6;
/// Partials looked at per candidate.
const MAX_PARTIALS: usize = 16;
/// Nothing above this frequency is used: a pickup puts little there and the pick noise a lot.
const TOP_HZ: f32 = 5000.0;
/// A partial is searched for within this many cents of where it is expected.
const PARTIAL_TOL_CENTS: f32 = 40.0;
/// How far a candidate's partials may drift from the note's exact pitch, in cents, as they are
/// followed up the series (string stiffness sharpens the upper partials; the tuning may be off).
const MAX_DRIFT_CENTS: f32 = 45.0;
/// The noise floor is the median bin in this band, and anything under `NOISE_MULT` times it is noise.
const FLOOR_LO_HZ: f32 = 1500.0;
const FLOOR_HI_HZ: f32 = 5000.0;
const NOISE_MULT: f32 = 3.0;
/// A lower note's own fundamental must be at least this fraction of the upper note's for the lower
/// note to be preferred (see `PolyParams::lower_evidence`).
const LOWER_FUNDAMENTAL: f32 = 0.15;
/// A low partial this many cents off the pitch its note's other partials agree on is shared with a
/// neighbouring note (two peaks merged into one); only half of it is taken away with its note.
const MERGED_CENTS: f32 = 25.0;
/// A partial may be this much over what its neighbours predict before the excess is left for another note.
const SMOOTH_HEADROOM: f32 = 1.15;
/// A note's fundamental must be at least this fraction of its strongest partial.
const MIN_FUNDAMENTAL: f32 = 0.08;
/// Window lengths are multiples of this, so every Hann window used can be computed up front.
pub const WINDOW_STEP: usize = 128;
/// Shortest window analysed.
pub const MIN_WINDOW: usize = 512;

/// One note found in a frame.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct PolyNote {
    pub note: u8,
    /// Measured from the partials, so it follows the string's real tuning.
    pub freq_hz: f32,
    /// RMS of the note's own partials, dBFS: how loud this string is on its own.
    pub strength_db: f32,
    /// The detector's score, relative to the strongest note in the frame (1.0 for that note).
    pub salience: f32,
}

/// Every note found in one analysis, strongest first.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct PolyFrame {
    pub notes: [PolyNote; MAX_NOTES],
    pub count: usize,
}

impl PolyFrame {
    pub fn iter(&self) -> impl Iterator<Item = &PolyNote> {
        self.notes[..self.count].iter()
    }

    pub fn get(&self, note: u8) -> Option<&PolyNote> {
        self.iter().find(|n| n.note == note)
    }

    pub fn contains(&self, note: u8) -> bool {
        self.get(note).is_some()
    }

    fn push(&mut self, n: PolyNote) {
        if self.count < MAX_NOTES {
            self.notes[self.count] = n;
            self.count += 1;
        }
    }
}

/// What the detector is told about the notes already sounding: they get the benefit of the doubt
/// (a lower bar to be found again), which keeps a decaying chord from flickering.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NoteSet(pub u128);

impl NoteSet {
    pub fn contains(self, note: u8) -> bool {
        note < 128 && self.0 & (1u128 << note) != 0
    }

    pub fn insert(&mut self, note: u8) {
        if note < 128 {
            self.0 |= 1u128 << note;
        }
    }

    pub fn remove(&mut self, note: u8) {
        if note < 128 {
            self.0 &= !(1u128 << note);
        }
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn len(self) -> usize {
        self.0.count_ones() as usize
    }

    pub fn iter(self) -> impl Iterator<Item = u8> {
        (0u8..128).filter(move |&n| self.contains(n))
    }
}

/// Thresholds for accepting a note. Plain numbers so a benchmark can sweep them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PolyParams {
    /// A new note's salience must reach this fraction of the frame's strongest.
    pub rel_new: f32,
    /// The same, for a new note whose partials mostly land where no note found has one: nothing else
    /// could have put them there, so less is asked of it.
    pub rel_clean: f32,
    /// A new note more than this many dB under the frame's loudest is not reported. Strings in one strum
    /// are within a few dB of each other; leftovers of imperfect subtraction are far quieter.
    pub max_below_db: f32,
    /// The same, for a note that is already sounding.
    pub rel_active: f32,
    /// The same, for a new note whose partials all sit on partials of a note already found (an octave,
    /// a twelfth or two octaves above it): the likeliest ghost, so it must show more.
    pub rel_related: f32,
    /// A new note quieter than this (its own partials, dBFS RMS) is not reported.
    pub floor_new_db: f32,
    /// The same, for a note already sounding.
    pub floor_active_db: f32,
    /// Salience multiplier for notes already sounding.
    pub active_bonus: f32,
    /// Klapuri's partial weights, `(f0 + alpha) / (h f0 + beta)`, Hz.
    pub alpha_hz: f32,
    pub beta_hz: f32,
    /// Amplitudes are raised to this power before they are scored (1 is none). Below 1 flattens the
    /// spectrum, so weak upper partials count for more: Klapuri's whitening, in its simplest form.
    pub compress: f32,
    /// Before an upper note is taken, the notes an octave, a twelfth or two octaves below it are tried:
    /// if the partials of one that the upper note cannot explain carry this share of the upper note's
    /// salience, the lower note is the one playing and is taken first.
    pub lower_evidence: f32,
    /// How strongly the partials of a note found are smoothed before they are taken away: 0 keeps them
    /// as measured, 1 clips each to the mean of itself and its neighbours.
    pub smoothing: f32,
}

impl Default for PolyParams {
    fn default() -> Self {
        PolyParams {
            rel_new: 0.22,
            rel_clean: 0.2,
            max_below_db: 20.0,
            rel_active: 0.10,
            rel_related: 0.45,
            floor_new_db: -52.0,
            floor_active_db: -60.0,
            active_bonus: 1.25,
            alpha_hz: 27.0,
            beta_hz: 320.0,
            compress: 1.0,
            lower_evidence: 0.2,
            smoothing: 1.0,
        }
    }
}

/// Why a candidate was or was not taken as a note.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Verdict {
    #[default]
    Accepted,
    /// Fewer than two real partials.
    NotANote,
    /// Quieter than the floor.
    TooQuiet,
    /// Too little salience next to the strongest note.
    TooWeak,
    /// Sits on the partials of a note already found and did not stand out enough from them.
    Ghost,
    /// No string left to play it on.
    Unplayable,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TraceEntry {
    pub note: u8,
    /// Salience against the frame's strongest note.
    pub rel: f32,
    pub strength_db: f32,
    pub verdict: Verdict,
}

#[derive(Clone, Copy, Debug, Default)]
struct Partial {
    freq: f32,
    amp: f32,
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    note: u8,
    f0: f32,
    /// Strings that can play it.
    strings: u8,
}

pub struct PolyDetector {
    sample_rate: f32,
    fft: Arc<dyn RealToComplex<f32>>,
    input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    /// Hann windows for every length `WINDOW_STEP * (i + 1)` up to the longest.
    windows: Vec<Vec<f32>>,
    /// Sinusoid amplitude per bin for the frame being analysed.
    mag: Vec<f32>,
    residual: Vec<f32>,
    candidates: Vec<Candidate>,
    /// Scratch for one candidate's partials.
    partials: [Partial; MAX_PARTIALS],
    best_partials: [Partial; MAX_PARTIALS],
    tuning: [u8; 6],
    frets: u8,
    params: PolyParams,
    /// Length of the window last analysed.
    last_len: usize,
    bin_hz: f32,
    trace: [TraceEntry; MAX_NOTES * 3],
    trace_len: usize,
    strictness: f32,
    floor_bins: (usize, usize),
    floor_scratch: Vec<f32>,
    noise_floor: f32,
}

impl PolyDetector {
    /// Candidates run from `min_hz` to `max_hz`, limited to what `tuning` reaches; windows up to
    /// `max_window` samples.
    pub fn new(planner: &mut RealFftPlanner<f32>, sample_rate: f32, min_hz: f32, max_hz: f32, reference: f32, tuning: [u8; 6], frets: u8, max_window: usize) -> Self {
        let max_window = (max_window / WINDOW_STEP).max(MIN_WINDOW / WINDOW_STEP) * WINDOW_STEP;
        // Zero padding to at least twice the window, for finer peak positions.
        let n_fft = (max_window * 2).next_power_of_two();
        let fft = planner.plan_fft_forward(n_fft);
        let windows = (1..=max_window / WINDOW_STEP)
            .map(|i| {
                let len = i * WINDOW_STEP;
                (0..len).map(|n| 0.5 - 0.5 * (std::f32::consts::TAU * (n as f32 + 0.5) / len as f32).cos()).collect()
            })
            .collect();
        let lo = (69.0 + 12.0 * (min_hz / reference).log2()).ceil().max(0.0) as u8;
        let hi = (69.0 + 12.0 * (max_hz / reference).log2()).floor().min(127.0) as u8;
        let candidates = (lo..=hi)
            .filter_map(|note| {
                let strings = tab::strings_for(note, &tuning, frets);
                (strings != 0).then(|| Candidate { note, f0: midi_to_hz(note as f32, reference), strings })
            })
            .collect();
        let bin_hz = sample_rate / n_fft as f32;
        let floor_top = FLOOR_HI_HZ.min(sample_rate * 0.45);
        let floor_bins = ((FLOOR_LO_HZ / bin_hz) as usize, ((floor_top / bin_hz) as usize).max((FLOOR_LO_HZ / bin_hz) as usize));
        PolyDetector {
            sample_rate,
            input: fft.make_input_vec(),
            spectrum: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
            windows,
            mag: vec![0.0; n_fft / 2 + 1],
            residual: vec![0.0; n_fft / 2 + 1],
            candidates,
            partials: [Partial::default(); MAX_PARTIALS],
            best_partials: [Partial::default(); MAX_PARTIALS],
            tuning,
            frets,
            params: PolyParams::default(),
            last_len: 0,
            bin_hz: sample_rate / n_fft as f32,
            trace: [TraceEntry::default(); MAX_NOTES * 3],
            trace_len: 0,
            strictness: 1.0,
            floor_bins,
            floor_scratch: vec![0.0; floor_bins.1 - floor_bins.0],
            noise_floor: 0.0,
        }
    }

    pub fn params(&self) -> PolyParams {
        self.params
    }

    pub fn set_params(&mut self, p: PolyParams) {
        self.params = p;
    }

    /// Multiplies the bars new notes must clear. A short window blurs partials together and leaves
    /// more behind when a note is taken away, so it is read more sceptically.
    pub fn set_strictness(&mut self, s: f32) {
        self.strictness = s.max(0.1);
    }

    /// Amplitude (dBFS) of the peak at `f0` in the last analysis, the noise floor taken off; -120 when
    /// there is none. Whether a string is still sounding at all, whatever else was found.
    pub fn fundamental_db(&self, f0: f32) -> f32 {
        // The level at the fundamental, anywhere within half a bin of this window's own resolution. No
        // peak is asked for: in a short window a neighbour's lobe can pull the peak off to one side.
        let half = (0.5 * self.sample_rate / self.last_len.max(1) as f32).max(self.bin_hz);
        let lo = ((f0 - half) / self.bin_hz).floor().max(1.0) as usize;
        let hi = (((f0 + half) / self.bin_hz).ceil() as usize).min(self.mag.len() - 1);
        let peak = self.mag[lo..=hi].iter().copied().fold(0.0f32, f32::max);
        if peak > 0.0 { amp_to_db(peak) } else { -120.0 }
    }

    /// Length of the window last analysed.
    pub fn last_window(&self) -> usize {
        self.last_len
    }

    /// Longest window this detector can analyse.
    pub fn max_window(&self) -> usize {
        self.windows.len() * WINDOW_STEP
    }

    /// Candidate notes, lowest first.
    pub fn note_range(&self) -> (u8, u8) {
        (self.candidates.first().map_or(0, |c| c.note), self.candidates.last().map_or(0, |c| c.note))
    }

    /// Moves every candidate to a new reference pitch (A4), keeping the note range.
    pub fn set_reference(&mut self, reference: f32) {
        for c in self.candidates.iter_mut() {
            c.f0 = midi_to_hz(c.note as f32, reference);
        }
    }

    /// Sinusoid amplitude per bin of the last analysis, and the width of a bin in Hz.
    pub fn spectrum(&self) -> (&[f32], f32) {
        (&self.mag, self.bin_hz)
    }

    /// The window length `analyze` will use for `available` samples.
    pub fn window_for(&self, available: usize) -> usize {
        (available / WINDOW_STEP * WINDOW_STEP).clamp(MIN_WINDOW, self.max_window())
    }

    /// Finds the notes in the newest `window_for(samples.len())` samples. `active` are the notes
    /// already sounding.
    pub fn analyze(&mut self, samples: &[f32], active: NoteSet, out: &mut PolyFrame) {
        *out = PolyFrame::default();
        self.trace_len = 0;
        let len = self.window_for(samples.len());
        if samples.len() < len {
            return;
        }
        self.transform(&samples[samples.len() - len..]);
        self.residual.copy_from_slice(&self.mag);

        let p = self.params;
        let mut first_salience = 0.0f32;
        // Candidates turned down for a reason that does not rule out a weaker one (the string rule, a
        // ghost of a note already found) are skipped from then on.
        let mut excluded = NoteSet::default();
        let mut found_notes = [0u8; MAX_NOTES];
        for _ in 0..MAX_NOTES * 3 {
            if out.count == MAX_NOTES {
                break;
            }
            // --- The best remaining candidate.
            let mut best: Option<(usize, f32)> = None;
            for i in 0..self.candidates.len() {
                let c = self.candidates[i];
                if excluded.contains(c.note) || out.contains(c.note) {
                    continue;
                }
                let raw = self.salience(c.f0, false);
                let score = if active.contains(c.note) { raw * p.active_bonus } else { raw };
                if best.map_or(true, |b| score > b.1) {
                    best = Some((i, score));
                }
            }
            let Some((mut i, mut score)) = best else { break };
            if score <= 0.0 {
                break;
            }
            // --- Prefer the lowest note that explains it. A chord's doubled octaves pile their energy
            // on the upper note's partials, so the upper note often scores best, though it is the lower
            // one whose partials it is standing on.
            'lower: loop {
                let c = self.candidates[i];
                let raw = if active.contains(c.note) { score / p.active_bonus } else { score };
                for (interval, ratio) in LOWER_RELATIVES {
                    let Some(j) = c.note.checked_sub(interval).and_then(|n| self.candidate_index(n)) else { continue };
                    let l = self.candidates[j];
                    if excluded.contains(l.note) || out.contains(l.note) {
                        continue;
                    }
                    if self.unique_evidence(l.f0, ratio, c.f0) >= p.lower_evidence * raw {
                        i = j;
                        let lraw = self.salience(l.f0, false);
                        score = if active.contains(l.note) { lraw * p.active_bonus } else { lraw };
                        continue 'lower;
                    }
                }
                break;
            }
            let c = self.candidates[i];
            // Measure it again, keeping its partials this time.
            self.salience(c.f0, true);
            let (strength_db, freq, sure) = self.smooth_and_measure(c.f0);
            let is_active = active.contains(c.note);
            let rel = if first_salience > 0.0 { score / first_salience } else { 1.0 };
            // An octave or twelfth above a note found is the likeliest ghost; a semitone next to one is the
            // next likeliest (what is left of a partial taken away at slightly the wrong pitch).
            let related = !is_active && found_notes[..out.count].iter().any(|&f| harmonic_above(f, c.note) || f.abs_diff(c.note) == 1);
            let floor = if is_active { p.floor_active_db } else { p.floor_new_db };
            let clean = !related && self.overlap(c.f0, &out) < CLEAN_OVERLAP;
            let need = if is_active {
                p.rel_active
            } else if related {
                p.rel_related * self.strictness
            } else if clean {
                p.rel_clean * self.strictness
            } else {
                p.rel_new * self.strictness
            };
            let loudest = out.iter().map(|n| n.strength_db).fold(f32::MIN, f32::max);

            // --- Is it a note?
            let verdict = if !sure {
                Verdict::NotANote
            } else if strength_db < floor || (!is_active && strength_db < loudest - p.max_below_db) {
                Verdict::TooQuiet
            } else if rel < need {
                if related { Verdict::Ghost } else { Verdict::TooWeak }
            } else {
                found_notes[out.count] = c.note;
                if tab::playable(&found_notes[..=out.count], &self.tuning, self.frets) { Verdict::Accepted } else { Verdict::Unplayable }
            };
            self.log(TraceEntry { note: c.note, rel, strength_db, verdict });
            if verdict != Verdict::Accepted {
                excluded.insert(c.note);
                // Under every bar there is: nothing weaker can be a note either.
                if strength_db < p.floor_active_db.min(floor) && rel < p.rel_active.min(need) {
                    break;
                }
                continue;
            }
            if first_salience == 0.0 {
                first_salience = score;
            }
            self.subtract();
            out.push(PolyNote { note: c.note, freq_hz: freq, strength_db, salience: score / first_salience });
            self.doublings(out.count - 1, active, out);
            for (k, n) in out.iter().enumerate() {
                found_notes[k] = n.note;
            }
        }
    }

    /// The notes an octave, a twelfth or two octaves above a note found, which the pass above cannot
    /// see: every partial of the upper note is a partial of the lower, and it went with it. What gives
    /// it away is the lower note's envelope: its partials that the upper note shares come out stronger
    /// than their neighbours say they should be. Partials that another note found also explains are
    /// left out of the count.
    fn doublings(&mut self, i: usize, active: NoteSet, out: &mut PolyFrame) {
        // A short window cannot tell an envelope's own unevenness from a note on top of it.
        if self.strictness > 1.0 {
            return;
        }
        let base = out.notes[i];
        for (interval, ratio) in DOUBLINGS {
            if out.count == MAX_NOTES {
                return;
            }
            let upper = base.note.saturating_add(interval);
            let Some(j) = self.candidate_index(upper) else { continue };
            if out.contains(upper) {
                continue;
            }
            let mut notes = [0u8; MAX_NOTES];
            for (k, n) in out.iter().enumerate() {
                notes[k] = n.note;
            }
            notes[out.count] = upper;
            if !tab::playable(&notes[..=out.count], &self.tuning, self.frets) {
                continue;
            }
            let f_base = base.freq_hz;
            // Partials measured in the whole spectrum, not the residual: a neighbour another note took
            // away would read as low and make any partial look like an excess.
            let shared = |h: usize, me: &Self| h == 0 || out.iter().enumerate().any(|(k, n)| k != i && shares_partial(n.freq_hz, h as f32 * f_base)) || me.partial_in(&me.mag, h as f32 * f_base).is_none();
            let amp = |h: usize, me: &Self| me.partial_in(&me.mag, h as f32 * f_base).map_or(0.0, |p| p.amp);
            let (mut excess, mut predicted, mut strong, mut used) = (0.0f32, 0.0f32, 0, 0);
            let mut h = ratio;
            while h < MAX_PARTIALS {
                if !shared(h, self) {
                    let a = amp(h, self);
                    let below = (!shared(h - 1, self)).then(|| amp(h - 1, self));
                    let above = (!shared(h + 1, self)).then(|| amp(h + 1, self));
                    let pred = match (below, above) {
                        (Some(b), Some(c)) => Some(0.5 * (b + c)),
                        (Some(v), None) | (None, Some(v)) => Some(v),
                        (None, None) => None,
                    };
                    if let Some(pred) = pred {
                        let over = (a - pred).max(0.0);
                        excess += over;
                        predicted += pred;
                        used += 1;
                        if over >= 0.5 * pred {
                            strong += 1;
                        }
                    }
                }
                h += ratio;
            }
            let need = if active.contains(upper) { 0.5 * DOUBLING_EXCESS } else { DOUBLING_EXCESS * self.strictness };
            let found_ratio = if predicted > 0.0 { excess / predicted } else { 0.0 };
            if used < 2 || strong < 2 || found_ratio < need {
                self.log(TraceEntry { note: upper, rel: found_ratio, strength_db: -200.0, verdict: Verdict::Ghost });
                continue;
            }
            // It is there: measure it in what is left and take it away like any other note.
            let f0 = self.candidates[j].f0;
            self.salience(f0, true);
            let (strength_db, freq, _) = self.smooth_and_measure(f0);
            let floor = if active.contains(upper) { self.params.floor_active_db } else { self.params.floor_new_db };
            if strength_db < floor {
                self.log(TraceEntry { note: upper, rel: found_ratio, strength_db, verdict: Verdict::TooQuiet });
                continue;
            }
            self.log(TraceEntry { note: upper, rel: found_ratio, strength_db, verdict: Verdict::Accepted });
            self.subtract();
            out.push(PolyNote { note: upper, freq_hz: freq, strength_db, salience: found_ratio });
        }
    }

    /// Share of the kept partials' weighted amplitude that sits on a partial of a note in `found`.
    fn overlap(&self, f0: f32, found: &PolyFrame) -> f32 {
        let (mut shared, mut total) = (0.0f32, 0.0f32);
        for (h, p) in self.partials.iter().enumerate() {
            if p.amp <= 0.0 {
                continue;
            }
            let w = self.weight(f0, h + 1) * p.amp;
            total += w;
            if found.iter().any(|n| shares_partial(n.freq_hz, p.freq)) {
                shared += w;
            }
        }
        if total > 0.0 { shared / total } else { 1.0 }
    }

    fn candidate_index(&self, note: u8) -> Option<usize> {
        let first = self.candidates.first()?.note;
        let j = note.checked_sub(first)? as usize;
        (j < self.candidates.len() && self.candidates[j].note == note).then_some(j)
    }

    /// Salience of `f0` counted only on the partials a note `ratio` times higher does not share: the
    /// odd ones for an octave, those not divisible by three for a twelfth. Zero unless at least two of
    /// them are there.
    fn unique_evidence(&self, f0: f32, ratio: usize, upper_f0: f32) -> f32 {
        let tol = (PARTIAL_TOL_CENTS / 1200.0).exp2() - 1.0;
        let find = |expect: f32| self.peak(expect - (expect * tol).max(self.bin_hz * 1.5), expect + (expect * tol).max(self.bin_hz * 1.5));
        // Its own fundamental must be there, and not faint next to the upper note's: a lower note that
        // only exists as partials it shares with other chord tones is not played.
        let Some(fund) = find(f0) else { return 0.0 };
        if (1200.0 * (fund.freq / f0).log2()).abs() > PARTIAL_TOL_CENTS {
            return 0.0;
        }
        let upper = find(upper_f0).map_or(0.0, |p| p.amp);
        if fund.amp < LOWER_FUNDAMENTAL * upper {
            return 0.0;
        }
        let mut total = 0.0;
        let mut found = 0;
        for h in 1..=8usize {
            if h % ratio == 0 {
                continue;
            }
            let expect = h as f32 * f0;
            if expect > TOP_HZ {
                break;
            }
            if let Some(p) = find(expect).filter(|p| (1200.0 * (p.freq / expect).log2()).abs() <= PARTIAL_TOL_CENTS) {
                total += self.weight(f0, h) * p.amp.powf(self.params.compress);
                found += 1;
            }
        }
        if found >= 2 { total } else { 0.0 }
    }

    fn log(&mut self, e: TraceEntry) {
        if self.trace_len < self.trace.len() {
            self.trace[self.trace_len] = e;
            self.trace_len += 1;
        }
    }

    /// Every candidate the last analysis weighed, in the order it weighed them, and what it decided
    /// (DIA-3: rejected estimates and why).
    pub fn trace(&self) -> &[TraceEntry] {
        &self.trace[..self.trace_len]
    }

    /// Window, FFT and amplitude spectrum of `x` (its length is a multiple of `WINDOW_STEP`).
    fn transform(&mut self, x: &[f32]) {
        let len = x.len();
        let w = &self.windows[len / WINDOW_STEP - 1];
        for (o, (s, w)) in self.input.iter_mut().zip(x.iter().zip(w.iter())) {
            *o = s * w;
        }
        self.input[len..].iter_mut().for_each(|v| *v = 0.0);
        // Lengths are fixed at construction, so this cannot fail.
        self.fft.process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch).expect("fft length");
        // A Hann window's coherent gain is 1/2: a sinusoid of amplitude A peaks at A * len / 4.
        let scale = 4.0 / len as f32;
        for (m, c) in self.mag.iter_mut().zip(self.spectrum.iter()) {
            *m = c.norm() * scale;
        }
        self.last_len = len;
        // The noise floor: the median bin where a guitar's partials are few and weak. Everything is
        // measured above a few times it, so broadband noise adds nothing to any candidate.
        let (lo, hi) = self.floor_bins;
        if hi > lo {
            let scratch = &mut self.floor_scratch[..hi - lo];
            scratch.copy_from_slice(&self.mag[lo..hi]);
            let mid = scratch.len() / 2;
            let (_, median, _) = scratch.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
            self.noise_floor = *median;
            let cut = self.noise_floor * NOISE_MULT;
            self.mag.iter_mut().for_each(|m| *m = (*m - cut).max(0.0));
        }
    }

    /// Median amplitude per bin between 1.5 and 5 kHz in the last analysis, before it was taken off.
    pub fn noise_floor(&self) -> f32 {
        self.noise_floor
    }

    /// The partial nearest `freq` in `spec`, within the partial tolerance.
    fn partial_in(&self, spec: &[f32], freq: f32) -> Option<Partial> {
        let half = (freq * ((PARTIAL_TOL_CENTS / 1200.0).exp2() - 1.0)).max(self.bin_hz);
        self.peak_in(spec, freq - half, freq + half)
    }

    /// The strongest local maximum of the residual between `lo` and `hi` Hz, refined by a parabola
    /// through the log amplitudes.
    fn peak(&self, lo: f32, hi: f32) -> Option<Partial> {
        self.peak_in(&self.residual, lo, hi)
    }

    fn peak_in(&self, spec: &[f32], lo: f32, hi: f32) -> Option<Partial> {
        let k_lo = ((lo / self.bin_hz).ceil() as usize).max(1);
        let k_hi = ((hi / self.bin_hz).floor() as usize).min(spec.len() - 2);
        let mut best: Option<usize> = None;
        for k in k_lo..=k_hi {
            let v = spec[k];
            if v > 0.0 && v >= spec[k - 1] && v > spec[k + 1] && best.map_or(true, |b| v > spec[b]) {
                best = Some(k);
            }
        }
        let k = best?;
        let (a, b, c) = (spec[k - 1].max(1e-12).ln(), spec[k].max(1e-12).ln(), spec[k + 1].max(1e-12).ln());
        let denom = a - 2.0 * b + c;
        let (delta, peak) = if denom.abs() < 1e-9 {
            (0.0, b)
        } else {
            let d = (0.5 * (a - c) / denom).clamp(-0.5, 0.5);
            (d, b - 0.25 * (a - c) * d)
        };
        Some(Partial { freq: (k as f32 + delta) * self.bin_hz, amp: peak.exp() })
    }

    /// How much partial `h` of `f0` counts.
    fn weight(&self, f0: f32, h: usize) -> f32 {
        (f0 + self.params.alpha_hz) / (h as f32 * f0 + self.params.beta_hz)
    }

    /// FFT bins per bin of the unpadded window.
    fn bin_per_window_bin(&self) -> f32 {
        (self.input.len() as f32 / self.last_len.max(1) as f32).max(1.0)
    }

    /// Weighted sum of the amplitudes found at the partials of `f0` in the residual. Each partial is
    /// looked for near where the previous ones say it should be, so a stiff string's stretched series
    /// is followed. With `keep`, the partials are left in `self.partials`.
    fn salience(&mut self, f0: f32, keep: bool) -> f32 {
        let h_max = ((TOP_HZ.min(self.sample_rate * 0.45)) / f0).floor().min(MAX_PARTIALS as f32) as usize;
        let tol = (PARTIAL_TOL_CENTS / 1200.0).exp2();
        let drift = (MAX_DRIFT_CENTS / 1200.0).exp2();
        let mut f_ref = f0;
        let mut total = 0.0;
        // Half a main lobe: closer than this, two sinusoids are one peak.
        let lobe = 2.0 * self.sample_rate / self.last_len.max(1) as f32;
        for h in 1..=h_max {
            let expect = h as f32 * f_ref;
            let half = (expect * (tol - 1.0)).max(0.25 * lobe).max(self.bin_hz);
            let found = self.peak(expect - half, expect + half);
            let p = match found {
                Some(p) => {
                    let off = ((p.freq - expect) / half).abs().min(1.0);
                    total += self.weight(f0, h) * p.amp.powf(self.params.compress) * (1.0 - off * off);
                    // Follow the series where it really is, within the drift allowed.
                    let implied = (p.freq / h as f32).clamp(f0 / drift, f0 * drift);
                    f_ref += 0.5 * (implied - f_ref);
                    p
                }
                None => Partial::default(),
            };
            if keep {
                self.partials[h - 1] = p;
            }
        }
        if keep {
            for p in self.partials[h_max..].iter_mut() {
                *p = Partial::default();
            }
        }
        total
    }

    /// Smooths the kept partials (each is at most the average of itself and its neighbours), keeps the
    /// result for `subtract`, and returns the note's strength in dBFS, its pitch, and whether it looks
    /// like a note at all (more than one real partial, unless it is so high that it has only one).
    fn smooth_and_measure(&mut self, f0: f32) -> (f32, f32, bool) {
        let n = MAX_PARTIALS;
        let amps: [f32; MAX_PARTIALS] = std::array::from_fn(|i| self.partials[i].amp);
        let strongest = amps.iter().copied().fold(0.0f32, f32::max);
        let mut power = 0.0f32;
        let (mut fw, mut w) = (0.0f32, 0.0f32);
        let mut real = 0;
        for h in 0..n {
            let a = amps[h];
            if a <= 0.0 {
                self.best_partials[h] = Partial::default();
                continue;
            }
            // What the note's own envelope says this partial should be: the mean of its neighbours, not
            // counting itself. A partial far over that has another note on it.
            let (below, above) = (if h > 0 { Some(amps[h - 1]) } else { None }, if h + 1 < n { Some(amps[h + 1]) } else { None });
            let predicted = match (below, above) {
                (Some(b), Some(a)) => 0.5 * (a + b),
                (Some(b), None) => b,
                (None, Some(_)) => a, // The fundamental keeps what it measures: nothing sits under it.
                (None, None) => a,
            };
            let clipped = a.min(predicted.max(if h == 0 { a } else { 0.0 }) * SMOOTH_HEADROOM);
            let smoothed = a + self.params.smoothing * (clipped - a);
            self.best_partials[h] = Partial { freq: self.partials[h].freq, amp: smoothed };
            power += smoothed * smoothed * 0.5;
            if a >= strongest * 0.1 {
                real += 1;
                // Low partials pin the pitch best: weight by amplitude over partial number.
                let weight = a / (h + 1) as f32;
                fw += weight * self.partials[h].freq / (h + 1) as f32;
                w += weight;
            }
        }
        let freq = if w > 0.0 { fw / w } else { f0 };
        // A low partial well off the pitch the note agrees on is two partials merged into one peak.
        for h in 0..4 {
            let bp = &mut self.best_partials[h];
            if bp.amp > 0.0 && (1200.0 * (bp.freq / ((h + 1) as f32 * freq)).log2()).abs() > MERGED_CENTS {
                bp.amp *= 0.5;
            }
        }
        let few_partials = 2.0 * f0 > TOP_HZ.min(self.sample_rate * 0.45);
        // A string always puts something at its own fundamental. Without it, the "note" is some other
        // note's upper partials.
        let has_fundamental = amps[0] >= MIN_FUNDAMENTAL * strongest;
        (10.0 * power.max(1e-20).log10(), freq, has_fundamental && (real >= 2 || (few_partials && real >= 1)))
    }

    /// Takes the smoothed partials of the note just accepted out of the residual: each is a Hann main
    /// lobe at its measured frequency and amplitude.
    fn subtract(&mut self) {
        let len = self.last_len as f32;
        // Offset in bins of the unpadded window, per Hz.
        let per_hz = len / self.sample_rate;
        for p in self.best_partials {
            if p.amp <= 0.0 {
                continue;
            }
            let lo = (((p.freq - 2.0 / per_hz) / self.bin_hz).floor().max(1.0)) as usize;
            let hi = (((p.freq + 2.0 / per_hz) / self.bin_hz).ceil() as usize).min(self.residual.len() - 1);
            for k in lo..=hi {
                let x = (k as f32 * self.bin_hz - p.freq) * per_hz;
                let r = &mut self.residual[k];
                *r = (*r - p.amp * hann_lobe(x)).max(0.0);
            }
        }
    }
}

/// Normalised magnitude of a Hann window's transform `x` bins (of the window's own length) from its
/// centre: 1 at the centre, 1/2 at one bin, 0 at two.
fn hann_lobe(x: f32) -> f32 {
    let x = x.abs();
    if x < 1e-4 {
        return 1.0;
    }
    if (x - 1.0).abs() < 1e-4 {
        return 0.5;
    }
    if x >= 2.0 {
        return 0.0;
    }
    let px = std::f32::consts::PI * x;
    (px.sin() / px / (1.0 - x * x)).abs()
}

/// True when some partial of a note at `f0` lands within the partial tolerance of `freq`.
pub(crate) fn shares_partial(f0: f32, freq: f32) -> bool {
    let h = (freq / f0).round();
    h >= 1.0 && (1200.0 * (freq / (h * f0)).log2()).abs() < PARTIAL_TOL_CENTS
}

/// True when every partial of `upper` is a partial of `lower`: an octave, a twelfth, two octaves, and
/// so on up the series.
pub fn harmonic_above(lower: u8, upper: u8) -> bool {
    matches!(upper as i32 - lower as i32, 12 | 19 | 24 | 28 | 31 | 36)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guitar::config::STANDARD_TUNING;
    use crate::guitar::testsig::{mix, Pluck};

    const FS: f32 = 48_000.0;

    fn detector() -> PolyDetector {
        PolyDetector::new(&mut RealFftPlanner::new(), FS, 70.0, 1400.0, 440.0, STANDARD_TUNING, 24, 4096)
    }

    /// Notes found in `window` samples starting 60 ms after the picks.
    fn notes_in(plucks: &[Pluck], window: usize) -> Vec<u8> {
        let (x, _) = mix(FS, 1.0, plucks);
        let start = (0.16 * FS) as usize;
        let mut d = detector();
        let mut f = PolyFrame::default();
        d.analyze(&x[start..start + window], NoteSet::default(), &mut f);
        let mut v: Vec<u8> = f.iter().map(|n| n.note).collect();
        v.sort();
        v
    }

    fn chord(notes: &[u8]) -> Vec<Pluck> {
        notes.iter().enumerate().map(|(i, &n)| Pluck::note(n).starting(0.1).loud(-20.0).seeded(i as u32 + 3)).collect()
    }

    #[test]
    fn hann_lobe_has_its_known_shape() {
        assert_eq!(hann_lobe(0.0), 1.0);
        assert!((hann_lobe(1.0) - 0.5).abs() < 1e-6);
        assert!((hann_lobe(0.999) - 0.5).abs() < 1e-3);
        assert_eq!(hann_lobe(2.5), 0.0);
        assert!(hann_lobe(0.5) > 0.8 && hann_lobe(1.5) < 0.2);
    }

    #[test]
    fn a_single_note_is_one_note() {
        for n in [40u8, 45, 52, 59, 64, 76, 88] {
            assert_eq!(notes_in(&chord(&[n]), 4096), vec![n], "note {n}");
        }
    }

    #[test]
    fn a_single_note_reads_its_strength_and_pitch() {
        let (x, _) = mix(FS, 1.0, &[Pluck::at(220.0).loud(-20.0)]);
        let mut d = detector();
        let mut f = PolyFrame::default();
        d.analyze(&x[8000..8000 + 4096], NoteSet::default(), &mut f);
        let n = f.notes[0];
        assert_eq!(n.note, 57);
        assert!((1200.0 * (n.freq_hz / 220.0).log2()).abs() < 5.0, "{} Hz", n.freq_hz);
        // The note peaks at -20 dBFS; its RMS a little under that, and it has decayed a little.
        assert!(n.strength_db < -20.0 && n.strength_db > -32.0, "{} dB", n.strength_db);
    }

    /// Every note found was played, and every pitch class played was found. An octave doubling that
    /// hides entirely in a lower string's partials may be missed; that is all this allows.
    fn assert_chord(notes: &[u8]) {
        let got = notes_in(&chord(notes), 4096);
        assert!(got.iter().all(|n| notes.contains(n)), "invented notes: played {notes:?}, found {got:?}");
        let pc = |v: &[u8]| v.iter().fold(0u16, |m, n| m | 1 << (n % 12));
        assert_eq!(pc(&got), pc(notes), "pitch classes: played {notes:?}, found {got:?}");
        // The bass note, which names the chord's inversion, is always found.
        assert!(got.contains(&notes[0]), "no bass: played {notes:?}, found {got:?}");
    }

    #[test]
    fn an_open_e_major_chord() {
        assert_chord(&[40, 47, 52, 56, 59, 64]);
    }

    #[test]
    fn an_open_a_minor_chord() {
        assert_chord(&[45, 52, 57, 60, 64]);
    }

    #[test]
    fn an_open_c_major_chord() {
        assert_chord(&[48, 52, 55, 60, 64]);
    }

    #[test]
    fn a_power_chord_and_its_octave() {
        let notes = [40, 47, 52];
        assert_eq!(notes_in(&chord(&notes), 4096), notes.to_vec());
    }

    #[test]
    fn a_third_on_the_top_strings() {
        let notes = [55, 59];
        assert_eq!(notes_in(&chord(&notes), 4096), notes.to_vec());
    }

    #[test]
    fn silence_is_no_notes() {
        let mut d = detector();
        let mut f = PolyFrame::default();
        d.analyze(&vec![0.0; 4096], NoteSet::default(), &mut f);
        assert_eq!(f.count, 0);
    }

    #[test]
    fn noise_is_no_notes() {
        let mut x = vec![0.0f32; 4096];
        crate::guitar::testsig::add_noise(&mut x, -30.0, 5);
        let mut d = detector();
        let mut f = PolyFrame::default();
        d.analyze(&x, NoteSet::default(), &mut f);
        assert_eq!(f.count, 0, "{:?}", f.iter().collect::<Vec<_>>());
    }

    #[test]
    fn harmonic_relations() {
        assert!(harmonic_above(40, 52));
        assert!(harmonic_above(40, 59));
        assert!(!harmonic_above(40, 47));
        assert!(!harmonic_above(52, 40));
    }
}
