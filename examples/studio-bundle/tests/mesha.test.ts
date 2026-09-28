import { describe, expect, it } from "vitest";
import { evaluate, referencedNames } from "../src/apps/mesha/mesha_expr";
import { CATALOG } from "../src/apps/mesha/mesha_catalog";
import { type Mesh, type Vec2, type Vec3, bounds, triangleCount, sub3, cross3, dot3 } from "../src/apps/mesha/mesha_mesh";
import { roundedBox, lathe, capsuleProfile, extrude, sweep, cylinder, triangulate, loft } from "../src/apps/mesha/mesha_primitives";
import { circle2, roundedRect2 } from "../src/apps/mesha/mesha_curves";
import { type ObjectDef, evaluateObject, evaluateExpression, resolveParams, isParamVisible, validateDefinition, defaultValues } from "../src/apps/mesha/mesha_object";
import { LIBRARY, lookupObject, browsableObjects } from "../src/apps/mesha/library";
import { vary } from "../src/apps/mesha/mesha_variation";
import { checkGeometry, fuzz, acceptanceText } from "../src/apps/mesha/mesha_verify";
import { render, contactShadowMap } from "../src/apps/mesha/mesha_raster";
import { buildScene, searchLibrary } from "../src/apps/mesha/mesha_scene";

// Signed volume by the divergence theorem: positive only if every face winds outward.
function volume(mesh: Mesh): number {
    let v = 0;
    for (const p of mesh.parts) {
        for (let t = 0; t < p.indices.length; t += 3) {
            const [a, b, c] = [p.indices[t], p.indices[t + 1], p.indices[t + 2]].map(i => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]]);
            v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
        }
    }
    return v;
}

const bare = (mesh: Mesh): ObjectDef & { mesh: Mesh } => ({ id: "t", name: "t", category: "t", groups: [], params: [], regions: { default: { label: "", material: "default" } }, nodes: [], mesh });
const report = (mesh: Mesh) => {
    const def = bare(mesh);
    return checkGeometry(def, { mesh, params: {}, materials: {}, violations: [], stats: { triangles: triangleCount(mesh), vertices: 0, bounds: bounds(mesh), ms: 0 } });
};

// Nearest positive ray/triangle hit, used to test actual architectural openings.
function rayHit(mesh: Mesh, origin: Vec3, direction: Vec3): number {
    let nearest = Infinity;
    for (const p of mesh.parts) for (let i = 0; i < p.indices.length; i += 3) {
        const [a, b, c] = p.indices.slice(i, i + 3).map(k => p.positions.slice(k * 3, k * 3 + 3) as Vec3);
        const e1 = sub3(b, a), e2 = sub3(c, a), h = cross3(direction, e2), det = dot3(e1, h);
        if (Math.abs(det) < 1e-9) continue;
        const s = sub3(origin, a), u = dot3(s, h) / det;
        if (u < 0 || u > 1) continue;
        const q = cross3(s, e1), v = dot3(direction, q) / det;
        if (v < 0 || u + v > 1) continue;
        const t = dot3(e2, q) / det;
        if (t > 1e-7) nearest = Math.min(nearest, t);
    }
    return nearest;
}

// The same ray cast over a flattened triangle list, for meshes of a few hundred thousand triangles.
function flatten(mesh: Mesh): Float64Array {
    const out: number[] = [];
    for (const p of mesh.parts) for (const i of p.indices) out.push(p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]);
    return Float64Array.from(out);
}
function castRay(tris: Float64Array, o: Vec3, d: Vec3): number {
    let nearest = Infinity;
    for (let i = 0; i < tris.length; i += 9) {
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const e1x = tris[i + 3] - ax, e1y = tris[i + 4] - ay, e1z = tris[i + 5] - az;
        const e2x = tris[i + 6] - ax, e2y = tris[i + 7] - ay, e2z = tris[i + 8] - az;
        const hx = d[1] * e2z - d[2] * e2y, hy = d[2] * e2x - d[0] * e2z, hz = d[0] * e2y - d[1] * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (Math.abs(det) < 1e-12) continue;
        const sx = o[0] - ax, sy = o[1] - ay, sz = o[2] - az;
        const u = (sx * hx + sy * hy + sz * hz) / det;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) / det;
        if (t > 1e-7 && t < nearest) nearest = t;
    }
    return nearest;
}

describe("Mesha expressions", () => {
    const scope = (vars: Record<string, number | string | boolean>) => (n: string) => vars[n];
    it("follows precedence, ternaries, comparisons and string equality", () => {
        expect(evaluate("=1 + 2 * 3 ^ 2", scope({}))).toBe(19);
        expect(evaluate("=-2 ^ 2", scope({}))).toBe(-4);
        expect(evaluate("=w > 1 ? 'big' : 'small'", scope({ w: 1.5 }))).toBe("big");
        expect(evaluate("=style == 'turned' && legs >= 4", scope({ style: "turned", legs: 4 }))).toBe(true);
        expect(evaluate("=!armrests || armHeight < 0.3", scope({ armrests: false, armHeight: 1 }))).toBe(true);
        expect(evaluate("=[1, 2, 3][index]", scope({ index: 1 }))).toBe(2);
        expect(evaluate("=-7 % 3", scope({}))).toBe(2);
    });
    it("has the math a definition needs and a seeded rand", () => {
        expect(evaluate("=clamp(lerp(0, 10, 0.5), 0, 4)", scope({}))).toBe(4);
        expect(evaluate("=round(deg(rad(90)))", scope({}))).toBe(90);
        const a = evaluate("=rand(3)", scope({ seed: 1 })), b = evaluate("=rand(3)", scope({ seed: 1 })), c = evaluate("=rand(3)", scope({ seed: 2 }));
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(Number(a)).toBeGreaterThanOrEqual(0);
        expect(Number(a)).toBeLessThan(1);
    });
    it("rejects unknown names and functions instead of evaluating anything", () => {
        expect(() => evaluate("=nope + 1", scope({}))).toThrow(/Unknown name "nope"/);
        expect(() => evaluate("=constructor('x')", scope({}))).toThrow(/Unknown function/);
        expect(() => evaluate("=1 +", scope({}))).toThrow();
        expect(referencedNames("=max(width, depth) * k + PI")).toEqual(["width", "depth", "k"]);
    });
});

describe("Mesha geometry builders", () => {
    it("rounded boxes are closed and outward: a sharp box has exactly its volume", () => {
        expect(volume(roundedBox([2, 3, 4], 0))).toBeCloseTo(24, 6);
        const r = 0.2, v = volume(roundedBox([1, 1, 1], r, 8));
        const exact = 1 - (8 - (4 / 3) * Math.PI) * r ** 3 - (4 - Math.PI) * r * r * 3 * (1 - 2 * r);
        expect(v).toBeGreaterThan(exact * 0.99);
        expect(v).toBeLessThan(1);
    });
    it("lathe solids wind outward (cylinder volume) and split normals at hard rims", () => {
        const m = cylinder(0.5, 2, 64);
        expect(volume(m)).toBeCloseTo(Math.PI * 0.25 * 2, 1);
        expect(report(m).inverted).toBe(0);
        const rounded = lathe(capsuleProfile(0.5, 0.3, 1, 0.1, 4), { segments: 48 });
        expect(volume(rounded)).toBeGreaterThan(0);
        expect(report(rounded).issues.filter(i => i.severity === "error")).toEqual([]);
    });
    it("extrusions with holes cap exactly the ring's area", () => {
        const outer = circle2(1, 96), hole = circle2(0.4, 64);
        const m = extrude(outer, 0.5, { holes: [hole] });
        const ringArea = (poly: Vec2[]) => Math.abs(poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
        expect(volume(m)).toBeCloseTo((ringArea(outer) - ringArea(hole)) * 0.5, 4);
        const beveled = extrude(roundedRect2(2, 1, 0.2), 0.1, { bevel: 0.02, bevelSegments: 4 });
        expect(volume(beveled)).toBeGreaterThan(0);
        expect(report(beveled).issues.filter(i => i.severity === "error")).toEqual([]);
    });
    it("ear clipping covers a concave outline with no overlap", () => {
        const l: Vec2[] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
        const tris = triangulate(l);
        let area = 0;
        for (let t = 0; t < tris.length; t += 3) {
            const [a, b, c] = [l[tris[t]], l[tris[t + 1]], l[tris[t + 2]]];
            const s = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
            expect(s).toBeGreaterThan(0);
            area += s;
        }
        expect(area).toBeCloseTo(3, 9);
    });
    it("sweeps make closed tubes around their path", () => {
        const tube = sweep([[0, 0, 0], [0, 1, 0], [0, 2, 0.001]], circle2(0.1, 48));
        expect(volume(tube)).toBeCloseTo(Math.PI * 0.01 * 2, 2);
        expect(report(tube).inverted).toBe(0);
    });
    it("lofts are closed, outward solids: a frustum's volume, a hip roof, mismatched outlines", () => {
        const square = (h: number): Vec2[] => [[-h, -h], [h, -h], [h, h], [-h, h]];
        expect(volume(loft(square(1), square(0.5), 1))).toBeCloseTo((4 + 1 + 2) / 3, 9);
        // A hip roof: 4 x 2 footprint up to a ridge 2 m long (a prism and two end pyramids); the
        // reversed outline makes the same solid.
        const hip = loft([[-2, -1], [2, -1], [2, 1], [-2, 1]], [[-1, -0.001], [1, -0.001], [1, 0.001], [-1, 0.001]], 1);
        expect(volume(hip)).toBeCloseTo(2 + 2 * (1 * 2 * 1) / 3, 2);
        expect(volume(loft([[-2, 1], [2, 1], [2, -1], [-2, -1]], [[-1, 0.001], [1, 0.001], [1, -0.001], [-1, -0.001]], 1))).toBeCloseTo(volume(hip), 6);
        const mixed = loft(circle2(1, 48), square(0.3), 2);
        expect(volume(mixed)).toBeGreaterThan(0);
        expect(report(hip).issues.filter(i => i.severity === "error")).toEqual([]);
        expect(report(mixed).issues.filter(i => i.severity === "error")).toEqual([]);
    });
    it("every catalog mesh component builds valid geometry at its defaults", () => {
        const needsInput = new Set(["mesh", "meshes", "curve2", "curve3", "curves2", "points3"]);
        for (const comp of CATALOG.values()) {
            if (comp.output !== "mesh") continue;
            const inputs: Record<string, unknown> = {};
            for (const i of comp.inputs) inputs[i.name] = i.default;
            if (comp.inputs.some(i => needsInput.has(i.kind) && (i.default === undefined || i.default === null || (Array.isArray(i.default) && !i.default.length)))) {
                // Feed composite inputs a small representative value.
                for (const i of comp.inputs) {
                    if (i.kind === "mesh") inputs[i.name] = roundedBox([0.5, 1, 0.5], 0.05, 3, "default", [4, 4, 4]);
                    if (i.kind === "meshes") inputs[i.name] = [roundedBox([0.5, 1, 0.5], 0.05), cylinder(0.2, 1)];
                    if (i.kind === "curve2" && !inputs[i.name]) inputs[i.name] = comp.type === "mesh.lathe" ? [[0, 0], [0.3, 0], [0.3, 1], [0, 1]] : roundedRect2(1, 0.6, 0.1);
                    if (i.kind === "curve3") inputs[i.name] = [[0, 0, 0], [0, 1, 0], [0.5, 1.5, 0]];
                    if (i.kind === "points3" && i.default === undefined) inputs[i.name] = [[0, 0, 0], [1, 0, 0]];
                }
            }
            const mesh = comp.build(inputs) as Mesh;
            const errors = report(mesh).issues.filter(i => i.severity === "error");
            expect({ type: comp.type, errors }).toEqual({ type: comp.type, errors: [] });
        }
    });
});

describe("Mesha library", () => {
    it("is plain JSON: every definition survives a JSON round trip", () => {
        for (const def of LIBRARY) expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    });
    it("has no definition problems", () => {
        for (const def of LIBRARY) expect({ id: def.id, problems: validateDefinition(def, lookupObject) }).toEqual({ id: def.id, problems: [] });
    });
    it("presets hold their values (nothing silently clamped) and satisfy their rules", () => {
        for (const def of LIBRARY) for (const preset of def.presets ?? []) {
            const resolved = resolveParams(def, preset.values);
            const where = `${def.id} / ${preset.name}`;
            for (const [k, v] of Object.entries(preset.values)) expect(resolved[k], `${where}: ${k}`).toBe(v);
            expect(evaluateObject(def, preset.values, lookupObject).violations, where).toEqual([]);
        }
    });
    it("reports a parameter or derived value hidden by a repeat's own index, count or t", () => {
        const def: ObjectDef = {
            id: "t.shadow", name: "t", category: "t", groups: [{ id: "g", label: "g" }], regions: { default: { label: "", material: "wood.oak" } },
            params: [{ id: "count", label: "Count", type: "int", default: 3, min: 1, max: 9, group: "g" }],
            derived: { t: "=0.3" },
            nodes: [
                { id: "fine", type: "mesh.box", repeat: "=count", size: [1, 1, 1], at: ["=index", 0, 0] },
                { id: "hidden", type: "mesh.box", repeat: 2, size: ["=t", 1, 1] },
            ],
        };
        expect(validateDefinition(def)).toEqual(['node hidden: "t" here is the repeat\'s own t, not the derived value']);
    });
    it("passes the parameter fuzzer: every object is ready", () => {
        for (const def of LIBRARY) {
            const a = fuzz(def, lookupObject, { pairs: 12, random: 16 });
            if (!a.ready) throw new Error(`${acceptanceText(a)}\n${a.failures.map(f => `${f.label}: ${JSON.stringify(f.issues)}`).join("\n")}`);
            expect(a.configurations).toBeGreaterThan(20);
        }
    }, 120_000);
    it("clamps dynamic ranges against clamped values, whatever the declaration order", () => {
        const table = lookupObject("furniture.table")!;
        const v = resolveParams(table, { topThickness: 1e9 });
        expect(v.topThickness).toBe(0.09);
        expect(v.cornerRadius).toBe(0.08);
        const bolt = lookupObject("mechanical.bolt")!;
        expect(resolveParams(bolt, { diameter: 0.004, length: 1 }).length).toBeCloseTo(0.064, 9);
    });
    it("hides irrelevant controls: no arms, legs instead of wheels", () => {
        const chair = lookupObject("furniture.office_chair")!;
        const visible = (values: Record<string, unknown>) => chair.params.filter(p => isParamVisible(chair, p, resolveParams(chair, values as never))).map(p => p.id);
        expect(visible({})).toEqual(expect.arrayContaining(["armHeight", "spokes", "casterSize"]));
        expect(visible({})).not.toContain("legStyle");
        expect(visible({ armrests: false })).not.toContain("armHeight");
        const legs = visible({ base: "legs" });
        expect(legs).toContain("legStyle");
        expect(legs).not.toContain("spokes");
    });
    it("composes objects: a table's legs are component.leg, and change with its leg style", () => {
        const table = lookupObject("furniture.table")!;
        const a = evaluateObject(table, { legStyle: "tapered" }, lookupObject);
        const b = evaluateObject(table, { legStyle: "turned" }, lookupObject);
        expect(a.mesh.parts.some(p => p.region === "legs")).toBe(true);
        expect(b.stats.triangles).toBeGreaterThan(a.stats.triangles);
        expect(a.stats.bounds!.min[1]).toBeGreaterThan(-1e-6);
    });
    it("keeps materials on semantic regions when the object is resized", () => {
        const chair = lookupObject("furniture.office_chair")!;
        const small = evaluateObject(chair, { seatWidth: 0.42 }, lookupObject), big = evaluateObject(chair, { seatWidth: 0.62, upholstery: "leather.tan" }, lookupObject);
        const regions = (m: Mesh) => [...new Set(m.parts.map(p => p.region))].sort();
        expect(regions(small.mesh)).toEqual(regions(big.mesh));
        expect(big.materials.upholstery.id).toBe("leather.tan");
        expect(small.materials.upholstery.id).toBe("fabric.charcoal");
    });
    it("lists components separately from what Add Object browses, and searches by name and tag", () => {
        expect(browsableObjects().some(d => d.component)).toBe(false);
        expect(searchLibrary("office chair")[0].id).toBe("furniture.office_chair");
        expect(searchLibrary("wine")[0].id).toBe("household.bottle");
        expect(searchLibrary("cog")[0].id).toBe("mechanical.gear");
    });
    it("the lamp has an open shade with an inner wall at every style and size", () => {
        const lamp = lookupObject("household.table_lamp")!;
        expect(searchLibrary("bedside")[0].id).toBe(lamp.id);
        for (const shadeShape of ["tapered", "drum", "dome"]) {
            for (const height of [0.25, 0.85]) {
                const e = evaluateObject(lamp, { shadeShape, height, wall: 1, baseShare: 1 }, lookupObject);
                expect(e.stats.bounds!.min[1]).toBeCloseTo(0, 6);
                expect(e.stats.bounds!.max[1]).toBeCloseTo(height, 6);
                const shade = e.mesh.parts.filter(p => p.region === "shade");
                let inward = 0, outward = 0;
                for (const part of shade) for (let i = 0; i < part.positions.length; i += 3) {
                    const [x, , z] = part.positions.slice(i, i + 3);
                    expect(Math.hypot(x, z)).toBeGreaterThan(Number(e.params.shadeRadius) * 0.1);
                    const dot = x * part.normals[i] + z * part.normals[i + 2];
                    if (dot < -0.001) inward++;
                    if (dot > 0.001) outward++;
                }
                expect(inward).toBeGreaterThan(100);
                expect(outward).toBeGreaterThan(100);
            }
        }
    });
    it("coffee maker groups fit the body and cups clear the spouts across size extremes", () => {
        const def = lookupObject("household.coffee_maker")!;
        expect(searchLibrary("espresso")[0].id).toBe(def.id);
        expect(resolveParams(def, { width: 0.22, groups: 2 }).groups).toBe(1);
        expect(resolveParams(def, { width: 0.52, groups: 2 }).groups).toBe(2);
        for (const width of [0.22, 0.38, 0.56]) for (const height of [0.28, 0.5]) {
            const e = evaluateObject(def, { width, height, groups: 2, rounding: 1 }, lookupObject);
            const cupParts = e.mesh.parts.filter(p => p.region === "cups");
            const cb = bounds({ parts: cupParts })!;
            expect(cb.max[1]).toBeLessThan(height * 0.43 - 0.02);
            expect(cb.min[1]).toBeCloseTo(height * 0.1095, 6);
            expect(cb.min[0]).toBeGreaterThan(-width * 0.43);
            expect(cb.max[0]).toBeLessThan(width * 0.43);
            const noCups = evaluateObject(def, { width, height, groups: 2, cups: false }, lookupObject);
            expect(noCups.mesh.parts.some(p => p.region === "cups")).toBe(false);
            expect(e.materials.cups.id).toBe("ceramic.white");
        }
        const hidden = resolveParams(def, { portafilters: false, gauges: false, steamWand: false });
        for (const id of ["handleLength", "doubleSpout", "gaugeReading", "wandReach"]) {
            expect(isParamVisible(def, def.params.find(p => p.id === id)!, hidden)).toBe(false);
        }
    });
});

describe("Mesha dome architecture", () => {
    const def = lookupObject("architecture.dome_building")!;
    it("has a traversable front entrance and an empty hall at presets and extremes", () => {
        const cases = [ {}, ...(def.presets ?? []).map(p => p.values),
            ...[3, 14].flatMap(radius => [2.6, 6].flatMap(drumHeight => [1.2, 100].map(doorWidth =>
                ({ radius, drumHeight, doorWidth, wall: 100, doorHeight: 100, trimWidth: 100, columns: 24, columnRadius: 100 })))) ];
        for (const values of cases) {
            const e = evaluateObject(def, values, lookupObject), v = e.params;
            const floor = v.floor ? 0.15 : 0;
            for (const x of [-0.499, 0, 0.499]) for (const y of [0.2, 0.5, 0.9]) {
                expect(rayHit(e.mesh, [x * Number(v.doorWidth), floor + y * Number(v.doorHeight), 0], [0, 0, 1]), JSON.stringify(values)).toBe(Infinity);
            }
            // Side walls enclose the hall; there are no objects or columns in the room.
            expect(rayHit(e.mesh, [0, floor + 1, 0], [1, 0, 0])).toBeCloseTo(Number(v.radius) - Number(v.wall), 1);
            const roofOnly = { parts: e.mesh.parts.filter(p => p.region === "shell") };
            const roof = rayHit(roofOnly, [Number(v.radius) * 0.5, floor + 1, 0], [0, 1, 0]);
            expect(roof).toBeGreaterThan(Number(v.drumHeight) - 1);
            expect(roof).toBeLessThan(Number(v.drumHeight) + Number(v.rise));
        }
    });
    it("opens the oculus and removes the entire roof for interior inspection", () => {
        const closed = evaluateObject(def, { oculus: 0 }, lookupObject);
        expect(rayHit(closed.mesh, [0.017, 1, 0.023], [0, 1, 0])).toBeLessThan(Infinity);
        const open = evaluateObject(def, { oculus: 0.25 }, lookupObject);
        expect(rayHit(open.mesh, [0.017, 1, 0.023], [0, 1, 0])).toBe(Infinity);
        const cutaway = evaluateObject(def, { roofVisible: false }, lookupObject);
        expect(cutaway.mesh.parts.some(p => p.region === "shell" || p.region === "ribs")).toBe(false);
        expect(rayHit(cutaway.mesh, [2, 1, 0], [0, 1, 0])).toBe(Infinity);
    });
    it("the dome shell has no boundary edges, including the oculus rim", () => {
        for (const oculus of [0, 0.25]) {
            const e = evaluateObject(def, { oculus }, lookupObject);
            const edges = new Map<string, number>();
            for (const p of e.mesh.parts.filter(p => p.region === "shell")) {
                const key = (i: number) => p.positions.slice(i * 3, i * 3 + 3).map(v => Math.round(v * 1e5)).join(",");
                for (let i = 0; i < p.indices.length; i += 3) {
                    const ids = p.indices.slice(i, i + 3).map(key);
                    for (let j = 0; j < 3; j++) {
                        const edge = [ids[j], ids[(j + 1) % 3]].sort().join("|");
                        edges.set(edge, (edges.get(edge) ?? 0) + 1);
                    }
                }
            }
            expect([...edges.values()].every(n => n === 2)).toBe(true);
        }
    });
});

describe("Mesha door", () => {
    const def = lookupObject("architecture.door")!;
    it("fills its opening when closed and swings clear of it when open", () => {
        for (const style of ["panel", "glazed", "flush", "plank"]) {
            const closed = flatten(evaluateObject(def, { style }, lookupObject).mesh);
            expect(castRay(closed, [0.05, 1.0, 3], [0, 0, -1]), style).toBeLessThan(3);
            const open = flatten(evaluateObject(def, { style, openAngle: 90 }, lookupObject).mesh);
            for (const x of [-0.2, 0, 0.3]) for (const y of [0.3, 1.0, 1.8]) expect(castRay(open, [x, y, 3], [0, 0, -1]), `${style} ${x} ${y}`).toBe(Infinity);
        }
    });
    it("exterior doors carry a threshold and an entry-finish leaf", () => {
        const regions = (values: Record<string, unknown>) => new Set(evaluateObject(def, values as never, lookupObject).mesh.parts.map(p => p.region));
        expect([...regions({ exterior: true })].sort()).toEqual(["casing", "entry", "hardware", "sill"]);
        expect(regions({}).has("leaf")).toBe(true);
        expect(regions({ fanlight: 0.4 }).has("glass")).toBe(true);
    });
});

describe("Mesha house", () => {
    const def = lookupObject("architecture.house")!;
    const plan = (values: Record<string, unknown>) => {
        const e = evaluateObject(def, values as never, lookupObject);
        const n = (name: string) => Number(evaluateExpression(def, e.params, `=${name}`));
        return { e, n, tris: flatten(e.mesh), storeys: Number(e.params.storeys) };
    };
    const layouts: Record<string, unknown>[] = [
        {}, ...(def.presets ?? []).map(p => p.values),
        { stairSide: "right" }, { hallOffset: 1 }, { hallOffset: -1, stairSide: "right", stairStyle: "open" },
        { storeys: 3, depth: 10 }, { storeys: 1, roofStyle: "hip", porch: "veranda" }, { groundPlan: "open", interiorDoors: "glazed" },
        { width: 100, depth: 100, storeyHeight: 100, hallWidth: 100 }, { width: 0, depth: 0, storeyHeight: 0, wall: 100, hallWidth: 0 },
    ];
    it("the front door opens onto a hall that runs clear to the back wall", () => {
        for (const values of layouts) {
            const { n, tris } = plan({ ...values, frontDoorAngle: 90 });
            const x = n("hallX") - n("sgn") * 0.12, y = n("pl") + 1.2;
            expect(castRay(tris, [x, y, n("D2") + 6], [0, 0, -1]), JSON.stringify(values)).toBeGreaterThan(6 + n("depth") - n("wall") - 0.4);
            // And the hall floor is there to walk on.
            expect(castRay(tris, [x, y, n("zi1") - 0.4], [0, -1, 0])).toBeCloseTo(1.2 - 0.004, 2);
        }
    });
    it("every hall doorway on every storey opens into a room", () => {
        for (const values of layouts) {
            const { n, tris, storeys } = plan(values);
            // Walk down the corridor beside the stair (the hall's centre line can be over the treads).
            const x0 = storeys > 1 ? n("hallX") - n("sgn") * Number(n("stairWidth")) / 2 : n("hallX");
            for (let f = 0; f < storeys; f++) {
                const y = n("pl") + f * n("H") + 1.0;
                for (const [side, z] of [[-1, n("zdLF")], [-1, n("zdLB")], [1, n("zdRF")], [1, n("zdRB")]]) {
                    const inner = side < 0 ? x0 - n("xi0") : n("xi1") - x0;
                    const hit = castRay(tris, [x0, y, z], [side, 0, 0]);
                    const where = `${JSON.stringify(values)} storey ${f} side ${side} z ${z.toFixed(2)}`;
                    expect(hit, where).toBeGreaterThan(inner - 0.05);
                    expect(hit, where).toBeLessThan(inner + n("wall") + 0.4);
                }
            }
        }
    });
    it("stairs climb in even, walkable risers with headroom and land beside the stairwell", () => {
        for (const values of layouts) {
            const { e, n, tris, storeys } = plan(values);
            if (storeys < 2) continue;
            const rh = n("rh"), tread = Number(e.params.tread), steps = n("steps");
            expect(rh).toBeLessThanOrEqual(Number(e.params.riser) + 1e-9);
            expect(2 * rh + tread).toBeGreaterThan(0.55);
            for (let f = 0; f < storeys - 1; f++) {
                const yf = n("pl") + f * n("H");
                for (let k = 0; k < steps; k++) {
                    const top = yf + (k + 1) * rh, z = n("zS") - (k + 0.4) * tread, where = `${JSON.stringify(values)} flight ${f} step ${k}`;
                    expect(castRay(tris, [n("sX"), top + 0.4, z], [0, -1, 0]), where).toBeCloseTo(0.4, 3);
                    expect(castRay(tris, [n("sX"), top + 0.01, z], [0, 1, 0]), where).toBeGreaterThan(2.0);
                }
                // Stepping off the top: the next storey's floor, just past the stairwell.
                expect(castRay(tris, [n("sX"), yf + n("H") + 0.5, n("zE") - 0.2], [0, -1, 0])).toBeCloseTo(0.5 - 0.004, 2);
            }
        }
    });
    it("lifting the roof or cutting away storeys opens the rooms to view", () => {
        const full = plan({ storeys: 3, depth: 10 });
        const roofless = plan({ storeys: 3, depth: 10, roofVisible: false });
        const n = roofless.n;
        // Only the porch roof, well below the eaves, stays.
        expect(roofless.e.mesh.parts.some(p => ["chimney", "pots", "gutters"].includes(p.region))).toBe(false);
        expect(Math.max(...roofless.e.mesh.parts.filter(p => p.region === "roof").flatMap(p => p.positions.filter((_, i) => i % 3 === 1)))).toBeLessThan(n("pl") + n("H") + 1.2);
        const x = (n("xi0") + n("hallL") - n("pt")) / 2, z = n("zmF");
        expect(castRay(full.tris, [x, 40, z], [0, -1, 0])).toBeLessThan(40 - n("yTop"));
        expect(40 - castRay(roofless.tris, [x, 40, z], [0, -1, 0])).toBeCloseTo(n("pl") + 2 * n("H") + 0.004, 2);
        const cut = plan({ storeys: 3, depth: 10, cutaway: 2 });
        expect(40 - castRay(cut.tris, [x, 40, z], [0, -1, 0])).toBeCloseTo(n("pl") + 0.004, 2);
        expect(cut.e.stats.bounds!.max[1]).toBeLessThan(n("pl") + n("H") + 1.2);
        expect(cut.e.stats.triangles).toBeLessThan(roofless.e.stats.triangles / 2);
    });
    it("rooms are at least 2.4 m wide and windows stay clear of partitions and corners", () => {
        for (const values of layouts) {
            const { n } = plan(values);
            expect(n("zwL"), JSON.stringify(values)).toBeGreaterThanOrEqual(2.4 - 1e-9);
            expect(n("zwR"), JSON.stringify(values)).toBeGreaterThanOrEqual(2.4 - 1e-9);
            // A row of k windows (and the shutters beyond its ends, which `margin` allows for) fits its room.
            const row = (k: number) => k * n("ww") + (k - 1) * n("gap") + n("margin");
            expect(row(n("kL"))).toBeLessThanOrEqual(n("zwL") + 1e-9);
            expect(row(n("kR"))).toBeLessThanOrEqual(n("zwR") + 1e-9);
        }
    });
});

describe("Mesha variation", () => {
    const chair = lookupObject("furniture.office_chair")!;
    it("is deterministic per seed and respects rules", () => {
        const a = vary(chair, defaultValues(chair), { amount: 0.8, seed: 5 });
        const b = vary(chair, defaultValues(chair), { amount: 0.8, seed: 5 });
        expect(a.values).toEqual(b.values);
        expect(a.violations).toEqual([]);
        expect(a.changed.length).toBeGreaterThan(3);
    });
    it("never touches locked parameters or locked groups", () => {
        const base = resolveParams(chair, { upholstery: "leather.tan", seatWidth: 0.55 });
        for (let seed = 1; seed < 20; seed++) {
            const v = vary(chair, base, { amount: 1, seed, locked: ["seatWidth", "group:materials"] });
            expect(v.values.seatWidth).toBe(0.55);
            expect(v.values.upholstery).toBe("leather.tan");
            expect(v.values.frameFinish).toBe(base.frameFinish);
        }
    });
    it("scales with the amount: tiny amounts make tiny changes", () => {
        const base = defaultValues(chair);
        const small = vary(chair, base, { amount: 0.05, seed: 9 });
        expect(Math.abs(Number(small.values.seatHeight) - Number(base.seatHeight))).toBeLessThan(0.03);
        expect(small.values.base).toBe(base.base);
    });
});

describe("Mesha scene and rendering", () => {
    it("bakes each placed object into one world-space mesh per material", () => {
        const scene = buildScene([
            { id: "a", objectId: "furniture.table", values: {}, position: [0, 0, 0], rotationY: 0, scale: 1 },
            { id: "b", objectId: "household.bottle", values: {}, position: [0.3, 0.75, 0], rotationY: 90, scale: 1 },
        ], lookupObject);
        expect(scene.length).toBe(2);
        const bottle = scene[1];
        expect(bottle.meshes.map(m => m.region).sort()).toEqual(["cork", "glass", "label"]);
        const minY = Math.min(...bottle.meshes.flatMap(m => m.positions.filter((_, i) => i % 3 === 1)));
        expect(minY).toBeGreaterThan(0.74);
    });
    it("renders a contact-sheet tile with the object in frame", () => {
        const e = evaluateObject(lookupObject("household.bottle")!, {}, lookupObject);
        const img = render(e.mesh, e.materials, { width: 64, height: 64, ss: 1 });
        expect(img.data.length).toBe(64 * 64 * 4);
        const centre = (32 * 64 + 32) * 4, corner = 0;
        expect(img.data.slice(centre, centre + 3)).not.toEqual(img.data.slice(corner, corner + 3));
        const shadow = contactShadowMap(e.mesh, e.stats.bounds!, 32);
        expect(Math.max(...shadow.values)).toBeGreaterThan(0.2);
    });
});
