// The DAW's quick moves: the character knobs (Pump, Bounce, Gate, Acid, Grit, Space, Humanize)
// and the one-click buttons (Pattern Variation, Build, Drop Gap, Echo Out, Stutter, Octave Spark,
// Answer, Thin Out, Kick Lock). Kept free of `Entropy.*` so a plain vitest run can drive every
// rule here (tests/daw_moves.test.ts); daw_synth_addon.ts wires them to the engine and the UI.
//
// Two kinds of thing live here:
//   - Knobs are non-destructive track settings (`Character`). Pump, Gate, Grit and Space are audio
//     effects on the track's bus (src/audio/character.rs). Bounce and Humanize move and shape notes
//     as they play (`grooveAt`), identically live and in an export. Acid moves the track's own
//     filter and drive (`applyAcid`), so its sliders follow the knob.
//   - Buttons rewrite a pattern or the arrangement. They are pure functions returning new notes (or
//     editing the clip list they are handed); the addon keeps an undo snapshot before each one.
//
// Time is in steps (16ths at the default four steps per beat), as everywhere in the DAW.

import { BEATS_PER_BAR, clipEnd, type ArrClip, type IdGen, type NoteCell } from "./daw_arrangement";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

// --- Character knobs --------------------------------------------------------------------------

export const GATE_PATTERNS = ["eighths", "sixteenths", "syncopated"] as const;
export type GatePattern = typeof GATE_PATTERNS[number];
export const GATE_PATTERN_LABELS = ["1/8", "1/16", "Synco"];

export interface Character {
    /** Beat-synced ducking, 0..1. */
    pump: number;
    /** Deliberate groove: late, softer offbeat sixteenths and accented, laid-back offbeat eighths. */
    bounce: number;
    /** Depth of the rhythmic gate, 0..1, with the figure it chops to. */
    gate: number;
    gatePattern: GatePattern;
    /** Coordinated filter cutoff, resonance, filter envelope and drive (built-in synth voices). */
    acid: number;
    /** Saturation turning into digital roughness, loudness-compensated. */
    grit: number;
    /** Close and dry (0) to distant and washed out (1). */
    space: number;
    /** Small, repeatable variations in timing and velocity. */
    humanize: number;
    /** The cutoff and resonance the track had before Acid was turned up, put back at zero. */
    acidBase?: { cutoff: number; resonance: number } | null;
}

export function defaultCharacter(): Character {
    return { pump: 0, bounce: 0, gate: 0, gatePattern: "sixteenths", acid: 0, grit: 0, space: 0, humanize: 0, acidBase: null };
}

/** A saved character, clamped and completed; anything unreadable is the default. */
export function repairCharacter(c: any): Character {
    const d = defaultCharacter();
    if (!c || typeof c !== "object") return d;
    const knob = (v: unknown) => clamp(num(v, 0), 0, 1);
    const base = c.acidBase && Number.isFinite(c.acidBase.cutoff) && Number.isFinite(c.acidBase.resonance)
        ? { cutoff: c.acidBase.cutoff, resonance: c.acidBase.resonance } : null;
    return {
        pump: knob(c.pump), bounce: knob(c.bounce), gate: knob(c.gate),
        gatePattern: GATE_PATTERNS.includes(c.gatePattern) ? c.gatePattern : d.gatePattern,
        acid: knob(c.acid), grit: knob(c.grit), space: knob(c.space), humanize: knob(c.humanize),
        acidBase: base,
    };
}

export interface AcidVoice {
    cutoff: number;
    resonance: number;
    /** Octaves the filter opens above the cutoff when a note starts. */
    filterEnv: number;
    /** Time constant (seconds) of the filter's fall back. */
    filterDecay: number;
    drive: number;
}

/**
 * The Acid knob's coordinated voice settings. The ranges are chosen so the whole travel is usable:
 * a quarter of the way is a round, lightly squelchy bass; halfway is the classic acid line; the top
 * is a screaming, driven resonance. The cutoff starts low and climbs, because the envelope does
 * the opening; resonance and drive climb faster near the top.
 */
export function acidVoice(amount: number): AcidVoice {
    const a = clamp(amount, 0, 1);
    return {
        cutoff: Math.round(160 * Math.pow(2, 3.3 * a)),
        resonance: +(0.8 + 6.2 * Math.pow(a, 1.3)).toFixed(3),
        filterEnv: a > 0 ? +(1.2 + 3.3 * a).toFixed(3) : 0,
        filterDecay: +(0.26 - 0.12 * a).toFixed(3),
        drive: +(1 + 5 * Math.pow(a, 1.5)).toFixed(3),
    };
}

export interface AcidTarget {
    cutoff: number;
    resonance: number;
    filterEnv?: number;
    filterDecay?: number;
    drive?: number;
}

/**
 * Turns the Acid knob on a voice: the knob writes the voice's cutoff, resonance, filter envelope and
 * drive, so the Cutoff and Resonance sliders visibly follow it. The voice's own settings from before
 * Acid was touched are kept in `character.acidBase` and put back when the knob returns to zero.
 */
export function applyAcid(voice: AcidTarget, character: Character, amount: number): void {
    const a = clamp(amount, 0, 1);
    if (a > 0 && character.acid <= 0 && !character.acidBase) {
        character.acidBase = { cutoff: voice.cutoff, resonance: voice.resonance };
    }
    character.acid = a;
    if (a <= 0) {
        if (character.acidBase) {
            voice.cutoff = character.acidBase.cutoff;
            voice.resonance = character.acidBase.resonance;
        }
        character.acidBase = null;
        voice.filterEnv = 0;
        voice.drive = 1;
        return;
    }
    const v = acidVoice(a);
    voice.cutoff = v.cutoff;
    voice.resonance = v.resonance;
    voice.filterEnv = v.filterEnv;
    voice.filterDecay = v.filterDecay;
    voice.drive = v.drive;
}

/** The character effects a track's bus needs, in chain order, leaving out any at zero. */
export function busEffects(c: Character, bpm: number): { kind: "grit" | "gate" | "space" | "pump"; amount: number; pattern: number; bpm: number }[] {
    const out: { kind: "grit" | "gate" | "space" | "pump"; amount: number; pattern: number; bpm: number }[] = [];
    const pattern = Math.max(0, GATE_PATTERNS.indexOf(c.gatePattern));
    if (c.grit > 0) out.push({ kind: "grit", amount: c.grit, pattern, bpm });
    if (c.gate > 0) out.push({ kind: "gate", amount: c.gate, pattern, bpm });
    if (c.space > 0) out.push({ kind: "space", amount: c.space, pattern, bpm });
    if (c.pump > 0) out.push({ kind: "pump", amount: c.pump, pattern, bpm });
    return out;
}

// --- Groove: Bounce and Humanize ---------------------------------------------------------------

/** A hash of the parts to a number in [0, 1): the same inputs always give the same number. */
export function hash01(...parts: (string | number)[]): number {
    let h = 2166136261;
    for (const part of parts) {
        const s = String(part);
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        h ^= 0x7c;
        h = Math.imul(h, 16777619);
    }
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return (h >>> 0) / 4294967296;
}

export interface Groove {
    /** Steps to move the note by (negative is early). */
    offset: number;
    velocityScale: number;
    velocityAdd: number;
}

/** Bounce's largest push of an offbeat sixteenth: a third of a step, a 66% swing. */
export const BOUNCE_MAX_SWING = 1 / 3;
/** Humanize's largest timing nudge, in steps (about 15 ms at 120 bpm). */
export const HUMANIZE_MAX_TIMING = 0.12;

/**
 * How Bounce and Humanize move one note as it plays. `step` is its grid step within the bar (any
 * multiple of a bar away gives the same answer); `key` names this play of the note - the song step
 * it lands on - so a loop's repeats vary but every playthrough, and the export, is identical.
 *
 * Bounce is a deliberate groove, the same every bar: offbeat sixteenths are pushed late (up to a 66%
 * swing) and softened, offbeat eighths are accented and laid back a little - house hats, garage
 * shuffle, a bouncing bassline. Humanize is the opposite: small, irregular differences.
 */
export function grooveAt(c: Pick<Character, "bounce" | "humanize">, step: number, stepsPerBeat: number, row: number, key: string | number): Groove {
    const g: Groove = { offset: 0, velocityScale: 1, velocityAdd: 0 };
    const spb = Math.max(1, Math.round(stepsPerBeat));
    const pos = ((Math.round(step) % spb) + spb) % spb;
    const b = clamp(c.bounce, 0, 1);
    if (b > 0 && spb >= 2) {
        if (spb % 2 === 0 && pos === spb / 2) {
            g.offset += 0.08 * b;
            g.velocityScale *= 1 + 0.15 * b;
        } else if (pos % 2 === 1) {
            g.offset += BOUNCE_MAX_SWING * b;
            g.velocityScale *= 1 - 0.3 * b;
        }
    }
    const h = clamp(c.humanize, 0, 1);
    if (h > 0) {
        // Notes on the beat wander half as far: a drummer's downbeats are the steadiest.
        const steadiness = pos === 0 ? 0.5 : 1;
        g.offset += (hash01("t", key, row) * 2 - 1) * HUMANIZE_MAX_TIMING * h * steadiness;
        g.velocityAdd += (hash01("v", key, row) * 2 - 1) * 0.14 * h;
    }
    g.offset = clamp(g.offset, -0.45, 0.9);
    return g;
}

export function grooveVelocity(velocity: number, g: Groove): number {
    return clamp(velocity * g.velocityScale + g.velocityAdd, 0.05, 1);
}

// --- Rhythm helpers ---------------------------------------------------------------------------

export function barLength(stepsPerBeat: number): number {
    return Math.max(1, Math.round(stepsPerBeat)) * BEATS_PER_BAR;
}

/** How strong a position in the bar is: the downbeat 1, a beat 0.75, an eighth 0.5, a sixteenth 0.3. */
export function metricWeight(step: number, stepsPerBeat: number): number {
    const spb = Math.max(1, Math.round(stepsPerBeat));
    const bar = spb * BEATS_PER_BAR;
    const s = ((step % bar) + bar) % bar;
    if (s === 0) return 1;
    if (s % spb === 0) return 0.75;
    if (spb % 2 === 0 && s % (spb / 2) === 0) return 0.5;
    if (Number.isInteger(s)) return 0.3;
    return 0.15;
}

const noteTime = (n: NoteCell) => n.step + (n.offset ?? 0);
const copyNote = (n: NoteCell): NoteCell => ({ ...n });
const sortNotes = (notes: NoteCell[]) => notes.sort((a, b) => noteTime(a) - noteTime(b) || a.row - b.row);

/** A seeded random generator (mulberry32), so a variation can be reproduced from its seed. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** What a pattern move needs to know about the pattern and its track. */
export interface MoveContext {
    /** Pattern length in steps. */
    steps: number;
    stepsPerBeat: number;
    kind: "synth" | "drum";
    /** Rows the track shows. */
    rows: number;
    /** Rows per octave of the track's scale (7 for major, 5 for pentatonic, 12 chromatic). */
    rowsPerOctave: number;
    /** Drum rows that are kicks: their notes on the beat are anchors. */
    kickRows?: number[];
    /** Drum rows a fill may use (snare, toms, clap), best first. */
    fillRows?: number[];
}

/**
 * The notes a move must not touch: downbeats, the first and last notes of the phrase, and (on a
 * drum track) kicks on the beat. Returned as indices into `notes`.
 */
export function anchorIndices(notes: NoteCell[], ctx: MoveContext): Set<number> {
    const out = new Set<number>();
    if (notes.length === 0) return out;
    const bar = barLength(ctx.stepsPerBeat);
    const spb = Math.max(1, Math.round(ctx.stepsPerBeat));
    const first = Math.min(...notes.map(noteTime));
    const last = Math.max(...notes.map(noteTime));
    notes.forEach((n, i) => {
        const t = noteTime(n);
        if (n.offset === undefined || n.offset === 0) {
            if (n.step % bar === 0) out.add(i);
            if (ctx.kind === "drum" && ctx.kickRows?.includes(n.row) && n.step % spb === 0) out.add(i);
        }
        if (t === first || t === last) out.add(i);
    });
    return out;
}

function noteStrength(n: NoteCell, ctx: MoveContext): number {
    const len = ctx.kind === "synth" ? Math.min(n.length / 8, 1) * 0.1 : 0;
    return metricWeight(noteTime(n), ctx.stepsPerBeat) * 0.65 + n.velocity * 0.35 + len;
}

function occupied(notes: NoteCell[], row: number, step: number, except?: NoteCell): boolean {
    return notes.some(n => n !== except && n.row === row && step >= n.step && step < n.step + Math.max(n.length, 1));
}

// --- Pattern Variation ------------------------------------------------------------------------

export type VariationFocus = "mixed" | "rhythm" | "notes" | "fill";
export const VARIATION_FOCI: VariationFocus[] = ["mixed", "rhythm", "notes", "fill"];
export const VARIATION_LABELS = ["Mixed", "Rhythm", "Notes", "Fill"];

/**
 * A variation of a pattern: the anchors stay, the rest is revised. `strength` (0..1) is how much;
 * `focus` is what: "rhythm" nudges, drops, echoes and adds ghost notes; "notes" moves pitches to
 * nearby scale degrees (on a drum track it reshapes accents instead, since moving a kick to a
 * snare is not a variation); "fill" rewrites the last beat (last two beats when strong) as a fill;
 * "mixed" is rhythm and notes, plus a fill when strong. The same seed gives the same variation.
 */
export function makeVariation(notes: NoteCell[], ctx: MoveContext, opts: { strength: number; focus: VariationFocus; seed: number }): NoteCell[] {
    const s = clamp(opts.strength, 0.05, 1);
    const rand = seededRandom(opts.seed);
    let out = notes.map(copyNote);
    const anchorSet = anchorIndices(out, ctx);
    const anchors = new Set(out.filter((_, i) => anchorSet.has(i)));
    const free = (n: NoteCell) => !anchors.has(n);
    const doRhythm = opts.focus === "rhythm" || opts.focus === "mixed";
    const doNotes = opts.focus === "notes" || opts.focus === "mixed";
    const doFill = opts.focus === "fill" || (opts.focus === "mixed" && s > 0.66);

    if (doRhythm) {
        const removed = new Set<NoteCell>();
        const added: NoteCell[] = [];
        for (const n of out.filter(free)) {
            if (rand() >= s * 0.4) continue;
            const choice = rand();
            if (choice < 0.5) {
                const to = n.step + (rand() < 0.5 ? -1 : 1);
                if (to >= 0 && to < ctx.steps && !occupied(out, n.row, to, n)) {
                    n.step = to;
                    n.length = Math.min(n.length, ctx.steps - to);
                }
            } else if (choice < 0.75 && out.length - removed.size > 2) {
                removed.add(n);
            } else {
                const at = n.step + Math.max(1, Math.round(n.length));
                if (at < ctx.steps && !occupied(out, n.row, at) && !occupied(added, n.row, at)) {
                    added.push({ row: n.row, step: at, length: 1, velocity: clamp(n.velocity * 0.7, 0.05, 1) });
                }
            }
        }
        out = out.filter(n => !removed.has(n)).concat(added);
        // Ghost notes: quiet copies of existing rows on free offbeat sixteenths.
        const ghosts = Math.round(s * Math.max(1, notes.length * 0.25));
        const templates = out.slice();
        for (let i = 0; i < ghosts && templates.length > 0; i++) {
            const t = templates[Math.floor(rand() * templates.length)];
            const spots: number[] = [];
            for (let st = 1; st < ctx.steps; st += 2) if (!occupied(out, t.row, st)) spots.push(st);
            if (spots.length === 0) continue;
            const st = spots[Math.floor(rand() * spots.length)];
            out.push({ row: t.row, step: st, length: 1, velocity: +(0.45 + rand() * 0.2).toFixed(3) });
        }
    }

    if (doNotes) {
        for (const n of out.filter(free)) {
            if (rand() >= s * 0.5) continue;
            if (ctx.kind === "drum") {
                n.velocity = clamp(+(n.velocity * (0.7 + rand() * 0.45)).toFixed(3), 0.05, 1);
                continue;
            }
            const moves = [-2, -1, 1, 2];
            const to = n.row + moves[Math.floor(rand() * moves.length)];
            if (to >= 0 && to < ctx.rows && !occupied(out, to, n.step, n)) n.row = to;
        }
    }

    if (doFill) out = writeFill(out, ctx, s > 0.6 ? 2 : 1);

    // A little accent movement everywhere but the anchors, so even a light touch is audible.
    for (const n of out) {
        if (anchors.has(n)) continue;
        n.velocity = clamp(+(n.velocity + (rand() * 2 - 1) * s * 0.08).toFixed(3), 0.05, 1);
    }
    return dedupe(out, ctx.steps);
}

function writeFill(notes: NoteCell[], ctx: MoveContext, beats: number): NoteCell[] {
    const spb = Math.max(1, Math.round(ctx.stepsPerBeat));
    const start = Math.max(0, ctx.steps - beats * spb);
    const kept = notes.filter(n => noteTime(n) < start);
    const fill: NoteCell[] = [];
    const count = ctx.steps - start;
    if (ctx.kind === "drum") {
        const rows = ctx.fillRows && ctx.fillRows.length > 0 ? ctx.fillRows : [1];
        for (let i = 0; i < count; i++) {
            fill.push({ row: rows[Math.floor(i / Math.max(1, Math.ceil(count / rows.length))) % rows.length], step: start + i, length: 1, velocity: +(0.6 + 0.4 * (i + 1) / count).toFixed(3) });
        }
    } else {
        const before = kept.filter(n => n.step < start).sort((a, b) => b.step - a.step || b.row - a.row)[0];
        if (!before) return notes;
        const stride = beats >= 2 ? 1 : Math.max(1, spb / 2);
        let row = before.row;
        for (let st = start, i = 0; st < ctx.steps; st += stride, i++) {
            fill.push({ row: clamp(row, 0, Math.max(0, ctx.rows - 1)), step: st, length: stride, velocity: +(0.7 + 0.3 * i / Math.max(1, count / stride)).toFixed(3) });
            row += 1;
        }
        // A note ringing into the fill would smear it.
        for (const n of kept) if (n.step + n.length > start) n.length = Math.max(1, start - n.step);
    }
    return kept.concat(fill);
}

function dedupe(notes: NoteCell[], steps: number): NoteCell[] {
    const seen = new Set<string>();
    const out: NoteCell[] = [];
    for (const n of sortNotes(notes)) {
        if (n.step < 0 || n.step >= steps) continue;
        const key = `${n.row}:${noteTime(n)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        n.length = Math.min(n.length, steps - n.step);
        out.push(n);
    }
    return out;
}

// --- Thin Out ---------------------------------------------------------------------------------

/**
 * Removes the weakest notes - off the strong beats, quiet, short - while keeping downbeats and the
 * phrase's first and last notes (and kicks on the beat). `amount` is the share of the removable
 * notes that go: 0.5 halves them. Handy for turning a busy chorus into a verse or a breakdown.
 */
export function thinOut(notes: NoteCell[], ctx: MoveContext, amount: number): { notes: NoteCell[]; removed: number } {
    const a = clamp(amount, 0, 1);
    const anchors = anchorIndices(notes, ctx);
    const candidates = notes.map((n, i) => ({ n, i })).filter(({ i }) => !anchors.has(i));
    const count = Math.round(a * candidates.length);
    candidates.sort((x, y) =>
        noteStrength(x.n, ctx) - noteStrength(y.n, ctx) || noteTime(y.n) - noteTime(x.n) || y.n.row - x.n.row);
    const gone = new Set(candidates.slice(0, count).map(c => c.i));
    return { notes: notes.filter((_, i) => !gone.has(i)).map(copyNote), removed: gone.size };
}

// --- Stutter ----------------------------------------------------------------------------------

export type StutterRate = "8th" | "16th" | "32nd";
export const STUTTER_RATES: StutterRate[] = ["8th", "16th", "32nd"];

export function stutterUnit(rate: StutterRate, stepsPerBeat: number): number {
    const spb = Math.max(1, Math.round(stepsPerBeat));
    return rate === "8th" ? spb / 2 : rate === "16th" ? spb / 4 : spb / 8;
}

/**
 * Repeats a small slice at the end of the phrase: the last beat is rewritten as the slice that
 * starts it, repeated every eighth, sixteenth or thirty-second note, a little louder each time.
 * When nothing starts on that beat, the last notes played before it are what repeats. Notes ringing
 * into the stutter are cut where it begins. MIDI only: audio slicing is not done.
 */
export function stutter(notes: NoteCell[], ctx: MoveContext, rate: StutterRate, regionSteps?: number): NoteCell[] {
    const spb = Math.max(1, Math.round(ctx.stepsPerBeat));
    const region = clamp(regionSteps ?? spb, 1, ctx.steps);
    const start = ctx.steps - region;
    const unit = stutterUnit(rate, spb);
    let slice = notes.filter(n => noteTime(n) >= start && noteTime(n) < start + unit);
    if (slice.length === 0) {
        const before = notes.filter(n => noteTime(n) < start);
        if (before.length === 0) return notes.map(copyNote);
        const lastTime = Math.max(...before.map(noteTime));
        slice = before.filter(n => noteTime(n) === lastTime).map(n => ({ ...n, step: start, offset: 0 }));
    }
    const out = notes.filter(n => noteTime(n) < start).map(copyNote);
    for (const n of out) if (n.step + n.length > start) n.length = Math.max(0.5, start - n.step);
    const repeats = Math.max(1, Math.floor(region / unit + 1e-9));
    for (let k = 0; k < repeats; k++) {
        const t = start + k * unit;
        const rise = repeats > 1 ? 0.8 + 0.2 * k / (repeats - 1) : 1;
        for (const n of slice) {
            const rel = noteTime(n) - start;
            const at = t + rel;
            if (at >= ctx.steps) continue;
            const step = Math.floor(at + 1e-9);
            const note: NoteCell = { row: n.row, step, length: Math.min(unit, Math.max(0.5, n.length)), velocity: clamp(+(n.velocity * rise).toFixed(3), 0.05, 1) };
            const offset = +(at - step).toFixed(4);
            if (offset > 0) note.offset = offset;
            if (n.tone !== undefined) note.tone = n.tone;
            out.push(note);
        }
    }
    return sortNotes(out);
}

// --- Octave Spark -----------------------------------------------------------------------------

/**
 * Adds a few short octave-up notes in the last half-bar of a bass or lead phrase, on free offbeat
 * steps, each an octave above the note playing just before it. The strongest notes - anything on
 * a beat, or the loudest in the phrase - keep their timing and length; a weaker note ringing over a
 * spark is shortened to make room. Synth tracks only.
 */
export function octaveSpark(notes: NoteCell[], ctx: MoveContext, count = 3): { notes: NoteCell[]; added: number; highestRow: number } {
    const out = notes.map(copyNote);
    const highest = () => out.reduce((m, n) => Math.max(m, n.row), -1);
    if (ctx.kind !== "synth" || out.length === 0) return { notes: out, added: 0, highestRow: highest() };
    const spb = Math.max(1, Math.round(ctx.stepsPerBeat));
    const half = Math.min(ctx.steps, barLength(spb) / 2);
    const start = ctx.steps - half;
    const loudest = Math.max(...out.map(n => n.velocity));
    const strong = (n: NoteCell) => n.step % spb === 0 || n.velocity >= loudest - 1e-6;
    const picked: number[] = [];
    for (let s = ctx.steps - 1; s >= start && picked.length < count; s--) {
        if (s % spb === 0) continue;
        if (out.some(n => n.step === s)) continue;
        if (out.some(n => strong(n) && n.step < s && s < n.step + n.length)) continue;
        if (!out.some(n => n.step < s)) continue;
        if (picked.some(p => Math.abs(p - s) < 2)) continue;
        picked.push(s);
    }
    for (const s of picked.sort((a, b) => a - b)) {
        const lastStart = Math.max(...out.filter(n => n.step < s).map(n => n.step));
        const src = out.filter(n => n.step === lastStart).sort((a, b) => b.row - a.row)[0];
        for (const n of out) if (!strong(n) && n.step < s && s < n.step + n.length) n.length = s - n.step;
        out.push({ row: src.row + ctx.rowsPerOctave, step: s, length: 1, velocity: clamp(+(src.velocity * 0.9).toFixed(3), 0.05, 1) });
    }
    return { notes: sortNotes(out), added: picked.length, highestRow: highest() };
}

// --- Answer -----------------------------------------------------------------------------------

/**
 * A short response to a phrase, built only from its own notes: the first half of the phrase is
 * kept (trimmed), its pitches are played in reverse order over the same rhythm, the last note
 * resolves to the pitch the phrase started on, and the whole answer moves an octave: down when the
 * phrase sits high and there is room, up otherwise. Synth tracks only.
 */
export function answerPhrase(notes: NoteCell[], ctx: MoveContext): NoteCell[] {
    if (ctx.kind !== "synth" || notes.length === 0) return [];
    const sorted = sortNotes(notes.map(copyNote));
    let kept = sorted.filter(n => noteTime(n) < ctx.steps / 2);
    if (kept.length < 2) kept = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
    const rows = kept.map(n => n.row).reverse();
    rows[rows.length - 1] = sorted[0].row;
    const answer = kept.map((n, i) => ({ ...n, row: rows[i] }));
    for (const n of answer) n.length = Math.min(n.length, ctx.steps - n.step);
    const mean = answer.reduce((m, n) => m + n.row, 0) / answer.length;
    const lowest = Math.min(...answer.map(n => n.row));
    // Down when the phrase sits high and there is room below; otherwise up (the addon adds rows
    // above when an answer climbs past the top).
    const shift = mean >= ctx.rows / 2 && lowest - ctx.rowsPerOctave >= 0 ? -ctx.rowsPerOctave : ctx.rowsPerOctave;
    for (const n of answer) n.row += shift;
    return answer;
}

// --- Kick Lock --------------------------------------------------------------------------------

export interface KickLockChange {
    row: number;
    kind: "shortened" | "aligned";
    fromStep: number;
    toStep: number;
    fromLength: number;
    toLength: number;
}

/**
 * Keeps a bassline out of the kick's way. Every bass note still ringing when a kick hits stops at
 * that kick (including a note ringing over the pattern's end into a kick on step 0). With `align`,
 * a bass note starting one step either side of a kick moves onto it first, so the two attacks
 * land together. `kicks` are the kick's steps within the pattern.
 */
export function kickLock(notes: NoteCell[], kicks: number[], ctx: MoveContext, align: boolean): { notes: NoteCell[]; changes: KickLockChange[] } {
    const hits = [...new Set(kicks.map(k => Math.round(k)).filter(k => k >= 0 && k < ctx.steps))].sort((a, b) => a - b);
    const out = notes.map(copyNote);
    const before = new Map(out.map(n => [n, { step: n.step, length: n.length }]));
    const aligned = new Set<NoteCell>();
    if (align) {
        for (const n of out) {
            if (n.offset || hits.includes(n.step)) continue;
            const k = hits.find(h => Math.abs(h - n.step) === 1);
            if (k === undefined || out.some(o => o !== n && o.row === n.row && o.step === k)) continue;
            const end = n.step + n.length;
            n.step = k;
            n.length = Math.max(1, end - k);
            aligned.add(n);
        }
    }
    for (const n of out) {
        const end = n.step + n.length;
        const k = hits.find(h => h > noteTime(n) && h < end);
        if (k !== undefined) n.length = k - n.step;
        else if (hits.includes(0) && end > ctx.steps) n.length = ctx.steps - n.step;
    }
    const changes: KickLockChange[] = [];
    for (const n of out) {
        const was = before.get(n)!;
        if (was.step === n.step && was.length === n.length) continue;
        changes.push({ row: n.row, kind: aligned.has(n) ? "aligned" : "shortened", fromStep: was.step, toStep: n.step, fromLength: was.length, toLength: n.length });
    }
    return { notes: sortNotes(out), changes };
}

/** Whether a drum pad is a kick, by its voice, its name or its General MIDI note. */
export function isKickPad(pad: { name?: string; voice?: string; midi?: number; sample?: { name?: string } | null }): boolean {
    if (pad.voice === "kick") return true;
    if (pad.midi === 35 || pad.midi === 36) return true;
    const names = `${pad.name ?? ""} ${pad.sample?.name ?? ""}`;
    return /kick|\bbd\b|bass ?drum/i.test(names);
}

/** Rows a build or fill should roll on: snares first, then claps and toms. */
export function rollRows(pads: { name?: string; voice?: string }[]): number[] {
    const find = (re: RegExp, voice: string) => pads.map((p, i) => ({ p, i })).filter(({ p }) => p.voice === voice || re.test(p.name ?? "")).map(({ i }) => i);
    const rows = [...find(/snare|\bsd\b/i, "snare"), ...find(/clap/i, "clap"), ...find(/tom/i, "tom")];
    return [...new Set(rows)];
}

// --- Build ------------------------------------------------------------------------------------

/**
 * An accelerating drum roll for the `bars` (2 or 4) before a section boundary: quarter notes, then
 * eighths, then sixteenths, with the last half-bar in thirty-seconds, velocity climbing all the way.
 * With `sweep`, each hit's `tone` climbs too - a filter opening across the build. `kicks` (steps
 * within the build) are kept under the roll except in its final bar, which is left for tension.
 */
export function buildRoll(bars: number, stepsPerBeat: number, row: number, opts: { sweep: boolean; kickRow?: number; kicks?: number[] }): NoteCell[] {
    const spb = Math.max(1, Math.round(stepsPerBeat));
    const bar = barLength(spb);
    const n = Math.max(1, Math.round(bars));
    const total = n * bar;
    const q = spb, e = spb / 2, s = spb / 4, t = spb / 8;
    // Each bar of the roll: [(from, to, unit)] in fractions of the bar.
    const tail: [number, number, number][] = [[0, 0.5, s], [0.5, 1, t]];
    const plan: [number, number, number][][] =
        n >= 4 ? [[[0, 1, q]], [[0, 1, e]], [[0, 1, s]], tail]
            : n === 3 ? [[[0, 1, e]], [[0, 1, s]], tail]
                : n === 2 ? [[[0, 1, e]], tail]
                    : [tail];
    while (plan.length < n) plan.unshift([[0, 1, q]]);
    const out: NoteCell[] = [];
    plan.forEach((segments, b) => {
        for (const [from, to, unit] of segments) {
            for (let at = b * bar + from * bar; at < b * bar + to * bar - 1e-9; at += unit) {
                const step = Math.floor(at + 1e-9);
                const progress = at / total;
                const note: NoteCell = { row, step, length: unit >= 1 ? 1 : 0.5, velocity: +(0.35 + 0.65 * Math.pow(progress, 1.2)).toFixed(3) };
                const offset = +(at - step).toFixed(4);
                if (offset > 0) note.offset = offset;
                if (opts.sweep) note.tone = +(0.3 + 1.3 * progress).toFixed(3);
                out.push(note);
            }
        }
    });
    if (opts.kickRow !== undefined && opts.kickRow !== row) {
        for (const k of opts.kicks ?? []) {
            if (k >= 0 && k < total - bar) out.push({ row: opts.kickRow, step: k, length: 1, velocity: 1 });
        }
    }
    return sortNotes(out);
}

// --- Echo Out ---------------------------------------------------------------------------------

/**
 * Repeats of a phrase's ending, each quieter and darker than the last: `slice` is the notes of the
 * ending with steps relative to its start, `sliceSteps` long, repeated `repeats` times.
 */
export function echoRepeats(slice: NoteCell[], sliceSteps: number, repeats: number): NoteCell[] {
    const out: NoteCell[] = [];
    for (let r = 0; r < repeats; r++) {
        const level = Math.pow(0.62, r + 1);
        const dark = Math.pow(0.6, r + 1);
        for (const n of slice) {
            const at = r * sliceSteps + noteTime(n);
            const step = Math.floor(at + 1e-9);
            const note: NoteCell = {
                row: n.row, step, length: Math.min(n.length, sliceSteps),
                velocity: clamp(+(n.velocity * level).toFixed(3), 0.05, 1),
                tone: +Math.max(0.08, (n.tone ?? 1) * dark).toFixed(3),
            };
            const offset = +(at - step).toFixed(4);
            if (offset > 0) note.offset = offset;
            out.push(note);
        }
    }
    return sortNotes(out);
}

/**
 * The notes that end a stretch of music: every note starting in its last `sliceSteps`, relative to
 * the slice's start. When the phrase ends on a held note, the last notes to start are used instead.
 */
export function phraseEnding(placed: { row: number; time: number; length: number; velocity: number; tone?: number }[], end: number, sliceSteps: number): NoteCell[] {
    const start = end - sliceSteps;
    let inSlice = placed.filter(p => p.time >= start && p.time < end);
    if (inSlice.length === 0) {
        const before = placed.filter(p => p.time < start);
        if (before.length === 0) return [];
        const last = Math.max(...before.map(p => p.time));
        inSlice = before.filter(p => p.time === last).map(p => ({ ...p, time: start }));
    }
    return inSlice.map(p => {
        const rel = p.time - start;
        const step = Math.floor(rel + 1e-9);
        const note: NoteCell = { row: p.row, step, length: Math.min(p.length, sliceSteps), velocity: p.velocity };
        if (rel - step > 0) note.offset = +(rel - step).toFixed(4);
        if (p.tone !== undefined) note.tone = p.tone;
        return note;
    });
}

// --- Arrangement surgery ----------------------------------------------------------------------

/**
 * Clears [start, end) on the given tracks' lanes: clips inside it go, clips crossing an edge are
 * trimmed, and a clip spanning the whole range is split in two. A clip cut on its left keeps
 * playing its pattern from where it was (`offsetSteps`) rather than restarting it.
 */
export function carveRange(arr: ArrClip[], trackIds: Set<string>, start: number, end: number, patternSteps: (clip: ArrClip) => number, newId: IdGen): { removed: number; trimmed: number } {
    let removed = 0;
    let trimmed = 0;
    const shifted = (c: ArrClip, by: number) => {
        const steps = Math.max(1, patternSteps(c));
        return ((((c.offsetSteps ?? 0) + by) % steps) + steps) % steps;
    };
    for (const c of arr.slice()) {
        if (!trackIds.has(c.trackId)) continue;
        const cEnd = clipEnd(c);
        if (cEnd <= start || c.startStep >= end) continue;
        const before = c.startStep < start;
        const after = cEnd > end;
        if (!before && !after) {
            arr.splice(arr.indexOf(c), 1);
            removed++;
        } else if (before && !after) {
            c.lengthSteps = start - c.startStep;
            trimmed++;
        } else if (!before && after) {
            const offset = shifted(c, end - c.startStep);
            c.lengthSteps = cEnd - end;
            c.startStep = end;
            if (offset) c.offsetSteps = offset; else delete c.offsetSteps;
            trimmed++;
        } else {
            const offset = shifted(c, end - c.startStep);
            const rest: ArrClip = { ...c, id: newId(), startStep: end, lengthSteps: cEnd - end };
            if (offset) rest.offsetSteps = offset; else delete rest.offsetSteps;
            arr.push(rest);
            c.lengthSteps = start - c.startStep;
            trimmed++;
        }
    }
    return { removed, trimmed };
}

/** A section boundary for Build and Drop Gap: the bar line nearest `step`. */
export function nearestBar(step: number, stepsPerBeat: number): number {
    const bar = barLength(stepsPerBeat);
    return Math.round(step / bar) * bar;
}

/** Hard cuts made by Drop Gap without tails: which tracks fall silent from `startStep` to `endStep`. */
export interface HardCut {
    id: string;
    trackIds: string[];
    startStep: number;
    endStep: number;
}

export function repairCuts(cuts: any): HardCut[] {
    if (!Array.isArray(cuts)) return [];
    return cuts.filter(c => c && typeof c.id === "string" && Array.isArray(c.trackIds)
        && Number.isFinite(c.startStep) && Number.isFinite(c.endStep) && c.endStep > c.startStep)
        .map(c => ({ id: c.id, trackIds: c.trackIds.filter((t: unknown) => typeof t === "string"), startStep: c.startStep, endStep: c.endStep }));
}

/** Whether `trackId` is hard-cut at song step `step`. */
export function isCut(cuts: HardCut[], trackId: string, step: number): boolean {
    return cuts.some(c => step >= c.startStep && step < c.endStep && c.trackIds.includes(trackId));
}
