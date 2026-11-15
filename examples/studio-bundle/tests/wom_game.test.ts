// World of Music: the simulation played directly (no engine).
import { describe, expect, it } from "vitest";
import { Game, NO_INPUT, newCampaign, type WomInput, type Swarm } from "../src/games/world_of_music/wom_game";
import { LEVELS, REVIVE_WINDOW, SPLIT_AT, traitPrice } from "../src/games/world_of_music/wom_data";
import { WirArena, brainRule, brainNet, senseNet, senseRule, pathCellRule, weightCount } from "../src/games/world_of_music/wom_wir";
import { WIR_DATA } from "../src/games/world_of_music/wom_wir_data";

const DT = 1 / 30;
function run(g: Game, seconds: number, input: Partial<WomInput> = {}, until?: () => boolean): number {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) { g.step(DT, { ...NO_INPUT, ...input }); if (until?.()) return i * DT; }
    return seconds;
}
const at = (g: Game, x: number, z: number): [number, number, number] => [x, g.terrain.surface(x, z), z];
const swarmOf = (g: Game, species: string) => g.swarms.find(s => s.species === species)!;
function send(g: Game, sw: Swarm, x: number, z: number) { g.selected = sw.id; return g.direct(at(g, x, z)); }
function teleportAll(g: Game, x: number, z: number) {
    g.tom.pos = at(g, x, z);
    for (const t of g.tones) t.pos = at(g, x + (Math.random() - 0.5) * 3, z + 2 + Math.random() * 2);
}

describe("WIR enemy networks", () => {
    it("the imported networks are the ones yumon-pet exported", () => {
        expect(WIR_DATA.brains.map(b => b.name)).toEqual(["grunt", "rusher", "sniper"]);
        expect(weightCount(WIR_DATA.sense.layers)).toBeGreaterThan(500);
    });
    it("fields, senses and brains match their rules on a live arena", () => {
        const g = new Game();
        const d = g.darks[0];
        d.arena.check = true;
        teleportAll(g, d.def.x, d.def.z + d.def.r + 4);
        for (const s of g.swarms) send(g, s, d.def.x, d.def.z);
        run(g, 12);
        const st = d.arena.stats;
        expect(st.decisions).toBeGreaterThan(50);
        expect(st.fieldDiff).toBe(0);
        expect(st.senseDiff).toBe(0);
        expect(st.netDiff).toBe(0);
        expect(st.unclean).toBe(0);
    });
    it("random sense and brain inputs agree with the rules", () => {
        const A = new WirArena(WIR_DATA, 9, 9, 0, 0, 1);
        let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
        for (let k = 0; k < 300; k++) {
            const ch = [Array.from({ length: 81 }, () => Math.floor(rnd() * 40)), Array.from({ length: 81 }, () => Math.floor(rnd() * 40)), Array.from({ length: 81 }, () => (rnd() < 0.5 ? 1 : 0)), Array.from({ length: 81 }, () => (rnd() < 0.15 ? 1 : 0)), Array.from({ length: 81 }, () => (rnd() < 0.2 ? 1 : 0))];
            const get = (c: number, dy: number, dx: number) => (dy === 0 && dx === 0 && c === 4 ? 0 : ch[c][(4 + dy) * 9 + 4 + dx]);
            const s = senseNet(WIR_DATA.sense, get);
            expect(s).toEqual(senseRule(get, WIR_DATA.consts.ally_cap));
            const x = { option: Math.floor(rnd() * 9), hp: 1 + Math.floor(rnd() * 12), ammo: Math.floor(rnd() * 7), cool: Math.floor(rnd() * 3), reload: Math.floor(rnd() * 5), s };
            for (const b of WIR_DATA.brains) expect(brainNet(b, x)).toEqual(brainRule(b, x));
            const pget = (c: number, dy: number, dx: number) => [ch[0], ch[3], ch[2], ch[4].map(v => 1 + v * 2)][c][(4 + dy) * 9 + 4 + dx];
            void A; void pathCellRule; void pget;
        }
    });
});

describe("directing swarms", () => {
    it("starts with three swarms of three: Thrum, Zing, Hop", () => {
        const g = new Game();
        expect(g.swarms.map(s => [s.species, g.tonesOf(s).length])).toEqual([["thrum", 3], ["zing", 3], ["hop", 3]]);
        expect(g.events.some(e => e.kind === "link")).toBe(true);
    });
    it("a click sends the selected swarm and selects the next one", () => {
        const g = new Game();
        expect(g.selected).toBe(0);
        expect(g.direct(at(g, 6, 66))).toBe(true);
        expect(g.selected).toBe(1);
        expect(g.swarms[0].order.kind).toBe("move");
        g.direct(at(g, -6, 66));
        expect(g.selected).toBe(2);
        g.direct(at(g, 0, 60));
        expect(g.selected).toBe(0);
        run(g, 6);
        const [x, z] = g.swarmCenter(g.swarms[0]);
        expect(Math.hypot(x - 6, z - 66)).toBeLessThan(3);
    });
    it("orders follow what is under the pointer: crate, tree, enemy", () => {
        const g = new Game();
        const c = g.crates[0], t = g.trees[0], e = g.enemies[0];
        expect(g.targetAt(at(g, c.x + 0.5, c.z)).kind).toBe("crate");
        expect(g.targetAt(at(g, t.x, t.z + 0.5)).kind).toBe("tree");
        expect(g.targetAt(e.pos).kind).toBe("attack");
    });
    it("a swarm breaks a crate and carries the relics home to Tom", () => {
        const g = new Game();
        const c = g.crates[0];
        send(g, g.swarms[0], c.x, c.z);
        run(g, 20, {}, () => c.broken);
        expect(c.broken).toBe(true);
        run(g, 25, {}, () => g.campaign.relics >= c.relics);
        expect(g.campaign.relics).toBe(c.relics);
    });
});

describe("growing Tones", () => {
    it("fruit shaken from a tree is eaten, and a Tone that eats enough splits in two", () => {
        const g = new Game();
        const sw = g.swarms[0], tree = g.trees.find(t => t.fruit >= 4)!;
        teleportAll(g, tree.x, tree.z + 6);
        send(g, sw, tree.x, tree.z);
        run(g, 40, {}, () => g.tonesOf(sw).length > 3);
        expect(g.campaign.stats.fed).toBeGreaterThanOrEqual(SPLIT_AT);
        expect(g.tonesOf(sw).length).toBe(4);
        expect(g.events.some(e => e.kind === "split")).toBe(true);
    });
    it("a fallen Tone can be revived within the window, and passes away after it", () => {
        const g = new Game();
        const [a, b] = g.tonesOf(g.swarms[1]);
        g.hurtTone(a, 999);
        expect(a.state).toBe("faded");
        a.pos = at(g, g.tom.pos[0] + 1, g.tom.pos[2]);
        run(g, 2);
        expect(a.state).toBe("ok");
        g.hurtTone(b, 999);
        b.pos = at(g, g.tom.pos[0] + 30, g.tom.pos[2]);
        for (const t of g.tonesOf(g.swarms[1])) if (t !== b) t.pos = at(g, g.tom.pos[0] - 4, g.tom.pos[2]);
        g.recall(g.swarms[1]);
        run(g, REVIVE_WINDOW + 1);
        expect(g.tones.includes(b)).toBe(false);
        expect(g.campaign.stats.lost).toBe(1);
    });
});

describe("puzzles", () => {
    it("Landfall Cove: two swarms of weight three hold the ridge gate open", () => {
        const g = new Game();
        const [w, e] = g.switches;
        send(g, g.swarms[0], w.x, w.z);
        const gate = g.gates.find(x => x.id === "ridge")!;
        run(g, 25, {}, () => w.weight >= 3);
        expect(w.weight).toBeGreaterThanOrEqual(3);
        expect(gate.open).toBe(false);
        send(g, g.swarms[1], e.x, e.z);
        run(g, 25, {}, () => gate.open);
        expect(gate.open).toBe(true);
        g.recall(g.swarms[1]);
        run(g, 6);
        expect(gate.open).toBe(false);
    });
    it("only the Hop swarm (claws) can reach the spire's lever, and the lever opens the wallow for good", () => {
        const g = new Game();
        const lever = g.levers[0];
        teleportAll(g, lever.x - 22, lever.z + 4);
        expect(send(g, swarmOf(g, "thrum"), lever.x, lever.z)).toBe(false);
        expect(send(g, swarmOf(g, "hop"), lever.x, lever.z)).toBe(true);
        run(g, 30, {}, () => lever.flipped);
        expect(lever.flipped).toBe(true);
        run(g, 1);
        expect(g.gates.find(x => x.id === "basin")!.open).toBe(true);
    });
    it("Canopy Falls: a phasing swarm walks the ring to the walled switch", () => {
        const c = newCampaign();
        c.level = "falls"; c.unlocked.push("lull");
        c.swarms.push({ species: "lull", traits: {}, tones: 3, growth: [0, 0, 0] });
        const g = new Game(c);
        const sw = g.switches[0], lull = swarmOf(g, "lull");
        expect(send(g, swarmOf(g, "zing"), sw.x, sw.z)).toBe(false);
        expect(send(g, lull, sw.x, sw.z)).toBe(true);
        run(g, 40, {}, () => sw.weight >= sw.need);
        expect(sw.weight).toBeGreaterThanOrEqual(3);
        expect(g.events.some(e => e.kind === "portal")).toBe(true);
    });
});

describe("the stall", () => {
    it("relics sell for chimes and chimes buy traits", () => {
        const g = new Game();
        g.campaign.relics = 8;
        expect(g.sell()).toBe(80);
        const price = traitPrice("thrum", {}, "tempo")!;
        expect(g.buy(0, "tempo").ok).toBe(true);
        expect(g.campaign.chimes).toBe(80 - price);
        expect(g.swarms[0].stats.speed).toBeGreaterThan(6.2);
        expect(g.buy(0, "claws").ok).toBe(false);
        g.campaign.chimes = 500;
        expect(g.buy(0, "claws").ok).toBe(true);
        expect(g.swarms[0].mover.climb).toBe(true);
    });
});

describe("the Red Corruption", () => {
    it("swarms clear the Smudged Grove and sing its heart pure", () => {
        const g = new Game();
        const d = g.darks[0];
        teleportAll(g, d.def.x + 4, d.def.z + d.def.r + 2);
        g.tom.hp = 1e6; g.tom.maxHp = 1e6;
        for (const t of g.tones) t.hp = 400;
        for (let i = 0; i < 160 && !d.purified; i++) {
            const foe = g.enemies.find(e => e.alive && e.dark === d.idx);
            for (const s of g.swarms) if (s.order.kind !== "attack" && s.order.kind !== "heart") send(g, s, foe ? foe.pos[0] : d.def.x, foe ? foe.pos[2] : d.def.z);
            run(g, 1);
            for (const t of g.tones) t.hp = Math.max(t.hp, 300);
        }
        expect(d.purified).toBe(true);
        expect(g.campaign.stats.defeated).toBeGreaterThanOrEqual(4);
        expect(g.events.some(e => e.kind === "purified")).toBe(true);
    });
    it("enemies move, shoot and hurt the swarms they find", () => {
        const g = new Game();
        const d = g.darks[0];
        teleportAll(g, d.def.x, d.def.z + d.def.r - 4);
        const start = g.enemies.filter(e => e.dark === 0).map(e => [...e.pos]);
        let shots = 0;
        for (let i = 0; i < 300; i++) { g.step(DT, NO_INPUT); shots += g.events.filter(e => e.kind === "shot" && e.foe).length; g.events = []; }
        const moved = g.enemies.filter(e => e.dark === 0).some((e, i) => Math.hypot(e.pos[0] - start[i][0], e.pos[2] - start[i][2]) > 1);
        expect(moved).toBe(true);
        expect(shots).toBeGreaterThan(0);
    });
});

describe("the campaign", () => {
    it("purifying every heart opens the song gate; walking in finishes the island", () => {
        const g = new Game();
        for (const d of g.darks) { d.heart = 0.001; if (d.boss) { d.boss.anchors.forEach(a => (a.hp = 0)); } }
        for (const d of g.darks) (g as unknown as { purify(d: unknown): void }).purify(d);
        run(g, 0.2);
        expect(g.exitOpen).toBe(true);
        g.tom.pos = at(g, ...g.level.exit);
        run(g, 0.2);
        expect(g.complete).toBe(true);
        expect(g.advance()).toBe(true);
        expect(g.level.id).toBe(LEVELS[1].id);
        expect(g.swarms.length).toBeGreaterThanOrEqual(4);
    });
});
