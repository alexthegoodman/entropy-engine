// The wavetable synth's model: what a wavetable track saves, how a saved one is repaired, and how a
// note on it becomes an engine call. Pure, so it can be tested without a window.
//
// The table itself lives engine-side (src/audio/wavetable.rs), named by the track's id. What is
// saved with the project is that table as base64 (`data`), the settings below, and the state of the
// editor (tool, brush, selected frame), so the window reopens the way it was left.

export const WT_WAVEFORM = "wavetable";

export interface WtPreset { id: string; label: string }

/** The presets the engine knows, in the order the editor lists them. */
export const WT_PRESETS: WtPreset[] = [
    { id: "sine", label: "Sine" },
    { id: "saw", label: "Sine to Saw" },
    { id: "square", label: "Sine to Square" },
    { id: "pwm", label: "Pulse Width" },
    { id: "vowels", label: "Vowels" },
    { id: "bell", label: "FM Bell" },
    { id: "terrain", label: "Terrain" },
    { id: "glass", label: "Glass" },
];

export const WT_OPS: { id: string; label: string; arg?: number }[] = [
    { id: "normalize", label: "Normalize" },
    { id: "smooth", label: "Smooth" },
    { id: "invert", label: "Invert" },
    { id: "reverse", label: "Reverse" },
    { id: "flip_frames", label: "Flip frames" },
    { id: "randomize", label: "Randomize" },
];

export const WT_TOOLS = ["raise", "lower", "smooth", "level", "orbit"] as const;
export type WtTool = typeof WT_TOOLS[number];

export interface WavetableSettings {
    /** The preset the table started from, for the label. */
    preset: string;
    /** The whole table as base64 (see Wavetable.exportData); absent until the first save. */
    data?: string;
    /** Where the note rests in the table, 0..1 across the frames. */
    position: number;
    lfoRate: number;
    lfoDepth: number;
    sweep: number;
    sweepTime: number;
    velToPosition: number;
    unison: number;
    detuneCents: number;
    spread: number;
    // Editor state.
    tool: WtTool;
    radius: number;
    strength: number;
    frame: number;
    /** Sound a held note while a stroke is in progress, so the edit is heard as it is made. */
    audition: boolean;
    /** MIDI note the audition and the Hold button play. */
    auditionNote: number;
}

export function defaultWavetable(preset = "saw"): WavetableSettings {
    return {
        preset, position: 0.35, lfoRate: 0, lfoDepth: 0, sweep: 0, sweepTime: 0.6, velToPosition: 0,
        unison: 1, detuneCents: 14, spread: 0.6,
        tool: "raise", radius: 0.16, strength: 0.5, frame: 0, audition: true, auditionNote: 48,
    };
}

const num = (v: unknown, fallback: number, lo: number, hi: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(hi, Math.max(lo, n));
};

/** A wavetable's settings from whatever was saved: every field clamped, anything missing defaulted. */
export function repairWavetable(saved: unknown): WavetableSettings {
    const d = defaultWavetable();
    const s: any = saved && typeof saved === "object" ? saved : {};
    const preset = WT_PRESETS.some(p => p.id === s.preset) ? s.preset : (s.data ? "custom" : d.preset);
    return {
        preset,
        data: typeof s.data === "string" && s.data.length > 0 ? s.data : undefined,
        position: num(s.position, d.position, 0, 1),
        lfoRate: num(s.lfoRate, d.lfoRate, 0, 20),
        lfoDepth: num(s.lfoDepth, d.lfoDepth, 0, 1),
        sweep: num(s.sweep, d.sweep, -1, 1),
        sweepTime: num(s.sweepTime, d.sweepTime, 0.02, 6),
        velToPosition: num(s.velToPosition, d.velToPosition, -1, 1),
        unison: Math.round(num(s.unison, d.unison, 1, 7)),
        detuneCents: num(s.detuneCents, d.detuneCents, 0, 60),
        spread: num(s.spread, d.spread, 0, 1),
        tool: (WT_TOOLS as readonly string[]).includes(s.tool) ? s.tool : d.tool,
        radius: num(s.radius, d.radius, 0.04, 0.6),
        strength: num(s.strength, d.strength, 0.05, 1),
        frame: Math.round(num(s.frame, d.frame, 0, 63)),
        audition: s.audition === undefined ? d.audition : s.audition === true,
        auditionNote: Math.round(num(s.auditionNote, d.auditionNote, 24, 96)),
    };
}

export interface VoiceLike {
    cutoff: number;
    resonance: number;
    attack: number;
    decay: number;
    sustain: number;
    release: number;
}

/** How loud a wavetable voice is at full velocity, before the track's own gain. Chosen so a
 *  wavetable track sits at about the level of a saw track with the same gain. */
export const WT_GAIN = 1.0;

/** One wavetable note as the engine takes it (see WavetableNoteConfig in addon.d.ts). */
export interface WtNote {
    table: string;
    freq: number;
    velocity: number;
    gain: number;
    position: number;
    lfoRate: number;
    lfoDepth: number;
    sweep: number;
    sweepTime: number;
    velToPosition: number;
    unison: number;
    detuneCents: number;
    spread: number;
    cutoff: number;
    resonance: number;
    attack: number;
    decay: number;
    sustain: number;
    release: number;
    duration?: number;
    startTime?: number;
}

/** The engine call for one note of a wavetable track: the track's voice (filter and envelope) and
 *  the wavetable's own settings. `table` is the track id. */
export function noteConfig(
    table: string,
    voice: VoiceLike,
    wt: WavetableSettings,
    note: { freq: number; velocity: number; duration?: number; startTime?: number },
): WtNote {
    return {
        table,
        freq: note.freq,
        velocity: note.velocity,
        gain: WT_GAIN,
        position: wt.position,
        lfoRate: wt.lfoRate,
        lfoDepth: wt.lfoDepth,
        sweep: wt.sweep,
        sweepTime: wt.sweepTime,
        velToPosition: wt.velToPosition,
        unison: wt.unison,
        detuneCents: wt.detuneCents,
        spread: wt.spread,
        cutoff: voice.cutoff,
        resonance: voice.resonance,
        attack: voice.attack,
        decay: voice.decay,
        sustain: voice.sustain,
        release: voice.release,
        ...(note.duration !== undefined ? { duration: note.duration } : {}),
        ...(note.startTime !== undefined ? { startTime: note.startTime } : {}),
    };
}

/** The bit of a table an AI tool reports: enough to describe it without sending 65,000 numbers. */
export function describeSettings(wt: WavetableSettings): Record<string, unknown> {
    return {
        preset: wt.preset, position: wt.position, lfoRate: wt.lfoRate, lfoDepth: wt.lfoDepth, sweep: wt.sweep,
        sweepTime: wt.sweepTime, velToPosition: wt.velToPosition, unison: wt.unison, detuneCents: wt.detuneCents, spread: wt.spread,
    };
}

export const midiName = (midi: number): string => {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
};
