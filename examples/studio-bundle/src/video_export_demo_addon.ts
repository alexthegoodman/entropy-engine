// Exercises the video export path added alongside this addon: a Windows/Media-Foundation H.264
// encoder (src/video_export/encode.rs) and the offscreen frame loop that drives it
// (src/video_export/exporter.rs's run_export, called from EntropyPipeline::render_display_frame
// via the new Entropy.Video.export/pollExport ops - see src/deno/addon_ops.rs `op_video_export_*`).
//
// The scene is a single lit cube with an orbiting camera. The orbit itself is driven twice, by
// two different pieces of code: `onUpdatePlus` below animates it live while nothing is
// exporting, and `run_export` drives the identical formula directly in Rust during an export.
// That duplication is deliberate, not an oversight: export runs synchronously on the render
// thread and blocks the whole JS runtime (including this addon's own onUpdatePlus) for its
// duration, so the live per-tick callback never runs during the frames being captured - an
// export that relied on it would just capture N copies of one frozen frame. See the 2026-09-11
// video export post's decision log.

const addonInfo = {
    name: "Video Export Demo",
    version: "1.0.0",
    description: "Orbiting-camera cube scene, exported to MP4 via Entropy.Video.export",
    author: ["Entropy Team", "Claude"],
    capabilities: {
        graphics: true,
        ui: true
    }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const OUTPUT_PATH = "public/video_export_demo.mp4";
const EXPORT_FPS = 30;
const EXPORT_DURATION_MS = 3000;
const ORBIT_RADIUS = 6;

let statusText = "Idle";
let exporting = false;
let orbitAngle = 0;

// 12 floats/vertex: position(3), normal(3), tex_coords(2), color(4) - the fixed layout every
// Entropy.Model.createMesh vertex buffer uses (see media_player_addon.ts's buildQuad for the
// same convention). geometry_pipeline's PrimitiveState has cull_mode: None (src/core/pipeline.rs
// ~line 1060), so triangle winding doesn't affect visibility here - only the per-face normal
// direction (for lighting) matters.
function buildCube(half: number): { vertices: number[]; indices: number[] } {
    const faces: { normal: [number, number, number]; corners: [number, number, number][] }[] = [
        { normal: [1, 0, 0], corners: [[half, -half, -half], [half, half, -half], [half, half, half], [half, -half, half]] },
        { normal: [-1, 0, 0], corners: [[-half, -half, half], [-half, half, half], [-half, half, -half], [-half, -half, -half]] },
        { normal: [0, 1, 0], corners: [[-half, half, -half], [-half, half, half], [half, half, half], [half, half, -half]] },
        { normal: [0, -1, 0], corners: [[-half, -half, half], [-half, -half, -half], [half, -half, -half], [half, -half, half]] },
        { normal: [0, 0, 1], corners: [[-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half]] },
        { normal: [0, 0, -1], corners: [[half, -half, -half], [-half, -half, -half], [-half, half, -half], [half, half, -half]] },
    ];

    const color = [1.0, 0.55, 0.2, 1.0];
    const vertices: number[] = [];
    const indices: number[] = [];

    faces.forEach((face, faceIndex) => {
        face.corners.forEach((pos, cornerIndex) => {
            const uv = [[0, 0], [1, 0], [1, 1], [0, 1]][cornerIndex];
            vertices.push(...pos, ...face.normal, ...uv, ...color);
        });
        const base = faceIndex * 4;
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });

    return { vertices, indices };
}

function orbitCamera(angle: number) {
    Entropy.Camera.setTransform(
        [Math.cos(angle) * ORBIT_RADIUS, 3, Math.sin(angle) * ORBIT_RADIUS],
        [0, 0, 0]
    );
}

function setupUI() {
    const win = Entropy.UI.createWindow({
        title: "Video Export Demo",
        width: 340,
        height: 150,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    Entropy.UI.Widget.label(win, { text: "Video Export Demo", bold: true });
    Entropy.UI.Widget.label(win, { text: statusText });

    Entropy.UI.Widget.button(win, {
        text: exporting ? "Exporting..." : `Export ${EXPORT_DURATION_MS / 1000}s Clip to MP4`,
        onClick: () => {
            if (exporting) return;
            exporting = true;
            statusText = `Exporting ${EXPORT_DURATION_MS / 1000}s @ ${EXPORT_FPS}fps - window will freeze...`;
            Entropy.Video.export({
                outputPath: OUTPUT_PATH,
                fps: EXPORT_FPS,
                durationMs: EXPORT_DURATION_MS
            });
        }
    });
}

addon.onInit(() => {
    // Built as an explicit mesh (Entropy.Model.createMesh, pipelineId "default") rather than
    // Model.createProcedural({type:"cube"}) - createProcedural is only exposed on the
    // addon-scoped API this register() call returns, not on the global Entropy, and even once
    // called correctly it rendered nothing (a fully black frame, live and exported alike) for
    // reasons not tracked down in this pass. createMesh with explicit vertex data is the same
    // path media_player_addon.ts's video quad uses and is known to draw and light correctly.
    const { vertices, indices } = buildCube(0.75);
    Entropy.Model.createMesh({
        id: "video_export_demo_cube",
        position: [0, 0, 0],
        vertexData: vertices,
        indexData: indices,
        pipelineId: "default"
    } as any);

    Entropy.Lighting.updateSun({
        sunDirection: [0.3, 1.0, 0.2],
        sunIntensity: 6.0
    });

    Entropy.Lighting.createPointLight({
        id: "video_export_demo_key_light",
        position: [4, 6, 4],
        color: [1, 1, 1],
        intensity: 40.0,
        maxDistance: 30.0
    });

    orbitCamera(orbitAngle);
    setupUI();

    Entropy.println("Video Export Demo: initialized (cube + orbiting camera + key light)");
});

addon.onUpdatePlus("Global", (_time: number) => {
    if (exporting) {
        const result = Entropy.Video.pollExport();
        if (result) {
            exporting = false;
            statusText = result.error
                ? `Export failed: ${result.error}`
                : `Exported ${result.frameCount} frames to ${result.outputPath} in ${result.elapsedMs}ms`;
            Entropy.println(`[video-export-demo] ${statusText}`);
        }
        // Frozen during export (see the file-level note) - no point animating the live camera
        // for frames that won't be shown until the export finishes anyway.
        return;
    }

    orbitAngle += 0.01;
    orbitCamera(orbitAngle);
});
