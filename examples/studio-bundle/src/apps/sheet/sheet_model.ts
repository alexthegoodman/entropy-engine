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

export interface SheetRange {
    start: CellAddr;
    end: CellAddr;
}

export type NumberFormatType = "general" | "currency" | "percent" | "decimal" | "integer";

export interface CellFormat {
    type: NumberFormatType;
    /** Number of decimal places (default 2 for currency, percent, decimal; 0 for integer). */
    decimals?: number;
    /** Currency symbol prefix (default "$"). */
    symbol?: string;
}

export interface ClipboardCell {
    dRow: number;
    dCol: number;
    raw: string;
    border?: [number, number, number, number];
    format?: CellFormat;
    source: CellAddr;
}

export interface SheetClipboard {
    rows: number;
    cols: number;
    cells: ClipboardCell[];
    isCut?: boolean;
    sourceRange?: SheetRange;
}

export interface SheetCellData {
    /** "" for empty, a plain number/text literal, or a formula starting with "=". */
    raw: string;
    /** [r, g, b, a] in 0-1, or undefined for no border. */
    border?: [number, number, number, number];
    /** Formatting for numeric values. */
    format?: CellFormat;
}

export interface SheetDoc {
    rows: number;
    cols: number;
    cells: Record<string, SheetCellData>;
    /** Custom column widths in pixels (0-based column index to width). */
    colWidths?: Record<number, number>;
}

export function defaultSheet(rows = 30, cols = 12): SheetDoc {
    return { rows, cols, cells: {} };
}

function splitKey(key: string): [number, number] {
    const [rowStr, colStr] = key.split(":");
    return [parseInt(rowStr, 10), parseInt(colStr, 10)];
}

/** Sets the width in pixels for column `col` (0-based index). */
export function setColumnWidth(doc: SheetDoc, col: number, width: number): SheetDoc {
    const colWidths = { ...(doc.colWidths ?? {}) };
    colWidths[col] = width;
    return { ...doc, colWidths };
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
    return { rows: doc.rows + 1, cols: doc.cols, cells, colWidths: doc.colWidths };
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
    return { rows: doc.rows - 1, cols: doc.cols, cells, colWidths: doc.colWidths };
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
    let colWidths: Record<number, number> | undefined;
    if (doc.colWidths) {
        colWidths = {};
        for (const [colStr, w] of Object.entries(doc.colWidths)) {
            const col = parseInt(colStr, 10);
            const newCol = col >= at ? col + 1 : col;
            colWidths[newCol] = w;
        }
    }
    return { rows: doc.rows, cols: doc.cols + 1, cells, colWidths };
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
    let colWidths: Record<number, number> | undefined;
    if (doc.colWidths) {
        colWidths = {};
        for (const [colStr, w] of Object.entries(doc.colWidths)) {
            const col = parseInt(colStr, 10);
            if (col === at) continue;
            const newCol = col > at ? col - 1 : col;
            colWidths[newCol] = w;
        }
    }
    return { rows: doc.rows, cols: doc.cols - 1, cells, colWidths };
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

/** Parses "A1:B10" or "A1" into a SheetRange, or null if invalid. */
export function parseRangeA1(ref: string): SheetRange | null {
    const parts = ref.split(":");
    if (parts.length === 1) {
        const addr = parseA1(parts[0].trim());
        if (!addr) return null;
        return { start: addr, end: addr };
    }
    if (parts.length === 2) {
        const start = parseA1(parts[0].trim());
        const end = parseA1(parts[1].trim());
        if (!start || !end) return null;
        return { start, end };
    }
    return null;
}

// ------------------------------------------------------------------------------------------
// Formula engine
// ------------------------------------------------------------------------------------------

export class FormulaError extends Error {}

type TokenType =
    | "num"
    | "str"
    | "ident"
    | "lparen"
    | "rparen"
    | "comma"
    | "colon"
    | "plus"
    | "minus"
    | "star"
    | "slash"
    | "concat"
    | "eq"
    | "neq"
    | "lt"
    | "lte"
    | "gt"
    | "gte"
    | "error"
    | "eof";

interface Token {
    type: TokenType;
    text: string;
    value?: number;
    strValue?: string;
    start: number;
    end: number;
}

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === " " || c === "\t" || c === "\r" || c === "\n") {
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
        if (c === '"') {
            let j = i + 1;
            let s = "";
            let closed = false;
            while (j < src.length) {
                if (src[j] === '"') {
                    if (j + 1 < src.length && src[j + 1] === '"') {
                        s += '"';
                        j += 2;
                        continue;
                    }
                    closed = true;
                    j++;
                    break;
                }
                if (src[j] === "\\" && j + 1 < src.length) {
                    s += src[j + 1];
                    j += 2;
                    continue;
                }
                s += src[j];
                j++;
            }
            if (!closed) throw new FormulaError("#ERROR! unclosed string literal");
            tokens.push({ type: "str", text: src.slice(i, j), strValue: s, start: i, end: j });
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
        if (c === "<") {
            if (src[i + 1] === ">") {
                tokens.push({ type: "neq", text: "<>", start: i, end: i + 2 });
                i += 2;
                continue;
            }
            if (src[i + 1] === "=") {
                tokens.push({ type: "lte", text: "<=", start: i, end: i + 2 });
                i += 2;
                continue;
            }
            tokens.push({ type: "lt", text: "<", start: i, end: i + 1 });
            i++;
            continue;
        }
        if (c === ">") {
            if (src[i + 1] === "=") {
                tokens.push({ type: "gte", text: ">=", start: i, end: i + 2 });
                i += 2;
                continue;
            }
            tokens.push({ type: "gt", text: ">", start: i, end: i + 1 });
            i++;
            continue;
        }
        if (c === "=") {
            tokens.push({ type: "eq", text: "=", start: i, end: i + 1 });
            i++;
            continue;
        }
        if (c === "&") {
            tokens.push({ type: "concat", text: "&", start: i, end: i + 1 });
            i++;
            continue;
        }
        const single: Partial<Record<string, TokenType>> = {
            "(": "lparen",
            ")": "rparen",
            ",": "comma",
            ":": "colon",
            "+": "plus",
            "-": "minus",
            "*": "star",
            "/": "slash",
        };
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

export const EMPTY_CELL = Symbol("empty");
export type FormulaValue = number | string | boolean | typeof EMPTY_CELL;

export function toNumber(v: FormulaValue): number {
    if (v === EMPTY_CELL) return 0;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
        const trimmed = v.trim();
        if (trimmed === "") return 0;
        const n = Number(trimmed);
        if (Number.isNaN(n)) throw new FormulaError("#VALUE!");
        return n;
    }
    throw new FormulaError("#VALUE!");
}

export function toBoolean(v: FormulaValue): boolean {
    if (v === EMPTY_CELL) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
        const upper = v.trim().toUpperCase();
        if (upper === "TRUE") return true;
        if (upper === "FALSE" || upper === "") return false;
        const n = Number(v);
        if (!Number.isNaN(n)) return n !== 0;
        throw new FormulaError("#VALUE!");
    }
    return false;
}

export function toStringVal(v: FormulaValue): string {
    if (v === EMPTY_CELL) return "";
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number") return formatNumber(v);
    return "";
}

function areEqual(a: FormulaValue, b: FormulaValue): boolean {
    if (a === EMPTY_CELL && b === EMPTY_CELL) return true;
    if (a === EMPTY_CELL) return typeof b === "string" ? b === "" : typeof b === "number" ? b === 0 : false;
    if (b === EMPTY_CELL) return typeof a === "string" ? a === "" : typeof a === "number" ? a === 0 : false;
    if (typeof a === "string" && typeof b === "string") {
        return a.toLowerCase() === b.toLowerCase();
    }
    return a === b;
}

function compareValues(a: FormulaValue, b: FormulaValue): number {
    const valA = a === EMPTY_CELL ? (typeof b === "string" ? "" : 0) : a;
    const valB = b === EMPTY_CELL ? (typeof a === "string" ? "" : 0) : b;
    if (typeof valA === "number" && typeof valB === "number") {
        return valA === valB ? 0 : valA < valB ? -1 : 1;
    }
    if (typeof valA === "string" && typeof valB === "string") {
        const la = valA.toLowerCase();
        const lb = valB.toLowerCase();
        return la === lb ? 0 : la < lb ? -1 : 1;
    }
    if (typeof valA === "boolean" && typeof valB === "boolean") {
        return valA === valB ? 0 : !valA && valB ? -1 : 1;
    }
    const typeRank = (x: FormulaValue) => (typeof x === "number" ? 1 : typeof x === "string" ? 2 : 3);
    return typeRank(valA) < typeRank(valB) ? -1 : 1;
}

const FUNCTIONS = new Set([
    "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA",
    "IF", "AND", "OR", "NOT", "TRUE", "FALSE",
    "CONCAT", "CONCATENATE", "LEN", "UPPER", "LOWER", "TRIM", "LEFT", "RIGHT", "MID",
    "ROUND", "ABS", "SQRT", "MOD", "POWER",
    "TEXT"
]);

/** Functions that must error rather than silently return a meaningless value on an empty arg list. */
const NEEDS_ARGS = new Set([
    "AVERAGE", "MIN", "MAX", "LEN", "UPPER", "LOWER", "TRIM", "LEFT", "RIGHT", "MID",
    "ROUND", "ABS", "SQRT", "MOD", "POWER", "AND", "OR", "NOT", "TEXT"
]);

class Parser {
    private pos = 0;
    private evaluating = true;

    constructor(private tokens: Token[], private getCell: (addr: CellAddr) => FormulaValue) {}

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

    parse(): FormulaValue {
        const v = this.comparison();
        this.expect("eof");
        return v;
    }

    private comparison(): FormulaValue {
        let v = this.concat();
        for (;;) {
            const t = this.peek();
            if (t.type === "eq") {
                this.next();
                const rhs = this.concat();
                if (this.evaluating) v = areEqual(v, rhs);
            } else if (t.type === "neq") {
                this.next();
                const rhs = this.concat();
                if (this.evaluating) v = !areEqual(v, rhs);
            } else if (t.type === "lt") {
                this.next();
                const rhs = this.concat();
                if (this.evaluating) v = compareValues(v, rhs) < 0;
            } else if (t.type === "lte") {
                this.next();
                const rhs = this.concat();
                if (this.evaluating) v = compareValues(v, rhs) <= 0;
            } else if (t.type === "gt") {
                this.next();
                const rhs = this.concat();
                if (this.evaluating) v = compareValues(v, rhs) > 0;
            } else if (t.type === "gte") {
                this.next();
                const rhs = this.concat();
                if (this.evaluating) v = compareValues(v, rhs) >= 0;
            } else break;
        }
        return v;
    }

    private concat(): FormulaValue {
        let v = this.additive();
        while (this.peek().type === "concat") {
            this.next();
            const rhs = this.additive();
            if (this.evaluating) {
                v = toStringVal(v) + toStringVal(rhs);
            }
        }
        return v;
    }

    private additive(): FormulaValue {
        let v = this.multiplicative();
        for (;;) {
            if (this.peek().type === "plus") {
                this.next();
                const rhs = this.multiplicative();
                if (this.evaluating) v = toNumber(v) + toNumber(rhs);
            } else if (this.peek().type === "minus") {
                this.next();
                const rhs = this.multiplicative();
                if (this.evaluating) v = toNumber(v) - toNumber(rhs);
            } else break;
        }
        return v;
    }

    private multiplicative(): FormulaValue {
        let v = this.factor();
        for (;;) {
            if (this.peek().type === "star") {
                this.next();
                const rhs = this.factor();
                if (this.evaluating) v = toNumber(v) * toNumber(rhs);
            } else if (this.peek().type === "slash") {
                this.next();
                const rhs = this.factor();
                if (this.evaluating) {
                    const r = toNumber(rhs);
                    if (r === 0) throw new FormulaError("#DIV/0!");
                    v = toNumber(v) / r;
                }
            } else break;
        }
        return v;
    }

    private factor(): FormulaValue {
        const t = this.peek();
        if (t.type === "minus") {
            this.next();
            const f = this.factor();
            return this.evaluating ? -toNumber(f) : 0;
        }
        if (t.type === "plus") {
            this.next();
            const f = this.factor();
            return this.evaluating ? toNumber(f) : 0;
        }
        if (t.type === "lparen") {
            this.next();
            const v = this.comparison();
            this.expect("rparen");
            return v;
        }
        if (t.type === "num") {
            this.next();
            return t.value!;
        }
        if (t.type === "str") {
            this.next();
            return t.strValue!;
        }
        if (t.type === "error") {
            this.next();
            if (this.evaluating) throw new FormulaError(t.text);
            return 0;
        }
        if (t.type === "ident") return this.identifier();
        throw new FormulaError(`#ERROR! unexpected "${t.text || "end"}"`);
    }

    private identifier(): FormulaValue {
        const name = this.next().text;
        const upper = name.toUpperCase();
        if (upper === "TRUE" && this.peek().type !== "lparen") return true;
        if (upper === "FALSE" && this.peek().type !== "lparen") return false;

        if (this.peek().type === "lparen") {
            this.next();
            return this.callFunction(upper);
        }
        const addr = parseA1(name);
        if (!addr) throw new FormulaError(`#REF! bad reference "${name}"`);
        if (!this.evaluating) return 0;
        return this.getCell(addr);
    }

    private callFunction(name: string): FormulaValue {
        if (name === "IF") {
            return this.callIf();
        }

        const values = this.args();
        this.expect("rparen");
        if (!this.evaluating) return 0;
        return this.applyFn(name, values);
    }

    private callIf(): FormulaValue {
        const cond = this.comparison();
        this.expect("comma");

        let result: FormulaValue = false;
        const wasEvaluating = this.evaluating;

        if (!wasEvaluating) {
            this.comparison();
            if (this.peek().type === "comma") {
                this.next();
                this.comparison();
            }
            this.expect("rparen");
            return 0;
        }

        const isTrue = toBoolean(cond);
        if (isTrue) {
            result = this.comparison();
            if (this.peek().type === "comma") {
                this.next();
                this.evaluating = false;
                this.comparison();
                this.evaluating = true;
            }
        } else {
            this.evaluating = false;
            this.comparison();
            this.evaluating = true;
            if (this.peek().type === "comma") {
                this.next();
                result = this.comparison();
            } else {
                result = false;
            }
        }
        this.expect("rparen");
        return result;
    }

    /** A comma-separated argument list; each argument is a range (expanded to every cell's
     * value) or a plain expression. */
    private args(): FormulaValue[] {
        const values: FormulaValue[] = [];
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

    private arg(): FormulaValue[] {
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
        return [this.comparison()];
    }

    private expandRange(a: CellAddr, b: CellAddr): FormulaValue[] {
        if (!this.evaluating) return [];
        return expandRange(a, b).map((c) => this.getCell(c));
    }

    private applyFn(name: string, values: FormulaValue[]): FormulaValue {
        if (values.length === 0 && NEEDS_ARGS.has(name)) {
            throw new FormulaError(`#ERROR! ${name}() needs a value`);
        }
        switch (name) {
            case "SUM": {
                let sum = 0;
                for (const v of values) {
                    if (typeof v === "number") sum += v;
                    else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
                        sum += Number(v);
                    }
                }
                return sum;
            }
            case "AVERAGE": {
                let sum = 0;
                let count = 0;
                for (const v of values) {
                    if (typeof v === "number") {
                        sum += v;
                        count++;
                    } else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
                        sum += Number(v);
                        count++;
                    }
                }
                if (count === 0) throw new FormulaError("#DIV/0!");
                return sum / count;
            }
            case "MIN": {
                const nums: number[] = [];
                for (const v of values) {
                    if (typeof v === "number") nums.push(v);
                    else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
                        nums.push(Number(v));
                    }
                }
                if (nums.length === 0) throw new FormulaError("#ERROR! MIN() needs a value");
                return Math.min(...nums);
            }
            case "MAX": {
                const nums: number[] = [];
                for (const v of values) {
                    if (typeof v === "number") nums.push(v);
                    else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
                        nums.push(Number(v));
                    }
                }
                if (nums.length === 0) throw new FormulaError("#ERROR! MAX() needs a value");
                return Math.max(...nums);
            }
            case "COUNT": {
                return values.length;
            }
            case "COUNTA": {
                let count = 0;
                for (const v of values) {
                    if (v !== EMPTY_CELL && v !== "") count++;
                }
                return count;
            }
            case "ROUND": {
                const n = toNumber(values[0]);
                const d = values.length > 1 ? toNumber(values[1]) : 0;
                const factor = Math.pow(10, d);
                return Math.round(n * factor) / factor;
            }
            case "ABS": {
                return Math.abs(toNumber(values[0]));
            }
            case "SQRT": {
                const n = toNumber(values[0]);
                if (n < 0) throw new FormulaError("#NUM!");
                return Math.sqrt(n);
            }
            case "MOD": {
                if (values.length < 2) throw new FormulaError("#ERROR! MOD() needs 2 arguments");
                const n = toNumber(values[0]);
                const d = toNumber(values[1]);
                if (d === 0) throw new FormulaError("#DIV/0!");
                return ((n % d) + d) % d;
            }
            case "POWER": {
                if (values.length < 2) throw new FormulaError("#ERROR! POWER() needs 2 arguments");
                return Math.pow(toNumber(values[0]), toNumber(values[1]));
            }
            case "CONCAT":
            case "CONCATENATE": {
                return values.map(toStringVal).join("");
            }
            case "LEN": {
                return toStringVal(values[0]).length;
            }
            case "UPPER": {
                return toStringVal(values[0]).toUpperCase();
            }
            case "LOWER": {
                return toStringVal(values[0]).toLowerCase();
            }
            case "TRIM": {
                return toStringVal(values[0]).trim();
            }
            case "LEFT": {
                const s = toStringVal(values[0]);
                const cnt = values.length > 1 ? Math.max(0, Math.floor(toNumber(values[1]))) : 1;
                return s.slice(0, cnt);
            }
            case "RIGHT": {
                const s = toStringVal(values[0]);
                const cnt = values.length > 1 ? Math.max(0, Math.floor(toNumber(values[1]))) : 1;
                return cnt === 0 ? "" : s.slice(-cnt);
            }
            case "MID": {
                if (values.length < 3) throw new FormulaError("#ERROR! MID() needs 3 arguments");
                const s = toStringVal(values[0]);
                const start = Math.max(1, Math.floor(toNumber(values[1])));
                const cnt = Math.max(0, Math.floor(toNumber(values[2])));
                return s.slice(start - 1, start - 1 + cnt);
            }
            case "AND": {
                for (const v of values) {
                    if (!toBoolean(v)) return false;
                }
                return true;
            }
            case "OR": {
                for (const v of values) {
                    if (toBoolean(v)) return true;
                }
                return false;
            }
            case "NOT": {
                return !toBoolean(values[0]);
            }
            case "TRUE": {
                return true;
            }
            case "FALSE": {
                return false;
            }
            case "TEXT": {
                if (values.length < 2) throw new FormulaError("#ERROR! TEXT() needs value and format");
                return formatCellValue(values[0], toStringVal(values[1]) as any);
            }
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

/** 0-based range -> A1-notation range ("A1", "A1:B3"). */
export function rangeA1(start: CellAddr, end: CellAddr): string {
    const minRow = Math.min(start.row, end.row);
    const maxRow = Math.max(start.row, end.row);
    const minCol = Math.min(start.col, end.col);
    const maxCol = Math.max(start.col, end.col);
    if (minRow === maxRow && minCol === maxCol) {
        return a1(minRow, minCol);
    }
    return `${a1(minRow, minCol)}:${a1(maxRow, maxCol)}`;
}

/** Returns all cell addresses within the bounding rectangle of `a` and `b` in row-major order. */
export function expandRange(a: CellAddr, b: CellAddr): CellAddr[] {
    const out: CellAddr[] = [];
    const r0 = Math.min(a.row, b.row);
    const r1 = Math.max(a.row, b.row);
    const c0 = Math.min(a.col, b.col);
    const c1 = Math.max(a.col, b.col);
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            out.push({ row: r, col: c });
        }
    }
    return out;
}

/** Copies a cell range into a clipboard representation. */
export function copyRange(doc: SheetDoc, range: SheetRange, isCut = false): SheetClipboard {
    const minRow = Math.min(range.start.row, range.end.row);
    const maxRow = Math.max(range.start.row, range.end.row);
    const minCol = Math.min(range.start.col, range.end.col);
    const maxCol = Math.max(range.start.col, range.end.col);
    const rows = maxRow - minRow + 1;
    const cols = maxCol - minCol + 1;
    const cells: ClipboardCell[] = [];

    for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
            const data = doc.cells[cellKey(r, c)];
            cells.push({
                dRow: r - minRow,
                dCol: c - minCol,
                raw: data?.raw ?? "",
                border: data?.border,
                format: data?.format,
                source: { row: r, col: c },
            });
        }
    }

    return {
        rows,
        cols,
        cells,
        isCut,
        sourceRange: { start: { ...range.start }, end: { ...range.end } },
    };
}

/** Clears content (raw text) of all cells in `range`. If `clearBorders` is true, borders are also removed.
 * If `clearFormats` is true, formats are also removed. */
export function clearRange(doc: SheetDoc, range: SheetRange, clearBorders = false, clearFormats = false): SheetDoc {
    const cells: Record<string, SheetCellData> = { ...doc.cells };
    for (const addr of expandRange(range.start, range.end)) {
        const key = cellKey(addr.row, addr.col);
        const existing = cells[key];
        if (existing) {
            const border = clearBorders ? undefined : existing.border;
            const format = clearFormats ? undefined : existing.format;
            if (!border && !format) {
                delete cells[key];
            } else {
                cells[key] = { raw: "", border, format };
            }
        }
    }
    return { ...doc, cells };
}

/** Sets or clears borders across all cells in `range`. */
export function setRangeBorder(doc: SheetDoc, range: SheetRange, border?: [number, number, number, number]): SheetDoc {
    const cells: Record<string, SheetCellData> = { ...doc.cells };
    for (const addr of expandRange(range.start, range.end)) {
        const key = cellKey(addr.row, addr.col);
        const existing = cells[key];
        if (!border && (!existing || (existing.raw.trim() === "" && !existing.format))) {
            delete cells[key];
        } else {
            cells[key] = { raw: existing?.raw ?? "", border, format: existing?.format };
        }
    }
    return { ...doc, cells };
}

/** Sets or clears number formatting across all cells in `range`. */
export function setRangeFormat(doc: SheetDoc, range: SheetRange, format?: CellFormat): SheetDoc {
    const cells: Record<string, SheetCellData> = { ...doc.cells };
    for (const addr of expandRange(range.start, range.end)) {
        const key = cellKey(addr.row, addr.col);
        const existing = cells[key];
        if (!format && (!existing || (existing.raw.trim() === "" && !existing.border))) {
            delete cells[key];
        } else {
            cells[key] = { raw: existing?.raw ?? "", border: existing?.border, format };
        }
    }
    return { ...doc, cells };
}

/** Pastes clipboard data into the document at destination `dst`.
 * - If clipboard has 1 cell and destination is a multi-cell range: fills the entire destination range.
 * - Otherwise: pastes clipboard cells offset from destination's top-left corner.
 * - When `!clipboard.isCut`, formulas are adjusted relative to their movement.
 */
export function pasteRange(doc: SheetDoc, clipboard: SheetClipboard, dst: SheetRange): SheetDoc {
    const cells: Record<string, SheetCellData> = { ...doc.cells };
    const dstMinRow = Math.min(dst.start.row, dst.end.row);
    const dstMaxRow = Math.max(dst.start.row, dst.end.row);
    const dstMinCol = Math.min(dst.start.col, dst.end.col);
    const dstMaxCol = Math.max(dst.start.col, dst.end.col);

    const isDstRange = dstMinRow !== dstMaxRow || dstMinCol !== dstMaxCol;

    if (clipboard.rows === 1 && clipboard.cols === 1 && isDstRange) {
        // Single cell copied, pasting into a multi-cell range -> fill all destination cells
        const srcCell = clipboard.cells[0];
        for (let r = dstMinRow; r <= dstMaxRow; r++) {
            for (let c = dstMinCol; c <= dstMaxCol; c++) {
                if (r >= doc.rows || c >= doc.cols) continue;
                const targetAddr: CellAddr = { row: r, col: c };
                const raw = (!clipboard.isCut && srcCell.source)
                    ? adjustFormulaForPaste(srcCell.raw, srcCell.source, targetAddr)
                    : srcCell.raw;
                const key = cellKey(r, c);
                if (raw.trim() === "" && !srcCell.border && !srcCell.format) {
                    delete cells[key];
                } else {
                    cells[key] = { raw, border: srcCell.border, format: srcCell.format };
                }
            }
        }
    } else {
        // Multi-cell clipboard (or 1x1 into 1x1): paste starting from top-left of destination
        for (const item of clipboard.cells) {
            const targetRow = dstMinRow + item.dRow;
            const targetCol = dstMinCol + item.dCol;
            if (targetRow >= doc.rows || targetCol >= doc.cols) continue;

            const targetAddr: CellAddr = { row: targetRow, col: targetCol };
            const raw = (!clipboard.isCut && item.source)
                ? adjustFormulaForPaste(item.raw, item.source, targetAddr)
                : item.raw;
            const key = cellKey(targetRow, targetCol);
            if (raw.trim() === "" && !item.border && !item.format) {
                delete cells[key];
            } else {
                cells[key] = { raw, border: item.border, format: item.format };
            }
        }
    }

    return { ...doc, cells };
}

/** Standard spreadsheet Fill-Down (Ctrl+D): takes the top row of `range` and fills downward
 * across each column, adjusting formula references row by row. */
export function fillDown(doc: SheetDoc, range: SheetRange): SheetDoc {
    const minRow = Math.min(range.start.row, range.end.row);
    const maxRow = Math.max(range.start.row, range.end.row);
    const minCol = Math.min(range.start.col, range.end.col);
    const maxCol = Math.max(range.start.col, range.end.col);

    if (minRow === maxRow) return doc; // Only one row selected, nothing to fill down

    const cells: Record<string, SheetCellData> = { ...doc.cells };

    for (let c = minCol; c <= maxCol; c++) {
        const srcAddr: CellAddr = { row: minRow, col: c };
        const srcKey = cellKey(minRow, c);
        const srcData = doc.cells[srcKey];
        const srcRaw = srcData?.raw ?? "";
        const srcBorder = srcData?.border;
        const srcFormat = srcData?.format;

        for (let r = minRow + 1; r <= maxRow; r++) {
            const targetAddr: CellAddr = { row: r, col: c };
            const raw = adjustFormulaForPaste(srcRaw, srcAddr, targetAddr);
            const targetKey = cellKey(r, c);
            if (raw.trim() === "" && !srcBorder && !srcFormat) {
                delete cells[targetKey];
            } else {
                cells[targetKey] = { raw, border: srcBorder, format: srcFormat };
            }
        }
    }

    return { ...doc, cells };
}

// ------------------------------------------------------------------------------------------
// Whole-sheet evaluation
// ------------------------------------------------------------------------------------------

export interface CellValue {
    text: string;
    numeric: boolean;
    error: boolean;
}

export function formatNumber(n: number): string {
    if (!Number.isFinite(n)) return "#ERROR!";
    // Round away float noise (0.1 + 0.2) without truncating a deliberately precise value.
    const rounded = Math.round(n * 1e6) / 1e6;
    return String(rounded);
}

export function formatCellValue(value: FormulaValue, format?: CellFormat | NumberFormatType): string {
    if (value === EMPTY_CELL) return "";
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "string") return value;

    if (!Number.isFinite(value)) return "#ERROR!";

    const fmt: CellFormat = typeof format === "string" ? { type: format } : format ?? { type: "general" };

    switch (fmt.type) {
        case "currency": {
            const sym = fmt.symbol ?? "$";
            const dec = fmt.decimals !== undefined ? fmt.decimals : 2;
            const isNeg = value < 0;
            const absVal = Math.abs(value);
            const parts = absVal.toFixed(dec).split(".");
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
            const formatted = sym + (dec > 0 ? parts.join(".") : parts[0]);
            return isNeg ? `-${formatted}` : formatted;
        }
        case "percent": {
            const dec = fmt.decimals !== undefined ? fmt.decimals : 2;
            const isNeg = value < 0;
            const absVal = Math.abs(value) * 100;
            const parts = absVal.toFixed(dec).split(".");
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
            const formatted = (dec > 0 ? parts.join(".") : parts[0]) + "%";
            return isNeg ? `-${formatted}` : formatted;
        }
        case "decimal": {
            const dec = fmt.decimals !== undefined ? fmt.decimals : 2;
            const isNeg = value < 0;
            const absVal = Math.abs(value);
            const parts = absVal.toFixed(dec).split(".");
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
            const formatted = dec > 0 ? parts.join(".") : parts[0];
            return isNeg ? `-${formatted}` : formatted;
        }
        case "integer": {
            const isNeg = value < 0;
            const absVal = Math.round(Math.abs(value));
            const formatted = String(absVal).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
            return isNeg ? `-${formatted}` : formatted;
        }
        case "general":
        default:
            return formatNumber(value);
    }
}

/** Recomputes every non-empty cell's display text, resolving formulas (with cycle detection)
 * against every other cell in `doc`. An empty cell referenced numerically is 0, like a real
 * spreadsheet; a text cell referenced numerically is `#VALUE!`. */
export function evaluateSheet(doc: SheetDoc): Map<string, CellValue> {
    const results = new Map<string, CellValue>();
    const visiting = new Set<string>();
    const cellCache = new Map<string, FormulaValue>();

    const computeCell = (raw: string): FormulaValue => {
        const trimmed = raw.trim();
        if (trimmed.startsWith("=")) {
            const tokens = tokenize(trimmed.slice(1));
            return new Parser(tokens, resolveCell).parse();
        }
        if (trimmed === "") return EMPTY_CELL;
        const upper = trimmed.toUpperCase();
        if (upper === "TRUE") return true;
        if (upper === "FALSE") return false;
        const n = Number(trimmed);
        if (!Number.isNaN(n)) return n;
        return raw;
    };

    function resolveCell(addr: CellAddr): FormulaValue {
        const key = cellKey(addr.row, addr.col);
        const cached = cellCache.get(key);
        if (cached !== undefined) return cached;
        const data = doc.cells[key];
        if (!data || data.raw.trim() === "") {
            cellCache.set(key, EMPTY_CELL);
            return EMPTY_CELL;
        }
        if (visiting.has(key)) throw new FormulaError("#CYCLE!");
        visiting.add(key);
        try {
            const value = computeCell(data.raw);
            cellCache.set(key, value);
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
                    const value = resolveCell({ row, col });
                    const isNum = typeof value === "number";
                    const text = formatCellValue(value, data.format);
                    results.set(key, { text, numeric: isNum, error: false });
                } catch (e) {
                    const msg = e instanceof FormulaError ? e.message : "#ERROR!";
                    results.set(key, { text: msg, numeric: false, error: true });
                }
            } else {
                const upper = raw.toUpperCase();
                if (upper === "TRUE" || upper === "FALSE") {
                    results.set(key, { text: upper, numeric: false, error: false });
                } else {
                    const n = Number(raw);
                    const isNumeric = !Number.isNaN(n);
                    if (isNumeric) {
                        results.set(key, {
                            text: formatCellValue(n, data.format),
                            numeric: true,
                            error: false,
                        });
                    } else {
                        results.set(key, { text: raw, numeric: false, error: false });
                    }
                }
            }
        }
    }

    return results;
}

export const CHART3D_PALETTE: [number, number, number, number][] = [
    [0.28, 0.90, 0.84, 1.0], // Teal
    [0.58, 0.45, 1.00, 1.0], // Violet
    [1.00, 0.38, 0.66, 1.0], // Pink
    [1.00, 0.78, 0.36, 1.0], // Amber
    [0.45, 0.62, 1.00, 1.0], // Sky
    [1.00, 0.36, 0.42, 1.0], // Rose
    [0.65, 0.95, 0.35, 1.0], // Lime
    [1.00, 0.55, 0.35, 1.0], // Coral
];

export interface Chart3dSeriesData {
    name: string;
    color?: [number, number, number, number];
    values: number[];
}

export interface Chart3dExtractedData {
    series: Chart3dSeriesData[];
    xLabels: string[];
    title?: string;
}

export interface Chart3dExtractOptions {
    orientation?: "rows" | "cols";
    firstRowHeaders?: boolean;
    firstColHeaders?: boolean;
}

export function extractChart3dData(
    doc: SheetDoc,
    evaluated: Map<string, CellValue>,
    range: SheetRange,
    options?: Chart3dExtractOptions
): Chart3dExtractedData {
    const r0 = Math.min(range.start.row, range.end.row);
    const r1 = Math.max(range.start.row, range.end.row);
    const c0 = Math.min(range.start.col, range.end.col);
    const c1 = Math.max(range.start.col, range.end.col);

    const orientation = options?.orientation ?? "rows";
    const hasRowHeaders = (options?.firstRowHeaders ?? false) && r1 > r0;
    const hasColHeaders = (options?.firstColHeaders ?? false) && c1 > c0;

    const getCellNumber = (row: number, col: number): number => {
        const key = cellKey(row, col);
        const evalCell = evaluated.get(key);
        if (evalCell && evalCell.numeric && !evalCell.error) {
            const cleaned = evalCell.text.replace(/[^0-9.-]/g, "");
            const n = parseFloat(cleaned);
            if (!Number.isNaN(n)) return n;
        }
        const raw = doc.cells[key]?.raw;
        if (raw !== undefined) {
            const n = Number(raw);
            if (!Number.isNaN(n)) return n;
        }
        return 0;
    };

    const getCellText = (row: number, col: number, fallback: string): string => {
        const key = cellKey(row, col);
        const evalCell = evaluated.get(key);
        if (evalCell && evalCell.text.trim()) return evalCell.text.trim();
        const raw = doc.cells[key]?.raw;
        if (raw && raw.trim()) return raw.trim();
        return fallback;
    };

    const getCellBorder = (row: number, col: number): [number, number, number, number] | undefined => {
        const key = cellKey(row, col);
        return doc.cells[key]?.border;
    };

    const series: Chart3dSeriesData[] = [];
    const xLabels: string[] = [];

    if (orientation === "rows") {
        const dataR0 = hasRowHeaders ? r0 + 1 : r0;
        const dataC0 = hasColHeaders ? c0 + 1 : c0;

        for (let c = dataC0; c <= c1; c++) {
            const label = hasRowHeaders ? getCellText(r0, c, colLetters(c)) : colLetters(c);
            xLabels.push(label);
        }

        for (let r = dataR0; r <= r1; r++) {
            const name = hasColHeaders ? getCellText(r, c0, `Row ${r + 1}`) : `Row ${r + 1}`;
            const sIdx = r - dataR0;
            const customColor = (hasColHeaders ? getCellBorder(r, c0) : undefined) ?? getCellBorder(r, dataC0);
            const color = customColor ?? CHART3D_PALETTE[sIdx % CHART3D_PALETTE.length];
            const values: number[] = [];
            for (let c = dataC0; c <= c1; c++) {
                values.push(getCellNumber(r, c));
            }
            series.push({ name, color, values });
        }
    } else {
        const dataR0 = hasRowHeaders ? r0 + 1 : r0;
        const dataC0 = hasColHeaders ? c0 + 1 : c0;

        for (let r = dataR0; r <= r1; r++) {
            const label = hasColHeaders ? getCellText(r, c0, `Row ${r + 1}`) : `Row ${r + 1}`;
            xLabels.push(label);
        }

        for (let c = dataC0; c <= c1; c++) {
            const name = hasRowHeaders ? getCellText(r0, c, colLetters(c)) : colLetters(c);
            const sIdx = c - dataC0;
            const customColor = (hasRowHeaders ? getCellBorder(r0, c) : undefined) ?? getCellBorder(dataR0, c);
            const color = customColor ?? CHART3D_PALETTE[sIdx % CHART3D_PALETTE.length];
            const values: number[] = [];
            for (let r = dataR0; r <= r1; r++) {
                values.push(getCellNumber(r, c));
            }
            series.push({ name, color, values });
        }
    }

    return { series, xLabels };
}

/** Applies matching 3D chart palette border colors to each series in the spreadsheet range. */
export function applyChartBorders(
    doc: SheetDoc,
    range: SheetRange,
    orientation: "rows" | "cols" = "rows",
    hasRowHeaders = false,
    hasColHeaders = false
): SheetDoc {
    const r0 = Math.min(range.start.row, range.end.row);
    const r1 = Math.max(range.start.row, range.end.row);
    const c0 = Math.min(range.start.col, range.end.col);
    const c1 = Math.max(range.start.col, range.end.col);

    const cells: Record<string, SheetCellData> = { ...doc.cells };
    const rowH = hasRowHeaders && r1 > r0;
    const colH = hasColHeaders && c1 > c0;

    if (orientation === "rows") {
        const dataR0 = rowH ? r0 + 1 : r0;
        for (let r = dataR0; r <= r1; r++) {
            const sIdx = r - dataR0;
            const color = CHART3D_PALETTE[sIdx % CHART3D_PALETTE.length];
            for (let c = c0; c <= c1; c++) {
                const key = cellKey(r, c);
                const existing = cells[key];
                cells[key] = { raw: existing?.raw ?? "", border: color, format: existing?.format };
            }
        }
    } else {
        const dataC0 = colH ? c0 + 1 : c0;
        for (let c = dataC0; c <= c1; c++) {
            const sIdx = c - dataC0;
            const color = CHART3D_PALETTE[sIdx % CHART3D_PALETTE.length];
            for (let r = r0; r <= r1; r++) {
                const key = cellKey(r, c);
                const existing = cells[key];
                cells[key] = { raw: existing?.raw ?? "", border: color, format: existing?.format };
            }
        }
    }

    return { ...doc, cells };
}

/** Creates a sample spreadsheet populated with quarterly revenue data ready for 3D charting. */
export function createSampleSheet(): SheetDoc {
    const doc = defaultSheet(30, 12);
    // Header row
    doc.cells[cellKey(0, 0)] = { raw: "Segment" };
    doc.cells[cellKey(0, 1)] = { raw: "Q1" };
    doc.cells[cellKey(0, 2)] = { raw: "Q2" };
    doc.cells[cellKey(0, 3)] = { raw: "Q3" };
    doc.cells[cellKey(0, 4)] = { raw: "Q4" };

    const data: [string, number, number, number, number][] = [
        ["SaaS", 120, 145, 180, 215],
        ["Hardware", 95, 80, 110, 140],
        ["Services", 60, 75, 70, 95],
        ["Cloud", 150, 195, 240, 310],
    ];

    data.forEach(([name, q1, q2, q3, q4], idx) => {
        const r = idx + 1;
        const color = CHART3D_PALETTE[idx % CHART3D_PALETTE.length];
        doc.cells[cellKey(r, 0)] = { raw: name, border: color };
        doc.cells[cellKey(r, 1)] = { raw: String(q1), border: color, format: { type: "currency", decimals: 0 } };
        doc.cells[cellKey(r, 2)] = { raw: String(q2), border: color, format: { type: "currency", decimals: 0 } };
        doc.cells[cellKey(r, 3)] = { raw: String(q3), border: color, format: { type: "currency", decimals: 0 } };
        doc.cells[cellKey(r, 4)] = { raw: String(q4), border: color, format: { type: "currency", decimals: 0 } };
    });

    return doc;
}
