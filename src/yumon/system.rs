/// [YUMON AI SYSTEM] — LSTM NPC brain for the Entropy game engine.
///
/// Architecture:
///   LSTM(256) → Dropout(0.2) → Dense(64, ReLU) → [Button Head: Dense(ACTION_SIZE, linear)]
///                                                  [Rotation Head: Dense(1, tanh)]
///
///   Input:  [batch, CONTEXT_LEN=16, MOMENT_SIZE=24]
///   Output: (button_logits: [batch, ACTION_SIZE], rotation_delta: [batch, 1])
///
/// Training: Behavior Cloning (supervised) from designer play sessions,
///           optionally followed by REINFORCE fine-tuning.
///
/// Actions map 1:1 to controller buttons. Rotation is a continuous f32
/// output handled by a separate regression head (tanh → -1..1).
/// 
/// 

use burn::{
    module::AutodiffModule,
    nn::{
        Dropout, DropoutConfig, Linear, LinearConfig, Lstm, LstmConfig,
    },
    optim::{AdamConfig, GradientsParams, Optimizer, Adam, adaptor::OptimizerAdaptor},
    prelude::*,
    tensor::{
        backend::AutodiffBackend,
        TensorData,
    },
    record::{BinFileRecorder, FullPrecisionSettings, Recorder},
};
use serde::{Serialize, Deserialize};
use rand::seq::SliceRandom;
use rand::thread_rng;
use std::collections::VecDeque;

// ─── Constants ────────────────────────────────────────────────────────────────

pub const WORLD_SIZE: usize      = 16;  // expanded world state
pub const SELF_SIZE: usize       = 8;
pub const MOMENT_SIZE: usize     = WORLD_SIZE + SELF_SIZE; // 24
pub const ACTION_SIZE: usize     = 12;  // discrete button actions
pub const CONTEXT_LEN: usize     = 16; // how many moments per input (16 = 8s, 64 ~ 30s)
pub const MEMORY_CAPACITY: usize = 512; // ~5 minutes
// pub const MEMORY_CAPACITY: usize = 4096; // ~30 minutes of recorded play time supported at 500ms ticks
pub const BATCH_SIZE: usize      = 16; // how many inputs per iteration
pub const SLEEP_EPOCHS: usize    = 4;
pub const DANGER_THRESHOLD: f32  = 0.5;
pub const TICK_MS: u64           = 500;
pub const SLEEP_EVERY_TICKS: u64 = 400; // sleep every 400 ticks (~200s)

// ─── World State Indices ──────────────────────────────────────────────────────

/// Ego-centric relational world state.
/// All distances normalized 0..1. All angles normalized -1..1 (divide by PI).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WorldIdx {
    // Spatial — nearest obstacle
    NearestObstacleDist  = 0,
    NearestObstacleAngle = 1,

    // Spatial — player
    NearestPlayerDist    = 2,
    NearestPlayerAngle   = 3,

    // Spatial — allies
    NearestAllyDist      = 4,
    NearestAllyAngle     = 5,

    // Spatial — threat (projectile / attack)
    NearestThreatDist    = 6,
    NearestThreatAngle   = 7,

    // Cover & navigation
    IsInCover            = 8,   // 0 or 1
    PathClearForward     = 9,   // 0 or 1

    // Crowd awareness
    NearbyEnemyCount     = 10,  // normalized, e.g. count / 10.0
    NearbyAllyCount      = 11,  // normalized

    // Situational
    AlertLevel           = 12,  // 0=calm, 0.5=alerted, 1=combat
    LastDamageAngle      = 13,  // angle of last hit, -1..1
    TimeSincePlayerSeen  = 14,  // normalized 0..1
    LightLevel           = 15,
}

/// Agent self-state indices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SelfIdx {

    HealthPct    = 0,
    StaminaPct   = 1,
    Ammo         = 2,  // normalized 0..1
    IsGrounded   = 3,  // 0 or 1
    IsCrouching  = 4,  // 0 or 1
    Speed        = 5,  // normalized current movement speed
    Clock        = 6,  // tick % 100 / 100.0
    RewardDelta  = 7,
}

// ─── Actions — direct controller button mapping ───────────────────────────────

/// Each variant maps 1:1 to a physical controller input.
/// Rotation is handled separately as a continuous f32 output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Action {
    // Left stick
    MoveForward  = 0,
    MoveBackward = 1,

    // Face buttons
    ButtonA      = 2,  // Jump
    ButtonB      = 3,  // Dodge / Roll
    ButtonX      = 4,  // Attack Light
    ButtonY      = 5,  // Attack Heavy

    // Triggers & bumpers
    LTrigger     = 6,  // Aim / Block
    RTrigger     = 7,  // Ranged Attack / Sprint
    LBumper      = 8,  // Ability 1
    RBumper      = 9,  // Ability 2

    // Body state toggles
    Crouch       = 10,
    Idle         = 11,
}

impl Action {
    pub fn from_usize(v: usize) -> Self {
        match v {
            0  => Action::MoveForward,
            1  => Action::MoveBackward,
            2  => Action::ButtonA,
            3  => Action::ButtonB,
            4  => Action::ButtonX,
            5  => Action::ButtonY,
            6  => Action::LTrigger,
            7  => Action::RTrigger,
            8  => Action::LBumper,
            9  => Action::RBumper,
            10 => Action::Crouch,
            11 => Action::Idle,
            _  => Action::Idle,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Action::MoveForward  => "MoveForward",
            Action::MoveBackward => "MoveBackward",
            Action::ButtonA      => "ButtonA (Jump)",
            Action::ButtonB      => "ButtonB (Dodge)",
            Action::ButtonX      => "ButtonX (Light)",
            Action::ButtonY      => "ButtonY (Heavy)",
            Action::LTrigger     => "LTrigger (Aim)",
            Action::RTrigger     => "RTrigger (Sprint)",
            Action::LBumper      => "LBumper (Ability1)",
            Action::RBumper      => "RBumper (Ability2)",
            Action::Crouch       => "Crouch",
            Action::Idle         => "Idle",
        }
    }
}

// ─── Moment & Experience ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// A recorded designer input frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Experience {
    pub moment:          Moment,
    pub action_taken:    Action,
    pub rotation_delta:  f32,   // -1..1, designer's stick/mouse rotation this tick
    pub reward:          f32,
    pub danger:          f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrganismState {
    Awake,
    Sleeping,
}

// ─── Inference Result ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct InferenceResult {
    pub action:           Action,
    pub action_name:      &'static str,
    pub rotation_delta:   f32,          // -1..1, scale to your turn speed
    pub button_logits:    Vec<f32>,
    pub probabilities:    Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct SleepResult {
    pub epochs_run:   usize,
    pub final_loss:   f32,
    pub samples_used: usize,
}

// ─── Running Normalizer ───────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
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
            let delta   = x[i] - self.mean[i];
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

#[derive(Serialize, Deserialize)]
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
    pub fn get_all(&self) -> Vec<&Experience> { self.buffer.iter().collect() }

    pub fn count_dangerous(&self) -> usize {
        self.buffer.iter().filter(|e| e.danger > DANGER_THRESHOLD).count()
    }
}

// ─── Model Definition — Dual-Head ─────────────────────────────────────────────

/// Shared LSTM backbone → two heads:
///   - button_head:   Dense(ACTION_SIZE) — softmax for discrete button selection
///   - rotation_head: Dense(1)           — tanh for continuous rotation delta
#[derive(Module, Debug)]
pub struct BrainModel<B: Backend> {
    lstm:          Lstm<B>,
    dropout:       Dropout,
    dense_shared:  Linear<B>,   // shared Dense(64, ReLU)
    button_head:   Linear<B>,   // → ACTION_SIZE logits
    rotation_head: Linear<B>,   // → 1 (tanh applied in forward)
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
            lstm:          LstmConfig::new(MOMENT_SIZE, self.lstm_units, false).init(device),
            dropout:       DropoutConfig::new(self.dropout_rate).init(),
            dense_shared:  LinearConfig::new(self.lstm_units, self.hidden_units).init(device),
            button_head:   LinearConfig::new(self.hidden_units, ACTION_SIZE).init(device),
            rotation_head: LinearConfig::new(self.hidden_units, 1).init(device),
        }
    }
}

impl<B: Backend> BrainModel<B> {
    /// Forward pass.
    /// Input:  [batch, CONTEXT_LEN, MOMENT_SIZE]
    /// Output: (button_logits [batch, ACTION_SIZE], rotation_delta [batch, 1])
    pub fn forward(&self, x: Tensor<B, 3>) -> (Tensor<B, 2>, Tensor<B, 2>) {
        let (output_seq, _) = self.lstm.forward(x, None);

        // Take last time-step → [batch, lstm_units]
        let dims    = output_seq.dims();
        let batch   = dims[0];
        let seq_len = dims[1];
        let units   = dims[2];

        let last = output_seq
            .slice([0..batch, seq_len - 1..seq_len, 0..units])
            .reshape([batch, units]);

        let dropped = self.dropout.forward(last);
        let shared  = burn::tensor::activation::relu(self.dense_shared.forward(dropped));

        let button_logits   = self.button_head.forward(shared.clone());
        let rotation_raw    = self.rotation_head.forward(shared);
        let rotation_delta  = burn::tensor::activation::tanh(rotation_raw); // -1..1

        (button_logits, rotation_delta)
    }
}

// ─── Reward ───────────────────────────────────────────────────────────────────

/// Archetype-tunable reward weights.
/// Set aggression_weight high for a berserker, survival_weight high for a coward, etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchetypeRewardWeights {
    pub survival_weight:     f32,
    pub aggression_weight:   f32,
    pub tactical_weight:     f32,
    pub ally_support_weight: f32,
}

impl ArchetypeRewardWeights {
    pub fn balanced() -> Self {
        Self { survival_weight: 1.0, aggression_weight: 1.0, tactical_weight: 1.0, ally_support_weight: 1.0 }
    }
    pub fn berserker() -> Self {
        Self { survival_weight: 0.2, aggression_weight: 2.5, tactical_weight: 0.5, ally_support_weight: 0.3 }
    }
    pub fn coward() -> Self {
        Self { survival_weight: 2.5, aggression_weight: 0.1, tactical_weight: 1.0, ally_support_weight: 0.5 }
    }
    pub fn support() -> Self {
        Self { survival_weight: 1.0, aggression_weight: 0.5, tactical_weight: 1.0, ally_support_weight: 3.0 }
    }
}

pub fn compute_reward(
    prev_self:    &[f32; SELF_SIZE],
    next_self:    &[f32; SELF_SIZE],
    prev_world:   &[f32; WORLD_SIZE],
    next_world:   &[f32; WORLD_SIZE],
    weights:      &ArchetypeRewardWeights,
) -> f32 {
    // Survival
    let health_delta   = next_self[SelfIdx::HealthPct  as usize] - prev_self[SelfIdx::HealthPct  as usize];
    let stamina_delta  = next_self[SelfIdx::StaminaPct as usize] - prev_self[SelfIdx::StaminaPct as usize];
    let survival       = health_delta * 2.0 + stamina_delta.min(0.0) * 0.1;

    // Aggression — reward closing distance to player
    let prev_player_dist = prev_world[WorldIdx::NearestPlayerDist as usize];
    let next_player_dist = next_world[WorldIdx::NearestPlayerDist as usize];
    let aggression       = (prev_player_dist - next_player_dist) * 1.5;

    // Tactical — reward taking cover when threatened
    let in_cover    = next_world[WorldIdx::IsInCover   as usize];
    let alert_level = next_world[WorldIdx::AlertLevel  as usize];
    let threat_near = next_world[WorldIdx::NearestThreatDist as usize] < 0.3;
    let tactical    = if threat_near && in_cover > 0.5 { 1.0 } else { 0.0 };

    // Crowd fear — penalize being surrounded (many nearby enemies while low health)
    let nearby_enemies  = next_world[WorldIdx::NearbyEnemyCount as usize];
    let low_health      = next_self[SelfIdx::HealthPct as usize] < 0.3;
    let crowd_penalty   = if low_health { -nearby_enemies * 0.5 } else { 0.0 };

    // Ally support — reward staying near allies when they are hurt
    let ally_dist   = next_world[WorldIdx::NearestAllyDist as usize];
    let support     = if ally_dist < 0.2 { 0.3 } else { 0.0 };

    weights.survival_weight     * survival
        + weights.aggression_weight   * aggression
        + weights.tactical_weight     * tactical
        + weights.ally_support_weight * support
        + crowd_penalty  // crowd penalty is universal — not weighted by archetype
}

// ─── Loss Functions ───────────────────────────────────────────────────────────

/// Behavior Cloning loss for the button head.
/// Cross-entropy against the designer's recorded action.
fn button_bc_loss<B: AutodiffBackend>(
    logits:       Tensor<B, 2>,  // [1, ACTION_SIZE]
    action_taken: Action,
) -> Tensor<B, 1> {
    let action_idx = action_taken as usize;
    let log_probs  = burn::tensor::activation::log_softmax(logits, 1);
    log_probs
        .slice([0..1, action_idx..action_idx + 1])
        .reshape([1])
        .mul_scalar(-1.0)  // NLL loss
}

/// Behavior Cloning loss for the rotation head.
/// MSE against the designer's recorded rotation delta.
fn rotation_bc_loss<B: AutodiffBackend>(
    rotation_pred: Tensor<B, 2>,  // [1, 1]
    rotation_gt:   f32,
) -> Tensor<B, 1> {
    let diff = rotation_pred.reshape([1]).sub_scalar(rotation_gt);
    diff.clone().mul(diff)  // MSE
}

/// REINFORCE loss for the button head (used during RL fine-tuning).
fn button_reinforce_loss<B: AutodiffBackend>(
    logits:       Tensor<B, 2>,
    action_taken: Action,
    reward:       f32,
) -> Tensor<B, 1> {
    let action_idx = action_taken as usize;
    let log_probs  = burn::tensor::activation::log_softmax(logits, 1);
    log_probs
        .slice([0..1, action_idx..action_idx + 1])
        .reshape([1])
        .mul_scalar((1.0 - reward) * -1.0)
}

// ─── Training Mode ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrainingMode {
    BehaviorCloning,   // supervised from designer recordings
    Reinforce,         // policy gradient fine-tuning
}

// ─── Brain ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct YumonBrainMetadata {
    pub archetype_name: String,
    pub reward_weights: ArchetypeRewardWeights,
    pub training_mode:  TrainingMode,
    pub total_moments:  u64,
    pub sleep_count:    u32,
    pub world_norm:     RunningNorm,
    pub self_norm:      RunningNorm,
}

pub struct YumonBrain<B: AutodiffBackend> {
    pub model:           BrainModel<B>,
    optimizer:           OptimizerAdaptor<Adam, BrainModel<B>, B>,
    buffer:              ExperienceBuffer,
    world_norm:          RunningNorm,
    self_norm:           RunningNorm,
    context_window:      VecDeque<Moment>,
    device:              B::Device,

    pub archetype_name:  String,
    pub reward_weights:  ArchetypeRewardWeights,
    pub training_mode:   TrainingMode,
    pub state:           OrganismState,
    pub total_moments:   u64,
    pub last_reward:     f32,
    pub last_loss:       Option<f32>,
    pub last_action:     &'static str,
    pub last_rotation:   f32,
    pub sleep_count:     u32,
}

impl<B: AutodiffBackend> YumonBrain<B> {
    pub fn new(device: B::Device, archetype_name: &str, reward_weights: ArchetypeRewardWeights) -> Self {
        let config = BrainModelConfig::new();
        Self {
            model:          config.init(&device),
            optimizer:      AdamConfig::new().with_epsilon(1e-7).init(),
            buffer:         ExperienceBuffer::new(),
            world_norm:     RunningNorm::new(WORLD_SIZE),
            self_norm:      RunningNorm::new(SELF_SIZE),
            context_window: VecDeque::with_capacity(CONTEXT_LEN),
            device,
            archetype_name: archetype_name.to_string(),
            reward_weights,
            training_mode:  TrainingMode::BehaviorCloning,
            state:          OrganismState::Awake,
            total_moments:  0,
            last_reward:    0.0,
            last_loss:      None,
            last_action:    "none",
            last_rotation:  0.0,
            sleep_count:    0,
        }
    }

    pub fn save(&self, directory: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
        std::fs::create_dir_all(directory)?;
        
        // 1. Save Model Weights
        let recorder = BinFileRecorder::<FullPrecisionSettings>::new();
        self.model
            .clone()
            .save_file(directory.join("model"), &recorder);

        // 2. Save Metadata
        let metadata = YumonBrainMetadata {
            archetype_name: self.archetype_name.clone(),
            reward_weights: self.reward_weights.clone(),
            training_mode:  self.training_mode,
            total_moments:  self.total_moments,
            sleep_count:    self.sleep_count,
            world_norm:     RunningNorm {
                n:    self.world_norm.n,
                mean: self.world_norm.mean.clone(),
                m2:   self.world_norm.m2.clone(),
                size: self.world_norm.size,
            },
            self_norm: RunningNorm {
                n:    self.self_norm.n,
                mean: self.self_norm.mean.clone(),
                m2:   self.self_norm.m2.clone(),
                size: self.self_norm.size,
            },
        };
        let meta_json = serde_json::to_string_pretty(&metadata)?;
        std::fs::write(directory.join("metadata.json"), meta_json)?;

        // 3. Save Experience Buffer (Recordings)
        let buffer_json = serde_json::to_string_pretty(&self.buffer)?;
        std::fs::write(directory.join("recordings.json"), buffer_json)?;

        Ok(())
    }

    pub fn load(device: B::Device, directory: &std::path::Path) -> Result<Self, Box<dyn std::error::Error>> {
        // 1. Load Metadata
        let meta_json = std::fs::read_to_string(directory.join("metadata.json"))?;
        let metadata: YumonBrainMetadata = serde_json::from_str(&meta_json)?;

        // 2. Initialize Brain
        let mut brain = Self::new(device.clone(), &metadata.archetype_name, metadata.reward_weights);
        brain.training_mode = metadata.training_mode;
        brain.total_moments = metadata.total_moments;
        brain.sleep_count   = metadata.sleep_count;
        brain.world_norm    = metadata.world_norm;
        brain.self_norm     = metadata.self_norm;

        // 3. Load Model Weights
        let recorder = BinFileRecorder::<FullPrecisionSettings>::new();
        let record = recorder.load(directory.join("model").into(), &device)?;
        brain.model = brain.model.load_record(record);

        // 4. Load Recordings (optional if they exist)
        let rec_path = directory.join("recordings.json");
        if rec_path.exists() {
            let buffer_json = std::fs::read_to_string(rec_path)?;
            brain.buffer = serde_json::from_str(&buffer_json)?;
        }

        Ok(brain)
    }

    // ── Observe ────────────────────────────────────────────────────────────────

    pub fn observe(
        &mut self,
        raw_world:       &[f32; WORLD_SIZE],
        raw_self:        &[f32; SELF_SIZE],
        action_taken:    Action,
        rotation_delta:  f32,
        reward:          f32,
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
        let danger = raw_world[WorldIdx::NearestThreatDist as usize];

        self.buffer.push(Experience {
            moment:         moment.clone(),
            action_taken,
            rotation_delta,
            reward,
            danger,
        });

        if self.context_window.len() >= CONTEXT_LEN {
            self.context_window.pop_front();
        }
        self.context_window.push_back(moment);

        self.total_moments += 1;
        self.last_reward    = reward;
    }

    // ── Infer ──────────────────────────────────────────────────────────────────

    pub fn infer(&self) -> InferenceResult {
        assert_eq!(self.state, OrganismState::Awake, "[Brain] Cannot infer while sleeping.");
        assert!(!self.context_window.is_empty(), "[Brain] No context yet.");

        let padded = pad_moments_deque(&self.context_window, CONTEXT_LEN);
        let flat   = moments_to_flat(&padded);

        let input_t = Tensor::<B, 3>::from_floats(
            TensorData::new(flat, [1, CONTEXT_LEN, MOMENT_SIZE]),
            &self.device,
        );

        let model_valid                     = self.model.clone().valid();
        let (button_logits_t, rotation_t)   = model_valid.forward(input_t.inner());

        let button_logits: Vec<f32>  = button_logits_t.to_data().to_vec().unwrap();
        let rotation_raw:  Vec<f32>  = rotation_t.to_data().to_vec().unwrap();

        let probs         = softmax(&button_logits);
        let action_idx    = argmax(&probs);
        let action_enum   = Action::from_usize(action_idx);
        let rotation_out  = rotation_raw[0]; // already tanh'd → -1..1

        InferenceResult {
            action:         action_enum,
            action_name:    action_enum.name(),
            rotation_delta: rotation_out,
            button_logits,
            probabilities:  probs,
        }
    }

    /// Returns an inference result if the brain has enough context.
    /// If context is empty but recordings exist, seeds context from recent recordings first.
    pub fn infer_if_ready(&mut self) -> Option<InferenceResult> {
        if self.state != OrganismState::Awake {
            return None;
        }

        if self.context_window.is_empty() {
            if self.buffer.buffer.is_empty() {
                return None;
            }

            let start = self.buffer.buffer.len().saturating_sub(CONTEXT_LEN);
            for exp in self.buffer.buffer.iter().skip(start) {
                if self.context_window.len() >= CONTEXT_LEN {
                    self.context_window.pop_front();
                }
                self.context_window.push_back(exp.moment.clone());
            }
        }

        Some(self.infer())
    }

    // ── Sleep ──────────────────────────────────────────────────────────────────

    pub fn sleep(&mut self, epochs: usize) -> SleepResult {
        assert_ne!(self.state, OrganismState::Sleeping, "[Brain] Already sleeping.");
        if self.buffer.len() < CONTEXT_LEN {
            eprintln!("[Brain] Not enough experience to sleep yet.");
            return SleepResult { epochs_run: 0, final_loss: 0.0, samples_used: 0 };
        }

        self.state = OrganismState::Sleeping;
        self.sleep_count += 1;

        let all: Vec<Experience> = self.buffer.buffer.iter().cloned().collect();
        println!("[Brain:{}] 💤 Sleep #{} — {} experiences, {} epochs, mode={:?}",
            self.archetype_name, self.sleep_count, all.len(), epochs, self.training_mode);

        let mut final_loss = 0.0f32;

        for epoch in 0..epochs {
            let mut indices: Vec<usize> = (0..all.len()).collect();
            indices.shuffle(&mut thread_rng());

            let mut epoch_loss  = 0.0f32;
            let num_batches     = (indices.len() + BATCH_SIZE - 1) / BATCH_SIZE;

            println!("Epoch: {:?} {:?} {:?}", BATCH_SIZE, epoch, num_batches);

            for batch_start in (0..indices.len()).step_by(BATCH_SIZE) {
                let batch_idx: Vec<usize> = indices[
                    batch_start..(batch_start + BATCH_SIZE).min(indices.len())
                ].to_vec();

                let mut loss_tensors: Vec<Tensor<B, 1>> = Vec::new();
                let mut batch_loss_sum = 0.0f32;

                for &i in &batch_idx {
                    let exp     = &all[i];
                    let context = build_context(&all, i);
                    let flat    = moments_to_flat(&context);

                    let input_t = Tensor::<B, 3>::from_floats(
                        TensorData::new(flat, [1, CONTEXT_LEN, MOMENT_SIZE]),
                        &self.device,
                    );

                    let (button_logits, rotation_pred) = self.model.forward(input_t);

                    let loss = match self.training_mode {
                        TrainingMode::BehaviorCloning => {
                            // println!("Starting loss");
                            // Button head: NLL loss against designer's recorded action
                            let bl = button_bc_loss(button_logits, exp.action_taken);
                            // println!("Continuing loss");
                            // Rotation head: MSE against designer's recorded rotation
                            let rl = rotation_bc_loss(rotation_pred, exp.rotation_delta);
                            // println!("Finishing loss");
                            // Combined — weight rotation slightly lower
                            bl + rl.mul_scalar(0.5)
                        }
                        TrainingMode::Reinforce => {
                            // Button head: REINFORCE
                            let bl = button_reinforce_loss(button_logits, exp.action_taken, exp.reward);
                            // Rotation head: MSE still — no clean REINFORCE formulation for continuous
                            let rl = rotation_bc_loss(rotation_pred, exp.rotation_delta);
                            bl + rl.mul_scalar(0.5)
                        }
                    };

                    let loss_val: Vec<f32> = loss.clone().inner().to_data().to_vec().unwrap();
                    batch_loss_sum += loss_val[0];
                    loss_tensors.push(loss);
                }

                let batch_size_f = batch_idx.len() as f32;
                let total_loss   = loss_tensors.into_iter()
                    .reduce(|a, b| a + b)
                    .unwrap()
                    .div_scalar(batch_size_f);

                let grads   = GradientsParams::from_grads(total_loss.backward(), &self.model);
                self.model  = self.optimizer.step(1e-4, self.model.clone(), grads);

                epoch_loss += batch_loss_sum / batch_size_f;
            }

            final_loss = epoch_loss / num_batches as f32;
            println!("[Brain:{}]   epoch {}/{}  loss={:.6}",
                self.archetype_name, epoch + 1, epochs, final_loss);
        }

        self.last_loss = Some(final_loss);
        SleepResult { epochs_run: epochs, final_loss, samples_used: all.len() }
    }

    pub fn wake(&mut self) {
        if self.state != OrganismState::Sleeping { return; }
        self.state          = OrganismState::Awake;
        self.context_window = VecDeque::with_capacity(CONTEXT_LEN);
        println!("[Brain:{}] 👁️  Awake.", self.archetype_name);
    }

    pub fn sleep_and_wake(&mut self, epochs: usize) -> SleepResult {
        let result = self.sleep(epochs);
        self.wake();
        result
    }

    // ── Debug ──────────────────────────────────────────────────────────────────

    pub fn debug_print(&self) {
        let buf_usage = self.buffer.len() as f32 / MEMORY_CAPACITY as f32;
        let bar       = mk_bar(buf_usage, 20);
        let dangerous = self.buffer.count_dangerous();
        let d_pct     = if self.buffer.len() > 0 { (dangerous * 100) / self.buffer.len() } else { 0 };
        let state_str = match self.state {
            OrganismState::Sleeping => "💤 sleeping",
            OrganismState::Awake    => "👁️  awake",
        };
        let loss_str  = self.last_loss.map(|l| format!("{:.6}", l)).unwrap_or("n/a".into());
        let mode_str  = format!("{:?}", self.training_mode);

        println!("╔═══════════════════════════════════════════╗");
        println!("║       YUMON AI — {:14}          ║", self.archetype_name);
        println!("╠═══════════════════════════════════════════╣");
        println!("║ State      : {:28}║", state_str);
        println!("║ Mode       : {:28}║", mode_str);
        println!("║ Moments    : {:28}║", self.total_moments);
        println!("║ Buffer     : {} {:2}%  ║", bar, (buf_usage * 100.0) as u32);
        println!("║ Dangerous  : {:28}║", format!("{} ({}%)", dangerous, d_pct));
        println!("║ Last Action: {:28}║", self.last_action);
        println!("║ Last Rot Δ : {:28}║", format!("{:.4}", self.last_rotation));
        println!("║ Last Reward: {:28}║", format!("{:.4}", self.last_reward));
        println!("║ Last Loss  : {:28}║", loss_str);
        println!("║ Sleep #    : {:28}║", self.sleep_count);
        println!("╚═══════════════════════════════════════════╝");
    }
}

// ─── Archetype Registry ───────────────────────────────────────────────────────

/// Manages multiple NPC archetypes, each with their own brain.
/// Drop archetypes in here; the sim ticks them in a staggered schedule.
pub struct ArchetypeRegistry<B: AutodiffBackend> {
    pub archetypes:  Vec<YumonBrain<B>>,
    tick_offsets:    Vec<u64>,  // stagger so archetypes don't tick simultaneously
}

impl<B: AutodiffBackend> ArchetypeRegistry<B> {
    pub fn new() -> Self {
        Self { archetypes: Vec::new(), tick_offsets: Vec::new() }
    }

    pub fn register(&mut self, brain: YumonBrain<B>) {
        let offset = self.archetypes.len() as u64;
        self.archetypes.push(brain);
        self.tick_offsets.push(offset);
    }

    /// Returns indices of archetypes that should tick on this global tick number.
    /// Each archetype is offset so they never tick on the same frame.
    pub fn archetypes_ticking_on(&self, global_tick: u64) -> Vec<usize> {
        self.tick_offsets.iter().enumerate()
            .filter(|(_, offset)| &&((global_tick % self.archetypes.len() as u64) as u64) == offset)
            .map(|(i, _)| i)
            .collect()
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn build_context(all: &[Experience], i: usize) -> Vec<Moment> {
    let start = i.saturating_sub(CONTEXT_LEN - 1);
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

// ─── Backend Type Alias ───────────────────────────────────────────────────────

pub type MyBackend = burn::backend::Autodiff<burn::backend::NdArray<f32>>;
