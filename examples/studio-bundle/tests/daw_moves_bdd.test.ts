import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, parseFeature } from "./daw_test_world";

// tests/features/daw_moves.feature, run against the production addon: the knobs and buttons are
// the real widget callbacks, and the stand-in engine records the effects, notes and exports.

const BAR = 16;
const STEP_S = 60 / 96 / 4; // the starter song's step, in seconds

describe("Quick knobs and moves (production addon callbacks)", () => {
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); delete (globalThis as any).Entropy; });

    for (const scenario of parseFeature("daw_moves")) {
        it(scenario.name, async () => {
            vi.resetModules();
            let world = createWorld();
            vi.spyOn(Date, "now").mockImplementation(() => world.w.clock);
            const w = new Proxy({} as ReturnType<typeof createWorld>["w"], {
                get: (_, key) => (world.w as any)[key],
                set: (_, key, value) => { (world.w as any)[key] = value; return true; },
            });
            let remembered = "";
            let playedAt = 0;

            const state = () => w.tools.get("daw_get_state")!({});
            const trackNamed = (name: string) => {
                const t = state().tracks.find((t: any) => t.name === name);
                if (!t) throw new Error(`no track named ${name}`);
                return t;
            };
            const click = (id: string) => {
                world.render();
                if (!w.buttons.has(id)) throw new Error(`no button ${id}; have ${[...w.buttons.keys()].join(", ")}`);
                if (id === "transport_toggle") playedAt = w.clock;
                w.buttons.get(id)!();
                world.render();
            };
            // The kinds of effect on a track's bus, in chain order.
            const chain = (name: string) => (w.buses.get(trackNamed(name).id)?.effectIds ?? [])
                .map((id: string) => /^(delay|reverb)-/.exec(id)?.[1] ?? w.effects.get(id)?.kind ?? `unknown:${id}`);
            const effectOf = (kind: string, name: string) => {
                const id = (w.buses.get(trackNamed(name).id)?.effectIds ?? []).find((id: string) => w.effects.get(id)?.kind === kind);
                if (!id) throw new Error(`${name} has no ${kind} on its bus: ${chain(name).join(", ")}`);
                return w.effects.get(id);
            };
            const settled = () => { world.advance(400); return w.saved; };
            const savedPattern = (id: string) => {
                for (const t of settled().tracks) { const p = t.patterns.find((p: any) => p.id === id); if (p) return p; }
                throw new Error(`no pattern ${id}`);
            };
            const patternByName = (track: string, name: string) => {
                const t = settled().tracks.find((t: any) => t.name === track);
                return t.patterns.find((p: any) => p.name === name);
            };
            const clipsOf = (track: string) => {
                const project = settled();
                const t = project.tracks.find((t: any) => t.name === track);
                return project.arrangement.filter((c: any) => c.trackId === t.id)
                    .map((c: any) => ({ ...c, pattern: t.patterns.find((p: any) => p.id === c.patternId)?.name }));
            };
            const at = (bar: string, beat?: string) => (+bar - 1) * BAR + (beat ? (+beat - 1) * 4 : 0);
            const barMs = () => w.arrangement.options.barMs as number;
            const lastExport = () => w.exports.at(-1)!;
            const hihatOnStep = (step: number) => lastExport()
                .filter(e => e.waveform === "hihat" && e.startTime >= step * STEP_S - 1e-9 && e.startTime < (step + 1) * STEP_S)
                .sort((a, b) => a.startTime - b.startTime)[0];
            const callTool = (name: string, args: any) => { world.render(); w.lastToolResult = w.tools.get(name)!(args); world.render(); };

            const steps: [RegExp, (...m: string[]) => void | Promise<void>][] = [
                [/^the DAW is open$/, async () => { await world.open(); }],
                [/^I reopen the DAW$/, async () => {
                    const saved = settled();
                    // A fresh import, so the addon starts over from the saved project.
                    vi.resetModules();
                    world = createWorld(saved);
                    await world.open();
                }],
                [/^I select the track "(.+)"$/, name => {
                    const i = state().tracks.findIndex((t: any) => t.name === name);
                    click(`select_track_${i}`);
                }],
                [/^I select the clip "(.+)"$/, id => {
                    world.render();
                    const lane = (w.arrangement.tracks as any[]).find(t => t.clips.some((c: any) => c.id === id));
                    w.arrangement.onClipSelected(lane.id, id);
                    world.render();
                }],
                [/^I turn the knob "(.+)" to ([\d.]+)$/, (id, v) => {
                    world.render();
                    const knob = w.knobs.find(k => k.id === id);
                    if (!knob) throw new Error(`no knob ${id}; have ${w.knobs.map(k => k.id).join(", ")}`);
                    knob.onChange(v);
                    world.render();
                }],
                [/^the knob "(.+)" shows ([\d.]+)$/, (id, v) => { world.render(); expect(w.knobs.find(k => k.id === id)?.value).toBe(+v); }],
                [/^I choose option (\d+) of "(.+)"$/, (i, id) => { world.render(); w.dropdowns.get(id).onChange(i); world.render(); }],
                [/^I untick "(.+)"$/, label => { world.render(); w.checkboxes.get(label).onChange(false); world.render(); }],
                [/^I click "(.+)"$/, id => click(id)],
                [/^I advance (\d+) milliseconds$/, ms => world.advance(+ms)],
                [/^I park the playhead at bar (\d+) beat (\d+)$/, (bar, beat) => {
                    world.render();
                    w.arrangement.onSeek(at(bar, beat) / BAR * barMs());
                    world.render();
                }],
                [/^I call the tool "(.+)" with (\{.*\})$/, (name, json) => callTool(name, JSON.parse(json))],
                [/^the tool status mentions "(.+)"$/, text => {
                    expect(w.lastToolResult.success, JSON.stringify(w.lastToolResult)).toBe(true);
                    expect(w.lastToolResult.status).toContain(text);
                }],

                [/^the bus of "(.+)" chains "(.+)"$/, (name, list) => expect(chain(name)).toEqual(list.split(", "))],
                [/^the "(.+)" effect of "(.+)" has amount ([\d.]+)(?: at (\d+) bpm)?$/, (kind, name, amount, bpm) => {
                    const fx = effectOf(kind, name);
                    expect(fx.amount).toBeCloseTo(+amount, 6);
                    if (bpm) expect(fx.bpm).toBe(+bpm);
                }],
                [/^the "(.+)" effect of "(.+)" has pattern (\d+)$/, (kind, name, pattern) => expect(effectOf(kind, name).pattern).toBe(+pattern)],
                [/^the "(.+)" effect of "(.+)" is (\d+) beats? into the bar$/, (kind, name, beat) => expect(effectOf(kind, name).beat).toBeCloseTo(+beat, 6)],

                [/^the voice of "(.+)" has a cutoff below (\d+) Hz and resonance above ([\d.]+)$/, (name, hz, q) => {
                    const v = trackNamed(name).voice;
                    expect(v.cutoff).toBeLessThan(+hz);
                    expect(v.resonance).toBeGreaterThan(+q);
                }],
                [/^the voice of "(.+)" has a cutoff of (\d+) Hz and resonance ([\d.]+)$/, (name, hz, q) => {
                    const v = trackNamed(name).voice;
                    expect([v.cutoff, v.resonance]).toEqual([+hz, +q]);
                }],
                [/^the last note on "(.+)" played with a filter envelope and drive$/, name => {
                    const note = w.played.filter(p => p.id === trackNamed(name).id).at(-1);
                    expect(note, `${name} played`).toBeDefined();
                    expect(note!.cfg.filterEnv).toBeGreaterThan(1);
                    expect(note!.cfg.drive).toBeGreaterThan(1);
                }],

                [/^the hihat on step 1 sounded at least (\d+) ms after Play$/, ms => {
                    const hats = w.played.filter(p => p.cfg.waveform === "hihat").map(p => p.at! - playedAt);
                    expect(hats.length).toBeGreaterThanOrEqual(2);
                    expect(hats[1]).toBeGreaterThanOrEqual(+ms);
                }],
                [/^the export's hihat on step (\d+) starts a third of a step late$/, step => {
                    expect(hihatOnStep(+step).startTime / STEP_S - +step).toBeCloseTo(1 / 3, 6);
                }],
                [/^the export's hihat on step (\d+) starts less than a tenth of a step late$/, step => {
                    const late = hihatOnStep(+step).startTime / STEP_S - +step;
                    expect(late).toBeGreaterThan(0);
                    expect(late).toBeLessThan(0.1);
                }],
                [/^the last two exports are identical$/, () => expect(JSON.stringify(w.exports.at(-1))).toBe(JSON.stringify(w.exports.at(-2)))],
                [/^some of the export's drum hits are off the grid by less than an eighth of a step$/, () => {
                    const off = lastExport().filter(e => e.track === "trk-drums").map(e => {
                        const s = e.startTime / STEP_S;
                        return Math.abs(s - Math.round(s));
                    });
                    expect(off.filter(d => d > 0.001).length).toBeGreaterThan(off.length / 2);
                    expect(Math.max(...off)).toBeLessThan(0.125);
                }],
                [/^the export has a bus for "(.+)" with gain ([\d.]+) and effects "(.+)"$/, (name, gain, fx) => {
                    const bus = w.busExports.at(-1)!.find(b => b.track === trackNamed(name).id);
                    expect(bus.gain).toBeCloseTo(+gain, 6);
                    expect(bus.effects.map((e: any) => e.kind)).toEqual(fx.split(", "));
                }],
                [/^the export's "(.+)" notes name their track and carry only their own velocity$/, name => {
                    const t = trackNamed(name);
                    const velocities = new Set(t.patterns.flatMap((p: any) => savedPattern(p.id).notes.map((n: any) => n.velocity)));
                    const notes = lastExport().filter(e => e.track === t.id);
                    expect(notes.length).toBeGreaterThan(0);
                    for (const e of notes) expect(velocities.has(e.gain), `gain ${e.gain}`).toBe(true);
                }],
                [/^the export's bus for "(.+)" is silent from bar (\d+) beat (\d+) to bar (\d+)$/, (name, b1, beat, b2) => {
                    const bus = w.busExports.at(-1)!.find(b => b.track === trackNamed(name).id);
                    expect(bus.silences).toHaveLength(1);
                    expect(bus.silences[0][0]).toBeCloseTo(at(b1, beat) * STEP_S, 6);
                    expect(bus.silences[0][1]).toBeCloseTo(at(b2) * STEP_S, 6);
                }],

                [/^I remember the notes of the pattern "(.+)"$/, id => {
                    // Nothing has been saved yet on a fresh open: an empty track edit writes the project.
                    const owner = state().tracks.find((t: any) => t.patterns.some((p: any) => p.id === id));
                    callTool("daw_set_track_params", { trackId: owner.id });
                    remembered = JSON.stringify(savedPattern(id).notes);
                }],
                [/^the pattern "(.+)" has changed$/, id => expect(JSON.stringify(savedPattern(id).notes)).not.toBe(remembered)],
                [/^the pattern "(.+)" is as I remembered it$/, id => expect(JSON.stringify(savedPattern(id).notes)).toBe(remembered)],
                [/^the pattern "(.+)" has fewer notes than (\d+)$/, (id, count) => expect(savedPattern(id).notes.length).toBeLessThan(+count)],
                [/^the pattern "(.+)" still has a note on row (\d+) at step (\d+)$/, (id, row, step) =>
                    expect(savedPattern(id).notes.some((n: any) => n.row === +row && n.step === +step)).toBe(true)],
                [/^I see a label containing "(.+)"$/, text => { world.render(); expect(w.labels.some(l => l.includes(text)), `${text} in ${w.labels.join(" | ")}`).toBe(true); }],
                [/^I see the label "(.+)"$/, text => { world.render(); expect(w.labels).toContain(text); }],

                [/^"(.+)" has a clip playing "(.+)" from bar (\d+) to bar (\d+)$/, (track, pattern, from, to) => {
                    const clips = clipsOf(track).filter((c: any) => c.pattern === pattern);
                    expect(clips.map((c: any) => [c.startStep, c.startStep + c.lengthSteps])).toEqual([[at(from), at(to)]]);
                }],
                [/^"(.+)" has no clip playing "(.+)"$/, (track, pattern) => expect(clipsOf(track).filter((c: any) => c.pattern === pattern)).toEqual([])],
                [/^no other "(.+)" clip plays between bar (\d+) and bar (\d+)$/, (track, from, to) => {
                    const others = clipsOf(track).filter((c: any) => !c.pattern.startsWith("Build") && c.startStep < at(to) && c.startStep + c.lengthSteps > at(from));
                    expect(others).toEqual([]);
                }],
                [/^no "(.+)" clip plays between bar (\d+) beat (\d+) and bar (\d+)$/, (track, b1, beat, b2) => {
                    const inside = clipsOf(track).filter((c: any) => c.startStep < at(b2) && c.startStep + c.lengthSteps > at(b1, beat));
                    expect(inside).toEqual([]);
                }],
                [/^the pattern "(.+)" on "(.+)" has thirty-second notes at the end and a rising filter sweep$/, (name, track) => {
                    const notes = patternByName(track, name).notes.filter((n: any) => n.tone !== undefined);
                    expect(notes.some((n: any) => n.offset === 0.5 && n.step >= 56)).toBe(true);
                    expect(notes.at(-1).tone).toBeGreaterThan(notes[0].tone);
                    expect(notes.at(-1).velocity).toBeGreaterThan(notes[0].velocity);
                }],
                [/^the pattern "(.+)" on "(.+)" fades and darkens$/, (name, track) => {
                    const notes = patternByName(track, name).notes;
                    expect(notes.length).toBeGreaterThanOrEqual(4);
                    expect(notes.at(-1).velocity).toBeLessThan(notes[0].velocity);
                    expect(notes.at(-1).tone).toBeLessThan(notes[0].tone);
                }],

                [/^the piano roll shows notes of length "(.+)"$/, list => { world.render(); expect(w.piano.cells.map((c: any) => c.length).join(", ")).toBe(list); }],
                [/^the saved pattern "(.+)" has notes starting at "(.+)" of length "(.+)"$/, (id, starts, lengths) => {
                    const notes = savedPattern(id).notes;
                    expect(notes.map((n: any) => n.step).join(", ")).toBe(starts);
                    expect(notes.map((n: any) => n.length).join(", ")).toBe(lengths);
                }],
            ];

            for (const text of scenario.steps) {
                const step = steps.find(([re]) => re.test(text));
                if (!step) throw new Error(`No step definition for: ${text}`);
                await step[1](...step[0].exec(text)!.slice(1));
            }
        });
    }
});
