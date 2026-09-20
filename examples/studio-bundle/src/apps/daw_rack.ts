// The DAW's drum rack: what a drum track's rows are, what plays when one is hit, and the state of
// the sample browser that fills the pads. Kept free of `Entropy.*` so a plain vitest run can drive
// it without a window or an audio device (tests/daw_rack_bdd.test.ts).
//
// A drum track owns a rack of up to MAX_PADS pads. Pad N is row N of the piano roll, so pads never
// move or disappear: clearing a pad empties it, it does not renumber the ones after it (that
// would silently re-map every note already written). A pad plays one of three things:
//   - a sample file, when one has been put on it;
//   - the built-in synth voice it started with (Kick, Snare, Hihat, Clap, Tom), when it has none;
//   - nothing, for the extra pads that were added empty.

export const MAX_PADS = 16;

export interface PadSample {
    /** Absolute path of the audio file. Saved with the project. */
    path: string;
    /** Display name: the file name without its extension. */
    name: string;
    /** Linear gain, 0..2. */
    gain: number;
    /** Pitch shift in semitones, -12..12. */
    semitones: number;
    /** The played part of the sample as fractions, 0 <= start < end <= 1. */
    start: number;
    end: number;
    /** Stop at the note's length instead of playing to the end (a one-shot). */
    gate: boolean;
}

export interface DrumPad {
    name: string;
    /** The built-in voice this pad falls back to, or "" for none. */
    voice: string;
    freq: number;
    /** General MIDI drum note, sent when the track's instrument is a VST3 plugin. */
    midi: number;
    sample: PadSample | null;
}

export interface RackTrack {
    kind: "synth" | "drum";
    rows: number;
    rack?: DrumPad[];
}

const BUILT_IN: { name: string; voice: string; freq: number; midi: number }[] = [
    { name: "Kick", voice: "kick", freq: 55, midi: 36 },
    { name: "Snare", voice: "snare", freq: 200, midi: 38 },
    { name: "Hihat", voice: "hihat", freq: 1000, midi: 42 },
    { name: "Clap", voice: "clap", freq: 200, midi: 39 },
    { name: "Tom", voice: "tom", freq: 110, midi: 45 },
];

// General MIDI drum notes handed to the pads added after the five built-in ones.
const EXTRA_MIDI = [46, 49, 51, 43, 47, 50, 37, 40, 44, 41, 48];

export function defaultRack(): DrumPad[] {
    return BUILT_IN.map(d => ({ ...d, sample: null }));
}

function cleanSample(s: any): PadSample | null {
    if (!s || typeof s.path !== "string" || !s.path) return null;
    const start = clamp(num(s.start, 0), 0, 0.99);
    return {
        path: s.path,
        name: typeof s.name === "string" && s.name ? s.name : stem(s.path),
        gain: clamp(num(s.gain, 1), 0, 2),
        semitones: clamp(num(s.semitones, 0), -12, 12),
        start,
        end: clamp(num(s.end, 1), start + 0.005, 1),
        gate: s.gate === true,
    };
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const inRange = (v: unknown, lo: number, hi: number) => typeof v === "number" && v >= lo && v <= hi;

function sampleIsClean(s: any): boolean {
    return s === null || (
        !!s && typeof s.path === "string" && s.path !== "" && typeof s.name === "string"
        && inRange(s.gain, 0, 2) && inRange(s.semitones, -12, 12) && inRange(s.start, 0, 0.99)
        && inRange(s.end, 0, 1) && s.end > s.start && typeof s.gate === "boolean"
    );
}

function padIsClean(p: any): boolean {
    return !!p && typeof p.name === "string" && typeof p.voice === "string" && Number.isFinite(p.freq)
        && Number.isInteger(p.midi) && inRange(p.midi, 0, 127) && sampleIsClean(p.sample);
}

/**
 * The rack of a drum track, created (as the five built-in pads) when it has none, and repaired when
 * a saved one is damaged. Also keeps `track.rows` equal to the pad count, since the piano roll
 * draws one row per pad. A synth track is left alone and gets `[]`.
 *
 * A pad that is already valid is left as the same object: callers hold on to a pad between frames
 * (a slider's callback edits it), and a rack rebuilt on every call would leave them editing a copy.
 * An empty name is valid (someone is mid-edit); it is drawn as "Pad N".
 */
export function ensureRack(track: RackTrack): DrumPad[] {
    if (track.kind !== "drum") return [];
    if (!Array.isArray(track.rack) || track.rack.length === 0) track.rack = defaultRack();
    if (track.rack.length > MAX_PADS) track.rack.length = MAX_PADS;
    const rack = track.rack;
    for (let i = 0; i < rack.length; i++) {
        if (padIsClean(rack[i])) continue;
        const p: any = rack[i];
        rack[i] = {
            name: typeof p?.name === "string" ? p.name : `Pad ${i + 1}`,
            voice: typeof p?.voice === "string" ? p.voice : "",
            freq: num(p?.freq, 200),
            midi: Math.round(clamp(num(p?.midi, 36 + i), 0, 127)),
            sample: cleanSample(p?.sample),
        };
    }
    track.rows = rack.length;
    return rack;
}

export function padAt(track: RackTrack, row: number): DrumPad | undefined {
    return ensureRack(track)[row];
}

/** Appends an empty pad. Null when the rack is full. */
export function addPad(track: RackTrack): DrumPad | null {
    const rack = ensureRack(track);
    if (rack.length >= MAX_PADS) return null;
    const extra = rack.length - BUILT_IN.length;
    const pad: DrumPad = {
        name: `Pad ${rack.length + 1}`, voice: "", freq: 200,
        midi: EXTRA_MIDI[extra] ?? 36 + rack.length, sample: null,
    };
    rack.push(pad);
    track.rows = rack.length;
    return pad;
}

/** A file name without its folder and extension. */
export function stem(path: string): string {
    const file = path.split(/[\\/]/).pop() ?? path;
    const dot = file.lastIndexOf(".");
    return dot > 0 ? file.slice(0, dot) : file;
}

/**
 * Puts a sample file on a pad. A pad still called "Pad N" takes the file's name, since that is the
 * only thing that says what it is; a pad the user or the starter kit already named keeps its name.
 */
export function assignSample(track: RackTrack, row: number, file: { path: string; name?: string }): DrumPad | null {
    const pad = padAt(track, row);
    if (!pad) return null;
    const name = file.name ?? stem(file.path);
    pad.sample = { path: file.path, name, gain: 1, semitones: 0, start: 0, end: 1, gate: false };
    if (/^Pad \d+$/.test(pad.name)) pad.name = name.length > 14 ? name.slice(0, 14) : name;
    return pad;
}

/** Takes a pad's sample off: back to its built-in voice, or empty if it never had one. */
export function clearSample(track: RackTrack, row: number): DrumPad | null {
    const pad = padAt(track, row);
    if (!pad) return null;
    pad.sample = null;
    return pad;
}

export type SampleEdit = Partial<Pick<PadSample, "gain" | "semitones" | "start" | "end" | "gate">>;

/** Edits a pad's sample settings, clamped so the trim can never invert or collapse. */
export function editSample(pad: DrumPad, edit: SampleEdit): boolean {
    const s = pad.sample;
    if (!s) return false;
    // A slider that reports NaN (an empty field parsed as a number) changes nothing.
    const given = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v);
    if (given(edit.gain)) s.gain = clamp(edit.gain, 0, 2);
    if (given(edit.semitones)) s.semitones = clamp(Math.round(edit.semitones * 10) / 10, -12, 12);
    if (edit.gate !== undefined) s.gate = edit.gate;
    const MIN_SPAN = 0.005;
    if (given(edit.start)) s.start = clamp(edit.start, 0, s.end - MIN_SPAN);
    if (given(edit.end)) s.end = clamp(edit.end, s.start + MIN_SPAN, 1);
    return true;
}

export type PadStatus = "empty" | "synth" | "sample" | "missing";

export function padStatus(pad: DrumPad, isMissing: (path: string) => boolean): PadStatus {
    if (pad.sample) return isMissing(pad.sample.path) ? "missing" : "sample";
    return pad.voice ? "synth" : "empty";
}

export type PadHit =
    | { type: "sample"; path: string; gain: number; semitones: number; start: number; end: number; hold?: number }
    | { type: "voice"; voice: string; freq: number };

/**
 * What to play when `pad` is hit at `velocity` (0..1) by a note `noteSeconds` long. A pad whose
 * sample file is known to be missing plays nothing rather than silently switching to the synth
 * voice: the wrong sound in a finished beat is worse than a gap that shows up red.
 */
export function padHit(pad: DrumPad, velocity: number, noteSeconds: number, isMissing: (path: string) => boolean = () => false): PadHit | null {
    const s = pad.sample;
    if (s) {
        if (isMissing(s.path)) return null;
        return {
            type: "sample", path: s.path, gain: s.gain * clamp(velocity, 0, 1), semitones: s.semitones,
            start: s.start, end: s.end, hold: s.gate ? Math.max(0.03, noteSeconds) : undefined,
        };
    }
    return pad.voice ? { type: "voice", voice: pad.voice, freq: pad.freq } : null;
}

// --- Sample browser -----------------------------------------------------------------------------

export interface DirEntry {
    name: string;
    path: string;
    isDir: boolean;
    size: number;
    audioCount: number;
    dirCount: number;
}

export interface ListDirResult { ok: boolean; error?: string | null; entries: DirEntry[] }

/** What `Entropy.Audio.loadSample` reports about a decoded file. */
export interface SampleInfo {
    ok: boolean;
    error?: string | null;
    seconds: number;
    fullSeconds?: number | null;
    truncated: boolean;
    sourceRate: number;
    channels: number;
    peak: number;
    waveform: number[];
}
export type Lister = (path: string) => ListDirResult;

export interface BrowserState {
    /** Folder the tree starts at, or null before one has been chosen. */
    root: string | null;
    expanded: Record<string, boolean>;
    listings: Record<string, DirEntry[]>;
    errors: Record<string, string>;
    /** The file highlighted in the tree (and armed for the next pad click). */
    selected: string | null;
    filter: string;
}

export function newBrowser(): BrowserState {
    return { root: null, expanded: {}, listings: {}, errors: {}, selected: null, filter: "" };
}

/** Points the browser at a folder and opens it. Everything read from the previous root is dropped. */
export function setRoot(b: BrowserState, root: string, list: Lister): void {
    b.root = root;
    b.expanded = {};
    b.listings = {};
    b.errors = {};
    b.selected = null;
    openFolder(b, root, list);
}

function openFolder(b: BrowserState, path: string, list: Lister): void {
    const r = list(path);
    if (r.ok) {
        b.listings[path] = r.entries;
        delete b.errors[path];
        b.expanded[path] = true;
    } else {
        b.errors[path] = r.error ?? "could not read this folder";
        b.expanded[path] = false;
    }
}

/** Opens a closed folder (reading it again, so a pack copied in since is seen) or closes an open one. */
export function toggleFolder(b: BrowserState, path: string, list: Lister): void {
    if (b.expanded[path]) b.expanded[path] = false;
    else openFolder(b, path, list);
}

/** Reads every open folder again. */
export function refreshBrowser(b: BrowserState, list: Lister): void {
    for (const path of Object.keys(b.expanded)) if (b.expanded[path]) openFolder(b, path, list);
}

export interface TreeRow {
    id: string;
    label: string;
    depth: number;
    hasChildren: boolean;
    expanded: boolean;
    selected: boolean;
    icon: string;
    detail: string;
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSeconds(s: number): string {
    if (s < 10) return `${s.toFixed(2)} s`;
    if (s < 60) return `${s.toFixed(1)} s`;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function folderDetail(e: { audioCount: number; dirCount: number }): string {
    if (e.audioCount > 0) return plural(e.audioCount, "sample", "samples");
    if (e.dirCount > 0) return plural(e.dirCount, "folder", "folders");
    return "empty";
}

const FILE_ICON = "♪";

/**
 * The flat, depth-computed rows the tree widget draws: the root, then every open folder's
 * contents beneath it. Files are filtered by `filter` (a case-insensitive substring of the name);
 * folders always show, so an unopened pack is still there to open.
 */
export function browserRows(b: BrowserState): TreeRow[] {
    if (!b.root) return [];
    const rows: TreeRow[] = [];
    const needle = b.filter.trim().toLowerCase();

    const walk = (path: string, depth: number) => {
        for (const e of b.listings[path] ?? []) {
            if (e.isDir) {
                const open = !!b.expanded[e.path];
                rows.push({
                    id: e.path, label: e.name, depth, hasChildren: e.audioCount + e.dirCount > 0, expanded: open,
                    selected: false, icon: "", detail: b.errors[e.path] ? "unreadable" : folderDetail(e),
                });
                if (open) walk(e.path, depth + 1);
            } else if (!needle || e.name.toLowerCase().includes(needle)) {
                rows.push({
                    id: e.path, label: e.name, depth, hasChildren: false, expanded: false,
                    selected: b.selected === e.path, icon: FILE_ICON, detail: formatBytes(e.size),
                });
            }
        }
    };

    const rootName = b.root.split(/[\\/]/).filter(Boolean).pop() ?? b.root;
    const rootOpen = !!b.expanded[b.root];
    rows.push({ id: b.root, label: rootName, depth: 0, hasChildren: true, expanded: rootOpen, selected: false, icon: "", detail: "" });
    if (rootOpen) walk(b.root, 1);
    return rows;
}

/** Whether `path` is a file row the browser currently lists (so a stale selection can be dropped). */
export function isListedFile(b: BrowserState, path: string): boolean {
    for (const entries of Object.values(b.listings)) {
        if (entries.some(e => !e.isDir && e.path === path)) return true;
    }
    return false;
}

/** A pad's colour: the palette walked from the track's own colour, one step per row. */
export function padPaletteIndex(trackColorIndex: number, row: number, paletteSize: number): number {
    return (((trackColorIndex + row) % paletteSize) + paletteSize) % paletteSize;
}
