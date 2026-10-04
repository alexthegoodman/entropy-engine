import { describe, expect, it } from "vitest";
import { buildFigure, buildSkeleton, measures, DEFAULT_FIGURE, type BoneName } from "../src/apps/mesha/mesha_figure";
import { dress, penetration, footwear, shoeLift } from "../src/apps/mesha/mesha_cloth";
import { growHair, SEGMENTS } from "../src/apps/mesha/mesha_hair";
import { dynamicOf } from "../src/apps/mesha/mesha_dynamics";
import { evaluateObject, resolveParams } from "../src/apps/mesha/mesha_object";
import { lookupObject } from "../src/apps/mesha/library";
import { checkGeometry, topology } from "../src/apps/mesha/mesha_verify";
import { type Mesh, type Vec3, bounds, compose4 } from "../src/apps/mesha/mesha_mesh";
import { packVertices, PATTERN_IDS } from "../src/apps/mesha/mesha_scene";
import { material } from "../src/apps/mesha/mesha_materials";
import { MESHA_SHADER } from "../src/apps/mesha/mesha_shader";
import { fieldOf } from "../src/apps/mesha/mesha_sdf";

const human = lookupObject("people.human")!;
const region = (mesh: Mesh, name: string) => ({ parts: mesh.parts.filter(p => p.region === name) });
const ys = (mesh: Mesh) => mesh.parts.flatMap(p => p.positions.filter((_, i) => i % 3 === 1));
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("Mesha people: the body", () => {
    it("poses without stretching a bone, and each pose reads as itself", () => {
        const M = measures(DEFAULT_FIGURE);
        const rest = buildSkeleton({ ...DEFAULT_FIGURE, pose: "apose" }, M);
        const length = (sk: typeof rest, b: BoneName) => { const bone = sk.bones.get(b)!; return dist(sk.pt(b, bone.head), sk.pt(b, bone.tail)); };
        for (const pose of ["relaxed", "tpose", "walking", "hipsHands", "wave", "contrapposto"] as const) {
            const sk = buildSkeleton({ ...DEFAULT_FIGURE, pose }, M);
            for (const b of ["upperarmL", "forearmR", "thighL", "shinR", "fingerL11", "neck"] as BoneName[]) expect(length(sk, b), `${pose} ${b}`).toBeCloseTo(length(rest, b), 9);
        }
        const T = buildSkeleton({ ...DEFAULT_FIGURE, pose: "tpose" }, M);
        const shoulder = T.bones.get("upperarmL")!.posedHead, wrist = T.bones.get("handL")!.posedHead;
        expect(Math.abs(wrist[1] - shoulder[1])).toBeLessThan(0.04); // arms out level
        expect(wrist[0] - shoulder[0]).toBeGreaterThan(0.45);
        const wave = buildSkeleton({ ...DEFAULT_FIGURE, pose: "wave" }, M);
        expect(wave.bones.get("handR")!.posedHead[1]).toBeGreaterThan(M.topY); // the waving hand is above the head
    });

    it("stands on the floor at its height, about seven and a half heads tall", { timeout: 60_000 }, () => {
        for (const p of [{ height: 1.6, masculinity: 0 }, { height: 1.9, masculinity: 1, muscle: 0.8 }]) {
            const { mesh, handle } = buildFigure({ ...p, detail: 2.6 });
            const b = bounds(mesh)!;
            expect(b.min[1]).toBeCloseTo(0, 3);
            expect(b.max[1] / p.height).toBeGreaterThan(0.97);
            expect(b.max[1] / p.height).toBeLessThan(1.03);
            expect(b.max[1] / handle.head.radii[1] / 2).toBeGreaterThan(6.8);
        }
    });

    it("is one closed skin (lips and nails are regions of it), with eyes in their sockets", { timeout: 60_000 }, () => {
        const { mesh, handle } = buildFigure({ detail: 2.6 });
        const skin = { parts: mesh.parts.filter(p => ["skin", "lips", "nails"].includes(p.region)) };
        // Closed but for the odd non-manifold cell where thin forms (lids, lips) meet.
        const skinTriangles = skin.parts.reduce((n, p) => n + p.indices.length / 3, 0);
        const topo = topology(skin);
        expect(topo.openEdges).toBeLessThan(skinTriangles * 0.001);
        expect(topo.components).toBeLessThanOrEqual(3);
        expect(region(mesh, "lips").parts.length).toBe(1);
        expect(region(mesh, "nails").parts[0].indices.length).toBeGreaterThan(0);
        // Each iris looks forward (+Z) from inside the face: in front of the head's center, behind the nose's tip.
        const iris = region(mesh, "iris").parts[0];
        const zs = iris.positions.filter((_, i) => i % 3 === 2);
        const nose = handle.headPoint(0, -0.036, 0.1)[2];
        expect(Math.min(...zs)).toBeGreaterThan(handle.head.center[2]);
        expect(Math.max(...zs)).toBeLessThan(nose);
        expect(checkGeometry(human, { mesh, params: {}, materials: {}, violations: [], stats: { triangles: 0, vertices: 0, bounds: bounds(mesh), ms: 0 } }).issues.filter(i => i.severity === "error")).toEqual([]);
    });

    it("masculinity and weight change the build", () => {
        // Half-widths of the torso alone (the arms hang beside it) at a landmark's height.
        const width = (p: object, at: "chest" | "hips" | "waist") => {
            const h = buildFigure({ ...p, detail: 2.6 }).handle, M = h.measures;
            const y = (at === "chest" ? M.shoulderY - 0.06 : at === "hips" ? M.hipY : M.waistY) * h.scale + h.lift;
            const f = fieldOf(h.segments.torso);
            let x = 0.4;
            while (x > 0 && f(x, y, -0.01) > 0) x -= 0.002;
            return x;
        };
        const shoulders = (p: object) => width(p, "chest") / width(p, "hips");
        expect(shoulders({ masculinity: 1 })).toBeGreaterThan(shoulders({ masculinity: 0 }) * 1.05);
        expect(width({ weight: 1 }, "waist")).toBeGreaterThan(width({ weight: 0 }, "waist") * 1.12);
    }, 60_000);
});

describe("Mesha people: clothes", () => {
    const fig = buildFigure({ toes: false, sole: shoeLift("sneakers").sole, detail: 2.4 });
    const h = fig.handle;

    it("drape over the body without passing through it, bottoms before tops", { timeout: 60_000 }, () => {
        const o = dress(h, { top: "tee", bottom: "jeans", detail: 2, settle: 25 });
        expect(o.garments.map(g => g.region)).toEqual(["bottom", "top"]);
        for (const g of o.garments) {
            const pen = penetration(g, h.field);
            expect(pen.inside / g.solver.n, g.region).toBeLessThan(0.01);
            expect(pen.worst, g.region).toBeGreaterThan(-0.004);
        }
        // Each garment is a two-sided shell with hems: its outer and inner surfaces and the strips joining them.
        const top = region(o.mesh, "top");
        expect(topology(top).openEdges).toBe(0);
    });

    it("a sleeve ends where its length says, and a tank top has none", () => {
        // How much cloth lies around a point on the left arm.
        // (Probed on the arm's outer side, away from the cloth over the torso beside it.)
        const clothNear = (sleeve: number, bone: BoneName, top: "tee" | "tank" = "tee") => {
            const o = dress(h, { top, sleeve, bottom: "none", detail: 2.2, settle: 0 });
            const j = h.joint(bone, 0.6);
            const at: Vec3 = [j[0] + 0.04, j[1], j[2]];
            const P = region(o.mesh, "top").parts[0].positions;
            let n = 0;
            for (let i = 0; i < P.length; i += 3) if (dist([P[i], P[i + 1], P[i + 2]], at) < 0.03) n++;
            return n;
        };
        expect(clothNear(0.25, "upperarmL")).toBeGreaterThan(5);
        expect(clothNear(0.25, "forearmL")).toBe(0);
        expect(clothNear(0.95, "forearmL")).toBeGreaterThan(5);
        expect(clothNear(0.5, "upperarmL", "tank")).toBe(0);
    }, 60_000);

    it("a flared skirt hangs to its length and falls into folds", { timeout: 60_000 }, () => {
        const o = dress(h, { top: "none", bottom: "skirt", bottomLength: 0.6, flare: 0.8, detail: 2, settle: 40 });
        const skirt = o.garments[0];
        const M = h.measures, waist = M.waistY * h.scale + h.lift;
        const hemTarget = waist - (waist - 0.05) * 0.6;
        const hem = Math.min(...ys(region(o.mesh, "bottom")));
        expect(hem).toBeLessThan(hemTarget + 0.06);
        expect(hem).toBeGreaterThan(0.02);
        // Folds: round the skirt at knee height its distance from the legs' axis rises and falls.
        const Y = (waist + hem) / 2, X = skirt.solver.x;
        const around = new Array(36).fill(0);
        for (let i = 0; i < skirt.solver.n; i++) {
            if (Math.abs(X[i * 3 + 1] - Y) > 0.02) continue;
            const a = Math.floor(((Math.atan2(X[i * 3 + 2], X[i * 3]) / Math.PI + 1) / 2) * 36) % 36;
            around[a] = Math.max(around[a], Math.hypot(X[i * 3], X[i * 3 + 2]));
        }
        let turns = 0;
        for (let a = 0; a < 36; a++) {
            const prev = around[(a + 35) % 36], cur = around[a], next = around[(a + 1) % 36];
            if (cur > prev && cur > next) turns++;
        }
        expect(turns).toBeGreaterThanOrEqual(3);
    });

    it("shoes fit the feet and stand on the floor; heels lift the heel", { timeout: 60_000 }, () => {
        for (const kind of ["sneakers", "boots", "flats", "heels"] as const) {
            const lift = shoeLift(kind);
            const f = buildFigure({ toes: false, sole: lift.sole, heel: lift.heel, detail: 2.6 });
            const shoes = footwear(f.handle, kind, 2);
            const b = bounds(shoes)!;
            expect(b.min[1], kind).toBeGreaterThanOrEqual(0);
            expect(b.min[1], kind).toBeLessThan(0.002);
            const skinLow = Math.min(...ys(f.mesh));
            expect(skinLow, kind).toBeGreaterThan(lift.sole * 0.9);
        }
    });
});

describe("Mesha people: hair", () => {
    const fig = buildFigure({ toes: false, detail: 2.4 });
    const h = fig.handle;
    const head = fieldOf(h.segments.head);

    it("grows inside the hairline and never through the head", { timeout: 60_000 }, () => {
        const r = growHair(h, h.body, { style: "long", detail: 2.4, settle: 20 });
        const s = r.solver!;
        let inside = 0;
        for (let i = 0; i < s.x.length; i += 3) if (head(s.x[i], s.x[i + 1], s.x[i + 2]) < -0.003) inside++;
        expect(inside / (s.x.length / 3)).toBeLessThan(0.01);
        // Roots are on the scalp, above the eyes and ears at the front.
        for (let i = 0; i < s.count; i++) {
            const j = i * s.stride * 3;
            expect(Math.abs(head(s.x[j], s.x[j + 1], s.x[j + 2]))).toBeLessThan(0.003);
            expect(s.x[j + 1]).toBeGreaterThan(h.head.eyeY - 0.09);
        }
        expect(r.strands).toBeGreaterThan(1000);
    });

    it("each style ends where it should: a bob at the jaw, long hair past the shoulders, a fringe above the eyes", () => {
        const lowest = (style: string, extra = {}) => Math.min(...ys(region(growHair(h, h.body, { style: style as never, detail: 2.4, settle: 25, ...extra }).mesh, "hair")));
        const chin = h.headPoint(0, -0.1, 0.06)[1], shoulders = h.measures.shoulderY * h.scale + h.lift;
        const bob = lowest("bob");
        expect(bob).toBeGreaterThan(chin - 0.08);
        expect(bob).toBeLessThan(h.head.eyeY - 0.03);
        expect(lowest("long")).toBeLessThan(shoulders - 0.05);
        expect(lowest("buzz")).toBeGreaterThan(h.head.eyeY - 0.01);
        // A fringe: no strand in front of the eyes.
        const r = growHair(h, h.body, { style: "bob", bangs: 1, detail: 2.4, settle: 25 });
        const P = region(r.mesh, "hair").parts[0].positions;
        for (const sd of [1, -1]) {
            const eye = h.headPoint(sd * 0.032, 0, 0.09);
            let near = Infinity;
            for (let i = 0; i < P.length; i += 3) near = Math.min(near, dist([P[i], P[i + 1], P[i + 2]], eye));
            expect(near).toBeGreaterThan(0.012);
        }
    }, 120_000);

    it("strands are ribbons with uv running root to tip and a random per strand", { timeout: 60_000 }, () => {
        const r = growHair(h, h.body, { style: "shoulder", detail: 2.4, settle: 10 });
        const part = region(r.mesh, "hair").parts[0];
        const S = SEGMENTS + 1;
        expect(part.positions.length / 3).toBe(r.strands * S * 2);
        expect(part.uvs[1]).toBe(0);
        expect(part.uvs[(S - 1) * 4 + 1]).toBe(1);
        expect(part.uvs[0]).toBe(part.uvs[(S - 1) * 4]);
        // Brows, lashes and the cap under the hair come with it; a beard only when asked.
        const regions = r.mesh.parts.map(p => p.region);
        for (const name of ["brows", "lashes", "hairCap"]) expect(regions).toContain(name);
        expect(regions).not.toContain("beard");
        expect(growHair(h, h.body, { style: "none", beard: "full", detail: 2.4 }).mesh.parts.map(p => p.region)).toContain("beard");
    });
});

describe("Mesha people: live physics", () => {
    it("hair and clothes swing when the figure turns, then settle back and sleep", () => {
        const e = evaluateObject(human, { quality: "draft", hairStyle: "ponytail", top: "tee", bottom: "skirt", flare: 0.6 }, lookupObject);
        const dynamic = e.mesh.parts.filter(p => dynamicOf(p));
        expect(dynamic.map(p => p.region).sort()).toEqual(["bottom", "hair", "top"]);
        for (const part of dynamic) {
            const sim = dynamicOf(part)!.spawn();
            expect(sim.vertexCount).toBe(part.positions.length / 3);
            const rest = Float32Array.from(part.positions);
            // Mean displacement from the settled shape.
            const deviation = () => { let d = 0; for (let i = 0; i < rest.length; i++) d += Math.abs(sim.positions[i] - rest[i]); return d / rest.length; };
            for (let f = 0; f < 60; f++) sim.step(1 / 60, compose4([0, 0, 0], [0, 0, 0], [1, 1, 1]), [0, 0, 0]);
            const settled = deviation();
            // A quick quarter turn: the hair and cloth lag behind (in the figure's own frame they move).
            for (let f = 1; f <= 6; f++) sim.step(1 / 60, compose4([0, 0, 0], [0, (f / 6) * 1.2, 0], [1, 1, 1]), [0, 0, 0]);
            const swung = deviation();
            expect(swung, part.region).toBeGreaterThan(settled + 0.005);
            let asleep = false;
            for (let f = 0; f < 600 && !asleep; f++) asleep = !sim.step(1 / 60, compose4([0, 0, 0], [0, 1.2, 0], [1, 1, 1]), [0, 0, 0]);
            expect(deviation(), part.region).toBeLessThan(swung);
            if (part.region === "hair") expect(asleep).toBe(true);
            expect(sim.positions.every(Number.isFinite)).toBe(true);
        }
    }, 120_000);
});

describe("Mesha people: materials and shading", () => {
    it("skin leans toward its flush and hair toward its tint per strand, through the vertex color", () => {
        const skin = material("skin.light"), hair = material("hair.brown");
        expect(skin.pattern).toBe("skin");
        const pack = (m: typeof skin, uv: number[]) => packVertices({ region: "x", material: m, positions: [0, 0, 0, 1, 0, 0], normals: [0, 1, 0, 0, 1, 0], uvs: uv, indices: [] }).vertexData;
        const s = pack(skin, [0, 0, 0, 0.9]);
        expect(s[12 + 8]).toBeCloseTo(skin.color[0] + (skin.tint![0] - skin.color[0]) * 0.9, 6);
        expect(Math.hypot(s[3], s[4], s[5])).toBeCloseTo(1 + PATTERN_IDS.skin, 6);
        const hr = pack(hair, [0, 0.5, 1, 0.5]);
        expect(hr[8]).toBeCloseTo(hair.color[0], 6);
        expect(hr[12 + 8]).toBeCloseTo(hair.color[0] + (hair.tint![0] - hair.color[0]) * 0.75, 6);
        for (const id of [17, 18, 19, 20, 21]) expect(MESHA_SHADER).toContain(`pattern == ${id}`);
        expect(material("eye.cornea").clear).toBeGreaterThan(0.8);
    });
});

describe("Mesha people: the object", () => {
    it("is ready across styles, garments, poses and extremes (draft quality)", () => {
        const cases: Record<string, unknown>[] = [{}];
        for (const p of human.presets ?? []) cases.push(p.values);
        for (const id of ["hairStyle", "top", "bottom", "shoes", "pose", "beard", "neckline", "part"]) {
            const param = human.params.find(q => q.id === id)!;
            for (const o of param.options ?? []) if (o !== param.default) cases.push({ [id]: o });
        }
        for (const id of ["height", "weight", "muscle", "masculinity", "topFit", "flare", "hairLength", "curl", "volume", "wind", "headTurn"]) cases.push({ [id]: -1e9 }, { [id]: 1e9 });
        cases.push({ top: "dress", flare: 1, bottomLength: 1, wind: 8 }, { hairStyle: "afro", curl: 1, volume: 1, pose: "tpose" }, { hairStyle: "long", bangs: 1, curl: 1, top: "sweater", topLength: 2 });
        const failures: string[] = [];
        for (const values of cases) {
            const e = evaluateObject(human, { ...values, quality: "draft" }, lookupObject);
            const errors = checkGeometry(human, e).issues.filter(i => i.severity === "error");
            if (errors.length) failures.push(`${JSON.stringify(values)}: ${errors.map(i => i.message).join("; ")}`);
            const b = e.stats.bounds!;
            expect(b.min[1], JSON.stringify(values)).toBeGreaterThan(-0.002);
        }
        expect(failures).toEqual([]);
    }, 600_000);

    it("draft builds a coarser person than final, from the same parameters", () => {
        const values = resolveParams(human, { hairStyle: "short", top: "tee", bottom: "shorts", shoes: "none" });
        const draft = evaluateObject(human, { ...values, quality: "draft" }, lookupObject);
        const final = evaluateObject(human, values, lookupObject);
        expect(draft.stats.triangles).toBeLessThan(final.stats.triangles * 0.6);
        // Changing only a material re-evaluates nothing heavy: the parts are the very same.
        const recolored = evaluateObject(human, { ...values, hairColor: "hair.blonde", skin: "skin.deep" }, lookupObject);
        expect(recolored.mesh.parts.find(p => p.region === "hair")!.positions).toBe(final.mesh.parts.find(p => p.region === "hair")!.positions);
        expect(recolored.materials.hair.id).toBe("hair.blonde");
    }, 120_000);
});
