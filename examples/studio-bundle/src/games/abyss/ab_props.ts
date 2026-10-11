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
    group: "fob" | "rim" | "ledge" | "boulders" | "crystals" | "settlement" | "ruins" | "pickup";
    /** Draw-distance class: "near" props fade out early, "far" ones always draw. */
    reach: "near" | "mid" | "far";
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
    return out;
}

/** Solid footprints (x, z, radius) of the props, for walking and line of sight. */
export function solids(props: readonly Prop[]): { x: number; z: number; r: number }[] {
    return props.filter(p => p.solid > 0).map(p => ({ x: p.x, z: p.z, r: p.solid * (p.object === "nature.rock" ? 1 : 1) }));
}
