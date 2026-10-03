//! The DAW's next-action prediction model, its action vocabulary and the procedural session
//! generator that trains it (moved from yumon-pet). `gen_daw_data` and `train_prediction` in
//! src/bin generate data and train; the Deno ops in deno/prediction_ops.rs run inference.

pub mod daw_actions;
pub mod daw_sim;
pub mod model;
pub mod nn;

pub use daw_actions::{ActionStep, DawAction, StepContext, Trajectory};
pub use model::{
    ActionPredictor, AltAction, InferenceBackend, LoadedPredictor, PlanPoll, PlanState, PredictedAction,
    PredictionMetadata, PredictionModel, PredictionModelConfig, PredictionStatus, poll_plan, predict_next_actions,
    predict_plan, prediction_status, request_plan, resolve_prediction_checkpoint_dir,
};
