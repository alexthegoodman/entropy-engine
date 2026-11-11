// Builds a region of Nebula Kingdom from its definition (nk_data.ts REGIONS): bodies (motes,
// rubble, moons, planets, stars), creatures, black holes and the rift, all placed by a seeded
// generator so a region is the same every visit. Sizes and positions in a definition are in
// units of the region's radius; here they become kilometres.

import { Rng, add, mul, norm, cross, type V3 } from "./nk_math";
import {
    SPECIES, tierRadius, kindOfRadius, starLook, massOfRadius,
    type RegionDef, type BodySpec, type BodyKind, type BodyLook, type CreatureSpec, type FactionId, type SpeciesId, type Species,
} from "./nk_data";

export interface Body {
    id: number;
    key: string;
    name: string;
    kind: BodyKind;
    look: BodyLook;
    pos: V3;
    vel: V3;
    radius: number;
    /** The radius it was made with (what is left of it shows as cracks). */
    radius0: number;
    /** Per-body variation for the shader. */
    seed: number;
    inhabited: boolean;
    rings: boolean;
    alive: boolean;
    /** Circling another body. */
    orbit: { around: number; r: number; speed: number; phase: number; axis: V3 } | null;
    /** Seconds until a star being siphoned throws its next flare. */
    flareIn: number;
    /** 0..1: how hard it is being siphoned right now (drawn as a stream). */
    drain: number;
    /** Multiplier on the mass it yields. */
    yield: number;
}

export type CreatureState = "wander" | "hunt" | "flee" | "dead";
export interface Creature {
    id: number;
    key: string;
    species: Species;
    faction: FactionId;
    name: string;
    pos: V3;
    vel: V3;
    /** Facing (unit). */
    dir: V3;
    radius: number;
    hp: number;
    maxHp: number;
    power: number;
    /** km/s. */
    speed: number;
    /** km. */
    sight: number;
    state: CreatureState;
    /** What it hunts: the player (-1), a decoy (-2), or a creature id. */
    target: number;
    home: V3;
    wanderTo: V3;
    cooldown: number;
    think: number;
    boss: number;
    group: string;
    alive: boolean;
    /** Seconds it keeps treating the player as an enemy whatever its government thinks. */
    provoked: number;
    /** Seconds since it last cried out. */
    cried: number;
    hurt: number;
    /** A phase for its animation. */
    phase: number;
    /** Wave it arrived in (defend goals), -1 otherwise. */
    wave: number;
}

export interface Hole {
    id: number;
    key: string;
    name: string;
    pos: V3;
    vel: V3;
    /** Horizon radius (km). */
    radius: number;
    /** km/s it hunts at (0: it stays put). */
    hunts: number;
    alive: boolean;
    fed: number;
    /** Has the player dipped inside its ergosphere on this pass. */
    grazing: boolean;
}

export interface Rift { pos: V3; radius: number; open: boolean }

export interface Region {
    def: RegionDef;
    /** km per region unit. */
    scale: number;
    bodies: Body[];
    creatures: Creature[];
    holes: Hole[];
    rift: Rift | null;
    /** Where a nebula folds in, and which way it faces. */
    entry: V3;
    nextId: number;
}

const NAMES_A = ["Ka", "Ve", "Or", "Thi", "Ul", "Sa", "Mi", "Ro", "En", "Ya", "Qu", "Ix", "Lo", "Hae", "Ny"];
const NAMES_B = ["ren", "dis", "mar", "tha", "lune", "vex", "sol", "rim", "dra", "nox", "bel", "syr", "tor"];

function pointOf(ref: string | V3, keyed: Map<string, Body>, holes: Map<string, V3>, scale: number): V3 {
    if (typeof ref !== "string") return mul(ref, scale);
    const b = keyed.get(ref);
    if (b) return [...b.pos];
    const h = holes.get(ref);
    if (h) return [...h];
    throw new Error(`Region refers to an unknown body "${ref}"`);
}

function lookFor(kind: BodyKind, radius: number, rng: Rng): BodyLook {
    switch (kind) {
        case "mote": case "essence": return "light";
        case "asteroid": return rng.next() < 0.25 ? "ice" : "rock";
        case "moon": return rng.pick<BodyLook>(["rock", "rock", "ice", "desert"]);
        case "planet": return rng.pick<BodyLook>(["rock", "desert", "ice", "lava", "ocean"]);
        case "giant": return rng.pick<BodyLook>(["gas", "banded", "banded"]);
        case "star": return starLook(radius, rng.next());
    }
}

export function makeBody(region: Region, kind: BodyKind, look: BodyLook, pos: V3, radius: number, seed: number, name = "", key = ""): Body {
    const b: Body = {
        id: region.nextId++, key, name, kind, look, pos, vel: [0, 0, 0], radius, radius0: radius, seed,
        inhabited: false, rings: false, alive: true, orbit: null, flareIn: 3, drain: 0,
        yield: kind === "star" ? 1.6 : kind === "essence" ? 3 : 1,
    };
    region.bodies.push(b);
    return b;
}

export function makeCreature(region: Region, speciesId: SpeciesId, pos: V3, opts: { faction?: FactionId; name?: string; boss?: number; group?: string; key?: string; wave?: number; phase?: number } = {}): Creature {
    const species = SPECIES[speciesId];
    const boss = opts.boss ?? 1;
    const radius = species.size * region.scale * boss;
    const c: Creature = {
        id: region.nextId++, key: opts.key ?? "", species, faction: opts.faction ?? species.faction, name: opts.name ?? species.name,
        pos, vel: [0, 0, 0], dir: [0, 0, -1], radius,
        hp: species.hp * boss * boss, maxHp: species.hp * boss * boss, power: species.power * boss,
        speed: species.speed * radius, sight: species.sight * region.scale * Math.sqrt(boss),
        state: "wander", target: 0, home: [...pos], wanderTo: [...pos], cooldown: 1 + (opts.phase ?? 0) * 2, think: opts.phase ?? 0,
        boss, group: opts.group ?? "", alive: true, provoked: 0, cried: 99, hurt: 0, phase: (opts.phase ?? 0) * 6.283, wave: opts.wave ?? -1,
    };
    region.creatures.push(c);
    return c;
}

export function generateRegion(def: RegionDef): Region {
    const scale = tierRadius(def.tier);
    const rng = new Rng(`nebula-kingdom/${def.id}`);
    const region: Region = { def, scale, bodies: [], creatures: [], holes: [], rift: null, entry: [0, 0, -6 * scale], nextId: 1 };
    const keyed = new Map<string, Body>();
    const holePos = new Map<string, V3>();
    for (const h of def.holes ?? []) holePos.set(h.key, mul(h.at, scale));

    const place = (spec: BodySpec, index: number): V3 => {
        if (spec.at) return mul(spec.at, scale);
        if (spec.belt) {
            const c = pointOf(spec.belt.around, keyed, holePos, scale);
            const a = rng.range(0, Math.PI * 2), r = rng.range(spec.belt.r[0], spec.belt.r[1]) * scale;
            const tilt = spec.belt.tilt ?? 0;
            const y = rng.range(-1, 1) * (spec.belt.thick ?? 1) * scale;
            const p: V3 = [Math.cos(a) * r, y, Math.sin(a) * r];
            // Tilt the belt about X.
            return add(c, [p[0], p[1] * Math.cos(tilt) - p[2] * Math.sin(tilt), p[1] * Math.sin(tilt) + p[2] * Math.cos(tilt)]);
        }
        if (spec.cloud) return add(pointOf(spec.cloud.center, keyed, holePos, scale), mul(rng.ball(), spec.cloud.radius * scale));
        if (spec.orbit) {
            const c = pointOf(spec.orbit.around, keyed, holePos, scale);
            const a = (index / Math.max(1, spec.count ?? 1)) * Math.PI * 2 + rng.range(0, 1);
            return add(c, [Math.cos(a) * spec.orbit.r * scale, 0, Math.sin(a) * spec.orbit.r * scale]);
        }
        return mul(rng.ball(), def.extent * scale);
    };

    // Keyed bodies first, in order, so belts and clouds can refer to them (and to holes).
    const ordered = [...def.bodies.filter(b => b.key), ...def.bodies.filter(b => !b.key)];
    for (const spec of ordered) {
        const n = spec.count ?? 1;
        for (let i = 0; i < n; i++) {
            const size = typeof spec.size === "number" ? spec.size : rng.range(spec.size[0], spec.size[1]);
            const radius = size * scale;
            const kind = spec.kind ?? kindOfRadius(radius);
            const look = spec.look ?? lookFor(kind, radius, rng);
            const name = spec.name ?? (kind === "mote" ? "" : NAMES_A[rng.int(0, NAMES_A.length - 1)] + NAMES_B[rng.int(0, NAMES_B.length - 1)]);
            const b = makeBody(region, kind, look, place(spec, i), radius, rng.next(), name, spec.key ?? "");
            b.inhabited = !!spec.inhabited;
            b.rings = !!spec.rings;
            if (kind === "mote") b.yield = 8;
            if (spec.key) keyed.set(spec.key, b);
            if (spec.orbit) {
                const around = keyed.get(spec.orbit.around);
                if (around) b.orbit = { around: around.id, r: spec.orbit.r * scale, speed: spec.orbit.speed ?? 0.05, phase: rng.range(0, 6.283), axis: [0, 1, 0] };
            }
            // Loose rubble tumbles slowly.
            if (!spec.key && kind !== "mote") b.vel = mul(rng.dir(), rng.range(0, 0.03) * scale);
        }
    }

    for (const h of def.holes ?? []) {
        region.holes.push({ id: region.nextId++, key: h.key, name: h.name, pos: mul(h.at, scale), vel: [0, 0, 0], radius: h.size * scale, hunts: (h.hunts ?? 0) * scale, alive: true, fed: 0, grazing: false });
    }
    if (def.rift) region.rift = { pos: mul(def.rift.at, scale), radius: def.rift.size * scale, open: true };

    const spawn = (spec: CreatureSpec) => {
        const n = spec.count ?? 1;
        const center = spec.near ? pointOf(spec.near, keyed, holePos, scale) : spec.at ? mul(spec.at, scale) : mul(rng.ball(), def.extent * scale * 0.6);
        const nearBody = spec.near ? keyed.get(spec.near) : undefined;
        for (let i = 0; i < n; i++) {
            const spread = (spec.spread ?? 0) * scale;
            let pos = center;
            if (spread > 0 || nearBody) {
                const d = rng.dir();
                // Never inside the body it keeps near.
                const min = nearBody ? nearBody.radius * 1.5 + SPECIES[spec.species].size * scale * (spec.boss ?? 1) : 0;
                pos = add(center, mul(d, min + rng.range(0.25, 1) * spread));
            }
            makeCreature(region, spec.species, pos, { faction: spec.faction, name: spec.name, boss: spec.boss, group: spec.group, key: n === 1 ? spec.key : undefined, phase: rng.next() });
        }
    };
    for (const spec of def.creatures) spawn(spec);
    return region;
}

/** Total mass (in newborn-nebula volumes) the region's bodies would yield, by kind. */
export function regionMass(region: Region): number {
    let m = 0;
    for (const b of region.bodies) if (!b.inhabited && b.kind !== "mote") m += massOfRadius(b.radius) * b.yield;
    return m;
}

/** A point `d` km from `from` on a circle about it, facing roughly at `toward` (wave arrivals). */
export function edgePoint(rng: Rng, toward: V3, d: number): V3 {
    const out = norm(rng.dir());
    const side = norm(cross(out, [0, 1, 0]), [1, 0, 0]);
    return add(toward, add(mul(out, d), mul(side, rng.range(-0.2, 0.2) * d)));
}
