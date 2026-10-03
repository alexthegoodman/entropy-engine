#![recursion_limit = "256"]
#![allow(warnings)]

//! Training binary for the DAW action prediction model.
//!
//! Loads sessions produced by gen_daw_data, cuts them into overlapping
//! windows of `--context-len` steps and trains the MoE prediction model with
//! teacher forcing on two targets at every position: the next action (cross
//! entropy) and that action's normalised parameters (masked MSE, weighted by
//! `--param-loss-weight`). With an eval file it reports held-out loss and
//! top-1 / top-3 next-action accuracy after every epoch.
//!
//! Usage:
//!   cargo run --release --bin train_prediction -- \
//!       --data data/daw_sequences.json \
//!       --eval-data data/daw_sequences.eval.json \
//!       --out checkpoints/prediction \
//!       --epochs 20 \
//!       --batch-size 32
//!
//!   # Build one batch, run the forward pass and both losses, then exit
//!   # without an optimiser step or a checkpoint:
//!   cargo run --release --bin train_prediction -- --dry-run

use anyhow::Result;
use burn::{
    backend::Wgpu,
    module::AutodiffModule,
    nn::loss::CrossEntropyLossConfig,
    optim::{AdamWConfig, GradientsParams, Optimizer},
    prelude::*,
    tensor::{Int, TensorData},
};
use clap::Parser;
use indicatif::{ProgressBar, ProgressStyle};
use rand::{rngs::StdRng, seq::SliceRandom, SeedableRng};

use entropy_engine::prediction::{
    daw_actions::*,
    model::{ActionPredictor, BatchBuffers, PredictionMetadata, PredictionModel, PredictionModelConfig},
};

type B = burn::backend::Autodiff<Wgpu>;

#[derive(Parser)]
#[command(name = "train_prediction", about = "Train the DAW action prediction model")]
struct Cli {
    /// Training sessions (from gen_daw_data).
    #[arg(long, default_value = "data/daw_sequences.json")]
    data: String,

    /// Held-out sessions for per-epoch evaluation (optional).
    #[arg(long, default_value = "data/daw_sequences.eval.json")]
    eval_data: String,

    /// Output checkpoint directory.
    #[arg(long, default_value = "checkpoints/prediction")]
    out: String,

    #[arg(long, default_value_t = 20)]
    epochs: usize,

    #[arg(long, default_value_t = 32)]
    batch_size: usize,

    /// Context window (action history the model sees).
    #[arg(long, default_value_t = 48)]
    context_len: usize,

    #[arg(long, default_value_t = 128)]
    embed_dim: usize,

    #[arg(long, default_value_t = 4)]
    n_layers: usize,

    #[arg(long, default_value_t = 4)]
    attn_heads: usize,

    /// FFN hidden dimension (per expert).
    #[arg(long, default_value_t = 256)]
    ff_dim: usize,

    #[arg(long, default_value_t = 4)]
    num_experts: usize,

    #[arg(long, default_value_t = 1)]
    top_k: usize,

    /// Weight of the parameter loss against the action loss.
    #[arg(long, default_value_t = 0.5)]
    param_loss_weight: f64,

    #[arg(long, default_value_t = 3e-4)]
    lr_start: f64,

    #[arg(long, default_value_t = 3e-5)]
    lr_end: f64,

    /// Windows evaluated per epoch.
    #[arg(long, default_value_t = 2048)]
    eval_windows: usize,

    #[arg(long, default_value_t = 42)]
    seed: u64,

    /// Run one batch through the model and the losses, then exit (no training, no checkpoint).
    #[arg(long)]
    dry_run: bool,
}

/// A training window: a session and where in it the window starts.
#[derive(Clone, Copy)]
struct Window { session: usize, start: usize }

/// Overlapping windows (stride half the context) so every position is
/// predicted at least once with a good amount of history behind it.
fn windows(sessions: &[Trajectory], context_len: usize) -> Vec<Window> {
    let stride = (context_len / 2).max(1);
    let mut out = Vec::new();
    for (i, t) in sessions.iter().enumerate() {
        if t.steps.len() < 2 { continue; }
        let mut start = 0;
        loop {
            out.push(Window { session: i, start });
            if start + context_len + 1 >= t.steps.len() { break; }
            start += stride;
        }
    }
    out
}

struct HostBatch {
    inputs: BatchBuffers,
    targets: Vec<i32>,
    target_params: Vec<f32>,
    param_mask: Vec<f32>,
}

/// Inputs are steps [start, start+len), targets the steps one later.
fn host_batch(sessions: &[Trajectory], batch: &[Window], seq: usize) -> HostBatch {
    let mut inputs = BatchBuffers::default();
    let mut targets = Vec::with_capacity(batch.len() * seq);
    let mut target_params = Vec::with_capacity(batch.len() * seq * MAX_ACTION_PARAMS);
    let mut mask = Vec::with_capacity(batch.len() * seq * MAX_ACTION_PARAMS);
    for w in batch {
        let steps = &sessions[w.session].steps;
        let end = (w.start + seq + 1).min(steps.len());
        let slice = &steps[w.start..end];
        let input_len = slice.len() - 1;
        inputs.push_window(&slice[..input_len], seq);
        for i in 0..seq {
            match slice.get(i + 1).filter(|_| i < input_len) {
                Some(t) => {
                    targets.push(t.action_id as i32);
                    target_params.extend_from_slice(&normalize_step_params(t.action_id, &t.params));
                    mask.extend_from_slice(&param_mask(t.action_id));
                }
                None => {
                    targets.push(PAD_ACTION as i32);
                    target_params.extend_from_slice(&[0.0; MAX_ACTION_PARAMS]);
                    mask.extend_from_slice(&[0.0; MAX_ACTION_PARAMS]);
                }
            }
        }
    }
    HostBatch { inputs, targets, target_params, param_mask: mask }
}

/// (total loss, action loss, param loss, aux loss) for one batch.
fn losses<Bk: Backend>(
    model: &PredictionModel<Bk>,
    hb: HostBatch,
    n: usize,
    seq: usize,
    device: &Bk::Device,
) -> (Tensor<Bk, 1>, Tensor<Bk, 1>, Tensor<Bk, 1>, Tensor<Bk, 1>, Tensor<Bk, 2>) {
    let targets = Tensor::<Bk, 2, Int>::from_ints(TensorData::new(hb.targets, [n, seq]), device);
    let target_params = Tensor::<Bk, 3>::from_data(TensorData::new(hb.target_params, [n, seq, MAX_ACTION_PARAMS]), device);
    let mask = Tensor::<Bk, 3>::from_data(TensorData::new(hb.param_mask, [n, seq, MAX_ACTION_PARAMS]), device);

    let (hidden, aux) = model.forward(hb.inputs.into_batch::<Bk>(n, seq, device));
    let logits = model.action_logits(hidden.clone()).reshape([n * seq, ACTION_VOCAB_SIZE]);
    let ce = CrossEntropyLossConfig::new()
        .with_pad_tokens(Some(vec![PAD_ACTION as usize]))
        .init(device);
    let action_loss = ce.forward(logits.clone(), targets.clone().reshape([n * seq]));

    let predicted = model.param_predictions(hidden, targets);
    let diff = (predicted - target_params) * mask.clone();
    let param_loss = diff.powf_scalar(2.0).sum() / (mask.sum() + 1e-6);

    let total = action_loss.clone() + param_loss.clone() * model.config.param_loss_weight + aux.clone();
    (total, action_loss, param_loss, aux, logits)
}

struct EvalReport { loss: f32, top1: f32, top3: f32, param_mse: f32 }

fn evaluate(model: &PredictionModel<Wgpu>, sessions: &[Trajectory], wins: &[Window], cli: &Cli, device: &<Wgpu as Backend>::Device) -> EvalReport {
    let (mut loss, mut pmse, mut batches) = (0.0f32, 0.0f32, 0usize);
    let (mut hits1, mut hits3, mut counted) = (0usize, 0usize, 0usize);
    for chunk in wins.chunks(cli.batch_size) {
        let hb = host_batch(sessions, chunk, cli.context_len);
        let targets = hb.targets.clone();
        let (_, action_loss, param_loss, _, logits) = losses(model, hb, chunk.len(), cli.context_len, device);
        loss += action_loss.to_data().to_vec::<f32>().unwrap()[0];
        pmse += param_loss.to_data().to_vec::<f32>().unwrap()[0];
        batches += 1;
        let rows: Vec<f32> = logits.to_data().to_vec().unwrap();
        for (i, &t) in targets.iter().enumerate() {
            if t == PAD_ACTION as i32 || t >= NUM_DAW_ACTIONS as i32 { continue; }
            let row = &rows[i * ACTION_VOCAB_SIZE..i * ACTION_VOCAB_SIZE + NUM_DAW_ACTIONS];
            let target_logit = row[t as usize];
            let better = row.iter().filter(|&&x| x > target_logit).count();
            if better == 0 { hits1 += 1; }
            if better < 3 { hits3 += 1; }
            counted += 1;
        }
    }
    let b = batches.max(1) as f32;
    let c = counted.max(1) as f32;
    EvalReport { loss: loss / b, top1: hits1 as f32 / c, top3: hits3 as f32 / c, param_mse: pmse / b }
}

fn load_sessions(path: &str) -> Result<Vec<Trajectory>> {
    let data = std::fs::read(path)?;
    let sessions: Vec<Trajectory> = serde_json::from_slice(&data)?;
    if let Some(t) = sessions.iter().find(|t| t.vocab_version != DAW_VOCAB_VERSION) {
        anyhow::bail!("{path} was generated for vocabulary v{}, this build uses v{DAW_VOCAB_VERSION}: rerun gen_daw_data", t.vocab_version);
    }
    Ok(sessions)
}

fn show_plan(model: PredictionModel<Wgpu>, device: &<Wgpu as Backend>::Device) {
    let predictor = ActionPredictor::from_model(model, device.clone());
    let ctx = |view: u32, family: u32| StepContext { family, view, ..StepContext::default() };
    let history = vec![
        ActionStep::with_context(DawAction::SetBpm, &[124.0], ctx(0, 1)),
        ActionStep::with_context(DawAction::OpenView, &[1.0], ctx(1, 1)),
        ActionStep::with_context(DawAction::AddNote, &[0.0, 0.0, 1.0, 0.85], ctx(1, 1)),
        ActionStep::with_context(DawAction::AddNote, &[0.0, 4.0, 1.0, 0.85], ctx(1, 1)),
    ];
    let plan = predictor.predict_plan(&history, None, 5, 0);
    let fmt: Vec<String> = plan.iter().map(|p| {
        let params: Vec<String> = p.params.iter().map(|v| format!("{v:.2}")).collect();
        format!("{}({}) {:.0}%", p.name, params.join(", "), p.confidence * 100.0)
    }).collect();
    println!("  Plan after bpm, piano roll, kick at 0 and 4: {}", fmt.join(" -> "));
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let device = burn::backend::wgpu::WgpuDevice::default();

    let config = PredictionModelConfig::new()
        .with_vocab_size(ACTION_VOCAB_SIZE)
        .with_num_families(NUM_FAMILIES)
        .with_num_views(NUM_VIEWS)
        .with_embed_dim(cli.embed_dim)
        .with_n_layers(cli.n_layers)
        .with_attn_heads(cli.attn_heads)
        .with_ff_dim(cli.ff_dim)
        .with_max_seq_len(cli.context_len)
        .with_num_experts(cli.num_experts)
        .with_top_k(cli.top_k)
        .with_dropout_rate(0.05)
        .with_prediction_depth(5)
        .with_param_loss_weight(cli.param_loss_weight);

    if cli.dry_run {
        // A handful of fresh sessions: no data file needed.
        let sessions = entropy_engine::prediction::daw_sim::generate_sessions(16, cli.seed, entropy_engine::prediction::daw_sim::Split::Train);
        let wins = windows(&sessions, cli.context_len);
        let batch: Vec<Window> = wins.into_iter().take(cli.batch_size).collect();
        let model: PredictionModel<B> = config.init(&device);
        let n = batch.len();
        let (total, action, param, aux, _) = losses(&model, host_batch(&sessions, &batch, cli.context_len), n, cli.context_len, &device);
        let v = |t: Tensor<B, 1>| t.inner().to_data().to_vec::<f32>().unwrap()[0];
        println!("Dry run: {} actions in the vocabulary, batch {n}x{}, loss {:.4} (action {:.4}, param {:.4}, aux {:.4})",
            NUM_DAW_ACTIONS, cli.context_len, v(total), v(action), v(param), v(aux));
        println!("An untrained model's action loss should be near ln({ACTION_VOCAB_SIZE}) = {:.4}.", (ACTION_VOCAB_SIZE as f32).ln());
        show_plan(model.valid(), &device);
        return Ok(());
    }

    println!("Loading sessions from {}", cli.data);
    let sessions = load_sessions(&cli.data)?;
    let train_windows = windows(&sessions, cli.context_len);
    println!("{} sessions, {} windows of {} steps", sessions.len(), train_windows.len(), cli.context_len);
    if train_windows.is_empty() {
        anyhow::bail!("No training windows - check your data file");
    }

    let eval = if std::path::Path::new(&cli.eval_data).exists() {
        let s = load_sessions(&cli.eval_data)?;
        let mut w = windows(&s, cli.context_len);
        w.shuffle(&mut StdRng::seed_from_u64(cli.seed ^ 0xE7A1));
        w.truncate(cli.eval_windows);
        println!("Eval: {} held-out sessions, {} windows", s.len(), w.len());
        Some((s, w))
    } else {
        println!("No eval file at {} - training without held-out evaluation", cli.eval_data);
        None
    };

    println!("\nModel config: {:?}", config);
    let mut model: PredictionModel<B> = config.init(&device);
    let mut optimizer = AdamWConfig::new().with_weight_decay(0.01).init();

    let mut rng = StdRng::seed_from_u64(cli.seed);
    let num_batches = train_windows.len() / cli.batch_size;
    let mut best = f32::INFINITY;

    println!("\nTraining for {} epochs, {} batches/epoch, batch_size={}", cli.epochs, num_batches, cli.batch_size);

    for epoch in 0..cli.epochs {
        let mut order = train_windows.clone();
        order.shuffle(&mut rng);

        let (mut epoch_loss, mut epoch_action, mut epoch_param) = (0.0f32, 0.0f32, 0.0f32);
        let progress = ProgressBar::new(num_batches as u64);
        progress.set_style(
            ProgressStyle::default_bar()
                .template(&format!(
                    "Epoch {}/{} [{{elapsed_precise}}] {{bar:40.cyan/blue}} {{pos}}/{{len}} loss={{msg}}",
                    epoch + 1, cli.epochs
                ))
                .unwrap(),
        );

        for batch_num in 0..num_batches {
            let total_steps = cli.epochs * num_batches;
            let t = (epoch * num_batches + batch_num) as f64 / total_steps as f64;
            let lr = cli.lr_start * (1.0 - t) + cli.lr_end * t;

            let batch = &order[batch_num * cli.batch_size..(batch_num + 1) * cli.batch_size];
            let hb = host_batch(&sessions, batch, cli.context_len);
            let (loss, action_loss, param_loss, _aux, _) = losses(&model, hb, batch.len(), cli.context_len, &device);

            epoch_loss += loss.clone().inner().to_data().to_vec::<f32>().unwrap()[0];
            epoch_action += action_loss.inner().to_data().to_vec::<f32>().unwrap()[0];
            epoch_param += param_loss.inner().to_data().to_vec::<f32>().unwrap()[0];

            let grads = GradientsParams::from_grads(loss.backward(), &model);
            model = optimizer.step(lr, model, grads);

            let k = (batch_num + 1) as f32;
            progress.set_message(format!("{:.4} (action {:.4}, param {:.4})", epoch_loss / k, epoch_action / k, epoch_param / k));
            progress.inc(1);
        }

        let avg = epoch_loss / num_batches.max(1) as f32;
        progress.finish_with_message(format!("{avg:.4}"));
        println!("  Epoch {} train loss {:.4} (action {:.4}, param {:.4})", epoch + 1, avg,
            epoch_action / num_batches.max(1) as f32, epoch_param / num_batches.max(1) as f32);

        let mut meta = PredictionMetadata::from_config(&config);
        meta.epochs_trained = epoch + 1;
        meta.final_loss = avg;
        meta.batch_size = cli.batch_size;
        meta.num_sequences = sessions.len();

        // Checkpoints are chosen on held-out action loss when there is an eval set.
        let mut score = avg;
        if let Some((es, ew)) = &eval {
            let r = evaluate(&model.valid(), es, ew, &cli, &device);
            println!("  Eval loss {:.4}  top-1 {:.1}%  top-3 {:.1}%  param mse {:.4}", r.loss, r.top1 * 100.0, r.top3 * 100.0, r.param_mse);
            meta.eval_top1 = Some(r.top1);
            meta.eval_top3 = Some(r.top3);
            score = r.loss;
        }

        if score < best {
            best = score;
            model.valid().save(&cli.out, &meta)?;
            println!("  Saved best checkpoint ({score:.4})");
        }

        if (epoch + 1) % 5 == 0 || epoch + 1 == cli.epochs {
            show_plan(model.valid(), &device);
        }
    }

    println!("\nTraining complete. Best score: {best:.4}");
    println!("Checkpoint saved to: {}", cli.out);
    Ok(())
}
