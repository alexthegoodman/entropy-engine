// DAW Synth Addon
// A multi-track piano roll / beat editor with a built-in polyphonic synth + drum kit,
// hooked up to the built-in chat via registerTool so beats, basslines, riffs and synth
// configs can be composed by the AI as well as by hand.

const addon = Entropy.Addon.register({
    name: "DAW",
    version: "2.0.0",
    description: "Piano Roll / Beat Editor with built-in synth + drum kit",
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

interface DrumRow {
    name: string;
    voice: string;
    freq: number;
    // General MIDI drum-map note, used when a drum track's instrument is a VST3 plugin (Maschine's
    // pads default to C1 = 36 upward, and GM kits everywhere follow the same map).
    midi: number;
}

const DRUM_ROWS: DrumRow[] = [
    { name: "Kick", voice: "kick", freq: 55, midi: 36 },
    { name: "Snare", voice: "snare", freq: 200, midi: 38 },
    { name: "Hihat", voice: "hihat", freq: 1000, midi: 42 },
    { name: "Clap", voice: "clap", freq: 200, midi: 39 },
    { name: "Tom", voice: "tom", freq: 110, midi: 45 }
];

// --- Data model ------------------------------------------------------------

interface NoteCell {
    row: number;
    step: number;
    length: number;
    velocity: number;
}

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
    rootNote: number;
    scale: string;
    rows: number;
    voice: VoiceParams;
    gain: number;
    muted: boolean;
    solo: boolean;
    notes: NoteCell[];
    // Lazily created the first time this track's bus is synced (see ensureTrackEffects) - ids
    // into the engine's shared Entropy.AudioEffect registry, one delay + one reverb per track,
    // reused by every note that plays through this track's persistent mixing bus instead of
    // each note getting its own fresh (and, for reverb, expensive) effect instance.
    delayEffectId?: string | null;
    reverbEffectId?: string | null;
}

interface DAWProject {
    bpm: number;
    steps: number;
    stepsPerBeat: number;
    tracks: Track[];
    activeTrackId: string | null;
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

function makeStarterProject(): DAWProject {
    const drumId = Entropy.generateUUID();
    const bassId = Entropy.generateUUID();

    const drums: Track = {
        id: drumId, name: "Drums", kind: "drum",
        rootNote: 60, scale: "chromatic", rows: DRUM_ROWS.length,
        voice: defaultDrumVoice(), gain: 0.55, muted: false, solo: false,
        notes: [
            { row: 0, step: 0, length: 1, velocity: 1.0 },
            { row: 0, step: 8, length: 1, velocity: 1.0 },
            { row: 1, step: 4, length: 1, velocity: 0.95 },
            { row: 1, step: 12, length: 1, velocity: 0.95 },
            { row: 2, step: 0, length: 1, velocity: 0.7 },
            { row: 2, step: 2, length: 1, velocity: 0.6 },
            { row: 2, step: 4, length: 1, velocity: 0.7 },
            { row: 2, step: 6, length: 1, velocity: 0.6 },
            { row: 2, step: 8, length: 1, velocity: 0.7 },
            { row: 2, step: 10, length: 1, velocity: 0.6 },
            { row: 2, step: 12, length: 1, velocity: 0.7 },
            { row: 2, step: 14, length: 1, velocity: 0.6 }
        ]
    };

    const bass: Track = {
        id: bassId, name: "Bass", kind: "synth",
        rootNote: 36, scale: "pentatonic_minor", rows: 10,
        voice: defaultSynthVoice("saw"), gain: 0.3, muted: false, solo: false,
        notes: [
            { row: 0, step: 0, length: 2, velocity: 0.9 },
            { row: 0, step: 4, length: 2, velocity: 0.8 },
            { row: 2, step: 8, length: 2, velocity: 0.9 },
            { row: 1, step: 12, length: 2, velocity: 0.8 }
        ]
    };

    return { bpm: 96, steps: 16, stepsPerBeat: 4, tracks: [drums, bass], activeTrackId: drumId };
}

let project: DAWProject = makeStarterProject();

function getActiveTrack(): Track | undefined {
    return project.tracks.find(t => t.id === project.activeTrackId) || project.tracks[0];
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
    addon.Vst3.unload(track.id);
    delete vst3Runtime[track.id];
    addon.Audio.removeTrackBus(track.id);
    if (track.delayEffectId) addon.AudioEffect.destroy(track.delayEffectId);
    if (track.reverbEffectId) addon.AudioEffect.destroy(track.reverbEffectId);
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
    if (track.kind === "drum") return (DRUM_ROWS[row] || DRUM_ROWS[0]).midi;
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

// --- Transport / sequencer --------------------------------------------------

const transport = {
    playing: false,
    startedAt: 0,
    lastStep: -1,
    playheadFrac: -1
};

function stepDuration(): number {
    return 60 / Math.max(1, project.bpm) / Math.max(1, project.stepsPerBeat);
}

function noteVoiceAndFreq(track: Track, row: number): { voice: string; freq: number } {
    if (track.kind === "drum") {
        const d = DRUM_ROWS[row] || DRUM_ROWS[0];
        return { voice: d.voice, freq: d.freq };
    }
    return { voice: track.voice.waveform, freq: midiToFreq(rowToMidi(row, track.rootNote, track.scale)) };
}

// Unlike the old per-note architecture, mute/solo are no longer pre-filtered here - every
// track's bus (see syncTrackBus) applies them live, every sample, so toggling either one while
// a note is already ringing takes effect immediately instead of only affecting the *next*
// trigger. Track gain is likewise applied continuously by the bus, so only the note's own
// velocity is passed through here.
function triggerStep(stepIndex: number) {
    const sd = stepDuration();

    for (const track of project.tracks) {
        for (const note of track.notes) {
            if (note.step !== stepIndex) continue;

            const { voice, freq } = noteVoiceAndFreq(track, note.row);
            const duration = Math.max(0.03, note.length * sd * 0.95);

            if (trackUsesVst3(track)) {
                playVst3Note(track, note.row, note.velocity, duration);
                continue;
            }

            addon.Audio.playNoteOnTrack(track.id, {
                freq,
                waveform: voice,
                duration,
                cutoff: track.voice.cutoff,
                resonance: track.voice.resonance,
                gain: note.velocity,
                attack: track.voice.attack,
                decay: track.voice.decay,
                sustain: track.voice.sustain,
                release: track.voice.release
            });
        }
    }
}

// --- Offline WAV export -----------------------------------------------------

let lastExportStatus: string | null = null;

function buildPatternEvents(): any[] {
    const anySolo = project.tracks.some(t => t.solo);
    const sd = stepDuration();
    const events: any[] = [];

    for (const track of project.tracks) {
        if (track.muted) continue;
        if (anySolo && !track.solo) continue;
        // The offline renderer only knows the built-in voices; a hosted plugin runs live.
        if (track.instrument) continue;

        for (const note of track.notes) {
            const { voice, freq } = noteVoiceAndFreq(track, note.row);
            const duration = Math.max(0.03, note.length * sd * 0.95);

            events.push({
                startTime: note.step * sd,
                freq,
                waveform: voice,
                duration,
                cutoff: track.voice.cutoff,
                resonance: track.voice.resonance,
                gain: track.gain * note.velocity,
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
    }

    return events;
}

function exportPatternToWav(): { success: boolean; path?: string; durationSeconds?: number; error?: string } {
    const events = buildPatternEvents();
    const result = addon.Audio.renderPatternToWav(events, `daw-pattern-${project.bpm}bpm.wav`);
    const skipped = project.tracks.filter(t => t.instrument).length;
    lastExportStatus = result.success
        ? `Exported ${result.durationSeconds.toFixed(2)}s to ${result.path}`
            + (skipped > 0 ? ` (${skipped} VST3 track${skipped === 1 ? "" : "s"} not included - plugins render live only)` : "")
        : `Export failed: ${result.error}`;
    return result;
}

function play() {
    transport.playing = true;
    transport.startedAt = Date.now() / 1000;
    transport.lastStep = -1;
}

function stop() {
    transport.playing = false;
    transport.playheadFrac = -1;
    transport.lastStep = -1;
}

// --- Grid paint interaction --------------------------------------------------

let dragMode: "add" | "erase" | null = null;
let lastCellKey: string | null = null;

function findNoteIndexAt(track: Track, row: number, step: number): number {
    return track.notes.findIndex(n => n.row === row && step >= n.step && step < n.step + n.length);
}

function applyCell(track: Track, row: number, step: number) {
    const idx = findNoteIndexAt(track, row, step);
    if (dragMode === "add") {
        if (idx === -1) {
            track.notes.push({ row, step, length: 1, velocity: 0.85 });
        }
    } else if (dragMode === "erase") {
        if (idx !== -1) track.notes.splice(idx, 1);
    }
}

function handleNoteDown(row: number, step: number) {
    const track = getActiveTrack();
    if (!track) return;
    dragMode = findNoteIndexAt(track, row, step) >= 0 ? "erase" : "add";
    lastCellKey = `${row}:${step}`;
    applyCell(track, row, step);
}

function handleNoteDrag(row: number, step: number) {
    const key = `${row}:${step}`;
    if (key === lastCellKey || !dragMode) return;
    lastCellKey = key;
    const track = getActiveTrack();
    if (!track) return;
    applyCell(track, row, step);
}

function handleNoteUp(_row: number, _step: number) {
    dragMode = null;
    lastCellKey = null;
    persist();
}

// --- UI ----------------------------------------------------------------------

function rowLabelsFor(track: Track): string[] {
    if (track.kind === "drum") {
        return DRUM_ROWS.map(d => d.name);
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
    project = saved as DAWProject;
    if (!project.tracks.some(t => t.id === project.activeTrackId)) {
        project.activeTrackId = project.tracks[0].id;
    }
}

const WAVEFORMS = ["sine", "square", "saw", "triangle", "noise"];
const SCALE_NAMES = Object.keys(SCALES);

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

    // Create the starter tracks' persistent mixing buses (and their effect instances) up front,
    // rather than waiting for the first user interaction to call persist().
    project.tracks.forEach(syncTrackBus);

    // Reload each track's plugin with the patch it was saved on. A plugin that fails to load keeps
    // its slot on the track (see loadTrackInstrument), so the failure is visible instead of silent.
    project.tracks.forEach(t => { if (t.instrument) loadTrackInstrument(t, t.instrument); });

    const renderInstrumentPanel = (tabId: string, track: Track) => {
        Entropy.UI.Widget.collapsingHeader(tabId, `🔌 ${track.name} - Instrument (VST3)`, (tid: string) => {
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
                        text: (!track.instrument ? "● " : "") + "Built-in",
                        id: "vst3_use_builtin",
                        onClick: () => { clearTrackInstrument(track); persist(); }
                    });
                    vst3Catalog.forEach(plugin => {
                        Entropy.UI.Widget.button(tid2, {
                            text: (track.instrument?.path === plugin.path ? "● " : "") + plugin.name,
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

    const renderDAWUI = (tabId: string) => {
        Entropy.UI.Widget.collapsingHeader(tabId, "🎛 Transport", (tid: string) => {
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                Entropy.UI.Widget.button(tid2, {
                    text: transport.playing ? "⏸ Stop" : "▶ Play",
                    id: "transport_toggle",
                    onClick: () => { transport.playing ? stop() : play(); }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: "⬇ Export Pattern to WAV",
                    onClick: () => { exportPatternToWav(); }
                });
            });
            if (lastExportStatus) {
                Entropy.UI.Widget.label(tid, { text: lastExportStatus });
            }
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                Entropy.UI.Widget.numericInput(tid2, {
                    label: "BPM",
                    value: project.bpm,
                    onChange: (v: string) => { project.bpm = Math.max(20, Math.min(300, parseFloat(v) || project.bpm)); persist(); }
                });
                Entropy.UI.Widget.numericInput(tid2, {
                    label: "Pattern Steps",
                    value: project.steps,
                    onChange: (v: string) => {
                        project.steps = Math.max(1, Math.round(parseFloat(v)) || project.steps);
                        persist();
                    }
                });
            });
        });

        // Mixer: one channel-strip group per track, laid out side by side like a real mixing
        // console instead of a flat vertical list of rows.
        Entropy.UI.Widget.collapsingHeader(tabId, "🎚 Mixer", (tid: string) => {
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                project.tracks.forEach(track => {
                    Entropy.UI.Widget.group(tid2, (tid3: string) => {
                        Entropy.UI.Widget.button(tid3, {
                            text: (track.id === project.activeTrackId ? "▶ " : "") + track.name,
                            id: "select_track_" + project.tracks.indexOf(track),
                            onClick: () => { project.activeTrackId = track.id; }
                        });
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
                            text: "🗑 Delete",
                            onClick: () => {
                                removeTrackBus(track);
                                project.tracks = project.tracks.filter(t => t.id !== track.id);
                                if (project.activeTrackId === track.id) {
                                    project.activeTrackId = project.tracks[0]?.id ?? null;
                                }
                                persist();
                            }
                        });
                    });
                });
            });

            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                Entropy.UI.Widget.button(tid2, {
                    text: "+ Synth Track",
                    id: "add_synth_track",
                    onClick: () => {
                        const id = Entropy.generateUUID();
                        project.tracks.push({
                            id, name: `Synth ${project.tracks.length + 1}`, kind: "synth",
                            rootNote: 60, scale: "pentatonic_minor", rows: 10,
                            voice: defaultSynthVoice("saw"), gain: 0.25, muted: false, solo: false, notes: []
                        });
                        project.activeTrackId = id;
                        persist();
                    }
                });
                Entropy.UI.Widget.button(tid2, {
                    text: "+ Drum Track",
                    id: "add_drum_track",
                    onClick: () => {
                        const id = Entropy.generateUUID();
                        project.tracks.push({
                            id, name: `Drums ${project.tracks.length + 1}`, kind: "drum",
                            rootNote: 60, scale: "chromatic", rows: DRUM_ROWS.length,
                            voice: defaultDrumVoice(), gain: 0.5, muted: false, solo: false, notes: []
                        });
                        project.activeTrackId = id;
                        persist();
                    }
                });
            });
        }, "mixer_panel", true);

        const track = getActiveTrack();
        if (!track) {
            Entropy.UI.Widget.label(tabId, { text: "Add a track to begin." });
            return;
        }

        renderInstrumentPanel(tabId, track);

        Entropy.UI.Widget.collapsingHeader(tabId, `🎹 ${track.name} — Voice`, (tid: string) => {
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
        Entropy.UI.Widget.collapsingHeader(tabId, "✨ Effects", (tid: string) => {
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
        Entropy.UI.Widget.collapsingHeader(tabId, "🔊 Preview", (tid: string) => {
            Entropy.UI.Widget.horizontal(tid, (tid2: string) => {
                const previewRows = track.kind === "drum" ? DRUM_ROWS.length : Math.min(track.rows, SCALES[track.scale]?.length || 7);
                for (let r = 0; r < previewRows; r++) {
                    const { voice, freq } = noteVoiceAndFreq(track, r);
                    const label = track.kind === "drum" ? DRUM_ROWS[r].name : midiToName(rowToMidi(r, track.rootNote, track.scale));
                    Entropy.UI.Widget.button(tid2, {
                        text: label,
                        id: "preview_row_" + r,
                        onClick: () => {
                            if (trackUsesVst3(track)) {
                                playVst3Note(track, r, 1.0, 0.5);
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

        Entropy.UI.Widget.label(tabId, { text: "Piano Roll (click/drag to paint, click a note to erase)" });

        const displayCells = track.notes.map(n => ({
            row: toDisplayRow(track, n.row),
            step: n.step,
            length: n.length,
            velocity: n.velocity
        }));

        Entropy.UI.Widget.pianoRoll(tabId, {
            id: "daw_pianoroll_" + track.id,
            rows: track.rows,
            steps: project.steps,
            stepsPerBeat: project.stepsPerBeat,
            rowLabels: rowLabelsFor(track),
            cells: displayCells,
            playhead: transport.playing ? transport.playheadFrac : -1,
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
        title: "🎹 DAW",
        onRender: async () => {
            renderDAWUI(tabId);
        }
    });

    const onFrame = () => {
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

        if (!transport.playing) return;

        const sd = stepDuration();
        const elapsed = Date.now() / 1000 - transport.startedAt;
        const totalSteps = Math.max(1, project.steps);
        const stepFloat = elapsed / sd;
        const curStep = Math.floor(stepFloat) % totalSteps;

        transport.playheadFrac = (stepFloat % totalSteps) / totalSteps;

        if (curStep !== transport.lastStep) {
            transport.lastStep = curStep;
            triggerStep(curStep);
        }
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
        name: "daw_get_state",
        description: "Get the current DAW project: BPM, pattern length (steps), and every track (id, name, kind, mute/solo, gain, voice params, scale/rootNote for synth tracks, and note count). Call this before editing so you know track ids and row semantics.",
        parameters: { type: "object", properties: {} }
    }, () => {
        return {
            bpm: project.bpm,
            steps: project.steps,
            stepsPerBeat: project.stepsPerBeat,
            playing: transport.playing,
            activeTrackId: project.activeTrackId,
            drumRowLayout: DRUM_ROWS.map((d, i) => ({ row: i, name: d.name })),
            availableScales: SCALE_NAMES,
            tracks: project.tracks.map(t => ({
                id: t.id,
                name: t.name,
                kind: t.kind,
                muted: t.muted,
                solo: t.solo,
                gain: t.gain,
                instrument: t.instrument ? { name: t.instrument.name, loaded: vst3Runtime[t.id]?.ok === true } : null,
                voice: t.voice,
                rootNote: t.kind === "synth" ? t.rootNote : undefined,
                scale: t.kind === "synth" ? t.scale : undefined,
                rows: t.rows,
                rowNotes: t.kind === "synth"
                    ? Array.from({ length: t.rows }, (_, r) => midiToName(rowToMidi(r, t.rootNote, t.scale)))
                    : DRUM_ROWS.map(d => d.name),
                noteCount: t.notes.length
            }))
        };
    });

    addon.registerTool({
        name: "daw_create_track",
        description: "Create a new DAW track. kind \"drum\" gives a 5-row kit (row 0=Kick, 1=Snare, 2=Hihat, 3=Clap, 4=Tom). kind \"synth\" gives a pitched track spanning multiple octaves of the chosen scale (row 0 = root note, increasing row = higher pitch). Returns the new track id plus its row layout so you can write patterns with daw_set_notes.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string" },
                kind: { type: "string", enum: ["synth", "drum"] },
                waveform: { type: "string", enum: WAVEFORMS, description: "Synth tracks only." },
                scale: { type: "string", enum: SCALE_NAMES, description: "Synth tracks only. Defaults to pentatonic_minor." },
                rootNote: { type: "number", description: "MIDI note number for row 0 (e.g. 60 = C4, 36 = C2 for bass). Synth tracks only." },
                octaves: { type: "number", description: "How many octaves of the scale to expose as rows. Synth tracks only, default 2." },
                gain: { type: "number", description: "0-1, default 0.25 for synth, 0.5 for drum." }
            },
            required: ["name", "kind"]
        }
    }, (args: any) => {
        const id = Entropy.generateUUID();

        if (args.kind === "drum") {
            const track: Track = {
                id, name: args.name, kind: "drum",
                rootNote: 60, scale: "chromatic", rows: DRUM_ROWS.length,
                voice: defaultDrumVoice(), gain: args.gain ?? 0.5, muted: false, solo: false, notes: []
            };
            project.tracks.push(track);
            project.activeTrackId = id;
            persist();
            return { success: true, id, kind: "drum", rows: DRUM_ROWS.length, rowLayout: DRUM_ROWS.map((d, i) => ({ row: i, name: d.name })) };
        }

        const scale = (args.scale && SCALES[args.scale]) ? args.scale : "pentatonic_minor";
        const octaves = Math.max(1, args.octaves || 2);
        const rows = SCALES[scale].length * octaves;
        const rootNote = typeof args.rootNote === "number" ? args.rootNote : 60;

        const track: Track = {
            id, name: args.name, kind: "synth",
            rootNote, scale, rows,
            voice: defaultSynthVoice(args.waveform || "saw"), gain: args.gain ?? 0.25, muted: false, solo: false, notes: []
        };
        project.tracks.push(track);
        project.activeTrackId = id;
        persist();

        return {
            success: true, id, kind: "synth", scale, rootNote, rows,
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
        description: "Delete a DAW track by id.",
        parameters: { type: "object", properties: { trackId: { type: "string" } }, required: ["trackId"] }
    }, (args: any) => {
        const before = project.tracks.length;
        const removed = project.tracks.find(t => t.id === args.trackId);
        if (removed) removeTrackBus(removed);
        project.tracks = project.tracks.filter(t => t.id !== args.trackId);
        if (project.activeTrackId === args.trackId) {
            project.activeTrackId = project.tracks[0]?.id ?? null;
        }
        persist();
        return { success: project.tracks.length < before };
    });

    addon.registerTool({
        name: "daw_set_notes",
        description: `Write a note/beat pattern into a track. Provide notes either as an explicit list or as compact ASCII row patterns (or both):
- "notes": [{row, step, length, velocity}] — row/step/length are integers (length in steps, default 1), velocity is 0-1 (default 0.85).
- "rows": [{row, pattern}] — one character per step, e.g. {row: 0, pattern: "X...X...X...X..."}. Characters: '.' or '-' = empty, 'x' = medium hit (0.75), 'X' = accent (1.0), digits 1-9 = velocity n/9.
Row meaning depends on track kind (see daw_get_state): drum tracks use row 0=Kick, 1=Snare, 2=Hihat, 3=Clap, 4=Tom; synth tracks use row = scale degree (0 = root note, increasing = higher pitch). Step 0 is the start of the pattern; the pattern repeats every "steps" from daw_get_state.
Default mode replaces the track's whole pattern; pass mode:"add" to layer new notes onto the existing ones instead.`,
        parameters: {
            type: "object",
            properties: {
                trackId: { type: "string" },
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
                const pattern: string = r.pattern || "";
                for (let step = 0; step < pattern.length; step++) {
                    const c = pattern[step];
                    let velocity = 0;
                    if (c === "x") velocity = 0.75;
                    else if (c === "X") velocity = 1.0;
                    else if (c >= "1" && c <= "9") velocity = parseInt(c, 10) / 9;
                    if (velocity > 0) newNotes.push({ row: Math.max(0, Math.round(r.row) || 0), step, length: 1, velocity });
                }
            }
        }

        if (args.mode === "add") {
            track.notes.push(...newNotes);
        } else {
            track.notes = newNotes;
        }

        persist();
        return { success: true, trackId: track.id, noteCount: track.notes.length };
    });

    addon.registerTool({
        name: "daw_set_transport",
        description: "Change BPM and/or pattern length, and optionally start or stop playback so the user can hear the current pattern immediately.",
        parameters: {
            type: "object",
            properties: {
                bpm: { type: "number" },
                steps: { type: "number", description: "Pattern length in steps. Common values: 16, 32, 64." },
                stepsPerBeat: { type: "number" },
                playing: { type: "boolean" }
            }
        }
    }, (args: any) => {
        if (typeof args.bpm === "number") project.bpm = Math.max(20, Math.min(300, args.bpm));
        if (typeof args.steps === "number") project.steps = Math.max(1, Math.round(args.steps));
        if (typeof args.stepsPerBeat === "number") project.stepsPerBeat = Math.max(1, Math.round(args.stepsPerBeat));
        if (args.playing === true) play();
        else if (args.playing === false) stop();
        persist();
        return { success: true, bpm: project.bpm, steps: project.steps, stepsPerBeat: project.stepsPerBeat, playing: transport.playing };
    });

    addon.registerTool({
        name: "daw_export_wav",
        description: "Render the current pattern (all unmuted tracks, one loop, respecting solo/gain/velocity) to a WAV file. Opens a native save dialog on the host machine, so this only completes when a human picks a location - it is not silent/headless.",
        parameters: { type: "object", properties: {} }
    }, () => {
        return exportPatternToWav();
    });
});
