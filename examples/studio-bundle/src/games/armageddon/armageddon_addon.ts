// ARMAGEDDON 2070
//
// Large-scale squad tactical combat: 128 vs 128 on four battlefields, Conquer only. Every other
// soldier is a bot whose decisions come from WIR networks (Yumon Pet's WIR; docs/ARMAGEDDON_2070.md).
// Docs: docs/ARMAGEDDON_2070.md. Design data: docs/armageddon/v0.2/*.csv (ar_data.ts).
//
// This file wires the modules to the engine: input (pointer-locked mouse look when the engine
// offers it, else middle-drag), the first-person and vehicle cameras, the fixed-step battle, effects
// and sound from battle events, every screen, saving the loadout, and the MCP tools the live test
// (tests/armageddon_live.rs) drives.

import { Battle, STEP, NO_INPUT, SUPPLY_FALL, eyeOf, dirOf, launcherOf, TEAM_NAMES, type PlayerInput, type Team, type Soldier, type Slot, type BattleEvent } from "./ar_sim";
import { think } from "./ar_bots";
import { MAPS, worldFor, HALF } from "./ar_map";
import { ROLE_LOADOUTS, REWARD, WEAPON, loadoutStats, type Loadout } from "./ar_data";
import { Renderer, terrainMesh, seaMesh } from "./ar_render";
import { packStatics, packGrass, drawSoldier, drawVehicle, groundTint, TEAM_COLOR, ENEMY_MARK } from "./ar_scene";
import { LIT, GLOW, BODY } from "./ar_shader";
import { drawTitle, drawSetup, drawArmory, drawDeploy, drawHud, drawDebrief, armoryRows, cycleArmory, type SetupView, type HudExtra } from "./ar_hud";
import { Sound } from "./ar_audio";
import { enginePainter, type Painter, type DrawApi, type Color } from "../allegiance/al_ui";
import { yawed, placed, between, type Mat4 } from "../world_of_music/wom_render";
import { clamp, type V3 } from "../nebula/nk_math";
import { Controller } from "../allegiance/al_controller";

const addon = Entropy.AddonAtom.register({
    name: "Armageddon 2070",
    version: "0.1.0",
    description: "Large-scale 128 vs 128 squad tactical combat on the rim of the ash. Bots think with WIR.",
    author: ["Entropy Team", "Claude"],
    capabilities: { graphics: true, ui: true },
});

const SAVE_PATH = "armageddon.json";
const renderer = new Renderer();
const sound = new Sound();
let painter: Painter | null = null;

type Mode = "title" | "setup" | "armory" | "deploy" | "play" | "end";
let mode: Mode = "title";
let armoryBack: Mode = "title";
let battle: Battle | null = null;
const setup: SetupView = { map: 0, team: 0, size: 128, vehicles: true };
let loadout: Loadout = JSON.parse(JSON.stringify(ROLE_LOADOUTS.rifleman));
const roleIndex = { i: 0 };
let armoryCursor = "primary";
let spawnPick = "HQ";
let realTime = 0, modeAge = 0, accum = 0, lastMs = 0, frames = 0;
let fixedStep: number | null = null;
let staticsFor = "", grassKey = "", terrainKey = "", seaKey = "";
let staticsDirtyAt = -1;
let freeCam: { pos: V3; target: V3; fov: number } | null = null;
let thirdPerson = false;
let postOn = true;
let hadSave = false;

// --- input ------------------------------------------------------------------------------------

const held = new Set<string>();
const pressed = new Set<string>();
let mouseButtons = new Set<number>();
let clicked = false, rightHeld = false;
let lookDrag: [number, number] | null = null;
let lookYaw = 0, lookPitch = 0;
let crouch = false, prone = false;
let scripted: (Partial<PlayerInput> & { frames: number }) | null = null;
let scoreboard = false, mapOpen = false, showHelp = true;
let lockSupported = false, locked = false, lockAskedAt = -99;
const pad = new Controller();
let padSprint = false;
const key = (k: string) => held.has(k) || held.has(k.toLowerCase()) || held.has(k.toUpperCase());
const tapped = (k: string) => pressed.has(k) || pressed.has(k.toLowerCase()) || pressed.has(k.toUpperCase());

const hud: HudExtra = { hitMarker: 0, killMarker: 0, headMarker: 0, hurt: 0, toasts: [], banner: null, device: "keys", ads: false, adsT: 0, sight: "iron", spread: 8, zoom: 1, scoreboard: false, mapOpen: false, showHelp: true, fps: 0, lockHint: false, point: "", lock: null, prompt: "", hint: "", reloadP: -1, steady: false };
let flash = 0;

// --- weapon feel ----------------------------------------------------------------------------------

const HIP_FOV = 70;
/** How far into aiming down sights the view is (0 hip .. 1 aimed); eases in over the weapon's aim time. */
let adsT = 0;
/** Recoil still to be applied to the view (rad), and how much of the climb the player gets back. */
let kickPitch = 0, kickYaw = 0, recoilDebt = 0;
/** The viewmodel's kick (1 on a shot, decays), screen shake, the scope's breathing sway (rad). */
let viewKick = 0, shake = 0, sway: [number, number] = [0, 0];
/** What the frame loop last saw of the player's weapon: the last shot, the reload it started, the slot. */
let seenShot = -10, reloadFrom = 0, seenSlot: Slot = "primary", slotAt = -10, boltSounded = true;
/** The gun trails fast turns (rad of yaw/pitch per second, smoothed). */
let gunLag: [number, number] = [0, 0], prevLook: [number, number] = [0, 0];
let lockBeepAt = 0;
/** Where the first-person muzzle and ejection port were drawn last (tracers and brass start there). */
let muzzleAt: V3 | null = null, portAt: V3 | null = null;
let sprintingNow = false;
let fireWas = false;

type SightKind = "iron" | "dot" | "holo" | "scope" | "launcher";
/** Magnification and reticle aiming down sights: the fitted optic (primary only), else the weapon's own sights. */
function sightOf(b: Battle, me: Soldier): { zoom: number; kind: SightKind } {
    const w = b.weaponOf(me);
    if (me.slot === "launcher") return { zoom: w.sight, kind: "launcher" };
    if (me.slot === "primary") {
        const o = me.loadout.attachments.Optic;
        if (o && o !== "A001") return { zoom: me.stats.zoom, kind: me.stats.zoom >= 2 ? "scope" : o === "A003" ? "holo" : "dot" };
        if (o === "A001") return { zoom: me.stats.zoom, kind: "iron" };
    }
    return { zoom: w.sight, kind: "iron" };
}
/** The zoom right now: optical (tan of the half angle), eased by adsT. */
function zoomNow(): number { const e = adsT * adsT * (3 - 2 * adsT); return 1 + (Math.max(1, hud.zoom) - 1) * e; }
function fovFor(zoom: number): number { return (2 * Math.atan(Math.tan((HIP_FOV * Math.PI) / 360) / zoom) * 180) / Math.PI; }

function toast(text: string, color: Color = [1, 1, 1, 1]): void { hud.toasts.unshift({ text, age: 0, color }); if (hud.toasts.length > 4) hud.toasts.pop(); }

/** The ground (or wall) point under the crosshair, from the player's eye. */
function crosshairPoint(): V3 | null {
    const b = battle, me = b?.me;
    if (!b || !me) return null;
    const cam = cameraNow();
    const d = dirOf(lookYaw, lookPitch);
    const L = 900;
    const f = b.world.trace(cam.pos[0], cam.pos[1], cam.pos[2], cam.pos[0] + d[0] * L, cam.pos[1] + d[1] * L, cam.pos[2] + d[2] * L);
    if (f >= 1) return null;
    return [cam.pos[0] + d[0] * L * f, cam.pos[1] + d[1] * L * f, cam.pos[2] + d[2] * L * f];
}

/** Aiming down sights: the right mouse button or the left trigger. */
const aimHeld = () => rightHeld || pad.triggers[0] > 0.35 || pad.held.has("LeftTrigger2");

function readInput(dt: number): PlayerInput {
    const me = battle?.me;
    const playing = mode === "play" && !!me?.alive;
    const look = (Entropy.Input as { takeMouseLook?: () => number[] }).takeMouseLook?.() ?? [0, 0, 0];
    locked = look[2] > 0.5;
    // Sticks and triggers go stale when a pad stops reporting; buttons get real releases (also on disconnect).
    if (realTime - pad.lastAxis > 0.5) { pad.left = [0, 0]; pad.right = [0, 0]; pad.triggers = [0, 0]; }
    const [lx, ly] = pad.left, [rx, ry] = pad.right;
    if (lx || ly || rx || ry || pad.triggers[0] > 0.1 || pad.triggers[1] > 0.1) hud.device = "pad";
    else if (look[0] || look[1]) hud.device = "keys";
    if (playing) {
        // Look speed follows the zoom, so a target crosses the screen at the same speed at 1x and 8x.
        const z = zoomNow(), adsK = 1 - 0.2 * adsT;
        const sens = (0.0024 / z) * adsK;
        lookYaw -= look[0] * sens; lookPitch -= look[1] * sens;
        if (key("ArrowLeft")) lookYaw += 0.04 / z; if (key("ArrowRight")) lookYaw -= 0.04 / z;
        if (key("ArrowUp")) lookPitch += 0.03 / z; if (key("ArrowDown")) lookPitch -= 0.03 / z;
        // Right stick: a response curve (fine aim near the centre), slower while aiming down sights.
        const rate = (3.2 / z) * adsK * dt;
        lookYaw -= Math.sign(rx) * rx * rx * rate; lookPitch += Math.sign(ry) * ry * ry * rate * 0.75;
        lookPitch = clamp(lookPitch, -1.4, 1.35);
    }
    const slot: Slot | null = tapped("1") ? "primary" : tapped("2") ? "sidearm" : tapped("3") ? "launcher" : tapped("NextWeapon") ? nextSlot(me) : null;
    const rewardKey = ["5", "6", "7", "8", "9"].findIndex(k => tapped(k));
    const inVeh = !!me && me.vehicle >= 0;
    const kx = (key("d") ? 1 : 0) - (key("a") ? 1 : 0), kz = (key("w") ? 1 : 0) - (key("s") ? 1 : 0);
    if (padSprint && Math.hypot(lx, ly) < 0.3) padSprint = false;
    const input: PlayerInput = {
        move: playing && !inVeh ? [clamp(kx + lx, -1, 1), clamp(kz + ly, -1, 1)] : [0, 0],
        yaw: lookYaw, pitch: lookPitch,
        fire: playing && (mouseButtons.has(0) || clicked || pad.triggers[1] > 0.5 || pad.held.has("RightTrigger2")) && !mapOpen, aim: playing && aimHeld(), reload: playing && tapped("r"),
        jump: playing && tapped(" ") && !inVeh, sprint: key("Shift") || padSprint, crouch: crouch && !inVeh, prone: prone && !inVeh,
        use: playing && tapped("e"), slot, grenade: playing && tapped("g"), equipment: playing && tapped("f"),
        call: playing && tapped("q"), reward: playing ? rewardKey : -1, point: playing ? crosshairPoint() : null,
        throttle: inVeh ? clamp(kz + ly, -1, 1) : 0, steer: inVeh ? clamp(-kx - lx, -1, 1) : 0,
        lift: inVeh ? (key(" ") ? 1 : 0) - (key("Control") ? 1 : 0) : 0,
    };
    if (scripted) {
        const { frames: _n, ...rest } = scripted;
        Object.assign(input, rest);
        if (rest.yaw !== undefined) lookYaw = rest.yaw;
        if (rest.pitch !== undefined) lookPitch = rest.pitch;
        if (--scripted.frames <= 0) scripted = null;
    }
    return input;
}

/** The next weapon slot the soldier carries (Y on the gamepad). */
function nextSlot(me: Soldier | null | undefined): Slot | null {
    if (!me) return null;
    const order: Slot[] = launcherOf(me) ? ["primary", "sidearm", "launcher"] : ["primary", "sidearm"];
    return order[(order.indexOf(me.slot) + 1) % order.length];
}

/** Gamepad buttons drive the same keys as the keyboard (menus included); what a button means can depend
 * on the moment (B is crouch on foot, descend in an aircraft), so each press remembers the key it sent. */
function padKey(button: string): string | null {
    const inVeh = !!battle?.me && battle.me.vehicle >= 0 && mode === "play";
    const menu = mode !== "play";
    switch (button) {
        case "South": return menu ? "Enter" : " ";
        case "East": return menu ? "Escape" : inVeh ? "Control" : "c";
        case "West": return "r";
        // Y: get in or out of a vehicle, or take from a supply crate, when there is one at hand; else the
        // next weapon. (D-pad up also enters and exits.)
        case "North": return menu ? null : useTarget() ? "e" : "NextWeapon";
        case "DPadUp": return menu ? "ArrowUp" : "e";
        case "DPadDown": return menu ? "ArrowDown" : "z";
        case "DPadLeft": return menu ? "ArrowLeft" : "q";
        case "DPadRight": return menu ? "ArrowRight" : "5";
        case "LeftTrigger": return "g";
        case "RightTrigger": return "f";
        case "RightThumb": return "v";
        case "Select": return "m";
        case "Start": return "PadStart";
        default: return null;
    }
}
const padSent = new Map<string, string>();

/** What "use" (E, Y, D-pad up) would do right now: leave the vehicle, take from a crate, get in a vehicle, or nothing. */
function useTarget(): string {
    const b = battle, me = b?.me;
    if (!b || !me || !me.alive || mode !== "play") return "";
    if (me.vehicle >= 0) return "Exit";
    const crate = b.supplyNear(me, 4);
    if (crate && b.needsSupply(me, crate.kind === "supply")) return "Resupply";
    const v = b.vehicleNear(me, true);
    return v ? `Enter ${v.def.name}${v.seats.includes(-1) ? "" : " (a passenger makes room)"}` : "";
}

function keyDown(k: string): void {
    {
        const repeat = held.has(k);
        held.add(k);
        if (repeat) return;
        pressed.add(k);
        const lower = k.toLowerCase();
        if (mode === "title") { if (k === "Enter") act("setup"); else if (lower === "a") act("armory"); return; }
        if (mode === "setup") { if (k === "Enter") act("start"); else if (k === "Escape") act("back"); else if (k === "ArrowRight") setup.map = (setup.map + 1) % MAPS.length; else if (k === "ArrowLeft") setup.map = (setup.map + MAPS.length - 1) % MAPS.length; return; }
        if (mode === "armory") {
            const rows = armoryRows(loadout).map(r => r.id);
            if (k === "Escape" || k === "Enter") act("done");
            else if (k === "ArrowDown" || k === "ArrowUp") { armoryCursor = rows[(rows.indexOf(armoryCursor) + (k === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]; sound.ui(); }
            else if (k === "ArrowRight" || k === "ArrowLeft") { loadout = cycleArmory(loadout, armoryCursor, k === "ArrowRight" ? 1 : -1, roleIndex); sound.ui(); save(); }
            return;
        }
        if (mode === "deploy") {
            if (k === "Enter" || k === " " || k === "PadStart") act("deploy");
            else if (k === "Escape") act("title");
            else if ((k === "ArrowRight" || k === "ArrowLeft" || k === "ArrowDown" || k === "ArrowUp") && battle?.me) {
                // Cycle the spawn point (keyboard and D-pad).
                const ids = battle.spawnOptions(battle.me).map(o => o.id);
                const step = k === "ArrowRight" || k === "ArrowDown" ? 1 : ids.length - 1;
                spawnPick = ids[(Math.max(0, ids.indexOf(spawnPick)) + step) % ids.length];
                sound.ui();
            }
            return;
        }
        if (mode === "end") { if (k === "Enter") act("again"); else if (k === "Escape") act("title"); return; }
        if (mode === "play") {
            if (k === "Tab") scoreboard = true;
            if (lower === "m") mapOpen = !mapOpen;
            if (lower === "h") showHelp = !showHelp;
            if (lower === "v") thirdPerson = !thirdPerson;
            if (lower === "p") { postOn = !postOn; renderer.setScreen(postOn); }
            if (lower === "c") { crouch = !crouch; prone = false; }
            if (lower === "z") { prone = !prone; crouch = false; }
            if ((k === "Escape" && !locked) || k === "PadStart") { setMode("deploy"); }
        }
    }
}
function keyUp(k: string): void { held.delete(k); held.delete(k.toLowerCase()); held.delete(k.toUpperCase()); if (k === "Tab") scoreboard = false; }

function setupInput(): void {
    Entropy.Input.onKeyDown((k: string) => { hud.device = "keys"; keyDown(k); });
    Entropy.Input.onKeyUp((k: string) => keyUp(k));
    Entropy.Input.onGamepadAxis((l, r, triggers) => pad.axis(l, r, realTime, triggers));
    Entropy.Input.onGamepadButton((button: string, down: boolean) => {
        const fresh = pad.button(button, down);
        hud.device = "pad";
        if (button === "LeftThumb") { if (fresh) padSprint = !padSprint; return; }
        if (fresh) { const k = padKey(button); if (k) { padSent.set(button, k); keyDown(k); } }
        else if (!down) { const k = padSent.get(button); if (k) { padSent.delete(button); keyUp(k); } }
    });
    // Entropy's addon mouse buttons: 0 left, 1 right, 2 middle (src/handlers.rs).
    Entropy.Input.onMouseDown((button: number, x: number, y: number) => {
        const hit = painter?.hit(x, y);
        if (hit) { act(hit.id); return; }
        if (mode !== "play") return;
        // The first click asks for pointer lock; if the lock does not take (some windows refuse it), later
        // clicks fire instead of asking forever (the left button used to never fire then).
        if (lockSupported && !locked && button === 0 && realTime - lockAskedAt > 3) { lockAskedAt = realTime; (Entropy.Input as { setPointerLock?: (b: boolean) => void }).setPointerLock?.(true); return; }
        mouseButtons.add(button);
        if (button === 0) clicked = true;
        if (button === 1) rightHeld = true;
        if (button === 2) lookDrag = [x, y];
    });
    Entropy.Input.onMouseUp((button: number) => { mouseButtons.delete(button); if (button === 1) rightHeld = false; if (button === 2) lookDrag = null; });
    Entropy.Input.onMouseMove((x: number, y: number) => {
        if (painter) painter.hover = painter.hit(x, y)?.id ?? null;
        if (lookDrag && !locked) { lookYaw -= (x - lookDrag[0]) * 0.004; lookPitch = clamp(lookPitch - (y - lookDrag[1]) * 0.004, -1.4, 1.35); lookDrag = [x, y]; }
    });
}

function setMode(m: Mode): void {
    if (mode === m) return;
    mode = m; modeAge = 0;
    sound.ui();
    if (m !== "play") { (Entropy.Input as { setPointerLock?: (b: boolean) => void }).setPointerLock?.(false); mouseButtons = new Set(); rightHeld = false; }
}

function act(id: string): void {
    sound.ui();
    if (id === "setup") setMode("setup");
    else if (id === "armory") { armoryBack = mode === "armory" ? armoryBack : mode; setMode("armory"); }
    else if (id === "done") { setMode(armoryBack === "armory" ? "title" : armoryBack); if (battle?.me && armoryBack === "deploy") battle.setLoadout(battle.me, loadout); save(); }
    else if (id === "back" || id === "title") { setMode("title"); }
    else if (id.startsWith("map:")) setup.map = Number(id.slice(4));
    else if (id.startsWith("team:")) setup.team = Number(id.slice(5)) as Team;
    else if (id.startsWith("size:")) setup.size = Number(id.slice(5));
    else if (id === "vehicles") setup.vehicles = !setup.vehicles;
    else if (id === "start" || id === "again") startBattle();
    else if (id.startsWith("spawn:")) spawnPick = id.slice(6);
    else if (id === "deploy") deploy();
    else if (id.startsWith("row:")) armoryCursor = id.slice(4);
    else if (id.startsWith("prev:") || id.startsWith("next:")) { armoryCursor = id.slice(5); loadout = cycleArmory(loadout, armoryCursor, id.startsWith("next") ? 1 : -1, roleIndex); save(); }
}

function startBattle(seed = 2070 + Math.floor(realTime * 10)): void {
    const map = MAPS[setup.map];
    battle = new Battle({ map: map.id, perTeam: setup.size, playerTeam: setup.team, playerLoadout: loadout, vehicles: setup.vehicles, seed });
    const me = battle.me!;
    me.alive = false; me.respawnAt = 0;
    staticsFor = ""; grassKey = "";
    effects.length = 0;
    freeCam = null; mapOpen = false; scoreboard = false; thirdPerson = false;
    hud.toasts = []; hud.banner = { title: map.name.toUpperCase(), text: `${TEAM_NAMES[setup.team]}  -  Conquer: kill and take territories`, age: 0 };
    spawnPick = "HQ";
    setMode("deploy");
}

function deploy(): void {
    const b = battle, me = b?.me;
    if (!b || !me) return;
    if (me.alive) { setMode("play"); return; }
    if (b.time < me.respawnAt) return;
    const ok = spawnPick === "HQ" || b.spawnOptions(me).some(s => s.id === spawnPick);
    b.setLoadout(me, loadout);
    b.respawn(me, false, ok ? spawnPick : "HQ");
    lookYaw = me.yaw; lookPitch = 0; crouch = prone = false;
    setMode("play");
}

function load(): void {
    try {
        const text = addon.IO.store.read(SAVE_PATH);
        const d = text ? (JSON.parse(text) as { v?: number; loadout?: Loadout; setup?: SetupView }) : null;
        if (d?.v === 1 && d.loadout && loadoutStats(d.loadout).problems.length === 0) { loadout = d.loadout; hadSave = true; }
        if (d?.setup) Object.assign(setup, d.setup);
    } catch { /* no save yet */ }
}
function save(): void {
    try { addon.IO.store.write(SAVE_PATH, JSON.stringify({ v: 1, loadout, setup })); } catch { /* no data folder */ }
}

// --- effects ------------------------------------------------------------------------------------------

interface Fx { kind: "tracer" | "flash" | "boom" | "smoke" | "spark" | "debris"; pos: V3; to: V3; vel: V3; life: number; max: number; size: number; color: [number, number, number]; seed: number }
const effects: Fx[] = [];
let fxSeed = 11;
const rnd = () => { fxSeed = (Math.imul(fxSeed, 1664525) + 1013904223) >>> 0; return fxSeed / 4294967296; };

function onEvents(b: Battle, events: BattleEvent[]): void {
    const me = b.me;
    const camPos = cameraNow().pos;
    for (const e of events) {
        switch (e.kind) {
            case "shot": {
                const mine = !!me && e.shooter === me.id && me.vehicle < 0;
                const d = Math.hypot(e.from[0] - camPos[0], e.from[2] - camPos[2]);
                if (d < 450 && effects.length < 900) {
                    // The player's own rounds leave from the drawn muzzle, not the eye, so the tracer is seen.
                    const from: V3 = mine && muzzleAt && !thirdPerson ? [...muzzleAt] : [...e.from];
                    if (rnd() < (mine ? 1 : 0.45)) effects.push({ kind: "tracer", pos: from, to: [...e.to], vel: [0, 0, 0], life: mine ? 0.09 : 0.07, max: mine ? 0.09 : 0.07, size: e.heavy ? 0.09 : mine ? 0.03 : 0.04, color: e.team === 0 ? [0.6, 0.9, 1] : [1, 0.75, 0.4], seed: rnd() });
                    if (!mine || thirdPerson) effects.push({ kind: "flash", pos: [...e.from], to: [0, 0, 0], vel: [0, 0, 0], life: 0.05, max: 0.05, size: e.heavy ? 0.9 : 0.4, color: [1, 0.8, 0.45], seed: rnd() });
                    // Rounds that hit the world kick up dust and sparks where they land.
                    if (e.impact && Math.hypot(e.to[0] - camPos[0], e.to[2] - camPos[2]) < 160) {
                        effects.push({ kind: "smoke", pos: [...e.to], to: [0, 0, 0], vel: [0, 0.6, 0], life: 0.7, max: 0.7, size: e.heavy ? 0.7 : 0.35, color: [0.5, 0.45, 0.38], seed: rnd() });
                        for (let i = 0; i < (mine ? 3 : 1); i++) effects.push({ kind: "spark", pos: [...e.to], to: [0, 0, 0], vel: [(rnd() - 0.5) * 5, 1 + rnd() * 3, (rnd() - 0.5) * 5], life: 0.18, max: 0.18, size: 0.05, color: [1, 0.8, 0.5], seed: rnd() });
                    }
                }
                sound.shot(e.from, e.heavy, mine, e.weapon);
                break;
            }
            case "resupply": if (me && e.soldier === me.id) { toast("Resupplied: ammunition, launcher and grenades", [0.6, 1, 0.6, 1]); sound.resupply(); } break;
            case "hit":
                if (me && b.soldiers[me.id] && b.time - me.lastShot < 0.3 && !e.vehicle && b.soldiers[e.target]?.team !== me.team) { hud.hitMarker = 0.25; sound.hit(); }
                if (effects.length < 900) for (let i = 0; i < 3; i++) effects.push({ kind: "spark", pos: [...e.at], to: [0, 0, 0], vel: [(rnd() - 0.5) * 4, rnd() * 3, (rnd() - 0.5) * 4], life: 0.25, max: 0.25, size: 0.12, color: e.vehicle ? [1, 0.8, 0.4] : [0.7, 0.1, 0.08], seed: rnd() });
                if (me && e.target === me.id && !e.vehicle) { hud.hurt = Math.min(1, hud.hurt + 0.35); sound.hurt(); }
                break;
            case "explode": {
                sound.explode(e.at, e.radius);
                const d = Math.hypot(e.at[0] - camPos[0], e.at[2] - camPos[2]);
                if (d < 700 && effects.length < 900) {
                    effects.push({ kind: "boom", pos: [...e.at], to: [0, 0, 0], vel: [0, 0, 0], life: 0.5, max: 0.5, size: e.radius * 0.9, color: [1, 0.55, 0.2], seed: rnd() });
                    for (let i = 0; i < 4; i++) effects.push({ kind: "smoke", pos: [e.at[0] + (rnd() - 0.5) * e.radius * 0.5, e.at[1] + 1, e.at[2] + (rnd() - 0.5) * e.radius * 0.5], to: [0, 0, 0], vel: [(rnd() - 0.5) * 1.5, 1.5 + rnd() * 2, (rnd() - 0.5) * 1.5], life: 3 + rnd() * 2, max: 5, size: e.radius * 0.5 + 1, color: [0.28, 0.26, 0.24], seed: rnd() });
                    for (let i = 0; i < 6; i++) effects.push({ kind: "debris", pos: [...e.at], to: [0, 0, 0], vel: [(rnd() - 0.5) * 12, 4 + rnd() * 8, (rnd() - 0.5) * 12], life: 1.2, max: 1.2, size: 0.15 + rnd() * 0.2, color: [0.25, 0.22, 0.2], seed: rnd() });
                }
                if (me && Math.hypot(e.at[0] - me.pos[0], e.at[2] - me.pos[2]) < e.radius * 3) flash = Math.max(flash, 0.25);
                if (me) shake = Math.max(shake, clamp(e.radius * 2.5 / (4 + Math.hypot(e.at[0] - me.pos[0], e.at[1] - me.pos[1], e.at[2] - me.pos[2])), 0, 1));
                break;
            }
            case "kill":
                if (me && e.killer === me.id) { toast(`${e.head ? "HEADSHOT  " : ""}${b.soldiers[e.victim].name}  +${e.head ? 130 : 100}`, [1, 0.85, 0.4, 1]); sound.kill(e.head); hud.killMarker = 0.45; if (e.head) hud.headMarker = 0.45; }
                if (me && e.victim === me.id) { hud.banner = { title: "YOU WERE KILLED", text: e.killer >= 0 ? `by ${b.soldiers[e.killer].name} (${e.weapon})` : e.weapon, age: 0 }; }
                break;
            case "vehicleKill": if (me && e.killer === me.id) toast(`${b.vehicles[e.vehicle].def.name} destroyed`, [1, 0.85, 0.4, 1]); break;
            case "capture": {
                const t = b.territories.find(x => x.def.id === e.territory)!;
                const ours = me && e.team === me.team;
                toast(`${t.def.name} ${ours ? "captured" : "lost"}`, ours ? [0.5, 0.9, 1, 1] : [1, 0.5, 0.3, 1]);
                sound.capture(!!ours);
                break;
            }
            case "reward": if (me && e.soldier === me.id) { const r = REWARD.get(e.reward)!; hud.banner = { title: e.underdog ? "UNDERDOG REWARD" : "KILLSTREAK REWARD", text: `${r.name}: ${r.payload}  -  press ${me.rewards.indexOf(e.reward) + 5} to call it in at the crosshair`, age: 0 }; sound.reward(); } break;
            case "rewardUsed": if (me && b.soldiers[e.soldier].team !== me.team && ["R004", "R006", "R007"].includes(e.reward)) toast(`Enemy ${REWARD.get(e.reward)!.name} incoming!`, [1, 0.3, 0.2, 1]); break;
            case "mecha": toast(`${b.vehicles[e.vehicle].def.name} mecha deployed by ${TEAM_NAMES[e.team]}`, TEAM_COLOR[e.team].concat(1) as Color); break;
            case "airdrop": toast(`${TEAM_NAMES[e.team]} air-dropped a ${b.vehicles[e.vehicle].def.name}`, [0.9, 0.9, 0.9, 1]); break;
            case "end": setMode("end"); break;
            case "spawn": break;
        }
    }
}

function stepEffects(dt: number, b: Battle): void {
    for (const f of effects) {
        f.life -= dt;
        if (f.kind === "spark" || f.kind === "debris") { f.vel[1] -= 9.8 * dt; f.pos = [f.pos[0] + f.vel[0] * dt, f.pos[1] + f.vel[1] * dt, f.pos[2] + f.vel[2] * dt]; }
        if (f.kind === "smoke") { f.pos = [f.pos[0] + f.vel[0] * dt, f.pos[1] + f.vel[1] * dt, f.pos[2] + f.vel[2] * dt]; f.vel[1] *= 0.98; f.size += dt * 1.2; }
    }
    for (let i = effects.length - 1; i >= 0; i--) if (effects[i].life <= 0) effects.splice(i, 1);
    // Rockets leave smoke; smoke clouds billow.
    for (const p of b.projectiles) if ((p.kind === "rocket" || p.kind === "missile") && effects.length < 900 && rnd() < 0.6) effects.push({ kind: "smoke", pos: [...p.pos], to: [0, 0, 0], vel: [0, 0.3, 0], life: 1.2, max: 1.2, size: 0.6, color: [0.75, 0.73, 0.7], seed: rnd() });
}

// --- camera -----------------------------------------------------------------------------------------

function cameraNow(): { pos: V3; target: V3; fov: number } {
    if (freeCam) return freeCam;
    const b = battle, me = b?.me;
    if (!b || mode === "title" || mode === "setup" || mode === "armory") {
        const w = b?.world ?? worldFor(MAPS[setup.map].id);
        const a = realTime * 0.03;
        const t = w.territories[0];
        return { pos: [t.x + Math.sin(a) * 160, w.height(t.x, t.z) + 70, t.z + Math.cos(a) * 160], target: [t.x, w.height(t.x, t.z) + 5, t.z], fov: 55 };
    }
    if (!me || !me.alive || mode === "deploy" || mode === "end") {
        const base = b.world.bases[me?.team ?? 0];
        const a = realTime * 0.05;
        return { pos: [base.x * 0.5 + Math.sin(a) * 260, 220, base.z * 0.5 + Math.cos(a) * 260], target: [0, 0, 0], fov: 60 };
    }
    if (me.vehicle >= 0) {
        const v = b.vehicles[me.vehicle];
        const air = v.def.domain === "Air";
        const back = Math.max(8, v.def.dims[0] * 1.4), up = air ? 6 : Math.max(3.5, v.def.dims[2] * 1.4);
        const d = dirOf(lookYaw, lookPitch);
        const pos: V3 = [v.pos[0] - d[0] * back, v.pos[1] + up - d[1] * back, v.pos[2] - d[2] * back];
        pos[1] = Math.max(pos[1], b.world.height(pos[0], pos[2]) + 1.5);
        return { pos, target: [v.pos[0] + d[0] * 40, v.pos[1] + 2 + d[1] * 40, v.pos[2] + d[2] * 40], fov: 65 };
    }
    const eye = eyeOf(me);
    // Shake (explosions, heavy weapons) moves where the camera looks, not where the bullets go.
    const sh = shake * shake * 0.03, t = realTime * 37;
    const d = dirOf(lookYaw + Math.sin(t) * sh, lookPitch + Math.sin(t * 1.3 + 1) * sh);
    const fov = fovFor(zoomNow());
    if (thirdPerson) {
        const r: V3 = [Math.cos(lookYaw), 0, -Math.sin(lookYaw)];
        const pos: V3 = [eye[0] - d[0] * 3.2 + r[0] * 0.7, eye[1] + 0.4 - d[1] * 3.2, eye[2] - d[2] * 3.2 + r[2] * 0.7];
        return { pos, target: [eye[0] + d[0] * 30, eye[1] + d[1] * 30, eye[2] + d[2] * 30], fov };
    }
    return { pos: eye, target: [eye[0] + d[0] * 10, eye[1] + d[1] * 10, eye[2] + d[2] * 10], fov };
}

// --- the frame ----------------------------------------------------------------------------------------

function frame(dt: number, show = true): void {
    realTime += dt; modeAge += dt; frames++;
    const b = battle;
    const input = readInput(dt);
    // One-shot taps (weapon keys, reload, use, grenade, a semi-auto click...) stay latched until a battle
    // step has consumed them: the battle steps at 30 Hz, so at 60+ fps about half of all frames run no step
    // and a tap cleared on such a frame was simply lost.
    let consumed = true;
    if (b && (mode === "play" || mode === "deploy" || mode === "end") && b.winner === -1) {
        accum += dt;
        let n = 0;
        while (accum >= STEP && n < 3) {
            accum -= STEP; n++;
            b.step(STEP, mode === "play" ? input : NO_INPUT, think);
            if (n === 1) { input.use = false; input.reward = -1; input.call = false; input.grenade = false; input.equipment = false; input.jump = false; input.reload = false; input.slot = null; }
            onEvents(b, b.events);
            if (b.events.some(e => e.kind === "explode")) staticsDirtyAt = staticsDirtyAt < 0 ? realTime + 0.3 : staticsDirtyAt;
            b.events = [];
        }
        if (n === 3) accum = 0;
        consumed = n > 0;
        const me = b.me;
        if (me && !me.alive && mode === "play") { setMode("deploy"); spawnPick = "HQ"; }
        if (me) weaponFeel(b, me, dt, input);
        stepEffects(dt, b);
    }
    if (consumed) { pressed.clear(); clicked = false; }
    hud.hitMarker = Math.max(0, hud.hitMarker - dt);
    hud.killMarker = Math.max(0, hud.killMarker - dt);
    hud.headMarker = Math.max(0, hud.headMarker - dt);
    hud.hurt = Math.max(0, hud.hurt - dt * 0.6);
    flash = Math.max(0, flash - dt * 1.5);
    if (show) draw(dt);
}

/** Per frame: aiming down sights (eased, zoom per sight), recoil on the view and its recovery, the scope's
 * breathing sway, reload/bolt/lock sounds, the guided launcher's lock box, and the HUD's prompt and hints. */
function weaponFeel(b: Battle, me: Soldier, dt: number, input: PlayerInput): void {
    const onFoot = me.alive && me.vehicle < 0 && mode === "play";
    const w = b.weaponOf(me);
    const sight = sightOf(b, me);
    hud.ads = (aimHeld() || !!scripted?.aim) && onFoot;
    hud.zoom = sight.zoom; hud.sight = sight.kind;
    const aimTime = me.slot === "primary" ? me.stats.aimTime : 0.22;
    adsT = clamp(adsT + (hud.ads ? 1 : -1.6) * dt / Math.max(0.08, aimTime * 0.8));
    hud.adsT = adsT;
    sprintingNow = input.sprint && !hud.ads && Math.hypot(me.vel[0], me.vel[2]) > 4;
    if (!onFoot) { kickPitch = kickYaw = recoilDebt = 0; hud.lock = null; hud.prompt = ""; hud.hint = ""; hud.reloadP = -1; seenShot = me.lastShot; return; }
    // Slot changes and the swap animation.
    if (me.slot !== seenSlot) { seenSlot = me.slot; slotAt = b.time; sound.swap(); }
    // A new shot: recoil on the view (most of the climb comes back once the trigger is let go), the
    // viewmodel's kick, brass, shake for the big guns.
    if (me.lastShot !== seenShot) {
        seenShot = me.lastShot;
        const braced = me.stance !== "stand" && me.loadout.attachments.Underbarrel === "A014" && me.slot === "primary";
        const wild = w.heavy && !me.stats.heavyOk && me.stance === "stand";
        const deg = (me.slot === "primary" ? me.stats.recoil : w.recoil) * 0.6 * (hud.ads ? 0.8 : 1) * (me.stance === "prone" ? 0.55 : me.stance === "crouch" ? 0.8 : 1) * (braced ? 0.55 : 1) * (wild ? 2 : 1);
        const rad = (deg * Math.PI) / 180;
        kickPitch += rad * (0.85 + rnd() * 0.3);
        kickYaw += rad * (rnd() - 0.5) * 0.7;
        viewKick = 1;
        shake = Math.max(shake, w.speed > 0 ? 0.55 : clamp(deg / 6, 0, 0.45));
        boltSounded = !(w.action === "bolt" || w.action === "pump");
        if (portAt && w.speed === 0 && !thirdPerson && effects.length < 900) {
            const r: V3 = [-Math.cos(lookYaw), 0, Math.sin(lookYaw)];
            effects.push({ kind: "debris", pos: [...portAt], to: [0, 0, 0], vel: [r[0] * (1.4 + rnd()) + me.vel[0], 1.6 + rnd(), r[2] * (1.4 + rnd()) + me.vel[2]], life: 0.6, max: 0.6, size: 0.006, color: [0.75, 0.6, 0.25], seed: rnd() });
        }
    }
    // The bolt or pump cycles a beat after the shot.
    if (!boltSounded && b.time - me.lastShot > 0.3) { boltSounded = true; sound.cycle(w.action === "pump"); }
    const a = Math.min(1, dt * 30);
    const kp = kickPitch * a, ky = kickYaw * a;
    lookPitch = clamp(lookPitch + kp, -1.4, 1.35); lookYaw += ky;
    kickPitch -= kp; kickYaw -= ky; recoilDebt += kp * 0.6;
    if (b.time - me.lastShot > 0.14 && recoilDebt > 0) { const r = recoilDebt * Math.min(1, dt * 7); lookPitch -= r; recoilDebt -= r; }
    viewKick = Math.max(0, viewKick - dt * 9);
    shake = Math.max(0, shake - dt * 2.5);
    // Breathing sway while aiming, strongest through a scope; crouch, prone and a braced bipod calm it, and
    // holding Shift (or L3 on the pad) steadies it while aiming.
    hud.steady = hud.ads && (key("Shift") || padSprint);
    const braced = me.stance !== "stand" && me.loadout.attachments.Underbarrel === "A014";
    const amp = 0.0008 * Math.sqrt(hud.zoom) * (me.stance === "prone" ? 0.35 : me.stance === "crouch" ? 0.65 : 1) * (braced ? 0.4 : 1) * (hud.steady ? 0.12 : 1) * adsT;
    const want: [number, number] = [amp * (Math.sin(realTime * 0.83) + 0.5 * Math.sin(realTime * 1.91 + 1)), amp * 0.8 * (Math.sin(realTime * 1.17 + 2) + 0.4 * Math.sin(realTime * 2.3))];
    lookYaw += want[0] - sway[0]; lookPitch += want[1] - sway[1]; sway = want;
    // The gun trails the view a little on fast turns.
    const dy = lookYaw - prevLook[0], dp = lookPitch - prevLook[1];
    prevLook = [lookYaw, lookPitch];
    const k = Math.min(1, dt * 12);
    gunLag = [gunLag[0] + (clamp(dy / Math.max(dt, 1e-3), -6, 6) * 0.012 - gunLag[0]) * k, gunLag[1] + (clamp(dp / Math.max(dt, 1e-3), -6, 6) * 0.012 - gunLag[1]) * k];
    // Reloads: a sound when the magazine comes out and when it goes home.
    if (me.reloadUntil > 0 && reloadFrom === 0) { reloadFrom = b.time; sound.reload(false); }
    if (me.reloadUntil === 0 && reloadFrom !== 0) { reloadFrom = 0; sound.reload(true); }
    hud.reloadP = me.reloadUntil > 0 ? clamp((b.time - reloadFrom) / Math.max(0.1, me.reloadUntil - reloadFrom)) : -1;
    // A dry trigger: a click.
    if (input.fire && !fireWas && me.mag[me.slot] === 0 && me.reserve[me.slot] === 0) sound.dry();
    fireWas = input.fire;
    // Guided launchers: a box on the vehicle being locked, a beep that speeds up, a steady tone once locked.
    hud.lock = null;
    if (w.lock > 0 && me.lock.target >= 0) {
        const v = b.vehicles[me.lock.target];
        const p = Math.min(1, (b.time - me.lock.since) / w.lock);
        const s = v ? project([v.pos[0], v.pos[1] + 1, v.pos[2]]) : null;
        if (s) hud.lock = { x: s[0], y: s[1], r: clamp(Math.max(v.def.dims[0], 4) * s[2], 18, 160), p, locked: p >= 1 };
        if (realTime >= lockBeepAt) { lockBeepAt = realTime + (p >= 1 ? 0.07 : 0.3 - p * 0.18); sound.lockTone(p >= 1); }
    }
    // Prompts and hints.
    const use = useTarget();
    hud.prompt = use ? `[${hud.device === "pad" ? "Y" : "E"}] ${use.toUpperCase()}` : "";
    const sz = b.magSize(me, me.slot);
    hud.hint = me.mag[me.slot] === 0 && me.reserve[me.slot] === 0 ? (me.slot === "primary" ? "NO AMMO  -  switch weapons or find a supply crate" : "EMPTY  -  find a supply crate")
        : w.heavy && !me.stats.heavyOk && me.stance === "stand" && me.slot === "primary" ? "UNBRACED  -  crouch or go prone to fire accurately"
        : me.reloadUntil === 0 && sz > 3 && me.mag[me.slot] <= sz * 0.25 ? "LOW AMMO  -  reload" : "";
}

/** A world point on screen: [x, y, pixels per metre at that distance], or null behind the camera. */
function project(p: V3): [number, number, number] | null {
    const cam = cameraNow();
    const [w, h] = Entropy.Window.getSize();
    const f = norm([cam.target[0] - cam.pos[0], cam.target[1] - cam.pos[1], cam.target[2] - cam.pos[2]]);
    const r = norm([-f[2], 0, f[0]]);
    const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const d: V3 = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
    const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
    if (z < 0.5) return null;
    const t = Math.tan((cam.fov * Math.PI) / 360), half = h / 2;
    const x = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / z, y = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / z;
    return [w / 2 + (x / t) * half, half - (y / t) * half, half / (t * z)];
}

function ensureLevel(b: Battle): void {
    const id = b.world.def.id;
    if (staticsFor !== id) {
        staticsFor = id;
        terrainKey = renderer.levelMesh(`terrain-${id}`, () => terrainMesh(b.world));
        seaKey = b.world.sea !== null ? renderer.levelMesh(`sea-${id}`, () => seaMesh(b.world)) : "";
        packStatics(renderer, b.world);
        grassKey = "";
    }
    if (staticsDirtyAt > 0 && realTime > staticsDirtyAt) { staticsDirtyAt = -1; packStatics(renderer, b.world); }
}

function draw(dt: number): void {
    if (!renderer.ready) return;
    const b = battle;
    const world = b?.world ?? worldFor(MAPS[setup.map].id);
    const cam = cameraNow();
    const [w, h] = Entropy.Window.getSize();
    Entropy.Camera.setTransform(cam.pos, cam.target, [0, 1, 0]);
    Entropy.Camera.setFov(cam.fov);
    if (b) ensureLevel(b);
    else if (staticsFor !== world.def.id) {
        staticsFor = world.def.id;
        terrainKey = renderer.levelMesh(`terrain-${world.def.id}`, () => terrainMesh(world));
        seaKey = world.sea !== null ? renderer.levelMesh(`sea-${world.def.id}`, () => seaMesh(world)) : "";
        packStatics(renderer, world);
        grassKey = "";
    }
    const gk = `${Math.floor((cam.pos[0] + HALF) / 32)}_${Math.floor((cam.pos[2] + HALF) / 32)}`;
    if (gk !== grassKey) { grassKey = gk; packGrass(renderer, world, cam.pos); }

    renderer.solids.begin(); renderer.glows.begin(); renderer.smokes.begin();
    renderer.solid("sky", placed([0, 0, 0], 1), [1, 1, 1, 1], [LIT.sky, 0, 0, 0]);
    renderer.solid(terrainKey, placed([0, 0, 0], 1), [1, 1, 1, 1], [LIT.terrain, 0, 0, 0]);
    if (seaKey) renderer.solid(seaKey, placed([0, 0, 0], 1), [1, 1, 1, 1], [LIT.water, 0, 0, 0]);
    if (b) drawBattle(b, cam);
    renderer.solids.flush(); renderer.glows.flush(); renderer.smokes.flush();

    const def = world.def;
    const me = b?.me;
    const sun = norm(def.sun);
    const biome = ["coast", "mountain", "industrial", "city"].indexOf(def.biome);
    const emp = me && me.vehicle >= 0 && b!.vehicles[me.vehicle].empUntil > b!.time ? 1 : 0;
    renderer.writeWorld({ time: realTime, aspect: w / Math.max(1, h), fog: def.fogDensity, exposure: 1, sun, sunIntensity: 1.15, cam: cam.pos, biome, fogColor: def.haze, snowline: def.biome === "mountain" ? 105 : 9999, sky: def.sky, glowAzimuth: Math.PI * 0.75, sunColor: [1, 0.95, 0.85], ambient: 0.85, hurt: hud.hurt, flash, emp, sea: 0 });
    renderer.writePost({ fog: def.fogDensity, fogStart: 30, screen: [w, h], fogColor: def.haze, time: realTime, vignette: 0.32, grain: 0.02, hurt: Math.max(hud.hurt, me && me.alive ? clamp(1 - me.hp / 45) * 0.5 : 0), flash, emp, ads: hud.ads ? 1 : 0, exposure: 1.05, saturation: 0.88 });
    drawUi(dt, w, h);
    // The ear faces where the camera looks (the deploy and death cameras orbit, so not lookYaw).
    sound.step(realTime, { pos: cam.pos, yaw: Math.atan2(cam.target[0] - cam.pos[0], cam.target[2] - cam.pos[2]) },b && me ? clamp(me.suppression / 3 + (b.time - me.lastHitAt < 5 ? 0.4 : 0)) : 0);
}

function drawBattle(b: Battle, cam: { pos: V3 }): void {
    const me = b.me;
    // Territory rings and flags.
    for (const t of b.territories) {
        const y = b.world.height(t.def.x, t.def.z);
        const col: [number, number, number] = t.owner === -1 ? [0.8, 0.8, 0.8] : TEAM_COLOR[t.owner];
        renderer.glow(placed([t.def.x, y + 0.3, t.def.z], t.def.radius), [...col, t.contested ? 0.9 : 0.45], GLOW.flatRing, 0.04, [realTime, 0, 0, 0]);
        renderer.solid("cyl", between([t.def.x, y, t.def.z], [t.def.x, y + 9, t.def.z], 0.08), [0.3, 0.3, 0.3, 1], [LIT.prop, 0, 0, 0], [0, 3, 0, 0]);
        const flagH = 3 + Math.abs(t.progress) * 5.5;
        renderer.solid("cube", yawed([t.def.x + 0.7, y + flagH, t.def.z], Math.sin(realTime) * 0.2, 0.7, 0.4, 0.02), [...col, 1], [LIT.emissive, 0, 0.3, 0], [0, 0, 0, 0]);
        const d = Math.hypot(t.def.x - cam.pos[0], t.def.z - cam.pos[2]);
        if (d > 40) renderer.glow(placed([t.def.x, y + 14 + d * 0.02, t.def.z], 1.2 + d * 0.012), [...col, 0.9], GLOW.marker, 0.1);
    }
    // Soldiers (the player in first person is not drawn), with a simple LOD.
    const hitFlash = (s: Soldier) => (b.time - s.lastHitAt < 0.12 ? 0.6 : 0);
    for (const s of b.soldiers) {
        if (!s.alive || s.vehicle >= 0) continue;
        if (me && s.id === me.id && !thirdPerson && !freeCam) continue;
        const d = Math.hypot(s.pos[0] - cam.pos[0], s.pos[2] - cam.pos[2]);
        if (d > 420) continue;
        if (d > 130) {
            const hgt = s.stance === "prone" ? 0.4 : s.stance === "crouch" ? 1.2 : 1.75;
            renderer.solid("cube", yawed([s.pos[0], s.pos[1] + hgt / 2, s.pos[2]], s.yaw, 0.24, hgt / 2, 0.16), [...(s.team === 0 ? [0.33, 0.37, 0.4] : [0.47, 0.38, 0.28]), 1], [LIT.body, s.id, hitFlash(s), 0], [3, BODY.cloth, 0, 0]);
            // Far enemies keep a red band (a little oversized so it survives at distance).
            if (me && s.team !== me.team) renderer.solid("cube", yawed([s.pos[0], s.pos[1] + hgt * 0.72, s.pos[2]], s.yaw, 0.27, Math.min(0.12, hgt * 0.12), 0.19), [...ENEMY_MARK, 1], [LIT.body, 0, 0, 0], [0, BODY.visor, 0, 0]);
            continue;
        }
        drawSoldier(renderer, s, realTime, hitFlash(s), s.loadout.armor.Finish ? groundTint(b.world, s.pos[0], s.pos[2]) : null, me ? me.team : -1);
    }
    for (const v of b.vehicles) {
        if (!v.alive && (v.temporary || b.time - v.deadAt > 20)) continue;
        if (Math.hypot(v.pos[0] - cam.pos[0], v.pos[2] - cam.pos[2]) > 1600) continue;
        drawVehicle(renderer, b, v, realTime, b.time - (v.alive ? 0 : 99) < 0 ? 0.4 : 0);
    }
    // Projectiles, mines, deployables, clouds, strikes, the squad call.
    for (const p of b.projectiles) {
        if (p.kind === "bolt") { renderer.glow(placed(p.pos, 1.2), [1, 0.25, 0.15, 1], GLOW.dot); continue; }
        if (p.kind === "rocket" || p.kind === "missile") {
            // A body along its flight and a hot motor at the tail.
            const sp = Math.hypot(...p.vel) || 1, dv: V3 = [p.vel[0] / sp, p.vel[1] / sp, p.vel[2] / sp];
            const tail: V3 = [p.pos[0] - dv[0] * 0.9, p.pos[1] - dv[1] * 0.9, p.pos[2] - dv[2] * 0.9];
            renderer.solid("cyl", between(tail, p.pos, 0.06), [0.3, 0.32, 0.28, 1], [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]);
            renderer.glow(placed(tail, 0.45 + 0.15 * Math.sin(realTime * 60 + p.pos[0])), [1, 0.75, 0.4, 1.6], GLOW.dot);
            continue;
        }
        renderer.glow(placed(p.pos, p.kind === "grenade" ? 0.2 : 0.6), p.kind === "grenade" ? [0.4, 0.4, 0.4, 0.3] : [1, 0.7, 0.35, 1], GLOW.dot);
        if (p.kind === "grenade" || p.kind === "bomb" || p.kind === "mortar") renderer.solid("sphere-1", placed(p.pos, p.kind === "grenade" ? 0.07 : 0.3), [0.2, 0.22, 0.2, 1], [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]);
    }
    for (const m of b.mines) {
        const show = me && (m.team === me.team || Math.hypot(m.x - me.pos[0], m.z - me.pos[2]) < 6);
        if (!show) continue;
        renderer.solid("cyl", yawed([m.x, m.y, m.z], 0, m.av ? 0.3 : 0.14, 0.08, m.av ? 0.3 : 0.14), [0.25, 0.27, 0.22, 1], [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]);
        renderer.glow(placed([m.x, m.y + 0.12, m.z], 0.15), m.team === me!.team ? [0.3, 1, 0.4, 0.8] : [1, 0.2, 0.1, 0.9], GLOW.dot);
    }
    for (const d of b.deployables) {
        if (d.kind === "turret") { renderer.solid("cyl", yawed([d.x, d.y, d.z], 0, 0.35, 0.9, 0.35), [0.3, 0.32, 0.3, 1], [LIT.body, 0, 0, 0], [0, BODY.hull, 0, 0]); renderer.solid("cube", yawed([d.x, d.y + 1.1, d.z], d.yaw, 0.25, 0.2, 0.6), [0.15, 0.15, 0.15, 1], [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]); }
        else if (d.kind === "crate") renderer.solid("cube", yawed([d.x, d.y + 0.4, d.z], d.yaw, 0.6, 0.4, 0.4), [0.35, 0.33, 0.2, 1], [LIT.body, 0, 0, 0], [0, BODY.plate, 0, 0]);
        else if (d.kind === "supply") drawSupplyDrop(b, d);
        else if (d.kind === "beacon") { renderer.solid("cyl", yawed([d.x, d.y, d.z], 0, 0.05, 1.2, 0.05), [0.2, 0.2, 0.2, 1], [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]); renderer.glow(placed([d.x, d.y + 1.25, d.z], 0.3 + 0.1 * Math.sin(realTime * 6)), [...TEAM_COLOR[d.team], 1], GLOW.dot); }
    }
    for (const c of b.clouds) {
        if (c.kind === "emp") { renderer.glow(placed([c.x, c.y + 1, c.z], c.r), [0.4, 0.6, 1, 0.8], GLOW.ring, 0.1); continue; }
        for (let k = 0; k < 6; k++) { const a = k * 1.05 + c.x; renderer.smoke(placed([c.x + Math.cos(a) * c.r * 0.45, c.y + (k % 3) * 1.4, c.z + Math.sin(a) * c.r * 0.45], c.r * 0.7), [0.78, 0.78, 0.76, 0.5], k + c.z); }
    }
    for (const st of b.strikes) {
        const y = b.world.height(st.x, st.z);
        const r = st.kind === "R007" ? 60 : st.kind === "R004" ? 25 : 30;
        renderer.glow(placed([st.x, y + 0.5, st.z], r), [1, 0.15, 0.1, 0.9], GLOW.flatRing, 0.03, [realTime * 3, 0.15, 0, 0]);
    }
    if (me) { const call = b.squads[me.squad].call; if (call) { const y = b.world.height(call.x, call.z); renderer.glow(placed([call.x, y + 3, call.z], 1.5), [0.4, 1, 0.5, 1], GLOW.marker, 0.1); renderer.glow(placed([call.x, y + 0.3, call.z], 6), [0.4, 1, 0.5, 0.6], GLOW.flatRing, 0.05); } }
    // Effects.
    for (const f of effects) {
        const a = f.life / f.max;
        if (f.kind === "tracer") { const ax: V3 = [f.to[0] - f.pos[0], f.to[1] - f.pos[1], f.to[2] - f.pos[2]]; const m: Mat4 = [f.size, 0, 0, 0, 0, f.size, 0, 0, ax[0], ax[1], ax[2], 0, f.pos[0], f.pos[1], f.pos[2], 1]; renderer.glow(m, [...f.color, 1.4 * a], GLOW.beam); }
        else if (f.kind === "flash") renderer.glow(placed(f.pos, f.size), [...f.color, 2 * a], GLOW.dot);
        else if (f.kind === "spark") renderer.glow(placed(f.pos, f.size), [...f.color, a * 1.5], GLOW.dot);
        else if (f.kind === "boom") { renderer.glow(placed(f.pos, f.size * (1.2 - a * 0.4)), [...f.color, a * 2.5], GLOW.fire); renderer.glow(placed([f.pos[0], f.pos[1] + 0.2, f.pos[2]], f.size * 1.6 * (1 - a)), [1, 0.8, 0.5, a], GLOW.flatRing, 0.1); }
        else if (f.kind === "smoke") renderer.smoke(placed(f.pos, f.size), [...f.color, 0.55 * Math.min(1, a * 2)], f.seed * 50);
        else if (f.kind === "debris") renderer.solid("cube", yawed(f.pos, f.seed * 9 + f.life * 6, f.size, f.size * 0.6, f.size), [...f.color, 1], [LIT.prop, 0, 0, 0], [0, 10, 0, 0]);
    }
    // The player's weapon in first person.
    if (me && me.alive && me.vehicle < 0 && !thirdPerson && !freeCam) drawViewModel(me);
}

type Rgba = readonly [number, number, number, number];
const VM = {
    body: [0.16, 0.17, 0.17, 1] as Rgba, dark: [0.07, 0.07, 0.08, 1] as Rgba, steel: [0.3, 0.31, 0.33, 1] as Rgba,
    tan: [0.42, 0.35, 0.24, 1] as Rgba, olive: [0.27, 0.3, 0.22, 1] as Rgba, sand: [0.55, 0.5, 0.38, 1] as Rgba, glove: [0.2, 0.2, 0.18, 1] as Rgba,
};
/** Rifle-family shapes (metres in model space, bore along +z, the receiver centred on z = 0). */
interface GunShape { recv: number; h: number; barrel: number; br: number; mag: "curved" | "box" | "long" | "drum" | "belt" | "tube" | "none"; stock: "full" | "short" | "thumb" | "spade"; furn: Rgba; bolt?: boolean; brake?: boolean; coils?: boolean; jacket?: boolean }
const SHAPES: Record<string, GunShape> = {
    W001: { recv: 0.15, h: 0.04, barrel: 0.5, br: 0.009, mag: "curved", stock: "full", furn: VM.body },
    W002: { recv: 0.13, h: 0.038, barrel: 0.36, br: 0.009, mag: "curved", stock: "short", furn: VM.body },
    W003: { recv: 0.16, h: 0.042, barrel: 0.56, br: 0.011, mag: "box", stock: "full", furn: VM.tan },
    W004: { recv: 0.11, h: 0.036, barrel: 0.26, br: 0.008, mag: "long", stock: "short", furn: VM.body },
    W005: { recv: 0.14, h: 0.04, barrel: 0.56, br: 0.012, mag: "tube", stock: "full", furn: VM.tan },
    W006: { recv: 0.2, h: 0.05, barrel: 0.62, br: 0.013, mag: "drum", stock: "full", furn: VM.olive, jacket: true },
    W007: { recv: 0.24, h: 0.06, barrel: 0.8, br: 0.018, mag: "belt", stock: "spade", furn: VM.olive, jacket: true },
    W008: { recv: 0.18, h: 0.04, barrel: 0.78, br: 0.01, mag: "box", stock: "thumb", furn: VM.sand, bolt: true },
    W009: { recv: 0.17, h: 0.042, barrel: 0.6, br: 0.01, mag: "box", stock: "full", furn: VM.tan },
    W010: { recv: 0.22, h: 0.055, barrel: 0.95, br: 0.016, mag: "box", stock: "thumb", furn: VM.olive, bolt: true, brake: true },
    W016: { recv: 0.18, h: 0.045, barrel: 0.55, br: 0.012, mag: "box", stock: "full", furn: VM.steel, coils: true },
};

/** A supply drop: it falls under a parachute for SUPPLY_FALL s, then sits with a coloured smoke plume and a
 * marker over it (seen across the battlefield) while it has uses left. */
function drawSupplyDrop(b: Battle, d: Battle["deployables"][number]): void {
    const fall = clamp(1 - (b.time - d.born) / SUPPLY_FALL);
    const y = d.y + fall * fall * 70;
    const team: [number, number, number] = TEAM_COLOR[d.team];
    const crate: [number, number, number, number] = d.uses > 0 ? [0.25, 0.35, 0.2, 1] : [0.2, 0.2, 0.18, 1];
    renderer.solid("cube", yawed([d.x, y + 0.5, d.z], d.yaw, 0.8, 0.5, 0.55), crate, [LIT.body, 0, 0, 0], [0, BODY.plate, 0, 0]);
    renderer.solid("cube", yawed([d.x, y + 0.5, d.z], d.yaw, 0.82, 0.52, 0.06), [0.12, 0.12, 0.1, 1], [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]); // strap
    renderer.solid("cube", yawed([d.x, y + 1.02, d.z], d.yaw, 0.3, 0.02, 0.3), [...team, 1], [LIT.emissive, 0, 0.4, 0], [0, 0, 0, 0]);
    if (fall > 0) {
        // The parachute: a canopy and its lines.
        const top: V3 = [d.x, y + 7, d.z];
        renderer.solid("sphere-1", yawed(top, d.yaw, 3.2, 1.1, 3.2), [0.85, 0.82, 0.72, 1], [LIT.body, 0, 0, 0], [0, BODY.cloth, 0, 0]);
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) renderer.solid("cyl", between([d.x + sx * 0.5, y + 1, d.z + sz * 0.5], [d.x + sx * 2.6, y + 6.6, d.z + sz * 2.6], 0.015), [0.6, 0.6, 0.55, 1], [LIT.body, 0, 0, 0], [0, BODY.cloth, 0, 0]);
    } else if (d.uses > 0) {
        if (rnd() < 0.25 && effects.length < 900) effects.push({ kind: "smoke", pos: [d.x + (rnd() - 0.5) * 0.4, d.y + 1.2, d.z + (rnd() - 0.5) * 0.4], to: [0, 0, 0], vel: [(rnd() - 0.5) * 0.4, 2.2 + rnd(), (rnd() - 0.5) * 0.4], life: 3.5, max: 3.5, size: 0.7, color: [team[0] * 0.8 + 0.15, team[1] * 0.8 + 0.15, team[2] * 0.8 + 0.15], seed: rnd() });
        const cam = cameraNow().pos, dist = Math.hypot(d.x - cam[0], d.z - cam[2]);
        if (dist > 12 && battle?.me && battle.me.team === d.team) renderer.glow(placed([d.x, d.y + 4 + dist * 0.02, d.z], 0.6 + dist * 0.01), [0.6, 1, 0.6, 0.9], GLOW.marker, 0.1);
    }
}

/** The player's weapon in first person. Each weapon has its own shape and fitted attachments; aiming brings
 * its sight onto the view axis (and scales the model with the zoom so it keeps its size on screen), and it
 * kicks on a shot, cycles a bolt or pump, dips and tilts through a reload, drops on a weapon swap, lowers
 * while sprinting and trails fast turns. */
function drawViewModel(me: Soldier): void {
    const b = battle!;
    const w = b.weaponOf(me);
    const sight = sightOf(b, me);
    if (sight.kind === "scope" && hud.ads && adsT > 0.85) { muzzleAt = null; portAt = null; return; } // looking through the scope (ar_hud draws it)
    const eye = eyeOf(me);
    const f0 = dirOf(lookYaw, lookPitch);
    const r0 = norm([-f0[2], 0, f0[0]]);
    const u0: V3 = [r0[1] * f0[2] - r0[2] * f0[1], r0[2] * f0[0] - r0[0] * f0[2], r0[0] * f0[1] - r0[1] * f0[0]];
    const ads = adsT * adsT * (3 - 2 * adsT);
    const since = b.time - me.lastShot, cycle = 60 / w.rpm;
    const moving = Math.min(1, Math.hypot(me.vel[0], me.vel[2]) / 4);
    const sprint = sprintingNow ? 1 : 0;
    const bob = Math.sin(realTime * (sprint ? 12 : 9)) * moving * (0.008 + sprint * 0.01), swayX = Math.cos(realTime * (sprint ? 6 : 4.5)) * moving * (0.006 + sprint * 0.008);
    // Reload: dip and roll in, magazine out and back, roll out. Swap: the weapon comes up from below.
    const rl = hud.reloadP >= 0 ? hud.reloadP : -1;
    const dip = rl >= 0 ? Math.sin(Math.min(1, rl * 1.15) * Math.PI) : 0;
    const magOut = rl >= 0 ? Math.max(0, Math.sin(clamp((rl - 0.12) / 0.6) * Math.PI)) : 0;
    const swap = clamp(1 - (b.time - slotAt) / 0.4);
    const kick = viewKick * viewKick;
    // The weapon's model and where its sight sits (x, y in model space).
    const launcher = me.slot === "launcher" && w.id !== "A015";
    const shape = me.slot === "primary" || w.id === "A015" ? SHAPES[me.loadout.primary] ?? SHAPES.W001 : null;
    const optic = me.slot === "primary" ? me.loadout.attachments.Optic : undefined;
    const sightPt: [number, number] = launcher ? [-0.11, 0.06] : shape ? [0, shape.h + (optic && optic !== "A001" ? (optic === "A003" ? 0.042 : 0.036) : 0.036)] : [0, 0.052];
    // Model scale: the old view model's 0.62, times the zoom so the gun keeps its size on screen.
    const zs = zoomNow(), K = 0.62 * zs;
    // The anchor (view space, metres): hip, or the sight on the view axis when aimed.
    const hip: V3 = launcher ? [0.16, -0.11, 0.36] : me.slot === "sidearm" ? [0.12, -0.12, 0.42] : [0.13, -0.14, 0.42];
    const aim: V3 = [-sightPt[0] * K, -sightPt[1] * K, 0.38];
    const lag = gunLag;
    const ax = (hip[0] + (aim[0] / zs - hip[0]) * ads) + swayX * (1 - ads * 0.85) - lag[0] * (1 - ads * 0.7) * 0.5 + sprint * 0.04;
    const ay = (hip[1] + (aim[1] / zs - hip[1]) * ads) + bob * (1 - ads * 0.85) + lag[1] * (1 - ads * 0.7) * 0.4 - dip * 0.06 - swap * 0.2 - sprint * 0.05;
    const az = (hip[2] + (aim[2] - hip[2]) * ads) - kick * (launcher ? 0.06 : 0.035) - dip * 0.04;
    // Orientation: kick pitches the muzzle up, a reload rolls the gun, sprinting tilts it away, a swap
    // brings it up from pointing down, and fast turns yaw it behind the view.
    const pitch = kick * (launcher ? 0.12 : 0.08) * (1 - ads * 0.6) - sprint * 0.55 - swap * 0.9 + dip * 0.15 - lag[1] * 0.6 * (1 - ads);
    const yaw = sprint * 0.55 + lag[0] * 0.8 * (1 - ads);
    const roll = dip * 0.5 + sprint * 0.25;
    let F = f0, U = u0, R = r0;
    [F, U] = rot2(F, U, pitch);
    [F, R] = rot2(F, R, yaw);
    [R, U] = rot2(R, U, roll);
    const O: V3 = [eye[0] + (r0[0] * ax + u0[0] * ay + f0[0] * az) * zs, eye[1] + (r0[1] * ax + u0[1] * ay + f0[1] * az) * zs, eye[2] + (r0[2] * ax + u0[2] * ay + f0[2] * az) * zs];
    const at = (x: number, y: number, z: number): V3 => [O[0] + (R[0] * x + U[0] * y + F[0] * z) * K, O[1] + (R[1] * x + U[1] * y + F[1] * z) * K, O[2] + (R[2] * x + U[2] * y + F[2] * z) * K];
    const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: Rgba) => renderer.solid("cube", aligned2(at(x, y, z), F, U, sx * K, sy * K, sz * K), c, [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]);
    const tube = (x: number, y: number, z0: number, z1: number, rad: number, c: Rgba) => renderer.solid("cyl", between(at(x, y, z0), at(x, y, z1), rad * K), c, [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]);
    const dot = (x: number, y: number, z: number, size: number, c: readonly number[]) => renderer.glow(placed(at(x, y, z), size * K), c, GLOW.dot);
    const hand = (x: number, y: number, z: number) => renderer.solid("sphere-1", placed(at(x, y, z), 0.022 * K), VM.glove, [LIT.body, 0, 0, 0], [0, BODY.cloth, 0, 0]);
    /** A see-through sight frame (four thin bars) centred on (x, y). */
    const frame = (x: number, y: number, z: number, hw: number, hh: number, t: number, c: Rgba) => { box(x - hw, y, z, t, hh + t, t, c); box(x + hw, y, z, t, hh + t, t, c); box(x, y + hh, z, hw, t, t, c); box(x, y - hh, z, hw, t, t, c); };
    let muzzle = 0.5, flashSize = 1, portZ = 0, portY = 0;

    if (launcher) {
        // Shoulder-fired tubes: the sight sits left of the tube, on the view axis when aimed.
        const big = w.id === "W015" ? 1.2 : w.id === "W014" ? 1 : 0.8;
        const c = w.id === "W015" ? VM.sand : w.id === "W014" ? VM.olive : [0.32, 0.34, 0.25, 1] as Rgba;
        const r = 0.05 * big, z0 = -0.45 * big, z1 = 0.6 * big;
        tube(0, 0, z0, z1, r, c);
        tube(0, 0, z0 - 0.02, z0 + 0.06, r * 1.25, VM.dark);                  // venturi
        tube(0, 0, z1 - 0.04, z1 + 0.01, r * 1.12, VM.dark);                  // muzzle ring
        box(0, -r - 0.04, 0.05, 0.012, 0.04, 0.02, VM.dark);                    // grip
        box(0, -r - 0.03, 0.3 * big, 0.012, 0.03, 0.018, VM.dark);             // fore grip
        if (w.id === "W014") { box(-0.165, -0.005, 0.05, 0.02, 0.026, 0.05, VM.dark); renderer.glow(placed(at(-0.165, -0.005, -0.002), 0.01 * K), [0.3, 1, 0.5, 0.9], GLOW.dot); } // the sight unit, left of the sight frame
        if (w.id === "W015") { box(0, -r - 0.05, -0.1, 0.03, 0.03, 0.06, VM.dark); tube(-0.03, r + 0.04, 0.1, 0.32, 0.004, VM.steel); }
        frame(sightPt[0], sightPt[1], 0.12 * big, 0.022 * big, 0.018 * big, 0.003, VM.dark);
        box(sightPt[0] / 2, sightPt[1] / 2, 0.12 * big, Math.abs(sightPt[0]) / 2, 0.004, 0.004, VM.dark);   // the sight's arm
        // A loaded round shows at the front.
        if (me.mag.launcher > 0 && me.reloadUntil === 0) renderer.solid("sphere-1", placed(at(0, 0, z1 + 0.03), r * 0.9 * K), w.id === "W015" ? [0.8, 0.8, 0.75, 1] : [0.3, 0.32, 0.25, 1], [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]);
        hand(0, -r - 0.03, 0.04); hand(0, -r - 0.02, 0.3 * big);
        muzzle = z1 + 0.05; flashSize = 2.2;
        // Backblast behind the shooter.
        if (since < 0.1) renderer.glow(placed(at(0, 0, z0 - 0.1), 0.25 * K), [1, 0.7, 0.4, 2 * (1 - since * 10)], GLOW.dot);
    } else if (shape) {
        const s = shape, h = s.h, rz = s.recv;
        const att = me.loadout.attachments;
        box(0, 0, 0, 0.026 * (h / 0.04), h, rz, VM.body);                                     // receiver
        box(0, h + 0.004, -0.01, 0.011, 0.005, rz * 0.9, VM.dark);                            // top rail
        if (s.jacket) tube(0, 0.012, rz, rz + s.barrel * 0.6, s.br * 1.9, VM.dark);           // barrel jacket / heat shield
        tube(0, 0.012, rz, rz + s.barrel, s.br, VM.dark);                                      // barrel
        box(0, 0.006, rz + s.barrel * 0.28, 0.022 * (h / 0.04), 0.026 * (h / 0.04), s.barrel * 0.26, s.furn); // handguard
        box(0, -h - 0.032, -rz * 0.45, 0.012, 0.036, 0.016, VM.dark);                         // pistol grip
        // Magazine (it drops out and comes back through a reload); an extended magazine is longer.
        const ext = att.Magazine === "A016" ? 1.4 : 1, my = -magOut * 0.22;
        if (s.mag === "curved") { box(0, -h - 0.04 * ext + my, rz * 0.3, 0.011, 0.04 * ext, 0.022, VM.dark); box(0, -h - 0.08 * ext - 0.012 + my, rz * 0.3 + 0.014, 0.011, 0.016, 0.02, VM.dark); }
        else if (s.mag === "box") box(0, -h - 0.028 * ext + my, rz * 0.3, 0.012, 0.028 * ext, 0.03, VM.dark);
        else if (s.mag === "long") box(0, -h - 0.06 * ext + my, rz * 0.3, 0.01, 0.06 * ext, 0.014, VM.dark);
        else if (s.mag === "drum") { box(0, -h - 0.036 + my, rz * 0.25, 0.036, 0.036, 0.04, VM.olive); }
        else if (s.mag === "belt") { box(-0.07, -0.02 + my, 0, 0.03, 0.045, 0.07, VM.olive); box(-0.035, 0.01, 0, 0.012, 0.006, 0.02, [0.7, 0.55, 0.25, 1]); }
        else if (s.mag === "tube") tube(0, -0.024, rz, rz + s.barrel * 0.85, 0.011, VM.dark);
        // Stock.
        if (s.stock === "full") { box(0, -0.008, -rz - 0.12, 0.017, 0.034, 0.12, s.furn); box(0, -0.012, -rz - 0.245, 0.019, 0.042, 0.008, VM.dark); }
        else if (s.stock === "short") { box(0, 0.004, -rz - 0.07, 0.006, 0.006, 0.07, VM.dark); box(0, -0.01, -rz - 0.14, 0.014, 0.03, 0.008, VM.dark); }
        else if (s.stock === "thumb") { box(0, -0.016, -rz - 0.13, 0.019, 0.045, 0.13, s.furn); box(0, 0.035, -rz - 0.1, 0.012, 0.012, 0.06, s.furn); }
        else { box(-0.03, -0.03, -rz - 0.03, 0.008, 0.035, 0.008, VM.dark); box(0.03, -0.03, -rz - 0.03, 0.008, 0.035, 0.008, VM.dark); }
        // Shotgun pump, bolt handle: they cycle a beat after the shot.
        const cyc = since > 0.1 && since < Math.min(0.55, cycle) ? Math.sin(((since - 0.1) / (Math.min(0.55, cycle) - 0.1)) * Math.PI) : 0;
        if (s.mag === "tube") { box(0, -0.024, rz + s.barrel * 0.4 - cyc * 0.08, 0.02, 0.022, 0.07, s.furn); hand(0, -0.04, rz + s.barrel * 0.4 - cyc * 0.08); }
        if (s.bolt) { box(0.035, 0.012, -rz * 0.25 - cyc * 0.07, 0.012, 0.005, 0.005, VM.steel); renderer.solid("sphere-1", placed(at(0.048, 0.012, -rz * 0.25 - cyc * 0.07), 0.009 * K), VM.steel, [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]); }
        if (s.brake) box(0, 0.012, rz + s.barrel + 0.03, 0.026, 0.016, 0.03, VM.dark);
        if (s.coils) { const glowK = 0.5 + 0.5 * Math.max(0, 1 - since * 2); for (let i = 0; i < 4; i++) { tube(0, 0.012, rz + 0.06 + i * 0.1, rz + 0.09 + i * 0.1, s.br * 2.1, VM.steel); dot(0, 0.012 + s.br * 2.2, rz + 0.075 + i * 0.1, 0.012, [0.35, 0.7, 1, 1.5 * glowK]); } box(0.016, 0.03, rz + s.barrel * 0.5, 0.003, 0.004, s.barrel * 0.45, VM.dark); box(-0.016, 0.03, rz + s.barrel * 0.5, 0.003, 0.004, s.barrel * 0.45, VM.dark); }
        if (s.mag === "drum" || s.mag === "belt") { box(0, h + 0.03, 0.02, 0.006, 0.02, 0.05, VM.dark); }  // carry handle
        // Sights.
        const sy = sightPt[1];
        if (!optic || optic === "A001") {
            box(0, sy - 0.016, rz + s.barrel * 0.82, 0.0022, 0.016, 0.002, VM.dark);          // front post (its tip is the aim point)
            box(0, h + 0.012, rz + s.barrel * 0.82, 0.01, 0.008, 0.006, VM.dark);
            box(-0.008, sy - 0.006, -rz * 0.55, 0.003, 0.012, 0.004, VM.dark); box(0.008, sy - 0.006, -rz * 0.55, 0.003, 0.012, 0.004, VM.dark); // rear notch
        } else if (optic === "A002") {
            box(0, h + 0.012, 0, 0.012, 0.006, 0.022, VM.dark);
            frame(0, sy, 0.01, 0.016, 0.014, 0.0025, VM.dark);
            dot(0, sy, 0.0, 0.004, [1, 0.15, 0.1, 0.6]);
        } else if (optic === "A003") {
            box(0, h + 0.012, 0, 0.016, 0.006, 0.03, VM.dark);
            frame(0, sy, -0.02, 0.022, 0.017, 0.003, VM.dark); frame(0, sy, 0.03, 0.022, 0.017, 0.003, VM.dark);
            box(-0.022, sy, 0.005, 0.003, 0.017, 0.025, VM.dark); box(0.022, sy, 0.005, 0.003, 0.017, 0.025, VM.dark);
        } else {
            const len = optic === "A004" ? 0.07 : optic === "A005" ? 0.1 : 0.14, rad = optic === "A006" ? 0.02 : 0.017;
            box(0, h + 0.016, 0, 0.01, 0.008, 0.03, VM.dark);
            tube(0, sy, -len, len, rad, VM.dark);
            tube(0, sy, len * 0.75, len + 0.01, rad * 1.35, VM.dark);
            tube(0, sy, -len - 0.01, -len * 0.75, rad * 1.15, VM.dark);
            renderer.glow(placed(at(0, sy, len + 0.012), rad * 1.1 * K), [0.3, 0.45, 0.6, 0.5], GLOW.dot);
        }
        // Muzzle devices and underbarrel / utility attachments.
        muzzle = rz + s.barrel + (s.brake ? 0.06 : 0);
        if (att.Muzzle === "A007") { tube(0, 0.012, muzzle - 0.01, muzzle + 0.14, s.br * 1.9, VM.dark); muzzle += 0.14; flashSize = 0.35; }
        else if (att.Muzzle === "A008") { box(0, 0.012, muzzle + 0.025, 0.014, 0.014, 0.025, VM.dark); muzzle += 0.05; flashSize = 1.3; }
        else if (att.Muzzle === "A009") { tube(0, 0.012, muzzle - 0.005, muzzle + 0.045, s.br * 1.3, VM.dark); muzzle += 0.045; flashSize = 0.6; }
        const fore = rz + s.barrel * 0.32;
        if (att.Underbarrel === "A013") box(0, -0.055, fore, 0.01, 0.04, 0.012, VM.dark);
        if (att.Underbarrel === "A014") { const open = me.stance !== "stand" ? 1 : 0; box(-0.012, -0.03 - open * 0.05, rz + s.barrel * 0.55 + (1 - open) * 0.05, 0.004, 0.012 + open * 0.05, 0.05 - open * 0.045, VM.dark); box(0.012, -0.03 - open * 0.05, rz + s.barrel * 0.55 + (1 - open) * 0.05, 0.004, 0.012 + open * 0.05, 0.05 - open * 0.045, VM.dark); }
        if (att.Underbarrel === "A015") { tube(0, -0.036, rz * 0.5, rz + s.barrel * 0.35, 0.021, VM.olive); box(0, -0.06, rz * 0.6, 0.006, 0.02, 0.008, VM.dark); }
        if (att.Utility === "A017") { box(0.03, 0.005, rz + s.barrel * 0.35, 0.01, 0.012, 0.03, VM.dark); dot(0.03, 0.005, rz + s.barrel * 0.35 + 0.032, 0.006, [1, 0.1, 0.1, 1.2]); }
        if (att.Utility === "A018") { tube(-0.03, 0.005, rz + s.barrel * 0.25, rz + s.barrel * 0.45, 0.012, VM.dark); dot(-0.03, 0.005, rz + s.barrel * 0.45 + 0.004, 0.012, [1, 1, 0.9, 0.8]); }
        // Hands: grip, and the support hand on the handguard (on the magazine through a reload).
        hand(0.003, -h - 0.02, -rz * 0.45);
        if (s.mag !== "tube") magOut > 0.05 ? hand(0, -h - 0.05 - magOut * 0.1, rz * 0.3) : hand(-0.004, -0.02, w.id === "A015" ? rz * 0.9 : fore);
        portZ = rz * 0.1; portY = h * 0.5;
        if (w.id === "A015") { muzzle = rz + s.barrel * 0.35; flashSize = 0.8; }
    } else {
        // Sidearms: a slide that runs back on the shot.
        const slide = Math.max(0, 1 - since / 0.06) * 0.035;
        box(0, 0.03, 0.03 - slide, 0.014, 0.017, 0.09, VM.body);
        box(0, 0.005, 0.02, 0.013, 0.012, 0.08, VM.dark);
        box(0, -0.042, -0.04, 0.013, 0.046, 0.021, VM.dark);
        if (w.id === "W012") box(0, -0.1 + magOut * -0.2, -0.04, 0.011, 0.03, 0.017, VM.dark);
        else if (magOut > 0) box(0, -0.06 - magOut * 0.2, -0.04, 0.011, 0.03, 0.017, VM.dark);
        box(0, 0.052 - 0.006, 0.11 - slide, 0.002, 0.006, 0.002, VM.dark);                           // front sight
        box(-0.007, 0.05 - 0.004, -0.05 - slide, 0.003, 0.006, 0.003, VM.dark); box(0.007, 0.05 - 0.004, -0.05 - slide, 0.003, 0.006, 0.003, VM.dark);
        hand(0.004, -0.04, -0.04); hand(-0.008, -0.05, -0.02);
        muzzle = 0.13; flashSize = 0.8; portZ = 0.02; portY = 0.045;
    }
    // Muzzle flash: a hot core and a short flame along the bore for a couple of frames.
    muzzleAt = at(0, launcher ? 0 : 0.012, muzzle);
    portAt = at(0.03, portY, portZ);
    if (since < 0.05 && w.id !== "W016") {
        const fl = flashSize * (0.8 + 0.4 * ((realTime * 977) % 1));
        renderer.glow(placed(muzzleAt, 0.05 * fl * K), [1, 0.8, 0.45, 2.4], GLOW.dot);
        const tip = at(0, launcher ? 0 : 0.012, muzzle + 0.12 * fl);
        const ax: V3 = [tip[0] - muzzleAt[0], tip[1] - muzzleAt[1], tip[2] - muzzleAt[2]], sz = 0.025 * fl * K;
        renderer.glow([sz, 0, 0, 0, 0, sz, 0, 0, ax[0], ax[1], ax[2], 0, muzzleAt[0], muzzleAt[1], muzzleAt[2], 1], [1, 0.7, 0.35, 1.8], GLOW.beam);
    } else if (since < 0.08 && w.id === "W016") renderer.glow(placed(muzzleAt, 0.08 * K), [0.4, 0.75, 1, 2.5], GLOW.dot);
}

/** Rotates the pair (a, b) by `ang` in their plane: a toward b. */
function rot2(a: V3, b: V3, ang: number): [V3, V3] {
    const c = Math.cos(ang), s = Math.sin(ang);
    return [[a[0] * c + b[0] * s, a[1] * c + b[1] * s, a[2] * c + b[2] * s], [b[0] * c - a[0] * s, b[1] * c - a[1] * s, b[2] * c - a[2] * s]];
}

function aligned2(p: V3, f: V3, u: V3, sx: number, sy: number, sz: number): Mat4 {
    const r: V3 = [u[1] * f[2] - u[2] * f[1], u[2] * f[0] - u[0] * f[2], u[0] * f[1] - u[1] * f[0]];
    return [r[0] * sx, r[1] * sx, r[2] * sx, 0, u[0] * sy, u[1] * sy, u[2] * sy, 0, f[0] * sz, f[1] * sz, f[2] * sz, 0, p[0], p[1], p[2], 1];
}
function norm(a: V3): V3 { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

let uiTimer = 0;
function drawUi(dt: number, w: number, h: number): void {
    if (!painter) return;
    uiTimer += dt;
    if (uiTimer < 1 / 30 && !fixedStep) return;
    const step = uiTimer; uiTimer = 0;
    for (const t of hud.toasts) t.age += step;
    hud.toasts = hud.toasts.filter(t => t.age < 4);
    if (hud.banner) { hud.banner.age += step; if (hud.banner.age > 6) hud.banner = null; }
    const p = painter;
    p.begin();
    const b = battle, me = b?.me;
    if (mode === "title") drawTitle(p, w, h, modeAge, hadSave);
    else if (mode === "setup") drawSetup(p, w, h, setup);
    else if (mode === "armory") drawArmory(p, w, h, loadout, armoryCursor);
    else if (mode === "deploy" && b && me) drawDeploy(p, w, h, b, me, spawnPick, me.alive ? 0 : Math.max(0, me.respawnAt - b.time), loadoutName());
    else if (mode === "end" && b) drawDebrief(p, w, h, b, me ?? null);
    else if (mode === "play" && b && me) {
        const st = me.stats, wpn = b.weaponOf(me);
        const moving = Math.hypot(me.vel[0], me.vel[2]) > 0.8 ? 1.6 : 1;
        const deg = ((me.slot === "primary" ? (hud.ads ? st.spread : wpn.hip) : hud.ads ? wpn.aim : wpn.hip) + me.bloom) * moving * (1 + me.suppression * 0.25);
        hud.spread = (deg / 70) * h * 0.9;
        hud.scoreboard = scoreboard; hud.mapOpen = mapOpen; hud.showHelp = showHelp && modeAge < 25;
        hud.lockHint = lockSupported && !locked;
        drawHud(p, w, h, b, me, hud);
    }
    p.flush();
}

function loadoutName(): string { const s = loadoutStats(loadout); return `${WEAPON.get(loadout.primary)!.name}, ${s.weight} kg, ${Math.round(s.speedShare * 100)}% speed`; }

addon.onInit(() => {
    renderer.init();
    Entropy.setGameMode(false);
    Entropy.Lighting.updateSun({ horizonColor: [0.8, 0.8, 0.8], zenithColor: [0.6, 0.65, 0.75], sunDirection: [0.5, 0.6, 0.35], sunColor: [1, 1, 1], sunIntensity: 0 });
    painter = enginePainter(addon.UI as unknown as DrawApi);
    sound.occluded = (a, p) => !!battle && battle.world.trace(a[0], a[1], a[2], p[0], p[1] + 0.5, p[2]) < 0.97;
    lockSupported = typeof (Entropy.Input as { setPointerLock?: unknown }).setPointerLock === "function";
    load();
    setupInput();
    registerTools();
    Entropy.println("[armageddon-2070] initialized");
});

addon.onUpdatePlus("Global", () => {
    if (!renderer.ready) return;
    const now = Date.now();
    const real = lastMs ? Math.min(0.1, Math.max(0, (now - lastMs) / 1000)) : 1 / 60;
    lastMs = now;
    frame(fixedStep ?? real);
});

// --- MCP tools (tests/armageddon_live.rs drives these) ------------------------------------------------

type Args = Record<string, unknown>;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: V3): V3 => (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number") ? [v[0], v[1], v[2]] : d);

function snapshot() {
    const b = battle, me = b?.me;
    return {
        mode, frames, realTime: Math.round(realTime * 100) / 100, post: renderer.screenOn, pointerLock: lockSupported,
        scene: { solids: renderer.solids.lastStats.instances, statics: renderer.statics.lastStats.instances, grass: renderer.grass.lastStats.instances, glows: renderer.glows.lastStats.instances, smokes: renderer.smokes.lastStats.instances },
        sound: sound.played, ui: painter?.opCount() ?? 0,
        loadout: { ...loadoutStats(loadout), primary: loadout.primary, armor: loadout.armor },
        battle: b ? {
            map: b.world.def.id, time: Math.round(b.time * 10) / 10, tickets: b.tickets, winner: b.winner,
            holdings: [b.holdings(0), b.holdings(1)],
            territories: b.territories.map(t => ({ id: t.def.id, name: t.def.name, owner: t.owner, progress: Math.round(t.progress * 100) / 100, contested: t.contested, counts: t.counts })),
            soldiers: b.soldiers.filter(s => s.alive).length, inVehicles: b.soldiers.filter(s => s.alive && s.vehicle >= 0).length,
            vehicles: b.vehicles.filter(v => v.alive).map(v => ({ id: v.id, def: v.def.id, team: v.team, hp: Math.round(v.hp), crew: b.passengers(v), mecha: !!v.mecha })),
            squads: b.squads.slice(0, 32).map(q => ({ id: q.id, team: q.team, mode: q.mode, objective: q.objective, call: !!q.call, alive: q.members.filter(i => b.soldiers[i].alive).length })),
            stats: b.stats, wir: b.wirStats, mecha: b.mecha,
            me: me ? { alive: me.alive, hp: Math.round(me.hp), pos: me.pos.map(v => Math.round(v * 10) / 10), team: me.team, squad: me.squad, vehicle: me.vehicle, seat: me.seat, slot: me.slot, mag: me.mag, kills: me.kills, deaths: me.deaths, score: me.score, streak: me.streak, rewards: me.rewards, underdog: me.underdogTime, stance: me.stance, rank: b.leaderboard(me.team).findIndex(s => s.id === me.id) + 1 } : null,
        } : null,
    };
}

let undrawn = 0;
let expectMark: { pos: number[]; yaw: number } = { pos: [0, 0, 0], yaw: 0 };
function advance(n: number, input: Partial<PlayerInput> = {}, last = true): void {
    for (let i = 0; i < n; i++) {
        scripted = { ...input, frames: 1 };
        const show = last && i === n - 1;
        frame(fixedStep ?? STEP, show);
        undrawn = show ? 0 : undrawn + 1;
    }
}

/** A world point from a tool's `to`: [x, z], a territory id or name, "base0"/"base1", "enemy", "vehicle:<def id>". */
function locate(to: unknown): [number, number] | null {
    const b = battle;
    if (!b) return null;
    if (Array.isArray(to) && to.length >= 2) return [Number(to[0]), Number(to[to.length - 1])];
    const k = String(to);
    const t = b.territories.find(x => x.def.id === k || x.def.name === k);
    if (t) return [t.def.x, t.def.z];
    if (k.startsWith("base")) { const base = b.world.bases[Number(k.slice(4))]; return [base.x, base.z]; }
    if (k === "enemy") { const me = b.me!; const e = b.soldiers.filter(s => s.alive && s.team !== me.team && s.vehicle < 0).sort((p, q) => Math.hypot(p.pos[0] - me.pos[0], p.pos[2] - me.pos[2]) - Math.hypot(q.pos[0] - me.pos[0], q.pos[2] - me.pos[2]))[0]; return e ? [e.pos[0], e.pos[2]] : null; }
    if (k.startsWith("vehicle:")) { const me = b.me!; const v = b.vehicles.find(o => o.alive && o.def.id === k.slice(8) && o.team === me.team); return v ? [v.pos[0], v.pos[2]] : null; }
    return null;
}

function registerTools(): void {
    const tools: { name: string; description: string; parameters: object; run: (a: Args) => object }[] = [
        { name: "ar_state", description: "Armageddon 2070's state: mode, the loadout, the battle (tickets, territories, squads and their WIR modes, vehicles, WIR stats), the player.", parameters: { type: "object", properties: {} }, run: () => snapshot() },
        {
            name: "ar_expect", description: "Asserts the player's input state (fails the call on a mismatch): slot, ads (bool), stance, device (keys|pad), moved / turned (bool: since the previous ar_expect), mode, inVehicle (bool), launcherRounds (loaded + spare), zoomed (bool: the view is narrower than the hip FOV). Use after real key, mouse or gamepad input.",
            parameters: { type: "object", properties: { slot: { type: "string" }, ads: { type: "boolean" }, stance: { type: "string" }, device: { type: "string" }, moved: { type: "boolean" }, turned: { type: "boolean" }, mode: { type: "string" }, inVehicle: { type: "boolean" }, launcherRounds: { type: "number" }, zoomed: { type: "boolean" } } },
            run: a => {
                const me = battle?.me;
                const now = { slot: me?.slot, ads: hud.ads, stance: me?.stance, device: hud.device, mode, pos: me ? [...me.pos] : [0, 0, 0], yaw: lookYaw };
                const moved = Math.hypot(now.pos[0] - expectMark.pos[0], now.pos[2] - expectMark.pos[2]) > 0.5, turned = Math.abs(now.yaw - expectMark.yaw) > 0.05;
                const got: Record<string, unknown> = { slot: now.slot, ads: now.ads, stance: now.stance, device: now.device, mode, moved, turned, inVehicle: !!me && me.vehicle >= 0, launcherRounds: me ? me.mag.launcher + me.reserve.launcher : 0, zoomed: cameraNow().fov < HIP_FOV - 1 };
                expectMark = { pos: now.pos, yaw: now.yaw };
                const wrong = Object.keys(a).filter(k => k in got && got[k] !== a[k]);
                if (wrong.length) throw new Error(`expected ${wrong.map(k => `${k}=${String(a[k])}`).join(", ")}; got ${wrong.map(k => `${k}=${String(got[k])}`).join(", ")}`);
                return snapshot();
            },
        },
        {
            name: "ar_config", description: "Test settings: fixedStep (seconds per frame, null for real time), sound (bool), post (bool), check (bool: compare every WIR decision with its rule), thirdPerson (bool), help (bool).",
            parameters: { type: "object", properties: { fixedStep: { type: "number" }, sound: { type: "boolean" }, post: { type: "boolean" }, check: { type: "boolean" }, thirdPerson: { type: "boolean" }, help: { type: "boolean" } } },
            run: a => {
                if ("fixedStep" in a) fixedStep = a.fixedStep === null ? null : num(a.fixedStep, STEP);
                if ("sound" in a) sound.enabled = !!a.sound;
                if ("post" in a) { postOn = !!a.post; renderer.setScreen(postOn); }
                if ("check" in a && battle) battle.check = !!a.check;
                if ("thirdPerson" in a) thirdPerson = !!a.thirdPerson;
                if ("help" in a) showHelp = !!a.help;
                return snapshot();
            },
        },
        {
            name: "ar_start", description: "Starts a battle: map (glass-coast, kush-corridor, fusion-plant-seven, lhasa-arcology), team (0/1), size (soldiers per team), vehicles (bool), seed, screen (title|setup|armory|deploy|play: play spawns the player at `spawn`, a territory id or HQ).",
            parameters: { type: "object", properties: { map: { type: "string" }, team: { type: "number" }, size: { type: "number" }, vehicles: { type: "boolean" }, seed: { type: "number" }, screen: { type: "string" }, spawn: { type: "string" } } },
            run: a => {
                const i = MAPS.findIndex(m => m.id === String(a.map ?? MAPS[0].id));
                if (i < 0) throw new Error(`No map ${String(a.map)}`);
                setup.map = i; setup.team = (num(a.team, 0) ? 1 : 0) as Team; setup.size = num(a.size, 128); setup.vehicles = a.vehicles !== false;
                const screen = String(a.screen ?? "play");
                if (screen === "title" || screen === "setup" || screen === "armory") { battle = null; mode = screen; modeAge = 9; staticsFor = ""; return snapshot(); }
                startBattle(num(a.seed, 7));
                if (screen === "play") { spawnPick = String(a.spawn ?? "HQ"); battle!.me!.respawnAt = 0; deploy(); }
                return snapshot();
            },
        },
        {
            name: "ar_camera", description: "A free camera at position looking at target (world metres, or relative to the player with relative: true), fov; {release: true} returns to the game camera; {look: [yaw, pitch]} turns the player's view.",
            parameters: { type: "object", properties: { position: { type: "array" }, target: { type: "array" }, fov: { type: "number" }, relative: { type: "boolean" }, release: { type: "boolean" }, look: { type: "array" } } },
            run: a => {
                if (a.release) freeCam = null;
                else if (Array.isArray(a.look)) { lookYaw = num(a.look[0], lookYaw); lookPitch = num(a.look[1], lookPitch); }
                else {
                    const me = battle?.me;
                    const o: V3 = a.relative && me ? [...me.pos] : [0, 0, 0];
                    const p = vec(a.position, cameraNow().pos), t = vec(a.target, cameraNow().target);
                    freeCam = { pos: [p[0] + o[0], p[1] + o[1], p[2] + o[2]], target: [t[0] + o[0], t[1] + o[1], t[2] + o[2]], fov: num(a.fov, 60) };
                }
                draw(0);
                return snapshot();
            },
        },
        {
            name: "ar_act", description: "Plays. action: wait (frames); teleport (to, distance: the player stands `distance` m short of it, facing it); face (to); fire (frames, aim: bool); call (to: squad call there); reward (id: grants it, then uses it at `to`); enter (vehicle def id nearby, e.g. V005); exit; drive (frames, throttle, steer, lift); stance (stand|crouch|prone); slot (primary|sidearm|launcher); screen (title|setup|armory|deploy|play|end); scoreboard (bool); map (bool); kill (the player dies); deploy (spawn); armory (row, dir); loadout (role preset name); banner (clears banners and toasts); winTeam (team: ends the battle).",
            parameters: { type: "object", properties: { action: { type: "string" }, frames: { type: "number" } } },
            run: a => {
                const b = battle, n = Math.max(1, Math.round(num(a.frames, 1)));
                const me = b?.me;
                switch (String(a.action)) {
                    case "wait": advance(n); break;
                    case "teleport": {
                        if (!b || !me) throw new Error("no battle");
                        const p = locate(a.to); if (!p) throw new Error(`Nothing called ${String(a.to)}`);
                        const dist = num(a.distance, 0);
                        const ang = Math.atan2(p[0] - me.pos[0], p[1] - me.pos[2]);
                        const [x, z] = b.world.openNear(p[0] - Math.sin(ang) * dist, p[1] - Math.cos(ang) * dist);
                        if (me.vehicle >= 0) b.exitVehicle(me);
                        me.pos = [x, b.world.height(x, z), z]; me.vel = [0, 0, 0];
                        lookYaw = Math.atan2(p[0] - x, p[1] - z); lookPitch = 0;
                        advance(1); break;
                    }
                    case "face": { if (!me) throw new Error("no player"); const p = locate(a.to); if (!p) throw new Error(`Nothing called ${String(a.to)}`); lookYaw = Math.atan2(p[0] - me.pos[0], p[1] - me.pos[2]); lookPitch = num(a.pitch, 0); advance(1); break; }
                    case "fire": advance(n, { fire: true, aim: !!a.aim }); break;
                    case "call": { const p = locate(a.to); if (!p || !b) throw new Error("nowhere"); advance(1, { call: true, point: [p[0], b.world.height(p[0], p[1]), p[1]] }); advance(n); break; }
                    case "reward": {
                        if (!b || !me) throw new Error("no battle");
                        const id = String(a.id) as keyof typeof REWARD extends never ? string : string;
                        if (!REWARD.has(id)) throw new Error(`No reward ${id}`);
                        me.rewards.unshift(id as never);
                        const p = locate(a.to) ?? [me.pos[0] + Math.sin(lookYaw) * 40, me.pos[2] + Math.cos(lookYaw) * 40];
                        const why = b.useReward(me, 0, [p[0], b.world.height(p[0], p[1]), p[1]]);
                        if (why) throw new Error(why);
                        advance(n); break;
                    }
                    case "enter": {
                        if (!b || !me) throw new Error("no battle");
                        const v = b.vehicles.filter(o => o.alive && o.team === me.team && o.def.id === String(a.vehicle ?? "V005")).sort((p, q) => Math.hypot(p.pos[0] - me.pos[0], p.pos[2] - me.pos[2]) - Math.hypot(q.pos[0] - me.pos[0], q.pos[2] - me.pos[2]))[0];
                        if (!v) throw new Error(`No ${String(a.vehicle)}`);
                        me.pos = [v.pos[0] + 3, v.pos[1], v.pos[2]];
                        advance(1, { use: true }); advance(n); break;
                    }
                    case "exit": advance(1, { use: true }); break;
                    case "drive": advance(n, { throttle: num(a.throttle, 1), steer: num(a.steer, 0), lift: num(a.lift, 0) }); break;
                    case "stance": crouch = a.stance === "crouch"; prone = a.stance === "prone"; advance(n); break;
                    case "slot": advance(1, { slot: String(a.slot) as Slot }); break;
                    case "screen": { const s = String(a.screen) as Mode; if (["title", "setup", "armory", "deploy", "play", "end"].includes(s)) { mode = s; modeAge = num(a.age, 9); } advance(1); break; }
                    case "scoreboard": scoreboard = !!a.value; advance(1); break;
                    case "map": mapOpen = !!a.value; advance(1); break;
                    case "kill": if (b && me) b.kill(me, -1, "test"); advance(1); break;
                    case "deploy": if (b?.me) { b.me.respawnAt = 0; if (a.spawn) spawnPick = String(a.spawn); deploy(); } advance(1); break;
                    case "armory": { const rows = armoryRows(loadout).map(r => r.id); armoryCursor = String(a.row ?? rows[1]); loadout = cycleArmory(loadout, armoryCursor, num(a.dir, 1), roleIndex); advance(1); break; }
                    case "loadout": { const r = String(a.role) as keyof typeof ROLE_LOADOUTS; if (!ROLE_LOADOUTS[r]) throw new Error(`No role ${r}`); loadout = JSON.parse(JSON.stringify(ROLE_LOADOUTS[r])); if (b?.me) b.setLoadout(b.me, loadout); advance(1); break; }
                    case "banner": hud.banner = null; hud.toasts = []; showHelp = false; advance(1); break;
                    case "winTeam": if (b) { b.tickets[1 - num(a.team, 0)] = 0; for (const s of b.soldiers) if (s.team !== num(a.team, 0)) s.alive = false; } advance(n); break;
                    default: throw new Error(`Unknown action ${String(a.action)}`);
                }
                if (undrawn) draw(0);
                return snapshot();
            },
        },
    ];
    for (const t of tools) {
        addon.registerTool({ name: t.name, description: t.description, parameters: t.parameters }, (args: Args) => {
            try { return { success: true, ...t.run(args && typeof args === "object" ? args : {}) }; }
            catch (error) { return { success: false, error: (error as Error).message }; }
        });
    }
}
