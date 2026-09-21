/** Serializable event graph shared by the editor and runtime. */
export const LOGIC_KINDS = ["start", "click", "near", "interact", "once", "clip", "wait", "message", "show", "hide", "add", "check", "teleport"] as const;
export type LogicKind = typeof LOGIC_KINDS[number];
export const LOGIC_LABELS: Record<LogicKind, string> = {
    start: "When Play starts", click: "When surface clicked", near: "When player is near", interact: "When player presses E near",
    once: "Once per play", clip: "Play animation", wait: "Wait", message: "Show message",
    show: "Show surface", hide: "Hide surface", add: "Change counter", check: "Only if counter", teleport: "Move player to",
};
/** Events start a chain: they have no input pin and cannot be the destination of a wire. */
export const TRIGGER_KINDS: readonly LogicKind[] = ["start", "click", "near", "interact"];
/** Kinds whose `target` is a surface or group id. */
export const SURFACE_TARGET_KINDS: readonly LogicKind[] = ["click", "near", "interact", "show", "hide", "teleport"];
export const DEFAULT_NEAR_DISTANCE = 1.5;
export type CounterOp = ">=" | "<";
/** `target` is a surface or group id (or a clip id for `clip`). `variable`/`amount`/`op` are optional so
 * graphs saved before counters existed stay valid. */
export interface LogicNode { id: string; kind: LogicKind; position: [number, number]; target: string; text: string; seconds: number; variable?: string; amount?: number; op?: CounterOp; }
export interface LogicWire { fromNode: string; fromPin: string; toNode: string; toPin: string; }
export interface LogicGraph { nodes: LogicNode[]; connections: LogicWire[]; }
export const emptyLogic = (): LogicGraph => ({ nodes: [], connections: [] });
export function logicNode(id: string, kind: LogicKind, position: [number, number]): LogicNode {
    const node: LogicNode = { id, kind, position, target: "", text: "Hello!", seconds: 1 };
    if (kind === "near" || kind === "interact") node.amount = DEFAULT_NEAR_DISTANCE;
    if (kind === "interact") node.text = "Interact";
    if (kind === "add") { node.variable = "items"; node.amount = 1; }
    if (kind === "check") { node.variable = "items"; node.amount = 1; node.op = ">="; }
    return node;
}

/** Imported graphs may have incomplete targets, but cannot contain malformed wires or loops. */
export function validateLogic(value: unknown): asserts value is LogicGraph {
    const g = value as LogicGraph;
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.connections) || g.nodes.length > 128 || g.connections.length > 256) throw new Error("Invalid logic graph.");
    const ids = new Set<string>();
    for (const n of g.nodes) {
        if (!n || typeof n.id !== "string" || !n.id || ids.has(n.id) || !LOGIC_KINDS.includes(n.kind) || !Array.isArray(n.position) || n.position.length !== 2 || !n.position.every(Number.isFinite) || typeof n.target !== "string" || typeof n.text !== "string" || n.text.length > 500 || !Number.isFinite(n.seconds) || n.seconds < 0.05 || n.seconds > 60) throw new Error("Invalid logic node.");
        if (n.variable !== undefined && (typeof n.variable !== "string" || n.variable.length > 40)) throw new Error("Invalid logic node.");
        if (n.amount !== undefined && (!Number.isFinite(n.amount) || Math.abs(n.amount) > 1e6)) throw new Error("Invalid logic node.");
        if (n.op !== undefined && n.op !== ">=" && n.op !== "<") throw new Error("Invalid logic node.");
        ids.add(n.id);
    }
    const seen = new Set<string>();
    for (const c of g.connections) {
        const destination = g.nodes.find(n => n.id === c?.toNode);
        const signature = JSON.stringify(c);
        if (!c || !ids.has(c.fromNode) || !destination || TRIGGER_KINDS.includes(destination.kind) || c.fromPin !== "next" || c.toPin !== "in" || seen.has(signature)) throw new Error("Invalid logic connection.");
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
/** `targets` are the ids a surface-target node may point at (surfaces and groups). */
export function logicProblems(graph: LogicGraph, targets: string[], clips: string[]): string[] {
    try { validateLogic(graph); } catch (e) { return [(e as Error).message]; }
    return graph.nodes.flatMap(n => {
        if (SURFACE_TARGET_KINDS.includes(n.kind) && !targets.includes(n.target)) return [`Choose a surface for ${LOGIC_LABELS[n.kind]}.`];
        if (n.kind === "clip" && !clips.includes(n.target)) return ["Choose an animation for Play animation."];
        if ((n.kind === "add" || n.kind === "check") && !(n.variable ?? "").trim()) return [`Name the counter for ${LOGIC_LABELS[n.kind]}.`];
        return [];
    });
}

/** Distance from the player to a target's nearest visible edge, or null when the target is gone or hidden. */
export type DistanceTo = (target: string) => number | null;

/** Fresh per Play: bounded work, deterministic waits, no eval or wall-clock timers. */
export class LogicSession {
    private elapsed = 0;
    private used = new Set<string>();
    private pending: { id: string; due: number }[] = [];
    private inside = new Set<string>();
    /** Counters changed by "Change counter" nodes. Fresh per Play, so Stop resets the game. */
    readonly vars = new Map<string, number>();
    active = false;
    constructor(private graph: LogicGraph, private effect: (node: LogicNode) => void) { validateLogic(graph); }
    start(): void { this.stop(); this.active = true; this.dispatch("start"); }
    stop(): void { this.active = false; this.pending = []; this.used.clear(); this.inside.clear(); this.vars.clear(); this.elapsed = 0; }
    click(surface: string | string[]): void { if (this.active) this.dispatch("click", Array.isArray(surface) ? surface : [surface]); }
    /** Replace `{counter}` in message text with the counter's current value. */
    format(text: string): string { return text.replace(/\{([^{}]{1,40})\}/g, (_m, name: string) => String(this.vars.get(name.trim()) ?? 0)); }
    tick(delta: number): void {
        if (!this.active || !Number.isFinite(delta) || delta < 0) return;
        this.elapsed += delta;
        const ready = this.pending.filter(p => p.due <= this.elapsed);
        this.pending = this.pending.filter(p => p.due > this.elapsed);
        for (const p of ready) this.follow(p.id);
    }
    /** Fires "When player is near" once each time the player walks into range; leaving re-arms it. */
    proximity(distanceTo: DistanceTo): void {
        if (!this.active) return;
        for (const n of this.graph.nodes) {
            if (n.kind !== "near") continue;
            const d = distanceTo(n.target);
            const inRange = d !== null && d <= (n.amount ?? DEFAULT_NEAR_DISTANCE);
            if (inRange && !this.inside.has(n.id)) { this.inside.add(n.id); this.follow(n.id); }
            else if (!inRange) this.inside.delete(n.id);
            if (!this.active) return;
        }
    }
    /** The "When player presses E near" nodes currently in range, nearest first (for the on-screen prompt). */
    interactables(distanceTo: DistanceTo): { node: LogicNode; distance: number }[] {
        const found: { node: LogicNode; distance: number }[] = [];
        for (const n of this.graph.nodes) {
            if (n.kind !== "interact") continue;
            const d = distanceTo(n.target);
            if (d !== null && d <= (n.amount ?? DEFAULT_NEAR_DISTANCE)) found.push({ node: n, distance: d });
        }
        return found.sort((a, b) => a.distance - b.distance);
    }
    /** Press E: runs every interact node in range. */
    interact(distanceTo: DistanceTo): void {
        if (!this.active) return;
        for (const { node } of this.interactables(distanceTo)) { this.follow(node.id); if (!this.active) return; }
    }
    private dispatch(kind: LogicKind, targets?: string[]): void {
        for (const n of this.graph.nodes) if (n.kind === kind && (targets === undefined || targets.includes(n.target))) this.follow(n.id);
    }
    private passes(n: LogicNode): boolean {
        const value = this.vars.get((n.variable ?? "").trim()) ?? 0, limit = n.amount ?? 1;
        return n.op === "<" ? value < limit : value >= limit;
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
            if (n.kind === "check" && !this.passes(n)) continue;
            if (n.kind === "add") { const name = (n.variable ?? "").trim(); this.vars.set(name, (this.vars.get(name) ?? 0) + (n.amount ?? 1)); }
            if (n.kind === "clip" || n.kind === "message" || n.kind === "show" || n.kind === "hide" || n.kind === "teleport") this.effect(n);
            queue.push(...this.graph.connections.filter(c => c.fromNode === n.id).map(c => c.toNode));
        }
        if (queue.length) { this.stop(); throw new Error("Too many connected actions in one event."); }
    }
}
