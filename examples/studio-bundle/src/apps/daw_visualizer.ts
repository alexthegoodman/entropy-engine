// Pure logic for the DAW's Music Video panel: the saved look of a song's visualizer, colour themes,
// output sizes, and turning all that into the settings `Entropy.Video.exportMusicVideo` and
// `Widget.musicVisualizer` take. No `Entropy` calls in here, so it runs under vitest as it is
// (tests/daw_visualizer.test.ts). The panel that uses it is in daw_synth_addon.ts.
//
// The renderer itself is Rust (src/music_video): the preview widget and the export draw the same
// frames, so what the panel shows is what the MP4 will contain.

export type Rgba = [number, number, number, number];

/** Matches `VisualStyle` in src/music_video/settings.rs, in the same order. */
export const VISUALIZER_STYLES = [
    { id: "bars", label: "Spectrum Bars" },
    { id: "radial", label: "Radial Pulse" },
    { id: "wave", label: "Waveform" },
    { id: "particles", label: "Starfield" },
    { id: "rings", label: "Beat Rings" },
    { id: "horizon", label: "Horizon" },
] as const;
export type VisualizerStyle = (typeof VISUALIZER_STYLES)[number]["id"];

/** Output sizes, named for where the video is going. */
export const VIDEO_SIZES = [
    { id: "hd", label: "1280 x 720 (HD)", width: 1280, height: 720 },
    { id: "fullhd", label: "1920 x 1080 (Full HD)", width: 1920, height: 1080 },
    { id: "square", label: "1080 x 1080 (Square)", width: 1080, height: 1080 },
    { id: "vertical", label: "1080 x 1920 (Vertical: Shorts, Reels)", width: 1080, height: 1920 },
    { id: "small", label: "854 x 480 (Small, quick)", width: 854, height: 480 },
] as const;
export type VideoSizeId = (typeof VIDEO_SIZES)[number]["id"];

export const VIDEO_FPS = [24, 30, 60] as const;

/** Faces from the engine's font catalog that read well as a title. */
export const TITLE_FONTS = ["Figtree", "Lexend", "Bungee", "Exo", "Play", "Epilogue", "Quicksand", "Jaro", "Vina Sans", "Sacramento"] as const;

export const COLOR_THEMES = [
    { id: "mint", label: "Mint & Coral", primary: [0.36, 0.95, 0.77, 1], secondary: [1.0, 0.46, 0.38, 1], background: [0.04, 0.05, 0.09, 1], backgroundBottom: [0.09, 0.05, 0.14, 1] },
    { id: "synthwave", label: "Synthwave", primary: [1.0, 0.25, 0.75, 1], secondary: [0.2, 0.85, 1.0, 1], background: [0.07, 0.02, 0.15, 1], backgroundBottom: [0.2, 0.04, 0.25, 1] },
    { id: "ice", label: "Ice", primary: [0.85, 0.95, 1.0, 1], secondary: [0.3, 0.55, 1.0, 1], background: [0.02, 0.04, 0.09, 1], backgroundBottom: [0.04, 0.1, 0.2, 1] },
    { id: "ember", label: "Ember", primary: [1.0, 0.7, 0.2, 1], secondary: [1.0, 0.25, 0.1, 1], background: [0.08, 0.02, 0.02, 1], backgroundBottom: [0.16, 0.05, 0.02, 1] },
    { id: "forest", label: "Forest", primary: [0.6, 1.0, 0.4, 1], secondary: [0.1, 0.7, 0.5, 1], background: [0.02, 0.06, 0.04, 1], backgroundBottom: [0.03, 0.12, 0.08, 1] },
    { id: "mono", label: "Mono", primary: [1, 1, 1, 1], secondary: [0.55, 0.55, 0.6, 1], background: [0, 0, 0, 1], backgroundBottom: [0.08, 0.08, 0.09, 1] },
] as const satisfies readonly { id: string; label: string; primary: Rgba; secondary: Rgba; background: Rgba; backgroundBottom: Rgba }[];

/** What is saved with the song. Unknown fields in a saved file are ignored and missing ones take
 * their defaults, so older and newer saves both still open. */
export interface VisualizerPrefs {
    style: VisualizerStyle;
    size: VideoSizeId;
    fps: number;
    primary: Rgba;
    secondary: Rgba;
    background: Rgba;
    backgroundBottom: Rgba;
    /** How hard the visuals react, 0.25..3. */
    sensitivity: number;
    /** 0 twitchy .. 1 syrupy. */
    smoothing: number;
    barCount: number;
    mirror: boolean;
    glow: number;
    /** Empty means "use the song's name" (see `displayTitle`). */
    title: string;
    artist: string;
    font: string;
    showProgress: boolean;
    backgroundImage: string | null;
    backgroundDim: number;
}

export function defaultVisualizer(): VisualizerPrefs {
    const t = COLOR_THEMES[0];
    return {
        style: "bars",
        size: "hd",
        fps: 30,
        primary: [...t.primary],
        secondary: [...t.secondary],
        background: [...t.background],
        backgroundBottom: [...t.backgroundBottom],
        sensitivity: 1,
        smoothing: 0.5,
        barCount: 48,
        mirror: false,
        glow: 0.6,
        title: "",
        artist: "",
        font: "Figtree",
        showProgress: true,
        backgroundImage: null,
        backgroundDim: 0.45,
    };
}

const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

function color(v: unknown, fallback: Rgba): Rgba {
    if (!Array.isArray(v) || v.length < 3) return [...fallback];
    const c = [0, 1, 2, 3].map(i => num(v[i], 0, 1, i === 3 ? 1 : fallback[i]));
    return [c[0], c[1], c[2], c[3]];
}

/** Reads a saved look of any age or shape into a valid `VisualizerPrefs`. */
export function readVisualizer(saved: unknown): VisualizerPrefs {
    const d = defaultVisualizer();
    if (!saved || typeof saved !== "object") return d;
    const s = saved as Record<string, any>;
    return {
        style: VISUALIZER_STYLES.some(v => v.id === s.style) ? s.style : d.style,
        size: VIDEO_SIZES.some(v => v.id === s.size) ? s.size : d.size,
        fps: (VIDEO_FPS as readonly number[]).includes(s.fps) ? s.fps : d.fps,
        primary: color(s.primary, d.primary),
        secondary: color(s.secondary, d.secondary),
        background: color(s.background, d.background),
        backgroundBottom: color(s.backgroundBottom, d.backgroundBottom),
        sensitivity: num(s.sensitivity, 0.25, 3, d.sensitivity),
        smoothing: num(s.smoothing, 0, 1, d.smoothing),
        barCount: Math.round(num(s.barCount, 8, 128, d.barCount)),
        mirror: typeof s.mirror === "boolean" ? s.mirror : d.mirror,
        glow: num(s.glow, 0, 1, d.glow),
        title: typeof s.title === "string" ? s.title.slice(0, 120) : d.title,
        artist: typeof s.artist === "string" ? s.artist.slice(0, 120) : d.artist,
        font: typeof s.font === "string" && s.font ? s.font : d.font,
        showProgress: typeof s.showProgress === "boolean" ? s.showProgress : d.showProgress,
        backgroundImage: typeof s.backgroundImage === "string" && s.backgroundImage ? s.backgroundImage : null,
        backgroundDim: num(s.backgroundDim, 0, 1, d.backgroundDim),
    };
}

/** Sets the four colours from a theme; everything else stays. */
export function applyTheme(p: VisualizerPrefs, themeId: string): VisualizerPrefs {
    const t = COLOR_THEMES.find(x => x.id === themeId);
    if (!t) return p;
    return { ...p, primary: [...t.primary], secondary: [...t.secondary], background: [...t.background], backgroundBottom: [...t.backgroundBottom] };
}

/** The theme whose colours these are, or -1 when they have been edited. */
export function themeIndex(p: VisualizerPrefs): number {
    const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
    return COLOR_THEMES.findIndex(t => same(t.primary, p.primary) && same(t.secondary, p.secondary) && same(t.background, p.background) && same(t.backgroundBottom, p.backgroundBottom));
}

export function videoSize(p: VisualizerPrefs) {
    return VIDEO_SIZES.find(s => s.id === p.size) ?? VIDEO_SIZES[0];
}

export function displayTitle(p: VisualizerPrefs, songName: string): string {
    return p.title.trim() || songName;
}

/** The `VisualizerSettings` (src/music_video/settings.rs) for this look. */
export function engineSettings(p: VisualizerPrefs, songName: string) {
    const size = videoSize(p);
    return {
        style: p.style,
        width: size.width,
        height: size.height,
        fps: p.fps,
        primary: p.primary,
        secondary: p.secondary,
        background: p.background,
        backgroundBottom: p.backgroundBottom,
        sensitivity: p.sensitivity,
        smoothing: p.smoothing,
        barCount: p.barCount,
        mirror: p.mirror,
        glow: p.glow,
        title: displayTitle(p, songName),
        artist: p.artist,
        font: p.font,
        showProgress: p.showProgress,
        backgroundImage: p.backgroundImage,
        backgroundDim: p.backgroundDim,
    };
}

/** "Night Drive" -> "night-drive-music-video.mp4". */
export function musicVideoFileName(songName: string): string {
    const slug = songName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "song";
    return `${slug}-music-video.mp4`;
}

/** What `Entropy.Video.pollMusicVideo()` returns. */
export interface MusicVideoStatus {
    framesDone: number;
    totalFrames: number;
    progress: number;
    done: boolean;
    cancelled: boolean;
    error?: string | null;
    outputPath: string;
    elapsedMs: number;
    warning?: string | null;
}

function duration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** One line for the panel and the toast. */
export function exportStatusText(s: MusicVideoStatus): string {
    if (s.done) {
        if (s.cancelled) return "Export cancelled.";
        if (s.error) return `Export failed: ${s.error}`;
        const note = s.warning ? ` (${s.warning})` : "";
        return `Exported ${s.totalFrames} frames to ${s.outputPath} in ${duration(s.elapsedMs)}${note}`;
    }
    if (s.totalFrames === 0) return "Starting the export...";
    const pct = Math.floor(s.progress * 100);
    // Estimate the rest from the pace so far, once there is enough of it to go on.
    const remaining = s.framesDone > 10 && s.progress > 0 ? ` - about ${duration(s.elapsedMs * (1 - s.progress) / s.progress)} left` : "";
    return `Rendering video ${pct}% (frame ${s.framesDone} of ${s.totalFrames})${remaining}`;
}
