import { readFileSync } from "node:fs";

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
export function createWorld(initialSaved?: unknown) {
    let uuid = 0;
    let init: (() => Promise<void> | void) | undefined;
    let tabRender: (() => void) | undefined;
    const windowRenders: (() => void)[] = [];
    const updates: (() => void)[] = [];
    const w = {
        clock: 1_000_000,
        saved: null as any,
        tools: new Map<string, (args: any) => any>(),
        buttons: new Map<string, () => void>(),
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
        played: [] as { id: string; cfg: any }[],
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
        sliders: [] as any[],
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
        lastCreatedTrackId: "",
        lastToolResult: null as any,
    };

    const wrap = (_win: string, body: (win: string) => void) => body("win");
    const widgets = {
        collapsingHeader: (win: string, _title: string, body: (w: string) => void) => body(win),
        horizontal: wrap, vertical: wrap, group: wrap,
        button: (_win: string, c: any) => { w.buttons.set(c.id ?? `text:${c.text}`, c.onClick); },
        label: (_win: string, c: any) => { w.labels.push(c.text); },
        slider: (_win: string, c: any) => { w.sliders.push(c); }, separator: () => {},
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
            save: (p: unknown) => { w.saved = JSON.parse(JSON.stringify(p)); },
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
            playNoteOnTrack: (id: string, cfg: any) => { w.played.push({ id, cfg }); },
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
            renderPatternToWav: (events: any[], _name: string, sampleEvents?: any[], wavetableEvents?: any[]) => {
                w.exports.push(events);
                w.sampleExports.push(sampleEvents ?? []);
                w.wavetableExports.push(wavetableEvents ?? []);
                return { success: true, path: "test.wav", durationSeconds: 1 };
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
        UI: {
            Widget: widgets,
            createWindow: (cfg: any) => { windowRenders.push(cfg.onRender); const id = `window-${windowRenders.length}`; w.windowTitles[id] = cfg.title; return id; },
            setWindowVisible: (id: string, visible: boolean) => { w.windowVisible[id] = visible; },
        },
        Window: { getSize: () => [1400, 900] },
        Composer: undefined,
    };

    const render = () => {
        w.buttons.clear(); w.textInputs.clear(); w.numerics.clear(); w.dropdowns.clear();
        w.checkboxes.clear(); w.spectra.clear(); w.scopes.clear(); w.meters.clear();
        w.padGrids.clear(); w.trees.clear(); w.sliders = []; w.wavetableViews.clear();
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

