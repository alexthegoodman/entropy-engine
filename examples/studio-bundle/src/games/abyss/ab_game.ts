// The whole of Chapter One as a simulation with no engine in it: Alex (body, weapons, wounds),
// his squad and the wardens (ab_combat.ts), the rotorcraft (ab_flight.ts), fire and explosions
// (Allegiance's al_fx.ts), the cutscenes playing (ab_cinema.ts), the radio, pickups, checkpoints
// and the story's phases (ab_script.ts). The addon feeds it input and draws what it holds; the
// tests drive it headless from the title to the end card.

import { HeightGrid, MAP_HALF, SHRINE, SETTLEMENT, EVAC_LZ, FLOOR_Y, LEDGE_Y, type V2, type V3 } from "./ab_world";
import {
    newCombat, spawn, stepCombat, damage, kill, castBolt, rayHitActor, meleeHits, surge, living, alive, actorById, chest,
    type CombatState, type Actor, type CombatWorld, type PlayerView, type Bolt,
} from "./ab_combat";
import { newAircraft, stepAircraft, shootDown, fly, orbit, aircraftFrame, type Aircraft } from "./ab_flight";
import {
    newBody, stepBody, eye, newInventory, newWeaponState, stepWeapon, trigger, startReload, switchWeapon, useMedgel, absorb,
    WEAPONS, ARTIFACTS, type Body, type Inventory, type WeaponState, type WeaponId,
} from "./ab_player";
import { evaluate, eventsBetween, eventsUntil, sceneDuration, type Scene, type Frame, type Subtitle } from "./ab_cinema";
import {
    SCENES, OPENING, CONTACT, ENDING, BEATS, SQUAD, OBJECTIVES, PLACES, PHASES, WARDEN_REVEAL, WARDEN_STAND, WAVE_SOURCES, MAN_DOWN, WARDEN_SHOUTS,
    kiloTwoFlight, type Phase, type Line, type Objective,
} from "./ab_script";
import { newFx, explode, ignite, stepFx, type FxState } from "../allegiance/al_fx";
import { newLook, addMouse, stepLook, stepAds, adsFov, pickAssistTarget, assistFriction, assistPull, bendAngle, adsSpread, adsMove, anglesTo, type LookState, type AimTarget } from "../allegiance/al_aim";
import { makeRng, type Rng } from "../allegiance/al_rng";

// --- The world's physical queries -----------------------------------------------------------------

export interface Solid { x: number; z: number; r: number }

/** Ground, solid props and line of sight over the baked terrain. */
export class GameWorld implements CombatWorld {
    solids: Solid[] = [];
    constructor(readonly grid: HeightGrid) {}
    ground(x: number, z: number): number { return this.grid.height(x, z); }
    slope(x: number, z: number): number { return this.grid.slope(x, z); }
    collide(x: number, z: number, r: number): [number, number] {
        for (const s of this.solids) {
            const dx = x - s.x, dz = z - s.z;
            const d = Math.hypot(dx, dz), min = s.r + r;
            if (d < min && d > 1e-4) { x = s.x + dx / d * min; z = s.z + dz / d * min; }
        }
        return [x, z];
    }
    /** Terrain (marched) and solid props (as columns 6 m tall) between a and b. */
    clear(a: V3, b: V3): boolean {
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const len = Math.hypot(dx, dy, dz);
        const steps = Math.min(200, Math.ceil(len / 3));
        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            const x = a[0] + dx * t, y = a[1] + dy * t, z = a[2] + dz * t;
            if (y < this.ground(x, z) - 0.2) return false;
        }
        for (const s of this.solids) {
            if (s.r < 1.5) continue;
            // Distance from the column's axis to the segment, in plan.
            const h2 = dx * dx + dz * dz;
            const t = h2 > 1e-6 ? Math.max(0, Math.min(1, ((s.x - a[0]) * dx + (s.z - a[2]) * dz) / h2)) : 0;
            const px = a[0] + dx * t - s.x, pz = a[2] + dz * t - s.z;
            if (px * px + pz * pz < (s.r * 0.8) ** 2 && t > 0.02 && t < 0.98) {
                const y = a[1] + dy * t;
                if (y < this.ground(s.x, s.z) + 6) return false;
            }
        }
        return true;
    }
    /** Where a ray from `from` along `dir` meets the terrain (distance), up to `range`. */
    rayTerrain(from: V3, dir: V3, range: number): number {
        let prev = 0;
        for (let t = 1; t <= range; t += t < 40 ? 1 : 3) {
            const x = from[0] + dir[0] * t, y = from[1] + dir[1] * t, z = from[2] + dir[2] * t;
            if (y < this.ground(x, z)) {
                // Refine.
                let lo = prev, hi = t;
                for (let k = 0; k < 8; k++) {
                    const m = (lo + hi) / 2;
                    if (from[1] + dir[1] * m < this.ground(from[0] + dir[0] * m, from[2] + dir[2] * m)) hi = m; else lo = m;
                }
                return hi;
            }
            prev = t;
        }
        return Infinity;
    }
}

// --- Input ----------------------------------------------------------------------------------------

export interface GameInput {
    moveX: number; moveY: number;
    sprint: boolean; jump: boolean;
    /** Mouse look (pixels this frame) and stick/arrow look (-1..1). */
    mouseX: number; mouseY: number; lookX: number; lookY: number;
    fire: boolean; ads: boolean;
    reload: boolean; interact: boolean; heal: boolean; scan: boolean;
    weapon: number | null;
    /** Skip the cutscene (held). */
    skip: boolean;
}

export const NO_INPUT: GameInput = { moveX: 0, moveY: 0, sprint: false, jump: false, mouseX: 0, mouseY: 0, lookX: 0, lookY: 0, fire: false, ads: false, reload: false, interact: false, heal: false, scan: false, weapon: null, skip: false };

// --- Events for the addon (sound, light, the HUD) ----------------------------------------------------

export type GameEvent =
    | { kind: "music"; cue: string }
    | { kind: "shot"; from: V3; to: V3; player: boolean; faction: "surface" | "below" }
    | { kind: "cast"; at: V3 }
    | { kind: "burst"; at: V3; size: number }
    | { kind: "explosion"; at: V3; power: number }
    | { kind: "hitmarker"; kill: boolean }
    | { kind: "hurt"; amount: number; from: V3 }
    | { kind: "death"; name: string; faction: "surface" | "below" }
    | { kind: "pickup"; text: string }
    | { kind: "phase"; phase: Phase }
    | { kind: "toast"; text: string }
    | { kind: "surge"; at: V3 }
    | { kind: "melee" }
    | { kind: "reload" }
    | { kind: "scan" }
    | { kind: "shout"; text: string; translation: string; at: V3 };

export interface Pickup {
    id: number;
    kind: "artifact" | "weapon" | "medgel" | "supply" | "vial";
    item: string;
    x: number; y: number; z: number;
    taken: boolean;
    label: string;
}

export interface RadioLine extends Line { at: number; until: number }

export interface Checkpoint { phase: Phase; x: number; z: number; yaw: number; inv: Inventory; objective: number }

/** Story phases a test or the chapter menu can start at. */
export const START_PHASES: Phase[] = ["intro", "ledge", "descent", "floor", "ambush", "fallback", "evac", "laststand", "ending"];

export class Game {
    world: GameWorld;
    rng: Rng = makeRng(31);
    time = 0;
    phase: Phase = "title";
    phaseT = 0;
    objective = 0;
    body: Body;
    inv: Inventory = newInventory();
    ws: WeaponState = newWeaponState();
    look: LookState = newLook();
    health = 100;
    maxHealth = 100;
    alive = true;
    deadT = 0;
    lastHurt = -100;
    hurtDir: { yaw: number; age: number }[] = [];
    combat: CombatState = newCombat(17);
    aircraft: Aircraft[] = [];
    fx: FxState = newFx(5);
    cinema: { scene: Scene; t: number; frame: Frame | null } | null = null;
    black = false;
    radio: RadioLine[] = [];
    pickups: Pickup[] = [];
    nextPickup = 1;
    events: GameEvent[] = [];
    checkpoint: Checkpoint | null = null;
    squadIds: number[] = [];
    wardenId: number | null = null;
    /** Aircraft a bolt is meant for (bolt id -> aircraft id). */
    boltTargets = new Map<number, string>();
    flags: Record<string, boolean | number> = {};
    /** Aim assist 0..1 and look sensitivity (settings). */
    aimAssist = 0.5;
    sensitivity = 1;
    assist: { id: number; angle: number } | null = null;
    scanT = -100;
    stats = { kills: 0, shots: 0, hits: 0, damageTaken: 0, started: 0, finished: 0, squadLost: 0 };
    /** The squad holds a point (T) or follows. */
    hold: V2 | null = null;
    /** What the camera does this frame (the addon reads it). */
    camera = { pos: [0, 0, 0] as V3, target: [0, 0, 1] as V3, fov: 45, roll: 0 };
    interactable: Pickup | { kind: "shrine" | "okafor"; label: string } | null = null;
    /** The Warden's place (scripted). */
    wardenGoal: V2 | null = null;
    vialPos: V3 | null = null;
    /** Where Alex has walked (newest first, ~1.5 m apart): the squad follows it down narrow ways. */
    trail: V2[] = [];

    constructor(world: GameWorld) {
        this.world = world;
        const [lx, lz] = PLACES.landing;
        this.body = newBody(lx, lz, world.ground(lx, lz));
        this.setupAircraft();
    }

    // --- Setup -----------------------------------------------------------------------------------

    private setupAircraft(): void {
        const g = (x: number, z: number) => this.world.ground(x, z);
        const a: Aircraft[] = [];
        const act = newAircraft("actual", "Lantern Actual", "gunship", [0, 260, -500]);
        orbit(act, [0, 240, -150], 950, 30, 0.4, 1, 10);
        a.push(act);
        const orbits: [string, V3, number, number, number, 1 | -1][] = [
            ["lantern1", [-300, 140, -200], 620, 26, 1.0, 1], ["lantern2", [200, 60, 100], 520, 24, 2.2, -1], ["lantern3", [500, -120, 0], 380, 18, 3.1, 1],
            ["lantern5", [-600, -60, -100], 420, 20, 4.4, -1], ["lantern7", [100, -300, -350], 300, 16, 5.2, 1], ["lantern8", [800, 120, -300], 600, 28, 0.2, -1],
        ];
        for (const [id, c, r, s, ph, dir] of orbits) {
            const p = newAircraft(id, id.replace("lantern", "Lantern "), "gunship", c);
            orbit(p, c, r, s, ph, dir, 8);
            a.push(p);
        }
        const l4 = newAircraft("lantern4", "Lantern 4", "gunship", [SHRINE[0] + 40, -380, SHRINE[1] - 60]);
        orbit(l4, [SHRINE[0], -400, SHRINE[1]], 160, 14, 0, 1, 4);
        a.push(l4);
        const kilo = newAircraft("kilo2", "Kilo-Two", "dropship", [PLACES.fob[0] + 20, g(PLACES.fob[0] + 20, PLACES.fob[1] + 20) + 0.2, PLACES.fob[1] + 20]);
        kilo.mode = "parked"; kilo.searchlight = false;
        a.push(kilo);
        for (const [i, dx] of [[0, -60], [1, 70]] as const) {
            const p = newAircraft(`parked${i}`, "Kilo", "dropship", [PLACES.fob[0] + dx, g(PLACES.fob[0] + dx, PLACES.fob[1] - 20) + 0.2, PLACES.fob[1] - 20], 0.3 * i);
            p.mode = "parked"; p.searchlight = false;
            a.push(p);
        }
        const six = newAircraft("lantern6", "Lantern 6", "dropship", [-900, 200, -300]);
        six.mode = "parked"; six.pos = [-1500, 220, -900]; six.searchlight = false;
        a.push(six);
        const nine = newAircraft("lantern9", "Lantern 9", "gunship", [-1500, 240, -900]);
        nine.mode = "parked";
        a.push(nine);
        this.aircraft = a;
    }

    aircraftById(id: string): Aircraft | undefined { return this.aircraft.find(a => a.id === id); }

    private spawnSquad(near: V2): void {
        if (this.squadIds.length) return;
        SQUAD.forEach((m, i) => {
            const ang = i * 0.8;
            const a = spawn(this.combat, { name: m.name, look: m.look, faction: "surface", role: "squad", x: near[0] + Math.cos(ang) * (3 + i * 0.6), z: near[1] + Math.sin(ang) * (3 + i * 0.6), slot: m.slot, mortal: false }, (x, z) => this.world.ground(x, z));
            a.yaw = Math.atan2(PLACES.rampTop[0] - a.x, PLACES.rampTop[1] - a.z);
            if (m.look === "synthetic") { a.maxHp = 160; a.hp = 160; a.scale = 1; }
            this.squadIds.push(a.id);
        });
    }

    squad(): Actor[] { return this.squadIds.map(id => actorById(this.combat, id)!).filter(Boolean); }
    squadLost(): number { return this.squad().filter(a => !alive(a)).length; }
    okafor(): Actor | undefined { return this.squad()[0]; }
    warden(): Actor | undefined { return actorById(this.combat, this.wardenId); }

    private playerView(): PlayerView {
        const g = this;
        return {
            x: this.body.x, y: this.body.y, z: this.body.z, yaw: this.body.yaw, alive: this.alive && this.phase !== "ending",
            hurt(amount: number, from: V3) { g.hurt(amount, from); },
        };
    }

    // --- Story control ---------------------------------------------------------------------------

    /** Starts the chapter (or jumps to a phase: tests and the chapter menu). */
    start(phase: Phase = "intro"): void {
        this.stats.started = this.time;
        if (phase === "intro") { this.setPhase("intro"); this.playScene(OPENING); return; }
        // Bring the world to that point: the opening's flight done, the squad down, earlier phases' outcomes.
        this.finishScene(OPENING);
        this.beginLedge();
        const order = PHASES.indexOf(phase);
        if (order > PHASES.indexOf("ledge")) this.gear();
        if (order >= PHASES.indexOf("floor")) this.teleport(PLACES.rampFoot[0], PLACES.rampFoot[1], Math.atan2(SHRINE[0] - PLACES.rampFoot[0], SHRINE[1] - PLACES.rampFoot[1]));
        if (order === PHASES.indexOf("descent")) this.setPhase("descent");
        if (order === PHASES.indexOf("floor")) this.setPhase("floor");
        if (order >= PHASES.indexOf("ambush")) {
            this.teleport(SHRINE[0] - 6, SHRINE[1] - 14, 0.1);
            this.revealWardens();
            this.finishScene(CONTACT);
            this.beginAmbush();
        }
        if (order >= PHASES.indexOf("fallback")) { this.killDoomed("ambush"); this.beginFallback(); }
        if (order >= PHASES.indexOf("evac")) { this.teleport(EVAC_LZ[0] + 8, EVAC_LZ[1] + 8, 0.8); this.killDoomed("fallback"); this.beginEvac(); }
        if (order >= PHASES.indexOf("laststand")) { this.killDoomed("evac"); this.beginLastStand(); }
        if (order >= PHASES.indexOf("ending")) { this.drink(); this.beginEnding(); }
        // What was said on the way here was said already.
        this.radio = [];
    }

    private setPhase(p: Phase): void {
        this.phase = p;
        this.phaseT = 0;
        this.objective = 0;
        this.events.push({ kind: "phase", phase: p });
        // Doom: troopers whose time has come can now fall.
        const order = PHASES.indexOf(p);
        this.squad().forEach((a, i) => {
            const from = SQUAD[i].mortalFrom;
            if (from && PHASES.indexOf(from) <= order) a.mortal = true;
        });
        if (["ledge", "descent", "floor", "ambush", "fallback", "evac"].includes(p)) {
            this.checkpoint = { phase: p, x: this.body.x, z: this.body.z, yaw: this.body.yaw, inv: JSON.parse(JSON.stringify(this.inv)), objective: 0 };
        }
    }

    say(lines: Line[]): void {
        let at = Math.max(this.time, ...this.radio.map(r => r.until));
        for (const l of lines) {
            const start = Math.max(at, this.time + (l.delay ?? 0));
            const dur = Math.max(2.4, 1.3 + l.text.length * 0.055);
            this.radio.push({ ...l, at: start, until: start + dur });
            at = start + dur;
        }
    }

    beat(name: string): void {
        const lines = BEATS[name];
        if (lines && !this.flags[`beat:${name}`]) { this.flags[`beat:${name}`] = true; this.say(lines); }
    }

    /** Radio lines on air now. */
    onAir(): RadioLine[] { return this.radio.filter(r => this.time >= r.at && this.time < r.until); }

    currentObjective(): Objective | null {
        const list = OBJECTIVES[this.phase];
        if (!list) return null;
        return list[Math.min(this.objective, list.length - 1)];
    }

    private playScene(scene: Scene): void {
        this.cinema = { scene, t: 0, frame: null };
    }

    /** Applies every event of a scene (skipping it or jumping past it). */
    private finishScene(scene: Scene): void {
        for (const e of eventsUntil(scene, sceneDuration(scene))) this.sceneEvent(e.name, e.args ?? {}, scene, true);
        this.black = false;
    }

    private teleport(x: number, z: number, yaw: number): void {
        this.body.x = x; this.body.z = z; this.body.y = this.world.ground(x, z); this.body.vy = 0; this.body.yaw = yaw;
        this.trail = [];
        for (const a of this.squad()) if (alive(a)) {
            const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
            a.x = x + rx * a.slot[0] - fx * a.slot[1]; a.z = z + rz * a.slot[0] - fz * a.slot[1]; a.y = this.world.ground(a.x, a.z);
            [a.x, a.z] = this.world.collide(a.x, a.z, 0.4);
        }
    }

    private beginLedge(): void {
        if (this.phase === "ledge" && this.flags.ledgeBegun) return;
        this.flags.ledgeBegun = true;
        const [lx, lz] = PLACES.landing;
        const kilo = this.aircraftById("kilo2")!;
        kilo.mode = "parked"; kilo.pos = [lx, this.world.ground(lx, lz) + 0.2, lz]; kilo.yaw = 0.6; kilo.vel = [0, 0, 0]; kilo.pitch = 0; kilo.roll = 0;
        this.spawnSquad([lx + 4, lz + 6]);
        const ok = this.okafor()!;
        ok.x = PLACES.okafor[0]; ok.z = PLACES.okafor[1]; ok.state = "scripted"; ok.goal = null;
        this.body.x = lx + 3; this.body.z = lz + 5; this.body.y = this.world.ground(this.body.x, this.body.z); this.body.yaw = Math.atan2(ok.x - this.body.x, ok.z - this.body.z);
        this.addPickup("supply", "supply", PLACES.supply[0], PLACES.supply[1], "Supply drop: plates and medgel", 1.4);
        this.placeArtifacts();
        this.setPhase("ledge");
        this.beat("boot");
        this.beat("ledgeStart");
    }

    private gear(): void {
        if (this.flags.geared) return;
        this.flags.geared = true;
        this.inv.armor = 100; this.inv.armorMax = 100; this.inv.armorName = "Aegis Mk.II plates";
        this.inv.medgel += 2;
        const sup = this.pickups.find(p => p.kind === "supply");
        if (sup) sup.taken = true;
        const ok = this.okafor();
        if (ok) { ok.state = "follow"; }
        // Kilo-Two lifts off and climbs out of the crack.
        const kilo = this.aircraftById("kilo2")!;
        const t = this.time;
        fly(kilo, [{ t, pos: [...kilo.pos] as V3 }, { t: t + 4, pos: [kilo.pos[0] + 5, kilo.pos[1] + 25, kilo.pos[2] + 10] }, { t: t + 14, pos: [-400, -60, -500] }, { t: t + 26, pos: [-100, 180, -300] }], "orbit");
        kilo.orbit = { center: [-200, 200, -400], radius: 700, speed: 26, phase: 2.5, bob: 8, dir: 1 };
        this.setPhase("descent");
        this.beat("geared");
    }

    private placeArtifacts(): void {
        if (this.flags.artifacts) return;
        this.flags.artifacts = true;
        const at = (item: string, x: number, z: number) => this.addPickup("artifact", item, x, z, ARTIFACTS[item].name);
        at("lumen-shard", -300, -768);
        at("lumen-shard", 60, -735);
        at("lumen-shard", SETTLEMENT[0] + 120, SETTLEMENT[1] - 30);
        at("bronze-cup", SHRINE[0] + 14, SHRINE[1] - 4);
        at("river-idol", SETTLEMENT[0] - 58, SETTLEMENT[1] + 10);
        at("prayer-tablet", SETTLEMENT[0] + 60, SETTLEMENT[1] + 75);
        this.addPickup("medgel", "medgel", EVAC_LZ[0] - 6, EVAC_LZ[1] + 4, "Medgel");
        this.addPickup("medgel", "medgel", SHRINE[0] - 30, SHRINE[1] - 20, "Medgel");
    }

    private addPickup(kind: Pickup["kind"], item: string, x: number, z: number, label: string, lift = 0.2): Pickup {
        const p: Pickup = { id: this.nextPickup++, kind, item, x, y: this.world.ground(x, z) + lift, z, taken: false, label };
        this.pickups.push(p);
        return p;
    }

    private revealWardens(): void {
        if (this.flags.revealed) return;
        this.flags.revealed = true;
        const g = (x: number, z: number) => this.world.ground(x, z);
        for (const w of WARDEN_REVEAL) {
            const a = spawn(this.combat, { name: w.look === "adept" ? "Adept" : "Warden", look: w.look, faction: "below", role: w.role, x: w.x, z: w.z }, g);
            a.yaw = Math.atan2(SHRINE[0] - a.x, SHRINE[1] - a.z);
        }
        const lead = spawn(this.combat, { name: "The Warden", look: "the-warden", faction: "below", role: "leader", x: WARDEN_STAND[0], z: WARDEN_STAND[1], scale: 1.0 }, g);
        lead.yaw = Math.atan2(SHRINE[0] - lead.x, SHRINE[1] - lead.z) + Math.PI;
        lead.mortal = false;
        this.wardenId = lead.id;
        this.combat.wardensPassive = true;
        this.combat.holdFire = true;
    }

    private beginAmbush(): void {
        this.combat.holdFire = false;
        this.combat.wardensPassive = false;
        const lead = this.warden();
        if (lead) { lead.state = "scripted"; lead.goal = [SHRINE[0] + 20, SHRINE[1] + 150]; }
        for (const a of this.squad()) if (a.state === "scripted") a.state = "follow";
        this.setPhase("ambush");
        this.beat("ambushStart");
        this.flags.waveA = 0; this.flags.ambushKills = 0;
    }

    private beginFallback(): void {
        this.setPhase("fallback");
        this.beat("fallbackStart");
        this.spawnWave(4, 0, ["warden-m", "warden-f", "warden-m", "adept"]);
        const l7 = this.aircraftById("lantern7")!;
        orbit(l7, [EVAC_LZ[0] + 160, -380, EVAC_LZ[1] + 120], 140, 18, 0, 1, 4);
    }

    private beginEvac(): void {
        this.setPhase("evac");
        this.beat("evacStart");
        this.flags.evacT = 0;
        this.spawnWave(5, 1, ["warden-m", "adept", "warden-f", "warden-m", "adept"]);
        const six = this.aircraftById("lantern6")!;
        const t = this.time;
        six.mode = "parked"; six.pos = [-1300, 200, -700]; six.searchlight = false;
        fly(six, [{ t: t + 4, pos: [-1300, 200, -700] }, { t: t + 26, pos: [EVAC_LZ[0] - 260, -300, EVAC_LZ[1] - 120] }, { t: t + 40, pos: [EVAC_LZ[0] - 40, -480, EVAC_LZ[1] - 20] }, { t: t + 46, pos: [EVAC_LZ[0] - 6, -508, EVAC_LZ[1]] }], "hover");
    }

    private beginLastStand(): void {
        this.setPhase("laststand");
        const ok = this.okafor();
        if (ok) ok.mortal = true;
        this.spawnWave(6, 2, ["warden-m", "warden-m", "adept", "warden-f", "warden-m", "adept"]);
        const lead = this.warden();
        if (lead) { lead.x = EVAC_LZ[0] + 40; lead.z = EVAC_LZ[1] + 70; lead.y = this.world.ground(lead.x, lead.z); lead.state = "scripted"; lead.goal = [EVAC_LZ[0] + 30, EVAC_LZ[1] + 45]; }
    }

    private beginEnding(): void {
        this.setPhase("ending");
        this.combat.wardensPassive = true;
        this.combat.holdFire = true;
        const lead = this.warden();
        if (lead) {
            // Among the fallen, across the zone from Alex.
            const fallen = this.combat.actors.find(a => !alive(a) && a.faction === "below") ?? lead;
            lead.state = "scripted";
            lead.x = fallen.x + 2.5; lead.z = fallen.z + 2.5; lead.y = this.world.ground(lead.x, lead.z);
            lead.goal = null;
            lead.yaw = Math.atan2(this.body.x - lead.x, this.body.z - lead.z);
        }
        this.playScene(ENDING);
    }

    private spawnWave(n: number, source: number, looks: string[]): void {
        const g = (x: number, z: number) => this.world.ground(x, z);
        const [sx, sz] = WAVE_SOURCES[source % WAVE_SOURCES.length];
        for (let i = 0; i < n; i++) {
            const look = looks[i % looks.length];
            const role = look === "warden-m" ? "blade" : "caster";
            const x = sx + (this.rng.next() - 0.5) * 30, z = sz + (this.rng.next() - 0.5) * 30;
            const a = spawn(this.combat, { name: role === "blade" ? "Warden" : "Adept", look, faction: "below", role, x, z }, g);
            a.yaw = Math.atan2(this.body.x - a.x, this.body.z - a.z);
            [a.x, a.z] = this.world.collide(a.x, a.z, 0.5);
        }
        if (this.rng.next() < 0.7) {
            const [text, translation] = WARDEN_SHOUTS[Math.floor(this.rng.next() * WARDEN_SHOUTS.length)];
            this.events.push({ kind: "shout", text, translation, at: [sx, g(sx, sz) + 2, sz] });
        }
    }

    private killDoomed(phase: Phase): void {
        this.squad().forEach((a, i) => {
            if (SQUAD[i].mortalFrom === phase && alive(a)) kill(this.combat, a);
        });
    }

    // --- Cutscene events -------------------------------------------------------------------------

    private sceneEvent(name: string, args: Record<string, unknown>, scene: Scene, skipping: boolean): void {
        const t0 = this.time - (this.cinema && this.cinema.scene === scene ? this.cinema.t : 0);
        switch (name) {
            case "black": this.black = !!args.on; break;
            case "music": if (!skipping) this.events.push({ kind: "music", cue: String(args.cue) }); break;
            case "flyover": {
                // Kilo-Two's flight down to the ledge, timed to the opening.
                const kilo = this.aircraftById("kilo2")!;
                const [lx, lz] = PLACES.landing;
                fly(kilo, kiloTwoFlight(t0, this.world.ground(lx, lz)), "parked");
                // Two gunships thunder low over the camera toward the crack, then take up their orbits.
                const now = this.time;
                for (const [id, dx, dt0] of [["lantern1", -14, 0.5], ["lantern2", 22, 2.2]] as const) {
                    const g = this.aircraftById(id)!;
                    const keepOrbit = g.orbit;
                    fly(g, [
                        { t: now + dt0, pos: [-1120 + dx, 95, -1760] },
                        { t: now + dt0 + 4, pos: [-930 + dx, 70, -1380] },
                        { t: now + dt0 + 9, pos: [-620 + dx, 60, -900] },
                        { t: now + dt0 + 16, pos: [-300 + dx, 90, -380] },
                    ], "orbit");
                    g.orbit = keepOrbit;
                }
                break;
            }
            case "disembark": this.beginLedge(); break;
            case "wardensAppear": this.revealWardens(); break;
            case "wardenRaise": { const w = this.warden(); if (w) w.pose = 2; break; }
            case "aimUp": this.combat.holdFire = true; break;
            case "firstBolt": {
                const l4 = this.aircraftById("lantern4")!;
                const caster = this.combat.actors.find(a => a.faction === "below" && a.role === "caster" && alive(a));
                if (skipping || !caster) { shootDown(l4); break; }
                const b = castBolt(this.combat, caster, null, l4.pos, { speed: 60, damage: 0, radius: 0, size: 0.9, color: [0.6, 0.95, 1], life: 6 });
                this.boltTargets.set(b.id, l4.id);
                break;
            }
            case "wardenKneel": { const w = this.warden(); if (w) w.pose = 4; break; }
            case "wardenWithdraw": {
                for (const a of this.combat.actors) if (alive(a) && a.faction === "below") { a.state = a.role === "leader" ? "scripted" : "flee"; a.goal = [a.x + 30, a.z + 260]; }
                break;
            }
            case "rescue": {
                const nine = this.aircraftById("lantern9")!;
                const t = this.time;
                nine.searchlight = true;
                fly(nine, [{ t, pos: [EVAC_LZ[0] - 200, -260, EVAC_LZ[1] - 300] }, { t: t + 8, pos: [EVAC_LZ[0] - 20, -480, EVAC_LZ[1] - 30] }, { t: t + 14, pos: [EVAC_LZ[0] - 8, -500, EVAC_LZ[1] - 6] }], "hover");
                break;
            }
        }
    }

    // --- Wounds ----------------------------------------------------------------------------------

    hurt(amount: number, from: V3): void {
        if (!this.alive || this.phase === "ending" || this.phase === "complete" || this.cinema) return;
        const taken = absorb(this.inv, amount);
        this.health -= taken;
        this.stats.damageTaken += amount;
        this.lastHurt = this.time;
        const yaw = Math.atan2(from[0] - this.body.x, from[2] - this.body.z) - this.body.yaw;
        this.hurtDir.push({ yaw, age: 0 });
        this.events.push({ kind: "hurt", amount, from });
        if (this.phase === "laststand") {
            // The story keeps Alex alive here: he goes down to the edge, and the river does the rest.
            if (this.health < 14) { this.health = 12; this.critical(); }
            return;
        }
        if (this.health <= 0) { this.health = 0; this.alive = false; this.deadT = 0; }
    }

    private critical(): void {
        if (this.flags.critical) return;
        this.flags.critical = true;
        this.objective = 1;
        // A warden's vial, fallen within reach.
        const v = this.addPickup("vial", "vial", this.body.x + Math.sin(this.body.yaw) * 1.6, this.body.z + Math.cos(this.body.yaw) * 1.6, "Vial of river water", 0.12);
        this.vialPos = [v.x, v.y, v.z];
        this.combat.wardensPassive = false;
        this.beat("vialPrompt");
    }

    /** Alex drinks the river's water: the surge. */
    drink(): void {
        if (this.flags.drank) return;
        this.flags.drank = true;
        this.inv.vial = false;
        const v = this.pickups.find(p => p.kind === "vial");
        if (v) v.taken = true;
        if (!this.vialPos) this.vialPos = [this.body.x + 1.2, this.world.ground(this.body.x + 1.2, this.body.z) + 0.1, this.body.z];
        const at: V3 = [this.body.x, this.body.y + 1, this.body.z];
        const killed = surge(this.combat, at, 30, [SETTLEMENT[0] + 120, SETTLEMENT[1] + 320]);
        this.stats.kills += killed;
        this.combat.wardensPassive = true;
        this.health = this.maxHealth;
        this.events.push({ kind: "surge", at });
        this.beat("surge");
        this.flags.surgeT = this.time;
    }

    private respawn(): void {
        const cp = this.checkpoint;
        if (!cp) return;
        this.alive = true;
        this.health = this.maxHealth;
        this.inv = JSON.parse(JSON.stringify(cp.inv));
        this.ws = newWeaponState();
        this.teleport(cp.x, cp.z, cp.yaw);
        // Wardens of the moment regroup out of sight; their next push comes again.
        for (const a of this.combat.actors) if (alive(a) && a.faction === "below" && a.role !== "leader") {
            const [sx, sz] = WAVE_SOURCES[a.id % WAVE_SOURCES.length];
            a.x = sx + (this.rng.next() - 0.5) * 30; a.z = sz + (this.rng.next() - 0.5) * 30; a.y = this.world.ground(a.x, a.z); a.target = null;
        }
        this.combat.bolts = [];
        this.events.push({ kind: "toast", text: "Augment restarted. Signal reacquired." });
    }

    // --- The step --------------------------------------------------------------------------------

    step(dt: number, input: GameInput = NO_INPUT): void {
        this.events = [];
        this.time += dt;
        this.phaseT += dt;
        if (this.phase === "title" || this.phase === "complete") { this.stepWorld(dt); return; }

        if (this.cinema) { this.stepCinema(dt, input); this.stepWorld(dt); return; }

        // Dead: a moment of static, then the checkpoint.
        if (!this.alive) {
            this.deadT += dt;
            if (this.deadT > 3.5) this.respawn();
            this.stepWorld(dt);
            this.updateCamera(dt);
            return;
        }
        this.stepPlayer(dt, input);
        this.stepWorld(dt);
        this.stepStory(dt);
        this.updateCamera(dt);
    }

    private stepCinema(dt: number, input: GameInput): void {
        const c = this.cinema!;
        const before = c.t;
        const dur = sceneDuration(c.scene);
        if (input.skip) {
            // Skip: every remaining event fires, and we land where the scene would have left us.
            for (const e of eventsBetween(c.scene, before, dur)) this.sceneEvent(e.name, e.args ?? {}, c.scene, true);
            c.t = dur;
        } else {
            c.t += dt;
            for (const e of eventsBetween(c.scene, before, c.t)) this.sceneEvent(e.name, e.args ?? {}, c.scene, false);
        }
        c.frame = evaluate(c.scene, Math.min(c.t, dur), name => this.follow(name));
        this.camera = { ...c.frame.camera, pos: [...c.frame.camera.pos] as V3 };
        // Never inside the ground.
        const floor = this.world.ground(this.camera.pos[0], this.camera.pos[2]) + 1.2;
        if (this.camera.pos[1] < floor) this.camera.pos[1] = floor;
        if (c.t >= dur) this.endScene(c.scene);
    }

    private endScene(scene: Scene): void {
        this.cinema = null;
        this.black = false;
        if (scene === OPENING) { this.beginLedge(); return; }
        if (scene === CONTACT) { this.beginAmbush(); return; }
        if (scene === ENDING) { this.stats.finished = this.time; this.setPhase("complete"); }
    }

    /** What a cutscene's follow key means: a thing's frame in the world. */
    follow(name: string): { pos: V3; right: V3; up: V3; forward: V3 } | null {
        const ac = this.aircraftById(name);
        if (ac) { const f = aircraftFrame(ac); return { pos: ac.pos, ...f }; }
        const frameOf = (x: number, y: number, z: number, yaw: number) => ({
            pos: [x, y, z] as V3, right: [Math.cos(yaw), 0, -Math.sin(yaw)] as V3, up: [0, 1, 0] as V3, forward: [Math.sin(yaw), 0, Math.cos(yaw)] as V3,
        });
        if (name === "alex") return frameOf(this.body.x, this.body.y, this.body.z, this.body.yaw);
        if (name === "okafor") { const o = this.okafor(); return o ? frameOf(o.x, o.y, o.z, o.yaw) : null; }
        if (name === "warden") { const w = this.warden(); return w ? frameOf(w.x, w.y, w.z, w.yaw) : null; }
        if (name === "caster") { const c = this.combat.actors.find(a => a.faction === "below" && a.role === "caster" && alive(a)); return c ? frameOf(c.x, c.y, c.z, c.yaw) : null; }
        if (name === "vial") { const v = this.vialPos ?? [this.body.x + 1, this.body.y, this.body.z]; return frameOf(v[0], v[1], v[2], this.body.yaw); }
        return null;
    }

    private stepPlayer(dt: number, input: GameInput): void {
        const b = this.body;
        // Look: smoothed mouse, eased sticks, slowed over a warden (aim assist).
        stepAds(this.look, input.ads && WEAPONS[this.inv.current].kind === "gun", dt);
        addMouse(this.look, input.mouseX, input.mouseY, this.sensitivity);
        const e = eye(b);
        const targets: AimTarget[] = living(this.combat, "below").map(a => ({ id: a.id, x: a.x, y: a.y, z: a.z }));
        const pick = pickAssistTarget(e.pos, b.yaw, b.pitch, targets, this.aimAssist, this.look.ads, 120, t => this.world.clear(e.pos, [t.x, t.y + 1.25, t.z]));
        this.assist = pick ? { id: pick.target.id, angle: pick.angle } : null;
        const turn = stepLook(this.look, input.lookX, input.lookY, dt, assistFriction(pick, this.aimAssist), this.sensitivity);
        const pull = assistPull(pick, this.aimAssist, this.look.ads, input.fire, dt);
        b.yaw += turn.yaw + pull.yaw;
        b.pitch = Math.max(-1.35, Math.min(1.35, b.pitch + turn.pitch + pull.pitch));
        const fall = stepBody(b, { moveX: input.moveX, moveY: input.moveY, sprint: input.sprint, jump: input.jump }, dt, { ground: (x, z) => this.world.ground(x, z), collide: (x, z, r) => this.world.collide(x, z, r), half: MAP_HALF }, adsMove(this.look.ads));
        if (fall > 0) this.hurt(fall, [b.x, b.y - 1, b.z]);
        if (b.y < FLOOR_Y - 60) this.hurt(999, [b.x, b.y, b.z]);
        // Weapons.
        stepWeapon(this.inv, this.ws, dt);
        if (input.weapon !== null) {
            const id = (["coil-rifle", "arc-pistol", "monoblade", "warden-glaive"] as WeaponId[])[input.weapon - 1];
            if (id && switchWeapon(this.inv, this.ws, id)) this.events.push({ kind: "toast", text: WEAPONS[id].name });
        }
        if (input.reload && startReload(this.inv, this.ws)) this.events.push({ kind: "reload" });
        const spec = WEAPONS[this.inv.current];
        const pressed = input.fire && (spec.auto || !this.flags.triggerHeld);
        this.flags.triggerHeld = input.fire;
        if (pressed && this.phase !== "ledge" && trigger(this.inv, this.ws)) {
            if (spec.kind === "gun") this.fire(pick);
            else this.events.push({ kind: "melee" });
        }
        if (spec.kind === "melee" && this.ws.swing >= (spec.windup ?? 0.15) && !this.ws.swingLanded) {
            this.ws.swingLanded = true;
            for (const a of meleeHits(this.combat, b.x, b.z, b.yaw, spec.reach ?? 2.4, spec.arc ?? 0.9)) {
                const died = damage(this.combat, a, spec.damage, "player");
                this.events.push({ kind: "hitmarker", kill: died });
                if (died) this.onWardenKilled(a);
            }
        }
        if (input.heal) {
            const h = useMedgel(this.inv, this.health, this.maxHealth);
            if (h !== this.health) { this.health = h; this.events.push({ kind: "toast", text: "Medgel applied" }); }
        }
        if (input.scan && this.time - this.scanT > 8) { this.scanT = this.time; this.events.push({ kind: "scan" }); }
        // Out of the fight, the augment knits wounds.
        if (this.time - this.lastHurt > 7 && this.health < this.maxHealth && this.phase !== "laststand") this.health = Math.min(this.maxHealth, this.health + 3 * dt);
        for (const h of this.hurtDir) h.age += dt;
        this.hurtDir = this.hurtDir.filter(h => h.age < 1.6);
        this.updateInteract(input);
    }

    /** A slug from the muzzle along the crosshair (spread, bent onto a warden a hair off it). */
    private fire(pick: ReturnType<typeof pickAssistTarget>): void {
        const b = this.body;
        const spec = WEAPONS[this.inv.current];
        const e = eye(b);
        const moving = Math.min(1, b.speed / 6);
        const spread = (spec.spread ?? 0.01) * adsSpread(this.look.ads) * (1 + moving * 1.5);
        let yaw = b.yaw + (this.rng.next() - 0.5) * 2 * spread, pitch = b.pitch + (this.rng.next() - 0.5) * 2 * spread;
        if (pick && pick.angle < bendAngle(this.aimAssist) + spread) {
            const a = anglesTo(e.pos, [pick.target.x, pick.target.y + 1.25, pick.target.z]);
            yaw = a.yaw; pitch = a.pitch;
        }
        const dir: V3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
        const tT = this.world.rayTerrain(e.pos, dir, spec.range);
        const hit = rayHitActor(this.combat, e.pos, dir, spec.range, "below", tT);
        const dist = hit ? hit.t : Math.min(tT, spec.range);
        const to: V3 = [e.pos[0] + dir[0] * dist, e.pos[1] + dir[1] * dist, e.pos[2] + dir[2] * dist];
        const muzzle: V3 = [e.pos[0] + Math.sin(b.yaw - 0.35) * 0.3 + dir[0] * 0.6, e.pos[1] - 0.18 + dir[1] * 0.6, e.pos[2] + Math.cos(b.yaw - 0.35) * 0.3 + dir[2] * 0.6];
        this.combat.shots.push({ from: muzzle, to, age: 0, hit: !!hit, faction: "surface" });
        this.events.push({ kind: "shot", from: muzzle, to, player: true, faction: "surface" });
        this.stats.shots++;
        // The first shot fired breaks any stand-off.
        if (this.combat.holdFire && living(this.combat, "below").length) { this.combat.holdFire = false; this.combat.wardensPassive = false; }
        if (hit) {
            this.stats.hits++;
            const died = damage(this.combat, hit.actor, spec.damage, "player");
            this.events.push({ kind: "hitmarker", kill: died });
            if (died) this.onWardenKilled(hit.actor);
        }
    }

    private onWardenKilled(a: Actor): void {
        this.stats.kills++;
        if (!this.flags.glaiveDropped && a.role === "blade") {
            this.flags.glaiveDropped = true;
            this.addPickup("weapon", "warden-glaive", a.x + 0.8, a.z, WEAPONS["warden-glaive"].name);
        } else if (!this.flags.maskDropped && a.role === "caster") {
            this.flags.maskDropped = true;
            this.addPickup("artifact", "warden-mask", a.x - 0.6, a.z + 0.4, ARTIFACTS["warden-mask"].name);
        }
    }

    private updateInteract(input: GameInput): void {
        const b = this.body;
        let best: Pickup | null = null, bd = 2.6;
        for (const p of this.pickups) {
            if (p.taken) continue;
            const d = Math.hypot(p.x - b.x, p.z - b.z);
            if (d < bd && Math.abs(p.y - b.y) < 3) { bd = d; best = p; }
        }
        this.interactable = best;
        const ok = this.okafor();
        if (!best && this.phase === "floor" && this.objective === 1 && Math.hypot(SHRINE[0] - b.x, SHRINE[1] - b.z) < 14) this.interactable = { kind: "shrine", label: "Investigate the shrine" };
        if (!this.interactable || !input.interact) return;
        const it = this.interactable;
        if ("id" in it) this.take(it);
        else if (it.kind === "shrine") this.investigateShrine();
        void ok;
    }

    take(p: Pickup): void {
        if (p.taken) return;
        if (p.kind === "supply") { if (this.phase === "ledge") this.gear(); this.events.push({ kind: "pickup", text: "Aegis Mk.II plates bonded. Medgel x2." }); return; }
        p.taken = true;
        if (p.kind === "artifact") { this.inv.artifacts.push(p.item); this.events.push({ kind: "pickup", text: `${ARTIFACTS[p.item].name}  ~${ARTIFACTS[p.item].value} CR` }); }
        else if (p.kind === "weapon") { const id = p.item as WeaponId; if (!this.inv.weapons.includes(id)) this.inv.weapons.push(id); this.events.push({ kind: "pickup", text: `${WEAPONS[id].name}  [4]` }); }
        else if (p.kind === "medgel") { this.inv.medgel++; this.events.push({ kind: "pickup", text: "Medgel +1" }); }
        else if (p.kind === "vial") { this.drink(); }
    }

    private investigateShrine(): void {
        if (this.phase !== "floor") return;
        this.setPhase("contact");
        // Lantern 4 holds over the settlement with its light on the shrine.
        const l4 = this.aircraftById("lantern4")!;
        l4.mode = "hover"; l4.hover = { at: [SHRINE[0] - 10, -470, SHRINE[1] - 30], yaw: 0.4 };
        this.playScene(CONTACT);
    }

    /** Records Alex's trail and gives each trooper its place along it. */
    private stepTrail(): void {
        const b = this.body;
        const last = this.trail[0];
        if (!last || Math.hypot(last[0] - b.x, last[1] - b.z) > 1.5) {
            if (last && Math.hypot(last[0] - b.x, last[1] - b.z) > 40) this.trail = [];
            this.trail.unshift([b.x, b.z]);
            if (this.trail.length > 240) this.trail.pop();
        }
        for (const a of this.squad()) {
            if (!alive(a) || a.state === "scripted") continue;
            // Walk back along the trail by the slot's depth; step aside by its width.
            let need = 2.5 + a.slot[1], at: V2 = [b.x, b.z], dir: V2 = [Math.sin(b.yaw), Math.cos(b.yaw)];
            let prev: V2 = [b.x, b.z];
            for (const p of this.trail) {
                const seg = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
                if (seg > 1e-3) dir = [(prev[0] - p[0]) / seg, (prev[1] - p[1]) / seg];
                if (seg >= need) { at = [prev[0] - dir[0] * need, prev[1] - dir[1] * need]; need = 0; break; }
                need -= seg; prev = p; at = p;
            }
            // The trail's own direction tells "aside" apart; narrow ground keeps it tight.
            const side = a.slot[0] * (this.world.slope(at[0], at[1]) > 0.25 ? 0.25 : 0.6);
            a.goal = [at[0] + dir[1] * side, at[1] - dir[0] * side];
            // Left far behind (a respawn, a long sprint): it catches up out of sight.
            if (Math.hypot(a.x - b.x, a.z - b.z) > 90) {
                a.x = a.goal[0]; a.z = a.goal[1]; a.y = this.world.ground(a.x, a.z);
            }
        }
    }

    private stepWorld(dt: number): void {
        if (this.phase !== "title" && !this.cinema) this.stepTrail();
        // Rotorcraft.
        for (const a of this.aircraft) {
            const ev = stepAircraft(a, dt, this.time, (x, z) => this.world.ground(x, z));
            if (a.mode === "crash" && a.crash) {
                a.crash.smoke += dt;
                if (a.crash.smoke > 0.06) { a.crash.smoke = 0; ignite(this.fx, a.pos[0], a.pos[1], a.pos[2], 0.6, 0.35); }
            }
            if (ev) this.crashed(a, ev.at);
        }
        // Fighting.
        const before = this.combat.actors.filter(a => alive(a)).map(a => a.id);
        stepCombat(this.combat, dt, this.playerView(), this.world, { hold: this.hold, wardenAccuracy: this.phase === "laststand" ? 1.4 : 1 });
        for (const ev of this.combat.events) {
            if (ev.kind === "shot") this.events.push({ kind: "shot", from: ev.from, to: ev.to, player: false, faction: ev.faction });
            else if (ev.kind === "cast") this.events.push({ kind: "cast", at: [ev.actor.x, ev.actor.y + 2, ev.actor.z] });
            else if (ev.kind === "burst") this.events.push({ kind: "burst", at: ev.pos, size: ev.size });
            else if (ev.kind === "death") {
                this.events.push({ kind: "death", name: ev.actor.name, faction: ev.actor.faction });
                if (ev.actor.faction === "surface") {
                    const line = MAN_DOWN[Math.floor(this.rng.next() * MAN_DOWN.length)].replace("{name}", ev.actor.name.split(" ").pop() ?? ev.actor.name);
                    if (ev.actor !== this.okafor() && this.okafor() && alive(this.okafor()!)) this.say([{ speaker: "Sgt. Okafor", text: line, channel: "radio" }]);
                } else if (ev.by === "squad") this.stats.kills += 0;
            }
        }
        void before;
        // Bolts meant for aircraft.
        for (const [boltId, acId] of this.boltTargets) {
            const bolt = this.combat.bolts.find(b => b.id === boltId);
            const ac = this.aircraftById(acId);
            if (!ac) { this.boltTargets.delete(boltId); continue; }
            if (!bolt) { this.boltTargets.delete(boltId); shootDown(ac); continue; }
            bolt.aim = [...ac.pos] as V3;
            if (Math.hypot(bolt.pos[0] - ac.pos[0], bolt.pos[1] - ac.pos[1], bolt.pos[2] - ac.pos[2]) < 5) {
                bolt.life = -1;
                this.combat.bolts = this.combat.bolts.filter(b => b !== bolt);
                this.boltTargets.delete(boltId);
                this.combat.bursts.push({ pos: [...ac.pos] as V3, age: 0, color: bolt.color, size: 6 });
                this.events.push({ kind: "burst", at: [...ac.pos] as V3, size: 2.5 });
                shootDown(ac);
            }
        }
        stepFx(this.fx, dt, [1.2, 0.4], (x, z) => this.world.ground(x, z));
        // Searchlights: gunships sweep the walls and floor; the ones over the fight find it.
        for (const a of this.aircraft) {
            if (!a.searchlight || a.mode === "crash" || a.mode === "wreck") { a.lightTarget = null; continue; }
            const t = this.time * 0.11 + a.rotor * 0.0;
            let tx = a.pos[0] * 0.6 + Math.sin(t + a.id.length) * 120, tz = a.pos[2] * 0.6 + Math.cos(t * 1.3 + a.id.length) * 120;
            if (a.id === "lantern4" && (this.phase === "contact" || this.phase === "floor")) { tx = SHRINE[0]; tz = SHRINE[1]; }
            if (a.id === "lantern9") { tx = this.body.x; tz = this.body.z; }
            a.lightTarget = [tx, this.world.ground(tx, tz), tz];
        }
    }

    private crashed(a: Aircraft, at: V3): void {
        explode(this.fx, at[0], at[1] + 1, at[2], 4, this.world.ground(at[0], at[2]), [this.body.x, this.body.y, this.body.z]);
        ignite(this.fx, at[0], this.world.ground(at[0], at[2]), at[2], 3, 400);
        this.events.push({ kind: "explosion", at, power: 4 });
        this.world.solids.push({ x: at[0], z: at[2], r: 4 });
        // Those caught under it.
        for (const o of this.combat.actors) if (alive(o) && Math.hypot(o.x - at[0], o.z - at[2]) < 9) {
            if (o.faction === "below" || o.mortal) kill(this.combat, o);
        }
        if (Math.hypot(this.body.x - at[0], this.body.z - at[2]) < 7) this.hurt(40, at);
    }

    private stepStory(dt: number): void {
        const b = this.body;
        const near = (p: V2, r: number) => Math.hypot(p[0] - b.x, p[1] - b.z) < r;
        switch (this.phase) {
            case "ledge": {
                const ok = this.okafor();
                if (this.objective === 0 && ok && Math.hypot(ok.x - b.x, ok.z - b.z) < 7) this.objective = 1;
                break;
            }
            case "descent": {
                if (b.x > -180 && b.y < LEDGE_Y - 60) this.beat("rampHalf");
                if (near(PLACES.rampFoot, 45) || (b.y < FLOOR_Y + 25 && b.x > 40)) { this.setPhase("floor"); this.beat("floorReached"); }
                break;
            }
            case "floor": {
                if (this.objective === 0 && near(SETTLEMENT, 150)) { this.objective = 1; this.beat("settlement"); }
                if (this.objective === 1 && near(SHRINE, 16)) this.beat("shrinePrompt");
                break;
            }
            case "ambush": {
                const kills = this.combat.actors.filter(a => a.faction === "below" && !alive(a)).length;
                const left = living(this.combat, "below").filter(a => a.role !== "leader").length;
                if (this.phaseT > 22 && !this.flags.waveA) { this.flags.waveA = 1; this.spawnWave(5, 0, ["warden-m", "adept", "warden-m", "warden-f", "adept"]); }
                if (this.phaseT > 48 && this.flags.waveA === 1) { this.flags.waveA = 2; this.spawnWave(4, 2, ["warden-m", "warden-m", "adept", "warden-f"]); }
                if ((kills >= 10 && this.phaseT > 30) || this.phaseT > 95 || (left === 0 && this.phaseT > 52)) { this.killDoomed("ambush"); this.beginFallback(); }
                break;
            }
            case "fallback": {
                const d = Math.hypot(EVAC_LZ[0] - b.x, EVAC_LZ[1] - b.z);
                if (d < 230 && !this.flags.l7) {
                    this.flags.l7 = true;
                    const l7 = this.aircraftById("lantern7")!;
                    const thrower = living(this.combat, "below").find(a => a.role === "caster") ?? this.warden();
                    if (thrower) { const bolt = castBolt(this.combat, thrower, null, l7.pos, { speed: 70, damage: 0, radius: 0, size: 1, color: [1, 0.85, 0.5], life: 8 }); this.boltTargets.set(bolt.id, l7.id); }
                    else shootDown(l7);
                    this.beat("lantern7Hit");
                }
                if (this.phaseT > 14 && !this.flags.fbWave) { this.flags.fbWave = 1; this.spawnWave(4, 3, ["warden-m", "warden-f", "adept", "warden-m"]); }
                if (d < 28) { this.killDoomed("fallback"); this.beginEvac(); }
                break;
            }
            case "evac": {
                const t = this.phaseT;
                if (t > 18 && !this.flags.evWave) { this.flags.evWave = 1; this.spawnWave(5, 0, ["adept", "warden-m", "warden-m", "warden-f", "adept"]); }
                if (t > 36) this.beat("evacInbound");
                const six = this.aircraftById("lantern6")!;
                if (t > 45 && !this.flags.sixDown) {
                    this.flags.sixDown = true;
                    const lead = this.warden();
                    if (lead && alive(lead)) {
                        lead.x = EVAC_LZ[0] + 60; lead.z = EVAC_LZ[1] + 80; lead.y = this.world.ground(lead.x, lead.z);
                        const bolt = castBolt(this.combat, lead, null, six.pos, { speed: 80, damage: 0, radius: 0, size: 1.4, color: [1, 0.9, 0.6], life: 6 });
                        this.boltTargets.set(bolt.id, six.id);
                        lead.pose = 2;
                    } else shootDown(six);
                }
                if (this.flags.sixDown && (six.mode === "wreck") && !this.flags.sixCrashed) {
                    this.flags.sixCrashed = true;
                    this.killDoomed("evac");
                    this.beat("evacDown");
                }
                if (this.flags.sixCrashed && (this.radio.length === 0 || this.time > Math.max(...this.radio.map(r => r.until)))) this.beginLastStand();
                if (t > 75 && !this.flags.sixCrashed) { shootDown(six); }
                break;
            }
            case "laststand": {
                const ok = this.okafor();
                if (this.phaseT > 10 && ok && alive(ok) && !this.flags.okaforDown) { this.flags.okaforDown = true; this.beat("okaforFalls"); }
                if (this.phaseT > 13 && ok && alive(ok)) kill(this.combat, ok);
                // The wardens close in; the story makes sure it comes to the edge.
                if (this.phaseT > 14 && !this.flags.critical) { this.combat.wardensPassive = false; if (this.phaseT > 40) { this.health = 12; this.critical(); } }
                if (this.flags.drank && this.time - Number(this.flags.surgeT) > 7) this.beginEnding();
                break;
            }
        }
        const lead = this.warden();
        if (lead && alive(lead) && lead.state === "scripted" && lead.goal && Math.hypot(lead.goal[0] - lead.x, lead.goal[1] - lead.z) < 1) lead.goal = null;
        void dt;
    }

    private updateCamera(_dt: number): void {
        const e = eye(this.body);
        const shake = this.fx.shake * this.fx.shake * 0.3;
        const sx = Math.sin(this.time * 53) * shake, sy = Math.sin(this.time * 41 + 1) * shake;
        const dip = Math.min(0.25, this.body.landed * 0.02) * Math.max(0, 1 - (this.time % 1));
        this.camera = {
            pos: [e.pos[0] + sx, e.pos[1] + sy - dip, e.pos[2]],
            target: [e.pos[0] + e.forward[0] * 10, e.pos[1] + e.forward[1] * 10, e.pos[2] + e.forward[2] * 10],
            fov: adsFov(this.look),
            roll: 0,
        };
    }

    /** A plain summary for the state tool and the tests. */
    summary() {
        const r2 = (v: number) => Math.round(v * 100) / 100;
        return {
            phase: this.phase, phaseT: r2(this.phaseT), time: r2(this.time), objective: this.currentObjective()?.text ?? null,
            cinema: this.cinema ? { scene: this.cinema.scene.id, t: r2(this.cinema.t), shot: this.cinema.frame?.shot.shot.id ?? null } : null,
            player: { x: r2(this.body.x), y: r2(this.body.y), z: r2(this.body.z), yaw: r2(this.body.yaw), health: Math.round(this.health), armor: Math.round(this.inv.armor), alive: this.alive, weapon: this.inv.current, mag: this.inv.mags[this.inv.current] ?? null },
            inventory: { weapons: this.inv.weapons, medgel: this.inv.medgel, artifacts: this.inv.artifacts, armor: this.inv.armorName },
            squad: this.squad().map(a => ({ name: a.name, alive: alive(a), hp: Math.round(a.hp), x: r2(a.x), z: r2(a.z) })),
            wardens: living(this.combat, "below").length,
            wardensFallen: this.combat.actors.filter(a => a.faction === "below" && !alive(a)).length,
            aircraft: this.aircraft.map(a => ({ id: a.id, mode: a.mode, pos: a.pos.map(r2) })),
            radio: this.onAir().map(l => `${l.speaker}: ${l.text}`),
            stats: { ...this.stats, squadLost: this.squadLost() },
            flags: this.flags,
        };
    }
}

export { SCENES, chest };
export type { Subtitle, Bolt };
