//! The DAW's next-step brain: a WIR program written by hand and compiled to a ReLU network.
//!
//! The program is yumon-pet's `wir daw` (source in `wir/examples/daw_brain.wir`, also embedded
//! in `daw_brain.json`). It reads which substantive action came last, the active track's
//! instrument family, the track count, how full the pattern and the song are, how far mixing
//! has got, and the last note, clip and mixer track touched, and gives one key per action plus
//! the parameters it reasons about (the next note, the next clip, the mixer track, solo on/off,
//! a pattern length). Nothing is trained: `wir daw` checks the compiled network against the
//! rule as plain code on 200k random inputs, and the test vectors in the JSON check this
//! runtime against the same rule.
//!
//! This file is the host: it reads a recorded history into the network's inputs (the same
//! reading as `wir::daw::features`), runs the network (a few thousand multiply-adds), ranks the
//! keys, takes softmax(score / temperature) for confidences, fills the parameters the network
//! does not predict with the ones last used for that action (or the spec defaults), and chains
//! steps into a plan. The network is embedded, so there is no checkpoint to find or load.

use super::daw_actions::*;
use serde::{Deserialize, Serialize};

const BRAIN_JSON: &str = include_str!("daw_brain.json");

/// The network's inputs after the one-hot last action, in program order (`wir::daw::STATE`).
const STATE: [&str; 19] =
    ["start", "fam", "tracks", "pf", "sf", "mixed", "on", "gate", "soloing", "nr", "ns", "nd", "dr", "steps", "cl", "cb", "cn", "cend", "mt"];

/// The parameter outputs after the keys, in program order (`wir::daw::PARAMS`).
const PARAMS: [&str; 10] =
    ["note_row", "note_step", "erase_row", "erase_step", "clip_lane", "clip_bar", "clip_bars", "mix_track", "solo_on", "pattern_bars"];

/// The gate knob's index in CHARACTER_KNOBS.
const GATE_KNOB: i64 = 2;

// ── The compiled network ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct BrainFile {
    format: String,
    consts: BrainConsts,
    brain: BrainNet,
    #[serde(default)]
    vectors: Vec<(Vec<f64>, Vec<f64>)>,
}

#[derive(Deserialize)]
struct BrainConsts {
    actions: Vec<String>,
    params: Vec<String>,
    key_scale: f64,
    temperature: f64,
}

#[derive(Deserialize)]
struct BrainNet {
    inputs: Vec<String>,
    outputs: Vec<String>,
    hidden: Vec<usize>,
    layers: Vec<SparseLayer>,
    source: String,
}

/// One layer as the WIR export writes it: per output row, flat (input index, weight) pairs.
#[derive(Deserialize)]
struct SparseLayer {
    rows: Vec<Vec<f64>>,
    b: Vec<f64>,
}

/// The loaded brain: a sparse ReLU MLP (ReLU after every layer but the last).
pub struct Brain {
    layers: Vec<(Vec<Vec<(usize, f64)>>, Vec<f64>)>,
    key_scale: f64,
    temperature: f64,
    /// Units per hidden layer and non-zero weights (biases included), for the status line.
    pub hidden: Vec<usize>,
    pub weights: usize,
    /// The WIR program the weights were compiled from.
    pub source: String,
    vectors: Vec<(Vec<f64>, Vec<f64>)>,
}

impl Brain {
    /// Parses and checks the embedded brain against this build's vocabulary.
    pub fn load() -> Result<Self, String> {
        Self::parse(BRAIN_JSON)
    }

    fn parse(text: &str) -> Result<Self, String> {
        let file: BrainFile = serde_json::from_str(text).map_err(|e| format!("the DAW brain could not be read: {e}"))?;
        if file.format != "wir-daw-brain" {
            return Err(format!("the DAW brain has format {:?}, not \"wir-daw-brain\"", file.format));
        }
        let names: Vec<&str> = DawAction::ALL.iter().map(|a| a.name()).collect();
        if file.consts.actions != names {
            return Err(format!(
                "the DAW brain was compiled for another action vocabulary ({} actions; this build has {} in vocabulary v{DAW_VOCAB_VERSION}): rerun `wir daw --export`",
                file.consts.actions.len(),
                names.len()
            ));
        }
        let want_inputs: Vec<String> = names.iter().map(|a| format!("after_{a}")).chain(STATE.iter().map(|s| s.to_string())).collect();
        let want_outputs: Vec<String> = names.iter().map(|a| format!("key_{a}")).chain(PARAMS.iter().map(|s| s.to_string())).collect();
        if file.brain.inputs != want_inputs || file.brain.outputs != want_outputs || file.consts.params != PARAMS {
            return Err("the DAW brain's inputs or outputs are not the ones this build reads: rerun `wir daw --export`".into());
        }
        let mut width = want_inputs.len();
        let mut layers = Vec::with_capacity(file.brain.layers.len());
        for (k, l) in file.brain.layers.iter().enumerate() {
            if l.rows.len() != l.b.len() {
                return Err(format!("the DAW brain's layer {k} has {} rows and {} biases", l.rows.len(), l.b.len()));
            }
            let mut rows = Vec::with_capacity(l.rows.len());
            for r in &l.rows {
                let pairs: Vec<(usize, f64)> = r.chunks(2).map(|p| (p[0] as usize, p.get(1).copied().unwrap_or(f64::NAN))).collect();
                if r.len() % 2 != 0 || pairs.iter().any(|&(j, w)| j >= width || !w.is_finite()) {
                    return Err(format!("the DAW brain's layer {k} has a bad weight entry"));
                }
                rows.push(pairs);
            }
            width = rows.len();
            layers.push((rows, l.b.clone()));
        }
        if width != want_outputs.len() {
            return Err(format!("the DAW brain ends with {width} outputs, not {}", want_outputs.len()));
        }
        let weights = layers.iter().map(|(rows, b)| rows.iter().map(|r| r.len()).sum::<usize>() + b.len()).sum();
        Ok(Self {
            layers,
            key_scale: file.consts.key_scale,
            temperature: file.consts.temperature,
            hidden: file.brain.hidden,
            weights,
            source: file.brain.source,
            vectors: file.vectors,
        })
    }

    /// The network's outputs (keys, then parameters) for `x`.
    pub fn eval(&self, x: &[f64]) -> Vec<f64> {
        let mut a = x.to_vec();
        let last = self.layers.len() - 1;
        for (k, (rows, bias)) in self.layers.iter().enumerate() {
            a = rows
                .iter()
                .zip(bias)
                .map(|(row, b)| {
                    let z = row.iter().fold(*b, |s, &(j, w)| s + w * a[j]);
                    if k == last { z } else { z.max(0.0) }
                })
                .collect();
        }
        a
    }

    /// The largest difference between this runtime and the rule's outputs on the exported test
    /// vectors (0 when they agree), and how many vectors there are.
    pub fn check_vectors(&self) -> (f64, usize) {
        let worst = self
            .vectors
            .iter()
            .map(|(x, want)| self.eval(x).iter().zip(want).map(|(g, w)| (g - w).abs()).fold(0.0, f64::max))
            .fold(0.0, f64::max);
        (worst, self.vectors.len())
    }
}

/// The embedded brain, parsed once.
pub fn brain() -> Result<&'static Brain, String> {
    static BRAIN: std::sync::OnceLock<Result<Brain, String>> = std::sync::OnceLock::new();
    BRAIN.get_or_init(Brain::load).as_ref().map_err(|e| e.clone())
}

// ── Reading a history ─────────────────────────────────────────────────────────

/// What the brain reads (`wir::daw::DawIn`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BrainInput {
    pub last: Option<DawAction>,
    pub fam: i64,
    pub tracks: i64,
    pub pf: i64,
    pub sf: i64,
    pub mixed: i64,
    pub on: i64,
    pub gate: i64,
    pub soloing: i64,
    pub nr: i64,
    pub ns: i64,
    pub nd: i64,
    pub dr: i64,
    pub steps: i64,
    pub cl: i64,
    pub cb: i64,
    pub cn: i64,
    pub cend: i64,
    pub mt: i64,
}

impl BrainInput {
    /// Reads `history` (oldest first) with the song as it is now, `now`.
    pub fn read(history: &[ActionStep], now: StepContext) -> Self {
        let quarter = |f: f32| ((f.clamp(0.0, 1.0) * 4.0).floor() as i64).min(4);
        let mut x = BrainInput { nd: 4, cn: 4, ..Default::default() };
        let mut notes: Vec<(i64, i64)> = Vec::new();
        let mut song_bars = 16;
        for s in history {
            let Some(a) = s.action() else { continue };
            let p = |i: usize| s.params[i] as i64;
            match a {
                DawAction::SetVolume | DawAction::SoloTrack | DawAction::MuteTrack => {
                    x.mixed = (x.mixed + 1).min(4);
                    x.mt = p(0).clamp(0, 15);
                    if a == DawAction::SoloTrack {
                        x.soloing = (s.params[1] >= 0.5) as i64;
                    }
                }
                DawAction::SetEqPreset | DawAction::SetReverbPreset => x.mixed = (x.mixed + 1).min(4),
                DawAction::AddNote => notes.push((p(0).clamp(0, 47), p(1).clamp(0, 63))),
                DawAction::CreateClip => {
                    x.cl = p(0).clamp(0, 15);
                    x.cb = p(1).clamp(0, 127);
                    x.cn = p(2).clamp(1, 32);
                }
                DawAction::DuplicateClip => x.cb = (x.cb + x.cn).min(127),
                DawAction::SetSongBars => song_bars = p(0).max(1),
                _ => {}
            }
        }
        x.cend = (x.cb + x.cn >= song_bars) as i64;
        if let Some(&(r, s)) = notes.last() {
            x.nr = r;
            x.ns = s;
            if notes.len() >= 2 {
                let (pr, ps) = notes[notes.len() - 2];
                x.nd = (s - ps).clamp(0, 16);
                x.dr = if s == ps { (r - pr).clamp(-4, 4) } else { 0 };
            }
        }
        if let Some(s) = history.iter().rev().find(|s| s.action().is_some()) {
            let a = s.action().unwrap();
            x.last = Some(a);
            x.on = if a == DawAction::SoloTrack || a == DawAction::MuteTrack { (s.params[1] >= 0.5) as i64 } else { 0 };
            x.gate = (a == DawAction::SetCharacter && s.params[0] as i64 == GATE_KNOB) as i64;
        }
        x.fam = (now.family as i64).clamp(0, 9);
        x.tracks = (now.tracks as i64).clamp(0, 16);
        x.pf = quarter(now.pattern_fill);
        x.sf = quarter(now.song_fill);
        x.steps = (now.pattern_steps as i64).clamp(8, 64);
        x
    }

    /// The network's input vector.
    pub fn inputs(&self) -> Vec<f64> {
        let mut v: Vec<f64> = DawAction::ALL.iter().map(|&a| (Some(a) == self.last) as i64 as f64).collect();
        v.extend(
            [
                self.last.is_none() as i64, self.fam, self.tracks, self.pf, self.sf, self.mixed, self.on, self.gate, self.soloing,
                self.nr, self.ns, self.nd, self.dr, self.steps, self.cl, self.cb, self.cn, self.cend, self.mt,
            ]
            .map(|v| v as f64),
        );
        v
    }
}

// ── Plans ─────────────────────────────────────────────────────────────────────

/// Another action the brain considered for a step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AltAction {
    pub action_id: u32,
    pub name: String,
    pub display_name: String,
    pub icon: String,
    pub confidence: f32,
}

/// A predicted action with metadata, parameters (natural units, one per `ParamSpec` of the
/// action) and confidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictedAction {
    pub action_id: u32,
    pub name: String,
    pub display_name: String,
    pub category: String,
    pub icon: String,
    pub params: Vec<f32>,
    pub confidence: f32,
    /// The next most likely actions at this step.
    #[serde(default)]
    pub alternatives: Vec<AltAction>,
}

/// One step of the brain: every action ranked (most likely first) with its probability, and
/// the raw outputs for the parameters.
pub struct Ranking {
    pub ranked: Vec<(DawAction, f32)>,
    outputs: Vec<f64>,
}

impl Brain {
    /// Ranks every action after `history` with the song as it is now.
    pub fn rank(&self, history: &[ActionStep], now: StepContext) -> Ranking {
        let outputs = self.eval(&BrainInput::read(history, now).inputs());
        let n = NUM_DAW_ACTIONS;
        let scores: Vec<f64> = outputs[..n].iter().map(|k| (k / self.key_scale).floor() / self.temperature).collect();
        let max = scores.iter().cloned().fold(f64::MIN, f64::max);
        let sum: f64 = scores.iter().map(|s| (s - max).exp()).sum();
        let mut order: Vec<usize> = (0..n).collect();
        // Keys carry a tie-break below the key scale, so they never tie.
        order.sort_by(|&a, &b| outputs[b].partial_cmp(&outputs[a]).unwrap_or(std::cmp::Ordering::Equal));
        let ranked = order.into_iter().map(|i| (DawAction::ALL[i], ((scores[i] - max).exp() / sum) as f32)).collect();
        Ranking { ranked, outputs }
    }

    /// Parameters for `action`: the brain's where it predicts them, otherwise the ones last used
    /// for that action in `history`, otherwise the spec defaults.
    pub fn params(&self, ranking: &Ranking, action: DawAction, history: &[ActionStep]) -> Vec<f32> {
        let n = NUM_DAW_ACTIONS;
        let o = |name: &str| ranking.outputs[n + PARAMS.iter().position(|p| *p == name).unwrap()] as f32;
        let used = history.iter().rev().find(|s| s.action_id == action.id()).map(|s| s.params);
        let base: Vec<f32> = action.params().iter().enumerate().map(|(i, s)| used.map_or(s.default, |p| p[i])).collect();
        let b = |i: usize| base[i];
        let raw = match action {
            DawAction::AddNote => vec![o("note_row"), o("note_step"), b(2), b(3)],
            DawAction::RemoveNote => vec![o("erase_row"), o("erase_step")],
            DawAction::CreateClip => vec![o("clip_lane"), o("clip_bar"), o("clip_bars")],
            DawAction::SetVolume | DawAction::MuteTrack => vec![o("mix_track"), b(1)],
            DawAction::SoloTrack => vec![o("mix_track"), o("solo_on")],
            DawAction::SetPatternLength | DawAction::NewPattern => vec![o("pattern_bars")],
            _ => base,
        };
        action.sanitize_params(&raw)
    }

    /// The next `steps` actions after `history` (oldest first). `current` is the song as it is
    /// now (the last step's context when absent). `alternative` > 0 starts the plan from the
    /// alternative-th most likely first action, so "Refresh Plan" gives a different
    /// continuation; later steps follow the brain.
    pub fn plan(&self, history: &[ActionStep], current: Option<StepContext>, steps: usize, alternative: usize) -> Vec<PredictedAction> {
        let mut seq: Vec<ActionStep> = history.iter().filter(|s| s.action().is_some()).cloned().collect();
        let mut now = current.or_else(|| seq.last().map(|s| s.context)).unwrap_or_default();
        let round = |p: f32| (p * 100.0).round() / 100.0;
        let mut plan = Vec::with_capacity(steps);
        for k in 0..steps {
            let ranking = self.rank(&seq, now);
            let pick = if k == 0 { alternative.min(ranking.ranked.len() - 1) } else { 0 };
            let (action, prob) = ranking.ranked[pick];
            let params = self.params(&ranking, action, &seq);
            let alternatives = ranking
                .ranked
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != pick)
                .take(3)
                .map(|(_, &(a, p))| AltAction {
                    action_id: a.id(),
                    name: a.name().to_string(),
                    display_name: a.display_name().to_string(),
                    icon: a.icon().to_string(),
                    confidence: round(p),
                })
                .collect();
            plan.push(PredictedAction {
                action_id: action.id(),
                name: action.name().to_string(),
                display_name: action.display_name().to_string(),
                category: action.category().to_string(),
                icon: action.icon().to_string(),
                params: params.clone(),
                confidence: round(prob),
                alternatives,
            });
            now = now.advance(action, &params);
            seq.push(ActionStep::with_context(action, &params, now));
        }
        plan
    }
}

// ── The API the DAW calls ─────────────────────────────────────────────────────

/// What the app can know about the brain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionStatus {
    pub available: bool,
    /// A one-line description of the brain, or why it is not available.
    pub message: String,
    pub vocab_version: u32,
    /// Non-zero weights in the network (0 when unavailable).
    pub weights: usize,
}

/// Whether the embedded brain loaded, with a one-line description.
pub fn prediction_status() -> PredictionStatus {
    match brain() {
        Ok(b) => PredictionStatus {
            available: true,
            message: format!("Written WIR brain: {} weights, {} hidden layers", b.weights, b.hidden.len()),
            vocab_version: DAW_VOCAB_VERSION,
            weights: b.weights,
        },
        Err(e) => PredictionStatus { available: false, message: e, vocab_version: DAW_VOCAB_VERSION, weights: 0 },
    }
}

/// Predicts a plan. An error only when the embedded brain could not be loaded.
pub fn predict_plan(history: &[ActionStep], current: Option<StepContext>, steps: usize, alternative: usize) -> Result<Vec<PredictedAction>, String> {
    Ok(brain()?.plan(history, current, steps, alternative))
}

/// Where a requested plan is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanState {
    Done,
    Error,
    /// No such ticket (never issued, or long since forgotten).
    Unknown,
}

/// The answer to `poll_plan`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanPoll {
    pub state: PlanState,
    pub plan: Vec<PredictedAction>,
    pub error: Option<String>,
    /// Time the plan took to compute.
    pub elapsed_ms: f32,
}

/// Results by ticket, the most recent `KEPT_RESULTS`, so polling a ticket again is safe.
static RESULTS: std::sync::Mutex<std::collections::BTreeMap<u64, PlanPoll>> = std::sync::Mutex::new(std::collections::BTreeMap::new());
static NEXT_TICKET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
const KEPT_RESULTS: usize = 32;

/// Computes a plan and files it under a new ticket for `poll_plan`. The brain answers in
/// microseconds, so the plan is ready when this returns; the ticket keeps the DAW's
/// request-then-poll flow.
pub fn request_plan(history: Vec<ActionStep>, current: Option<StepContext>, steps: usize, alternative: usize) -> u64 {
    let ticket = NEXT_TICKET.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    let started = std::time::Instant::now();
    let result = predict_plan(&history, current, steps, alternative);
    let elapsed_ms = started.elapsed().as_secs_f32() * 1000.0;
    let poll = match result {
        Ok(plan) => PlanPoll { state: PlanState::Done, plan, error: None, elapsed_ms },
        Err(error) => PlanPoll { state: PlanState::Error, plan: Vec::new(), error: Some(error), elapsed_ms },
    };
    let mut results = RESULTS.lock().unwrap_or_else(|p| p.into_inner());
    results.insert(ticket, poll);
    while results.len() > KEPT_RESULTS {
        results.pop_first();
    }
    ticket
}

/// The plan filed under `ticket`.
pub fn poll_plan(ticket: u64) -> PlanPoll {
    RESULTS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&ticket)
        .cloned()
        .unwrap_or(PlanPoll { state: PlanState::Unknown, plan: Vec::new(), error: None, elapsed_ms: 0.0 })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn step(a: DawAction, params: &[f32]) -> ActionStep {
        ActionStep::with_context(a, params, StepContext { family: family::DRUM_RACK, tracks: 3, pattern_fill: 0.3, ..Default::default() })
    }

    #[test]
    fn runtime_matches_the_written_rule() {
        let b = brain().unwrap();
        let (worst, n) = b.check_vectors();
        assert!(n >= 32, "only {n} test vectors");
        assert_eq!(worst, 0.0);
        assert!(b.source.starts_with("wir 0.2"));
    }

    #[test]
    fn a_brain_for_another_vocabulary_is_refused() {
        let mut v: serde_json::Value = serde_json::from_str(BRAIN_JSON).unwrap();
        v["consts"]["actions"].as_array_mut().unwrap().push("open_view".into());
        let err = Brain::parse(&v.to_string()).err().unwrap();
        assert!(err.contains("another action vocabulary"), "{err}");
    }

    #[test]
    fn reads_the_history_like_the_wir_host() {
        // The same history as wir/tests/daw.rs `features_read_the_history`.
        let h = vec![
            step(DawAction::AddNote, &[0.0, 0.0, 1.0, 0.85]),
            step(DawAction::AddNote, &[0.0, 4.0, 1.0, 0.85]),
            step(DawAction::CreateClip, &[1.0, 0.0, 8.0]),
            step(DawAction::DuplicateClip, &[]),
            step(DawAction::SoloTrack, &[2.0, 1.0]),
        ];
        let x = BrainInput::read(&h, h.last().unwrap().context);
        assert_eq!(x.last, Some(DawAction::SoloTrack));
        assert_eq!((x.nr, x.ns, x.nd), (0, 4, 4));
        assert_eq!((x.cl, x.cb, x.cn, x.cend), (1, 8, 8, 1));
        assert_eq!((x.mt, x.soloing, x.on, x.mixed, x.pf), (2, 1, 1, 1, 1));
        assert_eq!(BrainInput::read(&[], StepContext::default()).last, None);
    }

    #[test]
    fn plans_follow_the_written_workflow() {
        let b = brain().unwrap();
        // A blank song: the tempo first.
        let plan = b.plan(&[], Some(StepContext::default()), 3, 0);
        assert_eq!(plan[0].name, "set_bpm");
        // A new pitched track: instrument, then (wavetable) its preset.
        let h = vec![step(DawAction::AddTrack, &[2.0])];
        let now = StepContext { family: family::SYNTH, ..h[0].context };
        assert_eq!(b.plan(&h, Some(now), 1, 0)[0].name, "set_instrument");
        let h = vec![step(DawAction::SetInstrument, &[family::WAVETABLE as f32])];
        let now = StepContext { family: family::WAVETABLE, ..h[0].context };
        assert_eq!(b.plan(&h, Some(now), 1, 0)[0].name, "load_wavetable_preset");
        // Notes continue the spacing; the plan chains them.
        let h = vec![step(DawAction::AddNote, &[2.0, 0.0, 1.0, 0.85]), step(DawAction::AddNote, &[2.0, 4.0, 1.0, 0.7])];
        let plan = b.plan(&h, None, 3, 0);
        let steps: Vec<f32> = plan.iter().map(|p| p.params[1]).collect();
        assert!(plan.iter().all(|p| p.name == "add_note"));
        assert_eq!(steps, vec![8.0, 12.0, 0.0]);
        // Length and velocity are the ones last used.
        assert_eq!(plan[0].params[2..], [1.0, 0.7]);
    }

    #[test]
    fn plans_are_valid_and_alternatives_differ() {
        let b = brain().unwrap();
        let h = vec![step(DawAction::SetBpm, &[124.0]), step(DawAction::AddNote, &[0.0, 0.0, 1.0, 0.85])];
        let plan = b.plan(&h, None, 5, 0);
        assert_eq!(plan.len(), 5);
        for p in &plan {
            let a = DawAction::from_name(&p.name).unwrap();
            assert_eq!(p.params.len(), a.param_count());
            for (v, spec) in p.params.iter().zip(a.params()) {
                assert!(*v >= spec.min && *v <= spec.max, "{}.{} = {v}", p.name, spec.name);
            }
            assert!((0.0..=1.0).contains(&p.confidence));
            assert_eq!(p.alternatives.len(), 3);
        }
        let alt = b.plan(&h, None, 2, 1);
        assert_ne!(alt[0].action_id, plan[0].action_id);
        assert_eq!(alt[0].action_id, plan[0].alternatives[0].action_id);
    }

    #[test]
    fn a_requested_plan_is_ready_when_polled() {
        let ticket = request_plan(vec![step(DawAction::AddNote, &[0.0, 0.0, 1.0, 0.85])], None, 3, 0);
        let poll = poll_plan(ticket);
        assert_eq!(poll.state, PlanState::Done, "{:?}", poll.error);
        assert_eq!(poll.plan.len(), 3);
        assert_eq!(poll_plan(u64::MAX).state, PlanState::Unknown);
    }
}
