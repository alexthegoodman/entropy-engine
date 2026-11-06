// The Detailer's hand-off package: GLB and PNG encoders that read back, and a package whose scene,
// models, heightmaps and lore agree with each other.
import { describe, expect, it } from "vitest";
import { createSampleWorld } from "../src/apps/game_detailer/detail_sample";
import { Ground } from "../src/apps/game_detailer/detail_ground";
import { detailOf } from "../src/apps/game_detailer/detail_types";
import { buildPackage, crc32, encodeGlb, encodePng, modelGlb, readGlbJson, type ArchiveEntry } from "../src/apps/game_detailer/detail_export";
import { ModelStore, type ModelEngine } from "../src/apps/game_detailer/detail_jobs";
import { budgetLods, chooseLod, maybeVisible, packRecord, ViewChange, yawOf, yawQuat } from "../src/apps/game_detailer/detail_view";
import { DETAIL_SHADER, RECORD_FLOATS } from "../src/apps/game_detailer/detail_shader";

function run<T>(gen: Generator<unknown, T, void>): T {
    let n = gen.next();
    while (!n.done) n = gen.next();
    return n.value;
}

describe("encoders", () => {
    it("crc32 matches the reference value", () => {
        expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    });

    it("writes PNGs with valid chunks", () => {
        const png = encodePng(3, 2, [0, 1000, 65535, 3, 4, 5], 1, 16);
        expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        const dv = new DataView(png.buffer);
        // IHDR: 3 x 2, 16-bit gray.
        expect(dv.getUint32(16)).toBe(3);
        expect(dv.getUint32(20)).toBe(2);
        expect(png[24]).toBe(16);
        expect(png[25]).toBe(0);
        // Every chunk's CRC is right.
        let o = 8;
        while (o < png.length) {
            const len = dv.getUint32(o);
            expect(dv.getUint32(o + 8 + len)).toBe(crc32(png, o + 4, o + 8 + len));
            o += 12 + len;
        }
        expect(o).toBe(png.length);
    });

    it("writes GLBs that are valid glTF 2.0", () => {
        const glb = encodeGlb("tri", [{ name: "a", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2], material: { name: "m", color: [1, 0.5, 0], metallic: 0, roughness: 0.5 } }]);
        expect(glb.length % 4).toBe(0);
        const json = readGlbJson(glb);
        expect(json.asset.version).toBe("2.0");
        expect(json.meshes[0].primitives.length).toBe(1);
        expect(json.accessors[0].max).toEqual([1, 1, 0]);
        expect(json.materials[0].pbrMetallicRoughness.roughnessFactor).toBe(0.5);
        expect(new DataView(glb.buffer).getUint32(8, true)).toBe(glb.length);
    });

    it("exports a Mesha model with one primitive per material region", () => {
        const g = modelGlb("street.barrel", {});
        const json = readGlbJson(g.glb);
        expect(json.meshes[0].primitives.length).toBe(g.regions.length);
        expect(g.triangles).toBeGreaterThan(50);
    });
});

describe("the package", () => {
    const world = createSampleWorld("world_test_pkg");
    const detail = detailOf(world);
    const ground = new Ground(world, detail);
    const capital = world.spots.find((s) => s.spotType === "capital")!;
    const entries: ArchiveEntry[] = run(buildPackage(world, detail, ground, { sites: [{ name: "Capital", x: capital.x, y: capital.y }, { name: "Woods", x: capital.x - 1.2, y: capital.y }], siteRadiusKm: 0.15, siteStepM: 4 }));
    const byName = new Map(entries.map((e) => [e.name, e]));
    const json = (name: string) => JSON.parse(byName.get(name)!.data as string);

    it("has the scene, models, terrain, materials and lore", () => {
        for (const n of ["README.md", "scene.json", "models/index.json", "terrain/terrain.json", "terrain/heightmap.png", "materials.json", "lore/world_bible.json", "lore/game_design_document.md", "lore/codex.json", "lore/story.json"]) expect(byName.has(n), n).toBe(true);
        expect(entries.some((e) => /^terrain\/site-1-capital-height\.png$/.test(e.name))).toBe(true);
        expect(entries.some((e) => e.name === "terrain/mask-forest.png")).toBe(true);
    });

    it("every object's model is in the package, and every model is used", () => {
        const scene = json("scene.json");
        const index = json("models/index.json");
        const files = new Set(index.map((m: any) => m.file));
        expect(scene.objects.length).toBeGreaterThan(20);
        for (const o of scene.objects) expect(files.has(o.model), o.model).toBe(true);
        for (const f of files) expect(byName.has(f as string)).toBe(true);
        // Buildings say what the plan says they are.
        const building = scene.objects.find((o: any) => o.plan.source === "structure" && o.plan.kind === "house");
        expect(building.plan.footprintM.length).toBe(2);
        expect(building.positionM[2]).toBeCloseTo(-building.positionKm[1] * 1000, 0);
        // Creatures and guards carry their codex entry and behavior.
        expect(scene.objects.some((o: any) => o.plan.source === "placement" && o.plan.behavior === "wander")).toBe(true);
        expect(scene.scatter.groups.length).toBeGreaterThan(0);
    });

    it("heightmaps say what their values mean", () => {
        const t = json("terrain/terrain.json");
        expect(t.heightmap.width).toBe(world.terrain!.cols);
        expect(t.heightmap.maxM).toBeGreaterThan(t.heightmap.minM);
        expect(t.sites[0].width).toBe(Math.round(300 / 4) + 1);
        const glb = byName.get(json("models/index.json")[0].file)!.data as Uint8Array;
        expect(readGlbJson(glb).asset.version).toBe("2.0");
    });
});

describe("model store", () => {
    function fakeEngine(worker: boolean): ModelEngine & { cache: Map<string, unknown>; jobs: Map<number, string> } {
        const cache = new Map<string, unknown>();
        const jobs = new Map<number, string>();
        let n = 0, t = 0;
        return {
            cache, jobs,
            status: (_ns, k) => (cache.has(k) ? "ready" : "missing"),
            put: (_ns, k, _m, meta) => void cache.set(k, meta),
            meta: (_ns, k) => cache.get(k) ?? null,
            startJob: worker ? (job) => { const id = ++n; jobs.set(id, JSON.stringify(job)); return id; } : undefined,
            pollJob: worker ? (id) => {
                const job = JSON.parse(jobs.get(id)!);
                for (const k of job.keys) cache.set(k, JSON.stringify({ center: [0, 1, 0], radius: 2, triangles: [100, 40, 10] }));
                return { status: "done" };
            } : undefined,
            now: () => (t += 1000),
        };
    }

    it("hands evaluations to the worker, a few at a time, nearest first", () => {
        const e = fakeEngine(true);
        const s = new ModelStore(e, { maxInFlight: 2 });
        s.want("street.barrel", { radius: 0.3 }, 50);
        s.want("street.barrel", { radius: 0.35 }, 5);
        s.want("street.barrel", { radius: 0.25 }, 500);
        s.pump();
        expect(e.jobs.size).toBe(2);
        expect([...e.jobs.values()].some((j) => j.includes("0.35"))).toBe(true);
        expect(s.pump()).toBe(2);
        expect(s.info("street.barrel", { radius: 0.35 })!.state).toBe("ready");
        expect(s.info("street.barrel", { radius: 0.35 })!.radius).toBe(2);
    });

    it("evaluates here, one at a time, without a worker", () => {
        const s = new ModelStore(fakeEngine(false), { minBuildIntervalMs: 0 });
        const a = s.want("street.barrel", {}, 1);
        s.want("street.barrel", { radius: 0.35 }, 2);
        expect(s.pump()).toBe(1);
        expect(a.state).toBe("ready");
        expect(a.triangles.length).toBe(3);
        expect(s.pending).toBe(1);
    });

    it("comes up from the cache without building", () => {
        const e = fakeEngine(true);
        new ModelStore(e).want("street.barrel", {}, 0);
        const first = new ModelStore(e);
        first.want("street.barrel", {}, 0);
        first.pump(); first.pump();
        const again = new ModelStore(e).want("street.barrel", {}, 0);
        expect(again.state).toBe("ready");
    });
});

describe("view decisions", () => {
    it("chooses coarser levels farther away and for small things sooner", () => {
        expect(chooseLod(5, 5)).toBe(0);
        expect(chooseLod(150, 5)).toBe(1);
        expect(chooseLod(400, 5)).toBe(2);
        expect(chooseLod(40, 0.5)).toBe(2);
    });

    it("demotes the farthest first to fit the budget", () => {
        const c = [{ distance: 10, lod: 0, triangles: [1000, 100, 10] }, { distance: 500, lod: 0, triangles: [1000, 100, 10] }];
        expect(budgetLods(c, 1200)).toBe(1100);
        expect(c[0].lod).toBe(0);
        expect(c[1].lod).toBe(1);
    });

    it("culls only what is certainly behind", () => {
        expect(maybeVisible([0, 0, 0], [0, 0, 1], [0, 0, 50], 1)).toBe(true);
        expect(maybeVisible([0, 0, 0], [0, 0, 1], [0, 0, -50], 1)).toBe(false);
        expect(maybeVisible([0, 0, 0], [0, 0, 1], [0, 0, -2], 3)).toBe(true);
    });

    it("packs a yaw the way the gizmo reads it back", () => {
        const r = new Float32Array(RECORD_FLOATS);
        packRecord(r, 0, 1, 2, 3, 0.7, 2, [1, 0, 0, 1]);
        // Local +Z goes to (sin yaw, 0, cos yaw) times scale.
        expect(r[12]).toBeCloseTo(Math.sin(0.7) * 2);
        expect(r[14]).toBeCloseTo(Math.cos(0.7) * 2);
        expect([r[16], r[17], r[18]]).toEqual([1, 2, 3]);
        expect(yawOf(yawQuat(0.7))).toBeCloseTo(0.7);
    });

    it("repacks only when the camera moved or turned enough", () => {
        const v = new ViewChange(1.5, 0.06, 0);
        expect(v.due([0, 0, 0], [0, 0, 1], 0)).toBe(true);
        expect(v.due([0.5, 0, 0], [0, 0, 1], 100)).toBe(false);
        expect(v.due([2, 0, 0], [0, 0, 1], 200)).toBe(true);
        expect(v.due([2, 0, 0], [0, 0, 1], 300, true)).toBe(true);
    });

    it("derives an instanced shader from Mesha's (every anchor found)", () => {
        expect(DETAIL_SHADER).toContain("var<storage, read> items: array<Item>");
        expect(DETAIL_SHADER).toContain("@builtin(instance_index)");
        expect(DETAIL_SHADER).toContain("pattern == 30");
        expect(DETAIL_SHADER).not.toContain("item.highlight.w;");
    });
});
