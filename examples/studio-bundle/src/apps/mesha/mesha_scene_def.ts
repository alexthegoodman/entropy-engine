// A procedural Mesha scene: plain JSON like an object definition, with parameters, groups, rules,
// presets and Variation, but instead of building geometry it *places library objects*. Each
// placement names an object, its parameter values ("=expressions" of the scene's parameters) and a
// transform, optionally repeated (`repeat`, with `index`, `count` and `t` in scope) and thinned
// (`keep`). Evaluating a scene gives ordinary scene instances: every wreck, wall and the dome stays
// a live, editable procedural object, and regenerating the scene with new settings keeps any
// changes the user made to one of them.

import { type ParamSpace, type ParamValues, type ParamValue, type ObjectLookup, type PresetDef, resolveParams, paramScope, ruleViolations, validateDefinition, MeshaError } from "./mesha_object";
import { evaluate, num, truthy, checkSyntax, referencedNames, type Scope, type Value } from "./mesha_expr";
import type { Vec3 } from "./mesha_mesh";
import type { Instance } from "./mesha_scene";

export interface PlacementDef {
    id: string;
    /** Library object id. */
    object: string;
    /** Instance name; repeated copies are numbered. Defaults to the object's name. */
    label?: string;
    when?: string;
    repeat?: number | string;
    keep?: string;
    /** Start from one of the object's presets, then apply `params`. */
    preset?: string;
    /** Literal values or "=expressions" of the scene's parameters (and index/count/t). */
    params?: Record<string, ParamValue>;
    /** [x, y, z] in metres. */
    at: [number | string, number | string, number | string];
    /** Degrees about +Y. */
    turn?: number | string;
    scale?: number | string;
}

export interface SceneDef extends ParamSpace {
    name: string;
    description?: string;
    tags?: string[];
    featured?: string[];
    presets?: PresetDef[];
    /** Studio lighting the scene looks best under (a STUDIO_PRESETS id), or an "=expression". */
    lighting?: string;
    placements: PlacementDef[];
}

/** One placed object: what becomes an editable instance. `key` is stable across regenerations. */
export interface ScenePlacement {
    key: string;
    objectId: string;
    name: string;
    values: ParamValues;
    position: Vec3;
    rotationY: number;
    scale: number;
}

export interface SceneEvaluation {
    params: ParamValues;
    placements: ScenePlacement[];
    lighting?: string;
    violations: string[];
}

const withLocals = (scope: Scope, locals: Record<string, Value>): Scope => name => (name in locals ? locals[name] : scope(name));

function value(raw: unknown, scope: Scope, where: string): Value {
    if (typeof raw === "string" && raw.startsWith("=")) {
        try { return evaluate(raw, scope); } catch (e) { throw new MeshaError(`${where}: ${(e as Error).message}`); }
    }
    return raw as Value;
}

/** Places every object of `def` for `values` (missing ones take defaults; everything is clamped). */
export function evaluateScene(def: SceneDef, values: ParamValues, lookup: ObjectLookup): SceneEvaluation {
    const params = resolveParams(def, values);
    const root = paramScope(def, params);
    const placements: ScenePlacement[] = [];
    for (const p of def.placements) {
        const where = `${def.id}:${p.id}`;
        if (p.when !== undefined && !truthy(value(p.when, root, `${where}.when`))) continue;
        const object = lookup(p.object);
        if (!object) throw new MeshaError(`${where}: no object "${p.object}"`);
        const repeated = p.repeat !== undefined;
        const count = repeated ? Math.max(0, Math.min(400, Math.floor(num(value(p.repeat, root, `${where}.repeat`))))) : 1;
        const preset = p.preset ? object.presets?.find(x => x.name === p.preset) : undefined;
        if (p.preset && !preset) throw new MeshaError(`${where}: ${p.object} has no preset "${p.preset}"`);
        for (let index = 0; index < count; index++) {
            const scope = withLocals(root, { index, count, t: count > 1 ? index / (count - 1) : 0 });
            if (p.keep !== undefined && !truthy(value(p.keep, scope, `${where}.keep`))) continue;
            const given: ParamValues = { ...(preset?.values ?? {}) };
            for (const [k, raw] of Object.entries(p.params ?? {})) given[k] = value(raw, scope, `${where}.params.${k}`) as ParamValue;
            // Copies differ in their details unless the scene says otherwise.
            if (given.seed === undefined && object.params.some(x => x.id === "seed")) given.seed = (num(params.seed ?? 0) * 31 + index * 7 + hashId(p.id)) % 99999;
            const at = p.at.map((c, i) => num(value(c, scope, `${where}.at[${i}]`))) as Vec3;
            placements.push({
                key: repeated ? `${p.id}:${index}` : p.id,
                objectId: p.object,
                name: `${p.label ?? object.name}${repeated && count > 1 ? ` ${index + 1}` : ""}`,
                values: resolveParams(object, given),
                position: [at[0], Math.max(0, at[1]), at[2]],
                rotationY: p.turn === undefined ? 0 : num(value(p.turn, scope, `${where}.turn`)),
                scale: p.scale === undefined ? 1 : Math.max(0.01, num(value(p.scale, scope, `${where}.scale`))),
            });
        }
    }
    let lighting = def.lighting;
    if (lighting?.startsWith("=")) lighting = String(value(lighting, root, `${def.id}.lighting`));
    return { params, placements, lighting, violations: ruleViolations(def, params) };
}

function hashId(id: string): number {
    let h = 7;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 9973;
    return h;
}

/** Static problems: bad expressions, unknown objects, parameters or presets. */
export function validateScene(def: SceneDef, lookup: ObjectLookup): string[] {
    // The parameter half is checked the way an object's is (an ObjectDef with no geometry).
    const problems = validateDefinition({ ...def, category: "Scenes", regions: {}, nodes: [] }, lookup);
    const known = new Set([...def.params.map(p => p.id), ...Object.keys(def.derived ?? {}), "index", "count", "t", "seed"]);
    const check = (raw: unknown, where: string) => {
        if (typeof raw !== "string" || !raw.startsWith("=")) return;
        try { checkSyntax(raw); } catch (e) { problems.push(`${where}: ${(e as Error).message}`); return; }
        for (const name of referencedNames(raw)) if (!known.has(name)) problems.push(`${where}: unknown name "${name}"`);
    };
    const ids = new Set<string>();
    for (const p of def.placements) {
        const where = `placement ${p.id}`;
        if (ids.has(p.id)) problems.push(`${where}: duplicate id`);
        ids.add(p.id);
        const object = lookup(p.object);
        if (!object) { problems.push(`${where}: no object "${p.object}"`); continue; }
        if (object.component) problems.push(`${where}: ${p.object} is a component, not a placeable object`);
        if (p.preset && !object.presets?.some(x => x.name === p.preset)) problems.push(`${where}: ${p.object} has no preset "${p.preset}"`);
        for (const [k, raw] of Object.entries(p.params ?? {})) {
            if (!object.params.some(x => x.id === k)) problems.push(`${where}: ${p.object} has no param "${k}"`);
            check(raw, `${where}.params.${k}`);
        }
        if (!Array.isArray(p.at) || p.at.length !== 3) problems.push(`${where}: at needs [x, y, z]`);
        else p.at.forEach((c, i) => check(c, `${where}.at[${i}]`));
        for (const k of ["when", "repeat", "keep", "turn", "scale"] as const) check(p[k], `${where}.${k}`);
    }
    if (def.lighting) check(def.lighting, "lighting");
    return problems;
}

export interface SceneMerge {
    instances: Instance[];
    /** Instances whose geometry or placement changed (or that are new). */
    changed: string[];
    /** Instances the scene no longer places. */
    removed: string[];
}

/**
 * Applies a scene's placements to the current instances. The scene's own instances update in place
 * by placement key, keeping parameters the user changed (`source.overrides`) and, once the user has
 * moved one (`source.placed`), its transform; new placements are added with `newId()`, vanished
 * ones removed. Instances the scene didn't place are left alone.
 */
export function mergeScene(current: Instance[], sceneId: string, placements: ScenePlacement[], lookup: ObjectLookup, newId: () => string): SceneMerge {
    const byKey = new Map(current.filter(i => i.source?.scene === sceneId).map(i => [i.source!.key, i]));
    const changed: string[] = [];
    const kept = new Set<string>();
    const placed: Instance[] = [];
    for (const p of placements) {
        const def = lookup(p.objectId)!;
        let inst = byKey.get(p.key);
        if (inst && inst.objectId !== p.objectId) inst = undefined;
        if (inst) {
            const old = inst;
            const overrides = old.source?.overrides ?? [];
            const values = resolveParams(def, { ...p.values, ...Object.fromEntries(overrides.filter(k => k in old.values).map(k => [k, old.values[k]])) });
            const next: Instance = { ...old, values, source: { ...old.source!, key: p.key } };
            if (!old.source?.placed) Object.assign(next, { position: p.position, rotationY: p.rotationY, rotation: undefined, scale: p.scale });
            const moved = next.position.some((c, k) => Math.abs(c - old.position[k]) > 1e-9) || next.rotationY !== old.rotationY || next.scale !== old.scale || next.rotation !== old.rotation;
            if (moved || JSON.stringify(values) !== JSON.stringify(old.values)) changed.push(old.id);
            inst = next;
        } else {
            inst = { id: newId(), objectId: p.objectId, values: p.values, position: p.position, rotationY: p.rotationY, scale: p.scale, name: p.name, source: { scene: sceneId, key: p.key } };
            changed.push(inst.id);
        }
        kept.add(inst.id);
        placed.push(inst);
    }
    const removed = current.filter(i => i.source?.scene === sceneId && !kept.has(i.id)).map(i => i.id);
    const replaced = new Map(placed.map(i => [i.id, i]));
    const others = current.filter(i => i.source?.scene !== sceneId);
    // Keep the scene's own instances in placement order, after the user's.
    return { instances: [...others.map(i => replaced.get(i.id) ?? i), ...placed.filter(i => !others.some(o => o.id === i.id))], changed, removed };
}
