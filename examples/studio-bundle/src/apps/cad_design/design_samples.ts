// Starting points for Contour Design: documents that show what the tools are for. Each is built
// with the same helpers the app uses, so they double as worked examples of the document format.

import { type CadDocument, type Feature, type PlaneSpec, type SketchFeature, type V2, addCircle, addEntity, addPoint, addSketch, addSpline, emptyDocument, newFeatureIdentity } from "../cad/cad_doc";

export interface Sample { id: string; name: string; description: string; build: () => CadDocument }

type Loose<T> = T extends Feature ? Omit<T, "id" | "name"> : never;

function add(doc: CadDocument, name: string, feature: Loose<Feature>): string {
    const f = { ...feature, ...newFeatureIdentity(doc, feature.type), name } as Feature;
    doc.features.push(f);
    return f.id;
}

function sketch(doc: CadDocument, name: string, plane: PlaneSpec, draw: (s: SketchFeature) => void): string {
    const s = addSketch(doc, plane);
    s.name = name;
    draw(s);
    return s.id;
}

/** A small craft with nothing mirrored: a lofted hull, a cockpit cut, one wing, a fin, a fluted thruster. */
function skiff(): CadDocument {
    const doc = emptyDocument();
    const section = (name: string, offset: number, tilt: number, pts: V2[]) =>
        sketch(doc, name, { base: "side", offset, tiltY: tilt }, s => { addSpline(s, pts, { closed: true }); });
    // Hull sections along x, each a different closed curve, none of them symmetric.
    const nose = section("Nose", -150, 0, [[-6, 30], [0, 38], [8, 33], [6, 25], [-2, 23]]);
    const fore = section("Fore section", -60, 8, [[-45, 22], [-12, 58], [36, 46], [52, 20], [8, 6]]);
    const mid = section("Mid section", 50, -4, [[-62, 24], [-22, 70], [44, 54], [70, 22], [6, 2]]);
    const tail = section("Tail", 150, 0, [[-26, 28], [-6, 50], [24, 42], [30, 26], [2, 14]]);
    add(doc, "Hull", { type: "loft", sections: [nose, fore, mid, tail].map(id => ({ profile: { sketch: id } })), op: "new" });

    // The cockpit: an ellipse above the hull, turned off-axis, cut down into it narrowing as it goes.
    const cockpit = sketch(doc, "Cockpit outline", { base: "top", offset: 90 }, s => {
        addEntity(s, { type: "ellipse", center: addPoint(s, 5, 6).id, rx: 46, ry: 17, rotation: 14 });
    });
    add(doc, "Cockpit", { type: "extrude", profile: { sketch: cockpit }, forward: { distance: 0 }, backward: { distance: 52, scale: [0.72, 0.6], shift: [10, 0] }, op: "cut" });

    // One wing, on one side only: a stroke around a curved spine, wide at the root, fine at the tip.
    const wing = sketch(doc, "Wing spine", { base: "top", offset: 26 }, s => {
        const id = addSpline(s, [[-10, -40], [20, -85], [78, -128]]);
        const spine = s.entities.find(e => e.id === id)!;
        spine.stroke = { left: 26, right: 9, start: 1, middle: 0.75, end: 0.12, round: true };
    });
    add(doc, "Wing", { type: "extrude", profile: { sketch: wing }, forward: { distance: 5, scale: [0.9, 0.9] }, backward: { distance: 3 }, op: "add" });

    // A fin swept up and back along a curve, thinning toward the tip.
    const finSection = sketch(doc, "Fin section", { base: "top", offset: 48 }, s => {
        addEntity(s, { type: "ellipse", center: addPoint(s, 70, 4).id, rx: 26, ry: 4.5, rotation: 0 });
    });
    const finPath = sketch(doc, "Fin path", { base: "front", offset: -4 }, s => { addSpline(s, [[70, 48], [92, 92], [140, 122]]); });
    add(doc, "Fin", { type: "sweep", profile: { sketch: finSection }, path: { sketch: finPath }, scaleEnd: 0.22, twist: 0, op: "add" });

    // The thruster: a ring revolved about the hull's axis, fluted with six lobes.
    const ring = sketch(doc, "Thruster section", { base: "front", offset: -2 }, s => {
        addSpline(s, [[146, 50], [182, 55], [190, 48], [180, 43], [146, 44]], { closed: true });
        const [a, b] = [addPoint(s, 100, 30), addPoint(s, 200, 30)];
        addEntity(s, { type: "line", a: a.id, b: b.id, construction: true });
    });
    const axis = (doc.features.find(f => f.id === ring) as SketchFeature).entities.find(e => e.type === "line")!.id;
    add(doc, "Thruster", { type: "revolve", profile: { sketch: ring }, axis: { entity: axis }, start: 0, end: 360, lobes: 6, lobeDepth: 0.07, op: "add" });
    return doc;
}

/** A vessel that is round nowhere: a squashed, lobed revolve, bent to lean and tapered to one side. */
function vessel(): CadDocument {
    const doc = emptyDocument();
    const wall = sketch(doc, "Wall", { base: "front" }, s => {
        // The wall's centre line, given thickness by an uneven stroke: fat belly, fine lip.
        const id = addSpline(s, [[14, 0], [44, 34], [30, 86], [20, 126], [32, 150]]);
        s.entities.find(e => e.id === id)!.stroke = { left: 2.2, right: 2.2, start: 1.6, middle: 1, end: 0.5, round: true };
        const [a, b] = [addPoint(s, 0, 0), addPoint(s, 0, 150)];
        addEntity(s, { type: "line", a: a.id, b: b.id, construction: true });
    });
    const axis = (doc.features.find(f => f.id === wall) as SketchFeature).entities.find(e => e.type === "line")!.id;
    add(doc, "Body", { type: "revolve", profile: { sketch: wall }, axis: { entity: axis }, start: 0, end: 360, squash: 0.78, lobes: 3, lobeDepth: 0.06, op: "new" });
    const foot = sketch(doc, "Foot", { base: "top" }, s => { addCircle(s, [0, 0], 15); });
    add(doc, "Base", { type: "extrude", profile: { sketch: foot }, forward: { distance: 3 }, backward: { distance: 0 }, op: "add" });
    add(doc, "Lean", { type: "deform", kind: "bend", axis: "y", toward: "x", angle: 16, from: 0.35, to: 1, smooth: false });
    add(doc, "Spiral", { type: "deform", kind: "twist", axis: "y", angle: 70, from: 0.1, to: 1, smooth: true });
    return doc;
}

/** One closed curve, extruded two ways at once: the shortest route from a sketch to an odd solid. */
function pebble(): CadDocument {
    const doc = emptyDocument();
    const outline = sketch(doc, "Outline", { base: "top" }, s => {
        addSpline(s, [[-50, -10], [-20, 34], [34, 30], [58, -6], [10, -36]], { closed: true, weights: [1, 1.4, 1, 0.7, 1] });
    });
    add(doc, "Pebble", { type: "extrude", profile: { sketch: outline }, forward: { distance: 34, scale: [0.35, 0.5], shift: [14, 6], bulge: 0.22 }, backward: { distance: 10, scale: [0.7, 0.7], bulge: 0.12 }, op: "new" });
    return doc;
}

export const SAMPLES: Sample[] = [
    { id: "skiff", name: "Skiff", description: "A craft with nothing mirrored: lofted hull, cockpit cut, one wing, swept fin, fluted thruster", build: skiff },
    { id: "vessel", name: "Vessel", description: "A lobed, squashed revolve with an uneven wall, bent and twisted", build: vessel },
    { id: "pebble", name: "Pebble", description: "One closed curve extruded two ways with scale, shift and bulge", build: pebble },
    { id: "empty", name: "Empty", description: "A blank document", build: emptyDocument },
];
