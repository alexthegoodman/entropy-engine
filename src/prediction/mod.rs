//! The DAW's next-step prediction: a written WIR brain (`brain`, compiled by yumon-pet's
//! `wir daw`), the substantive action vocabulary it ranks (`daw_actions`) and the procedural
//! session simulator it is scored on (`daw_sim`; `bench_prediction` in src/bin measures it,
//! `gen_daw_data` writes sessions for `wir daw --sessions`). The Deno ops in
//! deno/prediction_ops.rs call it.

pub mod brain;
pub mod daw_actions;
pub mod daw_sim;

pub use brain::{
    AltAction, Brain, BrainInput, PlanPoll, PlanState, PredictedAction, PredictionStatus, poll_plan, predict_plan, prediction_status,
    request_plan,
};
pub use daw_actions::{ActionStep, DawAction, StepContext, Trajectory};
