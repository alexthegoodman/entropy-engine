import { describe, expect, it } from "vitest";
import {
    applySheetEdit, fingerStep, noteName, parseTab, polyphonyPlan, sheetHeader, songToSheetCells, songToTabText, stepMidi,
    stringOfSheetCol, type EditOutcome, type ParseResult,
} from "../src/apps/tabs/tab_model";
import {
    OnsetTracker, PracticeSession, defaultPracticeOptions, type PracticeEvent, type PracticeMode,
} from "../src/apps/tabs/tab_practice";
import { EXAMPLE_TABS } from "../src/apps/tabs/tab_songs";
import { parseFeature } from "./daw_test_world";

const midiOf = (name: string) => {
    const m = /^([A-G])(#?)(-?\d+)$/.exec(name);
    if (!m) throw new Error(`not a note: ${name}`);
    const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    return (parseInt(m[3], 10) + 1) * 12 + base[m[1]] + (m[2] ? 1 : 0);
};
const notes = (text: string) => text.split(" ").filter(Boolean).map(midiOf);
const names = (midi: number[]) => midi.map(noteName).join(" ");
/** The string a tab calls "e", "B", ... as the engine numbers it (0 = low E). */
const STRING_BY_NAME: Record<string, number> = { E: 0, A: 1, D: 2, G: 3, B: 4, e: 5 };

/** 1-based step numbers in events, as a player reads them. */
function eventText(e: PracticeEvent): string {
    switch (e.type) {
        case "hit": return e.offsetMs === null ? `hit ${e.step + 1}` : `hit ${e.step + 1} ${e.offsetMs >= 0 ? "+" : ""}${e.offsetMs}`;
        case "partial": return `partial ${e.step + 1}`;
        case "miss": return `miss ${e.step + 1}`;
        case "wrong": return `wrong ${noteName(e.note)}`;
        case "due": return `due ${e.step + 1}`;
        case "beat": return `beat ${e.beat}`;
        case "advance": return `advance ${e.step + 1}`;
        default: return e.type;
    }
}

describe("Guitar Tabs: reading, reviewing and grading a tab (production modules)", () => {
    for (const scenario of parseFeature("guitar_tabs")) {
        it(scenario.name, () => {
            let text = "";
            let parsed: ParseResult | null = null;
            let first: ParseResult | null = null;
            let edit: EditOutcome | null = null;
            let session: PracticeSession | null = null;
            let mode: PracticeMode = "wait";
            let events: PracticeEvent[] = [];
            let tracker: OnsetTracker | null = null;
            let practice: { tempo: number; countIn: number; lenient: boolean; loop: [number, number] | null } = { tempo: 100, countIn: 4, lenient: true, loop: null };
            const song = () => parsed!.song;
            const step = (n: number) => song().steps[n - 1];

            for (const s of scenario.steps) {
                let m: RegExpExecArray | null;
                if ((m = /^the example tab "(.*)"(?: in "(\w+)" practice(?: at (\d+) percent tempo with a (\d+) beat count-in)?(?:, looping steps (\d+) to (\d+))?( without lenient chords)?)?$/.exec(s))) {
                    const ex = EXAMPLE_TABS.find(e => e.id === m![1]);
                    if (!ex) throw new Error(`no example ${m[1]}`);
                    text = ex.text;
                    session = null;
                    if (m[2]) {
                        mode = m[2] as PracticeMode;
                        practice = {
                            tempo: m[3] ? +m[3] : 100, countIn: m[4] ? +m[4] : 4, lenient: !m[7],
                            loop: m[5] ? [+m[5] - 1, +m[6] - 1] : null,
                        };
                        parsed = parseTab(text);
                    }
                } else if ((m = /^the tab "(.*)"$/.exec(s))) {
                    text = m[1].split("/").join("\n");
                } else if (s === "it is parsed") {
                    parsed = parseTab(text);
                } else if ((m = /^there are (\d+) steps in (\d+) bars and no warnings$/.exec(s))) {
                    expect(parsed!.warnings).toEqual([]);
                    expect(song().steps.length).toBe(+m[1]);
                    expect(parsed!.bars).toBe(+m[2]);
                } else if ((m = /^there are (\d+) steps and a warning mentioning "(.*)"$/.exec(s))) {
                    expect(song().steps.length).toBe(+m[1]);
                    expect(parsed!.warnings.join(" ")).toContain(m[2]);
                } else if ((m = /^the title is "(.*)" at (\d+) BPM$/.exec(s))) {
                    expect(song().title).toBe(m[1]);
                    expect(song().bpm).toBe(+m[2]);
                } else if ((m = /^step (\d+) plays "(\S+)" on the (\w) string at fret (\d+) in bar (\d+) for ([\d.]+) beats$/.exec(s))) {
                    const st = step(+m[1]);
                    expect(names(stepMidi(song(), st))).toBe(m[2]);
                    expect(st.notes).toEqual([expect.objectContaining({ string: STRING_BY_NAME[m[3]], fret: +m[4] })]);
                    expect(st.bar).toBe(+m[5]);
                    expect(st.beats).toBe(+m[6]);
                } else if ((m = /^step (\d+) sounds "(.*?)"(?: with the low E string muted| with strings E and A muted)?$/.exec(s))) {
                    const st = step(+m[1]);
                    expect(names(stepMidi(song(), st))).toBe(m[2]);
                    if (s.includes("low E string muted")) expect(st.muted).toEqual([0]);
                    if (s.includes("strings E and A muted")) expect(st.muted).toEqual([0, 1]);
                } else if ((m = /^every step lasts ([\d.]+) beats$/.exec(s))) {
                    expect(song().steps.map(x => x.beats)).toEqual(song().steps.map(() => +m![1]));
                } else if ((m = /^the plan is (pick|chord) mode throughout$/.exec(s))) {
                    expect(new Set(polyphonyPlan(song()))).toEqual(new Set([m[1]]));
                } else if ((m = /^the plan is "(.*)"$/.exec(s))) {
                    expect(polyphonyPlan(song()).join(" ")).toBe(m[1]);
                } else if ((m = /^the tuning is "(.*)"$/.exec(s))) {
                    expect(names(song().tuning)).toBe(m[1]);
                } else if ((m = /^the sheet header reads "(.*)"$/.exec(s))) {
                    expect(sheetHeader(song()).join(", ")).toBe(m[1]);
                    const header = songToSheetCells(song()).filter(c => c.row === 0).map(c => c.text);
                    expect(header.join(", ")).toBe(m[1]);
                } else if ((m = /^sheet row (\d+) reads "(.*)"$/.exec(s))) {
                    const row = +m[1];
                    const cells = songToSheetCells(song()).filter(c => c.row === row);
                    const texts = Array.from({ length: 11 }, (_, col) => cells.find(c => c.col === col)?.text ?? "");
                    expect(texts.join(", ")).toBe(m[2]);
                } else if ((m = /^sheet row (\d+) column "(.*)" is set to "(.*)"$/.exec(s))) {
                    const col = sheetHeader(song()).indexOf(m[2]);
                    expect(col).toBeGreaterThanOrEqual(0);
                    edit = applySheetEdit(song(), +m[1], col, m[3]);
                } else if ((m = /^the edit is accepted and step (\d+) sounds "(.*)"$/.exec(s))) {
                    expect(edit).toEqual({ ok: true });
                    expect(names(stepMidi(song(), step(+m[1])))).toBe(m[2]);
                } else if ((m = /^the edit is accepted and there are (\d+) steps$/.exec(s))) {
                    expect(edit).toEqual({ ok: true });
                    expect(song().steps.length).toBe(+m[1]);
                } else if ((m = /^the edit is accepted and the plan for step (\d+) is "(.*)"$/.exec(s))) {
                    expect(edit).toEqual({ ok: true });
                    expect(polyphonyPlan(song())[+m[1] - 1]).toBe(m[2]);
                } else if ((m = /^the edit is refused with "(.*)"$/.exec(s))) {
                    expect(edit!.ok).toBe(false);
                    expect(edit!.error).toContain(m[1]);
                } else if (s === "it is written out as tab and parsed again") {
                    first = parsed;
                    parsed = parseTab(songToTabText(first!.song));
                } else if (s === "both readings have the same notes, bars and beats") {
                    const shape = (r: ParseResult) => r.song.steps.map(x => ({ notes: x.notes.map(n => [n.string, n.fret]), bar: x.bar, beats: x.beats }));
                    expect(parsed!.warnings).toEqual([]);
                    expect(shape(parsed!)).toEqual(shape(first!));
                    expect(parsed!.song.tuning).toEqual(first!.song.tuning);
                    expect(parsed!.song.bpm).toBe(first!.song.bpm);
                } else if ((m = /^steps (\d+) to (\d+) are fingered "(.*)"$/.exec(s))) {
                    const got: number[] = [];
                    for (let i = +m[1]; i <= +m[2]; i++) got.push(...fingerStep(song(), i - 1).map(n => n.finger));
                    expect(got.join(", ")).toBe(m[3]);
                } else if ((m = /^step (\d+) is fingered "(.*)" lowest string first$/.exec(s))) {
                    expect(fingerStep(song(), +m[1] - 1).map(n => n.finger).join(" ")).toBe(m[2]);
                } else if ((m = /^the practice starts at (\d+) ms$/.exec(s))) {
                    const o = { ...defaultPracticeOptions(song()), mode, tempoPct: practice.tempo, countIn: practice.countIn, lenientChords: practice.lenient };
                    if (practice.loop) { o.fromStep = practice.loop[0]; o.toStep = practice.loop[1]; o.loop = true; }
                    session = new PracticeSession(song(), o);
                    session.start(+m[1]);
                    events = [];
                } else if ((m = /^the current step is (\d+)$/.exec(s))) {
                    expect(session!.currentStep(0) + 1).toBe(+m[1]);
                } else if ((m = /^"(.*)" is played at (\d+) ms(?: with (\d+) ms of latency)?$/.exec(s))) {
                    events = session!.play(notes(m[1]), +m[2], m[3] ? +m[3] : 0);
                } else if ((m = /^the events are "(.*)"(?: and the current step is (\d+))?$/.exec(s))) {
                    expect(events.map(eventText).join(", ")).toBe(m[1]);
                    if (m[2]) expect(session!.currentStep(0) + 1).toBe(+m[2]);
                } else if (s === "there are no events") {
                    expect(events.map(eventText)).toEqual([]);
                } else if ((m = /^the stats read (\d+) hits, (\d+) misses, (\d+) wrong, streak (\d+)$/.exec(s))) {
                    const st = session!.stats();
                    expect([st.hits, st.misses, st.wrong, st.streak]).toEqual([+m[1], +m[2], +m[3], +m[4]]);
                } else if ((m = /^the first step is due at (\d+) ms$/.exec(s)) || (m = /^step (\d+) is due at (\d+) ms$/.exec(s))) {
                    const n = m.length === 3 ? +m[1] - 1 : 0;
                    const at = m.length === 3 ? +m[2] : +m[1];
                    expect(session!.stepTimeMs(n)! + practice.countIn * session!.msPerBeat).toBe(at);
                } else if ((m = /^time reaches (\d+) ms$/.exec(s))) {
                    events = session!.tick(+m[1]);
                } else if ((m = /^the events include "(.*)"$/.exec(s))) {
                    // In this order, others may come between.
                    const got = events.map(eventText);
                    let from = 0;
                    for (const want of m[1].split(", ")) {
                        const at = got.indexOf(want, from);
                        expect(at, `${want} in ${got.join(", ")}`).toBeGreaterThanOrEqual(0);
                        from = at + 1;
                    }
                } else if (s === "an onset tracker") {
                    tracker = new OnsetTracker();
                } else if ((m = /^reading "(.*)" with (\d+) note-ons(?: at pitch "(\S+)" off by (\d+) cents)? gives "(.*)"$/.exec(s))) {
                    const pitch = m[3] ? { note: midiOf(m[3]), cents: +m[4] } : null;
                    expect(names(tracker!.update(notes(m[1]), +m[2], pitch))).toBe(m[5]);
                } else {
                    throw new Error(`Unmatched step: ${s}`);
                }
            }
            void stringOfSheetCol;
        });
    }
});
