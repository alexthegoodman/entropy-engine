// TRUE ERROR - level 1, the Central Spire.
//
// A third-person, over-the-shoulder game on a ruined, terraformed Mars (src/games/true_error/README.md).
// Ray, the first Reborn, wakes in the Secret Doctor's lab and climbs the capital's torn spire to the
// hypercube. Models come from Meshy (assets/true_error, tools/te_assets.py); the spire itself is built
// in code (te_level.ts). This file wires the modules to the engine: input (pointer-locked mouse look, or a gamepad),
// the shoulder camera and the cutscenes, the game's fixed step (te_game.ts), the characters' skinning
// (te_skin.ts), drawing (te_render.ts), sound, the HUD, and the MCP tools tests/true_error_live.rs drives.

import { Game, NO_INPUT, LINES, ECHOES, ENEMY, RESET_REACH, type PlayerInput, type GameEvent, type Enemy } from "./te_game";
import { START, DOCTOR_POS, PEDESTAL, HYPERCUBE_Y, DARK_ZONE, CITY_FLOOR, hash, type V3, type Prop } from "./te_level";
import { Renderer, SkinnedMesh, type ModelAsset, type WorldLook } from "./te_render";
import { ARCH, GLOW, LENS } from "./te_shader";
import { archMesh, groundMesh, tesseract, EDGES, along, placeModel, rifleFrame } from "./te_scene";
import { Skeleton, Animator, skinVertices, axisAngle } from "./te_skin";
import { Sound } from "./te_audio";
import { drawHud, drawTitle, drawSubtitle, drawComplete, LENS_NAMES, TE, type HudView } from "./te_hud";
import { enginePainter, type Painter, type DrawApi, type Color } from "../allegiance/al_ui";
import { placed } from "../world_of_music/wom_render";
import { shadowCascades } from "../allegiance/al_sky";
import { Controller } from "../allegiance/al_controller";
import { StickLook } from "../armageddon/ar_aim";

const addon = Entropy.AddonAtom.register({
    name: "True Error",
    version: "0.1.0",
    description: "Level 1 of True Error: the first Reborn climbs the Central Spire of a ruined Mars to the hypercube.",
    author: ["Entropy Team", "Claude"],
    capabilities: { graphics: true, ui: true },
});

const renderer = new Renderer();
const sound = new Sound();
let painter: Painter | null = null;
let game = new Game();

type Mode = "title" | "intro" | "play" | "outro" | "complete";
let mode: Mode = "title";
let modeT = 0, realTime = 0, lastMs = 0, frames = 0, fps = 0;
let fixedStep: number | null = null;
let lens = 0;
let showHelp = true;

// --- Sun and air -----------------------------------------------------------------------------------

const SUN: V3 = (() => { const v: V3 = [0.78, 0.3, 0.24]; const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; })();
const SUN_COLOR: V3 = [1, 0.8, 0.6];
const SKY_TOP: V3 = [0.36, 0.3, 0.27];
const SKY_HORIZON: V3 = [0.86, 0.6, 0.4];
const FOG: V3 = [0.7, 0.5, 0.36];

// --- Input ---------------------------------------------------------------------------------------------

const held = new Set<string>();
const pressed = new Set<string>();
const buttons = new Set<number>();
let lookYaw = START.yaw, lookPitch = -0.1;
let lockSupported = false, locked = false, lockAskedAt = -99;
let scripted: (Partial<PlayerInput> & { frames: number }) | null = null;
/** Test tools: keep the crosshair on this machine every frame. */
let trackId: string | null = null;
const key = (k: string) => held.has(k) || held.has(k.toLowerCase()) || held.has(k.toUpperCase());
const tapped = (k: string) => pressed.has(k) || pressed.has(k.toLowerCase()) || pressed.has(k.toUpperCase());
let lastMouse: [number, number] | null = null;

// The gamepad (gilrs names, the same for Xbox and DualShock): the left stick moves (clicked: sprint until
// it is let go), the right stick looks (Armageddon's stick curve), LT aims, RT fires, A jumps, X resets a
// downed machine, Y and the D-pad switch lenses, Back toggles the help, Start or A begin and B skips.
const pad = new Controller();
const stickLook = new StickLook();
let padSprint = false;
/** The last device used, for the HUD's prompts. */
let device: "keys" | "pad" = "keys";
/**
 * This frame's stick reports, merged: the engine reports every connected pad, so with two (or a test's
 * sticks beside a real idle pad) the stick pushed further wins instead of the last report.
 */
let padIn: { l: [number, number]; r: [number, number]; t: [number, number] } | null = null;
const further = (a: [number, number], b: [number, number]): [number, number] => (Math.hypot(b[0], b[1]) > Math.hypot(a[0], a[1]) ? b : a);
const padAim = () => pad.triggers[0] > 0.35 || pad.held.has("LeftTrigger2");
const padFire = () => pad.triggers[1] > 0.5 || pad.held.has("RightTrigger2");

function setLens(l: number): void {
    if (l === lens) return;
    lens = l; sound.lens();
    if (l === LENS.simulation) game.usedSim = true;
}

function keyDown(k: string): void {
    if (held.has(k)) return;
    held.add(k); pressed.add(k);
    if (mode === "title" && (k === "Enter" || k === " ")) begin();
    else if ((mode === "intro" || mode === "outro") && k === "Escape") skipCinematic();
    else if (mode === "complete" && k === "Enter") restart();
    else if (mode === "play") {
        if (k >= "1" && k <= "5") setLens(Number(k) - 1);
        if (k === "NextLens") setLens((lens + 1) % LENS_NAMES.length);
        if (k === "PrevLens") setLens((lens + LENS_NAMES.length - 1) % LENS_NAMES.length);
        if (k.toLowerCase() === "h") showHelp = !showHelp;
        if (k === "Escape") locked = false;
    }
}
function keyUp(k: string): void { held.delete(k); held.delete(k.toLowerCase()); held.delete(k.toUpperCase()); }

/** A gamepad button as the key it stands for at this moment (null: handled elsewhere or unused). */
function padKey(button: string): string | null {
    const cinematic = mode === "intro" || mode === "outro";
    switch (button) {
        case "South": return mode === "play" ? " " : cinematic ? null : "Enter";
        case "Start": return cinematic ? "Escape" : mode === "play" ? null : "Enter";
        case "East": return cinematic ? "Escape" : null;
        case "West": return "e";
        case "North": case "DPadRight": return "NextLens";
        case "DPadLeft": return "PrevLens";
        case "DPadUp": return "1";
        case "Select": return "h";
        default: return null;
    }
}
const padSent = new Map<string, string>();

function setupInput(): void {
    Entropy.Input.onKeyDown((k: string) => { device = "keys"; keyDown(k); });
    Entropy.Input.onKeyUp((k: string) => keyUp(k));
    Entropy.Input.onGamepadAxis((l, r, t) => {
        padIn = padIn ? { l: further(padIn.l, l), r: further(padIn.r, r), t: [Math.max(padIn.t[0], t[0]), Math.max(padIn.t[1], t[1])] } : { l, r, t };
    });
    Entropy.Input.onGamepadButton((button: string, down: boolean) => {
        const fresh = pad.button(button, down);
        device = "pad";
        if (button === "LeftThumb") { if (fresh) padSprint = !padSprint; return; }
        if (fresh) { const k = padKey(button); if (k) { padSent.set(button, k); keyDown(k); } }
        else if (!down) { const k = padSent.get(button); if (k) { padSent.delete(button); keyUp(k); } }
    });
    Entropy.Input.onMouseDown((button: number) => {
        if (Entropy.Input.isPointerOverUI?.() && mode !== "play") { /* the UI is drawn, not interactive */ }
        if (mode === "title" && button === 0) { begin(); return; }
        if (mode === "complete" && button === 0) { restart(); return; }
        if (mode === "play" && lockSupported && !locked && button === 0 && realTime - lockAskedAt > 1) {
            lockAskedAt = realTime;
            Entropy.Input.setPointerLock?.(true);
            locked = true;
            return;
        }
        buttons.add(button);
    });
    Entropy.Input.onMouseUp((button: number) => buttons.delete(button));
    Entropy.Input.onMouseMove((x: number, y: number) => {
        // Without pointer lock: look while the middle button is held.
        if (!locked && lastMouse && buttons.has(2)) { lookYaw -= (x - lastMouse[0]) * 0.005; lookPitch -= (y - lastMouse[1]) * 0.004; }
        lastMouse = [x, y];
    });
}

function readLook(dt: number): void {
    const look = Entropy.Input.takeMouseLook?.() ?? [0, 0, 0];
    if (look[2] > 0.5) { locked = true; lookYaw -= look[0] * 0.0022; lookPitch -= look[1] * 0.0019; }
    else if (locked && lockSupported) locked = false;
    if (look[0] || look[1]) device = "keys";
    if (padIn) { pad.axis(padIn.l, padIn.r, realTime, padIn.t); padIn = null; }
    // Sticks and triggers go stale when a pad stops reporting; buttons get real releases.
    if (realTime - pad.lastAxis > 0.5) { pad.left = [0, 0]; pad.right = [0, 0]; pad.triggers = [0, 0]; }
    const [lx, ly] = pad.left, [rx, ry] = pad.right;
    if (lx || ly || rx || ry || pad.triggers[0] > 0.1 || pad.triggers[1] > 0.1) device = "pad";
    if (mode === "play") {
        // Slower while aiming down the rifle, like the mouse feels with the narrower view.
        const [sx, sy] = stickLook.step(rx, ry, dt);
        const k = (padAim() ? 0.55 : 1) * dt;
        lookYaw -= sx * k; lookPitch += sy * k * 0.75;
    } else stickLook.reset();
    if (key("ArrowLeft")) lookYaw += 0.035; if (key("ArrowRight")) lookYaw -= 0.035;
    if (key("ArrowUp")) lookPitch += 0.025; if (key("ArrowDown")) lookPitch -= 0.025;
    lookPitch = Math.max(-1.2, Math.min(1.0, lookPitch));
}

function playerInput(): PlayerInput {
    if (scripted) {
        const s = scripted;
        if (--s.frames <= 0) scripted = null;
        return { ...NO_INPUT, yaw: lookYaw, pitch: lookPitch, target: crosshair().point, ...s };
    }
    const [lx, ly] = pad.left;
    if (padSprint && Math.hypot(lx, ly) < 0.3) padSprint = false;
    const mx = (key("d") ? 1 : 0) - (key("a") ? 1 : 0) + lx, my = (key("w") ? 1 : 0) - (key("s") ? 1 : 0) + ly;
    // The mouse fires only once it is captured (the first click asks for the lock); the pad always can.
    const mouseFire = buttons.has(0) && (locked || !lockSupported);
    return {
        move: [Math.max(-1, Math.min(1, mx)), Math.max(-1, Math.min(1, my))], run: key("Shift") || padSprint, jump: tapped(" "),
        fire: mouseFire || padFire(), aim: buttons.has(1) || padAim(), use: tapped("e"),
        yaw: lookYaw, pitch: lookPitch, target: crosshair().point,
    };
}

// --- Camera -------------------------------------------------------------------------------------------

interface Cam { pos: V3; target: V3; fov: number }
let cam: Cam = { pos: [0, 0, 0], target: [0, 0, 1], fov: 62 };
let camDist = 2.8, aimT = 0;

function lookDir(): V3 { return [Math.sin(lookYaw) * Math.cos(lookPitch), Math.sin(lookPitch), Math.cos(lookYaw) * Math.cos(lookPitch)]; }

function shoulderCam(dt: number): Cam {
    const p = game.player;
    const aiming = p.aiming && p.alive;
    aimT += ((aiming ? 1 : 0) - aimT) * Math.min(1, dt * 10);
    const d = lookDir();
    const right: V3 = [-Math.cos(lookYaw), 0, Math.sin(lookYaw)];
    const side = 0.55 + aimT * 0.12;
    const pivot: V3 = [p.pos[0] + right[0] * side, p.pos[1] + 1.62 - aimT * 0.05, p.pos[2] + right[2] * side];
    const want = (p.speed > 4 ? 3.2 : 2.7) * (1 - aimT * 0.48) + (p.alive ? 0 : 2);
    // Pull in when a wall is behind.
    const back: V3 = [-d[0], -d[1], -d[2]];
    const hit = game.world.raycast(pivot, back, want + 0.3);
    const dist = Math.min(want, Math.max(0.4, hit.t - 0.3));
    camDist += (dist - camDist) * Math.min(1, dt * (dist < camDist ? 30 : 6));
    const pos: V3 = [pivot[0] + back[0] * camDist, pivot[1] + back[1] * camDist, pivot[2] + back[2] * camDist];
    const fov = lens === LENS.distance ? 22 : 62 - aimT * 14;
    return { pos, target: [pos[0] + d[0] * 10, pos[1] + d[1] * 10, pos[2] + d[2] * 10], fov };
}

/** What the crosshair is on: the first wall or machine along the camera's center ray. */
let crossCache: { frame: number; point: V3 | null; dist: number } = { frame: -1, point: null, dist: Infinity };
function crosshair(): { point: V3 | null; dist: number } {
    if (crossCache.frame === frames) return crossCache;
    const d = lookDir();
    const o = cam.pos;
    const hit = game.trace(o, d, 400, null);
    const t = Number.isFinite(hit.t) ? hit.t : 400;
    crossCache = { frame: frames, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], dist: Number.isFinite(hit.t) ? hit.t : Infinity };
    return crossCache;
}

// --- Cinematics ------------------------------------------------------------------------------------------

interface Shot { from: Cam; to: Cam; seconds: number }
const RAY_TO_DOCTOR = Math.atan2(DOCTOR_POS[0] - START.pos[0], DOCTOR_POS[2] - START.pos[2]);
const INTRO: Shot[] = [
    { from: { pos: [-520, 140, 640], target: [0, 60, 0], fov: 50 }, to: { pos: [-330, 90, 420], target: [0, 40, 0], fov: 50 }, seconds: 4.5 },
    { from: { pos: [175, 34, -110], target: [0, 20, 0], fov: 46 }, to: { pos: [95, 24, -46], target: [0, 18, 2], fov: 46 }, seconds: 5 },
    { from: { pos: [-11.6, 1.75, -15.2], target: [-13.6, 1.62, -15.8], fov: 38 }, to: { pos: [-12.0, 1.7, -15.3], target: [-13.6, 1.6, -15.8], fov: 34 }, seconds: 3.6 },
    { from: { pos: [-9.6, 2.1, -14.4], target: [-13.1, 1.2, -17.4], fov: 48 }, to: { pos: [-10.2, 1.9, -14.0], target: [-13.1, 1.25, -17.2], fov: 46 }, seconds: 6 },
    { from: { pos: [-15.2, 1.6, -21.4], target: [-12.8, 1.5, -18.6], fov: 44 }, to: { pos: [-15.6, 1.65, -21.0], target: [-12.8, 1.5, -18.6], fov: 42 }, seconds: 6 },
    { from: { pos: [-11.0, 1.7, -16.0], target: [-13.6, 1.5, -16.2], fov: 46 }, to: { pos: [-10.4, 1.9, -15.4], target: [-13.4, 1.4, -16.6], fov: 48 }, seconds: 6.2 },
    { from: { pos: [-12.4, 3.0, -13.0], target: [-14, 1.0, -17], fov: 55 }, to: { pos: [-11.2, 2.4, -12.2], target: [-14.0, 1.2, -17.0], fov: 52 }, seconds: 6.2 },
];
const OUTRO: Shot[] = [
    { from: { pos: [PEDESTAL[0] + 7, 16, PEDESTAL[2] - 6], target: [PEDESTAL[0], HYPERCUBE_Y - 0.5, PEDESTAL[2]], fov: 50 }, to: { pos: [PEDESTAL[0] + 4.5, 17.5, PEDESTAL[2] - 6.5], target: [PEDESTAL[0], HYPERCUBE_Y, PEDESTAL[2]], fov: 46 }, seconds: 4 },
    { from: { pos: [PEDESTAL[0] - 2.6, 15.8, PEDESTAL[2] - 4.4], target: [PEDESTAL[0], HYPERCUBE_Y, PEDESTAL[2]], fov: 40 }, to: { pos: [PEDESTAL[0] - 1.6, 16.6, PEDESTAL[2] - 3.4], target: [PEDESTAL[0], HYPERCUBE_Y, PEDESTAL[2]], fov: 34 }, seconds: 3.5 },
    { from: { pos: [PEDESTAL[0] + 14, 26, PEDESTAL[2] - 14], target: [PEDESTAL[0], HYPERCUBE_Y, PEDESTAL[2]], fov: 50 }, to: { pos: [PEDESTAL[0] + 40, 34, PEDESTAL[2] - 30], target: [PEDESTAL[0], HYPERCUBE_Y, PEDESTAL[2]], fov: 56 }, seconds: 4.5 },
];
let shots: Shot[] = [];
let shotIndex = 0, shotT = 0;
const ease = (t: number) => t * t * (3 - 2 * t);
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function cinematicCam(dt: number): Cam | null {
    const s = shots[shotIndex];
    if (!s) return null;
    shotT += dt;
    const t = ease(Math.min(1, shotT / s.seconds));
    if (shotT >= s.seconds) { shotIndex++; shotT = 0; }
    return { pos: lerp3(s.from.pos, s.to.pos, t), target: lerp3(s.from.target, s.to.target, t), fov: s.from.fov + (s.to.fov - s.from.fov) * t };
}

// --- Subtitles ---------------------------------------------------------------------------------------------

let lineQueue: { who: string; text: string; seconds: number }[] = [];
let lineNow: { who: string; text: string; seconds: number; age: number } | null = null;
function queueLines(id: string): void {
    const ls = LINES[id];
    if (!ls) return;
    lineQueue.push(...ls);
    if (id !== "intro" && id !== "outro") sound.radio();
}
function updateLines(dt: number): HudView["subtitle"] {
    if (lineNow) { lineNow.age += dt; if (lineNow.age > lineNow.seconds) lineNow = null; }
    if (!lineNow && lineQueue.length) lineNow = { ...lineQueue.shift()!, age: 0 };
    if (!lineNow) return null;
    const a = Math.min(1, lineNow.age * 4, (lineNow.seconds - lineNow.age) * 3);
    return { who: lineNow.who, text: lineNow.text, alpha: a };
}

// --- Modes ----------------------------------------------------------------------------------------------------

function setMode(m: Mode): void {
    mode = m; modeT = 0;
    if (m !== "play") { Entropy.Input.setPointerLock?.(false); locked = false; buttons.clear(); }
}
function begin(): void {
    setMode("intro");
    shots = INTRO; shotIndex = 0; shotT = 0;
    lineQueue = []; lineNow = null;
    queueLines("intro");
}
function skipCinematic(): void {
    shotIndex = shots.length;
    lineQueue = []; lineNow = null;
}
function startPlay(): void {
    setMode("play");
    lookYaw = game.player.yaw; lookPitch = -0.12;
}
function restart(): void {
    for (const c of characters.values()) c.mesh.show(false);
    game = new Game(propHalfExtents);
    lens = 0;
    setupCharacters();
    begin();
}

// --- Characters -------------------------------------------------------------------------------------------------

class Character {
    readonly sk: Skeleton;
    readonly anim: Animator;
    readonly mesh: SkinnedMesh;
    constructor(readonly asset: ModelAsset, id: string) {
        this.sk = new Skeleton(asset.glb);
        this.anim = new Animator(this.sk);
        this.mesh = new SkinnedMesh(renderer, asset, id);
    }
    /**
     * Poses, and skins and uploads when the figure is in view (or near enough to cast a shadow into
     * it); returns the model matrix to draw with. Off screen the pose still advances, unskinned.
     */
    pose(dt: number, pos: V3, yaw: number): number[] {
        const t0 = Date.now();
        this.anim.update(dt);
        const c: V3 = [pos[0], pos[1] + 1, pos[2]];
        if (inView(c, 1.6) || Math.hypot(c[0] - cam.pos[0], c[1] - cam.pos[1], c[2] - cam.pos[2]) < 8) {
            skinVertices(this.asset.glb, this.sk, this.mesh.verts);
            this.mesh.upload();
        }
        skinMs += Date.now() - t0;
        return placeModel(pos, yaw, 1, 0, this.asset.floor, 0);
    }
    /** A bone's world position, for the model matrix `m`. */
    bone(name: string, m: number[]): V3 {
        const n = this.sk.node(name);
        if (n < 0) return [m[12], m[13] + 1.4, m[14]];
        const [x, y, z] = this.sk.position(n);
        return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    }
}

const characters = new Map<string, Character>();
let skinMs = 0;
let doctorTalk = 0;

function setupCharacters(): void {
    const make = (id: string, model: string) => {
        if (characters.has(id)) return characters.get(id)!;
        const a = renderer.loadModel(model);
        if (!a || !a.glb.skin) return null;
        const c = new Character(a, id);
        characters.set(id, c);
        return c;
    };
    make("ray", "ray")?.anim.play("idle", { restart: true });
    make("doctor", "doctor")?.anim.play("idle", { restart: true });
    for (const e of game.enemies) if (e.kind === "hacked_bot") make(e.id, "hacked_bot")?.anim.play("combat_idle", { restart: true });
}

/** The props' collision half-extents (from te_level, independent of the model files). */
const propHalfExtents = (p: Prop): V3 => p.collide ?? [0, 0, 0];

// --- Effects ---------------------------------------------------------------------------------------------------

interface Spark { pos: V3; vel: V3; age: number; life: number; color: number[]; size: number }
const sparks: Spark[] = [];
interface Flash { pos: V3; color: V3; intensity: number; range: number; age: number; life: number }
const flashes: Flash[] = [];
const toasts: HudView["toasts"] = [];
let hurtT = 0;

function burst(at: V3, color: number[], n: number, speed: number, life = 0.5, size = 0.06): void {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, r = Math.sqrt(1 - u * u);
        sparks.push({ pos: [...at], vel: [Math.cos(a) * r * speed, u * speed + speed * 0.4, Math.sin(a) * r * speed], age: 0, life: life * (0.5 + Math.random()), color, size });
    }
}
function toast(text: string, color: Color): void { toasts.unshift({ text, age: 0, color }); if (toasts.length > 4) toasts.pop(); }

function handle(ev: GameEvent): void {
    switch (ev.kind) {
        case "shot":
            shotCount++;
            sound.photon(ev.at, ev.enemy);
            flashes.push({ pos: ev.at, color: ev.enemy ? [1, 0.25, 0.15] : [0.4, 0.8, 1], intensity: 2.5, range: 5, age: 0, life: 0.08 });
            break;
        case "hit": burst(ev.at, ev.target === "world" ? [1, 0.75, 0.4, 2] : [0.5, 0.85, 1, 3], ev.target === "world" ? 6 : 10, 3.5, 0.35); sound.hit(ev.at, ev.target !== "world"); break;
        case "hurt": hurtT = 0.4; sound.hurt(); break;
        case "disabled": burst(ev.at, [1, 0.3, 0.2, 3], 24, 4, 0.7); sound.disabled(ev.at); toast("MACHINE DOWN  -  E TO RESET", TE.cyan); break;
        case "reset": burst([ev.at[0], ev.at[1] + 1, ev.at[2]], [0.4, 0.9, 1, 4], 40, 2.5, 1.2, 0.05); sound.reset(ev.at); toast("MIND RESTORED", TE.cyan); break;
        case "destroyed":
            burst([ev.at[0], ev.at[1] + 0.8, ev.at[2]], [1, 0.55, 0.2, 4], 50, 7, 0.9, 0.09);
            flashes.push({ pos: [ev.at[0], ev.at[1] + 1, ev.at[2]], color: [1, 0.55, 0.25], intensity: 8, range: 12, age: 0, life: 0.5 });
            sound.explode(ev.at); toast("MACHINE DESTROYED", TE.red); break;
        case "rebooted": toast("A MACHINE REBOOTED", TE.red); break;
        case "pickup": sound.pickup(); toast("+ NUCLEAR CELL", TE.green); break;
        case "line": queueLines(ev.id); break;
        case "checkpoint": toast("CHECKPOINT", TE.brass); break;
        case "died": toast("SYSTEMS FAILING", TE.red); break;
        case "respawn": lookYaw = game.player.yaw; toast("REBOOTED AT CHECKPOINT", TE.brass); break;
        case "step": sound.step(ev.at); break;
        case "goal":
            setMode("outro");
            shots = OUTRO; shotIndex = 0; shotT = 0;
            lineQueue = []; lineNow = null;
            queueLines("outro");
            sound.hypercube();
            break;
    }
}

// --- The frame -----------------------------------------------------------------------------------------------

let levelKey = "", groundKey = "";
let uiDt = 0;
/** Smoothed milliseconds of this addon's own work per frame, and of skinning within it. */
const perf = { js: 0, skin: 0 };
/** A still camera from the test tools (screenshots from anywhere); the HUD hides while it is set. */
let stillCam: Cam | null = null;
let simPulse = 0;
/** Photon shots so far, and where te_expect last looked (moved / turned / fired are since then). */
let shotCount = 0;
let expectMark = { pos: [0, 0, 0] as V3, yaw: 0, shots: 0 };

function frame(dt: number, ui = true): void {
    const t0 = Date.now();
    realTime += dt; modeT += dt; frames++;
    fps += ((dt > 0 ? 1 / dt : 60) - fps) * 0.05;
    readLook(dt);
    if (trackId) {
        const e = game.enemies.find(x => x.id === trackId);
        if (e) {
            const at: V3 = [e.pos[0], e.pos[1] + ENEMY[e.kind].height * 0.5, e.pos[2]];
            const d: V3 = [at[0] - cam.pos[0], at[1] - cam.pos[1], at[2] - cam.pos[2]];
            lookYaw = Math.atan2(d[0], d[2]); lookPitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
        }
    }

    // Advance the game (the intro and title leave it paused; the outro lets it run on).
    if (mode === "play" || mode === "outro") {
        const input = mode === "play" ? playerInput() : { ...NO_INPUT, yaw: lookYaw, pitch: lookPitch };
        game.step(dt, input);
        for (const ev of game.events.splice(0)) handle(ev);
    }
    pressed.clear();

    // The camera.
    if (mode === "title") {
        const a = realTime * 0.03;
        cam = { pos: [Math.cos(a) * 260, 60 + Math.sin(realTime * 0.1) * 10, Math.sin(a) * 260], target: [0, 20, 0], fov: 50 };
    } else if (mode === "intro" || mode === "outro") {
        const c = cinematicCam(dt);
        if (c) cam = c;
        else if (mode === "intro") startPlay();
        else setMode("complete");
    }
    if (mode === "play") cam = shoulderCam(dt);
    if (stillCam) cam = stillCam;
    Entropy.Camera.setTransform(cam.pos, cam.target, [0, 1, 0]);
    Entropy.Camera.setFov(cam.fov);
    sound.listener = cam.pos;

    draw(dt, ui);
    perf.js += (Date.now() - t0 - perf.js) * 0.05;
}

function draw(dt: number, ui = true): void {
    const r = renderer;
    updateView();
    r.statics.begin(); r.props.begin(); r.glows.begin();
    const t = realTime;

    // The spire and the plain, cached once.
    r.put(r.statics, levelKey, IDENTITY, [1, 1, 1, 1], [ARCH.surface, 0, 0, 0]);
    r.put(r.statics, groundKey, IDENTITY, [1, 1, 1, 1], [ARCH.ground, 0, 0, 0]);
    r.put(r.statics, "sky", IDENTITY, [1, 1, 1, 1], [ARCH.sky, 0, 0, 0]);

    // Props (and the skyline).
    for (const p of game.level.props) drawProp(p);
    for (const p of game.level.skyline) drawProp(p, true);
    // Nuclear cells not yet taken.
    for (const c of game.level.pickups) {
        if (game.taken.has(c.id)) continue;
        const a = r.models.get("battery");
        const bob = Math.sin(t * 2 + c.pos[0]) * 0.06;
        if (a) r.put(r.props, "model:battery", placeModel([c.pos[0], c.pos[1] + 0.15 + bob, c.pos[2]], t * 0.8, 0.55 / a.extent, a.center[0], a.floor, a.center[1]), [1, 1, 1, 1], [0, a.flags, 0.15, 0.4], [0, 0, 0, game.open(c.pos)]);
        r.glowAt(GLOW.dot, placed([c.pos[0], c.pos[1] + 0.45 + bob, c.pos[2]], 0.6), [0.3, 1, 0.4, 0.5]);
    }

    skinMs = 0;
    drawCharacters(dt);
    drawEnemies(dt);
    perf.skin += (skinMs - perf.skin) * 0.05;
    drawEffects(dt);
    drawHypercube(t);

    r.statics.flush(); r.props.flush(); r.glows.flush();
    writeLook(dt);
    updateShadows();
    // The engine keeps UI ops until its next clear: steps run in one tick (the test tools) draw once.
    if (ui) drawUi(uiDt + dt); uiDt = ui ? 0 : uiDt + dt;
}

/** The camera frustum for this frame (inView), from cam and the window's aspect. */
const view = { pos: [0, 0, 0] as V3, f: [0, 0, 1] as V3, r: [1, 0, 0] as V3, u: [0, 1, 0] as V3, tx: 1, ty: 1, kx: 1, ky: 1 };
function updateView(): void {
    const [w, h] = Entropy.Window.getSize();
    const f = norm([cam.target[0] - cam.pos[0], cam.target[1] - cam.pos[1], cam.target[2] - cam.pos[2]]);
    const r = norm([f[2], 0, -f[0]]);
    const u: V3 = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
    view.pos = cam.pos; view.f = f; view.r = r; view.u = u;
    view.ty = Math.tan((cam.fov * Math.PI) / 360); view.tx = view.ty * (w / Math.max(1, h));
    view.kx = Math.hypot(1, view.tx); view.ky = Math.hypot(1, view.ty);
}
/** Whether a sphere touches the camera frustum (no far plane). */
function inView(c: V3, radius: number): boolean {
    const d: V3 = [c[0] - view.pos[0], c[1] - view.pos[1], c[2] - view.pos[2]];
    const z = d[0] * view.f[0] + d[1] * view.f[1] + d[2] * view.f[2];
    if (z < -radius) return false;
    const x = d[0] * view.r[0] + d[1] * view.r[1] + d[2] * view.r[2];
    const y = d[0] * view.u[0] + d[1] * view.u[1] + d[2] * view.u[2];
    return Math.abs(x) - z * view.tx <= radius * view.kx && Math.abs(y) - z * view.ty <= radius * view.ky;
}

/** Characters keep a fill of ambient light wherever they stand, so a backlit figure still reads. */
function charOpen(at: V3): number { return Math.max(0.65, game.open(at)); }

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function drawProp(p: Prop, skyline = false): void {
    const r = renderer;
    const a = r.models.get(p.model);
    if (!a) return;
    const height = a.glb.max[1] - a.glb.min[1];
    const s = skyline && p.model !== "bridge" ? p.size / height : p.size / a.extent;
    const pos: V3 = [p.pos[0], p.pos[1] - (p.sink ?? 0), p.pos[2]];
    const m = placeModel(pos, p.yaw, s, a.center[0], a.floor, a.center[1]);
    const emissive = p.model === "dark_emitter" ? 0.4 : p.model === "boiler" ? 0.12 : 0;
    const heat = p.model === "boiler" ? 0.8 : p.model === "hovercar" ? 0.6 : 0.1;
    const open = skyline ? 1 : game.open(p.pos);
    const bounds = [pos[0], pos[1] + a.extent * s * 0.5, pos[2], a.extent * s];
    r.put(r.props, `model:${p.model}@${chunkOf(pos, skyline)}`, m, [...(p.tint ?? [1, 1, 1]), 1], [0, a.flags, emissive, heat], [0, 0, 0, open], bounds);
}

/**
 * A placement's spatial batch: the skyline by ring and 30-degree sector, the spire's props by floor
 * and quadrant. Each chunk is its own instanced batch with its own bounds, so the engine culls it
 * per pass (the camera and every shadow cascade) instead of drawing every copy of a model.
 */
function chunkOf(p: V3, skyline: boolean): string {
    if (skyline) {
        const d = Math.hypot(p[0], p[2]);
        const ring = d < 260 ? 0 : d < 500 ? 1 : d < 900 ? 2 : 3;
        return `r${ring}s${Math.floor(((Math.atan2(p[2], p[0]) + Math.PI) / (Math.PI * 2)) * 12) % 12}`;
    }
    return `f${Math.round(p[1] / 7)}${p[0] < 0 ? "w" : "e"}${p[2] < 0 ? "n" : "s"}`;
}

function animFor(c: Character, name: string, opts: Parameters<Animator["play"]>[1] = {}): void { c.anim.play(name, opts); }

function drawCharacters(dt: number): void {
    const r = renderer;
    const ray = characters.get("ray");
    const p = game.player;
    const t = realTime;
    // Ray.
    if (ray) {
        let yaw = p.yaw;
        if (mode === "intro" || mode === "title") { yaw = RAY_TO_DOCTOR; animFor(ray, "idle"); }
        else if (!p.alive) animFor(ray, "death", { loop: false, fade: 0.15 });
        else if (!p.grounded && p.vel[1] > 1) animFor(ray, "jump", { loop: false, fade: 0.1, speed: 1.6 });
        else if (p.speed > 0.4) {
            if (p.aiming) {
                const back = Math.cos(p.yaw - Math.atan2(p.vel[0], p.vel[2])) < -0.3;
                animFor(ray, back ? "walk_back_shoot" : "walk_shoot", { fade: 0.2, speed: Math.max(0.7, p.speed / 1.6) });
            } else if (p.speed > 3.6) animFor(ray, "run", { fade: 0.2, speed: p.speed / 5.2 });
            else animFor(ray, "walk", { fade: 0.25, speed: p.speed / 1.9 });
        } else animFor(ray, p.aiming ? "combat_idle" : "idle", { fade: 0.3 });
        // Aim the upper body up and down with the camera.
        const spine = ray.sk.node("Spine02");
        if (spine >= 0) {
            if (p.aiming && p.alive && mode === "play") ray.sk.extra.set(spine, axisAngle([1, 0, 0], -lookPitch * 0.7));
            else ray.sk.extra.delete(spine);
        }
        const show = !(mode === "play" && camDist < 0.6);
        ray.mesh.show(show);
        const m = ray.pose(dt, p.pos, yaw);
        r.writeRecord(ray.mesh.buffer, m, [1, 1, 1, 1], [0, ray.asset.flags, 0, 0.75], [0, p.hurtT > 0 ? 0.12 : 0, game.player.darkT * 0.6, charOpen(p.pos)]);
        // The rifle, in the right hand, pointing where Ray aims (lowered otherwise).
        const rifle = r.models.get("rifle");
        if (rifle && show && p.alive && mode !== "intro" && mode !== "title") {
            const hand = ray.bone("RightHand", m);
            const aimDir = p.aiming ? lookDir() : (() => { const a = p.yaw, d = -0.55; return [Math.sin(a) * Math.cos(d), Math.sin(d), Math.cos(a) * Math.cos(d)] as V3; })();
            const at: V3 = [hand[0] + aimDir[0] * 0.22, hand[1] + aimDir[1] * 0.22 + 0.04, hand[2] + aimDir[2] * 0.22];
            const s = 0.95 / rifle.extent;
            const frameM = rifleFrame(at, aimDir, s);
            // Recenter the model on its bounds.
            const cx = rifle.center[0], cy = (rifle.glb.min[1] + rifle.glb.max[1]) / 2, cz = rifle.center[1];
            frameM[12] -= frameM[0] * cx + frameM[4] * cy + frameM[8] * cz;
            frameM[13] -= frameM[1] * cx + frameM[5] * cy + frameM[9] * cz;
            frameM[14] -= frameM[2] * cx + frameM[6] * cy + frameM[10] * cz;
            r.put(r.props, "model:rifle", frameM, [1, 1, 1, 1], [0, rifle.flags, p.firing > 0.15 ? 0.6 : 0.05, 0.5], [0, 0, 0, game.open(p.pos)]);
            if (p.firing > 0.17) r.glowAt(GLOW.dot, placed(game.muzzle(), 0.35), [0.5, 0.85, 1, 1.2]);
        }
    }
    // The Secret Doctor, in his lab.
    const doc = characters.get("doctor");
    if (doc) {
        const near = Math.hypot(cam.pos[0] - DOCTOR_POS[0], cam.pos[2] - DOCTOR_POS[2]) < 40 && cam.pos[1] < 12;
        doc.mesh.show(near);
        if (near) {
            const talking = !!lineNow && lineNow.who.startsWith("THE SECRET");
            if (talking) { doctorTalk += dt; animFor(doc, Math.floor(doctorTalk / 4) % 2 ? "talk2" : "talk", { fade: 0.4 }); }
            else animFor(doc, "idle", { fade: 0.5 });
            const yaw = mode === "intro" ? Math.atan2(START.pos[0] - DOCTOR_POS[0], START.pos[2] - DOCTOR_POS[2]) : Math.atan2(p.pos[0] - DOCTOR_POS[0], p.pos[2] - DOCTOR_POS[2]);
            const m = doc.pose(dt, DOCTOR_POS, yaw);
            r.writeRecord(doc.mesh.buffer, m, [1, 1, 1, 1], [0, doc.asset.flags, 0, 0.9], [0, 0, 0, charOpen(DOCTOR_POS)]);
        }
    }
    void t;
}

function drawEnemies(dt: number): void {
    const r = renderer;
    const t = realTime;
    for (const e of game.enemies) {
        const glitch = e.state === "restored" || e.state === "destroyed" ? 0 : e.state === "stunned" ? 1 : 0.55;
        const tint = e.state === "restored" ? [0.8, 0.9, 1.05, 1] : [1, 1, 1, 1];
        const open = charOpen(e.pos);
        if (e.kind === "hacked_bot") {
            const c = characters.get(e.id);
            if (!c) continue;
            const visible = e.state !== "destroyed" || e.stateT < 6;
            const near = Math.hypot(cam.pos[0] - e.pos[0], cam.pos[1] - e.pos[1], cam.pos[2] - e.pos[2]) < 60;
            c.mesh.show(visible && near);
            if (!visible || !near) continue;
            if (e.state === "destroyed") animFor(c, "death", { loop: false, fade: 0.1 });
            else if (e.state === "stunned") animFor(c, "stun", { loop: false, fade: 0.15 });
            else if (e.state === "restored") animFor(c, "combat_idle", { fade: 0.6, speed: 0.4 });
            else if (e.hitFlash > 0.9 && e.state === "fight") animFor(c, "hit", { loop: false, fade: 0.08, restart: true });
            else if (c.anim.current === "hit" && !c.anim.finished) { /* let the flinch finish */ }
            else if (e.moving > 0.3) animFor(c, e.state === "patrol" ? "walk" : "walk_shoot", { fade: 0.25, speed: e.state === "patrol" ? 0.9 : 1.1 });
            else animFor(c, "combat_idle", { fade: 0.3 });
            const sink = e.state === "destroyed" ? Math.max(0, e.stateT - 4) * 0.4 : 0;
            const m = c.pose(dt, [e.pos[0], e.pos[1] - sink, e.pos[2]], e.yaw);
            r.writeRecord(c.mesh.buffer, m, tint, [0, c.asset.flags, 0, e.state === "destroyed" ? Math.max(0, 0.9 - e.stateT * 0.2) : 0.9], [0, e.hitFlash * 0.6, glitch, open]);
            if (e.state === "stunned" && Math.random() < dt * 8) burst(c.bone("Spine02", m), [1, 0.4, 0.2, 3], 3, 2.5, 0.3);
        } else {
            if (e.state === "destroyed") {
                if (e.stateT < 3) r.glowAt(GLOW.dot, placed([e.pos[0], e.pos[1] + 0.5, e.pos[2]], 1.6 * Math.max(0, 1 - e.stateT / 3)), [1, 0.5, 0.2, 0.6]);
                continue;
            }
            const a = r.models.get("roller");
            if (!a) continue;
            const s = 1.1 / a.extent;
            const stunned = e.state === "stunned";
            const pitch = stunned ? 0.45 + Math.sin(t * 9) * 0.05 : Math.sin(e.roll) * 0.05 + e.moving * 0.12;
            const roll = stunned ? 0.3 : Math.sin(t * 2 + e.pos[0]) * 0.04;
            const bob = stunned ? 0 : Math.sin(t * 5 + e.pos[2]) * 0.03;
            const m = placeModel([e.pos[0], e.pos[1] + bob, e.pos[2]], e.yaw + Math.PI / 2, s, a.center[0], a.floor, a.center[1], pitch, roll);
            r.put(r.props, "model:roller", m, tint, [0, a.flags, 0, 0.85], [0, e.hitFlash * 0.6, glitch, open]);
            // Its eye.
            const eye: V3 = [e.pos[0], e.pos[1] + 1.05 + bob, e.pos[2]];
            const eyeC = e.state === "restored" ? [0.3, 0.8, 1, 1.2] : stunned ? [1, 0.2, 0.1, Math.random() < 0.5 ? 1 : 0.1] : [1, 0.15, 0.08, 1.4];
            r.glowAt(GLOW.dot, placed(eye, 0.25), eyeC);
            if (stunned && Math.random() < dt * 10) burst([e.pos[0], e.pos[1] + 0.6, e.pos[2]], [1, 0.6, 0.2, 3], 3, 3, 0.3);
        }
        // Prompt ring under a downed machine.
        if (e.state === "stunned") {
            const left = 1 - e.stateT / 10;
            r.glowAt(GLOW.ring, placed([e.pos[0], e.pos[1] + 0.05, e.pos[2]], RESET_REACH * 0.6, 1, RESET_REACH * 0.6), [0.3, 0.85, 1, 0.7 * left + 0.2], [0, 0, 0, 0], false, "ring");
        }
        // The simulation lens sees hacked machines through walls.
        if (lens === LENS.simulation && (e.state === "patrol" || e.state === "fight" || e.state === "alert")) {
            r.glowAt(GLOW.dot, placed([e.pos[0], e.pos[1] + ENEMY[e.kind].height * 0.6, e.pos[2]], 1.2), [1, 0.2, 0.15, 0.5], [0, 0, 0, 0], true);
        }
    }
}

function drawEffects(dt: number): void {
    const r = renderer;
    const t = realTime;
    // Photon bolts: a short streak travels from the muzzle to where it struck.
    for (const b of game.bolts) {
        const k = Math.min(1, b.age / 0.06);
        const from = lerp3(b.from, b.to, Math.max(0, k - 0.35)), to = lerp3(b.from, b.to, k);
        const m = [1, 0, 0, 0, 0, 1, 0, 0, to[0] - from[0], to[1] - from[1], to[2] - from[2], 0, from[0], from[1], from[2], 1];
        r.glowAt(GLOW.beam, m, b.enemy ? [1, 0.2, 0.1, 3] : [0.35, 0.8, 1, 3.5], [0.07, 0, 0, 0]);
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.age += dt;
        if (s.age > s.life) { sparks.splice(i, 1); continue; }
        s.vel[1] -= 9 * dt;
        s.pos = [s.pos[0] + s.vel[0] * dt, s.pos[1] + s.vel[1] * dt, s.pos[2] + s.vel[2] * dt];
        const fade = 1 - s.age / s.life;
        r.glowAt(GLOW.dot, placed(s.pos, s.size * (0.6 + fade)), [s.color[0], s.color[1], s.color[2], s.color[3] * fade]);
    }
    if (sparks.length > 600) sparks.splice(0, sparks.length - 600);
    // The dark zone: a churning shell, and shards drifting around the bomb fragment.
    const c = DARK_ZONE.center;
    // Its foot is hidden in the slab (a dome below the floor showed through the ceiling under it).
    r.glowAt(GLOW.dark, placed([c[0], c[1] + 2.4, c[2]], DARK_ZONE.radius, 2.6, DARK_ZONE.radius), [0.6, 0.2, 1, 0.55], [0, 0, 0, 0], false, "sphere");
    for (let i = 0; i < 18; i++) {
        const a = t * (0.2 + hash(i) * 0.3) + i * 2.1, rr = 1 + hash(i, 1) * 3.5;
        r.glowAt(GLOW.mote, placed([c[0] + Math.cos(a) * rr, c[1] + 0.6 + hash(i, 2) * 2.4 + Math.sin(t + i) * 0.2, c[2] + Math.sin(a) * rr], 0.12), [0.55, 0.15, 1, 1.4]);
    }
    // Dust in the wind through the torn side, around the camera.
    for (let i = 0; i < 70; i++) {
        const span = 16;
        const x = cam.pos[0] + (((hash(i, 3) * span + t * (1.2 + hash(i) * 0.8)) % span) - span / 2);
        const y = cam.pos[1] + (hash(i, 4) - 0.4) * 6 + Math.sin(t * 0.7 + i) * 0.3;
        const z = cam.pos[2] + (hash(i, 5) - 0.5) * span;
        r.glowAt(GLOW.mote, placed([x, y, z], 0.025 + hash(i, 6) * 0.03), [1, 0.75, 0.5, 0.35]);
    }
    // The simulation lens: the old world's light along the way to the hypercube.
    if (lens === LENS.simulation) {
        ECHOES.forEach((p, i) => {
            const pulse = 0.5 + 0.5 * Math.sin(t * 3 - i * 0.6);
            r.glowAt(GLOW.dot, placed([p[0], p[1] + 0.4, p[2]], 0.5 + pulse * 0.2), [0.3, 0.9, 1, 0.5 + pulse], [0, 0, 0, 0], true);
        });
    }
    // The objective ring at the pedestal.
    r.glowAt(GLOW.ring, placed([PEDESTAL[0], PEDESTAL[1] + 0.05, PEDESTAL[2]], 5, 1, 5), [0.4, 0.8, 1, 0.5], [0, 0, 0, 0], false, "ring");
    for (const f of flashes) f.age += dt;
    for (let i = flashes.length - 1; i >= 0; i--) if (flashes[i].age > flashes[i].life) flashes.splice(i, 1);
}

function drawHypercube(t: number): void {
    const r = renderer;
    const center: V3 = [PEDESTAL[0], HYPERCUBE_Y + Math.sin(t * 0.8) * 0.12, PEDESTAL[2]];
    const pts = tesseract(t, center, mode === "outro" ? 2.6 + Math.min(1, modeT * 0.2) : 2.6);
    const bright = mode === "outro" ? 1.5 + modeT * 0.3 : 1;
    for (const [a, b] of EDGES) r.glowAt(GLOW.edge, along(pts[a], pts[b], 0.035), [0.55, 0.85, 1, 1.3 * bright], [0, 0, 0, 0], false, "box");
    for (const p of pts) r.glowAt(GLOW.dot, placed(p, 0.28), [0.7, 0.9, 1, 1.1 * bright]);
    r.glowAt(GLOW.dot, placed(center, 2.6 + Math.sin(t * 2) * 0.2), [0.3, 0.55, 1, 0.35 * bright]);
    r.glowAt(GLOW.holo, placed(center, 1.15), [0.4, 0.8, 1, 0.5], [0, 0, 0, 0], false, "box");
}

function writeLook(dt: number): void {
    const p = game.player;
    simPulse = lens === LENS.simulation ? (simPulse + dt) : 0;
    // The lights nearest the camera (level lights first, then flashes), with flicker.
    const lights = [
        ...game.level.lights.map(l => ({ pos: l.pos, range: l.range, color: l.color, intensity: l.intensity * (l.flicker ? 1 - l.flicker * 0.5 * (Math.sin(realTime * 23 + l.pos[0]) * 0.5 + 0.5) * (Math.sin(realTime * 7.3) > 0.6 ? 1 : 0.3) : 1) })),
        ...flashes.map(f => ({ pos: f.pos, range: f.range, color: f.color, intensity: f.intensity * (1 - f.age / f.life) })),
    ].filter(l => inView(l.pos, l.range)).sort((a, b) => Math.hypot(a.pos[0] - cam.pos[0], a.pos[1] - cam.pos[1], a.pos[2] - cam.pos[2]) - a.range * 2 - (Math.hypot(b.pos[0] - cam.pos[0], b.pos[1] - cam.pos[1], b.pos[2] - cam.pos[2]) - b.range * 2)).slice(0, 16);
    const glitch = Math.min(1, p.darkT * 0.9 + (p.alive ? 0 : 0.6) + (hurtT > 0 ? 0.25 : 0) + (mode === "outro" && shotIndex >= 1 ? 0.4 : 0));
    const look: WorldLook = {
        time: realTime, exposure: 1, lens, glitch,
        sun: SUN, sunIntensity: 2.1, sunColor: SUN_COLOR, ambient: 1.35,
        skyTop: SKY_TOP, skyHorizon: SKY_HORIZON, simPulse,
        ground: [0.36, 0.22, 0.15], interior: 0.3,
        dark: DARK_ZONE.center, darkRadius: DARK_ZONE.radius, darkStrength: 1, hitFlash: 0,
        lights,
    };
    renderer.writeWorld(look);
    hurtT = Math.max(0, hurtT - dt);
    const [w, h] = Entropy.Window.getSize();
    const d = norm([cam.target[0] - cam.pos[0], cam.target[1] - cam.pos[1], cam.target[2] - cam.pos[2]]);
    const right = norm([d[2], 0, -d[0]]);
    // right = forward x up, so screen-right; up = right x forward.
    const rr: V3 = [-right[0], -right[1], -right[2]];
    const up = norm([rr[1] * d[2] - rr[2] * d[1], rr[2] * d[0] - rr[0] * d[2], rr[0] * d[1] - rr[1] * d[0]]);
    const cinematic = mode === "intro" || mode === "outro";
    renderer.writePost({
        fogDensity: 0.022, fogHeight: 115, fogFloor: CITY_FLOOR, time: realTime, fogColor: FOG, exposure: 1.1,
        vignette: cinematic ? 0.55 : 0.32, grain: lens === LENS.night ? 0.06 : 0.025, hurt: Math.min(1, hurtT * 2 + (p.integrity < 25 && mode === "play" ? 0.25 : 0)),
        fade: mode === "intro" && shotIndex === 0 ? Math.max(0, 1 - shotT) : mode === "complete" ? 0.4 : !p.alive ? Math.min(0.9, p.deadT * 0.4) : 0,
        lens, glitch, letterbox: cinematic ? 1 : 0, saturation: lens === LENS.none ? 1.05 : 1,
        forward: d, tanHalf: Math.tan((cam.fov * Math.PI) / 360), right: [-rr[0], -rr[1], -rr[2]], aspect: w / Math.max(1, h), up, simPulse, sun: SUN, sunGlow: 1.4,
    });
    if (p.darkT > 0.05 && Math.random() < dt * 3) sound.darkHum(p.darkT);
}

function norm(v: V3): V3 { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

function updateShadows(): void {
    const f = norm([cam.target[0] - cam.pos[0], cam.target[1] - cam.pos[1], cam.target[2] - cam.pos[2]]);
    const s = shadowCascades(cam.pos, f, SUN, [10, 34, 110, 420], 2048);
    Entropy.Lighting.setSunShadows({ cascades: s.cascades, texel: s.texel, depthRange: s.depthRange, strength: 0.92, mapSize: 2048 });
}

function objective(): string {
    const f = game.floorOf(game.player.pos[1]);
    if (f === 0) return "Climb the core stairs to the second floor";
    if (f === 1) return "Find a way past the dark zone, up to the atrium";
    return "Reach the hypercube";
}

function drawUi(dt: number): void {
    if (!painter) return;
    const p = painter;
    const [w, h] = Entropy.Window.getSize();
    p.begin();
    for (const t of toasts) t.age += dt;
    while (toasts.length && toasts[toasts.length - 1].age > 3.2) toasts.pop();
    const sub = updateLines(dt);
    if (mode === "title") drawTitle(p, w, h, realTime);
    else if (mode === "play" && stillCam) drawSubtitle(p, w, h, sub, false);
    else if (mode === "play") {
        const e = game.resettable();
        const view: HudView = {
            integrity: game.player.integrity, energy: game.player.energy, lens, objective: objective(),
            prompt: e ? (device === "pad" ? "X" : "E") + "  RESET ALGORITHM     or shoot to destroy" : !game.player.alive ? "Rebooting..." : "",
            subtitle: sub, toasts, hurt: hurtT, crosshair: game.player.alive, aiming: game.player.aiming, showHelp,
            dark: game.player.darkT, range: lens === LENS.distance ? crosshair().dist : null, lockHint: lockSupported && !locked && device === "keys", pad: device === "pad", fps,
        };
        drawHud(p, w, h, view);
        drawSubtitle(p, w, h, sub, false);
    } else if (mode === "intro" || mode === "outro") {
        drawSubtitle(p, w, h, sub, true);
        if (mode === "intro" && shotIndex === 0) p.textC("TRUE ERROR", w / 2, h * 0.36, Math.min(110, w / 9), [TE.brass[0], TE.brass[1], TE.brass[2], Math.min(1, shotT * 0.8)], "Bungee");
    } else if (mode === "complete") {
        drawComplete(p, w, h, { time: game.time, resets: game.resets, destroyed: game.destroyed, deaths: game.deaths }, modeT);
    }
    p.flush();
}

// --- Start -------------------------------------------------------------------------------------------------

function loadEverything(): void {
    for (const name of ["ray", "doctor", "hacked_bot", "rifle", "roller", "workbench", "upload_pod", "holo_terminal", "battery", "rubble", "girders", "pedestal", "junk", "boiler", "carcass", "tower_a", "tower_b", "bridge", "hovercar", "dark_emitter"]) {
        try { renderer.loadModel(name); } catch (e) { Entropy.println(`[true-error] ${name}: ${(e as Error).message}`); }
    }
    if (renderer.missing.length) Entropy.println(`[true-error] models not found (run tools/te_assets.py): ${renderer.missing.join(", ")}`);
    const level = game.level;
    // The mesh key carries a fingerprint of the layout so an edited level rebuilds.
    const sig = level.boxes.length * 31 + level.ramps.length * 7 + Math.round(level.boxes.reduce((s, b) => s + b.min[0] * 3 + b.max[1] * 5 + b.max[2] * 7 + b.mat, 0) * 10);
    levelKey = renderer.levelMesh(`spire-${sig}-v3`, () => archMesh(level.boxes, level.ramps));
    groundKey = renderer.levelMesh("plain-v1", () => groundMesh(CITY_FLOOR, 4000));
    setupCharacters();
}

addon.onInit(() => {
    renderer.read = path => addon.IO.readAsset(path);
    renderer.init();
    Entropy.setGameMode?.(false);
    Entropy.Lighting.updateSun({ horizonColor: SKY_HORIZON, zenithColor: SKY_TOP, sunDirection: SUN, sunColor: SUN_COLOR, sunIntensity: 0 });
    painter = enginePainter(addon.UI as unknown as DrawApi);
    lockSupported = typeof Entropy.Input.setPointerLock === "function";
    loadEverything();
    setupInput();
    registerTools();
    Entropy.println("[true-error] initialized");
});

addon.onUpdatePlus("Global", () => {
    if (!renderer.ready) return;
    const now = Date.now();
    const real = lastMs ? Math.min(0.1, Math.max(0, (now - lastMs) / 1000)) : 1 / 60;
    lastMs = now;
    frame(fixedStep ?? real);
});

// --- MCP tools (tests/true_error_live.rs drives these) ---------------------------------------------------------------

type Args = Record<string, unknown>;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: V3): V3 => (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number") ? [v[0], v[1], v[2]] : d);

function snapshot() {
    const p = game.player;
    return {
        mode, frames, realTime: Math.round(realTime * 100) / 100, perf: { js: Math.round(perf.js * 10) / 10, skin: Math.round(perf.skin * 10) / 10 }, lens: LENS_NAMES[lens], post: renderer.screenOn, missing: renderer.missing,
        models: [...renderer.models.keys()], characters: [...characters.keys()],
        scene: { props: renderer.props.lastStats.instances, glows: renderer.glows.lastStats.instances, statics: renderer.statics.lastStats.instances },
        sound: sound.played, ui: painter?.opCount() ?? 0, subtitle: lineNow?.text ?? null,
        player: { pos: p.pos.map(v => Math.round(v * 100) / 100), yaw: Math.round(p.yaw * 100) / 100, integrity: Math.round(p.integrity), energy: Math.round(p.energy), alive: p.alive, grounded: p.grounded, aiming: p.aiming, dark: Math.round(p.darkT * 100) / 100 },
        enemies: game.enemies.map((e: Enemy) => ({ id: e.id, state: e.state, hp: Math.round(e.hp), pos: e.pos.map(v => Math.round(v * 10) / 10) })),
        checkpoint: game.checkpoint, resets: game.resets, destroyed: game.destroyed, deaths: game.deaths, won: game.won, said: [...game.said],
    };
}

function advance(n: number, input?: Partial<PlayerInput>): void {
    if (input) scripted = { ...input, frames: n };
    for (let i = 0; i < n; i++) frame(fixedStep ?? 1 / 60, i === n - 1);
}

function registerTools(): void {
    const tools: { name: string; description: string; parameters: object; run: (a: Args) => unknown }[] = [
        {
            name: "te_state", description: "True Error: the game's state.", parameters: { type: "object", properties: {} },
            run: () => snapshot(),
        },
        {
            name: "te_expect",
            description: "True Error: asserts the state after real key, mouse or gamepad input (fails the call on a mismatch): mode, lens (name), device (keys|pad), aiming, run (bool), moved / turned / fired (bool: since the previous te_expect).",
            parameters: { type: "object", properties: {} },
            run: (a) => {
                const p = game.player;
                const now = { mode, lens: LENS_NAMES[lens], device, aiming: p.aiming, run: padSprint || key("Shift"),
                    moved: Math.hypot(p.pos[0] - expectMark.pos[0], p.pos[2] - expectMark.pos[2]) > 0.3,
                    turned: Math.abs(lookYaw - expectMark.yaw) > 0.05, fired: shotCount > expectMark.shots, pad: { left: pad.left, sinceAxis: Math.round((realTime - pad.lastAxis) * 100) / 100 }, pos: game.player.pos.map(v => Math.round(v * 100) / 100) };
                expectMark = { pos: [...p.pos] as V3, yaw: lookYaw, shots: shotCount };
                const wrong = Object.entries(a).filter(([k, v]) => k in now && (now as Record<string, unknown>)[k] !== v);
                if (wrong.length) throw new Error(`expected ${JSON.stringify(Object.fromEntries(wrong))}, got ${JSON.stringify(now)}`);
                return now;
            },
        },
        {
            name: "te_act",
            description: "True Error: drive the game. action: begin | skip | play (jump to play) | step (frames) | move (dx, dy, run, frames) | look (yaw, pitch) | fire (frames, aim) | use | lens (index 0-4) | teleport (pos, yaw) | face (at) | fixed (dt or 0) | camera (pos, target, fov: a still frame) | win | restart | help (on).",
            parameters: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
            run: (a) => {
                const n = Math.max(1, Math.floor(num(a.frames, 1)));
                switch (String(a.action)) {
                    case "begin": begin(); advance(n); break;
                    case "skip": skipCinematic(); advance(n); break;
                    case "play": if (mode === "title") begin(); skipCinematic(); advance(2); if (mode !== "play") startPlay(); advance(n); break;
                    case "step": advance(n); break;
                    case "move": advance(n, { move: [num(a.dx, 0), num(a.dy, 1)], run: !!a.run, aim: !!a.aim }); break;
                    case "look": lookYaw = num(a.yaw, lookYaw); lookPitch = num(a.pitch, lookPitch); advance(n); break;
                    case "face": { const at = vec(a.at, [0, 0, 0]); const p = game.player.pos; lookYaw = Math.atan2(at[0] - p[0], at[2] - p[2]); lookPitch = Math.atan2(at[1] - p[1] - 1.6, Math.hypot(at[0] - p[0], at[2] - p[2])); game.player.yaw = lookYaw; advance(n); break; }
                    case "fire": trackId = typeof a.aimAt === "string" ? a.aimAt : null; advance(n, { fire: true, aim: true }); trackId = null; break;
                    case "use": advance(1, { use: true }); advance(n); break;
                    case "lens": lens = Math.max(0, Math.min(4, Math.floor(num(a.index, 0)))); if (lens === LENS.simulation) game.usedSim = true; advance(n); break;
                    case "teleport": { const p = game.player; p.pos = vec(a.pos, p.pos); p.vel = [0, 0, 0]; p.yaw = num(a.yaw, p.yaw); lookYaw = p.yaw; lookPitch = num(a.pitch, -0.1); advance(n); break; }
                    case "fixed": fixedStep = num(a.dt, 0) > 0 ? num(a.dt, 0) : null; break;
                    case "camera": {
                        // A still frame from anywhere (for screenshots): the play camera is paused while set.
                        stillCam = { pos: vec(a.pos, cam.pos), target: vec(a.target, cam.target), fov: num(a.fov, 55) };
                        advance(n);
                        break;
                    }
                    case "release": stillCam = null; advance(n); break;
                    case "win": game.player.pos = [PEDESTAL[0] + 3.5, PEDESTAL[1], PEDESTAL[2] - 3]; advance(n); break;
                    case "restart": restart(); advance(n); break;
                    case "help": showHelp = !!a.on; advance(1); break;
                    default: throw new Error(`Unknown action ${String(a.action)}`);
                }
                return snapshot();
            },
        },
    ];
    for (const t of tools) {
        addon.registerTool({ name: t.name, description: t.description, parameters: t.parameters }, (args: Args) => {
            try { return { success: true, ...t.run(args && typeof args === "object" ? args : {}) as object }; }
            catch (error) { return { success: false, error: (error as Error).message }; }
        });
    }
}
