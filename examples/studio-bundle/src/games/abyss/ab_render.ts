// What The Abyss asks of the engine: its pipelines, the World uniform, Items, the light map
// texture, and meshes (plain ones, mesh-cache ones, instanced batches). The packing functions are
// pure (tests check them); the Renderer is the only place that calls Entropy.* for drawing.

import { ABYSS_SHADER, ABYSS_INSTANCED_SHADER, WORLD_FLOATS, ITEM_FLOATS, MAX_LIGHTS } from "./ab_shader";
import { MAP_HALF, LIGHT_MIN_Y, LIGHT_RANGE_Y, LIGHT_RES, FLOOR_Y, type V3 } from "./ab_world";

export type RGB = [number, number, number];
export type Mat4 = number[];

export interface PointLight { pos: V3; radius: number; color: RGB; intensity: number }

export interface WorldLook {
    sunDir: V3;
    sunColor: RGB;
    sunIntensity: number;
    zenith: RGB;
    horizon: RGB;
    exposure: number;
    /** Base haze (1/m) and the dust at the abyss floor (1/m) with its scale height (m). */
    haze: number;
    dustDensity: number;
    dustHeight: number;
    dustColor: RGB;
    bounce: RGB;
    sourceColor: RGB;
    sourceIntensity: number;
    sourcePos: V3;
    sourceReach: number;
    saturation: number;
    contrast: number;
    fade: number;
    vignette: number;
    /** 0..1 white flash, and its hue (0 white, 1 the river's light). */
    flash: number;
    flashHue: number;
    /** How sunlit the camera's own air is (fog in-scatter). */
    cameraSun: number;
    /** Debug view (1: the terrain's masks). */
    debug?: number;
}

export const DEFAULT_LOOK: WorldLook = {
    sunDir: [0.4, 0.5, 0.75],
    sunColor: [1, 0.74, 0.5],
    sunIntensity: 1.9,
    zenith: [0.26, 0.28, 0.32],
    horizon: [0.62, 0.52, 0.43],
    exposure: 0.85,
    haze: 0.00006,
    dustDensity: 0.0007,
    dustHeight: 150,
    dustColor: [0.12, 0.11, 0.12],
    bounce: [0.24, 0.19, 0.14],
    sourceColor: [0.4, 0.8, 1],
    sourceIntensity: 0.6,
    sourcePos: [1405, -300, 70],
    sourceReach: 520,
    saturation: 1,
    contrast: 1.05,
    fade: 0,
    vignette: 0.35,
    flash: 0,
    flashHue: 0,
    cameraSun: 1,
};

/** The World uniform's floats (see ab_shader.ts `World`). */
export function packWorld(l: WorldLook, time: number, screen: [number, number], lights: readonly PointLight[], out = new Float32Array(WORLD_FLOATS)): Float32Array {
    const n = Math.hypot(...l.sunDir) || 1;
    const set = (i: number, a: number, b: number, c: number, d: number) => { out[i * 4] = a; out[i * 4 + 1] = b; out[i * 4 + 2] = c; out[i * 4 + 3] = d; };
    set(0, l.sunDir[0] / n, l.sunDir[1] / n, l.sunDir[2] / n, time);
    set(1, ...l.sunColor, l.sunIntensity);
    set(2, ...l.zenith, l.exposure);
    set(3, ...l.horizon, l.haze);
    set(4, ...l.bounce, l.dustDensity);
    set(5, ...l.dustColor, l.dustHeight);
    set(6, MAP_HALF, LIGHT_MIN_Y, LIGHT_RANGE_Y, LIGHT_RES);
    set(7, ...l.sourceColor, l.sourceIntensity);
    set(8, ...l.sourcePos, l.sourceReach);
    set(9, l.saturation, l.contrast, l.fade, l.vignette);
    const count = Math.min(MAX_LIGHTS, lights.length);
    set(10, screen[0], screen[1], FLOOR_Y, count);
    set(11, l.cameraSun, l.flash, l.flashHue, l.debug ?? 0);
    for (let i = 0; i < MAX_LIGHTS; i++) {
        const p = lights[i];
        if (i < count && p) { set(12 + i * 2, ...p.pos, p.radius); set(13 + i * 2, ...p.color, p.intensity); }
        else { set(12 + i * 2, 0, -1e6, 0, 0); set(13 + i * 2, 0, 0, 0, 0); }
    }
    return out;
}

export interface ItemData {
    matrix: Mat4;
    tint?: readonly number[];
    anim?: readonly number[];
    extra?: readonly number[];
}

const ONE = [1, 1, 1, 0], NO_ANIM = [0, 0, 0, 0], OPAQUE = [1, 0, 0, 0];

/** One Item's floats at `offset` of `out` (a uniform, or a record of an instanced batch). */
export function packItem(out: Float32Array, offset: number, matrix: Mat4, tint: readonly number[] = ONE, anim: readonly number[] = NO_ANIM, extra: readonly number[] = OPAQUE): void {
    for (let i = 0; i < 16; i++) out[offset + i] = matrix[i];
    for (let i = 0; i < 4; i++) {
        out[offset + 16 + i] = tint[i] ?? 0;
        out[offset + 20 + i] = anim[i] ?? 0;
        out[offset + 24 + i] = extra[i] ?? 0;
    }
}

// --- Matrices (column-major) ----------------------------------------------------------------------

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Translate, then yaw about +Y (radians; 0 faces +Z), then uniform scale. */
export function placeMatrix(x: number, y: number, z: number, yaw = 0, s = 1): Mat4 {
    const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s;
    return [c, 0, -sn, 0, 0, s, 0, 0, sn, 0, c, 0, x, y, z, 1];
}

/** A full frame: right, up, forward (the model's +X, +Y, +Z) scaled per axis, at p. */
export function frameMatrix(p: V3, right: V3, up: V3, forward: V3, sx = 1, sy = 1, sz = 1): Mat4 {
    return [right[0] * sx, right[1] * sx, right[2] * sx, 0, up[0] * sy, up[1] * sy, up[2] * sy, 0, forward[0] * sz, forward[1] * sz, forward[2] * sz, 0, p[0], p[1], p[2], 1];
}

/** Yaw, pitch (nose up), roll (right wing down) then scale, at p. */
export function eulerMatrix(p: V3, yaw: number, pitch = 0, roll = 0, s = 1): Mat4 {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    // forward = yaw/pitch; right and up rolled about forward.
    const f: V3 = [sy * cp, sp, cy * cp];
    const r0: V3 = [cy, 0, -sy];
    const u0: V3 = [-sy * sp, cp, -cy * sp];
    const r: V3 = [r0[0] * cr - u0[0] * sr, r0[1] * cr - u0[1] * sr, r0[2] * cr - u0[2] * sr];
    const u: V3 = [r0[0] * sr + u0[0] * cr, r0[1] * sr + u0[1] * cr, r0[2] * sr + u0[2] * cr];
    return frameMatrix(p, r, u, f, s, s, s);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
    const o = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
    }
    return o;
}

export const transformPoint = (m: Mat4, p: V3): V3 => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

// --- The engine side --------------------------------------------------------------------------------

export interface MeshData { vertexData: Float32Array | number[]; indexData: Uint32Array | number[] }

export const CACHE_NAMESPACE = "abyss";

const PIPELINE_ENTRIES = [
    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
    { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
    { binding: 2, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
] as const;
const INSTANCED_ENTRIES = [
    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
    { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "StorageReadOnly" },
    { binding: 2, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
] as const;

type Kind = "solid" | "ground" | "fx" | "people" | "instanced" | "instancedFx";

/**
 * Pipelines: "solid" Mesha objects (cast into every cascade), "ground" (the terrain: receives only),
 * "fx" (sky, effects: receive nothing they need, cast nothing), "people" (cast into the two nearest
 * cascades), and instanced batches (scattered rocks and debris; effects particles).
 */
export class Renderer {
    pipelines: Record<Kind, string> = { solid: "", ground: "", fx: "", people: "", instanced: "", instancedFx: "" };
    worldBuffer = "";
    lightTexture = "";
    private worldScratch = new Float32Array(WORLD_FLOATS);
    private itemScratch = new Float32Array(ITEM_FLOATS);
    /** Meshes spawned (id -> item buffer and pipeline kind), and which are hidden. */
    private meshes = new Map<string, { item: string; kind: Kind; triangles: number }>();
    private hidden = new Set<string>();
    triangles = 0;

    init(): void {
        const make = (name: string, kind: Kind, extra: Record<string, unknown>) => {
            const instanced = kind === "instanced" || kind === "instancedFx" || kind === "people";
            this.pipelines[kind] = Entropy.Pipeline.create({
                name, layout: "mesh", pbr: false, sunShadows: true,
                vertexShader: instanced ? ABYSS_INSTANCED_SHADER : ABYSS_SHADER,
                fragmentShader: instanced ? ABYSS_INSTANCED_SHADER : ABYSS_SHADER,
                extraBindGroups: [{ entries: (instanced ? INSTANCED_ENTRIES : PIPELINE_ENTRIES).map(e => ({ ...e, visibility: [...e.visibility] })) }],
                ...extra,
            } as Parameters<typeof Entropy.Pipeline.create>[0]);
        };
        make("Abyss", "solid", {});
        make("Abyss Ground", "ground", { shadowCaster: false });
        make("Abyss FX", "fx", { shadowCaster: false });
        make("Abyss People", "people", { shadowCascades: 2 });
        make("Abyss Instanced", "instanced", { shadowCascades: 3 });
        make("Abyss Instanced FX", "instancedFx", { shadowCaster: false });
        this.worldBuffer = Entropy.Buffer.create({ size: WORLD_FLOATS * 4, usage: "Uniform" });
        // An empty light map until the bake lands (everything lit, full sky).
        const blank = new Uint8Array(LIGHT_RES * LIGHT_RES * 4);
        for (let i = 0; i < LIGHT_RES * LIGHT_RES; i++) { blank[i * 4] = 0; blank[i * 4 + 1] = 0; blank[i * 4 + 2] = 255; blank[i * 4 + 3] = 128; }
        this.lightTexture = Entropy.Texture.create(LIGHT_RES, LIGHT_RES, blank);
    }

    setLightMap(data: Uint8Array): void {
        Entropy.Texture.update(this.lightTexture, data);
    }

    writeWorld(look: WorldLook, time: number, screen: [number, number], lights: readonly PointLight[]): void {
        Entropy.Buffer.write(this.worldBuffer, packWorld(look, time, screen, lights, this.worldScratch));
    }

    createItem(): string {
        return Entropy.Buffer.create({ size: ITEM_FLOATS * 4, usage: "Uniform" });
    }

    writeItem(item: string, matrix: Mat4, tint?: readonly number[], anim?: readonly number[], extra?: readonly number[]): void {
        packItem(this.itemScratch, 0, matrix, tint, anim, extra);
        Entropy.Buffer.write(item, this.itemScratch);
    }

    private bindings(item: string) {
        return [
            { group: 2, binding: 0, resource: { type: "Buffer" as const, value: { id: this.worldBuffer } } },
            { group: 2, binding: 1, resource: { type: "Buffer" as const, value: { id: item } } },
            { group: 2, binding: 2, resource: { type: "Texture" as const, value: { id: this.lightTexture } } },
        ];
    }

    /** Spawns `mesh` drawn with `item` (a buffer from createItem). */
    spawn(id: string, mesh: MeshData, item: string, kind: Kind = "solid", bounds?: [number, number, number, number]): void {
        this.remove(id);
        Entropy.Model.createMesh({
            id, position: [0, 0, 0], vertexData: Array.from(mesh.vertexData), indexData: Array.from(mesh.indexData),
            pipelineId: this.pipelines[kind], bindings: this.bindings(item),
        });
        if (bounds) Entropy.Model.setBounds(id, [bounds[0], bounds[1], bounds[2]], bounds[3]);
        this.meshes.set(id, { item, kind, triangles: mesh.indexData.length / 3 });
    }

    /** Caches `mesh` under `key` (if it isn't already) and spawns it from the cache. */
    spawnCached(id: string, key: string, mesh: MeshData | (() => MeshData), item: string, kind: Kind = "solid", bounds?: [number, number, number, number], instanceCount = 1): boolean {
        this.remove(id);
        if (Entropy.MeshCache.status(CACHE_NAMESPACE, key) !== "ready") {
            const m = typeof mesh === "function" ? mesh() : mesh;
            Entropy.MeshCache.put(CACHE_NAMESPACE, key, { vertexData: m.vertexData, indexData: m.indexData });
        }
        const info = Entropy.MeshCache.info(CACHE_NAMESPACE, key);
        const ok = Entropy.MeshCache.createMesh(CACHE_NAMESPACE, key, {
            id, pipelineId: this.pipelines[kind], bindings: this.bindings(item), instanceCount,
            ...(bounds ? { bounds } : {}),
        });
        if (ok) this.meshes.set(id, { item, kind, triangles: info?.triangleCount ?? 0 });
        return ok;
    }

    show(id: string, visible: boolean, instances = 1): void {
        const m = this.meshes.get(id);
        if (!m) return;
        const was = !this.hidden.has(id);
        if (visible === was && instances === 1) return;
        Entropy.Model.setInstanceCount(id, visible ? instances : 0);
        if (visible) this.hidden.delete(id); else this.hidden.add(id);
    }

    isShown(id: string): boolean { return this.meshes.has(id) && !this.hidden.has(id); }
    has(id: string): boolean { return this.meshes.has(id); }
    trianglesOf(id: string): number { return this.meshes.get(id)?.triangles ?? 0; }

    remove(id: string): void {
        if (!this.meshes.has(id)) return;
        Entropy.Model.clearMesh(id);
        this.meshes.delete(id);
        this.hidden.delete(id);
    }

    setBounds(id: string, center: V3 | null, radius: number): void {
        if (center) Entropy.Model.setBounds(id, center, radius); else Entropy.Model.setBounds(id, null, -1);
    }
}
