// Object-specific relationships for the room-and-street families (cabinet, seating, shelving,
// books, crates, tableware, sofas, beds, fences, stairs, street lights, pipework): the checks the
// generic fuzzer can't make, such as drawers that slide out of their openings, stair treads where
// the risers say, books that fit under the shelf above, and gates that swing clear of their bay.
import { describe, expect, it } from "vitest";
import { type Mesh, type Vec3, bounds, sub3, cross3, dot3 } from "../src/apps/mesha/mesha_mesh";
import { evaluateObject, evaluateExpression, type ParamValues } from "../src/apps/mesha/mesha_object";
import { lookupObject } from "../src/apps/mesha/library";

const def = (id: string) => lookupObject(id)!;
const build = (id: string, values: ParamValues = {}) => evaluateObject(def(id), values, lookupObject);
const num = (id: string, values: ParamValues, expr: string) => Number(evaluateExpression(def(id), values, `=${expr}`));

function flatten(mesh: Mesh, regions?: string[]): Float64Array {
    const out: number[] = [];
    for (const p of mesh.parts) {
        if (regions && !regions.includes(p.region)) continue;
        for (const i of p.indices) out.push(p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]);
    }
    return Float64Array.from(out);
}

// Distance to the nearest triangle along a ray (Infinity on a miss).
function cast(tris: Float64Array, o: Vec3, d: Vec3): number {
    let nearest = Infinity;
    for (let i = 0; i < tris.length; i += 9) {
        const a: Vec3 = [tris[i], tris[i + 1], tris[i + 2]], b: Vec3 = [tris[i + 3], tris[i + 4], tris[i + 5]], c: Vec3 = [tris[i + 6], tris[i + 7], tris[i + 8]];
        const e1 = sub3(b, a), e2 = sub3(c, a), h = cross3(d, e2), det = dot3(e1, h);
        if (Math.abs(det) < 1e-12) continue;
        const s = sub3(o, a), u = dot3(s, h) / det;
        if (u < 0 || u > 1) continue;
        const q = cross3(s, e1), v = dot3(d, q) / det;
        if (v < 0 || u + v > 1) continue;
        const t = dot3(e2, q) / det;
        if (t > 1e-7 && t < nearest) nearest = t;
    }
    return nearest;
}

const regionBounds = (mesh: Mesh, region: string) => bounds({ parts: mesh.parts.filter(p => p.region === region) });

describe("Mesha hardware components", () => {
    it("every handle style stands out from its mounting face into +Z", () => {
        for (const style of ["bar", "bow", "knob", "cup", "ring", "tab"]) {
            const b = build("component.handle", { style }).stats.bounds!;
            expect(b.max[2], style).toBeGreaterThan(0.004);
            expect(b.min[2], style).toBeGreaterThan(-0.004);
        }
    });
    it("a hinge's second leaf swings about the pin", () => {
        const flat = build("component.hinge", { open: 180 }).stats.bounds!, square = build("component.hinge", { open: 90 }).stats.bounds!;
        expect(flat.max[0]).toBeGreaterThan(0.02);
        expect(square.max[2]).toBeGreaterThan(0.02);
        expect(square.max[0]).toBeLessThan(0.01);
    });
});

describe("Mesha cabinet", () => {
    it("drawers slide out of their openings, the top one furthest, and stay engaged", () => {
        const values = { layout: "drawers", drawers: 3, bays: 1, open: 1 };
        const shut = build("furniture.cabinet", { ...values, open: 0 }).stats.bounds!, out = build("furniture.cabinet", values).stats.bounds!;
        const depth = num("furniture.cabinet", values, "depth"), boxD = num("furniture.cabinet", values, "boxD");
        expect(shut.max[2]).toBeLessThan(depth / 2 + 0.05);
        expect(out.max[2]).toBeGreaterThan(depth / 2 + boxD * 0.7);
        // Still engaged: the back of the drawer box stays inside the carcass.
        expect(out.max[2] - boxD - 0.019).toBeLessThan(depth / 2);
    });
    it("closed doors fill the front; open doors swing clear to show the shelves inside", () => {
        const values = { layout: "doors", bays: 1, width: 0.8, shelves: 0, frontStyle: "slab" };
        const shut = flatten(build("furniture.cabinet", values).mesh), open = flatten(build("furniture.cabinet", { ...values, open: 1 }).mesh);
        const y = num("furniture.cabinet", values, "y0 + bodyH / 2"), depth = num("furniture.cabinet", values, "depth");
        expect(3 - cast(shut, [0.1, y, 3], [0, 0, -1])).toBeCloseTo(depth / 2, 2);
        // Through the open doorway to the back panel.
        expect(3 - cast(open, [0.1, y, 3], [0, 0, -1])).toBeLessThan(-depth / 2 + 0.02);
    });
});

describe("Mesha chairs, stools and benches", () => {
    it("every leg meets the seat, however splayed, for chairs, round stools and benches", () => {
        for (const values of [{}, { splay: 12 }, { seatShape: "round", backStyle: "none", splay: 10, seatHeight: 0.76 }, { seats: 4, seatStyle: "slatted" }]) {
            const mesh = flatten(build("furniture.chair", values).mesh);
            const legH = num("furniture.chair", values, "legH"), lx = num("furniture.chair", values, "lx"), lz = num("furniture.chair", values, "lz");
            const lt = num("furniture.chair", values, "lt");
            for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
                // Just under the seat, a ray in from the side finds each leg's top where it should be.
                const hit = 2 - cast(mesh, [sx * 2, legH - 0.005, sz * lz], [-sx, 0, 0]);
                expect(hit, `${JSON.stringify(values)} ${sx} ${sz}`).toBeGreaterThan(lx - lt);
                expect(hit, `${JSON.stringify(values)} ${sx} ${sz}`).toBeLessThan(lx + lt);
            }
            expect(build("furniture.chair", values).stats.bounds!.min[1]).toBeGreaterThan(-1e-4);
        }
    });
});

describe("Mesha shelving and books", () => {
    it("books stand on the shelves and never reach the board above", () => {
        for (const values of [{}, { width: 2.4, height: 2.2, bays: 3, shelves: 6 }, { construction: "frame", books: true, shelves: 5 }]) {
            const e = build("furniture.shelving", values);
            const y0 = num("furniture.shelving", values, "y0"), pitch = num("furniture.shelving", values, "pitch"), bd = num("furniture.shelving", values, "bd");
            let books = 0;
            for (const p of e.mesh.parts) {
                if (!["cover", "cover2", "cover3", "cover4", "pages", "label"].includes(p.region)) continue;
                for (let v = 1; v < p.positions.length; v += 3) {
                    const rel = p.positions[v] - y0, frac = rel - Math.floor(rel / pitch + 1e-9) * pitch;
                    expect(frac, JSON.stringify(values)).toBeGreaterThan(bd - 1e-4);
                    books++;
                }
            }
            expect(books).toBeGreaterThan(100);
        }
    });
    it("a book stands its height and lies open symmetric about its gutter", () => {
        expect(build("household.book", { height: 0.3 }).stats.bounds!.max[1]).toBeCloseTo(0.3, 3);
        const open = build("household.book", { pose: "open" }).stats.bounds!;
        expect(open.max[0] + open.min[0]).toBeCloseTo(0, 3);
        expect(open.min[1]).toBeGreaterThan(-1e-4);
    });
});

describe("Mesha crates and tableware", () => {
    it("a crate, a carton and a tote are hollow: looking in from above reaches the floor", () => {
        for (const style of ["crate", "carton", "tote"]) {
            const values = { style, lid: false, open: 1 };
            const hit = 2 - cast(flatten(build("household.crate", values).mesh), [0.02, 2, 0.01], [0, -1, 0]);
            expect(hit, style).toBeLessThan(0.04);
        }
    });
    it("a tote's hand holes go right through its end walls", () => {
        const values = { style: "tote", handHoles: true, lid: false };
        const y = num("household.crate", values, "(holeY + thh / 2) * cos(ta)");
        const mesh = flatten(build("household.crate", values).mesh);
        expect(cast(mesh, [2, y, 0], [-1, 0, 0])).toBe(Infinity);
        expect(cast(mesh, [2, y * 0.4, 0], [-1, 0, 0])).toBeLessThan(2);
    });
    it("plates and bowls have a real wall and a foot to stand on", () => {
        for (const values of [{}, { shape: "bowl", height: 0.07, diameter: 0.16, steepness: 0.85, rimWidth: 0, well: 0.35 }]) {
            const mesh = flatten(build("household.dish", values).mesh);
            const yf = num("household.dish", values, "yf");
            // Down onto the well, then up into the underside under it: the floor is one wall thick.
            const top = 1 - cast(mesh, [0, 1, 0], [0, -1, 0]), under = cast(mesh, [0, -1, 0], [0, 1, 0]) - 1;
            expect(top).toBeCloseTo(yf, 3);
            expect(top - under).toBeCloseTo(num("household.dish", values, "wall"), 3);
        }
    });
});

describe("Mesha sofas and beds", () => {
    it("seat cushions follow the seats; arms stand outside them", () => {
        for (const seats of [1, 2, 3, 4]) {
            const e = build("furniture.sofa", { seats, seatWidth: 0.6 });
            const pads = e.mesh.parts.filter(p => p.region === "upholstery");
            expect(pads.length).toBeGreaterThan(0);
            const b = e.stats.bounds!;
            expect(b.max[0] - b.min[0]).toBeCloseTo(seats * 0.6 + 2 * num("furniture.sofa", { seats, seatWidth: 0.6 }, "aw"), 2);
        }
    });
    it("the mattress lies on the deck, and a bunk's upper deck is a metre above the lower", () => {
        const values = { bedding: "none", headboard: "none" };
        const top = 3 - cast(flatten(build("furniture.bed", values).mesh), [0.1, 3, 0.2], [0, -1, 0]);
        expect(top).toBeCloseTo(num("furniture.bed", values, "y0 + mattress"), 2);
        const bunk = { width: 0.9, frame: "legs", bunk: true, bedding: "none" };
        const hit = 3 - cast(flatten(build("furniture.bed", bunk).mesh), [0.1, 3, 0.2], [0, -1, 0]);
        expect(hit).toBeCloseTo(num("furniture.bed", bunk, "upperY + mattress"), 2);
    });
});

describe("Mesha fences, stairs and street furniture", () => {
    it("a gate closes its bay and swings clear of it", () => {
        const values = { length: 6, postSpacing: 2, gate: true, gateBay: 1, infillStyle: "boards", height: 1.6 };
        const bayX = num("architecture.fence", values, "-length / 2 + gateBay * span + span / 2");
        const shut = flatten(build("architecture.fence", { ...values, gateOpen: 0 }).mesh), open = flatten(build("architecture.fence", { ...values, gateOpen: 95 }).mesh);
        for (const y of [0.4, 0.9, 1.3]) {
            expect(cast(shut, [bayX, y, 3], [0, 0, -1])).toBeLessThan(3.1);
            expect(cast(open, [bayX + 0.2, y, 3], [0, 0, -1])).toBe(Infinity);
        }
    });
    it("every tread is where its riser says, with equal risers, on straight and turning stairs", () => {
        for (const values of [{ railSide: "none" }, { railSide: "none", style: "open", rise: 2.6 }, { railSide: "none", type: "landing", rise: 3 }]) {
            const mesh = flatten(build("architecture.stair", values).mesh);
            const n1 = num("architecture.stair", values, "n1"), r = num("architecture.stair", values, "rise1"), g = num("architecture.stair", values, "going");
            for (let i = 0; i < n1 - 1; i++) {
                const y = 5 - cast(mesh, [0.05, 5, -i * g - g / 2], [0, -1, 0]);
                expect(y, `${JSON.stringify(values)} tread ${i}`).toBeCloseTo((i + 1) * r, 3);
            }
        }
        // A quarter turn arrives at the full rise.
        const turn = { type: "lLeft", rise: 2.8, topLanding: true, railSide: "none" };
        const tx = num("architecture.stair", turn, "topX - landingDepth / 2"), tz = num("architecture.stair", turn, "topZ");
        expect(5 - cast(flatten(build("architecture.stair", turn).mesh), [tx, 5, tz], [0, -1, 0])).toBeCloseTo(2.8, 3);
    });
    it("a ramp climbs at its gradient and rests level between runs", () => {
        const values = { type: "ramp", rise: 1.2, gradient: 6, railSide: "none" };
        const mesh = flatten(build("architecture.stair", values).mesh);
        const segLen = num("architecture.stair", values, "segLen"), segRise = num("architecture.stair", values, "segRise");
        const y = (z: number) => 5 - cast(mesh, [0, 5, z], [0, -1, 0]);
        expect(y(-segLen / 2)).toBeCloseTo(segRise / 2, 2);
        expect(y(-segLen - 0.75)).toBeCloseTo(segRise, 3);
    });
    it("a lit lamp glows; an unlit one shows frosted glass", () => {
        expect(build("street.streetlight", { lit: true }).mesh.parts.some(p => p.region === "lamp")).toBe(true);
        const dark = build("street.streetlight", { lit: false }).mesh.parts.map(p => p.region);
        expect(dark).not.toContain("lamp");
        expect(dark).toContain("glass");
    });
    it("an open pipe end shows its bore; a valve sits on the run", () => {
        const values = { layout: "straight", ends: "open", valve: "gate", length: 3, supports: "none", joints: "none" };
        const e = build("mechanical.pipe", values);
        const y = num("mechanical.pipe", values, "y");
        const bore = cast(flatten(e.mesh, ["bore"]), [5, y, 0], [-1, 0, 0]);
        expect(5 - bore).toBeCloseTo(1.5, 2);
        const valve = regionBounds(e.mesh, "valve")!;
        expect(valve.min[1]).toBeLessThan(y);
        expect(valve.max[1]).toBeGreaterThan(y);
    });
});
