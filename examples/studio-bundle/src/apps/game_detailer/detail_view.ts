// What the viewport draws, decided without the engine (so it is tested): which level of detail an
// object gets for its distance and size, which ground tiles at which resolution, which things are
// out of view, how far each kind of thing is drawn at all, the triangle budget, and the instance
// records the shader reads. The ideas are the ones The Abyss and Allegiance settled on:
//
// - levels of detail by projected size (distance over the object's radius), scaled by a setting;
// - a triangle budget: once it is spent, the farthest things drop a level (people first in
//   Allegiance; here whatever is farthest);
// - a conservative view cone: things certainly behind the camera aren't packed at all;
// - small things are drawn while they cover a few pixels (grass some 80 m, people 250 m, trees and
//   houses to the far plane);
// - a still camera does no work: records are repacked only when the camera moved or turned
//   enough, or the scene changed.

import { RECORD_FLOATS } from "./detail_shader";

export type V3 = [number, number, number];

/** LOD for a thing of bounding `radius` (m) at `distance` (m); `levels` LODs exist. */
export function chooseLod(distance: number, radius: number, lodScale = 1, levels = 3): number {
    const r = Math.max(0.3, radius) * Math.max(0.1, lodScale);
    const near = r * 14, mid = r * 45;
    const lod = distance < near ? 0 : distance < mid ? 1 : 2;
    return Math.min(levels - 1, lod);
}

/**
 * How far (m) a thing of this size is drawn at all: while it still covers a few pixels (a radius
 * about 1/280 of its distance, some 3 px tall on a 1080p screen at the 45 degree field of view),
 * never closer than 70 m - a person, a shrub or a cart in front of the camera is always there.
 */
export function drawDistance(radius: number, lodScale = 1, farPlane = 1700): number {
    return Math.min(farPlane, Math.max(70, radius * 280) * Math.max(0.25, lodScale));
}

/** Ground tile resolution (quads per side) for a tile whose nearest point is `distanceM` away. */
export function tileResolution(distanceM: number): number {
    if (distanceM < 180) return 64;
    if (distanceM < 420) return 32;
    if (distanceM < 800) return 16;
    return 8;
}

/** False only when a sphere is certainly out of view (behind, or outside a wide cone ahead). */
export function maybeVisible(camera: V3, forward: V3, center: V3, radius: number, halfAngle = 1.2): boolean {
    const dx = center[0] - camera[0], dy = center[1] - camera[1], dz = center[2] - camera[2];
    const d = Math.hypot(dx, dy, dz);
    if (d <= radius * 1.5) return true;
    const cos = (dx * forward[0] + dy * forward[1] + dz * forward[2]) / d;
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    return angle <= halfAngle + Math.asin(Math.min(1, radius / d));
}

export interface Candidate {
    distance: number;
    lod: number;
    /** Triangles at each LOD. */
    triangles: number[];
}

/**
 * Demotes the farthest candidates one level at a time until the drawn triangles fit `budget`.
 * Returns the triangles drawn. Candidates are changed in place.
 */
export function budgetLods(candidates: Candidate[], budget: number): number {
    const tri = (c: Candidate) => c.triangles[Math.min(c.lod, c.triangles.length - 1)] ?? 0;
    let total = 0;
    for (const c of candidates) total += tri(c);
    if (total <= budget) return total;
    const order = candidates.slice().sort((a, b) => b.distance - a.distance);
    for (let pass = 0; pass < 2 && total > budget; pass++) {
        for (const c of order) {
            if (total <= budget) break;
            if (c.lod >= c.triangles.length - 1) continue;
            const before = tri(c);
            c.lod++;
            total += tri(c) - before;
        }
    }
    return total;
}

/**
 * Writes one instance record at `offset`: highlight rgb + strength, the model matrix (translate,
 * yaw about +Y, uniform scale; column-major), and flags (settle into the ground, sway).
 */
export function packRecord(out: Float32Array, offset: number, x: number, y: number, z: number, yaw: number, scale: number, highlight: readonly number[] | null, settle = 1, sway = 0): void {
    const c = Math.cos(yaw) * scale, s = Math.sin(yaw) * scale;
    const o = offset;
    out[o] = highlight?.[0] ?? 0; out[o + 1] = highlight?.[1] ?? 0; out[o + 2] = highlight?.[2] ?? 0; out[o + 3] = highlight?.[3] ?? 0;
    // Columns: x axis (c, 0, -s), y axis (0, scale, 0), z axis (s, 0, c), translation.
    out[o + 4] = c; out[o + 5] = 0; out[o + 6] = -s; out[o + 7] = 0;
    out[o + 8] = 0; out[o + 9] = scale; out[o + 10] = 0; out[o + 11] = 0;
    out[o + 12] = s; out[o + 13] = 0; out[o + 14] = c; out[o + 15] = 0;
    out[o + 16] = x; out[o + 17] = y; out[o + 18] = z; out[o + 19] = 1;
    out[o + 20] = settle; out[o + 21] = sway; out[o + 22] = 0; out[o + 23] = 0;
}

export const IDENTITY_RECORD = (() => {
    const r = new Float32Array(RECORD_FLOATS);
    packRecord(r, 0, 0, 0, 0, 0, 1, null, 0, 0);
    return r;
})();

/** Remembers the camera of the last repack: has it moved or turned enough to repack? */
export class ViewChange {
    private pos: V3 | null = null;
    private fwd: V3 = [0, 0, 1];
    private at = -Infinity;
    constructor(private moveM = 1.5, private turnRad = 0.06, private minMs = 90) {}
    /** True (and remembers this view) when a repack is due. `force`: the scene changed. */
    due(pos: V3, forward: V3, now: number, force = false): boolean {
        if (!force) {
            if (now - this.at < this.minMs) return false;
            if (this.pos) {
                const moved = Math.hypot(pos[0] - this.pos[0], pos[1] - this.pos[1], pos[2] - this.pos[2]);
                const turned = Math.acos(Math.max(-1, Math.min(1, forward[0] * this.fwd[0] + forward[1] * this.fwd[1] + forward[2] * this.fwd[2])));
                if (moved < this.moveM && turned < this.turnRad) return false;
            }
        }
        this.pos = [...pos];
        this.fwd = [...forward];
        this.at = now;
        return true;
    }
}

/** Yaw (radians about +Y) of a quaternion [x, y, z, w], ignoring any tilt. */
export function yawOf(q: readonly number[]): number {
    const [x, y, z, w] = q;
    // Rotate +Z by q, read its heading.
    const fx = 2 * (x * z + w * y), fz = 1 - 2 * (x * x + y * y);
    return Math.atan2(fx, fz);
}

export function yawQuat(yaw: number): [number, number, number, number] {
    return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}
