// The street: everyone around you, simulated in the local frame (al_nav.ts) - plain data the
// addon draws, and the tests drive without a window.
//
// - Civilians walk between real building doors along A* paths over the nav grid, pause, and walk
//   on. Each has a name, an audience segment, an opinion of the party and a rival they lean to.
//   They stop to listen when you speak (gathering in a ring around you), take pamphlets, can be
//   talked to and recruited, and run from gunfire.
// - Followers (party members you lead in person) walk with you and fight beside you.
// - Soldiers: when the region is at war with the party, or the regime's heat is high enough to
//   send a raid, squads arrive and fight. Fights are roughly proportional: they shoot back as hard
//   as they are hit. Kills feed the region's war (al_world.ts reportFieldBattle).
// - Rival orators set up across the square and work the crowd; answer them (a debate) or their
//   speech lands unopposed.
//
// Shooting is hitscan against standing capsules, blocked by buildings.

import { type Vec3 } from "../../apps/quadplanet/qp_math";
import { type NavGrid, NAV_SIZE, segmentHitsRect } from "./al_nav";
import {
    FIRST_NAMES, LAST_NAMES, SEGMENTS, RIVALS, PAMPHLETS, factionById, weaponById, type PamphletDef, type WeaponDef,
} from "./al_data";
import { type Rng, pick, weighted, gauss, clamp } from "./al_rng";

export type ActorKind = "civilian" | "follower" | "soldier" | "orator";
export type Side = "party" | "enemy" | "neutral";
export type ActorState = "walk" | "idle" | "listen" | "flee" | "follow" | "fight" | "orate" | "talk" | "dead";

export type RGB = [number, number, number];

export interface Actor {
    id: number;
    kind: ActorKind;
    side: Side;
    name: string;
    segment: string;
    x: number; z: number; y: number;
    /** Facing: direction (sin h, cos h) in (x east, z north). */
    heading: number;
    speed: number;
    path: [number, number][];
    state: ActorState;
    stateTime: number;
    /** -1 (hostile) .. 1 (ready to join). */
    opinion: number;
    lean: string;
    member: boolean;
    memberId: number | null;
    pamphletCooldown: number;
    talkCooldown: number;
    charisma: number; admin: number; combat: number;
    health: number;
    maxHealth: number;
    weapon: string;
    mag: number;
    cooldown: number;
    reload: number;
    accuracy: number;
    target: number | null;
    retarget: number;
    repath: number;
    stride: number;
    faction: string | null;
    look: { shirt: RGB; pants: RGB; skin: RGB; hair: RGB; hat: boolean; female: boolean };
    /** Where a listener stands in the ring. */
    slot: [number, number] | null;
    /** An unnamed armed party member from the region's forces (joins street battles in a war). */
    militia: boolean;
    /** A weapon a fallen soldier dropped, waiting to be picked up. */
    loot: string | null;
    /** Compound defenders: the compound they hold, and the spot they guard until alerted. */
    compound?: string | null;
    post?: [number, number] | null;
    alerted?: boolean;
}

export interface Shot { ax: number; ay: number; az: number; bx: number; by: number; bz: number; side: Side; hit: boolean; age: number }

export type StreetEvent =
    | { kind: "kill"; victim: number; by: Side; soldier: boolean; compound?: string | null }
    | { kind: "follower-died"; memberId: number | null; name: string }
    | { kind: "civilian-killed"; name: string; byPlayer: boolean }
    | { kind: "player-hit"; damage: number }
    | { kind: "rival-speech"; faction: string; crowd: number; name: string }
    | { kind: "squad"; count: number; raid: boolean }
    | { kind: "squad-defeated" };

export interface StreetContext {
    /** Party share of the region (0..1): how civilians start out. */
    partyShare: number;
    rivalShares: Record<string, number>;
    atWar: boolean;
    heat: number;
    /** Enemy troop quality 0..1. */
    enemyQuality: number;
    /** Named followers to keep walking with you. */
    followers: { id: number; name: string; armed: boolean; combat: number }[];
    /** Armed party members from the region's forces fighting beside you (wars only). */
    militia?: number;
    playerWeapon: string;
    /** Spawn a soldier squad now (tests and tools). */
    forceSquad?: boolean;
    /** No new rivals or raids (loading, menus). */
    calm?: boolean;
    /** No roaming squads (respawn grace, or a compound assault already underway). */
    noSquads?: boolean;
}

export interface StreetState {
    actors: Actor[];
    nextId: number;
    shots: Shot[];
    events: StreetEvent[];
    player: { x: number; z: number; y: number; heading: number; health: number; armor: number; absorb: number; dead: boolean; moving: boolean;
        /** Seconds of protection left after respawning (nothing hurts you). */
        shield?: number };
    alarm: { x: number; z: number; time: number } | null;
    speech: { x: number; z: number; target: number } | null;
    rally: { orator: number; time: number; faction: string } | null;
    squadTimer: number;
    rallyTimer: number;
    /** Soldiers still alive from squads (to report when a squad is wiped out). */
    squadAlive: number;
    /** Path requests served this frame (A* is budgeted). */
    pathBudget: number;
    fighterBudget: number;
    civilianTarget: number;
}

export const CIVILIAN_TARGET = 34;
export const SPAWN_MIN = 25;
export const SPAWN_MAX = 130;
export const DESPAWN = 175;
export const WALK = 1.4;
export const RUN = 4.6;
export const ACTOR_RADIUS = 0.35;
export const ACTOR_HEIGHT = 1.75;
export const RALLY_SECONDS = 70;

export function newStreet(): StreetState {
    return {
        actors: [], nextId: 1, shots: [], events: [],
        player: { x: 0, z: 0, y: 0, heading: 0, health: 100, armor: 0, absorb: 0, dead: false, moving: false },
        alarm: null, speech: null, rally: null,
        squadTimer: 40, rallyTimer: 90, squadAlive: 0, pathBudget: 0, fighterBudget: 0, civilianTarget: CIVILIAN_TARGET,
    };
}

// --- Appearance and identity ---------------------------------------------------------------------

const SKINS: RGB[] = [[0.98, 0.84, 0.72], [0.9, 0.7, 0.55], [0.76, 0.55, 0.4], [0.55, 0.37, 0.25], [0.36, 0.24, 0.16]];
const HAIR: RGB[] = [[0.08, 0.06, 0.05], [0.25, 0.15, 0.08], [0.55, 0.38, 0.2], [0.85, 0.72, 0.45], [0.6, 0.6, 0.62]];
const CLOTHES: RGB[] = [[0.25, 0.3, 0.38], [0.55, 0.52, 0.45], [0.2, 0.2, 0.22], [0.42, 0.25, 0.2], [0.3, 0.4, 0.3], [0.7, 0.68, 0.6], [0.35, 0.3, 0.45], [0.6, 0.45, 0.25]];

const FIRST = FIRST_NAMES;
const LAST = LAST_NAMES;

function newActor(st: StreetState, kind: ActorKind, x: number, z: number, r: Rng): Actor {
    const female = r.next() < 0.5;
    return {
        id: st.nextId++, kind, side: kind === "soldier" ? "enemy" : kind === "follower" ? "party" : "neutral",
        name: `${pick(r, FIRST)} ${pick(r, LAST)}`,
        segment: pick(r, SEGMENTS).id,
        x, z, y: 0, heading: r.next() * Math.PI * 2, speed: 0, path: [], state: "idle", stateTime: r.next() * 3,
        opinion: 0, lean: "concordat", member: false, memberId: null, pamphletCooldown: 0, talkCooldown: 0,
        charisma: 1 + Math.floor(r.next() * 10), admin: 1 + Math.floor(r.next() * 10), combat: 1 + Math.floor(r.next() * 10),
        health: 100, maxHealth: 100, weapon: "fists", mag: 0, cooldown: 0, reload: 0, accuracy: 0.5,
        target: null, retarget: 0, repath: 0, stride: r.next() * 6, faction: null,
        look: { shirt: pick(r, CLOTHES), pants: pick(r, CLOTHES), skin: pick(r, SKINS), hair: pick(r, HAIR), hat: r.next() < 0.15, female },
        slot: null, militia: false, loot: null,
    };
}

/** A civilian's starting opinion of the party, from the region's support. */
export function initialOpinion(partyShare: number, r: Rng): number {
    return clamp(gauss(r, -0.18 + partyShare * 2.2, 0.32), -1, 1);
}

export function opinionLabel(o: number): string {
    if (o >= 0.75) return "DEVOTED";
    if (o >= 0.45) return "SYMPATHETIC";
    if (o >= 0.15) return "CURIOUS";
    if (o > -0.2) return "INDIFFERENT";
    if (o > -0.55) return "SKEPTICAL";
    return "HOSTILE";
}

// --- Queries -------------------------------------------------------------------------------------

export const alive = (a: Actor) => a.state !== "dead";
export const dist2 = (ax: number, az: number, bx: number, bz: number) => (ax - bx) ** 2 + (az - bz) ** 2;
export const actorById = (st: StreetState, id: number | null) => (id === null ? undefined : st.actors.find(a => a.id === id));

/** The living actor nearest the player within `reach` meters, preferring ones in front. */
export function nearestActor(st: StreetState, reach = 3.2, filter: (a: Actor) => boolean = () => true): Actor | null {
    const p = st.player;
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    let best: Actor | null = null, bestS = Infinity;
    for (const a of st.actors) {
        if (!alive(a) || !filter(a)) continue;
        const dx = a.x - p.x, dz = a.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d > reach) continue;
        const facing = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
        const s = d * (1.6 - facing);
        if (s < bestS) { bestS = s; best = a; }
    }
    return best;
}

export const listeners = (st: StreetState) => st.actors.filter(a => a.state === "listen" && alive(a));
export const soldiers = (st: StreetState) => st.actors.filter(a => a.kind === "soldier" && alive(a));

// --- Talking, persuading, pamphlets, recruiting --------------------------------------------------

export function persuade(a: Actor, persuasion: number, r: Rng): { ok: boolean; delta: number } {
    if (a.talkCooldown > 0) return { ok: false, delta: 0 };
    a.talkCooldown = 25;
    const p = clamp(0.55 + persuasion * 0.08 + (a.opinion > 0 ? 0.1 : -0.1), 0.1, 0.95);
    const ok = r.next() < p;
    const delta = ok ? 0.12 + persuasion * 0.025 + r.next() * 0.08 : -0.05;
    a.opinion = clamp(a.opinion + delta, -1, 1);
    return { ok, delta };
}

export function recruitChance(a: Actor, persuasion: number): number {
    if (a.member || a.kind !== "civilian") return 0;
    return clamp((a.opinion - 0.3) * 1.6 + persuasion * 0.06, 0, 0.95);
}

export function tryRecruit(a: Actor, persuasion: number, r: Rng): boolean {
    const p = recruitChance(a, persuasion);
    if (a.talkCooldown > 0 && p < 0.9) return false;
    a.talkCooldown = 20;
    if (r.next() < p) { a.member = true; a.opinion = Math.max(a.opinion, 0.8); return true; }
    a.opinion = clamp(a.opinion - 0.05, -1, 1);
    return false;
}

/** Hands a pamphlet over. Hostile people tear it up. Returns the opinion change (null: refused). */
export function givePamphlet(a: Actor, p: PamphletDef, persuasion: number, press: boolean, r: Rng): number | null {
    if (a.kind !== "civilian" || a.pamphletCooldown > 0) return null;
    a.pamphletCooldown = 40;
    if (a.opinion < -0.6 && r.next() < 0.7) return null;
    const delta = p.opinion * (1 + persuasion * 0.1) * (press ? 1.3 : 1) * (0.7 + 0.6 * r.next());
    a.opinion = clamp(a.opinion + delta, -1, 1);
    return delta;
}

// --- Speech crowds -------------------------------------------------------------------------------

/** Starts a speech at (x, z): civilians nearby come to listen until `target` are gathered. */
export function startCrowd(st: StreetState, x: number, z: number, target: number): void {
    st.speech = { x, z, target };
}

export function setCrowdTarget(st: StreetState, target: number): void {
    if (st.speech) st.speech.target = Math.max(1, Math.round(target));
}

/** Ends the speech: opinions move by each listener's segment approval; returns who listened. */
export function endCrowd(st: StreetState, approval: Record<string, number> | null): Actor[] {
    const heard = listeners(st);
    if (approval) for (const a of heard) a.opinion = clamp(a.opinion + (approval[a.segment] ?? 0) * 0.45, -1, 1);
    for (const a of st.actors) if (a.state === "listen") { a.state = "idle"; a.stateTime = 1 + (a.id % 3); a.slot = null; }
    st.speech = null;
    return heard;
}

/** Shares of each segment among the people listening right now. */
export function listenerSegments(st: StreetState): Record<string, number> {
    const l = listeners(st);
    const out: Record<string, number> = {};
    for (const a of l) out[a.segment] = (out[a.segment] ?? 0) + 1 / l.length;
    return out;
}

/** Converts the `n` most convinced listeners into members (they put on the armband). */
export function convertListeners(st: StreetState, n: number): Actor[] {
    const pool = st.actors.filter(a => alive(a) && a.kind === "civilian" && !a.member && (a.state === "listen" || st.speech === null))
        .sort((a, b) => b.opinion - a.opinion).slice(0, Math.max(0, n));
    for (const a of pool) { a.member = true; a.opinion = Math.max(a.opinion, 0.8); }
    return pool;
}

// --- Shooting ------------------------------------------------------------------------------------

/** Ray (origin, unit direction; local coordinates) against a standing capsule: hit distance or null. */
export function rayHitsActor(o: Vec3, d: Vec3, a: Actor, maxDist: number): number | null {
    // Closest approach of the ray to the actor's vertical axis, within the body's height.
    const px = a.x - o[0], pz = a.z - o[2];
    const hl = Math.hypot(d[0], d[2]);
    if (hl < 1e-6) return null;
    const t = (px * d[0] + pz * d[2]) / (hl * hl);
    if (t < 0 || t > maxDist) return null;
    const cx = o[0] + d[0] * t - a.x, cz = o[2] + d[2] * t - a.z;
    const r = a.state === "dead" ? 0 : 0.42;
    if (cx * cx + cz * cz > r * r) return null;
    const y = o[1] + d[1] * t;
    if (y < a.y - 0.1 || y > a.y + ACTOR_HEIGHT + 0.1) return null;
    return t * hl;
}

/** Only combatants can be shot: civilians, rival orators and your own comrades are never harmed. */
export const targetable = (a: Actor): boolean => a.kind === "soldier";

export interface ShotResult { hit: Actor | null; distance: number; blocked: boolean; end: Vec3 }

/**
 * One shot along a ray from `o` (local). Buildings block; the first actor hit takes the damage.
 * `exclude` is the shooter.
 */
export function castShot(st: StreetState, nav: NavGrid | null, o: Vec3, d: Vec3, range: number, exclude: number | null, includePlayer: boolean): ShotResult & { player: boolean } {
    let best: Actor | null = null, bestT = range;
    for (const a of st.actors) {
        if (a.id === exclude || !alive(a) || !targetable(a)) continue;
        const t = rayHitsActor(o, d, a, bestT);
        if (t !== null && t < bestT) { bestT = t; best = a; }
    }
    let player = false;
    if (includePlayer && !st.player.dead) {
        const fake = { x: st.player.x, z: st.player.z, y: st.player.y, state: "idle" } as Actor;
        const t = rayHitsActor(o, d, fake, bestT);
        if (t !== null && t < bestT) { bestT = t; best = null; player = true; }
    }
    let blocked = false;
    if (nav) {
        const ex = o[0] + d[0] * bestT, ez = o[2] + d[2] * bestT;
        for (const r of nav.rects) {
            // Only walls the ray passes below the roof of.
            const reach = bestT + r.hw + r.hd;
            if (Math.abs(r.cx - o[0]) > reach || Math.abs(r.cz - o[2]) > reach) continue;
            const hit = segmentHitsRect(r, o[0], o[2], ex, ez);
            if (hit !== null) {
                const t = hit * bestT;
                const y = o[1] + d[1] * t;
                if (y < r.base + r.height && t < bestT) { bestT = t; best = null; player = false; blocked = true; }
            }
        }
    }
    const end: Vec3 = [o[0] + d[0] * bestT, o[1] + d[1] * bestT, o[2] + d[2] * bestT];
    return { hit: best, distance: bestT, blocked, end, player };
}

function damageActor(st: StreetState, a: Actor, dmg: number, by: Side, byPlayer: boolean): void {
    if (!alive(a)) return;
    // Civilians are never harmed in this game: gunfire scares them, it never hurts them.
    if (a.kind === "civilian" || a.kind === "orator") { alarm(st, a.x, a.z); return; }
    if (a.post) a.alerted = true;
    a.health -= dmg;
    if (a.health > 0) return;
    a.health = 0;
    a.state = "dead";
    a.stateTime = 0;
    a.path = [];
    if (a.kind === "soldier") {
        if (a.weapon !== "fists" && (a.id * 7919) % 10 < 7) a.loot = a.weapon;
        st.events.push({ kind: "kill", victim: a.id, by, soldier: true, compound: a.compound ?? null });
        if (!a.compound) {
            st.squadAlive = Math.max(0, st.squadAlive - 1);
            if (st.squadAlive === 0) st.events.push({ kind: "squad-defeated" });
        }
    } else st.events.push({ kind: "follower-died", memberId: a.memberId, name: a.name });
    void byPlayer;
    if (st.rally && st.rally.orator === a.id) st.rally = null;
}

function damagePlayer(st: StreetState, dmg: number): void {
    const p = st.player;
    if (p.dead || (p.shield ?? 0) > 0) return;
    let rest = dmg;
    if (p.armor > 0) {
        const soak = Math.min(p.armor, dmg * p.absorb);
        p.armor -= soak;
        rest -= soak;
    }
    p.health -= rest;
    st.events.push({ kind: "player-hit", damage: rest });
    if (p.health <= 0) { p.health = 0; p.dead = true; }
}

export function alarm(st: StreetState, x: number, z: number): void {
    st.alarm = { x, z, time: 8 };
}

/**
 * The player fires one shot (pellets for shotguns) along `dir` from `eye` (local). Returns what
 * was hit. Civilians hit count against your karma (the addon reads the events).
 */
export function playerShoot(st: StreetState, nav: NavGrid | null, eye: Vec3, dir: Vec3, w: WeaponDef, marksmanship: number, r: Rng): ShotResult[] {
    const out: ShotResult[] = [];
    const spread = w.spread * (1 - marksmanship * 0.12) * (st.player.moving ? 1.6 : 1);
    for (let k = 0; k < w.pellets; k++) {
        const d = jitter(dir, spread, r);
        const res = castShot(st, nav, eye, d, w.range, null, false);
        if (res.hit) damageActor(st, res.hit, w.damage * (1 + marksmanship * 0.08) * (0.85 + 0.3 * r.next()), "party", true);
        st.shots.push({ ax: eye[0], ay: eye[1] - 0.15, az: eye[2], bx: res.end[0], by: res.end[1], bz: res.end[2], side: "party", hit: !!res.hit, age: 0 });
        out.push(res);
    }
    if (w.id !== "fists") alarm(st, st.player.x, st.player.z);
    return out;
}

function jitter(d: Vec3, spread: number, r: Rng): Vec3 {
    const x = d[0] + (r.next() - 0.5) * 2 * spread, y = d[1] + (r.next() - 0.5) * 2 * spread, z = d[2] + (r.next() - 0.5) * 2 * spread;
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
}

// --- Spawning ------------------------------------------------------------------------------------

function spawnPoint(st: StreetState, nav: NavGrid | null, r: Rng, min: number, max: number): [number, number] | null {
    const p = st.player;
    for (let t = 0; t < 20; t++) {
        const a = r.next() * Math.PI * 2, d = min + r.next() * (max - min);
        const x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
        if (!nav || nav.walkable(x, z)) return [x, z];
    }
    return null;
}

function spawnCivilian(st: StreetState, nav: NavGrid | null, ctx: StreetContext, r: Rng, near = false): void {
    const at = spawnPoint(st, nav, r, near ? 6 : SPAWN_MIN, near ? 40 : SPAWN_MAX);
    if (!at) return;
    const a = newActor(st, "civilian", at[0], at[1], r);
    a.opinion = initialOpinion(ctx.partyShare, r);
    const rivals = RIVALS.map(id => ctx.rivalShares[id] ?? 0.1);
    a.lean = RIVALS[weighted(r, rivals)];
    a.state = "idle";
    a.stateTime = r.next() * 4;
    st.actors.push(a);
}

function ensureFollowers(st: StreetState, ctx: StreetContext, r: Rng): void {
    const want = new Map(ctx.followers.map(f => [f.id, f]));
    let militia = 0;
    for (const a of st.actors) {
        if (a.kind !== "follower" || !alive(a)) continue;
        if (a.militia) {
            // Stand down militia nobody needs any more (the war ended).
            if (++militia > (ctx.militia ?? 0)) { a.state = "dead"; a.stateTime = 99; }
            continue;
        }
        if (a.memberId === null || !want.has(a.memberId)) { a.state = "dead"; a.stateTime = 99; continue; }
        want.delete(a.memberId);
    }
    for (let k = militia; k < (ctx.militia ?? 0); k++) {
        const at = spawnPoint(st, null, r, 3, 8);
        if (!at) break;
        const a = newActor(st, "follower", at[0], at[1], r);
        a.name = `Militia ${pick(r, LAST)}`;
        a.militia = true;
        a.member = true;
        a.opinion = 1;
        a.weapon = r.next() < 0.5 ? "rifle" : "smg";
        a.mag = weaponById(a.weapon).magazine;
        a.accuracy = 0.4;
        a.maxHealth = a.health = 110;
        a.state = "follow";
        st.actors.push(a);
    }
    for (const f of want.values()) {
        const p = st.player;
        const a = newActor(st, "follower", p.x + (r.next() - 0.5) * 3, p.z - 2 - r.next() * 2, r);
        a.name = f.name;
        a.memberId = f.id;
        a.member = true;
        a.opinion = 1;
        a.weapon = f.armed ? (f.combat >= 7 ? "rifle" : "smg") : "fists";
        a.mag = weaponById(a.weapon).magazine;
        a.accuracy = 0.35 + f.combat * 0.045;
        a.maxHealth = a.health = 100 + f.combat * 6;
        a.state = "follow";
        st.actors.push(a);
    }
}

/** A squad of soldiers arrives, out of sight around you. */
export function spawnSquad(st: StreetState, nav: NavGrid | null, ctx: StreetContext, r: Rng, count: number, raid: boolean): number {
    let n = 0;
    const anchor = spawnPoint(st, nav, r, 70, 110);
    if (!anchor) return 0;
    for (let k = 0; k < count; k++) {
        const x = anchor[0] + (r.next() - 0.5) * 8, z = anchor[1] + (r.next() - 0.5) * 8;
        if (nav && !nav.walkable(x, z)) continue;
        const a = newActor(st, "soldier", x, z, r);
        a.name = `Trooper ${pick(r, LAST)}`;
        a.faction = "concordat";
        a.weapon = r.next() < 0.75 ? "rifle" : r.next() < 0.5 ? "smg" : "shotgun";
        a.mag = weaponById(a.weapon).magazine;
        a.accuracy = 0.25 + ctx.enemyQuality * 0.35;
        a.maxHealth = a.health = 90 + ctx.enemyQuality * 50;
        a.state = "fight";
        a.look = { shirt: [0.22, 0.27, 0.22], pants: [0.2, 0.22, 0.2], skin: a.look.skin, hair: a.look.hair, hat: true, female: a.look.female };
        st.actors.push(a);
        n++;
    }
    st.squadAlive += n;
    if (n) st.events.push({ kind: "squad", count: n, raid });
    return n;
}

/** Compound defenders at their posts (local x, z). They hold position until you come close or shoot. */
export function spawnGuards(st: StreetState, ctx: StreetContext, r: Rng, compound: string, posts: [number, number][]): number {
    let n = 0;
    for (const [x, z] of posts) {
        const a = newActor(st, "soldier", x, z, r);
        a.name = `Guard ${pick(r, LAST)}`;
        a.faction = "concordat";
        a.weapon = r.next() < 0.7 ? "rifle" : "smg";
        a.mag = weaponById(a.weapon).magazine;
        a.accuracy = 0.22 + ctx.enemyQuality * 0.3;
        a.maxHealth = a.health = 80 + ctx.enemyQuality * 40;
        a.state = "fight";
        a.compound = compound;
        a.post = [x, z];
        a.alerted = false;
        a.heading = r.next() * Math.PI * 2;
        a.look = { shirt: [0.24, 0.26, 0.2], pants: [0.2, 0.21, 0.18], skin: a.look.skin, hair: a.look.hair, hat: true, female: a.look.female };
        st.actors.push(a);
        n++;
    }
    return n;
}

/** Guards of `compound` still standing. */
export const guardsOf = (st: StreetState, compound: string): Actor[] => st.actors.filter(a => a.compound === compound && alive(a));

export function spawnOrator(st: StreetState, nav: NavGrid | null, ctx: StreetContext, r: Rng): void {
    const rivals = RIVALS.map(id => ctx.rivalShares[id] ?? 0);
    const faction = RIVALS[weighted(r, rivals)];
    // Orators set up where people are: the candidate spot with the most passers-by within earshot.
    let at: [number, number] | null = null, best = -1;
    for (let k = 0; k < 8; k++) {
        const p = spawnPoint(st, nav, r, 30, 55);
        if (!p) continue;
        const near = st.actors.filter(a => a.kind === "civilian" && alive(a) && dist2(a.x, a.z, p[0], p[1]) < 28 * 28).length;
        if (near > best) { best = near; at = p; }
    }
    if (!at) return;
    const a = newActor(st, "orator", at[0], at[1], r);
    a.faction = faction;
    a.side = "neutral";
    a.state = "orate";
    a.opinion = -1;
    a.charisma = 3 + Math.floor(r.next() * 7);
    const c = factionById(faction).color;
    a.look = { ...a.look, shirt: [c[0], c[1], c[2]], hat: false };
    st.actors.push(a);
    st.rally = { orator: a.id, time: RALLY_SECONDS, faction };
}

// --- The per-frame step --------------------------------------------------------------------------

function moveToward(a: Actor, tx: number, tz: number, speed: number, dt: number, nav: NavGrid | null): boolean {
    const dx = tx - a.x, dz = tz - a.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) { a.speed = 0; return true; }
    const step = Math.min(d, speed * dt);
    let nx = a.x + dx / d * step, nz = a.z + dz / d * step;
    if (nav) [nx, nz] = nav.collide(nx, nz, ACTOR_RADIUS);
    a.speed = Math.hypot(nx - a.x, nz - a.z) / Math.max(dt, 1e-6);
    a.x = nx; a.z = nz;
    const want = Math.atan2(dx, dz);
    a.heading = turn(a.heading, want, dt * 6);
    a.stride += a.speed * dt * 2.2;
    return false;
}

function turn(h: number, target: number, rate: number): number {
    let d = target - h;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return h + clamp(d, -rate, rate);
}

function followPath(st: StreetState, a: Actor, speed: number, dt: number, nav: NavGrid | null): boolean {
    if (!a.path.length) return true;
    const [tx, tz] = a.path[0];
    if (moveToward(a, tx, tz, speed, dt, nav)) a.path.shift();
    return a.path.length === 0;
}

/** Finds a path now if this frame's A* budget allows (fighters have their own, larger one). */
function requestPath(st: StreetState, a: Actor, nav: NavGrid | null, tx: number, tz: number): boolean {
    if (!nav) { a.path = [[tx, tz]]; return true; }
    const fighter = a.kind === "soldier" || a.kind === "follower";
    if (fighter ? st.fighterBudget <= 0 : st.pathBudget <= 0) { a.path = []; a.repath = 0.15 + (a.id % 5) * 0.05; return false; }
    if (fighter) st.fighterBudget--; else st.pathBudget--;
    a.path = nav.findPath(a.x, a.z, tx, tz, fighter ? 30000 : 8000) ?? [];
    return true;
}

function civilianGoal(st: StreetState, a: Actor, nav: NavGrid | null, r: Rng): void {
    if (nav && nav.rects.length && r.next() < 0.65) {
        const near = nav.rects.filter(rc => dist2(rc.door[0], rc.door[1], a.x, a.z) < 110 * 110);
        if (near.length) { const rc = pick(r, near); requestPath(st, a, nav, rc.door[0], rc.door[1]); return; }
    }
    const p = nav ? nav.randomWalkable(a.x, a.z, 60, () => r.next()) : [a.x + (r.next() - 0.5) * 60, a.z + (r.next() - 0.5) * 60] as [number, number];
    if (p) requestPath(st, a, nav, p[0], p[1]);
}

function stepCivilian(st: StreetState, a: Actor, dt: number, nav: NavGrid | null, r: Rng): void {
    a.pamphletCooldown = Math.max(0, a.pamphletCooldown - dt);
    a.talkCooldown = Math.max(0, a.talkCooldown - dt);
    if (st.alarm && a.state !== "flee" && dist2(a.x, a.z, st.alarm.x, st.alarm.z) < 55 * 55 && !(a.member && a.state === "listen")) {
        a.state = "flee"; a.stateTime = 0; a.path = [];
    }
    const sp = st.speech;
    const rally = st.rally ? actorById(st, st.rally.orator) : undefined;
    switch (a.state) {
        case "flee": {
            const from = st.alarm ?? { x: st.player.x, z: st.player.z };
            const dx = a.x - from.x, dz = a.z - from.z, d = Math.hypot(dx, dz) || 1;
            moveToward(a, a.x + dx / d * 5, a.z + dz / d * 5, RUN, dt, nav);
            if (a.stateTime > 8 && !st.alarm) { a.state = "idle"; a.stateTime = 0; }
            return;
        }
        case "listen": {
            const center = sp ?? (rally ? { x: rally.x, z: rally.z } : null);
            if (!center) { a.state = "idle"; a.slot = null; return; }
            if (!a.slot) {
                // A free spot in the ring with a clear line to the speaker (not inside a wall).
                for (let t = 0; t < 24 && !a.slot; t++) {
                    const ang = r.next() * Math.PI * 2, rad = 3 + r.next() * (5 + t * 0.4);
                    let sx = center.x + Math.sin(ang) * rad, sz = center.z + Math.cos(ang) * rad;
                    if (nav) {
                        const w = nav.nearestWalkable(sx, sz, 3);
                        if (!w || !nav.sightClear(w[0], w[1], center.x, center.z)) continue;
                        [sx, sz] = w;
                    }
                    a.slot = [sx, sz];
                }
                if (!a.slot) { a.state = "idle"; a.stateTime = 0; return; }
                a.path = [];
                if (dist2(a.x, a.z, a.slot[0], a.slot[1]) > 36) requestPath(st, a, nav, a.slot[0], a.slot[1]);
            }
            if (a.path.length) { followPath(st, a, WALK * 1.5, dt, nav); return; }
            if (nav && dist2(a.x, a.z, a.slot[0], a.slot[1]) > 36 && !nav.lineClear(a.x, a.z, a.slot[0], a.slot[1])) {
                if ((a.repath -= dt) <= 0) requestPath(st, a, nav, a.slot[0], a.slot[1]);
                return;
            }
            if (moveToward(a, a.slot[0], a.slot[1], WALK * 1.3, dt, nav)) a.heading = turn(a.heading, Math.atan2(center.x - a.x, center.z - a.z), dt * 4);
            return;
        }
        case "talk":
            a.speed = 0;
            a.heading = turn(a.heading, Math.atan2(st.player.x - a.x, st.player.z - a.z), dt * 5);
            if (a.stateTime > 12) { a.state = "idle"; a.stateTime = 0; }
            return;
        case "idle":
            a.speed = 0;
            if (a.stateTime > 3 + (a.id % 5)) { civilianGoal(st, a, nav, r); a.state = "walk"; a.stateTime = 0; }
            break;
        case "walk":
            if (a.repath > 0) { a.repath -= dt; if (a.repath <= 0) civilianGoal(st, a, nav, r); break; }
            if (followPath(st, a, WALK * (0.85 + (a.id % 4) * 0.08), dt, nav) || a.stateTime > 90) { a.state = "idle"; a.stateTime = 0; }
            break;
    }
    // Drawn to a speech (yours or a rival's) while there's room in the crowd.
    if (sp && (a.state === "walk" || a.state === "idle")) {
        const want = sp.target;
        if (listeners(st).length < want && dist2(a.x, a.z, sp.x, sp.z) < (30 + want * 1.5) ** 2) { a.state = "listen"; a.slot = null; a.path = []; }
    } else if (!sp && rally && (a.state === "walk" || a.state === "idle") && dist2(a.x, a.z, rally.x, rally.z) < 28 * 28) {
        const count = st.actors.filter(x => x.state === "listen").length;
        if (count < 10 && r.next() < dt * 0.3) { a.state = "listen"; a.slot = null; a.path = []; }
    }
}

function hostiles(st: StreetState, a: Actor): { x: number; z: number; y: number; id: number | null }[] {
    const out: { x: number; z: number; y: number; id: number | null }[] = [];
    if (a.side === "enemy") {
        if (!st.player.dead) out.push({ x: st.player.x, z: st.player.z, y: st.player.y, id: null });
        for (const b of st.actors) if (b.side === "party" && alive(b)) out.push({ x: b.x, z: b.z, y: b.y, id: b.id });
    } else if (a.side === "party") {
        for (const b of st.actors) if (b.side === "enemy" && alive(b)) out.push({ x: b.x, z: b.z, y: b.y, id: b.id });
    }
    return out;
}

function stepFighter(st: StreetState, a: Actor, dt: number, nav: NavGrid | null, r: Rng): void {
    const w = weaponById(a.weapon);
    a.cooldown = Math.max(0, a.cooldown - dt);
    if (a.reload > 0) { a.reload -= dt; if (a.reload <= 0) a.mag = w.magazine; }
    a.retarget -= dt;
    let target: { x: number; z: number; y: number; id: number | null } | null = null;
    // Guards stay at their posts until someone comes close, shoots near them or hits one of them.
    if (a.post && !a.alerted) {
        const near = (x: number, z: number) => dist2(x, z, a.post![0], a.post![1]) < 45 * 45;
        if ((!st.player.dead && near(st.player.x, st.player.z)) || (st.alarm && near(st.alarm.x, st.alarm.z))
            || st.actors.some(b => b.side === "party" && alive(b) && near(b.x, b.z))) {
            for (const g of st.actors) if (g.compound === a.compound) g.alerted = true;
        }
    }
    const foes = a.post && !a.alerted ? [] : hostiles(st, a);
    if (foes.length) {
        // Nearest visible foe within reach.
        let bestD = (w.range * 1.4) ** 2;
        for (const f of foes) {
            const d = dist2(a.x, a.z, f.x, f.z);
            if (d < bestD && (!nav || nav.sightClear(a.x, a.z, f.x, f.z))) { bestD = d; target = f; }
        }
    }
    if (target && a.weapon !== "fists") {
        const d = Math.sqrt(dist2(a.x, a.z, target.x, target.z));
        a.heading = turn(a.heading, Math.atan2(target.x - a.x, target.z - a.z), dt * 8);
        // Soldiers press in to fighting distance; followers hold a little farther back.
        const engage = w.range * (a.kind === "soldier" ? 0.35 : 0.55);
        if (d > engage) moveToward(a, target.x, target.z, RUN * 0.8, dt, nav);
        else {
            // Strafe a little while shooting.
            const side = (a.id % 2 ? 1 : -1) * Math.sin(st.squadTimer + a.id);
            const sx = a.x + Math.cos(a.heading) * side, sz = a.z - Math.sin(a.heading) * side;
            moveToward(a, sx, sz, WALK, dt, nav);
            a.heading = turn(a.heading, Math.atan2(target.x - a.x, target.z - a.z), dt * 8);
        }
        if (a.cooldown <= 0 && a.reload <= 0 && d <= w.range) {
            if (a.mag <= 0) { a.reload = w.reload; return; }
            a.mag--;
            // People fire in short, aimed bursts, not at the weapon's cyclic rate.
            a.cooldown = 1 / Math.min(w.rate, 1.6) * (1 + r.next() * 0.8);
            const hitP = a.accuracy * 0.55 * clamp(1 - d / w.range * 0.8, 0.1, 1) * (target.id === null && st.player.moving ? 0.7 : 1);
            const hit = r.next() < hitP;
            const ty = target.y + 1.2 + (hit ? 0 : (r.next() - 0.5) * 1.5);
            const miss = hit ? 0 : 1.2;
            st.shots.push({ ax: a.x, ay: a.y + 1.4, az: a.z, bx: target.x + (r.next() - 0.5) * miss, by: ty, bz: target.z + (r.next() - 0.5) * miss, side: a.side, hit, age: 0 });
            if (hit) {
                const dmg = w.damage * Math.min(w.pellets, 3) * 0.45 * (0.8 + 0.4 * r.next());
                if (target.id === null) damagePlayer(st, dmg);
                else { const b = actorById(st, target.id); if (b) damageActor(st, b, dmg, a.side, false); }
            }
            alarm(st, a.x, a.z);
        }
        return;
    }
    // No one to shoot: followers walk with you, soldiers hunt you.
    if (a.side === "party") {
        const p = st.player;
        const k = (a.id % 4) - 1.5;
        const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
        const tx = p.x - fx * 2.5 + fz * k * 1.4, tz = p.z - fz * 2.5 - fx * k * 1.4;
        const d = Math.sqrt(dist2(a.x, a.z, tx, tz));
        if (d > 30 && (a.repath -= dt) <= 0 && requestPath(st, a, nav, tx, tz)) a.repath = 2;
        if (a.path.length && d > 8) followPath(st, a, RUN, dt, nav);
        else if (d > 1.2) moveToward(a, tx, tz, d > 6 ? RUN : WALK * 1.2, dt, nav);
        else { a.speed = 0; a.heading = turn(a.heading, p.heading, dt * 3); }
    } else if (a.post && !a.alerted) {
        // On guard: back to the post, then a slow look around.
        if (!moveToward(a, a.post[0], a.post[1], WALK, dt, nav)) return;
        a.speed = 0;
        a.heading += dt * 0.25 * (a.id % 2 ? 1 : -1);
    } else {
        const p = st.player;
        if ((a.repath -= dt) <= 0 && requestPath(st, a, nav, p.x, p.z)) a.repath = 4;
        if (!followPath(st, a, RUN * 0.7, dt, nav)) return;
        // No path (yet): close in directly only when nothing stands in the way.
        if (!nav || nav.lineClear(a.x, a.z, p.x, p.z)) moveToward(a, p.x, p.z, WALK, dt, nav);
    }
}

function stepOrator(st: StreetState, a: Actor, dt: number): void {
    a.speed = 0;
    a.stride += dt * 0.5;
    if (a.state !== "orate" || !st.rally || st.rally.orator !== a.id) return;
    st.rally.time -= dt;
    if (st.rally.time <= 0) {
        const crowd = st.actors.filter(x => x.state === "listen" && alive(x)).length;
        for (const l of st.actors) if (l.state === "listen") { l.opinion = clamp(l.opinion - 0.15, -1, 1); l.state = "idle"; l.slot = null; }
        st.events.push({ kind: "rival-speech", faction: st.rally.faction, crowd, name: a.name });
        st.rally = null;
        a.state = "walk";
        a.kind = "civilian";
    }
}

/** Picks up a weapon dropped within reach of (x, z); returns its id. */
export function takeLoot(st: StreetState, x: number, z: number, reach = 1.8): string | null {
    for (const a of st.actors) {
        if (a.loot && a.state === "dead" && dist2(a.x, a.z, x, z) < reach * reach) {
            const w = a.loot;
            a.loot = null;
            return w;
        }
    }
    return null;
}

/** Ends a rival's rally early (you answered them in a debate, or they fled). */
export function endRally(st: StreetState): void {
    const a = st.rally ? actorById(st, st.rally.orator) : undefined;
    if (a) { a.state = "idle"; a.kind = "civilian"; }
    for (const l of st.actors) if (l.state === "listen" && !st.speech) { l.state = "idle"; l.slot = null; }
    st.rally = null;
}

export function stepStreet(st: StreetState, nav: NavGrid | null, ctx: StreetContext, dt: number, r: Rng, heightAt: (x: number, z: number) => number): void {
    st.events.length = 0;
    st.pathBudget = 4;
    st.fighterBudget = 2;
    if (st.alarm) { st.alarm.time -= dt; if (st.alarm.time <= 0) st.alarm = null; }
    if (st.player.shield) st.player.shield = Math.max(0, st.player.shield - dt);
    for (const s of st.shots) s.age += dt;
    st.shots = st.shots.filter(s => s.age < 0.12);
    const p = st.player;

    // Population: civilians around you, despawned far away.
    st.actors = st.actors.filter(a => !(a.state === "dead" && a.stateTime > (a.loot ? 90 : 25)) && !(a.kind !== "follower" && dist2(a.x, a.z, p.x, p.z) > DESPAWN * DESPAWN && a.state !== "dead"));
    const civilians = st.actors.filter(a => a.kind === "civilian" && alive(a)).length;
    if (civilians < st.civilianTarget) spawnCivilian(st, nav, ctx, r, civilians < st.civilianTarget / 3);
    ensureFollowers(st, ctx, r);

    // Trouble: soldier squads during a war (or a raid when the regime's heat runs high), rivals.
    if (!ctx.calm) {
        st.squadTimer -= dt;
        const raid = !ctx.atWar && ctx.heat > 0.7;
        if (ctx.forceSquad || ((ctx.atWar || raid) && !ctx.noSquads && st.squadTimer <= 0 && st.squadAlive === 0)) {
            spawnSquad(st, nav, ctx, r, ctx.atWar ? 3 + Math.floor(r.next() * 4) : 3, raid && !ctx.atWar);
            st.squadTimer = ctx.atWar ? 35 + r.next() * 40 : 120 + r.next() * 120;
        }
        if (!ctx.atWar && !st.rally && !st.speech) {
            st.rallyTimer -= dt;
            if (st.rallyTimer <= 0) {
                spawnOrator(st, nav, ctx, r);
                st.rallyTimer = 150 + r.next() * 150;
            }
        }
    }

    for (const a of st.actors) {
        a.stateTime += dt;
        if (a.state === "dead") continue;
        if (a.kind === "civilian") stepCivilian(st, a, dt, nav, r);
        else if (a.kind === "orator") stepOrator(st, a, dt);
        else stepFighter(st, a, dt, nav, r);
        // Keep people from standing inside each other or you.
        const dpx = a.x - p.x, dpz = a.z - p.z, dp = Math.hypot(dpx, dpz);
        if (dp < 0.7 && dp > 1e-4) { a.x = p.x + dpx / dp * 0.7; a.z = p.z + dpz / dp * 0.7; }
        a.y = heightAt(a.x, a.z);
    }
    separate(st);
}

/** Cheap pairwise separation on a spatial hash. */
function separate(st: StreetState): void {
    const cell = 1.5;
    const grid = new Map<number, Actor[]>();
    const key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
    for (const a of st.actors) {
        if (!alive(a)) continue;
        const k = key(Math.floor(a.x / cell), Math.floor(a.z / cell));
        const list = grid.get(k);
        if (list) list.push(a); else grid.set(k, [a]);
    }
    for (const a of st.actors) {
        if (!alive(a)) continue;
        const i = Math.floor(a.x / cell), j = Math.floor(a.z / cell);
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            for (const b of grid.get(key(i + di, j + dj)) ?? []) {
                if (b.id <= a.id) continue;
                const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
                const min = ACTOR_RADIUS * 2;
                if (d < min && d > 1e-4) {
                    const push = (min - d) / 2;
                    a.x -= dx / d * push; a.z -= dz / d * push;
                    b.x += dx / d * push; b.z += dz / d * push;
                }
            }
        }
    }
}

/** Recenters every actor when the local frame moves by (dx, dz). */
export function shiftStreet(st: StreetState, dx: number, dz: number): void {
    for (const a of st.actors) {
        a.x -= dx; a.z -= dz;
        if (a.post) a.post = [a.post[0] - dx, a.post[1] - dz];
        a.path = a.path.map(([x, z]) => [x - dx, z - dz] as [number, number]);
        if (a.slot) a.slot = [a.slot[0] - dx, a.slot[1] - dz];
    }
    st.player.x -= dx; st.player.z -= dz;
    if (st.speech) { st.speech.x -= dx; st.speech.z -= dz; }
    if (st.alarm) { st.alarm.x -= dx; st.alarm.z -= dz; }
    st.shots = [];
}

/** Clears everyone (travel to another region). */
export function resetStreet(st: StreetState): void {
    st.actors = [];
    st.shots = [];
    st.speech = null;
    st.rally = null;
    st.alarm = null;
    st.squadAlive = 0;
    st.squadTimer = 40;
    st.rallyTimer = 90;
}

export { PAMPHLETS, NAV_SIZE };
