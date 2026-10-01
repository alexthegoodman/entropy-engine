// Guitar Tabs: learn a tab by playing it. Paste an ASCII tab, check it in a spreadsheet, then play
// along while the neck shows where the fingers go and Guitar-to-MIDI (GUITAR_TO_MIDI.md) checks
// what you play.
//
// The work is done elsewhere and tested there: tab_model.ts reads the tab and backs the review sheet,
// tab_practice.ts grades a run, entropy_gui::FretboardView (Widget.fretboard) draws the neck, and the
// guitar engine is Rust (src/guitar). This file is the glue: views, the guitar input, the synths, and
// saving. Run it with `cargo run --bin example -- guitar-tabs`.

import {
    applySheetEdit, deleteStep, emptySong, fingerStep, fretWindow, handPosition, insertStep, noteName, parseTab,
    playableSteps, polyphonyPlan, positionFor, SHEET_COLS, songToSheetCells, songToTabText, stepMidi, stepNotesText,
    TUNINGS, tuningPresetIndex, type ParseResult, type TabSong,
} from "./tab_model";
import {
    belongsTo, defaultPracticeOptions, OnsetTracker, pitchOf, PracticeSession, PRACTICE_MODES,
    type PracticeEvent, type PracticeMode, type StepResult,
} from "./tab_practice";
import { EXAMPLE_TABS } from "./tab_songs";
import { defaultGuitarPrefs, readGuitarPrefs, startConfig, type GuitarPrefs } from "../daw_guitar";
import type {
    CodeEditorConfig, FretboardConfig, FretboardHighwayItem, FretMarkConfig, GuitarInputDevice, GuitarStartConfig, IconName, SplitConfig,
} from "../../addon";

const addon = Entropy.Addon.register({
    name: "guitar-tabs",
    version: "1.0.0",
    description: "Learn guitar tabs: paste a tab, review it as a spreadsheet, then play along while Guitar-to-MIDI checks every note",
    author: ["Entropy"],
    category: "Audio Creation",
    capabilities: { ui: true, needsViewport: false },
});

type RGBA = [number, number, number, number];
const UI = {
    header: [0.07, 0.07, 0.12, 1] as RGBA,
    nav: [0.055, 0.055, 0.095, 1] as RGBA,
    line: [0.22, 0.22, 0.32, 1] as RGBA,
    dim: [0.62, 0.64, 0.74, 1] as RGBA,
    amber: [1.0, 0.78, 0.36, 1] as RGBA,
    teal: [0.28, 0.9, 0.84, 1] as RGBA,
    rose: [1.0, 0.42, 0.46, 1] as RGBA,
    card: [0.08, 0.08, 0.13, 1] as RGBA,
};
const W = Entropy.UI.Widget;
const icon = (name: IconName, text: string) => Entropy.Icons.label(name, text);

// Buses: what the guitar plays through, the guide synth, the metronome.
const GUITAR_BUS = "tabs_guitar";
const GUIDE_BUS = "tabs_guide";
const CLICK_BUS = "tabs_click";

type View = "paste" | "review" | "practice";
const VIEWS: { id: View; label: string }[] = [
    { id: "paste", label: "1  Paste" },
    { id: "review", label: "2  Review" },
    { id: "practice", label: "3  Practice" },
];
const MODE_LABELS: Record<PracticeMode, string> = { wait: "Own pace", realtime: "Real time", listen: "Listen" };

interface PracticePrefs {
    mode: PracticeMode;
    tempoPct: number;
    loop: boolean;
    lenientChords: boolean;
    guide: boolean;
    guideVolume: number;
    metronome: boolean;
    hearGuitar: boolean;
    lowOnTop: boolean;
    fromBar: number;
    toBar: number;
}

interface Saved {
    version: number;
    source: string;
    /** The source the song was last read from (edits in the sheet live in `song`). */
    songSource: string;
    song: TabSong | null;
    guitar: GuitarPrefs;
    practice: PracticePrefs;
    view: View;
}

function defaultPractice(): PracticePrefs {
    return { mode: "wait", tempoPct: 100, loop: false, lenientChords: true, guide: true, guideVolume: 0.5, metronome: false, hearGuitar: true, lowOnTop: false, fromBar: 1, toBar: 9999 };
}

// --- State ---------------------------------------------------------------------------------------

let view: View = "paste";
let source = EXAMPLE_TABS[0].text;
let parsed: ParseResult = parseTab(source);
let song: TabSong = parsed.song;
let songSource = source;
let guitarPrefs: GuitarPrefs = defaultGuitarPrefs();
let practice: PracticePrefs = defaultPractice();
let message = "Paste a tab (Ctrl+V in the box, or the button), or pick an example.";

let selected = { row: 1, col: 3 };
let editing: { row: number; col: number; value: string } | null = null;
let exampleIndex = 0;
let titleDraft = song.title;

let session: PracticeSession | null = null;
let tracker = new OnsetTracker();
let guitarDevices: GuitarInputDevice[] = [];
let guitarRunning = false;
let guitarPolyphony: "mono" | "poly" = "mono";
let diag: any = null;
let polledAt = 0;
/** Notes clicked on the neck, shown as heard for a moment, and whether they were right when played. */
let clicked: { note: number; at: number; correct: boolean }[] = [];
let flash: { at: number; miss: boolean } | null = null;
let lastWrong: { note: number; want: number[]; at: number } | null = null;
let saveDue = 0;

function reparse() {
    parsed = parseTab(source);
}

/** The song from the pasted text, unless the sheet already edited a reading of that same text. */
function songFromSource() {
    if (songSource === source && song.steps.length) return;
    reparse();
    song = parsed.song;
    songSource = source;
    titleDraft = song.title;
    selected = { row: 1, col: 3 };
    endSession();
}

function scheduleSave() {
    saveDue = Date.now() + 600;
}

function save() {
    saveDue = 0;
    const data: Saved = { version: 1, source, songSource, song, guitar: guitarPrefs, practice, view };
    addon.IO.save(data);
}

function load() {
    let saved: any = null;
    try { saved = addon.IO.load(); } catch (e) { Entropy.println("Guitar Tabs: could not read saved state: " + e); }
    if (!saved || typeof saved !== "object") return;
    if (typeof saved.source === "string") source = saved.source;
    reparse();
    if (saved.song && Array.isArray(saved.song.steps) && Array.isArray(saved.song.tuning) && saved.song.tuning.length === 6) {
        song = { ...emptySong(), ...saved.song };
        songSource = typeof saved.songSource === "string" ? saved.songSource : source;
    } else {
        song = parsed.song;
        songSource = source;
    }
    titleDraft = song.title;
    guitarPrefs = readGuitarPrefs(saved.guitar);
    practice = { ...defaultPractice(), ...(saved.practice ?? {}) };
    if (!PRACTICE_MODES.includes(practice.mode)) practice.mode = "wait";
    if (saved.view === "review" || saved.view === "practice" || saved.view === "paste") view = saved.view;
    message = `Welcome back: "${song.title}", ${song.steps.length} steps.`;
}

// --- Sound ---------------------------------------------------------------------------------------

function ensureBuses() {
    addon.Audio.ensureTrackBus(GUITAR_BUS, { gain: 0.8 });
    addon.Audio.ensureTrackBus(GUIDE_BUS, { gain: Math.max(0, Math.min(1, practice.guideVolume)) });
    addon.Audio.ensureTrackBus(CLICK_BUS, { gain: 0.45 });
}

const freqOf = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** The guide: a soft plucked synth, one voice per note of the step. */
function playNotes(notes: number[], seconds: number, velocity = 0.8) {
    notes.forEach((n, i) => {
        addon.Audio.playNoteOnTrack(GUIDE_BUS, {
            freq: freqOf(n), waveform: "saw", duration: Math.max(0.12, seconds), gain: velocity * (notes.length > 1 ? 0.55 : 0.8),
            cutoff: 1800 + 200 * i, resonance: 0.6, attack: 0.004, decay: 0.35, sustain: 0.35, release: 0.3,
            filterEnv: 1.6, filterDecay: 0.18, drive: 1.1,
        });
    });
}

function playStep(i: number) {
    const step = song.steps[i];
    if (!step) return;
    const msPerBeat = session?.msPerBeat ?? 60000 / song.bpm;
    playNotes(stepMidi(song, step), Math.min(2.5, (step.beats * msPerBeat) / 1000 * 0.95));
}

function click(accent: boolean) {
    addon.Audio.playNoteOnTrack(CLICK_BUS, { freq: accent ? 1760 : 1175, waveform: "sine", duration: 0.035, gain: accent ? 0.9 : 0.6, attack: 0.001, decay: 0.03, sustain: 0, release: 0.02 });
}

// --- The guitar ----------------------------------------------------------------------------------

function refreshDevices() {
    guitarDevices = addon.Guitar.listInputs().devices;
}

function guitarOutput(): Record<string, unknown> {
    return practice.hearGuitar ? { trackId: GUITAR_BUS, waveform: guitarPrefs.waveform === "wavetable" ? "saw" : guitarPrefs.waveform } : {};
}

function startGuitar() {
    ensureBuses();
    const r = addon.Guitar.start({ ...startConfig(guitarPrefs), ...guitarOutput(), polyphony: desiredPolyphony(Date.now()) } as GuitarStartConfig);
    if (!r.ok) {
        message = r.error ?? "The guitar input would not start.";
        guitarRunning = false;
        return;
    }
    guitarRunning = true;
    guitarPolyphony = desiredPolyphony(Date.now());
    tracker.reset();
    const o = r.opened!;
    message = `Listening on ${o.device} (${o.host}) at ${o.sampleRate} Hz.` + (o.notes.length ? " " + o.notes.join(" ") : "");
}

function stopGuitar() {
    addon.Guitar.stop();
    guitarRunning = false;
    diag = null;
    message = "Guitar input stopped.";
}

function pushGuitarSettings(patch: Record<string, unknown>) {
    scheduleSave();
    if (guitarRunning) {
        const r = addon.Guitar.set(patch as any);
        if (!r.ok) message = r.error ?? "Could not change that setting.";
    }
}

/** The detector mode the song wants now: the current step's, or in a timed run the step about to
 * come (switching releases what sounds, so it happens just before, not on, the next note). */
function desiredPolyphony(now: number): "mono" | "poly" {
    const plan = polyphonyPlan(song);
    let step = currentStep(now);
    if (session && session.options.mode !== "wait" && session.running) {
        const next = session.upcoming(now, 1)[0];
        const t = next !== undefined ? session.stepTimeMs(next) : null;
        if (next !== undefined && t !== null && t - session.songTimeMs(now) < 120) step = next;
    }
    return (plan[step] ?? "pick") === "chord" ? "poly" : "mono";
}

function pollGuitar(now: number) {
    if (!guitarRunning) return;
    const busy = !!session?.running;
    if (!busy && now - polledAt < 80) return;
    polledAt = now;
    const st = addon.Guitar.status() as any;
    if (!st.running) {
        guitarRunning = false;
        message = st.deviceLost ? "The input device went away. Plug it back in and press Start input." : "The guitar input stopped.";
        return;
    }
    diag = st.diagnostics ?? null;
    const fin = st.calibration?.finished;
    if (fin === "room") { guitarPrefs.gateOpenDb = st.settings.gateOpenDb; guitarPrefs.gateCloseDb = st.settings.gateCloseDb; message = `Room measured: the gate opens at ${st.settings.gateOpenDb.toFixed(1)} dBFS.`; scheduleSave(); }
    else if (fin === "playing") { guitarPrefs.velocityFloorDb = st.settings.velocityFloorDb; guitarPrefs.velocityCeilDb = st.settings.velocityCeilDb; message = "Playing measured: velocity range set."; scheduleSave(); }
    else if (fin === "failed") message = "Calibration heard nothing usable. Try again.";
    if (!diag) return;

    // Keep the detector in the mode this part of the song wants.
    const want = desiredPolyphony(now);
    if (want !== guitarPolyphony) {
        const r = addon.Guitar.set({ polyphony: want });
        if (r.ok) { guitarPolyphony = want; tracker.reset(); }
    }
    const pitch = guitarPolyphony === "mono" ? pitchOf(diag.freqHz, guitarPrefs.referencePitch) : null;
    const fresh = tracker.update(diag.notesSounding ?? [], diag.notes ?? 0, pitch);
    if (fresh.length && session?.running) handleEvents(session.play(fresh, now, diag.pipelineLatencyMs ?? 0), now);
}

// --- Practice ------------------------------------------------------------------------------------

function barRange(): [number, number] {
    const steps = song.steps;
    if (!steps.length) return [0, 0];
    const from = steps.findIndex(s => s.bar >= practice.fromBar);
    let to = -1;
    steps.forEach((s, i) => { if (s.bar <= practice.toBar) to = i; });
    return [Math.max(0, from), Math.max(0, to)];
}

function newSession(): PracticeSession {
    const [from, to] = barRange();
    return new PracticeSession(song, {
        ...defaultPracticeOptions(song),
        mode: practice.mode, tempoPct: practice.tempoPct, loop: practice.loop, lenientChords: practice.lenientChords,
        fromStep: from, toStep: to,
    });
}

function startSession(now: number) {
    ensureBuses();
    session = newSession();
    if (session.order.length === 0) {
        message = "Nothing to play in those bars.";
        session = null;
        return;
    }
    tracker.reset();
    session.start(now);
    flash = null;
    message = practice.mode === "wait"
        ? "Play the highlighted notes. The cursor waits for you."
        : practice.mode === "realtime" ? "Count-in, then play along in time." : "Listen: the song plays itself.";
}

function endSession() {
    session = null;
    flash = null;
}

function togglePlay(now: number) {
    if (!session || session.finished) startSession(now);
    else if (session.paused) session.resume(now);
    else session.pause(now);
}

function handleEvents(events: PracticeEvent[], now: number) {
    for (const e of events) {
        if (e.type === "hit") flash = { at: now, miss: false };
        else if (e.type === "miss") flash = { at: now, miss: true };
        else if (e.type === "wrong") lastWrong = { note: e.note, want: session?.expected(e.step) ?? [], at: now };
        else if (e.type === "due") {
            if (practice.guide || practice.mode === "listen") playStep(e.step);
        } else if (e.type === "beat") {
            if (e.countIn || practice.metronome) click(e.countIn ? e.beat === -session!.options.countIn : Math.round(e.beat) % 4 === 0);
        } else if (e.type === "loop") message = `Again from the top (run ${session!.loops + 1}).`;
        else if (e.type === "finished") {
            const st = session!.stats();
            message = `Done: ${st.accuracy}% accuracy, ${st.hits} hit, ${st.partials} partly, ${st.misses} missed, ${st.wrong} wrong notes, best streak ${st.bestStreak}.`;
        }
    }
}

/** A click on the neck: sounds the note and counts as playing it. */
function pick(string: number, fret: number, now: number) {
    const note = song.tuning[string] + fret;
    ensureBuses();
    playNotes([note], 0.6);
    let correct = true;
    if (view === "practice") {
        if (!session || session.finished) startSession(now);
        if (session?.running) {
            const events = session.play([note], now, 0);
            correct = !events.some(e => e.type === "wrong");
            handleEvents(events, now);
        }
    }
    clicked.push({ note, at: now, correct });
}

function currentStep(now: number): number {
    if (view === "practice" && session) {
        const s = session.currentStep(now);
        if (s >= 0) return s;
    }
    if (view === "review") return Math.max(0, Math.min(song.steps.length - 1, selected.row - 1));
    const [from] = barRange();
    return playableSteps(song).find(i => i >= from) ?? 0;
}

// --- The neck ------------------------------------------------------------------------------------

/** Cumulative beats to each step. */
function beatPositions(): number[] {
    const out: number[] = [];
    let b = 0;
    for (const s of song.steps) { out.push(b); b += s.beats; }
    return out;
}

function highwayState(i: number, cur: number): "waiting" | "current" | "hit" | "partial" | "miss" {
    const r: StepResult = session?.results[i] ?? "pending";
    if (r !== "pending") return r;
    return i === cur ? "current" : "waiting";
}

function fretboardConfig(now: number, forPractice: boolean): FretboardConfig {
    const cur = currentStep(now);
    const step = song.steps[cur];
    const [first, last] = fretWindow(song);
    const expected = step ? stepMidi(song, step) : [];
    const targets = step ? fingerStep(song, cur).map(n => ({ string: n.string, fret: n.fret, finger: n.finger || undefined })) : [];
    const upcoming: FretMarkConfig[] = [];
    const nextSteps = session && forPractice ? session.upcoming(now, 3) : playableSteps(song).filter(i => i > cur).slice(0, 3);
    nextSteps.forEach((i, k) => {
        for (const n of song.steps[i].notes) {
            if (targets.some(t => t.string === n.string && t.fret === n.fret)) continue;
            if (upcoming.some(u => u.string === n.string && u.fret === n.fret)) continue;
            upcoming.push({ string: n.string, fret: n.fret, ahead: k + 1 });
        }
    });

    // Heard: the guitar's sounding notes, and recent clicks, placed where the hand is.
    // A sounding note is judged against the step now; a click was judged when it was made (the
    // cursor may have moved on since).
    clicked = clicked.filter(c => now - c.at < 450);
    const judged = new Map<number, boolean>();
    for (const note of forPractice ? (diag?.notesSounding ?? []) as number[] : []) judged.set(note, belongsTo(expected, note, practice.lenientChords));
    for (const c of clicked) judged.set(c.note, c.correct);
    const hand = handPosition(song, cur);
    const heard: FretMarkConfig[] = [];
    for (const [note, correct] of judged) {
        const target = step?.notes.find(n => song.tuning[n.string] + n.fret === note);
        const pos = target ? { string: target.string, fret: target.fret } : positionFor(note, song.tuning, hand);
        if (pos) heard.push({ ...pos, correct });
    }

    // The highway: steps around now, in beats.
    const beats = beatPositions();
    let nowBeat = beats[cur] ?? 0;
    if (session && forPractice && session.options.mode !== "wait") {
        nowBeat = (beats[session.order[0]] ?? 0) + session.songTimeMs(now) / session.msPerBeat;
    }
    const span = practice.mode === "wait" ? 10 : 8;
    const highway: FretboardHighwayItem[] = [];
    const bars: number[] = [];
    const plan = polyphonyPlan(song);
    song.steps.forEach((s, i) => {
        const ahead = beats[i] - nowBeat;
        if (ahead < -4 || ahead > span + 1) return;
        if (i > 0 && s.bar !== song.steps[i - 1].bar) bars.push(ahead - 0.25);
        if (!s.notes.length) return;
        const label = s.notes.length > 1 && (i === 0 || plan[i - 1] !== plan[i] || stepMidi(song, s).join() !== stepMidi(song, song.steps[i - 1]).join()) ? chordName(stepMidi(song, s)) : undefined;
        highway.push({ ahead, notes: s.notes.map(n => ({ string: n.string, fret: n.fret })), muted: s.muted, state: highwayState(i, cur), label });
    });

    const order = session?.order ?? playableSteps(song);
    const k = order.indexOf(cur);
    const caption = step
        ? `${song.title}  -  bar ${step.bar}  -  step ${k >= 0 ? k + 1 : cur + 1} of ${order.length}  -  ${stepNotesText(song, step)}${step.notes.length > 1 ? `  (${chordName(expected)})` : ""}`
        : song.title;
    let status = "";
    if (session && forPractice) {
        const st = session.stats();
        status = `${MODE_LABELS[session.options.mode]}   accuracy ${st.accuracy}%   streak ${st.streak}`;
        if (session.options.mode === "realtime" && session.songTimeMs(now) < 0) status = `count-in ${Math.ceil(-session.songTimeMs(now) / session.msPerBeat)}   ` + status;
    } else if (forPractice) status = "press Start, or play the first note";
    const f = flash ? Math.max(0, 1 - (now - flash.at) / 550) : 0;
    return {
        id: forPractice ? "tabs_neck" : "tabs_preview",
        height: forPractice ? 470 : 250,
        tuning: song.tuning, firstFret: first, lastFret: last,
        targets, upcoming, heard, muted: step?.muted ?? [],
        showHighway: forPractice, highway, highwayBars: bars, highwaySpan: span,
        caption, status, flash: f, flashKind: flash?.miss ? "miss" : "hit",
        lowOnTop: practice.lowOnTop,
        onPick: (s: number, fr: number) => pick(s, fr, Date.now()),
    };
}

/** A short chord name for a set of notes: root from the bass, quality from the intervals. */
function chordName(notes: number[]): string {
    if (notes.length < 2) return notes.length ? noteName(notes[0]) : "";
    const bass = notes[0] % 12;
    const pcs = new Set(notes.map(n => (((n - bass) % 12) + 12) % 12));
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const root = names[bass];
    if (pcs.has(4) && pcs.has(7)) return pcs.has(10) ? `${root}7` : pcs.has(11) ? `${root}maj7` : root;
    if (pcs.has(3) && pcs.has(7)) return pcs.has(10) ? `${root}m7` : `${root}m`;
    if (pcs.size === 2 && pcs.has(7)) return `${root}5`;
    // An inversion: try each note as the root.
    for (const n of notes) {
        const r = n % 12;
        const rel = new Set(notes.map(x => (((x - r) % 12) + 12) % 12));
        if (rel.has(4) && rel.has(7) && rel.size === 3) return `${names[r]}/${root}`;
        if (rel.has(3) && rel.has(7) && rel.size === 3) return `${names[r]}m/${root}`;
    }
    return notes.map(noteName).join(" ");
}

// --- Views ---------------------------------------------------------------------------------------

function renderHeader(tab: string) {
    W.bar(tab, { id: "tabs_header", height: 50, fill: UI.header, border: UI.line, paddingX: 12 },
        (left: string) => {
            W.label(left, { text: icon("guitar", "Guitar Tabs"), bold: true, fontSize: 16 });
            W.label(left, { text: song.title, color: UI.dim, fontSize: 13 });
        },
        (center: string) => {
            W.tabBar(center, {
                id: "tabs_view", stretch: false, tabs: VIEWS, selected: view,
                onSelect: (id: string) => goTo(id as View),
            });
        },
        (right: string) => {
            const on = guitarRunning;
            W.label(right, { text: on ? icon("microphone", "guitar listening") : "guitar off", color: on ? UI.teal : UI.dim, fontSize: 12 });
        });
}

function goTo(next: View) {
    if (next !== "paste") songFromSource();
    if (next === "practice" && guitarDevices.length === 0) refreshDevices();
    if (next !== "practice" && session) session.pause(Date.now());
    view = next;
    scheduleSave();
}

function renderStatus(tab: string) {
    W.bar(tab, { id: "tabs_status", height: 28, fill: UI.nav, border: UI.line, borderTop: true, paddingX: 12 },
        (left: string) => { W.label(left, { text: message, color: UI.dim, fontSize: 12 }); });
}

function renderPaste(tab: string) {
    W.label(tab, { text: "Paste a guitar tab: six lines per system, highest string on top (e|---0---|). Two-digit frets, bar lines, x for a muted string and h p b / \\ ~ after a fret are understood. A line like \"Tuning: D A D G B E\" or \"Tempo: 90\" is read too, and \"let ring\" over a system plays it in chord mode.", wrap: true, color: UI.dim });
    W.horizontal(tab, (row: string) => {
        W.button(row, {
            id: "tabs_paste", text: icon("clipboard-text", "Paste from clipboard"), onClick: () => {
                const text = Entropy.Clipboard.readText();
                if (!text.trim()) { message = "The clipboard has no text in it."; return; }
                source = text;
                reparse();
                message = parsed.song.steps.length ? `Read ${parsed.song.steps.length} steps from the clipboard.` : "That doesn't look like a tab.";
                scheduleSave();
            },
        });
        W.dropdown(row, {
            id: "tabs_example", label: "Example", options: EXAMPLE_TABS.map(e => e.label), selectedIndex: exampleIndex,
            onChange: (idx: string) => {
                exampleIndex = Number(idx);
                source = EXAMPLE_TABS[exampleIndex].text;
                reparse();
                message = `Loaded the example "${EXAMPLE_TABS[exampleIndex].label}".`;
                scheduleSave();
            },
        });
        W.button(row, { id: "tabs_clear", text: "Clear", onClick: () => { source = ""; reparse(); scheduleSave(); } });
        W.button(row, {
            id: "tabs_to_review", text: icon("arrow-right", "Review"), disabled: parsed.song.steps.length === 0,
            onClick: () => goTo("review"),
        });
    });
    const s = parsed.song;
    const summary = s.steps.length
        ? `"${s.title}": ${s.steps.length} steps in ${parsed.bars} bar${parsed.bars === 1 ? "" : "s"} over ${parsed.systems} system${parsed.systems === 1 ? "" : "s"}, tuned ${s.tuning.map(noteName).join(" ")}, ${s.bpm} BPM.`
        : "No steps yet.";
    W.label(tab, { text: summary, color: s.steps.length ? UI.teal : UI.dim });
    for (const w of parsed.warnings) W.label(tab, { text: w, color: UI.rose, wrap: true });
    W.codeEditor(tab, {
        id: "tabs_source", label: "Tab text", content: source, language: "text",
        onChange: (text: string) => { source = text; reparse(); scheduleSave(); },
    } as CodeEditorConfig & { id: string });
}

function renderReview(tab: string) {
    W.horizontal(tab, (row: string) => {
        W.textInput(row, {
            id: "tabs_title", label: "Title", value: titleDraft, width: 260,
            onChange: (v: string) => { titleDraft = v; song.title = v.trim() || "Untitled tab"; scheduleSave(); },
        });
        const t = tuningPresetIndex(song.tuning);
        const options = [...TUNINGS.map(x => x.label), ...(t < 0 ? [`Custom (${song.tuning.map(noteName).join(" ")})`] : [])];
        W.dropdown(row, {
            id: "tabs_tuning", label: "Tuning", options, selectedIndex: t < 0 ? options.length - 1 : t,
            onChange: (idx: string) => { const p = TUNINGS[Number(idx)]; if (p) { song.tuning = [...p.tuning]; endSession(); scheduleSave(); } },
        });
        W.numericInput(row, {
            id: "tabs_bpm", label: "BPM", value: song.bpm, min: 20, max: 300, speed: 0.5, decimals: 0,
            onChange: (v: string) => { const n = Math.round(Number(v)); if (n >= 20 && n <= 300) { song.bpm = n; endSession(); scheduleSave(); } },
        });
        W.button(row, {
            id: "tabs_copy", text: icon("clipboard-text", "Copy as tab"), tooltip: "The song, edits included, as ASCII tab on the clipboard",
            onClick: () => { message = Entropy.Clipboard.writeText(songToTabText(song)) ? "Copied the tab to the clipboard." : "Could not reach the clipboard."; },
        });
        W.button(row, { id: "tabs_to_practice", text: icon("guitar", "Practice"), disabled: playableSteps(song).length === 0, onClick: () => goTo("practice") });
    });
    W.label(tab, { text: "Each row is one step. Double-click a cell (or select it and type) to change it: a string takes a fret (7), a fret and technique (5h), x for muted, or nothing. Beats is the length; Play as picks the detector (auto, pick for single notes with bends, chord for strings ringing together). Type in the empty row below the last to add a step; right-click a row number to insert or delete one.", wrap: true, color: UI.dim, fontSize: 12 });

    const cells = songToSheetCells(song);
    W.sheetGrid(tab, {
        id: "tabs_sheet",
        cells,
        selected,
        editing: editing ?? undefined,
        options: { rows: song.steps.length + 2, cols: SHEET_COLS, colWidth: 92, maxHeight: 330 },
        onCellSelected: (row: number, col: number) => { selected = { row, col }; },
        onCellClear: (row: number, col: number) => commitCell(row, col, ""),
        onEditStarted: (row: number, col: number, initial: string) => {
            const current = cells.find(c => c.row === row && c.col === col)?.text ?? "";
            editing = { row, col, value: initial.length ? initial : current.replace(/^auto \(.*\)$/, "auto") };
        },
        onEditChanged: (row: number, col: number, text: string) => { editing = { row, col, value: text }; },
        onEditCommitted: (row: number, col: number) => {
            if (editing && editing.row === row && editing.col === col) commitCell(row, col, editing.value);
            editing = null;
        },
        onEditCancelled: () => { editing = null; },
        onInsertRow: (row: number) => { if (row >= 1) { insertStep(song, row - 1); endSession(); scheduleSave(); } },
        onDeleteRow: (row: number) => { if (row >= 1) { deleteStep(song, row - 1); endSession(); scheduleSave(); } },
    });

    const i = Math.max(0, Math.min(song.steps.length - 1, selected.row - 1));
    const step = song.steps[i];
    W.horizontal(tab, (row: string) => {
        W.label(row, { text: step ? `Step ${i + 1}: ${stepNotesText(song, step) || "nothing"}  (${polyphonyPlan(song)[i] === "chord" ? "chord mode" : "pick mode"})` : "No steps.", bold: true });
        W.button(row, { id: "tabs_hear_step", text: icon("speaker-high", "Hear it"), disabled: !step?.notes.length, onClick: () => { ensureBuses(); playStep(i); } });
        W.button(row, {
            id: "tabs_practice_from", text: icon("play", "Practice from this bar"), disabled: !step,
            onClick: () => { practice.fromBar = step.bar; practice.toBar = 9999; goTo("practice"); },
        });
    });
    W.fretboard(tab, fretboardConfig(Date.now(), false));
}

function commitCell(row: number, col: number, value: string) {
    const r = applySheetEdit(song, row, col, value);
    if (!r.ok) { message = r.error ?? "That edit was not taken."; return; }
    endSession();
    scheduleSave();
}

function renderPractice(tab: string) {
    const now = Date.now();
    const running = !!session?.running;
    W.horizontal(tab, (row: string) => {
        W.segmented(row, {
            id: "tabs_mode", options: PRACTICE_MODES.map(m => MODE_LABELS[m]), selectedIndex: PRACTICE_MODES.indexOf(practice.mode), accent: UI.amber,
            onChange: (idx: string) => { practice.mode = PRACTICE_MODES[Number(idx)]; endSession(); scheduleSave(); },
        });
        const label = !session || session.finished ? icon("play", "Start") : session.paused ? icon("play", "Resume") : icon("pause", "Pause");
        W.button(row, { id: "tabs_play", text: label, shortcut: "Space", onClick: () => togglePlay(Date.now()) });
        W.button(row, { id: "tabs_restart", text: icon("arrow-counter-clockwise", "Restart"), onClick: () => startSession(Date.now()) });
        if (practice.mode === "wait") {
            W.button(row, { id: "tabs_skip", text: icon("skip-forward", "Skip"), disabled: !running, onClick: () => { if (session) handleEvents(session.skip(Date.now()), Date.now()); } });
        }
        W.button(row, { id: "tabs_hear", text: icon("ear", "Hear it"), shortcut: "H", onClick: () => { ensureBuses(); playStep(currentStep(Date.now())); } });
        W.slider(row, {
            id: "tabs_tempo", label: `Tempo ${Math.round(song.bpm * practice.tempoPct / 100)} BPM (%)`, value: practice.tempoPct, min: 25, max: 150,
            onChange: (v: string) => { practice.tempoPct = Math.round(Number(v)); if (session && !session.running) endSession(); scheduleSave(); },
        });
    });
    W.horizontal(tab, (row: string) => {
        const maxBar = song.steps.length ? song.steps[song.steps.length - 1].bar : 1;
        W.numericInput(row, { id: "tabs_from_bar", label: "From bar", value: Math.min(practice.fromBar, maxBar), min: 1, max: maxBar, speed: 0.1, decimals: 0, onChange: (v: string) => { practice.fromBar = Math.max(1, Math.round(Number(v))); endSession(); scheduleSave(); } });
        W.numericInput(row, { id: "tabs_to_bar", label: "to", value: Math.min(practice.toBar, maxBar), min: 1, max: maxBar, speed: 0.1, decimals: 0, onChange: (v: string) => { practice.toBar = Math.max(1, Math.round(Number(v))); endSession(); scheduleSave(); } });
        W.checkbox(row, { id: "tabs_loop", label: "Loop", value: practice.loop, onChange: (v: boolean) => { practice.loop = v; endSession(); scheduleSave(); } });
        W.checkbox(row, { id: "tabs_guide", label: "Guide synth", value: practice.guide, tooltip: "Plays each step as it comes, in Real time", onChange: (v: boolean) => { practice.guide = v; scheduleSave(); } });
        W.slider(row, { id: "tabs_guide_volume", label: "Guide volume", value: practice.guideVolume, min: 0, max: 1, onChange: (v: string) => { practice.guideVolume = Number(v); ensureBuses(); scheduleSave(); } });
        W.checkbox(row, { id: "tabs_metronome", label: "Metronome", value: practice.metronome, onChange: (v: boolean) => { practice.metronome = v; scheduleSave(); } });
        W.checkbox(row, { id: "tabs_lenient", label: "Lenient chords", value: practice.lenientChords, tooltip: "A chord counts when its bass note and every pitch class are heard; octave doublings are optional", onChange: (v: boolean) => { practice.lenientChords = v; endSession(); scheduleSave(); } });
        W.checkbox(row, { id: "tabs_low_on_top", label: "Low string on top", value: practice.lowOnTop, onChange: (v: boolean) => { practice.lowOnTop = v; scheduleSave(); } });
    });

    W.fretboard(tab, fretboardConfig(now, true));

    if (session) {
        const st = session.stats();
        const timing = st.meanOffsetMs !== null ? `   timing +-${st.meanOffsetMs} ms` : "";
        W.label(tab, {
            text: `Hit ${st.hits}   partly ${st.partials}   missed ${st.misses}   wrong notes ${st.wrong}   streak ${st.streak} (best ${st.bestStreak})   accuracy ${st.accuracy}%${timing}`,
            monospace: true, color: UI.amber,
        });
    }
    if (lastWrong && now - lastWrong.at < 2500) {
        W.label(tab, { text: `Heard ${noteName(lastWrong.note)}, the step wants ${lastWrong.want.map(noteName).join(" ")}.`, color: UI.rose });
    }

    // The guitar input.
    W.card(tab, { id: "tabs_guitar_card", fill: UI.card, padding: 10 }, (card: string) => {
        W.horizontal(card, (row: string) => {
            const options = ["Default input", ...guitarDevices.map(d => `${d.name}  [${d.host}, ${d.channels} ch]`)];
            let idx = 0;
            if (guitarPrefs.device) {
                idx = guitarDevices.findIndex(d => d.name === guitarPrefs.device) + 1;
                if (idx === 0) { options.push(`${guitarPrefs.device}  (not connected)`); idx = options.length - 1; }
            }
            W.dropdown(row, {
                id: "tabs_input", label: "Guitar input", options, selectedIndex: idx,
                onChange: (v: string) => {
                    const i = Number(v);
                    const d = guitarDevices[i - 1];
                    if (i === 0) { delete guitarPrefs.device; delete guitarPrefs.host; }
                    else if (d) { guitarPrefs.device = d.name; guitarPrefs.host = d.host; }
                    if (guitarRunning) startGuitar();
                    scheduleSave();
                },
            });
            W.button(row, { id: "tabs_refresh_inputs", text: "Refresh", onClick: () => refreshDevices() });
            W.button(row, { id: "tabs_guitar_toggle", text: guitarRunning ? "Stop input" : icon("microphone", "Start input"), selected: guitarRunning, onClick: () => { if (guitarRunning) stopGuitar(); else startGuitar(); } });
            W.button(row, { id: "tabs_cal_room", text: "Calibrate room (3 s quiet)", disabled: !guitarRunning, onClick: () => { addon.Guitar.calibrate(false, 3); message = "Listening to the room: stay quiet for 3 seconds."; } });
            W.checkbox(row, {
                id: "tabs_hear_guitar", label: "Hear my guitar through the synth", value: practice.hearGuitar,
                onChange: (v: boolean) => { practice.hearGuitar = v; if (guitarRunning) addon.Guitar.target(v ? guitarOutput() : { trackId: "" }); scheduleSave(); },
            });
        });
        W.horizontal(card, (row: string) => {
            W.slider(row, {
                id: "tabs_guitar_sensitivity", label: "Sensitivity", value: guitarPrefs.sensitivity, min: 0, max: 1,
                onChange: (v: string) => {
                    guitarPrefs.sensitivity = parseFloat(v);
                    pushGuitarSettings({ sensitivity: guitarPrefs.sensitivity });
                },
            });
            W.slider(row, {
                id: "tabs_guitar_gate", label: "Gate opens at (dBFS)", value: guitarPrefs.gateOpenDb ?? -46, min: -70, max: -20,
                onChange: (v: string) => {
                    const open = parseFloat(v);
                    guitarPrefs.gateOpenDb = open;
                    guitarPrefs.gateCloseDb = open - 8;
                    pushGuitarSettings({ gateOpenDb: open, gateCloseDb: open - 8 });
                },
            });
        });
        const heard = diag?.notesSounding?.length ? diag.notesSounding.map(noteName).join(" ") : "nothing";
        const level = diag ? `${Number(diag.levelDb).toFixed(0)} dBFS` : "-";
        W.label(card, {
            text: guitarRunning
                ? `Hearing: ${heard}   (${guitarPolyphony === "poly" ? "chord mode" : "pick mode"})   level ${level}${diag?.clipped ? "   CLIPPING" : ""}`
                : "No guitar? Click the neck to play a note: it sounds and counts just as if the guitar had played it.",
            color: guitarRunning ? UI.teal : UI.dim, monospace: guitarRunning,
        });
    });
}

// --- Frame loop ----------------------------------------------------------------------------------

function onFrame() {
    const now = Date.now();
    pollGuitar(now);
    if (session?.running) handleEvents(session.tick(now), now);
    if (saveDue && now >= saveDue) save();
}

addon.onInit(() => {
    load();
    ensureBuses();
    const tabId = addon.UI.createTab({
        title: icon("guitar", "Guitar Tabs"),
        scroll: false,
        onRender: () => {
            renderHeader(tabId);
            W.split(tabId, { id: "tabs_body_" + view, sideOpen: false, sideWidth: 0, reserveBottom: 28, minHeight: 600, mainPadding: 14, scrollMain: true } as SplitConfig, (main: string) => {
                if (view === "paste") renderPaste(main);
                else if (view === "review") renderReview(main);
                else renderPractice(main);
            });
            renderStatus(tabId);
        },
    });

    Entropy.Input.onKeyDown((key: string, ctrl: boolean) => {
        if (ctrl || view !== "practice") return;
        const now = Date.now();
        if (key === " ") togglePlay(now);
        else if (key.toLowerCase() === "h") { ensureBuses(); playStep(currentStep(now)); }
    });

    addon.onUpdate(onFrame);
    addon.onUpdatePlus("Global", onFrame);

    addon.registerTool({
        name: "tabs_load",
        description: "Load an ASCII guitar tab into the Guitar Tabs app, as if pasted, and open the Review view. Six lines per system, highest string first (e|---0---|). Returns what was read: steps, bars, tuning and any warnings.",
        parameters: { type: "object", properties: { text: { type: "string", description: "The tab text" } }, required: ["text"] },
    }, (args: { text: string }) => {
        source = String(args?.text ?? "");
        songSource = "";
        songFromSource();
        view = "review";
        scheduleSave();
        return { success: parsed.song.steps.length > 0, title: song.title, steps: song.steps.length, bars: parsed.bars, tuning: song.tuning.map(noteName), warnings: parsed.warnings };
    });

    addon.registerTool({
        name: "tabs_state",
        description: "What the Guitar Tabs app is doing: the view, the song's steps (notes and play-as mode), and the practice run's score if one is going.",
        parameters: { type: "object", properties: {} },
    }, () => {
        const now = Date.now();
        const plan = polyphonyPlan(song);
        return {
            success: true, view, title: song.title, bpm: song.bpm, tuning: song.tuning.map(noteName),
            steps: song.steps.map((s, i) => ({ bar: s.bar, beats: s.beats, notes: stepMidi(song, s).map(noteName), playAs: plan[i] })),
            practice: session ? { mode: session.options.mode, currentStep: session.currentStep(now) + 1, finished: session.finished, ...session.stats() } : null,
            guitar: {
                running: guitarRunning,
                polyphony: guitarPolyphony,
                sensitivity: guitarPrefs.sensitivity,
                gateOpenDb: guitarPrefs.gateOpenDb ?? -46,
                gateCloseDb: guitarPrefs.gateCloseDb ?? -54,
            },
        };
    });
});
