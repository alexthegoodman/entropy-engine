import { describe, expect, it } from "vitest";
import {
    SignalHints, bendCents, diagnosticsLines, noteName, readGuitarPrefs, takeToPattern,
    type GuitarDiag, type TakeNote, type TakePattern,
} from "../src/apps/daw_guitar";
import { parseFeature } from "./daw_test_world";

const midiOf = (name: string) => {
    const m = /^([A-G])(#?)(-?\d+)$/.exec(name);
    if (!m) throw new Error(`not a note: ${name}`);
    const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    return (parseInt(m[3], 10) + 1) * 12 + base[m[1]] + (m[2] ? 1 : 0);
};

// "E3 0.0-0.4, G3 0.5-0.9 with 12 bend points"
const parseTake = (text: string): TakeNote[] =>
    text.split(",").map(s => s.trim()).filter(Boolean).map(s => {
        const m = /^(\S+) ([\d.]+)-([\d.]+)(?: with (\d+) bend points)?$/.exec(s);
        if (!m) throw new Error(`cannot read take note: ${s}`);
        return {
            note: midiOf(m[1]), velocity: 100, startS: parseFloat(m[2]), endS: parseFloat(m[3]),
            bends: Array.from({ length: m[4] ? parseInt(m[4], 10) : 0 }, (_, i) => [i * 0.01, 0] as [number, number]),
        };
    });

describe("The DAW's guitar input logic (production module)", () => {
    for (const scenario of parseFeature("daw_guitar")) {
        it(scenario.name, () => {
            let take: TakeNote[] = [];
            let bpm = 120, spb = 4;
            let pattern: TakePattern | null = null;
            let prefsJson = "";
            let prefs: ReturnType<typeof readGuitarPrefs> | null = null;
            const hints = new SignalHints();
            let lines: string[] = [];
            let diag: GuitarDiag | null = null;

            for (const step of scenario.steps) {
                let m: RegExpExecArray | null;
                if ((m = /^a take at (\d+) BPM with (\d+) steps per beat: "(.*)"$/.exec(step))) {
                    bpm = +m[1]; spb = +m[2]; take = parseTake(m[3]);
                } else if (step === "the take is turned into a pattern") {
                    pattern = takeToPattern(take, bpm, spb);
                } else if ((m = /^the pattern is rooted on note (\d+) with (\d+) rows$/.exec(step))) {
                    expect(pattern!.rootNote).toBe(+m[1]);
                    expect(pattern!.rows).toBe(+m[2]);
                } else if ((m = /^the pattern has these cells: "(.*)"$/.exec(step))) {
                    const want = m[1].split(",").map(s => s.trim().split(":").map(Number));
                    const got = pattern!.cells.map(c => [c.row, c.step, c.length]).sort((a, b) => a[1] - b[1]);
                    expect(got).toEqual(want);
                } else if ((m = /^the pattern is (\d+) steps long$/.exec(step))) {
                    expect(pattern!.steps).toBe(+m[1]);
                } else if ((m = /^the pattern has (\d+) bend points that the note cells cannot hold$/.exec(step))) {
                    expect(pattern!.bendPoints).toBe(+m[1]);
                    expect(Object.keys(pattern!.cells[0])).not.toContain("bends");
                } else if (step === "there is no pattern") {
                    expect(pattern).toBeNull();
                } else if ((m = /^saved guitar preferences '(.*)'$/.exec(step))) {
                    prefsJson = m[1];
                } else if (step === "the preferences are read") {
                    prefs = readGuitarPrefs(JSON.parse(prefsJson));
                } else if (step === "the mode is accurate and the bend range is 12 and the channel is 0") {
                    expect([prefs!.mode, prefs!.bendRange, prefs!.channel]).toEqual(["accurate", 12, 0]);
                } else if (step === "the waveform is the default") {
                    expect(prefs!.waveform).toBe("saw");
                } else if ((m = /^the device is "(.*)" on "(.*)"$/.exec(step))) {
                    expect([prefs!.device, prefs!.host]).toEqual([m[1], m[2]]);
                } else if ((m = /^notes played at these peak levels in dBFS: "(.*)"$/.exec(step))) {
                    for (const db of m[1].split(/\s+/).map(Number)) {
                        for (let i = 0; i < 5; i++) hints.update(true, db - (i === 2 ? 0 : 6));
                        hints.update(true, db);
                        hints.update(false, -90);
                    }
                } else if (step === "the input is reported as too quiet") {
                    expect(hints.tooQuiet()).toBe(true);
                } else if (step === "the input is not reported as too quiet") {
                    expect(hints.tooQuiet()).toBe(false);
                } else if ((m = /^a reading of (\S+) sharp by (\d+) cents at ([\d.]+) Hz with the bend at (\d+) on a (\d+) semitone range$/.exec(step))) {
                    diag = {
                        levelDb: -20, inputPeakDb: -12, clipped: false, freqHz: +m[3], confidence: 0.97, note: midiOf(m[1]), cents: +m[2],
                        state: "playing", velocity: 96, bend: +m[4], pipelineLatencyMs: 14.2, bufferMs: 2.7, bufferFrames: 128, sampleRate: 48000,
                        callbacks: 100, overruns: 0, streamErrors: 0, maxCallbackUs: 90, meanCallbackUs: 15, droppedBends: 0, droppedEvents: 0,
                        notes: 3, noiseRejects: 0, octaveRejects: 0, octaveCorrections: 0, slides: 0, repicks: 0,
                    };
                    bpm = +m[5];
                } else if (step === "the diagnostics are formatted") {
                    lines = diagnosticsLines(diag!, bpm);
                } else if ((m = /^the readout mentions (.*)$/.exec(step))) {
                    const text = lines.join("\n");
                    for (const word of m[1].match(/"([^"]+)"/g)!.map(s => s.slice(1, -1))) expect(text).toContain(word);
                } else {
                    throw new Error(`no step for: ${step}`);
                }
            }
        });
    }

    it("names notes and converts bend to cents", () => {
        expect(noteName(40)).toBe("E2");
        expect(noteName(69)).toBe("A4");
        expect(bendCents(8192, 2)).toBe(0);
        expect(bendCents(16383, 2)).toBeCloseTo(200, 0);
        expect(bendCents(0, 12)).toBe(-1200);
    });
});
