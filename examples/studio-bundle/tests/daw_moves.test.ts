import { describe, expect, it } from "vitest";
import { expandArrangement, type ArrClip, type ArrProject, type NoteCell } from "../src/apps/daw_arrangement";
import {
    BOUNCE_MAX_SWING, HUMANIZE_MAX_TIMING, acidVoice, anchorIndices, answerPhrase, applyAcid, buildRoll, busEffects,
    carveRange, defaultCharacter, echoRepeats, grooveAt, isKickPad, kickLock, makeVariation, metricWeight, nearestBar,
    octaveSpark, phraseEnding, repairCharacter, rollRows, stutter, thinOut, type MoveContext,
} from "../src/apps/daw_moves";

// The rules behind the Character knobs and the Moves buttons, exercised directly. The scenarios in
// tests/features/daw_moves.feature drive the same code through the production addon.

const n = (row: number, step: number, length = 1, velocity = 0.8): NoteCell => ({ row, step, length, velocity });
const synth = (steps = 16, rows = 10): MoveContext => ({ steps, stepsPerBeat: 4, kind: "synth", rows, rowsPerOctave: 5 });
const drums = (steps = 16): MoveContext => ({ steps, stepsPerBeat: 4, kind: "drum", rows: 5, rowsPerOctave: 12, kickRows: [0], fillRows: [1, 4] });
const time = (x: NoteCell) => x.step + (x.offset ?? 0);

describe("Character knobs", () => {
    it("repairs a damaged save and leaves every knob at zero by default", () => {
        expect(repairCharacter(null)).toEqual(defaultCharacter());
        const c = repairCharacter({ pump: 4, grit: -1, gate: "x", gatePattern: "polka", space: 0.5 });
        expect([c.pump, c.grit, c.gate, c.gatePattern, c.space]).toEqual([1, 0, 0, "sixteenths", 0.5]);
    });

    it("puts only the knobs that are up on the bus, in chain order", () => {
        expect(busEffects(defaultCharacter(), 120)).toEqual([]);
        const c = { ...defaultCharacter(), pump: 0.5, grit: 0.2, space: 0.1, gate: 0.3, gatePattern: "syncopated" as const };
        expect(busEffects(c, 128).map(e => e.kind)).toEqual(["grit", "gate", "space", "pump"]);
        expect(busEffects(c, 128)[1]).toMatchObject({ amount: 0.3, pattern: 2, bpm: 128 });
    });

    it("sweeps acid's filter, resonance, envelope and drive together over the whole travel", () => {
        const steps = [0.1, 0.25, 0.5, 0.75, 1].map(acidVoice);
        for (let i = 1; i < steps.length; i++) {
            expect(steps[i].cutoff).toBeGreaterThan(steps[i - 1].cutoff);
            expect(steps[i].resonance).toBeGreaterThan(steps[i - 1].resonance);
            expect(steps[i].filterEnv).toBeGreaterThan(steps[i - 1].filterEnv);
            expect(steps[i].drive).toBeGreaterThan(steps[i - 1].drive);
        }
        // Useful from the first quarter: a real envelope, a resonance you can hear, still clean-ish.
        expect(steps[1].filterEnv).toBeGreaterThan(1.5);
        expect(steps[1].resonance).toBeGreaterThan(1.3);
        expect(steps[1].drive).toBeLessThan(2);
        // And at the top it stays inside what the voice and the resonance slider allow.
        expect(steps[4].resonance).toBeLessThanOrEqual(10);
        expect(steps[4].cutoff).toBeLessThan(2000);
    });

    it("gives the voice its own filter back when acid returns to zero", () => {
        const voice: any = { cutoff: 4000, resonance: 1 };
        const ch = defaultCharacter();
        applyAcid(voice, ch, 0.6);
        applyAcid(voice, ch, 0.8);
        expect(voice.cutoff).toBe(acidVoice(0.8).cutoff);
        expect(voice.drive).toBeGreaterThan(1);
        applyAcid(voice, ch, 0);
        expect([voice.cutoff, voice.resonance, voice.filterEnv, voice.drive]).toEqual([4000, 1, 0, 1]);
        expect(ch.acidBase).toBeNull();
    });
});

describe("Bounce and Humanize", () => {
    it("bounce pushes offbeat sixteenths late and softer, and lays back the offbeat eighth", () => {
        const g = (step: number, bounce: number) => grooveAt({ bounce, humanize: 0 }, step, 4, 0, "k");
        expect(g(0, 1)).toEqual({ offset: 0, velocityScale: 1, velocityAdd: 0 });
        expect(g(1, 1).offset).toBeCloseTo(BOUNCE_MAX_SWING);
        expect(g(3, 0.5).offset).toBeCloseTo(BOUNCE_MAX_SWING / 2);
        expect(g(1, 1).velocityScale).toBeLessThan(1);
        expect(g(2, 1).offset).toBeGreaterThan(0);
        expect(g(2, 1).offset).toBeLessThan(0.1);
        expect(g(2, 1).velocityScale).toBeGreaterThan(1);
        // A deliberate groove: every bar the same.
        expect(g(17, 0.7)).toEqual(g(1, 0.7));
    });

    it("humanize varies by note and pass but repeats exactly, and stays small", () => {
        const g = (key: string, row = 0) => grooveAt({ bounce: 0, humanize: 1 }, 6, 4, row, key);
        expect(g("a|6")).toEqual(g("a|6"));
        const offsets = Array.from({ length: 200 }, (_, i) => g(`a|${i}`).offset);
        expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(HUMANIZE_MAX_TIMING + 1e-9);
        expect(new Set(offsets.map(o => o.toFixed(4))).size).toBeGreaterThan(150);
        expect(offsets.some(o => o < 0)).toBe(true);
        expect(g("a|6", 1)).not.toEqual(g("a|6", 0));
        // Downbeats wander half as far.
        const onBeat = Array.from({ length: 200 }, (_, i) => grooveAt({ bounce: 0, humanize: 1 }, 0, 4, 0, `b|${i}`).offset);
        expect(Math.max(...onBeat.map(Math.abs))).toBeLessThanOrEqual(HUMANIZE_MAX_TIMING / 2 + 1e-9);
    });
});

describe("Pattern moves", () => {
    const busy: NoteCell[] = [
        n(0, 0, 1, 1), n(2, 2, 1, 0.5), n(1, 3, 1, 0.4), n(0, 4, 1, 0.9), n(3, 6, 1, 0.6), n(2, 7, 1, 0.3),
        n(0, 8, 1, 1), n(4, 10, 1, 0.5), n(1, 11, 1, 0.3), n(0, 12, 1, 0.9), n(2, 14, 1, 0.6), n(5, 15, 1, 0.7),
    ];

    it("anchors are downbeats, the phrase's first and last notes, and drum kicks on the beat", () => {
        const a = anchorIndices(busy, synth());
        expect([...a].map(i => busy[i].step).sort((x, y) => x - y)).toEqual([0, 15]);
        const kicks = [n(0, 0), n(0, 4), n(0, 6), n(1, 4), n(2, 9)];
        expect([...anchorIndices(kicks, drums())].map(i => kicks[i].step).sort((x, y) => x - y)).toEqual([0, 4, 9]);
    });

    it("a variation keeps the anchors, changes something, and is reproducible from its seed", () => {
        for (const focus of ["mixed", "rhythm", "notes", "fill"] as const) {
            const v = makeVariation(busy, synth(), { strength: 0.8, focus, seed: 7 });
            expect(v, focus).not.toEqual(busy);
            expect(v.some(x => x.step === 0 && x.row === 0 && x.velocity === 1), `${focus} keeps the downbeat`).toBe(true);
            expect(makeVariation(busy, synth(), { strength: 0.8, focus, seed: 7 })).toEqual(v);
            for (const x of v) {
                expect(x.step).toBeGreaterThanOrEqual(0);
                expect(x.step).toBeLessThan(16);
                expect(x.row).toBeGreaterThanOrEqual(0);
            }
        }
        expect(makeVariation(busy, synth(), { strength: 0.8, focus: "mixed", seed: 8 })).not.toEqual(makeVariation(busy, synth(), { strength: 0.8, focus: "mixed", seed: 7 }));
        // The input is not modified.
        expect(busy[1]).toEqual(n(2, 2, 1, 0.5));
    });

    it("on drums, a notes variation reshapes accents instead of swapping drums, and a fill rolls on the fill rows", () => {
        const beat = [n(0, 0, 1, 1), n(2, 2, 1, 0.7), n(1, 4, 1, 0.9), n(2, 6, 1, 0.7), n(0, 8, 1, 1), n(2, 10, 1, 0.7), n(1, 12, 1, 0.9), n(2, 14, 1, 0.7)];
        const v = makeVariation(beat, drums(), { strength: 1, focus: "notes", seed: 3 });
        expect(v.map(x => `${x.row}:${x.step}`)).toEqual(beat.map(x => `${x.row}:${x.step}`));
        const fill = makeVariation(beat, drums(), { strength: 0.3, focus: "fill", seed: 3 });
        const last = fill.filter(x => x.step >= 12);
        expect(last.map(x => x.step)).toEqual([12, 13, 14, 15]);
        expect(new Set(last.map(x => x.row))).toEqual(new Set([1, 4]));
    });

    it("thin out removes the weakest share and never an anchor", () => {
        const half = thinOut(busy, synth(), 0.5);
        expect(half.removed).toBe(5);
        expect(half.notes).toHaveLength(7);
        const steps = half.notes.map(x => x.step);
        expect(steps).toContain(0);
        expect(steps).toContain(15);
        // The quiet offbeat sixteenths go first.
        expect(steps).not.toContain(7);
        expect(steps).not.toContain(11);
        expect(thinOut(busy, synth(), 1).notes.map(x => x.step)).toEqual([0, 15]);
        expect(thinOut(busy, synth(), 0).removed).toBe(0);
    });

    it("stutter repeats the last beat's first slice at the chosen rate", () => {
        const line = [n(0, 0, 4), n(3, 8, 6), n(4, 12, 1, 0.6), n(5, 14, 1)];
        const s16 = stutter(line, synth(), "16th");
        expect(s16.filter(x => time(x) >= 12).map(x => [x.row, time(x)])).toEqual([[4, 12], [4, 13], [4, 14], [4, 15]]);
        // The held note ringing into the stutter is cut where it starts.
        expect(s16.find(x => x.step === 8)!.length).toBe(4);
        const s32 = stutter(line, synth(), "32nd");
        expect(s32.filter(x => time(x) >= 12).map(time)).toEqual([12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5]);
        expect(s32.find(x => time(x) === 12.5)!.offset).toBe(0.5);
        expect(stutter(line, synth(), "8th").filter(x => time(x) >= 12).map(time)).toEqual([12, 14]);
        // Rising into the next bar.
        const vel = s16.filter(x => time(x) >= 12).map(x => x.velocity);
        expect(vel[3]).toBeGreaterThan(vel[0]);
    });

    it("stutter repeats the last notes played when the last beat starts empty", () => {
        const s = stutter([n(0, 0, 2), n(2, 10, 6)], synth(), "16th");
        expect(s.filter(x => time(x) >= 12).map(x => x.row)).toEqual([2, 2, 2, 2]);
    });

    it("octave spark adds a few short octave-up notes near the end and keeps the strong notes", () => {
        const bass = [n(0, 0, 4, 1), n(2, 4, 4, 0.8), n(1, 9, 3, 0.8), n(0, 12, 2, 0.9)];
        const r = octaveSpark(bass, synth(), 3);
        expect(r.added).toBe(2);
        const sparks = r.notes.filter(x => x.row >= 5);
        // An octave (5 rows of the pentatonic) above the note before each: row 1 at 11, row 0 at 15.
        expect(sparks.map(x => [x.row, x.step, x.length])).toEqual([[6, 11, 1], [5, 15, 1]]);
        // The strong note (on the beat) keeps its length and blocks a spark over it (step 13);
        // the weaker offbeat note ringing over a spark is cut to make room.
        expect(r.notes.find(x => x.step === 12)!.length).toBe(2);
        expect(r.notes.find(x => x.step === 9)!.length).toBe(2);
        expect(r.highestRow).toBe(6);
        expect(octaveSpark(bass, drums()).added).toBe(0);
    });

    it("answer keeps the first half, reverses its pitches, resolves home and moves an octave", () => {
        const phrase = [n(7, 0, 2), n(8, 2, 2), n(9, 4, 2), n(8, 6, 2), n(5, 8, 4), n(4, 12, 4)];
        const a = answerPhrase(phrase, synth(16, 10));
        expect(a.map(x => x.step)).toEqual([0, 2, 4, 6]);
        // First-half pitches 7 8 9 8 reversed to 8 9 8 7, ending on the phrase's first pitch (7),
        // then an octave (5 rows) down since the phrase sits high.
        expect(a.map(x => x.row)).toEqual([3, 4, 3, 2]);
        // No room below: the answer goes up instead.
        expect(answerPhrase([n(4, 0), n(6, 2), n(5, 4)], synth(16, 8)).map(x => x.row)).toEqual([10, 11, 9]);
        const low = answerPhrase([n(0, 0), n(1, 4), n(2, 8)], synth());
        expect(low.every(x => x.row >= 5)).toBe(true);
        expect(answerPhrase(phrase, drums())).toEqual([]);
    });

    it("kick lock stops bass notes at the kick and, with align, pulls near attacks onto it", () => {
        const bass = [n(0, 0, 6), n(2, 5, 2), n(3, 9, 2), n(1, 14, 4)];
        const kicks = [0, 4, 8, 12];
        const plain = kickLock(bass, kicks, synth(), false);
        expect(plain.notes.map(x => [x.step, x.length])).toEqual([[0, 4], [5, 2], [9, 2], [14, 2]]);
        expect(plain.changes.map(c => c.kind)).toEqual(["shortened", "shortened"]);
        const aligned = kickLock(bass, kicks, synth(), true);
        expect(aligned.notes.map(x => [x.step, x.length])).toEqual([[0, 4], [4, 3], [8, 3], [14, 2]]);
        expect(aligned.changes.filter(c => c.kind === "aligned").map(c => [c.fromStep, c.toStep])).toEqual([[5, 4], [9, 8]]);
        expect(kickLock([n(0, 0, 4)], kicks, synth(), true).changes).toEqual([]);
    });

    it("recognises kicks and snares on a rack by voice, name or MIDI note", () => {
        expect(isKickPad({ name: "Kick", voice: "kick" })).toBe(true);
        expect(isKickPad({ name: "Pad 6", voice: "", midi: 36 })).toBe(true);
        expect(isKickPad({ name: "808 BD", voice: "" })).toBe(true);
        expect(isKickPad({ name: "Snare", voice: "snare", midi: 38 })).toBe(false);
        expect(rollRows([{ name: "Kick", voice: "kick" }, { name: "Clap", voice: "clap" }, { name: "Snare", voice: "snare" }])).toEqual([2, 1]);
    });
});

describe("Arrangement moves", () => {
    it("a build accelerates from quarters to thirty-seconds with rising velocity and sweep", () => {
        const roll = buildRoll(4, 4, 1, { sweep: true, kickRow: 0, kicks: [0, 4, 8, 12, 16, 48, 52] });
        const snare = roll.filter(x => x.row === 1);
        const gaps = (bar: number) => {
            const t = snare.filter(x => time(x) >= bar * 16 && time(x) < (bar + 1) * 16).map(time);
            return t.slice(1).map((v, i) => v - t[i]);
        };
        expect(new Set(gaps(0))).toEqual(new Set([4]));
        expect(new Set(gaps(1))).toEqual(new Set([2]));
        expect(new Set(gaps(2))).toEqual(new Set([1]));
        expect(snare.filter(x => time(x) >= 56).map(time).slice(0, 3)).toEqual([56, 56.5, 57]);
        for (let i = 1; i < snare.length; i++) {
            expect(snare[i].velocity).toBeGreaterThanOrEqual(snare[i - 1].velocity);
            expect(snare[i].tone!).toBeGreaterThan(snare[i - 1].tone!);
        }
        // Kicks carry on under the roll but drop out for the last bar.
        expect(roll.filter(x => x.row === 0).map(x => x.step)).toEqual([0, 4, 8, 12, 16]);
        expect(buildRoll(2, 4, 1, { sweep: false }).every(x => x.tone === undefined)).toBe(true);
    });

    it("echo repeats fade and darken", () => {
        const e = echoRepeats([n(3, 0, 1, 1), n(4, 2, 1, 0.8)], 4, 4);
        expect(e.map(time)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
        const firsts = e.filter(x => x.row === 3);
        for (let i = 1; i < firsts.length; i++) {
            expect(firsts[i].velocity).toBeLessThan(firsts[i - 1].velocity);
            expect(firsts[i].tone!).toBeLessThan(firsts[i - 1].tone!);
        }
    });

    it("a phrase's ending falls back to its last notes when it ends on a held note", () => {
        const placed = [{ row: 1, time: 16, length: 2, velocity: 1 }, { row: 2, time: 26, length: 6, velocity: 0.7 }];
        expect(phraseEnding(placed, 32, 4).map(x => [x.row, x.step])).toEqual([[2, 0]]);
        expect(phraseEnding([...placed, { row: 5, time: 29.5, length: 1, velocity: 1 }], 32, 4).map(x => [x.row, time(x)])).toEqual([[5, 1.5]]);
    });

    it("carving a span trims, removes and splits clips, and a split keeps its place in the pattern", () => {
        let id = 0;
        const arr: ArrClip[] = [
            { id: "long", trackId: "t", patternId: "p", startStep: 0, lengthSteps: 64 },
            { id: "inside", trackId: "t", patternId: "p", startStep: 80, lengthSteps: 8 },
            { id: "other", trackId: "u", patternId: "q", startStep: 0, lengthSteps: 64 },
        ];
        carveRange(arr, new Set(["t"]), 28, 36, () => 12, () => `new-${++id}`);
        expect(arr.find(c => c.id === "long")).toMatchObject({ startStep: 0, lengthSteps: 28 });
        // 36 steps in is a whole number of 12-step loops, so the second half needs no offset.
        expect(arr.find(c => c.id === "new-1")).toMatchObject({ startStep: 36, lengthSteps: 28 });
        expect(arr.find(c => c.id === "new-1")!.offsetSteps).toBeUndefined();
        expect(arr.find(c => c.id === "other")!.lengthSteps).toBe(64);
        carveRange(arr, new Set(["t"]), 78, 96, () => 12, () => "x");
        expect(arr.some(c => c.id === "inside")).toBe(false);
        // A left trim at step 40 of a 12-step pattern starts 4 steps in.
        carveRange(arr, new Set(["t"]), 30, 40, () => 12, () => "y");
        expect(arr.find(c => c.id === "new-1")).toMatchObject({ startStep: 40, lengthSteps: 24, offsetSteps: 4 });
    });

    it("a clip with an offset plays its pattern from partway in, exactly where the uncut clip would", () => {
        const pattern = { id: "p", name: "P", steps: 12, notes: [n(0, 0), n(1, 5), n(2, 9)] };
        const track = { id: "t", channel: 0, kind: "synth" as const, rows: 4, patterns: [pattern], activePatternId: "p", muted: false, solo: false };
        const whole: ArrProject = { bpm: 120, stepsPerBeat: 4, songBars: 4, snap: "bar", tracks: [track], arrangement: [{ id: "a", trackId: "t", patternId: "p", startStep: 0, lengthSteps: 48 }] };
        const before = expandArrangement(whole, { respectMuteSolo: false }).map(x => [x.startStep, x.note.row]);
        carveRange(whole.arrangement, new Set(["t"]), 20, 20, () => 12, () => "b");
        carveRange(whole.arrangement, new Set(["t"]), 19, 21, () => 12, () => "b");
        const after = expandArrangement(whole, { respectMuteSolo: false }).map(x => [x.startStep, x.note.row]);
        expect(after).toEqual(before.filter(([s]) => s < 19 || s >= 21));
    });

    it("the section boundary is the nearest bar line", () => {
        expect([nearestBar(0, 4), nearestBar(7, 4), nearestBar(9, 4), nearestBar(64, 4)]).toEqual([0, 0, 16, 64]);
        expect(metricWeight(0, 4)).toBe(1);
        expect(metricWeight(8, 4)).toBe(0.75);
        expect(metricWeight(2, 4)).toBe(0.5);
        expect(metricWeight(3, 4)).toBe(0.3);
    });
});
