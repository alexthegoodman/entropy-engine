// What stands in Chapter One's world, placed once from a seed: the expedition's forward base on
// the south rim (containers, field habitats, floodlights, comms poles), floodlights along the rim,
// Ledge Kilo's supply drop and lamps, boulders fallen from the walls, the deep's glowing crystals,
// and the settlement of the kingdom below - tower houses round the river shrine, ruins and domed
// halls. Every piece is a Mesha library object with its own parameters; pieces that share an
// object and parameters are drawn as one instanced batch.

import { makeRng } from "../allegiance/al_rng";
import { lookupObject } from "../../apps/mesha/library";
import type { ParamValues } from "../../apps/mesha/mesha_object";
import { FOB, SHRINE, SETTLEMENT, EVAC_LZ, CRACK_A, CRACK_B, crackSD, riverDistance, MAP_HALF, riftBend, SOURCE_POOL, type V2 } from "./ab_world";
import { PLACES } from "./ab_script";
import { PLACES2 } from "./ab_script2";

export interface Prop {
    object: string;
    values: ParamValues;
    x: number;
    z: number;
    /** Height above the ground (usually 0). */
    lift?: number;
    yaw: number;
    scale: number;
    /** Solid footprint radius (m) for walking and line of sight; 0 none. */
    solid: number;
    /** Where it belongs (for the debugging and the state tool). */
    group: "fob" | "rim" | "ledge" | "boulders" | "crystals" | "settlement" | "ruins" | "pickup" | "firebase" | "cover";
    /** Only in this chapter (absent: every chapter). */
    chapter?: 1 | 2;
    /** Draw-distance class: "near" props fade out early, "far" ones always draw. */
    reach: "near" | "mid" | "far";
    /** Cover (barricades, low walls): solid along its length (local +Z) up to this height. */
    cover?: number;
}

/** A preset's values by name (falls back to the defaults). */
export function preset(objectId: string, name: string, extra: ParamValues = {}): ParamValues {
    const def = lookupObject(objectId);
    const p = def?.presets?.find(x => x.name === name);
    return { ...(p?.values ?? {}), ...extra };
}

/** The key that groups identical pieces into one batch. */
export const propKey = (p: Pick<Prop, "object" | "values">): string => `${p.object}|${JSON.stringify(p.values, Object.keys(p.values).sort())}`;

export function placeProps(seed = 1): Prop[] {
    const rng = makeRng(seed);
    const out: Prop[] = [];
    const put = (p: Omit<Prop, "yaw" | "scale" | "solid" | "reach"> & Partial<Pick<Prop, "yaw" | "scale" | "solid" | "reach">>) =>
        out.push({ yaw: 0, scale: 1, solid: 0, reach: "mid", ...p });

    // --- The forward base on the south rim ---
    const [bx, bz] = FOB;
    const container = preset("transport.container", "Port blue high cube", { doorsOpen: 0.15, shellFinish: "metal.corrugated", doorFinish: "metal.corrugated" });
    const containerRed = preset("transport.container", "Port blue high cube", { doorsOpen: 0, size: "20", highCube: false, doorFinish: "metal.corrugatedRed" });
    for (let i = 0; i < 6; i++) put({ object: "transport.container", values: i % 2 ? container : containerRed, x: bx - 110 + i * 7, z: bz - 70, yaw: Math.PI / 2, solid: 4, group: "fob" });
    for (let i = 0; i < 4; i++) put({ object: "transport.container", values: containerRed, x: bx + 95, z: bz - 60 + i * 9, yaw: 0, solid: 3.5, group: "fob" });
    const habitat = preset("architecture.dome_building", "Lunar habitat", { roofFinish: "paint.sage", wallFinish: "paint.sage" });
    for (let i = 0; i < 3; i++) put({ object: "architecture.dome_building", values: habitat, x: bx - 70 + i * 26, z: bz + 70, yaw: Math.PI, solid: 5.5, group: "fob" });
    const flood = preset("street.streetlight", "Highway cobra head");
    for (const [dx, dz] of [[-120, -95], [120, -95], [-120, 95], [120, 95], [0, 115], [0, -110]]) put({ object: "street.streetlight", values: flood, x: bx + dx, z: bz + dz, yaw: Math.atan2(-dx, -dz), solid: 0.4, group: "fob", reach: "far" });
    const pole = preset("street.utility_pole", "Upright country pole", { wires: false, lamp: false, transformer: false });
    for (let i = 0; i < 4; i++) put({ object: "street.utility_pole", values: pole, x: bx - 140 + i * 90, z: bz - 135, yaw: 0, solid: 0.4, group: "fob", reach: "far" });
    const drums = preset("street.barrel", "Toxic stack", { drumFinish: "paint.navy", bandFinish: "paint.signal" });
    for (let i = 0; i < 5; i++) put({ object: "street.barrel", values: drums, x: bx - 40 + rng.next() * 140, z: bz - 40 + rng.next() * 60, yaw: rng.next() * 6, solid: 1.2, group: "fob", reach: "near" });

    // --- Floodlights along the south rim, turned to the crack ---
    for (let x = -1100; x <= 1100; x += 220) {
        // Walk out from the rim's line until the ground is solid.
        let z = -CRACK_B * 0.98 + riftBend(x);
        while (crackSD(x, z) < 18 && z > -MAP_HALF + 50) z -= 6;
        put({ object: "street.streetlight", values: flood, x, z, yaw: Math.PI, solid: 0.4, group: "rim", reach: "far" });
    }

    // --- Ledge Kilo: the supply drop and its lamps ---
    const [sx, sz] = PLACES.supply;
    put({ object: "household.crate", values: preset("household.crate", "Shipping crate", { woodFinish: "wood.weathered" }), x: sx, z: sz, yaw: 0.4, scale: 3.2, solid: 1.4, group: "ledge", reach: "near" });
    put({ object: "household.crate", values: preset("household.crate", "Shipping crate", { woodFinish: "wood.weathered" }), x: sx + 2.6, z: sz - 1.2, yaw: 1.1, scale: 2.6, solid: 1.1, group: "ledge", reach: "near" });
    put({ object: "street.streetlight", values: preset("street.streetlight", "Steel bollard", { lit: true }), x: sx - 1.8, z: sz + 1.6, yaw: 0, scale: 1.2, solid: 0.3, group: "ledge", reach: "near" });
    const ledgeLamp = preset("street.streetlight", "Modern LED");
    put({ object: "street.streetlight", values: ledgeLamp, x: PLACES.landing[0] + 22, z: PLACES.landing[1] + 26, yaw: Math.PI * 0.8, solid: 0.3, group: "ledge" });
    put({ object: "street.streetlight", values: ledgeLamp, x: PLACES.rampTop[0] - 30, z: PLACES.rampTop[1] - 8, yaw: Math.PI * 0.4, solid: 0.3, group: "ledge" });
    put({ object: "street.barrel", values: preset("street.barrel", "Rusted drum", { drumFinish: "paint.navy", count: 3 }), x: sx + 5, z: sz + 3, yaw: 0.3, solid: 1, group: "ledge", reach: "near" });

    // --- Boulders fallen from the walls: on the floor near the walls, the scree, the rockslide's flanks ---
    // Sizes come from the scale, so boulders share a dozen meshes (six seeds of each kind).
    const boulder = (_size: number, s: number): ParamValues => ({ ...preset("nature.rock", "Boulder"), size: 2.5, seed: s, stone: "stone.slate" });
    const outcrop = (_size: number, s: number): ParamValues => ({ ...preset("nature.rock", "Low-poly outcrop"), size: 2.5, seed: s, stone: "stone.slate" });
    for (let i = 0; i < 90; i++) {
        const a = rng.next() * Math.PI * 2, rr = 0.55 + rng.next() * 0.42;
        const x = Math.cos(a) * CRACK_A * rr, z = Math.sin(a) * CRACK_B * rr + riftBend(Math.cos(a) * CRACK_A * rr);
        if (crackSD(x, z) > -60) continue;
        if (Math.hypot(x - SETTLEMENT[0], z - SETTLEMENT[1]) < 190 || Math.hypot(x - EVAC_LZ[0], z - EVAC_LZ[1]) < 70) continue;
        const size = 2 + rng.next() * 3;
        const s = Math.floor(rng.next() * 6);
        const near = Math.hypot(x - SETTLEMENT[0], z - SETTLEMENT[1]) < 500;
        const scale = (1.5 + rng.next() * 2.2) * size / 2.5;
        put({ object: "nature.rock", values: near ? boulder(size, s) : outcrop(size, s), x, z, yaw: rng.next() * 6.28, scale, solid: 1.1 * scale, group: "boulders", reach: near ? "mid" : "far" });
    }
    // Along the rockslide.
    for (let i = 0; i < PLACES.rampPath.length - 1; i++) {
        const [ax, az] = PLACES.rampPath[i], [cx, cz] = PLACES.rampPath[i + 1];
        for (let k = 0; k < 2; k++) {
            const t = rng.next();
            const side = rng.next() < 0.5 ? -1 : 1;
            const px = ax + (cx - ax) * t, pz = az + (cz - az) * t;
            const nx = -(cz - az), nz = cx - ax, nl = Math.hypot(nx, nz) || 1;
            const off = 22 + rng.next() * 18;
            const scale = 0.8 + rng.next() * 0.9;
            put({ object: "nature.rock", values: boulder(2.5, Math.floor(rng.next() * 6)), x: px + nx / nl * off * side, z: pz + nz / nl * off * side, yaw: rng.next() * 6.28, scale, solid: 1.1 * scale, group: "boulders" });
        }
    }

    // --- Crystals of the deep: clusters on the floor and at the walls' feet, brighter toward the Source ---
    const crystal = (name: string): ParamValues => preset("nature.crystal_cluster", name);
    const kinds = ["River crystals", "Violet spire", "Golden bloom"];
    for (let i = 0; i < 46; i++) {
        const a = rng.next() * Math.PI * 2, rr = 0.25 + rng.next() * 0.68;
        const x = Math.cos(a) * CRACK_A * rr, z = Math.sin(a) * CRACK_B * rr + riftBend(Math.cos(a) * CRACK_A * rr);
        if (crackSD(x, z) > -30) continue;
        if (Math.hypot(x - SHRINE[0], z - SHRINE[1]) < 40) continue;
        const kind = kinds[x > 600 ? (rng.next() < 0.5 ? 0 : 1) : Math.floor(rng.next() * 3)];
        put({ object: "nature.crystal_cluster", values: crystal(kind), x, z, yaw: rng.next() * 6.28, scale: 1 + rng.next() * 2.5, solid: 0, group: "crystals", reach: "far" });
    }
    for (let i = 0; i < 10; i++) {
        const a = rng.next() * Math.PI * 2, d = 30 + rng.next() * 70;
        put({ object: "nature.crystal_cluster", values: crystal("Violet spire"), x: SOURCE_POOL[0] + Math.cos(a) * d - 30, z: SOURCE_POOL[1] + Math.sin(a) * d, yaw: rng.next() * 6.28, scale: 1.4 + rng.next() * 2, solid: 0, group: "crystals", reach: "far" });
    }

    // --- The settlement: tower houses in rings round the shrine, between the streets, off the riverbed ---
    put({ object: "architecture.river_shrine", values: preset("architecture.river_shrine", "Shrine of the river", { radius: 11 }), x: SHRINE[0], z: SHRINE[1], yaw: Math.atan2(PLACES.rampFoot[0] - SHRINE[0], PLACES.rampFoot[1] - SHRINE[1]), solid: 0, group: "settlement", reach: "far" });
    const houseKinds: ParamValues[] = [
        preset("architecture.cave_dwelling", "River house"),
        preset("architecture.cave_dwelling", "Candlelit tower"),
        preset("architecture.cave_dwelling", "Elder's dome"),
        preset("architecture.cave_dwelling", "Roofless"),
        preset("architecture.cave_dwelling", "Shattered"),
        { ...preset("architecture.cave_dwelling", "River house"), tiers: 3, roof: "dome", seed: 3 },
        { ...preset("architecture.cave_dwelling", "River house"), tiers: 1, radius: 2.6, windows: 3, seed: 5, roof: "cone", roofFinish: "metal.bronze" },
    ];
    const placed: V2[] = [];
    let tries = 0;
    while (placed.length < 22 && tries++ < 600) {
        const sector = Math.floor(rng.next() * 6);
        const ang = (sector + 0.5) * (Math.PI / 3) + (rng.next() - 0.5) * 0.55;
        const d = 34 + rng.next() * 140;
        const x = SHRINE[0] + Math.cos(ang) * d, z = SHRINE[1] + Math.sin(ang) * d;
        if (riverDistance(x, z).d < 26) continue;
        if (crackSD(x, z) > -150) continue;
        if (placed.some(([px, pz]) => Math.hypot(px - x, pz - z) < 15)) continue;
        if (Math.hypot(x - EVAC_LZ[0], z - EVAC_LZ[1]) < 90) continue;
        placed.push([x, z]);
        // Nearer the shrine, the older and grander; out at the edge, more of them broken.
        const k = d < 70 ? (rng.next() < 0.5 ? 2 : 0) : d > 130 ? (rng.next() < 0.5 ? 3 : 4) : Math.floor(rng.next() * houseKinds.length);
        const v: ParamValues = { ...houseKinds[k], seed: Math.floor(rng.next() * 50) };
        const r = Number(v.radius ?? 3.2);
        put({ object: "architecture.cave_dwelling", values: v, x, z, yaw: Math.atan2(SHRINE[0] - x, SHRINE[1] - z), solid: r + 0.4, group: "settlement", reach: "far" });
    }
    // Domed halls and the fieldstone ruins of older houses.
    const hall = { ...preset("architecture.dome_building", "Obsidian embassy"), wallFinish: "stone.sandstone", trimFinish: "metal.brass", roofFinish: "stone.slate" };
    for (const [dx, dz] of [[-95, 70], [110, 95]]) {
        const x = SHRINE[0] + dx, z = SHRINE[1] + dz;
        put({ object: "architecture.dome_building", values: hall, x, z, yaw: Math.atan2(SHRINE[0] - x, SHRINE[1] - z), solid: 7.4, group: "settlement", reach: "far" });
    }
    const ruinV = preset("architecture.ruin", "Fieldstone remains", { wallFinish: "stone.carved" as string });
    for (let i = 0; i < 8; i++) {
        const ang = rng.next() * Math.PI * 2, d = 120 + rng.next() * 90;
        const x = SHRINE[0] + Math.cos(ang) * d, z = SHRINE[1] + Math.sin(ang) * d;
        if (riverDistance(x, z).d < 22 || crackSD(x, z) > -120) continue;
        put({ object: "architecture.ruin", values: { ...ruinV, seed: i * 7 + 3 }, x, z, yaw: rng.next() * 6.28, solid: 0, group: "ruins" });
    }
    placeFirebase(put, rng);
    placeCover(put, rng, out);
    return out;
}

type Put = (p: Omit<Prop, "yaw" | "scale" | "solid" | "reach"> & Partial<Pick<Prop, "yaw" | "scale" | "solid" | "reach">>) => void;

/** A barricade prop (ab street.barricade): `yaw` turns its length (local +Z). */
function barricade(put: Put, kind: "jersey" | "sandbags" | "stone", x: number, z: number, yaw: number, length: number, extra: Partial<Prop> = {}, values: ParamValues = {}): void {
    const height = kind === "stone" ? 0.95 : kind === "sandbags" ? 1.05 : 1;
    // Lengths come in a few sizes so walls share meshes.
    const L = kind === "jersey" ? Math.max(3, Math.round(length / 3) * 3) : Math.max(2, Math.round(length / 2) * 2);
    put({ object: "street.barricade", values: { kind, length: L, height, ...values }, x, z, yaw, cover: height, group: "cover", reach: "mid", ...extra });
}

/**
 * Cover across the world: the settlement's dry-stone field walls, the expedition's barriers at the
 * forward base and the rim, the firebase's checkpoints, and positions scattered over the open
 * floor - places to crouch behind, for Alex and for the wardens.
 */
function placeCover(put: Put, rng: { next(): number }, placed: readonly Prop[]): void {
    const clearOf = (x: number, z: number, r: number) => !placed.some(p => p.solid > 0 && Math.hypot(p.x - x, p.z - z) < p.solid + r);
    // The settlement's fields: dry-stone walls in arcs round the town, off the streets and the riverbed.
    let n = 0;
    for (let i = 0; i < 80 && n < 18; i++) {
        const ang = rng.next() * Math.PI * 2, d = 70 + rng.next() * 170;
        const x = SHRINE[0] + Math.cos(ang) * d, z = SHRINE[1] + Math.sin(ang) * d;
        if (riverDistance(x, z).d < 24 || crackSD(x, z) > -90 || !clearOf(x, z, 6)) continue;
        // Along the ring (tangent), as field walls run.
        barricade(put, "stone", x, z, ang + (rng.next() - 0.5) * 0.5, 5 + rng.next() * 6, {}, { damage: 0.3 + rng.next() * 0.5, seed: Math.floor(rng.next() * 4) });
        n++;
    }
    // By the landing zone: old walls where the battle of First Blood was fought.
    for (const [dx, dz, yaw] of [[34, 22, 0.4], [-30, 38, 1.9], [48, -18, 2.6], [-44, -24, 1.1], [12, 52, 0.1], [-58, 6, 1.6]] as const) {
        barricade(put, "stone", EVAC_LZ[0] + dx, EVAC_LZ[1] + dz, yaw, 6, {}, { damage: 0.6, seed: 2 });
    }
    // The forward base on the rim: jersey barriers round its pad and along the lip.
    const [bx, bz] = FOB;
    for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + 0.2;
        barricade(put, "jersey", bx + Math.cos(a) * 150, bz + Math.sin(a) * 150, -a, 9, { chapter: undefined });
    }
    for (let x = -1000; x <= 1000; x += 250) {
        let z = -CRACK_B * 0.98 + riftBend(x);
        while (crackSD(x, z) < 26 && z > -MAP_HALF + 50) z -= 6;
        barricade(put, "jersey", x + 40, z, Math.PI / 2, 9);
    }
    // Firebase Lantern (Chapter Two): checkpoints at its two gates, sandbag nests by the sentries.
    const [fx, fz] = PLACES2.firebase;
    const c2 = { chapter: 2 as const };
    barricade(put, "jersey", fx, fz + 80, Math.PI / 2, 12, c2, { stripeFinish: "paint.white", damage: 0.1 });
    barricade(put, "jersey", fx + 80, fz, 0, 12, c2, { stripeFinish: "paint.white", damage: 0.1 });
    for (const [dx, dz] of [[46, 44], [-50, 48], [62, -20], [-64, -28], [4, 58]] as const) {
        const a = Math.atan2(dx, dz);
        barricade(put, "sandbags", fx + dx * 1.08, fz + dz * 1.08, a + Math.PI / 2, 4, c2);
    }
    // The open floor: positions the surface dug and abandoned, the kingdoms' old field walls.
    const spots: V2[] = [[520, -160], [760, -60], [-320, 280], [880, 320], [420, -260], [200, 520], [-900, 120], [70, -62], [205, -640], [1240, 70], [-560, -120], [620, 420]];
    for (const [sx, sz] of spots) {
        const k = 3 + Math.floor(rng.next() * 3);
        for (let i = 0; i < k; i++) {
            const a = rng.next() * Math.PI * 2, d = 18 + rng.next() * 45;
            const x = sx + Math.cos(a) * d, z = sz + Math.sin(a) * d;
            if (crackSD(x, z) > -60 || riverDistance(x, z).d < 14 || !clearOf(x, z, 5)) continue;
            const stone = rng.next() < 0.55;
            barricade(put, stone ? "stone" : "sandbags", x, z, rng.next() * Math.PI, stone ? 6 : 4, c2, stone ? { damage: 0.5, seed: Math.floor(rng.next() * 4) } : {});
        }
    }
}

/**
 * Chapter Two's Firebase Lantern on Kilo-Two's landing zone: a ring of containers for a wall
 * (open to the north and east), the command dome, floodlights, the quartermaster's stacks and
 * the crates of recovered artifacts, and a lit memorial.
 */
function placeFirebase(put: (p: Omit<Prop, "yaw" | "scale" | "solid" | "reach"> & Partial<Pick<Prop, "yaw" | "scale" | "solid" | "reach">>) => void, rng: { next(): number }): void {
    const [fx, fz] = PLACES2.firebase;
    const c2 = { chapter: 2 as const, group: "firebase" as const };
    const wall = preset("transport.container", "Port blue high cube", { doorsOpen: 0, shellFinish: "metal.corrugatedGreen", doorFinish: "metal.corrugatedGreen" });
    const wallRed = preset("transport.container", "Port blue high cube", { doorsOpen: 0, size: "20", highCube: false, doorFinish: "metal.corrugatedRed" });
    for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2;
        // Gates: north (toward the hollow) and east (toward the shrine).
        if (Math.abs(Math.sin(a) - 1) < 0.05 || Math.abs(Math.cos(a) - 1) < 0.05) continue;
        const x = fx + Math.cos(a) * 62, z = fz + Math.sin(a) * 62;
        put({ object: "transport.container", values: i % 3 ? wall : wallRed, x, z, yaw: -a, solid: 3.6, ...c2 });
    }
    const habitat = preset("architecture.dome_building", "Lunar habitat", { roofFinish: "paint.sage", wallFinish: "paint.sage" });
    put({ object: "architecture.dome_building", values: habitat, x: fx + 30, z: fz + 32, yaw: Math.atan2(-30, -32), solid: 5.5, reach: "far", ...c2 });
    put({ object: "architecture.dome_building", values: habitat, x: fx - 34, z: fz - 30, yaw: Math.atan2(34, 30), solid: 5.5, reach: "far", ...c2 });
    const flood = preset("street.streetlight", "Highway cobra head");
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        put({ object: "street.streetlight", values: flood, x: fx + Math.cos(a) * 50, z: fz + Math.sin(a) * 50, yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) + Math.PI, solid: 0.4, reach: "far", ...c2 });
    }
    // The quartermaster's stacks, and the recovered artifacts crated beside them.
    const [dx, dz] = PLACES2.dace;
    const crate = preset("household.crate", "Shipping crate", { woodFinish: "wood.weathered" });
    for (let i = 0; i < 5; i++) put({ object: "household.crate", values: crate, x: dx - 4 + (i % 3) * 2.8, z: dz + 4 + Math.floor(i / 3) * 2.8, yaw: rng.next() * 0.4, scale: 2.6, solid: 1.1, reach: "near", ...c2 });
    const [cx, cz] = PLACES2.crate;
    for (let i = 0; i < 4; i++) put({ object: "household.crate", values: crate, x: cx + (i % 2) * 2.4 - 1.2, z: cz + 2 + Math.floor(i / 2) * 2.4, yaw: 0.2 * i, scale: 2.2, solid: 0.9, reach: "near", ...c2 });
    put({ object: "street.barrel", values: preset("street.barrel", "Toxic stack", { drumFinish: "paint.navy", bandFinish: "paint.signal" }), x: dx + 6, z: dz - 4, yaw: 0.4, solid: 1.2, reach: "near", ...c2 });
    // The memorial: a crate of Kilo-Two's kit under a lamp, where the tags will hang.
    const [mx, mz] = PLACES2.memorial;
    put({ object: "household.crate", values: preset("household.crate", "Shipping crate", { woodFinish: "wood.charred" }), x: mx, z: mz - 1.6, yaw: 0, scale: 1.6, solid: 0.8, reach: "near", ...c2 });
    put({ object: "street.streetlight", values: preset("street.streetlight", "Steel bollard", { lit: true }), x: mx + 1.6, z: mz - 1.2, yaw: 0, scale: 1.3, solid: 0.3, reach: "near", ...c2 });
    put({ object: "street.streetlight", values: preset("street.streetlight", "Steel bollard", { lit: true }), x: mx - 1.6, z: mz - 1.2, yaw: 0, scale: 1.3, solid: 0.3, reach: "near", ...c2 });
}

/**
 * Solid footprints of the props, for walking and line of sight: a column per prop, and for cover
 * a row of short columns along its length (with its height, so it hides a crouched body but not
 * a standing one).
 */
export function solids(props: readonly Prop[], chapter: 1 | 2 = 1): { x: number; z: number; r: number; h?: number; cover?: boolean }[] {
    const out: { x: number; z: number; r: number; h?: number; cover?: boolean }[] = [];
    for (const p of props) {
        if (p.chapter && p.chapter !== chapter) continue;
        if (p.cover) {
            const L = Number(p.values.length ?? 4);
            const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
            const n = Math.max(2, Math.round(L / 0.6));
            for (let i = 0; i <= n; i++) {
                const t = -L / 2 + 0.3 + (L - 0.6) * (i / n);
                out.push({ x: p.x + fx * t, z: p.z + fz * t, r: 0.42, h: p.cover, cover: true });
            }
        } else if (p.solid > 0) out.push({ x: p.x, z: p.z, r: p.solid });
    }
    return out;
}

/** The doors of the settlement's houses (where its people run when the expedition comes): each on the side facing the shrine. */
export function settlementDoors(props: readonly Prop[]): [number, number][] {
    return props.filter(p => p.object === "architecture.cave_dwelling").map(p => {
        const r = Number(p.values.radius ?? 3.2) + 0.4;
        return [p.x + Math.sin(p.yaw) * r, p.z + Math.cos(p.yaw) * r] as [number, number];
    });
}
