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

/** A full patch on top of a table preset: the table it starts from, the motion/voice settings
 *  that make it read as "bass" or "strings" rather than a bare waveform, and the filter/envelope
 *  a track's Voice panel would otherwise leave at its plain defaults. Deliberately named "Simple
 *  X" where a richer instrument is a known future step (Simple Strings, Simple Horns) - this is a
 *  starting point built entirely from what the wavetable engine already has (table shape, motion,
 *  unison, filter, envelope), not a dedicated physically-modelled instrument. */
export interface WtInstrumentPreset {
    id: string;
    label: string;
    /** Groups presets in the picker (Bass, Motion FX, Strings & Horns, Pads & Leads). */
    folder: string;
    /** One line under the label: what it is and the trick that makes it work. */
    hint: string;
    /** The table shape this patch is built from (an id in WT_PRESETS). */
    table: string;
    settings: Pick<WavetableSettings, "position" | "lfoRate" | "lfoDepth" | "sweep" | "sweepTime" | "velToPosition" | "unison" | "detuneCents" | "spread">;
    voice: VoiceLike;
}

/** Curated full patches, built from nothing but the table shapes and motion/filter/envelope the
 *  engine already exposes. `sweep` decays FROM `position + sweep` back TO `position` over
 *  `sweepTime` (see WavetableParams.sweep) - so a preset that wants brightness to rise into the
 *  note (a riser, a horn's blown-harder blip) sets `position` high and `sweep` negative, and one
 *  that wants a falling transient (a zap, a pluck) sets `position` low and `sweep` positive. */
export const WT_INSTRUMENT_PRESETS: WtInstrumentPreset[] = [
    {
        id: "modulated_bass", label: "Modulated Bass", folder: "Bass", table: "saw",
        hint: "A wobble: the LFO morphs the table while a resonant filter tracks it.",
        settings: { position: 0.28, lfoRate: 5.5, lfoDepth: 0.4, sweep: 0.12, sweepTime: 0.12, velToPosition: 0.15, unison: 3, detuneCents: 9, spread: 0.25 },
        voice: { cutoff: 1600, resonance: 2.2, attack: 0.004, decay: 0.18, sustain: 0.7, release: 0.1 },
    },
    {
        id: "sub_pulse", label: "Sub Pulse", folder: "Bass", table: "pwm",
        hint: "A narrow pulse held near the sine end of the table: low-end weight, no wobble.",
        settings: { position: 0.05, lfoRate: 0, lfoDepth: 0, sweep: 0, sweepTime: 0.6, velToPosition: 0, unison: 1, detuneCents: 0, spread: 0 },
        voice: { cutoff: 900, resonance: 0.6, attack: 0.002, decay: 0.08, sustain: 0.85, release: 0.09 },
    },
    {
        id: "acid_bass", label: "Acid Bass", folder: "Bass", table: "saw",
        hint: "A resonant filter and a fast position sweep stand in for a 303's envelope-mod squelch.",
        settings: { position: 0.55, lfoRate: 0, lfoDepth: 0, sweep: 0.5, sweepTime: 0.35, velToPosition: 0.3, unison: 1, detuneCents: 0, spread: 0 },
        voice: { cutoff: 2200, resonance: 6.5, attack: 0.002, decay: 0.25, sustain: 0.35, release: 0.12 },
    },
    {
        id: "synth_riser", label: "Synth Riser", folder: "Motion FX", table: "glass",
        hint: "Position rests bright; a negative sweep starts dark and climbs into it over ~3.5s.",
        settings: { position: 0.92, lfoRate: 0.6, lfoDepth: 0.05, sweep: -0.85, sweepTime: 3.5, velToPosition: 0, unison: 5, detuneCents: 32, spread: 0.9 },
        voice: { cutoff: 19000, resonance: 0.2, attack: 3.2, decay: 0.2, sustain: 1.0, release: 1.5 },
    },
    {
        id: "sweeping_siren", label: "Sweeping Siren", folder: "Motion FX", table: "vowels",
        hint: "A slow, deep LFO wails the formant table back and forth like a siren's cycle.",
        settings: { position: 0.5, lfoRate: 0.4, lfoDepth: 0.9, sweep: 0, sweepTime: 0.6, velToPosition: 0, unison: 2, detuneCents: 18, spread: 0.7 },
        voice: { cutoff: 12000, resonance: 1.0, attack: 0.3, decay: 0.1, sustain: 1.0, release: 0.6 },
    },
    {
        id: "laser_zap", label: "Laser Zap", folder: "Motion FX", table: "square",
        hint: "A bright, near-instant sweep collapses to the sine end - a classic falling zap.",
        settings: { position: 0.05, lfoRate: 0, lfoDepth: 0, sweep: 0.95, sweepTime: 0.09, velToPosition: 0, unison: 1, detuneCents: 0, spread: 0 },
        voice: { cutoff: 20000, resonance: 0.2, attack: 0.0005, decay: 0.12, sustain: 0.0, release: 0.05 },
    },
    {
        id: "simple_strings", label: "Simple Strings", folder: "Strings & Horns", table: "saw",
        hint: "A wide, detuned unison section (the ensemble effect) on a slow bow-like swell.",
        settings: { position: 0.6, lfoRate: 4.8, lfoDepth: 0.03, sweep: 0, sweepTime: 0.6, velToPosition: 0.1, unison: 6, detuneCents: 16, spread: 0.85 },
        voice: { cutoff: 6500, resonance: 0.4, attack: 0.35, decay: 0.2, sustain: 0.85, release: 0.9 },
    },
    {
        id: "simple_horns", label: "Simple Horns", folder: "Strings & Horns", table: "square",
        hint: "Harder velocity brightens the table (a real brass trait) with a fast attack blip.",
        settings: { position: 0.45, lfoRate: 5.5, lfoDepth: 0.02, sweep: 0.2, sweepTime: 0.06, velToPosition: 0.35, unison: 3, detuneCents: 10, spread: 0.5 },
        voice: { cutoff: 5200, resonance: 1.1, attack: 0.03, decay: 0.15, sustain: 0.8, release: 0.25 },
    },
    {
        id: "warm_pad", label: "Warm Pad", folder: "Pads & Leads", table: "vowels",
        hint: "A slow LFO drifts the formants; a long attack and release make it a bed, not a lead.",
        settings: { position: 0.3, lfoRate: 0.25, lfoDepth: 0.15, sweep: 0, sweepTime: 0.6, velToPosition: 0, unison: 5, detuneCents: 22, spread: 0.8 },
        voice: { cutoff: 3800, resonance: 0.3, attack: 1.2, decay: 0.4, sustain: 0.9, release: 1.6 },
    },
    {
        id: "glass_pluck", label: "Glass Pluck", folder: "Pads & Leads", table: "glass",
        hint: "Zero sustain and a quick sweep-driven decay: struck, not held.",
        settings: { position: 0.5, lfoRate: 0, lfoDepth: 0, sweep: 0.4, sweepTime: 0.15, velToPosition: 0.2, unison: 2, detuneCents: 6, spread: 0.3 },
        voice: { cutoff: 9000, resonance: 0.8, attack: 0.002, decay: 0.35, sustain: 0.0, release: 0.2 },
    },
];

/** `WT_INSTRUMENT_PRESETS` grouped by folder, in first-seen order, for a tree/outliner picker. */
export function instrumentPresetFolders(): { folder: string; presets: WtInstrumentPreset[] }[] {
    const out: { folder: string; presets: WtInstrumentPreset[] }[] = [];
    for (const p of WT_INSTRUMENT_PRESETS) {
        let group = out.find(g => g.folder === p.folder);
        if (!group) { group = { folder: p.folder, presets: [] }; out.push(group); }
        group.presets.push(p);
    }
    return out;
}

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
    /** The full patch last applied from WT_INSTRUMENT_PRESETS, if any - so the picker can show
     *  which one is active. Sculpting the table or changing a setting by hand does not clear it;
     *  it is a "started from" record, not a locked-in link. */
    instrumentPreset?: string;
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

/** Applies a full instrument preset's table seed and settings onto a `WavetableSettings`, in
 *  place, so the caller only has to also give the track its `voice` fields (see daw_synth_addon.ts
 *  `applyInstrumentPreset`, which needs a live track to do that). Returns the preset applied, or
 *  undefined for an unknown id. */
export function instrumentPresetById(id: string): WtInstrumentPreset | undefined {
    return WT_INSTRUMENT_PRESETS.find(p => p.id === id);
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
        instrumentPreset: WT_INSTRUMENT_PRESETS.some(p => p.id === s.instrumentPreset) ? s.instrumentPreset : undefined,
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
        preset: wt.preset, instrumentPreset: wt.instrumentPreset, position: wt.position, lfoRate: wt.lfoRate, lfoDepth: wt.lfoDepth, sweep: wt.sweep,
        sweepTime: wt.sweepTime, velToPosition: wt.velToPosition, unison: wt.unison, detuneCents: wt.detuneCents, spread: wt.spread,
    };
}

export const midiName = (midi: number): string => {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
};
