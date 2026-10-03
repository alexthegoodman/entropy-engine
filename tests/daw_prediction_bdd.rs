#![recursion_limit = "256"]

//! BDD test suite for the DAW UI prediction model and Suggested Next Steps.
//!
//! Verifies the action vocabulary and its parameter specs, the vocabulary fixture the studio
//! bundle's DAW tests load, the checkpoint version gate, and plan prediction through the same
//! `predict_plan` the Deno op calls. Inference runs against a freshly initialised (untrained)
//! checkpoint written to a temp dir: these scenarios check the plumbing and the shape of a plan,
//! not how good its suggestions are - that needs a trained model.
//!
//! Regenerate the fixture after changing the vocabulary:
//!   UPDATE_PREDICTION_FIXTURE=1 cargo test --test daw_prediction_bdd

use cucumber::{World as _, given, then, when};
use entropy_engine::deno::prediction_ops::{
    ActionVocabEntry, ContextInput, HistoryEntry, PlanRequest, PlanState, PredictedAction, poll_plan,
    predict_plan, prediction_action_vocab, prediction_choice_lists,
};
use entropy_engine::deno::prediction_ops::{PredictionStatus, prediction_status};
use entropy_engine::prediction::daw_actions::{ACTION_VOCAB_SIZE, DAW_VOCAB_VERSION, NUM_FAMILIES, NUM_VIEWS};
use entropy_engine::prediction::model::{CHECKPOINT_ENV, PredictionMetadata, PredictionModel, PredictionModelConfig};

const FIXTURE: &str = "examples/studio-bundle/tests/fixtures/prediction_vocab.json";

#[derive(cucumber::World, Default)]
pub struct PredictionWorld {
    vocab: Vec<ActionVocabEntry>,
    checkpoint: Option<std::path::PathBuf>,
    load_error: Option<String>,
    history: Vec<HistoryEntry>,
    current: ContextInput,
    plan: Vec<PredictedAction>,
    alternative: Vec<PredictedAction>,
    status: Option<PredictionStatus>,
    /// Tickets from `request_plan`, oldest first, and how long queuing the last one took.
    tickets: Vec<u64>,
    queue_ms: f64,
}

impl std::fmt::Debug for PredictionWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PredictionWorld(history={}, plan={})", self.history.len(), self.plan.len())
    }
}

fn tiny_config() -> PredictionModelConfig {
    PredictionModelConfig::new()
        .with_vocab_size(ACTION_VOCAB_SIZE)
        .with_num_families(NUM_FAMILIES)
        .with_num_views(NUM_VIEWS)
        .with_embed_dim(32)
        .with_n_layers(2)
        .with_attn_heads(2)
        .with_ff_dim(64)
        .with_max_seq_len(32)
        .with_num_experts(4)
        .with_top_k(1)
        .with_dropout_rate(0.0)
}

fn temp_checkpoint(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("entropy-prediction-{tag}-{}", uuid::Uuid::new_v4()))
}

/// The vocabulary and choice lists exactly as the fixture stores them.
fn vocab_json() -> serde_json::Value {
    serde_json::json!({
        "version": DAW_VOCAB_VERSION,
        "actions": prediction_action_vocab(),
        "choices": prediction_choice_lists(),
    })
}

// ── Given ─────────────────────────────────────────────────────────────────────

#[given(expr = "the DAW action vocabulary is loaded")]
fn vocab_loaded(world: &mut PredictionWorld) {
    world.vocab = prediction_action_vocab();
}

#[given(expr = "a prediction checkpoint saved with vocabulary version {int}")]
fn old_checkpoint(world: &mut PredictionWorld, version: u32) {
    let dir = temp_checkpoint("old");
    let config = tiny_config();
    let mut meta = PredictionMetadata::from_config(&config);
    let device = Default::default();
    let model: PredictionModel<burn::backend::Wgpu> = config.init(&device);
    model.save(dir.to_str().unwrap(), &meta).unwrap();
    meta.vocab_version = version;
    meta.vocab_size = 35;
    std::fs::write(dir.join("metadata.json"), serde_json::to_string(&meta).unwrap()).unwrap();
    world.checkpoint = Some(dir);
}

#[given(expr = "a freshly initialised prediction checkpoint")]
fn fresh_checkpoint(world: &mut PredictionWorld) {
    let dir = temp_checkpoint("fresh");
    let config = tiny_config();
    let device = Default::default();
    let model: PredictionModel<burn::backend::Wgpu> = config.init(&device);
    model.save(dir.to_str().unwrap(), &PredictionMetadata::from_config(&config)).unwrap();
    // The op resolves its checkpoint through this variable when it is set.
    unsafe { std::env::set_var(CHECKPOINT_ENV, &dir) };
    world.checkpoint = Some(dir);
}

#[given(expr = "no prediction model is installed")]
fn no_model(world: &mut PredictionWorld) {
    let dir = temp_checkpoint("empty");
    std::fs::create_dir_all(&dir).unwrap();
    unsafe { std::env::set_var(CHECKPOINT_ENV, &dir) };
    world.checkpoint = Some(dir);
}

#[given(expr = "a checkpoint with metadata but no model.bin")]
fn no_weights(world: &mut PredictionWorld) {
    let dir = temp_checkpoint("noweights");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("metadata.json"), serde_json::to_string(&PredictionMetadata::from_config(&tiny_config())).unwrap()).unwrap();
    unsafe { std::env::set_var(CHECKPOINT_ENV, &dir) };
    world.checkpoint = Some(dir);
}

#[given(expr = "a history of {string} on a {string} track in the {string} view")]
fn history(world: &mut PredictionWorld, actions: String, family: String, view: String) {
    let choices = prediction_choice_lists();
    let index = |list: &str, id: &str| choices[list].iter().position(|o| o.id == id).unwrap_or_else(|| panic!("no {id} in {list}")) as u32;
    world.current = ContextInput { family: index("families", &family), view: index("views", &view), tracks: 2, ..Default::default() };
    world.history = actions
        .split(';')
        .map(|entry| {
            let mut parts = entry.split_whitespace();
            let action = parts.next().unwrap().to_string();
            HistoryEntry { action, params: parts.map(|p| p.parse().unwrap()).collect(), context: world.current }
        })
        .collect();
}

// ── When ──────────────────────────────────────────────────────────────────────

#[when(expr = "I try to load that checkpoint")]
fn try_load(world: &mut PredictionWorld) {
    let dir = world.checkpoint.as_ref().unwrap();
    let device = Default::default();
    world.load_error = PredictionModel::<burn::backend::Wgpu>::load(dir.to_str().unwrap(), &device).err().map(|e| e.to_string());
}

fn request(world: &PredictionWorld, steps: u32, alternative: u32) -> Vec<PredictedAction> {
    predict_plan(&PlanRequest {
        history: world.history.clone(),
        current: Some(world.current),
        steps: Some(steps),
        alternative: Some(alternative),
    })
    .unwrap_or_else(|e| panic!("predict_plan failed: {e:?}"))
}

#[when(expr = "I ask whether a model is installed")]
fn ask_status(world: &mut PredictionWorld) {
    world.status = Some(prediction_status());
}

#[when(expr = "I request a plan of {int} steps")]
fn request_plan(world: &mut PredictionWorld, steps: u32) {
    world.plan = request(world, steps, 0);
}

#[when(expr = "I request alternative plan {int} of {int} steps")]
fn request_alternative(world: &mut PredictionWorld, alternative: u32, steps: u32) {
    world.alternative = request(world, steps, alternative);
}

fn plan_request(world: &PredictionWorld, steps: u32) -> PlanRequest {
    PlanRequest { history: world.history.clone(), current: Some(world.current), steps: Some(steps), alternative: Some(0) }
}

#[when(expr = "I queue {int} plans of {int} steps back to back")]
fn queue_plans(world: &mut PredictionWorld, count: usize, steps: u32) {
    for _ in 0..count {
        let request = plan_request(world, steps);
        let started = std::time::Instant::now();
        world.tickets.push(entropy_engine::deno::prediction_ops::request_plan(&request));
        world.queue_ms = started.elapsed().as_secs_f64() * 1000.0;
    }
}

#[when("I poll the newest plan until it is finished")]
fn poll_newest(world: &mut PredictionWorld) {
    let ticket = *world.tickets.last().expect("no plan was queued");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        let poll = poll_plan(ticket);
        match poll.state {
            PlanState::Pending => {
                assert!(std::time::Instant::now() < deadline, "plan {ticket} still pending after 120 s");
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            PlanState::Done => {
                world.plan = poll.plan;
                return;
            }
            other => panic!("plan {ticket} ended {other:?}: {:?}", poll.error),
        }
    }
}

#[then(expr = "queuing a plan took under {int} ms")]
fn queue_fast(world: &mut PredictionWorld, ms: u32) {
    assert!(world.queue_ms < ms as f64, "queuing took {:.3} ms", world.queue_ms);
}

#[then(expr = "at least {int} of the earlier plans were superseded without running")]
fn superseded(world: &mut PredictionWorld, count: usize) {
    let earlier = &world.tickets[..world.tickets.len() - 1];
    let states: Vec<PlanState> = earlier.iter().map(|&t| poll_plan(t).state).collect();
    assert!(states.iter().all(|s| matches!(s, PlanState::Done | PlanState::Superseded)), "{states:?}");
    let n = states.iter().filter(|&&s| s == PlanState::Superseded).count();
    assert!(n >= count, "only {n} superseded: {states:?}");
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

#[then(expr = "loading should fail with a message naming vocabulary {string}")]
fn load_failed(world: &mut PredictionWorld, version: String) {
    let err = world.load_error.as_ref().expect("the old checkpoint loaded");
    assert!(err.contains(&format!("vocabulary {version}")), "{err}");
    assert!(err.contains("retrain"), "{err}");
}

#[then(expr = "the model should be unavailable, saying {string}")]
fn unavailable(world: &mut PredictionWorld, text: String) {
    let status = world.status.as_ref().unwrap();
    assert!(!status.available, "{status:?}");
    assert!(status.message.contains(&text), "{}", status.message);
}

#[then(expr = "the model should be available")]
fn available(world: &mut PredictionWorld) {
    let status = world.status.as_ref().unwrap();
    assert!(status.available, "{status:?}");
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
            if spec.kind != "knob" { assert_eq!(v.fract(), 0.0, "{}.{} = {v} is not whole", step.name, spec.name); }
        }
    }
}

#[then(expr = "every step should have a confidence between 0 and 1")]
fn plan_confidence(world: &mut PredictionWorld) {
    for p in &world.plan {
        assert!((0.0..=1.0).contains(&p.confidence), "{} confidence {}", p.name, p.confidence);
    }
}

#[then(expr = "the alternative plan should open with a different action")]
fn alternative_differs(world: &mut PredictionWorld) {
    assert_ne!(world.plan[0].action_id, world.alternative[0].action_id);
}

fn main() {
    futures::executor::block_on(
        PredictionWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/daw_prediction.feature"),
    );
}
