import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BRASS_INSTRUMENTS, BRASS_MUTES, BRASS_STYLES, BRASS_WAVEFORM, applyInstrument, applyMute, applyStyle, bendForSlide,
    defaultBrass, describeSettings, handAndBell, heldSeconds, noteConfig, repairBrass,
} from "../src/apps/daw_brass";
import { createWorld } from "./daw_test_world";

// --- The model, on its own -------------------------------------------------------------------------

describe("The brass model", () => {
    it("repairs a damaged saved track instead of throwing", () => {
        const b = repairBrass({ instrument: "kazoo", breath: 7, lipTension: -9, articulation: "slap", tongue: 0, style: "wild", brassiness: 99, auditionNote: 3 });
        expect(b.instrument).toBe("trombone");
        expect(b.breath).toBe(1);
        expect(b.lipTension).toBe(-1);
        expect(b.articulation).toBe("tongued");
        expect(b.tongue).toBe(0.001);
        expect(b.style).toBe("section");
        expect(b.brassiness).toBe(4);
        expect(b.auditionNote).toBe(24);
        expect(repairBrass(null)).toEqual(defaultBrass());
        expect(repairBrass("garbage")).toEqual(defaultBrass());
    });

    it("keeps what an older save had and defaults the rest", () => {
        const b = repairBrass({ breath: 0.8, vibratoDepth: 12 });
        expect(b.breath).toBe(0.8);
        expect(b.vibratoDepth).toBe(12);
        expect(b.slideTime).toBe(defaultBrass().slideTime);
        expect(b.physicsView).toBe(false);
    });

    it("plays in a style: the player changes, the instrument stays", () => {
        const b = defaultBrass();
        b.aperture = 0.8;
        expect(applyStyle(b, "blazing")).toBe(true);
        expect(b.breath).toBeGreaterThan(0.9);
        expect(b.articulation).toBe("tongued");
        expect(b.style).toBe("blazing");
        expect(b.instrument).toBe("trombone");
        expect(b.aperture).toBe(0.8);
        expect(applyStyle(b, "chorale")).toBe(true);
        expect(b.breath).toBeLessThan(0.4);
        expect(b.articulation).toBe("legato");
        expect(applyStyle(b, "nope")).toBe(false);
        expect(applyInstrument(b, "trombone")).toBe(true);
        expect(applyInstrument(b, "kazoo")).toBe(false);
    });

    it("styles are ordered from soft to loud where they are dynamics", () => {
        const breath = (id: string) => BRASS_STYLES.find(s => s.id === id)!.settings.breath!;
        expect(breath("chorale")).toBeLessThan(breath("section"));
        expect(breath("section")).toBeLessThan(breath("fanfare"));
        expect(breath("fanfare")).toBeLessThan(breath("blazing"));
    });

    it("tongued notes leave a gap; slurred ones overlap the next so the player joins them", () => {
        const b = defaultBrass();
        expect(heldSeconds(b, 0.25)).toBeLessThan(0.25);
        b.articulation = "legato";
        expect(heldSeconds(b, 0.25)).toBeGreaterThan(0.25);
        b.articulation = "glissando";
        expect(heldSeconds(b, 0.25)).toBeGreaterThan(0.25);
    });

    it("turns a track and a note into the engine's config, played by the track's player", () => {
        const b = { ...defaultBrass(), breath: 0.7, tongue: 0.01, lipTension: 0.2 };
        const cfg = noteConfig("trk-x", b, { freq: 233.08, velocity: 0.9, duration: 0.5, startTime: 2 });
        expect(cfg).toMatchObject({ trackId: "trk-x", instrumentId: "trk-x", instrument: "trombone", freq: 233.08, velocity: 0.9, breath: 0.7, attack: 0.01, lipTension: 0.2, duration: 0.5, startTime: 2 });
        expect("duration" in noteConfig("t", b, { freq: 1, velocity: 1 })).toBe(false);
    });

    it("a slide position becomes a bend: a semitone a position, down as the slide goes out", () => {
        expect(bendForSlide(4, 1)).toBe(-300);
        expect(bendForSlide(1, 1)).toBeCloseTo(0);
        expect(bendForSlide(2.5, 3)).toBe(50);
    });

    it("switching instrument brings its own hand, bell and range; a mute stays in until taken out", () => {
        const b = defaultBrass();
        b.hand = 0.9; b.bellFacing = 1;
        expect(applyInstrument(b, "horn")).toBe(true);
        expect(b.hand).toBeNull();
        expect(handAndBell(b)).toEqual({ hand: 0.35, bellFacing: 0.15 });
        // B-flat 3 is in the horn's range, so the audition note stays; a note too high for the tuba
        // moves to the tuba's own.
        expect(b.auditionNote).toBe(58);
        applyInstrument(b, "trumpet");
        b.auditionNote = 80;
        expect(applyMute(b, "harmon")).toBe(true);
        expect(applyMute(b, "sock")).toBe(false);
        applyInstrument(b, "tuba");
        expect(b.mute).toBe("harmon");
        expect(b.auditionNote).toBe(41);
    });

    it("sends the mute always and the hand and bell only when the track sets them", () => {
        const b = defaultBrass("horn");
        const usual = noteConfig("t", b, { freq: 349.2, velocity: 0.8 });
        expect(usual).toMatchObject({ instrument: "horn", mute: "open" });
        expect("hand" in usual || "bellFacing" in usual).toBe(false);
        b.hand = 1; b.bellFacing = 0.9; b.mute = "straight";
        expect(noteConfig("t", b, { freq: 349.2, velocity: 0.8 })).toMatchObject({ mute: "straight", hand: 1, bellFacing: 0.9 });
        const saved = repairBrass(JSON.parse(JSON.stringify(b)));
        expect(saved).toMatchObject({ instrument: "horn", mute: "straight", hand: 1, bellFacing: 0.9 });
        expect(repairBrass({ ...b, mute: "sock", hand: 7, bellFacing: "up" })).toMatchObject({ mute: "open", hand: 1, bellFacing: null });
    });

    it("lists what it offers", () => {
        expect(BRASS_WAVEFORM).toBe("brass");
        expect(BRASS_INSTRUMENTS.map(p => p.id)).toEqual(["trombone", "trumpet", "horn", "tuba"]);
        expect(BRASS_MUTES.map(m => m.id)).toEqual(["open", "straight", "cup", "harmon"]);
        for (const p of BRASS_INSTRUMENTS) {
            expect(p.audition).toBeGreaterThanOrEqual(p.range[0]);
            expect(p.audition).toBeLessThanOrEqual(p.range[1]);
        }
        expect(BRASS_STYLES.map(s => s.id)).toEqual(["chorale", "section", "fanfare", "blazing", "glissando", "rough"]);
        expect(Object.keys(describeSettings(defaultBrass()))).toContain("breath");
    });
});

// --- The addon, through its production callbacks ----------------------------------------------------

describe("The DAW's brass (production addon callbacks)", () => {
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
        // The lead becomes brass, is selected, and the Brass window is open.
        tool("daw_set_track_params", { trackId: "trk-lead", waveform: "brass" });
        click(`select_track_${trackIndex("trk-lead")}`);
        click("toggle_brass");
        const view = () => {
            const v = w.brassViews.get("br_trk-lead");
            if (!v) throw new Error(`no brass view; have ${[...w.brassViews.keys()].join(", ")}`);
            return v;
        };
        const held = () => [...w.brassHeld.values()].filter(n => !n.released);
        return { world, w, click, tool, view, held, state };
    }

    it("makes a track brass, shows its player and plays keys through the track's own player", async () => {
        const { w, view, held, world } = await openDaw();
        expect(Object.values(w.windowTitles)).toContain("Brass");
        expect(view().instrument).toBe("trk-lead");
        view().onKeyDown(58, 0.9);
        world.render();
        expect(held().length).toBe(1);
        expect(held()[0].cfg).toMatchObject({ trackId: "trk-lead", instrumentId: "trk-lead", instrument: "trombone" });
        expect(held()[0].cfg.freq).toBeCloseTo(233.08, 1);
        expect(view().held).toContain(58);
        view().onKeyUp(58);
        expect(held().length).toBe(0);
    });

    it("styles, knobs and the playing map steer a held note live", async () => {
        const { w, click, view, held, world } = await openDaw();
        click("br_latch");
        expect(held().length).toBe(1);
        click("br_style_blazing");
        expect(held()[0].live.breath).toBeGreaterThan(0.9);
        view().onPlayDrag(0.35, -0.4);
        world.render();
        expect(held()[0].live).toMatchObject({ breath: 0.35, lipTension: -0.4 });
        const knob = w.knobs.find(k => k.label === "Breath")!;
        knob.onChange("0.6");
        expect(held()[0].live.breath).toBe(0.6);
        click("br_latch");
        expect(held().length).toBe(0);
    });

    it("dragging the slide bends the held note by a semitone a position", async () => {
        const { w, click, view, held, world } = await openDaw();
        click("br_latch");
        w.brassInfo.set("trk-lead", { ok: true, playing: true, position: 1.0 });
        view().onSlideDrag(3.0);
        world.render();
        expect(held()[0].live.bend).toBe(-200);
        // The engine now reports the bent slide (3); dragging back to 2 bends by one position less.
        w.brassInfo.set("trk-lead", { ok: true, playing: true, position: 3.0 });
        view().onSlideDrag(2.0);
        expect(held()[0].live.bend).toBe(-100);
    });

    it("the AI tool plays a style, changes params and hears a note", async () => {
        const { tool } = await openDaw();
        const s = tool("daw_brass", { trackId: "trk-lead", action: "style", style: "fanfare" });
        expect(s.success).toBe(true);
        expect(s.settings.style).toBe("fanfare");
        const p = tool("daw_brass", { trackId: "trk-lead", action: "params", params: { breath: 3, articulation: "glissando" } });
        expect(p.settings.breath).toBe(1);
        expect(p.settings.articulation).toBe("glissando");
        const h = tool("daw_brass", { trackId: "trk-lead", action: "hear", note: 58 });
        expect(h.success).toBe(true);
        expect(h.note).toMatch(/^A#3|Bb3/);
        expect(h.partial).toBe(4);
        expect(tool("daw_brass", { trackId: "trk-lead", action: "style", style: "nope" }).success).toBe(false);
        expect(tool("daw_brass", { trackId: "trk-kick", action: "info" }).success).toBe(false);
    });

    it("saves the track's brass settings and describes them in the state", async () => {
        const { world, w, tool, state } = await openDaw();
        tool("daw_brass", { trackId: "trk-lead", action: "style", style: "chorale" });
        world.advance(400);
        const saved = w.saved.tracks.find((t: any) => t.id === "trk-lead");
        expect(saved.voice.waveform).toBe("brass");
        expect(saved.brass.style).toBe("chorale");
        expect(state().tracks.find((t: any) => t.id === "trk-lead").brass.articulation).toBe("legato");
    });

    it("the sequencer plays the track's notes on its player, and the export hands them over", async () => {
        const { world, w, tool } = await openDaw();
        tool("daw_set_notes", { trackId: "trk-lead", notes: [{ row: 0, step: 0, length: 2 }, { row: 2, step: 2, length: 2 }, { row: 4, step: 4, length: 2 }] });
        tool("daw_set_transport", { mode: "pattern", playing: true });
        world.advance(3000);
        tool("daw_set_transport", { playing: false });
        expect(w.brassNotes.length).toBeGreaterThan(0);
        expect(w.brassNotes.every(n => n.id === "trk-lead" && n.cfg.instrumentId === "trk-lead")).toBe(true);
        // Tongued by default: a note ends before the next begins.
        const first = w.brassNotes[0].cfg;
        expect(first.articulation).toBe("tongued");
        tool("daw_export_wav", {});
        const exported = w.brassExports.at(-1)!;
        expect(exported.length).toBeGreaterThan(0);
        expect(exported.every((e: any) => e.trackId === "trk-lead" && typeof e.startTime === "number" && e.duration > 0)).toBe(true);
        // The same notes are not also exported as plain oscillator notes.
        expect(w.exports.at(-1)!.every((e: any) => e.track !== "trk-lead")).toBe(true);
    });

    it("a legato track's sequenced notes overlap, so the player slurs them", async () => {
        const { world, w, tool } = await openDaw();
        tool("daw_brass", { trackId: "trk-lead", action: "params", params: { articulation: "legato" } });
        tool("daw_set_notes", { trackId: "trk-lead", notes: [{ row: 0, step: 0, length: 2 }, { row: 2, step: 2, length: 2 }] });
        tool("daw_export_wav", {});
        const events = w.brassExports.at(-1)!.slice().sort((a: any, b: any) => a.startTime - b.startTime);
        expect(events.length).toBeGreaterThan(1);
        expect(events[0].startTime + events[0].duration).toBeGreaterThan(events[1].startTime);
        void world;
    });

    it("the family: choose an instrument and a mute; a held note is played again on the new air column", async () => {
        const { click, held, view, w } = await openDaw();
        click("br_latch");
        const first = held()[0];
        expect(first.cfg.instrument).toBe("trombone");
        click("br_instrument_horn");
        expect(first.released).toBe(true);
        expect(held().length).toBe(1);
        expect(held()[0].cfg).toMatchObject({ instrument: "horn", mute: "open" });
        expect(view().firstKey).toBe(41);
        click("br_mute_straight");
        expect(held()[0].cfg).toMatchObject({ instrument: "horn", mute: "straight" });
        // The hand knob shows the horn's usual hand, and turning it applies from the next note.
        const hand = w.knobs.find(k => k.label === "Hand")!;
        expect(hand.value).toBeCloseTo(0.35);
        hand.onChange("1");
        click("br_latch");
        click("br_latch");
        expect(held()[0].cfg.hand).toBe(1);
        // A trumpet has no slide to time.
        click("br_instrument_trumpet");
        expect(w.knobs.some(k => k.label === "Slide")).toBe(false);
    });

    it("the AI tool plays the family: instrument, mute, hand and bell, and hears the valves", async () => {
        const { tool } = await openDaw();
        expect(tool("daw_brass", { trackId: "trk-lead", action: "instrument", instrument: "trumpet" }).settings.instrument).toBe("trumpet");
        const p = tool("daw_brass", { trackId: "trk-lead", action: "params", params: { mute: "cup", hand: 0.5, bellFacing: 2 } });
        expect(p.settings).toMatchObject({ mute: "cup", hand: 0.5, bellFacing: 1 });
        expect(tool("daw_brass", { trackId: "trk-lead", action: "params", params: { hand: null } }).settings.hand).toBe("usual");
        const h = tool("daw_brass", { trackId: "trk-lead", action: "hear", note: 69 });
        expect(h.valves).toEqual([2]);
        expect("slidePosition" in h).toBe(false);
        expect(tool("daw_brass", { trackId: "trk-lead", action: "instrument", instrument: "sousaphone" }).success).toBe(false);
    });

    it("deleting the track removes its player", async () => {
        const { w, tool } = await openDaw();
        tool("daw_delete_track", { trackId: "trk-lead" });
        expect(w.removedBrass).toContain("trk-lead");
    });
});
