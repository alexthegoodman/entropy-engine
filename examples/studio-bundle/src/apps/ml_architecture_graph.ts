/** Shape-checked architecture graphs used by the ML graph editor.
 * Dimensions are symbolic so a graph describes a model independently of batch size. */
export type Shape = readonly (number | string)[];
export type ArchitectureKind = "npc" | "pet" | "mini_pic";
export type NodeKind =
    | "SequenceInput" | "TokenInput" | "ImageInput" | "TimestepInput"
    | "LSTM" | "LastStep" | "Dropout" | "Dense" | "Embedding" | "RMSNorm"
    | "CausalAttention" | "SparseMoE" | "Add" | "TimeEmbedding"
    | "TextEncoder" | "Conv2d" | "ResBlock2d" | "Downsample2d"
    | "SpatialSelfAttention2d" | "CrossAttention2d" | "Upsample2d" | "Concat2d" | "Output";

export interface ArchitectureNode {
    id: string;
    kind: NodeKind;
    position: [number, number];
    config: Record<string, number | string>;
}
export interface ArchitectureLink {
    from: string;
    output: string;
    to: string;
    input: string;
}
export interface ArchitectureGraph {
    name: string;
    nodes: ArchitectureNode[];
    links: ArchitectureLink[];
}
export interface NodeDefinition { inputs: readonly string[]; outputs: readonly string[]; help: string; }

export const NODE_DEFINITIONS: Record<NodeKind, NodeDefinition> = {
    SequenceInput: { inputs: [], outputs: ["out"], help: "Floating point sequence [B,T,F]." },
    TokenInput: { inputs: [], outputs: ["out"], help: "Integer token IDs [B,T]." },
    ImageInput: { inputs: [], outputs: ["out"], help: "Noisy image [B,C,H,W]." },
    TimestepInput: { inputs: [], outputs: ["out"], help: "Diffusion step [B]." },
    LSTM: { inputs: ["in"], outputs: ["sequence"], help: "Recurrent sequence [B,T,F] to [B,T,hidden]." },
    LastStep: { inputs: ["in"], outputs: ["out"], help: "Select the last recurrent state [B,F]." },
    Dropout: { inputs: ["in"], outputs: ["out"], help: "Training-only dropout; shape is unchanged." },
    Dense: { inputs: ["in"], outputs: ["out"], help: "Linear projection of the last dimension." },
    Embedding: { inputs: ["tokens"], outputs: ["out"], help: "Token IDs to learned vectors [B,T,D]." },
    RMSNorm: { inputs: ["in"], outputs: ["out"], help: "Root-mean-square normalization of the feature axis." },
    CausalAttention: { inputs: ["in"], outputs: ["out"], help: "Masked self-attention over a token sequence." },
    SparseMoE: { inputs: ["in"], outputs: ["out", "aux"], help: "Top-k routed experts; aux carries scalar router balance and z-loss." },
    Add: { inputs: ["a", "b"], outputs: ["out"], help: "Residual addition; input shapes must match." },
    TimeEmbedding: { inputs: ["steps"], outputs: ["out"], help: "Sinusoidal diffusion time embedding followed by an MLP." },
    TextEncoder: { inputs: ["tokens"], outputs: ["context"], help: "Token embedding and transformer encoder for text conditioning." },
    Conv2d: { inputs: ["in"], outputs: ["out"], help: "Same-resolution spatial convolution." },
    ResBlock2d: { inputs: ["in", "time"], outputs: ["out"], help: "Two convolutions, time bias, and a residual projection." },
    Downsample2d: { inputs: ["in"], outputs: ["out"], help: "Stride-two spatial convolution; requires even H and W." },
    SpatialSelfAttention2d: { inputs: ["in"], outputs: ["out"], help: "Spatial self-attention over image pixels; shape is unchanged." },
    CrossAttention2d: { inputs: ["in", "context"], outputs: ["out"], help: "Image features attend to text tokens; shape is unchanged." },
    Upsample2d: { inputs: ["in"], outputs: ["out"], help: "Two-times spatial upsampling." },
    Concat2d: { inputs: ["a", "b"], outputs: ["out"], help: "U-Net skip merge along the channel dimension." },
    Output: { inputs: ["in"], outputs: [], help: "Named model output; multiple outputs are allowed." },
};

export interface ValidationResult {
    errors: string[];
    shapes: Record<string, Shape>;
}

const key = (node: string, pin: string) => `${node}.${pin}`;
const shapeText = (shape: Shape) => `[${shape.join(",")}]`;
const sameShape = (a: Shape, b: Shape) => a.length === b.length && a.every((d, i) => d === b[i]);

function positiveInt(node: ArchitectureNode, name: string): number {
    const value = node.config[name];
    if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer`);
    return value as number;
}
function rank(shape: Shape, count: number, name: string): void {
    if (shape.length !== count) throw new Error(`${name} needs rank ${count}, got ${shapeText(shape)}`);
}
function equal(a: number | string, b: number | string, name: string): void {
    if (a !== b) throw new Error(`${name} mismatch: ${a} versus ${b}`);
}

function infer(node: ArchitectureNode, inputs: Record<string, Shape>): Record<string, Shape> {
    const x = inputs.in;
    switch (node.kind) {
        case "SequenceInput": return { out: ["B", positiveInt(node, "steps"), positiveInt(node, "features")] };
        case "TokenInput": return { out: ["B", positiveInt(node, "steps")] };
        case "ImageInput": return { out: ["B", positiveInt(node, "channels"), positiveInt(node, "height"), positiveInt(node, "width")] };
        case "TimestepInput": return { out: ["B"] };
        case "LSTM": rank(x, 3, "LSTM"); return { sequence: [x[0], x[1], positiveInt(node, "hidden")] };
        case "LastStep": rank(x, 3, "LastStep"); return { out: [x[0], x[2]] };
        case "Dropout": {
            const p = node.config.probability;
            if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p >= 1) throw new Error("probability must be in [0,1)");
            return { out: x };
        }
        case "Dense": {
            if (x.length !== 2 && x.length !== 3) throw new Error(`Dense needs rank 2 or 3, got ${shapeText(x)}`);
            if (!["relu", "tanh", "sigmoid", "linear"].includes(String(node.config.activation))) throw new Error("unknown activation");
            return { out: [...x.slice(0, -1), positiveInt(node, "units")] };
        }
        case "Embedding": rank(inputs.tokens, 2, "Embedding"); positiveInt(node, "vocabSize"); return { out: [...inputs.tokens, positiveInt(node, "width")] };
        case "TextEncoder": {
            rank(inputs.tokens, 2, "TextEncoder"); positiveInt(node, "layers"); positiveInt(node, "vocabSize");
            const width = positiveInt(node, "width");
            if (width % positiveInt(node, "heads") !== 0) throw new Error("width must be divisible by heads");
            return { context: [...inputs.tokens, width] };
        }
        case "RMSNorm": if (x.length !== 2 && x.length !== 3) throw new Error("RMSNorm needs rank 2 or 3"); return { out: x };
        case "CausalAttention": {
            rank(x, 3, "CausalAttention");
            if (typeof x[2] !== "number" || x[2] % positiveInt(node, "heads") !== 0) throw new Error("width must be divisible by heads");
            return { out: x };
        }
        case "SparseMoE": {
            rank(x, 3, "SparseMoE");
            const experts = positiveInt(node, "experts");
            if (positiveInt(node, "topK") > experts) throw new Error("topK cannot exceed experts");
            positiveInt(node, "hidden");
            return { out: x, aux: [1] };
        }
        case "Add": {
            if (!sameShape(inputs.a, inputs.b)) throw new Error(`Add needs equal shapes: ${shapeText(inputs.a)} versus ${shapeText(inputs.b)}`);
            return { out: inputs.a };
        }
        case "TimeEmbedding": {
            rank(inputs.steps, 1, "TimeEmbedding");
            const width = positiveInt(node, "width");
            if (width % 2) throw new Error("width must be even for sinusoidal embedding");
            return { out: [inputs.steps[0], width] };
        }
        case "Conv2d": rank(x, 4, "Conv2d"); return { out: [x[0], positiveInt(node, "channels"), x[2], x[3]] };
        case "ResBlock2d": {
            rank(x, 4, "ResBlock2d"); rank(inputs.time, 2, "ResBlock2d time"); equal(x[0], inputs.time[0], "batch");
            return { out: [x[0], positiveInt(node, "channels"), x[2], x[3]] };
        }
        case "Downsample2d": {
            rank(x, 4, "Downsample2d");
            if (typeof x[2] !== "number" || typeof x[3] !== "number" || x[2] % 2 || x[3] % 2) throw new Error("height and width must be even");
            return { out: [x[0], x[1], x[2] / 2, x[3] / 2] };
        }
        case "SpatialSelfAttention2d": {
            rank(x, 4, "SpatialSelfAttention2d");
            const heads = positiveInt(node, "heads");
            if (typeof x[1] !== "number" || x[1] % heads !== 0) throw new Error("channels must be divisible by heads");
            return { out: x };
        }
        case "CrossAttention2d": {
            rank(x, 4, "CrossAttention2d"); rank(inputs.context, 3, "CrossAttention2d context"); equal(x[0], inputs.context[0], "batch");
            const heads = positiveInt(node, "heads");
            if (typeof x[1] !== "number" || x[1] % heads !== 0) throw new Error("channels must be divisible by heads");
            return { out: x };
        }
        case "Upsample2d": rank(x, 4, "Upsample2d"); return { out: [x[0], x[1], (x[2] as number) * 2, (x[3] as number) * 2] };
        case "Concat2d": {
            const a = inputs.a, b = inputs.b;
            rank(a, 4, "Concat2d"); rank(b, 4, "Concat2d");
            equal(a[0], b[0], "batch"); equal(a[2], b[2], "height"); equal(a[3], b[3], "width");
            return { out: [a[0], (a[1] as number) + (b[1] as number), a[2], a[3]] };
        }
        case "Output": return {};
    }
}

/** Validates pins, arity, cycles and tensor dimensions without executing the model. */
export function validateArchitecture(graph: ArchitectureGraph): ValidationResult {
    const errors: string[] = [], shapes: Record<string, Shape> = {};
    const nodes = new Map<string, ArchitectureNode>();
    for (const node of graph.nodes) {
        if (!node.id || nodes.has(node.id)) errors.push(`duplicate or empty node id '${node.id}'`);
        nodes.set(node.id, node);
    }
    const incoming = new Map<string, ArchitectureLink>();
    for (const link of graph.links) {
        const from = nodes.get(link.from), to = nodes.get(link.to);
        if (!from || !to) { errors.push(`link ${link.from}.${link.output} -> ${link.to}.${link.input} references a missing node`); continue; }
        if (!NODE_DEFINITIONS[from.kind].outputs.includes(link.output)) errors.push(`${from.id} has no output '${link.output}'`);
        if (!NODE_DEFINITIONS[to.kind].inputs.includes(link.input)) errors.push(`${to.id} has no input '${link.input}'`);
        const inputKey = key(link.to, link.input);
        if (incoming.has(inputKey)) errors.push(`${inputKey} has more than one source`);
        incoming.set(inputKey, link);
    }
    for (const node of graph.nodes) for (const pin of NODE_DEFINITIONS[node.kind].inputs) {
        if (!incoming.has(key(node.id, pin))) errors.push(`${node.id}.${pin} is unconnected`);
    }
    if (!graph.nodes.some(n => n.kind === "Output")) errors.push("graph needs at least one Output node");
    const state = new Map<string, "visiting" | "done">();
    const reachesOutput = new Set<string>();
    const visit = (node: ArchitectureNode): void => {
        if (state.get(node.id) === "done") return;
        if (state.get(node.id) === "visiting") { errors.push(`cycle reaches ${node.id}`); return; }
        state.set(node.id, "visiting");
        const inputs: Record<string, Shape> = {};
        for (const pin of NODE_DEFINITIONS[node.kind].inputs) {
            const link = incoming.get(key(node.id, pin));
            const source = link && nodes.get(link.from);
            if (source) {
                visit(source);
                const shape = shapes[key(source.id, link!.output)];
                if (shape) inputs[pin] = shape;
            }
        }
        if (Object.keys(inputs).length === NODE_DEFINITIONS[node.kind].inputs.length) {
            try {
                const outputs = infer(node, inputs);
                for (const [pin, shape] of Object.entries(outputs)) shapes[key(node.id, pin)] = shape;
            } catch (error) { errors.push(`${node.id} (${node.kind}): ${(error as Error).message}`); }
        }
        state.set(node.id, "done");
    };
    for (const node of graph.nodes.filter(n => n.kind === "Output")) {
        const walk = (id: string): void => {
            if (reachesOutput.has(id)) return;
            reachesOutput.add(id);
            for (const link of graph.links.filter(l => l.to === id)) walk(link.from);
        };
        walk(node.id);
    }
    for (const node of graph.nodes) {
        visit(node);
        if (!reachesOutput.has(node.id)) errors.push(`${node.id} does not reach an Output node`);
    }
    return { errors: [...new Set(errors)], shapes };
}

function builder(name: string) {
    const nodes: ArchitectureNode[] = [], links: ArchitectureLink[] = [];
    const add = (id: string, kind: NodeKind, x: number, y: number, config: ArchitectureNode["config"] = {}) => {
        nodes.push({ id, kind, position: [x, y], config }); return id;
    };
    const wire = (from: string, to: string, input = "in", output = "out") => links.push({ from, output, to, input });
    return { add, wire, graph: { name, nodes, links } as ArchitectureGraph };
}

/** Matches the two-head shape of entropy-engine/src/yumon/system.rs. */
export function npcGraph(): ArchitectureGraph {
    const b = builder("Yumon NPC - LSTM with action and rotation heads");
    b.add("moments", "SequenceInput", 30, 250, { steps: 16, features: 24 });
    b.add("memory", "LSTM", 250, 250, { hidden: 256 }); b.wire("moments", "memory");
    b.add("last", "LastStep", 470, 250); b.wire("memory", "last", "in", "sequence");
    b.add("dropout", "Dropout", 680, 250, { probability: 0.2 }); b.wire("last", "dropout");
    b.add("shared", "Dense", 890, 250, { units: 64, activation: "relu" }); b.wire("dropout", "shared");
    b.add("actions", "Dense", 1100, 120, { units: 12, activation: "linear" }); b.wire("shared", "actions");
    b.add("rotation", "Dense", 1100, 370, { units: 1, activation: "tanh" }); b.wire("shared", "rotation");
    b.add("action_output", "Output", 1320, 120); b.wire("actions", "action_output");
    b.add("rotation_output", "Output", 1320, 370); b.wire("rotation", "rotation_output");
    return b.graph;
}

/** Sparse MoE decoder core from yumon-pet/src/brain/moe_model.rs. */
export function petGraph(): ArchitectureGraph {
    const b = builder("Yumon Pet - causal decoder with sparse MoE");
    b.add("tokens", "TokenInput", 30, 250, { steps: 320 });
    b.add("embedding", "Embedding", 250, 250, { width: 256, vocabSize: 8192 }); b.wire("tokens", "embedding", "tokens");
    for (let i = 0; i < 2; i++) {
        const previous = i === 0 ? "embedding" : `residual_${i - 1}`;
        const offset = i * 1100;
        b.add(`attn_norm_${i}`, "RMSNorm", 470 + offset, 250); b.wire(previous, `attn_norm_${i}`);
        b.add(`attention_${i}`, "CausalAttention", 690 + offset, 250, { heads: 4 }); b.wire(`attn_norm_${i}`, `attention_${i}`);
        b.add(`attn_residual_${i}`, "Add", 910 + offset, 250); b.wire(previous, `attn_residual_${i}`, "a"); b.wire(`attention_${i}`, `attn_residual_${i}`, "b");
        b.add(`ffn_norm_${i}`, "RMSNorm", 1130 + offset, 250); b.wire(`attn_residual_${i}`, `ffn_norm_${i}`);
        b.add(`moe_${i}`, "SparseMoE", 1350 + offset, 250, { experts: 4, topK: 1, hidden: 1024 }); b.wire(`ffn_norm_${i}`, `moe_${i}`);
        b.add(`residual_${i}`, "Add", 1570 + offset, 250); b.wire(`attn_residual_${i}`, `residual_${i}`, "a"); b.wire(`moe_${i}`, `residual_${i}`, "b");
    }
    b.add("final_norm", "RMSNorm", 2890, 250); b.wire("residual_1", "final_norm");
    b.add("token_logits", "Dense", 3110, 250, { units: 8192, activation: "linear" }); b.wire("final_norm", "token_logits");
    b.add("output", "Output", 3330, 250); b.wire("token_logits", "output");
    b.add("router_aux", "Add", 2450, 540); b.wire("moe_0", "router_aux", "a", "aux"); b.wire("moe_1", "router_aux", "b", "aux");
    b.add("aux_output", "Output", 2670, 540); b.wire("router_aux", "aux_output");
    return b.graph;
}

/** Conditioned U-Net skeleton with explicit time/text edges and three skip merges. */
export function miniPicGraph(): ArchitectureGraph {
    const b = builder("Mini-Pic - text and time conditioned U-Net");
    b.add("image", "ImageInput", 20, 300, { channels: 3, height: 64, width: 64 });
    b.add("steps", "TimestepInput", 20, 620);
    b.add("time", "TimeEmbedding", 230, 620, { width: 128 }); b.wire("steps", "time", "steps");
    b.add("tokens", "TokenInput", 20, 800, { steps: 32 });
    b.add("text", "TextEncoder", 230, 800, { width: 128, layers: 4, heads: 4, vocabSize: 8192 }); b.wire("tokens", "text", "tokens");
    b.add("stem", "Conv2d", 230, 300, { channels: 64 }); b.wire("image", "stem");
    b.add("enc1", "ResBlock2d", 450, 300, { channels: 64 }); b.wire("stem", "enc1"); b.wire("time", "enc1", "time");
    b.add("down1", "Downsample2d", 670, 300); b.wire("enc1", "down1");
    b.add("enc2", "ResBlock2d", 890, 300, { channels: 128 }); b.wire("down1", "enc2"); b.wire("time", "enc2", "time");
    b.add("self2", "SpatialSelfAttention2d", 1000, 500, { heads: 4 }); b.wire("enc2", "self2");
    b.add("attn2", "CrossAttention2d", 1110, 300, { heads: 4 }); b.wire("self2", "attn2"); b.wire("text", "attn2", "context", "context");
    b.add("down2", "Downsample2d", 1330, 300); b.wire("attn2", "down2");
    b.add("enc3", "ResBlock2d", 1550, 300, { channels: 256 }); b.wire("down2", "enc3"); b.wire("time", "enc3", "time");
    b.add("mid_self", "SpatialSelfAttention2d", 1660, 500, { heads: 4 }); b.wire("enc3", "mid_self");
    b.add("mid_attn", "CrossAttention2d", 1770, 300, { heads: 4 }); b.wire("mid_self", "mid_attn"); b.wire("text", "mid_attn", "context", "context");
    b.add("merge3", "Concat2d", 1990, 300); b.wire("mid_attn", "merge3", "a"); b.wire("enc3", "merge3", "b");
    b.add("dec3", "ResBlock2d", 2210, 300, { channels: 128 }); b.wire("merge3", "dec3"); b.wire("time", "dec3", "time");
    b.add("up2", "Upsample2d", 2430, 300); b.wire("dec3", "up2");
    b.add("merge2", "Concat2d", 2650, 300); b.wire("up2", "merge2", "a"); b.wire("attn2", "merge2", "b");
    b.add("dec2", "ResBlock2d", 2870, 300, { channels: 64 }); b.wire("merge2", "dec2"); b.wire("time", "dec2", "time");
    b.add("up1", "Upsample2d", 3090, 300); b.wire("dec2", "up1");
    b.add("merge1", "Concat2d", 3310, 300); b.wire("up1", "merge1", "a"); b.wire("enc1", "merge1", "b");
    b.add("dec1", "ResBlock2d", 3530, 300, { channels: 64 }); b.wire("merge1", "dec1"); b.wire("time", "dec1", "time");
    b.add("noise", "Conv2d", 3750, 300, { channels: 3 }); b.wire("dec1", "noise");
    b.add("output", "Output", 3970, 300); b.wire("noise", "output");
    return b.graph;
}
