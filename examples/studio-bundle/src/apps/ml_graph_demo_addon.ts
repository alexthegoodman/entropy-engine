// ML Graph Trainer and shape-checked architecture editor.
//
// Built on the same `Entropy.UI.Widget.snarl(...)` / `NodeGraphEditor` the "Nocode Calculator"
// (node_graph_addon.ts) exercises for pure-JS arithmetic - but here the graph isn't evaluated in
// JS at all. `Entropy.ML.trainGraph` (new this session, `crate::ml_graph`) serializes it, walks
// the chain from the one Input node to the one Loss node on the Rust side, and dynamically
// builds a `Vec<Linear<B>>`-backed Burn MLP from whatever Dense nodes it finds in between -
// something Burn has no built-in support for, since its models are ordinarily fixed Rust structs
// known at compile time (compare `crate::yumon::system::BrainModel`, a hand-written fixed
// LSTM->Dense->heads shape). Training runs full-batch on a background thread and reports
// per-epoch loss back through `Entropy.ML.poll`; nothing here blocks the UI thread.
//
import {
    NODE_DEFINITIONS, miniPicGraph, npcGraph, petGraph, tinyArchitecture, validateArchitecture,
    type ArchitectureGraph, type ArchitectureKind, type NodeKind,
} from "./ml_architecture_graph";

interface MlPin { id: string; name: string; pinType: string; }
interface MlNode {
    id: string;
    name: string;
    nodeType: "Input" | "Dense" | "Output" | "Loss";
    position: [number, number];
    inputs: MlPin[];
    outputs: MlPin[];
    properties: { units?: number; activation?: string };
}
interface MlConn { fromNode: string; fromPin: string; toNode: string; toPin: string; }

const addonInfo = {
    name: "ML Graph Trainer",
    version: "1.0.0",
    description: "Train Burn MLP, LSTM, MoE, and U-Net node graphs",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const INPUT_ID = "in";
const OUTPUT_ID = "out";
const LOSS_ID = "loss";
const ACTIVATIONS = ["relu", "tanh", "sigmoid", "linear"] as const;
const DATASETS = ["xor", "two_moons", "and"] as const;
const ARCHITECTURES: readonly ArchitectureKind[] = ["npc", "pet", "mini_pic"];
const GRAPH_FACTORIES = { npc: npcGraph, pet: petGraph, mini_pic: miniPicGraph };
const NODE_KINDS = Object.keys(NODE_DEFINITIONS) as NodeKind[];
let view: "trainer" | "architecture" = "trainer";
let architectureKind: ArchitectureKind = "npc";
let architecture: ArchitectureGraph = npcGraph();
let selectedArchitectureNode = "moments";
let newNodeKind: NodeKind = "Dense";
let architectureNodeCount = 0;
let architectureIoError: string | null = null;
let architectureTrainError: string | null = null;
let architectureTraining = false;
let architectureEpoch = 0;
let architectureLoss: number | null = null;
let architectureFirstLoss: number | null = null;
let architectureActiveKind: ArchitectureKind = "npc";
let architectureTrainingRuns: Array<{ task: ArchitectureKind; seed: number; epochs: number; firstLoss: number; finalLoss: number; nodes: number }> = [];
const ARCHITECTURE_TRAINING_ID = "ml_architecture_demo";

let nextId = 0;
function freshId(prefix: string): string {
    nextId += 1;
    return `${prefix}_${nextId}`;
}

function makeInput(): MlNode {
    return { id: INPUT_ID, name: "Input (2)", nodeType: "Input", position: [40, 220], inputs: [], outputs: [{ id: "out", name: "out", pinType: "vec" }], properties: {} };
}
function makeOutput(): MlNode {
    return { id: OUTPUT_ID, name: "Output Dense", nodeType: "Output", position: [800, 220], inputs: [{ id: "in", name: "in", pinType: "vec" }], outputs: [{ id: "out", name: "out", pinType: "vec" }], properties: { units: 2, activation: "linear" } };
}
function makeLoss(): MlNode {
    return { id: LOSS_ID, name: "Loss (cross-entropy)", nodeType: "Loss", position: [1040, 220], inputs: [{ id: "in", name: "in", pinType: "vec" }], outputs: [], properties: {} };
}
function makeDense(pos: [number, number]): MlNode {
    const id = freshId("dense");
    return { id, name: "Dense", nodeType: "Dense", position: pos, inputs: [{ id: "in", name: "in", pinType: "vec" }], outputs: [{ id: "out", name: "out", pinType: "vec" }], properties: { units: 8, activation: "relu" } };
}

let nodes: MlNode[] = [makeInput(), makeDense([280, 220]), makeOutput(), makeLoss()];
let connections: MlConn[] = [];

// Connects Input -> hidden Dense nodes (in array order) -> Output -> Loss. A convenience default
// so a fresh graph (or one after adding/removing a hidden layer) is trainable without manually
// dragging every wire - manual rewiring via the editor still works and wins afterward.
function autoWireChain() {
    const hiddenIds = nodes.filter(n => n.nodeType === "Dense").map(n => n.id);
    const chain = [INPUT_ID, ...hiddenIds, OUTPUT_ID, LOSS_ID];
    connections = [];
    for (let i = 0; i < chain.length - 1; i++) {
        connections.push({ fromNode: chain[i], fromPin: "out", toNode: chain[i + 1], toPin: "in" });
    }
}
autoWireChain();

let dataset: typeof DATASETS[number] = "xor";
let epochs = 250;
const TRAINING_ID = "ml_demo";
let isTraining = false;
let latestEpoch = 0;
let latestLoss: number | null = null;
let latestAccuracy: number | null = null;
let trainError: string | null = null;
let firstLoss: number | null = null;
let activeDataset: typeof DATASETS[number] = dataset;
let activeHiddenUnits: number[] = [];
interface TrainingRun {
    dataset: string;
    seed: number;
    epochs: number;
    hiddenUnits: number[];
    firstLoss: number;
    finalLoss: number;
    accuracy: number;
}
let trainingRuns: TrainingRun[] = [];

function saveState() {
    addon.IO.save({ architectureKind, architecture, trainingRuns, architectureTrainingRuns }, { pretty: true });
}

function startArchitectureTraining() {
    architectureTrainError = null;
    architectureLoss = null;
    architectureFirstLoss = null;
    architectureEpoch = 0;
    const validation = validateArchitecture(architecture);
    if (validation.errors.length) { architectureTrainError = validation.errors[0]; return; }
    try {
        Entropy.ML.trainArchitecture(ARCHITECTURE_TRAINING_ID, {
            graph: architecture, task: architectureKind,
            epochs: architectureKind === "mini_pic" ? 3 : architectureKind === "pet" ? 12 : 24,
            lr: architectureKind === "mini_pic" ? 0.005 : 0.02, seed: 42,
        });
        architectureActiveKind = architectureKind;
        architectureTraining = true;
    } catch (error) { architectureTrainError = String(error); }
}

function pollArchitectureTraining() {
    if (!architectureTraining) return;
    for (const update of Entropy.ML.pollArchitecture(ARCHITECTURE_TRAINING_ID)) {
        if (update.error) { architectureTraining = false; architectureTrainError = update.error; break; }
        if (architectureFirstLoss === null) architectureFirstLoss = update.loss;
        architectureEpoch = update.epoch;
        architectureLoss = update.loss;
        if (update.done) {
            architectureTraining = false;
            architectureTrainingRuns.push({ task: architectureActiveKind, seed: 42, epochs: update.epoch,
                firstLoss: architectureFirstLoss!, finalLoss: update.loss, nodes: architecture.nodes.length });
            try { saveState(); } catch (error) { architectureTrainError = `Could not save training result: ${error}`; }
        }
    }
}

function cycle<T>(options: readonly T[], current: T): T {
    return options[(options.indexOf(current) + 1) % options.length];
}

function startTraining() {
    trainError = null;
    latestEpoch = 0;
    latestLoss = null;
    latestAccuracy = null;
    firstLoss = null;
    activeDataset = dataset;
    activeHiddenUnits = nodes.filter(n => n.nodeType === "Dense").map(n => n.properties.units ?? 8);

    const graphNodes = nodes.map(n => {
        if (n.nodeType === "Input") return { kind: "Input", id: n.id, size: 2 };
        if (n.nodeType === "Loss") return { kind: "Loss", id: n.id };
        // Output is a Dense node too, from the trainer's point of view - the visual distinction
        // (fixed units, can't be deleted) is purely a UI convenience so a fresh graph always has
        // a valid, dataset-matching final layer.
        return { kind: "Dense", id: n.id, units: n.properties.units, activation: n.properties.activation };
    });
    const links = connections.map(c => ({ from: c.fromNode, to: c.toNode }));

    try {
        Entropy.ML.trainGraph(TRAINING_ID, {
            nodes: graphNodes as any,
            links,
            dataset,
            epochs,
            lr: dataset === "two_moons" ? 0.02 : 0.05,
            seed: 42,
        });
        isTraining = true;
    } catch (e) {
        trainError = String(e);
    }
}

function pollTraining() {
    if (!isTraining) return;
    const updates = Entropy.ML.poll(TRAINING_ID);
    for (const u of updates) {
        if (firstLoss === null) firstLoss = u.loss;
        latestEpoch = u.epoch;
        latestLoss = u.loss;
        if (u.accuracy !== undefined && u.accuracy !== null) latestAccuracy = u.accuracy;
        if (u.done) {
            isTraining = false;
            if (firstLoss !== null && latestAccuracy !== null) {
                trainingRuns.push({ dataset: activeDataset, seed: 42, epochs: u.epoch, hiddenUnits: activeHiddenUnits, firstLoss, finalLoss: u.loss, accuracy: latestAccuracy });
                try { saveState(); } catch (error) { trainError = `Could not save training result: ${error}`; }
            }
        }
    }
}

function setupUI() {
    const win = Entropy.UI.createWindow({
        title: "ML Graph Trainer",
        width: 1180,
        height: 880,
        x: 20,
        y: 20,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    pollTraining();
    pollArchitectureTraining();

    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.button(win, { id: "ml_view_trainer", text: "MLP Trainer", onClick: () => { view = "trainer"; } });
        Entropy.UI.Widget.button(win, { id: "ml_view_architecture", text: "Model Architectures", onClick: () => { view = "architecture"; } });
    });
    if (view === "architecture") {
        renderArchitectureUI(win);
        return;
    }

    Entropy.UI.Widget.label(win, { text: "ML Graph Trainer", bold: true });
    Entropy.UI.Widget.label(win, { text: "Wire Input -> Dense -> Output -> Loss, then Train. Burn runs on a background thread." });

    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.button(win, {
            id: "ml_add_dense", text: "+ Dense Layer", onClick: () => {
                const hiddenCount = nodes.filter(n => n.nodeType === "Dense").length;
                nodes.push(makeDense([280 + hiddenCount * 220, 220]));
                autoWireChain();
            }
        });
        Entropy.UI.Widget.button(win, {
            text: "- Remove Last Dense", onClick: () => {
                const hidden = nodes.filter(n => n.nodeType === "Dense");
                const last = hidden[hidden.length - 1];
                if (last) {
                    nodes = nodes.filter(n => n.id !== last.id);
                    connections = connections.filter(c => c.fromNode !== last.id && c.toNode !== last.id);
                    autoWireChain();
                }
            }
        });
        Entropy.UI.Widget.button(win, { text: "Auto-Wire Chain", onClick: autoWireChain });
        Entropy.UI.Widget.button(win, { id: "ml_dataset", text: `Dataset: ${dataset}`, onClick: () => { dataset = cycle(DATASETS, dataset); } });
        Entropy.UI.Widget.numericInput(win, { id: "ml_epochs", label: "Epochs", value: epochs, onChange: (v) => { epochs = Math.max(10, Math.round(parseFloat(v))); } });
        Entropy.UI.Widget.button(win, { id: "ml_train", text: isTraining ? "Training..." : "Train", onClick: () => { if (!isTraining) startTraining(); } });
    });
    Entropy.UI.Widget.separator(win);

    Entropy.UI.Widget.horizontal(win, () => {
        for (const n of nodes.filter(n => n.nodeType === "Dense")) {
            Entropy.UI.Widget.numericInput(win, {
                label: `${n.id}: units`,
                value: n.properties.units ?? 8,
                onChange: (v) => { n.properties!.units = Math.max(1, Math.round(parseFloat(v))); }
            });
            Entropy.UI.Widget.button(win, {
                text: `${n.id}: ${n.properties.activation}`,
                onClick: () => { n.properties.activation = cycle(ACTIVATIONS, (n.properties.activation as any) ?? "relu"); }
            });
        }
    });
    Entropy.UI.Widget.separator(win);

    if (trainError) {
        Entropy.UI.Widget.label(win, { text: `Error: ${trainError}` });
    } else if (latestLoss !== null) {
        if (!isTraining) Entropy.UI.Widget.label(win, { text: "ML training completed" });
        const accStr = latestAccuracy !== null ? `   accuracy = ${(latestAccuracy * 100).toFixed(1)}%` : "";
        const statusStr = isTraining ? "training..." : "done";
        Entropy.UI.Widget.label(win, { text: `[${statusStr}] epoch ${latestEpoch}/${epochs}   loss = ${latestLoss.toFixed(6)}${accStr}` });
    } else {
        Entropy.UI.Widget.label(win, { text: "Not trained yet." });
    }

    // Live node titles - Dense/Output nodes show their current config, Loss shows the running
    // loss value, same trick node_graph_addon.ts uses for the calculator's live values.
    for (const n of nodes) {
        if (n.nodeType === "Dense") n.name = `Dense (${n.properties.units}, ${n.properties.activation})`;
        if (n.nodeType === "Output") n.name = `Output Dense (${n.properties.units}, ${n.properties.activation})`;
        if (n.nodeType === "Loss") n.name = latestLoss !== null ? `Loss = ${latestLoss.toFixed(4)}` : "Loss (cross-entropy)";
    }

    Entropy.UI.Widget.snarl(win, {
        id: "ml_graph",
        height: 420,
        graph: { nodes, connections },
        onConnect: (params) => {
            const [fromNode, fromPin, toNode, toPin] = params;
            connections = connections.filter(c => !(c.toNode === toNode && c.toPin === toPin));
            connections.push({ fromNode, fromPin, toNode, toPin });
        },
        onDisconnect: (params) => {
            const [fromNode, fromPin, toNode, toPin] = params;
            connections = connections.filter(c => !(c.fromNode === fromNode && c.fromPin === fromPin && c.toNode === toNode && c.toPin === toPin));
        },
        onNodeMoved: (nodeId, position) => {
            const n = nodes.find(n => n.id === nodeId);
            if (n) n.position = position;
        }
    });
}

function renderArchitectureUI(win: string) {
    const validation = validateArchitecture(architecture);
    Entropy.UI.Widget.label(win, { text: architecture.name, bold: true });
    Entropy.UI.Widget.label(win, { text: "Select nodes to edit; drag wires to rewire. Use Tiny Config for fast CPU training." });
    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.button(win, { id: "ml_preset", text: `Preset: ${architectureKind}`, onClick: () => {
            architectureKind = cycle(ARCHITECTURES, architectureKind);
            architecture = GRAPH_FACTORIES[architectureKind]();
            selectedArchitectureNode = architecture.nodes[0].id;
        } });
        Entropy.UI.Widget.button(win, { id: "ml_reset_preset", text: "Reset Preset", onClick: () => {
            architecture = GRAPH_FACTORIES[architectureKind]();
            selectedArchitectureNode = architecture.nodes[0].id;
        } });
        Entropy.UI.Widget.button(win, { id: "ml_save_graph", text: "Save Graph", onClick: () => {
            try { saveState(); architectureIoError = null; }
            catch (error) { architectureIoError = String(error); }
        } });
        Entropy.UI.Widget.button(win, { id: "ml_load_graph", text: "Load Graph", onClick: () => {
            try {
                const saved = addon.IO.load();
                if (!saved || !saved.architecture || !Array.isArray(saved.architecture.nodes) || !Array.isArray(saved.architecture.links)) throw new Error("No saved architecture graph");
                if (!saved.architecture.nodes.every((n: any) => n && typeof n.id === "string" && Object.prototype.hasOwnProperty.call(NODE_DEFINITIONS, n.kind) && Array.isArray(n.position) && n.position.length === 2 && n.position.every(Number.isFinite) && n.config && typeof n.config === "object")) throw new Error("Saved graph has invalid nodes");
                if (!saved.architecture.links.every((l: any) => l && [l.from, l.output, l.to, l.input].every((v: any) => typeof v === "string"))) throw new Error("Saved graph has invalid links");
                architecture = saved.architecture as ArchitectureGraph;
                architectureKind = ARCHITECTURES.includes(saved.architectureKind) ? saved.architectureKind : "npc";
                trainingRuns = Array.isArray(saved.trainingRuns) ? saved.trainingRuns : [];
                architectureTrainingRuns = Array.isArray(saved.architectureTrainingRuns) ? saved.architectureTrainingRuns : [];
                selectedArchitectureNode = architecture.nodes[0]?.id ?? "";
                architectureIoError = null;
            } catch (error) { architectureIoError = String(error); }
        } });
    });
    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.button(win, { id: "ml_arch_tiny", text: "Tiny Config", onClick: () => {
            architecture = tinyArchitecture(architecture, architectureKind);
        } });
        Entropy.UI.Widget.button(win, { id: "ml_arch_train", text: architectureTraining ? "Training..." : "Train Architecture", onClick: () => {
            if (!architectureTraining) startArchitectureTraining();
        } });
    });
    Entropy.UI.Widget.label(win, { text: architectureTraining ? "Architecture training in progress"
        : architectureLoss === null ? "Architecture ready to train" : "Architecture training completed" });
    if (architectureLoss !== null) Entropy.UI.Widget.label(win, { text: `${architectureEpoch} epochs, loss ${architectureLoss.toFixed(4)}` });
    if (architectureTrainError) Entropy.UI.Widget.label(win, { text: `Architecture training error: ${architectureTrainError}` });
    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.button(win, { text: `New kind: ${newNodeKind}`, onClick: () => { newNodeKind = cycle(NODE_KINDS, newNodeKind); } });
        Entropy.UI.Widget.button(win, { text: "+ Node", onClick: () => {
            const id = `new_${++architectureNodeCount}`;
            architecture.nodes.push({ id, kind: newNodeKind, position: [200, 100], config: defaultArchitectureConfig(newNodeKind) });
            selectedArchitectureNode = id;
        } });
        Entropy.UI.Widget.button(win, { text: "Delete Selected", onClick: () => {
            architecture.nodes = architecture.nodes.filter(n => n.id !== selectedArchitectureNode);
            architecture.links = architecture.links.filter(l => l.from !== selectedArchitectureNode && l.to !== selectedArchitectureNode);
            selectedArchitectureNode = architecture.nodes[0]?.id ?? "";
        } });
    });
    const selected = architecture.nodes.find(n => n.id === selectedArchitectureNode);
    if (selected) {
        Entropy.UI.Widget.label(win, { text: `${selected.id}: ${NODE_DEFINITIONS[selected.kind].help}` });
        Entropy.UI.Widget.horizontal(win, () => {
            for (const [property, value] of Object.entries(selected.config)) {
                if (typeof value === "number") {
                    Entropy.UI.Widget.numericInput(win, { label: property, value, onChange: (raw) => {
                        const next = Number(raw);
                        if (Number.isFinite(next)) selected.config[property] = next;
                    } });
                } else {
                    if (property === "activation") Entropy.UI.Widget.button(win, {
                        text: `${property}: ${value}`,
                        onClick: () => { selected.config.activation = cycle(ACTIVATIONS, value as typeof ACTIVATIONS[number]); },
                    });
                    else Entropy.UI.Widget.label(win, { text: `${property}: ${value}` });
                }
            }
        });
    }
    Entropy.UI.Widget.label(win, { text: validation.errors.length ? "Graph invalid" : "Graph valid" });
    Entropy.UI.Widget.label(win, { text: validation.errors.length
        ? `Graph errors (${validation.errors.length}): ${validation.errors.slice(0, 3).join("; ")}`
        : `Valid tensor shapes across ${architecture.nodes.length} nodes and ${architecture.links.length} links.` });
    if (architectureIoError) Entropy.UI.Widget.label(win, { text: `Graph file: ${architectureIoError}` });
    const visualNodes = architecture.nodes.map(n => ({
        id: n.id,
        name: `${n.kind} ${Object.entries(validation.shapes).filter(([k]) => k.startsWith(`${n.id}.`)).map(([k, s]) => `${k.split(".")[1]} [${s.join(",")}]`).join(" ")}`,
        nodeType: n.kind,
        position: n.position,
        inputs: NODE_DEFINITIONS[n.kind].inputs.map(id => ({ id, name: id, pinType: "tensor" })),
        outputs: NODE_DEFINITIONS[n.kind].outputs.map(id => ({ id, name: id, pinType: "tensor" })),
        properties: n.config,
    }));
    Entropy.UI.Widget.snarl(win, {
        id: "ml_architecture_graph",
        height: 420,
        graph: { nodes: visualNodes, connections: architecture.links.map(l => ({ fromNode: l.from, fromPin: l.output, toNode: l.to, toPin: l.input })) },
        onNodeSelected: (id) => { selectedArchitectureNode = id; },
        onConnect: ([from, output, to, input]) => {
            architecture.links = architecture.links.filter(l => !(l.to === to && l.input === input));
            architecture.links.push({ from, output, to, input });
        },
        onDisconnect: ([from, output, to, input]) => {
            architecture.links = architecture.links.filter(l => !(l.from === from && l.output === output && l.to === to && l.input === input));
        },
        onNodeMoved: (id, position) => {
            const n = architecture.nodes.find(n => n.id === id);
            if (n) n.position = position;
        },
    });
}

function defaultArchitectureConfig(kind: NodeKind): Record<string, number | string> {
    switch (kind) {
        case "SequenceInput": return { steps: 16, features: 24 };
        case "TokenInput": return { steps: 32 };
        case "ImageInput": return { channels: 3, height: 64, width: 64 };
        case "LSTM": return { hidden: 256 };
        case "Dropout": return { probability: 0.2 };
        case "Dense": return { units: 64, activation: "relu" };
        case "Embedding": return { width: 256, vocabSize: 8192 };
        case "CausalAttention": case "SpatialSelfAttention2d": case "CrossAttention2d": return { heads: 4 };
        case "SparseMoE": return { experts: 4, topK: 1, hidden: 1024 };
        case "TimeEmbedding": return { width: 128 };
        case "TextEncoder": return { width: 128, layers: 4, heads: 4, vocabSize: 8192 };
        case "Conv2d": case "ResBlock2d": return { channels: 64 };
        default: return {};
    }
}

addon.onInit(async () => {
    setupUI();
});
