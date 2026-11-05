// Saving Game Worlds: the compact world format (quantized, predicted terrain; collapsed paint
// layers), the world library (index, save, load, remove) over an in-memory store, and new worlds.
import { describe, expect, it } from "vitest";
import { PlannerModel } from "../src/apps/game_planner/planner_model";
import { SHATTERED_ISLES_PRESET } from "../src/apps/game_planner/presets";
import {
    WorldLibrary,
    base64ToBytes,
    bytesToBase64,
    copyWorld,
    createBlankWorld,
    decodeOverlay,
    decodeTerrain,
    deserializeWorld,
    encodeOverlay,
    encodeTerrain,
    serializeWorld,
    worldFileName,
    type WorldStoreLike,
} from "../src/apps/game_planner/world_store";

function memoryStore(): WorldStoreLike & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
        files,
        read: (p) => files.get(p) ?? null,
        write: (p, t) => void files.set(p, t),
        list: (dir = "") => {
            const prefix = dir ? `${dir}/` : "";
            return [...files.keys()]
                .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
                .map((k) => ({ name: k.slice(prefix.length), isDir: false, size: files.get(k)!.length, modifiedMs: 1 }));
        },
        remove: (p) => files.delete(p),
    };
}

describe("compact encodings", () => {
    it("base64 round-trips every length", () => {
        for (let n = 0; n < 9; n++) {
            const b = new Uint8Array(n).map((_, i) => (i * 97 + 13) & 255);
            expect([...base64ToBytes(bytesToBase64(b))]).toEqual([...b]);
        }
    });

    it("terrain round-trips within half a quantization step and is several times smaller than JSON", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const t = model.world.terrain!;
        const enc = encodeTerrain(t);
        const back = decodeTerrain(enc);
        expect(back.cols).toBe(t.cols);
        expect(back.rows).toBe(t.rows);
        let worst = 0;
        for (let i = 0; i < t.data.length; i++) worst = Math.max(worst, Math.abs(back.data[i] - t.data[i]));
        expect(worst).toBeLessThanOrEqual(enc.stepM / 2 + 0.01);
        expect(worst).toBeLessThanOrEqual(0.06);
        const jsonBytes = JSON.stringify(t.data).length;
        expect(enc.data.length * 3).toBeLessThan(jsonBytes);
    });

    it("a flat or empty heightfield still encodes", () => {
        const flat = { cols: 3, rows: 2, data: [5, 5, 5, 5, 5, 5], seaLevelM: 0, minM: 5, maxM: 5 };
        expect(decodeTerrain(encodeTerrain(flat)).data).toEqual(flat.data);
    });

    it("paint layers keep their densities and collapse empty cells", () => {
        const data = new Array(400).fill(0);
        data[3] = 1;
        data[4] = 0.5;
        data[200] = 0.25;
        const enc = encodeOverlay({ cols: 20, rows: 20, layers: { forest: data } });
        expect(enc.layers.forest.length).toBeLessThan(40);
        const back = decodeOverlay(enc).layers.forest;
        expect(back.length).toBe(400);
        for (let i = 0; i < 400; i++) expect(Math.abs(back[i] - data[i])).toBeLessThan(0.003);
    });
});

describe("world files", () => {
    it("a whole world survives a save and load", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        model.paint("forest", [[0, 0], [1, 1]], true);
        const text = serializeWorld(model.world, 42);
        const back = deserializeWorld(text);
        expect(back.meta).toEqual(model.world.meta);
        expect(back.spots.map((s) => s.id)).toEqual(model.world.spots.map((s) => s.id));
        expect(back.missions).toEqual(model.world.missions);
        expect(back.terrain!.data.length).toBe(model.world.terrain!.data.length);
        expect(Object.keys(back.overlay!.layers)).toEqual(["forest"]);
        // Far smaller than the plain JSON the planner used to write.
        expect(text.length * 2.5).toBeLessThan(JSON.stringify(model.world).length);
    });

    it("reads the bare-world JSON older versions saved", () => {
        const legacy = JSON.stringify(SHATTERED_ISLES_PRESET);
        expect(deserializeWorld(legacy).meta.name).toBe(SHATTERED_ISLES_PRESET.meta.name);
    });

    it("refuses something that is not a world", () => {
        expect(() => deserializeWorld('{"hello": 1}')).toThrow();
    });
});

describe("the world library", () => {
    it("saves, lists, loads and removes worlds", () => {
        const store = memoryStore();
        const lib = new WorldLibrary(store);
        expect(lib.list()).toEqual([]);
        const a = createBlankWorld({ name: "Ashfall", genre: "fantasy", widthKm: 12, heightKm: 10, seed: 7, landform: "island" }, "world_a");
        const b = copyWorld(SHATTERED_ISLES_PRESET, "My Isles", "world_b");
        lib.save(a, 100);
        lib.save(b, 200);
        expect(lib.list().map((s) => s.id)).toEqual(["world_b", "world_a"]);
        expect(lib.list()[0].name).toBe("My Isles");
        const loaded = lib.load("world_a")!;
        expect(loaded.meta.worldWidthKm).toBe(12);
        expect(loaded.terrain!.cols).toBe(129);
        // Re-saving replaces the entry and moves it to the top.
        loaded.meta.name = "Ashfall Reborn";
        lib.save(loaded, 300);
        expect(lib.list().map((s) => s.name)).toEqual(["Ashfall Reborn", "My Isles"]);
        expect(lib.remove("world_b")).toBe(true);
        expect(lib.list().map((s) => s.id)).toEqual(["world_a"]);
        expect(lib.load("world_b")).toBeNull();
    });

    it("rebuilds a lost index from the world files", () => {
        const store = memoryStore();
        new WorldLibrary(store).save(copyWorld(SHATTERED_ISLES_PRESET, "Kept", "world_kept"), 5);
        store.files.delete("worlds/index.json");
        expect(new WorldLibrary(store).list().map((s) => s.name)).toEqual(["Kept"]);
    });

    it("file names are safe whatever the id", () => {
        expect(worldFileName("../etc/passwd")).toBe("worlds/etc_passwd.world.json");
    });
});

describe("new worlds", () => {
    it("are empty, sized as asked, on generated terrain", () => {
        const w = createBlankWorld({ name: "  ", genre: "scifi", widthKm: 40, heightKm: 20, seed: 3, landform: "continent" });
        expect(w.meta.name).toBe("Untitled World");
        expect(w.meta.worldWidthKm).toBe(40);
        expect(w.spots).toEqual([]);
        expect(w.terrain!.data.length).toBe(129 * 129);
        expect(w.terrain!.maxM).toBeGreaterThan(0);
        // A continent is mostly land.
        const land = w.terrain!.data.filter((v) => v > 0).length / w.terrain!.data.length;
        expect(land).toBeGreaterThan(0.4);
    });

    it("landforms differ: lowlands are lower than highlands", () => {
        const opts = { name: "x", genre: "fantasy" as const, widthKm: 20, heightKm: 20, seed: 11 };
        const low = createBlankWorld({ ...opts, landform: "lowlands" });
        const high = createBlankWorld({ ...opts, landform: "highlands" });
        expect(high.terrain!.maxM).toBeGreaterThan(low.terrain!.maxM * 2);
    });
});
