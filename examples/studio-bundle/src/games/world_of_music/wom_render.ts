// What World of Music asks of the engine: the TOON, INK and GLOW pipelines (instanced, one
// draw per mesh), the World uniform, the screen pass and its uniform. The packing is pure (tests
// check it); the Renderer is the only place that calls Entropy.* to draw.

import { WOM_TOON_SHADER, WOM_INK_SHADER, WOM_GLOW_SHADER, WOM_SCREEN_SHADER, WORLD_FLOATS, ITEM_FLOATS, POST_FLOATS, MAX_PULSES, MAX_DARKS } from "./wom_shader";
import { InstanceBatches, meshCacheInstances, INSTANCED_BIND_GROUPS } from "../../apps/quadplanet/qp_instances";
import { icosphere, quad, cone } from "../nebula/nk_meshes";
import type { Terrain } from "./wom_terrain";
import type { V3 } from "../nebula/nk_math";

export const CACHE_NAMESPACE = "world-of-music";
const MESH_VERSION = 2;

export interface MeshData { vertexData: Float32Array; indexData: Uint32Array }

function pack(positions: number[], normals: number[], uvs: number[], indices: number[]): MeshData {
    const n = positions.length / 3, v = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) v.set([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2], uvs[i * 2], uvs[i * 2 + 1], 0, 0, 0, 1], i * 12);
    return { vertexData: v, indexData: new Uint32Array(indices) };
}

/** A unit cube from -1 to 1, flat-shaded faces. */
export function box(): MeshData {
    const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
    const faces: [V3, V3, V3][] = [[[1, 0, 0], [0, 1, 0], [0, 0, -1]], [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]], [[0, 0, 1], [0, 1, 0], [1, 0, 0]], [[0, 0, -1], [0, 1, 0], [-1, 0, 0]]];
    for (const [n, u, r] of faces) {
        const b = P.length / 3;
        for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            P.push(n[0] + r[0] * a + u[0] * c, n[1] + r[1] * a + u[1] * c, n[2] + r[2] * a + u[2] * c);
            N.push(...n); U.push((a + 1) / 2, (c + 1) / 2);
        }
        I.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    // Wind every face counter-clockwise seen from outside.
    for (let f = 0; f < 6; f++) {
        const i0 = I[f * 6], i1 = I[f * 6 + 1], i2 = I[f * 6 + 2];
        const p = (i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
        const a = p(i0), b = p(i1), c = p(i2);
        const cr: V3 = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
        const n = faces[f][0];
        if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) for (let k = 0; k < 6; k += 3) { const t = I[f * 6 + k + 1]; I[f * 6 + k + 1] = I[f * 6 + k + 2]; I[f * 6 + k + 2] = t; }
    }
    return pack(P, N, U, I);
}

/** A capped cylinder of radius 1 from y = 0 to y = 1. */
export function cylinder(seg = 14): MeshData {
    const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
    for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        P.push(c, 0, s, c, 1, s); N.push(c, 0, s, c, 0, s); U.push(i / seg, 0, i / seg, 1);
    }
    for (let i = 0; i < seg; i++) { const a = i * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    for (const y of [0, 1]) {
        const c0 = P.length / 3;
        P.push(0, y, 0); N.push(0, y ? 1 : -1, 0); U.push(0.5, 0.5);
        for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2; P.push(Math.cos(a), y, Math.sin(a)); N.push(0, y ? 1 : -1, 0); U.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5); }
        for (let i = 0; i < seg; i++) { if (y) I.push(c0, c0 + i + 2, c0 + i + 1); else I.push(c0, c0 + i + 1, c0 + i + 2); }
    }
    return pack(P, N, U, I);
}

/** A torus in the xz plane: ring radius 1, tube radius `tube`. */
export function torus(tube = 0.12, seg = 32, sides = 8): MeshData {
    const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
    for (let i = 0; i <= seg; i++) for (let j = 0; j <= sides; j++) {
        const u = (i / seg) * Math.PI * 2, v = (j / sides) * Math.PI * 2;
        const cx = Math.cos(u), cz = Math.sin(u);
        const nx = Math.cos(v) * cx, ny = Math.sin(v), nz = Math.cos(v) * cz;
        P.push(cx + nx * tube, ny * tube, cz + nz * tube); N.push(nx, ny, nz); U.push(i / seg, j / sides);
    }
    for (let i = 0; i < seg; i++) for (let j = 0; j < sides; j++) {
        const a = i * (sides + 1) + j, b = a + sides + 1;
        I.push(a, a + 1, b, a + 1, b + 1, b);
    }
    return pack(P, N, U, I);
}

/** A cone pointing +y: base radius 1 at y = 0, apex at y = 1 (Nebula's points +z; turned here). */
function coneUp(): MeshData {
    const m = cone(10), v = m.vertexData;
    for (let i = 0; i < v.length; i += 12) {
        const y = v[i + 2], z = -v[i + 1]; v[i + 1] = y; v[i + 2] = z;
        const ny = v[i + 5], nz = -v[i + 4]; v[i + 4] = ny; v[i + 5] = nz;
    }
    return m;
}

export const MESHES: Record<string, () => MeshData> = {
    "sphere-3": () => icosphere(3),
    "sphere-2": () => icosphere(2),
    "sphere-1": () => icosphere(1),
    sky: () => icosphere(3, true),
    quad: () => quad(),
    cone: () => coneUp(),
    box: () => box(),
    cyl: () => cylinder(),
    torus: () => torus(),
};

/** The water: a 2 m grid over the whole island, each vertex knowing the depth below it (color.r). */
export function waterMesh(t: Terrain, step = 2.5): MeshData {
    const half = t.half + 60, cells = Math.ceil((half * 2) / step), n = cells + 1;
    const v = new Float32Array(n * n * 12);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x = i * step - half, z = j * step - half, o = (j * n + i) * 12;
        const depth = t.inBounds(x, z) ? Math.max(0, -t.height(x, z)) : 6;
        v.set([x, 0, z, 0, 1, 0, x / 10, z / 10, depth, 0, 0, 1], o);
    }
    const idx = new Uint32Array(cells * cells * 6);
    let k = 0;
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    return { vertexData: v, indexData: idx };
}

// --- transforms -----------------------------------------------------------------------------

export type Mat4 = number[];

/** Scale then translate (no rotation). */
export function placed(p: V3, sx: number, sy = sx, sz = sx): Mat4 {
    return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, p[0], p[1], p[2], 1];
}

/** Turned by `yaw` about +y (0 faces +z), scaled per axis. */
export function yawed(p: V3, yaw: number, sx: number, sy: number, sz: number): Mat4 {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, p[0], p[1], p[2], 1];
}

/** A frame at p whose +y is `up` (unit), turned toward `yaw` around it, scaled per axis. */
export function aligned(p: V3, up: V3, yaw: number, sx: number, sy: number, sz: number): Mat4 {
    let f: V3 = [Math.sin(yaw), 0, Math.cos(yaw)];
    const d = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
    f = [f[0] - up[0] * d, f[1] - up[1] * d, f[2] - up[2] * d];
    const fl = Math.hypot(...f) || 1; f = [f[0] / fl, f[1] / fl, f[2] / fl];
    const r: V3 = [up[1] * f[2] - up[2] * f[1], up[2] * f[0] - up[0] * f[2], up[0] * f[1] - up[1] * f[0]];
    return [r[0] * sx, r[1] * sx, r[2] * sx, 0, up[0] * sy, up[1] * sy, up[2] * sy, 0, f[0] * sz, f[1] * sz, f[2] * sz, 0, p[0], p[1], p[2], 1];
}

/** A point `o` (x right, y up, z forward) in a body's yawed frame at p. */
export function at(p: V3, yaw: number, o: V3): V3 {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [p[0] + o[0] * c + o[2] * s, p[1] + o[1], p[2] - o[0] * s + o[2] * c];
}

/** A segment from a to b drawn with a +y unit mesh (cylinder, cone): radius r. */
export function between(a: V3, b: V3, r: number, r2 = r): Mat4 {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d) || 1e-6;
    const up: V3 = [d[0] / l, d[1] / l, d[2] / l];
    const m = aligned(a, up, 0, r, 1, r2);
    m[4] *= l; m[5] *= l; m[6] *= l;
    return m;
}

// --- the uniforms ---------------------------------------------------------------------------

export interface PulseView { x: number; z: number; radius: number; strength: number; color: [number, number, number]; width: number }
export interface WorldLook {
    time: number; aspect: number; focus: number; exposure: number;
    sun: V3; haze: number; cam: V3; dof: number; screen: [number, number];
    tom: V3; hurt: number; fog: [number, number, number]; fade: number;
    veins: number; hatch: number; ink: number; flash: number;
    pulses: PulseView[];
    darks: [number, number, number, number][];
}

export function packWorld(l: WorldLook, out = new Float32Array(WORLD_FLOATS)): Float32Array {
    const set = (i: number, a: number, b: number, c: number, d: number) => { out[i * 4] = a; out[i * 4 + 1] = b; out[i * 4 + 2] = c; out[i * 4 + 3] = d; };
    const np = Math.min(MAX_PULSES, l.pulses.length), nd = Math.min(MAX_DARKS, l.darks.length);
    set(0, l.time, l.aspect, l.focus, l.exposure);
    set(1, l.sun[0], l.sun[1], l.sun[2], l.haze);
    set(2, l.cam[0], l.cam[1], l.cam[2], l.dof);
    set(3, l.screen[0], l.screen[1], np, nd);
    set(4, l.tom[0], l.tom[1], l.tom[2], l.hurt);
    set(5, l.fog[0], l.fog[1], l.fog[2], l.fade);
    set(6, l.veins, l.hatch, l.ink, l.flash);
    set(7, 0, 0, 0, 0);
    for (let i = 0; i < MAX_PULSES; i++) {
        const p = l.pulses[i];
        if (i < np) { set(8 + i * 2, p.x, p.z, p.radius, p.strength); set(9 + i * 2, p.color[0], p.color[1], p.color[2], p.width); }
        else { set(8 + i * 2, 0, 0, 0, 0); set(9 + i * 2, 0, 0, 0, 1); }
    }
    for (let i = 0; i < MAX_DARKS; i++) { const d = l.darks[i]; if (i < nd) set(8 + MAX_PULSES * 2 + i, d[0], d[1], d[2], d[3]); else set(8 + MAX_PULSES * 2 + i, 0, 0, 0, 0); }
    return out;
}

export interface PostLook { focus: number; range: number; blur: number; haze: number; fog: [number, number, number]; bloom: number; screen: [number, number]; time: number; ink: number; vignette: number; grain: number; fade: number; flash: number }
export function packPost(p: PostLook, out = new Float32Array(POST_FLOATS)): Float32Array {
    out.set([p.focus, p.range, p.blur, p.haze, p.fog[0], p.fog[1], p.fog[2], p.bloom, p.screen[0], p.screen[1], p.time, p.ink, p.vignette, p.grain, p.fade, p.flash]);
    return out;
}

// --- the renderer ---------------------------------------------------------------------------

export class Renderer {
    toonPipeline = ""; inkPipeline = ""; glowPipeline = ""; screenPipeline = "";
    worldBuffer = ""; postBuffer = "";
    solids!: InstanceBatches;
    inks!: InstanceBatches;
    glows!: InstanceBatches;
    ready = false;
    screenOn = false;
    private scratch = new Float32Array(WORLD_FLOATS);
    private postScratch = new Float32Array(POST_FLOATS);
    private levelMeshes = new Set<string>();

    init(): void {
        const groups = INSTANCED_BIND_GROUPS.map(g => ({ entries: g.entries.map(e => ({ ...e, visibility: [...e.visibility] })) }));
        this.toonPipeline = Entropy.Pipeline.create({ name: "WoM Toon", layout: "mesh", pbr: false, vertexShader: WOM_TOON_SHADER, fragmentShader: WOM_TOON_SHADER, extraBindGroups: groups });
        this.inkPipeline = Entropy.Pipeline.create({ name: "WoM Ink", layout: "mesh", pbr: false, vertexShader: WOM_INK_SHADER, fragmentShader: WOM_INK_SHADER, extraBindGroups: groups, doubleSided: true });
        this.glowPipeline = Entropy.Pipeline.create({ name: "WoM Glow", layout: "mesh", pbr: false, vertexShader: WOM_GLOW_SHADER, fragmentShader: WOM_GLOW_SHADER, extraBindGroups: groups, transparent: true, additive: true, doubleSided: true });
        this.worldBuffer = Entropy.Buffer.create({ size: WORLD_FLOATS * 4, usage: "Uniform" });
        this.postBuffer = Entropy.Buffer.create({ size: POST_FLOATS * 4, usage: "Uniform" });
        try {
            this.screenPipeline = Entropy.Pipeline.create({ name: "WoM Screen", form: "composite", pbr: false, vertexShader: WOM_SCREEN_SHADER, fragmentShader: WOM_SCREEN_SHADER, doubleSided: true, extraBindGroups: [{ entries: [{ binding: 0, visibility: ["Fragment"], resourceType: "Uniform" }] }] });
        } catch { this.screenPipeline = ""; }
        for (const [key, make] of Object.entries(MESHES)) this.cache(`${key}-v${MESH_VERSION}`, make);
        const engine = (pipeline: () => string) => {
            const e = meshCacheInstances(CACHE_NAMESPACE, pipeline, () => this.worldBuffer);
            return { ...e, createMesh: (key: string, meshId: string, buffer: string, instances: number) => e.createMesh(key.startsWith("level:") ? key.slice(6) : `${key}-v${MESH_VERSION}`, meshId, buffer, instances) };
        };
        this.solids = new InstanceBatches(engine(() => this.toonPipeline), ITEM_FLOATS, { prefix: "wom-toon", idleFrames: 300, initialCapacity: 64 });
        this.inks = new InstanceBatches(engine(() => this.inkPipeline), ITEM_FLOATS, { prefix: "wom-ink", idleFrames: 300, initialCapacity: 64 });
        this.glows = new InstanceBatches(engine(() => this.glowPipeline), ITEM_FLOATS, { prefix: "wom-glow", idleFrames: 300, initialCapacity: 128 });
        this.setScreen(true);
        this.ready = true;
    }

    private cache(key: string, make: () => MeshData): void {
        if (Entropy.MeshCache.status(CACHE_NAMESPACE, key) !== "ready") { const m = make(); Entropy.MeshCache.put(CACHE_NAMESPACE, key, { vertexData: m.vertexData, indexData: m.indexData }); }
    }

    /** Caches a level's ground and water meshes (once per level and version). */
    levelMesh(key: string, make: () => MeshData): string {
        const k = `${key}-v${MESH_VERSION}`;
        if (!this.levelMeshes.has(k)) { this.cache(k, make); this.levelMeshes.add(k); }
        return `level:${k}`;
    }

    setScreen(on: boolean): void {
        this.screenOn = on && !!this.screenPipeline;
        try { Entropy.Screen?.setEffect(this.screenOn ? { pipeline: this.screenPipeline, buffers: [this.postBuffer] } : null); } catch { this.screenOn = false; }
    }

    begin(): void { this.solids.begin(); this.inks.begin(); this.glows.begin(); }
    flush(): void { this.solids.flush(); this.inks.flush(); this.glows.flush(); }

    writeWorld(look: WorldLook): void { Entropy.Buffer.write(this.worldBuffer, packWorld(look, this.scratch)); }
    writePost(p: PostLook): void { Entropy.Buffer.write(this.postBuffer, packPost(p, this.postScratch)); }

    private put(b: InstanceBatches, mesh: string, m: Mat4, color: readonly number[], params: readonly number[], extra: readonly number[]): void {
        const { data, offset } = b.add(mesh);
        for (let i = 0; i < 16; i++) data[offset + i] = m[i];
        for (let i = 0; i < 4; i++) { data[offset + 16 + i] = color[i] ?? 0; data[offset + 20 + i] = params[i] ?? 0; data[offset + 24 + i] = extra[i] ?? 0; }
    }

    /**
     * An opaque mesh. color = [r, g, b, chroma] (chroma 0: drawn grey at the color's lightness;
     * 1: its own color); params = [kind, seed, emissive, 0]; extra = [squash, 0, 0, ink width].
     * Ink width > 0 also draws the ink hull.
     */
    solid(mesh: string, m: Mat4, color: readonly number[], params: readonly number[] = [0, 0, 0, 0], extra: readonly number[] = [0, 0, 0, 0]): void {
        this.put(this.solids, mesh, m, color, params, extra);
        if ((extra[3] ?? 0) > 0) this.put(this.inks, mesh, m, color, params, extra);
    }

    /** Light: color = [r, g, b, strength]; params = [kind, seed, width, 0]. */
    glow(m: Mat4, color: readonly number[], kind: number, width = 0.1, extra: readonly number[] = [0, 0, 0, 0]): void {
        this.put(this.glows, "quad", m, color, [kind, 0, width, 0], extra);
    }
}
