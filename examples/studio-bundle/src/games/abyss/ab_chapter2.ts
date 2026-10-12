// Chapter Two: Retaliation, played over the Game of Chapter One (ab_game.ts): the same Alex, the
// same weapons, wounds, wardens and cutscene player, with the open world laid on top - the quest
// book (ab_quests.ts) and its data (ab_script2.ts), the people of Firebase Lantern and the healer
// of below, warden patrols roaming the wild floor, the quartermaster's trade, choices, and Kesh
// (ab_creature.ts): found wounded, calmed, healed, called with a whistle, and flown.
//
// The Game calls in at its seams (step, interactions, cutscene events, kills, pickups, the
// camera, respawn, saving); everything here stays free of the engine, so the tests play the whole
// chapter headless.

import type { Game, GameInput, Pickup } from "./ab_game";
import type { V2, V3 } from "./ab_world";
import { MAP_HALF } from "./ab_world";
import { spawn, alive, kill, type Actor } from "./ab_combat";
import { QuestBook, type QuestEvent, type QuestState, type QuestContext, type QuestDef } from "./ab_quests";
import {
    QUESTS, NPCS, SENTRIES, PLACES2, DOG_TAGS, PATROLS, HUNTERS, OFFERS, STAGE_LINES, TALK_LINES, IDLE, DONE_LINES, IDOL_LINES, SAGE_LINES, SHOP,
    AFTERMATH, HOLLOW, SKYBOUND, FIRSTLIGHT, CAST2, type ChapterTwoStart,
} from "./ab_script2";
import { newCreature, stepCreature, stepRidden, seatPosition, chaseCamera, altitude, type Creature, NO_FLIGHT } from "./ab_creature";
import { addMouse, stepLook } from "../allegiance/al_aim";
import { WEAPONS, ARTIFACTS, artifactValue, type WeaponId } from "./ab_player";
import { shootDown, type Aircraft } from "./ab_flight";
import type { Scene } from "./ab_cinema";
import type { Line } from "./ab_script";

export interface Choice { id: string; prompt: string; options: string[]; /** The option each answer reports (null: walk away). */ values: (number | null)[] }

export interface Ch2Save {
    v: 1;
    quests: { states: QuestState[]; tracked: string | null };
    counters: Record<string, number>;
    flags: Record<string, boolean | number>;
    taken: string[];
    inv: Game["inv"];
    pos: [number, number, number];
    kesh: { x: number; z: number; yaw: number; healed: boolean; trust: number; resting: boolean };
}

const NEAR_TALK = 3.4;

export class ChapterTwo {
    readonly quests = new QuestBook(QUESTS);
    kesh: Creature;
    mounted = false;
    counters: Record<string, number> = {};
    npcIds: Record<string, number> = {};
    choice: Choice | null = null;
    /** The quartermaster's screen should open (the addon reads and clears it). */
    wantTrade = false;
    /** Quest pickups already taken (by key), so a reload does not lay them out again. */
    taken = new Set<string>();
    private pickupKeys = new Map<number, string>();
    private talked: string | null = null;
    private interacted: string | null = null;
    private chose: { id: string; option: number } | null = null;
    private idleAt: Record<string, number> = {};
    private patrols = new Map<string, { ids: number[]; until: number }>();
    private lastShot = -100;
    private shots = 0;
    private sageAt = -100;
    private cam: { pos: V3; target: V3 } | null = null;
    private landing = false;
    private counted = new Set<number>();
    private sentryIds: number[] = [];

    constructor(readonly g: Game) {
        const [kx, kz] = PLACES2.kesh;
        this.kesh = newCreature(kx, kz, g.world.ground(kx, kz), Math.atan2(PLACES2.hollow[0] - 60 - kx, PLACES2.hollow[1] - 140 - kz));
    }

    // --- Setting the chapter up ----------------------------------------------------------------------

    /** Lays the chapter out and starts it at `from`. */
    begin(from: ChapterTwoStart, quiet = false): void {
        const g = this.g;
        g.combat.holdFire = false;
        g.combat.wardensPassive = false;
        g.inv.armor = 100; g.inv.armorMax = 100; g.inv.armorName = "Aegis Mk.II plates";
        g.inv.medgel = 2;
        g.inv.credits = 150;
        this.setupAircraft();
        this.spawnPeople();
        this.placeLoot();
        const [sx, sz] = PLACES2.spawn;
        g.teleportTo(sx, sz, Math.atan2(PLACES2.voss[0] - sx, PLACES2.voss[1] - sz));
        this.events(this.quests.unlock(g.flags));
        this.events(this.quests.start("beast", this));
        g.checkpoint = { phase: "open", x: sx, z: sz, yaw: g.body.yaw, inv: JSON.parse(JSON.stringify(g.inv)), objective: 0 };
        if (from === "open" && !quiet) { g.enterPhase("aftermath"); g.playScene(AFTERMATH); return; }
        g.enterPhase("open");
        if (from === "hollow") {
            this.jump("beast", "trail");
            const [hx, hz] = PLACES2.hollow;
            g.teleportTo(hx + 20, hz - 80, Math.atan2(-20, 80));
        } else if (from === "skybound" || from === "roam") {
            this.jump("beast", from === "roam" ? null : "mount");
            this.healKesh();
            this.kesh.mode = "rest";
            if (from === "roam") {
                g.flags.chapterDone = true;
                const [fx, fz] = PLACES2.firebase;
                this.kesh.x = fx + 40; this.kesh.z = fz - 50; this.kesh.y = g.world.ground(this.kesh.x, this.kesh.z);
            } else g.teleportTo(this.kesh.x + 4, this.kesh.z - 6, Math.atan2(-4, 6));
        }
        g.radio = [];
    }

    /** Puts a quest at a stage (stageId null: finished) as if played there, running the stages' setup on the way. */
    jump(questId: string, stageId: string | null): void {
        const def = this.quests.def(questId);
        const st = this.quests.state(questId);
        if (st.status === "locked" || st.status === "available") this.events(this.quests.start(questId, this), true);
        const end = stageId === null ? def.stages.length : def.stages.findIndex(s => s.id === stageId);
        for (let i = st.stage + 1; i <= end && i <= def.stages.length; i++) {
            // Each passed stage's actions, quietly (no scenes).
            for (const a of def.stages[i - 1].done ?? []) this.action(def, a, true);
            // Only the stage it lands on is set up (a passed stage's hunters never come).
            if (i < def.stages.length) { st.stage = i; if (i === end) for (const a of def.stages[i].enter ?? []) this.action(def, a, true); }
        }
        if (stageId === null) { st.status = "done"; st.stage = def.stages.length - 1; this.reward(def, true); }
        this.quests.unlock(this.g.flags);
    }

    private setupAircraft(): void {
        const g = this.g;
        const ground = (x: number, z: number) => g.world.ground(x, z);
        const wreck = (a: Aircraft | undefined, at: V2, yaw: number) => {
            if (!a) return;
            a.mode = "wreck"; a.pos = [at[0], ground(at[0], at[1]) + 0.8, at[1]]; a.yaw = yaw; a.roll = 0.35; a.pitch = -0.12; a.searchlight = false; a.vel = [0, 0, 0]; a.burning = 200;
            g.world.solids.push({ x: at[0], z: at[1], r: 4 });
        };
        wreck(g.aircraftById("lantern4"), PLACES2.wreck4, 2.1);
        wreck(g.aircraftById("lantern7"), PLACES2.wreck7, -0.8);
        const [fx, fz] = PLACES2.firebase;
        const park = (a: Aircraft | undefined, x: number, z: number, yaw: number) => {
            if (!a) return;
            a.mode = "parked"; a.pos = [x, ground(x, z) + 0.2, z]; a.yaw = yaw; a.pitch = 0; a.roll = 0; a.vel = [0, 0, 0]; a.searchlight = false; a.rotorSpeed = 0;
            g.world.solids.push({ x, z, r: 5 });
        };
        park(g.aircraftById("lantern6"), fx + 34, fz - 4, 1.4);
        park(g.aircraftById("lantern9"), fx - 30, fz - 40, 0.4);
        // Kilo-Two flies supply runs between the rim and the firebase.
        const kilo = g.aircraftById("kilo2");
        if (kilo) { kilo.mode = "orbit"; kilo.searchlight = true; kilo.orbit = { center: [-300, -200, -700], radius: 420, speed: 24, phase: 1, bob: 10, dir: -1 }; }
        void shootDown;
    }

    private spawnPeople(): void {
        const g = this.g;
        const ground = (x: number, z: number) => g.world.ground(x, z);
        for (const n of NPCS) {
            if (!n.at) continue;
            this.spawnNpc(n.id, n.at, n.faceTo ?? null);
        }
        for (const s of SENTRIES) {
            const a = spawn(g.combat, { name: "Sentry", look: s.look, faction: "surface", role: "trooper", x: s.at[0], z: s.at[1], state: "scripted", mortal: false }, ground);
            a.yaw = Math.atan2(s.face[0] - a.x, s.face[1] - a.z);
            a.pose = 1;
            this.sentryIds.push(a.id);
        }
    }

    private spawnNpc(id: string, at: V2, faceTo: V2 | null): Actor {
        const g = this.g;
        const n = NPCS.find(x => x.id === id)!;
        const old = this.npc(id);
        if (old) g.combat.actors = g.combat.actors.filter(a => a !== old);
        const a = spawn(g.combat, { name: n.name, look: n.look, faction: n.faction, role: n.faction === "neutral" ? "civilian" : "trooper", x: at[0], z: at[1], state: "scripted", mortal: false, tag: `npc:${id}` }, (x, z) => g.world.ground(x, z));
        if (faceTo) a.yaw = Math.atan2(faceTo[0] - a.x, faceTo[1] - a.z);
        this.npcIds[id] = a.id;
        return a;
    }

    npc(id: string): Actor | undefined { const n = this.npcIds[id]; return n === undefined ? undefined : this.g.combat.actors.find(a => a.id === n); }

    /** Artifacts of below and medgel lying about the open floor. */
    private placeLoot(): void {
        const loot: [string, string, V2][] = [
            ["artifact", "bronze-cup", [412, -300]], ["artifact", "prayer-tablet", [190, -380]], ["artifact", "river-idol", [520, -520]],
            ["artifact", "warden-mask", [640, -140]], ["artifact", "prayer-tablet", [-300, 260]], ["artifact", "bronze-cup", [880, 300]],
            ["medgel", "medgel", [500, -170]], ["medgel", "medgel", [-310, 290]], ["medgel", "medgel", [760, -50]], ["medgel", "medgel", [200, -620]],
        ];
        loot.forEach(([kind, item, at], i) => this.place(`loot${i}`, kind as Pickup["kind"], item, at, kind === "medgel" ? "Medgel" : ARTIFACTS[item].name));
    }

    /** Places a pickup once (not if its key was taken already). */
    private place(key: string, kind: Pickup["kind"], item: string, at: V2, label: string, lift = 0.2): void {
        if (this.taken.has(key) || [...this.pickupKeys.values()].includes(key)) return;
        const p = this.g.addPickup(kind, item, at[0], at[1], label, lift);
        this.pickupKeys.set(p.id, key);
    }

    // --- Quest plumbing ---------------------------------------------------------------------------------

    private events(evs: QuestEvent[], quiet = false): void {
        const g = this.g;
        for (const e of evs) {
            if (e.kind === "started") {
                if (!quiet && e.quest.kind === "side") g.events.push({ kind: "quest", state: "started", title: e.quest.title, text: e.quest.summary });
            } else if (e.kind === "stage") {
                if (!quiet) {
                    const lines = STAGE_LINES[`${e.quest.id}/${e.stage.id}`];
                    if (lines?.length) g.say(lines);
                }
            } else if (e.kind === "action") this.action(e.quest, e.name, quiet);
            else if (e.kind === "completed") this.reward(e.quest, quiet);
            else if (e.kind === "offered" && !quiet && e.quest.giver && e.quest.requires?.length) g.events.push({ kind: "toast", text: `New lead: ${e.quest.title}` });
        }
    }

    private reward(q: QuestDef, quiet: boolean): void {
        const g = this.g;
        const r = q.reward;
        if (r.credits) g.inv.credits += r.credits;
        for (const it of r.items ?? []) this.give(it);
        if (quiet) return;
        const text = q.id === "idol" ? (this.quests.state("idol").outcome === "idol:0" ? "Maelis gave you river water - and her trust." : "Dace paid 900 CR. The healer is gone.") : r.text;
        g.events.push({ kind: "quest", state: "completed", title: q.title, text: `${text}${r.credits ? `  +${r.credits} CR` : ""}` });
        const done = DONE_LINES[q.id];
        if (done?.length) g.say(done);
    }

    private give(item: string): void {
        const inv = this.g.inv;
        if (item === "plates-mk3") { inv.armorMax = 150; inv.armor = 150; inv.armorName = "Aegis Mk.III plates"; }
        else if (item === "medgel") inv.medgel++;
        else if (item in WEAPONS) {
            const id = item as WeaponId;
            if (!inv.weapons.includes(id)) inv.weapons.push(id);
            inv.mags[id] = WEAPONS[id].mag ?? 0;
            inv.reserve[id] = Math.max(inv.reserve[id] ?? 0, 96);
        }
    }

    /** A quest's named action (see ab_script2's QUESTS). `quiet`: setting up a jump or a reload, no scenes. */
    private action(_q: QuestDef, name: string, quiet: boolean): void {
        const g = this.g;
        switch (name) {
            case "placeRecorder": this.place("recorder", "quest", "recorder", [PLACES2.wreck4[0] - 5, PLACES2.wreck4[1] - 4], "Lantern Four's flight recorder"); break;
            case "showTrail": g.flags.trail = true; break;
            case "foundScene": g.flags.trail = false; if (!quiet) g.playScene(HOLLOW); break;
            case "spawnHunters": this.spawnGroup("hunters", PLACES2.hollow, HUNTERS.map(h => ({ dx: h.dx, dz: h.dz, look: h.look })), PLACES2.kesh); break;
            case "waterHint": break;
            case "skyboundScene": if (!quiet) g.playScene(this.namingScene()); else this.healKesh(); break;
            case "firstLightScene": if (!quiet) g.playScene(FIRSTLIGHT); else g.flags.chapterDone = true; break;
            case "pellFound": this.spawnNpc("pell", PLACES2.pellWreck, PLACES2.wreck7); break;
            case "spawnSeven": this.spawnGroup("seven", PLACES2.wreck7, [{ dx: -40, dz: 70, look: "warden-m" }, { dx: 10, dz: 80, look: "adept" }, { dx: 50, dz: 60, look: "warden-f" }, { dx: -70, dz: 40, look: "warden-m" }], PLACES2.pellWreck); break;
            case "pellHome": this.spawnNpc("pell", PLACES2.pellHome, PLACES2.spawn); if (!quiet) g.events.push({ kind: "toast", text: "Pell sets off for the firebase lights" }); break;
            case "placeTags": DOG_TAGS.forEach((t, i) => this.place(`tag${i}`, "quest", "dogtag", t.at, `Tags: ${t.name}`, 0.05)); break;
            case "placeShards": [[340, -150], [610, -330], [-160, -260], [700, 160], [960, -20], [-520, 120]].forEach((p, i) => this.place(`shard${i}`, "artifact", "lumen-shard", p as V2, ARTIFACTS["lumen-shard"].name)); break;
            case "shardsDelivered": {
                let n = 5;
                g.inv.artifacts = g.inv.artifacts.filter(a => !(a === "lumen-shard" && n-- > 0));
                break;
            }
            case "placeRelay": this.place("relay", "quest", "relay", PLACES2.relay, "Relay drone core", 0.3); break;
            case "relayHeard": g.flags.scanBoost = true; if (!quiet) g.say([SAGE_LINES.scanBoost]); break;
            case "idolOutcome": {
                const out = this.quests.state("idol").outcome;
                g.inv.artifacts = g.inv.artifacts.filter((a, i, all) => !(a === "river-idol" && all.indexOf("river-idol") === i && g.flags.idolHeld));
                g.flags.idolHeld = false;
                if (out === "idol:0") {
                    g.flags.riverWater = true; g.inv.vial = true; g.flags.maelisFriend = true;
                    if (!quiet) g.say(IDOL_LINES.returned);
                } else {
                    g.inv.credits += 900;
                    const m = this.npc("maelis");
                    if (m) g.combat.actors = g.combat.actors.filter(a => a !== m);
                    delete this.npcIds.maelis;
                    if (!quiet) g.say(IDOL_LINES.sold);
                }
                break;
            }
        }
    }

    /** SKYBOUND with its naming line: the healer's word if Alex has her trust, the wardens' otherwise. */
    private namingScene(): Scene {
        const text = this.g.flags.maelisFriend
            ? "The healer's word for it was 'kesh'. Little light. I will log it as KESH."
            : "The wardens' chant had a word in it, over and over. Kesh. I will log it as KESH.";
        return { ...SKYBOUND, shots: SKYBOUND.shots.map(s => ({ ...s, subtitles: s.subtitles?.map(t => (t.text === "{naming}" ? { ...t, text } : t)) })) };
    }

    private spawnGroup(tag: string, at: V2, who: { dx: number; dz: number; look: string }[], goal: V2): void {
        const g = this.g;
        for (const w of who) {
            const role = w.look === "warden-m" ? "blade" : "caster";
            const a = spawn(g.combat, { name: role === "blade" ? "Warden" : "Adept", look: w.look, faction: "below", role, x: at[0] + w.dx, z: at[1] + w.dz, tag }, (x, z) => g.world.ground(x, z));
            a.goal = [goal[0] + (g.rng.next() - 0.5) * 8, goal[1] + (g.rng.next() - 0.5) * 8];
            a.yaw = Math.atan2(goal[0] - a.x, goal[1] - a.z);
            [a.x, a.z] = g.world.collide(a.x, a.z, 0.5);
        }
    }

    healKesh(): void {
        const g = this.g;
        this.kesh.healed = true;
        this.kesh.trust = 1;
        if (this.kesh.mode === "wounded") this.kesh.mode = "rest";
        g.inv.vial = false;
        g.flags.riverWater = false;
        g.flags.calmed = true;
    }

    // --- Each frame -----------------------------------------------------------------------------------------

    /** Before the world steps (not in cutscenes): input that only Chapter Two knows. */
    stepInput(dt: number, input: GameInput): void {
        const g = this.g;
        if (g.stats.shots !== this.shots) { this.shots = g.stats.shots; this.lastShot = g.time; }
        if (input.track) { const id = this.quests.cycleTracked(); if (id) g.events.push({ kind: "toast", text: `Tracking: ${this.quests.def(id).title}` }); }
        if (this.choice && input.choice) {
            const c = this.choice;
            const v = c.values[input.choice - 1];
            if (input.choice >= 1 && input.choice <= c.options.length) {
                this.choice = null;
                if (v !== null && v !== undefined) this.chose = { id: c.id === "idol-sell" ? "idol" : c.id, option: v };
            }
        }
        if (this.choice) {
            // Walking away closes it.
            const who = this.choice.id === "idol-sell" ? this.npc("dace") : this.npc("maelis");
            if (who && Math.hypot(who.x - g.body.x, who.z - g.body.z) > 6) this.choice = null;
        }
        // The whistle: Kesh comes to Alex.
        if (input.call && this.kesh.healed && !this.mounted) {
            const b = g.body;
            const side = 6;
            const tx = b.x - Math.cos(b.yaw) * side, tz = b.z + Math.sin(b.yaw) * side;
            this.kesh.goal = [tx, g.world.ground(tx, tz), tz];
            if (Math.hypot(this.kesh.x - tx, this.kesh.z - tz) > 4) { this.kesh.mode = "fly"; g.events.push({ kind: "whistle" }); this.sage(SAGE_LINES.whistle, 20); }
        }
        void dt;
    }

    /** Alex on Kesh's back: flight instead of walking. */
    stepMounted(dt: number, input: GameInput): void {
        const g = this.g;
        const k = this.kesh;
        addMouse(g.look, input.mouseX, input.mouseY, g.sensitivity);
        const turn = stepLook(g.look, input.lookX, input.lookY, dt, 0, g.sensitivity);
        if (input.interact) {
            if (k.grounded) { this.dismount(); return; }
            if (altitude(k, this.air()) < 14) this.landing = true;
            else this.sage(SAGE_LINES.noLand, 6);
        }
        const landed = stepRidden(k, { throttle: input.moveY, turnYaw: turn.yaw, turnPitch: turn.pitch, flap: input.jumpHeld || input.jump, boost: input.sprint, land: this.landing }, dt, { ground: (x, z) => g.world.ground(x, z), half: MAP_HALF });
        if (landed || k.grounded) this.landing = false;
        if (k.flap % (Math.PI * 2) < (k.flap - dt * 6) % (Math.PI * 2) && k.beat > 0.5) g.events.push({ kind: "wingbeat", at: [k.x, k.y + 2, k.z] });
        const seat = seatPosition(k);
        const b = g.body;
        b.x = seat[0]; b.y = seat[1] - 1.66 + 0.9; b.z = seat[2]; b.vy = 0; b.yaw = k.yaw; b.pitch = k.pitch; b.speed = 0; b.grounded = true;
        // The augment knits wounds in the air too.
        if (g.time - g.lastHurt > 7 && g.health < g.maxHealth) g.health = Math.min(g.maxHealth, g.health + 3 * dt);
        for (const h of g.hurtDir) h.age += dt;
        g.hurtDir = g.hurtDir.filter(h => h.age < 1.6);
        g.interactable = k.grounded ? { kind: "site", id: "dismount", label: "Climb down" } : altitude(k, this.air()) < 14 ? { kind: "site", id: "land", label: "Set down" } : null;
    }

    mount(): void {
        const g = this.g;
        this.mounted = true;
        this.kesh.mode = "ridden";
        this.kesh.goal = null;
        this.landing = false;
        this.cam = null;
        g.flags.mounted = true;
        g.look.pendingYaw = 0; g.look.pendingPitch = 0;
        g.events.push({ kind: "toast", text: "W/S speed  -  look to steer  -  SPACE beat wings  -  SHIFT dive  -  E set down" });
    }

    dismount(): void {
        const g = this.g;
        const k = this.kesh;
        this.mounted = false;
        k.mode = "rest";
        k.grounded = true;
        k.y = g.world.ground(k.x, k.z);
        // Off the left side.
        const x = k.x + Math.cos(k.yaw) * 3.5, z = k.z - Math.sin(k.yaw) * 3.5;
        g.teleportTo(x, z, k.yaw);
        g.body.pitch = -0.05;
    }

    /** The world around: Kesh (when not ridden), patrols, the quest book. After the world steps. */
    stepStory(dt: number): void {
        const g = this.g;
        if (!this.mounted) stepCreature(this.kesh, dt, this.air());
        g.combat.wardensPassive = !!g.cinema;
        if (this.kesh.cryT > 14 && (this.kesh.mode === "wounded" || g.rng.next() < dt * 0.02)) { this.kesh.cryT = 0; g.events.push({ kind: "cry", at: [this.kesh.x, this.kesh.y + 3, this.kesh.z] }); }
        // Deaths the combat step did not report (a story kill, a crash): counted all the same.
        for (const a of g.combat.actors) if (a.tag && !alive(a) && !this.counted.has(a.id)) this.onDeath(a);
        this.stepPatrols();
        // Groups heading for a goal (hunters, the wave at Seven) keep coming until they find a target.
        this.stepQuests();
    }

    private stepQuests(): void {
        const g = this.g;
        const b = g.body;
        const flying = this.mounted && !this.kesh.grounded;
        // A talk nobody's stage is waiting on: what the NPC says instead.
        if (this.talked && !this.stageWaitsOn("talk", this.talked)) {
            const who = this.talked;
            this.talked = null;
            this.idle(who);
        }
        const ctx: QuestContext = {
            pos: [b.x, b.y, b.z], flying, ground: g.world.ground(b.x, b.z), talked: this.talked, interacted: this.interacted, chose: this.chose,
            counters: this.counters, flags: g.flags,
        };
        const before = this.talked ? this.stageKey() : null;
        const evs = this.quests.step(ctx);
        if (before) {
            // Lines for the talk that finished a stage.
            for (const k of before) if (evs.some(e => e.kind === "stage" || e.kind === "completed")) {
                const lines = TALK_LINES[k];
                if (lines?.length && this.quests.state(k.split("/")[0]).stage !== QUESTS.find(q => q.id === k.split("/")[0])!.stages.findIndex(s => s.id === k.split("/")[1])) g.say(lines);
            }
        }
        this.talked = null; this.interacted = null; this.chose = null;
        this.events(evs);
    }

    /** Keys (quest/stage) of every active stage waiting on a talk. */
    private stageKey(): string[] {
        return this.quests.list("active").map(q => ({ q, st: this.quests.stage(q.id)! })).filter(x => x.st?.trigger.kind === "talk").map(x => `${x.q.id}/${x.st.id}`);
    }

    private stageWaitsOn(kind: "talk", who: string): boolean {
        return this.quests.list("active").some(q => { const t = this.quests.stage(q.id)?.trigger; return t?.kind === kind && t.npc === who; });
    }

    private idle(who: string): void {
        const g = this.g;
        if (who === "dace") { this.wantTrade = true; g.events.push({ kind: "trade" }); }
        if (who === "maelis" && this.quests.stage("idol")?.id === "decide" && g.flags.idolHeld) {
            this.choice = { id: "idol", prompt: "Give Maelis her family's idol?", options: ["Give it back", "Keep it"], values: [0, null] };
            return;
        }
        const sets = IDLE[who];
        if (!sets?.length) return;
        const i = this.idleAt[who] ?? 0;
        this.idleAt[who] = i + 1;
        if (who !== "dace" || i === 0) g.say(sets[i % sets.length]);
    }

    private sage(line: Line, every: number): void {
        if (this.g.time - this.sageAt < every) return;
        this.sageAt = this.g.time;
        this.g.say([line]);
    }

    // --- Patrols ---------------------------------------------------------------------------------------------

    private stepPatrols(): void {
        const g = this.g;
        const b = g.body;
        const [fx, fz] = PLACES2.firebase;
        let active = 0;
        for (const p of this.patrols.values()) if (p.ids.some(id => { const a = g.combat.actors.find(x => x.id === id); return a && alive(a); })) active++;
        for (const z of PATROLS) {
            const d = Math.hypot(z.at[0] - b.x, z.at[1] - b.z);
            let p = this.patrols.get(z.id);
            const members = p ? p.ids.map(id => g.combat.actors.find(a => a.id === id)).filter((a): a is Actor => !!a) : [];
            const living = members.filter(a => alive(a));
            if (p && living.length === 0 && members.length && p.until < g.time) p.until = g.time + 240;
            // Far away: the patrol goes home (alive ones vanish; the dead are cleared).
            if (p && d > 520) {
                g.combat.actors = g.combat.actors.filter(a => !p!.ids.includes(a.id));
                if (living.length) { this.patrols.delete(z.id); continue; }
                p.ids = [];
            }
            if (d < 250 && (!p || (p.ids.length === 0 && p.until < g.time)) && active < 2 && Math.hypot(z.at[0] - fx, z.at[1] - fz) > 260 && !this.mounted && !g.cinema) {
                const ids: number[] = [];
                z.looks.slice(0, z.n).forEach((look, i) => {
                    const ang = (i / z.n) * Math.PI * 2;
                    const role = look === "warden-m" ? "blade" : "caster";
                    const a = spawn(g.combat, { name: role === "blade" ? "Warden" : "Adept", look, faction: "below", role, x: z.at[0] + Math.cos(ang) * 12, z: z.at[1] + Math.sin(ang) * 12, tag: `patrol` }, (x, zz) => g.world.ground(x, zz));
                    [a.x, a.z] = g.world.collide(a.x, a.z, 0.5);
                    ids.push(a.id);
                });
                p = { ids, until: 0 };
                this.patrols.set(z.id, p);
                active++;
            }
            // Wandering: a new point near home whenever one is reached, unless Alex is close.
            for (const a of living) {
                if (a.target !== null || Math.hypot(a.x - b.x, a.z - b.z) < 70) continue;
                if (!a.goal || Math.hypot(a.goal[0] - a.x, a.goal[1] - a.z) < 3) a.goal = [z.at[0] + (g.rng.next() - 0.5) * 70, z.at[1] + (g.rng.next() - 0.5) * 70];
            }
        }
    }

    // --- Interactions ---------------------------------------------------------------------------------------

    /** What Alex can interact with here (nearest first), beyond pickups. */
    sites(): { kind: "site"; id: string; label: string; d: number }[] {
        const g = this.g;
        const b = g.body;
        const out: { kind: "site"; id: string; label: string; d: number }[] = [];
        const near = (p: V2) => Math.hypot(p[0] - b.x, p[1] - b.z);
        for (const n of NPCS) {
            const a = this.npc(n.id);
            if (!a) continue;
            const d = Math.hypot(a.x - b.x, a.z - b.z);
            if (d < NEAR_TALK) out.push({ kind: "site", id: `talk:${n.id}`, label: n.id === "dace" ? `Talk to ${n.name}  (trade)` : `Talk to ${n.name}`, d });
        }
        const k = this.kesh;
        const dk = Math.hypot(k.x - b.x, k.z - b.z);
        const stage = this.quests.stage("beast")?.id;
        if (dk < 7.5 && k.grounded) {
            if (stage === "calm") out.push({ kind: "site", id: "creature-calm", label: "Reach out to it", d: dk });
            else if (stage === "heal" && g.flags.riverWater) out.push({ kind: "site", id: "creature-heal", label: "Pour the river's water", d: dk });
            else if (k.healed && k.mode === "rest") out.push({ kind: "site", id: "creature-ride", label: "Ride Kesh", d: dk });
        }
        if (this.quests.stage("idol")?.id === "crate" && near(PLACES2.crate) < 3.5) out.push({ kind: "site", id: "crate", label: "Search the recovered artifacts", d: near(PLACES2.crate) });
        if (this.quests.stage("tags")?.id === "memorial" && near(PLACES2.memorial) < 3.5) out.push({ kind: "site", id: "memorial", label: "Hang the tags", d: near(PLACES2.memorial) });
        if (!g.flags.riverWater && !k.healed && near(PLACES2.sourceFill) < 16) out.push({ kind: "site", id: "source", label: "Draw river water", d: near(PLACES2.sourceFill) });
        return out.sort((a, c) => a.d - c.d);
    }

    /** Alex pressed interact at a site. */
    interact(id: string): void {
        const g = this.g;
        if (id.startsWith("talk:")) {
            const who = id.slice(5);
            if (who === "dace" && this.quests.stage("idol")?.id === "decide" && g.flags.idolHeld) {
                this.choice = { id: "idol-sell", prompt: "Sell the river idol to Dace for 900 CR?", options: ["Sell it", "Keep it"], values: [1, null] };
                return;
            }
            const offer = this.quests.list("available").find(q => q.giver === who);
            if (offer) {
                g.say(OFFERS[offer.id] ?? []);
                this.events(this.quests.start(offer.id, this));
                return;
            }
            const n = this.npc(who);
            if (n) n.yaw = Math.atan2(g.body.x - n.x, g.body.z - n.z);
            this.talked = who;
            return;
        }
        switch (id) {
            case "creature-calm": {
                const k = this.kesh;
                const rushed = g.time - this.lastShot < 6 || g.body.speed > 5.5;
                if (rushed) { k.trust = Math.max(0, k.trust - 0.2); k.cryT = 99; g.say([SAGE_LINES.trustFlinch]); break; }
                k.trust = Math.min(1, k.trust + 0.34);
                k.yaw += Math.atan2(g.body.x - k.x, g.body.z - k.z) * 0;
                if (k.trust >= 0.99) { g.flags.calmed = true; g.say(SAGE_LINES.calmed); }
                else g.say([SAGE_LINES.trustRise[k.trust < 0.5 ? 0 : 1]]);
                break;
            }
            case "creature-heal": this.interacted = "creature-heal"; break;
            case "creature-ride": this.mount(); break;
            case "dismount": this.dismount(); break;
            case "land": this.landing = true; break;
            case "crate": {
                g.inv.artifacts.push("river-idol");
                g.flags.idolHeld = true;
                g.events.push({ kind: "pickup", text: "River Idol - her house's mark is on the seal" });
                this.interacted = "crate";
                break;
            }
            case "memorial": this.interacted = "memorial"; g.events.push({ kind: "toast", text: "Six tags, hung where the firebase can see them" }); break;
            case "source": {
                g.flags.riverWater = true; g.inv.vial = true;
                g.events.push({ kind: "pickup", text: "Vial of river water" });
                g.say([SAGE_LINES.sourceFill]);
                break;
            }
        }
    }

    /** A pickup was taken. */
    onPickup(p: Pickup): void {
        const key = this.pickupKeys.get(p.id);
        if (key) this.taken.add(key);
        if (p.kind === "quest") {
            this.counters[p.item] = (this.counters[p.item] ?? 0) + 1;
            const label = p.item === "dogtag" ? `${p.label}  (${this.counters.dogtag}/6)` : p.label;
            this.g.events.push({ kind: "pickup", text: label });
        }
        if (p.item === "lumen-shard") this.counters.lumen = (this.counters.lumen ?? 0) + 1;
        if (p.item === "river-idol" && p.kind === "artifact") this.g.flags.idolFound = true;
    }

    /** An actor died (by anyone). */
    onDeath(a: Actor): void {
        if (this.counted.has(a.id)) return;
        this.counted.add(a.id);
        if (a.tag) this.counters[`kill:${a.tag}`] = (this.counters[`kill:${a.tag}`] ?? 0) + 1;
    }

    // --- Cutscenes --------------------------------------------------------------------------------------------

    sceneEvent(name: string): void {
        const g = this.g;
        const k = this.kesh;
        switch (name) {
            case "cry": g.events.push({ kind: "cry", at: [k.x, k.y + 3, k.z] }); break;
            case "healKesh": this.healKesh(); break;
            case "keshRise": k.mode = "rest"; k.fold = 0.2; break;
            case "keshBow": k.pitch = -0.2; break;
        }
    }

    endScene(scene: Scene): boolean {
        const g = this.g;
        if (scene === AFTERMATH) { g.enterPhase("open"); return true; }
        if (scene.id === SKYBOUND.id) { const k = this.kesh; k.pitch = 0; g.teleportTo(k.x + Math.cos(k.yaw) * 4, k.z - Math.sin(k.yaw) * 4, k.yaw + Math.PI / 2); return true; }
        if (scene === FIRSTLIGHT) {
            g.flags.chapterDone = true;
            g.events.push({ kind: "quest", state: "chapter", title: "CHAPTER TWO COMPLETE", text: "The Abyss is open. Side quests remain - and Kesh will carry you to all of them." });
            return true;
        }
        return scene === HOLLOW;
    }

    /** Cutscene follow keys Chapter Two knows. */
    follow(name: string): { pos: V3; right: V3; up: V3; forward: V3 } | null {
        const frameOf = (x: number, y: number, z: number, yaw: number) => ({
            pos: [x, y, z] as V3, right: [Math.cos(yaw), 0, -Math.sin(yaw)] as V3, up: [0, 1, 0] as V3, forward: [Math.sin(yaw), 0, Math.cos(yaw)] as V3,
        });
        if (name === "kesh") return frameOf(this.kesh.x, this.kesh.y, this.kesh.z, this.kesh.yaw);
        if (name === "hunter") {
            const h = this.g.combat.actors.find(a => a.tag === "hunters" && alive(a)) ?? this.g.combat.actors.find(a => a.tag === "hunters");
            return h ? frameOf(h.x, h.y, h.z, h.yaw) : null;
        }
        const n = this.npc(name);
        return n ? frameOf(n.x, n.y, n.z, n.yaw) : null;
    }

    // --- The camera, the HUD -------------------------------------------------------------------------------------

    camera(dt: number): { pos: V3; target: V3; fov: number } {
        const c = chaseCamera(this.kesh, this.cam, dt, (x, z) => this.g.world.ground(x, z));
        this.cam = { pos: c.pos, target: c.target };
        return c;
    }

    /** Resolves a stage's marker (a place, an NPC, the creature). */
    resolve(marker: V2 | string | null): V2 | null {
        if (!marker) return null;
        if (typeof marker !== "string") return marker;
        if (marker === "creature") return [this.kesh.x, this.kesh.z];
        if (marker.startsWith("npc:")) { const a = this.npc(marker.slice(4)); return a ? [a.x, a.z] : null; }
        return null;
    }

    /** The HUD's objective: the tracked quest's stage, with its progress. */
    objective(): { title: string; text: string; marker: V2 | null } | null {
        const f = this.quests.focus();
        if (!f) return this.g.flags.chapterDone ? { title: "THE ABYSS IS OPEN", text: "Roam - [TAB] journal", marker: null } : null;
        const pr = this.quests.progress(f.quest.id, this.counters);
        return { title: f.quest.title.toUpperCase(), text: pr ? `${f.stage.text}  ${pr[0]}/${pr[1]}` : f.stage.text, marker: this.resolve(f.stage.marker) };
    }

    /** The other active quests (the HUD lists them under the objective). */
    others(): { title: string; text: string }[] {
        const f = this.quests.focus();
        return this.quests.list("active").filter(q => q.id !== f?.quest.id).map(q => ({ title: q.title, text: this.quests.stage(q.id)?.text ?? "" }));
    }

    /** NPCs with a quest to offer (the HUD marks them). */
    givers(): { id: string; pos: V3; name: string }[] {
        const out: { id: string; pos: V3; name: string }[] = [];
        for (const q of this.quests.list("available")) {
            if (!q.giver) continue;
            const a = this.npc(q.giver);
            if (a && !out.some(o => o.id === q.giver)) out.push({ id: q.giver, pos: [a.x, a.y, a.z], name: a.name });
        }
        return out;
    }

    /** The journal (inventory screen). */
    journal(): { id: string; title: string; kind: string; status: string; text: string; hint: string; tracked: boolean }[] {
        const order = { active: 0, available: 1, done: 2, locked: 3 } as const;
        return this.quests.defs
            .filter(q => this.quests.status(q.id) !== "locked")
            .map(q => {
                const st = this.quests.stage(q.id);
                const status = this.quests.status(q.id);
                const pr = this.quests.progress(q.id, this.counters);
                const giver = q.giver ? NPCS.find(n => n.id === q.giver)?.name ?? q.giver : null;
                return {
                    id: q.id, title: q.title, kind: q.kind, status,
                    text: status === "active" ? `${st?.text ?? ""}${pr ? `  ${pr[0]}/${pr[1]}` : ""}` : status === "available" ? `${q.summary}  Talk to ${giver}.` : q.summary,
                    hint: st?.hint ?? "", tracked: this.quests.tracked === q.id,
                };
            })
            .sort((a, b) => order[a.status as keyof typeof order] - order[b.status as keyof typeof order] || (a.kind === "main" ? -1 : 1));
    }

    track(id: string): void { if (this.quests.status(id) === "active") this.quests.tracked = id; }

    /** The glowing trail of blood to the hollow, while it is the objective. */
    trail(): V2[] { return this.g.flags.trail ? PLACES2.trail : []; }

    // --- Trade -------------------------------------------------------------------------------------------------

    sellable(): number { return artifactValue({ ...this.g.inv, artifacts: this.g.inv.artifacts.filter(a => a !== "river-idol" || !this.g.flags.idolHeld) }); }

    sellAll(): number {
        const g = this.g;
        const keep = g.inv.artifacts.filter(a => a === "river-idol" && g.flags.idolHeld);
        const value = this.sellable();
        g.inv.credits += value;
        g.inv.artifacts = keep;
        if (value) g.events.push({ kind: "toast", text: `Sold to Dace  +${value} CR` });
        return value;
    }

    canBuy(id: string): boolean {
        const g = this.g;
        const item = SHOP.find(s => s.id === id);
        if (!item || g.inv.credits < item.price) return false;
        if (id === "saddle") return this.kesh.healed && !g.flags.saddle;
        if (id === "refit") return g.inv.armor < g.inv.armorMax;
        return true;
    }

    buy(id: string): boolean {
        const g = this.g;
        if (!this.canBuy(id)) return false;
        const item = SHOP.find(s => s.id === id)!;
        g.inv.credits -= item.price;
        if (id === "medgel") g.inv.medgel++;
        else if (id === "ammo") { g.inv.reserve["coil-rifle"] = (g.inv.reserve["coil-rifle"] ?? 0) + 96; if (g.inv.weapons.includes("okafor-carbine")) g.inv.reserve["okafor-carbine"] = (g.inv.reserve["okafor-carbine"] ?? 0) + 48; }
        else if (id === "refit") g.inv.armor = g.inv.armorMax;
        else if (id === "saddle") g.flags.saddle = true;
        g.events.push({ kind: "pickup", text: `${item.label}  -${item.price} CR` });
        return true;
    }

    private air() { return { ground: (x: number, z: number) => this.g.world.ground(x, z), half: MAP_HALF }; }

    // --- Death, saving ------------------------------------------------------------------------------------------

    /** The augment restarts at the firebase; whoever was hunting Alex goes back where they came from. */
    respawn(): void {
        const g = this.g;
        if (this.mounted) this.dismount();
        const [sx, sz] = PLACES2.spawn;
        g.teleportTo(sx, sz, g.body.yaw);
        for (const [id, p] of this.patrols) { g.combat.actors = g.combat.actors.filter(a => !p.ids.includes(a.id)); this.patrols.delete(id); }
        for (const a of g.combat.actors) if (alive(a) && a.faction === "below" && (a.tag === "hunters" || a.tag === "seven")) {
            const home = a.tag === "hunters" ? PLACES2.hollow : PLACES2.wreck7;
            a.x = home[0] + (g.rng.next() - 0.5) * 80; a.z = home[1] + 60 + g.rng.next() * 20; a.y = g.world.ground(a.x, a.z); a.target = null;
        }
    }

    save(): Ch2Save {
        const g = this.g;
        const k = this.kesh;
        const keep = ["calmed", "riverWater", "idolHeld", "maelisFriend", "scanBoost", "saddle", "chapterDone", "trail", "mounted"];
        return {
            v: 1, quests: this.quests.save(), counters: { ...this.counters }, taken: [...this.taken],
            flags: Object.fromEntries(Object.entries(g.flags).filter(([key]) => keep.includes(key))),
            inv: JSON.parse(JSON.stringify(g.inv)),
            pos: this.mounted ? [k.x + 4, k.z, k.yaw] : [g.body.x, g.body.z, g.body.yaw],
            kesh: { x: k.x, z: k.z, yaw: k.yaw, healed: k.healed, trust: k.trust, resting: k.mode !== "wounded" },
        };
    }

    /** Restores a save over a freshly begun chapter: the quest book, then the world it implies. */
    load(d: Ch2Save): void {
        const g = this.g;
        // Undo what begin() laid out for a fresh start.
        g.pickups = g.pickups.filter(p => !this.pickupKeys.has(p.id));
        this.pickupKeys.clear();
        this.taken = new Set(d.taken);
        this.counters = { ...d.counters };
        Object.assign(g.flags, d.flags);
        g.inv = JSON.parse(JSON.stringify(d.inv));
        this.quests.load(d.quests);
        this.placeLoot();
        // Each active stage's setup, and what finished stages left behind.
        for (const q of QUESTS) {
            const s = this.quests.state(q.id);
            if (s.status === "active") for (const a of q.stages[s.stage].enter ?? []) this.action(q, a, true);
        }
        if (this.quests.reached("seven", "talk")) this.spawnNpc("pell", this.quests.reached("seven", "home") ? PLACES2.pellHome : PLACES2.pellWreck, null);
        if (this.quests.status("idol") === "done" && this.quests.state("idol").outcome !== "idol:0") {
            const m = this.npc("maelis");
            if (m) g.combat.actors = g.combat.actors.filter(a => a !== m);
            delete this.npcIds.maelis;
        }
        const k = this.kesh;
        k.x = d.kesh.x; k.z = d.kesh.z; k.y = g.world.ground(k.x, k.z); k.yaw = d.kesh.yaw; k.healed = d.kesh.healed; k.trust = d.kesh.trust;
        k.mode = d.kesh.resting ? "rest" : "wounded";
        g.flags.mounted = false;
        g.teleportTo(d.pos[0], d.pos[1], d.pos[2]);
        g.radio = [];
    }

    /** A plain summary for the state tool and the tests. */
    summary() {
        const k = this.kesh;
        const r2 = (x: number) => Math.round(x * 100) / 100;
        return {
            objective: this.objective(),
            quests: Object.fromEntries(QUESTS.map(q => [q.id, { status: this.quests.status(q.id), stage: this.quests.stage(q.id)?.id ?? null, outcome: this.quests.state(q.id).outcome }])),
            tracked: this.quests.tracked,
            counters: this.counters,
            kesh: { x: r2(k.x), y: r2(k.y), z: r2(k.z), mode: k.mode, healed: k.healed, trust: r2(k.trust), speed: r2(k.speed), grounded: k.grounded, stamina: r2(k.stamina) },
            mounted: this.mounted,
            choice: this.choice,
            credits: this.g.inv.credits,
            patrols: [...this.patrols.entries()].map(([id, p]) => ({ id, alive: p.ids.filter(i => { const a = this.g.combat.actors.find(x => x.id === i); return a && alive(a); }).length })),
            npcs: Object.keys(this.npcIds),
        };
    }

    /** Hostile wardens of quests and patrols (for the HUD's count). */
    hostiles(): number { return this.g.combat.actors.filter(a => alive(a) && a.faction === "below").length; }

    /** Removes the dead and the sentries from the summary (kept for tests). */
    sentries(): Actor[] { return this.sentryIds.map(id => this.g.combat.actors.find(a => a.id === id)!).filter(Boolean); }
}

export { CAST2, NO_FLIGHT, kill };
