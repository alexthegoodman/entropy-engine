import { DEFAULT_NEAR_DISTANCE, LOGIC_KINDS, LOGIC_LABELS, SURFACE_TARGET_KINDS, TRIGGER_KINDS, logicNode, logicProblems, validateLogic } from "./canvas_logic";
import type { LogicGraph, LogicKind, LogicWire } from "./canvas_logic";

let selected = "";
let error = "";
/** Only the graph is document state. Selection and validation feedback belong to the editor. */
export function renderLogicEditor(win: string, graph: LogicGraph, surfaces: { id: string; name: string }[], clips: { id: string; name: string }[], edit: (change: () => void) => void, preferredSurfaceId: string | null): void {
    const W = Entropy.UI.Widget;
    const button = (id: string, text: string, onClick: () => void) => W.button(win, { id, text, onClick });
    W.label(win, { text: "Gameplay logic: connect an event to actions. Drag pins to wire, click a wire to remove, drag empty space to pan." });
    // Two rows keep the graph itself on screen: events (which start a chain), then actions.
    const addButtons = (kinds: readonly LogicKind[]) => W.horizontal(win, () => {
        for (const kind of kinds) button(`logic_add_${kind}`, `+ ${LOGIC_LABELS[kind]}`, () => edit(() => {
            if (graph.nodes.length >= 128) { error = "Maximum 128 nodes."; return; }
            const n = logicNode(Entropy.generateUUID(), kind, [30 + graph.nodes.length % 3 * 220, 30 + Math.floor(graph.nodes.length / 3) * 110]);
            if (SURFACE_TARGET_KINDS.includes(kind)) n.target = preferredSurfaceId ?? surfaces[0]?.id ?? "";
            if (kind === "clip") n.target = clips[0]?.id ?? "";
            graph.nodes.push(n); selected = n.id; error = "";
        }));
    });
    addButtons(LOGIC_KINDS.filter(k => TRIGGER_KINDS.includes(k)));
    addButtons(LOGIC_KINDS.filter(k => !TRIGGER_KINDS.includes(k)));
    const node = graph.nodes.find(n => n.id === selected) ?? graph.nodes[0];
    if (node) {
        W.horizontal(win, () => {
            W.dropdown(win, { id: "logic_node", label: "Edit node", options: graph.nodes.map((n, i) => `${i + 1}. ${LOGIC_LABELS[n.kind]}`), selectedIndex: graph.nodes.indexOf(node), onChange: v => { selected = graph.nodes[Number(v)]?.id ?? ""; } });
            if (SURFACE_TARGET_KINDS.includes(node.kind) || node.kind === "clip") {
                const targets = node.kind === "clip" ? clips : surfaces;
                W.dropdown(win, { id: "logic_target", label: node.kind === "clip" ? "Animation" : "Surface", options: ["Choose...", ...targets.map(t => t.name)], selectedIndex: targets.findIndex(t => t.id === node.target) + 1, onChange: v => edit(() => { node.target = targets[Number(v) - 1]?.id ?? ""; }) });
            }
            if (node.kind === "message") W.textInput(win, { id: "logic_message", label: "Message", value: node.text, onChange: v => edit(() => { node.text = v.slice(0, 500); }) });
            if (node.kind === "interact") W.textInput(win, { id: "logic_prompt", label: "Prompt", value: node.text, onChange: v => edit(() => { node.text = v.slice(0, 60); }) });
            if (node.kind === "wait") W.slider(win, { id: "logic_wait", label: "Seconds", value: node.seconds, min: 0.05, max: 60, onChange: v => { const seconds = Number(v); if (Number.isFinite(seconds)) edit(() => { node.seconds = Math.max(0.05, Math.min(60, seconds)); }); } });
            if (node.kind === "near" || node.kind === "interact") W.slider(win, { id: "logic_distance", label: "Distance", value: node.amount ?? DEFAULT_NEAR_DISTANCE, min: 0.25, max: 20, onChange: v => { const d = Number(v); if (Number.isFinite(d)) edit(() => { node.amount = Math.max(0.25, Math.min(20, d)); }); } });
            if (node.kind === "add" || node.kind === "check") {
                W.textInput(win, { id: "logic_counter", label: "Counter", value: node.variable ?? "", onChange: v => edit(() => { node.variable = v.slice(0, 40); }) });
                W.slider(win, { id: "logic_amount", label: node.kind === "add" ? "Add" : "Amount", value: node.amount ?? 1, min: node.kind === "add" ? -20 : 0, max: 100, onChange: v => { const a = Number(v); if (Number.isFinite(a)) edit(() => { node.amount = Math.round(a); }); } });
            }
            if (node.kind === "check") button("logic_op", node.op === "<" ? "Only if fewer than" : "Only if at least", () => edit(() => { node.op = node.op === "<" ? ">=" : "<"; }));
            button("logic_delete", "Delete node", () => edit(() => { graph.nodes = graph.nodes.filter(n => n.id !== node.id); graph.connections = graph.connections.filter(c => c.fromNode !== node.id && c.toNode !== node.id); selected = ""; }));
        });
    }
    const problems = logicProblems(graph, surfaces.map(s => s.id), clips.map(c => c.id));
    W.label(win, { text: error || problems[0] || (graph.nodes.length ? "Ready. Logic runs only after Play." : "Start with When Play starts or When surface clicked, then add an action.") });
    const caption = (id: string) => surfaces.find(s => s.id === id)?.name ?? clips.find(c => c.id === id)?.name ?? "Choose target";
    const output = (n: LogicGraph["nodes"][number]): string => {
        switch (n.kind) {
            case "click": case "clip": case "show": case "hide": case "teleport": return caption(n.target);
            case "near": case "interact": return `${caption(n.target)} < ${n.amount ?? DEFAULT_NEAR_DISTANCE}`;
            case "message": return n.text;
            case "wait": return `After ${n.seconds}s`;
            case "add": return `${n.variable ?? ""} ${(n.amount ?? 1) >= 0 ? "+" : ""}${n.amount ?? 1}`;
            case "check": return `${n.variable ?? ""} ${n.op === "<" ? "<" : ">="} ${n.amount ?? 1}`;
            default: return "Then";
        }
    };
    W.snarl(win, {
        id: "canvas_logic",
        onNodeSelected: id => { selected = id; },
        graph: {
            selectedNode: node?.id,
            nodes: graph.nodes.map((n, i) => ({ id: n.id, name: `${i + 1}. ${LOGIC_LABELS[n.kind]}`, nodeType: n.kind,
                position: n.position,
                inputs: TRIGGER_KINDS.includes(n.kind) ? [] : [{ id: "in", name: "Do", pinType: "event" }],
                outputs: [{ id: "next", name: output(n).slice(0, 24), pinType: "event" }], properties: {} })),
            connections: graph.connections,
        },
        onConnect: ([fromNode, fromPin, toNode, toPin]) => {
            const wire: LogicWire = { fromNode, fromPin, toNode, toPin };
            const candidate = { ...graph, connections: [...graph.connections, wire] };
            try { validateLogic(candidate); edit(() => { graph.connections = candidate.connections; }); error = ""; }
            catch (e) { error = (e as Error).message; }
        },
        onDisconnect: ([fromNode, fromPin, toNode, toPin]) => edit(() => { graph.connections = graph.connections.filter(c => !(c.fromNode === fromNode && c.fromPin === fromPin && c.toNode === toNode && c.toPin === toPin)); error = ""; }),
        onNodeMoved: (id, position) => { if (position.every(Number.isFinite)) edit(() => { const n = graph.nodes.find(n => n.id === id); if (n) n.position = position; }); },
    });
}
