// Draws a Game into the two pipelines: the sky, every body (rubble, worlds with air and rings,
// stars with coronas), black holes with their discs, the rift, creatures (each built from a few
// spheres, cones and pieces of light), bolts, lightwaves, and the nebula you are - a slow storm
// of gas around a bright heart, trailing behind as it moves.
//
// Everything is placed in the player's own units around the player (see nk_shader.ts), through
// a `Draw` that only records instances, so tests can count what a scene holds.

import { add, sub, mul, len, norm, cross, lerp, clamp, basis, hashString, type V3 } from "./nk_math";
import { FACTIONS, galaxyById, type RGB, type BodyLook, type FactionId } from "./nk_data";
import type { Game } from "./nk_game";
import type { Body, Creature } from "./nk_world";
import { SOLID_KIND, GLOW_KIND, PLANET_LOOK, PLACE } from "./nk_shader";
import { placed, oriented, type Mat4, type LightSource } from "./nk_render";

export interface Draw {
    solid(mesh: string, m: Mat4, color: readonly number[], params: readonly number[], extra?: readonly number[]): void;
    glow(m: Mat4, color: readonly number[], kind: number, seed?: number, place?: number, extra?: readonly number[]): void;
}

/** A spark, a puff of trailing gas, a ring: light that lives a moment (km, seconds). */
export interface Particle { pos: V3; vel: V3; life: number; max: number; size: number; color: RGB; kind: number; grow: number; toPlayer: boolean; seed: number }

export interface SceneOut { lights: LightSource[]; holes: [number, number, number, number][]; solids: number; glows: number }

const STAR_COLOR: Partial<Record<BodyLook, RGB>> = {
    whiteDwarf: [0.82, 0.9, 1], brownDwarf: [0.75, 0.3, 0.16], redDwarf: [1, 0.42, 0.2], yellow: [1, 0.86, 0.5], white: [0.95, 0.96, 1],
    blue: [0.6, 0.75, 1], orange: [1, 0.62, 0.28], redGiant: [1, 0.36, 0.2],
};
const LOOK_INDEX: Partial<Record<BodyLook, number>> = { rock: PLANET_LOOK.rock, ice: PLANET_LOOK.ice, ocean: PLANET_LOOK.ocean, lava: PLANET_LOOK.lava, desert: PLANET_LOOK.desert, gas: PLANET_LOOK.gas, banded: PLANET_LOOK.banded };
const AIR: Partial<Record<BodyLook, RGB>> = { ocean: [0.35, 0.6, 1], ice: [0.6, 0.8, 1], gas: [0.9, 0.7, 0.45], banded: [0.7, 0.75, 1], lava: [1, 0.35, 0.1], desert: [0.9, 0.6, 0.35] };

/** The nebula's colours at a level: its heart, its body, its edge. Cool when young, royal when grown. */
export function nebulaPalette(level: number): { core: RGB; mid: RGB; edge: RGB } {
    const t = clamp((level - 1) / 36);
    const stops = (a: RGB, b: RGB, c: RGB): RGB => (t < 0.5 ? [lerp(a[0], b[0], t * 2), lerp(a[1], b[1], t * 2), lerp(a[2], b[2], t * 2)] : [lerp(b[0], c[0], t * 2 - 1), lerp(b[1], c[1], t * 2 - 1), lerp(b[2], c[2], t * 2 - 1)]);
    return {
        core: stops([0.85, 0.97, 1], [1, 0.9, 0.95], [1, 0.95, 0.8]),
        mid: stops([0.15, 0.75, 0.95], [0.9, 0.35, 0.85], [1, 0.7, 0.25]),
        edge: stops([0.2, 0.3, 1], [0.5, 0.2, 0.95], [0.95, 0.25, 0.4]),
    };
}

interface Puff { dir: V3; rho: number; size: number; speed: number; phase: number; tone: number; seed: number }
function makePuffs(n: number, seed: number): Puff[] {
    const out: Puff[] = [];
    let s = seed >>> 0 || 1;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < n; i++) {
        const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
        const rho = 0.12 + 0.95 * Math.pow(rnd(), 0.75);
        out.push({ dir: [r * Math.cos(a), z * 0.7, r * Math.sin(a)], rho, size: 0.26 + rnd() * 0.5, speed: (0.1 + rnd() * 0.22) * (rnd() < 0.5 ? 1 : 0.6) / (0.4 + rho), phase: rnd() * 6.283, tone: rnd(), seed: rnd() });
    }
    return out;
}
const PLAYER_PUFFS = makePuffs(120, 7);
const SMALL_PUFFS = makePuffs(28, 31);

function rotY(v: V3, a: number): V3 { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; }

/** A living cloud: gas circling a heart. `lag` (units) smears it back along its motion. */
function drawCloud(d: Draw, at: V3, r: number, puffs: Puff[], pal: { core: RGB; mid: RGB; edge: RGB }, time: number, lag: V3, strength: number, filaments: number): void {
    for (const p of puffs) {
        const o = rotY(p.dir, time * p.speed + p.phase);
        const pos: V3 = [at[0] + (o[0] * p.rho - lag[0] * p.rho * p.rho) * r, at[1] + (o[1] * p.rho - lag[1] * p.rho * p.rho) * r, at[2] + (o[2] * p.rho - lag[2] * p.rho * p.rho) * r];
        const k = clamp(p.rho * 1.1 + (p.tone - 0.5) * 0.35);
        const c: RGB = k < 0.45 ? [lerp(pal.core[0], pal.mid[0], k / 0.45), lerp(pal.core[1], pal.mid[1], k / 0.45), lerp(pal.core[2], pal.mid[2], k / 0.45)] : [lerp(pal.mid[0], pal.edge[0], (k - 0.45) / 0.55), lerp(pal.mid[1], pal.edge[1], (k - 0.45) / 0.55), lerp(pal.mid[2], pal.edge[2], (k - 0.45) / 0.55)];
        d.glow(placed(pos, p.size * r), [c[0], c[1], c[2], strength * (0.022 + p.rho * 0.055)], GLOW_KIND.gas, p.seed, PLACE.billboard, [filaments, 0, 0, p.phase + time * p.speed * 0.3]);
    }
    d.glow(placed(at, r * 0.95), [pal.core[0], pal.core[1], pal.core[2], strength * 0.14], GLOW_KIND.halo, 0);
    d.glow(placed(at, r * 0.32), [1, 1, 1, strength * 0.4], GLOW_KIND.spark, 0.3, PLACE.billboard, [1, 0, 0, time * 0.1]);
}

function factionColor(f: FactionId): RGB { return FACTIONS[f].color; }

function drawCreature(d: Draw, c: Creature, at: V3, r: number, time: number, attune: number): void {
    const f = c.dir, { right, up } = basis(f);
    const col = c.species.color, em = c.faction === "wild" ? col : factionColor(c.faction);
    const flash = Math.min(1, c.hurt * 3.5);
    const seed = (c.id * 0.137) % 1;
    const at3 = (x: number, y: number, z: number): V3 => [at[0] + (right[0] * x + up[0] * y + f[0] * z) * r, at[1] + (right[1] * x + up[1] * y + f[1] * z) * r, at[2] + (right[2] * x + up[2] * y + f[2] * z) * r];
    const dirOf = (x: number, y: number, z: number): V3 => norm([right[0] * x + up[0] * y + f[0] * z, right[1] * x + up[1] * y + f[1] * z, right[2] * x + up[2] * y + f[2] * z]);
    const hide = (mesh: string, pos: V3, sx: number, sy: number, sz: number, look: number, tint: RGB = col, fwd: V3 = f, upHint: V3 = up) =>
        d.solid(mesh, oriented(pos, fwd, sx * r, sy * r, sz * r, upHint), [tint[0] * 0.3, tint[1] * 0.3, tint[2] * 0.3, 1], [SOLID_KIND.hide, seed, look, 1], [em[0], em[1], em[2], flash]);
    const spike = (pos: V3, dir: V3, w: number, l: number, look = 0) => hide("cone", pos, w, w, l, look, col, dir, f);
    const ph = c.phase;
    switch (c.species.shape) {
        case "eel": {
            for (let i = 0; i < 7; i++) {
                const k = i / 6, s = (1 - k * 0.72) * 0.42;
                hide(i === 0 ? "sphere-2" : "sphere-1", at3(Math.sin(ph * 2.2 - i * 0.9) * 0.22 * k * 2, Math.cos(ph * 1.3 - i * 0.7) * 0.08, 0.7 - i * 0.36), s, s, s * 1.5, 2);
            }
            spike(at3(0, 0, 0.9), f, 0.2, 0.55);
            d.glow(placed(at3(0, 0, 0.8), r * 0.7), [em[0], em[1], em[2], 0.5], GLOW_KIND.halo, seed);
            break;
        }
        case "crab": {
            hide("sphere-2", at, 0.95, 0.55, 0.85, 1);
            for (let i = 0; i < 6; i++) {
                const side = i < 3 ? -1 : 1, k = (i % 3) - 1, sw = Math.sin(ph * 3 + i * 2) * 0.15;
                spike(at3(side * 0.75, -0.1, k * 0.5), dirOf(side, -0.5 + sw, k * 0.4), 0.14, 0.95);
            }
            for (const side of [-1, 1]) { spike(at3(side * 0.45, 0, 0.75), dirOf(side * 0.3, 0, 1), 0.2, 0.8, 1); }
            d.glow(placed(at3(0, 0.1, 0.6), r * 0.5), [em[0], em[1], em[2], 0.35], GLOW_KIND.halo, seed);
            break;
        }
        case "manta": {
            const flap = Math.sin(ph * 1.6);
            hide("sphere-2", at, 0.42, 0.18, 1, 1);
            for (const side of [-1, 1]) hide("sphere-2", at3(side * 0.72, flap * 0.22, -0.05), 0.75, 0.06, 0.5, 2, col, dirOf(0, -flap * 0.35 * 1, 1), dirOf(side * flap * 0.35, 1, 0));
            hide("sphere-1", at3(0, 0, -1.35), 0.04, 0.04, 0.75, 0);
            d.glow(placed(at, r * 1.5), [em[0], em[1], em[2], 0.22], GLOW_KIND.halo, seed);
            break;
        }
        case "nebula": {
            const pal = { core: [1, 1, 1] as RGB, mid: col, edge: [em[0] * 0.6, em[1] * 0.5, em[2] * 0.9] as RGB };
            drawCloud(d, at, r, SMALL_PUFFS, pal, time + seed * 40, [0, 0, 0], 1 + flash, 1);
            break;
        }
        case "wasp": {
            hide("sphere-2", at, 0.36, 0.36, 0.8, 2);
            hide("sphere-1", at3(0, 0.05, 0.85), 0.3, 0.28, 0.3, 0);
            spike(at3(0, 0, -0.7), dirOf(0, -0.15, -1), 0.16, 0.9);
            for (const side of [-1, 1]) {
                spike(at3(side * 0.2, 0.1, 0.95), dirOf(side * 0.5, 0.3, 1), 0.06, 0.5);
                d.glow(oriented(at3(side * 0.6, 0.35, -0.1), dirOf(0, 0, 1), r * (0.55 + 0.1 * Math.sin(ph * 14)), r * 0.25, r), [em[0], em[1], em[2], 0.5], GLOW_KIND.gas, seed + side, PLACE.billboard);
            }
            break;
        }
        case "brute": {
            hide("sphere-3", at, 0.95, 0.9, 1, 3, [0.5, 0.3, 0.25]);
            for (let i = 0; i < 6; i++) { const a = (i / 6) * 6.283; spike(at3(Math.cos(a) * 0.6, 0.55 + Math.sin(a) * 0.2, Math.sin(a) * 0.6 + 0.1), dirOf(Math.cos(a) * 0.7, 1, Math.sin(a) * 0.7), 0.2, 0.75, 3); }
            for (const side of [-1, 1]) hide("sphere-2", at3(side * 0.95, -0.2, 0.55 + Math.sin(ph * 2 + side) * 0.15), 0.4, 0.4, 0.5, 3, [0.5, 0.3, 0.25]);
            d.glow(placed(at, r * 2), [em[0], em[1], em[2], 0.3], GLOW_KIND.halo, seed);
            break;
        }
        case "spire": {
            const upw: V3 = [0, 1, 0], side: V3 = [1, 0, 0];
            d.solid("cone", oriented(sub(at, mul(upw, r * 0.2)), upw, r * 0.5, r * 0.5, r * 2.2, side), [col[0] * 0.3, col[1] * 0.3, col[2] * 0.3, 1], [SOLID_KIND.hide, seed, 3, 1], [em[0], em[1], em[2], flash]);
            d.solid("cone", oriented(sub(at, mul(upw, r * 0.2)), [0, -1, 0], r * 0.5, r * 0.5, r * 1.2, side), [col[0] * 0.3, col[1] * 0.3, col[2] * 0.3, 1], [SOLID_KIND.hide, seed, 3, 1], [em[0], em[1], em[2], flash]);
            for (let i = 0; i < 3; i++) {
                const a = time * 0.8 + (i / 3) * 6.283;
                d.solid("sphere-1", placed([at[0] + Math.cos(a) * r * 1.1, at[1] + r * 0.3, at[2] + Math.sin(a) * r * 1.1], r * 0.18), [0.3, 0.2, 0.1, 1], [SOLID_KIND.crystal, seed, 0, 1], [em[0], em[1], em[2], 0]);
            }
            d.glow(placed([at[0], at[1] + r * 2, at[2]], r * 1.2), [em[0], em[1], em[2], 0.9], GLOW_KIND.spark, seed, PLACE.billboard, [1, 0, 0, 0]);
            d.glow(placed(at, r * 2.6), [em[0], em[1], em[2], 0.25], GLOW_KIND.halo, seed);
            break;
        }
        case "jelly": {
            const beat = 1 + Math.sin(ph * 1.8) * 0.08;
            hide("sphere-3", at3(0, 0, 0.2), 0.85 * beat, 0.85 * beat, 0.6 / beat, 1);
            for (let i = 0; i < 7; i++) {
                const a = (i / 7) * 6.283, sway = Math.sin(ph + i) * 0.25;
                const root = at3(Math.cos(a) * 0.5, Math.sin(a) * 0.5, -0.1), tip = at3(Math.cos(a) * 0.7 + sway, Math.sin(a) * 0.7, -2.4);
                const axis = sub(tip, root);
                d.glow([r * 0.16, 0, 0, 0, 0, 1, 0, 0, axis[0], axis[1], axis[2], 0, (root[0] + tip[0]) / 2, (root[1] + tip[1]) / 2, (root[2] + tip[2]) / 2, 1], [em[0], em[1], em[2], 0.7], GLOW_KIND.stream, seed + i * 0.1, PLACE.axial);
            }
            d.glow(placed(at3(0, 0, 0.2), r * 1.5), [em[0], em[1], em[2], 0.45], GLOW_KIND.halo, seed);
            break;
        }
        case "husk": {
            hide("sphere-2", at, 0.8, 0.75, 0.95, 3, [0.16, 0.1, 0.13]);
            for (let i = 0; i < 5; i++) { const a = (i / 5) * 6.283 + seed * 6; spike(at3(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0.3), dirOf(Math.cos(a), Math.sin(a), 0.5), 0.2, 1, 3); }
            for (let i = 1; i < 4; i++) d.glow(placed(at3(0, 0, -i * 0.7), r * (0.9 - i * 0.15)), [em[0], em[1], em[2], 0.3 / i], GLOW_KIND.gas, seed + i * 0.2);
            break;
        }
        case "whale": {
            hide("sphere-3", at, 0.5, 0.48, 1.2, 1);
            hide("sphere-2", at3(0, -0.04, 0.95), 0.4, 0.36, 0.5, 1);
            const tail = Math.sin(ph * 1.2) * 0.3;
            hide("sphere-2", at3(0, tail * 0.5, -1.25), 0.16, 0.14, 0.6, 2);
            for (const side of [-1, 1]) {
                hide("sphere-2", at3(side * 0.4, tail, -1.8), 0.42, 0.05, 0.3, 2);
                hide("sphere-2", at3(side * 0.6, -0.2, 0.3), 0.4, 0.05, 0.22, 2, col, dirOf(side * 0.4, 0, 1));
            }
            for (let i = 0; i < 5; i++) d.glow(placed(at3(0, 0.5, 0.8 - i * 0.45), r * 0.22), [em[0], em[1], em[2], 0.9], GLOW_KIND.mote, seed + i * 0.17);
            d.glow(placed(at, r * 2.4), [em[0], em[1], em[2], 0.16], GLOW_KIND.halo, seed);
            break;
        }
        case "envoy": {
            const upw: V3 = [0, 1, 0], side: V3 = [Math.cos(time * 0.3), 0, Math.sin(time * 0.3)];
            const bob = Math.sin(time * 0.8 + seed * 6) * 0.1 * r;
            const p0: V3 = [at[0], at[1] + bob, at[2]];
            d.solid("sphere-1", oriented(p0, upw, r * 0.45, r * 0.45, r * 1.05, side), [0.25, 0.3, 0.4, 1], [SOLID_KIND.crystal, seed, 0, 1], [em[0], em[1], em[2], 0]);
            for (let i = 0; i < 4; i++) {
                const a = -time * 0.6 + (i / 4) * 6.283;
                d.solid("sphere-1", oriented([p0[0] + Math.cos(a) * r * 0.95, p0[1] + Math.sin(a * 2) * r * 0.2, p0[2] + Math.sin(a) * r * 0.95], upw, r * 0.1, r * 0.1, r * 0.3, side), [0.25, 0.3, 0.4, 1], [SOLID_KIND.crystal, seed, 0, 1], [em[0], em[1], em[2], 0]);
            }
            d.glow(placed(p0, r * 2.4), [em[0], em[1], em[2], 0.35], GLOW_KIND.halo, seed);
            d.glow(placed(p0, r * 1.1), [1, 1, 1, 0.7], GLOW_KIND.spark, seed, PLACE.billboard, [1, 0, 0, time * 0.2]);
            // An envoy never stops speaking: rings of its government's light, visible to the attuned.
            for (let i = 0; i < 3; i++) { const k = (time * 0.25 + i / 3) % 1; d.glow(placed(p0, r * (1 + k * 5)), [em[0], em[1], em[2], (0.12 + attune * 0.5) * (1 - k)], GLOW_KIND.wave, seed + i); }
            break;
        }
    }
    if (attune > 0.02) d.glow(placed(at, r * 1.9), [em[0], em[1], em[2], attune * 0.45], GLOW_KIND.mark, seed);
}

function drawBody(d: Draw, b: Body, at: V3, r: number, dist: number, out: SceneOut, pal: { mid: RGB }, time: number): void {
    const apparent = r / Math.max(dist, 1e-6);
    const integrity = clamp(b.radius / b.radius0);
    if (b.kind === "mote" || b.kind === "essence") {
        const c: RGB = b.kind === "mote" ? [0.6 + b.seed * 0.4, 0.95, 1] : [1, 0.85, 0.6];
        d.glow(placed(at, r * 3.2), [c[0], c[1], c[2], 0.9], GLOW_KIND.mote, b.seed);
        return;
    }
    if (b.kind === "star") {
        const c = STAR_COLOR[b.look] ?? [1, 0.9, 0.7];
        const flare = b.drain > 0 && b.flareIn < 1 ? 1 - b.flareIn : 0;
        d.solid(apparent > 0.2 ? "sphere-5" : apparent > 0.02 ? "sphere-4" : "sphere-3", placed(at, r), [c[0], c[1], c[2], 1], [SOLID_KIND.star, b.seed, 0, integrity], [flare, 0, 0, 0]);
        d.glow(placed(at, r * 3.4), [c[0], c[1], c[2], 0.5 + flare * 0.6], GLOW_KIND.corona, b.seed, PLACE.billboard, [1 / 3.4, 0, 0, 0]);
        d.glow(placed(at, r * 7), [c[0], c[1], c[2], 0.1], GLOW_KIND.halo, b.seed);
        out.lights.push({ pos: at, color: c, intensity: 1.1 * Math.min(1, apparent * 30 + 0.25), reach: 0 });
        return;
    }
    if (b.kind === "asteroid" || (b.kind === "moon" && apparent < 0.004)) {
        const c: RGB = b.look === "ice" ? [0.62, 0.74, 0.86] : [0.5 + b.seed * 0.12, 0.42 + b.seed * 0.06, 0.36];
        d.solid(apparent > 0.03 ? "sphere-2" : "sphere-1", oriented(at, norm([Math.sin(b.seed * 40 + time * 0.05), 0.4, Math.cos(b.seed * 40 + time * 0.05)]), r, r * (0.75 + b.seed * 0.3), r), [c[0], c[1], c[2], 1], [SOLID_KIND.rock, b.seed, 0, 1]);
        return;
    }
    const look = LOOK_INDEX[b.look] ?? PLANET_LOOK.rock;
    const air = AIR[b.look] ?? [0, 0, 0];
    const tint: RGB = b.kind === "giant" ? [0.55 + b.seed * 0.4, 0.4 + ((b.seed * 7) % 1) * 0.3, 0.3 + ((b.seed * 13) % 1) * 0.5] : [0.8, 0.75, 0.7];
    d.solid(apparent > 0.25 ? "sphere-5" : apparent > 0.02 ? "sphere-4" : "sphere-3", placed(at, r), [tint[0], tint[1], tint[2], 1], [SOLID_KIND.planet, b.seed, look, integrity], [b.inhabited ? 1 : 0, air[0], air[1], air[2]]);
    if (air[0] + air[1] + air[2] > 0) d.glow(placed(at, r * 1.22), [air[0], air[1], air[2], 0.28], GLOW_KIND.halo, b.seed);
    if (b.rings) {
        const n = norm([Math.sin(b.seed * 9) * 0.5, 1, Math.cos(b.seed * 5) * 0.4]);
        const fwd = norm(cross(n, [1, 0, 0]));
        d.glow(oriented(at, fwd, r * 2.5, r * 2.5, r * 2.5, n), [0.8, 0.72, 0.6, 0.3], GLOW_KIND.rings, b.seed, PLACE.planar, [0.52, 0, 0, 0]);
    }
    if (integrity < 0.999) d.glow(placed(at, r * 1.5), [pal.mid[0], pal.mid[1], pal.mid[2], 0.4 * (1 - integrity) + 0.15 * b.drain], GLOW_KIND.halo, b.seed);
}

/** Draws the game. `scale` is km per unit (the player's radius); returns the lights and holes for the World uniform. */
export function drawScene(d: Draw, g: Game, time: number, attune: number, particles: readonly Particle[], camera: V3): SceneOut {
    const p = g.player, scale = p.radius, region = g.region;
    const out: SceneOut = { lights: [], holes: [], solids: 0, glows: 0 };
    const rs = (v: V3): V3 => [(v[0] - p.pos[0]) / scale, (v[1] - p.pos[1]) / scale, (v[2] - p.pos[2]) / scale];
    const pal = nebulaPalette(p.level);
    const sky = galaxyById(region.def.galaxy).sky;

    d.solid("sky", placed([0, 0, 0], 1), [1, 1, 1, 1], [SOLID_KIND.sky, 0, 0, 1]);

    // The region's own sun: far off, always the same way, so worlds have a day side.
    const h = hashString(region.def.id);
    const sunDir = norm([Math.cos(h % 6.283), 0.35 + ((h >> 8) % 100) / 300, Math.sin(h % 6.283)]);
    const sunColor: RGB = [lerp(1, sky.b[0], 0.35), lerp(0.96, sky.b[1], 0.35), lerp(0.9, sky.b[2], 0.35)];
    const sunAt = add(camera, mul(sunDir, 3000));
    d.glow(placed(sunAt, 420), [sunColor[0], sunColor[1], sunColor[2], 1], GLOW_KIND.corona, 0.5, PLACE.billboard, [0.06, 0, 0, 0]);
    d.glow(placed(sunAt, 90), [1, 1, 1, 1], GLOW_KIND.spark, 0.2, PLACE.billboard, [1, 0, 0, 0.3]);
    out.lights.push({ pos: mul(sunDir, 1e6), color: sunColor, intensity: region.bodies.some(b => b.kind === "star") ? 0.45 : 1.25, reach: 0 });

    // Bodies; the brightest stars light the scene (the list is sorted below).
    const starLights: LightSource[] = [];
    for (const b of region.bodies) {
        if (!b.alive) continue;
        const at = rs(b.pos), r = b.radius / scale, dist = len(sub(at, camera));
        if (b.kind === "mote" || b.kind === "essence") { if (dist > 500) continue; }
        else if (b.kind !== "star" && r / dist < 0.0007) continue;
        const before = out.lights.length;
        drawBody(d, b, at, r, dist, out, pal, time);
        if (out.lights.length > before) starLights.push(out.lights.pop()!);
        if (b.drain > 0.01) {
            // Matter streaming off it into you.
            const from = add(at, mul(norm(sub([0, 0, 0], at)), r * 0.9)), axis = sub([0, 0, 0], from);
            for (let i = 0; i < 3; i++) d.glow([0.3 + i * 0.12, 0, 0, 0, 0, 1, 0, 0, axis[0], axis[1], axis[2], 0, from[0] + axis[0] / 2, from[1] + axis[1] / 2, from[2] + axis[2] / 2, 1], [pal.mid[0], pal.mid[1], pal.mid[2], 0.8 * b.drain], GLOW_KIND.stream, b.seed + i * 0.31, PLACE.axial);
        }
    }
    starLights.sort((a, b2) => b2.intensity / (len(b2.pos) + 1) - a.intensity / (len(a.pos) + 1));
    out.lights.push(...starLights.slice(0, 2));
    // Your own light falls on what is near you.
    out.lights.push({ pos: [0, 0, 0], color: pal.mid, intensity: p.veil ? 0.1 : 0.9, reach: 26 });

    for (const hole of region.holes) {
        if (!hole.alive) continue;
        const at = rs(hole.pos), r = hole.radius / scale;
        const hot: RGB = region.def.galaxy === "hollow" ? [1, 0.35, 0.3] : [1, 0.62, 0.3];
        d.solid("sphere-4", placed(at, r), [0, 0, 0, 1], [SOLID_KIND.horizon, 0, 0, 1]);
        const hs = (hole.id * 0.317) % 1;
        const n = norm([Math.sin(hs * 9) * 0.35, 1, Math.cos(hs * 7) * 0.3]);
        d.glow(oriented(at, norm(cross(n, [1, 0, 0])), r * 4.4, r * 4.4, r * 4.4, n), [hot[0], hot[1], hot[2], 0.95], GLOW_KIND.disc, hs, PLACE.planar, [0.3, hs * 6, 0, 0]);
        d.glow(placed(at, r * 2.7), [hot[0], hot[1], hot[2], 0.5], GLOW_KIND.photon, hs, PLACE.billboard, [1, 0, 0, 0]);
        if (attune > 0.02) d.glow(placed(at, r * 2.5 / 0.9), [0.6, 0.5, 1, attune * 0.6], GLOW_KIND.mark, hs);
        out.holes.push([at[0], at[1], at[2], r]);
    }
    if (region.rift) {
        const at = rs(region.rift.pos), r = region.rift.radius / scale;
        d.glow(placed(at, r * 1.3), [0.75, 0.95, 1, 0.5], GLOW_KIND.rift, 0.4, PLACE.billboard, [region.rift.open ? 1 : 0.18, 0, 0, time * 0.05]);
    }

    for (const c of region.creatures) {
        if (!c.alive) continue;
        const at = rs(c.pos), r = c.radius / scale, dist = len(sub(at, camera));
        if (r / dist < 0.0012) continue;
        drawCreature(d, c, at, r, time, attune);
    }

    for (const dc of g.decoys) {
        const at = rs(dc.pos), r = (dc.radius / scale) * 1.6;
        drawCloud(d, at, r, SMALL_PUFFS, { core: pal.core, mid: pal.mid, edge: pal.edge }, time * 2, [0, 0, 0], Math.min(1, dc.life / 3) * 1.3, 1);
    }

    for (const b of g.bolts) {
        const at = rs(b.pos), r = b.radius / scale, dir = norm(b.vel);
        const c: RGB = b.faction === "player" ? pal.core : factionColor(b.faction);
        const axis = mul(dir, r * 14);
        d.glow([r * 1.6, 0, 0, 0, 0, 1, 0, 0, axis[0], axis[1], axis[2], 0, at[0] - axis[0] * 0.4, at[1] - axis[1] * 0.4, at[2] - axis[2] * 0.4, 1], [c[0], c[1], c[2], 1], GLOW_KIND.bolt, 0, PLACE.axial);
        d.glow(placed(at, r * 5), [c[0], c[1], c[2], 0.5], GLOW_KIND.halo, 0);
    }

    // Lightwaves: invisible unless you are attuned to them. A Pulse is yours, and always seen.
    for (const s of g.signals) {
        const r = ((g.time - s.t0) * s.speed) / scale, k = clamp(1 - ((g.time - s.t0) * s.speed) / s.range);
        const at = rs(s.from);
        if (s.kind === "pulse") { d.glow(placed(at, r / 0.9), [pal.core[0], pal.core[1], pal.core[2], k * 0.9], GLOW_KIND.shock, 0); continue; }
        if (attune < 0.02) continue;
        const c: RGB = s.faction === "player" ? pal.mid : factionColor(s.faction);
        d.glow(placed(at, r / 0.93), [c[0], c[1], c[2], attune * k * (s.kind === "chatter" ? 0.45 : 0.85)], GLOW_KIND.wave, (s.id * 0.37) % 1);
    }

    // You.
    if (p.alive) {
        const speed = len(p.vel) / scale;
        const lag = speed > 0.01 ? mul(norm(p.vel), Math.min(2.6, speed * 0.13)) : ([0, 0, 0] as V3);
        const veil = p.veil ? 0.3 : 1;
        const shown = p.veil ? { core: [0.5, 0.45, 0.8] as RGB, mid: [0.3, 0.2, 0.6] as RGB, edge: [0.15, 0.1, 0.4] as RGB } : pal;
        const blink = p.invulnerable > 0 ? 0.6 + 0.4 * Math.sin(time * 20) : 1;
        drawCloud(d, [0, 0, 0], 1, PLAYER_PUFFS, shown, time, lag, veil * blink, 1);
        // The stars you have eaten glitter inside you.
        const stars = Math.min(24, g.campaign.stats.stars * 2);
        for (let i = 0; i < stars; i++) {
            const pf = PLAYER_PUFFS[i * 2 + 1], o = rotY(pf.dir, -time * pf.speed * 1.7 + pf.phase);
            d.glow(placed(mul(o, pf.rho * 0.8), 0.14), [1, 0.92, 0.7, veil], GLOW_KIND.spark, pf.seed, PLACE.billboard, [1, 0, 0, time * 0.3 + i]);
        }
        if (p.flare > 0) {
            const f = g.forward, axis = mul(f, 90);
            d.glow([16, 0, 0, 0, 0, 1, 0, 0, axis[0], axis[1], axis[2], 0, axis[0] / 2 + f[0], axis[1] / 2 + f[1], axis[2] / 2 + f[2], 1], [1, 0.8, 0.5, Math.min(1, p.flare * 2) * 0.6], GLOW_KIND.fire, 0.2, PLACE.axial);
        }
    }

    for (const q of particles) {
        const k = q.life / q.max;
        const at = rs(q.pos), r = (q.size / scale) * (1 + q.grow * (1 - k));
        d.glow(placed(at, r), [q.color[0], q.color[1], q.color[2], k * (q.kind === GLOW_KIND.gas ? 0.22 : 1)], q.kind, q.seed, PLACE.billboard, [1, 0, 0, q.seed * 6]);
    }
    return out;
}
