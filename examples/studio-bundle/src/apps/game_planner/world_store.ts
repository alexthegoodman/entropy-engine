// Saving Game Worlds: a library of worlds in the addon's own store, one file per world plus a small
// index, in a compact format sized for the data:
//
// - Vector data (spots, quest paths, regions, structures, codex, story...) is plain JSON with
//   coordinates rounded to 0.1 m (4 decimals of a km) and no pretty-printing.
// - The heightfield, by far the biggest part, is quantized to 10 cm steps (16 bits; taller reliefs
//   get coarser steps), predicted from its west, north and north-west neighbors (smooth ground
//   predicts well), and the residuals stored as zigzag varints in base64: 1-2 bytes per sample
//   instead of 6-10 characters of JSON.
// - Painted planning layers (densities 0..1) are stored as bytes with runs of empty cells collapsed.
//
// Everything here is pure (the store is passed in), so it is tested without the app.

import type { GameWorld, GenreType, PlanningOverlay, TerrainGrid } from "./planner_types";
import { erodeTerrain, generateTerrain, terrainStats } from "./terrain";

export const WORLD_FORMAT = "entropy-game-world";
export const WORLD_FORMAT_VERSION = 2;
export const WORLDS_DIR = "worlds";
const INDEX_PATH = `${WORLDS_DIR}/index.json`;

/** The subset of the addon store this module needs (`addon.IO.store`). */
export interface WorldStoreLike {
    read(path: string): string | null;
    write(path: string, text: string): void;
    list(path?: string): Array<{ name: string; isDir: boolean; size: number; modifiedMs: number }>;
    remove(path: string): boolean;
}

// -------------------------------------------------------------------------------------------------
// Base64 and varints (no platform dependencies: the addon runtime has no Buffer)
// -------------------------------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV = (() => {
    const t = new Int16Array(128).fill(-1);
    for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
    return t;
})();

export function bytesToBase64(bytes: Uint8Array): string {
    let out = "";
    const chunk: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
        const n = (a << 16) | (b << 8) | c;
        chunk.push(B64[(n >> 18) & 63], B64[(n >> 12) & 63], i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=", i + 2 < bytes.length ? B64[n & 63] : "=");
        if (chunk.length >= 4096) {
            out += chunk.join("");
            chunk.length = 0;
        }
    }
    return out + chunk.join("");
}

export function base64ToBytes(s: string): Uint8Array {
    const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const v = (k: number) => (i + k < clean.length ? B64_INV[clean.charCodeAt(i + k)] : 0);
        const n = (v(0) << 18) | (v(1) << 12) | (v(2) << 6) | v(3);
        if (o < out.length) out[o++] = (n >> 16) & 255;
        if (o < out.length) out[o++] = (n >> 8) & 255;
        if (o < out.length) out[o++] = n & 255;
    }
    return out;
}

class ByteWriter {
    private buf = new Uint8Array(1024);
    length = 0;
    private grow(n: number): void {
        if (this.length + n <= this.buf.length) return;
        const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
    }
    byte(b: number): void {
        this.grow(1);
        this.buf[this.length++] = b;
    }
    varint(v: number): void {
        // Unsigned LEB128 for 0 <= v < 2^35.
        while (v >= 0x80) {
            this.byte((v & 0x7f) | 0x80);
            v = Math.floor(v / 128);
        }
        this.byte(v);
    }
    bytes(): Uint8Array {
        return this.buf.slice(0, this.length);
    }
}

class ByteReader {
    pos = 0;
    constructor(private buf: Uint8Array) {}
    get done(): boolean {
        return this.pos >= this.buf.length;
    }
    byte(): number {
        if (this.pos >= this.buf.length) throw new Error("truncated data");
        return this.buf[this.pos++];
    }
    varint(): number {
        let v = 0;
        let mul = 1;
        for (let i = 0; i < 6; i++) {
            const b = this.byte();
            v += (b & 0x7f) * mul;
            if (b < 0x80) return v;
            mul *= 128;
        }
        throw new Error("bad varint");
    }
}

const zigzag = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzigzag = (v: number) => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);

// -------------------------------------------------------------------------------------------------
// Terrain: 16-bit quantization + planar prediction + zigzag varints
// -------------------------------------------------------------------------------------------------

export interface EncodedTerrain {
    cols: number;
    rows: number;
    seaLevelM: number;
    /** "q16p": 16-bit levels over [baseM, baseM + 65535 * stepM], predicted (median edge detector) varint residuals. */
    enc: "q16p";
    baseM: number;
    stepM: number;
    data: string;
}

export function encodeTerrain(t: TerrainGrid): EncodedTerrain {
    const { cols, rows, data } = t;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (!Number.isFinite(min)) min = max = 0;
    // 10 cm is far finer than a planning heightfield needs (its cells are ~100-200 m), and a coarser
    // step makes the residuals smaller. Very tall reliefs use the whole 16 bits.
    const stepM = Math.max((max - min) / 65535, 0.1);
    const q = new Int32Array(data.length);
    for (let i = 0; i < data.length; i++) q[i] = Math.max(0, Math.min(65535, Math.round((data[i] - min) / stepM)));
    const w = new ByteWriter();
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            w.varint(zigzag(q[i] - predict(q, cols, r, c)));
        }
    }
    return { cols, rows, seaLevelM: t.seaLevelM, enc: "q16p", baseM: min, stepM, data: bytesToBase64(w.bytes()) };
}

/**
 * The median edge detector (LOCO-I): west + north - north-west on smooth ground (exact for planes),
 * and the west or north neighbor across a ridge or cliff.
 */
function predict(q: ArrayLike<number>, cols: number, r: number, c: number): number {
    const i = r * cols + c;
    if (r === 0 && c === 0) return 0;
    if (r === 0) return q[i - 1];
    if (c === 0) return q[i - cols];
    const a = q[i - 1], b = q[i - cols], d = q[i - cols - 1];
    if (d >= Math.max(a, b)) return Math.min(a, b);
    if (d <= Math.min(a, b)) return Math.max(a, b);
    return a + b - d;
}

export function decodeTerrain(e: EncodedTerrain): TerrainGrid {
    if (e.enc !== "q16p") throw new Error(`unknown terrain encoding "${e.enc}"`);
    const n = e.cols * e.rows;
    const q = new Int32Array(n);
    const rd = new ByteReader(base64ToBytes(e.data));
    for (let r = 0; r < e.rows; r++) {
        for (let c = 0; c < e.cols; c++) {
            q[r * e.cols + c] = predict(q, e.cols, r, c) + unzigzag(rd.varint());
        }
    }
    const data = new Array<number>(n);
    // Two decimals: the quantization step is coarser than that anyway, and it keeps saves stable.
    for (let i = 0; i < n; i++) data[i] = Math.round((e.baseM + q[i] * e.stepM) * 100) / 100;
    const { min, max } = terrainStats(data);
    return { cols: e.cols, rows: e.rows, data, seaLevelM: e.seaLevelM, minM: min, maxM: max };
}

// -------------------------------------------------------------------------------------------------
// Planning overlay: bytes with empty runs collapsed
// -------------------------------------------------------------------------------------------------

export interface EncodedOverlay {
    cols: number;
    rows: number;
    /** "u8z": per layer, alternating varint(empty run), varint(n), n density bytes (0..255). */
    enc: "u8z";
    layers: Record<string, string>;
}

export function encodeOverlay(o: PlanningOverlay): EncodedOverlay {
    const layers: Record<string, string> = {};
    for (const [key, data] of Object.entries(o.layers)) {
        const b = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) b[i] = Math.max(0, Math.min(255, Math.round((data[i] || 0) * 255)));
        const w = new ByteWriter();
        let i = 0;
        while (i < b.length) {
            let z = 0;
            while (i + z < b.length && b[i + z] === 0) z++;
            i += z;
            let n = 0;
            // A literal run ends at the next run of 3+ empty cells.
            while (i + n < b.length && !(b[i + n] === 0 && b[i + n + 1] === 0 && b[i + n + 2] === 0)) n++;
            w.varint(z);
            w.varint(n);
            for (let k = 0; k < n; k++) w.byte(b[i + k]);
            i += n;
        }
        layers[key] = bytesToBase64(w.bytes());
    }
    return { cols: o.cols, rows: o.rows, enc: "u8z", layers };
}

export function decodeOverlay(e: EncodedOverlay): PlanningOverlay {
    if (e.enc !== "u8z") throw new Error(`unknown overlay encoding "${e.enc}"`);
    const n = e.cols * e.rows;
    const layers: Record<string, number[]> = {};
    for (const [key, s] of Object.entries(e.layers)) {
        const data = new Array<number>(n).fill(0);
        const rd = new ByteReader(base64ToBytes(s));
        let i = 0;
        while (!rd.done && i < n) {
            i += rd.varint();
            const lit = rd.varint();
            for (let k = 0; k < lit && i < n; k++) data[i++] = Math.round((rd.byte() / 255) * 1000) / 1000;
        }
        layers[key] = data;
    }
    return { cols: e.cols, rows: e.rows, layers };
}

// -------------------------------------------------------------------------------------------------
// Whole worlds
// -------------------------------------------------------------------------------------------------

export interface WorldFile {
    format: typeof WORLD_FORMAT;
    version: number;
    savedAt: number;
    world: Omit<GameWorld, "terrain" | "overlay"> & { terrain?: EncodedTerrain; overlay?: EncodedOverlay };
}

/** Rounds every non-integer to 4 decimals (0.1 m in km; plenty for colors and parameters). */
function compactReplacer(_key: string, v: unknown): unknown {
    return typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v;
}

export function serializeWorld(world: GameWorld, savedAt = Date.now()): string {
    const { terrain, overlay, ...rest } = world;
    const file: WorldFile = {
        format: WORLD_FORMAT,
        version: WORLD_FORMAT_VERSION,
        savedAt,
        world: {
            ...rest,
            ...(terrain && terrain.data?.length === terrain.cols * terrain.rows ? { terrain: encodeTerrain(terrain) } : {}),
            ...(overlay && Object.keys(overlay.layers).length ? { overlay: encodeOverlay(overlay) } : {}),
        },
    };
    // The encoded blobs are strings, so rounding only touches the vector data.
    return JSON.stringify(file, compactReplacer);
}

/** Reads a world file, or a bare world (the format older versions saved). */
export function deserializeWorld(text: string): GameWorld {
    const parsed = JSON.parse(text);
    const raw: any = parsed?.format === WORLD_FORMAT ? parsed.world : parsed;
    if (!raw?.meta || !Array.isArray(raw.spots)) throw new Error("not a Game World file");
    if (parsed?.format === WORLD_FORMAT && parsed.version > WORLD_FORMAT_VERSION) {
        throw new Error(`this world was saved by a newer version (format ${parsed.version})`);
    }
    const world = raw as GameWorld;
    if (raw.terrain?.enc) world.terrain = decodeTerrain(raw.terrain);
    if (raw.overlay?.enc) world.overlay = decodeOverlay(raw.overlay);
    world.paths ??= [];
    world.regions ??= [];
    world.contours ??= [];
    world.codex ??= [];
    world.acts ??= [];
    world.missions ??= [];
    world.proposals ??= [];
    return world;
}

// -------------------------------------------------------------------------------------------------
// The library
// -------------------------------------------------------------------------------------------------

export interface WorldSummary {
    id: string;
    name: string;
    genre: GenreType;
    widthKm: number;
    heightKm: number;
    savedAt: number;
    bytes: number;
    spots: number;
    quests: number;
    structures: number;
}

/** A file name for a world id: letters, digits, `_` and `-` only. */
export function worldFileName(id: string): string {
    const safe = id.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[_-]+/, "") || "world";
    return `${WORLDS_DIR}/${safe}.world.json`;
}

export function summarize(world: GameWorld, bytes: number, savedAt: number): WorldSummary {
    return {
        id: world.meta.id,
        name: world.meta.name,
        genre: world.meta.genre,
        widthKm: world.meta.worldWidthKm,
        heightKm: world.meta.worldHeightKm,
        savedAt,
        bytes,
        spots: world.spots.length,
        quests: world.missions.length,
        structures: world.structures?.length ?? 0,
    };
}

export class WorldLibrary {
    /** The listing, kept in memory between saves (the Worlds tab reads it every frame). */
    private cached: WorldSummary[] | null = null;

    constructor(private store: WorldStoreLike) {}

    /** Saved worlds, most recently saved first. Rebuilds the index from the files if it is missing or stale. */
    list(): WorldSummary[] {
        if (!this.cached) this.cached = this.readList();
        return [...this.cached];
    }

    /** Forgets the in-memory listing (after files changed behind the library's back). */
    refresh(): void {
        this.cached = null;
    }

    private readList(): WorldSummary[] {
        let index: WorldSummary[] | null = null;
        try {
            const text = this.store.read(INDEX_PATH);
            if (text) index = JSON.parse(text);
        } catch {
            index = null;
        }
        const files = this.store.list(WORLDS_DIR).filter((f) => !f.isDir && f.name.endsWith(".world.json"));
        const known = new Set((index ?? []).map((s) => worldFileName(s.id).slice(WORLDS_DIR.length + 1)));
        if (!index || files.length !== index.length || files.some((f) => !known.has(f.name))) index = this.rebuildIndex();
        return [...index].sort((a, b) => b.savedAt - a.savedAt);
    }

    private rebuildIndex(): WorldSummary[] {
        const out: WorldSummary[] = [];
        for (const f of this.store.list(WORLDS_DIR)) {
            if (f.isDir || !f.name.endsWith(".world.json")) continue;
            try {
                const text = this.store.read(`${WORLDS_DIR}/${f.name}`);
                if (!text) continue;
                const parsed = JSON.parse(text);
                const w = parsed?.format === WORLD_FORMAT ? parsed.world : parsed;
                if (!w?.meta) continue;
                out.push(summarize(w, text.length, parsed.savedAt ?? f.modifiedMs));
            } catch {
                // An unreadable file is left alone (and out of the list).
            }
        }
        this.writeIndex(out);
        return out;
    }

    private writeIndex(index: WorldSummary[]): void {
        this.store.write(INDEX_PATH, JSON.stringify(index));
        this.cached = [...index].sort((a, b) => b.savedAt - a.savedAt);
    }

    has(id: string): boolean {
        return this.store.read(worldFileName(id)) !== null;
    }

    save(world: GameWorld, savedAt = Date.now()): WorldSummary {
        const text = serializeWorld(world, savedAt);
        this.store.write(worldFileName(world.meta.id), text);
        const summary = summarize(world, text.length, savedAt);
        const index = this.list().filter((s) => s.id !== world.meta.id);
        index.unshift(summary);
        this.writeIndex(index);
        return summary;
    }

    load(id: string): GameWorld | null {
        const text = this.store.read(worldFileName(id));
        return text ? deserializeWorld(text) : null;
    }

    remove(id: string): boolean {
        const removed = this.store.remove(worldFileName(id));
        this.writeIndex(this.list().filter((s) => s.id !== id));
        return removed;
    }
}

// -------------------------------------------------------------------------------------------------
// New worlds
// -------------------------------------------------------------------------------------------------

export type Landform = "island" | "archipelago" | "continent" | "highlands" | "lowlands";

export const LANDFORMS: Array<{ id: Landform; label: string }> = [
    { id: "island", label: "Island" },
    { id: "archipelago", label: "Archipelago" },
    { id: "continent", label: "Continent" },
    { id: "highlands", label: "Highlands" },
    { id: "lowlands", label: "Lowlands" },
];

export interface NewWorldOptions {
    name: string;
    genre: GenreType;
    widthKm: number;
    heightKm: number;
    seed: number;
    landform: Landform;
    /** Heightfield vertices along each axis: 129 (default) or 257 for finer sculpting. */
    resolution?: number;
    description?: string;
}

export function newWorldId(now = Date.now(), rand = Math.random()): string {
    return `world_${now.toString(36)}_${Math.floor(rand * 36 ** 4).toString(36).padStart(4, "0")}`;
}

/** A fresh, empty world on generated terrain. */
export function createBlankWorld(opts: NewWorldOptions, id = newWorldId()): GameWorld {
    const widthKm = Math.max(1, Math.min(400, opts.widthKm));
    const heightKm = Math.max(1, Math.min(400, opts.heightKm));
    const shape: Record<Landform, { islandMask: boolean; landBias: number; mountainScale: number; ruggedness: number }> = {
        island: { islandMask: true, landBias: 0.05, mountainScale: 2400, ruggedness: 0.55 },
        archipelago: { islandMask: true, landBias: -0.18, mountainScale: 1600, ruggedness: 0.45 },
        continent: { islandMask: false, landBias: 0.18, mountainScale: 2800, ruggedness: 0.55 },
        highlands: { islandMask: false, landBias: 0.3, mountainScale: 3800, ruggedness: 0.85 },
        lowlands: { islandMask: false, landBias: 0.22, mountainScale: 700, ruggedness: 0.25 },
    };
    const s = shape[opts.landform] ?? shape.island;
    const resolution = opts.resolution && opts.resolution >= 257 ? 257 : 129;
    const base = generateTerrain({ widthKm, heightKm, resolution, seed: opts.seed, seaLevelM: 0, ...s });
    const terrain = erodeTerrain(base, { droplets: resolution > 129 ? 40000 : 16000, seed: opts.seed });
    return {
        meta: {
            id,
            name: opts.name.trim() || "Untitled World",
            genre: opts.genre,
            worldWidthKm: widthKm,
            worldHeightKm: heightKm,
            seed: opts.seed,
            description: opts.description ?? "",
            blockingMode: false,
            gridSnapM: 0,
            seaLevelM: 0,
        },
        spots: [],
        paths: [],
        regions: [],
        contours: [],
        terrain,
        codex: [],
        acts: [],
        missions: [],
        proposals: [],
        intents: [],
        placements: [],
        questPaths: [],
        structures: [],
    };
}

/** A copy of a world under a new id and name (Save As, or starting from a preset). */
export function copyWorld(world: GameWorld, name: string, id = newWorldId()): GameWorld {
    const copy: GameWorld = JSON.parse(JSON.stringify(world));
    copy.meta.id = id;
    copy.meta.name = name;
    return copy;
}
