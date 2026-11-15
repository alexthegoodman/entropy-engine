// WORLD OF MUSIC
//
// Agent Tom, from the World of Color, lands on a tropical planet whose people see no color -
// they see music - with three swarms of Tones. Point and click directs a swarm, and the next
// swarm is selected at once. Feed them fruit and they split; sell relics for traits; purify the
// Red Corruption, whose creatures think with Yumon Pet's WIR tactical networks.
// Docs: docs/WORLD_OF_MUSIC.md.
//
// This file wires the modules to the engine:
// - wom_data / wom_terrain / wom_wir / wom_game: rules, islands, enemy minds, the simulation;
// - wom_shader / wom_render / wom_scene: the cel-shaded, hazy, black-and-white-and-color look;
// - wom_hud / wom_audio: every screen, and the sound.
// It reads input, steps the game, draws it, saves the campaign, and registers the MCP tools the
// live test (tests/world_of_music_live.rs) drives.

import { Game, NO_INPUT, newCampaign, normalizeCampaign, RELIC_VALUE, type Campaign, type GameEvent, type WomInput } from "./wom_game";
import { LEVELS, SPECIES, NPCS, BOSSES, TRAIT_IDS, INTRO, ENDING, JAM_PHRASES, PIPE_NOTES, traitPrice, traitRank, type RGB, type Device, type TraitId, type SpeciesId } from "./wom_data";
import { Renderer, waterMesh, type WorldLook } from "./wom_render";
import { drawScene, type Particle } from "./wom_scene";
import { GLOW } from "./wom_shader";
import { drawHud, drawStall, drawTitle, drawStory, LESSONS, type HudView, type StallView } from "./wom_hud";
import { Sound } from "./wom_audio";
import { enginePainter, type Painter, type DrawApi } from "../allegiance/al_ui";
import { Controller } from "../allegiance/al_controller";
import { clamp, norm, sub, cross, dot, type V3 } from "../nebula/nk_math";

const addon = Entropy.AddonAtom.register({
    name: "World of Music",
    version: "0.1.0",
    description: "Agent Tom and his swarms of Tones purify the Red Corruption from a tropical planet whose people see music, not color.",
    author: ["Entropy Team", "Claude"],
    capabilities: { graphics: true, ui: true },
});

const SAVE_PATH = "campaign.json";
const renderer = new Renderer();
const sound = new Sound();
const controller = new Controller();
let painter: Painter | null = null;

type Mode = "title" | "intro" | "play" | "stall" | "complete" | "ending";
let mode: Mode = "title";
let game = new Game();
let saved: Campaign | null = null;
let realTime = 0, storyAge = 0;
let fixedStep: number | null = null;
let lastMs = 0, frames = 0, lastSave = 0;
let freeCam: { pos: V3; target: V3; fov: number } | null = null;
let device: Device = "keys";
let terrainKey = "", waterKey = "", meshLevel = "";
let postOn = true;
const particles: Particle[] = [];

const hud = {
    link: null as { text: string; age: number } | null,
    links: [] as string[],
    say: null as { name: string; text: string; age: number } | null,
    lesson: null as { id: string; age: number } | null,
    lessons: [] as string[],
    toasts: [] as { text: string; age: number }[],
    banner: null as { title: string; text: string; age: number; color: RGB } | null,
    flash: 0, hurt: 0, timer: 0,
    cardFlash: [] as number[],
};
const stall = { selected: 0, cursor: "sell", note: "" };

// --- input ----------------------------------------------------------------------------------

const held = new Set<string>();
const pressed = new Set<string>();
const padPressed = new Set<string>();
let mouse: [number, number] = [0, 0];
let clicked = false, rightClicked = false, wheel = 0;
let padCursor: [number, number] | null = null;
let scripted: (Partial<WomInput> & { frames: number }) | null = null;
let pipeMode = false;
let rtWas = false;
const key = (k: string) => held.has(k) || held.has(k.toLowerCase()) || held.has(k.toUpperCase());
const tapped = (k: string) => pressed.has(k) || pressed.has(k.toLowerCase()) || pressed.has(k.toUpperCase());

/** The ground under a screen point, from the game camera (no engine round trip). */
function groundAt(sx: number, sy: number): V3 | null {
    const cam = cameraNow();
    const [w, h] = Entropy.Window.getSize();
    const f = norm(sub(cam.target, cam.pos)), r = norm(cross(f, [0, 1, 0]), [1, 0, 0]), u = cross(r, f);
    const t = Math.tan((cam.fov * Math.PI) / 360), nx = (sx / w) * 2 - 1, ny = 1 - (sy / h) * 2;
    const d = norm([f[0] + r[0] * nx * t * (w / h) + u[0] * ny * t, f[1] + r[1] * nx * t * (w / h) + u[1] * ny * t, f[2] + r[2] * nx * t * (w / h) + u[2] * ny * t]);
    return game.terrain.ray(cam.pos[0], cam.pos[1], cam.pos[2], d[0], d[1], d[2], 260);
}

function readInput(): WomInput {
    const L = controller.left, R = controller.right;
    const kx = (key("d") ? 1 : 0) - (key("a") ? 1 : 0) + L[0], kz = (key("w") ? 1 : 0) - (key("s") ? 1 : 0) + L[1];
    const yaw = game.camYaw, fx = Math.sin(yaw), fz = Math.cos(yaw);
    let mx = fx * kz - fz * kx, mz = fz * kz + fx * kx;
    const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
    const aimPad = device === "pad";
    let cursor: V3 | null = null;
    if (mode === "play") {
        if (aimPad) {
            // The pad aims a reticle around Tom with the right stick (held LT), else ahead of him.
            if (!padCursor) padCursor = [game.tom.pos[0] + fx * 8, game.tom.pos[2] + fz * 8];
            if (controller.held.has("LeftTrigger2") || controller.triggers[0] > 0.3) { padCursor = [padCursor[0] + (fx * R[1] - fz * R[0]) * 0.5, padCursor[1] + (fz * R[1] + fx * R[0]) * 0.5]; }
            else padCursor = [padCursor[0] + (game.tom.pos[0] + fx * 8 - padCursor[0]) * 0.08, padCursor[1] + (game.tom.pos[2] + fz * 8 - padCursor[1]) * 0.08];
            cursor = [padCursor[0], game.terrain.surface(padCursor[0], padCursor[1]), padCursor[1]];
        } else cursor = groundAt(mouse[0], mouse[1]);
    }
    const turnPad = aimPad && !(controller.held.has("LeftTrigger2") || controller.triggers[0] > 0.3) ? -R[0] * 0.05 : 0;
    const noteKey = pipeMode || game.jam ? PIPE_NOTES.findIndex(n => tapped(n.key) || (device === "pad" && padPressed.has(n.pad))) : -1;
    const sel = !pipeMode && !game.jam ? ["1", "2", "3", "4", "5", "6", "7", "8"].findIndex(k => tapped(k)) : -1;
    const input: WomInput = {
        moveX: mode === "play" ? mx : 0, moveZ: mode === "play" ? mz : 0,
        jump: mode === "play" && (tapped(" ") || padPressed.has("South") && !pipeMode && !game.jam),
        turn: (key("q") ? 1.8 : 0) * (1 / 60) - (key("e") ? 1.8 : 0) * (1 / 60) + turnPad,
        zoom: wheel,
        cursor,
        direct: mode === "play" && (clicked || padPressed.has("RightTrigger2") || (controller.triggers[1] > 0.5 && !rtWas)),
        recall: mode === "play" && (rightClicked || padPressed.has("LeftTrigger")),
        gather: mode === "play" && !pipeMode && (tapped("g") || padPressed.has("North") && !game.jam),
        select: sel >= 0 ? sel : null,
        selectNext: mode === "play" && (tapped("Tab") || padPressed.has("DPadRight")),
        selectPrev: mode === "play" && padPressed.has("DPadLeft"),
        divide: mode === "play" && (tapped("v") || padPressed.has("DPadDown")),
        talk: mode === "play" && (tapped("r") || padPressed.has("East") && !pipeMode && !game.jam),
        note: noteKey,
    };
    rtWas = controller.triggers[1] > 0.5;
    clicked = false; rightClicked = false; wheel = 0;
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
        device = "keys";
        if (repeat) return;
        pressed.add(k);
        const lower = k.toLowerCase();
        if (mode === "title") { if (k === "Enter") act(saved ? "continue" : "new"); return; }
        if (mode === "intro" || mode === "complete" || mode === "ending") { if (k === "Enter" || k === " " || k === "Escape") act("next"); return; }
        if (mode === "stall") {
            if (k === "Escape" || lower === "b") act("close");
            else if (k === "Tab") { stall.selected = (stall.selected + 1) % game.swarms.length; sound.ui(); }
            else if (k.startsWith("Arrow")) moveStallCursor(k === "ArrowRight" || k === "ArrowDown" ? 1 : -1);
            else if (k === "Enter") act(stall.cursor);
            return;
        }
        if (lower === "h") { nextLesson(); return; }
        if (lower === "f") { togglePipe(); return; }
        if (lower === "b" && game.npcNear(5) && NPCS[game.npcNear(5)!.id].role === "shop") { setMode("stall"); return; }
        if (lower === "p") { postOn = !postOn; renderer.setScreen(postOn); return; }
        if (k === "Escape") { if (pipeMode || game.jam) { pipeMode = false; game.endJam(); } else { save(); setMode("title"); } }
    });
    Entropy.Input.onKeyUp((k: string) => { held.delete(k); held.delete(k.toLowerCase()); held.delete(k.toUpperCase()); });
    Entropy.Input.onMouseDown((button: number, x: number, y: number) => {
        device = "keys";
        mouse = [x, y];
        const hit = painter?.hit(x, y);
        if (hit) { act(hit.id); return; }
        if (mode === "play") { if (button === 0) clicked = true; else if (button === 2 || button === 1) rightClicked = true; }
    });
    Entropy.Input.onMouseMove((x: number, y: number) => { mouse = [x, y]; if (painter) painter.hover = painter.hit(x, y)?.id ?? null; });
    Entropy.Input.onMouseWheel((_dx: number, dy: number) => { if (dy) wheel += dy > 0 ? 1 : -1; });
    Entropy.Input.onGamepadAxis((l, r, t) => {
        controller.axis(l, r, realTime, t);
        if (Math.max(Math.hypot(...controller.left), Math.hypot(...controller.right), ...controller.triggers) > 0.3) device = "pad";
    });
    Entropy.Input.onGamepadButton((b, down) => {
        const fresh = controller.button(b, down);
        if (!fresh) return;
        device = "pad";
        padPressed.add(b);
        if (mode === "title") { if (b === "South" || b === "Start") act(saved ? "continue" : "new"); return; }
        if (mode === "intro" || mode === "complete" || mode === "ending") { if (b === "South" || b === "Start") act("next"); return; }
        if (mode === "stall") {
            if (b === "East" || b === "Select") act("close");
            else if (b === "RightTrigger" || b === "LeftTrigger") stall.selected = (stall.selected + (b === "RightTrigger" ? 1 : game.swarms.length - 1)) % game.swarms.length;
            else if (b.startsWith("DPad")) moveStallCursor(b === "DPadRight" || b === "DPadDown" ? 1 : -1);
            else if (b === "South") act(stall.cursor);
            return;
        }
        if (b === "West") togglePipe();
        if (b === "Select") { const n = game.npcNear(5); if (n && NPCS[n.id].role === "shop") setMode("stall"); else nextLesson(); }
        if (b === "Start") { save(); setMode("title"); }
    });
}

function togglePipe(): void {
    if (game.jam) { game.endJam(); pipeMode = false; return; }
    if (game.startJam()) { pipeMode = true; return; }
    pipeMode = !pipeMode;
}

function stallItems(): string[] { return ["sell", ...TRAIT_IDS.map(t => `buy:${t}`), ...game.campaign.unlocked.map(s => `hatch:${s}`), "close"]; }
function moveStallCursor(step: number): void {
    const items = stallItems(), i = Math.max(0, items.indexOf(stall.cursor));
    stall.cursor = items[(i + step + items.length) % items.length];
    sound.ui();
}

function nextLesson(): void {
    hud.lesson = null;
    const next = hud.lessons.shift();
    if (next) hud.lesson = { id: next, age: 0 };
}

function setMode(m: Mode): void {
    if (mode === m) return;
    mode = m;
    storyAge = 0;
    sound.ui();
    if (m === "stall") { stall.note = ""; stall.selected = Math.min(stall.selected, game.swarms.length - 1); }
}

function act(id: string): void {
    sound.ui();
    if (id === "continue" && saved) { game = new Game(saved); afterStart(); setMode("play"); }
    else if (id === "new") { game = new Game(newCampaign()); afterStart(); setMode("intro"); save(); }
    else if (id === "next") {
        if (mode === "intro") setMode("play");
        else if (mode === "complete") { if (game.advance()) { afterStart(); save(); setMode("play"); } else setMode("ending"); }
        else if (mode === "ending") { save(); setMode("title"); }
    } else if (id === "close") setMode("play");
    else if (id === "sell") { const got = game.sell(); stall.note = got ? `Bodhi pays ${got} chimes` : ""; if (got) sound.relic(); save(); }
    else if (id.startsWith("buy:")) { const r = game.buy(stall.selected, id.slice(4) as TraitId); stall.note = r.why; if (r.ok) { sound.song(); save(); } }
    else if (id.startsWith("hatch:")) { const r = game.hatch(id.slice(6) as SpeciesId); stall.note = r.why; if (r.ok) { sound.split(id.slice(6) as SpeciesId); save(); } }
    else if (id.startsWith("stall-swarm:")) stall.selected = Number(id.slice(12));
    else if (id.startsWith("swarm:")) { game.selected = Number(id.slice(6)); sound.select(game.swarms[game.selected].species); }
}

function afterStart(): void {
    particles.length = 0;
    hud.link = null; hud.links = []; hud.say = null; hud.lesson = null; hud.lessons = []; hud.toasts = [];
    hud.banner = { title: game.level.name.toUpperCase(), text: game.level.text, age: 0, color: [1, 1, 1] };
    freeCam = null; padCursor = null; pipeMode = false;
    handleEvents(game.events); game.events = [];
}

function load(): void {
    try {
        const text = addon.IO.store.read(SAVE_PATH);
        const d = text ? (JSON.parse(text) as { v?: number; campaign?: Campaign; sound?: boolean }) : null;
        if (d?.v === 1 && d.campaign) saved = normalizeCampaign(d.campaign);
        if (d && typeof d.sound === "boolean") sound.enabled = d.sound;
    } catch { /* no save yet */ }
}

function save(): void {
    lastSave = realTime;
    saved = JSON.parse(JSON.stringify(game.syncCampaign())) as Campaign;
    try { addon.IO.store.write(SAVE_PATH, JSON.stringify({ v: 1, campaign: saved, sound: sound.enabled })); } catch { /* no data folder */ }
}

// --- effects --------------------------------------------------------------------------------

let fxSeed = 7;
const rnd = () => { fxSeed = (Math.imul(fxSeed, 1664525) + 1013904223) >>> 0; return fxSeed / 4294967296; };
function burst(at: V3, n: number, speed: number, size: number, color: RGB, life: number, kind: number = GLOW.star): void {
    for (let i = 0; i < n && particles.length < 500; i++) {
        const a = rnd() * 6.283, z = rnd() * 2 - 1, r = Math.sqrt(1 - z * z);
        particles.push({ pos: [...at], vel: [r * Math.cos(a) * speed, Math.abs(z) * speed + 1, r * Math.sin(a) * speed], life: life * (0.6 + rnd() * 0.6), max: life, size: size * (0.6 + rnd() * 0.8), color, kind, spin: rnd() });
    }
}
function note(at: V3, color: RGB): void {
    if (particles.length > 480) return;
    particles.push({ pos: [at[0], at[1] + 1.1, at[2]], vel: [(rnd() - 0.5) * 0.8, 1.2 + rnd() * 0.6, (rnd() - 0.5) * 0.8], life: 1.6, max: 1.6, size: 0.38, color, kind: GLOW.note, spin: rnd() });
}
function stepParticles(dt: number): void {
    for (const p of particles) {
        p.life -= dt;
        if (p.kind === GLOW.note) { p.vel[0] = Math.sin(realTime * 3 + p.spin * 9) * 0.6; }
        else p.vel[1] -= 3 * dt;
        p.pos = [p.pos[0] + p.vel[0] * dt, p.pos[1] + p.vel[1] * dt, p.pos[2] + p.vel[2] * dt];
    }
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
}

function toast(text: string): void { hud.toasts.unshift({ text, age: 0 }); if (hud.toasts.length > 3) hud.toasts.pop(); }

function handleEvents(events: GameEvent[]): void {
    for (const e of events) {
        switch (e.kind) {
            case "chirp": sound.chirp(e.species, e.at, e.note); note(e.at, SPECIES[e.species].color); break;
            case "npcNote": sound.instrument(e.instrument, e.midi, e.at); if (rnd() < 0.5) note(e.at, [0.95, 0.96, 1]); break;
            case "shot": sound.shot(e.at, e.foe); break;
            case "hit": sound.hit(e.at, e.foe); burst(e.at, 4, 3, 0.25, e.color, 0.35); break;
            case "fade": sound.fade(e.at); burst(e.at, 10, 2, 0.3, SPECIES[e.species].color, 0.8); break;
            case "revived": sound.revived(e.at); burst(e.at, 14, 3, 0.3, SPECIES[e.species].color, 0.8); break;
            case "passed": sound.passed(); note(e.at, [1, 1, 1]); toast(`A ${SPECIES[e.species].name} has passed away`); break;
            case "ate": sound.ate(e.at); burst(e.at, 5, 2, 0.2, [1, 0.12, 0.62], 0.5); break;
            case "split": sound.split(e.species); burst(e.at, 16, 3, 0.3, SPECIES[e.species].color, 0.8); toast(`A ${SPECIES[e.species].name} split in two  -  the swarm is ${e.size} now`); break;
            case "crate": sound.crate(e.at); burst(e.at, 18, 5, 0.3, [0.85, 0.85, 0.85], 0.7); break;
            case "relic": sound.relic(); break;
            case "defeated": sound.defeated(e.at, e.big); burst(e.at, e.big ? 60 : 16, e.big ? 9 : 4, e.big ? 0.8 : 0.35, [1, 1, 1], e.big ? 1.6 : 0.7); if (e.big) { hud.flash = 0.8; hud.banner = { title: `${e.name.toUpperCase()} IS SILENT`, text: "The red drains out of the ground.", age: 0, color: [1, 1, 1] }; } break;
            case "purified": sound.purified(); hud.flash = Math.max(hud.flash, 0.35); burst(e.at, 50, 6, 0.4, [1, 1, 1], 1.4); hud.banner = { title: `${e.name.toUpperCase()} IS PURE`, text: e.freed ? `Three ${SPECIES[e.freed].name}s were trapped inside. They follow you now.` : "Its music comes back. Amber relics spill from where the heart was.", age: 0, color: e.freed ? SPECIES[e.freed].color : [1, 1, 1] }; save(); break;
            case "anchor": sound.purified(); toast(e.left ? `An anchor falls silent  -  ${e.left} left` : "The last anchor is silent"); break;
            case "gate": sound.gate(e.open); if (e.open) toast("A gate opens"); break;
            case "lever": sound.lever(); toast("Somewhere, a gate swings open"); break;
            case "portal": sound.portal(); burst(e.at, 14, 3, 0.3, [0.05, 0.92, 0.82], 0.7); break;
            case "slam": sound.slam(); hud.hurt = Math.max(hud.hurt, 0.25); break;
            case "tomHurt": sound.hurt(); hud.hurt = Math.min(1, hud.hurt + e.amount / 30); break;
            case "tomDown": sound.down(); break;
            case "order": {
                const sw = game.swarms[e.swarm];
                sound.order(e.ok, sw?.species ?? null);
                hud.cardFlash[e.swarm] = 0.8;
                if (!e.ok) toast(e.label);
                break;
            }
            case "select": if (game.swarms[e.swarm]) sound.select(game.swarms[e.swarm].species); break;
            case "jam":
                if (e.what === "note" && e.note !== undefined) sound.jamNote(NPCS[e.npc].instrument, e.note, game.level);
                else if (e.what === "ok" || e.what === "fail") sound.jamResult(e.what === "ok");
                else if (e.what === "done") { sound.song(); pipeMode = false; toast(`${NPCS[e.npc].name}: "That was music."`); save(); }
                break;
            case "pipe": sound.pipe(e.note, game.level); note(e.at, PIPE_NOTES[e.note].color); break;
            case "song": sound.song(); if (e.id === "gathering") toast("The Gathering Song: every swarm comes home"); break;
            case "link": sound.link(); if (!hud.link) hud.link = { text: e.text, age: 0 }; else hud.links.push(e.text); break;
            case "say": hud.say = { name: NPCS[e.npc].name, text: e.text, age: 0 }; break;
            case "lesson": if (!hud.lesson) hud.lesson = { id: e.id, age: 0 }; else if (!hud.lessons.includes(e.id)) hud.lessons.push(e.id); break;
            case "toast": toast(e.text); break;
            case "exitOpen": hud.banner = { title: "THE SONG GATE IS OPEN", text: "Every heart is pure. Walk into the white ring.", age: 0, color: [1, 1, 1] }; sound.complete(); break;
            case "levelComplete": save(); setMode("complete"); break;
            case "ending": break;
        }
    }
}

// --- the frame ------------------------------------------------------------------------------

function cameraNow(): { pos: V3; target: V3; fov: number } {
    if (freeCam) return freeCam;
    if (mode === "title" || mode === "ending") {
        const a = realTime * 0.05, c = game.level.spawn;
        return { pos: [c[0] + Math.sin(a) * 40, 22, c[1] + Math.cos(a) * 40], target: [c[0] * 0.3, 2, c[1] * 0.5], fov: 50 };
    }
    return game.camera();
}

function tension(): number {
    let n = 0;
    for (const d of game.darks) if (d.engaged && !d.purified) n += 0.5;
    return clamp(n + (1 - game.tom.hp / game.tom.maxHp) * 0.4);
}

function frame(dt: number, show = true): void {
    realTime += dt; storyAge += dt; frames++;
    controller.expire(realTime);
    const input = readInput();
    if (mode === "play" || mode === "stall") {
        game.step(dt, mode === "play" ? input : NO_INPUT);
        handleEvents(game.events);
        game.events = [];
    } else if (mode === "title") game.step(dt, NO_INPUT), (game.events = []);
    stepParticles(dt);
    pressed.clear(); padPressed.clear();
    for (let i = 0; i < hud.cardFlash.length; i++) hud.cardFlash[i] = Math.max(0, (hud.cardFlash[i] ?? 0) - dt);
    if (mode === "play" && realTime - lastSave > 30) save();
    if (show) draw(dt);
}

function ensureLevelMeshes(): void {
    if (meshLevel === game.level.id) return;
    meshLevel = game.level.id;
    terrainKey = renderer.levelMesh(`terrain-${game.level.id}`, () => game.terrain.mesh(1.5));
    waterKey = renderer.levelMesh(`water-${game.level.id}`, () => waterMesh(game.terrain));
}

function draw(dt: number): void {
    if (!renderer.ready) return;
    ensureLevelMeshes();
    const cam = cameraNow();
    const [w, h] = Entropy.Window.getSize();
    Entropy.Camera.setTransform(cam.pos, cam.target, [0, 1, 0]);
    Entropy.Camera.setFov(cam.fov);
    hud.flash = Math.max(0, hud.flash - dt * 1.4);
    hud.hurt = Math.max(0, hud.hurt - dt * 1.2);

    const sel = game.selectedSwarm;
    const selColor: RGB = sel ? SPECIES[sel.species].color : [1, 1, 1];
    renderer.begin();
    drawScene(renderer, game, realTime, particles, cam.pos, terrainKey, waterKey, selColor);
    renderer.flush();

    const tom = game.tom.pos;
    const focus = Math.hypot(tom[0] - cam.pos[0], tom[1] + 1 - cam.pos[1], tom[2] - cam.pos[2]);
    const fog: [number, number, number] = [0.9, 0.91, 0.93];
    const fade = mode === "intro" || mode === "complete" ? 0.25 : 0;
    const look: WorldLook = {
        time: realTime, aspect: w / Math.max(1, h), focus, exposure: 1,
        sun: norm([0.45, 0.8, 0.35]), haze: 0.012, cam: cam.pos, dof: 1, screen: [w, h],
        tom, hurt: hud.hurt, fog, fade,
        veins: 1, hatch: 1, ink: 1, flash: hud.flash,
        pulses: game.pulses.slice(-32).map(p => ({ x: p.x, z: p.z, radius: p.t * p.speed, strength: p.strength * clamp(1 - (p.t * p.speed) / p.reach), color: p.color, width: 1.2 + p.t * 0.8 })),
        darks: game.darks.map(d => [d.def.x, d.def.z, d.radius, d.purified ? 0 : d.boss ? 1 : d.heart / d.heartMax] as [number, number, number, number]),
    };
    renderer.writeWorld(look);
    renderer.writePost({ focus, range: Math.max(6, focus * 0.6), blur: 9, haze: 0.0065, fog, bloom: 0.55, screen: [w, h], time: realTime, ink: 1, vignette: 0.35, grain: 0.035, fade, flash: hud.flash * 0.6 + (mode === "title" ? 0 : 0) });

    hud.timer += dt;
    if (hud.timer >= 1 / 30 || fixedStep) { drawUi(hud.timer, w, h); hud.timer = 0; }
    sound.step(realTime, game.level, mode === "play" ? tension() : 0, { pos: cam.pos, yaw: game.camYaw });
}

function hudView(w: number, h: number): HudView {
    const g = game;
    const boss = g.darks.find(d => d.boss?.alive && d.engaged)?.boss ?? null;
    const near = g.npcNear(5);
    let prompt = "";
    if (near && !g.jam) {
        const def = NPCS[near.id];
        prompt = def.role === "shop" ? `${def.name}:  [R] talk   [B] trade` : JAM_PHRASES[near.id] && !g.campaign.jams.includes(near.id) ? `${def.name}:  [R] talk   [F] jam on your Prism Pipe` : `${def.name}:  [R] talk`;
        if (device === "pad") prompt = prompt.replace("[R]", "[B]").replace("[B] trade", "[BACK] trade").replace("[F]", "[X]");
    }
    if (pipeMode && !g.jam) prompt = "Prism Pipe: play 1-5   [F] put it away";
    const hover = g.hover && sel() ? { text: `${SPECIES[sel()!.species].name} swarm  >  ${g.hover.label}`, color: SPECIES[sel()!.species].color } : null;
    return {
        w, h, time: realTime, device,
        island: g.level.name, hearts: g.hearts, relics: g.campaign.relics, chimes: g.campaign.chimes, hp: g.tom.hp / g.tom.maxHp,
        swarms: g.swarms.map((s, i) => ({
            name: SPECIES[s.species].name, species: s.species, count: g.liveTones(s).length, faded: g.tonesOf(s).filter(t => t.state === "faded").length, food: s.food,
            traits: TRAIT_IDS.filter(t => traitRank(s.species, s.traits, t) > 0).map(t => ({ id: t, rank: traitRank(s.species, s.traits, t) })),
            order: s.order.label, selected: i === g.selected, key: String(i + 1), unreachable: s.unreachable > 0, flash: hud.cardFlash[i] ?? 0,
        })),
        hover,
        link: hud.link, say: hud.say,
        lesson: hud.lesson && LESSONS[hud.lesson.id] ? { ...LESSONS[hud.lesson.id], age: hud.lesson.age, more: hud.lessons.length } : null,
        toasts: hud.toasts, banner: hud.banner,
        boss: boss ? { name: BOSSES[boss.id].name, hp: boss.hp / boss.maxHp, anchors: boss.anchors.filter(a => a.hp > 0).length } : null,
        prompt,
        jam: g.jam ? { npc: g.jam.npc, phrase: g.jam.phrase, phrases: JAM_PHRASES[g.jam.npc].length, step: g.jam.step, shown: JAM_PHRASES[g.jam.npc][Math.min(g.jam.phrase, JAM_PHRASES[g.jam.npc].length - 1)].slice(0, g.jam.shown), input: g.jam.input, length: JAM_PHRASES[g.jam.npc][Math.min(g.jam.phrase, JAM_PHRASES[g.jam.npc].length - 1)].length } : null,
        pipe: pipeMode || g.jam ? g.pipeGlow.map(v => v + 0.0001) : g.pipeGlow,
        exitOpen: g.exitOpen, down: g.tom.down,
        hints: device === "pad"
            ? "[RT] direct   [LB] recall   [D-PAD] swarms   [Y] gather   [X] pipe   [B] talk   [START] title"
            : "[CLICK] direct   [RIGHT CLICK] recall   [TAB / 1-8] swarms   [G] gather   [V] divide   [F] pipe   [R] talk   [Q/E] camera   [P] haze   [ESC] title",
    };
}
const sel = () => game.selectedSwarm;

function stallView(w: number, h: number): StallView {
    const g = game;
    const sw = g.swarms[stall.selected];
    return {
        w, h, device, relics: g.campaign.relics, chimes: g.campaign.chimes, relicValue: RELIC_VALUE,
        swarms: g.swarms.map(s => ({ name: SPECIES[s.species].name, species: s.species, count: g.tonesOf(s).length, traits: Object.fromEntries(TRAIT_IDS.map(t => [t, traitRank(s.species, s.traits, t)])) })),
        selected: stall.selected, cursor: stall.cursor,
        prices: Object.fromEntries(TRAIT_IDS.map(t => [t, sw ? traitPrice(sw.species, sw.traits, t) : null])),
        hatch: g.campaign.unlocked.map(s => ({ species: s, price: 90, can: g.campaign.chimes >= 90 && g.swarms.length < 8 })),
        note: stall.note,
    };
}

function drawUi(dt: number, w: number, h: number): void {
    if (!painter) return;
    const p = painter;
    p.begin();
    for (const t of hud.toasts) t.age += dt;
    hud.toasts = hud.toasts.filter(t => t.age < 4.5);
    if (hud.banner) { hud.banner.age += dt; if (hud.banner.age > 6) hud.banner = null; }
    if (hud.link) { hud.link.age += dt; if (hud.link.age > 11) { hud.link = null; const n = hud.links.shift(); if (n) hud.link = { text: n, age: 0 }; } }
    if (hud.say) { hud.say.age += dt; if (hud.say.age > 6) hud.say = null; }
    if (hud.lesson && mode === "play") { hud.lesson.age += dt; if (hud.lesson.age > 14) nextLesson(); }
    if (mode === "title") {
        const c = saved;
        drawTitle(p, w, h, realTime, !!c, c ? `${LEVELS.find(l => l.id === c.level)?.name ?? ""}  -  ${c.swarms.length} swarms, ${c.swarms.reduce((s, x) => s + x.tones, 0)} Tones  -  ${c.chimes} chimes` : "", device);
    } else if (mode === "intro") drawStory(p, w, h, "AGENT TOM", INTRO, storyAge, device === "pad" ? "[A] begin" : "[ENTER] begin");
    else if (mode === "complete") {
        const next = LEVELS[LEVELS.findIndex(l => l.id === game.level.id) + 1];
        drawStory(p, w, h, `${game.level.name.toUpperCase()} SINGS AGAIN`, [
            `Hearts purified: ${game.campaign.stats.purified}.  Corrupted silenced: ${game.campaign.stats.defeated}.`,
            `Fruit eaten: ${game.campaign.stats.fed}.  Splits: ${game.campaign.stats.splits}.  Revived: ${game.campaign.stats.revived}.  Lost: ${game.campaign.stats.lost}.`,
            next ? `Next: ${next.name}. ${next.text}` : "The signal's source is silent.",
        ], storyAge, device === "pad" ? "[A] go on" : "[ENTER] go on");
    } else if (mode === "ending") drawStory(p, w, h, "THE WORLD OF MUSIC", ENDING, storyAge, device === "pad" ? "[A] the end" : "[ENTER] the end");
    else {
        drawHud(p, hudView(w, h));
        if (mode === "stall") drawStall(p, stallView(w, h));
    }
    p.flush();
}

addon.onInit(() => {
    renderer.init();
    Entropy.setGameMode(false);
    Entropy.Lighting.updateSun({ horizonColor: [0.9, 0.9, 0.9], zenithColor: [0.7, 0.7, 0.7], sunDirection: [0.45, 0.8, 0.35], sunColor: [1, 1, 1], sunIntensity: 0 });
    painter = enginePainter(addon.UI as unknown as DrawApi);
    load();
    if (saved) game = new Game(JSON.parse(JSON.stringify(saved)) as Campaign);
    game.events = [];
    setupInput();
    registerTools();
    Entropy.println("[world-of-music] initialized");
});

addon.onUpdatePlus("Global", () => {
    if (!renderer.ready) return;
    const now = Date.now();
    const real = lastMs ? Math.min(0.1, Math.max(0, (now - lastMs) / 1000)) : 1 / 60;
    lastMs = now;
    frame(fixedStep ?? real);
});

// --- MCP tools (tests/world_of_music_live.rs drives these) ----------------------------------

type Args = Record<string, unknown>;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: V3): V3 => (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number") ? [v[0], v[1], v[2]] : d);

function snapshot() {
    const g = game;
    return {
        mode, frames, realTime: Math.round(realTime * 100) / 100, device, post: renderer.screenOn,
        scene: { solids: renderer.solids.lastStats.instances, glows: renderer.glows.lastStats.instances, inks: renderer.inks.lastStats.instances },
        sound: sound.played, ui: painter?.opCount() ?? 0,
        level: g.level.id, tom: g.tom.pos.map(v => Math.round(v * 10) / 10), hp: Math.round(g.tom.hp),
        selected: g.selected, chimes: g.campaign.chimes, relics: g.campaign.relics,
        swarms: g.swarms.map(s => ({ species: s.species, tones: g.liveTones(s).length, faded: g.tonesOf(s).filter(t => t.state === "faded").length, order: s.order.kind, label: s.order.label, food: s.food, traits: s.traits })),
        darks: g.darks.map(d => ({ id: d.def.id, purified: d.purified, heart: Math.round(d.heart), enemies: g.enemies.filter(e => e.dark === d.idx && e.alive).length, wir: d.arena.stats, boss: d.boss ? { hp: Math.round(d.boss.hp), anchors: d.boss.anchors.filter(a => a.hp > 0).length } : null })),
        gates: g.gates.map(x => ({ id: x.id, open: x.open })), switches: g.switches.map(s => ({ id: s.id, weight: s.weight, need: s.need })), levers: g.levers.map(l => ({ id: l.id, flipped: l.flipped })),
        exitOpen: g.exitOpen, complete: g.complete, jam: g.jam ? { npc: g.jam.npc, phrase: g.jam.phrase, step: g.jam.step } : null, songs: g.campaign.songs, lesson: hud.lesson?.id ?? null,
        pulses: g.pulses.length, particles: particles.length, stats: g.campaign.stats,
    };
}

let undrawn = 0;
function advance(n: number, input: Partial<WomInput> = {}, last = true): void {
    for (let i = 0; i < n; i++) {
        scripted = { ...input, frames: 1 };
        const show = last && i === n - 1;
        frame(fixedStep ?? 1 / 30, show);
        undrawn = show ? 0 : undrawn + 1;
    }
}

/** Where a tool's `to` points: [x, z], a dark id (its heart), "lever", "switch:<id>", "crate:<i>", "tree:<i>", "npc:<id>", "enemy", "exit", "portal". */
function locate(to: unknown): [number, number] | null {
    const g = game;
    if (Array.isArray(to) && to.length >= 2) return [Number(to[0]), Number(to[to.length - 1])];
    const k = String(to);
    const d = g.darks.find(x => x.def.id === k); if (d) return [d.def.x, d.def.z];
    if (k === "exit") return g.level.exit;
    if (k === "enemy") { const e = g.enemies.find(x => x.alive); return e ? [e.pos[0], e.pos[2]] : null; }
    const [kind, id] = k.split(":");
    if (kind === "lever") { const l = id ? g.levers.find(x => x.id === id) : g.levers[0]; return l ? [l.x, l.z] : null; }
    if (kind === "switch") { const s = id ? g.switches.find(x => x.id === id) : g.switches[0]; return s ? [s.x, s.z] : null; }
    if (kind === "gate") { const s = id ? g.gates.find(x => x.id === id) : g.gates[0]; return s ? [s.x, s.z] : null; }
    if (kind === "crate") { const c = g.crates[Number(id ?? 0)]; return c ? [c.x, c.z] : null; }
    if (kind === "tree") { const t = g.trees[Number(id ?? 0)]; return t ? [t.x, t.z] : null; }
    if (kind === "npc") { const n = g.npcs.find(x => x.id === id); return n ? [n.x, n.z] : null; }
    if (kind === "anchor") { const b = g.darks.find(x => x.boss)?.boss; const a = b?.anchors[Number(id ?? 0)]; return a ? [a.x, a.z] : null; }
    if (kind === "boss") { const b = g.darks.find(x => x.boss)?.boss; return b ? [b.pos[0], b.pos[2]] : null; }
    if (kind === "portal") { const p = g.level.portals[0]; return p ? (id === "b" ? p.b : p.a) : null; }
    return null;
}

function registerTools(): void {
    const tools: { name: string; description: string; parameters: object; run: (a: Args) => object }[] = [
        { name: "wom_state", description: "World of Music's state: mode, the island, Tom, every swarm and its order, the corrupted patches (with WIR decision stats), gates, switches, levers, the jam.", parameters: { type: "object", properties: {} }, run: () => snapshot() },
        {
            name: "wom_config", description: "Test settings: fixedStep (seconds per frame, null for real time), sound (bool), device ('keys' or 'pad'), post (bool: the depth-of-field screen pass), check (bool: check every WIR decision against its rule).",
            parameters: { type: "object", properties: { fixedStep: { type: "number" }, sound: { type: "boolean" }, device: { type: "string" }, post: { type: "boolean" }, check: { type: "boolean" } } },
            run: a => {
                if ("fixedStep" in a) fixedStep = a.fixedStep === null ? null : num(a.fixedStep, 1 / 30);
                if ("sound" in a) sound.enabled = !!a.sound;
                if (a.device === "keys" || a.device === "pad") device = a.device;
                if ("post" in a) { postOn = !!a.post; renderer.setScreen(postOn); }
                if ("check" in a) for (const d of game.darks) d.arena.check = !!a.check;
                return snapshot();
            },
        },
        {
            name: "wom_start", description: "Starts a new mission on an island (cove, falls, caldera) as if the ones before were done; extra: chimes, relics, lull (bool: add the violet swarm), screen ('title', 'intro', 'play').",
            parameters: { type: "object", properties: { level: { type: "string" }, chimes: { type: "number" }, lull: { type: "boolean" }, screen: { type: "string" } } },
            run: a => {
                const id = String(a.level ?? "cove"), i = LEVELS.findIndex(l => l.id === id);
                if (i < 0) throw new Error(`No island ${id}`);
                const c = newCampaign();
                c.level = id; c.completed = LEVELS.slice(0, i).map(l => l.id);
                c.chimes = num(a.chimes, 0); c.relics = num(a.relics, 0);
                if (a.lull || i > 0) { c.unlocked.push("lull"); c.swarms.push({ species: "lull", traits: {}, tones: 3, growth: [0, 0, 0] }); }
                if (i > 0) c.songs.push("gathering");
                game = new Game(c);
                afterStart();
                mode = (["title", "intro", "play"].includes(String(a.screen)) ? String(a.screen) : "play") as Mode;
                storyAge = num(a.storyAge, 0);
                return snapshot();
            },
        },
        {
            name: "wom_camera", description: "A free camera at position looking at target (world metres), fov degrees; {yaw, dist} turns the game camera instead; {release: true} gives it back.",
            parameters: { type: "object", properties: { position: { type: "array" }, target: { type: "array" }, fov: { type: "number" }, yaw: { type: "number" }, dist: { type: "number" }, release: { type: "boolean" } } },
            run: a => {
                if (a.release) freeCam = null;
                else if ("yaw" in a || "dist" in a) { freeCam = null; game.camYaw = num(a.yaw, game.camYaw); game.camDist = num(a.dist, game.camDist); }
                else {
                    // `relative`: position and target are offsets from Agent Tom's feet.
                    const o: V3 = a.relative ? [...game.tom.pos] : [0, 0, 0];
                    const p = vec(a.position, cameraNow().pos), t = vec(a.target, cameraNow().target);
                    freeCam = { pos: [p[0] + o[0], p[1] + o[1], p[2] + o[2]], target: [t[0] + o[0], t[1] + o[1], t[2] + o[2]], fov: num(a.fov, 52) };
                }
                draw(0);
                return snapshot();
            },
        },
        {
            name: "wom_act", description: "Plays. action: wait (frames); walk (to; frames: Tom walks there); teleport (to, distance: Tom and every standing Tone); direct (to, frames: a click there with the selected swarm, then waits); select (index); recall; gather; divide; talk; pipe (note 0-4); jam (starts it near a player); solveJam (plays the right notes); stall (open/close); sell; buy (swarm, trait); hatch (species); hurtTone (swarm: one Tone falls); feed (swarm, n: fruit eaten); purifyAll; screen (title|intro|play|complete|ending); banner (clears banners).",
            parameters: { type: "object", properties: { action: { type: "string" }, frames: { type: "number" } } },
            run: a => {
                const g = game, n = Math.max(1, Math.round(num(a.frames, 1)));
                switch (String(a.action)) {
                    case "wait": advance(n); break;
                    case "teleport": {
                        const p = locate(a.to); if (!p) throw new Error(`Nothing called ${String(a.to)}`);
                        const back = num(a.distance, 6), yaw = g.camYaw;
                        const x = p[0] - Math.sin(yaw) * back, z = p[1] - Math.cos(yaw) * back;
                        g.tom.pos = [x, g.terrain.surface(x, z), z]; g.tom.vel = [0, 0, 0];
                        g.tones.forEach((t, i) => { if (t.state === "ok") { const tx = x + Math.cos(i * 2.4) * (1.5 + (i % 3)), tz = z - 2 + Math.sin(i * 2.4) * (1.5 + (i % 3)); t.pos = [tx, g.terrain.surface(tx, tz), tz]; } });
                        for (const s of g.swarms) g.recall(s);
                        advance(1); break;
                    }
                    case "walk": {
                        const p = locate(a.to); if (!p) throw new Error(`Nothing called ${String(a.to)}`);
                        for (let i = 0; i < n; i++) {
                            const dx = p[0] - g.tom.pos[0], dz = p[1] - g.tom.pos[2], d = Math.hypot(dx, dz);
                            if (d < 1.2) break;
                            advance(1, { moveX: dx / d, moveZ: dz / d }, false);
                        }
                        draw(0); break;
                    }
                    case "direct": {
                        const p = locate(a.to); if (!p) throw new Error(`Nothing called ${String(a.to)}`);
                        if ("swarm" in a) g.selected = num(a.swarm, g.selected);
                        const cursor: V3 = [p[0], g.terrain.surface(p[0], p[1]), p[1]];
                        advance(1, { cursor, direct: true });
                        advance(n, { cursor });
                        break;
                    }
                    case "select": g.selected = Math.max(0, Math.min(g.swarms.length - 1, Math.round(num(a.index, 0)))); advance(1); break;
                    case "recall": advance(1, { recall: true }); break;
                    case "gather": advance(1, { gather: true }); break;
                    case "divide": advance(1, { divide: true }); break;
                    case "talk": advance(1, { talk: true }); break;
                    case "pipe": pipeMode = true; advance(1, { note: Math.round(num(a.note, 0)) }); advance(n); break;
                    case "jam": if (!g.startJam()) throw new Error("No one to jam with here"); pipeMode = true; advance(n); break;
                    case "solveJam": {
                        for (let guard = 0; guard < 2000 && g.jam; guard++) {
                            const j = g.jam;
                            if (j.step === "echo") { const phrase = JAM_PHRASES[j.npc][j.phrase]; advance(1, { note: phrase[j.input.length] }, false); advance(4, {}, false); }
                            else advance(1, {}, false);
                        }
                        advance(1); break;
                    }
                    case "stall": setMode(mode === "stall" ? "play" : "stall"); advance(1); break;
                    case "sell": act("sell"); advance(1); break;
                    case "buy": stall.selected = Math.round(num(a.swarm, 0)); act(`buy:${String(a.trait)}`); advance(1); break;
                    case "hatch": act(`hatch:${String(a.species)}`); advance(1); break;
                    case "hurtTone": { const s = g.swarms[Math.round(num(a.swarm, 0))]; const t = s && g.liveTones(s)[0]; if (t) g.hurtTone(t, 1e6); advance(1); break; }
                    case "feed": { const s = g.swarms[Math.round(num(a.swarm, 0))]; if (s) s.food += Math.round(num(a.n, 3)); advance(n); break; }
                    case "purifyAll": for (const d of g.darks) { if (d.boss) { d.boss.anchors.forEach(x => (x.hp = 0)); g.damageBoss(d, 1e9); } else { d.heart = 0.0001; (g as unknown as { purify(d: unknown): void }).purify(d); } } advance(n); break;
                    case "screen": { const s = String(a.screen); if (["title", "intro", "play", "complete", "ending", "stall"].includes(s)) { mode = s as Mode; storyAge = num(a.age, 9); } advance(1); break; }
                    case "banner": hud.banner = null; hud.toasts = []; hud.lesson = null; hud.lessons = []; hud.link = null; hud.links = []; hud.say = null; advance(1); break;
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

void dot;
