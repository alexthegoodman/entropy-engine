// DAW Synth Addon
// A multi-track piano roll / beat editor with a built-in polyphonic synth + drum kit and a
// 16-channel arrangement view, hooked up to the built-in chat via registerTool so beats,
// basslines, riffs, synth configs and whole arrangements can be composed by the AI as well as
// by hand.
//
// The arrangement maths (clips, snapping, what plays on a given step, migration of older
// saves) lives in daw_arrangement.ts so it can be tested without a window; this file wires it
// to the engine and the UI.

import type { ArrClip, NoteCell, Pattern, SnapMode } from "./daw_arrangement";
import {
    activePattern,
    barSteps,
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
import type { WavetableSettings } from "./daw_wavetable";
import type { IconName, IconStyle } from "../addon";
import {
    WT_OPS,
    WT_PRESETS,
    WT_WAVEFORM,
    defaultWavetable,
    describeSettings as describeWavetable,
    noteConfig as wavetableNoteConfig,
    repairWavetable,
} from "./daw_wavetable";
import type { GuitarDiag, GuitarPrefs } from "./daw_guitar";
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

let project: DAWProject = makeStarterProject();

function getActiveTrack(): Track | undefined {
    return project.tracks.find(t => t.id === project.activeTrackId) || project.tracks[0];
}

function findTrack(id: string): Track | undefined {
    return project.tracks.find(t => t.id === id);
}

function newTrack(kind: "synth" | "drum", channel: number, name?: string): Track {
    const pattern = newPattern("Pattern 1", barSteps(project.stepsPerBeat));
    const colorIndex = project.tracks.reduce((m, t) => Math.max(m, t.colorIndex), -1) + 1;
    const base = {
        id: Entropy.generateUUID(), channel, colorIndex, muted: false, solo: false,
        patterns: [pattern], activePatternId: pattern.id
    };
    if (kind === "drum") {
        return {
            ...base, name: name ?? `Drums ${project.tracks.length + 1}`, kind: "drum",
            rootNote: 60, scale: "chromatic", rows: 5, rack: defaultRack(),
            voice: defaultDrumVoice(), gain: 0.5
        };
    }
    return {
        ...base, name: name ?? `Synth ${project.tracks.length + 1}`, kind: "synth",
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

function wavetableNote(track: Track, freq: number, velocity: number, duration: number) {
    addon.Audio.playWavetableOnTrack(track.id, wavetableNoteConfig(track.id, track.voice, trackWavetable(track), { freq, velocity, duration }));
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
    trackWavetable(track).preset = preset;
    saveTrackWavetable(track);
}

function runWavetableOp(track: Track, op: string, arg?: number) {
    trackWavetable(track);
    const r = addon.Wavetable.op(track.id, op, arg);
    wtStatus = r.ok ? "" : (r.error ?? `${op} did not work`);
    if (r.ok) saveTrackWavetable(track);
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

// Pushes one track's current gain/mute/solo/FX params into the engine's persistent bus for that
// track - creating the bus (and its two effect instances) on first call. Cheap to call on every
// edit: the DAW's sliders are click-to-set rather than continuous-drag, so this fires once per
// interaction, not once per frame.
function syncTrackBus(track: Track) {
    if (isWavetableTrack(track)) trackWavetable(track);
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
        effectIds: [track.delayEffectId!, track.reverbEffectId!]
    });
}

function removeTrackBus(track: Track) {
    releaseWavetableVoices(track);
    if (wtLoaded[track.id]) addon.Wavetable.remove(track.id);
    delete wtLoaded[track.id];
    addon.Vst3.unload(track.id);
    delete vst3Runtime[track.id];
    addon.Audio.removeTrackBus(track.id);
    if (track.delayEffectId) addon.AudioEffect.destroy(track.delayEffectId);
    if (track.reverbEffectId) addon.AudioEffect.destroy(track.reverbEffectId);
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
    ensureTrackEffects(track);
    addon.Audio.ensureTrackBus(track.id, {
        gain: track.gain, muted: track.muted, solo: track.solo,
        effectIds: [track.delayEffectId!, track.reverbEffectId!]
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
    addon.IO.save(project);
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
    if (saveDueAt && Date.now() >= saveDueAt) {
        saveDueAt = 0;
        addon.IO.save(project);
    }
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
function playPad(track: Track, row: number, velocity: number, duration: number) {
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
        cutoff: track.voice.cutoff, resonance: track.voice.resonance, gain: velocity,
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
function guitarOutput(prefs: GuitarPrefs): Record<string, unknown> {
    const track = project.tracks.find(t => t.id === prefs.targetTrackId && t.kind === "synth")
        ?? project.tracks.find(t => t.kind === "synth");
    if (!track) return {};
    if (track.instrument && vst3Runtime[track.id]?.ok) return { vst3Track: track.id, vst3Channel: 0 };
    return { trackId: track.id, waveform: prefs.waveform };
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
                if (running) addon.Guitar.target(guitarOutput(prefs));
            }
        });
        W.dropdown(tid, {
            label: "Voice", id: "guitar_waveform", options: [...GUITAR_WAVEFORMS], selectedIndex: GUITAR_WAVEFORMS.indexOf(prefs.waveform),
            onChange: (idx: string) => {
                prefs.waveform = GUITAR_WAVEFORMS[parseInt(idx, 10)] ?? "saw";
                scheduleSave();
                if (running) addon.Guitar.target(guitarOutput(prefs));
            }
        });
    });
    const outTrack = project.tracks.find(t => t.id === (guitarOutput(prefs) as any).vst3Track);
    if (outTrack) W.label(win, { text: `${outTrack.name} has a VST3 instrument, so the guitar plays that. Set its pitch-bend range to ${prefs.bendRange} semitones.` });

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
            Entropy.UI.Widget.label(g, { text: "Motion", bold: true });
            Entropy.UI.Widget.slider(g, { label: "Position", value: wt.position, min: 0, max: 1, onChange: (v: string) => { setWavetablePosition(track, parseFloat(v)); } });
            Entropy.UI.Widget.slider(g, { label: "LFO rate (Hz)", value: wt.lfoRate, min: 0, max: 20, onChange: (v: string) => { wt.lfoRate = parseFloat(v); scheduleSave(); } });
            Entropy.UI.Widget.slider(g, { label: "LFO depth", value: wt.lfoDepth, min: 0, max: 1, onChange: (v: string) => { wt.lfoDepth = parseFloat(v); scheduleSave(); } });
            Entropy.UI.Widget.slider(g, { label: "Sweep", value: wt.sweep, min: -1, max: 1, onChange: (v: string) => { wt.sweep = parseFloat(v); scheduleSave(); } });
            Entropy.UI.Widget.slider(g, { label: "Sweep time (s)", value: wt.sweepTime, min: 0.02, max: 6, onChange: (v: string) => { wt.sweepTime = parseFloat(v); scheduleSave(); } });
        });
        Entropy.UI.Widget.group(right, (g: string) => {
            Entropy.UI.Widget.label(g, { text: "Voice", bold: true });
            Entropy.UI.Widget.slider(g, { label: "Unison voices", value: wt.unison, min: 1, max: 7, onChange: (v: string) => { wt.unison = Math.round(parseFloat(v)); scheduleSave(); } });
            Entropy.UI.Widget.slider(g, { label: "Detune (cents)", value: wt.detuneCents, min: 0, max: 60, onChange: (v: string) => { wt.detuneCents = parseFloat(v); scheduleSave(); } });
            Entropy.UI.Widget.slider(g, { label: "Stereo spread", value: wt.spread, min: 0, max: 1, onChange: (v: string) => { wt.spread = parseFloat(v); scheduleSave(); } });
            Entropy.UI.Widget.slider(g, { label: "Velocity to position", value: wt.velToPosition, min: -1, max: 1, onChange: (v: string) => { wt.velToPosition = parseFloat(v); scheduleSave(); } });
            Entropy.UI.Widget.label(g, { text: "Cutoff and envelope: see Voice." });
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


// Unlike the old per-note architecture, mute/solo are no longer pre-filtered here - every
// track's bus (see syncTrackBus) applies them live, every sample, so toggling either one while
// a note is already ringing takes effect immediately instead of only affecting the *next*
// trigger. Track gain is likewise applied continuously by the bus, so only the note's own
// velocity is passed through here.
function triggerStep(absStep: number) {
    const sd = stepDuration();
    const triggers = transport.mode === "pattern"
        ? triggersAt(project, absStep, project.activeTrackId)
        : triggersAt(project, absStep % songSteps(project));

    for (const { track, note } of triggers) {
        const { voice, freq } = noteVoiceAndFreq(track as Track, note.row);
        const duration = Math.max(0.03, note.length * sd * 0.95);

        if (trackUsesVst3(track as Track)) {
            playVst3Note(track as Track, note.row, note.velocity, duration);
            continue;
        }

        const t = track as Track;
        if (t.kind === "drum") {
            playPad(t, note.row, note.velocity, duration);
            continue;
        }
        if (isWavetableTrack(t)) {
            wavetableNote(t, freq, note.velocity, duration);
            continue;
        }
        addon.Audio.playNoteOnTrack(t.id, {
            freq,
            waveform: voice,
            duration,
            cutoff: t.voice.cutoff,
            resonance: t.voice.resonance,
            gain: note.velocity,
            attack: t.voice.attack,
            decay: t.voice.decay,
            sustain: t.voice.sustain,
            release: t.voice.release
        });
    }
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
}

function stop() {
    if (transport.playing) transport.cursorStep = currentStepFloat() % transportLength();
    transport.playing = false;
}

function seekToStep(step: number) {
    const total = songSteps(project);
    transport.cursorStep = Math.max(0, Math.min(total - 0.001, step));
    if (transport.playing) {
        transport.startedAt = nowSeconds() - transport.cursorStep * stepDuration();
        transport.lastAbsStep = Math.ceil(transport.cursorStep) - 1;
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
}

// --- Offline WAV export -----------------------------------------------------

let lastExportStatus: string | null = null;

// Renders the arrangement: every clip's pattern tiled across the clip, notes cut where the clip ends.
function buildPatternEvents(): any[] {
    const sd = stepDuration();
    const events: any[] = [];

    for (const placed of expandArrangement(project, { respectMuteSolo: true })) {
        const track = placed.track as Track;
        // The offline renderer only knows the built-in voices; a hosted plugin runs live. A wavetable
        // track is rendered by buildWavetableEvents from the table as it is now.
        if (track.instrument || isWavetableTrack(track)) continue;
        const { voice, freq } = noteVoiceAndFreq(track, placed.note.row);
        // A sample pad is rendered from its file (buildSampleEvents), and an empty pad is silent.
        if (track.kind === "drum" && (padAt(track, placed.note.row)?.sample || !voice)) continue;
        const duration = Math.max(0.03, placed.lengthSteps * sd * 0.95);

        events.push({
            startTime: placed.startStep * sd,
            freq,
            waveform: voice,
            duration,
            cutoff: track.voice.cutoff,
            resonance: track.voice.resonance,
            gain: track.gain * placed.note.velocity,
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
            reverbMix: track.voice.reverbMix
        });
    }

    return events;
}

// The sample pads' hits, one per note, for the same render: the file to play and how, with the track's
// gain folded in (an offline render has no live bus to apply it).
function buildSampleEvents(): any[] {
    const sd = stepDuration();
    const events: any[] = [];
    for (const placed of expandArrangement(project, { respectMuteSolo: true })) {
        const track = placed.track as Track;
        if (track.instrument || track.kind !== "drum") continue;
        const pad = padAt(track, placed.note.row);
        if (!pad?.sample) continue;
        const hit = padHit(pad, placed.note.velocity, Math.max(0.03, placed.lengthSteps * sd * 0.95), isSampleMissing);
        if (!hit || hit.type !== "sample") continue;
        events.push({
            startTime: placed.startStep * sd, path: hit.path, gain: hit.gain * track.gain,
            semitones: hit.semitones, start: hit.start, end: hit.end, hold: hit.hold
        });
    }
    return events;
}

// The wavetable tracks' notes for the same render. The offline renderer plays the table as it is now,
// through the same voice the live path uses; the track's gain is folded in (no live bus to apply it).
function buildWavetableEvents(): any[] {
    const sd = stepDuration();
    const events: any[] = [];
    for (const placed of expandArrangement(project, { respectMuteSolo: true })) {
        const track = placed.track as Track;
        if (!isWavetableTrack(track)) continue;
        const { freq } = noteVoiceAndFreq(track, placed.note.row);
        const config = wavetableNoteConfig(track.id, track.voice, trackWavetable(track), {
            freq, velocity: placed.note.velocity,
            duration: Math.max(0.03, placed.lengthSteps * sd * 0.95),
            startTime: placed.startStep * sd,
        });
        config.gain *= track.gain;
        events.push(config);
    }
    return events;
}

function exportPatternToWav(): { success: boolean; path?: string; durationSeconds?: number; error?: string } {
    const events = buildPatternEvents();
    const sampleEvents = buildSampleEvents();
    const wavetableEvents = buildWavetableEvents();
    const result = addon.Audio.renderPatternToWav(events, `daw-song-${project.bpm}bpm.wav`, sampleEvents, wavetableEvents);
    const skipped = project.tracks.filter(t => t.instrument).length;
    const lost = Object.keys(sampleMissing).length;
    lastExportStatus = result.success
        ? `Exported ${result.durationSeconds.toFixed(2)}s to ${result.path}`
            + (skipped > 0 ? ` (${skipped} VST3 track${skipped === 1 ? "" : "s"} not included - plugins render live only)` : "")
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
    addon.IO.save(project);
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

// --- UI ----------------------------------------------------------------------

function rowLabelsFor(track: Track): string[] {
    if (track.kind === "drum") {
        return ensureRack(track).map((p, i) => p.name || `Pad ${i + 1}`);
    }
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
    if (track.kind === "drum") return row;
    return track.rows - 1 - row;
}

// Reopens the last saved project. Effect ids are per-session handles into the engine's effect
// registry, so the saved ones are meaningless now and are cleared for syncTrackBus to recreate.
// A project saved before the arrangement existed is migrated in place (see migrateProject).
function restoreSavedProject() {
    let saved: any = null;
    try {
        saved = addon.IO.load();
    } catch (e) {
        Entropy.println("DAW: could not read the saved project: " + e);
    }
    if (!saved || !Array.isArray(saved.tracks) || saved.tracks.length === 0) return;
    for (const t of saved.tracks) {
        t.delayEffectId = null;
        t.reverbEffectId = null;
    }
    const legacy = !Array.isArray(saved.arrangement);
    migrateProject(saved, newId);
    // A project from before drum racks has no `rack`: it gets the five built-in pads it always had.
    for (const t of saved.tracks) if (t.kind === "drum") ensureRack(t);
    // A wavetable track's settings are clamped, and its saved table is checked when the engine is given it.
    for (const t of saved.tracks) if (t.wavetable || t.voice?.waveform === WT_WAVEFORM) t.wavetable = repairWavetable(t.wavetable);
    project = saved as DAWProject;
    if (saved.guitar) project.guitar = readGuitarPrefs(saved.guitar);
    if (!project.tracks.some(t => t.id === project.activeTrackId)) {
        project.activeTrackId = project.tracks[0].id;
    }
    // Write the upgraded project back so the file on disk is in the new format from the first open,
    // not only after the next edit.
    if (legacy) addon.IO.save(project);
}

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

    restoreSavedProject();
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
                    notes: miniNotes(track, pattern)
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

        // Preview plays through this track's own persistent bus (ensureTrackBus/syncTrackBus),
        // so it's an honest preview of the track's actual gain/mute/solo/FX, not a bypassed
        // one-off - the tradeoff is a muted track previews silent too.
        Entropy.UI.Widget.collapsingHeader(tabId, withIcon("speaker-high", "Preview"), (tid: string) => {
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                const previewRows = track.kind === "drum" ? ensureRack(track).length : Math.min(track.rows, SCALES[track.scale]?.length || 7);
                for (let r = 0; r < previewRows; r++) {
                    const { voice, freq } = noteVoiceAndFreq(track, r);
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
                            addon.Audio.playNoteOnTrack(track.id, {
                                freq, waveform: voice, duration: 0.5,
                                cutoff: track.voice.cutoff, resonance: track.voice.resonance,
                                gain: 1.0, attack: track.voice.attack, decay: track.voice.decay,
                                sustain: track.voice.sustain, release: track.voice.release
                            });
                        }
                    });
                }
            });
        });

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

        const displayCells = pattern.notes.map(n => ({
            row: toDisplayRow(track, n.row),
            step: n.step,
            length: n.length,
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

        flushSaveIfDue();

        if (!transport.playing) return;

        const stepFloat = currentStepFloat();
        const absStep = Math.floor(stepFloat);
        const total = transportLength();
        transport.cursorStep = ((stepFloat % total) + total) % total;

        // Trigger every step that has passed since the last frame, not just the newest, so a slow
        // frame cannot swallow a note. After a long stall (a plugin loading, say) skip ahead
        // rather than fire the whole backlog at once.
        let from = transport.lastAbsStep + 1;
        if (absStep - from > 32) from = absStep;
        for (let s = from; s <= absStep; s++) triggerStep(s);
        transport.lastAbsStep = Math.max(transport.lastAbsStep, absStep);
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
                wavetable: isWavetableTrack(t) ? describeWavetable(trackWavetable(t)) : undefined,
                rootNote: t.kind === "synth" ? t.rootNote : undefined,
                scale: t.kind === "synth" ? t.scale : undefined,
                rows: t.rows,
                rowNotes: t.kind === "synth"
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
                waveform: { type: "string", enum: [...WAVEFORMS, "kick", "snare", "hihat", "clap", "tom"] },
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
        name: "daw_wavetable",
        description: "Design the sound of a wavetable synth track: a track whose waveform is \"wavetable\" (daw_set_track_params with waveform \"wavetable\" makes one). Its sound is a table of 32 frames, each one cycle of a wave; a note plays one frame's wave at its pitch and moves through the frames as it sounds, so the table is a timbre that changes over time. The human sculpts the same table in the Wavetable window as terrain (phase across, frame into the screen, level up), and every action here edits that same table. Actions: \"info\" (settings, and the harmonics of one frame), \"preset\" (start from sine, saw, square, pwm, vowels, bell, terrain or glass: saw and square brighten across the frames, vowels moves through formants), \"op\" (normalize, smooth, invert, reverse, flip_frames, randomize), \"sculpt\" (brush dabs: raise, lower, smooth or level at a frame and a phase; radius is in world units, 0.16 default, amount 0.3 is a firm dab and 1 or more saturates), \"params\" (position 0-1 across the frames, lfoRate/lfoDepth, sweep/sweepTime, velToPosition, unison 1-7, detuneCents, spread), and \"hear\" (plays one note offline and reports its loudness, strongest frequency and brightness, so you can check a change worked without listening). Position 0 is the first frame. Sculpt then \"hear\" is the way to verify an edit.",
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
                action: { type: "string", enum: ["info", "preset", "op", "sculpt", "params", "hear"] },
                preset: { type: "string", enum: WT_PRESETS.map(p => p.id), description: "For action preset." },
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
        name: "daw_export_wav",
        description: "Render the whole arrangement (all unmuted tracks, respecting solo/gain/velocity) to a WAV file. Opens a native save dialog on the host machine, so this only completes when a human picks a location - it is not silent/headless.",
        parameters: { type: "object", properties: {} }
    }, () => {
        return exportPatternToWav();
    });
});
