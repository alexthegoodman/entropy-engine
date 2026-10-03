import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, parseFeature } from "./daw_test_world";

// tests/features/daw_next_steps.feature, run against the production addon: the piano roll, faders,
// buttons and the panel's knobs are the real widget callbacks. The model is a stand-in that answers
// with a scripted plan and keeps every request, so a step can read exactly the history (actions,
// params, context) the real model would have been given.

describe("Suggested Next Steps (production addon callbacks)", () => {
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); delete (globalThis as any).Entropy; });

    for (const scenario of parseFeature("daw_next_steps")) {
        it(scenario.name, async () => {
            vi.resetModules();
            const world = createWorld();
            const w = world.w;
            vi.spyOn(Date, "now").mockImplementation(() => w.clock);
            const vocab = w.prediction.vocab;
            const families: { id: string }[] = vocab.choices.families;
            const views: { id: string }[] = vocab.choices.views;

            const click = (id: string) => {
                world.render();
                const run = w.buttons.get(id);
                if (!run) throw new Error(`no button ${id}; have ${[...w.buttons.keys()].filter(k => k.startsWith("pred") || k.endsWith("_make")).join(", ")}`);
                run();
                world.advance(400);
            };
            // The history the model was last asked about. A change asks again once things settle.
            const history = (): any[] => {
                world.advance(400);
                const last = w.prediction.requests.at(-1);
                if (!last) throw new Error("the model was never asked for a plan");
                return last.history;
            };
            const lastOf = (action: string) => {
                const entry = history().filter(e => e.action === action).at(-1);
                if (!entry) throw new Error(`the model never saw ${action}; it saw ${history().map(e => e.action).join(", ")}`);
                return entry;
            };
            let lastAction = "";
            const numbers = (list: string) => list.split(",").map(x => parseFloat(x.trim()));
            const close = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
            const saved = () => { world.advance(400); return w.saved; };
            const track = (name: string) => {
                const t = saved().tracks.find((t: any) => t.name === name);
                if (!t) throw new Error(`no track named ${name}`);
                return t;
            };
            const knob = (id: string) => {
                world.render();
                const k = w.knobs.find((k: any) => k.id === id);
                if (!k) throw new Error(`no knob ${id}; have ${w.knobs.map((k: any) => k.id).filter(Boolean).join(", ")}`);
                return k;
            };
            const dropdown = (id: string) => {
                world.render();
                const d = w.dropdowns.get(id);
                if (!d) throw new Error(`no dropdown ${id}`);
                return d;
            };
            const planStep = (spec: string) => {
                const [name, ...params] = spec.trim().split(/\s+/);
                const def = vocab.actions.find((a: any) => a.name === name);
                if (!def) throw new Error(`no action ${name} in the vocabulary`);
                return {
                    action_id: def.id, name, display_name: def.display_name, category: def.category, icon: def.icon,
                    params: params.map(Number), confidence: 0.5, alternatives: [],
                };
            };

            for (const step of scenario.steps) {
                let m: RegExpExecArray | null;
                if ((m = /^the model will suggest "(.+)"$/.exec(step))) {
                    w.prediction.plan = m[1].split(";").map(planStep);
                } else if (step === "no prediction model is installed") {
                    w.prediction.status = { available: false, checkpoint: null, message: "No prediction model installed: put metadata.json and model.bin in checkpoints/prediction", vocab_version: 2, eval_top1: null, eval_top3: null };
                } else if (step === "the model was never asked for a plan") {
                    world.advance(400);
                    expect(w.prediction.requests).toEqual([]);
                } else if ((m = /^the DAW recorded "(\w+)" for when a model arrives$/.exec(step))) {
                    // Install a model: the next plan request carries everything recorded meanwhile.
                    w.prediction.status = { ...w.prediction.status, available: true };
                    click("prediction_refresh_btn");
                    expect(w.prediction.requests.at(-1).history.map((e: any) => e.action)).toContain(m[1]);
                } else if ((m = /^the model cannot load: "(.+)"$/.exec(step))) {
                    w.prediction.error = m[1];
                } else if (step === "the DAW is open with Suggested Next Steps showing" || step === "the DAW is open") {
                    // Next Steps is the inspector's default tab: opening the DAW shows it.
                    await world.open();
                    world.advance(400);
                    if (step !== "the DAW is open") expect(w.tabBars.get("inspector_tab")?.selected).toBe("next");
                } else if ((m = /^the inspector's first tab is "(\w+)"$/.exec(step))) {
                    world.renderOnly();
                    expect(w.tabBars.get("inspector_tab").tabs[0].id).toBe(m[1]);
                } else if ((m = /^the inspector is showing "(\w+)"$/.exec(step))) {
                    world.renderOnly();
                    expect(w.tabBars.get("inspector_tab")?.selected).toBe(m[1]);
                } else if (step === "the inspector is hidden") {
                    world.renderOnly();
                    expect(w.tabBars.has("inspector_tab")).toBe(false);
                } else if ((m = /^I pick the inspector tab "(\w+)"$/.exec(step))) {
                    world.renderOnly();
                    w.tabBars.get("inspector_tab").onSelect(m[1]);
                    world.advance(400);
                } else if (step === "the model is slow to answer") {
                    w.prediction.hold = true;
                } else if (step === "the model answers") {
                    w.prediction.hold = false;
                    world.advance(100);
                } else if ((m = /^I open the "(\w+)" view$/.exec(step))) {
                    world.render();
                    w.tabBars.get("daw_view").onSelect(m[1]);
                    world.advance(400);
                } else if ((m = /^I click the piano roll at row (\d+), step (\d+)$/.exec(step))) {
                    world.render();
                    // Drum tracks draw their rows top-down as stored, so the display row is the row.
                    w.piano.onNoteDown(Number(m[1]), Number(m[2]));
                    w.piano.onNoteUp(Number(m[1]), Number(m[2]));
                    world.advance(400);
                } else if ((m = /^I drag across row (\d+) from step (\d+) to step (\d+)$/.exec(step))) {
                    world.render();
                    const row = Number(m[1]);
                    const [from, to] = [Number(m[2]), Number(m[3])];
                    w.piano.onNoteDown(row, from);
                    for (let s = from + 1; s <= to; s++) w.piano.onNoteDrag(row, s);
                    w.piano.onNoteUp(row, to);
                    world.advance(400);
                } else if ((m = /^I drag the gain of "(\w+)" through (.+)$/.exec(step))) {
                    world.render();
                    const index = saved().tracks.findIndex((t: any) => t.name === m![1]);
                    const strip = w.sliders.filter((s: any) => s.label === "Gain")[index];
                    if (!strip) throw new Error(`no gain fader for ${m[1]}`);
                    for (const v of m[2].split(/,| and /).map(x => x.trim()).filter(Boolean)) {
                        strip.onChange(v);
                        w.clock += 16;
                    }
                    world.advance(400);
                } else if ((m = /^I select the track "(\w+)"$/.exec(step))) {
                    const index = saved().tracks.findIndex((t: any) => t.name === m![1]);
                    click(`select_track_${index}`);
                } else if ((m = /^I open the "(\w+)" instrument window$/.exec(step))) {
                    world.openInstrument(m[1]);
                    world.advance(400);
                } else if ((m = /^I press "(\w+)"$/.exec(step))) {
                    click(m[1]);
                } else if ((m = /^I turn knob "(\w+)" to ([\d.]+)$/.exec(step))) {
                    knob(m[1]).onChange(m[2]);
                    world.render();
                } else if ((m = /^the model last saw "(\w+)" with params "(.+)"( as a suggestion)?$/.exec(step))) {
                    const entry = lastOf(m[1]);
                    lastAction = m[1];
                    expect(close(entry.params, numbers(m[2])), `${m[1]} params ${JSON.stringify(entry.params)}`).toBe(true);
                    if (m[3]) {
                        // The history sent to the model carries no source; the panel's list marks it.
                        world.render();
                        expect(w.labels).toContain("suggested");
                    }
                } else if ((m = /^the model saw "(\w+)" with params "(.+)"$/.exec(step))) {
                    const seen = history().filter(e => e.action === m![1]).map(e => e.params);
                    expect(seen.some(p => close(p, numbers(m![2]))), `${m[1]}: ${JSON.stringify(seen)}`).toBe(true);
                } else if ((m = /^the model saw "(\w+)" (\d+) times?$/.exec(step))) {
                    expect(history().filter(e => e.action === m![1]).length).toBe(Number(m[2]));
                } else if ((m = /^the model saw no "(\w+)"$/.exec(step))) {
                    expect(history().filter(e => e.action === m![1])).toEqual([]);
                } else if ((m = /^that action happened on a "(\w+)" track in the "(\w+)" view$/.exec(step))) {
                    const ctx = lastOf(lastAction).context;
                    expect(families[ctx.family].id).toBe(m[1]);
                    expect(views[ctx.view].id).toBe(m[2]);
                } else if ((m = /^step (\d+) has a dropdown "(\w+)" on "(.+)"$/.exec(step))) {
                    const d = dropdown(m[2]);
                    expect(d.options[d.selectedIndex]).toBe(m[3]);
                } else if ((m = /^step (\d+) has a knob "(\w+)" at ([\d.]+)$/.exec(step))) {
                    expect(knob(m[2]).value).toBeCloseTo(Number(m[3]), 6);
                } else if ((m = /^step (\d+) has a knob "(\w+)" labelled "(.+)"$/.exec(step))) {
                    expect(knob(m[2]).label).toBe(m[3]);
                } else if ((m = /^the track "(\w+)" has gain ([\d.]+)$/.exec(step))) {
                    expect(track(m[1]).gain).toBeCloseTo(Number(m[2]), 6);
                } else if ((m = /^the "(\w+)" pattern "(\w+)" has a note on row (\d+) at step (\d+)$/.exec(step))) {
                    const pattern = track(m[1]).patterns.find((p: any) => p.name === m![2]);
                    expect(pattern.notes.some((n: any) => n.row === Number(m![3]) && n.step === Number(m![4]))).toBe(true);
                } else if ((m = /^the track "(\w+)" plays the "(\w+)" waveform with instrument "(\w+)"$/.exec(step))) {
                    const t = track(m[1]);
                    expect(t.voice.waveform).toBe(m[2]);
                    expect(t.physmod?.instrument).toBe(m[3]);
                } else if ((m = /^the last plan request asked for alternative (\d+)$/.exec(step))) {
                    expect(w.prediction.requests.at(-1).alternative).toBe(Number(m[1]));
                } else if ((m = /^the panel shows "(.+)"$/.exec(step))) {
                    world.render();
                    expect(w.labels.some((l: string) => typeof l === "string" && l.includes(m![1])), w.labels.filter((l: string) => /model|predict|checkpoint/i.test(l)).join(" | ")).toBe(true);
                } else {
                    throw new Error(`Unknown step: ${step}`);
                }
            }
        });
    }
});
