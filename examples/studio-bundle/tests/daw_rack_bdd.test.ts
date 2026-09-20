import { afterEach, describe, expect, it, vi } from "vitest";
import {
    addPad, assignSample, browserRows, clearSample, defaultRack, editSample, ensureRack, formatBytes,
    formatSeconds, isListedFile, newBrowser, padHit, padStatus, refreshBrowser, setRoot, stem, toggleFolder,
    type DirEntry, type DrumPad,
} from "../src/apps/daw_rack";
import { createWorld, parseFeature } from "./daw_test_world";

// --- The model, on its own -------------------------------------------------------------------------

const track = () => ({ kind: "drum" as const, rows: 0, rack: undefined as DrumPad[] | undefined });

describe("The drum rack model", () => {
    it("starts as the five built-in voices and keeps rows equal to the pad count", () => {
        const t = track();
        expect(ensureRack(t).map(p => p.name)).toEqual(["Kick", "Snare", "Hihat", "Clap", "Tom"]);
        expect(t.rows).toBe(5);
        expect(ensureRack({ kind: "synth", rows: 10 })).toEqual([]);
    });

    it("repairs a damaged saved rack instead of throwing", () => {
        const t: any = { kind: "drum", rows: 3, rack: [null, { name: 7, midi: 500, sample: { path: "" } }, { name: "Loop", voice: "kick", freq: 50, midi: 36, sample: { path: "a.wav", start: 0.9, end: 0.1, gain: 9, semitones: -40 } }] };
        const rack = ensureRack(t);
        expect(rack.map(p => p.name)).toEqual(["Pad 1", "Pad 2", "Loop"]);
        expect(rack[1].midi).toBe(127);
        expect(rack[1].sample).toBeNull();
        const s = rack[2].sample!;
        expect([s.gain, s.semitones]).toEqual([2, -12]);
        expect(s.start).toBeLessThan(s.end);
    });

    it("never renumbers pads: clearing empties one, adding appends, sixteen is the limit", () => {
        const t = track();
        assignSample(t, 0, { path: "C:/m/kick.wav" });
        clearSample(t, 0);
        expect(ensureRack(t)).toHaveLength(5);
        for (let i = 0; i < 11; i++) expect(addPad(t)).not.toBeNull();
        expect(addPad(t)).toBeNull();
        expect(t.rows).toBe(16);
        expect(t.rack!.map(p => p.midi).slice(5, 8)).toEqual([46, 49, 51]);
    });

    it("a pad still called Pad N takes the file's name, a named pad keeps its own", () => {
        const t = track();
        addPad(t);
        expect(assignSample(t, 5, { path: "C:/m/Big Crash Cymbal 04.wav" })!.name).toBe("Big Crash Cymb");
        expect(assignSample(t, 0, { path: "C:/m/808.wav" })!.name).toBe("Kick");
        expect(stem("C:\\Users\\a\\Music\\x.tar.wav")).toBe("x.tar");
    });

    it("clamps edits so a trim cannot invert and a NaN slider changes nothing", () => {
        const t = track();
        const pad = assignSample(t, 0, { path: "a.wav" })!;
        editSample(pad, { end: 0.4 });
        editSample(pad, { start: 0.9 });
        expect(pad.sample!.start).toBeLessThan(pad.sample!.end);
        editSample(pad, { gain: NaN, semitones: NaN });
        expect([pad.sample!.gain, pad.sample!.semitones]).toEqual([1, 0]);
        editSample(pad, { gain: 9, semitones: 99 });
        expect([pad.sample!.gain, pad.sample!.semitones]).toEqual([2, 12]);
    });

    it("plays a sample when it has one, its voice when it does not, and nothing for a missing file", () => {
        const t = track();
        const rack = ensureRack(t);
        expect(padHit(rack[0], 0.8, 0.2)).toEqual({ type: "voice", voice: "kick", freq: 55 });
        addPad(t);
        expect(padHit(t.rack![5], 1, 0.2)).toBeNull();
        const pad = assignSample(t, 0, { path: "a.wav" })!;
        editSample(pad, { gate: true });
        const hit: any = padHit(pad, 0.5, 0.01);
        expect([hit.type, hit.gain, hit.hold]).toEqual(["sample", 0.5, 0.03]);
        expect(padHit(pad, 1, 0.2, p => p === "a.wav")).toBeNull();
        expect(padStatus(pad, p => p === "a.wav")).toBe("missing");
        expect(padHit(defaultRack()[1], 1, 0.1)).not.toBeNull();
    });
});

describe("The sample browser model", () => {
    const dir = (name: string, path: string, audioCount = 0, dirCount = 0): DirEntry => ({ name, path, isDir: true, size: 0, audioCount, dirCount });
    const file = (name: string, path: string, size = 2048): DirEntry => ({ name, path, isDir: false, size, audioCount: 0, dirCount: 0 });
    const disk: Record<string, DirEntry[]> = {
        "/m": [dir("Kits", "/m/Kits", 2, 1), dir("Empty", "/m/Empty"), file("loop.wav", "/m/loop.wav", 5_242_880)],
        "/m/Kits": [dir("808", "/m/Kits/808", 1), file("hat.wav", "/m/Kits/hat.wav"), file("Kick.WAV", "/m/Kits/Kick.WAV")],
        "/m/Kits/808": [file("bass.wav", "/m/Kits/808/bass.wav")],
    };
    let reads: string[] = [];
    const list = (p: string) => { reads.push(p); return p in disk ? { ok: true, entries: disk[p] } : { ok: false, error: "refused", entries: [] }; };
    const labels = (b = newBrowser()) => browserRows(b).map(r => `${" ".repeat(r.depth)}${r.label}`);

    it("shows the root open with folders first and a count on each folder", () => {
        const b = newBrowser();
        expect(browserRows(b)).toEqual([]);
        setRoot(b, "/m", list);
        const rows = browserRows(b);
        expect(rows.map(r => [r.label, r.depth, r.detail])).toEqual([
            ["m", 0, ""], ["Kits", 1, "2 samples"], ["Empty", 1, "empty"], ["loop.wav", 1, "5.0 MB"],
        ]);
        expect(rows[1].hasChildren).toBe(true);
        expect(rows[2].hasChildren).toBe(false);
    });

    it("opening a folder reads it and lists it in place; closing hides it without reading again", () => {
        const b = newBrowser();
        setRoot(b, "/m", list);
        reads = [];
        toggleFolder(b, "/m/Kits", list);
        expect(labels(b)).toEqual(["m", " Kits", "  808", "  hat.wav", "  Kick.WAV", " Empty", " loop.wav"]);
        toggleFolder(b, "/m/Kits", list);
        expect(labels(b)).toEqual(["m", " Kits", " Empty", " loop.wav"]);
        expect(reads).toEqual(["/m/Kits"]);
    });

    it("an unreadable folder stays closed and says so instead of throwing", () => {
        const b = newBrowser();
        setRoot(b, "/m", list);
        toggleFolder(b, "/m/Empty", list);
        expect(b.expanded["/m/Empty"]).toBe(false);
        expect(browserRows(b).find(r => r.label === "Empty")!.detail).toBe("unreadable");
    });

    it("filters files by a case-insensitive substring and leaves folders alone", () => {
        const b = newBrowser();
        setRoot(b, "/m", list);
        toggleFolder(b, "/m/Kits", list);
        b.filter = "kick";
        expect(labels(b)).toEqual(["m", " Kits", "  808", "  Kick.WAV", " Empty"]);
    });

    it("refresh reads open folders again and a selection is only kept while its file is listed", () => {
        const b = newBrowser();
        setRoot(b, "/m", list);
        toggleFolder(b, "/m/Kits", list);
        b.selected = "/m/Kits/hat.wav";
        expect(isListedFile(b, b.selected)).toBe(true);
        disk["/m/Kits"] = disk["/m/Kits"].filter(e => e.name !== "hat.wav");
        refreshBrowser(b, list);
        expect(isListedFile(b, "/m/Kits/hat.wav")).toBe(false);
        expect(browserRows(b).some(r => r.selected)).toBe(false);
    });

    it("formats sizes and lengths the way the browser shows them", () => {
        expect(formatBytes(900)).toBe("900 B");
        expect(formatBytes(84_000)).toBe("82 KB");
        expect(formatSeconds(0.416)).toBe("0.42 s");
        expect(formatSeconds(42.34)).toBe("42.3 s");
        expect(formatSeconds(200)).toBe("3:20");
    });
});

// --- The addon, through its production callbacks ----------------------------------------------------

const LEGACY_DRUMS = {
    bpm: 110, steps: 16, stepsPerBeat: 4, activeTrackId: "t1",
    tracks: [{
        id: "t1", name: "Old drums", kind: "drum", rootNote: 60, scale: "chromatic", rows: 5,
        voice: { waveform: "kick", cutoff: 1800, resonance: 1, attack: 0.002, decay: 0.12, sustain: 0, release: 0.08, delayTime: 0, delayFeedback: 0.35, delayMix: 0, reverbRoomSize: 10, reverbTime: 0.8, reverbDamping: 0.5, reverbMix: 0 },
        gain: 0.5, muted: false, solo: false,
        notes: [{ row: 0, step: 0, length: 1, velocity: 1 }, { row: 0, step: 8, length: 1, velocity: 1 }],
    }],
};

describe("The DAW puts samples from the Music folder on drum pads (production addon callbacks)", () => {
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); delete (globalThis as any).Entropy; });

    for (const scenario of parseFeature("daw_rack")) {
        it(scenario.name, async () => {
            vi.resetModules();
            let world = createWorld();
            vi.spyOn(Date, "now").mockImplementation(() => world.w.clock);
            const w = new Proxy({} as ReturnType<typeof createWorld>["w"], {
                get: (_, key) => (world.w as any)[key],
                set: (_, key, value) => { (world.w as any)[key] = value; return true; },
            });

            // ---- the fake disk ----
            const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
            const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
            const bump = (folder: string, key: "audioCount" | "dirCount", by: number) => {
                const entry = (w.folders[parentOf(folder)] ?? []).find(e => e.path === folder);
                if (entry) entry[key] += by;
            };
            const addFolder = (path: string) => {
                if (w.folders[path]) return;
                w.folders[path] = [];
                const parent = parentOf(path);
                if (w.folders[parent]) {
                    w.folders[parent].push({ name: baseOf(path), path, isDir: true, size: 0, audioCount: 0, dirCount: 0 });
                    bump(parent, "dirCount", 1);
                }
            };
            const addSample = (path: string, seconds: number) => {
                const folder = parentOf(path);
                addFolder(folder);
                w.folders[folder].push({ name: baseOf(path), path, isDir: false, size: Math.round(seconds * 176_400), audioCount: 0, dirCount: 0 });
                bump(folder, "audioCount", 1);
                const decoded = Math.min(seconds, 12);
                w.samples[path] = {
                    seconds: decoded, fullSeconds: seconds, truncated: seconds > 12, sourceRate: 44100, channels: 2, peak: 0.8,
                    waveform: Array.from({ length: 64 }, (_, i) => Math.max(0.05, 1 - i / 64)),
                };
            };
            const removeSample = (path: string) => {
                delete w.samples[path];
                const folder = parentOf(path);
                w.folders[folder] = (w.folders[folder] ?? []).filter(e => e.path !== path);
                bump(folder, "audioCount", -1);
            };

            // ---- reading what the addon drew ----
            const grid = () => {
                world.render();
                const g = [...w.padGrids.entries()].find(([id]) => id.startsWith("rack_pads_"))?.[1];
                if (!g) throw new Error(`no pad grid; have ${[...w.padGrids.keys()].join(", ")}`);
                return g;
            };
            const pad = (label: string) => {
                const p = grid().pads.find((p: any) => p.label === label);
                if (!p) throw new Error(`no pad "${label}"; have ${grid().pads.map((p: any) => p.label).join(", ")}`);
                return p;
            };
            const tree = () => { world.render(); const t = w.trees.get("sample_tree"); if (!t) throw new Error("no sample tree"); return t; };
            const node = (label: string) => {
                const n = tree().nodes.find((n: any) => n.label === label);
                if (!n) throw new Error(`no tree row "${label}"; have ${tree().nodes.map((n: any) => n.label).join(", ")}`);
                return n;
            };
            const state = () => w.tools.get("daw_get_state")!({});
            const trackIdNamed = (name: string) => {
                const t = state().tracks.find((t: any) => t.name === name);
                if (!t) throw new Error(`no track named ${name}`);
                return t.id as string;
            };
            const settled = () => { world.advance(400); return w.saved; };
            const savedTrack = (name: string) => {
                const t = settled().tracks.find((t: any) => t.name === name);
                if (!t) throw new Error(`no saved track named ${name}`);
                return t;
            };
            const savedPad = (i: string, name: string) => savedTrack(name).rack[+i];
            const click = (id: string) => {
                world.render();
                if (!w.buttons.has(id)) throw new Error(`no button ${id}; have ${[...w.buttons.keys()].join(", ")}`);
                w.buttons.get(id)!();
                world.render();
            };
            const callTool = (name: string, args: any) => { w.lastToolResult = w.tools.get(name)!(args); world.render(); };
            const hitsOn = (name: string) => w.sampleHits.filter(h => h.id === trackIdNamed(name));
            const voicesOn = (name: string) => w.played.filter(p => p.id === trackIdNamed(name)).map(p => p.cfg.waveform);

            const steps: [RegExp, (...m: string[]) => void | Promise<void>][] = [
                [/^the DAW is open$/, async () => { await world.open(); }],
                [/^the DAW is open on a project saved before drum racks existed$/, async () => {
                    world = createWorld(LEGACY_DRUMS);
                    await world.open();
                }],
                [/^the DAW is reopened without "(.+)" on the disk$/, async path => {
                    const saved = settled();
                    const disk = { folders: w.folders, samples: w.samples };
                    removeSample(path);
                    vi.resetModules();
                    world = createWorld(saved);
                    world.w.folders = disk.folders;
                    world.w.samples = disk.samples;
                    await world.open();
                }],
                [/^the disk has a Music folder$/, () => { w.folders["C:/Music"] = []; }],
                [/^the disk has the folder "(.+)"$/, path => addFolder(path)],
                [/^the disk has the sample "(.+)" of ([\d.]+) seconds$/, (path, s) => addSample(path, +s)],
                [/^a disk with a drum kit folder$/, () => {
                    w.folders["C:/Music"] = [];
                    addFolder("C:/Music/Drum Kit");
                    addSample("C:/Music/Drum Kit/kick_808.wav", 0.4);
                    addSample("C:/Music/Drum Kit/snare_tight.wav", 0.3);
                    addSample("C:/Music/Drum Kit/hat.wav", 0.1);
                }],
                [/^the file "(.+)" is deleted from the disk$/, path => removeSample(path)],

                [/^the rack has (\d+) pads$/, n => expect(grid().pads).toHaveLength(+n)],
                [/^the pad "(.+)" is an? "(\w+)" pad$/, (label, kind) => expect(pad(label).kind).toBe(kind)],
                [/^the pad "(.+)" is captioned "(.+)"$/, (label, caption) => expect(pad(label).sublabel).toBe(caption)],
                [/^the pad "(.+)" has a waveform$/, label => expect(pad(label).waveform?.length).toBeGreaterThan(8)],
                [/^the pad "(.+)" is glowing$/, label => expect(pad(label).glow).toBeGreaterThan(0.05)],
                [/^the pad "(.+)" is not glowing$/, label => expect(pad(label).glow).toBe(0)],
                [/^the drum rack window is shown$/, () => { world.render(); expect(Object.values(w.windowVisible).at(-1)).toBe(true); }],
                [/^the drum rack window is hidden$/, () => { world.render(); expect(Object.values(w.windowVisible).at(-1)).toBe(false); }],
                [/^the pad grid is not drawn$/, () => { world.render(); expect([...w.padGrids.keys()].some(id => id.startsWith("rack_pads_"))).toBe(false); }],
                [/^I see the label "(.+)"$/, text => { world.render(); expect(w.labels).toContain(text); }],
                [/^the pad grid has no add tile$/, () => expect(grid().addTile).toBe(false)],
                [/^the piano roll has (\d+) rows labelled "(.+)"$/, (n, labels) => {
                    world.render();
                    expect(w.piano.rows).toBe(+n);
                    expect(w.piano.rowLabels).toEqual(labels.split(", "));
                }],
                [/^the piano roll has (\d+) rows$/, n => { world.render(); expect(w.piano.rows).toBe(+n); }],

                [/^I click the pad "(.+)"$/, label => { const p = pad(label); grid().onPadClick(p.id); world.render(); }],
                [/^I right-click the pad "(.+)"$/, label => { const p = pad(label); grid().onPadClear(p.id); world.render(); }],
                [/^I click the add tile (\d+) times$/, n => { for (let i = 0; i < +n; i++) { grid().onAdd(); world.render(); } }],
                [/^I click the add tile$/, () => { grid().onAdd(); world.render(); }],
                [/^I click "(.+)"$/, id => click(id)],
                [/^I select the tree row "(.+)"$/, label => { tree().onSelect(node(label).id); world.render(); }],
                [/^I set "(.+)" to "(.*)"$/, (id, value) => {
                    world.render();
                    const control = w.textInputs.get(id);
                    if (!control) throw new Error(`no field ${id}`);
                    control.onChange(value);
                    world.render();
                }],
                [/^I drag the slider "(.+)" to ([\d.]+)$/, (label, value) => {
                    world.render();
                    const slider = [...w.sliders].reverse().find(s => s.label === label);
                    if (!slider) throw new Error(`no slider ${label}; have ${w.sliders.map(s => s.label).join(", ")}`);
                    slider.onChange(String(value));
                    world.render();
                }],
                [/^I advance (\d+) milliseconds$/, ms => world.advance(+ms)],
                [/^I forget what has been played$/, () => { w.played.length = 0; w.sampleHits.length = 0; w.previews.length = 0; }],

                [/^the tree row "(.+)" is at depth (\d+)$/, (label, d) => expect(node(label).depth).toBe(+d)],
                [/^the tree row "(.+)" is at depth (\d+) and says "(.+)"$/, (label, d, detail) => {
                    expect([node(label).depth, node(label).detail]).toEqual([+d, detail]);
                }],
                [/^the tree row "(.+)" comes before the tree row "(.+)"$/, (a, b) => {
                    const labels = tree().nodes.map((n: any) => n.label);
                    expect(labels.indexOf(a)).toBeGreaterThanOrEqual(0);
                    expect(labels.indexOf(a)).toBeLessThan(labels.indexOf(b));
                }],
                [/^the tree lists "(.+)"$/, label => expect(node(label)).toBeTruthy()],
                [/^the tree has no row "(.+)"$/, label => expect(tree().nodes.some((n: any) => n.label === label)).toBe(false)],
                [/^the engine was asked to preview "(.+)"$/, path => expect(w.previews.some(p => p.path === path)).toBe(true)],
                [/^the preview card shows "(.+)" as armed$/, name => {
                    world.render();
                    const card = w.padGrids.get("browser_preview")?.pads[0];
                    expect(card, "a preview card").toBeTruthy();
                    expect([card.label, card.hint, card.selected]).toEqual([name, "ARMED", true]);
                }],
                [/^I see a label containing "(.+)"$/, text => { world.render(); expect(w.labels.some(l => l.includes(text)), `${text} in ${w.labels.join(" | ")}`).toBe(true); }],

                [/^the saved project has "(.+)" on pad (\d+) of "(.+)"$/, (path, i, name) => expect(savedPad(i, name).sample?.path).toBe(path)],
                [/^the saved project has no sample on pad (\d+) of "(.+)"$/, (i, name) => expect(savedPad(i, name).sample).toBeNull()],
                [/^the saved project has the trim ([\d.]+) to ([\d.]+) on pad (\d+) of "(.+)"$/, (a, b, i, name) => {
                    const s = savedPad(i, name).sample;
                    expect([s.start, s.end]).toEqual([+a, +b]);
                }],
                [/^the saved project has a trim that starts before it ends on pad (\d+) of "(.+)"$/, (i, name) => {
                    const s = savedPad(i, name).sample;
                    expect(s.start).toBeLessThan(s.end);
                }],
                [/^the saved project has (\d+) semitones and a gain of ([\d.]+) on pad (\d+) of "(.+)"$/, (semi, gain, i, name) => {
                    const s = savedPad(i, name).sample;
                    expect([s.semitones, s.gain]).toEqual([+semi, +gain]);
                }],
                [/^the saved project has (\d+) pads on "(.+)"$/, (n, name) => expect(savedTrack(name).rack).toHaveLength(+n)],

                [/^the engine played "(.+)" on the track "(.+)" straight away$/, (path, name) => expect(hitsOn(name).some(h => h.path === path)).toBe(true)],
                [/^the track "(.+)" has played the sample "(.+)"$/, (name, path) => expect(hitsOn(name).some(h => h.path === path)).toBe(true)],
                [/^the track "(.+)" has not played any sample$/, name => expect(hitsOn(name)).toHaveLength(0)],
                [/^the track "(.+)" has played the built-in voice "(.+)"$/, (name, voice) => expect(voicesOn(name)).toContain(voice)],
                [/^the track "(.+)" has not played the built-in voice "(.+)"$/, (name, voice) => expect(voicesOn(name)).not.toContain(voice)],
                [/^every hit of "(.+)" has a gain between ([\d.]+) and ([\d.]+)$/, (path, lo, hi) => {
                    const hits = w.sampleHits.filter(h => h.path === path);
                    expect(hits.length).toBeGreaterThan(0);
                    for (const h of hits) { expect(h.cfg.gain).toBeGreaterThanOrEqual(+lo); expect(h.cfg.gain).toBeLessThanOrEqual(+hi); }
                }],
                [/^the last sample hit on "(.+)" has start ([\d.]+), end ([\d.]+), semitones (-?[\d.]+) and a hold$/, (name, a, b, semi) => {
                    const cfg = hitsOn(name).at(-1)!.cfg;
                    expect([cfg.start, cfg.end, cfg.semitones]).toEqual([+a, +b, +semi]);
                    expect(cfg.hold).toBeGreaterThan(0);
                }],

                [/^the export has sample hits of "(.+)" from (\d+) seconds$/, (path, s) =>
                    expect(w.sampleExports.at(-1)!.some(e => e.path === path && e.startTime >= +s)).toBe(true)],
                [/^the export has no sample hits$/, () => expect(w.sampleExports.at(-1)).toHaveLength(0)],
                [/^the export has no "(.+)" notes before (\d+) seconds$/, (voice, s) =>
                    expect(w.exports.at(-1)!.filter(e => e.waveform === voice && e.startTime < +s)).toHaveLength(0)],

                [/^I call the tool "(.+)" with (\{.*\})$/, (name, json) => callTool(name, JSON.parse(json))],
                [/^the tool succeeded$/, () => expect(w.lastToolResult.success, JSON.stringify(w.lastToolResult)).toBe(true)],
                [/^the tool failed saying "(.+)"$/, text => {
                    expect(w.lastToolResult.success).toBe(false);
                    expect(String(w.lastToolResult.error)).toContain(text);
                }],
                [/^the tool result lists the folder "(.+)"$/, name => expect(w.lastToolResult.entries.some((e: any) => e.name === name && e.folder)).toBe(true)],
                [/^the tool result lists the file "(.+)"$/, name => expect(w.lastToolResult.entries.some((e: any) => e.name === name && !e.folder)).toBe(true)],
                [/^the state shows pad (\d+) of "(.+)" playing a "(.+)"$/, (i, name, plays) => {
                    expect(w.lastToolResult.tracks.find((t: any) => t.name === name).rack[+i].plays).toBe(plays);
                }],
            ];

            for (const text of scenario.steps) {
                const step = steps.find(([re]) => re.test(text));
                if (!step) throw new Error(`No step definition for: ${text}`);
                const match = step[0].exec(text)!;
                await step[1](...match.slice(1));
            }
        });
    }
});
