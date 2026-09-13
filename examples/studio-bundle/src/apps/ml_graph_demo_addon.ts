// ML Graph Trainer - visual node-graph editor that compiles into a real Burn model.
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
// Two hand-picked hidden-node choices (uses NumericInput's drag-to-change and a cycling button
// for activation/dataset, not a dropdown - this GUI kit's dropdown payload format wasn't worth
// depending on for a same-session demo when the existing NumericInput/cycling-button pattern
// already proven by doc_editor_demo_addon.ts covers the same need).

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
    description: "Build a small MLP visually and train a real Burn model on a background thread",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const INPUT_ID = "in";
const OUTPUT_ID = "out";
const LOSS_ID = "loss";
const ACTIVATIONS = ["relu", "tanh", "sigmoid", "linear"] as const;
const DATASETS = ["xor", "two_moons"] as const;

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

function cycle<T>(options: readonly T[], current: T): T {
    return options[(options.indexOf(current) + 1) % options.length];
}

function startTraining() {
    trainError = null;
    latestEpoch = 0;
    latestLoss = null;
    latestAccuracy = null;

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
            lr: dataset === "xor" ? 0.05 : 0.02
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
        latestEpoch = u.epoch;
        latestLoss = u.loss;
        if (u.accuracy !== undefined && u.accuracy !== null) latestAccuracy = u.accuracy;
        if (u.done) isTraining = false;
    }
}

function setupUI() {
    const win = Entropy.UI.createWindow({
        title: "ML Graph Trainer",
        width: 1220,
        height: 780,
        x: 20,
        y: 20,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    pollTraining();

    Entropy.UI.Widget.label(win, { text: "ML Graph Trainer", bold: true });
    Entropy.UI.Widget.label(win, { text: "Add hidden Dense layers, wire Input -> hidden -> Output -> Loss (or click Auto-Wire), then Train. This compiles to a real Burn MLP trained on a background thread - nothing here is simulated in JS." });

    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.button(win, {
            text: "+ Dense Layer", onClick: () => {
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
        Entropy.UI.Widget.button(win, { text: `Dataset: ${dataset}`, onClick: () => { dataset = cycle(DATASETS, dataset); } });
        Entropy.UI.Widget.numericInput(win, { label: "Epochs", value: epochs, onChange: (v) => { epochs = Math.max(10, Math.round(parseFloat(v))); } });
        Entropy.UI.Widget.button(win, { text: isTraining ? "Training..." : "Train", onClick: () => { if (!isTraining) startTraining(); } });
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

addon.onInit(async () => {
    setupUI();
});
