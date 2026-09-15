// Hand-drawn 3D level building: anchored, movable canvas surfaces an artist draws on directly
// with a tablet, as an in-engine alternative to sculpting or round-tripping through a separate
// DCC tool. This is Phase 1 of the epic (see the canvas-surfaces-phase1 card in
// cc-manager/tasks.json for the full architecture note) - it covers create/position a surface,
// pressure/tilt stylus drawing on it, detach/relocate, "it's already the real level" (no export
// step), and viewing from a free camera. Bend/curve and stroke grouping are separate follow-up
// phases (canvas-surfaces-phase2-bend / -phase3-grouping), deliberately not attempted here.
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
// world = Ry(yaw) * Rx(pitch) * Rz(roll) * local.
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
function addV(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subV(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dotV(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function crossV(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
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
    normal: Vec3; // one representative world-space normal per patch - the shader ignores it (unlit), kept only for vertex-buffer completeness
}

function buildSurfaceWorldPatches(s: Surface): WorldPatch[] {
    return shapePatches(s).map(patch => {
        const verts: Vec3[][] = [];
        const uv: Array<Array<{ u: number; v: number }>> = [];
        for (let row = 0; row < patch.rows; row++) {
            const vRow: Vec3[] = [];
            const uvRow: Array<{ u: number; v: number }> = [];
            for (let col = 0; col < patch.cols; col++) {
                vRow.push(addV(localToWorldDir(patch.localPoint(row, col), s.yaw, s.pitch, s.roll), s.position));
                uvRow.push(patch.uvAt(row, col));
            }
            verts.push(vRow);
            uv.push(uvRow);
        }
        const repRow = Math.min(1, patch.rows - 2), repCol = Math.min(1, patch.cols - 2);
        const normal = localToWorldDir(patch.outwardAt(repRow, repCol), s.yaw, s.pitch, s.roll);
        return { rows: patch.rows, cols: patch.cols, verts, uv, winding: patchWinding(patch), normal };
    });
}

interface Surface {
    id: string;
    meshId: string;
    textureId: string;
    name: string;
    kind: ShapeKind;
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
    canvas: Uint8Array;
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

function clearCanvasBuffer(canvas: Uint8Array): void {
    for (let i = 0; i < canvas.length; i += 4) {
        canvas[i] = BACKGROUND[0];
        canvas[i + 1] = BACKGROUND[1];
        canvas[i + 2] = BACKGROUND[2];
        canvas[i + 3] = 255;
    }
}

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
                const { u, v } = patch.uv[row][col];
                vertexData.push(wx, wy, wz, patch.normal[0], patch.normal[1], patch.normal[2], u, v, 1, 1, 1, 1);
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
    s.position = snap ? snapPosition(s, candidate) : candidate;
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
function spawnSurface(
    position: Vec3, yaw: number, kind: ShapeKind = "plane",
    halfW = DEFAULT_HALF_SIZE, halfH = DEFAULT_HALF_SIZE, halfD = DEFAULT_HALF_DEPTH, radius = DEFAULT_RADIUS
): Surface {
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
        kind,
        position,
        yaw,
        pitch: 0,
        roll: 0,
        halfW,
        halfH,
        halfD,
        radius,
        bend: 0,
        bendAxis: "y",
        canvas,
        dirty: false,
        visible: true,
        worldPatches: [],
    };

    createSurfaceMesh(s);

    surfaces.push(s);
    activeSurfaceId = s.id;
    Entropy.println(`[canvas-surfaces] spawned ${s.name} (${kind}) (${id}) at [${position.map(n => n.toFixed(2))}]`);
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

// Generic over all four kinds - each UI slider only ever passes the one or two dimensions that
// actually apply to the selected surface's kind (see renderUI's per-kind slider set), leaving the
// others untouched.
function setSurfaceDimensions(s: Surface, dims: Partial<{ halfW: number; halfH: number; halfD: number; radius: number }>): void {
    if (dims.halfW !== undefined) s.halfW = Math.max(0.1, dims.halfW);
    if (dims.halfH !== undefined) s.halfH = Math.max(0.1, dims.halfH);
    if (dims.halfD !== undefined) s.halfD = Math.max(0.1, dims.halfD);
    if (dims.radius !== undefined) s.radius = Math.max(0.1, dims.radius);
    pushSurfaceTransform(s);
}

function setSurfaceBend(s: Surface, bend: number): void {
    s.bend = Math.max(-1, Math.min(1, bend));
    pushSurfaceTransform(s);
}

function setSurfaceBendAxis(s: Surface, axis: BendAxis): void {
    if (s.bendAxis === axis) return;
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
function raycastSurfaceMesh(s: Surface, origin: Vec3, dir: Vec3): SurfaceHit | null {
    let best: { t: number; u: number; v: number } | null = null;

    for (const patch of s.worldPatches) {
        const [i0, i1, i2, i3, i4, i5] = patch.winding;
        for (let row = 0; row < patch.rows - 1; row++) {
            for (let col = 0; col < patch.cols - 1; col++) {
                const cornerV = [patch.verts[row][col], patch.verts[row][col + 1], patch.verts[row + 1][col], patch.verts[row + 1][col + 1]];
                const cornerUV = [patch.uv[row][col], patch.uv[row][col + 1], patch.uv[row + 1][col], patch.uv[row + 1][col + 1]];

                let hit = rayTriangleIntersect(origin, dir, cornerV[i0], cornerV[i1], cornerV[i2]);
                if (hit && (!best || hit.t < best.t)) {
                    const w0 = 1 - hit.bu - hit.bv, w1 = hit.bu, w2 = hit.bv;
                    best = { t: hit.t, u: w0 * cornerUV[i0].u + w1 * cornerUV[i1].u + w2 * cornerUV[i2].u, v: w0 * cornerUV[i0].v + w1 * cornerUV[i1].v + w2 * cornerUV[i2].v };
                }
                hit = rayTriangleIntersect(origin, dir, cornerV[i3], cornerV[i4], cornerV[i5]);
                if (hit && (!best || hit.t < best.t)) {
                    const w0 = 1 - hit.bu - hit.bv, w1 = hit.bu, w2 = hit.bv;
                    best = { t: hit.t, u: w0 * cornerUV[i3].u + w1 * cornerUV[i4].u + w2 * cornerUV[i5].u, v: w0 * cornerUV[i3].v + w1 * cornerUV[i4].v + w2 * cornerUV[i5].v };
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

    for (const s of surfaces) {
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
    const hit = raycastSurfaceMesh(drawTarget, ray.origin, ray.direction);
    // Off the edge of the surface mid-stroke (or the ray missed it entirely, e.g. grazing a bent
    // surface's back side): skip painting this segment but keep drawTarget/lastStrokePoint alive
    // so re-entering the surface continues the same stroke rather than starting a fresh one.
    if (!hit) return;
    const point: StrokePoint = { px: hit.px, py: hit.py, pressure, tiltX, tiltY };
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
