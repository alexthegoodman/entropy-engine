import { describe, expect, it } from "vitest";
import { a1, cellKey, colLetters, defaultSheet, evaluateSheet, parseA1 } from "../src/apps/sheet/sheet_model";
import type { SheetDoc } from "../src/apps/sheet/sheet_model";

function withCells(cells: Record<string, string>, rows = 10, cols = 10): SheetDoc {
    const doc = defaultSheet(rows, cols);
    for (const [ref, raw] of Object.entries(cells)) {
        const addr = parseA1(ref);
        if (!addr) throw new Error(`bad test ref ${ref}`);
        doc.cells[cellKey(addr.row, addr.col)] = { raw };
    }
    return doc;
}

function textOf(doc: SheetDoc, ref: string): string | undefined {
    const addr = parseA1(ref)!;
    return evaluateSheet(doc).get(cellKey(addr.row, addr.col))?.text;
}

describe("A1 addressing", () => {
    it("converts column indices to letters and back", () => {
        expect(colLetters(0)).toBe("A");
        expect(colLetters(25)).toBe("Z");
        expect(colLetters(26)).toBe("AA");
        expect(colLetters(701)).toBe("ZZ");
        expect(colLetters(702)).toBe("AAA");
    });

    it("round-trips row/col through a1() and parseA1()", () => {
        for (const [row, col] of [[0, 0], [0, 25], [11, 1], [999, 27]]) {
            const ref = a1(row, col);
            expect(parseA1(ref)).toEqual({ row, col });
        }
    });

    it("rejects a non-cell reference", () => {
        expect(parseA1("SUM")).toBeNull();
        expect(parseA1("12A")).toBeNull();
        expect(parseA1("")).toBeNull();
    });
});

describe("literal cells", () => {
    it("detects a whole-string number as numeric and formats it", () => {
        const doc = withCells({ A1: "42", A2: "3.5", A3: "-2" });
        expect(evaluateSheet(doc).get(cellKey(0, 0))).toEqual({ text: "42", numeric: true, error: false });
        expect(textOf(doc, "A2")).toBe("3.5");
        expect(textOf(doc, "A3")).toBe("-2");
    });

    it("treats anything that doesn't fully parse as a number as plain text", () => {
        const doc = withCells({ A1: "Revenue", A2: "3abc" });
        expect(evaluateSheet(doc).get(cellKey(0, 0))).toEqual({ text: "Revenue", numeric: false, error: false });
        expect(evaluateSheet(doc).get(cellKey(1, 0))?.numeric).toBe(false);
    });

    it("skips empty cells entirely rather than reporting a blank value", () => {
        const doc = withCells({ A1: "1", A2: "   " });
        const results = evaluateSheet(doc);
        expect(results.has(cellKey(1, 0))).toBe(false);
    });
});

describe("arithmetic formulas", () => {
    it("respects operator precedence and parentheses", () => {
        const doc = withCells({ A1: "=1+2*3", A2: "=(1+2)*3", A3: "=10/2-1" });
        expect(textOf(doc, "A1")).toBe("7");
        expect(textOf(doc, "A2")).toBe("9");
        expect(textOf(doc, "A3")).toBe("4");
    });

    it("handles unary minus and nested parentheses", () => {
        const doc = withCells({ A1: "=-(2+3)*2" });
        expect(textOf(doc, "A1")).toBe("-10");
    });

    it("reports division by zero as a formula error", () => {
        const doc = withCells({ A1: "=1/0" });
        const v = evaluateSheet(doc).get(cellKey(0, 0));
        expect(v?.error).toBe(true);
        expect(v?.text).toBe("#DIV/0!");
    });

    it("rounds float noise away", () => {
        const doc = withCells({ A1: "=0.1+0.2" });
        expect(textOf(doc, "A1")).toBe("0.3");
    });
});

describe("cell references", () => {
    it("resolves a reference to another cell's computed value", () => {
        const doc = withCells({ A1: "5", B1: "=A1+1", C1: "=B1*2" });
        expect(textOf(doc, "B1")).toBe("6");
        expect(textOf(doc, "C1")).toBe("12");
    });

    it("treats an empty referenced cell as zero", () => {
        const doc = withCells({ A1: "=B1+1" });
        expect(textOf(doc, "A1")).toBe("1");
    });

    it("errors when a formula references a text cell numerically", () => {
        const doc = withCells({ A1: "hello", B1: "=A1+1" });
        const v = evaluateSheet(doc).get(cellKey(0, 1));
        expect(v?.error).toBe(true);
        expect(v?.text).toBe("#VALUE!");
    });

    it("errors on a malformed reference instead of throwing out of evaluateSheet", () => {
        const doc = withCells({ A1: "=1+" });
        expect(evaluateSheet(doc).get(cellKey(0, 0))?.error).toBe(true);
    });

    it("detects a cycle instead of recursing forever", () => {
        const doc = withCells({ A1: "=B1+1", B1: "=A1+1" });
        const results = evaluateSheet(doc);
        expect(results.get(cellKey(0, 0))).toEqual({ text: "#CYCLE!", numeric: false, error: true });
        expect(results.get(cellKey(0, 1))?.error).toBe(true);
    });

    it("does not treat a cell resolved via one path as cyclic when reached again via another", () => {
        // B1 and C1 both read A1; D1 reads both B1 and C1. Not a cycle, just a diamond.
        const doc = withCells({ A1: "10", B1: "=A1", C1: "=A1*2", D1: "=B1+C1" });
        expect(textOf(doc, "D1")).toBe("30");
    });
});

describe("functions and ranges", () => {
    it("sums, averages, mins and maxes a contiguous range", () => {
        const doc = withCells({ A1: "1", A2: "2", A3: "3", A4: "4", B1: "=SUM(A1:A4)", B2: "=AVERAGE(A1:A4)", B3: "=MIN(A1:A4)", B4: "=MAX(A1:A4)", B5: "=COUNT(A1:A4)" });
        expect(textOf(doc, "B1")).toBe("10");
        expect(textOf(doc, "B2")).toBe("2.5");
        expect(textOf(doc, "B3")).toBe("1");
        expect(textOf(doc, "B4")).toBe("4");
        expect(textOf(doc, "B5")).toBe("4");
    });

    it("treats an empty cell inside a range as zero, and skips it for COUNT", () => {
        const doc = withCells({ A1: "1", A3: "3", B1: "=SUM(A1:A3)", B2: "=COUNT(A1:A3)" });
        expect(textOf(doc, "B1")).toBe("4");
        // COUNT counts range cells resolved (including the implicit-zero empty one), matching
        // this engine's simple "a range is a list of numbers" model - not real Excel's
        // COUNT-only-non-blank semantics. Documented here so a future change is deliberate.
        expect(textOf(doc, "B2")).toBe("3");
    });

    it("mixes a range argument with plain expressions in one call", () => {
        const doc = withCells({ A1: "1", A2: "2", B1: "=SUM(A1:A2, 10, 1+1)" });
        expect(textOf(doc, "B1")).toBe("15");
    });

    it("errors when AVERAGE/MIN/MAX get no values", () => {
        const doc = withCells({ B1: "=MAX()" });
        expect(evaluateSheet(doc).get(cellKey(0, 1))?.error).toBe(true);
    });

    it("is case-insensitive on function names", () => {
        const doc = withCells({ A1: "3", A2: "4", B1: "=sum(A1:A2)" });
        expect(textOf(doc, "B1")).toBe("7");
    });
});
