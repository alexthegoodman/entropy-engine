// What Armageddon 2070 asks of the engine: the LIT, GLOW and SMOKE pipelines (instanced, one draw per
// mesh and chunk), the world uniform, the screen pass. Static scenery (boxes, trees, bushes) is
// packed once into 128 m chunk batches the engine culls by bounds and repacked only when cover is
// destroyed; grass near the camera is packed per 32 m chunk when the camera moves to a new one;
// everything that moves is packed every frame.

import { AR_LIT_SHADER, AR_GLOW_SHADER, AR_SMOKE_SHADER, AR_SCREEN_SHADER, WORLD_FLOATS, ITEM_FLOATS, POST_FLOATS } from "./ar_shader";
import { InstanceBatches, meshCacheInstances, INSTANCED_BIND_GROUPS } from "../../apps/quadplanet/qp_instances";
import { icosphere, quad, cone } from "../nebula/nk_meshes";
import { box, cylinder, type Mat4, type MeshData } from "../world_of_music/wom_render";
import { World, TN, TERRAIN_STEP, HALF, GROUND } from "./ar_map";
import type { V3 } from "../nebula/nk_math";

export const CACHE_NAMESPACE = "armageddon-2070";
const MESH_VERSION = 3;

function pack(positions: number[], normals: number[], uvs: number[], indices: number[], colors?: number[]): MeshData {
    const n = positions.length / 3, v = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) v.set([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2], uvs[i * 2], uvs[i * 2 + 1], colors ? colors[i * 4] : 0, colors ? colors[i * 4 + 1] : 0, colors ? colors[i * 4 + 2] : 0, colors ? colors[i * 4 + 3] : 1], i * 12);
    return { vertexData: v, indexData: new Uint32Array(indices) };
}

/** A lumpy rock: an icosphere pushed in and out by a hash of its direction. */
function rockMesh(): MeshData {
    const m = icosphere(1), v = m.vertexData;
    for (let i = 0; i < v.length; i += 12) {
        const x = v[i], y = v[i + 1], z = v[i + 2];
        const k = 0.8 + 0.35 * Math.abs(Math.sin(x * 7.1 + y * 3.3) * Math.cos(z * 5.7 - x * 2.1));
        v[i] = x * k; v[i + 1] = y * k; v[i + 2] = z * k;
    }
    return m;
}

/** A box from y = 0 to 1 (props stand on the ground): the -1..1 cube shifted up, half height. */
function standingBox(): MeshData {
    const m = box(), v = m.vertexData;
    for (let i = 0; i < v.length; i += 12) { v[i + 1] = (v[i + 1] + 1) / 2; v[i] /= 1; }
    return m;
}

/** A dome: the upper half of an icosphere, base at y = 0. */
function domeMesh(): MeshData {
    const m = icosphere(3), v = m.vertexData;
    for (let i = 0; i < v.length; i += 12) if (v[i + 1] < 0) { v[i + 1] = 0; v[i + 4] = -1; }
    return m;
}

export const MESHES: Record<string, () => MeshData> = {
    box: () => standingBox(),
    cube: () => box(),
    cyl: () => cylinder(12),
    sphere: () => icosphere(2),
    "sphere-1": () => icosphere(1),
    sky: () => icosphere(3, true),
    quad: () => quad(),
    cone: () => cone(10),
    rock: () => rockMesh(),
    dome: () => domeMesh(),
};

/** The terrain: one vertex per terrain grid point; vertex color = grass, rock, sand, paving weights. */
export function terrainMesh(w: World): MeshData {
    const P: number[] = [], N: number[] = [], U: number[] = [], C: number[] = [], I: number[] = [];
    for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
        const x = i * TERRAIN_STEP - HALF, z = j * TERRAIN_STEP - HALF, k = j * TN + i;
        P.push(x, w.heights[k], z);
        N.push(...w.normal(x, z));
        U.push(x / 8, z / 8);
        const g = w.ground[k];
        C.push(g === GROUND.grass ? 1 : 0, g === GROUND.rock || g === GROUND.snow ? 1 : 0, g === GROUND.sand || g === GROUND.glass ? 1 : 0, w.paved[k]);
    }
    for (let j = 0; j < TN - 1; j++) for (let i = 0; i < TN - 1; i++) {
        const a = j * TN + i, b = a + 1, c = a + TN, d = c + 1;
        I.push(a, c, b, b, c, d);
    }
    return pack(P, N, U, I, C);
}

/** The sea: a big grid whose vertices know the depth below them (color.r). */
export function seaMesh(w: World): MeshData {
    const P: number[] = [], N: number[] = [], U: number[] = [], C: number[] = [], I: number[] = [];
    const step = 16, half = HALF + 600, n = Math.ceil((half * 2) / step) + 1;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x = i * step - half, z = j * step - half;
        const depth = w.inBounds(x, z) ? Math.max(0, -w.height(x, z)) : 12;
        P.push(x, 0, z); N.push(0, 1, 0); U.push(x / 10, z / 10); C.push(depth, 0, 0, 1);
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i, b = a + 1, c = a + n, d = c + 1; I.push(a, c, b, b, c, d); }
    return pack(P, N, U, I, C);
}

export interface WorldLook { time: number; aspect: number; fog: number; exposure: number; sun: V3; sunIntensity: number; cam: V3; biome: number; fogColor: [number, number, number]; snowline: number; sky: [number, number, number]; glowAzimuth: number; sunColor: [number, number, number]; ambient: number; hurt: number; flash: number; emp: number; sea: number }
export interface PostLook { fog: number; fogStart: number; screen: [number, number]; fogColor: [number, number, number]; time: number; vignette: number; grain: number; hurt: number; flash: number; emp: number; ads: number; exposure: number; saturation: number }

export function packWorld(l: WorldLook, out = new Float32Array(WORLD_FLOATS)): Float32Array {
    out.set([l.time, l.aspect, l.fog, l.exposure, ...l.sun, l.sunIntensity, ...l.cam, l.biome, ...l.fogColor, l.snowline, ...l.sky, l.glowAzimuth, ...l.sunColor, l.ambient, l.hurt, l.flash, l.emp, l.sea, 0, 0, 0, 0]);
    return out;
}
export function packPost(p: PostLook, out = new Float32Array(POST_FLOATS)): Float32Array {
    out.set([p.fog, p.fogStart, p.screen[0], p.screen[1], ...p.fogColor, p.time, p.vignette, p.grain, p.hurt, p.flash, p.emp, p.ads, p.exposure, p.saturation]);
    return out;
}

export class Renderer {
    litPipeline = ""; glowPipeline = ""; smokePipeline = ""; screenPipeline = "";
    worldBuffer = ""; postBuffer = "";
    /** Static scenery by 128 m chunk (packed when dirty), grass by 32 m chunk, and dynamic things. */
    statics!: InstanceBatches;
    grass!: InstanceBatches;
    solids!: InstanceBatches;
    glows!: InstanceBatches;
    smokes!: InstanceBatches;
    ready = false;
    screenOn = false;
    private scratch = new Float32Array(WORLD_FLOATS);
    private postScratch = new Float32Array(POST_FLOATS);
    private levelMeshes = new Set<string>();

    init(): void {
        const groups = INSTANCED_BIND_GROUPS.map(g => ({ entries: g.entries.map(e => ({ ...e, visibility: [...e.visibility] })) }));
        this.litPipeline = Entropy.Pipeline.create({ name: "AR Lit", layout: "mesh", pbr: false, vertexShader: AR_LIT_SHADER, fragmentShader: AR_LIT_SHADER, extraBindGroups: groups, doubleSided: true });
        this.glowPipeline = Entropy.Pipeline.create({ name: "AR Glow", layout: "mesh", pbr: false, vertexShader: AR_GLOW_SHADER, fragmentShader: AR_GLOW_SHADER, extraBindGroups: groups, transparent: true, additive: true, doubleSided: true });
        this.smokePipeline = Entropy.Pipeline.create({ name: "AR Smoke", layout: "mesh", pbr: false, vertexShader: AR_SMOKE_SHADER, fragmentShader: AR_SMOKE_SHADER, extraBindGroups: groups, transparent: true, doubleSided: true });
        this.worldBuffer = Entropy.Buffer.create({ size: WORLD_FLOATS * 4, usage: "Uniform" });
        this.postBuffer = Entropy.Buffer.create({ size: POST_FLOATS * 4, usage: "Uniform" });
        try {
            this.screenPipeline = Entropy.Pipeline.create({ name: "AR Screen", form: "composite", pbr: false, vertexShader: AR_SCREEN_SHADER, fragmentShader: AR_SCREEN_SHADER, doubleSided: true, extraBindGroups: [{ entries: [{ binding: 0, visibility: ["Fragment"], resourceType: "Uniform" }] }] });
        } catch { this.screenPipeline = ""; }
        for (const [key, make] of Object.entries(MESHES)) this.cache(`${key}-v${MESH_VERSION}`, make);
        const engine = (pipeline: () => string) => {
            const e = meshCacheInstances(CACHE_NAMESPACE, pipeline, () => this.worldBuffer);
            // Keys are `mesh` or `mesh|chunk`; level meshes are `level:<cache key>`.
            return { ...e, createMesh: (key: string, meshId: string, buffer: string, instances: number) => e.createMesh(key.startsWith("level:") ? key.slice(6) : `${key.split("|")[0]}-v${MESH_VERSION}`, meshId, buffer, instances) };
        };
        this.statics = new InstanceBatches(engine(() => this.litPipeline), ITEM_FLOATS, { prefix: "ar-static", idleFrames: 2, initialCapacity: 64 });
        this.grass = new InstanceBatches(engine(() => this.litPipeline), ITEM_FLOATS, { prefix: "ar-grass", idleFrames: 2, initialCapacity: 64 });
        this.solids = new InstanceBatches(engine(() => this.litPipeline), ITEM_FLOATS, { prefix: "ar-lit", idleFrames: 300, initialCapacity: 64 });
        this.glows = new InstanceBatches(engine(() => this.glowPipeline), ITEM_FLOATS, { prefix: "ar-glow", idleFrames: 300, initialCapacity: 128 });
        this.smokes = new InstanceBatches(engine(() => this.smokePipeline), ITEM_FLOATS, { prefix: "ar-smoke", idleFrames: 300, initialCapacity: 64 });
        this.setScreen(true);
        this.ready = true;
    }

    private cache(key: string, make: () => MeshData): void {
        if (Entropy.MeshCache.status(CACHE_NAMESPACE, key) !== "ready") { const m = make(); Entropy.MeshCache.put(CACHE_NAMESPACE, key, { vertexData: m.vertexData, indexData: m.indexData }); }
    }

    levelMesh(key: string, make: () => MeshData): string {
        const k = `${key}-v${MESH_VERSION}`;
        if (!this.levelMeshes.has(k)) { this.cache(k, make); this.levelMeshes.add(k); }
        return `level:${k}`;
    }

    setScreen(on: boolean): void {
        this.screenOn = on && !!this.screenPipeline;
        try { Entropy.Screen?.setEffect(this.screenOn ? { pipeline: this.screenPipeline, buffers: [this.postBuffer] } : null); } catch { this.screenOn = false; }
    }

    writeWorld(look: WorldLook): void { Entropy.Buffer.write(this.worldBuffer, packWorld(look, this.scratch)); }
    writePost(p: PostLook): void { Entropy.Buffer.write(this.postBuffer, packPost(p, this.postScratch)); }

    put(b: InstanceBatches, mesh: string, m: Mat4, color: readonly number[], params: readonly number[], extra: readonly number[], sphere?: readonly number[]): void {
        const { data, offset } = b.add(mesh, sphere);
        for (let i = 0; i < 16; i++) data[offset + i] = m[i];
        for (let i = 0; i < 4; i++) { data[offset + 16 + i] = color[i] ?? 0; data[offset + 20 + i] = params[i] ?? 0; data[offset + 24 + i] = extra[i] ?? 0; }
    }

    /** An opaque thing this frame. color rgba; params [kind, seed, emissive, 0]; extra [camo, material/part/shape, 0, 0]. */
    solid(mesh: string, m: Mat4, color: readonly number[], params: readonly number[] = [0, 0, 0, 0], extra: readonly number[] = [0, 0, 0, 0]): void { this.put(this.solids, mesh, m, color, params, extra); }
    /** Additive light: color [r, g, b, strength]; params [kind, seed, width, 0]. */
    glow(m: Mat4, color: readonly number[], kind: number, width = 0.1, extra: readonly number[] = [0, 0, 0, 0]): void { this.put(this.glows, "quad", m, color, [kind, 0, width, 0], extra); }
    smoke(m: Mat4, color: readonly number[], seed: number): void { this.put(this.smokes, "quad", m, color, [0, seed, 0, 0], [0, 0, 0, 0]); }
}
