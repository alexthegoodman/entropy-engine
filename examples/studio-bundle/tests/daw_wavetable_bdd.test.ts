import { afterEach, describe, expect, it, vi } from "vitest";
import {
    WT_OPS, WT_PRESETS, WT_WAVEFORM, defaultWavetable, describeSettings, noteConfig, repairWavetable,
} from "../src/apps/daw_wavetable";
import { createWorld, parseFeature } from "./daw_test_world";

// --- The model, on its own -------------------------------------------------------------------------

describe("The wavetable model", () => {
    it("repairs a damaged saved wavetable instead of throwing", () => {
        const wt = repairWavetable({ preset: "nope", position: 9, unison: 40, detuneCents: -5, tool: "chisel", radius: "wide", frame: 999, auditionNote: 3, audition: "yes" });
        expect(wt.preset).toBe("saw");
        expect(wt.position).toBe(1);
        expect(wt.unison).toBe(7);
        expect(wt.detuneCents).toBe(0);
        expect(wt.tool).toBe("raise");
        expect(wt.radius).toBe(defaultWavetable().radius);
        expect(wt.frame).toBe(63);
        expect(wt.auditionNote).toBe(24);
        expect(wt.audition).toBe(false);
        expect(repairWavetable(null)).toEqual(defaultWavetable());
        expect(repairWavetable("garbage")).toEqual(defaultWavetable());
    });

    it("keeps a saved table and calls the preset custom when the preset is unknown", () => {
        const wt = repairWavetable({ data: "table:abc", preset: "made-up" });
        expect(wt.data).toBe("table:abc");
        expect(wt.preset).toBe("custom");
        expect(repairWavetable({ data: "" }).data).toBeUndefined();
    });

    it("turns a track and a note into the engine's config, with the track's own filter and envelope", () => {
        const wt = { ...defaultWavetable("vowels"), position: 0.6, unison: 3, lfoRate: 2 };
        const cfg = noteConfig("trk-x", { cutoff: 900, resonance: 2, attack: 0.1, decay: 0.2, sustain: 0.3, release: 0.4 }, wt, { freq: 220, velocity: 0.7, duration: 0.5, startTime: 3 });
        expect(cfg).toMatchObject({ table: "trk-x", freq: 220, velocity: 0.7, position: 0.6, unison: 3, lfoRate: 2, cutoff: 900, resonance: 2, attack: 0.1, decay: 0.2, sustain: 0.3, release: 0.4, duration: 0.5, startTime: 3 });
        expect("duration" in noteConfig("t", { cutoff: 1, resonance: 1, attack: 0, decay: 0, sustain: 1, release: 0 }, wt, { freq: 1, velocity: 1 })).toBe(false);
    });

    it("lists the engine's presets and the whole-table operations", () => {
        expect(WT_PRESETS.map(p => p.id)).toEqual(["sine", "saw", "square", "pwm", "vowels", "bell", "terrain", "glass"]);
        expect(WT_OPS.map(o => o.id)).toContain("normalize");
        expect(WT_WAVEFORM).toBe("wavetable");
        expect(Object.keys(describeSettings(defaultWavetable()))).toContain("position");
    });
});

// --- The addon, through its production callbacks ----------------------------------------------------

describe("The DAW's wavetable synth (production addon callbacks)", () => {
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); delete (globalThis as any).Entropy; });

    for (const scenario of parseFeature("daw_wavetable")) {
        it(scenario.name, async () => {
            vi.resetModules();
            let world = createWorld();
            vi.spyOn(Date, "now").mockImplementation(() => world.w.clock);
            const w = new Proxy({} as ReturnType<typeof createWorld>["w"], {
                get: (_, key) => (world.w as any)[key],
                set: (_, key, value) => { (world.w as any)[key] = value; return true; },
            });

            const state = () => w.tools.get("daw_get_state")!({});
            const trackIndex = (name: string) => {
                const i = state().tracks.findIndex((t: any) => t.name === name);
                if (i < 0) throw new Error(`no track named ${name}`);
                return i;
            };
            const trackId = (name: string) => state().tracks[trackIndex(name)].id as string;
            const click = (id: string) => {
                world.render();
                if (!w.buttons.has(id)) throw new Error(`no button ${id}; have ${[...w.buttons.keys()].join(", ")}`);
                w.buttons.get(id)!();
                world.render();
            };
            const selectTrack = (name: string) => click(`select_track_${trackIndex(name)}`);
            const callTool = (name: string, args: any) => { w.lastToolResult = w.tools.get(name)!(args); world.render(); };
            const settled = () => { world.advance(400); return w.saved; };
            const savedTrack = (name: string) => {
                const t = settled().tracks.find((t: any) => t.name === name);
                if (!t) throw new Error(`no saved track named ${name}`);
                return t;
            };
            const view = () => {
                world.render();
                const v = [...w.wavetableViews.values()][0];
                if (!v) throw new Error("the terrain widget is not drawn; the window shows: " + w.labels.join(" | "));
                return v;
            };
            const table = (name: string) => {
                const t = w.tables.get(trackId(name));
                if (!t) throw new Error(`the engine has no table for ${name}; it has ${[...w.tables.keys()].join(", ") || "none"}`);
                return t;
            };
            const windowShown = () => {
                world.render();
                const id = Object.keys(w.windowTitles).find(k => w.windowTitles[k] === "Wavetable")!;
                return w.windowVisible[id];
            };
            const heldOn = (name: string) => [...w.heldNotes.values()].filter(n => n.id === trackId(name) && !n.released);
            const notesOn = (name: string) => w.wavetableNotes.filter(n => n.id === trackId(name));
            const voicesOn = (name: string) => w.played.filter(p => p.id === trackId(name)).map(p => p.cfg.waveform);
            let builtInBefore = 0;

            const steps: [RegExp, (...m: string[]) => void | Promise<void>][] = [
                [/^the DAW is open$/, async () => { await world.open(); }],
                [/^"(.+)" is a wavetable track$/, name => { callTool("daw_set_track_params", { trackId: trackId(name), waveform: "wavetable" }); }],
                [/^the track "(.+)" is selected$/, name => selectTrack(name)],
                [/^the DAW was saved with a wavetable track whose table is garbage$/, async () => {
                    await world.open();
                    callTool("daw_set_track_params", { trackId: "trk-lead", waveform: "wavetable" });
                    callTool("daw_wavetable", { trackId: "trk-lead", action: "preset", preset: "vowels" });
                    const saved = JSON.parse(JSON.stringify(settled()));
                    saved.tracks.find((t: any) => t.id === "trk-lead").wavetable.data = "garbage";
                    vi.resetModules();
                    world = createWorld(saved);
                    await world.open();
                }],
                [/^the DAW is reopened$/, async () => {
                    const saved = settled();
                    vi.resetModules();
                    world = createWorld(saved);
                    await world.open();
                }],

                [/^the Wavetable window is hidden$/, () => expect(windowShown()).toBe(false)],
                [/^the Wavetable window is shown$/, () => expect(windowShown()).toBe(true)],
                [/^I click "(.+)"$/, id => click(id)],
                [/^I see the label "(.+)"$/, text => { world.render(); expect(w.labels, w.labels.join(" | ")).toContain(text); }],
                [/^I see a label containing "(.+)"$/, text => { world.render(); expect(w.labels.some(l => l.includes(text)), `${text} in ${w.labels.join(" | ")}`).toBe(true); }],
                [/^the Wavetable window offers to make "(.+)" a wavetable synth$/, name => {
                    world.render();
                    expect(w.labels).toContain(`${name} plays a ${state().tracks[trackIndex(name)].voice.waveform} oscillator.`);
                    expect(w.buttons.has("wt_make")).toBe(true);
                }],
                [/^the track "(.+)" is a wavetable track$/, name => expect(state().tracks[trackIndex(name)].voice.waveform).toBe("wavetable")],
                [/^no track is a wavetable track$/, () => expect(state().tracks.some((t: any) => t.voice?.waveform === "wavetable")).toBe(false)],
                [/^the terrain widget shows the table of "(.+)"$/, name => expect(view().table).toBe(trackId(name))],
                [/^the engine has a table for "(.+)" that started as "(.+)"$/, (name, preset) => expect(table(name).preset).toBe(preset)],
                [/^the engine table of "(.+)" started as "(.+)"$/, (name, preset) => expect(table(name).preset).toBe(preset)],
                [/^the engine has no tables$/, () => expect(w.tables.size).toBe(0)],
                [/^the engine removed the table of "(.+)"$/, name => {
                    // The id has to be read before the track is gone.
                    expect(w.removedTables).toContain(name === "Lead" ? "trk-lead" : name);
                }],
                [/^the engine table of "(.+)" was edited by "(.+)" then "(.+)"$/, (name, a, b) => expect(table(name).edits.slice(-2)).toEqual([a, b])],
                [/^the engine table of "(.+)" was edited by "(.+)"$/, (name, a) => expect(table(name).edits.at(-1)).toBe(a)],

                [/^I advance (\d+) milliseconds$/, ms => world.advance(+ms)],
                [/^I call the tool "(.+)" with (\{.*\})$/, (name, json) => callTool(name, JSON.parse(json))],
                [/^the tool succeeded$/, () => expect(w.lastToolResult.success, JSON.stringify(w.lastToolResult)).toBe(true)],
                [/^the tool failed saying "(.+)"$/, text => {
                    expect(w.lastToolResult.success).toBe(false);
                    expect(String(w.lastToolResult.error)).toContain(text);
                }],
                [/^the tool heard about (\d+) Hz and a brightness above (\d+) Hz$/, (hz, bright) => {
                    expect(Math.abs(w.lastToolResult.strongestHz - +hz)).toBeLessThan(2);
                    expect(w.lastToolResult.brightnessHz).toBeGreaterThan(+bright);
                }],
                [/^the tool heard a brightness below (\d+) Hz$/, bright => expect(w.lastToolResult.brightnessHz).toBeLessThan(+bright)],
                [/^the tool reports unison (\d+), position (\d+) and detune (\d+)$/, (u, p, d) => {
                    const s = w.lastToolResult.settings;
                    expect([s.unison, s.position, s.detuneCents]).toEqual([+u, +p, +d]);
                }],

                // ---- playing ----
                [/^the track "(.+)" has played wavetable notes$/, name => expect(notesOn(name).length).toBeGreaterThan(0)],
                [/^the track "(.+)" has not played the built-in voice "(.+)"$/, (name, voice) => expect(voicesOn(name)).not.toContain(voice)],
                [/^the track "(.+)" has played the built-in voice "(.+)"$/, (name, voice) => expect(voicesOn(name)).toContain(voice)],
                [/^every wavetable note on "(.+)" reads the table of "(.+)"$/, (name, tableOf) => {
                    const notes = notesOn(name);
                    expect(notes.length).toBeGreaterThan(0);
                    for (const n of notes) expect(n.cfg.table).toBe(trackId(tableOf));
                }],
                [/^the last wavetable note on "(.+)" has position ([\d.]+), unison (\d+), cutoff (\d+) and attack ([\d.]+)$/, (name, pos, uni, cutoff, attack) => {
                    const cfg = notesOn(name).at(-1)!.cfg;
                    expect([cfg.position, cfg.unison, cfg.cutoff, cfg.attack]).toEqual([+pos, +uni, +cutoff, +attack]);
                }],
                [/^I press the key (\d+) on the terrain with velocity ([\d.]+)$/, (midi, vel) => { view().onKeyDown(+midi, +vel); }],
                [/^I release the key (\d+) on the terrain$/, midi => { view().onKeyUp(+midi); }],
                [/^a stroke begins on the terrain$/, () => { view().onStrokeStart(); }],
                [/^the stroke ends on the terrain$/, () => { view().onStrokeEnd(); }],
                [/^a note is held on "(.+)" at ([\d.]+) Hz$/, (name, hz) => {
                    const held = heldOn(name);
                    expect(held.length, `notes held on ${name}`).toBeGreaterThan(0);
                    expect(Math.abs(held.at(-1)!.cfg.freq - +hz)).toBeLessThan(0.1);
                }],
                [/^no note is held on "(.+)"$/, name => expect(heldOn(name)).toHaveLength(0)],
                [/^exactly (\d+) notes? (?:is|are) held on "(.+)"$/, (n, name) => expect(heldOn(name)).toHaveLength(+n)],
                [/^the held note reads position ([\d.]+)$/, pos => expect(Math.abs([...w.heldNotes.values()].filter(n => !n.released).at(-1)!.position - +pos)).toBeLessThan(1e-9)],
                [/^I switch "(.+)" off$/, label => {
                    world.render();
                    const box = w.checkboxes.get(label);
                    if (!box) throw new Error(`no checkbox ${label}; have ${[...w.checkboxes.keys()].join(", ")}`);
                    box.onChange(false);
                    world.render();
                }],
                [/^I drag the slider "(.+)" to ([\d.]+)$/, (label, value) => {
                    world.render();
                    const slider = [...w.sliders].reverse().find(s => s.label === label);
                    if (!slider) throw new Error(`no slider ${label}; have ${w.sliders.map(s => s.label).join(", ")}`);
                    slider.onChange(String(value));
                    world.render();
                }],

                // ---- saving ----
                [/^I sculpt the table of "(.+)"$/, name => {
                    const t = table(name);
                    t.data += "+stroke";
                    t.edits.push("stroke");
                    view().onEdit();
                }],
                [/^the saved project has the table of "(.+)" as it is in the engine$/, name => {
                    const saved = savedTrack(name);
                    expect(saved.wavetable, "the saved wavetable settings").toBeTruthy();
                    expect(saved.wavetable.data).toBe(table(name).data);
                }],
                [/^the engine was given the saved table of "(.+)" back$/, name => {
                    const t = table(name);
                    expect(t.edits).toContain("imported");
                    expect(t.data).toContain("+stroke");
                }],

                // ---- exporting ----
                [/^I remember how many built-in notes the export has$/, () => { builtInBefore = w.exports.at(-1)!.length; }],
                [/^the export has wavetable notes for "(.+)" reading its own table$/, name => {
                    const events = w.wavetableExports.at(-1)!;
                    expect(events.length).toBeGreaterThan(0);
                    for (const e of events) {
                        expect(e.table).toBe(trackId(name));
                        expect(e.startTime).toBeGreaterThanOrEqual(0);
                        expect(e.duration).toBeGreaterThan(0);
                    }
                }],
                [/^the built-in notes and the wavetable notes together are what the built-in notes were before$/, () => {
                    expect(w.exports.at(-1)!.length + w.wavetableExports.at(-1)!.length).toBe(builtInBefore);
                }],
                [/^the export has no wavetable notes$/, () => expect(w.wavetableExports.at(-1)).toHaveLength(0)],
            ];

            for (const text of scenario.steps) {
                const step = steps.find(([re]) => re.test(text));
                if (!step) throw new Error(`No step definition for: ${text}`);
                const match = step[0].exec(text)!;
                await step[1](...match.slice(1));
            }
        });
    }
});
