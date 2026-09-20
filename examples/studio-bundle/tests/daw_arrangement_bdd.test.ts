import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
    activePattern,
    barSteps,
    clipsOfTrack,
    createClip,
    duplicateClip,
    expandArrangement,
    freeSpan,
    laneCount,
    laneTracks,
    migrateProject,
    moveClip,
    resizeClip,
    snapUnitSteps,
    triggersAt,
    type ArrProject,
} from "../src/apps/daw_arrangement";

// Executable Gherkin subset (same approach as canvas_animation_bdd.test.ts): an unknown line or
// step fails loudly instead of being skipped, so the feature file cannot drift from what runs.
interface Scenario { name: string; steps: string[] }
function parseFeature(file: string): Scenario[] {
    const scenarios: Scenario[] = [];
    const text = readFileSync(new URL(`../../../tests/features/${file}.feature`, import.meta.url), "utf8");
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith("Feature:")) continue;
        if (line.startsWith("Scenario:")) { scenarios.push({ name: line.slice(9).trim(), steps: [] }); continue; }
        const step = /^(Given|When|Then|And|But) (.+)$/.exec(line);
        if (!step || !scenarios.length) throw new Error(`Unsupported Gherkin: ${line}`);
        scenarios.at(-1)!.steps.push(step[2]);
    }
    return scenarios;
}

// A legacy save: one looping `notes` array per track and one global `steps`, no patterns/clips.
const LEGACY_PROJECT = {
    bpm: 110, steps: 16, stepsPerBeat: 4, activeTrackId: "t1",
    tracks: [{
        id: "t1", name: "Old drums", kind: "drum", rootNote: 60, scale: "chromatic", rows: 5,
        voice: { waveform: "kick", cutoff: 1800, resonance: 1, attack: 0.002, decay: 0.12, sustain: 0, release: 0.08, delayTime: 0, delayFeedback: 0.35, delayMix: 0, reverbRoomSize: 10, reverbTime: 0.8, reverbDamping: 0.5, reverbMix: 0 },
        gain: 0.5, muted: false, solo: false,
        notes: [{ row: 0, step: 0, length: 1, velocity: 1 }, { row: 0, step: 8, length: 1, velocity: 1 }],
    }],
};

// The production addon runs against a stand-in `Entropy`: widgets are captured each render so a
// step can call the exact callbacks the real widgets would, and every audio/IO call is recorded.
function createWorld(initialSaved?: unknown) {
    let uuid = 0;
    let init: (() => Promise<void> | void) | undefined;
    let tabRender: (() => void) | undefined;
    const updates: (() => void)[] = [];
    const w = {
        clock: 1_000_000,
        saved: null as any,
        tools: new Map<string, (args: any) => any>(),
        buttons: new Map<string, () => void>(),
        textInputs: new Map<string, any>(),
        numerics: new Map<string, any>(),
        dropdowns: new Map<string, any>(),
        piano: null as any,
        arrangement: null as any,
        labels: [] as string[],
        played: [] as { id: string; cfg: any }[],
        buses: new Map<string, any>(),
        exports: [] as any[][],
        lastCreatedTrackId: "",
        lastToolResult: null as any,
    };

    const wrap = (_win: string, body: (win: string) => void) => body("win");
    const widgets = {
        collapsingHeader: (win: string, _title: string, body: (w: string) => void) => body(win),
        horizontal: wrap, vertical: wrap, group: wrap,
        button: (_win: string, c: any) => { w.buttons.set(c.id ?? `text:${c.text}`, c.onClick); },
        label: (_win: string, c: any) => { w.labels.push(c.text); },
        slider: () => {}, checkbox: () => {}, separator: () => {},
        numericInput: (_win: string, c: any) => { w.numerics.set(c.id ?? c.label, c); },
        textInput: (_win: string, c: any) => { w.textInputs.set(c.id ?? c.label, c); },
        dropdown: (_win: string, c: any) => { w.dropdowns.set(c.id ?? c.label, c); },
        pianoRoll: (_win: string, c: any) => { w.piano = c; },
        tracks: (_win: string, c: any) => { if (c.id === "arrangement") w.arrangement = c; },
    };

    const addonApi = {
        onInit: (cb: () => void) => { init = cb; },
        // The real addon registers under two names and the engine ticks only one; the stand-in
        // takes just the "Global" one so a frame is never counted twice.
        onUpdate: () => {},
        onUpdatePlus: (_name: string, cb: () => void) => { updates.push(cb); },
        registerTool: (spec: any, run: (args: any) => any) => { w.tools.set(spec.name, run); },
        UI: { createTab: (cfg: any) => { tabRender = cfg.onRender; return "tab"; } },
        IO: {
            save: (p: unknown) => { w.saved = JSON.parse(JSON.stringify(p)); },
            load: () => (initialSaved ? JSON.parse(JSON.stringify(initialSaved)) : null),
        },
        Audio: {
            ensureTrackBus: (id: string, cfg: any) => { w.buses.set(id, cfg); },
            removeTrackBus: (id: string) => { w.buses.delete(id); },
            playNoteOnTrack: (id: string, cfg: any) => { w.played.push({ id, cfg }); },
            renderPatternToWav: (events: any[], _name: string) => { w.exports.push(events); return { success: true, path: "test.wav", durationSeconds: 1 }; },
        },
        AudioEffect: {
            createDelay: () => `delay-${++uuid}`, createReverb: () => `reverb-${++uuid}`,
            setDelayParams: () => {}, setReverbParams: () => {}, destroy: () => {},
        },
        Vst3: {
            unload: () => {}, load: () => ({ ok: false, error: "no plugins in the test world" }),
            scan: () => ({ plugins: [], skipped: [] }), noteOn: () => {}, pollState: () => null,
            takePeak: () => null, openEditor: () => ({ ok: false }), closeEditor: () => {}, allNotesOff: () => {},
        },
    };

    (globalThis as any).Entropy = {
        println: () => {},
        generateUUID: () => `uuid-${++uuid}`,
        Addon: { register: () => addonApi },
        UI: { Widget: widgets },
        Composer: undefined,
    };

    const render = () => {
        w.buttons.clear(); w.textInputs.clear(); w.numerics.clear(); w.dropdowns.clear();
        w.labels = []; w.piano = null; w.arrangement = null;
        tabRender?.();
    };
    const advance = (ms: number) => {
        for (let left = ms; left > 0; left -= 50) {
            w.clock += Math.min(50, left);
            updates.forEach(fn => fn());
        }
        render();
    };
    return {
        w, render, advance,
        async open() { await import("../src/apps/daw_synth_addon"); await init?.(); render(); },
    };
}

describe("The DAW arranges tracks on a 16-channel timeline (production addon callbacks)", () => {
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); delete (globalThis as any).Entropy; });

    for (const scenario of parseFeature("daw_arrangement")) {
        it(scenario.name, async () => {
            vi.resetModules();
            let world = createWorld();
            vi.spyOn(Date, "now").mockImplementation(() => world.w.clock);
            // Steps read the *current* world, which is replaced when a scenario opens a legacy save.
            const w = new Proxy({} as ReturnType<typeof createWorld>["w"], {
                get: (_, key) => (world.w as any)[key],
                set: (_, key, value) => { (world.w as any)[key] = value; return true; },
            });

            const lanes = () => w.arrangement.tracks as any[];
            const lane = (n: number) => lanes()[n - 1];
            const barMs = () => w.arrangement.options.barMs as number;
            const findClip = (id: string) => {
                for (const t of lanes()) { const c = t.clips.find((c: any) => c.id === id); if (c) return { track: t, clip: c }; }
                throw new Error(`no clip ${id} on the arrangement`);
            };
            const state = () => w.tools.get("daw_get_state")!({});
            const trackIdNamed = (name: string) => {
                const t = state().tracks.find((t: any) => t.name === name);
                if (!t) throw new Error(`no track named ${name}`);
                return t.id as string;
            };
            const click = (id: string) => {
                world.render();
                if (!w.buttons.has(id)) throw new Error(`no button ${id}; have ${[...w.buttons.keys()].join(", ")}`);
                w.buttons.get(id)!();
                world.render();
            };
            // Drags only mark the project dirty; the frame loop saves once things settle.
            const settled = () => { world.advance(400); return w.saved; };
            const savedTrackOnLane = (n: number) => settled().tracks.find((t: any) => t.channel === n - 1);
            const send = (event: string) => {
                world.render();
                const [type, , ...rest] = event.split("|");
                const c = w.arrangement;
                const int = (s: string) => parseInt(s, 10);
                if (type === "TRACKS_SEEK") c.onSeek(int(rest[0]));
                else if (type === "TRACKS_CLIP_SELECTED") c.onClipSelected(rest[0], rest[1]);
                else if (type === "TRACKS_TRACK_MUTE") c.onTrackMute(rest[0]);
                else if (type === "TRACKS_TRACK_SOLO") c.onTrackSolo(rest[0]);
                else throw new Error(`the test world does not route ${type}`);
                world.render();
            };
            const positionBar = () => {
                const label = w.labels.find(l => /^Bar \d+ /.test(l));
                if (!label) throw new Error(`no position readout in ${w.labels.join(" | ")}`);
                return parseInt(/^Bar (\d+) /.exec(label)![1], 10);
            };
            const toolArgs = (json: string, withTrack: boolean) => {
                const args = JSON.parse(json);
                if (withTrack) args.trackId = w.lastCreatedTrackId;
                return args;
            };
            const callTool = (name: string, args: any) => {
                w.lastToolResult = w.tools.get(name)!(args);
                if (name === "daw_create_track") w.lastCreatedTrackId = w.lastToolResult.id;
                world.render();
            };

            const steps: [RegExp, (...m: string[]) => void | Promise<void>][] = [
                [/^the DAW is open$/, async () => { await world.open(); }],
                [/^the DAW is open on a project saved before arrangements existed$/, async () => {
                    world = createWorld(LEGACY_PROJECT);
                    await world.open();
                }],
                [/^the arrangement shows (\d+) lanes$/, n => expect(lanes()).toHaveLength(+n)],
                [/^lane (\d+) is the track "(.+)"$/, (n, name) => { expect(lane(+n).label).toBe(name); expect(lane(+n).placeholder).not.toBe(true); }],
                [/^lane (\d+) is an empty channel$/, n => { expect(lane(+n).placeholder).toBe(true); expect(lane(+n).id).toBe(`empty:${+n - 1}`); }],
                [/^no lane is an empty channel$/, () => expect(lanes().filter(t => t.placeholder)).toHaveLength(0)],
                [/^the arrangement ruler is in bars of (\d+) ms with a beat of (\d+) ms$/, (bar, beat) => {
                    expect(w.arrangement.options.barMs).toBe(+bar);
                    expect(w.arrangement.options.beatMs).toBe(+beat);
                }],
                [/^I click "(.+)" (\d+) times$/, (id, n) => { for (let i = 0; i < +n; i++) click(id); }],
                [/^I click "(.+)"$/, id => click(id)],
                [/^I click the header of lane (\d+)$/, n => { world.render(); w.arrangement.onTrackClicked(lane(+n).id); world.render(); }],
                [/^I draw a clip on lane (\d+) from bar ([\d.]+) for ([\d.]+) bars$/, (n, from, bars) => {
                    world.render();
                    w.arrangement.onClipCreate(lane(+n).id, +from * barMs(), +bars * barMs());
                    world.render();
                }],
                [/^lane (\d+) holds a track with (\d+) clips?$/, (n, count) => {
                    expect(lane(+n).placeholder).not.toBe(true);
                    expect(lane(+n).clips).toHaveLength(+count);
                }],
                [/^the saved project has (\d+) tracks$/, n => expect(settled().tracks).toHaveLength(+n)],
                [/^the saved track on lane (\d+) has a clip starting at bar ([\d.]+) lasting ([\d.]+) bars$/, (n, start, bars) => {
                    const t = savedTrackOnLane(+n);
                    expect(t, `a saved track on lane ${n}`).toBeTruthy();
                    const clips = w.saved.arrangement.filter((c: any) => c.trackId === t.id);
                    expect(clips.some((c: any) => c.startStep === +start * 16 && c.lengthSteps === +bars * 16),
                        `clips on lane ${n}: ${JSON.stringify(clips)}`).toBe(true);
                }],
                [/^clip "(.+)" previews (\d+) notes and loops every (\d+) ms$/, (id, notes, loop) => {
                    const { clip } = findClip(id);
                    expect(clip.notes).toHaveLength(+notes);
                    expect(clip.loopMs).toBe(+loop);
                }],
                [/^clip "(.+)" is drawn from (\d+) ms for (\d+) ms and loops every (\d+) ms$/, (id, start, dur, loop) => {
                    const { clip } = findClip(id);
                    expect([clip.startMs, clip.durationMs, clip.loopMs]).toEqual([+start, +dur, +loop]);
                }],
                [/^I move clip "(.+)" to bar ([\d.]+)$/, (id, bar) => {
                    world.render();
                    const { track } = findClip(id);
                    w.arrangement.onClipMoved(track.id, id, +bar * barMs());
                    world.render();
                }],
                [/^I resize clip "(.+)" to end at bar ([\d.]+)$/, (id, bar) => {
                    world.render();
                    const { track, clip } = findClip(id);
                    w.arrangement.onClipResized(track.id, id, clip.startMs, +bar * barMs() - clip.startMs);
                    world.render();
                }],
                [/^clip "(.+)" starts at bar ([\d.]+)$/, (id, bar) => expect(findClip(id).clip.startMs).toBeCloseTo(+bar * barMs(), 0)],
                [/^clip "(.+)" starts at bar ([\d.]+) and ends at bar ([\d.]+)$/, (id, start, end) => {
                    const { clip } = findClip(id);
                    expect(clip.startMs).toBeCloseTo(+start * barMs(), 0);
                    expect(clip.startMs + clip.durationMs).toBeCloseTo(+end * barMs(), 0);
                }],
                [/^the saved project has no overlapping clips$/, () => {
                    const project = settled();
                    for (const t of project.tracks) {
                        const lane = project.arrangement.filter((c: any) => c.trackId === t.id).sort((a: any, b: any) => a.startStep - b.startStep);
                        lane.forEach((c: any, i: number) => { if (i > 0) expect(c.startStep).toBeGreaterThanOrEqual(lane[i - 1].startStep + lane[i - 1].lengthSteps); });
                    }
                }],
                [/^I duplicate clip "(.+)"$/, id => { world.render(); w.arrangement.onClipDuplicate(findClip(id).track.id, id); world.render(); }],
                [/^I delete clip "(.+)"$/, id => { world.render(); w.arrangement.onClipDelete(findClip(id).track.id, id); world.render(); }],
                [/^I see the label "(.+)"$/, text => expect(w.labels).toContain(text)],
                [/^I send the widget event "(.+)"$/, event => send(event)],
                [/^track "(.+)" is muted on its audio bus$/, name => expect(w.buses.get(trackIdNamed(name)).muted).toBe(true)],
                [/^track "(.+)" is soloed on its audio bus$/, name => expect(w.buses.get(trackIdNamed(name)).solo).toBe(true)],
                [/^the BPM is (\d+)$/, n => expect(state().bpm).toBe(+n)],
                [/^the BPM box shows "(.*)"$/, text => expect(w.textInputs.get("bpm_input").value).toBe(text)],
                [/^I set "(.+)" to "(.*)"$/, (id, value) => {
                    world.render();
                    const control = w.textInputs.get(id) ?? w.numerics.get(id);
                    if (!control) throw new Error(`no field ${id}`);
                    control.onChange(value);
                    world.render();
                }],
                [/^I choose option (\d+) of "(.+)"$/, (i, id) => { world.render(); w.dropdowns.get(id).onChange(String(i)); world.render(); }],
                [/^I advance (\d+) milliseconds$/, ms => world.advance(+ms)],
                [/^the position reads bar (\d+)$/, n => { world.render(); expect(positionBar()).toBe(+n); }],
                [/^track "(.+)" has played notes$/, name => expect(w.played.some(p => p.id === trackIdNamed(name))).toBe(true)],
                [/^track "(.+)" has not played$/, name => expect(w.played.some(p => p.id === trackIdNamed(name))).toBe(false)],
                [/^the export has notes after (\d+) seconds$/, s => expect(w.exports.at(-1)!.some(e => e.startTime > +s)).toBe(true)],
                [/^the export has no "(.+)" notes before (\d+) seconds$/, (voice, s) =>
                    expect(w.exports.at(-1)!.filter(e => e.waveform === voice && e.startTime < +s)).toHaveLength(0)],
                [/^I paint a note on row (\d+) at step (\d+)$/, (row, step) => {
                    world.render();
                    const p = w.piano;
                    const displayRow = p.rows - 1 - +row; // synth rows are drawn flipped
                    p.onNoteDown(displayRow, +step);
                    p.onNoteUp(displayRow, +step);
                    world.render();
                }],
                [/^clip "(.+)" plays a pattern named "(.+)"$/, (id, name) => {
                    const project = settled();
                    const clip = project.arrangement.find((c: any) => c.id === id);
                    const track = project.tracks.find((t: any) => t.id === clip.trackId);
                    expect(track.patterns.find((p: any) => p.id === clip.patternId).name).toBe(name);
                }],
                [/^I call the tool "(.+)" with (\{.*\})$/, (name, json) => callTool(name, toolArgs(json, false))],
                [/^I call the tool "(.+)" for that track with (\{.*\})$/, (name, json) => callTool(name, toolArgs(json, true))],
                [/^the tool result skipped (\d+) clips?$/, n => expect(w.lastToolResult.skipped).toHaveLength(+n)],
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

// The arrangement rules, exercised directly: the properties the scenarios above lean on, over
// more inputs than a feature file would sensibly spell out.
describe("Arrangement model properties", () => {
    let n = 0;
    const id = () => `id-${++n}`;
    const track = (tid: string, channel: number, patternSteps = 16, notes: any[] = []) => ({
        id: tid, channel, kind: "synth" as const, rows: 10, muted: false, solo: false,
        patterns: [{ id: `${tid}-p`, name: "P", steps: patternSteps, notes }], activePatternId: `${tid}-p`,
    });
    const project = (tracks: any[], arrangement: any[] = []): ArrProject => ({
        bpm: 120, stepsPerBeat: 4, songBars: 8, snap: "bar", arrangement, tracks,
    });

    it("never lets two clips on a lane overlap however they are dragged", () => {
        const arr: any[] = [];
        const total = 8 * 16;
        expect(createClip(arr, { trackId: "t", patternId: "p", startStep: 0, lengthSteps: 32 }, total, id)).toBeTruthy();
        expect(createClip(arr, { trackId: "t", patternId: "p", startStep: 64, lengthSteps: 32 }, total, id)).toBeTruthy();
        const mid = createClip(arr, { trackId: "t", patternId: "p", startStep: 40, lengthSteps: 16 }, total, id)!;
        // Random walks of moves and resizes.
        let seed = 7;
        const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (let i = 0; i < 400; i++) {
            if (rand() < 0.5) moveClip(arr, mid.id, Math.floor(rand() * total), total);
            else resizeClip(arr, mid.id, Math.floor(rand() * total), 1 + Math.floor(rand() * 60), total);
            const lane = clipsOfTrack(arr, "t");
            lane.forEach((c, k) => {
                expect(c.startStep).toBeGreaterThanOrEqual(0);
                expect(c.startStep + c.lengthSteps).toBeLessThanOrEqual(total);
                if (k > 0) expect(c.startStep).toBeGreaterThanOrEqual(lane[k - 1].startStep + lane[k - 1].lengthSteps);
            });
        }
    });

    it("refuses to start a clip inside another and caps one that runs into the next", () => {
        const arr: any[] = [];
        createClip(arr, { trackId: "t", patternId: "p", startStep: 32, lengthSteps: 16 }, 128, id);
        expect(createClip(arr, { trackId: "t", patternId: "p", startStep: 40, lengthSteps: 4 }, 128, id)).toBeNull();
        const capped = createClip(arr, { trackId: "t", patternId: "p", startStep: 16, lengthSteps: 64 }, 128, id)!;
        expect(capped.startStep + capped.lengthSteps).toBe(32);
        // The same span on a different lane is free.
        expect(createClip(arr, { trackId: "other", patternId: "p", startStep: 40, lengthSteps: 4 }, 128, id)).toBeTruthy();
    });

    it("tiles a pattern across a clip and cuts notes where the clip ends", () => {
        const t = track("t", 0, 8, [{ row: 0, step: 0, length: 4, velocity: 1 }, { row: 1, step: 6, length: 4, velocity: 1 }]);
        const p = project([t], [{ id: "c", trackId: "t", patternId: "t-p", startStep: 4, lengthSteps: 20 }]);
        const notes = expandArrangement(p, { respectMuteSolo: false });
        // Repeats begin at steps 4, 12 and 20; the last repeat is cut at 24.
        expect(notes.map(x => x.startStep)).toEqual([4, 10, 12, 18, 20]);
        expect(notes.find(x => x.startStep === 18)!.lengthSteps).toBe(4);
        expect(notes.find(x => x.startStep === 20)!.lengthSteps).toBe(4);
        expect(triggersAt(p, 12).map(x => x.note.row)).toEqual([0]);
        expect(triggersAt(p, 3)).toHaveLength(0);
        expect(triggersAt(p, 24)).toHaveLength(0);
    });

    it("honours mute and solo when rendering, but not when triggering live", () => {
        const a = track("a", 0, 4, [{ row: 0, step: 0, length: 1, velocity: 1 }]);
        const b = { ...track("b", 1, 4, [{ row: 0, step: 0, length: 1, velocity: 1 }]), solo: true };
        const p = project([a, b], [
            { id: "ca", trackId: "a", patternId: "a-p", startStep: 0, lengthSteps: 4 },
            { id: "cb", trackId: "b", patternId: "b-p", startStep: 0, lengthSteps: 4 },
        ]);
        expect(expandArrangement(p, { respectMuteSolo: true }).map(x => x.track.id)).toEqual(["b"]);
        expect(triggersAt(p, 0).map(x => x.track.id).sort()).toEqual(["a", "b"]);
    });

    it("sizes lanes to at least 16 and finds each track on its own channel", () => {
        expect(laneCount([])).toBe(16);
        expect(laneCount([{ channel: 15 }])).toBe(16);
        expect(laneCount([{ channel: 16 }])).toBe(17);
        const lanes = laneTracks([{ channel: 2, tag: "x" }, { channel: 0, tag: "y" }]);
        expect(lanes[0]?.tag).toBe("y");
        expect(lanes[1]).toBeNull();
        expect(lanes[2]?.tag).toBe("x");
    });

    it("migrates a legacy project without losing notes and gives tracks distinct channels", () => {
        const saved: any = JSON.parse(JSON.stringify(LEGACY_PROJECT));
        saved.tracks.push({ ...JSON.parse(JSON.stringify(LEGACY_PROJECT.tracks[0])), id: "t2", name: "Second", notes: [] });
        migrateProject(saved, id);
        expect(saved.steps).toBeUndefined();
        expect(saved.tracks.map((t: any) => t.channel)).toEqual([0, 1]);
        expect(saved.tracks[0].notes).toBeUndefined();
        expect(activePattern(saved.tracks[0]).notes).toHaveLength(2);
        // Only the track that had notes gets a clip, and it spans the song like the old loop did.
        expect(saved.arrangement).toHaveLength(1);
        expect(saved.arrangement[0].lengthSteps).toBe(8 * barSteps(4));
        // Migrating a second time changes nothing.
        const before = JSON.stringify(saved);
        migrateProject(saved, id);
        expect(JSON.stringify(saved)).toBe(before);
    });

    it("snaps to a bar, a beat or a step", () => {
        expect([snapUnitSteps("bar", 4), snapUnitSteps("beat", 4), snapUnitSteps("step", 4)]).toEqual([16, 4, 1]);
        expect(snapUnitSteps("bar", 2)).toBe(8);
    });

    it("reports free space around a clip and a gap for a duplicate", () => {
        const arr: any[] = [];
        const a = createClip(arr, { trackId: "t", patternId: "p", startStep: 16, lengthSteps: 16 }, 128, id)!;
        createClip(arr, { trackId: "t", patternId: "p", startStep: 64, lengthSteps: 16 }, 128, id);
        expect(freeSpan(arr, a, 128)).toEqual({ left: 0, right: 64 });
        const copy = duplicateClip(arr, a.id, 128, id)!;
        expect(copy.startStep).toBe(32);
        expect(copy.patternId).toBe("p");
    });
});
