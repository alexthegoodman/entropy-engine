import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_MIX, MATTER_PIECES, MATTER_PRESETS, MATTER_ROWS, MATTER_WAVEFORM, applyPreset, defaultMatter, describeSettings,
    brushHand, hitConfig, repairMatter, rowForNote, sameBuild, strikeSpeed, strikerFor,
} from "../src/apps/daw_matter";
import { createWorld } from "./daw_test_world";

// --- The model, on its own -------------------------------------------------------------------------

describe("The drum kit model", () => {
    it("repairs a damaged saved track instead of throwing", () => {
        const m = repairMatter({ kit: { kick: 5, snare: 9000, snares: "yes", snareTension: -1 }, mix: { kick: 99, ride: "loud" }, hands: "feet", beater: "hammer", dynamics: 40, preset: "polka" });
        expect(m.kit.kick).toBe(35);
        expect(m.kit.snare).toBe(360);
        expect(m.kit.snares).toBe(true);
        expect(m.kit.snareTension).toBe(0.03);
        expect(m.mix.kick).toBe(8);
        expect(m.mix.ride).toBe(DEFAULT_MIX.ride);
        expect(m.hands).toBe("sticks");
        expect(m.beater).toBe("felt");
        expect(m.dynamics).toBe(12);
        expect(m.preset).toBe("studio");
        expect(repairMatter(null)).toEqual(defaultMatter());
        expect(repairMatter("garbage")).toEqual(defaultMatter());
    });

    it("keeps what an older save had and defaults the rest", () => {
        const m = repairMatter({ kit: { snare: 300 } });
        expect(m.kit.snare).toBe(300);
        expect(m.kit.kick).toBe(defaultMatter().kit.kick);
        expect(m.physicsView).toBe(false);
    });

    it("a preset retunes the drums and the playing, and keeps the mix and the air", () => {
        const m = defaultMatter();
        m.mix.kick = 5;
        m.kit.sympathetic = false;
        expect(applyPreset(m, "jazz")).toBe(true);
        expect(m.kit.kick).toBeGreaterThan(defaultMatter().kit.kick);
        expect(m.kit.kickMuffling).toBeLessThan(0.5);
        expect(m.preset).toBe("jazz");
        expect(m.mix.kick).toBe(5);
        expect(m.kit.sympathetic).toBe(false);
        expect(applyPreset(m, "mallets")).toBe(true);
        expect(m.hands).toBe("mallets");
        expect(m.kit.snares).toBe(false);
        expect(applyPreset(m, "nope")).toBe(false);
    });

    it("velocity is the stick's speed, from a ghost note to the kit's dynamics", () => {
        const m = defaultMatter();
        expect(strikeSpeed(0, m)).toBeCloseTo(0.4);
        expect(strikeSpeed(1, m)).toBeCloseTo(m.dynamics);
        expect(strikeSpeed(0.5, m)).toBeGreaterThan(strikeSpeed(0.3, m));
        m.dynamics = 10;
        expect(strikeSpeed(1, m)).toBeCloseTo(10);
    });

    it("rows strike their pieces where they are played, with the right striker", () => {
        const m = defaultMatter();
        const at = (id: string) => MATTER_ROWS.findIndex(r => r.id === id);
        const snare = hitConfig("t", m, { row: at("snare"), velocity: 0.8 });
        const edge = hitConfig("t", m, { row: at("snare-edge"), velocity: 0.8 });
        expect(snare).toMatchObject({ trackId: "t", kitId: "t", piece: "snare", striker: "stick" });
        expect(edge.piece).toBe("snare");
        expect(edge.position).toBeGreaterThan(snare.position);
        expect(hitConfig("t", m, { row: at("crash"), velocity: 1 }).striker).toBe("shoulder");
        expect(hitConfig("t", m, { row: at("kick"), velocity: 1 }).striker).toBe("felt");
        m.beater = "plastic";
        expect(strikerFor(m, MATTER_ROWS[at("kick")])).toBe("plastic");
        m.hands = "mallets";
        expect(strikerFor(m, MATTER_ROWS[at("ride")])).toBe("yarn");
        expect(strikerFor(m, MATTER_ROWS[at("floor-tom")])).toBe("mallet");
        // A click in the view strikes where it was clicked.
        expect(hitConfig("t", m, { piece: "floor-tom", position: 0.9, angle: 1, velocity: 0.5 })).toMatchObject({ piece: "floor-tom", position: 0.9, angle: 1 });
        // The kit and the mix travel with every hit, and the start time only when given.
        expect(snare.kit).toEqual(m.kit);
        expect("startTime" in snare).toBe(false);
        expect(hitConfig("t", m, { row: 0, velocity: 1, startTime: 2 }).startTime).toBe(2);
    });

    it("brush rows rub the snare for as long as the note, faster and harder with velocity", () => {
        const m = defaultMatter();
        const at = (id: string) => MATTER_ROWS.findIndex(r => r.id === id);
        // After the strikes, so rows saved before brushes keep their meaning.
        expect(at("brush-sweep")).toBeGreaterThan(at("splash"));
        const soft = hitConfig("t", m, { row: at("brush-swirl"), velocity: 0.1, duration: 1.5 });
        const loud = hitConfig("t", m, { row: at("brush-swirl"), velocity: 0.9, duration: 1.5 });
        expect(soft).toMatchObject({ piece: "snare", stroke: "swirl", duration: 1.5 });
        expect(loud.speed).toBeGreaterThan(soft.speed);
        expect(loud.pressure!).toBeGreaterThan(soft.pressure!);
        expect(brushHand(0).speed).toBeCloseTo(0.2);
        expect(brushHand(1).speed).toBeCloseTo(1.2);
        // A note with no length is a short stroke; lengths are kept sane.
        expect(hitConfig("t", m, { row: at("brush-sweep"), velocity: 0.5 }).duration).toBeCloseTo(0.25);
        expect(hitConfig("t", m, { row: at("brush-sweep"), velocity: 0.5, duration: 99 }).duration).toBe(8);
        // Strike rows never carry a stroke.
        expect("stroke" in hitConfig("t", m, { row: at("snare"), velocity: 0.5 })).toBe(false);
        // The brushes preset sets the snare up for them, and that is a rebuild.
        expect(applyPreset(m, "brushes")).toBe(true);
        expect(m.kit.brushes).toBe(true);
        expect(sameBuild(m.kit, { ...m.kit, brushes: false })).toBe(false);
        expect(repairMatter({ kit: { brushes: "yes" } }).kit.brushes).toBe(false);
    });

    it("maps General MIDI drum notes onto the kit", () => {
        expect(MATTER_ROWS[rowForNote(36)].piece).toBe("kick");
        expect(MATTER_ROWS[rowForNote(38)].piece).toBe("snare");
        expect(MATTER_ROWS[rowForNote(47)].piece).toBe("rack-tom");
        expect(MATTER_ROWS[rowForNote(57)].piece).toBe("crash");
        expect(rowForNote(42)).toBe(-1);
    });

    it("knows a rebuild from a change that needs none", () => {
        const a = defaultMatter().kit;
        expect(sameBuild(a, { ...a, sympathetic: false })).toBe(true);
        expect(sameBuild(a, { ...a, snare: 230 })).toBe(false);
    });

    it("lists what it offers", () => {
        expect(MATTER_WAVEFORM).toBe("matter");
        expect(MATTER_PIECES.map(p => p.id)).toEqual(["kick", "snare", "rack-tom", "floor-tom", "crash", "ride", "splash"]);
        expect(MATTER_PRESETS.map(p => p.id)).toEqual(["studio", "jazz", "rock", "funk", "brushes", "mallets"]);
        expect(MATTER_ROWS[0].piece).toBe("kick");
        expect(new Set(MATTER_ROWS.map(r => r.piece)).size).toBe(MATTER_PIECES.length);
        expect(Object.keys(describeSettings(defaultMatter()))).toContain("snareTension");
    });
});

// --- The addon, through its production callbacks ----------------------------------------------------

describe("The DAW's drum kit (production addon callbacks)", () => {
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
        // The lead becomes a kit, is selected, and the Kit window is open.
        tool("daw_set_track_params", { trackId: "trk-lead", waveform: "matter" });
        click(`select_track_${trackIndex("trk-lead")}`);
        click("toggle_matter");
        const view = () => {
            const v = w.matterViews.get("mt_trk-lead");
            if (!v) throw new Error(`no kit view; have ${[...w.matterViews.keys()].join(", ")}`);
            return v;
        };
        return { world, w, click, tool, view, state };
    }

    it("makes a track a kit, prepares it at once and shows it", async () => {
        const { w, view, state } = await openDaw();
        expect(Object.values(w.windowTitles)).toContain("Kit");
        expect(view().kit).toBe("trk-lead");
        expect(w.matterPrepared.some(p => p.id === "trk-lead" && p.cfg.kitId === "trk-lead")).toBe(true);
        const t = state().tracks.find((t: any) => t.id === "trk-lead");
        expect(t.rows).toBe(MATTER_ROWS.length);
        expect(t.rowNotes).toEqual(MATTER_ROWS.map(r => r.label));
        expect(t.matter.kick).toBe(55);
    });

    it("clicks on the heads and the pads strike the kit", async () => {
        const { w, view, world } = await openDaw();
        view().onStrike("floor-tom", 0.8, 1.2, 0.9);
        view().onPad("crash", 1);
        world.render();
        expect(w.matterHits.map(h => h.cfg.piece)).toEqual(["floor-tom", "crash"]);
        expect(w.matterHits[0].cfg).toMatchObject({ trackId: "trk-lead", kitId: "trk-lead", position: 0.8, angle: 1.2, striker: "stick" });
        expect(w.matterHits[1].cfg).toMatchObject({ position: 0.92, striker: "shoulder" });
        expect(w.matterHits[1].cfg.speed).toBeCloseTo(defaultMatter().dynamics);
    });

    it("a shift-drag in the view holds a brush on the head and lifts it", async () => {
        const { w, view, world } = await openDaw();
        view().onRub("snare", 0.1, -0.2, 1);
        view().onRub("snare", 0.15, -0.2, 1);
        view().onRub("snare", 0.15, -0.2, 0);
        world.render();
        expect(w.matterHolds.map(h => h.cfg.pressure)).toEqual([1, 1, 0]);
        expect(w.matterHolds[1]).toMatchObject({ id: "trk-lead", cfg: { piece: "snare", x: 0.15, y: -0.2 } });
        expect(w.matterHolds[0].cfg.kit.snare).toBe(220);
    });

    it("the AI tool hears a brush row", async () => {
        const { tool } = await openDaw();
        const h = tool("daw_matter", { trackId: "trk-lead", action: "hear", row: MATTER_ROWS.findIndex(r => r.id === "brush-sweep"), velocity: 0.5 });
        expect(h).toMatchObject({ success: true, name: "Brush sweep", piece: "snare", tool: "brush" });
        expect(h.stickFraction).toBeCloseTo(0.4);
        expect(tool("daw_matter", { trackId: "trk-lead", action: "params", params: { brushes: true } }).settings.brushes).toBe(true);
    });

    it("a hit while the kit is first being built is dropped, and the view says so", async () => {
        const { w, view, world } = await openDaw();
        w.matterStatus = "building";
        view().onPad("snare", 0.8);
        world.render();
        expect(w.matterHits.length).toBe(0);
        expect(view().status).toMatch(/building/);
        w.matterStatus = "ready";
        world.render();
        expect(view().status).toBeUndefined();
    });

    it("a tuning knob is committed once it has been still, not at every step of the drag", async () => {
        const { w, world } = await openDaw();
        const before = w.matterPrepared.length;
        const snare = w.knobs.find(k => k.label === "Snare")!;
        snare.onChange("240");
        snare.onChange("250");
        snare.onChange("260");
        world.render();
        // Nothing new asked of the engine with the new tuning yet...
        expect(w.matterPrepared.slice(before).some(p => p.cfg.kit.snare !== 220)).toBe(false);
        world.advance(600);
        world.render();
        // ...then the last value, once.
        const tuned = w.matterPrepared.slice(before).filter(p => p.cfg.kit.snare !== 220);
        expect(tuned.length).toBeGreaterThan(0);
        expect(tuned.every(p => p.cfg.kit.snare === 260)).toBe(true);
    });

    it("presets, snares and the air reach the kit at once", async () => {
        const { w, click } = await openDaw();
        click("mt_preset_rock");
        expect(w.matterPrepared.at(-1)!.cfg.kit.kick).toBe(48);
        click("mt_snares");
        expect(w.matterPrepared.at(-1)!.cfg.kit.snares).toBe(false);
        click("mt_sympathetic");
        expect(w.matterPrepared.at(-1)!.cfg.kit.sympathetic).toBe(false);
    });

    it("the AI tool sets presets and params, mixes, hears and strikes", async () => {
        const { tool, w } = await openDaw();
        expect(tool("daw_matter", { trackId: "trk-lead", action: "preset", preset: "funk" }).settings.preset).toBe("funk");
        const p = tool("daw_matter", { trackId: "trk-lead", action: "params", params: { snare: 999, snareTension: 0.5, hands: "mallets", dynamics: 3 } });
        expect(p.settings).toMatchObject({ snare: 360, snareTension: 0.5, hands: "mallets", dynamics: 3 });
        expect(tool("daw_matter", { trackId: "trk-lead", action: "mix", mix: { kick: 4, ride: -2 } }).settings.mix).toMatchObject({ kick: 4, ride: 0 });
        const h = tool("daw_matter", { trackId: "trk-lead", action: "hear", row: 1, velocity: 1 });
        expect(h).toMatchObject({ success: true, name: "Snare", piece: "snare", striker: "mallet", speed: 3 });
        expect(h.wireLandings).toBe(120);
        expect(tool("daw_matter", { trackId: "trk-lead", action: "strike", row: 0 }).success).toBe(true);
        expect(w.matterHits.at(-1)!.cfg.piece).toBe("kick");
        expect(tool("daw_matter", { trackId: "trk-lead", action: "preset", preset: "polka" }).success).toBe(false);
        expect(tool("daw_matter", { trackId: "trk-kick", action: "info" }).success).toBe(false);
    });

    it("saves the kit and describes it in the state", async () => {
        const { world, w, tool, state } = await openDaw();
        tool("daw_matter", { trackId: "trk-lead", action: "preset", preset: "jazz" });
        world.advance(400);
        const saved = w.saved.tracks.find((t: any) => t.id === "trk-lead");
        expect(saved.voice.waveform).toBe("matter");
        expect(saved.matter.preset).toBe("jazz");
        expect(state().tracks.find((t: any) => t.id === "trk-lead").matter.kick).toBe(68);
    });

    it("the sequencer plays the rows on the kit, and the export hands the hits over", async () => {
        const { world, w, tool } = await openDaw();
        const swirl = MATTER_ROWS.findIndex(r => r.id === "brush-swirl");
        tool("daw_set_notes", { trackId: "trk-lead", notes: [{ row: 0, step: 0, length: 1 }, { row: 1, step: 2, length: 1 }, { row: 6, step: 4, length: 1 }, { row: swirl, step: 6, length: 4 }] });
        tool("daw_set_transport", { mode: "pattern", playing: true });
        world.advance(3000);
        tool("daw_set_transport", { playing: false });
        const pieces = new Set(w.matterHits.map(h => h.cfg.piece));
        expect(pieces).toEqual(new Set(["kick", "snare", "ride"]));
        expect(w.matterHits.every(h => h.id === "trk-lead" && h.cfg.kitId === "trk-lead")).toBe(true);
        tool("daw_export_wav", {});
        const exported = w.matterExports.at(-1)!;
        expect(exported.length).toBeGreaterThan(0);
        expect(exported.every((e: any) => e.trackId === "trk-lead" && typeof e.startTime === "number" && e.speed > 0)).toBe(true);
        // The brush note is a stroke as long as the note, live and in the export.
        const live = w.matterHits.find(h => h.cfg.stroke === "swirl")!;
        const out = exported.find((e: any) => e.stroke === "swirl");
        expect(live.cfg.duration).toBeGreaterThan(0.3);
        expect(out.duration).toBeCloseTo(live.cfg.duration, 1);
        // The same notes are not also exported as plain oscillator notes.
        expect(w.exports.at(-1)!.every((e: any) => e.track !== "trk-lead")).toBe(true);
    });

    it("deleting the track stops its kit", async () => {
        const { w, tool } = await openDaw();
        tool("daw_delete_track", { trackId: "trk-lead" });
        expect(w.removedMatter).toContain("trk-lead");
        expect(w.removedMatterKits).toContain("trk-lead");
    });
});
