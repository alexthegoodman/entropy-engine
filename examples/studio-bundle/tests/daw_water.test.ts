import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_MIX, PITCHED_ROWS, RACK_GLASSES, RAIN_SURFACES, VIEW_FILL_SECONDS, VIEW_HOLD_SECONDS, WATER_PLAYS, WATER_PRESETS, WATER_SOURCES, WATER_WAVEFORM, WEATHER_ROWS,
    applyPreset, brookSpeed, defaultWater, describeSettings, dripPan, glassSpeed, noteConfig, rainRate, repairWater, rowsFor, sameBuild, viewNoteConfig, viewRow,
} from "../src/apps/daw_water";
import { createWorld } from "./daw_test_world";

// --- The model, on its own -------------------------------------------------------------------------

describe("The water model", () => {
    it("repairs a damaged saved track instead of throwing", () => {
        const w = repairWater({ play: "tsunami", rain: "ocean", vessel: "bathtub", spoon: "yes", dynamics: 9, mix: { drip: 999, rain: "loud" }, preset: "polka" });
        expect(w.play).toBe("glass");
        expect(w.rain).toBe("lake");
        expect(w.vessel).toBe("bottle");
        expect(w.spoon).toBe(false);
        expect(w.dynamics).toBe(1);
        expect(w.mix.drip).toBe(32);
        expect(w.mix.rain).toBe(DEFAULT_MIX.rain);
        expect(w.preset).toBe("glass-harp");
        expect(w.weatherSource).toBe("rain");
        expect(repairWater({ weatherSource: "surf" }).weatherSource).toBe("surf");
        expect(repairWater({ weatherSource: "hail" }).weatherSource).toBe("rain");
        expect(repairWater(null)).toEqual(defaultWater());
        expect(repairWater("garbage")).toEqual(defaultWater());
    });

    it("a preset sets how it plays and what the rain falls on, and keeps the mix", () => {
        const w = defaultWater();
        w.mix.glass = 3;
        expect(applyPreset(w, "tin-roof")).toBe(true);
        expect(w).toMatchObject({ preset: "tin-roof", play: "weather", rain: "roof" });
        expect(w.mix.glass).toBe(3);
        expect(applyPreset(w, "polka")).toBe(false);
        expect(WATER_PRESETS.every(p => repairWater({ ...defaultWater(), ...p.settings }).play === (p.settings.play ?? "glass"))).toBe(true);
    });

    it("only the rain's surface is built; everything else is chosen per note", () => {
        const a = defaultWater();
        expect(sameBuild(a, { ...a, play: "fill", vessel: "jug", spoon: true, dynamics: 0.1 })).toBe(true);
        expect(sameBuild(a, { ...a, rain: "tent" })).toBe(false);
    });

    it("all plays use note rows, with weather using its selected source", () => {
        const w = defaultWater();
        expect(rowsFor(w)).toBeNull();
        const glass = noteConfig("t", w, { freq: 440, velocity: 0.5 });
        expect(glass).toMatchObject({ trackId: "t", waterId: "t", action: "glass", pitch: 440, spoon: false, water: { rain: "lake", vessel: "bottle" } });
        const drip = noteConfig("t", { ...w, play: "drip" }, { freq: 1760, velocity: 1 });
        expect(drip).toMatchObject({ action: "drip", pitch: 1760 });
        expect(drip.x).toBeGreaterThan(0);
        const fill = noteConfig("t", { ...w, play: "fill" }, { freq: 330, velocity: 1, duration: 3 });
        expect(fill).toMatchObject({ action: "fill", pitch: 330, duration: 3 });
        // A fill always pours for a moment, however short the note.
        expect(noteConfig("t", { ...w, play: "fill" }, { freq: 330, velocity: 1, duration: 0.01 }).duration).toBe(0.2);
        const weather = { ...w, play: "weather" as const };
        expect(rowsFor(weather)).toBeNull();
        expect(WEATHER_ROWS.map(source => noteConfig("t", { ...weather, weatherSource: source.id }, { freq: 440, velocity: 0.5, duration: 2 }).action)).toEqual(["rain", "brook", "surf", "slosh"]);
        expect(noteConfig("t", weather, { row: 0, velocity: 0.5, duration: 2, startTime: 1.5 })).toMatchObject({ rate: rainRate(0.5, weather), duration: 2, startTime: 1.5 });
    });

    it("velocity is how hard, evenly in ratio, and dynamics caps it", () => {
        const w = defaultWater();
        expect(glassSpeed(0, w)).toBeCloseTo(0.05);
        expect(glassSpeed(1, { ...w, dynamics: 1 })).toBeCloseTo(1.0);
        // At no dynamics a full-velocity note still goes a quarter of the way (in ratio).
        expect(glassSpeed(1, { ...w, dynamics: 0 })).toBeCloseTo(0.05 * 20 ** 0.25);
        // A spoon's contact is far stiffer: it is played much more gently.
        expect(glassSpeed(1, { ...w, spoon: true, dynamics: 1 })).toBeCloseTo(0.08);
        expect(rainRate(0, w)).toBeCloseTo(0.5);
        expect(rainRate(1, { ...w, dynamics: 1 })).toBeCloseTo(80);
        const mid = brookSpeed(0.5, { ...w, dynamics: 1 });
        expect(mid / brookSpeed(0, w)).toBeCloseTo(brookSpeed(1, { ...w, dynamics: 1 }) / mid);
    });

    it("drips spread low to the left and high to the right", () => {
        expect(dripPan(262)).toBeLessThan(0);
        expect(dripPan(523.25)).toBeCloseTo(0);
        expect(dripPan(4186)).toBeCloseTo(0.8);
    });

    it("a click in the view plays as itself, up the track's scale", () => {
        const w = defaultWater();
        const freq = (row: number) => 100 * (row + 1);
        expect(viewRow(0, 10)).toBe(0);
        expect(viewRow(1, 10)).toBe(9);
        expect(viewRow(NaN, 10)).toBe(0);
        // Left to right across the basin goes up the scale; the drop lands where it was clicked.
        const left = viewNoteConfig("t", w, { kind: "drip", x: -1, velocity: 0.5 }, freq, 10)!;
        const right = viewNoteConfig("t", w, { kind: "drip", x: 0.8, velocity: 0.5 }, freq, 10)!;
        expect(left).toMatchObject({ action: "drip", pitch: 100, x: -1 });
        expect(right).toMatchObject({ action: "drip", pitch: 900, x: 0.8 });
        // A glass is struck at its own pitch; an empty place in the rack takes its place's row.
        expect(viewNoteConfig("t", w, { kind: "glass", index: 3, pitch: 440, velocity: 0.7 }, freq, 10)).toMatchObject({ action: "glass", pitch: 440 });
        expect(viewNoteConfig("t", w, { kind: "glass", index: RACK_GLASSES - 1, pitch: 0, velocity: 0.7 }, freq, 10)).toMatchObject({ action: "glass", pitch: 1000 });
        // Up a vessel is up the scale, poured for a moment.
        expect(viewNoteConfig("t", w, { kind: "fill", height: 0.5, velocity: 0.7 }, freq, 5)).toMatchObject({ action: "fill", pitch: 300, duration: VIEW_FILL_SECONDS });
        // Holding weather keeps it going a moment, whatever the track plays.
        expect(viewNoteConfig("t", w, { kind: "hold", source: "surf", velocity: 1 }, freq, 10)).toMatchObject({ action: "surf", duration: VIEW_HOLD_SECONDS });
        expect(viewNoteConfig("t", w, { kind: "hold", source: "slosh", velocity: 0.2 }, freq, 10)).toMatchObject({ action: "slosh" });
        expect(viewNoteConfig("t", w, { kind: "hold", source: "glass", velocity: 0.2 }, freq, 10)).toBeNull();
        // The track's own settings still apply (a spoon, the rain's surface).
        expect(viewNoteConfig("t", { ...w, spoon: true, rain: "tent" }, { kind: "glass", index: 0, pitch: 523, velocity: 1 }, freq, 10)).toMatchObject({ spoon: true, water: { rain: "tent" } });
    });

    it("keeps Physics View through a save", () => {
        expect(repairWater({ ...defaultWater(), physicsView: true }).physicsView).toBe(true);
        expect(repairWater({ physicsView: "yes" }).physicsView).toBe(false);
    });

    it("describes itself for the AI", () => {
        expect(describeSettings(defaultWater())).toMatchObject({ play: "glass", rain: "lake" });
        expect(describeSettings({ ...defaultWater(), play: "weather", weatherSource: "surf" }).weatherSource).toBe("surf");
        expect(WATER_PLAYS.map(p => p.id)).toEqual(["glass", "drip", "fill", "weather"]);
        expect(WATER_SOURCES.length).toBe(7);
        expect(RAIN_SURFACES.length).toBe(6);
    });
});

// --- In the DAW ----------------------------------------------------------------------------------

describe("The DAW's water (production addon callbacks)", () => {
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); delete (globalThis as any).Entropy; });

    async function openDaw() {
        vi.resetModules();
        const world = createWorld();
        vi.spyOn(Date, "now").mockImplementation(() => world.w.clock);
        await world.open();
        const w = world.w;
        const state = () => w.tools.get("daw_get_state")!({});
        const trackIndex = (id: string) => state().tracks.findIndex((t: any) => t.id === id);
        const click = (id: string) => {
            world.render();
            if (!w.buttons.has(id)) throw new Error(`no button ${id}; have ${[...w.buttons.keys()].join(", ")}`);
            w.buttons.get(id)!();
            world.render();
        };
        const tool = (name: string, args: any) => { const r = w.tools.get(name)!(args); world.render(); return r; };
        // The lead becomes water, is selected, and the Water window is open.
        tool("daw_set_track_params", { trackId: "trk-lead", waveform: WATER_WAVEFORM });
        click(`select_track_${trackIndex("trk-lead")}`);
        click("toggle_water");
        return { world, w, click, tool, state };
    }

    it("makes a track water, prepares it at once and shows its window", async () => {
        const { w, state } = await openDaw();
        expect(Object.values(w.windowTitles)).toContain("Water");
        expect(w.waterPrepared.some(p => p.id === "trk-lead" && p.cfg.waterId === "trk-lead" && p.cfg.water.rain === "lake")).toBe(true);
        const t = state().tracks.find((t: any) => t.id === "trk-lead");
        expect(t.water).toMatchObject({ play: "glass", rain: "lake" });
        // A glass harp plays the scale.
        expect(t.rows).toBe(PITCHED_ROWS);
    });

    it("weather keeps note rows and plays the source selected in the window", async () => {
        const { click, state, w, tool } = await openDaw();
        click("wr_play_weather");
        let t = state().tracks.find((t: any) => t.id === "trk-lead");
        expect(t.rows).toBe(PITCHED_ROWS);
        expect(t.rowNotes).toHaveLength(PITCHED_ROWS);
        expect(t.rowNotes).not.toContain("Rain");
        click("wr_weather_surf");
        tool("daw_water", { trackId: "trk-lead", action: "play", row: 8 });
        expect(w.waterNotes.at(-1)!.cfg.action).toBe("surf");
        tool("daw_set_notes", { trackId: "trk-lead", notes: [{ row: 8, step: 0, length: 4 }] });
        tool("daw_export_wav", {});
        expect(w.waterExports.at(-1)!.some((note: any) => note.trackId === "trk-lead" && note.action === "surf")).toBe(true);
        expect(state().tracks.find((t: any) => t.id === "trk-lead").water.weatherSource).toBe("surf");
        click("wr_play_drip");
        t = state().tracks.find((t: any) => t.id === "trk-lead");
        expect(t.rows).toBe(PITCHED_ROWS);
    });

    it("the pads play each kind of water, and the rain's surface rebuilds it", async () => {
        const { w, click } = await openDaw();
        for (const src of WATER_SOURCES) click("wr_pad_" + src.id);
        expect(w.waterNotes.map(n => n.cfg.action)).toEqual(WATER_SOURCES.map(s => s.id));
        expect(w.waterNotes.every(n => n.id === "trk-lead")).toBe(true);
        click("wr_rain_tent");
        expect(w.waterPrepared.at(-1)!.cfg.water.rain).toBe("tent");
        click("wr_preset_tin-roof");
        expect(w.waterPrepared.at(-1)!.cfg.water.rain).toBe("roof");
    });

    it("a note while the water is first being built is dropped, and the window says so", async () => {
        const { w, click, world } = await openDaw();
        w.waterStatus = "building";
        click("wr_pad_drip");
        world.render();
        expect(w.waterNotes.length).toBe(0);
        expect(w.labels.some((l: any) => /Building the water/.test(l.text ?? l))).toBe(true);
    });

    it("the AI tool sets presets and params, mixes, hears and plays", async () => {
        const { tool, w } = await openDaw();
        expect(tool("daw_water", { trackId: "trk-lead", action: "preset", preset: "bottles" }).settings).toMatchObject({ play: "fill", vessel: "bottle" });
        const p = tool("daw_water", { trackId: "trk-lead", action: "params", params: { play: "glass", spoon: true, dynamics: 7, rain: "cymbal" } });
        expect(p.settings).toMatchObject({ play: "glass", spoon: true, dynamics: 1, rain: "cymbal" });
        expect(w.waterPrepared.at(-1)!.cfg.water.rain).toBe("cymbal");
        expect(tool("daw_water", { trackId: "trk-lead", action: "mix", mix: { glass: 4, rain: -2 } }).settings.mix).toMatchObject({ glass: 4, rain: 0 });
        const h = tool("daw_water", { trackId: "trk-lead", action: "hear", row: 0, velocity: 0.5 });
        expect(h).toMatchObject({ success: true, action: "glass" });
        expect(h.glass.pitchHz).toBeCloseTo(h.strongestHz, 0);
        expect(tool("daw_water", { trackId: "trk-lead", action: "play", row: 2 }).success).toBe(true);
        expect(w.waterNotes.at(-1)!.cfg).toMatchObject({ action: "glass", spoon: true });
        expect(tool("daw_water", { trackId: "trk-lead", action: "preset", preset: "polka" }).success).toBe(false);
        expect(tool("daw_water", { trackId: "trk-kick", action: "info" }).success).toBe(false);
    });

    it("saves the water and describes it in the state", async () => {
        const { world, w, tool, state } = await openDaw();
        tool("daw_water", { trackId: "trk-lead", action: "preset", preset: "lakeside" });
        world.advance(400);
        const saved = w.saved.tracks.find((t: any) => t.id === "trk-lead");
        expect(saved.voice.waveform).toBe(WATER_WAVEFORM);
        expect(saved.water.preset).toBe("lakeside");
        expect(state().tracks.find((t: any) => t.id === "trk-lead").water.play).toBe("weather");
    });

    it("the sequencer plays notes on the water, and the export hands them over", async () => {
        const { world, w, tool } = await openDaw();
        tool("daw_set_notes", { trackId: "trk-lead", notes: [{ row: 0, step: 0, length: 1 }, { row: 4, step: 2, length: 1 }, { row: 7, step: 4, length: 2 }] });
        tool("daw_set_transport", { mode: "pattern", playing: true });
        world.advance(2500);
        tool("daw_set_transport", { playing: false });
        const glasses = w.waterNotes.filter(n => n.cfg.action === "glass");
        expect(glasses.length).toBeGreaterThanOrEqual(3);
        // Higher rows are higher glasses.
        const pitches = [...new Set(glasses.map(n => n.cfg.pitch))].sort((a, b) => a - b);
        expect(pitches.length).toBe(3);
        tool("daw_export_wav", {});
        const exported = w.waterExports.at(-1)!;
        expect(exported.length).toBeGreaterThan(0);
        expect(exported.every((e: any) => e.trackId === "trk-lead" && e.action === "glass" && typeof e.startTime === "number" && pitches.includes(e.pitch))).toBe(true);
        // The same notes are not also exported as plain oscillator notes.
        expect(w.exports.at(-1)!.every((e: any) => e.track !== "trk-lead")).toBe(true);
    });

    it("weather notes are held as long as the note, live and in the export", async () => {
        const { world, w, tool, click } = await openDaw();
        click("wr_play_weather");
        tool("daw_set_notes", { trackId: "trk-lead", notes: [{ row: 0, step: 0, length: 8 }] });
        tool("daw_set_transport", { mode: "pattern", playing: true });
        world.advance(800);
        tool("daw_set_transport", { playing: false });
        const rain = w.waterNotes.find(n => n.cfg.action === "rain")!;
        expect(rain.cfg.duration).toBeGreaterThan(0.5);
        tool("daw_export_wav", {});
        const out = w.waterExports.at(-1)!.find((e: any) => e.action === "rain");
        expect(out.duration).toBeCloseTo(rain.cfg.duration, 3);
    });

    it("the window draws the track's water, and playing it plays the track", async () => {
        const { w, world, click, state } = await openDaw();
        const view = () => {
            world.render();
            const v = w.waterViews.get("wr_trk-lead");
            if (!v) throw new Error(`no water view; have ${[...w.waterViews.keys()].join(", ")}`);
            return v;
        };
        expect(view()).toMatchObject({ water: "trk-lead", physicsView: false });
        view().onDrip(-1, 0.6);
        view().onGlass(2, 0, 0.8);
        view().onFill(1, 0.5);
        view().onHold("rain", 0.9);
        view().onPad("brook", 0.4);
        const notes = w.waterNotes.map(n => n.cfg);
        expect(notes.map(n => n.action)).toEqual(["drip", "glass", "fill", "rain", "brook"]);
        expect(w.waterNotes.every(n => n.id === "trk-lead")).toBe(true);
        // The drip is the scale's lowest row, where it was clicked; the fill its highest.
        const t = state().tracks.find((t: any) => t.id === "trk-lead");
        expect(notes[0].x).toBe(-1);
        expect(notes[0].pitch).toBeLessThan(notes[2].pitch);
        expect(notes[3].duration).toBe(VIEW_HOLD_SECONDS);
        expect(t.water.play).toBe("glass");
        // Physics View, from the chip or the button, is remembered.
        view().onPhysicsView(true);
        expect(view().physicsView).toBe(true);
        click("wr_physics");
        expect(view().physicsView).toBe(false);
    });

    it("deleting the track stops its water", async () => {
        const { w, tool } = await openDaw();
        tool("daw_delete_track", { trackId: "trk-lead" });
        expect(w.removedWater).toContain("trk-lead");
        expect(w.removedWaterIds).toContain("trk-lead");
    });
});
