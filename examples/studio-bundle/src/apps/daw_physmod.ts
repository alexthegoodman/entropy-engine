// The bowed-string synth's model: what a physmod track saves, how a saved one is repaired, which
// open string a note picks, and how a note becomes an engine call. Pure, so it can be tested without
// a window.
//
// Unlike the wavetable there is no persistent editable data living engine-side under the track's id
// (see src/audio/physmod.rs) - a bowed string carries no sculpted content, only live bow state, so
// nothing here needs exporting/importing or an undo stack.

export const PHYSMOD_WAVEFORM = "physmod";

export interface PhysModInstrumentPreset {
    id: string;
    label: string;
    /** Open-string frequencies, low to high (up to 4). A note picks the highest string whose open
     *  pitch is at or below the requested note, the way a player would choose a string to stop. */
    strings: number[];
    /** 0 (violin-register body resonances) to 1 (bass-register). */
    bodySize: number;
}

/** Standard equal-tempered (A4 = 440 Hz) open-string frequencies for four orchestral strings. */
export const PHYSMOD_INSTRUMENT_PRESETS: PhysModInstrumentPreset[] = [
    { id: "violin", label: "Violin", strings: [196.0, 293.66, 440.0, 659.25], bodySize: 0.0 },
    { id: "viola", label: "Viola", strings: [130.81, 196.0, 293.66, 440.0], bodySize: 0.25 },
    { id: "cello", label: "Cello", strings: [65.41, 98.0, 146.83, 220.0], bodySize: 0.6 },
    { id: "bass", label: "Bass", strings: [41.2, 55.0, 73.42, 98.0], bodySize: 1.0 },
];

export function instrumentPresetById(id: string): PhysModInstrumentPreset | undefined {
    return PHYSMOD_INSTRUMENT_PRESETS.find(p => p.id === id);
}

/** The string (0 = lowest) a player would choose to reach `freq`: the highest-pitched open string
 *  that is still at or below it, so the note is reached by stopping the string, not an open note
 *  played below its own pitch. Below every open string, the lowest string is used (a real player
 *  simply cannot go lower). */
export function stringForFreq(strings: number[], freq: number): number {
    let choice = 0;
    for (let i = 0; i < strings.length; i++) {
        if (strings[i] <= freq) choice = i;
    }
    return choice;
}

export const PHYSMOD_TOOLS = ["orbit"] as const;

export interface PhysModSettings {
    /** The instrument preset the tuning and body size started from, for the label and the picker. */
    instrument: string;
    bowForce: number;
    bowVelocity: number;
    /** 0.02..0.5, fraction of the string's length from the bridge. */
    bowPosition: number;
    vibratoRate: number;
    vibratoDepth: number;
    damping: number;
    brightness: number;
    bodySize: number;
    bodyMix: number;
    // Editor state.
    audition: boolean;
    /** MIDI note the audition and the Hold button play. */
    auditionNote: number;
}

export function defaultPhysMod(instrument = "violin"): PhysModSettings {
    const preset = instrumentPresetById(instrument) ?? PHYSMOD_INSTRUMENT_PRESETS[0];
    return {
        instrument,
        bowForce: 0.5,
        bowVelocity: 0.5,
        bowPosition: 0.15,
        vibratoRate: 5.5,
        vibratoDepth: 15.0,
        damping: 0.15,
        brightness: 0.5,
        bodySize: preset.bodySize,
        bodyMix: 0.35,
        audition: true,
        auditionNote: 60,
    };
}

const num = (v: unknown, fallback: number, lo: number, hi: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(hi, Math.max(lo, n));
};

/** A physmod track's settings from whatever was saved: every field clamped, anything missing
 *  defaulted. */
export function repairPhysMod(saved: unknown): PhysModSettings {
    const d = defaultPhysMod();
    const s: any = saved && typeof saved === "object" ? saved : {};
    const instrument = PHYSMOD_INSTRUMENT_PRESETS.some(p => p.id === s.instrument) ? s.instrument : d.instrument;
    return {
        instrument,
        bowForce: num(s.bowForce, d.bowForce, 0, 1),
        bowVelocity: num(s.bowVelocity, d.bowVelocity, 0, 1),
        bowPosition: num(s.bowPosition, d.bowPosition, 0.02, 0.5),
        vibratoRate: num(s.vibratoRate, d.vibratoRate, 0, 12),
        vibratoDepth: num(s.vibratoDepth, d.vibratoDepth, 0, 100),
        damping: num(s.damping, d.damping, 0, 1),
        brightness: num(s.brightness, d.brightness, 0, 1),
        bodySize: num(s.bodySize, d.bodySize, 0, 1),
        bodyMix: num(s.bodyMix, d.bodyMix, 0, 1),
        audition: s.audition === undefined ? d.audition : s.audition === true,
        auditionNote: Math.round(num(s.auditionNote, d.auditionNote, 24, 96)),
    };
}

export interface PhysModNote {
    trackId?: string;
    instrument: string;
    freq: number;
    velocity: number;
    gain: number;
    bowForce: number;
    bowVelocity: number;
    bowPosition: number;
    vibratoRate: number;
    vibratoDepth: number;
    damping: number;
    brightness: number;
    bodySize: number;
    bodyMix: number;
    attack: number;
    release: number;
    duration?: number;
    startTime?: number;
}

/** How loud a bowed-string voice is at full velocity, before the track's own gain. */
export const PHYSMOD_GAIN = 1.1;

/** The engine call for one note of a physmod track: the settings, the string-dependent brightness
 *  tweak, and the requested pitch/velocity/duration. `instrument` is the track id. */
export function noteConfig(
    trackId: string,
    pm: PhysModSettings,
    note: { freq: number; velocity: number; duration?: number; startTime?: number },
): PhysModNote {
    const preset = instrumentPresetById(pm.instrument) ?? PHYSMOD_INSTRUMENT_PRESETS[0];
    const stringIndex = stringForFreq(preset.strings, note.freq);
    // Lower strings read a little darker, higher strings a little airier - a real trait of thicker
    // wound strings versus thin plain ones, applied as a straightforward per-string offset rather
    // than modeled from string mass/gauge.
    const stringBrightness = Math.min(1, Math.max(0, pm.brightness + (stringIndex - (preset.strings.length - 1) / 2) * 0.08));
    return {
        trackId,
        instrument: trackId,
        freq: note.freq,
        velocity: note.velocity,
        gain: PHYSMOD_GAIN,
        bowForce: pm.bowForce,
        bowVelocity: pm.bowVelocity,
        bowPosition: pm.bowPosition,
        vibratoRate: pm.vibratoRate,
        vibratoDepth: pm.vibratoDepth,
        damping: pm.damping,
        brightness: stringBrightness,
        bodySize: pm.bodySize,
        bodyMix: pm.bodyMix,
        attack: 0.02,
        release: 0.12,
        ...(note.duration !== undefined ? { duration: note.duration } : {}),
        ...(note.startTime !== undefined ? { startTime: note.startTime } : {}),
    };
}

/** The bit of a track an AI tool reports: enough to describe it without repeating every field. */
export function describeSettings(pm: PhysModSettings): Record<string, unknown> {
    return {
        instrument: pm.instrument, bowForce: pm.bowForce, bowVelocity: pm.bowVelocity, bowPosition: pm.bowPosition,
        vibratoRate: pm.vibratoRate, vibratoDepth: pm.vibratoDepth, damping: pm.damping, brightness: pm.brightness,
        bodySize: pm.bodySize, bodyMix: pm.bodyMix,
    };
}
