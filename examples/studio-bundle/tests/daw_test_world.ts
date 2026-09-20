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
        padGrids: new Map<string, any>(),
        trees: new Map<string, any>(),
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
            renderPatternToWav: (events: any[], _name: string, sampleEvents?: any[]) => {
                w.exports.push(events);
                w.sampleExports.push(sampleEvents ?? []);
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
            createWindow: (cfg: any) => { windowRenders.push(cfg.onRender); return `window-${windowRenders.length}`; },
            setWindowVisible: (id: string, visible: boolean) => { w.windowVisible[id] = visible; },
        },
        Window: { getSize: () => [1400, 900] },
        Composer: undefined,
    };

    const render = () => {
        w.buttons.clear(); w.textInputs.clear(); w.numerics.clear(); w.dropdowns.clear();
        w.checkboxes.clear(); w.spectra.clear(); w.scopes.clear(); w.meters.clear();
        w.padGrids.clear(); w.trees.clear(); w.sliders = [];
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

