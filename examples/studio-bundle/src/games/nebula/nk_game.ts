// Nebula Kingdom's simulation: the nebula you are (flight, feeding, siphoning worlds and stars,
// four blasts, the Pulse, the Veil, Shed, Starfire, the form you choose and the Grace or Ruin your
// deeds earn), the creatures and their governments (and the champions that yield to your mercy),
// the lightwaves they speak in, black holes (their pull, their shadows, the ones that hunt), goals,
// levels, the Field Guide that explains each new thing, and folding between regions and galaxies. Pure TypeScript: nothing here draws or
// touches the engine, so tests and the live tools play the same game the window does.
//
// Units: kilometres and seconds. Everything a creature or the player can do is scaled by its own
// radius, so the same rules hold for a Wisp the size of Luna and a Monarch wider than Antares.

import { Rng, add, sub, mul, dot, len, dist, norm, cross, clamp, forwardOf, basis, segmentDistance, type V3 } from "./nk_math";
import {
    ABILITIES, FACETS, FACET_MAX, FACTIONS, GOVERNMENTS, REGIONS, GALAXIES, SPECIES, BLASTS, BLAST_IDS, FORMS, FORM_LEVEL, LESSONS,
    radiusOfMass, massOfRadius, levelOfRadius, levelProgress, rankOf, regionById, galaxyById, isHostileStanding, garble, tierRadius, alignmentTier, graceKnit, ruinDamage,
    type AbilityId, type FacetId, type FactionId, type GoalDef, type BodyKind, type RegionDef, type BlastId, type FormId,
} from "./nk_data";
import { generateRegion, makeBody, makeCreature, type Region, type Body, type Creature, type Hole } from "./nk_world";

export interface NkInput {
    thrust: number; strafe: number; lift: number;
    /** Turn rates, -1..1 (right, up). */
    turnX: number; turnY: number;
    fire: boolean; surge: boolean; siphon: boolean;
    /** Pressed this frame. */
    pulse: boolean; veil: boolean; attune: boolean; decoy: boolean; flare: boolean; tribute: boolean;
    /** Instantaneous angle displacement in radians (e.g. from mouse look). */
    lookYaw?: number; lookPitch?: number;
    /** Pressed this frame: the next or previous blast you know, or one by name. */
    blastNext?: boolean; blastPrev?: boolean; blastPick?: BlastId | "";
}
export const NO_INPUT: NkInput = { thrust: 0, strafe: 0, lift: 0, turnX: 0, turnY: 0, fire: false, surge: false, siphon: false, pulse: false, veil: false, attune: false, decoy: false, flare: false, tribute: false, lookYaw: 0, lookPitch: 0 };

export interface Campaign {
    mass: number;
    facets: Record<FacetId, number>;
    points: number;
    standing: Record<FactionId, number>;
    /** Messages heard from each government (its tongue comes clear with listening). */
    lexicon: Record<FactionId, number>;
    completed: string[];
    goalsDone: Record<string, string[]>;
    region: string;
    crowned: boolean;
    stats: { absorbed: number; mined: number; stars: number; kills: number; dispersed: number; folds: number; time: number; spared: number; devoured: number };
    /** The blast {fire} throws. */
    blast: BlastId;
    /** The kind of nebula you chose to be ("" until you choose). */
    form: FormId | "";
    /** Grace (to 100) or Ruin (to -100): what your deeds have made you. */
    alignment: number;
    /** Lessons of the Field Guide already shown. */
    taught: string[];
}

export function newCampaign(): Campaign {
    const standing = {} as Record<FactionId, number>, lexicon = {} as Record<FactionId, number>;
    for (const f of Object.values(FACTIONS)) { standing[f.id] = f.standing; lexicon[f.id] = f.id === "concord" ? 6 : 0; }
    return {
        mass: 1, facets: { density: 0, radiance: 0, reach: 0, current: 0, resonance: 0, gravity: 0 }, points: 0,
        standing, lexicon, completed: [], goalsDone: {}, region: REGIONS[0].id, crowned: false,
        stats: { absorbed: 0, mined: 0, stars: 0, kills: 0, dispersed: 0, folds: 0, time: 0, spared: 0, devoured: 0 },
        blast: "lance", form: "", alignment: 0, taught: [],
    };
}

/** Fills in what a campaign saved before blasts, forms, Grace and the Field Guide did not have. */
export function normalizeCampaign(c: Campaign): Campaign {
    const d = newCampaign();
    c.stats = { ...d.stats, ...(c.stats ?? {}) };
    if (!c.blast || !BLASTS[c.blast]) c.blast = "lance";
    if (c.form && !FORMS[c.form]) c.form = "";
    c.form ??= "";
    if (typeof c.alignment !== "number" || !Number.isFinite(c.alignment)) c.alignment = 0;
    if (!Array.isArray(c.taught)) c.taught = [];
    return c;
}

export interface Player {
    pos: V3; vel: V3; yaw: number; pitch: number;
    radius: number; level: number;
    cohesion: number; charge: number;
    /** Seconds of being fed left (cohesion only knits while fed). */
    fed: number;
    /** Seconds since last harmed. */
    sinceHurt: number;
    veil: boolean; attune: boolean;
    /** 0..1: how far into a Lightstride. */
    stride: number;
    /** Seconds of slingshot speed left. */
    sling: number;
    cd: Record<AbilityId, number>;
    /** Seconds of Starfire left. */
    flare: number;
    /** Id of the body being siphoned (0: none). */
    siphon: number;
    invulnerable: number;
    alive: boolean; deadFor: number;
    tributeCd: number;
    /** Sunthread, while it is held: how far it reaches and which way. */
    beam: { on: boolean; length: number; dir: V3; target: number };
}

/** What made a bolt: a blast of yours (or one turned back), or a creature's. */
export type BoltKind = "lance" | "shard" | "seeker" | "foe";
export interface Bolt { pos: V3; vel: V3; radius: number; power: number; from: number; fromRadius: number; faction: FactionId | "player"; life: number; kind?: BoltKind; /** A Seeker's quarry (creature id; 0 while it looks). */ target?: number }

export type SignalKind = "edict" | "distress" | "chatter" | "thanks" | "threat" | "pulse" | "flare" | "plea";
export interface Signal {
    id: number; from: V3; t0: number; speed: number; range: number;
    faction: FactionId | "player"; speaker: string; text: string; kind: SignalKind;
    /** Who a distress call is about (-1 the player, or a creature id). */
    about: number;
    heard: boolean;
    reached: Set<number>;
}

export interface Decoy { pos: V3; vel: V3; mass: number; radius: number; life: number }
export interface Message { t: number; faction: FactionId | "player"; speaker: string; text: string; kind: SignalKind }
export interface GoalState { def: GoalDef; done: boolean; progress: number; total: number; locked: boolean }

export type GameEvent =
    | { kind: "absorb"; at: V3; radius: number; body: BodyKind }
    | { kind: "mined"; at: V3; name: string; body: BodyKind; radius: number }
    | { kind: "lance"; at: V3 }
    | { kind: "shot"; at: V3; faction: FactionId }
    | { kind: "impact"; at: V3; size: number; faction: FactionId | "player" }
    | { kind: "hurt"; amount: number }
    | { kind: "death"; at: V3; radius: number; species: string; faction: FactionId; name: string }
    | { kind: "swallowed"; at: V3; hole: string }
    | { kind: "pulse"; at: V3; radius: number }
    | { kind: "flare"; on: boolean }
    | { kind: "starflare"; at: V3; radius: number }
    | { kind: "decoy"; at: V3 }
    | { kind: "veil"; on: boolean }
    | { kind: "attune"; on: boolean }
    | { kind: "levelup"; level: number; rank: string; newRank: boolean; unlocked: string }
    | { kind: "goal"; text: string }
    | { kind: "regionComplete"; region: string; next: string }
    | { kind: "crowned" }
    | { kind: "message"; message: Message }
    | { kind: "torn"; hole: string }
    | { kind: "sling"; hole: string }
    | { kind: "merge"; at: V3; radius: number }
    | { kind: "banished"; at: V3; hole: string }
    | { kind: "fold"; to: string }
    | { kind: "arrive"; region: string }
    | { kind: "dispersed" }
    | { kind: "reformed" }
    | { kind: "tribute"; faction: FactionId; standing: number }
    | { kind: "crime"; faction: FactionId; text: string }
    | { kind: "wave"; n: number; of: number }
    | { kind: "toast"; text: string }
    | { kind: "lesson"; id: string; vars: Record<string, string> }
    | { kind: "deed"; amount: number; text: string; alignment: number }
    | { kind: "yield"; at: V3; name: string }
    | { kind: "spared"; at: V3; name: string; slipped: boolean }
    | { kind: "devoured"; at: V3; name: string }
    | { kind: "reflect"; at: V3; byYou: boolean }
    | { kind: "blink"; from: V3; to: V3 }
    | { kind: "burst"; at: V3; radius: number }
    | { kind: "split"; at: V3; name: string }
    | { kind: "ambush"; at: V3; name: string }
    | { kind: "blast"; id: BlastId }
    | { kind: "form"; id: FormId };

const CHATTER: Record<FactionId, string[]> = {
    concord: ["The shoal turns sunward at the next tide.", "A new Wisp in the Reach. Watch over it.", "Light to you, traveller.", "The Old Candle gutters. Let it rest - or let it feed someone."],
    drift: ["Comet ice, fresh from the lanes. No questions.", "Toll's gone up again.", "I'll trade you a moon for that gossip.", "Never deal with anything that has a horizon."],
    ember: ["More fuel for the Regent.", "I smell cloud. Burn it.", "The forges are hungry.", "Every star a furnace. Every cloud a spark."],
    synod: ["The Silence hears.", "Sing low: a Singer is near.", "The tide is rising in the deep.", "What falls is given."],
    hollow: ["...", "no light. no light. no light.", "the king is listening.", "come closer."],
    wild: ["(a hungry clicking)", "(a long, low call)", "(the snap of something feeding)", "(a warning flash)"],
};

let SIGNAL_ID = 1;
/** Seconds a beaten champion waits on your mercy before it slips away. */
export const YIELD_TIME = 30;

export class Game {
    campaign: Campaign;
    region!: Region;
    time = 0;
    /** Seconds in the current region. */
    regionTime = 0;
    player: Player;
    bolts: Bolt[] = [];
    signals: Signal[] = [];
    decoys: Decoy[] = [];
    messages: Message[] = [];
    goals: GoalState[] = [];
    events: GameEvent[] = [];
    /** A fold in progress: t runs 0..duration, the region changes at the midpoint. */
    fold: { to: string; t: number; duration: number; switched: boolean } | null = null;
    private rng = new Rng(20261111);
    private counts: Record<string, number> = {};
    private minedKeys = new Set<string>();
    private crimes = new Set<number>();
    private defend: { goal: string; wave: number; timer: number; alive: number[] } | null = null;
    private flags = new Set<string>();
    private chatterIn = 5;
    private spawnIn = 8;
    private baitIn = 4;
    private edictSent = false;
    private lessonIn = 0;

    constructor(campaign: Campaign = newCampaign()) {
        this.campaign = campaign;
        this.player = {
            pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, radius: radiusOfMass(campaign.mass), level: levelOfRadius(radiusOfMass(campaign.mass)),
            cohesion: 100, charge: 100, fed: 60, sinceHurt: 99, veil: false, attune: false, stride: 0, sling: 0,
            cd: { lance: 0, surge: 0, attune: 0, pulse: 0, veil: 0, decoy: 0, flare: 0 }, flare: 0, siphon: 0, invulnerable: 0,
            alive: true, deadFor: 0, tributeCd: 0, beam: { on: false, length: 0, dir: [0, 0, 1], target: 0 },
        };
        normalizeCampaign(campaign);
        this.enter(campaign.region);
        this.player.cohesion = this.maxCohesion;
        this.player.charge = this.maxCharge;
    }

    // --- Derived numbers ------------------------------------------------------------------------------

    get mass(): number { return this.campaign.mass; }
    get form(): FormId | "" { return this.campaign.form; }
    get maxCohesion(): number { return 100 * (1 + 0.12 * this.campaign.facets.density) * (this.form === "reflection" ? 1.15 : 1); }
    get maxCharge(): number { return 100 + 10 * this.campaign.facets.resonance; }
    get damageMul(): number { return (1 + 0.14 * this.campaign.facets.radiance) * (this.form === "emission" ? 1.2 : 1) * ruinDamage(this.campaign.alignment); }
    get siphonReach(): number { return this.player.radius * (3 + 0.36 * this.campaign.facets.reach); }
    get pullRange(): number { return this.player.radius * 4 * (1 + 0.4 * this.campaign.facets.gravity) * (this.form === "planetary" ? 1.5 : 1); }
    get forward(): V3 { return forwardOf(this.player.yaw, this.player.pitch); }
    get maxSpeed(): number {
        const p = this.player;
        const stride = p.stride > 0 ? 3 + 9 * p.stride * p.stride : 1;
        return p.radius * 2.6 * (1 + 0.08 * this.campaign.facets.current) * stride * (p.sling > 0 ? 1.8 : 1);
    }
    has(ability: AbilityId): boolean { return this.player.level >= ABILITIES[ability].level; }
    hasBlast(id: BlastId): boolean { return !!BLASTS[id] && this.player.level >= BLASTS[id].level; }
    get blasts(): BlastId[] { return BLAST_IDS.filter(id => this.hasBlast(id)); }
    get blast(): BlastId { return this.hasBlast(this.campaign.blast) ? this.campaign.blast : "lance"; }
    get alignment(): number { return this.campaign.alignment; }

    /** Chooses the blast {fire} throws. */
    selectBlast(id: BlastId): boolean {
        if (!this.hasBlast(id)) return false;
        if (this.campaign.blast !== id) { this.campaign.blast = id; this.player.beam.on = false; this.events.push({ kind: "blast", id }); }
        return true;
    }
    private cycleBlast(step: number): void {
        const known = this.blasts;
        if (known.length < 2) return;
        const i = Math.max(0, known.indexOf(this.blast));
        this.selectBlast(known[(i + step + known.length) % known.length]);
    }

    /** Becomes a kind of nebula. The first choice is free; changing it later costs a tenth of you. */
    chooseForm(id: FormId): { ok: boolean; why: string } {
        const c = this.campaign;
        if (!FORMS[id]) return { ok: false, why: "No such form" };
        if (this.player.level < FORM_LEVEL) return { ok: false, why: `You can choose a form at level ${FORM_LEVEL}` };
        if (c.form === id) return { ok: false, why: "You are already one" };
        if (c.form) { c.mass = Math.max(1, c.mass * 0.9); this.player.radius = radiusOfMass(c.mass); this.checkLevel(); }
        c.form = id;
        this.player.cohesion = Math.min(this.player.cohesion, this.maxCohesion);
        this.events.push({ kind: "form", id });
        return { ok: true, why: "" };
    }

    /** A lesson of the Field Guide, the first time it is needed. */
    teach(id: string, vars: Record<string, string> = {}): void {
        if (!LESSONS[id] || this.campaign.taught.includes(id)) return;
        this.campaign.taught.push(id);
        this.events.push({ kind: "lesson", id, vars });
    }

    /** A good or wicked act: Grace (positive) or Ruin (negative). */
    deed(amount: number, text: string): void {
        const c = this.campaign;
        c.alignment = clamp(c.alignment + amount, -100, 100);
        this.events.push({ kind: "deed", amount, text, alignment: c.alignment });
        this.teach("deeds");
    }
    standing(f: FactionId): number { return this.campaign.standing[f]; }
    fluency(f: FactionId | "player"): number {
        if (f === "player") return 1;
        const heard = this.campaign.lexicon[f] ?? 0;
        return f === "wild" ? 1 : clamp(heard / 6 + (this.campaign.standing[f] >= 25 ? 0.5 : 0));
    }

    /** The camera a player sees through (km): behind and above, pulling back in a Lightstride. */
    camera(): { pos: V3; target: V3; fov: number } {
        const p = this.player, f = this.forward, { up } = basis(f);
        const back = 8 * (1 + 0.45 * p.stride) * p.radius;
        return { pos: add(add(p.pos, mul(f, -back)), mul(up, 3.1 * p.radius)), target: add(add(p.pos, mul(f, 9 * p.radius)), mul(up, 1.2 * p.radius)), fov: 55 + 22 * p.stride };
    }

    // --- Regions and folding --------------------------------------------------------------------------

    unlocked(id: string): boolean {
        const i = REGIONS.findIndex(r => r.id === id);
        return i === 0 || this.campaign.completed.includes(id) || (i > 0 && this.campaign.completed.includes(REGIONS[i - 1].id));
    }

    canFold(id: string): { ok: boolean; why: string } {
        if (!REGIONS.some(r => r.id === id)) return { ok: false, why: "No such place" };
        if (!this.player.alive) return { ok: false, why: "You are dispersed" };
        if (this.fold) return { ok: false, why: "Already folding" };
        if (id === this.region.def.id) return { ok: false, why: "You are here" };
        if (!this.unlocked(id)) return { ok: false, why: "Your light has not reached it yet" };
        for (const h of this.region.holes) if (h.alive && dist(h.pos, this.player.pos) < h.radius * 3) return { ok: false, why: `${h.name} holds your light` };
        return { ok: true, why: "" };
    }

    /** Folds to another region, in this galaxy or any other: a couple of seconds, wherever it is. */
    startFold(id: string): boolean {
        if (!this.canFold(id).ok) return false;
        this.fold = { to: id, t: 0, duration: 2.6, switched: false };
        this.player.siphon = 0;
        this.events.push({ kind: "fold", to: id });
        return true;
    }

    enter(id: string): void {
        const def = regionById(id);
        this.region = generateRegion(def);
        this.campaign.region = id;
        this.regionTime = 0;
        this.bolts = []; this.signals = []; this.decoys = [];
        this.counts = {}; this.minedKeys = new Set(); this.crimes = new Set(); this.flags = new Set();
        this.defend = null; this.edictSent = false; this.chatterIn = 6; this.spawnIn = 10;
        const p = this.player;
        p.pos = [...this.region.entry]; p.vel = [0, 0, 0]; p.yaw = 0; p.pitch = 0; p.siphon = 0; p.stride = 0; p.flare = 0;
        const done = new Set(this.campaign.goalsDone[id] ?? []);
        this.goals = def.goals.map(g => ({ def: g, done: done.has(g.id), progress: 0, total: 1, locked: false }));
        // What was finished here stays finished.
        for (const g of this.goals) {
            if (!g.done) continue;
            const d = g.def;
            if (d.type === "mine" && d.keys) for (const k of d.keys) { const b = this.region.bodies.find(x => x.key === k); if (b) b.alive = false; this.minedKeys.add(k); }
            if (d.type === "clear") for (const c of this.region.creatures) if (c.group === d.group) c.alive = false;
            if (d.type === "defeat") for (const c of this.region.creatures) if (c.key === d.key) c.alive = false;
            if (d.type === "lure") { const h = this.region.holes.find(x => x.key === d.hole); if (h) h.alive = false; }
        }
        this.region.bodies = this.region.bodies.filter(b => b.alive);
        this.region.creatures = this.region.creatures.filter(c => c.alive);
        if (this.region.rift) this.region.rift.open = !def.goals.some(g => g.type === "lure" && g.to === "rift" && g.after?.length);
        this.updateGoals(true);
    }

    get regionComplete(): boolean { return this.campaign.completed.includes(this.region.def.id); }
    nextRegion(): RegionDef | null { const i = REGIONS.indexOf(this.region.def); return REGIONS[i + 1] ?? null; }

    // --- The step ---------------------------------------------------------------------------------------

    step(dt: number, input: NkInput = NO_INPUT): void {
        this.events = [];
        if (dt <= 0) return;
        this.time += dt; this.regionTime += dt; this.campaign.stats.time += dt;
        const p = this.player;
        if (this.fold) {
            const f = this.fold;
            f.t += dt;
            if (!f.switched && f.t >= f.duration * 0.5) { f.switched = true; this.campaign.stats.folds++; this.enter(f.to); this.events.push({ kind: "arrive", region: f.to }); }
            if (f.t >= f.duration) this.fold = null;
            p.invulnerable = Math.max(p.invulnerable, 1.5);
            return;
        }
        if (!p.alive) {
            p.deadFor += dt;
            this.stepWorld(dt);
            if (p.deadFor > 3.2) this.reform();
            return;
        }
        this.stepPlayer(dt, input);
        this.stepWorld(dt);
        this.stepFeeding(dt, input);
        this.updateGoals(false);
        this.checkLevel();
        this.stepLessons(dt);
        if (p.cohesion <= 0 && p.alive) {
            p.alive = false; p.deadFor = 0; p.siphon = 0; p.veil = false; p.flare = 0; p.beam.on = false;
            this.campaign.stats.dispersed++;
            this.events.push({ kind: "dispersed" });
            this.teach("dispersed");
        }
    }

    private reform(): void {
        const p = this.player;
        const floor = Math.max(1, massOfRadius(tierRadius(this.region.def.tier)) * 0.6);
        this.campaign.mass = Math.max(Math.min(this.campaign.mass, floor), this.campaign.mass * 0.85);
        p.radius = radiusOfMass(this.campaign.mass);
        p.alive = true; p.deadFor = 0; p.cohesion = this.maxCohesion; p.charge = this.maxCharge; p.fed = 60; p.invulnerable = 4;
        p.pos = [...this.region.entry]; p.vel = [0, 0, 0]; p.yaw = 0; p.pitch = 0;
        for (const c of this.region.creatures) { c.provoked = 0; if (c.target === -1) { c.state = "wander"; c.target = 0; } }
        this.bolts = [];
        this.events.push({ kind: "reformed" });
    }

    private stepPlayer(dt: number, input: NkInput): void {
        const p = this.player, c = this.campaign;
        p.yaw += clamp(input.turnX, -1, 1) * 1.9 * dt + (input.lookYaw ?? 0);
        p.pitch = clamp(p.pitch + clamp(input.turnY, -1, 1) * 1.5 * dt + (input.lookPitch ?? 0), -1.35, 1.35);
        const f = this.forward, { right, up } = basis(f);

        // Lightstride: hold to ride your own wave, faster the longer it is held. It carries you
        // forward on its own (a gamepad's trigger needs no stick with it); only backing off stops it.
        const striding = input.surge && p.charge > 1 && input.thrust > -0.1;
        if (striding) { p.stride = Math.min(1, p.stride + dt / 2.5); p.charge -= ABILITIES.surge.cost * dt; if (p.veil) this.setVeil(false); }
        else p.stride = Math.max(0, p.stride - dt * 1.6);
        p.sling = Math.max(0, p.sling - dt);

        const max = this.maxSpeed;
        let want: V3 = add(add(mul(f, input.thrust + (striding ? 1 : 0)), mul(right, input.strafe)), mul(up, input.lift));
        const wl = len(want);
        if (wl > 1) want = mul(want, 1 / wl);
        want = mul(want, max);
        const accel = max * (wl > 0.01 ? 2.6 : 1.3) * dt;
        const dv = sub(want, p.vel), dl = len(dv);
        p.vel = dl <= accel ? want : add(p.vel, mul(dv, accel / dl));

        for (const id of Object.keys(p.cd) as AbilityId[]) p.cd[id] = Math.max(0, p.cd[id] - dt);
        p.tributeCd = Math.max(0, p.tributeCd - dt);
        p.invulnerable = Math.max(0, p.invulnerable - dt);
        p.sinceHurt += dt;
        p.fed = Math.max(0, p.fed - dt);
        // Charge does not gather while it is being ridden.
        if (!striding && !p.beam.on) p.charge = Math.min(this.maxCharge, p.charge + 9 * (1 + 0.15 * c.facets.resonance) * dt);
        if (p.fed > 0 && p.sinceHurt > 4) p.cohesion = Math.min(this.maxCohesion, p.cohesion + 2.5 * graceKnit(c.alignment) * dt);

        if (input.attune) { p.attune = !p.attune; this.events.push({ kind: "attune", on: p.attune }); }
        if (input.veil && this.has("veil") && p.cd.veil <= 0) { this.setVeil(!p.veil); p.cd.veil = ABILITIES.veil.cooldown; }
        if (p.veil) { p.charge -= ABILITIES.veil.cost * (this.form === "dark" ? 0.4 : 1) * dt; if (p.charge <= 0) this.setVeil(false); }

        if (input.blastPick) this.selectBlast(input.blastPick);
        if (input.blastNext) this.cycleBlast(1);
        if (input.blastPrev) this.cycleBlast(-1);
        const blast = this.blast;
        if (blast === "beam") { if (input.fire) this.fireBeam(dt); else p.beam.on = false; }
        else {
            p.beam.on = false;
            if (input.fire && p.cd.lance <= 0 && p.charge >= BLASTS[blast].cost) {
                if (blast === "shard") this.fireShards();
                else if (blast === "seeker") this.fireSeekers();
                else this.fireLance();
            }
        }
        if (input.pulse && this.has("pulse") && p.cd.pulse <= 0 && p.charge >= ABILITIES.pulse.cost) this.pulse();
        if (input.decoy && this.has("decoy") && p.cd.decoy <= 0 && p.charge >= ABILITIES.decoy.cost && c.mass > 1.2) this.shed();
        if (input.flare && this.has("flare") && p.cd.flare <= 0 && p.charge >= ABILITIES.flare.cost) {
            p.charge -= ABILITIES.flare.cost; p.cd.flare = ABILITIES.flare.cooldown * (this.form === "emission" ? 0.7 : 1); p.flare = 2.5;
            if (p.veil) this.setVeil(false);
            this.events.push({ kind: "flare", on: true });
        }
        if (p.flare > 0) {
            p.flare -= dt;
            for (const cr of this.region.creatures) {
                if (!cr.alive || cr.yielding || !(this.hostile(cr) || cr.faction === "wild")) continue;
                const to = sub(cr.pos, p.pos), d = len(to);
                if (d < p.radius * 90 + cr.radius && dot(to, f) / (d || 1) > 0.965) this.hurtCreature(cr, 46 * dt * this.damageMul, p.radius, -1);
            }
            if (p.flare <= 0) this.events.push({ kind: "flare", on: false });
        }
        if (input.tribute) this.tribute();
    }

    private setVeil(on: boolean): void {
        if (this.player.veil === on) return;
        this.player.veil = on;
        this.events.push({ kind: "veil", on });
    }

    /** The hostile creature nearest the aim (within a narrow cone), or null. */
    aimTarget(): Creature | null {
        const p = this.player, f = this.forward;
        let best: Creature | null = null, bestScore = 0.985;
        for (const c of this.region.creatures) {
            if (!c.alive || !this.hostile(c) || (c.hidden && !p.attune)) continue;
            const to = sub(c.pos, p.pos), d = len(to);
            if (d > p.radius * 80 + c.radius) continue;
            // Big or close things are easier to hit: widen the cone by their angular size.
            const score = dot(to, f) / (d || 1) + Math.min(0.01, (c.radius / (d || 1)) * 0.02);
            if (score > bestScore) { bestScore = score; best = c; }
        }
        return best;
    }

    private fireLance(): void {
        const p = this.player, f = this.forward;
        p.charge -= ABILITIES.lance.cost; p.cd.lance = ABILITIES.lance.cooldown;
        if (p.veil) this.setVeil(false);
        const speed = p.radius * 18;
        let dir = f;
        const t = this.aimTarget();
        const from = add(p.pos, mul(f, p.radius * 0.9));
        if (t) {
            const lead = dist(t.pos, from) / speed;
            dir = norm(sub(add(t.pos, mul(t.vel, lead)), from), f);
        }
        this.bolts.push({ pos: from, vel: add(mul(dir, speed), mul(p.vel, 0.3)), radius: p.radius * 0.16, power: 10 * this.damageMul, from: -1, fromRadius: p.radius, faction: "player", life: 4.5, kind: "lance" });
        this.events.push({ kind: "lance", at: from });
    }

    /** Shardfall: seven shards in a close cone, toward the aim. */
    private fireShards(): void {
        const p = this.player, f = this.forward;
        p.charge -= BLASTS.shard.cost; p.cd.lance = BLASTS.shard.cooldown;
        if (p.veil) this.setVeil(false);
        const t = this.aimTarget();
        const aim = t ? norm(sub(t.pos, p.pos), f) : f;
        const { right, up } = basis(aim);
        const from = add(p.pos, mul(aim, p.radius * 0.9));
        for (let i = 0; i < 7; i++) {
            const a = (i / 7) * Math.PI * 2, k = i === 0 ? 0 : 0.13;
            const dir = norm(add(aim, add(mul(right, Math.cos(a) * k), mul(up, Math.sin(a) * k))));
            this.bolts.push({ pos: from, vel: add(mul(dir, p.radius * 16), mul(p.vel, 0.3)), radius: p.radius * 0.12, power: 4.2 * this.damageMul, from: -1, fromRadius: p.radius, faction: "player", life: 0.95, kind: "shard" });
        }
        this.events.push({ kind: "lance", at: from });
    }

    /** Seekers: three slow motes that find their own way to the nearest enemy. */
    private fireSeekers(): void {
        const p = this.player, f = this.forward, { right, up } = basis(f);
        p.charge -= BLASTS.seeker.cost; p.cd.lance = BLASTS.seeker.cooldown;
        if (p.veil) this.setVeil(false);
        const t = this.aimTarget();
        for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2;
            const dir = norm(add(f, add(mul(right, Math.cos(a) * 0.5), mul(up, Math.sin(a) * 0.5))));
            this.bolts.push({ pos: add(p.pos, mul(dir, p.radius)), vel: mul(dir, p.radius * 9), radius: p.radius * 0.18, power: 7 * this.damageMul, from: -1, fromRadius: p.radius, faction: "player", life: 7, kind: "seeker", target: t?.id ?? 0 });
        }
        this.events.push({ kind: "lance", at: [...p.pos] });
    }

    /** Sunthread: a held ray that burns the first thing along it. */
    private fireBeam(dt: number): void {
        const p = this.player, f = this.forward;
        const cost = BLASTS.beam.cost * dt;
        if (p.charge < cost) { p.beam.on = false; return; }
        p.charge -= cost;
        if (p.veil) this.setVeil(false);
        const t = this.aimTarget();
        const dir = t ? norm(sub(t.pos, p.pos), f) : f;
        const from = add(p.pos, mul(dir, p.radius * 0.9));
        let length = p.radius * 45, hit: Creature | null = null;
        const along = (pos: V3, r: number): number => {
            const to = sub(pos, from), a = dot(to, dir);
            if (a < -r || a > length + r) return -1;
            return len(sub(to, mul(dir, a))) < r ? Math.max(0, a - r * 0.6) : -1;
        };
        for (const c of this.region.creatures) {
            if (!c.alive) continue;
            const a = along(c.pos, c.radius + p.radius * 0.15);
            if (a >= 0 && a < length) { length = a; hit = c; }
        }
        for (const b of this.region.bodies) {
            if (!b.alive || b.kind === "mote" || b.kind === "essence" || b.radius < p.radius * 0.3) continue;
            const a = along(b.pos, b.radius);
            if (a >= 0 && a < length) { length = a; hit = null; }
        }
        if (!p.beam.on) this.events.push({ kind: "lance", at: from });
        p.beam = { on: true, length: length + p.radius * 0.9, dir, target: hit?.id ?? 0 };
        if (hit) this.hurtCreature(hit, 40 * dt * this.damageMul * (hit.species.trait === "reflect" ? 1.5 : 1), p.radius, -1);
    }

    private pulse(): void {
        const p = this.player;
        p.charge -= ABILITIES.pulse.cost; p.cd.pulse = ABILITIES.pulse.cooldown;
        if (p.veil) this.setVeil(false);
        const reach = p.radius * 10 * (this.form === "planetary" ? 1.4 : 1);
        if (this.form === "planetary") p.cohesion = Math.min(this.maxCohesion, p.cohesion + 10);
        for (const c of this.region.creatures) {
            if (!c.alive || c.yielding) continue;
            const to = sub(c.pos, p.pos), d = len(to);
            if (d > reach + c.radius) continue;
            // Friends ride the wave; it only bites what means you harm.
            if (this.hostile(c) || c.faction === "wild") this.hurtCreature(c, 9 * this.damageMul, p.radius, -1);
            const shove = clamp((p.radius / c.radius) ** 1.5, 0.1, 3) * p.radius * 9;
            c.vel = add(c.vel, mul(norm(to, [0, 1, 0]), shove));
            if (c.species.temper === "prey" || c.species.temper === "herd") { c.state = "flee"; c.think = 3; }
        }
        this.bolts = this.bolts.filter(b => b.from === -1 || dist(b.pos, p.pos) > reach);
        this.emit({ from: [...p.pos], faction: "player", speaker: "You", text: "", kind: "pulse", range: reach, speed: reach / 0.45 });
        this.events.push({ kind: "pulse", at: [...p.pos], radius: reach });
    }

    private shed(): void {
        const p = this.player, c = this.campaign;
        p.charge -= ABILITIES.decoy.cost; p.cd.decoy = ABILITIES.decoy.cooldown * (this.form === "dark" ? 0.5 : 1);
        const m = c.mass * 0.06;
        c.mass -= m;
        p.radius = radiusOfMass(c.mass);
        const f = this.forward;
        const d: Decoy = { pos: add(p.pos, mul(f, -p.radius * 2.2)), vel: mul(f, -p.radius * 0.6), mass: m, radius: radiusOfMass(m), life: 26 };
        this.decoys.push(d);
        for (const cr of this.region.creatures) if (cr.alive && cr.state === "hunt" && cr.target === -1 && this.rng.next() < 0.7) cr.target = -2;
        this.events.push({ kind: "decoy", at: [...d.pos] });
    }

    private tribute(): void {
        const p = this.player, c = this.campaign;
        if (p.tributeCd > 0) return;
        // A champion that has yielded is spared by the same gesture.
        let beggar: Creature | null = null;
        for (const cr of this.region.creatures) if (cr.alive && cr.yielding && dist(cr.pos, p.pos) - cr.radius < p.radius * 14 && (!beggar || dist(cr.pos, p.pos) < dist(beggar.pos, p.pos))) beggar = cr;
        if (beggar) { this.spare(beggar, false); p.tributeCd = 1; return; }
        if (c.mass < 1.3) return;
        let envoy: Creature | null = null, best = Infinity;
        for (const cr of this.region.creatures) {
            if (!cr.alive || cr.species.id !== "envoy") continue;
            const d = dist(cr.pos, p.pos) - cr.radius;
            if (d < p.radius * 9 && d < best) { best = d; envoy = cr; }
        }
        if (!envoy) { this.events.push({ kind: "toast", text: "No envoy is near enough to receive tribute" }); return; }
        c.mass *= 0.95;
        p.radius = radiusOfMass(c.mass);
        p.tributeCd = 2.5;
        this.addStanding(envoy.faction, 12);
        this.flags.add(`tribute:${envoy.faction}`);
        this.deed(2, `Tribute to ${FACTIONS[envoy.faction].name}`);
        this.emit({ from: [...envoy.pos], faction: envoy.faction, speaker: envoy.name, text: "Your tribute is received. It will be remembered.", kind: "thanks" });
        this.events.push({ kind: "tribute", faction: envoy.faction, standing: c.standing[envoy.faction] });
    }

    addStanding(f: FactionId, amount: number): void {
        if (f === "wild") return;
        this.campaign.standing[f] = clamp(this.campaign.standing[f] + amount, -100, 100);
    }

    /** Whether a creature treats the player as an enemy right now. */
    hostile(c: Creature): boolean {
        if (c.yielding) return false;
        if (c.provoked > 0) return true;
        if (c.species.attack === "none") return false;
        if (c.faction !== "wild") return isHostileStanding(this.campaign.standing[c.faction]) && c.species.temper !== "civil";
        return c.species.temper === "predator";
    }

    private hurtPlayer(amount: number): void {
        const p = this.player;
        if (p.invulnerable > 0 || !p.alive || amount <= 0) return;
        // A nebula is hard to hurt: what strikes it mostly passes through.
        const dealt = amount * 0.55 * (1 - 0.05 * this.campaign.facets.density);
        p.cohesion -= dealt;
        p.sinceHurt = 0;
        this.events.push({ kind: "hurt", amount: dealt });
    }

    /** Damage of a hit: `power` against something its own size, scaled by how the sizes compare. */
    static scaled(power: number, attackerRadius: number, targetRadius: number): number {
        return power * clamp((attackerRadius / targetRadius) ** 1.5, 0.12, 6);
    }

    /** `by`: -1 the player, a creature id, or 0 the world. */
    hurtCreature(c: Creature, power: number, attackerRadius: number, by: number): void {
        if (!c.alive) return;
        if (c.yielding) {
            // Strike one that has yielded (once it has had a moment to say so) and it is devoured.
            if (by === -1 && c.yieldFor < YIELD_TIME - 0.6) this.devour(c);
            return;
        }
        c.hidden = false;
        c.hp -= Game.scaled(power, attackerRadius, c.radius);
        c.hurt = 0.3;
        if (c.yieldable && by === -1 && c.hp <= c.maxHp * 0.15) { c.hp = c.maxHp * 0.15; this.yieldTo(c); return; }
        if (by === -1) {
            if (c.provoked <= 0 && c.faction !== "wild" && !isHostileStanding(this.campaign.standing[c.faction])) this.addStanding(c.faction, -3);
            c.provoked = 30;
            if (c.species.attack !== "none") { c.state = "hunt"; c.target = -1; } else { c.state = "flee"; c.think = 4; }
        } else if (by > 0 && c.species.attack !== "none" && c.state !== "hunt") { c.state = "hunt"; c.target = by; }
        if (c.cried > 7 && c.hp > 0) {
            c.cried = 0;
            const text = c.faction === "wild" ? "(a shriek of pain)" : by === -1 ? "Aid! A cloud strikes at me!" : "Aid! We are attacked!";
            this.emit({ from: [...c.pos], faction: c.faction, speaker: c.name, text, kind: "distress", about: by });
        }
        if (c.hp <= 0) this.kill(c, by === -1);
    }

    private kill(c: Creature, byPlayer: boolean): void {
        c.alive = false; c.state = "dead";
        this.events.push({ kind: "death", at: [...c.pos], radius: c.radius, species: c.species.id, faction: c.faction, name: c.name });
        const p = this.player;
        if (c.affix === "volatile") {
            // It bursts: everything close is caught in it.
            const reach = c.radius * 4.5;
            this.events.push({ kind: "burst", at: [...c.pos], radius: reach });
            if (p.alive && dist(p.pos, c.pos) < reach + p.radius) this.hurtPlayer(Game.scaled(c.power * 2.2, c.radius, p.radius));
        }
        if (c.species.trait === "split" && c.gen === 0) {
            const { right } = basis(c.dir);
            for (const side of [-1, 1]) {
                const half = makeCreature(this.region, c.species.id, add(c.pos, mul(right, side * c.radius * 0.7)), { faction: c.faction, boss: c.boss * 0.62, group: c.group, gen: 1, phase: this.rng.next(), affix: c.affix === "volatile" ? "" : c.affix });
                half.vel = mul(right, side * half.speed);
                if (byPlayer) { half.state = "hunt"; half.target = -1; half.provoked = 20; }
            }
            this.events.push({ kind: "split", at: [...c.pos], name: c.name });
        }
        // What it was made of is left behind as loose essence; Ruin wrings out a little more.
        const n = (c.boss > 1.2 ? 5 : 2) + (byPlayer && this.campaign.alignment <= -60 ? 1 : 0);
        for (let i = 0; i < n; i++) {
            const b = makeBody(this.region, "essence", "light", add(c.pos, mul(this.rng.ball(), c.radius)), c.radius * 0.42 / Math.cbrt(n / 2), this.rng.next());
            b.vel = mul(this.rng.dir(), c.radius * 0.4);
        }
        if (byPlayer) {
            this.campaign.stats.kills++;
            if (!c.species.menace && !c.yieldable && c.wave < 0) this.deed(-3, `You killed ${c.name}, who meant you no harm`);
            if (c.faction !== "wild") {
                this.addStanding(c.faction, -4);
                for (const e of FACTIONS[c.faction].enemies) this.addStanding(e, 2);
            }
        }
    }

    // --- Mercy and hunger ------------------------------------------------------------------------------

    private yieldTo(c: Creature): void {
        c.yielding = true; c.yieldFor = YIELD_TIME; c.provoked = 0; c.state = "wander"; c.target = 0;
        c.vel = mul(c.vel, 0.2);
        for (const o of this.region.creatures) if (o.target === c.id) { o.state = "wander"; o.target = 0; }
        this.emit({ from: [...c.pos], faction: c.faction, speaker: c.name, text: "Enough! I yield. Spare me, cloud, and I will trouble no one again.", kind: "plea" });
        this.events.push({ kind: "yield", at: [...c.pos], name: c.name });
        this.teach("yield", { name: c.name });
    }

    /** Lets a champion that yielded go: Grace. */
    spare(c: Creature, slipped: boolean): void {
        if (!c.alive || !c.yielding) return;
        c.alive = false; c.state = "dead";
        this.campaign.stats.spared++;
        if (!slipped) this.addStanding(c.faction, 6);
        this.emit({ from: [...c.pos], faction: c.faction, speaker: c.name, text: slipped ? "(it slips away into the dark)" : "You are merciful. I will not forget it.", kind: "thanks" });
        this.events.push({ kind: "spared", at: [...c.pos], name: c.name, slipped });
        this.deed(slipped ? 4 : 12, slipped ? `You let ${c.name} go` : `You spared ${c.name}`);
    }

    /** Takes a champion that yielded into yourself: Ruin, and a great deal of it to grow on. */
    private devour(c: Creature): void {
        if (!c.alive) return;
        this.campaign.stats.devoured++;
        this.gain(massOfRadius(c.radius) * 0.05);
        c.yielding = false;
        this.events.push({ kind: "devoured", at: [...c.pos], name: c.name });
        this.kill(c, true);
        this.deed(-12, `You devoured ${c.name}`);
    }

    // --- Lightwaves -------------------------------------------------------------------------------------

    /** Sends a lightwave: it spreads at the speed of (this game's) light and is heard as it arrives. */
    emit(s: { from: V3; faction: FactionId | "player"; speaker: string; text: string; kind: SignalKind; about?: number; range?: number; speed?: number }): Signal {
        const scale = this.region.scale;
        const sig: Signal = { id: SIGNAL_ID++, from: s.from, t0: this.time, speed: s.speed ?? 45 * scale, range: s.range ?? 130 * scale, faction: s.faction, speaker: s.speaker, text: s.text, kind: s.kind, about: s.about ?? 0, heard: s.kind === "pulse" || s.kind === "flare", reached: new Set() };
        this.signals.push(sig);
        return sig;
    }

    /** A black hole stands between two points: no lightwave crosses its shadow. */
    shadowed(a: V3, b: V3): Hole | null {
        for (const h of this.region.holes) if (h.alive && segmentDistance(h.pos, a, b) < h.radius * 2.5) return h;
        return null;
    }

    private stepSignals(): void {
        const p = this.player;
        for (const s of this.signals) {
            const r = (this.time - s.t0) * s.speed;
            if (!s.heard && dist(s.from, p.pos) <= r) {
                s.heard = true;
                const hole = this.shadowed(s.from, p.pos);
                if (hole) {
                    if (!this.flags.has("shadow-told")) { this.flags.add("shadow-told"); this.events.push({ kind: "toast", text: `A lightwave was lost in ${hole.name}'s shadow` }); }
                } else {
                    const fl = this.fluency(s.faction);
                    const m: Message = { t: this.time, faction: s.faction, speaker: s.speaker, text: garble(s.text, fl, s.id), kind: s.kind };
                    this.messages.push(m);
                    if (this.messages.length > 40) this.messages.shift();
                    if (s.faction !== "player") this.teach("lightwaves");
                    if (s.faction !== "player") this.campaign.lexicon[s.faction] = (this.campaign.lexicon[s.faction] ?? 0) + (p.attune ? 2 : 1);
                    this.events.push({ kind: "message", message: m });
                }
            }
            if (s.kind !== "distress") continue;
            for (const c of this.region.creatures) {
                if (!c.alive || c.faction !== s.faction || s.reached.has(c.id) || c.species.attack === "none") continue;
                if (dist(c.pos, s.from) > r) continue;
                s.reached.add(c.id);
                if (this.shadowed(s.from, c.pos)) continue;
                if (s.about === -1) { c.provoked = Math.max(c.provoked, 25); c.state = "hunt"; c.target = -1; }
                else if (s.about > 0 && c.state !== "hunt") { c.state = "hunt"; c.target = s.about; }
            }
        }
        this.signals = this.signals.filter(s => (this.time - s.t0) * s.speed < s.range);
    }

    // --- The world --------------------------------------------------------------------------------------

    private gravity(pos: V3, dt: number): V3 {
        let a: V3 = [0, 0, 0];
        for (const h of this.region.holes) {
            if (!h.alive) continue;
            const to = sub(h.pos, pos), d = Math.max(len(to), h.radius * 0.5);
            a = add(a, mul(to, (3 * h.radius * (h.radius / d) ** 2 * dt) / d));
        }
        return a;
    }

    private stepWorld(dt: number): void {
        const p = this.player, region = this.region, scale = region.scale;

        // Edict and ambient talk: the place speaks, in light.
        if (!this.edictSent && this.regionTime > 1.2) {
            this.edictSent = true;
            const gov = galaxyById(region.def.galaxy).government;
            const envoy = region.creatures.find(c => c.alive && c.species.id === "envoy");
            this.emit({ from: envoy ? [...envoy.pos] : add(p.pos, [0, 0, 20 * scale]), faction: envoy?.faction ?? gov, speaker: envoy?.name ?? FACTIONS[gov].name, text: region.def.edict, kind: "edict", range: 600 * scale, speed: 90 * scale });
        }
        this.chatterIn -= dt;
        if (this.chatterIn <= 0) {
            this.chatterIn = this.rng.range(7, 13);
            const near = region.creatures.filter(c => c.alive && c.state !== "hunt" && dist(c.pos, p.pos) < 90 * scale);
            if (near.length) {
                const c = this.rng.pick(near);
                this.emit({ from: [...c.pos], faction: c.faction, speaker: c.name, text: this.rng.pick(CHATTER[c.faction]), kind: "chatter", range: 100 * scale });
            }
        }
        this.stepSignals();

        // Player motion: black holes pull, tear and fling.
        if (p.alive) {
            p.vel = add(p.vel, this.gravity(p.pos, dt));
            p.pos = add(p.pos, mul(p.vel, dt));
            for (const h of region.holes) {
                if (!h.alive) continue;
                const d = dist(h.pos, p.pos);
                if (d < h.radius * 0.95 && p.invulnerable <= 0) this.tear(h);
                else if (d < h.radius * 1.6) this.hurtPlayer(14 * dt);
                if (d < h.radius * 2.2) h.grazing = true;
                else if (h.grazing && d > h.radius * 3) {
                    h.grazing = false;
                    p.sling = 6;
                    p.vel = mul(p.vel, 1.5);
                    this.flags.add(`sling:${h.key}`);
                    this.events.push({ kind: "sling", hole: h.name });
                }
            }
        }

        for (const b of region.bodies) {
            if (!b.alive) continue;
            b.drain = Math.max(0, b.drain - dt * 2);
            if (b.orbit) {
                const c = region.bodies.find(x => x.id === b.orbit!.around);
                if (c && c.alive) { b.orbit.phase += b.orbit.speed * dt; b.pos = add(c.pos, [Math.cos(b.orbit.phase) * b.orbit.r, 0, Math.sin(b.orbit.phase) * b.orbit.r]); }
            } else if (b.vel[0] || b.vel[1] || b.vel[2]) {
                b.pos = add(b.pos, mul(b.vel, dt));
                if (b.kind === "essence") b.vel = mul(b.vel, Math.max(0, 1 - dt * 0.8));
            }
        }

        for (const d of this.decoys) { d.life -= dt; d.pos = add(d.pos, mul(d.vel, dt)); d.vel = mul(d.vel, Math.max(0, 1 - dt)); }
        this.decoys = this.decoys.filter(d => d.life > 0);

        this.stepHoles(dt);
        this.stepCreatures(dt);
        this.stepBolts(dt);
        this.stepWaves(dt);

        // A hunting hole with a spawner keeps sending thralls.
        const sp = region.def.spawner;
        if (sp && p.alive) {
            this.spawnIn -= dt;
            const hole = region.holes.find(h => h.key === sp.hole && h.alive);
            if (this.spawnIn <= 0 && hole) {
                this.spawnIn = sp.every;
                if (region.creatures.filter(c => c.alive && c.wave === -2).length < sp.cap) {
                    const c = makeCreature(region, sp.species, add(hole.pos, mul(this.rng.dir(), hole.radius * 3.2)), { wave: -2, phase: this.rng.next() });
                    c.state = "hunt"; c.target = -1; c.provoked = 1e9;
                }
            }
        }
        // An open "feed" goal never runs out of creatures to trick: more arrive.
        for (const g of this.goals) {
            const d = g.def;
            if (d.type !== "feed" || g.done || !p.alive) continue;
            const hole = region.holes.find(h => h.key === d.hole);
            if (!hole) continue;
            const left = d.count - hole.fed;
            if (region.creatures.filter(c => c.alive && c.species.menace && c.species.attack === "ram").length >= left) continue;
            this.baitIn -= dt;
            if (this.baitIn > 0) continue;
            this.baitIn = 9;
            const from = add(hole.pos, mul(this.rng.dir(), 45 * region.scale));
            for (let i = 0; i < 2; i++) {
                const c = makeCreature(region, d.bait, add(from, mul(this.rng.ball(), 5 * region.scale)), { wave: -3, phase: this.rng.next() });
                c.state = "hunt"; c.target = -1; c.provoked = 120;
            }
            this.events.push({ kind: "toast", text: `More ${SPECIES[d.bait].name}s are coming` });
        }
        region.creatures = region.creatures.filter(c => c.alive);
        region.bodies = region.bodies.filter(b => b.alive);
    }

    private tear(h: Hole): void {
        const p = this.player, c = this.campaign;
        c.mass = Math.max(1, c.mass * 0.65);
        p.radius = radiusOfMass(c.mass);
        p.cohesion = Math.min(p.cohesion, this.maxCohesion * 0.25);
        const away = norm(sub(p.pos, h.pos), [0, 1, 0]);
        p.pos = add(h.pos, mul(away, h.radius * 4.5));
        p.vel = mul(away, p.radius * 5);
        p.invulnerable = 2.5; p.sinceHurt = 0; p.siphon = 0;
        h.grazing = false;
        this.events.push({ kind: "torn", hole: h.name });
    }

    private stepHoles(dt: number): void {
        const p = this.player, region = this.region;
        for (const h of region.holes) {
            if (!h.alive || h.hunts <= 0) continue;
            const lure = this.goals.find(g => g.def.type === "lure" && g.def.hole === h.key);
            const starved = !lure || !lure.locked;
            // It goes for whatever pulls on it hardest: mass over distance squared. Shed mass is dense.
            let best: V3 | null = null, bestPull = 0;
            if (p.alive) { const d = dist(p.pos, h.pos); bestPull = this.mass / (d * d); best = p.pos; }
            if (starved) for (const d of this.decoys) {
                const dd = Math.max(dist(d.pos, h.pos), h.radius * 0.2);
                const pull = (d.mass * 400) / (dd * dd);
                if (pull > bestPull) { bestPull = pull; best = d.pos; }
            }
            if (!best) continue;
            const to = sub(best, h.pos), d = len(to);
            if (d > h.radius * 0.05) h.pos = add(h.pos, mul(to, Math.min(1, (h.hunts * dt) / d)));
            // Decoys it reaches are gone.
            this.decoys = this.decoys.filter(x => dist(x.pos, h.pos) > h.radius);
        }
        // A hole led into the rift is banished; led into another hole, they merge.
        for (const g of this.goals) {
            const d = g.def;
            if (d.type !== "lure" || g.done || g.locked) continue;
            const h = region.holes.find(x => x.key === d.hole && x.alive);
            if (!h) continue;
            if (d.to === "rift" && region.rift?.open) {
                if (dist(h.pos, region.rift.pos) < region.rift.radius) {
                    h.alive = false;
                    this.flags.add(`lure:${h.key}`);
                    this.events.push({ kind: "banished", at: [...h.pos], hole: h.name });
                    this.deed(8, `You sent ${h.name} out of the universe`);
                }
            } else {
                const other = region.holes.find(x => x.key === d.to && x.alive);
                if (other && dist(h.pos, other.pos) < h.radius + other.radius) {
                    h.alive = false;
                    other.radius += h.radius;
                    this.flags.add(`lure:${h.key}`);
                    // The merger rings space like a bell: everything hostile for a long way is undone.
                    const reach = 400 * region.scale;
                    for (const c of region.creatures) if (c.alive && c.species.menace && dist(c.pos, other.pos) < reach) { c.hp = 0; this.kill(c, true); }
                    const pd = dist(p.pos, other.pos);
                    if (p.alive) { p.vel = add(p.vel, mul(norm(sub(p.pos, other.pos)), p.radius * 12)); if (pd < other.radius * 6) this.hurtPlayer(20); }
                    this.emit({ from: [...other.pos], faction: "player", speaker: "", text: "", kind: "pulse", range: reach, speed: reach / 3 });
                    this.events.push({ kind: "merge", at: [...other.pos], radius: other.radius });
                }
            }
        }
        region.holes = region.holes.filter(h => h.alive);
    }

    private targetOf(c: Creature): { pos: V3; vel: V3; radius: number } | null {
        if (c.target === -1) return this.player.alive ? this.player : null;
        if (c.target === -2) { const d = this.decoys[0]; return d ? { pos: d.pos, vel: d.vel, radius: d.radius } : null; }
        if (c.target > 0) { const t = this.region.creatures.find(x => x.id === c.target && x.alive); return t ?? null; }
        return null;
    }

    private stepCreatures(dt: number): void {
        const p = this.player, region = this.region, scale = region.scale;
        for (const c of region.creatures) {
            if (!c.alive) continue;
            c.provoked = Math.max(0, c.provoked - dt);
            c.cooldown -= dt; c.think -= dt; c.cried += dt; c.hurt = Math.max(0, c.hurt - dt);
            c.phase += dt * (1 + len(c.vel) / (c.speed || c.radius));
            const toPlayer = sub(p.pos, c.pos), pd = len(toPlayer);
            const sight = c.sight * (p.veil ? 0.25 : 1) * (this.form === "dark" ? 0.8 : 1);

            // A Lurker lies still and dark until something worth striking drifts close.
            if (c.hidden) {
                c.vel = mul(c.vel, Math.max(0, 1 - dt * 2));
                c.pos = add(c.pos, mul(c.vel, dt));
                if (p.alive && this.hostile(c) && pd < c.radius * 2 + p.radius * (p.veil ? 2.5 : 7)) {
                    c.hidden = false; c.state = "hunt"; c.target = -1; c.provoked = Math.max(c.provoked, 15);
                    c.vel = mul(norm(toPlayer), c.speed * 1.6);
                    this.events.push({ kind: "ambush", at: [...c.pos], name: c.name });
                    this.teach("species:lurker");
                }
                continue;
            }
            // A champion that has yielded drifts, waiting on your mercy, and in time slips away.
            if (c.yielding) {
                c.yieldFor -= dt;
                c.vel = mul(norm(mul(toPlayer, -1), c.dir), c.speed * 0.12);
                c.pos = add(add(c.pos, mul(c.vel, dt)), mul(this.gravity(c.pos, dt), dt));
                if (c.yieldFor <= 0) this.spare(c, true);
                continue;
            }

            if (c.think <= 0 && c.state !== "flee") {
                c.think = 0.45 + this.rng.next() * 0.3;
                // Who to go after: the player if hostile and seen, or the nearest enemy of its government.
                let target = 0, best = Infinity;
                if (p.alive && this.hostile(c) && pd < sight + p.radius) {
                    // A beast will not pick a fight with something far bigger than it is.
                    const outmatched = c.faction === "wild" && c.provoked <= 0 && c.boss <= 1.2 && p.radius > c.radius * 2.6;
                    if (outmatched) { c.state = "flee"; c.think = 2.5; continue; }
                    target = this.decoys.length && c.target === -2 ? -2 : -1; best = pd * 0.8;
                }
                if (c.species.attack !== "none" && (c.species.temper === "soldier" || c.species.temper === "predator")) {
                    const enemies = c.faction === "wild" ? null : FACTIONS[c.faction].enemies;
                    for (const o of region.creatures) {
                        if (o === c || !o.alive) continue;
                        const foe = enemies ? enemies.includes(o.faction) : (o.faction !== "wild" && o.species.temper === "herd" && o.radius < c.radius * 1.4 && c.species.id === "skimmer");
                        if (!foe) continue;
                        const d = dist(o.pos, c.pos);
                        if (d < c.sight && d < best) { best = d; target = o.id; }
                    }
                }
                if (target) { c.state = "hunt"; c.target = target; }
                else if (c.state === "hunt" && !this.targetOf(c)) { c.state = "wander"; c.target = 0; }
                else if (c.state === "hunt" && c.target === -1 && !this.hostile(c)) { c.state = "wander"; c.target = 0; }
                else if (c.state === "hunt" && c.target === -1 && pd > sight * 1.5 + p.radius) { c.state = "wander"; c.target = 0; }
            }
            if (c.state === "flee" && c.think <= 0) { c.state = "wander"; c.think = 0.5; }

            let want: V3 = [0, 0, 0];
            let face: V3 | null = null;
            if (c.state === "hunt") {
                const t = this.targetOf(c);
                if (!t) { c.state = "wander"; c.target = 0; }
                else {
                    const to = sub(t.pos, c.pos), d = len(to), dir = norm(to, c.dir);
                    face = dir;
                    const touch = c.radius + t.radius * 0.8;
                    if (c.species.attack === "ram") {
                        want = mul(dir, c.speed);
                        if (d < touch && c.cooldown <= 0) {
                            c.cooldown = 1.3;
                            this.strike(c, c.power);
                            c.vel = mul(dir, -c.speed * 0.9);
                        }
                    } else if (c.species.attack === "sting") {
                        want = mul(dir, d > touch ? c.speed : 0);
                        if (d < c.radius * 2.4 + t.radius) this.strike(c, c.power * 1.5 * dt);
                    } else if (c.species.attack === "bolt") {
                        const pref = c.radius * 9 + t.radius;
                        if (d > pref * 1.25) want = mul(dir, c.speed);
                        else if (d < pref * 0.6) want = mul(dir, -c.speed * 0.7);
                        else want = mul(norm(cross(dir, [0, 1, 0]), [1, 0, 0]), c.speed * 0.5 * (c.id % 2 ? 1 : -1));
                        if (c.cooldown <= 0 && d < c.sight * 1.2) {
                            c.cooldown = (c.species.id === "spire" ? 0.9 : 1.7) / Math.sqrt(c.boss);
                            const speed = Math.max(c.radius, scale * 0.5) * 12;
                            const aim = norm(sub(add(t.pos, mul(t.vel, d / speed)), c.pos), dir);
                            this.bolts.push({ pos: add(c.pos, mul(aim, c.radius)), vel: mul(aim, speed), radius: c.radius * 0.18, power: c.power, from: c.id, fromRadius: c.radius, faction: c.faction, life: 5 });
                            this.events.push({ kind: "shot", at: [...c.pos], faction: c.faction });
                        }
                    }
                }
            } else if (c.state === "flee") {
                want = mul(norm(mul(toPlayer, -1), c.dir), c.speed * 1.15);
            }
            // A Wraith folds space to land beside what it hunts.
            if (c.species.trait === "blink") {
                c.blinkIn -= dt;
                const t = c.state === "hunt" ? this.targetOf(c) : null;
                if (t && c.blinkIn <= 0 && dist(t.pos, c.pos) > c.radius * 6 + t.radius) {
                    const to = add(t.pos, mul(this.rng.dir(), t.radius + c.radius * 2.4));
                    if (!region.holes.some(h => h.alive && dist(h.pos, to) < h.radius * 2.5)) {
                        this.events.push({ kind: "blink", from: [...c.pos], to });
                        c.pos = to; c.vel = [0, 0, 0]; c.blinkIn = 5.5;
                        if (t === p) this.teach("species:wraith");
                    } else c.blinkIn = 1;
                }
            }
            if (c.state === "wander") {
                if (dist(c.pos, c.wanderTo) < c.radius * 2 + scale || this.rng.next() < dt * 0.05) c.wanderTo = add(c.home, mul(this.rng.ball(), (c.species.temper === "herd" ? 7 : 11) * scale));
                want = mul(norm(sub(c.wanderTo, c.pos), c.dir), c.speed * 0.32);
                // Creatures going about their day keep clear of horizons. Hunters forget to.
                for (const h of region.holes) {
                    const away = sub(c.pos, h.pos), d = len(away);
                    if (d < h.radius * 5) want = add(want, mul(norm(away), c.speed * 0.9));
                }
            }
            const accel = Math.max(c.speed, c.radius) * 2.2 * dt;
            const dv = sub(want, c.vel), dl = len(dv);
            c.vel = dl <= accel ? want : add(c.vel, mul(dv, accel / dl));
            c.vel = add(c.vel, this.gravity(c.pos, dt));
            if (c.species.speed === 0) c.vel = [0, 0, 0];
            c.pos = add(c.pos, mul(c.vel, dt));
            const heading = face ?? (len(c.vel) > c.radius * 0.05 ? norm(c.vel) : null);
            if (heading) c.dir = norm(add(mul(c.dir, 1 - Math.min(1, dt * 5)), mul(heading, Math.min(1, dt * 5))), c.dir);

            for (const h of region.holes) {
                if (h.alive && dist(h.pos, c.pos) < h.radius) {
                    c.alive = false; c.state = "dead";
                    if (c.species.menace) h.fed++;
                    this.events.push({ kind: "swallowed", at: [...c.pos], hole: h.name });
                    break;
                }
            }
            // Nothing passes through the big bodies.
            for (const b of region.bodies) {
                if (b.radius < c.radius * 1.5 || b.kind === "mote" || b.kind === "essence") continue;
                const away = sub(c.pos, b.pos), d = len(away);
                if (d < b.radius + c.radius) c.pos = add(b.pos, mul(norm(away, [0, 1, 0]), b.radius + c.radius));
            }
        }
    }

    /** A creature's hit lands on whatever it hunts. */
    private strike(c: Creature, power: number): void {
        if (c.affix === "vampiric") c.hp = Math.min(c.maxHp, c.hp + power * 0.6);
        if (c.target === -1) this.hurtPlayer(Game.scaled(power, Math.min(c.radius, this.player.radius * 1.7), this.player.radius));
        else if (c.target === -2) { const d = this.decoys[0]; if (d) d.life -= 6; }
        else { const t = this.region.creatures.find(x => x.id === c.target); if (t) this.hurtCreature(t, power, c.radius, c.id); }
    }

    private stepBolts(dt: number): void {
        const p = this.player, region = this.region;
        for (const b of this.bolts) {
            b.vel = add(b.vel, this.gravity(b.pos, dt));
            if (b.kind === "seeker") this.home(b, dt);
            const step = mul(b.vel, dt), next = add(b.pos, step);
            b.life -= dt;
            let hit = false;
            for (const h of region.holes) if (h.alive && dist(h.pos, next) < h.radius * 1.1) { b.life = 0; hit = true; }
            if (!hit && b.from !== -1 && p.alive && segmentDistance(p.pos, b.pos, next) < p.radius * 0.8 + b.radius) {
                // A Reflection Nebula turns some of what strikes it back on the thrower.
                const thrower = region.creatures.find(c => c.id === b.from && c.alive);
                if (this.form === "reflection" && thrower && this.rng.next() < 0.25) {
                    b.vel = mul(norm(sub(thrower.pos, p.pos), mul(b.vel, -1)), len(b.vel));
                    b.from = -1; b.faction = "player"; b.kind = "lance"; b.life = 3; b.target = 0;
                    b.pos = add(p.pos, mul(norm(b.vel), p.radius + b.radius * 2));
                    this.events.push({ kind: "reflect", at: [...b.pos], byYou: true });
                    continue;
                }
                this.hurtPlayer(Game.scaled(b.power, Math.min(b.fromRadius, p.radius * 1.7), p.radius));
                hit = true;
            }
            let bounced = false;
            if (!hit) for (const c of region.creatures) {
                if (!c.alive || c.id === b.from) continue;
                if (b.from !== -1 && (c.faction === b.faction)) continue;
                if (segmentDistance(c.pos, b.pos, next) < c.radius + b.radius) {
                    // Glass turns a single bolt of yours straight back.
                    if (b.from === -1 && c.species.trait === "reflect" && !c.yielding && (b.kind === "lance" || b.kind === "seeker" || !b.kind)) {
                        const back = norm(sub(p.pos, c.pos), mul(b.vel, -1));
                        b.vel = mul(back, len(b.vel) * 0.85);
                        b.pos = add(c.pos, mul(back, c.radius + b.radius * 2));
                        b.from = c.id; b.faction = c.faction; b.kind = "foe"; b.life = 3; b.target = 0;
                        if (c.provoked <= 0) { c.provoked = 30; c.state = "hunt"; c.target = -1; }
                        this.events.push({ kind: "reflect", at: [...b.pos], byYou: false });
                        this.teach("species:prism");
                        bounced = true;
                        break;
                    }
                    this.hurtCreature(c, b.power, b.fromRadius, b.from); hit = true; break;
                }
            }
            if (bounced) continue;
            if (!hit) for (const d of this.decoys) if (b.from !== -1 && dist(d.pos, next) < d.radius + b.radius) { d.life -= 3; hit = true; break; }
            if (!hit) for (const body of region.bodies) {
                if (body.kind === "mote" || body.kind === "essence" || body.radius < b.radius * 2) continue;
                if (segmentDistance(body.pos, b.pos, next) < body.radius) { hit = true; break; }
            }
            if (hit) { if (b.life > 0) this.events.push({ kind: "impact", at: next, size: b.radius * 4, faction: b.faction }); b.life = 0; }
            b.pos = next;
        }
        this.bolts = this.bolts.filter(b => b.life > 0);
    }

    /** A Seeker turns toward its quarry, or finds the nearest enemy if it has none. */
    private home(b: Bolt, dt: number): void {
        const p = this.player;
        let t = b.target ? this.region.creatures.find(c => c.id === b.target && c.alive && !c.yielding) : undefined;
        if (!t) {
            let best = p.radius * 70;
            for (const c of this.region.creatures) {
                if (!c.alive || c.hidden || !this.hostile(c)) continue;
                const d = dist(c.pos, b.pos);
                if (d < best) { best = d; t = c; }
            }
            b.target = t?.id ?? 0;
        }
        if (!t) return;
        const speed = len(b.vel), want = mul(norm(sub(t.pos, b.pos), b.vel), speed);
        b.vel = mul(norm(add(b.vel, mul(sub(want, b.vel), Math.min(1, dt * 3.5))), b.vel), speed);
    }

    private stepWaves(dt: number): void {
        const region = this.region;
        const goal = this.goals.find(g => g.def.type === "defend" && !g.done);
        if (!goal || goal.def.type !== "defend") return;
        const def = goal.def;
        if (!this.defend) this.defend = { goal: def.id, wave: -1, timer: 9, alive: [] };
        const st = this.defend;
        st.alive = st.alive.filter(id => region.creatures.some(c => c.id === id && c.alive));
        goal.total = def.waves.length;
        goal.progress = Math.max(0, st.wave + (st.alive.length ? 0 : 1));
        if (st.alive.length) return;
        if (st.wave >= 0 && !this.flags.has(`wave:${def.id}:${st.wave}`)) { this.flags.add(`wave:${def.id}:${st.wave}`); this.deed(4, "You stood between the raiders and the shoal"); }
        if (st.wave >= def.waves.length - 1 && st.wave >= 0) { this.flags.add(`defend:${def.id}`); return; }
        st.timer -= dt;
        if (st.timer > 0) return;
        st.timer = 5;
        st.wave++;
        const w = def.waves[st.wave];
        const herd = region.creatures.filter(c => c.alive && c.group === def.group);
        const center = herd.length ? herd[0].pos : this.player.pos;
        const from = add(center, mul(norm(this.rng.dir()), 55 * region.scale));
        for (let i = 0; i < w.count; i++) {
            const c = makeCreature(region, w.species, add(from, mul(this.rng.ball(), 6 * region.scale)), { boss: w.boss, wave: st.wave, phase: this.rng.next() });
            c.home = [...center]; c.wanderTo = [...center];
            st.alive.push(c.id);
        }
        const crier = herd[0];
        this.emit({ from: [...center], faction: crier?.faction ?? "concord", speaker: crier?.name ?? "The shoal", text: st.wave === 0 ? "Raiders! Ember raiders at the shoal!" : "More of them! Hold fast!", kind: "distress", about: st.alive[0] });
        this.events.push({ kind: "wave", n: st.wave + 1, of: def.waves.length });
    }

    // --- Feeding ---------------------------------------------------------------------------------------

    /** The body within reach that holding siphon would drink from. */
    siphonTarget(): Body | null {
        const p = this.player;
        let best: Body | null = null, bestD = Infinity;
        for (const b of this.region.bodies) {
            if (!b.alive || b.kind === "mote" || b.kind === "essence" || b.radius < p.radius * 0.5) continue;
            const d = dist(b.pos, p.pos) - b.radius;
            if (d < this.siphonReach && (b.id === p.siphon ? d * 0.5 : d) < bestD) { bestD = b.id === p.siphon ? d * 0.5 : d; best = b; }
        }
        return best;
    }

    private gain(mass: number): void {
        this.campaign.mass += mass;
        this.player.radius = radiusOfMass(this.campaign.mass);
        this.player.fed = 60;
    }

    private absorb(b: Body): void {
        const c = this.campaign, p = this.player;
        b.alive = false;
        const floor = b.kind === "mote" ? 0.006 * c.mass : b.kind === "essence" ? 0.012 * c.mass : 0;
        this.gain(Math.max(massOfRadius(b.radius) * b.yield, floor));
        p.charge = Math.min(this.maxCharge, p.charge + (b.kind === "mote" ? 5 : 2));
        p.cohesion = Math.min(this.maxCohesion, p.cohesion + (b.kind === "essence" ? 6 : 1));
        c.stats.absorbed++;
        this.counts[`absorb:${b.kind}`] = (this.counts[`absorb:${b.kind}`] ?? 0) + 1;
        this.counts["absorb:any"] = (this.counts["absorb:any"] ?? 0) + 1;
        if (b.key) this.minedKeys.add(b.key);
        if (b.inhabited) this.crime(b);
        this.events.push({ kind: "absorb", at: [...b.pos], radius: b.radius, body: b.kind });
    }

    /** Feeding on a living world: its government will not forgive it quickly. */
    private crime(b: Body): void {
        if (this.crimes.has(b.id)) return;
        this.crimes.add(b.id);
        const gov = galaxyById(this.region.def.galaxy).government;
        const f: FactionId = gov === "wild" ? "concord" : gov;
        this.addStanding(f, -30);
        this.deed(-15, `You fed on ${b.name}, a living world`);
        for (const c of this.region.creatures) if (c.alive && c.faction === f && c.species.attack !== "none") c.provoked = 60;
        this.emit({ from: [...b.pos], faction: f, speaker: b.name, text: `They are feeding on ${b.name}! Every light, to us!`, kind: "distress", about: -1, range: 400 * this.region.scale });
        this.events.push({ kind: "crime", faction: f, text: `${b.name} carries life. ${FACTIONS[f].name} has marked you.` });
    }

    private stepFeeding(dt: number, input: NkInput): void {
        const p = this.player, c = this.campaign;
        const pull = this.pullRange;
        for (const b of this.region.bodies) {
            if (!b.alive) continue;
            const to = sub(p.pos, b.pos), d = len(to);
            if (b.kind === "mote" || b.kind === "essence") {
                if (d < p.radius + b.radius) { this.absorb(b); continue; }
                if (d < pull) b.pos = add(b.pos, mul(to, Math.min(1, (p.radius * 7 * dt) / d)));
                continue;
            }
            if (b.radius < p.radius * 0.5) {
                if (d < p.radius * 0.9 + b.radius) this.absorb(b);
                continue;
            }
            // Too big to swallow: it is solid, and if it is a star, hot.
            const surface = b.radius + p.radius * 0.35;
            if (d < surface) { p.pos = add(b.pos, mul(norm(mul(to, 1), [0, 1, 0]), surface)); const n = norm(to); const vn = dot(p.vel, n); if (vn < 0) p.vel = sub(p.vel, mul(n, vn)); }
            if (b.kind === "star" && b.radius > p.radius && d < b.radius * 1.2 + p.radius * 0.3) this.hurtPlayer(7 * dt);
        }

        const target = input.siphon ? this.siphonTarget() : null;
        p.siphon = target?.id ?? 0;
        if (!target) return;
        if (p.veil && this.form !== "dark") this.setVeil(false);
        if (target.inhabited) this.crime(target);
        target.drain = 1;
        const rate = c.mass * 0.17 * (1 + 0.2 * c.facets.reach);
        const have = massOfRadius(target.radius);
        const take = Math.min(have, (rate * dt) / target.yield);
        this.gain(take * target.yield);
        target.radius = radiusOfMass(have - take);
        p.charge = Math.min(this.maxCharge, p.charge + 4 * dt);
        if (target.kind === "star") {
            this.teach("star");
            if (this.form === "emission") p.charge = Math.min(this.maxCharge, p.charge + 8 * dt);
            target.flareIn -= dt;
            if (target.flareIn <= 0) {
                target.flareIn = 4.5;
                this.events.push({ kind: "starflare", at: [...target.pos], radius: target.radius });
                // A Lightstride carries you through a flare; otherwise it burns.
                if (p.stride < 0.2) this.hurtPlayer(13);
            }
        }
        if (have - take <= massOfRadius(target.radius0) * 0.02 || target.radius < p.radius * 0.5) {
            // The last of it comes away at once.
            this.gain(massOfRadius(target.radius) * target.yield);
            target.alive = false;
            p.siphon = 0;
            if (target.key) this.minedKeys.add(target.key);
            c.stats.mined++;
            if (target.kind === "star") c.stats.stars++;
            this.counts[`mine:${target.kind}`] = (this.counts[`mine:${target.kind}`] ?? 0) + 1;
            this.events.push({ kind: "mined", at: [...target.pos], name: target.name, body: target.kind, radius: target.radius0 });
        }
    }

    // --- Goals and levels ------------------------------------------------------------------------------

    private updateGoals(quiet: boolean): void {
        const region = this.region;
        const done = (id: string) => this.goals.find(g => g.def.id === id)?.done ?? false;
        for (const g of this.goals) {
            const d = g.def;
            if (d.type === "lure") {
                g.locked = !!d.after?.some(id => !done(id));
                if (d.to === "rift" && region.rift) region.rift.open = !g.locked;
            }
            if (g.done) { g.progress = g.total; continue; }
            switch (d.type) {
                case "absorb": g.total = d.count; g.progress = Math.min(d.count, this.counts[`absorb:${d.kind}`] ?? 0); break;
                case "mine":
                    if (d.keys) { g.total = d.keys.length; g.progress = d.keys.filter(k => this.minedKeys.has(k)).length; }
                    else { g.total = d.count ?? 1; g.progress = Math.min(g.total, this.counts[`mine:${d.kind}`] ?? 0); }
                    break;
                case "clear": {
                    const alive = region.creatures.filter(c => c.alive && (d.group ? c.group === d.group : c.species.menace)).length;
                    g.total = Math.max(g.total, alive, 1); g.progress = g.total - alive;
                    break;
                }
                case "defeat": g.total = 1; g.progress = region.creatures.some(c => c.alive && c.key === d.key) ? 0 : 1; break;
                case "defend": g.total = d.waves.length; if (this.flags.has(`defend:${d.id}`)) g.progress = g.total; break;
                case "feed": g.total = d.count; g.progress = Math.min(d.count, region.holes.find(h => h.key === d.hole)?.fed ?? 0); break;
                case "lure": g.total = 1; g.progress = this.flags.has(`lure:${d.hole}`) ? 1 : 0; break;
                case "sling": g.total = 1; g.progress = this.flags.has(`sling:${d.hole}`) ? 1 : 0; break;
                case "standing": g.total = d.factions; g.progress = Math.min(d.factions, GOVERNMENTS.filter(f => this.campaign.standing[f] >= 25).length); break;
                case "tribute": g.total = 1; g.progress = this.flags.has(`tribute:${d.faction}`) ? 1 : 0; break;
            }
            if (g.progress >= g.total && !g.locked) {
                g.done = true;
                const list = (this.campaign.goalsDone[region.def.id] ??= []);
                if (!list.includes(d.id)) list.push(d.id);
                if (!quiet) this.events.push({ kind: "goal", text: d.text });
            }
        }
        if (!this.regionComplete && this.goals.every(g => g.done || g.def.optional)) {
            this.campaign.completed.push(region.def.id);
            for (const [f, n] of Object.entries(region.def.reward)) this.addStanding(f as FactionId, n as number);
            const next = this.nextRegion();
            if (!quiet) this.events.push({ kind: "regionComplete", region: region.def.name, next: next?.name ?? "" });
            if (!quiet && next) this.teach("fold");
            if (!next) { this.campaign.crowned = true; if (!quiet) this.events.push({ kind: "crowned" }); }
        }
    }

    private checkLevel(): void {
        const p = this.player;
        const level = levelOfRadius(p.radius);
        while (p.level < level) {
            p.level++;
            this.campaign.points++;
            p.cohesion = Math.min(this.maxCohesion, p.cohesion + this.maxCohesion * 0.3);
            const unlocked = Object.values(ABILITIES).find(a => a.level === p.level);
            const blast = Object.values(BLASTS).find(b => b.level === p.level);
            const names = [unlocked?.name, blast?.name].filter(Boolean).join(" and ");
            this.events.push({ kind: "levelup", level: p.level, rank: rankOf(p.level), newRank: rankOf(p.level) !== rankOf(p.level - 1), unlocked: names });
            if (unlocked && unlocked.id !== "lance" && unlocked.id !== "surge" && unlocked.id !== "attune") this.teach(`ability:${unlocked.id}`);
            if (blast && blast.id !== "lance") { this.teach("blasts"); this.teach(`blast:${blast.id}`); }
        }
        // Mass lost (tribute, Shed, a horizon) can cost levels; they are won back by feeding.
        if (level < p.level) p.level = level;
    }

    spendFacet(id: FacetId): boolean {
        const c = this.campaign;
        if (c.points <= 0 || c.facets[id] >= FACET_MAX || !FACETS[id]) return false;
        c.points--; c.facets[id]++;
        if (id === "density") this.player.cohesion = Math.min(this.maxCohesion, this.player.cohesion + 12);
        return true;
    }

    // --- The Field Guide: each new thing explained as it first comes up ------------------------------

    private stepLessons(dt: number): void {
        const p = this.player, c = this.campaign, region = this.region;
        if (this.regionTime < 0.5) return;
        this.teach("fly");
        // Every kind of goal, as soon as it is one you can work on.
        for (const g of this.goals) if (!g.done && !g.locked && !g.def.optional) this.teach(`goal:${g.def.type}`);
        if (c.points > 0) this.teach("facets");
        if (p.level >= FORM_LEVEL && !c.form) this.teach("forms");
        this.lessonIn -= dt;
        if (this.lessonIn > 0) return;
        this.lessonIn = 0.5;
        if (this.siphonTarget()) this.teach("siphon");
        for (const h of region.holes) if (h.alive && dist(h.pos, p.pos) < h.radius * 14 + p.radius * 20) this.teach("hole");
        for (const b of region.bodies) if (b.alive && b.inhabited && dist(b.pos, p.pos) - b.radius < Math.max(this.siphonReach * 3, p.radius * 12)) this.teach("law");
        const near = p.radius * 45;
        for (const cr of region.creatures) {
            if (!cr.alive || cr.hidden || dist(cr.pos, p.pos) > near + cr.radius) continue;
            if (this.hostile(cr)) this.teach("combat");
            if (cr.affix) this.teach("affix");
            if (cr.species.trait && cr.species.trait !== "ambush" && cr.species.trait !== "blink") this.teach(`species:${cr.species.id}`);
        }
    }

    // --- Reading the game ------------------------------------------------------------------------------

    /** What the reticle rests on: the creature, body or hole nearest the aim. */
    focus(): { type: "creature" | "body" | "hole"; id: number; name: string; pos: V3; radius: number; distance: number } | null {
        const p = this.player, f = this.forward;
        let best: ReturnType<Game["focus"]> = null, bestScore = 0.955;
        const consider = (type: "creature" | "body" | "hole", id: number, name: string, pos: V3, radius: number) => {
            const to = sub(pos, p.pos), d = len(to);
            if (d < 1e-6) return;
            const score = dot(to, f) / d + Math.min(0.04, (radius / d) * 0.05);
            if (score > bestScore) { bestScore = score; best = { type, id, name, pos, radius, distance: Math.max(0, d - radius - p.radius) }; }
        };
        for (const c of this.region.creatures) if (c.alive && (!c.hidden || p.attune)) consider("creature", c.id, c.name, c.pos, c.radius);
        for (const b of this.region.bodies) if (b.alive && b.kind !== "mote" && b.kind !== "essence" && b.radius > p.radius * 0.4) consider("body", b.id, b.name, b.pos, b.radius);
        for (const h of this.region.holes) if (h.alive) consider("hole", h.id, h.name, h.pos, h.radius);
        return best;
    }

    summary() {
        const p = this.player, c = this.campaign, r = this.region;
        const r3 = (v: V3) => v.map(x => Math.round(x)) as V3;
        return {
            region: r.def.id, regionName: r.def.name, galaxy: galaxyById(r.def.galaxy).name, tier: r.def.tier, complete: this.regionComplete,
            time: Math.round(this.time * 100) / 100,
            player: {
                pos: r3(p.pos), radiusKm: Math.round(p.radius), mass: Number(c.mass.toPrecision(6)), level: p.level, rank: rankOf(p.level), progress: Math.round(levelProgress(p.radius) * 100) / 100,
                cohesion: Math.round(p.cohesion), charge: Math.round(p.charge), alive: p.alive, veil: p.veil, attune: p.attune, stride: Math.round(p.stride * 100) / 100,
                speed: Math.round(len(p.vel)), siphon: p.siphon, points: c.points, facets: c.facets,
                blast: this.blast, blasts: this.blasts, beam: p.beam.on, form: c.form, alignment: c.alignment, alignmentTier: alignmentTier(c.alignment),
            },
            taught: c.taught.length,
            goals: this.goals.map(g => ({ id: g.def.id, text: g.def.text, done: g.done, progress: g.progress, total: g.total, optional: !!g.def.optional, locked: g.locked })),
            counts: { bodies: r.bodies.length, creatures: r.creatures.length, hostile: r.creatures.filter(x => this.hostile(x)).length, holes: r.holes.length, bolts: this.bolts.length, signals: this.signals.length, decoys: this.decoys.length, yielding: r.creatures.filter(x => x.yielding).length, hidden: r.creatures.filter(x => x.hidden).length, variants: r.creatures.filter(x => x.affix).length },
            standing: c.standing, completed: c.completed, crowned: c.crowned, stats: c.stats,
            fold: this.fold ? { to: this.fold.to, t: Math.round(this.fold.t * 100) / 100 } : null,
            lastMessage: this.messages[this.messages.length - 1] ?? null,
            unlocked: REGIONS.filter(x => this.unlocked(x.id)).map(x => x.id),
            galaxies: GALAXIES.length, species: Object.keys(SPECIES).length,
        };
    }
}
