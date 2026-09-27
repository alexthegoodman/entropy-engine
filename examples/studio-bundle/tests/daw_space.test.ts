import { afterEach, describe, expect, it, vi } from "vitest";
import {
    EQ_LAYOUT,
    EQ_PRESETS,
    REVERB_PRESETS,
    applyEqPreset,
    bandActive,
    defaultEq,
    describeBand,
    eqEngineConfig,
    eqPresetIndex,
    formatHz,
    isEqFlat,
    repairEq,
    reverbPresetIndex,
    setBand,
} from "../src/apps/daw_space";
import { createWorld } from "./daw_test_world";

describe("The Reverb & EQ window's settings (daw_space.ts)", () => {
    it("starts flat, in the engine's band layout", () => {
        const eq = defaultEq();
        expect(eq.bands.map(b => b.kind)).toEqual([...EQ_LAYOUT]);
        expect(isEqFlat(eq)).toBe(true);
        expect(isEqFlat(undefined)).toBe(true);
        // The cuts start off; the shelves and bells start on at 0 dB, ready to drag.
        expect(eq.bands.map(b => b.enabled)).toEqual([false, true, true, true, true, false]);
    });

    it("counts a switched-on cut, a boosted band or an output trim as not flat", () => {
        expect(isEqFlat(setBand(defaultEq(), 0, { enabled: true }))).toBe(false);
        expect(isEqFlat(setBand(defaultEq(), 2, { gain: 3 }))).toBe(false);
        expect(isEqFlat({ ...defaultEq(), output: -2 })).toBe(false);
        // A boosted band that is switched off makes no sound.
        const off = setBand(setBand(defaultEq(), 2, { gain: 6 }), 2, { enabled: false });
        expect(bandActive(off.bands[2])).toBe(false);
        expect(isEqFlat(off)).toBe(true);
    });

    it("pulls every edit into range and keeps each band's kind", () => {
        const eq = setBand(defaultEq(), 3, { freq: 99999, gain: -40, q: 0, kind: "lowcut" } as any);
        expect(eq.bands[3]).toEqual({ kind: "peak", enabled: true, freq: 20000, gain: -18, q: 0.1 });
        // Out-of-range indexes change nothing.
        expect(setBand(defaultEq(), 9, { gain: 3 })).toEqual(defaultEq());
    });

    it("reads a saved EQ of any age or shape", () => {
        expect(repairEq(null)).toEqual(defaultEq());
        expect(repairEq("nonsense")).toEqual(defaultEq());
        const saved = repairEq({ bands: [{ enabled: true, freq: 80 }, null, { gain: "loud" }, { gain: 4.5, q: 2 }], output: 99 });
        expect(saved.bands[0]).toMatchObject({ kind: "lowcut", enabled: true, freq: 80 });
        expect(saved.bands[1]).toEqual(defaultEq().bands[1]);
        expect(saved.bands[2].gain).toBe(0);
        expect(saved.bands[3]).toMatchObject({ gain: 4.5, q: 2 });
        expect(saved.bands).toHaveLength(6);
        expect(saved.output).toBe(18);
    });

    it("hands the engine every band in order", () => {
        const eq = setBand(defaultEq(), 4, { gain: 3 });
        const c = eqEngineConfig(eq);
        expect(c.bands).toHaveLength(6);
        expect(c.bands[4]).toEqual({ kind: "highshelf", enabled: true, freq: 8000, gain: 3, q: 0.707 });
        expect(c.output).toBe(0);
    });

    it("recognises its presets, and an edit makes it custom", () => {
        for (const [i, p] of EQ_PRESETS.entries()) expect(eqPresetIndex(applyEqPreset(p.id))).toBe(i);
        expect(eqPresetIndex(defaultEq())).toBe(0);
        const warm = applyEqPreset("warm");
        expect(eqPresetIndex(setBand(warm, 1, { gain: 3.5 }))).toBe(-1);
        // Moving a band that makes no sound does not count as an edit.
        expect(eqPresetIndex(setBand(warm, 5, { freq: 12000 }))).toBe(EQ_PRESETS.findIndex(p => p.id === "warm"));
        expect(applyEqPreset("no such preset")).toEqual(defaultEq());
    });

    it("recognises the reverb presets, and any reverb at zero mix as off", () => {
        for (const [i, p] of REVERB_PRESETS.entries()) expect(reverbPresetIndex(p.settings)).toBe(i);
        expect(reverbPresetIndex({ reverbRoomSize: 27, reverbTime: 3, reverbDamping: 0.1, reverbMix: 0 })).toBe(0);
        expect(reverbPresetIndex({ reverbRoomSize: 27, reverbTime: 3, reverbDamping: 0.1, reverbMix: 0.3 })).toBe(-1);
    });

    it("describes a band in a line", () => {
        const eq = setBand(setBand(defaultEq(), 3, { freq: 3200, gain: 3.5, q: 0.9 }), 0, { enabled: true, freq: 90 });
        expect(describeBand(eq.bands[3], 3)).toBe("4 Bell: 3.20 kHz, +3.5 dB, Q 0.90");
        expect(describeBand(eq.bands[0], 0)).toBe("1 Low cut: 90 Hz, Q 0.71");
        expect(describeBand(eq.bands[5], 5)).toBe("6 High cut: off");
        expect(formatHz(12500)).toBe("12.5 kHz");
    });
});

// --- The addon, through its production callbacks ----------------------------------------------------

describe("The DAW's Reverb & EQ window and Instruments menu (production addon callbacks)", () => {
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); delete (globalThis as any).Entropy; });

    async function openDaw() {
        vi.resetModules();
        const world = createWorld();
        vi.spyOn(Date, "now").mockImplementation(() => world.w.clock);
        await world.open();
        const w = world.w;
        const click = (id: string) => {
            world.render();
            if (!w.buttons.has(id)) throw new Error(`no button ${id}; have ${[...w.buttons.keys()].join(", ")}`);
            w.buttons.get(id)!();
            world.render();
        };
        const windowId = (title: string) => Object.entries(w.windowTitles).find(([, t]) => t === title)![0];
        const active = () => w.tools.get("daw_get_state")!({}).tracks.find((t: any) => t.id === w.reverbEqViews.get("space_view")?.source);
        const eqInChain = (trackId: string) => (w.buses.get(trackId)?.effectIds ?? []).map((id: string) => w.effects.get(id)).find((e: any) => e?.kind === "eq");
        return { world, w, click, windowId, active, eqInChain };
    }

    it("opens from the transport bar with the active track's reverb and a flat EQ", async () => {
        const { w, click, windowId } = await openDaw();
        const win = windowId("Reverb & EQ");
        expect(w.windowVisible[win]).toBe(false);
        click("toggle_space");
        expect(w.windowVisible[win]).toBe(true);
        const view = w.reverbEqViews.get("space_view");
        expect(view.eq.bands).toHaveLength(6);
        expect(isEqFlat(view.eq as any)).toBe(true);
        expect(Object.keys(view.reverb).sort()).toEqual(["damping", "mix", "roomSize", "time"]);
        expect(view.view).toBe("decay");
    });

    it("puts a dragged band on the track's bus after the reverb, saves it, and exports it", async () => {
        const { w, world, click, eqInChain } = await openDaw();
        click("toggle_space");
        const view = w.reverbEqViews.get("space_view");
        const trackId = view.source;
        // An untouched EQ costs nothing: it is not in the chain.
        expect(eqInChain(trackId)).toBeUndefined();

        view.onSelect(2);
        view.onBand(2, { kind: "peak", enabled: true, freq: 900, gain: 5, q: 1.4 });
        view.onEditEnd();
        world.render();

        const chain = w.buses.get(trackId).effectIds as string[];
        expect(chain[0]).toMatch(/^delay-/);
        expect(chain[1]).toMatch(/^reverb-/);
        expect(w.effects.get(chain[2])).toMatchObject({ kind: "eq" });
        expect(eqInChain(trackId).bands[2]).toEqual({ kind: "peak", enabled: true, freq: 900, gain: 5, q: 1.4 });
        // The view shows the edit, and the knobs follow the selected band.
        expect(w.reverbEqViews.get("space_view").eq.bands[2].gain).toBe(5);
        expect(w.reverbEqViews.get("space_view").selectedBand).toBe(2);
        expect(w.knobs.find(k => k.id === "space_band_gain").value).toBe(5);

        world.advance(3000);
        const saved = w.saved.tracks.find((t: any) => t.id === trackId);
        expect(saved.eq.bands[2]).toMatchObject({ freq: 900, gain: 5, q: 1.4 });

        click("export_wav");
        const bus = w.busExports.at(-1)!.find((b: any) => b.track === trackId);
        expect(bus.eq.bands[2]).toMatchObject({ kind: "peak", freq: 900, gain: 5 });
        // Flat tracks export without an EQ.
        expect(w.busExports.at(-1)!.filter((b: any) => b.track !== trackId).every((b: any) => b.eq === undefined)).toBe(true);
    });

    it("drops the EQ from the chain when it is set flat again", async () => {
        const { w, world, click, eqInChain } = await openDaw();
        click("toggle_space");
        const trackId = w.reverbEqViews.get("space_view").source;
        w.dropdowns.get("space_eq_preset").onChange(String(EQ_PRESETS.findIndex(p => p.id === "telephone") + 1));
        world.render();
        expect(eqInChain(trackId).bands[0]).toMatchObject({ enabled: true, freq: 400 });
        expect(w.dropdowns.get("space_eq_preset").selectedIndex).toBe(EQ_PRESETS.findIndex(p => p.id === "telephone") + 1);
        click("space_eq_flat");
        expect(eqInChain(trackId)).toBeUndefined();
        expect(w.dropdowns.get("space_eq_preset").selectedIndex).toBe(1);
    });

    it("sets the reverb from a preset and the knobs, clamped to what the reverb can do", async () => {
        const { w, world, click } = await openDaw();
        click("toggle_space");
        const hall = REVERB_PRESETS.findIndex(p => p.id === "hall");
        w.dropdowns.get("space_reverb_preset").onChange(String(hall + 1));
        world.render();
        expect(w.reverbEqViews.get("space_view").reverb).toEqual({ roomSize: 24, time: 2.6, damping: 0.45, mix: 0.3 });
        expect(w.dropdowns.get("space_reverb_preset").selectedIndex).toBe(hall + 1);
        w.knobs.find(k => k.id === "space_room").onChange("45");
        w.knobs.find(k => k.id === "space_mix").onChange("0.5");
        world.render();
        expect(w.reverbEqViews.get("space_view").reverb).toMatchObject({ roomSize: 30, mix: 0.5 });
        expect(w.dropdowns.get("space_reverb_preset").selectedIndex).toBe(0);
    });

    it("switches between the decay and live views", async () => {
        const { w, world, click } = await openDaw();
        click("toggle_space");
        w.reverbEqViews.get("space_view").onView("live");
        world.render();
        expect(w.reverbEqViews.get("space_view").view).toBe("live");
    });

    it("lets an AI tool set the reverb and the EQ", async () => {
        const { w, world } = await openDaw();
        const trackId = w.tools.get("daw_get_state")!({}).tracks[0].id;
        const r = w.tools.get("daw_reverb_eq")!({ trackId, reverbPreset: "plate", mix: 0.4, eqPreset: "air", bands: [{ band: 3, freq: 250, gain: -3 }] });
        world.render();
        expect(r.success).toBe(true);
        expect(r.reverb).toEqual({ roomSize: 12, decay: 1.8, damping: 0.15, mix: 0.4 });
        expect(r.eq[2]).toBe("3 Bell: 250 Hz, -3.0 dB, Q 1.00");
        expect(r.eq[4]).toBe("5 High shelf: 10.0 kHz, +4.0 dB, Q 0.60");
        expect(w.tools.get("daw_reverb_eq")!({ trackId: "nope" }).success).toBe(false);
    });

    it("keeps the instrument windows in one Instruments menu that ticks the open ones", async () => {
        const { w, world, windowId } = await openDaw();
        world.render();
        for (const gone of ["toggle_rack", "toggle_wavetable", "toggle_physmod", "toggle_brass", "toggle_matter", "toggle_water", "toggle_guitar"]) {
            expect(w.buttons.has(gone), gone).toBe(false);
        }
        const menu = () => w.dropdowns.get("instrument_windows");
        expect(menu().selectedIndex).toBe(0);
        expect(menu().options.slice(1).map((o: string) => o.replace(/^\[[\w-]+\] /, ""))).toEqual(["Drum Rack", "Wavetable", "Bowed String", "Brass", "Kit", "Water", "Guitar Input"]);

        world.openInstrument("Wavetable");
        expect(w.windowVisible[windowId("Wavetable")]).toBe(true);
        expect(menu().options[0]).toContain("Instruments (1 open)");
        // The menu always shows its title; the open window is ticked.
        expect(menu().selectedIndex).toBe(0);
        expect(menu().options[2]).toBe("[check-square] Wavetable");
        expect(menu().options[3]).toBe("[square] Bowed String");

        world.openInstrument("Wavetable");
        expect(w.windowVisible[windowId("Wavetable")]).toBe(false);
        expect(menu().options[0]).not.toContain("open");
    });
});
