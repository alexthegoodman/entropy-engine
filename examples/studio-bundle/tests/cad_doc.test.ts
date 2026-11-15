// The CAD document helpers every CAD app edits with (src/apps/cad/cad_doc.ts).
import { describe, expect, it } from "vitest";
import { History, addCircle, addEntity, addPoint, addRectangle, addSketch, addSpline, dependents, emptyDocument, entityPoints, mergePoints, moveFeature, newFeatureIdentity, nextId, removeEntities, removeFeature, removePoint, setSplineWeight, sketchRefs, splineWeight, type CadDocument, type ExtrudeFeature, type SplineEntity } from "../src/apps/cad/cad_doc";

function blockDoc(): CadDocument {
    const doc = emptyDocument();
    const s = addSketch(doc, { base: "top" });
    addRectangle(s, [0, 0], [40, 30]);
    doc.features.push({ ...newFeatureIdentity(doc, "extrude"), type: "extrude", profile: { sketch: s.id }, forward: { distance: 10 }, backward: { distance: 0 }, op: "new" });
    doc.features.push({ ...newFeatureIdentity(doc, "deform", "Twist"), type: "deform", kind: "twist", axis: "y", from: 0, to: 1, angle: 30, target: "x1" });
    return doc;
}

describe("ids and names", () => {
    it("fills the first gap and numbers names per kind", () => {
        expect(nextId(["p1", "p2", "p4"], "p")).toBe("p3");
        const doc = blockDoc();
        expect(doc.features.map(f => [f.id, f.name])).toEqual([["s1", "Sketch 1"], ["x1", "Extrude 1"], ["d1", "Twist 1"]]);
        expect(newFeatureIdentity(doc, "extrude")).toEqual({ id: "x2", name: "Extrude 2" });
    });
});

describe("sketch editing", () => {
    it("a rectangle is four lines sharing four points", () => {
        const s = addSketch(emptyDocument());
        const ids = addRectangle(s, [0, 0], [40, 30]);
        expect(ids).toHaveLength(4);
        expect(s.points).toHaveLength(4);
        const ends = s.entities.flatMap(entityPoints);
        for (const p of s.points) expect(ends.filter(e => e === p.id)).toHaveLength(2);
    });

    it("removing curves drops the points only they used", () => {
        const s = addSketch(emptyDocument());
        const [bottom] = addRectangle(s, [0, 0], [40, 30]);
        addCircle(s, [10, 10], 4);
        removeEntities(s, [bottom]);
        expect(s.points).toHaveLength(5); // the corners are still held by the other sides
        removeEntities(s, s.entities.filter(e => e.type === "line").map(e => e.id));
        expect(s.points).toHaveLength(1);
        expect(s.entities.map(e => e.type)).toEqual(["circle"]);
    });

    it("merging the ends of a spline closes it; merging line ends removes the line", () => {
        const s = addSketch(emptyDocument());
        const id = addSpline(s, [[0, 0], [10, 8], [20, 0], [10, -8], [1, -1]], { weights: [1, 2, 1, 1, 1] });
        const sp = s.entities.find(e => e.id === id) as SplineEntity;
        mergePoints(s, sp.points[4], sp.points[0]);
        expect(sp.closed).toBe(true);
        expect(sp.points).toHaveLength(4);
        expect(sp.weights).toEqual([1, 2, 1, 1]);
        expect(s.points).toHaveLength(4);
        const [a, b] = [addPoint(s, 50, 0), addPoint(s, 60, 0)];
        addEntity(s, { type: "line", a: a.id, b: b.id });
        mergePoints(s, b.id, a.id);
        expect(s.entities).toHaveLength(1);
        expect(s.points).toHaveLength(4);
    });

    it("deleting a point thins a spline but takes a line with it", () => {
        const s = addSketch(emptyDocument());
        const id = addSpline(s, [[0, 0], [10, 8], [20, 0]], { weights: [1, 3, 1] });
        const sp = s.entities.find(e => e.id === id) as SplineEntity;
        removePoint(s, sp.points[1]);
        expect(sp.points).toHaveLength(2);
        expect(sp.weights).toEqual([1, 1]);
        removePoint(s, sp.points[0]);
        expect(s.entities).toHaveLength(0);
        expect(s.points).toHaveLength(0);
    });

    it("spline weights default to one and are stored only when they matter", () => {
        const s = addSketch(emptyDocument());
        const id = addSpline(s, [[0, 0], [10, 8], [20, 0]]);
        const sp = s.entities.find(e => e.id === id) as SplineEntity;
        expect(splineWeight(sp, 1)).toBe(1);
        setSplineWeight(sp, 1, 2.5);
        expect(sp.weights).toEqual([1, 2.5, 1]);
        setSplineWeight(sp, 1, 1);
        expect(sp.weights).toBeUndefined();
    });

    it("coordinates are kept to a micrometre", () => {
        const s = addSketch(emptyDocument());
        const p = addPoint(s, 1.23456789, -0.00004);
        expect([p.x, p.y]).toEqual([1.235, -0]);
    });
});

describe("the feature history", () => {
    it("knows what reads what", () => {
        const doc = blockDoc();
        expect(sketchRefs(doc.features[1])).toEqual(["s1"]);
        expect(dependents(doc, "s1").map(f => f.id)).toEqual(["x1"]);
        expect(dependents(doc, "x1").map(f => f.id)).toEqual(["d1"]);
    });

    it("removing a sketch removes what was built on it", () => {
        const doc = blockDoc();
        expect(removeFeature(doc, "s1")).toEqual(["s1", "x1", "d1"]);
        expect(doc.features).toHaveLength(0);
    });

    it("a feature can't move ahead of what it depends on", () => {
        const doc = blockDoc();
        const other = addSketch(doc, { base: "front" });
        expect(moveFeature(doc, "x1", -1)).toBe(false);
        expect(moveFeature(doc, "d1", -1)).toBe(false);
        expect(moveFeature(doc, other.id, -1)).toBe(true);
        expect(doc.features.map(f => f.id)).toEqual(["s1", "x1", "s2", "d1"]);
        expect(moveFeature(doc, "s1", 1)).toBe(false);
    });
});

describe("undo history", () => {
    it("makes one step of a whole gesture and forgets redo after a new change", () => {
        let doc = blockDoc();
        const h = new History(() => doc, d => { doc = d; });
        const extrude = () => doc.features[1] as ExtrudeFeature;
        h.begin("Drag distance");
        for (const d of [12, 20, 35]) { h.begin("Drag distance"); extrude().forward.distance = d; }
        expect(h.commit()).toBe(true);
        expect(h.commit()).toBe(false);
        h.begin("Nothing");
        expect(h.commit()).toBe(false);
        expect(h.depth).toEqual({ undo: 1, redo: 0 });
        expect(h.undo()).toBe("Drag distance");
        expect(extrude().forward.distance).toBe(10);
        expect(h.redo()).toBe("Drag distance");
        expect(extrude().forward.distance).toBe(35);
        h.undo();
        h.begin("Other"); extrude().forward.distance = 50; h.commit();
        expect(h.redo()).toBeNull();
        expect(h.depth).toEqual({ undo: 1, redo: 0 });
    });

    it("cancel puts an unfinished gesture back", () => {
        let doc = blockDoc();
        const h = new History(() => doc, d => { doc = d; });
        h.begin("Oops");
        doc.features.length = 0;
        h.cancel();
        expect(doc.features).toHaveLength(3);
        expect(h.depth.undo).toBe(0);
    });
});
