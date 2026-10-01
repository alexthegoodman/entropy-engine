// sheet_model.ts - pure spreadsheet logic: cell storage, A1 addressing, and a small formula
// engine (SUM/AVERAGE/MIN/MAX/COUNT, + - * /, parentheses, cell refs and ranges). No Entropy
// calls anywhere in this file - it is what tests/sheet_model.test.ts exercises directly, and
// what sheet_addon.ts wires into Widget.sheetGrid. Recomputation is whole-sheet and stateless
// (no incremental dependency graph): call evaluateSheet(doc) fresh after any edit. That is the
// deliberate v1 tradeoff - fine at the hundreds-of-cells scale this widget targets, not at
// tens of thousands.

export interface CellAddr {
    row: number;
    col: number;
}

export interface SheetCellData {
    /** "" for empty, a plain number/text literal, or a formula starting with "=". */
    raw: string;
    /** [r, g, b, a] in 0-1, or undefined for no border. */
    border?: [number, number, number, number];
}

export interface SheetDoc {
    rows: number;
    cols: number;
    cells: Record<string, SheetCellData>;
}

export function defaultSheet(rows = 30, cols = 12): SheetDoc {
    return { rows, cols, cells: {} };
}

function splitKey(key: string): [number, number] {
    const [rowStr, colStr] = key.split(":");
    return [parseInt(rowStr, 10), parseInt(colStr, 10)];
}

/** Inserts a new, empty row at `at` (0-based) - every cell at row >= at shifts down by one,
 * and formula references across the entire sheet are adjusted accordingly. */
export function insertRow(doc: SheetDoc, at: number): SheetDoc {
    const cells: Record<string, SheetCellData> = {};
    for (const [key, data] of Object.entries(doc.cells)) {
        const [row, col] = splitKey(key);
        const newRow = row >= at ? row + 1 : row;
        const raw = adjustForInsertRow(data.raw, at);
        cells[cellKey(newRow, col)] = { ...data, raw };
    }
    return { rows: doc.rows + 1, cols: doc.cols, cells };
}

/** Deletes row `at`, dropping whatever was in it; rows after it shift up by one,
 * and formula references across the entire sheet are adjusted accordingly (references to the deleted row become #REF!).
 * Never deletes the sheet's last row. */
export function deleteRow(doc: SheetDoc, at: number): SheetDoc {
    if (doc.rows <= 1) return doc;
    const cells: Record<string, SheetCellData> = {};
    for (const [key, data] of Object.entries(doc.cells)) {
        const [row, col] = splitKey(key);
        if (row === at) continue;
        const newRow = row > at ? row - 1 : row;
        const raw = adjustForDeleteRow(data.raw, at);
        cells[cellKey(newRow, col)] = { ...data, raw };
    }
    return { rows: doc.rows - 1, cols: doc.cols, cells };
}

/** Inserts a new, empty column at `at` (0-based) - every cell at col >= at shifts right by one,
 * and formula references across the entire sheet are adjusted accordingly. */
export function insertColumn(doc: SheetDoc, at: number): SheetDoc {
    const cells: Record<string, SheetCellData> = {};
    for (const [key, data] of Object.entries(doc.cells)) {
        const [row, col] = splitKey(key);
        const newCol = col >= at ? col + 1 : col;
        const raw = adjustForInsertCol(data.raw, at);
        cells[cellKey(row, newCol)] = { ...data, raw };
    }
    return { rows: doc.rows, cols: doc.cols + 1, cells };
}

/** Deletes column `at`, dropping whatever was in it; columns after it shift left by one,
 * and formula references across the entire sheet are adjusted accordingly (references to the deleted column become #REF!).
 * Never deletes the sheet's last column. */
export function deleteColumn(doc: SheetDoc, at: number): SheetDoc {
    if (doc.cols <= 1) return doc;
    const cells: Record<string, SheetCellData> = {};
    for (const [key, data] of Object.entries(doc.cells)) {
        const [row, col] = splitKey(key);
        if (col === at) continue;
        const newCol = col > at ? col - 1 : col;
        const raw = adjustForDeleteCol(data.raw, at);
        cells[cellKey(row, newCol)] = { ...data, raw };
    }
    return { rows: doc.rows, cols: doc.cols - 1, cells };
}

export function cellKey(row: number, col: number): string {
    return `${row}:${col}`;
}

/** 0-based column index -> spreadsheet letters (0 -> "A", 25 -> "Z", 26 -> "AA"). */
export function colLetters(index: number): string {
    let n = index + 1;
    let out = "";
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

export function a1(row: number, col: number): string {
    return `${colLetters(col)}${row + 1}`;
}

export interface ParsedRef {
    row: number;
    col: number;
    absCol: boolean;
    absRow: boolean;
}

/** Parses "B12" or "$B$12" -> { row: 11, col: 1 }. Returns null for anything that isn't COLROW. */
export function parseA1(ref: string): CellAddr | null {
    const p = parseA1Detailed(ref);
    return p ? { row: p.row, col: p.col } : null;
}

/** Parses "B12", "$B12", "B$12", "$B$12" -> { row: 11, col: 1, absCol, absRow }. */
export function parseA1Detailed(ref: string): ParsedRef | null {
    const m = /^(\$?)([A-Za-z]+)(\$?)([0-9]+)$/.exec(ref.trim());
    if (!m) return null;
    let col = 0;
    for (const ch of m[2].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    const row = parseInt(m[4], 10) - 1;
    if (row < 0) return null;
    return { row, col: col - 1, absCol: m[1] === "$", absRow: m[3] === "$" };
}

export function formatRef(ref: ParsedRef): string {
    const colStr = (ref.absCol ? "$" : "") + colLetters(ref.col);
    const rowStr = (ref.absRow ? "$" : "") + (ref.row + 1);
    return `${colStr}${rowStr}`;
}

// ------------------------------------------------------------------------------------------
// Formula engine
// ------------------------------------------------------------------------------------------

export class FormulaError extends Error {}

type TokenType = "num" | "ident" | "lparen" | "rparen" | "comma" | "colon" | "plus" | "minus" | "star" | "slash" | "error" | "eof";
interface Token {
    type: TokenType;
    text: string;
    value?: number;
    start: number;
    end: number;
}

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === " " || c === "\t") {
            i++;
            continue;
        }
        if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
            let j = i;
            while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
            const text = src.slice(i, j);
            tokens.push({ type: "num", text, value: parseFloat(text), start: i, end: j });
            i = j;
            continue;
        }
        if (c === "$" || /[A-Za-z_]/.test(c)) {
            let j = i;
            while (j < src.length && (/[A-Za-z0-9_]/.test(src[j]) || src[j] === "$")) j++;
            tokens.push({ type: "ident", text: src.slice(i, j), start: i, end: j });
            i = j;
            continue;
        }
        if (c === "#") {
            let j = i + 1;
            while (j < src.length && /[A-Za-z0-9_!/?]/.test(src[j])) j++;
            tokens.push({ type: "error", text: src.slice(i, j), start: i, end: j });
            i = j;
            continue;
        }
        const single: Partial<Record<string, TokenType>> = { "(": "lparen", ")": "rparen", ",": "comma", ":": "colon", "+": "plus", "-": "minus", "*": "star", "/": "slash" };
        const kind = single[c];
        if (kind) {
            tokens.push({ type: kind, text: c, start: i, end: i + 1 });
            i++;
            continue;
        }
        throw new FormulaError(`#ERROR! unexpected "${c}"`);
    }
    tokens.push({ type: "eof", text: "", start: i, end: i });
    return tokens;
}

const FUNCTIONS = new Set(["SUM", "AVERAGE", "MIN", "MAX", "COUNT"]);
/** Functions that must error rather than silently return a meaningless value on an empty arg list. */
const NEEDS_ARGS = new Set(["AVERAGE", "MIN", "MAX"]);

class Parser {
    private pos = 0;
    constructor(private tokens: Token[], private getCell: (addr: CellAddr) => number) {}

    private peek(): Token {
        return this.tokens[this.pos];
    }
    private next(): Token {
        return this.tokens[this.pos++];
    }
    private expect(type: TokenType): Token {
        const t = this.next();
        if (t.type !== type) throw new FormulaError(`#ERROR! expected "${type}"`);
        return t;
    }

    parse(): number {
        const v = this.expr();
        this.expect("eof");
        return v;
    }

    private expr(): number {
        let v = this.term();
        for (;;) {
            if (this.peek().type === "plus") {
                this.next();
                v += this.term();
            } else if (this.peek().type === "minus") {
                this.next();
                v -= this.term();
            } else break;
        }
        return v;
    }

    private term(): number {
        let v = this.factor();
        for (;;) {
            if (this.peek().type === "star") {
                this.next();
                v *= this.factor();
            } else if (this.peek().type === "slash") {
                this.next();
                const rhs = this.factor();
                if (rhs === 0) throw new FormulaError("#DIV/0!");
                v /= rhs;
            } else break;
        }
        return v;
    }

    private factor(): number {
        const t = this.peek();
        if (t.type === "minus") {
            this.next();
            return -this.factor();
        }
        if (t.type === "plus") {
            this.next();
            return this.factor();
        }
        if (t.type === "lparen") {
            this.next();
            const v = this.expr();
            this.expect("rparen");
            return v;
        }
        if (t.type === "num") {
            this.next();
            return t.value!;
        }
        if (t.type === "error") {
            this.next();
            throw new FormulaError(t.text);
        }
        if (t.type === "ident") return this.identifier();
        throw new FormulaError(`#ERROR! unexpected "${t.text || "end"}"`);
    }

    private identifier(): number {
        const name = this.next().text;
        const upper = name.toUpperCase();
        if (this.peek().type === "lparen" && FUNCTIONS.has(upper)) {
            this.next();
            const values = this.args();
            this.expect("rparen");
            return this.applyFn(upper, values);
        }
        const addr = parseA1(name);
        if (!addr) throw new FormulaError(`#REF! bad reference "${name}"`);
        return this.getCell(addr);
    }

    /** A comma-separated argument list; each argument is a range (expanded to every cell's
     * value) or a plain expression. */
    private args(): number[] {
        const values: number[] = [];
        if (this.peek().type === "rparen") return values;
        for (;;) {
            values.push(...this.arg());
            if (this.peek().type === "comma") {
                this.next();
                continue;
            }
            break;
        }
        return values;
    }

    private arg(): number[] {
        if (this.peek().type === "ident") {
            const save = this.pos;
            const name = this.next().text;
            if (this.peek().type === "colon") {
                this.next();
                if (this.peek().type === "error") {
                    const err = this.next().text;
                    throw new FormulaError(err);
                }
                const endName = this.expect("ident").text;
                const start = parseA1(name);
                const end = parseA1(endName);
                if (!start || !end) throw new FormulaError(`#REF! bad range "${name}:${endName}"`);
                return this.expandRange(start, end);
            }
            this.pos = save;
        }
        return [this.expr()];
    }

    private expandRange(a: CellAddr, b: CellAddr): number[] {
        const out: number[] = [];
        const r0 = Math.min(a.row, b.row);
        const r1 = Math.max(a.row, b.row);
        const c0 = Math.min(a.col, b.col);
        const c1 = Math.max(a.col, b.col);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(this.getCell({ row: r, col: c }));
        return out;
    }

    private applyFn(name: string, values: number[]): number {
        if (values.length === 0 && NEEDS_ARGS.has(name)) throw new FormulaError(`#ERROR! ${name}() needs a value`);
        switch (name) {
            case "SUM":
                return values.reduce((a, b) => a + b, 0);
            case "AVERAGE":
                return values.reduce((a, b) => a + b, 0) / values.length;
            case "MIN":
                return Math.min(...values);
            case "MAX":
                return Math.max(...values);
            case "COUNT":
                return values.length;
            default:
                throw new FormulaError(`#ERROR! unknown function ${name}`);
        }
    }
}

// ------------------------------------------------------------------------------------------
// Formula reference adjustment
// ------------------------------------------------------------------------------------------

export interface FormulaAdjuster {
    adjustRef: (ref: ParsedRef) => ParsedRef | null;
    adjustRange: (start: ParsedRef, end: ParsedRef) => { start: ParsedRef; end: ParsedRef } | null;
}

export function rewriteFormula(raw: string, adjuster: FormulaAdjuster): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("=")) return raw;
    const eqIdx = raw.indexOf("=");
    const expr = raw.slice(eqIdx + 1);

    let tokens: Token[];
    try {
        tokens = tokenize(expr);
    } catch {
        return raw;
    }

    const replacements: { start: number; end: number; replacement: string }[] = [];

    let i = 0;
    while (i < tokens.length) {
        const t = tokens[i];
        if (t.type === "eof") break;

        // Check for range: ident : ident
        if (
            t.type === "ident" &&
            i + 2 < tokens.length &&
            tokens[i + 1].type === "colon" &&
            tokens[i + 2].type === "ident"
        ) {
            const startRef = parseA1Detailed(t.text);
            const endRef = parseA1Detailed(tokens[i + 2].text);
            if (startRef && endRef) {
                const adj = adjuster.adjustRange(startRef, endRef);
                const replacement = adj ? `${formatRef(adj.start)}:${formatRef(adj.end)}` : "#REF!";
                replacements.push({
                    start: t.start,
                    end: tokens[i + 2].end,
                    replacement,
                });
                i += 3;
                continue;
            }
        }

        // Check for single cell reference: ident NOT followed by '('
        if (t.type === "ident") {
            const isCall = i + 1 < tokens.length && tokens[i + 1].type === "lparen";
            if (!isCall) {
                const ref = parseA1Detailed(t.text);
                if (ref) {
                    const adj = adjuster.adjustRef(ref);
                    const replacement = adj ? formatRef(adj) : "#REF!";
                    replacements.push({
                        start: t.start,
                        end: t.end,
                        replacement,
                    });
                }
            }
        }

        i++;
    }

    replacements.sort((a, b) => b.start - a.start);
    let newExpr = expr;
    for (const r of replacements) {
        newExpr = newExpr.slice(0, r.start) + r.replacement + newExpr.slice(r.end);
    }

    return raw.slice(0, eqIdx + 1) + newExpr;
}

export function adjustForInsertRow(raw: string, at: number): string {
    return rewriteFormula(raw, {
        adjustRef: (ref) => {
            if (ref.row >= at) return { ...ref, row: ref.row + 1 };
            return ref;
        },
        adjustRange: (start, end) => {
            const rMin = Math.min(start.row, end.row);
            const rMax = Math.max(start.row, end.row);
            if (at <= rMin) {
                return {
                    start: { ...start, row: start.row + 1 },
                    end: { ...end, row: end.row + 1 },
                };
            }
            if (rMin < at && at <= rMax) {
                return {
                    start: { ...start, row: start.row > end.row ? start.row + 1 : start.row },
                    end: { ...end, row: end.row >= start.row ? end.row + 1 : end.row },
                };
            }
            return { start, end };
        }
    });
}

export function adjustForDeleteRow(raw: string, at: number): string {
    return rewriteFormula(raw, {
        adjustRef: (ref) => {
            if (ref.row === at) return null;
            if (ref.row > at) return { ...ref, row: ref.row - 1 };
            return ref;
        },
        adjustRange: (start, end) => {
            if (start.row === at || end.row === at) return null;
            const rMin = Math.min(start.row, end.row);
            const rMax = Math.max(start.row, end.row);
            if (at < rMin) {
                return {
                    start: { ...start, row: start.row - 1 },
                    end: { ...end, row: end.row - 1 },
                };
            }
            if (rMin < at && at < rMax) {
                return {
                    start: { ...start, row: start.row > end.row ? start.row - 1 : start.row },
                    end: { ...end, row: end.row > start.row ? end.row - 1 : end.row },
                };
            }
            return { start, end };
        }
    });
}

export function adjustForInsertCol(raw: string, at: number): string {
    return rewriteFormula(raw, {
        adjustRef: (ref) => {
            if (ref.col >= at) return { ...ref, col: ref.col + 1 };
            return ref;
        },
        adjustRange: (start, end) => {
            const cMin = Math.min(start.col, end.col);
            const cMax = Math.max(start.col, end.col);
            if (at <= cMin) {
                return {
                    start: { ...start, col: start.col + 1 },
                    end: { ...end, col: end.col + 1 },
                };
            }
            if (cMin < at && at <= cMax) {
                return {
                    start: { ...start, col: start.col > end.col ? start.col + 1 : start.col },
                    end: { ...end, col: end.col >= start.col ? end.col + 1 : end.col },
                };
            }
            return { start, end };
        }
    });
}

export function adjustForDeleteCol(raw: string, at: number): string {
    return rewriteFormula(raw, {
        adjustRef: (ref) => {
            if (ref.col === at) return null;
            if (ref.col > at) return { ...ref, col: ref.col - 1 };
            return ref;
        },
        adjustRange: (start, end) => {
            if (start.col === at || end.col === at) return null;
            const cMin = Math.min(start.col, end.col);
            const cMax = Math.max(start.col, end.col);
            if (at < cMin) {
                return {
                    start: { ...start, col: start.col - 1 },
                    end: { ...end, col: end.col - 1 },
                };
            }
            if (cMin < at && at < cMax) {
                return {
                    start: { ...start, col: start.col > end.col ? start.col - 1 : start.col },
                    end: { ...end, col: end.col > start.col ? end.col - 1 : end.col },
                };
            }
            return { start, end };
        }
    });
}

export function adjustFormulaForPaste(raw: string, src: CellAddr, dst: CellAddr): string {
    const dRow = dst.row - src.row;
    const dCol = dst.col - src.col;
    if (dRow === 0 && dCol === 0) return raw;

    const adjustOne = (ref: ParsedRef): ParsedRef | null => {
        const newRow = ref.absRow ? ref.row : ref.row + dRow;
        const newCol = ref.absCol ? ref.col : ref.col + dCol;
        if (newRow < 0 || newCol < 0) return null;
        return { ...ref, row: newRow, col: newCol };
    };

    return rewriteFormula(raw, {
        adjustRef: adjustOne,
        adjustRange: (start, end) => {
            const newStart = adjustOne(start);
            const newEnd = adjustOne(end);
            if (!newStart || !newEnd) return null;
            return { start: newStart, end: newEnd };
        }
    });
}

// ------------------------------------------------------------------------------------------
// Whole-sheet evaluation
// ------------------------------------------------------------------------------------------

export interface CellValue {
    text: string;
    numeric: boolean;
    error: boolean;
}

function formatNumber(n: number): string {
    if (!Number.isFinite(n)) return "#ERROR!";
    // Round away float noise (0.1 + 0.2) without truncating a deliberately precise value.
    const rounded = Math.round(n * 1e6) / 1e6;
    return String(rounded);
}

/** Recomputes every non-empty cell's display text, resolving formulas (with cycle detection)
 * against every other cell in `doc`. An empty cell referenced numerically is 0, like a real
 * spreadsheet; a text cell referenced numerically is `#VALUE!`. */
export function evaluateSheet(doc: SheetDoc): Map<string, CellValue> {
    const results = new Map<string, CellValue>();
    const visiting = new Set<string>();
    const numericCache = new Map<string, number>();

    const computeCellNumeric = (raw: string): number => {
        const trimmed = raw.trim();
        if (trimmed.startsWith("=")) {
            const tokens = tokenize(trimmed.slice(1));
            return new Parser(tokens, resolveNumeric).parse();
        }
        const n = Number(trimmed);
        if (Number.isNaN(n)) throw new FormulaError("#VALUE!");
        return n;
    };

    function resolveNumeric(addr: CellAddr): number {
        const key = cellKey(addr.row, addr.col);
        const cached = numericCache.get(key);
        if (cached !== undefined) return cached;
        const data = doc.cells[key];
        if (!data || data.raw.trim() === "") {
            numericCache.set(key, 0);
            return 0;
        }
        if (visiting.has(key)) throw new FormulaError("#CYCLE!");
        visiting.add(key);
        try {
            const value = computeCellNumeric(data.raw);
            numericCache.set(key, value);
            return value;
        } finally {
            visiting.delete(key);
        }
    }

    for (let row = 0; row < doc.rows; row++) {
        for (let col = 0; col < doc.cols; col++) {
            const key = cellKey(row, col);
            const data = doc.cells[key];
            if (!data || data.raw.trim() === "") continue;
            const raw = data.raw.trim();
            if (raw.startsWith("=")) {
                try {
                    const value = resolveNumeric({ row, col });
                    results.set(key, { text: formatNumber(value), numeric: true, error: false });
                } catch (e) {
                    const msg = e instanceof FormulaError ? e.message : "#ERROR!";
                    results.set(key, { text: msg, numeric: false, error: true });
                }
            } else {
                const n = Number(raw);
                const isNumeric = !Number.isNaN(n);
                results.set(key, { text: isNumeric ? formatNumber(n) : raw, numeric: isNumeric, error: false });
            }
        }
    }

    return results;
}
