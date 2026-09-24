# ML architecture graphs

The ML Graph Trainer addon has two views. **MLP Trainer** compiles a single `Input -> Dense -> Loss` chain into a Burn model and trains it on XOR, AND, or two moons. XOR and AND have four exact samples each; two moons uses a seeded generator. `Entropy.ML.trainGraph` accepts an optional `seed` (default 42) for Burn initialization and dataset generation. **Model Architectures** is a shape-checked editor for sequence, routed-expert, and image graphs. Run `cargo run --bin example -- ml-graph-demo` from `entropy-engine/`, or build the addon with `npm run build-ml-graph-demo` in `examples/studio-bundle/`.

The architecture view includes editable presets based on these local models:

| Preset | Source | Graph structure |
| --- | --- | --- |
| Yumon NPC | `src/yumon/system.rs` | `[B,16,24]` moments -> LSTM(256) -> last step -> dropout(0.2) -> Dense(64) -> action logits(12) and tanh rotation(1) |
| Yumon Pet | `../../yumon-pet/src/brain/moe_model.rs` | token IDs -> embedding(256) -> two causal attention and top-1 sparse MoE blocks with RMSNorm and residual adds -> vocabulary logits plus router auxiliary loss |
| Mini-Pic | `../../mini-pic/python-train/model.py` | noisy image, timestep, and text token inputs -> time/text conditioning -> convolutional encoder -> spatial attention -> skip concatenation and decoder -> predicted noise image |

The node catalog has sequence and token inputs, image and timestep inputs, LSTM, LastStep, Dropout, Dense, Embedding, RMSNorm, CausalAttention, SparseMoE, Add, TimeEmbedding, TextEncoder, Conv2d, ResBlock2d, Downsample2d, SpatialSelfAttention2d, CrossAttention2d, Upsample2d, Concat2d, and Output. Each node declares named input/output pins and checks its input rank and relevant dimensions. The editor reports missing pins, duplicate connections, cycles, invalid parameters, and shape mismatches. Multiple output nodes and branches are allowed in this view.

The architecture graphs **do not execute or train yet**. The current `Entropy.ML.trainGraph` API still accepts only the MLP chain and its three built-in classification datasets. Full execution needs a typed DAG compiler and data APIs for sequences/images/text, multi-output losses, optimizer state and model persistence. In particular, reproducing Mini-Pic also needs the diffusion scheduler and training targets; the U-Net alone is not the full model. The presets express representative architecture, not checkpoint-compatible replicas. Do not send an architecture graph to `trainGraph`.

The live BDD feature at `tests/features/ml_graph_live.feature` launches the actual compiled addon, trains Burn on all three deterministic datasets, checks saved loss and accuracy, captures eight graph/training states, and verifies a broken U-Net skip is rejected then restored from disk. The architecture unit tests also stress tiny sequence lengths, token lengths, and image sizes (8, 16, and 32) plus invalid parameter edges. Those tests check node contracts, not numerical training of LSTM, MoE, or U-Net.
