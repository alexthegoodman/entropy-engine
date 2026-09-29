import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PIANO_PRESETS,
    PIANO_WAVEFORM,
    applyPreset,
    defaultPiano,
    describeSettings,
    heldSeconds,
    noteConfig,
    pianoPresetById,
    repairPiano,
} from "../src/apps/daw_piano";
import { createWorld } from "./daw_test_world";

// --- The model, on its own -------------------------------------------------------------------------

describe("The piano model", () => {
    it("repairs a damaged saved track instead of throwing", () => {
        const p = repairPiano({
            preset: "Harpsichord",
            soundboardResonance: 99,
            sympatheticCoupling: -5,
            hammerHardness: 10,
            inharmonicityScale: -1,
            sustainPedal: 4,
            unaCorda: -2,
            auditionNote: 150,
            physicsView: "true",
        });
        expect(p.preset).toBe("ConcertGrand");
        expect(p.soundboardResonance).toBe(2);
        expect(p.sympatheticCoupling).toBe(0);
        expect(p.hammerHardness).toBe(2);
        expect(p.inharmonicityScale).toBe(0);
        expect(p.sustainPedal).toBe(1);
        expect(p.unaCorda).toBe(0);
        expect(p.auditionNote).toBe(108);
        expect(p.physicsView).toBe(false);
        expect(repairPiano(null)).toEqual(defaultPiano());
        expect(repairPiano("garbage")).toEqual(defaultPiano());
    });

    it("keeps what an older save had and defaults the rest", () => {
        const p = repairPiano({ soundboardResonance: 1.5, hammerHardness: 1.2 });
        expect(p.soundboardResonance).toBe(1.5);
        expect(p.hammerHardness).toBe(1.2);
        expect(p.preset).toBe("ConcertGrand");
        expect(p.sympatheticCoupling).toBe(defaultPiano().sympatheticCoupling);
        expect(p.sustainPedal).toBe(0);
        expect(p.physicsView).toBe(false);
    });

    it("applies voicing presets: updates acoustic settings and preset name", () => {
        const p = defaultPiano();
        expect(applyPreset(p, "BrightGrand")).toBe(true);
        expect(p.preset).toBe("BrightGrand");
        expect(p.hammerHardness).toBeGreaterThan(1.2);

        expect(applyPreset(p, "WarmGrand")).toBe(true);
        expect(p.preset).toBe("WarmGrand");
        expect(p.hammerHardness).toBeLessThan(1.0);
        expect(p.soundboardResonance).toBeGreaterThan(1.1);

        expect(applyPreset(p, "StudioGrand")).toBe(true);
        expect(p.preset).toBe("StudioGrand");

        expect(applyPreset(p, "ConcertGrand")).toBe(true);
        expect(p.preset).toBe("ConcertGrand");

        expect(applyPreset(p, "NonExistentPreset")).toBe(false);
    });

    it("presets are all registered with descriptions and valid configs", () => {
        expect(PIANO_PRESETS.map(x => x.id)).toEqual(["ConcertGrand", "StudioGrand", "BrightGrand", "WarmGrand"]);
        for (const pr of PIANO_PRESETS) {
            expect(pr.label.length).toBeGreaterThan(0);
            expect(pr.description.length).toBeGreaterThan(0);
            expect(pianoPresetById(pr.id)).toBe(pr);
        }
    });

    it("sustained notes are held longer than unsustained notes", () => {
        const p = defaultPiano();
        p.sustainPedal = 0;
        const dry = heldSeconds(p, 0.5);
        p.sustainPedal = 1;
        const sustained = heldSeconds(p, 0.5);
        expect(sustained).toBeGreaterThan(dry);
        expect(sustained).toBeGreaterThan(0.5);
    });

    it("turns a track and a note into the engine's config", () => {
        const p = { ...defaultPiano(), soundboardResonance: 1.3, hammerHardness: 1.1 };
        const cfg = noteConfig("trk-keys", p, { freq: 440, velocity: 0.85, duration: 1.2, startTime: 0.5 });
        expect(cfg).toMatchObject({
            trackId: "trk-keys",
            instrumentId: "trk-keys",
            instrument: "trk-keys",
            freq: 440,
            velocity: 0.85,
            gain: 0.8,
            duration: 1.2,
            startTime: 0.5,
            soundboardResonance: 1.3,
            hammerHardness: 1.1,
            preset: "ConcertGrand",
        });
    });

    it("describeSettings exports all relevant acoustic fields", () => {
        const desc = describeSettings(defaultPiano());
        expect(desc).toHaveProperty("preset");
        expect(desc).toHaveProperty("soundboardResonance");
        expect(desc).toHaveProperty("sympatheticCoupling");
        expect(desc).toHaveProperty("hammerHardness");
        expect(desc).toHaveProperty("inharmonicityScale");
        expect(desc).toHaveProperty("sustainPedal");
        expect(desc).toHaveProperty("unaCorda");
        expect(desc).toHaveProperty("quality");
    });
});

// --- The addon, through its production callbacks ----------------------------------------------------

describe("The DAW's piano (production addon callbacks)", () => {
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

        // Make the lead track a piano track, select it, and open the Grand Piano window.
        tool("daw_set_track_params", { trackId: "trk-lead", waveform: "piano" });
        click(`select_track_${trackIndex("trk-lead")}`);
        world.openInstrument("Grand Piano");

        const view = () => {
            const v = w.pianoViews.get("piano_trk-lead");
            if (!v) throw new Error(`no piano view; have ${[...w.pianoViews.keys()].join(", ")}`);
            return v;
        };
        const held = () => [...w.pianoHeld.values()].filter(n => !n.released);
        return { world, w, click, tool, view, held, state };
    }

    it("makes a track piano, opens the Grand Piano window, and interacts with keys", async () => {
        const { w, view, held, world } = await openDaw();
        expect(Object.values(w.windowTitles)).toContain("Grand Piano");
        expect(view().instrument).toBe("trk-lead");

        // Key 39 = C4 (MIDI 60)
        view().onKeyDown(39, 261.63, 0.85);
        world.render();
        expect(held().length).toBe(1);
        expect(held()[0].cfg).toMatchObject({
            trackId: "trk-lead",
            instrumentId: "trk-lead",
            preset: "ConcertGrand",
        });
        expect(held()[0].cfg.freq).toBeCloseTo(261.63, 1);

        view().onKeyUp(39, 261.63);
        world.render();
        expect(held().length).toBe(0);
    });

    it("latches a note to audition and holds it until toggled off", async () => {
        const { click, held } = await openDaw();
        click("piano_latch");
        expect(held().length).toBe(1);
        expect(held()[0].cfg.freq).toBeCloseTo(261.63, 1); // C4 audition note

        click("piano_latch");
        expect(held().length).toBe(0);
    });

    it("switches presets from the voicing menu and applies them", async () => {
        const { w } = await openDaw();
        w.dropdowns.get("piano_preset")!.onChange("2");
        const saved = w.saved.tracks.find((t: any) => t.id === "trk-lead");
        expect(saved.piano.preset).toBe("BrightGrand");
        expect(saved.piano.hammerHardness).toBe(1.35);

        w.dropdowns.get("piano_preset")!.onChange("3");
        const savedWarm = w.saved.tracks.find((t: any) => t.id === "trk-lead");
        expect(savedWarm.piano.preset).toBe("WarmGrand");
        expect(savedWarm.piano.soundboardResonance).toBe(1.25);
    });

    it("pedal knobs update pedals and call pianoSetPedal", async () => {
        const { w } = await openDaw();
        const sustainKnob = w.knobs.find(k => k.label === "Sustain")!;
        sustainKnob.onChange("0.85");
        expect(w.pianoPedals.get("trk-lead")?.sustain).toBeCloseTo(0.85);

        const unaCordaKnob = w.knobs.find(k => k.label === "Una Corda")!;
        unaCordaKnob.onChange("0.65");
        expect(w.pianoPedals.get("trk-lead")?.unaCorda).toBeCloseTo(0.65);
    });

    it("the AI tool daw_piano inspects settings, changes presets, adjusts parameters, sets pedals, and hears a note", async () => {
        const { tool } = await openDaw();

        const info = tool("daw_piano", { trackId: "trk-lead", action: "info" });
        expect(info.success).toBe(true);
        expect(info.settings.preset).toBe("ConcertGrand");

        const pr = tool("daw_piano", { trackId: "trk-lead", action: "preset", preset: "StudioGrand" });
        expect(pr.success).toBe(true);
        expect(pr.settings.preset).toBe("StudioGrand");

        const params = tool("daw_piano", {
            trackId: "trk-lead",
            action: "params",
            params: { soundboardResonance: 1.4, hammerHardness: 1.25 },
        });
        expect(params.success).toBe(true);
        expect(params.settings.soundboardResonance).toBe(1.4);
        expect(params.settings.hammerHardness).toBe(1.25);

        const ped = tool("daw_piano", { trackId: "trk-lead", action: "pedal", sustain: 0.9, unaCorda: 0.5 });
        expect(ped.success).toBe(true);
        expect(ped.settings.sustainPedal).toBe(0.9);
        expect(ped.settings.unaCorda).toBe(0.5);

        const hear = tool("daw_piano", { trackId: "trk-lead", action: "hear", note: 60 });
        expect(hear.success).toBe(true);
        expect(hear.pitchHz).toBeCloseTo(261.63, 1);
        expect(hear.centsOff).toBeDefined();
        expect(hear.contactTimeMs).toBeDefined();

        expect(tool("daw_piano", { trackId: "trk-lead", action: "preset", preset: "Unknown" }).success).toBe(false);
        expect(tool("daw_piano", { trackId: "trk-kick", action: "info" }).success).toBe(false);
    });

    it("pre-warms the piano instrument ahead of play", async () => {
        const { world, w } = await openDaw();
        world.advance(100);
        const lead = () => w.modelPrepared.filter(p => p.kind === "piano" && p.id === "trk-lead");
        expect(lead().length).toBeGreaterThan(0);
        expect(lead().at(-1)!.cfg.instrumentId).toBe("trk-lead");
    });

    it("offline bounce renders piano notes to WAV with EXPORT_QUALITY", async () => {
        const { tool, world, w } = await openDaw();
        // Add a note on the lead track
        tool("daw_set_notes", {
            trackId: "trk-lead",
            notes: [{ row: 0, step: 0, length: 4, velocity: 0.9 }],
        });
        world.render();

        const exportResult = tool("daw_export_wav", {});
        expect(exportResult.success).toBe(true);
        expect(w.pianoExports.length).toBeGreaterThan(0);
        const lastExport = w.pianoExports.at(-1)!;
        expect(lastExport.length).toBeGreaterThan(0);
        expect(lastExport[0]).toMatchObject({
            trackId: "trk-lead",
            quality: "render",
        });
    });

    it("removing a track releases held piano notes and removes the instrument", async () => {
        const { click, held, w, tool } = await openDaw();
        click("piano_latch");
        expect(held().length).toBe(1);

        tool("daw_delete_track", { trackId: "trk-lead" });
        expect(held().length).toBe(0);
        expect(w.removedPiano).toContain("trk-lead");
    });
});
