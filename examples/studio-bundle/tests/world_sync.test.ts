// One world file, two apps: the three-way merge that keeps the Planner's and the Detailer's edits,
// and the watcher that notices the other app's saves (and ignores its own).
import { describe, expect, it } from "vitest";
import { PlannerModel } from "../src/apps/game_planner/planner_model";
import { WorldLibrary, type WorldStoreLike } from "../src/apps/game_planner/world_store";
import { WorldFileWatcher, cloneWorld, mergeWorlds, sameValue } from "../src/apps/game_planner/world_sync";
import type { GameWorld, WorldStructure } from "../src/apps/game_planner/planner_types";

function memoryStore(): WorldStoreLike & { files: Map<string, string>; tick: () => void } {
    const files = new Map<string, string>();
    const modified = new Map<string, number>();
    let clock = 1;
    return {
        files,
        tick: () => void clock++,
        read: (p) => files.get(p) ?? null,
        write: (p, t) => { files.set(p, t); modified.set(p, ++clock); },
        list: (dir = "") => {
            const prefix = dir ? `${dir}/` : "";
            return [...files.keys()]
                .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
                .map((k) => ({ name: k.slice(prefix.length), isDir: false, size: files.get(k)!.length, modifiedMs: modified.get(k) ?? 0 }));
        },
        remove: (p) => files.delete(p),
    };
}

const house = (id: string, x: number): WorldStructure => ({ id, kind: "house", shape: "rect", x, y: 0, widthM: 10, depthM: 8, rotationDeg: 0 });

function world(): GameWorld {
    const w = cloneWorld(new PlannerModel().world);
    w.structures = [house("s1", 1), house("s2", 2)];
    return w;
}

describe("sameValue", () => {
    it("compares deeply and treats undefined fields as absent", () => {
        expect(sameValue({ a: [1, 2, { b: 3 }] }, { a: [1, 2, { b: 3 }] })).toBe(true);
        expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
        expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
        expect(sameValue({ a: 1 }, [1])).toBe(false);
    });
});

describe("mergeWorlds", () => {
    it("keeps both sides' edits to different fields of one building", () => {
        const base = world();
        const mine = cloneWorld(base), theirs = cloneWorld(base);
        mine.structures![0].name = "The Smithy";      // the Planner renames it
        theirs.structures![0].x = 1.25;               // the Detailer moves it
        theirs.structures![0].rotationDeg = 30;
        const { world: merged, report } = mergeWorlds(base, mine, theirs);
        expect(merged.structures![0]).toMatchObject({ name: "The Smithy", x: 1.25, rotationDeg: 30 });
        expect(report.conflicts).toEqual([]);
        expect(report.incoming).toBe(2);
    });

    it("takes additions and deletions from both sides", () => {
        const base = world();
        const mine = cloneWorld(base), theirs = cloneWorld(base);
        mine.structures!.push(house("mine", 5));
        theirs.structures = theirs.structures!.filter((s) => s.id !== "s2");
        theirs.structures.push(house("theirs", 6));
        const ids = mergeWorlds(base, mine, theirs).world.structures!.map((s) => s.id);
        expect(ids).toEqual(["s1", "mine", "theirs"]);
    });

    it("lets this app win a real conflict, and says so", () => {
        const base = world();
        const mine = cloneWorld(base), theirs = cloneWorld(base);
        mine.structures![1].x = 9;
        theirs.structures![1].x = 7;
        const { world: merged, report } = mergeWorlds(base, mine, theirs);
        expect(merged.structures![1].x).toBe(9);
        expect(report.conflicts).toEqual(["structures/s2/x"]);
    });

    it("keeps a thing one side deleted when the other side changed it", () => {
        const base = world();
        const mine = cloneWorld(base), theirs = cloneWorld(base);
        mine.structures = mine.structures!.filter((s) => s.id !== "s1");
        theirs.structures![0].floors = 3;
        const { world: merged, report } = mergeWorlds(base, mine, theirs);
        expect(merged.structures!.find((s) => s.id === "s1")?.floors).toBe(3);
        expect(report.conflicts.length).toBe(1);
    });

    it("merges the Detailer's own section, which the Planner only carries", () => {
        const base = world();
        const mine = cloneWorld(base), theirs = cloneWorld(base);
        mine.meta.description = "edited in the planner";
        theirs.detail = { version: 1, props: [{ id: "p1", objectId: "street.barrel" }] };
        const { world: merged } = mergeWorlds(base, mine, theirs);
        expect(merged.meta.description).toBe("edited in the planner");
        expect((merged.detail as any).props[0].id).toBe("p1");
    });

    it("takes sculpted terrain from the side that sculpted", () => {
        const base = world();
        const mine = cloneWorld(base), theirs = cloneWorld(base);
        theirs.terrain!.data[10] += 25;
        mine.spots[0].name = "Renamed";
        const { world: merged } = mergeWorlds(base, mine, theirs);
        expect(merged.terrain!.data[10]).toBe(theirs.terrain!.data[10]);
        expect(merged.spots[0].name).toBe("Renamed");
    });
});

describe("WorldFileWatcher", () => {
    it("reports another app's save and ignores its own", () => {
        const store = memoryStore();
        const lib = new WorldLibrary(store);
        const w = world();
        lib.save(w, 1000, "game-world-planner");
        const watcher = new WorldFileWatcher(store, w.meta.id, 0);
        expect(watcher.poll(1, true)).toBeNull();

        // Our own save: stamped, so it is not "external".
        lib.save(w, 2000, "game-world-planner");
        watcher.noteSaved(2000);
        expect(watcher.poll(2, true)).toBeNull();

        // Another app saves.
        const theirs = cloneWorld(w);
        theirs.structures![0].x = 3;
        lib.save(theirs, 3000, "game-world-detailer");
        const change = watcher.poll(3, true);
        expect(change?.savedBy).toBe("game-world-detailer");
        expect(change?.world.structures![0].x).toBe(3);
        // Seen once.
        expect(watcher.poll(4, true)).toBeNull();
    });

    it("polls no more often than its interval", () => {
        const store = memoryStore();
        const lib = new WorldLibrary(store);
        const w = world();
        lib.save(w, 1000);
        const watcher = new WorldFileWatcher(store, w.meta.id, 1000);
        expect(watcher.poll(0)).toBeNull();
        lib.save(cloneWorld(w), 5000, "x");
        expect(watcher.poll(500)).toBeNull();
        expect(watcher.poll(1500)).not.toBeNull();
    });
});
