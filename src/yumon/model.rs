/// [YUMON BRAIN] — LSTM organism brain for AI pet concept.
///
/// Architecture mirrors the original exactly:
///   LSTM(256) → Dropout(0.2) → Dense(64, ReLU) → Dense(8, linear)
///   Input: [batch, CONTEXT_LEN=16, MOMENT_SIZE=16]   Output: 8 action logits
///
/// Training: REINFORCE policy gradient via manual grad accumulation,
///           matching the tf.variableGrads batch loop in the original.

use burn::{
    module::AutodiffModule,
    nn::{
        loss::CrossEntropyLossConfig,
        Dropout, DropoutConfig, Gelu, Linear, LinearConfig, Lstm, LstmConfig,
    },
    optim::{AdamConfig, GradientsParams, Optimizer, Adam, adaptor::OptimizerAdaptor},
    prelude::*,
    tensor::{
        backend::AutodiffBackend,
        Distribution,
    },
};
use rand::seq::SliceRandom;
use rand::thread_rng;
use std::collections::VecDeque;

// ─── Constants ────────────────────────────────────────────────────────────────

pub const MOMENT_SIZE: usize    = 16;
pub const WORLD_SIZE: usize     = 8;
pub const SELF_SIZE: usize      = 8;
pub const ACTION_SIZE: usize    = 8;
pub const CONTEXT_LEN: usize    = 16;
pub const MEMORY_CAPACITY: usize = 512;
pub const BATCH_SIZE: usize     = 16;
pub const SLEEP_EPOCHS: usize   = 4;
pub const DANGER_THRESHOLD: f32 = 0.5;
pub const DANGER_WEIGHT: f32    = 5.0;
pub const TICK_MS: u64          = 500;
pub const SLEEP_EVERY_MS: u64   = 200_000;

// ─── Enums ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SelfIdx {
    Battery     = 0,
    Health      = 1,
    Stamina     = 2,
    Boredom     = 3,
    ProcLoad    = 4,
    Clock       = 5,
    Storage     = 6,
    RewardDelta = 7,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorldIdx {
    DistToCharger = 0,
    DistToGoal    = 1,
    DistToBuild   = 2,
    LightLevel    = 3,
    Danger        = 4,
    TypeID        = 5,
    Stability     = 6,
    PathClear     = 7,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    GoToCharger = 0,
    GoToRandom  = 1,
    GoToTarget  = 2,
    Interact    = 3,
    PickDrop    = 4,
    Rest        = 5,
    Scan        = 6,
    Build       = 7,
}

impl Action {
    pub fn from_usize(v: usize) -> Self {
        match v {
            0 => Action::GoToCharger,
            1 => Action::GoToRandom,
            2 => Action::GoToTarget,
            3 => Action::Interact,
            4 => Action::PickDrop,
            5 => Action::Rest,
            6 => Action::Scan,
            7 => Action::Build,
            _ => Action::Scan,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Action::GoToCharger => "GoToCharger",
            Action::GoToRandom  => "GoToRandom",
            Action::GoToTarget  => "GoToTarget",
            Action::Interact    => "Interact",
            Action::PickDrop    => "PickDrop",
            Action::Rest        => "Rest",
            Action::Scan        => "Scan",
            Action::Build       => "Build",
        }
    }
}

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Moment {
    pub world: [f32; WORLD_SIZE],
    pub self_: [f32; SELF_SIZE],
}

impl Moment {
    pub fn zero() -> Self {
        Self {
            world: [0.0; WORLD_SIZE],
            self_: [0.0; SELF_SIZE],
        }
    }

    pub fn to_flat(&self) -> [f32; MOMENT_SIZE] {
        let mut out = [0.0f32; MOMENT_SIZE];
        out[..WORLD_SIZE].copy_from_slice(&self.world);
        out[WORLD_SIZE..].copy_from_slice(&self.self_);
        out
    }
}

#[derive(Debug, Clone)]
pub struct Experience {
    pub moment:       Moment,
    pub action_taken: Action,
    pub reward:       f32,
    pub danger:       f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganismState {
    Awake,
    Sleeping,
}

#[derive(Debug, Clone)]
pub struct InferenceResult {
    pub action:        Action,
    pub action_name:   &'static str,
    pub logits:        Vec<f32>,
    pub probabilities: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct SleepResult {
    pub epochs_run:   usize,
    pub final_loss:   f32,
    pub samples_used: usize,
}

// ─── Running Normalizer ───────────────────────────────────────────────────────

/// Welford online mean/variance normalizer, matching RunningNorm in the JS.
pub struct RunningNorm {
    n:    u64,
    mean: Vec<f32>,
    m2:   Vec<f32>,
    size: usize,
}

impl RunningNorm {
    pub fn new(size: usize) -> Self {
        Self {
            n:    0,
            mean: vec![0.0; size],
            m2:   vec![1.0; size],
            size,
        }
    }

    pub fn update(&mut self, x: &[f32]) {
        self.n += 1;
        for i in 0..self.size {
            let delta = x[i] - self.mean[i];
            self.mean[i] += delta / self.n as f32;
            self.m2[i]   += delta * (x[i] - self.mean[i]);
        }
    }

    pub fn normalize(&self, x: &[f32]) -> Vec<f32> {
        let mut out = vec![0.0f32; self.size];
        for i in 0..self.size {
            let variance = if self.n > 1 {
                self.m2[i] / (self.n - 1) as f32
            } else {
                1.0
            };
            out[i] = (x[i] - self.mean[i]) / (variance.sqrt() + 1e-8);
        }
        out
    }
}

// ─── Experience Buffer ────────────────────────────────────────────────────────

pub struct ExperienceBuffer {
    buffer: VecDeque<Experience>,
}

impl ExperienceBuffer {
    pub fn new() -> Self {
        Self { buffer: VecDeque::with_capacity(MEMORY_CAPACITY) }
    }

    pub fn push(&mut self, exp: Experience) {
        if self.buffer.len() >= MEMORY_CAPACITY {
            self.buffer.pop_front();
        }
        self.buffer.push_back(exp);
    }

    pub fn len(&self) -> usize { self.buffer.len() }
    pub fn is_empty(&self) -> bool { self.buffer.is_empty() }

    pub fn get_all(&self) -> Vec<&Experience> {
        self.buffer.iter().collect()
    }

    pub fn count_dangerous(&self) -> usize {
        self.buffer.iter().filter(|e| e.danger > DANGER_THRESHOLD).count()
    }
}

// ─── Model Definition ─────────────────────────────────────────────────────────

/// Brain model: LSTM(256) → Dropout(0.2) → Dense(64, ReLU) → Dense(8, linear)
#[derive(Module, Debug)]
pub struct BrainModel<B: Backend> {
    lstm:    Lstm<B>,
    dropout: Dropout,
    dense1:  Linear<B>,
    dense2:  Linear<B>,
}

#[derive(Config, Debug)]
pub struct BrainModelConfig {
    #[config(default = 256)]
    pub lstm_units: usize,
    #[config(default = 64)]
    pub hidden_units: usize,
    #[config(default = 0.2)]
    pub dropout_rate: f64,
}

impl BrainModelConfig {
    pub fn init<B: Backend>(&self, device: &B::Device) -> BrainModel<B> {
        BrainModel {
            lstm: LstmConfig::new(MOMENT_SIZE, self.lstm_units, false)
                .init(device),
            dropout: DropoutConfig::new(self.dropout_rate).init(),
            dense1: LinearConfig::new(self.lstm_units, self.hidden_units).init(device),
            dense2: LinearConfig::new(self.hidden_units, ACTION_SIZE).init(device),
        }
    }
}

impl<B: Backend> BrainModel<B> {
    /// Forward pass.
    /// Input:  [batch, CONTEXT_LEN, MOMENT_SIZE]
    /// Output: [batch, ACTION_SIZE]  (raw logits)
    pub fn forward(&self, x: Tensor<B, 3>) -> Tensor<B, 2> {
        // LSTM — returns (output_seq, (h_n, c_n))
        // output_seq shape: [batch, seq_len, lstm_units]
        let (output_seq, _) = self.lstm.forward(x, None);

        // Take last time-step: [batch, lstm_units]
        let dims = output_seq.dims();
        let batch = dims[0];
        let seq_len = dims[1];
        let units = dims[2];
        
        let last = output_seq.slice([0..batch, seq_len - 1..seq_len, 0..units])
            .reshape([batch, units]);

        let dropped = self.dropout.forward(last);
        let h       = burn::tensor::activation::relu(self.dense1.forward(dropped));
        self.dense2.forward(h)
    }
}

// ─── Reward ───────────────────────────────────────────────────────────────────

/// Mirrors computeReward() in brain.ts exactly.
pub fn compute_reward(
    prev_self:          &[f32; SELF_SIZE],
    next_self:          &[f32; SELF_SIZE],
    _action_taken:      Action,
    distance_travelled: f32,
) -> f32 {
    let health_gain  = (next_self[SelfIdx::Health  as usize] - prev_self[SelfIdx::Health  as usize]) * 2.0;
    let battery_gain = (next_self[SelfIdx::Battery as usize] - prev_self[SelfIdx::Battery as usize]) * 1.5;
    let boredom_pen  = -next_self[SelfIdx::Boredom as usize] * 0.2;
    let stamina_drop = prev_self[SelfIdx::Stamina as usize] - next_self[SelfIdx::Stamina as usize];
    let stamina_pen  = -(stamina_drop.max(0.0)) * 0.1;
    let dist_penalty = -(distance_travelled.abs()) * 0.02;

    health_gain + battery_gain + boredom_pen + stamina_pen + dist_penalty
}

// ─── Policy Gradient Loss ─────────────────────────────────────────────────────

/// REINFORCE loss: -log_prob(action) * (1 - reward)
/// Mirrors policyGradientLoss() in brain.ts.
// fn policy_gradient_loss<B: AutodiffBackend>(
//     logits:       Tensor<B, 2>,   // [1, ACTION_SIZE]
//     action_taken: Action,
//     reward:       f32,
// ) -> Tensor<B, 1> {
//     let reward_scale = -1.0f32;
//     let action_idx   = action_taken as usize;

//     // log_softmax over action dim
//     let log_probs = burn::tensor::activation::log_softmax(logits, 1); // [1, ACTION_SIZE]

//     // Extract log prob of the taken action → scalar
//     let log_prob_taken = log_probs
//         .slice([0..1, action_idx..action_idx + 1])
//         .squeeze::<0>(); // scalar [,]

//     // loss = -log_prob * (1 - reward)   (reward_scale = -1 baked in)
//     log_prob_taken.mul_scalar((1.0 - reward) * reward_scale)
//         .unsqueeze() // back to [1] so we can return Tensor<B, 1>
// }

fn policy_gradient_loss<B: AutodiffBackend>(
    logits:       Tensor<B, 2>,   // [1, ACTION_SIZE]
    action_taken: Action,
    reward:       f32,
) -> Tensor<B, 1> {
    let action_idx = action_taken as usize;

    let log_probs = burn::tensor::activation::log_softmax(logits, 1); // [1, ACTION_SIZE]

    // Slice to [1, 1] then reshape to [1] — avoids zero-dim squeeze
    let log_prob_taken = log_probs
        .slice([0..1, action_idx..action_idx + 1])
        .reshape([1]);

    log_prob_taken.mul_scalar((1.0 - reward) * -1.0)
}

// ─── Brain ────────────────────────────────────────────────────────────────────

pub struct YumonBrain<B: AutodiffBackend> {
    pub model:          BrainModel<B>,
    optimizer:          OptimizerAdaptor<Adam, BrainModel<B>, B>,
    buffer:             ExperienceBuffer,
    world_norm:         RunningNorm,
    self_norm:          RunningNorm,
    context_window:     VecDeque<Moment>,
    device:             B::Device,

    pub state:          OrganismState,
    pub total_moments:  u64,
    pub last_reward:    f32,
    pub last_loss:      Option<f32>,
    pub last_action:    &'static str,
    pub sleep_count:    u32,
}

impl<B: AutodiffBackend> YumonBrain<B> {
    pub fn new(device: B::Device) -> Self {
        let config = BrainModelConfig::new();
        Self {
            model:          config.init(&device),
            optimizer:      AdamConfig::new().with_epsilon(1e-7).init(),
            buffer:         ExperienceBuffer::new(),
            world_norm:     RunningNorm::new(WORLD_SIZE),
            self_norm:      RunningNorm::new(SELF_SIZE),
            context_window: VecDeque::with_capacity(CONTEXT_LEN),
            device,
            state:          OrganismState::Awake,
            total_moments:  0,
            last_reward:    0.0,
            last_loss:      None,
            last_action:    "none",
            sleep_count:    0,
        }
    }

    // ── Wake Cycle ─────────────────────────────────────────────────────────────

    pub fn observe(
        &mut self,
        raw_world:    &[f32; WORLD_SIZE],
        raw_self:     &[f32; SELF_SIZE],
        action_taken: Action,
        reward:       f32,
    ) {
        if self.state != OrganismState::Awake { return; }

        self.world_norm.update(raw_world.as_slice());
        self.self_norm.update(raw_self.as_slice());

        let world_norm = self.world_norm.normalize(raw_world.as_slice());
        let self_norm  = self.self_norm.normalize(raw_self.as_slice());

        let mut world_arr = [0.0f32; WORLD_SIZE];
        let mut self_arr  = [0.0f32; SELF_SIZE];
        world_arr.copy_from_slice(&world_norm);
        self_arr.copy_from_slice(&self_norm);

        let moment = Moment { world: world_arr, self_: self_arr };

        let danger = raw_world[WorldIdx::Danger as usize];
        self.buffer.push(Experience { moment: moment.clone(), action_taken, reward, danger });

        if self.context_window.len() >= CONTEXT_LEN {
            self.context_window.pop_front();
        }
        self.context_window.push_back(moment);

        self.total_moments += 1;
        self.last_reward    = reward;
    }

    pub fn infer(&self) -> InferenceResult {
        assert_eq!(self.state, OrganismState::Awake, "[Brain] Cannot infer while sleeping.");
        assert!(!self.context_window.is_empty(), "[Brain] No context yet.");

        let padded = pad_moments_deque(&self.context_window, CONTEXT_LEN);
        let flat   = moments_to_flat(&padded);

        // let input_t  = Tensor::<B, 3>::from_floats(flat.as_slice(), &self.device)
        //     .reshape([1, CONTEXT_LEN, MOMENT_SIZE]);

        let input_t = Tensor::<B, 3>::from_floats(
            TensorData::new(flat, [1, CONTEXT_LEN, MOMENT_SIZE]),
            &self.device,
        );

        // Use valid() to disable dropout during inference
        let model_valid = self.model.clone().valid();
        let logits_t    = model_valid.forward(input_t.inner());
        let logits: Vec<f32> = logits_t.to_data().to_vec().unwrap();

        let probs  = softmax(&logits);
        let action = argmax(&probs);

        let action_enum = Action::from_usize(action);
        self.clone_last_action_name(action_enum);

        InferenceResult {
            action:        action_enum,
            action_name:   action_enum.name(),
            logits,
            probabilities: probs,
        }
    }

    // Hack to update last_action without &mut self in infer (called via interior pattern).
    // In practice, callers should update last_action from the returned InferenceResult.
    fn clone_last_action_name(&self, _a: Action) {
        // last_action is updated by the caller after infer returns.
    }

    // ── Sleep Cycle ────────────────────────────────────────────────────────────

    /// REINFORCE training loop — matches the sleepAndWake() implementation in brain.ts.
    pub fn sleep(&mut self, epochs: usize) -> SleepResult {
        assert_ne!(self.state, OrganismState::Sleeping, "[Brain] Already sleeping.");
        if self.buffer.len() < CONTEXT_LEN {
            eprintln!("[Brain] Not enough experience to sleep yet.");
            return SleepResult { epochs_run: 0, final_loss: 0.0, samples_used: 0 };
        }

        self.state = OrganismState::Sleeping;
        self.sleep_count += 1;

        let all: Vec<Experience> = self.buffer.buffer.iter().cloned().collect();
        println!("[Brain] 💤 Sleep session {} — {} experiences, {} epochs",
            self.sleep_count, all.len(), epochs);

        let mut final_loss = 0.0f32;

        for epoch in 0..epochs {
            let mut indices: Vec<usize> = (0..all.len()).collect();
            indices.shuffle(&mut thread_rng());

            let mut epoch_loss = 0.0f32;
            let num_batches    = (indices.len() + BATCH_SIZE - 1) / BATCH_SIZE;

            for batch_start in (0..indices.len()).step_by(BATCH_SIZE) {
                let batch_idx: Vec<usize> = indices[batch_start..(batch_start + BATCH_SIZE).min(indices.len())].to_vec();
                let mut batch_loss_sum = 0.0f32;

                // We need to accumulate gradients. Burn's approach: sum the losses,
                // then call backward once on the sum (equivalent to grad accumulation).
                // We collect (context, action, reward) then build a batched loss tensor.

                let mut loss_tensors: Vec<Tensor<B, 1>> = Vec::new();

                for &i in &batch_idx {
                    let exp     = &all[i];
                    let context = build_context(&all, i);
                    let flat    = moments_to_flat(&context);

                    // let input_t  = Tensor::<B, 3>::from_floats(flat.as_slice(), &self.device)
                    //     .reshape([1, CONTEXT_LEN, MOMENT_SIZE]);

                    let input_t = Tensor::<B, 3>::from_floats(
                        TensorData::new(flat, [1, CONTEXT_LEN, MOMENT_SIZE]),
                        &self.device,
                    );

                    let logits   = self.model.forward(input_t);

                    let loss = policy_gradient_loss(logits, exp.action_taken, exp.reward);
                    let loss_val: Vec<f32> = loss.clone().inner().to_data().to_vec().unwrap();
                    batch_loss_sum += loss_val[0];

                    println!("  batchLossSum: {:.2}", batch_loss_sum);
                    loss_tensors.push(loss);
                }

                // Average and backprop
                let batch_size_f = batch_idx.len() as f32;
                let total_loss   = loss_tensors.into_iter()
                    .reduce(|a, b| a + b)
                    .unwrap()
                    .div_scalar(batch_size_f);

                let grads       = GradientsParams::from_grads(total_loss.backward(), &self.model);
                self.model      = self.optimizer.step(1e-4, self.model.clone(), grads);

                epoch_loss += batch_loss_sum / batch_size_f;
            }

            final_loss = epoch_loss / num_batches as f32;
            println!("[Brain]   epoch {}/{}  loss={:.6}", epoch + 1, epochs, final_loss);
        }

        self.last_loss = Some(final_loss);
        SleepResult { epochs_run: epochs, final_loss, samples_used: all.len() }
    }

    pub fn wake(&mut self) {
        if self.state != OrganismState::Sleeping { return; }
        self.state          = OrganismState::Awake;
        self.context_window = VecDeque::with_capacity(CONTEXT_LEN);
        println!("[Brain] 👁️  Awake.");
    }

    pub fn sleep_and_wake(&mut self, epochs: usize) -> SleepResult {
        let result = self.sleep(epochs);
        self.wake();
        result
    }

    // ── Debug ──────────────────────────────────────────────────────────────────

    pub fn debug_print(&self) {
        let buf_usage   = self.buffer.len() as f32 / MEMORY_CAPACITY as f32;
        let bar         = mk_bar(buf_usage, 22);
        let dangerous   = self.buffer.count_dangerous();
        let d_pct       = if self.buffer.len() > 0 {
            (dangerous * 100) / self.buffer.len()
        } else { 0 };
        let state_str   = match self.state {
            OrganismState::Sleeping => "💤 sleeping",
            OrganismState::Awake    => "👁️  awake",
        };
        let loss_str    = self.last_loss.map(|l| format!("{:.6}", l)).unwrap_or("n/a".into());

        println!("╔══════════════════════════════════════════╗");
        println!("║          YUMON BRAIN DEBUG           ║");
        println!("╠══════════════════════════════════════════╣");
        println!("║ State      : {:27}║", state_str);
        println!("║ Moments    : {:27}║", self.total_moments);
        println!("║ Buffer     : {} {:2}%   ║", bar, (buf_usage * 100.0) as u32);
        println!("║ Dangerous  : {:27}║", format!("{} ({}% of buffer)", dangerous, d_pct));
        println!("║ Last Action: {:27}║", self.last_action);
        println!("║ Last Reward: {:27}║", format!("{:.4}", self.last_reward));
        println!("║ Last Loss  : {:27}║", loss_str);
        println!("║ Sleep #    : {:27}║", self.sleep_count);
        println!("╚══════════════════════════════════════════╝");
    }
}

// ─── World Simulation ─────────────────────────────────────────────────────────

/// Minimal 1D world for testing, matching WorldSim in brain.ts.
pub struct WorldSim {
    pub pos:           f32,
    pub danger_pos:    f32,
    pub danger_active: bool,
    pub light_level:   f32,
    pub stability:     f32,
    pub tick_count:    u64,

    pub battery:       f32,
    pub health:        f32,
    pub stamina:       f32,
    pub boredom:       f32,
    pub storage:       f32,
    pub reward_history: Vec<f32>,
}

impl WorldSim {
    const CHARGER_POS: f32 = 0.0;
    const GOAL_POS:    f32 = 0.5;
    const BUILD_POS:   f32 = 0.8;
    const MOVE_SPEED:  f32 = 0.08;

    pub fn new() -> Self {
        Self {
            pos:            0.5,
            danger_pos:     0.3,
            danger_active:  false,
            light_level:    0.8,
            stability:      1.0,
            tick_count:     0,
            battery:        0.9,
            health:         1.0,
            stamina:        1.0,
            boredom:        0.0,
            storage:        0.0,
            reward_history: Vec::new(),
        }
    }

    pub fn step(&mut self, action: Action) -> ([f32; WORLD_SIZE], [f32; SELF_SIZE], f32) {
        let prev_pos = self.pos;
        self.tick_count += 1;

        // Roam danger
        self.danger_pos   += (fastrand::f32() - 0.5) * 0.05;
        self.danger_pos    = self.danger_pos.max(0.0).min(1.0);
        self.danger_active = fastrand::f32() < 0.2;
        self.light_level   = 0.5 + 0.5 * (self.tick_count as f32 * 0.3).sin();

        match action {
            Action::GoToCharger => {
                self.pos    = (self.pos - Self::MOVE_SPEED * 2.0).max(0.0);
                self.stamina = (self.stamina - 0.04).max(0.0);
                if (self.pos - Self::CHARGER_POS).abs() < 0.05 {
                    self.battery = (self.battery + 0.25).min(1.0);
                }
            }
            Action::GoToTarget => {
                let goal = Self::GOAL_POS;
                self.pos = if self.pos < goal {
                    (self.pos + Self::MOVE_SPEED).min(goal)
                } else {
                    (self.pos - Self::MOVE_SPEED).max(goal)
                };
                self.stamina = (self.stamina - 0.0003).max(0.0);
            }
            Action::GoToRandom => {
                self.pos    = (self.pos + (fastrand::f32() - 0.5) * Self::MOVE_SPEED * 2.0).max(0.0).min(1.0);
                self.stamina = (self.stamina - 0.0003).max(0.0);
                self.boredom = (self.boredom - 0.0005).max(0.0);
            }
            Action::Interact => {
                if (self.pos - Self::GOAL_POS).abs() < 0.1 {
                    self.health  = (self.health  + 0.1).min(1.0);
                    self.stamina = (self.stamina - 0.0005).max(0.0);
                }
            }
            Action::PickDrop => {
                self.storage = if self.storage > 0.5 { 0.0 } else { (self.storage + 0.2).min(1.0) };
                self.stamina = (self.stamina - 0.0003).max(0.0);
            }
            Action::Rest => {
                self.stamina = (self.stamina + 0.12).min(1.0);
                self.boredom = (self.boredom + 0.04).min(1.0);
            }
            Action::Scan => {
                self.boredom    = (self.boredom   - 0.0008).max(0.0);
                self.stability  = (self.stability + 0.02).min(1.0);
                self.stamina    = (self.stamina   - 0.0001).max(0.0);
            }
            Action::Build => {
                if (self.pos - Self::BUILD_POS).abs() < 0.1 && self.storage > 0.3 {
                    self.storage   = (self.storage   - 0.002).max(0.0);
                    self.stability = (self.stability + 0.05).min(1.0);
                    self.stamina   = (self.stamina   - 0.0006).max(0.0);
                }
            }
        }

        // Passive decay
        self.battery = (self.battery - 0.0001).max(0.0);
        let health_drain = if self.battery < 0.1 { 0.0005 } else { 0.00002 };
        self.health  = (self.health - health_drain).max(0.0);
        self.boredom = (self.boredom + 0.0001).min(1.0);
        self.stamina = (self.stamina - 0.00005).max(0.0);

        // Danger
        let dist_to_danger  = (self.pos - self.danger_pos).abs();
        let danger_level    = if self.danger_active && dist_to_danger < 0.15 {
            1.0 - dist_to_danger / 0.15
        } else { 0.0 };

        let dist_travelled = (self.pos - prev_pos).abs();

        let reward_delta = if self.reward_history.len() >= 2 {
            let n = self.reward_history.len();
            self.reward_history[n - 1] - self.reward_history[n - 2]
        } else { 0.0 };

        let world: [f32; WORLD_SIZE] = [
            1.0 - (self.pos - Self::CHARGER_POS).abs(),
            1.0 - (self.pos - Self::GOAL_POS).abs(),
            1.0 - (self.pos - Self::BUILD_POS).abs(),
            self.light_level,
            danger_level,
            0.5,
            self.stability,
            if dist_travelled > 0.01 { 1.0 } else { 0.0 },
        ];

        let self_state: [f32; SELF_SIZE] = [
            self.battery,
            self.health,
            self.stamina,
            self.boredom,
            0.3,
            (self.tick_count % 100) as f32 / 100.0,
            self.storage,
            reward_delta.tanh(),
        ];

        (world, self_state, dist_travelled)
    }

    pub fn is_alive(&self) -> bool {
        self.health > 0.0 && self.battery > 0.0
    }

    pub fn status_line(&self) -> String {
        let bar = |v: f32, w: usize| -> String {
            let n = (v * w as f32).round() as usize;
            "▓".repeat(n) + &"░".repeat(w - n)
        };
        let danger_flag = if self.danger_active { " ⚠️ " } else { "    " };
        format!(
            "BAT[{}] HP[{}] STA[{}] BOR[{}]{} pos={:.2}",
            bar(self.battery, 8), bar(self.health, 8),
            bar(self.stamina, 8), bar(self.boredom, 8),
            danger_flag, self.pos
        )
    }
}

// ─── Simulation Loop ──────────────────────────────────────────────────────────

pub type MyBackend = burn::backend::Autodiff<burn::backend::NdArray<f32>>;

pub struct OrganismSim<B: AutodiffBackend> {
    pub brain:       YumonBrain<B>,
    pub world:       WorldSim,
    pub last_action:     Action,
    pub prev_self:       [f32; SELF_SIZE],
    pub tick_num:        u64,
}

impl<B: AutodiffBackend> OrganismSim<B> {
    pub fn new(device: B::Device) -> Self {
        Self {
            brain:       YumonBrain::new(device),
            world:       WorldSim::new(),
            last_action: Action::Scan,
            prev_self:   [0.5f32; SELF_SIZE],
            tick_num:    0,
        }
    }

    /// Run a single tick — observe → reward → infer → apply.
    /// Returns false when the organism has died.
    pub fn tick(&mut self) -> bool {
        if !self.world.is_alive() {
            println!("[Sim] ☠️  Organism died.");
            return false;
        }

        self.tick_num += 1;

        let (world, self_state, dist) = self.world.step(self.last_action);
        let reward = compute_reward(&self.prev_self, &self_state, self.last_action, dist);
        self.world.reward_history.push(reward);

        self.brain.observe(&world, &self_state, self.last_action, reward);

        let result       = self.brain.infer();
        self.last_action = result.action;
        self.brain.last_action = result.action_name;
        self.prev_self   = self_state;

        let danger_flag = if world[WorldIdx::Danger as usize] > DANGER_THRESHOLD { "⚠️ " } else { "   " };
        let rest_flag   = if result.action == Action::Rest { " 💤" } else { "   " };
        let reward_str  = if reward >= 0.0 {
            format!("+{:.3}", reward)
        } else {
            format!("{:.3}", reward)
        };
        let top_prob = result.probabilities[result.action as usize];

        println!(
            "[t={:4}] {}{:12}{} r={:7}  p={:.2}  {}",
            self.tick_num, danger_flag,
            result.action_name, rest_flag,
            reward_str, top_prob,
            self.world.status_line()
        );

        true
    }

    /// Run a sleep session in-place.
    pub fn trigger_sleep(&mut self) {
        println!("\n[Sim] ─────────── SLEEP SESSION ───────────");
        let result = self.brain.sleep_and_wake(SLEEP_EPOCHS);
        println!("[Sim] ─── loss={:.6}  samples={} ───\n", result.final_loss, result.samples_used);
        self.brain.debug_print();
    }

    pub fn last_action_name(&self) -> &'static str {
        self.last_action.name()
    }

    /// Run the full simulation for `max_ticks` ticks, sleeping every `sleep_every` ticks.
    pub fn run(&mut self, max_ticks: u64, sleep_every: u64) {
        println!("╔════════════════════════════════════════════════╗");
        println!("║            YUMON ORGANISM SIM              ║");
        println!("║  Tick: {}ms │ Sleep: every {}t │ Rest = Sleep  ║", TICK_MS, sleep_every);
        println!("╚════════════════════════════════════════════════╝");

        for t in 1..=max_ticks {
            if !self.tick() { break; }
            if t % sleep_every == 0 {
                self.trigger_sleep();
            }
        }

        self.brain.debug_print();
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn build_context(all: &[Experience], i: usize) -> Vec<Moment> {
    let start  = i.saturating_sub(CONTEXT_LEN - 1);
    let slice: Vec<Moment> = all[start..=i].iter().map(|e| e.moment.clone()).collect();
    pad_moments_vec(&slice, CONTEXT_LEN)
}

fn pad_moments_vec(moments: &[Moment], len: usize) -> Vec<Moment> {
    if moments.len() >= len {
        moments[moments.len() - len..].to_vec()
    } else {
        let pad = len - moments.len();
        let mut out: Vec<Moment> = (0..pad).map(|_| Moment::zero()).collect();
        out.extend_from_slice(moments);
        out
    }
}

fn pad_moments_deque(moments: &VecDeque<Moment>, len: usize) -> Vec<Moment> {
    let v: Vec<Moment> = moments.iter().cloned().collect();
    pad_moments_vec(&v, len)
}

fn moments_to_flat(moments: &[Moment]) -> Vec<f32> {
    let mut flat = vec![0.0f32; CONTEXT_LEN * MOMENT_SIZE];
    for (t, m) in moments.iter().enumerate() {
        let base = t * MOMENT_SIZE;
        flat[base..base + WORLD_SIZE].copy_from_slice(&m.world);
        flat[base + WORLD_SIZE..base + MOMENT_SIZE].copy_from_slice(&m.self_);
    }
    flat
}

fn softmax(logits: &[f32]) -> Vec<f32> {
    let max  = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exps: Vec<f32> = logits.iter().map(|l| (l - max).exp()).collect();
    let sum  = exps.iter().sum::<f32>();
    exps.iter().map(|e| e / sum).collect()
}

fn argmax(arr: &[f32]) -> usize {
    arr.iter().enumerate()
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
        .map(|(i, _)| i)
        .unwrap_or(0)
}

fn mk_bar(ratio: f32, width: usize) -> String {
    let n = (ratio.min(1.0) * width as f32).round() as usize;
    format!("[{}]", "█".repeat(n) + &"░".repeat(width - n))
}

// usage: we ensure that we run ticks on render_addon_frame, so it runs in tandem with 3D visual simulation, rather than just calling OrganismSim.run()