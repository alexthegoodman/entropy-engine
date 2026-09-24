//! Executable typed DAGs for the ML Graph architecture editor.
//! Each graph node owns its Burn parameters; links determine the forward pass.

use burn::{
    module::{Ignored, Module},
    nn::{
        Dropout, DropoutConfig, Embedding, EmbeddingConfig, GroupNorm, GroupNormConfig, Linear,
        LinearConfig, Lstm, LstmConfig, PaddingConfig2d, PositionalEncoding,
        PositionalEncodingConfig, RmsNorm, RmsNormConfig,
        attention::{MhaInput, MultiHeadAttention, MultiHeadAttentionConfig},
        conv::{Conv2d, Conv2dConfig},
        loss::CrossEntropyLossConfig,
        transformer::{TransformerEncoder, TransformerEncoderConfig, TransformerEncoderInput},
    },
    optim::{Adam, AdamConfig, GradientsParams, Optimizer, adaptor::OptimizerAdaptor},
    prelude::*,
    tensor::{
        Bool, IndexingUpdateOp, Int, Tensor, TensorData,
        activation::{relu, sigmoid, softmax, tanh},
        backend::AutodiffBackend,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::mpsc::{self, Receiver},
    thread,
};

use crate::ml_graph::MlBackend;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub kind: String,
    pub config: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Link {
    pub from: String,
    pub output: String,
    pub to: String,
    pub input: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Graph {
    pub name: String,
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
}

impl Node {
    fn int(&self, key: &str) -> Result<usize, String> {
        let v = self
            .config
            .get(key)
            .and_then(|v| v.as_u64())
            .ok_or_else(|| format!("{}.{} must be a positive integer", self.id, key))?;
        if v == 0 || v > 16384 {
            return Err(format!("{}.{} is out of range", self.id, key));
        }
        Ok(v as usize)
    }
    fn float(&self, key: &str) -> Result<f64, String> {
        self.config
            .get(key)
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite())
            .ok_or_else(|| format!("{}.{} must be finite", self.id, key))
    }
    fn string(&self, key: &str) -> Result<&str, String> {
        self.config
            .get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("{}.{} must be a string", self.id, key))
    }
}

fn pins(kind: &str) -> Option<(&'static [&'static str], &'static [&'static str])> {
    Some(match kind {
        "SequenceInput" | "TokenInput" | "ImageInput" | "TimestepInput" => (&[], &["out"]),
        "LSTM" => (&["in"], &["sequence"]),
        "LastStep"
        | "Dropout"
        | "Dense"
        | "RMSNorm"
        | "CausalAttention"
        | "Conv2d"
        | "Downsample2d"
        | "SpatialSelfAttention2d"
        | "Upsample2d" => (&["in"], &["out"]),
        "Embedding" | "TextEncoder" => (
            &["tokens"],
            if kind == "TextEncoder" {
                &["context"]
            } else {
                &["out"]
            },
        ),
        "SparseMoE" => (&["in"], &["out", "aux"]),
        "Add" | "Concat2d" => (&["a", "b"], &["out"]),
        "TimeEmbedding" => (&["steps"], &["out"]),
        "ResBlock2d" => (&["in", "time"], &["out"]),
        "CrossAttention2d" => (&["in", "context"], &["out"]),
        "Output" => (&["in"], &[]),
        _ => return None,
    })
}

#[derive(Clone, Debug)]
pub struct Plan {
    order: Vec<usize>,
    inputs: Vec<HashMap<String, (usize, String)>>,
    shapes: HashMap<(usize, String), Vec<usize>>,
    auxiliary: HashSet<(usize, String)>,
    outputs: Vec<usize>,
}

fn shape<'a>(
    shapes: &'a HashMap<(usize, String), Vec<usize>>,
    inputs: &HashMap<String, (usize, String)>,
    pin: &str,
) -> Result<&'a Vec<usize>, String> {
    let (source, output) = inputs
        .get(pin)
        .ok_or_else(|| format!("missing pin {pin}"))?;
    shapes
        .get(&(*source, output.clone()))
        .ok_or_else(|| format!("missing shape for {pin}"))
}

fn expect_rank(s: &[usize], rank: usize, kind: &str) -> Result<(), String> {
    if s.len() != rank {
        Err(format!("{kind} needs rank {rank}, got {s:?}"))
    } else {
        Ok(())
    }
}

/// Validates pins, cycles, reachable outputs and tensor dimensions independently of the editor.
/// Shape vectors omit the symbolic batch axis.
pub fn compile(graph: &Graph) -> Result<Plan, String> {
    if graph.nodes.is_empty() || graph.nodes.len() > 128 || graph.links.len() > 256 {
        return Err("graph exceeds node/link limits".into());
    }
    let mut by_id = HashMap::new();
    for (i, n) in graph.nodes.iter().enumerate() {
        if n.id.is_empty() || by_id.insert(n.id.as_str(), i).is_some() {
            return Err(format!("duplicate or empty node id '{}'", n.id));
        }
        pins(&n.kind).ok_or_else(|| format!("unknown node kind '{}'", n.kind))?;
    }
    let mut inputs = vec![HashMap::new(); graph.nodes.len()];
    let mut outgoing = vec![Vec::new(); graph.nodes.len()];
    for l in &graph.links {
        let &from = by_id
            .get(l.from.as_str())
            .ok_or_else(|| format!("unknown source '{}'", l.from))?;
        let &to = by_id
            .get(l.to.as_str())
            .ok_or_else(|| format!("unknown target '{}'", l.to))?;
        if !pins(&graph.nodes[from].kind)
            .unwrap()
            .1
            .contains(&l.output.as_str())
            || !pins(&graph.nodes[to].kind)
                .unwrap()
                .0
                .contains(&l.input.as_str())
        {
            return Err(format!(
                "invalid link {}.{} -> {}.{}",
                l.from, l.output, l.to, l.input
            ));
        }
        if inputs[to]
            .insert(l.input.clone(), (from, l.output.clone()))
            .is_some()
        {
            return Err(format!("duplicate input {}.{}", l.to, l.input));
        }
        outgoing[from].push(to);
    }
    for (i, n) in graph.nodes.iter().enumerate() {
        for pin in pins(&n.kind).unwrap().0 {
            if !inputs[i].contains_key(*pin) {
                return Err(format!("{}.{} is unconnected", n.id, pin));
            }
        }
    }
    let outputs: Vec<_> = graph
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.kind == "Output")
        .map(|(i, _)| i)
        .collect();
    if outputs.is_empty() {
        return Err("graph needs an Output node".into());
    }
    let mut indegree: Vec<_> = inputs.iter().map(HashMap::len).collect();
    let mut ready: Vec<_> = indegree
        .iter()
        .enumerate()
        .filter(|(_, d)| **d == 0)
        .map(|(i, _)| i)
        .collect();
    let mut order = Vec::new();
    while let Some(i) = ready.pop() {
        order.push(i);
        for &j in &outgoing[i] {
            indegree[j] -= 1;
            if indegree[j] == 0 {
                ready.push(j);
            }
        }
    }
    if order.len() != graph.nodes.len() {
        return Err("graph contains a cycle".into());
    }
    let mut reaches = vec![false; graph.nodes.len()];
    let mut stack = outputs.clone();
    while let Some(i) = stack.pop() {
        if reaches[i] {
            continue;
        }
        reaches[i] = true;
        stack.extend(inputs[i].values().map(|v| v.0));
    }
    if reaches.iter().any(|x| !x) {
        return Err("every node must reach an Output".into());
    }
    let mut shapes = HashMap::new();
    let mut auxiliary = HashSet::new();
    for &i in &order {
        let n = &graph.nodes[i];
        let x = if inputs[i].contains_key("in") {
            Some(shape(&shapes, &inputs[i], "in")?.clone())
        } else {
            None
        };
        let output = match n.kind.as_str() {
            "SequenceInput" => vec![n.int("steps")?, n.int("features")?],
            "TokenInput" => vec![n.int("steps")?],
            "ImageInput" => vec![n.int("channels")?, n.int("height")?, n.int("width")?],
            "TimestepInput" => vec![],
            "LSTM" => {
                let x = x.as_ref().unwrap();
                expect_rank(x, 2, "LSTM")?;
                vec![x[0], n.int("hidden")?]
            }
            "LastStep" => {
                let x = x.as_ref().unwrap();
                expect_rank(x, 2, "LastStep")?;
                vec![x[1]]
            }
            "Dropout" => {
                let p = n.float("probability")?;
                if !(0.0..1.0).contains(&p) {
                    return Err(format!("{} probability must be in [0,1)", n.id));
                }
                x.unwrap()
            }
            "Dense" => {
                let mut x = x.unwrap();
                if x.len() != 1 && x.len() != 2 {
                    return Err(format!("{} Dense needs rank 2 or 3", n.id));
                }
                if !["relu", "tanh", "sigmoid", "linear"].contains(&n.string("activation")?) {
                    return Err(format!("{} unknown activation", n.id));
                }
                *x.last_mut().unwrap() = n.int("units")?;
                x
            }
            "Embedding" | "TextEncoder" => {
                let mut x = shape(&shapes, &inputs[i], "tokens")?.clone();
                expect_rank(&x, 1, &n.kind)?;
                n.int("vocabSize")?;
                if n.kind == "TextEncoder" {
                    n.int("layers")?;
                    let heads = n.int("heads")?;
                    if n.int("width")? % heads != 0 {
                        return Err(format!("{} width must be divisible by heads", n.id));
                    }
                }
                x.push(n.int("width")?);
                x
            }
            "RMSNorm" => {
                let x = x.unwrap();
                if x.len() != 1 && x.len() != 2 {
                    return Err(format!("{} RMSNorm needs rank 2 or 3", n.id));
                }
                x
            }
            "CausalAttention" => {
                let x = x.unwrap();
                expect_rank(&x, 2, "CausalAttention")?;
                if x[1] % n.int("heads")? != 0 {
                    return Err(format!("{} width must be divisible by heads", n.id));
                }
                x
            }
            "SparseMoE" => {
                let x = x.unwrap();
                expect_rank(&x, 2, "SparseMoE")?;
                let experts = n.int("experts")?;
                if n.int("topK")? > experts {
                    return Err(format!("{} topK exceeds experts", n.id));
                }
                n.int("hidden")?;
                shapes.insert((i, "aux".into()), vec![1]);
                auxiliary.insert((i, "aux".into()));
                x
            }
            "Add" => {
                let a = shape(&shapes, &inputs[i], "a")?;
                let b = shape(&shapes, &inputs[i], "b")?;
                if a != b {
                    return Err(format!("{} Add shape mismatch", n.id));
                }
                let a_aux = auxiliary.contains(inputs[i].get("a").unwrap());
                let b_aux = auxiliary.contains(inputs[i].get("b").unwrap());
                if a_aux != b_aux {
                    return Err(format!(
                        "{} cannot mix auxiliary scalar and batched tensor",
                        n.id
                    ));
                }
                if a_aux {
                    auxiliary.insert((i, "out".into()));
                }
                a.clone()
            }
            "TimeEmbedding" => {
                expect_rank(shape(&shapes, &inputs[i], "steps")?, 0, "TimeEmbedding")?;
                let width = n.int("width")?;
                if width % 2 != 0 {
                    return Err(format!("{} width must be even", n.id));
                }
                vec![width]
            }
            "Conv2d" | "ResBlock2d" => {
                let x = x.unwrap();
                expect_rank(&x, 3, &n.kind)?;
                if n.kind == "ResBlock2d" {
                    expect_rank(shape(&shapes, &inputs[i], "time")?, 1, "ResBlock2d time")?;
                }
                vec![n.int("channels")?, x[1], x[2]]
            }
            "Downsample2d" => {
                let x = x.unwrap();
                expect_rank(&x, 3, "Downsample2d")?;
                if x[1] % 2 != 0 || x[2] % 2 != 0 {
                    return Err(format!("{} height and width must be even", n.id));
                }
                vec![x[0], x[1] / 2, x[2] / 2]
            }
            "SpatialSelfAttention2d" | "CrossAttention2d" => {
                let x = x.unwrap();
                expect_rank(&x, 3, &n.kind)?;
                if x[0] % n.int("heads")? != 0 {
                    return Err(format!("{} channels must be divisible by heads", n.id));
                }
                if n.kind == "CrossAttention2d" {
                    expect_rank(
                        shape(&shapes, &inputs[i], "context")?,
                        2,
                        "CrossAttention2d context",
                    )?;
                }
                x
            }
            "Upsample2d" => {
                let x = x.unwrap();
                expect_rank(&x, 3, "Upsample2d")?;
                vec![x[0], x[1] * 2, x[2] * 2]
            }
            "Concat2d" => {
                let a = shape(&shapes, &inputs[i], "a")?;
                let b = shape(&shapes, &inputs[i], "b")?;
                expect_rank(a, 3, "Concat2d")?;
                expect_rank(b, 3, "Concat2d")?;
                if a[1..] != b[1..] {
                    return Err(format!("{} Concat2d spatial mismatch", n.id));
                }
                vec![a[0] + b[0], a[1], a[2]]
            }
            "Output" => shape(&shapes, &inputs[i], "in")?.clone(),
            _ => unreachable!(),
        };
        if output.iter().fold(1usize, |a, &b| a.saturating_mul(b)) > 1_000_000 {
            return Err(format!("{} tensor too large", n.id));
        }
        let pin = match n.kind.as_str() {
            "LSTM" => "sequence",
            "TextEncoder" => "context",
            "Output" => continue,
            _ => "out",
        };
        shapes.insert((i, pin.into()), output);
    }
    Ok(Plan {
        order,
        inputs,
        shapes,
        auxiliary,
        outputs,
    })
}

#[derive(Module, Debug)]
struct TimeNode<B: Backend> {
    first: Linear<B>,
    second: Linear<B>,
}
impl<B: Backend> TimeNode<B> {
    fn forward(&self, steps: Tensor<B, 1, Int>) -> Tensor<B, 2> {
        let values: Vec<i64> = steps.clone().into_data().to_vec().expect("timestep data");
        let width = self.first.weight.dims()[1];
        let mut encoded = Vec::with_capacity(values.len() * width);
        for value in values {
            for i in 0..width / 2 {
                let angle = value as f32 / 10000f32.powf(2.0 * i as f32 / width as f32);
                encoded.push(angle.sin());
                encoded.push(angle.cos());
            }
        }
        let x = Tensor::from_floats(
            TensorData::new(encoded, [steps.dims()[0], width]),
            &steps.device(),
        );
        self.second.forward(relu(self.first.forward(x)))
    }
}

#[derive(Module, Debug)]
struct TextNode<B: Backend> {
    embedding: Embedding<B>,
    pos: PositionalEncoding<B>,
    transformer: TransformerEncoder<B>,
    projection: Linear<B>,
}
impl<B: Backend> TextNode<B> {
    fn forward(&self, tokens: Tensor<B, 2, Int>) -> Tensor<B, 3> {
        let x = self.pos.forward(self.embedding.forward(tokens));
        self.projection
            .forward(self.transformer.forward(TransformerEncoderInput::new(x)))
    }
}

#[derive(Module, Debug)]
struct MoeNode<B: Backend> {
    router: Linear<B>,
    first: Vec<Linear<B>>,
    second: Vec<Linear<B>>,
    top_k: Ignored<usize>,
}
impl<B: Backend> MoeNode<B> {
    fn forward(&self, x: Tensor<B, 3>) -> (Tensor<B, 3>, Tensor<B, 1>) {
        let [batch, steps, width] = x.dims();
        let experts = self.first.len();
        let logits = self
            .router
            .forward(x.clone())
            .reshape([batch * steps, experts]);
        let probabilities = softmax(logits.clone(), 1);
        let ids: Vec<i64> = logits
            .clone()
            .detach()
            .topk_with_indices(self.top_k.0, 1)
            .1
            .into_data()
            .to_vec()
            .expect("router choices");
        let mut rows = vec![Vec::<i32>::new(); experts];
        let mut counts = vec![0f32; experts];
        for (row, chosen) in ids.chunks(self.top_k.0).enumerate() {
            for &id in chosen {
                let id = id as usize;
                rows[id].push(row as i32);
                counts[id] += 1.0;
            }
        }
        let balance = (probabilities.clone().mean_dim(0)
            * Tensor::from_floats(
                TensorData::new(
                    counts
                        .iter()
                        .map(|c| c / (batch * steps * self.top_k.0) as f32)
                        .collect::<Vec<_>>(),
                    [1, experts],
                ),
                &x.device(),
            ))
        .sum()
            * experts as f64;
        let z = burn::tensor::activation::log_softmax(logits.clone(), 1);
        let log_z = logits.slice([0..batch * steps, 0..1]) - z.slice([0..batch * steps, 0..1]);
        let aux = (balance + log_z.powf_scalar(2.0).mean()).reshape([1]);
        let device = x.device();
        let mut output = Tensor::<B, 2>::zeros([batch * steps, width], &device);
        let flat = x.reshape([batch * steps, width]);
        for i in 0..experts {
            if rows[i].is_empty() {
                continue;
            }
            let count = rows[i].len();
            let index =
                Tensor::<B, 1, Int>::from_data(TensorData::new(rows[i].clone(), [count]), &device);
            let selected = flat.clone().select(0, index.clone());
            let gate = probabilities
                .clone()
                .select(0, index.clone())
                .slice([0..count, i..i + 1]);
            let value = self.second[i].forward(relu(self.first[i].forward(selected))) * gate;
            output = output.select_assign(0, index, value, IndexingUpdateOp::Add);
        }
        (output.reshape([batch, steps, width]), aux)
    }
}

#[derive(Module, Debug)]
struct ResNode<B: Backend> {
    norm1: GroupNorm<B>,
    conv1: Conv2d<B>,
    time: Linear<B>,
    norm2: GroupNorm<B>,
    conv2: Conv2d<B>,
    residual: Option<Conv2d<B>>,
}
impl<B: Backend> ResNode<B> {
    fn forward(&self, x: Tensor<B, 4>, t: Tensor<B, 2>) -> Tensor<B, 4> {
        let skip = match &self.residual {
            Some(conv) => conv.forward(x.clone()),
            None => x.clone(),
        };
        let h = self.conv1.forward(relu(self.norm1.forward(x)));
        let [b, c, height, width] = h.dims();
        let bias = self
            .time
            .forward(t)
            .reshape([b, c, 1, 1])
            .repeat(&[1, 1, height, width]);
        self.conv2.forward(relu(self.norm2.forward(h + bias))) + skip
    }
}

#[derive(Module, Debug)]
struct ImageAttention<B: Backend> {
    attention: MultiHeadAttention<B>,
    context: Option<Linear<B>>,
}
impl<B: Backend> ImageAttention<B> {
    fn forward(&self, x: Tensor<B, 4>, context: Option<Tensor<B, 3>>) -> Tensor<B, 4> {
        let [b, c, h, w] = x.dims();
        let flat = x
            .clone()
            .swap_dims(1, 2)
            .swap_dims(2, 3)
            .reshape([b, h * w, c]);
        let input = match context {
            Some(context) => {
                let context = self
                    .context
                    .as_ref()
                    .expect("context projection")
                    .forward(context);
                MhaInput::new(flat.clone(), context.clone(), context)
            }
            None => MhaInput::self_attn(flat),
        };
        let attended = self
            .attention
            .forward(input)
            .context
            .reshape([b, h, w, c])
            .swap_dims(2, 3)
            .swap_dims(1, 2);
        x + attended
    }
}

#[derive(Module, Debug)]
struct Operator<B: Backend> {
    lstm: Option<Lstm<B>>,
    dropout: Option<Dropout>,
    dense: Option<Linear<B>>,
    embedding: Option<Embedding<B>>,
    norm: Option<RmsNorm<B>>,
    attention: Option<MultiHeadAttention<B>>,
    moe: Option<MoeNode<B>>,
    time: Option<TimeNode<B>>,
    text: Option<TextNode<B>>,
    conv: Option<Conv2d<B>>,
    res: Option<ResNode<B>>,
    image_attention: Option<ImageAttention<B>>,
}
impl<B: Backend> Operator<B> {
    fn empty() -> Self {
        Self {
            lstm: None,
            dropout: None,
            dense: None,
            embedding: None,
            norm: None,
            attention: None,
            moe: None,
            time: None,
            text: None,
            conv: None,
            res: None,
            image_attention: None,
        }
    }
}

#[derive(Clone, Debug)]
enum Value<B: Backend> {
    Float1(Tensor<B, 1>),
    Float2(Tensor<B, 2>),
    Float3(Tensor<B, 3>),
    Float4(Tensor<B, 4>),
    Int1(Tensor<B, 1, Int>),
    Int2(Tensor<B, 2, Int>),
}

#[derive(Module, Debug)]
pub struct Model<B: Backend> {
    operators: Vec<Operator<B>>,
    graph: Ignored<Graph>,
    plan: Ignored<Plan>,
}

fn groups(channels: usize) -> usize {
    (1..=8).rev().find(|g| channels % g == 0).unwrap_or(1)
}
fn conv<B: Backend>(
    input: usize,
    output: usize,
    kernel: usize,
    stride: usize,
    padding: usize,
    device: &B::Device,
) -> Conv2d<B> {
    Conv2dConfig::new([input, output], [kernel, kernel])
        .with_stride([stride, stride])
        .with_padding(PaddingConfig2d::Explicit(padding, padding))
        .init(device)
}

pub fn build<B: Backend>(graph: Graph, plan: Plan, device: &B::Device) -> Result<Model<B>, String> {
    let mut operators = Vec::with_capacity(graph.nodes.len());
    for (i, n) in graph.nodes.iter().enumerate() {
        let input = |pin| shape(&plan.shapes, &plan.inputs[i], pin).map(|x| x.clone());
        let op = match n.kind.as_str() {
            "LSTM" => Operator {
                lstm: Some(LstmConfig::new(input("in")?[1], n.int("hidden")?, true).init(device)),
                ..Operator::empty()
            },
            "Dropout" => Operator {
                dropout: Some(DropoutConfig::new(n.float("probability")?).init()),
                ..Operator::empty()
            },
            "Dense" => Operator {
                dense: Some(
                    LinearConfig::new(*input("in")?.last().unwrap(), n.int("units")?).init(device),
                ),
                ..Operator::empty()
            },
            "Embedding" => Operator {
                embedding: Some(
                    EmbeddingConfig::new(n.int("vocabSize")?, n.int("width")?).init(device),
                ),
                ..Operator::empty()
            },
            "RMSNorm" => Operator {
                norm: Some(RmsNormConfig::new(*input("in")?.last().unwrap()).init(device)),
                ..Operator::empty()
            },
            "CausalAttention" => Operator {
                attention: Some(
                    MultiHeadAttentionConfig::new(input("in")?[1], n.int("heads")?)
                        .with_dropout(0.0)
                        .init(device),
                ),
                ..Operator::empty()
            },
            "SparseMoE" => {
                let width = input("in")?[1];
                let experts = n.int("experts")?;
                let hidden = n.int("hidden")?;
                Operator {
                    moe: Some(MoeNode {
                        router: LinearConfig::new(width, experts).init(device),
                        first: (0..experts)
                            .map(|_| LinearConfig::new(width, hidden).init(device))
                            .collect(),
                        second: (0..experts)
                            .map(|_| LinearConfig::new(hidden, width).init(device))
                            .collect(),
                        top_k: Ignored(n.int("topK")?),
                    }),
                    ..Operator::empty()
                }
            }
            "TimeEmbedding" => {
                let width = n.int("width")?;
                Operator {
                    time: Some(TimeNode {
                        first: LinearConfig::new(width, width).init(device),
                        second: LinearConfig::new(width, width).init(device),
                    }),
                    ..Operator::empty()
                }
            }
            "TextEncoder" => {
                let width = n.int("width")?;
                Operator {
                    text: Some(TextNode {
                        embedding: EmbeddingConfig::new(n.int("vocabSize")?, width).init(device),
                        pos: PositionalEncodingConfig::new(width)
                            .with_max_sequence_size(input("tokens")?[0])
                            .init(device),
                        transformer: TransformerEncoderConfig::new(
                            width,
                            width * 4,
                            n.int("heads")?,
                            n.int("layers")?,
                        )
                        .with_dropout(0.0)
                        .init(device),
                        projection: LinearConfig::new(width, width).init(device),
                    }),
                    ..Operator::empty()
                }
            }
            "Conv2d" => Operator {
                conv: Some(conv(input("in")?[0], n.int("channels")?, 3, 1, 1, device)),
                ..Operator::empty()
            },
            "ResBlock2d" => {
                let in_channels = input("in")?[0];
                let out_channels = n.int("channels")?;
                let time_width = input("time")?[0];
                Operator {
                    res: Some(ResNode {
                        norm1: GroupNormConfig::new(groups(in_channels), in_channels).init(device),
                        conv1: conv(in_channels, out_channels, 3, 1, 1, device),
                        time: LinearConfig::new(time_width, out_channels).init(device),
                        norm2: GroupNormConfig::new(groups(out_channels), out_channels)
                            .init(device),
                        conv2: conv(out_channels, out_channels, 3, 1, 1, device),
                        residual: if in_channels == out_channels {
                            None
                        } else {
                            Some(conv(in_channels, out_channels, 1, 1, 0, device))
                        },
                    }),
                    ..Operator::empty()
                }
            }
            "Downsample2d" => {
                let channels = input("in")?[0];
                Operator {
                    conv: Some(conv(channels, channels, 4, 2, 1, device)),
                    ..Operator::empty()
                }
            }
            "SpatialSelfAttention2d" => {
                let channels = input("in")?[0];
                Operator {
                    image_attention: Some(ImageAttention {
                        attention: MultiHeadAttentionConfig::new(channels, n.int("heads")?)
                            .with_dropout(0.0)
                            .init(device),
                        context: None,
                    }),
                    ..Operator::empty()
                }
            }
            "CrossAttention2d" => {
                let channels = input("in")?[0];
                Operator {
                    image_attention: Some(ImageAttention {
                        attention: MultiHeadAttentionConfig::new(channels, n.int("heads")?)
                            .with_dropout(0.0)
                            .init(device),
                        context: Some(
                            LinearConfig::new(input("context")?[1], channels).init(device),
                        ),
                    }),
                    ..Operator::empty()
                }
            }
            _ => Operator::empty(),
        };
        operators.push(op);
    }
    Ok(Model {
        operators,
        graph: Ignored(graph),
        plan: Ignored(plan),
    })
}

fn activation2<B: Backend>(x: Tensor<B, 2>, kind: &str) -> Tensor<B, 2> {
    match kind {
        "relu" => relu(x),
        "tanh" => tanh(x),
        "sigmoid" => sigmoid(x),
        _ => x,
    }
}
fn activation3<B: Backend>(x: Tensor<B, 3>, kind: &str) -> Tensor<B, 3> {
    match kind {
        "relu" => relu(x),
        "tanh" => tanh(x),
        "sigmoid" => sigmoid(x),
        _ => x,
    }
}

fn input<B: Backend>(
    values: &HashMap<(usize, String), Value<B>>,
    plan: &Plan,
    node: usize,
    pin: &str,
) -> Result<Value<B>, String> {
    let (source, output) = plan.inputs[node]
        .get(pin)
        .ok_or_else(|| format!("missing input {node}.{pin}"))?;
    values
        .get(&(*source, output.clone()))
        .cloned()
        .ok_or_else(|| format!("missing value for {node}.{pin}"))
}

impl<B: Backend> Model<B> {
    /// Caller supplies tensors for source nodes. Keys are node IDs. Returns named Output tensors.
    fn forward(
        &self,
        sources: &HashMap<String, Value<B>>,
    ) -> Result<HashMap<String, Value<B>>, String> {
        let mut values: HashMap<(usize, String), Value<B>> = HashMap::new();
        let mut outputs = HashMap::new();
        for &i in &self.plan.0.order {
            let n = &self.graph.0.nodes[i];
            let op = &self.operators[i];
            let v = match n.kind.as_str() {
                "SequenceInput" | "TokenInput" | "ImageInput" | "TimestepInput" => sources
                    .get(&n.id)
                    .cloned()
                    .ok_or_else(|| format!("missing source '{}'", n.id))?,
                "LSTM" => {
                    let Value::Float3(x) = input(&values, &self.plan.0, i, "in")? else {
                        return Err(format!("{} expects sequence", n.id));
                    };
                    Value::Float3(op.lstm.as_ref().unwrap().forward(x, None).0)
                }
                "LastStep" => {
                    let Value::Float3(x) = input(&values, &self.plan.0, i, "in")? else {
                        return Err(format!("{} expects sequence", n.id));
                    };
                    let [b, t, f] = x.dims();
                    Value::Float2(x.slice([0..b, t - 1..t, 0..f]).reshape([b, f]))
                }
                "Dropout" => match input(&values, &self.plan.0, i, "in")? {
                    Value::Float2(x) => Value::Float2(op.dropout.as_ref().unwrap().forward(x)),
                    Value::Float3(x) => Value::Float3(op.dropout.as_ref().unwrap().forward(x)),
                    _ => return Err(format!("{} expects rank 2 or 3", n.id)),
                },
                "Dense" => {
                    let kind = n.string("activation")?;
                    match input(&values, &self.plan.0, i, "in")? {
                        Value::Float2(x) => {
                            Value::Float2(activation2(op.dense.as_ref().unwrap().forward(x), kind))
                        }
                        Value::Float3(x) => {
                            Value::Float3(activation3(op.dense.as_ref().unwrap().forward(x), kind))
                        }
                        _ => return Err(format!("{} expects rank 2 or 3", n.id)),
                    }
                }
                "Embedding" => {
                    let Value::Int2(x) = input(&values, &self.plan.0, i, "tokens")? else {
                        return Err(format!("{} expects tokens", n.id));
                    };
                    Value::Float3(op.embedding.as_ref().unwrap().forward(x))
                }
                "TextEncoder" => {
                    let Value::Int2(x) = input(&values, &self.plan.0, i, "tokens")? else {
                        return Err(format!("{} expects tokens", n.id));
                    };
                    Value::Float3(op.text.as_ref().unwrap().forward(x))
                }
                "RMSNorm" => match input(&values, &self.plan.0, i, "in")? {
                    Value::Float2(x) => Value::Float2(op.norm.as_ref().unwrap().forward(x)),
                    Value::Float3(x) => Value::Float3(op.norm.as_ref().unwrap().forward(x)),
                    _ => return Err(format!("{} expects rank 2 or 3", n.id)),
                },
                "CausalAttention" => {
                    let Value::Float3(x) = input(&values, &self.plan.0, i, "in")? else {
                        return Err(format!("{} expects sequence", n.id));
                    };
                    let [batch, steps, _] = x.dims();
                    let mask: Vec<bool> = (0..batch)
                        .flat_map(|_| (0..steps).flat_map(|q| (0..steps).map(move |k| k > q)))
                        .collect();
                    let mask = Tensor::<B, 3, Bool>::from_data(
                        TensorData::new(mask, [batch, steps, steps]),
                        &x.device(),
                    );
                    Value::Float3(
                        op.attention
                            .as_ref()
                            .unwrap()
                            .forward(MhaInput::self_attn(x).mask_attn(mask))
                            .context,
                    )
                }
                "SparseMoE" => {
                    let Value::Float3(x) = input(&values, &self.plan.0, i, "in")? else {
                        return Err(format!("{} expects sequence", n.id));
                    };
                    let (out, aux) = op.moe.as_ref().unwrap().forward(x);
                    values.insert((i, "aux".into()), Value::Float1(aux));
                    Value::Float3(out)
                }
                "Add" => {
                    let a = input(&values, &self.plan.0, i, "a")?;
                    let b = input(&values, &self.plan.0, i, "b")?;
                    match (a, b) {
                        (Value::Float1(a), Value::Float1(b)) => Value::Float1(a + b),
                        (Value::Float2(a), Value::Float2(b)) => Value::Float2(a + b),
                        (Value::Float3(a), Value::Float3(b)) => Value::Float3(a + b),
                        (Value::Float4(a), Value::Float4(b)) => Value::Float4(a + b),
                        _ => return Err(format!("{} Add type mismatch", n.id)),
                    }
                }
                "TimeEmbedding" => {
                    let Value::Int1(x) = input(&values, &self.plan.0, i, "steps")? else {
                        return Err(format!("{} expects timesteps", n.id));
                    };
                    Value::Float2(op.time.as_ref().unwrap().forward(x))
                }
                "Conv2d" | "Downsample2d" => {
                    let Value::Float4(x) = input(&values, &self.plan.0, i, "in")? else {
                        return Err(format!("{} expects image", n.id));
                    };
                    Value::Float4(op.conv.as_ref().unwrap().forward(x))
                }
                "ResBlock2d" => {
                    let Value::Float4(x) = input(&values, &self.plan.0, i, "in")? else {
                        return Err(format!("{} expects image", n.id));
                    };
                    let Value::Float2(t) = input(&values, &self.plan.0, i, "time")? else {
                        return Err(format!("{} expects time embedding", n.id));
                    };
                    Value::Float4(op.res.as_ref().unwrap().forward(x, t))
                }
                "SpatialSelfAttention2d" | "CrossAttention2d" => {
                    let Value::Float4(x) = input(&values, &self.plan.0, i, "in")? else {
                        return Err(format!("{} expects image", n.id));
                    };
                    let context = if n.kind == "CrossAttention2d" {
                        let Value::Float3(c) = input(&values, &self.plan.0, i, "context")? else {
                            return Err(format!("{} expects context", n.id));
                        };
                        Some(c)
                    } else {
                        None
                    };
                    Value::Float4(op.image_attention.as_ref().unwrap().forward(x, context))
                }
                "Upsample2d" => {
                    let Value::Float4(x) = input(&values, &self.plan.0, i, "in")? else {
                        return Err(format!("{} expects image", n.id));
                    };
                    let [b, c, h, w] = x.dims();
                    let columns =
                        Tensor::stack::<5>(vec![x.clone(), x], 4).reshape([b, c, h, w * 2]);
                    Value::Float4(
                        Tensor::stack::<5>(vec![columns.clone(), columns], 3).reshape([
                            b,
                            c,
                            h * 2,
                            w * 2,
                        ]),
                    )
                }
                "Concat2d" => {
                    let Value::Float4(a) = input(&values, &self.plan.0, i, "a")? else {
                        return Err(format!("{} expects image a", n.id));
                    };
                    let Value::Float4(b) = input(&values, &self.plan.0, i, "b")? else {
                        return Err(format!("{} expects image b", n.id));
                    };
                    Value::Float4(Tensor::cat(vec![a, b], 1))
                }
                "Output" => {
                    let v = input(&values, &self.plan.0, i, "in")?;
                    outputs.insert(n.id.clone(), v);
                    continue;
                }
                _ => return Err(format!("unknown node kind {}", n.kind)),
            };
            let pin = match n.kind.as_str() {
                "LSTM" => "sequence",
                "TextEncoder" => "context",
                _ => "out",
            };
            values.insert((i, pin.into()), v);
        }
        Ok(outputs)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Task {
    Npc,
    Pet,
    MiniPic,
}
impl Task {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "npc" => Ok(Self::Npc),
            "pet" => Ok(Self::Pet),
            "mini_pic" => Ok(Self::MiniPic),
            _ => Err(format!("unknown architecture task '{value}'")),
        }
    }
}

fn node_shape<'a>(graph: &Graph, plan: &'a Plan, id: &str) -> Result<&'a Vec<usize>, String> {
    let i = graph
        .nodes
        .iter()
        .position(|n| n.id == id)
        .ok_or_else(|| format!("missing '{id}' node"))?;
    let n = &graph.nodes[i];
    if n.kind != "Output" {
        return Err(format!("'{id}' must be an Output node"));
    }
    shape(&plan.shapes, &plan.inputs[i], "in")
}

fn output_is_auxiliary(graph: &Graph, plan: &Plan, id: &str) -> bool {
    graph
        .nodes
        .iter()
        .position(|n| n.id == id)
        .and_then(|i| plan.inputs[i].get("in"))
        .is_some_and(|source| plan.auxiliary.contains(source))
}

fn validate_task(graph: &Graph, plan: &Plan, task: Task) -> Result<(), String> {
    let max_width = 64;
    for (i, n) in graph.nodes.iter().enumerate() {
        for pin in pins(&n.kind).unwrap().1 {
            if let Some(s) = plan.shapes.get(&(i, (*pin).into())) {
                if s.iter().fold(1usize, |a, &b| a.saturating_mul(b)) > 8192 {
                    return Err(format!(
                        "{} exceeds the small training tensor budget; reduce its dimensions",
                        n.id
                    ));
                }
                if s.iter().any(|&d| d > 128) && n.kind != "Dense" {
                    return Err(format!(
                        "{} exceeds the small training dimension budget",
                        n.id
                    ));
                }
            }
        }
        if let Some(width) = n.config.get("width").and_then(|v| v.as_u64()) {
            if width as usize > max_width {
                return Err(format!(
                    "{} width exceeds {max_width} for interactive training",
                    n.id
                ));
            }
        }
        if let Some(hidden) = n.config.get("hidden").and_then(|v| v.as_u64()) {
            if hidden > 128 {
                return Err(format!(
                    "{} hidden exceeds 128 for interactive training",
                    n.id
                ));
            }
        }
        if n.kind == "TextEncoder" && n.int("layers")? > 2 {
            return Err("TextEncoder layers exceed 2 for interactive training".into());
        }
    }
    match task {
        Task::Npc => {
            let a = node_shape(graph, plan, "action_output")?;
            let r = node_shape(graph, plan, "rotation_output")?;
            if a.len() != 1 || a[0] < 2 || r != &vec![1] {
                return Err("NPC outputs must be action logits [B,C>=2] and rotation [B,1]".into());
            }
            if !graph.nodes.iter().any(|n| n.kind == "SequenceInput") {
                return Err("NPC task needs SequenceInput".into());
            }
        }
        Task::Pet => {
            let a = node_shape(graph, plan, "output")?;
            let r = node_shape(graph, plan, "aux_output")?;
            if a.len() != 2
                || a[1] < 2
                || a[1] > 128
                || r != &vec![1]
                || !output_is_auxiliary(graph, plan, "aux_output")
            {
                return Err("Pet outputs must be token logits [B,T,V<=128] and aux [1]".into());
            }
            if !graph.nodes.iter().any(|n| n.kind == "TokenInput") {
                return Err("Pet task needs TokenInput".into());
            }
        }
        Task::MiniPic => {
            let a = node_shape(graph, plan, "output")?;
            if a.len() != 3 || a[1] > 16 || a[2] > 16 {
                return Err("Mini-Pic output must be image [B,C,H<=16,W<=16]".into());
            }
            if !graph.nodes.iter().any(|n| n.kind == "ImageInput") {
                return Err("Mini-Pic task needs ImageInput".into());
            }
        }
    }
    Ok(())
}

fn source_tensors(
    graph: &Graph,
    task: Task,
    device: &<MlBackend as Backend>::Device,
) -> HashMap<String, Value<MlBackend>> {
    let batch = if task == Task::MiniPic { 2 } else { 4 };
    let mut sources = HashMap::new();
    for n in &graph.nodes {
        let value = match n.kind.as_str() {
            "SequenceInput" => {
                let steps = n.int("steps").unwrap();
                let features = n.int("features").unwrap();
                let mut data = vec![0f32; batch * steps * features];
                for b in 0..batch {
                    for t in 0..steps {
                        for f in 0..features {
                            data[(b * steps + t) * features + f] = if f == 0 {
                                if b % 2 == 0 { -1.0 } else { 1.0 }
                            } else {
                                ((b + t + f) % 5) as f32 * 0.05
                            };
                        }
                    }
                }
                Value::Float3(Tensor::from_floats(
                    TensorData::new(data, [batch, steps, features]),
                    device,
                ))
            }
            "TokenInput" => {
                let steps = n.int("steps").unwrap();
                let vocab = graph
                    .nodes
                    .iter()
                    .filter(|x| x.kind == "Embedding" || x.kind == "TextEncoder")
                    .map(|x| x.int("vocabSize").unwrap())
                    .min()
                    .unwrap_or(2);
                let data = (0..batch * steps)
                    .map(|i| (i % vocab) as i32)
                    .collect::<Vec<_>>();
                Value::Int2(Tensor::from_data(
                    TensorData::new(data, [batch, steps]),
                    device,
                ))
            }
            "ImageInput" => {
                let c = n.int("channels").unwrap();
                let h = n.int("height").unwrap();
                let w = n.int("width").unwrap();
                let data = (0..batch * c * h * w)
                    .map(|i| ((i % 17) as f32 / 17.0 - 0.5) + ((i % 7) as f32 / 70.0))
                    .collect::<Vec<_>>();
                Value::Float4(Tensor::from_floats(
                    TensorData::new(data, [batch, c, h, w]),
                    device,
                ))
            }
            "TimestepInput" => Value::Int1(Tensor::from_data(
                TensorData::new(
                    (0..batch).map(|i| (i * 7 + 1) as i32).collect::<Vec<_>>(),
                    [batch],
                ),
                device,
            )),
            _ => continue,
        };
        sources.insert(n.id.clone(), value);
    }
    sources
}

fn training_loss(
    model: &Model<MlBackend>,
    sources: &HashMap<String, Value<MlBackend>>,
    task: Task,
    device: &<MlBackend as Backend>::Device,
) -> Result<Tensor<MlBackend, 1>, String> {
    let out = model.forward(sources)?;
    match task {
        Task::Npc => {
            let Some(Value::Float2(logits)) = out.get("action_output") else {
                return Err("missing NPC action output".into());
            };
            let Some(Value::Float2(rotation)) = out.get("rotation_output") else {
                return Err("missing NPC rotation output".into());
            };
            let batch = logits.dims()[0];
            let labels = Tensor::<MlBackend, 1, Int>::from_data(
                TensorData::new(
                    (0..batch).map(|i| (i % 2) as i32).collect::<Vec<_>>(),
                    [batch],
                ),
                device,
            );
            let targets = Tensor::<MlBackend, 2>::from_floats(
                TensorData::new(
                    (0..batch)
                        .map(|i| if i % 2 == 0 { -0.4 } else { 0.4 })
                        .collect::<Vec<_>>(),
                    [batch, 1],
                ),
                device,
            );
            Ok(CrossEntropyLossConfig::new()
                .init::<MlBackend>(device)
                .forward(logits.clone(), labels)
                .reshape([1])
                + (rotation.clone() - targets)
                    .powf_scalar(2.0)
                    .mean()
                    .reshape([1]))
        }
        Task::Pet => {
            let Some(Value::Float3(logits)) = out.get("output") else {
                return Err("missing Pet token output".into());
            };
            let Some(Value::Float1(aux)) = out.get("aux_output") else {
                return Err("missing Pet aux output".into());
            };
            let [batch, steps, vocab] = logits.dims();
            let token = sources
                .values()
                .find_map(|v| {
                    if let Value::Int2(t) = v {
                        Some(t.clone())
                    } else {
                        None
                    }
                })
                .ok_or("missing Pet tokens")?;
            let tokens: Vec<i64> = token
                .into_data()
                .to_vec()
                .map_err(|_| "token read failed")?;
            let labels = Tensor::<MlBackend, 1, Int>::from_data(
                TensorData::new(
                    tokens
                        .into_iter()
                        .map(|t| (t + 1) % vocab as i64)
                        .collect::<Vec<_>>(),
                    [batch * steps],
                ),
                device,
            );
            Ok(CrossEntropyLossConfig::new()
                .init::<MlBackend>(device)
                .forward(logits.clone().reshape([batch * steps, vocab]), labels)
                .reshape([1])
                + aux.clone() * 0.01)
        }
        Task::MiniPic => {
            let Some(Value::Float4(predicted)) = out.get("output") else {
                return Err("missing Mini-Pic image output".into());
            };
            let image = sources
                .values()
                .find_map(|v| {
                    if let Value::Float4(x) = v {
                        Some(x.clone())
                    } else {
                        None
                    }
                })
                .ok_or("missing Mini-Pic image")?;
            let [b, c, h, w] = image.dims();
            if predicted.dims() != [b, c, h, w] {
                return Err("Mini-Pic output shape must match image input".into());
            }
            // The deterministic target is the small perturbation of the clean pattern.
            let noise = (0..b * c * h * w)
                .map(|i| (i % 7) as f32 / 70.0)
                .collect::<Vec<_>>();
            let target =
                Tensor::<MlBackend, 4>::from_floats(TensorData::new(noise, [b, c, h, w]), device);
            Ok((predicted.clone() - target)
                .powf_scalar(2.0)
                .mean()
                .reshape([1]))
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchitectureTrainingUpdate {
    pub epoch: usize,
    pub total_epochs: usize,
    pub loss: f32,
    pub done: bool,
    pub accuracy: Option<f32>,
    pub error: Option<String>,
}

pub struct ArchitectureTrainer {
    rx: Receiver<ArchitectureTrainingUpdate>,
}
impl ArchitectureTrainer {
    pub fn start(
        graph_json: &str,
        task_name: &str,
        epochs: usize,
        lr: f64,
        seed: u64,
    ) -> Result<Self, String> {
        if epochs == 0 || epochs > 2000 {
            return Err("epochs must be between 1 and 2000".into());
        }
        if !lr.is_finite() || lr <= 0.0 || lr > 0.1 {
            return Err("learning rate must be in (0,0.1]".into());
        }
        let graph: Graph =
            serde_json::from_str(graph_json).map_err(|e| format!("invalid graph JSON: {e}"))?;
        let plan = compile(&graph)?;
        let task = Task::parse(task_name)?;
        validate_task(&graph, &plan, task)?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let outcome =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
                    let device = <MlBackend as Backend>::Device::default();
                    MlBackend::seed(&device, seed);
                    let mut model = build::<MlBackend>(graph.clone(), plan, &device)?;
                    let sources = source_tensors(&graph, task, &device);
                    let mut optimizer: OptimizerAdaptor<Adam, Model<MlBackend>, MlBackend> =
                        AdamConfig::new().init();
                    for epoch in 0..epochs {
                        let loss = training_loss(&model, &sources, task, &device)?;
                        let loss_val: f32 = loss.clone().inner().to_data().to_vec().unwrap()[0];
                        if !loss_val.is_finite() {
                            return Err(format!("nonfinite loss at epoch {}", epoch + 1));
                        }
                        let grads = GradientsParams::from_grads(loss.backward(), &model);
                        model = optimizer.step(lr, model, grads);
                        if tx
                            .send(ArchitectureTrainingUpdate {
                                epoch: epoch + 1,
                                total_epochs: epochs,
                                loss: loss_val,
                                done: epoch + 1 == epochs,
                                accuracy: None,
                                error: None,
                            })
                            .is_err()
                        {
                            return Ok(());
                        }
                    }
                    Ok(())
                }));
            let error = match outcome {
                Ok(Ok(())) => None,
                Ok(Err(message)) => Some(message),
                Err(_) => Some("training backend panicked".to_string()),
            };
            if let Some(error) = error {
                let _ = tx.send(ArchitectureTrainingUpdate {
                    epoch: 0,
                    total_epochs: epochs,
                    loss: 0.0,
                    done: true,
                    accuracy: None,
                    error: Some(error),
                });
            }
        });
        Ok(Self { rx })
    }
    pub fn poll(&mut self) -> Vec<ArchitectureTrainingUpdate> {
        let mut result = Vec::new();
        while let Ok(update) = self.rx.try_recv() {
            result.push(update);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::TryRecvError;
    use std::time::{Duration, Instant};

    fn fixture(task: Task) -> Graph {
        let data = match task {
            Task::Npc => include_str!("../tests/fixtures/ml_npc_tiny.json"),
            Task::Pet => include_str!("../tests/fixtures/ml_pet_tiny.json"),
            Task::MiniPic => include_str!("../tests/fixtures/ml_mini_pic_tiny.json"),
        };
        serde_json::from_str(data).unwrap()
    }
    fn train(graph: &Graph, task: &str, epochs: usize) -> Vec<ArchitectureTrainingUpdate> {
        let mut trainer = ArchitectureTrainer::start(
            &serde_json::to_string(graph).unwrap(),
            task,
            epochs,
            0.01,
            42,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut result = Vec::new();
        while Instant::now() < deadline {
            loop {
                match trainer.rx.try_recv() {
                    Ok(update) => {
                        let done = update.done;
                        result.push(update);
                        if done {
                            break;
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        panic!("training thread exited before completion: {result:?}")
                    }
                }
            }
            if result.last().is_some_and(|u| u.done) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            result.len(),
            epochs,
            "training ended early or timed out: {result:?}"
        );
        assert!(
            result.iter().all(|u| u.error.is_none()),
            "training error: {result:?}"
        );
        assert!(
            result.iter().all(|u| u.loss.is_finite()),
            "nonfinite loss: {result:?}"
        );
        result
    }
    #[test]
    fn npc_two_heads_train_on_two_sequence_lengths() {
        let mut graph = fixture(Task::Npc);
        let first = train(&graph, "npc", 15);
        assert!(
            first.last().unwrap().loss < first[0].loss,
            "NPC loss failed to decline"
        );
        graph
            .nodes
            .iter_mut()
            .find(|n| n.id == "moments")
            .unwrap()
            .config
            .insert("steps".into(), serde_json::json!(7));
        let second = train(&graph, "npc", 4);
        assert!(second.last().unwrap().loss < second[0].loss);
    }
    #[test]
    fn pet_causal_moe_trains_with_top_one_and_two() {
        let mut graph = fixture(Task::Pet);
        let first = train(&graph, "pet", 8);
        assert!(first.last().unwrap().loss < first[0].loss);
        for n in &mut graph.nodes {
            if n.kind == "SparseMoE" {
                n.config.insert("topK".into(), serde_json::json!(2));
            }
        }
        let second = train(&graph, "pet", 4);
        assert!(second.last().unwrap().loss < second[0].loss);
    }
    #[test]
    fn image_unet_trains_at_two_spatial_sizes() {
        let mut graph = fixture(Task::MiniPic);
        let first = train(&graph, "mini_pic", 3);
        assert!(first.last().unwrap().loss < first[0].loss);
        let image = graph.nodes.iter_mut().find(|n| n.id == "image").unwrap();
        image.config.insert("height".into(), serde_json::json!(4));
        image.config.insert("width".into(), serde_json::json!(4));
        let second = train(&graph, "mini_pic", 3);
        assert!(second.last().unwrap().loss < second[0].loss);
    }
    #[test]
    fn invalid_wires_and_dimensions_fail_before_thread_spawn() {
        let mut graph = fixture(Task::MiniPic);
        graph
            .links
            .retain(|l| !(l.from == "mid_attn" && l.to == "merge3"));
        assert!(compile(&graph).unwrap_err().contains("unconnected"));
        let mut graph = fixture(Task::Pet);
        graph
            .nodes
            .iter_mut()
            .find(|n| n.id == "moe_0")
            .unwrap()
            .config
            .insert("topK".into(), serde_json::json!(3));
        assert!(compile(&graph).unwrap_err().contains("topK"));

        let mut graph = fixture(Task::Pet);
        graph.nodes.push(Node {
            id: "last".into(),
            kind: "LastStep".into(),
            config: HashMap::new(),
        });
        graph.nodes.push(Node {
            id: "scalar".into(),
            kind: "Dense".into(),
            config: HashMap::from([
                ("units".into(), serde_json::json!(1)),
                ("activation".into(), serde_json::json!("linear")),
            ]),
        });
        graph.links.push(Link {
            from: "embedding".into(),
            output: "out".into(),
            to: "last".into(),
            input: "in".into(),
        });
        graph.links.push(Link {
            from: "last".into(),
            output: "out".into(),
            to: "scalar".into(),
            input: "in".into(),
        });
        let link = graph
            .links
            .iter_mut()
            .find(|l| l.to == "router_aux" && l.input == "b")
            .unwrap();
        link.from = "scalar".into();
        link.output = "out".into();
        assert!(
            compile(&graph)
                .unwrap_err()
                .contains("cannot mix auxiliary")
        );
    }
    #[test]
    fn pet_attention_does_not_see_future_tokens() {
        let graph = fixture(Task::Pet);
        let plan = compile(&graph).unwrap();
        let device = <MlBackend as Backend>::Device::default();
        MlBackend::seed(&device, 42);
        let model = build::<MlBackend>(graph.clone(), plan, &device).unwrap();
        let mut sources = source_tensors(&graph, Task::Pet, &device);
        let first = match model.forward(&sources).unwrap().remove("output").unwrap() {
            Value::Float3(x) => x.into_data().to_vec::<f32>().unwrap(),
            _ => panic!("expected logits"),
        };
        let mut ids = (0..16).map(|i| (i % 16) as i32).collect::<Vec<_>>();
        ids[3] = 7;
        sources.insert(
            "tokens".into(),
            Value::Int2(Tensor::from_data(TensorData::new(ids, [4, 4]), &device)),
        );
        let changed = match model.forward(&sources).unwrap().remove("output").unwrap() {
            Value::Float3(x) => x.into_data().to_vec::<f32>().unwrap(),
            _ => panic!("expected logits"),
        };
        assert!(
            first[..16]
                .iter()
                .zip(&changed[..16])
                .all(|(a, b)| (a - b).abs() < 1e-6),
            "first-token logits changed after a future-token edit"
        );
        assert!(
            first[3 * 16..4 * 16]
                .iter()
                .zip(&changed[3 * 16..4 * 16])
                .any(|(a, b)| (a - b).abs() > 1e-6),
            "edited token did not affect its own logits"
        );
    }
    #[test]
    fn image_unet_responds_to_time_and_text_inputs() {
        let graph = fixture(Task::MiniPic);
        let plan = compile(&graph).unwrap();
        let device = <MlBackend as Backend>::Device::default();
        MlBackend::seed(&device, 42);
        let model = build::<MlBackend>(graph.clone(), plan, &device).unwrap();
        let mut sources = source_tensors(&graph, Task::MiniPic, &device);
        let image = |sources: &HashMap<String, Value<MlBackend>>| match model
            .forward(sources)
            .unwrap()
            .remove("output")
            .unwrap()
        {
            Value::Float4(x) => x.into_data().to_vec::<f32>().unwrap(),
            _ => panic!("expected image"),
        };
        let baseline = image(&sources);
        sources.insert(
            "steps".into(),
            Value::Int1(Tensor::from_data(
                TensorData::new(vec![9i32, 16], [2]),
                &device,
            )),
        );
        let changed_time = image(&sources);
        assert!(
            baseline
                .iter()
                .zip(&changed_time)
                .any(|(a, b)| (a - b).abs() > 1e-6),
            "time input had no effect"
        );
        sources = source_tensors(&graph, Task::MiniPic, &device);
        sources.insert(
            "tokens".into(),
            Value::Int2(Tensor::from_data(
                TensorData::new(vec![15i32; 8], [2, 4]),
                &device,
            )),
        );
        let changed_text = image(&sources);
        assert!(
            baseline
                .iter()
                .zip(&changed_text)
                .any(|(a, b)| (a - b).abs() > 1e-6),
            "text input had no effect"
        );
    }
}
