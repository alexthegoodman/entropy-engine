import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld } from "./daw_test_world";

// The DAW's icons come from Entropy.Icons (Phosphor). The test world's stand-in returns a readable
// marker for each icon, "[play]" for regular and "[fill:play]" for a filled one, so these tests can
// say which icon a control shows. The engine draws the real glyphs (tests/icons_bdd.rs).

const ICON_NAMES = new Set(
    [...readFileSync(new URL("../src/icon_names.d.ts", import.meta.url), "utf8").matchAll(/\| "([a-z0-9-]+)"/g)].map(m => m[1]),
);
const SOURCE = readFileSync(new URL("../src/apps/daw_synth_addon.ts", import.meta.url), "utf8");

describe("The DAW's icons", () => {
    beforeEach(() => { vi.resetModules(); });

    it("names only icons that exist, because a typo draws nothing in the engine", () => {
        const asked = [...SOURCE.matchAll(/\b(?:icon|withIcon)\("([^"]+)"/g)].map(m => m[1]);
        expect(asked.length).toBeGreaterThan(15);
        expect(asked.filter(n => !ICON_NAMES.has(n))).toEqual([]);
        expect(ICON_NAMES.size).toBe(1530);
    });

    it("uses only the regular weight, because Fill and Bold do not draw in the real window", async () => {
        const world = createWorld();
        await world.open();
        const shown = [...world.w.buttonTexts.values(), ...world.w.headers];
        expect(shown.filter(t => /\[(fill|bold):/.test(t))).toEqual([]);
        expect(SOURCE).not.toMatch(/(?:icon|withIcon)\([^)]*"(?:fill|bold)"/);
    });

    it("draws no emoji or symbol glyph in any button, header or label", async () => {
        const world = createWorld();
        await world.open();
        const legacy = /[←-⯿\u{1F300}-\u{1FAFF}]/u;
        const shown = [...world.w.buttonTexts.values(), ...world.w.headers, ...world.w.labels];
        expect(shown.length).toBeGreaterThan(20);
        expect(shown.filter(t => legacy.test(t))).toEqual([]);
    });

    it("gives the transport a play icon that becomes a stop icon while playing", async () => {
        const world = createWorld();
        await world.open();
        expect(world.w.buttonTexts.get("transport_toggle")).toBe("[play] Play");
        world.w.buttons.get("transport_toggle")!();
        world.render();
        expect(world.w.buttonTexts.get("transport_toggle")).toBe("[stop] Stop");
        expect(world.w.buttonTexts.get("transport_rewind")).toBe("[skip-back] Rewind");
    });

    it("puts icons on the section headers", async () => {
        const world = createWorld();
        await world.open();
        const headers = world.w.headers;
        expect(headers).toContain("[rows] Arrangement");
        expect(headers).toContain("[sliders-horizontal] Mixer");
        expect(headers).toContain("[sparkle] Effects");
        expect(headers).toContain("[speaker-high] Preview");
    });

    it("marks the selected track in the mixer with a play icon and no other", async () => {
        const world = createWorld();
        await world.open();
        const marker = "[play] ";
        const strips = [...world.w.buttonTexts.entries()].filter(([id]) => id.startsWith("select_track_"));
        expect(strips.length).toBeGreaterThan(2);
        world.w.buttons.get("select_track_2")!();
        world.render();
        const after = [...world.w.buttonTexts.entries()].filter(([id]) => id.startsWith("select_track_"));
        expect(after.filter(([, t]) => t.startsWith(marker)).map(([id]) => id)).toEqual(["select_track_2"]);
    });
});
