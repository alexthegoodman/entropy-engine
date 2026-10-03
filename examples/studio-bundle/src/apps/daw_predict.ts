// The DAW side of the next-action prediction model (src/prediction/daw_actions.rs and
// model.rs, through Entropy.Prediction): the recorded action history, the context each
// action carries, how piano-roll strokes and knob drags become single actions, and the parameter
// helpers the Suggested Next Steps panel builds its controls with. No engine calls here, so it
// can be tested without a window; daw_synth_addon.ts wires it to the DAW.

import type { DawActionDef, PredictionContext, PredictionHistoryEntry, PredictionParamSpec } from "../addon";

/** Instrument families, in the order of src/prediction's FAMILIES list (the model embeds the index). */
export const FAMILIES = ["none", "drum_rack", "synth", "wavetable", "strings", "brass", "piano", "matter", "water", "vst3"] as const;
export type Family = typeof FAMILIES[number];
export const familyIndex = (f: Family): number => FAMILIES.indexOf(f);

/** DAW views, in the order of src/prediction's VIEWS list. */
export const VIEWS = ["arrange", "roll", "mixer"] as const;
export const viewIndex = (v: string): number => Math.max(0, VIEWS.indexOf(v as typeof VIEWS[number]));

export interface RecordedAction {
    /** Unique per entry, for widget ids. */
    id: number;
    action: string;
    params: number[];
    context: PredictionContext;
    /** What happened, for the history list ("Added C4 at 1.3"). */
    detail?: string;
    /** "user" for the DAW's own controls, "suggestion" for a step applied from the panel. */
    source: "user" | "suggestion";
    at: number;
    /** Entries with the same action and key within the coalescing window merge into one. */
    key?: string;
}

export interface RecordOptions {
    detail?: string;
    /** Set for continuous controls (a knob drag reports every step): the same action and key
     *  within `coalesceMs` of the last entry update it instead of adding one. */
    key?: string;
    source?: "user" | "suggestion";
    now?: number;
}

/** The actions the model has seen, newest last, bounded. */
export class ActionHistory {
    private items: RecordedAction[] = [];
    private serial = 0;
    /** Bumped on every change, so the panel knows when to ask for a new plan. */
    revision = 0;

    constructor(readonly limit = 64, readonly coalesceMs = 1500) {}

    record(action: string, params: number[], context: PredictionContext, opts: RecordOptions = {}): RecordedAction {
        const now = opts.now ?? Date.now();
        const last = this.items[this.items.length - 1];
        this.revision++;
        if (opts.key !== undefined && last && last.action === action && last.key === opts.key && now - last.at <= this.coalesceMs) {
            last.params = params.slice();
            last.context = { ...context };
            last.at = now;
            if (opts.detail !== undefined) last.detail = opts.detail;
            return last;
        }
        const entry: RecordedAction = {
            id: ++this.serial, action, params: params.slice(), context: { ...context },
            detail: opts.detail, source: opts.source ?? "user", at: now, key: opts.key,
        };
        this.items.push(entry);
        if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
        return entry;
    }

    entries(): readonly RecordedAction[] { return this.items; }
    get length(): number { return this.items.length; }

    clear() {
        this.items = [];
        this.revision++;
    }

    /** The history in the shape `Prediction.predictPlan` takes. */
    toRequest(): PredictionHistoryEntry[] {
        return this.items.map(e => ({ action: e.action, params: e.params, context: e.context }));
    }
}

/** One piano-roll stroke (press, drag, release) as the action it amounts to: a single cell is
 *  add_note / remove_note, more is paint_notes / erase_notes over the run, on the row most of the
 *  cells were on. */
export function strokeAction(mode: "add" | "erase", cells: { row: number; step: number }[]): { action: string; params: number[] } | null {
    if (cells.length === 0) return null;
    if (cells.length === 1) {
        const { row, step } = cells[0];
        return mode === "add" ? { action: "add_note", params: [row, step, 1, 0.85] } : { action: "remove_note", params: [row, step] };
    }
    const counts = new Map<number, number>();
    for (const c of cells) counts.set(c.row, (counts.get(c.row) ?? 0) + 1);
    let row = cells[0].row;
    for (const [r, n] of counts) if (n > (counts.get(row) ?? 0)) row = r;
    const steps = cells.map(c => c.step);
    return {
        action: mode === "add" ? "paint_notes" : "erase_notes",
        params: [row, Math.min(...steps), Math.max(...steps), cells.length],
    };
}

/** The steps a suggested paint_notes(start, end, count) writes: `count` cells spread evenly from
 *  start to end (every step when count fills the span). */
export function paintSteps(start: number, end: number, count: number): number[] {
    const a = Math.round(Math.min(start, end));
    const b = Math.round(Math.max(start, end));
    const span = b - a + 1;
    const n = Math.max(1, Math.min(span, Math.round(count)));
    if (n === 1) return [a];
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        const s = a + Math.round((i * (span - 1)) / (n - 1));
        if (out[out.length - 1] !== s) out.push(s);
    }
    return out;
}

/** A value made valid for its spec: clamped, whole for everything but knobs, 0/1 for toggles. */
export function sanitizeParam(spec: PredictionParamSpec, value: number): number {
    const v = Number.isFinite(value) ? value : spec.default;
    const clamped = Math.max(spec.min, Math.min(spec.max, v));
    if (spec.kind === "knob") return clamped;
    if (spec.kind === "toggle") return clamped >= (spec.min + spec.max) / 2 ? spec.max : spec.min;
    return Math.round(clamped);
}

/** A full parameter list for `def`: `params` where given and valid, the spec default otherwise. */
export function sanitizeParams(def: DawActionDef, params: readonly number[] | undefined): number[] {
    return def.params.map((spec, i) => sanitizeParam(spec, params?.[i] ?? spec.default));
}

/** Decimals a knob readout needs for a spec: none for whole numbers, more for small ranges. */
export function paramDecimals(spec: PredictionParamSpec): number {
    if (spec.kind !== "knob") return 0;
    const range = spec.max - spec.min;
    return range >= 100 ? 0 : range >= 5 ? 1 : 2;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (midi: number): string => `${NOTE_NAMES[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`;

/** A short readout of a parameter's value for history lines and tooltips. */
export function formatParam(spec: PredictionParamSpec, value: number, choices: Record<string, { id: string; label: string }[]>, trackNames: string[] = []): string {
    switch (spec.kind) {
        case "choice": return (spec.choices && choices[spec.choices]?.[Math.round(value)]?.label) ?? String(Math.round(value));
        case "toggle": return value >= 0.5 ? "on" : "off";
        case "note": return noteName(value);
        case "track": return trackNames[Math.round(value)] ?? `Track ${Math.round(value) + 1}`;
        case "int": return `${Math.round(value)}${spec.unit ? " " + spec.unit : ""}`;
        default: return `${value.toFixed(paramDecimals(spec))}${spec.unit ? " " + spec.unit : ""}`;
    }
}

/** The id a choice parameter's value names ("hall" for a reverb preset index), or undefined. */
export function choiceId(spec: PredictionParamSpec | undefined, value: number, choices: Record<string, { id: string; label: string }[]>): string | undefined {
    if (!spec?.choices) return undefined;
    return choices[spec.choices]?.[Math.round(value)]?.id;
}

/** A choice parameter's index for an id ("hall" to its reverb preset index), or -1. */
export function choiceIndex(list: string, id: string, choices: Record<string, { id: string; label: string }[]>): number {
    return choices[list]?.findIndex(o => o.id === id) ?? -1;
}
