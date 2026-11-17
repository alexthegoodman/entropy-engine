// Armageddon 2070's screens, drawn with the retained Painter (Entropy.UI rects and texts): the title,
// battle setup (map, side, size), the armory (loadout and armor builder), the deploy screen (spawn
// points on the map), the battle HUD (crosshair, health, ammo, tickets, territories, minimap,
// killfeed, squad, rewards, streak and underdog meters, vehicle panel), the scoreboard and the
// debrief.

import { Painter, FONT, textWidth, type Color } from "../allegiance/al_ui";
import { WEAPON, WEAPONS, ATTACHMENTS, ARMOR, ARMOR_BY_ID, EQUIP, EQUIPMENT, AMMO, AMMO_BY_ID, REWARD, KILLSTREAKS, BALANCE, ROLE_LOADOUTS, loadoutStats, type Loadout, type ArmorSlot, type Role } from "./ar_data";
import { MAPS, HALF, MAP_SIZE } from "./ar_map";
import { TEAM_NAMES, TEAM_SHORT, type Battle, type Soldier, type Team } from "./ar_sim";

const C = {
    bg: [0.04, 0.045, 0.05, 0.92] as Color, panel: [0.07, 0.08, 0.09, 0.86] as Color, line: [1, 1, 1, 0.14] as Color,
    text: [0.92, 0.93, 0.9, 1] as Color, dim: [0.6, 0.62, 0.6, 1] as Color, warn: [1, 0.55, 0.2, 1] as Color, red: [0.95, 0.25, 0.2, 1] as Color, good: [0.45, 0.9, 0.5, 1] as Color,
    gold: [1, 0.78, 0.25, 1] as Color, shade: [0, 0, 0, 0.45] as Color, clear: [0, 0, 0, 0] as Color,
    team: [[0.3, 0.75, 1, 1], [1, 0.45, 0.12, 1]] as Color[], neutral: [0.75, 0.75, 0.75, 1] as Color,
};
const H = FONT.head, N = FONT.num, B = FONT.body;
const tc = (t: Team | -1): Color => (t === -1 ? C.neutral : C.team[t]);

function frame(p: Painter, x: number, y: number, w: number, h: number, fill: Color = C.panel): void {
    p.rect(x, y, w, h, fill, 1, C.line);
}
function header(p: Painter, x: number, y: number, w: number, title: string, color: Color = C.warn): number {
    p.rect(x, y, w, 30, [0, 0, 0, 0.7]);
    p.rect(x, y + 30, w, 2, color);
    p.text(title, x + 10, y + 5, 16, C.text, H);
    return y + 40;
}

// --- title and setup ------------------------------------------------------------------------------

export const LORE = [
    "2070. Fusion gave the world abundance. Abundance gave it decay, then the Directorates, then the war.",
    "The first fusion bombs fell on the Indian subcontinent. It is gone; its glow still lights the southern sky.",
    "Now the Meridian Directorate and the Ember Ascendancy fight for what is left on the rim of the ash.",
];

export function drawTitle(p: Painter, w: number, h: number, t: number, hasSave: boolean): void {
    p.rect(0, 0, w, h, [0.02, 0.02, 0.025, 0.55]);
    p.rect(0, h * 0.22, w, 3, [1, 0.42, 0.12, 0.8]);
    p.text("ARMAGEDDON", w * 0.08, h * 0.24, Math.min(92, w / 11), C.text, H);
    p.text("2070", w * 0.08 + textWidth("ARMAGEDDON", Math.min(92, w / 11), H) + Math.min(92, w / 11) * 0.6, h * 0.24, Math.min(92, w / 11), [1, 0.45, 0.15, 1], H);
    p.text("Large-scale squad tactical combat  /  128 vs 128  /  Conquer", w * 0.08 + 4, h * 0.24 + Math.min(92, w / 11) * 1.35, 18, C.dim, B);
    LORE.forEach((l, i) => p.text(l, w * 0.08 + 4, h * 0.45 + i * 28, 15, [0.85, 0.85, 0.82, Math.min(1, Math.max(0, t * 0.8 - i * 0.4))], B));
    const bx = w * 0.08, by = h * 0.66;
    p.button("setup", bx, by, 260, 48, "BATTLE", "red", { size: 18 });
    p.button("armory", bx + 280, by, 220, 48, "ARMORY", "dark", { size: 16 });
    if (hasSave) p.text("Your loadout is saved.", bx, by + 60, 13, C.dim, B);
    p.text("[ENTER] battle   [A] armory", bx, h - 46, 13, C.dim, B);
}

export interface SetupView { map: number; team: Team; size: number; vehicles: boolean }
export function drawSetup(p: Painter, w: number, h: number, v: SetupView): void {
    p.rect(0, 0, w, h, [0.02, 0.02, 0.025, 0.6]);
    const x0 = Math.max(24, w * 0.06), cw = Math.min(330, (w - x0 * 2 - 30) / 4);
    let y = header(p, x0, 40, cw * 4 + 30, "CHOOSE THE BATTLEFIELD");
    MAPS.forEach((m, i) => {
        const x = x0 + i * (cw + 10), sel = i === v.map;
        frame(p, x, y, cw, 250, sel ? [0.16, 0.12, 0.07, 0.95] : C.panel);
        if (sel) p.rect(x, y, cw, 4, C.warn);
        p.text(m.name.toUpperCase(), x + 12, y + 14, 17, sel ? C.gold : C.text, H);
        p.text(`${m.territories.length} territories  /  ${m.biome}`, x + 12, y + 44, 12, C.dim, B);
        p.text(m.blurb, x + 12, y + 68, 12, [0.82, 0.82, 0.8, 1], B, cw - 24, 150);
        p.hotspot(`map:${i}`, x, y, cw, 250);
    });
    y += 270;
    p.text("SIDE", x0, y, 14, C.dim, H);
    ([0, 1] as Team[]).forEach(t => p.button(`team:${t}`, x0 + 80 + t * 250, y - 8, 240, 36, TEAM_NAMES[t].toUpperCase(), v.team === t ? "red" : "dark", { size: 12, active: v.team === t }));
    y += 50;
    p.text("SIZE", x0, y, 14, C.dim, H);
    [32, 64, 128].forEach((n, i) => p.button(`size:${n}`, x0 + 80 + i * 170, y - 8, 160, 36, `${n} VS ${n}`, "dark", { size: 12, active: v.size === n }));
    y += 50;
    p.text("VEHICLES", x0, y, 14, C.dim, H);
    p.button("vehicles", x0 + 120, y - 8, 160, 36, v.vehicles ? "ON" : "OFF", "dark", { size: 12, active: v.vehicles });
    p.button("start", x0, h - 100, 280, 52, "DEPLOY", "red", { size: 20 });
    p.button("armory", x0 + 300, h - 100, 200, 52, "ARMORY", "dark", { size: 15 });
    p.button("back", x0 + 520, h - 100, 140, 52, "BACK", "ghost", { size: 14 });
    p.text("Multiplayer comes later: every other soldier is a bot thinking with WIR networks.", x0, h - 36, 12, C.dim, B);
}

// --- armory ---------------------------------------------------------------------------------------

export const ARMOR_SLOTS: ArmorSlot[] = ["Helmet", "Chest", "Shoulders", "Arms", "Legs", "Utility", "Exoskeleton", "Finish"];
export const ATTACH_SLOTS = ["Optic", "Muzzle", "Barrel", "Underbarrel", "Magazine", "Utility"];

/** Every cycle the armory offers: weapons by slot, attachments that fit, armor by slot, equipment. */
export function armoryRows(l: Loadout): { id: string; label: string; value: string }[] {
    const p = WEAPON.get(l.primary)!;
    const rows = [
        { id: "role", label: "PRESET", value: "cycle role presets" },
        { id: "primary", label: "PRIMARY", value: `${p.name}  (${p.category})` },
        ...ATTACH_SLOTS.filter(s => p.slots.includes(s)).map(s => ({ id: `att:${s}`, label: s.toUpperCase(), value: l.attachments[s] ? ATTACHMENTS.find(a => a.id === l.attachments[s])!.name : "-" })),
        { id: "ammo", label: "AMMO", value: AMMO_BY_ID.get(l.ammo)!.name },
        { id: "sidearm", label: "SIDEARM", value: WEAPON.get(l.sidearm)!.name },
        { id: "launcher", label: "LAUNCHER", value: l.launcher ? WEAPON.get(l.launcher)!.name : "-" },
        ...ARMOR_SLOTS.map(s => ({ id: `arm:${s}`, label: s.toUpperCase(), value: l.armor[s] ? ARMOR_BY_ID.get(l.armor[s]!)!.name : "-" })),
        ...[0, 1, 2, 3].map(i => ({ id: `eq:${i}`, label: `KIT ${i + 1}`, value: l.equipment[i] ? EQUIP.get(l.equipment[i])!.name : "-" })),
    ];
    return rows;
}

const ROLES: Role[] = ["rifleman", "leader", "support", "medic", "engineer", "marksman", "antiarmor", "recon"];

/** Steps one armory row forward or back. */
export function cycleArmory(l: Loadout, id: string, dir: number, roleIndex: { i: number }): Loadout {
    const out = JSON.parse(JSON.stringify(l)) as Loadout;
    const step = <T>(list: T[], cur: T) => list[(list.indexOf(cur) + dir + list.length * 4) % list.length];
    if (id === "role") { roleIndex.i = (roleIndex.i + dir + ROLES.length) % ROLES.length; return JSON.parse(JSON.stringify(ROLE_LOADOUTS[ROLES[roleIndex.i]])); }
    if (id === "primary") {
        out.primary = step(WEAPONS.filter(w => w.slot === "Primary" || w.slot === "Heavy" || w.slot === "Special").map(w => w.id), out.primary);
        const w = WEAPON.get(out.primary)!;
        for (const s of Object.keys(out.attachments)) { const a = ATTACHMENTS.find(x => x.id === out.attachments[s]); if (!a || !a.fits.includes(w.id) || !w.slots.includes(s)) delete out.attachments[s]; }
    } else if (id.startsWith("att:")) {
        const slot = id.slice(4);
        const opts = ["", ...ATTACHMENTS.filter(a => a.slot === slot && a.fits.includes(out.primary)).map(a => a.id)];
        const n = step(opts, out.attachments[slot] ?? "");
        if (n) out.attachments[slot] = n; else delete out.attachments[slot];
    } else if (id === "ammo") out.ammo = step(AMMO.filter(a => a.type === "Ballistic").map(a => a.id), out.ammo);
    else if (id === "sidearm") out.sidearm = step(WEAPONS.filter(w => w.slot === "Sidearm").map(w => w.id), out.sidearm);
    else if (id === "launcher") out.launcher = step([null, ...WEAPONS.filter(w => w.slot === "Launcher").map(w => w.id)], out.launcher) as string | null;
    else if (id.startsWith("arm:")) {
        const slot = id.slice(4) as ArmorSlot;
        const n = step(["", ...ARMOR.filter(a => a.slot === slot).map(a => a.id)], out.armor[slot] ?? "");
        if (n) out.armor[slot] = n; else delete out.armor[slot];
    } else if (id.startsWith("eq:")) {
        const i = Number(id.slice(3));
        const n = step(["", ...EQUIPMENT.map(e => e.id)], out.equipment[i] ?? "");
        const eq = [...out.equipment];
        if (n) eq[i] = n; else eq.splice(i, 1);
        out.equipment = eq.filter(Boolean);
    }
    return out;
}

export function drawArmory(p: Painter, w: number, h: number, l: Loadout, cursor: string): void {
    p.rect(0, 0, w, h, [0.02, 0.02, 0.025, 0.82]);
    const x0 = Math.max(20, w * 0.05);
    let y = header(p, x0, 30, w - x0 * 2, "ARMORY  -  BUILD YOUR LOADOUT AND ARMOR");
    const rows = armoryRows(l);
    const rw = Math.min(560, w * 0.48);
    rows.forEach((r, i) => {
        const ry = y + i * 30, sel = r.id === cursor;
        p.rect(x0, ry, rw, 26, sel ? [0.3, 0.18, 0.06, 0.9] : [0, 0, 0, 0.35]);
        p.text(r.label, x0 + 10, ry + 4, 12, sel ? C.gold : C.dim, H);
        p.text(r.value, x0 + 150, ry + 4, 13, C.text, B);
        p.button(`prev:${r.id}`, x0 + rw - 64, ry + 1, 28, 24, "<", "ghost", { size: 12 });
        p.button(`next:${r.id}`, x0 + rw - 32, ry + 1, 28, 24, ">", "ghost", { size: 12 });
        p.hotspot(`row:${r.id}`, x0, ry, rw - 70, 26);
    });
    // Stats.
    const s = loadoutStats(l);
    const sx = x0 + rw + 24, sw = w - sx - x0;
    frame(p, sx, y, sw, h - y - 110);
    let yy = y + 12;
    const stat = (label: string, value: string, bar: number | null, color: Color = C.text) => {
        p.text(label, sx + 14, yy, 12, C.dim, H);
        p.text(value, sx + 190, yy - 1, 15, color, N);
        if (bar !== null) p.bar(sx + 360, yy + 3, Math.max(60, sw - 380), 10, bar, color);
        yy += 26;
    };
    stat("WEIGHT", `${s.weight} kg (load ${s.effectiveLoad})`, s.effectiveLoad / BALANCE.maxLoad, s.effectiveLoad > BALANCE.freeLoad ? C.warn : C.good);
    stat("SPEED", `${Math.round(s.speedShare * 100)}%`, s.speedShare, s.speedShare < 0.85 ? C.warn : C.good);
    stat("HEAD", `${Math.round(s.head * 100)}%`, s.head);
    stat("TORSO", `${Math.round(s.torso * 100)}%`, s.torso);
    stat("ARMS", `${Math.round(s.arms * 100)}%`, s.arms);
    stat("LEGS", `${Math.round(s.legs * 100)}%`, s.legs);
    stat("EXPLOSIVE", `${Math.round(s.explosive * 100)}%`, s.explosive);
    stat("VISUAL SIGNATURE", `x${s.visual.toFixed(2)}`, Math.min(1, s.visual / 1.6), s.visual < 0.9 ? C.good : s.visual > 1.15 ? C.warn : C.text);
    stat("THERMAL", `x${s.thermal.toFixed(2)}`, Math.min(1, s.thermal / 1.6));
    stat("NOISE", `x${s.noise.toFixed(2)}`, Math.min(1, s.noise / 1.8));
    stat("INVENTORY", `${s.inventoryUsed} / ${s.inventory} points`, s.inventoryUsed / Math.max(1, s.inventory), s.inventoryUsed > s.inventory ? C.red : C.text);
    yy += 6;
    const wpn = WEAPON.get(l.primary)!;
    stat("PRIMARY", `${wpn.damage} dmg, ${Math.round(s.range)} m, ${wpn.rpm} rpm`, null);
    stat("MAGAZINE", `${s.mag}  /  reload ${wpn.reload}s`, null);
    stat("AIMED SPREAD", `${s.spread.toFixed(2)} deg  recoil ${s.recoil.toFixed(2)}`, null);
    stat("ZOOM / AIM TIME", `${s.zoom}x  /  ${s.aimTime.toFixed(2)} s`, null);
    stat("SEEN FROM", `${Math.round(BALANCE.sightRange * s.visual)} m standing`, null);
    yy += 4;
    for (const prob of s.problems.slice(0, 3)) { p.text(prob, sx + 14, yy, 12, C.red, B, sw - 28); yy += 20; }
    if (!s.heavyOk && WEAPON.get(l.primary)!.heavy) { p.text("Fires braced only (crouch or prone) without a Heavy Exoskeleton.", sx + 14, yy, 12, C.warn, B, sw - 28); }
    p.button("done", x0, h - 74, 200, 46, "DONE", "red", { size: 16 });
    p.text("[UP/DOWN] row   [LEFT/RIGHT] change   [ESC] done", x0 + 220, h - 60, 12, C.dim, B);
}

// --- map --------------------------------------------------------------------------------------------

/** The map in a square: territories, bases, squad mates, spotted enemies, vehicles, strikes. */
export function drawMap(p: Painter, b: Battle, me: Soldier | null, x: number, y: number, size: number, opts: { spawns?: { id: string; label: string; x: number; z: number }[]; selected?: string; full?: boolean } = {}): void {
    const S = (wx: number, wz: number): [number, number] => [x + ((wx + HALF) / MAP_SIZE) * size, y + ((wz + HALF) / MAP_SIZE) * size];
    frame(p, x, y, size, size, opts.full ? [0.06, 0.07, 0.06, 0.78] : [0.08, 0.09, 0.08, 0.85]);
    const team = me?.team ?? 0;
    for (const base of b.world.bases) { const [px, py] = S(base.x, base.z); const r = (base.radius / MAP_SIZE) * size; p.rect(px - r, py - r, r * 2, r * 2, [...tc(base.team).slice(0, 3), 0.25] as Color, 1, tc(base.team)); }
    b.territories.forEach((t, i) => {
        const [px, py] = S(t.def.x, t.def.z);
        const r = Math.max(5, (t.def.radius / MAP_SIZE) * size);
        p.rect(px - r, py - r, r * 2, r * 2, [...tc(t.owner).slice(0, 3), t.contested ? 0.55 : 0.3] as Color, 2, t.contested ? C.gold : tc(t.owner));
        if (opts.full || size > 260) p.text(String.fromCharCode(65 + i), px - 5, py - 9, 13, C.text, H);
    });
    for (const v of b.vehicles) if (v.alive && v.team === team) { const [px, py] = S(v.pos[0], v.pos[2]); p.rect(px - 3, py - 3, 6, 6, tc(team)); }
    for (const s of b.soldiers) {
        if (!s.alive || s.vehicle >= 0) continue;
        const friend = s.team === team, mate = me && s.squad === me.squad && s.team === team;
        const spotted = !friend && b.spotted[team].has(s.id);
        if (!friend && !spotted) continue;
        if (friend && !mate && !opts.full && size < 260) continue;
        const [px, py] = S(s.pos[0], s.pos[2]);
        p.rect(px - 1.5, py - 1.5, mate ? 4 : 3, mate ? 4 : 3, friend ? (mate ? C.good : tc(team)) : C.red);
    }
    for (const st of b.strikes) { const [px, py] = S(st.x, st.z); p.rect(px - 6, py - 6, 12, 12, [1, 0.2, 0.1, 0.4], 1, C.red); }
    const call = me ? b.squads[me.squad].call : null;
    if (call) { const [px, py] = S(call.x, call.z); p.rect(px - 4, py - 4, 8, 8, C.good); }
    if (opts.spawns) for (const sp of opts.spawns) {
        const [px, py] = S(sp.x, sp.z);
        const sel = sp.id === opts.selected;
        p.rect(px - 8, py - 8, 16, 16, sel ? C.gold : [1, 1, 1, 0.25], 2, sel ? C.gold : C.text);
        p.hotspot(`spawn:${sp.id}`, px - 12, py - 12, 24, 24);
    }
    if (me && me.alive) {
        const [px, py] = S(me.pos[0], me.pos[2]);
        p.rect(px - 4, py - 4, 8, 8, C.gold);
        p.rect(px + Math.sin(me.yaw) * 8 - 1.5, py + Math.cos(me.yaw) * 8 - 1.5, 3, 3, C.gold);
    }
}

// --- the battle HUD ----------------------------------------------------------------------------------

export interface HudExtra {
    hitMarker: number; killMarker: number; headMarker: number; hurt: number; toasts: { text: string; age: number; color: Color }[]; banner: { title: string; text: string; age: number } | null; device: string;
    /** Aiming down sights (held), how far in (0..1), the sight (iron, dot, holo, scope, launcher) and its zoom. */
    ads: boolean; adsT: number; sight: string; spread: number; zoom: number;
    scoreboard: boolean; mapOpen: boolean; showHelp: boolean; fps: number; lockHint: boolean; point: string;
    /** A guided launcher's lock: the target on screen (px), the box's half size, progress 0..1. */
    lock: { x: number; y: number; r: number; p: number; locked: boolean } | null;
    /** "[E] ENTER ..." under the crosshair; a warning (no ammo, unbraced, low ammo); reload progress (-1: none); holding breath. */
    prompt: string; hint: string; reloadP: number; steady: boolean;
}

/** A ring of `n` small squares (the painter has no circles). */
function ring(p: Painter, cx: number, cy: number, r: number, size: number, c: Color, n = 24): void {
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; p.rect(cx + Math.cos(a) * r - size / 2, cy + Math.sin(a) * r - size / 2, size, size, c); }
}

/** Looking through a magnified optic: the round field of view in black, a lens shadow, the reticle (a red
 * chevron in the 2x, mil-dots in the 4x and 8x), the magnification. */
function drawScope(p: Painter, w: number, h: number, zoom: number, steady: boolean): void {
    const R = h * (zoom < 3 ? 0.47 : zoom < 6 ? 0.44 : 0.41), dark: Color = [0, 0, 0, 0.96], strips = 72, cx = w / 2, cy = h / 2;
    p.rect(0, 0, cx - R, h, dark); p.rect(cx + R, 0, cx - R, h, dark);
    p.rect(cx - R, 0, 2 * R, cy - R, dark); p.rect(cx - R, cy + R, 2 * R, cy - R, dark);
    for (let i = 0; i < strips; i++) {
        const y0 = cy - R + (i * 2 * R) / strips, yc = y0 + R / strips - cy;
        const half = Math.sqrt(Math.max(0, R * R - yc * yc));
        p.rect(cx - R, y0, R - half, (2 * R) / strips + 1, dark); p.rect(cx + half, y0, R - half, (2 * R) / strips + 1, dark);
    }
    const line: Color = [0, 0, 0, 0.9];
    if (zoom < 3) {
        // A combat optic: a red chevron over a thin post.
        for (let i = 0; i < 6; i++) { p.rect(cx - i * 1.6 - 1, cy + i * 2, 2.4, 2.4, [1, 0.2, 0.12, 1]); p.rect(cx + i * 1.6 - 1, cy + i * 2, 2.4, 2.4, [1, 0.2, 0.12, 1]); }
        p.rect(cx - 1, cy + 14, 2, R - 14, line);
        p.rect(cx - R, cy - 1, R * 0.6, 2, line); p.rect(cx + R * 0.4, cy - 1, R * 0.6, 2, line);
    } else {
        // Mil-dots on a fine crosshair, heavy posts toward the rim.
        p.rect(cx - R * 0.5, cy - 0.5, R, 1, line); p.rect(cx - 0.5, cy - R * 0.5, 1, R, line);
        p.rect(cx - R, cy - 2, R * 0.5, 4, line); p.rect(cx + R * 0.5, cy - 2, R * 0.5, 4, line);
        p.rect(cx - 2, cy + R * 0.5, 4, R * 0.5, line); p.rect(cx - 2, cy - R, 4, R * 0.5, line);
        for (let i = 1; i <= 4; i++) { const d = i * R * 0.1; for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) p.rect(cx + dx - 2, cy + dy - 2, 4, 4, line); }
        p.rect(cx - 1.5, cy - 1.5, 3, 3, [1, 0.2, 0.12, 0.9]);
    }
    p.textC(`${zoom}x`, cx + R * 0.72, cy + R * 0.62, 12, [0.8, 0.8, 0.75, 0.8], H);
    if (!steady && zoom >= 4) p.textC("SHIFT / L3  hold breath", cx, cy + R * 0.8, 11, [0.8, 0.8, 0.75, 0.55], B);
}

export function drawHud(p: Painter, w: number, h: number, b: Battle, me: Soldier, x: HudExtra): void {
    // Tickets and territories (top center).
    const cx = w / 2;
    p.rect(cx - 260, 10, 520, 34, [0, 0, 0, 0.55]);
    p.text(TEAM_SHORT[0], cx - 250, 15, 13, C.team[0], H);
    p.text(String(b.tickets[0]), cx - 150, 12, 24, C.text, N);
    p.text(String(b.tickets[1]), cx + 110, 12, 24, C.text, N);
    p.textR(TEAM_SHORT[1], cx + 250, 15, 13, C.team[1], H);
    const tw = Math.min(26, 200 / b.territories.length);
    b.territories.forEach((t, i) => {
        const tx = cx - (b.territories.length * tw) / 2 + i * tw;
        p.rect(tx + 1, 16, tw - 2, 22, [...tc(t.owner).slice(0, 3), 0.75] as Color, t.contested ? 2 : 0, C.gold);
        p.text(String.fromCharCode(65 + i), tx + tw / 2 - 5, 18, 12, [0, 0, 0, 1], H);
    });
    // The territory we stand in: capture progress.
    const here = b.territories.find(t => Math.hypot(t.def.x - me.pos[0], t.def.z - me.pos[2]) < t.def.radius);
    if (here) {
        const prog = me.team === 0 ? (here.progress + 1) / 2 : (1 - here.progress) / 2;
        p.rect(cx - 160, 52, 320, 30, [0, 0, 0, 0.55]);
        p.text(`${String.fromCharCode(65 + b.territories.indexOf(here))}  ${here.def.name.toUpperCase()}`, cx - 150, 54, 12, here.contested ? C.gold : C.text, H);
        p.bar(cx - 150, 72, 300, 6, prog, C.team[me.team]);
        p.textR(`${here.counts[me.team]} v ${here.counts[1 - me.team]}`, cx + 150, 54, 12, C.dim, N);
    }
    // Crosshair: the hip crosshair (spread as four ticks) fades out as the sights come up and the sight's
    // own reticle fades in; a scope picture for magnified optics. Then hit/kill markers, reload, lock.
    if (me.vehicle < 0 && !x.mapOpen) {
        const cx = w / 2, cy = h / 2, a = x.ads ? x.adsT : x.adsT * 0.5;
        if (x.ads && x.sight === "scope" && x.adsT > 0.85) drawScope(p, w, h, x.zoom, x.steady);
        if (a < 0.9) {
            const g = Math.max(4, x.spread), col: Color = [1, 1, 1, 0.85 * (1 - a)];
            p.rect(cx - 1, cy - g - 8, 2, 8, col); p.rect(cx - 1, cy + g, 2, 8, col);
            p.rect(cx - g - 8, cy - 1, 8, 2, col); p.rect(cx + g, cy - 1, 8, 2, col);
            p.rect(cx - 1, cy - 1, 2, 2, [1, 0.4, 0.2, 0.9 * (1 - a)]);
        }
        if (a > 0.3 && x.sight !== "scope") {
            const k = Math.min(1, (a - 0.3) / 0.5);
            if (x.sight === "dot") { p.rect(cx - 3, cy - 3, 6, 6, [1, 0.2, 0.1, 0.25 * k]); p.rect(cx - 2, cy - 2, 4, 4, [1, 0.15, 0.1, k]); }
            else if (x.sight === "holo") { ring(p, cx, cy, 14, 2, [1, 0.25, 0.15, 0.85 * k], 28); p.rect(cx - 1.5, cy - 1.5, 3, 3, [1, 0.2, 0.1, k]); }
            else if (x.sight === "launcher") {
                // Range ladder: a chevron for the aim point, ticks below for 100, 200 and 300 m.
                const c: Color = [0.4, 1, 0.5, 0.9 * k];
                p.rect(cx - 12, cy - 1, 8, 2, c); p.rect(cx + 4, cy - 1, 8, 2, c); p.rect(cx - 1, cy + 4, 2, 6, c);
                [1, 2, 3].forEach(i => { p.rect(cx - 6 - i * 2, cy + 10 + i * 12, 12 + i * 4, 1.5, c); p.text(`${i}00`, cx + 12 + i * 2, cy + 4 + i * 12, 9, c, B); });
            } else p.rect(cx - 1, cy - 1, 2, 2, [1, 1, 1, 0.35 * k]);
        }
        const mark = (t: number, c: Color, s: number) => { const al = Math.min(1, t * 4); for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { p.rect(cx + dx * s - 3, cy + dy * s - 3, 6, 6, [...c.slice(0, 3), al] as Color); p.rect(cx + dx * (s + 5) - 2, cy + dy * (s + 5) - 2, 4, 4, [...c.slice(0, 3), al * 0.8] as Color); } };
        if (x.killMarker > 0) mark(x.killMarker, x.headMarker > 0 ? C.gold : C.red, 11);
        else if (x.hitMarker > 0) mark(x.hitMarker, [1, 1, 1, 1], 9);
        if (x.reloadP >= 0) { p.rect(cx - 31, cy + 27, 62, 6, [0, 0, 0, 0.5]); p.rect(cx - 30, cy + 28, 60 * x.reloadP, 4, C.warn); }
        if (x.lock) {
            const { r } = x.lock, blink = x.lock.locked || Math.floor(Date.now() / 150) % 2 === 0;
            const c: Color = x.lock.locked ? C.red : [1, 0.75, 0.2, blink ? 1 : 0.4];
            const s = r * (1.6 - 0.6 * x.lock.p), L = Math.max(6, s * 0.4);
            for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { p.rect(x.lock.x + sx * s - (sx > 0 ? L : 0), x.lock.y + sy * s - 1, L, 2, c); p.rect(x.lock.x + sx * s - 1, x.lock.y + sy * s - (sy > 0 ? L : 0), 2, L, c); }
            p.textC(x.lock.locked ? "LOCKED" : "LOCKING", x.lock.x, x.lock.y + s + 6, 11, c, H);
        }
        if (x.prompt) { const tw = textWidth(x.prompt, 13, H) + 24; p.rect(cx - tw / 2, cy + 60, tw, 24, [0, 0, 0, 0.55]); p.textC(x.prompt, cx, cy + 64, 13, C.text, H); }
        if (x.hint) p.textC(x.hint, cx, cy + 92, 13, x.hint.startsWith("LOW") ? C.warn : C.red, H);
    } else if (me.vehicle >= 0) {
        p.rect(w / 2 - 14, h / 2 - 1, 28, 2, [1, 1, 1, 0.8]); p.rect(w / 2 - 1, h / 2 - 14, 2, 28, [1, 1, 1, 0.8]);
    }
    // Health and stance (bottom left).
    p.rect(20, h - 92, 300, 72, [0, 0, 0, 0.55]);
    p.text("HEALTH", 32, h - 86, 11, C.dim, H);
    p.bar(32, h - 66, 200, 12, me.hp / BALANCE.soldierHp, me.hp < 35 ? C.red : C.good);
    p.text(String(Math.max(0, Math.round(me.hp))), 244, h - 74, 22, C.text, N);
    p.text(`${me.stance.toUpperCase()}   ${Math.round(me.stats.speedShare * 100)}% SPEED   ${me.stats.weight} KG`, 32, h - 46, 11, C.dim, B);
    // Weapon and ammo (bottom right).
    if (me.vehicle < 0) {
        const wpn = b.weaponOf(me), size = Math.max(1, b.magSize(me, me.slot)), mag = me.mag[me.slot];
        p.rect(w - 330, h - 96, 310, 76, [0, 0, 0, 0.55]);
        p.text(wpn.name, w - 318, h - 90, 13, C.text, H);
        p.textR(`${me.slot.toUpperCase()}  ${wpn.action.toUpperCase()}${x.ads ? `  ${x.zoom}x` : ""}`, w - 30, h - 89, 10, C.dim, H);
        p.text(`${mag}`, w - 318, h - 72, 30, mag === 0 ? C.red : mag <= size * 0.25 && size > 3 ? C.warn : C.text, N);
        p.text(`/ ${me.reserve[me.slot]}`, w - 318 + textWidth(String(mag), 30, N) + 14, h - 62, 16, C.dim, N);
        // The magazine as pips (up to 40 rounds), else a bar.
        if (size <= 40) { const pw = Math.min(8, 190 / size); for (let i = 0; i < size; i++) p.rect(w - 318 + i * pw, h - 32, Math.max(1, pw - 2), 6, i < mag ? C.text : [1, 1, 1, 0.15]); }
        else p.bar(w - 318, h - 32, 190, 6, mag / size, C.text);
        p.textR(`GRENADES ${me.grenades}`, w - 30, h - 68, 11, C.dim, H);
        const eq = me.equipment.find(e => e.left > 0);
        p.textR(eq ? `[F] ${EQUIP.get(eq.id)!.name} x${eq.left}` : "[F] -", w - 30, h - 50, 11, C.dim, B);
        if (me.reloadUntil > 0) p.textC("RELOADING", w / 2, h / 2 + 40, 13, C.warn, H);
    } else {
        const v = b.vehicles[me.vehicle];
        p.rect(w - 330, h - 112, 310, 92, [0, 0, 0, 0.55]);
        p.text(v.def.name.toUpperCase(), w - 318, h - 106, 13, C.text, H);
        p.bar(w - 318, h - 84, 220, 10, v.hp / v.def.hp, v.hp < v.def.hp * 0.3 ? C.red : C.good);
        p.text(`${Math.round(v.hp)}`, w - 90, h - 90, 16, C.text, N);
        const gi = Math.max(0, v.def.guns.findIndex(g => g.seat === me.seat || (me.seat === 0 && g.seat === 0)));
        const g = v.def.guns[gi];
        p.text(g ? `${g.name}  ${v.ammo[gi]}` : "No weapon at this seat", w - 318, h - 66, 13, C.text, B);
        p.text(`SEAT ${me.seat + 1}/${v.seats.length}   ${Math.round(Math.abs(v.speed) * 3.6)} KM/H${v.def.domain === "Air" ? `   ALT ${Math.round(v.pos[1] - b.world.height(v.pos[0], v.pos[2]))} M` : ""}   CM ${v.countermeasures}`, w - 318, h - 44, 11, C.dim, B);
        if (v.empUntil > b.time) p.textC("EMP: SYSTEMS DOWN", w / 2, h / 2 + 40, 14, C.red, H);
        if (v.payload) p.textC("[G] DROP PAYLOAD", w / 2, h / 2 + 60, 14, C.gold, H);
    }
    // Minimap (top right).
    if (!x.mapOpen) drawMap(p, b, me, w - 220, 12, 200);
    // Killfeed (under the minimap).
    let ky = 222;
    for (const k of b.killfeed.slice(-5)) {
        if (b.time - k.at > 8) continue;
        const kl = k.killer >= 0 ? b.soldiers[k.killer] : null, vi = b.soldiers[k.victim];
        const s = `${kl ? kl.name : "-"}  [${k.weapon}${k.head ? " HS" : ""}]  ${vi.name}`;
        p.textR(s, w - 20, ky, 12, kl && kl.id === me.id ? C.gold : vi.id === me.id ? C.red : C.text, B);
        ky += 18;
    }
    // Squad panel (left).
    const sq = b.squads[me.squad];
    p.rect(20, 120, 250, 32 + sq.members.length * 18, [0, 0, 0, 0.5]);
    p.text(`SQUAD ${me.squad + 1}  ${sq.mode.toUpperCase()}`, 30, 126, 12, C.text, H);
    p.textR(sq.call ? `CALLED ${Math.max(0, Math.round(sq.call.until - b.time))}s` : `OBJ ${sq.objective ? String.fromCharCode(65 + b.territories.findIndex(t => t.def.id === sq.objective)) : "-"}`, 262, 127, 11, sq.call ? C.good : C.dim, H);
    sq.members.forEach((id, i) => {
        const m = b.soldiers[id];
        const col: Color = !m.alive ? [0.5, 0.3, 0.3, 1] : m.id === me.id ? C.gold : C.text;
        p.text(`${m.role.slice(0, 4).toUpperCase()}  ${m.name}`, 30, 146 + i * 18, 11, col, B);
        if (m.alive) p.bar(208, 151 + i * 18, 50, 5, m.hp / 100, m.vehicle >= 0 ? C.team[me.team] : C.good);
    });
    // Rewards bar, streak and underdog meter (bottom center).
    const rx = w / 2 - 230;
    p.rect(rx, h - 70, 460, 52, [0, 0, 0, 0.5]);
    p.text(`STREAK ${me.streak}`, rx + 10, h - 66, 12, C.gold, H);
    const next = KILLSTREAKS.find(r => r.requirement > me.streak);
    p.text(next ? `next: ${next.name} at ${next.requirement}` : "max streak", rx + 100, h - 65, 11, C.dim, B);
    p.text("UNDERDOG", rx + 290, h - 66, 11, C.dim, H);
    p.bar(rx + 370, h - 62, 80, 6, me.underdogTime / BALANCE.underdogSeconds, [0.6, 0.8, 1, 1]);
    me.rewards.slice(0, 5).forEach((r, i) => {
        const d = REWARD.get(r)!;
        p.rect(rx + 10 + i * 89, h - 46, 85, 22, d.type === "Underdog" ? [0.15, 0.3, 0.45, 0.9] : [0.45, 0.25, 0.08, 0.9]);
        p.text(`[${i + 5}] ${d.name}`, rx + 14 + i * 89, h - 43, 10, C.text, B, 80);
    });
    // Toasts and the banner.
    x.toasts.forEach((t, i) => p.textC(t.text, w / 2, h * 0.3 + i * 24, 15, [...t.color.slice(0, 3), Math.min(1, 4 - t.age)] as Color, H));
    if (x.banner) { const a = Math.min(1, x.banner.age * 2, (6 - x.banner.age) * 0.8); p.textC(x.banner.title, w / 2, h * 0.16, 30, [1, 0.8, 0.4, a], H); p.textC(x.banner.text, w / 2, h * 0.16 + 44, 14, [1, 1, 1, a], B); }
    if (x.lockHint) p.textC("Click to lock the mouse for aiming (Esc releases it)", w / 2, h - 110, 12, C.dim, B);
    if (x.showHelp) drawHelp(p, w, h, x.device === "pad");
    if (x.scoreboard) drawScoreboard(p, w, h, b, me);
    if (x.mapOpen) drawMap(p, b, me, w / 2 - Math.min(h, w) * 0.4, h / 2 - Math.min(h, w) * 0.4, Math.min(h, w) * 0.8, { full: true });
}

function drawHelp(p: Painter, w: number, h: number, pad: boolean): void {
    const lines = pad ? [
        "LEFT STICK move   RIGHT STICK look   RT fire   LT aim   L3 sprint   A jump   B crouch   D-PAD DOWN prone",
        "X reload   Y switch weapon (near a vehicle or crate: enter / exit, resupply)   LB grenade   RB equipment   D-PAD UP enter / exit",
        "D-PAD LEFT call your squad   D-PAD RIGHT use a reward   R3 third person   BACK map   START deploy screen",
        "Vehicles: left stick throttle and steer, A/B climb and descend (aircraft), right stick aims, RT fires",
    ] : [
        "WASD move   SHIFT sprint   SPACE jump   C crouch   Z prone   MOUSE look   LMB fire   RMB aim",
        "R reload   1 primary  2 sidearm  3 launcher / UGL   G grenade   F equipment   E enter / exit vehicle, resupply   SHIFT aimed: hold breath",
        "Q call your squad to the crosshair   5-9 use a reward at the crosshair   TAB scoreboard   M map   [ ] look speed   H help",
        "Vehicles: W/S throttle, A/D steer, SPACE/CTRL climb and descend (aircraft), mouse aims the gun, LMB fires",
    ];
    p.rect(w / 2 - 430, h * 0.62, 860, lines.length * 22 + 16, [0, 0, 0, 0.65]);
    lines.forEach((l, i) => p.textC(l, w / 2, h * 0.62 + 8 + i * 22, 12, C.text, B));
}

export function drawScoreboard(p: Painter, w: number, h: number, b: Battle, me: Soldier): void {
    const x0 = w * 0.08, cw = (w * 0.84 - 20) / 2;
    p.rect(x0 - 10, 70, w * 0.84 + 20, h - 140, [0, 0, 0, 0.82]);
    ([0, 1] as Team[]).forEach(t => {
        const x = x0 + t * (cw + 20);
        p.text(`${TEAM_NAMES[t].toUpperCase()}   ${b.tickets[t]} TICKETS   ${b.holdings(t)} TERRITORIES`, x, 80, 13, C.team[t], H);
        p.text("NAME                          SCORE   K    D   STREAK", x, 104, 11, C.dim, B);
        const board = b.leaderboard(t);
        const rows = Math.floor((h - 230) / 17);
        const meIdx = board.findIndex(s => s.id === me.id);
        const shown = board.slice(0, rows);
        if (meIdx >= rows) shown[rows - 1] = board[meIdx];
        shown.forEach((s, i) => {
            const y = 122 + i * 17, rank = board.indexOf(s) + 1;
            const bottom = rank > board.length * (1 - BALANCE.underdogShare);
            p.text(`${String(rank).padStart(3)}  ${s.name.padEnd(22).slice(0, 22)}`, x, y, 11, s.id === me.id ? C.gold : s.alive ? C.text : C.dim, B);
            p.text(`${String(s.score).padStart(6)}  ${String(s.kills).padStart(3)}  ${String(s.deaths).padStart(3)}  ${String(s.best).padStart(3)}${bottom ? "  U" : ""}`, x + cw * 0.55, y, 11, s.id === me.id ? C.gold : C.text, N);
        });
    });
    p.text("U: bottom quarter of the leaderboard - time there earns underdog rewards", x0, h - 92, 11, C.dim, B);
}

export function drawDeploy(p: Painter, w: number, h: number, b: Battle, me: Soldier, selected: string, wait: number, loadoutName: string): void {
    p.rect(0, 0, w, h, [0.02, 0.025, 0.03, 0.7]);
    const size = Math.min(h - 160, w * 0.55);
    const mx = 40, my = 80;
    header(p, mx, 24, size, me.deaths ? `DEPLOY  -  ${me.deaths} DEATHS` : "DEPLOY");
    const spawns = b.spawnOptions(me);
    drawMap(p, b, me, mx, my, size, { spawns, selected, full: true });
    const px = mx + size + 30, pw = w - px - 40;
    frame(p, px, my, pw, size);
    p.text("SPAWN POINT", px + 14, my + 12, 13, C.dim, H);
    spawns.slice(0, 16).forEach((s, i) => p.button(`spawn:${s.id}`, px + 14, my + 36 + i * 32, pw - 28, 28, s.label.toUpperCase(), "dark", { size: 11, active: s.id === selected }));
    p.text(`LOADOUT: ${loadoutName}`, px + 14, my + size - 92, 13, C.text, H);
    p.button("armory", px + 14, my + size - 66, 150, 34, "ARMORY", "ghost", { size: 12 });
    p.button("deploy", px + 180, my + size - 66, pw - 194, 34, wait > 0 ? `DEPLOY IN ${wait.toFixed(1)}` : "DEPLOY", wait > 0 ? "dark" : "red", { size: 14, disabled: wait > 0 });
    p.text(`${TEAM_NAMES[me.team]}  -  ${b.tickets[me.team]} tickets left   /   ${b.world.def.name}`, mx, h - 40, 12, C.dim, B);
}

export function drawDebrief(p: Painter, w: number, h: number, b: Battle, me: Soldier | null): void {
    p.rect(0, 0, w, h, [0.02, 0.02, 0.025, 0.85]);
    const won = me && b.winner === me.team;
    p.textC(b.winner === -1 ? "BATTLE OVER" : won ? "VICTORY" : me ? "DEFEAT" : `${TEAM_NAMES[b.winner as Team].toUpperCase()} WINS`, w / 2, h * 0.14, 56, won ? C.gold : C.red, H);
    p.textC(`${b.world.def.name}  -  ${Math.floor(b.time / 60)}:${String(Math.floor(b.time % 60)).padStart(2, "0")}  -  tickets ${b.tickets[0]} : ${b.tickets[1]}`, w / 2, h * 0.14 + 76, 16, C.text, B);
    if (me) {
        const rank = b.leaderboard(me.team).findIndex(s => s.id === me.id) + 1;
        const lines = [`Score ${me.score}  (rank ${rank} of ${b.leaderboard(me.team).length})`, `Kills ${me.kills}   Deaths ${me.deaths}   Best streak ${me.best}   Captures ${me.captures}   Vehicles ${me.vehicleKills}`];
        lines.forEach((l, i) => p.textC(l, w / 2, h * 0.32 + i * 30, 18, C.text, B));
    }
    const s = b.stats;
    p.textC(`${s.kills} soldiers fell, ${s.vehicleKills} vehicles destroyed, ${s.captures} territories changed hands, ${s.rewardsUsed} rewards called in.`, w / 2, h * 0.46, 14, C.dim, B);
    p.textC(`${b.wirStats.decisions.toLocaleString("en-US")} WIR decisions.`, w / 2, h * 0.46 + 26, 14, C.dim, B);
    p.button("again", w / 2 - 220, h * 0.62, 200, 50, "AGAIN", "red", { size: 18 });
    p.button("title", w / 2 + 20, h * 0.62, 200, 50, "TITLE", "dark", { size: 16 });
}

export { ROLES };
