// The physically modelled grand piano instrument's model in the DAW: what a piano track saves,
// how a saved one is repaired, voicing presets, and how a note becomes an engine call.
// Pure, so it can be tested without a window.
//
// The engine (src/audio/piano/) models nonlinear felt hammer contact dynamics, an 88-key string harp
// with stretched Railsback inharmonicity and coupled unisons, spruce soundboard modal radiation with
// bridge velocity feedback, and sympathetic sustain / una corda pedal acoustics.

import { repairQuality, type ModelQuality } from "./daw_quality";

export const PIANO_WAVEFORM = "piano";

export interface PianoPresetConfig {
    id: string;
    label: string;
    description: string;
    settings: Partial<PianoSettings>;
}

export const PIANO_PRESETS: PianoPresetConfig[] = [
    {
        id: "ConcertGrand",
        label: "Concert Grand",
        description: "Full-bodied concert voicing with balanced resonance and natural Railsback stretch",
        settings: {
            preset: "ConcertGrand",
            soundboardResonance: 1.0,
            sympatheticCoupling: 1.0,
            hammerHardness: 1.0,
            inharmonicityScale: 1.0,
        },
    },
    {
        id: "StudioGrand",
        label: "Studio Grand",
        description: "Focused, controlled decay and tight unisons ideal for pop/jazz mixes",
        settings: {
            preset: "StudioGrand",
            soundboardResonance: 0.85,
            sympatheticCoupling: 0.75,
            hammerHardness: 1.1,
            inharmonicityScale: 0.95,
        },
    },
    {
        id: "BrightGrand",
        label: "Bright Grand",
        description: "Harder felt strike with prominent upper partials and cutting presence",
        settings: {
            preset: "BrightGrand",
            soundboardResonance: 1.1,
            sympatheticCoupling: 1.1,
            hammerHardness: 1.35,
            inharmonicityScale: 1.15,
        },
    },
    {
        id: "WarmGrand",
        label: "Warm Grand",
        description: "Soft felt compression, rich low-mid fundamentals and resonant soundboard wash",
        settings: {
            preset: "WarmGrand",
            soundboardResonance: 1.25,
            sympatheticCoupling: 1.2,
            hammerHardness: 0.8,
            inharmonicityScale: 0.9,
        },
    },
];

export function pianoPresetById(id: string): PianoPresetConfig | undefined {
    const norm = id.toLowerCase().replace(/[^a-z0-9]/g, "");
    return PIANO_PRESETS.find(p => p.id.toLowerCase().replace(/[^a-z0-9]/g, "") === norm);
}

export interface PianoSettings {
    /** The voicing preset chosen. */
    preset: string;
    /** 0..2: Soundboard modal resonance scaling. */
    soundboardResonance: number;
    /** 0..2: Sympathetic resonance coupling across open strings. */
    sympatheticCoupling: number;
    /** 0.5..2.0: Felt hammer hardness modifier. */
    hammerHardness: number;
    /** 0..3.0: Railsback string stiffness inharmonicity scaling. */
    inharmonicityScale: number;
    /** 0..1: Sustain pedal position (lifts dampers, activates full-harp sympathy). */
    sustainPedal: number;
    /** 0..1: Una corda soft pedal position (shifts hammer strike point). */
    unaCorda: number;
    /** How finely the piano runs live: "draft" (singlets), "live" (coupled unisons), "render" (full). */
    quality: ModelQuality;
    /** MIDI audition note for latching / test triggering (default 60 = C4). */
    auditionNote: number;
    /** Whether physics view (soundboard modes, hammer force, Railsback curve) is visible. */
    physicsView: boolean;
}

export function defaultPiano(preset = "ConcertGrand"): PianoSettings {
    const p = pianoPresetById(preset) ?? PIANO_PRESETS[0];
    return {
        preset: p.id,
        soundboardResonance: p.settings.soundboardResonance ?? 1.0,
        sympatheticCoupling: p.settings.sympatheticCoupling ?? 1.0,
        hammerHardness: p.settings.hammerHardness ?? 1.0,
        inharmonicityScale: p.settings.inharmonicityScale ?? 1.0,
        sustainPedal: 0,
        unaCorda: 0,
        quality: "live",
        auditionNote: 60,
        physicsView: false,
    };
}

const num = (v: unknown, fallback: number, lo: number, hi: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(hi, Math.max(lo, n));
};

/** A piano track's settings from whatever was saved: every field clamped, anything missing defaulted. */
export function repairPiano(saved: unknown): PianoSettings {
    const s: any = saved && typeof saved === "object" ? saved : {};
    const d = defaultPiano(typeof s.preset === "string" ? s.preset : undefined);
    return {
        preset: PIANO_PRESETS.some(p => p.id === s.preset) ? s.preset : d.preset,
        soundboardResonance: num(s.soundboardResonance, d.soundboardResonance, 0, 2),
        sympatheticCoupling: num(s.sympatheticCoupling, d.sympatheticCoupling, 0, 2),
        hammerHardness: num(s.hammerHardness, d.hammerHardness, 0.5, 2),
        inharmonicityScale: num(s.inharmonicityScale, d.inharmonicityScale, 0, 3),
        sustainPedal: num(s.sustainPedal, d.sustainPedal, 0, 1),
        unaCorda: num(s.unaCorda, d.unaCorda, 0, 1),
        quality: repairQuality(s.quality),
        auditionNote: Math.round(num(s.auditionNote, d.auditionNote, 21, 108)),
        physicsView: s.physicsView === true,
    };
}

/** Applies a voicing preset to the current settings. */
export function applyPreset(p: PianoSettings, id: string): boolean {
    const preset = pianoPresetById(id);
    if (!preset) return false;
    Object.assign(p, preset.settings);
    p.preset = preset.id;
    return true;
}

/** How long a sequenced piano note is held. With sustain pedal active, notes ring beyond step boundary. */
export function heldSeconds(p: PianoSettings, stepSeconds: number): number {
    return p.sustainPedal > 0.5 ? Math.max(stepSeconds * 1.5, stepSeconds + 0.3) : Math.max(0.05, stepSeconds * 0.95);
}

export interface PianoNote {
    trackId?: string;
    instrumentId: string;
    instrument: string;
    freq: number;
    velocity: number;
    gain: number;
    duration?: number;
    sustainPedal: number;
    unaCorda: number;
    preset: string;
    soundboardResonance: number;
    sympatheticCoupling: number;
    hammerHardness: number;
    inharmonicityScale: number;
    quality: string;
    startTime?: number;
}

/** Nominal master gain for grand piano notes before the track's mixer gain. */
export const PIANO_GAIN = 0.8;

/** The engine call for one note of a piano track. */
export function noteConfig(
    trackId: string,
    p: PianoSettings,
    note: { freq: number; velocity: number; duration?: number; startTime?: number },
): PianoNote {
    return {
        trackId,
        instrumentId: trackId,
        instrument: trackId,
        freq: note.freq,
        velocity: note.velocity,
        gain: PIANO_GAIN,
        sustainPedal: p.sustainPedal,
        unaCorda: p.unaCorda,
        preset: p.preset,
        soundboardResonance: p.soundboardResonance,
        sympatheticCoupling: p.sympatheticCoupling,
        hammerHardness: p.hammerHardness,
        inharmonicityScale: p.inharmonicityScale,
        quality: p.quality,
        ...(note.duration !== undefined ? { duration: note.duration } : {}),
        ...(note.startTime !== undefined ? { startTime: note.startTime } : {}),
    };
}

/** The bit of piano settings an AI tool reports. */
export function describeSettings(p: PianoSettings): Record<string, unknown> {
    return {
        preset: p.preset,
        soundboardResonance: p.soundboardResonance,
        sympatheticCoupling: p.sympatheticCoupling,
        hammerHardness: p.hammerHardness,
        inharmonicityScale: p.inharmonicityScale,
        sustainPedal: p.sustainPedal,
        unaCorda: p.unaCorda,
        quality: p.quality,
    };
}
