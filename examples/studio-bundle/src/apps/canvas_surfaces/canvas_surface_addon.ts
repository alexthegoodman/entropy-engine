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
import { DEFAULT_PAINT_SETTINGS, blendPixel, compositePixel, compositeLayers, pressureResponse, stabilizePoint } from "./canvas_paint";
import type { PaintLayer, PaintSettings, RGB } from "./canvas_paint";
import { SceneLibrary } from "./canvas_scene_library";
import { bytesToBase64, base64ToBytes, validateScene } from "./canvas_scene_format";
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
/** Stable clip names are the future interaction entry point. */
export function playCanvasClip(name: string): boolean {
    const clip = clips.find(c => c.name === name);
    if (!clip) return false;
    stopPreview(); selectedClipId = clip.id; previewAt(0); playing = true; previousTime = null; return true;
}


// Snapshots share unchanged canvases. Paint gestures copy only their target canvas before
// writing; moving a surface therefore costs metadata, not another 2.3 MB bitmap.
type SurfaceState = Omit<Surface, "worldPatches" | "dirty" | "canvas">;
interface SceneState { surfaces: SurfaceState[]; activeId: string | null; sceneId: string | null; sceneName: string; groups: Group[]; clips: Clip[]; activeGroupId: string | null; selectedClipId: string | null; selectedStrokeId: string | null; }
let historyReady = false;
let restoringHistory = false;
let pointerHeld = false;
let penHeld = false;
let gestureCanvases = new Set<string>();

function captureScene(): SceneState {
    return {
        activeId: activeSurfaceId, sceneId: currentSceneId, sceneName, groups: JSON.parse(JSON.stringify(groups)), clips: JSON.parse(JSON.stringify(clips)), activeGroupId, selectedClipId, selectedStrokeId,
        surfaces: surfaces.map(({ worldPatches: _patches, dirty: _dirty, canvas: _canvas, ...s }) => ({
            ...s, position: [...s.position], scale: [...s.scale], pivot: [...s.pivot], frame: [...s.frame], layers: s.layers.map(layer => ({ ...layer, pixels: editingPixels.get(layer.id) ?? layer.pixels })),
        })),
    };
}

function sameScene(a: SceneState, b: SceneState): boolean {
    // Selection alone is not an edit. Keep it in snapshots to restore a deleted selection.
    return JSON.stringify(a.groups) === JSON.stringify(b.groups) && JSON.stringify(a.clips) === JSON.stringify(b.clips) && a.sceneId === b.sceneId && a.sceneName === b.sceneName && a.surfaces.length === b.surfaces.length && a.surfaces.every((s, i) => {
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
    restore?: { id?: string; parentId?: string | null; frame?: Matrix; scale?: Vec3; pivot?: Vec3; strokes?: RetainedStroke[]; bases?: Record<string, Uint8Array>; name?: string; pitch?: number; roll?: number; bend?: number; bendAxis?: BendAxis; canvas?: Uint8Array; visible?: boolean; layers?: PaintLayer[]; activeLayerId?: string; cutMask?: Uint8Array }
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
    if (!preview && pointerKnown && mode === "draw" && !orbitButtonDown && !Entropy.Input.isPointerOverUI()) {
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
    if (preview || activeGroupId) return;
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
function serializeScene(): SavedScene {
    return {
        version: 3, groups, clips,
        surfaces: surfaces.map((s): SavedSurface => ({
            id: s.id, parentId: s.parentId, frame: s.frame, scale: s.scale, pivot: s.pivot, strokes: s.strokes,
            name: s.name, kind: s.kind, position: [...s.position],
            yaw: s.yaw, pitch: s.pitch, roll: s.roll,
            halfW: s.halfW, halfH: s.halfH, halfD: s.halfD, radius: s.radius,
            bend: s.bend, bendAxis: s.bendAxis, visible: s.visible,
            activeLayerId: s.activeLayerId, cutMaskBase64: bytesToBase64(s.cutMask),
            layers: s.layers.map(layer => ({
                id: layer.id, name: layer.name, visible: layer.visible, locked: layer.locked,
                opacity: layer.opacity, basePixelsBase64: s.bases[layer.id] ? bytesToBase64(s.bases[layer.id]) : undefined, pixelsBase64: bytesToBase64(layer.pixels),
            })),
        })),
    };
}
function saveScene(asNew = false): boolean {
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
            layers: saved.layers?.map(({ pixelsBase64, basePixelsBase64: _base, ...layer }) => ({ ...layer, pixels: base64ToBytes(pixelsBase64) })),
            bases: Object.fromEntries((saved.layers ?? []).filter(layer => layer.basePixelsBase64).map(layer => [layer.id, base64ToBytes(layer.basePixelsBase64!)])),
            cutMask: saved.cutMaskBase64 ? base64ToBytes(saved.cutMaskBase64) : undefined,
        }));
        const name = sceneLibrary.entries.find(entry => entry.id === id)!.name;
        requestSceneAction(`Load ${name}`, () => {
            beginEdit("Load scene");
            for (const s of [...surfaces]) deleteSurface(s);
            groups = JSON.parse(JSON.stringify(scene.groups ?? [])); clips = JSON.parse(JSON.stringify(scene.clips ?? [])); activeGroupId = null; selectedClipId = clips[0]?.id ?? null; selectedStrokeId = null;
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

const AMBIENT: f32 = 0.45;
const LIGHT1_POS = vec3<f32>(4.0, 5.0, 3.0);
const LIGHT1_COLOR = vec3<f32>(1.0, 0.96, 0.88);
const LIGHT1_INTENSITY: f32 = 1.1;
const LIGHT2_POS = vec3<f32>(-4.0, 3.0, -3.5);
const LIGHT2_COLOR = vec3<f32>(0.55, 0.65, 0.95);
const LIGHT2_INTENSITY: f32 = 0.7;

fn point_light_diffuse(world_pos: vec3<f32>, n: vec3<f32>, light_pos: vec3<f32>, light_color: vec3<f32>, intensity: f32) -> vec3<f32> {
    let to_light = light_pos - world_pos;
    let dist = length(to_light);
    let l = to_light / max(dist, 0.0001);
    let ndotl = max(dot(n, l), 0.0);
    let atten = 1.0 / (1.0 + 0.06 * dist + 0.012 * dist * dist);
    return light_color * intensity * ndotl * atten;
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
    var lighting = vec3<f32>(AMBIENT, AMBIENT, AMBIENT);
    lighting += point_light_diffuse(in.world_pos, n, LIGHT1_POS, LIGHT1_COLOR, LIGHT1_INTENSITY);
    lighting += point_light_diffuse(in.world_pos, n, LIGHT2_POS, LIGHT2_COLOR, LIGHT2_INTENSITY);
    var lit_rgb = sampled.rgb * in.color.rgb * lighting;
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

function setupUI(): void {
    uiWindowId = Entropy.UI.createWindow({
        title: "Canvas Surfaces",
        width: 310,
        height: Math.max(420, Entropy.Window.getSize()[1] - 40),
        x: 16,
        y: 16,
        onRender: renderUI
    });
    layersWindowId = uiWindowId;
}

/** A small editable creation that exercises the same data used by hand-authored scenes. */
function createAnimatedExample(): void {
    requestSceneAction("Open animated character example", () => {
        beginEdit("Animated character example");
        for (const s of [...surfaces]) deleteSurface(s);
        groups = []; clips = []; markedNodes.clear(); selectedStrokeId = null;
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
        history.commit(); savedSceneState = null; pendingSceneAction = null;
        applyView({ position: [0, 2.0, 8], target: [0, 1.7, 0] });
        statusMessage = "Example ready. Play Wave and smile, or select a part to edit it.";
    });
}

let parentChoice: string | null = null;
let channelChoice: Channel = "roll";
let keyValue = 0;
const markedNodes = new Set<string>();
const collapsedGroups = new Set<string>();
function selectedNode(): Group | Surface | undefined { return activeGroupId ? groups.find(g => g.id === activeGroupId) : activeSurface() ?? undefined; }
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
function renderAnimationUI(): void {
    const W = Entropy.UI.Widget;
    const button = (id: string, text: string, onClick: () => void) => W.button(uiWindowId, { id, text, onClick });
    const slider = (id: string, label: string, value: number, min: number, max: number, change: (value: number) => void) => W.slider(uiWindowId, { id, label, value, min, max, onChange: value => { const n = Number(value); if (Number.isFinite(n)) change(Math.max(min, Math.min(max, n))); } });
    W.label(uiWindowId, { text: preview ? "PREVIEW - return to edit to draw" : "Select or mark parts, then group them." });
    button("animation_stop", "Return to editing pose", stopPreview);
    const tree = (parent: string | null, depth: number) => {
        for (const node of [...groups, ...surfaces].filter(n => n.parentId === parent)) {
            const isGroup = groups.some(g => g.id === node.id);
            button(`node_${node.id}`, `${"  ".repeat(depth)}${selectedNode()?.id === node.id ? "> " : ""}${isGroup ? "Group: " : ""}${node.name}`, () => {
                if (isGroup) { activeGroupId = node.id; selectedStrokeId = null; if (activeGizmoId) { Entropy.Gizmo.hide(activeGizmoId); activeGizmoId = null; } }
                else selectSurface(node as Surface);
            });
            button(`mark_${node.id}`, markedNodes.has(node.id) ? "Unmark part" : "Mark part", () => { if (markedNodes.has(node.id)) markedNodes.delete(node.id); else markedNodes.add(node.id); });
            if (isGroup) {
                button(`group_expand_${node.id}`, collapsedGroups.has(node.id) ? "Expand group" : "Collapse group", () => { if (collapsedGroups.has(node.id)) collapsedGroups.delete(node.id); else collapsedGroups.add(node.id); });
                if (!collapsedGroups.has(node.id)) tree(node.id, depth + 1);
            }
        }
    };
    tree(null, 0);
    button("group_create", "Group marked / selected", makeGroup);
    button("animated_example", "Open animated character example", createAnimatedExample);
    const node = selectedNode();
    if (node) {
        W.textInput(uiWindowId, { label: "Part name", id: "node_name", value: node.name, onChange: value => { beginEdit("Rename part"); node.name = String(value).slice(0, 80); } });
        button("parent_choice", `Parent: ${groups.find(g => g.id === parentChoice)?.name ?? "World"}`, () => {
            const options = [null, ...groups.filter(g => g.id !== node.id).map(g => g.id)]; parentChoice = options[(options.indexOf(parentChoice) + 1) % options.length];
        });
        button("parent_apply", "Attach to chosen parent", () => {
            try { const frame = reparentFrame(groups, node.id, node.parentId, parentChoice, node.frame); beginEdit("Reparent part"); node.frame = frame; node.parentId = parentChoice; refreshGeometry(); }
            catch (error) { statusMessage = String(error); }
        });
        if (activeGroupId) button("group_remove", "Ungroup (keep parts)", () => removeGroup(node as Group));
        const transform = "yaw" in node ? surfaceTransform(node) : node;
        W.collapsingHeader(uiWindowId, "Part transform & pivot", () => {
        for (const [index, axis] of ["x", "y", "z"].entries()) {
            slider(`node_pos_${axis}`, `Local ${axis}`, transform.position[index], -20, 20, value => { beginEdit("Move part"); node.position[index] = value; refreshGeometry(); });
            slider(`node_rotation_${axis}`, `Rotate ${axis} (rad)`, transform.rotation[index], -Math.PI, Math.PI, value => {
                beginEdit("Rotate part");
                if ("yaw" in node) { if (index === 0) node.pitch = value; if (index === 1) node.yaw = value; if (index === 2) node.roll = value; }
                else node.rotation[index] = value;
                refreshGeometry();
            });
            slider(`node_scale_${axis}`, `Scale ${axis}`, node.scale[index], 0.05, 5, value => { beginEdit("Scale part"); node.scale[index] = value; refreshGeometry(); });
            slider(`node_pivot_${axis}`, `Pivot ${axis}`, node.pivot[index], -20, 20, value => {
                beginEdit("Set pivot");
                const before = transformMatrix("yaw" in node ? surfaceTransform(node) : node);
                node.pivot[index] = value;
                const after = transformMatrix("yaw" in node ? surfaceTransform(node) : node);
                for (let i = 0; i < 3; i++) node.position[i] += before[i * 4 + 3] - after[i * 4 + 3];
                refreshGeometry();
            });
        }
        });
    }
    const surface = !activeGroupId ? activeSurface() : null;
    for (const stroke of surface?.strokes ?? []) button(`stroke_${stroke.id}`, `${selectedStrokeId === stroke.id ? "> " : ""}${stroke.name}`, () => { selectedStrokeId = stroke.id; channelChoice = "progress"; keyValue = stroke.progress; });
    const stroke = surface?.strokes.find(st => st.id === selectedStrokeId);
    if (stroke && surface) {
        const editStroke = (change: Partial<RetainedStroke>) => { beginEdit("Edit stroke"); surface.strokes = surface.strokes.map(st => st.id === stroke.id ? { ...st, ...change } : st); replayArtwork(surface); };
        W.textInput(uiWindowId, { label: "Stroke name", id: "stroke_name", value: stroke.name, onChange: value => editStroke({ name: String(value).slice(0, 80) }) });
        button("stroke_visible", stroke.visible ? "Hide stroke" : "Show stroke", () => editStroke({ visible: !stroke.visible }));
        slider("stroke_progress", "Drawing progress", stroke.progress, 0, 1, value => editStroke({ progress: value }));
    }
    button("clip_create", "New animation clip", () => {
        beginEdit("New animation"); let number = 1; while (clips.some(c => c.name === `Clip ${number}`)) number++; const clip: Clip = { id: Entropy.generateUUID(), name: `Clip ${number}`, duration: 2, tracks: [] }; clips.push(clip); selectedClipId = clip.id; playhead = 0;
    });
    for (const clip of clips) button(`clip_${clip.id}`, `${clip.id === selectedClipId ? "> " : ""}${clip.name}`, () => { stopPreview(); selectedClipId = clip.id; playhead = 0; });
    const clip = currentClip();
    if (!clip) return;
    W.textInput(uiWindowId, { label: "Clip name", id: "clip_name", value: clip.name, onChange: value => {
        const name = String(value).trim().slice(0, 80); if (!name || clips.some(c => c !== clip && c.name === name)) return;
        beginEdit("Rename clip"); clip.name = name;
    } });
    slider("clip_duration", "Duration (seconds)", clip.duration, 0.1, 30, value => { beginEdit("Clip duration"); clip.duration = Math.max(value, ...clip.tracks.flatMap(t => t.keys.map(k => k.time))); playhead = Math.min(playhead, clip.duration); });
    slider("clip_time", "Time (seconds)", playhead, 0, clip.duration, value => { playing = false; previewAt(value); });
    button("clip_play", playing ? "Pause" : "Play", () => { if (playing) { playing = false; previousTime = null; } else { previewAt(playhead >= clip.duration ? 0 : playhead); playing = true; previousTime = null; } });
    const targetId = stroke?.id ?? node?.id;
    W.label(uiWindowId, { text: `Key target: ${stroke?.name ?? node?.name ?? "Select a part"}` });
    const channels: Channel[] = stroke ? ["progress", "visible"] : ["x", "y", "z", "pitch", "yaw", "roll", "sx", "sy", "sz"];
    if (!channels.includes(channelChoice)) channelChoice = channels[0];
    button("key_channel", `Channel: ${channelChoice}`, () => { channelChoice = channels[(channels.indexOf(channelChoice) + 1) % channels.length]; });
    const bounded = channelChoice === "progress" || channelChoice === "visible";
    slider("key_value", "Key value", keyValue, bounded ? 0 : channelChoice.startsWith("s") ? 0.05 : -20, bounded ? 1 : 20, value => { keyValue = value; });
    button("key_add", "Set key at playhead", () => {
        if (!targetId) return;
        const time = playhead; beginEdit("Set animation key");
        setKey(clip, targetId, channelChoice, time, bounded ? Math.max(0, Math.min(1, keyValue)) : channelChoice.startsWith("s") ? Math.max(0.05, keyValue) : keyValue);
        previewAt(time);
    });
    button("key_current", "Key current editing pose", () => {
        if (!targetId) return;
        const t = node && ("yaw" in node ? surfaceTransform(node) : node);
        const values: Partial<Record<Channel, number>> = stroke ? { progress: stroke.progress, visible: stroke.visible ? 1 : 0 } : t ? {
            x: t.position[0], y: t.position[1], z: t.position[2], pitch: t.rotation[0], yaw: t.rotation[1], roll: t.rotation[2], sx: t.scale[0], sy: t.scale[1], sz: t.scale[2],
        } : {};
        const value = values[channelChoice]; if (value === undefined) return;
        const time = playhead; beginEdit("Key editing pose"); setKey(clip, targetId, channelChoice, time, value); keyValue = value; previewAt(time);
    });
    for (const track of clip.tracks.filter(t => t.targetId === targetId)) for (const key of track.keys) {
        button(`key_seek_${track.channel}_${key.time}`, `${track.channel} @ ${key.time.toFixed(2)}s = ${key.value.toFixed(2)}`, () => { playing = false; previewAt(key.time); });
        button(`key_delete_${track.channel}_${key.time}`, "Delete key", () => { beginEdit("Delete key"); track.keys = track.keys.filter(k => k !== key); clip.tracks = clip.tracks.filter(t => t.keys.length); });
    }
    button("clip_delete", "Delete clip", () => { beginEdit("Delete clip"); clips = clips.filter(c => c !== clip); selectedClipId = clips[0]?.id ?? null; });
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

function renderUI(): void {
    Entropy.UI.Widget.label(uiWindowId, { text: practiceSurface ? "PRACTICE ? not saved" : `${sceneName}${sceneIsDirty() ? " *" : ""}`, bold: true });
    if (statusMessage) Entropy.UI.Widget.label(uiWindowId, { text: statusMessage });
    if (pendingSceneAction) {
        Entropy.UI.Widget.label(uiWindowId, { text: `${pendingSceneAction.label}? Unsaved changes.` });
        Entropy.UI.Widget.button(uiWindowId, { text: "Save & continue", id: "scene_confirm_save", onClick: () => { if (saveScene()) pendingSceneAction?.run(); } });
        Entropy.UI.Widget.horizontal(uiWindowId, () => {
            Entropy.UI.Widget.button(uiWindowId, { text: "Discard & continue", id: "scene_confirm_discard", onClick: () => pendingSceneAction?.run() });
            Entropy.UI.Widget.button(uiWindowId, { text: "Cancel", id: "scene_confirm_cancel", onClick: () => { pendingSceneAction = null; } });
        });
    }
    Entropy.UI.Widget.horizontal(uiWindowId, () => {
        Entropy.UI.Widget.button(uiWindowId, { text: "Undo", id: "undo", onClick: undo });
        Entropy.UI.Widget.button(uiWindowId, { text: "Redo", id: "redo", onClick: redo });
    });
    Entropy.UI.Widget.label(uiWindowId, { text: history.undoLabel ? `Undo: ${history.undoLabel}` : "No edits to undo" });
    Entropy.UI.Widget.label(uiWindowId, { text: history.redoLabel ? `Redo: ${history.redoLabel}` : "" });
    Entropy.UI.Widget.horizontal(uiWindowId, () => {
        Entropy.UI.Widget.button(uiWindowId, {
            text: (mode === "draw" ? "> " : "  ") + "Draw",
            id: "mode_draw",
            onClick: () => setMode("draw")
        });
        Entropy.UI.Widget.button(uiWindowId, {
            text: (mode === "move" ? "> " : "  ") + "Move",
            id: "mode_move",
            onClick: () => setMode("move")
        });
        Entropy.UI.Widget.button(uiWindowId, {
            text: (mode === "cut" ? "> " : "  ") + "Cut",
            id: "mode_cut",
            onClick: () => setMode("cut")
        });
    });
    Entropy.UI.Widget.horizontal(uiWindowId, () => {
        Entropy.UI.Widget.button(uiWindowId, { text: "Focus", id: "focus_surface", onClick: () => focusSurface(false) });
        Entropy.UI.Widget.button(uiWindowId, { text: "Align", id: "align_surface", onClick: () => focusSurface(true) });
        Entropy.UI.Widget.button(uiWindowId, { text: "Return", id: "return_view", onClick: restoreView });
    });
    Entropy.UI.Widget.separator(uiWindowId);

    if (mode === "draw") {
        Entropy.UI.Widget.label(uiWindowId, { text: `Brush: ${currentBrush().name}` });
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
            Entropy.UI.Widget.label(uiWindowId, { text: activeGroupId ? "Edit this group in Groups & animation." : "No surface selected - click one." });
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
                text: "Delete Surface", id: "delete_surface",
                onClick: () => deleteActiveSurface()
            });
        }
    }

    Entropy.UI.Widget.collapsingHeader(uiWindowId, "Add surface", () => {
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
            onClick: () => {
                // +1: slot 0 of this stagger grid is x=-3.5, but slot 1 is x=0 - the same spot the
                // very first surface (spawned separately in onInit, not through this grid at all)
                // already occupies. Starting one slot ahead means the first-ever click always lands
                // on a genuinely empty spot instead of silently overlapping that surface.
                const n = surfaces.length + 1;
                spawnSurface(
                    [(n % 3) * 3.5 - 3.5, 1.5, -Math.floor(n / 3) * 3.0], 0, pendingKind,
                    pendingWidth / 2, pendingHeight / 2, pendingDepth / 2, pendingRadius
                );
            }
        });

    });
    Entropy.UI.Widget.collapsingHeader(uiWindowId, "Groups & animation", renderAnimationUI);
    Entropy.UI.Widget.collapsingHeader(uiWindowId, "Scenes & export", renderSceneLibrary);
    Entropy.UI.Widget.collapsingHeader(uiWindowId, "Surfaces", renderLayersUI);
    Entropy.UI.Widget.collapsingHeader(uiWindowId, "Shortcuts", () => {
        for (const text of ["B Draw | V Move | [ ] Size", "Ctrl+Z Undo | Ctrl+Shift+Z Redo", "F Focus | Shift+F Align", "Ctrl+S Save scene", "Esc Return view / cancel cut", "Right-drag Orbit | Wheel Zoom", "Hover ring shows full-pressure size"])
            Entropy.UI.Widget.label(uiWindowId, { text });
    });
    Entropy.UI.Widget.separator(uiWindowId);
    Entropy.UI.Widget.label(uiWindowId, { text: `${surfaces.length} surface(s)` });
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

function spawnGroundGrid(): void {
    const previewBufferId = Entropy.Buffer.create({ size: 32, usage: "Uniform" });
    Entropy.Buffer.write(previewBufferId, new Float32Array(8));
    const gridTextureId = Entropy.Texture.create(1, 1, new Uint8Array([255, 255, 255, 255]));
    const { vertexData, indexData } = buildGroundGridMesh();
    Entropy.Model.createMesh({
        id: "canvas_surfaces_ground_grid",
        position: [0, 0, 0],
        vertexData,
        indexData,
        pipelineId,
        bindings: [
            { group: 2, binding: 0, resource: { type: "Texture", value: { id: gridTextureId } } },
            { group: 2, binding: 1, resource: { type: "Sampler" } },
            { group: 2, binding: 2, resource: { type: "Buffer", value: { id: previewBufferId } } },
        ],
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
                ]
            }
        ]
    });

    // The procedural sky pass (src/core/render_addon_frame.rs) always runs, but only ever gets
    // colors written into it when something sets a sky config - a bare EntropyApp with no
    // world_state level has none, so without this call the pass draws whatever's left in its
    // uniform buffer's default (reads as black). This isn't a clear-color change, it's supplying
    // the config the always-on pass was missing. pending_sun_config is read every frame (never
    // consumed), so one call here is enough for the whole session.
    Entropy.Lighting.updateSun({
        horizonColor: [0.62, 0.62, 0.66],
        zenithColor: [0.36, 0.36, 0.4],
    });
    spawnGroundGrid();

    // Default engine game_mode is `true` (src/app.rs) - the gizmo render pass is gated on
    // `!game_mode` (src/core/render_addon_frame.rs) and game_composer_addon.ts only ever shows a
    // gizmo after its own `Entropy.setGameMode(false)`. This is a creation tool, not a "game" -
    // it should stay in edit mode (gizmo visible/interactive) for its whole lifetime.
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
