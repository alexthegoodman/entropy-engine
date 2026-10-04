// Instanced people. Every visible person of one body variant (one Entropy.MeshCache key: sex,
// level of detail and gear) is an instance of a single mesh: the people shader (al_shader.ts)
// reads each instance's record from a storage buffer by @builtin(instance_index). A frame packs
// the visible people into their batches and writes each batch with one buffer write, so a crowd
// costs a handful of draws and uploads instead of one mesh, two uniforms and a write per person,
// and changing someone's level of detail moves them to another batch rather than spawning a mesh.
//
// Batches keep their mesh and buffer while empty (instance count 0 skips the draw), and are only
// destroyed after `idleFrames` unused frames or by `clear`. A batch that outgrows its capacity is
// rebuilt at twice the size. All geometry of one key is shared on the GPU (MeshCache.createMesh).

/** Floats per person record: model matrix (16), shirt rgb + limb swing (4), pants rgb + stride
 * phase (4; negative: aiming), skin (4), hair (4). Must match PersonRecord in al_shader.ts. */
export const PERSON_FLOATS = 32;

/** The engine calls batches need (the addon passes Entropy's; tests pass fakes). */
export interface CrowdEngine {
    createBuffer: (bytes: number) => string;
    destroyBuffer: (id: string) => void;
    writeBuffer: (id: string, data: Float32Array) => void;
    /** Spawns the cached mesh `key` drawing `instances` records from `buffer`; false if it isn't cached. */
    createMesh: (key: string, meshId: string, buffer: string, instances: number) => boolean;
    clearMesh: (meshId: string) => void;
    setInstanceCount: (meshId: string, count: number) => void;
}

interface Batch {
    key: string;
    data: Float32Array;
    count: number;
    /** GPU side: the live mesh and its buffer's capacity (records), and the instance count it draws. */
    meshId: string;
    buffer: string;
    gpuCapacity: number;
    drawn: number;
    idle: number;
}

export interface CrowdStats { batches: number; drawnBatches: number; instances: number; uploads: number; rebuilds: number }

export class CrowdBatches {
    private batches = new Map<string, Batch>();
    private serial = 0;
    private rebuilds = 0;
    lastStats: CrowdStats = { batches: 0, drawnBatches: 0, instances: 0, uploads: 0, rebuilds: 0 };

    constructor(private engine: CrowdEngine, private options: { initialCapacity?: number; idleFrames?: number; onMissing?: (key: string) => void; prefix?: string } = {}) {}

    /** Starts a frame: every batch empties. */
    begin(): void {
        for (const b of this.batches.values()) b.count = 0;
    }

    /** Appends a person to `key`'s batch; returns the array and offset of its record to fill. */
    add(key: string): { data: Float32Array; offset: number } {
        let b = this.batches.get(key);
        if (!b) {
            b = { key, data: new Float32Array((this.options.initialCapacity ?? 16) * PERSON_FLOATS), count: 0, meshId: "", buffer: "", gpuCapacity: 0, drawn: 0, idle: 0 };
            this.batches.set(key, b);
        }
        if ((b.count + 1) * PERSON_FLOATS > b.data.length) {
            const grown = new Float32Array(b.data.length * 2);
            grown.set(b.data);
            b.data = grown;
        }
        const offset = b.count++ * PERSON_FLOATS;
        return { data: b.data, offset };
    }

    /** Uploads this frame's records: one buffer write per non-empty batch. */
    flush(): CrowdStats {
        const stats: CrowdStats = { batches: this.batches.size, drawnBatches: 0, instances: 0, uploads: 0, rebuilds: this.rebuilds };
        const idleFrames = this.options.idleFrames ?? 600;
        for (const b of [...this.batches.values()]) {
            if (b.count === 0) {
                if (b.drawn !== 0 && b.meshId) { this.engine.setInstanceCount(b.meshId, 0); b.drawn = 0; }
                if (++b.idle > idleFrames) this.destroy(b);
                continue;
            }
            b.idle = 0;
            const capacity = b.data.length / PERSON_FLOATS;
            if (!b.meshId || b.gpuCapacity < b.count) {
                this.release(b);
                b.buffer = this.engine.createBuffer(capacity * PERSON_FLOATS * 4);
                b.gpuCapacity = capacity;
                // The records go in first, so the mesh's first frame draws them.
                this.engine.writeBuffer(b.buffer, b.data.subarray(0, b.count * PERSON_FLOATS));
                stats.uploads++;
                const meshId = `${this.options.prefix ?? "crowd"}-${this.serial++}`;
                if (!this.engine.createMesh(b.key, meshId, b.buffer, b.count)) {
                    this.destroy(b);
                    this.options.onMissing?.(b.key);
                    continue;
                }
                b.meshId = meshId;
                b.drawn = b.count;
                this.rebuilds++;
            } else {
                this.engine.writeBuffer(b.buffer, b.data.subarray(0, b.count * PERSON_FLOATS));
                stats.uploads++;
                if (b.drawn !== b.count) { this.engine.setInstanceCount(b.meshId, b.count); b.drawn = b.count; }
            }
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

    private release(b: Batch): void {
        if (b.meshId) this.engine.clearMesh(b.meshId);
        if (b.buffer) this.engine.destroyBuffer(b.buffer);
        b.meshId = ""; b.buffer = ""; b.gpuCapacity = 0; b.drawn = 0;
    }

    private destroy(b: Batch): void {
        this.release(b);
        this.batches.delete(b.key);
    }
}

/**
 * A conservative view test for a person (bounding sphere `radius` around `center`): false only
 * when they are certainly behind the camera or outside a 66 degree cone (a 16:9 view with a 75
 * degree vertical field of view reaches 57 degrees in its corners). `forward` is unit length.
 */
export function maybeVisible(camera: readonly number[], forward: readonly number[], center: readonly number[], radius = 1.2, halfAngle = 1.15): boolean {
    const dx = center[0] - camera[0], dy = center[1] - camera[1], dz = center[2] - camera[2];
    const d = Math.hypot(dx, dy, dz);
    if (d <= radius * 2) return true;
    const cos = (dx * forward[0] + dy * forward[1] + dz * forward[2]) / d;
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    return angle <= halfAngle + Math.asin(Math.min(1, radius / d));
}
