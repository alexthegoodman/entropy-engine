// The hand-off package: everything an AI coding agent (or a person) needs to build this level in
// any engine or language, as one zip.
//
//   README.md                 what is here, the coordinate frame and units, how to build it
//   scene.json                every placed object (model file, transform, what the plan says it is),
//                             roads, rivers, regions, spots, NPCs and creatures, scatter, lighting
//   models/<name>.glb         one GLB per distinct model variant (glTF 2.0, PBR materials per
//                             semantic region), plus models/index.json (Mesha object, parameters,
//                             bounds, triangle counts, materials)
//   terrain/heightmap.png     the whole world's heightfield, 16-bit grayscale (terrain.json says
//                             the meters each value means and the world size it spans)
//   terrain/site-<n>-*.png    each detailed site at 2 m: its real ground heights (pads, road beds,
//                             river beds, micro-relief) and ground colors
//   terrain/mask-<mark>.png   painted planning marks (forest, farmland, snow...) as density masks
//   materials.json            every material used, and the ground materials
//   lore/                     the world bible (JSON), the Game Design Document (Markdown), codex,
//                             story and quests, regions with their plans
//
// Everything is plain data built here (GLB and PNG encoders included), so it is tested without
// the engine; the addon zips the entries with Entropy.IO.saveArchive.

import type { GameWorld } from "../game_planner/planner_types";
import { exportWorldBibleJson, generateGameDesignDoc } from "../game_planner/agent_pipeline";
import { lookupObject } from "../mesha/library";
import { evaluateObject, type ParamValues } from "../mesha/mesha_object";
import { mergeByRegion } from "../mesha/mesha_mesh";
import { FALLBACK_MATERIAL, type MaterialPreset } from "../mesha/mesha_materials";
import type { Ground } from "./detail_ground";
import { builtinMesh, quantizedSize, type PackedMesh } from "./detail_mesh";
import { buildSceneItems, type SceneItem, type BuiltinShape } from "./detail_scene";
import { scatterTile, tilesAround, type ScatterInstance } from "./detail_scatter";
import { DEFAULT_GROUND } from "./detail_models";
import type { WorldDetail } from "./detail_types";

export interface ArchiveEntry { name: string; data: Uint8Array | string }

/** UTF-8 bytes of a string (the addon runtime has no TextEncoder). */
export function utf8(text: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
        let c = text.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
            const d = text.charCodeAt(i + 1);
            if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
}

// -------------------------------------------------------------------------------------------------
// CRC32, Adler-32, PNG
// -------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length, seed = 0): number {
    let c = (seed ^ 0xffffffff) >>> 0;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
    let a = 1, b = 0;
    for (let i = 0; i < bytes.length; i++) {
        a = (a + bytes[i]) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

/** zlib with stored (uncompressed) blocks: the zip deflates the PNG as a whole anyway. */
function zlibStored(data: Uint8Array): Uint8Array {
    const blocks = Math.max(1, Math.ceil(data.length / 65535));
    const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
    out[0] = 0x78; out[1] = 0x01;
    let o = 2;
    for (let b = 0; b < blocks; b++) {
        const start = b * 65535, len = Math.min(65535, data.length - start);
        out[o++] = b === blocks - 1 ? 1 : 0;
        out[o++] = len & 255; out[o++] = len >> 8;
        out[o++] = ~len & 255; out[o++] = (~len >> 8) & 255;
        out.set(data.subarray(start, start + len), o);
        o += len;
    }
    const ad = adler32(data);
    out[o++] = ad >>> 24; out[o++] = (ad >>> 16) & 255; out[o++] = (ad >>> 8) & 255; out[o++] = ad & 255;
    return out.subarray(0, o);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
}

/**
 * A PNG: `channels` 1 (gray), 3 (RGB) or 4 (RGBA), 8 or 16 bits. `pixels` holds rows top to
 * bottom, channel values 0..255 or 0..65535.
 */
export function encodePng(width: number, height: number, pixels: ArrayLike<number>, channels: 1 | 3 | 4, bitDepth: 8 | 16): Uint8Array {
    const bpp = channels * (bitDepth / 8);
    const raw = new Uint8Array(height * (1 + width * bpp));
    for (let y = 0, o = 0; y < height; y++) {
        raw[o++] = 0; // no filter
        for (let x = 0; x < width * channels; x++) {
            const v = pixels[y * width * channels + x] | 0;
            if (bitDepth === 16) { raw[o++] = (v >> 8) & 255; raw[o++] = v & 255; } else raw[o++] = v & 255;
        }
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width); dv.setUint32(4, height);
    ihdr[8] = bitDepth; ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlibStored(raw)), pngChunk("IEND", new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

// -------------------------------------------------------------------------------------------------
// GLB
// -------------------------------------------------------------------------------------------------

export interface GlbPrimitive {
    name: string;
    positions: ArrayLike<number>;
    normals: ArrayLike<number>;
    uvs: ArrayLike<number>;
    indices: ArrayLike<number>;
    material: { name: string; color: [number, number, number]; metallic: number; roughness: number; emissive?: boolean; transmission?: number };
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A self-contained binary glTF 2.0 with one mesh (one primitive per material), in meters, +Y up. */
export function encodeGlb(meshName: string, prims: GlbPrimitive[]): Uint8Array {
    const chunks: Uint8Array[] = [];
    let binLength = 0;
    const bufferViews: any[] = [], accessors: any[] = [], materials: any[] = [], primitives: any[] = [];
    const add = (bytes: Uint8Array, target: number) => {
        const pad = (4 - (binLength % 4)) % 4;
        if (pad) { chunks.push(new Uint8Array(pad)); binLength += pad; }
        bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.length, target });
        chunks.push(bytes);
        binLength += bytes.length;
        return bufferViews.length - 1;
    };
    const matIndex = new Map<string, number>();
    for (const p of prims) {
        const n = p.positions.length / 3;
        if (!n || !p.indices.length) continue;
        const pos = Float32Array.from(p.positions);
        const nrm = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const x = p.normals[i * 3] ?? 0, y = p.normals[i * 3 + 1] ?? 1, z = p.normals[i * 3 + 2] ?? 0;
            const l = Math.hypot(x, y, z) || 1;
            nrm[i * 3] = x / l; nrm[i * 3 + 1] = y / l; nrm[i * 3 + 2] = z / l;
        }
        const uv = new Float32Array(n * 2);
        for (let i = 0; i < n * 2; i++) uv[i] = p.uvs[i] ?? 0;
        const idx = Uint32Array.from(p.indices);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pos[i * 3 + a]); max[a] = Math.max(max[a], pos[i * 3 + a]); }
        const vPos = add(new Uint8Array(pos.buffer), 34962), vNrm = add(new Uint8Array(nrm.buffer), 34962), vUv = add(new Uint8Array(uv.buffer), 34962), vIdx = add(new Uint8Array(idx.buffer), 34963);
        accessors.push({ bufferView: vPos, componentType: 5126, count: n, type: "VEC3", min, max });
        const aPos = accessors.length - 1;
        accessors.push({ bufferView: vNrm, componentType: 5126, count: n, type: "VEC3" });
        const aNrm = accessors.length - 1;
        accessors.push({ bufferView: vUv, componentType: 5126, count: n, type: "VEC2" });
        const aUv = accessors.length - 1;
        accessors.push({ bufferView: vIdx, componentType: 5125, count: idx.length, type: "SCALAR" });
        const aIdx = accessors.length - 1;
        let mi = matIndex.get(p.material.name);
        if (mi === undefined) {
            const m = p.material;
            const mat: any = {
                name: m.name,
                pbrMetallicRoughness: { baseColorFactor: [srgbToLinear(m.color[0]), srgbToLinear(m.color[1]), srgbToLinear(m.color[2]), 1], metallicFactor: m.metallic, roughnessFactor: m.roughness },
                doubleSided: true,
            };
            if (m.emissive) mat.emissiveFactor = mat.pbrMetallicRoughness.baseColorFactor.slice(0, 3);
            if (m.transmission) { mat.extensions = { KHR_materials_transmission: { transmissionFactor: m.transmission } }; }
            materials.push(mat);
            mi = materials.length - 1;
            matIndex.set(m.name, mi);
        }
        primitives.push({ attributes: { POSITION: aPos, NORMAL: aNrm, TEXCOORD_0: aUv }, indices: aIdx, material: mi, mode: 4 });
    }
    const usesTransmission = materials.some((m) => m.extensions?.KHR_materials_transmission);
    const json: any = {
        asset: { version: "2.0", generator: "Entropy Game World Detailer" },
        scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: meshName, mesh: 0 }],
        meshes: [{ name: meshName, primitives }], materials, accessors, bufferViews,
        buffers: [{ byteLength: binLength }],
        ...(usesTransmission ? { extensionsUsed: ["KHR_materials_transmission"] } : {}),
    };
    const jsonBytes = utf8(JSON.stringify(json));
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    const binPad = (4 - (binLength % 4)) % 4;
    const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + binLength + binPad;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length + jsonPad, true); dv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20);
    out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
    let o = 20 + jsonBytes.length + jsonPad;
    dv.setUint32(o, binLength + binPad, true); dv.setUint32(o + 4, 0x004e4942, true);
    o += 8;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
}

/** Reads a GLB's JSON chunk back (tests, and anyone checking a package). */
export function readGlbJson(glb: Uint8Array): any {
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
    const len = dv.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len)));
}

function materialOf(m: MaterialPreset): GlbPrimitive["material"] {
    return { name: m.id, color: m.color, metallic: m.metallic, roughness: m.roughness, emissive: m.pattern === "glow", transmission: m.clear ?? m.transmission };
}

/** A Mesha model variant as a GLB, one primitive per semantic region. */
export function modelGlb(objectId: string, values: ParamValues): { glb: Uint8Array; triangles: number; bounds: { min: number[]; max: number[] }; materials: Record<string, MaterialPreset>; regions: string[] } {
    const def = lookupObject(objectId);
    if (!def) throw new Error(`No Mesha object "${objectId}"`);
    const e = evaluateObject(def, values, lookupObject);
    const parts = mergeByRegion(e.mesh);
    const prims: GlbPrimitive[] = parts.map((p) => {
        const m = e.materials[p.region] ?? FALLBACK_MATERIAL;
        return { name: p.region, positions: p.positions, normals: p.normals, uvs: p.uvs, indices: p.indices, material: materialOf(m) };
    });
    const b = e.stats.bounds;
    return {
        glb: encodeGlb(def.name, prims), triangles: e.stats.triangles,
        bounds: { min: b ? [...b.min] : [0, 0, 0], max: b ? [...b.max] : [0, 0, 0] },
        materials: Object.fromEntries(parts.map((p) => [p.region, e.materials[p.region] ?? FALLBACK_MATERIAL])), regions: parts.map((p) => p.region),
    };
}

/** A packed (engine-layout) mesh as a GLB: builtins. Color and roughness come from the vertices. */
export function packedGlb(name: string, m: PackedMesh): Uint8Array {
    const n = m.vertexData.length / 12;
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
    for (let i = 0; i < n; i++) {
        const o = i * 12;
        positions.push(m.vertexData[o], m.vertexData[o + 1], m.vertexData[o + 2]);
        normals.push(m.vertexData[o + 3], m.vertexData[o + 4], m.vertexData[o + 5]);
        uvs.push(m.vertexData[o + 6], m.vertexData[o + 7]);
    }
    const c: [number, number, number] = n ? [m.vertexData[8], m.vertexData[9], m.vertexData[10]] : [0.6, 0.6, 0.6];
    const rough = n ? Math.min(1, (m.vertexData[11] % 0.5) / 0.49) : 0.8;
    return encodeGlb(name, [{ name, positions, normals, uvs, indices: Array.from(m.indexData), material: { name: `${name}-surface`, color: c, metallic: 0, roughness: rough } }]);
}

// -------------------------------------------------------------------------------------------------
// The package
// -------------------------------------------------------------------------------------------------

export interface ExportOptions {
    /** Scatter instances and 2 m site heightmaps are written around these points (km). */
    sites: Array<{ name: string; x: number; y: number }>;
    /** Radius around each site (km). */
    siteRadiusKm?: number;
    /** Site heightmap spacing (m). */
    siteStepM?: number;
}

export interface ExportProgress { done: number; total: number; label: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const toWorldM = (x: number, y: number, elevation: number): [number, number, number] => [r3(x * 1000), r3(elevation), r3(-y * 1000)];

/** The variant identity of an item's model (one GLB each). */
function modelId(item: SceneItem): string {
    if (item.builtin) { const s = quantizedSize(item.builtin); return `builtin:${item.builtin.kind}:${s.join("x")}`; }
    const v = item.model!.values;
    return `${item.model!.objectId}|${Object.keys(v).sort().map((k) => `${k}=${v[k]}`).join(",")}`;
}

/**
 * Builds the package's entries, one step at a time (models take a while to evaluate): iterate it,
 * and its return value is the entries. Each yield reports progress.
 */
export function* buildPackage(world: GameWorld, detail: WorldDetail, ground: Ground, opts: ExportOptions): Generator<ExportProgress, ArchiveEntry[], void> {
    const entries: ArchiveEntry[] = [];
    const items = buildSceneItems(world, detail, ground).filter((i) => !i.hidden && (i.model || i.builtin));
    const siteRadius = opts.siteRadiusKm ?? 0.5;
    // Scatter around each site, deduplicated by tile.
    const tileKm = 0.128;
    const tiles = new Map<string, [number, number]>();
    for (const s of opts.sites) for (const t of tilesAround(s.x, s.y, siteRadius, tileKm)) tiles.set(t.join(","), t);
    const scatter: ScatterInstance[] = [];
    for (const [tx, ty] of tiles.values()) scatter.push(...scatterTile(ground, detail, tx, ty, tileKm, { density: 1 }));

    // Distinct models: placed things and scatter variants.
    const models = new Map<string, { file: string; objectId: string | null; values: ParamValues | null; builtin?: BuiltinShape; uses: number }>();
    const fileNames = new Set<string>();
    const register = (id: string, objectId: string | null, values: ParamValues | null, builtin?: BuiltinShape) => {
        let m = models.get(id);
        if (!m) {
            const base = slug(builtin ? `builtin-${builtin.kind}-${quantizedSize(builtin).join("x")}` : `${objectId!.split(".").pop()}`);
            let file = `models/${base}.glb`, k = 2;
            while (fileNames.has(file)) file = `models/${base}-${k++}.glb`;
            fileNames.add(file);
            m = { file, objectId, values, builtin, uses: 0 };
            models.set(id, m);
        }
        m.uses++;
        return m;
    };
    for (const i of items) register(modelId(i), i.model?.objectId ?? null, i.model?.values ?? null, i.builtin);
    for (const s of scatter) register(s.variantKey, s.model.objectId, s.model.values);

    const total = models.size + 4;
    let done = 0;
    yield { done, total, label: `${models.size} models to build` };

    const modelIndex: any[] = [];
    const materialsUsed = new Map<string, MaterialPreset>();
    for (const [id, m] of models) {
        let entry: any;
        if (m.builtin) {
            const mesh = builtinMesh(m.builtin);
            entries.push({ name: m.file, data: packedGlb(`${m.builtin.kind}`, mesh) });
            entry = { file: m.file, builtin: m.builtin.kind, size: quantizedSize(m.builtin), triangles: mesh.triangles, uses: m.uses };
        } else {
            const g = modelGlb(m.objectId!, m.values!);
            entries.push({ name: m.file, data: g.glb });
            for (const mat of Object.values(g.materials)) materialsUsed.set(mat.id, mat);
            const def = lookupObject(m.objectId!)!;
            entry = {
                file: m.file, meshaObject: m.objectId, name: def.name, category: def.category, parameters: m.values,
                triangles: g.triangles, boundsM: g.bounds, regions: Object.fromEntries(Object.entries(g.materials).map(([r, mat]) => [r, mat.id])), uses: m.uses,
            };
        }
        modelIndex.push({ id, ...entry });
        done++;
        yield { done, total, label: `Built ${m.file}` };
    }
    entries.push({ name: "models/index.json", data: JSON.stringify(modelIndex, null, 1) });

    // Terrain: the world heightfield, masks of painted marks, and each site at 2 m.
    const t = world.terrain;
    const terrainInfo: any = { coordinateFrame: "see README.md", worldWidthM: world.meta.worldWidthKm * 1000, worldHeightM: world.meta.worldHeightKm * 1000, seaLevelM: ground.seaLevelM };
    if (t) {
        const px = new Uint16Array(t.cols * t.rows);
        const range = Math.max(1e-6, t.maxM - t.minM);
        for (let i = 0; i < px.length; i++) px[i] = Math.round(((t.data[i] - t.minM) / range) * 65535);
        entries.push({ name: "terrain/heightmap.png", data: encodePng(t.cols, t.rows, px, 1, 16) });
        terrainInfo.heightmap = { file: "terrain/heightmap.png", width: t.cols, height: t.rows, bits: 16, minM: t.minM, maxM: t.maxM, meters: "minM + value / 65535 * (maxM - minM)", rowZero: "north edge", columnZero: "west edge", spacingM: (world.meta.worldWidthKm * 1000) / (t.cols - 1), interpolation: "Catmull-Rom (bicubic) - the Detailer's own ground adds pads, road beds, river beds and micro-relief: see the site heightmaps" };
    }
    const masks: any[] = [];
    if (world.overlay) {
        const o = world.overlay;
        for (const [key, layer] of Object.entries(o.layers)) {
            const px = new Uint8Array(o.cols * o.rows);
            for (let i = 0; i < px.length; i++) px[i] = Math.round(Math.max(0, Math.min(1, layer[i] || 0)) * 255);
            const file = `terrain/mask-${slug(key)}.png`;
            entries.push({ name: file, data: encodePng(o.cols, o.rows, px, 1, 8) });
            masks.push({ key, file, width: o.cols, height: o.rows, meaning: key.startsWith("codex:") ? "where this codex entry roams (density)" : "painted density 0..1 of this planning mark", cellCentered: true });
        }
    }
    terrainInfo.masks = masks;
    done++;
    yield { done, total, label: "World heightmap and masks" };

    const step = opts.siteStepM ?? 2;
    const siteInfo: any[] = [];
    opts.sites.forEach((s, n) => {
        const size = Math.round((siteRadius * 2 * 1000) / step) + 1;
        const x0 = s.x - siteRadius, y1 = s.y + siteRadius;
        const heights = new Float32Array(size * size);
        const colors = new Uint8Array(size * size * 3);
        let lo = Infinity, hi = -Infinity;
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                const smp = ground.sample(x0 + (c * step) / 1000, y1 - (r * step) / 1000, true);
                heights[r * size + c] = smp.h;
                lo = Math.min(lo, smp.h); hi = Math.max(hi, smp.h);
                const col = smp.surface!.color;
                colors.set([Math.round(col[0] * 255), Math.round(col[1] * 255), Math.round(col[2] * 255)], (r * size + c) * 3);
            }
        }
        const px = new Uint16Array(size * size);
        for (let i = 0; i < px.length; i++) px[i] = Math.round(((heights[i] - lo) / Math.max(1e-6, hi - lo)) * 65535);
        const base = `terrain/site-${n + 1}-${slug(s.name)}`;
        entries.push({ name: `${base}-height.png`, data: encodePng(size, size, px, 1, 16) });
        entries.push({ name: `${base}-color.png`, data: encodePng(size, size, colors, 3, 8) });
        siteInfo.push({ name: s.name, centerKm: [s.x, s.y], centerM: toWorldM(s.x, s.y, 0).filter((_, i) => i !== 1), sizeM: siteRadius * 2000, spacingM: step, width: size, height: size, heightFile: `${base}-height.png`, colorFile: `${base}-color.png`, minM: lo, maxM: hi, rowZero: "north edge" });
    });
    terrainInfo.sites = siteInfo;
    entries.push({ name: "terrain/terrain.json", data: JSON.stringify(terrainInfo, null, 1) });
    done++;
    yield { done, total, label: "Site heightmaps" };

    // The scene.
    const codex = new Map(world.codex.map((c) => [c.id, c]));
    const structures = new Map((world.structures ?? []).map((s) => [s.id, s]));
    const spots = new Map(world.spots.map((s) => [s.id, s]));
    const placements = new Map((world.placements ?? []).map((p) => [p.id, p]));
    const objects = items.map((i) => {
        const m = models.get(modelId(i))!;
        const plan: any = { source: i.source, id: i.sourceId };
        if (i.source === "structure") { const s = structures.get(i.sourceId)!; Object.assign(plan, { kind: s.kind, shape: s.shape, footprintM: [s.widthM, s.depthM], floors: s.floors, settlementId: s.spotId, occupants: s.occupantCodexIds, notes: s.notes }); }
        if (i.source === "spot") { const s = spots.get(i.sourceId)!; Object.assign(plan, { spotType: s.spotType, dangerLevel: s.dangerLevel, description: s.description, lore: s.loreNotes }); }
        if (i.source === "placement") { const p = placements.get(i.sourceId)!; const c = codex.get(p.codexId); Object.assign(plan, { codexId: p.codexId, codexName: c?.name, category: c?.category, behavior: p.behavior, levelMin: p.levelMin, levelMax: p.levelMax, groupSize: p.count, notes: p.notes }); }
        if (i.source === "prop") { const p = detail.props.find((x) => x.id === i.sourceId); Object.assign(plan, { notes: p?.notes, anchorId: p?.anchorId }); }
        return { key: i.key, name: i.name, model: m.file, positionM: toWorldM(i.x, i.y, i.elevation), positionKm: [i.x, i.y], rotationYDeg: r3((i.yaw * 180) / Math.PI), scale: r3(i.scale), plan };
    });
    const scatterByModel = new Map<string, { model: string; layer: string; instances: number[][] }>();
    for (const s of scatter) {
        const file = models.get(s.variantKey)!.file;
        const k = `${s.layer}|${file}`;
        let g = scatterByModel.get(k);
        if (!g) { g = { model: file, layer: s.layer, instances: [] }; scatterByModel.set(k, g); }
        const p = toWorldM(s.x, s.y, s.elevation);
        g.instances.push([p[0], p[1], p[2], r3((s.yaw * 180) / Math.PI), r3(s.scale)]);
    }
    const line = (points: [number, number][]) => points.map(([x, y]) => toWorldM(x, y, ground.heightAt(x, y)));
    const scene = {
        format: "entropy-game-level", version: 1,
        world: { id: world.meta.id, name: world.meta.name, genre: world.meta.genre, description: world.meta.description, sizeM: [world.meta.worldWidthKm * 1000, world.meta.worldHeightKm * 1000], seaLevelM: ground.seaLevelM },
        coordinateFrame: { units: "meters", up: "+Y", east: "+X", south: "+Z (north is -Z)", origin: "the world's center at elevation 0", rotation: "rotationYDeg counter-clockwise seen from above (right-handed, about +Y); a model's front faces +Z at 0", planKm: "positionKm is the Planner's map frame: x east, y north, kilometers" },
        lighting: detail.lighting,
        objects,
        roads: world.paths.filter((p) => p.pathType !== "river").map((p) => ({ id: p.id, name: p.name, type: p.pathType, widthM: { highway: 10, road: 6, trail: 2.5, bridge: 6, river: 12 }[p.pathType], pointsM: line(p.points) })),
        rivers: world.paths.filter((p) => p.pathType === "river").map((p) => ({ id: p.id, name: p.name, flowFromFirstPoint: true, pointsM: line(p.points) })),
        streets: (world.structures ?? []).filter((s) => s.shape === "street").map((s) => ({ id: s.id, name: s.name, widthM: s.widthM || 6, pointsM: line(s.points ?? []) })),
        areas: (world.structures ?? []).filter((s) => s.shape === "area").map((s) => ({ id: s.id, kind: s.kind, name: s.name, outlineM: line(s.points ?? []) })),
        regions: world.regions.map((r) => ({ id: r.id, name: r.name, type: r.regionType, biome: r.dominantBiome, dangerLevel: r.dangerLevel, factionId: r.controllingFactionId, plan: r.plan, outlineKm: r.points, description: r.description })),
        spots: world.spots.map((s) => ({ id: s.id, name: s.name, type: s.spotType, positionM: toWorldM(s.x, s.y, s.snapToGround === false ? s.elevation : ground.heightAt(s.x, s.y)), dangerLevel: s.dangerLevel, tags: s.tags, description: s.description })),
        scatter: {
            note: "Instances are listed around each site; elsewhere use the layer rules with terrain/mask-<mark>.png (instances per hectare at full density).",
            layers: Object.fromEntries(Object.keys(world.overlay?.layers ?? {}).filter((k) => !k.startsWith("codex:")).map((k) => [k, detail.scatter[k] ?? null])),
            groups: [...scatterByModel.values()].map((g) => ({ ...g, instanceFormat: ["x", "y", "z", "rotationYDeg", "scale"] })),
        },
        sites: opts.sites,
    };
    entries.push({ name: "scene.json", data: JSON.stringify(scene, null, 1) });
    const materials = {
        note: "Mesha material presets: color is sRGB 0..1; pattern is the procedural surface detail Mesha draws (wood grain, brick, rust...), worth reproducing with a texture or shader.",
        meshaMaterials: Object.fromEntries([...materialsUsed].map(([id, m]) => [id, { label: m.label, color: m.color, roughness: m.roughness, metallic: m.metallic, pattern: m.pattern, transmission: m.transmission, clear: m.clear }])),
        ground: { ...DEFAULT_GROUND, ...detail.ground },
    };
    entries.push({ name: "materials.json", data: JSON.stringify(materials, null, 1) });
    done++;
    yield { done, total, label: "Scene" };

    // Lore: the Planner's own world bible and design document, plus the raw data.
    entries.push({ name: "lore/world_bible.json", data: exportWorldBibleJson(world) });
    entries.push({ name: "lore/game_design_document.md", data: generateGameDesignDoc(world) });
    entries.push({ name: "lore/codex.json", data: JSON.stringify(world.codex, null, 1) });
    entries.push({ name: "lore/story.json", data: JSON.stringify({ acts: world.acts, missions: world.missions, questPaths: world.questPaths ?? [] }, null, 1) });
    entries.push({ name: "lore/regions.json", data: JSON.stringify(world.regions, null, 1) });
    entries.push({ name: "README.md", data: readme(world, objects.length, models.size, scatter.length, opts) });
    done++;
    yield { done, total, label: "Lore" };
    return entries;
}

function readme(world: GameWorld, objects: number, models: number, scatter: number, opts: ExportOptions): string {
    return `# ${world.meta.name}: level package

Exported by the Entropy Game World Detailer from a world planned in the Game World Planner.
Genre: ${world.meta.genre}. World: ${world.meta.worldWidthKm} x ${world.meta.worldHeightKm} km.
${world.meta.description ? `\n> ${world.meta.description}\n` : ""}
This package is meant to be handed to a developer or an AI coding agent to build the level in any
engine or language. Everything is plain files: glTF 2.0 binary models, PNG images, JSON and Markdown.

## Contents

| Path | What |
| ---- | ---- |
| \`scene.json\` | ${objects} placed objects (model file, position, rotation, scale, and what the plan says each one is), roads, rivers, streets, plazas, regions, spots, scatter, lighting |
| \`models/*.glb\` | ${models} distinct models, one primitive per material; \`models/index.json\` lists each one's Mesha object, parameters, bounds and triangle count |
| \`terrain/heightmap.png\` | the whole world's heightfield (16-bit; \`terrain/terrain.json\` gives the meters) |
| \`terrain/site-*-height.png\`, \`-color.png\` | the ground of each detailed site at ${opts.siteStepM ?? 2} m, with building pads, road beds and river beds |
| \`terrain/mask-*.png\` | painted planning marks (forest, farmland, snow...) as density masks |
| \`materials.json\` | every material used (PBR values and the procedural pattern Mesha draws) and the ground materials |
| \`lore/\` | the world bible, the Game Design Document, codex, story, quests and regions |

## Coordinate frame

Meters, right-handed, **+Y up, +X east, +Z south** (north is -Z), origin at the world's center at
elevation 0: the same frame as glTF. \`rotationYDeg\` turns counter-clockwise seen from above; at 0 a
model's front (its door, its face) points +Z. Positions sit on the ground: a building's origin is
the middle of its footprint at floor level. \`positionKm\` repeats the Planner's map frame (x east,
y north, km) for cross-reference.

## Building it

1. Terrain: build a heightfield from \`terrain/heightmap.png\` (bicubic between samples), then
   replace it with each site's 2 m heightmap where one exists (blend the edges).
2. Water: sea level is ${world.terrain?.seaLevelM ?? world.meta.seaLevelM ?? 0} m; rivers are polylines in \`scene.json\` (water ~0.8 m below the banks).
3. Load each GLB once and instance it for every object (and scatter instance) that uses it.
4. Roads, streets and plazas are draped on the ground (their beds are already level in the site heightmaps).
5. Scatter: instances are listed around the sites (${scatter} of them); elsewhere follow each layer's
   rule (instances per hectare at full density) over its mask.
6. NPCs and creatures are \`objects\` with \`plan.source = "placement"\`: their codex entry, behavior
   (static, patrol, guard...), level range and group size are in \`plan\`; their lore in \`lore/codex.json\`.
7. Quests, their givers and objectives are in \`lore/story.json\`, written up in the Game Design Document.
`;
}
