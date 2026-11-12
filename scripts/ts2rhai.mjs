#!/usr/bin/env node
// ts2rhai: translates an Entropy TypeScript game into one Rhai script for the portable runtime
// (src/script), so the same game runs in a browser without running any JavaScript: the
// TypeScript stays the source of truth, and the Rhai is generated from it.
//
//   node scripts/ts2rhai.mjs <config.json>
//
// The config names the entry file, the tsconfig, the output, and what NOT to translate: modules
// and declarations that a hand-written Rhai prelude or the engine's native helpers provide
// instead (vector math, the instanced renderer, mesh builders - the inner loops of a frame,
// which are far faster in Rust than interpreted).
//
// How TypeScript maps onto Rhai (and src/script/jsrt.rs, which supplies the JavaScript parts):
// - Objects and arrays become `Obj` and `List`, reference types, so aliasing works as in JS.
// - Every number is a FLOAT (JavaScript has one number type).
// - Classes become functions: `new C(a)` is `C__new(a)`, `x.m(a)` is `x.C__m(a)` (the type
//   checker says which class), getters are `C__get_name()`.
// - Module-level state lives in one shared object, `G::__V`, filled by `__module_init()`, since
//   Rhai functions cannot see top-level variables.
// - Calls always pass every parameter (missing ones as `()`); defaults are applied in the body.
// - Conditions go through `truthy`, `===` on objects through `js_eq`, `+` on strings through
//   `js_str`, and so on - the type checker decides where that is needed.
//
// Anything it does not understand is an error naming the file and line: the subset grows with
// the games that need it.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const configPath = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !fs.existsSync(configPath)) {
    console.error("usage: node scripts/ts2rhai.mjs <config.json>");
    process.exit(2);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
/** `--profile`: every function times its calls (prof_begin/prof_end; prof_report() prints them). */
const PROFILE = process.argv.includes("--profile");
if (PROFILE) config.out = config.out.replace(/\.rhai$/, ".profile.rhai");
const base = path.dirname(configPath);
const rel = p => path.resolve(base, p);
const require = createRequire(rel(config.typescriptFrom ?? "."));
const ts = require("typescript");

const tsconfig = ts.getParsedCommandLineOfConfigFile(rel(config.tsconfig), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } });
const program = ts.createProgram([rel(config.entry), ...(config.extraRoots ?? []).map(rel)], { ...tsconfig.options, noEmit: true });
const checker = program.getTypeChecker();

const skipModules = new Set((config.skipModules ?? []).map(p => path.resolve(rel(p))));
/** module path -> names its declarations provide natively or in the prelude (not translated). */
const provided = new Map(Object.entries(config.provided ?? {}).map(([k, v]) => [path.resolve(rel(k)), new Set(v)]));

// --- Module order: dependencies first ---------------------------------------------------------------

const order = [];
const seen = new Set();
function visitModule(sf) {
    if (seen.has(sf.fileName)) return;
    seen.add(sf.fileName);
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly) {
            const sym = checker.getSymbolAtLocation(st.moduleSpecifier);
            const dep = sym?.valueDeclaration ?? sym?.declarations?.[0];
            if (dep && ts.isSourceFile(dep) && !dep.isDeclarationFile) visitModule(dep);
        }
    }
    order.push(sf);
}
visitModule(program.getSourceFile(rel(config.entry)));

// --- Names -------------------------------------------------------------------------------------------

const RESERVED = new Set(("fn let const if else switch do while loop until for in continue break return throw try catch import export as global " +
    "private this is_shared Fn call curry print debug type_of eval is_def_var is_def_fn var static shared sync with module package super thread spawn go " +
    "await async default void null public protected new use match case goto exit true false nil yield is of").split(" "));
const safe = n => (RESERVED.has(n) || n === "_" || /^_+$/.test(n) ? `${n}_v` : n.replace(/\$/g, "_S"));

/** Declaration node -> { kind: "fn" | "global" | "class" | "inline", name, value? } */
const declInfo = new Map();
const topNames = new Map(); // name -> count across modules
const modName = sf => path.basename(sf.fileName).replace(/\.ts$/, "").replace(/[^A-Za-z0-9_]/g, "_");

function isFnInit(init) { return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)); }
function literalValue(init) {
    if (!init) return null;
    let e = init;
    while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression?.(e)) e = e.expression;
    if (ts.isNumericLiteral(e)) return num(Number(e.text));
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return num(-Number(e.operand.text));
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return str(e.text);
    return null;
}

/** `const KIND = { a: 0, b: 1 } as const`: members that are all literals, inlined where read. */
const enumConsts = new Map();
function enumMembers(init) {
    let e = init;
    while (e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e)))) e = e.expression;
    if (!e || !ts.isObjectLiteralExpression(e)) return null;
    const out = new Map();
    for (const p of e.properties) {
        if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return null;
        const v = literalValue(p.initializer);
        if (v === null) return null;
        out.set(p.name.text, v);
    }
    return out;
}

for (const sf of order) {
    if (skipModules.has(path.resolve(sf.fileName))) continue;
    for (const st of sf.statements) {
        const names = [];
        if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text);
        if (ts.isClassDeclaration(st) && st.name) names.push(st.name.text);
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
        for (const n of names) topNames.set(n, (topNames.get(n) ?? 0) + 1);
    }
}
for (const sf of order) {
    const skip = skipModules.has(path.resolve(sf.fileName));
    const prov = provided.get(path.resolve(sf.fileName)) ?? new Set();
    const m = modName(sf);
    const nameFor = n => (topNames.get(n) > 1 ? `${m}__${n}` : n);
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name) declInfo.set(st, { kind: "fn", name: skip || prov.has(st.name.text) ? st.name.text : nameFor(st.name.text), provided: skip || prov.has(st.name.text) });
        if (ts.isClassDeclaration(st) && st.name) declInfo.set(st, { kind: "class", name: st.name.text, provided: skip || prov.has(st.name.text) });
        if (ts.isVariableStatement(st)) {
            const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
            for (const d of st.declarationList.declarations) {
                if (!ts.isIdentifier(d.name)) continue;
                const n = d.name.text;
                const p = skip || prov.has(n);
                const lit = isConst ? literalValue(d.initializer) : null;
                const members = isConst && !p ? enumMembers(d.initializer) : null;
                if (members) enumConsts.set(d, members);
                if (isConst && isFnInit(d.initializer)) declInfo.set(d, { kind: "fn", name: p ? n : nameFor(n), provided: p, node: d.initializer });
                else if (lit !== null && !p) declInfo.set(d, { kind: "inline", name: n, value: lit });
                else declInfo.set(d, { kind: "global", name: p ? n : nameFor(n), provided: p });
            }
        }
    }
}

// --- Output helpers ------------------------------------------------------------------------------------

function num(v) {
    if (Number.isNaN(v)) return "js_nan()";
    if (!Number.isFinite(v)) return v > 0 ? "js_inf()" : "(-js_inf())";
    let s = String(v);
    if (/e/i.test(s)) {
        let [m, e] = s.split(/e/i);
        if (!m.includes(".")) m += ".0";
        s = `${m}e${e}`;
    } else if (!s.includes(".")) s += ".0";
    return v < 0 ? `(${s})` : s;
}
function str(s) {
    let out = '"';
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (ch === '"') out += '\\"';
        else if (ch === "\\") out += "\\\\";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (c < 0x20) out += `\\x${c.toString(16).padStart(2, "0")}`;
        else out += ch;
    }
    return out + '"';
}

class TranspileError extends Error {}
function fail(node, msg) {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    throw new TranspileError(`${path.relative(process.cwd(), sf.fileName)}:${line + 1}: ${msg}\n    ${node.getText().slice(0, 160)}`);
}

let tmpSerial = 0;
const tmp = p => `__${p}${++tmpSerial}`;

// --- Types -------------------------------------------------------------------------------------------

const typeOf = n => checker.getTypeAtLocation(n);
function flags(t) { return t.flags; }
function everyPart(t, pred) { return t.isUnion() ? t.types.every(x => everyPart(x, pred)) : pred(t); }
function isNum(n) { return everyPart(typeOf(n), t => (flags(t) & (ts.TypeFlags.NumberLike)) !== 0); }
function isStr(n) { return everyPart(typeOf(n), t => (flags(t) & ts.TypeFlags.StringLike) !== 0); }
function isBool(n) { return everyPart(typeOf(n), t => (flags(t) & ts.TypeFlags.BooleanLike) !== 0); }
function maybeStr(n) { const t = typeOf(n); const parts = t.isUnion() ? t.types : [t]; return parts.some(x => (flags(x) & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0); }
function isPrimitive(n) { return everyPart(typeOf(n), t => (flags(t) & (ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike | ts.TypeFlags.BooleanLike)) !== 0); }
function typeName(t) {
    const s = t.getSymbol?.() ?? t.symbol;
    return s?.getName?.() ?? "";
}
function nonNull(t) { return checker.getNonNullableType(t); }
function kindOfType(n) {
    const t = nonNull(typeOf(n));
    if (checker.isArrayType(t) || checker.isTupleType(t)) return "array";
    const parts = t.isUnion() ? t.types : [t];
    if (parts.every(p => checker.isArrayType(p) || checker.isTupleType(p))) return "array";
    if (parts.every(p => (flags(p) & ts.TypeFlags.StringLike) !== 0)) return "string";
    if (parts.every(p => (flags(p) & ts.TypeFlags.NumberLike) !== 0)) return "number";
    const name = typeName(t);
    if (["Map", "ReadonlyMap"].includes(name)) return "map";
    if (["Set", "ReadonlySet"].includes(name)) return "set";
    if (name === "Float32Array" || name === "Uint32Array" || name === "Float64Array") return "floats";
    if (name === "RegExp") return "regexp";
    return "object";
}
/** The class a value is an instance of (one we translate or one provided), or null. */
function classOf(n) {
    const t = nonNull(typeOf(n));
    const s = t.getSymbol?.();
    const d = s?.declarations?.[0];
    if (d && ts.isClassDeclaration(d) && declInfo.has(d)) return d.name.text;
    return null;
}

// --- Symbols -----------------------------------------------------------------------------------------

function resolve(sym) {
    if (sym && sym.flags & ts.SymbolFlags.Alias) return checker.getAliasedSymbol(sym);
    return sym;
}
function declOf(node) {
    const sym = resolve(checker.getSymbolAtLocation(node));
    if (!sym) return null;
    return sym.valueDeclaration ?? sym.declarations?.[0] ?? null;
}
function propDecl(node /* PropertyAccessExpression */) {
    const sym = checker.getSymbolAtLocation(node.name);
    return sym?.valueDeclaration ?? sym?.declarations?.[0] ?? null;
}
function isLibDecl(d) { return d && d.getSourceFile().isDeclarationFile; }
function paramCount(fnNode) { return fnNode?.parameters?.length ?? 0; }
function fnNodeOfDecl(d) {
    if (!d) return null;
    if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isArrowFunction(d) || ts.isFunctionExpression(d) || ts.isMethodSignature(d) || ts.isConstructorDeclaration(d)) return d;
    if (ts.isVariableDeclaration(d) && isFnInit(d.initializer)) return d.initializer;
    if ((ts.isPropertySignature(d) || ts.isPropertyDeclaration(d) || ts.isParameter(d)) && d.type && ts.isFunctionTypeNode(d.type)) return d.type;
    if (ts.isPropertyAssignment(d) && isFnInit(d.initializer)) return d.initializer;
    return null;
}

// --- Lambda lifting ---------------------------------------------------------------------------------
//
// `const f = (x) => ...` inside a function, used only as `f(...)`, becomes a top-level function
// with what it captures as extra parameters. A Rhai closure would make every variable it captures
// a shared, locked value (slowing the whole enclosing function) and pass them all on every call.
// Not lifted: closures passed as values, and closures that assign to a variable they capture.

/** VariableDeclaration -> { name, captures: [decl...], node } */
const lifted = new Map();
let liftSerial = 0;
const liftedOut = [];

function isLocalDecl(d, fnNode) {
    // A parameter or variable declared inside fnNode (not module level).
    for (let p = d?.parent; p; p = p.parent) { if (p === fnNode) return true; if (ts.isSourceFile(p)) return false; }
    return false;
}

function analyzeLifts(fnNode, fnName) {
    const candidates = [];
    const visit = n => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isArrowFunction(n.initializer) && (n.parent.flags & ts.NodeFlags.Const)) candidates.push(n);
        ts.forEachChild(n, visit);
    };
    ts.forEachChild(fnNode, visit);
    if (!candidates.length) return;
    const ok = new Map();
    for (const c of candidates) {
        const sym = checker.getSymbolAtLocation(c.name);
        // Every use is a direct call.
        let direct = true;
        const uses = n => {
            if (ts.isIdentifier(n) && n !== c.name && checker.getSymbolAtLocation(n) === sym) {
                if (!(ts.isCallExpression(n.parent) && n.parent.expression === n)) direct = false;
            }
            ts.forEachChild(n, uses);
        };
        uses(fnNode);
        if (!direct) continue;
        // What it captures, and that it assigns none of it.
        const arrow = c.initializer;
        const caps = new Set();
        let pure = true, usesThis = false;
        const scan = n => {
            if (n.kind === ts.SyntaxKind.ThisKeyword) usesThis = true;
            if (ts.isIdentifier(n)) {
                const d = declOf(n);
                if (d && isLocalDecl(d, fnNode) && !isLocalDecl(d, arrow) && d !== c) {
                    if (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d)) caps.add(d);
                }
            }
            if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(unwrap(n.left))) {
                const d = declOf(unwrap(n.left));
                if (d && !isLocalDecl(d, arrow)) pure = false;
            }
            if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && ts.isIdentifier(unwrap(n.operand))) {
                const d = declOf(unwrap(n.operand));
                if (d && !isLocalDecl(d, arrow)) pure = false;
            }
            if (ts.isShorthandPropertyAssignment(n)) {
                const sy = resolve(checker.getShorthandAssignmentValueSymbol(n));
                const d = sy?.valueDeclaration ?? sy?.declarations?.[0];
                if (d && isLocalDecl(d, fnNode) && !isLocalDecl(d, arrow) && d !== c) caps.add(d);
            }
            ts.forEachChild(n, scan);
        };
        scan(arrow.body);
        arrow.parameters.forEach(p => p.initializer && scan(p.initializer));
        if (!pure) continue;
        ok.set(c, { caps, usesThis });
    }
    // A lifted closure calling another needs that one's captures too.
    let changed = true;
    while (changed) {
        changed = false;
        for (const [c, info] of ok) {
            for (const other of [...info.caps]) {
                const o = ok.get(other);
                if (!o) continue;
                info.caps.delete(other);
                for (const x of o.caps) if (x !== c && !info.caps.has(x)) { info.caps.add(x); changed = true; }
                if (o.usesThis && !info.usesThis) { info.usesThis = true; changed = true; }
            }
        }
    }
    for (const [c, info] of ok) {
        const caps = [...info.caps].filter(d => !ok.has(d));
        lifted.set(c, { name: `${fnName}__${c.name.text}${++liftSerial}`, caps, usesThis: info.usesThis, node: c.initializer });
    }
}

function capName(d) {
    if (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d)) return safe(d.name.text);
    fail(d, "capture");
}

/** Emits the lifted functions of a function body (after its analysis). */
function emitLifted(fnNode) {
    for (const [decl, info] of lifted) {
        if (info.emitted || !isLocalDecl(decl, fnNode)) continue;
        info.emitted = true;
        const saved = { ...ctx };
        const arrow = info.node;
        const extra = info.caps.map(capName);
        if (info.usesThis) extra.push("__self");
        ctx.arrowDepth = 1; ctx.usesSelf = false; ctx.inFn = true;
        const pnames = [], pre = [];
        arrow.parameters.forEach((p, i) => {
            if (ts.isIdentifier(p.name)) pnames.push(safe(p.name.text));
            else { const t = `__p${i}`; pnames.push(t); pre.push(destructure(p.name, t)); }
            if (p.initializer) pre.push(`let ${pnames[i]} = if js_is_nullish(${pnames[i]}) { ${expr(p.initializer)} } else { ${pnames[i]} };`);
        });
        const body = ts.isBlock(arrow.body) ? block(arrow.body.statements, pre) : `{\n${pre.join("\n")}\n${expr(arrow.body)}\n}`;
        Object.assign(ctx, saved);
        liftedOut.push(`fn ${info.name}(${[...pnames, ...extra].join(", ")}) ${body}\n`);
    }
}

// --- Emission context ----------------------------------------------------------------------------------

const ctx = { cls: null, arrowDepth: 0, usesSelf: false, inFn: false };
function thisRef() {
    if (ctx.arrowDepth > 0) { ctx.usesSelf = true; return "__self"; }
    return "this";
}
const G = n => `G::__V.${n}`;

/** The arguments of a call, one per parameter of `fnNode` (missing ones as `()`). A spread of a
 *  fixed-length tuple (`f(...v)` with `v: [number, number, number]`) becomes its elements. */
function args(callNode, fnNode, extraLeading = []) {
    const out = [...extraLeading];
    const given = [];
    for (const a of callNode.arguments ?? []) {
        if (!ts.isSpreadElement(a)) { given.push(expr(a)); continue; }
        const t = nonNull(typeOf(a.expression));
        if (!checker.isTupleType(t)) fail(a, "spread arguments are only supported for tuples, Math.max/min/hypot and push");
        const n = t.target?.fixedLength ?? checker.getTypeArguments(t).length;
        const inner = unwrap(a.expression);
        if (!(ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner))) fail(a, "spread of a tuple that is not a plain name or property");
        const src = expr(a.expression);
        for (let i = 0; i < n; i++) given.push(`${src}[${num(i)}]`);
    }
    const n = fnNode ? paramCount(fnNode) : given.length;
    for (let i = 0; i < n; i++) out.push(i < given.length ? given[i] : "()");
    return out.join(", ");
}

// --- Expressions -------------------------------------------------------------------------------------

function cond(n) {
    n = unwrap(n);
    if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken) return `(${cond(n.left)} && ${cond(n.right)})`;
        if (op === ts.SyntaxKind.BarBarToken) return `(${cond(n.left)} || ${cond(n.right)})`;
    }
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) return `!${cond(n.operand)}`;
    if (isBool(n)) return expr(n);
    return `truthy(${expr(n)})`;
}

function unwrap(n) {
    while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression?.(n) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n))) n = n.expression;
    return n;
}

function identifier(n) {
    const t = n.text;
    if (t === "undefined") return "()";
    if (t === "Boolean") return 'Fn("truthy")';
    if (t === "String") return 'Fn("js_str")';
    if (t === "Number") return 'Fn("js_num")';
    if (t === "NaN") return "js_nan()";
    if (t === "Infinity") return "js_inf()";
    const d = declOf(n);
    if (d) {
        const info = declInfo.get(d);
        if (info) {
            if (info.kind === "inline") return info.value;
            if (info.kind === "global") return G(info.name);
            if (info.kind === "fn") return `Fn(${str(info.name)})`;
            if (info.kind === "class") fail(n, "a class used as a value");
        }
        if (isLibDecl(d)) fail(n, `library value ${t} used directly`);
    }
    return safe(t);
}

/** Every `.name` the output reads or writes: the host registers a getter and setter for each on
 *  `Obj` (a registered property is several times faster than Rhai's indexer fallback). */
const usedProps = new Set();
function propertyName(name) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name)) { usedProps.add(name); return `.${name}`; }
    return `[${str(name)}]`;
}

function propertyAccess(n) {
    const obj = n.expression, name = n.name.text;
    // Math.PI and friends
    if (ts.isIdentifier(obj) && obj.text === "Math") {
        const c = { PI: "PI()", E: "E()", SQRT1_2: num(Math.SQRT1_2), SQRT2: num(Math.SQRT2), LN2: num(Math.LN2), LN10: num(Math.LN10) }[name];
        if (c) return c;
    }
    if (ts.isIdentifier(obj) && obj.text === "Number") {
        const c = { MAX_VALUE: num(Number.MAX_VALUE), MIN_VALUE: num(Number.MIN_VALUE), EPSILON: num(Number.EPSILON), POSITIVE_INFINITY: "js_inf()" }[name];
        if (c) return c;
    }
    if (ts.isIdentifier(obj)) {
        const od = declOf(obj);
        const members = od && enumConsts.get(od);
        if (members && members.has(name)) return members.get(name);
    }
    const d = propDecl(n);
    if (d && (ts.isGetAccessorDeclaration(d) || (d.kind === ts.SyntaxKind.GetAccessor))) {
        const cls = d.parent?.name?.text;
        return `${expr(obj)}.${cls}__get_${name}()`;
    }
    if (d && ts.isMethodDeclaration(d) && ts.isClassDeclaration(d.parent)) fail(n, "a method used as a value");
    const k = kindOfType(obj);
    if (name === "length") {
        if (k === "string") return `js_len(${expr(obj)})`;
        return `${expr(obj)}.length`;
    }
    if (n.questionDotToken) {
        const t = tmp("o");
        return `{ let ${t} = ${expr(obj)}; if js_is_nullish(${t}) { () } else { ${t}${propertyName(name)} } }`;
    }
    return `${expr(obj)}${propertyName(name)}`;
}

function elementAccess(n) {
    const k = kindOfType(n.expression);
    if (k === "string") return `js_char_at(${expr(n.expression)}, ${expr(n.argumentExpression)})`;
    if (n.questionDotToken) {
        const t = tmp("o");
        return `{ let ${t} = ${expr(n.expression)}; if js_is_nullish(${t}) { () } else { ${t}[${expr(n.argumentExpression)}] } }`;
    }
    return `${expr(n.expression)}[${expr(n.argumentExpression)}]`;
}

function objectLiteral(n) {
    const plain = [], spreads = [];
    let hasSpread = false, hasComputed = false;
    for (const p of n.properties) {
        if (ts.isSpreadAssignment(p)) hasSpread = true;
        else if (p.name && ts.isComputedPropertyName(p.name)) hasComputed = true;
    }
    const keyOf = p => (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : fail(p, "unsupported key"));
    const valueOf = p => {
        if (ts.isPropertyAssignment(p)) return expr(p.initializer);
        if (ts.isShorthandPropertyAssignment(p)) {
            const sym = resolve(checker.getShorthandAssignmentValueSymbol(p));
            const d = sym?.valueDeclaration ?? sym?.declarations?.[0];
            const info = d && declInfo.get(d);
            if (info?.kind === "global") return G(info.name);
            if (info?.kind === "inline") return info.value;
            if (info?.kind === "fn") return `Fn(${str(info.name)})`;
            return safe(p.name.text);
        }
        if (ts.isMethodDeclaration(p)) return closure(p);
        return fail(p, "unsupported object member");
    };
    const mapKey = k => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !RESERVED.has(k) ? k : str(k));
    if (!hasSpread && !hasComputed) {
        const keys = n.properties.map(keyOf);
        const body = n.properties.map(p => `${mapKey(keyOf(p))}: ${valueOf(p)}`).join(", ");
        if (keys.length <= 1) return `obj(#{ ${body} })`;
        return `obj_o([${keys.map(str).join(", ")}], #{ ${body} })`;
    }
    if (hasComputed) {
        const t = tmp("obj");
        const parts = [`let ${t} = obj();`];
        for (const p of n.properties) {
            if (ts.isSpreadAssignment(p)) parts.push(`js_assign(${t}, ${expr(p.expression)});`);
            else if (ts.isComputedPropertyName(p.name)) parts.push(`${t}[${expr(p.name.expression)}] = ${valueOf(p)};`);
            else parts.push(`${t}[${str(keyOf(p))}] = ${valueOf(p)};`);
        }
        return `{ ${parts.join(" ")} ${t} }`;
    }
    for (const p of n.properties) {
        if (ts.isSpreadAssignment(p)) spreads.push(expr(p.expression));
        else spreads.push(`#{ ${mapKey(keyOf(p))}: ${valueOf(p)} }`);
    }
    return `js_merge([${spreads.join(", ")}])`;
}

function arrayLiteral(n) {
    if (!n.elements.some(ts.isSpreadElement)) return `list([${n.elements.map(e => expr(e)).join(", ")}])`;
    return `js_build([${n.elements.map(e => (ts.isSpreadElement(e) ? `true, ${expr(e.expression)}` : `false, ${expr(e)}`)).join(", ")}])`;
}

function template(n) {
    const parts = [];
    if (n.head.text) parts.push(str(n.head.text));
    for (const span of n.templateSpans) {
        parts.push(isStr(span.expression) ? `(${expr(span.expression)})` : `js_str(${expr(span.expression)})`);
        if (span.literal.text) parts.push(str(span.literal.text));
    }
    if (parts.length === 0) return '""';
    if (parts.length === 1) return isStr(n.templateSpans[0]?.expression ?? n) && !parts[0].startsWith('"') ? parts[0] : parts[0].startsWith('"') ? parts[0] : `("" + ${parts[0]})`;
    return `(${parts.join(" + ")})`;
}

function closure(f) {
    const saved = { ...ctx };
    const isArrow = ts.isArrowFunction(f);
    if (isArrow) ctx.arrowDepth++;
    else if (ctx.cls) fail(f, "a non-arrow function inside a class body");
    const params = [];
    const pre = [];
    f.parameters.forEach((p, i) => {
        if (ts.isIdentifier(p.name)) params.push(safe(p.name.text));
        else {
            const t = `__p${i}`;
            params.push(t);
            pre.push(destructure(p.name, t));
        }
        if (p.initializer) pre.push(`let ${params[i]} = if js_is_nullish(${params[i]}) { ${expr(p.initializer)} } else { ${params[i]} };`);
    });
    // JavaScript ignores extra arguments; Rhai does not. A closure stored where a function of more
    // parameters is expected (`run: () => ...` for `run: (a: Args) => object`) takes the rest.
    const ctxType = checker.getContextualType(f);
    const sig = ctxType?.getCallSignatures?.()[0];
    const sigDecl = sig?.getDeclaration?.();
    if (sig && sigDecl && !sigDecl.getSourceFile().isDeclarationFile) {
        for (let i = params.length; i < sig.getParameters().length; i++) params.push(`__unused${i}`);
    }
    let body;
    if (ts.isBlock(f.body)) body = block(f.body.statements, pre);
    else body = `{ ${pre.join(" ")} ${expr(f.body)} }`;
    ctx.arrowDepth = saved.arrowDepth;
    return `|${params.join(", ")}| ${body}`;
}

function callbackArity(fnArg) {
    const u = unwrap(fnArg);
    if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) return u.parameters.length;
    const d = ts.isIdentifier(u) ? declOf(u) : null;
    const fnNode = fnNodeOfDecl(d);
    return fnNode ? fnNode.parameters.length : 1;
}

function arrayMethod(n, obj, name) {
    const a = n.arguments;
    const o = expr(obj);
    // A receiver reached through a variable that closures capture is a shared value, locked while
    // a method runs on it; a callback that captured the same variable would then find it locked.
    // So callback methods run on a temporary holding the receiver.
    const onTemp = (call_) => { const r = tmp("r"); return `{ let ${r} = ${o}; ${r}.${call_} }`; };
    const cb = (method) => {
        const ar = Math.min(2, Math.max(1, callbackArity(a[0])));
        return onTemp(`js_${method}${ar}(${expr(a[0])})`);
    };
    switch (name) {
        case "push":
            if (a.some(ts.isSpreadElement)) {
                if (a.length !== 1) fail(n, "push with a spread and other items");
                return `js_push_all(${o}, ${expr(a[0].expression)})`;
            }
            return `${o}.push(${a.map(x => expr(x)).join(", ")})`;
        case "pop": case "shift": case "reverse": return `${o}.${name}()`;
        case "unshift": case "includes": case "indexOf": case "concat": case "fill": return `${o}.${name}(${a.map(x => expr(x)).join(", ")})`;
        case "slice": case "splice": case "join": return `${o}.${name}(${a.map(x => expr(x)).join(", ")})`;
        case "map": case "filter": case "find": case "findIndex": case "some": case "every": case "forEach": case "flatMap": return cb(name);
        case "reduce": if (a.length < 2) fail(n, "reduce without an initial value"); return onTemp(`js_reduce(${expr(a[0])}, ${expr(a[1])})`);
        case "sort": return a.length ? onTemp(`js_sort(${expr(a[0])})`) : `${o}.js_sort()`;
        case "entries": return `js_list_entries(${o})`;
        case "keys": return `js_list_keys(${o})`;
        case "at": return `js_at(${o}, ${expr(a[0])})`;
        case "toString": return `js_str(${o})`;
    }
    fail(n, `array method ${name}`);
}

function stringMethod(n, obj, name) {
    const a = n.arguments.map(x => expr(x));
    const o = expr(obj);
    const m = {
        slice: "js_slice", substring: "js_slice", startsWith: "js_starts_with", endsWith: "js_ends_with", includes: "js_includes",
        indexOf: "js_index_of", toUpperCase: "js_upper", toLowerCase: "js_lower", trim: "js_trim", split: "js_split", repeat: "js_repeat",
        padStart: "js_pad_start", padEnd: "js_pad_end", charCodeAt: "js_char_code_at", charAt: "js_char_at", replaceAll: "js_replace_all", toString: "js_str",
    }[name];
    if (name === "replace") {
        const re = unwrap(n.arguments[0]);
        if (ts.isRegularExpressionLiteral(re) && re.text === "/\\{(\\w+)\\}/g") return `js_replace_braces(${o}, ${expr(n.arguments[1])})`;
        if (ts.isStringLiteral(re) && !isFnArg(n.arguments[1])) return `js_replace_first(${o}, ${a.slice(0, 2).join(", ")})`;
        fail(n, "string replace with this pattern");
    }
    if (!m) fail(n, `string method ${name}`);
    if (name === "padStart" || name === "padEnd") return `${m}(${o}, ${a[0]}, ${a[1] ?? '" "'})`;
    return `${m}(${[o, ...a].join(", ")})`;
}
const isFnArg = x => { const u = unwrap(x); return ts.isArrowFunction(u) || ts.isFunctionExpression(u); };

/** Calls the config maps onto the engine or the prelude: dotted path -> Rhai function name. */
const API = config.api ?? {};

function dotted(n) {
    n = unwrap(n);
    if (ts.isIdentifier(n)) return n.text;
    if (ts.isPropertyAccessExpression(n)) { const l = dotted(n.expression); return l ? `${l}.${n.name.text}` : null; }
    return null;
}

function call(n) {
    const callee = unwrap(n.expression);
    const given = n.arguments;
    const plainArgs = () => given.map(x => expr(x)).join(", ");
    const path_ = dotted(callee);
    if (path_ && API[path_] !== undefined) {
        const target = API[path_];
        if (target === null) return "()";
        // Engine calls read plain maps and arrays; callbacks pass as they are (a closure keeps
        // what it captured only if it is not copied through a native function).
        const isFn = x => isFnArg(x) || typeOf(x).getCallSignatures().length > 0;
        return `${target}(${given.map(x => (isFn(x) ? expr(x) : `js_plain(${expr(x)})`)).join(", ")})`;
    }
    if (ts.isIdentifier(callee)) {
        const name = callee.text;
        const builtin = { String: "js_str", Number: "js_num", isFinite: "js_is_finite", parseFloat: "js_parse_float", Boolean: "truthy" }[name];
        if (builtin) return `${builtin}(${plainArgs()})`;
        const d = declOf(callee);
        const info = d && declInfo.get(d);
        if (info?.kind === "fn") return `${info.name}(${args(n, fnNodeOfDecl(d) ?? info.node)})`;
        if (info?.kind === "class") fail(n, "calling a class");
        const lift = d && lifted.get(d);
        if (lift) {
            const extra = lift.caps.map(capName);
            if (lift.usesThis) extra.push(thisRef());
            const a = args(n, lift.node);
            return `${lift.name}(${[a, ...extra].filter(x => x !== "").join(", ")})`;
        }
        // A local function value: a closure, or a parameter holding one.
        const fnNode = fnNodeOfDecl(d);
        return `${identifier(callee)}.call(${args(n, fnNode)})`;
    }
    if (ts.isPropertyAccessExpression(callee)) {
        const obj = callee.expression, name = callee.name.text;
        if (ts.isIdentifier(obj)) {
            const root = obj.text;
            if (root === "Math") {
                const one = { floor: "floor", ceil: "ceil", abs: "abs", sqrt: "sqrt", sin: "sin", cos: "cos", tan: "tan", asin: "asin", acos: "acos", atan: "atan", exp: "exp", log: "ln", log10: "log", round: "js_round", trunc: "js_trunc", sign: "js_sign", cbrt: "js_cbrt" }[name];
                if (one) return `${one}(${plainArgs()})`;
                if (name === "atan2") return `js_atan2(${plainArgs()})`;
                if (name === "pow") return `js_pow(${plainArgs()})`;
                if (name === "max" || name === "min" || name === "hypot") {
                    if (given.length === 1 && ts.isSpreadElement(given[0])) return `js_${name}_list(${expr(given[0].expression)})`;
                    if (given.some(ts.isSpreadElement)) {
                        return `js_${name}_list(js_build([${given.map(e => (ts.isSpreadElement(e) ? `true, ${expr(e.expression)}` : `false, ${expr(e)}`)).join(", ")}]))`;
                    }
                    if (given.length === 1) return expr(given[0]);
                    if (given.length > 4) return `js_${name}_list(list([${plainArgs()}]))`;
                    return `js_${name}(${plainArgs()})`;
                }
                if (name === "imul") return `js_imul(${plainArgs()})`;
                fail(n, `Math.${name}`);
            }
            if (root === "JSON") return `js_json_${name === "parse" ? "parse" : "stringify"}(${expr(given[0])})`;
            if (root === "Object") {
                const m = { keys: "js_keys", values: "js_values", entries: "js_entries", assign: "js_assign" }[name];
                if (!m) fail(n, `Object.${name}`);
                return `${m}(${plainArgs()})`;
            }
            if (root === "Number") {
                const m = { isFinite: "js_is_finite", isNaN: "js_is_nan", parseFloat: "js_parse_float", isInteger: "js_is_integer" }[name];
                if (!m) fail(n, `Number.${name}`);
                return `${m}(${plainArgs()})`;
            }
            if (root === "Array" && name === "isArray") return `js_is_array(${plainArgs()})`;
            if (root === "Array" && name === "from") return `js_build([true, ${expr(given[0])}])`;
            if (root === "Date" && name === "now") return "js_date_now()";
        }
        const d = propDecl(callee);
        // A method of a class we translate (or one provided under the same scheme).
        if (d && ts.isMethodDeclaration(d) && ts.isClassDeclaration(d.parent) && declInfo.has(d.parent)) {
            const cls = d.parent.name.text;
            const isStatic = d.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
            if (isStatic) return `${cls}__${name}(${args(n, d)})`;
            if (callee.questionDotToken) {
                const t = tmp("o");
                return `{ let ${t} = ${expr(obj)}; if js_is_nullish(${t}) { () } else { ${t}.${cls}__${name}(${args(n, d)}) } }`;
            }
            return `${expr(obj)}.${cls}__${name}(${args(n, d)})`;
        }
        // Library types: arrays, strings, numbers, Map, Set, typed arrays, RegExp.
        if (!d || isLibDecl(d)) {
            const k = kindOfType(obj);
            if (k === "array") return arrayMethod(n, obj, name);
            if (k === "string") return stringMethod(n, obj, name);
            if (k === "number") {
                if (name === "toFixed") return `js_to_fixed(${expr(obj)}, ${given.length ? expr(given[0]) : "0.0"})`;
                if (name === "toLocaleString") return `js_locale(${expr(obj)})`;
                if (name === "toPrecision") return `js_to_precision(${expr(obj)}, ${expr(given[0])})`;
                if (name === "toString") return `js_str(${expr(obj)})`;
                fail(n, `number method ${name}`);
            }
            if (k === "map" || k === "set") {
                if (name === "forEach") return `js_coll_for_each(${expr(obj)}, ${expr(given[0])})`;
                if (["get", "set", "has", "delete", "clear", "add", "keys", "values", "entries"].includes(name)) return `${expr(obj)}.${name}(${plainArgs()})`;
                fail(n, `${k} method ${name}`);
            }
            if (k === "regexp" && name === "test") return `js_re_test(${expr(obj)}, ${expr(given[0])})`;
            if (k === "floats") {
                if (name === "set") return `js_floats_set(${expr(obj)}, ${plainArgs()}${given.length < 2 ? ", 0.0" : ""})`;
                if (name === "fill") return `${expr(obj)}.fill(${plainArgs()})`;
                fail(n, `typed array method ${name}`);
            }
            if (d && isLibDecl(d) && !d.getSourceFile().fileName.includes("addon.d.ts")) fail(n, `library method ${name} on ${k}`);
        }
        // A function held in a property: an interface method (an object of closures, or a class
        // instance passed as that interface - dispatched at run time) or a function-valued field.
        const fnNode = fnNodeOfDecl(d);
        if (d && ts.isMethodSignature(d)) {
            const iface = d.parent?.name?.text;
            const native = config.interfaceCalls?.[`${iface}.${name}`];
            if (native) return `${native}(${args(n, fnNode, [expr(obj)])})`;
            return `js_icall(${expr(obj)}, ${str(name)}, [${args(n, fnNode)}])`;
        }
        if (callee.questionDotToken) {
            const t = tmp("f");
            return `{ let ${t} = ${expr(obj)}${propertyName(name)}; if js_is_nullish(${t}) { () } else { ${t}.call(${args(n, fnNode)}) } }`;
        }
        return `${expr(obj)}${propertyName(name)}.call(${args(n, fnNode)})`;
    }
    if (ts.isElementAccessExpression(callee) || ts.isCallExpression(callee)) return `${expr(callee)}.call(${plainArgs()})`;
    if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) return `(${closure(callee)}).call(${args(n, callee)})`;
    fail(n, "unsupported call");
}

function newExpr(n) {
    const c = unwrap(n.expression);
    const a = n.arguments ?? [];
    if (ts.isIdentifier(c)) {
        switch (c.text) {
            case "Map": return a.length ? `js_new_map(${expr(a[0])})` : "js_new_map()";
            case "Set": return a.length ? `js_new_set(${expr(a[0])})` : "js_new_set()";
            case "Float32Array": case "Float64Array": case "Uint32Array":
                if (a.length && !isNum(a[0])) return `js_floats_from(${expr(a[0])})`;
                return `floats_f(${a.length ? expr(a[0]) : "0.0"})`;
            case "Error": return a.length ? expr(a[0]) : '"Error"';
            case "Array": return a.length ? `js_new_array(${expr(a[0])})` : "list()";
        }
        const d = declOf(c);
        if (d && ts.isClassDeclaration(d)) {
            const ctor = d.members.find(ts.isConstructorDeclaration);
            return `${d.name.text}__new(${args(n, ctor ?? { parameters: [] })})`;
        }
    }
    fail(n, "unsupported new");
}

function binary(n) {
    const op = n.operatorToken.kind, K = ts.SyntaxKind;
    const L = n.left, R = n.right;
    switch (op) {
        case K.EqualsToken: return assignExpr(n);
        case K.PlusEqualsToken: case K.MinusEqualsToken: case K.AsteriskEqualsToken: case K.SlashEqualsToken: case K.PercentEqualsToken:
        case K.QuestionQuestionEqualsToken: case K.BarBarEqualsToken: case K.AmpersandAmpersandEqualsToken: case K.AsteriskAsteriskEqualsToken:
        case K.BarEqualsToken: case K.AmpersandEqualsToken: case K.CaretEqualsToken: case K.LessThanLessThanEqualsToken: case K.GreaterThanGreaterThanEqualsToken: case K.GreaterThanGreaterThanGreaterThanEqualsToken:
            return assignExpr(n);
        case K.PlusToken:
            if (isNum(L) && isNum(R)) return `(${expr(L)} + ${expr(R)})`;
            if (isStr(L) && isStr(R)) return `(${expr(L)} + ${expr(R)})`;
            if (isStr(L) || isStr(R)) return `(${isStr(L) ? expr(L) : `js_str(${expr(L)})`} + ${isStr(R) ? expr(R) : `js_str(${expr(R)})`})`;
            return `js_add(${expr(L)}, ${expr(R)})`;
        case K.MinusToken: return `(${expr(L)} - ${expr(R)})`;
        case K.AsteriskToken: return `(${expr(L)} * ${expr(R)})`;
        case K.SlashToken: return `(${expr(L)} / ${expr(R)})`;
        case K.PercentToken: return `(${expr(L)} % ${expr(R)})`;
        case K.AsteriskAsteriskToken: return `js_pow(${expr(L)}, ${expr(R)})`;
        case K.LessThanToken: return `(${expr(L)} < ${expr(R)})`;
        case K.GreaterThanToken: return `(${expr(L)} > ${expr(R)})`;
        case K.LessThanEqualsToken: return `(${expr(L)} <= ${expr(R)})`;
        case K.GreaterThanEqualsToken: return `(${expr(L)} >= ${expr(R)})`;
        case K.EqualsEqualsEqualsToken: case K.EqualsEqualsToken:
            if (isPrimitive(L) && isPrimitive(R)) return `(${expr(L)} == ${expr(R)})`;
            return `js_eq(${expr(L)}, ${expr(R)})`;
        case K.ExclamationEqualsEqualsToken: case K.ExclamationEqualsToken:
            if (isPrimitive(L) && isPrimitive(R)) return `(${expr(L)} != ${expr(R)})`;
            return `!js_eq(${expr(L)}, ${expr(R)})`;
        case K.AmpersandAmpersandToken: {
            if (isBool(L) && isBool(R)) return `(${expr(L)} && ${expr(R)})`;
            const t = tmp("a");
            return `{ let ${t} = ${expr(L)}; if truthy(${t}) { ${expr(R)} } else { ${t} } }`;
        }
        case K.BarBarToken: {
            if (isBool(L) && isBool(R)) return `(${expr(L)} || ${expr(R)})`;
            const t = tmp("o");
            return `{ let ${t} = ${expr(L)}; if truthy(${t}) { ${t} } else { ${expr(R)} } }`;
        }
        case K.QuestionQuestionToken: return `(${expr(L)} ?? ${expr(R)})`;
        case K.BarToken: return `js_bor(${expr(L)}, ${expr(R)})`;
        case K.AmpersandToken: return `js_band(${expr(L)}, ${expr(R)})`;
        case K.CaretToken: return `js_bxor(${expr(L)}, ${expr(R)})`;
        case K.LessThanLessThanToken: return `js_shl(${expr(L)}, ${expr(R)})`;
        case K.GreaterThanGreaterThanToken: return `js_shr(${expr(L)}, ${expr(R)})`;
        case K.GreaterThanGreaterThanGreaterThanToken: return `js_ushr(${expr(L)}, ${expr(R)})`;
        case K.InKeyword: return `js_has(${expr(R)}, ${expr(L)})`;
        case K.CommaToken: return `{ ${expr(L)}; ${expr(R)} }`;
        case K.InstanceOfKeyword: fail(n, "instanceof");
    }
    fail(n, `operator ${ts.tokenToString(op)}`);
}

/** The target of an assignment, as an lvalue. */
function lvalue(n) {
    n = unwrap(n);
    if (ts.isIdentifier(n)) {
        const d = declOf(n);
        const info = d && declInfo.get(d);
        if (info?.kind === "global") return G(info.name);
        if (info) fail(n, "assigning to a constant or function");
        return safe(n.text);
    }
    if (ts.isPropertyAccessExpression(n)) {
        const d = propDecl(n);
        if (d && ts.isSetAccessorDeclaration(d)) fail(n, "setter in a compound position");
        return `${expr(n.expression)}${propertyName(n.name.text)}`;
    }
    if (ts.isElementAccessExpression(n)) return `${expr(n.expression)}[${expr(n.argumentExpression)}]`;
    fail(n, "unsupported assignment target");
}

/** An assignment, as a statement (no value). */
function assignStmt(n) {
    const op = n.operatorToken.kind, K = ts.SyntaxKind;
    const L = unwrap(n.left);
    if (op === K.EqualsToken && (ts.isArrayLiteralExpression(L) || ts.isObjectLiteralExpression(L))) {
        const t = tmp("d");
        return `let ${t} = ${expr(n.right)}; ${destructureAssign(L, t)}`;
    }
    if (op === K.EqualsToken && ts.isPropertyAccessExpression(L)) {
        const d = propDecl(L);
        if (d && ts.isSetAccessorDeclaration(d)) return `${expr(L.expression)}.${d.parent.name.text}__set_${L.name.text}(${expr(n.right)});`;
    }
    const target = lvalue(L);
    const R = n.right;
    switch (op) {
        case K.EqualsToken: return `${target} = ${expr(R)};`;
        case K.PlusEqualsToken:
            if (isNum(L) && isNum(R)) return `${target} += ${expr(R)};`;
            if (isStr(L)) return `${target} += ${isStr(R) ? expr(R) : `js_str(${expr(R)})`};`;
            return `${target} = js_add(${target}, ${expr(R)});`;
        case K.MinusEqualsToken: return `${target} -= ${expr(R)};`;
        case K.AsteriskEqualsToken: return `${target} *= ${expr(R)};`;
        case K.SlashEqualsToken: return `${target} /= ${expr(R)};`;
        case K.PercentEqualsToken: return `${target} %= ${expr(R)};`;
        case K.AsteriskAsteriskEqualsToken: return `${target} = js_pow(${target}, ${expr(R)});`;
        case K.QuestionQuestionEqualsToken: return `if js_is_nullish(${target}) { ${target} = ${expr(R)}; }`;
        case K.BarBarEqualsToken: return `if !truthy(${target}) { ${target} = ${expr(R)}; }`;
        case K.AmpersandAmpersandEqualsToken: return `if truthy(${target}) { ${target} = ${expr(R)}; }`;
        case K.BarEqualsToken: return `${target} = js_bor(${target}, ${expr(R)});`;
        case K.AmpersandEqualsToken: return `${target} = js_band(${target}, ${expr(R)});`;
        case K.CaretEqualsToken: return `${target} = js_bxor(${target}, ${expr(R)});`;
        case K.LessThanLessThanEqualsToken: return `${target} = js_shl(${target}, ${expr(R)});`;
        case K.GreaterThanGreaterThanEqualsToken: return `${target} = js_shr(${target}, ${expr(R)});`;
        case K.GreaterThanGreaterThanGreaterThanEqualsToken: return `${target} = js_ushr(${target}, ${expr(R)});`;
    }
    fail(n, "assignment operator");
}

/** An assignment used for its value: done in a block that yields the new value. */
function assignExpr(n) {
    const L = unwrap(n.left);
    return `{ ${assignStmt(n)} ${lvalue(L)} }`;
}

function incdec(n, prefix) {
    const operand = unwrap(n.operand);
    const target = lvalue(operand);
    const op = n.operator === ts.SyntaxKind.PlusPlusToken ? "+=" : "-=";
    if (prefix) return `{ ${target} ${op} 1.0; ${target} }`;
    const t = tmp("v");
    return `{ let ${t} = ${target}; ${target} ${op} 1.0; ${t} }`;
}

/** An expression. Block expressions (`{ let t = ...; t }`) come out parenthesized, so they parse
 *  anywhere - an `if` condition included. */
function expr(n) {
    const e = expr0(n);
    return e.startsWith("{") ? `(${e})` : e;
}

function expr0(n) {
    const K = ts.SyntaxKind;
    switch (n.kind) {
        case K.ParenthesizedExpression: return `(${expr(n.expression)})`;
        case K.AsExpression: case K.NonNullExpression: case K.TypeAssertionExpression: case K.SatisfiesExpression: return expr(n.expression);
        case K.NumericLiteral: return num(Number(n.text));
        case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: return str(n.text);
        case K.TemplateExpression: return template(n);
        case K.TrueKeyword: return "true";
        case K.FalseKeyword: return "false";
        case K.NullKeyword: return "()";
        case K.ThisKeyword: return thisRef();
        case K.Identifier: return identifier(n);
        case K.PropertyAccessExpression: return propertyAccess(n);
        case K.ElementAccessExpression: return elementAccess(n);
        case K.ObjectLiteralExpression: return objectLiteral(n);
        case K.ArrayLiteralExpression: return arrayLiteral(n);
        case K.ArrowFunction: case K.FunctionExpression: return closure(n);
        case K.CallExpression: return call(n);
        case K.NewExpression: return newExpr(n);
        case K.BinaryExpression: return binary(n);
        case K.ConditionalExpression: return `(if ${cond(n.condition)} { ${expr(n.whenTrue)} } else { ${expr(n.whenFalse)} })`;
        case K.PrefixUnaryExpression: {
            const o = n.operand;
            switch (n.operator) {
                case K.ExclamationToken: return `!${cond(o)}`;
                case K.MinusToken: return isNum(o) ? `(-${expr(o)})` : `(-js_num(${expr(o)}))`;
                case K.PlusToken: return `js_num(${expr(o)})`;
                case K.TildeToken: return `js_bxor(${expr(o)}, -1.0)`;
                case K.PlusPlusToken: case K.MinusMinusToken: return incdec(n, true);
            }
            break;
        }
        case K.PostfixUnaryExpression: return incdec(n, false);
        case K.TypeOfExpression: return `js_typeof(${expr(n.expression)})`;
        case K.RegularExpressionLiteral: {
            const m = /^\/(.*)\/([a-z]*)$/s.exec(n.text);
            return str(m[1]);
        }
        case K.VoidExpression: return `{ ${expr(n.expression)}; () }`;
        case K.SpreadElement: fail(n, "spread in this position");
    }
    fail(n, `unsupported expression (${K[n.kind]})`);
}

// --- Destructuring ---------------------------------------------------------------------------------

function destructure(pattern, source) {
    const out = [];
    if (ts.isObjectBindingPattern(pattern)) {
        const named = pattern.elements.filter(e => !e.dotDotDotToken).map(e => (e.propertyName ?? e.name).text);
        for (const el of pattern.elements) {
            if (el.dotDotDotToken) { out.push(`let ${safe(el.name.text)} = js_omit(${source}, [${named.map(str).join(", ")}]);`); continue; }
            const key = el.propertyName ? el.propertyName.text : el.name.text;
            const val = `${source}${propertyName(key)}`;
            if (ts.isIdentifier(el.name)) {
                const v = el.initializer ? `(${val} ?? ${expr(el.initializer)})` : val;
                out.push(`let ${safe(el.name.text)} = ${v};`);
            } else {
                const t = tmp("d");
                out.push(`let ${t} = ${val};`, destructure(el.name, t));
            }
        }
    } else if (ts.isArrayBindingPattern(pattern)) {
        pattern.elements.forEach((el, i) => {
            if (ts.isOmittedExpression(el)) return;
            if (el.dotDotDotToken) { out.push(`let ${safe(el.name.text)} = ${source}.slice(${num(i)});`); return; }
            const val = `${source}[${num(i)}]`;
            if (ts.isIdentifier(el.name)) out.push(`let ${safe(el.name.text)} = ${el.initializer ? `(${val} ?? ${expr(el.initializer)})` : val};`);
            else { const t = tmp("d"); out.push(`let ${t} = ${val};`, destructure(el.name, t)); }
        });
    } else fail(pattern, "binding pattern");
    return out.join(" ");
}

function destructureAssign(pattern, source) {
    const out = [];
    if (ts.isArrayLiteralExpression(pattern)) {
        pattern.elements.forEach((el, i) => { if (!ts.isOmittedExpression(el)) out.push(`${lvalue(el)} = ${source}[${num(i)}];`); });
    } else fail(pattern, "destructuring assignment");
    return out.join(" ");
}

// --- Statements --------------------------------------------------------------------------------------

function block(statements, pre = []) {
    const lines = [...pre];
    for (const s of statements) lines.push(stmt(s));
    return `{\n${lines.filter(Boolean).join("\n")}\n}`;
}

function asBlock(s) {
    return ts.isBlock(s) ? block(s.statements) : `{\n${stmt(s)}\n}`;
}

function varStmt(list) {
    const out = [];
    for (const d of list.declarations) {
        if (lifted.has(d)) continue;
        if (ts.isIdentifier(d.name)) out.push(`let ${safe(d.name.text)}${d.initializer ? ` = ${expr(d.initializer)}` : ""};`);
        else {
            const t = tmp("d");
            out.push(`let ${t} = ${expr(d.initializer)};`, destructure(d.name, t));
        }
    }
    return out.join(" ");
}

/** A for-of binding. JavaScript gives each iteration its own `const`, which closures made in the
 *  body capture; Rhai reuses the loop variable, so it is copied into a fresh `let` each pass. */
function makesClosures(node) {
    let found = false;
    const visit = n => { if (found) return; if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) { found = true; return; } ts.forEachChild(n, visit); };
    visit(node);
    return found;
}
function forOfBinding(init, item, body) {
    const d = init.declarations?.[0];
    if (!d) fail(init, "for-of without a declaration");
    if (ts.isIdentifier(d.name)) {
        if (body && !makesClosures(body)) return { name: safe(d.name.text), pre: "" };
        return { name: item, pre: `let ${safe(d.name.text)} = ${item};` };
    }
    return { name: item, pre: destructure(d.name, item) };
}
/** A loop body's statements, without a block of its own (one scope a pass is enough). */
function bodyStmts(s) {
    return ts.isBlock(s) ? s.statements.map(stmt).filter(Boolean).join("\n") : stmt(s);
}

function stmt(s) {
    const K = ts.SyntaxKind;
    switch (s.kind) {
        case K.Block: return block(s.statements);
        case K.EmptyStatement: return "";
        case K.VariableStatement: return varStmt(s.declarationList);
        case K.ExpressionStatement: {
            const e = unwrap(s.expression);
            if (ts.isBinaryExpression(e) && e.operatorToken.kind >= K.FirstAssignment && e.operatorToken.kind <= K.LastAssignment) return assignStmt(e);
            if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && (e.operator === K.PlusPlusToken || e.operator === K.MinusMinusToken)) {
                return `${lvalue(e.operand)} ${e.operator === K.PlusPlusToken ? "+=" : "-="} 1.0;`;
            }
            if (ts.isBinaryExpression(e) && e.operatorToken.kind === K.CommaToken) return `${stmt(ts.factory.createExpressionStatement(e.left))} ${stmt(ts.factory.createExpressionStatement(e.right))}`;
            return `${expr(e)};`;
        }
        case K.IfStatement: {
            let out = `if ${cond(s.expression)} ${asBlock(s.thenStatement)}`;
            if (s.elseStatement) out += ts.isIfStatement(s.elseStatement) ? ` else ${stmt(s.elseStatement)}` : ` else ${asBlock(s.elseStatement)}`;
            return out;
        }
        case K.ReturnStatement: return s.expression ? `return ${expr(s.expression)};` : "return;";
        case K.BreakStatement: if (s.label) fail(s, "labelled break"); return "break;";
        case K.ContinueStatement: if (s.label) fail(s, "labelled continue"); return "continue;";
        case K.ThrowStatement: return `throw ${expr(s.expression)};`;
        case K.WhileStatement: return `while ${cond(s.expression)} {\n${bodyStmts(s.statement)}\n}`;
        case K.DoStatement: return `loop {\n${stmt(s.statement)}\nif !${cond(s.expression)} { break; }\n}`;
        case K.ForStatement: {
            const first = tmp("first");
            const init = s.initializer ? (ts.isVariableDeclarationList(s.initializer) ? varStmt(s.initializer) : `${stmt(ts.factory.createExpressionStatement(s.initializer))}`) : "";
            const update = s.incrementor ? stmt(ts.factory.createExpressionStatement(s.incrementor)) : "";
            const test = s.condition ? `if !${cond(s.condition)} { break; }` : "";
            return `{\n${init}\nlet ${first} = true;\nloop {\nif !${first} { ${update} }\n${first} = false;\n${test}\n${bodyStmts(s.statement)}\n}\n}`;
        }
        case K.ForOfStatement: {
            const item = tmp("it");
            const { name, pre } = forOfBinding(s.initializer, item, s.statement);
            const k = kindOfType(s.expression);
            let src = expr(s.expression);
            if (k === "string") src = `js_split(${src}, "")`;
            else if (k === "floats") src = `js_build([true, ${src}])`;
            return `for ${name} in ${src} {\n${pre}\n${bodyStmts(s.statement)}\n}`;
        }
        case K.ForInStatement: {
            const { name, pre } = forOfBinding(s.initializer, tmp("k"), s.statement);
            return `for ${name} in js_keys(${expr(s.expression)}) {\n${pre}\n${bodyStmts(s.statement)}\n}`;
        }
        case K.SwitchStatement: return switchStmt(s);
        case K.TryStatement: {
            let out = `try ${block(s.tryBlock.statements)}`;
            const c = s.catchClause;
            if (c) {
                const v = c.variableDeclaration ? safe(c.variableDeclaration.name.text) : "__e";
                out += ` catch (${v}) ${block(c.block.statements, [`let ${v} = js_error(${v});`])}`;
            } else out += " catch (__e) { throw __e; }";
            if (s.finallyBlock) out += `\n${block(s.finallyBlock.statements)}`;
            return out;
        }
        case K.FunctionDeclaration: {
            // A function inside a function: a closure, declared where it stands.
            return `let ${safe(s.name.text)} = ${closure(ts.factory.createArrowFunction(undefined, undefined, s.parameters, undefined, undefined, s.body))};`;
        }
        case K.InterfaceDeclaration: case K.TypeAliasDeclaration: return "";
        case K.LabeledStatement: fail(s, "labels");
    }
    fail(s, `unsupported statement (${K[s.kind]})`);
}

function switchStmt(s) {
    const t = tmp("sw");
    const out = [`let ${t} = ${expr(s.expression)};`];
    const prim = isPrimitive(s.expression);
    const clauses = s.caseBlock.clauses;
    // Cases without statements fall through to the next: one test for the group.
    let group = [];
    const chain = [];
    let defaultBody = null;
    for (const c of clauses) {
        if (ts.isDefaultClause(c)) {
            if (group.length) fail(c, "a case falling into default");
            defaultBody = c.statements;
            continue;
        }
        group.push(c.expression);
        if (c.statements.length === 0) continue;
        const stmts = c.statements.filter(x => !(ts.isBreakStatement(x)));
        const last = c.statements[c.statements.length - 1];
        const ends = ts.isBreakStatement(last) || ts.isReturnStatement(last) || ts.isThrowStatement(last) || ts.isContinueStatement(last) || (ts.isBlock(last) && last.statements.length && [ts.SyntaxKind.BreakStatement, ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.ThrowStatement].includes(last.statements[last.statements.length - 1].kind));
        if (!ends) fail(c, "a switch case that falls through");
        const test = group.map(g => (prim ? `${t} == ${expr(g)}` : `js_eq(${t}, ${expr(g)})`)).join(" || ");
        // `break` inside the case body exits the switch: the body is in a one-pass loop.
        const body = stmts.map(x => (ts.isBlock(x) ? block(x.statements.filter(y => !ts.isBreakStatement(y))) : stmt(x))).join("\n");
        chain.push(`if ${test} {\n${body}\n}`);
        group = [];
    }
    let text = chain.join(" else ");
    if (defaultBody) {
        const body = defaultBody.filter(x => !ts.isBreakStatement(x)).map(stmt).join("\n");
        text = chain.length ? `${text} else {\n${body}\n}` : body;
    }
    out.push(text);
    return `{\n${out.join("\n")}\n}`;
}

// --- Declarations ------------------------------------------------------------------------------------

function fnDef(name, params, body, { method = false } = {}) {
    const owner = body?.parent;
    if (owner && body) analyzeLifts(owner, name);
    const saved = { ...ctx };
    ctx.usesSelf = false;
    ctx.arrowDepth = 0;
    ctx.inFn = true;
    const pnames = [];
    const pre = [];
    params.forEach((p, i) => {
        if (ts.isIdentifier(p.name)) pnames.push(safe(p.name.text));
        else { const t = `__p${i}`; pnames.push(t); pre.push(destructure(p.name, t)); }
        if (p.initializer) pre.push(`let ${pnames[i]} = if js_is_nullish(${pnames[i]}) { ${expr(p.initializer)} } else { ${pnames[i]} };`);
    });
    let text;
    if (!body) text = "{}";
    else if (ts.isBlock(body)) text = block(body.statements, pre);
    else text = `{\n${pre.join("\n")}\n${expr(body)}\n}`;
    if (ctx.usesSelf) text = text.replace(/^\{/, "{\nlet __self = this;");
    Object.assign(ctx, saved);
    if (owner && body) emitLifted(owner);
    if (PROFILE) {
        // Profiling build: the body becomes `<name>__p`, and `<name>` times each call to it.
        const callee = method ? `this.${name}__p` : `${name}__p`;
        return `fn ${name}__p(${pnames.join(", ")}) ${text}\nfn ${name}(${pnames.join(", ")}) { let __t = prof_begin(); let __r = ${callee}(${pnames.join(", ")}); prof_end(${str(name)}, __t); __r }\n`;
    }
    return `fn ${name}(${pnames.join(", ")}) ${text}\n`;
}

function classDecl(c) {
    const name = c.name.text;
    const saved = ctx.cls;
    ctx.cls = name;
    const out = [];
    const ctor = c.members.find(ts.isConstructorDeclaration);
    const params = ctor?.parameters ?? [];
    // Field initializers, then parameter properties, then the constructor body.
    const init = [];
    for (const p of params) {
        if (p.modifiers?.some(m => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind))) {
            init.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(ts.factory.createThis(), p.name.text), ts.SyntaxKind.EqualsToken, ts.factory.createIdentifier(p.name.text))));
        }
    }
    const fieldLines = [];
    for (const m of c.members) {
        if (ts.isPropertyDeclaration(m) && !m.modifiers?.some(x => x.kind === ts.SyntaxKind.StaticKeyword) && m.initializer) {
            fieldLines.push(m);
        }
    }
    // The constructor: a fresh object, its class, its fields, then the body as a method.
    const pnames = params.map(p => safe(p.name.text));
    out.push(`fn ${name}__new(${pnames.join(", ")}) {\nlet o = obj(#{ __class: ${str(name)} });\no.${name}__init(${pnames.join(", ")});\no\n}\n`);
    {
        const savedCtx = { ...ctx };
        ctx.usesSelf = false; ctx.arrowDepth = 0; ctx.inFn = true;
        const lines = [];
        params.forEach((p, i) => { if (p.initializer) lines.push(`let ${pnames[i]} = if js_is_nullish(${pnames[i]}) { ${expr(p.initializer)} } else { ${pnames[i]} };`); });
        for (const f of fieldLines) lines.push(`this${propertyName(f.name.text)} = ${expr(f.initializer)};`);
        // Parameter properties are assigned with the field names; the parameter is in scope.
        for (const p of params) {
            if (p.modifiers?.some(m => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind))) lines.push(`this${propertyName(p.name.text)} = ${safe(p.name.text)};`);
        }
        if (ctor?.body) for (const st of ctor.body.statements) lines.push(stmt(st));
        let text = `{\n${lines.join("\n")}\n}`;
        if (ctx.usesSelf) text = text.replace(/^\{/, "{\nlet __self = this;");
        Object.assign(ctx, savedCtx);
        out.push(`fn ${name}__init(${pnames.join(", ")}) ${text}\n`);
    }
    for (const m of c.members) {
        if (ts.isMethodDeclaration(m)) out.push(fnDef(`${name}__${m.name.text}`, m.parameters, m.body, { method: true }));
        else if (ts.isGetAccessorDeclaration(m)) out.push(fnDef(`${name}__get_${m.name.text}`, [], m.body, { method: true }));
        else if (ts.isSetAccessorDeclaration(m)) out.push(fnDef(`${name}__set_${m.name.text}`, m.parameters, m.body, { method: true }));
        else if (ts.isPropertyDeclaration(m) && m.modifiers?.some(x => x.kind === ts.SyntaxKind.StaticKeyword)) fail(m, "static fields");
    }
    ctx.cls = saved;
    return out.join("\n");
}

// --- Modules -------------------------------------------------------------------------------------------

const fnOut = [];
const initOut = [];
for (const sf of order) {
    if (skipModules.has(path.resolve(sf.fileName))) continue;
    const m = modName(sf);
    fnOut.push(`// ---- ${path.basename(sf.fileName)} ----`);
    initOut.push(`// ${path.basename(sf.fileName)}`);
    for (const st of sf.statements) {
        try {
            if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) continue;
            if (ts.isFunctionDeclaration(st)) {
                const info = declInfo.get(st);
                if (!info.provided) fnOut.push(fnDef(info.name, st.parameters, st.body));
                continue;
            }
            if (ts.isClassDeclaration(st)) {
                if (!declInfo.get(st).provided) fnOut.push(classDecl(st));
                continue;
            }
            if (ts.isVariableStatement(st)) {
                for (const d of st.declarationList.declarations) {
                    const info = declInfo.get(d);
                    if (!info || info.provided || info.kind === "inline") continue;
                    if (info.kind === "fn") { fnOut.push(fnDef(info.name, info.node.parameters, info.node.body)); continue; }
                    ctx.inFn = true;
                    initOut.push(`${G(info.name)} = ${d.initializer ? expr(d.initializer) : "()"};`);
                }
                continue;
            }
            if (ts.isExpressionStatement(st) || ts.isIfStatement(st) || ts.isForOfStatement(st) || ts.isForStatement(st)) { initOut.push(stmt(st)); continue; }
            fail(st, `unsupported top-level statement (${ts.SyntaxKind[st.kind]})`);
        } catch (e) {
            if (e instanceof TranspileError) { console.error(e.message); process.exitCode = 1; continue; }
            throw e;
        }
    }
}
if (process.exitCode) process.exit(process.exitCode);

const header = `// GENERATED by scripts/ts2rhai.mjs from ${path.relative(path.dirname(rel(config.out)), rel(config.entry))} - do not edit.
// Regenerate: node scripts/ts2rhai.mjs ${path.relative(process.cwd(), configPath)}
`;
const props = [...usedProps].sort();
const text = `${header}\n${fnOut.join("\n")}\n// ---- lifted closures ----\n${liftedOut.join("\n")}\n// ---- module state ----\nfn __module_init() {\n${initOut.join("\n")}\n}\n\n// Property names read or written on objects: the host registers fast accessors for them.\nconst __OBJ_PROPS = [${props.map(str).join(", ")}];\n`;
fs.mkdirSync(path.dirname(rel(config.out)), { recursive: true });
fs.writeFileSync(rel(config.out), text);
console.log(`ts2rhai: ${order.length} modules -> ${path.relative(process.cwd(), rel(config.out))} (${text.split("\n").length} lines)`);
