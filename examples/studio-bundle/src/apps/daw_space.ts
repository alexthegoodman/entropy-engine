// Pure logic for the DAW's Reverb & EQ window: a track's six-band EQ, the presets for it and for the
// reverb, and turning them into what `Entropy.AudioEffect.createEq` and the WAV export take. No
// `Entropy` calls in here, so it runs under vitest as it is (tests/daw_space.test.ts). The window
// that uses it is in daw_synth_addon.ts; the picture is Rust (src/entropy_gui/widgets_reverb_eq.rs)
// and the filters are src/audio/eq.rs.
//
// The EQ sits on the track's bus right after the reverb, so it shapes the reverb's tail as well as
// the dry sound - which is what the 3D view draws.

export type EqBandKind = "lowcut" | "lowshelf" | "peak" | "highshelf" | "highcut";

export interface EqBand {
    kind: EqBandKind;
    enabled: boolean;
    /** Hz, 20..20000. */
    freq: number;
    /** dB, -18..18. Ignored by the cuts. */
    gain: number;
    /** A bell's bandwidth, a shelf's slope, a cut's resonance. 0.1..18. */
    q: number;
}

export interface TrackEq {
    bands: EqBand[];
    /** Output trim, dB. */
    output: number;
}

export const EQ_BAND_COUNT = 6;
export const EQ_MIN_FREQ = 20;
export const EQ_MAX_FREQ = 20000;
export const EQ_MAX_GAIN = 18;
export const EQ_MIN_Q = 0.1;
export const EQ_MAX_Q = 18;

/** The fixed layout, matching `eq::DEFAULT_BANDS` in src/audio/eq.rs: each position keeps its kind. */
export const EQ_LAYOUT: readonly EqBandKind[] = ["lowcut", "lowshelf", "peak", "peak", "highshelf", "highcut"];

export const EQ_KIND_LABELS: Record<EqBandKind, string> = {
    lowcut: "Low cut",
    lowshelf: "Low shelf",
    peak: "Bell",
    highshelf: "High shelf",
    highcut: "High cut",
};

export function defaultEq(): TrackEq {
    return {
        bands: [
            { kind: "lowcut", enabled: false, freq: 30, gain: 0, q: 0.707 },
            { kind: "lowshelf", enabled: true, freq: 120, gain: 0, q: 0.707 },
            { kind: "peak", enabled: true, freq: 420, gain: 0, q: 1 },
            { kind: "peak", enabled: true, freq: 2400, gain: 0, q: 1 },
            { kind: "highshelf", enabled: true, freq: 8000, gain: 0, q: 0.707 },
            { kind: "highcut", enabled: false, freq: 18000, gain: 0, q: 0.707 },
        ],
        output: 0,
    };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

/** One band pulled into range; anything unusable falls back to `fallback`'s value. Keeps the
 * layout's kind for its position (the engine does the same). */
export function repairBand(saved: unknown, fallback: EqBand): EqBand {
    const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
    return {
        kind: fallback.kind,
        enabled: typeof s.enabled === "boolean" ? s.enabled : fallback.enabled,
        freq: num(s.freq, EQ_MIN_FREQ, EQ_MAX_FREQ, fallback.freq),
        gain: num(s.gain, -EQ_MAX_GAIN, EQ_MAX_GAIN, fallback.gain),
        q: num(s.q, EQ_MIN_Q, EQ_MAX_Q, fallback.q),
    };
}

/** Reads a saved EQ of any age or shape into a valid `TrackEq`. */
export function repairEq(saved: unknown): TrackEq {
    const d = defaultEq();
    if (!saved || typeof saved !== "object") return d;
    const s = saved as Record<string, unknown>;
    const bands = Array.isArray(s.bands) ? s.bands : [];
    return {
        bands: d.bands.map((b, i) => repairBand(bands[i], b)),
        output: num(s.output, -EQ_MAX_GAIN, EQ_MAX_GAIN, 0),
    };
}

/** Whether a band changes the sound at all. */
export function bandActive(b: EqBand): boolean {
    return b.enabled && (b.kind === "lowcut" || b.kind === "highcut" || Math.abs(b.gain) > 1e-3);
}

/** True when the EQ leaves the sound exactly as it is: the bus can leave it out. */
export function isEqFlat(eq: TrackEq | undefined | null): boolean {
    if (!eq) return true;
    return Math.abs(eq.output) <= 1e-3 && !eq.bands.some(bandActive);
}

/** What `AudioEffect.createEq`/`setEqParams` and the export's `eq` take. */
export function eqEngineConfig(eq: TrackEq) {
    return { bands: eq.bands.map(b => ({ kind: b.kind, enabled: b.enabled, freq: b.freq, gain: b.gain, q: b.q })), output: eq.output };
}

/** A band after an edit from the view or a knob: pulled into range, kind kept. */
export function setBand(eq: TrackEq, index: number, patch: Partial<EqBand>): TrackEq {
    if (index < 0 || index >= eq.bands.length) return eq;
    const bands = eq.bands.slice();
    bands[index] = repairBand({ ...bands[index], ...patch }, bands[index]);
    return { ...eq, bands };
}

// --- Presets -------------------------------------------------------------------------------------
//
// A preset only says what it changes; every band it does not mention goes back to the default.

type BandPatch = Partial<Omit<EqBand, "kind">>;

export const EQ_PRESETS: readonly { id: string; label: string; bands: Record<number, BandPatch>; output?: number }[] = [
    { id: "flat", label: "Flat", bands: {} },
    { id: "clean-low", label: "Clean up the lows", bands: { 0: { enabled: true, freq: 90, q: 0.707 }, 2: { freq: 300, gain: -2.5, q: 1.2 } } },
    { id: "warm", label: "Warm", bands: { 1: { freq: 180, gain: 3 }, 4: { freq: 7000, gain: -2.5 } } },
    { id: "air", label: "Air and sparkle", bands: { 0: { enabled: true, freq: 60 }, 4: { freq: 10000, gain: 4, q: 0.6 } } },
    { id: "presence", label: "Presence (vocals, leads)", bands: { 0: { enabled: true, freq: 100 }, 2: { freq: 350, gain: -2, q: 1.4 }, 3: { freq: 3200, gain: 3.5, q: 0.9 } } },
    { id: "boom", label: "Big low end", bands: { 1: { freq: 90, gain: 5, q: 0.8 }, 2: { freq: 320, gain: -2.5, q: 1.2 } } },
    { id: "scoop", label: "Scooped mids", bands: { 1: { freq: 150, gain: 2.5 }, 2: { freq: 800, gain: -5, q: 0.7 }, 4: { freq: 6000, gain: 2.5 } } },
    { id: "telephone", label: "Telephone", bands: { 0: { enabled: true, freq: 400, q: 1.1 }, 3: { freq: 1600, gain: 6, q: 1.2 }, 5: { enabled: true, freq: 3200, q: 1.1 } } },
    { id: "radio", label: "Old radio", bands: { 0: { enabled: true, freq: 250, q: 0.9 }, 2: { freq: 900, gain: 4, q: 0.8 }, 5: { enabled: true, freq: 5000, q: 0.9 } } },
    { id: "dark-verb", label: "Darker reverb tail", bands: { 4: { freq: 4500, gain: -6, q: 0.6 }, 5: { enabled: true, freq: 9000 } } },
];

export function applyEqPreset(presetId: string): TrackEq {
    const p = EQ_PRESETS.find(x => x.id === presetId);
    const eq = defaultEq();
    if (!p) return eq;
    const bands = eq.bands.map((b, i) => repairBand({ ...b, ...(p.bands[i] ?? {}) }, b));
    return { bands, output: p.output ?? 0 };
}

/** The preset these settings are, or -1 when they have been edited. */
export function eqPresetIndex(eq: TrackEq): number {
    const same = (a: TrackEq, b: TrackEq) =>
        Math.abs(a.output - b.output) < 1e-3 &&
        a.bands.every((x, i) => {
            const y = b.bands[i];
            // A band that makes no sound is the same whatever its other fields say.
            if (!bandActive(x) && !bandActive(y)) return true;
            return x.enabled === y.enabled && Math.abs(x.freq - y.freq) < 0.5 && Math.abs(x.gain - y.gain) < 0.05 && Math.abs(x.q - y.q) < 0.005;
        });
    return EQ_PRESETS.findIndex(p => same(applyEqPreset(p.id), eq));
}

/** The reverb's four settings, as `VoiceParams` stores them. */
export interface ReverbSettings {
    reverbRoomSize: number;
    reverbTime: number;
    reverbDamping: number;
    reverbMix: number;
}

export const REVERB_PRESETS: readonly { id: string; label: string; settings: ReverbSettings }[] = [
    { id: "dry", label: "Dry (off)", settings: { reverbRoomSize: 10, reverbTime: 1.2, reverbDamping: 0.5, reverbMix: 0 } },
    { id: "room", label: "Small room", settings: { reverbRoomSize: 10, reverbTime: 0.6, reverbDamping: 0.6, reverbMix: 0.18 } },
    { id: "studio", label: "Studio", settings: { reverbRoomSize: 14, reverbTime: 1.1, reverbDamping: 0.55, reverbMix: 0.22 } },
    { id: "plate", label: "Bright plate", settings: { reverbRoomSize: 12, reverbTime: 1.8, reverbDamping: 0.15, reverbMix: 0.28 } },
    { id: "hall", label: "Concert hall", settings: { reverbRoomSize: 24, reverbTime: 2.6, reverbDamping: 0.45, reverbMix: 0.3 } },
    { id: "cathedral", label: "Cathedral", settings: { reverbRoomSize: 30, reverbTime: 5.5, reverbDamping: 0.35, reverbMix: 0.4 } },
    { id: "wash", label: "Ambient wash", settings: { reverbRoomSize: 28, reverbTime: 6, reverbDamping: 0.7, reverbMix: 0.6 } },
];

/** The reverb preset these settings are, or -1. */
export function reverbPresetIndex(v: ReverbSettings): number {
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-3;
    return REVERB_PRESETS.findIndex(p => {
        const s = p.settings;
        // Any reverb with the mix at zero is "off", whatever the rest says.
        if (s.reverbMix === 0) return close(v.reverbMix, 0);
        return close(s.reverbRoomSize, v.reverbRoomSize) && close(s.reverbTime, v.reverbTime) && close(s.reverbDamping, v.reverbDamping) && close(s.reverbMix, v.reverbMix);
    });
}

/** "1.20 kHz", "85 Hz". */
export function formatHz(hz: number): string {
    return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`;
}

/** One line describing a band, for a label or an AI tool's answer. */
export function describeBand(b: EqBand, index: number): string {
    const name = `${index + 1} ${EQ_KIND_LABELS[b.kind]}`;
    if (!b.enabled) return `${name}: off`;
    if (b.kind === "lowcut" || b.kind === "highcut") return `${name}: ${formatHz(b.freq)}, Q ${b.q.toFixed(2)}`;
    return `${name}: ${formatHz(b.freq)}, ${b.gain >= 0 ? "+" : ""}${b.gain.toFixed(1)} dB, Q ${b.q.toFixed(2)}`;
}
