// GLB reading for True Error's Meshy models (geometry-only GLBs from tools/te_assets.py, read with
// Entropy.IO.readAsset). One skinned or static mesh per file is all Meshy produces; every primitive
// of every mesh node is read anyway, static ones baked into model space by their node's transform.

export type Mat4 = Float32Array;

export interface GlbNode {
    name: string;
    parent: number;
    children: number[];
    t: [number, number, number];
    r: [number, number, number, number];
    s: [number, number, number];
}

export interface GlbChannel {
    node: number;
    path: "translation" | "rotation" | "scale";
    times: Float32Array;
    values: Float32Array;
    /** Components per key (3 or 4); cubic-spline keys keep only their value. */
    width: number;
    step: boolean;
}

export interface GlbClip { name: string; duration: number; channels: GlbChannel[] }

export interface GlbSkin { joints: number[]; inverseBind: Float32Array }

export interface GlbModel {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    /** Four joint slots (indices into skin.joints) and weights per vertex; null for a static model. */
    joints: Uint16Array | null;
    weights: Float32Array | null;
    nodes: GlbNode[];
    skin: GlbSkin | null;
    clips: GlbClip[];
    /** Model-space bounds of the bind pose. */
    min: [number, number, number];
    max: [number, number, number];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

interface Doc {
    accessors: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
    bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
    meshes?: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
    nodes?: { name?: string; children?: number[]; mesh?: number; skin?: number; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }[];
    skins?: { joints: number[]; inverseBindMatrices?: number }[];
    animations?: { name?: string; samplers: { input: number; output: number; interpolation?: string }[]; channels: { sampler: number; target: { node?: number; path: string } }[] }[];
    scenes?: { nodes: number[] }[];
}

/** Reads accessor `i` as floats (normalized integers scaled to 0..1). */
function readAccessor(doc: Doc, bin: DataView, i: number): Float32Array {
    const a = doc.accessors[i];
    const n = COMPONENTS[a.type] * a.count;
    const out = new Float32Array(n);
    if (a.bufferView === undefined) return out;
    const bv = doc.bufferViews[a.bufferView];
    const size = BYTES[a.componentType];
    const width = COMPONENTS[a.type];
    const stride = bv.byteStride || size * width;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const scale = a.normalized ? ({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 } as Record<number, number>)[a.componentType] ?? 1 : 1;
    for (let e = 0; e < a.count; e++) {
        for (let c = 0; c < width; c++) {
            const o = base + e * stride + c * size;
            let v: number;
            switch (a.componentType) {
                case 5126: v = bin.getFloat32(o, true); break;
                case 5125: v = bin.getUint32(o, true); break;
                case 5123: v = bin.getUint16(o, true); break;
                case 5122: v = bin.getInt16(o, true); break;
                case 5121: v = bin.getUint8(o); break;
                default: v = bin.getInt8(o);
            }
            out[e * width + c] = scale !== 1 ? Math.max(v / scale, -1) : v;
        }
    }
    return out;
}

export function parseGlb(bytes: Uint8Array): GlbModel {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
    let off = 12, doc: Doc | null = null, bin: DataView = new DataView(new ArrayBuffer(0));
    while (off + 8 <= bytes.byteLength) {
        const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
        if (type === 0x4e4f534a) doc = JSON.parse(utf8(bytes.subarray(off + 8, off + 8 + len)));
        else if (type === 0x004e4942) bin = new DataView(bytes.buffer, bytes.byteOffset + off + 8, len);
        off += 8 + len;
    }
    if (!doc) throw new Error("GLB has no JSON chunk");
    return buildModel(doc, bin);
}

function buildModel(doc: Doc, bin: DataView): GlbModel {
    const rawNodes = doc.nodes ?? [];
    const nodes: GlbNode[] = rawNodes.map((n, i) => {
        const node: GlbNode = { name: n.name ?? `node${i}`, parent: -1, children: n.children ?? [], t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };
        if (n.matrix) decompose(n.matrix, node);
        if (n.translation) node.t = [n.translation[0], n.translation[1], n.translation[2]];
        if (n.rotation) node.r = [n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3]];
        if (n.scale) node.s = [n.scale[0], n.scale[1], n.scale[2]];
        return node;
    });
    nodes.forEach((n, i) => n.children.forEach(c => { nodes[c].parent = i; }));
    const world = nodeWorlds(nodes);

    const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [], J: number[] = [], W: number[] = [];
    let skin: GlbSkin | null = null;
    rawNodes.forEach((n, ni) => {
        if (n.mesh === undefined || !doc.meshes) return;
        const skinned = n.skin !== undefined && !!doc.skins;
        if (skinned && !skin) {
            const s = doc.skins![n.skin!];
            skin = { joints: s.joints, inverseBind: s.inverseBindMatrices !== undefined ? readAccessor(doc, bin, s.inverseBindMatrices) : identities(s.joints.length) };
        }
        // A skinned mesh's node transform is ignored (glTF); a static one is baked in.
        const m = skinned ? null : world[ni];
        for (const prim of doc.meshes[n.mesh].primitives) {
            const base = P.length / 3;
            const pos = readAccessor(doc, bin, prim.attributes.POSITION);
            const count = pos.length / 3;
            const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(doc, bin, prim.attributes.NORMAL) : null;
            const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(doc, bin, prim.attributes.TEXCOORD_0) : null;
            for (let v = 0; v < count; v++) {
                let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
                let nx = nrm ? nrm[v * 3] : 0, ny = nrm ? nrm[v * 3 + 1] : 1, nz = nrm ? nrm[v * 3 + 2] : 0;
                if (m) {
                    [x, y, z] = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
                    const a = m[0] * nx + m[4] * ny + m[8] * nz, b = m[1] * nx + m[5] * ny + m[9] * nz, c = m[2] * nx + m[6] * ny + m[10] * nz;
                    const l = Math.hypot(a, b, c) || 1;
                    nx = a / l; ny = b / l; nz = c / l;
                }
                P.push(x, y, z); N.push(nx, ny, nz);
                U.push(uv ? uv[v * 2] : 0, uv ? uv[v * 2 + 1] : 0);
            }
            if (skinned && prim.attributes.JOINTS_0 !== undefined && prim.attributes.WEIGHTS_0 !== undefined) {
                const j = readAccessor(doc, bin, prim.attributes.JOINTS_0), w = readAccessor(doc, bin, prim.attributes.WEIGHTS_0);
                for (let v = 0; v < count; v++) {
                    const s = w[v * 4] + w[v * 4 + 1] + w[v * 4 + 2] + w[v * 4 + 3] || 1;
                    for (let k = 0; k < 4; k++) { J.push(j[v * 4 + k]); W.push(w[v * 4 + k] / s); }
                }
            } else if (skinned) {
                for (let v = 0; v < count; v++) { J.push(0, 0, 0, 0); W.push(1, 0, 0, 0); }
            }
            if (prim.indices !== undefined) { const idx = readAccessor(doc, bin, prim.indices); for (let k = 0; k < idx.length; k++) I.push(idx[k] + base); }
            else for (let k = 0; k < count; k++) I.push(base + k);
        }
    });

    const clips: GlbClip[] = (doc.animations ?? []).map((a, k) => {
        let duration = 0;
        const channels: GlbChannel[] = [];
        for (const ch of a.channels) {
            if (ch.target.node === undefined || !["translation", "rotation", "scale"].includes(ch.target.path)) continue;
            const s = a.samplers[ch.sampler];
            const times = readAccessor(doc, bin, s.input);
            let values = readAccessor(doc, bin, s.output);
            const width = ch.target.path === "rotation" ? 4 : 3;
            if (s.interpolation === "CUBICSPLINE") {
                // in-tangent, value, out-tangent per key: keep the values.
                const v = new Float32Array(times.length * width);
                for (let i = 0; i < times.length; i++) for (let c = 0; c < width; c++) v[i * width + c] = values[(i * 3 + 1) * width + c];
                values = v;
            }
            if (times.length) duration = Math.max(duration, times[times.length - 1]);
            channels.push({ node: ch.target.node, path: ch.target.path as GlbChannel["path"], times, values, width, step: s.interpolation === "STEP" });
        }
        return { name: a.name ?? `clip${k}`, duration, channels };
    });

    const positions = new Float32Array(P);
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], positions[i + c]); max[c] = Math.max(max[c], positions[i + c]); }
    return {
        positions, normals: new Float32Array(N), uvs: new Float32Array(U), indices: new Uint32Array(I),
        joints: skin ? new Uint16Array(J) : null, weights: skin ? new Float32Array(W) : null,
        nodes, skin, clips, min, max,
    };
}

/** UTF-8 to a string (the addon runtime has no TextDecoder). */
function utf8(b: Uint8Array): string {
    let out = "";
    const chunk: number[] = [];
    for (let i = 0; i < b.length;) {
        const c = b[i++];
        let cp = c;
        if (c >= 0xf0) { cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63); }
        else if (c >= 0xe0) { cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63); }
        else if (c >= 0xc0) { cp = ((c & 31) << 6) | (b[i++] & 63); }
        if (cp > 0xffff) { cp -= 0x10000; chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); } else chunk.push(cp);
        if (chunk.length > 8000) { out += String.fromCharCode(...chunk); chunk.length = 0; }
    }
    return out + String.fromCharCode(...chunk);
}

function identities(n: number): Float32Array {
    const out = new Float32Array(n * 16);
    for (let i = 0; i < n; i++) { out[i * 16] = 1; out[i * 16 + 5] = 1; out[i * 16 + 10] = 1; out[i * 16 + 15] = 1; }
    return out;
}

/** Column-major TRS matrix into `out` at offset `o`. */
export function trs(out: Float32Array, o: number, t: ArrayLike<number>, r: ArrayLike<number>, s: ArrayLike<number>): void {
    const [x, y, z, w] = [r[0], r[1], r[2], r[3]];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    out[o] = (1 - (yy + zz)) * s[0]; out[o + 1] = (xy + wz) * s[0]; out[o + 2] = (xz - wy) * s[0]; out[o + 3] = 0;
    out[o + 4] = (xy - wz) * s[1]; out[o + 5] = (1 - (xx + zz)) * s[1]; out[o + 6] = (yz + wx) * s[1]; out[o + 7] = 0;
    out[o + 8] = (xz + wy) * s[2]; out[o + 9] = (yz - wx) * s[2]; out[o + 10] = (1 - (xx + yy)) * s[2]; out[o + 11] = 0;
    out[o + 12] = t[0]; out[o + 13] = t[1]; out[o + 14] = t[2]; out[o + 15] = 1;
}

/** out[o..o+16] = a[ao..] * b[bo..] (column-major). */
export function mul(out: Float32Array, o: number, a: Float32Array, ao: number, b: Float32Array, bo: number): void {
    for (let c = 0; c < 4; c++) {
        const b0 = b[bo + c * 4], b1 = b[bo + c * 4 + 1], b2 = b[bo + c * 4 + 2], b3 = b[bo + c * 4 + 3];
        out[o + c * 4] = a[ao] * b0 + a[ao + 4] * b1 + a[ao + 8] * b2 + a[ao + 12] * b3;
        out[o + c * 4 + 1] = a[ao + 1] * b0 + a[ao + 5] * b1 + a[ao + 9] * b2 + a[ao + 13] * b3;
        out[o + c * 4 + 2] = a[ao + 2] * b0 + a[ao + 6] * b1 + a[ao + 10] * b2 + a[ao + 14] * b3;
        out[o + c * 4 + 3] = a[ao + 3] * b0 + a[ao + 7] * b1 + a[ao + 11] * b2 + a[ao + 15] * b3;
    }
}

/** World matrix of every node from its rest TRS (parents first: glTF allows any order, so recurse). */
export function nodeWorlds(nodes: GlbNode[]): Float32Array[] {
    const out: Float32Array[] = nodes.map(() => new Float32Array(16));
    const done = new Uint8Array(nodes.length);
    const local = new Float32Array(16);
    const visit = (i: number) => {
        if (done[i]) return;
        const n = nodes[i];
        trs(local, 0, n.t, n.r, n.s);
        if (n.parent >= 0) { visit(n.parent); mul(out[i], 0, out[n.parent], 0, local, 0); }
        else out[i].set(local);
        done[i] = 1;
    };
    nodes.forEach((_, i) => visit(i));
    return out;
}

function decompose(m: number[], node: GlbNode): void {
    node.t = [m[12], m[13], m[14]];
    const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
    node.s = [sx, sy, sz];
    const r00 = m[0] / sx, r11 = m[5] / sy, r22 = m[10] / sz;
    const tr = r00 + r11 + r22;
    let x, y, z, w;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m[6] / sy - m[9] / sz) / s; y = (m[8] / sz - m[2] / sx) / s; z = (m[1] / sx - m[4] / sy) / s; }
    else if (r00 > r11 && r00 > r22) { const s = Math.sqrt(1 + r00 - r11 - r22) * 2; w = (m[6] / sy - m[9] / sz) / s; x = s / 4; y = (m[4] / sy + m[1] / sx) / s; z = (m[8] / sz + m[2] / sx) / s; }
    else if (r11 > r22) { const s = Math.sqrt(1 + r11 - r00 - r22) * 2; w = (m[8] / sz - m[2] / sx) / s; x = (m[4] / sy + m[1] / sx) / s; y = s / 4; z = (m[9] / sz + m[6] / sy) / s; }
    else { const s = Math.sqrt(1 + r22 - r00 - r11) * 2; w = (m[1] / sx - m[4] / sy) / s; x = (m[8] / sz + m[2] / sx) / s; y = (m[9] / sz + m[6] / sy) / s; z = s / 4; }
    node.r = [x, y, z, w];
}
