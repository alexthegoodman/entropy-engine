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
}

const DRUM_ROWS: DrumRow[] = [
    { name: "Kick", voice: "kick", freq: 55 },
    { name: "Snare", voice: "snare", freq: 200 },
    { name: "Hihat", voice: "hihat", freq: 1000 },
    { name: "Clap", voice: "clap", freq: 200 },
    { name: "Tom", voice: "tom", freq: 110 }
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
}

interface Track {
    id: string;
    name: string;
    kind: "synth" | "drum";
    rootNote: number;
    scale: string;
    rows: number;
    voice: VoiceParams;
    gain: number;
    muted: boolean;
    solo: boolean;
    notes: NoteCell[];
}

interface DAWProject {
    bpm: number;
    steps: number;
    stepsPerBeat: number;
    tracks: Track[];
    activeTrackId: string | null;
}

function defaultSynthVoice(waveform = "saw"): VoiceParams {
    return { waveform, cutoff: 4000, resonance: 1.0, attack: 0.005, decay: 0.08, sustain: 0.6, release: 0.12 };
}

function defaultDrumVoice(): VoiceParams {
    return { waveform: "kick", cutoff: 1800, resonance: 1.0, attack: 0.002, decay: 0.12, sustain: 0.0, release: 0.08 };
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

function persist() {
    addon.IO.save(project);
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

function triggerStep(stepIndex: number) {
    const anySolo = project.tracks.some(t => t.solo);
    const sd = stepDuration();

    for (const track of project.tracks) {
        if (track.muted) continue;
        if (anySolo && !track.solo) continue;

        for (const note of track.notes) {
            if (note.step !== stepIndex) continue;

            const { voice, freq } = noteVoiceAndFreq(track, note.row);
            const duration = Math.max(0.03, note.length * sd * 0.95);

            addon.Audio.playNote({
                freq,
                waveform: voice,
                duration,
                cutoff: track.voice.cutoff,
                resonance: track.voice.resonance,
                gain: track.gain * note.velocity,
                attack: track.voice.attack,
                decay: track.voice.decay,
                sustain: track.voice.sustain,
                release: track.voice.release
            });
        }
    }
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

const WAVEFORMS = ["sine", "square", "saw", "triangle", "noise"];
const SCALE_NAMES = Object.keys(SCALES);

addon.onInit(async () => {
    Entropy.println("DAW Addon Initializing...");

    addon.onProjectChanged((_newProjectId: string) => {
        const saved = addon.IO.load();
        if (saved && saved.tracks) {
            project = saved as DAWProject;
        }
    });

    const renderDAWUI = (tabId: string) => {
        Entropy.UI.Widget.label(tabId, { text: "🎛 Transport", bold: true });

        Entropy.UI.Widget.horizontal(tabId, (tid: string) => {
            Entropy.UI.Widget.button(tid, {
                text: transport.playing ? "⏸ Stop" : "▶ Play",
                onClick: () => { transport.playing ? stop() : play(); }
            });
        });

        Entropy.UI.Widget.numericInput(tabId, {
            label: "BPM",
            value: project.bpm,
            onChange: (v: string) => { project.bpm = Math.max(20, Math.min(300, parseFloat(v) || project.bpm)); persist(); }
        });

        Entropy.UI.Widget.numericInput(tabId, {
            label: "Pattern Steps",
            value: project.steps,
            onChange: (v: string) => {
                project.steps = Math.max(1, Math.round(parseFloat(v)) || project.steps);
                persist();
            }
        });

        Entropy.UI.Widget.separator(tabId);
        Entropy.UI.Widget.label(tabId, { text: "🎚 Tracks", bold: true });

        project.tracks.forEach(track => {
            Entropy.UI.Widget.horizontal(tabId, (tid: string) => {
                Entropy.UI.Widget.button(tid, {
                    text: (track.id === project.activeTrackId ? "▶ " : "") + track.name,
                    onClick: () => { project.activeTrackId = track.id; }
                });
                Entropy.UI.Widget.checkbox(tid, {
                    label: "Mute",
                    value: track.muted,
                    onChange: (v: any) => { track.muted = v === true || v === "true"; persist(); }
                });
                Entropy.UI.Widget.checkbox(tid, {
                    label: "Solo",
                    value: track.solo,
                    onChange: (v: any) => { track.solo = v === true || v === "true"; persist(); }
                });
                Entropy.UI.Widget.button(tid, {
                    text: "🗑",
                    onClick: () => {
                        project.tracks = project.tracks.filter(t => t.id !== track.id);
                        if (project.activeTrackId === track.id) {
                            project.activeTrackId = project.tracks[0]?.id ?? null;
                        }
                        persist();
                    }
                });
            });
        });

        Entropy.UI.Widget.horizontal(tabId, (tid: string) => {
            Entropy.UI.Widget.button(tid, {
                text: "+ Synth Track",
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
            Entropy.UI.Widget.button(tid, {
                text: "+ Drum Track",
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

        const track = getActiveTrack();
        if (!track) {
            Entropy.UI.Widget.label(tabId, { text: "Add a track to begin." });
            return;
        }

        Entropy.UI.Widget.separator(tabId);
        Entropy.UI.Widget.label(tabId, { text: `🎹 ${track.name} — Voice`, bold: true });

        if (track.kind === "synth") {
            const wfIndex = Math.max(0, WAVEFORMS.indexOf(track.voice.waveform));
            Entropy.UI.Widget.dropdown(tabId, {
                label: "Waveform",
                options: WAVEFORMS,
                selectedIndex: wfIndex,
                onChange: (idx: string) => { track.voice.waveform = WAVEFORMS[parseInt(idx, 10)]; persist(); }
            });

            const scaleIndex = Math.max(0, SCALE_NAMES.indexOf(track.scale));
            Entropy.UI.Widget.dropdown(tabId, {
                label: "Scale",
                options: SCALE_NAMES,
                selectedIndex: scaleIndex,
                onChange: (idx: string) => { track.scale = SCALE_NAMES[parseInt(idx, 10)]; persist(); }
            });

            Entropy.UI.Widget.numericInput(tabId, {
                label: "Root Note (MIDI)",
                value: track.rootNote,
                onChange: (v: string) => { track.rootNote = parseFloat(v) || track.rootNote; persist(); }
            });

            Entropy.UI.Widget.numericInput(tabId, {
                label: "Rows (octave span)",
                value: track.rows,
                onChange: (v: string) => { track.rows = Math.max(1, Math.round(parseFloat(v)) || track.rows); persist(); }
            });
        }

        Entropy.UI.Widget.slider(tabId, {
            label: "Track Gain",
            value: track.gain, min: 0, max: 1,
            onChange: (v: string) => { track.gain = parseFloat(v); persist(); }
        });

        Entropy.UI.Widget.slider(tabId, {
            label: track.kind === "drum" ? "Tone (filter)" : "Cutoff",
            value: track.voice.cutoff, min: 100, max: 20000,
            onChange: (v: string) => { track.voice.cutoff = parseFloat(v); persist(); }
        });

        Entropy.UI.Widget.slider(tabId, {
            label: "Resonance",
            value: track.voice.resonance, min: 0.1, max: 10,
            onChange: (v: string) => { track.voice.resonance = parseFloat(v); persist(); }
        });

        Entropy.UI.Widget.slider(tabId, {
            label: "Attack",
            value: track.voice.attack, min: 0, max: 1,
            onChange: (v: string) => { track.voice.attack = parseFloat(v); persist(); }
        });
        Entropy.UI.Widget.slider(tabId, {
            label: "Decay",
            value: track.voice.decay, min: 0, max: 1,
            onChange: (v: string) => { track.voice.decay = parseFloat(v); persist(); }
        });
        Entropy.UI.Widget.slider(tabId, {
            label: "Sustain",
            value: track.voice.sustain, min: 0, max: 1,
            onChange: (v: string) => { track.voice.sustain = parseFloat(v); persist(); }
        });
        Entropy.UI.Widget.slider(tabId, {
            label: "Release",
            value: track.voice.release, min: 0, max: 2,
            onChange: (v: string) => { track.voice.release = parseFloat(v); persist(); }
        });

        Entropy.UI.Widget.label(tabId, { text: "Preview", bold: true });
        Entropy.UI.Widget.horizontal(tabId, (tid: string) => {
            const previewRows = track.kind === "drum" ? DRUM_ROWS.length : Math.min(track.rows, SCALES[track.scale]?.length || 7);
            for (let r = 0; r < previewRows; r++) {
                const { voice, freq } = noteVoiceAndFreq(track, r);
                const label = track.kind === "drum" ? DRUM_ROWS[r].name : midiToName(rowToMidi(r, track.rootNote, track.scale));
                Entropy.UI.Widget.button(tid, {
                    text: label,
                    onClick: () => {
                        addon.Audio.playNote({
                            freq, waveform: voice, duration: 0.5,
                            cutoff: track.voice.cutoff, resonance: track.voice.resonance,
                            gain: track.gain, attack: track.voice.attack, decay: track.voice.decay,
                            sustain: track.voice.sustain, release: track.voice.release
                        });
                    }
                });
            }
        });

        Entropy.UI.Widget.separator(tabId);
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
        Entropy.Composer.registerEditor("DAW", renderDAWUI);
    }

    const tabId = addon.UI.createTab({
        title: "🎹 DAW",
        onRender: async () => {
            renderDAWUI(tabId);
        }
    });

    addon.onUpdate(() => {
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
    });

    // --- Chat / AI tool integration ---

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
                release: { type: "number" }
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

        persist();
        return { success: true, track: { id: track.id, name: track.name, voice: track.voice, gain: track.gain, muted: track.muted, solo: track.solo } };
    });

    addon.registerTool({
        name: "daw_delete_track",
        description: "Delete a DAW track by id.",
        parameters: { type: "object", properties: { trackId: { type: "string" } }, required: ["trackId"] }
    }, (args: any) => {
        const before = project.tracks.length;
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
});
