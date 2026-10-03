//! Deno ops exposing the MoE DAW next-action prediction model (src/prediction).
//!
//! The DAW records each semantic action with its parameters and the app
//! context after it (instrument family, view, transport, fill levels); these
//! ops turn that history into a predicted plan whose steps carry predicted
//! parameters, and export the vocabulary - every action's parameter specs and
//! the option lists its dropdowns index - so the Suggested Next Steps panel
//! can build real controls for each step.

use deno_core::op2;
use serde::{Deserialize, Serialize};
use crate::prediction::daw_actions::{ParamKind, CHOICE_LISTS, DAW_VOCAB_VERSION, MAX_ACTION_PARAMS};
pub use crate::prediction::{ActionStep, DawAction, PlanPoll, PlanState, PredictedAction, PredictionStatus, StepContext};

/// One parameter of an action, as the UI builds a control for it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamSpecEntry {
    pub name: String,
    pub label: String,
    /// "knob" | "int" | "choice" | "toggle" | "note" | "track"
    pub kind: String,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub unit: String,
    pub log: bool,
    /// For "choice": the id of the list in `prediction_choice_lists`.
    pub choices: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionVocabEntry {
    pub id: u32,
    pub name: String,
    pub display_name: String,
    pub category: String,
    pub icon: String,
    pub param_count: usize,
    pub default_params: Vec<f32>,
    pub params: Vec<ParamSpecEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChoiceOption {
    pub id: String,
    pub label: String,
}

/// The app context after an action, as the DAW reports it.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextInput {
    pub family: u32,
    pub view: u32,
    pub playing: bool,
    pub tracks: u32,
    pub pattern_fill: f32,
    pub song_fill: f32,
}

impl From<ContextInput> for StepContext {
    fn from(c: ContextInput) -> Self {
        StepContext {
            family: c.family,
            view: c.view,
            playing: c.playing,
            tracks: c.tracks,
            pattern_fill: c.pattern_fill,
            song_fill: c.song_fill,
        }
    }
}

/// One recorded action. `action` is the snake_case name (ids can move between vocabulary versions).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub action: String,
    #[serde(default)]
    pub params: Vec<f32>,
    #[serde(default)]
    pub context: ContextInput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanRequest {
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    /// The app's context now (used when the history is empty).
    #[serde(default)]
    pub current: Option<ContextInput>,
    #[serde(default)]
    pub steps: Option<u32>,
    /// 0 for the most likely plan; n opens the plan with the n-th most likely first action.
    #[serde(default)]
    pub alternative: Option<u32>,
}

fn kind_name(kind: ParamKind) -> &'static str {
    match kind {
        ParamKind::Knob => "knob",
        ParamKind::Int => "int",
        ParamKind::Choice => "choice",
        ParamKind::Toggle => "toggle",
        ParamKind::Note => "note",
        ParamKind::Track => "track",
    }
}

/// History entries the model understands: unknown names are dropped.
pub fn history_steps(history: &[HistoryEntry]) -> Vec<ActionStep> {
    history
        .iter()
        .filter_map(|h| {
            let action = DawAction::from_name(&h.action)?;
            let n = h.params.len().min(MAX_ACTION_PARAMS);
            Some(ActionStep::with_context(action, &h.params[..n], h.context.into()))
        })
        .collect()
}

fn plan_steps(request: &PlanRequest) -> usize {
    (request.steps.filter(|&s| s > 0).unwrap_or(5) as usize).min(12)
}

/// Queues a plan on the prediction worker thread and returns its ticket without waiting.
pub fn request_plan(request: &PlanRequest) -> u64 {
    crate::prediction::request_plan(
        None,
        history_steps(&request.history),
        request.current.map(Into::into),
        plan_steps(request),
        request.alternative.unwrap_or(0) as usize,
    )
}

/// Where a queued plan is: pending, done (with the plan), error, superseded or unknown.
pub fn poll_plan(ticket: u64) -> PlanPoll {
    crate::prediction::poll_plan(ticket)
}

/// Predicts a plan from a recorded history and waits for it. Empty when no model is installed.
pub fn predict_plan(request: &PlanRequest) -> Result<Vec<PredictedAction>, deno_error::JsErrorBox> {
    crate::prediction::predict_plan(
        None,
        &history_steps(&request.history),
        request.current.map(Into::into),
        plan_steps(request),
        request.alternative.unwrap_or(0) as usize,
    )
    .map_err(|e| deno_error::JsErrorBox::generic(format!("Prediction failed: {e}")))
}

/// Predict next DAW actions from a context window of recent action IDs (no context or params).
pub fn predict_next_actions(
    context_ids: &[u32],
    steps: usize,
) -> Result<Vec<PredictedAction>, deno_error::JsErrorBox> {
    crate::prediction::predict_next_actions(None, context_ids, None, steps)
        .map_err(|e| deno_error::JsErrorBox::generic(format!("Prediction failed: {e}")))
}

/// The full action vocabulary with display names, categories, Phosphor icons and parameter specs.
pub fn prediction_action_vocab() -> Vec<ActionVocabEntry> {
    DawAction::ALL
        .iter()
        .map(|&a| ActionVocabEntry {
            id: a.id(),
            name: a.name().to_string(),
            display_name: a.display_name().to_string(),
            category: a.category().to_string(),
            icon: a.icon().to_string(),
            param_count: a.param_count(),
            default_params: a.default_params()[..a.param_count()].to_vec(),
            params: a
                .params()
                .iter()
                .map(|p| ParamSpecEntry {
                    name: p.name.to_string(),
                    label: p.label.to_string(),
                    kind: kind_name(p.kind).to_string(),
                    min: p.min,
                    max: p.max,
                    default: p.default,
                    unit: p.unit.to_string(),
                    log: p.log,
                    choices: p.choices.map(|c| c.id.to_string()),
                })
                .collect(),
        })
        .collect()
}

/// Every option list a "choice" parameter indexes into, by list id.
pub fn prediction_choice_lists() -> std::collections::BTreeMap<String, Vec<ChoiceOption>> {
    CHOICE_LISTS
        .iter()
        .map(|l| {
            (
                l.id.to_string(),
                l.options.iter().map(|(id, label)| ChoiceOption { id: id.to_string(), label: label.to_string() }).collect(),
            )
        })
        .collect()
}

/// Queue a plan on the prediction worker; returns a ticket for `op_prediction_poll_plan`.
#[op2]
pub fn op_prediction_request_plan(#[serde] request: PlanRequest) -> f64 {
    request_plan(&request) as f64
}

#[op2]
#[serde]
pub fn op_prediction_poll_plan(ticket: f64) -> PlanPoll {
    poll_plan(ticket.max(0.0) as u64)
}

/// Predict a plan from a history of `{ action, params, context }` entries. Blocks until the
/// worker answers; the UI uses request/poll instead.
#[op2]
#[serde]
pub fn op_prediction_plan(#[serde] request: PlanRequest) -> Result<Vec<PredictedAction>, deno_error::JsErrorBox> {
    predict_plan(&request)
}

/// Predict next DAW actions from a context window of recent action IDs.
#[op2]
#[serde]
pub fn op_prediction_next_actions(
    #[serde] context_ids: Vec<u32>,
    #[smi] steps: u32,
) -> Result<Vec<PredictedAction>, deno_error::JsErrorBox> {
    let count = if steps == 0 { 5 } else { steps as usize };
    predict_next_actions(&context_ids, count)
}

#[op2]
#[serde]
pub fn op_prediction_action_vocab() -> Vec<ActionVocabEntry> {
    prediction_action_vocab()
}

#[op2]
#[serde]
pub fn op_prediction_choice_lists() -> std::collections::BTreeMap<String, Vec<ChoiceOption>> {
    prediction_choice_lists()
}

/// Whether a usable prediction model is installed (without loading it), and why not when it is not.
pub fn prediction_status() -> PredictionStatus {
    crate::prediction::prediction_status()
}

#[op2]
#[serde]
pub fn op_prediction_status() -> PredictionStatus {
    prediction_status()
}

/// The vocabulary version this build speaks; checkpoints from another one are refused.
#[op2(fast)]
pub fn op_prediction_vocab_version() -> u32 {
    DAW_VOCAB_VERSION
}
