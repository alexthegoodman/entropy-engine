import { readFileSync } from "node:fs";
import { memoryStore } from "../src/apps/daw_library";

// Executable Gherkin subset (same approach as canvas_animation_bdd.test.ts): an unknown line or
// step fails loudly instead of being skipped, so the feature file cannot drift from what runs.
export interface Scenario { name: string; steps: string[] }
export function parseFeature(file: string): Scenario[] {
    const scenarios: Scenario[] = [];
    const text = readFileSync(new URL(`../../../tests/features/${file}.feature`, import.meta.url), "utf8");
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith("Feature:")) continue;
        if (line.startsWith("Scenario:")) { scenarios.push({ name: line.slice(9).trim(), steps: [] }); continue; }
        // Prose under `Feature:` (before the first scenario) is a description, not a step. Anything
        // unrecognised inside a scenario still fails loudly.
        if (!scenarios.length) continue;
        const step = /^(Given|When|Then|And|But) (.+)$/.exec(line);
        if (!step) throw new Error(`Unsupported Gherkin: ${line}`);
        scenarios.at(-1)!.steps.push(step[2]);
    }
    return scenarios;
}

// The production addon runs against a stand-in `Entropy`: widgets are captured each render so a
// step can call the exact callbacks the real widgets would, and every audio/IO call is recorded.
// `initialSaved` is an old single-file DAW.json (what IO.load answers); `files` is the DAW's song
// store as it is on disk (path -> text), so a test can start from, or look at, a saved library.
export function createWorld(initialSaved?: unknown, files = new Map<string, string>()) {
    let uuid = 0;
    let init: (() => Promise<void> | void) | undefined;
    let tabRender: (() => void) | undefined;
    const windowRenders: (() => void)[] = [];
    const updates: (() => void)[] = [];
    const store = memoryStore(files);
    // What IO.save was last handed: only used when the app has no store.
    let legacySaved: any = null;
    const w = {
        clock: 1_000_000,
        // The open song exactly as persisted: the song file the library index says is open.
        get saved(): any {
            const index = JSON.parse(files.get("library.json") ?? "null");
            const id = index?.currentSongId;
            const doc = id ? JSON.parse(files.get(`songs/${id}.json`) ?? "null") : null;
            return doc?.project ?? legacySaved;
        },
        files,
        keyDown: null as null | ((key: string, ctrl: boolean, shift: boolean, alt: boolean) => void),
        tools: new Map<string, (args: any) => any>(),
        buttons: new Map<string, () => void>(),
        buttonTexts: new Map<string, string>(),
        headers: [] as string[],
        textInputs: new Map<string, any>(),
        numerics: new Map<string, any>(),
        dropdowns: new Map<string, any>(),
        checkboxes: new Map<string, any>(),
        // The analysis widgets, by id, exactly as the addon declared them this frame.
        spectra: new Map<string, any>(),
        scopes: new Map<string, any>(),
        meters: new Map<string, any>(),
        // What `Audio.analyze` answers per source; a source with no entry does not exist.
        analysis: new Map<string, any>(),
        piano: null as any,
        arrangement: null as any,
        labels: [] as string[],
        played: [] as { id: string; cfg: any; at?: number }[],
        buses: new Map<string, any>(),
        exports: [] as any[][],
        // Drum rack. `folders` is the fake disk (path -> entries) and `samples` what the fake engine
        // can decode (path -> info); a path in neither does not exist. `previews`, `sampleHits` and
        // `sampleExports` record what the addon asked the engine to play.
        musicDir: "C:/Music" as string | null,
        pickedFolder: null as string | null,
        folders: {} as Record<string, any[]>,
        samples: {} as Record<string, any>,
        previews: [] as { path: string; cfg: any }[],
        previewStops: 0,
        sampleHits: [] as { id: string; path: string; cfg: any }[],
        sampleExports: [] as any[][],
        // What the WAV export was handed as track buses (the last argument).
        busExports: [] as any[][],
        sliders: [] as any[],
        knobs: [] as any[],
        windowVisible: {} as Record<string, boolean>,
        windowTitles: {} as Record<string, string>,
        padGrids: new Map<string, any>(),
        trees: new Map<string, any>(),
        // Wavetables. `wavetableViews` are the editor widgets as the addon declared them this frame;
        // `tables` is the fake engine's registry (a table is a string that records what was done to
        // it, so a test can tell a preset from a stroke from an operation); `wavetableNotes` are timed
        // notes, `heldNotes` the notes started with a gate (by voice id), and `wavetableExports` what
        // the WAV export was handed.
        wavetableViews: new Map<string, any>(),
        tables: new Map<string, { data: string; preset: string; edits: string[] }>(),
        wavetableNotes: [] as { id: string; cfg: any }[],
        heldNotes: new Map<number, { id: string; cfg: any; released: boolean; position: number }>(),
        nextVoice: 1,
        wavetableExports: [] as any[][],
        removedTables: [] as string[],
        // Bowed-string (physmod) notes: unlike a wavetable there is no persistent table to create,
        // so the stand-in just records what was played/held and which instrument ids were removed.
        physModViews: new Map<string, any>(),
        physModNotes: [] as { id: string; cfg: any }[],
        physModHeld: new Map<number, { id: string; cfg: any; released: boolean; bow: Record<string, number> }>(),
        physModExports: [] as any[][],
        removedInstruments: [] as string[],
        // Brass: the views as declared, timed notes, held notes (by voice id, with their live
        // controls), what the export was handed, and removed player ids. `brassInfo` is what
        // `Brass.info` answers per player id (a test sets it to say where the slide is).
        brassViews: new Map<string, any>(),
        brassNotes: [] as { id: string; cfg: any }[],
        brassHeld: new Map<number, { id: string; cfg: any; released: boolean; live: Record<string, number> }>(),
        brassExports: [] as any[][],
        brassInfo: new Map<string, any>(),
        removedBrass: [] as string[],
        // What the WAV export was handed for VST3 tracks, and the vst3Warnings the fake render
        // should hand back on the next export call (reset to [] after each export).
        vst3Exports: [] as any[][],
        nextVst3Warnings: [] as string[],
        // The guitar input: what the panel started it with, every later `target`, and every position
        // pushed to the running voice. `running` is what `status` reports.
        guitar: { running: false, starts: [] as any[], targets: [] as any[], positions: [] as number[] },
        // Character effects (Pump, Gate, Grit, Space, cut faders) by id, as last configured.
        effects: new Map<string, any>(),
        lastCreatedTrackId: "",
        lastToolResult: null as any,
    };

    const wrap = (_win: string, body: (win: string) => void) => body("win");
    const widgets = {
        collapsingHeader: (win: string, title: string, body: (w: string) => void) => { w.headers.push(title); body(win); },
        horizontal: wrap, vertical: wrap, group: wrap,
        button: (_win: string, c: any) => { w.buttons.set(c.id ?? `text:${c.text}`, c.onClick); w.buttonTexts.set(c.id ?? `text:${c.text}`, c.text); },
        label: (_win: string, c: any) => { w.labels.push(c.text); },
        slider: (_win: string, c: any) => { w.sliders.push(c); }, separator: () => {},
        knob: (_win: string, c: any) => { w.knobs.push(c); },
        checkbox: (_win: string, c: any) => { w.checkboxes.set(c.id ?? c.label, c); },
        spectrum: (_win: string, c: any) => { w.spectra.set(c.id, c); },
        oscilloscope: (_win: string, c: any) => { w.scopes.set(c.id, c); },
        levelMeter: (_win: string, c: any) => { w.meters.set(c.id, c); },
        numericInput: (_win: string, c: any) => { w.numerics.set(c.id ?? c.label, c); },
        textInput: (_win: string, c: any) => { w.textInputs.set(c.id ?? c.label, c); },
        dropdown: (_win: string, c: any) => { w.dropdowns.set(c.id ?? c.label, c); },
        pianoRoll: (_win: string, c: any) => { w.piano = c; },
        padGrid: (_win: string, c: any) => { w.padGrids.set(c.id, c); },
        wavetable: (_win: string, c: any) => { w.wavetableViews.set(c.id ?? c.table, c); },
        physModString: (_win: string, c: any) => { w.physModViews.set(c.id ?? c.instrument, c); },
        brass: (_win: string, c: any) => { w.brassViews.set(c.id ?? c.instrument, c); },
        treeView: (_win: string, c: any) => { w.trees.set(c.id, c); },
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
            save: (p: unknown) => { legacySaved = JSON.parse(JSON.stringify(p)); },
            store,
            load: () => (initialSaved ? JSON.parse(JSON.stringify(initialSaved)) : null),
            musicDir: () => w.musicDir,
            pickSampleFolder: () => w.pickedFolder,
            listDir: (path: string) => path in w.folders
                ? { ok: true, entries: w.folders[path] }
                : { ok: false, error: `${path} is outside the folders the sample browser may read`, entries: [] },
        },
        Audio: {
            ensureTrackBus: (id: string, cfg: any) => { w.buses.set(id, cfg); },
            removeTrackBus: (id: string) => { w.buses.delete(id); },
            playNoteOnTrack: (id: string, cfg: any) => { w.played.push({ id, cfg, at: w.clock }); },
            playWavetableOnTrack: (id: string, cfg: any) => {
                if (!w.tables.has(cfg.table)) return { ok: false, error: `no wavetable called ${cfg.table}` };
                w.wavetableNotes.push({ id, cfg });
                return { ok: true };
            },
            wavetableNoteOn: (id: string, cfg: any) => {
                if (!w.tables.has(cfg.table)) return { ok: false, error: `no wavetable called ${cfg.table}` };
                const voice = w.nextVoice++;
                w.heldNotes.set(voice, { id, cfg, released: false, position: cfg.position });
                return { ok: true, voice };
            },
            wavetableNoteOff: (voice: number) => { const n = w.heldNotes.get(voice); if (n) n.released = true; },
            wavetableSetPosition: (voice: number, position: number) => {
                const n = w.heldNotes.get(voice);
                if (n && !n.released) n.position = position;
            },
            playPhysModOnTrack: (id: string, cfg: any) => { w.physModNotes.push({ id, cfg }); return { ok: true }; },
            physModNoteOn: (id: string, cfg: any) => {
                const voice = w.nextVoice++;
                w.physModHeld.set(voice, { id, cfg, released: false, bow: { force: cfg.bowForce, velocity: cfg.bowVelocity, position: cfg.bowPosition, vibratoDepth: cfg.vibratoDepth } });
                return { ok: true, voice };
            },
            physModNoteOff: (voice: number) => { const n = w.physModHeld.get(voice); if (n) n.released = true; },
            physModSetBow: (voice: number, which: string, value: number) => {
                const n = w.physModHeld.get(voice);
                if (n && !n.released) n.bow[which] = value;
            },
            playBrassOnTrack: (id: string, cfg: any) => { w.brassNotes.push({ id, cfg }); return { ok: true }; },
            brassNoteOn: (id: string, cfg: any) => {
                const voice = w.nextVoice++;
                w.brassHeld.set(voice, { id, cfg, released: false, live: { breath: cfg.breath, lipTension: cfg.lipTension, vibratoDepth: cfg.vibratoDepth, bend: 0 } });
                return { ok: true, voice };
            },
            brassNoteOff: (voice: number) => { const n = w.brassHeld.get(voice); if (n) n.released = true; },
            brassSetControl: (voice: number, which: string, value: number) => {
                const n = w.brassHeld.get(voice);
                if (n && !n.released) n.live[which] = value;
            },
            renderPatternToWav: (events: any[], _name: string, sampleEvents?: any[], wavetableEvents?: any[], physModEvents?: any[], vst3Events?: any[], trackBuses?: any[], brassEvents?: any[]) => {
                w.brassExports.push(brassEvents ?? []);
                w.exports.push(events);
                w.sampleExports.push(sampleEvents ?? []);
                w.wavetableExports.push(wavetableEvents ?? []);
                w.physModExports.push(physModEvents ?? []);
                w.vst3Exports.push(vst3Events ?? []);
                w.busExports.push(trackBuses ?? []);
                const vst3Warnings = w.nextVst3Warnings;
                w.nextVst3Warnings = [];
                return { success: true, path: "test.wav", durationSeconds: 1, vst3Warnings };
            },
            loadSample: (path: string) => w.samples[path]
                ? { ok: true, ...w.samples[path] }
                : { ok: false, error: `could not open ${path}`, seconds: 0, truncated: false, sourceRate: 0, channels: 0, peak: 0, waveform: [] },
            playSampleOnTrack: (id: string, path: string, cfg: any) => {
                if (!w.samples[path]) return { ok: false, error: `could not open ${path}` };
                w.sampleHits.push({ id, path, cfg });
                return { ok: true };
            },
            previewSample: (path: string, cfg: any) => {
                if (!w.samples[path]) return { ok: false, error: `could not open ${path}` };
                w.previews.push({ path, cfg });
                return { ok: true };
            },
            stopPreview: () => { w.previewStops++; },
            analyze: (source: string) => w.analysis.get(source) ?? null,
        },
        // Phosphor icons as the addon sees them: a character in the engine, here a readable marker
        // like [play] or [fill:play] so a test can say which icon a button shows. Unknown names
        // return "" like the engine (which also logs once).
        Icons: {
            get: (name: string, style = "regular") => name.startsWith("no-") ? "" : (style === "regular" ? `[${name}]` : `[${style}:${name}]`),
            label: (name: string, text: string, style = "regular") => `${style === "regular" ? `[${name}]` : `[${style}:${name}]`} ${text}`,
            has: (name: string) => !name.startsWith("no-"),
            names: () => [] as string[],
        },
        // The engine's wavetable registry, reduced to what the addon can observe: a table is created as
        // a preset, edited by strokes and operations (each recorded in `edits`), and saved and
        // restored as an opaque string. The stand-in refuses data that did not come from `exportData`,
        // like the real one refuses a string that is not a table.
        Wavetable: {
            ensure: (id: string, options?: { preset?: string }) => {
                const known = ["sine", "saw", "square", "pwm", "vowels", "bell", "terrain", "glass"];
                if (options?.preset && !known.includes(options.preset)) return { ok: false, error: `no preset called ${options.preset}` };
                const t = w.tables.get(id);
                if (!t) w.tables.set(id, { data: `table:${options?.preset ?? "sine"}`, preset: options?.preset ?? "sine", edits: [] });
                else if (options?.preset) { t.data = `table:${options.preset}`; t.preset = options.preset; t.edits.push(`preset ${options.preset}`); }
                return { ok: true, id, frames: 32, canUndo: false, canRedo: false };
            },
            remove: (id: string) => { w.removedTables.push(id); return w.tables.delete(id); },
            info: (id: string) => w.tables.has(id) ? { ok: true, id, frames: 32, canUndo: w.tables.get(id)!.edits.length > 0, canRedo: false, activity: null, activeVoices: 0 } : { ok: false, error: `no wavetable called ${id}` },
            op: (id: string, name: string, arg?: number) => {
                const t = w.tables.get(id);
                if (!t) return { ok: false, error: `no wavetable called ${id}` };
                t.data += `+${name}`; t.edits.push(`op ${name}${arg ? " " + arg : ""}`);
                return { ok: true };
            },
            stamp: (id: string, stamps: any[]) => {
                const t = w.tables.get(id);
                if (!t) return { ok: false, error: `no wavetable called ${id}` };
                for (const s of stamps) if (!["raise", "lower", "smooth", "level"].includes(s.tool)) return { ok: false, error: `no brush called ${s.tool}` };
                t.data += `+stamp${stamps.length}`; t.edits.push(`stamp x${stamps.length}`);
                return { ok: true, touchedFrames: [Math.max(0, Math.floor(stamps[0].frame) - 3), Math.floor(stamps[0].frame) + 3] };
            },
            setFrame: () => ({ ok: true }),
            exportData: (id: string) => w.tables.get(id)?.data ?? null,
            importData: (id: string, data: string) => {
                if (!data.startsWith("table:")) return { ok: false, error: "not a wavetable (missing WVT1 header)" };
                const t = w.tables.get(id);
                if (!t) w.tables.set(id, { data, preset: "custom", edits: ["imported"] });
                else { t.data = data; t.edits.push("imported"); }
                return { ok: true };
            },
            harmonics: () => ({ ok: true, frame: 0, harmonics: [1, 0.5, 0.33, 0.25], peak: 0.9, rms: 0.6 }),
            // Brightness follows the position, so a test can tell where in the table a note was heard.
            analyzeNote: (cfg: any) => w.tables.has(cfg.table)
                ? { ok: true, seconds: 0.85, peakDb: -12, rmsDb: -15, peakHz: cfg.freq, centroidHz: 300 + 4000 * cfg.position }
                : { ok: false, error: `no wavetable called ${cfg.table}` },
        },
        // The engine's bowed-string registry, reduced to what the addon can observe. Unlike Wavetable
        // there is nothing to "create" - a real PhysModShared is auto-created on first note, so the
        // stand-in reports every id as existing once a note has played on it or the view has drawn it.
        PhysMod: {
            info: (id: string) => ({ ok: true, id, activeVoices: 0, activity: null }),
            remove: (id: string) => { w.removedInstruments.push(id); return true; },
            shape: () => ({ ok: true, version: 0, points: [] }),
            analyzeNote: (cfg: any) => ({ ok: true, seconds: 0.7, peakDb: -12, rmsDb: -15, peakHz: cfg.freq, centroidHz: 300 + 4000 * cfg.bowForce }),
        },
        // The engine's brass registry, reduced to what the addon can observe. `analyzeNote` gets
        // brighter with breath, so a test can tell what breath a note was heard at.
        Brass: {
            info: (id: string) => w.brassInfo.get(id) ?? { ok: true, id, playing: false },
            remove: (id: string) => { w.removedBrass.push(id); return true; },
            analyzeNote: (cfg: any) => ({ ok: true, seconds: 0.9, peakDb: -10, rmsDb: -14, pitchHz: cfg.freq, centsOff: 0.5, centroidHz: 400 + 3000 * cfg.breath, harmonicsDb: [0, -3, -6], partial: 4, position: 1, mouthPressurePa: 500 * 32 ** cfg.breath, waveSteepness: 1e6, attackSeconds: 0.04 }),
        },
        Guitar: {
            listInputs: () => ({ devices: [], hosts: [] }),
            start: (cfg: any) => {
                w.guitar.running = true; w.guitar.starts.push(cfg);
                return { ok: true, opened: { device: "Test input", host: "Test", sampleRate: 48000, channels: 1, bufferFrames: null, sampleFormat: "f32", notes: [] } };
            },
            stop: () => { w.guitar.running = false; return { ok: true }; },
            set: () => ({ ok: true }),
            target: (t: any) => { w.guitar.targets.push(t); return { ok: true }; },
            setPosition: (p: number) => { w.guitar.positions.push(p); },
            status: () => !w.guitar.running ? { running: false } : {
                running: true, deviceLost: false, recording: false, bufferNote: null,
                calibration: { state: "idle", busy: false, finished: null },
                settings: { mode: "balanced", sensitivity: 0.5, gateOpenDb: -50, gateCloseDb: -56, bendRange: 2, referencePitch: 440, inputGainDb: 0, velocityFloorDb: -50, velocityCeilDb: -10 },
                diagnostics: {
                    levelDb: -40, inputPeakDb: -30, clipped: false, freqHz: 0, confidence: 0, note: null, cents: 0, state: "silent", velocity: 0, bend: 8192,
                    pipelineLatencyMs: 0, bufferMs: 10, bufferFrames: 480, sampleRate: 48000, callbacks: 1, overruns: 0, streamErrors: 0, maxCallbackUs: 10,
                    meanCallbackUs: 10, droppedBends: 0, droppedEvents: 0, notes: 0, noiseRejects: 0, octaveRejects: 0, octaveCorrections: 0, slides: 0, repicks: 0,
                },
            },
            calibrate: () => ({ ok: true }), record: () => ({ ok: true, notes: [] }), releaseAll: () => ({ ok: true }),
        },
        AudioEffect: {
            createDelay: () => `delay-${++uuid}`, createReverb: () => `reverb-${++uuid}`,
            setDelayParams: () => {}, setReverbParams: () => {},
            // Character effects are recorded by id with their latest settings, so a step can say
            // which effects a track's bus chains and what the knob sent them.
            createCharacter: (cfg: any) => { const id = `${cfg.kind}-${++uuid}`; w.effects.set(id, { ...cfg }); return id; },
            setCharacterParams: (id: string, cfg: any) => { if (w.effects.has(id)) w.effects.set(id, { ...cfg }); },
            destroy: (id: string) => { w.effects.delete(id); },
        },
        Vst3: {
            unload: () => {}, load: () => ({ ok: false, error: "no plugins in the test world" }),
            scan: () => ({ plugins: [], skipped: [] }), noteOn: () => {}, pollState: () => null,
            saveState: () => null,
            takePeak: () => null, openEditor: () => ({ ok: false }), closeEditor: () => {}, allNotesOff: () => {},
        },
    };

    (globalThis as any).Entropy = {
        println: () => {},
        generateUUID: () => `uuid-${++uuid}`,
        Addon: { register: () => addonApi },
        Icons: addonApi.Icons,
        UI: {
            Widget: widgets,
            createWindow: (cfg: any) => { windowRenders.push(cfg.onRender); const id = `window-${windowRenders.length}`; w.windowTitles[id] = cfg.title; return id; },
            setWindowVisible: (id: string, visible: boolean) => { w.windowVisible[id] = visible; },
        },
        Window: { getSize: () => [1400, 900] },
        Input: { onKeyDown: (cb: any) => { w.keyDown = cb; return () => {}; } },
        Composer: undefined,
    };

    const render = () => {
        w.buttons.clear(); w.buttonTexts.clear(); w.headers = []; w.textInputs.clear(); w.numerics.clear(); w.dropdowns.clear();
        w.checkboxes.clear(); w.spectra.clear(); w.scopes.clear(); w.meters.clear();
        w.padGrids.clear(); w.trees.clear(); w.sliders = []; w.knobs = []; w.wavetableViews.clear(); w.brassViews.clear();
        w.labels = []; w.piano = null; w.arrangement = null;
        tabRender?.();
        windowRenders.forEach(fn => fn());
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

