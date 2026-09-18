/** Addon-owned rigid hierarchy. Matrices are row-major; no engine scene graph is required. */
export type V3 = [number, number, number];
export type Matrix = number[];
export interface Transform {
    position: V3; rotation: V3; scale: V3; pivot: V3;
}
export interface Group extends Transform { id: string; name: string; parentId: string | null; frame: Matrix; }
export interface Key { time: number; value: number; }
export type Channel = "x" | "y" | "z" | "pitch" | "yaw" | "roll" | "sx" | "sy" | "sz" | "progress" | "visible";
export interface Track { targetId: string; channel: Channel; keys: Key[]; }
export interface Clip { id: string; name: string; duration: number; tracks: Track[]; }
export const identity = (): Matrix => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const defaultTransform = (): Transform => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] });
export function multiply(a: Matrix, b: Matrix): Matrix {
    return Array.from({ length: 16 }, (_, i) => {
        const row = Math.floor(i / 4), col = i % 4;
        return [0, 1, 2, 3].reduce((sum, k) => sum + a[row * 4 + k] * b[k * 4 + col], 0);
    });
}
export function inverse(a: Matrix): Matrix {
    const rows = Array.from({ length: 4 }, (_, r) => [...a.slice(r * 4, r * 4 + 4), ...identity().slice(r * 4, r * 4 + 4)]);
    for (let c = 0; c < 4; c++) {
        let pivot = c;
        for (let r = c + 1; r < 4; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
        if (Math.abs(rows[pivot][c]) < 1e-10) throw new Error("Transform is not invertible.");
        [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
        const divisor = rows[c][c]; rows[c] = rows[c].map(v => v / divisor);
        for (let r = 0; r < 4; r++) if (r !== c) {
            const factor = rows[r][c]; rows[r] = rows[r].map((v, k) => v - factor * rows[c][k]);
        }
    }
    return rows.flatMap(row => row.slice(4));
}
export function point(m: Matrix, p: V3): V3 {
    return [0, 1, 2].map(r => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]) as V3;
}
export function normal(m: Matrix, n: V3, inv = inverse(m)): V3 {
    const v = [0, 1, 2].map(c => inv[c] * n[0] + inv[4 + c] * n[1] + inv[8 + c] * n[2]);
    const length = Math.hypot(...v) || 1;
    return v.map(x => x / length) as V3;
}
export function transformMatrix(t: Transform): Matrix {
    const [x, y, z] = t.rotation, [cx, cy, cz] = [Math.cos(x), Math.cos(y), Math.cos(z)], [sx, sy, sz] = [Math.sin(x), Math.sin(y), Math.sin(z)];
    const rx = [1,0,0,0, 0,cx,-sx,0, 0,sx,cx,0, 0,0,0,1];
    const ry = [cy,0,sy,0, 0,1,0,0, -sy,0,cy,0, 0,0,0,1];
    const rz = [cz,-sz,0,0, sz,cz,0,0, 0,0,1,0, 0,0,0,1];
    const scale = identity(); scale[0] = t.scale[0]; scale[5] = t.scale[1]; scale[10] = t.scale[2];
    const m = multiply(multiply(multiply(ry, rx), rz), scale);
    const offset = point(m, t.pivot);
    for (let i = 0; i < 3; i++) m[i * 4 + 3] = t.position[i] + t.pivot[i] - offset[i];
    return m;
}
export function sample(track: Track, time: number): number {
    const keys = track.keys;
    if (!keys.length) throw new Error("Animation track has no keys.");
    if (time <= keys[0].time) return keys[0].value;
    for (let i = 1; i < keys.length; i++) if (time < keys[i].time) {
        const a = keys[i - 1], b = keys[i];
        return track.channel === "visible" ? a.value : a.value + (b.value - a.value) * (time - a.time) / (b.time - a.time);
    }
    return keys[keys.length - 1].value;
}
export function animatedTransform(base: Transform, id: string, clip: Clip | null, time: number): Transform {
    const result: Transform = { position: [...base.position], rotation: [...base.rotation], scale: [...base.scale], pivot: [...base.pivot] };
    const channels = { x: ["position", 0], y: ["position", 1], z: ["position", 2], pitch: ["rotation", 0], yaw: ["rotation", 1], roll: ["rotation", 2], sx: ["scale", 0], sy: ["scale", 1], sz: ["scale", 2] } as const;
    for (const track of clip?.tracks ?? []) if (track.targetId === id && track.channel in channels) {
        const [property, index] = channels[track.channel as keyof typeof channels]; result[property][index] = sample(track, time);
    }
    return result;
}
export function groupWorld(groups: Group[], id: string | null, clip: Clip | null = null, time = 0, seen = new Set<string>()): Matrix {
    if (!id) return identity();
    if (seen.has(id)) throw new Error("Groups cannot contain themselves.");
    seen.add(id);
    const g = groups.find(g => g.id === id);
    if (!g) throw new Error("Parent group is missing.");
    return multiply(groupWorld(groups, g.parentId, clip, time, seen), multiply(g.frame, transformMatrix(animatedTransform(g, g.id, clip, time))));
}
/** Preserve the current world pose, including shear from scaled ancestors, without decomposing it. */
export function reparentFrame(groups: Group[], id: string, oldParent: string | null, parent: string | null, frame: Matrix): Matrix {
    let cursor = parent;
    while (cursor) {
        if (cursor === id) throw new Error("Groups cannot contain themselves.");
        const g = groups.find(g => g.id === cursor);
        if (!g) throw new Error("Parent group is missing.");
        cursor = g.parentId;
    }
    return multiply(inverse(groupWorld(groups, parent)), multiply(groupWorld(groups, oldParent), frame));
}
export function setKey(clip: Clip, targetId: string, channel: Channel, time: number, value: number): void {
    let track = clip.tracks.find(t => t.targetId === targetId && t.channel === channel);
    if (!track) { track = { targetId, channel, keys: [] }; clip.tracks.push(track); }
    track.keys = [...track.keys.filter(k => Math.abs(k.time - time) > 1e-6), { time, value }].sort((a, b) => a.time - b.time);
}

/** Evaluated brush samples retain pressure/tilt's effect exactly, independent of future brush settings. */
export interface Stamp { x: number; y: number; radius: number; alpha: number; angle: number; elongation: number; }
export interface RetainedStroke {
    id: string; name: string; layerId: string; visible: boolean; progress: number;
    brush: { color: V3; softness: number; isEraser: boolean };
    stamps: Stamp[];
}
