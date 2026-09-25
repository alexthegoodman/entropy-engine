import { describe, expect, it } from "vitest";
import {
    AUTO_VERSION_INTERVAL_MS, MAX_AUTO_VERSIONS, SongLibrary, TRASH_RETENTION_MS,
    cleanName, describeChanges, filterSongs, fingerprint, memoryStore, sortSongs, timeAgo, uniqueName, versionsToPrune,
} from "../src/apps/daw_library";
import type { ProjectShape, VersionEntry } from "../src/apps/daw_library";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const song = (bpm = 120, tracks = ["Drums"], clips = 2): ProjectShape & { notes: number } => ({
    bpm, songBars: 16, notes: 0,
    tracks: tracks.map((name, i) => ({ id: `t${i}`, name })),
    arrangement: Array.from({ length: clips }, (_, i) => ({ id: `c${i}` })),
});

function setup(files = new Map<string, string>()) {
    const clock = { now: 1_700_000_000_000 };
    let n = 0;
    const store = memoryStore(files);
    const lib = new SongLibrary<ReturnType<typeof song>>(store, { now: () => clock.now, uuid: () => `id-${++n}` });
    lib.init();
    return { lib, store, clock, reopen: () => { const again = new SongLibrary<ReturnType<typeof song>>(store, { now: () => clock.now, uuid: () => `id-${++n}` }); again.init(); return again; } };
}

describe("song library", () => {
    it("keeps many songs, each in its own file, and remembers which one is open", () => {
        const { lib, store, reopen } = setup();
        const a = lib.createSong("First", song(90));
        const b = lib.createSong("Second", song(140));
        lib.setCurrent(b.id);
        expect(store.files.has(`songs/${a.id}.json`)).toBe(true);
        expect(store.files.has(`songs/${b.id}.json`)).toBe(true);

        const again = reopen();
        expect(again.activeSongs().map(s => s.name)).toEqual(["First", "Second"]);
        expect(again.current()?.name).toBe("Second");
        expect(again.loadSong(a.id).project.bpm).toBe(90);
    });

    it("saves edits to the song file at once and the listing summary on flush", () => {
        const { lib, clock, reopen } = setup();
        const a = lib.createSong("Song", song());
        clock.now += 5 * MIN;
        lib.saveSong(a.id, song(128, ["Drums", "Bass"], 7));
        expect(reopen().loadSong(a.id).project.bpm).toBe(128);
        lib.flushIndex();
        const entry = reopen().find(a.id)!;
        expect(entry).toMatchObject({ bpm: 128, tracks: 2, clips: 7, updatedAt: clock.now });
    });

    it("gives new, renamed and duplicated songs unique names", () => {
        const { lib } = setup();
        const a = lib.createSong("Tune", song());
        expect(lib.createSong("tune", song()).name).toBe("tune 2");
        const b = lib.createSong("Other", song());
        expect(lib.rename(b.id, "  Tune  ")).toBe("Tune 3");
        expect(() => lib.rename(b.id, "   ")).toThrow(/needs a name/);
        expect(lib.duplicate(a.id, song()).name).toBe("Tune copy");
        expect(lib.duplicate(a.id, song()).name).toBe("Tune copy 2");
        expect(uniqueName("", [])).toBe("Untitled song");
        expect(cleanName("  a \n  b ")).toBe("a b");
    });

    it("moves deleted songs to Recently deleted, restores them, and empties them after 30 days", () => {
        const { lib, store, clock, reopen } = setup();
        const a = lib.createSong("Keep", song());
        const b = lib.createSong("Bin", song());
        lib.addVersion(b.id, song(), "named", "v1");
        lib.setCurrent(b.id);
        lib.trash(b.id);
        expect(lib.currentSongId).toBeNull();
        expect(lib.activeSongs().map(s => s.id)).toEqual([a.id]);
        expect(lib.trashedSongs().map(s => s.id)).toEqual([b.id]);
        expect(store.files.has(`songs/${b.id}.json`)).toBe(true);

        lib.restoreFromTrash(b.id);
        expect(lib.activeSongs()).toHaveLength(2);
        lib.trash(b.id);
        clock.now += TRASH_RETENTION_MS + 1;
        const later = reopen();
        expect(later.find(b.id)).toBeUndefined();
        expect(store.files.has(`songs/${b.id}.json`)).toBe(false);
        expect([...store.files.keys()].some(k => k.startsWith(`versions/${b.id}/`))).toBe(false);
    });

    it("rebuilds a lost index from the song files", () => {
        const { lib, store, reopen } = setup();
        lib.createSong("Alpha", song(100));
        lib.createSong("Beta", song(110));
        store.files.delete("library.json");
        const again = reopen();
        expect(again.activeSongs().map(s => s.name).sort()).toEqual(["Alpha", "Beta"]);
        expect(store.files.has("library.json")).toBe(true);
        store.files.set("library.json", "{ not json");
        expect(reopen().activeSongs()).toHaveLength(2);
    });

    it("opens the newest readable version when a song file is damaged", () => {
        const { lib, store, clock } = setup();
        const a = lib.createSong("Fragile", song(100));
        lib.addVersion(a.id, song(101), "auto");
        clock.now += HOUR;
        lib.addVersion(a.id, song(102), "auto");
        store.files.set(`songs/${a.id}.json`, "{\"broken");
        const opened = lib.loadSong(a.id);
        expect(opened.project.bpm).toBe(102);
        expect(opened.note).toMatch(/could not be opened.*version from/);
        store.files.delete(`songs/${a.id}.json`);
        for (const v of lib.versions(a.id)) store.files.delete(`versions/${a.id}/${v.id}.json`);
        expect(() => lib.loadSong(a.id)).toThrow(/no saved versions/);
    });

    it("sorts and searches", () => {
        const songs = [
            { id: "1", name: "beta", createdAt: 3, updatedAt: 1, bpm: 1, bars: 1, tracks: 1, clips: 1 },
            { id: "2", name: "Alpha house", createdAt: 1, updatedAt: 3, bpm: 1, bars: 1, tracks: 1, clips: 1 },
            { id: "3", name: "gamma house", createdAt: 2, updatedAt: 2, bpm: 1, bars: 1, tracks: 1, clips: 1 },
        ];
        expect(sortSongs(songs, "recent").map(s => s.id)).toEqual(["2", "3", "1"]);
        expect(sortSongs(songs, "name").map(s => s.id)).toEqual(["2", "1", "3"]);
        expect(sortSongs(songs, "created").map(s => s.id)).toEqual(["1", "3", "2"]);
        expect(filterSongs(songs, "HOUSE a").map(s => s.id)).toEqual(["2", "3"]);
        expect(filterSongs(songs, " ")).toHaveLength(3);
    });
});

describe("version history", () => {
    it("keeps an automatic version only after 10 minutes of changes", () => {
        const { lib, clock } = setup();
        const a = lib.createSong("Song", song());
        lib.markOpened(a.id);
        expect(lib.autoVersionDue(a.id)).toBe(false);
        clock.now += 11 * MIN;
        expect(lib.autoVersionDue(a.id)).toBe(false); // nothing changed
        lib.saveSong(a.id, song(121));
        expect(lib.autoVersionDue(a.id)).toBe(true);
        expect(lib.addVersion(a.id, song(121), "auto")).not.toBeNull();
        expect(lib.autoVersionDue(a.id)).toBe(false);
        lib.saveSong(a.id, song(122));
        expect(lib.nextAutoVersionIn(a.id)).toBe(AUTO_VERSION_INTERVAL_MS);
        clock.now += AUTO_VERSION_INTERVAL_MS;
        expect(lib.autoVersionDue(a.id)).toBe(true);
    });

    it("skips an automatic version identical to the newest one, but always keeps a named one", () => {
        const { lib } = setup();
        const a = lib.createSong("Song", song());
        expect(lib.addVersion(a.id, song(), "opened")).not.toBeNull();
        expect(lib.addVersion(a.id, song(), "auto")).toBeNull();
        expect(lib.addVersion(a.id, song(), "named", "Mix A")).not.toBeNull();
        expect(lib.versions(a.id).map(v => v.kind)).toEqual(["named", "opened"]);
    });

    it("restores what a version held and survives a reopen", () => {
        const { lib, reopen } = setup();
        const a = lib.createSong("Song", song(90));
        const v = lib.addVersion(a.id, song(90, ["Drums", "Keys"]), "named", "Before chorus")!;
        const again = reopen();
        expect(again.versions(a.id)[0]).toMatchObject({ id: v.id, kind: "named", label: "Before chorus", tracks: 2 });
        expect(again.loadVersion(a.id, v.id).tracks.map(t => t.name)).toEqual(["Drums", "Keys"]);
    });

    it("names, un-names and deletes versions", () => {
        const { lib, store } = setup();
        const a = lib.createSong("Song", song());
        const v = lib.addVersion(a.id, song(99), "auto")!;
        lib.nameVersion(a.id, v.id, "Good take");
        expect(lib.versions(a.id)[0]).toMatchObject({ kind: "named", label: "Good take" });
        lib.nameVersion(a.id, v.id, "");
        expect(lib.versions(a.id)[0].kind).toBe("auto");
        lib.deleteVersion(a.id, v.id);
        expect(lib.versions(a.id)).toHaveLength(0);
        expect(store.files.has(`versions/${a.id}/${v.id}.json`)).toBe(false);
    });

    it("thins old automatic versions and deletes their files, keeping named ones", () => {
        const { lib, store, clock } = setup();
        const a = lib.createSong("Song", song());
        const start = clock.now;
        // A version every 10 minutes for three days of work.
        let bpm = 60;
        const named = lib.addVersion(a.id, song(bpm++), "named", "Keeper")!;
        for (let t = 0; t < 3 * DAY; t += 10 * MIN) {
            clock.now = start + t;
            lib.addVersion(a.id, song(bpm++), "auto");
        }
        const history = lib.versions(a.id);
        const autos = history.filter(v => v.kind === "auto");
        // Last hour at 10-minute spacing (6), then about one per hour for a day, then one per day.
        expect(autos.length).toBeGreaterThan(20);
        expect(autos.length).toBeLessThan(40);
        expect(history.some(v => v.id === named.id)).toBe(true);
        const files = [...store.files.keys()].filter(k => k.startsWith(`versions/${a.id}/`) && !k.endsWith("index.json"));
        expect(files.length).toBe(history.length);
    });
});

describe("versionsToPrune", () => {
    const v = (id: string, at: number, kind: VersionEntry["kind"] = "auto"): VersionEntry =>
        ({ id, at, kind, hash: id, size: 1, bpm: 1, bars: 1, tracks: 1, clips: 1 });
    const now = 1_000 * DAY;

    it("keeps everything from the last hour", () => {
        expect(versionsToPrune([v("a", now - 5 * MIN), v("b", now - 15 * MIN), v("c", now - 55 * MIN)], now)).toEqual([]);
    });

    it("keeps one per hour for a day, one per day for a month, one per week after", () => {
        const hourStart = Math.floor((now - 3 * HOUR) / HOUR) * HOUR;
        const dayStart = Math.floor((now - 5 * DAY) / DAY) * DAY;
        const weekStart = Math.floor((now - 60 * DAY) / (7 * DAY)) * 7 * DAY;
        const list = [
            v("new", now - MIN),
            v("h1", hourStart + 50 * MIN), v("h2", hourStart + 10 * MIN),
            v("d1", dayStart + 20 * HOUR), v("d2", dayStart + 2 * HOUR),
            v("w1", weekStart + 3 * DAY), v("w2", weekStart + DAY),
        ];
        expect(versionsToPrune(list, now).sort()).toEqual(["d2", "h2", "w2"]);
    });

    it("never prunes named versions or the newest automatic one", () => {
        const list = [v("old", now - 400 * DAY), v("n1", now - 300 * DAY, "named"), v("n2", now - 300 * DAY, "named")];
        expect(versionsToPrune(list, now)).toEqual([]);
    });

    it("caps automatic versions", () => {
        const list = Array.from({ length: MAX_AUTO_VERSIONS + 5 }, (_, i) => v(`v${i}`, now - i * 20_000));
        expect(versionsToPrune(list, now)).toHaveLength(5);
    });
});

describe("helpers", () => {
    it("fingerprints content", () => {
        expect(fingerprint("abc")).toBe(fingerprint("abc"));
        expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
    });

    it("says how long ago", () => {
        const now = 10 * DAY;
        expect(timeAgo(now - 10_000, now)).toBe("just now");
        expect(timeAgo(now - 12 * MIN, now)).toBe("12 min ago");
        expect(timeAgo(now - 3 * HOUR, now)).toBe("3 h ago");
        expect(timeAgo(now - 30 * HOUR, now)).toBe("yesterday");
        expect(timeAgo(now - 4 * DAY, now)).toBe("4 days ago");
    });

    it("describes what restoring a version would change", () => {
        const now = song(120, ["Drums", "Bass"], 4);
        const old = { ...song(96, ["Drums", "Pad"], 6) };
        old.tracks[1].id = "pad";
        expect(describeChanges(now, old)).toEqual(["Tempo 120 to 96 BPM", "Brings back Pad", "Removes Bass", "2 more clips"]);
        expect(describeChanges(now, song(120, ["Drums", "Bass"], 4))).toEqual(["Same as the song now"]);
    });
});
