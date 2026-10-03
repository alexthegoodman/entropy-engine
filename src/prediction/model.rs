//! MoE prediction model for DAW next-action prediction.
//!
//! Reuses the SparseMoe router from moe_model.rs, adapted for action-sequence
//! prediction rather than natural language generation. Each timestep is the
//! sum of five embeddings: the action, its normalised parameters, the
//! instrument family of the active track, the view on screen, and a few state
//! scalars (see `StepContext`). Two heads read the transformer's output:
//!
//! - the action head predicts the next action id;
//! - the parameter head predicts that action's parameters, conditioned on the
//!   action chosen (teacher-forced during training), so a suggested "Add Note"
//!   comes with a row and step, and a suggested "Set Gain" with a level.

use super::{
    daw_actions::{
        normalize_step_params, ActionStep, DawAction, StepContext, ACTION_VOCAB_SIZE, BOS_ACTION,
        DAW_VOCAB_VERSION, EOS_ACTION, MAX_ACTION_PARAMS, NUM_DAW_ACTIONS, NUM_FAMILIES, NUM_VIEWS,
        PAD_ACTION, STATE_DIMS,
    },
    nn::{RMSNorm, RMSNormConfig, SparseMoe},
};
use anyhow::Result;
use burn::{
    backend::{ndarray::NdArrayDevice, NdArray, Wgpu},
    module::Ignored,
    nn::{
        Dropout, DropoutConfig, Embedding, EmbeddingConfig, Linear, LinearConfig,
        RotaryEncoding, RotaryEncodingConfig,
    },
    prelude::*,
    record::{BinFileRecorder, FullPrecisionSettings, Recorder},
    tensor::{activation::{gelu, softmax}, TensorData},
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ── Prediction block ──────────────────────────────────────────────────────────

/// A single transformer block with causal self-attention and sparse MoE FFN,
/// structurally identical to MoeBlock in moe_model.rs but defined here to
/// keep the prediction model self-contained.
#[derive(Module, Debug)]
struct PredictionBlock<B: Backend> {
    attn_norm: RMSNorm<B>,
    q: Linear<B>,
    k: Linear<B>,
    v: Linear<B>,
    o: Linear<B>,
    ffn_norm: RMSNorm<B>,
    moe: SparseMoe<B>,
    heads: usize,
}

impl<B: Backend> PredictionBlock<B> {
    fn forward(
        &self,
        x: Tensor<B, 3>,
        rope: &RotaryEncoding<B>,
    ) -> (Tensor<B, 3>, Tensor<B, 1>, Tensor<B, 1>) {
        let [batch, seq, width] = x.dims();
        let device = x.device();
        let hd = width / self.heads;

        let norm = self.attn_norm.forward(x.clone());
        let split =
            |t: Tensor<B, 3>| t.reshape([batch, seq, self.heads, hd]).swap_dims(1, 2);
        let q = rope.forward(split(self.q.forward(norm.clone()))) / (hd as f64).sqrt();
        let k = rope.forward(split(self.k.forward(norm.clone())));
        let v = split(self.v.forward(norm));

        let future = Tensor::<B, 2>::ones([seq, seq], &device).triu(1).bool();
        let mask = future.unsqueeze::<4>();
        let weights = softmax(q.matmul(k.transpose()).mask_fill(mask, -1e9), 3);
        let attn = weights
            .matmul(v)
            .swap_dims(1, 2)
            .reshape([batch, seq, width]);
        let x = x + self.o.forward(attn);

        // Padding sits at the end of a window and is excluded from the loss;
        // causal attention keeps it from influencing earlier positions.
        let flat = self.ffn_norm.forward(x.clone()).reshape([batch * seq, width]);
        let (values, balance, z_loss, _counts) = self.moe.forward(flat);
        let ffn_out = values.reshape([batch, seq, width]);

        (x + ffn_out, balance, z_loss)
    }
}

// ── Batches ───────────────────────────────────────────────────────────────────

/// Model inputs for a batch of action windows.
pub struct PredictionBatch<B: Backend> {
    pub ids: Tensor<B, 2, Int>,
    pub params: Tensor<B, 3>,
    pub families: Tensor<B, 2, Int>,
    pub views: Tensor<B, 2, Int>,
    pub state: Tensor<B, 3>,
}

/// Flat host-side buffers for a batch, built once and turned into tensors.
#[derive(Default)]
pub struct BatchBuffers {
    pub ids: Vec<i32>,
    pub params: Vec<f32>,
    pub families: Vec<i32>,
    pub views: Vec<i32>,
    pub state: Vec<f32>,
}

impl BatchBuffers {
    /// Appends one window, padded with PAD steps to `seq`.
    pub fn push_window(&mut self, window: &[ActionStep], seq: usize) {
        for i in 0..seq {
            match window.get(i) {
                Some(step) => {
                    self.ids.push(step.action_id as i32);
                    self.params.extend_from_slice(&normalize_step_params(step.action_id, &step.params));
                    self.families.push(step.context.family.min(NUM_FAMILIES as u32 - 1) as i32);
                    self.views.push(step.context.view.min(NUM_VIEWS as u32 - 1) as i32);
                    self.state.extend_from_slice(&step.context.state_vector());
                }
                None => {
                    self.ids.push(PAD_ACTION as i32);
                    self.params.extend_from_slice(&[0.0; MAX_ACTION_PARAMS]);
                    self.families.push(0);
                    self.views.push(0);
                    self.state.extend_from_slice(&[0.0; STATE_DIMS]);
                }
            }
        }
    }

    pub fn into_batch<B: Backend>(self, batch: usize, seq: usize, device: &B::Device) -> PredictionBatch<B> {
        PredictionBatch {
            ids: Tensor::from_ints(TensorData::new(self.ids, [batch, seq]), device),
            params: Tensor::from_data(TensorData::new(self.params, [batch, seq, MAX_ACTION_PARAMS]), device),
            families: Tensor::from_ints(TensorData::new(self.families, [batch, seq]), device),
            views: Tensor::from_ints(TensorData::new(self.views, [batch, seq]), device),
            state: Tensor::from_data(TensorData::new(self.state, [batch, seq, STATE_DIMS]), device),
        }
    }
}

// ── Prediction model ──────────────────────────────────────────────────────────

/// Configuration for the action prediction MoE model.
#[derive(Config, Debug)]
pub struct PredictionModelConfig {
    /// Size of the action vocabulary (including sentinels).
    #[config(default = 75)] // ACTION_VOCAB_SIZE
    pub vocab_size: usize,
    /// Instrument families the context embeds.
    #[config(default = 10)] // NUM_FAMILIES
    pub num_families: usize,
    /// Views the context embeds.
    #[config(default = 3)] // NUM_VIEWS
    pub num_views: usize,
    /// Embedding dimension.
    #[config(default = 128)]
    pub embed_dim: usize,
    /// Number of transformer layers.
    #[config(default = 4)]
    pub n_layers: usize,
    /// Number of attention heads.
    #[config(default = 4)]
    pub attn_heads: usize,
    /// FFN hidden dimension (per expert).
    #[config(default = 256)]
    pub ff_dim: usize,
    /// Maximum context window (action history length).
    #[config(default = 48)]
    pub max_seq_len: usize,
    /// Number of MoE experts per layer.
    #[config(default = 4)]
    pub num_experts: usize,
    /// Top-k expert routing.
    #[config(default = 1)]
    pub top_k: usize,
    /// Dropout rate.
    #[config(default = 0.05)]
    pub dropout_rate: f64,
    /// Number of future actions shown as a plan.
    #[config(default = 5)]
    pub prediction_depth: usize,
    /// Auxiliary load-balancing loss weight.
    #[config(default = 0.01)]
    pub aux_loss_weight: f64,
    /// Router z-loss weight.
    #[config(default = 0.001)]
    pub z_loss_weight: f64,
    /// Weight of the parameter regression loss against the action loss.
    #[config(default = 0.5)]
    pub param_loss_weight: f64,
}

impl PredictionModelConfig {
    pub fn init<B: Backend>(&self, device: &B::Device) -> PredictionModel<B> {
        assert!(self.embed_dim % self.attn_heads == 0);
        assert!((self.embed_dim / self.attn_heads) % 2 == 0, "RoPE needs even head width");

        let linear = || {
            LinearConfig::new(self.embed_dim, self.embed_dim)
                .with_bias(false)
                .init(device)
        };

        PredictionModel {
            config: Ignored(self.clone()),
            action_embed: EmbeddingConfig::new(self.vocab_size, self.embed_dim).init(device),
            param_proj: LinearConfig::new(MAX_ACTION_PARAMS, self.embed_dim).with_bias(true).init(device),
            family_embed: EmbeddingConfig::new(self.num_families, self.embed_dim).init(device),
            view_embed: EmbeddingConfig::new(self.num_views, self.embed_dim).init(device),
            state_proj: LinearConfig::new(STATE_DIMS, self.embed_dim).with_bias(true).init(device),
            rope: RotaryEncodingConfig::new(self.max_seq_len, self.embed_dim / self.attn_heads).init(device),
            blocks: (0..self.n_layers)
                .map(|_| PredictionBlock {
                    attn_norm: RMSNormConfig::new(self.embed_dim).init(device),
                    q: linear(),
                    k: linear(),
                    v: linear(),
                    o: linear(),
                    ffn_norm: RMSNormConfig::new(self.embed_dim).init(device),
                    moe: SparseMoe::new(self.embed_dim, self.ff_dim, self.num_experts, self.top_k, device),
                    heads: self.attn_heads,
                })
                .collect(),
            norm: RMSNormConfig::new(self.embed_dim).init(device),
            dropout: DropoutConfig::new(self.dropout_rate).init(),
            action_head: LinearConfig::new(self.embed_dim, self.vocab_size).init(device),
            param_query: EmbeddingConfig::new(self.vocab_size, self.embed_dim).init(device),
            param_hidden: LinearConfig::new(self.embed_dim, self.embed_dim).init(device),
            param_out: LinearConfig::new(self.embed_dim, MAX_ACTION_PARAMS).init(device),
        }
    }
}

/// Sparse MoE transformer for predicting the next DAW actions, and their
/// parameters, from recent semantic action history and application context.
#[derive(Module, Debug)]
pub struct PredictionModel<B: Backend> {
    pub config: Ignored<PredictionModelConfig>,
    action_embed: Embedding<B>,
    param_proj: Linear<B>,
    family_embed: Embedding<B>,
    view_embed: Embedding<B>,
    state_proj: Linear<B>,
    rope: RotaryEncoding<B>,
    blocks: Vec<PredictionBlock<B>>,
    norm: RMSNorm<B>,
    dropout: Dropout,
    pub action_head: Linear<B>,
    param_query: Embedding<B>,
    param_hidden: Linear<B>,
    param_out: Linear<B>,
}

impl<B: Backend> PredictionModel<B> {
    /// Runs the transformer. Returns hidden states [batch, seq, embed] and
    /// the auxiliary MoE loss.
    pub fn forward(&self, batch: PredictionBatch<B>) -> (Tensor<B, 3>, Tensor<B, 1>) {
        let device = batch.ids.device();
        let x = self.action_embed.forward(batch.ids)
            + self.param_proj.forward(batch.params)
            + self.family_embed.forward(batch.families)
            + self.view_embed.forward(batch.views)
            + self.state_proj.forward(batch.state);
        let mut x = self.dropout.forward(x);

        let mut auxiliary = Tensor::zeros([1], &device);
        for block in &self.blocks {
            let (next, balance, z_loss) = block.forward(x, &self.rope);
            x = next;
            auxiliary = auxiliary
                + balance * self.config.aux_loss_weight
                + z_loss * self.config.z_loss_weight;
        }
        (self.norm.forward(x), auxiliary / self.blocks.len() as f64)
    }

    /// Next-action logits [batch, seq, vocab].
    pub fn action_logits(&self, hidden: Tensor<B, 3>) -> Tensor<B, 3> {
        self.action_head.forward(hidden)
    }

    /// Normalised parameters [batch, seq, MAX_ACTION_PARAMS] of `next_ids`,
    /// the action taken after each position.
    pub fn param_predictions(&self, hidden: Tensor<B, 3>, next_ids: Tensor<B, 2, Int>) -> Tensor<B, 3> {
        let q = hidden + self.param_query.forward(next_ids);
        self.param_out.forward(gelu(self.param_hidden.forward(q))).tanh()
    }

    // ── Checkpoint I/O ────────────────────────────────────────────────────

    pub fn save(&self, directory: &str, metadata: &PredictionMetadata) -> Result<()> {
        let dir = Path::new(directory);
        std::fs::create_dir_all(dir)?;
        std::fs::write(dir.join("metadata.json"), serde_json::to_string_pretty(metadata)?)?;
        let recorder = BinFileRecorder::<FullPrecisionSettings>::new();
        self.clone()
            .save_file(dir.join("model"), &recorder)
            .map_err(|e| anyhow::anyhow!("save_file: {e:?}"))?;
        Ok(())
    }

    /// Loads a checkpoint, refusing one trained on another vocabulary.
    pub fn load(directory: &str, device: &B::Device) -> Result<(Self, PredictionModelConfig)> {
        let dir = Path::new(directory);
        let metadata = read_metadata(dir)?;
        check_compatible(&metadata, dir)?;

        let recorder = BinFileRecorder::<FullPrecisionSettings>::new();
        let record = recorder
            .load(dir.join("model").into(), device)
            .map_err(|e| anyhow::anyhow!("load: {e:?}"))?;
        let config = metadata.config();
        let model = config.init::<B>(device).load_record(record);
        Ok((model, config))
    }
}

fn read_metadata(dir: &Path) -> Result<PredictionMetadata> {
    let json = std::fs::read_to_string(dir.join("metadata.json"))
        .map_err(|e| anyhow::anyhow!("no prediction checkpoint at {}: {e}", dir.display()))?;
    Ok(serde_json::from_str(&json)?)
}

fn check_compatible(meta: &PredictionMetadata, dir: &Path) -> Result<()> {
    if meta.vocab_version != DAW_VOCAB_VERSION || meta.vocab_size != ACTION_VOCAB_SIZE {
        anyhow::bail!(
            "the prediction checkpoint at {} was trained on DAW action vocabulary v{} ({} ids); this build uses v{} ({} ids). \
             Regenerate data with gen_daw_data and retrain with train_prediction.",
            dir.display(), meta.vocab_version, meta.vocab_size, DAW_VOCAB_VERSION, ACTION_VOCAB_SIZE
        );
    }
    Ok(())
}

// ── Metadata ──────────────────────────────────────────────────────────────────

fn one() -> u32 { 1 }
fn families_default() -> usize { NUM_FAMILIES }
fn views_default() -> usize { NUM_VIEWS }
fn half() -> f64 { 0.5 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionMetadata {
    /// Absent in checkpoints from before the versioned vocabulary (v1).
    #[serde(default = "one")]
    pub vocab_version: u32,
    pub vocab_size: usize,
    #[serde(default = "families_default")]
    pub num_families: usize,
    #[serde(default = "views_default")]
    pub num_views: usize,
    pub embed_dim: usize,
    pub n_layers: usize,
    pub attn_heads: usize,
    pub ff_dim: usize,
    pub max_seq_len: usize,
    pub num_experts: usize,
    pub top_k: usize,
    pub dropout_rate: f64,
    pub prediction_depth: usize,
    pub aux_loss_weight: f64,
    pub z_loss_weight: f64,
    #[serde(default = "half")]
    pub param_loss_weight: f64,
    pub epochs_trained: usize,
    pub final_loss: f32,
    pub batch_size: usize,
    pub num_sequences: usize,
    /// Held-out next-action accuracy, when the run had an eval set.
    #[serde(default)]
    pub eval_top1: Option<f32>,
    #[serde(default)]
    pub eval_top3: Option<f32>,
}

impl PredictionMetadata {
    pub fn from_config(config: &PredictionModelConfig) -> Self {
        Self {
            vocab_version: DAW_VOCAB_VERSION,
            vocab_size: config.vocab_size,
            num_families: config.num_families,
            num_views: config.num_views,
            embed_dim: config.embed_dim,
            n_layers: config.n_layers,
            attn_heads: config.attn_heads,
            ff_dim: config.ff_dim,
            max_seq_len: config.max_seq_len,
            num_experts: config.num_experts,
            top_k: config.top_k,
            dropout_rate: config.dropout_rate,
            prediction_depth: config.prediction_depth,
            aux_loss_weight: config.aux_loss_weight,
            z_loss_weight: config.z_loss_weight,
            param_loss_weight: config.param_loss_weight,
            epochs_trained: 0,
            final_loss: 0.0,
            batch_size: 0,
            num_sequences: 0,
            eval_top1: None,
            eval_top3: None,
        }
    }

    pub fn config(&self) -> PredictionModelConfig {
        PredictionModelConfig {
            vocab_size: self.vocab_size,
            num_families: self.num_families,
            num_views: self.num_views,
            embed_dim: self.embed_dim,
            n_layers: self.n_layers,
            attn_heads: self.attn_heads,
            ff_dim: self.ff_dim,
            max_seq_len: self.max_seq_len,
            num_experts: self.num_experts,
            top_k: self.top_k,
            dropout_rate: self.dropout_rate,
            prediction_depth: self.prediction_depth,
            aux_loss_weight: self.aux_loss_weight,
            z_loss_weight: self.z_loss_weight,
            param_loss_weight: self.param_loss_weight,
        }
    }
}

// ── High-Level Inference API ──────────────────────────────────────────────────

/// Another action the model considered for a step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AltAction {
    pub action_id: u32,
    pub name: String,
    pub display_name: String,
    pub icon: String,
    pub confidence: f32,
}

/// A predicted action with metadata, predicted parameters (natural units,
/// one per `ParamSpec` of the action) and confidence.
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

/// Action predictor holding a loaded model.
pub struct ActionPredictor<B: Backend = Wgpu> {
    model: PredictionModel<B>,
    pub config: PredictionModelConfig,
    device: B::Device,
}

impl ActionPredictor<Wgpu> {
    pub fn new(directory: &str) -> Result<Self> {
        Self::load(directory, burn::backend::wgpu::WgpuDevice::default())
    }
}

impl<B: Backend> ActionPredictor<B> {
    /// Loads a checkpoint onto `device` of any backend (the record format is backend-neutral).
    pub fn load(directory: &str, device: B::Device) -> Result<Self> {
        let (model, config) = PredictionModel::<B>::load(directory, &device)?;
        Ok(Self { model, config, device })
    }

    pub fn from_model(model: PredictionModel<B>, device: B::Device) -> Self {
        let config = model.config.0.clone();
        Self { model, config, device }
    }

    /// Predicts the next `steps` actions after `history` (oldest first, no
    /// BOS). `current` is the app's context now, used to open the sequence
    /// when there is no history. `alternative` > 0 starts the plan from the
    /// alternative-th most likely first action instead of the most likely, so
    /// "Refresh Plan" gives a genuinely different continuation.
    pub fn predict_plan(
        &self,
        history: &[ActionStep],
        current: Option<StepContext>,
        steps: usize,
        alternative: usize,
    ) -> Vec<PredictedAction> {
        let opening = history.first().map(|s| s.context).or(current).unwrap_or_default();
        let mut seq: Vec<ActionStep> = Vec::with_capacity(history.len() + steps + 1);
        seq.push(ActionStep::bos_with(opening));
        seq.extend(history.iter().filter(|s| s.action_id < NUM_DAW_ACTIONS as u32).cloned());
        let mut ctx = seq.last().map(|s| s.context).unwrap_or_default();
        if let Some(c) = current { ctx = c; }

        let mut plan = Vec::with_capacity(steps);
        for k in 0..steps {
            let start = seq.len().saturating_sub(self.config.max_seq_len);
            let window = &seq[start..];
            let len = window.len();

            let mut buf = BatchBuffers::default();
            buf.push_window(window, len);
            let (hidden, _aux) = self.model.forward(buf.into_batch::<B>(1, len, &self.device));
            let last = hidden.slice([0..1, len - 1..len, 0..self.config.embed_dim]);
            let logits: Vec<f32> = self
                .model
                .action_logits(last.clone())
                .reshape([self.config.vocab_size])
                .to_data()
                .to_vec()
                .unwrap();

            // Probabilities over real actions only: never a sentinel.
            let max = logits[..NUM_DAW_ACTIONS].iter().copied().fold(f32::NEG_INFINITY, f32::max);
            let exps: Vec<f32> = logits[..NUM_DAW_ACTIONS].iter().map(|&x| (x - max).exp()).collect();
            let sum: f32 = exps.iter().sum::<f32>().max(1e-12);
            let mut ranked: Vec<(usize, f32)> = exps.iter().map(|&e| e / sum).enumerate().collect();
            ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

            let pick = if k == 0 { alternative.min(ranked.len() - 1) } else { 0 };
            let (id, prob) = ranked[pick];
            let action = DawAction::from_id(id as u32).expect("ranked over real actions");

            let next = Tensor::<B, 2, Int>::from_ints(TensorData::new(vec![id as i32], [1, 1]), &self.device);
            let norm: Vec<f32> = self
                .model
                .param_predictions(last, next)
                .reshape([MAX_ACTION_PARAMS])
                .to_data()
                .to_vec()
                .unwrap();
            let params = action.denormalize_params(&norm);

            let alternatives = ranked
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != pick)
                .take(3)
                .filter_map(|(_, &(aid, p))| DawAction::from_id(aid as u32).map(|a| AltAction {
                    action_id: aid as u32,
                    name: a.name().to_string(),
                    display_name: a.display_name().to_string(),
                    icon: a.icon().to_string(),
                    confidence: (p * 100.0).round() / 100.0,
                }))
                .collect();

            plan.push(PredictedAction {
                action_id: id as u32,
                name: action.name().to_string(),
                display_name: action.display_name().to_string(),
                category: action.category().to_string(),
                icon: action.icon().to_string(),
                params: params.clone(),
                confidence: (prob * 100.0).round() / 100.0,
                alternatives,
            });

            ctx = ctx.advance(action, &params);
            seq.push(ActionStep::with_context(action, &params, ctx));
        }
        plan
    }
}

// ── Finding and loading the checkpoint ────────────────────────────────────────
//
// The model is optional: a setup without one (none trained yet, not downloaded, an old
// vocabulary) keeps working. `prediction_status` says whether a usable checkpoint is there
// without loading it, and a plan is empty when there is none. A checkpoint that fails to load is
// not retried until its files change, and a panic inside Burn (no GPU adapter, say) is caught and
// reported instead of taking the app down.

/// Overrides where the checkpoint is looked for.
pub const CHECKPOINT_ENV: &str = "ENTROPY_PREDICTION_DIR";

/// What the app can know about the prediction model without loading it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionStatus {
    pub available: bool,
    /// The checkpoint directory found, if any.
    pub checkpoint: Option<String>,
    /// Why the model is not available, or a one-line description of it when it is.
    pub message: String,
    pub vocab_version: u32,
    pub eval_top1: Option<f32>,
    pub eval_top3: Option<f32>,
}

fn has_checkpoint(dir: &Path) -> bool {
    dir.join("metadata.json").is_file() && dir.join("model.bin").is_file()
}

/// The checkpoint directory: `ENTROPY_PREDICTION_DIR` when set, otherwise the first
/// `checkpoints/prediction` (beside the working directory or the executable) that holds both
/// `metadata.json` and `model.bin`.
pub fn resolve_prediction_checkpoint_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var(CHECKPOINT_ENV) {
        let dir = PathBuf::from(dir);
        if has_checkpoint(&dir) {
            return Ok(dir);
        }
        anyhow::bail!("{CHECKPOINT_ENV} is {}, which holds no metadata.json and model.bin", dir.display());
    }
    let mut candidates: Vec<PathBuf> = [
        "checkpoints/prediction",
        "entropy-engine/checkpoints/prediction",
        "../entropy-engine/checkpoints/prediction",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("checkpoints/prediction"));
            // target/<profile>/ -> the crate root.
            candidates.push(parent.join("../../checkpoints/prediction"));
        }
    }
    candidates.into_iter().find(|p| has_checkpoint(p)).ok_or_else(|| {
        anyhow::anyhow!(
            "No prediction model installed: put metadata.json and model.bin in checkpoints/prediction \
             (or set {CHECKPOINT_ENV}). Train one with gen_daw_data and train_prediction."
        )
    })
}

/// Whether a usable checkpoint is installed, without loading its weights. Never waits on a
/// load or an inference in progress.
pub fn prediction_status() -> PredictionStatus {
    let unavailable = |checkpoint: Option<&Path>, message: String| PredictionStatus {
        available: false,
        checkpoint: checkpoint.map(|p| p.display().to_string()),
        message,
        vocab_version: DAW_VOCAB_VERSION,
        eval_top1: None,
        eval_top3: None,
    };
    let dir = match resolve_prediction_checkpoint_dir() {
        Ok(dir) => dir,
        Err(e) => return unavailable(None, e.to_string()),
    };
    let meta = match read_metadata(&dir) {
        Ok(meta) => meta,
        Err(e) => return unavailable(Some(&dir), format!("The prediction checkpoint at {} could not be read: {e}", dir.display())),
    };
    if let Err(e) = check_compatible(&meta, &dir) {
        return unavailable(Some(&dir), e.to_string());
    }
    if let Some(error) = load_failure(&dir, checkpoint_stamp(&dir)) {
        return unavailable(Some(&dir), error);
    }
    PredictionStatus {
        available: true,
        checkpoint: Some(dir.display().to_string()),
        message: format!("Trained {} epochs on {} sessions", meta.epochs_trained, meta.num_sequences),
        vocab_version: meta.vocab_version,
        eval_top1: meta.eval_top1,
        eval_top3: meta.eval_top3,
    }
}

/// Newest modification time of the checkpoint's two files, so a retrain is picked up.
fn checkpoint_stamp(dir: &Path) -> Option<std::time::SystemTime> {
    ["metadata.json", "model.bin"]
        .iter()
        .filter_map(|f| std::fs::metadata(dir.join(f)).and_then(|m| m.modified()).ok())
        .max()
}

fn panic_text(panic: Box<dyn std::any::Any + Send>) -> String {
    panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "unknown panic".to_string())
}

// ── Inference backend ─────────────────────────────────────────────────────────

/// Picks the Burn backend inference runs on: `cpu` (NdArray, the default) or `gpu` (Wgpu).
pub const BACKEND_ENV: &str = "ENTROPY_PREDICTION_BACKEND";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InferenceBackend {
    Cpu,
    Gpu,
}

impl InferenceBackend {
    pub fn from_env() -> Self {
        match std::env::var(BACKEND_ENV).map(|v| v.to_ascii_lowercase()) {
            Ok(v) if v == "gpu" || v == "wgpu" => Self::Gpu,
            _ => Self::Cpu,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Gpu => "gpu",
        }
    }
}

/// A loaded predictor on either backend.
pub enum LoadedPredictor {
    Cpu(ActionPredictor<NdArray>),
    Gpu(ActionPredictor<Wgpu>),
}

impl LoadedPredictor {
    pub fn load(directory: &str, backend: InferenceBackend) -> Result<Self> {
        Ok(match backend {
            InferenceBackend::Cpu => Self::Cpu(ActionPredictor::load(directory, NdArrayDevice::Cpu)?),
            InferenceBackend::Gpu => Self::Gpu(ActionPredictor::new(directory)?),
        })
    }

    pub fn predict_plan(&self, history: &[ActionStep], current: Option<StepContext>, steps: usize, alternative: usize) -> Vec<PredictedAction> {
        match self {
            Self::Cpu(p) => p.predict_plan(history, current, steps, alternative),
            Self::Gpu(p) => p.predict_plan(history, current, steps, alternative),
        }
    }
}

// ── The prediction worker ─────────────────────────────────────────────────────
//
// Loading and inference run on one long-lived thread that owns the predictor, so the UI thread
// never waits on the model: it submits a request (`request_plan`, which returns a ticket at once)
// and picks the result up on a later frame (`poll_plan`). A request that a newer one overtook
// before it started is answered `Superseded` without running, so a burst of edits costs one
// inference. `predict_plan` is the blocking form for tests and tools; it goes through the same
// worker and is never superseded.

/// The last load failure: (checkpoint dir, its stamp, the error). Only ever held for a moment,
/// never across a load or an inference, so `prediction_status` cannot wait on the model.
static LOAD_FAILURE: std::sync::Mutex<Option<(PathBuf, Option<std::time::SystemTime>, String)>> = std::sync::Mutex::new(None);

fn load_failure(dir: &Path, stamp: Option<std::time::SystemTime>) -> Option<String> {
    let guard = LOAD_FAILURE.lock().unwrap_or_else(|p| p.into_inner());
    match guard.as_ref() {
        Some((d, s, error)) if d == dir && *s == stamp => Some(error.clone()),
        _ => None,
    }
}

fn set_load_failure(failure: Option<(PathBuf, Option<std::time::SystemTime>, String)>) {
    *LOAD_FAILURE.lock().unwrap_or_else(|p| p.into_inner()) = failure;
}

/// Where a submitted plan request is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanState {
    /// Queued or running.
    Pending,
    Done,
    Error,
    /// A newer request arrived before this one started; it never ran.
    Superseded,
    /// No such ticket (never issued, or long since forgotten).
    Unknown,
}

/// The answer to `poll_plan`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanPoll {
    pub state: PlanState,
    pub plan: Vec<PredictedAction>,
    pub error: Option<String>,
    /// Time the worker spent on the request (a first request includes loading the model).
    pub elapsed_ms: f32,
}

impl PlanPoll {
    fn state(state: PlanState) -> Self {
        Self { state, plan: Vec::new(), error: None, elapsed_ms: 0.0 }
    }
}

type PlanResult = std::result::Result<Vec<PredictedAction>, String>;

enum Reply {
    Ticket(u64),
    Wait(std::sync::mpsc::Sender<PlanResult>),
}

struct PlanJob {
    checkpoint_dir: Option<PathBuf>,
    history: Vec<ActionStep>,
    current: Option<StepContext>,
    steps: usize,
    alternative: usize,
    reply: Reply,
}

/// Tickets are issued from 1 up; the newest one is the only async request worth running.
static NEXT_TICKET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static LATEST_TICKET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Results by ticket, the most recent `KEPT_RESULTS`, so polling a ticket again is safe.
static RESULTS: std::sync::Mutex<std::collections::BTreeMap<u64, PlanPoll>> = std::sync::Mutex::new(std::collections::BTreeMap::new());
const KEPT_RESULTS: usize = 32;

fn set_result(ticket: u64, poll: PlanPoll) {
    let mut results = RESULTS.lock().unwrap_or_else(|p| p.into_inner());
    results.insert(ticket, poll);
    while results.len() > KEPT_RESULTS {
        results.pop_first();
    }
}

fn worker() -> Option<&'static std::sync::Mutex<std::sync::mpsc::Sender<PlanJob>>> {
    static WORKER: std::sync::OnceLock<Option<std::sync::Mutex<std::sync::mpsc::Sender<PlanJob>>>> = std::sync::OnceLock::new();
    WORKER
        .get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel::<PlanJob>();
            std::thread::Builder::new()
                .name("entropy-prediction".into())
                .spawn(move || {
                    let mut loaded: Option<LoadState> = None;
                    while let Ok(job) = rx.recv() {
                        run_job(&mut loaded, job);
                    }
                })
                .ok()
                .map(|_| std::sync::Mutex::new(tx))
        })
        .as_ref()
}

fn submit(job: PlanJob) -> std::result::Result<(), String> {
    let worker = worker().ok_or_else(|| "the prediction worker thread could not start".to_string())?;
    let tx = worker.lock().unwrap_or_else(|p| p.into_inner());
    tx.send(job).map_err(|_| "the prediction worker has stopped".to_string())
}

struct LoadState {
    predictor: LoadedPredictor,
    dir: PathBuf,
    stamp: Option<std::time::SystemTime>,
    backend: InferenceBackend,
}

fn run_job(loaded: &mut Option<LoadState>, job: PlanJob) {
    if let Reply::Ticket(ticket) = job.reply {
        if ticket < LATEST_TICKET.load(std::sync::atomic::Ordering::Acquire) {
            set_result(ticket, PlanPoll::state(PlanState::Superseded));
            return;
        }
    }
    let started = std::time::Instant::now();
    let result = plan_on_worker(loaded, &job);
    match job.reply {
        Reply::Wait(tx) => {
            let _ = tx.send(result);
        }
        Reply::Ticket(ticket) => {
            let elapsed_ms = started.elapsed().as_secs_f32() * 1000.0;
            let poll = match result {
                Ok(plan) => PlanPoll { state: PlanState::Done, plan, error: None, elapsed_ms },
                Err(error) => PlanPoll { state: PlanState::Error, plan: Vec::new(), error: Some(error), elapsed_ms },
            };
            set_result(ticket, poll);
        }
    }
}

/// Loads (or reloads, when the checkpoint on disk or the backend changes) and predicts. With no
/// checkpoint installed this is an empty plan, not an error; a checkpoint that is there but
/// unusable (old vocabulary, failed load) is an error.
fn plan_on_worker(loaded: &mut Option<LoadState>, job: &PlanJob) -> PlanResult {
    let dir = match &job.checkpoint_dir {
        Some(d) => d.clone(),
        None => match resolve_prediction_checkpoint_dir() {
            Ok(dir) => dir,
            Err(_) => return Ok(Vec::new()),
        },
    };
    let stamp = checkpoint_stamp(&dir);
    let backend = InferenceBackend::from_env();
    if let Some(error) = load_failure(&dir, stamp) {
        return Err(error);
    }
    let fresh = matches!(loaded, Some(s) if s.dir == dir && s.stamp == stamp && s.backend == backend);
    if !fresh {
        *loaded = None;
        let result = std::panic::catch_unwind(|| LoadedPredictor::load(&dir.to_string_lossy(), backend))
            .unwrap_or_else(|panic| Err(anyhow::anyhow!("the prediction model crashed while loading: {}", panic_text(panic))));
        match result {
            Ok(predictor) => {
                set_load_failure(None);
                *loaded = Some(LoadState { predictor, dir, stamp, backend });
            }
            Err(e) => {
                let error = e.to_string();
                set_load_failure(Some((dir, stamp, error.clone())));
                return Err(error);
            }
        }
    }
    let Some(state) = loaded.as_ref() else { unreachable!("the predictor was loaded above") };
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.predictor.predict_plan(&job.history, job.current, job.steps, job.alternative)
    }))
    .map_err(|panic| format!("the prediction model crashed: {}", panic_text(panic)))
}

/// Queues a plan request on the prediction worker and returns its ticket at once. Poll it with
/// `poll_plan`; a newer request supersedes this one if it has not started yet.
pub fn request_plan(
    checkpoint_dir: Option<&str>,
    history: Vec<ActionStep>,
    current: Option<StepContext>,
    steps: usize,
    alternative: usize,
) -> u64 {
    let ticket = NEXT_TICKET.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    LATEST_TICKET.fetch_max(ticket, std::sync::atomic::Ordering::AcqRel);
    set_result(ticket, PlanPoll::state(PlanState::Pending));
    let job = PlanJob {
        checkpoint_dir: checkpoint_dir.map(PathBuf::from),
        history,
        current,
        steps,
        alternative,
        reply: Reply::Ticket(ticket),
    };
    if let Err(error) = submit(job) {
        set_result(ticket, PlanPoll { state: PlanState::Error, plan: Vec::new(), error: Some(error), elapsed_ms: 0.0 });
    }
    ticket
}

/// Where request `ticket` is. Never blocks on the model.
pub fn poll_plan(ticket: u64) -> PlanPoll {
    RESULTS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&ticket)
        .cloned()
        .unwrap_or_else(|| PlanPoll::state(PlanState::Unknown))
}

/// Predicts a plan and waits for it (tests, tools). Runs on the same worker as `request_plan`.
pub fn predict_plan(
    checkpoint_dir: Option<&str>,
    history: &[ActionStep],
    current: Option<StepContext>,
    steps: usize,
    alternative: usize,
) -> Result<Vec<PredictedAction>> {
    let (tx, rx) = std::sync::mpsc::channel();
    submit(PlanJob {
        checkpoint_dir: checkpoint_dir.map(PathBuf::from),
        history: history.to_vec(),
        current,
        steps,
        alternative,
        reply: Reply::Wait(tx),
    })
    .map_err(anyhow::Error::msg)?;
    rx.recv()
        .map_err(|_| anyhow::anyhow!("the prediction worker stopped before answering"))?
        .map_err(anyhow::Error::msg)
}

/// Older entry point: ids (and optional raw params) with no context.
pub fn predict_next_actions(
    checkpoint_dir: Option<&str>,
    context_ids: &[u32],
    context_params: Option<&[[f32; MAX_ACTION_PARAMS]]>,
    steps: usize,
) -> Result<Vec<PredictedAction>> {
    let history: Vec<ActionStep> = context_ids
        .iter()
        .enumerate()
        .filter_map(|(i, &id)| {
            let action = DawAction::from_id(id)?;
            let raw = context_params.and_then(|p| p.get(i)).copied().unwrap_or_else(|| action.default_params());
            Some(ActionStep::new(action, &raw))
        })
        .collect();
    predict_plan(checkpoint_dir, &history, None, steps, 0)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use burn::backend::{Autodiff, Wgpu};
    use burn::optim::{AdamWConfig, GradientsParams, Optimizer};

    type B = Autodiff<Wgpu>;

    fn tiny_config() -> PredictionModelConfig {
        PredictionModelConfig::new()
            .with_vocab_size(ACTION_VOCAB_SIZE)
            .with_embed_dim(16)
            .with_n_layers(2)
            .with_attn_heads(2)
            .with_ff_dim(32)
            .with_max_seq_len(16)
            .with_num_experts(4)
            .with_top_k(1)
            .with_dropout_rate(0.0)
            .with_prediction_depth(3)
    }

    fn sample_steps() -> Vec<ActionStep> {
        vec![
            ActionStep::bos(),
            ActionStep::new(DawAction::SetBpm, &[124.0]),
            ActionStep::new(DawAction::AddTrack, &[1.0]),
            ActionStep::new(DawAction::OpenView, &[1.0]),
            ActionStep::new(DawAction::AddNote, &[0.0, 4.0, 1.0, 0.85]),
        ]
    }

    #[test]
    fn prediction_model_forward_shapes() {
        let device = Default::default();
        let model: PredictionModel<B> = tiny_config().init(&device);
        let mut buf = BatchBuffers::default();
        buf.push_window(&sample_steps(), 6);
        let (hidden, aux) = model.forward(buf.into_batch::<B>(1, 6, &device));
        assert_eq!(model.action_logits(hidden.clone()).dims(), [1, 6, ACTION_VOCAB_SIZE]);
        let next = Tensor::<B, 2, Int>::from_ints([[1, 2, 3, 4, 5, 6]], &device);
        let params = model.param_predictions(hidden, next);
        assert_eq!(params.dims(), [1, 6, MAX_ACTION_PARAMS]);
        let p: Vec<f32> = params.to_data().to_vec().unwrap();
        assert!(p.iter().all(|v| (-1.0..=1.0).contains(v)));
        assert!(aux.to_data().to_vec::<f32>().unwrap()[0].is_finite());
    }

    #[test]
    fn prediction_model_optimizer_step() {
        let device = Default::default();
        let model: PredictionModel<B> = tiny_config().init(&device);
        let mut buf = BatchBuffers::default();
        buf.push_window(&sample_steps(), 5);
        let (hidden, aux) = model.forward(buf.into_batch::<B>(1, 5, &device));
        let next = Tensor::<B, 2, Int>::from_ints([[1, 2, 3, 4, 5]], &device);
        let loss = model.action_logits(hidden.clone()).powf_scalar(2.0).mean()
            + model.param_predictions(hidden, next).powf_scalar(2.0).mean()
            + aux;
        let grads = GradientsParams::from_grads(loss.backward(), &model);
        let mut optimizer = AdamWConfig::new().init();
        let _updated = optimizer.step(1e-3, model, grads);
    }

    #[test]
    fn plan_has_real_actions_with_params_in_range() {
        let device = Default::default();
        let model: PredictionModel<Wgpu> = tiny_config().init(&device);
        let predictor = ActionPredictor::from_model(model, device);
        let history = &sample_steps()[1..];
        let plan = predictor.predict_plan(history, None, 4, 0);
        assert_eq!(plan.len(), 4);
        for p in &plan {
            let action = DawAction::from_id(p.action_id).unwrap();
            assert_eq!(p.params.len(), action.param_count());
            for (v, spec) in p.params.iter().zip(action.params()) {
                assert!(*v >= spec.min && *v <= spec.max, "{} {} = {v}", p.name, spec.name);
            }
            assert!((0.0..=1.0).contains(&p.confidence));
            assert!(p.alternatives.len() <= 3);
        }
        // An alternative plan opens with a different first action.
        let alt = predictor.predict_plan(history, None, 2, 1);
        assert_ne!(alt[0].action_id, plan[0].action_id);
        // An empty history still plans.
        assert_eq!(predictor.predict_plan(&[], Some(StepContext::default()), 3, 0).len(), 3);
    }

    #[test]
    fn prediction_model_checkpoint_roundtrip_and_version_gate() {
        let device = Default::default();
        let config = tiny_config();
        let model: PredictionModel<Wgpu> = config.init(&device);

        let path = std::env::temp_dir().join(format!("entropy-pred-{}", uuid::Uuid::new_v4()));
        let mut meta = PredictionMetadata::from_config(&config);
        meta.epochs_trained = 1;
        model.save(path.to_str().unwrap(), &meta).unwrap();

        let (restored, restored_config) = PredictionModel::<Wgpu>::load(path.to_str().unwrap(), &device).unwrap();
        assert_eq!(restored_config.num_experts, config.num_experts);
        assert_eq!(restored_config.num_families, config.num_families);

        let mut a = BatchBuffers::default();
        a.push_window(&sample_steps(), 5);
        let mut b = BatchBuffers::default();
        b.push_window(&sample_steps(), 5);
        let (h1, _) = model.forward(a.into_batch::<Wgpu>(1, 5, &device));
        let (h2, _) = restored.forward(b.into_batch::<Wgpu>(1, 5, &device));
        let orig: Vec<f32> = model.action_logits(h1).to_data().to_vec().unwrap();
        let rest: Vec<f32> = restored.action_logits(h2).to_data().to_vec().unwrap();
        for (x, y) in orig.iter().zip(rest.iter()) {
            assert!((x - y).abs() < 1e-5, "{x} vs {y}");
        }

        // A checkpoint from the old 32-action vocabulary is refused with a clear message.
        let mut old = meta.clone();
        old.vocab_version = 1;
        old.vocab_size = 35;
        std::fs::write(path.join("metadata.json"), serde_json::to_string(&old).unwrap()).unwrap();
        let err = PredictionModel::<Wgpu>::load(path.to_str().unwrap(), &device).err().unwrap().to_string();
        assert!(err.contains("vocabulary v1"), "{err}");

        std::fs::remove_dir_all(path).unwrap();
    }
}
