// DAW Synth Addon
// A multi-track piano roll / beat editor with a built-in polyphonic synth + drum kit and a
// 16-channel arrangement view, hooked up to the built-in chat via registerTool so beats,
// basslines, riffs, synth configs and whole arrangements can be composed by the AI as well as
// by hand.
//
// The arrangement maths (clips, snapping, what plays on a given step, migration of older
// saves) lives in daw_arrangement.ts so it can be tested without a window; this file wires it
// to the engine and the UI.

import type { ArrClip, NoteCell, Pattern, PlacedNote, SnapMode } from "./daw_arrangement";
import {
    activePattern,
    barSteps,
    clipEnd,
    clipLocalStep,
    clipsOfTrack,
    createClip,
    deleteClip,
    duplicateClip,
    expandArrangement,
    laneTracks,
    laneCount,
    migrateProject,
    miniNotes,
    moveClip,
    msToStep,
    nextFreeChannel,
    nextPatternName,
    pianoRollPlayhead,
    pruneArrangement,
    resizeClip,
    snapUnitSteps,
    songSteps,
    stepMs,
    stepToMs,
    triggersAt,
} from "./daw_arrangement";
import type { DrumPad, ListDirResult, SampleInfo } from "./daw_rack";
import type { Character, HardCut, KickLockChange, MoveContext, StutterRate, VariationFocus } from "./daw_moves";
import {
    GATE_PATTERNS,
    GATE_PATTERN_LABELS,
    STUTTER_RATES,
    VARIATION_FOCI,
    VARIATION_LABELS,
    answerPhrase,
    applyAcid,
    buildRoll,
    busEffects,
    carveRange,
    echoRepeats,
    grooveAt,
    grooveVelocity,
    isCut,
    isKickPad,
    kickLock,
    makeVariation,
    nearestBar,
    octaveSpark,
    phraseEnding,
    repairCharacter,
    repairCuts,
    rollRows,
    stutter,
    thinOut,
} from "./daw_moves";
import type { WavetableSettings } from "./daw_wavetable";
import type { IconName, IconStyle } from "../addon";
import {
    WT_OPS,
    WT_PRESETS,
    WT_WAVEFORM,
    WT_INSTRUMENT_PRESETS,
    instrumentPresetFolders,
    instrumentPresetById,
    defaultWavetable,
    describeSettings as describeWavetable,
    noteConfig as wavetableNoteConfig,
    repairWavetable,
} from "./daw_wavetable";
import type { PhysModSettings } from "./daw_physmod";
import {
    PHYSMOD_WAVEFORM,
    PHYSMOD_INSTRUMENT_PRESETS,
    PHYSMOD_ARTICULATIONS,
    stringForFreq,
    openStrings as physModOpenStrings,
    applyPreset as applyPhysModPreset,
    defaultPhysMod,
    describeSettings as describePhysMod,
    noteConfig as physModNoteConfig,
    repairPhysMod,
} from "./daw_physmod";
import type { BrassSettings } from "./daw_brass";
import {
    BRASS_WAVEFORM,
    BRASS_INSTRUMENTS,
    BRASS_STYLES,
    BRASS_ARTICULATIONS,
    BRASS_MUTES,
    applyInstrument as applyBrassInstrument,
    applyMute as applyBrassMute,
    brassInstrumentById,
    handAndBell,
    applyStyle as applyBrassStyle,
    bendForSlide,
    defaultBrass,
    describeSettings as describeBrass,
    heldSeconds as brassHeldSeconds,
    noteConfig as brassNoteConfig,
    repairBrass,
} from "./daw_brass";
import type { MatterHit, MatterKit, MatterPiece, MatterSettings } from "./daw_matter";
import {
    MATTER_WAVEFORM,
    MATTER_PIECES,
    MATTER_PRESETS,
    MATTER_ROWS,
    KIT_RANGES,
    applyPreset as applyMatterPreset,
    defaultMatter,
    describeSettings as describeMatter,
    hitConfig as matterHitConfig,
    repairMatter,
    sameBuild as sameMatterBuild,
} from "./daw_matter";
import type { GuitarDiag, GuitarPrefs } from "./daw_guitar";
import type { SongEntry, SongStore, SortMode, VersionEntry } from "./daw_library";
import {
    SongLibrary,
    TRASH_RETENTION_MS,
    cleanName,
    dayHeading,
    describeChanges,
    describeStats,
    filterSongs,
    formatClock,
    formatDate,
    memoryStore,
    sortSongs,
    timeAgo,
    versionTitle,
} from "./daw_library";
import neonTide from "../../sample-songs/neon-tide-edm.json" with { type: "json" };
import afterhours from "../../sample-songs/afterhours-house.json" with { type: "json" };
import lowlight from "../../sample-songs/lowlight-hip-hop.json" with { type: "json" };
import beacon from "../../sample-songs/the-beacon-cinematic.json" with { type: "json" };
import shadow from "../../sample-songs/shadow-passage-cinematic.json" with { type: "json" };
import homeward from "../../sample-songs/homeward-light-cinematic.json" with { type: "json" };
import {
    GUITAR_MODES,
    GUITAR_WAVEFORMS,
    SignalHints,
    defaultGuitarPrefs,
    diagnosticsLines,
    levelBar,
    noteName as guitarNoteName,
    readGuitarPrefs,
    startConfig as guitarStartConfig,
    takeToPattern,
} from "./daw_guitar";
import {
    MAX_PADS,
    addPad,
    assignSample,
    browserRows,
    clearSample,
    defaultRack,
    editSample,
    ensureRack,
    formatSeconds,
    isListedFile,
    newBrowser,
    padAt,
    padHit,
    padPaletteIndex,
    padStatus,
    refreshBrowser,
    setRoot,
    stem,
    toggleFolder,
} from "./daw_rack";

/** Phosphor icons (`Entropy.Icons`): `icon("play")` alone, `withIcon("play", "Play")` beside a label. The DAW uses
 * the regular (outline) weight only: Fill and Bold icons do not draw in the real window (see README, Icons). */
const icon = (name: IconName, style?: IconStyle): string => Entropy.Icons.get(name, style);
const withIcon = (name: IconName, text: string, style?: IconStyle): string => Entropy.Icons.label(name, text, style);
/** The marker in front of an option in a pick list: a ring with a dot for the chosen one, an empty ring otherwise. */
const radio = (selected: boolean): string => (selected ? icon("radio-button") : icon("circle")) + " ";

const addon = Entropy.Addon.register({
    name: "DAW",
    version: "3.0.0",
    description: "Arrangement view, piano roll and beat editor with built-in synth + drum kit",
    author: ["Entropy"],
    category: "Audio Creation",
    capabilities: {
        ui: true,
        needsViewport: false
    }
});

// --- Music theory helpers -------------------------------------------------

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function midiToName(midi: number): string {
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${name}${octave}`;
}

function midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

const SCALES: Record<string, number[]> = {
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    major: [0, 2, 4, 5, 7, 9, 11],
    natural_minor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    pentatonic_major: [0, 2, 4, 7, 9],
    pentatonic_minor: [0, 3, 5, 7, 10],
    blues: [0, 3, 5, 6, 7, 10]
};

function rowToMidi(row: number, rootNote: number, scale: string): number {
    const intervals = SCALES[scale] || SCALES.chromatic;
    const len = intervals.length;
    const octave = Math.floor(row / len);
    const degree = intervals[((row % len) + len) % len];
    return rootNote + octave * 12 + degree;
}

// A drum track's rows are the pads of its rack (daw_rack.ts): five built-in voices to begin with,
// each replaceable by a sample from the browser, and up to MAX_PADS in all.

// --- Data model ------------------------------------------------------------

interface VoiceParams {
    waveform: string; // sine|square|saw|triangle|noise (synth tracks)
    cutoff: number;
    resonance: number;
    attack: number;
    decay: number;
    sustain: number;
    release: number;
    // Effects chain - see NoteConfig in addon.d.ts. Defaults keep the pre-FX sound unchanged.
    delayTime: number;
    delayFeedback: number;
    delayMix: number;
    reverbRoomSize: number;
    reverbTime: number;
    reverbDamping: number;
    reverbMix: number;
    // Filter envelope and drive, written by the Character panel's Acid knob (daw_moves.ts's
    // applyAcid). Absent on older saves, which means off.
    filterEnv?: number;
    filterDecay?: number;
    drive?: number;
}

// A hosted VST3 plugin standing in for the built-in voice. `state` is the plugin's own saved patch
// (base64), so a project reopens with the same sound the editor left it on.
interface Vst3Instrument {
    path: string;
    name: string;
    state?: string;
}

interface Track {
    id: string;
    name: string;
    kind: "synth" | "drum";
    instrument?: Vst3Instrument | null;
    // Drum tracks only: the pads, one per piano-roll row. `rows` always equals rack.length.
    rack?: DrumPad[];
    // Synth tracks whose waveform is "wavetable": the sculpted table (base64) and its settings.
    wavetable?: WavetableSettings;
    // Synth tracks whose waveform is "physmod": the bowed-string settings. No sculpted data - a
    // bowed string carries no persistent content the way a wavetable's table does.
    physmod?: PhysModSettings;
    // Synth tracks whose waveform is "brass": the brass player's settings (no persistent data).
    brass?: BrassSettings;
    // Synth tracks whose waveform is "matter": the drum kit's tunings, mix and how it is played.
    // Its rows are the kit's rows (daw_matter.ts), not a scale.
    matter?: MatterSettings;
    rootNote: number;
    scale: string;
    rows: number;
    voice: VoiceParams;
    gain: number;
    muted: boolean;
    solo: boolean;
    // The arrangement lane this track sits on (0-based). Lanes are a fixed grid of at least 16.
    channel: number;
    // Index into TRACK_PALETTE, fixed at creation so a track keeps its colour when others go away.
    colorIndex: number;
    // Every pattern this track owns, and the one the piano roll is editing.
    patterns: Pattern[];
    activePatternId: string;
    // Lazily created the first time this track's bus is synced (see ensureTrackEffects) - ids
    // into the engine's shared Entropy.AudioEffect registry, one delay + one reverb per track,
    // reused by every note that plays through this track's persistent mixing bus instead of
    // each note getting its own fresh (and, for reverb, expensive) effect instance.
    delayEffectId?: string | null;
    reverbEffectId?: string | null;
    // The Character knobs (daw_moves.ts). Created on first use; absent means all at zero.
    character?: Character;
}

interface DAWProject {
    bpm: number;
    stepsPerBeat: number;
    // Length of the arrangement, in bars (a bar is four beats).
    songBars: number;
    snap: SnapMode;
    arrangement: ArrClip[];
    tracks: Track[];
    activeTrackId: string | null;
    // Guitar Input settings (see daw_guitar.ts). Optional: a project saved before it existed has none.
    guitar?: GuitarPrefs;
    // Stretches where Drop Gap (without tails) silences tracks outright - see daw_moves.ts's HardCut.
    cuts?: HardCut[];
}

function defaultSynthVoice(waveform = "saw"): VoiceParams {
    return {
        waveform, cutoff: 4000, resonance: 1.0, attack: 0.005, decay: 0.08, sustain: 0.6, release: 0.12,
        delayTime: 0, delayFeedback: 0.35, delayMix: 0, reverbRoomSize: 10, reverbTime: 1.2, reverbDamping: 0.5, reverbMix: 0
    };
}

function defaultDrumVoice(): VoiceParams {
    return {
        waveform: "kick", cutoff: 1800, resonance: 1.0, attack: 0.002, decay: 0.12, sustain: 0.0, release: 0.08,
        delayTime: 0, delayFeedback: 0.35, delayMix: 0, reverbRoomSize: 10, reverbTime: 0.8, reverbDamping: 0.5, reverbMix: 0
    };
}

// Twelve hues spread around the wheel and tuned to sit together on the dark arrangement canvas.
const TRACK_PALETTE: [number, number, number][] = [
    [236, 96, 122], [242, 156, 74], [232, 200, 78], [118, 202, 120], [66, 196, 178], [84, 160, 238],
    [140, 128, 242], [200, 122, 232], [234, 122, 182], [110, 190, 222], [168, 210, 108], [240, 132, 98]
];

function trackRgba(track: Track): [number, number, number, number] {
    const [r, g, b] = TRACK_PALETTE[((track.colorIndex % TRACK_PALETTE.length) + TRACK_PALETTE.length) % TRACK_PALETTE.length];
    return [r / 255, g / 255, b / 255, 1];
}

const newId = () => Entropy.generateUUID();

function newPattern(name: string, steps: number, notes: NoteCell[] = [], id?: string): Pattern {
    return { id: id ?? newId(), name, steps, notes };
}

const n = (row: number, step: number, length = 1, velocity = 0.85): NoteCell => ({ row, step, length, velocity });

// The starter song uses fixed ids so a scripted run (and a person reading DAW.json) can name
// a track, pattern or clip without first looking it up.
function makeStarterProject(): DAWProject {
    const bar = 16;

    const drums: Track = {
        id: "trk-drums", name: "Drums", kind: "drum", channel: 0, colorIndex: 0,
        rootNote: 60, scale: "chromatic", rows: 5, rack: defaultRack(),
        voice: defaultDrumVoice(), gain: 0.55, muted: false, solo: false,
        patterns: [
            newPattern("Groove", bar, [
                n(0, 0, 1, 1.0), n(0, 8, 1, 1.0),
                n(1, 4, 1, 0.95), n(1, 12, 1, 0.95),
                n(2, 0, 1, 0.7), n(2, 2, 1, 0.6), n(2, 4, 1, 0.7), n(2, 6, 1, 0.6),
                n(2, 8, 1, 0.7), n(2, 10, 1, 0.6), n(2, 12, 1, 0.7), n(2, 14, 1, 0.6)
            ], "pat-drums-groove"),
            newPattern("Fill", bar, [
                n(0, 0, 1, 1.0), n(0, 8, 1, 1.0),
                n(1, 4, 1, 0.9),
                n(2, 0, 1, 0.7), n(2, 2, 1, 0.6), n(2, 4, 1, 0.7), n(2, 6, 1, 0.6),
                n(4, 10, 1, 0.8), n(4, 11, 1, 0.85),
                n(1, 12, 1, 0.7), n(1, 13, 1, 0.78), n(1, 14, 1, 0.88), n(1, 15, 1, 1.0)
            ], "pat-drums-fill")
        ],
        activePatternId: "pat-drums-groove"
    };

    const bass: Track = {
        id: "trk-bass", name: "Bass", kind: "synth", channel: 1, colorIndex: 1,
        rootNote: 36, scale: "pentatonic_minor", rows: 10,
        voice: defaultSynthVoice("saw"), gain: 0.3, muted: false, solo: false,
        patterns: [
            newPattern("Root", bar, [n(0, 0, 2, 0.9), n(0, 4, 2, 0.8), n(2, 8, 2, 0.9), n(1, 12, 2, 0.8)], "pat-bass-root"),
            newPattern("Walk", bar, [
                n(0, 0, 2, 0.9), n(0, 2, 1, 0.7), n(3, 4, 2, 0.85), n(2, 8, 2, 0.9),
                n(1, 10, 1, 0.75), n(0, 12, 2, 0.9), n(1, 14, 1, 0.8)
            ], "pat-bass-walk")
        ],
        activePatternId: "pat-bass-root"
    };

    const lead: Track = {
        id: "trk-lead", name: "Lead", kind: "synth", channel: 2, colorIndex: 4,
        rootNote: 60, scale: "pentatonic_minor", rows: 10,
        voice: defaultSynthVoice("square"), gain: 0.18, muted: false, solo: false,
        patterns: [
            newPattern("Melody", bar * 2, [
                n(4, 0, 2, 0.85), n(2, 3, 1, 0.7), n(3, 4, 2, 0.8), n(4, 8, 1, 0.85), n(5, 10, 2, 0.9),
                n(3, 12, 1, 0.7), n(4, 16, 2, 0.85), n(6, 19, 1, 0.8), n(5, 20, 2, 0.85),
                n(3, 24, 1, 0.7), n(2, 26, 2, 0.8), n(0, 28, 4, 0.9)
            ], "pat-lead-melody")
        ],
        activePatternId: "pat-lead-melody"
    };

    const pad: Track = {
        id: "trk-pad", name: "Pad", kind: "synth", channel: 3, colorIndex: 6,
        rootNote: 48, scale: "pentatonic_minor", rows: 10,
        voice: defaultSynthVoice("triangle"), gain: 0.16, muted: false, solo: false,
        patterns: [
            newPattern("Chords", bar, [
                n(0, 0, 8, 0.6), n(2, 0, 8, 0.55), n(4, 0, 8, 0.55),
                n(1, 8, 8, 0.6), n(3, 8, 8, 0.55), n(5, 8, 8, 0.55)
            ], "pat-pad-chords")
        ],
        activePatternId: "pat-pad-chords"
    };

    const clip = (trackId: string, patternId: string, startBar: number, bars: number): ArrClip => ({
        id: `clip-${trackId.slice(4)}-${startBar}`, trackId, patternId, startStep: startBar * bar, lengthSteps: bars * bar
    });

    const arrangement: ArrClip[] = [
        clip("trk-drums", "pat-drums-groove", 0, 3), clip("trk-drums", "pat-drums-fill", 3, 1),
        clip("trk-drums", "pat-drums-groove", 4, 3), clip("trk-drums", "pat-drums-fill", 7, 1),
        clip("trk-drums", "pat-drums-groove", 8, 7), clip("trk-drums", "pat-drums-fill", 15, 1),
        clip("trk-bass", "pat-bass-root", 2, 6), clip("trk-bass", "pat-bass-walk", 8, 8),
        clip("trk-lead", "pat-lead-melody", 4, 4), clip("trk-lead", "pat-lead-melody", 10, 6),
        clip("trk-pad", "pat-pad-chords", 6, 10)
    ];

    return { bpm: 96, stepsPerBeat: 4, songBars: 16, snap: "bar", arrangement, tracks: [drums, bass, lead, pad], activeTrackId: "trk-drums" };
}

// A fresh song: one drum track and one synth track, each with an empty pattern, and nothing
// arranged yet - the starting point "New song" gives you.
function makeBlankProject(): DAWProject {
    const blank: DAWProject = { bpm: 120, stepsPerBeat: 4, songBars: 16, snap: "bar", arrangement: [], tracks: [], activeTrackId: null };
    blank.tracks.push(newTrack("drum", 0, "Drums", blank), newTrack("synth", 1, "Synth", blank));
    blank.activeTrackId = blank.tracks[0].id;
    return blank;
}

let project: DAWProject = makeStarterProject();

// What "New song" can start from. Every choice makes a new song in the library - nothing here ever
// replaces the song you are working on. The JSON templates are copied with a JSON round trip (the
// addon runtime has no structuredClone), so the new song can be edited independently.
interface SongTemplate { id: string; label: string; songName: string; make: () => DAWProject }
const copyJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const SONG_TEMPLATES: SongTemplate[] = [
    { id: "blank", label: "Blank song", songName: "Untitled song", make: makeBlankProject },
    { id: "demo", label: "Demo song", songName: "Demo song", make: makeStarterProject },
    { id: "neon", label: "Neon Tide - EDM (rising violins)", songName: "Neon Tide", make: () => copyJson(neonTide) as DAWProject },
    { id: "afterhours", label: "Afterhours - House (cello chops)", songName: "Afterhours", make: () => copyJson(afterhours) as DAWProject },
    { id: "lowlight", label: "Lowlight - Hip Hop (drum breakdown)", songName: "Lowlight", make: () => copyJson(lowlight) as DAWProject },
    { id: "beacon", label: "The Beacon - Cinematic (horn fanfare)", songName: "The Beacon", make: () => copyJson(beacon) as DAWProject },
    { id: "shadow", label: "Shadow Passage - Cinematic (suspense)", songName: "Shadow Passage", make: () => copyJson(shadow) as DAWProject },
    { id: "homeward", label: "Homeward Light - Cinematic (string theme)", songName: "Homeward Light", make: () => copyJson(homeward) as DAWProject },
];

function getActiveTrack(): Track | undefined {
    return project.tracks.find(t => t.id === project.activeTrackId) || project.tracks[0];
}

function findTrack(id: string): Track | undefined {
    return project.tracks.find(t => t.id === id);
}

function newTrack(kind: "synth" | "drum", channel: number, name?: string, into: DAWProject = project): Track {
    const pattern = newPattern("Pattern 1", barSteps(into.stepsPerBeat));
    const colorIndex = into.tracks.reduce((m, t) => Math.max(m, t.colorIndex), -1) + 1;
    const base = {
        id: Entropy.generateUUID(), channel, colorIndex, muted: false, solo: false,
        patterns: [pattern], activePatternId: pattern.id
    };
    if (kind === "drum") {
        return {
            ...base, name: name ?? `Drums ${into.tracks.length + 1}`, kind: "drum",
            rootNote: 60, scale: "chromatic", rows: 5, rack: defaultRack(),
            voice: defaultDrumVoice(), gain: 0.5
        };
    }
    return {
        ...base, name: name ?? `Synth ${into.tracks.length + 1}`, kind: "synth",
        rootNote: 60, scale: "pentatonic_minor", rows: 10,
        voice: defaultSynthVoice("saw"), gain: 0.25
    };
}

function addTrack(kind: "synth" | "drum", channel?: number, name?: string): Track {
    const track = newTrack(kind, channel ?? nextFreeChannel(project.tracks), name);
    project.tracks.push(track);
    project.activeTrackId = track.id;
    return track;
}

// --- Wavetable tracks (see daw_wavetable.ts and src/audio/wavetable.rs) ---------------------------
//
// A synth track whose waveform is "wavetable" plays a table you sculpt in the Wavetable window. The
// table lives engine-side, named by the track's id; the project saves it as base64 next to the
// track's settings. Everything here that is not saved is runtime: which tables the engine has been
// given, and the engine ids of the notes being held while the window is used.

const wtLoaded: Record<string, boolean> = {};
// Engine ids of held notes: by key (a key pressed in the window), the audition note that sounds for
// the length of a stroke, and the note latched by the Hold button.
const wtHeld: Record<string, Record<number, number>> = {};
const wtStroke: Record<string, number> = {};
const wtLatch: Record<string, number> = {};
let wtStatus = "";

function isWavetableTrack(track: Track): boolean {
    return track.kind === "synth" && !track.instrument && track.voice.waveform === WT_WAVEFORM;
}

// The track's wavetable settings, with the table itself put in the engine the first time it is
// needed: from the saved data if there is any, otherwise from the preset it started as.
function trackWavetable(track: Track): WavetableSettings {
    if (!track.wavetable) track.wavetable = defaultWavetable();
    const wt = track.wavetable;
    if (!wtLoaded[track.id]) {
        wtLoaded[track.id] = true;
        const preset = WT_PRESETS.some(p => p.id === wt.preset) ? wt.preset : "saw";
        addon.Wavetable.ensure(track.id, { preset: wt.data ? undefined : preset });
        if (wt.data) {
            const r = addon.Wavetable.importData(track.id, wt.data);
            if (!r.ok) {
                wtStatus = `${track.name}: the saved wavetable could not be read (${r.error}), so it starts from ${preset}.`;
                addon.Wavetable.ensure(track.id, { preset });
                wt.data = undefined;
            }
        } else {
            wt.data = addon.Wavetable.exportData(track.id) ?? undefined;
        }
    }
    return wt;
}

// Copies the engine's table into the track, so the project saves what is on screen. Called whenever
// an edit ends; the write to disk is debounced.
function saveTrackWavetable(track: Track) {
    const data = addon.Wavetable.exportData(track.id);
    if (data && track.wavetable) track.wavetable.data = data;
    scheduleSave();
}

function wavetableNote(track: Track, freq: number, velocity: number, duration: number, tone = 1) {
    const voice = tone === 1 ? track.voice : { ...track.voice, cutoff: toneCutoff(track.voice.cutoff, tone) };
    addon.Audio.playWavetableOnTrack(track.id, wavetableNoteConfig(track.id, voice, trackWavetable(track), { freq, velocity, duration }));
}

// A note's `tone` (Build's sweep, Echo Out's fade) scales the track's filter cutoff.
function toneCutoff(cutoff: number, tone: number): number {
    return Math.max(40, Math.min(20000, cutoff * tone));
}

function startHeldWavetableNote(track: Track, midi: number, velocity: number): number | null {
    const r = addon.Audio.wavetableNoteOn(track.id, wavetableNoteConfig(track.id, track.voice, trackWavetable(track), { freq: midiToFreq(midi), velocity }));
    return r.ok && r.voice !== undefined ? r.voice : null;
}

function releaseWavetableVoices(track: Track) {
    for (const v of Object.values(wtHeld[track.id] ?? {})) addon.Audio.wavetableNoteOff(v);
    wtHeld[track.id] = {};
    if (wtStroke[track.id] !== undefined) addon.Audio.wavetableNoteOff(wtStroke[track.id]);
    if (wtLatch[track.id] !== undefined) addon.Audio.wavetableNoteOff(wtLatch[track.id]);
    delete wtStroke[track.id];
    delete wtLatch[track.id];
}

function heldWavetableVoices(track: Track): number[] {
    const held = Object.values(wtHeld[track.id] ?? {});
    for (const v of [wtStroke[track.id], wtLatch[track.id]]) if (v !== undefined) held.push(v);
    return held;
}

function pressWavetableKey(track: Track, midi: number, velocity: number) {
    const v = startHeldWavetableNote(track, midi, velocity);
    if (v !== null) (wtHeld[track.id] ??= {})[midi] = v;
}

function releaseWavetableKey(track: Track, midi: number) {
    const v = wtHeld[track.id]?.[midi];
    if (v === undefined) return;
    addon.Audio.wavetableNoteOff(v);
    delete wtHeld[track.id][midi];
}

// While a stroke is in progress a note sounds (if "Hear while sculpting" is on), so the change is
// heard as it is made rather than after. A latched note already sounds, so a stroke adds nothing.
function beginStrokeAudition(track: Track) {
    const wt = trackWavetable(track);
    if (!wt.audition || wtStroke[track.id] !== undefined || wtLatch[track.id] !== undefined) return;
    const v = startHeldWavetableNote(track, wt.auditionNote, 0.8);
    if (v !== null) wtStroke[track.id] = v;
}

function endStrokeAudition(track: Track) {
    const v = wtStroke[track.id];
    if (v === undefined) return;
    addon.Audio.wavetableNoteOff(v);
    delete wtStroke[track.id];
}

function toggleLatch(track: Track) {
    const held = wtLatch[track.id];
    if (held !== undefined) {
        addon.Audio.wavetableNoteOff(held);
        delete wtLatch[track.id];
        return;
    }
    const v = startHeldWavetableNote(track, trackWavetable(track).auditionNote, 0.8);
    if (v !== null) wtLatch[track.id] = v;
}

// The position slider moves every note that is sounding through the table, so dragging it is heard.
function setWavetablePosition(track: Track, position: number) {
    const wt = trackWavetable(track);
    wt.position = Math.max(0, Math.min(1, position));
    for (const v of heldWavetableVoices(track)) addon.Audio.wavetableSetPosition(v, wt.position);
    scheduleSave();
}

function loadWavetablePreset(track: Track, preset: string) {
    const r = addon.Wavetable.ensure(track.id, { preset });
    if (!r.ok) { wtStatus = r.error ?? "That preset could not be loaded."; return; }
    const wt = trackWavetable(track);
    wt.preset = preset;
    // A bare waveform start clears whatever full patch was applied before - the table no longer
    // matches its settings, and a stale "Modulated Bass" label on a hand-cleared sine would lie.
    wt.instrumentPreset = undefined;
    saveTrackWavetable(track);
}

// A full patch: the table it is built from plus the motion/voice settings that make it read as
// "bass" or "strings" rather than a bare waveform (see WT_INSTRUMENT_PRESETS in daw_wavetable.ts).
// Applying one is exactly loadWavetablePreset's table load, plus the settings and the track's own
// Voice fields (filter, envelope) in one step.
function applyInstrumentPreset(track: Track, presetId: string) {
    const preset = instrumentPresetById(presetId);
    if (!preset) { wtStatus = `Unknown instrument preset "${presetId}".`; return; }
    const r = addon.Wavetable.ensure(track.id, { preset: preset.table });
    if (!r.ok) { wtStatus = r.error ?? "That preset could not be loaded."; return; }
    const wt = trackWavetable(track);
    wt.preset = preset.table;
    wt.instrumentPreset = preset.id;
    Object.assign(wt, preset.settings);
    Object.assign(track.voice, preset.voice);
    wtStatus = "";
    saveTrackWavetable(track);
}

function runWavetableOp(track: Track, op: string, arg?: number) {
    trackWavetable(track);
    const r = addon.Wavetable.op(track.id, op, arg);
    wtStatus = r.ok ? "" : (r.error ?? `${op} did not work`);
    if (r.ok) saveTrackWavetable(track);
}

// --- Bowed-string (physmod) tracks (see daw_physmod.ts and src/audio/physmod/) -------------------
//
// A synth track whose waveform is "physmod" plays a physically modeled bowed-string instrument: every
// note of the track goes to one live instrument on the track's bus (strings, bridge and body shared),
// so overlapping notes slur, simultaneous ones double-stop, and open strings ring in sympathy. There
// is no sculpted data to load/save - the instrument is rebuilt from what each note carries - so
// `trackPhysMod` just lazily defaults the settings.

const pmHeld: Record<string, Record<number, number>> = {};
const pmLatch: Record<string, number> = {};
let pmStatus = "";

function isPhysModTrack(track: Track): boolean {
    return track.kind === "synth" && !track.instrument && track.voice.waveform === PHYSMOD_WAVEFORM;
}

function trackPhysMod(track: Track): PhysModSettings {
    if (!track.physmod) track.physmod = defaultPhysMod();
    return track.physmod;
}

function savePhysMod(_track: Track) {
    scheduleSave();
}

function physModNote(track: Track, freq: number, velocity: number, duration: number) {
    addon.Audio.playPhysModOnTrack(track.id, physModNoteConfig(track.id, trackPhysMod(track), { freq, velocity, duration }));
}

function startHeldPhysModNote(track: Track, midi: number, velocity: number): number | null {
    const r = addon.Audio.physModNoteOn(track.id, physModNoteConfig(track.id, trackPhysMod(track), { freq: midiToFreq(midi), velocity }));
    return r.ok && r.voice !== undefined ? r.voice : null;
}

function releasePhysModVoices(track: Track) {
    for (const v of Object.values(pmHeld[track.id] ?? {})) addon.Audio.physModNoteOff(v);
    pmHeld[track.id] = {};
    if (pmLatch[track.id] !== undefined) addon.Audio.physModNoteOff(pmLatch[track.id]);
    delete pmLatch[track.id];
}

function heldPhysModVoices(track: Track): number[] {
    const held = Object.values(pmHeld[track.id] ?? {});
    if (pmLatch[track.id] !== undefined) held.push(pmLatch[track.id]);
    return held;
}

function pressPhysModKey(track: Track, midi: number, velocity: number) {
    const v = startHeldPhysModNote(track, midi, velocity);
    if (v !== null) (pmHeld[track.id] ??= {})[midi] = v;
}

function releasePhysModKey(track: Track, midi: number) {
    const v = pmHeld[track.id]?.[midi];
    if (v === undefined) return;
    addon.Audio.physModNoteOff(v);
    delete pmHeld[track.id][midi];
}

function togglePhysModLatch(track: Track) {
    const held = pmLatch[track.id];
    if (held !== undefined) {
        addon.Audio.physModNoteOff(held);
        delete pmLatch[track.id];
        return;
    }
    const v = startHeldPhysModNote(track, trackPhysMod(track).auditionNote, 0.8);
    if (v !== null) pmLatch[track.id] = v;
}

// The bow controls move every note that is sounding, so dragging the bow (in the Physics View or on
// a knob) is heard immediately - the same live-control convention `setWavetablePosition` follows.
function setBowLive(track: Track, which: "force" | "velocity" | "position" | "vibratoDepth", value: number) {
    for (const v of heldPhysModVoices(track)) addon.Audio.physModSetBow(v, which, value);
}

function loadPhysModInstrument(track: Track, instrumentId: string) {
    if (!applyPhysModPreset(trackPhysMod(track), instrumentId)) { pmStatus = `Unknown instrument "${instrumentId}".`; return; }
    pmStatus = "";
    savePhysMod(track);
}

// --- Brass tracks (see daw_brass.ts and src/audio/brass/) ------------------------------------
//
// A synth track whose waveform is "brass" is played by a physically modeled brass player: every note
// of the track goes to one live player on the track's bus (the same lips, the same instrument), so a
// note that starts before the last one ends slurs into it. Like the bowed string there is no data
// to load or save beyond the settings.

const brHeld: Record<string, Record<number, number>> = {};
const brLatch: Record<string, number> = {};
/** The pitch bend (cents) a slide drag has put on a track's held notes. */
const brBend: Record<string, number> = {};
let brStatus = "";

function isBrassTrack(track: Track): boolean {
    return track.kind === "synth" && !track.instrument && track.voice.waveform === BRASS_WAVEFORM;
}

function trackBrass(track: Track): BrassSettings {
    if (!track.brass) track.brass = defaultBrass();
    return track.brass;
}

function brassNote(track: Track, freq: number, velocity: number, stepSeconds: number) {
    const b = trackBrass(track);
    addon.Audio.playBrassOnTrack(track.id, brassNoteConfig(track.id, b, { freq, velocity, duration: brassHeldSeconds(b, stepSeconds) }));
}

function startHeldBrassNote(track: Track, midi: number, velocity: number): number | null {
    const r = addon.Audio.brassNoteOn(track.id, brassNoteConfig(track.id, trackBrass(track), { freq: midiToFreq(midi), velocity }));
    return r.ok && r.voice !== undefined ? r.voice : null;
}

function heldBrassVoices(track: Track): number[] {
    const held = Object.values(brHeld[track.id] ?? {});
    if (brLatch[track.id] !== undefined) held.push(brLatch[track.id]);
    return held;
}

function releaseBrassVoices(track: Track) {
    for (const v of heldBrassVoices(track)) addon.Audio.brassNoteOff(v);
    brHeld[track.id] = {};
    delete brLatch[track.id];
    delete brBend[track.id];
}

function pressBrassKey(track: Track, midi: number, velocity: number) {
    const v = startHeldBrassNote(track, midi, velocity);
    if (v !== null) (brHeld[track.id] ??= {})[midi] = v;
    delete brBend[track.id];
}

function releaseBrassKey(track: Track, midi: number) {
    const v = brHeld[track.id]?.[midi];
    if (v === undefined) return;
    addon.Audio.brassNoteOff(v);
    delete brHeld[track.id][midi];
}

function toggleBrassLatch(track: Track) {
    const held = brLatch[track.id];
    if (held !== undefined) {
        addon.Audio.brassNoteOff(held);
        delete brLatch[track.id];
        return;
    }
    const v = startHeldBrassNote(track, trackBrass(track).auditionNote, 0.8);
    if (v !== null) brLatch[track.id] = v;
    delete brBend[track.id];
}

// Breath, lips, vibrato and bend move every note that is sounding, so a drag in the view or a
// knob is heard at once - the convention the bowed string's setBowLive follows.
function setBrassLive(track: Track, which: "breath" | "lipTension" | "vibratoDepth" | "bend", value: number) {
    for (const v of heldBrassVoices(track)) addon.Audio.brassSetControl(v, which, value);
}

/** A drag on the slide in the view: bends the held notes to where the slide was put. */
function dragBrassSlide(track: Track, position: number) {
    const info = addon.Brass.info(track.id);
    if (!info.ok || !info.playing || info.position === undefined) return;
    // The note's own position is where the slide sits with no bend.
    const notePosition = info.position + (brBend[track.id] ?? 0) / 100;
    brBend[track.id] = bendForSlide(position, notePosition);
    setBrassLive(track, "bend", brBend[track.id]);
}

function playBrassStyle(track: Track, id: string) {
    const b = trackBrass(track);
    if (!applyBrassStyle(b, id)) { brStatus = `Unknown style "${id}".`; return; }
    brStatus = "";
    setBrassLive(track, "breath", b.breath);
    setBrassLive(track, "lipTension", b.lipTension);
    setBrassLive(track, "vibratoDepth", b.vibratoDepth);
    scheduleSave();
}

function loadBrassInstrument(track: Track, id: string) {
    if (!applyBrassInstrument(trackBrass(track), id)) { brStatus = `Unknown instrument "${id}".`; return; }
    brStatus = "";
    rebuildBrass(track);
}

/** The instrument, its mute, the hand and the bell make the air column, which a note is built
 *  with: a change is heard from the next note. A held "Hold a note" is played again at once, so the
 *  change can be heard. */
function rebuildBrass(track: Track) {
    if (brLatch[track.id] !== undefined) {
        toggleBrassLatch(track);
        toggleBrassLatch(track);
    }
    scheduleSave();
}

function setBrassMute(track: Track, id: string) {
    if (!applyBrassMute(trackBrass(track), id)) { brStatus = `Unknown mute "${id}".`; return; }
    brStatus = "";
    rebuildBrass(track);
}

// --- Drum-kit tracks (see daw_matter.ts and src/audio/matter/) ------------------------------
//
// A synth track whose waveform is "matter" is a physically modeled drum kit. Its rows are the kit's
// rows (kick at the top, like a drum track's pads), and every hit lands on one live kit on the
// track's bus, so the pieces ring on and hear each other. The kit is built off the audio thread (a
// second or so the first time, then from the cache), so it is prepared as soon as the track becomes
// a kit or the song loads; hits sent while it is first being built are dropped. A retuned kit is
// built while the old one keeps playing.

/** The kit each track's hits go to: what was last handed to the engine. Knob drags change the
 *  track's settings at once but are committed only when the knob has been still for a moment, so a
 *  drag does not start a build per step. */
const mtKit: Record<string, MatterKit> = {};
const mtCommitDue: Record<string, number> = {};
const mtBuild: Record<string, string> = {};
let mtStatus = "";
const MATTER_COMMIT_MS = 350;

function isMatterTrack(track: Track): boolean {
    return track.kind === "synth" && !track.instrument && track.voice.waveform === MATTER_WAVEFORM;
}

function trackMatter(track: Track): MatterSettings {
    if (!track.matter) track.matter = defaultMatter();
    if (track.rows !== MATTER_ROWS.length) track.rows = MATTER_ROWS.length;
    return track.matter;
}

/** Hands the track's kit to the engine (building it if it is new) and notes where the build is. */
function prepareMatter(track: Track) {
    const m = trackMatter(track);
    if (!mtKit[track.id]) mtKit[track.id] = { ...m.kit };
    const r = addon.Audio.prepareMatter(track.id, { kitId: track.id, kit: mtKit[track.id] });
    mtBuild[track.id] = r.ok ? (r.status ?? "building") : "error";
    if (!r.ok) mtStatus = `${track.name}: the kit could not be prepared (${r.error}).`;
}

/** Commits the track's kit settings now (a preset, the AI tool) rather than after a knob settles. */
function commitMatter(track: Track) {
    const m = trackMatter(track);
    const was = mtKit[track.id];
    mtKit[track.id] = { ...m.kit };
    delete mtCommitDue[track.id];
    if (!was || !sameMatterBuild(was, m.kit) || was.sympathetic !== m.kit.sympathetic) prepareMatter(track);
}

/** A kit knob moved: heard once it has been still for a moment (see mtKit). */
function touchMatterKit(track: Track) {
    mtCommitDue[track.id] = Date.now() + MATTER_COMMIT_MS;
    scheduleSave();
}

function commitDueMatter() {
    const now = Date.now();
    for (const id of Object.keys(mtCommitDue)) {
        const t = findTrack(id);
        if (!t || !isMatterTrack(t)) { delete mtCommitDue[id]; continue; }
        if (now >= mtCommitDue[id]) commitMatter(t);
    }
}

function playMatterHit(track: Track, hit: MatterHit) {
    const r = addon.Audio.playMatterOnTrack(track.id, { ...hit, kit: mtKit[track.id] ?? hit.kit });
    if (!r.ok) mtStatus = `${track.name}: ${r.error}`;
    else if (r.played === false) mtBuild[track.id] = "building";
}

function matterRowHit(track: Track, row: number, velocity: number) {
    playMatterHit(track, matterHitConfig(track.id, trackMatter(track), { row, velocity }));
}

function loadMatterPreset(track: Track, id: string) {
    if (!applyMatterPreset(trackMatter(track), id)) { mtStatus = `Unknown kit "${id}".`; return; }
    mtStatus = "";
    commitMatter(track);
    scheduleSave();
}

// --- Persistent per-track mixing bus (see src/audio/mod.rs's TrackBus) -----------------------

function ensureTrackEffects(track: Track) {
    if (!track.delayEffectId) {
        track.delayEffectId = addon.AudioEffect.createDelay({
            time: track.voice.delayTime, feedback: track.voice.delayFeedback, mix: track.voice.delayMix
        });
    }
    if (!track.reverbEffectId) {
        track.reverbEffectId = addon.AudioEffect.createReverb({
            roomSize: track.voice.reverbRoomSize, time: track.voice.reverbTime,
            damping: track.voice.reverbDamping, mix: track.voice.reverbMix
        });
    }
}

// --- Character effects on the bus (see daw_moves.ts and src/audio/character.rs) -------------------
//
// Grit, Gate, Space and Pump are effects on the track's bus, after its delay and reverb, and a
// fader at the very end silences the track through a Drop Gap hard cut. Runtime only: effect ids
// are per-session handles, like the delay and reverb ids. An effect whose knob is at zero is left
// out of the chain, so an untouched track costs nothing.

type CharacterKind = "grit" | "gate" | "space" | "pump" | "fader";
const characterIds: Record<string, Partial<Record<CharacterKind, string>>> = {};
// Whether each track's cut fader is currently closed.
const cutClosed: Record<string, boolean> = {};

function trackCharacter(track: Track): Character {
    if (!track.character) track.character = repairCharacter(null);
    return track.character;
}

function projectCuts(): HardCut[] {
    if (!project.cuts) project.cuts = [];
    return project.cuts;
}

function characterEffect(track: Track, kind: CharacterKind, config: { amount: number; pattern?: number; bpm?: number; beat?: number }): string {
    const ids = characterIds[track.id] ?? (characterIds[track.id] = {});
    const full = { kind, amount: config.amount, pattern: config.pattern ?? 0, bpm: config.bpm ?? project.bpm, beat: config.beat };
    const existing = ids[kind];
    if (existing) {
        addon.AudioEffect.setCharacterParams(existing, full);
        return existing;
    }
    const id = addon.AudioEffect.createCharacter(full);
    ids[kind] = id;
    return id;
}

// The whole chain for a track's bus, creating whatever effects it needs.
function busEffectIds(track: Track): string[] {
    ensureTrackEffects(track);
    const ids = [track.delayEffectId!, track.reverbEffectId!];
    for (const fx of busEffects(trackCharacter(track), project.bpm)) {
        ids.push(characterEffect(track, fx.kind, { amount: fx.amount, pattern: fx.pattern, bpm: fx.bpm }));
    }
    if (projectCuts().some(c => c.trackIds.includes(track.id))) {
        ids.push(characterEffect(track, "fader", { amount: cutClosed[track.id] ? 0 : 1 }));
    }
    return ids;
}

// Where the song is in its bar, in beats (0..4) - what Pump and Gate's clocks are set to.
function barBeat(): number {
    const beats = currentStepFloat() / Math.max(1, project.stepsPerBeat);
    return ((beats % 4) + 4) % 4;
}

// Puts every Pump and Gate on the beat: when the transport starts, seeks or changes tempo, and
// once a bar while it runs (the audio clock and the frame clock drift apart very slowly).
function syncTempoEffects() {
    const beat = barBeat();
    for (const track of project.tracks) {
        const ids = characterIds[track.id];
        if (!ids) continue;
        const ch = trackCharacter(track);
        const pattern = Math.max(0, GATE_PATTERNS.indexOf(ch.gatePattern));
        if (ids.pump && ch.pump > 0) addon.AudioEffect.setCharacterParams(ids.pump, { kind: "pump", amount: ch.pump, pattern, bpm: project.bpm, beat });
        if (ids.gate && ch.gate > 0) addon.AudioEffect.setCharacterParams(ids.gate, { kind: "gate", amount: ch.gate, pattern, bpm: project.bpm, beat });
    }
}

// Opens or closes each track's cut fader for where the song is now. Only song playback cuts.
function updateCuts(songStep: number | null) {
    for (const track of project.tracks) {
        const ids = characterIds[track.id];
        const closed = songStep !== null && isCut(projectCuts(), track.id, songStep);
        if (!!cutClosed[track.id] === closed) continue;
        cutClosed[track.id] = closed;
        if (ids?.fader) addon.AudioEffect.setCharacterParams(ids.fader, { kind: "fader", amount: closed ? 0 : 1 });
    }
}

const BUILT_IN_OSCILLATORS = ["sine", "square", "saw", "triangle", "noise"];

// Whether Acid's filter envelope and drive reach this track's sound: only the built-in oscillators
// have them. A wavetable track still follows the cutoff and resonance Acid writes.
function acidApplies(track: Track): boolean {
    return track.kind === "synth" && !track.instrument && BUILT_IN_OSCILLATORS.includes(track.voice.waveform);
}

type KnobName = "pump" | "bounce" | "gate" | "acid" | "grit" | "space" | "humanize";
const KNOB_NAMES: KnobName[] = ["pump", "bounce", "gate", "acid", "grit", "space", "humanize"];

// One Character knob moved. Knobs report every step of a drag, so this updates only this track's
// bus and leaves the save to the debounce (see scheduleSave).
function setCharacterKnob(track: Track, knob: KnobName, value: number) {
    if (!Number.isFinite(value)) return;
    const ch = trackCharacter(track);
    const v = Math.max(0, Math.min(1, value));
    if (knob === "acid") applyAcid(track.voice, ch, v);
    else ch[knob] = v;
    syncTrackBus(track);
    if (knob === "pump" || knob === "gate") syncTempoEffects();
    scheduleSave();
}

function setGatePattern(track: Track, pattern: Character["gatePattern"]) {
    trackCharacter(track).gatePattern = pattern;
    syncTrackBus(track);
    syncTempoEffects();
    scheduleSave();
}

// Pushes one track's current gain/mute/solo/FX params into the engine's persistent bus for that
// track - creating the bus (and its two effect instances) on first call. Cheap to call on every
// edit: the DAW's sliders are click-to-set rather than continuous-drag, so this fires once per
// interaction, not once per frame.
function syncTrackBus(track: Track) {
    if (isWavetableTrack(track)) trackWavetable(track);
    if (isPhysModTrack(track)) trackPhysMod(track);
    if (isBrassTrack(track)) trackBrass(track);
    if (isMatterTrack(track)) trackMatter(track);
    ensureTrackEffects(track);
    addon.AudioEffect.setDelayParams(track.delayEffectId!, {
        time: track.voice.delayTime, feedback: track.voice.delayFeedback, mix: track.voice.delayMix
    });
    addon.AudioEffect.setReverbParams(track.reverbEffectId!, {
        roomSize: track.voice.reverbRoomSize, time: track.voice.reverbTime,
        damping: track.voice.reverbDamping, mix: track.voice.reverbMix
    });
    addon.Audio.ensureTrackBus(track.id, {
        gain: track.gain, muted: track.muted, solo: track.solo,
        effectIds: busEffectIds(track)
    });
    // A kit needs the bus it plays on; it is built (once) as soon as there is one.
    if (isMatterTrack(track)) prepareMatter(track);
}

function removeTrackBus(track: Track) {
    releaseWavetableVoices(track);
    if (wtLoaded[track.id]) addon.Wavetable.remove(track.id);
    delete wtLoaded[track.id];
    releasePhysModVoices(track);
    addon.PhysMod.remove(track.id);
    releaseBrassVoices(track);
    addon.Brass.remove(track.id);
    addon.Audio.removeMatter(track.id);
    addon.Matter.remove(track.id);
    delete mtKit[track.id];
    delete mtCommitDue[track.id];
    delete mtBuild[track.id];
    addon.Vst3.unload(track.id);
    delete vst3Runtime[track.id];
    addon.Audio.removeTrackBus(track.id);
    if (track.delayEffectId) addon.AudioEffect.destroy(track.delayEffectId);
    if (track.reverbEffectId) addon.AudioEffect.destroy(track.reverbEffectId);
    for (const id of Object.values(characterIds[track.id] ?? {})) if (id) addon.AudioEffect.destroy(id);
    delete characterIds[track.id];
    delete cutClosed[track.id];
}

function removeTrack(track: Track) {
    removeTrackBus(track);
    project.tracks = project.tracks.filter(t => t.id !== track.id);
    project.arrangement = project.arrangement.filter(c => c.trackId !== track.id);
    if (selectedClipId && !project.arrangement.some(c => c.id === selectedClipId)) selectedClipId = null;
    if (project.activeTrackId === track.id) {
        project.activeTrackId = project.tracks[0]?.id ?? null;
    }
}

// --- VST3 instruments (see src/audio/vst3.rs) --------------------------------------------------
//
// A track with an `instrument` sends its notes to a hosted plugin instead of the built-in voice.
// The plugin's audio joins the track's own bus, so gain/mute/solo and the Effects section apply to
// it unchanged. Runtime status lives here, not on the Track, so it never reaches the saved project.

interface Vst3Runtime {
    ok: boolean;
    status: string;
    peak: number;
}

const vst3Runtime: Record<string, Vst3Runtime> = {};
let vst3Catalog: { name: string; vendor: string; path: string; hasGui: boolean }[] = [];
let vst3ScanStatus = "Not scanned yet";

function vst3Slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function scanVst3Plugins(refresh: boolean) {
    const result = addon.Vst3.scan(refresh);
    vst3Catalog = result.plugins.filter((p: any) => p.isInstrument);
    const others = result.plugins.length - vst3Catalog.length;
    vst3ScanStatus = `${vst3Catalog.length} instrument${vst3Catalog.length === 1 ? "" : "s"} found`
        + (others > 0 ? ` (${others} effect/other plugin${others === 1 ? "" : "s"} not listed - MIDI-out effects like MIDI Guitar are not supported yet)` : "")
        + (result.skipped.length > 0 ? `, ${result.skipped.length} could not be read` : "");
}

function loadTrackInstrument(track: Track, instrument: Vst3Instrument) {
    addon.Audio.ensureTrackBus(track.id, {
        gain: track.gain, muted: track.muted, solo: track.solo,
        effectIds: busEffectIds(track)
    });
    const result = addon.Vst3.load(track.id, { path: instrument.path, state: instrument.state ?? null });
    if (result.ok) {
        track.instrument = instrument;
        vst3Runtime[track.id] = {
            ok: true, peak: 0,
            status: `${result.name} loaded in ${result.loadMs}ms, ${result.parameterCount} parameters` + (result.hasEditor ? "" : ", no editor")
        };
    } else {
        // Keep the choice on the track so a plugin that is only temporarily broken is not forgotten.
        track.instrument = instrument;
        vst3Runtime[track.id] = { ok: false, peak: 0, status: `Could not load ${instrument.name}: ${result.error}` };
    }
    return result;
}

function clearTrackInstrument(track: Track) {
    addon.Vst3.unload(track.id);
    delete vst3Runtime[track.id];
    track.instrument = null;
}

function trackUsesVst3(track: Track): boolean {
    return !!track.instrument && vst3Runtime[track.id]?.ok === true;
}

function midiForRow(track: Track, row: number): number {
    if (track.kind === "drum") return (padAt(track, row) ?? padAt(track, 0))?.midi ?? 36;
    return rowToMidi(row, track.rootNote, track.scale);
}

function playVst3Note(track: Track, row: number, velocity: number, duration: number) {
    addon.Vst3.noteOn(track.id, {
        note: midiForRow(track, row),
        velocity: Math.max(1, Math.min(127, Math.round(velocity * 127))),
        duration
    });
}

function persist() {
    writeProject();
    project.tracks.forEach(syncTrackBus);
}

// A clip drag reports a new position every frame. Writing the project (which can carry a
// plugin's whole saved patch) that often is wasteful, so drags only mark it dirty and the frame
// loop writes it once the pointer has been still for a moment.
const SAVE_DEBOUNCE_MS = 250;
let saveDueAt = 0;

function scheduleSave() {
    saveDueAt = Date.now() + SAVE_DEBOUNCE_MS;
}

function flushSaveIfDue() {
    if (saveDueAt && Date.now() >= saveDueAt) writeProject();
}

/** Writes a save the debounce is still holding, before anything reads the song from disk. */
function flushPendingSave() {
    if (saveDueAt) writeProject();
}

// --- Transport / sequencer --------------------------------------------------

type TransportMode = "song" | "pattern";

const transport = {
    playing: false,
    // Wall-clock second the current run's step 0 would have started at (shifted on seek/BPM change).
    startedAt: 0,
    // Last absolute (never-wrapped) step that has been triggered.
    lastAbsStep: -1,
    // Where the playhead is, in steps, while stopped and (updated each frame) while playing.
    cursorStep: 0,
    mode: "song" as TransportMode
};

function stepDuration(): number {
    return stepMs(project.bpm, project.stepsPerBeat) / 1000;
}

function nowSeconds(): number {
    return Date.now() / 1000;
}

function noteVoiceAndFreq(track: Track, row: number): { voice: string; freq: number } {
    if (track.kind === "drum") {
        const d = padAt(track, row);
        return { voice: d?.voice ?? "", freq: d?.freq ?? 200 };
    }
    return { voice: track.voice.waveform, freq: midiToFreq(rowToMidi(row, track.rootNote, track.scale)) };
}

// --- Drum rack ---------------------------------------------------------------------------------
//
// A drum track's rows are the pads of its rack (see daw_rack.ts). The browser on the left of the
// rack panel lists the Music folder (or any folder the user picks); clicking a file auditions it
// and arms it, and the next click on a pad puts it there. The decoded sample lives in the audio
// engine, keyed by path; what is saved with the project is only the path and the pad's settings.

// Runtime only, never saved: what the engine decoded for each path, the paths that could not be
// read, and when each pad was last hit (for its glow).
const sampleInfo: Record<string, SampleInfo> = {};
const sampleMissing: Record<string, string> = {};
const padHits: Record<string, number> = {};

const WAVE_BINS = 64;
const GLOW_MS = 260;
const AUDITION_GAIN = 0.9;

const rackUi = {
    browser: newBrowser(),
    /** The pad shown in the editor next to the grid. */
    selectedPad: 0,
    /** A file was just picked in the browser: the next pad click puts it on that pad. */
    armed: false,
    status: "",
    browserReady: false,
};

const isSampleMissing = (path: string) => path in sampleMissing;

const listDir = (path: string): ListDirResult => addon.IO.listDir(path);

function loadSampleInfo(path: string): SampleInfo | null {
    const info = addon.Audio.loadSample(path, WAVE_BINS);
    if (info.ok) {
        sampleInfo[path] = info;
        delete sampleMissing[path];
        return info;
    }
    delete sampleInfo[path];
    sampleMissing[path] = info.error ?? "could not be read";
    return null;
}

// Decodes every sample a saved rack refers to, so the first hit never waits on a decode and a
// moved or deleted file shows up as a red pad the moment the project opens.
function verifyRacks() {
    for (const t of project.tracks) {
        if (t.kind !== "drum") continue;
        for (const pad of ensureRack(t)) if (pad.sample) loadSampleInfo(pad.sample.path);
    }
}

function padGlow(track: Track, row: number): number {
    const at = padHits[`${track.id}:${row}`];
    if (!at) return 0;
    const age = Date.now() - at;
    return age >= GLOW_MS ? 0 : Math.pow(1 - age / GLOW_MS, 2);
}

// Plays one hit of a pad: its sample if it has one, otherwise the built-in voice. Used by the
// sequencer, the pad grid and the Preview buttons alike, so what you click is what the song plays.
function playPad(track: Track, row: number, velocity: number, duration: number, tone = 1) {
    const pad = padAt(track, row);
    if (!pad) return;
    const hit = padHit(pad, velocity, duration, isSampleMissing);
    if (!hit) return;
    padHits[`${track.id}:${row}`] = Date.now();
    if (hit.type === "sample") {
        const r = addon.Audio.playSampleOnTrack(track.id, hit.path, {
            gain: hit.gain, semitones: hit.semitones, start: hit.start, end: hit.end, hold: hit.hold
        });
        if (!r.ok) sampleMissing[hit.path] = r.error ?? "could not be played";
        return;
    }
    addon.Audio.playNoteOnTrack(track.id, {
        freq: hit.freq, waveform: hit.voice, duration,
        cutoff: toneCutoff(track.voice.cutoff, tone), resonance: track.voice.resonance, gain: velocity,
        attack: track.voice.attack, decay: track.voice.decay, sustain: track.voice.sustain, release: track.voice.release
    });
}

function ensureBrowserRoot() {
    if (rackUi.browserReady) return;
    rackUi.browserReady = true;
    const music = addon.IO.musicDir();
    if (music) setRoot(rackUi.browser, music, listDir);
    else rackUi.status = "No Music folder was found. Use Folder... to choose one.";
}

function openMusicFolder() {
    const music = addon.IO.musicDir();
    if (!music) { rackUi.status = "No Music folder was found. Use Folder... to choose one."; return; }
    setRoot(rackUi.browser, music, listDir);
    rackUi.armed = false;
    rackUi.status = "";
}

function pickSampleFolder() {
    const dir = addon.IO.pickSampleFolder();
    if (!dir) return;
    setRoot(rackUi.browser, dir, listDir);
    rackUi.armed = false;
    rackUi.status = "";
}

function refreshRack() {
    refreshBrowser(rackUi.browser, listDir);
    for (const path of Object.keys(sampleMissing)) delete sampleMissing[path];
    verifyRacks();
    rackUi.status = "Folders and samples read again.";
}

// A click on a tree row: a folder opens or closes, a file is auditioned and armed for the next pad.
function onBrowserSelect(path: string) {
    const b = rackUi.browser;
    if (isListedFile(b, path)) {
        b.selected = path;
        rackUi.armed = true;
        const info = loadSampleInfo(path);
        if (!info) { rackUi.armed = false; rackUi.status = `${stem(path)}: ${sampleMissing[path]}`; return; }
        rackUi.status = "";
        addon.Audio.previewSample(path, { gain: AUDITION_GAIN });
    } else {
        toggleFolder(b, path, listDir);
    }
}

function onBrowserToggle(path: string) {
    toggleFolder(rackUi.browser, path, listDir);
}

function onPadClick(track: Track, row: number) {
    const rack = ensureRack(track);
    if (row < 0 || row >= rack.length) return;
    rackUi.selectedPad = row;
    const file = rackUi.browser.selected;
    if (rackUi.armed && file) {
        const info = loadSampleInfo(file);
        if (!info) {
            rackUi.status = `Could not load ${stem(file)}: ${sampleMissing[file]}`;
        } else {
            addon.Audio.stopPreview();
            const pad = assignSample(track, row, { path: file })!;
            rackUi.armed = false;
            // A pad that just took the file's name would read "kick is on kick".
            rackUi.status = (pad.name === pad.sample!.name ? `${pad.sample!.name} is on pad ${row + 1}.` : `${pad.sample!.name} is on ${pad.name}.`)
                + (info.truncated ? ` Only the first ${formatSeconds(info.seconds)} of the file is used.` : "");
            persist();
        }
    }
    playPad(track, row, 1, 0.5);
}

function onPadClear(track: Track, row: number) {
    const pad = clearSample(track, row);
    if (!pad) return;
    rackUi.status = `${pad.name} is back to ${pad.voice ? "its built-in voice" : "empty"}.`;
    persist();
}

function onPadAdd(track: Track) {
    const pad = addPad(track);
    if (!pad) { rackUi.status = `A rack holds ${MAX_PADS} pads.`; return; }
    rackUi.selectedPad = track.rack!.length - 1;
    persist();
}

const PAD_ID_ROW = (id: string) => parseInt(id, 10);

function padConfig(track: Track, pad: DrumPad, row: number) {
    const status = padStatus(pad, isSampleMissing);
    const info = pad.sample ? sampleInfo[pad.sample.path] : undefined;
    const [r, g, b] = TRACK_PALETTE[padPaletteIndex(track.colorIndex, row, TRACK_PALETTE.length)];
    return {
        id: String(row),
        label: pad.name || `Pad ${row + 1}`,
        sublabel: pad.sample ? pad.sample.name : "",
        hint: midiToName(pad.midi),
        color: [r / 255, g / 255, b / 255, 1] as [number, number, number, number],
        kind: status,
        waveform: info?.waveform,
        trim: pad.sample ? [pad.sample.start, pad.sample.end] as [number, number] : undefined,
        selected: row === rackUi.selectedPad,
        glow: padGlow(track, row)
    };
}

function sampleDetails(info: SampleInfo): string {
    const length = info.truncated && info.fullSeconds
        ? `${formatSeconds(info.seconds)} of ${formatSeconds(info.fullSeconds)}`
        : formatSeconds(info.seconds);
    const peak = info.peak > 0.00001 ? `${(20 * Math.log10(info.peak)).toFixed(1)} dBFS` : "silent";
    return `${length}  |  ${(info.sourceRate / 1000).toFixed(1)} kHz ${info.channels === 1 ? "mono" : "stereo"}  |  peak ${peak}`;
}

function renderSampleBrowser(win: string) {
    const W = Entropy.UI.Widget;
    const b = rackUi.browser;
    ensureBrowserRoot();

    W.group(win, (g: string) => {
        W.label(g, { text: "Sample Browser", bold: true });
        W.horizontal(g, (h: string) => {
            W.button(h, { text: withIcon("music-notes", "Music"), id: "browser_music", onClick: openMusicFolder });
            W.button(h, { text: "Folder...", id: "browser_pick", onClick: pickSampleFolder });
            W.button(h, { text: "Refresh", id: "browser_refresh", onClick: refreshRack });
        });
        W.textInput(g, {
            label: "Filter", id: "browser_filter", value: b.filter, width: 236,
            onChange: (v: string) => { b.filter = v; }
        });

        if (!b.root) {
            W.label(g, { text: "Choose Music or a folder of samples to begin." });
            return;
        }

        W.treeView(g, {
            id: "sample_tree", width: 330, maxHeight: 300,
            nodes: browserRows(b).map(r => ({
                id: r.id, label: r.label, depth: r.depth, hasChildren: r.hasChildren,
                expanded: r.expanded, selected: r.selected, icon: r.icon, detail: r.detail
            })),
            onSelect: onBrowserSelect,
            onToggleExpand: onBrowserToggle
        });

        const picked = b.selected && isListedFile(b, b.selected) ? b.selected : null;
        const info = picked ? sampleInfo[picked] : undefined;
        if (picked && info) {
            W.padGrid(g, {
                id: "browser_preview", columns: 1, padWidth: 330, padHeight: 76,
                pads: [{
                    id: "0", label: stem(picked), kind: "sample", waveform: info.waveform,
                    color: [0.42, 0.72, 0.98, 1], hint: rackUi.armed ? "ARMED" : "", selected: rackUi.armed
                }],
                onPadClick: () => { addon.Audio.previewSample(picked, { gain: AUDITION_GAIN }); }
            });
            W.label(g, { text: sampleDetails(info) });
            W.horizontal(g, (h: string) => {
                W.button(h, { text: "Play", id: "browser_play", onClick: () => { addon.Audio.previewSample(picked, { gain: AUDITION_GAIN }); } });
                W.button(h, { text: "Stop", id: "browser_stop", onClick: () => { addon.Audio.stopPreview(); } });
            });
        } else {
            W.label(g, { text: "Click a file to hear it." });
        }
    });
}

function renderPadBank(win: string, track: Track) {
    const W = Entropy.UI.Widget;
    const rack = ensureRack(track);
    W.group(win, (g: string) => {
        W.label(g, { text: `Pads  ${rack.length}/${MAX_PADS}`, bold: true });
        W.padGrid(g, {
            id: `rack_pads_${track.id}`, columns: 4, padWidth: 128, padHeight: 84, addTile: rack.length < MAX_PADS,
            pads: rack.map((pad, row) => padConfig(track, pad, row)),
            onPadClick: (id: string) => onPadClick(track, PAD_ID_ROW(id)),
            onPadClear: (id: string) => onPadClear(track, PAD_ID_ROW(id)),
            onAdd: () => onPadAdd(track)
        });
        const armed = rackUi.armed && rackUi.browser.selected ? stem(rackUi.browser.selected) : null;
        W.label(g, {
            text: rackUi.status
                || (armed ? `Click a pad to put ${armed} on it.` : "Click a pad to hear it. Right-click a pad to take its sample off.")
        });
    });
}

function renderPadEditor(win: string, track: Track) {
    const W = Entropy.UI.Widget;
    const rack = ensureRack(track);
    const row = Math.min(rackUi.selectedPad, rack.length - 1);
    const pad = rack[row];
    if (!pad) return;
    const missing = pad.sample ? isSampleMissing(pad.sample.path) : false;

    W.group(win, (g: string) => {
        W.label(g, { text: `Pad ${row + 1}`, bold: true });
        W.textInput(g, {
            label: "Name", id: "pad_name", value: pad.name, width: 200,
            onChange: (v: string) => { pad.name = v.slice(0, 24); scheduleSave(); }
        });

        const s = pad.sample;
        if (s) {
            const info = sampleInfo[s.path];
            W.padGrid(g, {
                id: "pad_detail", columns: 1, padWidth: 340, padHeight: 108,
                pads: [{ ...padConfig(track, pad, row), id: "0", selected: false, glow: padGlow(track, row) }],
                onPadClick: () => playPad(track, row, 1, 0.5)
            });
            W.label(g, { text: missing ? `File missing: ${sampleMissing[s.path]}` : (info ? sampleDetails(info) : "Loading...") });
            W.slider(g, { label: "Sample gain", value: s.gain, min: 0, max: 2, onChange: (v: string) => { editSample(pad, { gain: parseFloat(v) }); scheduleSave(); } });
            W.slider(g, { label: "Pitch (semitones)", value: s.semitones, min: -12, max: 12, onChange: (v: string) => { editSample(pad, { semitones: parseFloat(v) }); scheduleSave(); } });
            W.slider(g, { label: "Start", value: s.start, min: 0, max: 1, onChange: (v: string) => { editSample(pad, { start: parseFloat(v) }); scheduleSave(); } });
            W.slider(g, { label: "End", value: s.end, min: 0, max: 1, onChange: (v: string) => { editSample(pad, { end: parseFloat(v) }); scheduleSave(); } });
            W.checkbox(g, {
                label: "Gate (stop when the note ends)", value: s.gate,
                onChange: (v: any) => { editSample(pad, { gate: v === true || v === "true" }); persist(); }
            });
            W.horizontal(g, (h: string) => {
                W.button(h, { text: "Play", id: "pad_play", onClick: () => playPad(track, row, 1, 0.5) });
                W.button(h, { text: pad.voice ? "Use built-in voice" : "Clear", id: "pad_clear", onClick: () => onPadClear(track, row) });
            });
        } else {
            W.label(g, {
                text: pad.voice
                    ? `This pad plays the built-in ${pad.voice} voice.`
                    : "This pad is empty."
            });
            W.label(g, { text: "Pick a sample in the browser," });
            W.label(g, { text: "then click this pad to put it here." });
            W.button(g, { text: "Play", id: "pad_play", onClick: () => playPad(track, row, 1, 0.5) });
        }
    });
}

// The rack lives in a floating window, like the Analyzer: the arrangement is 16 lanes tall, so a
// section of the tab would sit below the fold exactly when you want to put a sample on a pad. The
// browser is always there (you can audition with no drum track picked); the pads and the pad editor
// follow the drum track you have selected.
let rackWindowId: string | null = null;
let rackVisible = false;

function setRackVisible(visible: boolean) {
    rackVisible = visible;
    if (rackWindowId) Entropy.UI.setWindowVisible(rackWindowId, visible);
}

// --- Guitar input ------------------------------------------------------------------------------
// The engine is Rust (src/guitar, GUITAR_TO_MIDI.md) and this is only its panel: choose an input,
// start it, watch what it hears, and record a take into a new track. Notes play the built-in voice on
// the chosen track, or that track's VST3 instrument when it has one. Nothing per-buffer comes to JS.

let guitarWindowId: string | null = null;
let guitarVisible = false;
let guitarStatus: any = { running: false };
let guitarDevices: { host: string; name: string; channels: number; defaultSampleRate: number; isDefault: boolean }[] = [];
let guitarMessage = "";
let guitarPolledAt = 0;
let guitarRecording = false;
const guitarHints = new SignalHints();

function guitarPrefs(): GuitarPrefs {
    if (!project.guitar) project.guitar = defaultGuitarPrefs();
    return project.guitar;
}

function setGuitarVisible(visible: boolean) {
    guitarVisible = visible;
    if (guitarWindowId) Entropy.UI.setWindowVisible(guitarWindowId, visible);
    if (visible && guitarDevices.length === 0) refreshGuitarDevices();
    // The drum rack is wide and starts at the top left, which is where this panel opens: showing one
    // hides the other rather than leaving the rack over half of the guitar controls.
    if (visible && rackVisible) setRackVisible(false);
}

function refreshGuitarDevices() {
    guitarDevices = addon.Guitar.listInputs().devices;
    guitarMessage = guitarDevices.length === 0
        ? "No audio inputs found. Plug in the interface or cable, then Refresh."
        : `${guitarDevices.length} input${guitarDevices.length === 1 ? "" : "s"} found.`;
}

// Where the notes go: the target track's VST3 instrument if it has a working one, else the built-in
// voice on its bus.
function guitarTargetTrack(prefs: GuitarPrefs): Track | undefined {
    return project.tracks.find(t => t.id === prefs.targetTrackId && t.kind === "synth")
        ?? project.tracks.find(t => t.kind === "synth");
}

// The "wavetable" voice reads the target track's own table, live, so what is sculpted in the
// Wavetable window is what the guitar plays. Pitch and velocity come from the string.
function guitarOutput(prefs: GuitarPrefs): Record<string, unknown> {
    const track = guitarTargetTrack(prefs);
    if (!track) return {};
    if (track.instrument && vst3Runtime[track.id]?.ok) return { vst3Track: track.id, vst3Channel: 0 };
    if (prefs.waveform === WT_WAVEFORM) {
        return { trackId: track.id, waveform: prefs.waveform, wavetable: wavetableNoteConfig(track.id, track.voice, trackWavetable(track), { freq: 440, velocity: 0.8 }) };
    }
    return { trackId: track.id, waveform: prefs.waveform };
}

// What the running wavetable voice was built from, so a change made anywhere (a slider in the
// Wavetable window, the track's Voice panel, an AI tool) is noticed. The position is not part of
// it: that moves a sounding note through the table without a new voice.
let guitarVoiceKey = "";
let guitarVoicePosition = -1;

function rememberGuitarVoice(out: Record<string, unknown>) {
    const wt = out.wavetable as { position: number } | undefined;
    guitarVoiceKey = wt ? JSON.stringify({ ...out, wavetable: { ...wt, position: 0 } }) : "";
    guitarVoicePosition = wt ? wt.position : -1;
}

function pointGuitar(prefs: GuitarPrefs) {
    const out = guitarOutput(prefs);
    rememberGuitarVoice(out);
    addon.Guitar.target(out);
}

function syncGuitarWavetable(prefs: GuitarPrefs) {
    if (!guitarStatus.running || !guitarVoiceKey) return;
    const out = guitarOutput(prefs);
    const wt = out.wavetable as { position: number } | undefined;
    if (!wt) return;
    if (JSON.stringify({ ...out, wavetable: { ...wt, position: 0 } }) !== guitarVoiceKey) { pointGuitar(prefs); return; }
    if (wt.position !== guitarVoicePosition) {
        guitarVoicePosition = wt.position;
        addon.Guitar.setPosition(wt.position);
    }
}

function startGuitar() {
    const prefs = guitarPrefs();
    const out = guitarOutput(prefs);
    if (Object.keys(out).length === 0) {
        guitarMessage = "Add a synth track to play the guitar on first.";
        return;
    }
    const r = addon.Guitar.start({ ...guitarStartConfig(prefs), ...out });
    if (!r.ok) {
        guitarMessage = r.error ?? "The input would not start.";
        guitarStatus = { running: false };
        return;
    }
    guitarHints.reset();
    rememberGuitarVoice(out);
    const o = r.opened!;
    guitarMessage = `Listening on ${o.device} (${o.host}) at ${o.sampleRate} Hz.` + (o.notes.length ? " " + o.notes.join(" ") : "");
}

function stopGuitar() {
    if (guitarRecording) finishGuitarTake();
    addon.Guitar.stop();
    guitarStatus = { running: false };
    guitarMessage = "Stopped. Any held note was released.";
}

// A saved device that is missing stays in the settings and is shown as unavailable.
function pushGuitarSettings(patch: Record<string, unknown>) {
    scheduleSave();
    if (guitarStatus.running) {
        const r = addon.Guitar.set(patch);
        if (!r.ok) guitarMessage = r.error ?? "Could not change that setting.";
    }
}

function finishGuitarTake() {
    guitarRecording = false;
    const r = addon.Guitar.record("stop");
    const notes = r.notes ?? [];
    const take = takeToPattern(notes, project.bpm, project.stepsPerBeat);
    if (!take) {
        guitarMessage = "Nothing was played, so there is no take to keep.";
        return;
    }
    const n = project.tracks.filter(t => t.name.startsWith("Guitar take")).length + 1;
    const track = addTrack("synth", undefined, `Guitar take ${n}`);
    track.scale = "chromatic";
    track.rootNote = take.rootNote;
    track.rows = take.rows;
    const pattern = track.patterns[0];
    pattern.steps = take.steps;
    pattern.notes = take.cells.map(c => ({ row: c.row, step: c.step, length: c.length, velocity: c.velocity }));
    createClip(project.arrangement, {
        trackId: track.id, patternId: pattern.id, startStep: 0, lengthSteps: take.steps
    }, songSteps(project), newId);
    persist();
    guitarMessage = `Recorded ${take.cells.length} note${take.cells.length === 1 ? "" : "s"} into "${track.name}"` +
        (take.bendPoints ? `. ${take.bendPoints} bend points were played but the step grid cannot store bends.` : ".") +
        (take.dropped ? ` ${take.dropped} notes fell outside ${take.rows} rows and were left out.` : "");
}

function pollGuitar() {
    const now = Date.now();
    if (now - guitarPolledAt < 80) return;
    guitarPolledAt = now;
    if (!guitarStatus.running && !guitarVisible) return;
    const st = addon.Guitar.status() as any;
    if (!st.running && guitarStatus.running) {
        guitarMessage = st.deviceLost
            ? "The input device went away. Held notes were released. Plug it back in and press Start."
            : "The input stopped.";
        guitarRecording = false;
    }
    guitarStatus = st;
    if (!st.running || !st.diagnostics) return;
    syncGuitarWavetable(guitarPrefs());
    guitarHints.update(st.diagnostics.note !== null, st.diagnostics.levelDb);
    if (st.bufferNote) guitarMessage = st.bufferNote;
    const fin = st.calibration?.finished;
    if (fin) {
        const prefs = guitarPrefs();
        const s = st.settings;
        if (fin === "room") { prefs.gateOpenDb = s.gateOpenDb; prefs.gateCloseDb = s.gateCloseDb; guitarMessage = `Room measured: the gate now opens at ${s.gateOpenDb.toFixed(1)} dBFS.`; }
        else if (fin === "playing") { prefs.velocityFloorDb = s.velocityFloorDb; prefs.velocityCeilDb = s.velocityCeilDb; guitarMessage = `Playing measured: velocity runs from ${s.velocityFloorDb.toFixed(1)} to ${s.velocityCeilDb.toFixed(1)} dBFS.`; }
        else guitarMessage = "Calibration heard nothing usable. Try again, playing a few soft and hard notes.";
        scheduleSave();
    }
}

function renderGuitarWindow(win: string) {
    const W = Entropy.UI.Widget;
    const prefs = guitarPrefs();
    const running = !!guitarStatus.running;
    const synthTracks = project.tracks.filter(t => t.kind === "synth");

    // Input
    const deviceOptions = ["Default input", ...guitarDevices.map(d => `${d.name}  [${d.host}, ${d.channels} ch]`)];
    let deviceIndex = 0;
    if (prefs.device) {
        deviceIndex = guitarDevices.findIndex(d => d.name === prefs.device && (!prefs.host || d.host === prefs.host)) + 1;
        if (deviceIndex === 0) { deviceOptions.push(`${prefs.device}  (not connected)`); deviceIndex = deviceOptions.length - 1; }
    }
    W.horizontal(win, (tid: string) => {
        W.button(tid, { text: "Refresh inputs", id: "guitar_refresh", onClick: () => { refreshGuitarDevices(); } });
        W.dropdown(tid, {
            label: "Input", id: "guitar_device", options: deviceOptions, selectedIndex: deviceIndex,
            onChange: (idx: string) => {
                const i = parseInt(idx, 10);
                const d = i >= 1 ? guitarDevices[i - 1] : undefined;
                if (i === 0) { delete prefs.device; delete prefs.host; }
                else if (d) { prefs.device = d.name; prefs.host = d.host; }
                scheduleSave();
            }
        });
        W.numericInput(tid, {
            label: "Channel", id: "guitar_channel", value: prefs.channel + 1,
            onChange: (v: string) => { prefs.channel = Math.max(0, Math.round(parseFloat(v) || 1) - 1); scheduleSave(); }
        });
    });

    // Where the notes go
    W.horizontal(win, (tid: string) => {
        const target = synthTracks.findIndex(t => t.id === prefs.targetTrackId);
        W.dropdown(tid, {
            label: "Play on", id: "guitar_target", options: synthTracks.length ? synthTracks.map(t => t.name) : ["(no synth track)"],
            selectedIndex: Math.max(0, target),
            onChange: (idx: string) => {
                prefs.targetTrackId = synthTracks[parseInt(idx, 10)]?.id ?? null;
                scheduleSave();
                if (running) pointGuitar(prefs);
            }
        });
        W.dropdown(tid, {
            label: "Voice", id: "guitar_waveform", options: [...GUITAR_WAVEFORMS], selectedIndex: GUITAR_WAVEFORMS.indexOf(prefs.waveform),
            onChange: (idx: string) => {
                prefs.waveform = GUITAR_WAVEFORMS[parseInt(idx, 10)] ?? "saw";
                scheduleSave();
                if (running) pointGuitar(prefs);
            }
        });
    });
    const outTrack = project.tracks.find(t => t.id === (guitarOutput(prefs) as any).vst3Track);
    if (outTrack) W.label(win, { text: `${outTrack.name} has a VST3 instrument, so the guitar plays that. Set its pitch-bend range to ${prefs.bendRange} semitones.` });
    else if (prefs.waveform === WT_WAVEFORM) {
        const target = guitarTargetTrack(prefs);
        if (target) {
            const editing = getActiveTrack()?.id === target.id;
            W.label(win, {
                text: !isWavetableTrack(target)
                    ? `Plays ${target.name}'s wavetable. Make it a wavetable synth to sculpt it.`
                    : editing
                        ? `Plays ${target.name}'s wavetable. Sculpt it in the Wavetable window.`
                        : `Plays ${target.name}'s wavetable. Select it to sculpt it.`
            });
        }
    }

    W.horizontal(win, (tid: string) => {
        W.button(tid, { text: running ? withIcon("stop", "Stop") : withIcon("play", "Start"), id: "guitar_toggle", onClick: () => { running ? stopGuitar() : startGuitar(); } });
        W.button(tid, { text: "All notes off", id: "guitar_all_off", onClick: () => { addon.Guitar.releaseAll(); } });
        if (running) {
            W.button(tid, {
                text: guitarRecording ? withIcon("stop", "Stop and keep take") : withIcon("record", "Record take"), id: "guitar_record",
                onClick: () => {
                    if (guitarRecording) { finishGuitarTake(); return; }
                    const r = addon.Guitar.record("start");
                    guitarRecording = !!r.ok;
                    if (!r.ok) guitarMessage = r.error ?? "Could not start a take.";
                }
            });
        }
    });
    W.label(win, { text: running ? "Status: listening" : "Status: stopped", bold: true });
    if (guitarMessage) W.label(win, { text: guitarMessage });

    // Signal
    if (running && guitarStatus.diagnostics) {
        const d = guitarStatus.diagnostics as GuitarDiag;
        W.label(win, { text: `Input ${levelBar(d.inputPeakDb)} ${d.inputPeakDb.toFixed(1)} dBFS${d.clipped ? "   CLIPPING - turn the input down" : ""}`, bold: true });
        if (guitarHints.tooQuiet()) W.label(win, { text: "Signal too low: your notes peak under -30 dBFS. Raise the gain on the interface or the cable." });
        if (d.overruns > 0) W.label(win, { text: `The audio callback ran long ${d.overruns} times. Try the Accurate mode or a larger buffer.` });
        if (guitarStatus.calibration?.busy) W.label(win, { text: `Calibrating: ${guitarStatus.calibration.state}...`, bold: true });
    }

    // Response
    W.horizontal(win, (tid: string) => {
        W.label(tid, { text: "Response:", bold: true });
        GUITAR_MODES.forEach(m => {
            W.button(tid, {
                text: radio(prefs.mode === m) + m[0].toUpperCase() + m.slice(1), id: "guitar_mode_" + m,
                onClick: () => { prefs.mode = m; pushGuitarSettings({ mode: m }); }
            });
        });
    });
    W.slider(win, {
        label: "Sensitivity", value: prefs.sensitivity, min: 0, max: 1,
        onChange: (v: string) => { prefs.sensitivity = parseFloat(v); pushGuitarSettings({ sensitivity: prefs.sensitivity }); }
    });
    W.slider(win, {
        label: "Gate opens at (dBFS)", value: prefs.gateOpenDb ?? -46, min: -70, max: -20,
        onChange: (v: string) => {
            const open = parseFloat(v);
            prefs.gateOpenDb = open;
            prefs.gateCloseDb = open - 8;
            pushGuitarSettings({ gateOpenDb: open, gateCloseDb: open - 8 });
        }
    });
    W.horizontal(win, (tid: string) => {
        W.numericInput(tid, {
            label: "Bend range (semitones)", id: "guitar_bend_range", value: prefs.bendRange,
            onChange: (v: string) => { prefs.bendRange = Math.min(12, Math.max(1, Math.round(parseFloat(v) || 2))); pushGuitarSettings({ bendRange: prefs.bendRange }); }
        });
        W.numericInput(tid, {
            label: "A4 (Hz)", id: "guitar_reference", value: prefs.referencePitch,
            onChange: (v: string) => { prefs.referencePitch = Math.min(494, Math.max(392, parseFloat(v) || 440)); pushGuitarSettings({ referencePitch: prefs.referencePitch }); }
        });
    });
    W.horizontal(win, (tid: string) => {
        W.button(tid, { text: "Calibrate room (3 s, stay silent)", id: "guitar_cal_room", onClick: () => { if (running) addon.Guitar.calibrate(false, 3); } });
        W.button(tid, { text: "Calibrate playing (5 s, soft and hard notes)", id: "guitar_cal_play", onClick: () => { if (running) addon.Guitar.calibrate(true, 5); } });
    });

    // What the engine hears
    if (running && guitarStatus.diagnostics) {
        W.collapsingHeader(win, "Diagnostics", (tid: string) => {
            diagnosticsLines(guitarStatus.diagnostics as GuitarDiag, prefs.bendRange).forEach(line => W.label(tid, { text: line }));
            const d = guitarStatus.diagnostics as GuitarDiag;
            if (d.note !== null) W.label(tid, { text: `Sounding ${guitarNoteName(d.note)}`, bold: true });
        }, "guitar_diagnostics", true);
    }
}

// --- The Wavetable window -------------------------------------------------------------------------
//
// The active synth track's table as terrain (see entropy_gui::WavetableView), with the settings
// that decide how a note moves through it. Mouse and pen both work on the terrain; the on-screen
// keyboard plays the sound through the track's own bus, so it honours the track's gain, mute, solo
// and effects like any other note.

let wavetableWindowId: string | null = null;
let wavetableVisible = false;
let wavetableWindowHeight = 900;
let wavetableWindowWidth = 1240;
// The right-hand column of sliders takes this much of the window's width; the terrain gets the rest.
const WAVETABLE_SIDE_COLUMN = 380;

function setWavetableVisible(visible: boolean) {
    wavetableVisible = visible;
    if (wavetableWindowId) Entropy.UI.setWindowVisible(wavetableWindowId, visible);
}

// Folders start collapsed except the first, so a track that has never touched presets opens on
// one short, readable list rather than all ten at once.
const wtPresetCollapsed = new Set<string>(instrumentPresetFolders().slice(1).map(g => g.folder));

function wtPresetTreeNodes(wt: WavetableSettings) {
    const nodes: { id: string; label: string; depth: number; hasChildren: boolean; expanded?: boolean; selected?: boolean; detail?: string }[] = [];
    for (const group of instrumentPresetFolders()) {
        const collapsed = wtPresetCollapsed.has(group.folder);
        nodes.push({ id: `folder:${group.folder}`, label: group.folder, depth: 0, hasChildren: true, expanded: !collapsed });
        if (collapsed) continue;
        for (const p of group.presets) {
            nodes.push({ id: p.id, label: p.label, depth: 1, hasChildren: false, selected: wt.instrumentPreset === p.id });
        }
    }
    return nodes;
}

function renderWavetableWindow(win: string) {
    const track = getActiveTrack();
    if (!track || track.kind !== "synth" || track.instrument) {
        Entropy.UI.Widget.label(win, { text: "The wavetable editor works on a built-in synth track. Select one in the arrangement." });
        return;
    }
    if (!isWavetableTrack(track)) {
        Entropy.UI.Widget.label(win, { text: `${track.name} plays a ${track.voice.waveform} oscillator.`, bold: true });
        Entropy.UI.Widget.button(win, {
            text: "Make it a wavetable synth", id: "wt_make",
            onClick: () => { track.voice.waveform = WT_WAVEFORM; persist(); }
        });
        return;
    }
    const wt = trackWavetable(track);
    const latched = wtLatch[track.id] !== undefined;

    Entropy.UI.Widget.horizontal(win, (columns: string) => {
    Entropy.UI.Widget.vertical(columns, (left: string) => {
    Entropy.UI.Widget.horizontal(left, (row: string) => {
        Entropy.UI.Widget.label(row, { text: `${track.name} - start from`, bold: true });
        for (const p of WT_PRESETS) {
            Entropy.UI.Widget.button(row, {
                text: radio(wt.preset === p.id) + p.label, id: "wt_preset_" + p.id,
                onClick: () => { loadWavetablePreset(track, p.id); }
            });
        }
    });
    Entropy.UI.Widget.horizontal(left, (row: string) => {
        for (const o of WT_OPS) {
            Entropy.UI.Widget.button(row, { text: o.label, id: "wt_op_" + o.id, onClick: () => { runWavetableOp(track, o.id, o.arg); } });
        }
        Entropy.UI.Widget.button(row, {
            text: latched ? withIcon("stop", "Release note") : withIcon("play", "Hold a note"), id: "wt_latch",
            onClick: () => { toggleLatch(track); }
        });
        Entropy.UI.Widget.checkbox(row, {
            label: "Hear while sculpting", value: wt.audition,
            onChange: (v: any) => { wt.audition = v === true || v === "true"; scheduleSave(); }
        });
    });
    Entropy.UI.Widget.horizontal(left, (row: string) => {
        Entropy.UI.Widget.slider(row, {
            label: "Brush size", value: wt.radius, min: 0.04, max: 0.6,
            onChange: (v: string) => { wt.radius = parseFloat(v); scheduleSave(); }
        });
        Entropy.UI.Widget.slider(row, {
            label: "Strength", value: wt.strength, min: 0.05, max: 1,
            onChange: (v: string) => { wt.strength = parseFloat(v); scheduleSave(); }
        });
        Entropy.UI.Widget.numericInput(row, {
            label: "Note (MIDI)", id: "wt_audition_note", value: wt.auditionNote,
            onChange: (v: string) => { wt.auditionNote = Math.max(24, Math.min(96, Math.round(parseFloat(v) || wt.auditionNote))); scheduleSave(); }
        });
    });

    Entropy.UI.Widget.wavetable(left, {
        id: "wt_" + track.id,
        table: track.id,
        tool: wt.tool,
        radius: wt.radius,
        strength: wt.strength,
        frame: wt.frame,
        width: Math.max(420, wavetableWindowWidth - WAVETABLE_SIDE_COLUMN),
        height: Math.max(440, wavetableWindowHeight - 230),
        held: [...(latched ? [wt.auditionNote] : [])],
        onEdit: () => { saveTrackWavetable(track); },
        onStrokeStart: () => { beginStrokeAudition(track); },
        onStrokeEnd: () => { endStrokeAudition(track); },
        onFrame: (f: number) => { wt.frame = f; scheduleSave(); },
        onTool: (t: string) => { wt.tool = t as WavetableSettings["tool"]; scheduleSave(); },
        onKeyDown: (midi: number, velocity: number) => { pressWavetableKey(track, midi, velocity); },
        onKeyUp: (midi: number) => { releaseWavetableKey(track, midi); },
    });

    if (wtStatus) Entropy.UI.Widget.label(left, { text: wtStatus });
    });
    Entropy.UI.Widget.vertical(columns, (right: string) => {
        Entropy.UI.Widget.group(right, (g: string) => {
            Entropy.UI.Widget.label(g, { text: "Presets", bold: true });
            Entropy.UI.Widget.treeView(g, {
                id: "wt_instrument_presets", width: WAVETABLE_SIDE_COLUMN - 34, maxHeight: 160,
                nodes: wtPresetTreeNodes(wt),
                onSelect: (id: string) => {
                    if (id.startsWith("folder:")) {
                        const folder = id.slice(7);
                        if (wtPresetCollapsed.has(folder)) wtPresetCollapsed.delete(folder); else wtPresetCollapsed.add(folder);
                        return;
                    }
                    applyInstrumentPreset(track, id);
                },
                onToggleExpand: (id: string) => {
                    const folder = id.startsWith("folder:") ? id.slice(7) : id;
                    if (wtPresetCollapsed.has(folder)) wtPresetCollapsed.delete(folder); else wtPresetCollapsed.add(folder);
                },
            });
            const active = wt.instrumentPreset ? instrumentPresetById(wt.instrumentPreset) : undefined;
            if (active) Entropy.UI.Widget.label(g, { text: active.hint });
        });
        Entropy.UI.Widget.group(right, (g: string) => {
            Entropy.UI.Widget.label(g, { text: "Motion", bold: true });
            // 3 knobs to a row: at the column's real width (narrower than WAVETABLE_SIDE_COLUMN once
            // the terrain and its own padding take their share) a 4th or 5th knob was pushed off the
            // drawn area instead of wrapping onto a new line - confirmed by screenshotting the real
            // window (test-artifacts/daw-wavetable-*), not just reasoned about.
            Entropy.UI.Widget.horizontal(g, (row: string) => {
                Entropy.UI.Widget.knob(row, { label: "Position", value: wt.position, min: 0, max: 1, onChange: (v: string) => { setWavetablePosition(track, parseFloat(v)); } });
                Entropy.UI.Widget.knob(row, { label: "LFO rate", value: wt.lfoRate, min: 0, max: 20, onChange: (v: string) => { wt.lfoRate = parseFloat(v); scheduleSave(); } });
                Entropy.UI.Widget.knob(row, { label: "LFO depth", value: wt.lfoDepth, min: 0, max: 1, onChange: (v: string) => { wt.lfoDepth = parseFloat(v); scheduleSave(); } });
            });
            Entropy.UI.Widget.horizontal(g, (row: string) => {
                Entropy.UI.Widget.knob(row, { label: "Sweep", value: wt.sweep, min: -1, max: 1, onChange: (v: string) => { wt.sweep = parseFloat(v); scheduleSave(); } });
                Entropy.UI.Widget.knob(row, { label: "Sweep time", value: wt.sweepTime, min: 0.02, max: 6, onChange: (v: string) => { wt.sweepTime = parseFloat(v); scheduleSave(); } });
            });
        });
        Entropy.UI.Widget.group(right, (g: string) => {
            Entropy.UI.Widget.label(g, { text: "Voice", bold: true });
            Entropy.UI.Widget.horizontal(g, (row: string) => {
                Entropy.UI.Widget.knob(row, { label: "Unison", value: wt.unison, min: 1, max: 7, onChange: (v: string) => { wt.unison = Math.round(parseFloat(v)); scheduleSave(); } });
                Entropy.UI.Widget.knob(row, { label: "Detune", value: wt.detuneCents, min: 0, max: 60, onChange: (v: string) => { wt.detuneCents = parseFloat(v); scheduleSave(); } });
                Entropy.UI.Widget.knob(row, { label: "Spread", value: wt.spread, min: 0, max: 1, onChange: (v: string) => { wt.spread = parseFloat(v); scheduleSave(); } });
            });
            Entropy.UI.Widget.horizontal(g, (row: string) => {
                Entropy.UI.Widget.knob(row, { label: "Vel->Pos", value: wt.velToPosition, min: -1, max: 1, onChange: (v: string) => { wt.velToPosition = parseFloat(v); scheduleSave(); } });
                Entropy.UI.Widget.knob(row, { label: "Cutoff", value: track.voice.cutoff, min: 100, max: 20000, onChange: (v: string) => { track.voice.cutoff = parseFloat(v); saveTrackWavetable(track); } });
                Entropy.UI.Widget.knob(row, { label: "Resonance", value: track.voice.resonance, min: 0.1, max: 10, onChange: (v: string) => { track.voice.resonance = parseFloat(v); saveTrackWavetable(track); } });
            });
            Entropy.UI.Widget.horizontal(g, (row: string) => {
                Entropy.UI.Widget.knob(row, { label: "Attack", value: track.voice.attack, min: 0.0005, max: 4, onChange: (v: string) => { track.voice.attack = parseFloat(v); saveTrackWavetable(track); } });
                Entropy.UI.Widget.knob(row, { label: "Release", value: track.voice.release, min: 0.01, max: 3, onChange: (v: string) => { track.voice.release = parseFloat(v); saveTrackWavetable(track); } });
            });
        });
    });
    });
}

// --- The Bowed String window ------------------------------------------------------------------
//
// The active synth track's bowed string, drawn live by entropy_gui::PhysModView (see
// widgets_physmod.rs), with the bow and instrument controls. Dragging the bow in the view and
// turning the knobs below reach the same live state - see setBowLive.

let physModWindowId: string | null = null;
let physModVisible = false;
let physModWindowHeight = 760;
let physModWindowWidth = 1080;
const PHYSMOD_SIDE_COLUMN = 340;

function setPhysModVisible(visible: boolean) {
    physModVisible = visible;
    if (physModWindowId) Entropy.UI.setWindowVisible(physModWindowId, visible);
}

function renderPhysModWindow(win: string) {
    const W = Entropy.UI.Widget;
    const track = getActiveTrack();
    if (!track || track.kind !== "synth" || track.instrument) {
        W.label(win, { text: "The bowed-string editor works on a built-in synth track. Select one in the arrangement." });
        return;
    }
    if (!isPhysModTrack(track)) {
        W.label(win, { text: `${track.name} plays a ${track.voice.waveform} oscillator.`, bold: true });
        W.button(win, {
            text: "Make it a bowed string", id: "pm_make",
            onClick: () => { track.voice.waveform = PHYSMOD_WAVEFORM; persist(); }
        });
        return;
    }
    const pm = trackPhysMod(track);
    const latched = pmLatch[track.id] !== undefined;
    const strings = physModOpenStrings(pm);
    // Before anything has sounded, highlight the string a held key would go to; once a note plays,
    // the view follows the engine's own choice (it also knows about double stops and slurs).
    const heldMidis = Object.keys(pmHeld[track.id] ?? {}).map(Number);
    const activeMidi = heldMidis.length ? heldMidis[heldMidis.length - 1] : (latched ? pm.auditionNote : undefined);
    const activeString = activeMidi !== undefined ? stringForFreq(strings, midiToFreq(activeMidi)) : undefined;
    const knob = (row: string, label: string, key: keyof PhysModSettings, min: number, max: number, live?: "force" | "velocity" | "position" | "vibratoDepth") =>
        W.knob(row, {
            label, value: pm[key] as number, min, max,
            onChange: (v: string) => { (pm as any)[key] = parseFloat(v); if (live) setBowLive(track, live, pm[key] as number); scheduleSave(); },
        });

    W.horizontal(win, (columns: string) => {
    W.vertical(columns, (left: string) => {
    W.horizontal(left, (row: string) => {
        W.label(row, { text: `${track.name} -`, bold: true });
        for (const p of PHYSMOD_INSTRUMENT_PRESETS.filter(p => !p.invented)) {
            W.button(row, { text: radio(pm.instrument === p.id) + p.label, id: "pm_instrument_" + p.id, onClick: () => { loadPhysModInstrument(track, p.id); } });
        }
        W.button(row, {
            text: latched ? withIcon("stop", "Release note") : withIcon("play", "Hold a note"), id: "pm_latch",
            onClick: () => { togglePhysModLatch(track); }
        });
    });
    W.horizontal(left, (row: string) => {
        W.label(row, { text: "Laboratory:" });
        for (const p of PHYSMOD_INSTRUMENT_PRESETS.filter(p => p.invented || p.sympathetic)) {
            W.button(row, { text: radio(pm.instrument === p.id) + p.label, id: "pm_instrument_" + p.id, onClick: () => { loadPhysModInstrument(track, p.id); } });
        }
        W.button(row, {
            text: radio(pm.physicsView) + "Physics View", id: "pm_physics",
            onClick: () => { pm.physicsView = !pm.physicsView; scheduleSave(); }
        });
    });

    W.physModString(left, {
        id: "pm_" + track.id,
        instrument: track.id,
        activeString,
        bowPosition: pm.bowPosition,
        bowForce: pm.bowForce,
        bodySize: pm.bodySize,
        physicsView: pm.physicsView,
        width: Math.max(380, physModWindowWidth - PHYSMOD_SIDE_COLUMN),
        height: Math.max(360, physModWindowHeight - 170),
        held: [...heldMidis, ...(latched ? [pm.auditionNote] : [])],
        onBowDrag: (position: number, force: number) => {
            pm.bowPosition = position; pm.bowForce = force;
            setBowLive(track, "position", position); setBowLive(track, "force", force);
            scheduleSave();
        },
        onKeyDown: (midi: number, velocity: number) => { pressPhysModKey(track, midi, velocity); },
        onKeyUp: (midi: number) => { releasePhysModKey(track, midi); },
        onPhysicsView: (on: boolean) => { pm.physicsView = on; scheduleSave(); },
    });
    if (pmStatus) W.label(left, { text: pmStatus });
    });
    W.vertical(columns, (right: string) => {
        W.group(right, (g: string) => {
            W.label(g, { text: "Bow", bold: true });
            W.horizontal(g, (row: string) => {
                for (const a of PHYSMOD_ARTICULATIONS) {
                    W.button(row, { text: radio(pm.articulation === a.id) + a.label, id: "pm_art_" + a.id, onClick: () => { pm.articulation = a.id; scheduleSave(); } });
                }
            });
            W.horizontal(g, (row: string) => {
                knob(row, "Force", "bowForce", 0, 1, "force");
                knob(row, "Speed", "bowVelocity", 0, 1, "velocity");
                knob(row, "Position", "bowPosition", 0.02, 0.5, "position");
                knob(row, "Skill", "attackSkill", 0, 1);
            });
        });
        W.group(right, (g: string) => {
            W.label(g, { text: "Left hand", bold: true });
            W.horizontal(g, (row: string) => {
                knob(row, "Vib rate", "vibratoRate", 0, 12);
                knob(row, "Vib depth", "vibratoDepth", 0, 100, "vibratoDepth");
                knob(row, "Vib delay", "vibratoDelay", 0, 1);
                knob(row, "Slide", "slide", 0, 0.4);
            });
        });
        W.group(right, (g: string) => {
            W.label(g, { text: "Strings", bold: true });
            W.horizontal(g, (row: string) => {
                knob(row, "Brightness", "brightness", 0, 1);
                knob(row, "Damping", "damping", 0, 1);
                knob(row, "Ring", "ring", 0, 1);
                knob(row, "Mass", "stringMass", 0, 1);
            });
            W.horizontal(g, (row: string) => {
                knob(row, "Stiffness", "stiffness", 0, 1);
                knob(row, "Rosin", "rosin", 0, 1);
                knob(row, "Grit", "bowNoise", 0, 1);
            });
        });
        W.group(right, (g: string) => {
            W.label(g, { text: "Body", bold: true });
            W.horizontal(g, (row: string) => {
                knob(row, "Size", "bodySize", -1, 2.5);
                knob(row, "Mix", "bodyMix", 0, 1);
                knob(row, "Resonance", "bodyResonance", 0, 1);
                knob(row, "Coupling", "coupling", 0, 1);
            });
            W.horizontal(g, (row: string) => {
                W.button(row, {
                    text: radio(pm.tuningFollowsSize) + "Tuning follows size", id: "pm_morph",
                    onClick: () => { pm.tuningFollowsSize = !pm.tuningFollowsSize; scheduleSave(); }
                });
                W.button(row, {
                    text: "New maker", id: "pm_maker",
                    onClick: () => { pm.bodySeed = (pm.bodySeed * 1103515245 + 12345) % 2147483647; scheduleSave(); }
                });
            });
            W.label(g, { text: `Strings: ${strings.map(f => midiToName(Math.round(69 + 12 * Math.log2(f / 440)))).join(" ")}${pm.sympathetic.length ? `  +${pm.sympathetic.length} sympathetic` : ""}` });
        });
    });
    });
}

// --- The Brass window -----------------------------------------------------------------------
//
// The active synth track's brass player, drawn live by entropy_gui::BrassView (see
// widgets_brass.rs), with the player's controls. The slide and the playing map in the view and the
// knobs below reach the same live state - see setBrassLive.

let brassWindowId: string | null = null;
let brassVisible = false;
let brassWindowHeight = 760;
let brassWindowWidth = 1080;
const BRASS_SIDE_COLUMN = 320;

function setBrassVisible(visible: boolean) {
    brassVisible = visible;
    if (brassWindowId) Entropy.UI.setWindowVisible(brassWindowId, visible);
}

function renderBrassWindow(win: string) {
    const W = Entropy.UI.Widget;
    const track = getActiveTrack();
    if (!track || track.kind !== "synth" || track.instrument) {
        W.label(win, { text: "The brass editor works on a built-in synth track. Select one in the arrangement." });
        return;
    }
    if (!isBrassTrack(track)) {
        W.label(win, { text: `${track.name} plays a ${track.voice.waveform} oscillator.`, bold: true });
        W.button(win, {
            text: "Make it brass", id: "br_make",
            onClick: () => { track.voice.waveform = BRASS_WAVEFORM; persist(); }
        });
        return;
    }
    const b = trackBrass(track);
    const latched = brLatch[track.id] !== undefined;
    const heldMidis = Object.keys(brHeld[track.id] ?? {}).map(Number);
    const knob = (row: string, label: string, key: keyof BrassSettings, min: number, max: number, live?: "breath" | "lipTension" | "vibratoDepth") =>
        W.knob(row, {
            label, value: b[key] as number, min, max,
            onChange: (v: string) => { (b as any)[key] = parseFloat(v); if (live) setBrassLive(track, live, b[key] as number); scheduleSave(); },
        });

    W.horizontal(win, (columns: string) => {
    W.vertical(columns, (left: string) => {
    W.horizontal(left, (row: string) => {
        W.label(row, { text: `${track.name} -`, bold: true });
        for (const p of BRASS_INSTRUMENTS) {
            W.button(row, { text: radio(b.instrument === p.id) + p.label, id: "br_instrument_" + p.id, onClick: () => { loadBrassInstrument(track, p.id); } });
        }
        W.button(row, {
            text: latched ? withIcon("stop", "Release note") : withIcon("play", "Hold a note"), id: "br_latch",
            onClick: () => { toggleBrassLatch(track); }
        });
        W.button(row, {
            text: radio(b.physicsView) + "Physics View", id: "br_physics",
            onClick: () => { b.physicsView = !b.physicsView; scheduleSave(); }
        });
    });
    W.horizontal(left, (row: string) => {
        W.label(row, { text: "Play it:" });
        for (const st of BRASS_STYLES) {
            W.button(row, { text: radio(b.style === st.id) + st.label, id: "br_style_" + st.id, onClick: () => { playBrassStyle(track, st.id); } });
        }
    });

    W.brass(left, {
        id: "br_" + track.id,
        instrument: track.id,
        breath: b.breath,
        lipTension: b.lipTension,
        physicsView: b.physicsView,
        width: Math.max(380, brassWindowWidth - BRASS_SIDE_COLUMN),
        height: Math.max(380, brassWindowHeight - 170),
        held: [...heldMidis, ...(latched ? [b.auditionNote] : [])],
        firstKey: brassInstrumentById(b.instrument)?.firstKey ?? 40,
        onKeyDown: (midi: number, velocity: number) => { pressBrassKey(track, midi, velocity); },
        onKeyUp: (midi: number) => { releaseBrassKey(track, midi); },
        onSlideDrag: (position: number) => { dragBrassSlide(track, position); },
        onPlayDrag: (breath: number, lipTension: number) => {
            b.breath = breath; b.lipTension = lipTension;
            setBrassLive(track, "breath", breath); setBrassLive(track, "lipTension", lipTension);
            scheduleSave();
        },
        onPhysicsView: (on: boolean) => { b.physicsView = on; scheduleSave(); },
    });
    if (brStatus) W.label(left, { text: brStatus });
    });
    W.vertical(columns, (right: string) => {
        W.group(right, (g: string) => {
            W.label(g, { text: "Breath and lips", bold: true });
            W.horizontal(g, (row: string) => {
                knob(row, "Breath", "breath", 0, 1, "breath");
                knob(row, "Lips", "lipTension", -1, 1, "lipTension");
                knob(row, "Aperture", "aperture", 0, 1);
                knob(row, "Skill", "attackSkill", 0, 1);
            });
        });
        W.group(right, (g: string) => {
            W.label(g, { text: "Mute, hand and bell", bold: true });
            W.horizontal(g, (row: string) => {
                for (const m of BRASS_MUTES) {
                    W.button(row, { text: radio(b.mute === m.id) + m.label, id: "br_mute_" + m.id, onClick: () => { setBrassMute(track, m.id); } });
                }
            });
            const dress = handAndBell(b);
            W.horizontal(g, (row: string) => {
                W.knob(row, {
                    label: "Hand", value: dress.hand, min: 0, max: 1,
                    onChange: (v: string) => { b.hand = Math.min(1, Math.max(0, parseFloat(v))); scheduleSave(); },
                });
                W.knob(row, {
                    label: "Bell", value: dress.bellFacing, min: 0, max: 1,
                    onChange: (v: string) => { b.bellFacing = Math.min(1, Math.max(0, parseFloat(v))); scheduleSave(); },
                });
            });
            W.label(g, { text: "They rebuild the air column, so they apply from the next note. Hand: 1 stops the bell (the horn's stopped note, brassy, played a semitone up). Bell: 1 points at the listener, brighter." });
        });
        W.group(right, (g: string) => {
            W.label(g, { text: b.instrument === "trombone" ? "Tongue and slide" : "Tongue", bold: true });
            W.horizontal(g, (row: string) => {
                for (const a of BRASS_ARTICULATIONS) {
                    W.button(row, { text: radio(b.articulation === a.id) + a.label, id: "br_art_" + a.id, onClick: () => { b.articulation = a.id; scheduleSave(); } });
                }
            });
            W.horizontal(g, (row: string) => {
                knob(row, "Tongue", "tongue", 0.001, 0.08);
                knob(row, "Release", "release", 0.01, 0.6);
                if (b.instrument === "trombone") knob(row, "Slide", "slideTime", 0.01, 0.8);
            });
        });
        W.group(right, (g: string) => {
            W.label(g, { text: "Vibrato", bold: true });
            W.horizontal(g, (row: string) => {
                knob(row, "Rate", "vibratoRate", 0, 12);
                knob(row, "Depth", "vibratoDepth", 0, 60, "vibratoDepth");
                knob(row, "Delay", "vibratoDelay", 0, 1);
            });
        });
        W.group(right, (g: string) => {
            W.label(g, { text: "Laboratory", bold: true });
            W.horizontal(g, (row: string) => {
                knob(row, "Air noise", "breathNoise", 0, 1);
                knob(row, "Brassiness", "brassiness", 0, 3);
            });
            W.label(g, { text: "Brassiness scales the air's own nonlinearity: 1 is real air, 0 a tube that never goes brassy." });
        });
    });
    });
}

// --- The Kit window -------------------------------------------------------------------------
//
// The active synth track's drum kit, drawn live by entropy_gui::MatterView (see
// widgets_matter.rs) from the modes it rings with, with the kit's tunings and the way it is
// played. Clicking a head strikes it there; the pads strike each piece where it is usually played.

let matterWindowId: string | null = null;
let matterVisible = false;
let matterWindowHeight = 760;
let matterWindowWidth = 1120;
const MATTER_SIDE_COLUMN = 340;

function setMatterVisible(visible: boolean) {
    matterVisible = visible;
    if (matterWindowId) Entropy.UI.setWindowVisible(matterWindowId, visible);
}

/** A click in the view or a pad: struck now, with the kit's hands. */
function strikeMatterFromView(track: Track, piece: MatterPiece, velocity: number, position?: number, angle?: number) {
    const m = trackMatter(track);
    const hit = position === undefined
        ? matterHitConfig(track.id, m, { row: MATTER_ROWS.findIndex(r => r.piece === piece), velocity })
        : matterHitConfig(track.id, m, { piece, position, angle, velocity });
    playMatterHit(track, hit);
}

function renderMatterWindow(win: string) {
    const W = Entropy.UI.Widget;
    commitDueMatter();
    const track = getActiveTrack();
    if (!track || track.kind !== "synth" || track.instrument) {
        W.label(win, { text: "The kit works on a built-in synth track. Select one in the arrangement." });
        return;
    }
    if (!isMatterTrack(track)) {
        W.label(win, { text: `${track.name} plays a ${track.voice.waveform} oscillator.`, bold: true });
        W.button(win, {
            text: "Make it a drum kit", id: "mt_make",
            onClick: () => { track.voice.waveform = MATTER_WAVEFORM; trackMatter(track); persist(); }
        });
        return;
    }
    const m = trackMatter(track);
    // Keep the engine's kit in step (and pick up a finished build) while the window is open.
    if (mtKit[track.id]) prepareMatter(track);
    const build = mtBuild[track.id];
    const kitKnob = (row: string, label: string, key: keyof typeof KIT_RANGES) =>
        W.knob(row, {
            label, value: m.kit[key] as number, min: KIT_RANGES[key][0], max: KIT_RANGES[key][1],
            onChange: (v: string) => { const n = parseFloat(v); if (Number.isFinite(n)) { (m.kit as any)[key] = n; touchMatterKit(track); } },
        });

    W.horizontal(win, (columns: string) => {
    W.vertical(columns, (left: string) => {
    W.horizontal(left, (row: string) => {
        W.label(row, { text: `${track.name} -`, bold: true });
        for (const p of MATTER_PRESETS) {
            W.button(row, { text: radio(m.preset === p.id) + p.label, id: "mt_preset_" + p.id, onClick: () => { loadMatterPreset(track, p.id); } });
        }
        W.button(row, {
            text: radio(m.physicsView) + "Physics View", id: "mt_physics",
            onClick: () => { m.physicsView = !m.physicsView; scheduleSave(); }
        });
    });
    W.matter(left, {
        id: "mt_" + track.id,
        kit: track.id,
        physicsView: m.physicsView,
        width: Math.max(380, matterWindowWidth - MATTER_SIDE_COLUMN),
        height: Math.max(400, matterWindowHeight - 130),
        status: build === "building" ? "building the kit (the first time takes a moment)..." : build === "rebuilding" ? "retuning: the new kit is being built, the old one plays meanwhile" : undefined,
        onStrike: (piece: MatterPiece, position: number, angle: number, velocity: number) => { strikeMatterFromView(track, piece, velocity, position, angle); },
        onPad: (piece: MatterPiece, velocity: number) => { strikeMatterFromView(track, piece, velocity); },
        onPhysicsView: (on: boolean) => { m.physicsView = on; scheduleSave(); },
    });
    if (mtStatus) W.label(left, { text: mtStatus });
    });
    W.vertical(columns, (right: string) => {
        W.group(right, (g: string) => {
            W.label(g, { text: "Tuning (Hz)", bold: true });
            W.horizontal(g, (row: string) => {
                kitKnob(row, "Kick", "kick");
                kitKnob(row, "Snare", "snare");
                kitKnob(row, "Rack", "rackTom");
                kitKnob(row, "Floor", "floorTom");
            });
            W.label(g, { text: "Each head's fundamental: the tension is solved from it. A slacker head glides further when hit hard." });
        });
        W.group(right, (g: string) => {
            W.label(g, { text: "Kick and snare", bold: true });
            W.horizontal(g, (row: string) => {
                kitKnob(row, "Muffling", "kickMuffling");
                W.button(row, { text: radio(m.beater === "felt") + "Felt", id: "mt_beater_felt", onClick: () => { m.beater = "felt"; scheduleSave(); } });
                W.button(row, { text: radio(m.beater === "plastic") + "Plastic", id: "mt_beater_plastic", onClick: () => { m.beater = "plastic"; scheduleSave(); } });
            });
            W.horizontal(g, (row: string) => {
                W.button(row, { text: radio(m.kit.snares) + "Snares on", id: "mt_snares", onClick: () => { m.kit.snares = !m.kit.snares; commitMatter(track); scheduleSave(); } });
                kitKnob(row, "Tension", "snareTension");
            });
            W.label(g, { text: "Snare tension is how hard the strainer presses the wires (N): looser wires lift off more easily and buzz longer." });
        });
        W.group(right, (g: string) => {
            W.label(g, { text: "Playing", bold: true });
            W.horizontal(g, (row: string) => {
                W.button(row, { text: radio(m.hands === "sticks") + "Sticks", id: "mt_hands_sticks", onClick: () => { m.hands = "sticks"; scheduleSave(); } });
                W.button(row, { text: radio(m.hands === "mallets") + "Mallets", id: "mt_hands_mallets", onClick: () => { m.hands = "mallets"; scheduleSave(); } });
                W.knob(row, {
                    label: "Dynamics", value: m.dynamics, min: 1, max: 12,
                    onChange: (v: string) => { const n = parseFloat(v); if (Number.isFinite(n)) { m.dynamics = n; scheduleSave(); } },
                });
            });
            W.label(g, { text: `A full-velocity hit lands at ${m.dynamics.toFixed(1)} m/s; a ghost note at 0.4.` });
            W.button(g, { text: radio(m.kit.sympathetic) + "Pieces hear each other", id: "mt_sympathetic", onClick: () => { m.kit.sympathetic = !m.kit.sympathetic; commitMatter(track); scheduleSave(); } });
        });
        W.group(right, (g: string) => {
            W.label(g, { text: "Mix", bold: true });
            W.horizontal(g, (row: string) => {
                for (const p of MATTER_PIECES.slice(0, 4)) {
                    W.knob(row, { label: p.label.split(" ")[0], value: m.mix[p.id], min: 0, max: 6, onChange: (v: string) => { const n = parseFloat(v); if (Number.isFinite(n)) { m.mix[p.id] = n; scheduleSave(); } } });
                }
            });
            W.horizontal(g, (row: string) => {
                for (const p of MATTER_PIECES.slice(4)) {
                    W.knob(row, { label: p.label, value: m.mix[p.id], min: 0, max: 6, onChange: (v: string) => { const n = parseFloat(v); if (Number.isFinite(n)) { m.mix[p.id] = n; scheduleSave(); } } });
                }
            });
            W.label(g, { text: "The microphones: each piece's level, heard from the next hit. What the pieces hear of each other is unchanged." });
        });
    });
    });
}

function renderRackWindow(win: string) {
    const W = Entropy.UI.Widget;
    const track = getActiveTrack();
    W.horizontal(win, (row: string) => {
        renderSampleBrowser(row);
        if (track && track.kind === "drum") {
            renderPadBank(row, track);
            renderPadEditor(row, track);
        } else {
            W.group(row, (g: string) => {
                W.label(g, { text: "Pads", bold: true });
                W.label(g, { text: "The rack belongs to a drum track." });
                W.label(g, { text: "Pick one in the arrangement, or add one." });
                W.button(g, { text: "+ Drum Track", id: "rack_add_drum_track", onClick: () => { addTrack("drum"); persist(); } });
            });
        }
    });
}


// The built-in oscillator voice for one note: the track's filter (scaled by the note's tone),
// envelope, and the Acid knob's filter envelope and drive.
function builtInNoteConfig(t: Track, freq: number, velocity: number, duration: number, tone = 1) {
    return {
        freq,
        waveform: t.voice.waveform,
        duration,
        cutoff: toneCutoff(t.voice.cutoff, tone),
        resonance: t.voice.resonance,
        gain: velocity,
        attack: t.voice.attack,
        decay: t.voice.decay,
        sustain: t.voice.sustain,
        release: t.voice.release,
        filterEnv: t.voice.filterEnv ?? 0,
        filterDecay: t.voice.filterDecay ?? 0.2,
        drive: t.voice.drive ?? 1
    };
}

// Plays one note now. Unlike the old per-note architecture, mute/solo are no longer pre-filtered
// here - every track's bus (see syncTrackBus) applies them live, every sample, so toggling either
// one while a note is already ringing takes effect immediately instead of only affecting the
// *next* trigger. Track gain is likewise applied continuously by the bus, so only the note's own
// velocity is passed through here.
function playTrigger(t: Track, note: NoteCell, velocity: number) {
    const sd = stepDuration();
    const duration = Math.max(0.03, note.length * sd * 0.95);
    const tone = note.tone ?? 1;
    if (trackUsesVst3(t)) {
        playVst3Note(t, note.row, velocity, duration);
        return;
    }
    if (t.kind === "drum") {
        playPad(t, note.row, velocity, duration, tone);
        return;
    }
    if (isMatterTrack(t)) {
        matterRowHit(t, note.row, velocity);
        return;
    }
    const { freq } = noteVoiceAndFreq(t, note.row);
    if (isWavetableTrack(t)) {
        wavetableNote(t, freq, velocity, duration, tone);
        return;
    }
    if (isPhysModTrack(t)) {
        physModNote(t, freq, velocity, duration);
        return;
    }
    if (isBrassTrack(t)) {
        brassNote(t, freq, velocity, note.length * sd);
        return;
    }
    addon.Audio.playNoteOnTrack(t.id, builtInNoteConfig(t, freq, velocity, duration, tone));
}

// Notes queued to play at an exact moment. A step is queued half a step before it begins, so a
// note Humanize pulls early can still sound early; each note fires when the song reaches its time
// (its step, plus its own offset, plus Bounce and Humanize - see daw_moves.ts's grooveAt).
interface PendingNote { due: number; track: Track; note: NoteCell; velocity: number }
let pendingNotes: PendingNote[] = [];
const LOOKAHEAD_STEPS = 0.5;

function queueStep(absStep: number) {
    const wrapped = transport.mode === "pattern" ? absStep : absStep % songSteps(project);
    const triggers = transport.mode === "pattern"
        ? triggersAt(project, absStep, project.activeTrackId)
        : triggersAt(project, wrapped);
    for (const { track, note } of triggers) {
        const t = track as Track;
        const g = grooveAt(trackCharacter(t), wrapped, project.stepsPerBeat, note.row, `${t.id}|${wrapped}`);
        pendingNotes.push({ due: absStep + (note.offset ?? 0) + g.offset, track: t, note, velocity: grooveVelocity(note.velocity, g) });
    }
}

function firePendingNotes(stepFloat: number) {
    if (pendingNotes.length === 0) return;
    const due = pendingNotes.filter(p => p.due <= stepFloat).sort((a, b) => a.due - b.due);
    if (due.length === 0) return;
    pendingNotes = pendingNotes.filter(p => p.due > stepFloat);
    for (const p of due) playTrigger(p.track, p.note, p.velocity);
}

// The song position in steps right now (fractional), whether playing or parked.
function currentStepFloat(): number {
    if (!transport.playing) return transport.cursorStep;
    return (nowSeconds() - transport.startedAt) / stepDuration();
}

function transportLength(): number {
    if (transport.mode === "pattern") {
        const t = getActiveTrack();
        const pat = t ? activePattern(t) : undefined;
        return Math.max(1, pat?.steps ?? 1);
    }
    return songSteps(project);
}

function play() {
    transport.playing = true;
    transport.startedAt = nowSeconds() - transport.cursorStep * stepDuration();
    // ceil so a cursor parked exactly on a step plays that step, one parked mid-step waits for the next.
    transport.lastAbsStep = Math.ceil(transport.cursorStep) - 1;
    pendingNotes = [];
    syncTempoEffects();
}

function stop() {
    if (transport.playing) transport.cursorStep = currentStepFloat() % transportLength();
    transport.playing = false;
    pendingNotes = [];
    updateCuts(null);
}

function seekToStep(step: number) {
    const total = songSteps(project);
    transport.cursorStep = Math.max(0, Math.min(total - 0.001, step));
    if (transport.playing) {
        transport.startedAt = nowSeconds() - transport.cursorStep * stepDuration();
        transport.lastAbsStep = Math.ceil(transport.cursorStep) - 1;
        pendingNotes = [];
        syncTempoEffects();
    }
}

function rewind() {
    seekToStep(0);
}

// Changing tempo mid-run would jump the playhead (its position is elapsed time over step
// duration), so the run is re-anchored to where it currently is.
const BPM_MIN = 20;
const BPM_MAX = 300;

function setBpm(bpm: number) {
    const clamped = Math.max(BPM_MIN, Math.min(BPM_MAX, bpm));
    if (clamped === project.bpm) return;
    const pos = currentStepFloat();
    project.bpm = clamped;
    if (transport.playing) transport.startedAt = nowSeconds() - pos * stepDuration();
    syncTempoEffects();
}

// --- Offline WAV export -----------------------------------------------------

let lastExportStatus: string | null = null;

// When, and how hard, a placed note plays in an export: its own offset plus Bounce and Humanize,
// worked out exactly as the live sequencer does (queueStep), so a bounce grooves like playback.
function placedTiming(placed: PlacedNote): { startTime: number; velocity: number } {
    const track = placed.track as Track;
    const g = grooveAt(trackCharacter(track), placed.startStep, project.stepsPerBeat, placed.note.row, `${track.id}|${placed.startStep}`);
    return {
        startTime: Math.max(0, (placed.startStep + (placed.note.offset ?? 0) + g.offset) * stepDuration()),
        velocity: grooveVelocity(placed.note.velocity, g)
    };
}

// Every track's bus for an export: its gain (applied after its effects, as live), its character
// chain, and its Drop Gap hard cuts in seconds. Each event names its track, so it is mixed there.
function buildTrackBuses(): any[] {
    const sd = stepDuration();
    return project.tracks.map(t => ({
        track: t.id,
        gain: t.gain,
        effects: busEffects(trackCharacter(t), project.bpm),
        silences: projectCuts().filter(c => c.trackIds.includes(t.id)).map(c => [c.startStep * sd, c.endStep * sd])
    }));
}

// Renders the arrangement: every clip's pattern tiled across the clip, notes cut where the clip ends.
function buildPatternEvents(): any[] {
    const sd = stepDuration();
    const events: any[] = [];

    for (const placed of expandArrangement(project, { respectMuteSolo: true })) {
        const track = placed.track as Track;
        // The offline renderer only knows the built-in voices; a hosted plugin runs live. A wavetable
        // track is rendered by buildWavetableEvents from the table as it is now, and a physmod track
        // by buildPhysModEvents.
        if (track.instrument || isWavetableTrack(track) || isPhysModTrack(track) || isBrassTrack(track) || isMatterTrack(track)) continue;
        const { voice, freq } = noteVoiceAndFreq(track, placed.note.row);
        // A sample pad is rendered from its file (buildSampleEvents), and an empty pad is silent.
        if (track.kind === "drum" && (padAt(track, placed.note.row)?.sample || !voice)) continue;
        const duration = Math.max(0.03, placed.lengthSteps * sd * 0.95);
        const { startTime, velocity } = placedTiming(placed);

        events.push({
            track: track.id,
            startTime,
            freq,
            waveform: voice,
            duration,
            cutoff: toneCutoff(track.voice.cutoff, placed.note.tone ?? 1),
            resonance: track.voice.resonance,
            gain: velocity,
            attack: track.voice.attack,
            decay: track.voice.decay,
            sustain: track.voice.sustain,
            release: track.voice.release,
            delayTime: track.voice.delayTime,
            delayFeedback: track.voice.delayFeedback,
            delayMix: track.voice.delayMix,
            reverbRoomSize: track.voice.reverbRoomSize,
            reverbTime: track.voice.reverbTime,
            reverbDamping: track.voice.reverbDamping,
            reverbMix: track.voice.reverbMix,
            // Drum voices ignore these; the built-in oscillators take the Acid knob's settings.
            filterEnv: track.kind === "synth" ? track.voice.filterEnv ?? 0 : 0,
            filterDecay: track.voice.filterDecay ?? 0.2,
            drive: track.kind === "synth" ? track.voice.drive ?? 1 : 1
        });
    }

    return events;
}

// The sample pads' hits, one per note, for the same render: the file to play and how. The track's
// gain is applied on its bus (buildTrackBuses), after its effects, as it is live.
function buildSampleEvents(): any[] {
    const sd = stepDuration();
    const events: any[] = [];
    for (const placed of expandArrangement(project, { respectMuteSolo: true })) {
        const track = placed.track as Track;
        if (track.instrument || track.kind !== "drum") continue;
        const pad = padAt(track, placed.note.row);
        if (!pad?.sample) continue;
        const { startTime, velocity } = placedTiming(placed);
        const hit = padHit(pad, velocity, Math.max(0.03, placed.lengthSteps * sd * 0.95), isSampleMissing);
        if (!hit || hit.type !== "sample") continue;
        events.push({
            track: track.id, startTime, path: hit.path, gain: hit.gain,
            semitones: hit.semitones, start: hit.start, end: hit.end, hold: hit.hold
        });
    }
    return events;
}

// The wavetable tracks' notes for the same render. The offline renderer plays the table as it is now,
// through the same voice the live path uses; the track's gain is applied on its bus.
function buildWavetableEvents(): any[] {
    const sd = stepDuration();
    const events: any[] = [];
    for (const placed of expandArrangement(project, { respectMuteSolo: true })) {
        const track = placed.track as Track;
        if (!isWavetableTrack(track)) continue;
        const { freq } = noteVoiceAndFreq(track, placed.note.row);
        const { startTime, velocity } = placedTiming(placed);
        const tone = placed.note.tone ?? 1;
        const voice = tone === 1 ? track.voice : { ...track.voice, cutoff: toneCutoff(track.voice.cutoff, tone) };
        const config: any = wavetableNoteConfig(track.id, voice, trackWavetable(track), {
            freq, velocity,
            duration: Math.max(0.03, placed.lengthSteps * sd * 0.95),
            startTime,
        });
        config.trackId = track.id;
        events.push(config);
    }
    return events;
}

// The bowed-string tracks' notes for the same render, through the same voice the live path uses.
function buildPhysModEvents(): any[] {
    const sd = stepDuration();
    const events: any[] = [];
    for (const placed of expandArrangement(project, { respectMuteSolo: true })) {
        const track = placed.track as Track;
        if (!isPhysModTrack(track)) continue;
        const { freq } = noteVoiceAndFreq(track, placed.note.row);
        const { startTime, velocity } = placedTiming(placed);
        const config: any = physModNoteConfig(track.id, trackPhysMod(track), {
            freq, velocity,
            duration: Math.max(0.03, placed.lengthSteps * sd * 0.95),
            startTime,
        });
        config.trackId = track.id;
        events.push(config);
    }
    return events;
}

// The brass tracks' notes for the same render: one player per track, so slurs survive the bounce.
function buildBrassEvents(): any[] {
    const sd = stepDuration();
    const events: any[] = [];
    for (const placed of expandArrangement(project, { respectMuteSolo: true })) {
        const track = placed.track as Track;
        if (!isBrassTrack(track)) continue;
        const b = trackBrass(track);
        const { freq } = noteVoiceAndFreq(track, placed.note.row);
        const { startTime, velocity } = placedTiming(placed);
        events.push(brassNoteConfig(track.id, b, { freq, velocity, duration: brassHeldSeconds(b, placed.lengthSteps * sd), startTime }));
    }
    return events;
}

// The drum-kit tracks' hits for the same render: one kit per track, so the pieces ring on and hear
// each other in the bounce as they do live.
function buildMatterEvents(): any[] {
    const events: any[] = [];
    for (const placed of expandArrangement(project, { respectMuteSolo: true })) {
        const track = placed.track as Track;
        if (!isMatterTrack(track)) continue;
        const { startTime, velocity } = placedTiming(placed);
        events.push(matterHitConfig(track.id, trackMatter(track), { row: placed.note.row, velocity, startTime }));
    }
    return events;
}

// The VST3-hosted tracks' notes for the same render (see src/audio/vst3.rs's render_offline_track):
// each track is rendered through its own fresh, temporary plugin instance - separate from whatever
// the same plugin has loaded live on the track's bus - using a state snapshot taken right now where
// the plugin is currently loaded, so the bounce matches what is actually sounding rather than
// whatever was last saved to the project. A track whose plugin was never successfully loaded this
// session falls back to the state stored on the track (still correct for a project just reopened).
function buildVst3Events(): { path: string; state: string | null; notes: any[]; track: string }[] {
    const sd = stepDuration();
    const byTrack = new Map<string, { path: string; state: string | null; notes: any[]; track: string }>();

    for (const placed of expandArrangement(project, { respectMuteSolo: true })) {
        const track = placed.track as Track;
        if (!track.instrument) continue;
        let entry = byTrack.get(track.id);
        if (!entry) {
            const liveState = vst3Runtime[track.id]?.ok ? addon.Vst3.saveState(track.id) : null;
            entry = { path: track.instrument.path, state: liveState ?? track.instrument.state ?? null, notes: [], track: track.id };
            byTrack.set(track.id, entry);
        }
        const { startTime, velocity } = placedTiming(placed);
        entry.notes.push({
            startTime,
            duration: Math.max(0.03, placed.lengthSteps * sd * 0.95),
            note: midiForRow(track, placed.note.row),
            velocity: Math.max(1, Math.min(127, Math.round(velocity * 127))),
            channel: 0
        });
    }

    return Array.from(byTrack.values());
}

function exportPatternToWav(): { success: boolean; path?: string; durationSeconds?: number; error?: string; vst3Warnings?: string[] } {
    const events = buildPatternEvents();
    const sampleEvents = buildSampleEvents();
    const wavetableEvents = buildWavetableEvents();
    const physModEvents = buildPhysModEvents();
    const brassEvents = buildBrassEvents();
    const matterEvents = buildMatterEvents();
    const vst3Events = buildVst3Events();
    const result = addon.Audio.renderPatternToWav(events, `daw-song-${project.bpm}bpm.wav`, sampleEvents, wavetableEvents, physModEvents, vst3Events, buildTrackBuses(), brassEvents, matterEvents);
    const lost = Object.keys(sampleMissing).length;
    const vst3Failed = result.vst3Warnings?.length ?? 0;
    lastExportStatus = result.success
        ? `Exported ${result.durationSeconds.toFixed(2)}s to ${result.path}`
            + (vst3Failed > 0 ? ` (${vst3Failed} VST3 track${vst3Failed === 1 ? "" : "s"} could not be rendered: ${result.vst3Warnings!.join("; ")})` : "")
            + (lost > 0 ? ` (${lost} missing sample file${lost === 1 ? "" : "s"} left out)` : "")
        : `Export failed: ${result.error}`;
    return result;
}

// --- Arrangement editing -----------------------------------------------------

let selectedClipId: string | null = null;
let arrangementStatus = "";

// What the Analyzer section is looking at. UI-only: it is not part of the saved project, since
// which track you happen to be listening to is not something a song is made of.
const analyzer = {
    /** "master" or a track id; both are names the audio engine's analysis taps answer to. */
    source: "master" as string,
    fftSize: 4096,
    style: "filled" as "filled" | "bars",
    scope: "stereo" as "stereo" | "mono" | "xy",
    trigger: true
};
const SCOPE_MODES = ["stereo", "mono", "xy"] as const;
const FFT_SIZES = [1024, 2048, 4096, 8192];

function selectedClip(): ArrClip | undefined {
    return selectedClipId ? project.arrangement.find(c => c.id === selectedClipId) : undefined;
}

// A pattern that no clip plays is silent, which reads as "the editor is broken" to someone who has
// just painted notes. So the first notes written to a track that has no clips at all also give it
// one clip spanning the song - the same "loops for as long as the song runs" the DAW used to have.
function ensureTrackHasClip(track: Track) {
    if (project.arrangement.some(c => c.trackId === track.id)) return;
    createClip(project.arrangement, {
        trackId: track.id, patternId: activePattern(track).id, startStep: 0, lengthSteps: songSteps(project)
    }, songSteps(project), newId);
}

function selectClip(clip: ArrClip | undefined) {
    selectedClipId = clip?.id ?? null;
    if (!clip) return;
    const track = findTrack(clip.trackId);
    if (!track) return;
    project.activeTrackId = track.id;
    // Editing follows the selection: the piano roll shows the pattern the clip plays.
    track.activePatternId = clip.patternId;
}

// Lane ids for empty channels are `empty:<channel>`. Touching one gives the channel a synth track,
// so any of the 16 lanes can be started by clicking or drawing on it.
function trackForLane(laneId: string, kind: "synth" | "drum" = "synth"): Track | undefined {
    if (!laneId.startsWith("empty:")) return findTrack(laneId);
    const channel = parseInt(laneId.slice("empty:".length), 10);
    if (!Number.isFinite(channel) || project.tracks.some(t => t.channel === channel)) return undefined;
    return addTrack(kind, channel);
}

function onArrangementSeek(ms: number) {
    seekToStep(msToStep(ms, project.bpm, project.stepsPerBeat));
}

function onArrangementClipSelected(trackId: string, clipId: string) {
    const clip = project.arrangement.find(c => c.id === clipId && c.trackId === trackId);
    selectClip(clip);
}

function onArrangementClipMoved(_trackId: string, clipId: string, startMs: number) {
    moveClip(project.arrangement, clipId, msToStep(startMs, project.bpm, project.stepsPerBeat), songSteps(project));
    scheduleSave();
}

function onArrangementClipResized(_trackId: string, clipId: string, startMs: number, durationMs: number) {
    const start = msToStep(startMs, project.bpm, project.stepsPerBeat);
    const len = Math.max(1, msToStep(durationMs, project.bpm, project.stepsPerBeat));
    resizeClip(project.arrangement, clipId, start, len, songSteps(project));
    scheduleSave();
}

function onArrangementClipDelete(_trackId: string, clipId: string) {
    deleteClip(project.arrangement, clipId);
    if (selectedClipId === clipId) selectedClipId = null;
    persist();
}

function onArrangementClipDuplicate(_trackId: string, clipId: string) {
    const copy = duplicateClip(project.arrangement, clipId, songSteps(project), newId);
    if (copy) {
        selectClip(copy);
        arrangementStatus = "";
    } else {
        arrangementStatus = "No room after that clip for a copy.";
    }
    persist();
}

function onArrangementClipCreate(laneId: string, startMs: number, durationMs: number) {
    const track = trackForLane(laneId);
    if (!track) return;
    const start = msToStep(startMs, project.bpm, project.stepsPerBeat);
    const len = Math.max(1, msToStep(durationMs, project.bpm, project.stepsPerBeat));
    const clip = createClip(project.arrangement, {
        trackId: track.id, patternId: activePattern(track).id, startStep: start, lengthSteps: len
    }, songSteps(project), newId);
    if (clip) {
        selectClip(clip);
        arrangementStatus = "";
    } else {
        arrangementStatus = "That spot is already taken by another clip on this channel.";
    }
    persist();
}

function onArrangementTrackClicked(laneId: string) {
    const track = trackForLane(laneId);
    if (track) {
        project.activeTrackId = track.id;
        persist();
    }
}

function onArrangementTrackMute(trackId: string) {
    const t = findTrack(trackId);
    if (!t) return;
    t.muted = !t.muted;
    persist();
}

function onArrangementTrackSolo(trackId: string) {
    const t = findTrack(trackId);
    if (!t) return;
    t.solo = !t.solo;
    persist();
}

function onArrangementBackground() {
    selectedClipId = null;
}

function setSnap(mode: SnapMode) {
    project.snap = mode;
    writeProject();
}

function setSongBars(bars: number) {
    project.songBars = Math.max(1, Math.min(256, Math.round(bars)));
    pruneArrangement(project);
    if (selectedClipId && !project.arrangement.some(c => c.id === selectedClipId)) selectedClipId = null;
    persist();
}

function instrumentSummary(track: Track): string {
    if (track.instrument) return track.instrument.name;
    // Short on purpose: the header has room for about 16 characters beside the M/S pills.
    if (track.kind === "drum") return ensureRack(track).some(p => p.sample) ? "Sample rack" : "Drum kit";
    return `${track.voice.waveform[0].toUpperCase()}${track.voice.waveform.slice(1)} synth`;
}

// --- Grid paint interaction --------------------------------------------------

let dragMode: "add" | "erase" | null = null;
let lastCellKey: string | null = null;

function findNoteIndexAt(pattern: Pattern, row: number, step: number): number {
    return pattern.notes.findIndex(n => n.row === row && step >= n.step && step < n.step + n.length);
}

function applyCell(pattern: Pattern, row: number, step: number) {
    const idx = findNoteIndexAt(pattern, row, step);
    if (dragMode === "add") {
        if (idx === -1) {
            pattern.notes.push({ row, step, length: 1, velocity: 0.85 });
        }
    } else if (dragMode === "erase") {
        if (idx !== -1) pattern.notes.splice(idx, 1);
    }
}

function handleNoteDown(row: number, step: number) {
    const track = getActiveTrack();
    if (!track) return;
    // Painting over a Kick Lock preview keeps the preview: you are editing what you see.
    if (kickPreview) applyKickPreview();
    const pattern = activePattern(track);
    dragMode = findNoteIndexAt(pattern, row, step) >= 0 ? "erase" : "add";
    lastCellKey = `${row}:${step}`;
    applyCell(pattern, row, step);
}

function handleNoteDrag(row: number, step: number) {
    const key = `${row}:${step}`;
    if (key === lastCellKey || !dragMode) return;
    lastCellKey = key;
    const track = getActiveTrack();
    if (!track) return;
    applyCell(activePattern(track), row, step);
}

function handleNoteUp(_row: number, _step: number) {
    dragMode = null;
    lastCellKey = null;
    const track = getActiveTrack();
    if (track) ensureTrackHasClip(track);
    persist();
}

// --- Pattern management --------------------------------------------------------

const PATTERN_LENGTH_BARS = [0.5, 1, 2, 4];
const PATTERN_LENGTH_LABELS = ["1/2 bar", "1 bar", "2 bars", "4 bars"];

function patternLengthIndex(pattern: Pattern): number {
    const bars = pattern.steps / barSteps(project.stepsPerBeat);
    let best = 0;
    PATTERN_LENGTH_BARS.forEach((b, i) => {
        if (Math.abs(b - bars) < Math.abs(PATTERN_LENGTH_BARS[best] - bars)) best = i;
    });
    return best;
}

function addPattern(track: Track, name?: string, steps?: number, notes: NoteCell[] = []): Pattern {
    const pattern = newPattern(name ?? nextPatternName(track), steps ?? barSteps(project.stepsPerBeat), notes);
    track.patterns.push(pattern);
    track.activePatternId = pattern.id;
    return pattern;
}

function duplicatePattern(track: Track): Pattern {
    const src = activePattern(track);
    const copy = addPattern(track, `${src.name} copy`, src.steps, src.notes.map(n => ({ ...n })));
    // A variation is only useful where it plays, so a selected clip of this track switches to it.
    const clip = selectedClip();
    if (clip && clip.trackId === track.id) clip.patternId = copy.id;
    return copy;
}

// --- Quick moves (see daw_moves.ts) ------------------------------------------------------------
//
// The buttons in the Moves panel. Pattern moves (Variation, Thin Out, Stutter, Octave Spark, Kick
// Lock) rewrite the pattern in the piano roll; arrangement moves (Build, Drop Gap, Echo Out,
// Answer) write a new pattern and place it, clearing the span they need on that lane. Every move
// first takes an undo snapshot of the patterns, the clips and the hard cuts.

const moveOpts = {
    amount: 0.5,
    focus: "mixed" as VariationFocus,
    variationAsNew: false,
    stutterRate: "16th" as StutterRate,
    kickAlign: true,
    buildBars: 4,
    buildSweep: true,
    gapLength: "beat" as "beat" | "half",
    gapScope: "drums" as "drums" | "all",
    keepTails: true,
    echoLength: "beat" as "beat" | "half",
};
let moveStatus = "";
// Each Variation press is a new seed, so pressing again gives a different variation.
let variationSeed = 1;

interface MoveSnapshot {
    label: string;
    arrangement: ArrClip[];
    tracks: { id: string; patterns: Pattern[]; activePatternId: string; rows: number }[];
    cuts: HardCut[];
}
const undoStack: MoveSnapshot[] = [];
const UNDO_LIMIT = 20;

function takeSnapshot(label: string) {
    cancelKickPreview();
    undoStack.push(JSON.parse(JSON.stringify({
        label,
        arrangement: project.arrangement,
        tracks: project.tracks.map(t => ({ id: t.id, patterns: t.patterns, activePatternId: t.activePatternId, rows: t.rows })),
        cuts: projectCuts(),
    })));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undoMove(): string {
    cancelKickPreview();
    const snap = undoStack.pop();
    if (!snap) return moveStatus = "Nothing to undo.";
    project.arrangement = snap.arrangement;
    for (const saved of snap.tracks) {
        const t = findTrack(saved.id);
        if (!t) continue;
        t.patterns = saved.patterns;
        t.activePatternId = saved.activePatternId;
        t.rows = saved.rows;
    }
    project.cuts = snap.cuts;
    pruneArrangement(project);
    if (selectedClipId && !project.arrangement.some(c => c.id === selectedClipId)) selectedClipId = null;
    persist();
    return moveStatus = `Undid ${snap.label}.`;
}

function patternStepsOf(clip: ArrClip): number {
    return findTrack(clip.trackId)?.patterns.find(p => p.id === clip.patternId)?.steps ?? 1;
}

function rowsPerOctave(track: Track): number {
    return track.kind === "drum" ? 12 : (SCALES[track.scale] ?? SCALES.chromatic).length;
}

function moveContext(track: Track, pattern: Pattern): MoveContext {
    const rack = track.kind === "drum" ? ensureRack(track) : [];
    return {
        steps: pattern.steps,
        stepsPerBeat: project.stepsPerBeat,
        kind: track.kind,
        rows: track.rows,
        rowsPerOctave: rowsPerOctave(track),
        kickRows: rack.map((p, i) => (isKickPad(p) ? i : -1)).filter(i => i >= 0),
        fillRows: rollRows(rack),
    };
}

// A synth track's rows grow to fit notes written above them (an octave spark, an answer).
function fitRows(track: Track, pattern: Pattern) {
    if (track.kind !== "synth") return;
    const top = pattern.notes.reduce((m, n) => Math.max(m, n.row), -1);
    if (top >= track.rows) track.rows = top + 1;
}

// Writes `pattern` onto `track`'s lane over [start, start + length), clearing that span first.
function placePattern(track: Track, pattern: Pattern, start: number, length: number): ArrClip | null {
    const total = songSteps(project);
    const end = Math.min(total, start + length);
    if (start < 0 || end <= start) return null;
    carveRange(project.arrangement, new Set([track.id]), start, end, patternStepsOf, newId);
    const clip = createClip(project.arrangement, { trackId: track.id, patternId: pattern.id, startStep: start, lengthSteps: end - start }, total, newId);
    return clip;
}

const barLabel = (step: number) => {
    const bar = barSteps(project.stepsPerBeat);
    const beat = Math.floor((step % bar) / project.stepsPerBeat) + 1;
    return beat === 1 ? `bar ${Math.floor(step / bar) + 1}` : `bar ${Math.floor(step / bar) + 1} beat ${beat}`;
};

// --- Pattern moves

function variationMove(track: Track): string {
    let pattern = activePattern(track);
    if (pattern.notes.length === 0) return moveStatus = `${pattern.name} is empty: paint a few notes to vary first.`;
    takeSnapshot("Make Variation");
    if (moveOpts.variationAsNew) pattern = duplicatePattern(track);
    const before = JSON.stringify(pattern.notes);
    pattern.notes = makeVariation(pattern.notes, moveContext(track, pattern), { strength: moveOpts.amount, focus: moveOpts.focus, seed: variationSeed++ });
    const changed = JSON.stringify(pattern.notes) !== before;
    persist();
    return moveStatus = changed
        ? `${pattern.name}: ${VARIATION_LABELS[VARIATION_FOCI.indexOf(moveOpts.focus)].toLowerCase()} variation at ${Math.round(moveOpts.amount * 100)}%. Press again for another.`
        : `${pattern.name}: that variation came out the same - press again.`;
}

function thinOutMove(track: Track): string {
    const pattern = activePattern(track);
    takeSnapshot("Thin Out");
    const r = thinOut(pattern.notes, moveContext(track, pattern), moveOpts.amount);
    if (r.removed === 0) { undoStack.pop(); return moveStatus = `${pattern.name}: nothing left to thin - only downbeats and phrase anchors remain.`; }
    pattern.notes = r.notes;
    persist();
    return moveStatus = `${pattern.name}: removed ${r.removed} weaker note${r.removed === 1 ? "" : "s"}, kept the downbeats and anchors.`;
}

function stutterMove(track: Track): string {
    const pattern = activePattern(track);
    if (pattern.notes.length === 0) return moveStatus = `${pattern.name} is empty.`;
    takeSnapshot("Stutter");
    pattern.notes = stutter(pattern.notes, moveContext(track, pattern), moveOpts.stutterRate);
    persist();
    return moveStatus = `${pattern.name}: the last beat now stutters in ${moveOpts.stutterRate} notes.`;
}

function octaveSparkMove(track: Track): string {
    if (track.kind !== "synth") return moveStatus = "Octave Spark is for a bass or lead: pick a synth track.";
    const pattern = activePattern(track);
    const r = octaveSpark(pattern.notes, moveContext(track, pattern));
    if (r.added === 0) return moveStatus = `${pattern.name}: no free offbeat near the end for a spark.`;
    takeSnapshot("Octave Spark");
    pattern.notes = r.notes;
    fitRows(track, pattern);
    persist();
    return moveStatus = `${pattern.name}: added ${r.added} octave-up spark${r.added === 1 ? "" : "s"} near the end.`;
}

function answerMove(track: Track): string {
    if (track.kind !== "synth") return moveStatus = "Answer is for a melody or bassline: pick a synth track.";
    const clip = selectedClip();
    const onTrack = clip && clip.trackId === track.id ? clip : undefined;
    const phrase = onTrack ? track.patterns.find(p => p.id === onTrack.patternId) ?? activePattern(track) : activePattern(track);
    const notes = answerPhrase(phrase.notes, moveContext(track, phrase));
    if (notes.length === 0) return moveStatus = `${phrase.name} is empty: there is nothing to answer.`;
    takeSnapshot("Answer");
    const answer = addPattern(track, `${phrase.name} answer`, phrase.steps, notes);
    fitRows(track, answer);
    if (!onTrack) {
        persist();
        return moveStatus = `Wrote ${answer.name}. Select a clip of ${track.name} to place the answer after it.`;
    }
    // A clip that loops its phrase is answered in its second pass; a single pass, right after it.
    const at = onTrack.lengthSteps > phrase.steps ? onTrack.startStep + phrase.steps : clipEnd(onTrack);
    const placed = placePattern(track, answer, at, phrase.steps);
    persist();
    return moveStatus = placed
        ? `${answer.name} answers from ${barLabel(placed.startStep)}.`
        : `Wrote ${answer.name}, but the song ends before there is room to place it.`;
}

// --- Kick Lock, with a preview: the proposed pattern plays and shows until Apply or Cancel.
// The proposal sits in the pattern itself (that is what makes it audible), so a save that happens
// during the preview - a knob, the frame loop's debounce - writes it; Cancel puts the original back.

let kickPreview: { trackId: string; patternId: string; original: NoteCell[]; changes: KickLockChange[] } | null = null;

// The kick's steps under one pass of `pattern`: from a clip that plays it (the selected one first)
// and the drum clips beside it, or failing that the drum track's own pattern tiled across it.
function kickStepsFor(track: Track, pattern: Pattern): number[] {
    const drums = project.tracks.filter(t => t.kind === "drum");
    const kickRowsOf = (t: Track) => ensureRack(t).map((p, i) => (isKickPad(p) ? i : -1)).filter(i => i >= 0);
    const sel = selectedClip();
    const clip = sel && sel.trackId === track.id && sel.patternId === pattern.id
        ? sel
        : clipsOfTrack(project.arrangement, track.id).find(c => c.patternId === pattern.id);
    if (clip) {
        const kicks: number[] = [];
        const drumIds = new Set(drums.map(d => d.id));
        for (const placed of expandArrangement(project, { respectMuteSolo: false })) {
            const t = placed.track as Track;
            if (!drumIds.has(t.id) || !kickRowsOf(t).includes(placed.note.row)) continue;
            const rel = placed.startStep - clip.startStep;
            if (rel < 0 || rel >= Math.min(pattern.steps, clip.lengthSteps)) continue;
            kicks.push(clipLocalStep(clip, placed.startStep, pattern.steps));
        }
        if (kicks.length > 0) return kicks;
    }
    const drum = drums[0];
    if (!drum) return [];
    const dp = activePattern(drum);
    const rows = kickRowsOf(drum);
    const kicks: number[] = [];
    for (const n of dp.notes) {
        if (!rows.includes(n.row)) continue;
        for (let at = n.step; at < pattern.steps; at += dp.steps) kicks.push(at);
    }
    return kicks;
}

function kickLockMove(track: Track): string {
    cancelKickPreview();
    if (track.kind !== "synth") return moveStatus = "Kick Lock works on a bassline: pick a synth track.";
    const pattern = activePattern(track);
    const kicks = kickStepsFor(track, pattern);
    if (kicks.length === 0) return moveStatus = "No kick found: Kick Lock needs a drum track with a kick pad.";
    const r = kickLock(pattern.notes, kicks, moveContext(track, pattern), moveOpts.kickAlign);
    if (r.changes.length === 0) return moveStatus = `${pattern.name} already stays out of the kick's way.`;
    kickPreview = { trackId: track.id, patternId: pattern.id, original: pattern.notes, changes: r.changes };
    pattern.notes = r.notes;
    return moveStatus = "";
}

function kickPreviewPattern(): Pattern | undefined {
    if (!kickPreview) return undefined;
    return findTrack(kickPreview.trackId)?.patterns.find(p => p.id === kickPreview!.patternId);
}

function cancelKickPreview() {
    const pattern = kickPreviewPattern();
    if (pattern && kickPreview) pattern.notes = kickPreview.original;
    kickPreview = null;
}

function applyKickPreview(): string {
    const pattern = kickPreviewPattern();
    if (!pattern || !kickPreview) { kickPreview = null; return moveStatus; }
    const proposed = pattern.notes;
    const count = kickPreview.changes.length;
    takeSnapshot("Kick Lock"); // restores the original, which is what the snapshot keeps
    pattern.notes = proposed;
    persist();
    return moveStatus = `${pattern.name}: kick-locked ${count} note${count === 1 ? "" : "s"}.`;
}

function kickPreviewLines(): string[] {
    if (!kickPreview) return [];
    const track = findTrack(kickPreview.trackId);
    if (!track) return [];
    const name = (row: number) => midiToName(rowToMidi(row, track.rootNote, track.scale));
    const pos = (step: number) => `${Math.floor(step / project.stepsPerBeat) + 1}.${(step % project.stepsPerBeat) + 1}`;
    return kickPreview.changes.map(c => c.kind === "aligned"
        ? `${name(c.row)} at ${pos(c.fromStep)} moves onto the kick at ${pos(c.toStep)}${c.toLength !== c.fromLength ? `, ${c.toLength} step${c.toLength === 1 ? "" : "s"} long` : ""}`
        : `${name(c.row)} at ${pos(c.fromStep)} shortened from ${c.fromLength} to ${c.toLength} step${c.toLength === 1 ? "" : "s"}`);
}

// --- Arrangement moves, at a section boundary: the bar line nearest the playhead.

function boundaryStep(): number {
    return nearestBar(transport.cursorStep, project.stepsPerBeat);
}

function buildTargetDrums(): Track | undefined {
    const active = getActiveTrack();
    return active?.kind === "drum" ? active : project.tracks.find(t => t.kind === "drum");
}

function buildMove(): string {
    const bar = barSteps(project.stepsPerBeat);
    const boundary = boundaryStep();
    const bars = moveOpts.buildBars;
    const start = boundary - bars * bar;
    if (start < 0) return moveStatus = `A ${bars}-bar build needs ${bars} bars before the boundary: park the playhead on the first bar of the new section (at bar ${bars + 1} or later).`;
    const drums = buildTargetDrums();
    if (!drums) return moveStatus = "Build writes a drum roll: add a drum track first.";
    const rack = ensureRack(drums);
    const row = rollRows(rack)[0] ?? Math.min(1, rack.length - 1);
    const kickRow = rack.findIndex(p => isKickPad(p));
    const kicks = kickRow < 0 ? [] : expandArrangement(project, { respectMuteSolo: false })
        .filter(p => p.track.id === drums.id && p.note.row === kickRow && p.startStep >= start && p.startStep < boundary)
        .map(p => p.startStep - start);
    takeSnapshot("Build");
    const notes = buildRoll(bars, project.stepsPerBeat, row, { sweep: moveOpts.buildSweep, kickRow: kickRow < 0 ? undefined : kickRow, kicks });
    const pattern = addPattern(drums, `Build ${bars}`, bars * bar, notes);
    placePattern(drums, pattern, start, bars * bar);
    persist();
    const sweepNote = moveOpts.buildSweep && rack[row]?.sample ? " (the filter sweep shapes built-in voices; this pad plays a sample, so it rises in level only)" : "";
    return moveStatus = `${drums.name}: a ${bars}-bar build from ${barLabel(start)} into ${barLabel(boundary)}${sweepNote}.`;
}

function dropGapMove(): string {
    const boundary = boundaryStep();
    const gap = moveOpts.gapLength === "beat" ? project.stepsPerBeat : barSteps(project.stepsPerBeat) / 2;
    const start = boundary - gap;
    if (start < 0) return moveStatus = "Park the playhead on the first bar of the drop (click the ruler), then press Drop Gap.";
    const tracks = moveOpts.gapScope === "drums" ? project.tracks.filter(t => t.kind === "drum") : project.tracks;
    if (tracks.length === 0) return moveStatus = "There are no drum tracks to cut.";
    takeSnapshot("Drop Gap");
    const ids = new Set(tracks.map(t => t.id));
    carveRange(project.arrangement, ids, start, boundary, patternStepsOf, newId);
    if (!moveOpts.keepTails) {
        project.cuts = projectCuts().filter(c => !(c.startStep === start && c.endStep === boundary));
        project.cuts.push({ id: newId(), trackIds: [...ids], startStep: start, endStep: boundary });
    }
    if (selectedClipId && !project.arrangement.some(c => c.id === selectedClipId)) selectedClipId = null;
    persist();
    const what = moveOpts.gapScope === "drums" ? "the drums" : "everything";
    const length = moveOpts.gapLength === "beat" ? "last beat" : "last half-bar";
    return moveStatus = `Cut ${what} for the ${length} before ${barLabel(boundary)}` + (moveOpts.keepTails ? ", letting tails ring." : ", tails and all.");
}

function echoOutMove(): string {
    const clip = selectedClip();
    if (!clip) return moveStatus = "Select the clip whose ending should echo out.";
    const track = findTrack(clip.trackId);
    if (!track) return moveStatus;
    const bar = barSteps(project.stepsPerBeat);
    const slice = moveOpts.echoLength === "beat" ? project.stepsPerBeat : bar / 2;
    const end = clipEnd(clip);
    if (end + 1 > songSteps(project)) return moveStatus = "The clip ends the song: lengthen the song (Song bars) to leave room for the echo.";
    const placed = expandArrangement(project, { respectMuteSolo: false })
        .filter(p => p.track.id === track.id && p.startStep >= clip.startStep && p.startStep < end)
        .map(p => ({ row: p.note.row, time: p.startStep + (p.note.offset ?? 0), length: p.lengthSteps, velocity: p.note.velocity, tone: p.note.tone }));
    const ending = phraseEnding(placed, end, slice);
    if (ending.length === 0) return moveStatus = "That clip plays no notes to echo.";
    takeSnapshot("Echo Out");
    const pattern = addPattern(track, "Echo", bar, echoRepeats(ending, slice, Math.round(bar / slice)));
    const echo = placePattern(track, pattern, end, bar);
    persist();
    return moveStatus = `${track.name}: the phrase's last ${moveOpts.echoLength === "beat" ? "beat" : "half-bar"} echoes out from ${barLabel(echo?.startStep ?? end)}, fading and darkening`
        + (track.kind === "drum" ? " (darkening shapes built-in voices; sample pads fade in level)." : ".");
}

function removeCut(id: string) {
    takeSnapshot("Remove hard cut");
    project.cuts = projectCuts().filter(c => c.id !== id);
    persist();
}

// --- UI ----------------------------------------------------------------------

function rowLabelsFor(track: Track): string[] {
    if (track.kind === "drum") {
        return ensureRack(track).map((p, i) => p.name || `Pad ${i + 1}`);
    }
    if (isMatterTrack(track)) return MATTER_ROWS.map(r => r.label);
    const labels: string[] = [];
    for (let r = track.rows - 1; r >= 0; r--) {
        labels.push(midiToName(rowToMidi(r, track.rootNote, track.scale)));
    }
    return labels;
}

// The piano roll widget draws row 0 at the top. For synth tracks we want low pitches
// at the bottom like a real piano roll, so we flip rows for display; drum tracks keep
// their natural Kick-at-top order, matching rowLabelsFor() below.
function toDisplayRow(track: Track, row: number): number {
    if (track.kind === "drum" || isMatterTrack(track)) return row;
    return track.rows - 1 - row;
}

// Brings any saved project - an open song, a version, a template, an old DAW.json - up to date.
// Effect ids are per-session handles into the engine's effect registry, so saved ones are meaningless
// now and are cleared for syncTrackBus to recreate. A project saved before the arrangement existed
// is migrated in place (see migrateProject). Throws on something that is not a project at all.
function repairProject(saved: any): DAWProject {
    if (!saved || !Array.isArray(saved.tracks)) throw new Error("that file is not a DAW song");
    for (const t of saved.tracks) {
        t.delayEffectId = null;
        t.reverbEffectId = null;
    }
    migrateProject(saved, newId);
    // A project from before drum racks has no `rack`: it gets the five built-in pads it always had.
    for (const t of saved.tracks) if (t.kind === "drum") ensureRack(t);
    // A wavetable track's settings are clamped, and its saved table is checked when the engine is given it.
    for (const t of saved.tracks) if (t.wavetable || t.voice?.waveform === WT_WAVEFORM) t.wavetable = repairWavetable(t.wavetable);
    for (const t of saved.tracks) if (t.physmod || t.voice?.waveform === PHYSMOD_WAVEFORM) t.physmod = repairPhysMod(t.physmod);
    for (const t of saved.tracks) if (t.brass || t.voice?.waveform === BRASS_WAVEFORM) t.brass = repairBrass(t.brass);
    for (const t of saved.tracks) if (t.matter || t.voice?.waveform === MATTER_WAVEFORM) t.matter = repairMatter(t.matter);
    for (const t of saved.tracks) if (t.character) t.character = repairCharacter(t.character);
    saved.cuts = repairCuts(saved.cuts);
    const repaired = saved as DAWProject;
    if (saved.guitar) repaired.guitar = readGuitarPrefs(saved.guitar);
    if (!repaired.tracks.some(t => t.id === repaired.activeTrackId)) repaired.activeTrackId = repaired.tracks[0]?.id ?? null;
    return repaired;
}

// --- Song library (see daw_library.ts) ---------------------------------------------------------
//
// Every song lives in its own file under the DAW's store folder, saved as you work; the library
// lists them, and each song keeps a version history. Opening another song never asks "save
// changes?": the song you leave is already saved, and a version of it is kept on the way out.
//
// Without a data folder (an app that never called with_data_dir) the store is unavailable: the
// library then lives in memory for the session and the open song still goes to IO.save, as before.

const addonStore: SongStore | null = (addon.IO as any).store ?? null;
let libraryPersistent = !!addonStore;
let library = new SongLibrary<DAWProject>(addonStore ?? memoryStore(), { now: () => Date.now(), uuid: newId });

// The last save's outcome, for the status beside the song name.
const saveState = { at: 0, error: "" };
// A short message about the last library action, with an optional Undo.
let libraryToast: { text: string; at: number; undo?: { label: string; run: () => void } } | null = null;
const TOAST_MS = 12_000;

function toast(text: string, undo?: { label: string; run: () => void }) {
    libraryToast = { text, at: Date.now(), undo };
}

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** The one place the open song is written. Never throws: a failure shows beside the song name. */
function writeProject() {
    saveDueAt = 0;
    try {
        const id = library.currentSongId;
        if (id) library.saveSong(id, project);
        if (!libraryPersistent) addon.IO.save(project);
        saveState.at = Date.now();
        saveState.error = "";
    } catch (e) {
        saveState.error = errorText(e);
        Entropy.println("DAW: could not save the song: " + saveState.error);
    }
}

/** Runs a library action, turning a failure into a message rather than an exception in a click. */
function libraryAction(what: string, run: () => void) {
    try {
        run();
    } catch (e) {
        toast(`Could not ${what}: ${errorText(e)}`);
        Entropy.println(`DAW: could not ${what}: ${errorText(e)}`);
    }
}

function currentSongName(): string {
    return library.current()?.name ?? "Untitled song";
}

/** Swaps the song the DAW is playing and editing. Everything that belonged to the old one - its
 * buses, plugins, wavetables, undo steps, selection - goes; the new one's are built up. */
function installProject(next: DAWProject, teardown = true) {
    if (teardown) {
        stop();
        rewind();
        if (guitarStatus.running) stopGuitar();
        for (const track of project.tracks) removeTrackBus(track);
    }
    project = next;
    selectedClipId = null;
    arrangementStatus = "";
    kickPreview = null;
    undoStack.length = 0;
    moveStatus = "";
    saveDueAt = 0;
    transport.mode = "song";
    transport.cursorStep = 0;
    bpmDraft = String(project.bpm);
    bpmDraftFor = project.bpm;
    if (teardown) {
        project.tracks.forEach(syncTrackBus);
        verifyRacks();
        project.tracks.forEach(t => { if (t.instrument) loadTrackInstrument(t, t.instrument); });
    }
}

/** Keeps a version of the song being left, if it changed since its last one. */
function versionSongBeingLeft() {
    const id = library.currentSongId;
    if (!id) return;
    flushPendingSave();
    if (library.nextAutoVersionIn(id) !== null) library.addVersion(id, project, "auto");
    library.flushIndex();
}

function openSong(id: string) {
    if (id === library.currentSongId) return;
    versionSongBeingLeft();
    const { project: loaded, note } = library.loadSong(id);
    const repaired = repairProject(loaded);
    installProject(repaired);
    library.setCurrent(id);
    // The song as it was when opened, so this session's changes can always be undone as a whole.
    library.addVersion(id, project, "opened");
    selectedSongId = id;
    historySelection = null;
    toast(note ?? `Opened "${currentSongName()}".`);
}

function createSongFromTemplate(template: SongTemplate, name?: string): SongEntry {
    versionSongBeingLeft();
    const fresh = repairProject(template.make());
    const entry = library.createSong(name ?? template.songName, fresh);
    installProject(fresh);
    library.setCurrent(entry.id);
    library.markOpened(entry.id);
    selectedSongId = entry.id;
    historySelection = null;
    return entry;
}

/** The project of any song: the live one for the open song, its file for the others. */
function projectOfSong(id: string): DAWProject {
    if (id === library.currentSongId) {
        flushPendingSave();
        return project;
    }
    return library.loadSong(id).project;
}

function duplicateSong(id: string) {
    const copy = library.duplicate(id, projectOfSong(id));
    selectedSongId = copy.id;
    toast(`Made a copy called "${copy.name}".`, { label: "Open it", run: () => libraryAction("open the copy", () => openSong(copy.id)) });
}

function renameSong(id: string, name: string) {
    const before = library.find(id)?.name;
    const used = library.rename(id, name);
    if (before !== used) toast(used === cleanName(name) ? `Renamed to "${used}".` : `Renamed to "${used}" (that name was taken).`);
}

/** Moves a song to Recently deleted. Deleting the open song opens the most recent other one, or a
 * new blank song if it was the last. */
function deleteSong(id: string) {
    const entry = library.find(id);
    if (!entry) return;
    const wasOpen = id === library.currentSongId;
    if (wasOpen) versionSongBeingLeft();
    library.trash(id);
    if (wasOpen) {
        const next = sortSongs(library.activeSongs(), "recent")[0];
        if (next) openSong(next.id);
        else createSongFromTemplate(SONG_TEMPLATES[0]);
    }
    if (selectedSongId === id) selectedSongId = library.currentSongId;
    toast(`Moved "${entry.name}" to Recently deleted.`, {
        label: "Undo",
        run: () => libraryAction("undo the delete", () => {
            library.restoreFromTrash(id);
            if (wasOpen) openSong(id);
            selectedSongId = id;
            toast(`Brought back "${entry.name}".`);
        })
    });
}

function restoreSongFromTrash(id: string) {
    const entry = library.restoreFromTrash(id);
    selectedSongId = id;
    trashSelection = null;
    toast(`Brought back "${entry.name}".`, { label: "Open it", run: () => libraryAction("open the song", () => openSong(id)) });
}

/** Ctrl+S, and the "Save version" button with no name: a version now, unless nothing changed. */
function saveVersionNow(label?: string) {
    const id = library.currentSongId;
    if (!id) return;
    flushPendingSave();
    const name = label ? cleanName(label) : "";
    const kept = library.addVersion(id, project, name ? "named" : "auto", name || undefined);
    library.flushIndex();
    if (kept) {
        historySelection = kept.id;
        toast(name ? `Saved version "${name}".` : `Saved. A version from ${formatClock(kept.at)} is in History.`);
    } else {
        toast("Saved. Nothing changed since the last version.");
    }
}

function restoreVersion(versionId: string, keepBefore = true) {
    const id = library.currentSongId;
    if (!id) return;
    const target = library.versions(id).find(v => v.id === versionId);
    if (!target) throw new Error("that version no longer exists");
    flushPendingSave();
    const restored = repairProject(library.loadVersion(id, versionId));
    // The song as it is now becomes a version first, so the restore can be undone.
    const before = keepBefore
        ? library.addVersion(id, project, "before-restore", `Before restoring ${formatClock(target.at)}`) ?? library.versions(id)[0]
        : null;
    installProject(restored);
    writeProject();
    library.markOpened(id);
    library.flushIndex();
    historySelection = versionId;
    const when = dayHeading(target.at, Date.now()) === "Today" ? formatClock(target.at) : `${formatDate(target.at)} ${formatClock(target.at)}`;
    toast(`Restored the version from ${when}.`,
        before ? { label: "Undo", run: () => libraryAction("undo the restore", () => { restoreVersion(before.id, false); toast("Undid the restore."); }) } : undefined);
}

function openVersionAsSong(versionId: string) {
    const id = library.currentSongId;
    if (!id) return;
    const v = library.versions(id).find(x => x.id === versionId);
    if (!v) throw new Error("that version no longer exists");
    const source = library.loadVersion(id, versionId);
    const name = `${currentSongName()} (${v.kind === "named" && v.label ? v.label : formatClock(v.at)})`;
    const entry = createSongFromTemplate({ id: "version", label: "", songName: name, make: () => copyJson(source) });
    toast(`Opened that version as a new song, "${entry.name}". The original is unchanged.`);
}

/**
 * Startup: open the library and the song that was open last. The first run after this feature
 * arrived moves the old single DAW.json (if there is one) into the library as the first song - it is
 * left where it was, untouched, as a fallback. A first run with nothing saved starts the demo song.
 */
function openLibraryAtStartup() {
    try {
        library.init();
    } catch (e) {
        // The store is there but unusable (no data folder, a permissions problem): keep working in memory.
        libraryPersistent = false;
        Entropy.println(`DAW: the song library cannot be stored (${errorText(e)}); only the open song is saved, as DAW.json.`);
        library = new SongLibrary<DAWProject>(memoryStore(), { now: () => Date.now(), uuid: newId });
        library.init();
    }

    const tryOpen = (id: string): boolean => {
        try {
            const { project: loaded, note } = library.loadSong(id);
            installProject(repairProject(loaded), false);
            library.setCurrent(id);
            library.addVersion(id, project, "opened");
            if (note) toast(note);
            return true;
        } catch (e) {
            toast(`Could not open "${library.find(id)?.name ?? "the last song"}": ${errorText(e)}`);
            return false;
        }
    };

    const last = library.currentSongId;
    if (last && tryOpen(last)) return;
    const recent = sortSongs(library.activeSongs(), "recent").find(s => s.id !== last);
    if (recent && tryOpen(recent.id)) return;

    // Nothing in the library yet: bring in the old single-file save, or start with the demo.
    let legacy: any = null;
    try { legacy = addon.IO.load(); } catch (e) { Entropy.println("DAW: could not read the old DAW.json: " + e); }
    try {
        if (legacy && Array.isArray(legacy.tracks) && legacy.tracks.length > 0) {
            const imported = repairProject(legacy);
            const entry = library.createSong("My song", imported);
            installProject(imported, false);
            library.setCurrent(entry.id);
            library.addVersion(entry.id, project, "imported", "Imported from the previous DAW save");
            if (libraryPersistent) toast(`Your song is now "My song" in the song library. Rename it any time from Songs.`);
            return;
        }
    } catch (e) {
        Entropy.println("DAW: the old DAW.json could not be imported: " + errorText(e));
    }
    const demo = makeStarterProject();
    const entry = library.createSong("Demo song", demo);
    installProject(demo, false);
    library.setCurrent(entry.id);
    library.addVersion(entry.id, project, "opened");
}

/** Once a frame: the debounced save, the index, and the automatic version every 10 minutes. */
let indexFlushAt = 0;
function tickLibrary() {
    flushSaveIfDue();
    const id = library.currentSongId;
    const now = Date.now();
    try {
        if (id && library.autoVersionDue(id)) library.addVersion(id, project, "auto");
        if (now >= indexFlushAt) {
            indexFlushAt = now + 2000;
            library.flushIndex();
        }
    } catch (e) {
        saveState.error = errorText(e);
    }
    if (libraryToast && now - libraryToast.at > TOAST_MS) libraryToast = null;
}

// --- Song library UI state ---
let songsVisible = false;
let historyVisible = false;
let songsWindowId: string | null = null;
let historyWindowId: string | null = null;
let selectedSongId: string | null = null;
let trashSelection: string | null = null;
let songQuery = "";
let songSort: SortMode = "recent";
const SORT_MODES: SortMode[] = ["recent", "name", "created"];
const SORT_LABELS = ["Last edited", "Name", "Date created"];
let newSongTemplate = 0;
let renaming: { id: string; draft: string } | null = null;
// Two-step confirmation for what cannot be undone: the id of the thing armed, and when.
let confirmArmed: { key: string; at: number } | null = null;
let historySelection: string | null = null;
let versionNameDraft = "";
const collapsedDays = new Set<string>();
// The compared-with-now lines for the selected version, cached so a frame does not re-read the file.
let comparison: { songId: string; versionId: string; savedAt: number; lines: string[]; error?: string } | null = null;

function armed(key: string): boolean {
    return !!confirmArmed && confirmArmed.key === key && Date.now() - confirmArmed.at < 5000;
}
/** First click arms, second click (within 5 s) runs. */
function confirmThen(key: string, run: () => void) {
    if (armed(key)) { confirmArmed = null; run(); }
    else confirmArmed = { key, at: Date.now() };
}

function setSongsVisible(v: boolean) {
    songsVisible = v;
    if (v) selectedSongId = selectedSongId ?? library.currentSongId;
    if (songsWindowId) Entropy.UI.setWindowVisible(songsWindowId, v);
}
function setHistoryVisible(v: boolean) {
    historyVisible = v;
    if (v) comparison = null;
    if (historyWindowId) Entropy.UI.setWindowVisible(historyWindowId, v);
}

function saveStatusText(): string {
    if (saveState.error) return withIcon("warning-circle", `Not saved: ${saveState.error}`);
    if (saveDueAt) return "Saving...";
    if (!libraryPersistent) return "Song library unavailable: only this song is kept";
    return withIcon("check-circle", saveState.at ? `Saved ${timeAgo(saveState.at, Date.now())}` : "All changes saved");
}

// The song bar: which song is open, whether it is saved, and the way into Songs and History.
function renderSongBar(win: string) {
    const W = Entropy.UI.Widget;
    W.horizontal(win, (row: string) => {
        W.label(row, { text: withIcon("music-notes", currentSongName()), bold: true });
        W.label(row, { text: saveStatusText() });
        W.button(row, { text: withIcon("folder-open", songsVisible ? "Hide Songs" : "Songs"), id: "songs_toggle", onClick: () => { setSongsVisible(!songsVisible); } });
        W.button(row, { text: withIcon("clock-counter-clockwise", historyVisible ? "Hide History" : "History"), id: "history_toggle", onClick: () => { setHistoryVisible(!historyVisible); } });
        W.button(row, { text: withIcon("floppy-disk", "Save version"), id: "song_save_version", onClick: () => { libraryAction("save a version", () => saveVersionNow()); } });
    });
    renderToast(win);
}

function renderToast(win: string) {
    const t = libraryToast;
    if (!t) return;
    const W = Entropy.UI.Widget;
    W.horizontal(win, (row: string) => {
        W.label(row, { text: t.text });
        if (t.undo) {
            const undo = t.undo;
            W.button(row, { text: withIcon("arrow-u-up-left", undo.label), id: "library_toast_action", onClick: () => { libraryToast = null; undo.run(); } });
        }
        W.button(row, { text: "Dismiss", id: "library_toast_dismiss", onClick: () => { libraryToast = null; } });
    });
}

function songDetail(s: SongEntry, now: number): string {
    return `${Math.round(s.bpm)} BPM · ${s.tracks} tracks · ${timeAgo(s.updatedAt, now)}`;
}

function renderSongsWindow(win: string) {
    const W = Entropy.UI.Widget;
    const now = Date.now();

    W.horizontal(win, (row: string) => {
        W.dropdown(row, {
            label: "New song from", id: "new_song_template", options: SONG_TEMPLATES.map(t => t.label),
            selectedIndex: newSongTemplate,
            onChange: (idx: string) => { newSongTemplate = parseInt(idx, 10) || 0; }
        });
        W.button(row, {
            text: withIcon("file-plus", "Create"), id: "new_song_create",
            onClick: () => libraryAction("create a song", () => {
                const entry = createSongFromTemplate(SONG_TEMPLATES[newSongTemplate] ?? SONG_TEMPLATES[0]);
                renaming = { id: entry.id, draft: entry.name };
                toast(`Created "${entry.name}". Give it a name, or just start making music.`);
            })
        });
    });
    renderToast(win);
    W.separator(win);

    W.horizontal(win, (row: string) => {
        W.textInput(row, { label: "Search", id: "song_search", value: songQuery, width: 180, onChange: (v: string) => { songQuery = v; } });
        W.dropdown(row, {
            label: "Sort", id: "song_sort", options: SORT_LABELS, selectedIndex: SORT_MODES.indexOf(songSort),
            onChange: (idx: string) => { songSort = SORT_MODES[parseInt(idx, 10)] ?? "recent"; }
        });
    });

    const all = library.activeSongs();
    const shown = sortSongs(filterSongs(all, songQuery), songSort);
    if (!shown.length) {
        W.label(win, { text: all.length ? `No song name contains "${songQuery.trim()}".` : "No songs yet. Create one above." });
    } else {
        W.treeView(win, {
            id: "song_list",
            maxHeight: 300,
            nodes: shown.map(s => ({
                id: s.id, depth: 0,
                label: s.id === library.currentSongId ? `${s.name}  (open)` : s.name,
                icon: s.id === library.currentSongId ? icon("music-notes") : icon("music-note"),
                detail: songDetail(s, now),
                selected: s.id === selectedSongId,
            })),
            onSelect: (id: string) => { selectedSongId = id; if (renaming && renaming.id !== id) renaming = null; }
        });
        W.label(win, { text: songQuery.trim() ? `${shown.length} of ${all.length} songs` : `${all.length} song${all.length === 1 ? "" : "s"}` });
    }

    const sel = library.find(selectedSongId);
    if (sel && sel.deletedAt === undefined) {
        W.separator(win);
        const isOpen = sel.id === library.currentSongId;
        W.group(win, (g: string) => {
            if (renaming && renaming.id === sel.id) {
                const r = renaming;
                W.horizontal(g, (row: string) => {
                    W.textInput(row, { label: "Name", id: "song_rename_input", value: r.draft, width: 240, onChange: (v: string) => { r.draft = v; } });
                    W.button(row, {
                        text: "Save name", id: "song_rename_save",
                        onClick: () => libraryAction("rename the song", () => { renameSong(sel.id, r.draft); renaming = null; })
                    });
                    W.button(row, { text: "Cancel", id: "song_rename_cancel", onClick: () => { renaming = null; } });
                });
            } else {
                W.label(g, { text: isOpen ? `${sel.name} - open now` : sel.name, bold: true });
            }
            W.label(g, { text: describeStats(sel) });
            const versions = library.versions(sel.id).length;
            W.label(g, { text: `Created ${formatDate(sel.createdAt)} · edited ${timeAgo(sel.updatedAt, now)} · ${versions} version${versions === 1 ? "" : "s"}` });
            W.horizontal(g, (row: string) => {
                if (!isOpen) W.button(row, { text: withIcon("folder-open", "Open"), id: "song_open", onClick: () => libraryAction("open the song", () => openSong(sel.id)) });
                W.button(row, { text: withIcon("pencil-simple", "Rename"), id: "song_rename", onClick: () => { renaming = { id: sel.id, draft: sel.name }; } });
                W.button(row, { text: withIcon("copy", "Duplicate"), id: "song_duplicate", onClick: () => libraryAction("duplicate the song", () => duplicateSong(sel.id)) });
                W.button(row, { text: withIcon("trash", "Delete"), id: "song_delete", onClick: () => libraryAction("delete the song", () => deleteSong(sel.id)) });
            });
        });
    }

    const trashed = library.trashedSongs();
    if (trashed.length) {
        W.separator(win);
        W.collapsingHeader(win, withIcon("trash", `Recently deleted (${trashed.length})`), (tid: string) => {
            W.label(tid, { text: `Deleted songs are kept for ${Math.round(TRASH_RETENTION_MS / 86_400_000)} days, then removed for good.` });
            W.treeView(tid, {
                id: "trash_list",
                maxHeight: 160,
                nodes: trashed.map(s => ({
                    id: s.id, depth: 0, label: s.name, icon: icon("music-note"),
                    detail: `deleted ${timeAgo(s.deletedAt!, now)}`, selected: s.id === trashSelection,
                })),
                onSelect: (id: string) => { trashSelection = id; }
            });
            const t = library.find(trashSelection);
            W.horizontal(tid, (row: string) => {
                if (t && t.deletedAt !== undefined) {
                    W.button(row, { text: withIcon("arrow-counter-clockwise", "Restore"), id: "trash_restore", onClick: () => libraryAction("restore the song", () => restoreSongFromTrash(t.id)) });
                    W.button(row, {
                        text: armed("forever:" + t.id) ? "Click again to delete forever" : "Delete forever", id: "trash_delete_forever",
                        onClick: () => confirmThen("forever:" + t.id, () => libraryAction("delete the song", () => {
                            library.deleteForever(t.id);
                            trashSelection = null;
                            toast(`Deleted "${t.name}" for good.`);
                        }))
                    });
                }
                W.button(row, {
                    text: armed("empty-trash") ? "Click again to empty" : "Empty Recently deleted", id: "trash_empty",
                    onClick: () => confirmThen("empty-trash", () => libraryAction("empty Recently deleted", () => {
                        const n = library.trashedSongs().length;
                        for (const s of library.trashedSongs()) library.deleteForever(s.id);
                        trashSelection = null;
                        toast(`Deleted ${n} song${n === 1 ? "" : "s"} for good.`);
                    }))
                });
            });
        }, "songs_trash", false);
    }

    W.separator(win);
    W.label(win, {
        text: libraryPersistent
            ? "Songs save automatically as you work. Ctrl+S keeps a version; Ctrl+O shows this list."
            : "This app has no data folder for a song library: other songs last only until it closes, and only the open song is kept."
    });
}

function versionIcon(v: VersionEntry): string {
    switch (v.kind) {
        case "named": return icon("bookmark-simple");
        case "before-restore": return icon("arrow-counter-clockwise");
        case "opened": return icon("folder-open");
        default: return icon("clock-counter-clockwise");
    }
}

function renderHistoryWindow(win: string) {
    const W = Entropy.UI.Widget;
    const songId = library.currentSongId;
    if (!songId) { W.label(win, { text: "No song is open." }); return; }
    const now = Date.now();

    W.label(win, { text: withIcon("clock-counter-clockwise", `Versions of ${currentSongName()}`), bold: true });
    W.horizontal(win, (row: string) => {
        W.textInput(row, { label: "Name", id: "version_name", value: versionNameDraft, width: 200, onChange: (v: string) => { versionNameDraft = v; } });
        W.button(row, {
            text: withIcon("bookmark-simple", cleanName(versionNameDraft) ? "Save named version" : "Save version"), id: "version_save",
            onClick: () => libraryAction("save a version", () => { saveVersionNow(versionNameDraft); versionNameDraft = ""; })
        });
    });
    renderToast(win);

    const versions = library.versions(songId);
    if (!versions.length) {
        W.label(win, { text: "No versions yet. One is kept every 10 minutes while you work, or save one now." });
    } else {
        // Grouped by day, newest first; a day's group can be folded away.
        const nodes: any[] = [];
        let day = "";
        for (const v of versions) {
            const heading = dayHeading(v.at, now);
            if (heading !== day) {
                day = heading;
                const count = versions.filter(x => dayHeading(x.at, now) === heading).length;
                nodes.push({ id: "day:" + heading, depth: 0, label: heading, hasChildren: true, expanded: !collapsedDays.has(heading), detail: `${count}` });
            }
            if (collapsedDays.has(heading)) continue;
            nodes.push({
                id: v.id, depth: 1, icon: versionIcon(v),
                label: `${formatClock(v.at)}  ${versionTitle(v)}`,
                detail: `${v.tracks} tracks · ${Math.round(v.bpm)} BPM`,
                selected: v.id === historySelection,
            });
        }
        const toggleDay = (id: string) => {
            const heading = id.slice(4);
            if (collapsedDays.has(heading)) collapsedDays.delete(heading); else collapsedDays.add(heading);
        };
        W.treeView(win, {
            id: "version_list", maxHeight: 280, nodes,
            onSelect: (id: string) => { if (id.startsWith("day:")) toggleDay(id); else historySelection = id; },
            onToggleExpand: toggleDay,
        });
    }

    const sel = versions.find(v => v.id === historySelection);
    if (sel) {
        W.separator(win);
        W.group(win, (g: string) => {
            W.label(g, { text: `${versionTitle(sel)} - ${dayHeading(sel.at, now)} at ${formatClock(sel.at)}`, bold: true });
            W.label(g, { text: `${describeStats(sel)} · ${Math.max(1, Math.round(sel.size / 1024))} KB` });
            // Recomputed when the selection changes or the song is saved again (it was edited).
            if (!comparison || comparison.songId !== songId || comparison.versionId !== sel.id || comparison.savedAt !== saveState.at) {
                const key = { songId, versionId: sel.id, savedAt: saveState.at };
                try { comparison = { ...key, lines: describeChanges(project, library.loadVersion(songId, sel.id)) }; }
                catch (e) { comparison = { ...key, lines: [], error: errorText(e) }; }
            }
            if (comparison.error) W.label(g, { text: withIcon("warning-circle", comparison.error) });
            else {
                W.label(g, { text: "Restoring it would change:" });
                comparison.lines.forEach(line => W.label(g, { text: "  " + line }));
            }
            W.horizontal(g, (row: string) => {
                if (!comparison?.error) {
                    W.button(row, { text: withIcon("arrow-counter-clockwise", "Restore this version"), id: "version_restore", onClick: () => libraryAction("restore the version", () => { restoreVersion(sel.id); comparison = null; }) });
                    W.button(row, { text: withIcon("copy", "Open as new song"), id: "version_open_copy", onClick: () => libraryAction("open the version", () => openVersionAsSong(sel.id)) });
                }
                W.button(row, {
                    text: withIcon("bookmark-simple", sel.kind === "named" ? "Rename" : "Keep and name"), id: "version_name_toggle",
                    onClick: () => { versionRename = { id: sel.id, draft: sel.kind === "named" ? sel.label ?? "" : "" }; }
                });
                W.button(row, {
                    text: armed("version:" + sel.id) ? "Click again to delete" : withIcon("trash", "Delete"), id: "version_delete",
                    onClick: () => confirmThen("version:" + sel.id, () => libraryAction("delete the version", () => { library.deleteVersion(songId, sel.id); historySelection = null; toast("Deleted that version."); }))
                });
            });
            if (versionRename && versionRename.id === sel.id) {
                const r = versionRename;
                W.horizontal(g, (row: string) => {
                    W.textInput(row, { label: "Version name", id: "version_rename_input", value: r.draft, width: 200, onChange: (v: string) => { r.draft = v; } });
                    W.button(row, {
                        text: "Save", id: "version_rename_save",
                        onClick: () => libraryAction("name the version", () => { library.nameVersion(songId, sel.id, r.draft); versionRename = null; })
                    });
                    W.button(row, { text: "Cancel", id: "version_rename_cancel", onClick: () => { versionRename = null; } });
                });
            }
        });
    }

    W.separator(win);
    const next = library.nextAutoVersionIn(songId);
    W.label(win, { text: next === null ? "No changes since the last version." : `Next automatic version in ${Math.max(1, Math.ceil(next / 60_000))} min.` });
    W.label(win, { text: "Automatic versions thin out as they age: all from the last hour, one an hour for a day, one a day for a month, then one a week. Named versions are kept until you delete them." });
}
let versionRename: { id: string; draft: string } | null = null;

const WAVEFORMS = ["sine", "square", "saw", "triangle", "noise", WT_WAVEFORM];
const SCALE_NAMES = Object.keys(SCALES);
const SNAP_MODES: SnapMode[] = ["bar", "beat", "step"];
const SNAP_LABELS = ["Bar", "Beat", "Step"];
const TRANSPORT_MODES: TransportMode[] = ["song", "pattern"];

// What the BPM box shows. It is a draft rather than a mirror of project.bpm: typing "1" on the
// way to "140" must not be clamped to 20 under the user's fingers, so the box keeps what was
// typed and only follows project.bpm when something other than typing changed it.
let bpmDraft = String(project.bpm);
let bpmDraftFor = project.bpm;

function syncBpmDraft() {
    if (bpmDraftFor !== project.bpm) {
        bpmDraft = String(project.bpm);
        bpmDraftFor = project.bpm;
    }
}

function commitBpmText(text: string) {
    bpmDraft = text;
    const value = parseFloat(text);
    if (Number.isFinite(value) && value >= BPM_MIN && value <= BPM_MAX) {
        setBpm(value);
        bpmDraftFor = project.bpm;
        persist();
    }
}

function nudgeBpm(delta: number) {
    setBpm(project.bpm + delta);
    persist();
}

function positionReadout(): string {
    const step = currentStepFloat();
    const total = transportLength();
    const wrapped = transport.playing ? ((step % total) + total) % total : step;
    const spb = project.stepsPerBeat;
    const bar = Math.floor(wrapped / barSteps(spb)) + 1;
    const beat = Math.floor((wrapped % barSteps(spb)) / spb) + 1;
    const seconds = wrapped * stepDuration();
    const mm = Math.floor(seconds / 60);
    const ss = (seconds % 60).toFixed(1).padStart(4, "0");
    return `Bar ${bar}  Beat ${beat}   ${mm}:${ss}`;
}

addon.onInit(async () => {
    Entropy.println("DAW Addon Initializing...");

    // need new hook
    // addon.onProjectChanged((_newProjectId: string) => {
    //     const saved = addon.IO.load();
    //     if (saved && saved.tracks) {
    //         project = saved as DAWProject;
    //     }
    // });

    // Opens the song that was open last (see openLibraryAtStartup).
    openLibraryAtStartup();
    bpmDraft = String(project.bpm);
    bpmDraftFor = project.bpm;

    // Create the starter tracks' persistent mixing buses (and their effect instances) up front,
    // rather than waiting for the first user interaction to call persist().
    project.tracks.forEach(syncTrackBus);
    verifyRacks();

    // Reload each track's plugin with the patch it was saved on. A plugin that fails to load keeps
    // its slot on the track (see loadTrackInstrument), so the failure is visible instead of silent.
    project.tracks.forEach(t => { if (t.instrument) loadTrackInstrument(t, t.instrument); });

    const renderInstrumentPanel = (tabId: string, track: Track) => {
        Entropy.UI.Widget.collapsingHeader(tabId, withIcon("plug", `${track.name} - Instrument (VST3)`), (tid: string) => {
            const runtime = vst3Runtime[track.id];

            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                Entropy.UI.Widget.button(tid2, {
                    text: vst3Catalog.length === 0 ? "Find VST3 plugins" : "Rescan",
                    id: "vst3_scan",
                    onClick: () => { scanVst3Plugins(vst3Catalog.length > 0); }
                });
                Entropy.UI.Widget.label(tid2, { text: vst3ScanStatus });
            });

            if (vst3Catalog.length > 0) {
                Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                    Entropy.UI.Widget.button(tid2, {
                        text: radio(!track.instrument) + "Built-in",
                        id: "vst3_use_builtin",
                        onClick: () => { clearTrackInstrument(track); persist(); }
                    });
                    vst3Catalog.forEach(plugin => {
                        Entropy.UI.Widget.button(tid2, {
                            text: radio(track.instrument?.path === plugin.path) + plugin.name,
                            id: "vst3_use_" + vst3Slug(plugin.name),
                            onClick: () => {
                                loadTrackInstrument(track, { path: plugin.path, name: plugin.name });
                                persist();
                            }
                        });
                    });
                });
            }

            if (track.instrument) {
                Entropy.UI.Widget.label(tid, { text: runtime?.status ?? "Not loaded", bold: true });
                if (runtime?.ok) {
                    const db = runtime.peak > 0.00001 ? (20 * Math.log10(runtime.peak)).toFixed(1) + " dB" : "silent";
                    Entropy.UI.Widget.label(tid, { text: `Output level: ${db}` });
                    Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                        Entropy.UI.Widget.button(tid2, {
                            text: "Open Editor",
                            id: "vst3_open_editor",
                            onClick: () => {
                                const r = addon.Vst3.openEditor(track.id);
                                if (!r.ok) vst3Runtime[track.id].status = `Editor: ${r.error}`;
                            }
                        });
                        Entropy.UI.Widget.button(tid2, {
                            text: "Close Editor",
                            id: "vst3_close_editor",
                            onClick: () => { addon.Vst3.closeEditor(track.id); }
                        });
                        Entropy.UI.Widget.button(tid2, {
                            text: "All Notes Off",
                            id: "vst3_all_notes_off",
                            onClick: () => { addon.Vst3.allNotesOff(track.id); }
                        });
                    });
                }
            }
        }, "instrument_panel", true);
    };

    // The transport bar: everything you reach for while the song is running, in one row.
    const renderTransportBar = (tabId: string) => {
        syncBpmDraft();
        Entropy.UI.Widget.group(tabId, (tid: string) => {
            renderSongBar(tid);
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                Entropy.UI.Widget.button(tid2, {
                    text: transport.playing ? withIcon("stop", "Stop") : withIcon("play", "Play"),
                    id: "transport_toggle",
                    onClick: () => { transport.playing ? stop() : play(); }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: withIcon("skip-back", "Rewind"),
                    id: "transport_rewind",
                    onClick: () => { rewind(); }
                });
                Entropy.UI.Widget.textInput(tid2, {
                    label: "BPM",
                    id: "bpm_input",
                    value: bpmDraft,
                    width: 64,
                    onChange: (v: string) => { commitBpmText(v); }
                });
                Entropy.UI.Widget.button(tid2, { text: "-", id: "bpm_down", onClick: () => { nudgeBpm(-1); } });
                Entropy.UI.Widget.button(tid2, { text: "+", id: "bpm_up", onClick: () => { nudgeBpm(1); } });
                Entropy.UI.Widget.label(tid2, { text: positionReadout(), bold: true });
                Entropy.UI.Widget.dropdown(tid2, {
                    label: "Play",
                    id: "transport_mode",
                    options: ["Song", "Pattern loop"],
                    selectedIndex: TRANSPORT_MODES.indexOf(transport.mode),
                    onChange: (idx: string) => {
                        const wasPlaying = transport.playing;
                        if (wasPlaying) stop();
                        transport.mode = TRANSPORT_MODES[parseInt(idx, 10)] ?? "song";
                        transport.cursorStep = 0;
                        if (wasPlaying) play();
                    }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: withIcon("download-simple", "Export Song to WAV"),
                    id: "export_wav",
                    onClick: () => { exportPatternToWav(); }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: rackVisible ? "Hide Drum Rack" : "Show Drum Rack",
                    id: "toggle_rack",
                    onClick: () => { setRackVisible(!rackVisible); }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: wavetableVisible ? "Hide Wavetable" : withIcon("wave-sawtooth", "Wavetable"),
                    id: "toggle_wavetable",
                    onClick: () => { setWavetableVisible(!wavetableVisible); }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: physModVisible ? "Hide Bowed String" : withIcon("music-notes", "Bowed String"),
                    id: "toggle_physmod",
                    onClick: () => { setPhysModVisible(!physModVisible); }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: brassVisible ? "Hide Brass" : withIcon("megaphone", "Brass"),
                    id: "toggle_brass",
                    onClick: () => { setBrassVisible(!brassVisible); }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: matterVisible ? "Hide Kit" : withIcon("disc", "Kit"),
                    id: "toggle_matter",
                    onClick: () => { setMatterVisible(!matterVisible); }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: guitarStatus.running ? withIcon("guitar", "Guitar (on)") : (guitarVisible ? "Hide Guitar Input" : withIcon("guitar", "Guitar Input")),
                    id: "toggle_guitar",
                    onClick: () => { setGuitarVisible(!guitarVisible); }
                });
            });
            const bpmValue = parseFloat(bpmDraft);
            if (!(bpmValue >= BPM_MIN && bpmValue <= BPM_MAX)) {
                Entropy.UI.Widget.label(tid, { text: `BPM must be between ${BPM_MIN} and ${BPM_MAX}.` });
            }
            if (lastExportStatus) {
                Entropy.UI.Widget.label(tid, { text: lastExportStatus });
            }
        });
    };

    const arrangementTracks = () => laneTracks(project.tracks).map((track, channel) => {
        if (!track) {
            return { id: `empty:${channel}`, label: `Channel ${channel + 1}`, placeholder: true, clips: [] };
        }
        const patternById = new Map(track.patterns.map(p => [p.id, p]));
        return {
            id: track.id,
            label: track.name,
            sublabel: instrumentSummary(track),
            color: trackRgba(track),
            muted: track.muted,
            solo: track.solo,
            controls: true,
            clips: clipsOfTrack(project.arrangement, track.id).map(c => {
                const pattern = patternById.get(c.patternId) ?? track.patterns[0];
                return {
                    id: c.id,
                    label: pattern.name,
                    startMs: stepToMs(c.startStep, project.bpm, project.stepsPerBeat),
                    durationMs: Math.max(1, stepToMs(c.lengthSteps, project.bpm, project.stepsPerBeat)),
                    color: trackRgba(track),
                    loopMs: Math.max(1, stepToMs(pattern.steps, project.bpm, project.stepsPerBeat)),
                    notes: miniNotes(track, pattern, c.offsetSteps ?? 0)
                };
            })
        };
    });

    const renderArrangement = (tabId: string) => {
        Entropy.UI.Widget.collapsingHeader(tabId, withIcon("rows", "Arrangement"), (tid: string) => {
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                Entropy.UI.Widget.dropdown(tid2, {
                    label: "Snap",
                    id: "arr_snap",
                    options: SNAP_LABELS,
                    selectedIndex: Math.max(0, SNAP_MODES.indexOf(project.snap)),
                    onChange: (idx: string) => { setSnap(SNAP_MODES[parseInt(idx, 10)] ?? "bar"); }
                });
                Entropy.UI.Widget.numericInput(tid2, {
                    label: "Song bars",
                    id: "arr_bars",
                    value: project.songBars,
                    onChange: (v: string) => { setSongBars(parseFloat(v) || project.songBars); }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: "+ Synth Track",
                    id: "add_synth_track",
                    onClick: () => { addTrack("synth"); persist(); }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: "+ Drum Track",
                    id: "add_drum_track",
                    onClick: () => { addTrack("drum"); persist(); }
                });
            });

            const bar = barSteps(project.stepsPerBeat);
            const sm = stepMs(project.bpm, project.stepsPerBeat);
            const selected = selectedClip();
            Entropy.UI.Widget.tracks(tid, {
                id: "arrangement",
                durationMs: stepToMs(songSteps(project), project.bpm, project.stepsPerBeat),
                playheadMs: Math.round(currentStepFloat() % Math.max(1, songSteps(project)) * sm),
                tracks: arrangementTracks(),
                selected: selected ? { track: selected.trackId, clip: selected.id } : undefined,
                options: {
                    laneHeight: 34,
                    labelWidth: 176,
                    snapMs: Math.max(1, Math.round(snapUnitSteps(project.snap, project.stepsPerBeat) * sm)),
                    barMs: Math.max(1, Math.round(bar * sm)),
                    beatMs: Math.max(1, Math.round(project.stepsPerBeat * sm)),
                    fitOnOpen: true,
                    zoomNeedsCtrl: true,
                    allowDraw: true,
                    laneNumbers: true,
                    activeTrack: project.activeTrackId ?? undefined,
                    followPlayhead: transport.playing,
                    rightGutter: 16
                },
                onSeek: onArrangementSeek,
                onClipSelected: onArrangementClipSelected,
                onClipMoved: onArrangementClipMoved,
                onClipResized: onArrangementClipResized,
                onClipDelete: onArrangementClipDelete,
                onClipDuplicate: onArrangementClipDuplicate,
                onClipCreate: onArrangementClipCreate,
                onTrackClicked: onArrangementTrackClicked,
                onTrackMute: onArrangementTrackMute,
                onTrackSolo: onArrangementTrackSolo,
                onBackgroundClicked: onArrangementBackground
            });

            const t = selected ? findTrack(selected.trackId) : undefined;
            const pat = t?.patterns.find(p => p.id === selected?.patternId);
            const hint = selected && t && pat
                ? `${t.name} - ${pat.name}: bar ${Math.floor(selected.startStep / bar) + 1} for ${(selected.lengthSteps / bar).toFixed(selected.lengthSteps % bar === 0 ? 0 : 2)} bar(s)`
                : "Drag on an empty lane to draw a clip. Drag a clip to move it, drag its edges to resize, right-click for Duplicate or Delete. Hold Alt to skip snapping, Ctrl+wheel to zoom.";
            Entropy.UI.Widget.label(tid, { text: arrangementStatus || hint });
        }, "arrangement_panel", true);
    };

    // Oscilloscope, spectrum, goniometer and a level meter over one source: the whole mix or a
    // single track. All four read the audio engine's analysis taps Rust-side when they are drawn;
    // no samples come through JS. Only `Audio.analyze` (the readout line) does, as a handful of numbers.
    const analyzerReadout = (): string => {
        const a = addon.Audio.analyze(analyzer.source, analyzer.fftSize);
        if (!a) return "No such source.";
        const peak = Math.max(a.peakL, a.peakR);
        if (peak < -90) return "Silent.";
        const rms = Math.max(a.rmsL, a.rmsR);
        const note = a.peakHz > 0 ? ` (${midiToName(Math.round(69 + 12 * Math.log2(a.peakHz / 440)))})` : "";
        const hz = a.peakHz >= 1000 ? `${(a.peakHz / 1000).toFixed(2)} kHz` : `${a.peakHz.toFixed(1)} Hz`;
        return `Peak ${peak.toFixed(1)} dBFS   RMS ${rms.toFixed(1)} dBFS   Strongest ${hz}${note}   Brightness ${Math.round(a.centroidHz)} Hz`;
    };

    // A floating window rather than a section of the tab: the arrangement is 16 lanes tall, so a
    // section under it is off screen exactly when you want to glance at a level, and one above it
    // pushes the thing you are editing down the page. A window can be dragged out of the way.
    const renderAnalyzer = (win: string) => {
        const sources = ["master", ...project.tracks.map(t => t.id)];
        if (!sources.includes(analyzer.source)) analyzer.source = "master";
        const sourceTrack = findTrack(analyzer.source);
        const color = sourceTrack ? trackRgba(sourceTrack) : undefined;

        Entropy.UI.Widget.horizontal(win, (row: string) => {
            Entropy.UI.Widget.dropdown(row, {
                label: "Source",
                id: "analyzer_source",
                options: ["Master", ...project.tracks.map(t => t.name)],
                selectedIndex: Math.max(0, sources.indexOf(analyzer.source)),
                onChange: (idx: string) => { analyzer.source = sources[parseInt(idx, 10)] ?? "master"; }
            });
            Entropy.UI.Widget.dropdown(row, {
                label: "FFT",
                id: "analyzer_fft",
                options: FFT_SIZES.map(String),
                selectedIndex: Math.max(0, FFT_SIZES.indexOf(analyzer.fftSize)),
                onChange: (idx: string) => { analyzer.fftSize = FFT_SIZES[parseInt(idx, 10)] ?? 4096; }
            });
            Entropy.UI.Widget.dropdown(row, {
                label: "Style",
                id: "analyzer_style",
                options: ["Filled", "Bars"],
                selectedIndex: analyzer.style === "bars" ? 1 : 0,
                onChange: (idx: string) => { analyzer.style = idx === "1" ? "bars" : "filled"; }
            });
            Entropy.UI.Widget.dropdown(row, {
                label: "Scope",
                id: "analyzer_scope_mode",
                options: ["Stereo", "Mono", "XY"],
                selectedIndex: Math.max(0, SCOPE_MODES.indexOf(analyzer.scope)),
                onChange: (idx: string) => { analyzer.scope = SCOPE_MODES[parseInt(idx, 10)] ?? "stereo"; }
            });
            Entropy.UI.Widget.checkbox(row, {
                label: "Trigger",
                value: analyzer.trigger,
                onChange: (v: any) => { analyzer.trigger = v === true || v === "true"; }
            });
        });

        Entropy.UI.Widget.horizontal(win, (row: string) => {
            Entropy.UI.Widget.spectrum(row, {
                id: "analyzer_spectrum", source: analyzer.source, fftSize: analyzer.fftSize,
                style: analyzer.style, height: 200, width: 380, color
            });
            Entropy.UI.Widget.oscilloscope(row, {
                id: "analyzer_scope", source: analyzer.source, mode: analyzer.scope,
                trigger: analyzer.trigger, height: 200, width: 220, color,
                gain: analyzer.scope === "xy" ? 2 : 1
            });
            Entropy.UI.Widget.levelMeter(row, {
                id: "analyzer_meter", source: analyzer.source, width: 44, height: 200, showScale: true
            });
        });
        Entropy.UI.Widget.label(win, { text: analyzerReadout() });
    };

    const renderDAWUI = (tabId: string) => {
        renderTransportBar(tabId);
        renderArrangement(tabId);

        // Mixer: one channel-strip group per track, laid out side by side like a real mixing
        // console instead of a flat vertical list of rows.
        Entropy.UI.Widget.collapsingHeader(tabId, withIcon("sliders-horizontal", "Mixer"), (tid: string) => {
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                Entropy.UI.Widget.group(tid2, (tid3: string) => {
                    Entropy.UI.Widget.label(tid3, { text: "Master", bold: true });
                    Entropy.UI.Widget.levelMeter(tid3, { id: "meter_master", source: "master", width: 34, height: 84, showScale: true });
                });
                project.tracks.forEach(track => {
                    Entropy.UI.Widget.group(tid2, (tid3: string) => {
                        Entropy.UI.Widget.button(tid3, {
                            text: (track.id === project.activeTrackId ? icon("play") + " " : "") + track.name,
                            id: "select_track_" + project.tracks.indexOf(track),
                            onClick: () => { project.activeTrackId = track.id; }
                        });
                        Entropy.UI.Widget.levelMeter(tid3, { id: "meter_" + track.id, source: track.id, width: 34, height: 44 });
                        Entropy.UI.Widget.slider(tid3, {
                            label: "Gain",
                            value: track.gain, min: 0, max: 1,
                            onChange: (v: string) => { track.gain = parseFloat(v); persist(); }
                        });
                        Entropy.UI.Widget.horizontal(tid3, (tid4: string) => {
                            Entropy.UI.Widget.checkbox(tid4, {
                                label: "M",
                                value: track.muted,
                                onChange: (v: any) => { track.muted = v === true || v === "true"; persist(); }
                            });
                            Entropy.UI.Widget.checkbox(tid4, {
                                label: "S",
                                value: track.solo,
                                onChange: (v: any) => { track.solo = v === true || v === "true"; persist(); }
                            });
                        });
                        Entropy.UI.Widget.button(tid3, {
                            text: withIcon("trash", "Delete"),
                            onClick: () => {
                                removeTrack(track);
                                persist();
                            }
                        });
                    });
                });
            });
        }, "mixer_panel", true);

        const track = getActiveTrack();
        if (!track) {
            Entropy.UI.Widget.label(tabId, { text: "Add a track to begin." });
            return;
        }

        renderInstrumentPanel(tabId, track);

        Entropy.UI.Widget.collapsingHeader(tabId, withIcon("piano-keys", `${track.name} - Voice`), (tid: string) => {
            if (track.instrument) {
                Entropy.UI.Widget.label(tid, { text: `${track.instrument.name} is this track's instrument - the built-in oscillator and envelope are bypassed. Gain, mute, solo and Effects still apply.` });
                return;
            }
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                Entropy.UI.Widget.group(tid2, (tid3: string) => {
                    Entropy.UI.Widget.label(tid3, { text: "Oscillator", bold: true });

                    if (track.kind === "synth") {
                        const wfIndex = Math.max(0, WAVEFORMS.indexOf(track.voice.waveform));
                        Entropy.UI.Widget.dropdown(tid3, {
                            label: "Waveform",
                            options: WAVEFORMS,
                            selectedIndex: wfIndex,
                            onChange: (idx: string) => { track.voice.waveform = WAVEFORMS[parseInt(idx, 10)]; persist(); }
                        });

                        const scaleIndex = Math.max(0, SCALE_NAMES.indexOf(track.scale));
                        Entropy.UI.Widget.dropdown(tid3, {
                            label: "Scale",
                            options: SCALE_NAMES,
                            selectedIndex: scaleIndex,
                            onChange: (idx: string) => { track.scale = SCALE_NAMES[parseInt(idx, 10)]; persist(); }
                        });

                        Entropy.UI.Widget.numericInput(tid3, {
                            label: "Root Note (MIDI)",
                            value: track.rootNote,
                            onChange: (v: string) => { track.rootNote = parseFloat(v) || track.rootNote; persist(); }
                        });

                        Entropy.UI.Widget.numericInput(tid3, {
                            label: "Rows (octave span)",
                            value: track.rows,
                            onChange: (v: string) => { track.rows = Math.max(1, Math.round(parseFloat(v)) || track.rows); persist(); }
                        });
                    }

                    Entropy.UI.Widget.slider(tid3, {
                        label: track.kind === "drum" ? "Tone (filter)" : "Cutoff",
                        value: track.voice.cutoff, min: 100, max: 20000,
                        onChange: (v: string) => { track.voice.cutoff = parseFloat(v); persist(); }
                    });

                    Entropy.UI.Widget.slider(tid3, {
                        label: "Resonance",
                        value: track.voice.resonance, min: 0.1, max: 10,
                        onChange: (v: string) => { track.voice.resonance = parseFloat(v); persist(); }
                    });
                });

                Entropy.UI.Widget.group(tid2, (tid3: string) => {
                    Entropy.UI.Widget.label(tid3, { text: "Envelope", bold: true });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Attack",
                        value: track.voice.attack, min: 0, max: 1,
                        onChange: (v: string) => { track.voice.attack = parseFloat(v); persist(); }
                    });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Decay",
                        value: track.voice.decay, min: 0, max: 1,
                        onChange: (v: string) => { track.voice.decay = parseFloat(v); persist(); }
                    });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Sustain",
                        value: track.voice.sustain, min: 0, max: 1,
                        onChange: (v: string) => { track.voice.sustain = parseFloat(v); persist(); }
                    });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Release",
                        value: track.voice.release, min: 0, max: 2,
                        onChange: (v: string) => { track.voice.release = parseFloat(v); persist(); }
                    });
                });
            });
        });

        // FX: each track owns exactly one shared delay + reverb Entropy.AudioEffect instance
        // (see syncTrackBus) - these sliders edit that instance's live params, not a per-note
        // config anymore.
        Entropy.UI.Widget.collapsingHeader(tabId, withIcon("sparkle", "Effects"), (tid: string) => {
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                Entropy.UI.Widget.group(tid2, (tid3: string) => {
                    Entropy.UI.Widget.label(tid3, { text: "Delay", bold: true });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Time (s)",
                        value: track.voice.delayTime, min: 0, max: 1,
                        onChange: (v: string) => { track.voice.delayTime = parseFloat(v); persist(); }
                    });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Feedback",
                        value: track.voice.delayFeedback, min: 0, max: 0.95,
                        onChange: (v: string) => { track.voice.delayFeedback = parseFloat(v); persist(); }
                    });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Mix",
                        value: track.voice.delayMix, min: 0, max: 1,
                        onChange: (v: string) => { track.voice.delayMix = parseFloat(v); persist(); }
                    });
                });

                Entropy.UI.Widget.group(tid2, (tid3: string) => {
                    Entropy.UI.Widget.label(tid3, { text: "Reverb", bold: true });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Room Size (m)",
                        value: track.voice.reverbRoomSize, min: 10, max: 30,
                        onChange: (v: string) => { track.voice.reverbRoomSize = parseFloat(v); persist(); }
                    });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Time (s)",
                        value: track.voice.reverbTime, min: 0.1, max: 6,
                        onChange: (v: string) => { track.voice.reverbTime = parseFloat(v); persist(); }
                    });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Damping",
                        value: track.voice.reverbDamping, min: 0, max: 1,
                        onChange: (v: string) => { track.voice.reverbDamping = parseFloat(v); persist(); }
                    });
                    Entropy.UI.Widget.slider(tid3, {
                        label: "Mix",
                        value: track.voice.reverbMix, min: 0, max: 1,
                        onChange: (v: string) => { track.voice.reverbMix = parseFloat(v); persist(); }
                    });
                });
            });
        });

        // Character: one knob per idea. Pump, Gate, Grit and Space are effects on this track's bus;
        // Bounce and Humanize shape the notes as they play; Acid drives the built-in synth's filter.
        Entropy.UI.Widget.collapsingHeader(tabId, withIcon("lightning", `${track.name} - Character`), (tid: string) => {
            const ch = trackCharacter(track);
            const knob = (row: string, name: KnobName, label: string) => Entropy.UI.Widget.knob(row, {
                id: "char_" + name, label, value: ch[name], min: 0, max: 1,
                onChange: (v: string) => { setCharacterKnob(track, name, parseFloat(v)); }
            });
            Entropy.UI.Widget.horizontal(tid, (row: string) => {
                Entropy.UI.Widget.group(row, (g: string) => {
                    Entropy.UI.Widget.label(g, { text: "Groove", bold: true });
                    Entropy.UI.Widget.horizontal(g, (r: string) => {
                        knob(r, "pump", "Pump");
                        knob(r, "bounce", "Bounce");
                        knob(r, "humanize", "Humanize");
                    });
                });
                Entropy.UI.Widget.group(row, (g: string) => {
                    Entropy.UI.Widget.label(g, { text: "Gate", bold: true });
                    Entropy.UI.Widget.horizontal(g, (r: string) => {
                        knob(r, "gate", "Depth");
                        Entropy.UI.Widget.dropdown(r, {
                            label: "Pattern", id: "char_gate_pattern", options: GATE_PATTERN_LABELS,
                            selectedIndex: Math.max(0, GATE_PATTERNS.indexOf(ch.gatePattern)),
                            onChange: (idx: string) => { setGatePattern(track, GATE_PATTERNS[parseInt(idx, 10)] ?? "sixteenths"); }
                        });
                    });
                });
                Entropy.UI.Widget.group(row, (g: string) => {
                    Entropy.UI.Widget.label(g, { text: "Tone", bold: true });
                    Entropy.UI.Widget.horizontal(g, (r: string) => {
                        knob(r, "acid", "Acid");
                        knob(r, "grit", "Grit");
                        knob(r, "space", "Space");
                    });
                });
            });
            if (ch.acid > 0 && !acidApplies(track)) {
                Entropy.UI.Widget.label(tid, { text: "Acid's filter envelope and drive belong to the built-in oscillators (sine, square, saw, triangle, noise); this track follows only the cutoff and resonance it sets." });
            }
        }, "character_panel", true);

        // Preview plays through this track's own persistent bus (ensureTrackBus/syncTrackBus),
        // so it's an honest preview of the track's actual gain/mute/solo/FX, not a bypassed
        // one-off - the tradeoff is a muted track previews silent too.
        Entropy.UI.Widget.collapsingHeader(tabId, withIcon("speaker-high", "Preview"), (tid: string) => {
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                const previewRows = track.kind === "drum" ? ensureRack(track).length : Math.min(track.rows, SCALES[track.scale]?.length || 7);
                for (let r = 0; r < previewRows; r++) {
                    const { freq } = noteVoiceAndFreq(track, r);
                    const label = track.kind === "drum" ? (padAt(track, r)?.name || `Pad ${r + 1}`) : midiToName(rowToMidi(r, track.rootNote, track.scale));
                    Entropy.UI.Widget.button(tid2, {
                        text: label,
                        id: "preview_row_" + r,
                        onClick: () => {
                            if (trackUsesVst3(track)) {
                                playVst3Note(track, r, 1.0, 0.5);
                                return;
                            }
                            if (track.kind === "drum") {
                                playPad(track, r, 1.0, 0.5);
                                return;
                            }
                            if (isWavetableTrack(track)) {
                                wavetableNote(track, freq, 1.0, 0.5);
                                return;
                            }
                            addon.Audio.playNoteOnTrack(track.id, builtInNoteConfig(track, freq, 1.0, 0.5));
                        }
                    });
                }
            });
        });

        // Moves: one-click edits. The pattern row works on the pattern below; the arrangement row
        // works at the section boundary nearest the playhead, or on the selected clip.
        Entropy.UI.Widget.collapsingHeader(tabId, withIcon("magic-wand", "Moves"), (tid: string) => {
            const act = (fn: () => string) => () => { fn(); };
            Entropy.UI.Widget.horizontal(tid, (row: string) => {
                Entropy.UI.Widget.knob(row, {
                    id: "move_amount", label: "Amount", value: moveOpts.amount, min: 0, max: 1,
                    onChange: (v: string) => { const x = parseFloat(v); if (Number.isFinite(x)) moveOpts.amount = Math.max(0, Math.min(1, x)); }
                });
                Entropy.UI.Widget.dropdown(row, {
                    label: "Vary", id: "move_focus", options: VARIATION_LABELS,
                    selectedIndex: Math.max(0, VARIATION_FOCI.indexOf(moveOpts.focus)),
                    onChange: (idx: string) => { moveOpts.focus = VARIATION_FOCI[parseInt(idx, 10)] ?? "mixed"; }
                });
                Entropy.UI.Widget.checkbox(row, {
                    label: "As new pattern", value: moveOpts.variationAsNew,
                    onChange: (v: any) => { moveOpts.variationAsNew = v === true || v === "true"; }
                });
                Entropy.UI.Widget.button(row, { text: withIcon("shuffle", "Make Variation"), id: "move_variation", onClick: act(() => variationMove(track)) });
                Entropy.UI.Widget.button(row, { text: "Thin Out", id: "move_thin", onClick: act(() => thinOutMove(track)) });
                Entropy.UI.Widget.dropdown(row, {
                    label: "Stutter", id: "move_stutter_rate", options: ["1/8", "1/16", "1/32"],
                    selectedIndex: Math.max(0, STUTTER_RATES.indexOf(moveOpts.stutterRate)),
                    onChange: (idx: string) => { moveOpts.stutterRate = STUTTER_RATES[parseInt(idx, 10)] ?? "16th"; }
                });
                Entropy.UI.Widget.button(row, { text: "Stutter", id: "move_stutter", onClick: act(() => stutterMove(track)) });
                Entropy.UI.Widget.button(row, { text: "Octave Spark", id: "move_spark", onClick: act(() => octaveSparkMove(track)) });
                Entropy.UI.Widget.button(row, { text: "Answer", id: "move_answer", onClick: act(() => answerMove(track)) });
            });
            Entropy.UI.Widget.horizontal(tid, (row: string) => {
                Entropy.UI.Widget.checkbox(row, {
                    label: "Align attacks", value: moveOpts.kickAlign,
                    onChange: (v: any) => { moveOpts.kickAlign = v === true || v === "true"; }
                });
                Entropy.UI.Widget.button(row, { text: "Kick Lock", id: "move_kick_lock", onClick: act(() => kickLockMove(track)) });
                Entropy.UI.Widget.separator(row);
                Entropy.UI.Widget.dropdown(row, {
                    label: "Build", id: "move_build_bars", options: ["2 bars", "4 bars"],
                    selectedIndex: moveOpts.buildBars === 2 ? 0 : 1,
                    onChange: (idx: string) => { moveOpts.buildBars = idx === "0" ? 2 : 4; }
                });
                Entropy.UI.Widget.checkbox(row, {
                    label: "Filter sweep", value: moveOpts.buildSweep,
                    onChange: (v: any) => { moveOpts.buildSweep = v === true || v === "true"; }
                });
                Entropy.UI.Widget.button(row, { text: withIcon("fire", "Build"), id: "move_build", onClick: act(buildMove) });
                Entropy.UI.Widget.dropdown(row, {
                    label: "Gap", id: "move_gap_length", options: ["Last beat", "Half bar"],
                    selectedIndex: moveOpts.gapLength === "beat" ? 0 : 1,
                    onChange: (idx: string) => { moveOpts.gapLength = idx === "0" ? "beat" : "half"; }
                });
                Entropy.UI.Widget.dropdown(row, {
                    label: "Cut", id: "move_gap_scope", options: ["Drums", "Everything"],
                    selectedIndex: moveOpts.gapScope === "drums" ? 0 : 1,
                    onChange: (idx: string) => { moveOpts.gapScope = idx === "0" ? "drums" : "all"; }
                });
                Entropy.UI.Widget.checkbox(row, {
                    label: "Keep tails", value: moveOpts.keepTails,
                    onChange: (v: any) => { moveOpts.keepTails = v === true || v === "true"; }
                });
                Entropy.UI.Widget.button(row, { text: "Drop Gap", id: "move_drop_gap", onClick: act(dropGapMove) });
                Entropy.UI.Widget.dropdown(row, {
                    label: "Echo", id: "move_echo_length", options: ["1 beat", "Half bar"],
                    selectedIndex: moveOpts.echoLength === "beat" ? 0 : 1,
                    onChange: (idx: string) => { moveOpts.echoLength = idx === "0" ? "beat" : "half"; }
                });
                Entropy.UI.Widget.button(row, { text: withIcon("wave-sine", "Echo Out"), id: "move_echo_out", onClick: act(echoOutMove) });
                Entropy.UI.Widget.button(row, {
                    text: withIcon("arrow-counter-clockwise", undoStack.length ? `Undo ${undoStack[undoStack.length - 1].label}` : "Undo"),
                    id: "move_undo", onClick: act(undoMove)
                });
            });
            if (kickPreview) {
                const lines = kickPreviewLines();
                Entropy.UI.Widget.label(tid, { text: `Kick Lock preview (playing now): ${lines.length} note${lines.length === 1 ? "" : "s"} change.`, bold: true });
                for (const line of lines) Entropy.UI.Widget.label(tid, { text: line });
                Entropy.UI.Widget.horizontal(tid, (row: string) => {
                    Entropy.UI.Widget.button(row, { text: "Apply", id: "move_kick_apply", onClick: act(applyKickPreview) });
                    Entropy.UI.Widget.button(row, { text: "Cancel", id: "move_kick_cancel", onClick: () => { cancelKickPreview(); moveStatus = "Kick Lock cancelled."; } });
                });
            }
            for (const cut of projectCuts()) {
                const names = cut.trackIds.map(id => findTrack(id)?.name).filter(Boolean).join(", ");
                Entropy.UI.Widget.horizontal(tid, (row: string) => {
                    Entropy.UI.Widget.label(row, { text: `Hard cut: ${names || "no tracks"} silent from ${barLabel(cut.startStep)} to ${barLabel(cut.endStep)}` });
                    Entropy.UI.Widget.button(row, { text: withIcon("trash", "Remove"), id: "move_cut_remove_" + cut.id, onClick: () => { removeCut(cut.id); } });
                });
            }
            Entropy.UI.Widget.label(tid, {
                text: moveStatus || `Build and Drop Gap work before the bar nearest the playhead (now ${barLabel(boundaryStep())}); Echo Out and Answer use the selected clip.`
            });
        }, "moves_panel", true);

        // The pattern the piano roll below is editing: pick, add, duplicate, resize, or send it
        // to the clip that is selected in the arrangement.
        const pattern = activePattern(track);
        Entropy.UI.Widget.label(tabId, { text: `Piano Roll - ${track.name} / ${pattern.name} (click/drag to paint, click a note to erase)`, bold: true });
        Entropy.UI.Widget.horizontal(tabId, (tid: string) => {
            Entropy.UI.Widget.dropdown(tid, {
                label: "Pattern",
                id: "pattern_select",
                options: track.patterns.map(p => p.name),
                selectedIndex: Math.max(0, track.patterns.findIndex(p => p.id === pattern.id)),
                onChange: (idx: string) => {
                    const chosen = track.patterns[parseInt(idx, 10)];
                    if (chosen) track.activePatternId = chosen.id;
                }
            });
            Entropy.UI.Widget.button(tid, {
                text: "+ New Pattern",
                id: "pattern_new",
                onClick: () => { addPattern(track); persist(); }
            });
            Entropy.UI.Widget.button(tid, {
                text: "Duplicate Pattern",
                id: "pattern_duplicate",
                onClick: () => { duplicatePattern(track); persist(); }
            });
            Entropy.UI.Widget.button(tid, {
                text: "Use In Selected Clip",
                id: "pattern_assign",
                onClick: () => {
                    const clip = selectedClip();
                    if (clip && clip.trackId === track.id) {
                        clip.patternId = activePattern(track).id;
                        persist();
                    }
                }
            });
            Entropy.UI.Widget.dropdown(tid, {
                label: "Length",
                id: "pattern_length",
                options: PATTERN_LENGTH_LABELS,
                selectedIndex: patternLengthIndex(pattern),
                onChange: (idx: string) => {
                    const bars = PATTERN_LENGTH_BARS[parseInt(idx, 10)];
                    if (bars) {
                        activePattern(track).steps = Math.max(1, Math.round(bars * barSteps(project.stepsPerBeat)));
                        persist();
                    }
                }
            });
        });

        // The widget draws whole steps: a 32nd note (length 0.5) shows as one step.
        const displayCells = pattern.notes.map(n => ({
            row: toDisplayRow(track, n.row),
            step: n.step,
            length: Math.max(1, Math.round(n.length)),
            velocity: n.velocity
        }));

        Entropy.UI.Widget.pianoRoll(tabId, {
            id: "daw_pianoroll_" + track.id,
            rows: track.rows,
            steps: pattern.steps,
            stepsPerBeat: project.stepsPerBeat,
            rowLabels: rowLabelsFor(track),
            cells: displayCells,
            playhead: transport.playing ? pianoRollPlayhead(project, track, currentStepFloat(), transport.mode) : -1,
            onNoteDown: (displayRow: number, step: number) => handleNoteDown(toDisplayRow(track, displayRow), step),
            onNoteDrag: (displayRow: number, step: number) => handleNoteDrag(toDisplayRow(track, displayRow), step),
            onNoteUp: (displayRow: number, step: number) => handleNoteUp(toDisplayRow(track, displayRow), step)
        });
    };

    if (Entropy.Composer) {
        // Lets Entropy Studio host this addon as a docked workspace tab, when running inside
        // Studio.
        Entropy.Composer.registerEditor("DAW", renderDAWUI);
    }

    // Same createTab call also drives the full-window tab bar embedded (non-Studio) apps get
    // via AddonEngine::render_tabs - the widget calls inside renderDAWUI don't care which host
    // is drawing them.
    const tabId = addon.UI.createTab({
        title: withIcon("piano-keys", "DAW"),
        onRender: async () => {
            renderDAWUI(tabId);
        }
    });

    // The analyzer floats over the tab, bottom-right by default; drag it wherever suits. The engine
    // draws tabs first and windows on top of them.
    const [screenW, screenH] = Entropy.Window.getSize();
    const analyzerWindow: string = Entropy.UI.createWindow({
        title: "Analyzer",
        width: 720,
        height: 330,
        x: Math.max(16, screenW - 736),
        y: Math.max(16, screenH - 346),
        onRender: () => renderAnalyzer(analyzerWindow)
    });

    // The drum rack: sample browser, pad bank and pad editor side by side, top-left over the
    // arrangement (drag it wherever suits) and clear of the analyzer at the bottom right.
    const rackWidth = Math.max(640, Math.min(1290, screenW - 32));
    rackWindowId = Entropy.UI.createWindow({
        title: "Drum Rack",
        width: rackWidth,
        height: 590,
        x: 16,
        y: 56,
        onRender: () => renderRackWindow(rackWindowId!)
    });
    Entropy.UI.setWindowVisible(rackWindowId, rackVisible);

    // The wavetable editor, hidden until asked for. Tall and wide: the terrain wants room.
    wavetableWindowHeight = Math.max(560, Math.min(940, screenH - 72));
    wavetableWindowWidth = Math.max(760, Math.min(1240, screenW - 32));
    wavetableWindowId = Entropy.UI.createWindow({
        title: "Wavetable",
        width: wavetableWindowWidth,
        height: wavetableWindowHeight,
        x: 16,
        y: 56,
        onRender: () => renderWavetableWindow(wavetableWindowId!)
    });
    Entropy.UI.setWindowVisible(wavetableWindowId, wavetableVisible);

    // The bowed-string editor, hidden until asked for.
    physModWindowHeight = Math.max(520, Math.min(820, screenH - 72));
    physModWindowWidth = Math.max(700, Math.min(1080, screenW - 32));
    physModWindowId = Entropy.UI.createWindow({
        title: "Bowed String",
        width: physModWindowWidth,
        height: physModWindowHeight,
        x: 16,
        y: 56,
        onRender: () => renderPhysModWindow(physModWindowId!)
    });
    Entropy.UI.setWindowVisible(physModWindowId, physModVisible);

    // The brass editor, hidden until asked for.
    brassWindowHeight = Math.max(520, Math.min(820, screenH - 72));
    brassWindowWidth = Math.max(700, Math.min(1080, screenW - 32));
    brassWindowId = Entropy.UI.createWindow({
        title: "Brass",
        width: brassWindowWidth,
        height: brassWindowHeight,
        x: 16,
        y: 56,
        onRender: () => renderBrassWindow(brassWindowId!)
    });
    Entropy.UI.setWindowVisible(brassWindowId, brassVisible);

    // The drum kit, hidden until asked for.
    matterWindowHeight = Math.max(520, Math.min(820, screenH - 72));
    matterWindowWidth = Math.max(700, Math.min(1120, screenW - 32));
    matterWindowId = Entropy.UI.createWindow({
        title: "Kit",
        width: matterWindowWidth,
        height: matterWindowHeight,
        x: 16,
        y: 56,
        onRender: () => renderMatterWindow(matterWindowId!)
    });
    Entropy.UI.setWindowVisible(matterWindowId, matterVisible);

    // The song library and the open song's version history, hidden until asked for.
    songsWindowId = Entropy.UI.createWindow({
        title: "Songs",
        width: 620,
        height: Math.max(520, Math.min(760, screenH - 72)),
        x: 16,
        y: 56,
        onRender: () => renderSongsWindow(songsWindowId!)
    });
    Entropy.UI.setWindowVisible(songsWindowId, songsVisible);
    historyWindowId = Entropy.UI.createWindow({
        title: "History",
        width: 600,
        height: Math.max(520, Math.min(760, screenH - 72)),
        x: Math.max(16, screenW - 616),
        y: 56,
        onRender: () => renderHistoryWindow(historyWindowId!)
    });
    Entropy.UI.setWindowVisible(historyWindowId, historyVisible);

    // Ctrl+S keeps a version (the song itself is always saved), Ctrl+O shows the song list.
    Entropy.Input?.onKeyDown?.((key: string, ctrl: boolean) => {
        if (!ctrl) return;
        const k = key.toLowerCase();
        if (k === "s") libraryAction("save a version", () => saveVersionNow());
        else if (k === "o") setSongsVisible(!songsVisible);
    });

    // The guitar input, top right, hidden until asked for. Drag it anywhere.
    guitarWindowId = Entropy.UI.createWindow({
        title: "Guitar Input",
        width: 620,
        height: 590,
        x: Math.max(16, screenW - 636),
        y: 56,
        onRender: () => renderGuitarWindow(guitarWindowId!)
    });
    Entropy.UI.setWindowVisible(guitarWindowId, guitarVisible);

    const onFrame = () => {
        pollGuitar();
        // A plugin's patch changes inside its own editor window, where the DAW sees nothing. The
        // host snapshots its state when the editor closes or a parameter edit settles, and this
        // collects it into the project. The peak meter drains here too.
        for (const track of project.tracks) {
            const runtime = vst3Runtime[track.id];
            if (!track.instrument || !runtime?.ok) continue;
            const state = addon.Vst3.pollState(track.id);
            if (state) {
                track.instrument.state = state;
                persist();
            }
            const peak = addon.Vst3.takePeak(track.id);
            if (typeof peak === "number") runtime.peak = Math.max(peak, runtime.peak * 0.92);
        }

        tickLibrary();

        if (!transport.playing) return;

        const stepFloat = currentStepFloat();
        const absStep = Math.floor(stepFloat + LOOKAHEAD_STEPS);
        const total = transportLength();
        transport.cursorStep = ((stepFloat % total) + total) % total;

        // Queue every step that has come within reach since the last frame, not just the newest,
        // so a slow frame cannot swallow a note. After a long stall (a plugin loading, say) skip
        // ahead rather than fire the whole backlog at once.
        let from = transport.lastAbsStep + 1;
        if (absStep - from > 32) { from = absStep; pendingNotes = []; }
        for (let s = from; s <= absStep; s++) queueStep(s);
        // Re-anchor Pump and Gate once a bar.
        const bar = barSteps(project.stepsPerBeat);
        if (Math.floor(absStep / bar) !== Math.floor(transport.lastAbsStep / bar)) syncTempoEffects();
        transport.lastAbsStep = Math.max(transport.lastAbsStep, absStep);
        firePendingNotes(stepFloat);
        updateCuts(transport.mode === "song" ? transport.cursorStep : null);
    };

    // The engine ticks exactly one addon name per frame: "DAW" while Studio has the DAW workspace
    // active, but "Global" in a standalone EntropyApp (see render_addon_frame.rs), where a plain
    // `onUpdate` never fires - which left the transport silent in `example daw`. Registering under
    // both names cannot double-fire, since only one name is current on any given frame.
    addon.onUpdate(onFrame);
    addon.onUpdatePlus("Global", onFrame);

    // --- Chat / AI tool integration ---

    Entropy.println("DAW Addon Register Tools...");

    addon.registerTool({
        name: "daw_analyze_mix",
        description: "Listen to what the DAW is playing right now, without hearing it: returns peak and RMS level in dBFS, the strongest frequency (Hz and nearest note), and the spectral centroid (a brightness measure) for the master mix and for every track, measured over the last ~90 ms of audio. Call it while the song is playing (start it with daw_set_transport) to check a balance, find a track that is too loud or silent, or confirm a bass sits low and a lead sits high. Silence reads -120 dBFS. framesWritten increasing between two calls proves the audio engine is running.",
        parameters: { type: "object", properties: {} }
    }, () => {
        const read = (source: string) => {
            const a = addon.Audio.analyze(source, 4096);
            if (!a) return null;
            const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
            return {
                peakDb: round(Math.max(a.peakL, a.peakR)),
                rmsDb: round(Math.max(a.rmsL, a.rmsR)),
                strongestHz: round(a.peakHz),
                strongestNote: a.peakHz > 0 ? midiToName(Math.round(69 + 12 * Math.log2(a.peakHz / 440))) : null,
                brightnessHz: Math.round(a.centroidHz),
                framesWritten: a.framesWritten
            };
        };
        return {
            playing: transport.playing,
            master: read("master"),
            tracks: project.tracks.map(t => ({ id: t.id, name: t.name, muted: t.muted, solo: t.solo, ...read(t.id) }))
        };
    });

    addon.registerTool({
        name: "daw_get_state",
        description: "Get the current DAW project: BPM, song length in bars, and every track (id, name, kind, channel, mute/solo, gain, voice params, scale/rootNote for synth tracks, its patterns) plus the arrangement (which pattern plays where, in bars). Call this before editing so you know track ids, pattern ids and row semantics.",
        parameters: { type: "object", properties: {} }
    }, () => {
        const bar = barSteps(project.stepsPerBeat);
        return {
            song: { id: library.currentSongId, name: currentSongName() },
            bpm: project.bpm,
            songBars: project.songBars,
            stepsPerBeat: project.stepsPerBeat,
            stepsPerBar: bar,
            channels: laneCount(project.tracks),
            playing: transport.playing,
            mode: transport.mode,
            activeTrackId: project.activeTrackId,
            drumRowLayout: defaultRack().map((d, i) => ({ row: i, name: d.name })),
            availableScales: SCALE_NAMES,
            tracks: project.tracks.map(t => ({
                id: t.id,
                name: t.name,
                kind: t.kind,
                channel: t.channel,
                muted: t.muted,
                solo: t.solo,
                gain: t.gain,
                instrument: t.instrument ? { name: t.instrument.name, loaded: vst3Runtime[t.id]?.ok === true } : null,
                voice: t.voice,
                character: trackCharacter(t),
                wavetable: isWavetableTrack(t) ? describeWavetable(trackWavetable(t)) : undefined,
                physmod: isPhysModTrack(t) ? describePhysMod(trackPhysMod(t)) : undefined,
                brass: isBrassTrack(t) ? describeBrass(trackBrass(t)) : undefined,
                matter: isMatterTrack(t) ? describeMatter(trackMatter(t)) : undefined,
                rootNote: t.kind === "synth" && !isMatterTrack(t) ? t.rootNote : undefined,
                scale: t.kind === "synth" && !isMatterTrack(t) ? t.scale : undefined,
                rows: t.rows,
                rowNotes: isMatterTrack(t)
                    ? MATTER_ROWS.map(r => r.label)
                    : t.kind === "synth"
                    ? Array.from({ length: t.rows }, (_, r) => midiToName(rowToMidi(r, t.rootNote, t.scale)))
                    : ensureRack(t).map(d => d.name),
                rack: t.kind === "drum"
                    ? ensureRack(t).map((p, i) => ({
                        row: i, name: p.name, plays: p.sample ? "sample" : (p.voice ? "built-in voice" : "nothing"),
                        sample: p.sample ? { path: p.sample.path, gain: p.sample.gain, semitones: p.sample.semitones, start: p.sample.start, end: p.sample.end, gate: p.sample.gate, missing: isSampleMissing(p.sample.path) } : null
                    }))
                    : undefined,
                activePatternId: t.activePatternId,
                patterns: t.patterns.map(p => ({ id: p.id, name: p.name, steps: p.steps, noteCount: p.notes.length }))
            })),
            arrangement: project.arrangement.map(c => ({
                id: c.id, trackId: c.trackId, patternId: c.patternId,
                startBar: c.startStep / bar, bars: c.lengthSteps / bar
            }))
        };
    });

    addon.registerTool({
        name: "daw_create_track",
        description: "Create a new DAW track on the lowest free channel (or a chosen one). kind \"drum\" gives a drum rack that starts as a 5-pad kit (row 0=Kick, 1=Snare, 2=Hihat, 3=Clap, 4=Tom); pads can be given sample files with daw_set_pad_sample. kind \"synth\" gives a pitched track spanning multiple octaves of the chosen scale (row 0 = root note, increasing row = higher pitch). It starts with one empty pattern and no clips; writing notes with daw_set_notes gives it a clip automatically. Returns the new track id plus its row layout so you can write patterns.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string" },
                kind: { type: "string", enum: ["synth", "drum"] },
                channel: { type: "number", description: "0-based arrangement lane. Defaults to the lowest free one." },
                waveform: { type: "string", enum: WAVEFORMS, description: "Synth tracks only." },
                scale: { type: "string", enum: SCALE_NAMES, description: "Synth tracks only. Defaults to pentatonic_minor." },
                rootNote: { type: "number", description: "MIDI note number for row 0 (e.g. 60 = C4, 36 = C2 for bass). Synth tracks only." },
                octaves: { type: "number", description: "How many octaves of the scale to expose as rows. Synth tracks only, default 2." },
                gain: { type: "number", description: "0-1, default 0.25 for synth, 0.5 for drum." }
            },
            required: ["name", "kind"]
        }
    }, (args: any) => {
        const channel = typeof args.channel === "number" && args.channel >= 0 && !project.tracks.some(t => t.channel === Math.round(args.channel))
            ? Math.round(args.channel) : undefined;

        if (args.kind === "drum") {
            const track = addTrack("drum", channel, args.name);
            if (typeof args.gain === "number") track.gain = args.gain;
            persist();
            return { success: true, id: track.id, kind: "drum", channel: track.channel, rows: ensureRack(track).length, patternId: track.activePatternId, rowLayout: ensureRack(track).map((d, i) => ({ row: i, name: d.name })) };
        }

        const scale = (args.scale && SCALES[args.scale]) ? args.scale : "pentatonic_minor";
        const octaves = Math.max(1, args.octaves || 2);
        const rows = SCALES[scale].length * octaves;
        const rootNote = typeof args.rootNote === "number" ? args.rootNote : 60;

        const track = addTrack("synth", channel, args.name);
        track.scale = scale;
        track.rows = rows;
        track.rootNote = rootNote;
        track.voice = defaultSynthVoice(args.waveform || "saw");
        if (typeof args.gain === "number") track.gain = args.gain;
        persist();

        return {
            success: true, id: track.id, kind: "synth", channel: track.channel, scale, rootNote, rows, patternId: track.activePatternId,
            rowNotes: Array.from({ length: rows }, (_, r) => midiToName(rowToMidi(r, rootNote, scale)))
        };
    });

    addon.registerTool({
        name: "daw_set_track_params",
        description: "Update a track's name, mute/solo, gain, or synth voice (waveform/cutoff/resonance/attack/decay/sustain/release). Only fields provided are changed.",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                name: { type: "string" },
                muted: { type: "boolean" },
                solo: { type: "boolean" },
                gain: { type: "number" },
                waveform: { type: "string", enum: [...WAVEFORMS, PHYSMOD_WAVEFORM, BRASS_WAVEFORM, MATTER_WAVEFORM, "kick", "snare", "hihat", "clap", "tom"], description: "\"physmod\" makes a bowed string, \"brass\" a brass instrument, \"matter\" a physically modeled drum kit (its rows become the kit's pieces)." },
                cutoff: { type: "number" },
                resonance: { type: "number" },
                attack: { type: "number" },
                decay: { type: "number" },
                sustain: { type: "number" },
                release: { type: "number" },
                delayTime: { type: "number", description: "Echo delay time in seconds, 0 = off." },
                delayFeedback: { type: "number", description: "0-0.95." },
                delayMix: { type: "number", description: "0 (off) - 1 wet/dry mix." },
                reverbRoomSize: { type: "number", description: "Meters, 10-30." },
                reverbTime: { type: "number", description: "Seconds to -60dB." },
                reverbDamping: { type: "number", description: "0-1." },
                reverbMix: { type: "number", description: "0 (off) - 1 wet/dry mix." }
            },
            required: ["trackId"]
        }
    }, (args: any) => {
        const track = project.tracks.find(t => t.id === args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };

        if (typeof args.name === "string") track.name = args.name;
        if (typeof args.muted === "boolean") track.muted = args.muted;
        if (typeof args.solo === "boolean") track.solo = args.solo;
        if (typeof args.gain === "number") track.gain = Math.max(0, Math.min(1, args.gain));
        if (typeof args.waveform === "string") track.voice.waveform = args.waveform;
        if (typeof args.cutoff === "number") track.voice.cutoff = args.cutoff;
        if (typeof args.resonance === "number") track.voice.resonance = args.resonance;
        if (typeof args.attack === "number") track.voice.attack = args.attack;
        if (typeof args.decay === "number") track.voice.decay = args.decay;
        if (typeof args.sustain === "number") track.voice.sustain = args.sustain;
        if (typeof args.release === "number") track.voice.release = args.release;
        if (typeof args.delayTime === "number") track.voice.delayTime = args.delayTime;
        if (typeof args.delayFeedback === "number") track.voice.delayFeedback = args.delayFeedback;
        if (typeof args.delayMix === "number") track.voice.delayMix = args.delayMix;
        if (typeof args.reverbRoomSize === "number") track.voice.reverbRoomSize = args.reverbRoomSize;
        if (typeof args.reverbTime === "number") track.voice.reverbTime = args.reverbTime;
        if (typeof args.reverbDamping === "number") track.voice.reverbDamping = args.reverbDamping;
        if (typeof args.reverbMix === "number") track.voice.reverbMix = args.reverbMix;

        persist();
        return { success: true, track: { id: track.id, name: track.name, voice: track.voice, gain: track.gain, muted: track.muted, solo: track.solo } };
    });

    addon.registerTool({
        name: "daw_character",
        description: "Set a track's Character knobs, each 0-1 (0 = off). pump: beat-synced volume ducking, from gentle breathing to deep house pumping. bounce: a deliberate groove - offbeat sixteenths pushed late (up to a 66% swing) and softened, offbeat eighths accented - for house hats, garage percussion and basslines. gate: chops the sound into rhythmic pulses, with gatePattern eighths, sixteenths or syncopated (3+3+2). acid: the built-in synth's filter cutoff, resonance, filter envelope and drive swept together (sine/square/saw/triangle/noise voices; it also writes the track's cutoff and resonance, restored when acid returns to 0). grit: saturation turning into bit and sample-rate reduction, loudness-compensated. space: close and dry to distant and washed out (reverb, darker, less direct sound). humanize: small repeatable timing and velocity differences. Pump, gate, grit and space work on every kind of track, sample pads and plugins included, live and in the WAV export. Only fields given change.",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                ...Object.fromEntries(KNOB_NAMES.map(k => [k, { type: "number", description: "0-1." }])),
                gatePattern: { type: "string", enum: [...GATE_PATTERNS] }
            },
            required: ["trackId"]
        }
    }, (args: any) => {
        const track = findTrack(args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        for (const k of KNOB_NAMES) if (typeof args[k] === "number") setCharacterKnob(track, k, args[k]);
        if (GATE_PATTERNS.includes(args.gatePattern)) setGatePattern(track, args.gatePattern);
        persist();
        return { success: true, character: trackCharacter(track), voice: track.voice };
    });

    addon.registerTool({
        name: "daw_move",
        description: "Apply a one-click Move. Pattern moves rewrite a track's active pattern (pass trackId): \"variation\" (amount 0-1, focus mixed|rhythm|notes|fill, asNewPattern to keep the original), \"thin_out\" (removes the weakest amount-share of notes, keeping downbeats and phrase anchors), \"stutter\" (rate 8th|16th|32nd: the last beat repeats its first slice), \"octave_spark\" (a few short octave-up notes near the end; synth tracks), \"kick_lock\" (shortens bass notes that ring over a kick; align moves attacks one step off a kick onto it; with preview true it only proposes and lists the changes - call kick_lock_apply or kick_lock_cancel after), \"answer\" (a response phrase from a synth pattern's own notes, placed after the clip given by clipId). Arrangement moves: \"build\" (bars 2|4 of accelerating drum roll ending at boundaryBar, with sweep for a rising filter), \"drop_gap\" (gap beat|half before boundaryBar, scope drums|all, keepTails false also silences reverb/delay tails), \"echo_out\" (the ending of clipId, echoLength beat|half, repeats fading and darkening for one bar after it). \"undo\" reverts the last move. boundaryBar is 1-based: the first bar of the new section. Returns a status message.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["variation", "thin_out", "stutter", "octave_spark", "kick_lock", "kick_lock_apply", "kick_lock_cancel", "answer", "build", "drop_gap", "echo_out", "undo"] },
                trackId: { type: "string" },
                clipId: { type: "string" },
                boundaryBar: { type: "number" },
                amount: { type: "number" },
                focus: { type: "string", enum: VARIATION_FOCI },
                asNewPattern: { type: "boolean" },
                rate: { type: "string", enum: STUTTER_RATES },
                align: { type: "boolean" },
                preview: { type: "boolean" },
                bars: { type: "number", enum: [2, 4] },
                sweep: { type: "boolean" },
                gap: { type: "string", enum: ["beat", "half"] },
                scope: { type: "string", enum: ["drums", "all"] },
                keepTails: { type: "boolean" },
                echoLength: { type: "string", enum: ["beat", "half"] }
            },
            required: ["action"]
        }
    }, (args: any) => {
        if (args.trackId !== undefined) {
            if (!findTrack(args.trackId)) return { success: false, error: "Track not found: " + args.trackId };
            project.activeTrackId = args.trackId;
        }
        if (args.clipId !== undefined) {
            const clip = project.arrangement.find(c => c.id === args.clipId);
            if (!clip) return { success: false, error: "Clip not found: " + args.clipId };
            selectClip(clip);
        }
        if (typeof args.boundaryBar === "number") seekToStep((Math.round(args.boundaryBar) - 1) * barSteps(project.stepsPerBeat));
        if (typeof args.amount === "number") moveOpts.amount = Math.max(0, Math.min(1, args.amount));
        if (VARIATION_FOCI.includes(args.focus)) moveOpts.focus = args.focus;
        if (typeof args.asNewPattern === "boolean") moveOpts.variationAsNew = args.asNewPattern;
        if (STUTTER_RATES.includes(args.rate)) moveOpts.stutterRate = args.rate;
        if (typeof args.align === "boolean") moveOpts.kickAlign = args.align;
        if (args.bars === 2 || args.bars === 4) moveOpts.buildBars = args.bars;
        if (typeof args.sweep === "boolean") moveOpts.buildSweep = args.sweep;
        if (args.gap === "beat" || args.gap === "half") moveOpts.gapLength = args.gap;
        if (args.scope === "drums" || args.scope === "all") moveOpts.gapScope = args.scope;
        if (typeof args.keepTails === "boolean") moveOpts.keepTails = args.keepTails;
        if (args.echoLength === "beat" || args.echoLength === "half") moveOpts.echoLength = args.echoLength;
        const track = getActiveTrack();
        const needTrack = () => { if (!track) throw new Error("no track"); return track; };
        let status: string;
        try {
            switch (args.action) {
                case "variation": status = variationMove(needTrack()); break;
                case "thin_out": status = thinOutMove(needTrack()); break;
                case "stutter": status = stutterMove(needTrack()); break;
                case "octave_spark": status = octaveSparkMove(needTrack()); break;
                case "answer": status = answerMove(needTrack()); break;
                case "kick_lock":
                    status = kickLockMove(needTrack());
                    if (kickPreview && !args.preview) status = applyKickPreview();
                    else if (kickPreview) status = "Preview: " + kickPreviewLines().join("; ");
                    break;
                case "kick_lock_apply": status = kickPreview ? applyKickPreview() : "No Kick Lock preview to apply."; break;
                case "kick_lock_cancel": cancelKickPreview(); status = moveStatus = "Kick Lock cancelled."; break;
                case "build": status = buildMove(); break;
                case "drop_gap": status = dropGapMove(); break;
                case "echo_out": status = echoOutMove(); break;
                case "undo": status = undoMove(); break;
                default: return { success: false, error: "Unknown action: " + args.action };
            }
        } catch {
            return { success: false, error: "Add a track first." };
        }
        return { success: true, status };
    });

    addon.registerTool({
        name: "daw_wavetable",
        description: "Design the sound of a wavetable synth track: a track whose waveform is \"wavetable\" (daw_set_track_params with waveform \"wavetable\" makes one). Its sound is a table of 32 frames, each one cycle of a wave; a note plays one frame's wave at its pitch and moves through the frames as it sounds, so the table is a timbre that changes over time. The human sculpts the same table in the Wavetable window as terrain (phase across, frame into the screen, level up), and every action here edits that same table. Actions: \"info\" (settings, and the harmonics of one frame), \"preset\" (start from sine, saw, square, pwm, vowels, bell, terrain or glass: saw and square brighten across the frames, vowels moves through formants), \"instrument\" (a full patch: table, motion and the track's own filter/envelope in one step - bass, motion FX like a riser or a siren, simple strings/horns, pads and leads; see instrumentPreset for the list and what each one does), \"op\" (normalize, smooth, invert, reverse, flip_frames, randomize), \"sculpt\" (brush dabs: raise, lower, smooth or level at a frame and a phase; radius is in world units, 0.16 default, amount 0.3 is a firm dab and 1 or more saturates), \"params\" (position 0-1 across the frames, lfoRate/lfoDepth, sweep/sweepTime, velToPosition, unison 1-7, detuneCents, spread), and \"hear\" (plays one note offline and reports its loudness, strongest frequency and brightness, so you can check a change worked without listening). Position 0 is the first frame. Sculpt then \"hear\" is the way to verify an edit.",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                action: { type: "string", enum: ["info", "preset", "instrument", "op", "sculpt", "params", "hear"] },
                preset: { type: "string", enum: WT_PRESETS.map(p => p.id), description: "For action preset." },
                instrumentPreset: {
                    type: "string", enum: WT_INSTRUMENT_PRESETS.map(p => p.id),
                    description: "For action instrument. " + WT_INSTRUMENT_PRESETS.map(p => `${p.id} (${p.folder}): ${p.hint}`).join(" "),
                },
                op: { type: "string", enum: WT_OPS.map(o => o.id), description: "For action op." },
                arg: { type: "number", description: "For action op: normalize peak (default 0.9), smooth passes, randomize seed." },
                stamps: {
                    type: "array",
                    description: "For action sculpt. Applied together as one undo step.",
                    items: {
                        type: "object",
                        properties: {
                            tool: { type: "string", enum: ["raise", "lower", "smooth", "level"] },
                            frame: { type: "number", description: "0-based, may be fractional. Frame 0 is where a note starts at position 0." },
                            phase: { type: "number", description: "Position within the cycle, 0-1 (wraps)." },
                            radius: { type: "number", description: "World units, default 0.16. The whole cycle is 2 wide." },
                            amount: { type: "number", description: "0.3 is a firm dab; 1 or more saturates." },
                            target: { type: "number", description: "For level: the height to pull toward, -1 to 1." }
                        },
                        required: ["tool", "frame", "phase"]
                    }
                },
                params: {
                    type: "object",
                    description: "For action params. Only fields given change.",
                    properties: {
                        position: { type: "number" }, lfoRate: { type: "number" }, lfoDepth: { type: "number" },
                        sweep: { type: "number" }, sweepTime: { type: "number" }, velToPosition: { type: "number" },
                        unison: { type: "number" }, detuneCents: { type: "number" }, spread: { type: "number" }
                    }
                },
                frame: { type: "number", description: "For info: which frame's harmonics to report (default 0)." },
                note: { type: "number", description: "For hear: MIDI note (default 48)." },
                position: { type: "number", description: "For hear: where in the table to listen, 0-1 (default the track's position)." }
            },
            required: ["trackId", "action"]
        }
    }, (args: any) => {
        const track = findTrack(args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        if (!isWavetableTrack(track)) return { success: false, error: `${track.name} is not a wavetable track. Use daw_set_track_params with waveform "wavetable" first.` };
        const wt = trackWavetable(track);
        const done = (extra: Record<string, unknown> = {}) => ({ success: true, trackId: track.id, settings: describeWavetable(wt), ...extra });

        switch (args.action) {
            case "info": {
                const frame = Math.max(0, Math.min(31, Math.round(args.frame ?? 0)));
                const h = addon.Wavetable.harmonics(track.id, frame, 16);
                const info = addon.Wavetable.info(track.id);
                return done({ frames: info.frames, frame, harmonics: h.harmonics?.map(v => Math.round(v * 1000) / 1000), peak: h.peak, canUndo: info.canUndo });
            }
            case "preset": {
                if (!WT_PRESETS.some(p => p.id === args.preset)) return { success: false, error: "Unknown preset. Choose one of: " + WT_PRESETS.map(p => p.id).join(", ") };
                loadWavetablePreset(track, args.preset);
                return done();
            }
            case "instrument": {
                if (!WT_INSTRUMENT_PRESETS.some(p => p.id === args.instrumentPreset)) {
                    return { success: false, error: "Unknown instrumentPreset. Choose one of: " + WT_INSTRUMENT_PRESETS.map(p => p.id).join(", ") };
                }
                applyInstrumentPreset(track, args.instrumentPreset);
                return done({ voice: { cutoff: track.voice.cutoff, resonance: track.voice.resonance, attack: track.voice.attack, decay: track.voice.decay, sustain: track.voice.sustain, release: track.voice.release } });
            }
            case "op": {
                if (!WT_OPS.some(o => o.id === args.op)) return { success: false, error: "Unknown op. Choose one of: " + WT_OPS.map(o => o.id).join(", ") };
                const r = addon.Wavetable.op(track.id, args.op, args.arg);
                if (!r.ok) return { success: false, error: r.error };
                saveTrackWavetable(track);
                return done();
            }
            case "sculpt": {
                if (!Array.isArray(args.stamps) || args.stamps.length === 0) return { success: false, error: "sculpt needs a non-empty stamps array." };
                const r = addon.Wavetable.stamp(track.id, args.stamps);
                if (!r.ok) return { success: false, error: r.error };
                saveTrackWavetable(track);
                return done({ touchedFrames: r.touchedFrames ?? null });
            }
            case "params": {
                const p = args.params ?? {};
                const merged = repairWavetable({ ...wt, ...p });
                for (const k of ["position", "lfoRate", "lfoDepth", "sweep", "sweepTime", "velToPosition", "unison", "detuneCents", "spread"] as const) {
                    if (typeof p[k] === "number") (wt as any)[k] = merged[k];
                }
                // A note that is sounding follows the position, exactly as it does for the slider.
                if (typeof p.position === "number") setWavetablePosition(track, wt.position);
                scheduleSave();
                return done();
            }
            case "hear": {
                const midi = typeof args.note === "number" ? args.note : 48;
                const config = wavetableNoteConfig(track.id, track.voice, wt, { freq: midiToFreq(midi), velocity: 0.8, duration: 0.6 });
                if (typeof args.position === "number") config.position = Math.max(0, Math.min(1, args.position));
                config.sweep = 0; config.lfoDepth = 0;
                const a = addon.Wavetable.analyzeNote(config, 0);
                if (!a.ok) return { success: false, error: a.error };
                const r = (v: number | undefined, d = 1) => v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d;
                return done({ note: midiToName(midi), peakDb: r(a.peakDb), rmsDb: r(a.rmsDb), strongestHz: r(a.peakHz), brightnessHz: r(a.centroidHz, 0) });
            }
            default:
                return { success: false, error: "Unknown action: " + args.action };
        }
    });

    addon.registerTool({
        name: "daw_physmod",
        description: "Play and shape a physically modeled bowed-string instrument: a track whose waveform is \"physmod\" (daw_set_track_params with waveform \"physmod\" makes one). The sound comes from a physical model - strings as travelling waves, a bow gripping them through rosin friction, a bridge and resonant body they share - so a violinist's controls behave physically: more bow force brightens until the tone turns raucous, too little force for the bow position gives an airy 'surface sound', bowing nearer the bridge needs more force and sounds brighter, a faster bow is louder. Notes go to the string a player would use; overlapping notes slur, simultaneous ones double-stop, and open strings ring in sympathy. Actions: \"info\" (current settings), \"instrument\" (a preset: violin, viola, cello, bass, or invented ones - hardanger with sympathetic strings, glass violin, octobass, wolf cello), \"params\" (bowForce 0-1, bowVelocity 0-1, bowPosition 0.02-0.5 fraction of the string from the bridge, articulation arco|pizzicato|colLegno, attackSkill 0-1, vibratoRate Hz, vibratoDepth cents, vibratoDelay s, slide s, damping 0-1, brightness 0-1, ring 0-1, stringMass 0-1, stiffness 0-1, rosin 0-1, bowNoise 0-1, bodySize -1..2.5 (0 violin, 0.13 viola, 0.72 cello, 1 bass, beyond is the laboratory), bodyMix 0-1, bodyResonance 0-1, coupling 0-1, tuningFollowsSize true|false to morph the tuning continuously with bodySize), and \"hear\" (plays one note offline and reports its pitch accuracy in cents, loudness, brightness, harmonic balance, and what the bow did: helmholtz / surfaceSound / raucous, slips per period, how long the attack took to settle - so a change can be checked without listening).",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                action: { type: "string", enum: ["info", "instrument", "params", "hear"] },
                instrument: { type: "string", enum: PHYSMOD_INSTRUMENT_PRESETS.map(p => p.id), description: "For action instrument." },
                params: {
                    type: "object",
                    description: "For action params. Only fields given change.",
                    properties: {
                        bowForce: { type: "number" }, bowVelocity: { type: "number" }, bowPosition: { type: "number" },
                        articulation: { type: "string", enum: PHYSMOD_ARTICULATIONS.map(a => a.id) }, attackSkill: { type: "number" },
                        vibratoRate: { type: "number" }, vibratoDepth: { type: "number" }, vibratoDelay: { type: "number" }, slide: { type: "number" },
                        damping: { type: "number" }, brightness: { type: "number" }, ring: { type: "number" },
                        stringMass: { type: "number" }, stiffness: { type: "number" }, rosin: { type: "number" }, bowNoise: { type: "number" },
                        bodySize: { type: "number" }, bodyMix: { type: "number" }, bodyResonance: { type: "number" }, coupling: { type: "number" },
                        tuningFollowsSize: { type: "boolean" }
                    }
                },
                note: { type: "number", description: "For hear: MIDI note (default 60)." }
            },
            required: ["trackId", "action"]
        }
    }, (args: any) => {
        const track = findTrack(args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        if (!isPhysModTrack(track)) return { success: false, error: `${track.name} is not a bowed-string track. Use daw_set_track_params with waveform "physmod" first.` };
        const pm = trackPhysMod(track);
        const done = (extra: Record<string, unknown> = {}) => ({ success: true, trackId: track.id, settings: describePhysMod(pm), ...extra });

        switch (args.action) {
            case "info":
                return done();
            case "instrument": {
                if (!PHYSMOD_INSTRUMENT_PRESETS.some(p => p.id === args.instrument)) {
                    return { success: false, error: "Unknown instrument. Choose one of: " + PHYSMOD_INSTRUMENT_PRESETS.map(p => p.id).join(", ") };
                }
                loadPhysModInstrument(track, args.instrument);
                return done();
            }
            case "params": {
                const p = args.params ?? {};
                const merged = repairPhysMod({ ...pm, ...p });
                for (const k of ["bowForce", "bowVelocity", "bowPosition", "attackSkill", "vibratoRate", "vibratoDepth", "vibratoDelay", "slide", "damping", "brightness", "ring", "stringMass", "stiffness", "rosin", "bowNoise", "bodySize", "bodyMix", "bodyResonance", "coupling"] as const) {
                    if (typeof p[k] === "number") (pm as any)[k] = merged[k];
                }
                if (typeof p.articulation === "string") pm.articulation = merged.articulation;
                if (typeof p.tuningFollowsSize === "boolean") pm.tuningFollowsSize = p.tuningFollowsSize;
                for (const k of ["bowForce", "bowVelocity", "bowPosition", "vibratoDepth"] as const) {
                    if (typeof p[k] === "number") setBowLive(track, k === "bowForce" ? "force" : k === "bowVelocity" ? "velocity" : k === "bowPosition" ? "position" : "vibratoDepth", (pm as any)[k]);
                }
                scheduleSave();
                return done();
            }
            case "hear": {
                const midi = typeof args.note === "number" ? args.note : 60;
                const config = physModNoteConfig(track.id, pm, { freq: midiToFreq(midi), velocity: 0.8, duration: 0.6 });
                const a = addon.PhysMod.analyzeNote(config, 0);
                if (!a.ok) return { success: false, error: a.error };
                const r = (v: number | undefined | null, d = 1) => v === undefined || v === null ? null : Math.round(v * 10 ** d) / 10 ** d;
                return done({
                    note: midiToName(midi), pitchHz: r(a.pitchHz, 2), centsOff: r(a.centsOff), peakDb: r(a.peakDb), rmsDb: r(a.rmsDb),
                    brightnessHz: r(a.centroidHz, 0), harmonicsDb: (a.harmonicsDb ?? []).slice(0, 8).map(v => r(v)),
                    bow: a.regime, slipsPerPeriod: r(a.slipsPerPeriod, 2), stickFraction: r(a.stickFraction, 2), attackSeconds: r(a.attackSeconds, 3),
                    string: a.string,
                });
            }
            default:
                return { success: false, error: "Unknown action: " + args.action };
        }
    });

    addon.registerTool({
        name: "daw_brass",
        description: "Play and shape a physically modeled brass instrument: a track whose waveform is \"brass\" (daw_set_track_params with waveform \"brass\" makes one). The sound comes from a physical model - the player's lips, blown open by the breath, driving an air column built from a real instrument's bore (trombone, trumpet, horn or tuba), radiating through its bell - so a brass player's controls behave physically: more breath is louder and, past mezzo, much brighter as the pressure wave in the tubing steepens toward a shock (the blazing fortissimo); looser lips fall to the partial below, tighter ones pop up to the next; a player with low attack skill blooms slowly and cracks high notes. The player picks the partial and slide position or valves a player would (the horn is a double horn and uses its F side low) and tunes by ear; a note that starts before the last ends slurs into it (legato: a soft tongue; glissando: the trombone's slide is heard). A mute in the bell, the horn player's hand (hand 1 is stopped horn: brassy and buzzing) and which way the bell faces all change the air column or the sound and apply from the next note. Actions: \"info\" (current settings), \"instrument\" (trombone, trumpet, horn, tuba), \"style\" (a way of playing: chorale, section, fanfare, blazing, glissando, rough), \"params\" (breath 0-1 (0.5 is about 2.8 kPa, a comfortable mezzo; 1 is 16 kPa), lipTension -1..1, aperture 0-1, articulation tongued|legato|glissando, attackSkill 0-1, tongue s (a few ms is 'ta'), release s, vibratoRate Hz, vibratoDepth cents, vibratoDelay s, slideTime s, breathNoise 0-1, brassiness 0-4 (the laboratory: 1 is real air), mute open|straight|cup|harmon, hand 0-1 (null for the instrument's usual), bellFacing 0-1 (1 at the listener; null for usual)), and \"hear\" (plays one note offline and reports its pitch accuracy in cents, loudness, brightness, harmonic balance, how fast it spoke, the partial and slide position or valves the player used, the mouth pressure, and how steep the wavefront at the bell got - so a change can be checked without listening).",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                action: { type: "string", enum: ["info", "instrument", "style", "params", "hear"] },
                instrument: { type: "string", enum: BRASS_INSTRUMENTS.map(p => p.id), description: "For action instrument." },
                style: { type: "string", enum: BRASS_STYLES.map(s => s.id), description: "For action style." },
                params: {
                    type: "object",
                    description: "For action params. Only fields given change.",
                    properties: {
                        breath: { type: "number" }, lipTension: { type: "number" }, aperture: { type: "number" },
                        articulation: { type: "string", enum: BRASS_ARTICULATIONS.map(a => a.id) }, attackSkill: { type: "number" },
                        tongue: { type: "number" }, release: { type: "number" },
                        vibratoRate: { type: "number" }, vibratoDepth: { type: "number" }, vibratoDelay: { type: "number" },
                        slideTime: { type: "number" }, breathNoise: { type: "number" }, brassiness: { type: "number" },
                        mute: { type: "string", enum: BRASS_MUTES.map(m => m.id) },
                        hand: { type: ["number", "null"] }, bellFacing: { type: ["number", "null"] }
                    }
                },
                note: { type: "number", description: "For hear: MIDI note (default: the instrument's audition note, e.g. 58, B-flat 3, on the trombone)." }
            },
            required: ["trackId", "action"]
        }
    }, (args: any) => {
        const track = findTrack(args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        if (!isBrassTrack(track)) return { success: false, error: `${track.name} is not a brass track. Use daw_set_track_params with waveform "brass" first.` };
        const b = trackBrass(track);
        const done = (extra: Record<string, unknown> = {}) => ({ success: true, trackId: track.id, settings: describeBrass(b), ...extra });
        switch (args.action) {
            case "info":
                return done();
            case "instrument":
                if (!BRASS_INSTRUMENTS.some(p => p.id === args.instrument)) return { success: false, error: "Unknown instrument. Choose one of: " + BRASS_INSTRUMENTS.map(p => p.id).join(", ") };
                loadBrassInstrument(track, args.instrument);
                return done();
            case "style":
                if (!BRASS_STYLES.some(s => s.id === args.style)) return { success: false, error: "Unknown style. Choose one of: " + BRASS_STYLES.map(s => s.id).join(", ") };
                playBrassStyle(track, args.style);
                return done();
            case "params": {
                const p = args.params ?? {};
                const merged = repairBrass({ ...b, ...p });
                for (const k of ["breath", "lipTension", "aperture", "attackSkill", "tongue", "release", "vibratoRate", "vibratoDepth", "vibratoDelay", "slideTime", "breathNoise", "brassiness"] as const) {
                    if (typeof p[k] === "number") (b as any)[k] = merged[k];
                }
                if (typeof p.articulation === "string") b.articulation = merged.articulation;
                let rebuilt = false;
                if (typeof p.mute === "string") { b.mute = merged.mute; rebuilt = true; }
                for (const k of ["hand", "bellFacing"] as const) {
                    if (typeof p[k] === "number" || p[k] === null) { b[k] = merged[k]; rebuilt = true; }
                }
                if (rebuilt) rebuildBrass(track);
                for (const k of ["breath", "lipTension", "vibratoDepth"] as const) {
                    if (typeof p[k] === "number") setBrassLive(track, k, b[k]);
                }
                scheduleSave();
                return done();
            }
            case "hear": {
                const midi = typeof args.note === "number" ? args.note : b.auditionNote;
                const config = brassNoteConfig(track.id, b, { freq: midiToFreq(midi), velocity: 0.8, duration: 0.7 });
                const a = addon.Brass.analyzeNote(config, 0);
                if (!a.ok) return { success: false, error: a.error };
                const r = (v: number | undefined | null, d = 1) => v === undefined || v === null ? null : Math.round(v * 10 ** d) / 10 ** d;
                return done({
                    note: midiToName(midi), pitchHz: r(a.pitchHz, 2), centsOff: r(a.centsOff), peakDb: r(a.peakDb), rmsDb: r(a.rmsDb),
                    brightnessHz: r(a.centroidHz, 0), harmonicsDb: (a.harmonicsDb ?? []).slice(0, 10).map(v => r(v)),
                    partial: a.partial,
                    ...(b.instrument === "trombone" ? { slidePosition: r(a.position, 2) } : { valves: a.valves ?? [], fSide: a.fSide ?? false }),
                    mouthPressurePa: r(a.mouthPressurePa, 0),
                    waveSteepness: a.waveSteepness, attackSeconds: r(a.attackSeconds, 3),
                });
            }
            default:
                return { success: false, error: "Unknown action: " + args.action };
        }
    });

    addon.registerTool({
        name: "daw_matter",
        description: "Play and shape a physically modeled drum kit: a track whose waveform is \"matter\" (daw_set_track_params with waveform \"matter\" makes one; its rows become the kit's: 0 Kick, 1 Snare, 2 Snare edge, 3 Rack tom, 4 Floor tom, 5 Crash, 6 Ride, 7 Ride bell, 8 Splash). The sound comes from a physical model, with no samples: drumheads as stretched membranes with the air loading them and the air inside the shell coupling both heads, snare wires that are thrown off the head and land again, cymbals as bronze domes whose modes couple when they bend past their thickness (the crash's swell into a wash), and sticks, beaters and mallets meeting them through a contact solved every sample - so the controls behave physically: velocity is the stick's speed (a harder hit is brighter, and a slack tom's pitch glides down after it), a hit near the rim rings different modes from one near the centre, a felt beater is darker than plastic, looser snare wires buzz longer, and the pieces hear each other through the air (a tom or a kick sets the snare wires buzzing). Tunings rebuild the kit (heard a moment later: the old kit plays meanwhile); the mix, hands, beater and dynamics apply from the next hit. Actions: \"info\" (settings and rows), \"preset\" (studio, jazz, rock, funk, mallets), \"params\" (kick/snare/rackTom/floorTom: the heads' fundamentals in Hz (kick 35-90, snare 140-360, rack 90-260, floor 55-160); kickMuffling 0-1 (1 a pillow in the kick); snares true|false; snareTension N (0.03-1.5, 0.15 usual); sympathetic true|false; hands sticks|mallets; beater felt|plastic; dynamics m/s at full velocity (1-12)), \"mix\" ({kick, snare, rack-tom, floor-tom, crash, ride, splash}: each piece's level, 0-8), \"hear\" (strikes one row offline, alone, and reports its loudness, brightness, crack (energy above 4 kHz), strongest partial, how long it rings, the contact time and force, how fast the stick rebounded, a drum's pitch glide and the snare wires' landings - so a change can be checked without listening), and \"strike\" (plays a row live on the track's kit now).",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                action: { type: "string", enum: ["info", "preset", "params", "mix", "hear", "strike"] },
                preset: { type: "string", enum: MATTER_PRESETS.map(p => p.id), description: "For action preset." },
                params: {
                    type: "object",
                    description: "For action params. Only fields given change.",
                    properties: {
                        kick: { type: "number" }, snare: { type: "number" }, rackTom: { type: "number" }, floorTom: { type: "number" },
                        kickMuffling: { type: "number" }, snares: { type: "boolean" }, snareTension: { type: "number" },
                        sympathetic: { type: "boolean" }, hands: { type: "string", enum: ["sticks", "mallets"] },
                        beater: { type: "string", enum: ["felt", "plastic"] }, dynamics: { type: "number" }
                    }
                },
                mix: { type: "object", description: "For action mix: piece -> level.", properties: Object.fromEntries(MATTER_PIECES.map(p => [p.id, { type: "number" }])) },
                row: { type: "number", description: "For hear and strike: the kit row (0-8). Default 1, the snare." },
                velocity: { type: "number", description: "For hear and strike: 0-1 (default 0.8)." }
            },
            required: ["trackId", "action"]
        }
    }, (args: any) => {
        const track = findTrack(args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        if (!isMatterTrack(track)) return { success: false, error: `${track.name} is not a drum-kit track. Use daw_set_track_params with waveform "matter" first.` };
        const m = trackMatter(track);
        const done = (extra: Record<string, unknown> = {}) => ({ success: true, trackId: track.id, settings: describeMatter(m), ...extra });
        const rowOf = () => Math.min(MATTER_ROWS.length - 1, Math.max(0, Math.round(typeof args.row === "number" ? args.row : 1)));
        const velocityOf = () => Math.min(1, Math.max(0, typeof args.velocity === "number" ? args.velocity : 0.8));
        switch (args.action) {
            case "info":
                return done({ status: mtBuild[track.id] ?? "not built" });
            case "preset":
                if (!MATTER_PRESETS.some(p => p.id === args.preset)) return { success: false, error: "Unknown preset. Choose one of: " + MATTER_PRESETS.map(p => p.id).join(", ") };
                loadMatterPreset(track, args.preset);
                return done();
            case "params": {
                const p = args.params ?? {};
                const merged = repairMatter({ ...m, kit: { ...m.kit, ...p }, ...(typeof p.hands === "string" ? { hands: p.hands } : {}), ...(typeof p.beater === "string" ? { beater: p.beater } : {}), ...(typeof p.dynamics === "number" ? { dynamics: p.dynamics } : {}) });
                m.kit = merged.kit;
                m.hands = merged.hands;
                m.beater = merged.beater;
                m.dynamics = merged.dynamics;
                commitMatter(track);
                scheduleSave();
                return done();
            }
            case "mix": {
                const merged = repairMatter({ ...m, mix: { ...m.mix, ...(args.mix ?? {}) } });
                m.mix = merged.mix;
                scheduleSave();
                return done();
            }
            case "hear": {
                const row = rowOf();
                const a = addon.Matter.analyzeHit(matterHitConfig(track.id, m, { row, velocity: velocityOf() }), 0);
                if (!a.ok) return { success: false, error: a.error };
                const r = (v: number | undefined | null, d = 1) => v === undefined || v === null ? null : Math.round(v * 10 ** d) / 10 ** d;
                return done({
                    row, name: MATTER_ROWS[row].label, piece: a.piece, striker: a.striker, speed: r(a.speed, 2),
                    peakDb: r(a.peakDb), rmsDb: r(a.rmsDb), brightnessHz: r(a.centroidHz, 0), crackDb: r(a.above4kDb), strongestHz: r(a.strongestHz, 0),
                    decaySeconds: r(a.decaySeconds, 2), contactMs: r(a.contactMs, 2), peakForceN: r(a.peakForceN, 0), reboundSpeed: r(a.reboundSpeed, 2),
                    ...(a.glideCents !== undefined ? { glideCents: r(a.glideCents) } : {}),
                    ...(a.wireLandings !== undefined ? { wireLandings: a.wireLandings } : {}),
                });
            }
            case "strike":
                matterRowHit(track, rowOf(), velocityOf());
                return done({ row: rowOf(), status: mtBuild[track.id] ?? "building" });
            default:
                return { success: false, error: "Unknown action: " + args.action };
        }
    });

    addon.registerTool({
        name: "daw_list_vst3_plugins",
        description: "List the VST3 instrument plugins installed on this machine (name, vendor, path). Scans the standard VST3 folders on first use, which can take a couple of seconds. Use a returned name with daw_set_track_instrument.",
        parameters: { type: "object", properties: { rescan: { type: "boolean" } } }
    }, (args: any) => {
        scanVst3Plugins(args.rescan === true || vst3Catalog.length === 0);
        return { success: true, status: vst3ScanStatus, plugins: vst3Catalog.map(p => ({ name: p.name, vendor: p.vendor, path: p.path })) };
    });

    addon.registerTool({
        name: "daw_set_track_instrument",
        description: "Make a track play a hosted VST3 plugin instead of the built-in synth/drum voice, or go back to the built-in voice with plugin \"builtin\". The plugin starts on its default patch (the human picks sounds in its own editor window). Synth tracks send the row's pitch as a MIDI note; drum tracks send General MIDI drum notes (Kick 36, Snare 38, Hihat 42, Clap 39, Tom 45). Loading can block the app for a second or two.",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                plugin: { type: "string", description: "A plugin name from daw_list_vst3_plugins, or \"builtin\"." }
            },
            required: ["trackId", "plugin"]
        }
    }, (args: any) => {
        const track = project.tracks.find(t => t.id === args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        if (args.plugin === "builtin") {
            clearTrackInstrument(track);
            persist();
            return { success: true, instrument: null };
        }
        if (vst3Catalog.length === 0) scanVst3Plugins(false);
        const plugin = vst3Catalog.find(p => p.name.toLowerCase() === String(args.plugin).toLowerCase());
        if (!plugin) return { success: false, error: "No installed VST3 instrument named " + args.plugin, available: vst3Catalog.map(p => p.name) };
        const result = loadTrackInstrument(track, { path: plugin.path, name: plugin.name });
        persist();
        return result.ok
            ? { success: true, instrument: plugin.name, status: vst3Runtime[track.id].status }
            : { success: false, error: result.error };
    });

    addon.registerTool({
        name: "daw_delete_track",
        description: "Delete a DAW track by id, along with its patterns and every clip that plays them.",
        parameters: { type: "object", properties: { trackId: { type: "string" } }, required: ["trackId"] }
    }, (args: any) => {
        const before = project.tracks.length;
        const removed = project.tracks.find(t => t.id === args.trackId);
        if (removed) removeTrack(removed);
        persist();
        return { success: project.tracks.length < before };
    });

    addon.registerTool({
        name: "daw_set_notes",
        description: `Write a note/beat pattern into one of a track's patterns (its active one unless patternId is given). Provide notes either as an explicit list or as compact ASCII row patterns (or both):
- "notes": [{row, step, length, velocity}] — row/step/length are integers (length in steps, default 1), velocity is 0-1 (default 0.85).
- "rows": [{row, pattern}] — one character per step, e.g. {row: 0, pattern: "X...X...X...X..."}. Characters: '.' or '-' = empty, 'x' = medium hit (0.75), 'X' = accent (1.0), digits 1-9 = velocity n/9.
Row meaning depends on track kind (see daw_get_state): drum tracks use the rack's pads (row 0=Kick, 1=Snare, 2=Hihat, 3=Clap, 4=Tom to begin with; see the track's "rack" in daw_get_state); synth tracks use row = scale degree (0 = root note, increasing = higher pitch). Step 0 is the start of the pattern; a pattern repeats for as long as the clip that plays it lasts. A track with no clips yet gets one spanning the whole song, so the notes are audible straight away.
Default mode replaces the pattern's notes; pass mode:"add" to layer new notes onto the existing ones instead.`,
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                patternId: { type: "string", description: "Defaults to the track's active pattern." },
                mode: { type: "string", enum: ["replace", "add"] },
                notes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            row: { type: "number" },
                            step: { type: "number" },
                            length: { type: "number" },
                            velocity: { type: "number" }
                        },
                        required: ["row", "step"]
                    }
                },
                rows: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            row: { type: "number" },
                            pattern: { type: "string" }
                        },
                        required: ["row", "pattern"]
                    }
                }
            },
            required: ["trackId"]
        }
    }, (args: any) => {
        const track = project.tracks.find(t => t.id === args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        const pattern = args.patternId ? track.patterns.find(p => p.id === args.patternId) : activePattern(track);
        if (!pattern) return { success: false, error: "Pattern not found: " + args.patternId };

        const newNotes: NoteCell[] = [];

        if (Array.isArray(args.notes)) {
            for (const n of args.notes) {
                newNotes.push({
                    row: Math.max(0, Math.round(n.row) || 0),
                    step: Math.max(0, Math.round(n.step) || 0),
                    length: Math.max(1, Math.round(n.length) || 1),
                    velocity: typeof n.velocity === "number" ? Math.max(0, Math.min(1, n.velocity)) : 0.85
                });
            }
        }

        if (Array.isArray(args.rows)) {
            for (const r of args.rows) {
                const text: string = r.pattern || "";
                for (let step = 0; step < text.length; step++) {
                    const c = text[step];
                    let velocity = 0;
                    if (c === "x") velocity = 0.75;
                    else if (c === "X") velocity = 1.0;
                    else if (c >= "1" && c <= "9") velocity = parseInt(c, 10) / 9;
                    if (velocity > 0) newNotes.push({ row: Math.max(0, Math.round(r.row) || 0), step, length: 1, velocity });
                }
            }
        }

        if (args.mode === "add") {
            pattern.notes.push(...newNotes);
        } else {
            pattern.notes = newNotes;
        }

        // Notes past the end of a pattern never play; widen it to a whole number of bars so they do.
        const furthest = pattern.notes.reduce((m, n) => Math.max(m, n.step + n.length), 0);
        if (furthest > pattern.steps) {
            const bar = barSteps(project.stepsPerBeat);
            pattern.steps = Math.ceil(furthest / bar) * bar;
        }

        if (!args.patternId || args.patternId === track.activePatternId) ensureTrackHasClip(track);
        persist();
        return { success: true, trackId: track.id, patternId: pattern.id, patternSteps: pattern.steps, noteCount: pattern.notes.length };
    });

    addon.registerTool({
        name: "daw_new_pattern",
        description: "Add another pattern to a track (it becomes the track's active pattern), optionally copying an existing one. Write its notes with daw_set_notes, then place it in the arrangement with daw_place_clips.",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                name: { type: "string" },
                bars: { type: "number", description: "Pattern length in bars (0.5, 1, 2 or 4). Default 1." },
                copyFrom: { type: "string", description: "Pattern id on the same track to copy the notes from." }
            },
            required: ["trackId"]
        }
    }, (args: any) => {
        const track = project.tracks.find(t => t.id === args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        const src = args.copyFrom ? track.patterns.find(p => p.id === args.copyFrom) : undefined;
        if (args.copyFrom && !src) return { success: false, error: "Pattern not found: " + args.copyFrom };
        const bars = typeof args.bars === "number" && args.bars > 0 ? args.bars : (src ? src.steps / barSteps(project.stepsPerBeat) : 1);
        const steps = Math.max(1, Math.round(bars * barSteps(project.stepsPerBeat)));
        const pattern = addPattern(track, typeof args.name === "string" ? args.name : undefined, steps, src ? src.notes.map(n => ({ ...n })) : []);
        persist();
        return { success: true, trackId: track.id, patternId: pattern.id, name: pattern.name, steps: pattern.steps };
    });

    addon.registerTool({
        name: "daw_place_clips",
        description: "Arrange a track: place clips (a pattern looped over a span of bars) on the track's lane. Positions are in bars from the start of the song (bar 0 is the first bar). A clip that would overlap another clip on the same track is skipped and reported. mode \"replace\" clears the track's existing clips first, \"add\" (default) keeps them.",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                mode: { type: "string", enum: ["replace", "add"] },
                clips: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            patternId: { type: "string", description: "Defaults to the track's active pattern." },
                            startBar: { type: "number" },
                            bars: { type: "number" }
                        },
                        required: ["startBar", "bars"]
                    }
                }
            },
            required: ["trackId", "clips"]
        }
    }, (args: any) => {
        const track = project.tracks.find(t => t.id === args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        const bar = barSteps(project.stepsPerBeat);
        if (args.mode === "replace") project.arrangement = project.arrangement.filter(c => c.trackId !== track.id);
        const placed: string[] = [];
        const skipped: any[] = [];
        for (const spec of Array.isArray(args.clips) ? args.clips : []) {
            const patternId = spec.patternId ?? track.activePatternId;
            if (!track.patterns.some(p => p.id === patternId)) { skipped.push({ ...spec, reason: "unknown pattern" }); continue; }
            const clip = createClip(project.arrangement, {
                trackId: track.id, patternId, startStep: Math.round(spec.startBar * bar), lengthSteps: Math.max(1, Math.round(spec.bars * bar))
            }, songSteps(project), newId);
            if (clip) placed.push(clip.id); else skipped.push({ ...spec, reason: "outside the song or overlapping another clip" });
        }
        persist();
        return { success: true, placed, skipped, clipCount: clipsOfTrack(project.arrangement, track.id).length };
    });

    addon.registerTool({
        name: "daw_browse_samples",
        description: "List the audio files and folders inside a folder on this machine, so a drum pad can be given a sample with daw_set_pad_sample. With no path it lists the user's Music folder. Only the Music folder and folders the user has chosen in the DAW's sample browser can be read. Folders come first; audioCount is how many samples are directly inside one.",
        parameters: { type: "object", properties: { path: { type: "string", description: "A folder path from an earlier listing. Omit for the Music folder." } } }
    }, (args: any) => {
        const path = typeof args.path === "string" && args.path ? args.path : addon.IO.musicDir();
        if (!path) return { success: false, error: "No Music folder was found." };
        const r = listDir(path);
        return r.ok
            ? { success: true, path, entries: r.entries.map(e => ({ name: e.name, path: e.path, folder: e.isDir, sizeBytes: e.isDir ? undefined : e.size, audioCount: e.isDir ? e.audioCount : undefined, folderCount: e.isDir ? e.dirCount : undefined })) }
            : { success: false, error: r.error };
    });

    addon.registerTool({
        name: "daw_set_pad_sample",
        description: "Put a sample file on a drum pad (or take it off). Only drum tracks have pads. The file must be wav, flac, mp3, ogg or m4a; only its first 12 seconds are used. Optional settings shape how it plays: gain 0-2, semitones -12..12 (changes length too), start/end as fractions 0-1 of the sample, gate (stop when the note ends instead of playing to the end). Pass path \"\" to clear the pad back to its built-in voice. Pass name to rename the pad.",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                row: { type: "number", description: "The pad's row, from the track's rack in daw_get_state." },
                path: { type: "string", description: "Absolute path of the file, from daw_browse_samples. \"\" clears the pad." },
                name: { type: "string" },
                gain: { type: "number" },
                semitones: { type: "number" },
                start: { type: "number" },
                end: { type: "number" },
                gate: { type: "boolean" }
            },
            required: ["trackId", "row"]
        }
    }, (args: any) => {
        const track = project.tracks.find(t => t.id === args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        if (track.kind !== "drum") return { success: false, error: "Only drum tracks have pads." };
        const row = Math.round(args.row);
        const pad = padAt(track, row);
        if (!pad) return { success: false, error: `No pad at row ${row}; this rack has ${ensureRack(track).length}.` };
        if (typeof args.path === "string") {
            if (args.path === "") {
                clearSample(track, row);
            } else {
                const info = loadSampleInfo(args.path);
                if (!info) return { success: false, error: sampleMissing[args.path] ?? "could not be read" };
                assignSample(track, row, { path: args.path });
            }
        }
        if (typeof args.name === "string" && args.name) pad.name = args.name.slice(0, 24);
        editSample(pad, { gain: args.gain, semitones: args.semitones, start: args.start, end: args.end, gate: args.gate });
        persist();
        return {
            success: true, row, name: pad.name, plays: pad.sample ? "sample" : (pad.voice ? "built-in voice" : "nothing"),
            sample: pad.sample, seconds: pad.sample ? sampleInfo[pad.sample.path]?.seconds : undefined
        };
    });

    addon.registerTool({
        name: "daw_add_pad",
        description: "Add an empty pad (a new piano-roll row) to a drum track's rack, up to 16 pads. Give it a sample with daw_set_pad_sample.",
        parameters: { type: "object", properties: { trackId: { type: "string" }, name: { type: "string" } }, required: ["trackId"] }
    }, (args: any) => {
        const track = project.tracks.find(t => t.id === args.trackId);
        if (!track) return { success: false, error: "Track not found: " + args.trackId };
        if (track.kind !== "drum") return { success: false, error: "Only drum tracks have pads." };
        const pad = addPad(track);
        if (!pad) return { success: false, error: `A rack holds ${MAX_PADS} pads.` };
        if (typeof args.name === "string" && args.name) pad.name = args.name.slice(0, 24);
        persist();
        return { success: true, row: track.rack!.length - 1, name: pad.name, rows: track.rows };
    });

    addon.registerTool({
        name: "daw_set_transport",
        description: "Change BPM, song length (bars), the active pattern's length, or the transport mode, and optionally start or stop playback so the user can hear the result immediately. mode \"song\" plays the whole arrangement; \"pattern\" loops just the active track's active pattern.",
        parameters: {
            type: "object",
            properties: {
                bpm: { type: "number" },
                songBars: { type: "number", description: "Length of the arrangement in bars." },
                steps: { type: "number", description: "Length in steps of the active track's active pattern. Common values: 16, 32, 64." },
                stepsPerBeat: { type: "number" },
                mode: { type: "string", enum: ["song", "pattern"] },
                playing: { type: "boolean" }
            }
        }
    }, (args: any) => {
        if (typeof args.bpm === "number") setBpm(args.bpm);
        if (typeof args.songBars === "number") setSongBars(args.songBars);
        if (typeof args.steps === "number") {
            const t = getActiveTrack();
            if (t) activePattern(t).steps = Math.max(1, Math.round(args.steps));
        }
        if (typeof args.stepsPerBeat === "number") project.stepsPerBeat = Math.max(1, Math.round(args.stepsPerBeat));
        if (args.mode === "song" || args.mode === "pattern") { transport.mode = args.mode; transport.cursorStep = 0; }
        if (args.playing === true) play();
        else if (args.playing === false) stop();
        persist();
        const t = getActiveTrack();
        return {
            success: true, bpm: project.bpm, songBars: project.songBars, stepsPerBeat: project.stepsPerBeat,
            activePatternSteps: t ? activePattern(t).steps : null, mode: transport.mode, playing: transport.playing
        };
    });

    addon.registerTool({
        name: "daw_songs",
        description: "Manage the song library and the open song's version history. Every song saves automatically; switching songs never loses work. Actions: \"list\" (all songs, newest edit first), \"open\" (songId), \"new\" (optional name, optional template: blank|demo|neon|afterhours|lowlight), \"rename\" (songId, name), \"duplicate\" (songId), \"delete\" (songId; moves it to Recently deleted, recoverable for 30 days), \"versions\" (the open song's versions, newest first), \"save_version\" (optional name; a named version is never thinned out), \"restore_version\" (versionId; the song as it is now is kept as a version first, so this can be undone). Use \"new\" before composing something unrelated to the open song rather than overwriting it.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["list", "open", "new", "rename", "duplicate", "delete", "versions", "save_version", "restore_version"] },
                songId: { type: "string" },
                versionId: { type: "string" },
                name: { type: "string" },
                template: { type: "string", enum: SONG_TEMPLATES.map(t => t.id) }
            },
            required: ["action"]
        }
    }, (args: any) => {
        const songOut = (s: SongEntry) => ({ id: s.id, name: s.name, open: s.id === library.currentSongId, bpm: s.bpm, bars: s.bars, tracks: s.tracks, clips: s.clips, createdAt: new Date(s.createdAt).toISOString(), updatedAt: new Date(s.updatedAt).toISOString() });
        const need = (id: unknown, what: string): string => {
            if (typeof id !== "string" || !id) throw new Error(`${what} is required`);
            return id;
        };
        try {
            switch (args.action) {
                case "list":
                    return { success: true, songs: sortSongs(library.activeSongs(), "recent").map(songOut), recentlyDeleted: library.trashedSongs().map(s => ({ id: s.id, name: s.name })) };
                case "open": {
                    const id = need(args.songId, "songId");
                    if (!library.find(id) || library.find(id)!.deletedAt !== undefined) throw new Error(`no song with id ${id}`);
                    openSong(id);
                    return { success: true, song: songOut(library.current()!) };
                }
                case "new": {
                    const template = SONG_TEMPLATES.find(t => t.id === args.template) ?? SONG_TEMPLATES[0];
                    const entry = createSongFromTemplate(template, typeof args.name === "string" && cleanName(args.name) ? args.name : undefined);
                    return { success: true, song: songOut(entry) };
                }
                case "rename": {
                    const id = need(args.songId, "songId");
                    renameSong(id, need(args.name, "name"));
                    return { success: true, song: songOut(library.find(id)!) };
                }
                case "duplicate": {
                    const copy = library.duplicate(need(args.songId, "songId"), projectOfSong(args.songId));
                    return { success: true, song: songOut(copy) };
                }
                case "delete":
                    deleteSong(need(args.songId, "songId"));
                    return { success: true, openSong: library.current() ? songOut(library.current()!) : null };
                case "versions": {
                    const id = library.currentSongId;
                    return { success: true, song: currentSongName(), versions: id ? library.versions(id).map(v => ({ id: v.id, at: new Date(v.at).toISOString(), kind: v.kind, title: versionTitle(v), bpm: v.bpm, bars: v.bars, tracks: v.tracks, clips: v.clips })) : [] };
                }
                case "save_version":
                    saveVersionNow(typeof args.name === "string" ? args.name : undefined);
                    return { success: true, message: libraryToast?.text ?? "" };
                case "restore_version":
                    restoreVersion(need(args.versionId, "versionId"));
                    return { success: true, message: libraryToast?.text ?? "" };
                default:
                    throw new Error(`unknown action ${args.action}`);
            }
        } catch (e) {
            return { success: false, error: errorText(e) };
        }
    });

    addon.registerTool({
        name: "daw_export_wav",
        description: "Render the whole arrangement (all unmuted tracks, respecting solo/gain/velocity) to a WAV file. Opens a native save dialog on the host machine, so this only completes when a human picks a location - it is not silent/headless.",
        parameters: { type: "object", properties: {} }
    }, () => {
        return exportPatternToWav();
    });
});
