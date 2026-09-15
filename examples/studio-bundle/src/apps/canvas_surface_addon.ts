// Hand-drawn 3D level building: anchored, movable canvas surfaces an artist draws on directly
// with a tablet, as an in-engine alternative to sculpting or round-tripping through a separate
// DCC tool. This is Phase 1 of the epic (see the canvas-surfaces-phase1 card in
// cc-manager/tasks.json for the full architecture note) - it covers create/position a surface,
// pressure/tilt stylus drawing on it, detach/relocate, "it's already the real level" (no export
// step), and viewing from a free camera. Bend/curve and stroke grouping are separate follow-up
// phases (canvas-surfaces-phase2-bend / -phase3-grouping), deliberately not attempted here.
//
// Each surface is one flat quad mesh - the same 4-vert/2-triangle shape game2d's Sprite uses,
// generalized from a 2D x/y/rotation to a real 3D position + yaw/pitch/roll - created once via
// Entropy.Model.createMesh and then only ever moved by recomputing its 4 world-space corners and
// pushing them with Entropy.Mesh.updateVertices. That's not a simplification for this demo: per
// sprite.ts's own doc comment, a plain createMesh mesh has no updatable transform of its own,
// only vertex positions, so this is the only way to move it at all.
//
// Each surface owns a private CPU-painted RGBA texture (Entropy.Texture.create/update), sampled
// by a small unlit custom pipeline - same "dynamic texture on a textured quad" shape as
// media_player_addon.ts's video quad and game2d's sprite pipeline. The brush/stamp/paintSegment
// pixel-painting code below is stylus_drawing_addon.ts's, generalized to paint into whichever
// surface's own canvas buffer a stroke lands on instead of one global canvas.
//
// Turning a screen-space pointer position into a surface-local paint coordinate is a hand-rolled
// ray-plane intersection (surface plane = its position + its rotated local +Z normal), converted
// to local UV and then to pixel coordinates - the same shape as fft_water_addon.ts's
// raycastToOceanPlane/worldToOceanUV. This is deliberate, not a missing feature: addon.d.ts
// declares Entropy.Selection.raycast(screenX, screenY), but its Rust side (op_selection_raycast)
// doesn't exist yet - src/deno/addon_setup.js's own implementation is a stub that always returns
// null (confirmed by reading it), so relying on it here would silently never work.
//
// Position can be edited either by dragging Entropy.Gizmo's translate handles (requires
// Entropy.setGameMode(false), since the gizmo's render pass is gated on !game_mode) or with the
// X/Y/Z sliders - both drive the same setSurfacePosition() path, including edge snapping. An
// earlier session briefly concluded the gizmo drag was broken outside Studio; that was a false
// alarm caused by that session's own coarse synthetic-mouse testing (a handful of large jumps,
// which Windows coalesces into almost no real CursorMoved events while a button is held) - see
// the gizmo-translate-drag-false-alarm-corrected card. A real mouse or stylus drag works fine.
//
// Surfaces snap together at the edges (and centers) when moved via either the gizmo or the
// position sliders: setSurfacePosition() compares the moving surface's world-space AABB (from its
// 4 corners) against every other surface's AABB, per axis independently, and pulls the candidate
// position onto the nearest edge/center alignment within SNAP_DISTANCE. This is an AABB snap, not
// a true rotated-edge snap - exact for axis-aligned surfaces (the common case: tiling flat panels
// into a wall or floor), approximate for tilted ones.

const addonInfo = {
    name: "Canvas Surfaces",
    version: "1.0.0",
    description: "Hand-drawn 3D level building: anchored, movable canvas surfaces you draw on with a tablet",
    author: ["Entropy Team", "Claude"],
    capabilities: {
        graphics: true,
        ui: true
    }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const CANVAS_RES = 768; // per-surface texture resolution (square)
const DEFAULT_HALF_SIZE = 1.5; // world units - a 3x3 unit surface by default

// --- Brush model (verbatim from stylus_drawing_addon.ts) --------------------------------------
//
// Every brush stamps a (possibly elongated) soft- or hard-edged ellipse at points sampled along
// the stroke. Tilt is treated as a 2D vector (tiltX, tiltY), not a rigorous azimuth/altitude
// pair - its angle becomes the ellipse's elongation direction, its magnitude how elongated it
// gets. Good enough to make "Ink Brush" read as a flat calligraphy nib as the pen tilts.
interface Brush {
    name: string;
    color: [number, number, number];
    isEraser: boolean;
    baseRadius: number;
    radiusGain: number;
    softness: number;
    opacityBase: number;
    opacityGain: number;
    tiltElongation: number;
    spacingFactor: number;
}

const BACKGROUND: [number, number, number] = [250, 248, 244];

const BRUSHES: Brush[] = [
    { name: "Pencil", color: [55, 52, 48], isEraser: false, baseRadius: 1.5, radiusGain: 2.5, softness: 0.15, opacityBase: 0.55, opacityGain: 0.35, tiltElongation: 0.15, spacingFactor: 0.35 },
    { name: "Ink Brush", color: [18, 20, 32], isEraser: false, baseRadius: 4.0, radiusGain: 12.0, softness: 0.08, opacityBase: 0.92, opacityGain: 0.08, tiltElongation: 0.85, spacingFactor: 0.22 },
    { name: "Airbrush", color: [224, 88, 44], isEraser: false, baseRadius: 14.0, radiusGain: 12.0, softness: 0.95, opacityBase: 0.05, opacityGain: 0.16, tiltElongation: 0.3, spacingFactor: 0.12 },
    { name: "Eraser", color: BACKGROUND, isEraser: true, baseRadius: 10.0, radiusGain: 16.0, softness: 0.4, opacityBase: 0.9, opacityGain: 0.1, tiltElongation: 0.0, spacingFactor: 0.3 },
];

let brushIndex = 1;
let sizeMultiplier = 1.0;
function currentBrush(): Brush {
    return BRUSHES[brushIndex];
}

function tiltVector(tiltX: number, tiltY: number): { angle: number; magnitude: number } {
    const angle = Math.atan2(tiltY, tiltX);
    const magnitude = Math.min(1, Math.hypot(tiltX, tiltY) / 60);
    return { angle, magnitude };
}

// --- Rotation helpers ---------------------------------------------------------------------------
//
// A surface's orientation is yaw (Y axis) / pitch (X axis) / roll (Z axis), composed as
// world = Ry(yaw) * Rx(pitch) * Rz(roll) * local. worldToLocalDir is the exact inverse
// (each per-axis rotation is orthonormal, so the inverse is the same rotations, reversed order,
// negated angles) - used to turn a world-space ray/plane hit back into the surface's own frame.
type Vec3 = [number, number, number];

function rotX([x, y, z]: Vec3, a: number): Vec3 {
    const c = Math.cos(a), s = Math.sin(a);
    return [x, y * c - z * s, y * s + z * c];
}
function rotY([x, y, z]: Vec3, a: number): Vec3 {
    const c = Math.cos(a), s = Math.sin(a);
    return [x * c + z * s, y, -x * s + z * c];
}
function rotZ([x, y, z]: Vec3, a: number): Vec3 {
    const c = Math.cos(a), s = Math.sin(a);
    return [x * c - y * s, x * s + y * c, z];
}

function localToWorldDir(v: Vec3, yaw: number, pitch: number, roll: number): Vec3 {
    return rotY(rotX(rotZ(v, roll), pitch), yaw);
}
function worldToLocalDir(v: Vec3, yaw: number, pitch: number, roll: number): Vec3 {
    return rotZ(rotX(rotY(v, -yaw), -pitch), -roll);
}
function addV(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subV(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dotV(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// --- Surface ------------------------------------------------------------------------------------

// Local corners, matching game2d/sprite.ts's CORNERS/QUAD_INDICES exactly (same winding, same
// backface-culling reasoning - this pipeline is created with the same default front-face
// convention) with a local z=0 added since these live in real 3D instead of a 2D x/y plane.
const CORNERS: Array<[number, number, number, number]> = [
    [-1, 1, 0, 0],  // top-left
    [1, 1, 1, 0],   // top-right
    [1, -1, 1, 1],  // bottom-right
    [-1, -1, 0, 1], // bottom-left
];
const QUAD_INDICES = [0, 2, 1, 0, 3, 2];

interface Surface {
    id: string;
    meshId: string;
    textureId: string;
    name: string;
    position: Vec3;
    yaw: number;
    pitch: number;
    roll: number;
    halfW: number;
    halfH: number;
    canvas: Uint8Array;
    dirty: boolean;
    visible: boolean;
}

const surfaces: Surface[] = [];
let activeSurfaceId: string | null = null;
let pipelineId: string;

function clearCanvasBuffer(canvas: Uint8Array): void {
    for (let i = 0; i < canvas.length; i += 4) {
        canvas[i] = BACKGROUND[0];
        canvas[i + 1] = BACKGROUND[1];
        canvas[i + 2] = BACKGROUND[2];
        canvas[i + 3] = 255;
    }
}

function worldCorner(s: Surface, lx: number, ly: number): Vec3 {
    const local: Vec3 = [lx * s.halfW, ly * s.halfH, 0];
    return addV(localToWorldDir(local, s.yaw, s.pitch, s.roll), s.position);
}

function surfaceVertexData(s: Surface): number[] {
    const out: number[] = [];
    const normal = localToWorldDir([0, 0, 1], s.yaw, s.pitch, s.roll);
    for (const [lx, ly, u, v] of CORNERS) {
        const [wx, wy, wz] = worldCorner(s, lx, ly);
        out.push(wx, wy, wz, normal[0], normal[1], normal[2], u, v, 1, 1, 1, 1);
    }
    return out;
}

function pushSurfaceTransform(s: Surface): void {
    const positions: number[] = [];
    for (const [lx, ly] of CORNERS) positions.push(...worldCorner(s, lx, ly));
    Entropy.Mesh.updateVertices(s.meshId, [0, 1, 2, 3], positions);
}

// --- Edge/center snapping -----------------------------------------------------------------------

const SNAP_DISTANCE = 0.2; // world units

interface AABB { min: Vec3; max: Vec3; }

function surfaceAABB(s: Surface): AABB {
    const corners = CORNERS.map(([lx, ly]) => worldCorner(s, lx, ly));
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of corners) {
        for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], c[axis]);
            max[axis] = Math.max(max[axis], c[axis]);
        }
    }
    return { min, max };
}

// Snaps `candidate` onto nearby surfaces' edges/centers, one axis at a time. Rotation is held
// fixed during a move, so a surface's AABB translates rigidly with its position - the candidate
// AABB on each axis is just the current AABB shifted by (candidate - s.position) on that axis.
function snapPosition(s: Surface, candidate: Vec3): Vec3 {
    const current = surfaceAABB(s);
    const others = surfaces.filter(o => o !== s).map(surfaceAABB);
    if (others.length === 0) return candidate;

    const snapped: Vec3 = [...candidate];
    for (let axis = 0; axis < 3; axis++) {
        const shift = candidate[axis] - s.position[axis];
        const candMin = current.min[axis] + shift;
        const candMax = current.max[axis] + shift;
        const candCenter = (candMin + candMax) / 2;

        let bestDelta = 0;
        let bestDist = SNAP_DISTANCE;
        for (const o of others) {
            const oMin = o.min[axis], oMax = o.max[axis];
            const oCenter = (oMin + oMax) / 2;
            const candidates = [oMin - candMax, oMax - candMin, oCenter - candCenter];
            for (const delta of candidates) {
                const dist = Math.abs(delta);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestDelta = delta;
                }
            }
        }
        snapped[axis] = candidate[axis] + bestDelta;
    }
    return snapped;
}

function setSurfacePosition(s: Surface, candidate: Vec3, snap: boolean): void {
    s.position = snap ? snapPosition(s, candidate) : candidate;
    pushSurfaceTransform(s);
    if (activeGizmoId && activeSurfaceId === s.id) Entropy.Gizmo.updatePosition(activeGizmoId, s.position);
}

function createSurfaceMesh(s: Surface): void {
    Entropy.Model.createMesh({
        id: s.meshId,
        position: [0, 0, 0], // baked directly into world-space vertices below, not this transform
        vertexData: surfaceVertexData(s),
        indexData: QUAD_INDICES,
        pipelineId,
        bindings: [
            { group: 2, binding: 0, resource: { type: "Texture", value: { id: s.textureId } } },
            { group: 2, binding: 1, resource: { type: "Sampler" } },
        ],
    });
}

let surfaceCount = 0;
let pendingWidth = DEFAULT_HALF_SIZE * 2;
let pendingHeight = DEFAULT_HALF_SIZE * 2;

function spawnSurface(position: Vec3, yaw: number, halfW = DEFAULT_HALF_SIZE, halfH = DEFAULT_HALF_SIZE): Surface {
    surfaceCount++;
    const id = `canvas_surface_${Entropy.generateUUID()}`;
    const canvas = new Uint8Array(CANVAS_RES * CANVAS_RES * 4);
    clearCanvasBuffer(canvas);
    const textureId = Entropy.Texture.create(CANVAS_RES, CANVAS_RES, canvas);

    const s: Surface = {
        id,
        meshId: id,
        textureId,
        name: `Surface ${surfaceCount}`,
        position,
        yaw,
        pitch: 0,
        roll: 0,
        halfW,
        halfH,
        canvas,
        dirty: false,
        visible: true,
    };

    createSurfaceMesh(s);

    surfaces.push(s);
    activeSurfaceId = s.id;
    Entropy.println(`[canvas-surfaces] spawned ${s.name} (${id}) at [${position.map(n => n.toFixed(2))}]`);
    return s;
}

function activeSurface(): Surface | null {
    return surfaces.find(s => s.id === activeSurfaceId) ?? null;
}

// Hiding/showing has no dedicated op - a plain createMesh mesh has no visibility flag - so it
// clears and (on show) recreates the mesh with the surface's current geometry/texture binding.
function setSurfaceVisible(s: Surface, visible: boolean): void {
    if (s.visible === visible) return;
    s.visible = visible;
    if (visible) {
        createSurfaceMesh(s);
    } else {
        Entropy.Model.clearMesh(s.meshId);
        if (activeSurfaceId === s.id && activeGizmoId) {
            Entropy.Gizmo.hide(activeGizmoId);
            activeGizmoId = null;
            lastGizmoSurfaceId = null;
        }
    }
}

function resizeSurface(s: Surface, halfW: number, halfH: number): void {
    s.halfW = Math.max(0.1, halfW);
    s.halfH = Math.max(0.1, halfH);
    pushSurfaceTransform(s);
}

// --- Screen -> surface-local paint coordinate ---------------------------------------------------

interface SurfaceHit {
    surface: Surface;
    px: number; // pixel x within that surface's own canvas
    py: number;
    t: number;
}

// Flat-plane ray intersection, bounded to the surface's own quad extent. Deliberately not a
// general mesh raycast - fine as long as every surface stays flat (Phase 1); a bent surface
// (canvas-surfaces-phase2-bend) will need a real per-triangle test instead.
function raycastSurfaces(screenX: number, screenY: number): SurfaceHit | null {
    const ray = Entropy.Camera.screenToWorldRay(screenX, screenY);
    let best: SurfaceHit | null = null;

    for (const s of surfaces) {
        if (!s.visible) continue;
        const normal = localToWorldDir([0, 0, 1], s.yaw, s.pitch, s.roll);
        const denom = dotV(ray.direction, normal);
        if (Math.abs(denom) < 1e-6) continue;
        const t = dotV(subV(s.position, ray.origin), normal) / denom;
        if (t <= 0) continue;
        if (best && t >= best.t) continue;

        const hitWorld: Vec3 = addV(ray.origin, [ray.direction[0] * t, ray.direction[1] * t, ray.direction[2] * t]);
        const local = worldToLocalDir(subV(hitWorld, s.position), s.yaw, s.pitch, s.roll);
        const u = local[0] / s.halfW; // -1..1
        const v = local[1] / s.halfH;
        if (u < -1 || u > 1 || v < -1 || v > 1) continue;

        const px = ((u + 1) / 2) * CANVAS_RES;
        const py = ((1 - v) / 2) * CANVAS_RES; // local +y is "up", texture v=0 is top (matches CORNERS)
        best = { surface: s, px, py, t };
    }
    return best;
}

// --- Painting (adapted from stylus_drawing_addon.ts's stamp/paintSegment) ----------------------

function stamp(s: Surface, brush: Brush, cx: number, cy: number, radius: number, alpha: number, angle: number, elongation: number): void {
    if (radius <= 0 || alpha <= 0) return;
    const canvas = s.canvas;

    const majorR = radius * (1 + elongation * 0.9);
    const minorR = radius * (1 - elongation * 0.55);
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);

    const extent = Math.ceil(majorR) + 1;
    const minX = Math.max(0, Math.floor(cx - extent));
    const maxX = Math.min(CANVAS_RES - 1, Math.ceil(cx + extent));
    const minY = Math.max(0, Math.floor(cy - extent));
    const maxY = Math.min(CANVAS_RES - 1, Math.ceil(cy + extent));

    const [r, g, b] = brush.color;
    const hardEdge = 1 - brush.softness;

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const dx = x + 0.5 - cx;
            const dy = y + 0.5 - cy;
            const lx = dx * cosA - dy * sinA;
            const ly = dx * sinA + dy * cosA;
            const dist = Math.sqrt((lx / majorR) ** 2 + (ly / minorR) ** 2);
            if (dist > 1) continue;

            const falloff = hardEdge > 0.01
                ? Math.min(1, (1 - dist) / Math.max(0.02, 1 - hardEdge))
                : (1 - dist * dist);
            const a = alpha * Math.max(0, falloff);
            if (a <= 0.002) continue;

            const i = (y * CANVAS_RES + x) * 4;
            canvas[i] = r * a + canvas[i] * (1 - a);
            canvas[i + 1] = g * a + canvas[i + 1] * (1 - a);
            canvas[i + 2] = b * a + canvas[i + 2] * (1 - a);
        }
    }
    s.dirty = true;
}

interface StrokePoint {
    px: number;
    py: number;
    pressure: number;
    tiltX: number;
    tiltY: number;
}

function paintSegment(s: Surface, from: StrokePoint, to: StrokePoint): void {
    const brush = currentBrush();
    const dist = Math.hypot(to.px - from.px, to.py - from.py);
    const approxRadius = brush.baseRadius + brush.radiusGain * Math.max(from.pressure, to.pressure);
    const step = Math.max(0.75, approxRadius * brush.spacingFactor);
    const steps = Math.max(1, Math.ceil(dist / step));

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const px = from.px + (to.px - from.px) * t;
        const py = from.py + (to.py - from.py) * t;
        const pressure = from.pressure + (to.pressure - from.pressure) * t;
        const tiltX = from.tiltX + (to.tiltX - from.tiltX) * t;
        const tiltY = from.tiltY + (to.tiltY - from.tiltY) * t;

        const radius = (brush.baseRadius + brush.radiusGain * pressure) * sizeMultiplier;
        const alpha = Math.min(1, brush.opacityBase + brush.opacityGain * pressure);
        const { angle, magnitude } = tiltVector(tiltX, tiltY);
        stamp(s, brush, px, py, radius, alpha, angle, brush.tiltElongation * magnitude);
    }
}

// --- Modes: Draw (paint on whichever surface the pointer hits) / Move (select + gizmo + rotate
// sliders) - a plain click can't mean both at once. ---------------------------------------------

type Mode = "draw" | "move";
let mode: Mode = "draw";

let drawTarget: Surface | null = null;
let lastStrokePoint: StrokePoint | null = null;
let usingStylus = false;
let usingStylusClearPending = false;
let mouseDrawing = false;

let lastStylusReading = { pressure: 0, tiltX: 0 as number | null, tiltY: 0 as number | null };

function beginStroke(hit: SurfaceHit, pressure: number, tiltX: number, tiltY: number): void {
    drawTarget = hit.surface;
    activeSurfaceId = hit.surface.id;
    lastStrokePoint = { px: hit.px, py: hit.py, pressure, tiltX, tiltY };
    stamp(
        hit.surface, currentBrush(), hit.px, hit.py,
        (currentBrush().baseRadius + currentBrush().radiusGain * pressure) * sizeMultiplier,
        Math.min(1, currentBrush().opacityBase + currentBrush().opacityGain * pressure),
        0, 0
    );
}

function continueStroke(x: number, y: number, pressure: number, tiltX: number, tiltY: number): void {
    if (!drawTarget || !lastStrokePoint) return;
    const ray = Entropy.Camera.screenToWorldRay(x, y);
    const normal = localToWorldDir([0, 0, 1], drawTarget.yaw, drawTarget.pitch, drawTarget.roll);
    const denom = dotV(ray.direction, normal);
    if (Math.abs(denom) < 1e-6) return; // ray parallel to the surface - no new point this sample
    const t = dotV(subV(drawTarget.position, ray.origin), normal) / denom;
    if (t <= 0) return;
    const hitWorld: Vec3 = addV(ray.origin, [ray.direction[0] * t, ray.direction[1] * t, ray.direction[2] * t]);
    const local = worldToLocalDir(subV(hitWorld, drawTarget.position), drawTarget.yaw, drawTarget.pitch, drawTarget.roll);
    const u = local[0] / drawTarget.halfW;
    const v = local[1] / drawTarget.halfH;
    // Off the edge of the surface mid-stroke: skip painting this segment but keep drawTarget/
    // lastStrokePoint alive so re-entering the surface continues the same stroke rather than
    // starting a fresh one.
    if (u < -1 || u > 1 || v < -1 || v > 1) return;
    const point: StrokePoint = { px: ((u + 1) / 2) * CANVAS_RES, py: ((1 - v) / 2) * CANVAS_RES, pressure, tiltX, tiltY };
    paintSegment(drawTarget, lastStrokePoint, point);
    lastStrokePoint = point;
}

Entropy.Input.onStylusDown((e) => {
    usingStylus = true;
    usingStylusClearPending = false;
    lastStylusReading = { pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY };
    if (mode !== "draw" || Entropy.Input.isPointerOverUI()) return;
    const hit = raycastSurfaces(e.x, e.y);
    if (hit) beginStroke(hit, e.pressure, e.tiltX ?? 0, e.tiltY ?? 0);
});

Entropy.Input.onStylusMove((e) => {
    lastStylusReading = { pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY };
    if (mode !== "draw") return;
    continueStroke(e.x, e.y, e.pressure, e.tiltX ?? 0, e.tiltY ?? 0);
});

Entropy.Input.onStylusUp((_e) => {
    drawTarget = null;
    lastStrokePoint = null;
    // See stylus_drawing_addon.ts for why this guard exists: Windows also synthesizes legacy
    // mouse-compatibility events for pen input, which would otherwise double-draw.
    usingStylusClearPending = true;
});

let currentMouseX = 0;
let currentMouseY = 0;

Entropy.Input.onMouseDown((button) => {
    currentMouseX = currentMouseX; // no-op, keeps this handler symmetrical with onMouseMove below
    if (button !== 0 || usingStylus || Entropy.Input.isPointerOverUI()) return;

    if (mode === "draw") {
        mouseDrawing = true;
        const hit = raycastSurfaces(currentMouseX, currentMouseY);
        if (hit) beginStroke(hit, 1.0, 0, 0);
    } else {
        const hit = raycastSurfaces(currentMouseX, currentMouseY);
        if (hit) {
            selectSurface(hit.surface);
            syncGizmoToSelection();
        }
    }
});

Entropy.Input.onMouseMove((x, y) => {
    currentMouseX = x;
    currentMouseY = y;
    if (usingStylus || mode !== "draw" || !mouseDrawing) return;
    continueStroke(x, y, 1.0, 0, 0);
});

Entropy.Input.onMouseUp((button) => {
    if (button !== 0 || usingStylus) return;
    mouseDrawing = false;
    drawTarget = null;
    lastStrokePoint = null;
});

// --- Move mode: translate gizmo (rotation is UI sliders - see the phase-1 card for why: the
// engine only feeds a real transform back to the addon gizmo in translate mode). ----------------

let activeGizmoId: string | null = null;
let lastGizmoSurfaceId: string | null = null;

function syncGizmoToSelection(): void {
    if (activeSurfaceId === lastGizmoSurfaceId) return;
    lastGizmoSurfaceId = activeSurfaceId;

    if (activeGizmoId) {
        Entropy.Gizmo.hide(activeGizmoId);
        activeGizmoId = null;
    }

    const s = activeSurface();
    if (!s || mode !== "move") return;

    activeGizmoId = Entropy.Gizmo.show({
        position: s.position,
        mode: "translate",
        space: "world",
        onTransform: (delta) => {
            setSurfacePosition(s, addV(s.position, delta), true);
        }
    });
}

function setMode(next: Mode): void {
    mode = next;
    if (mode === "draw" && activeGizmoId) {
        Entropy.Gizmo.hide(activeGizmoId);
        activeGizmoId = null;
        lastGizmoSurfaceId = null;
    } else if (mode === "move") {
        lastGizmoSurfaceId = null; // force syncGizmoToSelection to (re)create it next tick
    }
}

function deleteSurface(s: Surface): void {
    if (s.visible) Entropy.Model.clearMesh(s.meshId);
    const idx = surfaces.indexOf(s);
    if (idx >= 0) surfaces.splice(idx, 1);
    if (activeSurfaceId === s.id) {
        if (activeGizmoId) {
            Entropy.Gizmo.hide(activeGizmoId);
            activeGizmoId = null;
        }
        lastGizmoSurfaceId = null;
        activeSurfaceId = surfaces.length > 0 ? surfaces[surfaces.length - 1].id : null;
    }
}

function deleteActiveSurface(): void {
    const s = activeSurface();
    if (s) deleteSurface(s);
}

function selectSurface(s: Surface): void {
    activeSurfaceId = s.id;
    if (mode === "move") lastGizmoSurfaceId = null; // force syncGizmoToSelection to move the gizmo
}

// --- Setup ---------------------------------------------------------------------------------------

const CANVAS_SURFACE_SHADER = `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

@group(2) @binding(0)
var surface_texture: texture_2d<f32>;
@group(2) @binding(1)
var surface_sampler: sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = camera.view_proj * vec4<f32>(in.position, 1.0);
    out.tex_coords = in.tex_coords;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let sampled = textureSample(surface_texture, surface_sampler, in.tex_coords);
    return vec4<f32>(sampled.rgb * in.color.rgb, sampled.a * in.color.a);
}
`;

let uiWindowId: string;
let layersWindowId: string;

function setupUI(): void {
    uiWindowId = Entropy.UI.createWindow({
        title: "Canvas Surfaces",
        width: 300,
        height: 640,
        x: 20,
        y: 20,
        onRender: renderUI
    });
    layersWindowId = Entropy.UI.createWindow({
        title: "Surfaces",
        width: 260,
        height: 400,
        x: 340,
        y: 20,
        onRender: renderLayersUI
    });
}

function renderLayersUI(): void {
    Entropy.UI.Widget.label(layersWindowId, { text: "Surfaces", bold: true });
    Entropy.UI.Widget.separator(layersWindowId);

    if (surfaces.length === 0) {
        Entropy.UI.Widget.label(layersWindowId, { text: "None yet - add one." });
        return;
    }

    for (const s of surfaces) {
        const isActive = s.id === activeSurfaceId;
        Entropy.UI.Widget.button(layersWindowId, {
            text: (isActive ? "> " : "  ") + s.name + (s.visible ? "" : " (hidden)"),
            id: `layer_select_${s.id}`,
            onClick: () => selectSurface(s)
        });
        Entropy.UI.Widget.button(layersWindowId, {
            text: s.visible ? "  Hide" : "  Show",
            id: `layer_toggle_${s.id}`,
            onClick: () => setSurfaceVisible(s, !s.visible)
        });
        Entropy.UI.Widget.button(layersWindowId, {
            text: "  Delete",
            id: `layer_delete_${s.id}`,
            onClick: () => deleteSurface(s)
        });
        Entropy.UI.Widget.separator(layersWindowId);
    }
}

function renderUI(): void {
    Entropy.UI.Widget.label(uiWindowId, { text: "Canvas Surfaces", bold: true });
    Entropy.UI.Widget.label(uiWindowId, { text: "Right-drag to orbit the camera" });
    Entropy.UI.Widget.separator(uiWindowId);

    Entropy.UI.Widget.button(uiWindowId, {
        text: (mode === "draw" ? "> " : "  ") + "Draw",
        id: "mode_draw",
        onClick: () => setMode("draw")
    });
    Entropy.UI.Widget.button(uiWindowId, {
        text: (mode === "move" ? "> " : "  ") + "Move / Select",
        id: "mode_move",
        onClick: () => setMode("move")
    });
    Entropy.UI.Widget.separator(uiWindowId);

    Entropy.UI.Widget.slider(uiWindowId, {
        label: "New Width", value: pendingWidth, min: 0.5, max: 8, id: "pending_w_slider",
        onChange: (v: string) => { pendingWidth = parseFloat(v); }
    });
    Entropy.UI.Widget.slider(uiWindowId, {
        label: "New Height", value: pendingHeight, min: 0.5, max: 8, id: "pending_h_slider",
        onChange: (v: string) => { pendingHeight = parseFloat(v); }
    });
    Entropy.UI.Widget.button(uiWindowId, {
        text: "+ New Surface",
        id: "new_surface",
        onClick: () => {
            const n = surfaces.length;
            spawnSurface([(n % 3) * 3.5 - 3.5, 1.5, -Math.floor(n / 3) * 3.0], 0, pendingWidth / 2, pendingHeight / 2);
        }
    });

    if (mode === "draw") {
        Entropy.UI.Widget.label(uiWindowId, { text: `Brush: ${currentBrush().name}` });
        for (let i = 0; i < BRUSHES.length; i++) {
            Entropy.UI.Widget.button(uiWindowId, {
                text: (i === brushIndex ? "> " : "  ") + BRUSHES[i].name,
                id: `brush_btn_${i}`,
                onClick: () => { brushIndex = i; }
            });
        }
        Entropy.UI.Widget.slider(uiWindowId, {
            label: "Size", value: sizeMultiplier, min: 0.3, max: 3.0, id: "size_slider",
            onChange: (v: string) => { sizeMultiplier = parseFloat(v); }
        });
        Entropy.UI.Widget.label(uiWindowId, { text: `pressure: ${lastStylusReading.pressure.toFixed(2)}` });
    } else {
        const s = activeSurface();
        if (!s) {
            Entropy.UI.Widget.label(uiWindowId, { text: "No surface selected - click one." });
        } else {
            Entropy.UI.Widget.label(uiWindowId, { text: `Selected: ${s.name}` });
            Entropy.UI.Widget.label(uiWindowId, {
                text: `pos: ${s.position.map(n => n.toFixed(2)).join(", ")}`
            });
            Entropy.UI.Widget.slider(uiWindowId, {
                label: "X", value: s.position[0], min: -8, max: 8, id: "pos_x_slider",
                onChange: (v: string) => {
                    const p: Vec3 = [parseFloat(v), s.position[1], s.position[2]];
                    setSurfacePosition(s, p, true);
                }
            });
            Entropy.UI.Widget.slider(uiWindowId, {
                label: "Y", value: s.position[1], min: 0, max: 6, id: "pos_y_slider",
                onChange: (v: string) => {
                    const p: Vec3 = [s.position[0], parseFloat(v), s.position[2]];
                    setSurfacePosition(s, p, true);
                }
            });
            Entropy.UI.Widget.slider(uiWindowId, {
                label: "Z", value: s.position[2], min: -8, max: 8, id: "pos_z_slider",
                onChange: (v: string) => {
                    const p: Vec3 = [s.position[0], s.position[1], parseFloat(v)];
                    setSurfacePosition(s, p, true);
                }
            });
            Entropy.UI.Widget.slider(uiWindowId, {
                label: "Yaw", value: s.yaw, min: -Math.PI, max: Math.PI, id: "yaw_slider",
                onChange: (v: string) => { s.yaw = parseFloat(v); pushSurfaceTransform(s); }
            });
            Entropy.UI.Widget.slider(uiWindowId, {
                label: "Pitch", value: s.pitch, min: -Math.PI / 2, max: Math.PI / 2, id: "pitch_slider",
                onChange: (v: string) => { s.pitch = parseFloat(v); pushSurfaceTransform(s); }
            });
            Entropy.UI.Widget.slider(uiWindowId, {
                label: "Roll", value: s.roll, min: -Math.PI, max: Math.PI, id: "roll_slider",
                onChange: (v: string) => { s.roll = parseFloat(v); pushSurfaceTransform(s); }
            });
            Entropy.UI.Widget.slider(uiWindowId, {
                // Width/height edit the surface's geometry only - the texture keeps its 0..1 UV
                // mapping and just stretches to fit, so a drastic aspect-ratio change will distort
                // whatever's already drawn. Acceptable for now, not attempted to fix.
                label: "Width", value: s.halfW * 2, min: 0.5, max: 8, id: "resize_w_slider",
                onChange: (v: string) => resizeSurface(s, parseFloat(v) / 2, s.halfH)
            });
            Entropy.UI.Widget.slider(uiWindowId, {
                label: "Height", value: s.halfH * 2, min: 0.5, max: 8, id: "resize_h_slider",
                onChange: (v: string) => resizeSurface(s, s.halfW, parseFloat(v) / 2)
            });
            Entropy.UI.Widget.button(uiWindowId, {
                text: s.visible ? "Hide Surface" : "Show Surface", id: "toggle_visible",
                onClick: () => setSurfaceVisible(s, !s.visible)
            });
            Entropy.UI.Widget.button(uiWindowId, {
                text: "Delete Surface", id: "delete_surface",
                onClick: () => deleteActiveSurface()
            });
        }
    }

    Entropy.UI.Widget.separator(uiWindowId);
    Entropy.UI.Widget.label(uiWindowId, { text: `${surfaces.length} surface(s)` });
}

addon.onInit(() => {
    pipelineId = Entropy.Pipeline.create({
        name: "CanvasSurface",
        layout: "mesh",
        pbr: false,
        vertexShader: CANVAS_SURFACE_SHADER,
        fragmentShader: CANVAS_SURFACE_SHADER,
        extraBindGroups: [
            {
                entries: [
                    { binding: 0, visibility: ["Fragment"], resourceType: "Texture" },
                    { binding: 1, visibility: ["Fragment"], resourceType: "Sampler" },
                ]
            }
        ]
    });

    // Default engine game_mode is `true` (src/app.rs) - the gizmo render pass is gated on
    // `!game_mode` (src/core/render_addon_frame.rs) and game_composer_addon.ts only ever shows a
    // gizmo after its own `Entropy.setGameMode(false)`. This is a creation tool, not a "game" -
    // it should stay in edit mode (gizmo visible/interactive) for its whole lifetime.
    Entropy.setGameMode(false);

    Entropy.Camera.setTransform([0, 1.6, 6], [0, 1.2, 0]);
    // trigger:"always" + button:1 (right mouse button) instead of the default shift+left-drag -
    // easier to hold with a stylus in the drawing hand, and leaves plain left-drag free for
    // drawing/gizmo use without a modifier key.
    Entropy.Controls.enable("orbit", { target: [0, 1.2, 0], trigger: "always", button: 1 });

    spawnSurface([0, 1.5, 0], 0);

    setupUI();
    Entropy.println("[canvas-surfaces] initialized");
});

addon.onUpdatePlus("Global", (_time: number) => {
    if (usingStylusClearPending) {
        usingStylusClearPending = false;
        usingStylus = false;
    }
    if (mode === "move") syncGizmoToSelection();
    for (const s of surfaces) {
        if (s.dirty) {
            Entropy.Texture.update(s.textureId, s.canvas);
            s.dirty = false;
        }
    }
});
