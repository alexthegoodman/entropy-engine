// The bowed-string instrument's model: what a physmod track saves, how a saved one is repaired, the
// instrument presets (real and invented), the continuous violin-to-bass morph, and how a note
// becomes an engine call. Pure, so it can be tested without a window.
//
// The engine (src/audio/physmod/) builds the instrument from what each note carries - string
// tuning, body, rosin, coupling - so there is still no engine-side data to export or import here,
// only settings.

export const PHYSMOD_WAVEFORM = "physmod";

export type PhysModArticulation = "arco" | "pizzicato" | "colLegno";
export const PHYSMOD_ARTICULATIONS: { id: PhysModArticulation; label: string }[] = [
    { id: "arco", label: "Arco" },
    { id: "pizzicato", label: "Pizz." },
    { id: "colLegno", label: "Col legno" },
];

/** Construction settings a preset may set beyond tuning and size - the "instrument laboratory". */
export interface PhysModConstruction {
    stringMass?: number;
    stiffness?: number;
    brightness?: number;
    rosin?: number;
    coupling?: number;
    bodyResonance?: number;
    bodyMix?: number;
}

export interface PhysModInstrumentPreset {
    id: string;
    label: string;
    /** Open-string frequencies, low to high (up to 4). */
    strings: number[];
    /** Instrument size: 0 violin, ~0.13 viola, ~0.72 cello, 1 bass (the body's resonances scale as
     *  4^-size). Beyond 0..1 is the laboratory. */
    bodySize: number;
    /** Unbowed strings that ring in sympathy (up to 6). */
    sympathetic?: number[];
    /** Anything else this instrument is built differently in. */
    construction?: PhysModConstruction;
    /** An invented instrument rather than a real one. */
    invented?: boolean;
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** Equal-tempered (A4 = 440 Hz) tunings of the orchestral family, plus a few instruments that
 *  exist mostly (or only) in this laboratory. */
export const PHYSMOD_INSTRUMENT_PRESETS: PhysModInstrumentPreset[] = [
    { id: "violin", label: "Violin", strings: [196.0, 293.66, 440.0, 659.25], bodySize: 0.0 },
    { id: "viola", label: "Viola", strings: [130.81, 196.0, 293.66, 440.0], bodySize: 0.13 },
    { id: "cello", label: "Cello", strings: [65.41, 98.0, 146.83, 220.0], bodySize: 0.72 },
    { id: "bass", label: "Bass", strings: [41.2, 55.0, 73.42, 98.0], bodySize: 1.0 },
    // Real, if rare: a Hardanger fiddle's understrings ring along with the melody (D major here).
    { id: "hardanger", label: "Hardanger", strings: [220.0, 293.66, 440.0, 659.25], bodySize: -0.05, sympathetic: [hz(74), hz(76), hz(78), hz(81), hz(83)], construction: { coupling: 0.55 } },
    // Invented: a violin-sized body with steel-bar strings - bright, glassy, stretched partials.
    { id: "glass", label: "Glass violin", strings: [196.0, 293.66, 440.0, 659.25], bodySize: -0.5, invented: true, construction: { stiffness: 0.7, brightness: 0.95, bodyResonance: 0.85, stringMass: 0.3 } },
    // Invented: a bass an octave below the bass, on a body four times its size, heavy strings.
    { id: "octobass", label: "Octobass", strings: [20.6, 27.5, 36.7, 49.0], bodySize: 1.8, invented: true, construction: { stringMass: 0.8, brightness: 0.35, coupling: 0.5 } },
    // Invented: a cello whose bridge couples everything to everything - sympathy and wolves.
    { id: "wolfcello", label: "Wolf cello", strings: [65.41, 98.0, 146.83, 220.0], bodySize: 0.72, sympathetic: [98.0, 146.83, 196.0, 220.0], invented: true, construction: { coupling: 0.95, bodyResonance: 0.8 } },
];

export function instrumentPresetById(id: string): PhysModInstrumentPreset | undefined {
    return PHYSMOD_INSTRUMENT_PRESETS.find(p => p.id === id);
}

// The four orchestral instruments as points along the size axis, for the morph.
const FAMILY = ["violin", "viola", "cello", "bass"].map(id => instrumentPresetById(id)!);

/** Open strings for an instrument of any size, interpolated (in pitch) between the orchestral
 *  family's tunings along the body-size axis and extrapolated past violin and bass - the
 *  continuous violin -> viola -> cello -> bass dimension, and beyond it in both directions. */
export function stringsForSize(size: number): number[] {
    let i = 0;
    while (i < FAMILY.length - 2 && size > FAMILY[i + 1].bodySize) i++;
    const a = FAMILY[i], b = FAMILY[i + 1];
    const t = (size - a.bodySize) / (b.bodySize - a.bodySize);
    return a.strings.map((fa, k) => Math.exp(Math.log(fa) + (Math.log(b.strings[k]) - Math.log(fa)) * t));
}

/** The string (0 = lowest) a player would choose to reach `freq`: the highest open string at or
 *  below it. Below every open string, the lowest string. (The engine makes the same choice, and
 *  also handles double stops and slurs; this is for highlighting before anything has sounded.) */
export function stringForFreq(strings: number[], freq: number): number {
    let choice = 0;
    for (let i = 0; i < strings.length; i++) {
        if (strings[i] <= freq * 1.0005) choice = i;
    }
    return choice;
}

export const PHYSMOD_TOOLS = ["orbit"] as const;

export interface PhysModSettings {
    /** The preset the tuning and construction started from. */
    instrument: string;
    // The bow.
    bowForce: number;
    bowVelocity: number;
    /** 0.02..0.5, fraction of the vibrating length from the bridge. */
    bowPosition: number;
    articulation: PhysModArticulation;
    /** 0..1, how cleanly a stroke starts (a player's skill at the attack). */
    attackSkill: number;
    // The left hand.
    vibratoRate: number;
    vibratoDepth: number;
    vibratoDelay: number;
    /** Seconds for a slurred note's finger to slide. */
    slide: number;
    // The strings.
    damping: number;
    brightness: number;
    /** 0..1, how freely a released note rings on. */
    ring: number;
    stringMass: number;
    stiffness: number;
    rosin: number;
    bowNoise: number;
    // The body.
    bodySize: number;
    bodyMix: number;
    bodyResonance: number;
    coupling: number;
    /** Which "maker's" instrument: picks the body's high-frequency modes. */
    bodySeed: number;
    /** Unbowed strings ringing in sympathy. */
    sympathetic: number[];
    /** When on, the open-string tuning follows the size knob (the violin-to-bass morph); when off,
     *  the preset's tuning stays and only the body changes. */
    tuningFollowsSize: boolean;
    // Editor state.
    audition: boolean;
    /** MIDI note the audition and the Hold button play. */
    auditionNote: number;
    physicsView: boolean;
}

export function defaultPhysMod(instrument = "violin"): PhysModSettings {
    const preset = instrumentPresetById(instrument) ?? PHYSMOD_INSTRUMENT_PRESETS[0];
    const c = preset.construction ?? {};
    return {
        instrument: preset.id,
        bowForce: 0.5,
        bowVelocity: 0.5,
        bowPosition: 0.12,
        articulation: "arco",
        attackSkill: 0.9,
        vibratoRate: 5.5,
        vibratoDepth: 15.0,
        vibratoDelay: 0.15,
        slide: 0.06,
        damping: 0.0,
        brightness: c.brightness ?? 0.5,
        ring: 0.35,
        stringMass: c.stringMass ?? 0.5,
        stiffness: c.stiffness ?? 0.0,
        rosin: c.rosin ?? 0.5,
        bowNoise: 0.15,
        bodySize: preset.bodySize,
        bodyMix: c.bodyMix ?? 0.85,
        bodyResonance: c.bodyResonance ?? 0.5,
        coupling: c.coupling ?? 0.35,
        bodySeed: 1,
        sympathetic: [...(preset.sympathetic ?? [])],
        tuningFollowsSize: false,
        audition: true,
        auditionNote: 60,
        physicsView: false,
    };
}

const num = (v: unknown, fallback: number, lo: number, hi: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(hi, Math.max(lo, n));
};

/** A physmod track's settings from whatever was saved: every field clamped, anything missing
 *  defaulted (so songs saved before a field existed load with that field's default). */
export function repairPhysMod(saved: unknown): PhysModSettings {
    const s: any = saved && typeof saved === "object" ? saved : {};
    const instrument = PHYSMOD_INSTRUMENT_PRESETS.some(p => p.id === s.instrument) ? s.instrument : "violin";
    const d = defaultPhysMod(instrument);
    const articulation = PHYSMOD_ARTICULATIONS.some(a => a.id === s.articulation) ? s.articulation : d.articulation;
    const sympathetic = Array.isArray(s.sympathetic)
        ? s.sympathetic.filter((f: unknown) => typeof f === "number" && Number.isFinite(f) && f > 0).slice(0, 6).map((f: number) => num(f, 0, 12, 5000))
        : d.sympathetic;
    return {
        instrument,
        bowForce: num(s.bowForce, d.bowForce, 0, 1),
        bowVelocity: num(s.bowVelocity, d.bowVelocity, 0, 1),
        bowPosition: num(s.bowPosition, d.bowPosition, 0.02, 0.5),
        articulation,
        attackSkill: num(s.attackSkill, d.attackSkill, 0, 1),
        vibratoRate: num(s.vibratoRate, d.vibratoRate, 0, 12),
        vibratoDepth: num(s.vibratoDepth, d.vibratoDepth, 0, 100),
        vibratoDelay: num(s.vibratoDelay, d.vibratoDelay, 0, 2),
        slide: num(s.slide, d.slide, 0, 1),
        damping: num(s.damping, d.damping, 0, 1),
        brightness: num(s.brightness, d.brightness, 0, 1),
        ring: num(s.ring, d.ring, 0, 1),
        stringMass: num(s.stringMass, d.stringMass, 0, 1),
        stiffness: num(s.stiffness, d.stiffness, 0, 1),
        rosin: num(s.rosin, d.rosin, 0, 1),
        bowNoise: num(s.bowNoise, d.bowNoise, 0, 1),
        bodySize: num(s.bodySize, d.bodySize, -1, 2.5),
        bodyMix: num(s.bodyMix, d.bodyMix, 0, 1),
        bodyResonance: num(s.bodyResonance, d.bodyResonance, 0, 1),
        coupling: num(s.coupling, d.coupling, 0, 1),
        bodySeed: Math.round(num(s.bodySeed, d.bodySeed, 0, 2 ** 31)),
        sympathetic,
        tuningFollowsSize: s.tuningFollowsSize === true,
        audition: s.audition === undefined ? d.audition : s.audition === true,
        auditionNote: Math.round(num(s.auditionNote, d.auditionNote, 24, 96)),
        physicsView: s.physicsView === true,
    };
}

/** Switches a track to a preset: its tuning, size and construction, keeping the player's bow and
 *  hand settings (so trying instruments keeps the same playing). */
export function applyPreset(pm: PhysModSettings, id: string): boolean {
    const preset = instrumentPresetById(id);
    if (!preset) return false;
    const d = defaultPhysMod(id);
    pm.instrument = id;
    pm.bodySize = d.bodySize;
    pm.sympathetic = d.sympathetic;
    pm.stringMass = d.stringMass;
    pm.stiffness = d.stiffness;
    pm.brightness = d.brightness;
    pm.rosin = d.rosin;
    pm.coupling = d.coupling;
    pm.bodyResonance = d.bodyResonance;
    pm.bodyMix = d.bodyMix;
    pm.tuningFollowsSize = false;
    return true;
}

/** The open strings a track's notes are played on. */
export function openStrings(pm: PhysModSettings): number[] {
    if (pm.tuningFollowsSize) return stringsForSize(pm.bodySize);
    return (instrumentPresetById(pm.instrument) ?? PHYSMOD_INSTRUMENT_PRESETS[0]).strings;
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
    articulation: PhysModArticulation;
    attackSkill: number;
    vibratoRate: number;
    vibratoDepth: number;
    vibratoDelay: number;
    slide: number;
    damping: number;
    brightness: number;
    ring: number;
    stringMass: number;
    stiffness: number;
    rosin: number;
    bowNoise: number;
    bodySize: number;
    bodyMix: number;
    bodyResonance: number;
    coupling: number;
    bodySeed: number;
    strings: number[];
    sympathetic: number[];
    attack: number;
    release: number;
    duration?: number;
    startTime?: number;
}

/** How loud a bowed-string voice is at full velocity, before the track's own gain. */
export const PHYSMOD_GAIN = 0.7;

/** The engine call for one note of a physmod track. `instrument` is the track id, so every note of
 *  the track plays the same instrument (and slurs, double-stops and rings in sympathy on it). */
export function noteConfig(
    trackId: string,
    pm: PhysModSettings,
    note: { freq: number; velocity: number; duration?: number; startTime?: number },
): PhysModNote {
    return {
        trackId,
        instrument: trackId,
        freq: note.freq,
        velocity: note.velocity,
        gain: PHYSMOD_GAIN,
        bowForce: pm.bowForce,
        bowVelocity: pm.bowVelocity,
        bowPosition: pm.bowPosition,
        articulation: pm.articulation,
        attackSkill: pm.attackSkill,
        vibratoRate: pm.vibratoRate,
        vibratoDepth: pm.vibratoDepth,
        vibratoDelay: pm.vibratoDelay,
        slide: pm.slide,
        damping: pm.damping,
        brightness: pm.brightness,
        ring: pm.ring,
        stringMass: pm.stringMass,
        stiffness: pm.stiffness,
        rosin: pm.rosin,
        bowNoise: pm.bowNoise,
        bodySize: pm.bodySize,
        bodyMix: pm.bodyMix,
        bodyResonance: pm.bodyResonance,
        coupling: pm.coupling,
        bodySeed: pm.bodySeed,
        strings: openStrings(pm),
        sympathetic: pm.sympathetic,
        attack: 0.06,
        release: 0.15,
        ...(note.duration !== undefined ? { duration: note.duration } : {}),
        ...(note.startTime !== undefined ? { startTime: note.startTime } : {}),
    };
}

/** The bit of a track an AI tool reports: enough to describe it without repeating every field. */
export function describeSettings(pm: PhysModSettings): Record<string, unknown> {
    return {
        instrument: pm.instrument, strings: openStrings(pm).map(f => Math.round(f * 100) / 100),
        articulation: pm.articulation, bowForce: pm.bowForce, bowVelocity: pm.bowVelocity, bowPosition: pm.bowPosition,
        vibratoRate: pm.vibratoRate, vibratoDepth: pm.vibratoDepth, damping: pm.damping, brightness: pm.brightness,
        ring: pm.ring, stringMass: pm.stringMass, stiffness: pm.stiffness, rosin: pm.rosin,
        bodySize: pm.bodySize, bodyMix: pm.bodyMix, bodyResonance: pm.bodyResonance, coupling: pm.coupling,
        sympathetic: pm.sympathetic, tuningFollowsSize: pm.tuningFollowsSize,
    };
}
