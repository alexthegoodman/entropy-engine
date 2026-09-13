// Clip & Curve Editor - the exercise addon for the new `entropy_gui::KeyframeTimeline` and
// `entropy_gui::TrackView` widgets (this session's addition, alongside the existing
// `NodeGraphEditor`/`Snarl` and `PianoRoll`). Both widgets are domain-agnostic on the Rust
// side - this addon is what actually drives them: a small animation-curve editor (three
// properties, draggable keyframes) sitting on the same playhead as a two-video-plus-audio
// clip timeline, so scrubbing one moves the other. The audio track's waveform is a
// synthetic peaks array (a few summed sine lobes plus noise) - this widget never decodes
// real audio itself, an addon owns getting from a file to a `peaks` array (see
// `TracksConfig.peaks` in addon.d.ts).

interface KF { id: string; timeMs: number; }
interface Row { id: string; label: string; keyframes: KF[]; }
interface Clip { id: string; label: string; startMs: number; durationMs: number; color: [number, number, number, number]; peaks?: number[]; }
interface Track { id: string; label: string; clips: Clip[]; }

const addonInfo = {
    name: "Clip & Curve Editor",
    version: "1.0.0",
    description: "Exercises the new KeyframeTimeline and TrackView widgets on a shared playhead",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const DURATION_MS = 4000;

let rows: Row[] = [
    { id: "x", label: "Position X", keyframes: [{ id: "k1", timeMs: 0 }, { id: "k2", timeMs: 1500 }, { id: "k3", timeMs: 3200 }] },
    { id: "y", label: "Position Y", keyframes: [{ id: "k4", timeMs: 400 }, { id: "k5", timeMs: 2200 }] },
    { id: "op", label: "Opacity", keyframes: [{ id: "k6", timeMs: 0 }, { id: "k7", timeMs: 3800 }] },
];

// A few summed sine lobes plus jitter - not real decoded audio, just enough shape to prove
// the waveform-bar rendering (see the module comment above and the post's decision log).
function fakePeaks(count: number): number[] {
    const peaks: number[] = [];
    for (let i = 0; i < count; i++) {
        const t = i / count;
        const envelope = Math.sin(t * Math.PI);
        const wobble = 0.5 + 0.5 * Math.sin(t * 40) * Math.sin(t * 7 + 1.3);
        peaks.push(Math.max(0.05, envelope * (0.4 + 0.6 * wobble)));
    }
    return peaks;
}

let tracks: Track[] = [
    {
        id: "video_a", label: "Video A", clips: [
            { id: "c1", label: "intro.mp4", startMs: 0, durationMs: 1800, color: [0.30, 0.52, 0.85, 1] },
            { id: "c2", label: "outro.mp4", startMs: 2400, durationMs: 1600, color: [0.30, 0.52, 0.85, 1] },
        ]
    },
    {
        id: "video_b", label: "Video B", clips: [
            { id: "c3", label: "overlay.mp4", startMs: 900, durationMs: 1200, color: [0.80, 0.47, 0.28, 1] },
        ]
    },
    {
        id: "audio_a", label: "Audio", clips: [
            { id: "c4", label: "music.wav", startMs: 0, durationMs: 4000, color: [0.35, 0.72, 0.42, 1], peaks: fakePeaks(96) },
        ]
    },
];

let playheadMs = 0;
let playing = false;
let lastTickMs = Date.now();
let selectedKeyframe: { row: string; keyframe: string } | null = { row: "x", keyframe: "k2" };
let selectedClip: { track: string; clip: string } | null = null;
let lastEvent = "(none yet)";

function setupUI() {
    const win = Entropy.UI.createWindow({
        title: "Clip & Curve Editor",
        width: 1100,
        height: 760,
        x: 20,
        y: 20,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    Entropy.UI.Widget.label(win, { text: "Clip & Curve Editor", bold: true });
    Entropy.UI.Widget.label(win, { text: "Drag a keyframe or a clip; right-click a row/clip for Add/Delete; scroll to zoom, drag empty space to pan." });

    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.button(win, {
            text: playing ? "Pause" : "Play",
            onClick: () => { playing = !playing; }
        });
        Entropy.UI.Widget.button(win, { text: "Reset Playhead", onClick: () => { playheadMs = 0; } });
        Entropy.UI.Widget.label(win, { text: `t = ${(playheadMs / 1000).toFixed(2)}s` });
    });
    Entropy.UI.Widget.separator(win);

    Entropy.UI.Widget.label(win, { text: "Animation Curve" });
    Entropy.UI.Widget.keyframeTimeline(win, {
        id: "curve_editor",
        durationMs: DURATION_MS,
        playheadMs,
        rows,
        selected: selectedKeyframe ?? undefined,
        onSeek: (t) => { playheadMs = t; lastEvent = `Seek(curve) -> ${t}ms`; },
        onKeyframeSelected: (row, keyframe) => { selectedKeyframe = { row, keyframe }; lastEvent = `KeyframeSelected(${row}, ${keyframe})`; },
        onKeyframeMoved: (row, keyframe, timeMs) => {
            const r = rows.find(r => r.id === row);
            const kf = r?.keyframes.find(k => k.id === keyframe);
            if (kf) kf.timeMs = timeMs;
            lastEvent = `KeyframeMoved(${row}, ${keyframe}) -> ${timeMs}ms`;
        },
        onKeyframeAdd: (row, timeMs) => {
            const r = rows.find(r => r.id === row);
            if (r) {
                const id = `k_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                r.keyframes.push({ id, timeMs });
                r.keyframes.sort((a, b) => a.timeMs - b.timeMs);
                selectedKeyframe = { row, keyframe: id };
            }
            lastEvent = `KeyframeAdd(${row}) @ ${timeMs}ms`;
        },
        onKeyframeDelete: (row, keyframe) => {
            const r = rows.find(r => r.id === row);
            if (r) r.keyframes = r.keyframes.filter(k => k.id !== keyframe);
            if (selectedKeyframe?.row === row && selectedKeyframe?.keyframe === keyframe) selectedKeyframe = null;
            lastEvent = `KeyframeDelete(${row}, ${keyframe})`;
        },
        onBackgroundClicked: () => { selectedKeyframe = null; }
    });

    Entropy.UI.Widget.separator(win);

    Entropy.UI.Widget.label(win, { text: "Clip Timeline" });
    Entropy.UI.Widget.tracks(win, {
        id: "clip_timeline",
        durationMs: DURATION_MS,
        playheadMs,
        tracks,
        selected: selectedClip ?? undefined,
        onSeek: (t) => { playheadMs = t; lastEvent = `Seek(tracks) -> ${t}ms`; },
        onClipSelected: (track, clip) => { selectedClip = { track, clip }; lastEvent = `ClipSelected(${track}, ${clip})`; },
        onClipMoved: (track, clip, startMs) => {
            const t = tracks.find(t => t.id === track);
            const c = t?.clips.find(c => c.id === clip);
            if (c) c.startMs = startMs;
            lastEvent = `ClipMoved(${track}, ${clip}) -> ${startMs}ms`;
        },
        onClipResized: (track, clip, startMs, durationMs) => {
            const t = tracks.find(t => t.id === track);
            const c = t?.clips.find(c => c.id === clip);
            if (c) { c.startMs = startMs; c.durationMs = durationMs; }
            lastEvent = `ClipResized(${track}, ${clip}) -> [${startMs}, +${durationMs}]ms`;
        },
        onClipDelete: (track, clip) => {
            const t = tracks.find(t => t.id === track);
            if (t) t.clips = t.clips.filter(c => c.id !== clip);
            if (selectedClip?.track === track && selectedClip?.clip === clip) selectedClip = null;
            lastEvent = `ClipDelete(${track}, ${clip})`;
        },
        onBackgroundClicked: () => { selectedClip = null; }
    });

    Entropy.UI.Widget.separator(win);
    Entropy.UI.Widget.label(win, { text: `Last event: ${lastEvent}` });
}

addon.onInit(async () => {
    setupUI();
});

// `addon.onUpdate` only fires when `pipeline.current_workspace` is `Workspace::Addon(name)`
// matching this addon's own registered name - true inside Studio's multi-addon shell, but a
// plain `EntropyApp` (no Studio shell, like this demo's `cargo run --bin example`) never
// leaves the default `Workspace::Global`, so `current_addon_name` stays "Global" and a plain
// `onUpdate` callback is filtered out and never runs. `onUpdatePlus("Global", ...)` is the
// existing, already-shipped workaround for that case (see `fft_water_addon.ts`), and is what
// actually drives the playhead here.
addon.onUpdatePlus("Global", () => {
    const now = Date.now();
    const dt = now - lastTickMs;
    lastTickMs = now;
    if (playing) {
        playheadMs = (playheadMs + dt) % DURATION_MS;
    }
});
