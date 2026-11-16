//! BDD test suite for the DAW's next-step brain and Suggested Next Steps.
//!
//! Verifies the action vocabulary and its parameter specs (interface actions left out), the
//! vocabulary fixture the studio bundle's DAW tests load, the embedded WIR brain against its
//! rule's test vectors, and plans through the same functions the Deno ops call.
//!
//! Regenerate the fixture after changing the vocabulary:
//!   UPDATE_PREDICTION_FIXTURE=1 cargo test --test daw_prediction_bdd

use cucumber::{World as _, given, then, when};
use entropy_engine::deno::prediction_ops::{
    ActionVocabEntry, ContextInput, HistoryEntry, PlanRequest, PlanState, PredictedAction, PredictionStatus, poll_plan,
    predict_plan, prediction_action_vocab, prediction_choice_lists, prediction_status,
};
use entropy_engine::prediction::daw_actions::DAW_VOCAB_VERSION;

const FIXTURE: &str = "examples/studio-bundle/tests/fixtures/prediction_vocab.json";

#[derive(cucumber::World, Default)]
pub struct PredictionWorld {
    vocab: Vec<ActionVocabEntry>,
    history: Vec<HistoryEntry>,
    current: ContextInput,
    plan: Vec<PredictedAction>,
    alternative: Vec<PredictedAction>,
    status: Option<PredictionStatus>,
    ticket: u64,
}

impl std::fmt::Debug for PredictionWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PredictionWorld(history={}, plan={})", self.history.len(), self.plan.len())
    }
}

/// The vocabulary and choice lists exactly as the fixture stores them.
fn vocab_json() -> serde_json::Value {
    serde_json::json!({
        "version": DAW_VOCAB_VERSION,
        "actions": prediction_action_vocab(),
        "choices": prediction_choice_lists(),
    })
}

/// "add_note 0 4 1 0.85; play" as history entries, all with `context`.
fn parse_history(actions: &str, context: ContextInput) -> Vec<HistoryEntry> {
    actions
        .split(';')
        .map(|entry| {
            let mut parts = entry.split_whitespace();
            let action = parts.next().unwrap().to_string();
            HistoryEntry { action, params: parts.map(|p| p.parse().unwrap()).collect(), context }
        })
        .collect()
}

fn plan_request(world: &PredictionWorld, history: Vec<HistoryEntry>, steps: u32, alternative: u32) -> PlanRequest {
    PlanRequest { history, current: Some(world.current), steps: Some(steps), alternative: Some(alternative) }
}

fn request(world: &PredictionWorld, history: Vec<HistoryEntry>, steps: u32, alternative: u32) -> Vec<PredictedAction> {
    predict_plan(&plan_request(world, history, steps, alternative)).unwrap_or_else(|e| panic!("predict_plan failed: {e:?}"))
}

// ── Given ─────────────────────────────────────────────────────────────────────

#[given(expr = "the DAW action vocabulary is loaded")]
fn vocab_loaded(world: &mut PredictionWorld) {
    world.vocab = prediction_action_vocab();
}

#[given(expr = "a history of {string} on a {string} track")]
fn history(world: &mut PredictionWorld, actions: String, family: String) {
    let choices = prediction_choice_lists();
    let family = choices["families"].iter().position(|o| o.id == family).unwrap_or_else(|| panic!("no family {family}")) as u32;
    world.current = ContextInput { family, tracks: 3, ..Default::default() };
    world.history = parse_history(&actions, world.current);
}

// ── When ──────────────────────────────────────────────────────────────────────

#[when(expr = "I ask whether the brain is available")]
fn ask_status(world: &mut PredictionWorld) {
    world.status = Some(prediction_status());
}

#[when(expr = "I request a plan of {int} steps")]
fn request_plan(world: &mut PredictionWorld, steps: u32) {
    world.plan = request(world, world.history.clone(), steps, 0);
}

#[when(expr = "I request alternative plan {int} of {int} steps")]
fn request_alternative(world: &mut PredictionWorld, alternative: u32, steps: u32) {
    world.alternative = request(world, world.history.clone(), steps, alternative);
}

#[when(expr = "I request a plan of {int} steps through a ticket")]
fn request_ticket(world: &mut PredictionWorld, steps: u32) {
    let req = plan_request(world, world.history.clone(), steps, 0);
    world.ticket = entropy_engine::deno::prediction_ops::request_plan(&req);
}

#[when("I poll that ticket once")]
fn poll_once(world: &mut PredictionWorld) {
    let poll = poll_plan(world.ticket);
    assert_eq!(poll.state, PlanState::Done, "{:?}", poll.error);
    world.plan = poll.plan;
}

// ── Then ──────────────────────────────────────────────────────────────────────

#[then(expr = "it should contain at least {int} distinct DAW actions")]
fn vocab_min_count(world: &mut PredictionWorld, count: usize) {
    assert!(world.vocab.len() >= count, "expected at least {count} actions, got {}", world.vocab.len());
}

#[then(expr = "the vocabulary should include action {string} in category {string}")]
fn vocab_includes_action(world: &mut PredictionWorld, name: String, category: String) {
    let entry = world.vocab.iter().find(|a| a.name == name).unwrap_or_else(|| panic!("action '{name}' not found"));
    assert_eq!(entry.category, category, "category of {name}");
}

#[then(expr = "the vocabulary should not include {string}")]
fn vocab_excludes(world: &mut PredictionWorld, names: String) {
    for name in names.split(',').map(str::trim) {
        assert!(world.vocab.iter().all(|a| a.name != name), "{name} is in the vocabulary");
    }
}

#[then(expr = "action {string} should have parameters {string}")]
fn action_params(world: &mut PredictionWorld, name: String, params: String) {
    let entry = world.vocab.iter().find(|a| a.name == name).unwrap();
    let got: Vec<String> = entry.params.iter().map(|p| format!("{}:{}", p.name, p.kind)).collect();
    let want: Vec<String> = params.split(',').map(|s| s.trim().to_string()).collect();
    assert_eq!(got, want, "parameters of {name}");
    assert_eq!(entry.param_count, want.len());
}

#[then(expr = "every choice parameter should name a choice list that exists")]
fn choices_exist(world: &mut PredictionWorld) {
    let lists = prediction_choice_lists();
    for a in &world.vocab {
        for p in &a.params {
            if p.kind == "choice" {
                let list = p.choices.as_ref().unwrap_or_else(|| panic!("{}.{} has no list", a.name, p.name));
                let options = lists.get(list).unwrap_or_else(|| panic!("{}.{} names missing list {list}", a.name, p.name));
                assert_eq!(p.max as usize, options.len() - 1, "{}.{} range vs {list}", a.name, p.name);
            }
        }
    }
}

#[then(expr = "every action should have a valid display name and Phosphor icon")]
fn vocab_all_valid(world: &mut PredictionWorld) {
    for a in &world.vocab {
        assert!(!a.display_name.is_empty(), "{} has an empty display name", a.name);
        assert!(!a.icon.is_empty(), "{} has an empty icon", a.name);
    }
}

#[then(expr = "the studio bundle's vocabulary fixture should match it")]
fn fixture_matches(_world: &mut PredictionWorld) {
    let want = serde_json::to_string_pretty(&vocab_json()).unwrap() + "\n";
    if std::env::var("UPDATE_PREDICTION_FIXTURE").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(FIXTURE).parent().unwrap()).unwrap();
        std::fs::write(FIXTURE, &want).unwrap();
    }
    let have = std::fs::read_to_string(FIXTURE).unwrap_or_default().replace("\r\n", "\n");
    assert!(have == want, "{FIXTURE} is out of date: rerun with UPDATE_PREDICTION_FIXTURE=1");
}

#[then(expr = "the brain should be available")]
fn available(world: &mut PredictionWorld) {
    let status = world.status.as_ref().unwrap();
    assert!(status.available, "{status:?}");
    assert!(status.weights > 0, "{status:?}");
    assert!(status.message.contains("WIR"), "{}", status.message);
}

#[then(expr = "the runtime should reproduce the rule's test vectors exactly")]
fn vectors_exact(_world: &mut PredictionWorld) {
    let brain = entropy_engine::prediction::brain::brain().unwrap();
    let (worst, n) = brain.check_vectors();
    assert!(n > 0, "the brain has no test vectors");
    assert_eq!(worst, 0.0, "worst difference over {n} vectors");
}

#[then(expr = "the plan should have {int} steps")]
fn plan_len(world: &mut PredictionWorld, steps: usize) {
    assert_eq!(world.plan.len(), steps);
}

#[then(expr = "every step should carry one value per parameter, inside its range")]
fn plan_params(world: &mut PredictionWorld) {
    let vocab = prediction_action_vocab();
    for step in &world.plan {
        let def = vocab.iter().find(|a| a.name == step.name).unwrap_or_else(|| panic!("unknown action {}", step.name));
        assert_eq!(step.params.len(), def.params.len(), "{} params", step.name);
        for (v, spec) in step.params.iter().zip(&def.params) {
            assert!(*v >= spec.min && *v <= spec.max, "{}.{} = {v} outside {}..{}", step.name, spec.name, spec.min, spec.max);
            if spec.kind != "knob" {
                assert_eq!(v.fract(), 0.0, "{}.{} = {v} is not whole", step.name, spec.name);
            }
        }
    }
}

#[then(expr = "every step should have a confidence between 0 and 1")]
fn plan_confidence(world: &mut PredictionWorld) {
    for p in &world.plan {
        assert!((0.0..=1.0).contains(&p.confidence), "{} confidence {}", p.name, p.confidence);
    }
}

#[then(expr = "step {int} should be {string} with parameters {string}")]
fn step_is(world: &mut PredictionWorld, index: usize, name: String, params: String) {
    let step = &world.plan[index - 1];
    assert_eq!(step.name, name);
    let want: Vec<f32> = params.split(',').map(|p| p.trim().parse().unwrap()).collect();
    assert_eq!(step.params, want, "{name} parameters");
}

#[then(expr = "the plan should be {string}")]
fn plan_is(world: &mut PredictionWorld, names: String) {
    let got: Vec<&str> = world.plan.iter().map(|p| p.name.as_str()).collect();
    let want: Vec<&str> = names.split(',').map(str::trim).collect();
    assert_eq!(got, want);
}

#[then(expr = "the alternative plan should open with a different action")]
fn alternative_differs(world: &mut PredictionWorld) {
    assert_ne!(world.plan[0].action_id, world.alternative[0].action_id);
}

#[then(expr = "the plan should be the same as for {string}")]
fn same_plan(world: &mut PredictionWorld, actions: String) {
    let other = request(world, parse_history(&actions, world.current), world.plan.len() as u32, 0);
    let view = |p: &[PredictedAction]| p.iter().map(|s| (s.name.clone(), s.params.clone())).collect::<Vec<_>>();
    assert_eq!(view(&world.plan), view(&other));
}

fn main() {
    futures::executor::block_on(
        PredictionWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/daw_prediction.feature"),
    );
}
