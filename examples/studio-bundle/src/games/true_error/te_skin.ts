// Skeletal animation on the CPU: clips sampled per node (linear keys, quaternion nlerp), a crossfade
// from the previous clip, optional extra rotations on named bones (the upper body aiming), then
// linear blend skinning straight into the engine's 12-float vertex layout for Mesh.writeVertices.
//
// Meshy's rigs are Mixamo-named, 24 joints, under an "Armature" node scaled 0.01; their clips
// animate rotations everywhere and translation on the hips.

import { type GlbModel, type GlbClip, trs, mul } from "./te_glb";

export interface ClipState { clip: number; time: number; speed: number; loop: boolean }

/** A quaternion [x, y, z, w] for `angle` radians about a unit axis. */
export function axisAngle(axis: [number, number, number], angle: number): [number, number, number, number] {
    const s = Math.sin(angle / 2);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

function qmul(a: ArrayLike<number>, b: ArrayLike<number>, out: Float32Array, o: number): void {
    const [ax, ay, az, aw] = [a[0], a[1], a[2], a[3]], [bx, by, bz, bw] = [b[0], b[1], b[2], b[3]];
    out[o] = aw * bx + ax * bw + ay * bz - az * by;
    out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
    out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
    out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** Writes channel `ch` at time t into dst[o..]. */
function sample(times: Float32Array, values: Float32Array, width: number, step: boolean, t: number, dst: Float32Array, o: number): void {
    const n = times.length;
    if (n === 0) return;
    if (t <= times[0] || n === 1) { for (let c = 0; c < width; c++) dst[o + c] = values[c]; return; }
    if (t >= times[n - 1]) { for (let c = 0; c < width; c++) dst[o + c] = values[(n - 1) * width + c]; return; }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    const f = step ? 0 : (t - times[lo]) / Math.max(1e-6, times[hi] - times[lo]);
    if (width === 4) {
        let dot = 0;
        for (let c = 0; c < 4; c++) dot += values[lo * 4 + c] * values[hi * 4 + c];
        const sgn = dot < 0 ? -1 : 1;
        let l = 0;
        for (let c = 0; c < 4; c++) { const v = values[lo * 4 + c] * (1 - f) + values[hi * 4 + c] * f * sgn; dst[o + c] = v; l += v * v; }
        l = Math.sqrt(l) || 1;
        for (let c = 0; c < 4; c++) dst[o + c] /= l;
    } else {
        for (let c = 0; c < width; c++) dst[o + c] = values[lo * width + c] * (1 - f) + values[hi * width + c] * f;
    }
}

export class Skeleton {
    readonly nodes: number;
    /** Per node: translation (3), rotation (4), scale (3) - rest, then the posed result. */
    private restT: Float32Array; private restR: Float32Array; private restS: Float32Array;
    private T: Float32Array; private R: Float32Array; private S: Float32Array;
    private T2: Float32Array; private R2: Float32Array; private S2: Float32Array;
    /** World matrices of every node, 16 floats each. */
    readonly world: Float32Array;
    /** Skin matrices (joint world * inverse bind), 16 floats per joint. */
    readonly skinMats: Float32Array;
    private order: number[];
    private local = new Float32Array(16);
    private byName = new Map<string, number>();
    /** Bones whose rotation gets an extra (pre-multiplied, parent space) quaternion this frame. */
    readonly extra = new Map<number, [number, number, number, number]>();

    constructor(readonly model: GlbModel) {
        const n = this.nodes = model.nodes.length;
        this.restT = new Float32Array(n * 3); this.restR = new Float32Array(n * 4); this.restS = new Float32Array(n * 3);
        model.nodes.forEach((nd, i) => { this.restT.set(nd.t, i * 3); this.restR.set(nd.r, i * 4); this.restS.set(nd.s, i * 3); this.byName.set(nd.name, i); });
        this.T = this.restT.slice(); this.R = this.restR.slice(); this.S = this.restS.slice();
        this.T2 = this.restT.slice(); this.R2 = this.restR.slice(); this.S2 = this.restS.slice();
        this.world = new Float32Array(n * 16);
        this.skinMats = new Float32Array((model.skin?.joints.length ?? 0) * 16);
        // Parents before children.
        const order: number[] = [], seen = new Uint8Array(n);
        const visit = (i: number) => { if (seen[i]) return; const p = model.nodes[i].parent; if (p >= 0) visit(p); seen[i] = 1; order.push(i); };
        for (let i = 0; i < n; i++) visit(i);
        this.order = order;
    }

    node(name: string): number { return this.byName.get(name) ?? this.byName.get(`mixamorig:${name}`) ?? -1; }
    clipIndex(name: string): number { return this.model.clips.findIndex(c => c.name === name); }
    clip(i: number): GlbClip | undefined { return this.model.clips[i]; }

    private sampleInto(clip: GlbClip | undefined, time: number, T: Float32Array, R: Float32Array, S: Float32Array): void {
        T.set(this.restT); R.set(this.restR); S.set(this.restS);
        if (!clip) return;
        for (const ch of clip.channels) {
            if (ch.path === "rotation") sample(ch.times, ch.values, 4, ch.step, time, R, ch.node * 4);
            else if (ch.path === "translation") sample(ch.times, ch.values, 3, ch.step, time, T, ch.node * 3);
            else sample(ch.times, ch.values, 3, ch.step, time, S, ch.node * 3);
        }
    }

    /**
     * Poses the skeleton: clip `a` at its time, blended toward `b` (the clip being faded out) by
     * `fadeOut` (1 = all b). `rootLock` keeps the hips over the origin in x/z (the game moves the
     * character itself).
     */
    pose(a: ClipState, b: ClipState | null, fadeOut: number, rootLock = true): void {
        this.sampleInto(this.model.clips[a.clip], a.time, this.T, this.R, this.S);
        if (b && fadeOut > 0.001) {
            this.sampleInto(this.model.clips[b.clip], b.time, this.T2, this.R2, this.S2);
            const f = fadeOut;
            for (let i = 0; i < this.T.length; i++) { this.T[i] += (this.T2[i] - this.T[i]) * f; this.S[i] += (this.S2[i] - this.S[i]) * f; }
            for (let n = 0; n < this.nodes; n++) {
                const o = n * 4;
                let dot = 0;
                for (let c = 0; c < 4; c++) dot += this.R[o + c] * this.R2[o + c];
                const sgn = dot < 0 ? -1 : 1;
                let l = 0;
                for (let c = 0; c < 4; c++) { const v = this.R[o + c] * (1 - f) + this.R2[o + c] * f * sgn; this.R[o + c] = v; l += v * v; }
                l = Math.sqrt(l) || 1;
                for (let c = 0; c < 4; c++) this.R[o + c] /= l;
            }
        }
        if (rootLock) {
            const hips = this.node("Hips");
            if (hips >= 0) { this.T[hips * 3] = this.restT[hips * 3]; this.T[hips * 3 + 2] = this.restT[hips * 3 + 2]; }
        }
        for (const [node, q] of this.extra) qmul(q, this.R.subarray(node * 4, node * 4 + 4), this.R, node * 4);
        for (const i of this.order) {
            trs(this.local, 0, this.T.subarray(i * 3, i * 3 + 3), this.R.subarray(i * 4, i * 4 + 4), this.S.subarray(i * 3, i * 3 + 3));
            const p = this.model.nodes[i].parent;
            if (p >= 0) mul(this.world, i * 16, this.world, p * 16, this.local, 0);
            else this.world.set(this.local, i * 16);
        }
        const skin = this.model.skin;
        if (skin) skin.joints.forEach((j, k) => mul(this.skinMats, k * 16, this.world, j * 16, skin.inverseBind, k * 16));
    }

    /** A node's world position in model space (after `pose`). */
    position(node: number): [number, number, number] {
        const o = node * 16;
        return [this.world[o + 12], this.world[o + 13], this.world[o + 14]];
    }
}

/**
 * Skins the model's vertices by the skeleton's current pose into `out` (12 floats a vertex:
 * position, normal, uv, color white). Returns `out`.
 */
export function skinVertices(model: GlbModel, sk: Skeleton, out: Float32Array): Float32Array {
    const P = model.positions, N = model.normals, U = model.uvs, J = model.joints!, W = model.weights!, M = sk.skinMats;
    const n = P.length / 3;
    for (let v = 0; v < n; v++) {
        const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
        const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
        let x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
        for (let k = 0; k < 4; k++) {
            const w = W[v * 4 + k];
            if (w <= 0) continue;
            const m = J[v * 4 + k] * 16;
            x += w * (M[m] * px + M[m + 4] * py + M[m + 8] * pz + M[m + 12]);
            y += w * (M[m + 1] * px + M[m + 5] * py + M[m + 9] * pz + M[m + 13]);
            z += w * (M[m + 2] * px + M[m + 6] * py + M[m + 10] * pz + M[m + 14]);
            a += w * (M[m] * nx + M[m + 4] * ny + M[m + 8] * nz);
            b += w * (M[m + 1] * nx + M[m + 5] * ny + M[m + 9] * nz);
            c += w * (M[m + 2] * nx + M[m + 6] * ny + M[m + 10] * nz);
        }
        const l = Math.hypot(a, b, c) || 1;
        const o = v * 12;
        out[o] = x; out[o + 1] = y; out[o + 2] = z;
        out[o + 3] = a / l; out[o + 4] = b / l; out[o + 5] = c / l;
        out[o + 6] = U[v * 2]; out[o + 7] = U[v * 2 + 1];
        out[o + 8] = 1; out[o + 9] = 1; out[o + 10] = 1; out[o + 11] = 1;
    }
    return out;
}

/** Static vertices (bind pose) in the 12-float layout. */
export function staticVertices(model: GlbModel): Float32Array {
    const n = model.positions.length / 3, out = new Float32Array(n * 12);
    for (let v = 0; v < n; v++) {
        const o = v * 12;
        out[o] = model.positions[v * 3]; out[o + 1] = model.positions[v * 3 + 1]; out[o + 2] = model.positions[v * 3 + 2];
        out[o + 3] = model.normals[v * 3]; out[o + 4] = model.normals[v * 3 + 1]; out[o + 5] = model.normals[v * 3 + 2];
        out[o + 6] = model.uvs[v * 2]; out[o + 7] = model.uvs[v * 2 + 1];
        out[o + 8] = 1; out[o + 9] = 1; out[o + 10] = 1; out[o + 11] = 1;
    }
    return out;
}

/**
 * Plays clips by name with crossfades. `play` switches (fading over `fade` seconds); `update`
 * advances time and poses the skeleton.
 */
export class Animator {
    cur: ClipState = { clip: 0, time: 0, speed: 1, loop: true };
    prev: ClipState | null = null;
    private fadeT = 0; private fadeLen = 0;
    current = "";
    constructor(readonly sk: Skeleton) {}

    play(name: string, opts: { fade?: number; speed?: number; loop?: boolean; restart?: boolean } = {}): void {
        const i = this.sk.clipIndex(name);
        if (i < 0) return;
        if (name === this.current && !opts.restart) { this.cur.speed = opts.speed ?? this.cur.speed; return; }
        this.prev = this.current ? { ...this.cur } : null;
        this.fadeLen = this.fadeT = this.prev ? (opts.fade ?? 0.2) : 0;
        this.cur = { clip: i, time: 0, speed: opts.speed ?? 1, loop: opts.loop ?? true };
        this.current = name;
    }

    /** True once a non-looping clip has reached its end. */
    get finished(): boolean { const c = this.sk.clip(this.cur.clip); return !this.cur.loop && !!c && this.cur.time >= c.duration; }

    update(dt: number): void {
        const adv = (s: ClipState) => {
            const c = this.sk.clip(s.clip);
            if (!c) return;
            s.time += dt * s.speed;
            if (c.duration > 0) s.time = s.loop ? s.time % c.duration : Math.min(s.time, c.duration);
        };
        adv(this.cur);
        if (this.prev) adv(this.prev);
        this.fadeT = Math.max(0, this.fadeT - dt);
        const f = this.fadeLen > 0 ? this.fadeT / this.fadeLen : 0;
        if (f <= 0) this.prev = null;
        this.sk.pose(this.cur, this.prev, f);
    }
}
