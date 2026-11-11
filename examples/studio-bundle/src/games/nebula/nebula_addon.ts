// NEBULA KINGDOM
//
// You are a living nebula. You are born the size of a moon; you feed on motes, rubble, worlds
// and at last stars, and end wider than any star there is. Other living things share the dark
// - shoals, hunters, rival clouds, leviathans - and five governments rule them, speaking (as
// everything here does) in lightwaves you cannot see until you attune to them. Black holes
// cannot be eaten: they are outrun, slung around, hidden behind, and led by the nose.
// Docs: docs/NEBULA_KINGDOM.md.
//
// This file wires the game's modules to the engine:
// - nk_data / nk_world / nk_game: the rules, the regions, the simulation (pure TypeScript);
// - nk_shader / nk_render / nk_meshes / nk_scene: two pipelines and what is drawn through them;
// - nk_hud / nk_audio: every screen, and the sound.
// It reads input, steps the game, draws it, saves the campaign, and registers the MCP tools the
// live test (tests/nebula_live.rs) drives.

import { Game, NO_INPUT, newCampaign, type Campaign, type GameEvent, type NkInput } from "./nk_game";
import { ABILITIES, ABILITY_IDS, FACETS, FACET_IDS, FACET_MAX, FACTIONS, GALAXIES, GOVERNMENTS, REGIONS, MAX_LEVEL, KIND_LABEL, LOOK_LABEL, compare, formatKm, galaxyById, levelProgress, rankOf, standingTier, tierRadius, massOfRadius, radiusOfLevel, type FacetId, type RGB } from "./nk_data";
import { add, sub, mul, len, dist, norm, cross, dot, clamp, type V3 } from "./nk_math";
import { Renderer, type WorldLook } from "./nk_render";
import { drawScene, nebulaPalette, type Particle } from "./nk_scene";
import { GLOW_KIND } from "./nk_shader";
import { drawHud, drawChart, drawCodex, drawTitle, drawDispersed, drawFold, drawCrowned, type HudView, type HudMarker, type HudFocus, type ChartView, type CodexView } from "./nk_hud";
import { Sound } from "./nk_audio";
import { enginePainter, type Painter, type DrawApi } from "../allegiance/al_ui";
import { Controller } from "../allegiance/al_controller";

const addon = Entropy.AddonAtom.register({
    name: "Nebula Kingdom",
    version: "0.1.0",
    description: "You are a living nebula: born the size of a moon, grown wider than a star. Feed, fight, bargain with five governments, and outwit black holes across six galaxies.",
    author: ["Entropy Team", "Claude"],
    capabilities: { graphics: true, ui: true },
});

const SAVE_PATH = "campaign.json";
const renderer = new Renderer();
const sound = new Sound();
const controller = new Controller();
let painter: Painter | null = null;

type Mode = "title" | "play" | "chart" | "codex";
let mode: Mode = "title";
let game: Game = new Game();
let saved: Campaign | null = null;
let realTime = 0;
let fixedStep: number | null = null;
let lastMs = 0;
let frames = 0;
let lastSave = 0;
let freeCam: { pos: V3; target: V3; fov: number } | null = null;
let chartSelected = REGIONS[0].id;
let chartNote = "";
let crownedAt = -1;
let crownedSeen = false;

const hud = {
    banner: null as HudView["banner"],
    toasts: [] as { text: string; age: number }[],
    hurt: 0, flash: 0, attune: 0, fade: 0, timer: 0,
};
const particles: Particle[] = [];
let lastScene = { solids: 0, glows: 0, lights: 0, holes: 0 };

// --- Input --------------------------------------------------------------------------------------------

const held = new Set<string>();
const pressed = new Set<string>();
const padPressed = new Set<string>();
let mouseDeltaX = 0;
let mouseDeltaY = 0;
let lastMouse: [number, number] | null = null;
let fireHeld = false;
let scripted: (Partial<NkInput> & { frames: number }) | null = null;
const key = (k: string) => held.has(k) || held.has(k.toLowerCase()) || held.has(k.toUpperCase());
const tapped = (k: string) => pressed.has(k) || pressed.has(k.toUpperCase());

function readInput(): NkInput {
    const L = controller.left, R = controller.right;
    let mdx = 0, mdy = 0;
    if (mode === "play") {
        mdx = mouseDeltaX;
        mdy = mouseDeltaY;
        mouseDeltaX = 0;
        mouseDeltaY = 0;
    }
    const kx = (key("ArrowRight") ? 1 : 0) - (key("ArrowLeft") ? 1 : 0), ky = (key("ArrowUp") ? 1 : 0) - (key("ArrowDown") ? 1 : 0);
    const input: NkInput = {
        thrust: clamp((key("w") ? 1 : 0) - (key("s") ? 1 : 0) + L[1], -1, 1),
        strafe: -clamp((key("d") ? 1 : 0) - (key("a") ? 1 : 0) + L[0], -1, 1),
        lift: (key(" ") || controller.held.has("South") ? 1 : 0) - (key("Control") || controller.held.has("East") ? 1 : 0),
        turnX: -clamp(kx + R[0], -1, 1),
        turnY: clamp(ky + R[1], -1, 1),
        fire: fireHeld || controller.held.has("RightTrigger2") || controller.held.has("RightTrigger"),
        surge: key("Shift") || controller.held.has("LeftTrigger2") || controller.held.has("LeftTrigger"),
        siphon: key("e") || controller.held.has("West"),
        pulse: tapped("q") || padPressed.has("RightThumb"),
        veil: tapped("c") || padPressed.has("DPadDown"),
        attune: tapped("t") || padPressed.has("DPadUp"),
        decoy: tapped("f") || padPressed.has("DPadLeft"),
        flare: tapped("r") || padPressed.has("North"),
        tribute: tapped("g") || padPressed.has("DPadRight"),
        lookYaw: mdx * 0.0035,
        lookPitch: -mdy * 0.0035,
    };
    if (scripted) {
        const { frames: _n, ...rest } = scripted;
        Object.assign(input, rest);
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
        if (mode === "title") { if (k === "Enter" || k === " ") act(saved ? "continue" : "new"); return; }
        if (crownedAt >= 0 && !crownedSeen) { if (k === "Enter" || k === " " || k === "Escape") act("reign"); return; }
        if (lower === "m") { setMode(mode === "chart" ? "play" : "chart"); return; }
        if (k === "Tab") { setMode(mode === "codex" ? "play" : "codex"); return; }
        if (k === "Escape") { if (mode !== "play") setMode("play"); else { save(); setMode("title"); } return; }
        if (mode === "chart") {
            const i = REGIONS.findIndex(r => r.id === chartSelected);
            if (k === "ArrowRight" || k === "ArrowDown") chartSelected = REGIONS[Math.min(REGIONS.length - 1, i + 1)].id;
            if (k === "ArrowLeft" || k === "ArrowUp") chartSelected = REGIONS[Math.max(0, i - 1)].id;
            if (k === "Enter") act(`fold:${chartSelected}`);
            chartNote = "";
        }
        if (mode === "codex" && /^[1-6]$/.test(k)) act(`facet:${FACET_IDS[Number(k) - 1]}`);
    });
    Entropy.Input.onKeyUp((k: string) => { held.delete(k); held.delete(k.toLowerCase()); held.delete(k.toUpperCase()); });
    Entropy.Input.onMouseDown((button: number, x: number, y: number) => {
        if (mode === "play" && !lastMouse) lastMouse = [x, y];
        const hit = painter?.hit(x, y);
        if (hit) { act(hit.id); return; }
        if (button === 0 && mode === "play") fireHeld = true;
    });
    Entropy.Input.onMouseMove((x: number, y: number) => {
        if (painter) painter.hover = painter.hit(x, y)?.id ?? null;
        if (mode === "play") {
            if (lastMouse) {
                const dx = clamp(x - lastMouse[0], -200, 200);
                const dy = clamp(y - lastMouse[1], -200, 200);
                mouseDeltaX += dx;
                mouseDeltaY += dy;
            }
            lastMouse = [x, y];
        } else {
            lastMouse = null;
            mouseDeltaX = 0;
            mouseDeltaY = 0;
        }
    });
    Entropy.Input.onMouseUp((button: number) => { if (button === 0) fireHeld = false; });
    Entropy.Input.onGamepadAxis((l, r) => controller.axis(l, r, realTime));
    Entropy.Input.onGamepadButton((b, down) => {
        const fresh = controller.button(b, down);
        if (!fresh) return;
        padPressed.add(b);
        if (mode === "title" && (b === "South" || b === "Start")) act(saved ? "continue" : "new");
        else if (b === "Start") setMode(mode === "chart" ? "play" : "chart");
        else if (b === "Select") setMode(mode === "codex" ? "play" : "codex");
    });
}

function setMode(m: Mode): void {
    if (mode === m) return;
    mode = m;
    sound.ui();
    if (m === "chart") { chartSelected = game.nextRegion() && game.regionComplete ? game.nextRegion()!.id : game.region.def.id; chartNote = ""; }
    fireHeld = false;
    lastMouse = null;
    mouseDeltaX = 0;
    mouseDeltaY = 0;
}

/** A button or hotspot was clicked (or its key pressed). */
function act(id: string): void {
    sound.ui();
    if (id === "continue" && saved) { game = new Game(saved); mode = "play"; afterStart(); }
    else if (id === "new") { game = new Game(newCampaign()); mode = "play"; afterStart(); save(); }
    else if (id === "sound") sound.enabled = !sound.enabled;
    else if (id === "reign") { crownedSeen = true; }
    else if (id.startsWith("fold:")) {
        const region = id.slice(5);
        if (chartSelected !== region) { chartSelected = region; chartNote = ""; return; }
        const can = game.canFold(region);
        if (!can.ok) { chartNote = can.why; return; }
        game.startFold(region);
        mode = "play";
    } else if (id.startsWith("facet:")) { if (game.spendFacet(id.slice(6) as FacetId)) save(); }
}

function afterStart(): void {
    particles.length = 0;
    hud.banner = { title: game.region.def.name.toUpperCase(), text: game.region.def.text, age: 0, color: FACTIONS[galaxyById(game.region.def.galaxy).government].color };
    hud.toasts = [];
    crownedAt = -1; crownedSeen = game.campaign.crowned;
    freeCam = null;
}

function load(): void {
    try {
        const text = addon.IO.store.read(SAVE_PATH);
        const d = text ? (JSON.parse(text) as { v?: number; campaign?: Campaign; sound?: boolean }) : null;
        if (d?.v === 1 && d.campaign && typeof d.campaign.mass === "number" && REGIONS.some(r => r.id === d.campaign!.region)) saved = d.campaign;
        if (d && typeof d.sound === "boolean") sound.enabled = d.sound;
    } catch { /* no save yet */ }
}

function save(): void {
    lastSave = realTime;
    saved = JSON.parse(JSON.stringify(game.campaign)) as Campaign;
    try { addon.IO.store.write(SAVE_PATH, JSON.stringify({ v: 1, campaign: saved, sound: sound.enabled })); } catch { /* no data folder */ }
}

// --- Effects ------------------------------------------------------------------------------------------

let fxSeed = 1;
const rnd = () => { fxSeed = (Math.imul(fxSeed, 1664525) + 1013904223) >>> 0; return fxSeed / 4294967296; };
const rndDir = (): V3 => { const z = rnd() * 2 - 1, a = rnd() * 6.283, r = Math.sqrt(1 - z * z); return [r * Math.cos(a), z, r * Math.sin(a)]; };

function burst(at: V3, n: number, speed: number, size: number, color: RGB, life: number, kind: number = GLOW_KIND.spark, toPlayer = false, grow = 0): void {
    for (let i = 0; i < n && particles.length < 600; i++) {
        particles.push({ pos: [...at], vel: mul(rndDir(), speed * (0.3 + rnd() * 0.9)), life: life * (0.6 + rnd() * 0.6), max: life * 1.2, size: size * (0.6 + rnd() * 0.8), color, kind, grow, toPlayer, seed: rnd() });
    }
}

function stepParticles(dt: number): void {
    const p = game.player;
    for (const q of particles) {
        q.life -= dt;
        if (q.toPlayer) {
            const to = sub(p.pos, q.pos), d = len(to);
            q.vel = add(mul(q.vel, Math.max(0, 1 - dt * 3)), mul(to, (p.radius * 22 * dt) / Math.max(d, p.radius * 0.2)));
            if (d < p.radius * 0.5) q.life = Math.min(q.life, 0.08);
        } else q.vel = mul(q.vel, Math.max(0, 1 - dt * 1.2));
        q.pos = add(q.pos, mul(q.vel, dt));
    }
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
    // Gas shed behind a moving nebula.
    if (p.alive && mode === "play") {
        const speed = len(p.vel) / p.radius;
        if (speed > 0.8 && rnd() < dt * Math.min(40, speed * 6)) {
            const pal = nebulaPalette(p.level);
            particles.push({ pos: add(p.pos, mul(rndDir(), p.radius * 0.7)), vel: mul(p.vel, 0.15), life: 1.8, max: 1.8, size: p.radius * (0.5 + rnd() * 0.5), color: rnd() < 0.5 ? pal.mid : pal.edge, kind: GLOW_KIND.gas, grow: 1.2, toPlayer: false, seed: rnd() });
        }
    }
}

function toast(text: string): void {
    hud.toasts.unshift({ text, age: 0 });
    if (hud.toasts.length > 4) hud.toasts.pop();
}

function handleEvents(events: GameEvent[]): void {
    const p = game.player, pal = nebulaPalette(p.level);
    for (const e of events) {
        switch (e.kind) {
            case "absorb": if (particles.length < 220) burst(e.at, e.body === "mote" ? 3 : 8, p.radius * 2, Math.max(e.radius, p.radius * 0.08) * 1.4, e.body === "mote" || e.body === "essence" ? [0.8, 1, 1] : [1, 0.85, 0.6], 0.8, GLOW_KIND.spark, true); sound.absorb(e.radius / p.radius); break;
            case "mined": burst(e.at, 40, p.radius * 6, p.radius * 0.3, pal.core, 1.6, GLOW_KIND.spark, true); burst(e.at, 1, 0, e.radius * 2.5, pal.mid, 1.2, GLOW_KIND.shock, false, 3); hud.flash = Math.max(hud.flash, 0.2); sound.mined(e.body === "star"); toast(`${e.name || KIND_LABEL[e.body]} is yours`); save(); break;
            case "lance": sound.lance(); break;
            case "shot": sound.shot(); break;
            case "impact": burst(e.at, 5, e.size * 5, e.size * 0.9, e.faction === "player" ? pal.core : FACTIONS[e.faction].color, 0.35); sound.impact(); break;
            case "hurt": hud.hurt = Math.min(1, hud.hurt + e.amount / 25); sound.hurt(); break;
            case "death": burst(e.at, 18, e.radius * 4, e.radius * 0.5, FACTIONS[e.faction].color, 1.1); burst(e.at, 1, 0, e.radius * 2, [1, 1, 1], 0.5, GLOW_KIND.halo, false, 2.5); sound.death(e.radius > p.radius * 2); break;
            case "swallowed": toast(`${e.hole} swallows one`); sound.death(false); break;
            case "pulse": sound.pulse(); break;
            case "flare": if (e.on) sound.flare(); break;
            case "starflare": burst(e.at, 1, 0, e.radius * 2.2, [1, 0.9, 0.6], 1.1, GLOW_KIND.shock, false, 3.5); hud.flash = Math.max(hud.flash, 0.2); break;
            case "decoy": sound.toggle(false); toast("You shed a knot of yourself"); break;
            case "veil": sound.toggle(e.on); break;
            case "attune": sound.toggle(e.on); break;
            case "levelup": hud.banner = { title: e.newRank ? `${e.rank.toUpperCase()}` : `LEVEL ${e.level}`, text: `${e.newRank ? `Level ${e.level}. The governments will call you ${e.rank} now. ` : ""}${e.unlocked ? `${e.unlocked} awakens. ` : ""}A facet point to spend - [TAB]`, age: 0, color: [1, 0.84, 0.45] }; sound.levelup(); burst(p.pos, 1, 0, p.radius * 4, pal.core, 1, GLOW_KIND.shock, false, 2); save(); break;
            case "goal": toast(`Done: ${e.text}`); sound.goal(); save(); break;
            case "regionComplete": hud.banner = { title: `${e.region.toUpperCase()} IS YOURS`, text: e.next ? `Your light reaches ${e.next} now. Fold there from the Star Chart - [M]` : "There is nowhere left your light has not reached.", age: 0, color: [0.55, 1, 0.72] }; sound.levelup(); save(); break;
            case "crowned": crownedAt = realTime; crownedSeen = false; save(); break;
            case "message": sound.message(e.message.kind, e.message.speaker.length); break;
            case "torn": hud.flash = 1; hud.hurt = 1; sound.torn(); hud.banner = { title: "TORN", text: `${e.hole} took a third of you. Never cross a horizon.`, age: 0, color: [1, 0.38, 0.38] }; break;
            case "sling": toast(`Slingshot: ${e.hole} flings you on`); sound.toggle(true); break;
            case "merge": hud.flash = 1; sound.torn(); sound.levelup(); hud.banner = { title: "THE HOLES MERGE", text: "Space rings like a bell. Everything hostile for a long way is undone.", age: 0, color: [0.8, 0.62, 1] }; break;
            case "banished": hud.flash = 1; sound.levelup(); hud.banner = { title: `${e.hole.toUpperCase()} IS GONE`, text: "Into the white, and out of this universe.", age: 0, color: [0.75, 0.95, 1] }; break;
            case "fold": sound.fold(); break;
            case "arrive": hud.flash = 1; particles.length = 0; hud.banner = { title: game.region.def.name.toUpperCase(), text: game.region.def.text, age: 0, color: FACTIONS[galaxyById(game.region.def.galaxy).government].color }; save(); break;
            case "dispersed": sound.torn(); break;
            case "reformed": toast("You gather yourself again"); break;
            case "tribute": toast(`${FACTIONS[e.faction].name}: ${standingTier(e.standing)}`); sound.goal(); break;
            case "crime": hud.banner = { title: "A LIVING WORLD", text: e.text, age: 0, color: [1, 0.38, 0.38] }; break;
            case "wave": toast(`Raid: wave ${e.n} of ${e.of}`); break;
            case "toast": toast(e.text); break;
        }
    }
}

// --- The frame ----------------------------------------------------------------------------------------

/** The camera in render units (1 = the player's radius, around the player). */
function cameraNow(): { pos: V3; target: V3; fov: number } {
    if (freeCam) return freeCam;
    const p = game.player;
    if (mode === "title") {
        const a = realTime * 0.07 + 0.6;
        return { pos: [Math.cos(a) * 6.5, 1.6 + Math.sin(realTime * 0.05) * 0.8, Math.sin(a) * 6.5], target: [0, 0.4, 0], fov: 50 };
    }
    const c = game.camera();
    return { pos: mul(sub(c.pos, p.pos), 1 / p.radius), target: mul(sub(c.target, p.pos), 1 / p.radius), fov: c.fov };
}

function frame(dt: number, show = true): void {
    realTime += dt;
    frames++;
    controller.expire(realTime);
    const input = readInput();
    const crownCard = crownedAt >= 0 && !crownedSeen;
    if (mode === "play" && !crownCard) {
        game.step(dt, input);
        handleEvents(game.events);
    } else if (mode === "title") {
        // The world drifts behind the title.
        game.step(dt, NO_INPUT);
    }
    stepParticles(dt);
    pressed.clear();
    padPressed.clear();
    if (mode === "play" && realTime - lastSave > 30 && game.player.alive && !game.fold) save();
    if (show) draw(dt);
}

function tension(): number {
    const p = game.player;
    let n = 0;
    for (const c of game.region.creatures) if (c.alive && c.state === "hunt" && c.target === -1 && dist(c.pos, p.pos) < p.radius * 80) n++;
    return clamp(n / 4 + (1 - p.cohesion / game.maxCohesion) * 0.4);
}

function draw(dt: number): void {
    if (!renderer.ready) return;
    const cam = cameraNow();
    const [w, h] = Entropy.Window.getSize();
    Entropy.Camera.setTransform(cam.pos, cam.target, [0, 1, 0]);
    Entropy.Camera.setFov(cam.fov);
    const p = game.player;
    hud.attune += ((p.attune ? 1 : 0) - hud.attune) * Math.min(1, dt * 5);
    hud.hurt = Math.max(0, hud.hurt - dt * 1.2);
    hud.flash = Math.max(0, hud.flash - dt * 1.6);
    hud.fade += ((p.alive ? 0 : 0.6) - hud.fade) * Math.min(1, dt * 2);

    renderer.begin();
    const scene = drawScene(renderer, game, realTime, hud.attune, particles, cam.pos);
    renderer.flush();
    lastScene = { solids: renderer.solids.lastStats.instances, glows: renderer.glows.lastStats.instances, lights: scene.lights.length, holes: scene.holes.length };

    const sky = galaxyById(game.region.def.galaxy).sky;
    const fold = game.fold ? Math.sin(Math.PI * clamp(game.fold.t / game.fold.duration)) : 0;
    const look: WorldLook = {
        time: realTime, warp: Math.max(fold, p.stride * 0.3), attune: hud.attune, flash: Math.max(hud.flash, fold > 0.97 ? 1 : 0), hurt: hud.hurt,
        camPos: cam.pos, camTarget: cam.target, fov: cam.fov, screen: [w, h],
        deep: sky.deep, a: sky.a, b: sky.b, clouds: sky.clouds, stars: sky.stars, seed: GALAXIES.findIndex(g => g.id === game.region.def.galaxy) * 1.37 + game.region.def.tier * 0.21,
        exposure: 1.15, saturation: 1.12 - hud.attune * 0.25, vignette: 0.42, fade: hud.fade,
        lights: scene.lights, holes: scene.holes,
    };
    renderer.writeWorld(look);

    hud.timer += dt;
    if (hud.timer >= 1 / 30 || fixedStep) { drawUi(hud.timer, w, h, cam); hud.timer = 0; }
    sound.step(realTime, game.region.def.galaxy, mode === "play" ? tension() : 0, p.stride);
    if (p.siphon) sound.siphon();
}

// --- Screens ------------------------------------------------------------------------------------------

function project(cam: { pos: V3; target: V3; fov: number }, w: number, h: number, at: V3): { x: number; y: number; z: number } {
    const f = norm(sub(cam.target, cam.pos));
    const r = norm(cross(f, [0, 1, 0]), [1, 0, 0]), u = cross(r, f);
    const d = sub(at, cam.pos), z = dot(d, f), t = Math.tan((cam.fov * Math.PI) / 360);
    const zz = Math.max(Math.abs(z), 1e-6);
    return { x: (dot(d, r) / (zz * t * (w / h)) * 0.5 + 0.5) * w, y: (0.5 - (dot(d, u) / (zz * t)) * 0.5) * h, z };
}

function hudView(w: number, h: number, cam: { pos: V3; target: V3; fov: number }): HudView {
    const g = game, p = g.player, def = g.region.def, gal = galaxyById(def.galaxy), gov = FACTIONS[gal.government];
    const units = (v: V3): V3 => mul(sub(v, p.pos), 1 / p.radius);
    const pal = nebulaPalette(p.level);

    let focus: HudFocus | null = null;
    const fo = g.focus();
    if (fo) {
        const s = project(cam, w, h, units(fo.pos));
        const size = ((fo.radius / p.radius) / Math.max(s.z, 0.01)) / Math.tan((cam.fov * Math.PI) / 360) * (h / 2);
        const ratio = fo.radius / p.radius;
        const sizeText = `${formatKm(fo.radius)} radius  -  ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} x your size`;
        let line = sizeText, note = "", color: RGB = [0.8, 0.9, 1], health: number | null = null, name = fo.name;
        if (fo.type === "body") {
            const b = g.region.bodies.find(x => x.id === fo.id)!;
            const label = (b.kind === "star" || b.kind === "planet" ? LOOK_LABEL[b.look] : undefined) ?? KIND_LABEL[b.kind];
            line = `${label}  -  ${sizeText}`;
            const reach = g.siphonReach;
            if (b.inhabited) { note = `Carries life: under ${gov.id === "wild" ? FACTIONS.concord.name : gov.name}'s law`; color = [1, 0.74, 0.35]; }
            else if (b.radius < p.radius * 0.5) { note = "Small enough to swallow: fly into it"; color = [0.55, 1, 0.72]; }
            else if (fo.distance < reach) { note = g.player.siphon === b.id ? "Siphoning..." : "[E] hold to siphon"; color = [0.55, 1, 0.72]; }
            else note = `Siphon from ${formatKm(fo.distance - reach)} closer`;
            if (b.radius < b.radius0 * 0.999) health = (b.radius / b.radius0) ** 3;
        } else if (fo.type === "creature") {
            const c = g.region.creatures.find(x => x.id === fo.id)!;
            const hostile = g.hostile(c);
            color = hostile ? [1, 0.38, 0.38] : FACTIONS[c.faction].color;
            name = c.name;
            line = `${c.species.name === c.name ? "" : `${c.species.name}  -  `}${c.faction === "wild" ? "Ungoverned" : FACTIONS[c.faction].name}  -  ${hostile ? "Hostile" : c.faction === "wild" ? "Wary" : standingTier(g.standing(c.faction))}`;
            health = c.hp / c.maxHp;
            if (c.species.id === "envoy") note = fo.distance < p.radius * 9 ? "[G] offer tribute (a twentieth of your mass)" : "An envoy: come closer to offer tribute";
            else note = `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} x your size`;
        } else {
            color = [0.8, 0.62, 1];
            line = `Black hole  -  horizon ${formatKm(fo.radius)}`;
            note = "It cannot be eaten. Graze it for a slingshot; never cross the horizon.";
        }
        if (s.z > 0) focus = { x: s.x, y: s.y, size, name, line, note, color, health };
    }

    // Where the unfinished goals are.
    const markers: HudMarker[] = [];
    const mark = (at: V3, label: string, color: RGB) => {
        if (markers.length >= 7) return;
        const s = project(cam, w, h, units(at));
        const on = s.z > 0 && s.x > 20 && s.x < w - 20 && s.y > 20 && s.y < h - 20;
        let x = s.x, y = s.y;
        if (!on) {
            let dx = (s.x - w / 2) * (s.z > 0 ? 1 : -1), dy = (s.y - h / 2) * (s.z > 0 ? 1 : -1);
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) dy = 1;
            const k = Math.min((w / 2 - 30) / Math.max(1e-6, Math.abs(dx)), (h / 2 - 30) / Math.max(1e-6, Math.abs(dy)));
            x = w / 2 + dx * k; y = h / 2 + dy * k;
        }
        if (focus && on && Math.hypot(x - focus.x, y - focus.y) < 30) return;
        markers.push({ x, y, label, sub: formatKm(dist(at, p.pos)), color, onscreen: on });
    };
    const goalColor: RGB = [1, 0.84, 0.45];
    for (const gs of g.goals) {
        if (gs.done || gs.locked && gs.def.type !== "lure") continue;
        const d = gs.def;
        if (d.type === "mine" && d.keys) for (const k of d.keys) { const b = g.region.bodies.find(x => x.key === k); if (b) mark(b.pos, b.name.toUpperCase(), goalColor); }
        if (d.type === "defeat") { const c = g.region.creatures.find(x => x.key === d.key); if (c) mark(c.pos, c.name.toUpperCase(), [1, 0.38, 0.38]); }
        if (d.type === "clear") {
            let near = null as null | (typeof g.region.creatures)[number];
            for (const c of g.region.creatures) if (c.alive && c.group === d.group && (!near || dist(c.pos, p.pos) < dist(near.pos, p.pos))) near = c;
            if (near) mark(near.pos, near.name.toUpperCase(), [1, 0.38, 0.38]);
        }
        if (d.type === "feed" || d.type === "sling" || d.type === "lure") { const hole = g.region.holes.find(x => x.key === d.hole); if (hole) mark(hole.pos, hole.name.toUpperCase(), [0.8, 0.62, 1]); }
        if (d.type === "lure") {
            if (d.to === "rift" && g.region.rift) mark(g.region.rift.pos, g.region.rift.open ? "THE RIFT" : "THE RIFT (CLOSED)", [0.75, 0.95, 1]);
            else { const other = g.region.holes.find(x => x.key === d.to); if (other) mark(other.pos, other.name.toUpperCase(), [0.8, 0.62, 1]); }
        }
        if (d.type === "tribute" || d.type === "standing") for (const c of g.region.creatures) if (c.species.id === "envoy") mark(c.pos, c.name.toUpperCase(), FACTIONS[c.faction].color);
        if (d.type === "defend") { const c = g.region.creatures.find(x => x.wave >= 0) ?? g.region.creatures.find(x => x.group === d.group); if (c) mark(c.pos, c.wave >= 0 ? "RAIDERS" : "THE SHOAL", c.wave >= 0 ? [1, 0.38, 0.38] : FACTIONS.concord.color); }
    }

    let warning = "";
    for (const hole of g.region.holes) if (dist(hole.pos, p.pos) < hole.radius * 2.2) warning = dist(hole.pos, p.pos) < hole.radius * 1.6 ? `${hole.name.toUpperCase()}: TIDES ARE TEARING YOU - PULL AWAY` : `${hole.name.toUpperCase()}: INSIDE THE ERGOSPHERE`;
    const st = g.region.bodies.find(b => b.id === p.siphon);
    if (st && st.kind === "star" && st.flareIn < 1.3) warning = "FLARE - LIGHTSTRIDE THROUGH IT  [SHIFT]";

    return {
        w, h, time: realTime,
        region: def.name, galaxy: gal.name, government: gov.name, governmentColor: gov.color,
        standing: gov.id === "wild" ? "no law here" : standingTier(g.standing(gov.id)), complete: g.regionComplete,
        goals: g.goals.map(x => ({ text: x.def.text, done: x.done, progress: x.progress, total: x.total, optional: !!x.def.optional, locked: x.locked })),
        messages: g.messages.slice(-5).map(m => ({ speaker: m.speaker || "A voice", text: m.text, color: m.faction === "player" ? pal.mid : FACTIONS[m.faction].color, age: g.time - m.t, kind: m.kind })).filter(m => m.age < 16),
        attune: p.attune, veil: p.veil,
        rank: rankOf(p.level), level: p.level, maxLevel: MAX_LEVEL, progress: levelProgress(p.radius), radius: formatKm(p.radius), compare: compare(p.radius),
        cohesion: p.cohesion / g.maxCohesion, charge: p.charge / g.maxCharge, fed: p.fed > 0, points: g.campaign.points,
        abilities: ABILITY_IDS.map(id => {
            const a = ABILITIES[id];
            return { name: a.name, key: a.key, ready: a.cooldown > 0 ? 1 - clamp(p.cd[id] / a.cooldown) : 1, locked: g.has(id) ? 0 : a.level, active: (id === "veil" && p.veil) || (id === "attune" && p.attune) || (id === "surge" && p.stride > 0) || (id === "flare" && p.flare > 0), affordable: p.charge >= a.cost };
        }),
        focus, markers,
        stride: p.stride, speed: `${formatKm(len(p.vel))} / s`,
        warning,
        banner: hud.banner, toasts: hud.toasts,
        hints: "[M] Star Chart   [TAB] Codex   [E] siphon   [G] tribute   [ESC] title",
    };
}

function chartView(w: number, h: number): ChartView {
    const g = game;
    return {
        w, h, selected: chartSelected, note: chartNote,
        galaxies: GALAXIES.map(gal => ({
            name: gal.name, government: FACTIONS[gal.government].name, color: FACTIONS[gal.government].color, text: gal.text,
            regions: REGIONS.filter(r => r.galaxy === gal.id).map(r => ({
                id: r.id, name: r.name, text: r.text,
                state: r.id === g.region.def.id ? "here" as const : !g.unlocked(r.id) ? "sealed" as const : g.campaign.completed.includes(r.id) ? "done" as const : "open" as const,
                size: `Built for a cloud of ${formatKm(tierRadius(r.tier))}`,
                why: "Sealed: finish the region before it and your light will reach here",
            })),
        })),
    };
}

function codexView(w: number, h: number): CodexView {
    const g = game, p = g.player, c = g.campaign, s = c.stats;
    return {
        w, h, points: c.points, rank: rankOf(p.level), level: p.level, radius: formatKm(p.radius), compare: compare(p.radius),
        facets: FACET_IDS.map(id => ({ id, name: FACETS[id].name, text: FACETS[id].text, rank: c.facets[id], max: FACET_MAX })),
        abilities: ABILITY_IDS.map(id => ({ name: ABILITIES[id].name, key: ABILITIES[id].key, text: ABILITIES[id].text, level: ABILITIES[id].level, unlocked: g.has(id) })),
        factions: GOVERNMENTS.map(id => ({ name: FACTIONS[id].name, form: FACTIONS[id].form, creed: FACTIONS[id].creed, color: FACTIONS[id].color, standing: c.standing[id], tier: standingTier(c.standing[id]), laws: FACTIONS[id].laws, fluency: g.fluency(id) })),
        stats: [`Absorbed: ${s.absorbed}`, `Worlds and stars mined: ${s.mined}`, `Stars consumed: ${s.stars}`, `Creatures undone: ${s.kills}`, `Folds: ${s.folds}`, `Times dispersed: ${s.dispersed}`, `Regions held: ${c.completed.length} of ${REGIONS.length}`, `Time: ${Math.floor(s.time / 60)} min`],
    };
}

function drawUi(dt: number, w: number, h: number, cam: { pos: V3; target: V3; fov: number }): void {
    if (!painter) return;
    const p = painter;
    p.begin();
    for (const t of hud.toasts) t.age += dt;
    hud.toasts = hud.toasts.filter(t => t.age < 4.5);
    if (hud.banner) { hud.banner.age += dt; if (hud.banner.age > 6.5) hud.banner = null; }
    if (mode === "title") {
        const c = saved;
        drawTitle(p, { w, h, time: realTime, canContinue: !!c, summary: c ? `${rankOf(Math.max(1, Math.round(1 + Math.log(Math.cbrt(c.mass)) / Math.log(Math.cbrt(3.3)))))}  -  ${REGIONS.find(r => r.id === c.region)?.name ?? ""}  -  ${c.completed.length} of ${REGIONS.length} regions held` : "", sound: sound.enabled });
    } else if (crownedAt >= 0 && !crownedSeen) {
        const s = game.campaign.stats;
        drawCrowned(p, w, h, realTime - crownedAt, [`Radius ${formatKm(game.player.radius)}  -  ${compare(game.player.radius)}`, `${s.stars} stars consumed  -  ${s.mined} worlds and stars mined  -  ${s.folds} folds  -  ${Math.floor(s.time / 60)} minutes`]);
    } else {
        if (game.fold) drawFold(p, w, h, REGIONS.find(r => r.id === game.fold!.to)!.name, galaxyById(REGIONS.find(r => r.id === game.fold!.to)!.galaxy).name, game.fold.t / game.fold.duration);
        else if (mode === "chart") drawChart(p, chartView(w, h));
        else if (mode === "codex") drawCodex(p, codexView(w, h));
        else {
            drawHud(p, hudView(w, h, cam));
            if (!game.player.alive) drawDispersed(p, w, h, game.player.deadFor);
        }
    }
    p.flush();
}

// --- Lifecycle ----------------------------------------------------------------------------------------

addon.onInit(() => {
    renderer.init();
    Entropy.setGameMode(false);
    Entropy.Lighting.updateSun({ horizonColor: [0, 0, 0], zenithColor: [0, 0, 0], sunDirection: [0.3, 0.8, 0.5], sunColor: [1, 1, 1], sunIntensity: 0 });
    painter = enginePainter(addon.UI as unknown as DrawApi);
    load();
    if (saved) game = new Game(JSON.parse(JSON.stringify(saved)) as Campaign);
    setupInput();
    registerTools();
    Entropy.println("[nebula-kingdom] initialized");
});

addon.onUpdatePlus("Global", () => {
    if (!renderer.ready) return;
    const now = Date.now();
    const real = lastMs ? Math.min(0.1, Math.max(0, (now - lastMs) / 1000)) : 1 / 60;
    lastMs = now;
    frame(fixedStep ?? real);
});

// --- MCP tools (and the live test) --------------------------------------------------------------------

type Args = Record<string, unknown>;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: V3): V3 => (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number") ? [v[0], v[1], v[2]] : d);

function snapshot() {
    return { mode, frames, realTime: Math.round(realTime * 100) / 100, camera: cameraNow(), scene: lastScene, particles: particles.length, sound: sound.played, ui: painter?.opCount() ?? 0, game: game.summary() };
}

/** Steps the game n frames at a fixed step. Only the last is drawn: a tool call is one engine frame. */
let undrawn = 0;
function advance(n: number, input: Partial<NkInput> = {}, last = true): void {
    for (let i = 0; i < n; i++) {
        scripted = { ...input, frames: 1 };
        const show = last && i === n - 1;
        frame(fixedStep ?? 1 / 30, show);
        undrawn = show ? 0 : undrawn + 1;
    }
}

/** Where a tool's `to` points: a keyed body, creature or hole, "rift", or [x, y, z] in region units. */
function locate(to: unknown): { pos: V3; radius: number } | null {
    const r = game.region;
    if (Array.isArray(to)) return { pos: mul(vec(to, [0, 0, 0]), r.scale), radius: 0 };
    const k = String(to);
    const b = r.bodies.find(x => x.key === k);
    if (b) return b;
    const c = r.creatures.find(x => x.key === k) ?? r.creatures.find(x => x.alive && (x.group === k || x.species.id === k));
    if (c) return c;
    const hole = r.holes.find(x => x.key === k);
    if (hole) return hole;
    if (k === "rift" && r.rift) return r.rift;
    // A kind of body ("mote", "asteroid", "star"...): the nearest one.
    let near: (typeof r.bodies)[number] | null = null;
    for (const x of r.bodies) if (x.alive && x.kind === k && (!near || dist(x.pos, game.player.pos) < dist(near.pos, game.player.pos))) near = x;
    return near;
}

function faceTo(at: V3): void {
    const p = game.player, d = sub(at, p.pos), l = len(d) || 1;
    p.yaw = Math.atan2(d[0], d[2]);
    p.pitch = Math.asin(clamp(d[1] / l, -1, 1));
}

function registerTools(): void {
    const tools: { name: string; description: string; parameters: object; run: (a: Args) => object }[] = [
        { name: "nebula_state", description: "The game's state: mode, camera, what the scene drew, and the game (region, the nebula's size, level and rank, goals, standings, counts).", parameters: { type: "object", properties: {} }, run: () => snapshot() },
        {
            name: "nebula_config", description: "Test settings: fixedStep (seconds per frame, null for real time), sound (bool).",
            parameters: { type: "object", properties: { fixedStep: { type: "number" }, sound: { type: "boolean" } } },
            run: a => {
                if ("fixedStep" in a) fixedStep = a.fixedStep === null ? null : num(a.fixedStep, 1 / 30);
                if ("sound" in a) sound.enabled = !!a.sound;
                return snapshot();
            },
        },
        {
            name: "nebula_start", description: "Starts a new nebula in a region (cradle, hearthring, tollgate, bazaar, marches, cinders, choir, drowned, wake, parliament, shallows, throne) as if every region before it were done, at the level given (default: the region's own). {title: true} shows the title screen instead.",
            parameters: { type: "object", properties: { region: { type: "string" }, level: { type: "number" }, title: { type: "boolean" } } },
            run: a => {
                if (a.title) { mode = "title"; return snapshot(); }
                const id = String(a.region ?? "cradle");
                const i = REGIONS.findIndex(r => r.id === id);
                if (i < 0) throw new Error(`No region ${id}`);
                const c = newCampaign();
                c.completed = REGIONS.slice(0, i).map(r => r.id);
                c.region = id;
                const level = Math.max(1, Math.min(MAX_LEVEL, Math.round(num(a.level, 1 + REGIONS[i].tier * 3))));
                c.mass = massOfRadius(radiusOfLevel(level)) * 1.02;
                c.points = level - 1;
                c.stats.stars = Math.max(0, i - 1);
                game = new Game(c);
                mode = "play";
                afterStart();
                return snapshot();
            },
        },
        {
            name: "nebula_camera", description: "A free camera at position looking at target, in the nebula's own units around it (1 = its radius), fov degrees; {release: true} gives the camera back to the game.",
            parameters: { type: "object", properties: { position: { type: "array" }, target: { type: "array" }, fov: { type: "number" }, release: { type: "boolean" } } },
            run: a => {
                if (a.release) freeCam = null;
                else freeCam = { pos: vec(a.position, cameraNow().pos), target: vec(a.target, cameraNow().target), fov: num(a.fov, 55) };
                draw(0);
                return snapshot();
            },
        },
        {
            name: "nebula_act", description: "Plays the nebula. action: wait (frames); fly (to: a key such as a body's, a group, a species, 'rift', or [x,y,z] in region units; frames; surge; fire; siphon: flies at it); face (to); teleport (to, distance in the target's radii); fire / siphon / surge (frames); pulse, veil, attune, decoy, flare, tribute; fold (region); facet (id); screen (chart, codex, play, title); banner (clears the banner and toasts).",
            parameters: { type: "object", properties: { action: { type: "string" }, frames: { type: "number" } } },
            run: a => {
                const g = game, p = g.player;
                const n = Math.max(1, Math.round(num(a.frames, 1)));
                switch (String(a.action)) {
                    case "wait": advance(n); break;
                    case "face": { const t = locate(a.to); if (!t) throw new Error(`Nothing called ${String(a.to)}`); faceTo(t.pos); advance(1); break; }
                    case "teleport": {
                        const t = locate(a.to);
                        if (!t) throw new Error(`Nothing called ${String(a.to)}`);
                        const away = norm(sub(p.pos, t.pos), [0, 0, -1]);
                        p.pos = add(t.pos, mul(away, t.radius + p.radius * num(a.distance, 6)));
                        p.vel = [0, 0, 0];
                        faceTo(t.pos);
                        advance(1);
                        break;
                    }
                    case "fly": {
                        for (let i = 0; i < n; i++) {
                            const t = locate(a.to);
                            if (!t) break;
                            faceTo(t.pos);
                            const d = dist(t.pos, p.pos) - t.radius;
                            advance(1, { thrust: a.hold ? 0 : Math.min(1, d / (p.radius * 3)), surge: !!a.surge && d > p.radius * 20, fire: !!a.fire, siphon: !!a.siphon, pulse: !!a.pulse && d < p.radius * 8 && p.cd.pulse <= 0 }, i === n - 1);
                        }
                        if (undrawn) draw(0);
                        break;
                    }
                    case "fire": advance(n, { fire: true }); break;
                    case "siphon": advance(n, { siphon: true }); break;
                    case "surge": advance(n, { surge: true, thrust: 1 }); break;
                    case "pulse": advance(1, { pulse: true }); break;
                    case "veil": advance(1, { veil: true }); break;
                    case "attune": advance(1, { attune: true }); break;
                    case "decoy": advance(1, { decoy: true }); break;
                    case "flare": advance(1, { flare: true }); break;
                    case "tribute": advance(1, { tribute: true }); break;
                    case "fold": if (!g.startFold(String(a.region))) throw new Error(g.canFold(String(a.region)).why); mode = "play"; advance(n); break;
                    case "facet": if (!g.spendFacet(String(a.id) as FacetId)) throw new Error("No point to spend there"); break;
                    case "screen": mode = (["chart", "codex", "play", "title"].includes(String(a.screen)) ? String(a.screen) : "play") as Mode; if (mode === "chart") chartSelected = String(a.select ?? g.region.def.id); advance(1); break;
                    case "banner": hud.banner = null; hud.toasts = []; advance(1); break;
                    default: throw new Error(`Unknown action ${String(a.action)}`);
                }
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
