// Hand-drawn 3D level building: anchored, movable canvas surfaces an artist draws on directly
// with a tablet, as an in-engine alternative to sculpting or round-tripping through a separate
// DCC tool. This is Phase 1 of the epic (see the canvas-surfaces-phase1 card in
// cc-manager/tasks.json for the full architecture note) - it covers create/position a surface,
// pressure/tilt stylus drawing on it, detach/relocate, "it's already the real level" (no export
// step), and viewing from a free camera. Groups, pivots and named animation clips now live
// in the addon too; canvas_animation.ts contains the hierarchy and sampling math.
//
// Each surface is a subdivided grid mesh (GRID_SEGMENTS x GRID_SEGMENTS quads, phase 1 was a
// single flat 4-vert quad, the same shape game2d's Sprite uses) - generalized from a 2D
// x/y/rotation to a real 3D position + yaw/pitch/roll, created once via Entropy.Model.createMesh
// and then only ever moved by recomputing every grid vertex's world-space position and pushing
// them with Entropy.Mesh.updateVertices. That's not a simplification for this demo: per
// sprite.ts's own doc comment, a plain createMesh mesh has no updatable transform of its own,
// only vertex positions, so this is the only way to move (or bend) it at all.
//
// Phase 2: a per-surface `bend` amount cylindrically curves the grid around a local axis
// (bendLocalPoint below) before the existing rotate+translate-to-world step - a real subdivided
// grid is what makes that possible, a single quad has no interior vertices to bend. Because
// strokes are painted into a UV-mapped texture (not vector strokes with world positions), bending
// only ever touches vertex positions - the texture and its UVs stay exactly as authored, so
// existing strokes wrap with the surface for free. Painting/selection now raycasts the actual
// grid triangles (raycastSurfaceMesh, Möller-Trumbore) instead of phase 1's flat-plane shortcut,
// so drawing accuracy holds on bent surfaces too, not just flat ones.
//
// Phase 4: a Cut tool/mode - draw a closed shape on a surface (same raycast path as painting) and
// it auto-cuts a real hole through the surface once the shape loops back on itself (or on
// pointer-up, as a fallback). Implemented purely as an alpha-channel operation on the surface's
// existing canvas (floodFillCutAlpha zeroes alpha inside the shape) plus one `discard` in
// CANVAS_SURFACE_SHADER's fragment stage for any pixel below that alpha threshold - no engine
// change, no new geometry, no new persisted field (saveScene/loadScene already round-trip the
// whole RGBA canvas). raycastSurfaceMesh also treats a cut pixel as a miss, so painting/selection
// rays pass through a hole instead of catching on it. See the "Cut tool" section below for the
// full design note, including the deliberate box/cylinder/sphere backface-culling side effect.
//
// Phase 3: surfaces are no longer only flat/bent planes - a surface's `kind` can also be "box",
// "cylinder", or "sphere". All four kinds share one mesh-building/raycasting path via a generic
// `Patch` abstraction (see "Surface geometry" below): a patch is just a row/col grid of local-space
// points plus a matching UV grid, and a shape is one or more patches (a plane/sphere is one patch,
// a box is 6 face patches, a cylinder is a side patch + two cap patches). Every patch's triangle
// winding is derived once, automatically, from its own declared outward-normal direction rather
// than hand-derived per shape - see `patchWinding`'s doc comment for why that's safe. Every
// patch's UV lives in its own sub-rectangle of the surface's one shared texture (an atlas) rather
// than each shape needing its own texture, so all the existing per-surface machinery (one canvas
// buffer, one textureId, one dirty flag) is completely unchanged.
//
// Each surface owns a private CPU-painted RGBA texture (Entropy.Texture.create/update), sampled
// by a small unlit custom pipeline - same "dynamic texture on a textured quad" shape as
// media_player_addon.ts's video quad and game2d's sprite pipeline. The brush/stamp/paintSegment
// pixel-painting code below is stylus_drawing_addon.ts's, generalized to paint into whichever
// surface's own canvas buffer a stroke lands on instead of one global canvas.
//
// Turning a screen-space pointer position into a surface-local paint coordinate is a hand-rolled
// ray-triangle intersection over the surface's own world-space grid (Möller-Trumbore, see
// raycastSurfaceMesh) - phase 1 used a flat-plane shortcut here (fine when every surface was a
// single quad), but a bent surface has no single plane to intersect, so phase 2 replaced it with
// a real per-triangle test against the cached world-space grid vertices. This is deliberate, not
// a missing feature: addon.d.ts declares Entropy.Selection.raycast(screenX, screenY), but its
// Rust side (op_selection_raycast) doesn't exist yet - src/deno/addon_setup.js's own
// implementation is a stub that always returns null (confirmed by reading it), so relying on it
// here would silently never work.
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
// position sliders: setSurfacePosition() compares the moving surface's world-space AABB (scanned
// from all its cached patch vertices - see surfaceAABB) against every other surface's AABB, per
// axis independently, and pulls the candidate position onto the nearest edge/center alignment
// within SNAP_DISTANCE. This is an AABB snap, not a true rotated-edge snap - exact for axis-aligned
// shapes (the common case: tiling flat panels
// into a wall or floor), approximate for tilted ones.

import { identity, defaultTransform, multiply, inverse, point, normal as transformNormal, transformMatrix, animatedTransform, groupWorld, reparentFrame, sample, setKey } from "./canvas_animation";
import type { Group, Clip, Channel, Matrix, Transform, RetainedStroke } from "./canvas_animation";
import { CanvasHistory } from "./canvas_history";
import { emptyLogic, logicNode, logicProblems, validateLogic, LogicSession, LOGIC_KINDS } from "./canvas_logic";
import type { LogicGraph, LogicNode } from "./canvas_logic";
import { appendRule } from "./canvas_logic_rules";
import type { Rule } from "./canvas_logic_rules";
import { LIGHTING_PRESETS, LIGHTING_PRESET_NAMES, defaultLighting, cloneLighting, mergeLighting, packLighting, LIGHTING_FLOATS } from "./canvas_lighting";
import type { LightingSettings } from "./canvas_lighting";
import { PREFABS, PREFAB_IDS, buildPrefab, parseColor } from "./canvas_prefabs";
import { stepPlayer, cameraRelative, followCamera, distanceToRect, unionRect } from "./canvas_walk";
import type { Rect, XZ } from "./canvas_walk";
import { CANVAS_TOOLS, CANVAS_TOOL_NAMES } from "./canvas_tool_schemas";
import type { CanvasToolName } from "./canvas_tool_schemas";
import { renderLogicEditor } from "./canvas_logic_editor";
import { DEFAULT_PAINT_SETTINGS, blendPixel, compositePixel, compositeLayers, pressureResponse, stabilizePoint } from "./canvas_paint";
import type { PaintLayer, PaintSettings, RGB } from "./canvas_paint";
import { SceneLibrary } from "./canvas_scene_library";
import { bytesToBase64, base64ToBytes, validateScene, uniformFill, fillBytes } from "./canvas_scene_format";
import type { SavedScene, SavedSurface } from "./canvas_scene_format";

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
const DEFAULT_HALF_SIZE = 1.5; // world units - a 3x3 unit plane/box by default
const DEFAULT_HALF_DEPTH = 0.75; // box depth default
const DEFAULT_RADIUS = 1.0; // cylinder/sphere default

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
let sizeMultiplier = 0.25; // default ink brush size, per explicit ask - was 1.0
let paintSettings: PaintSettings = { ...DEFAULT_PAINT_SETTINGS, color: [...DEFAULT_PAINT_SETTINGS.color] };
let recentColors: RGB[] = [];
let savedSwatches: RGB[] = [[18, 20, 32], [224, 88, 44], [52, 105, 148], [90, 120, 65]];
let preferencesDirty = false;
let statusMessage = "";
let pickingColor = false;
let textInputActive = false;
function currentBrush(): Brush {
    return { ...BRUSHES[brushIndex], color: paintSettings.color };
}
function brushRadius(brush: Brush, pressure: number): number {
    return (brush.baseRadius + brush.radiusGain * pressureResponse(pressure, paintSettings, "size")) * sizeMultiplier;
}
function brushAlpha(brush: Brush, pressure: number): number {
    return Math.min(1, brush.opacityBase + brush.opacityGain * pressureResponse(pressure, paintSettings, "opacity")) * paintSettings.opacity;
}
function rememberColor(): void {
    const color = [...paintSettings.color] as RGB;
    recentColors = [color, ...recentColors.filter(c => c.some((n, i) => n !== color[i]))].slice(0, 6);
    preferencesDirty = true;
}
function chooseColor(color: RGB): void {
    paintSettings.color = [...color];
    rememberColor();
}
function sampleColor(x: number, y: number): void {
    const hit = raycastSurfaces(x, y);
    if (!hit) return;
    const px = Math.max(0, Math.min(CANVAS_RES - 1, Math.floor(hit.px)));
    const py = Math.max(0, Math.min(CANVAS_RES - 1, Math.floor(hit.py)));
    const i = (py * CANVAS_RES + px) * 4;
    chooseColor([hit.surface.canvas[i], hit.surface.canvas[i + 1], hit.surface.canvas[i + 2]]);
    pickingColor = false;
    statusMessage = "Color sampled";
}

function tiltVector(tiltX: number, tiltY: number): { angle: number; magnitude: number } {
    const angle = Math.atan2(tiltY, tiltX);
    const magnitude = Math.min(1, Math.hypot(tiltX, tiltY) / 60);
    return { angle, magnitude };
}

// --- Rotation helpers ---------------------------------------------------------------------------
//
// A surface's orientation is yaw (Y axis) / pitch (X axis) / roll (Z axis), composed as
// world = Ry(yaw) * Rx(pitch) * Rz(roll) * local.
type Vec3 = [number, number, number];

function addV(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subV(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dotV(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function crossV(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Quaternion form of the same yaw/pitch/roll convention above (world = Ry(yaw)*Rx(pitch)*Rz(roll)) -
// used only to seed/read Entropy.Gizmo's rotate handles (see syncGizmoToSelection).
// Rigid transforms use the same Y-X-Z order; this is a bridge to
// the gizmo's quaternion-based interface. [x, y, z, w] throughout, matching mint::Quaternion's
// own `From<[T; 4]>` order (confirmed by reading the mint crate's source) and glTF's convention.
type Quat = [number, number, number, number];

function axisAngleQuat(axis: Vec3, angle: number): Quat {
    const half = angle / 2, s = Math.sin(half);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

// Hamilton product - q = a then b applied on top corresponds to matrix M(a)*M(b), the same
// composition order as transformMatrix in canvas_animation.ts.
function quatMul(a: Quat, b: Quat): Quat {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}

function eulerToQuat(yaw: number, pitch: number, roll: number): Quat {
    return quatMul(quatMul(axisAngleQuat([0, 1, 0], yaw), axisAngleQuat([1, 0, 0], pitch)), axisAngleQuat([0, 0, 1], roll));
}

// Inverse of eulerToQuat - extracts yaw/pitch/roll back out of an arbitrary quaternion (as
// returned by a gizmo rotate-handle drag) under the same Ry*Rx*Rz convention. Standard "YXZ"
// Euler extraction via an intermediate rotation matrix (the quaternion->matrix formula and this
// extraction are the well-known standard pairing - not re-derived here). Falls back to roll=0
// at the pitch=+-90deg gimbal-lock singularity, same as any other YXZ extractor.
function quatToEuler(q: Quat): { yaw: number; pitch: number; roll: number } {
    const [x, y, z, w] = q;
    const r02 = 2 * (x * z + y * w);
    const r12 = 2 * (y * z - x * w);
    const r22 = 1 - 2 * (x * x + y * y);
    const r10 = 2 * (x * y + z * w);
    const r11 = 1 - 2 * (x * x + z * z);
    const r20 = 2 * (x * z - y * w);
    const r00 = 1 - 2 * (y * y + z * z);

    const pitch = Math.asin(Math.max(-1, Math.min(1, -r12)));
    if (Math.abs(r12) > 0.9999) {
        return { yaw: Math.atan2(-r20, r00), pitch, roll: 0 };
    }
    return { yaw: Math.atan2(r02, r22), pitch, roll: Math.atan2(r10, r11) };
}

// --- Surface geometry: shapes as one or more patches -------------------------------------------
//
// A Patch is a row/col grid of LOCAL-space points (pre rotate/translate) plus a matching grid of
// atlas UVs - the same shape phase 2's plane grid already was, just abstracted so box/cylinder/
// sphere can reuse every bit of mesh-building, raycasting, and AABB code below without a shape
// switch anywhere except "which patches does this kind produce."
interface Patch {
    rows: number;
    cols: number;
    localPoint(row: number, col: number): Vec3;
    // Approximate outward normal at (row, col) - only ever evaluated at one representative
    // interior cell (see patchWinding), so it doesn't need to be exact everywhere, just correct
    // at whatever cell gets tested.
    outwardAt(row: number, col: number): Vec3;
    uvAt(row: number, col: number): { u: number; v: number };
}

// Grid resolution for plane/box-face patches - fixed rather than size-dependent, since bend needs
// interior vertices regardless of how big or small a surface is. 16x16 quads (289 vertices) is
// enough to read as a smooth curve/corner at this demo's typical surface sizes and cheap enough to
// raycast against per stroke sample (see raycastSurfaceMesh's doc comment).
const GRID_SEGMENTS = 16;

// Texture UV per grid cell is a fixed 0..1 ratio of grid position, independent of a surface's
// size/bend - precomputed once and reused by every plane and every box face (each box face maps
// this same 0..1 square into its own atlas cell, see boxPatches). u=0/v=0 is top-left.
const GRID_UV: Array<Array<{ u: number; v: number }>> = (() => {
    const rows: Array<Array<{ u: number; v: number }>> = [];
    for (let j = 0; j <= GRID_SEGMENTS; j++) {
        const row: Array<{ u: number; v: number }> = [];
        for (let i = 0; i <= GRID_SEGMENTS; i++) row.push({ u: i / GRID_SEGMENTS, v: j / GRID_SEGMENTS });
        rows.push(row);
    }
    return rows;
})();

type BendAxis = "x" | "y";
type ShapeKind = "plane" | "box" | "cylinder" | "sphere";
const SHAPE_KINDS: ShapeKind[] = ["plane", "box", "cylinder", "sphere"];

// Full sweep angle at bend = 1 (or -1, opposite direction) - a half-circle. Cylindrically bends
// the flat grid around a local axis: axis "y" curls across local X into local Z (cylinder axis
// vertical, like a scroll curling left-right); axis "x" curls across local Y into local Z
// (cylinder axis horizontal, like a page curling top-to-bottom). At bend=0 this is a no-op flat
// plane (early-out below avoids a divide-by-a-tiny-halfAngle for values very close to zero). Only
// ever applied to "plane" surfaces - bending a box/cylinder/sphere isn't a supported operation.
const MAX_BEND_ANGLE = Math.PI;

function bendLocalPoint(lx: number, ly: number, halfW: number, halfH: number, bend: number, axis: BendAxis): Vec3 {
    if (Math.abs(bend) < 1e-4) return [lx, ly, 0];
    const halfAngle = (bend * MAX_BEND_ANGLE) / 2;
    if (axis === "y") {
        const r = halfW / halfAngle;
        const theta = (lx / halfW) * halfAngle;
        return [r * Math.sin(theta), ly, r * (1 - Math.cos(theta))];
    } else {
        const r = halfH / halfAngle;
        const theta = (ly / halfH) * halfAngle;
        return [lx, r * Math.sin(theta), r * (1 - Math.cos(theta))];
    }
}

function planePatch(s: Surface): Patch {
    const N = GRID_SEGMENTS;
    return {
        rows: N + 1, cols: N + 1,
        localPoint: (row, col) => {
            const ly = s.halfH - (2 * s.halfH * row) / N;
            const lx = -s.halfW + (2 * s.halfW * col) / N;
            return bendLocalPoint(lx, ly, s.halfW, s.halfH, s.bend, s.bendAxis);
        },
        outwardAt: () => [0, 0, 1],
        uvAt: (row, col) => GRID_UV[row][col],
    };
}

// Box: 6 face patches, one per axis-aligned direction, packed into a 3x2 grid of the surface's
// one shared texture (front/back/right in the top row, left/top/bottom in the bottom row) so a
// box only ever needs the same one canvas/textureId every other shape uses. Each face reuses
// GRID_UV for its own local 0..1 parametrization, just remapped into its atlas cell.
const BOX_ATLAS_COLS = 3, BOX_ATLAS_ROWS = 2;

function boxPatches(s: Surface): Patch[] {
    const N = GRID_SEGMENTS;
    const hw = s.halfW, hh = s.halfH, hd = s.halfD;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const cellW = 1 / BOX_ATLAS_COLS, cellH = 1 / BOX_ATLAS_ROWS;

    const faces: Array<{ outward: Vec3; cellCol: number; cellRow: number; point(row: number, col: number): Vec3 }> = [
        { outward: [0, 0, 1], cellCol: 0, cellRow: 0, point: (row, col) => [lerp(-hw, hw, col / N), lerp(hh, -hh, row / N), hd] },   // front (+Z)
        { outward: [0, 0, -1], cellCol: 1, cellRow: 0, point: (row, col) => [lerp(hw, -hw, col / N), lerp(hh, -hh, row / N), -hd] }, // back (-Z)
        { outward: [1, 0, 0], cellCol: 2, cellRow: 0, point: (row, col) => [hw, lerp(hh, -hh, row / N), lerp(-hd, hd, col / N)] },   // right (+X)
        { outward: [-1, 0, 0], cellCol: 0, cellRow: 1, point: (row, col) => [-hw, lerp(hh, -hh, row / N), lerp(hd, -hd, col / N)] }, // left (-X)
        { outward: [0, 1, 0], cellCol: 1, cellRow: 1, point: (row, col) => [lerp(-hw, hw, col / N), hh, lerp(-hd, hd, row / N)] },   // top (+Y)
        { outward: [0, -1, 0], cellCol: 2, cellRow: 1, point: (row, col) => [lerp(-hw, hw, col / N), -hh, lerp(hd, -hd, row / N)] }, // bottom (-Y)
    ];

    return faces.map(face => ({
        rows: N + 1, cols: N + 1,
        localPoint: face.point,
        outwardAt: () => face.outward,
        uvAt: (row, col) => ({ u: face.cellCol * cellW + (col / N) * cellW, v: face.cellRow * cellH + (row / N) * cellH }),
    }));
}

// Cylinder: a side patch (circumference x height, radius = s.radius, height = 2*s.halfH) plus two
// disc caps. The seam where angle wraps from 2*PI back to 0 is a duplicated column of vertices at
// the same position with different U (0 vs 1), not a modular-index special case - the standard
// mesh-generation trick that lets every patch here stay a plain non-wrapping row/col grid. Each
// cap is a polar grid (row = radial ring, 0 = center point .. edge; col = angle, same duplicated
// seam) - the collapsed center ring produces some zero-area triangles, which is fine, they simply
// never register a raycast hit (rayTriangleIntersect's parallel/degenerate check rejects them).
const CYL_RADIAL_SEGMENTS = 24;
const CYL_HEIGHT_SEGMENTS = 8;
const CYL_CAP_RINGS = 6;
const CYL_SIDE_V_FRACTION = 0.66; // atlas: side occupies the top 66% of the texture (v), caps share the bottom third
const CYL_CAP_UV_RADIUS = 0.15;

function cylinderPatches(s: Surface): Patch[] {
    const R = CYL_RADIAL_SEGMENTS, H = CYL_HEIGHT_SEGMENTS, C = CYL_CAP_RINGS;
    const radius = s.radius, hh = s.halfH;

    const side: Patch = {
        rows: H + 1, cols: R + 1,
        localPoint: (row, col) => {
            const y = hh - (2 * hh * row) / H;
            const angle = (col / R) * Math.PI * 2;
            return [radius * Math.cos(angle), y, radius * Math.sin(angle)];
        },
        outwardAt: (_row, col) => {
            const angle = (col / R) * Math.PI * 2;
            return [Math.cos(angle), 0, Math.sin(angle)];
        },
        uvAt: (row, col) => ({ u: col / R, v: (row / H) * CYL_SIDE_V_FRACTION }),
    };

    const cap = (y: number, outward: Vec3, cu: number, cv: number): Patch => ({
        rows: C + 1, cols: R + 1,
        localPoint: (row, col) => {
            const rt = row / C;
            const angle = (col / R) * Math.PI * 2;
            return [rt * radius * Math.cos(angle), y, rt * radius * Math.sin(angle)];
        },
        outwardAt: () => outward,
        uvAt: (row, col) => {
            const rt = row / C, angle = (col / R) * Math.PI * 2;
            return { u: cu + rt * CYL_CAP_UV_RADIUS * Math.cos(angle), v: cv + rt * CYL_CAP_UV_RADIUS * Math.sin(angle) };
        },
    });

    const capV = CYL_SIDE_V_FRACTION + (1 - CYL_SIDE_V_FRACTION) / 2;
    return [side, cap(hh, [0, 1, 0], 0.25, capV), cap(-hh, [0, -1, 0], 0.75, capV)];
}

// Sphere: one lat/long patch, standard equirectangular UV over the whole texture (no atlas packing
// needed - the only shape here with just one patch). Same duplicated-seam trick handles the
// longitude wrap; the collapsed north/south pole rows are the same acceptable degenerate-triangle
// case as the cylinder's caps.
const SPHERE_LAT_SEGMENTS = 16;
const SPHERE_LON_SEGMENTS = 24;

function spherePatch(s: Surface): Patch {
    const LAT = SPHERE_LAT_SEGMENTS, LON = SPHERE_LON_SEGMENTS, radius = s.radius;
    return {
        rows: LAT + 1, cols: LON + 1,
        localPoint: (row, col) => {
            const phi = (row / LAT) * Math.PI; // 0 at north pole .. PI at south pole
            const theta = (col / LON) * Math.PI * 2;
            const y = radius * Math.cos(phi);
            const r = radius * Math.sin(phi);
            return [r * Math.cos(theta), y, r * Math.sin(theta)];
        },
        outwardAt: (row, col) => {
            const phi = (row / LAT) * Math.PI, theta = (col / LON) * Math.PI * 2;
            return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
        },
        uvAt: (row, col) => ({ u: col / LON, v: row / LAT }),
    };
}

function shapePatches(s: Surface): Patch[] {
    switch (s.kind) {
        case "plane": return [planePatch(s)];
        case "box": return boxPatches(s);
        case "cylinder": return cylinderPatches(s);
        case "sphere": return [spherePatch(s)];
    }
}

// Which diagonal to use for a patch's two triangles, derived once from the patch's own geometry
// rather than hand-derived per shape (which is exactly the kind of by-hand cross-product algebra
// that produced a real, if ultimately harmless, sign mistake worth not repeating six more times -
// see the ground-grid winding comment above buildGroundGridMesh). Tested at one representative
// interior cell (never row/col 0, which is degenerate for a sphere pole or a cylinder cap's
// center) and reused for every cell: valid because every patch here has a globally consistent
// row/col orientation (no Möbius-style twist), and because rotation and this addon's bend are both
// orientation-preserving, so a winding computed in local, undeformed space stays correct once the
// surface is rotated or (for a plane) bent - confirmed by this exact reasoning already holding up
// for the plane case through phase 1 and phase 2's screenshots.
function patchWinding(patch: Patch): [number, number, number, number, number, number] {
    const row = Math.min(1, patch.rows - 2);
    const col = Math.min(1, patch.cols - 2);
    const p00 = patch.localPoint(row, col);         // TL (corner slot 0)
    const p01 = patch.localPoint(row, col + 1);     // TR (corner slot 1)
    const p11 = patch.localPoint(row + 1, col + 1); // BR (corner slot 3) - BL (slot 2) isn't needed for this test
    const outward = patch.outwardAt(row, col);
    const nCandidate = crossV(subV(p11, p00), subV(p01, p00)); // normal if triangle order is (TL,BR,TR)
    return dotV(nCandidate, outward) >= 0
        ? [0, 3, 1, 0, 2, 3]  // (TL,BR,TR), (TL,BL,BR)
        : [0, 1, 3, 0, 3, 2]; // reversed
}

interface WorldPatch {
    rows: number;
    cols: number;
    verts: Vec3[][];
    uv: Array<Array<{ u: number; v: number }>>;
    winding: [number, number, number, number, number, number];
    // Per-vertex world-space normal, from the patch's own outwardAt(row,col) - a plane/box face
    // has one normal everywhere so this is uniform for those, but a cylinder/sphere's outwardAt
    // already varies smoothly per cell (see cylinderPatches/spherePatch), so using it per-vertex
    // here (rather than one representative value for the whole patch) is what makes point-light
    // shading (see setupUI's lighting section / CANVAS_SURFACE_SHADER) read as a smooth curved
    // surface instead of one flat-shaded facet.
    normals: Vec3[][];
}

function buildSurfaceWorldPatches(s: Surface): WorldPatch[] {
    const matrix = surfaceMatrix(s), inverted = inverse(matrix);
    return shapePatches(s).map(patch => {
        const verts: Vec3[][] = [];
        const uv: Array<Array<{ u: number; v: number }>> = [];
        const normals: Vec3[][] = [];
        for (let row = 0; row < patch.rows; row++) {
            const vRow: Vec3[] = [];
            const uvRow: Array<{ u: number; v: number }> = [];
            const nRow: Vec3[] = [];
            for (let col = 0; col < patch.cols; col++) {
                vRow.push(point(matrix, patch.localPoint(row, col)));
                uvRow.push(patch.uvAt(row, col));
                nRow.push(transformNormal(matrix, patch.outwardAt(row, col), inverted));
            }
            verts.push(vRow);
            uv.push(uvRow);
            normals.push(nRow);
        }
        return { rows: patch.rows, cols: patch.cols, verts, uv, winding: patchWinding(patch), normals };
    });
}

interface Surface {
    id: string;
    meshId: string;
    textureId: string;
    previewBufferId: string;
    name: string;
    kind: ShapeKind;
    parentId: string | null; frame: Matrix; scale: Vec3; pivot: Vec3;
    strokes: RetainedStroke[]; bases: Record<string, Uint8Array>;
    position: Vec3;
    yaw: number;
    pitch: number;
    roll: number;
    halfW: number; // plane/box width
    halfH: number; // plane/box height, cylinder half-height
    halfD: number; // box depth only
    radius: number; // cylinder/sphere only
    bend: number; // -1..1, plane only
    bendAxis: BendAxis; // plane only
    canvas: Uint8Array; // derived composite, never stored in history
    layers: PaintLayer[];
    activeLayerId: string;
    cutMask: Uint8Array;
    dirty: boolean;
    visible: boolean;
    /** Blocks the player while playing. */
    solid: boolean;
    // Cached world-space patches - rebuilt by pushSurfaceTransform/createSurfaceMesh on every
    // geometry change (move/rotate/bend/resize) and used by raycastSurfaceMesh so drawing/
    // selection never has to recompute geometry mid-raycast.
    worldPatches: WorldPatch[];
}

const surfaces: Surface[] = [];
let activeSurfaceId: string | null = null;
let pipelineId: string;
let groups: Group[] = [];
let clips: Clip[] = [];
let logic: LogicGraph = emptyLogic();
/** Play-mode settings saved with the scene. `player` is the id of a root group (or a surface) the keyboard moves. */
interface WorldState { player: string | null; bounds: number; lighting: LightingSettings; }
const DEFAULT_BOUNDS = 40;
let world: WorldState = { player: null, bounds: DEFAULT_BOUNDS, lighting: defaultLighting() };
let lightingBufferId = "";
function resetWorld(): void { world = { player: null, bounds: DEFAULT_BOUNDS, lighting: defaultLighting() }; applyLighting(); }
function applyLighting(): void {
    const l = world.lighting;
    if (lightingBufferId) Entropy.Buffer.write(lightingBufferId, packLighting(l));
    Entropy.Lighting.updateSun({ horizonColor: l.horizonColor, zenithColor: l.zenithColor, sunDirection: l.sunDirection, sunColor: l.sunColor, sunIntensity: l.sunIntensity });
}
let gameSession: LogicSession | null = null;
let gamePreviousTime: number | null = null;
let workspace: "animation" | "logic" = "animation";
let workspaceVisible = false;
function showWorkspace(kind: "animation" | "logic"): void {
    workspace = kind; workspaceVisible = true;
    Entropy.UI.setWindowVisible(keyframeWindowId, true);
}
let editingClipId: string | null = null;

// --- Play sessions ------------------------------------------------------------------------------
//
// A GameRun is one Play: a fresh LogicSession plus everything Play may change (which surfaces are
// shown, where the player stands), snapshotted so Stop puts it all back and the scene never turns
// dirty from playing. With a `world.player` set, the keyboard walks it (WASD, camera-relative) and
// the camera follows; without one, Play is the original click-only mode with the orbit camera.
// A `dry` run does the same work but never touches a mesh or the camera. The canvas_playtest tool
// uses it to play a whole game inside one frame, which also keeps it clear of the engine's
// same-tick mesh queue ordering (see the note above spawnSurface).

const PLAYER_HEIGHT = 1.8;
function ancestorIds(s: Surface): string[] {
    const ids: string[] = [];
    let id = s.parentId;
    while (id) { ids.push(id); id = groups.find(g => g.id === id)?.parentId ?? null; }
    return ids;
}
/** A surface id maps to itself; a group id to every surface anywhere beneath it. */
function surfacesUnder(id: string): Surface[] {
    const direct = surfaces.find(s => s.id === id);
    return direct ? [direct] : surfaces.filter(s => ancestorIds(s).includes(id));
}
function surfaceFootprint(s: Surface): { rect: Rect; minY: number } {
    const bb = surfaceAABB(s);
    return { rect: { minX: bb.min[0], maxX: bb.max[0], minZ: bb.min[2], maxZ: bb.max[2] }, minY: bb.min[1] };
}
interface PlayerHandle { position: Vec3; yaw: number; place(x: number, z: number, yaw?: number): void; }
/** The node the keyboard moves: a root group (a prefab person) or a root surface. */
function playerHandle(): PlayerHandle | null {
    const id = world.player;
    if (!id) return null;
    const g = groups.find(g => g.id === id);
    if (g) return g.parentId ? null : {
        position: g.position, yaw: g.rotation[1],
        place: (x, z, yaw) => { g.position = [x, g.position[1], z]; if (yaw !== undefined) g.rotation = [g.rotation[0], yaw, g.rotation[2]]; },
    };
    const s = surfaces.find(s => s.id === id);
    return s && !s.parentId ? {
        position: s.position, yaw: s.yaw,
        place: (x, z, yaw) => { s.position = [x, s.position[1], z]; if (yaw !== undefined) s.yaw = yaw; },
    } : null;
}
const targetIds = (): string[] => [...surfaces.map(s => s.id), ...groups.map(g => g.id)];

class GameRun {
    readonly session: LogicSession;
    message = "";
    /** Every message shown, in order, and every clip started. The playtest tool reports both. */
    readonly messages: string[] = [];
    readonly clipsPlayed: string[] = [];
    /** Set when the player moved; the frame loop rebuilds meshes once and clears it. */
    moved = false;
    private shown = new Map<string, boolean>();
    private home: { position: Vec3; yaw: number } | null;
    private rects = new Map<string, Rect>();
    private blockers: { s: Surface; rect: Rect }[] = [];
    constructor(readonly dry: boolean) {
        for (const s of surfaces) { s.worldPatches = buildSurfaceWorldPatches(s); this.shown.set(s.id, s.visible); }
        const p = playerHandle();
        this.home = p ? { position: [...p.position], yaw: p.yaw } : null;
        const own = new Set(p ? surfacesUnder(world.player!).map(s => s.id) : []);
        for (const s of surfaces) if (s.solid && !own.has(s.id)) {
            const f = surfaceFootprint(s);
            if (f.minY < PLAYER_HEIGHT) this.blockers.push({ s, rect: f.rect });
        }
        this.session = new LogicSession(JSON.parse(JSON.stringify(logic)), node => this.effect(node));
    }
    get hasPlayer(): boolean { return this.home !== null; }
    position(): XZ | null { const p = playerHandle(); return p ? [p.position[0], p.position[2]] : null; }
    private rectOf(s: Surface): Rect {
        let r = this.rects.get(s.id);
        if (!r) { r = surfaceFootprint(s).rect; this.rects.set(s.id, r); }
        return r;
    }
    /** Distance from the player to the nearest edge of what is currently shown under `target`. */
    distanceTo = (target: string): number | null => {
        const at = this.position();
        if (!at) return null;
        const rect = unionRect(surfacesUnder(target).filter(s => s.visible).map(s => this.rectOf(s)));
        return rect ? distanceToRect(at[0], at[1], rect) : null;
    };
    /** `dir` is a world-space XZ direction. Returns true if the player moved. */
    walk(dir: XZ, dt: number): boolean {
        const p = playerHandle();
        if (!p) return false;
        const live = this.blockers.filter(b => b.s.visible).map(b => b.rect);
        const step = stepPlayer([p.position[0], p.position[2]], dir, dt, live, world.bounds);
        if (!step.moved) return false;
        p.place(step.pos[0], step.pos[1], Math.atan2(dir[0], dir[1]));
        this.moved = true;
        return true;
    }
    tick(dt: number): void { this.session.tick(dt); this.session.proximity(this.distanceTo); }
    interact(): void { this.session.interact(this.distanceTo); }
    click(ids: string[]): void { this.session.click(ids); }
    prompt(): string | null { return this.session.interactables(this.distanceTo)[0]?.node.text ?? null; }
    private setShown(s: Surface, visible: boolean): void {
        if (s.visible === visible) return;
        s.visible = visible;
        if (this.dry) return;
        if (visible) createSurfaceMesh(s); else Entropy.Model.clearMesh(s.meshId);
    }
    private effect(node: LogicNode): void {
        if (node.kind === "message") { this.message = this.session.format(node.text); this.messages.push(this.message); }
        else if (node.kind === "show" || node.kind === "hide") for (const s of surfacesUnder(node.target)) this.setShown(s, node.kind === "show");
        else if (node.kind === "teleport") {
            const rect = unionRect(surfacesUnder(node.target).map(s => this.rectOf(s)));
            const p = playerHandle();
            if (rect && p) { p.place((rect.minX + rect.maxX) / 2, (rect.minZ + rect.maxZ) / 2); this.moved = true; }
        } else if (node.kind === "clip") {
            const clip = clips.find(c => c.id === node.target);
            if (clip) { this.clipsPlayed.push(clip.name); if (!this.dry) playCanvasClip(clip.name); }
        }
    }
    /** Put back everything Play changed. */
    restore(): void {
        for (const s of surfaces) { const was = this.shown.get(s.id); if (was !== undefined) this.setShown(s, was); }
        const p = playerHandle();
        if (p && this.home) p.place(this.home.position[0], this.home.position[2], this.home.yaw);
    }
}

let gameRun: GameRun | null = null;
let playReturnView: CameraView | null = null;
let camYaw = 0;
let camDistance = 9;
const CAMERA_PITCH = 0.72;
const held = (...keys: string[]): boolean => keys.some(k => Entropy.Input.isKeyPressed(k));
function moveInput(): XZ {
    const f = (held("w", "W", "ArrowUp", "arrowup") ? 1 : 0) - (held("s", "S", "ArrowDown", "arrowdown") ? 1 : 0);
    const r = (held("d", "D", "ArrowRight", "arrowright") ? 1 : 0) - (held("a", "A", "ArrowLeft", "arrowleft") ? 1 : 0);
    return [r, f];
}
function placeFollowCamera(): void {
    const p = playerHandle();
    if (!p) return;
    const view = followCamera([p.position[0], p.position[1] + 1, p.position[2]], camYaw, CAMERA_PITCH, camDistance);
    Entropy.Camera.setTransform(view.position, view.target);
}
Entropy.Input.onMouseWheel((_dx, dy) => { if (gameRun?.hasPlayer && !Entropy.Input.isPointerOverUI()) camDistance = Math.max(3, Math.min(25, camDistance - dy * 0.6)); });

function stopGame(): void {
    Entropy.UI.setWindowVisible(keyframeWindowId, workspaceVisible);
    const run = gameRun;
    gameRun = null;
    gameSession?.stop(); gameSession = null; gamePreviousTime = null;
    stopPreview(); selectedClipId = editingClipId ?? selectedClipId;
    if (run) {
        run.restore();
        if (run.hasPlayer) { refreshGeometry(); spawnGroundGrid(); if (playReturnView) applyView(playReturnView); }
    }
    playReturnView = null;
    textInputActive = false;
    lastGizmoSurfaceId = null;
    statusMessage = "Editing. Artwork and pose restored.";
}
function runGameAction(action: () => void): void {
    try { action(); } catch (error) { stopGame(); statusMessage = `Play stopped: ${(error as Error).message}`; }
}
function currentView(): CameraView {
    const [position, direction] = Entropy.Camera.getTransform();
    const distance = Math.max(1, Math.hypot(...subV(position, orbitTarget)));
    return { position: [...position], target: addV(position, direction.map(n => n * distance) as Vec3) };
}
function startGame(): void {
    if (gameSession) return;
    if (practiceSurface) togglePractice();
    stopPreview(); finishStroke(); resetGesture(); history.commit();
    const problems = logicProblems(logic, targetIds(), clips.map(c => c.id));
    if (problems.length) { statusMessage = problems[0]; showWorkspace("logic"); return; }
    editingClipId = selectedClipId; gamePreviousTime = null;
    Entropy.UI.setWindowVisible(keyframeWindowId, false);
    if (activeGizmoId) { Entropy.Gizmo.hide(activeGizmoId); activeGizmoId = null; }
    const run = new GameRun(false);
    gameRun = run; gameSession = run.session;
    if (run.hasPlayer) { playReturnView = currentView(); camYaw = 0; Entropy.Controls.disable(); Entropy.Model.clearMesh(GROUND_GRID_MESH_ID); placeFollowCamera(); }
    statusMessage = run.hasPlayer ? "Playing. WASD walks, E interacts. Stop returns to editing." : "Playing. Click a surface to interact. Stop returns to editing.";
    runGameAction(() => run.session.start());
}
function clickGameSurface(x: number, y: number): void {
    const hit = raycastSurfaces(x, y);
    const run = gameRun;
    if (hit && run) runGameAction(() => run.click([hit.surface.id, ...ancestorIds(hit.surface)]));
}
let activeGroupId: string | null = null;
let selectedStrokeId: string | null = null;
let selectedClipId: string | null = null;
let preview = false;
const editingPixels = new Map<string, Uint8Array>();
const previewArtworkKeys = new Map<string, string>();
const geometryKeys = new Map<string, string>();
let playing = false;
let playhead = 0;
let previousTime: number | null = null;
let pendingStroke: { surface: Surface; stroke: RetainedStroke } | null = null;
let replayLayer: PaintLayer | null = null;
function currentClip(): Clip | null { return clips.find(c => c.id === selectedClipId) ?? null; }
function surfaceTransform(s: Surface): Transform { return { position: s.position, rotation: [s.pitch, s.yaw, s.roll], scale: s.scale, pivot: s.pivot }; }
function surfaceMatrix(s: Surface): Matrix {
    const clip = preview ? currentClip() : null;
    return multiply(groupWorld(groups, s.parentId, clip, playhead), multiply(s.frame, transformMatrix(animatedTransform(surfaceTransform(s), s.id, clip, playhead))));
}
function refreshGeometry(): void {
    if (activeGizmoId) { Entropy.Gizmo.hide(activeGizmoId); activeGizmoId = null; }
    for (const s of surfaces) {
        const key = JSON.stringify([surfaceMatrix(s), s.kind, s.halfW, s.halfH, s.halfD, s.radius, s.bend, s.bendAxis, s.visible]);
        if (geometryKeys.get(s.id) === key) continue;
        geometryKeys.set(s.id, key);
        if (s.visible) { Entropy.Model.clearMesh(s.meshId); createSurfaceMesh(s); }
        else s.worldPatches = buildSurfaceWorldPatches(s);
    }
    lastGizmoSurfaceId = null;
}
function replayArtwork(s: Surface): void {
    for (const layer of s.layers) {
        if (!s.bases[layer.id]) continue;
        layer.pixels = s.bases[layer.id].slice();
        replayLayer = layer;
        for (const stroke of s.strokes.filter(st => st.layerId === layer.id)) {
            let progress = stroke.progress, visible = stroke.visible;
            for (const track of preview ? currentClip()?.tracks ?? [] : []) if (track.targetId === stroke.id) {
                if (track.channel === "progress") progress = sample(track, playhead);
                if (track.channel === "visible") visible = sample(track, playhead) >= 0.5;
            }
            if (!visible) continue;
            const count = Math.ceil(Math.max(0, Math.min(1, progress)) * stroke.stamps.length);
            for (const st of stroke.stamps.slice(0, count)) stamp(s, stroke.brush as Brush, st.x, st.y, st.radius, st.alpha, st.angle, st.elongation);
        }
        replayLayer = null;
    }
    composeSurface(s);
}
function finishRetainedStroke(): void {
    if (!pendingStroke) return;
    const { surface, stroke } = pendingStroke;
    pendingStroke = null;
    if (stroke.stamps.length) { surface.strokes = [...surface.strokes, stroke]; selectedStrokeId = stroke.id; }
}
function stopPreview(): void {
    if (!preview) return;
    preview = false; playing = false; previousTime = null;
    for (const s of surfaces) {
        let changed = false;
        for (const layer of s.layers) if (editingPixels.has(layer.id)) {
            changed ||= layer.pixels !== editingPixels.get(layer.id);
            layer.pixels = editingPixels.get(layer.id)!;
        }
        if (changed) composeSurface(s);
    }
    editingPixels.clear(); previewArtworkKeys.clear(); refreshGeometry();
}
function previewAt(time: number): void {
    finishStroke(); resetGesture(); history.commit();
    if (!preview) for (const s of surfaces) for (const layer of s.layers) editingPixels.set(layer.id, layer.pixels);
    preview = true; playhead = Math.max(0, Math.min(currentClip()?.duration ?? 1, time));
    if (activeGizmoId) { Entropy.Gizmo.hide(activeGizmoId); activeGizmoId = null; }
    for (const s of surfaces) {
        const tracks = (currentClip()?.tracks ?? []).filter(t => s.strokes.some(st => st.id === t.targetId));
        if (!tracks.length) continue;
        const key = JSON.stringify(tracks.map(t => [t.targetId, t.channel, sample(t, playhead)]));
        if (previewArtworkKeys.get(s.id) === key) continue;
        previewArtworkKeys.set(s.id, key); replayArtwork(s);
    }
    refreshGeometry();
}
/** Gameplay clip entry point. Scrubbing and clip preview remain editor-only controls. */
export function playCanvasClip(name: string): boolean {
    if (!gameSession) return false;
    const clip = clips.find(c => c.name === name);
    if (!clip) return false;
    stopPreview(); selectedClipId = clip.id; previewAt(0); playing = true; previousTime = null; return true;
}


// Snapshots share unchanged canvases. Paint gestures copy only their target canvas before
// writing; moving a surface therefore costs metadata, not another 2.3 MB bitmap.
type SurfaceState = Omit<Surface, "worldPatches" | "dirty" | "canvas">;
interface SceneState { surfaces: SurfaceState[]; activeId: string | null; sceneId: string | null; sceneName: string; groups: Group[]; clips: Clip[]; logic: LogicGraph; world: WorldState; activeGroupId: string | null; selectedClipId: string | null; selectedStrokeId: string | null; }
let historyReady = false;
let restoringHistory = false;
let pointerHeld = false;
let penHeld = false;
let gestureCanvases = new Set<string>();

function captureScene(): SceneState {
    return {
        logic: JSON.parse(JSON.stringify(logic)), world: JSON.parse(JSON.stringify(world)),
        activeId: activeSurfaceId, sceneId: currentSceneId, sceneName, groups: JSON.parse(JSON.stringify(groups)), clips: JSON.parse(JSON.stringify(clips)), activeGroupId, selectedClipId, selectedStrokeId,
        surfaces: surfaces.map(({ worldPatches: _patches, dirty: _dirty, canvas: _canvas, ...s }) => ({
            ...s, position: [...s.position], scale: [...s.scale], pivot: [...s.pivot], frame: [...s.frame], layers: s.layers.map(layer => ({ ...layer, pixels: editingPixels.get(layer.id) ?? layer.pixels })),
        })),
    };
}

function sameScene(a: SceneState, b: SceneState): boolean {
    // Selection alone is not an edit. Keep it in snapshots to restore a deleted selection.
    return JSON.stringify(a.logic) === JSON.stringify(b.logic) && JSON.stringify(a.world) === JSON.stringify(b.world) && JSON.stringify(a.groups) === JSON.stringify(b.groups) && JSON.stringify(a.clips) === JSON.stringify(b.clips) && a.sceneId === b.sceneId && a.sceneName === b.sceneName && a.surfaces.length === b.surfaces.length && a.surfaces.every((s, i) => {
        const other = b.surfaces[i];
        const { layers, bases, strokes, cutMask, activeLayerId: _active, ...meta } = s;
        const { layers: otherLayers, bases: otherBases, strokes: otherStrokes, cutMask: otherMask, activeLayerId: _otherActive, ...otherMeta } = other;
        return strokes === otherStrokes && Object.keys(bases).length === Object.keys(otherBases).length && Object.keys(bases).every(id => bases[id] === otherBases[id]) && cutMask === otherMask && JSON.stringify(meta) === JSON.stringify(otherMeta) &&
            layers.length === otherLayers.length && layers.every((layer, index) => {
                const { pixels, ...properties } = layer;
                const { pixels: otherPixels, ...otherProperties } = otherLayers[index];
                return pixels === otherPixels && JSON.stringify(properties) === JSON.stringify(otherProperties);
            });
    });
}

function restoreScene(state: SceneState): void {
    logic = JSON.parse(JSON.stringify(state.logic));
    if (JSON.stringify(world) !== JSON.stringify(state.world)) { world = JSON.parse(JSON.stringify(state.world)); applyLighting(); }
    stopPreview();
    restoringHistory = true;
    geometryKeys.clear();
    groups = JSON.parse(JSON.stringify(state.groups)); clips = JSON.parse(JSON.stringify(state.clips)); activeGroupId = state.activeGroupId; selectedClipId = state.selectedClipId; selectedStrokeId = state.selectedStrokeId;
    resetGesture();
    if (activeGizmoId) Entropy.Gizmo.hide(activeGizmoId);
    activeGizmoId = null;
    lastGizmoSurfaceId = null;
    const old = new Map(surfaces.map(s => [s.id, s]));
    const wanted = new Set(state.surfaces.map(s => s.id));
    for (const s of surfaces) if (!wanted.has(s.id) && s.visible) Entropy.Model.clearMesh(s.meshId);
    surfaces.length = 0;
    for (const saved of state.surfaces) {
        const existing = old.get(saved.id);
        const s: Surface = { ...saved, position: [...saved.position], scale: [...saved.scale], pivot: [...saved.pivot], frame: [...saved.frame], layers: saved.layers.map(layer => ({ ...layer })),
            canvas: new Uint8Array(CANVAS_RES * CANVAS_RES * 4), dirty: true, worldPatches: [] };
        composeSurface(s);
        // Recreate geometry only when needed. Clear/create ordering is supported by the engine;
        // updateVertices in the same tick as createMesh is not.
        if (existing?.visible) Entropy.Model.clearMesh(existing.meshId);
        if (s.visible) createSurfaceMesh(s);
        else s.worldPatches = buildSurfaceWorldPatches(s);
        Entropy.Buffer.write(s.previewBufferId, new Float32Array(8));
        surfaces.push(s);
    }
    activeSurfaceId = state.activeId;
    currentSceneId = state.sceneId;
    sceneName = state.sceneName;
    previewSurfaceId = null;
    restoringHistory = false;
}

const history = new CanvasHistory(captureScene, restoreScene, sameScene, states => {
    const canvases = new Set(states.flatMap(state => state.surfaces.flatMap(s => [s.cutMask, ...Object.values(s.bases), ...s.layers.map(layer => layer.pixels)])));
    const strokes = new Set(states.flatMap(state => state.surfaces.flatMap(s => s.strokes)));
    return [...canvases].reduce((bytes, canvas) => bytes + canvas.byteLength, 0) + [...strokes].reduce((bytes, stroke) => bytes + stroke.stamps.length * 64, 0);
});

function beginEdit(label: string): void {
    stopPreview();
    if (!historyReady || restoringHistory || practiceSurface) return;
    if (!history.inProgress) gestureCanvases.clear();
    history.begin(label);
}

function editableLayer(s: Surface): PaintLayer | null {
    const layer = s.layers.find(layer => layer.id === s.activeLayerId);
    return layer && layer.visible && !layer.locked ? layer : null;
}
function composeSurface(s: Surface): void {
    compositeLayers(s.canvas, s.layers, s.cutMask, BACKGROUND);
    s.dirty = true;
}
function editCanvas(s: Surface, label: string): void {
    beginEdit(label);
    const layer = editableLayer(s);
    if (layer && !gestureCanvases.has(`${s.id}:${layer.id}`)) {
        layer.pixels = layer.pixels.slice();
        gestureCanvases.add(`${s.id}:${layer.id}`);
    }
}
function newPaintLayer(name: string): PaintLayer {
    return { id: Entropy.generateUUID(), name, visible: true, locked: false, opacity: 1, pixels: new Uint8Array(CANVAS_RES * CANVAS_RES * 4) };
}
function changeLayer(s: Surface, label: string, change: () => void): void {
    beginEdit(label);
    change();
    composeSurface(s);
}

function resetGesture(): void {
    finishRetainedStroke();
    if (cutTarget) composeSurface(cutTarget);
    drawTarget = null;
    lastStrokePoint = null;
    rawStrokePoint = null;
    mouseDrawing = false;
    cutTarget = null;
    cutPath = [];
    mouseCutting = false;
    gestureCanvases.clear();
}

function undo(): void { if (practiceSurface) return; resetGesture(); history.undo(); }
function redo(): void { if (practiceSurface) return; resetGesture(); history.redo(); }


function surfaceMeshData(s: Surface): { vertexData: number[]; indexData: number[] } {
    const worldPatches = buildSurfaceWorldPatches(s);
    s.worldPatches = worldPatches;
    const vertexData: number[] = [];
    const indexData: number[] = [];
    let base = 0;
    for (const patch of worldPatches) {
        for (let row = 0; row < patch.rows; row++) {
            for (let col = 0; col < patch.cols; col++) {
                const [wx, wy, wz] = patch.verts[row][col];
                const [nx, ny, nz] = patch.normals[row][col];
                const { u, v } = patch.uv[row][col];
                vertexData.push(wx, wy, wz, nx, ny, nz, u, v, 1, 1, 1, 1);
            }
        }
        const rowStride = patch.cols;
        const [i0, i1, i2, i3, i4, i5] = patch.winding;
        for (let row = 0; row < patch.rows - 1; row++) {
            for (let col = 0; col < patch.cols - 1; col++) {
                const a = base + row * rowStride + col, b = a + 1, c = a + rowStride, d = c + 1;
                const corner = [a, b, c, d]; // slot 0=TL,1=TR,2=BL,3=BR
                indexData.push(corner[i0], corner[i1], corner[i2], corner[i3], corner[i4], corner[i5]);
            }
        }
        base += patch.rows * patch.cols;
    }
    return { vertexData, indexData };
}

function pushSurfaceTransform(s: Surface): void {
    geometryKeys.delete(s.id);
    const worldPatches = buildSurfaceWorldPatches(s);
    s.worldPatches = worldPatches;
    const positions: number[] = [];
    for (const patch of worldPatches) for (const row of patch.verts) for (const p of row) positions.push(p[0], p[1], p[2]);
    const indices = Array.from({ length: positions.length / 3 }, (_, k) => k);
    Entropy.Mesh.updateVertices(s.meshId, indices, positions);
    if (activeGizmoId && activeSurfaceId === s.id) Entropy.Gizmo.updatePosition(activeGizmoId, s.position);
}

// --- Edge/center snapping -----------------------------------------------------------------------

const SNAP_DISTANCE = 0.2; // world units

interface AABB { min: Vec3; max: Vec3; }

// Scans every cached world vertex across every patch rather than a shape-specific set of extreme
// corners - a plane only had 4 corners worth checking, but a box/cylinder/sphere doesn't have a
// small fixed corner set the way a flat quad does, so this is the one AABB implementation that
// works unmodified for all four kinds.
function surfaceAABB(s: Surface): AABB {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const patch of s.worldPatches) {
        for (const row of patch.verts) {
            for (const p of row) {
                for (let axis = 0; axis < 3; axis++) {
                    min[axis] = Math.min(min[axis], p[axis]);
                    max[axis] = Math.max(max[axis], p[axis]);
                }
            }
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
    beginEdit("Move surface");
    s.position = snap && !s.parentId && JSON.stringify(s.frame) === JSON.stringify(identity()) ? snapPosition(s, candidate) : candidate;
    pushSurfaceTransform(s);
    if (activeGizmoId && activeSurfaceId === s.id) Entropy.Gizmo.updatePosition(activeGizmoId, s.position);
}

function createSurfaceMesh(s: Surface): void {
    const { vertexData, indexData } = surfaceMeshData(s); // also refreshes s.worldPatches
    Entropy.Model.createMesh({
        id: s.meshId,
        position: [0, 0, 0], // baked directly into world-space vertices below, not this transform
        vertexData,
        indexData,
        pipelineId,
        bindings: [
            { group: 2, binding: 0, resource: { type: "Texture", value: { id: s.textureId } } },
            { group: 2, binding: 1, resource: { type: "Sampler" } },
            { group: 2, binding: 2, resource: { type: "Buffer", value: { id: s.previewBufferId } } },
            { group: 2, binding: 3, resource: { type: "Buffer", value: { id: lightingBufferId } } },
        ],
    });
}

let surfaceCount = 0;
let pendingWidth = DEFAULT_HALF_SIZE * 2;
let pendingHeight = DEFAULT_HALF_SIZE * 2;
let pendingDepth = DEFAULT_HALF_DEPTH * 2;
let pendingRadius = DEFAULT_RADIUS;
let pendingKind: ShapeKind = "plane";

// Engine gotcha found while verifying bend this session, not touched here: don't call
// pushSurfaceTransform (or setSurfaceDimensions/setSurfaceBend*) in the same tick as spawnSurface.
// op_mesh_update_vertices's queue is drained *before* op_model_create_mesh's queue every frame
// (src/deno/addon_engine.rs - pending_mesh_updates around line 1983 runs ahead of pending_meshes
// around line 2476), so a same-tick update finds no matching mesh yet and is silently dropped for
// good (the queue is cleared either way, never re-queued). Every real call site in this file
// (UI onChange handlers, gizmo onTransform) already fires many frames after creation, so this
// never bites normal use - it only matters for a future addon that reshapes a surface immediately
// after spawning it.
// `restore` is passed by loadScene() - it seeds the fields a freshly-drawn "+ New
// Surface" never needs a starting value for (an existing pitch/roll/bend, a previously-painted
// canvas). Baking all of it into this ONE createSurfaceMesh call (below) rather than creating
// flat-and-default then following up with a pushSurfaceTransform/setSurfaceBend* call is what
// sidesteps the same-tick op_mesh_update_vertices/op_model_create_mesh ordering gotcha
// documented above - there's no follow-up update call needed at all, the initial mesh is
// already correct.
function spawnSurface(
    position: Vec3, yaw: number, kind: ShapeKind = "plane",
    halfW = DEFAULT_HALF_SIZE, halfH = DEFAULT_HALF_SIZE, halfD = DEFAULT_HALF_DEPTH, radius = DEFAULT_RADIUS,
    restore?: { id?: string; parentId?: string | null; frame?: Matrix; scale?: Vec3; pivot?: Vec3; strokes?: RetainedStroke[]; bases?: Record<string, Uint8Array>; name?: string; pitch?: number; roll?: number; bend?: number; bendAxis?: BendAxis; canvas?: Uint8Array; visible?: boolean; solid?: boolean; layers?: PaintLayer[]; activeLayerId?: string; cutMask?: Uint8Array }
): Surface {
    beginEdit("New surface");
    surfaceCount++;
    const id = restore?.id ?? `canvas_surface_${Entropy.generateUUID()}`;
    const canvas = new Uint8Array(CANVAS_RES * CANVAS_RES * 4);
    const layers = restore?.layers ?? [newPaintLayer(restore?.canvas ? "Imported artwork" : "Ink")];
    const cutMask = restore?.cutMask ?? new Uint8Array(CANVAS_RES * CANVAS_RES).fill(255);
    if (restore?.canvas) {
        layers[0].pixels.set(restore.canvas);
        for (let i = 0; i < cutMask.length; i++) {
            cutMask[i] = restore.canvas[i * 4 + 3];
            layers[0].pixels[i * 4 + 3] = 255;
        }
    }
    compositeLayers(canvas, layers, cutMask, BACKGROUND);
    const textureId = Entropy.Texture.create(CANVAS_RES, CANVAS_RES, canvas);

    const s: Surface = {
        id,
        parentId: restore?.parentId ?? null, frame: restore?.frame ?? identity(), scale: restore?.scale ?? [1, 1, 1], pivot: restore?.pivot ?? [0, 0, 0],
        strokes: restore?.strokes ?? [], bases: restore?.bases ?? {},
        meshId: id,
        textureId,
        previewBufferId: Entropy.Buffer.create({ size: 32, usage: "Uniform" }),
        name: restore?.name ?? `Surface ${surfaceCount}`,
        kind,
        position,
        yaw,
        pitch: restore?.pitch ?? 0,
        roll: restore?.roll ?? 0,
        halfW,
        halfH,
        halfD,
        radius,
        bend: restore?.bend ?? 0,
        bendAxis: restore?.bendAxis ?? "y",
        canvas, layers, cutMask, activeLayerId: restore?.activeLayerId ?? layers[0].id,
        dirty: false,
        visible: restore?.visible ?? true,
        solid: restore?.solid ?? false,
        worldPatches: [],
    };

    Entropy.Buffer.write(s.previewBufferId, new Float32Array(8));
    if (s.visible) createSurfaceMesh(s);
    else s.worldPatches = buildSurfaceWorldPatches(s);

    surfaces.push(s);
    activeGroupId = null; selectedStrokeId = null;
    activeSurfaceId = s.id;
    Entropy.println(`[canvas-surfaces] spawned ${s.name} (${kind}) (${id}) at [${position.map(n => n.toFixed(2))}]`);
    return s;
}

function activeSurface(): Surface | null {
    return practiceSurface ?? surfaces.find(s => s.id === activeSurfaceId) ?? null;
}

// Hiding/showing has no dedicated op - a plain createMesh mesh has no visibility flag - so it
// clears and (on show) recreates the mesh with the surface's current geometry/texture binding.
function setSurfaceVisible(s: Surface, visible: boolean): void {
    if (s.visible === visible) return;
    beginEdit(visible ? "Show surface" : "Hide surface");
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

// Generic over all four kinds - each UI slider only ever passes the one or two dimensions that
// actually apply to the selected surface's kind (see renderUI's per-kind slider set), leaving the
// others untouched.
function setSurfaceDimensions(s: Surface, dims: Partial<{ halfW: number; halfH: number; halfD: number; radius: number }>): void {
    beginEdit("Resize surface");
    if (dims.halfW !== undefined) s.halfW = Math.max(0.1, dims.halfW);
    if (dims.halfH !== undefined) s.halfH = Math.max(0.1, dims.halfH);
    if (dims.halfD !== undefined) s.halfD = Math.max(0.1, dims.halfD);
    if (dims.radius !== undefined) s.radius = Math.max(0.1, dims.radius);
    pushSurfaceTransform(s);
}

function setSurfaceBend(s: Surface, bend: number): void {
    beginEdit("Bend surface");
    s.bend = Math.max(-1, Math.min(1, bend));
    pushSurfaceTransform(s);
}

function setSurfaceBendAxis(s: Surface, axis: BendAxis): void {
    if (s.bendAxis === axis) return;
    beginEdit("Bend axis");
    s.bendAxis = axis;
    pushSurfaceTransform(s);
}

// --- Screen -> surface-local paint coordinate ---------------------------------------------------

interface SurfaceHit {
    surface: Surface;
    px: number; // pixel x within that surface's own canvas
    py: number;
    t: number;
}

// Ray-triangle intersection (Moller-Trumbore) against one triangle. Returns the hit distance and
// the barycentric weights for v1/v2 (weight for v0 is 1 - bu - bv) so the caller can interpolate
// whatever per-vertex attributes it needs (here: UV) rather than just a hit point.
function rayTriangleIntersect(origin: Vec3, dir: Vec3, v0: Vec3, v1: Vec3, v2: Vec3): { t: number; bu: number; bv: number } | null {
    const EPS = 1e-7;
    const e1 = subV(v1, v0);
    const e2 = subV(v2, v0);
    const pvec = crossV(dir, e2);
    const det = dotV(e1, pvec);
    if (Math.abs(det) < EPS) return null; // ray parallel to the triangle's plane
    const invDet = 1 / det;
    const tvec = subV(origin, v0);
    const bu = dotV(tvec, pvec) * invDet;
    if (bu < 0 || bu > 1) return null;
    const qvec = crossV(tvec, e1);
    const bv = dotV(dir, qvec) * invDet;
    if (bv < 0 || bu + bv > 1) return null;
    const t = dotV(e2, qvec) * invDet;
    if (t <= 1e-6) return null;
    return { t, bu, bv };
}

// Real per-triangle raycast against one surface's cached world-space patches (s.worldPatches) -
// replaces phase 1's flat-plane shortcut so drawing/selection stay accurate on any shape, curved
// or not. Each patch supplies its own winding (see patchWinding), so this loop never hardcodes
// which corner pairing forms a triangle - it just asks the patch. No bounding-volume pre-check
// (deliberately simple, and still cheap at this demo's surface counts and stroke sampling rate) -
// a box's 6 faces (3072 triangles total) is the priciest shape here and still comfortably
// sub-millisecond in practice.
// A cut hole (see finishCut) zeroes the canvas alpha inside its polygon and the fragment shader
// discards any pixel below this same threshold - checking it here too means a ray (paint or
// selection) passes straight through a hole instead of catching on it, matching what the eye
// sees. Nearest-neighbor sample (round, not bilinear) is enough at CANVAS_RES=768 for a raycast.
function isCanvasAlphaCut(s: Surface, px: number, py: number): boolean {
    const x = Math.min(CANVAS_RES - 1, Math.max(0, Math.round(px)));
    const y = Math.min(CANVAS_RES - 1, Math.max(0, Math.round(py)));
    return s.canvas[(y * CANVAS_RES + x) * 4 + 3] < 128;
}

function raycastSurfaceMesh(s: Surface, origin: Vec3, dir: Vec3): SurfaceHit | null {
    let best: { t: number; u: number; v: number } | null = null;

    for (const patch of s.worldPatches) {
        const [i0, i1, i2, i3, i4, i5] = patch.winding;
        for (let row = 0; row < patch.rows - 1; row++) {
            for (let col = 0; col < patch.cols - 1; col++) {
                const cornerV = [patch.verts[row][col], patch.verts[row][col + 1], patch.verts[row + 1][col], patch.verts[row + 1][col + 1]];
                const cornerUV = [patch.uv[row][col], patch.uv[row][col + 1], patch.uv[row + 1][col], patch.uv[row + 1][col + 1]];

                let hit = rayTriangleIntersect(origin, dir, cornerV[i0], cornerV[i1], cornerV[i2]);
                if (hit) {
                    const w0 = 1 - hit.bu - hit.bv, w1 = hit.bu, w2 = hit.bv;
                    const u = w0 * cornerUV[i0].u + w1 * cornerUV[i1].u + w2 * cornerUV[i2].u;
                    const v = w0 * cornerUV[i0].v + w1 * cornerUV[i1].v + w2 * cornerUV[i2].v;
                    if ((!best || hit.t < best.t) && !isCanvasAlphaCut(s, u * CANVAS_RES, v * CANVAS_RES)) {
                        best = { t: hit.t, u, v };
                    }
                }
                hit = rayTriangleIntersect(origin, dir, cornerV[i3], cornerV[i4], cornerV[i5]);
                if (hit) {
                    const w0 = 1 - hit.bu - hit.bv, w1 = hit.bu, w2 = hit.bv;
                    const u = w0 * cornerUV[i3].u + w1 * cornerUV[i4].u + w2 * cornerUV[i5].u;
                    const v = w0 * cornerUV[i3].v + w1 * cornerUV[i4].v + w2 * cornerUV[i5].v;
                    if ((!best || hit.t < best.t) && !isCanvasAlphaCut(s, u * CANVAS_RES, v * CANVAS_RES)) {
                        best = { t: hit.t, u, v };
                    }
                }
            }
        }
    }
    if (!best) return null;
    return { surface: s, px: best.u * CANVAS_RES, py: best.v * CANVAS_RES, t: best.t };
}

function raycastSurfaces(screenX: number, screenY: number): SurfaceHit | null {
    const ray = Entropy.Camera.screenToWorldRay(screenX, screenY);
    let best: SurfaceHit | null = null;

    for (const s of practiceSurface ? [practiceSurface] : surfaces) {
        if (!s.visible) continue;
        const hit = raycastSurfaceMesh(s, ray.origin, ray.direction);
        if (hit && (!best || hit.t < best.t)) best = hit;
    }
    return best;
}

// --- Painting (adapted from stylus_drawing_addon.ts's stamp/paintSegment) ----------------------

function stamp(s: Surface, brush: Brush, cx: number, cy: number, radius: number, alpha: number, angle: number, elongation: number): void {
    if (radius <= 0 || alpha <= 0) return;
    const canvas = s.canvas;
    const layer = replayLayer ?? editableLayer(s);
    const isGuide = brush === CUT_GUIDE_BRUSH;
    if (!isGuide && !layer) return;
    if (!isGuide && !replayLayer && pendingStroke?.surface === s) pendingStroke.stroke.stamps.push({ x: cx, y: cy, radius, alpha, angle, elongation });

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
            if (isGuide) {
                canvas[i] = r * a + canvas[i] * (1 - a);
                canvas[i + 1] = g * a + canvas[i + 1] * (1 - a);
                canvas[i + 2] = b * a + canvas[i + 2] * (1 - a);
            } else if (layer) {
                blendPixel(layer.pixels, i, brush.color, a, brush.isEraser);
                if (!replayLayer) compositePixel(canvas, s.layers, s.cutMask, BACKGROUND, i);
            }
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
    const approxRadius = brushRadius(brush, Math.max(from.pressure, to.pressure));
    const step = Math.max(0.25, approxRadius * brush.spacingFactor);
    const steps = Math.max(1, Math.ceil(dist / step));

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const px = from.px + (to.px - from.px) * t;
        const py = from.py + (to.py - from.py) * t;
        const pressure = from.pressure + (to.pressure - from.pressure) * t;
        const tiltX = from.tiltX + (to.tiltX - from.tiltX) * t;
        const tiltY = from.tiltY + (to.tiltY - from.tiltY) * t;

        const radius = brushRadius(brush, pressure);
        const alpha = brushAlpha(brush, pressure);
        const { angle, magnitude } = tiltVector(tiltX, tiltY);
        stamp(s, brush, px, py, radius, alpha, angle, brush.tiltElongation * magnitude);
    }
}

// --- Cut tool: draw a closed shape on a surface, and once it loops back to its own start point,
// punch a hole straight through the surface at that shape - a real see-through hole (the fragment
// shader discards it, see CANVAS_SURFACE_SHADER below), not a color/opacity blend. ---------------
//
// Reuses the exact same screen -> surface-local raycast path painting already uses
// (raycastSurfaceMesh via continueStroke's sibling below), so a cut stroke tracks the pointer
// across a bent/curved surface exactly as accurately as a paint stroke does. Instead of stamping
// color, it records the path (in the surface's own canvas-pixel space, same units stamp() already
// works in) and paints a thin guide line as feedback so the shape being drawn is visible - reuses
// `stamp` directly (which already takes an explicit Brush, unlike paintSegment) rather than
// routing through currentBrush(), so drawing a cut guide never disturbs the active paint brush.
//
// Closing the loop is "the pointer comes back within CUT_CLOSE_DISTANCE canvas-px of the stroke's
// own first point, after at least CUT_MIN_POINTS points" - a plain click-and-release without ever
// looping back is NOT silently ignored: endCutStroke (pointer-up) also fires the cut using an
// implicit closing segment from the last point straight back to the first, since a hand-drawn
// shape (especially with a stylus) may never precisely re-cross its own start.
//
// The actual cut is a standard even-odd scanline polygon fill over the path's own canvas-pixel
// bounding box, zeroing alpha (not color) inside it. That alpha buffer is the exact same one
// CANVAS_SURFACE_SHADER samples and isCanvasAlphaCut (raycastSurfaceMesh, above) checks - one
// buffer drives rendering, drawing-raycast pass-through, AND save/load (saveScene/loadScene
// already base64-round-trip the whole RGBA canvas, so a cut needs no new persisted field at all).
const CUT_GUIDE_COLOR: [number, number, number] = [206, 32, 32];
const CUT_GUIDE_BRUSH: Brush = {
    name: "CutGuide", color: CUT_GUIDE_COLOR, isEraser: false,
    baseRadius: 2.2, radiusGain: 0, softness: 0.05, opacityBase: 1, opacityGain: 0,
    tiltElongation: 0, spacingFactor: 0.3,
};
const CUT_CLOSE_DISTANCE = 16; // canvas px (of CANVAS_RES=768) - how close the loop must come to its own start
const CUT_MIN_POINTS = 8; // guards against an accidental instant-closure right after starting

interface CutPoint { px: number; py: number; }

let cutTarget: Surface | null = null;
let cutPath: CutPoint[] = [];
let mouseCutting = false;

function paintCutGuideSegment(s: Surface, from: CutPoint, to: CutPoint): void {
    const dist = Math.hypot(to.px - from.px, to.py - from.py);
    const steps = Math.max(1, Math.ceil(dist / 1.5));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        stamp(s, CUT_GUIDE_BRUSH, from.px + (to.px - from.px) * t, from.py + (to.py - from.py) * t, CUT_GUIDE_BRUSH.baseRadius, 1, 0, 0);
    }
}

// Standard even-odd scanline polygon fill, rasterized directly in canvas-pixel space (the same
// space every point in `path` already lives in). Zeroes alpha only - RGB is left as whatever was
// already painted/guide-lined there, since a discarded fragment never samples color at all.
function floodFillCutAlpha(s: Surface, path: CutPoint[]): void {
    if (path.length < 3) return;
    let minY = Infinity, maxY = -Infinity;
    for (const p of path) {
        minY = Math.min(minY, p.py);
        maxY = Math.max(maxY, p.py);
    }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(CANVAS_RES - 1, Math.ceil(maxY));
    const canvas = s.canvas;

    for (let y = y0; y <= y1; y++) {
        const yc = y + 0.5;
        const xs: number[] = [];
        for (let i = 0; i < path.length; i++) {
            const a = path[i], b = path[(i + 1) % path.length];
            if ((a.py <= yc && b.py > yc) || (b.py <= yc && a.py > yc)) {
                xs.push(a.px + ((yc - a.py) / (b.py - a.py)) * (b.px - a.px));
            }
        }
        xs.sort((m, n) => m - n);
        for (let i = 0; i + 1 < xs.length; i += 2) {
            const xStart = Math.max(0, Math.round(xs[i]));
            const xEnd = Math.min(CANVAS_RES - 1, Math.round(xs[i + 1]));
            for (let x = xStart; x <= xEnd; x++) {
                s.cutMask[y * CANVAS_RES + x] = 0;
                canvas[(y * CANVAS_RES + x) * 4 + 3] = 0;
            }
        }
    }
    s.dirty = true;
}

function finishCut(s: Surface, path: CutPoint[]): void {
    if (path.length < 3) return;
    const first = path[0], last = path[path.length - 1];
    if (Math.hypot(last.px - first.px, last.py - first.py) > 0.75) paintCutGuideSegment(s, last, first);
    floodFillCutAlpha(s, path);
    composeSurface(s);
    Entropy.println(`[canvas-surfaces] cut a ${path.length}-point hole into ${s.name}`);
}

function beginCut(hit: SurfaceHit): void {
    if (preview) return;
    beginEdit("Cut");
    hit.surface.cutMask = hit.surface.cutMask.slice();
    cutTarget = hit.surface;
    if (!practiceSurface) { activeSurfaceId = hit.surface.id; activeGroupId = null; }
    cutPath = [{ px: hit.px, py: hit.py }];
    stamp(hit.surface, CUT_GUIDE_BRUSH, hit.px, hit.py, CUT_GUIDE_BRUSH.baseRadius, 1, 0, 0);
}

function continueCut(x: number, y: number): void {
    if (!cutTarget || cutPath.length === 0) return;
    const ray = Entropy.Camera.screenToWorldRay(x, y);
    const hit = raycastSurfaceMesh(cutTarget, ray.origin, ray.direction);
    if (!hit) return; // off the edge, or the ray grazed past a curved surface - keep the path alive

    const point: CutPoint = { px: hit.px, py: hit.py };
    paintCutGuideSegment(cutTarget, cutPath[cutPath.length - 1], point);
    cutPath.push(point);

    if (cutPath.length >= CUT_MIN_POINTS) {
        const start = cutPath[0];
        if (Math.hypot(point.px - start.px, point.py - start.py) <= CUT_CLOSE_DISTANCE) {
            finishCut(cutTarget, cutPath);
            cutTarget = null;
            cutPath = [];
        }
    }
}

// Fallback for a stroke that's released without ever precisely looping back onto itself - closes
// it with a straight implicit segment (see finishCut) rather than discarding the whole shape.
function endCutStroke(): void {
    if (cutTarget && cutPath.length >= 3) finishCut(cutTarget, cutPath);
    else if (cutTarget) composeSurface(cutTarget);
    cutTarget = null;
    cutPath = [];
}

// --- Modes: Draw (paint on whichever surface the pointer hits) / Move (select + gizmo + rotate
// sliders) / Cut (draw a closed shape that punches a hole through the surface once it closes) -
// a plain click can't mean more than one of these at once. ---------------------------------------

type Mode = "draw" | "move" | "cut";
let mode: Mode = "draw";

let drawTarget: Surface | null = null;
let lastStrokePoint: StrokePoint | null = null;
let rawStrokePoint: StrokePoint | null = null;
let usingStylus = false;
let usingStylusClearPending = false;
let mouseDrawing = false;

// Tracks the orbit-trigger button (button 1 - see Entropy.Controls.enable's own button:1 in
// onInit below) so drawing can be suppressed while it's held - explicit ask, since without this
// a barrel-button-held stylus drag over a surface both orbited the camera AND painted a stroke
// at the same time. Real mouse right-clicks and a stylus barrel button both arrive as the same
// button:1 MouseDown/Up (see handle_stylus_touch's barrel-button synthesis, src/handlers.rs), so
// this one flag covers either source without needing to know which one is in use.
let orbitButtonDown = false;
Entropy.Input.onMouseDown((button) => {
    if (button === 0) {
        if (!penHeld) history.commit();
        pointerHeld = true;
    }
    if (button !== 1) return;
    if (cutTarget) history.cancel(); else history.commit();
    orbitButtonDown = true;
    // End whatever stroke was mid-flight cleanly rather than leaving a stale drawTarget/
    // lastStrokePoint around - resuming from those once orbiting stops would otherwise draw a
    // stray connecting line jump from wherever the stroke last was to wherever the pen re-lands.
    drawTarget = null;
    lastStrokePoint = null;
    // Same reasoning for an in-flight cut path: abandon it rather than resuming it after an
    // orbit, which would otherwise jump the shape across whatever the camera move revealed.
    cutTarget = null;
    cutPath = [];
});
Entropy.Input.onMouseUp((button) => {
    if (button === 0) pointerHeld = false;
    if (button === 1) orbitButtonDown = false;
});

let lastStylusReading = { pressure: 0, tiltX: 0 as number | null, tiltY: 0 as number | null };

function beginStroke(hit: SurfaceHit, pressure: number, tiltX: number, tiltY: number): void {
    if (preview) return;
    finishRetainedStroke();
    if (!editableLayer(hit.surface)) { statusMessage = "Choose a visible, unlocked paint layer."; return; }
    if (!currentBrush().isEraser) rememberColor();
    editCanvas(hit.surface, currentBrush().isEraser ? "Erase" : "Stroke");
    const layer = editableLayer(hit.surface)!;
    if (!hit.surface.bases[layer.id]) hit.surface.bases = { ...hit.surface.bases, [layer.id]: layer.pixels.slice() };
    const brush = currentBrush();
    pendingStroke = { surface: hit.surface, stroke: { id: Entropy.generateUUID(), name: `Stroke ${hit.surface.strokes.length + 1}`, layerId: layer.id, visible: true, progress: 1, brush: { color: [...brush.color], softness: brush.softness, isEraser: brush.isEraser }, stamps: [] } };
    drawTarget = hit.surface;
    if (!practiceSurface) { activeSurfaceId = hit.surface.id; activeGroupId = null; }
    lastStrokePoint = { px: hit.px, py: hit.py, pressure, tiltX, tiltY };
    rawStrokePoint = lastStrokePoint;
    stamp(
        hit.surface, currentBrush(), hit.px, hit.py,
        brushRadius(currentBrush(), pressure),
        brushAlpha(currentBrush(), pressure),
        tiltVector(tiltX, tiltY).angle, currentBrush().tiltElongation * tiltVector(tiltX, tiltY).magnitude
    );
}

function continueStroke(x: number, y: number, pressure: number, tiltX: number, tiltY: number): void {
    if (!drawTarget) return;
    const ray = Entropy.Camera.screenToWorldRay(x, y);
    const hit = raycastSurfaceMesh(drawTarget, ray.origin, ray.direction);
    // A missed region must break interpolation, otherwise returning draws a stray bridge.
    if (!hit || Entropy.Input.isPointerOverUI()) { lastStrokePoint = null; rawStrokePoint = null; return; }
    rawStrokePoint = { px: hit.px, py: hit.py, pressure, tiltX, tiltY };
    const point: StrokePoint = { ...rawStrokePoint, ...stabilizePoint(lastStrokePoint ?? rawStrokePoint, rawStrokePoint, paintSettings.stabilization * 32) };
    if (lastStrokePoint && point.px === lastStrokePoint.px && point.py === lastStrokePoint.py) return;
    paintSegment(drawTarget, lastStrokePoint ?? point, point);
    lastStrokePoint = point;
}

function finishStroke(): void {
    if (drawTarget && lastStrokePoint && rawStrokePoint && paintSettings.stabilization > 0)
        paintSegment(drawTarget, lastStrokePoint, rawStrokePoint);
    rawStrokePoint = null;
    finishRetainedStroke();
}

Entropy.Input.onStylusDown((e) => {
    if (gameSession) { if (!Entropy.Input.isPointerOverUI()) clickGameSurface(e.x, e.y); usingStylus = true; return; }
    history.commit();
    penHeld = true;
    currentMouseX = e.x;
    currentMouseY = e.y;
    pointerKnown = true;
    usingStylus = true;
    usingStylusClearPending = false;
    lastStylusReading = { pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY };
    textInputActive = Entropy.Input.isPointerOverUI();
    if (orbitButtonDown || textInputActive) return;
    if (pickingColor) { sampleColor(e.x, e.y); return; }
    if (mode === "draw") {
        const hit = raycastSurfaces(e.x, e.y);
        if (hit) beginStroke(hit, e.pressure, e.tiltX ?? 0, e.tiltY ?? 0);
    } else if (mode === "cut") {
        const hit = raycastSurfaces(e.x, e.y);
        if (hit) beginCut(hit);
    }
});

Entropy.Input.onStylusMove((e) => {
    currentMouseX = e.x;
    currentMouseY = e.y;
    pointerKnown = true;
    lastStylusReading = { pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY };
    if (orbitButtonDown) return;
    if (mode === "draw") continueStroke(e.x, e.y, e.pressure, e.tiltX ?? 0, e.tiltY ?? 0);
    else if (mode === "cut") continueCut(e.x, e.y);
});

Entropy.Input.onStylusUp((_e) => {
    finishStroke();
    penHeld = false;
    drawTarget = null;
    lastStrokePoint = null;
    if (mode === "cut") endCutStroke();
    history.commit();
    // See stylus_drawing_addon.ts for why this guard exists: Windows also synthesizes legacy
    // mouse-compatibility events for pen input, which would otherwise double-draw.
    usingStylusClearPending = true;
});

let currentMouseX = 0;
let currentMouseY = 0;
let pointerKnown = false;

Entropy.Input.onMouseDown((button, x, y) => {
    currentMouseX = x;
    currentMouseY = y;
    pointerKnown = true;
    if (button === 0) textInputActive = Entropy.Input.isPointerOverUI();
    if (button !== 0 || usingStylus || textInputActive) return;
    if (gameSession) { if (!orbitButtonDown) clickGameSurface(x, y); return; }
    if (pickingColor) { sampleColor(x, y); return; }

    if (mode === "draw") {
        mouseDrawing = true;
        const hit = raycastSurfaces(currentMouseX, currentMouseY);
        if (hit) beginStroke(hit, 1.0, 0, 0);
    } else if (mode === "cut") {
        mouseCutting = true;
        const hit = raycastSurfaces(currentMouseX, currentMouseY);
        if (hit) beginCut(hit);
    } else {
        const hit = raycastSurfaces(currentMouseX, currentMouseY);
        if (hit) {
            selectSurface(hit.surface);
            syncGizmoToSelection();
        }
    }
});

Entropy.Input.onMouseMove((x, y) => {
    pointerKnown = true;
    currentMouseX = x;
    currentMouseY = y;
    if (usingStylus) return;
    if (mode === "draw" && mouseDrawing) continueStroke(x, y, 1.0, 0, 0);
    else if (mode === "cut" && mouseCutting) continueCut(x, y);
});

Entropy.Input.onMouseUp((button) => {
    if (button !== 0 || usingStylus) return;
    finishStroke();
    mouseDrawing = false;
    drawTarget = null;
    lastStrokePoint = null;
    if (mouseCutting) {
        mouseCutting = false;
        endCutStroke();
    }
    history.commit();
});

// The ring is a shader overlay, never painted into canvas pixels or exported textures.
let previewSurfaceId: string | null = null;
let hoverSurfaceName = "";
function updateBrushPreview(): void {
    let hit: SurfaceHit | null = null;
    if (!gameSession && !preview && pointerKnown && mode === "draw" && !orbitButtonDown && !Entropy.Input.isPointerOverUI()) {
        if (drawTarget) {
            const ray = Entropy.Camera.screenToWorldRay(currentMouseX, currentMouseY);
            hit = raycastSurfaceMesh(drawTarget, ray.origin, ray.direction);
        } else hit = raycastSurfaces(currentMouseX, currentMouseY);
    }
    const target = hit?.surface;
    if (previewSurfaceId && previewSurfaceId !== target?.id) {
        const previous = (practiceSurface ? [practiceSurface, ...surfaces] : surfaces).find(s => s.id === previewSurfaceId);
        if (previous) Entropy.Buffer.write(previous.previewBufferId, new Float32Array(8));
    }
    previewSurfaceId = target?.id ?? null;
    hoverSurfaceName = target?.name ?? "";
    if (!target || !hit) return;
    if (drawTarget === target && lastStrokePoint && paintSettings.stabilization > 0) {
        hit.px = lastStrokePoint.px; hit.py = lastStrokePoint.py;
    }
    const brush = currentBrush();
    const pressure = penHeld ? lastStylusReading.pressure : 1;
    const radius = brushRadius(brush, pressure);
    const tilt = tiltVector(lastStylusReading.tiltX ?? 0, lastStylusReading.tiltY ?? 0);
    const elongation = brush.tiltElongation * (usingStylus ? tilt.magnitude : 0);
    Entropy.Buffer.write(target.previewBufferId, new Float32Array([
        hit.px, hit.py, radius * (1 + elongation * 0.9), radius * (1 - elongation * 0.55),
        Math.cos(tilt.angle), Math.sin(tilt.angle), 1, 0,
    ]));
}

interface CameraView { position: Vec3; target: Vec3; }
let returnView: CameraView | null = null;
let orbitTarget: Vec3 = [0, 1.2, 0];
let pendingOrbit: { target: Vec3; frames: number } | null = null;

function applyView(view: CameraView): void {
    Entropy.Controls.disable();
    Entropy.Camera.setTransform(view.position, view.target);
    orbitTarget = [...view.target];
    // Engine getTransform lags setTransform: context is sampled before pending transforms
    // are applied. Re-seed orbit only after both the render camera and context have caught up.
    pendingOrbit = { target: [...view.target], frames: 3 };
}

function focusSurface(align: boolean): void {
    const s = activeSurface();
    if (!s?.visible) return;
    const [position, direction] = Entropy.Camera.getTransform();
    if (!returnView) {
        const distance = Math.max(0.1, Math.hypot(...subV(position, orbitTarget)));
        const length = Math.hypot(...direction) || 1;
        returnView = { position: [...position], target: addV(position, direction.map(n => n / length * distance) as Vec3) };
    }
    const bounds = surfaceAABB(s);
    const target = bounds.min.map((n, i) => (n + bounds.max[i]) / 2) as Vec3;
    const radius = Math.hypot(...subV(bounds.max, bounds.min)) / 2;
    const [w, h] = Entropy.Window.getSize();
    // The engine's perspective vertical FOV is 45 degrees. Reserve space for the left panel.
    const usableAspect = Math.max(0.25, (w - 360) / Math.max(1, h));
    const halfFov = Math.min(Math.PI / 8, Math.atan(Math.tan(Math.PI / 8) * usableAspect));
    const distance = Math.max(1, radius * 1.25 / Math.sin(halfFov));
    let normal: Vec3 = align ? transformNormal(surfaceMatrix(s), [0, 0, 1])
        : direction.map(n => -n) as Vec3;
    // look-at uses world up: avoid an exactly parallel up/view vector for horizontal planes.
    if (Math.abs(normal[1]) > 0.9999) normal = [0, Math.sign(normal[1]) * 0.9999, 0.01414];
    const len = Math.hypot(...normal) || 1;
    applyView({ position: addV(target, normal.map(n => n / len * distance) as Vec3), target });
}

function restoreView(): void {
    if (!returnView) return;
    applyView(returnView);
    returnView = null;
}

Entropy.Input.onKeyDown((key, ctrl, shift, alt) => {
    const k = key.toLowerCase();
    if (gameSession) {
        if (k === "escape") stopGame();
        else if (k === "e" || k === "enter") { const run = gameRun; if (run) runGameAction(() => run.interact()); }
        return;
    }
    if (alt || textInputActive) return;
    if (ctrl && k === "s") { saveScene(); return; }
    if (ctrl && k === "z") { shift ? redo() : undo(); return; }
    if (ctrl && k === "y") { redo(); return; }
    if (k === "escape" && !ctrl) {
        if (cutTarget) { history.cancel(); resetGesture(); }
        else restoreView();
        return;
    }
    if (ctrl || pointerHeld || penHeld) return;
    if (k === "f") focusSurface(shift);
    else if (k === "b") setMode("draw");
    else if (k === "v") setMode("move");
    else if (k === "[") sizeMultiplier = Math.max(0.1, sizeMultiplier / 1.2);
    else if (k === "]") sizeMultiplier = Math.min(3, sizeMultiplier * 1.2);
});

// --- Move mode: translate + rotate gizmo. Both handle sets are shown and draggable at once
// ("translate_rotate" mode) rather than a separate mode toggle - the Yaw/Pitch/Roll sliders
// stay as an equally valid alternate input alongside the rotate handles, same reasoning the
// phase-1 card already gave for keeping the X/Y/Z position sliders alongside translate. ---------

let activeGizmoId: string | null = null;
let lastGizmoSurfaceId: string | null = null;

function syncGizmoToSelection(): void {
    if (gameSession || preview || activeGroupId) return;
    if (activeSurfaceId === lastGizmoSurfaceId) return;
    lastGizmoSurfaceId = activeSurfaceId;

    if (activeGizmoId) {
        Entropy.Gizmo.hide(activeGizmoId);
        activeGizmoId = null;
    }

    const s = activeSurface();
    if (!s || !s.visible || mode !== "move" || s.parentId || JSON.stringify(s.frame) !== JSON.stringify(identity())) return;

    activeGizmoId = Entropy.Gizmo.show({
        position: s.position,
        rotation: eulerToQuat(s.yaw, s.pitch, s.roll),
        mode: "translate_rotate",
        space: "world",
        onTransform: (delta) => {
            setSurfacePosition(s, addV(s.position, delta), true);
        },
        onRotate: (rotation) => {
            beginEdit("Rotate surface");
            const { yaw, pitch, roll } = quatToEuler(rotation);
            s.yaw = yaw;
            s.pitch = pitch;
            s.roll = roll;
            pushSurfaceTransform(s);
        },
        onComplete: () => history.commit(),
    });
}

// Called whenever yaw/pitch/roll changes from somewhere OTHER than the gizmo's own rotate
// handles (the Yaw/Pitch/Roll sliders) - without pushing the new orientation back, the gizmo's
// own Rust-side rotation stays stale and it visually snaps back to the pre-change orientation
// the next time its transform is rebuilt (same reason setSurfacePosition already does this for
// position via updatePosition).
function syncGizmoRotationFromSurface(s: Surface): void {
    if (activeGizmoId && activeSurfaceId === s.id) {
        Entropy.Gizmo.updateRotation(activeGizmoId, eulerToQuat(s.yaw, s.pitch, s.roll));
    }
}

function setMode(next: Mode): void {
    stopPreview(); finishStroke();
    if (practiceSurface && next !== "draw") togglePractice();
    if (cutTarget) history.cancel(); else history.commit();
    mode = next;
    if (mode !== "move" && activeGizmoId) {
        Entropy.Gizmo.hide(activeGizmoId);
        activeGizmoId = null;
        lastGizmoSurfaceId = null;
    } else if (mode === "move") {
        lastGizmoSurfaceId = null; // force syncGizmoToSelection to (re)create it next tick
    }
    // Abandon any in-flight stroke/cut rather than letting it resume oddly after a mode switch.
    drawTarget = null;
    lastStrokePoint = null;
    rawStrokePoint = null;
    mouseDrawing = false;
    cutTarget = null;
    cutPath = [];
    mouseCutting = false;
}

function deleteSurface(s: Surface): void {
    beginEdit("Delete surface");
    geometryKeys.delete(s.id); markedNodes.delete(s.id);
    for (const clip of clips) clip.tracks = clip.tracks.filter(t => t.targetId !== s.id && !s.strokes.some(st => st.id === t.targetId));
    if (s.visible) Entropy.Model.clearMesh(s.meshId);
    if (world.player === s.id) world.player = null;
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
    activeGroupId = null; selectedStrokeId = null;
    activeSurfaceId = s.id;
    if (mode === "move") lastGizmoSurfaceId = null; // force syncGizmoToSelection to move the gizmo
}

// --- Save / load scene ---------------------------------------------------------------------------
//
// Persisted via this addon's own scoped Entropy.IO.save/load (see cc_manager_addon.ts for the
// established precedent of this same API) - JSON.stringify under the hood, so each surface's
// painted canvas (a CANVAS_RES x CANVAS_RES RGBA Uint8Array, ~2.3MB raw) is base64-encoded first
// rather than embedded as a plain JSON number array, which JSON.stringify would otherwise expand
// into one comma-separated digit sequence per byte - several times larger and far slower to
// parse back. This addon's own registration needs `.with_data_dir(...)` in src/bin/example.rs
// for IO.save/load to actually persist anywhere (op_addon_save_data silently no-ops without a
// dev-controlled data_dir OR a loaded project - neither applies to a standalone EntropyApp like
// this one) - see that binary's canvas-surface-demo entry.
let currentSceneId: string | null = Entropy.generateUUID();
let sceneName = "Untitled scene";
let selectedSceneId: string | null = null;
let savedSceneState: SceneState | null = null;
let libraryReady = false;
let pendingSceneAction: { label: string; run: () => void } | null = null;
const sceneLibrary = new SceneLibrary<SavedScene>({
    loadIndex: () => addon.IO.load(), saveIndex: value => addon.IO.save(value),
    load: key => addon.GameState.load(key), save: (key, value) => addon.GameState.save(key, value),
    uuid: () => Entropy.generateUUID(),
}, validateScene);

function sceneIsDirty(): boolean {
    return savedSceneState ? !sameScene(savedSceneState, captureScene()) : true;
}
/** An unpainted, single-colour canvas is stored as its colour rather than as base64 (see uniformFill). */
function pixelFields(prefix: "pixels" | "basePixels", bytes: Uint8Array): Record<string, unknown> {
    const fill = uniformFill(bytes);
    return fill ? { [`${prefix}Fill`]: fill } : { [`${prefix}Base64`]: bytesToBase64(bytes) };
}
function maskFields(mask: Uint8Array): Record<string, unknown> {
    const first = mask[0];
    return mask.every(v => v === first) ? { cutMaskFill: first } : { cutMaskBase64: bytesToBase64(mask) };
}
function serializeScene(): SavedScene {
    return {
        version: 3, groups, clips, logic, world: { player: world.player, bounds: world.bounds, lighting: cloneLighting(world.lighting) },
        surfaces: surfaces.map((s): SavedSurface => ({
            id: s.id, parentId: s.parentId, frame: s.frame, scale: s.scale, pivot: s.pivot, strokes: s.strokes,
            name: s.name, kind: s.kind, position: [...s.position],
            yaw: s.yaw, pitch: s.pitch, roll: s.roll,
            halfW: s.halfW, halfH: s.halfH, halfD: s.halfD, radius: s.radius,
            bend: s.bend, bendAxis: s.bendAxis, visible: s.visible, ...(s.solid ? { solid: true } : {}),
            activeLayerId: s.activeLayerId, ...maskFields(s.cutMask),
            layers: s.layers.map(layer => ({
                id: layer.id, name: layer.name, visible: layer.visible, locked: layer.locked, opacity: layer.opacity,
                ...pixelFields("pixels", layer.pixels), ...(s.bases[layer.id] ? pixelFields("basePixels", s.bases[layer.id]) : {}),
            })),
        })),
    };
}
function saveScene(asNew = false): boolean {
    if (gameSession) return false;
    stopPreview();
    if (!libraryReady) { statusMessage = "Scene library unavailable. Restart after checking storage."; return false; }
    if (practiceSurface) togglePractice();
    finishStroke(); resetGesture(); history.commit();
    try {
        const entry = sceneLibrary.save(asNew ? null : currentSceneId, sceneName, validateScene(serializeScene()));
        const previousId = currentSceneId;
        history.remap(state => state.sceneId === previousId ? { ...state, sceneId: entry.id } : state);
        currentSceneId = entry.id;
        sceneName = entry.name;
        selectedSceneId = entry.id;
        savedSceneState = captureScene();
        statusMessage = `Saved: ${entry.name}`;
        textInputActive = false;
        return true;
    } catch (error) {
        statusMessage = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
        return false;
    }
}
function requestSceneAction(label: string, run: () => void): void {
    stopPreview();
    if (practiceSurface) togglePractice();
    finishStroke(); resetGesture(); history.commit();
    textInputActive = false;
    if (sceneIsDirty()) pendingSceneAction = { label, run };
    else run();
}
function loadScene(): void {
    if (!selectedSceneId) { statusMessage = "Choose a saved scene below."; return; }
    const id = selectedSceneId;
    // Validate and decode before asking to replace the current artwork.
    try {
        const scene = sceneLibrary.load(id);
        const decoded = scene.surfaces.map(saved => ({
            saved,
            canvas: scene.version === 1 ? base64ToBytes(saved.canvasBase64!) : undefined,
            layers: saved.layers?.map(({ pixelsBase64, pixelsFill, basePixelsBase64: _base, basePixelsFill: _baseFill, ...layer }) => ({ ...layer, pixels: pixelsFill ? fillBytes(pixelsFill) : base64ToBytes(pixelsBase64!) })),
            bases: Object.fromEntries((saved.layers ?? []).filter(layer => layer.basePixelsBase64 || layer.basePixelsFill).map(layer => [layer.id, layer.basePixelsFill ? fillBytes(layer.basePixelsFill) : base64ToBytes(layer.basePixelsBase64!)])),
            cutMask: saved.cutMaskFill !== undefined ? new Uint8Array(CANVAS_RES * CANVAS_RES).fill(saved.cutMaskFill) : saved.cutMaskBase64 ? base64ToBytes(saved.cutMaskBase64) : undefined,
        }));
        const name = sceneLibrary.entries.find(entry => entry.id === id)!.name;
        requestSceneAction(`Load ${name}`, () => {
            beginEdit("Load scene");
            for (const s of [...surfaces]) deleteSurface(s);
            groups = JSON.parse(JSON.stringify(scene.groups ?? [])); clips = JSON.parse(JSON.stringify(scene.clips ?? [])); activeGroupId = null; selectedClipId = clips[0]?.id ?? null; selectedStrokeId = null;
            logic = JSON.parse(JSON.stringify(scene.logic ?? emptyLogic()));
            world = scene.world ? { player: scene.world.player, bounds: scene.world.bounds, lighting: cloneLighting(scene.world.lighting) } : { player: null, bounds: DEFAULT_BOUNDS, lighting: defaultLighting() };
            applyLighting();
            for (const { saved, canvas, layers, cutMask, bases } of decoded) {
                spawnSurface(saved.position, saved.yaw, saved.kind, saved.halfW, saved.halfH, saved.halfD, saved.radius,
                    { ...saved, canvas, layers, cutMask, bases });
            }
            currentSceneId = id; sceneName = name;
            history.commit();
            savedSceneState = captureScene();
            statusMessage = `Loaded: ${name}`;
            pendingSceneAction = null;
        });
    } catch (error) { statusMessage = `Load failed: ${error instanceof Error ? error.message : String(error)}`; }
}
function newScene(): void {
    requestSceneAction("New scene", () => {
        beginEdit("New scene");
        for (const s of [...surfaces]) deleteSurface(s);
        groups = []; clips = []; activeGroupId = null; selectedClipId = null; selectedStrokeId = null;
        logic = emptyLogic(); resetWorld();
        currentSceneId = Entropy.generateUUID(); sceneName = "Untitled scene";
        spawnSurface([0, 1.5, 0], 0);
        history.commit();
        savedSceneState = null;
        pendingSceneAction = null;
        statusMessage = "New scene ? choose a name and save.";
    });
}

// A disposable drawing surface uses exactly the scene's brush, pressure and smoothing code.
let practiceSurface: Surface | null = null;
let practiceView: CameraView | null = null;
function togglePractice(): void {
    stopPreview();
    finishStroke(); resetGesture(); history.commit();
    if (practiceSurface) {
        Entropy.Model.clearMesh(practiceSurface.meshId);
        practiceSurface = null;
        for (const s of surfaces) if (s.visible) createSurfaceMesh(s);
        if (practiceView) applyView(practiceView);
        practiceView = null;
        statusMessage = "Back to scene";
    } else {
        const [position, direction] = Entropy.Camera.getTransform();
        const distance = Math.max(1, Math.hypot(...subV(position, orbitTarget)));
        practiceView = { position: [...position], target: addV(position, direction.map(n => n * distance) as Vec3) };
        const selected = activeSurfaceId;
        restoringHistory = true;
        practiceSurface = spawnSurface([0, 1.5, 0], 0);
        practiceSurface.name = "Practice pad (not saved)";
        surfaces.pop(); activeSurfaceId = selected;
        restoringHistory = false;
        for (const s of surfaces) if (s.visible) Entropy.Model.clearMesh(s.meshId);
        setMode("draw");
        applyView({ position: [0, 1.5, 6], target: [0, 1.5, 0] });
        statusMessage = "Practice pad ? your scene is unchanged.";
    }
    previewSurfaceId = null;
    textInputActive = false;
}

function loadPreferences(): void {
    try {
        const value = addon.GameState.load("CanvasSurfaces_BrushSettings") as { settings?: Partial<PaintSettings>; swatches?: RGB[]; recent?: RGB[] } | null;
        if (!value) return;
        const settings = value.settings ?? {};
        const number = (key: keyof PaintSettings, min: number, max: number) => {
            const v = settings[key];
            if (typeof v === "number" && Number.isFinite(v)) (paintSettings as unknown as Record<string, unknown>)[key] = Math.min(max, Math.max(min, v));
        };
        number("opacity", 0.01, 1); number("pressureMin", 0, 0.45); number("pressureMax", 0.55, 1);
        number("sizeCurve", 0.25, 3); number("opacityCurve", 0.25, 3); number("stabilization", 0, 1);
        for (const key of ["pressureSize", "pressureOpacity"] as const) if (typeof settings[key] === "boolean") paintSettings[key] = settings[key];
        const isColor = (color: unknown): color is RGB => Array.isArray(color) && color.length === 3 && color.every(n => Number.isFinite(n) && n >= 0 && n <= 255);
        if (isColor(settings.color)) paintSettings.color = [...settings.color];
        if (Array.isArray(value.swatches)) savedSwatches = value.swatches.filter(isColor).slice(0, 8);
        if (Array.isArray(value.recent)) recentColors = value.recent.filter(isColor).slice(0, 6);
    } catch { statusMessage = "Brush settings could not be loaded; using defaults."; }
}
let lastPreferencesSave = 0;
function savePreferences(): void {
    if (!preferencesDirty || pointerHeld || penHeld || Date.now() - lastPreferencesSave < 1000) return;
    lastPreferencesSave = Date.now();
    try {
        addon.GameState.save("CanvasSurfaces_BrushSettings", { settings: paintSettings, swatches: savedSwatches, recent: recentColors });
        preferencesDirty = false;
    } catch { statusMessage = "Brush settings could not be saved. Scene artwork is unchanged."; preferencesDirty = false; }
}

// --- Export GLB ------------------------------------------------------------------------------
//
// Builds one glTF mesh per VISIBLE surface directly from its already-cached world-space
// s.worldPatches (the same data raycastSurfaceMesh reads) - no separate export-specific mesh
// build path. See src/art_assets/GLBExporter.rs for the actual glTF/GLB assembly on the Rust
// side (this pipeline has no writer in the `gltf` crate, so it's hand-rolled there).
function exportSceneToGlb(): void {
    stopPreview();
    const visible = surfaces.filter(s => s.visible);
    if (visible.length === 0) {
        Entropy.println("[canvas-surfaces] nothing visible to export");
        return;
    }

    const meshes = visible.map(s => {
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        let base = 0;
        for (const patch of s.worldPatches) {
            for (let row = 0; row < patch.rows; row++) {
                for (let col = 0; col < patch.cols; col++) {
                    const [px, py, pz] = patch.verts[row][col];
                    const [nx, ny, nz] = patch.normals[row][col];
                    const { u, v } = patch.uv[row][col];
                    positions.push(px, py, pz);
                    normals.push(nx, ny, nz);
                    uvs.push(u, v);
                }
            }
            const rowStride = patch.cols;
            const [i0, i1, i2, i3, i4, i5] = patch.winding;
            for (let row = 0; row < patch.rows - 1; row++) {
                for (let col = 0; col < patch.cols - 1; col++) {
                    const a = base + row * rowStride + col, b = a + 1, c = a + rowStride, d = c + 1;
                    const corner = [a, b, c, d];
                    indices.push(corner[i0], corner[i1], corner[i2], corner[i3], corner[i4], corner[i5]);
                }
            }
            base += patch.rows * patch.cols;
        }
        return {
            name: s.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
            positions, normals, uvs, indices,
            textureRgba: s.canvas,
            textureWidth: CANVAS_RES,
            textureHeight: CANVAS_RES,
        };
    });

    const result = Entropy.Model.exportGlb(meshes, "canvas-surfaces-scene.glb");
    if (result.success) {
        Entropy.println(`[canvas-surfaces] exported GLB to ${result.path}`);
    } else {
        Entropy.println(`[canvas-surfaces] GLB export: ${result.error}`);
    }
}

// --- Setup ---------------------------------------------------------------------------------------

// Two fixed point lights (warm key + cool fill, classic two-point setup) baked directly into
// this shader as WGSL constants rather than a dynamic uniform buffer: the engine's real
// Entropy.Lighting.createPointLight system only ever reaches meshes drawn through the deferred
// G-buffer/lighting pass (pbr:true pipelines) - this pipeline is deliberately pbr:false/unlit
// (it just displays a painted texture as-is) and non-pbr custom meshes are drawn in a separate
// forward pass that's never given a lighting bind group at all (confirmed by reading
// render_addon_frame.rs's non-PBR mesh loop: only camera (group 0) and the addon's own
// extraBindGroups are bound). Doing simple per-fragment Lambertian shading by hand here, fully
// inside this one pipeline, gets real shadowing/depth without needing to plumb a new bind group
// through the engine's non-PBR render path for what two static lights don't require.
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

struct BrushPreview {
    center_radius: vec4<f32>,
    rotation_enabled: vec4<f32>,
};
@group(2) @binding(2)
var<uniform> brush_preview: BrushPreview;

// One shared buffer for the whole scene (canvas_lighting.ts packLighting writes it, same order).
struct Lighting {
    ambient: vec4<f32>,
    sun_dir: vec4<f32>,      // xyz points toward the sun
    sun_color: vec4<f32>,    // rgb, w = intensity
    sky_fill: vec4<f32>,     // rgb, w = fill strength
    ground_fill: vec4<f32>,
    fog: vec4<f32>,          // rgb, w = density
    lamp_pos: array<vec4<f32>, 4>,    // xyz, w = reach
    lamp_color: array<vec4<f32>, 4>,  // rgb, w = intensity (0 = off)
};
@group(2) @binding(3)
var<uniform> lighting: Lighting;

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
    @location(2) world_pos: vec3<f32>,
    @location(3) normal: vec3<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    // in.position is already world-space (this addon bakes every surface's transform directly
    // into its vertex positions - see pushSurfaceTransform's doc comment), so no model matrix
    // is needed here, just forward it for the fragment stage's lighting math.
    out.clip_position = camera.view_proj * vec4<f32>(in.position, 1.0);
    out.tex_coords = in.tex_coords;
    out.color = in.color;
    out.world_pos = in.position;
    out.normal = in.normal;
    return out;
}

fn point_light_diffuse(world_pos: vec3<f32>, n: vec3<f32>, pos_reach: vec4<f32>, color_intensity: vec4<f32>) -> vec3<f32> {
    let to_light = pos_reach.xyz - world_pos;
    let dist = length(to_light);
    let l = to_light / max(dist, 0.0001);
    let ndotl = max(dot(n, l), 0.0);
    // Distance is measured in units of reach; reach 1 is the original editor falloff.
    let d = dist / max(pos_reach.w, 0.1);
    let atten = 1.0 / (1.0 + 0.06 * d + 0.012 * d * d);
    return color_intensity.rgb * color_intensity.w * ndotl * atten;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let sampled = textureSample(surface_texture, surface_sampler, in.tex_coords);
    // The Cut tool (canvas_surface_addon.ts's floodFillCutAlpha) zeroes alpha inside a closed
    // shape once it's drawn - discard turns that into a real hole (whatever's behind the surface
    // shows through, depth-correct) rather than a blended/see-through-tinted color.
    if (sampled.a < 0.5) {
        discard;
    }
    let n = normalize(in.normal);
    var light = lighting.ambient.rgb;
    light += lighting.sun_color.rgb * lighting.sun_color.w * max(dot(n, normalize(lighting.sun_dir.xyz)), 0.0);
    light += mix(lighting.ground_fill.rgb, lighting.sky_fill.rgb, n.y * 0.5 + 0.5) * lighting.sky_fill.w;
    light += point_light_diffuse(in.world_pos, n, lighting.lamp_pos[0], lighting.lamp_color[0]);
    light += point_light_diffuse(in.world_pos, n, lighting.lamp_pos[1], lighting.lamp_color[1]);
    light += point_light_diffuse(in.world_pos, n, lighting.lamp_pos[2], lighting.lamp_color[2]);
    light += point_light_diffuse(in.world_pos, n, lighting.lamp_pos[3], lighting.lamp_color[3]);
    var lit_rgb = sampled.rgb * in.color.rgb * light;
    let fog_amount = 1.0 - exp(-lighting.fog.w * length(camera.view_pos.xyz - in.world_pos));
    lit_rgb = mix(lit_rgb, lighting.fog.rgb, clamp(fog_amount, 0.0, 1.0));
    let delta = in.tex_coords * 768.0 - brush_preview.center_radius.xy;
    let c = brush_preview.rotation_enabled.x;
    let s = brush_preview.rotation_enabled.y;
    let local = vec2<f32>(c * delta.x + s * delta.y, -s * delta.x + c * delta.y);
    let ellipse = length(local / max(brush_preview.center_radius.zw, vec2<f32>(0.01)));
    // Derivatives keep the outline legible at different zooms and on oblique surfaces.
    let edge = abs(ellipse - 1.0) / max(fwidth(ellipse), 0.0001);
    let enabled = brush_preview.rotation_enabled.z;
    lit_rgb = mix(lit_rgb, vec3<f32>(1.0), (1.0 - smoothstep(1.0, 2.5, edge)) * enabled);
    lit_rgb = mix(lit_rgb, vec3<f32>(0.04), (1.0 - smoothstep(0.0, 1.0, edge)) * enabled);
    return vec4<f32>(lit_rgb, sampled.a * in.color.a);
}
`;

let uiWindowId: string;
let layersWindowId: string;
let keyframeWindowId: string;

function setupUI(): void {
    uiWindowId = Entropy.UI.createWindow({
        title: "Canvas Surfaces",
        // 330 less the 12 px window margins and a 10 px scrollbar leaves 296 for the tab bar, which
        // is what the five tab labels need on one line (see tests/features/tab_bar.feature).
        width: 330,
        height: Math.max(420, Entropy.Window.getSize()[1] - 40),
        x: 16,
        y: 16,
        onRender: renderUI
    });
    layersWindowId = uiWindowId;
    // A second window rather than a widget stuffed into the first - a full-width timeline reads
    // far better than one squeezed into a 330px sidebar, and it needs to stay visible while the
    // sidebar's own Keyframes group (still the place to pick a channel and set a precise value)
    // is scrolled elsewhere.
    keyframeWindowId = Entropy.UI.createWindow({
        title: "Canvas workspace",
        width: Math.max(600, Entropy.Window.getSize()[0] - 390),
        height: 480,
        x: 362,
        y: Math.max(16, Entropy.Window.getSize()[1] - 505),
        onRender: renderKeyframeTimelineUI
    });
    Entropy.UI.setWindowVisible(keyframeWindowId, false);
}

/** A small editable creation that exercises the same data used by hand-authored scenes. */
function createAnimatedExample(withLogic = false): void {
    requestSceneAction("Open animated character example", () => {
        beginEdit("Animated character example");
        for (const s of [...surfaces]) deleteSurface(s);
        groups = []; clips = []; markedNodes.clear(); selectedStrokeId = null;
        logic = emptyLogic(); resetWorld();
        currentSceneId = Entropy.generateUUID(); sceneName = "Drawn character";
        const character: Group = { ...defaultTransform(), id: Entropy.generateUUID(), name: "Character", parentId: null, frame: identity(), pivot: [0, 1.5, 0] };
        const arm: Group = { ...defaultTransform(), id: Entropy.generateUUID(), name: "Waving arm", parentId: character.id, frame: identity(), pivot: [0.65, 2.05, 0] };
        groups.push(character, arm);
        const part = (name: string, position: Vec3, halfW: number, halfH: number, color: RGB, parentId = character.id, kind: ShapeKind = "box") => {
            const surface = spawnSurface(position, 0, kind, halfW, halfH, 0.25, 1, { name, parentId });
            const pixels = surface.layers[0].pixels;
            for (let i = 0; i < pixels.length; i += 4) pixels.set([...color, 255], i);
            composeSurface(surface); return surface;
        };
        part("Shirt", [0, 1.6, 0], 0.55, 0.65, [74, 130, 154]);
        const face = part("Face", [0, 2.65, 0.3], 0.55, 0.5, [250, 228, 193], character.id, "plane");
        part("Waving hand", [0.8, 1.6, 0], 0.2, 0.55, [250, 228, 193], arm.id);
        part("Other hand", [-0.8, 1.6, 0], 0.2, 0.55, [250, 228, 193]);
        part("Left leg", [-0.28, 0.45, 0], 0.22, 0.45, [57, 69, 95]);
        part("Right leg", [0.28, 0.45, 0], 0.22, 0.45, [57, 69, 95]);
        const layer = face.layers[0]; face.bases = { [layer.id]: layer.pixels.slice() };
        const draw = (name: string, points: [number, number][]) => {
            const stroke: RetainedStroke = { id: Entropy.generateUUID(), name, layerId: layer.id, visible: true, progress: 1, brush: { color: [35, 30, 35], softness: 0.1, isEraser: false }, stamps: points.map(([x, y]) => ({ x, y, radius: 7, alpha: 1, angle: 0, elongation: 0 })) };
            face.strokes = [...face.strokes, stroke]; return stroke;
        };
        for (const x of [255, 510]) draw("Eye", Array.from({ length: 20 }, (_, i) => [x, 255 + i * 2]));
        const smile = draw("Smile", Array.from({ length: 151 }, (_, i) => { const t = i / 150; return [220 + t * 328, 445 + Math.sin(t * Math.PI) * 100]; }));
        replayArtwork(face);
        const clip: Clip = { id: Entropy.generateUUID(), name: "Wave and smile", duration: 2, tracks: [] };
        for (const [time, value] of [[0, 0], [0.5, 2.3], [1, 1.7], [1.5, 2.3], [2, 0]]) setKey(clip, arm.id, "roll", time, value);
        setKey(clip, smile.id, "progress", 0, 0); setKey(clip, smile.id, "progress", 1, 1);
        clips = [clip]; selectedClipId = clip.id; activeGroupId = character.id; activeSurfaceId = face.id; playhead = 0;
        if (withLogic) {
            const start = logicNode("demo-start", "start", [20, 20]);
            const welcome = { ...logicNode("demo-welcome", "message", [240, 20]), text: "Click my face to say hello!" };
            const click = { ...logicNode("demo-click", "click", [20, 150]), target: face.id };
            const once = logicNode("demo-once", "once", [240, 150]);
            const wave = { ...logicNode("demo-wave", "clip", [460, 150]), target: clip.id };
            const wait = { ...logicNode("demo-wait", "wait", [680, 150]), seconds: 2 };
            const message = { ...logicNode("demo-message", "message", [680, 20]), text: "Hello, friend! Stop and Play to try again." };
            logic = { nodes: [start, welcome, click, once, wave, wait, message], connections: [[start, welcome], [click, once], [once, wave], [wave, wait], [wait, message]].map(([a, b]) => ({ fromNode: a.id, fromPin: "next", toNode: b.id, toPin: "in" })) };
            showWorkspace("logic");
        }
        history.commit(); savedSceneState = null; pendingSceneAction = null;
        applyView({ position: [0, 2.0, 8], target: [0, 1.7, 0] });
        statusMessage = withLogic ? "Example ready. Open Logic or press Play." : "Example ready. Preview a clip or edit a part.";
    });
}

function createPlayableExample(): void { createAnimatedExample(true); }

let parentChoice: string | null = null;
let channelChoice: Channel = "roll";
let keyValue = 0;
const markedNodes = new Set<string>();
const collapsedGroups = new Set<string>();
function selectedNode(): Group | Surface | undefined { return activeGroupId ? groups.find(g => g.id === activeGroupId) : activeSurface() ?? undefined; }
function findTargetName(targetId: string): string {
    const group = groups.find(g => g.id === targetId); if (group) return group.name;
    const surface = surfaces.find(s => s.id === targetId); if (surface) return surface.name;
    for (const s of surfaces) { const stroke = s.strokes.find(st => st.id === targetId); if (stroke) return stroke.name; }
    return "?";
}
/** Shared by the hierarchy tree's row click and the keyframe timeline window's row click - a
 * target id is a group, a surface, or (for a progress/visible track) an individual stroke, and
 * whichever it is should end up selected the same way regardless of which widget it came from. */
function selectTreeTarget(id: string): void {
    const isGroup = groups.some(g => g.id === id);
    if (isGroup) { activeGroupId = id; selectedStrokeId = null; if (activeGizmoId) { Entropy.Gizmo.hide(activeGizmoId); activeGizmoId = null; } return; }
    const surface = surfaces.find(s => s.id === id);
    if (surface) { selectSurface(surface); return; }
    for (const s of surfaces) {
        const stroke = s.strokes.find(st => st.id === id);
        if (stroke) { selectSurface(s); selectedStrokeId = stroke.id; channelChoice = "progress"; keyValue = stroke.progress; return; }
    }
}
function parentNode(node: Group | Surface, parent: string | null): void {
    const frame = reparentFrame(groups, node.id, node.parentId, parent, node.frame);
    node.frame = frame; node.parentId = parent;
}
function makeGroup(): void {
    beginEdit("Group selection");
    const nodes = [...groups, ...surfaces].filter(n => markedNodes.size ? markedNodes.has(n.id) : n.id === selectedNode()?.id);
    // If a parent is selected, its descendants already belong to the new group through it.
    const roots = nodes.filter(n => {
        let parent = n.parentId;
        while (parent) { if (nodes.some(other => other.id === parent)) return false; parent = groups.find(g => g.id === parent)?.parentId ?? null; }
        return true;
    });
    const group: Group = { id: Entropy.generateUUID(), name: `Group ${groups.length + 1}`, parentId: null, frame: identity(), ...defaultTransform() };
    const centers = roots.map(n => "yaw" in n ? point(surfaceMatrix(n), [0, 0, 0]) : point(groupWorld(groups, n.id), n.pivot));
    if (centers.length) group.pivot = [0, 1, 2].map(i => centers.reduce((sum, c) => sum + c[i], 0) / centers.length) as Vec3;
    groups.push(group);
    for (const node of roots) parentNode(node, group.id);
    activeGroupId = group.id; markedNodes.clear(); refreshGeometry();
}
function removeGroup(group: Group): void {
    beginEdit("Ungroup");
    for (const node of [...groups, ...surfaces]) if (node.parentId === group.id) parentNode(node, group.parentId);
    groups = groups.filter(g => g !== group);
    for (const clip of clips) clip.tracks = clip.tracks.filter(t => t.targetId !== group.id);
    activeGroupId = null; refreshGeometry();
}
// Structurally matches addon.d.ts's TreeNodeConfig (that .d.ts's `export interface`s aren't
// ambiently visible here the way the global `Entropy` var itself is, so this is a local mirror
// rather than an import - TS only needs the shape to match, not the same named type).
type HierarchyRow = { id: string; label: string; depth: number; hasChildren: boolean; expanded: boolean; marked: boolean; selected: boolean };

/** Flattens the group/surface forest into the already-depth-computed row list `Widget.treeView`
 * expects, skipping the contents of any collapsed group entirely (the widget has no hierarchy
 * or collapsed-state knowledge of its own - see `entropy_gui::widgets_tree`'s doc comment). */
function buildHierarchyRows(parent: string | null, depth: number, rows: HierarchyRow[]): void {
    for (const node of [...groups, ...surfaces].filter(n => n.parentId === parent)) {
        const isGroup = groups.some(g => g.id === node.id);
        const hasChildren = isGroup && [...groups, ...surfaces].some(n => n.parentId === node.id);
        rows.push({
            id: node.id, label: node.name, depth, hasChildren,
            expanded: !collapsedGroups.has(node.id), marked: markedNodes.has(node.id),
            selected: selectedNode()?.id === node.id,
        });
        if (hasChildren && !collapsedGroups.has(node.id)) buildHierarchyRows(node.id, depth + 1, rows);
    }
}

function renderAnimationUI(): void {
    const W = Entropy.UI.Widget;
    const button = (id: string, text: string, onClick: () => void) => W.button(uiWindowId, { id, text, onClick });
    const slider = (id: string, label: string, value: number, min: number, max: number, change: (value: number) => void) => W.slider(uiWindowId, { id, label, value, min, max, onChange: value => { const n = Number(value); if (Number.isFinite(n)) change(Math.max(min, Math.min(max, n))); } });

    W.label(uiWindowId, { text: preview ? "Previewing. Return to the editing pose to draw." : "Click a part to select it. Check Mark to build a multi-part group." });
    button("animation_stop", "Return to Editing Pose", stopPreview);

    W.label(uiWindowId, { text: "Hierarchy", bold: true });
    const hierarchyRows: HierarchyRow[] = [];
    buildHierarchyRows(null, 0, hierarchyRows);
    W.group(uiWindowId, () => {
        W.treeView(uiWindowId, {
            id: "hierarchy_tree", nodes: hierarchyRows,
            onSelect: selectTreeTarget,
            onToggleExpand: id => { if (collapsedGroups.has(id)) collapsedGroups.delete(id); else collapsedGroups.add(id); },
            onMark: (id, value) => { if (value) markedNodes.add(id); else markedNodes.delete(id); },
        });
    });
    W.horizontal(uiWindowId, () => {
        button("group_create", "Group Selected", makeGroup);
        button("animated_example", "Load Example", createAnimatedExample);
    });

    const node = selectedNode();
    if (node) {
        W.separator(uiWindowId);
        W.label(uiWindowId, { text: `Selected: ${node.name} (${activeGroupId ? "Group" : "Part"})`, bold: true });
        W.textInput(uiWindowId, { label: "Rename", id: "node_name", value: node.name, onChange: value => { beginEdit("Rename part"); node.name = String(value).slice(0, 80); } });
        W.horizontal(uiWindowId, () => {
            button("parent_choice", `Parent: ${groups.find(g => g.id === parentChoice)?.name ?? "World"}`, () => {
                const options = [null, ...groups.filter(g => g.id !== node.id).map(g => g.id)]; parentChoice = options[(options.indexOf(parentChoice) + 1) % options.length];
            });
            button("parent_apply", "Attach", () => {
                try { const frame = reparentFrame(groups, node.id, node.parentId, parentChoice, node.frame); beginEdit("Reparent part"); node.frame = frame; node.parentId = parentChoice; refreshGeometry(); }
                catch (error) { statusMessage = String(error); }
            });
        });
        if (activeGroupId) button("group_remove", "Ungroup (Keep Parts)", () => removeGroup(node as Group));

        const transform = "yaw" in node ? surfaceTransform(node) : node;
        W.collapsingHeader(uiWindowId, "Transform & Pivot", () => {
            const axisRow = (title: string, idPrefix: string, min: number, max: number, get: (axis: number) => number, set: (axis: number, value: number) => void) => {
                W.group(uiWindowId, () => {
                    W.label(uiWindowId, { text: title, bold: true });
                    for (const [index, axis] of ["x", "y", "z"].entries()) slider(`${idPrefix}_${axis}`, axis.toUpperCase(), get(index), min, max, value => set(index, value));
                });
            };
            axisRow("Position", "node_pos", -20, 20, index => transform.position[index], (index, value) => { beginEdit("Move part"); node.position[index] = value; refreshGeometry(); });
            axisRow("Rotation (radians)", "node_rotation", -Math.PI, Math.PI, index => transform.rotation[index], (index, value) => {
                beginEdit("Rotate part");
                if ("yaw" in node) { if (index === 0) node.pitch = value; if (index === 1) node.yaw = value; if (index === 2) node.roll = value; }
                else node.rotation[index] = value;
                refreshGeometry();
            });
            axisRow("Scale", "node_scale", 0.05, 5, index => transform.scale[index], (index, value) => { beginEdit("Scale part"); node.scale[index] = value; refreshGeometry(); });
            axisRow("Pivot Offset", "node_pivot", -20, 20, index => transform.pivot[index], (index, value) => {
                beginEdit("Set pivot");
                const before = transformMatrix("yaw" in node ? surfaceTransform(node) : node);
                node.pivot[index] = value;
                const after = transformMatrix("yaw" in node ? surfaceTransform(node) : node);
                for (let i = 0; i < 3; i++) node.position[i] += before[i * 4 + 3] - after[i * 4 + 3];
                refreshGeometry();
            });
        });
    }

    const surface = !activeGroupId ? activeSurface() : null;
    if (surface && surface.strokes.length) {
        W.separator(uiWindowId);
        W.label(uiWindowId, { text: "Strokes", bold: true });
        W.group(uiWindowId, () => {
            for (const stroke of surface.strokes) button(`stroke_${stroke.id}`, `${selectedStrokeId === stroke.id ? "> " : ""}${stroke.name}`, () => { selectedStrokeId = stroke.id; channelChoice = "progress"; keyValue = stroke.progress; });
        });
    }
    const stroke = surface?.strokes.find(st => st.id === selectedStrokeId);
    if (stroke && surface) {
        const editStroke = (change: Partial<RetainedStroke>) => { beginEdit("Edit stroke"); surface.strokes = surface.strokes.map(st => st.id === stroke.id ? { ...st, ...change } : st); replayArtwork(surface); };
        W.group(uiWindowId, () => {
            W.textInput(uiWindowId, { label: "Stroke name", id: "stroke_name", value: stroke.name, onChange: value => editStroke({ name: String(value).slice(0, 80) }) });
            button("stroke_visible", stroke.visible ? "Hide Stroke" : "Show Stroke", () => editStroke({ visible: !stroke.visible }));
            slider("stroke_progress", "Drawing Progress", stroke.progress, 0, 1, value => editStroke({ progress: value }));
        });
    }

    W.separator(uiWindowId);
    W.label(uiWindowId, { text: "Clips", bold: true });
    W.group(uiWindowId, () => {
        button("clip_create", "+ New Clip", () => {
            showWorkspace("animation");
            beginEdit("New animation"); let number = 1; while (clips.some(c => c.name === `Clip ${number}`)) number++; const clip: Clip = { id: Entropy.generateUUID(), name: `Clip ${number}`, duration: 2, tracks: [] }; clips.push(clip); selectedClipId = clip.id; playhead = 0;
        });
        for (const clip of clips) button(`clip_${clip.id}`, `${clip.id === selectedClipId ? "> " : ""}${clip.name}`, () => { stopPreview(); selectedClipId = clip.id; playhead = 0; });
    });
    const clip = currentClip();
    if (!clip) return;
    W.group(uiWindowId, () => {
        W.textInput(uiWindowId, { label: "Clip name", id: "clip_name", value: clip.name, onChange: value => {
            const name = String(value).trim().slice(0, 80); if (!name || clips.some(c => c !== clip && c.name === name)) return;
            beginEdit("Rename clip"); clip.name = name;
        } });
        slider("clip_duration", "Duration (seconds)", clip.duration, 0.1, 30, value => { beginEdit("Clip duration"); clip.duration = Math.max(value, ...clip.tracks.flatMap(t => t.keys.map(k => k.time))); playhead = Math.min(playhead, clip.duration); });
        button("clip_delete", "Delete Clip", () => { beginEdit("Delete clip"); clips = clips.filter(c => c !== clip); selectedClipId = clips[0]?.id ?? null; });
    });

    W.label(uiWindowId, { text: "Playback", bold: true });
    W.group(uiWindowId, () => {
        slider("clip_time", "Time (seconds)", playhead, 0, clip.duration, value => { playing = false; previewAt(value); });
        button("clip_play", playing ? "Pause preview" : "Preview clip", () => { if (playing) { playing = false; previousTime = null; } else { previewAt(playhead >= clip.duration ? 0 : playhead); playing = true; previousTime = null; } });
    });

    W.label(uiWindowId, { text: "Keyframes", bold: true });
    W.group(uiWindowId, () => {
        const targetId = stroke?.id ?? node?.id;
        W.label(uiWindowId, { text: `Keying: ${stroke?.name ?? node?.name ?? "Select a part or group above"}` });
        const channels: Channel[] = stroke ? ["progress", "visible"] : ["x", "y", "z", "pitch", "yaw", "roll", "sx", "sy", "sz"];
        if (!channels.includes(channelChoice)) channelChoice = channels[0];
        button("key_channel", `Channel: ${channelChoice}`, () => { channelChoice = channels[(channels.indexOf(channelChoice) + 1) % channels.length]; });
        const bounded = channelChoice === "progress" || channelChoice === "visible";
        slider("key_value", "Key Value", keyValue, bounded ? 0 : channelChoice.startsWith("s") ? 0.05 : -20, bounded ? 1 : 20, value => { keyValue = value; });
        W.horizontal(uiWindowId, () => {
            button("key_add", "Set Key Here", () => {
                if (!targetId) return;
                const time = playhead; beginEdit("Set animation key");
                setKey(clip, targetId, channelChoice, time, bounded ? Math.max(0, Math.min(1, keyValue)) : channelChoice.startsWith("s") ? Math.max(0.05, keyValue) : keyValue);
                previewAt(time);
            });
            button("key_current", "Key Current Pose", () => {
                if (!targetId) return;
                const t = node && ("yaw" in node ? surfaceTransform(node) : node);
                const values: Partial<Record<Channel, number>> = stroke ? { progress: stroke.progress, visible: stroke.visible ? 1 : 0 } : t ? {
                    x: t.position[0], y: t.position[1], z: t.position[2], pitch: t.rotation[0], yaw: t.rotation[1], roll: t.rotation[2], sx: t.scale[0], sy: t.scale[1], sz: t.scale[2],
                } : {};
                const value = values[channelChoice]; if (value === undefined) return;
                const time = playhead; beginEdit("Key editing pose"); setKey(clip, targetId, channelChoice, time, value); keyValue = value; previewAt(time);
            });
        });
        W.label(uiWindowId, { text: clip.tracks.length ? "See the Keyframes window for this clip's full timeline." : "No keys yet - set one above to start this clip's timeline." });
    });
}

/** `rowId` packs a track's (targetId, channel) into one string `Widget.keyframeTimeline` can
 * hand back unchanged on every callback - targetIds are UUIDs (never contain "::") and channel
 * names are a fixed lowercase set, so a plain separator is unambiguous to split back apart. */
function keyframeRowId(targetId: string, channel: Channel): string { return `${targetId}::${channel}`; }
function parseKeyframeRowId(rowId: string): [string, Channel] {
    const sep = rowId.lastIndexOf("::");
    return [rowId.slice(0, sep), rowId.slice(sep + 2) as Channel];
}

/** A real dopesheet for the clip currently selected in the Animate tab, in its own window -
 * every existing track shown as a row, not just whichever part happens to be selected right now.
 * `entropy_gui::KeyframeTimeline` only knows a keyframe's time, not its value (see the widget's
 * own `KeyframeConfig`), so precise value entry stays in the sidebar's Keyframes group; this
 * window is the shared-timeline view and the seek/move/add/delete surface. */
function renderKeyframeTimelineUI(): void {
    if (gameSession || !workspaceVisible) return;
    Entropy.UI.Widget.button(keyframeWindowId, { id: "workspace_close", text: "Return to canvas", onClick: () => { workspaceVisible = false; Entropy.UI.setWindowVisible(keyframeWindowId, false); } });
    if (workspace === "logic") {
        renderLogicEditor(keyframeWindowId, logic, [...surfaces.map(s => ({ id: s.id, name: s.name })), ...groups.map(g => ({ id: g.id, name: `${g.name} (group)` }))], clips, change => { beginEdit("Edit gameplay logic"); change(); }, activeSurfaceId);
        return;
    }
    const W = Entropy.UI.Widget;
    const clip = currentClip();
    if (!clip) { W.label(keyframeWindowId, { text: "No clip selected. Create or select one in the Canvas Surfaces window's Animate tab." }); return; }
    if (!clip.tracks.length) { W.label(keyframeWindowId, { text: `${clip.name}: no keyframes yet. Set one in the Animate tab to see it here.` }); return; }

    W.keyframeTimeline(keyframeWindowId, {
        id: "clip_keyframe_timeline",
        durationMs: Math.max(1, Math.round(clip.duration * 1000)),
        playheadMs: Math.round(playhead * 1000),
        rows: clip.tracks.map(track => ({
            id: keyframeRowId(track.targetId, track.channel),
            label: `${findTargetName(track.targetId)} · ${track.channel}`,
            keyframes: track.keys.map(key => ({ id: String(key.time), timeMs: Math.round(key.time * 1000) })),
        })),
        onSeek: timeMs => { playing = false; previewAt(timeMs / 1000); },
        onKeyframeSelected: (rowId, keyframeId) => {
            const [targetId, channel] = parseKeyframeRowId(rowId);
            const track = clip.tracks.find(t => t.targetId === targetId && t.channel === channel);
            const key = track?.keys.find(k => String(k.time) === keyframeId);
            playing = false; previewAt(Number(keyframeId)); channelChoice = channel;
            if (key) keyValue = key.value;
            selectTreeTarget(targetId);
        },
        onKeyframeMoved: (rowId, keyframeId, timeMs) => {
            const [targetId, channel] = parseKeyframeRowId(rowId);
            const track = clip.tracks.find(t => t.targetId === targetId && t.channel === channel);
            const key = track?.keys.find(k => String(k.time) === keyframeId);
            if (!track || !key) return;
            beginEdit("Move key");
            const time = Math.max(0, Math.min(clip.duration, timeMs / 1000)), value = key.value;
            track.keys = track.keys.filter(k => k !== key);
            setKey(clip, targetId, channel, time, value);
            previewAt(playhead);
        },
        // Fired on a double-click on a row's timeline - seeds the new key from the track's own
        // interpolated value at that time, so dropping one mid-clip doesn't introduce a jump.
        onKeyframeAdd: (rowId, timeMs) => {
            const [targetId, channel] = parseKeyframeRowId(rowId);
            const track = clip.tracks.find(t => t.targetId === targetId && t.channel === channel);
            if (!track) return;
            const time = Math.max(0, Math.min(clip.duration, timeMs / 1000));
            beginEdit("Set animation key"); setKey(clip, targetId, channel, time, sample(track, time)); previewAt(time);
        },
        onKeyframeDelete: (rowId, keyframeId) => {
            const [targetId, channel] = parseKeyframeRowId(rowId);
            const track = clip.tracks.find(t => t.targetId === targetId && t.channel === channel);
            if (!track) return;
            beginEdit("Delete key");
            track.keys = track.keys.filter(k => String(k.time) !== keyframeId);
            clip.tracks = clip.tracks.filter(t => t.keys.length);
        },
        onRowClicked: rowId => selectTreeTarget(parseKeyframeRowId(rowId)[0]),
    });
}

function renderLayersUI(): void {
    if (surfaces.length === 0) {
        Entropy.UI.Widget.label(layersWindowId, { text: "None yet - add one above." });
        return;
    }

    // One row per surface: the name selects it, the other two act on it.
    for (const s of surfaces) {
        const isActive = s.id === activeSurfaceId;
        Entropy.UI.Widget.horizontal(layersWindowId, () => {
            Entropy.UI.Widget.button(layersWindowId, {
                text: (isActive ? "> " : "  ") + s.name + (s.visible ? "" : " (hidden)"),
                id: `layer_select_${s.id}`,
                onClick: () => selectSurface(s)
            });
            Entropy.UI.Widget.button(layersWindowId, {
                text: s.visible ? "Hide" : "Show",
                id: `layer_toggle_${s.id}`,
                onClick: () => setSurfaceVisible(s, !s.visible)
            });
            Entropy.UI.Widget.button(layersWindowId, {
                text: "Delete",
                id: `layer_delete_${s.id}`,
                onClick: () => deleteSurface(s)
            });
        });
    }
}

function renderPaintLayers(): void {
    const s = activeSurface();
    if (!s) return;
    Entropy.UI.Widget.label(uiWindowId, { text: `${s.name} ? top layer first` });
    Entropy.UI.Widget.horizontal(uiWindowId, () => {
        for (const name of ["Sketch", "Ink", "Color"]) Entropy.UI.Widget.button(uiWindowId, {
            text: `+ ${name}`, id: `paint_add_${name.toLowerCase()}`,
            onClick: () => {
                if (s.layers.length >= 16) { statusMessage = "Maximum 16 layers per surface."; return; }
                changeLayer(s, "Add paint layer", () => {
                    const layer = newPaintLayer(name); s.layers.push(layer); s.activeLayerId = layer.id;
                });
            },
        });
    });
    for (const layer of [...s.layers].reverse()) {
        Entropy.UI.Widget.horizontal(uiWindowId, () => {
            Entropy.UI.Widget.button(uiWindowId, { text: `${s.activeLayerId === layer.id ? "> " : ""}${layer.name}`, id: `paint_select_${layer.id}`, onClick: () => { s.activeLayerId = layer.id; } });
            Entropy.UI.Widget.button(uiWindowId, { text: layer.visible ? "Hide" : "Show", id: `paint_visible_${layer.id}`, onClick: () => changeLayer(s, "Layer visibility", () => { layer.visible = !layer.visible; }) });
            Entropy.UI.Widget.button(uiWindowId, { text: layer.locked ? "Unlock" : "Lock", id: `paint_lock_${layer.id}`, onClick: () => changeLayer(s, "Layer lock", () => { layer.locked = !layer.locked; }) });
        });
    }
    const layer = s.layers.find(layer => layer.id === s.activeLayerId)!;
    Entropy.UI.Widget.textInput(uiWindowId, { label: "Layer name", value: layer.name, id: "paint_layer_name", onChange: value => {
        if (typeof value !== "string") return;
        changeLayer(s, "Rename layer", () => { layer.name = value.slice(0, 40); });
    } });
    Entropy.UI.Widget.slider(uiWindowId, { label: "Layer opacity", value: layer.opacity, min: 0, max: 1, id: "paint_layer_opacity", onChange: value => changeLayer(s, "Layer opacity", () => { layer.opacity = Number(value); }) });
    Entropy.UI.Widget.horizontal(uiWindowId, () => {
        for (const [label, delta] of [["Up", 1], ["Down", -1]] as const) Entropy.UI.Widget.button(uiWindowId, {
            text: label, id: `paint_layer_${label.toLowerCase()}`, onClick: () => {
                const index = s.layers.indexOf(layer), next = index + delta;
                if (next < 0 || next >= s.layers.length) return;
                changeLayer(s, "Reorder layers", () => { s.layers.splice(index, 1); s.layers.splice(next, 0, layer); });
            },
        });
        Entropy.UI.Widget.button(uiWindowId, { text: "Delete layer", id: "paint_layer_delete", onClick: () => {
            if (s.layers.length === 1) { statusMessage = "Keep at least one paint layer."; return; }
            changeLayer(s, "Delete paint layer", () => {
                const removed = s.strokes.filter(st => st.layerId === layer.id).map(st => st.id);
                s.strokes = s.strokes.filter(st => st.layerId !== layer.id);
                s.bases = Object.fromEntries(Object.entries(s.bases).filter(([id]) => id !== layer.id));
                for (const clip of clips) clip.tracks = clip.tracks.filter(t => !removed.includes(t.targetId));
                s.layers = s.layers.filter(l => l !== layer); s.activeLayerId = s.layers.at(-1)!.id; });
        } });
    });
}

function renderBrushTuning(): void {
    Entropy.UI.Widget.button(uiWindowId, { text: practiceSurface ? "Back to scene" : "Open practice pad", id: "practice_toggle", onClick: togglePractice });
    if (practiceSurface) Entropy.UI.Widget.button(uiWindowId, { text: "Clear practice pad", id: "practice_clear", onClick: () => {
        practiceSurface!.strokes = []; practiceSurface!.bases = {};
        practiceSurface!.layers = [newPaintLayer("Ink")];
        practiceSurface!.activeLayerId = practiceSurface!.layers[0].id;
        composeSurface(practiceSurface!);
    } });
    Entropy.UI.Widget.label(uiWindowId, { text: `Pen pressure: ${lastStylusReading.pressure.toFixed(2)}` });
    Entropy.UI.Widget.label(uiWindowId, { text: `Size response: ${pressureResponse(lastStylusReading.pressure, paintSettings, "size").toFixed(2)} | Opacity: ${pressureResponse(lastStylusReading.pressure, paintSettings, "opacity").toFixed(2)}` });
    for (const [label, key] of [["Pressure ? size", "pressureSize"], ["Pressure ? opacity", "pressureOpacity"]] as const)
        Entropy.UI.Widget.button(uiWindowId, { text: `${label}: ${paintSettings[key] ? "On" : "Off"}`, id: key, onClick: () => { paintSettings[key] = !paintSettings[key]; preferencesDirty = true; } });
    for (const [label, key, min, max] of [
        ["Light pressure", "pressureMin", 0, 0.45], ["Firm pressure", "pressureMax", 0.55, 1],
        ["Size curve", "sizeCurve", 0.25, 3], ["Opacity curve", "opacityCurve", 0.25, 3],
        ["Stabilization", "stabilization", 0, 1],
    ] as const) Entropy.UI.Widget.slider(uiWindowId, {
        label, value: paintSettings[key], min, max, id: `tuning_${key}`,
        onChange: value => { paintSettings[key] = Number(value); preferencesDirty = true; },
    });
    Entropy.UI.Widget.label(uiWindowId, { text: "Curve < 1: softer touch; > 1: firmer" });
    Entropy.UI.Widget.label(uiWindowId, { text: paintSettings.stabilization === 0 ? "Stabilization off ? direct pen movement" : "Steady stroke; tail finishes on release" });
    Entropy.UI.Widget.button(uiWindowId, { text: "Reset tablet tuning", id: "tuning_reset", onClick: () => {
        paintSettings = { ...DEFAULT_PAINT_SETTINGS, color: paintSettings.color, opacity: paintSettings.opacity };
        preferencesDirty = true;
    } });
}

function renderPalette(): void {
    const colors = (label: string, list: RGB[], prefix: string) => {
        Entropy.UI.Widget.label(uiWindowId, { text: label });
        for (let offset = 0; offset < list.length; offset += 3) Entropy.UI.Widget.horizontal(uiWindowId, () => {
            list.slice(offset, offset + 3).forEach((color, index) => Entropy.UI.Widget.button(uiWindowId, {
                text: "#" + color.map(n => n.toString(16).padStart(2, "0")).join(""), id: `${prefix}_${offset + index}`,
                onClick: () => chooseColor(color),
            }));
        });
    };
    colors("Saved colors", savedSwatches, "swatch");
    Entropy.UI.Widget.button(uiWindowId, { text: "Save current color", id: "save_swatch", onClick: () => {
        const color = [...paintSettings.color] as RGB;
        if (!savedSwatches.some(c => c.every((n, i) => n === color[i]))) savedSwatches = [...savedSwatches, color].slice(-8);
        preferencesDirty = true;
    } });
    colors("Recent colors", recentColors, "recent_color");
}

function renderSceneLibrary(): void {
    Entropy.UI.Widget.textInput(uiWindowId, { label: "Scene name", value: sceneName, id: "scene_name", onChange: value => {
        if (typeof value !== "string") return;
        beginEdit("Scene name"); sceneName = value.slice(0, 80);
    } });
    Entropy.UI.Widget.horizontal(uiWindowId, () => {
        Entropy.UI.Widget.button(uiWindowId, { text: "Save", id: "save_scene", onClick: () => { saveScene(); } });
        Entropy.UI.Widget.button(uiWindowId, { text: "Save as new", id: "save_scene_as", onClick: () => { saveScene(true); } });
        Entropy.UI.Widget.button(uiWindowId, { text: "New", id: "new_scene", onClick: newScene });
    });
    for (const entry of sceneLibrary.entries) Entropy.UI.Widget.button(uiWindowId, {
        text: `${entry.id === selectedSceneId ? "> " : ""}${entry.name}`, id: `scene_select_${entry.id}`,
        onClick: () => { selectedSceneId = entry.id; },
    });
    Entropy.UI.Widget.horizontal(uiWindowId, () => {
        Entropy.UI.Widget.button(uiWindowId, { text: "Load selected", id: "load_scene", onClick: loadScene });
        Entropy.UI.Widget.button(uiWindowId, { text: "Export GLB", id: "export_glb", onClick: exportSceneToGlb });
    });
    Entropy.UI.Widget.label(uiWindowId, { text: "Save as new needs a different name." });
}

function addSurfaceFromPalette(): void {
    // The first surface already occupies slot 1; start the stagger one slot ahead.
    const n = surfaces.length + 1;
    spawnSurface([(n % 3) * 3.5 - 3.5, 1.5, -Math.floor(n / 3) * 3.0], 0, pendingKind,
        pendingWidth / 2, pendingHeight / 2, pendingDepth / 2, pendingRadius);
}

type PanelTab = "tool" | "surfaces" | "animate" | "scene" | "help";
const PANEL_TABS: { id: PanelTab; label: string }[] = [
    { id: "tool", label: "Tool" }, { id: "surfaces", label: "Surfaces" }, { id: "animate", label: "Animate" },
    { id: "scene", label: "Scene" }, { id: "help", label: "Help" },
];
/** Which page of the sidebar is showing. UI-only state: never saved, never in undo history. */
let panelTab: PanelTab = "tool";

/** What stays visible on every tab: play, the two workspace windows, the scene's name and status,
 * undo, and the tool mode (which changes what the viewport does, so it must not hide behind a
 * tab). Everything else is on a page of the tab bar underneath. */
function renderUI(): void {
    const W = Entropy.UI.Widget;
    W.horizontal(uiWindowId, () => {
        W.button(uiWindowId, { id: "game_play", text: gameSession ? "Stop" : "Play", onClick: () => gameSession ? stopGame() : startGame() });
        if (!gameSession) {
            // "Timeline" not "Animate": the Animate tab authors clips, this opens the dopesheet window.
            W.button(uiWindowId, { id: "workspace_logic", text: workspaceVisible && workspace === "logic" ? "> Logic" : "Logic", onClick: () => showWorkspace("logic") });
            W.button(uiWindowId, { id: "workspace_animation", text: workspaceVisible && workspace === "animation" ? "> Timeline" : "Timeline", onClick: () => showWorkspace("animation") });
        }
    });
    if (gameSession) {
        W.label(uiWindowId, { text: sceneName, bold: true });
        W.label(uiWindowId, { text: gameRun?.message ?? "", bold: true });
        const counters = [...gameSession.vars].filter(([, v]) => v !== 0).map(([name, v]) => `${name}: ${v}`);
        if (counters.length) W.label(uiWindowId, { text: counters.join("   ") });
        const prompt = gameRun?.prompt();
        if (prompt) W.label(uiWindowId, { text: `[E] ${prompt}`, bold: true });
        W.label(uiWindowId, { text: gameRun?.hasPlayer ? "WASD walk | E interact | Q R turn | wheel zoom" : "Click surfaces to interact." });
        W.label(uiWindowId, { text: "Esc or Stop returns to editing." });
        return;
    }
    W.label(uiWindowId, { text: practiceSurface ? "PRACTICE - not saved" : `${sceneName}${sceneIsDirty() ? " *" : ""}`, bold: true });
    if (statusMessage) W.label(uiWindowId, { text: statusMessage });
    if (pendingSceneAction) {
        W.label(uiWindowId, { text: `${pendingSceneAction.label}? Unsaved changes.` });
        W.button(uiWindowId, { text: "Save & continue", id: "scene_confirm_save", onClick: () => { if (saveScene()) pendingSceneAction?.run(); } });
        W.horizontal(uiWindowId, () => {
            W.button(uiWindowId, { text: "Discard & continue", id: "scene_confirm_discard", onClick: () => pendingSceneAction?.run() });
            W.button(uiWindowId, { text: "Cancel", id: "scene_confirm_cancel", onClick: () => { pendingSceneAction = null; } });
        });
    }
    W.horizontal(uiWindowId, () => {
        W.button(uiWindowId, { text: "Undo", id: "undo", onClick: undo });
        W.button(uiWindowId, { text: "Redo", id: "redo", onClick: redo });
    });
    W.label(uiWindowId, { text: history.undoLabel ? `Undo: ${history.undoLabel}` : "No edits to undo" });
    if (history.redoLabel) W.label(uiWindowId, { text: `Redo: ${history.redoLabel}` });
    W.horizontal(uiWindowId, () => {
        for (const [id, label] of [["draw", "Draw"], ["move", "Move"], ["cut", "Cut"]] as const)
            W.button(uiWindowId, { text: (mode === id ? "> " : "  ") + label, id: `mode_${id}`, onClick: () => setMode(id) });
    });
    W.separator(uiWindowId);

    W.tabBar(uiWindowId, { id: "panel_tabs", tabs: PANEL_TABS, selected: panelTab, onSelect: id => { panelTab = id as PanelTab; } });
    if (panelTab === "tool") renderToolTab();
    else if (panelTab === "surfaces") renderSurfacesTab();
    else if (panelTab === "animate") renderAnimationUI();
    else if (panelTab === "scene") renderSceneTab();
    else renderHelpTab();
}

/** The Tool tab follows the mode row: brush for Draw, the selected surface's transform for Move,
 * cutting instructions for Cut. */
function renderToolTab(): void {
    if (mode === "draw") {
        Entropy.UI.Widget.label(uiWindowId, { text: `Brush: ${currentBrush().name}`, bold: true });
        Entropy.UI.Widget.horizontal(uiWindowId, () => {
            for (let i = 0; i < BRUSHES.length; i++) {
                Entropy.UI.Widget.button(uiWindowId, {
                    text: (i === brushIndex ? "> " : "") + ["Pencil", "Ink", "Air", "Erase"][i],
                    id: `brush_btn_${i}`,
                    onClick: () => { brushIndex = i; }
                });
            }
        });
        Entropy.UI.Widget.slider(uiWindowId, {
            label: "Size", value: sizeMultiplier, min: 0.1, max: 3.0, id: "size_slider",
            onChange: (v: string) => { sizeMultiplier = parseFloat(v); }
        });
        Entropy.UI.Widget.colorInput(uiWindowId, {
            label: "Color", color: [...paintSettings.color.map(n => n / 255), paintSettings.opacity],
            onChange: values => {
                if (!Array.isArray(values) || values.length !== 4 || !values.every(Number.isFinite)) return;
                chooseColor(values.slice(0, 3).map(n => Math.round(Math.max(0, Math.min(1, n)) * 255)) as RGB);
                paintSettings.opacity = Math.max(0.01, Math.min(1, values[3]));
            },
        });
        Entropy.UI.Widget.slider(uiWindowId, { label: "Opacity", value: paintSettings.opacity, min: 0.01, max: 1, id: "brush_opacity", onChange: value => { paintSettings.opacity = Number(value); preferencesDirty = true; } });
        Entropy.UI.Widget.button(uiWindowId, { text: pickingColor ? "Pick a surface color (cancel)" : "Eyedropper", id: "eyedropper", onClick: () => { pickingColor = !pickingColor; } });
        const drawingLayer = activeSurface()?.layers.find(layer => layer.id === activeSurface()?.activeLayerId);
        Entropy.UI.Widget.label(uiWindowId, { text: drawingLayer ? `Layer: ${drawingLayer.name}${drawingLayer.locked ? " (locked)" : !drawingLayer.visible ? " (hidden)" : ""}` : "No paint layer" });
        Entropy.UI.Widget.collapsingHeader(uiWindowId, "Palette", renderPalette);
        Entropy.UI.Widget.collapsingHeader(uiWindowId, "Tablet tuning", renderBrushTuning);
        Entropy.UI.Widget.collapsingHeader(uiWindowId, "Paint layers", renderPaintLayers);
        Entropy.UI.Widget.label(uiWindowId, { text: hoverSurfaceName ? `Painting: ${hoverSurfaceName}` : "Hover a surface to preview the brush" });
    } else if (mode === "cut") {
        Entropy.UI.Widget.label(uiWindowId, { text: "Draw a closed shape on a surface -" });
        Entropy.UI.Widget.label(uiWindowId, { text: "it cuts a hole through when it closes." });
        Entropy.UI.Widget.label(uiWindowId, { text: `path points: ${cutPath.length}` });
        if (cutTarget) {
            Entropy.UI.Widget.button(uiWindowId, {
                text: "Cancel Cut",
                id: "cancel_cut",
                onClick: () => { history.cancel(); resetGesture(); }
            });
        }
    } else {
        const s = activeGroupId ? null : activeSurface();
        if (!s) {
            Entropy.UI.Widget.label(uiWindowId, { text: activeGroupId ? "Edit this group in the Animate tab." : "No surface selected - click one." });
            if (activeGroupId) Entropy.UI.Widget.button(uiWindowId, { id: "open_animate_tab", text: "Open Animate tab", onClick: () => { panelTab = "animate"; } });
        } else {
            Entropy.UI.Widget.label(uiWindowId, { text: `Selected: ${s.name} (${s.kind})` });
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
                onChange: (v: string) => { beginEdit("Rotate surface"); s.yaw = parseFloat(v); pushSurfaceTransform(s); syncGizmoRotationFromSurface(s); }
            });
            Entropy.UI.Widget.slider(uiWindowId, {
                label: "Pitch", value: s.pitch, min: -Math.PI / 2, max: Math.PI / 2, id: "pitch_slider",
                onChange: (v: string) => { beginEdit("Rotate surface"); s.pitch = parseFloat(v); pushSurfaceTransform(s); syncGizmoRotationFromSurface(s); }
            });
            Entropy.UI.Widget.slider(uiWindowId, {
                label: "Roll", value: s.roll, min: -Math.PI, max: Math.PI, id: "roll_slider",
                onChange: (v: string) => { beginEdit("Rotate surface"); s.roll = parseFloat(v); pushSurfaceTransform(s); syncGizmoRotationFromSurface(s); }
            });
            // Dimension sliders are conditional on the surface's own (fixed-at-creation) kind -
            // a plane/box shares Width/Height, a box adds Depth, cylinder/sphere use Radius
            // (cylinder also keeps Height). Width/height edit geometry only - the texture keeps
            // its 0..1 (or atlas-cell) UV mapping and just stretches to fit, so a drastic
            // aspect-ratio change will distort whatever's already drawn. Acceptable for now, not
            // attempted to fix.
            if (s.kind === "plane" || s.kind === "box") {
                Entropy.UI.Widget.slider(uiWindowId, {
                    label: "Width", value: s.halfW * 2, min: 0.5, max: 8, id: "resize_w_slider",
                    onChange: (v: string) => setSurfaceDimensions(s, { halfW: parseFloat(v) / 2 })
                });
                Entropy.UI.Widget.slider(uiWindowId, {
                    label: "Height", value: s.halfH * 2, min: 0.5, max: 8, id: "resize_h_slider",
                    onChange: (v: string) => setSurfaceDimensions(s, { halfH: parseFloat(v) / 2 })
                });
            }
            if (s.kind === "box") {
                Entropy.UI.Widget.slider(uiWindowId, {
                    label: "Depth", value: s.halfD * 2, min: 0.5, max: 8, id: "resize_d_slider",
                    onChange: (v: string) => setSurfaceDimensions(s, { halfD: parseFloat(v) / 2 })
                });
            }
            if (s.kind === "cylinder") {
                Entropy.UI.Widget.slider(uiWindowId, {
                    label: "Radius", value: s.radius, min: 0.25, max: 4, id: "resize_r_slider",
                    onChange: (v: string) => setSurfaceDimensions(s, { radius: parseFloat(v) })
                });
                Entropy.UI.Widget.slider(uiWindowId, {
                    label: "Height", value: s.halfH * 2, min: 0.5, max: 8, id: "resize_h_slider",
                    onChange: (v: string) => setSurfaceDimensions(s, { halfH: parseFloat(v) / 2 })
                });
            }
            if (s.kind === "sphere") {
                Entropy.UI.Widget.slider(uiWindowId, {
                    label: "Radius", value: s.radius, min: 0.25, max: 4, id: "resize_r_slider",
                    onChange: (v: string) => setSurfaceDimensions(s, { radius: parseFloat(v) })
                });
            }
            if (s.kind === "plane") {
                Entropy.UI.Widget.slider(uiWindowId, {
                    // Cylindrical bend - see bendLocalPoint's doc comment. Sign flips which side the
                    // curve bulges toward; axis (button below) picks which local dimension curls.
                    // Plane-only: bending a box/cylinder/sphere isn't a supported operation.
                    label: "Bend", value: s.bend, min: -1, max: 1, id: "bend_slider",
                    onChange: (v: string) => setSurfaceBend(s, parseFloat(v))
                });
                Entropy.UI.Widget.button(uiWindowId, {
                    text: `Bend Axis: ${s.bendAxis.toUpperCase()}`, id: "bend_axis_toggle",
                    onClick: () => setSurfaceBendAxis(s, s.bendAxis === "y" ? "x" : "y")
                });
            }
            Entropy.UI.Widget.button(uiWindowId, {
                text: s.visible ? "Hide Surface" : "Show Surface", id: "toggle_visible",
                onClick: () => setSurfaceVisible(s, !s.visible)
            });
            Entropy.UI.Widget.button(uiWindowId, {
                text: s.solid ? "Solid: blocks the player" : "Solid: player walks through", id: "toggle_solid",
                onClick: () => { beginEdit("Toggle solid"); s.solid = !s.solid; }
            });
            Entropy.UI.Widget.button(uiWindowId, {
                text: "Delete Surface", id: "delete_surface",
                onClick: () => deleteActiveSurface()
            });
        }
    }
}

/** Surfaces tab: create one, frame the selected one in the camera, and the list of every surface. */
function renderSurfacesTab(): void {
    const W = Entropy.UI.Widget;
    W.label(uiWindowId, { text: "New surface", bold: true });
    // Cycling button, not a dropdown - the same call this codebase's other demos already made
    // (see ml_graph_demo_addon.ts's dataset/activation pickers): this GUI kit's dropdown payload
    // format wasn't worth depending on for a same-session feature with only 4 fixed choices.
    Entropy.UI.Widget.button(uiWindowId, {
        text: `Shape: ${pendingKind}`,
        id: "pending_kind_cycle",
        onClick: () => { pendingKind = SHAPE_KINDS[(SHAPE_KINDS.indexOf(pendingKind) + 1) % SHAPE_KINDS.length]; }
    });
    if (pendingKind === "plane" || pendingKind === "box") {
        Entropy.UI.Widget.slider(uiWindowId, {
            label: "New Width", value: pendingWidth, min: 0.5, max: 8, id: "pending_w_slider",
            onChange: (v: string) => { pendingWidth = parseFloat(v); }
        });
        Entropy.UI.Widget.slider(uiWindowId, {
            label: "New Height", value: pendingHeight, min: 0.5, max: 8, id: "pending_h_slider",
            onChange: (v: string) => { pendingHeight = parseFloat(v); }
        });
    }
    if (pendingKind === "box") {
        Entropy.UI.Widget.slider(uiWindowId, {
            label: "New Depth", value: pendingDepth, min: 0.5, max: 8, id: "pending_d_slider",
            onChange: (v: string) => { pendingDepth = parseFloat(v); }
        });
    }
    if (pendingKind === "cylinder") {
        Entropy.UI.Widget.slider(uiWindowId, {
            label: "New Radius", value: pendingRadius, min: 0.25, max: 4, id: "pending_r_slider",
            onChange: (v: string) => { pendingRadius = parseFloat(v); }
        });
        Entropy.UI.Widget.slider(uiWindowId, {
            label: "New Height", value: pendingHeight, min: 0.5, max: 8, id: "pending_h_slider",
            onChange: (v: string) => { pendingHeight = parseFloat(v); }
        });
    }
    if (pendingKind === "sphere") {
        Entropy.UI.Widget.slider(uiWindowId, {
            label: "New Radius", value: pendingRadius, min: 0.25, max: 4, id: "pending_r_slider",
            onChange: (v: string) => { pendingRadius = parseFloat(v); }
        });
    }
    Entropy.UI.Widget.button(uiWindowId, {
        text: "+ New Surface",
        id: "new_surface",
        onClick: addSurfaceFromPalette
    });
    W.collapsingHeader(uiWindowId, "Prefabs", renderPrefabsUI, "prefabs_header", true);
    W.label(uiWindowId, { text: `Surfaces (${surfaces.length})`, bold: true });
    W.horizontal(uiWindowId, () => {
        W.button(uiWindowId, { text: "Focus", id: "focus_surface", onClick: () => focusSurface(false) });
        W.button(uiWindowId, { text: "Align", id: "align_surface", onClick: () => focusSurface(true) });
        W.button(uiWindowId, { text: "Return", id: "return_view", onClick: restoreView });
    });
    renderLayersUI();
}

/** Scene tab: the playable example, then save, load and export. */
function renderSceneTab(): void {
    Entropy.UI.Widget.button(uiWindowId, { id: "playable_example", text: "Open playable example", onClick: createPlayableExample });
    Entropy.UI.Widget.collapsingHeader(uiWindowId, "World and lighting", renderWorldUI, "world_header", true);
    renderSceneLibrary();
}

/** Ready-made props: one click drops a blocked-out group on the ground under the camera's target. */
function renderPrefabsUI(): void {
    const W = Entropy.UI.Widget;
    W.label(uiWindowId, { text: "Drops a prop at the camera target." });
    for (let i = 0; i < PREFAB_IDS.length; i += 3) W.horizontal(uiWindowId, () => {
        for (const id of PREFAB_IDS.slice(i, i + 3)) W.button(uiWindowId, { id: `prefab_${id}`, text: `+ ${id}`, onClick: () => addPrefabAtView(id) });
    });
}

/** Who walks in Play, how far they may go, and the light. The same settings the MCP tools change. */
function renderWorldUI(): void {
    const W = Entropy.UI.Widget;
    const playerName = world.player ? groups.find(g => g.id === world.player)?.name ?? surfaces.find(s => s.id === world.player)?.name ?? "(missing)" : "none (Play is click-only)";
    W.label(uiWindowId, { text: `Player: ${playerName}` });
    W.horizontal(uiWindowId, () => {
        W.button(uiWindowId, { id: "world_set_player", text: "Use selection", onClick: () => {
            const node = activeGroupId ? groups.find(g => g.id === activeGroupId) : activeSurface();
            if (!node) { statusMessage = "Select a group or surface first."; return; }
            if (node.parentId) { statusMessage = "The player must not be inside another group."; return; }
            beginEdit("Set player"); world.player = node.id; statusMessage = `Player is ${node.name}. Press Play, then WASD.`;
        } });
        W.button(uiWindowId, { id: "world_clear_player", text: "No player", onClick: () => { beginEdit("Clear player"); world.player = null; } });
    });
    W.slider(uiWindowId, { id: "world_bounds", label: "Walk bounds", value: world.bounds, min: 5, max: 200, onChange: v => { const n = Number(v); if (Number.isFinite(n)) { beginEdit("Walk bounds"); world.bounds = Math.max(1, Math.min(1000, n)); } } });
    W.label(uiWindowId, { text: "Lighting" });
    for (let i = 0; i < LIGHTING_PRESET_NAMES.length; i += 3) W.horizontal(uiWindowId, () => {
        for (const name of LIGHTING_PRESET_NAMES.slice(i, i + 3)) W.button(uiWindowId, { id: `light_${name}`, text: name, onClick: () => { beginEdit("Change lighting"); world.lighting = cloneLighting(LIGHTING_PRESETS[name]); applyLighting(); } });
    });
}

function renderHelpTab(): void {
    const W = Entropy.UI.Widget;
    W.label(uiWindowId, { text: "Add a surface > Draw > Logic > Play", bold: true });
    W.label(uiWindowId, { text: "Tool: brush, transform, cut for the mode above." });
    W.label(uiWindowId, { text: "Surfaces: add, focus, hide, delete." });
    W.label(uiWindowId, { text: "Animate: groups, clips and keyframes." });
    W.label(uiWindowId, { text: "Scene: save, load, export, player, lighting." });
    W.label(uiWindowId, { text: "Surfaces > Prefabs: houses, trees, people." });
    W.separator(uiWindowId);
    W.label(uiWindowId, { text: "Shortcuts", bold: true });
    for (const text of ["B Draw | V Move | [ ] Size", "Ctrl+Z Undo | Ctrl+Shift+Z Redo", "F Focus | Shift+F Align", "Ctrl+S Save scene", "Esc Return view / cancel cut", "Right-drag Orbit | Wheel Zoom", "Hover ring shows full-pressure size", "Play: WASD walk | E interact | Q R turn"])
        W.label(uiWindowId, { text });
}

// A ground-plane reference grid, drawn as one addon-owned mesh reusing the CanvasSurface pipeline
// (a 1x1 white texture tinted by the mesh's own vertex color, same trick the fragment shader
// already applies to surfaces) - the engine's own ground grid (src/core/Grid.rs) only renders in
// Studio's editor path (render_frame.rs), not the addon/runtime path this demo uses, so a visible
// grid here has to be addon geometry, not an engine feature to flip on. Line quads are built the
// same way as Grid.rs's generate_grid (thin axis-aligned rectangles, not literal 1px lines).
const GROUND_GRID_HALF_SIZE = 12; // world units
const GROUND_GRID_SPACING = 1;
const GROUND_GRID_LINE_WIDTH = 0.02;
const GROUND_GRID_COLOR: [number, number, number, number] = [0.58, 0.58, 0.62, 1];

function buildGroundGridMesh(): { vertexData: number[]; indexData: number[] } {
    const vertexData: number[] = [];
    const indexData: number[] = [];
    const half = GROUND_GRID_HALF_SIZE;
    const halfLine = GROUND_GRID_LINE_WIDTH / 2;
    const normal: Vec3 = [0, 1, 0];
    const [r, g, b, a] = GROUND_GRID_COLOR;

    // Quad corners pushed as (bottom-left, bottom-right, top-left, top-right) in (x,z), matching
    // src/core/Grid.rs's generate_grid layout - but Grid.rs draws in a separate, apparently
    // unculled Studio-only pipeline and hardcodes its normal rather than deriving it from winding.
    // This mesh reuses CanvasSurface's pipeline, which *does* backface-cull (see phase 1's winding
    // comments), so the two triangles below are wound to face +Y (cross(p3-p0, p1-p0) and
    // cross(p2-p0, p3-p0) both point +Y - verified by hand, not copied from Grid.rs's order).
    const pushLineQuad = (x0: number, z0: number, x1: number, z1: number, x2: number, z2: number, x3: number, z3: number) => {
        const base = vertexData.length / 12;
        for (const [x, z, u, v] of [[x0, z0, 0, 0], [x1, z1, 1, 0], [x2, z2, 0, 1], [x3, z3, 1, 1]] as const) {
            vertexData.push(x, 0, z, normal[0], normal[1], normal[2], u, v, r, g, b, a);
        }
        indexData.push(base, base + 3, base + 1, base, base + 2, base + 3);
    };

    const steps = Math.round((half * 2) / GROUND_GRID_SPACING);
    for (let i = 0; i <= steps; i++) {
        const x = -half + i * GROUND_GRID_SPACING;
        pushLineQuad(x - halfLine, -half, x + halfLine, -half, x - halfLine, half, x + halfLine, half);
    }
    for (let i = 0; i <= steps; i++) {
        const z = -half + i * GROUND_GRID_SPACING;
        pushLineQuad(-half, z - halfLine, half, z - halfLine, -half, z + halfLine, half, z + halfLine);
    }

    return { vertexData, indexData };
}

const GROUND_GRID_MESH_ID = "canvas_surfaces_ground_grid";
let groundGridResources: { texture: string; preview: string } | null = null;
/** The reference grid is an editing aid: Play hides it (clearMesh) and Stop brings it back with the same texture and buffer. */
function spawnGroundGrid(): void {
    if (!groundGridResources) {
        const preview = Entropy.Buffer.create({ size: 32, usage: "Uniform" });
        Entropy.Buffer.write(preview, new Float32Array(8));
        groundGridResources = { preview, texture: Entropy.Texture.create(1, 1, new Uint8Array([255, 255, 255, 255])) };
    }
    const previewBufferId = groundGridResources.preview, gridTextureId = groundGridResources.texture;
    const { vertexData, indexData } = buildGroundGridMesh();
    Entropy.Model.createMesh({
        id: GROUND_GRID_MESH_ID,
        position: [0, 0, 0],
        vertexData,
        indexData,
        pipelineId,
        bindings: [
            { group: 2, binding: 0, resource: { type: "Texture", value: { id: gridTextureId } } },
            { group: 2, binding: 1, resource: { type: "Sampler" } },
            { group: 2, binding: 2, resource: { type: "Buffer", value: { id: previewBufferId } } },
            { group: 2, binding: 3, resource: { type: "Buffer", value: { id: lightingBufferId } } },
        ],
    });
}

// --- Prefabs and flat colour ---------------------------------------------------------------------

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const r3v = (v: readonly number[]): number[] => v.map(r3);

/** A brand-new array, never an in-place write: history snapshots share unchanged canvases. */
function paintFlat(s: Surface, rgb: RGB): void {
    const layer = s.layers.find(l => l.id === s.activeLayerId && l.visible && !l.locked) ?? s.layers[0];
    layer.pixels = fillBytes([rgb[0], rgb[1], rgb[2], 255]);
    composeSurface(s);
}
/** The triangular end of a gable roof: alpha is cut everywhere outside an apex-up triangle. */
function cutGable(s: Surface): void {
    const mask = new Uint8Array(CANVAS_RES * CANVAS_RES);
    const mid = (CANVAS_RES - 1) / 2;
    for (let y = 0; y < CANVAS_RES; y++) {
        const half = mid * (y / (CANVAS_RES - 1)) + 0.5;
        for (let x = 0; x < CANVAS_RES; x++) if (Math.abs(x - mid) <= half) mask[y * CANVAS_RES + x] = 255;
    }
    s.cutMask = mask;
    composeSurface(s);
}
function uniqueName(base: string, taken: (name: string) => boolean): string {
    if (!taken(base)) return base;
    for (let n = 2; ; n++) if (!taken(`${base} ${n}`)) return `${base} ${n}`;
}
const surfaceNameTaken = (name: string): boolean => surfaces.some(s => s.name === name);
const groupNameTaken = (name: string): boolean => groups.some(g => g.name === name);

function placePrefab(id: string, params: Record<string, unknown>, position: Vec3, yaw: number, name?: string): { group: Group; made: Surface[]; footprint: number } {
    const spec = buildPrefab(id, params);
    if (surfaces.length + spec.parts.length > 128) throw new Error(`A scene holds at most 128 surfaces; this prefab needs ${spec.parts.length} and ${surfaces.length} exist.`);
    if (groups.length >= 128) throw new Error("A scene holds at most 128 groups.");
    beginEdit(`Add ${id}`);
    const groupName = uniqueName(name?.trim() || id.charAt(0).toUpperCase() + id.slice(1), groupNameTaken);
    const group: Group = { ...defaultTransform(), id: Entropy.generateUUID(), name: groupName, parentId: null, frame: identity(), position: [...position], rotation: [0, yaw, 0] };
    groups.push(group);
    const made = spec.parts.map(part => {
        const s = spawnSurface(part.position, part.yaw ?? 0, part.kind, part.halfW ?? DEFAULT_HALF_SIZE, part.halfH ?? DEFAULT_HALF_SIZE, part.halfD ?? DEFAULT_HALF_DEPTH, part.radius ?? DEFAULT_RADIUS, {
            name: uniqueName(`${groupName} ${part.name}`, surfaceNameTaken), parentId: group.id, pitch: part.pitch ?? 0, roll: part.roll ?? 0, scale: part.scale ? [...part.scale] as Vec3 : undefined, solid: part.solid ?? false,
        });
        paintFlat(s, part.color);
        if (part.mask === "gable") cutGable(s);
        return s;
    });
    activeGroupId = group.id; selectedStrokeId = null;
    return { group, made, footprint: spec.footprint };
}
/** Where the GUI drops a prefab: on the ground under the camera's orbit target. */
function addPrefabAtView(id: string): void {
    try {
        const at = placePrefab(id, {}, [Math.round(orbitTarget[0] * 2) / 2, 0, Math.round(orbitTarget[2] * 2) / 2], 0);
        statusMessage = `Added ${at.group.name} (${at.made.length} surface${at.made.length === 1 ? "" : "s"}).`;
    } catch (error) { statusMessage = (error as Error).message; }
}

// --- MCP tools -----------------------------------------------------------------------------------
//
// Every tool is defined in canvas_tool_schemas.ts and implemented here. A tool is one undo step,
// returns { success: true, ... } or { success: false, error }, refuses to change the scene during
// Play, and rejects arguments it does not know so a typo is an error, not a silent no-op.

type Args = Record<string, any>;
function fail(message: string): never { throw new Error(message); }
function vec(value: unknown, name: string, length = 3): number[] {
    if (!Array.isArray(value) || value.length !== length || !value.every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e5)) fail(`${name} must be [${length === 3 ? "x, y, z" : "x, z"}] numbers.`);
    return value as number[];
}
function angle(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e4) fail(`${name} must be a number of radians.`);
    return value as number;
}
function flag(value: unknown, name: string): boolean { if (typeof value !== "boolean") fail(`${name} must be true or false.`); return value as boolean; }
function listNames(names: string[]): string { return names.length ? names.slice(0, 15).map(n => `"${n}"`).join(", ") + (names.length > 15 ? ", ..." : "") : "(none)"; }

function findSurface(ref: unknown): Surface {
    const key = String(ref);
    const byId = surfaces.find(s => s.id === key);
    if (byId) return byId;
    const named = surfaces.filter(s => s.name === key);
    if (named.length === 1) return named[0];
    if (named.length > 1) fail(`More than one surface is named "${key}" (ids: ${named.map(s => s.id).join(", ")}). Use an id.`);
    return fail(`No surface "${key}". Surfaces: ${listNames(surfaces.map(s => s.name))}.`);
}
function findGroup(ref: unknown): Group {
    const key = String(ref);
    const byId = groups.find(g => g.id === key);
    if (byId) return byId;
    const named = groups.filter(g => g.name === key);
    if (named.length === 1) return named[0];
    if (named.length > 1) fail(`More than one group is named "${key}" (ids: ${named.map(g => g.id).join(", ")}). Use an id.`);
    return fail(`No group "${key}". Groups: ${listNames(groups.map(g => g.name))}.`);
}
/** A surface or a group, by id first and then by name. */
function findNode(ref: unknown): { surface?: Surface; group?: Group } {
    const key = String(ref);
    const id = surfaces.find(s => s.id === key) ?? groups.find(g => g.id === key);
    if (id) return "yaw" in id ? { surface: id as Surface } : { group: id as Group };
    const s = surfaces.filter(s => s.name === key), g = groups.filter(g => g.name === key);
    if (s.length + g.length === 1) return s.length ? { surface: s[0] } : { group: g[0] };
    if (s.length + g.length > 1) fail(`"${key}" names more than one surface or group. Use an id.`);
    return fail(`No surface or group "${key}". Groups: ${listNames(groups.map(g => g.name))}. Surfaces: ${listNames(surfaces.map(s => s.name))}.`);
}
const nodeId = (ref: unknown): string => { const n = findNode(ref); return (n.surface ?? n.group)!.id; };
function findClip(ref: unknown): Clip {
    const key = String(ref);
    const clip = clips.find(c => c.id === key) ?? clips.find(c => c.name === key);
    return clip ?? fail(`No clip "${key}". Clips: ${listNames(clips.map(c => c.name))}.`);
}
const nameOf = (id: string): string => groups.find(g => g.id === id)?.name ?? surfaces.find(s => s.id === id)?.name ?? clips.find(c => c.id === id)?.name ?? id;
function sizeOf(s: Surface): Record<string, number> {
    if (s.kind === "plane") return { width: r3(s.halfW * 2), height: r3(s.halfH * 2) };
    if (s.kind === "box") return { width: r3(s.halfW * 2), height: r3(s.halfH * 2), depth: r3(s.halfD * 2) };
    if (s.kind === "cylinder") return { radius: r3(s.radius), height: r3(s.halfH * 2) };
    return { radius: r3(s.radius) };
}
function surfaceInfo(s: Surface): Record<string, unknown> {
    return { id: s.id, name: s.name, kind: s.kind, parent: s.parentId ? nameOf(s.parentId) : null, position: r3v(s.position), yaw: r3(s.yaw), pitch: r3(s.pitch), roll: r3(s.roll), size: sizeOf(s), visible: s.visible, solid: s.solid, strokes: s.strokes.length };
}
function groupInfo(g: Group): Record<string, unknown> {
    return { id: g.id, name: g.name, parent: g.parentId ? nameOf(g.parentId) : null, position: r3v(g.position), yaw: r3(g.rotation[1]), scale: r3v(g.scale), children: surfaces.filter(s => s.parentId === g.id).length + groups.filter(o => o.parentId === g.id).length };
}
function readDims(kind: ShapeKind, dims: Args, base: { halfW: number; halfH: number; halfD: number; radius: number }): { halfW: number; halfH: number; halfD: number; radius: number } {
    const out = { ...base };
    const dim = (key: string, allowed: boolean): number | undefined => {
        const v = dims[key];
        if (v === undefined) return undefined;
        if (!allowed) fail(`size.${key} does not apply to a ${kind}.`);
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0.02 || v > 20000) fail(`size.${key} must be a number from 0.02 to 20000.`);
        return v;
    };
    const w = dim("width", kind === "plane" || kind === "box"), h = dim("height", kind !== "sphere"), d = dim("depth", kind === "box"), r = dim("radius", kind === "cylinder" || kind === "sphere");
    if (w !== undefined) out.halfW = w / 2;
    if (h !== undefined) out.halfH = h / 2;
    if (d !== undefined) out.halfD = d / 2;
    if (r !== undefined) out.radius = r;
    return out;
}
function editingOnly(): void { if (gameSession) fail("Play is running. Call canvas_stop first."); }
const LOGIC_RULE_KEYS = ["when", "once", "conditions", "then", "otherwise"];

/** Resolve names in a rule to ids so compileRule only ever sees ids. */
function resolveRule(raw: Args): Rule {
    const unknown = Object.keys(raw).filter(k => !LOGIC_RULE_KEYS.includes(k));
    if (unknown.length) fail(`Unknown rule field(s): ${unknown.join(", ")}.`);
    const when = raw.when ?? fail("A rule needs when.");
    if (!["start", "click", "near", "interact"].includes(when.type)) fail('when.type must be "start", "click", "near" or "interact".');
    const action = (a: Args, where: string) => {
        if (!a || typeof a !== "object") fail(`${where} must be an object with a "do".`);
        switch (a.do) {
            case "message": if (typeof a.text !== "string") fail(`${where}: message needs text.`); return { do: "message" as const, text: a.text };
            case "show": case "hide": case "teleport": if (a.target === undefined) fail(`${where}: ${a.do} needs a target.`); return { do: a.do as "show" | "hide" | "teleport", target: nodeId(a.target) };
            case "add": if (typeof a.counter !== "string" || !a.counter.trim()) fail(`${where}: add needs a counter name.`); return { do: "add" as const, counter: a.counter.trim(), amount: a.amount === undefined ? 1 : Number(a.amount) };
            case "clip": if (a.clip === undefined) fail(`${where}: clip needs a clip.`); return { do: "clip" as const, clip: findClip(a.clip).id };
            case "wait": return { do: "wait" as const, seconds: Number(a.seconds) };
            default: return fail(`${where}: unknown action "${a.do}". Use message, show, hide, teleport, add, clip or wait.`);
        }
    };
    return {
        when: { type: when.type, target: when.type === "start" ? undefined : nodeId(when.target ?? fail(`A "${when.type}" trigger needs when.target.`)), distance: when.distance, prompt: when.prompt },
        once: raw.once === true,
        conditions: (raw.conditions ?? []).map((c: Args) => ({ counter: String(c.counter ?? "").trim() || fail("A condition needs a counter."), atLeast: c.atLeast, below: c.below })),
        then: (raw.then ?? []).map((a: Args, i: number) => action(a, `then[${i}]`)),
        otherwise: raw.otherwise ? raw.otherwise.map((a: Args, i: number) => action(a, `otherwise[${i}]`)) : undefined,
    };
}
function logicInfo(): Record<string, unknown> {
    return {
        nodes: logic.nodes.map(n => ({ id: n.id, kind: n.kind, target: n.target ? nameOf(n.target) : "", text: n.text, seconds: n.seconds, ...(n.variable !== undefined ? { counter: n.variable } : {}), ...(n.amount !== undefined ? { amount: n.amount } : {}), ...(n.op ? { op: n.op } : {}) })),
        connections: logic.connections.map(c => ({ from: c.fromNode, to: c.toNode })),
        problems: logicProblems(logic, targetIds(), clips.map(c => c.id)),
    };
}
function worldInfo(): Record<string, unknown> {
    const p = playerHandle();
    return { player: world.player ? { id: world.player, name: nameOf(world.player), position: p ? r3v([p.position[0], p.position[2]]) : null } : null, bounds: world.bounds, lighting: world.lighting };
}
function statsInfo(): Record<string, unknown> {
    const PIXEL_BYTES = CANVAS_RES * CANVAS_RES * 4;
    let ram = 0, save = 2000, painted = 0;
    for (const s of surfaces) {
        ram += s.canvas.byteLength + s.cutMask.byteLength + s.layers.reduce((n, l) => n + l.pixels.byteLength, 0) + Object.values(s.bases).reduce((n, b) => n + b.byteLength, 0);
        let surfaceIsPainted = false;
        for (const l of s.layers) { if (!uniformFill(l.pixels)) { save += Math.ceil(PIXEL_BYTES / 3) * 4; surfaceIsPainted = true; } }
        for (const b of Object.values(s.bases)) if (!uniformFill(b)) save += Math.ceil(PIXEL_BYTES / 3) * 4;
        if (!s.cutMask.every(v => v === s.cutMask[0])) save += Math.ceil(PIXEL_BYTES / 4 / 3) * 4;
        if (surfaceIsPainted) painted++;
        save += 700 + s.strokes.reduce((n, st) => n + st.stamps.length * 70, 0);
    }
    const mb = (n: number) => Math.round(n / 1048576 * 10) / 10;
    return {
        surfaces: surfaces.length, surfaceLimit: 128, groups: groups.length, groupLimit: 128, clips: clips.length, clipLimit: 128,
        logicNodes: logic.nodes.length, logicNodeLimit: 128, logicWires: logic.connections.length, logicWireLimit: 256,
        paintedSurfaces: painted, estimatedMemoryMB: mb(ram), estimatedSaveMB: mb(save), saveLimitMB: 256,
    };
}
function clearScene(name: string): void {
    beginEdit("New scene");
    for (const s of [...surfaces]) deleteSurface(s);
    groups = []; clips = []; markedNodes.clear(); activeGroupId = null; selectedClipId = null; selectedStrokeId = null;
    logic = emptyLogic(); resetWorld();
    currentSceneId = Entropy.generateUUID(); sceneName = name;
    history.commit(); savedSceneState = null; pendingSceneAction = null;
    statusMessage = "New empty scene.";
}
function subtreeBounds(id: string): AABB | null {
    const under = surfacesUnder(id);
    if (!under.length) return null;
    const boxes = under.map(s => { s.worldPatches = buildSurfaceWorldPatches(s); return surfaceAABB(s); });
    return { min: [0, 1, 2].map(i => Math.min(...boxes.map(b => b.min[i]))) as Vec3, max: [0, 1, 2].map(i => Math.max(...boxes.map(b => b.max[i]))) as Vec3 };
}

const PLAYTEST_DT = 1 / 30;
const PLAYTEST_MAX_WALK_SECONDS = 60;
/** Run the same session Play runs, in one call, then put everything back. */
function runPlaytest(steps: Args[]): Record<string, unknown> {
    stopPreview(); finishStroke(); resetGesture(); history.commit();
    const problems = logicProblems(logic, targetIds(), clips.map(c => c.id));
    if (problems.length) fail(`The logic has a problem: ${problems[0]}`);
    const run = new GameRun(true);
    const failures: string[] = [];
    const transcript: Record<string, unknown>[] = [];
    const counters = (): Record<string, number> => Object.fromEntries(run.session.vars);
    const settle = (seconds: number): void => { for (let t = 0; t < seconds - 1e-9; t += PLAYTEST_DT) run.tick(Math.min(PLAYTEST_DT, seconds - t)); };
    try {
        run.session.start();
        run.tick(0);
        steps.forEach((step, i) => {
            const keys = Object.keys(step).filter(k => k !== "within");
            if (keys.length !== 1) fail(`steps[${i}] must have exactly one of walkTo, interact, click, wait, expect.`);
            const before = run.messages.length;
            const entry: Record<string, unknown> = { step: i, do: keys[0] };
            if (keys[0] === "walkTo") {
                if (!run.hasPlayer) fail("walkTo needs a player: call canvas_set_world first.");
                const goal = step.walkTo;
                // A step is 0.14 long at 30 fps, so anything tighter than 0.15 could overshoot forever.
                const within = Math.max(0.15, typeof step.within === "number" ? step.within : (Array.isArray(goal) ? 0.15 : 1));
                const targetId = Array.isArray(goal) ? null : nodeId(goal);
                if (targetId && run.distanceTo(targetId) === null) fail(`steps[${i}] walkTo "${goal}": nothing under it is shown, so there is nothing to walk to.`);
                const point: XZ | null = Array.isArray(goal) ? ((): XZ => { const v = vec(goal, `steps[${i}].walkTo`, goal.length === 3 ? 3 : 2); return [v[0], v[v.length - 1]]; })() : null;
                const aim = (): XZ => {
                    if (point) return point;
                    const b = subtreeBounds(targetId!)!;
                    return [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
                };
                // A target the game hides on arrival (a pickup) counts as reached.
                const arrived = (): boolean => point ? Math.hypot(run.position()![0] - point[0], run.position()![1] - point[1]) <= within : (run.distanceTo(targetId!) ?? 0) <= within;
                // Sliding along a wall still moves, so "stuck" means no progress toward the goal for a second.
                let best = Infinity, sinceProgress = 0, time = 0;
                while (!arrived() && time < PLAYTEST_MAX_WALK_SECONDS && sinceProgress < 1) {
                    const at = run.position()!, to = aim();
                    run.walk([to[0] - at[0], to[1] - at[1]], PLAYTEST_DT);
                    run.tick(PLAYTEST_DT); time += PLAYTEST_DT;
                    const now = run.position()!, remaining = Math.hypot(to[0] - now[0], to[1] - now[1]);
                    if (remaining < best - 0.02) { best = remaining; sinceProgress = 0; } else sinceProgress += PLAYTEST_DT;
                }
                if (!arrived()) failures.push(`steps[${i}] walkTo ${JSON.stringify(goal)}: ${sinceProgress >= 1 ? "was stopped by a solid surface or the world bounds" : "did not arrive in 60 s"} at [${r3v(run.position()!)}]. Try waypoints around it.`);
                entry.arrived = arrived();
            } else if (keys[0] === "interact") { run.interact(); run.tick(0); }
            else if (keys[0] === "click") { const n = findNode(step.click); const id = (n.surface ?? n.group)!.id; run.click([id, ...(n.surface ? ancestorIds(n.surface) : [])]); run.tick(0); }
            else if (keys[0] === "wait") { const s = step.wait; if (typeof s !== "number" || s < 0 || s > 600) fail(`steps[${i}].wait must be 0 to 600 seconds.`); settle(s); }
            else if (keys[0] === "expect") {
                const e = step.expect ?? {};
                for (const [name, value] of Object.entries(e.counters ?? {})) { const actual = run.session.vars.get(name) ?? 0; if (actual !== value) failures.push(`steps[${i}] expected ${name} = ${value}, got ${actual}.`); }
                if (e.message !== undefined && !run.message.includes(String(e.message))) failures.push(`steps[${i}] expected the message to contain "${e.message}", got "${run.message}".`);
                for (const [ref, want] of Object.entries(e.shown ?? {})) { const shown = surfacesUnder(nodeId(ref)).some(s => s.visible); if (shown !== want) failures.push(`steps[${i}] expected ${ref} shown = ${want}, got ${shown}.`); }
                if (e.near) { const d = run.distanceTo(nodeId(e.near.target)); if (d === null || d > (e.near.within ?? 1.5)) failures.push(`steps[${i}] expected the player within ${e.near.within ?? 1.5} of ${e.near.target}, distance is ${d === null ? "unknown (hidden)" : r3(d)}.`); }
            } else fail(`steps[${i}]: unknown step "${keys[0]}". Use walkTo, interact, click, wait or expect.`);
            if (run.messages.length > before) entry.messages = run.messages.slice(before);
            entry.position = run.position() ? r3v(run.position()!) : null; entry.counters = counters();
            transcript.push(entry);
        });
        const hidden = surfaces.filter(s => !s.visible).map(s => s.name);
        return { passed: failures.length === 0, failures, transcript, messages: run.messages, counters: counters(), position: run.position() ? r3v(run.position()!) : null, clipsPlayed: run.clipsPlayed, hiddenByGame: hidden };
    } finally { run.restore(); }
}

const TOOL_HANDLERS: Record<CanvasToolName, (args: Args) => unknown> = {
    canvas_get_scene: () => ({
        name: sceneName, sceneId: currentSceneId, unsavedChanges: sceneIsDirty(), playing: !!gameSession,
        surfaces: surfaces.map(surfaceInfo), groups: groups.map(groupInfo), clips: clips.map(c => ({ id: c.id, name: c.name, duration: c.duration, tracks: c.tracks.length })),
        logic: { nodes: logic.nodes.length, wires: logic.connections.length }, world: worldInfo(),
    }),
    canvas_world_stats: () => statsInfo(),
    canvas_new_scene: a => {
        editingOnly();
        if (sceneIsDirty() && surfaces.length && a.confirmDiscard !== true) fail("The open scene has unsaved changes. Save it with canvas_save_scene, or pass confirmDiscard: true to throw them away.");
        clearScene(typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 80) : "Untitled scene");
        return { name: sceneName };
    },
    canvas_list_scenes: () => ({ scenes: sceneLibrary.entries.map(e => ({ id: e.id, name: e.name })) }),
    canvas_save_scene: a => {
        editingOnly();
        if (typeof a.name === "string" && a.name.trim()) sceneName = a.name.trim().slice(0, 80);
        if (!saveScene(a.asNew === true)) fail(statusMessage || "Save failed.");
        return { name: sceneName, id: currentSceneId, message: statusMessage };
    },
    canvas_load_scene: a => {
        editingOnly();
        const entry = sceneLibrary.entries.find(e => e.id === a.scene) ?? sceneLibrary.entries.find(e => e.name === a.scene);
        if (!entry) fail(`No saved scene "${a.scene}". Saved: ${listNames(sceneLibrary.entries.map(e => e.name))}.`);
        if (sceneIsDirty() && surfaces.length && a.confirmDiscard !== true) fail("The open scene has unsaved changes. Save it first, or pass confirmDiscard: true.");
        selectedSceneId = entry!.id;
        loadScene();
        if (pendingSceneAction) pendingSceneAction.run();
        if (statusMessage.startsWith("Load failed")) fail(statusMessage);
        return { name: sceneName, surfaces: surfaces.length };
    },
    canvas_create_surface: a => {
        editingOnly();
        const kind: ShapeKind = a.kind ?? "plane";
        if (!SHAPE_KINDS.includes(kind)) fail(`kind must be one of ${SHAPE_KINDS.join(", ")}.`);
        if (surfaces.length >= 128) fail("A scene holds at most 128 surfaces. Check canvas_world_stats.");
        const dims = readDims(kind, a.size ?? {}, { halfW: DEFAULT_HALF_SIZE, halfH: DEFAULT_HALF_SIZE, halfD: DEFAULT_HALF_DEPTH, radius: DEFAULT_RADIUS });
        const parent = a.parent !== undefined && a.parent !== null ? findGroup(a.parent) : null;
        const s = spawnSurface(vec(a.position, "position") as Vec3, a.yaw === undefined ? 0 : angle(a.yaw, "yaw"), kind, dims.halfW, dims.halfH, dims.halfD, dims.radius, {
            name: uniqueName(typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 80) : `${kind[0].toUpperCase()}${kind.slice(1)}`, surfaceNameTaken),
            parentId: parent?.id ?? null, pitch: a.pitch === undefined ? 0 : angle(a.pitch, "pitch"), roll: a.roll === undefined ? 0 : angle(a.roll, "roll"),
            solid: a.solid === true, visible: a.visible === undefined ? true : flag(a.visible, "visible"),
        });
        if (a.color !== undefined) paintFlat(s, parseColor(a.color, [255, 255, 255]));
        return { surface: surfaceInfo(s) };
    },
    canvas_update_surface: a => {
        editingOnly();
        const s = findSurface(a.surface);
        beginEdit("Update surface");
        if (a.color !== undefined && s.strokes.length && a.overwrite !== true) fail(`"${s.name}" has ${s.strokes.length} brush stroke(s); pass overwrite: true to repaint it.`);
        if (a.parent !== undefined) {
            const parent = a.parent === null ? null : findGroup(a.parent).id;
            try { parentNode(s, parent); } catch (e) { fail((e as Error).message); }
        }
        if (typeof a.name === "string" && a.name.trim()) { const name = a.name.trim().slice(0, 80); if (name !== s.name) s.name = uniqueName(name, surfaceNameTaken); }
        if (a.position !== undefined) s.position = [...vec(a.position, "position")] as Vec3;
        if (a.yaw !== undefined) s.yaw = angle(a.yaw, "yaw");
        if (a.pitch !== undefined) s.pitch = angle(a.pitch, "pitch");
        if (a.roll !== undefined) s.roll = angle(a.roll, "roll");
        if (a.size !== undefined) Object.assign(s, readDims(s.kind, a.size, s));
        if (a.bend !== undefined) { if (s.kind !== "plane") fail("bend only applies to planes."); if (typeof a.bend !== "number" || Math.abs(a.bend) > 1) fail("bend must be -1 to 1."); s.bend = a.bend; }
        if (a.solid !== undefined) s.solid = flag(a.solid, "solid");
        if (a.color !== undefined) { if (a.overwrite === true && s.strokes.length) { s.strokes = []; s.bases = {}; } paintFlat(s, parseColor(a.color, [255, 255, 255])); }
        if (a.visible !== undefined) setSurfaceVisible(s, flag(a.visible, "visible"));
        s.worldPatches = buildSurfaceWorldPatches(s);
        refreshGeometry();
        return { surface: surfaceInfo(s) };
    },
    canvas_fill_surface: a => {
        editingOnly();
        const s = findSurface(a.surface);
        if (s.strokes.length && a.overwrite !== true) fail(`"${s.name}" has ${s.strokes.length} brush stroke(s); pass overwrite: true to repaint it.`);
        beginEdit("Fill surface");
        if (s.strokes.length) { s.strokes = []; s.bases = {}; }
        paintFlat(s, parseColor(a.color, [255, 255, 255]));
        return { surface: s.name };
    },
    canvas_delete: a => {
        editingOnly();
        const n = findNode(a.ref);
        const removedIds = new Set<string>();
        if (n.surface) { removedIds.add(n.surface.id); deleteSurface(n.surface); }
        else {
            const g = n.group!;
            removedIds.add(g.id);
            if (a.deleteChildren === true) {
                const under = (id: string): string[] => [id, ...groups.filter(o => o.parentId === id).flatMap(o => under(o.id))];
                const doomed = new Set(under(g.id));
                for (const s of surfaces.filter(s => s.parentId && doomed.has(s.parentId))) { removedIds.add(s.id); deleteSurface(s); }
                beginEdit("Delete group");
                groups = groups.filter(o => !doomed.has(o.id)); doomed.forEach(id => removedIds.add(id));
                for (const clip of clips) clip.tracks = clip.tracks.filter(t => !doomed.has(t.targetId));
                if (world.player && doomed.has(world.player)) world.player = null;
                activeGroupId = null;
            } else { removeGroup(g); if (world.player === g.id) world.player = null; }
        }
        refreshGeometry();
        return { removed: removedIds.size, orphanedLogicNodes: logic.nodes.filter(node => removedIds.has(node.target)).length };
    },
    canvas_create_group: a => {
        editingOnly();
        if (groups.length >= 128) fail("A scene holds at most 128 groups.");
        if (typeof a.name !== "string" || !a.name.trim()) fail("name is required.");
        beginEdit("New group");
        const parent = a.parent !== undefined && a.parent !== null ? findGroup(a.parent) : null;
        const g: Group = { ...defaultTransform(), id: Entropy.generateUUID(), name: uniqueName(a.name.trim().slice(0, 80), groupNameTaken), parentId: parent?.id ?? null, frame: identity(),
            position: a.position === undefined ? [0, 0, 0] : [...vec(a.position, "position")] as Vec3, rotation: [0, a.yaw === undefined ? 0 : angle(a.yaw, "yaw"), 0] };
        groups.push(g);
        return { group: groupInfo(g) };
    },
    canvas_update_group: a => {
        editingOnly();
        const g = findGroup(a.group);
        beginEdit("Update group");
        if (a.parent !== undefined) { try { parentNode(g, a.parent === null ? null : findGroup(a.parent).id); } catch (e) { fail((e as Error).message); } }
        if (typeof a.name === "string" && a.name.trim()) { const name = a.name.trim().slice(0, 80); if (name !== g.name) g.name = uniqueName(name, groupNameTaken); }
        if (a.position !== undefined) g.position = [...vec(a.position, "position")] as Vec3;
        if (a.scale !== undefined) { const sc = vec(a.scale, "scale"); if (sc.some(n => n < 0.001)) fail("scale values must be above 0."); g.scale = sc as Vec3; }
        g.rotation = [a.pitch === undefined ? g.rotation[0] : angle(a.pitch, "pitch"), a.yaw === undefined ? g.rotation[1] : angle(a.yaw, "yaw"), a.roll === undefined ? g.rotation[2] : angle(a.roll, "roll")];
        for (const s of surfaces) s.worldPatches = buildSurfaceWorldPatches(s);
        refreshGeometry();
        return { group: groupInfo(g) };
    },
    canvas_list_prefabs: () => ({
        prefabs: PREFAB_IDS.map(id => ({ id, description: PREFABS[id].description, params: PREFABS[id].params, surfaces: buildPrefab(id, {}).parts.length })),
    }),
    canvas_add_prefab: a => {
        editingOnly();
        const p = vec(a.position, "position", Array.isArray(a.position) && a.position.length === 3 ? 3 : 2);
        const at: Vec3 = p.length === 3 ? [p[0], p[1], p[2]] : [p[0], 0, p[1]];
        const made = placePrefab(String(a.prefab), a.params ?? {}, at, a.yaw === undefined ? 0 : angle(a.yaw, "yaw"), typeof a.name === "string" ? a.name : undefined);
        return { group: groupInfo(made.group), surfaces: made.made.map(s => ({ id: s.id, name: s.name })), footprintRadius: r3(made.footprint) };
    },
    canvas_create_clip: a => {
        editingOnly();
        if (typeof a.name !== "string" || !a.name.trim()) fail("name is required.");
        if (clips.length >= 128) fail("A scene holds at most 128 clips.");
        if (clips.some(c => c.name === a.name.trim())) fail(`A clip named "${a.name.trim()}" already exists.`);
        if (typeof a.duration !== "number" || !(a.duration >= 0.1 && a.duration <= 3600)) fail("duration must be 0.1 to 3600 seconds.");
        beginEdit("New clip");
        const clip: Clip = { id: Entropy.generateUUID(), name: a.name.trim().slice(0, 80), duration: a.duration, tracks: [] };
        clips = [...clips, clip];
        return { clip: { id: clip.id, name: clip.name, duration: clip.duration } };
    },
    canvas_set_keyframes: a => {
        editingOnly();
        const clip = findClip(a.clip), id = nodeId(a.target);
        const channel = a.channel as Channel;
        if (!["x", "y", "z", "pitch", "yaw", "roll", "sx", "sy", "sz"].includes(channel)) fail("channel must be x, y, z, pitch, yaw, roll, sx, sy or sz.");
        if (!Array.isArray(a.keys) || !a.keys.length || a.keys.length > 200) fail("keys must be a list of 1 to 200 {time, value}.");
        const times = new Set<number>();
        for (const k of a.keys) {
            if (typeof k?.time !== "number" || typeof k?.value !== "number" || !Number.isFinite(k.time) || !Number.isFinite(k.value) || k.time < 0 || k.time > clip.duration) fail(`Each key needs a time from 0 to the clip's ${clip.duration} s and a numeric value.`);
            if (times.has(k.time)) fail("Two keys share the same time.");
            if (channel.startsWith("s") && k.value < 0.001) fail("Scale values must be above 0.");
            times.add(k.time);
        }
        beginEdit("Set keyframes");
        clip.tracks = clip.tracks.filter(t => !(t.targetId === id && t.channel === channel));
        for (const k of a.keys) setKey(clip, id, channel, k.time, k.value);
        return { clip: clip.name, target: nameOf(id), channel, keys: a.keys.length };
    },
    canvas_delete_clip: a => {
        editingOnly();
        const clip = findClip(a.clip);
        beginEdit("Delete clip");
        clips = clips.filter(c => c !== clip);
        if (selectedClipId === clip.id) selectedClipId = clips[0]?.id ?? null;
        return { orphanedLogicNodes: logic.nodes.filter(n => n.target === clip.id).length };
    },
    canvas_get_logic: () => logicInfo(),
    canvas_add_rule: a => {
        editingOnly();
        const rule = resolveRule(a);
        const next = appendRule(logic, rule, () => Entropy.generateUUID());
        beginEdit("Add logic rule");
        const added = next.nodes.length - logic.nodes.length;
        logic = next;
        return { nodesAdded: added, totalNodes: logic.nodes.length, problems: logicInfo().problems };
    },
    canvas_add_collectible: a => {
        editingOnly();
        if (typeof a.counter !== "string" || !a.counter.trim()) fail("counter is required.");
        const counter = a.counter.trim();
        const rule = resolveRule({
            when: { type: "near", target: a.target, distance: a.distance ?? 1.2 }, once: true,
            then: [{ do: "hide", target: a.target }, { do: "add", counter, amount: a.amount ?? 1 }, { do: "message", text: a.message ?? `Collected: ${counter} {${counter}}` }],
        });
        const next = appendRule(logic, rule, () => Entropy.generateUUID());
        beginEdit("Add collectible");
        logic = next;
        return { totalNodes: logic.nodes.length };
    },
    canvas_set_logic: a => {
        editingOnly();
        if (!Array.isArray(a.nodes)) fail("nodes must be a list.");
        const base = a.append === true ? logic : emptyLogic();
        const ids = new Map<string, string>();
        const nodes: LogicNode[] = a.nodes.map((n: Args, i: number) => {
            if (!LOGIC_KINDS.includes(n.kind)) fail(`nodes[${i}].kind "${n.kind}" is not one of ${LOGIC_KINDS.join(", ")}.`);
            const id = Entropy.generateUUID();
            if (typeof n.id === "string") { if (ids.has(n.id)) fail(`Two nodes use the id "${n.id}".`); ids.set(n.id, id); }
            const node = logicNode(id, n.kind, Array.isArray(n.position) ? [Number(n.position[0]), Number(n.position[1])] : [30 + (base.nodes.length + i) % 4 * 220, 30 + Math.floor((base.nodes.length + i) / 4) * 110]);
            if (n.target !== undefined && n.target !== "") node.target = n.kind === "clip" ? findClip(n.target).id : nodeId(n.target);
            if (n.text !== undefined) node.text = String(n.text);
            if (n.seconds !== undefined) node.seconds = Number(n.seconds);
            if (n.variable !== undefined) node.variable = String(n.variable);
            if (n.amount !== undefined) node.amount = Number(n.amount);
            if (n.distance !== undefined) node.amount = Number(n.distance);
            if (n.op !== undefined) node.op = n.op;
            return node;
        });
        const lookup = (ref: unknown): string => ids.get(String(ref)) ?? fail(`Connection refers to an unknown node id "${ref}".`);
        const connections = (a.connections ?? []).map((c: Args) => ({ fromNode: lookup(c.from), fromPin: "next", toNode: lookup(c.to), toPin: "in" }));
        const next: LogicGraph = { nodes: [...base.nodes, ...nodes], connections: [...base.connections, ...connections] };
        try { validateLogic(next); } catch (e) { fail((e as Error).message); }
        beginEdit("Set gameplay logic");
        logic = next;
        return { nodeIds: Object.fromEntries(ids), problems: logicInfo().problems };
    },
    canvas_clear_logic: a => { editingOnly(); void a; beginEdit("Clear gameplay logic"); logic = emptyLogic(); return {}; },
    canvas_set_world: a => {
        editingOnly();
        beginEdit("Set world");
        if (a.player !== undefined) {
            if (a.player === null) world.player = null;
            else {
                const n = findNode(a.player);
                const node = n.surface ?? n.group!;
                if (node.parentId) fail("The player must be a root group or surface (not inside another group).");
                world.player = node.id;
            }
        }
        if (a.bounds !== undefined) { if (typeof a.bounds !== "number" || !(a.bounds >= 1 && a.bounds <= 1000)) fail("bounds must be 1 to 1000."); world.bounds = a.bounds; }
        return { world: worldInfo() };
    },
    canvas_set_lighting: a => {
        editingOnly();
        const { preset, ...fields } = a;
        if (preset !== undefined && !LIGHTING_PRESETS[preset]) fail(`preset must be one of ${LIGHTING_PRESET_NAMES.join(", ")}.`);
        let next: LightingSettings;
        try { next = mergeLighting(preset ? cloneLighting(LIGHTING_PRESETS[preset]) : world.lighting, fields); } catch (e) { throw new Error((e as Error).message); }
        beginEdit("Change lighting");
        world.lighting = next;
        applyLighting();
        return { lighting: world.lighting };
    },
    canvas_set_camera: a => {
        editingOnly();
        if (a.focus !== undefined) {
            const bounds = subtreeBounds(nodeId(a.focus));
            if (!bounds) fail("Nothing to frame: that group has no surfaces.");
            const b = bounds!;
            const centre = [0, 1, 2].map(i => (b.min[i] + b.max[i]) / 2) as Vec3;
            const radius = Math.hypot(...subV(b.max, b.min)) / 2;
            const distance = typeof a.distance === "number" ? a.distance : Math.max(6, radius * 3);
            applyView({ position: [centre[0], centre[1] + distance * 0.6, centre[2] + distance * 0.8], target: centre });
        } else {
            const view = currentView();
            applyView({ position: a.position !== undefined ? vec(a.position, "position") as Vec3 : view.position, target: a.target !== undefined ? vec(a.target, "target") as Vec3 : view.target });
        }
        return { camera: { position: r3v(currentView().position), target: r3v(currentView().target) } };
    },
    canvas_play: () => {
        if (gameSession) return { playing: true, already: true };
        startGame();
        if (!gameSession) fail(statusMessage || "Play could not start.");
        return { playing: true, walking: !!gameRun?.hasPlayer, message: statusMessage };
    },
    canvas_stop: () => { if (gameSession) stopGame(); return { playing: false }; },
    canvas_get_play_state: () => {
        if (!gameSession || !gameRun) return { playing: false };
        const p = gameRun.position();
        return { playing: true, walking: gameRun.hasPlayer, message: gameRun.message, counters: Object.fromEntries(gameSession.vars), prompt: gameRun.prompt(), player: p ? r3v(p) : null, hiddenByGame: surfaces.filter(s => !s.visible).map(s => s.name) };
    },
    canvas_playtest: a => {
        editingOnly();
        if (!Array.isArray(a.steps) || a.steps.length > 200) fail("steps must be a list of at most 200 steps.");
        return runPlaytest(a.steps);
    },
    canvas_undo: a => {
        editingOnly();
        const n = Math.max(1, Math.min(50, Math.round(typeof a.steps === "number" ? a.steps : 1)));
        const labels: string[] = [];
        for (let i = 0; i < n && history.undoLabel; i++) { labels.push(history.undoLabel); undo(); }
        return { undone: labels };
    },
    canvas_redo: () => { editingOnly(); const label = history.redoLabel; if (label) redo(); return { redone: label ?? null }; },
};

for (const name of CANVAS_TOOL_NAMES) {
    const definition = CANVAS_TOOLS[name];
    const allowed = Object.keys(definition.parameters.properties);
    addon.registerTool({ name, description: definition.description, parameters: definition.parameters }, (args: Args) => {
        try {
            if (!lightingBufferId || !historyReady) fail("Canvas Surfaces is still starting. Try again in a moment.");
            const given = args && typeof args === "object" ? args : {};
            const extra = Object.keys(given).filter(k => !allowed.includes(k));
            if (extra.length) fail(`Unknown argument(s): ${extra.join(", ")}. Valid: ${allowed.join(", ") || "(none)"}.`);
            for (const key of definition.parameters.required ?? []) if (given[key] === undefined) fail(`Missing required argument: ${key}.`);
            const result = TOOL_HANDLERS[name](given);
            history.commit();
            return { success: true, ...(result as object) };
        } catch (error) {
            history.cancel(); // roll back anything a half-applied call changed

            return { success: false, error: (error as Error).message };
        }
    });
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
                    { binding: 2, visibility: ["Fragment"], resourceType: "Uniform" },
                    { binding: 3, visibility: ["Fragment"], resourceType: "Uniform" },
                ]
            }
        ]
    });

    lightingBufferId = Entropy.Buffer.create({ size: LIGHTING_FLOATS * 4, usage: "Uniform" });
    // The procedural sky pass (src/core/render_addon_frame.rs) always runs, but only ever gets
    // colors written into it when something sets a sky config - a bare EntropyApp with no
    // world_state level has none, so without this call the pass draws whatever's left in its
    // uniform buffer's default (reads as black). This isn't a clear-color change, it's supplying
    // the config the always-on pass was missing. pending_sun_config is read every frame (never
    // consumed), so one call here is enough for the whole session.
    applyLighting();
    spawnGroundGrid();

    // Default engine game_mode is `true` (src/app.rs) - the gizmo render pass is gated on
    // `!game_mode` (src/core/render_addon_frame.rs) and game_composer_addon.ts only ever shows a
    // gizmo after its own `Entropy.setGameMode(false)`. This engine flag enables the gizmo
    // renderer; the addon's separate Play session hides gizmos and gates gameplay input.
    Entropy.setGameMode(false);

    Entropy.Camera.setTransform([0, 1.6, 6], [0, 1.2, 0]);
    // trigger:"always" + button:1 (right mouse button) instead of the default shift+left-drag -
    // easier to hold with a stylus in the drawing hand, and leaves plain left-drag free for
    // drawing/gizmo use without a modifier key. invertX: real hardware feedback - dragging felt
    // backwards from the natural expectation with the default (unflipped) sign.
    Entropy.Controls.enable("orbit", { target: [0, 1.2, 0], trigger: "always", button: 1, invertX: true });

    spawnSurface([0, 1.5, 0], 0);

    loadPreferences();
    try {
        sceneLibrary.read();
        selectedSceneId = sceneLibrary.entries[0]?.id ?? null;
        libraryReady = true;
    } catch (error) { statusMessage = `Scene library: ${error instanceof Error ? error.message : String(error)}`; }
    setupUI();
    historyReady = true;
    Entropy.println("[canvas-surfaces] initialized");
});

addon.onUpdatePlus("Global", (_time: number) => {
    if (gameRun && gameSession && Number.isFinite(_time)) {
        const run = gameRun;
        const delta = gamePreviousTime === null ? 0 : Math.max(0, _time - gamePreviousTime);
        gamePreviousTime = _time;
        runGameAction(() => {
            if (run.hasPlayer) {
                camYaw += ((held("q", "Q") ? 1 : 0) - (held("r", "R") ? 1 : 0)) * 1.8 * delta;
                run.walk(cameraRelative(moveInput(), camYaw), delta);
            }
            run.tick(delta);
        });
        if (gameRun === run && run.hasPlayer) {
            if (run.moved) { refreshGeometry(); run.moved = false; }
            placeFollowCamera();
        }
    }
    if (usingStylusClearPending) {
        usingStylusClearPending = false;
        usingStylus = false;
    }
    if (!pointerHeld && !penHeld) history.commit();
    savePreferences();
    if (pendingOrbit && --pendingOrbit.frames <= 0) {
        Entropy.Controls.enable("orbit", { target: pendingOrbit.target, trigger: "always", button: 1, invertX: true });
        pendingOrbit = null;
    }
    if (playing && currentClip() && Number.isFinite(_time)) {
        const delta = previousTime === null ? 0 : Math.max(0, _time - previousTime);
        previousTime = _time;
        previewAt(playhead + delta);
        if (playhead >= currentClip()!.duration) playing = false;
    }
    updateBrushPreview();
    if (mode === "move") syncGizmoToSelection();
    for (const s of practiceSurface ? [...surfaces, practiceSurface] : surfaces) {
        if (s.dirty) {
            Entropy.Texture.update(s.textureId, s.canvas);
            s.dirty = false;
        }
    }
});
