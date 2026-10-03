import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DawActionDef, PredictionContext, PredictionParamSpec } from "../src/addon";
import {
    ActionHistory,
    FAMILIES,
    VIEWS,
    choiceIndex,
    formatParam,
    noteName,
    paintSteps,
    paramDecimals,
    sanitizeParam,
    sanitizeParams,
    strokeAction,
} from "../src/apps/daw_predict";
import { BRASS_INSTRUMENTS, BRASS_MUTES, BRASS_STYLES } from "../src/apps/daw_brass";
import { MATTER_PRESETS } from "../src/apps/daw_matter";
import { GATE_PATTERNS, STUTTER_RATES } from "../src/apps/daw_moves";
import { PHYSMOD_INSTRUMENT_PRESETS } from "../src/apps/daw_physmod";
import { PIANO_PRESETS } from "../src/apps/daw_piano";
import { EQ_PRESETS, REVERB_PRESETS } from "../src/apps/daw_space";
import { WATER_PRESETS } from "../src/apps/daw_water";
import { WT_INSTRUMENT_PRESETS, WT_PRESETS } from "../src/apps/daw_wavetable";

const ctx = (over: Partial<PredictionContext> = {}): PredictionContext => ({
    family: 1, view: 1, playing: false, tracks: 2, patternFill: 0, songFill: 0, ...over,
});

const spec = (over: Partial<PredictionParamSpec>): PredictionParamSpec => ({
    name: "x", label: "X", kind: "knob", min: 0, max: 1, default: 0.5, unit: "", log: false, choices: null, ...over,
});

describe("Recording what the user does (ActionHistory)", () => {
    it("keeps actions oldest first, each with its params and the context after it", () => {
        const h = new ActionHistory();
        h.record("set_bpm", [124], ctx({ view: 0 }), { now: 0 });
        h.record("add_note", [0, 4, 1, 0.85], ctx({ patternFill: 0.06 }), { now: 10 });
        expect(h.toRequest()).toEqual([
            { action: "set_bpm", params: [124], context: ctx({ view: 0 }) },
            { action: "add_note", params: [0, 4, 1, 0.85], context: ctx({ patternFill: 0.06 }) },
        ]);
    });

    it("turns a knob drag into one entry holding the final value", () => {
        const h = new ActionHistory(64, 1500);
        for (let i = 0; i <= 10; i++) h.record("set_volume", [0, i / 10], ctx(), { key: "gain:t1", now: i * 16 });
        expect(h.length).toBe(1);
        expect(h.entries()[0].params).toEqual([0, 1]);
    });

    it("starts a new entry for another control, another track or after a pause", () => {
        const h = new ActionHistory(64, 1500);
        h.record("set_volume", [0, 0.5], ctx(), { key: "gain:t1", now: 0 });
        h.record("set_volume", [1, 0.5], ctx(), { key: "gain:t2", now: 10 });
        h.record("set_volume", [1, 0.6], ctx(), { key: "gain:t2", now: 5000 });
        h.record("add_note", [0, 0], ctx(), { now: 5001 });
        h.record("add_note", [0, 4], ctx(), { now: 5002 });
        expect(h.entries().map(e => e.action)).toEqual(["set_volume", "set_volume", "set_volume", "add_note", "add_note"]);
    });

    it("forgets the oldest actions past its limit and bumps its revision on every change", () => {
        const h = new ActionHistory(3);
        const before = h.revision;
        for (let i = 0; i < 5; i++) h.record("play", [], ctx(), { now: i });
        expect(h.length).toBe(3);
        expect(h.revision).toBe(before + 5);
        h.clear();
        expect(h.length).toBe(0);
    });
});

describe("Piano-roll strokes become single actions", () => {
    it("a click is add_note or remove_note at that cell", () => {
        expect(strokeAction("add", [{ row: 2, step: 6 }])).toEqual({ action: "add_note", params: [2, 6, 1, 0.85] });
        expect(strokeAction("erase", [{ row: 2, step: 6 }])).toEqual({ action: "remove_note", params: [2, 6] });
        expect(strokeAction("add", [])).toBeNull();
    });

    it("a drag is paint_notes over the run, on the row most cells were on", () => {
        const cells = [{ row: 2, step: 0 }, { row: 2, step: 1 }, { row: 3, step: 2 }, { row: 2, step: 3 }];
        expect(strokeAction("add", cells)).toEqual({ action: "paint_notes", params: [2, 0, 3, 4] });
        expect(strokeAction("erase", cells)?.action).toBe("erase_notes");
    });

    it("a suggested paint spreads its notes evenly over the span", () => {
        expect(paintSteps(0, 15, 16)).toEqual([...Array(16).keys()]);
        expect(paintSteps(0, 14, 8)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
        expect(paintSteps(12, 4, 1)).toEqual([4]);
        expect(paintSteps(0, 3, 99)).toEqual([0, 1, 2, 3]);
    });
});

describe("Parameters from the model are made valid for their controls", () => {
    it("knobs clamp, whole-number kinds round, toggles snap", () => {
        expect(sanitizeParam(spec({ kind: "knob" }), 1.7)).toBe(1);
        expect(sanitizeParam(spec({ kind: "int", min: 0, max: 63 }), 12.6)).toBe(13);
        expect(sanitizeParam(spec({ kind: "choice", min: 0, max: 6 }), -2)).toBe(0);
        expect(sanitizeParam(spec({ kind: "toggle" }), 0.7)).toBe(1);
        expect(sanitizeParam(spec({ kind: "note", min: 24, max: 84, default: 60 }), Number.NaN)).toBe(60);
    });

    it("a missing value falls back to the spec's default", () => {
        const def = { params: [spec({ name: "row", kind: "int", min: 0, max: 47, default: 4 }), spec({ name: "velocity", default: 0.85 })] } as DawActionDef;
        expect(sanitizeParams(def, [7])).toEqual([7, 0.85]);
        expect(sanitizeParams(def, undefined)).toEqual([4, 0.85]);
    });

    it("readouts name notes, choices and tracks", () => {
        const choices = { scales: [{ id: "major", label: "Major" }, { id: "dorian", label: "Dorian" }] };
        expect(noteName(60)).toBe("C4");
        expect(formatParam(spec({ kind: "note" }), 69, choices)).toBe("A4");
        expect(formatParam(spec({ kind: "choice", choices: "scales" }), 1, choices)).toBe("Dorian");
        expect(formatParam(spec({ kind: "track" }), 1, choices, ["Drums", "Bass"])).toBe("Bass");
        expect(formatParam(spec({ kind: "knob", min: 100, max: 20000, unit: "Hz" }), 1234.5, choices)).toBe("1235 Hz");
        expect(paramDecimals(spec({ kind: "knob" }))).toBe(2);
        expect(choiceIndex("scales", "dorian", choices)).toBe(1);
        expect(choiceIndex("scales", "lydian", choices)).toBe(-1);
    });
});

// The model's vocabulary lives in src/prediction/daw_actions.rs (Rust); the DAW maps its choice indices back to its own
// ids. These read the Rust source so a renamed preset on either side fails here, not in a session.
describe("The model's vocabulary matches the DAW", () => {
    const rust = readFileSync(fileURLToPath(new URL("../../../src/prediction/daw_actions.rs", import.meta.url)), "utf8");
    const list = (name: string): string[] => {
        const m = rust.match(new RegExp(`choice_list!\\(${name}, "[a-z_]+", \\[([\\s\\S]*?)\\]\\);`));
        if (!m) throw new Error(`no ${name} list in daw_actions.rs`);
        return [...m[1].matchAll(/\("([^"]+)", "[^"]*"\)/g)].map(x => x[1]);
    };

    it("families and views are in the order the model embeds them", () => {
        expect(list("FAMILIES")).toEqual([...FAMILIES]);
        expect(list("VIEWS")).toEqual([...VIEWS]);
    });

    it("every preset, instrument and option the model can suggest exists in the DAW", () => {
        const has = (rustList: string, ids: readonly string[]) => {
            for (const id of list(rustList)) expect(ids, `${rustList}: ${id}`).toContain(id);
        };
        has("WAVETABLE_PRESETS", [...WT_PRESETS.map(p => p.id), ...WT_INSTRUMENT_PRESETS.map(p => p.id)]);
        has("STRINGS_INSTRUMENTS", PHYSMOD_INSTRUMENT_PRESETS.map(p => p.id));
        has("BRASS_INSTRUMENTS", BRASS_INSTRUMENTS.map(p => p.id));
        has("BRASS_MUTES", BRASS_MUTES.map(p => p.id));
        has("BRASS_STYLES", BRASS_STYLES.map(p => p.id));
        has("PIANO_PRESETS", PIANO_PRESETS.map(p => p.id));
        has("MATTER_PRESETS", MATTER_PRESETS.map(p => p.id));
        has("WATER_PRESETS", WATER_PRESETS.map(p => p.id));
        has("REVERB_PRESETS", REVERB_PRESETS.map(p => p.id));
        has("EQ_PRESETS", EQ_PRESETS.map(p => p.id));
        has("GATE_PATTERNS", GATE_PATTERNS);
        has("STUTTER_RATES", STUTTER_RATES);
    });
});
