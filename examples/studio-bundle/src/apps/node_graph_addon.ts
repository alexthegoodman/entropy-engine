// Nocode Calculator - the exercise addon for `entropy_gui::NodeGraphEditor`, the real
// interactive node graph editor added this session (replacing the read-only fallback that
// used to live at src/entropy_gui/widgets_node_graph.rs). Built entirely on the pre-existing
// `Entropy.UI.Widget.snarl(...)` / `BehaviorGraph` API - `SnarlConfig`'s `onConnect`/
// `onDisconnect`/`onNodeMoved` callbacks (examples/studio-bundle/src/addon.d.ts) and their
// `SNARL_CONNECT`/`SNARL_DISCONNECT`/`SNARL_NODE_MOVED` event parsing
// (src/deno/addon_setup.js's `snarl()`) already existed; this is the first addon to actually
// exercise them, since the widget they depended on used to be read-only.
//
// The addon owns the graph (`nodes`/`connections`), re-evaluates it every frame, and writes
// each node's live computed value straight into its title - proving the editor is good for
// more than drawing boxes: this is a small but genuine nocode program (drag a Number node's
// value, and the Add/Multiply/Output nodes downstream visibly recompute).

interface GPin { id: string; name: string; pinType: string; }
interface GNode {
    id: string;
    name: string;
    nodeType: "Number" | "Add" | "Multiply" | "Output";
    position: [number, number];
    inputs: GPin[];
    outputs: GPin[];
    properties: { value?: number };
}
interface GConn { fromNode: string; fromPin: string; toNode: string; toPin: string; }

const addonInfo = {
    name: "Nocode Calculator",
    version: "1.0.0",
    description: "A tiny visual-scripting calculator exercising the real NodeGraphEditor",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

let nextId = 0;
function freshId(prefix: string): string {
    nextId += 1;
    return `${prefix}_${nextId}`;
}

function makeNode(nodeType: GNode["nodeType"], pos: [number, number], value?: number): GNode {
    const id = freshId(nodeType.toLowerCase());
    switch (nodeType) {
        case "Number":
            return { id, name: "Number", nodeType, position: pos, inputs: [], outputs: [{ id: "value", name: "value", pinType: "number" }], properties: { value: value ?? 1 } };
        case "Add":
            return { id, name: "Add", nodeType, position: pos, inputs: [{ id: "a", name: "a", pinType: "number" }, { id: "b", name: "b", pinType: "number" }], outputs: [{ id: "sum", name: "sum", pinType: "number" }], properties: {} };
        case "Multiply":
            return { id, name: "Multiply", nodeType, position: pos, inputs: [{ id: "a", name: "a", pinType: "number" }, { id: "b", name: "b", pinType: "number" }], outputs: [{ id: "product", name: "product", pinType: "number" }], properties: {} };
        case "Output":
            return { id, name: "Output", nodeType, position: pos, inputs: [{ id: "value", name: "value", pinType: "number" }], outputs: [], properties: {} };
    }
}

const numA = makeNode("Number", [40, 40], 3);
const numB = makeNode("Number", [40, 160], 4);
const numC = makeNode("Number", [40, 280], 2);
const add = makeNode("Add", [280, 100]);
const mul = makeNode("Multiply", [520, 190]);
const out = makeNode("Output", [760, 190]);

let nodes: GNode[] = [numA, numB, numC, add, mul, out];
let connections: GConn[] = [
    { fromNode: numA.id, fromPin: "value", toNode: add.id, toPin: "a" },
    { fromNode: numB.id, fromPin: "value", toNode: add.id, toPin: "b" },
    { fromNode: add.id, fromPin: "sum", toNode: mul.id, toPin: "a" },
    { fromNode: numC.id, fromPin: "value", toNode: mul.id, toPin: "b" },
    { fromNode: mul.id, fromPin: "product", toNode: out.id, toPin: "value" },
];

// Recomputes every node's value from its inputs' connections. No cycle detection - a cycle
// would just recurse forever, which is an accepted gap for a v1 demo graph small enough to
// build by hand (see the post's decision log).
function evaluate(): Map<string, number> {
    const values = new Map<string, number>();
    function valueAt(nodeId: string, pinId: string): number {
        const conn = connections.find(c => c.toNode === nodeId && c.toPin === pinId);
        return conn ? computeNode(conn.fromNode) : 0;
    }
    function computeNode(nodeId: string): number {
        const cached = values.get(nodeId);
        if (cached !== undefined) return cached;
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return 0;
        let v = 0;
        if (node.nodeType === "Number") v = node.properties.value ?? 0;
        else if (node.nodeType === "Add") v = valueAt(nodeId, "a") + valueAt(nodeId, "b");
        else if (node.nodeType === "Multiply") v = valueAt(nodeId, "a") * valueAt(nodeId, "b");
        else if (node.nodeType === "Output") v = valueAt(nodeId, "value");
        values.set(nodeId, v);
        return v;
    }
    for (const n of nodes) computeNode(n.id);
    return values;
}

function setupUI() {
    const win = Entropy.UI.createWindow({
        title: "Nocode Calculator",
        width: 1040,
        height: 620,
        x: 20,
        y: 20,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    Entropy.UI.Widget.label(win, { text: "Nocode Calculator", bold: true });
    Entropy.UI.Widget.label(win, { text: "Drag nodes, drag between pins to connect, click a wire to delete it, scroll to zoom." });

    Entropy.UI.Widget.horizontal(win, () => {
        for (const n of nodes.filter(n => n.nodeType === "Number")) {
            Entropy.UI.Widget.numericInput(win, {
                label: n.name,
                value: n.properties.value ?? 0,
                onChange: (v) => { n.properties.value = parseFloat(v); }
            });
        }
        Entropy.UI.Widget.button(win, { text: "+ Number", onClick: () => nodes.push(makeNode("Number", [40, 40 + nodes.length * 24], 1)) });
        Entropy.UI.Widget.button(win, { text: "+ Add", onClick: () => nodes.push(makeNode("Add", [300, 40 + nodes.length * 24])) });
        Entropy.UI.Widget.button(win, { text: "+ Multiply", onClick: () => nodes.push(makeNode("Multiply", [300, 40 + nodes.length * 24])) });
        Entropy.UI.Widget.button(win, { text: "+ Output", onClick: () => nodes.push(makeNode("Output", [760, 40 + nodes.length * 24])) });
    });
    Entropy.UI.Widget.separator(win);

    const values = evaluate();
    for (const n of nodes) {
        const v = values.get(n.id) ?? 0;
        const base = n.nodeType === "Number" ? `Number` : n.nodeType;
        n.name = n.nodeType === "Output" ? `Output = ${v.toFixed(2)}` : `${base} = ${v.toFixed(2)}`;
    }

    Entropy.UI.Widget.snarl(win, {
        id: "calc_graph",
        graph: { nodes, connections },
        onConnect: (params) => {
            const [fromNode, fromPin, toNode, toPin] = params;
            // An input pin accepts at most one incoming wire - a fresh connection replaces
            // whatever was already feeding that pin.
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
