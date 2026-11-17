// Armageddon 2070: every WIR network against its rule written as plain TypeScript (ar_wir.ts), on
// random in-domain inputs, and the senses stencil against senseRule on random windows.
import { describe, expect, it } from "vitest";
import { AR_WIR } from "../src/games/armageddon/ar_wir_data";
import { Wir, rule, senseRule, hot, SENSE_NAMES, type Vals } from "../src/games/armageddon/ar_wir";

const wir = new Wir(AR_WIR);
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

/** Random inputs; one-hot groups get exactly one bit; strategic slots keep en + ne <= 1. */
function sample(name: string): Vals {
    const n = AR_WIR.nets[name], x: Vals = {};
    n.inputs.forEach((k, i) => { const [lo, hi] = n.ranges[i]; x[k] = rnd() < 0.3 ? (rnd() < 0.5 ? lo : hi) : int(lo, hi); });
    for (const [p, len] of [["o", 9], ["m", 7], ["c", 7], ["g", 3], ["q", 3], ["a", 3], ["p", 5], ["ow", 3]] as const) {
        if (!n.inputs.includes(`${p}0`) || !n.inputs.includes(`${p}${len - 1}`)) continue;
        if (n.kind === "strategic") continue;
        const h = int(0, len - 1);
        for (let i = 0; i < len; i++) x[`${p}${i}`] = i === h ? 1 : 0;
    }
    if (n.kind === "strategic") for (let k = 0; k < 12; k++) { if (x[`en${k}`] && x[`ne${k}`]) x[`ne${k}`] = 0; }
    return x;
}

describe("Armageddon WIR networks", () => {
    it("has every brain the design database names", () => {
        const names = Object.keys(AR_WIR.nets);
        for (const n of ["ar_rifle_brain", "ar_support_brain", "ar_marksman_brain", "ar_antiarmor_brain", "ar_squad_brain", "ar_strategic_brain", "ar_tank_mbt", "ar_tank_destroyer", "ar_apc_apc", "ar_apc_ifv", "ar_heli_attack", "ar_heli_transport", "ar_jet_fighter", "ar_jet_attack", "ar_jet_transport", "ar_mecha_titan", "ar_mecha_wraith", "ar_mecha_bastion"]) expect(names).toContain(n);
        expect(AR_WIR.sense.outputs).toEqual(SENSE_NAMES);
    });

    for (const name of Object.keys(AR_WIR.nets)) {
        it(`${name} matches its rule on 3,000 random inputs`, () => {
            let bad = 0, first = "";
            for (let i = 0; i < 3000; i++) {
                const x = sample(name), net = wir.run(name, x), want = rule(wir, name, x);
                for (const [k, v] of Object.entries(want)) if (Math.abs((net[k] ?? NaN) - v) > 1e-6) { bad++; if (!first) first = `${k}: net ${net[k]} rule ${v} at ${JSON.stringify(x)}`; break; }
            }
            expect(bad, first).toBe(0);
        });
    }

    it("the senses stencil matches senseRule on 5,000 random windows", () => {
        const pads = AR_WIR.sense.pads;
        let bad = 0, first = "";
        for (let i = 0; i < 5000; i++) {
            const grid: number[][][] = [];
            for (let c = 0; c < 7; c++) { grid[c] = []; for (let y = 0; y < 5; y++) { grid[c][y] = []; for (let xx = 0; xx < 5; xx++) grid[c][y][xx] = c < 4 ? (rnd() < 0.1 ? 48 : int(10, 22)) : rnd() < (c === 5 ? 0.15 : 0.25) ? 1 : 0; } }
            const get = (c: number, dy: number, dx: number) => (Math.abs(dy) > 2 || Math.abs(dx) > 2 ? pads[c] : grid[c][dy + 2][dx + 2]);
            const net = wir.senses(get), want = senseRule(get);
            for (const k of SENSE_NAMES) if (net[k] !== want[k]) { bad++; if (!first) first = `${k}: ${net[k]} vs ${want[k]}`; break; }
        }
        expect(bad, first).toBe(0);
    });

    it("an exposed, hurt rifleman under fire steps toward cover; a calm one in assault steps toward the threat", () => {
        const base = sample("ar_rifle_brain");
        for (const k of Object.keys(base)) if (/^(o|m|g[otcl]|e|n|b)\d/.test(k)) base[k] = 0;
        Object.assign(base, { o8: 1, ammo: 5, supp: 0, call: 0, dt: 20, vis: 1, armor: 0, dl: 0, gren: 0, hasl: 0, es: 1, gcs: -1 });
        // East is toward the threat, west toward cover.
        for (let d = 0; d < 8; d++) { base[`gt${d}`] = d === 0 ? 1 : -1; base[`gc${d}`] = d === 4 ? 1 : -1; }
        const calm = wir.run("ar_rifle_brain", { ...base, hp: 10, m1: 1, vis: 0, es: 0 });
        const planted = wir.run("ar_rifle_brain", { ...base, hp: 10, m1: 1 });
        expect(hot(planted, "o2_", 9)).toBe(8);
        expect(planted.fire).toBe(1);
        const hurt = wir.run("ar_rifle_brain", { ...base, hp: 2, supp: 4, m2: 1 });
        expect(hot(calm, "o2_", 9)).toBe(0);
        expect(hot(hurt, "o2_", 9)).toBe(4);
    });
});
