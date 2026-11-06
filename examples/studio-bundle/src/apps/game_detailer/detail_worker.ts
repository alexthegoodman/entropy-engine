// Background Mesha evaluation for the Game World Detailer (Entropy.Worker), bundled on its own
// as dist/game_detailer_worker.js and run in a separate JavaScript isolate on an engine worker
// thread, as Allegiance evaluates its houses: a house takes 10-150 ms to evaluate, a person more,
// and none of it may hold a frame. Each job evaluates one model variant, makes its levels of
// detail and writes them straight into the mesh cache; the Detailer sees the keys go "ready".

import { buildModelLods } from "./detail_mesh";
import type { ModelJob } from "./detail_jobs";

interface WorkerApi {
    MeshCache: { put: (namespace: string, key: string, vertices: Float32Array, indices: Uint32Array, meta: string, options: unknown) => void };
}
const host = (globalThis as unknown as { EntropyWorker: WorkerApi }).EntropyWorker;

(globalThis as unknown as { onJob: (job: ModelJob) => unknown }).onJob = (job: ModelJob) => {
    const built = buildModelLods(job.objectId, job.values, job.keys.length);
    const meta = { center: built.center, radius: built.radius, triangles: built.lods.map((l) => l.triangles), ms: built.ms };
    // Coarsest first: the viewport can draw something far away while the rest is written.
    for (let i = job.keys.length - 1; i >= 0; i--) {
        const m = built.lods[Math.min(i, built.lods.length - 1)];
        host.MeshCache.put(job.namespace, job.keys[i], m.vertexData, m.indexData, JSON.stringify(meta), {});
    }
    return meta;
};
