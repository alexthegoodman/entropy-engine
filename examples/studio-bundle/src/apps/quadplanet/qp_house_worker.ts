// Background house evaluation (Entropy.Worker): this file is bundled on its own
// (dist/qp_house_worker.js) and runs in a separate JavaScript isolate on an engine worker thread,
// so a Mesha evaluation (10-150 ms) never holds a frame. It evaluates one house per job and
// writes the meshes CityHouses would have written straight into the mesh cache; the game sees
// them go "pending" -> "ready" there. Nothing here touches the scene.

import { evaluateObject } from "../mesha/mesha_object";
import { lookupObject } from "../mesha/library";
import houseDef from "../mesha/library/house";
import { HOUSE_GENERATOR, HOUSE_NAMESPACE, LOD1_SIMPLIFY, packHouse, type HouseJob } from "./qp_city";

interface WorkerApi {
    MeshCache: { put: (namespace: string, key: string, vertices: Float32Array, indices: Uint32Array, meta: string, options: unknown) => void };
}
const host = (globalThis as unknown as { EntropyWorker: WorkerApi }).EntropyWorker;

(globalThis as unknown as { onJob: (job: HouseJob) => unknown }).onJob = (job: HouseJob) => {
    const e = evaluateObject(houseDef, job.values, lookupObject);
    let lod0 = 0, lod1 = 0;
    if (job.lod0Key) {
        const m = packHouse(e, 0);
        host.MeshCache.put(HOUSE_NAMESPACE, job.lod0Key, m.vertexData, m.indexData, JSON.stringify({ generator: HOUSE_GENERATOR }), { background: true });
        lod0 = m.triangles;
    }
    if (job.lod1Key) {
        const m = packHouse(e, 1);
        host.MeshCache.put(HOUSE_NAMESPACE, job.lod1Key, m.vertexData, m.indexData, JSON.stringify({ generator: HOUSE_GENERATOR, simplifiedFrom: m.triangles }), { simplify: LOD1_SIMPLIFY });
        lod1 = m.triangles;
    }
    return { lod0, lod1 };
};
