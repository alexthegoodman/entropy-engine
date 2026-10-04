import { describe, expect, it } from "vitest";
import { CrowdBatches, PERSON_FLOATS, maybeVisible, type CrowdEngine } from "../src/games/allegiance/al_crowd";
import { PEOPLE_SHADER } from "../src/games/allegiance/al_shader";
import { budgetLods, PERSON_TRIANGLES, DEFAULT_PEOPLE_BUDGET, personLod, type PersonLod } from "../src/games/allegiance/al_people";

function fakeEngine(cached: Set<string>) {
    const buffers = new Map<string, { bytes: number; data: Float32Array | null }>();
    const meshes = new Map<string, { key: string; buffer: string; instances: number }>();
    const log = { writes: 0, creates: 0, counts: 0 };
    let next = 0;
    const engine: CrowdEngine = {
        createBuffer: bytes => { const id = `b${next++}`; buffers.set(id, { bytes, data: null }); return id; },
        destroyBuffer: id => { buffers.delete(id); },
        writeBuffer: (id, data) => {
            const b = buffers.get(id)!;
            expect(data.byteLength).toBeLessThanOrEqual(b.bytes);
            b.data = new Float32Array(data); log.writes++;
        },
        createMesh: (key, meshId, buffer, instances) => {
            if (!cached.has(key)) return false;
            meshes.set(meshId, { key, buffer, instances }); log.creates++; return true;
        },
        clearMesh: id => { meshes.delete(id); },
        setInstanceCount: (id, n) => { meshes.get(id)!.instances = n; log.counts++; },
    };
    return { engine, buffers, meshes, log };
}

function frame(crowd: CrowdBatches, people: [string, number][]) {
    crowd.begin();
    for (const [key, id] of people) {
        const { data, offset } = crowd.add(key);
        data.fill(id, offset, offset + PERSON_FLOATS);
    }
    return crowd.flush();
}

describe("instanced crowds", () => {
    it("draws every person of a body variant with one mesh and one upload", () => {
        const f = fakeEngine(new Set(["male0", "female1"]));
        const crowd = new CrowdBatches(f.engine, { initialCapacity: 4 });
        const people: [string, number][] = Array.from({ length: 10 }, (_, i) => [i % 3 ? "male0" : "female1", i + 1]);
        const s = frame(crowd, people);
        expect(s).toMatchObject({ drawnBatches: 2, instances: 10, uploads: 2 });
        expect(f.meshes.size).toBe(2);
        const male = [...f.meshes.values()].find(m => m.key === "male0")!;
        expect(male.instances).toBe(6);
        // Records are packed in order, one per instance.
        const data = f.buffers.get(male.buffer)!.data!;
        expect([...data.filter((_, i) => i % PERSON_FLOATS === 0)]).toEqual([2, 3, 5, 6, 8, 9]);

        // The next frame reuses the meshes: no creation, one write per batch, counts only when they change.
        f.log.creates = 0; f.log.counts = 0;
        frame(crowd, people.slice(0, 9));
        expect(f.log.creates).toBe(0);
        expect(f.log.counts).toBe(1);
    });

    it("grows a batch past its capacity and empties unused ones without destroying them", () => {
        const f = fakeEngine(new Set(["a", "b"]));
        const crowd = new CrowdBatches(f.engine, { initialCapacity: 2, idleFrames: 3 });
        frame(crowd, [["a", 1], ["b", 2]]);
        const s = frame(crowd, [["a", 1], ["a", 2], ["a", 3], ["a", 4], ["a", 5]]);
        expect(s.instances).toBe(5);
        const a = [...f.meshes.values()].find(m => m.key === "a")!;
        expect(a.instances).toBe(5);
        expect(f.buffers.get(a.buffer)!.bytes).toBeGreaterThanOrEqual(5 * PERSON_FLOATS * 4);
        // "b" draws nothing but keeps its mesh for a while, then goes.
        expect([...f.meshes.values()].find(m => m.key === "b")!.instances).toBe(0);
        for (let i = 0; i < 4; i++) frame(crowd, [["a", 1]]);
        expect([...f.meshes.values()].some(m => m.key === "b")).toBe(false);
        expect(f.buffers.size).toBe(1);
        crowd.clear();
        expect(f.meshes.size).toBe(0);
        expect(f.buffers.size).toBe(0);
    });

    it("reports a variant missing from the cache instead of drawing it", () => {
        const f = fakeEngine(new Set());
        const missing: string[] = [];
        const crowd = new CrowdBatches(f.engine, { onMissing: k => missing.push(k) });
        const s = frame(crowd, [["gone", 1]]);
        expect(s.instances).toBe(0);
        expect(missing).toEqual(["gone"]);
        expect(f.buffers.size).toBe(0);
    });

    it("culls only people certainly out of view", () => {
        const cam = [0, 0, 0], fwd = [0, 0, -1];
        expect(maybeVisible(cam, fwd, [0, 0, -20])).toBe(true);
        expect(maybeVisible(cam, fwd, [15, 0, -20])).toBe(true); // 37 degrees off axis
        expect(maybeVisible(cam, fwd, [0, 0, 20])).toBe(false); // behind
        expect(maybeVisible(cam, fwd, [40, 0, -1])).toBe(false); // far to the side
        expect(maybeVisible(cam, fwd, [0.5, 0, 1])).toBe(true); // close enough to touch
    });

    it("reads each person's record by instance index in both shader stages", () => {
        expect(PEOPLE_SHADER).toContain("var<storage, read> people: array<PersonRecord>");
        expect(PEOPLE_SHADER).toContain("@builtin(instance_index) instance: u32");
        expect(PEOPLE_SHADER).toContain("@location(7) @interpolate(flat) instance: u32");
        expect(PEOPLE_SHADER.match(/load_person\(in\.instance\)/g)?.length).toBe(2);
        expect(PEOPLE_SHADER).not.toContain("var<uniform> item: Item");
        // The record is the 32 floats al_crowd.ts packs.
        expect(PERSON_FLOATS).toBe(16 + 4 * 4);
    });
});

describe("the people triangle budget", () => {
    const cost = (lods: PersonLod[]) => lods.reduce((n, l) => n + PERSON_TRIANGLES[l], 0);

    it("leaves a quiet street as its distances ask", () => {
        const wanted: PersonLod[] = [0, 0, 1, 1, 1, 2, 2, 2, 2, 2];
        expect(budgetLods(wanted)).toEqual(wanted);
    });

    it("keeps a packed rally within budget, nearest people in the most detail", () => {
        // 80 listeners within 25 m: all want full or LOD 1 detail (~20M triangles).
        const wanted = Array.from({ length: 80 }, (_, i): PersonLod => personLod(4 + i * 0.26));
        expect(cost(wanted)).toBeGreaterThan(15_000_000);
        const lods = budgetLods(wanted);
        expect(cost(lods)).toBeLessThanOrEqual(DEFAULT_PEOPLE_BUDGET.triangleBudget + PERSON_TRIANGLES[2] * 80);
        expect(lods.filter(l => l === 0).length).toBe(DEFAULT_PEOPLE_BUDGET.maxFull);
        // Never more detail than wanted, and detail only falls with distance.
        lods.forEach((l, i) => { expect(l).toBeGreaterThanOrEqual(wanted[i]); if (i) expect(l).toBeGreaterThanOrEqual(lods[i - 1]); });
    });

    it("honors a small budget for slow machines", () => {
        const lods = budgetLods(Array(20).fill(0), { maxFull: 1, triangleBudget: 500_000 });
        expect(lods[0]).toBe(0);
        expect(lods.slice(1).every(l => l === 2 || l === 1)).toBe(true);
        expect(cost(lods)).toBeLessThanOrEqual(500_000 + PERSON_TRIANGLES[2] * 20);
    });
});
