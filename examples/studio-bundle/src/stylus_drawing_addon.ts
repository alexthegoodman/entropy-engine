// A pressure/tilt-sensitive drawing app, built on:
//  - src/stylus.rs + the WM_POINTER msg-hook it installs (see that file's header comment) -
//    winit 0.30.12's own `WindowEvent::Touch` has pressure but no tilt at all, so tilt is read
//    straight out of the raw Win32 pen packet and threaded back in as `Entropy.Input.onStylusMove`.
//  - The game2d layer (camera2d.ts/sprite.ts/textures.ts) for display: the whole canvas is one
//    `Sprite` quad sampling one `Entropy.Texture`, exactly the "dynamic texture on a full-frame
//    quad" shape media_player_addon.ts uses for video frames - painting is CPU-side pixel math
//    into a plain `Uint8Array`, pushed to the GPU with `Entropy.Texture.update`.
//
// Canvas pixels map 1:1 to window pixels (no camera/world-space math for painting - only the
// display quad uses the orthographic camera) - see CANVAS_W/H below, which must match the
// window size passed to `.with_window_size` in src/bin/example.rs.

import { createSpritePipeline, Sprite } from "./game2d/sprite";
import { Camera2D } from "./game2d/camera2d";

const addonInfo = {
    name: "Stylus Drawing",
    version: "1.0.0",
    description: "Pressure + tilt sensitive drawing with pencil/ink/airbrush/eraser brushes",
    author: ["Entropy Team", "Claude"],
    capabilities: {
        graphics: true,
        ui: true
    }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const CANVAS_W = 1280;
const CANVAS_H = 800;

// --- Brush model -----------------------------------------------------------------------------
//
// Every brush stamps a (possibly elongated) soft- or hard-edged ellipse at points sampled along
// the stroke. Tilt isn't a real azimuth/altitude pair here - see `tiltVector` below - it's
// tiltX/tiltY treated as a 2D vector, whose angle becomes the ellipse's elongation direction and
// whose magnitude becomes how elongated it gets. That's a deliberate simplification, not a
// rigorous conversion (documented in the post's decision log), but it's enough to make "Ink
// Brush" visibly behave like a flat calligraphy nib as the pen tilts.
interface Brush {
    name: string;
    color: [number, number, number]; // 0-255, ignored for the eraser (always paints background)
    isEraser: boolean;
    baseRadius: number; // px at pressure=0
    radiusGain: number; // added px at pressure=1
    softness: number; // 0 = hard edge (small AA band), 1 = wide gaussian-ish falloff
    opacityBase: number; // 0-1 alpha at pressure=0
    opacityGain: number; // additional alpha at pressure=1 (clamped to 1 total)
    tiltElongation: number; // 0 = circular regardless of tilt, ~0.8 = strongly elongated
    spacingFactor: number; // fraction of current stamp radius between stamps along a stroke
}

const BACKGROUND: [number, number, number] = [250, 248, 244];

const BRUSHES: Brush[] = [
    {
        name: "Pencil",
        color: [55, 52, 48],
        isEraser: false,
        baseRadius: 1.2,
        radiusGain: 2.0,
        softness: 0.15,
        opacityBase: 0.55,
        opacityGain: 0.35,
        tiltElongation: 0.15,
        spacingFactor: 0.35,
    },
    {
        name: "Ink Brush",
        color: [18, 20, 32],
        isEraser: false,
        baseRadius: 3.5,
        radiusGain: 11.0,
        softness: 0.08,
        opacityBase: 0.92,
        opacityGain: 0.08,
        tiltElongation: 0.85,
        spacingFactor: 0.22,
    },
    {
        name: "Airbrush",
        color: [224, 88, 44],
        isEraser: false,
        baseRadius: 12.0,
        radiusGain: 10.0,
        softness: 0.95,
        opacityBase: 0.05,
        opacityGain: 0.16,
        tiltElongation: 0.3,
        spacingFactor: 0.12,
    },
    {
        name: "Eraser",
        color: BACKGROUND,
        isEraser: true,
        baseRadius: 8.0,
        radiusGain: 14.0,
        softness: 0.4,
        opacityBase: 0.9,
        opacityGain: 0.1,
        tiltElongation: 0.0,
        spacingFactor: 0.3,
    },
];

let brushIndex = 1; // start on Ink Brush - the one that best shows tilt off
let sizeMultiplier = 1.0;

function currentBrush(): Brush {
    return BRUSHES[brushIndex];
}

// --- Canvas buffer -----------------------------------------------------------------------------

// Plain Uint8Array, not Uint8ClampedArray - Entropy.Texture.create/update's type is
// `number[] | Uint8Array`, and every write below is already a convex blend of two 0-255 values
// (see `stamp`'s per-channel blend), so it never leaves the 0-255 range and needs no clamping.
const canvas = new Uint8Array(CANVAS_W * CANVAS_H * 4);
function clearCanvas(): void {
    for (let i = 0; i < canvas.length; i += 4) {
        canvas[i] = BACKGROUND[0];
        canvas[i + 1] = BACKGROUND[1];
        canvas[i + 2] = BACKGROUND[2];
        canvas[i + 3] = 255;
    }
    canvasDirty = true;
}

let canvasDirty = true;
let textureId: string;

// Paints one elliptical stamp centered at (cx, cy). `angle` is the elongation direction
// (radians), `elongation` in [0,1] widens the major axis and narrows the minor axis so a
// strongly tilted "Ink Brush" stamp reads as a flat nib stroke rather than a fat circle.
function stamp(brush: Brush, cx: number, cy: number, radius: number, alpha: number, angle: number, elongation: number): void {
    if (radius <= 0 || alpha <= 0) return;

    const majorR = radius * (1 + elongation * 0.9);
    const minorR = radius * (1 - elongation * 0.55);
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);

    const extent = Math.ceil(majorR) + 1;
    const minX = Math.max(0, Math.floor(cx - extent));
    const maxX = Math.min(CANVAS_W - 1, Math.ceil(cx + extent));
    const minY = Math.max(0, Math.floor(cy - extent));
    const maxY = Math.min(CANVAS_H - 1, Math.ceil(cy + extent));

    const [r, g, b] = brush.color;
    const hardEdge = 1 - brush.softness;

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const dx = x + 0.5 - cx;
            const dy = y + 0.5 - cy;
            // Rotate into the ellipse's local frame, then treat it as a unit circle scaled by
            // major/minor radius - the standard ellipse-membership trick.
            const lx = dx * cosA - dy * sinA;
            const ly = dx * sinA + dy * cosA;
            const dist = Math.sqrt((lx / majorR) ** 2 + (ly / minorR) ** 2);
            if (dist > 1) continue;

            // softness=0: crisp edge with a ~1px antialiasing band. softness=1: falloff starts
            // from the center, giving the wide soft blob an airbrush stamp needs.
            const falloff = hardEdge > 0.01
                ? Math.min(1, (1 - dist) / Math.max(0.02, 1 - hardEdge))
                : (1 - dist * dist);
            const a = alpha * Math.max(0, falloff);
            if (a <= 0.002) continue;

            const i = (y * CANVAS_W + x) * 4;
            canvas[i] = r * a + canvas[i] * (1 - a);
            canvas[i + 1] = g * a + canvas[i + 1] * (1 - a);
            canvas[i + 2] = b * a + canvas[i + 2] * (1 - a);
            // canvas alpha stays 255 - this is an opaque page, not a compositing layer.
        }
    }
    canvasDirty = true;
}

interface StrokePoint {
    x: number;
    y: number;
    pressure: number;
    tiltX: number;
    tiltY: number;
}

let lastPoint: StrokePoint | null = null;

// tiltX/tiltY are independent per-axis angles (winit/Win32 convention), not a real
// azimuth/altitude pair - see the Brush interface comment. Magnitude is normalized against 60
// degrees rather than the full +-90 range because most styli rarely report past ~45-50 degrees
// in normal drawing grips; clamping there gives the elongation effect useful range instead of
// saturating only at the extreme edge of the pen's tilt travel.
function tiltVector(tiltX: number, tiltY: number): { angle: number; magnitude: number } {
    const angle = Math.atan2(tiltY, tiltX);
    const magnitude = Math.min(1, Math.hypot(tiltX, tiltY) / 60);
    return { angle, magnitude };
}

function paintSegment(from: StrokePoint, to: StrokePoint): void {
    const brush = currentBrush();
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const approxRadius = brush.baseRadius + brush.radiusGain * Math.max(from.pressure, to.pressure);
    const step = Math.max(0.75, approxRadius * brush.spacingFactor);
    const steps = Math.max(1, Math.ceil(dist / step));

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        const pressure = from.pressure + (to.pressure - from.pressure) * t;
        const tiltX = from.tiltX + (to.tiltX - from.tiltX) * t;
        const tiltY = from.tiltY + (to.tiltY - from.tiltY) * t;

        const radius = (brush.baseRadius + brush.radiusGain * pressure) * sizeMultiplier;
        const alpha = Math.min(1, brush.opacityBase + brush.opacityGain * pressure);
        const { angle, magnitude } = tiltVector(tiltX, tiltY);
        stamp(brush, x, y, radius, alpha, angle, brush.tiltElongation * magnitude);
    }
}

// --- Input wiring ------------------------------------------------------------------------------
//
// Windows 8+ also synthesizes legacy WM_LBUTTONDOWN/MOUSEMOVE/WM_LBUTTONUP for pen input
// alongside the WM_POINTER packets it's actually driven from (app-compatibility behavior, not
// specific to this engine). Without `usingStylus`, a real pen stroke would draw twice - once
// from onStylusMove, once from the synthesized onMouseMove. The mouse handlers below exist as a
// no-tablet-required fallback (fixed pressure/tilt) for testing this addon with a plain mouse,
// not as a second input path a real stylus should also drive.
let usingStylus = false;
let usingStylusClearPending = false;
let mouseDrawing = false;

let lastStylusReading = { pressure: 0, tiltX: 0 as number | null, tiltY: 0 as number | null };
let strokeEventCount = 0;
let strokeStartFrame = 0;

Entropy.Input.onStylusDown((e) => {
    usingStylus = true;
    usingStylusClearPending = false; // a new stroke starting cancels the previous stroke's guard-release
    lastStylusReading = { pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY };
    lastPoint = { x: e.x, y: e.y, pressure: e.pressure, tiltX: e.tiltX ?? 0, tiltY: e.tiltY ?? 0 };
    strokeEventCount = 1;
    strokeStartFrame = frameCount;
    stamp(
        currentBrush(),
        e.x, e.y,
        (currentBrush().baseRadius + currentBrush().radiusGain * e.pressure) * sizeMultiplier,
        Math.min(1, currentBrush().opacityBase + currentBrush().opacityGain * e.pressure),
        0, 0
    );
});

Entropy.Input.onStylusMove((e) => {
    lastStylusReading = { pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY };
    if (!lastPoint) return; // move without a preceding down - ignore, nothing to connect to
    strokeEventCount++;
    const point: StrokePoint = { x: e.x, y: e.y, pressure: e.pressure, tiltX: e.tiltX ?? 0, tiltY: e.tiltY ?? 0 };
    paintSegment(lastPoint, point);
    lastPoint = point;
});

Entropy.Input.onStylusUp((_e) => {
    lastPoint = null;
    if (strokeEventCount > 0) {
        const frames = Math.max(1, frameCount - strokeStartFrame);
        Entropy.println(`[stylus-drawing] stylus stroke: ${strokeEventCount} pointer events over ${frames} rendered frames (${(strokeEventCount / frames).toFixed(2)} events/frame)`);
    }
    // Swallow the very next synthesized mouse-up compatibility event too, then release the
    // guard on the next real frame - see the comment above this section. `setTimeout` doesn't
    // exist in this addon's JS runtime (deno_core with no timer ops bound, not a browser or
    // Node) - discovered as a real ReferenceError logged on every stylus-up during hardware
    // testing (see the post's Failure Notes). `onUpdatePlus` is this codebase's own "next tick"
    // primitive (already used for `canvasDirty` above), so defer through that instead.
    usingStylusClearPending = true;
});

let mouseMoveEventsThisFrame = 0;

let currentMouseX = 0;
let currentMouseY = 0;

// Per-stroke event-vs-frame counters - see the "Evidence" section of the post this addon
// shipped with. A stroke's move-event count and the number of real rendered frames it spanned
// are independent (input arrives on its own cadence; onUpdatePlus runs once per render), and the
// gap between them is exactly why canvasDirty (below) throttles Entropy.Texture.update to once
// per frame instead of once per move event.
let mouseStrokeEvents = 0;
let mouseStrokeStartFrame = 0;

Entropy.Input.onMouseDown((button) => {
    if (button !== 0 || usingStylus) return;
    if (Entropy.Input.isPointerOverUI()) return;
    mouseDrawing = true;
    mouseStrokeEvents = 0;
    mouseStrokeStartFrame = frameCount;
    const point: StrokePoint = { x: currentMouseX, y: currentMouseY, pressure: 1.0, tiltX: 0, tiltY: 0 };
    lastPoint = point;
    const brush = currentBrush();
    stamp(brush, point.x, point.y, (brush.baseRadius + brush.radiusGain) * sizeMultiplier,
        Math.min(1, brush.opacityBase + brush.opacityGain), 0, 0);
});

Entropy.Input.onMouseMove((x, y) => {
    currentMouseX = x;
    currentMouseY = y;
    if (usingStylus) return;
    mouseMoveEventsThisFrame++;
    if (!mouseDrawing) return;
    if (Entropy.Input.isPointerOverUI()) return;
    mouseStrokeEvents++;
    const point: StrokePoint = { x, y, pressure: 1.0, tiltX: 0, tiltY: 0 };
    if (lastPoint) paintSegment(lastPoint, point);
    lastPoint = point;
});

Entropy.Input.onMouseUp((button) => {
    if (button !== 0 || usingStylus) return;
    mouseDrawing = false;
    lastPoint = null;
    if (mouseStrokeEvents > 0) {
        const frames = Math.max(1, frameCount - mouseStrokeStartFrame);
        Entropy.println(`[stylus-drawing] mouse stroke: ${mouseStrokeEvents} move events over ${frames} rendered frames (${(mouseStrokeEvents / frames).toFixed(2)} events/frame)`);
    }
});

Entropy.Input.onKeyDown((key) => {
    const k = key.toLowerCase();
    if (k === "1") setBrush(0);
    else if (k === "2") setBrush(1);
    else if (k === "3") setBrush(2);
    else if (k === "4") setBrush(3);
    else if (k === "c") clearCanvas();
});

function setBrush(index: number): void {
    brushIndex = index;
    Entropy.println(`[stylus-drawing] brush -> ${currentBrush().name}`);
}

// --- Frame-rate texture throttling ---------------------------------------------------------
//
// The first version called Entropy.Texture.update() directly inside onStylusMove/onMouseMove -
// once per pointer event. A fast mouse drag alone was measured (see Evidence in the post)
// producing several times more move events than rendered frames over the same drag; uploading a
// full CANVAS_W*CANVAS_H*4 byte buffer that many times is pure waste; nothing between two events
// that land in the same rendered frame is ever seen on screen. `canvasDirty` defers the actual
// upload to onUpdatePlus, at most once per real frame.
let frameCount = 0;
let lastStatLogTime = 0;

addon.onInit(() => {
    for (let i = 0; i < canvas.length; i += 4) {
        canvas[i] = BACKGROUND[0];
        canvas[i + 1] = BACKGROUND[1];
        canvas[i + 2] = BACKGROUND[2];
        canvas[i + 3] = 255;
    }

    textureId = Entropy.Texture.create(CANVAS_W, CANVAS_H, canvas);

    const pipelineId = createSpritePipeline("StylusCanvas");
    new Sprite({ textureId, pipelineId, x: 0, y: 0, z: 0, halfW: CANVAS_W / 2, halfH: CANVAS_H / 2 });

    const camera = new Camera2D(CANVAS_H);
    camera.lookAt(0, 0);

    setupUI();

    // One-time micro-benchmark: cost of a single full-buffer Entropy.Texture.update call at this
    // canvas resolution, on this machine - the actual number behind "throttle uploads to once per
    // frame" (see the comment above `frameCount`), independent of how fast any particular input
    // device happens to report. See the post's Evidence section for the printed result.
    const N = 30;
    const benchStart = Date.now();
    for (let i = 0; i < N; i++) {
        Entropy.Texture.update(textureId, canvas);
    }
    const benchMs = Date.now() - benchStart;
    Entropy.println(`[stylus-drawing] bench: ${N}x Texture.update(${CANVAS_W}x${CANVAS_H}) = ${benchMs}ms total, ${(benchMs / N).toFixed(2)}ms/call`);

    Entropy.println(`[stylus-drawing] initialized: ${CANVAS_W}x${CANVAS_H} canvas, ${BRUSHES.length} brushes`);
});

let uiWindowId: string;

function setupUI(): void {
    uiWindowId = Entropy.UI.createWindow({
        title: "Stylus Drawing",
        width: 260,
        // Tall enough for every widget in renderUI without scrolling - 360 clipped the "Last pen
        // reading" pressure/tilt readout below the fold (only found by screenshotting the real
        // running window, not by reading the layout code).
        height: 520,
        x: 20,
        y: 20,
        onRender: renderUI
    });
}

function renderUI(): void {
    Entropy.UI.Widget.label(uiWindowId, { text: "Stylus Drawing", bold: true });
    Entropy.UI.Widget.label(uiWindowId, { text: `Brush: ${currentBrush().name}` });
    Entropy.UI.Widget.separator(uiWindowId);

    for (let i = 0; i < BRUSHES.length; i++) {
        Entropy.UI.Widget.button(uiWindowId, {
            text: (i === brushIndex ? "> " : "  ") + BRUSHES[i].name,
            id: `brush_btn_${i}`,
            onClick: () => setBrush(i)
        });
    }

    Entropy.UI.Widget.separator(uiWindowId);
    Entropy.UI.Widget.slider(uiWindowId, {
        label: "Size",
        value: sizeMultiplier,
        min: 0.3,
        max: 3.0,
        id: "size_slider",
        onChange: (v: string) => { sizeMultiplier = parseFloat(v); }
    });

    Entropy.UI.Widget.button(uiWindowId, {
        text: "Clear Canvas (C)",
        id: "clear_btn",
        onClick: () => clearCanvas()
    });

    Entropy.UI.Widget.separator(uiWindowId);
    Entropy.UI.Widget.label(uiWindowId, { text: "Last pen reading:" });
    Entropy.UI.Widget.label(uiWindowId, { text: `pressure: ${lastStylusReading.pressure.toFixed(2)}` });
    Entropy.UI.Widget.label(uiWindowId, {
        text: `tilt: ${lastStylusReading.tiltX === null ? "n/a" : lastStylusReading.tiltX.toFixed(1)}, `
            + `${lastStylusReading.tiltY === null ? "n/a" : lastStylusReading.tiltY.toFixed(1)}`
    });
    Entropy.UI.Widget.label(uiWindowId, { text: "Keys: 1-4 brush, C clear" });
}

addon.onUpdatePlus("Global", (_time: number) => {
    frameCount++;
    if (usingStylusClearPending) {
        usingStylusClearPending = false;
        usingStylus = false;
    }
    if (canvasDirty) {
        Entropy.Texture.update(textureId, canvas);
        canvasDirty = false;
    }

    const now = Date.now();
    if (now - lastStatLogTime > 2000) {
        lastStatLogTime = now;
        Entropy.println(`[stylus-drawing] tick ${frameCount}, mouseMoveEvents/2s window=${mouseMoveEventsThisFrame}`);
        mouseMoveEventsThisFrame = 0;
    }
});
