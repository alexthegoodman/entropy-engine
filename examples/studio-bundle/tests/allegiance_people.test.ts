import { describe, expect, it } from "vitest";
import { buildHuman } from "../src/apps/mesha/mesha_human";
import { PeopleMeshes, PEOPLE_NAMESPACE, humanKey, humanParams, packHuman, coarseHuman, personLod, type PersonMesh, type PeopleCache } from "../src/games/allegiance/al_people";
import { MAT_CLOTH_TOP, MAT_CLOTH_BOTTOM, MAT_SKIN, MAT_HAIR } from "../src/games/allegiance/al_shader";

function cacheFixture() {
    const disk = new Map<string, PersonMesh>();
    const puts: string[] = [];
    const cache: PeopleCache = {
        status: (_ns, key) => disk.has(key) ? "ready" : "missing",
        get: (_ns, key) => disk.get(key) ?? null,
        put: (ns, key, mesh) => {
            expect(ns).toBe(PEOPLE_NAMESPACE); puts.push(key);
            disk.set(key, { vertexData: new Float32Array(mesh.vertexData), indexData: new Uint32Array(mesh.indexData) });
        },
        failure: () => null,
    };
    return { cache, disk, puts };
}

describe("Allegiance's Mesha humans", () => {
    it("uses every full-quality Mesha vertex, normal and triangle nearby, without changing the source", { timeout: 180_000 }, () => {
        for (const female of [false, true]) {
            const source = buildHuman(humanParams(female));
            const packed = packHuman(source);
            let v = 0, index = 0;
            for (const part of source.parts) {
                const base = v;
                for (let i = 0; i < part.positions.length / 3; i++, v++) {
                    for (let axis = 0; axis < 3; axis++) {
                        const sign = axis === 1 ? 1 : -1;
                        expect(packed.vertexData[v * 12 + axis]).toBe(Math.fround(part.positions[i * 3 + axis] * sign));
                        expect(packed.vertexData[v * 12 + 3 + axis]).toBe(Math.fround(part.normals[i * 3 + axis] * sign));
                    }
                }
                for (const i of part.indices) expect(packed.indexData[index++]).toBe(base + i);
            }
            expect(packed.vertexData.length).toBe(v * 12);
            expect(packed.indexData.length).toBe(index);
            for (const mat of [MAT_CLOTH_TOP, MAT_CLOTH_BOTTOM, MAT_SKIN, MAT_HAIR])
                expect(packed.vertexData.some((x, i) => i % 12 === 6 && Math.floor(x) === mat)).toBe(true);
            const draft = coarseHuman(packed, 0.012);
            const distant = coarseHuman(packed);
            expect(draft.indexData.length).toBeLessThan(packed.indexData.length);
            expect(distant.indexData.length).toBeLessThan(draft.indexData.length * 0.35);
            expect(distant.indexData.length).toBeGreaterThan(300);
            expect(Array.from(distant.vertexData).every(Number.isFinite)).toBe(true);
            console.log(`${female ? "female" : "male"} triangles: ${packed.indexData.length / 3}, ${draft.indexData.length / 3}, ${distant.indexData.length / 3}`);
        }
    });

    it("prepares humans during loading and reuses the disk cache after a new session", () => {
        const f = cacheFixture();
        const tiny: PersonMesh = { vertexData: new Float32Array([0, 0, 0, 0, 1, 0, 15.5, 0, 1, 1, 1, 1]), indexData: new Uint32Array() };
        let evaluations = 0;
        const people = new PeopleMeshes(f.cache, () => { evaluations++; return tiny; });
        let frames = 0;
        while (!people.prepare()) expect(++frames).toBeLessThan(10);
        expect(evaluations).toBe(2);
        expect(f.puts).toHaveLength(6);
        for (const female of [false, true]) for (const lod of [0, 1, 2] as const) expect(f.disk.has(humanKey(female, lod))).toBe(true);
        const fresh = new PeopleMeshes(f.cache, () => { throw new Error("must reuse disk"); });
        expect(fresh.prepare()).toBe(true);
        const look = { skin: [1, 1, 1], hair: [0, 0, 0], female: true, hat: false, soldier: false, sash: false, weapon: "none" } as const;
        const mutable = { ...look, skin: [...look.skin] as [number, number, number], hair: [...look.hair] as [number, number, number] };
        const key = fresh.ensure(mutable, 0);
        expect(key).not.toBeNull();
        const writes = f.puts.length;
        expect(fresh.ensure({ ...mutable, skin: [0.5, 0.4, 0.3], hair: [0.8, 0.6, 0.2] }, 0)).toBe(key);
        expect(f.puts.length).toBe(writes);
    });

    it("keeps full nearby detail and avoids switching repeatedly at distance boundaries", () => {
        expect(personLod(18, 2)).toBe(0);
        expect(personLod(21, 0)).toBe(0);
        expect(personLod(23, 0)).toBe(1);
        expect(personLod(60, 1)).toBe(1);
        expect(personLod(66, 1)).toBe(2);
        expect(personLod(55, 2)).toBe(1);
    });

    it("waits for disk writes and reports failures without regenerating a pending human", () => {
        const f = cacheFixture();
        let evaluations = 0;
        f.cache.status = () => "pending";
        const people = new PeopleMeshes(f.cache, () => { evaluations++; throw new Error("unexpected generation"); });
        expect(people.prepare()).toBe(false);
        expect(evaluations).toBe(0);
        f.cache.status = () => "missing";
        f.cache.failure = () => "disk is full";
        expect(() => people.prepare()).toThrow("disk is full");
        expect(evaluations).toBe(0);
    });
});
