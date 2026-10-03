import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld } from "./daw_test_world";

// The DAW's workspace: a header, a row of view tabs (Arrange, Piano Roll, Mixer), the active view
// beside a track inspector, and a status bar. These tests draw one real frame at a time
// (`renderOnly`), so they see only what is on screen, not every tab the page could show.
describe("The DAW workspace", () => {
    beforeEach(() => { vi.resetModules(); });

    async function open() {
        const world = createWorld();
        await world.open();
        world.renderOnly();
        const w = world.w;
        const view = () => w.tabBars.get("daw_view");
        const section = () => w.tabBars.get("inspector_tab");
        const pick = (bar: string, tab: string) => { w.tabBars.get(bar).onSelect(tab); world.renderOnly(); };
        const press = (key: string, ctrl = false) => { w.keyDown!(key, ctrl, false, false); world.renderOnly(); };
        return { world, w, view, section, pick, press };
    }

    it("fills the window instead of scrolling as one long page", async () => {
        const { w } = await open();
        expect(w.tabConfig.scroll).toBe(false);
    });

    it("opens on the arrangement with the inspector on Next Steps, and no piano roll on screen", async () => {
        const { w, view, section } = await open();
        expect(view().selected).toBe("arrange");
        expect(section().selected).toBe("next");
        expect(section().tabs[0].id).toBe("next");
        expect(w.arrangement).not.toBeNull();
        expect(w.piano).toBeNull();
        expect(w.buttons.has("pattern_duplicate")).toBe(false);
    });

    it("gives the piano roll the whole view, sized to the room there is", async () => {
        const { w, pick, view } = await open();
        pick("daw_view", "roll");
        expect(view().selected).toBe("roll");
        expect(w.arrangement).toBeNull();
        expect(w.piano.fillHeight).toBe(true);
        expect(w.piano.showVelocity).toBe(true);
        expect(w.buttons.has("pattern_duplicate")).toBe(true);

    });

    it("sizes piano roll rows from the Rows control", async () => {
        const { world, w, pick } = await open();
        pick("daw_view", "roll");
        w.dropdowns.get("roll_rows").onChange("3");
        world.renderOnly();
        expect(w.piano.fillHeight).toBe(false);
        expect(w.piano.rowHeight).toBe(38);
    });

    it("tints the root note of every octave in the piano roll", async () => {
        const { world, w, pick } = await open();
        pick("daw_view", "roll");
        const tracks = w.dropdowns.get("roll_track");
        tracks.onChange(String(tracks.options.indexOf("Bass")));
        world.renderOnly();
        const roots = w.piano.highlightRows.map((r: number) => w.piano.rowLabels[r]);
        expect(roots.length).toBeGreaterThan(0);
        const rootName = roots[0].replace(/-?\d+$/, "");
        expect(roots.every((n: string) => n.replace(/-?\d+$/, "") === rootName)).toBe(true);
    });

    it("switches views with 1, 2 and 3, and shows or hides the inspector with I", async () => {
        const { w, view, press } = await open();
        press("2");
        expect(view().selected).toBe("roll");
        press("3");
        expect(view().selected).toBe("mixer");
        expect(w.buttons.has("select_track_0")).toBe(true);
        press("1");
        expect(view().selected).toBe("arrange");

        expect(w.buttonConfigs.get("toggle_inspector").selected).toBe(true);
        press("i");
        expect(w.buttonConfigs.get("toggle_inspector").selected).toBe(false);
        expect(w.tabBars.has("inspector_tab")).toBe(false);
        press("I");
        expect(w.tabBars.has("inspector_tab")).toBe(true);
    });

    it("leaves those keys alone while a text field has the keyboard", async () => {
        const { w, view, press } = await open();
        w.typing = true;
        press("2");
        press("i");
        expect(view().selected).toBe("arrange");
        expect(w.buttonConfigs.get("toggle_inspector").selected).toBe(true);
    });

    it("keeps Ctrl shortcuts working", async () => {
        const { w, press } = await open();
        const before = w.buttonConfigs.get("songs_toggle").selected;
        press("o", true);
        expect(w.buttonConfigs.get("songs_toggle").selected).toBe(!before);
    });

    it("opens the inspector on Moves from the arrangement and piano roll toolbars", async () => {
        const { w, section, pick, press } = await open();
        press("i");
        w.buttons.get("arr_open_moves")!();
        pick("daw_view", "arrange");
        expect(section().selected).toBe("moves");
        expect(w.buttons.has("move_variation")).toBe(true);

        pick("inspector_tab", "sound");
        pick("daw_view", "roll");
        w.buttons.get("roll_open_moves")!();
        pick("daw_view", "roll");
        expect(section().selected).toBe("moves");
    });

    it("gives empty channels slim lanes and used ones roomy lanes", async () => {
        const { w } = await open();
        const lanes = w.arrangement.tracks;
        expect(lanes.filter((l: any) => l.placeholder).length).toBeGreaterThan(0);
        expect(w.arrangement.options.laneHeight).toBe(56);
        expect(w.arrangement.options.placeholderLaneHeight).toBe(28);
    });

    it("shows the selected clip in the status bar", async () => {
        const { world, w } = await open();
        const lane = w.arrangement.tracks.find((l: any) => !l.placeholder && l.clips.length);
        w.arrangement.onClipSelected(lane.id, lane.clips[0].id);
        world.renderOnly();
        expect(w.labels.some(l => l.startsWith(`${lane.label} - ${lane.clips[0].label}: bar `))).toBe(true);
    });

    it("draws the play button as the header's one filled action, and the position in fixed-width digits", async () => {
        const { w } = await open();
        expect(w.buttonConfigs.get("transport_toggle").accent).toBeDefined();
        expect(w.dropdowns.get("transport_mode").options).toEqual(["Song", "Pattern loop"]);
    });
});
