// Armageddon 2070's scene: turns the battle into instanced draws. Static scenery is packed into
// chunk batches once (and again when cover is destroyed); grass is scattered around the camera;
// soldiers, vehicles, mecha, projectiles and effects are packed every frame.

import { Renderer } from "./ar_render";
import { LIT, MAT, BODY, CARD, GLOW } from "./ar_shader";
import { yawed, placed, aligned, between, at, type Mat4 } from "../world_of_music/wom_render";
import { HALF, GROUND, TN, TERRAIN_STEP, type World, type Box } from "./ar_map";
import { Rng, clamp, type V3 } from "../nebula/nk_math";
import type { Battle, Soldier, VehicleState, Team } from "./ar_sim";

export type RGB = [number, number, number];
export const TEAM_COLOR: [RGB, RGB] = [[0.3, 0.75, 1.0], [1.0, 0.45, 0.12]];
const CLOTH: [RGB, RGB] = [[0.33, 0.37, 0.4], [0.47, 0.38, 0.28]];
const PLATE: [RGB, RGB] = [[0.24, 0.27, 0.31], [0.34, 0.26, 0.2]];
const HULL: [RGB, RGB] = [[0.36, 0.4, 0.42], [0.5, 0.42, 0.3]];
const SKIN: RGB[] = [[0.78, 0.6, 0.48], [0.55, 0.38, 0.27], [0.86, 0.7, 0.58], [0.4, 0.28, 0.2]];

const MAT_COLOR: Record<string, RGB> = {
    concrete: [0.62, 0.6, 0.56], brick: [0.6, 0.33, 0.24], adobe: [0.68, 0.55, 0.4], metal: [0.45, 0.47, 0.48], container: [0.5, 0.5, 0.5],
    sandbag: [0.62, 0.55, 0.4], rock: [0.5, 0.48, 0.45], wood: [0.45, 0.33, 0.22], glass: [0.15, 0.25, 0.2], barrier: [0.68, 0.67, 0.63],
    rubble: [0.52, 0.5, 0.46], hesco: [0.6, 0.55, 0.42], pipe: [0.5, 0.48, 0.42], wreck: [0.35, 0.3, 0.26], dome: [0.78, 0.78, 0.76], plaster: [0.78, 0.74, 0.66],
};
const CONTAINER: RGB[] = [[0.62, 0.18, 0.12], [0.15, 0.35, 0.55], [0.2, 0.45, 0.3], [0.7, 0.55, 0.15], [0.55, 0.55, 0.55], [0.4, 0.2, 0.45], [0.75, 0.38, 0.12], [0.2, 0.25, 0.3]];
const FOLIAGE: Record<string, { card: number; color: RGB }> = {
    bush: { card: CARD.bush, color: [0.33, 0.4, 0.2] }, tree: { card: CARD.broadleaf, color: [0.3, 0.38, 0.18] }, pine: { card: CARD.pine, color: [0.18, 0.28, 0.16] },
    palm: { card: CARD.palm, color: [0.38, 0.42, 0.2] }, dead: { card: CARD.dead, color: [0.32, 0.26, 0.2] }, reed: { card: CARD.reed, color: [0.55, 0.52, 0.3] },
};

// --- static scenery ---------------------------------------------------------------------------------

/** Packs every box and plant into chunk batches (128 m chunks, so the engine culls by bounds). */
export function packStatics(r: Renderer, w: World): void {
    r.statics.begin();
    const chunk = (x: number, z: number) => `${Math.floor((x + HALF) / 128)}_${Math.floor((z + HALF) / 128)}`;
    for (const b of w.boxes) packBox(r, b, chunk(b.x, b.z));
    for (const f of w.foliage) {
        const d = FOLIAGE[f.kind];
        const tint = 0.85 + f.seed * 0.3;
        const wdt = f.kind === "bush" || f.kind === "reed" ? f.size * 0.75 : f.size * (f.kind === "pine" ? 0.32 : f.kind === "palm" ? 0.45 : 0.5);
        r.put(r.statics, `quad|${chunk(f.x, f.z)}`, placed([f.x, f.y - 0.1, f.z], wdt, f.size, 1), [d.color[0] * tint, d.color[1] * tint, d.color[2] * tint, 1], [LIT.card, f.seed * 97, 0, 0], [0, d.card, 0, 0], [f.x, f.y + f.size / 2, f.z, f.size]);
    }
    r.statics.flush();
}

function packBox(r: Renderer, b: Box, chunk: string): void {
    if (b.kind === "deco" && b.h < 0.31 && b.hp !== undefined) {
        // Destroyed cover leaves a flat pile.
        r.put(r.statics, `box|${chunk}`, yawed([b.x, b.y, b.z], b.yaw, b.hx, 0.25, b.hz), [...MAT_COLOR.rubble, 1], [LIT.prop, b.seed, 0, 0], [0, MAT.rubble, 0, 0], [b.x, b.y, b.z, Math.max(b.hx, b.hz)]);
        return;
    }
    let color = MAT_COLOR[b.mat] ?? [0.6, 0.6, 0.6];
    if (b.mat === "container") color = CONTAINER[b.tint % CONTAINER.length];
    if (b.mat === "wreck") color = CONTAINER[b.tint % CONTAINER.length].map(c => c * 0.6) as RGB;
    if (b.mat === "dome" && b.tint) color = [0.7, 0.72, 0.74];
    const v = 0.92 + (b.seed % 13) / 80;
    const col = [color[0] * v, color[1] * v, color[2] * v, 1];
    const sphere = [b.x, b.y + b.h / 2, b.z, Math.hypot(b.hx, b.hz, b.h)];
    const m = MAT[b.mat] ?? 0;
    if (b.mat === "rock") r.put(r.statics, `rock|${chunk}`, yawed([b.x, b.y + b.h * 0.45, b.z], b.yaw, b.hx, b.h * 0.55, b.hz), col, [LIT.prop, b.seed, 0, 0], [0, m, 0, 0], sphere);
    else if (b.mat === "dome") {
        // Round tanks and reactor domes: a cylinder with a dome cap.
        const capH = Math.min(b.hx, b.h * 0.4);
        r.put(r.statics, `cyl|${chunk}`, yawed([b.x, b.y, b.z], 0, b.hx, b.h - capH, b.hz), col, [LIT.prop, b.seed, 0, 0], [0, m, 0, 0], sphere);
        r.put(r.statics, `dome|${chunk}`, yawed([b.x, b.y + b.h - capH, b.z], 0, b.hx, capH, b.hz), col, [LIT.prop, b.seed, 0, 0], [0, m, 0, 0], sphere);
    } else r.put(r.statics, `box|${chunk}`, yawed([b.x, b.y, b.z], b.yaw, b.hx, b.h, b.hz), col, [LIT.prop, b.seed, 0, 0], [0, m, 0, 0], sphere);
}

/** Grass tufts in the 32 m chunks around the camera (rebuilt when the camera changes chunk). */
export function packGrass(r: Renderer, w: World, cam: V3, radius = 96): void {
    r.grass.begin();
    const c0 = Math.floor((cam[0] + HALF) / 32), c1 = Math.floor((cam[2] + HALF) / 32), n = Math.ceil(radius / 32);
    const biome = w.def.biome;
    const base: RGB = biome === "coast" ? [0.58, 0.54, 0.34] : biome === "mountain" ? [0.36, 0.44, 0.2] : biome === "industrial" ? [0.45, 0.46, 0.3] : [0.4, 0.46, 0.22];
    for (let cj = c1 - n; cj <= c1 + n; cj++) for (let ci = c0 - n; ci <= c0 + n; ci++) {
        if (ci < 0 || cj < 0 || ci >= 32 || cj >= 32) continue;
        const rng = new Rng(ci * 7919 + cj * 104729 + w.def.seed);
        for (let k = 0; k < 140; k++) {
            const x = ci * 32 - HALF + rng.next() * 32, z = cj * 32 - HALF + rng.next() * 32;
            const ti = Math.round((x + HALF) / TERRAIN_STEP), tj = Math.round((z + HALF) / TERRAIN_STEP);
            const g = w.ground[clamp(tj, 0, TN - 1) * TN + clamp(ti, 0, TN - 1)];
            if (g === GROUND.road || g === GROUND.concrete || g === GROUND.rock || g === GROUND.snow || g === GROUND.glass) continue;
            if (g === GROUND.sand && rng.next() < 0.7) continue;
            if (w.wet(x, z) || w.coverHeight(x, z) > 0.2) continue;
            const s = 0.35 + rng.next() * 0.45, tone = 0.8 + rng.next() * 0.35;
            r.put(r.grass, `quad|g${ci}_${cj}`, placed([x, w.height(x, z) - 0.05, z], s * 0.9, s, 1), [base[0] * tone, base[1] * tone, base[2] * tone, 1], [LIT.card, rng.next() * 97, 0, 0], [0, CARD.grass, 0, 0], [x, 0, z, 4]);
        }
    }
    r.grass.flush();
}

// --- soldiers -----------------------------------------------------------------------------------------

/** A soldier from boxes and spheres: legs and arms swing with speed; armor and exoskeletons show. */
export function drawSoldier(r: Renderer, s: Soldier, time: number, hitFlash: number, groundTint: RGB | null): void {
    const team = s.team, yaw = s.yaw;
    const moving = Math.hypot(s.vel[0], s.vel[2]);
    const phase = time * (moving > 5 ? 11 : 8) + s.id;
    const swing = Math.sin(phase) * Math.min(1, moving / 3) * 0.55;
    let cloth: RGB = CLOTH[team], plate: RGB = PLATE[team];
    if (s.loadout.armor.Finish && groundTint) { const k = s.loadout.armor.Finish === "AR013" ? 0.75 : 0.45; cloth = mix3(cloth, groundTint, k); plate = mix3(plate, groundTint, k * 0.8); }
    const glow = TEAM_COLOR[team];
    const flash = hitFlash;
    const p = s.pos;
    const B = (o: V3, sx: number, sy: number, sz: number, color: RGB, part: number, mesh = "cube") => r.solid(mesh, yawed(at(p, yaw, o), yaw, sx, sy, sz), [...color, 1], [LIT.body, s.id, flash, 0], [3, part, 0, 0]);
    const heavy = s.stats.torso > 0.5, exo = !!s.loadout.armor.Exoskeleton;
    if (s.stance === "prone") {
        const m = aligned([p[0], p[1] + 0.22, p[2]], [0, 1, 0], yaw, 0.22, 0.16, 0.85);
        r.solid("cube", m, [...cloth, 1], [LIT.body, s.id, flash, 0], [3, BODY.cloth, 0, 0]);
        r.solid("sphere-1", placed(at(p, yaw, [0, 0.3, 0.95]), 0.16), [...plate, 1], [LIT.body, s.id, flash, 0], [3, BODY.plate, 0, 0]);
        B([0.12, 0.3, 1.35], 0.04, 0.05, 0.5, [0.1, 0.1, 0.1], BODY.gun);
        return;
    }
    const crouch = s.stance === "crouch";
    const hip = crouch ? 0.62 : 0.92, legLen = hip;
    // Legs (thigh+shin as one box each), swinging about the hip.
    for (const side of [-1, 1]) {
        const a = swing * side;
        const foot = at(p, yaw, [side * 0.13, crouch ? 0.25 : 0.0, Math.sin(a) * 0.5 + (crouch ? 0.25 * side : 0)]);
        const hipP = at(p, yaw, [side * 0.13, hip, 0]);
        r.solid("cyl", between(foot, hipP, 0.085), [...cloth, 1], [LIT.body, s.id, flash, 0], [3, BODY.cloth, 0, 0]);
        r.solid("cube", yawed(at(p, yaw, [side * 0.13, 0.05, Math.sin(a) * 0.5 * (crouch ? 0 : 1) + 0.05]), yaw, 0.07, 0.05, 0.13), [0.12, 0.11, 0.1, 1], [LIT.body, 0, 0, 0], [0, BODY.rubber, 0, 0]);
        if (s.loadout.armor.Legs) r.solid("cube", yawed(at(p, yaw, [side * 0.13, hip * 0.45, 0.07 + Math.sin(a) * 0.15]), yaw, 0.08, 0.13, 0.04), [...plate, 1], [LIT.body, s.id, flash, 0], [2, BODY.plate, 0, 0]);
        if (exo) r.solid("cyl", between(at(p, yaw, [side * 0.2, 0.08, -0.05]), at(p, yaw, [side * 0.2, hip + 0.4, -0.12]), 0.025), [0.22, 0.22, 0.24, 1], [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]);
        void legLen;
    }
    const torsoY = hip + 0.32;
    const lean = crouch ? 0.25 : 0.05;
    const chest = at(p, yaw, [0, torsoY, lean * 0.3]);
    r.solid("cube", aligned(chest, norm3([Math.sin(yaw) * lean, 1, Math.cos(yaw) * lean]), yaw, 0.21 * (heavy ? 1.12 : 1), 0.3, 0.13), [...cloth, 1], [LIT.body, s.id, flash, 0], [3, BODY.cloth, 0, 0]);
    // Plate carrier, backpack.
    if (s.loadout.armor.Chest) r.solid("cube", yawed(at(p, yaw, [0, torsoY + 0.04, 0.12 + lean * 0.3]), yaw, heavy ? 0.22 : 0.18, heavy ? 0.24 : 0.2, heavy ? 0.06 : 0.04), [...plate, 1], [LIT.body, s.id, flash, 0], [2, BODY.plate, 0, 0]);
    r.solid("cube", yawed(at(p, yaw, [0, torsoY + 0.05, -0.17]), yaw, 0.15, 0.2, 0.08), [...cloth.map(c => c * 0.85) as RGB, 1], [LIT.body, s.id, flash, 0], [3, BODY.cloth, 0, 0]);
    if (s.loadout.armor.Utility === "AR010") r.solid("cube", yawed(at(p, yaw, [0, torsoY - 0.15, -0.22]), yaw, 0.26, 0.45, 0.03), [...mix3(cloth, [0.3, 0.3, 0.28], 0.5), 1], [LIT.body, s.id, flash, 0], [5, BODY.cloth, 0, 0]);
    // Team glow stripe on the shoulders.
    r.solid("cube", yawed(at(p, yaw, [0, torsoY + 0.29, 0]), yaw, 0.2, 0.012, 0.03), [...glow, 1], [LIT.body, 0, 0, 0], [0, BODY.visor, 0, 0]);
    if (s.loadout.armor.Shoulders) for (const side of [-1, 1]) r.solid("sphere-1", yawed(at(p, yaw, [side * 0.25, torsoY + 0.22, 0]), yaw, 0.1, 0.07, 0.1), [...plate, 1], [LIT.body, s.id, flash, 0], [2, BODY.plate, 0, 0]);
    // Head, helmet and visor.
    const head = at(p, yaw, [0, torsoY + 0.45, lean * 0.45]);
    r.solid("sphere-1", placed(head, 0.11), [...SKIN[s.id % SKIN.length], 1], [LIT.body, s.id, flash, 0], [0, BODY.skin, 0, 0]);
    const helm = s.loadout.armor.Helmet, hs = helm === "AR003" ? 0.145 : helm === "AR001" ? 0.122 : 0.135;
    if (helm) r.solid("sphere-1", yawed([head[0], head[1] + 0.04, head[2]], yaw, hs, hs * 0.75, hs * 1.05), [...plate, 1], [LIT.body, s.id, flash, 0], [2, BODY.plate, 0, 0]);
    r.solid("cube", yawed(at(p, yaw, [0, torsoY + 0.46, 0.1 + lean * 0.45]), yaw, 0.08, 0.025, 0.02), [...glow, 1], [LIT.body, 0, 0.2, 0], [0, BODY.visor, 0, 0]);
    // Arms holding the weapon forward, and the weapon itself (longer for rifles and launchers).
    const aimPitch = s.pitch;
    const gunLen = s.slot === "launcher" ? 0.65 : s.slot === "sidearm" ? 0.16 : s.loadout.primary === "W008" || s.loadout.primary === "W010" ? 0.62 : 0.45;
    const grip = at(p, yaw, [0.05, torsoY + 0.12, 0.32 + lean * 0.3]);
    const muzzle: V3 = [grip[0] + Math.sin(yaw) * Math.cos(aimPitch) * gunLen * 2, grip[1] + Math.sin(aimPitch) * gunLen * 2, grip[2] + Math.cos(yaw) * Math.cos(aimPitch) * gunLen * 2];
    for (const side of [-1, 1]) {
        const shoulder = at(p, yaw, [side * 0.25, torsoY + 0.2, 0]);
        const hand = side > 0 ? grip : lerp3(grip, muzzle, 0.45);
        r.solid("cyl", between(shoulder, hand, 0.06), [...cloth, 1], [LIT.body, s.id, flash, 0], [3, BODY.cloth, 0, 0]);
    }
    const gunColor: RGB = s.slot === "launcher" ? [0.3, 0.32, 0.25] : [0.1, 0.1, 0.1];
    r.solid("cyl", between(lerp3(grip, muzzle, -0.15), muzzle, s.slot === "launcher" ? 0.06 : 0.03), [...gunColor, 1], [LIT.body, 0, 0, 0], [0, BODY.gun, 0, 0]);
    void B;
}

// --- vehicles ---------------------------------------------------------------------------------------

/** A vehicle from boxes and cylinders: hull, wheels or tracks, turret and gun, rotors, wings. */
export function drawVehicle(r: Renderer, b: Battle, v: VehicleState, time: number, hitFlash: number): void {
    const team = v.team, def = v.def, p = v.pos, yaw = v.yaw;
    const [L, W, H] = def.dims;
    const hull: RGB = v.alive ? HULL[team] : [0.12, 0.11, 0.1];
    const glow = TEAM_COLOR[team];
    const params = [LIT.body, v.id, hitFlash, 0];
    const hullE = [1.2, BODY.hull, 0, 0];
    const up: V3 = [Math.sin(v.roll) * Math.cos(yaw) - Math.sin(v.pitch) * Math.sin(yaw) * -1, 1, -Math.sin(v.roll) * Math.sin(yaw) + Math.sin(v.pitch) * Math.cos(yaw)];
    const nup = norm3(up);
    const box = (o: V3, sx: number, sy: number, sz: number, color: RGB, part: number = BODY.hull, mesh = "cube", turnYaw = yaw) => r.solid(mesh, aligned(at(p, yaw, o), v.def.domain === "Ground" ? nup : [0, 1, 0], turnYaw, sx, sy, sz), [...color, 1], params, [part === BODY.hull ? 1.2 : 0, part, 0, 0]);
    if (v.mecha) { drawMecha(r, v, time, hitFlash); return; }
    if (def.domain === "Ground") {
        const tracked = def.size === "Heavy" || def.id === "V004" || def.id === "V007";
        const clear = tracked ? 0.45 : 0.55;
        box([0, clear + (H * 0.45) / 2, 0], W / 2 - 0.2, (H * 0.45) / 2, L / 2, hull);
        // Sloped glacis.
        box([0, clear + H * 0.38, L / 2 - 0.6], W / 2 - 0.25, 0.25, 0.6, hull);
        if (tracked) for (const side of [-1, 1]) {
            box([side * (W / 2 - 0.3), 0.5, 0], 0.32, 0.45, L / 2 - 0.1, [0.13, 0.13, 0.12], BODY.rubber);
            for (let k = 0; k < 6; k++) r.solid("cyl", aligned(at(p, yaw, [side * (W / 2 - 0.3), 0.45, -L / 2 + 0.7 + k * ((L - 1.4) / 5)]), [Math.cos(yaw) * side, 0, -Math.sin(yaw) * side], 0, 0.38, 0.3, 0.38), [0.2, 0.2, 0.19, 1], params, [0, BODY.gun, 0, 0]);
        } else for (const side of [-1, 1]) for (const k of def.id === "V009" || def.id === "V003" ? [-1, 0, 1] : [-1, 1]) {
            const wp = at(p, yaw, [side * (W / 2 - 0.1), 0.5, k * L * 0.32]);
            r.solid("cyl", aligned([wp[0] - Math.cos(yaw) * side * 0.15, wp[1], wp[2] + Math.sin(yaw) * side * 0.15], [Math.cos(yaw) * side, 0, -Math.sin(yaw) * side], 0, 0.5, 0.3, 0.5), [0.1, 0.1, 0.1, 1], params, [0, BODY.rubber, 0, 0]);
        }
        const deck = clear + H * 0.45;
        const tYaw = v.alive && v.target >= 0 ? v.turretYaw : v.turretYaw || yaw;
        if (def.id === "V005" || def.id === "V004" || def.id === "V007") {
            // Turret and gun(s), turned separately from the hull.
            const tc: V3 = [p[0], p[1] + deck + 0.4, p[2]];
            r.solid("cube", yawed(tc, tYaw, W * 0.32, 0.4, L * 0.22), [...hull, 1], params, [1.2, BODY.hull, 0, 0]);
            const barrel = def.id === "V005" ? L * 0.6 : def.id === "V004" ? L * 0.35 : L * 0.3;
            for (const side of def.id === "V007" ? [-0.5, 0.5] : [0]) {
                const base = at(tc, tYaw, [side, 0.1, L * 0.2]);
                r.solid("cyl", between(base, at(tc, tYaw, [side, 0.15, L * 0.2 + barrel]), def.id === "V005" ? 0.13 : 0.08), [0.15, 0.16, 0.15, 1], params, [0, BODY.gun, 0, 0]);
            }
            if (def.id === "V007") box([0, deck + 1.1, -L * 0.15], 0.6, 0.35, 0.6, [0.2, 0.22, 0.2], BODY.gun, "cube", tYaw);
        } else if (def.id === "V006" || def.id === "V008") {
            box([0, deck + 0.5, -0.4], W / 2 - 0.4, 0.5, L * 0.3, hull);
            const tc = at(p, yaw, [0, deck + 0.7, def.id === "V008" ? -0.6 : 0.4]);
            const elev = def.id === "V008" ? 0.5 : 0.02;
            r.solid("cyl", between(tc, [tc[0] + Math.sin(yaw) * L * 0.7 * Math.cos(elev), tc[1] + Math.sin(elev) * L * 0.7, tc[2] + Math.cos(yaw) * L * 0.7 * Math.cos(elev)], 0.14), [0.15, 0.16, 0.15, 1], params, [0, BODY.gun, 0, 0]);
        } else if (def.id === "V009" || def.id === "V010") {
            box([0, deck + 0.9, -L * 0.15], W / 2 - 0.15, 0.9, L * 0.33, def.id === "V009" ? mix3(hull, [0.4, 0.38, 0.3], 0.5) : hull);
            box([0, deck + 0.6, L * 0.33], W / 2 - 0.2, 0.6, L * 0.12, hull);
            r.solid("cube", yawed(at(p, yaw, [0, deck + 0.75, L * 0.43]), yaw, W / 2 - 0.4, 0.25, 0.02), [0.1, 0.13, 0.15, 1], params, [0, BODY.glass, 0, 0]);
            if (def.id === "V010") r.solid("cyl", between(at(p, yaw, [0, deck + 1.6, -L * 0.3]), at(p, yaw, [0, deck + 4, -L * 0.6]), 0.12), [0.6, 0.5, 0.1, 1], params, [0, BODY.gun, 0, 0]);
        } else {
            // Light vehicles and the APC: a cab with windows and a roof gun.
            box([0, deck + 0.35, -L * 0.05], W / 2 - 0.3, 0.38, L * 0.32, hull);
            r.solid("cube", yawed(at(p, yaw, [0, deck + 0.45, L * 0.28]), yaw, W / 2 - 0.4, 0.2, 0.02), [0.1, 0.13, 0.15, 1], params, [0, BODY.glass, 0, 0]);
            if (def.guns.length) { const g0 = at(p, yaw, [0, deck + 0.85, 0]); r.solid("cyl", between(g0, [g0[0] + Math.sin(tYaw) * 1.4, g0[1] + 0.05, g0[2] + Math.cos(tYaw) * 1.4], 0.05), [0.1, 0.1, 0.1, 1], params, [0, BODY.gun, 0, 0]); }
        }
        // Identification lights.
        r.solid("cube", yawed(at(p, yaw, [0, deck + 0.02, -L / 2 + 0.1]), yaw, W * 0.3, 0.04, 0.03), [...glow, 1], [LIT.body, 0, 0.6, 0], [0, BODY.visor, 0, 0]);
        if (v.alive && v.speed > 2) r.smoke(placed([p[0] - Math.sin(yaw) * L * 0.55, p[1] + 0.6, p[2] - Math.cos(yaw) * L * 0.55], 1.2 + Math.random() * 0.6), [0.55, 0.5, 0.45, 0.25], v.id + time);
    } else {
        drawAircraft(r, v, time, hull, params);
    }
    if (!v.alive) for (let k = 0; k < 3; k++) r.smoke(placed([p[0], p[1] + 2 + k * 2.5 + ((time * 1.5 + k) % 2.5), p[2]], 2 + k), [0.12, 0.11, 0.1, 0.55], v.id * 3 + k);
    void hullE; void b;
}

function drawAircraft(r: Renderer, v: VehicleState, time: number, hull: RGB, params: number[]): void {
    const def = v.def, p = v.pos, yaw = v.yaw;
    const [L, W, H] = def.dims;
    const bank = clamp((v.option === 8 ? 0 : 0.25) * Math.sin(time * 0.7 + v.id), -0.4, 0.4);
    const upv: V3 = [Math.cos(yaw) * Math.sin(bank), Math.cos(bank), -Math.sin(yaw) * Math.sin(bank)];
    const B = (o: V3, sx: number, sy: number, sz: number, color: RGB, part: number) => r.solid("cube", aligned(at(p, yaw, o), upv, yaw, sx, sy, sz), [...color, 1], params, [part === BODY.hull ? 1.2 : 0, part, 0, 0]);
    const fixed = def.topSpeed > 500;
    if (fixed) {
        B([0, 0, 0], 1.1, 1.0, L / 2, hull, BODY.hull);
        B([0, 0, -L * 0.05], W / 2, 0.15, L * 0.14, hull, BODY.hull);
        B([0, 0.6, -L / 2 + 1.5], 0.15, 1.6, 1.2, hull, BODY.hull);
        B([0, 0.1, -L / 2 + 1.2], W * 0.22, 0.1, 1.0, hull, BODY.hull);
        B([0, 0.75, L * 0.3], 0.55, 0.35, 1.6, [0.1, 0.13, 0.15], BODY.glass);
        if (def.id === "V018") { B([0, -0.3, 0], 2.4, 2.2, L / 2 - 2, hull, BODY.hull); for (const s of [-1, 1]) for (const k of [0.3, 0.6]) r.solid("cyl", aligned(at(p, yaw, [s * W * k * 0.5, -0.4, L * 0.05]), [Math.sin(yaw), 0, Math.cos(yaw)], 0, 0.9, 3, 0.9), [0.2, 0.2, 0.2, 1], params, [0, BODY.gun, 0, 0]); }
        // Engine glow.
        r.glow(placed(at(p, yaw, [0, 0, -L / 2 - 0.4]), 1.4), [1, 0.6, 0.3, 0.8], GLOW.dot);
        if (v.payload) B([0, -2.2, 0], 1.6, 1.2, 3.5, HULL[v.team], BODY.hull);
        return;
    }
    // Helicopters and drones.
    const drone = def.id === "V011" || def.id === "V012";
    if (drone) {
        B([0, 0, 0], W * 0.3, H * 0.6, L * 0.3, hull, BODY.hull);
        for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const rp = at(p, yaw, [a * W * 0.45, 0.1, c * L * 0.45]); r.solid("cube", yawed(rp, time * 40 + a, 0.38, 0.01, 0.04), [0.1, 0.1, 0.1, 1], params, [0, BODY.gun, 0, 0]); }
        r.glow(placed(at(p, yaw, [0, -0.1, L * 0.3]), 0.25), [...TEAM_COLOR[v.team], 1], GLOW.dot);
        return;
    }
    const tandem = def.id === "V015";
    B([0, 0, 0], W / 2, H * 0.35, L * 0.32, hull, BODY.hull);
    B([0, H * 0.05, -L * 0.42], 0.3, 0.35, L * 0.18, hull, BODY.hull);
    B([0, 0.4, L * 0.27], W * 0.35, H * 0.18, L * 0.08, [0.1, 0.13, 0.15], BODY.glass);
    if (def.id === "V013") for (const s of [-1, 1]) B([s * (W / 2 + 0.6), -0.4, 0.2], 0.6, 0.12, 0.5, [0.15, 0.15, 0.15], BODY.gun);
    const rotors: V3[] = tandem ? [[0, H * 0.45, L * 0.3], [0, H * 0.6, -L * 0.35]] : [[0, H * 0.45, 0.2]];
    for (const [k, o] of rotors.entries()) {
        const c = at(p, yaw, o);
        const spin = time * 22 * (k ? -1 : 1);
        for (let bl = 0; bl < 4; bl++) r.solid("cube", aligned([c[0], c[1], c[2]], upv, spin + (bl * Math.PI) / 2, 0.12, 0.02, L * (tandem ? 0.26 : 0.4)), [0.08, 0.08, 0.08, 1], params, [0, BODY.gun, 0, 0]);
    }
    if (!tandem) { const tr = at(p, yaw, [0.35, H * 0.15, -L * 0.5]); r.solid("cube", aligned(tr, [Math.cos(yaw), 0, -Math.sin(yaw)], time * 30, 0.06, 0.02, 1.1), [0.08, 0.08, 0.08, 1], params, [0, BODY.gun, 0, 0]); }
    r.glow(placed(at(p, yaw, [0, -H * 0.35, 0]), 0.3), [...TEAM_COLOR[v.team], 1], GLOW.dot);
}

function drawMecha(r: Renderer, v: VehicleState, time: number, hitFlash: number): void {
    const p = v.pos, yaw = v.yaw, m = v.mecha!, parts = v.parts!;
    const hull = mix3(HULL[v.team], [0.25, 0.25, 0.27], 0.4);
    const params = [LIT.body, v.id, hitFlash, 0];
    const lame = parts.legs < m.parts.legs * 0.35;
    const stride = Math.sin(time * 2.4 + v.id) * Math.min(1, Math.abs(v.speed) / 3) * (lame ? 0.3 : 0.7);
    const scale = m.id === "M003" ? 1.2 : m.id === "M002" ? 0.85 : 1;
    const S = (o: V3) => at(p, yaw, [o[0] * scale, o[1] * scale, o[2] * scale]);
    const hipY = 5.2;
    for (const side of [-1, 1]) {
        const a = stride * side;
        const hip = S([side * 1.3, hipY, 0]);
        const knee = S([side * 1.45, 2.7, Math.sin(a) * 1.2 + 0.4]);
        const foot = S([side * 1.4, 0.3, Math.sin(a) * 1.8]);
        r.solid("cyl", between(hip, knee, 0.5 * scale), [...hull, 1], params, [1, BODY.hull, 0, 0]);
        r.solid("cyl", between(knee, foot, 0.45 * scale), [...hull, 1], params, [1, BODY.hull, 0, 0]);
        r.solid("cube", yawed([foot[0], p[1] + 0.25, foot[2]], yaw, 0.7 * scale, 0.25 * scale, 1.1 * scale), [0.15, 0.15, 0.16, 1], params, [0, BODY.gun, 0, 0]);
    }
    const torso = S([0, hipY + 1.8, 0]);
    r.solid("cube", yawed(torso, yaw, 1.9 * scale, 1.5 * scale, 1.4 * scale), [...hull, 1], params, [1, BODY.hull, 0, 0]);
    r.solid("cube", yawed(S([0, hipY + 3.4, 0.5]), yaw, 0.5 * scale, 0.35 * scale, 0.5 * scale), [...hull, 1], params, [1, BODY.hull, 0, 0]);
    r.solid("cube", yawed(S([0, hipY + 3.45, 0.98]), yaw, 0.35 * scale, 0.08 * scale, 0.02), [...TEAM_COLOR[v.team], 1], [LIT.body, 0, 0.5, 0], [0, BODY.visor, 0, 0]);
    const ty = v.turretYaw || yaw;
    for (const [side, hp] of [[-1, parts.left], [1, parts.right]] as [number, number][]) {
        if (hp <= 0) continue;
        const sh = S([side * 2.4, hipY + 2.6, 0]);
        const elbow: V3 = [sh[0] + Math.sin(ty) * 1.2, sh[1] - 1.2, sh[2] + Math.cos(ty) * 1.2];
        r.solid("cyl", between(sh, elbow, 0.35 * scale), [...hull, 1], params, [1, BODY.hull, 0, 0]);
        r.solid("cyl", between(elbow, [elbow[0] + Math.sin(ty) * 3.6 * scale, elbow[1] + 0.2, elbow[2] + Math.cos(ty) * 3.6 * scale], 0.3 * scale), [0.13, 0.13, 0.14, 1], params, [0, BODY.gun, 0, 0]);
    }
    if (m.id !== "M002" && parts.torso > m.parts.torso * 0.25) r.solid("cube", yawed(S([1.4, hipY + 3.6, -0.4]), yaw, 0.8 * scale, 0.6 * scale, 0.9 * scale), [...hull, 1], params, [1, BODY.hull, 0, 0]);
    if (v.braced) r.solid("cube", yawed(S([-1.2, hipY + 2.2, 1.8]), yaw, 1.4 * scale, 2.2 * scale, 0.15), [0.3, 0.32, 0.34, 1], params, [1, BODY.plate, 0, 0]);
}

// --- small helpers ----------------------------------------------------------------------------------

export function mix3(a: RGB, b: RGB, t: number): RGB { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function lerp3(a: V3, b: V3, t: number): V3 { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function norm3(a: V3): V3 { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

/** The ground colour under a point (for mimetic armor). */
export function groundTint(w: World, x: number, z: number): RGB {
    const i = clamp(Math.round((x + HALF) / TERRAIN_STEP), 0, TN - 1), j = clamp(Math.round((z + HALF) / TERRAIN_STEP), 0, TN - 1);
    const g = w.ground[j * TN + i];
    return g === GROUND.grass ? [0.36, 0.4, 0.2] : g === GROUND.sand ? [0.72, 0.64, 0.48] : g === GROUND.rock ? [0.45, 0.44, 0.42] : g === GROUND.road ? [0.25, 0.25, 0.26] : g === GROUND.concrete ? [0.5, 0.49, 0.46] : g === GROUND.snow ? [0.85, 0.87, 0.9] : g === GROUND.glass ? [0.18, 0.26, 0.22] : [0.45, 0.37, 0.27];
}

export type { Mat4, Team };
