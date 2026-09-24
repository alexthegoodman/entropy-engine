//! Compiles a JSON node-graph description (see `ml_graph_demo_addon.ts`) into a real Burn MLP
//! and trains it on a tiny synthetic dataset (XOR / AND / two moons), on a background thread.
//!
//! The interesting part: Burn models are ordinarily static Rust structs (`BrainModel` in
//! `crate::yumon::system` is a fixed LSTM->Dense->heads shape known at compile time). A visual
//! graph editor hands you an arbitrary chain of layers at *runtime*, so the model here is a
//! `Vec<Linear<B>>` instead - `Vec<T: Module<B>>` has a blanket `Module`/`AutodiffModule` impl in
//! burn-core (`burn_core::module::param::primitive`), so a variable-length layer stack still gets
//! real parameter registration, gradient tracking, and (de)serialization for free. The one thing
//! that blanket impl can't carry is the per-layer activation choice (not a `Module` itself) -
//! that rides alongside in `Ignored<Vec<Activation>>`, burn-core's escape hatch for non-tensor
//! metadata living inside a `#[derive(Module)]` struct.
//!
//! Training reuses the exact background-thread/mpsc-channel shape as
//! `crate::yumon::system::BackgroundTrainer`, so a caller polls instead of blocking the UI
//! thread. Unlike that trainer, this one is full-batch (the whole dataset fits in one forward
//! pass), since both supported datasets are a few hundred points at most.

use burn::{
    module::{Ignored, Module},
    nn::{
        loss::CrossEntropyLossConfig,
        Linear, LinearConfig,
    },
    optim::{adaptor::OptimizerAdaptor, Adam, AdamConfig, GradientsParams, Optimizer},
    prelude::*,
    tensor::{backend::AutodiffBackend, Int, Tensor, TensorData},
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;

pub type MlBackend = burn::backend::Autodiff<burn::backend::NdArray<f32>>;

// ─── Graph description (JSON sent from the addon) ─────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum GraphNodeSpec {
    Input { id: String, size: usize },
    Dense { id: String, units: usize, activation: String },
    Loss { id: String },
}

impl GraphNodeSpec {
    fn id(&self) -> &str {
        match self {
            GraphNodeSpec::Input { id, .. } => id,
            GraphNodeSpec::Dense { id, .. } => id,
            GraphNodeSpec::Loss { id } => id,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphLinkSpec {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphSpec {
    pub nodes: Vec<GraphNodeSpec>,
    pub links: Vec<GraphLinkSpec>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum Activation {
    Relu,
    Tanh,
    Sigmoid,
    Linear,
}

impl Activation {
    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "relu" => Ok(Activation::Relu),
            "tanh" => Ok(Activation::Tanh),
            "sigmoid" => Ok(Activation::Sigmoid),
            "linear" => Ok(Activation::Linear),
            other => Err(format!("unknown activation '{other}' (expected relu/tanh/sigmoid/linear)")),
        }
    }

    fn apply<B: Backend>(&self, x: Tensor<B, 2>) -> Tensor<B, 2> {
        match self {
            Activation::Relu => burn::tensor::activation::relu(x),
            Activation::Tanh => burn::tensor::activation::tanh(x),
            Activation::Sigmoid => burn::tensor::activation::sigmoid(x),
            Activation::Linear => x,
        }
    }
}

/// A validated, ordered layer chain - the thing that's actually buildable into a model.
#[derive(Debug)]
pub struct ModelSpec {
    pub input_size: usize,
    /// (in_dim, out_dim, activation) per Dense node, in graph order.
    pub layer_dims: Vec<(usize, usize, Activation)>,
}

/// Walks the graph starting at its one Input node, following the single outgoing link at each
/// node in turn, until it reaches the one Loss node. No branching support: an MLP is a chain,
/// and that constraint is what keeps this a same-session scope instead of a general dataflow
/// compiler (see the post's decision log).
pub fn parse_graph(spec: &GraphSpec) -> Result<ModelSpec, String> {
    if spec.nodes.len() > 128 {
        return Err("graph has more than 128 nodes".to_string());
    }
    let mut by_id = HashMap::new();
    for node in &spec.nodes {
        if node.id().is_empty() || by_id.insert(node.id(), node).is_some() {
            return Err(format!("duplicate or empty node id '{}'", node.id()));
        }
        match node {
            GraphNodeSpec::Input { size, .. } if *size == 0 => return Err("Input size must be positive".to_string()),
            GraphNodeSpec::Dense { units, .. } if *units == 0 => return Err(format!("Dense node '{}' must have positive units", node.id())),
            _ => {}
        }
    }
    let inputs: Vec<&GraphNodeSpec> = spec.nodes.iter().filter(|n| matches!(n, GraphNodeSpec::Input { .. })).collect();
    if inputs.len() != 1 {
        return Err(format!("graph must have exactly one Input node, found {}", inputs.len()));
    }
    let loss_count = spec.nodes.iter().filter(|n| matches!(n, GraphNodeSpec::Loss { .. })).count();
    if loss_count != 1 {
        return Err(format!("graph must have exactly one Loss node, found {loss_count}"));
    }

    let (input_id, input_size) = match inputs[0] {
        GraphNodeSpec::Input { id, size } => (id.clone(), *size),
        _ => unreachable!(),
    };

    let mut outgoing = HashMap::new();
    let mut incoming = HashSet::new();
    for link in &spec.links {
        if !by_id.contains_key(link.from.as_str()) || !by_id.contains_key(link.to.as_str()) {
            return Err(format!("link '{}' -> '{}' references an unknown node", link.from, link.to));
        }
        if outgoing.insert(link.from.as_str(), link.to.as_str()).is_some() {
            return Err(format!("node '{}' has more than one outgoing link; branching is not supported by the MLP trainer", link.from));
        }
        if !incoming.insert(link.to.as_str()) {
            return Err(format!("node '{}' has more than one incoming link", link.to));
        }
    }

    let mut layer_dims = Vec::new();
    let mut current_id = input_id;
    let mut current_size = input_size;
    let mut visited = HashSet::new();

    loop {
        if !visited.insert(current_id.clone()) {
            return Err(format!("cycle reaches node '{current_id}'"));
        }
        let next_id = outgoing
            .get(current_id.as_str())
            .ok_or_else(|| format!("node '{current_id}' has no outgoing link to continue the chain"))?;
        let next = by_id[next_id];

        match next {
            GraphNodeSpec::Dense { id, units, activation } => {
                let act = Activation::parse(activation)?;
                layer_dims.push((current_size, *units, act));
                current_size = *units;
                current_id = id.clone();
            }
            GraphNodeSpec::Loss { id } => {
                visited.insert(id.clone());
                break;
            }
            GraphNodeSpec::Input { .. } => return Err("a link points back into the Input node".to_string()),
        }
    }

    if layer_dims.is_empty() {
        return Err("graph needs at least one Dense node between Input and Loss".to_string());
    }
    if visited.len() != spec.nodes.len() {
        return Err("every node must be connected to the Input -> Loss chain".to_string());
    }
    if spec.links.len() != spec.nodes.len() - 1 {
        return Err("graph must contain only the Input -> Loss chain".to_string());
    }

    Ok(ModelSpec { input_size, layer_dims })
}

// ─── Dynamic model ─────────────────────────────────────────────────────────────

#[derive(Module, Debug)]
pub struct DynamicMlp<B: Backend> {
    layers: Vec<Linear<B>>,
    activations: Ignored<Vec<Activation>>,
}

impl<B: Backend> DynamicMlp<B> {
    pub fn forward(&self, x: Tensor<B, 2>) -> Tensor<B, 2> {
        let mut h = x;
        for (layer, act) in self.layers.iter().zip(self.activations.0.iter()) {
            h = act.apply(layer.forward(h));
        }
        h
    }
}

pub fn build_model<B: Backend>(spec: &ModelSpec, device: &B::Device) -> DynamicMlp<B> {
    let mut layers = Vec::with_capacity(spec.layer_dims.len());
    let mut activations = Vec::with_capacity(spec.layer_dims.len());
    for (in_dim, out_dim, act) in &spec.layer_dims {
        layers.push(LinearConfig::new(*in_dim, *out_dim).init(device));
        activations.push(*act);
    }
    DynamicMlp { layers, activations: Ignored(activations) }
}

// ─── Synthetic datasets ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub enum Dataset {
    Xor,
    And,
    TwoMoons,
}

impl Dataset {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "xor" => Ok(Dataset::Xor),
            "and" => Ok(Dataset::And),
            "two_moons" => Ok(Dataset::TwoMoons),
            other => Err(format!("unknown dataset '{other}' (expected xor/and/two_moons)")),
        }
    }

    pub fn input_size(&self) -> usize {
        2
    }

    pub fn num_classes(&self) -> usize {
        2
    }

    /// Returns (flattened row-major inputs, class labels).
    fn generate(&self, seed: u64) -> (Vec<f32>, Vec<i32>) {
        match self {
            Dataset::Xor => {
                let xs: [[f32; 2]; 4] = [[0.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0, 1.0]];
                let ys: [i32; 4] = [0, 1, 1, 0];
                (xs.iter().flatten().copied().collect(), ys.to_vec())
            }
            Dataset::And => {
                let xs: [[f32; 2]; 4] = [[0.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0, 1.0]];
                let ys: [i32; 4] = [0, 0, 0, 1];
                (xs.iter().flatten().copied().collect(), ys.to_vec())
            }
            Dataset::TwoMoons => {
                use rand::{Rng, SeedableRng};
                let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
                let n_per_class = 100;
                let mut flat = Vec::with_capacity(n_per_class * 2 * 2);
                let mut ys = Vec::with_capacity(n_per_class * 2);

                for _ in 0..n_per_class {
                    // Upper moon: class 0.
                    let t: f32 = rng.gen_range(0.0..std::f32::consts::PI);
                    let x = t.cos() + rng.gen_range(-0.08..0.08);
                    let y = t.sin() + rng.gen_range(-0.08..0.08);
                    flat.push(x);
                    flat.push(y);
                    ys.push(0);
                }
                for _ in 0..n_per_class {
                    // Lower moon: class 1, offset so the two interleave.
                    let t: f32 = rng.gen_range(0.0..std::f32::consts::PI);
                    let x = 1.0 - t.cos() + rng.gen_range(-0.08..0.08);
                    let y = 0.5 - t.sin() + rng.gen_range(-0.08..0.08);
                    flat.push(x);
                    flat.push(y);
                    ys.push(1);
                }
                (flat, ys)
            }
        }
    }
}

// ─── Background trainer ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlTrainingUpdate {
    pub epoch: usize,
    pub total_epochs: usize,
    pub loss: f32,
    pub done: bool,
    pub accuracy: Option<f32>,
}

pub struct MlTrainer {
    rx: Receiver<MlTrainingUpdate>,
}

impl MlTrainer {
    /// Validates and parses the graph synchronously (so malformed-graph errors return to the
    /// caller immediately, not after a thread has already spun up), then trains on its own
    /// thread.
    pub fn start(graph_json: &str, dataset: &str, epochs: usize, lr: f64) -> Result<Self, String> {
        Self::start_seeded(graph_json, dataset, epochs, lr, 42)
    }

    /// Same trainer with an explicit seed for model initialization and generated data.
    pub fn start_seeded(graph_json: &str, dataset: &str, epochs: usize, lr: f64, seed: u64) -> Result<Self, String> {
        if epochs == 0 || epochs > 100_000 {
            return Err("epochs must be between 1 and 100000".to_string());
        }
        if !lr.is_finite() || lr <= 0.0 {
            return Err("learning rate must be finite and positive".to_string());
        }
        let spec: GraphSpec = serde_json::from_str(graph_json).map_err(|e| format!("invalid graph JSON: {e}"))?;
        let model_spec = parse_graph(&spec)?;
        let dataset_name = dataset.to_string();
        let dataset = Dataset::parse(dataset)?;

        if model_spec.input_size != dataset.input_size() {
            return Err(format!(
                "Input node size is {}, but dataset '{}' needs {}",
                model_spec.input_size,
                dataset_name,
                dataset.input_size()
            ));
        }
        let last_out = model_spec.layer_dims.last().unwrap().1;
        if last_out != dataset.num_classes() {
            return Err(format!(
                "final Dense node has {} units, but dataset '{}' has {} classes - the last layer before Loss must match",
                last_out,
                dataset_name,
                dataset.num_classes()
            ));
        }

        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            let device = <MlBackend as Backend>::Device::default();
            MlBackend::seed(&device, seed);
            let mut model = build_model::<MlBackend>(&model_spec, &device);
            let mut optimizer: OptimizerAdaptor<Adam, DynamicMlp<MlBackend>, MlBackend> = AdamConfig::new().init();
            let loss_fn = CrossEntropyLossConfig::new().init::<MlBackend>(&device);

            let (flat_x, ys) = dataset.generate(seed);
            let batch = ys.len();
            let x_t = Tensor::<MlBackend, 2>::from_floats(TensorData::new(flat_x, [batch, model_spec.input_size]), &device);
            let y_t = Tensor::<MlBackend, 1, Int>::from_data(TensorData::new(ys.clone(), [batch]), &device);

            for epoch in 0..epochs {
                let logits = model.forward(x_t.clone());
                let loss = loss_fn.forward(logits, y_t.clone());
                let loss_val: f32 = loss.clone().inner().to_data().to_vec().unwrap()[0];

                let grads = GradientsParams::from_grads(loss.backward(), &model);
                model = optimizer.step(lr, model, grads);

                let done = epoch + 1 == epochs;
                let accuracy = if done {
                    Some(accuracy_of(&model, &x_t, &ys))
                } else {
                    None
                };

                if tx
                    .send(MlTrainingUpdate { epoch: epoch + 1, total_epochs: epochs, loss: loss_val, done, accuracy })
                    .is_err()
                {
                    return;
                }
            }
        });

        Ok(Self { rx })
    }

    /// Drains every update queued since the last poll (usually zero or one - both datasets
    /// train fast enough on CPU that many epochs can land between two JS-side polls).
    pub fn poll(&mut self) -> Vec<MlTrainingUpdate> {
        let mut updates = Vec::new();
        loop {
            match self.rx.try_recv() {
                Ok(u) => updates.push(u),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }
        updates
    }
}

fn accuracy_of(model: &DynamicMlp<MlBackend>, x_t: &Tensor<MlBackend, 2>, ys: &[i32]) -> f32 {
    let logits = model.forward(x_t.clone());
    let dims = logits.dims();
    let (batch, num_classes) = (dims[0], dims[1]);
    let data: Vec<f32> = logits.into_data().to_vec().unwrap();

    let mut correct = 0usize;
    for i in 0..batch {
        let row = &data[i * num_classes..(i + 1) * num_classes];
        let pred = row
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
            .map(|(idx, _)| idx)
            .unwrap_or(0);
        if pred as i32 == ys[i] {
            correct += 1;
        }
    }
    correct as f32 / batch as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain() -> GraphSpec {
        GraphSpec {
            nodes: vec![
                GraphNodeSpec::Input { id: "in".into(), size: 2 },
                GraphNodeSpec::Dense { id: "hidden".into(), units: 8, activation: "relu".into() },
                GraphNodeSpec::Dense { id: "out".into(), units: 2, activation: "linear".into() },
                GraphNodeSpec::Loss { id: "loss".into() },
            ],
            links: vec![
                GraphLinkSpec { from: "in".into(), to: "hidden".into() },
                GraphLinkSpec { from: "hidden".into(), to: "out".into() },
                GraphLinkSpec { from: "out".into(), to: "loss".into() },
            ],
        }
    }

    #[test]
    fn valid_chain_keeps_layer_order() {
        let parsed = parse_graph(&chain()).unwrap();
        assert_eq!(parsed.layer_dims, vec![(2, 8, Activation::Relu), (8, 2, Activation::Linear)]);
    }

    #[test]
    fn cyclic_chain_returns_an_error_instead_of_hanging() {
        let mut graph = chain();
        graph.links[2].to = "hidden".into();
        assert!(parse_graph(&graph).unwrap_err().contains("incoming"));
    }

    #[test]
    fn disconnected_layer_is_rejected() {
        let mut graph = chain();
        graph.nodes.push(GraphNodeSpec::Dense { id: "orphan".into(), units: 4, activation: "relu".into() });
        assert!(parse_graph(&graph).unwrap_err().contains("every node"));
    }

    #[test]
    fn branching_is_rejected() {
        let mut graph = chain();
        graph.links.push(GraphLinkSpec { from: "hidden".into(), to: "loss".into() });
        assert!(parse_graph(&graph).unwrap_err().contains("branching"));
    }

    #[test]
    fn zero_width_is_rejected() {
        let mut graph = chain();
        graph.nodes[1] = GraphNodeSpec::Dense { id: "hidden".into(), units: 0, activation: "relu".into() };
        assert!(parse_graph(&graph).unwrap_err().contains("positive units"));
    }

    #[test]
    fn built_in_datasets_are_small_and_seeded() {
        let (xor_x, xor_y) = Dataset::Xor.generate(42);
        let (and_x, and_y) = Dataset::And.generate(42);
        assert_eq!(xor_x, and_x);
        assert_eq!(xor_y, [0, 1, 1, 0]);
        assert_eq!(and_y, [0, 0, 0, 1]);
        assert_eq!(Dataset::TwoMoons.generate(42), Dataset::TwoMoons.generate(42));
        assert_ne!(Dataset::TwoMoons.generate(42), Dataset::TwoMoons.generate(43));
    }

    #[test]
    fn seeded_training_replays_the_same_loss_curve() {
        const GRAPH: &str = r#"{"nodes":[{"kind":"Input","id":"in","size":2},{"kind":"Dense","id":"hidden","units":8,"activation":"relu"},{"kind":"Dense","id":"out","units":2,"activation":"linear"},{"kind":"Loss","id":"loss"}],"links":[{"from":"in","to":"hidden"},{"from":"hidden","to":"out"},{"from":"out","to":"loss"}]}"#;
        let run = || {
            let mut trainer = MlTrainer::start_seeded(GRAPH, "xor", 30, 0.05, 123).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut losses = Vec::new();
            loop {
                for update in trainer.poll() {
                    losses.push(update.loss);
                    if update.done { return losses; }
                }
                assert!(std::time::Instant::now() < deadline, "seeded trainer stalled");
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        };
        let first = run();
        assert_eq!(first.len(), 30);
        assert_eq!(first, run());
    }
}
