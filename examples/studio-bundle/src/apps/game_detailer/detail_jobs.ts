// Models on demand. The viewport asks for a Mesha variant (object + values); the store says
// whether its meshes are in the mesh cache yet and, if not, gets them made:
//
// - in a background worker (detail_worker.ts through Entropy.Worker), a few jobs at a time, as
//   Allegiance evaluates its houses, so a 100 ms evaluation never holds a frame;
// - else on this thread, at most one evaluation per frame and none closer than `minBuildIntervalMs`
//   to the last, so a cold level shows up over a few seconds instead of freezing;
// - nearest first: each frame's wants carry a priority (the distance), and the queue is re-sorted.
//
// The mesh cache is on disk, so a level opened before comes up from the cache immediately.
// Builtins (walls, wells, docks) are cheap and made here when first wanted.

import type { ParamValues } from "../mesha/mesha_object";
import { buildModelLods, builtinKey, builtinMesh, variantKey, type PackedMesh } from "./detail_mesh";
import type { BuiltinShape } from "./detail_scene";

export const DETAIL_NAMESPACE = "game-detailer";
export const LOD_COUNT = 3;

export interface ModelJob {
    namespace: string;
    objectId: string;
    values: ParamValues;
    /** Cache keys, LOD 0 first. */
    keys: string[];
}

export interface ModelInfo {
    /** LOD cache keys, best first. */
    keys: string[];
    state: "queued" | "building" | "ready" | "failed";
    center: [number, number, number];
    radius: number;
    triangles: number[];
    error?: string;
}

/** What the store needs from the engine (the addon passes Entropy's; tests pass fakes). */
export interface ModelEngine {
    status: (namespace: string, key: string) => "ready" | "pending" | "missing";
    put: (namespace: string, key: string, mesh: PackedMesh, meta: unknown) => void;
    meta: (namespace: string, key: string) => unknown;
    /** Starts a background job; null when there is no worker (evaluate here instead). */
    startJob?: (job: ModelJob) => number | null;
    pollJob?: (id: number) => { status: "pending" | "done" | "failed" | "unknown"; error?: string };
    now: () => number;
}

export interface ModelStoreOptions {
    maxInFlight?: number;
    minBuildIntervalMs?: number;
}

interface Pending { variant: string; objectId: string; values: ParamValues; priority: number }

const parseMeta = (m: unknown): any => (typeof m === "string" ? (() => { try { return JSON.parse(m); } catch { return null; } })() : m);

export class ModelStore {
    private infos = new Map<string, ModelInfo>();
    private queue = new Map<string, Pending>();
    private running = new Map<number, string>();
    private lastLocalBuild = -Infinity;
    private workerBroken = false;
    /** Evaluations finished (here or in a worker), for the stats line. */
    built = 0;

    constructor(private engine: ModelEngine, private options: ModelStoreOptions = {}) {}

    /** The variant's id (its LOD 0 key without the level). */
    static variantOf(objectId: string, values: ParamValues): string {
        return variantKey(objectId, values, 0);
    }

    /** The model's info, asking for it to be made (priority: lower is sooner). */
    want(objectId: string, values: ParamValues, priority = 0): ModelInfo {
        const variant = ModelStore.variantOf(objectId, values);
        let info = this.infos.get(variant);
        if (info) {
            if (info.state === "queued") {
                const q = this.queue.get(variant);
                if (q && priority < q.priority) q.priority = priority;
            }
            return info;
        }
        const keys = Array.from({ length: LOD_COUNT }, (_, l) => variantKey(objectId, values, l));
        info = { keys, state: "queued", center: [0, 0, 0], radius: 1, triangles: [] };
        this.infos.set(variant, info);
        if (this.readFromCache(info)) return info;
        this.queue.set(variant, { variant, objectId, values, priority });
        return info;
    }

    /** A builtin's single-LOD info, made now if it isn't cached. */
    wantBuiltin(shape: BuiltinShape): ModelInfo {
        const key = builtinKey(shape);
        let info = this.infos.get(key);
        if (info) return info;
        info = { keys: [key], state: "queued", center: [0, 0, 0], radius: 1, triangles: [] };
        this.infos.set(key, info);
        if (!this.readFromCache(info)) {
            const m = builtinMesh(shape);
            const meta = { center: [m.bounds[0], m.bounds[1], m.bounds[2]], radius: m.bounds[3], triangles: [m.triangles] };
            this.engine.put(DETAIL_NAMESPACE, key, m, meta);
            this.applyMeta(info, meta);
            info.state = "ready";
        }
        return info;
    }

    private readFromCache(info: ModelInfo): boolean {
        if (!info.keys.every((k) => this.engine.status(DETAIL_NAMESPACE, k) === "ready")) return false;
        const meta = parseMeta(this.engine.meta(DETAIL_NAMESPACE, info.keys[0]));
        if (!meta) return false;
        this.applyMeta(info, meta);
        info.state = "ready";
        return true;
    }

    private applyMeta(info: ModelInfo, meta: any): void {
        info.center = meta.center ?? [0, 0, 0];
        info.radius = meta.radius ?? 1;
        info.triangles = meta.triangles ?? [];
    }

    /** Variants waiting or being made. */
    get pending(): number {
        return this.queue.size + this.running.size;
    }

    /** Starts and collects work; call once a frame. Returns how many models became ready. */
    pump(): number {
        let ready = 0;
        // Collect finished jobs.
        for (const [id, variant] of [...this.running]) {
            const r = this.engine.pollJob?.(id);
            if (!r || r.status === "pending") continue;
            this.running.delete(id);
            const info = this.infos.get(variant);
            if (!info) continue;
            if (r.status === "done" && this.readFromCache(info)) { ready++; this.built++; continue; }
            // A failed job (or a worker that couldn't load): evaluate here instead.
            info.state = "queued";
            const parts = variant.split("|");
            this.queue.set(variant, { variant, objectId: parts[1], values: this.valuesOf(variant), priority: -1 });
            if (r.status === "unknown") this.workerBroken = true;
        }
        if (!this.queue.size) return ready;
        const order = [...this.queue.values()].sort((a, b) => a.priority - b.priority);
        const maxInFlight = this.options.maxInFlight ?? 3;
        for (const p of order) {
            if (this.running.size >= maxInFlight) break;
            if (this.workerBroken || !this.engine.startJob) break;
            const info = this.infos.get(p.variant)!;
            let id: number | null = null;
            try { id = this.engine.startJob({ namespace: DETAIL_NAMESPACE, objectId: p.objectId, values: p.values, keys: info.keys }); } catch { id = null; }
            if (id === null) { this.workerBroken = true; break; }
            this.queue.delete(p.variant);
            this.running.set(id, p.variant);
            this.pendingValues.set(p.variant, p.values);
            info.state = "building";
        }
        // No worker: one evaluation here, spaced out.
        if ((this.workerBroken || !this.engine.startJob) && this.queue.size) {
            const now = this.engine.now();
            if (now - this.lastLocalBuild >= (this.options.minBuildIntervalMs ?? 120)) {
                const p = [...this.queue.values()].sort((a, b) => a.priority - b.priority)[0];
                this.queue.delete(p.variant);
                const info = this.infos.get(p.variant)!;
                try {
                    const built = buildModelLods(p.objectId, p.values, info.keys.length);
                    const meta = { center: built.center, radius: built.radius, triangles: built.lods.map((l) => l.triangles), ms: built.ms };
                    info.keys.forEach((k, i) => this.engine.put(DETAIL_NAMESPACE, k, built.lods[Math.min(i, built.lods.length - 1)], meta));
                    this.applyMeta(info, meta);
                    info.state = "ready";
                    ready++;
                    this.built++;
                } catch (e) {
                    info.state = "failed";
                    info.error = (e as Error).message;
                }
                this.lastLocalBuild = this.engine.now();
            }
        }
        return ready;
    }

    /** Values of a running job, kept so a failed job can be redone here. */
    private pendingValues = new Map<string, ParamValues>();
    private valuesOf(variant: string): ParamValues {
        return this.pendingValues.get(variant) ?? {};
    }

    /** Forgets everything (the mesh cache keeps what was made). */
    reset(): void {
        this.infos.clear();
        this.queue.clear();
        this.running.clear();
    }

    info(objectId: string, values: ParamValues): ModelInfo | undefined {
        return this.infos.get(ModelStore.variantOf(objectId, values));
    }
}
