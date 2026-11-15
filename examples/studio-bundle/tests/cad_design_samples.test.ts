// Contour Design's samples: well-formed documents, and in step with the JSON the kernel's own
// tests evaluate (crates/entropy-cad/tests/samples.rs). Run `npm run cad:fixtures` after editing a sample.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dependents, entityPoints, sketchRefs, type SketchFeature } from "../src/apps/cad/cad_doc";
import { SAMPLES } from "../src/apps/cad_design/design_samples";

describe("design samples", () => {
    for (const sample of SAMPLES) {
        const doc = sample.build();
        it(`${sample.id} is a consistent document`, () => {
            const ids = doc.features.map(f => f.id);
            expect(new Set(ids).size).toBe(ids.length);
            for (const [i, f] of doc.features.entries()) {
                expect(f.name).toBeTruthy();
                // Everything a feature reads comes before it.
                for (const ref of sketchRefs(f)) expect(ids.indexOf(ref)).toBeGreaterThanOrEqual(0), expect(ids.indexOf(ref)).toBeLessThan(i);
                if (f.type !== "sketch") continue;
                const points = new Set(f.points.map(p => p.id));
                expect(points.size).toBe(f.points.length);
                for (const e of f.entities) for (const p of entityPoints(e)) expect(points.has(p)).toBe(true);
            }
        });
        it(`${sample.id} matches the kernel's fixture`, () => {
            const fixture = JSON.parse(readFileSync(new URL(`../../../crates/entropy-cad/tests/fixtures/${sample.id}.json`, import.meta.url), "utf8"));
            expect(fixture).toEqual(JSON.parse(JSON.stringify(doc)));
        });
    }

    it("the skiff uses every sketch it draws, and nothing in it is mirrored", () => {
        const doc = SAMPLES.find(s => s.id === "skiff")!.build();
        for (const s of doc.features.filter((f): f is SketchFeature => f.type === "sketch")) expect(dependents(doc, s.id).length).toBeGreaterThan(0);
        expect(doc.features.some(f => f.type === "mirror")).toBe(false);
        expect(doc.features.map(f => f.type).filter(t => t !== "sketch")).toEqual(["loft", "extrude", "extrude", "sweep", "revolve"]);
    });
});
