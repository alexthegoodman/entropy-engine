// Armageddon 2070's bots think with WIR: programs written in Yumon Pet's WIR language
// (yumon-pet/wir/src/armageddon.rs writes them, `wir armageddon` compiles and checks them), run here
// as sparse ReLU networks (ar_wir_data.ts). This file is the runtime and, for checks, every rule
// again as plain TypeScript: tests (and `ar_config {check: true}` in the live game) compare each
// network decision with its rule.
//
// The chain of command:
//   strategic  every few seconds per squad: which territory (of up to 12) to go for;
//   squad      per squad: its mode (advance, assault, defend, regroup, flank, fall back, mount);
//   infantry   per soldier: senses (a 5 x 5 grid program at its cell) + a role brain: heading or
//              hold, fire, reload, crouch, grenade, launcher;
//   vehicles   tank / transport / helicopter / jet / mecha brains for whoever drives them.

export interface WirLayer { b: number[]; rows: number[][] }
export interface ArNet { kind: string; variant: string; consts: Record<string, number | number[] | boolean>; inputs: string[]; ranges: [number, number][]; outputs: string[]; layers: WirLayer[] }
export interface ArWirData {
    consts: { ceil: number; ally_cap: number; keep: number[]; keep_hold: number; slots: number };
    sense: { channels: string[]; taps: [number, number, number][]; pads: number[]; outputs: string[]; layers: WirLayer[] };
    nets: Record<string, ArNet>;
}

/** E NE N NW W SW S SE as [dRow, dCol]: rows grow toward +z, so "N" is -z. */
export const DIRS: readonly [number, number][] = [[0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1]];
export const HOLD = 8;
export const CEIL = 48;
export const MODES = ["advance", "assault", "defend", "regroup", "flank", "fallback", "mount"] as const;
export type Mode = (typeof MODES)[number];
export const SENSE_NAMES: string[] = [...["go", "gt", "gc", "gl", "e", "n", "b"].flatMap(p => Array.from({ length: 8 }, (_, k) => `${p}${k}`)), "es", "gcs"];

/** A sparse ReLU network: rows hold (input index, weight) pairs; the last layer is linear. */
export function evalNet(layers: readonly WirLayer[], x: ArrayLike<number>): Float64Array {
    let a: ArrayLike<number> = x;
    for (let k = 0; k < layers.length; k++) {
        const L = layers[k], last = k === layers.length - 1, out = new Float64Array(L.b.length);
        for (let r = 0; r < L.b.length; r++) {
            let z = L.b[r];
            const row = L.rows[r];
            for (let i = 0; i < row.length; i += 2) z += row[i + 1] * a[row[i]];
            out[r] = last ? z : z > 0 ? z : 0;
        }
        a = out;
    }
    return a as Float64Array;
}
export const weightCount = (layers: readonly WirLayer[]): number => layers.reduce((s, l) => s + l.rows.reduce((t, r) => t + r.length / 2, 0), 0);

export type Getter = (channel: number, dy: number, dx: number) => number;
export type Vals = Record<string, number>;

/** The networks, by name, run from named inputs. */
export class Wir {
    constructor(readonly data: ArWirData) {}
    has(name: string): boolean { return name in this.data.nets; }
    run(name: string, x: Vals): Vals {
        const n = this.data.nets[name];
        if (!n) throw new Error(`no WIR network ${name}`);
        const v = new Float64Array(n.inputs.length);
        for (let i = 0; i < n.inputs.length; i++) v[i] = x[n.inputs[i]] ?? 0;
        const out = evalNet(n.layers, v), r: Vals = {};
        for (let i = 0; i < n.outputs.length; i++) r[n.outputs[i]] = Math.round(out[i] * 1e6) / 1e6;
        return r;
    }
    /** Senses from the stencil network at one cell. */
    senses(get: Getter): Vals {
        const s = this.data.sense, x = new Float64Array(s.taps.length);
        for (let i = 0; i < s.taps.length; i++) { const [c, dy, dx] = s.taps[i]; x[i] = get(c, dy, dx); }
        const out = evalNet(s.layers, x), r: Vals = {};
        for (let i = 0; i < s.outputs.length; i++) r[s.outputs[i]] = Math.round(out[i]);
        return r;
    }
    consts(name: string): Record<string, number | number[] | boolean> { return this.data.nets[name].consts; }
}

// --- the combinators, exactly as WIR lowers them --------------------------------------------

const relu = (x: number) => (x > 0 ? x : 0);
const clip = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const step = (x: number) => clip(x, 0, 1);
const ge = (a: number, b: number) => step(a - b + 1), le = (a: number, b: number) => step(b - a + 1);
const not = (x: number) => 1 - x;
const and = (...xs: number[]) => relu(xs.reduce((s, x) => s + x, 0) - (xs.length - 1));
const or = (...xs: number[]) => { const s = xs.reduce((t, x) => t + x, 0); return s - relu(s - 1); };
const select = (c: number, a: number, b: number) => (c ? a : b);
const min = Math.min;

/** One-hot argmax (keys n*s + n-1-d: ties go to the lower index). */
export function argmax(scores: number[]): number {
    let best = 0, bk = -Infinity;
    const n = scores.length;
    scores.forEach((s, d) => { const k = n * s + (n - 1 - d); if (k > bk) { bk = k; best = d; } });
    return best;
}
const oneHot = (prefix: string, n: number, k: number, out: Vals) => { for (let i = 0; i < n; i++) out[`${prefix}${i}`] = i === k ? 1 : 0; };

// --- the rules --------------------------------------------------------------------------------

function sector(dy: number, dx: number): number {
    if (dy === 0 && dx === 0) return -1;
    const a = (Math.atan2(-dy, dx) * 180) / Math.PI;
    return ((Math.floor((a + 18) / 45) % 8) + 8) % 8;
}
const grade = (v: number, best: number) => le(v - best, 1) - ge(v - best, 4);
const KEEP = [3, 1, 0, -1, -3], KEEP_HOLD = 1;
const turnSteps = (a: number, b: number) => { const t = (a + 8 - b) % 8; return Math.min(t, 8 - t); };
function inertia(option: number, current: number): number {
    if (option !== HOLD && current !== HOLD) return KEEP[turnSteps(option, current)];
    return option === HOLD && current === HOLD ? KEEP_HOLD : 0;
}

/** The senses as plain code. Channels: dobj, dthr, dcov, dlead, exp, wall, ally. */
export function senseRule(get: Getter): Vals {
    const out: Vals = {};
    const fields = [["go", 0], ["gt", 1], ["gc", 2], ["gl", 3]] as const;
    const bests: number[] = [];
    for (const [, ch] of fields) bests[ch] = Math.min(...DIRS.map(([dy, dx]) => get(ch, dy, dx)));
    for (const [g, ch] of fields) DIRS.forEach(([dy, dx], d) => (out[`${g}${d}`] = grade(get(ch, dy, dx), bests[ch])));
    DIRS.forEach(([dy, dx], d) => (out[`e${d}`] = get(4, dy, dx)));
    for (let d = 0; d < 8; d++) {
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (sector(dy, dx) === d) n += get(6, dy, dx);
        out[`n${d}`] = 3 - relu(3 - n);
    }
    DIRS.forEach(([dy, dx], d) => {
        const parts = [get(5, dy, dx), get(6, dy, dx)];
        if (dy && dx) parts.push(get(5, dy, 0), get(5, 0, dx));
        out[`b${d}`] = or(...parts);
    });
    out.es = get(4, 0, 0);
    out.gcs = grade(get(2, 0, 0), bests[2]);
    return out;
}

type C = Record<string, number | number[] | boolean>;
const num = (c: C, k: string) => c[k] as number;

/** k_d: spacing, inertia (over the o bits), blocked penalty, plus extra per-heading terms. */
function rest(x: Vals, spacing: number, big: number, extraHeading = 0): number[] {
    const k: number[] = [];
    for (let d = 0; d < 9; d++) {
        let v = 0;
        for (let o = 0; o < 9; o++) v += inertia(d, o) * (x[`o${o}`] ?? 0);
        if (d < 8) v += -spacing * x[`n${d}`] - big * x[`b${d}`] + extraHeading;
        k.push(v);
    }
    return k;
}

function headings(x: Vals, k: number[], fields: [number, string][], extra: (d: number) => number, hold: number): number {
    const s: number[] = [];
    for (let d = 0; d < 8; d++) { let v = k[d] + extra(d); for (const [w, f] of fields) v += w * x[`${f}${d}`]; s.push(v); }
    s.push(hold + k[8]);
    return argmax(s);
}

export function infantryRule(c: C, x: Vals): Vals {
    const m = (i: number) => x[`m${i}`];
    const empty = relu(1 - x.ammo);
    const fear = num(c, "f1") * relu(num(c, "knee1") - x.hp) + num(c, "f2") * relu(num(c, "knee2") - x.hp) + num(c, "fe") * empty + num(c, "fs") * x.supp;
    const ap = num(c, "approach");
    const approach = clip(x.dt - num(c, "range") - fear + 4 * m(1) - 6 * m(2) - 8 * m(3) - 12 * m(5) - 8 * m(6), -ap, ap);
    const obj = clip(3 * m(0) + 4 * m(1) + m(2) + 3 * m(4) + 5 * m(5) + 6 * m(6) - 2 * x.vis, 0, num(c, "obj"));
    const coh = clip(x.dl - num(c, "leash") + 4 * m(3) + 6 * x.call, 0, num(c, "coh"));
    const cover = clip(fear - num(c, "cover_from") + 2 * m(2) + 2 * m(5), 0, num(c, "cover"));
    const peek = clip(num(c, "peek") - fear, -num(c, "hide"), num(c, "peek"));
    const plant = num(c, "plant") * and(x.es, x.vis, ge(x.ammo, 1), le(x.dt, num(c, "fire")), ge(x.dt, num(c, "min_range"))) + 2 * m(2);
    const k = rest(x, num(c, "spacing"), num(c, "big"));
    const o = headings(x, k, [[approach, "gt"], [obj, "go"], [coh, "gl"], [cover, "gc"], [peek, "e"]], () => 0, cover * x.gcs + peek * x.es + plant);
    const out: Vals = {};
    oneHot("o2_", 9, o, out);
    out.fire = and(x.vis, ge(x.ammo, 1), le(x.dt, num(c, "fire")));
    out.reload = or(le(x.ammo, 0), and(not(x.vis), le(x.ammo, num(c, "reload_at"))));
    out.crouch = or(ge(fear, num(c, "crouch")), and(x.vis, ge(x.dt, 4)));
    out.grenade = and(x.gren, x.vis, le(x.dt, 6), ge(x.dt, 2));
    out.launch = and(x.hasl, x.armor, x.vis, le(x.dt, num(c, "launcher")));
    return out;
}

export function squadRule(x: Vals): Vals {
    const c = (i: number) => x[`c${i}`];
    const strength = x.alive + x.hp;
    const danger = min(x.contact, 6) + 3 * x.armor - 2 * x.farmor + x.supp;
    const s = [
        4 + min(x.dobj, 8) - 2 * min(x.contact, 3) - 3 * x.ow2 + 2 * c(0),
        select(and(le(x.dobj, 3), not(x.ow2)), 6 + min(x.contact, 3) + 2 * x.cont, 0) + 2 * c(1),
        3 * x.ow2 + 4 * and(x.ow2, or(x.cont, ge(x.contact, 1))) + 2 * and(x.ow2, le(x.dobj, 2)) + 2 * c(2),
        clip(x.spread - 4, 0, 6) + 14 * x.call + 3 * le(x.alive, 3) + 2 * c(3),
        select(and(ge(x.contact, 2), le(x.dobj, 8), ge(strength, 12), le(x.armor, 0)), 5 + min(x.contact, 3), 0) + 2 * c(4),
        clip(danger + 6 - strength, 0, 12) + 2 * c(5),
        7 * and(x.veh, ge(x.dobj, 10), not(x.mounted)) + 9 * and(x.mounted, ge(x.dobj, 4)) + 2 * c(6),
    ];
    const out: Vals = {};
    oneHot("mode", 7, argmax(s), out);
    return out;
}

export function strategicRule(x: Vals, slots = 12): Vals {
    const s: number[] = [];
    for (let k = 0; k < slots; k++) {
        const en = x[`en${k}`], ne = x[`ne${k}`], ours = 1 - en - ne, th = min(x[`fo${k}`], 3);
        s.push(3 * x[`val${k}`] + 5 * en + 3 * ne + 4 * and(x[`ct${k}`], ours) + 2 * th * ours - th * en - x[`d${k}`] - 3 * x[`fr${k}`] + 3 * x[`cur${k}`] - 60 * (1 - x[`v${k}`]));
    }
    const out: Vals = {};
    oneHot("a", slots, argmax(s), out);
    return out;
}

export function tankRule(c: C, x: Vals): Vals {
    const fear = num(c, "f1") * relu(5 - x.hp) + num(c, "f2") * relu(3 - x.hp) + num(c, "fa") * min(x.at, 3) + num(c, "ft") * min(x.tanks, 2);
    const ap = num(c, "approach");
    const approach = clip(x.tdist - num(c, "range") - fear - 6 * x.g2, -ap, ap);
    const obj = clip(num(c, "obj") - fear + 2 * x.g0 - 3 * x.g2, 0, num(c, "obj") + 2);
    const sup = x.g1 * clip(x.dl - 3, 0, 4);
    const cover = clip(fear - num(c, "cover_from") + 2 * min(x.tanks, 1), 0, num(c, "cover"));
    const peek = clip(num(c, "peek") - fear, -num(c, "hide"), num(c, "peek"));
    const plant = num(c, "plant") * and(x.es, x.vis, x.loaded, le(x.tdist, num(c, "fire"))) + 3 * x.g2;
    const k = rest(x, num(c, "spacing"), num(c, "big"));
    const o = headings(x, k, [[approach, "gt"], [obj, "go"], [sup, "gl"], [cover, "gc"], [peek, "e"]], () => 0, cover * x.gcs + peek * x.es + plant);
    const out: Vals = {};
    oneHot("o2_", 9, o, out);
    const prio = c.prio as number[];
    oneHot("tgt", 5, argmax([2 * prio[0] * ge(x.tanks, 1), 2 * prio[1] * ge(x.at, 1), 2 * prio[2] * ge(x.inf, 1), 2 * prio[3] * ge(x.air, 1), 1]), out);
    out.fire = and(x.vis, x.loaded, le(x.tdist, num(c, "fire")));
    out.coax = and(x.vis, ge(x.inf, 1), le(x.tdist, 16));
    out.smoke2 = and(x.smoke, or(ge(x.at, 2), and(le(x.hp, 4), x.vis)));
    return out;
}

export function apcRule(c: C, x: Vals): Vals {
    const fear = num(c, "f1") * relu(5 - x.hp) + num(c, "fa") * min(x.at, 3) + num(c, "ft") * min(x.tanks, 2) + min(x.pax, 3);
    const ap = num(c, "approach");
    const approach = clip(x.tdist - num(c, "range") - fear, -ap, ap);
    const deliver = clip(3 + min(x.pax, 3) - fear + 2 * le(x.wait, 0), 0, num(c, "deliver"));
    const pickup = select(le(x.pax, 0), clip(2 * min(x.wait, 3), 0, 6), 0);
    const cover = clip(fear - num(c, "cover_from"), 0, num(c, "cover"));
    const peek = clip(num(c, "peek") - fear, -num(c, "hide"), num(c, "peek"));
    const plant = 6 * and(x.near, ge(x.wait, 1)) + (c.gun ? num(c, "plant") * and(x.es, x.vis, le(x.tdist, num(c, "fire"))) : 0);
    const k = rest(x, num(c, "spacing"), num(c, "big"));
    const o = headings(x, k, [[approach, "gt"], [deliver, "go"], [pickup, "gl"], [cover, "gc"], [peek, "e"]], () => 0, cover * x.gcs + peek * x.es + plant);
    const out: Vals = {};
    oneHot("o2_", 9, o, out);
    out.dismount = and(ge(x.pax, 1), or(le(x.dobj, 2), and(le(x.tdist, 8), ge(x.inf, 1)), le(x.hp, 3)));
    out.fire = c.gun ? and(x.vis, le(x.tdist, num(c, "fire"))) : 0;
    out.atgm2 = and(x.atgm, x.vis, ge(x.tanks, 1), le(x.tdist, 40));
    out.smoke2 = and(x.smoke, x.vis, or(ge(x.at, 1), le(x.hp, 4)));
    return out;
}

export function heliRule(c: C, x: Vals): Vals {
    const fear = num(c, "f1") * relu(5 - x.hp) + num(c, "fa") * min(x.aa, 3) + 6 * x.lock;
    const obj = clip(num(c, "obj") - fear + 2 * x.q1 + 2 * x.q2, 0, num(c, "obj") + 2);
    const ap = num(c, "approach");
    const approach = x.q0 * clip(x.tdist - num(c, "range") - fear, -ap, ap);
    const cover = clip(fear - num(c, "cover_from"), 0, num(c, "cover"));
    const avoid = clip(2 * x.aa, 0, 4);
    const plant = 6 * and(or(x.q1, x.q2), le(x.dobj, 1)) + num(c, "plant") * and(x.q0, x.vis, le(x.tdist, num(c, "fire")));
    const k = rest(x, num(c, "spacing"), num(c, "big"));
    const o = headings(x, k, [[obj, "go"], [approach, "gt"], [cover, "gc"], [-avoid, "e"], [1, "r"]], () => 0, plant);
    const out: Vals = {};
    oneHot("o2_", 9, o, out);
    oneHot("alt", 3, argmax([2 * min(x.aa, 2) + 4 * le(x.dobj, 2) + 2 * and(x.q0, x.vis) + 2 * x.a0, 3 + 2 * x.a1, 4 * ge(x.dobj, 8) - 3 * min(x.aa, 2) - 3 * x.q0 + 2 * x.a2]), out);
    out.land = and(or(x.q1, x.q2), le(x.dobj, 1), x.lz, le(x.aa, 0));
    out.fire = and(x.vis, le(x.tdist, num(c, "fire")), or(x.q0, ge(x.tg, 1)));
    out.flare = and(x.lock, x.flares);
    return out;
}

export function jetRule(c: C, x: Vals): Vals {
    const s = [
        3 + 2 * x.p0,
        select(ge(x.ammo, 1), num(c, "ground") * x.tg + num(c, "air") * min(x.air, 1), 0) + 8 * x.payload - 2 * min(x.aa, 3) + 3 * x.p1,
        9 * and(x.p1, or(le(x.tdist, 1), le(x.alt, 1))) + 4 * and(x.p2, le(x.alt, 3)),
        8 * x.lock + 2 * min(x.aa, 3) + 2 * x.p3,
        7 * and(le(x.ammo, 0), le(x.payload, 0)) + 6 * le(x.hp, 3) + 2 * x.p4,
    ];
    const out: Vals = {};
    oneHot("phase", 5, argmax(s), out);
    out.fire = num(c, "fire") > 0 ? and(x.p1, ge(x.ammo, 1), le(x.tdist, num(c, "fire")), or(x.tg, ge(x.air, 1))) : 0;
    out.flare = and(x.lock, x.flares);
    out.drop = c.bombs ? or(and(x.payload, x.dz), and(x.p1, x.tg, le(x.tdist, 2), ge(x.ammo, 1))) : and(x.payload, x.dz);
    return out;
}

export function mechaRule(c: C, x: Vals): Vals {
    const fear = 3 * relu(2 - x.torso) + relu(2 - x.legs) + 2 * min(x.at, 3) + min(x.tanks, 2);
    const lame = relu(2 - x.legs);
    const ap = num(c, "approach");
    const approach = clip(x.tdist - num(c, "range") - fear, -ap, ap);
    const obj = clip(num(c, "obj") - fear, 0, num(c, "obj"));
    const cover = clip(fear - num(c, "cover_from"), 0, num(c, "cover"));
    const peek = clip(num(c, "peek") - fear, -num(c, "hide"), num(c, "peek"));
    const plant = num(c, "plant") * and(x.es, x.vis, le(x.tdist, num(c, "fire"))) + 2 * lame;
    const k = rest(x, 2, num(c, "big"), -lame);
    const o = headings(x, k, [[approach, "gt"], [obj, "go"], [cover, "gc"], [peek, "e"]], () => 0, cover * x.gcs + peek * x.es + plant);
    const out: Vals = {};
    oneHot("o2_", 9, o, out);
    const tp = ge(x.tanks, 1), ap2 = ge(x.at, 1), ip = ge(x.inf, 1), airp = ge(x.air, 1);
    const key = (pr: number[], avail: number) => select(avail, 2 * (pr[0] * tp + pr[1] * ap2 + pr[2] * ip + pr[3] * airp), -1);
    oneHot("wpn", 4, argmax([key(c.left as number[], ge(x.larm, 1)), key(c.right as number[], ge(x.rarm, 1)), key(c.shoulder as number[], ge(x.torso, 2)), 1]), out);
    out.brace = and(x.vis, or(ge(x.at, 2), le(x.torso, 1), ge(x.tanks, 2)));
    out.fire = and(x.vis, le(x.tdist, num(c, "fire")));
    return out;
}

/** The rule for any network by name. */
export function rule(wir: Wir, name: string, x: Vals): Vals {
    const n = wir.data.nets[name], c = n.consts;
    switch (n.kind) {
        case "infantry": return infantryRule(c, x);
        case "squad": return squadRule(x);
        case "strategic": return strategicRule(x, num(c, "slots"));
        case "tank": return tankRule(c, x);
        case "apc": return apcRule(c, x);
        case "heli": return heliRule(c, x);
        case "jet": return jetRule(c, x);
        case "mecha": return mechaRule(c, x);
        default: throw new Error(`no rule for ${name}`);
    }
}

/** Index of the hot bit among `${prefix}0..n-1` (-1 if none or several). */
export function hot(out: Vals, prefix: string, n: number): number {
    let k = -1;
    for (let i = 0; i < n; i++) if (out[`${prefix}${i}`] > 0.5) { if (k >= 0) return -1; k = i; }
    return k;
}
