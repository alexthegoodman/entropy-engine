// Instanced people. Every visible person of one body variant (one Entropy.MeshCache key: sex,
// level of detail and gear) is an instance of a single mesh: the people shader (al_shader.ts)
// reads each instance's record from a storage buffer by @builtin(instance_index). A frame packs
// the visible people into their batches and writes each batch with one buffer write, so a crowd
// costs a handful of draws and uploads instead of one mesh, two uniforms and a write per person,
// and changing someone's level of detail moves them to another batch rather than spawning a mesh.
//
// The batching itself (growth, idle cleanup, shared geometry) is qp_instances.ts, which houses use too.

import { InstanceBatches, type InstanceEngine, type InstanceOptions, type InstanceStats } from "../../apps/quadplanet/qp_instances";

/** Floats per person record: model matrix (16), shirt rgb + limb swing (4), pants rgb + stride
 * phase (4; negative: aiming), skin (4), hair (4). Must match PersonRecord in al_shader.ts. */
export const PERSON_FLOATS = 32;

export type CrowdEngine = InstanceEngine;
export type CrowdStats = InstanceStats;

/** People batches: InstanceBatches of PERSON_FLOATS records (qp_instances.ts). */
export class CrowdBatches extends InstanceBatches {
    constructor(engine: CrowdEngine, options: InstanceOptions = {}) {
        super(engine, PERSON_FLOATS, options);
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
