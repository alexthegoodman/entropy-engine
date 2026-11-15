// World of Music: the islands are built so every puzzle needs the swarm it was made for.
import { describe, expect, it } from "vitest";
import { LEVELS, levelById } from "../src/games/world_of_music/wom_data";
import { Terrain, WALKER, type Mover } from "../src/games/world_of_music/wom_terrain";

const CLIMBER: Mover = { climb: true, fly: false, phase: false };
const PHASER: Mover = { climb: false, fly: true, phase: true };

function closeGates(t: Terrain, open: string[] = []) {
    t.blockers = t.level.gates.map(g => {
        const dx = Math.cos(g.angle) * g.len / 2, dz = Math.sin(g.angle) * g.len / 2;
        return { id: g.id, ax: g.x - dx, az: g.z - dz, bx: g.x + dx, bz: g.z + dz, open: open.includes(g.id) };
    });
}
const reach = (t: Terrain, to: [number, number], m: Mover = WALKER) => t.findPath(t.level.spawn, to, m, t.level.portals) !== null;

describe("World of Music islands", () => {
    it("every spawn stands on dry, walkable land", () => {
        for (const l of LEVELS) {
            const t = new Terrain(l);
            expect(t.height(...l.spawn)).toBeGreaterThan(0);
        }
    });

    it("Landfall Cove: the ridge needs both switches, the wallow needs the spire's lever, the spire needs claws", () => {
        const t = new Terrain(levelById("cove"));
        closeGates(t);
        const ridge = t.level.dark.find(d => d.id === "ridge")!, basin = t.level.dark.find(d => d.id === "basin")!, grove = t.level.dark.find(d => d.id === "grove")!;
        const lever = t.level.levers[0];
        expect(reach(t, [grove.x, grove.z])).toBe(true);
        for (const s of t.level.switches) expect(reach(t, [s.x, s.z])).toBe(true);
        expect(reach(t, [ridge.x, ridge.z])).toBe(false);
        expect(reach(t, [basin.x, basin.z])).toBe(false);
        expect(reach(t, [lever.x, lever.z])).toBe(false);
        expect(reach(t, [lever.x, lever.z], CLIMBER)).toBe(true);
        closeGates(t, ["ridge", "basin"]);
        expect(reach(t, [ridge.x, ridge.z])).toBe(true);
        expect(reach(t, [basin.x, basin.z])).toBe(true);
        expect(reach(t, t.level.exit)).toBe(true);
        for (const c of t.level.crates) expect(reach(t, [c.x, c.z], { climb: true, fly: false, phase: false }), `crate ${c.x},${c.z}`).toBe(true);
    });

    it("Canopy Falls: the ring switch is only for phasers, the terrace for the cliff lever", () => {
        const t = new Terrain(levelById("falls"));
        closeGates(t);
        const sw = t.level.switches[0], lever = t.level.levers[0];
        expect(reach(t, [sw.x, sw.z])).toBe(false);
        expect(reach(t, [sw.x, sw.z], CLIMBER)).toBe(false);
        expect(reach(t, [sw.x, sw.z], PHASER)).toBe(true);
        expect(reach(t, [lever.x, lever.z])).toBe(false);
        expect(reach(t, [lever.x, lever.z], CLIMBER)).toBe(true);
        const terrace = t.level.dark.find(d => d.id === "terrace")!, summit = t.level.dark.find(d => d.id === "summit")!;
        expect(reach(t, [terrace.x, terrace.z])).toBe(false);
        expect(reach(t, [summit.x, summit.z])).toBe(false);
        closeGates(t, ["terrace", "summit"]);
        expect(reach(t, [terrace.x, terrace.z])).toBe(true);
        expect(reach(t, [summit.x, summit.z])).toBe(true);
        expect(reach(t, t.level.exit)).toBe(true);
    });

    it("The Red Caldera: the rim gate keeps the Maw in until both switches hold", () => {
        const t = new Terrain(levelById("caldera"));
        closeGates(t);
        const maw = t.level.dark.find(d => d.id === "maw")!;
        expect(reach(t, [maw.x, maw.z])).toBe(false);
        expect(reach(t, [t.level.dark[0].x, t.level.dark[0].z])).toBe(true);
        expect(reach(t, [-70, 44], PHASER)).toBe(true);
        expect(reach(t, [-70, 44])).toBe(false);
        closeGates(t, ["rim"]);
        expect(reach(t, [maw.x, maw.z])).toBe(true);
    });
});
