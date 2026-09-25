// The brass instrument's model in the DAW: what a brass track saves, how a saved one is repaired,
// the instruments, the playing styles, and how a note becomes an engine call. Pure, so it can be
// tested without a window.
//
// The engine (src/audio/brass/) builds the player and instrument from what each note carries, so
// there is no engine-side data to export or import here, only settings - as with the bowed string.

export const BRASS_WAVEFORM = "brass";

export type BrassArticulation = "tongued" | "legato" | "glissando";
export const BRASS_ARTICULATIONS: { id: BrassArticulation; label: string }[] = [
    { id: "tongued", label: "Tongued" },
    { id: "legato", label: "Legato" },
    { id: "glissando", label: "Gliss" },
];

export interface BrassInstrumentPreset {
    id: string;
    label: string;
    /** The notes the instrument plays in its normal range, MIDI. */
    range: [number, number];
    /** The note "Hold a note" plays when the instrument is chosen, and the keyboard's first key. */
    audition: number;
    firstKey: number;
    /** How the instrument is usually played (the engine's defaults, for the knobs to show): the hand
     *  in the bell (the horn's is), and which way the bell faces the listener. */
    hand: number;
    bellFacing: number;
}

/** The instruments the engine builds, each from its own bore (docs/PHYS_MOD_BRASS.md). The
 *  trombone has a slide; the others valves (the horn a double horn, with its F side). */
export const BRASS_INSTRUMENTS: BrassInstrumentPreset[] = [
    { id: "trombone", label: "Trombone", range: [40, 74], audition: 58, firstKey: 40, hand: 0, bellFacing: 0.55 },
    { id: "trumpet", label: "Trumpet", range: [54, 84], audition: 70, firstKey: 53, hand: 0, bellFacing: 0.6 },
    { id: "horn", label: "Horn", range: [41, 77], audition: 65, firstKey: 41, hand: 0.35, bellFacing: 0.15 },
    { id: "tuba", label: "Tuba", range: [28, 60], audition: 41, firstKey: 28, hand: 0, bellFacing: 0.35 },
];

export type BrassMute = "open" | "straight" | "cup" | "harmon";
export const BRASS_MUTES: { id: BrassMute; label: string }[] = [
    { id: "open", label: "Open" },
    { id: "straight", label: "Straight" },
    { id: "cup", label: "Cup" },
    { id: "harmon", label: "Harmon" },
];

export function brassInstrumentById(id: string): BrassInstrumentPreset | undefined {
    return BRASS_INSTRUMENTS.find(p => p.id === id);
}

/** A way of playing: settings of the player, not of the instrument. Choosing one keeps the
 *  instrument and changes how it is blown, tongued and slurred. */
export interface BrassStyle {
    id: string;
    label: string;
    settings: Partial<BrassSettings>;
}

export const BRASS_STYLES: BrassStyle[] = [
    // A soft, round chorale: little air, legato, no vibrato, a gentle "da".
    { id: "chorale", label: "Chorale", settings: { breath: 0.3, articulation: "legato", tongue: 0.02, vibratoDepth: 0, attackSkill: 1, lipTension: 0 } },
    // An ordinary mezzo section sound.
    { id: "section", label: "Section", settings: { breath: 0.5, articulation: "tongued", tongue: 0.004, vibratoDepth: 0, attackSkill: 1, lipTension: 0 } },
    // A fanfare: loud, crisp "ta" on every note.
    { id: "fanfare", label: "Fanfare", settings: { breath: 0.78, articulation: "tongued", tongue: 0.002, vibratoDepth: 0, attackSkill: 1, lipTension: 0 } },
    // As loud as the player can: the wavefront shocks and the tone blazes.
    { id: "blazing", label: "Blazing", settings: { breath: 0.95, articulation: "tongued", tongue: 0.002, vibratoDepth: 0, attackSkill: 1, lipTension: 0 } },
    // No tongue between notes: the slide is heard travelling.
    { id: "glissando", label: "Glissando", settings: { breath: 0.65, articulation: "glissando", slideTime: 0.3, vibratoDepth: 0, attackSkill: 1 } },
    // A rough player: loose attacks that crack and bloom, a little extra air noise.
    { id: "rough", label: "Rough", settings: { breath: 0.7, articulation: "tongued", attackSkill: 0.2, breathNoise: 0.35 } },
];

export function brassStyleById(id: string): BrassStyle | undefined {
    return BRASS_STYLES.find(s => s.id === id);
}

export interface BrassSettings {
    instrument: string;
    /** The playing style last chosen (settings may have moved since). */
    style: string;
    // The player.
    /** 0..1: mouth pressure, log from 0.5 to 16 kPa. */
    breath: number;
    /** -1..1: lips looser (fall to the partial below) or tighter (pop to the one above). */
    lipTension: number;
    /** 0..1: rest opening of the lips. */
    aperture: number;
    articulation: BrassArticulation;
    /** 0..1: at 1 notes speak at once; lower, attacks bloom and high notes crack. */
    attackSkill: number;
    /** Seconds for the tongue to release: a few ms is "ta", tens of ms "da". */
    tongue: number;
    release: number;
    vibratoRate: number;
    /** Cents (slide vibrato on the trombone). */
    vibratoDepth: number;
    vibratoDelay: number;
    /** Seconds for the slide to travel to a new position. */
    slideTime: number;
    breathNoise: number;
    /** The laboratory: the air's nonlinearity, 1 real air, 0 none. */
    brassiness: number;
    // The instrument's dress: these rebuild the air column, so they apply from the next note.
    mute: BrassMute;
    /** 0..1: how far the hand is in the bell (1 stops it); null, the instrument's usual. */
    hand: number | null;
    /** 0 (the bell away from the listener) .. 1 (at them); null, the instrument's usual. */
    bellFacing: number | null;
    // Editor state.
    auditionNote: number;
    physicsView: boolean;
}

export function defaultBrass(instrument = "trombone"): BrassSettings {
    const preset = brassInstrumentById(instrument) ?? BRASS_INSTRUMENTS[0];
    return {
        instrument: preset.id,
        style: "section",
        breath: 0.5,
        lipTension: 0,
        aperture: 0.5,
        articulation: "tongued",
        attackSkill: 1,
        tongue: 0.004,
        release: 0.08,
        vibratoRate: 5,
        vibratoDepth: 0,
        vibratoDelay: 0.3,
        slideTime: 0.07,
        breathNoise: 0.1,
        brassiness: 1,
        mute: "open",
        hand: null,
        bellFacing: null,
        auditionNote: preset.audition,
        physicsView: false,
    };
}

const num = (v: unknown, fallback: number, lo: number, hi: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(hi, Math.max(lo, n));
};

/** A brass track's settings from whatever was saved: every field clamped, anything missing
 *  defaulted (so songs saved before a field existed load with that field's default). */
export function repairBrass(saved: unknown): BrassSettings {
    const s: any = saved && typeof saved === "object" ? saved : {};
    const d = defaultBrass(typeof s.instrument === "string" ? s.instrument : undefined);
    return {
        instrument: d.instrument,
        style: BRASS_STYLES.some(x => x.id === s.style) ? s.style : d.style,
        breath: num(s.breath, d.breath, 0, 1),
        lipTension: num(s.lipTension, d.lipTension, -1, 1),
        aperture: num(s.aperture, d.aperture, 0, 1),
        articulation: BRASS_ARTICULATIONS.some(a => a.id === s.articulation) ? s.articulation : d.articulation,
        attackSkill: num(s.attackSkill, d.attackSkill, 0, 1),
        tongue: num(s.tongue, d.tongue, 0.001, 0.5),
        release: num(s.release, d.release, 0.005, 3),
        vibratoRate: num(s.vibratoRate, d.vibratoRate, 0, 12),
        vibratoDepth: num(s.vibratoDepth, d.vibratoDepth, 0, 100),
        vibratoDelay: num(s.vibratoDelay, d.vibratoDelay, 0, 2),
        slideTime: num(s.slideTime, d.slideTime, 0.005, 2),
        breathNoise: num(s.breathNoise, d.breathNoise, 0, 1),
        brassiness: num(s.brassiness, d.brassiness, 0, 4),
        mute: BRASS_MUTES.some(m => m.id === s.mute) ? s.mute : d.mute,
        hand: typeof s.hand === "number" && Number.isFinite(s.hand) ? num(s.hand, 0, 0, 1) : null,
        bellFacing: typeof s.bellFacing === "number" && Number.isFinite(s.bellFacing) ? num(s.bellFacing, 0, 0, 1) : null,
        auditionNote: Math.round(num(s.auditionNote, d.auditionNote, 24, 96)),
        physicsView: s.physicsView === true,
    };
}

/** Plays in a style: its player settings replace the current ones; the instrument stays. */
export function applyStyle(b: BrassSettings, id: string): boolean {
    const style = brassStyleById(id);
    if (!style) return false;
    Object.assign(b, style.settings);
    b.style = id;
    return true;
}

/** Switches the instrument, keeping the player's settings. The hand and the bell go back to the
 *  new instrument's usual (a horn player's hand is not a trumpeter's), and the audition note moves
 *  into its range. */
export function applyInstrument(b: BrassSettings, id: string): boolean {
    const preset = brassInstrumentById(id);
    if (!preset) return false;
    if (b.instrument !== id) {
        b.hand = null;
        b.bellFacing = null;
        if (b.auditionNote < preset.range[0] || b.auditionNote > preset.range[1]) b.auditionNote = preset.audition;
    }
    b.instrument = id;
    return true;
}

/** The hand and bell in effect: the track's own, or the instrument's usual. */
export function handAndBell(b: BrassSettings): { hand: number; bellFacing: number } {
    const preset = brassInstrumentById(b.instrument) ?? BRASS_INSTRUMENTS[0];
    return { hand: b.hand ?? preset.hand, bellFacing: b.bellFacing ?? preset.bellFacing };
}

/** Puts a mute in the bell (or takes it out). */
export function applyMute(b: BrassSettings, id: string): boolean {
    if (!BRASS_MUTES.some(m => m.id === id)) return false;
    b.mute = id as BrassMute;
    return true;
}

/** How long a sequenced note is held. A tongued note leaves a small gap before the next, so the
 *  tongue stops the air between them; a legato or glissando note overlaps the next a little, so the
 *  one player slurs into it, as a brass player joins notes. */
export function heldSeconds(b: BrassSettings, stepSeconds: number): number {
    return b.articulation === "tongued" ? Math.max(0.03, stepSeconds * 0.95) : stepSeconds + 0.03;
}

export interface BrassNote {
    trackId?: string;
    instrumentId: string;
    instrument: string;
    freq: number;
    velocity: number;
    gain: number;
    breath: number;
    lipTension: number;
    aperture: number;
    articulation: BrassArticulation;
    attackSkill: number;
    attack: number;
    release: number;
    vibratoRate: number;
    vibratoDepth: number;
    vibratoDelay: number;
    slideTime: number;
    breathNoise: number;
    brassiness: number;
    mute: BrassMute;
    hand?: number;
    bellFacing?: number;
    duration?: number;
    startTime?: number;
}

/** How loud a brass voice is at full velocity, before the track's own gain. */
export const BRASS_GAIN = 0.7;

/** The engine call for one note of a brass track. `instrumentId` is the track id, so every note of
 *  the track is played by the same player (and slurs on it). */
export function noteConfig(
    trackId: string,
    b: BrassSettings,
    note: { freq: number; velocity: number; duration?: number; startTime?: number },
): BrassNote {
    return {
        trackId,
        instrumentId: trackId,
        instrument: b.instrument,
        freq: note.freq,
        velocity: note.velocity,
        gain: BRASS_GAIN,
        breath: b.breath,
        lipTension: b.lipTension,
        aperture: b.aperture,
        articulation: b.articulation,
        attackSkill: b.attackSkill,
        attack: b.tongue,
        release: b.release,
        vibratoRate: b.vibratoRate,
        vibratoDepth: b.vibratoDepth,
        vibratoDelay: b.vibratoDelay,
        slideTime: b.slideTime,
        breathNoise: b.breathNoise,
        brassiness: b.brassiness,
        mute: b.mute,
        ...(b.hand !== null ? { hand: b.hand } : {}),
        ...(b.bellFacing !== null ? { bellFacing: b.bellFacing } : {}),
        ...(note.duration !== undefined ? { duration: note.duration } : {}),
        ...(note.startTime !== undefined ? { startTime: note.startTime } : {}),
    };
}

/** A pitch bend (cents) that puts the slide at `position` (1..7) for a note whose own position is
 *  `notePosition`: a semitone per position, down as the slide goes out. */
export function bendForSlide(position: number, notePosition: number): number {
    return -100 * (position - notePosition);
}

/** The bit of a track an AI tool reports. */
export function describeSettings(b: BrassSettings): Record<string, unknown> {
    return {
        instrument: b.instrument, style: b.style, breath: b.breath, lipTension: b.lipTension, aperture: b.aperture,
        articulation: b.articulation, attackSkill: b.attackSkill, tongue: b.tongue, release: b.release,
        vibratoRate: b.vibratoRate, vibratoDepth: b.vibratoDepth, vibratoDelay: b.vibratoDelay,
        slideTime: b.slideTime, breathNoise: b.breathNoise, brassiness: b.brassiness,
        mute: b.mute, hand: b.hand ?? "usual", bellFacing: b.bellFacing ?? "usual",
    };
}
