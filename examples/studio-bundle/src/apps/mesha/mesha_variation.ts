// Variation: "give me another sensible one". Instead of randomizing every number, it moves each
// unlocked, visible parameter by an amount scaled to that parameter's own range and weight, keeps
// dynamic ranges, and retries until the object's rules hold - so a bolt never becomes 14 m long
// and a chair never loses contact with its legs.

import { type ObjectDef, type ParamDef, type ParamValues, resolveParams, ruleViolations, isParamVisible, paramRange, materialChoices } from "./mesha_object";
import { rng, gaussian } from "./mesha_noise";
import { evaluate, type Scope } from "./mesha_expr";

export interface VariationOptions {
    /** 0 = tiny nudges, 1 = anything the ranges and rules allow. */
    amount: number;
    /** Locked parameter ids, and/or "group:<id>" to lock a whole group. */
    locked?: Iterable<string>;
    seed: number;
    /** Attempts before settling for the configuration with the fewest rule violations. */
    attempts?: number;
}

export interface VariationResult {
    values: ParamValues;
    attempts: number;
    violations: string[];
    changed: string[];
}

export function isLocked(p: ParamDef, locked: Set<string>): boolean {
    return locked.has(p.id) || locked.has(`group:${p.group}`);
}

function choices(p: ParamDef): string[] | null {
    if (p.type === "enum") return p.options ?? [];
    if (p.type === "material") return materialChoices(p);
    return null;
}

function valueScope(values: ParamValues): Scope {
    return name => values[name];
}

function varyOnce(def: ObjectDef, base: ParamValues, amount: number, locked: Set<string>, random: () => number): ParamValues {
    const next: ParamValues = { ...base };
    const a = Math.max(0, Math.min(1, amount));
    for (const p of def.params) {
        const weight = p.variation ?? 1;
        if (weight <= 0 || isLocked(p, locked)) continue;
        if (!isParamVisible(def, p, next)) continue;
        const strength = Math.min(1, a * weight);
        const options = choices(p);
        if (options) {
            if (options.length > 1 && random() < strength * 0.75) {
                const others = options.filter(o => o !== next[p.id]);
                next[p.id] = others[Math.floor(random() * others.length)];
            }
            continue;
        }
        if (p.type === "bool") {
            if (random() < strength * 0.45) next[p.id] = !next[p.id];
            continue;
        }
        if (p.type === "seed") {
            next[p.id] = Math.floor(random() * 99999);
            continue;
        }
        let lo: number, hi: number;
        try { [lo, hi] = paramRange(p, valueScope(next)); } catch { continue; }
        const span = hi - lo;
        if (!(span > 0)) continue;
        const current = Number(next[p.id]);
        const nudged = current + gaussian(random) * strength * span * 0.35;
        // Large amounts blend toward a uniform pick across the whole range.
        const uniform = lo + random() * span;
        const blend = Math.max(0, Math.min(1, (a - 0.55) / 0.45)) * weight;
        let v = nudged * (1 - blend) + uniform * blend;
        v = Math.max(lo, Math.min(hi, v));
        if (p.type === "int") v = Math.round(v);
        else if (p.step) v = Math.round(v / p.step) * p.step;
        next[p.id] = v;
    }
    return resolveParams(def, next);
}

/** A new configuration near `current` (see VariationOptions). Deterministic for a given seed. */
export function vary(def: ObjectDef, current: ParamValues, options: VariationOptions): VariationResult {
    const locked = new Set(options.locked ?? []);
    const random = rng(options.seed);
    const base = resolveParams(def, current);
    const attempts = Math.max(1, options.attempts ?? 40);
    let best: ParamValues = base, bestViolations = ruleViolations(def, base), used = 0;
    for (let i = 0; i < attempts; i++) {
        used = i + 1;
        // Later attempts back off toward smaller changes, which usually clears a violated rule.
        const amount = options.amount * (1 - (i / attempts) * 0.6);
        const candidate = varyOnce(def, base, amount, locked, random);
        const violations = ruleViolations(def, candidate);
        if (violations.length < bestViolations.length || i === 0) { best = candidate; bestViolations = violations; }
        if (!violations.length) break;
    }
    const changed = def.params.filter(p => best[p.id] !== base[p.id]).map(p => p.id);
    return { values: best, attempts: used, violations: bestViolations, changed };
}

/** Evaluates a dynamic bound for display ("max 1.2 m" given the current width). */
export function boundFor(p: ParamDef, which: "min" | "max", values: ParamValues): number | undefined {
    const b = p[which];
    if (b === undefined) return undefined;
    return typeof b === "number" ? b : Number(evaluate(b, valueScope(values)));
}
