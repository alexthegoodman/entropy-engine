// Automatic checks for procedural objects: cheap deterministic geometry tests, and a parameter
// fuzzer that drives every parameter to its extremes, every option, combinations and random
// configurations. The result is the "is this generator ready?" report, and the configurations
// worth rendering onto a contact sheet for a visual pass.

import { type Mesh, type Vec3, sub3, cross3, dot3, length3, normalize3 } from "./mesha_mesh";
import { type ObjectDef, type ParamValues, type Evaluation, type ObjectLookup, evaluateObject, defaultValues, materialChoices, validateDefinition, resolveParams } from "./mesha_object";
import { vary } from "./mesha_variation";
import { rng } from "./mesha_noise";

export type Severity = "error" | "warning" | "info";

export interface Issue { code: string; severity: Severity; message: string }

export interface GeometryReport {
    issues: Issue[];
    triangles: number;
    degenerate: number;
    inverted: number;
    components: number;
    openEdges: number;
}

/** Deterministic checks on one evaluated configuration. */
export function checkGeometry(def: ObjectDef, e: Evaluation, options: { topology?: boolean } = {}): GeometryReport {
    const issues: Issue[] = [];
    const mesh = e.mesh;
    let triangles = 0, degenerate = 0, inverted = 0, badNumbers = 0, badNormals = 0;
    const b = e.stats.bounds;
    const diag = b ? length3(sub3(b.max, b.min)) : 0;
    const areaEps = Math.max(1e-14, diag * diag * 1e-11);
    for (const p of mesh.parts) {
        for (const x of p.positions) if (!Number.isFinite(x)) badNumbers++;
        for (let v = 0; v < p.normals.length; v += 3) {
            const l = Math.hypot(p.normals[v], p.normals[v + 1], p.normals[v + 2]);
            if (!Number.isFinite(l) || Math.abs(l - 1) > 1e-3) badNormals++;
        }
        for (let t = 0; t < p.indices.length; t += 3) {
            triangles++;
            const ids = [p.indices[t], p.indices[t + 1], p.indices[t + 2]];
            if (ids.some(i => i < 0 || i * 3 + 2 >= p.positions.length)) { badNumbers++; continue; }
            const pt = ids.map(i => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]] as Vec3);
            const fn = cross3(sub3(pt[1], pt[0]), sub3(pt[2], pt[0]));
            const area = length3(fn) / 2;
            if (!(area > areaEps)) { degenerate++; continue; }
            const vn: Vec3 = [0, 0, 0];
            for (const i of ids) { vn[0] += p.normals[i * 3]; vn[1] += p.normals[i * 3 + 1]; vn[2] += p.normals[i * 3 + 2]; }
            if (dot3(normalize3(fn), normalize3(vn)) < -0.2) inverted++;
        }
    }
    const limits = def.limits ?? {};
    if (badNumbers) issues.push({ code: "nan", severity: "error", message: `${badNumbers} invalid numbers or indices` });
    if (!triangles) issues.push({ code: "empty", severity: "error", message: "No geometry" });
    if (badNormals) issues.push({ code: "normals", severity: "error", message: `${badNormals} normals not unit length` });
    if (triangles && degenerate / triangles > 0.02) issues.push({ code: "degenerate", severity: "error", message: `${degenerate} of ${triangles} faces are degenerate` });
    else if (degenerate) issues.push({ code: "degenerate", severity: "info", message: `${degenerate} degenerate faces` });
    if (triangles && inverted / triangles > 0.01) issues.push({ code: "inverted", severity: "error", message: `${inverted} faces point inward` });
    else if (inverted) issues.push({ code: "inverted", severity: "warning", message: `${inverted} faces point inward` });
    if (b) {
        const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
        if (limits.maxSize !== undefined && size > limits.maxSize) issues.push({ code: "bounds", severity: "error", message: `Extreme size ${size.toFixed(3)} m (limit ${limits.maxSize} m)` });
        if (limits.minSize !== undefined && size < limits.minSize) issues.push({ code: "bounds", severity: "error", message: `Too small: ${size.toFixed(4)} m (limit ${limits.minSize} m)` });
        if (b.min[1] < -1e-3 * Math.max(1, size)) issues.push({ code: "floor", severity: "warning", message: `Dips ${(-b.min[1]).toFixed(4)} m below the floor` });
    }
    if (limits.maxTriangles !== undefined && triangles > limits.maxTriangles) issues.push({ code: "budget", severity: "warning", message: `${triangles} triangles (budget ${limits.maxTriangles})` });
    if (e.stats.ms > 250) issues.push({ code: "slow", severity: "warning", message: `Evaluation took ${e.stats.ms.toFixed(0)} ms` });
    for (const region of new Set(mesh.parts.map(p => p.region))) {
        if (!def.regions[region]) issues.push({ code: "material", severity: "error", message: `Region "${region}" has no material` });
    }
    for (const v of e.violations) issues.push({ code: "rule", severity: "warning", message: v });
    const topo = options.topology ? topology(mesh) : { components: 0, openEdges: 0 };
    return { issues, triangles, degenerate, inverted, ...topo };
}

/** Pieces (welded by position) and edges used by only one face: informational, parts are often separate solids. */
export function topology(mesh: Mesh): { components: number; openEdges: number } {
    const key = (x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    const ids = new Map<string, number>();
    const parent: number[] = [];
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const edges = new Map<string, number>();
    for (const p of mesh.parts) {
        const local = new Array<number>(p.positions.length / 3);
        for (let v = 0; v < local.length; v++) {
            const k = key(p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]);
            let id = ids.get(k);
            if (id === undefined) { id = parent.length; ids.set(k, id); parent.push(id); }
            local[v] = id;
        }
        for (let t = 0; t < p.indices.length; t += 3) {
            const a = local[p.indices[t]], b = local[p.indices[t + 1]], c = local[p.indices[t + 2]];
            for (const [x, y] of [[a, b], [b, c], [c, a]]) {
                if (x === y) continue;
                const ek = x < y ? `${x}_${y}` : `${y}_${x}`;
                edges.set(ek, (edges.get(ek) ?? 0) + 1);
                const rx = find(x), ry = find(y);
                if (rx !== ry) parent[rx] = ry;
            }
        }
    }
    const roots = new Set<number>();
    for (let i = 0; i < parent.length; i++) roots.add(find(i));
    let open = 0;
    for (const c of edges.values()) if (c === 1) open++;
    return { components: roots.size, openEdges: open };
}

export interface FuzzCase { label: string; values: ParamValues }

/** The strategic configurations: defaults, presets, each extreme, each option, pairs of extremes, random picks. */
export function fuzzCases(def: ObjectDef, options: { pairs?: number; random?: number; seed?: number } = {}): FuzzCase[] {
    const cases: FuzzCase[] = [{ label: "default", values: {} }];
    for (const p of def.presets ?? []) cases.push({ label: `preset ${p.name}`, values: p.values });
    const base = defaultValues(def);
    const extremes: FuzzCase[] = [];
    for (const p of def.params) {
        if (p.type === "number" || p.type === "int") {
            // Numbers far outside any range: resolveParams clamps them to the (possibly dynamic) bound.
            extremes.push({ label: `${p.id}=min`, values: { [p.id]: -1e9 } });
            extremes.push({ label: `${p.id}=max`, values: { [p.id]: 1e9 } });
        } else if (p.type === "bool") {
            cases.push({ label: `${p.id}=${!base[p.id]}`, values: { [p.id]: !base[p.id] } });
        } else if (p.type === "enum" || p.type === "material") {
            const opts = p.type === "enum" ? p.options ?? [] : materialChoices(p);
            for (const o of opts) if (o !== base[p.id]) cases.push({ label: `${p.id}=${o}`, values: { [p.id]: o } });
        }
    }
    cases.push(...extremes);
    const random = rng(options.seed ?? 1);
    for (let i = 0; i < (options.pairs ?? 24) && extremes.length > 1; i++) {
        const a = extremes[Math.floor(random() * extremes.length)], b = extremes[Math.floor(random() * extremes.length)];
        if (a === b) continue;
        cases.push({ label: `${a.label} & ${b.label}`, values: { ...a.values, ...b.values } });
    }
    for (let i = 0; i < (options.random ?? 40); i++) {
        // What a user gets from Variation at full strength: rules respected where possible.
        const v = vary(def, base, { amount: 1, seed: (options.seed ?? 1) * 1000 + i });
        cases.push({ label: `random ${i + 1}`, values: v.values });
    }
    return cases;
}

export interface FuzzResult {
    label: string;
    values: ParamValues;
    issues: Issue[];
    ms: number;
    triangles: number;
}

export interface Acceptance {
    id: string;
    name: string;
    parameters: number;
    groups: number;
    constraints: number;
    materials: number;
    configurations: number;
    failures: FuzzResult[];
    warnings: FuzzResult[];
    definitionProblems: string[];
    averageMs: number;
    maxMs: number;
    maxTriangles: number;
    ready: boolean;
    results: FuzzResult[];
}

/** Runs every fuzz case and summarizes. `ready` means no definition problems and no geometry errors. */
export function fuzz(def: ObjectDef, lookup: ObjectLookup, options: { pairs?: number; random?: number; seed?: number } = {}): Acceptance {
    const definitionProblems = validateDefinition(def, lookup);
    const results: FuzzResult[] = [];
    for (const c of fuzzCases(def, options)) {
        let issues: Issue[];
        let ms = 0, triangles = 0;
        const values = resolveParams(def, c.values);
        try {
            const e = evaluateObject(def, values, lookup);
            const report = checkGeometry(def, e);
            issues = report.issues;
            ms = e.stats.ms; triangles = report.triangles;
        } catch (error) {
            issues = [{ code: "exception", severity: "error", message: (error as Error).message }];
        }
        results.push({ label: c.label, values, issues, ms, triangles });
    }
    const dynamicBounds = def.params.filter(p => typeof p.min === "string" || typeof p.max === "string").length;
    const failures = results.filter(r => r.issues.some(i => i.severity === "error"));
    const warnings = results.filter(r => !failures.includes(r) && r.issues.some(i => i.severity === "warning"));
    const times = results.map(r => r.ms);
    return {
        id: def.id,
        name: def.name,
        parameters: def.params.length,
        groups: def.groups.length,
        constraints: (def.rules?.length ?? 0) + dynamicBounds,
        materials: Object.keys(def.regions).length,
        configurations: results.length,
        failures,
        warnings,
        definitionProblems,
        averageMs: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length),
        maxMs: Math.max(0, ...times),
        maxTriangles: Math.max(0, ...results.map(r => r.triangles)),
        ready: !definitionProblems.length && !failures.length,
        results,
    };
}

/** The human summary the doc's "Acceptance" section describes. */
export function acceptanceText(a: Acceptance, inspected = 0): string {
    const lines = [
        `${a.name} - ${a.ready ? "Ready" : "Not ready"}`,
        "",
        `${a.parameters} parameters`,
        `${a.groups} parameter groups`,
        `${a.constraints} constraints`,
        `${a.materials} materials`,
        `${a.configurations} configurations tested`,
    ];
    if (inspected) lines.push(`${inspected} configurations visually inspected`);
    lines.push(a.failures.length ? `Geometry tests FAILED in ${a.failures.length} configurations` : "Geometry tests passed");
    if (a.warnings.length) lines.push(`${a.warnings.length} configurations with warnings`);
    if (a.definitionProblems.length) lines.push(`Definition problems: ${a.definitionProblems.length}`);
    lines.push(`Average evaluation: ${a.averageMs.toFixed(0)} ms (max ${a.maxMs.toFixed(0)} ms, up to ${a.maxTriangles} triangles)`);
    return lines.join("\n");
}
