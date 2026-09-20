/** Serializable event graph shared by the editor and runtime. */
export const LOGIC_KINDS = ["start", "click", "once", "clip", "wait", "message"] as const;
export type LogicKind = typeof LOGIC_KINDS[number];
export const LOGIC_LABELS: Record<LogicKind, string> = { start: "When Play starts", click: "When surface clicked", once: "Once per play", clip: "Play animation", wait: "Wait", message: "Show message" };
export interface LogicNode { id: string; kind: LogicKind; position: [number, number]; target: string; text: string; seconds: number; }
export interface LogicWire { fromNode: string; fromPin: string; toNode: string; toPin: string; }
export interface LogicGraph { nodes: LogicNode[]; connections: LogicWire[]; }
export const emptyLogic = (): LogicGraph => ({ nodes: [], connections: [] });
export function logicNode(id: string, kind: LogicKind, position: [number, number]): LogicNode {
    return { id, kind, position, target: "", text: "Hello!", seconds: 1 };
}

/** Imported graphs may have incomplete targets, but cannot contain malformed wires or loops. */
export function validateLogic(value: unknown): asserts value is LogicGraph {
    const g = value as LogicGraph;
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.connections) || g.nodes.length > 128 || g.connections.length > 256) throw new Error("Invalid logic graph.");
    const ids = new Set<string>();
    for (const n of g.nodes) {
        if (!n || typeof n.id !== "string" || !n.id || ids.has(n.id) || !LOGIC_KINDS.includes(n.kind) || !Array.isArray(n.position) || n.position.length !== 2 || !n.position.every(Number.isFinite) || typeof n.target !== "string" || typeof n.text !== "string" || n.text.length > 500 || !Number.isFinite(n.seconds) || n.seconds < 0.05 || n.seconds > 60) throw new Error("Invalid logic node.");
        ids.add(n.id);
    }
    const seen = new Set<string>();
    for (const c of g.connections) {
        const destination = g.nodes.find(n => n.id === c?.toNode);
        const signature = JSON.stringify(c);
        if (!c || !ids.has(c.fromNode) || !destination || ["start", "click"].includes(destination.kind) || c.fromPin !== "next" || c.toPin !== "in" || seen.has(signature)) throw new Error("Invalid logic connection.");
        seen.add(signature);
    }
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => {
        if (visiting.has(id)) throw new Error("Logic loops are not supported. Remove the returning wire.");
        if (visited.has(id)) return;
        visiting.add(id);
        for (const c of g.connections.filter(c => c.fromNode === id)) visit(c.toNode);
        visiting.delete(id); visited.add(id);
    };
    for (const n of g.nodes) visit(n.id);
}
export function logicProblems(graph: LogicGraph, surfaces: string[], clips: string[]): string[] {
    try { validateLogic(graph); } catch (e) { return [(e as Error).message]; }
    return graph.nodes.flatMap(n => n.kind === "click" && !surfaces.includes(n.target) ? ["Choose a surface for When surface clicked."] : n.kind === "clip" && !clips.includes(n.target) ? ["Choose an animation for Play animation."] : []);
}

/** Fresh per Play: bounded work, deterministic waits, no eval or wall-clock timers. */
export class LogicSession {
    private elapsed = 0;
    private used = new Set<string>();
    private pending: { id: string; due: number }[] = [];
    active = false;
    constructor(private graph: LogicGraph, private effect: (node: LogicNode) => void) { validateLogic(graph); }
    start(): void { this.stop(); this.active = true; this.dispatch("start"); }
    stop(): void { this.active = false; this.pending = []; this.used.clear(); this.elapsed = 0; }
    click(surface: string): void { if (this.active) this.dispatch("click", surface); }
    tick(delta: number): void {
        if (!this.active || !Number.isFinite(delta) || delta < 0) return;
        this.elapsed += delta;
        const ready = this.pending.filter(p => p.due <= this.elapsed);
        this.pending = this.pending.filter(p => p.due > this.elapsed);
        for (const p of ready) this.follow(p.id);
    }
    private dispatch(kind: LogicKind, target?: string): void {
        for (const n of this.graph.nodes) if (n.kind === kind && (target === undefined || n.target === target)) this.follow(n.id);
    }
    private follow(id: string): void {
        const queue = this.graph.connections.filter(c => c.fromNode === id).map(c => c.toNode);
        let budget = 512;
        while (this.active && queue.length && budget-- > 0) {
            const next = queue.shift();
            const n = this.graph.nodes.find(n => n.id === next)!;
            if (n.kind === "once") { if (this.used.has(n.id)) continue; this.used.add(n.id); }
            if (n.kind === "wait") {
                if (this.pending.length >= 256) { this.stop(); throw new Error("Too many waiting actions. Add Once per play before repeated clicks."); }
                this.pending.push({ id: n.id, due: this.elapsed + n.seconds }); continue;
            }
            if (n.kind === "clip" || n.kind === "message") this.effect(n);
            queue.push(...this.graph.connections.filter(c => c.fromNode === n.id).map(c => c.toNode));
        }
        if (queue.length) { this.stop(); throw new Error("Too many connected actions in one event."); }
    }
}
