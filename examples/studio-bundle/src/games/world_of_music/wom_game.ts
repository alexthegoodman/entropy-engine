// WORLD OF MUSIC - the simulation. Pure TypeScript: no engine calls, so tests play it directly.
//
// Agent Tom walks an island in third person with his swarms of Tones. The player points at
// something and clicks: the selected swarm goes to do the obvious thing there (fight it, break
// it, shake the fruit off it, sit on it, climb to it, walk through it, sing at it), and the
// selection moves on to the next swarm, so the next click sends the next swarm. Tones are run by
// a small state machine each; enemies are run by WIR networks (wom_wir.ts) on a grid over each
// patch of the Red Corruption.

import {
    BOSSES, ENEMIES, LEVELS, MAX_SWARM, MAX_SWARMS, NPCS, PALETTE, REVIVE_TIME, REVIVE_WINDOW, SPECIES, SPLIT_AT, JAM_PHRASES, SONGS,
    levelById, toneStats, traitPrice, traitRank, TRAITS,
    type DarkDef, type EnemyId, type LevelDef, type RGB, type SpeciesId, type ToneStats, type TraitId,
} from "./wom_data";
import { Terrain, WALKER, DEEP, MAX_GRADE, type Mover, segDist } from "./wom_terrain";
import { WirArena, HOLD, type ArenaAgent } from "./wom_wir";
import { WIR_DATA } from "./wom_wir_data";
import { clamp, type V3 } from "../nebula/nk_math";

// --- the campaign (what is saved) -----------------------------------------------------------

export interface SwarmSave { species: SpeciesId; traits: Partial<Record<TraitId, number>>; tones: number; growth: number[] }
export interface Campaign {
    v: 1;
    level: string;
    completed: string[];
    chimes: number;
    relics: number;
    swarms: SwarmSave[];
    unlocked: SpeciesId[];
    songs: string[];
    jams: string[];
    lessons: string[];
    links: string[];
    ended: boolean;
    stats: { purified: number; defeated: number; fed: number; splits: number; revived: number; lost: number; crates: number; sold: number };
}

export function newCampaign(): Campaign {
    return {
        v: 1, level: LEVELS[0].id, completed: [], chimes: 0, relics: 0,
        swarms: (["thrum", "zing", "hop"] as SpeciesId[]).map(species => ({ species, traits: {}, tones: 3, growth: [0, 0, 0] })),
        unlocked: ["thrum", "zing", "hop"], songs: [], jams: [], lessons: [], links: [], ended: false,
        stats: { purified: 0, defeated: 0, fed: 0, splits: 0, revived: 0, lost: 0, crates: 0, sold: 0 },
    };
}

export function normalizeCampaign(c: Partial<Campaign>): Campaign {
    const base = newCampaign();
    const out = { ...base, ...c, stats: { ...base.stats, ...(c.stats ?? {}) } } as Campaign;
    if (!LEVELS.some(l => l.id === out.level)) out.level = base.level;
    if (!Array.isArray(out.swarms) || !out.swarms.length) out.swarms = base.swarms;
    out.swarms = out.swarms.filter(s => SPECIES[s.species]).map(s => ({ species: s.species, traits: { ...(s.traits ?? {}) }, tones: Math.max(1, Math.min(MAX_SWARM, s.tones | 0)), growth: Array.from({ length: Math.max(1, Math.min(MAX_SWARM, s.tones | 0)) }, (_, i) => s.growth?.[i] ?? 0) }));
    return out;
}

// --- input ----------------------------------------------------------------------------------

export interface WomInput {
    /** Walk direction in world x / z (already turned by the camera), length <= 1. */
    moveX: number; moveZ: number;
    jump: boolean;
    /** Camera: yaw change (radians) and zoom steps. */
    turn: number; zoom: number;
    /** The ground point under the pointer (null when it points at the sky). */
    cursor: V3 | null;
    direct: boolean;
    recall: boolean;
    gather: boolean;
    select: number | null;
    selectNext: boolean;
    selectPrev: boolean;
    divide: boolean;
    talk: boolean;
    /** A Prism Pipe note (0-4) played this frame, or -1. */
    note: number;
}
export const NO_INPUT: WomInput = { moveX: 0, moveZ: 0, jump: false, turn: 0, zoom: 0, cursor: null, direct: false, recall: false, gather: false, select: null, selectNext: false, selectPrev: false, divide: false, talk: false, note: -1 };

// --- state ----------------------------------------------------------------------------------

export type OrderKind = "follow" | "move" | "attack" | "crate" | "tree" | "heart" | "anchor" | "lever" | "revive" | "boss" | "npc";
export interface Order { kind: OrderKind; x: number; z: number; ref: number; label: string }

export interface Tone {
    id: number; swarm: number; species: SpeciesId;
    pos: V3; vel: V3; yaw: number;
    hp: number; growth: number;
    state: "ok" | "faded";
    fadedFor: number; revive: number;
    sing: number; attackCd: number; hop: number;
    /** A relic or fruit it is carrying home (fruit is eaten on the spot instead). */
    carrying: number;
    slot: number;
    stuck: number; path: [number, number][] | null; pathI: number; pathAt: number;
    /** Just split from another (for the pop). */
    born: number;
    hurt: number;
}

export interface Swarm {
    id: number; species: SpeciesId; traits: Partial<Record<TraitId, number>>;
    stats: ToneStats; mover: Mover;
    order: Order;
    anchor: [number, number];
    path: [number, number][] | null; pathI: number;
    unreachable: number;
    /** Seconds since the last order (the HUD flashes the card). */
    ordered: number;
    /** Fruit eaten toward the next split (the swarm shares it). */
    food: number;
}

export interface Enemy {
    id: number; kind: EnemyId; dark: number;
    pos: V3; yaw: number; hp: number; maxHp: number;
    alive: boolean; deadFor: number; minion: boolean;
    agent: ArenaAgent;
    /** Cell it is walking to (from the brain's heading). */
    goal: [number, number];
    attackCd: number; hurt: number; lunge: number;
}

export interface Bolt { pos: V3; vel: V3; damage: number; life: number; foe: boolean; color: RGB; size: number }
export interface Pickup { kind: "fruit" | "relic"; pos: V3; vel: V3; taken: boolean; age: number }
export interface Pulse { x: number; z: number; t: number; color: RGB; strength: number; reach: number; speed: number }

export interface Dark {
    def: DarkDef; idx: number;
    heart: number; heartMax: number;
    purified: boolean; radius: number;
    arena: WirArena;
    tick: number; engaged: boolean;
    boss: Boss | null;
    singing: number;
}
export interface Boss {
    id: string; pos: V3; yaw: number; hp: number; maxHp: number; size: number;
    anchors: { x: number; z: number; hp: number; max: number }[];
    slamIn: number; slam: number; summonIn: number; stomp: number; alive: boolean; hurt: number;
}
export interface CrateState { x: number; z: number; y: number; hp: number; max: number; broken: boolean; relics: number; fruit: number; big: boolean; shake: number }
export interface TreeState { x: number; z: number; y: number; fruit: number; max: number; regrow: number; shake: number }
export interface GateState { id: string; x: number; z: number; len: number; angle: number; open: boolean; lift: number; y: number; light: number }
export interface SwitchState { id: string; x: number; z: number; y: number; weight: number; need: number; gate: string }
export interface LeverState { id: string; x: number; z: number; y: number; flipped: boolean; gate: string }
export interface NpcState { id: string; x: number; z: number; y: number; face: number; line: number; talking: number; play: number; note: number }
export interface Jam { npc: string; phrase: number; step: "listen" | "echo" | "done"; t: number; input: number[]; shown: number; fails: number }

export type GameEvent =
    | { kind: "chirp"; species: SpeciesId; at: V3; note: number }
    | { kind: "npcNote"; npc: string; instrument: string; midi: number; at: V3 }
    | { kind: "hit"; at: V3; foe: boolean; color: RGB }
    | { kind: "shot"; at: V3; foe: boolean }
    | { kind: "fade"; at: V3; species: SpeciesId }
    | { kind: "revived"; at: V3; species: SpeciesId }
    | { kind: "passed"; at: V3; species: SpeciesId }
    | { kind: "ate"; at: V3; species: SpeciesId }
    | { kind: "split"; at: V3; species: SpeciesId; size: number }
    | { kind: "crate"; at: V3 }
    | { kind: "relic"; at: V3; total: number }
    | { kind: "defeated"; at: V3; name: string; big: boolean }
    | { kind: "purified"; at: V3; name: string; freed: SpeciesId | null }
    | { kind: "anchor"; at: V3; left: number }
    | { kind: "gate"; id: string; open: boolean; at: V3 }
    | { kind: "lever"; at: V3 }
    | { kind: "portal"; at: V3 }
    | { kind: "slam"; at: V3; radius: number }
    | { kind: "tomHurt"; amount: number }
    | { kind: "tomDown" }
    | { kind: "order"; swarm: number; label: string; ok: boolean }
    | { kind: "select"; swarm: number }
    | { kind: "jam"; what: "start" | "note" | "ok" | "fail" | "done"; npc: string; note?: number }
    | { kind: "pipe"; note: number; at: V3 }
    | { kind: "song"; id: string }
    | { kind: "link"; text: string }
    | { kind: "say"; npc: string; text: string }
    | { kind: "lesson"; id: string }
    | { kind: "toast"; text: string }
    | { kind: "levelComplete"; level: string; next: string | null }
    | { kind: "exitOpen" }
    | { kind: "ending" };

export interface Tom { pos: V3; vel: V3; yaw: number; onGround: boolean; hp: number; maxHp: number; down: number; hurt: number; walk: number; lastSafe: V3 }

const TOM_SPEED = 7.5, GRAVITY = 24, JUMP = 8.6;
const ARENA_CELL = 1.5, ARENA_TICK = 0.3;
const RELIC_VALUE = 10;

let ids = 1;

export class Game {
    campaign: Campaign;
    level!: LevelDef;
    terrain!: Terrain;
    time = 0;
    tom!: Tom;
    camYaw = 0;
    camDist = 13;
    swarms: Swarm[] = [];
    tones: Tone[] = [];
    selected = 0;
    enemies: Enemy[] = [];
    darks: Dark[] = [];
    bolts: Bolt[] = [];
    pickups: Pickup[] = [];
    pulses: Pulse[] = [];
    crates: CrateState[] = [];
    trees: TreeState[] = [];
    gates: GateState[] = [];
    switches: SwitchState[] = [];
    levers: LeverState[] = [];
    npcs: NpcState[] = [];
    jam: Jam | null = null;
    exitOpen = false;
    complete = false;
    events: GameEvent[] = [];
    /** What the pointer rests on (HUD label and the order a click would give). */
    hover: Order | null = null;
    cursor: V3 | null = null;
    /** Seconds left of a pipe note glow per note (HUD). */
    pipeGlow = [0, 0, 0, 0, 0];
    pipeRecent: number[] = [];
    private chirpBudget = 0;

    constructor(c: Campaign = newCampaign()) {
        this.campaign = normalizeCampaign(JSON.parse(JSON.stringify(c)));
        this.loadLevel(this.campaign.level);
    }

    // --- setup -----------------------------------------------------------------------------

    loadLevel(id: string): void {
        this.level = levelById(id);
        this.campaign.level = this.level.id;
        this.terrain = new Terrain(this.level);
        const L = this.level, T = this.terrain;
        const [sx, sz] = L.spawn;
        this.tom = { pos: [sx, T.surface(sx, sz), sz], vel: [0, 0, 0], yaw: Math.PI, onGround: true, hp: 100, maxHp: 100, down: 0, hurt: 0, walk: 0, lastSafe: [sx, T.surface(sx, sz), sz] };
        this.camYaw = Math.PI;
        this.gates = L.gates.map(g => ({ ...g, open: false, lift: 0, y: T.height(g.x, g.z), light: 0 }));
        this.switches = L.switches.map(s => ({ id: s.id, x: s.x, z: s.z, y: T.surface(s.x, s.z), weight: 0, need: s.weight, gate: s.gate }));
        this.levers = L.levers.map(l => ({ id: l.id, x: l.x, z: l.z, y: T.surface(l.x, l.z), flipped: false, gate: l.gate }));
        this.crates = L.crates.map(c => ({ x: c.x, z: c.z, y: T.surface(c.x, c.z), hp: c.big ? 60 : 24, max: c.big ? 60 : 24, broken: false, relics: c.relics, fruit: c.fruit, big: !!c.big, shake: 0 }));
        this.trees = L.trees.map(t => ({ x: t.x, z: t.z, y: T.surface(t.x, t.z), fruit: t.fruit, max: t.fruit, regrow: 0, shake: 0 }));
        this.npcs = L.npcs.map(n => ({ id: n.id, x: n.x, z: n.z, y: T.surface(n.x, n.z), face: n.face ?? 0, line: 0, talking: 0, play: 1 + (n.x % 3 + 3) % 3, note: 0 }));
        this.syncBlockers();
        this.enemies = [];
        this.darks = L.dark.map((d, idx) => this.makeDark(d, idx));
        this.bolts = []; this.pickups = []; this.pulses = [];
        this.exitOpen = false; this.complete = false; this.jam = null;
        this.buildSwarms();
        this.link("start");
        this.lesson("direct");
    }

    private makeDark(d: DarkDef, idx: number): Dark {
        const span = d.r + 10, cells = Math.ceil((2 * span) / ARENA_CELL);
        const arena = new WirArena(WIR_DATA, cells, cells, d.x - span, d.z - span, ARENA_CELL);
        const dark: Dark = { def: d, idx, heart: d.heart, heartMax: d.heart, purified: false, radius: d.r, arena, tick: Math.random() * ARENA_TICK, engaged: false, boss: null, singing: 0 };
        this.paintArena(dark);
        let k = 0;
        for (const group of d.enemies) for (let i = 0; i < group.n; i++) this.spawnEnemy(dark, group.kind, k++, false);
        if (d.boss) {
            const b = BOSSES[d.boss];
            const anchors = Array.from({ length: b.anchors }, (_, i) => {
                const a = (i / b.anchors) * Math.PI * 2 + 0.4;
                return { x: d.x + Math.cos(a) * d.r * 0.72, z: d.z + Math.sin(a) * d.r * 0.72, hp: 45, max: 45 };
            });
            dark.boss = { id: b.id, pos: [d.x, this.terrain.surface(d.x, d.z), d.z], yaw: 0, hp: b.hp, maxHp: b.hp, size: b.size, anchors, slamIn: 5, slam: -1, summonIn: 10, stomp: 0, alive: true, hurt: 0 };
        }
        return dark;
    }

    /** Arena walls: cells an enemy cannot stand on (cliffs, deep water, other heights, closed gates). */
    private paintArena(d: Dark): void {
        const A = d.arena, T = this.terrain, h0 = T.height(d.def.x, d.def.z);
        for (let r = 0; r < A.rows; r++) for (let c = 0; c < A.cols; c++) {
            const [x, z] = A.center(r, c);
            const h = T.height(x, z);
            const off = !T.inBounds(x, z) || h < DEEP || T.grade(x, z) > MAX_GRADE || Math.abs(h - h0) > 3.2 || Math.hypot(x - d.def.x, z - d.def.z) > d.def.r + 9;
            let gate = false;
            for (const g of this.gates) if (!g.open && segDist(x, z, g.x - Math.cos(g.angle) * g.len / 2, g.z - Math.sin(g.angle) * g.len / 2, g.x + Math.cos(g.angle) * g.len / 2, g.z + Math.sin(g.angle) * g.len / 2) < 1.2) gate = true;
            A.wall[r * A.cols + c] = off || gate ? 1 : 0;
        }
    }

    private spawnEnemy(d: Dark, kind: EnemyId, k: number, minion: boolean, at?: [number, number]): Enemy {
        const def = ENEMIES[kind], A = d.arena;
        const a = k * 2.399 + d.idx;
        const px = at ? at[0] : d.def.x + Math.cos(a) * d.def.r * (0.25 + 0.5 * ((k * 0.37) % 1));
        const pz = at ? at[1] : d.def.z + Math.sin(a) * d.def.r * (0.25 + 0.5 * ((k * 0.37) % 1));
        const [r, c] = A.nearestOpen(...A.cellOf(px, pz));
        const [x, z] = A.center(r, c);
        const e: Enemy = {
            id: ids++, kind, dark: d.idx, pos: [x, this.terrain.surface(x, z), z], yaw: a, hp: def.hp, maxHp: def.hp, alive: true, deadFor: 0, minion,
            agent: { r, c, option: HOLD, hp: 12, ammo: WIR_DATA.consts.ammo, cool: 0, reload: 0, brain: def.brain }, goal: [r, c], attackCd: 0, hurt: 0, lunge: 0,
        };
        this.enemies.push(e);
        return e;
    }

    private buildSwarms(): void {
        this.swarms = []; this.tones = [];
        const [sx, sz] = this.level.spawn;
        this.campaign.swarms.forEach((s, i) => {
            const sw = this.makeSwarm(s.species, s.traits);
            sw.food = s.growth[0] ?? 0;
            for (let k = 0; k < s.tones; k++) this.addTone(sw, [sx + (i - 1) * 2 + Math.cos(k) * 0.8, 0, sz + 3 + Math.sin(k) * 0.8], 0);
        });
        this.selected = 0;
    }

    private makeSwarm(species: SpeciesId, traits: Partial<Record<TraitId, number>>): Swarm {
        const stats = toneStats(species, traits);
        const sw: Swarm = { id: this.swarms.length, species, traits: { ...traits }, stats, mover: { climb: stats.climb, fly: stats.fly, phase: stats.phase }, order: { kind: "follow", x: 0, z: 0, ref: -1, label: "Following" }, anchor: [this.tom.pos[0], this.tom.pos[2]], path: null, pathI: 0, unreachable: 0, ordered: 9, food: 0 };
        this.swarms.push(sw);
        return sw;
    }

    private addTone(sw: Swarm, at: V3, growth = 0, born = 0): Tone {
        const t: Tone = {
            id: ids++, swarm: sw.id, species: sw.species, pos: [at[0], this.terrain.surface(at[0], at[2]), at[2]], vel: [0, 0, 0], yaw: 0,
            hp: sw.stats.hp, growth, state: "ok", fadedFor: 0, revive: 0, sing: 1 + Math.random() * 4, attackCd: Math.random(), hop: Math.random() * 6,
            carrying: 0, slot: this.tonesOf(sw).length, stuck: 0, path: null, pathI: 0, pathAt: -9, born, hurt: 0,
        };
        this.tones.push(t);
        return t;
    }

    /** Brings the campaign's swarm list up to date with the field (on save). */
    syncCampaign(): Campaign {
        this.campaign.swarms = this.swarms.map(s => {
            const ts = this.tonesOf(s).filter(t => t.state === "ok" || t.fadedFor < REVIVE_WINDOW);
            return { species: s.species, traits: { ...s.traits }, tones: Math.max(1, ts.length), growth: [s.food, ...ts.slice(1).map(t => t.growth)] };
        }).filter((_, i) => this.tonesOf(this.swarms[i]).length > 0);
        return this.campaign;
    }

    // --- queries ---------------------------------------------------------------------------

    tonesOf(s: Swarm): Tone[] { return this.tones.filter(t => t.swarm === s.id); }
    liveTones(s: Swarm): Tone[] { return this.tones.filter(t => t.swarm === s.id && t.state === "ok"); }
    get selectedSwarm(): Swarm | null { return this.swarms[this.selected] ?? null; }
    darkAt(x: number, z: number): Dark | null {
        for (const d of this.darks) if (!d.purified && Math.hypot(x - d.def.x, z - d.def.z) < d.radius) return d;
        return null;
    }
    corruption(x: number, z: number): number {
        let c = 0;
        for (const d of this.darks) if (d.radius > 0.1) c = Math.max(c, clamp(1 - Math.hypot(x - d.def.x, z - d.def.z) / d.radius) ** 0.5);
        return c;
    }
    near(a: { x: number; z: number } | V3, r: number): boolean {
        const ax = Array.isArray(a) ? a[0] : a.x, az = Array.isArray(a) ? a[2] : a.z;
        return Math.hypot(ax - this.tom.pos[0], az - this.tom.pos[2]) < r;
    }
    npcNear(r = 5): NpcState | null {
        let best: NpcState | null = null, bd = r;
        for (const n of this.npcs) { const d = Math.hypot(n.x - this.tom.pos[0], n.z - this.tom.pos[2]); if (d < bd) { bd = d; best = n; } }
        return best;
    }
    get hearts(): { left: number; total: number } { return { left: this.darks.filter(d => !d.purified).length, total: this.darks.length }; }

    // --- the frame -------------------------------------------------------------------------

    step(dt: number, input: WomInput): void {
        dt = Math.min(dt, 0.1);
        this.time += dt;
        this.cursor = input.cursor;
        this.stepTom(dt, input);
        this.stepCommands(input);
        this.stepWorld(dt);
        for (const s of this.swarms) this.stepSwarm(s, dt);
        for (const t of this.tones) this.stepTone(t, dt);
        this.stepSplits();
        for (const d of this.darks) this.stepDark(d, dt);
        this.stepEnemies(dt);
        this.stepBolts(dt);
        this.stepPickups(dt);
        this.stepNpcs(dt, input);
        this.stepPulses(dt);
        this.hover = input.cursor ? this.targetAt(input.cursor) : null;
        for (let i = 0; i < 5; i++) this.pipeGlow[i] = Math.max(0, this.pipeGlow[i] - dt);
    }

    private stepTom(dt: number, input: WomInput): void {
        const tom = this.tom, T = this.terrain;
        this.camYaw += input.turn;
        this.camDist = clamp(this.camDist - input.zoom * 1.5, 7, 24);
        if (tom.down > 0) {
            tom.down -= dt;
            if (tom.down <= 0) {
                const [sx, sz] = this.respawnPoint();
                tom.pos = [sx, T.surface(sx, sz), sz]; tom.vel = [0, 0, 0]; tom.hp = tom.maxHp;
                for (const s of this.swarms) this.recall(s);
                for (const t of this.tones) if (t.state === "ok") { t.pos = [sx + (Math.random() - 0.5) * 4, 0, sz + 2 + Math.random() * 3]; t.pos[1] = T.surface(t.pos[0], t.pos[2]); }
                this.say("toast", "The Link pulls you back together.");
            }
            return;
        }
        const mx = input.moveX, mz = input.moveZ, ml = Math.hypot(mx, mz);
        const speed = TOM_SPEED * (this.jam ? 0 : 1);
        const want: V3 = [mx * speed, 0, mz * speed];
        const k = Math.min(1, dt * (tom.onGround ? 12 : 3));
        tom.vel[0] += (want[0] - tom.vel[0]) * k;
        tom.vel[2] += (want[2] - tom.vel[2]) * k;
        if (ml > 0.1) tom.yaw = Math.atan2(mx, mz);
        if (input.jump && tom.onGround && !this.jam) { tom.vel[1] = JUMP; tom.onGround = false; }
        tom.vel[1] -= GRAVITY * dt;
        // Horizontal: step if the ground allows it (gates and cliffs stop Tom; drops do not).
        const nx = tom.pos[0] + tom.vel[0] * dt, nz = tom.pos[2] + tom.vel[2] * dt;
        const ground = (x: number, z: number) => T.surface(x, z);
        const feet = tom.pos[1];
        const ok = (x: number, z: number) => {
            if (!T.inBounds(x, z) || T.gateBlocks(tom.pos[0], tom.pos[2], x, z, 0.7)) return false;
            if (T.height(x, z) < DEEP - 0.6) return false;
            return ground(x, z) <= feet + 0.55 + Math.max(0, tom.vel[1]) * dt * 2 || T.canStep(tom.pos[0], tom.pos[2], x, z, WALKER) && ground(x, z) < feet + 1.2;
        };
        if (ok(nx, nz)) { tom.pos[0] = nx; tom.pos[2] = nz; }
        else if (ok(nx, tom.pos[2])) { tom.pos[0] = nx; tom.vel[2] = 0; }
        else if (ok(tom.pos[0], nz)) { tom.pos[2] = nz; tom.vel[0] = 0; }
        else { tom.vel[0] = 0; tom.vel[2] = 0; }
        tom.pos[1] += tom.vel[1] * dt;
        const g = ground(tom.pos[0], tom.pos[2]);
        if (tom.pos[1] <= g) { tom.pos[1] = g; tom.vel[1] = 0; tom.onGround = true; } else tom.onGround = tom.pos[1] - g < 0.05;
        tom.walk += Math.hypot(tom.vel[0], tom.vel[2]) * dt;
        tom.hurt = Math.max(0, tom.hurt - dt);
        if (tom.onGround && T.height(tom.pos[0], tom.pos[2]) > 0 && !this.darkAt(tom.pos[0], tom.pos[2])) tom.lastSafe = [...tom.pos];
        // Out of the fight, Tom mends.
        if (this.time - this.lastHurtAt > 6) tom.hp = Math.min(tom.maxHp, tom.hp + dt * 6);
    }
    private lastHurtAt = -99;

    private respawnPoint(): [number, number] {
        let best = this.level.spawn;
        for (const d of this.darks) if (d.purified) best = [d.def.x, d.def.z + 3];
        return best;
    }

    hurtTom(amount: number): void {
        const tom = this.tom;
        if (tom.down > 0) return;
        tom.hp -= amount; tom.hurt = 0.4; this.lastHurtAt = this.time;
        this.events.push({ kind: "tomHurt", amount });
        if (tom.hp <= 0) { tom.hp = 0; tom.down = 3; this.events.push({ kind: "tomDown" }); this.lesson("down"); }
    }

    // --- commands --------------------------------------------------------------------------

    private stepCommands(input: WomInput): void {
        const n = this.swarms.length;
        if (!n) return;
        if (input.select !== null && input.select < n) { this.selected = input.select; this.events.push({ kind: "select", swarm: this.selected }); }
        if (input.selectNext) { this.selected = this.nextSwarm(this.selected, 1); this.events.push({ kind: "select", swarm: this.selected }); }
        if (input.selectPrev) { this.selected = this.nextSwarm(this.selected, -1); this.events.push({ kind: "select", swarm: this.selected }); }
        if (input.direct && input.cursor && !this.jam) this.direct(input.cursor);
        if (input.recall && this.selectedSwarm) { this.recall(this.selectedSwarm); this.events.push({ kind: "order", swarm: this.selected, label: "Recalled", ok: true }); }
        if (input.gather) this.gather();
        if (input.divide) this.divide();
    }

    /** The next swarm that has a Tone standing (skipping ones that are all faded). */
    nextSwarm(from: number, dir: number): number {
        const n = this.swarms.length;
        for (let k = 1; k <= n; k++) {
            const i = (((from + dir * k) % n) + n) % n;
            if (this.liveTones(this.swarms[i]).length) return i;
        }
        return from;
    }

    /** What a click at `p` would order: the most specific thing near the point. */
    targetAt(p: V3): Order {
        const x = p[0], z = p[2];
        const d2 = (ax: number, az: number) => Math.hypot(ax - x, az - z);
        let best: Order | null = null, bd = Infinity;
        const consider = (kind: OrderKind, ax: number, az: number, r: number, ref: number, label: string) => {
            const d = d2(ax, az);
            if (d < r && d - r * 0.3 < bd) { bd = d - r * 0.3; best = { kind, x: ax, z: az, ref, label }; }
        };
        for (const e of this.enemies) if (e.alive) consider("attack", e.pos[0], e.pos[2], 2.2 + ENEMIES[e.kind].size, e.id, ENEMIES[e.kind].name);
        for (const d of this.darks) {
            if (d.purified) continue;
            if (d.boss?.alive) {
                d.boss.anchors.forEach((a, i) => { if (a.hp > 0) consider("anchor", a.x, a.z, 3.2, d.idx * 16 + i, "Corrupt anchor"); });
                consider("boss", d.boss.pos[0], d.boss.pos[2], d.boss.size * 0.9, d.idx, BOSSES[d.boss.id].name);
            } else consider("heart", d.def.x, d.def.z, 3.4, d.idx, `Heart of ${d.def.name}`);
        }
        this.crates.forEach((c, i) => { if (!c.broken) consider("crate", c.x, c.z, c.big ? 2.6 : 2, i, c.big ? "Big crate" : "Crate"); });
        this.trees.forEach((t, i) => consider("tree", t.x, t.z, 3.2, i, t.fruit > 0 ? `Fruit tree (${t.fruit})` : "Fruit tree (bare)"));
        this.levers.forEach((l, i) => { if (!l.flipped) consider("lever", l.x, l.z, 2.4, i, "Lever"); });
        this.tones.forEach(t => { if (t.state === "faded") consider("revive", t.pos[0], t.pos[2], 1.6, t.id, `Fallen ${SPECIES[t.species].name}`); });
        this.npcs.forEach((n, i) => consider("npc", n.x, n.z, 2.2, i, NPCS[n.id].name));
        if (best) return best;
        const sw = this.switches.find(s => d2(s.x, s.z) < 2.6);
        if (sw) return { kind: "move", x: sw.x, z: sw.z, ref: -1, label: `Switch (${sw.need} weight)` };
        const portal = this.level.portals.find(pt => d2(pt.a[0], pt.a[1]) < 2.6 || d2(pt.b[0], pt.b[1]) < 2.6);
        if (portal) { const far = d2(portal.a[0], portal.a[1]) < 2.6 ? portal.b : portal.a; return { kind: "move", x: far[0], z: far[1], ref: -1, label: "Through the ring" }; }
        return { kind: "move", x, z, ref: -1, label: this.terrain.climbable(x, z) ? "Climb here" : "Go here" };
    }

    /** The point-and-click: the selected swarm goes, and the selection moves on. */
    direct(p: V3): boolean {
        const sw = this.selectedSwarm;
        if (!sw || !this.liveTones(sw).length) { this.selected = this.nextSwarm(this.selected, 1); return false; }
        const order = this.targetAt(p);
        const ok = this.give(sw, order);
        this.events.push({ kind: "order", swarm: sw.id, label: ok ? order.label : `Can't reach: ${order.label}`, ok });
        if (ok) {
            const next = this.nextSwarm(this.selected, 1);
            if (next !== this.selected) { this.selected = next; this.events.push({ kind: "select", swarm: next }); this.lesson("autoselect"); }
        }
        return ok;
    }

    give(sw: Swarm, order: Order): boolean {
        if (order.kind === "npc") order = { ...order, kind: "move", label: `Listening to ${order.label}` };
        const [cx, cz] = this.swarmCenter(sw);
        let tx = order.x, tz = order.z;
        if (order.kind === "move" && this.terrain.height(tx, tz) < DEEP && !sw.mover.fly) {
            this.lesson("water");
            return false;
        }
        // Path to a stand-off point for things that are solid.
        const path = this.terrain.findPath([cx, cz], [tx, tz], sw.mover, this.level.portals) ?? this.terrain.findPath([cx, cz], this.approachPoint(sw, tx, tz), sw.mover, this.level.portals);
        if (!path) {
            sw.unreachable = 2;
            if (this.terrain.climbable(tx, tz) || this.levers.some(l => Math.hypot(l.x - tx, l.z - tz) < 3)) this.lesson("climb");
            else if (this.level.portals.length) this.lesson("portal");
            return false;
        }
        sw.order = order; sw.path = path; sw.pathI = 0; sw.ordered = 0; sw.unreachable = 0;
        for (const t of this.liveTones(sw)) { t.path = null; t.stuck = 0; }
        if (order.kind === "tree") this.lesson("fruit");
        if (order.kind === "crate") this.lesson("crate");
        if (this.switches.some(s => Math.hypot(s.x - tx, s.z - tz) < 2.6)) this.lesson("switch");
        return true;
    }

    private approachPoint(sw: Swarm, x: number, z: number): [number, number] {
        const [cx, cz] = this.swarmCenter(sw);
        const d = Math.hypot(x - cx, z - cz) || 1;
        return [x + ((cx - x) / d) * 3, z + ((cz - z) / d) * 3];
    }

    recall(sw: Swarm): void { sw.order = { kind: "follow", x: 0, z: 0, ref: -1, label: "Following" }; sw.path = null; sw.ordered = 0; for (const t of this.tonesOf(sw)) t.path = null; }

    gather(): boolean {
        if (!this.campaign.songs.includes("gathering")) { this.lesson("gathering"); return false; }
        for (const s of this.swarms) this.recall(s);
        for (const t of this.tones) if (t.state === "ok") t.hp = Math.min(this.swarms[t.swarm].stats.hp, t.hp + this.swarms[t.swarm].stats.hp * 0.25);
        this.events.push({ kind: "song", id: "gathering" });
        this.pulse(this.tom.pos[0], this.tom.pos[2], [1, 1, 1], 1, 40, 22);
        return true;
    }

    /** Splits the selected swarm in half (it needs six Tones): two swarms for two switches. */
    divide(): boolean {
        const sw = this.selectedSwarm;
        if (!sw || this.swarms.length >= MAX_SWARMS) return false;
        const live = this.liveTones(sw);
        if (live.length < 6) { this.say("toast", "A swarm needs six Tones to divide"); return false; }
        const ns = this.makeSwarm(sw.species, sw.traits);
        live.slice(live.length >> 1).forEach((t, i) => { t.swarm = ns.id; t.slot = i; t.path = null; });
        this.tonesOf(sw).forEach((t, i) => { t.slot = i; });
        this.say("toast", `The ${SPECIES[sw.species].name}s divide: two swarms now`);
        return true;
    }

    swarmCenter(sw: Swarm): [number, number] {
        const ts = this.liveTones(sw);
        if (!ts.length) return [this.tom.pos[0], this.tom.pos[2]];
        let x = 0, z = 0;
        for (const t of ts) { x += t.pos[0]; z += t.pos[2]; }
        return [x / ts.length, z / ts.length];
    }

    // --- swarms and Tones ------------------------------------------------------------------

    private stepSwarm(sw: Swarm, dt: number): void {
        sw.ordered += dt;
        sw.unreachable = Math.max(0, sw.unreachable - dt);
        const tom = this.tom, o = sw.order;
        if (o.kind === "follow") {
            // A loose arc behind Tom, one cluster per swarm.
            const i = sw.id, n = Math.max(1, this.swarms.length);
            const a = tom.yaw + Math.PI + (i - (n - 1) / 2) * 0.55;
            sw.anchor = [tom.pos[0] + Math.sin(a) * (3.2 + (i % 2) * 1.2), tom.pos[2] + Math.cos(a) * (3.2 + (i % 2) * 1.2)];
            return;
        }
        // Move the anchor along the path; it waits for the slowest Tone.
        if (sw.path && sw.pathI < sw.path.length) {
            const [wx, wz] = sw.path[sw.pathI];
            const dx = wx - sw.anchor[0], dz = wz - sw.anchor[1], d = Math.hypot(dx, dz);
            const lag = this.liveTones(sw).reduce((m, t) => Math.max(m, Math.hypot(t.pos[0] - sw.anchor[0], t.pos[2] - sw.anchor[1])), 0);
            const v = sw.stats.speed * (lag > 6 ? 0.3 : 1) * dt;
            if (d > 8 && sw.mover.phase && this.portalNear(sw.anchor[0], sw.anchor[1])) {
                sw.anchor = [wx, wz]; sw.pathI++;
                for (const t of this.liveTones(sw)) { t.pos = [wx + (Math.random() - 0.5) * 2, this.terrain.surface(wx, wz), wz + (Math.random() - 0.5) * 2]; }
                this.events.push({ kind: "portal", at: [wx, this.terrain.surface(wx, wz), wz] });
            } else if (d <= v) { sw.anchor = [wx, wz]; sw.pathI++; }
            else { sw.anchor = [sw.anchor[0] + (dx / d) * v, sw.anchor[1] + (dz / d) * v]; }
        }
        // Orders that end when their thing is gone.
        const done = (): boolean => {
            switch (o.kind) {
                case "attack": return !this.enemies.some(e => e.id === o.ref && e.alive);
                case "crate": return this.crates[o.ref]?.broken ?? true;
                case "tree": return (this.trees[o.ref]?.fruit ?? 0) <= 0 && !this.pickups.some(p => p.kind === "fruit" && !p.taken && Math.hypot(p.pos[0] - o.x, p.pos[2] - o.z) < 6);
                case "heart": return this.darks[o.ref]?.purified ?? true;
                case "anchor": { const d = this.darks[Math.floor(o.ref / 16)]; return !d?.boss || d.boss.anchors[o.ref % 16].hp <= 0; }
                case "boss": return !this.darks[o.ref]?.boss?.alive;
                case "lever": return this.levers[o.ref]?.flipped ?? true;
                case "revive": return !this.tones.some(t => t.id === o.ref && t.state === "faded");
                default: return false;
            }
        };
        if (done()) {
            // Keep fighting what is near, else hold here (a carried relic brings them home).
            const next = this.nearestEnemy(sw.anchor[0], sw.anchor[1], 12);
            if (next && o.kind === "attack") { sw.order = { kind: "attack", x: next.pos[0], z: next.pos[2], ref: next.id, label: ENEMIES[next.kind].name }; return; }
            const carrying = this.liveTones(sw).some(t => t.carrying > 0);
            if (carrying) this.recall(sw);
            else sw.order = { kind: "move", x: sw.anchor[0], z: sw.anchor[1], ref: -1, label: "Holding" };
        }
        if (o.kind === "attack") { const e = this.enemies.find(x => x.id === o.ref); if (e && Math.hypot(e.pos[0] - sw.anchor[0], e.pos[2] - sw.anchor[1]) > 2 && (!sw.path || sw.pathI >= sw.path.length)) sw.anchor = this.stepToward(sw, e.pos[0], e.pos[2], dt); }
        if (o.kind === "boss") { const b = this.darks[o.ref]?.boss; if (b && (!sw.path || sw.pathI >= sw.path.length)) sw.anchor = this.stepToward(sw, b.pos[0], b.pos[2], dt, b.size * 0.8); }
    }

    private stepToward(sw: Swarm, x: number, z: number, dt: number, stop = 1.5): [number, number] {
        const [ax, az] = sw.anchor, d = Math.hypot(x - ax, z - az);
        if (d < stop) return sw.anchor;
        const v = Math.min(d - stop, sw.stats.speed * dt);
        const nx = ax + ((x - ax) / d) * v, nz = az + ((z - az) / d) * v;
        return this.terrain.canStep(ax, az, nx, nz, sw.mover) ? [nx, nz] : sw.anchor;
    }

    private portalNear(x: number, z: number): boolean {
        return this.level.portals.some(p => Math.hypot(p.a[0] - x, p.a[1] - z) < 4 || Math.hypot(p.b[0] - x, p.b[1] - z) < 4);
    }

    nearestEnemy(x: number, z: number, r: number): Enemy | null {
        let best: Enemy | null = null, bd = r;
        for (const e of this.enemies) if (e.alive) { const d = Math.hypot(e.pos[0] - x, e.pos[2] - z); if (d < bd) { bd = d; best = e; } }
        return best;
    }

    private stepTone(t: Tone, dt: number): void {
        const sw = this.swarms[t.swarm];
        t.born = Math.max(0, t.born - dt);
        t.hurt = Math.max(0, t.hurt - dt);
        if (t.state === "faded") {
            t.fadedFor += dt;
            // Tom (or any standing Tone of its swarm) close by brings it back.
            const helper = this.near(t.pos, 1.8) || this.liveTones(sw).some(o => Math.hypot(o.pos[0] - t.pos[0], o.pos[2] - t.pos[2]) < 1.2);
            t.revive = helper ? t.revive + dt : Math.max(0, t.revive - dt);
            if (t.revive >= REVIVE_TIME) {
                t.state = "ok"; t.hp = sw.stats.hp * 0.5; t.fadedFor = 0; t.revive = 0; this.campaign.stats.revived++;
                this.events.push({ kind: "revived", at: [...t.pos], species: t.species });
            } else if (t.fadedFor > REVIVE_WINDOW) {
                this.events.push({ kind: "passed", at: [...t.pos], species: t.species });
                this.campaign.stats.lost++;
                this.tones.splice(this.tones.indexOf(t), 1);
                this.tonesOf(sw).forEach((o, i) => { o.slot = i; });
            }
            return;
        }
        const o = sw.order;
        const live = this.liveTones(sw), k = live.indexOf(t), n = live.length;
        // Where this Tone wants to stand: around the anchor, or at its work.
        const ring = (cx: number, cz: number, r: number): [number, number] => { const a = (k / Math.max(1, n)) * Math.PI * 2 + sw.id; return [cx + Math.cos(a) * r, cz + Math.sin(a) * r]; };
        const spiral = (cx: number, cz: number): [number, number] => { const a = k * 2.399, r = 0.55 * Math.sqrt(k + 0.5); return [cx + Math.cos(a) * r, cz + Math.sin(a) * r]; };
        let goal: [number, number] = spiral(sw.anchor[0], sw.anchor[1]);
        let working = false;
        const arrived = !sw.path || sw.pathI >= sw.path.length || Math.hypot(sw.anchor[0] - o.x, sw.anchor[1] - o.z) < 4;
        const st = sw.stats;
        // Free fruit nearby is always eaten (and makes Tones grow).
        const fruit = o.kind === "follow" || o.kind === "tree" || o.kind === "move" ? this.pickups.find(p => p.kind === "fruit" && !p.taken && Math.hypot(p.pos[0] - t.pos[0], p.pos[2] - t.pos[2]) < (o.kind === "tree" ? 9 : 5)) : undefined;
        // Idle Tones defend themselves.
        const foe = o.kind === "follow" || o.kind === "move" || o.kind === "heart" || o.kind === "tree" ? this.nearestEnemy(t.pos[0], t.pos[2], st.ranged ? 11 : 6) : null;
        // Loose relics nearby are fetched (and then carried home).
        const relic = !fruit && !t.carrying && (o.kind === "move" || o.kind === "crate" || o.kind === "follow") ? this.pickups.find(p => p.kind === "relic" && !p.taken && p.age > 0.6 && Math.hypot(p.pos[0] - t.pos[0], p.pos[2] - t.pos[2]) < 8) : undefined;
        if (relic && !foe) {
            goal = [relic.pos[0], relic.pos[2]];
        } else if (fruit && !foe) {
            goal = [fruit.pos[0], fruit.pos[2]];
            if (Math.hypot(fruit.pos[0] - t.pos[0], fruit.pos[2] - t.pos[2]) < 0.9) {
                fruit.taken = true; t.growth++; sw.food++; this.campaign.stats.fed++;
                this.events.push({ kind: "ate", at: [...t.pos], species: t.species });
                this.pulse(t.pos[0], t.pos[2], PALETTE.fruit, 0.6, 7, 9);
            }
        } else if (foe && o.kind !== "attack") {
            working = this.attackStep(t, sw, foe.pos, ENEMIES[foe.kind].size, (dmg) => this.damageEnemy(foe, dmg), dt);
            if (!st.ranged) goal = [foe.pos[0], foe.pos[2]];
        } else if (arrived) {
            switch (o.kind) {
                case "attack": {
                    const e = this.enemies.find(x => x.id === o.ref);
                    if (e) { working = this.attackStep(t, sw, e.pos, ENEMIES[e.kind].size, dmg => this.damageEnemy(e, dmg), dt); goal = st.ranged ? ring(e.pos[0], e.pos[2], 6) : ring(e.pos[0], e.pos[2], ENEMIES[e.kind].size + 0.5); }
                    break;
                }
                case "boss": {
                    const d = this.darks[o.ref], b = d?.boss;
                    if (b) {
                        goal = ring(b.pos[0], b.pos[2], st.ranged ? b.size + 6 : b.size * 0.75 + 0.6);
                        working = this.attackStep(t, sw, b.pos, b.size * 0.8, dmg => this.damageBoss(d, dmg), dt);
                    }
                    break;
                }
                case "crate": {
                    const c = this.crates[o.ref];
                    if (c && !c.broken) {
                        goal = ring(c.x, c.z, c.big ? 1.7 : 1.2);
                        if (Math.hypot(goal[0] - t.pos[0], goal[1] - t.pos[2]) < 1.2) {
                            working = true;
                            c.hp -= st.damage * (traitRank(sw.species, sw.traits, "brawn") ? 1.6 : 1) * (sw.traits.heft ? 1.3 : 1) * dt * 0.9;
                            c.shake = 0.15;
                            if (c.hp <= 0) this.breakCrate(c);
                        }
                    }
                    break;
                }
                case "tree": {
                    const tr = this.trees[o.ref];
                    if (tr) {
                        goal = ring(tr.x, tr.z, 1.4);
                        if (!fruit && Math.hypot(goal[0] - t.pos[0], goal[1] - t.pos[2]) < 1.3 && tr.fruit > 0) {
                            working = true;
                            tr.shake = 0.3;
                            t.attackCd -= dt;
                            if (t.attackCd <= 0) {
                                t.attackCd = 1.4;
                                tr.fruit--;
                                const a = Math.random() * 6.28;
                                this.pickups.push({ kind: "fruit", pos: [tr.x + Math.cos(a) * 0.5, tr.y + 3.2, tr.z + Math.sin(a) * 0.5], vel: [Math.cos(a) * 2.2, 2, Math.sin(a) * 2.2], taken: false, age: 0 });
                            }
                        }
                    }
                    break;
                }
                case "heart": case "anchor": {
                    const d = o.kind === "heart" ? this.darks[o.ref] : this.darks[Math.floor(o.ref / 16)];
                    const a = o.kind === "anchor" ? d?.boss?.anchors[o.ref % 16] : null;
                    const cx = a ? a.x : d?.def.x ?? 0, cz = a ? a.z : d?.def.z ?? 0;
                    goal = ring(cx, cz, 2.4 + n * 0.05);
                    if (d && Math.hypot(goal[0] - t.pos[0], goal[1] - t.pos[2]) < 2) {
                        working = true;
                        d.singing = 0.3;
                        const amount = st.purify * dt;
                        if (a) { a.hp -= amount * 1.2; if (a.hp <= 0) { a.hp = 0; this.anchorDown(d); } }
                        else if (!d.boss) { d.heart -= amount; if (d.heart <= 0) this.purify(d); }
                        if (Math.random() < dt * 1.6) this.pulse(t.pos[0], t.pos[2], SPECIES[t.species].color, 0.9, 10, 8);
                    }
                    break;
                }
                case "lever": {
                    const l = this.levers[o.ref];
                    if (l) { goal = ring(l.x, l.z, 0.9); if (Math.hypot(l.x - t.pos[0], l.z - t.pos[2]) < 1.6 && !l.flipped) this.flip(l); }
                    break;
                }
                case "revive": {
                    const f = this.tones.find(x => x.id === o.ref);
                    if (f) goal = ring(f.pos[0], f.pos[2], 0.8);
                    break;
                }
            }
        }
        // A carrier takes its relic home to Tom (unless it is fighting), and hands it over there.
        if (t.carrying > 0 && !working && o.kind !== "attack" && o.kind !== "boss") goal = [this.tom.pos[0] + Math.sin(t.id) * 1.2, this.tom.pos[2] + Math.cos(t.id) * 1.2];
        // Carry relics home: a carrier near Tom hands it over.
        if (t.carrying > 0 && this.near(t.pos, 2.6)) {
            this.campaign.relics += t.carrying; t.carrying = 0;
            this.events.push({ kind: "relic", at: [...t.pos], total: this.campaign.relics });
            this.lesson("shop");
        }
        this.moveTone(t, sw, goal, dt, working);
        // Song as it goes: Tones chirp like birds, more when they move and when they work.
        t.sing -= dt * (working ? 2 : 1) * (Math.hypot(t.vel[0], t.vel[2]) > 1 ? 1.6 : 1);
        if (t.sing <= 0) {
            t.sing = 2.2 + Math.random() * 5;
            if (this.chirpBudget > 0) {
                this.chirpBudget--;
                const note = Math.floor(Math.random() * 5);
                this.events.push({ kind: "chirp", species: t.species, at: [...t.pos], note });
                this.pulse(t.pos[0], t.pos[2], SPECIES[t.species].color, 0.75, 9, 7);
            }
        }
    }

    private attackStep(t: Tone, sw: Swarm, at: V3, size: number, hit: (dmg: number) => void, dt: number): boolean {
        const st = sw.stats, d = Math.hypot(at[0] - t.pos[0], at[2] - t.pos[2]);
        t.attackCd -= dt;
        if (st.ranged) {
            if (d < st.range + size && t.attackCd <= 0) {
                t.attackCd = 0.9 + Math.random() * 0.3;
                const from: V3 = [t.pos[0], t.pos[1] + 0.6, t.pos[2]], to: V3 = [at[0], at[1] + size * 0.6, at[2]];
                const dir: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], l = Math.hypot(...dir) || 1;
                this.bolts.push({ pos: from, vel: [(dir[0] / l) * 22, (dir[1] / l) * 22, (dir[2] / l) * 22], damage: st.damage, life: (l / 22) + 0.05, foe: false, color: SPECIES[t.species].color, size: 0.22 });
                this.events.push({ kind: "shot", at: from, foe: false });
                void hit;
                return true;
            }
            return d < st.range + size;
        }
        if (d < size + 1.1) {
            if (t.attackCd <= 0) { t.attackCd = 0.7; hit(st.damage); t.hop = 0; this.events.push({ kind: "hit", at: [...at], foe: false, color: SPECIES[t.species].color }); }
            return true;
        }
        return false;
    }

    private moveTone(t: Tone, sw: Swarm, goal: [number, number], dt: number, working: boolean): void {
        const T = this.terrain, st = sw.stats;
        let gx = goal[0], gz = goal[1];
        // A personal path when the straight way is blocked for a while.
        if (t.path && t.pathI < t.path.length) {
            const [wx, wz] = t.path[t.pathI];
            if (Math.hypot(wx - t.pos[0], wz - t.pos[2]) < 0.8) t.pathI++;
            else { gx = wx; gz = wz; }
            if (Math.hypot(goal[0] - t.pos[0], goal[1] - t.pos[2]) < 2) t.path = null;
        }
        const dx = gx - t.pos[0], dz = gz - t.pos[2], d = Math.hypot(dx, dz);
        const speed = st.speed * (d > 6 ? 1.35 : 1) * (t.carrying ? 0.85 : 1);
        let vx = 0, vz = 0;
        if (d > 0.15) { const s = Math.min(speed, d * 3); vx = (dx / d) * s; vz = (dz / d) * s; }
        // Keep a little apart from swarm-mates.
        for (const o of this.tones) {
            if (o === t || o.state !== "ok") continue;
            const ox = t.pos[0] - o.pos[0], oz = t.pos[2] - o.pos[2], od = ox * ox + oz * oz;
            if (od < 0.36 && od > 1e-6) { const f = (0.6 - Math.sqrt(od)) * 6; vx += (ox / Math.sqrt(od)) * f; vz += (oz / Math.sqrt(od)) * f; }
        }
        t.vel[0] += (vx - t.vel[0]) * Math.min(1, dt * 8);
        t.vel[2] += (vz - t.vel[2]) * Math.min(1, dt * 8);
        const nx = t.pos[0] + t.vel[0] * dt, nz = t.pos[2] + t.vel[2] * dt;
        let moved = false;
        if (T.canStep(t.pos[0], t.pos[2], nx, nz, sw.mover)) { t.pos[0] = nx; t.pos[2] = nz; moved = true; }
        else if (T.canStep(t.pos[0], t.pos[2], nx, t.pos[2], sw.mover)) { t.pos[0] = nx; moved = true; }
        else if (T.canStep(t.pos[0], t.pos[2], t.pos[0], nz, sw.mover)) { t.pos[2] = nz; moved = true; }
        const far = Math.hypot(goal[0] - t.pos[0], goal[1] - t.pos[2]);
        if ((!moved || Math.hypot(t.vel[0], t.vel[2]) < 0.4) && far > 2.5 && !working) t.stuck += dt; else t.stuck = Math.max(0, t.stuck - dt * 2);
        if (t.stuck > 1.2 && this.time - t.pathAt > 1.5) {
            t.pathAt = this.time;
            t.path = T.findPath([t.pos[0], t.pos[2]], goal, sw.mover, this.level.portals, 8000);
            t.pathI = 0;
            if (!t.path && t.stuck > 5 && far > 10) {
                // Lost for good: it hops back to its swarm (a small leap, not a teleport across the map).
                t.pos[0] = sw.anchor[0] + (Math.random() - 0.5); t.pos[2] = sw.anchor[1] + (Math.random() - 0.5); t.stuck = 0; t.hop = 0;
            }
        }
        const ground = st.fly ? Math.max(T.surface(t.pos[0], t.pos[2]), T.height(t.pos[0], t.pos[2])) : T.surface(t.pos[0], t.pos[2]);
        const climbing = st.climb && T.grade(t.pos[0], t.pos[2]) > MAX_GRADE;
        const hover = st.fly ? 0.9 + Math.sin(this.time * 3 + t.id) * 0.15 : 0;
        t.pos[1] += (ground + hover - t.pos[1]) * Math.min(1, dt * (climbing ? 6 : 14));
        const sp = Math.hypot(t.vel[0], t.vel[2]);
        if (sp > 0.3) t.yaw = Math.atan2(t.vel[0], t.vel[2]);
        t.hop += dt * (2 + sp * 1.6);
    }

    private stepSplits(): void {
        for (const sw of this.swarms) {
            if (sw.food < SPLIT_AT) continue;
            const live = this.liveTones(sw);
            if (!live.length || this.tonesOf(sw).length >= MAX_SWARM) { sw.food = Math.min(sw.food, SPLIT_AT); continue; }
            sw.food -= SPLIT_AT;
            // The best-fed Tone is the one that splits.
            const t = live.reduce((a, b) => (b.growth > a.growth ? b : a));
            t.growth = 0;
            const child = this.addTone(sw, [t.pos[0] + 0.6, 0, t.pos[2] + 0.3], 0, 0.6);
            child.hp = t.hp; t.born = 0.6;
            this.campaign.stats.splits++;
            this.events.push({ kind: "split", at: [...t.pos], species: t.species, size: this.tonesOf(sw).length });
            this.pulse(t.pos[0], t.pos[2], SPECIES[t.species].color, 1, 14, 10);
            this.lesson("split"); this.link("firstSplit");
        }
    }

    hurtTone(t: Tone, amount: number): void {
        if (t.state !== "ok") return;
        t.hp -= amount; t.hurt = 0.3;
        if (t.hp <= 0) {
            t.hp = 0; t.state = "faded"; t.fadedFor = 0; t.revive = 0; t.carrying = 0; t.vel = [0, 0, 0];
            this.events.push({ kind: "fade", at: [...t.pos], species: t.species });
            this.lesson("fade");
            if (this.selectedSwarm === this.swarms[t.swarm] && !this.liveTones(this.swarms[t.swarm]).length) this.selected = this.nextSwarm(this.selected, 1);
        }
    }

    // --- the world -------------------------------------------------------------------------

    private stepWorld(dt: number): void {
        this.chirpBudget = Math.min(6, this.chirpBudget + dt * 3);
        for (const tr of this.trees) {
            tr.shake = Math.max(0, tr.shake - dt);
            if (tr.fruit < tr.max) { tr.regrow += dt; if (tr.regrow > 45) { tr.regrow = 0; tr.fruit++; } }
        }
        for (const c of this.crates) c.shake = Math.max(0, c.shake - dt);
        // Switch plates weigh the Tones standing on them; gates follow their switches and levers.
        for (const s of this.switches) {
            s.weight = 0;
            for (const t of this.tones) if (t.state === "ok" && Math.hypot(t.pos[0] - s.x, t.pos[2] - s.z) < 2.2) s.weight += this.swarms[t.swarm].stats.weight;
        }
        for (const g of this.gates) {
            const sws = this.switches.filter(s => s.gate === g.id), lev = this.levers.filter(l => l.gate === g.id);
            const want = (sws.length > 0 && sws.every(s => s.weight >= s.need)) || (lev.length > 0 && lev.every(l => l.flipped)) || (g.open && lev.length > 0);
            // A gate held open closes only after its plates have been light for a moment
            // (Tones shuffling on a plate must not make it flicker).
            g.light = want ? 0 : g.light + dt;
            const open = want || (g.open && g.light < 0.8);
            if (open !== g.open) {
                g.open = open;
                this.events.push({ kind: "gate", id: g.id, open, at: [g.x, g.y, g.z] });
                this.syncBlockers();
                for (const d of this.darks) this.paintArena(d);
                if (open) this.pulse(g.x, g.z, PALETTE.mech, 1, 30, 16);
            }
            g.lift += ((g.open ? 1 : 0) - g.lift) * Math.min(1, dt * 2.5);
        }
        // The exit: every heart purified.
        if (!this.exitOpen && this.darks.every(d => d.purified)) {
            this.exitOpen = true;
            this.events.push({ kind: "exitOpen" });
            this.link("complete");
            this.pulse(this.level.exit[0], this.level.exit[1], [1, 1, 1], 1, 60, 18);
        }
        if (this.exitOpen && !this.complete && this.near([this.level.exit[0], 0, this.level.exit[1]], 3)) this.finishLevel();
        // Corruption pulses from every heart still beating.
        for (const d of this.darks) {
            if (d.purified) { d.radius = Math.max(0, d.radius - dt * d.def.r / 3); continue; }
            if (Math.floor(this.time / 2.4 + d.idx * 0.37) !== Math.floor((this.time - dt) / 2.4 + d.idx * 0.37)) this.pulse(d.def.x, d.def.z, PALETTE.red, 1, d.def.r * 1.1, 7);
            if (!this.campaign.links.includes("firstDark") && this.near([d.def.x, 0, d.def.z], d.def.r + 14)) { this.link("firstDark"); this.lesson("dark"); }
            if (d.boss && this.near([d.def.x, 0, d.def.z], d.def.r + 6)) { this.link("boss"); this.lesson("anchors"); }
        }
    }

    private syncBlockers(): void {
        this.terrain.blockers = this.gates.map(g => {
            const dx = (Math.cos(g.angle) * g.len) / 2, dz = (Math.sin(g.angle) * g.len) / 2;
            return { id: g.id, ax: g.x - dx, az: g.z - dz, bx: g.x + dx, bz: g.z + dz, open: g.open };
        });
    }

    private flip(l: LeverState): void {
        l.flipped = true;
        this.events.push({ kind: "lever", at: [l.x, l.y, l.z] });
        this.pulse(l.x, l.z, PALETTE.mech, 1, 40, 14);
    }

    private breakCrate(c: CrateState): void {
        c.broken = true; this.campaign.stats.crates++;
        this.events.push({ kind: "crate", at: [c.x, c.y, c.z] });
        for (let i = 0; i < c.relics; i++) this.drop("relic", c.x, c.y + 0.8, c.z);
        for (let i = 0; i < c.fruit; i++) this.drop("fruit", c.x, c.y + 0.8, c.z);
    }

    private drop(kind: "fruit" | "relic", x: number, y: number, z: number): void {
        const a = Math.random() * 6.28, s = 1.5 + Math.random() * 2;
        this.pickups.push({ kind, pos: [x, y, z], vel: [Math.cos(a) * s, 4 + Math.random() * 2, Math.sin(a) * s], taken: false, age: 0 });
    }

    private stepPickups(dt: number): void {
        const T = this.terrain;
        for (const p of this.pickups) {
            if (p.taken) continue;
            p.age += dt;
            p.vel[1] -= GRAVITY * 0.7 * dt;
            const nx = p.pos[0] + p.vel[0] * dt, nz = p.pos[2] + p.vel[2] * dt;
            if (T.canStep(p.pos[0], p.pos[2], nx, nz, { climb: false, fly: true, phase: false })) { p.pos[0] = nx; p.pos[2] = nz; }
            p.pos[1] += p.vel[1] * dt;
            const g = T.surface(p.pos[0], p.pos[2]) + 0.25;
            if (p.pos[1] < g) { p.pos[1] = g; p.vel = [p.vel[0] * 0.5, Math.abs(p.vel[1]) * 0.25, p.vel[2] * 0.5]; if (Math.abs(p.vel[1]) < 0.5) p.vel = [0, 0, 0]; }
            if (p.kind === "relic" && p.age > 0.6) {
                // Tom picks relics up; a Tone nearby picks one up and carries it home.
                if (this.near(p.pos, 1.8)) { p.taken = true; this.campaign.relics++; this.events.push({ kind: "relic", at: [...p.pos], total: this.campaign.relics }); this.lesson("shop"); continue; }
                for (const t of this.tones) if (t.state === "ok" && t.carrying === 0 && Math.hypot(t.pos[0] - p.pos[0], t.pos[2] - p.pos[2]) < 1.2) { t.carrying = 1; p.taken = true; break; }
            }
        }
        this.pickups = this.pickups.filter(p => !p.taken && p.age < 300);
    }

    // --- the Red Corruption ----------------------------------------------------------------

    private friendCells(d: Dark): [number, number][] {
        const A = d.arena, out: [number, number][] = [];
        if (this.tom.down <= 0) out.push(A.cellOf(this.tom.pos[0], this.tom.pos[2]));
        for (const t of this.tones) if (t.state === "ok" && Math.hypot(t.pos[0] - d.def.x, t.pos[2] - d.def.z) < d.def.r + 14) out.push(A.cellOf(t.pos[0], t.pos[2]));
        return out;
    }

    private stepDark(d: Dark, dt: number): void {
        d.singing = Math.max(0, d.singing - dt);
        if (d.purified) return;
        const reachR = d.def.r + 14;
        d.engaged = this.near([d.def.x, 0, d.def.z], reachR) || this.tones.some(t => t.state === "ok" && Math.hypot(t.pos[0] - d.def.x, t.pos[2] - d.def.z) < reachR);
        if (d.boss?.alive) this.stepBoss(d, dt);
        if (!d.engaged) return;
        d.tick -= dt;
        if (d.tick > 0) return;
        d.tick += ARENA_TICK;
        const mine = this.enemies.filter(e => e.dark === d.idx && e.alive);
        if (!mine.length) return;
        const A = d.arena;
        for (const e of mine) { const [r, c] = A.nearestOpen(...A.cellOf(e.pos[0], e.pos[2])); e.agent.r = r; e.agent.c = c; e.agent.hp = Math.max(1, Math.min(12, Math.round((12 * e.hp) / e.maxHp))); }
        A.updateFields(this.friendCells(d), mine.map(e => e.agent));
        const plans = A.decide(mine.map(e => e.agent));
        const C = WIR_DATA.consts;
        mine.forEach((e, k) => {
            const [option, fire, reload] = plans[k], ag = e.agent, def = ENEMIES[e.kind];
            ag.option = option;
            ag.cool = Math.max(0, ag.cool - 1);
            if (ag.reload > 0) { ag.reload--; if (ag.reload === 0) ag.ammo = C.ammo; }
            if (fire) {
                const target = this.visibleFriend(d, e, 14);
                if (target) {
                    ag.ammo--; ag.cool = C.cool;
                    if (def.bolt > 0) this.enemyShot(e, target.pos, def);
                    else e.lunge = 0.35;
                }
            } else if (reload) { ag.ammo = 0; ag.reload = C.reload; }
            const next = A.step(ag.r, ag.c, option);
            const taken = next && mine.some(o => o !== e && o.goal[0] === next[0] && o.goal[1] === next[1]);
            e.goal = next && !taken ? next : [ag.r, ag.c];
            // Hidden from every friend, a hurt one mends.
            if (A.exp[A.at(ag.r, ag.c)] === 0 && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.02);
        });
    }

    private visibleFriend(d: Dark, e: Enemy, range: number): { pos: V3; tone: Tone | null } | null {
        const A = d.arena, me: [number, number] = [e.agent.r, e.agent.c];
        let best: { pos: V3; tone: Tone | null } | null = null, bd = range;
        const consider = (pos: V3, tone: Tone | null) => {
            const dd = Math.hypot(pos[0] - e.pos[0], pos[2] - e.pos[2]);
            if (dd >= bd) return;
            const cell = A.cellOf(pos[0], pos[2]);
            if (A.at(cell[0], cell[1]) >= 0 && !A.sight(me, cell)) return;
            bd = dd; best = { pos, tone };
        };
        if (this.tom.down <= 0) consider(this.tom.pos, null);
        for (const t of this.tones) if (t.state === "ok") consider(t.pos, t);
        return best;
    }

    private enemyShot(e: Enemy, at: V3, def: { bolt: number; damage: number; size: number }): void {
        const from: V3 = [e.pos[0], e.pos[1] + def.size * 0.9, e.pos[2]];
        // Lead nothing: a sidestep dodges it.
        const to: V3 = [at[0], at[1] + 0.7, at[2]], dir: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], l = Math.hypot(...dir) || 1;
        this.bolts.push({ pos: from, vel: [(dir[0] / l) * def.bolt, (dir[1] / l) * def.bolt + (def.bolt > 18 ? 2 : 0), (dir[2] / l) * def.bolt], damage: def.damage, life: l / def.bolt + 0.6, foe: true, color: PALETTE.red, size: 0.35 });
        this.events.push({ kind: "shot", at: from, foe: true });
    }

    private stepEnemies(dt: number): void {
        const T = this.terrain;
        for (const e of this.enemies) {
            e.hurt = Math.max(0, e.hurt - dt);
            if (!e.alive) { e.deadFor += dt; continue; }
            const d = this.darks[e.dark], def = ENEMIES[e.kind];
            if (!d.engaged && !e.minion) continue;
            const [gx, gz] = d.arena.center(e.goal[0], e.goal[1]);
            const dx = gx - e.pos[0], dz = gz - e.pos[2], dist = Math.hypot(dx, dz);
            if (dist > 0.05) {
                const v = Math.min(dist, def.speed * dt);
                e.pos[0] += (dx / dist) * v; e.pos[2] += (dz / dist) * v;
                e.yaw = Math.atan2(dx, dz);
            }
            e.pos[1] = T.surface(e.pos[0], e.pos[2]);
            // Rushers bite whatever they reach.
            e.attackCd -= dt;
            if (def.bolt === 0 && e.attackCd <= 0) {
                const victim = this.closestFriend(e.pos, def.size + 1.2);
                if (victim) {
                    e.attackCd = 0.9; e.lunge = 0.3;
                    if (victim.tone) this.hurtTone(victim.tone, def.damage); else this.hurtTom(def.damage);
                    this.events.push({ kind: "hit", at: [...victim.pos], foe: true, color: PALETTE.red });
                }
            }
            e.lunge = Math.max(0, e.lunge - dt);
        }
        this.enemies = this.enemies.filter(e => e.alive || e.deadFor < 2);
    }

    private closestFriend(at: V3, r: number): { pos: V3; tone: Tone | null } | null {
        let best: { pos: V3; tone: Tone | null } | null = null, bd = r;
        if (this.tom.down <= 0) { const dd = Math.hypot(this.tom.pos[0] - at[0], this.tom.pos[2] - at[2]); if (dd < bd) { bd = dd; best = { pos: this.tom.pos, tone: null }; } }
        for (const t of this.tones) if (t.state === "ok") { const dd = Math.hypot(t.pos[0] - at[0], t.pos[2] - at[2]); if (dd < bd) { bd = dd; best = { pos: t.pos, tone: t }; } }
        return best;
    }

    damageEnemy(e: Enemy, amount: number): void {
        if (!e.alive) return;
        e.hp -= amount; e.hurt = 0.2;
        if (e.hp <= 0) {
            e.alive = false; e.deadFor = 0; this.campaign.stats.defeated++;
            this.events.push({ kind: "defeated", at: [...e.pos], name: ENEMIES[e.kind].name, big: false });
            if (!e.minion && Math.random() < 0.6) this.drop("relic", e.pos[0], e.pos[1] + 0.5, e.pos[2]);
            this.pulse(e.pos[0], e.pos[2], [1, 1, 1], 0.8, 10, 12);
        }
    }

    private stepBolts(dt: number): void {
        for (const b of this.bolts) {
            b.life -= dt;
            b.vel[1] -= (b.foe ? 6 : 0) * dt;
            b.pos = [b.pos[0] + b.vel[0] * dt, b.pos[1] + b.vel[1] * dt, b.pos[2] + b.vel[2] * dt];
            if (b.pos[1] < this.terrain.height(b.pos[0], b.pos[2])) { b.life = 0; continue; }
            if (b.foe) {
                const v = this.closestFriend(b.pos, 0.9);
                if (v && Math.abs(v.pos[1] + 0.6 - b.pos[1]) < 1.4) {
                    b.life = 0;
                    if (v.tone) this.hurtTone(v.tone, b.damage); else this.hurtTom(b.damage);
                    this.events.push({ kind: "hit", at: [...b.pos], foe: true, color: PALETTE.red });
                }
            } else {
                for (const e of this.enemies) if (e.alive && Math.hypot(e.pos[0] - b.pos[0], e.pos[2] - b.pos[2]) < ENEMIES[e.kind].size + 0.4) { this.damageEnemy(e, b.damage); b.life = 0; this.events.push({ kind: "hit", at: [...b.pos], foe: false, color: b.color }); break; }
                if (b.life > 0) for (const d of this.darks) if (d.boss?.alive && Math.hypot(d.boss.pos[0] - b.pos[0], d.boss.pos[2] - b.pos[2]) < d.boss.size * 0.8) { this.damageBoss(d, b.damage); b.life = 0; this.events.push({ kind: "hit", at: [...b.pos], foe: false, color: b.color }); break; }
            }
        }
        this.bolts = this.bolts.filter(b => b.life > 0);
    }

    private stepBoss(d: Dark, dt: number): void {
        const b = d.boss!, T = this.terrain;
        b.hurt = Math.max(0, b.hurt - dt);
        if (!d.engaged) return;
        const target = this.closestFriend(b.pos, d.def.r * 2);
        if (target) {
            const dx = target.pos[0] - b.pos[0], dz = target.pos[2] - b.pos[2], dist = Math.hypot(dx, dz);
            b.yaw = Math.atan2(dx, dz);
            const nx = b.pos[0] + (dx / dist) * 1.6 * dt, nz = b.pos[2] + (dz / dist) * 1.6 * dt;
            if (dist > b.size * 0.9 && Math.hypot(nx - d.def.x, nz - d.def.z) < d.def.r * 0.6) { b.pos[0] = nx; b.pos[2] = nz; }
        }
        b.pos[1] = T.surface(b.pos[0], b.pos[2]);
        // The slam: a ring of red that rolls out along the ground. Jump it.
        b.slamIn -= dt;
        if (b.slamIn <= 0 && b.slam < 0) { b.slam = 0; b.stomp = 0.5; this.events.push({ kind: "slam", at: [...b.pos], radius: BOSSES[b.id].slam }); }
        if (b.slam >= 0) {
            const prev = b.slam;
            b.slam += dt * 11;
            const r0 = prev, r1 = b.slam;
            const inBand = (p: V3, airborne: boolean) => { const dd = Math.hypot(p[0] - b.pos[0], p[2] - b.pos[2]); return dd >= r0 && dd < r1 && !airborne; };
            if (this.tom.down <= 0 && inBand(this.tom.pos, !this.tom.onGround && this.tom.pos[1] - T.surface(this.tom.pos[0], this.tom.pos[2]) > 0.5)) this.hurtTom(14);
            for (const t of this.tones) if (t.state === "ok" && inBand(t.pos, this.swarms[t.swarm].stats.fly)) this.hurtTone(t, 8);
            if (b.slam > BOSSES[b.id].slam) { b.slam = -1; b.slamIn = b.anchors.some(a => a.hp > 0) ? 6.5 : 4.5; }
            this.lesson("slam");
        }
        b.stomp = Math.max(0, b.stomp - dt);
        b.summonIn -= dt;
        if (b.summonIn <= 0) {
            b.summonIn = 14;
            const minions = this.enemies.filter(e => e.dark === d.idx && e.alive && e.minion).length;
            if (minions < 3) for (let i = 0; i < 2; i++) {
                const a = Math.random() * 6.28;
                this.spawnEnemy(d, BOSSES[b.id].summon, i, true, [b.pos[0] + Math.cos(a) * (b.size + 2), b.pos[2] + Math.sin(a) * (b.size + 2)]);
            }
        }
    }

    private anchorDown(d: Dark): void {
        const b = d.boss!;
        const left = b.anchors.filter(a => a.hp > 0).length;
        const a = b.anchors.find(x => x.hp <= 0 && x.max > 0)!;
        a.max = 0;
        this.events.push({ kind: "anchor", at: [a.x, this.terrain.surface(a.x, a.z), a.z], left });
        this.pulse(a.x, a.z, [1, 1, 1], 1, 20, 14);
        if (!left) this.say("toast", `${BOSSES[b.id].name} is exposed: send every swarm at it`);
    }

    damageBoss(d: Dark, amount: number): void {
        const b = d.boss;
        if (!b?.alive) return;
        if (b.anchors.some(a => a.hp > 0)) { b.hurt = 0.05; this.lesson("anchors"); return; }
        b.hp -= amount; b.hurt = 0.2;
        if (b.hp <= 0) {
            b.alive = false; b.hp = 0;
            this.events.push({ kind: "defeated", at: [...b.pos], name: BOSSES[b.id].name, big: true });
            for (const e of this.enemies) if (e.dark === d.idx && e.alive) this.damageEnemy(e, 1e6);
            this.purify(d);
        }
    }

    private purify(d: Dark): void {
        if (d.purified) return;
        d.purified = true; d.heart = 0;
        this.campaign.stats.purified++;
        for (const e of this.enemies) if (e.dark === d.idx && e.alive) { e.alive = false; e.deadFor = 0; this.events.push({ kind: "defeated", at: [...e.pos], name: ENEMIES[e.kind].name, big: false }); }
        for (let i = 0; i < d.def.relics; i++) this.drop("relic", d.def.x, this.terrain.surface(d.def.x, d.def.z) + 1, d.def.z);
        let freed: SpeciesId | null = null;
        if (d.def.frees && this.swarms.length < MAX_SWARMS) {
            freed = d.def.frees;
            if (!this.campaign.unlocked.includes(freed)) this.campaign.unlocked.push(freed);
            const sw = this.makeSwarm(freed, {});
            for (let k = 0; k < 3; k++) this.addTone(sw, [d.def.x + Math.cos(k * 2.1) * 1.5, 0, d.def.z + Math.sin(k * 2.1) * 1.5], 0, 0.6);
            this.lesson("freed");
        }
        this.events.push({ kind: "purified", at: [d.def.x, this.terrain.surface(d.def.x, d.def.z), d.def.z], name: d.def.name, freed });
        this.pulse(d.def.x, d.def.z, [1, 1, 1], 1, 70, 20);
        for (const s of this.swarms) if ((s.order.kind === "heart" || s.order.kind === "boss" || s.order.kind === "anchor") && (s.order.ref === d.idx || Math.floor(s.order.ref / 16) === d.idx)) s.order = { kind: "move", x: s.anchor[0], z: s.anchor[1], ref: -1, label: "Holding" };
    }

    private finishLevel(): void {
        this.complete = true;
        const i = LEVELS.findIndex(l => l.id === this.level.id);
        if (!this.campaign.completed.includes(this.level.id)) this.campaign.completed.push(this.level.id);
        const next = LEVELS[i + 1] ?? null;
        this.syncCampaign();
        this.events.push({ kind: "levelComplete", level: this.level.id, next: next?.id ?? null });
        if (!next) { this.campaign.ended = true; this.events.push({ kind: "ending" }); }
    }

    /** Travel to the next island (after the level-complete card). */
    advance(): boolean {
        const i = LEVELS.findIndex(l => l.id === this.level.id);
        const next = LEVELS[i + 1];
        if (!next) return false;
        this.syncCampaign();
        this.loadLevel(next.id);
        return true;
    }

    // --- friends, the stall and the Prism Pipe ---------------------------------------------

    private stepNpcs(dt: number, input: WomInput): void {
        const key = this.level.key;
        for (const n of this.npcs) {
            n.talking = Math.max(0, n.talking - dt);
            // Each friend plays its instrument: silver music others can see.
            n.play -= dt;
            if (n.play <= 0 && (!this.jam || this.jam.npc !== n.id)) {
                n.play = 0.42 + ((n.note * 7) % 5) * 0.12;
                n.note++;
                const deg = [0, 2, 4, 1, 3, 4, 2, 0][n.note % 8] + (n.note % 16 > 11 ? 1 : 0);
                const midi = key.tonic + 12 + key.mode[deg % key.mode.length] + (deg >= key.mode.length ? 12 : 0);
                if (n.note % 8 === 7) n.play += 1.4;
                if (this.near([n.x, 0, n.z], 40)) this.events.push({ kind: "npcNote", npc: n.id, instrument: NPCS[n.id].instrument, midi, at: [n.x, n.y + 1.5, n.z] });
                this.pulse(n.x, n.z, [0.92, 0.95, 1], 0.6, 12, 9);
            }
        }
        if (input.talk && !this.jam) {
            const n = this.npcNear(4.5);
            if (n) {
                const def = NPCS[n.id];
                const text = def.lines[n.line % def.lines.length];
                n.line++; n.talking = 5;
                this.events.push({ kind: "say", npc: n.id, text });
                if (def.role === "shop") this.lesson("stall");
                if (def.role === "jam" && !this.campaign.jams.includes(n.id)) this.lesson("jam");
            }
        }
        if (input.note >= 0) this.playNote(input.note);
        this.stepJam(dt);
    }

    /** F near a jam partner: starts their call-and-response. */
    startJam(): boolean {
        const n = this.npcNear(5);
        if (!n || !JAM_PHRASES[n.id]) return false;
        this.jam = { npc: n.id, phrase: 0, step: "listen", t: 0, input: [], shown: 0, fails: 0 };
        this.events.push({ kind: "jam", what: "start", npc: n.id });
        return true;
    }
    endJam(): void { this.jam = null; }

    playNote(note: number): void {
        this.pipeGlow[note] = 0.35;
        this.events.push({ kind: "pipe", note, at: [...this.tom.pos] });
        this.pulse(this.tom.pos[0], this.tom.pos[2], [[0.12, 0.45, 1.0], [0.42, 1.0, 0.18], [1.0, 0.93, 0.1], [0.66, 0.3, 1.0], [1, 1, 1]][note] as RGB, 1, 16, 12);
        const j = this.jam;
        if (j && j.step === "echo") {
            const phrase = JAM_PHRASES[j.npc][j.phrase];
            j.input.push(note);
            const k = j.input.length - 1;
            if (phrase[k] !== note) { j.step = "listen"; j.t = -0.8; j.input = []; j.shown = 0; j.fails++; this.events.push({ kind: "jam", what: "fail", npc: j.npc }); }
            else if (j.input.length === phrase.length) {
                this.events.push({ kind: "jam", what: "ok", npc: j.npc });
                j.phrase++; j.input = []; j.shown = 0; j.t = -1; j.step = "listen";
                if (j.phrase >= JAM_PHRASES[j.npc].length) this.jamDone(j);
            }
            return;
        }
        if (!j) {
            // Free play: the Gathering Song's notes call every swarm home.
            this.pipeRecent.push(note);
            if (this.pipeRecent.length > 3) this.pipeRecent.shift();
            if (this.pipeRecent.join() === SONGS.gathering.notes.join() && this.campaign.songs.includes("gathering")) { this.pipeRecent = []; this.gather(); }
        }
    }

    private stepJam(dt: number): void {
        const j = this.jam;
        if (!j || j.step === "done") return;
        if (!this.npcNear(9)) { this.jam = null; return; }
        if (j.step === "listen") {
            j.t += dt;
            const phrase = JAM_PHRASES[j.npc][j.phrase];
            const k = Math.floor(j.t / 0.55);
            if (j.t >= 0 && k >= j.shown && j.shown < phrase.length) {
                const note = phrase[j.shown++];
                const n = this.npcs.find(x => x.id === j.npc)!;
                this.events.push({ kind: "jam", what: "note", npc: j.npc, note });
                this.pulse(n.x, n.z, [[0.12, 0.45, 1.0], [0.42, 1.0, 0.18], [1.0, 0.93, 0.1], [0.66, 0.3, 1.0], [1, 1, 1]][note] as RGB, 0.9, 12, 10);
            }
            if (j.shown >= phrase.length && j.t > phrase.length * 0.55 + 0.3) { j.step = "echo"; j.input = []; }
        }
    }

    private jamDone(j: Jam): void {
        j.step = "done";
        this.events.push({ kind: "jam", what: "done", npc: j.npc });
        if (!this.campaign.jams.includes(j.npc)) {
            this.campaign.jams.push(j.npc);
            if (j.npc === "hoolu" && !this.campaign.songs.includes("gathering")) { this.campaign.songs.push("gathering"); this.events.push({ kind: "song", id: "learned" }); this.say("toast", "You learned the Gathering Song: G, or play 1 3 5"); }
            else { this.campaign.chimes += 60; this.say("toast", "Clatter tosses you 60 chimes"); }
        }
        this.jam = null;
    }

    /** Sells every relic at a stall (Bodhi). */
    sell(): number {
        const n = this.campaign.relics;
        if (!n) return 0;
        this.campaign.relics = 0;
        this.campaign.chimes += n * RELIC_VALUE;
        this.campaign.stats.sold += n;
        return n * RELIC_VALUE;
    }

    /** Buys the next rank of a trait for a swarm. */
    buy(swarm: number, trait: TraitId): { ok: boolean; why: string } {
        const sw = this.swarms[swarm];
        if (!sw) return { ok: false, why: "No such swarm" };
        const price = traitPrice(sw.species, sw.traits, trait);
        if (price === null) return { ok: false, why: `${TRAITS[trait].name} is already as strong as it gets` };
        if (this.campaign.chimes < price) return { ok: false, why: `${TRAITS[trait].name} costs ${price} chimes` };
        this.campaign.chimes -= price;
        sw.traits[trait] = traitRank(sw.species, sw.traits, trait) + 1;
        const before = sw.stats.hp;
        sw.stats = toneStats(sw.species, sw.traits);
        sw.mover = { climb: sw.stats.climb, fly: sw.stats.fly, phase: sw.stats.phase };
        for (const t of this.tonesOf(sw)) t.hp = Math.min(sw.stats.hp, t.hp + sw.stats.hp - before);
        this.syncCampaign();
        return { ok: true, why: `${SPECIES[sw.species].name} swarm learns ${TRAITS[trait].name}` };
    }

    /** A new swarm of three, of a species you have met (the stall hatches them). */
    hatch(species: SpeciesId): { ok: boolean; why: string } {
        const price = 90;
        if (!this.campaign.unlocked.includes(species)) return { ok: false, why: "You have not met that kind of Tone" };
        if (this.swarms.length >= MAX_SWARMS) return { ok: false, why: `${MAX_SWARMS} swarms is all one agent can direct` };
        if (this.campaign.chimes < price) return { ok: false, why: `A new swarm costs ${price} chimes` };
        this.campaign.chimes -= price;
        const sw = this.makeSwarm(species, {});
        for (let k = 0; k < 3; k++) this.addTone(sw, [this.tom.pos[0] + Math.cos(k * 2.1) * 1.5, 0, this.tom.pos[2] + Math.sin(k * 2.1) * 1.5], 0, 0.6);
        this.syncCampaign();
        return { ok: true, why: `Three ${SPECIES[species].name}s hatch from the egg` };
    }

    // --- music made visible ----------------------------------------------------------------

    /** A pulse of color running out through the ground's veins from (x, z). */
    pulse(x: number, z: number, color: RGB, strength: number, reach: number, speed: number): void {
        this.pulses.push({ x, z, t: 0, color, strength, reach, speed });
        if (this.pulses.length > 48) this.pulses.splice(0, this.pulses.length - 48);
    }
    private stepPulses(dt: number): void {
        for (const p of this.pulses) p.t += dt;
        this.pulses = this.pulses.filter(p => p.t * p.speed < p.reach + 4);
    }

    // --- messages --------------------------------------------------------------------------

    lesson(id: string): void {
        if (this.campaign.lessons.includes(id)) return;
        this.campaign.lessons.push(id);
        this.events.push({ kind: "lesson", id });
    }
    link(on: string): void {
        const key = `${this.level.id}:${on}`;
        if (this.campaign.links.includes(key) || this.campaign.links.includes(on) && on === "firstSplit") return;
        const m = this.level.link.find(l => l.on === on) ?? (on === "firstSplit" ? LEVELS[0].link.find(l => l.on === on) : undefined);
        if (!m) return;
        this.campaign.links.push(on === "firstSplit" ? on : key);
        this.events.push({ kind: "link", text: m.text });
    }
    private say(kind: "toast", text: string): void { this.events.push({ kind, text }); }

    // --- the camera ------------------------------------------------------------------------

    camera(): { pos: V3; target: V3; fov: number } {
        const t = this.tom, d = this.camDist, pitch = 0.36 + (d - 7) * 0.012;
        const target: V3 = [t.pos[0], t.pos[1] + 1.6, t.pos[2]];
        let pos: V3 = [target[0] - Math.sin(this.camYaw) * Math.cos(pitch) * d, target[1] + Math.sin(pitch) * d, target[2] - Math.cos(this.camYaw) * Math.cos(pitch) * d];
        const floor = this.terrain.surface(pos[0], pos[2]) + 1.2;
        if (pos[1] < floor) pos = [pos[0], floor, pos[2]];
        return { pos, target, fov: 52 };
    }
}

export { RELIC_VALUE };
