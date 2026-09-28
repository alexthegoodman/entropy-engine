// The small, safe expression language inside Mesha's JSON object definitions. Any input written as
// a string starting with "=" is an expression: "=height - topThickness", "=hasArms ? 2 : 0",
// "=lerp(0.3, 0.6, rand(index))". There is no eval: expressions are parsed once into closures and
// can only read the names in scope (parameters, derived values, `index`/`count` inside a repeat)
// and call the math functions below.

import { hash01 } from "./mesha_noise";

export type Value = number | string | boolean | Value[];
export type Scope = (name: string) => Value | undefined;

type Node = (scope: Scope) => Value;

const FUNCTIONS: Record<string, (args: Value[], scope: Scope) => Value> = {
    min: a => Math.min(...a.map(num)),
    max: a => Math.max(...a.map(num)),
    clamp: ([x, lo, hi]) => Math.max(num(lo), Math.min(num(hi), num(x))),
    lerp: ([a, b, t]) => num(a) + (num(b) - num(a)) * num(t),
    /** Quadratic Bezier from a to c with control b, at t in 0..1: smooth profiles through a bulge. */
    bez: ([a, b, c, t]) => { const u = num(t), v = 1 - u; return v * v * num(a) + 2 * v * u * num(b) + u * u * num(c); },
    mix: ([a, b, t]) => num(a) + (num(b) - num(a)) * num(t),
    smoothstep: ([e0, e1, x]) => { const t = Math.max(0, Math.min(1, (num(x) - num(e0)) / (num(e1) - num(e0) || 1))); return t * t * (3 - 2 * t); },
    abs: ([x]) => Math.abs(num(x)),
    sign: ([x]) => Math.sign(num(x)),
    floor: ([x]) => Math.floor(num(x)),
    ceil: ([x]) => Math.ceil(num(x)),
    round: ([x]) => Math.round(num(x)),
    sqrt: ([x]) => Math.sqrt(Math.max(0, num(x))),
    pow: ([x, y]) => Math.pow(num(x), num(y)),
    sin: ([x]) => Math.sin(num(x)),
    cos: ([x]) => Math.cos(num(x)),
    tan: ([x]) => Math.tan(num(x)),
    atan2: ([y, x]) => Math.atan2(num(y), num(x)),
    hypot: a => Math.hypot(...a.map(num)),
    rad: ([x]) => (num(x) * Math.PI) / 180,
    deg: ([x]) => (num(x) * 180) / Math.PI,
    /** A stable random number in [0, 1) for this object's seed and the given keys. */
    rand: (a, scope) => hash01(num(scope("seed") ?? 0), num(a[0] ?? 0) * 7919 + 13, num(a[1] ?? 0) * 104729 + 7),
    /** rand scaled to [lo, hi). */
    randRange: ([key, lo, hi], scope) => num(lo) + (num(hi) - num(lo)) * hash01(num(scope("seed") ?? 0), num(key) * 7919 + 13, 31),
    /** The `index`th of the remaining arguments, clamped. */
    select: ([i, ...options]) => options[Math.max(0, Math.min(options.length - 1, Math.floor(num(i))))],
    len: ([a]) => (Array.isArray(a) ? a.length : String(a).length),
    vec: a => a.map(num),
};

const CONSTANTS: Record<string, Value> = { PI: Math.PI, TAU: Math.PI * 2, true: true, false: false };

export function num(v: Value | undefined): number {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : 0; }
    return 0;
}

export function truthy(v: Value | undefined): boolean {
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return !!v;
}

type Tok = { t: "num"; v: number } | { t: "str"; v: string } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
    const out: Tok[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) { i++; continue; }
        if (/[0-9.]/.test(c)) {
            const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
            if (!m) throw new Error(`Bad number at ${i} in "${src}"`);
            out.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
            out.push({ t: "id", v: m[0] }); i += m[0].length; continue;
        }
        if (c === "'" || c === '"') {
            const end = src.indexOf(c, i + 1);
            if (end < 0) throw new Error(`Unterminated string in "${src}"`);
            out.push({ t: "str", v: src.slice(i + 1, end) }); i = end + 1; continue;
        }
        const two = src.slice(i, i + 2);
        if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
        if ("+-*/%^()<>!?:,[]".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
        throw new Error(`Unexpected "${c}" in "${src}"`);
    }
    return out;
}

function parse(src: string): Node {
    const toks = tokenize(src);
    let pos = 0;
    const peek = () => toks[pos];
    const isOp = (v: string) => { const t = toks[pos]; return !!t && t.t === "op" && t.v === v; };
    const expect = (v: string) => { if (!isOp(v)) throw new Error(`Expected "${v}" in "${src}"`); pos++; };

    const expr = (): Node => {
        const cond = or();
        if (isOp("?")) {
            pos++;
            const a = expr(); expect(":"); const b = expr();
            return s => (truthy(cond(s)) ? a(s) : b(s));
        }
        return cond;
    };
    const or = (): Node => {
        let left = and();
        while (isOp("||")) { pos++; const l = left, r = and(); left = s => truthy(l(s)) || truthy(r(s)); }
        return left;
    };
    const and = (): Node => {
        let left = cmp();
        while (isOp("&&")) { pos++; const l = left, r = cmp(); left = s => truthy(l(s)) && truthy(r(s)); }
        return left;
    };
    const cmp = (): Node => {
        const left = sum();
        const t = peek();
        if (t && t.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
            pos++;
            const right = sum();
            const eq = (a: Value, b: Value) => (typeof a === "string" || typeof b === "string" ? String(a) === String(b) : num(a) === num(b));
            switch (t.v) {
                case "==": return s => eq(left(s), right(s));
                case "!=": return s => !eq(left(s), right(s));
                case "<": return s => num(left(s)) < num(right(s));
                case "<=": return s => num(left(s)) <= num(right(s));
                case ">": return s => num(left(s)) > num(right(s));
                default: return s => num(left(s)) >= num(right(s));
            }
        }
        return left;
    };
    const sum = (): Node => {
        let left = prod();
        while (isOp("+") || isOp("-")) {
            const op = (toks[pos++] as { v: string }).v, l = left, r = prod();
            left = op === "+" ? s => num(l(s)) + num(r(s)) : s => num(l(s)) - num(r(s));
        }
        return left;
    };
    const prod = (): Node => {
        let left = unary();
        while (isOp("*") || isOp("/") || isOp("%")) {
            const op = (toks[pos++] as { v: string }).v, l = left, r = unary();
            left = op === "*" ? s => num(l(s)) * num(r(s)) : op === "/" ? s => num(l(s)) / num(r(s)) : s => { const b = num(r(s)); return ((num(l(s)) % b) + b) % b; };
        }
        return left;
    };
    const unary = (): Node => {
        if (isOp("-")) { pos++; const u = unary(); return s => -num(u(s)); }
        if (isOp("+")) { pos++; return unary(); }
        if (isOp("!")) { pos++; const u = unary(); return s => !truthy(u(s)); }
        return power();
    };
    const power = (): Node => {
        const base = postfix();
        if (isOp("^")) { pos++; const e = unary(); return s => Math.pow(num(base(s)), num(e(s))); }
        return base;
    };
    const postfix = (): Node => {
        let node = primary();
        while (isOp("[")) {
            pos++;
            const idx = expr(); expect("]");
            const n = node;
            node = s => { const a = n(s); if (!Array.isArray(a) || !a.length) return 0; return a[Math.max(0, Math.min(a.length - 1, Math.floor(num(idx(s)))))]; };
        }
        return node;
    };
    const primary = (): Node => {
        const t = toks[pos++];
        if (!t) throw new Error(`Unexpected end of "${src}"`);
        if (t.t === "num") { const v = t.v; return () => v; }
        if (t.t === "str") { const v = t.v; return () => v; }
        if (t.t === "op" && t.v === "(") { const e = expr(); expect(")"); return e; }
        if (t.t === "op" && t.v === "[") {
            const items: Node[] = [];
            if (!isOp("]")) { do { items.push(expr()); } while (isOp(",") && ++pos); }
            expect("]");
            return s => items.map(i => i(s));
        }
        if (t.t === "id") {
            const name = t.v;
            if (isOp("(")) {
                pos++;
                const args: Node[] = [];
                if (!isOp(")")) { do { args.push(expr()); } while (isOp(",") && ++pos); }
                expect(")");
                // Own properties only: never Object.prototype's constructor, toString and friends.
                const f = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
                if (!f) throw new Error(`Unknown function "${name}" in "${src}"`);
                return s => f(args.map(a => a(s)), s);
            }
            if (Object.hasOwn(CONSTANTS, name)) { const v = CONSTANTS[name]; return () => v; }
            return s => {
                const v = s(name);
                if (v === undefined) throw new Error(`Unknown name "${name}" in "${src}"`);
                return v;
            };
        }
        throw new Error(`Unexpected "${t.v}" in "${src}"`);
    };
    const root = expr();
    if (pos !== toks.length) throw new Error(`Unexpected "${(toks[pos] as { v: unknown }).v}" in "${src}"`);
    return root;
}

const compiled = new Map<string, Node>();

/** Parses (once, cached) and evaluates an expression - with or without its leading "=". */
export function evaluate(src: string, scope: Scope): Value {
    const body = src.startsWith("=") ? src.slice(1) : src;
    let node = compiled.get(body);
    if (!node) { node = parse(body); compiled.set(body, node); }
    return node(scope);
}

/** Throws with a readable message if `src` doesn't parse; used by the definition validator. */
export function checkSyntax(src: string): void {
    parse(src.startsWith("=") ? src.slice(1) : src);
}

/** Every bare name an expression reads (not functions or constants): for dependency checks. */
export function referencedNames(src: string): string[] {
    const toks = tokenize(src.startsWith("=") ? src.slice(1) : src);
    const names = new Set<string>();
    toks.forEach((t, i) => {
        if (t.t !== "id" || Object.hasOwn(CONSTANTS, t.v)) return;
        const next = toks[i + 1];
        if (next && next.t === "op" && next.v === "(") return;
        names.add(t.v);
    });
    return [...names];
}

export const EXPRESSION_FUNCTIONS = Object.keys(FUNCTIONS);
