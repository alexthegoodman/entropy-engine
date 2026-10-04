import type { BindingEntry } from "../../addon";

// Instanced batches. Every instance of one cached mesh (one Entropy.MeshCache key) is drawn by a
// single engine mesh: the shader reads each instance's record from a storage buffer by
// @builtin(instance_index) (qp_shader.ts `instancedShader`). A caller packs records into a
// batch's reused Float32Array, and `flush` writes each batch with one buffer write, so N copies
// cost one draw and one upload instead of N meshes, N uniforms and N writes.
//
// Batches keep their mesh and buffer while empty (instance count 0 skips the draw) and are only
// destroyed after `idleFrames` flushes unused, or by `clear`. A batch that outgrows its capacity
// is rebuilt at twice the size. Callers that give each record a bounding sphere get a sphere
// around the whole batch handed to the engine (Model.setBounds), so a batch out of view is not
// drawn at all. The geometry of one key is shared on the GPU (MeshCache.createMesh).

/** The engine calls batches need (addons pass Entropy's; tests pass fakes). */
export interface InstanceEngine {
    createBuffer: (bytes: number) => string;
    destroyBuffer: (id: string) => void;
    writeBuffer: (id: string, data: Float32Array) => void;
    /** Spawns the cached mesh `key` drawing `instances` records from `buffer`; false if it isn't cached. */
    createMesh: (key: string, meshId: string, buffer: string, instances: number) => boolean;
    clearMesh: (meshId: string) => void;
    setInstanceCount: (meshId: string, count: number) => void;
    /** Render-space bounding sphere of everything the mesh draws; null: always drawn. */
    setBounds?: (meshId: string, center: [number, number, number] | null, radius: number) => void;
}

export interface InstanceOptions {
    initialCapacity?: number;
    /** Flushes a batch may stay empty before its mesh and buffer are destroyed. */
    idleFrames?: number;
    /** A key's mesh was missing from the cache (nothing was drawn for it). */
    onMissing?: (key: string) => void;
    /** Mesh ids are `${prefix}-${n}`. */
    prefix?: string;
}

interface Batch {
    key: string;
    data: Float32Array;
    count: number;
    /** Box around the bounding spheres added this frame (Infinity when none had one). */
    lo: [number, number, number];
    hi: [number, number, number];
    unbounded: boolean;
    /** GPU side: the live mesh, its buffer's capacity (records), the instance count it draws and the bounds it was given. */
    meshId: string;
    buffer: string;
    gpuCapacity: number;
    drawn: number;
    bounds: string;
    idle: number;
}

export interface InstanceStats { batches: number; drawnBatches: number; instances: number; uploads: number; rebuilds: number }

export class InstanceBatches {
    private batches = new Map<string, Batch>();
    private serial = 0;
    private rebuilds = 0;
    lastStats: InstanceStats = { batches: 0, drawnBatches: 0, instances: 0, uploads: 0, rebuilds: 0 };

    constructor(private engine: InstanceEngine, readonly recordFloats: number, private options: InstanceOptions = {}) {}

    /** Starts a frame: every batch empties. */
    begin(): void {
        for (const b of this.batches.values()) {
            b.count = 0;
            b.lo = [Infinity, Infinity, Infinity]; b.hi = [-Infinity, -Infinity, -Infinity];
            b.unbounded = false;
        }
    }

    /**
     * Appends an instance to `key`'s batch; returns the array and offset of its record to fill.
     * `sphere` ([x, y, z, radius], render space) lets the batch be culled as a whole; a batch
     * with any instance without one is always drawn.
     */
    add(key: string, sphere?: readonly number[]): { data: Float32Array; offset: number } {
        const f = this.recordFloats;
        let b = this.batches.get(key);
        if (!b) {
            b = { key, data: new Float32Array((this.options.initialCapacity ?? 16) * f), count: 0,
                lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], unbounded: false,
                meshId: "", buffer: "", gpuCapacity: 0, drawn: 0, bounds: "", idle: 0 };
            this.batches.set(key, b);
        }
        if ((b.count + 1) * f > b.data.length) {
            const grown = new Float32Array(b.data.length * 2);
            grown.set(b.data);
            b.data = grown;
        }
        if (sphere) {
            for (let i = 0; i < 3; i++) {
                b.lo[i] = Math.min(b.lo[i], sphere[i] - sphere[3]);
                b.hi[i] = Math.max(b.hi[i], sphere[i] + sphere[3]);
            }
        } else b.unbounded = true;
        const offset = b.count++ * f;
        return { data: b.data, offset };
    }

    /** Uploads this frame's records: one buffer write per non-empty batch. */
    flush(): InstanceStats {
        const f = this.recordFloats;
        const stats: InstanceStats = { batches: 0, drawnBatches: 0, instances: 0, uploads: 0, rebuilds: 0 };
        const idleFrames = this.options.idleFrames ?? 600;
        for (const b of [...this.batches.values()]) {
            if (b.count === 0) {
                if (b.drawn !== 0 && b.meshId) { this.engine.setInstanceCount(b.meshId, 0); b.drawn = 0; }
                if (++b.idle > idleFrames) this.destroy(b);
                continue;
            }
            b.idle = 0;
            const capacity = b.data.length / f;
            if (!b.meshId || b.gpuCapacity < b.count) {
                this.release(b);
                b.buffer = this.engine.createBuffer(capacity * f * 4);
                b.gpuCapacity = capacity;
                // The records go in first, so the mesh's first frame draws them.
                this.engine.writeBuffer(b.buffer, b.data.subarray(0, b.count * f));
                stats.uploads++;
                const meshId = `${this.options.prefix ?? "instances"}-${this.serial++}`;
                if (!this.engine.createMesh(b.key, meshId, b.buffer, b.count)) {
                    this.destroy(b);
                    this.options.onMissing?.(b.key);
                    continue;
                }
                b.meshId = meshId;
                b.drawn = b.count;
                this.rebuilds++;
            } else {
                this.engine.writeBuffer(b.buffer, b.data.subarray(0, b.count * f));
                stats.uploads++;
                if (b.drawn !== b.count) { this.engine.setInstanceCount(b.meshId, b.count); b.drawn = b.count; }
            }
            this.updateBounds(b);
            stats.drawnBatches++;
            stats.instances += b.count;
        }
        stats.batches = this.batches.size;
        stats.rebuilds = this.rebuilds;
        this.lastStats = stats;
        return stats;
    }

    /** Destroys every batch's mesh and buffer. */
    clear(): void {
        for (const b of [...this.batches.values()]) this.destroy(b);
    }

    private updateBounds(b: Batch): void {
        if (!this.engine.setBounds) return;
        let center: [number, number, number] | null = null, radius = -1;
        if (!b.unbounded && Number.isFinite(b.lo[0])) {
            center = [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2];
            radius = Math.hypot(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) / 2;
        }
        const tag = center ? `${center.map(v => v.toFixed(2)).join(",")},${radius.toFixed(2)}` : "none";
        if (tag === b.bounds) return;
        b.bounds = tag;
        this.engine.setBounds(b.meshId, center, radius);
    }

    private release(b: Batch): void {
        if (b.meshId) this.engine.clearMesh(b.meshId);
        if (b.buffer) this.engine.destroyBuffer(b.buffer);
        b.meshId = ""; b.buffer = ""; b.gpuCapacity = 0; b.drawn = 0; b.bounds = "";
    }

    private destroy(b: Batch): void {
        this.release(b);
        this.batches.delete(b.key);
    }
}

/**
 * An InstanceEngine on Entropy: batches spawn `namespace`'s cached meshes with `pipelineId`
 * (an instanced shader whose group 2 is the world uniform and the records' storage buffer).
 */
export function meshCacheInstances(namespace: string, pipelineId: () => string, worldBuffer: () => string): InstanceEngine {
    return {
        createBuffer: bytes => Entropy.Buffer.create({ size: bytes, usage: "Storage" }),
        destroyBuffer: id => Entropy.Buffer.destroy(id),
        writeBuffer: (id, data) => Entropy.Buffer.write(id, data),
        createMesh: (key, meshId, buffer, instances) => Entropy.MeshCache.createMesh(namespace, key, { id: meshId, pipelineId: pipelineId(), instanceCount: instances, bindings: [
            { group: 2, binding: 0, resource: { type: "Buffer", value: { id: worldBuffer() } } },
            { group: 2, binding: 1, resource: { type: "Buffer", value: { id: buffer } } },
        ] }),
        clearMesh: meshId => Entropy.Model.clearMesh(meshId),
        setInstanceCount: (meshId, count) => Entropy.Model.setInstanceCount(meshId, count),
        setBounds: (meshId, center, radius) => center ? Entropy.Model.setBounds(meshId, center, radius) : Entropy.Model.setBounds(meshId, null, -1),
    };
}

/** Group 2 of an instanced pipeline: the world uniform, then the records. */
export const INSTANCED_BIND_GROUPS: { entries: BindingEntry[] }[] = [{ entries: [
    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
    { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "StorageReadOnly" },
] }];

/** The house worker bundle (qp_house_worker.ts), relative to the working directory like the app bundles. */
export const HOUSE_WORKER_SCRIPT = "examples/studio-bundle/dist/qp_house_worker.js";
