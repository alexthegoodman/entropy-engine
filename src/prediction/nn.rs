//! The building blocks the prediction model is made of, copied from yumon-pet's brain/model.rs
//! (RMSNorm, SiLU, the SwiGLU MLP) and brain/moe_model.rs (the dropless sparse MoE layer).

use burn::{
    nn::{Initializer, Linear, LinearConfig},
    prelude::*,
    tensor::{
        IndexingUpdateOp,
        activation::{log_softmax, sigmoid, softmax},
    },
};

#[derive(Config, Debug)]
pub struct RMSNormConfig {
    size: usize,
    #[config(default = 1e-6)]
    eps: f64,
}

impl RMSNormConfig {
    pub fn init<B: Backend>(&self, device: &B::Device) -> RMSNorm<B> {
        let weight = burn::module::Param::from_tensor(Tensor::ones([self.size], device));
        RMSNorm { weight, eps: self.eps }
    }
}

#[derive(Module, Debug)]
pub struct RMSNorm<B: Backend> {
    weight: burn::module::Param<Tensor<B, 1>>,
    eps: f64,
}

impl<B: Backend> RMSNorm<B> {
    pub fn forward<const D: usize>(&self, x: Tensor<B, D>) -> Tensor<B, D> {
        let rms = (x.clone().powf_scalar(2.0).mean_dim(D - 1) + self.eps).sqrt();
        (x / rms) * self.weight.val().unsqueeze()
    }
}


#[derive(Module, Clone, Debug)]
pub struct SiLU {}

impl SiLU {
    pub fn new() -> Self { Self {} }
    pub fn forward<B: Backend, const D: usize>(&self, x: Tensor<B, D>) -> Tensor<B, D> {
        x.clone() * sigmoid(x)
    }
}

#[derive(Config, Debug)]
pub struct MLPConfig {
    d_model:    usize,
    d_hidden:   usize,
}

impl MLPConfig {
    pub fn init<B: Backend>(&self, device: &B::Device) -> MLP<B> {
        MLP {
            w1:   LinearConfig::new(self.d_model, self.d_hidden)
                .with_initializer(Initializer::KaimingUniform {
                    gain: 1.0 / f64::sqrt(3.0),
                    fan_out_only: false,
                })
                .with_bias(false).init(device),
            w2:   LinearConfig::new(self.d_hidden, self.d_model)
                .with_initializer(Initializer::KaimingUniform {
                    gain: 1.0 / f64::sqrt(3.0),
                    fan_out_only: false,
                })
                .with_bias(false).init(device),
            w3:   LinearConfig::new(self.d_model, self.d_hidden)
                .with_initializer(Initializer::KaimingUniform {
                    gain: 1.0 / f64::sqrt(3.0),
                    fan_out_only: false,
                })
                .with_bias(false).init(device),
            silu: SiLU::new(),
        }
    }
}

#[derive(Module, Debug)]
pub struct MLP<B: Backend> {
    w1:   Linear<B>,
    w2:   Linear<B>,
    w3:   Linear<B>,
    silu: SiLU,
}

impl<B: Backend> MLP<B> {
    pub fn forward(&self, x: Tensor<B, 3>) -> Tensor<B, 3> {
        // SwiGLU: w2( silu(w1(x)) * w3(x) )
        self.w2.forward(self.silu.forward(self.w1.forward(x.clone())) * self.w3.forward(x))
    }
}

#[derive(Module, Debug)]
pub struct SparseMoe<B: Backend> {
    router: Linear<B>,
    experts: Vec<MLP<B>>,
    top_k: usize,
}
impl<B: Backend> SparseMoe<B> {
    pub fn new(
        width: usize,
        hidden: usize,
        experts: usize,
        top_k: usize,
        device: &B::Device,
    ) -> Self {
        assert!(width > 0 && hidden > 0 && experts > 0);
        assert!(top_k > 0 && top_k <= experts);
        Self {
            router: LinearConfig::new(width, experts)
                .with_bias(false)
                .init(device),
            experts: (0..experts)
                .map(|_| MLPConfig::new(width, hidden).init(device))
                .collect(),
            top_k,
        }
    }
    /// Non-padding tokens [tokens, width]; output, balance/z losses, actual row counts.
    pub fn forward(
        &self,
        x: Tensor<B, 2>,
    ) -> (Tensor<B, 2>, Tensor<B, 1>, Tensor<B, 1>, Vec<usize>) {
        let [tokens, width] = x.dims();
        let device = x.device();
        let n = self.experts.len();
        assert!(tokens > 0);
        let logits = self.router.forward(x.clone());
        let probabilities = softmax(logits.clone(), 1);
        let choices = if self.top_k == 1 {
            logits.clone().detach().argmax(1)
        } else {
            logits.clone().detach().topk_with_indices(self.top_k, 1).1
        };
        // One host read of integer decisions; no dense expert output tensors.
        // Converted first: Wgpu's Int element is i32, NdArray's is i64.
        let ids = choices.to_data().convert::<i64>().to_vec::<i64>().expect("router indices");
        let mut rows = vec![Vec::<i32>::new(); n];
        for (slot, expert) in ids.into_iter().enumerate() {
            rows[expert as usize].push((slot / self.top_k) as i32);
        }
        let counts: Vec<usize> = rows.iter().map(Vec::len).collect();
        let fractions = Tensor::<B, 2>::from_data(
            TensorData::new(
                counts
                    .iter()
                    .map(|&c| c as f32 / (tokens * self.top_k) as f32)
                    .collect::<Vec<_>>(),
                [1, n],
            ),
            &device,
        );
        // Switch-style balance: E * sum(f_i * mean(p_i)).
        let balance = (probabilities.clone().mean_dim(0) * fractions).sum() * n as f64;
        let log_z = logits.clone().slice([0..tokens, 0..1])
            - log_softmax(logits, 1).slice([0..tokens, 0..1]);
        let z_loss = log_z.powf_scalar(2.0).mean();
        // Full-softmax gate preserves language-loss router gradients for top-1.
        // Normalizing a single selected gate to 1 would remove that gradient.
        let mut output = Tensor::zeros([tokens, width], &device);
        for (expert_id, row_ids) in rows.into_iter().enumerate() {
            let count = row_ids.len();
            if count == 0 {
                continue;
            }
            let index = Tensor::<B, 1, Int>::from_ints(TensorData::new(row_ids, [count]), &device);
            let input = x
                .clone()
                .select(0, index.clone())
                .reshape([1, count, width]);
            let gate = probabilities
                .clone()
                .select(0, index.clone())
                .slice([0..count, expert_id..expert_id + 1]);
            let value = self.experts[expert_id]
                .forward(input)
                .reshape([count, width])
                * gate;
            output = output.select_assign(0, index, value, IndexingUpdateOp::Add);
        }
        (output, balance, z_loss, counts)
    }
}
