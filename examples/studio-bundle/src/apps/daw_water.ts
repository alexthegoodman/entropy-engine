// Water in the DAW: what a water track saves, how a saved one is repaired, its presets, and how a
// note becomes an engine call. Pure, so it can be tested without a window.
//
// A water track plays one of four ways. Three are pitched and use the track's scale like any synth
// track: a glass harp (each note struck on a glass its water tunes to the note), drips (each note
// the drop whose bubble rings at it), and fills (each note a bottle filling, its air column rising
// a fifth to the note over the note's length). The fourth is weather: its rows are rain, a brook,
// surf and a sloshing tub, held for as long as the note lasts. The physics is the engine's
// (src/audio/matter/water_voice.rs); nothing here is a sample.

export const WATER_WAVEFORM = "water";

export type WaterPlay = "glass" | "drip" | "fill" | "weather";
export const WATER_PLAYS: { id: WaterPlay; label: string; pitched: boolean }[] = [
    { id: "glass", label: "Glass harp", pitched: true },
    { id: "drip", label: "Drips", pitched: true },
    { id: "fill", label: "Fills", pitched: true },
    { id: "weather", label: "Weather", pitched: false },
];

export type WaterSource = "drip" | "glass" | "fill" | "rain" | "brook" | "surf" | "slosh";
export const WATER_SOURCES: { id: WaterSource; label: string }[] = [
    { id: "drip", label: "Drips" },
    { id: "glass", label: "Glass" },
    { id: "fill", label: "Fills" },
    { id: "rain", label: "Rain" },
    { id: "brook", label: "Brook" },
    { id: "surf", label: "Surf" },
    { id: "slosh", label: "Slosh" },
];

/** What rain falls on: every one is a different body, so it sounds different. */
export type RainSurface = "lake" | "window" | "roof" | "tent" | "cymbal" | "drum";
export const RAIN_SURFACES: { id: RainSurface; label: string }[] = [
    { id: "lake", label: "Lake" },
    { id: "window", label: "Window" },
    { id: "roof", label: "Tin roof" },
    { id: "tent", label: "Tent" },
    { id: "cymbal", label: "Cymbal" },
    { id: "drum", label: "Drum" },
];

/** What fills pour into (scaled to each note). */
export type WaterVessel = "bottle" | "vase" | "jug";
export const WATER_VESSELS: { id: WaterVessel; label: string }[] = [
    { id: "bottle", label: "Bottle" },
    { id: "vase", label: "Vase" },
    { id: "jug", label: "Jug" },
];

/** A row of a weather track: what it holds for the length of the note, and its General MIDI
 *  sound-effect note. */
export interface WeatherRow {
    id: "rain" | "brook" | "surf" | "slosh";
    label: string;
    note: number;
}

export const WEATHER_ROWS: WeatherRow[] = [
    { id: "rain", label: "Rain", note: 60 },
    { id: "brook", label: "Brook", note: 62 },
    { id: "surf", label: "Surf", note: 64 },
    { id: "slosh", label: "Slosh", note: 65 },
];

/** How many rows a pitched water track gets back when it leaves weather (a synth track's default). */
export const PITCHED_ROWS = 10;

export interface WaterSettings {
    /** The preset last chosen (settings may have moved since). */
    preset: string;
    play: WaterPlay;
    rain: RainSurface;
    vessel: WaterVessel;
    /** Glasses struck with a spoon rather than a soft mallet: brighter, a ringing overtone. */
    spoon: boolean;
    /** How hard a full-velocity note plays, 0..1 (a quiet note is always gentle). */
    dynamics: number;
    /** Each source's level - the microphones. */
    mix: Record<WaterSource, number>;
    // Editor state.
    physicsView: boolean;
}

/** The engine's measured default microphones (see water_voice.rs's DEFAULT_MIX): drips are a few
 *  hundredths of a pascal where a mallet on a glass is tenths, so each is brought near the others. */
export const DEFAULT_MIX: Record<WaterSource, number> = { drip: 5, glass: 1.5, fill: 4, rain: 1, brook: 0.7, surf: 0.5, slosh: 0.5 };

export interface WaterPreset {
    id: string;
    label: string;
    settings: Partial<Omit<WaterSettings, "mix" | "preset" | "physicsView">>;
}

export const WATER_PRESETS: WaterPreset[] = [
    { id: "glass-harp", label: "Glass harp", settings: { play: "glass", spoon: false, dynamics: 0.7 } },
    { id: "spoon-glasses", label: "Spoon on glasses", settings: { play: "glass", spoon: true, dynamics: 0.6 } },
    { id: "drips", label: "Drips", settings: { play: "drip", dynamics: 0.8 } },
    { id: "bottles", label: "Filling bottles", settings: { play: "fill", vessel: "bottle", dynamics: 0.8 } },
    { id: "vases", label: "Filling vases", settings: { play: "fill", vessel: "vase", dynamics: 0.8 } },
    { id: "lakeside", label: "Lakeside", settings: { play: "weather", rain: "lake", dynamics: 0.7 } },
    { id: "tent", label: "Rain on a tent", settings: { play: "weather", rain: "tent", dynamics: 0.6 } },
    { id: "tin-roof", label: "Tin roof", settings: { play: "weather", rain: "roof", dynamics: 0.8 } },
    { id: "window", label: "Rain on the window", settings: { play: "weather", rain: "window", dynamics: 0.7 } },
    { id: "cymbal-rain", label: "Rain on a cymbal", settings: { play: "weather", rain: "cymbal", dynamics: 0.7 } },
];

export function waterPresetById(id: string): WaterPreset | undefined {
    return WATER_PRESETS.find(p => p.id === id);
}

export function defaultWater(): WaterSettings {
    return { preset: "glass-harp", play: "glass", rain: "lake", vessel: "bottle", spoon: false, dynamics: 0.7, mix: { ...DEFAULT_MIX }, physicsView: false };
}

const num = (v: unknown, fallback: number, lo: number, hi: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(hi, Math.max(lo, n));
};

const oneOf = <T extends string>(v: unknown, options: readonly { id: T }[], fallback: T): T =>
    options.some(o => o.id === v) ? v as T : fallback;

/** A water track's settings from whatever was saved: every field checked, anything missing defaulted. */
export function repairWater(saved: unknown): WaterSettings {
    const s: any = saved && typeof saved === "object" ? saved : {};
    const d = defaultWater();
    const mix = { ...DEFAULT_MIX };
    for (const src of WATER_SOURCES) mix[src.id] = num(s.mix?.[src.id], DEFAULT_MIX[src.id], 0, 32);
    return {
        preset: WATER_PRESETS.some(p => p.id === s.preset) ? s.preset : d.preset,
        play: oneOf(s.play, WATER_PLAYS, d.play),
        rain: oneOf(s.rain, RAIN_SURFACES, d.rain),
        vessel: oneOf(s.vessel, WATER_VESSELS, d.vessel),
        spoon: s.spoon === true,
        dynamics: num(s.dynamics, d.dynamics, 0, 1),
        mix,
        physicsView: s.physicsView === true,
    };
}

/** Loads a preset: how the track plays and what its rain falls on. The mix stays (it is the room's). */
export function applyPreset(w: WaterSettings, id: string): boolean {
    const p = waterPresetById(id);
    if (!p) return false;
    Object.assign(w, p.settings);
    w.preset = id;
    return true;
}

/** Whether two settings build the same water (only the rain's surface is built; everything else
 *  is chosen per note). */
export function sameBuild(a: WaterSettings, b: WaterSettings): boolean {
    return a.rain === b.rain;
}

export function isPitched(w: WaterSettings): boolean {
    return w.play !== "weather";
}

/** The rows a track of these settings has: the weather's, or `null` for the scale's own. */
export function rowsFor(w: WaterSettings): WeatherRow[] | null {
    return isPitched(w) ? null : WEATHER_ROWS;
}

/** A value from `lo` (velocity 0) to `hi` (velocity 1 at full dynamics), evenly in ratio - evenly
 *  in loudness, as every one of these grows the sound about as a power of itself. */
function span(velocity: number, dynamics: number, lo: number, hi: number): number {
    const v = Math.min(1, Math.max(0, velocity)) * (0.25 + 0.75 * Math.min(1, Math.max(0, dynamics)));
    return lo * Math.pow(hi / lo, v);
}

/** The glass striker's speed, m/s: a soft mallet from 5 cm/s to a metre a second; a spoon, whose
 *  contact is so much stiffer, from 1 to 8 cm/s. */
export function glassSpeed(velocity: number, w: WaterSettings): number {
    return w.spoon ? span(velocity, w.dynamics, 0.01, 0.08) : span(velocity, w.dynamics, 0.05, 1.0);
}

/** Rain rate, mm/h: a drizzle at 0.5 to a downpour at 80. */
export function rainRate(velocity: number, w: WaterSettings): number {
    return span(velocity, w.dynamics, 0.5, 80);
}

/** The brook's speed, m/s. */
export function brookSpeed(velocity: number, w: WaterSettings): number {
    return span(velocity, w.dynamics, 0.15, 1.0);
}

/** The surf's wave height, m. */
export function surfHeight(velocity: number, w: WaterSettings): number {
    return span(velocity, w.dynamics, 0.3, 2.0);
}

/** How hard the tub is shaken (1: about as hard as it takes to slop over). */
export function sloshStrength(velocity: number, w: WaterSettings): number {
    return span(velocity, w.dynamics, 0.3, 1.3);
}

/** Where a drip lands across the basin, -1..1: low notes to the left, high to the right. */
export function dripPan(freq: number): number {
    const midi = 69 + 12 * Math.log2(Math.max(1, freq) / 440);
    return Math.min(0.8, Math.max(-0.8, (midi - 72) / 24));
}

export interface WaterNote {
    trackId?: string;
    waterId: string;
    water: { rain: RainSurface; vessel: WaterVessel };
    mix: Record<WaterSource, number>;
    action: WaterSource;
    pitch?: number;
    speed?: number;
    spoon?: boolean;
    x?: number;
    rate?: number;
    height?: number;
    strength?: number;
    duration?: number;
    startTime?: number;
}

/** The engine call for one note on a water track. `waterId` is the track id, so every note of the
 *  track plays on the same water (glasses ring on, the rain keeps falling). A pitched play takes
 *  the note's `freq`; weather takes its `row`. */
export function noteConfig(
    trackId: string,
    w: WaterSettings,
    note: { freq?: number; row?: number; velocity: number; duration?: number; startTime?: number },
): WaterNote {
    const base = {
        trackId, waterId: trackId, water: { rain: w.rain, vessel: w.vessel }, mix: { ...w.mix },
        ...(note.startTime !== undefined ? { startTime: note.startTime } : {}),
    };
    const duration = Math.min(600, Math.max(0.05, typeof note.duration === "number" && Number.isFinite(note.duration) ? note.duration : 0.5));
    const v = note.velocity;
    if (w.play === "weather") {
        const row = WEATHER_ROWS[Math.min(WEATHER_ROWS.length - 1, Math.max(0, Math.round(note.row ?? 0)))];
        switch (row.id) {
            case "rain": return { ...base, action: "rain", rate: rainRate(v, w), duration };
            case "brook": return { ...base, action: "brook", speed: brookSpeed(v, w), duration };
            case "surf": return { ...base, action: "surf", height: surfHeight(v, w), duration };
            case "slosh": return { ...base, action: "slosh", strength: sloshStrength(v, w), duration };
        }
    }
    const pitch = Math.min(12000, Math.max(40, note.freq ?? 523.25));
    switch (w.play) {
        case "drip": return { ...base, action: "drip", pitch, x: dripPan(pitch) };
        case "fill": return { ...base, action: "fill", pitch, duration: Math.max(0.2, duration) };
        default: return { ...base, action: "glass", pitch, speed: glassSpeed(v, w), spoon: w.spoon };
    }
}

// --- The Water view (entropy_gui::WaterView) --------------------------------------------------
//
// The window draws the track's water from the engine's own state, and it can be played: a click
// on the basin drops a drip there, on a glass strikes it, on a vessel fills it to a note; a press
// held on the rain, the brook, the beach or the tub keeps it going. Whatever the track plays, each
// of these plays as itself (a drip is a drip on a glass-harp track), on the track's scale.

/** How long one press held on the rain, the brook, the beach or the tub keeps it going, s. The
 *  view sends it again every 0.12 s while it is held (see WaterView's HOLD_SECONDS). */
export const VIEW_HOLD_SECONDS = 0.35;
/** Glasses in the engine's rack (water_voice.rs's GLASSES), left to right in the view. */
export const RACK_GLASSES = 8;
/** How long a vessel clicked in the view pours, s. */
export const VIEW_FILL_SECONDS = 2;

/** What the view asked for. */
export type WaterViewAction =
    | { kind: "drip"; x: number; velocity: number }
    | { kind: "glass"; index: number; pitch: number; velocity: number }
    | { kind: "fill"; height: number; velocity: number }
    | { kind: "hold"; source: WaterSource; velocity: number };

/** A fraction `0..1` as one of `rows` scale rows (0 the lowest). */
export function viewRow(fraction: number, rows: number): number {
    const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    return Math.min(rows - 1, Math.max(0, Math.round(f * (rows - 1))));
}

/** The engine call for something clicked in the Water view, or `null` for nothing to play.
 *  `freqOfRow` gives a scale row's pitch, `rows` how many scale rows there are: left to right
 *  across the basin and up a vessel go up the scale, as an empty glass's place in the rack does. */
export function viewNoteConfig(
    trackId: string,
    w: WaterSettings,
    a: WaterViewAction,
    freqOfRow: (row: number) => number,
    rows: number,
): WaterNote | null {
    const as = (play: WaterPlay): WaterSettings => ({ ...w, play });
    const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.7));
    switch (a.kind) {
        case "drip": {
            const x = Math.min(1, Math.max(-1, Number.isFinite(a.x) ? a.x : 0));
            const freq = freqOfRow(viewRow((x + 1) / 2, rows));
            return { ...noteConfig(trackId, as("drip"), { freq, velocity: clamp01(a.velocity) }), x };
        }
        case "glass": {
            const freq = a.pitch > 0 ? a.pitch : freqOfRow(viewRow(a.index / (RACK_GLASSES - 1), rows));
            return noteConfig(trackId, as("glass"), { freq, velocity: clamp01(a.velocity) });
        }
        case "fill": {
            const freq = freqOfRow(viewRow(a.height, rows));
            return noteConfig(trackId, as("fill"), { freq, velocity: clamp01(a.velocity), duration: VIEW_FILL_SECONDS });
        }
        case "hold": {
            const row = WEATHER_ROWS.findIndex(r => r.id === a.source);
            if (row < 0) return null;
            return noteConfig(trackId, as("weather"), { row, velocity: clamp01(a.velocity), duration: VIEW_HOLD_SECONDS });
        }
    }
}

/** The bit of a track an AI tool reports. */
export function describeSettings(w: WaterSettings): Record<string, unknown> {
    return {
        preset: w.preset, play: w.play, rain: w.rain, vessel: w.vessel, spoon: w.spoon, dynamics: w.dynamics, mix: { ...w.mix },
        ...(isPitched(w) ? {} : { rows: WEATHER_ROWS.map((r, i) => ({ row: i, name: r.label, note: r.note })) }),
    };
}
