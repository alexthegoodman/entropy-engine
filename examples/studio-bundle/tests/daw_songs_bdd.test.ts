import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, parseFeature } from "./daw_test_world";

// Runs tests/features/daw_songs.feature against the production addon. The world's store is a Map,
// kept across "the DAW is closed and opened again" so a reopen reads exactly what was written.

describe("The DAW keeps many songs with version history (production addon callbacks)", () => {
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); delete (globalThis as any).Entropy; });

    it("without a store (no data folder) still saves the open song through IO.save, as before", async () => {
        vi.resetModules();
        const world = createWorld({ ...JSON.parse(JSON.stringify({ bpm: 100, stepsPerBeat: 4, songBars: 4, snap: "bar", arrangement: [], tracks: [], activeTrackId: null })) });
        vi.spyOn(Date, "now").mockImplementation(() => world.w.clock);
        delete (globalThis as any).Entropy.Addon.register().IO.store;
        await world.open();
        world.w.buttons.get("bpm_up")!();
        world.advance(400);
        expect(world.w.saved.bpm).toBe(97); // the demo song, since that old save had no tracks
        expect(world.w.files.size).toBe(0);
        expect(world.w.labels).toContain("Song library unavailable: only this song is kept");
    });

    for (const scenario of parseFeature("daw_songs")) {
        it(scenario.name, async () => {
            vi.resetModules();
            let world = createWorld();
            vi.spyOn(Date, "now").mockImplementation(() => world.w.clock);
            const w = () => world.w;

            const index = () => JSON.parse(w().files.get("library.json") ?? "null");
            const songs = () => (index()?.songs ?? []) as any[];
            const openSong = () => songs().find(s => s.id === index()?.currentSongId);
            const history = () => {
                const id = index()?.currentSongId;
                return (JSON.parse(w().files.get(`versions/${id}/index.json`) ?? "null")?.versions ?? []) as any[];
            };
            const click = (id: string) => {
                world.render();
                const b = w().buttons.get(id);
                if (!b) throw new Error(`no button ${id}; have ${[...w().buttons.keys()].join(", ")}`);
                b();
                world.render();
            };
            const tree = (id: string) => { world.render(); const t = w().trees.get(id); if (!t) throw new Error(`no tree ${id}`); return t; };
            const songRows = () => tree("song_list").nodes.map((n: any) => n.label.replace(/  \(open\)$/, ""));
            const selectIn = (treeId: string, label: string) => {
                const t = tree(treeId);
                const row = t.nodes.find((n: any) => n.label.replace(/  \(open\)$/, "") === label);
                if (!row) throw new Error(`no row "${label}" in ${treeId}; have ${t.nodes.map((n: any) => n.label).join(", ")}`);
                t.onSelect(row.id);
                world.render();
            };
            const showSongs = () => { world.render(); if (!w().trees.has("song_list")) click("songs_toggle"); };
            const showHistory = () => { world.render(); if (!w().trees.has("version_list")) click("history_toggle"); };
            const selectOldestVersion = () => {
                showHistory();
                const rows = tree("version_list").nodes.filter((n: any) => !n.id.startsWith("day:"));
                tree("version_list").onSelect(rows[rows.length - 1].id);
                world.render();
            };
            const tool = (args: any) => w().tools.get("daw_songs")!(args);

            const steps: [RegExp, (...m: string[]) => void | Promise<void>][] = [
                [/^the DAW is open$/, async () => { await world.open(); }],
                [/^the DAW is open on an old DAW\.json at (\d+) BPM$/, async bpm => {
                    const old = { bpm: +bpm, stepsPerBeat: 4, songBars: 8, snap: "bar", arrangement: [], activeTrackId: "t1",
                        tracks: [{ id: "t1", name: "Keys", kind: "synth", rootNote: 60, scale: "major", rows: 7, gain: 0.3, muted: false, solo: false, channel: 0, colorIndex: 0,
                            voice: { waveform: "saw", cutoff: 4000, resonance: 1, attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.1, delayTime: 0, delayFeedback: 0.3, delayMix: 0, reverbRoomSize: 10, reverbTime: 1, reverbDamping: 0.5, reverbMix: 0 },
                            patterns: [{ id: "p1", name: "A", steps: 16, notes: [] }], activePatternId: "p1" }] };
                    world = createWorld(old);
                    await world.open();
                }],
                [/^the DAW is closed and opened again$/, async () => {
                    world.advance(3000);
                    const files = w().files;
                    const clock = w().clock;
                    vi.resetModules();
                    world = createWorld(undefined, files);
                    world.w.clock = clock;
                    await world.open();
                }],
                [/^I click "(.+)"$/, id => click(id)],
                [/^I press Ctrl\+S$/, () => { w().keyDown!("s", true, false, false); world.render(); }],
                [/^(\d+) minutes pass$/, m => { w().clock += +m * 60_000; world.advance(100); }],
                [/^I set "(.+)" to "(.*)"$/, (id, value) => {
                    if (id.startsWith("version_")) showHistory(); else showSongs();
                    const field = w().textInputs.get(id);
                    if (!field) throw new Error(`no field ${id}`);
                    field.onChange(value);
                    world.render();
                }],
                [/^I create a new song from "(.+)"$/, label => {
                    showSongs();
                    const d = w().dropdowns.get("new_song_template");
                    const i = d.options.indexOf(label);
                    if (i < 0) throw new Error(`no template ${label}; have ${d.options.join(", ")}`);
                    d.onChange(String(i));
                    click("new_song_create");
                }],
                [/^I select the song "(.+)"$/, name => { showSongs(); selectIn("song_list", name); }],
                [/^I select the deleted song "(.+)"$/, name => { showSongs(); selectIn("trash_list", name); }],
                [/^I open the song "(.+)"$/, name => { showSongs(); selectIn("song_list", name); click("song_open"); }],
                [/^I rename the song "(.+)" to "(.+)"$/, (from, to) => {
                    showSongs();
                    selectIn("song_list", from);
                    click("song_rename");
                    w().textInputs.get("song_rename_input").onChange(to);
                    click("song_rename_save");
                }],
                [/^I restore the oldest version$/, () => { selectOldestVersion(); click("version_restore"); }],
                [/^I open the oldest version as a new song$/, () => { selectOldestVersion(); click("version_open_copy"); }],
                [/^the assistant creates a song called "(.+)"$/, name => { expect(tool({ action: "new", name }).success).toBe(true); world.render(); }],
                [/^the assistant opens the song "(.+)"$/, name => {
                    const song = tool({ action: "list" }).songs.find((s: any) => s.name === name);
                    expect(tool({ action: "open", songId: song.id }).success).toBe(true);
                    world.render();
                }],

                [/^the open song is "(.+)"$/, name => { world.advance(3000); expect(openSong()?.name).toBe(name); }],
                [/^the open song is at (\d+) BPM$/, bpm => { world.advance(400); expect(w().saved.bpm).toBe(+bpm); }],
                [/^the song bar says "(.+)"$/, name => { world.render(); expect(w().labels).toContain(`[music-notes] ${name}`); }],
                [/^the library has (\d+) songs?$/, n => { world.advance(3000); expect(songs().filter(s => s.deletedAt === undefined)).toHaveLength(+n); }],
                [/^the song list shows "(.+)"$/, name => { showSongs(); expect(songRows()).toContain(name); }],
                [/^the song list does not show "(.+)"$/, name => { showSongs(); expect(songRows()).not.toContain(name); }],
                [/^the song list shows only "(.+)"$/, name => { showSongs(); expect(songRows()).toEqual([name]); }],
                [/^Recently deleted has (\d+) songs?$/, n => {
                    world.advance(3000);
                    expect(songs().filter(s => s.deletedAt !== undefined)).toHaveLength(+n);
                    world.render();
                    expect(w().trees.has("trash_list")).toBe(+n > 0);
                }],
                [/^no file of the deleted song is left$/, () => {
                    const ids = new Set(songs().map(s => s.id));
                    const orphans = [...w().files.keys()].filter(k => {
                        const m = /^(?:songs|versions)\/([^/.]+)/.exec(k);
                        return m && !ids.has(m[1]);
                    });
                    expect(orphans).toEqual([]);
                }],
                [/^the assistant lists (\d+) songs$/, n => expect(tool({ action: "list" }).songs).toHaveLength(+n)],
                [/^the song has (\d+) versions?$/, n => expect(history()).toHaveLength(+n)],
                [/^the song has a version "(.+)"$/, label => expect(history().some(v => (v.label ?? "").startsWith(label))).toBe(true)],
            ];

            for (const text of scenario.steps) {
                const match = steps.map(([re, run]) => [re.exec(text), run] as const).find(([m]) => m);
                if (!match) throw new Error(`No step matches: ${text}`);
                await match[1](...match[0]!.slice(1));
            }
        });
    }
});
