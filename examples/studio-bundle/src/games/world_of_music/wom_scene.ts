// What is drawn each frame, from the game state. Everything is built from a few unit meshes
// (spheres, boxes, cylinders, cones, a torus) placed by matrices: Agent Tom, every Tone, the
// friends, the corrupted, the palms. Grey unless it means something (wom_data.ts PALETTE).

import { Renderer, placed, yawed, aligned, at, between, type Mat4 } from "./wom_render";
import { TOON, GLOW, MATERIAL, CARD } from "./wom_shader";
import { Game, type Tone, type Enemy } from "./wom_game";
import { SPECIES, PALETTE, ENEMIES, BOSSES, NPCS, type RGB, type SpeciesId } from "./wom_data";
import { Rng, type V3 } from "../nebula/nk_math";

const INK = 0.045;
const S2 = "sphere-2", S3 = "sphere-3", S1 = "sphere-1";

/** Grey of a given lightness (chroma 0). */
const grey = (v: number): number[] => [v, v, v, 0];
const hue = (c: RGB, chroma = 1): number[] => [c[0], c[1], c[2], chroma];

export interface Particle { pos: V3; vel: V3; life: number; max: number; size: number; color: RGB; kind: number; spin: number }

// --- scenery ---------------------------------------------------------------------------------
//
// Dense, cheap scenery. Grass, reeds, ferns, bushes, flowers and broad leaves are billboard
// cards (2 triangles, the silhouette cut in the shader); rocks come in four sizes, trees in three
// kinds, and there is driftwood on the beaches. Everything is placed once per island, sorted into
// 16 m chunks, and only chunks near the camera are drawn (grass nearest, trees and boulders far).

type CardItem = { x: number; y: number; z: number; w: number; h: number; shape: number; grey: number; seed: number };
type RockItem = { x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number; up: V3; grey: number; seed: number; mesh: string; size: number };
type TreeItem = { kind: "palm" | "broad" | "sapling"; x: number; y: number; z: number; s: number; yaw: number; seed: number; lean: number };
type LogItem = { a: V3; b: V3; r: number };
interface Chunk { cards: CardItem[]; small: RockItem[]; big: RockItem[]; trees: TreeItem[]; logs: LogItem[]; cx: number; cz: number }
const CHUNK = 16;
const sceneryCache = new Map<string, Map<number, Chunk>>();

function scenery(g: Game): Map<number, Chunk> {
    const hit = sceneryCache.get(g.level.id);
    if (hit) return hit;
    const T = g.terrain, rng = new Rng(g.level.seed * 77 + 5), chunks = new Map<number, Chunk>();
    const chunk = (x: number, z: number): Chunk => {
        const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK), k = (cx + 64) * 256 + (cz + 64);
        let c = chunks.get(k);
        if (!c) { c = { cards: [], small: [], big: [], trees: [], logs: [], cx: (cx + 0.5) * CHUNK, cz: (cz + 0.5) * CHUNK }; chunks.set(k, c); }
        return c;
    };
    const keep: { x: number; z: number; r: number }[] = [
        ...g.trees.map(t => ({ x: t.x, z: t.z, r: 3 })), ...g.crates.map(c => ({ x: c.x, z: c.z, r: 2.4 })), ...g.switches.map(s => ({ x: s.x, z: s.z, r: 3.5 })),
        ...g.gates.map(s => ({ x: s.x, z: s.z, r: s.len / 2 + 2 })), ...g.npcs.map(n => ({ x: n.x, z: n.z, r: 3.5 })), ...g.levers.map(l => ({ x: l.x, z: l.z, r: 2.5 })),
        { x: g.level.spawn[0], z: g.level.spawn[1], r: 5 }, { x: g.level.exit[0], z: g.level.exit[1], r: 4.5 },
        ...g.level.portals.flatMap(p => [{ x: p.a[0], z: p.a[1], r: 3.5 }, { x: p.b[0], z: p.b[1], r: 3.5 }]),
        ...g.darks.map(d => ({ x: d.def.x, z: d.def.z, r: 4 })),
    ];
    const busy = (x: number, z: number, pad = 0) => keep.some(o => Math.hypot(o.x - x, o.z - z) < o.r + pad);
    const lo = -T.half + 4, hi = T.half - 4;
    const rand = () => [rng.range(lo, hi), rng.range(lo, hi)] as const;
    // Where things like to grow: patches, not an even spray.
    const lush = (x: number, z: number) => 0.5 + 0.5 * Math.sin(x * 0.07 + Math.sin(z * 0.05) * 2) * Math.cos(z * 0.06 + x * 0.02);

    // Grass tufts in clumps.
    for (let c = 0; c < 1500; c++) {
        const [x0, z0] = rand();
        const h0 = T.height(x0, z0);
        if (h0 < 0.2 || T.grade(x0, z0) > 0.8 || T.path(x0, z0) > 0.5) continue;
        const n = 3 + Math.floor(lush(x0, z0) * 9);
        for (let k = 0; k < n; k++) {
            const x = x0 + rng.range(-3, 3), z = z0 + rng.range(-3, 3), y = T.height(x, z);
            if (y < 0.15 || T.grade(x, z) > 0.9 || T.path(x, z) > 0.4 || busy(x, z)) continue;
            const beach = y < 1.0;
            const s = rng.range(0.35, 0.75) * (beach ? 0.7 : 1);
            chunk(x, z).cards.push({ x, y: y - 0.05, z, w: s * 0.9, h: s, shape: CARD.grass, grey: beach ? 0.62 : rng.range(0.32, 0.5), seed: rng.next() });
        }
    }
    // Ferns, bushes, broad leaves and white flowers, in the damp and shady places.
    for (let i = 0; i < 1600; i++) {
        const [x, z] = rand(), y = T.height(x, z);
        if (y < 0.8 || T.grade(x, z) > 0.7 || T.path(x, z) > 0.3 || busy(x, z, 1)) continue;
        const r = rng.next() * (0.6 + lush(x, z) * 0.6);
        const c = chunk(x, z);
        if (r < 0.28) { const s = rng.range(0.7, 1.4); c.cards.push({ x, y: y - 0.05, z, w: s * 1.1, h: s * 0.8, shape: CARD.fern, grey: rng.range(0.28, 0.42), seed: rng.next() }); }
        else if (r < 0.55) { const s = rng.range(0.8, 2.0); c.cards.push({ x, y: y - 0.1, z, w: s, h: s * 0.85, shape: CARD.bush, grey: rng.range(0.3, 0.5), seed: rng.next() }); }
        else if (r < 0.68) { const s = rng.range(1.2, 2.2); c.cards.push({ x, y: y - 0.05, z, w: s * 0.9, h: s, shape: CARD.broad, grey: rng.range(0.36, 0.5), seed: rng.next() }); }
        else if (r < 0.9) { for (let k = 0; k < 3; k++) { const fx = x + rng.range(-1.5, 1.5), fz = z + rng.range(-1.5, 1.5); const s = rng.range(0.35, 0.6); c.cards.push({ x: fx, y: T.height(fx, fz) - 0.03, z: fz, w: s * 0.8, h: s, shape: CARD.flower, grey: 0.62, seed: rng.next() }); } }
    }
    // Reeds along every shore and pond edge.
    for (let i = 0; i < 2500; i++) {
        const [x, z] = rand(), y = T.height(x, z);
        if (y < -0.3 || y > 0.45 || busy(x, z)) continue;
        const s = rng.range(0.8, 1.5);
        chunk(x, z).cards.push({ x, y: y - 0.05, z, w: s * 0.5, h: s, shape: CARD.reed, grey: rng.range(0.36, 0.5), seed: rng.next() });
    }
    // Rocks in four sizes: pebble scatters, stones, rocks, boulders (most at the foot of cliffs).
    const rock = (x: number, z: number, size: number, list: "small" | "big") => {
        const y = T.height(x, z);
        if (y < -0.4 || busy(x, z, size)) return;
        const flat = rng.range(0.45, 0.85);
        chunk(x, z)[list].push({ x, y: y - size * 0.25, z, sx: size * rng.range(0.8, 1.3), sy: size * flat, sz: size * rng.range(0.8, 1.2), yaw: rng.range(0, 6.28), up: T.normal(x, z), grey: rng.range(0.42, 0.62), seed: rng.next(), mesh: size > 1.2 || rng.next() < 0.5 ? S1 : S2, size });
    };
    for (let i = 0; i < 260; i++) { const [x, z] = rand(); if (T.height(x, z) < 0.1) continue; for (let k = 0; k < 4; k++) rock(x + rng.range(-1.2, 1.2), z + rng.range(-1.2, 1.2), rng.range(0.08, 0.2), "small"); }
    for (let i = 0; i < 380; i++) { const [x, z] = rand(); rock(x, z, rng.range(0.25, 0.6), "small"); }
    for (let i = 0; i < 2600; i++) {
        const [x, z] = rand();
        const gr = T.grade(x, z);
        if (gr > 1.4 || gr < 0.35 && rng.next() > 0.12) continue;
        if (T.path(x, z) > 0.1) continue;
        rock(x, z, gr > 0.35 ? rng.range(0.8, 2.6) : rng.range(0.7, 1.4), "big");
    }
    for (let i = 0; i < 40; i++) { const [x, z] = rand(); if (T.grade(x, z) < 0.5 && T.path(x, z) < 0.05 && !busy(x, z, 6)) rock(x, z, rng.range(2.4, 3.8), "big"); }
    // Trees: tall palms by the sea, broad rain trees inland, little saplings anywhere.
    for (let i = 0; i < 700; i++) {
        const [x, z] = rand(), y = T.height(x, z);
        if (y < 0.5 || T.grade(x, z) > 0.5 || T.path(x, z) > 0.2 || busy(x, z, 3)) continue;
        const coastal = y < 2.4, r = rng.next();
        if (r > 0.35 + lush(x, z) * 0.25) continue;
        const kind: TreeItem["kind"] = r < 0.12 ? "sapling" : coastal || r < 0.22 ? "palm" : "broad";
        chunk(x, z).trees.push({ kind, x, y, z, s: rng.range(0.8, 1.3), yaw: rng.range(0, 6.28), seed: rng.next(), lean: rng.range(0.2, 0.6) });
    }
    // Driftwood on the sand.
    for (let i = 0; i < 260; i++) {
        const [x, z] = rand(), y = T.height(x, z);
        if (y < 0.1 || y > 0.9 || busy(x, z)) continue;
        const a = rng.range(0, 6.28), l = rng.range(1.2, 3);
        const p0: V3 = [x, y + 0.12, z], p1: V3 = [x + Math.cos(a) * l, T.height(x + Math.cos(a) * l, z + Math.sin(a) * l) + 0.12, z + Math.sin(a) * l];
        chunk(x, z).logs.push({ a: p0, b: p1, r: rng.range(0.1, 0.2) });
    }
    sceneryCache.set(g.level.id, chunks);
    return chunks;
}

/** Scenery counts for the HUD diagnostics and tests. */
export function sceneryStats(g: Game): { cards: number; rocks: number; trees: number; logs: number; chunks: number } {
    let cards = 0, rocks = 0, trees = 0, logs = 0;
    const ch = scenery(g);
    for (const c of ch.values()) { cards += c.cards.length; rocks += c.small.length + c.big.length; trees += c.trees.length; logs += c.logs.length; }
    return { cards, rocks, trees, logs, chunks: ch.size };
}

function drawScenery(r: Renderer, g: Game, cam: V3, time: number): void {
    // Tall things standing between the camera and Tom are left out, so he is never hidden.
    const tom = g.tom.pos, vx = tom[0] - cam[0], vz = tom[2] - cam[2], vl = Math.hypot(vx, vz) || 1;
    const blocks = (x: number, z: number, r0: number) => {
        const t = ((x - cam[0]) * vx + (z - cam[2]) * vz) / vl;
        if (t < -r0 || t > vl - 1) return false;
        return Math.abs((x - cam[0]) * vz - (z - cam[2]) * vx) / vl < r0 + 1.5;
    };
    for (const c of scenery(g).values()) {
        const d = Math.hypot(c.cx - cam[0], c.cz - cam[2]);
        if (d > 150) continue;
        if (d < 62) for (const k of c.cards) {
            if (k.shape === CARD.grass && d > 44) continue;
            if (k.h > 0.9 && blocks(k.x, k.z, k.w * 0.6)) continue;
            r.solid("quad", placed([k.x, k.y, k.z], k.w, k.h, 1), grey(k.grey), [TOON.card, k.seed, 0, 0], [0, k.shape, 0, 0]);
        }
        else if (d < 110) for (const k of c.cards) if (k.shape === CARD.bush || k.shape === CARD.broad) r.solid("quad", placed([k.x, k.y, k.z], k.w, k.h, 1), grey(k.grey), [TOON.card, k.seed, 0, 0], [0, k.shape, 0, 0]);
        const ink = d < 50 ? INK : 0;
        if (d < 55) for (const k of c.small) r.solid(k.mesh, aligned([k.x, k.y, k.z], k.up, k.yaw, k.sx, k.sy, k.sz), grey(k.grey), [TOON.prop, k.seed, 0, 0], [0, MATERIAL.stone, 0, k.size > 0.3 ? ink * 0.6 : 0]);
        for (const k of c.big) if (!(k.size > 1.2 && blocks(k.x, k.z, k.size))) r.solid(k.mesh, aligned([k.x, k.y, k.z], k.up, k.yaw, k.sx, k.sy, k.sz), grey(k.grey), [TOON.prop, k.seed, 0, 0], [0, MATERIAL.stone, 0, ink]);
        if (d < 70) for (const l of c.logs) r.solid("cyl", between(l.a, l.b, l.r), grey(0.7), [TOON.prop, 0, 0, 0], [0, MATERIAL.bark, 0, ink * 0.7]);
        for (const t of c.trees) if (!blocks(t.x, t.z, t.kind === "broad" ? 3 * t.s : 1.5)) drawTree(r, t, time, d < 70 ? INK : 0);
    }
}

function drawTree(r: Renderer, t: TreeItem, time: number, ink: number): void {
    const base: V3 = [t.x, t.y - 0.2, t.z];
    if (t.kind === "palm") {
        let p = base;
        const segs = 7, sway = Math.sin(time * 0.6 + t.seed * 9) * 0.05;
        for (let k = 0; k < segs; k++) {
            const q = at(p, t.yaw, [0, 1.25 * t.s, t.lean * 0.16 * (k + 1) * 0.5 + sway * k]);
            r.solid("cyl", between(p, q, (0.24 - k * 0.018) * t.s), grey(0.5), [TOON.prop, t.seed, 0, 0], [0, MATERIAL.ringed, 0, ink]);
            p = q;
        }
        for (let k = 0; k < 8; k++) {
            const a = t.yaw + k * 0.785 + t.seed;
            const tip = at(p, a, [0, -0.9 * t.s, 2.8 * t.s]);
            const mid: V3 = [(p[0] + tip[0]) / 2, (p[1] + tip[1]) / 2 + 0.45 * t.s, (p[2] + tip[2]) / 2];
            r.solid(S2, aligned(mid, [Math.sin(a) * 0.4, 0.92, Math.cos(a) * 0.4], a, 0.42 * t.s, 0.06, 1.7 * t.s), grey(0.3), [TOON.foliage, t.seed + k, 0, 0], [0, MATERIAL.leaf, 0, ink * 0.8]);
        }
        r.solid(S1, placed(p, 0.35 * t.s), grey(0.25), [TOON.prop, 0, 0, 0]);
    } else if (t.kind === "broad") {
        const h = 4.2 * t.s, top: V3 = [t.x, t.y + h, t.z];
        r.solid("cyl", between(base, top, 0.32 * t.s, 0.32 * t.s), grey(0.38), [TOON.prop, t.seed, 0, 0], [0, MATERIAL.bark, 0, ink]);
        for (let k = 0; k < 3; k++) {
            const a = t.yaw + k * 2.1;
            r.solid("cyl", between(at(base, a, [0, h * 0.55, 0]), at(base, a, [0, h * 0.95, 1.6 * t.s]), 0.12 * t.s), grey(0.38), [TOON.prop, t.seed, 0, 0], [0, MATERIAL.bark, 0, ink]);
        }
        // A lumpy crown: a big core and a ring of smaller clumps at different heights.
        for (let k = 0; k < 10; k++) {
            const a = t.yaw + k * 2.39 + t.seed * 3, rr = k === 0 ? 0 : (1.1 + (k % 3) * 0.45) * t.s;
            const c = at(top, a, [0, (k === 0 ? 1.0 : -0.2 + ((k * 7) % 5) * 0.32) * t.s, rr]);
            const s = (k === 0 ? 1.9 : 0.85 + ((k * 3) % 4) * 0.17) * t.s;
            r.solid(S2, yawed(c, a, s, s * 0.8, s * 0.95), grey(0.28 + (k % 3) * 0.05), [TOON.foliage, t.seed + k, 0, 0], [0, 0, 0, ink]);
        }
    } else {
        const top: V3 = [t.x, t.y + 1.4 * t.s, t.z];
        r.solid("cyl", between(base, top, 0.07 * t.s), grey(0.4), [TOON.prop, 0, 0, 0], [0, MATERIAL.bark, 0, ink * 0.6]);
        r.solid(S2, placed(top, 0.75 * t.s, 0.6 * t.s, 0.75 * t.s), grey(0.38), [TOON.foliage, t.seed, 0, 0], [0, 0, 0, ink * 0.7]);
    }
}

let gRef: Game | null = null;

export interface SceneStats { solids: number; glows: number }

export function drawScene(r: Renderer, g: Game, time: number, particles: Particle[], cam: V3, terrainKey: string, waterKey: string, selectedColor: RGB): void {
    const T = g.terrain;

    r.solid("sky", placed([0, 0, 0], 1), grey(0.8), [TOON.sky, 0, 0, 0]);
    r.solid(terrainKey, placed([0, 0, 0], 1), grey(0.65), [TOON.terrain, 0, 0, 0]);
    r.solid(waterKey, placed([0, 0, 0], 1), grey(0.5), [TOON.water, 0, 0, 0]);

    drawScenery(r, g, cam, time);

    // Palms with magenta fruit.
    g.trees.forEach((t, i) => {
        const shake = Math.sin(time * 40) * t.shake * 0.25;
        const base: V3 = [t.x, t.y, t.z];
        let p = base, lean = 0.35 + (i % 3) * 0.12, yaw = i * 1.9;
        for (let k = 0; k < 6; k++) {
            const q = at(p, yaw, [0, 1.15, lean * 0.18 * (k + 1) * 0.4 + shake]);
            r.solid("cyl", between(p, q, 0.22 - k * 0.018), grey(0.5), [TOON.prop, i, 0, 0], [0, MATERIAL.ringed, 0, INK]);
            p = q;
        }
        for (let k = 0; k < 7; k++) {
            const a = yaw + k * 0.9;
            const tip = at(p, a, [0, -0.6, 2.4]);
            const mid: V3 = [(p[0] + tip[0]) / 2, (p[1] + tip[1]) / 2 + 0.35, (p[2] + tip[2]) / 2];
            r.solid(S2, aligned(mid, [Math.sin(a) * 0.35, 0.94, Math.cos(a) * 0.35], a, 0.35, 0.07, 1.5), grey(0.3), [TOON.foliage, i + k, 0, 0], [0, MATERIAL.leaf, 0, INK * 0.8]);
        }
        for (let k = 0; k < t.fruit; k++) {
            const a = yaw + k * 1.7;
            r.solid(S2, placed(at(p, a, [0, -0.35 - (k % 2) * 0.2, 0.42]), 0.24), hue(PALETTE.fruit), [TOON.prop, k, 0.35, 0], [0, 0, 0, INK]);
        }
    });

    // Crates.
    for (const c of g.crates) {
        if (c.broken) continue;
        const s = c.big ? 1.1 : 0.7, sh = Math.sin(time * 50) * c.shake * 0.08;
        const p: V3 = [c.x + sh, c.y + s, c.z];
        r.solid("box", yawed(p, c.x * 0.3, s, s, s), grey(0.74), [TOON.prop, 1, 0, 0], [0, MATERIAL.wood, 0, INK]);
        for (const y of [-0.55, 0.55]) r.solid("box", yawed([p[0], p[1] + y * s, p[2]], c.x * 0.3, s * 1.02, s * 0.08, s * 1.02), grey(0.42), [TOON.prop, 2, 0, 0]);
        if (c.hp < c.max) r.glow(placed([p[0], p[1] + s + 0.5, p[2]], 0.6 * (c.hp / c.max) + 0.2), [1, 1, 1, 0.3], GLOW.ring, 0.12);
    }

    // Pickups.
    for (const pk of g.pickups) {
        const bob = Math.sin(time * 3 + pk.pos[0]) * 0.08;
        if (pk.kind === "fruit") r.solid(S2, placed([pk.pos[0], pk.pos[1] + bob, pk.pos[2]], 0.26), hue(PALETTE.fruit), [TOON.prop, 0, 0.4, 0], [0, 0, 0, INK]);
        else {
            r.solid(S1, yawed([pk.pos[0], pk.pos[1] + 0.2 + bob, pk.pos[2]], time * 2 + pk.pos[2], 0.2, 0.34, 0.2), hue(PALETTE.relic), [TOON.prop, 0, 0.5, 0], [0, 0, 0, INK]);
            r.glow(placed([pk.pos[0], pk.pos[1] + 0.25 + bob, pk.pos[2]], 0.7), [...PALETTE.relic, 0.35], GLOW.dot);
        }
    }

    // Mechanisms: switches, gates, levers, portals, the song gate.
    for (const s of g.switches) {
        const full = s.weight >= s.need;
        r.solid("cyl", placed([s.x, s.y - 0.05, s.z], 1.9, 0.2 - (full ? 0.08 : 0), 1.9), hue(PALETTE.mech, 0.85), [TOON.mech, 0, full ? 0.6 : 0.15, 0], [0, 0, 0, INK]);
        r.glow(placed([s.x, s.y + 0.18, s.z], 2.3), [...PALETTE.mech, full ? 0.9 : 0.35], GLOW.flatRing, 0.08, [full ? 0.3 : 0.05, 0, 0, 0]);
        for (let k = 0; k < s.need; k++) {
            const a = (k / s.need) * Math.PI * 2 + time * 0.3;
            r.glow(placed([s.x + Math.cos(a) * 2.6, s.y + 0.3, s.z + Math.sin(a) * 2.6], 0.35), k < s.weight ? [...PALETTE.mech, 1] : [1, 1, 1, 0.25], GLOW.dot);
        }
    }
    for (const gt of g.gates) {
        const dx = Math.cos(gt.angle), dz = Math.sin(gt.angle), n = Math.max(3, Math.round(gt.len / 1.6));
        const sink = gt.lift * 3.2;
        for (let k = 0; k <= n; k++) {
            const f = k / n - 0.5;
            const x = gt.x + dx * gt.len * f, z = gt.z + dz * gt.len * f, y = T.height(x, z);
            r.solid("cyl", placed([x, y - sink, z], 0.22, 3.2, 0.22), grey(0.4), [TOON.prop, k, 0, 0], [0, MATERIAL.stone, 0, INK]);
            r.solid(S1, placed([x, y + 3.25 - sink, z], 0.3), hue(PALETTE.mech), [TOON.mech, k, 0.6, 0], [0, 0, 0, INK]);
        }
        if (gt.lift < 0.9) for (let h = 0.6; h < 3; h += 0.8) {
            const a: V3 = [gt.x - dx * gt.len / 2, gt.y + h - sink, gt.z - dz * gt.len / 2];
            const len = gt.len;
            const m = placed([a[0], a[1], a[2]], 0.09 + Math.sin(time * 6 + h) * 0.02);
            m[8] = dx * len; m[9] = 0; m[10] = dz * len;
            r.glow(m, [...PALETTE.mech, 0.9 * (1 - gt.lift)], GLOW.beam);
        }
    }
    for (const l of g.levers) {
        r.solid("box", placed([l.x, l.y + 0.4, l.z], 0.5, 0.4, 0.5), grey(0.45), [TOON.prop, 0, 0, 0], [0, MATERIAL.stone, 0, INK]);
        const tilt = l.flipped ? 0.8 : -0.8;
        const top: V3 = [l.x + Math.sin(tilt) * 1.2, l.y + 0.8 + Math.cos(tilt) * 1.2, l.z];
        r.solid("cyl", between([l.x, l.y + 0.8, l.z], top, 0.09), grey(0.6), [TOON.prop, 0, 0, 0], [0, 0, 0, INK]);
        r.solid(S2, placed(top, 0.26), hue(PALETTE.mech), [TOON.mech, 0, l.flipped ? 0.9 : 0.3, 0], [0, 0, 0, INK]);
        if (!l.flipped) r.glow(placed([top[0], top[1], top[2]], 1.1 + Math.sin(time * 3) * 0.2), [...PALETTE.mech, 0.5], GLOW.dot);
    }
    for (const p of g.level.portals) for (const [x, z] of [p.a, p.b]) {
        const y = T.surface(x, z) + 1.8;
        const face = Math.atan2(p.b[0] - p.a[0], p.b[1] - p.a[1]);
        const c = Math.cos(face), s = Math.sin(face);
        // The torus (made flat in xz) stands upright, facing along the path between the pair.
        const up: Mat4 = [1.7 * c, 0, -1.7 * s, 0, 1.7 * s, 0, 1.7 * c, 0, 0, 1.7, 0, 0, x, y, z, 1];
        r.solid("torus", up, hue(PALETTE.mech), [TOON.mech, 0, 0.5, 0], [0, 0, 0, INK]);
        r.glow(placed([x, y, z], 1.5), [...PALETTE.mech, 0.35 + 0.15 * Math.sin(time * 2)], GLOW.ring, 0.35);
        r.glow(placed([x, y, z], 1.2), [...PALETTE.mech, 0.25], GLOW.dot);
    }
    {
        const [ex, ez] = g.level.exit, ey = T.surface(ex, ez) + 2.6;
        const s = 2.6, faceY = Math.atan2(g.level.spawn[0] - ex, g.level.spawn[1] - ez);
        const c = Math.cos(faceY), sn = Math.sin(faceY);
        const up: Mat4 = [s * c, 0, -s * sn, 0, s * sn, 0, s * c, 0, 0, s, 0, 0, ex, ey, ez, 1];
        r.solid("torus", up, g.exitOpen ? [1, 1, 1, 0] : grey(0.35), [TOON.prop, 0, g.exitOpen ? 1.2 : 0, 0], [0, 0, 0, INK]);
        r.solid("cyl", placed([ex, ey - 2.7, ez], 2.2, 0.25, 2.2), grey(0.5), [TOON.prop, 0, 0, 0], [0, MATERIAL.stone, 0, INK]);
        if (g.exitOpen) {
            r.glow(placed([ex, ey, ez], 2.5), [1, 1, 1, 0.8], GLOW.ring, 0.25);
            r.glow(placed([ex, ey, ez], 2.2), [1, 1, 1, 0.45 + 0.2 * Math.sin(time * 3)], GLOW.dot);
        }
    }

    // The Red Corruption: hearts, anchors, bosses.
    for (const d of g.darks) {
        if (d.purified && d.radius < 0.1) continue;
        const y = T.surface(d.def.x, d.def.z);
        if (!d.purified && !d.boss) {
            const beat = 1 + 0.06 * Math.sin(time * 4);
            const hp = d.heart / d.heartMax;
            for (let k = 0; k < 7; k++) {
                const a = k * 0.9 + d.idx, lean = k === 0 ? 0 : 0.35;
                const base = at([d.def.x, y, d.def.z], a, [0, 0, k === 0 ? 0 : 0.7]);
                const tip = at(base, a, [0, (k === 0 ? 3.4 : 1.8 + (k % 3) * 0.5) * (0.4 + 0.6 * hp) * beat, lean * 1.6]);
                r.solid("cone", between(base, tip, k === 0 ? 0.7 : 0.35), hue(PALETTE.red), [TOON.corrupt, k, 0.25 + (d.singing > 0 ? 0.4 : 0), 0], [0, 0, 0, INK]);
            }
            r.glow(placed([d.def.x, y + 2, d.def.z], 3.2 * beat), [...PALETTE.red, 0.6], GLOW.heart);
            if (d.singing > 0) r.glow(placed([d.def.x, y + 2, d.def.z], 4.5), [1, 1, 1, 0.5], GLOW.ring, 0.1);
        }
        if (d.boss) {
            for (const a of d.boss.anchors) {
                const ay = T.surface(a.x, a.z);
                if (a.hp <= 0) { r.solid("cone", between([a.x, ay, a.z], [a.x, ay + 0.8, a.z], 0.6), grey(0.25), [TOON.prop, 0, 0, 0], [0, 0, 0, INK]); continue; }
                const k = a.hp / a.max;
                r.solid("cone", between([a.x, ay, a.z], [a.x, ay + 2 + 3 * k, a.z], 0.8), hue(PALETTE.red), [TOON.corrupt, a.x, 0.4, 0], [0, 0, 0, INK]);
                r.glow(placed([a.x, ay + 2.2, a.z], 2.4), [...PALETTE.red, 0.6], GLOW.heart);
                // A thread of red from each anchor into the boss.
                if (d.boss.alive) {
                    const from: V3 = [a.x, ay + 3, a.z], to: V3 = [d.boss.pos[0], d.boss.pos[1] + d.boss.size * 0.8, d.boss.pos[2]];
                    const m = placed(from, 0.18); m[8] = to[0] - from[0]; m[9] = to[1] - from[1]; m[10] = to[2] - from[2];
                    r.glow(m, [...PALETTE.red, 0.5 + 0.3 * Math.sin(time * 5 + a.x)], GLOW.beam);
                }
            }
            if (d.boss.alive) drawBoss(r, g, d.idx, time);
        }
    }
    gRef = g;
    for (const e of g.enemies) drawEnemy(r, e, time, cam);

    // Friends of the World of Music.
    for (const n of g.npcs) drawNpc(r, n.id, [n.x, n.y, n.z], n.face, time, n.talking > 0);

    // Tones, then Tom.
    for (const t of g.tones) drawTone(r, g, t, time, cam);
    drawTom(r, g, time);

    // Bolts.
    for (const b of g.bolts) {
        r.glow(placed(b.pos, b.size * 2.2), [...b.color, 1], GLOW.dot);
        r.glow(placed(b.pos, b.size * 1.1), [1, 1, 1, 0.8], GLOW.dot);
        const m = placed(b.pos, b.size * 0.8); m[8] = -b.vel[0] * 0.06; m[9] = -b.vel[1] * 0.06; m[10] = -b.vel[2] * 0.06;
        r.glow(m, [...b.color, 0.6], GLOW.beam);
    }
    // Boss slam waves.
    for (const d of g.darks) if (d.boss?.alive && d.boss.slam >= 0) {
        const b = d.boss;
        r.glow(placed([b.pos[0], T.surface(b.pos[0], b.pos[2]) + 0.25, b.pos[2]], b.slam + 0.5), [...PALETTE.red, 1], GLOW.flatRing, 0.06);
    }

    // Particles (notes, sparks).
    for (const p of particles) {
        const k = Math.max(0, p.life / p.max);
        r.glow(placed(p.pos, p.size * (p.kind === GLOW.shock ? 1 + (1 - k) * 4 : 1)), [...p.color, Math.min(1, k * 1.6)], p.kind, 0.1);
    }

    // The pointer: where the selected swarm would go, in its color; what it would do there.
    if (g.cursor) {
        const c = g.cursor, h = g.hover;
        const y = T.surface(c[0], c[2]) + 0.12;
        r.glow(placed([c[0], y, c[2]], 0.9 + Math.sin(time * 6) * 0.08), [...selectedColor, 0.9], GLOW.flatRing, 0.12);
        if (h && h.kind !== "move") r.glow(placed([h.x, T.surface(h.x, h.z) + 0.15, h.z], 2.6), [...selectedColor, 0.8], GLOW.flatRing, 0.06);
        const sw = g.selectedSwarm;
        if (sw) {
            const [sx, sz] = g.swarmCenter(sw);
            const n = Math.min(14, Math.ceil(Math.hypot(c[0] - sx, c[2] - sz) / 2));
            for (let k = 1; k < n; k++) {
                const f = k / n, x = sx + (c[0] - sx) * f, z = sz + (c[2] - sz) * f;
                r.glow(placed([x, T.surface(x, z) + 0.3 + Math.sin(f * Math.PI) * 1.2, z], 0.16), [...selectedColor, 0.55], GLOW.dot);
            }
        }
    }
    // Each swarm's order point, and a ring under the selected swarm.
    g.swarms.forEach((s, i) => {
        const col = SPECIES[s.species].color;
        if (s.order.kind !== "follow") r.glow(placed([s.order.x, T.surface(s.order.x, s.order.z) + 0.12, s.order.z], 0.6), [...col, 0.5], GLOW.flatRing, 0.2);
        if (i === g.selected) {
            const [x, z] = g.swarmCenter(s);
            r.glow(placed([x, T.surface(x, z) + 0.1, z], 1.6 + Math.sqrt(g.liveTones(s).length) * 0.5), [...col, 0.7], GLOW.flatRing, 0.05);
        }
    });
}

/** An ink-blot contact shadow on the ground under something. */
function blot(r: Renderer, g: Game, x: number, z: number, radius: number): void {
    const n = g.terrain.normal(x, z), y = g.terrain.surface(x, z) + 0.05;
    r.solid("cyl", aligned([x, y, z], n, 0, radius, 0.012, radius), grey(0.1), [TOON.prop, 0, 0, 0]);
}

function drawTone(r: Renderer, g: Game, t: Tone, time: number, cam: V3): void {
    const sp = SPECIES[t.species], col = sp.color, T = g.terrain;
    const sw = g.swarms[t.swarm];
    const size = (sp.shape === "squat" ? 0.4 : sp.shape === "tall" ? 0.32 : 0.34) * (1 + Math.min(4, t.growth) * 0.06) * (1 - t.born * 0.6);
    const ink = Math.hypot(t.pos[0] - cam[0], t.pos[2] - cam[2]) < 60 ? INK : 0;
    if (t.state === "faded") {
        const p: V3 = [t.pos[0], t.pos[1] + size * 0.4, t.pos[2]];
        r.solid(S2, placed(p, size, size * 0.6, size), grey(0.55), [TOON.ghost, t.id, 0.3, 0]);
        // A ghost note rises while it can still be saved; the ring fills as it is revived.
        const left = 1 - t.fadedFor / 20;
        r.glow(placed([p[0], p[1] + 1.2 + Math.sin(time * 2 + t.id) * 0.15, p[2]], 0.45), [...col, 0.5 * left + 0.2], GLOW.note);
        r.glow(placed([p[0], T.surface(p[0], p[2]) + 0.1, p[2]], 1.2), [...col, 0.6], GLOW.flatRing, 0.06, [t.revive, 0, 0, 0]);
        return;
    }
    blot(r, g, t.pos[0], t.pos[2], size * 0.9);
    const moving = Math.hypot(t.vel[0], t.vel[2]);
    const hop = Math.abs(Math.sin(t.hop)) * Math.min(1, moving / 2) * (sp.shape === "wisp" ? 0 : 0.35);
    const squash = (Math.cos(t.hop * 2) * 0.12) * Math.min(1, moving / 2) + (t.hurt > 0 ? 0.25 : 0);
    const base: V3 = [t.pos[0], t.pos[1] + hop, t.pos[2]];
    const body: V3 = [base[0], base[1] + size * (sp.shape === "tall" ? 1.25 : 0.95), base[2]];
    const tall = sp.shape === "tall" ? 1.35 : sp.shape === "squat" ? 0.85 : 1;
    const em = 0.18 + (t.hurt > 0 ? 0.8 : 0);
    r.solid(S3, yawed(body, t.yaw, size, size * tall, size), hue(col), [TOON.creature, t.id, em, 0], [squash, 0, 0, ink]);
    // Eyes.
    for (const sx of [-1, 1]) {
        const e = at(body, t.yaw, [sx * size * 0.38, size * tall * 0.25, size * 0.82]);
        r.solid(S2, placed(e, size * 0.22), grey(1), [TOON.prop, 0, 0.5, 0], [0, 0, 0, ink * 0.6]);
        r.solid(S1, placed(at(body, t.yaw, [sx * size * 0.4, size * tall * 0.25, size * 0.98]), size * 0.11), grey(0.02), [TOON.prop, 0, 0, 0]);
    }
    // What each species carries: horns, an antenna with a spark, long legs, wings.
    const traits = sw?.traits ?? {};
    if (sp.shape === "squat") for (const sx of [-1, 1]) r.solid("cone", between(at(body, t.yaw, [sx * size * 0.5, size * 0.6, 0]), at(body, t.yaw, [sx * size * 0.75, size * 1.15, -size * 0.1]), size * 0.16), hue(col), [TOON.creature, 0, em, 0], [0, 0, 0, ink]);
    if (sp.shape === "round" || traits.blaster) {
        const tip = at(body, t.yaw, [0, size * tall * 1.6, -size * 0.2]);
        r.solid("cyl", between(at(body, t.yaw, [0, size * tall * 0.9, 0]), tip, size * 0.05), grey(0.15), [TOON.prop, 0, 0, 0]);
        r.glow(placed(tip, size * 0.5 + (t.attackCd > 0.7 ? 0.3 : 0)), [...col, 0.9], GLOW.star);
    }
    if (sp.shape === "tall" || traits.claws) for (const sx of [-1, 1]) {
        const swing = Math.sin(t.hop + (sx > 0 ? 0 : Math.PI)) * 0.35 * Math.min(1, moving / 2);
        r.solid("cyl", between(at(body, t.yaw, [sx * size * 0.35, -size * 0.6, 0]), at(base, t.yaw, [sx * size * 0.4, 0.05, swing]), size * 0.09), hue(col), [TOON.creature, 0, em, 0], [0, 0, 0, ink]);
    }
    if (sp.shape === "wisp" || traits.wings) for (const sx of [-1, 1]) {
        const flap = Math.sin(time * 12 + t.id) * 0.6;
        const root = at(body, t.yaw, [sx * size * 0.6, size * 0.3, -size * 0.2]);
        const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
        const out: V3 = [c * sx, Math.sin(flap), -s * sx];
        r.solid(S2, aligned([root[0] + out[0] * size * 0.6, root[1] + out[1] * size * 0.4, root[2] + out[2] * size * 0.6], [-Math.sin(flap) * sx * c, 1, Math.sin(flap) * sx * s].map(v => v) as V3, t.yaw, size * 0.7, size * 0.08, size * 0.4), hue(col, 0.75), [TOON.creature, 0, em + 0.2, 0], [0, 0, 0, ink * 0.6]);
    }
    if (t.carrying) r.solid(S1, yawed([body[0], body[1] + size * tall + 0.3, body[2]], time * 3, 0.18, 0.3, 0.18), hue(PALETTE.relic), [TOON.prop, 0, 0.5, 0], [0, 0, 0, ink]);
    if (t.hp < (sw?.stats.hp ?? 1) * 0.999) {
        const k = t.hp / (sw?.stats.hp ?? 1);
        r.glow(placed([body[0], body[1] + size * tall + 0.45, body[2]], 0.28), [k > 0.4 ? 1 : 1, k > 0.4 ? 1 : 0.2, k > 0.4 ? 1 : 0.2, 0.4], GLOW.ring, 0.25 * k + 0.05);
    }
}

function drawTom(r: Renderer, g: Game, time: number): void {
    const t = g.tom;
    if (t.down > 0) {
        const k = 1 - t.down / 3;
        r.glow(placed([t.pos[0], t.pos[1] + 1, t.pos[2]], 1.5 + k * 3), [...PALETTE.link, 0.8 * (1 - k)], GLOW.shock);
        return;
    }
    const speed = Math.hypot(t.vel[0], t.vel[2]), stride = Math.sin(t.walk * 1.6) * Math.min(1, speed / 4);
    const p = t.pos, y = t.yaw;
    blot(r, g, p[0], p[2], 0.55);
    const suit = grey(0.22), skin = grey(0.85), trim = grey(0.95);
    const bob = Math.abs(Math.cos(t.walk * 1.6)) * 0.05 * Math.min(1, speed / 4);
    const hip = at(p, y, [0, 0.95 + bob, 0]);
    // Legs, boots.
    for (const sx of [-1, 1]) {
        const knee = at(p, y, [sx * 0.16, 0.5 + bob, stride * sx * 0.22]);
        const foot = at(p, y, [sx * 0.17, 0.08, stride * sx * 0.42]);
        r.solid("cyl", between(at(hip, y, [sx * 0.15, 0, 0]), knee, 0.11), suit, [TOON.creature, 0, 0, 0], [0, 0, 0, INK]);
        r.solid("cyl", between(knee, foot, 0.1), suit, [TOON.creature, 0, 0, 0], [0, 0, 0, INK]);
        r.solid("box", yawed(at(foot, y, [0, 0, 0.08]), y, 0.12, 0.08, 0.2), grey(0.1), [TOON.prop, 0, 0, 0], [0, 0, 0, INK]);
    }
    // Torso, belt, backpack with the Link antenna.
    const chest = at(p, y, [0, 1.35 + bob, 0]);
    r.solid(S3, yawed(chest, y, 0.34, 0.45, 0.24), suit, [TOON.creature, 1, 0, 0], [0, 0, 0, INK]);
    r.solid("cyl", yawed(at(p, y, [0, 1.0 + bob, 0]), y, 0.3, 0.09, 0.22), trim, [TOON.prop, 0, 0, 0]);
    const pack = at(chest, y, [0, 0.05, -0.32]);
    r.solid("box", yawed(pack, y, 0.24, 0.3, 0.12), grey(0.55), [TOON.prop, 0, 0, 0], [0, 0, 0, INK]);
    const tip = at(pack, y, [0.14, 0.95, -0.05]);
    r.solid("cyl", between(at(pack, y, [0.14, 0.25, 0]), tip, 0.025), grey(0.3), [TOON.prop, 0, 0, 0]);
    r.glow(placed(tip, 0.22 + 0.06 * Math.sin(time * 5)), [...PALETTE.link, 0.95], GLOW.star);
    // Arms (swinging; the right one raised a little when directing).
    for (const sx of [-1, 1]) {
        const sh = at(chest, y, [sx * 0.4, 0.28, 0]);
        const hand = at(p, y, [sx * 0.48, 0.95 + bob, -stride * sx * 0.3]);
        const elbow: V3 = [(sh[0] + hand[0]) / 2, (sh[1] + hand[1]) / 2 + 0.02, (sh[2] + hand[2]) / 2];
        r.solid("cyl", between(sh, elbow, 0.08), suit, [TOON.creature, 0, 0, 0], [0, 0, 0, INK]);
        r.solid("cyl", between(elbow, hand, 0.075), suit, [TOON.creature, 0, 0, 0], [0, 0, 0, INK]);
        r.solid(S2, placed(hand, 0.1), trim, [TOON.prop, 0, 0, 0], [0, 0, 0, INK]);
    }
    // Head and the visor: the one piece of the World of Color he wears.
    const head = at(p, y, [0, 1.98 + bob, 0.02]);
    r.solid(S3, placed(head, 0.25, 0.27, 0.25), skin, [TOON.creature, 2, 0, 0], [0, 0, 0, INK]);
    r.solid(S2, yawed(at(head, y, [0, 0.13, -0.03]), y, 0.27, 0.12, 0.27), grey(0.12), [TOON.prop, 0, 0, 0], [0, 0, 0, INK]);
    r.solid(S2, yawed(at(head, y, [0, 0.02, 0.17]), y, 0.21, 0.08, 0.11), hue(PALETTE.link), [TOON.creature, 3, 0.7, 0], [0, 0, 0, INK]);
    if (t.hurt > 0) r.glow(placed(chest, 1.4), [...PALETTE.red, t.hurt * 1.5], GLOW.ring, 0.2);
}

function drawEnemy(r: Renderer, e: Enemy, time: number, cam: V3): void {
    const def = ENEMIES[e.kind];
    const fade = e.alive ? 1 : Math.max(0, 1 - e.deadFor / 0.8);
    if (fade <= 0) return;
    const s = def.size * (e.alive ? 1 : 1 + (1 - fade) * 0.6) * fade;
    const ink = Math.hypot(e.pos[0] - cam[0], e.pos[2] - cam[2]) < 60 ? INK : 0;
    const em = (e.hurt > 0 ? 1 : 0.2) + e.lunge;
    const p = e.pos, y = e.yaw;
    const red = hue(PALETTE.red);
    if (e.alive && gRef) blot(r, gRef, p[0], p[2], s * 0.9);
    const wob = Math.sin(time * 5 + e.id) * 0.08;
    if (e.kind === "smudge") {
        const body = at(p, y, [0, s * 0.8 + wob * 0.5, 0]);
        r.solid(S3, yawed(body, y, s * 0.85, s * 0.75, s * 0.85), red, [TOON.corrupt, e.id, em, 0], [wob, 0, 0, ink]);
        for (let k = 0; k < 6; k++) {
            const a = k * 1.05 + time * 0.4;
            r.solid("cone", between(at(body, a, [0, 0, s * 0.6]), at(body, a, [0, s * 0.35, s * 1.25]), s * 0.16), red, [TOON.corrupt, k, em, 0], [0, 0, 0, ink]);
        }
        r.solid(S2, placed(at(body, y, [0, s * 0.15, s * 0.72]), s * 0.26), grey(0.02), [TOON.prop, 0, 0, 0]);
        r.glow(placed(at(body, y, [0, s * 0.15, s * 0.88]), s * 0.32), [1, 0.85, 0.85, 0.9], GLOW.dot);
    } else if (e.kind === "thornback") {
        const lunge = e.lunge * 2;
        const body = at(p, y, [0, s * 0.75, lunge]);
        r.solid(S3, yawed(body, y, s * 0.55, s * 0.5, s * 1.05), red, [TOON.corrupt, e.id, em, 0], [0, 0, 0, ink]);
        const head = at(body, y, [0, s * 0.2, s * 1.05]);
        r.solid(S2, yawed(head, y, s * 0.42, s * 0.36, s * 0.5), red, [TOON.corrupt, e.id, em, 0], [0, 0, 0, ink]);
        for (const sx of [-1, 1]) r.glow(placed(at(head, y, [sx * s * 0.2, s * 0.12, s * 0.42]), s * 0.13), [1, 0.9, 0.8, 1], GLOW.dot);
        for (let k = 0; k < 5; k++) r.solid("cone", between(at(body, y, [0, s * 0.3, s * (0.7 - k * 0.35)]), at(body, y, [0, s * (0.95 + (k % 2) * 0.25), s * (0.45 - k * 0.35)]), s * 0.13), grey(0.05), [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
        const run = Math.sin(time * 14 + e.id);
        for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) r.solid("cyl", between(at(body, y, [sx * s * 0.35, -s * 0.2, sz * s * 0.6]), at(p, y, [sx * s * 0.4, 0, sz * s * 0.6 + run * sx * sz * 0.2]), s * 0.09), red, [TOON.corrupt, 0, em, 0], [0, 0, 0, ink]);
    } else {
        const base = at(p, y, [0, s * 0.5, 0]);
        r.solid(S3, yawed(base, y, s * 0.6, s * 0.5, s * 0.6), red, [TOON.corrupt, e.id, em, 0], [0, 0, 0, ink]);
        const neck = at(p, y, [0, s * 2.1 + wob, s * 0.35]);
        r.solid("cyl", between(base, neck, s * 0.16), red, [TOON.corrupt, 0, em, 0], [0, 0, 0, ink]);
        r.solid(S2, yawed(neck, y, s * 0.36, s * 0.3, s * 0.5), red, [TOON.corrupt, e.id, em, 0], [0, 0, 0, ink]);
        r.solid("cyl", between(at(neck, y, [0, 0, s * 0.3]), at(neck, y, [0, 0, s * 0.75]), s * 0.12), grey(0.05), [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
        r.glow(placed(at(neck, y, [0, 0.05, s * 0.78]), s * 0.22 + (e.agent.cool > 0 ? 0.15 : 0)), [1, 0.4, 0.4, 0.9], GLOW.dot);
    }
    if (e.alive && e.hp < e.maxHp) {
        const k = e.hp / e.maxHp;
        r.glow(placed([p[0], p[1] + s * 2.4, p[2]], 0.35), [1, 0.25, 0.25, 0.5], GLOW.ring, 0.05 + 0.25 * k);
    }
}

function drawBoss(r: Renderer, g: Game, idx: number, time: number): void {
    const b = g.darks[idx].boss!;
    const def = BOSSES[b.id], s = b.size, p = b.pos, y = b.yaw;
    const shielded = b.anchors.some(a => a.hp > 0);
    const em = (b.hurt > 0 ? 0.9 : 0.25) + b.stomp;
    const red = hue(def.color);
    const breathe = Math.sin(time * 1.3) * 0.04;
    if (b.id === "gloomtusk") {
        const body = at(p, y, [0, s * 0.62 - b.stomp * 0.6, 0]);
        r.solid(S3, yawed(body, y, s * 0.6, s * 0.48, s * 0.85), red, [TOON.corrupt, 1, em, 0], [breathe, 0, 0, INK * 2]);
        const head = at(body, y, [0, s * 0.05, s * 0.85]);
        r.solid(S3, yawed(head, y, s * 0.36, s * 0.32, s * 0.4), red, [TOON.corrupt, 2, em, 0], [0, 0, 0, INK * 2]);
        for (const sx of [-1, 1]) {
            r.solid("cone", between(at(head, y, [sx * s * 0.2, -s * 0.12, s * 0.28]), at(head, y, [sx * s * 0.42, s * 0.25, s * 0.62]), s * 0.07), grey(0.95), [TOON.prop, 0, 0.2, 0], [0, 0, 0, INK * 2]);
            r.glow(placed(at(head, y, [sx * s * 0.14, s * 0.1, s * 0.38]), s * 0.08), [1, 0.9, 0.7, 1], GLOW.dot);
        }
        for (let k = 0; k < 9; k++) r.solid("cone", between(at(body, y, [0, s * 0.3, s * (0.6 - k * 0.17)]), at(body, y, [Math.sin(k) * s * 0.1, s * (0.75 + (k % 3) * 0.12), s * (0.5 - k * 0.17)]), s * 0.08), grey(0.04), [TOON.prop, 0, 0, 0], [0, 0, 0, INK * 2]);
        for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) r.solid("cyl", between(at(body, y, [sx * s * 0.35, -s * 0.2, sz * s * 0.5]), at(p, y, [sx * s * 0.38, 0, sz * s * 0.5]), s * 0.12), red, [TOON.corrupt, 0, em, 0], [0, 0, 0, INK * 2]);
    } else {
        // The Maw: a tower of red flesh, a ring of teeth, an open throat.
        const body = at(p, y, [0, s * 0.55, 0]);
        r.solid(S3, yawed(body, y, s * 0.55, s * 0.7, s * 0.55), red, [TOON.corrupt, 1, em, 0], [breathe, 0, 0, INK * 2]);
        const crown = at(body, y, [0, s * 0.62, 0]);
        for (let k = 0; k < 12; k++) {
            const a = (k / 12) * Math.PI * 2 + time * 0.2;
            r.solid("cone", between(at(crown, a, [0, 0, s * 0.34]), at(crown, a, [0, s * 0.35 + (k % 2) * s * 0.1, s * 0.48]), s * 0.06), grey(0.95), [TOON.prop, 0, 0.1, 0], [0, 0, 0, INK * 2]);
        }
        r.glow(placed([crown[0], crown[1] + s * 0.1, crown[2]], s * 0.35), [...PALETTE.red, 0.9], GLOW.heart);
        for (let k = 0; k < 6; k++) {
            const a = k * 1.047 + Math.sin(time * 0.7 + k) * 0.2;
            const root = at(body, a, [0, -s * 0.3, s * 0.4]);
            r.solid("cone", between(root, at(root, a, [0, -s * 0.25, s * 0.55]), s * 0.12), red, [TOON.corrupt, k, em, 0], [0, 0, 0, INK * 2]);
        }
    }
    // Shielded by its anchors: a red cage; exposed: a white target on the heart.
    if (shielded) r.glow(placed([p[0], p[1] + s * 0.7, p[2]], s * 1.05), [...PALETTE.red, 0.35 + 0.1 * Math.sin(time * 3)], GLOW.ring, 0.05);
    else r.glow(placed([p[0], p[1] + s * 0.7, p[2]], s * 0.5), [1, 1, 1, 0.5 + 0.3 * Math.sin(time * 6)], GLOW.ring, 0.08);
}

function drawNpc(r: Renderer, id: string, p: V3, face: number, time: number, talking: boolean): void {
    const def = NPCS[id], y = face + Math.sin(time * 0.6) * 0.15;
    const fur = grey(0.62), dark = grey(0.25), light = grey(0.9);
    const bounce = Math.abs(Math.sin(time * 4.2)) * 0.06 + (talking ? Math.abs(Math.sin(time * 9)) * 0.04 : 0);
    const ink = INK;
    if (def.kind === "koala") {
        const body = at(p, y, [0, 0.75 + bounce, 0]);
        r.solid(S3, yawed(body, y, 0.55, 0.65, 0.5), fur, [TOON.creature, 0, 0, 0], [0, 0, 0, ink]);
        const head = at(body, y, [0, 0.78, 0.05]);
        r.solid(S3, placed(head, 0.48, 0.42, 0.42), fur, [TOON.creature, 0, 0, 0], [0, 0, 0, ink]);
        for (const sx of [-1, 1]) {
            r.solid(S2, placed(at(head, y, [sx * 0.45, 0.25, -0.05]), 0.26, 0.26, 0.12), light, [TOON.creature, 0, 0, 0], [0, 0, 0, ink]);
            r.solid(S1, placed(at(head, y, [sx * 0.17, 0.06, 0.38]), 0.06), grey(0.02), [TOON.prop, 0, 0, 0]);
        }
        r.solid(S2, yawed(at(head, y, [0, -0.06, 0.42]), y, 0.12, 0.16, 0.1), grey(0.1), [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
        // The marimba: bars of light grey on a stand.
        const m = at(p, y, [0, 0.7, 0.85]);
        for (let k = 0; k < 7; k++) r.solid("box", yawed(at(m, y, [(k - 3) * 0.17, 0, 0]), y, 0.07, 0.03, 0.22 + (6 - k) * 0.025), grey(0.82 - (k % 2) * 0.1), [TOON.prop, k, 0, 0], [0, 0, 0, ink * 0.6]);
        r.solid("box", yawed(at(m, y, [0, -0.35, 0]), y, 0.62, 0.33, 0.06), dark, [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
        // A stall awning behind.
        const st = at(p, y, [0, 0, -1.6]);
        for (const sx of [-1, 1]) r.solid("cyl", placed(at(st, y, [sx * 1.4, 0, 0]), 0.08, 2.6, 0.08), dark, [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
        r.solid("box", yawed(at(st, y, [0, 2.65, 0.3]), y, 1.6, 0.08, 0.9), grey(0.88), [TOON.prop, 0, 0, 0], [0, MATERIAL.wood, 0, ink]);
        r.solid("box", yawed(at(st, y, [0, 0.45, 0.2]), y, 1.3, 0.45, 0.5), grey(0.6), [TOON.prop, 0, 0, 0], [0, MATERIAL.wood, 0, ink]);
    } else if (def.kind === "owl") {
        const body = at(p, y, [0, 0.85 + bounce * 0.5, 0]);
        r.solid(S3, yawed(body, y, 0.5, 0.75, 0.45), fur, [TOON.creature, 0, 0, 0], [0, 0, 0, ink]);
        r.solid(S2, yawed(at(body, y, [0, -0.1, 0.25]), y, 0.36, 0.5, 0.25), light, [TOON.creature, 0, 0, 0]);
        const head = at(body, y, [0, 0.78, 0]);
        r.solid(S3, placed(head, 0.45, 0.38, 0.4), fur, [TOON.creature, 0, 0, 0], [0, 0, 0, ink]);
        for (const sx of [-1, 1]) {
            r.solid(S2, placed(at(head, y, [sx * 0.18, 0.04, 0.32]), 0.15), light, [TOON.prop, 0, 0.3, 0], [0, 0, 0, ink * 0.6]);
            r.solid(S1, placed(at(head, y, [sx * 0.18, 0.04, 0.44]), 0.07), grey(0.02), [TOON.prop, 0, 0, 0]);
            r.solid("cone", between(at(head, y, [sx * 0.25, 0.28, 0]), at(head, y, [sx * 0.38, 0.6, -0.05]), 0.08), dark, [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
        }
        // The flute, held across.
        r.solid("cyl", between(at(head, y, [-0.5, -0.25, 0.3]), at(head, y, [0.4, -0.18, 0.45]), 0.035), grey(0.88), [TOON.prop, 0, 0, 0], [0, 0, 0, ink * 0.6]);
        r.solid("cyl", placed(at(p, y, [0, 0, 0]), 0.3, 0.3, 0.3), dark, [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
    } else if (def.kind === "snake") {
        for (let k = 0; k < 9; k++) {
            const a = k * 0.7 + time * 0.8;
            const q = at(p, y, [Math.sin(a) * 0.45, 0.25 + (k > 5 ? (k - 5) * 0.32 : 0), (4 - k) * 0.3]);
            r.solid(S2, placed(q, 0.3 - k * 0.012), k % 2 ? fur : dark, [TOON.creature, k, 0, 0], [0, 0, 0, ink]);
        }
        const head = at(p, y, [Math.sin(8 * 0.7 + time * 0.8) * 0.45, 1.6, -1.0]);
        r.solid(S3, yawed(head, y, 0.3, 0.22, 0.4), fur, [TOON.creature, 0, 0, 0], [0, 0, 0, ink]);
        for (const sx of [-1, 1]) r.solid(S1, placed(at(head, y, [sx * 0.16, 0.08, 0.2]), 0.06), grey(0.02), [TOON.prop, 0, 0, 0]);
        // The handpan.
        r.solid(S3, placed(at(p, y, [0, 0.3, 1.2]), 0.55, 0.2, 0.55), grey(0.72), [TOON.prop, 0, 0.1, 0], [0, 0, 0, ink]);
    } else if (def.kind === "crab") {
        const body = at(p, y, [0, 0.45 + bounce, 0]);
        r.solid(S3, yawed(body, y, 0.6, 0.3, 0.45), fur, [TOON.creature, 0, 0, 0], [0, 0, 0, ink]);
        for (const sx of [-1, 1]) {
            const claw = at(body, y, [sx * 0.8, 0.2 + Math.abs(Math.sin(time * 6 + sx)) * 0.15, 0.4]);
            r.solid("cyl", between(at(body, y, [sx * 0.5, 0, 0.2]), claw, 0.06), dark, [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
            r.solid(S2, yawed(claw, y, 0.2, 0.14, 0.26), fur, [TOON.creature, 0, 0, 0], [0, 0, 0, ink]);
            r.solid("cyl", between(at(body, y, [sx * 0.2, 0.25, 0.3]), at(body, y, [sx * 0.22, 0.55, 0.32]), 0.03), dark, [TOON.prop, 0, 0, 0]);
            r.solid(S1, placed(at(body, y, [sx * 0.22, 0.6, 0.32]), 0.08), light, [TOON.prop, 0, 0, 0], [0, 0, 0, ink * 0.6]);
            for (let k = 0; k < 3; k++) r.solid("cyl", between(at(body, y, [sx * 0.45, -0.05, -0.2 + k * 0.2]), at(p, y, [sx * 0.8, 0, -0.2 + k * 0.2]), 0.04), dark, [TOON.prop, 0, 0, 0]);
        }
        r.solid("cyl", placed(at(p, y, [0, 0, 0.95]), 0.38, 0.5, 0.38), grey(0.45), [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
        r.solid("cyl", placed(at(p, y, [0, 0.5, 0.95]), 0.36, 0.02, 0.36), light, [TOON.prop, 0, 0, 0]);
    } else {
        const shell = at(p, y, [0, 0.55, 0]);
        r.solid(S3, placed(shell, 0.95, 0.6, 1.05), grey(0.4), [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
        for (let k = 0; k < 6; k++) r.solid("cyl", aligned(at(shell, k * 1.05, [0, 0.36, 0.55]), [Math.sin(k * 1.05) * 0.5, 0.86, Math.cos(k * 1.05) * 0.5], 0, 0.28, 0.02, 0.28), grey(0.6), [TOON.prop, 0, 0, 0]);
        const head = at(p, y, [0, 0.75 + Math.sin(time) * 0.05, 1.15]);
        r.solid("cyl", between(at(p, y, [0, 0.4, 0.8]), head, 0.17), fur, [TOON.creature, 0, 0, 0], [0, 0, 0, ink]);
        r.solid(S3, yawed(head, y, 0.24, 0.22, 0.3), fur, [TOON.creature, 0, 0, 0], [0, 0, 0, ink]);
        for (const sx of [-1, 1]) r.solid(S1, placed(at(head, y, [sx * 0.13, 0.06, 0.2]), 0.04), grey(0.02), [TOON.prop, 0, 0, 0]);
        r.solid("box", yawed(at(p, y, [0.7, 0.4, 0.9]), y, 0.22, 0.05, 0.16), grey(0.8), [TOON.prop, 0, 0, 0], [0, 0, 0, ink]);
    }
}

export function speciesColor(s: SpeciesId): RGB { return SPECIES[s].color; }
