// A Mesha procedural object is plain JSON: parameters with metadata (range, group, visibility,
// how much variation may move them), rules the parameters must satisfy, semantic regions bound to
// materials, and a list of catalog nodes whose inputs are literals, "=expressions" or "@node"
// references. `evaluateObject` turns a definition plus parameter values into geometry.

import { type Mesh, type Vec3, join, setRegion, transformMesh, compose4, emptyMesh, triangleCount, vertexCount, bounds, type Bounds } from "./mesha_mesh";
import { CATALOG, COMMON_NODE_FIELDS, type ComponentInput } from "./mesha_catalog";
import { evaluate, num, truthy, checkSyntax, referencedNames, type Scope, type Value } from "./mesha_expr";
import { material, MATERIAL_BY_ID, materialFamily, type MaterialPreset } from "./mesha_materials";

export type ParamType = "number" | "int" | "bool" | "enum" | "seed" | "material";
export type ParamValue = number | boolean | string;
export type ParamValues = Record<string, ParamValue>;

export interface ParamDef {
    id: string;
    label: string;
    type: ParamType;
    default: ParamValue;
    /** A number, or an "=expression" of other parameters for a range that depends on them. */
    min?: number | string;
    max?: number | string;
    step?: number;
    unit?: string;
    decimals?: number;
    /** enum: the stored values. */
    options?: string[];
    /** enum: what the user sees, parallel to `options`. */
    optionLabels?: string[];
    /** material: allowed preset ids or families ("wood" allows every wood.*). */
    materials?: string[];
    group: string;
    /** Shown (and varied) only while this expression holds: "=hasArms", "=base == 'star'". */
    visibleIf?: string;
    description?: string;
    /** How strongly Variation moves this parameter; 0 never touches it. Default 1. */
    variation?: number;
}

export interface GroupDef { id: string; label: string }

export interface RuleDef {
    /** Must evaluate true for a sensible object. */
    check: string;
    message: string;
}

export interface RegionDef {
    label: string;
    /** A material preset id, or an "=expression" (usually a material parameter). */
    material: string;
}

export interface NodeDef {
    id?: string;
    type: string;
    [key: string]: unknown;
}

export interface PresetDef { name: string; values: ParamValues }

export interface ObjectDef {
    id: string;
    name: string;
    category: string;
    tags?: string[];
    description?: string;
    /** Parameter ids shown at the top of the properties panel. */
    featured?: string[];
    groups: GroupDef[];
    params: ParamDef[];
    derived?: Record<string, string | number>;
    rules?: RuleDef[];
    regions: Record<string, RegionDef>;
    presets?: PresetDef[];
    nodes: NodeDef[];
    /** Sanity bounds for automatic checks: largest plausible dimension (m) and triangle budget. */
    limits?: { maxSize?: number; minSize?: number; maxTriangles?: number; floor?: boolean };
    /** A reusable building block (a leg, a caster) other objects compose; not listed in Add Object. */
    component?: boolean;
}

export interface Evaluation {
    mesh: Mesh;
    params: ParamValues;
    materials: Record<string, MaterialPreset>;
    /** Rules that failed, by message. */
    violations: string[];
    stats: { triangles: number; vertices: number; bounds: Bounds | null; ms: number };
}

export class MeshaError extends Error {}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// --- Parameters ----------------------------------------------------------------------------------

export function defaultValues(def: ObjectDef): ParamValues {
    return Object.fromEntries(def.params.map(p => [p.id, p.default]));
}

/** Allowed material ids for a material parameter, families expanded. */
export function materialChoices(p: ParamDef): string[] {
    const out: string[] = [];
    for (const m of p.materials ?? []) out.push(...(MATERIAL_BY_ID.has(m) ? [m] : materialFamily(m)));
    return [...new Set(out)];
}

function paramScope(def: ObjectDef, values: ParamValues): Scope {
    const derivedCache = new Map<string, Value>();
    const busy = new Set<string>();
    const scope: Scope = name => {
        if (name in values) return values[name];
        const d = def.derived?.[name];
        if (d === undefined) return undefined;
        const hit = derivedCache.get(name);
        if (hit !== undefined) return hit;
        if (busy.has(name)) throw new MeshaError(`Derived value "${name}" depends on itself`);
        busy.add(name);
        const v = typeof d === "number" ? d : evaluate(d, scope);
        busy.delete(name);
        derivedCache.set(name, v);
        return v;
    };
    return scope;
}

/** A parameter's range for these values (dynamic bounds evaluated). */
export function paramRange(p: ParamDef, scope: Scope): [number, number] {
    const bound = (b: number | string | undefined, fallback: number) => (b === undefined ? fallback : typeof b === "number" ? b : num(evaluate(b, scope)));
    const lo = bound(p.min, p.type === "seed" ? 0 : 0);
    const hi = bound(p.max, p.type === "seed" ? 99999 : 1);
    return lo <= hi ? [lo, hi] : [hi, lo];
}

/** UI bounds for current resolved values, including the object's derived dimensions. */
export function objectParamRange(def: ObjectDef, p: ParamDef, values: ParamValues): [number, number] {
    return paramRange(p, paramScope(def, values));
}

/**
 * Defaults, overridden by `values`, coerced to each parameter's type and clamped into its range.
 * Ranges that depend on other parameters are applied in declaration order, so a later parameter
 * clamps against the already-clamped earlier ones.
 */
export function resolveParams(def: ObjectDef, values: ParamValues = {}): ParamValues {
    const out: ParamValues = {};
    for (const p of def.params) out[p.id] = values[p.id] ?? p.default;
    // Ranges can depend on other parameters, declared before or after. Clamp everything to its
    // fixed bounds first, so no dynamic bound ever sees a wild input, then apply the dynamic
    // bounds until nothing moves.
    clampPass(def, out, true);
    for (let pass = 0; pass < 4; pass++) {
        const before = JSON.stringify(out);
        clampPass(def, out);
        if (JSON.stringify(out) === before) break;
    }
    return out;
}

function clampPass(def: ObjectDef, out: ParamValues, staticOnly = false): void {
    const scope = paramScope(def, out);
    for (const p of def.params) {
        const v = out[p.id];
        switch (p.type) {
            case "bool": out[p.id] = typeof v === "string" ? v === "true" : !!v; break;
            case "enum": {
                const s = String(v);
                out[p.id] = p.options?.includes(s) ? s : String(p.default);
                break;
            }
            case "material": {
                const s = String(v);
                const allowed = materialChoices(p);
                out[p.id] = allowed.includes(s) || (!allowed.length && MATERIAL_BY_ID.has(s)) ? s : String(p.default);
                break;
            }
            default: {
                let x = num(v as Value);
                if (!Number.isFinite(x)) x = num(p.default);
                const [lo, hi] = staticOnly
                    ? [typeof p.min === "number" ? p.min : -Infinity, typeof p.max === "number" ? p.max : Infinity]
                    : paramRange(p, scope);
                x = Math.max(lo, Math.min(hi, x));
                if (p.type === "int" || p.type === "seed") x = Math.round(x);
                out[p.id] = x;
            }
        }
    }
}

/** An "=expression" of `def`'s parameters and derived values at `values` (clamped first): what a node would see. */
export function evaluateExpression(def: ObjectDef, values: ParamValues, expression: string): Value {
    return evaluate(expression, paramScope(def, resolveParams(def, values)));
}

export function isParamVisible(def: ObjectDef, p: ParamDef, values: ParamValues): boolean {
    if (!p.visibleIf) return true;
    try { return truthy(evaluate(p.visibleIf, paramScope(def, values))); } catch { return true; }
}

export function ruleViolations(def: ObjectDef, values: ParamValues): string[] {
    const scope = paramScope(def, values);
    const out: string[] = [];
    for (const r of def.rules ?? []) {
        let ok = false;
        try { ok = truthy(evaluate(r.check, scope)); } catch (e) { out.push(`${r.message} (${(e as Error).message})`); continue; }
        if (!ok) out.push(r.message);
    }
    return out;
}

export function resolveMaterials(def: ObjectDef, values: ParamValues): Record<string, MaterialPreset> {
    const scope = paramScope(def, values);
    const out: Record<string, MaterialPreset> = {};
    for (const [region, r] of Object.entries(def.regions)) {
        let id = r.material;
        if (id.startsWith("=")) { try { id = String(evaluate(id, scope)); } catch { id = ""; } }
        out[region] = material(id);
    }
    return out;
}

// --- Graph ---------------------------------------------------------------------------------------

export type ObjectLookup = (id: string) => ObjectDef | undefined;

interface EvalContext {
    def: ObjectDef;
    values: ParamValues;
    root: Scope;
    lookup: ObjectLookup;
    nodes: Map<string, NodeDef>;
    memo: Map<string, unknown>;
    busy: Set<string>;
    depth: number;
}

const nodeId = (n: NodeDef, i: number) => n.id ?? `#${i}`;

function isRef(v: unknown): v is string {
    return typeof v === "string" && v.startsWith("@");
}

function resolveAny(ctx: EvalContext, raw: unknown, scope: Scope, where: string): unknown {
    if (typeof raw === "string") {
        if (raw.startsWith("=")) {
            try { return evaluate(raw, scope); } catch (e) { throw new MeshaError(`${where}: ${(e as Error).message}`); }
        }
        if (isRef(raw)) return nodeOutput(ctx, raw.slice(1), where);
        return raw;
    }
    if (Array.isArray(raw)) return raw.map(r => resolveAny(ctx, r, scope, where));
    if (raw && typeof raw === "object") {
        // { "if": "=cond", "then": a, "else": b } and { "switch": "=expr", "cases": { k: v }, "default": d }:
        // choose between node references (a curve, a mesh), which expressions alone can't name.
        const o = raw as Record<string, unknown>;
        if ("if" in o) return resolveAny(ctx, truthy(resolveAny(ctx, o.if, scope, `${where}.if`) as Value) ? o.then : o.else, scope, where);
        if ("switch" in o) {
            const key = String(resolveAny(ctx, o.switch, scope, `${where}.switch`));
            const cases = (o.cases ?? {}) as Record<string, unknown>;
            return resolveAny(ctx, key in cases ? cases[key] : o.default, scope, where);
        }
        throw new MeshaError(`${where}: objects must be { if, then, else } or { switch, cases, default }`);
    }
    return raw;
}

function coerce(input: ComponentInput, v: unknown, where: string): unknown {
    const finite = (x: unknown) => { const n = num(x as Value); if (!Number.isFinite(n)) throw new MeshaError(`${where}.${input.name} is not a finite number`); return n; };
    switch (input.kind) {
        case "number": { let x = finite(v); if (input.min !== undefined) x = Math.max(input.min, x); if (input.max !== undefined) x = Math.min(input.max, x); return x; }
        case "int": { let x = Math.round(finite(v)); if (input.min !== undefined) x = Math.max(input.min, x); if (input.max !== undefined) x = Math.min(input.max, x); return x; }
        case "bool": return truthy(v as Value);
        case "string": return String(v);
        case "enum": return input.options?.includes(String(v)) ? String(v) : input.default;
        case "vec2": case "vec3": {
            const size = input.kind === "vec2" ? 2 : 3;
            if (typeof v === "number") return new Array(size).fill(v);
            if (!Array.isArray(v) || v.length < size) throw new MeshaError(`${where}.${input.name} needs ${size} numbers`);
            return v.slice(0, size).map(finite);
        }
        case "curve2": case "points3": case "curve3": {
            if (v === null && input.default === null) return null;
            if (!Array.isArray(v)) throw new MeshaError(`${where}.${input.name} needs a list of points`);
            const size = input.kind === "curve2" ? 2 : 3;
            return v.map((p, i) => {
                if (!Array.isArray(p) || p.length < size) throw new MeshaError(`${where}.${input.name}[${i}] is not a point of ${size} numbers`);
                return p.slice(0, size).map(finite);
            });
        }
        case "curves2": {
            // A curve (list of points), a list of curves, or a list mixing both (["@bore", "@cutouts"]).
            const isCurve = (c: unknown) => Array.isArray(c) && c.length > 0 && Array.isArray(c[0]) && typeof c[0][0] === "number";
            if (!Array.isArray(v)) return [];
            if (isCurve(v)) return [v];
            const out: unknown[] = [];
            for (const c of v) {
                if (isCurve(c)) out.push(c);
                else if (Array.isArray(c)) for (const d of c) if (isCurve(d)) out.push(d);
            }
            return out;
        }
        case "mesh": return v && typeof v === "object" && "parts" in (v as object) ? v : emptyMesh();
        case "meshes": return (Array.isArray(v) ? v : [v]).filter(m => m && typeof m === "object" && "parts" in (m as object));
    }
}

function nodeOutput(ctx: EvalContext, id: string, where: string): unknown {
    if (ctx.memo.has(id)) return ctx.memo.get(id);
    const node = ctx.nodes.get(id);
    if (!node) throw new MeshaError(`${where}: no node "${id}"`);
    if (ctx.busy.has(id)) throw new MeshaError(`${where}: node "${id}" depends on itself`);
    ctx.busy.add(id);
    const out = evaluateNode(ctx, node, id);
    ctx.busy.delete(id);
    ctx.memo.set(id, out);
    return out;
}

function withLocals(scope: Scope, locals: Record<string, Value>): Scope {
    return name => (name in locals ? locals[name] : scope(name));
}

function evaluateNode(ctx: EvalContext, node: NodeDef, id: string): unknown {
    const where = `${ctx.def.id}:${id}`;
    const isObject = node.type === "object";
    const comp = CATALOG.get(node.type);
    if (!comp && !isObject) throw new MeshaError(`${where}: unknown node type "${node.type}"`);
    const output = isObject ? "mesh" : comp!.output;
    const empty = () => (output === "mesh" ? emptyMesh() : []);
    if (node.when !== undefined && !truthy(resolveAny(ctx, node.when, ctx.root, `${where}.when`) as Value)) return empty();
    const once = (scope: Scope): unknown => {
        let result: unknown;
        if (isObject) {
            const childDef = ctx.lookup(String(node.object));
            if (!childDef) throw new MeshaError(`${where}: no object "${String(node.object)}"`);
            if (ctx.depth > 8) throw new MeshaError(`${where}: objects nested too deeply`);
            const given = (node.params ?? {}) as Record<string, unknown>;
            const childValues: ParamValues = {};
            for (const [k, v] of Object.entries(given)) childValues[k] = resolveAny(ctx, v, scope, `${where}.params.${k}`) as ParamValue;
            if (childValues.seed === undefined && childDef.params.some(p => p.id === "seed")) childValues.seed = num(scope("seed") ?? 0) * 31 + num(scope("index") ?? 0) + 1;
            result = evaluateGraph(childDef, resolveParams(childDef, childValues), ctx.lookup, ctx.depth + 1);
        } else {
            const inputs: Record<string, unknown> = {};
            for (const input of comp!.inputs) {
                const raw = node[input.name] !== undefined ? node[input.name] : input.default;
                if (raw === undefined) throw new MeshaError(`${where}: missing input "${input.name}"`);
                inputs[input.name] = coerce(input, resolveAny(ctx, raw, scope, `${where}.${input.name}`), where);
            }
            try { result = comp!.build(inputs); } catch (e) {
                if (e instanceof MeshaError) throw e;
                throw new MeshaError(`${where}: ${(e as Error).message}`);
            }
        }
        if (output !== "mesh") return result;
        let mesh = result as Mesh;
        if (node.at !== undefined || node.rotate !== undefined || node.scale !== undefined) {
            const vec = (raw: unknown, fallback: number, name: string): Vec3 => {
                if (raw === undefined) return [fallback, fallback, fallback];
                const v = resolveAny(ctx, raw, scope, `${where}.${name}`);
                if (typeof v === "number") return [v, v, v];
                if (!Array.isArray(v) || v.length < 3) throw new MeshaError(`${where}.${name} needs 3 numbers`);
                return [num(v[0]), num(v[1]), num(v[2])];
            };
            const t = vec(node.at, 0, "at"), r = vec(node.rotate, 0, "rotate"), s = vec(node.scale, 1, "scale");
            const D = Math.PI / 180;
            mesh = transformMesh(mesh, compose4(t, [r[0] * D, r[1] * D, r[2] * D], s));
        }
        if (node.rest !== undefined && truthy(resolveAny(ctx, node.rest, scope, `${where}.rest`) as Value)) {
            const b = bounds(mesh);
            if (b && Math.abs(b.min[1]) > 1e-9) mesh = transformMesh(mesh, compose4([0, -b.min[1], 0]));
        }
        if (node.region !== undefined) mesh = setRegion(mesh, String(resolveAny(ctx, node.region, scope, `${where}.region`)));
        return mesh;
    };
    if (node.repeat === undefined) return once(ctx.root);
    const count = Math.max(0, Math.min(4096, Math.floor(num(resolveAny(ctx, node.repeat, ctx.root, `${where}.repeat`) as Value))));
    if (output !== "mesh") return count > 0 ? once(withLocals(ctx.root, { index: 0, count })) : [];
    const meshes: Mesh[] = [];
    for (let index = 0; index < count; index++) {
        const scope = withLocals(ctx.root, { index, count, t: count > 1 ? index / (count - 1) : 0 });
        // `keep` drops individual copies (a missing roof sheet, a broken pane) where `when` drops the node.
        if (node.keep !== undefined && !truthy(resolveAny(ctx, node.keep, scope, `${where}.keep`) as Value)) continue;
        meshes.push(once(scope) as Mesh);
    }
    return join(...meshes);
}

function evaluateGraph(def: ObjectDef, values: ParamValues, lookup: ObjectLookup, depth: number): Mesh {
    const nodes = new Map<string, NodeDef>();
    def.nodes.forEach((n, i) => nodes.set(nodeId(n, i), n));
    const ctx: EvalContext = { def, values, root: paramScope(def, values), lookup, nodes, memo: new Map(), busy: new Set(), depth };
    const parts: Mesh[] = [];
    def.nodes.forEach((n, i) => {
        const out = nodeOutput(ctx, nodeId(n, i), def.id);
        if (n.output === false) return;
        if (out && typeof out === "object" && "parts" in (out as object)) parts.push(out as Mesh);
    });
    return join(...parts);
}

/** Evaluates `def` at `values` (missing ones take defaults; everything is clamped). */
export function evaluateObject(def: ObjectDef, values: ParamValues = {}, lookup: ObjectLookup = () => undefined): Evaluation {
    const start = now();
    const params = resolveParams(def, values);
    const mesh = evaluateGraph(def, params, lookup, 0);
    const ms = now() - start;
    return {
        mesh,
        params,
        materials: resolveMaterials(def, params),
        violations: ruleViolations(def, params),
        stats: { triangles: triangleCount(mesh), vertices: vertexCount(mesh), bounds: bounds(mesh), ms },
    };
}

// --- Definition checks ---------------------------------------------------------------------------

/** Static problems in a definition: unknown types and inputs, bad expressions, dangling references. */
export function validateDefinition(def: ObjectDef, lookup: ObjectLookup = () => undefined): string[] {
    const problems: string[] = [];
    const paramIds = new Set(def.params.map(p => p.id));
    const derivedIds = new Set(Object.keys(def.derived ?? {}));
    const groupIds = new Set(def.groups.map(g => g.id));
    const nodeIds = new Set(def.nodes.map((n, i) => nodeId(n, i)));
    const locals = new Set(["index", "count", "t", "seed"]);
    const known = (name: string) => paramIds.has(name) || derivedIds.has(name) || locals.has(name);
    const checkExpr = (src: string, where: string) => {
        try { checkSyntax(src); } catch (e) { problems.push(`${where}: ${(e as Error).message}`); return; }
        for (const name of referencedNames(src)) if (!known(name)) problems.push(`${where}: unknown name "${name}"`);
    };
    const walk = (raw: unknown, where: string) => {
        if (raw === null && where.includes("[")) problems.push(`${where}: empty entry`);
        if (typeof raw === "string") {
            if (raw.startsWith("=")) checkExpr(raw, where);
            else if (raw.startsWith("@") && !nodeIds.has(raw.slice(1))) problems.push(`${where}: no node "${raw.slice(1)}"`);
        } else if (Array.isArray(raw)) {
            for (let i = 0; i < raw.length; i++) {
                if (raw[i] === undefined) problems.push(`${where}[${i}]: empty entry (a missing comma?)`);
                else walk(raw[i], `${where}[${i}]`);
            }
        }
        else if (raw && typeof raw === "object") {
            const o = raw as Record<string, unknown>;
            if ("if" in o) { walk(o.if, `${where}.if`); walk(o.then, `${where}.then`); walk(o.else, `${where}.else`); }
            else if ("switch" in o) { walk(o.switch, `${where}.switch`); for (const [k, v] of Object.entries((o.cases ?? {}) as object)) walk(v, `${where}.cases.${k}`); walk(o.default, `${where}.default`); }
            else problems.push(`${where}: objects must be { if, then, else } or { switch, cases, default }`);
        }
    };
    if (paramIds.size !== def.params.length) problems.push("duplicate parameter ids");
    // Inside a repeated node index, count and t are the copy's own: a parameter or derived value of
    // that name is silently hidden there (only `when` and `repeat` itself see the object's).
    const shadowed = ["index", "count", "t"].filter(name => paramIds.has(name) || derivedIds.has(name));
    const namesIn = (raw: unknown): string[] => {
        if (typeof raw === "string") { if (!raw.startsWith("=")) return []; try { return referencedNames(raw); } catch { return []; } }
        if (Array.isArray(raw)) return raw.flatMap(namesIn);
        if (raw && typeof raw === "object") return Object.values(raw as object).flatMap(namesIn);
        return [];
    };
    def.nodes.forEach((n, i) => {
        if (n.repeat === undefined || !shadowed.length) return;
        const used = new Set(Object.entries(n).filter(([k]) => k !== "repeat" && k !== "when").flatMap(([, v]) => namesIn(v)));
        for (const name of shadowed) if (used.has(name)) problems.push(`node ${nodeId(n, i)}: "${name}" here is the repeat's own ${name}, not the ${paramIds.has(name) ? "parameter" : "derived value"}`);
    });
    if (nodeIds.size !== def.nodes.length) problems.push("duplicate node ids");
    for (const p of def.params) {
        if (!groupIds.has(p.group)) problems.push(`param ${p.id}: unknown group "${p.group}"`);
        for (const k of ["min", "max", "visibleIf"] as const) { const v = p[k]; if (typeof v === "string") checkExpr(v, `param ${p.id}.${k}`); }
        if (p.type === "enum" && !(p.options ?? []).includes(String(p.default))) problems.push(`param ${p.id}: default not among options`);
        if (p.type === "material" && !materialChoices(p).includes(String(p.default))) problems.push(`param ${p.id}: default material not allowed`);
        if (p.optionLabels && p.optionLabels.length !== (p.options ?? []).length) problems.push(`param ${p.id}: optionLabels and options differ in length`);
    }
    for (const id of def.featured ?? []) if (!paramIds.has(id)) problems.push(`featured: no param "${id}"`);
    for (const [k, v] of Object.entries(def.derived ?? {})) if (typeof v === "string") checkExpr(v, `derived ${k}`);
    for (const r of def.rules ?? []) checkExpr(r.check, `rule "${r.message}"`);
    for (const [k, r] of Object.entries(def.regions)) {
        if (r.material.startsWith("=")) checkExpr(r.material, `region ${k}`);
        else if (!MATERIAL_BY_ID.has(r.material)) problems.push(`region ${k}: unknown material "${r.material}"`);
    }
    for (const preset of def.presets ?? []) for (const k of Object.keys(preset.values)) if (!paramIds.has(k)) problems.push(`preset ${preset.name}: no param "${k}"`);
    def.nodes.forEach((n, i) => {
        const id = nodeId(n, i);
        const where = `node ${id}`;
        if (n.type === "object") {
            const child = lookup(String(n.object));
            if (!child) { problems.push(`${where}: no object "${String(n.object)}"`); return; }
            const childParams = new Set(child.params.map(p => p.id));
            for (const [k, v] of Object.entries((n.params ?? {}) as Record<string, unknown>)) {
                if (!childParams.has(k)) problems.push(`${where}: ${child.id} has no param "${k}"`);
                walk(v, `${where}.params.${k}`);
            }
        } else {
            const comp = CATALOG.get(n.type);
            if (!comp) { problems.push(`${where}: unknown type "${n.type}"`); return; }
            const inputNames = new Set(comp.inputs.map(x => x.name));
            for (const k of Object.keys(n)) {
                if ((COMMON_NODE_FIELDS as readonly string[]).includes(k)) continue;
                if (!inputNames.has(k)) problems.push(`${where}: ${n.type} has no input "${k}"`);
            }
            for (const input of comp.inputs) {
                if (n[input.name] === undefined && input.default === undefined) problems.push(`${where}: missing input "${input.name}"`);
                walk(n[input.name], `${where}.${input.name}`);
            }
        }
        for (const k of ["when", "repeat", "keep", "at", "rotate", "scale", "rest", "region"]) walk(n[k], `${where}.${k}`);
    });
    return problems;
}
