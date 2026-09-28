// The Mesha component catalog: every node type a procedural object's JSON may use, in the spirit of
// Blender's Geometry Nodes (primitives, curves, curve-to-mesh, deformers, instancing). Each entry
// describes its inputs so a definition can be validated, documented and eventually shown in a node
// editor, and `build` turns resolved inputs into geometry or a curve.

import { type Mesh, type Vec2, type Vec3, join, setRegion, transformMesh, compose4, recomputeNormals, autoSmoothNormals, mapPositions } from "./mesha_mesh";
import {
    roundedBox, lathe, cylinder, capsuleProfile, sphere, icosphere, torus, extrude, sweep,
    bendY, taperY, twistY, displaceNoise, radialArray, linearArray, mirror, loft,
} from "./mesha_primitives";
import {
    circle2, ellipse2, polygon2, roundedRect2, superellipse2, star2, gear2, filletPolyline, smoothPath,
    bezier3, helix3, arc3, translate2, rotate2, scale2, resample, subdivideSegments,
} from "./mesha_curves";

export type InputKind = "number" | "int" | "bool" | "vec2" | "vec3" | "enum" | "string" | "mesh" | "meshes" | "curve2" | "curves2" | "curve3" | "points3";
export type OutputKind = "mesh" | "curve2" | "curves2" | "curve3";

export interface ComponentInput {
    name: string;
    kind: InputKind;
    default?: unknown;
    min?: number;
    max?: number;
    options?: string[];
    description: string;
}

export interface ComponentDef {
    type: string;
    category: "Mesh Primitives" | "Curve Primitives" | "Paths" | "Curve to Mesh" | "Deform" | "Instances" | "Geometry";
    label: string;
    description: string;
    inputs: ComponentInput[];
    output: OutputKind;
    build: (i: Record<string, any>) => Mesh | Vec2[] | Vec3[];
}

const n = (name: string, def: number, description: string, min?: number, max?: number): ComponentInput => ({ name, kind: "number", default: def, min, max, description });
const int = (name: string, def: number, description: string, min = 1, max = 512): ComponentInput => ({ name, kind: "int", default: def, min, max, description });
const DEG = Math.PI / 180;

const LIST: ComponentDef[] = [
    // --- Mesh primitives -----------------------------------------------------------------------
    {
        type: "mesh.box", category: "Mesh Primitives", label: "Box", output: "mesh",
        description: "A box centered on the origin with rounded edges and corners. `radius` 0 is sharp; half the smallest side is a pill.",
        inputs: [{ name: "size", kind: "vec3", default: [1, 1, 1], description: "Width, height, depth." }, n("radius", 0, "Edge rounding.", 0), int("segments", 3, "Rows per rounded band.", 1, 16), { name: "divisions", kind: "vec3", default: [1, 1, 1], description: "Extra rows across each flat side (give a box to be bent or tapered some)." }],
        build: i => roundedBox(i.size, i.radius, i.segments, "default", i.divisions),
    },
    {
        type: "mesh.cylinder", category: "Mesh Primitives", label: "Cylinder", output: "mesh",
        description: "A closed cylinder standing on y = 0 with optional rounded rims.",
        inputs: [n("radius", 0.5, "Radius.", 0), n("height", 1, "Height.", 0), int("segments", 32, "Sides.", 3), n("bevel", 0, "Rim rounding.", 0), int("bevelSegments", 3, "Rows per rim.", 1, 12)],
        build: i => cylinder(i.radius, i.height, i.segments, "default", i.bevel, i.bevelSegments),
    },
    {
        type: "mesh.cone", category: "Mesh Primitives", label: "Cone / Frustum", output: "mesh",
        description: "A closed frustum from `bottomRadius` at y = 0 to `topRadius` at `height` (0 top radius is a cone).",
        inputs: [n("bottomRadius", 0.5, "Radius at the base.", 0), n("topRadius", 0.25, "Radius at the top.", 0), n("height", 1, "Height.", 0), int("segments", 32, "Sides.", 3), n("bevel", 0, "Rim rounding.", 0)],
        build: i => lathe(capsuleProfile(i.bottomRadius, i.topRadius, i.height, i.bevel, 3), { segments: i.segments }),
    },
    {
        type: "mesh.sphere", category: "Mesh Primitives", label: "UV Sphere", output: "mesh",
        description: "A sphere centered on the origin.",
        inputs: [n("radius", 0.5, "Radius.", 0), int("segments", 32, "Around.", 3), int("rings", 16, "Pole to pole.", 2)],
        build: i => sphere(i.radius, i.segments, i.rings),
    },
    {
        type: "mesh.icosphere", category: "Mesh Primitives", label: "Ico Sphere", output: "mesh",
        description: "A sphere of evenly sized triangles, the base for rocks and other displaced organic shapes.",
        inputs: [n("radius", 0.5, "Radius.", 0), int("subdivisions", 3, "Each level quadruples the triangles.", 0, 6)],
        build: i => icosphere(i.radius, i.subdivisions),
    },
    {
        type: "mesh.torus", category: "Mesh Primitives", label: "Torus", output: "mesh",
        description: "A ring around +Y centered on the origin.",
        inputs: [n("major", 0.5, "Ring radius.", 0), n("minor", 0.1, "Tube radius.", 0), int("segments", 48, "Around the ring.", 3), int("sides", 16, "Around the tube.", 3)],
        build: i => torus(i.major, i.minor, i.segments, i.sides),
    },
    // --- 2D curves -----------------------------------------------------------------------------
    {
        type: "curve.circle", category: "Curve Primitives", label: "Circle", output: "curve2",
        description: "A closed circle in the plane.",
        inputs: [n("radius", 0.5, "Radius.", 0), int("segments", 32, "Points.", 3), { name: "center", kind: "vec2", default: [0, 0], description: "Center." }],
        build: i => circle2(i.radius, i.segments, i.center),
    },
    {
        type: "curve.ellipse", category: "Curve Primitives", label: "Ellipse", output: "curve2",
        description: "A closed ellipse.",
        inputs: [n("rx", 0.5, "X radius.", 0), n("ry", 0.3, "Y radius.", 0), int("segments", 32, "Points.", 3)],
        build: i => ellipse2(i.rx, i.ry, i.segments),
    },
    {
        type: "curve.polygon", category: "Curve Primitives", label: "Regular Polygon", output: "curve2",
        description: "A regular polygon (a hexagon for a bolt head).",
        inputs: [n("radius", 0.5, "Corner radius.", 0), int("sides", 6, "Sides.", 3, 64), n("rotation", 0, "Degrees.")],
        build: i => polygon2(i.radius, i.sides, i.rotation * DEG),
    },
    {
        type: "curve.rect", category: "Curve Primitives", label: "Rounded Rectangle", output: "curve2",
        description: "A rectangle centered on the origin with rounded corners.",
        inputs: [n("width", 1, "Width.", 0), n("height", 1, "Height.", 0), n("radius", 0, "Corner radius.", 0), int("cornerSegments", 6, "Points per corner.", 1, 32)],
        build: i => roundedRect2(i.width, i.height, i.radius, i.cornerSegments),
    },
    {
        type: "curve.superellipse", category: "Curve Primitives", label: "Superellipse", output: "curve2",
        description: "Between an ellipse (exponent 2) and a rectangle (large exponent): squircle table tops and bottles.",
        inputs: [n("width", 1, "Width.", 0), n("height", 1, "Height.", 0), n("exponent", 4, "Squareness.", 0.5, 20), int("segments", 64, "Points.", 8)],
        build: i => superellipse2(i.width / 2, i.height / 2, i.exponent, i.segments),
    },
    {
        type: "curve.star", category: "Curve Primitives", label: "Star", output: "curve2",
        description: "A star with alternating outer and inner points.",
        inputs: [n("outer", 0.5, "Tip radius.", 0), n("inner", 0.25, "Valley radius.", 0), int("points", 5, "Tips.", 2, 64)],
        build: i => star2(i.outer, i.inner, i.points),
    },
    {
        type: "curve.gear", category: "Curve Primitives", label: "Gear Outline", output: "curve2",
        description: "A spur gear's toothed outline.",
        inputs: [int("teeth", 24, "Teeth.", 3, 400), n("root", 0.45, "Root radius.", 0), n("tip", 0.5, "Tip radius.", 0), n("toothWidth", 0.45, "Tip width as a share of the pitch.", 0.1, 0.9), n("flank", 0.25, "Extra width at the root.", 0, 0.5)],
        build: i => gear2(i.teeth, i.root, i.tip, i.toothWidth, i.flank),
    },
    {
        type: "curve.points", category: "Curve Primitives", label: "Point List", output: "curve2",
        description: "A 2D polyline from literal points, optionally with every corner filleted and/or smoothed.",
        inputs: [{ name: "points", kind: "curve2", default: [], description: "[[x, y], ...]." }, n("fillet", 0, "Corner radius.", 0), int("filletSegments", 4, "Points per fillet.", 1, 32), { name: "closed", kind: "bool", default: false, description: "Treat as a loop." }, int("smooth", 0, "Catmull-Rom samples per span (0 keeps corners).", 0, 64)],
        build: i => {
            let pts: Vec2[] = i.points;
            if (i.smooth > 0) pts = smoothPath(pts, i.smooth, i.closed);
            return filletPolyline(pts, i.fillet, i.filletSegments, i.closed);
        },
    },
    {
        type: "curve.transform", category: "Curve Primitives", label: "Transform Curve", output: "curve2",
        description: "Moves, rotates (degrees) and scales a 2D curve.",
        inputs: [{ name: "curve", kind: "curve2", description: "Input." }, { name: "offset", kind: "vec2", default: [0, 0], description: "Move." }, n("rotation", 0, "Degrees."), { name: "scale", kind: "vec2", default: [1, 1], description: "Scale." }],
        build: i => translate2(rotate2(scale2(i.curve, i.scale[0], i.scale[1]), i.rotation * DEG), i.offset[0], i.offset[1]),
    },
    {
        type: "curve.sector", category: "Curve Primitives", label: "Annular Sector", output: "curve2",
        description: "A ring segment between two radii and two angles (degrees) with rounded corners: gear cut-outs, vents, arcs of trim.",
        inputs: [n("inner", 0.2, "Inner radius.", 0), n("outer", 0.4, "Outer radius.", 0), n("start", 0, "Start angle."), n("end", 60, "End angle."), n("radius", 0.02, "Corner rounding.", 0), int("segments", 24, "Points along each arc.", 2, 256)],
        build: i => {
            const a0 = i.start * DEG, a1 = i.end * DEG, m = i.segments;
            const pts: Vec2[] = [];
            for (let k = 0; k <= m; k++) { const a = a0 + ((a1 - a0) * k) / m; pts.push([Math.cos(a) * i.outer, Math.sin(a) * i.outer]); }
            for (let k = m; k >= 0; k--) { const a = a0 + ((a1 - a0) * k) / m; pts.push([Math.cos(a) * i.inner, Math.sin(a) * i.inner]); }
            return filletPolyline(pts, i.radius, 4, true);
        },
    },
    {
        type: "curve.arch", category: "Curve Primitives", label: "Arch", output: "curve2",
        description: "An opening outline: a width x height rectangle whose top is a round arch `rise` high (0 is square-topped), bottom centred on the origin. Windows, doors, niches.",
        inputs: [n("width", 1, "Width.", 0), n("height", 2, "Total height.", 0), n("rise", 0.5, "Arch height (half the width is a semicircle).", 0), int("segments", 24, "Points along the arch.", 2, 256)],
        build: i => {
            const hw = i.width / 2, rise = Math.max(0, Math.min(i.rise, i.height - 1e-4));
            const spring = i.height - rise;
            const pts: Vec2[] = [[-hw, 0], [hw, 0], [hw, spring]];
            if (rise > 1e-5) {
                // A circular segment through both springing points and the crown.
                const R = (hw * hw + rise * rise) / (2 * rise), cy = spring + rise - R;
                const a0 = Math.atan2(spring - cy, hw), a1 = Math.PI - a0;
                for (let k = 1; k < i.segments; k++) { const a = a0 + ((a1 - a0) * k) / i.segments; pts.push([Math.cos(a) * R, cy + Math.sin(a) * R]); }
            }
            pts.push([-hw, spring]);
            return pts;
        },
    },
    {
        type: "curves.linear", category: "Curve Primitives", label: "Linear Curve Copies", output: "curves2",
        description: "`count` copies of a 2D curve, each `offset` further - a row of window openings for Extrude's holes.",
        inputs: [{ name: "curve", kind: "curve2", description: "Input." }, int("count", 3, "Copies.", 1, 512), { name: "offset", kind: "vec2", default: [1, 0], description: "Step between copies." }, { name: "centered", kind: "bool", default: true, description: "Centre the row on the original." }],
        build: i => {
            const shift = i.centered ? (i.count - 1) / 2 : 0;
            return Array.from({ length: i.count }, (_, k) => translate2(i.curve, (k - shift) * i.offset[0], (k - shift) * i.offset[1])) as unknown as Vec2[];
        },
    },
    {
        type: "curves.radial", category: "Curve Primitives", label: "Radial Curve Copies", output: "curves2",
        description: "`count` copies of a 2D curve rotated evenly about the origin - a list of curves for Extrude's holes (spokes, vents, bolt circles).",
        inputs: [{ name: "curve", kind: "curve2", description: "Input." }, int("count", 6, "Copies.", 1, 512), n("startAngle", 0, "Degrees.")],
        build: i => Array.from({ length: i.count }, (_, k) => rotate2(i.curve, i.startAngle * DEG + (k / i.count) * Math.PI * 2)) as unknown as Vec2[],
    },
    // --- 3D paths ------------------------------------------------------------------------------
    {
        type: "path.points", category: "Paths", label: "Path", output: "curve3",
        description: "A 3D polyline through literal points, with filleted corners (bent tube) or a smooth spline through them.",
        inputs: [{ name: "points", kind: "points3", default: [], description: "[[x, y, z], ...]." }, n("fillet", 0, "Bend radius at each corner.", 0), int("filletSegments", 6, "Points per bend.", 1, 32), int("smooth", 0, "Spline samples per span (0 keeps corners).", 0, 64), { name: "closed", kind: "bool", default: false, description: "Loop." }, n("step", 0, "Split straight runs longer than this (so a later bend has points to move); 0 is off.", 0)],
        build: i => {
            let pts: Vec3[] = i.points;
            if (i.smooth > 0) pts = smoothPath(pts, i.smooth, i.closed);
            pts = filletPolyline(pts, i.fillet, i.filletSegments, i.closed);
            return i.step > 0 ? subdivideSegments(pts, i.step, i.closed) : pts;
        },
    },
    {
        type: "path.bezier", category: "Paths", label: "Bezier", output: "curve3",
        description: "A cubic Bezier from p0 to p3.",
        inputs: [...["p0", "p1", "p2", "p3"].map((name): ComponentInput => ({ name, kind: "vec3", default: [0, 0, 0], description: "Control point." })), int("segments", 16, "Samples.", 2)],
        build: i => bezier3(i.p0, i.p1, i.p2, i.p3, i.segments),
    },
    {
        type: "path.arc", category: "Paths", label: "Arc", output: "curve3",
        description: "An arc in the XZ plane (degrees).",
        inputs: [n("radius", 0.5, "Radius.", 0), n("start", 0, "Start angle."), n("end", 180, "End angle."), int("segments", 16, "Samples.", 1)],
        build: i => arc3(i.radius, i.start * DEG, i.end * DEG, i.segments),
    },
    {
        type: "path.helix", category: "Paths", label: "Helix", output: "curve3",
        description: "A helix rising around +Y (threads, springs, coils).",
        inputs: [n("radius", 0.1, "Radius.", 0), n("pitch", 0.02, "Rise per turn.", 0), n("turns", 5, "Turns.", 0), int("segmentsPerTurn", 24, "Samples per turn.", 3)],
        build: i => helix3(i.radius, i.pitch, i.turns, i.segmentsPerTurn),
    },
    {
        type: "path.resample", category: "Paths", label: "Resample", output: "curve3",
        description: "The same path with `count` evenly spaced points.",
        inputs: [{ name: "path", kind: "curve3", description: "Input." }, int("count", 16, "Points.", 2, 2048)],
        build: i => resample(i.path as Vec3[], i.count),
    },
    // --- Curve to mesh -------------------------------------------------------------------------
    {
        type: "mesh.lathe", category: "Curve to Mesh", label: "Lathe (Revolve)", output: "mesh",
        description: "Spins a (radius, y) profile around +Y, bottom to top. Start and end on the axis for a closed solid: bottles, vases, turned legs, knobs.",
        inputs: [{ name: "profile", kind: "curve2", description: "(radius, y) points." }, int("segments", 48, "Around.", 3), n("sweep", 360, "Degrees.", 0, 360), n("smoothAngle", 40, "Corners sharper than this stay crisp.", 0, 180), n("fillet", 0, "Round every profile corner.", 0), int("filletSegments", 4, "Points per fillet.", 1, 32), { name: "cap", kind: "bool", default: false, description: "Close both ends onto the axis (adds (0, y) points), for a solid from a side-only profile." }],
        build: i => {
            let profile: Vec2[] = filletPolyline(i.profile, i.fillet, i.filletSegments, false);
            if (i.cap && profile.length) {
                const first = profile[0], last = profile[profile.length - 1];
                profile = [...(first[0] > 1e-6 ? [[0, first[1]] as Vec2] : []), ...profile, ...(last[0] > 1e-6 ? [[0, last[1]] as Vec2] : [])];
            }
            return lathe(profile, { segments: i.segments, sweep: i.sweep * DEG, smoothAngle: i.smoothAngle });
        },
    },
    {
        type: "mesh.extrude", category: "Curve to Mesh", label: "Extrude", output: "mesh",
        description: "Extrudes a 2D outline (x, z) up from y = 0, with holes and a rounded bevel on both rims: table tops, gears, panels, frames.",
        inputs: [{ name: "outline", kind: "curve2", description: "Closed outline." }, { name: "holes", kind: "curves2", default: [], description: "Closed hole outlines." }, n("height", 0.1, "Thickness.", 0), n("bevel", 0, "Rim rounding.", 0), int("bevelSegments", 3, "Rows per rim.", 1, 12), n("smoothAngle", 35, "Outline corners sharper than this stay crisp.", 0, 180)],
        build: i => extrude(i.outline, i.height, { holes: i.holes, bevel: i.bevel, bevelSegments: i.bevelSegments, smoothAngle: i.smoothAngle }),
    },
    {
        type: "mesh.loft", category: "Curve to Mesh", label: "Loft", output: "mesh",
        description: "A closed, flat-shaded solid from a `bottom` outline (x, z) at y = 0 to a `top` outline at `height`, point to point (resampled when the counts differ): hip and gable roofs, hoppers, plinths, chimney caps.",
        inputs: [{ name: "bottom", kind: "curve2", description: "Closed outline at y = 0." }, { name: "top", kind: "curve2", description: "Closed outline at the top (a very thin one makes a ridge)." }, n("height", 1, "Height.", 0)],
        build: i => loft(i.bottom, i.top, i.height),
    },
    {
        type: "mesh.sweep", category: "Curve to Mesh", label: "Sweep (Curve to Mesh)", output: "mesh",
        description: "Sweeps a profile along a path - `radius` for a round tube, or any closed `profile`. `taper` scales the far end.",
        inputs: [{ name: "path", kind: "curve3", description: "Path." }, { name: "profile", kind: "curve2", default: null, description: "Closed profile (overrides radius)." }, n("radius", 0.02, "Tube radius.", 0), int("sides", 16, "Tube sides.", 3, 128), n("taper", 1, "Scale at the end of the path.", 0), n("twist", 0, "Degrees per unit length."), { name: "closed", kind: "bool", default: false, description: "Loop the path." }, { name: "caps", kind: "bool", default: true, description: "Close the ends." }],
        build: i => {
            const profile: Vec2[] = i.profile && i.profile.length >= 3 ? i.profile : circle2(i.radius, i.sides);
            const count = (i.path as Vec3[]).length;
            const scales = i.taper !== 1 ? Array.from({ length: count }, (_, k) => 1 + (i.taper - 1) * (k / Math.max(1, count - 1))) : undefined;
            return sweep(i.path, profile, { scales, twist: i.twist * DEG, closed: i.closed, caps: i.caps });
        },
    },
    // --- Deform --------------------------------------------------------------------------------
    {
        type: "deform.bend", category: "Deform", label: "Bend", output: "mesh",
        description: "Bends geometry around a vertical axis: `angle` degrees across `width` of X, both ends curving toward +Z (a chair back wrapping the sitter).",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }, n("angle", 30, "Degrees across the width."), n("width", 1, "Span of X the angle covers.", 0)],
        build: i => bendY(i.mesh, i.angle * DEG, i.width),
    },
    {
        type: "deform.taper", category: "Deform", label: "Taper", output: "mesh",
        description: "Scales X/Z from 1 at `y0` to `amount` at `y1`.",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }, n("amount", 0.5, "Scale at y1.", 0), n("y0", 0, "Start height."), n("y1", 1, "End height.")],
        build: i => taperY(i.mesh, i.amount, i.y0, i.y1),
    },
    {
        type: "deform.twist", category: "Deform", label: "Twist", output: "mesh",
        description: "Twists around +Y by `rate` degrees per unit of height.",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }, n("rate", 90, "Degrees per unit height.")],
        build: i => twistY(i.mesh, i.rate * DEG),
    },
    {
        type: "deform.noise", category: "Deform", label: "Noise Displace", output: "mesh",
        description: "Pushes the surface along its normals by fractal noise, then rebuilds normals (smooth or faceted).",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }, n("amount", 0.1, "Displacement."), n("frequency", 2, "Noise scale.", 0), int("octaves", 4, "Detail layers.", 1, 8), int("seed", 0, "Noise seed.", -1e9, 1e9), { name: "faceted", kind: "bool", default: false, description: "Flat-shaded facets." }, { name: "radial", kind: "bool", default: false, description: "Push away from the origin instead of along normals: never folds a closed blob (rocks)." }],
        build: i => recomputeNormals(displaceNoise(i.mesh, i.amount, i.frequency, i.seed, i.octaves, i.radial), !i.faceted),
    },
    {
        type: "deform.clamp", category: "Deform", label: "Clamp Height", output: "mesh",
        description: "Flattens everything below `min` (and above `max`) onto that plane: a rock's resting face, a cushion's flat underside.",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }, n("min", -1e9, "Floor."), n("max", 1e9, "Ceiling."), n("give", 0, "0 flattens hard; above 0 squashes what's past the plane to this fraction instead, which never folds a face (rebuild normals after).", 0, 1)],
        build: i => {
            const f = (y: number) => (y < i.min ? i.min + (y - i.min) * i.give : y > i.max ? i.max + (y - i.max) * i.give : y);
            const m = mapPositions(i.mesh, ([x, y, z]) => [x, f(y), z]);
            if (i.give > 0) return m;
            return { parts: m.parts.map(p => {
                const normals = p.normals.slice();
                for (let v = 0; v < normals.length; v += 3) {
                    const y = p.positions[v + 1];
                    if (y <= i.min + 1e-9) { normals[v] = 0; normals[v + 1] = -1; normals[v + 2] = 0; }
                    else if (y >= i.max - 1e-9) { normals[v] = 0; normals[v + 1] = 1; normals[v + 2] = 0; }
                }
                return { ...p, normals };
            }) };
        },
    },
    // --- Instances -----------------------------------------------------------------------------
    {
        type: "instance.radial", category: "Instances", label: "Radial Array", output: "mesh",
        description: "`count` copies rotated evenly around +Y (chair base spokes, wheel spokes, petals).",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }, int("count", 5, "Copies.", 1, 1024), n("startAngle", 0, "Degrees.")],
        build: i => radialArray(i.mesh, i.count, i.startAngle * DEG),
    },
    {
        type: "instance.linear", category: "Instances", label: "Linear Array", output: "mesh",
        description: "`count` copies, each `offset` further (slats, shelves, balusters).",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }, int("count", 3, "Copies.", 1, 1024), { name: "offset", kind: "vec3", default: [1, 0, 0], description: "Step between copies." }],
        build: i => linearArray(i.mesh, i.count, i.offset),
    },
    {
        type: "instance.mirror", category: "Instances", label: "Mirror", output: "mesh",
        description: "The input plus its reflection across the plane normal to `axis` (x, y or z).",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }, { name: "axis", kind: "enum", default: "x", options: ["x", "y", "z"], description: "Mirror axis." }],
        build: i => mirror(i.mesh, ({ x: 0, y: 1, z: 2 } as const)[i.axis as "x" | "y" | "z"] ?? 0),
    },
    {
        type: "instance.onPoints", category: "Instances", label: "Instance on Points", output: "mesh",
        description: "A copy of `mesh` at every point, optionally rotated about Y by `rotations` (degrees, one per point or one for all).",
        inputs: [{ name: "mesh", kind: "mesh", description: "Instance." }, { name: "points", kind: "points3", description: "Positions." }, { name: "rotations", kind: "points3", default: [], description: "Per-point [x, y, z] degrees." }, { name: "scales", kind: "points3", default: [], description: "Per-point [x, y, z] scale." }],
        build: i => join(...(i.points as Vec3[]).map((p, k) => {
            const r: number[] = (i.rotations as Vec3[])[k] ?? (i.rotations as Vec3[])[0] ?? [0, 0, 0];
            const s: number[] = (i.scales as Vec3[])[k] ?? (i.scales as Vec3[])[0] ?? [1, 1, 1];
            return transformMesh(i.mesh, compose4(p, [r[0] * DEG, r[1] * DEG, r[2] * DEG], s as Vec3));
        })),
    },
    // --- Geometry ------------------------------------------------------------------------------
    {
        type: "geo.join", category: "Geometry", label: "Join", output: "mesh",
        description: "Combines meshes, keeping each part's region.",
        inputs: [{ name: "meshes", kind: "meshes", default: [], description: "Inputs." }],
        build: i => join(...i.meshes),
    },
    {
        type: "geo.transform", category: "Geometry", label: "Transform", output: "mesh",
        description: "Pass-through: use the common `at`/`rotate`/`scale` fields to place a copy of `mesh`.",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }],
        build: i => i.mesh,
    },
    {
        type: "geo.smooth", category: "Geometry", label: "Shade Smooth / Flat", output: "mesh",
        description: "Rebuilds normals: smooth (welded by position), auto-smooth (creases sharper than `angle` stay crisp) or flat facets.",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }, { name: "smooth", kind: "bool", default: true, description: "Smooth or flat." }, n("angle", 180, "Degrees: faces meeting at a sharper angle don't share a normal (180 smooths everything).", 0, 180)],
        build: i => (i.smooth && i.angle < 179.9 ? autoSmoothNormals(i.mesh, i.angle * DEG) : recomputeNormals(i.mesh, i.smooth)),
    },
    {
        type: "geo.region", category: "Geometry", label: "Set Region", output: "mesh",
        description: "Moves every part of `mesh` into one semantic material region (same as the common `region` field).",
        inputs: [{ name: "mesh", kind: "mesh", description: "Input." }, { name: "name", kind: "string", default: "default", description: "Region." }],
        build: i => setRegion(i.mesh, i.name),
    },
];

export const CATALOG: ReadonlyMap<string, ComponentDef> = new Map(LIST.map(c => [c.type, c]));

export const CATALOG_CATEGORIES = [...new Set(LIST.map(c => c.category))];

/**
 * Fields every node may carry besides its component inputs. `object` nodes take `object` and `params`;
 * `rest: true` lifts each placed copy so its lowest point sits on the floor (splayed legs, casters).
 */
export const COMMON_NODE_FIELDS = ["id", "type", "when", "repeat", "at", "rotate", "scale", "rest", "region", "output", "note", "object", "params"] as const;
