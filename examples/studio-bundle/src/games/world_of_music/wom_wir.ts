// World of Music's enemies think with WIR: networks written as programs in Yumon Pet's WIR
// language, compiled to ReLU weights and proven exact against their rules (yumon-pet/wir,
// docs/WIR.md "Tactical enemies and response curves"). This file is the runtime: it evaluates
// those weights (wom_wir_data.ts) on a grid laid over each corrupted arena.
//
// Every tick of an arena (a few per second):
//   1. exposure: which open cells the friends (Agent Tom and the Tones) can see;
//   2. two distance fields, each a WIR stencil network run at every cell (the 8-move path step):
//      `dp` to the nearest friend (ally cells cost 3 to leave, so packs spread) and `dc` to cover
//      (open cells no friend can see);
//   3. at every enemy's cell the senses network reads a 5 x 5 window of the fields;
//   4. the enemy's brain network (grunt, rusher or sniper) turns senses, hp, ammo and its current
//      heading into one of 8 headings or hold, and whether to fire or reload.
// The game moves enemies smoothly toward the chosen neighbour cell between ticks.
//
// The rules the networks were compiled from are here too (`*Rule`), so tests can check the
// networks against them cell for cell, as yumon-pet's `tactics_check` does.

export interface WirLayer { b: number[]; rows: number[][] }
export interface WirStencil { taps: number[][]; pads: number[]; layers: WirLayer[] }
export interface WirBrain {
    name: string;
    range: number; fire_range: number; min_range: number;
    knee1: number; f1: number; knee2: number; f2: number; fe: number;
    approach: number; cover_from: number; cover: number; peek: number; hide: number; plant: number; spacing: number;
    keep: number[]; keep_hold: number; reload_at: number; damage: number; big: number;
    layers: WirLayer[];
}
export interface WirData {
    consts: { ally_cap: number; ally_cost: number; ammo: number; ceiling: number; cool: number; field_iters: number; hp: number; reload: number; regen: number; respawn: number; player_cool: number; player_reach: number; player_damage: number };
    path: WirStencil;
    sense: WirStencil;
    brains: WirBrain[];
}

/** E NE N NW W SW S SE as [dRow, dCol]: row grows toward +z, so "N" is -z. */
export const DIRS: readonly [number, number][] = [[0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1]];
export const HOLD = 8;

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

/** Non-zero weights in a network (what it costs to run). */
export const weightCount = (layers: readonly WirLayer[]): number => layers.reduce((s, l) => s + l.rows.reduce((t, r) => t + r.length / 2, 0), 0);

export type Getter = (channel: number, dy: number, dx: number) => number;

// --- the rules (plain code), for checks -------------------------------------------------------

export function pathCellRule(get: Getter, ceiling: number): number {
    if (get(2, 0, 0) === 1) return 0;
    if (get(1, 0, 0) === 1) return ceiling;
    const c = get(3, 0, 0);
    let best = ceiling;
    for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) best = Math.min(best, 2 * c + get(0, dy, dx));
    for (const [dy, dx] of [[-1, 1], [-1, -1], [1, 1], [1, -1]]) if (get(1, dy, 0) === 0 && get(1, 0, dx) === 0) best = Math.min(best, 3 * c + get(0, dy, dx));
    return best;
}

function sector(dy: number, dx: number): number {
    if (dy === 0 && dx === 0) return -1;
    const a = (Math.atan2(-dy, dx) * 180) / Math.PI;
    return ((Math.floor((a + 18) / 45) % 8) + 8) % 8;
}
const grade = (v: number, best: number) => (v - best <= 1 ? 1 : 0) - (v - best >= 4 ? 1 : 0);

/** The 43 senses: gp[8] gc[8] e[8] n[8] b[8], dps, es, gcs. Channels: dp, dc, exp, wall, ally. */
export function senseRule(get: Getter, allyCap: number): number[] {
    const s: number[] = [];
    const best = (ch: number) => Math.min(...DIRS.map(([dy, dx]) => get(ch, dy, dx)));
    const mp = best(0), mc = best(1);
    for (const [dy, dx] of DIRS) s.push(grade(get(0, dy, dx), mp));
    for (const [dy, dx] of DIRS) s.push(grade(get(1, dy, dx), mc));
    for (const [dy, dx] of DIRS) s.push(get(2, dy, dx));
    for (let d = 0; d < 8; d++) {
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (sector(dy, dx) === d) n += get(4, dy, dx);
        s.push(Math.min(n, allyCap));
    }
    for (const [dy, dx] of DIRS) {
        let b = get(3, dy, dx) === 1 || get(4, dy, dx) === 1 || get(0, dy, dx) <= 0;
        if (dy !== 0 && dx !== 0) b = b || get(3, dy, 0) === 1 || get(3, 0, dx) === 1;
        s.push(b ? 1 : 0);
    }
    s.push(mp, get(2, 0, 0), grade(get(1, 0, 0), mc));
    return s;
}

export interface BrainInput { option: number; hp: number; ammo: number; cool: number; reload: number; s: number[] }
export type Plan = [option: number, fire: boolean, reload: boolean];

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const turnSteps = (a: number, b: number) => { const t = (a + 8 - b) % 8; return Math.min(t, 8 - t); };

/** The response curves a brain was written with (fear, approach, cover, peek, plant). */
export function drives(a: WirBrain, x: BrainInput) {
    const dp = x.s[40], e = x.s[41];
    const empty = x.ammo <= 0 ? 1 : 0;
    const fear = a.f1 * Math.max(0, a.knee1 - x.hp) + a.f2 * Math.max(0, a.knee2 - x.hp) + a.fe * empty;
    return {
        fear,
        approach: clampN(dp - a.range - fear, -a.approach, a.approach),
        cover: clampN(fear - a.cover_from, 0, a.cover),
        peek: clampN(a.peek - fear, -a.hide, a.peek),
        plant: e === 1 && x.ammo >= 1 && dp <= a.fire_range && dp >= a.min_range ? a.plant : 0,
    };
}

export function brainRule(a: WirBrain, x: BrainInput): Plan {
    const dv = drives(a, x), s = x.s, sc: number[] = [];
    const inertia = (option: number) => option !== HOLD && x.option !== HOLD ? a.keep[turnSteps(option, x.option)] : option === HOLD && x.option === HOLD ? a.keep_hold : 0;
    for (let d = 0; d < 8; d++) sc.push(dv.approach * s[d] + dv.cover * s[8 + d] + (s[16 + d] === 1 ? dv.peek : 0) - a.spacing * s[24 + d] + inertia(d) - a.big * s[32 + d]);
    sc.push(dv.cover * s[42] + (s[41] === 1 ? dv.peek : 0) + dv.plant + inertia(HOLD));
    let best = 0;
    for (let d = 1; d < 9; d++) if (9 * sc[d] + (8 - d) > 9 * sc[best] + (8 - best)) best = d;
    const fire = s[41] === 1 && x.ammo >= 1 && x.cool <= 0 && s[40] <= a.fire_range;
    const reload = x.reload <= 0 && (x.ammo <= 0 || (s[41] === 0 && x.ammo <= a.reload_at));
    return [best, fire, reload];
}

// --- the networks ---------------------------------------------------------------------------

export function senseNet(net: WirStencil, get: Getter): number[] {
    const x = new Float64Array(net.taps.length);
    for (let k = 0; k < net.taps.length; k++) { const t = net.taps[k]; x[k] = get(t[0], t[1], t[2]); }
    return Array.from(evalNet(net.layers, x), v => Math.round(v));
}

/** The brain network's plan, or null if its outputs are not a clean one-hot (never seen: checked exact). */
export function brainNet(a: WirBrain, x: BrainInput): Plan | null {
    const v: number[] = [];
    for (let k = 0; k < 9; k++) v.push(k === x.option ? 1 : 0);
    v.push(x.hp, x.ammo, x.cool, x.reload, ...x.s);
    const out = evalNet(a.layers, v);
    const bit = (z: number) => (Math.abs(z) < 1e-6 ? 0 : Math.abs(z - 1) < 1e-6 ? 1 : -1);
    const bits = Array.from(out, bit);
    const hot: number[] = [];
    for (let k = 0; k < 9; k++) if (bits[k] === 1) hot.push(k);
    if (bits.includes(-1) || hot.length !== 1) return null;
    return [hot[0], bits[9] === 1, bits[10] === 1];
}

// --- the arena ------------------------------------------------------------------------------

/** One enemy as the arena sees it (the game owns the rest). */
export interface ArenaAgent { r: number; c: number; option: number; hp: number; ammo: number; cool: number; reload: number; brain: number }

export interface ArenaStats { ticks: number; decisions: number; fieldCells: number; checked: number; senseDiff: number; netDiff: number; fieldDiff: number; unclean: number }

/**
 * A grid of `rows` x `cols` cells of `cell` metres laid over the world with its corner at
 * (x0, z0). Row r spans z0 + r * cell; column c spans x0 + c * cell.
 */
export class WirArena {
    readonly n: number;
    wall: Int8Array;
    exp: Int8Array;
    dp: Float64Array;
    dc: Float64Array;
    /** Check every cell and decision against the rules (tests, and the debug overlay). */
    check = false;
    stats: ArenaStats = { ticks: 0, decisions: 0, fieldCells: 0, checked: 0, senseDiff: 0, netDiff: 0, fieldDiff: 0, unclean: 0 };

    constructor(readonly data: WirData, readonly rows: number, readonly cols: number, readonly x0: number, readonly z0: number, readonly cell: number) {
        this.n = rows * cols;
        this.wall = new Int8Array(this.n);
        this.exp = new Int8Array(this.n);
        this.dp = new Float64Array(this.n).fill(data.consts.ceiling);
        this.dc = new Float64Array(this.n).fill(data.consts.ceiling);
    }

    at(r: number, c: number): number { return r >= 0 && c >= 0 && r < this.rows && c < this.cols ? r * this.cols + c : -1; }
    open(r: number, c: number): boolean { const i = this.at(r, c); return i >= 0 && this.wall[i] === 0; }
    cellOf(x: number, z: number): [number, number] { return [Math.floor((z - this.z0) / this.cell), Math.floor((x - this.x0) / this.cell)]; }
    center(r: number, c: number): [number, number] { return [this.x0 + (c + 0.5) * this.cell, this.z0 + (r + 0.5) * this.cell]; }
    contains(x: number, z: number): boolean { const [r, c] = this.cellOf(x, z); return this.at(r, c) >= 0; }
    /** The nearest open cell to (r, c) (enemies are pushed off walls this way). */
    nearestOpen(r: number, c: number): [number, number] {
        r = Math.max(0, Math.min(this.rows - 1, r)); c = Math.max(0, Math.min(this.cols - 1, c));
        if (this.open(r, c)) return [r, c];
        for (let k = 1; k < Math.max(this.rows, this.cols); k++)
            for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++)
                if (Math.max(Math.abs(dy), Math.abs(dx)) === k && this.open(r + dy, c + dx)) return [r + dy, c + dx];
        return [r, c];
    }

    sight(a: [number, number], b: [number, number]): boolean {
        const n = 4 * Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
        for (let k = 1; k < n; k++) {
            const y = Math.floor((2 * a[0] * n + 2 * (b[0] - a[0]) * k + n) / (2 * n));
            const x = Math.floor((2 * a[1] * n + 2 * (b[1] - a[1]) * k + n) / (2 * n));
            if (!this.open(y, x)) return false;
        }
        return true;
    }

    private stencilAt(net: WirStencil, fields: ArrayLike<number>[], r: number, c: number): Float64Array {
        const x = new Float64Array(net.taps.length);
        for (let k = 0; k < net.taps.length; k++) {
            const [ch, dy, dx] = net.taps[k], i = this.at(r + dy, c + dx);
            x[k] = i < 0 ? net.pads[ch] : fields[ch][i];
        }
        return evalNet(net.layers, x);
    }

    private fieldStep(d: Float64Array, goal: Float64Array, cost: Float64Array): Float64Array {
        const fields = [d, this.wall, goal, cost], out = new Float64Array(this.n), net = this.data.path;
        for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
            const v = Math.round(this.stencilAt(net, fields, r, c)[0]);
            out[r * this.cols + c] = v;
            this.stats.fieldCells++;
            if (this.check) {
                const get: Getter = (ch, dy, dx) => { const i = this.at(r + dy, c + dx); return i < 0 ? net.pads[ch] : fields[ch][i]; };
                if (pathCellRule(get, this.data.consts.ceiling) !== v) this.stats.fieldDiff++;
            }
        }
        return out;
    }

    /** Exposure and both fields, for friends standing at these cells and these enemies. */
    updateFields(friends: [number, number][], agents: readonly ArenaAgent[]): void {
        const inside = friends.filter(f => this.at(f[0], f[1]) >= 0);
        for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
            const i = r * this.cols + c;
            this.exp[i] = this.wall[i] === 0 && inside.some(f => this.sight(f, [r, c])) ? 1 : 0;
        }
        const goalP = new Float64Array(this.n), goalC = new Float64Array(this.n);
        for (const f of friends) {
            // A friend outside the grid pulls from the nearest edge cell toward it.
            const r = Math.max(0, Math.min(this.rows - 1, f[0])), c = Math.max(0, Math.min(this.cols - 1, f[1]));
            const [or, oc] = this.nearestOpen(r, c);
            goalP[this.at(or, oc)] = 1;
        }
        for (let i = 0; i < this.n; i++) goalC[i] = this.wall[i] === 0 && this.exp[i] === 0 ? 1 : 0;
        const ally = this.allyGrid(agents);
        const cost = ally.map(a => (a === 1 ? this.data.consts.ally_cost : 1)), flat = new Float64Array(this.n).fill(1);
        for (let k = 0; k < this.data.consts.field_iters; k++) {
            this.dp = this.fieldStep(this.dp, goalP, cost);
            this.dc = this.fieldStep(this.dc, goalC, flat);
        }
    }

    allyGrid(agents: readonly ArenaAgent[]): Float64Array {
        const g = new Float64Array(this.n);
        for (const e of agents) { const i = this.at(e.r, e.c); if (i >= 0) g[i] = 1; }
        return g;
    }

    reader(ally: Float64Array, r: number, c: number): Getter {
        const ch = [this.dp, this.dc, this.exp, this.wall, ally], pads = this.data.sense.pads;
        return (k, dy, dx) => {
            const i = this.at(r + dy, c + dx);
            if (i < 0) return pads[k];
            if (k === 4 && dy === 0 && dx === 0) return 0;
            return ch[k][i];
        };
    }

    /** One decision per agent, by the networks (and checked against the rules when `check`). */
    decide(agents: readonly ArenaAgent[]): Plan[] {
        const ally = this.allyGrid(agents);
        this.stats.ticks++;
        return agents.map(e => {
            const get = this.reader(ally, e.r, e.c);
            const s = senseNet(this.data.sense, get);
            const x: BrainInput = { option: e.option, hp: Math.max(1, Math.min(this.data.consts.hp, Math.round(e.hp))), ammo: e.ammo, cool: e.cool, reload: e.reload, s };
            const a = this.data.brains[e.brain];
            let plan = brainNet(a, x);
            this.stats.decisions++;
            if (!plan) { this.stats.unclean++; plan = [HOLD, false, false]; }
            if (this.check) {
                this.stats.checked++;
                const want = senseRule(get, this.data.consts.ally_cap);
                if (want.some((v, i) => v !== s[i])) this.stats.senseDiff++;
                const r = brainRule(a, { ...x, s: want });
                if (r[0] !== plan[0] || r[1] !== plan[1] || r[2] !== plan[2]) this.stats.netDiff++;
            }
            return plan;
        });
    }

    /** Where heading `option` from (r, c) leads, or null if a wall, a corner or the grid edge stops it. */
    step(r: number, c: number, option: number): [number, number] | null {
        if (option >= 8) return null;
        const [dy, dx] = DIRS[option], y = r + dy, x = c + dx;
        if (!this.open(y, x)) return null;
        if (dy !== 0 && dx !== 0 && !(this.open(y, c) && this.open(r, x))) return null;
        return [y, x];
    }
}
