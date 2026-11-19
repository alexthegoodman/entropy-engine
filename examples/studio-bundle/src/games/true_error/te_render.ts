// What True Error asks of the engine: three instanced pipelines (ASSET, ARCH, GLOW; te_shader.ts),
// the world uniform, the screen pass, the tiling material arrays, and each Meshy model's geometry
// (cached by Entropy.MeshCache) and texture arrays.
//
// Static things are instanced: every placement of one model is one record in that model's batch,
// redrawn from a storage buffer (qp_instances.ts InstanceBatches). A skinned character is its own
// cached mesh (one key per character, so its vertices can be rewritten each frame without touching
// anyone else's) with a one-record buffer.

import { TE_ASSET_SHADER, TE_ARCH_SHADER, TE_GLOW_SHADER, TE_SCREEN_SHADER, WORLD_FLOATS, ITEM_FLOATS, POST_FLOATS, MAX_LIGHTS } from "./te_shader";
import { InstanceBatches, INSTANCED_BIND_GROUPS, type InstanceEngine } from "../../apps/quadplanet/qp_instances";
import { icosphere, quad } from "../nebula/nk_meshes";
import { box, cylinder, type Mat4 } from "../world_of_music/wom_render";
import { parseGlb, type GlbModel } from "./te_glb";
import { staticVertices } from "./te_skin";
import type { BindingConfig, BindingEntry } from "../../addon";
import type { V3 } from "./te_level";

export const CACHE = "true-error";
const MESH_VERSION = 1;
export const GAME_DIR = "examples/studio-bundle/assets/true_error/game";
const MATERIAL_DIR = "examples/studio-bundle/assets/materials";
/** ARCH texture array layers, in te_level.ts MAT order. */
export const MATERIALS = ["concrete", "granite", "marble", "metal-corrugated", "soil", "sandstone-blocks", "wood-walnut", "brick-red", "asphalt"];

export interface WorldLook {
    time: number; exposure: number; lens: number; glitch: number;
    sun: V3; sunIntensity: number; sunColor: V3; ambient: number;
    skyTop: V3; skyHorizon: V3; simPulse: number;
    ground: V3; interior: number;
    dark: V3; darkRadius: number; darkStrength: number; hitFlash: number;
    lights: { pos: V3; range: number; color: V3; intensity: number }[];
}

export interface PostLook {
    fogDensity: number; fogHeight: number; fogFloor: number; time: number;
    fogColor: V3; exposure: number;
    vignette: number; grain: number; hurt: number; fade: number;
    lens: number; glitch: number; letterbox: number; saturation: number;
    forward: V3; tanHalf: number; right: V3; aspect: number; up: V3; simPulse: number; sun: V3; sunGlow: number;
}

/** A loaded Meshy model: its parsed GLB, texture arrays and what its maps carry. */
export interface ModelAsset {
    name: string;
    glb: GlbModel;
    albedo: string;
    data: string;
    /** Item.params.y flags: 1 normal map, 2 metallic/roughness. */
    flags: number;
    /** Largest extent of the bind pose (static props are scaled by target size / this). */
    extent: number;
    /** Lift so the model's lowest point sits on y = 0. */
    floor: number;
    /** Center of the bind pose in x/z (props are recentered). */
    center: [number, number];
}

export class Renderer {
    asset = ""; arch = ""; glow = ""; screen = "";
    worldBuffer = ""; postBuffer = "";
    archMaps: string[] = [];
    readonly models = new Map<string, ModelAsset>();
    statics!: InstanceBatches;
    props!: InstanceBatches;
    glows!: InstanceBatches;
    ready = false;
    screenOn = false;
    readonly missing: string[] = [];
    /** Reads a file's bytes (the addon's scoped IO.readAsset). */
    read: (path: string) => Uint8Array | null = () => null;
    private world = new Float32Array(WORLD_FLOATS);
    private post = new Float32Array(POST_FLOATS);
    private record = new Float32Array(ITEM_FLOATS);

    init(): void {
        const groups = (extra: BindingEntry[]) => [{ entries: [...INSTANCED_BIND_GROUPS[0].entries.map(e => ({ ...e, visibility: [...e.visibility] })), ...extra] }];
        const tex = (b: number): BindingEntry => ({ binding: b, visibility: ["Fragment"], resourceType: "TextureArray" });
        this.asset = Entropy.Pipeline.create({ name: "TE Asset", layout: "mesh", pbr: false, sunShadows: true, shadowCascades: 3, vertexShader: TE_ASSET_SHADER, fragmentShader: TE_ASSET_SHADER, extraBindGroups: groups([tex(2), tex(3), { binding: 4, visibility: ["Fragment"], resourceType: "Sampler" }]), doubleSided: true, reversedDepth: true });
        this.arch = Entropy.Pipeline.create({ name: "TE Arch", layout: "mesh", pbr: false, sunShadows: true, vertexShader: TE_ARCH_SHADER, fragmentShader: TE_ARCH_SHADER, extraBindGroups: groups([tex(2), tex(3), tex(4), { binding: 5, visibility: ["Fragment"], resourceType: "Sampler" }]), doubleSided: true, reversedDepth: true });
        this.glow = Entropy.Pipeline.create({ name: "TE Glow", layout: "mesh", pbr: false, vertexShader: TE_GLOW_SHADER, fragmentShader: TE_GLOW_SHADER, extraBindGroups: groups([]), transparent: true, additive: true, doubleSided: true, reversedDepth: true });
        this.worldBuffer = Entropy.Buffer.create({ size: WORLD_FLOATS * 4, usage: "Uniform" });
        this.postBuffer = Entropy.Buffer.create({ size: POST_FLOATS * 4, usage: "Uniform" });
        Entropy.Screen.setReversedDepth(true);
        try {
            this.screen = Entropy.Pipeline.create({ name: "TE Screen", form: "composite", pbr: false, vertexShader: TE_SCREEN_SHADER, fragmentShader: TE_SCREEN_SHADER, doubleSided: true, extraBindGroups: [{ entries: [{ binding: 0, visibility: ["Fragment"], resourceType: "Uniform" }] }] });
        } catch { this.screen = ""; }

        // Tiling materials: one array per map type, a layer per set.
        const files = (map: string) => MATERIALS.map(m => `${MATERIAL_DIR}/${m}/${map}.png`);
        this.archMaps = [
            Entropy.Texture.loadArray({ id: "te-base", files: files("basecolor"), srgb: true, size: 1024, fallback: "checker" }).id,
            Entropy.Texture.loadArray({ id: "te-normal", files: files("normal"), srgb: false, size: 1024, fallback: [0.5, 0.5, 1, 1] }).id,
            Entropy.Texture.loadArray({ id: "te-rough", files: files("roughness"), srgb: false, size: 512, fallback: [0.8, 0.8, 0.8, 1] }).id,
        ];

        for (const [key, make] of Object.entries(SHAPES)) this.cache(`${key}-v${MESH_VERSION}`, make);
        this.statics = new InstanceBatches(this.engine(() => this.arch, () => this.archBindings()), ITEM_FLOATS, { prefix: "te-arch", idleFrames: 600, initialCapacity: 8 });
        this.props = new InstanceBatches(this.engine(() => this.asset, key => this.modelBindings(key)), ITEM_FLOATS, { prefix: "te-prop", idleFrames: 600, initialCapacity: 16 });
        this.glows = new InstanceBatches(this.engine(() => this.glow, () => []), ITEM_FLOATS, { prefix: "te-glow", idleFrames: 300, initialCapacity: 64 });
        this.setScreen(true);
        this.ready = true;
    }

    /** Batches whose meshes come from this game's cache, with per-key extra bindings. */
    private engine(pipeline: () => string, extra: (key: string) => BindingConfig[]): InstanceEngine {
        return {
            createBuffer: bytes => Entropy.Buffer.create({ size: bytes, usage: "Storage" }),
            destroyBuffer: id => Entropy.Buffer.destroy(id),
            writeBuffer: (id, data) => Entropy.Buffer.write(id, data),
            createMesh: (key, meshId, buffer, instances) => Entropy.MeshCache.createMesh(CACHE, this.cacheKey(key), {
                id: meshId, pipelineId: pipeline(), instanceCount: instances, bindings: [
                    { group: 2, binding: 0, resource: { type: "Buffer", value: { id: this.worldBuffer } } },
                    { group: 2, binding: 1, resource: { type: "Buffer", value: { id: buffer } } },
                    ...extra(key),
                ],
            }),
            clearMesh: meshId => Entropy.Model.clearMesh(meshId),
            setInstanceCount: (meshId, count) => Entropy.Model.setInstanceCount(meshId, count),
            setBounds: (meshId, center, radius) => center ? Entropy.Model.setBounds(meshId, center, radius) : Entropy.Model.setBounds(meshId, null, -1),
        };
    }

    /**
     * Batch keys: a shape (`box`), a model (`model:rubble`) or a level mesh (`level:<key>`). A
     * `@chunk` suffix splits one model into spatial batches (same mesh) that are culled apart.
     */
    private cacheKey(key: string): string {
        key = key.split("@")[0];
        if (key.startsWith("model:")) return `model-${key.slice(6)}-v${MESH_VERSION}`;
        if (key.startsWith("level:")) return key.slice(6);
        return `${key}-v${MESH_VERSION}`;
    }

    private archBindings(): BindingConfig[] {
        return [
            ...this.archMaps.map((id, i) => ({ group: 2, binding: 2 + i, resource: { type: "Texture", value: { id } } }) as BindingConfig),
            { group: 2, binding: 5, resource: { type: "SamplerRepeat" } } as BindingConfig,
        ];
    }

    modelBindings(key: string): BindingConfig[] {
        key = key.split("@")[0];
        const m = this.models.get(key.startsWith("model:") ? key.slice(6) : key);
        if (!m) return [];
        return [
            { group: 2, binding: 2, resource: { type: "Texture", value: { id: m.albedo } } },
            { group: 2, binding: 3, resource: { type: "Texture", value: { id: m.data } } },
            { group: 2, binding: 4, resource: { type: "Sampler" } },
        ];
    }

    private cache(key: string, make: () => { vertexData: Float32Array; indexData: Uint32Array }): void {
        if (Entropy.MeshCache.status(CACHE, key) !== "ready") { const m = make(); Entropy.MeshCache.put(CACHE, key, { vertexData: m.vertexData, indexData: m.indexData }); }
    }

    /** Caches a level mesh under `key` (rebuilt when the key changes) and returns its batch key. */
    levelMesh(key: string, make: () => { vertexData: Float32Array; indexData: Uint32Array }): string {
        this.cache(key, make);
        return `level:${key}`;
    }

    /**
     * Loads a model: its GLB (geometry only, tools/te_assets.py), its texture arrays, and for a
     * static one its geometry into the cache. Returns null (and notes it) when the file is missing.
     */
    loadModel(name: string): ModelAsset | null {
        if (this.models.has(name)) return this.models.get(name)!;
        const bytes = this.read(`${GAME_DIR}/${name}.glb`);
        if (!bytes) { this.missing.push(name); return null; }
        const glb = parseGlb(bytes);
        const hasNormal = !!this.read(`${GAME_DIR}/${name}_normal.png`)?.length;
        const hasMr = !!this.read(`${GAME_DIR}/${name}_mr.png`)?.length;
        const albedo = Entropy.Texture.loadArray({ id: `te-${name}-albedo`, files: [`${GAME_DIR}/${name}_albedo.png`], srgb: true, fallback: [0.6, 0.55, 0.5, 1] }).id;
        const data = Entropy.Texture.loadArray({ id: `te-${name}-data`, files: [`${GAME_DIR}/${name}_normal.png`, `${GAME_DIR}/${name}_mr.png`], srgb: false, fallback: [0.5, 0.5, 1, 1] }).id;
        const ext = [glb.max[0] - glb.min[0], glb.max[1] - glb.min[1], glb.max[2] - glb.min[2]];
        const asset: ModelAsset = {
            name, glb, albedo, data, flags: (hasNormal ? 1 : 0) | (hasMr ? 2 : 0),
            extent: Math.max(...ext), floor: -glb.min[1], center: [(glb.min[0] + glb.max[0]) / 2, (glb.min[2] + glb.max[2]) / 2],
        };
        if (!glb.skin) this.cache(`model-${name}-v${MESH_VERSION}`, () => ({ vertexData: staticVertices(glb), indexData: glb.indices }));
        this.models.set(name, asset);
        return asset;
    }

    setScreen(on: boolean): void {
        this.screenOn = on && !!this.screen;
        try { Entropy.Screen?.setEffect(this.screenOn ? { pipeline: this.screen, buffers: [this.postBuffer] } : null); } catch { this.screenOn = false; }
    }

    writeWorld(l: WorldLook): void {
        const w = this.world;
        w.set([l.time, l.exposure, l.lens, l.glitch, ...l.sun, l.sunIntensity, ...l.sunColor, l.ambient, ...l.skyTop, Math.min(l.lights.length, MAX_LIGHTS), ...l.skyHorizon, l.simPulse, ...l.ground, l.interior, ...l.dark, l.darkRadius, l.darkStrength, l.hitFlash, 0, 0], 0);
        for (let i = 0; i < MAX_LIGHTS; i++) {
            const li = l.lights[i];
            const o = 32 + i * 8;
            if (li) w.set([...li.pos, li.range, ...li.color, li.intensity], o);
            else w.fill(0, o, o + 8);
        }
        Entropy.Buffer.write(this.worldBuffer, w);
    }

    writePost(p: PostLook): void {
        this.post.set([p.fogDensity, p.fogHeight, p.fogFloor, p.time, ...p.fogColor, p.exposure, p.vignette, p.grain, p.hurt, p.fade, p.lens, p.glitch, p.letterbox, p.saturation,
            ...p.forward, p.tanHalf, ...p.right, p.aspect, ...p.up, p.simPulse, ...p.sun, p.sunGlow]);
        Entropy.Buffer.write(this.postBuffer, this.post);
    }

    /** One record into a batch: matrix, color, params [kind, flags, emissive, heat], extra. */
    put(b: InstanceBatches, key: string, m: Mat4 | Float32Array, color: readonly number[], params: readonly number[] = [0, 0, 0, 0], extra: readonly number[] = [0, 0, 0, 0], sphere?: readonly number[]): void {
        const { data, offset } = b.add(key, sphere);
        for (let i = 0; i < 16; i++) data[offset + i] = m[i];
        for (let i = 0; i < 4; i++) { data[offset + 16 + i] = color[i] ?? 0; data[offset + 20 + i] = params[i] ?? 0; data[offset + 24 + i] = extra[i] ?? 0; }
    }

    glowAt(kind: number, m: Mat4, color: readonly number[], extra: readonly number[] = [0, 0, 0, 0], simOnly = false, shape = "quad"): void {
        this.put(this.glows, shape, m, color, [kind, simOnly ? 1 : 0, 0, 0], extra);
    }

    /** Writes a one-record item buffer (a skinned character's). */
    writeRecord(buffer: string, m: Mat4 | Float32Array, color: readonly number[], params: readonly number[], extra: readonly number[]): void {
        const r = this.record;
        r.set(m as ArrayLike<number>, 0);
        r.set(color, 16); r.set(params, 20); r.set(extra, 24);
        Entropy.Buffer.write(buffer, r);
    }
}

/** Shapes drawn by the glow and arch batches. */
export const SHAPES: Record<string, () => { vertexData: Float32Array; indexData: Uint32Array }> = {
    quad: () => quad(),
    box: () => box(),
    cyl: () => cylinder(16),
    sphere: () => icosphere(3),
    sky: () => icosphere(3, true),
    ring: () => {
        // A flat disc in xz (radius 1) for objective rings.
        const P: number[] = [];
        const I: number[] = [];
        const n = 48;
        P.push(0, 0, 0, 0, 1, 0, 0.5, 0.5, 1, 1, 1, 1);
        for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; P.push(Math.cos(a), 0, Math.sin(a), 0, 1, 0, 0, 0, 1, 1, 1, 1); }
        for (let i = 1; i <= n; i++) I.push(0, i, i + 1);
        return { vertexData: new Float32Array(P), indexData: new Uint32Array(I) };
    },
};

/**
 * A character drawn from its own copy of the model's geometry, rewritten every frame it is posed.
 * The mesh is spawned once from a per-character cache key and kept; `hide` sets its instances to 0.
 */
export class SkinnedMesh {
    readonly meshId: string;
    readonly buffer: string;
    readonly verts: Float32Array;
    private shown = true;
    constructor(r: Renderer, readonly model: ModelAsset, id: string) {
        const key = `skin-${id}-v${MESH_VERSION}`;
        const g = model.glb;
        this.verts = staticVertices(g);
        Entropy.MeshCache.put(CACHE, key, { vertexData: this.verts, indexData: g.indices });
        this.buffer = Entropy.Buffer.create({ size: ITEM_FLOATS * 4, usage: "Storage" });
        this.meshId = `te-skin-${id}`;
        Entropy.MeshCache.createMesh(CACHE, key, {
            id: this.meshId, pipelineId: r.asset, instanceCount: 1, bindings: [
                { group: 2, binding: 0, resource: { type: "Buffer", value: { id: r.worldBuffer } } },
                { group: 2, binding: 1, resource: { type: "Buffer", value: { id: this.buffer } } },
                ...r.modelBindings(model.name),
            ],
        });
    }
    upload(): void { Entropy.Mesh.writeVertices(this.meshId, 0, this.verts); }
    show(on: boolean): void { if (on !== this.shown) { this.shown = on; Entropy.Model.setInstanceCount(this.meshId, on ? 1 : 0); } }
    dispose(): void { Entropy.Model.clearMesh(this.meshId); Entropy.Buffer.destroy(this.buffer); }
}
