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

import { Battle, STEP, NO_INPUT, eyeOf, dirOf, TEAM_NAMES, type PlayerInput, type Team, type Soldier, type Slot, type BattleEvent } from "./ar_sim";
import { think } from "./ar_bots";
import { MAPS, worldFor, HALF } from "./ar_map";
import { ROLE_LOADOUTS, REWARD, WEAPON, loadoutStats, type Loadout } from "./ar_data";
import { Renderer, terrainMesh, seaMesh } from "./ar_render";
import { packStatics, packGrass, drawSoldier, drawVehicle, groundTint, TEAM_COLOR } from "./ar_scene";
import { LIT, GLOW, BODY } from "./ar_shader";
import { drawTitle, drawSetup, drawArmory, drawDeploy, drawHud, drawDebrief, armoryRows, cycleArmory, type SetupView, type HudExtra } from "./ar_hud";
import { Sound } from "./ar_audio";
import { enginePainter, type Painter, type DrawApi, type Color } from "../allegiance/al_ui";
import { yawed, placed, between, type Mat4 } from "../world_of_music/wom_render";
import { clamp, type V3 } from "../nebula/nk_math";

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
let lockSupported = false, locked = false;
const key = (k: string) => held.has(k) || held.has(k.toLowerCase()) || held.has(k.toUpperCase());
const tapped = (k: string) => pressed.has(k) || pressed.has(k.toLowerCase()) || pressed.has(k.toUpperCase());

const hud: HudExtra = { hitMarker: 0, hurt: 0, toasts: [], banner: null, device: "keys", ads: false, spread: 8, zoom: 1, scoreboard: false, mapOpen: false, showHelp: true, fps: 0, lockHint: false, point: "" };
let flash = 0;

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

function readInput(): PlayerInput {
    const me = battle?.me;
    const playing = mode === "play" && !!me?.alive;
    const look = (Entropy.Input as { takeMouseLook?: () => number[] }).takeMouseLook?.() ?? [0, 0, 0];
    locked = look[2] > 0.5;
    if (playing) {
        const sens = (hud.ads ? 0.0011 / Math.max(1, hud.zoom * 0.6) : 0.0024);
        lookYaw -= look[0] * sens; lookPitch -= look[1] * sens;
        if (key("ArrowLeft")) lookYaw += 0.04; if (key("ArrowRight")) lookYaw -= 0.04;
        if (key("ArrowUp")) lookPitch += 0.03; if (key("ArrowDown")) lookPitch -= 0.03;
        lookPitch = clamp(lookPitch, -1.4, 1.35);
    }
    if (tapped("c")) { crouch = !crouch; prone = false; }
    if (tapped("z")) { prone = !prone; crouch = false; }
    const slot: Slot | null = tapped("1") ? "primary" : tapped("2") ? "sidearm" : tapped("3") ? "launcher" : null;
    const rewardKey = ["5", "6", "7", "8", "9"].findIndex(k => tapped(k));
    const inVeh = !!me && me.vehicle >= 0;
    const input: PlayerInput = {
        move: playing && !inVeh ? [(key("d") ? 1 : 0) - (key("a") ? 1 : 0), (key("w") ? 1 : 0) - (key("s") ? 1 : 0)] : [0, 0],
        yaw: lookYaw, pitch: lookPitch,
        fire: playing && (mouseButtons.has(0) || clicked) && !mapOpen, aim: playing && rightHeld, reload: playing && tapped("r"),
        jump: playing && tapped(" ") && !inVeh, sprint: key("Shift"), crouch: crouch && !inVeh, prone: prone && !inVeh,
        use: playing && tapped("e"), slot, grenade: playing && tapped("g"), equipment: playing && tapped("f"),
        call: playing && tapped("q"), reward: playing ? rewardKey : -1, point: playing ? crosshairPoint() : null,
        throttle: inVeh ? (key("w") ? 1 : 0) - (key("s") ? 1 : 0) : 0, steer: inVeh ? (key("a") ? 1 : 0) - (key("d") ? 1 : 0) : 0,
        lift: inVeh ? (key(" ") ? 1 : 0) - (key("Control") ? 1 : 0) : 0,
    };
    clicked = false;
    if (scripted) {
        const { frames: _n, ...rest } = scripted;
        Object.assign(input, rest);
        if (rest.yaw !== undefined) lookYaw = rest.yaw;
        if (rest.pitch !== undefined) lookPitch = rest.pitch;
        if (--scripted.frames <= 0) scripted = null;
    }
    return input;
}

function setupInput(): void {
    Entropy.Input.onKeyDown((k: string) => {
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
        if (mode === "deploy") { if (k === "Enter" || k === " ") act("deploy"); else if (k === "Escape") act("title"); return; }
        if (mode === "end") { if (k === "Enter") act("again"); else if (k === "Escape") act("title"); return; }
        if (mode === "play") {
            if (k === "Tab") scoreboard = true;
            if (lower === "m") mapOpen = !mapOpen;
            if (lower === "h") showHelp = !showHelp;
            if (lower === "v") thirdPerson = !thirdPerson;
            if (lower === "p") { postOn = !postOn; renderer.setScreen(postOn); }
            if (k === "Escape" && !locked) { setMode("deploy"); }
        }
    });
    Entropy.Input.onKeyUp((k: string) => { held.delete(k); held.delete(k.toLowerCase()); held.delete(k.toUpperCase()); if (k === "Tab") scoreboard = false; });
    Entropy.Input.onMouseDown((button: number, x: number, y: number) => {
        const hit = painter?.hit(x, y);
        if (hit) { act(hit.id); return; }
        if (mode !== "play") return;
        if (lockSupported && !locked && button === 0) { (Entropy.Input as { setPointerLock?: (b: boolean) => void }).setPointerLock?.(true); return; }
        mouseButtons.add(button);
        if (button === 0) clicked = true;
        if (button === 2) rightHeld = true;
        if (button === 1) lookDrag = [x, y];
    });
    Entropy.Input.onMouseUp((button: number) => { mouseButtons.delete(button); if (button === 2) rightHeld = false; if (button === 1) lookDrag = null; });
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
                const d = Math.hypot(e.from[0] - camPos[0], e.from[2] - camPos[2]);
                if (d < 450 && effects.length < 900) {
                    if (rnd() < (e.shooter === me?.id ? 1 : 0.45)) effects.push({ kind: "tracer", pos: [...e.from], to: [...e.to], vel: [0, 0, 0], life: 0.07, max: 0.07, size: e.heavy ? 0.09 : 0.04, color: e.team === 0 ? [0.6, 0.9, 1] : [1, 0.75, 0.4], seed: rnd() });
                    effects.push({ kind: "flash", pos: [...e.from], to: [0, 0, 0], vel: [0, 0, 0], life: 0.05, max: 0.05, size: e.heavy ? 0.9 : 0.4, color: [1, 0.8, 0.45], seed: rnd() });
                }
                sound.shot(e.from, e.heavy, e.shooter === me?.id);
                break;
            }
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
                break;
            }
            case "kill":
                if (me && e.killer === me.id) { toast(`${e.head ? "HEADSHOT  " : ""}${b.soldiers[e.victim].name}  +${e.head ? 130 : 100}`, [1, 0.85, 0.4, 1]); sound.kill(); }
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
            case "spawn": case "hit": break;
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
    const d = dirOf(lookYaw, lookPitch);
    const zoom = hud.ads ? hud.zoom : 1;
    const fov = 70 / Math.pow(Math.max(1, zoom), 0.75);
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
    const input = readInput();
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
        const me = b.me;
        if (me && !me.alive && mode === "play") { setMode("deploy"); spawnPick = "HQ"; }
        if (me) {
            hud.ads = rightHeld || !!scripted?.aim;
            hud.zoom = me.slot === "primary" ? me.stats.zoom : 1.2;
        }
        stepEffects(dt, b);
    }
    pressed.clear();
    hud.hitMarker = Math.max(0, hud.hitMarker - dt);
    hud.hurt = Math.max(0, hud.hurt - dt * 0.6);
    flash = Math.max(0, flash - dt * 1.5);
    if (show) draw(dt);
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
    sound.step(realTime, { pos: cam.pos, yaw: lookYaw }, b && me ? clamp(me.suppression / 3 + (b.time - me.lastHitAt < 5 ? 0.4 : 0)) : 0);
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
            continue;
        }
        drawSoldier(renderer, s, realTime, hitFlash(s), s.loadout.armor.Finish ? groundTint(b.world, s.pos[0], s.pos[2]) : null);
    }
    for (const v of b.vehicles) {
        if (!v.alive && (v.temporary || b.time - v.deadAt > 20)) continue;
        if (Math.hypot(v.pos[0] - cam.pos[0], v.pos[2] - cam.pos[2]) > 1600) continue;
        drawVehicle(renderer, b, v, realTime, b.time - (v.alive ? 0 : 99) < 0 ? 0.4 : 0);
    }
    // Projectiles, mines, deployables, clouds, strikes, the squad call.
    for (const p of b.projectiles) {
        if (p.kind === "bolt") { renderer.glow(placed(p.pos, 1.2), [1, 0.25, 0.15, 1], GLOW.dot); continue; }
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
        else if (d.kind === "crate" || d.kind === "supply") renderer.solid("cube", yawed([d.x, d.y + 0.4, d.z], d.yaw, 0.6, 0.4, 0.4), d.kind === "supply" ? [0.25, 0.35, 0.2, 1] : [0.35, 0.33, 0.2, 1], [LIT.body, 0, 0, 0], [0, BODY.plate, 0, 0]);
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

function drawViewModel(me: Soldier): void {
    const eye = eyeOf(me);
    const f = dirOf(lookYaw, lookPitch);
    const r = norm([-f[2], 0, f[0]]);
    const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const moving = Math.min(1, Math.hypot(me.vel[0], me.vel[2]) / 4);
    const bob = Math.sin(realTime * 9) * moving * 0.008, sway = Math.cos(realTime * 4.5) * moving * 0.006;
    const kick = Math.max(0, 0.06 - (battle!.time - me.lastShot)) * 0.6;
    const ads = hud.ads ? 1 : 0;
    const off = (x: number, y: number, z: number): V3 => [eye[0] + r[0] * x + u[0] * y + f[0] * z, eye[1] + r[1] * x + u[1] * y + f[1] * z, eye[2] + r[2] * x + u[2] * y + f[2] * z];
    const x0 = (ads ? 0 : 0.15) + sway, y0 = (ads ? -0.06 : -0.15) + bob, z0 = 0.6 - kick;
    const k = 0.62;
    const wpn = WEAPON.get(me.slot === "primary" ? me.loadout.primary : me.slot === "sidearm" ? me.loadout.sidearm : me.loadout.launcher ?? me.loadout.primary)!;
    const len = me.slot === "launcher" ? 0.9 : me.slot === "sidearm" ? 0.12 : wpn.id === "W008" || wpn.id === "W010" ? 0.55 : 0.4;
    const body: [number, number, number, number] = [0.16, 0.17, 0.17, 1], dark: [number, number, number, number] = [0.07, 0.07, 0.08, 1];
    const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: readonly number[]) => renderer.solid("cube", aligned2(off(x0 + (x - x0) * k, y0 + (y - y0) * k, z0 + (z - z0) * k), f, u, sx * k, sy * k, sz * k), c, [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]);
    if (me.slot === "launcher") { renderer.solid("cyl", between(off(x0, y0 + 0.02, z0 - 0.35), off(x0, y0 + 0.02, z0 + len), 0.05), [0.28, 0.3, 0.24, 1], [LIT.body, 0, 0, 0], [0, BODY.plate, 0, 0]); return; }
    box(x0, y0, z0, 0.025, 0.04, me.slot === "sidearm" ? 0.07 : 0.16, body);                 // receiver
    renderer.solid("cyl", between(off(x0, y0 + 0.012 * k, z0 + 0.1 * k), off(x0, y0 + 0.012 * k, z0 + (0.1 + len) * k), 0.009 * k), dark, [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]); // barrel
    box(x0, y0 + 0.01, z0 + 0.2, 0.022, 0.025, 0.09, body);                                  // handguard
    box(x0, y0 - 0.06, z0 + 0.04, 0.012, 0.045, 0.02, dark);                                 // magazine
    if (me.slot !== "sidearm") box(x0, y0 - 0.015, z0 - 0.2, 0.018, 0.035, 0.07, body);      // stock
    if (me.loadout.attachments.Optic && me.loadout.attachments.Optic !== "A001" && me.slot === "primary") box(x0, y0 + 0.055, z0, 0.014, 0.018, 0.05, dark);
    // Gloved hands.
    renderer.solid("sphere-1", placed(off(x0 + 0.003, y0 - 0.022, z0 - 0.025), 0.02), [0.2, 0.2, 0.18, 1], [LIT.body, 0, 0, 0], [0, BODY.cloth, 0, 0]);
    renderer.solid("sphere-1", placed(off(x0 - 0.006, y0 - 0.012, z0 + 0.14), 0.02), [0.2, 0.2, 0.18, 1], [LIT.body, 0, 0, 0], [0, BODY.cloth, 0, 0]);
    if (battle!.time - me.lastShot < 0.05) renderer.glow(placed(off(x0, y0 + 0.008, z0 + (0.12 + len) * k), 0.06), [1, 0.8, 0.45, 2], GLOW.dot);
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
