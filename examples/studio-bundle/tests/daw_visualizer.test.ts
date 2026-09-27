import { afterEach, describe, expect, it, vi } from "vitest";
import {
    COLOR_THEMES, VIDEO_SIZES, VISUALIZER_STYLES, applyTheme, defaultVisualizer, displayTitle, engineSettings, exportStatusText,
    musicVideoFileName, readVisualizer, themeIndex, videoSize,
} from "../src/apps/daw_visualizer";
import { createWorld } from "./daw_test_world";

describe("The music video look", () => {
    it("repairs a damaged saved look instead of throwing", () => {
        const p = readVisualizer({ style: "lasers", size: "8k", fps: 50, sensitivity: 99, barCount: 3.4, glow: -1, primary: [2, "x", 0.5], mirror: "yes", backgroundImage: "" });
        expect(p.style).toBe("bars");
        expect(p.size).toBe("hd");
        expect(p.fps).toBe(30);
        expect(p.sensitivity).toBe(3);
        expect(p.barCount).toBe(8);
        expect(p.glow).toBe(0);
        expect(p.primary).toEqual([1, defaultVisualizer().primary[1], 0.5, 1]);
        expect(p.mirror).toBe(false);
        expect(p.backgroundImage).toBeNull();
        expect(readVisualizer(null)).toEqual(defaultVisualizer());
        expect(readVisualizer("garbage")).toEqual(defaultVisualizer());
    });

    it("keeps what a save had", () => {
        const saved = { ...defaultVisualizer(), style: "horizon", size: "vertical", fps: 60, title: "Night Drive", mirror: true };
        expect(readVisualizer(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    });

    it("applies a theme's colours and recognises them again", () => {
        const p = applyTheme(defaultVisualizer(), "synthwave");
        expect(themeIndex(p)).toBe(COLOR_THEMES.findIndex(t => t.id === "synthwave"));
        expect(themeIndex({ ...p, primary: [0.1, 0.2, 0.3, 1] })).toBe(-1);
        expect(applyTheme(p, "nope")).toBe(p);
        // A theme's arrays are copied, not shared.
        p.primary[0] = 0;
        expect(COLOR_THEMES[1].primary[0]).toBe(1);
    });

    it("turns into the engine's settings at the chosen size, titled by the song", () => {
        const p = { ...defaultVisualizer(), size: "square" as const, style: "radial" as const };
        const s = engineSettings(p, "Neon Tide");
        expect([s.width, s.height]).toEqual([1080, 1080]);
        expect(s.style).toBe("radial");
        expect(s.title).toBe("Neon Tide");
        expect(engineSettings({ ...p, title: "My Cut" }, "Neon Tide").title).toBe("My Cut");
        expect(displayTitle({ ...p, title: "   " }, "Song")).toBe("Song");
        expect(videoSize(p).id).toBe("square");
    });

    it("offers even sizes and the six styles", () => {
        for (const s of VIDEO_SIZES) {
            expect(s.width % 2).toBe(0);
            expect(s.height % 2).toBe(0);
        }
        expect(VISUALIZER_STYLES.map(s => s.id)).toEqual(["bars", "radial", "wave", "particles", "rings", "horizon"]);
    });

    it("names the file after the song", () => {
        expect(musicVideoFileName("Night Drive!")).toBe("night-drive-music-video.mp4");
        expect(musicVideoFileName("***")).toBe("song-music-video.mp4");
    });

    it("describes export progress, success, failure and cancellation", () => {
        const base = { framesDone: 0, totalFrames: 0, progress: 0, done: false, cancelled: false, outputPath: "/tmp/a.mp4", elapsedMs: 0 };
        expect(exportStatusText(base)).toBe("Starting the export...");
        expect(exportStatusText({ ...base, framesDone: 150, totalFrames: 600, progress: 0.25, elapsedMs: 10_000 })).toBe("Rendering video 25% (frame 150 of 600) - about 30s left");
        expect(exportStatusText({ ...base, done: true, totalFrames: 600, progress: 1, elapsedMs: 75_000 })).toBe("Exported 600 frames to /tmp/a.mp4 in 1m 15s");
        expect(exportStatusText({ ...base, done: true, error: "disk full" })).toBe("Export failed: disk full");
        expect(exportStatusText({ ...base, done: true, cancelled: true })).toBe("Export cancelled.");
    });
});

// --- The addon, through its production callbacks ----------------------------------------------------

describe("The DAW's Analyzer toggle and Music Video panel (production addon callbacks)", () => {
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); delete (globalThis as any).Entropy; });

    async function openDaw() {
        vi.resetModules();
        const world = createWorld();
        vi.spyOn(Date, "now").mockImplementation(() => world.w.clock);
        await world.open();
        const w = world.w;
        const click = (id: string) => {
            world.render();
            if (!w.buttons.has(id)) throw new Error(`no button ${id}; have ${[...w.buttons.keys()].join(", ")}`);
            w.buttons.get(id)!();
            world.render();
        };
        const windowId = (title: string) => Object.entries(w.windowTitles).find(([, t]) => t === title)![0];
        return { world, w, click, windowId };
    }

    it("hides and shows the Analyzer from the transport bar, and its close button keeps the toggle in step", async () => {
        const { w, click, windowId } = await openDaw();
        const analyzer = windowId("Analyzer");
        expect(w.windowVisible[analyzer]).toBe(true);
        expect(w.buttonTexts.get("toggle_analyzer")).toBe("Hide Analyzer");
        click("toggle_analyzer");
        expect(w.windowVisible[analyzer]).toBe(false);
        expect(w.buttonTexts.get("toggle_analyzer")).toContain("Show Analyzer");
        click("toggle_analyzer");
        expect(w.windowVisible[analyzer]).toBe(true);
    });

    it("opens the Music Video window with a live preview of the saved look", async () => {
        const { w, click, windowId, world } = await openDaw();
        const panel = windowId("Music Video");
        expect(w.windowVisible[panel]).toBe(false);
        click("toggle_visualizer");
        expect(w.windowVisible[panel]).toBe(true);
        const preview = w.musicVisualizers.get("music_video_preview");
        expect(preview.source).toBe("master");
        expect(preview.settings).toMatchObject({ style: "bars", width: 1280, height: 720, fps: 30 });
        // Titled by the song until a title is typed.
        expect(preview.settings.title).toBe("Demo song");

        w.dropdowns.get("music_video_style").onChange("5");
        w.dropdowns.get("music_video_size").onChange("3");
        w.dropdowns.get("music_video_theme").onChange("1");
        w.textInputs.get("music_video_title").onChange("Night Drive");
        world.advance(3000);
        expect(w.musicVisualizers.get("music_video_preview").settings).toMatchObject({
            style: "horizon", width: 1080, height: 1920, title: "Night Drive", primary: [...COLOR_THEMES[1].primary],
        });
        // The look is saved with the song.
        expect(w.saved.visualizer).toMatchObject({ style: "horizon", size: "vertical", title: "Night Drive" });
    });

    it("exports: bounces to a temporary WAV, starts the export, then reports progress and the result", async () => {
        const { w, click, world } = await openDaw();
        click("toggle_visualizer");
        click("music_video_export");
        expect(w.wavOptions.at(-1)).toEqual({ tempFile: true });
        expect(w.musicVideoStarts).toHaveLength(1);
        expect(w.musicVideoStarts[0]).toMatchObject({ wavPath: "test.wav", outputPath: "/videos/song.mp4", deleteWav: true });
        expect(w.musicVideoStarts[0].settings).toMatchObject({ style: "bars", width: 1280, title: "Demo song" });
        expect(w.buttonTexts.get("music_video_export")).toBe("Exporting...");

        w.musicVideoPolls.push({ framesDone: 150, totalFrames: 600, progress: 0.25, done: false, cancelled: false, outputPath: "/videos/song.mp4", elapsedMs: 10_000 });
        world.advance(50);
        expect(w.labels).toContain("Rendering video 25% (frame 150 of 600) - about 30s left");
        click("music_video_cancel");
        expect(w.musicVideoCancels).toBe(1);

        w.musicVideoPolls.push({ framesDone: 600, totalFrames: 600, progress: 1, done: true, cancelled: false, outputPath: "/videos/song.mp4", elapsedMs: 40_000 });
        world.advance(50);
        expect(w.labels).toContain("Exported 600 frames to /videos/song.mp4 in 40s");
        expect(w.buttons.has("music_video_cancel")).toBe(false);
        // A second export can start.
        click("music_video_export");
        expect(w.musicVideoStarts).toHaveLength(2);
    });

    it("does nothing when the save dialog is cancelled", async () => {
        const { w, click } = await openDaw();
        w.musicVideoPath = null;
        click("toggle_visualizer");
        const bounces = w.wavOptions.length;
        click("music_video_export");
        expect(w.wavOptions.length).toBe(bounces);
        expect(w.musicVideoStarts).toHaveLength(0);
        expect(w.labels).toContain("Export cancelled.");
    });
});
