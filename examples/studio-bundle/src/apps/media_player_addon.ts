// Entropy Media Player - a small standalone EntropyApp built to exercise (and harden) the
// engine's Media Foundation video decode path, an addon-facing Entropy.Video API added
// alongside this addon (src/media_player/mod.rs, src/deno/addon_ops.rs `op_video_*`), and the
// entropy_gui-backed Entropy.UI widgets (label/button/slider) for transport controls.
//
// Windows-only (Media Foundation). A Mac/AVFoundation backend is out of scope for this pass.

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

// Bundled sample clip (200x200 h264, ~26s) - no open-file dialog exists in Entropy.UI yet,
// so arbitrary file loading is explicitly out of scope for this pass.
const SAMPLE_CLIP = "public/yumondesktop.mp4";

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
let textureId: string | null = null;
let videoWidth = 16;
let videoHeight = 9;
let durationMs = 0;
let isPlaying = false;
let volume = 1.0;
let displayTimeMs = 0;

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
        width: 340,
        height: 220,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    Entropy.UI.Widget.label(win, { text: "Entropy Media Player", bold: true });
    Entropy.UI.Widget.label(win, { text: `${formatTime(displayTimeMs)} / ${formatTime(durationMs)}` });

    Entropy.UI.Widget.button(win, {
        text: isPlaying ? "Pause" : "Play",
        onClick: () => {
            if (!videoHandle) return;
            if (isPlaying) {
                Entropy.Video.pause(videoHandle);
            } else {
                Entropy.Video.play(videoHandle);
            }
        }
    });

    Entropy.UI.Widget.slider(win, {
        label: "Seek",
        value: displayTimeMs,
        min: 0,
        max: durationMs || 1,
        onChange: (v: number) => {
            if (!videoHandle) return;
            const ms = parseFloat(v as unknown as string);
            displayTimeMs = ms;
            Entropy.Video.seek(videoHandle, ms);
        }
    });

    Entropy.UI.Widget.slider(win, {
        label: "Volume",
        value: volume,
        min: 0,
        max: 1,
        onChange: (v: number) => {
            volume = parseFloat(v as unknown as string);
            if (videoHandle) Entropy.Video.setVolume(videoHandle, volume);
        }
    });
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

    const opened = Entropy.Video.open(SAMPLE_CLIP);
    videoHandle = opened.handle;
    videoWidth = opened.width;
    videoHeight = opened.height;
    durationMs = opened.durationMs;
    Entropy.println(`Media Player: opened ${SAMPLE_CLIP} (${videoWidth}x${videoHeight}, ${(durationMs / 1000).toFixed(1)}s, ${opened.frameRate.toFixed(1)}fps)`);

    textureId = Entropy.Texture.createEx({
        width: videoWidth,
        height: videoHeight,
        format: "Rgba8Unorm",
        usage: ["Texture", "CopyDst"]
    }, null);

    Entropy.Video.bindTexture(videoHandle, textureId);

    const { vertices, indices } = buildQuad(videoWidth / videoHeight);
    Entropy.Model.createMesh({
        id: "media_player_quad",
        position: [0, 0, 0],
        vertexData: vertices,
        indexData: indices,
        pipelineId: pipelineId,
        bindings: [
            { group: 2, binding: 0, resource: { type: "Texture", value: { id: textureId } } },
            { group: 2, binding: 1, resource: { type: "Sampler" } },
        ]
    } as any);

    Entropy.Camera.setTransform([0, 0, 3], [0, 0, 0]);

    setupUI();

    Entropy.Video.play(videoHandle);
    isPlaying = true;
});

addon.onUpdatePlus("Global", (_time: number) => {
    if (!videoHandle) return;
    const result = Entropy.Video.poll(videoHandle);
    isPlaying = result.playing;
    displayTimeMs = result.currentTimeMs;
});
