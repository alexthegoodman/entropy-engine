//! Deno ops exposing the MoE DAW next-action prediction model from Yumon Pet.
//!
//! Provides inference over recent semantic DAW action sequences and returns
//! predicted continuation actions with metadata and confidence scores.

use deno_core::op2;
use serde::{Deserialize, Serialize};
pub use yumon_pet::{DawAction, PredictedAction};


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionVocabEntry {
    pub id: u32,
    pub name: String,
    pub display_name: String,
    pub category: String,
    pub icon: String,
    pub param_count: usize,
    pub default_params: Vec<f32>,
}

/// Predict next DAW actions from a context window of recent action IDs.
pub fn predict_next_actions(
    context_ids: &[u32],
    steps: usize,
) -> Result<Vec<yumon_pet::PredictedAction>, deno_error::JsErrorBox> {
    yumon_pet::predict_next_actions(None, context_ids, None, steps)
        .map_err(|e| deno_error::JsErrorBox::generic(format!("Prediction failed: {e}")))
}

/// Returns the full semantic action vocabulary with display names, categories,
/// Phosphor icons, and default parameters.
pub fn prediction_action_vocab() -> Vec<ActionVocabEntry> {
    yumon_pet::DawAction::ALL
        .iter()
        .map(|&a| ActionVocabEntry {
            id: a.id(),
            name: a.name().to_string(),
            display_name: a.display_name().to_string(),
            category: a.category().to_string(),
            icon: a.icon().to_string(),
            param_count: a.param_count(),
            default_params: a.default_params().to_vec(),
        })
        .collect()
}

/// Predict next DAW actions from a context window of recent action IDs.
///
/// `context_ids`: slice of recent semantic action IDs
/// `steps`: how many future steps to predict (e.g. 5)
#[op2]
#[serde]
pub fn op_prediction_next_actions(
    #[serde] context_ids: Vec<u32>,
    #[smi] steps: u32,
) -> Result<Vec<yumon_pet::PredictedAction>, deno_error::JsErrorBox> {
    let count = if steps == 0 { 5 } else { steps as usize };
    predict_next_actions(&context_ids, count)
}

/// Returns the full semantic action vocabulary with display names, categories,
/// Phosphor icons, and default parameters.
#[op2]
#[serde]
pub fn op_prediction_action_vocab() -> Vec<ActionVocabEntry> {
    prediction_action_vocab()
}

