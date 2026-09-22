// Pure logic for the DAW's Guitar Input panel: saved preferences, turning a recorded take into a
// pattern, and the readouts. No `Entropy` calls in here, so it runs under vitest as it is
// (tests/daw_guitar_bdd.test.ts). The panel that uses it is in daw_synth_addon.ts.
//
// The engine itself is Rust (src/guitar, spec GUITAR_TO_MIDI.md). Nothing per-sample crosses into
// JS: the panel polls Entropy.Guitar.status() and works from that small snapshot.

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(midi: number): string {
    return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export type GuitarMode = "fast" | "balanced" | "accurate";
export const GUITAR_MODES: GuitarMode[] = ["fast", "balanced", "accurate"];
export const GUITAR_WAVEFORMS = ["wavetable", "sine", "triangle", "saw", "square"] as const;

/** What is saved with the project (spec CFG-1). Unknown fields in a saved file are ignored and
 * missing ones take their defaults (CFG-4), so a newer or older save still opens. */
export interface GuitarPrefs {
    version: number;
    host?: string;
    /** A device that is not plugged in stays here, shown as unavailable (CFG-3). */
    device?: string;
    /** Zero-based input channel. */
    channel: number;
    sampleRate: number;
    bufferFrames: number;
    mode: GuitarMode;
    sensitivity: number;
    bendRange: number;
    referencePitch: number;
    gateOpenDb?: number;
    gateCloseDb?: number;
    velocityFloorDb?: number;
    velocityCeilDb?: number;
    /** The track the notes play on. */
    targetTrackId: string | null;
    waveform: (typeof GUITAR_WAVEFORMS)[number];
}

export const GUITAR_PREFS_VERSION = 1;

export function defaultGuitarPrefs(): GuitarPrefs {
    return {
        version: GUITAR_PREFS_VERSION,
        channel: 0,
        sampleRate: 48000,
        bufferFrames: 128,
        mode: "balanced",
        sensitivity: 0.5,
        bendRange: 2,
        referencePitch: 440,
        targetTrackId: null,
        waveform: "saw",
    };
}

const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Reads saved preferences of any age or shape into a valid `GuitarPrefs`. */
export function readGuitarPrefs(saved: unknown): GuitarPrefs {
    const d = defaultGuitarPrefs();
    if (!saved || typeof saved !== "object") return d;
    const s = saved as Record<string, any>;
    const out: GuitarPrefs = {
        ...d,
        channel: Math.round(num(s.channel, 0, 63, d.channel)),
        sampleRate: num(s.sampleRate, 8000, 192000, d.sampleRate),
        bufferFrames: Math.round(num(s.bufferFrames, 16, 8192, d.bufferFrames)),
        mode: GUITAR_MODES.includes(s.mode) ? s.mode : d.mode,
        sensitivity: num(s.sensitivity, 0, 1, d.sensitivity),
        bendRange: Math.round(num(s.bendRange, 1, 12, d.bendRange)),
        referencePitch: num(s.referencePitch, 392, 494, d.referencePitch),
        targetTrackId: typeof s.targetTrackId === "string" ? s.targetTrackId : null,
        waveform: (GUITAR_WAVEFORMS as readonly string[]).includes(s.waveform) ? s.waveform : d.waveform,
    };
    if (typeof s.host === "string" && s.host) out.host = s.host;
    if (typeof s.device === "string" && s.device) out.device = s.device;
    for (const k of ["gateOpenDb", "gateCloseDb", "velocityFloorDb", "velocityCeilDb"] as const) {
        if (typeof s[k] === "number" && Number.isFinite(s[k])) out[k] = s[k];
    }
    return out;
}

/** Settings for `Guitar.start` / `Guitar.set` from the saved preferences. */
export function startConfig(p: GuitarPrefs): Record<string, unknown> {
    const c: Record<string, unknown> = {
        channel: p.channel, sampleRate: p.sampleRate, bufferFrames: p.bufferFrames,
        mode: p.mode, sensitivity: p.sensitivity, bendRange: p.bendRange, referencePitch: p.referencePitch,
    };
    if (p.host) c.host = p.host;
    if (p.device) c.device = p.device;
    for (const k of ["gateOpenDb", "gateCloseDb", "velocityFloorDb", "velocityCeilDb"] as const) {
        if (p[k] !== undefined) c[k] = p[k];
    }
    return c;
}

// --- A take becomes a pattern --------------------------------------------------------------------

export interface TakeNote {
    note: number;
    velocity: number;
    startS: number;
    endS: number;
    bends?: [number, number][];
}

export interface TakePattern {
    /** A chromatic track rooted here: row 0 is this MIDI note, row n is n semitones up. */
    rootNote: number;
    rows: number;
    steps: number;
    cells: { row: number; step: number; length: number; velocity: number }[];
    /** Notes left out because they fell outside the row span. */
    dropped: number;
    /** Bend points in the take. The DAW's note cells have no bend field, so they are not kept. */
    bendPoints: number;
}

/** Quantizes a take to the step grid. `startS` is already corrected for detection latency, so a note
 * lands on the step it was played on, not the one after. A note is trimmed at the next note's start
 * (the input is monophonic), and the pattern is a whole number of bars. */
export function takeToPattern(notes: TakeNote[], bpm: number, stepsPerBeat: number, maxRows = 48): TakePattern | null {
    const played = notes.filter(n => Number.isFinite(n.startS) && Number.isFinite(n.endS)).sort((a, b) => a.startS - b.startS);
    if (played.length === 0 || !(bpm > 0)) return null;

    const stepSeconds = 60 / bpm / stepsPerBeat;
    const lowest = Math.min(...played.map(n => n.note));
    const highest = Math.max(...played.map(n => n.note));
    const rootNote = lowest;
    const rows = Math.min(maxRows, highest - lowest + 1);

    const starts = played.map(n => Math.max(0, Math.round(n.startS / stepSeconds)));
    const cells: TakePattern["cells"] = [];
    let dropped = 0;
    let lastEnd = 0;
    played.forEach((n, i) => {
        const row = n.note - rootNote;
        if (row >= rows) { dropped++; return; }
        const start = starts[i];
        let length = Math.max(1, Math.round((n.endS - n.startS) / stepSeconds));
        const next = starts.slice(i + 1).find(s => s > start);
        if (next !== undefined) length = Math.min(length, next - start);
        // Two notes that quantize to the same step: the later one wins the step, as it was played later.
        const clash = cells.findIndex(c => c.step === start);
        if (clash >= 0) cells.splice(clash, 1);
        cells.push({ row, step: start, length, velocity: Math.min(1, Math.max(1 / 127, n.velocity / 127)) });
        lastEnd = Math.max(lastEnd, start + length);
    });

    const bar = 4 * stepsPerBeat;
    const steps = Math.max(bar, Math.ceil(lastEnd / bar) * bar);
    const bendPoints = played.reduce((a, n) => a + (n.bends?.length ?? 0), 0);
    return { rootNote, rows, steps, cells, dropped, bendPoints };
}

// --- Readouts ------------------------------------------------------------------------------------

export interface GuitarDiag {
    levelDb: number; inputPeakDb: number; clipped: boolean; freqHz: number; confidence: number;
    note: number | null; cents: number; state: string; velocity: number; bend: number;
    pipelineLatencyMs: number; bufferMs: number; bufferFrames: number; sampleRate: number;
    callbacks: number; overruns: number; streamErrors: number; maxCallbackUs: number; meanCallbackUs: number;
    droppedBends: number; droppedEvents: number; notes: number; noiseRejects: number;
    octaveRejects: number; octaveCorrections: number; slides: number; repicks: number;
}

/** 14-bit bend to cents for a range in semitones each way. */
export function bendCents(bend: number, rangeSemitones: number): number {
    return ((bend - 8192) / 8192) * rangeSemitones * 100;
}

const fixed = (v: number, digits: number) => (Number.isFinite(v) ? v.toFixed(digits) : "-");

/** The lines of the diagnostics readout (spec DIA-1). */
export function diagnosticsLines(d: GuitarDiag, rangeSemitones: number): string[] {
    const heard = d.note === null ? "no note" : `${noteName(d.note)}  (${d.cents >= 0 ? "+" : ""}${fixed(d.cents, 0)} cents)`;
    return [
        `Note: ${heard}   state: ${d.state}   velocity: ${d.velocity}`,
        `Detected: ${d.freqHz > 0 ? fixed(d.freqHz, 1) + " Hz" : "-"}   confidence: ${fixed(d.confidence * 100, 0)}%   bend: ${fixed(bendCents(d.bend, rangeSemitones), 0)} cents`,
        `Level: ${fixed(d.levelDb, 1)} dBFS   peak: ${fixed(d.inputPeakDb, 1)} dBFS${d.clipped ? "   CLIPPING" : ""}`,
        `Buffer: ${d.bufferFrames} frames at ${d.sampleRate} Hz = ${fixed(d.bufferMs, 1)} ms   pick to note: ${fixed(d.pipelineLatencyMs, 1)} ms (device latency not included)`,
        `Callbacks: ${d.callbacks}   mean ${fixed(d.meanCallbackUs, 0)} us   max ${d.maxCallbackUs} us   overruns: ${d.overruns}   stream errors: ${d.streamErrors}`,
        `Notes: ${d.notes}   noise rejected: ${d.noiseRejects}   octave rejected/corrected: ${d.octaveRejects}/${d.octaveCorrections}   slides: ${d.slides}   re-picks: ${d.repicks}   dropped: ${d.droppedBends} bends, ${d.droppedEvents} notes`,
    ];
}

/** A text meter: `-60..0 dBFS` across `width` cells. */
export function levelBar(db: number, width = 24): string {
    const t = Number.isFinite(db) ? Math.min(1, Math.max(0, (db + 60) / 60)) : 0;
    const filled = Math.round(t * width);
    return "[" + "#".repeat(filled) + ".".repeat(width - filled) + "]";
}

/** Watches the peaks of the notes played and says when the input is too quiet (spec 3.1): after several
 * notes whose loudest level stays under -30 dBFS. */
export class SignalHints {
    private peaks: number[] = [];
    private sounding = false;
    private notePeak = -120;

    /** Feed each status poll. */
    update(noteSounding: boolean, levelDb: number) {
        if (noteSounding) {
            this.notePeak = this.sounding ? Math.max(this.notePeak, levelDb) : levelDb;
        } else if (this.sounding) {
            this.peaks.push(this.notePeak);
            if (this.peaks.length > 8) this.peaks.shift();
        }
        this.sounding = noteSounding;
    }

    tooQuiet(): boolean {
        if (this.peaks.length < 4) return false;
        const recent = this.peaks.slice(-6);
        return recent.every(p => p < -30);
    }

    reset() {
        this.peaks = [];
        this.sounding = false;
        this.notePeak = -120;
    }
}
