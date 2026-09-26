// The physically modeled drum kit in the DAW: what a kit track saves, how a saved one is repaired,
// the kit's rows (which piece each piano-roll row strikes, and where), the kit presets, and how a
// hit becomes an engine call. Pure, so it can be tested without a window.
//
// The engine (src/audio/matter/) builds the kit from its tunings, so there is no engine-side data to
// export or import here, only settings - as with the bowed string and the brass.

export const MATTER_WAVEFORM = "matter";

export type MatterPiece = "kick" | "snare" | "rack-tom" | "floor-tom" | "crash" | "ride" | "splash";
export const MATTER_PIECES: { id: MatterPiece; label: string; cymbal: boolean }[] = [
    { id: "kick", label: "Kick", cymbal: false },
    { id: "snare", label: "Snare", cymbal: false },
    { id: "rack-tom", label: "Rack tom", cymbal: false },
    { id: "floor-tom", label: "Floor tom", cymbal: false },
    { id: "crash", label: "Crash", cymbal: true },
    { id: "ride", label: "Ride", cymbal: true },
    { id: "splash", label: "Splash", cymbal: true },
];

export type MatterStriker = "stick" | "shoulder" | "felt" | "plastic" | "mallet" | "hard-mallet" | "yarn";

/** A row of a kit track: which piece it strikes, where (0 centre .. 1 edge), with what, and the
 *  General MIDI note it answers to. Kick at the top, like a drum track's pads. */
export interface MatterRow {
    id: string;
    label: string;
    piece: MatterPiece;
    position: number;
    /** A striker for this row only (the crash is played with the stick's shoulder); otherwise the
     *  kit's hands decide. */
    striker?: MatterStriker;
    note: number;
}

export const MATTER_ROWS: MatterRow[] = [
    { id: "kick", label: "Kick", piece: "kick", position: 0.25, note: 36 },
    { id: "snare", label: "Snare", piece: "snare", position: 0.3, note: 38 },
    // Near the rim the asymmetric modes ring: a thinner, ringier note.
    { id: "snare-edge", label: "Snare edge", piece: "snare", position: 0.82, note: 40 },
    { id: "rack-tom", label: "Rack tom", piece: "rack-tom", position: 0.35, note: 48 },
    { id: "floor-tom", label: "Floor tom", piece: "floor-tom", position: 0.35, note: 43 },
    { id: "crash", label: "Crash", piece: "crash", position: 0.92, striker: "shoulder", note: 49 },
    { id: "ride", label: "Ride", piece: "ride", position: 0.6, note: 51 },
    // Close to the centre: the long bending modes barely move there, a higher, glassier ping.
    { id: "ride-bell", label: "Ride bell", piece: "ride", position: 0.12, note: 53 },
    { id: "splash", label: "Splash", piece: "splash", position: 0.9, note: 55 },
];

/** The row a General MIDI drum note plays (the nearest thing the kit has), or -1. */
export function rowForNote(note: number): number {
    const exact = MATTER_ROWS.findIndex(r => r.note === note);
    if (exact >= 0) return exact;
    const gm: Record<number, string> = { 35: "kick", 37: "snare-edge", 39: "snare", 41: "floor-tom", 45: "rack-tom", 47: "rack-tom", 50: "rack-tom", 52: "crash", 57: "crash", 59: "ride" };
    return gm[note] ? MATTER_ROWS.findIndex(r => r.id === gm[note]) : -1;
}

export interface MatterKit {
    /** Batter-head fundamentals, Hz. */
    kick: number;
    snare: number;
    rackTom: number;
    floorTom: number;
    /** 0 an open kick .. 1 a pillow against the batter. */
    kickMuffling: number;
    snares: boolean;
    /** How hard the strainer presses the wires, N. */
    snareTension: number;
    /** Whether the pieces hear each other through the air. */
    sympathetic: boolean;
}

export type MatterHands = "sticks" | "mallets";

export interface MatterSettings {
    /** The preset last chosen (settings may have moved since). */
    preset: string;
    kit: MatterKit;
    /** Each piece's level in the kit's mix - the microphones. */
    mix: Record<MatterPiece, number>;
    hands: MatterHands;
    beater: "felt" | "plastic";
    /** The stick speed a full-velocity hit lands with, m/s. */
    dynamics: number;
    // Editor state.
    physicsView: boolean;
}

/** Microphone levels that bring the pieces near each other at the same stroke: the kick and the
 *  toms radiate far less than the snare for the same stick speed (measured peaks at 6 m/s: kick
 *  -15 dB, toms -18 to -21 dB, ride -27 dB against the snare), and a kit is mic'd to taste. */
export const DEFAULT_MIX: Record<MatterPiece, number> = { kick: 3, snare: 1, "rack-tom": 2, "floor-tom": 2.5, crash: 2, ride: 3, splash: 1.5 };

export const DEFAULT_KIT: MatterKit = { kick: 55, snare: 220, rackTom: 140, floorTom: 82, kickMuffling: 1, snares: true, snareTension: 0.15, sympathetic: true };

export interface MatterPreset {
    id: string;
    label: string;
    kit: Partial<MatterKit>;
    settings?: Partial<Omit<MatterSettings, "kit" | "mix" | "preset">>;
}

/** Kits people tune: settings of the drums and how they are played. */
export const MATTER_PRESETS: MatterPreset[] = [
    { id: "studio", label: "Studio", kit: { ...DEFAULT_KIT }, settings: { hands: "sticks", beater: "felt", dynamics: 6 } },
    // Small and high, open kick, snares a little loose: bebop.
    { id: "jazz", label: "Jazz", kit: { kick: 68, snare: 260, rackTom: 190, floorTom: 110, kickMuffling: 0.15, snares: true, snareTension: 0.1 }, settings: { hands: "sticks", beater: "felt", dynamics: 4 } },
    // Low and fat, a plastic beater, hit hard: the toms glide.
    { id: "rock", label: "Rock", kit: { kick: 48, snare: 190, rackTom: 115, floorTom: 70, kickMuffling: 1, snares: true, snareTension: 0.2 }, settings: { hands: "sticks", beater: "plastic", dynamics: 8 } },
    // A cranked, crisp snare with tight wires.
    { id: "funk", label: "Funk", kit: { kick: 60, snare: 320, rackTom: 170, floorTom: 100, kickMuffling: 0.8, snares: true, snareTension: 0.35 }, settings: { hands: "sticks", beater: "felt", dynamics: 5 } },
    // Felt mallets on the drums and yarn on the cymbals, snares off: swells and rolls.
    { id: "mallets", label: "Mallets", kit: { kick: 55, snare: 200, rackTom: 140, floorTom: 82, kickMuffling: 0.5, snares: false, snareTension: 0.15 }, settings: { hands: "mallets", beater: "felt", dynamics: 5 } },
];

export function matterPresetById(id: string): MatterPreset | undefined {
    return MATTER_PRESETS.find(p => p.id === id);
}

export function defaultMatter(): MatterSettings {
    return { preset: "studio", kit: { ...DEFAULT_KIT }, mix: { ...DEFAULT_MIX }, hands: "sticks", beater: "felt", dynamics: 6, physicsView: false };
}

const num = (v: unknown, fallback: number, lo: number, hi: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(hi, Math.max(lo, n));
};

/** The ranges the engine builds drums in (see `KitSpec::clamped`). */
export const KIT_RANGES: Record<"kick" | "snare" | "rackTom" | "floorTom" | "kickMuffling" | "snareTension", [number, number]> = {
    kick: [35, 90], snare: [140, 360], rackTom: [90, 260], floorTom: [55, 160], kickMuffling: [0, 1], snareTension: [0.03, 1.5],
};

function repairKit(saved: any): MatterKit {
    const s = saved && typeof saved === "object" ? saved : {};
    const d = DEFAULT_KIT;
    const r = KIT_RANGES;
    return {
        kick: num(s.kick, d.kick, ...r.kick),
        snare: num(s.snare, d.snare, ...r.snare),
        rackTom: num(s.rackTom, d.rackTom, ...r.rackTom),
        floorTom: num(s.floorTom, d.floorTom, ...r.floorTom),
        kickMuffling: num(s.kickMuffling, d.kickMuffling, ...r.kickMuffling),
        snares: typeof s.snares === "boolean" ? s.snares : d.snares,
        snareTension: num(s.snareTension, d.snareTension, ...r.snareTension),
        sympathetic: typeof s.sympathetic === "boolean" ? s.sympathetic : d.sympathetic,
    };
}

/** A kit track's settings from whatever was saved: every field clamped, anything missing defaulted. */
export function repairMatter(saved: unknown): MatterSettings {
    const s: any = saved && typeof saved === "object" ? saved : {};
    const d = defaultMatter();
    const mix = { ...DEFAULT_MIX };
    for (const p of MATTER_PIECES) mix[p.id] = num(s.mix?.[p.id], DEFAULT_MIX[p.id], 0, 8);
    return {
        preset: MATTER_PRESETS.some(p => p.id === s.preset) ? s.preset : d.preset,
        kit: repairKit(s.kit),
        mix,
        hands: s.hands === "mallets" ? "mallets" : "sticks",
        beater: s.beater === "plastic" ? "plastic" : "felt",
        dynamics: num(s.dynamics, d.dynamics, 1, 12),
        physicsView: s.physicsView === true,
    };
}

/** Loads a preset: its drums and how they are played. The mix stays (it is the room's). */
export function applyPreset(m: MatterSettings, id: string): boolean {
    const p = matterPresetById(id);
    if (!p) return false;
    m.kit = { ...DEFAULT_KIT, ...p.kit, sympathetic: m.kit.sympathetic };
    Object.assign(m, p.settings ?? {});
    m.preset = id;
    return true;
}

/** Whether two kits build the same drums (anything else is a rebuild, heard from the next hit). */
export function sameBuild(a: MatterKit, b: MatterKit): boolean {
    return a.kick === b.kick && a.snare === b.snare && a.rackTom === b.rackTom && a.floorTom === b.floorTom
        && a.kickMuffling === b.kickMuffling && a.snares === b.snares && a.snareTension === b.snareTension;
}

/** The stick's speed at impact for a note's velocity (0..1): from a ghost note's 0.4 m/s up to the
 *  kit's dynamics, evenly in loudness (the radiated level rises about with the speed). */
export function strikeSpeed(velocity: number, m: MatterSettings): number {
    const v = Math.min(1, Math.max(0, velocity));
    const lo = 0.4;
    const hi = Math.max(lo, m.dynamics);
    return lo * Math.pow(hi / lo, v);
}

/** What strikes a row's piece: the row's own striker, or the kit's hands (and beater). */
export function strikerFor(m: MatterSettings, row: MatterRow): MatterStriker {
    if (row.piece === "kick") return m.beater;
    const cymbal = MATTER_PIECES.find(p => p.id === row.piece)?.cymbal ?? false;
    if (m.hands === "mallets") return cymbal ? "yarn" : "mallet";
    return row.striker ?? "stick";
}

export interface MatterHit {
    trackId?: string;
    kitId: string;
    kit: MatterKit;
    mix: Record<MatterPiece, number>;
    piece: MatterPiece;
    speed: number;
    position: number;
    angle?: number;
    striker: MatterStriker;
    startTime?: number;
}

/** The engine call for one hit on a kit track. `kitId` is the track id, so every hit of the track
 *  lands on the same kit (and the pieces keep ringing and hearing each other). */
export function hitConfig(
    trackId: string,
    m: MatterSettings,
    hit: { row: number; velocity: number; startTime?: number } | { piece: MatterPiece; position: number; angle?: number; velocity: number; startTime?: number },
): MatterHit {
    let row: MatterRow;
    let position: number;
    let angle: number | undefined;
    if ("row" in hit) {
        row = MATTER_ROWS[Math.min(MATTER_ROWS.length - 1, Math.max(0, Math.round(hit.row)))];
        position = row.position;
    } else {
        row = MATTER_ROWS.find(r => r.piece === hit.piece) ?? MATTER_ROWS[0];
        position = hit.position;
        angle = hit.angle;
    }
    return {
        trackId,
        kitId: trackId,
        kit: { ...m.kit },
        mix: { ...m.mix },
        piece: row.piece,
        speed: strikeSpeed(hit.velocity, m),
        position: Math.min(1, Math.max(0, position)),
        ...(angle !== undefined ? { angle } : {}),
        striker: strikerFor(m, row),
        ...(hit.startTime !== undefined ? { startTime: hit.startTime } : {}),
    };
}

/** The bit of a track an AI tool reports. */
export function describeSettings(m: MatterSettings): Record<string, unknown> {
    return {
        preset: m.preset, ...m.kit, hands: m.hands, beater: m.beater, dynamics: m.dynamics, mix: { ...m.mix },
        rows: MATTER_ROWS.map((r, i) => ({ row: i, name: r.label, note: r.note })),
    };
}
