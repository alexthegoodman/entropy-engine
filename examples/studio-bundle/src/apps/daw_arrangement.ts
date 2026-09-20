// The DAW's arrangement model, kept free of `Entropy.*` so it can be exercised by a plain
// vitest run (tests/daw_arrangement.test.ts) without a window or an audio device.
//
// Vocabulary, since "track" and "channel" get used loosely elsewhere:
//   - A *track* is one instrument strip: a voice (or hosted VST3 plugin), gain/mute/solo, effects.
//   - A *channel* is the lane a track sits on in the arrangement. There are always at least
//     MIN_LANES of them, so an empty lane is somewhere a track can be dropped.
//   - A *pattern* is a looping bank of notes that belongs to one track (a track can have many).
//   - A *clip* places a pattern on the timeline: start and length in steps, looping the
//     pattern when it is longer than the pattern.
//
// Time is measured in steps (one grid cell of the piano roll) everywhere in here, and only
// converted to milliseconds at the edge, where the TrackView widget wants it.

export const MIN_LANES = 16;
export const BEATS_PER_BAR = 4;

export interface NoteCell {
    row: number;
    step: number;
    length: number;
    velocity: number;
}

export interface Pattern {
    id: string;
    name: string;
    steps: number;
    notes: NoteCell[];
}

export interface ArrClip {
    id: string;
    trackId: string;
    patternId: string;
    startStep: number;
    lengthSteps: number;
}

export type SnapMode = "bar" | "beat" | "step";

export interface ArrTrack {
    id: string;
    channel: number;
    kind: "synth" | "drum";
    rows: number;
    patterns: Pattern[];
    activePatternId: string;
    muted: boolean;
    solo: boolean;
}

export interface ArrProject<T extends ArrTrack = ArrTrack> {
    bpm: number;
    stepsPerBeat: number;
    songBars: number;
    snap: SnapMode;
    arrangement: ArrClip[];
    tracks: T[];
}

export type IdGen = () => string;

// --- Time -------------------------------------------------------------------------------------

export function barSteps(stepsPerBeat: number): number {
    return Math.max(1, Math.round(stepsPerBeat)) * BEATS_PER_BAR;
}

export function songSteps(p: Pick<ArrProject, "songBars" | "stepsPerBeat">): number {
    return Math.max(1, Math.round(p.songBars)) * barSteps(p.stepsPerBeat);
}

export function stepMs(bpm: number, stepsPerBeat: number): number {
    return 60000 / Math.max(1, bpm) / Math.max(1, stepsPerBeat);
}

export function snapUnitSteps(mode: SnapMode, stepsPerBeat: number): number {
    if (mode === "bar") return barSteps(stepsPerBeat);
    if (mode === "beat") return Math.max(1, Math.round(stepsPerBeat));
    return 1;
}

export function msToStep(ms: number, bpm: number, stepsPerBeat: number): number {
    return Math.round(ms / stepMs(bpm, stepsPerBeat));
}

export function stepToMs(step: number, bpm: number, stepsPerBeat: number): number {
    return Math.round(step * stepMs(bpm, stepsPerBeat));
}

// --- Lanes ------------------------------------------------------------------------------------

export function laneCount(tracks: { channel: number }[]): number {
    const highest = tracks.reduce((m, t) => Math.max(m, t.channel), -1);
    return Math.max(MIN_LANES, highest + 1);
}

/** One entry per lane, `null` where no track sits on that channel. */
export function laneTracks<T extends { channel: number }>(tracks: T[]): (T | null)[] {
    const lanes: (T | null)[] = Array.from({ length: laneCount(tracks) }, () => null);
    for (const t of tracks) lanes[t.channel] = t;
    return lanes;
}

export function nextFreeChannel(tracks: { channel: number }[]): number {
    const used = new Set(tracks.map(t => t.channel));
    let c = 0;
    while (used.has(c)) c++;
    return c;
}

export function activePattern<T extends ArrTrack>(track: T): Pattern {
    return track.patterns.find(p => p.id === track.activePatternId) ?? track.patterns[0];
}

export function nextPatternName(track: ArrTrack): string {
    let n = track.patterns.length + 1;
    const names = new Set(track.patterns.map(p => p.name));
    while (names.has(`Pattern ${n}`)) n++;
    return `Pattern ${n}`;
}

// --- Clips ------------------------------------------------------------------------------------

export function clipEnd(c: ArrClip): number {
    return c.startStep + c.lengthSteps;
}

export function clipsOfTrack(arr: ArrClip[], trackId: string): ArrClip[] {
    return arr.filter(c => c.trackId === trackId).sort((a, b) => a.startStep - b.startStep);
}

/**
 * The free span around a clip in its lane: the nearest neighbour end on the left and neighbour
 * start on the right, ignoring the clip itself. Moves and trims clamp inside it, so dragging can
 * never overlap two clips (two clips on one lane would double-trigger every note) and a clip
 * bumps against its neighbour instead of deleting it.
 */
export function freeSpan(arr: ArrClip[], clip: ArrClip, total: number): { left: number; right: number } {
    let left = 0;
    let right = total;
    for (const other of arr) {
        if (other.id === clip.id || other.trackId !== clip.trackId) continue;
        if (clipEnd(other) <= clip.startStep) left = Math.max(left, clipEnd(other));
        else if (other.startStep >= clipEnd(clip)) right = Math.min(right, other.startStep);
    }
    return { left, right };
}

export function moveClip(arr: ArrClip[], clipId: string, newStart: number, total: number): ArrClip | null {
    const clip = arr.find(c => c.id === clipId);
    if (!clip) return null;
    const { left, right } = freeSpan(arr, clip, total);
    const hi = Math.max(left, right - clip.lengthSteps);
    clip.startStep = Math.min(hi, Math.max(left, Math.round(newStart)));
    return clip;
}

export function resizeClip(arr: ArrClip[], clipId: string, newStart: number, newLength: number, total: number): ArrClip | null {
    const clip = arr.find(c => c.id === clipId);
    if (!clip) return null;
    const { left, right } = freeSpan(arr, clip, total);
    const end = Math.min(right, Math.max(newStart + 1, Math.round(newStart) + Math.round(newLength)));
    const start = Math.max(left, Math.min(Math.round(newStart), end - 1));
    clip.startStep = start;
    clip.lengthSteps = Math.max(1, end - start);
    return clip;
}

export function createClip(
    arr: ArrClip[],
    args: { trackId: string; patternId: string; startStep: number; lengthSteps: number },
    total: number,
    newId: IdGen,
): ArrClip | null {
    const start = Math.round(args.startStep);
    if (start < 0 || start >= total) return null;
    let end = Math.min(total, start + Math.max(1, Math.round(args.lengthSteps)));
    for (const other of arr) {
        if (other.trackId !== args.trackId) continue;
        // Starting inside another clip is not a free spot; a clip ahead just caps the length.
        if (start >= other.startStep && start < clipEnd(other)) return null;
        if (other.startStep >= start) end = Math.min(end, other.startStep);
    }
    if (end <= start) return null;
    const clip: ArrClip = { id: newId(), trackId: args.trackId, patternId: args.patternId, startStep: start, lengthSteps: end - start };
    arr.push(clip);
    return clip;
}

/** A copy of a clip placed in the first gap at or after its end that fits it. */
export function duplicateClip(arr: ArrClip[], clipId: string, total: number, newId: IdGen): ArrClip | null {
    const src = arr.find(c => c.id === clipId);
    if (!src) return null;
    const lane = clipsOfTrack(arr, src.trackId);
    let start = clipEnd(src);
    for (const other of lane) {
        if (other.startStep >= start + src.lengthSteps) break;
        if (clipEnd(other) > start) start = clipEnd(other);
    }
    if (start + src.lengthSteps > total) return null;
    const copy: ArrClip = { ...src, id: newId(), startStep: start };
    arr.push(copy);
    return copy;
}

export function deleteClip(arr: ArrClip[], clipId: string): boolean {
    const i = arr.findIndex(c => c.id === clipId);
    if (i < 0) return false;
    arr.splice(i, 1);
    return true;
}

/** Drops clips that no longer make sense: their track or pattern is gone, or they start past the end. */
export function pruneArrangement(p: ArrProject): void {
    const total = songSteps(p);
    p.arrangement = p.arrangement.filter(c => {
        const track = p.tracks.find(t => t.id === c.trackId);
        if (!track || !track.patterns.some(pt => pt.id === c.patternId)) return false;
        if (c.startStep >= total) return false;
        if (clipEnd(c) > total) c.lengthSteps = total - c.startStep;
        return c.lengthSteps > 0;
    });
}

// --- Playback ---------------------------------------------------------------------------------

export interface Trigger {
    track: ArrTrack;
    note: NoteCell;
}

/**
 * Every note that starts on `step` (a step in the song, already wrapped into 0..songSteps).
 * `soloPatternOf` switches to audition mode: only that track's active pattern, looped by itself.
 */
export function triggersAt(p: ArrProject, step: number, soloPatternOf?: string | null): Trigger[] {
    const out: Trigger[] = [];
    if (soloPatternOf) {
        const track = p.tracks.find(t => t.id === soloPatternOf);
        if (!track) return out;
        const pat = activePattern(track);
        if (!pat) return out;
        const local = ((step % pat.steps) + pat.steps) % pat.steps;
        for (const note of pat.notes) if (note.step === local) out.push({ track, note });
        return out;
    }
    for (const clip of p.arrangement) {
        if (step < clip.startStep || step >= clipEnd(clip)) continue;
        const track = p.tracks.find(t => t.id === clip.trackId);
        const pat = track?.patterns.find(pt => pt.id === clip.patternId);
        if (!track || !pat || pat.steps < 1) continue;
        const local = (step - clip.startStep) % pat.steps;
        for (const note of pat.notes) if (note.step === local) out.push({ track, note });
    }
    return out;
}

export interface PlacedNote {
    track: ArrTrack;
    note: NoteCell;
    /** Absolute start in the song, in steps. */
    startStep: number;
    /** Note length, cut off where its clip ends. */
    lengthSteps: number;
}

/** The whole arrangement flattened into absolute notes - what an offline render needs. */
export function expandArrangement(p: ArrProject, opts: { respectMuteSolo: boolean }): PlacedNote[] {
    const anySolo = p.tracks.some(t => t.solo);
    const out: PlacedNote[] = [];
    for (const clip of p.arrangement) {
        const track = p.tracks.find(t => t.id === clip.trackId);
        const pat = track?.patterns.find(pt => pt.id === clip.patternId);
        if (!track || !pat || pat.steps < 1) continue;
        if (opts.respectMuteSolo && (track.muted || (anySolo && !track.solo))) continue;
        const end = clipEnd(clip);
        for (let rep = 0; clip.startStep + rep * pat.steps < end; rep++) {
            for (const note of pat.notes) {
                const abs = clip.startStep + rep * pat.steps + note.step;
                if (note.step >= pat.steps || abs >= end) continue;
                out.push({ track, note, startStep: abs, lengthSteps: Math.min(note.length, end - abs) });
            }
        }
    }
    return out.sort((a, b) => a.startStep - b.startStep);
}

/**
 * Where the piano roll's playhead should sit (0..1 across the pattern), or -1 when it has nothing
 * to show: the song position is not inside a clip of the pattern being edited.
 */
export function pianoRollPlayhead(
    p: ArrProject,
    track: ArrTrack | undefined,
    songStepFloat: number,
    mode: "song" | "pattern",
): number {
    if (!track) return -1;
    const pat = activePattern(track);
    if (!pat) return -1;
    if (mode === "pattern") return ((songStepFloat % pat.steps) + pat.steps) % pat.steps / pat.steps;
    const clip = p.arrangement.find(c => c.trackId === track.id && c.patternId === pat.id && songStepFloat >= c.startStep && songStepFloat < clipEnd(c));
    if (!clip) return -1;
    return ((songStepFloat - clip.startStep) % pat.steps) / pat.steps;
}

// --- Widget data ------------------------------------------------------------------------------

/**
 * A pattern's notes as the `[start, len, y]` triples TrackView draws inside a clip. Drum rows
 * read top to bottom (kick first); pitched rows put the high notes at the top.
 */
export function miniNotes(track: ArrTrack, pattern: Pattern): [number, number, number][] {
    const rows = Math.max(1, track.rows);
    const out: [number, number, number][] = [];
    for (const n of pattern.notes) {
        if (n.step >= pattern.steps) continue;
        const y = track.kind === "drum" ? (n.row + 0.5) / rows : 1 - (n.row + 0.5) / rows;
        out.push([n.step / pattern.steps, Math.min(n.length, pattern.steps - n.step) / pattern.steps, Math.min(1, Math.max(0, y))]);
    }
    return out;
}

// --- Migration --------------------------------------------------------------------------------

/**
 * Brings a saved project from before the arrangement existed (one looping `notes` array per
 * track, one global `steps`) up to the pattern + clip model. The old behaviour was "loop the
 * pattern forever", so each track with notes gets one clip covering the whole song.
 */
export function migrateProject(saved: any, newId: IdGen): void {
    const legacySteps = Math.max(1, Math.round(saved.steps) || 16);
    saved.stepsPerBeat = Math.max(1, Math.round(saved.stepsPerBeat) || 4);
    saved.songBars = Math.max(1, Math.round(saved.songBars) || 8);
    if (saved.snap !== "bar" && saved.snap !== "beat" && saved.snap !== "step") saved.snap = "bar";
    const hadArrangement = Array.isArray(saved.arrangement);
    if (!hadArrangement) saved.arrangement = [];
    const total = songSteps(saved);

    const used = new Set<number>();
    (saved.tracks as any[]).forEach((t, i) => {
        if (!Array.isArray(t.patterns) || t.patterns.length === 0) {
            const pat: Pattern = { id: newId(), name: "Pattern 1", steps: legacySteps, notes: Array.isArray(t.notes) ? t.notes : [] };
            t.patterns = [pat];
            t.activePatternId = pat.id;
            if (!hadArrangement && pat.notes.length > 0) {
                saved.arrangement.push({ id: newId(), trackId: t.id, patternId: pat.id, startStep: 0, lengthSteps: total });
            }
        }
        delete t.notes;
        if (!t.patterns.some((p: Pattern) => p.id === t.activePatternId)) t.activePatternId = t.patterns[0].id;
        if (typeof t.colorIndex !== "number") t.colorIndex = i;
        // Give every track a distinct channel, keeping any it already had.
        let ch = typeof t.channel === "number" && t.channel >= 0 && !used.has(t.channel) ? t.channel : -1;
        if (ch < 0) {
            ch = 0;
            while (used.has(ch)) ch++;
        }
        used.add(ch);
        t.channel = ch;
    });
    delete saved.steps;
    pruneArrangement(saved);
}
