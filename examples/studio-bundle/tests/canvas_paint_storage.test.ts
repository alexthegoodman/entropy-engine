import { describe, expect, it } from "vitest";
import { DEFAULT_PAINT_SETTINGS, blendPixel, compositeLayers, pressureResponse, stabilizePoint } from "../src/apps/canvas_paint";
import type { PaintLayer } from "../src/apps/canvas_paint";
import { SceneLibrary } from "../src/apps/canvas_scene_library";
import { base64ToBytes, bytesToBase64, validateScene } from "../src/apps/canvas_scene_format";

describe("brush response and compositing", () => {
    it("calibrates and clamps pressure with independent size and opacity curves", () => {
        const settings = { ...DEFAULT_PAINT_SETTINGS, pressureMin: 0.1, pressureMax: 0.9, sizeCurve: 2, opacityCurve: 0.5 };
        expect(pressureResponse(0, settings, "size")).toBe(0);
        expect(pressureResponse(1, settings, "size")).toBe(1);
        expect(pressureResponse(0.5, settings, "size")).toBeCloseTo(0.25);
        expect(pressureResponse(0.5, settings, "opacity")).toBeCloseTo(Math.sqrt(0.5));
        expect(pressureResponse(0, { ...settings, pressureSize: false }, "size")).toBe(1);
    });
    it("preserves transparent paint RGB and reveals lower paint when erasing", () => {
        const lower: PaintLayer = { id: "a", name: "red", visible: true, locked: false, opacity: 1, pixels: new Uint8Array([255, 0, 0, 255]) };
        const upper: PaintLayer = { ...lower, id: "b", pixels: new Uint8Array(4) };
        blendPixel(upper.pixels, 0, [0, 0, 255], 0.5, false);
        expect([...upper.pixels]).toEqual([0, 0, 255, 128]);
        const result = new Uint8Array(4);
        compositeLayers(result, [lower, upper], new Uint8Array([255]), [250, 248, 244]);
        expect([...result]).toEqual([127, 0, 128, 255]);
        blendPixel(upper.pixels, 0, [0, 0, 0], 1, true);
        compositeLayers(result, [lower, upper], new Uint8Array([255]), [250, 248, 244]);
        expect([...result]).toEqual([255, 0, 0, 255]);
        compositeLayers(result, [lower, upper], new Uint8Array([0]), [250, 248, 244]);
        expect(result[3]).toBe(0); // cutting is independent of paint visibility
    });
    it("passes points through when disabled and suppresses jitter within the trailing distance", () => {
        expect(stabilizePoint({ px: 0, py: 0 }, { px: 2, py: 1 }, 0)).toEqual({ px: 2, py: 1 });
        expect(stabilizePoint({ px: 0, py: 0 }, { px: 2, py: 1 }, 8)).toEqual({ px: 0, py: 0 });
        expect(stabilizePoint({ px: 0, py: 0 }, { px: 20, py: 0 }, 8)).toEqual({ px: 12, py: 0 });
    });
});

describe("scene payloads", () => {
    it("round-trips base64 including chunk boundaries and padding", () => {
        for (const size of [0, 1, 2, 3, 12287, 12288, 12289]) {
            const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
            expect(Buffer.from(base64ToBytes(bytesToBase64(bytes))).equals(Buffer.from(bytes))).toBe(true);
            expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
        }
    });
    it("accepts legacy artwork and rejects corrupt pixels before replacing a scene", () => {
        const saved = {
            name: "Legacy", kind: "plane", position: [0, 1.5, 0], yaw: 0, pitch: 0, roll: 0,
            halfW: 1.5, halfH: 1.5, halfD: 0.75, radius: 1, bend: 0, bendAxis: "y", visible: false,
            canvasBase64: bytesToBase64(new Uint8Array(768 * 768 * 4)),
        };
        expect(validateScene({ version: 1, surfaces: [saved] }).surfaces[0].visible).toBe(false);
        expect(() => validateScene({ version: 1, surfaces: [{ ...saved, canvasBase64: "broken" }] })).toThrow();
        expect(() => validateScene({ version: 1, surfaces: [{ ...saved, position: [NaN, 0, 0] }] })).toThrow();
        expect(() => validateScene({ version: 3, surfaces: [] })).toThrow();
    });
});

describe("named scene library", () => {
    function storage(initial: unknown = null) {
        let index = initial, serial = 0;
        const files = new Map<string, unknown>();
        const api = {
            loadIndex: () => structuredClone(index), saveIndex: (value: unknown) => { index = structuredClone(value); },
            load: (key: string) => structuredClone(files.get(key)), save: (key: string, value: unknown) => { files.set(key, structuredClone(value)); },
            uuid: () => `id-${++serial}`,
        };
        const validate = (value: unknown): { value: number } => {
            if (!value || typeof (value as any).value !== "number") throw new Error("Invalid data");
            return value as { value: number };
        };
        return { api, files, validate };
    }
    it("migrates the old single scene and loads independent scenes after restart", () => {
        const { api, validate } = storage({ value: 10 });
        const library = new SceneLibrary(api, validate); library.read();
        expect(library.load("legacy")).toEqual({ value: 10 });
        const next = library.save(null, "New painting", { value: 20 });
        const restarted = new SceneLibrary(api, validate); restarted.read();
        expect(restarted.load("legacy")).toEqual({ value: 10 });
        expect(restarted.load(next.id)).toEqual({ value: 20 });
        restarted.save(next.id, "Renamed painting", { value: 30 });
        expect(restarted.load("legacy")).toEqual({ value: 10 });
        expect(restarted.load(next.id)).toEqual({ value: 30 });
        expect(restarted.entries).toHaveLength(2);
    });
    it("keeps the previous scene accessible when an index write fails", () => {
        const { api, validate } = storage();
        const library = new SceneLibrary(api, validate); library.read();
        const entry = library.save(null, "Painting", { value: 1 });
        api.saveIndex = () => { throw new Error("Disk full"); };
        expect(() => library.save(entry.id, "Painting", { value: 2 })).toThrow("Disk full");
        expect(library.load(entry.id)).toEqual({ value: 1 });
        const restarted = new SceneLibrary(api, validate); restarted.read();
        expect(restarted.load(entry.id)).toEqual({ value: 1 });
    });
    it("detects no-op writes and name collisions without overwriting an existing scene", () => {
        const { api, validate } = storage();
        const library = new SceneLibrary(api, validate); library.read();
        library.save(null, "Painting", { value: 1 });
        expect(() => library.save(null, " painting ", { value: 2 })).toThrow("already used");
        expect(() => library.save(null, "  ", { value: 2 })).toThrow("Enter a scene name");
        api.save = () => {};
        expect(() => library.save(null, "Another", { value: 2 })).toThrow();
        expect(library.entries).toHaveLength(1);
    });
});
