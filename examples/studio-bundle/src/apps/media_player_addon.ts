// Windows Media Foundation player. The playlist, transport and subtitle state live in this addon;
// decoding, audio and frame upload live in Entropy.Video.
import { parseSubtitles, subtitleAt, type Cue } from "./media_player_model";

const addonInfo = {
    name: "Media Player",
    version: "1.0.0",
    description: "Plays a video file with audio via Windows Media Foundation",
    author: ["Entropy Team", "Claude"],
    capabilities: {
        audio: true,
        ui: true
    }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const playlist = [
    "public/yumondesktop.mp4",
    "public/grok-imagine-video.mp4",
    "public/replicate-prediction-video.mp4",
    "public/video_export_demo.mp4",
];
let selectedIndex = 0;
let pathDraft = "";
let subtitleDraft = "";
let cues: Cue[] = [];
let captionsEnabled = true;
let caption = "";
let status = "";
let speed = 1;
let fullscreen = false;
let looping = false;
let lastPlaying = false;
let captionWindow: string | null = null;

// Unlit textured quad. No model-transform uniform is referenced (group 1) because, like the
// FFT water / advanced water pipelines' custom shaders, vertex positions are baked into
// `vertexData` in world space already - see buildQuad(). Texture+sampler land at group(2)
// because this pipeline declares exactly one `extraBindGroups` entry, and extra bind groups
// are numbered starting at 2 (group 0 = camera, group 1 = model transform, always present).
const VIDEO_QUAD_SHADER = `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

@group(2) @binding(0)
var video_texture: texture_2d<f32>;
@group(2) @binding(1)
var video_sampler: sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = camera.view_proj * vec4<f32>(in.position, 1.0);
    out.tex_coords = in.tex_coords;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(video_texture, video_sampler, in.tex_coords);
}
`;

let pipelineId: string | null = null;
let videoHandle: string | null = null;
let videoWidth = 16;
let videoHeight = 9;
let durationMs = 0;
let isPlaying = false;
let volume = 1.0;
let displayTimeMs = 0;

function loadSubtitles(path: string, silent = false) {
    try {
        cues = parseSubtitles(Entropy.Video.readSubtitles(path));
        subtitleDraft = path;
        status = `${cues.length} subtitle cues loaded`;
    } catch (error) {
        cues = [];
        if (!silent) status = String(error);
    }
}

function openIndex(index: number): boolean {
    if (index < 0 || index >= playlist.length) return false;
    const path = playlist[index];
    let opened: ReturnType<typeof Entropy.Video.open>;
    try {
        opened = Entropy.Video.open(path);
    } catch (error) {
        status = `Could not open ${path}: ${error}`;
        return false;
    }
    if (videoHandle) Entropy.Video.close(videoHandle);
    videoHandle = opened.handle;
    selectedIndex = index;
    videoWidth = opened.width;
    videoHeight = opened.height;
    durationMs = opened.durationMs;
    displayTimeMs = 0;
    const newTexture = Entropy.Texture.createEx({
        width: videoWidth, height: videoHeight, format: "Rgba8Unorm", usage: ["Texture", "CopyDst"]
    }, null);
    Entropy.Video.bindTexture(videoHandle, newTexture);
    const { vertices, indices } = buildQuad(videoWidth / videoHeight);
    Entropy.Model.clearMesh("media_player_quad");
    Entropy.Model.createMesh({
        id: "media_player_quad", position: [0, 0, 0], vertexData: vertices, indexData: indices,
        pipelineId, bindings: [
            { group: 2, binding: 0, resource: { type: "Texture", value: { id: newTexture } } },
            { group: 2, binding: 1, resource: { type: "Sampler" } },
        ]
    } as any);
    Entropy.Video.setVolume(videoHandle, volume);
    Entropy.Video.setSpeed(videoHandle, speed);
    loadSubtitles(path.replace(/\.[^.]+$/, ".srt"), true);
    if (!cues.length) loadSubtitles(path.replace(/\.[^.]+$/, ".vtt"), true);
    status = `${path} - ${videoWidth}x${videoHeight}`;
    Entropy.Video.play(videoHandle);
    isPlaying = true;
    lastPlaying = true;
    return true;
}

function next(delta: number) {
    openIndex((selectedIndex + delta + playlist.length) % playlist.length);
}

function removeCurrent() {
    if (playlist.length <= 1) { status = "Keep at least one clip in the playlist"; return; }
    const old = selectedIndex;
    playlist.splice(old, 1);
    openIndex(Math.min(old, playlist.length - 1));
}

// 12 floats/vertex: position(3), normal(3), tex_coords(2), color(4) - the fixed layout every
// `Entropy.Model.createMesh` vertex buffer uses (see src/core/vertex.rs's `Vertex`); `Entropy`
// doesn't reinterpret `vertexData`, it's cast straight to bytes on the Rust side.
function buildQuad(aspect: number): { vertices: number[]; indices: number[] } {
    const halfW = aspect >= 1 ? aspect : 1;
    const halfH = aspect >= 1 ? 1 : 1 / aspect;
    const z = 0;

    // TODO(verify on first run): if the decoded frame appears upside-down or mirrored, it's
    // this UV mapping or MF's RGB32 row order (see the note in src/media_player/mod.rs's
    // create_video_reader) - fix here rather than guessing which one is wrong before testing.
    const vertex = (x: number, y: number, u: number, v: number) => [x, y, z, 0, 0, 1, u, v, 1, 1, 1, 1];
    const vertices = [
        ...vertex(-halfW, halfH, 0, 0), // top-left
        ...vertex(halfW, halfH, 1, 0), // top-right
        ...vertex(halfW, -halfH, 1, 1), // bottom-right
        ...vertex(-halfW, -halfH, 0, 1), // bottom-left
    ];
    // Reversed from the "obvious" [0,1,2,0,2,3] strip winding - the default addon pipeline
    // culls backfaces with FrontFace::Ccw (src/core/addon_pipeline.rs), and TL->TR->BR is
    // clockwise as seen from the camera sitting on +Z looking toward -Z. First run rendered
    // pure black with no errors at all until this was caught - a culled quad looks identical
    // to a missing one, so this is worth checking before suspecting the texture/decode path.
    const indices = [0, 2, 1, 0, 3, 2];
    return { vertices, indices };
}

function formatTime(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function setupUI() {
    const win = Entropy.UI.createWindow({
        title: "Entropy Media Player",
        x: 875,
        y: 55,
        width: 390,
        height: 650,
        onRender: () => renderUI(win)
    });
    captionWindow = Entropy.UI.createWindow({
        title: "", x: 400, y: 665, width: 480, height: 55,
        decorations: false, resizable: false,
        onRender: () => { if (caption) Entropy.UI.Widget.label(captionWindow!, { text: caption, bold: true, fontSize: 20 }); }
    });
    Entropy.UI.setWindowVisible(captionWindow, false);
}

function renderUI(win: string) {
    Entropy.UI.Widget.label(win, { text: "Entropy Media Player", bold: true });
    Entropy.UI.Widget.label(win, { text: `${playlist[selectedIndex]}  (${selectedIndex + 1}/${playlist.length})` });
    Entropy.UI.Widget.dropdown(win, {
        id: "playlist_picker", label: "Playlist", options: playlist.map(path => path.split(/[\\/]/).pop() ?? path),
        selectedIndex, onChange: value => openIndex(Number(value))
    });
    Entropy.UI.Widget.label(win, { text: `${formatTime(displayTimeMs)} / ${formatTime(durationMs)}  ${speed}x` });
    Entropy.UI.Widget.horizontal(win, win => {
        Entropy.UI.Widget.button(win, { id: "previous_btn", text: "Previous", onClick: () => next(-1) });
        Entropy.UI.Widget.button(win, { id: "play_btn", text: isPlaying ? "Pause" : "Play", onClick: () => {
            if (!videoHandle) return;
            if (isPlaying) Entropy.Video.pause(videoHandle);
            else Entropy.Video.play(videoHandle);
            isPlaying = !isPlaying;
        }});
        Entropy.UI.Widget.button(win, { id: "next_btn", text: "Next", onClick: () => next(1) });
        Entropy.UI.Widget.button(win, { id: "remove_btn", text: "Remove", onClick: removeCurrent });
    });

    Entropy.UI.Widget.slider(win, {
        id: "seek_slider",
        label: "Seek",
        value: displayTimeMs,
        min: 0,
        max: durationMs || 1,
        onChange: (v: string) => {
            if (!videoHandle) return;
            const ms = Math.max(0, Math.min(durationMs, Number(v)));
            displayTimeMs = ms;
            Entropy.Video.seek(videoHandle, ms);
        }
    });

    Entropy.UI.Widget.slider(win, {
        id: "volume_slider",
        label: "Volume",
        value: volume,
        min: 0,
        max: 1,
        onChange: (v: string) => {
            volume = Math.max(0, Math.min(1, Number(v)));
            if (videoHandle) Entropy.Video.setVolume(videoHandle, volume);
        }
    });
    Entropy.UI.Widget.dropdown(win, {
        id: "speed_picker", label: "Speed", options: ["0.5x", "0.75x", "1x", "1.25x", "1.5x", "2x"],
        selectedIndex: [0.5, 0.75, 1, 1.25, 1.5, 2].indexOf(speed),
        onChange: value => {
            speed = [0.5, 0.75, 1, 1.25, 1.5, 2][Number(value)] ?? 1;
            if (videoHandle) Entropy.Video.setSpeed(videoHandle, speed);
        }
    });
    Entropy.UI.Widget.horizontal(win, win => {
        Entropy.UI.Widget.button(win, { id: "fullscreen_btn", text: fullscreen ? "Windowed" : "Fullscreen", onClick: () => {
            fullscreen = !fullscreen;
            Entropy.Window.setFullscreen(fullscreen);
        }});
        Entropy.UI.Widget.button(win, { id: "loop_btn", text: looping ? "Loop: On" : "Loop: Off", onClick: () => looping = !looping });
        Entropy.UI.Widget.button(win, { id: "captions_btn", text: captionsEnabled ? "Captions: On" : "Captions: Off", onClick: () => captionsEnabled = !captionsEnabled });
    });
    Entropy.UI.Widget.textInput(win, { id: "media_path", label: "Media path", value: pathDraft, onChange: value => pathDraft = value });
    Entropy.UI.Widget.button(win, { id: "add_media_btn", text: "Add and play", onClick: () => {
        const path = pathDraft.trim();
        if (!path) return;
        if (playlist.includes(path)) openIndex(playlist.indexOf(path));
        else { playlist.push(path); if (!openIndex(playlist.length - 1)) playlist.pop(); }
    }});
    Entropy.UI.Widget.textInput(win, { id: "subtitle_path", label: "SRT or VTT path", value: subtitleDraft, onChange: value => subtitleDraft = value });
    Entropy.UI.Widget.button(win, { id: "load_subtitles_btn", text: "Load subtitles", onClick: () => loadSubtitles(subtitleDraft) });
    if (captionsEnabled && caption) Entropy.UI.Widget.label(win, { text: caption, bold: true });
    if (status) Entropy.UI.Widget.label(win, { text: status });
}

addon.onInit(async () => {
    pipelineId = Entropy.Pipeline.create({
        name: "MediaPlayerQuad",
        layout: "mesh", // base groups = [camera(0), model transform(1)]; without this, an
                        // unset `layout` starts extraBindGroups at group 1, not group 2 -
                        // hit this exact "binding missing from pipeline layout" panic first try.
        pbr: false,
        vertexShader: VIDEO_QUAD_SHADER,
        fragmentShader: VIDEO_QUAD_SHADER,
        extraBindGroups: [
            {
                entries: [
                    { binding: 0, visibility: ["Fragment"], resourceType: "Texture" },
                    { binding: 1, visibility: ["Fragment"], resourceType: "Sampler" },
                ]
            }
        ]
    });

    Entropy.Camera.setTransform([0, 0, 3], [0, 0, 0]);
    setupUI();
    openIndex(0);
});

addon.onUpdatePlus("Global", (_time: number) => {
    if (!videoHandle) return;
    const result = Entropy.Video.poll(videoHandle);
    isPlaying = result.playing;
    displayTimeMs = result.currentTimeMs;
    caption = captionsEnabled ? subtitleAt(cues, displayTimeMs) : "";
    if (captionWindow) Entropy.UI.setWindowVisible(captionWindow, !!caption);
    if (lastPlaying && !isPlaying && displayTimeMs >= durationMs - 100) {
        if (looping) openIndex(selectedIndex);
        else if (selectedIndex < playlist.length - 1) next(1);
    }
    lastPlaying = isPlaying;
});
