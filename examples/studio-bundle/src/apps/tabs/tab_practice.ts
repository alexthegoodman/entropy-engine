// Grading a performance against a tab. No `Entropy` calls: the app feeds this what Guitar-to-MIDI
// reports each frame (`Guitar.status().diagnostics`), and it answers with what happened: a step hit,
// a wrong note, a step missed. tests/guitar_tabs.test.ts runs it with made-up input.
//
// Knowing what the tab expects makes the check far more reliable than open transcription (see
// GUITAR_TO_MIDI.md section 12): the question is "is each of these notes there?", not "what is being
// played?". For chords the detector's pitch classes and bass note are the reliable part, so a chord
// counts as played when its bass note and every pitch class are heard, octave doublings or not.

import { playableSteps, stepMidi, type TabSong } from "./tab_model";

/** `wait`: the cursor waits on each step until you play it (your own pace). `realtime`: the song
 * runs at its tempo and each step must be played in time. `listen`: the song plays itself. */
export type PracticeMode = "wait" | "realtime" | "listen";
export const PRACTICE_MODES: PracticeMode[] = ["wait", "realtime", "listen"];

export type StepResult = "pending" | "hit" | "partial" | "miss";

export interface PracticeOptions {
    mode: PracticeMode;
    /** Percent of the song's tempo, 25..150. */
    tempoPct: number;
    /** First and last step to practise (indexes into song.steps), inclusive. */
    fromStep: number;
    toStep: number;
    loop: boolean;
    /** Beats of metronome before a timed run starts. */
    countIn: number;
    /** How early and late a note may land and still count for a step, in ms. */
    earlyMs: number;
    lateMs: number;
    /** Accept a chord from its bass note and pitch classes (octave doublings optional). */
    lenientChords: boolean;
}

export function defaultPracticeOptions(song: TabSong): PracticeOptions {
    return {
        mode: "wait", tempoPct: 100, fromStep: 0, toStep: Math.max(0, song.steps.length - 1), loop: false,
        countIn: 4, earlyMs: 160, lateMs: 220, lenientChords: true,
    };
}

export type PracticeEvent =
    /** Every expected note of a step was played. `offsetMs` is how late (positive) or early it was,
     * in a timed run. */
    | { type: "hit"; step: number; offsetMs: number | null }
    /** A timed step passed with only some of its notes played. */
    | { type: "partial"; step: number; matched: number; expected: number }
    | { type: "miss"; step: number }
    /** A note that belongs to no step within reach. */
    | { type: "wrong"; note: number; step: number }
    /** A step's time has come (sound the guide synth for it). */
    | { type: "due"; step: number }
    /** A metronome beat; `countIn` for the beats before the first step. */
    | { type: "beat"; beat: number; countIn: boolean }
    /** The cursor moved to another step (own-pace runs). */
    | { type: "advance"; step: number }
    | { type: "loop" }
    | { type: "finished" };

/** How well a set of heard notes covers what a step expects. */
export interface Match { matched: number; expected: number; complete: boolean }

/** Exact notes, or for a chord of three or more notes played leniently, its bass note plus every
 * pitch class. */
export function matchNotes(expected: number[], heard: Iterable<number>, lenient: boolean): Match {
    const got = new Set(heard);
    const exp = [...new Set(expected)].sort((a, b) => a - b);
    if (exp.length === 0) return { matched: 0, expected: 0, complete: false };
    const exact = exp.filter(n => got.has(n)).length;
    if (exact === exp.length || !lenient || exp.length < 3) return { matched: exact, expected: exp.length, complete: exact === exp.length };
    const gotPc = new Set([...got].map(n => ((n % 12) + 12) % 12));
    const pcs = [...new Set(exp.map(n => n % 12))];
    const pcHit = pcs.filter(pc => gotPc.has(pc)).length;
    const bass = got.has(exp[0]);
    // Count notes whose pitch class was heard, so progress reads naturally for a doubled chord.
    const matched = exp.filter(n => got.has(n) || gotPc.has(n % 12)).length;
    return { matched, expected: exp.length, complete: bass && pcHit === pcs.length };
}

/** Is `note` one the step wants (by pitch class, for a lenient chord)? */
export function belongsTo(expected: number[], note: number, lenient: boolean): boolean {
    if (expected.includes(note)) return true;
    return lenient && new Set(expected).size >= 3 && expected.some(n => n % 12 === note % 12);
}

/** Turns successive `Guitar.status()` readings into the notes that were just played. A note is
 * fresh when it joins the sounding set, or when the engine counted a new Note On while the same
 * notes kept sounding (a re-pick).
 *
 * Pick mode plays a hammer-on, pull-off or slide as pitch bend on the note already sounding, with no
 * new Note On (GUITAR_TO_MIDI.md 4.4). So `pitch`, the detected pitch as a note and cents off it, is
 * also watched: when it settles (within `settleCents`) on a new note while a note sounds, that note
 * is fresh too. */
export class OnsetTracker {
    private prev = new Set<number>();
    private prevOns = -1;
    private prevPitch: number | null = null;
    settleCents = 30;

    update(sounding: number[], noteOns: number, pitch: { note: number; cents: number } | null = null): number[] {
        const now = new Set(sounding);
        let fresh = sounding.filter(n => !this.prev.has(n));
        if (this.prevOns >= 0 && noteOns > this.prevOns && fresh.length === 0) fresh = [...now];
        const settled = pitch && sounding.length > 0 && Math.abs(pitch.cents) <= this.settleCents ? pitch.note : null;
        // Before any pitch was read, the note that was sounding is where the pitch started from.
        const from = this.prevPitch ?? (this.prev.size ? Math.min(...this.prev) : null);
        if (settled !== null && from !== null && settled !== from) fresh.push(settled);
        if (settled !== null) this.prevPitch = settled;
        else if (sounding.length === 0) this.prevPitch = null;
        this.prev = now;
        this.prevOns = noteOns;
        return [...new Set(fresh)].sort((a, b) => a - b);
    }

    reset() {
        this.prev = new Set();
        this.prevOns = -1;
        this.prevPitch = null;
    }
}

/** The detected pitch as a note and cents from it, from `freqHz` (0 when nothing is heard). */
export function pitchOf(freqHz: number, referencePitch = 440): { note: number; cents: number } | null {
    if (!(freqHz > 20)) return null;
    const exact = 69 + 12 * Math.log2(freqHz / referencePitch);
    const note = Math.round(exact);
    return { note, cents: (exact - note) * 100 };
}

export interface PracticeStats {
    hits: number;
    partials: number;
    misses: number;
    wrong: number;
    streak: number;
    bestStreak: number;
    /** 0..100 over the steps graded so far. */
    accuracy: number;
    /** Mean absolute timing error of hits in a timed run. */
    meanOffsetMs: number | null;
}

/** One run through a range of the song. */
export class PracticeSession {
    readonly song: TabSong;
    readonly options: PracticeOptions;
    /** Indexes into song.steps with something to play, in order, within the range. */
    readonly order: number[];
    readonly results: StepResult[];
    readonly offsets: (number | null)[];
    /** Notes heard toward each step so far. */
    private collected: Set<number>[];
    /** Own pace: position in `order` of the step being waited on. */
    private cursor = 0;
    /** Timed: ms from the first step of the range to each step of `order`. */
    private times: number[];
    private totalMs: number;
    private startedAt: number | null = null;
    private pausedAt: number | null = null;
    private lastTick = -Infinity;
    private stepEnteredAt = 0;
    finished = false;
    wrong = 0;
    streak = 0;
    bestStreak = 0;
    loops = 0;

    constructor(song: TabSong, options: PracticeOptions) {
        this.song = song;
        this.options = { ...options, tempoPct: Math.min(150, Math.max(25, options.tempoPct)) };
        const lo = Math.max(0, Math.min(options.fromStep, options.toStep));
        const hi = Math.min(song.steps.length - 1, Math.max(options.fromStep, options.toStep));
        this.order = playableSteps(song).filter(i => i >= lo && i <= hi);
        this.results = song.steps.map(() => "pending");
        this.offsets = song.steps.map(() => null);
        this.collected = song.steps.map(() => new Set<number>());
        this.times = [];
        let t = 0;
        let prev = this.order[0] ?? 0;
        for (const i of this.order) {
            for (let k = prev; k < i; k++) t += this.song.steps[k].beats * this.msPerBeat;
            this.times.push(t);
            prev = i;
        }
        const last = this.order[this.order.length - 1];
        this.totalMs = last === undefined ? 0 : t + this.song.steps[last].beats * this.msPerBeat;
    }

    get msPerBeat(): number {
        return 60000 / (Math.max(20, this.song.bpm) * this.options.tempoPct / 100);
    }

    get running(): boolean {
        return this.startedAt !== null && this.pausedAt === null && !this.finished;
    }

    get started(): boolean {
        return this.startedAt !== null;
    }

    get paused(): boolean {
        return this.pausedAt !== null;
    }

    private get countInMs(): number {
        return this.options.mode === "wait" ? 0 : this.options.countIn * this.msPerBeat;
    }

    start(nowMs: number) {
        this.startedAt = nowMs;
        this.pausedAt = null;
        this.stepEnteredAt = nowMs;
        this.lastTick = -Infinity;
    }

    pause(nowMs: number) {
        if (this.running) this.pausedAt = nowMs;
    }

    resume(nowMs: number) {
        if (this.startedAt === null || this.pausedAt === null) return;
        this.startedAt += nowMs - this.pausedAt;
        this.stepEnteredAt += nowMs - this.pausedAt;
        this.pausedAt = null;
    }

    /** Song time in ms from the first step of the range; negative during the count-in. */
    songTimeMs(nowMs: number): number {
        if (this.startedAt === null) return -this.countInMs;
        const now = this.pausedAt ?? nowMs;
        return now - this.startedAt - this.countInMs;
    }

    /** Time of a step (index into song.steps) in a timed run, or null outside the range. */
    stepTimeMs(step: number): number | null {
        const k = this.order.indexOf(step);
        return k < 0 ? null : this.times[k];
    }

    get lengthMs(): number {
        return this.totalMs;
    }

    /** The step the player should be on now (index into song.steps), or -1 when there is none. */
    currentStep(nowMs: number): number {
        if (this.order.length === 0) return -1;
        if (this.options.mode === "wait") return this.order[Math.min(this.cursor, this.order.length - 1)];
        const t = this.songTimeMs(nowMs);
        let k = 0;
        while (k + 1 < this.times.length && this.times[k + 1] <= t + 1) k++;
        return this.order[k];
    }

    /** Steps after the current one, soonest first. */
    upcoming(nowMs: number, count: number): number[] {
        const cur = this.currentStep(nowMs);
        const k = this.order.indexOf(cur);
        if (k < 0) return [];
        const out = this.order.slice(k + 1, k + 1 + count);
        if (this.options.loop && out.length < count) out.push(...this.order.slice(0, count - out.length));
        return out;
    }

    /** How far through the current step the song is, 0..1 (own pace: always 0). */
    stepProgress(nowMs: number): number {
        if (this.options.mode === "wait") return 0;
        const cur = this.currentStep(nowMs);
        const k = this.order.indexOf(cur);
        if (k < 0) return 0;
        const t = this.songTimeMs(nowMs);
        const len = this.song.steps[cur].beats * this.msPerBeat;
        return Math.min(1, Math.max(0, (t - this.times[k]) / len));
    }

    /** Notes the player has already played toward a step. */
    heardFor(step: number): number[] {
        return [...(this.collected[step] ?? [])];
    }

    expected(step: number): number[] {
        const s = this.song.steps[step];
        return s ? stepMidi(this.song, s) : [];
    }

    private lenientFor(step: number): boolean {
        return this.options.lenientChords;
    }

    /** Advances time: metronome beats, steps falling due, timed steps that passed unplayed. */
    tick(nowMs: number): PracticeEvent[] {
        const events: PracticeEvent[] = [];
        if (!this.running || this.order.length === 0) return events;
        if (this.options.mode === "wait") return events;
        const t = this.songTimeMs(nowMs);
        const from = this.lastTick;
        this.lastTick = t;

        // Metronome beats from the count-in on.
        const beat = this.msPerBeat;
        const firstBeat = Math.ceil((Number.isFinite(from) ? from + 0.001 : -this.countInMs) / beat);
        for (let b = firstBeat; b * beat <= t; b++) {
            if (b * beat < -this.countInMs - 0.5) continue;
            if (b * beat >= this.totalMs) break;
            events.push({ type: "beat", beat: b, countIn: b < 0 });
        }
        // Steps falling due.
        this.order.forEach((step, k) => {
            const due = this.times[k];
            if (due <= t && (due > from || (!Number.isFinite(from) && due >= 0 && due <= t))) events.push({ type: "due", step });
        });
        if (this.options.mode === "realtime") {
            this.order.forEach((step, k) => {
                if (this.results[step] !== "pending") return;
                if (t <= this.times[k] + this.lateMs(k)) return;
                const m = matchNotes(this.expected(step), this.collected[step], this.lenientFor(step));
                if (m.matched > 0) {
                    this.results[step] = "partial";
                    events.push({ type: "partial", step, matched: m.matched, expected: m.expected });
                } else {
                    this.results[step] = "miss";
                    events.push({ type: "miss", step });
                }
                this.streak = 0;
            });
        }
        if (t >= this.totalMs + (this.options.mode === "realtime" ? this.options.lateMs : 0)) {
            if (this.options.loop) {
                this.loops++;
                this.resetRange();
                this.startedAt = nowMs - this.countInMs;
                this.lastTick = -0.001;
                events.push({ type: "loop" });
                if (this.times[0] === 0) events.push({ type: "due", step: this.order[0] });
            } else {
                this.finished = true;
                events.push({ type: "finished" });
            }
        }
        return events;
    }

    /** How late a note may land for step k of `order`: the option, but never past halfway to the
     * next step, so quick passages do not bleed into each other. */
    private lateMs(k: number): number {
        const gap = k + 1 < this.times.length ? this.times[k + 1] - this.times[k] : Infinity;
        return Math.max(60, Math.min(this.options.lateMs, gap * 0.5));
    }

    private earlyMs(k: number): number {
        const gap = k > 0 ? this.times[k] - this.times[k - 1] : Infinity;
        return Math.max(60, Math.min(this.options.earlyMs, gap * 0.5));
    }

    /** Notes just played (from `OnsetTracker`, or a click on the neck). `latencyMs` is how long the
     * detector took to name them, taken off their time in a timed run. */
    play(notes: number[], nowMs: number, latencyMs = 0): PracticeEvent[] {
        const events: PracticeEvent[] = [];
        if (!this.running || notes.length === 0 || this.order.length === 0) return events;
        if (this.options.mode === "listen") return events;
        if (this.options.mode === "wait") return this.playOwnPace(notes, nowMs);

        const t = this.songTimeMs(nowMs) - latencyMs;
        for (const note of notes) {
            // The nearest step still open whose window this falls in and which wants this note.
            let best = -1, bestDist = Infinity;
            this.order.forEach((step, k) => {
                if (this.results[step] !== "pending") return;
                const d = t - this.times[k];
                if (d < -this.earlyMs(k) || d > this.lateMs(k)) return;
                if (!belongsTo(this.expected(step), note, this.lenientFor(step))) return;
                if (Math.abs(d) < bestDist) { bestDist = Math.abs(d); best = k; }
            });
            if (best < 0) {
                this.wrong++;
                events.push({ type: "wrong", note, step: this.currentStep(nowMs) });
                continue;
            }
            const step = this.order[best];
            const first = this.collected[step].size === 0;
            this.collected[step].add(note);
            if (first) this.offsets[step] = Math.round(t - this.times[best]);
            if (matchNotes(this.expected(step), this.collected[step], this.lenientFor(step)).complete) {
                this.results[step] = "hit";
                this.streak++;
                this.bestStreak = Math.max(this.bestStreak, this.streak);
                events.push({ type: "hit", step, offsetMs: this.offsets[step] });
            }
        }
        return events;
    }

    private playOwnPace(notes: number[], nowMs: number): PracticeEvent[] {
        const events: PracticeEvent[] = [];
        const step = this.order[this.cursor];
        if (step === undefined) return events;
        const expected = this.expected(step);
        for (const note of notes) {
            if (belongsTo(expected, note, this.lenientFor(step))) this.collected[step].add(note);
            else {
                this.wrong++;
                this.streak = 0;
                events.push({ type: "wrong", note, step });
            }
        }
        if (matchNotes(expected, this.collected[step], this.lenientFor(step)).complete) {
            this.results[step] = "hit";
            this.offsets[step] = null;
            this.streak++;
            this.bestStreak = Math.max(this.bestStreak, this.streak);
            events.push({ type: "hit", step, offsetMs: null });
            this.cursor++;
            this.stepEnteredAt = nowMs;
            if (this.cursor >= this.order.length) {
                if (this.options.loop) {
                    this.loops++;
                    this.resetRange();
                    events.push({ type: "loop" });
                    events.push({ type: "advance", step: this.order[0] });
                } else {
                    this.finished = true;
                    events.push({ type: "finished" });
                }
            } else events.push({ type: "advance", step: this.order[this.cursor] });
        }
        return events;
    }

    /** Own pace: skip the current step without playing it (it counts as missed). */
    skip(nowMs: number): PracticeEvent[] {
        if (this.options.mode !== "wait" || !this.running) return [];
        const step = this.order[this.cursor];
        if (step === undefined) return [];
        this.results[step] = "miss";
        this.streak = 0;
        this.cursor++;
        this.stepEnteredAt = nowMs;
        if (this.cursor >= this.order.length) {
            this.finished = true;
            return [{ type: "miss", step }, { type: "finished" }];
        }
        return [{ type: "miss", step }, { type: "advance", step: this.order[this.cursor] }];
    }

    /** How long the player has been on the current step (own pace). */
    timeOnStep(nowMs: number): number {
        return (this.pausedAt ?? nowMs) - this.stepEnteredAt;
    }

    private resetRange() {
        this.cursor = 0;
        for (const i of this.order) {
            this.results[i] = "pending";
            this.offsets[i] = null;
            this.collected[i] = new Set();
        }
    }

    stats(): PracticeStats {
        let hits = 0, partials = 0, misses = 0;
        const offsets: number[] = [];
        for (const i of this.order) {
            const r = this.results[i];
            if (r === "hit") { hits++; if (this.offsets[i] !== null) offsets.push(Math.abs(this.offsets[i]!)); }
            else if (r === "partial") partials++;
            else if (r === "miss") misses++;
        }
        const graded = hits + partials + misses;
        return {
            hits, partials, misses, wrong: this.wrong, streak: this.streak, bestStreak: this.bestStreak,
            accuracy: graded ? Math.round(((hits + partials * 0.5) / graded) * 100) : 0,
            meanOffsetMs: offsets.length ? Math.round(offsets.reduce((a, b) => a + b, 0) / offsets.length) : null,
        };
    }
}
