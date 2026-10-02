//! BDD test suite for DAW UI Prediction Model and Suggested Next Steps.
//!
//! Verifies action vocabulary metadata, confidence scores, multi-step next action
//! predictions, and context continuity across beatmaking and mixing workflows.

use cucumber::{given, then, when, World as _};
use entropy_engine::deno::prediction_ops::{
    predict_next_actions, prediction_action_vocab, ActionVocabEntry, DawAction,
    PredictedAction,
};

#[derive(cucumber::World)]
pub struct PredictionWorld {
    vocab: Vec<ActionVocabEntry>,
    context_ids: Vec<u32>,
    predicted_actions: Vec<PredictedAction>,
}

impl std::fmt::Debug for PredictionWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "PredictionWorld(context_len={}, preds_len={})",
            self.context_ids.len(),
            self.predicted_actions.len()
        )
    }
}

impl Default for PredictionWorld {
    fn default() -> Self {
        Self {
            vocab: Vec::new(),
            context_ids: Vec::new(),
            predicted_actions: Vec::new(),
        }
    }
}

// ── Given Steps ─────────────────────────────────────────────────────────────

#[given(expr = "the DAW action vocabulary is loaded")]
fn action_vocab_loaded(world: &mut PredictionWorld) {
    world.vocab = prediction_action_vocab();
}

#[given(expr = "an action history sequence of {string}")]
fn action_history_sequence(world: &mut PredictionWorld, names_str: String) {
    world.context_ids.clear();
    for raw in names_str.split(',') {
        let name = raw.trim();
        if let Some(action) = DawAction::from_name(name) {
            let id: u32 = action.id();
            world.context_ids.push(id);
        } else {
            panic!("Unknown action name in test: '{name}'");
        }
    }
}

#[given(expr = "an empty action history sequence")]
fn empty_action_history_sequence(world: &mut PredictionWorld) {
    world.context_ids.clear();
}

// ── When Steps ──────────────────────────────────────────────────────────────

#[when(expr = "I request {int} predicted next steps from the model")]
fn request_predicted_steps(world: &mut PredictionWorld, steps: i32) {
    let result = predict_next_actions(&world.context_ids, steps as usize);
    assert!(
        result.is_ok(),
        "predict_next_actions failed: {:?}",
        result.err()
    );
    world.predicted_actions = result.unwrap();
}

// ── Then Steps ──────────────────────────────────────────────────────────────

#[then(expr = "it should contain at least {int} distinct DAW actions")]
fn vocab_min_count(world: &mut PredictionWorld, count: i32) {
    assert!(
        world.vocab.len() >= count as usize,
        "Expected at least {} actions, got {}",
        count,
        world.vocab.len()
    );
}

#[then(expr = "the vocabulary should include action {string} in category {string}")]
fn vocab_includes_action(world: &mut PredictionWorld, name: String, category: String) {
    let entry = world
        .vocab
        .iter()
        .find(|a| a.name == name)
        .unwrap_or_else(|| panic!("Action '{name}' not found in vocabulary"));
    assert_eq!(
        entry.category, category,
        "Action '{name}' category expected '{}', got '{}'",
        category, entry.category
    );
}

#[then(expr = "every action should have a valid display name and Phosphor icon")]
fn vocab_all_valid(world: &mut PredictionWorld) {
    for a in &world.vocab {
        assert!(
            !a.display_name.is_empty(),
            "Action {} has empty display name",
            a.name
        );
        assert!(
            !a.icon.is_empty(),
            "Action {} has empty icon",
            a.name
        );
    }
}

#[then(expr = "the response should contain {int} predicted actions")]
fn response_contains_count(world: &mut PredictionWorld, count: i32) {
    assert_eq!(
        world.predicted_actions.len(),
        count as usize,
        "Expected {} predictions, got {}",
        count,
        world.predicted_actions.len()
    );
}

#[then(expr = "each prediction should have a confidence score between 0 and 100 percent")]
fn predictions_have_confidence(world: &mut PredictionWorld) {
    for p in &world.predicted_actions {
        assert!(
            p.confidence >= 0.0 && p.confidence <= 1.0,
            "Prediction {} confidence out of range: {}",
            p.name,
            p.confidence
        );
    }
}

#[then(expr = "each prediction should have a category, display name, and icon")]
fn predictions_have_metadata(world: &mut PredictionWorld) {
    for p in &world.predicted_actions {
        assert!(
            !p.category.is_empty(),
            "Prediction {} has empty category",
            p.name
        );
        assert!(
            !p.display_name.is_empty(),
            "Prediction {} has empty display name",
            p.name
        );
        assert!(
            !p.icon.is_empty(),
            "Prediction {} has empty icon",
            p.name
        );
    }
}

#[then(expr = "the predicted actions should have valid action IDs")]
fn predictions_valid_ids(world: &mut PredictionWorld) {
    for p in &world.predicted_actions {
        assert!(
            (p.action_id as usize) < DawAction::ALL.len(),
            "Prediction {} action_id {} is out of range",
            p.name,
            p.action_id
        );
    }
}

fn main() {
    futures::executor::block_on(
        PredictionWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/daw_prediction.feature"),
    );
}
