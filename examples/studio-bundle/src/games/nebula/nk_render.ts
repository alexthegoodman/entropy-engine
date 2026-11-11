// What Nebula Kingdom asks of the engine: two pipelines (opaque solids, additive light), the
// World uniform, and instanced batches of the few meshes in nk_meshes.ts. The packing functions
// are pure (tests check them); the Renderer is the only place that calls Entropy.* to draw.

import { NEBULA_SOLID_SHADER, NEBULA_GLOW_SHADER, WORLD_FLOATS, ITEM_FLOATS, MAX_LIGHTS, MAX_HOLES } from "./nk_shader";
import { MESHES } from "./nk_meshes";
import { InstanceBatches, meshCacheInstances, INSTANCED_BIND_GROUPS } from "../../apps/quadplanet/qp_instances";
import { basis, norm, sub, type V3 } from "./nk_math";
import type { RGB } from "./nk_data";

export const CACHE_NAMESPACE = "nebula-kingdom";
/** Bumped when a mesh in nk_meshes.ts changes shape, so the cache rebuilds. */
const MESH_VERSION = 1;

export interface LightSource { pos: V3; color: RGB; intensity: number; reach: number }

export interface WorldLook {
    time: number; warp: number; attune: number; flash: number; hurt: number;
    camPos: V3; camTarget: V3; fov: number; screen: [number, number];
    deep: RGB; a: RGB; b: RGB; clouds: number; stars: number; seed: number;
    exposure: number; saturation: number; vignette: number; fade: number;
    lights: LightSource[];
    /** Black holes in render space: x, y, z, horizon radius. */
    holes: [number, number, number, number][];
}

/** The World uniform's floats (see nk_shader.ts `World`). */
export function packWorld(l: WorldLook, out = new Float32Array(WORLD_FLOATS)): Float32Array {
    const set = (i: number, a: number, b: number, c: number, d: number) => { out[i * 4] = a; out[i * 4 + 1] = b; out[i * 4 + 2] = c; out[i * 4 + 3] = d; };
    const f = norm(sub(l.camTarget, l.camPos));
    const { right, up } = basis(f);
    // The engine's view is right-handed: its right is forward x up.
    set(0, l.time, l.warp, l.attune, l.flash);
    set(1, -right[0], -right[1], -right[2], l.screen[0] / Math.max(1, l.screen[1]));
    set(2, up[0], up[1], up[2], Math.tan((l.fov * Math.PI) / 360));
    set(3, f[0], f[1], f[2], l.hurt);
    set(4, ...l.deep, l.clouds);
    set(5, ...l.a, l.stars);
    set(6, ...l.b, l.seed);
    set(7, l.exposure, l.saturation, l.vignette, l.fade);
    const nl = Math.min(MAX_LIGHTS, l.lights.length), nh = Math.min(MAX_HOLES, l.holes.length);
    set(8, l.screen[0], l.screen[1], nl, nh);
    for (let i = 0; i < MAX_LIGHTS; i++) {
        const s = l.lights[i];
        if (i < nl) { set(9 + i * 2, ...s.pos, s.reach); set(10 + i * 2, ...s.color, s.intensity); }
        else { set(9 + i * 2, 0, 0, 0, 0); set(10 + i * 2, 0, 0, 0, 0); }
    }
    for (let i = 0; i < MAX_HOLES; i++) {
        const h = l.holes[i];
        if (i < nh) set(17 + i, h[0], h[1], h[2], h[3]); else set(17 + i, 0, 0, 0, 0);
    }
    return out;
}

export type Mat4 = number[];

/** Scale then translate (no rotation): spheres, and quads the shader turns to the camera. */
export function placed(p: V3, sx: number, sy = sx, sz = sx): Mat4 {
    return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, p[0], p[1], p[2], 1];
}

/** A frame at p whose +Z is `forward` (unit) and whose +Y leans to `upHint`, scaled per axis. */
export function oriented(p: V3, forward: V3, sx: number, sy: number, sz: number, upHint: V3 = [0, 1, 0]): Mat4 {
    let r: V3 = [upHint[1] * forward[2] - upHint[2] * forward[1], upHint[2] * forward[0] - upHint[0] * forward[2], upHint[0] * forward[1] - upHint[1] * forward[0]];
    const rl = Math.hypot(r[0], r[1], r[2]);
    r = rl < 1e-6 ? [1, 0, 0] : [r[0] / rl, r[1] / rl, r[2] / rl];
    const u: V3 = [forward[1] * r[2] - forward[2] * r[1], forward[2] * r[0] - forward[0] * r[2], forward[0] * r[1] - forward[1] * r[0]];
    return [r[0] * sx, r[1] * sx, r[2] * sx, 0, u[0] * sy, u[1] * sy, u[2] * sy, 0, forward[0] * sz, forward[1] * sz, forward[2] * sz, 0, p[0], p[1], p[2], 1];
}

export class Renderer {
    solidPipeline = "";
    glowPipeline = "";
    worldBuffer = "";
    solids!: InstanceBatches;
    glows!: InstanceBatches;
    private scratch = new Float32Array(WORLD_FLOATS);
    ready = false;

    init(): void {
        const groups = INSTANCED_BIND_GROUPS.map(g => ({ entries: g.entries.map(e => ({ ...e, visibility: [...e.visibility] })) }));
        this.solidPipeline = Entropy.Pipeline.create({ name: "Nebula Solid", layout: "mesh", pbr: false, vertexShader: NEBULA_SOLID_SHADER, fragmentShader: NEBULA_SOLID_SHADER, extraBindGroups: groups });
        this.glowPipeline = Entropy.Pipeline.create({ name: "Nebula Glow", layout: "mesh", pbr: false, vertexShader: NEBULA_GLOW_SHADER, fragmentShader: NEBULA_GLOW_SHADER, extraBindGroups: groups, transparent: true, additive: true, doubleSided: true });
        this.worldBuffer = Entropy.Buffer.create({ size: WORLD_FLOATS * 4, usage: "Uniform" });
        for (const [key, make] of Object.entries(MESHES)) {
            const k = `${key}-v${MESH_VERSION}`;
            if (Entropy.MeshCache.status(CACHE_NAMESPACE, k) !== "ready") { const m = make(); Entropy.MeshCache.put(CACHE_NAMESPACE, k, { vertexData: m.vertexData, indexData: m.indexData }); }
        }
        const engine = (pipeline: () => string) => {
            const e = meshCacheInstances(CACHE_NAMESPACE, pipeline, () => this.worldBuffer);
            return { ...e, createMesh: (key: string, meshId: string, buffer: string, instances: number) => e.createMesh(`${key}-v${MESH_VERSION}`, meshId, buffer, instances) };
        };
        this.solids = new InstanceBatches(engine(() => this.solidPipeline), ITEM_FLOATS, { prefix: "nk-solid", idleFrames: 600, initialCapacity: 64 });
        this.glows = new InstanceBatches(engine(() => this.glowPipeline), ITEM_FLOATS, { prefix: "nk-glow", idleFrames: 600, initialCapacity: 256 });
        this.ready = true;
    }

    begin(): void { this.solids.begin(); this.glows.begin(); }
    flush(): void { this.solids.flush(); this.glows.flush(); }

    writeWorld(look: WorldLook): void { Entropy.Buffer.write(this.worldBuffer, packWorld(look, this.scratch)); }

    private put(batches: InstanceBatches, mesh: string, m: Mat4, color: readonly number[], params: readonly number[], extra: readonly number[]): void {
        const { data, offset } = batches.add(mesh);
        for (let i = 0; i < 16; i++) data[offset + i] = m[i];
        for (let i = 0; i < 4; i++) { data[offset + 16 + i] = color[i] ?? 0; data[offset + 20 + i] = params[i] ?? 0; data[offset + 24 + i] = extra[i] ?? 0; }
    }

    /** An opaque mesh: params = [kind, seed, look, integrity]. */
    solid(mesh: string, m: Mat4, color: readonly number[], params: readonly number[], extra: readonly number[] = [0, 0, 0, 0]): void {
        this.put(this.solids, mesh, m, color, params, extra);
    }

    /** A piece of light on a quad: color's alpha is its strength; params = [kind, seed, 0, placement]. */
    glow(m: Mat4, color: readonly number[], kind: number, seed = 0, place = 0, extra: readonly number[] = [0, 0, 0, 0]): void {
        this.put(this.glows, "quad", m, color, [kind, seed, 0, place], extra);
    }
}
