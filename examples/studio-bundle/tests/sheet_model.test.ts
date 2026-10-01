import { describe, expect, it } from "vitest";
import type { SheetDoc } from "../src/apps/sheet/sheet_model";
import {
    a1,
    adjustFormulaForPaste,
    cellKey,
    clearRange,
    colLetters,
    copyRange,
    defaultSheet,
    deleteColumn,
    deleteRow,
    evaluateSheet,
    expandRange,
    fillDown,
    formatRef,
    insertColumn,
    insertRow,
    parseA1,
    parseA1Detailed,
    pasteRange,
    rangeA1,
    setRangeBorder,
    setRangeFormat,
    formatCellValue,
    setColumnWidth,
    applyChartBorders,
    createSampleSheet,
    extractChart3dData,
    parseRangeA1,
} from "../src/apps/sheet/sheet_model";

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

describe("row and column insert/delete", () => {
    it("inserting a row shifts cells at and after it down, and leaves earlier rows alone", () => {
        // top=row0, middle=row3, bottom=row5; inserting at row3 leaves row0 alone and shifts
        // anything at row3 or later (3->4, 5->6).
        const doc = withCells({ A1: "top", A4: "middle", A6: "bottom" });
        const next = insertRow(doc, 3);
        expect(next.rows).toBe(11);
        expect(next.cells[cellKey(0, 0)].raw).toBe("top");
        expect(next.cells[cellKey(4, 0)].raw).toBe("middle");
        expect(next.cells[cellKey(6, 0)].raw).toBe("bottom");
        expect(next.cells[cellKey(3, 0)]).toBeUndefined();
    });

    it("deleting a row drops its cells and shifts the rest up", () => {
        // top=row0, middle=row1, bottom=row3; deleting row2 (empty) leaves row0/row1 alone and
        // shifts anything after it up by one (3->2).
        const doc = withCells({ A1: "top", A2: "middle", A4: "bottom" });
        const next = deleteRow(doc, 2);
        expect(next.rows).toBe(9);
        expect(next.cells[cellKey(0, 0)].raw).toBe("top");
        expect(next.cells[cellKey(1, 0)].raw).toBe("middle");
        expect(next.cells[cellKey(2, 0)].raw).toBe("bottom");
    });

    it("refuses to delete the sheet's last row", () => {
        const doc = defaultSheet(1, 5);
        doc.cells[cellKey(0, 0)] = { raw: "only" };
        const next = deleteRow(doc, 0);
        expect(next.rows).toBe(1);
        expect(next.cells[cellKey(0, 0)].raw).toBe("only");
    });

    it("inserting and deleting a column shifts cells the same way, on the other axis", () => {
        const doc = withCells({ A1: "left", C1: "middle", E1: "right" });
        const inserted = insertColumn(doc, 2);
        expect(inserted.cols).toBe(11);
        expect(inserted.cells[cellKey(0, 0)].raw).toBe("left");
        expect(inserted.cells[cellKey(0, 3)].raw).toBe("middle");
        expect(inserted.cells[cellKey(0, 5)].raw).toBe("right");

        // After the insert, "right" sits at col5; deleting col3 (empty) shifts it to col4.
        const deleted = deleteColumn(inserted, 3);
        expect(deleted.cols).toBe(10);
        expect(deleted.cells[cellKey(0, 4)].raw).toBe("right");
        expect(Object.values(deleted.cells).some((c) => c.raw === "middle")).toBe(false);
    });

    it("refuses to delete the sheet's last column", () => {
        const doc = defaultSheet(5, 1);
        doc.cells[cellKey(0, 0)] = { raw: "only" };
        const next = deleteColumn(doc, 0);
        expect(next.cols).toBe(1);
        expect(next.cells[cellKey(0, 0)].raw).toBe("only");
    });

    it("preserves a cell's border across an insert", () => {
        const doc = withCells({ A3: "x" });
        doc.cells[cellKey(2, 0)].border = [1, 0, 0, 1];
        const next = insertRow(doc, 1);
        expect(next.cells[cellKey(3, 0)].border).toEqual([1, 0, 0, 1]);
    });
});

describe("formula reference adjustment on row/column insert and delete", () => {
    it("shifts cell references down when a row is inserted above or at them", () => {
        const doc = withCells({ A1: "10", A2: "=A1*2", A3: "=A1+A2" });
        // Insert empty row at index 1 (between A1 and A2)
        const next = insertRow(doc, 1);
        expect(next.rows).toBe(11);
        // A1 stayed at A1 (row 0 < 1)
        expect(next.cells[cellKey(0, 0)].raw).toBe("10");
        // Row 1 is new empty row
        expect(next.cells[cellKey(1, 0)]).toBeUndefined();
        // A2 moved to A3 (row 2); its reference to A1 stayed A1 (row 0 < 1)
        expect(next.cells[cellKey(2, 0)].raw).toBe("=A1*2");
        // A3 moved to A4 (row 3); references A1 (unchanged) and old A2 (now A3)
        expect(next.cells[cellKey(3, 0)].raw).toBe("=A1+A3");
    });

    it("shifts cell references at or below the inserted row", () => {
        const doc = withCells({ A2: "5", B1: "=A2+1" });
        // Insert row at 0 (above everything)
        const next = insertRow(doc, 0);
        // B1 moved to B2 (row 1, col 1); old A2 moved to A3, formula adjusted from A2 to A3
        expect(next.cells[cellKey(1, 1)].raw).toBe("=A3+1");
    });

    it("expands a formula range when a row is inserted inside the range", () => {
        const doc = withCells({ A1: "1", A2: "2", A3: "3", B1: "=SUM(A1:A3)" });
        // Insert row at index 2 (between A2 and A3)
        const next = insertRow(doc, 2);
        // Range A1:A3 expands to A1:A4
        expect(next.cells[cellKey(0, 1)].raw).toBe("=SUM(A1:A4)");
    });

    it("shifts an entire formula range when a row is inserted above it", () => {
        const doc = withCells({ A3: "1", A4: "2", B1: "=SUM(A3:A4)" });
        // Insert row at index 0 (above A3:A4)
        const next = insertRow(doc, 0);
        expect(next.cells[cellKey(1, 1)].raw).toBe("=SUM(A4:A5)");
    });

    it("leaves formula references untouched when a row is inserted below them", () => {
        const doc = withCells({ A1: "10", B1: "=A1+5" });
        const next = insertRow(doc, 5);
        expect(next.cells[cellKey(0, 1)].raw).toBe("=A1+5");
    });

    it("replaces reference with #REF! when referenced row is deleted", () => {
        const doc = withCells({ A1: "10", A2: "20", A3: "=A1+A2" });
        // Delete row 1 (A2)
        const next = deleteRow(doc, 1);
        expect(next.rows).toBe(9);
        // A3 shifted up to row 1 (now A2), formula had A1 and A2; A2 was deleted -> #REF!
        expect(next.cells[cellKey(1, 0)].raw).toBe("=A1+#REF!");
    });

    it("shifts references up when a row above them is deleted", () => {
        const doc = withCells({ A1: "10", A2: "20", A3: "30", B1: "=A3*2" });
        // Delete row 1 (A2)
        const next = deleteRow(doc, 1);
        // A3 shifted to A2; B1 formula adjusts from A3 to A2
        expect(next.cells[cellKey(0, 1)].raw).toBe("=A2*2");
    });

    it("shrinks a formula range when an interior row is deleted", () => {
        const doc = withCells({ A1: "1", A2: "2", A3: "3", A4: "4", B1: "=SUM(A1:A4)" });
        // Delete row 2 (A3, inside the range)
        const next = deleteRow(doc, 2);
        expect(next.cells[cellKey(0, 1)].raw).toBe("=SUM(A1:A3)");
    });

    it("replaces range with #REF! when an endpoint row is deleted", () => {
        const doc = withCells({ A1: "1", A2: "2", A3: "3", B2: "=SUM(A1:A3)" });
        // Delete row 0 (A1, the range start)
        const next = deleteRow(doc, 0);
        // B2 shifted to B1 (row 0, col 1)
        expect(next.cells[cellKey(0, 1)].raw).toBe("=SUM(#REF!)");
    });

    it("adjusts formula references on column insert", () => {
        const doc = withCells({ A1: "10", B1: "20", C1: "=A1+B1", D1: "=SUM(A1:B1)" });
        // Insert column at index 1 (between A and B)
        const next = insertColumn(doc, 1);
        expect(next.cols).toBe(11);
        // C1 moved to D1; A1 stays A1 (col 0 < 1), B1 moved to C1
        expect(next.cells[cellKey(0, 3)].raw).toBe("=A1+C1");
        // D1 moved to E1; range A1:B1 expanded to A1:C1
        expect(next.cells[cellKey(0, 4)].raw).toBe("=SUM(A1:C1)");
    });

    it("adjusts formula references on column delete", () => {
        const doc = withCells({ A1: "10", B1: "20", C1: "30", D1: "=A1+B1+C1" });
        // Delete column 1 (B)
        const next = deleteColumn(doc, 1);
        expect(next.cols).toBe(9);
        // D1 moved to C1; B1 was deleted -> #REF!, C1 moved to B1
        expect(next.cells[cellKey(0, 2)].raw).toBe("=A1+#REF!+B1");
    });
});

describe("formula reference adjustment on paste", () => {
    it("shifts relative references by row and column delta", () => {
        // Copy from A1 (0, 0) to B2 (1, 1): delta row = +1, delta col = +1
        const raw = "=C1 + D2";
        const adjusted = adjustFormulaForPaste(raw, { row: 0, col: 0 }, { row: 1, col: 1 });
        expect(adjusted).toBe("=D2 + E3");
    });

    it("preserves absolute row references when shifting rows", () => {
        const raw = "=A$1 + B2";
        // Paste 2 rows down
        const adjusted = adjustFormulaForPaste(raw, { row: 0, col: 0 }, { row: 2, col: 0 });
        expect(adjusted).toBe("=A$1 + B4");
    });

    it("preserves absolute column references when shifting columns", () => {
        const raw = "=$A1 + B2";
        // Paste 3 columns right
        const adjusted = adjustFormulaForPaste(raw, { row: 0, col: 0 }, { row: 0, col: 3 });
        expect(adjusted).toBe("=$A1 + E2");
    });

    it("preserves fully absolute references across any shift", () => {
        const raw = "=$A$1 + 5";
        const adjusted = adjustFormulaForPaste(raw, { row: 0, col: 0 }, { row: 5, col: 5 });
        expect(adjusted).toBe("=$A$1 + 5");
    });

    it("shifts ranges relatively on paste", () => {
        const raw = "=SUM(A1:B3)";
        const adjusted = adjustFormulaForPaste(raw, { row: 0, col: 0 }, { row: 2, col: 1 });
        expect(adjusted).toBe("=SUM(B3:C5)");
    });

    it("turns reference into #REF! when shifted off the top or left of the sheet", () => {
        // Reference A1 in cell B2 (1, 1), paste into A1 (0, 0): delta = (-1, -1)
        const raw = "=A1 + 1";
        const adjusted = adjustFormulaForPaste(raw, { row: 1, col: 1 }, { row: 0, col: 0 });
        expect(adjusted).toBe("=#REF! + 1");
    });

    it("returns non-formula strings verbatim", () => {
        expect(adjustFormulaForPaste("42", { row: 0, col: 0 }, { row: 1, col: 1 })).toBe("42");
        expect(adjustFormulaForPaste("hello", { row: 0, col: 0 }, { row: 1, col: 1 })).toBe("hello");
    });

    it("returns unchanged formula if pasted to the same cell", () => {
        expect(adjustFormulaForPaste("=A1+B1", { row: 0, col: 0 }, { row: 0, col: 0 })).toBe("=A1+B1");
    });
});

describe("recomputation and error handling after reference adjustments", () => {
    it("evaluates correctly after row insertion moves data and formulas", () => {
        const doc = withCells({ A1: "10", A2: "20", A3: "=A1+A2" });
        expect(textOf(doc, "A3")).toBe("30");

        // Insert row at 1 (between A1 and A2)
        const next = insertRow(doc, 1);
        // A3 became A4; should still evaluate to 30 because A1 is 10 and A3 is 20
        expect(textOf(next, "A4")).toBe("30");
    });

    it("reports #REF! error when evaluating a formula whose reference was deleted", () => {
        const doc = withCells({ A1: "10", A2: "20", A3: "=A1+A2" });
        const next = deleteRow(doc, 1); // delete A2
        // A3 moved to A2; formula is =A1+#REF!
        const result = evaluateSheet(next).get(cellKey(1, 0));
        expect(result?.error).toBe(true);
        expect(result?.text).toBe("#REF!");
    });

    it("evaluates pasted formula against its new relative target cells", () => {
        const doc = withCells({ A1: "10", B1: "=A1*2", A2: "50" });
        expect(textOf(doc, "B1")).toBe("20");

        // Simulate pasting B1's formula into B2 (row 0 -> row 1)
        const rawPasted = adjustFormulaForPaste(doc.cells[cellKey(0, 1)].raw, { row: 0, col: 1 }, { row: 1, col: 1 });
        expect(rawPasted).toBe("=A2*2");
        doc.cells[cellKey(1, 1)] = { raw: rawPasted };
        expect(textOf(doc, "B2")).toBe("100");
    });
});

describe("range formatting and expansion", () => {
    it("formats single cell and multi-cell ranges in A1 notation", () => {
        expect(rangeA1({ row: 0, col: 0 }, { row: 0, col: 0 })).toBe("A1");
        expect(rangeA1({ row: 0, col: 0 }, { row: 2, col: 1 })).toBe("A1:B3");
        // Inverted selection order still produces canonical top-left to bottom-right
        expect(rangeA1({ row: 2, col: 1 }, { row: 0, col: 0 })).toBe("A1:B3");
    });

    it("expands a bounding rectangle into row-major cell addresses", () => {
        const addrs = expandRange({ row: 1, col: 2 }, { row: 2, col: 3 });
        expect(addrs).toEqual([
            { row: 1, col: 2 },
            { row: 1, col: 3 },
            { row: 2, col: 2 },
            { row: 2, col: 3 },
        ]);
    });
});

describe("range copy, cut, paste, and fill-down", () => {
    it("copies a multi-cell range and preserves relative structure", () => {
        const doc = withCells({ A1: "1", B1: "2", A2: "3", B2: "=A1+B1" });
        const clip = copyRange(doc, { start: { row: 0, col: 0 }, end: { row: 1, col: 1 } });
        expect(clip.rows).toBe(2);
        expect(clip.cols).toBe(2);
        expect(clip.cells).toHaveLength(4);
        expect(clip.cells[3].raw).toBe("=A1+B1");
        expect(clip.cells[3].dRow).toBe(1);
        expect(clip.cells[3].dCol).toBe(1);
    });

    it("pastes a multi-cell range to a new location with formula adjustment", () => {
        const doc = withCells({ A1: "10", B1: "20", A2: "=A1*2", B2: "=B1*2" });
        const clip = copyRange(doc, { start: { row: 0, col: 0 }, end: { row: 1, col: 1 } });

        // Paste at C3 (row 2, col 2)
        const pasted = pasteRange(doc, clip, { start: { row: 2, col: 2 }, end: { row: 2, col: 2 } });
        expect(pasted.cells[cellKey(2, 2)].raw).toBe("10"); // C3
        expect(pasted.cells[cellKey(2, 3)].raw).toBe("20"); // D3
        expect(pasted.cells[cellKey(3, 2)].raw).toBe("=C3*2"); // C4
        expect(pasted.cells[cellKey(3, 3)].raw).toBe("=D3*2"); // D4
    });

    it("pastes a single copied cell into a destination range (fill/repeat with adjustment)", () => {
        const doc = withCells({ A1: "100", A2: "200", A3: "300", B1: "=A1+1" });
        const clip = copyRange(doc, { start: { row: 0, col: 1 }, end: { row: 0, col: 1 } }); // copy B1

        // Paste into B2:B3
        const pasted = pasteRange(doc, clip, { start: { row: 1, col: 1 }, end: { row: 2, col: 1 } });
        expect(pasted.cells[cellKey(1, 1)].raw).toBe("=A2+1");
        expect(pasted.cells[cellKey(2, 1)].raw).toBe("=A3+1");
        expect(textOf(pasted, "B2")).toBe("201");
        expect(textOf(pasted, "B3")).toBe("301");
    });

    it("cutting a range keeps formulas unchanged on paste", () => {
        const doc = withCells({ A1: "10", B1: "=A1*2" });
        const clip = copyRange(doc, { start: { row: 0, col: 1 }, end: { row: 0, col: 1 } }, true); // cut B1
        const pasted = pasteRange(doc, clip, { start: { row: 3, col: 3 }, end: { row: 3, col: 3 } }); // paste at D4
        expect(pasted.cells[cellKey(3, 3)].raw).toBe("=A1*2");
    });

    it("fillDown copies top row values and adjusts formulas across multiple columns", () => {
        const doc = withCells({
            A1: "10",
            B1: "=A1*2",
            C1: "=$A$1+5",
            A2: "20",
            A3: "30",
        });

        // Fill down B1:C3
        const next = fillDown(doc, { start: { row: 0, col: 1 }, end: { row: 2, col: 2 } });
        // Column B has relative =A1*2, should shift to =A2*2 and =A3*2
        expect(next.cells[cellKey(1, 1)].raw).toBe("=A2*2");
        expect(next.cells[cellKey(2, 1)].raw).toBe("=A3*2");
        expect(textOf(next, "B2")).toBe("40");
        expect(textOf(next, "B3")).toBe("60");

        // Column C has absolute =$A$1+5, should remain =$A$1+5
        expect(next.cells[cellKey(1, 2)].raw).toBe("=$A$1+5");
        expect(next.cells[cellKey(2, 2)].raw).toBe("=$A$1+5");
        expect(textOf(next, "C2")).toBe("15");
        expect(textOf(next, "C3")).toBe("15");
    });

    it("clearRange removes cell content across the range while preserving or clearing borders", () => {
        const doc = withCells({ A1: "foo", A2: "bar", B1: "baz" });
        doc.cells[cellKey(0, 0)].border = [1, 0, 0, 1];

        // Clear A1:B1 without clearing borders
        const clearedContent = clearRange(doc, { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } }, false);
        expect(clearedContent.cells[cellKey(0, 0)].raw).toBe("");
        expect(clearedContent.cells[cellKey(0, 0)].border).toEqual([1, 0, 0, 1]);
        expect(clearedContent.cells[cellKey(0, 1)]).toBeUndefined();
        expect(clearedContent.cells[cellKey(1, 0)].raw).toBe("bar");

        // Clear with borders
        const clearedAll = clearRange(doc, { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } }, true);
        expect(clearedAll.cells[cellKey(0, 0)]).toBeUndefined();
    });

    it("setRangeBorder applies borders across an entire multi-cell range", () => {
        const doc = withCells({ A1: "1", B2: "2" });
        const red: [number, number, number, number] = [1, 0, 0, 1];
        const next = setRangeBorder(doc, { start: { row: 0, col: 0 }, end: { row: 1, col: 1 } }, red);
        expect(next.cells[cellKey(0, 0)].border).toEqual(red);
        expect(next.cells[cellKey(0, 1)].border).toEqual(red);
        expect(next.cells[cellKey(1, 0)].border).toEqual(red);
        expect(next.cells[cellKey(1, 1)].border).toEqual(red);
    });
});

describe("comparison operators", () => {
    it("evaluates numeric equality and inequality", () => {
        const doc = withCells({
            A1: "=5=5",
            A2: "=5=6",
            A3: "=5<>6",
            A4: "=5<>5",
        });
        expect(textOf(doc, "A1")).toBe("TRUE");
        expect(textOf(doc, "A2")).toBe("FALSE");
        expect(textOf(doc, "A3")).toBe("TRUE");
        expect(textOf(doc, "A4")).toBe("FALSE");
    });

    it("evaluates relational comparisons", () => {
        const doc = withCells({
            A1: "=10>5",
            A2: "=10<5",
            A3: "=10>=10",
            A4: "=10<=9",
        });
        expect(textOf(doc, "A1")).toBe("TRUE");
        expect(textOf(doc, "A2")).toBe("FALSE");
        expect(textOf(doc, "A3")).toBe("TRUE");
        expect(textOf(doc, "A4")).toBe("FALSE");
    });

    it("evaluates string equality case-insensitively", () => {
        const doc = withCells({
            A1: '="apple"="apple"',
            A2: '="apple"="Apple"',
            A3: '="apple"="banana"',
            A4: '="apple"<"banana"',
        });
        expect(textOf(doc, "A1")).toBe("TRUE");
        expect(textOf(doc, "A2")).toBe("TRUE");
        expect(textOf(doc, "A3")).toBe("FALSE");
        expect(textOf(doc, "A4")).toBe("TRUE");
    });

    it("respects operator precedence between arithmetic and comparison", () => {
        const doc = withCells({
            A1: "=1+2 > 2*1",
            A2: "=10 - 5 = 2 + 3",
        });
        expect(textOf(doc, "A1")).toBe("TRUE");
        expect(textOf(doc, "A2")).toBe("TRUE");
    });
});

describe("string literals, concatenation, and text functions", () => {
    it("supports string literals and concatenation via & operator", () => {
        const doc = withCells({
            A1: '="Hello"',
            A2: '="Hello " & "World"',
            A3: '="Quotes: ""hello"""',
        });
        expect(textOf(doc, "A1")).toBe("Hello");
        expect(textOf(doc, "A2")).toBe("Hello World");
        expect(textOf(doc, "A3")).toBe('Quotes: "hello"');
    });

    it("concatenates cell references and mixed types", () => {
        const doc = withCells({
            A1: "Entropy",
            A2: "100",
            B1: '=A1 & " score: " & A2',
        });
        expect(textOf(doc, "B1")).toBe("Entropy score: 100");
    });

    it("supports CONCAT across arguments and ranges", () => {
        const doc = withCells({
            A1: "A",
            A2: "B",
            A3: "C",
            B1: '=CONCAT("X", "Y", "Z")',
            B2: "=CONCAT(A1:A3)",
        });
        expect(textOf(doc, "B1")).toBe("XYZ");
        expect(textOf(doc, "B2")).toBe("ABC");
    });

    it("evaluates LEN, UPPER, LOWER, and TRIM", () => {
        const doc = withCells({
            A1: "  Spreadsheet  ",
            B1: "=LEN(A1)",
            B2: "=LEN(TRIM(A1))",
            B3: '=UPPER("rust")',
            B4: '=LOWER("WGPU")',
        });
        expect(textOf(doc, "B1")).toBe("15");
        expect(textOf(doc, "B2")).toBe("11");
        expect(textOf(doc, "B3")).toBe("RUST");
        expect(textOf(doc, "B4")).toBe("wgpu");
    });

    it("evaluates LEFT, RIGHT, and MID substrings", () => {
        const doc = withCells({
            A1: "EntropyEngine",
            B1: "=LEFT(A1, 7)",
            B2: "=LEFT(A1)",
            B3: "=RIGHT(A1, 6)",
            B4: "=MID(A1, 8, 3)",
        });
        expect(textOf(doc, "B1")).toBe("Entropy");
        expect(textOf(doc, "B2")).toBe("E");
        expect(textOf(doc, "B3")).toBe("Engine");
        expect(textOf(doc, "B4")).toBe("Eng");
    });
});

describe("conditional and logical functions", () => {
    it("evaluates IF branches correctly", () => {
        const doc = withCells({
            A1: "15",
            B1: '=IF(A1 > 10, "High", "Low")',
            B2: '=IF(A1 < 10, "High", "Low")',
            B3: "=IF(A1 > 10, A1 * 2, A1 / 2)",
        });
        expect(textOf(doc, "B1")).toBe("High");
        expect(textOf(doc, "B2")).toBe("Low");
        expect(textOf(doc, "B3")).toBe("30");
    });

    it("lazily evaluates IF branches to avoid unnecessary error evaluation", () => {
        const doc = withCells({
            A1: "0",
            B1: '=IF(A1 = 0, "Zero", 100 / A1)',
            B2: '=IF(A1 <> 0, 100 / A1, "Safe")',
        });
        expect(textOf(doc, "B1")).toBe("Zero");
        expect(textOf(doc, "B2")).toBe("Safe");
    });

    it("evaluates nested IF expressions", () => {
        const doc = withCells({
            A1: "85",
            B1: '=IF(A1 >= 90, "A", IF(A1 >= 80, "B", "C"))',
            A2: "70",
            B2: '=IF(A2 >= 90, "A", IF(A2 >= 80, "B", "C"))',
        });
        expect(textOf(doc, "B1")).toBe("B");
        expect(textOf(doc, "B2")).toBe("C");
    });

    it("evaluates AND, OR, and NOT logical functions", () => {
        const doc = withCells({
            A1: "=AND(1=1, 2=2, 3=3)",
            A2: "=AND(1=1, 2=3)",
            A3: "=OR(1=2, 2=3, 4=4)",
            A4: "=OR(1=2, 2=3)",
            A5: "=NOT(1=1)",
            A6: "=NOT(1=2)",
            A7: "=TRUE()",
            A8: "=FALSE()",
        });
        expect(textOf(doc, "A1")).toBe("TRUE");
        expect(textOf(doc, "A2")).toBe("FALSE");
        expect(textOf(doc, "A3")).toBe("TRUE");
        expect(textOf(doc, "A4")).toBe("FALSE");
        expect(textOf(doc, "A5")).toBe("FALSE");
        expect(textOf(doc, "A6")).toBe("TRUE");
        expect(textOf(doc, "A7")).toBe("TRUE");
        expect(textOf(doc, "A8")).toBe("FALSE");
    });
});

describe("extended math functions", () => {
    it("evaluates ROUND with positive, zero, and negative decimal digits", () => {
        const doc = withCells({
            A1: "=ROUND(3.14159, 2)",
            A2: "=ROUND(3.14159, 4)",
            A3: "=ROUND(1234.56, 0)",
            A4: "=ROUND(1234.56)",
            A5: "=ROUND(1250, -2)",
        });
        expect(textOf(doc, "A1")).toBe("3.14");
        expect(textOf(doc, "A2")).toBe("3.1416");
        expect(textOf(doc, "A3")).toBe("1235");
        expect(textOf(doc, "A4")).toBe("1235");
        expect(textOf(doc, "A5")).toBe("1300");
    });

    it("evaluates ABS, SQRT, MOD, and POWER", () => {
        const doc = withCells({
            A1: "=ABS(-42)",
            A2: "=SQRT(144)",
            A3: "=SQRT(-4)",
            A4: "=MOD(10, 3)",
            A5: "=POWER(2, 8)",
        });
        expect(textOf(doc, "A1")).toBe("42");
        expect(textOf(doc, "A2")).toBe("12");
        expect(textOf(doc, "A3")).toBe("#NUM!");
        expect(textOf(doc, "A4")).toBe("1");
        expect(textOf(doc, "A5")).toBe("256");
    });

    it("evaluates COUNTA to count non-empty cells", () => {
        const doc = withCells({
            A1: "Alpha",
            A2: "",
            A3: "42",
            B1: "=COUNTA(A1:A3)",
        });
        expect(textOf(doc, "B1")).toBe("2");
    });
});

describe("number formatting", () => {
    it("formats numbers via formatCellValue directly", () => {
        expect(formatCellValue(1234.56, { type: "currency" })).toBe("$1,234.56");
        expect(formatCellValue(-1234.56, { type: "currency" })).toBe("-$1,234.56");
        expect(formatCellValue(0, { type: "currency" })).toBe("$0.00");
        expect(formatCellValue(1234.56, { type: "currency", symbol: "€" })).toBe("€1,234.56");

        expect(formatCellValue(0.155, { type: "percent" })).toBe("15.50%");
        expect(formatCellValue(0.155, { type: "percent", decimals: 1 })).toBe("15.5%");
        expect(formatCellValue(-0.05, { type: "percent", decimals: 0 })).toBe("-5%");

        expect(formatCellValue(1234.5, { type: "decimal" })).toBe("1,234.50");
        expect(formatCellValue(42, { type: "decimal", decimals: 2 })).toBe("42.00");
        expect(formatCellValue(1234.5678, { type: "decimal", decimals: 3 })).toBe("1,234.568");

        expect(formatCellValue(1234.56, { type: "integer" })).toBe("1,235");
        expect(formatCellValue(1000000, { type: "integer" })).toBe("1,000,000");
        expect(formatCellValue(-500, { type: "integer" })).toBe("-500");
    });

    it("formats numbers via TEXT formula function", () => {
        const doc = withCells({
            A1: "1234.5",
            B1: '=TEXT(A1, "currency")',
            B2: '=TEXT(0.155, "percent")',
            B3: '=TEXT(A1, "decimal")',
            B4: '=TEXT(A1, "integer")',
        });
        expect(textOf(doc, "B1")).toBe("$1,234.50");
        expect(textOf(doc, "B2")).toBe("15.50%");
        expect(textOf(doc, "B3")).toBe("1,234.50");
        expect(textOf(doc, "B4")).toBe("1,235");
    });

    it("applies cell formatting in evaluateSheet", () => {
        const doc = withCells({
            A1: "1234.5",
            A2: "=A1*2",
        });
        doc.cells[cellKey(0, 0)].format = { type: "currency", decimals: 2 };
        doc.cells[cellKey(1, 0)].format = { type: "percent", decimals: 1 };

        const results = evaluateSheet(doc);
        expect(results.get(cellKey(0, 0))?.text).toBe("$1,234.50");
        expect(results.get(cellKey(1, 0))?.text).toBe("246,900.0%");
    });

    it("setRangeFormat applies format across range", () => {
        const doc = withCells({ A1: "100", A2: "200" });
        const formatted = setRangeFormat(doc, { start: { row: 0, col: 0 }, end: { row: 1, col: 0 } }, { type: "currency" });
        expect(formatted.cells[cellKey(0, 0)].format).toEqual({ type: "currency" });
        expect(formatted.cells[cellKey(1, 0)].format).toEqual({ type: "currency" });
        expect(textOf(formatted, "A1")).toBe("$100.00");
        expect(textOf(formatted, "A2")).toBe("$200.00");
    });

    it("copies, pastes, and fills down cell formatting", () => {
        const doc = withCells({ A1: "50" });
        doc.cells[cellKey(0, 0)].format = { type: "currency", decimals: 2 };

        // Copy A1 and paste to B1
        const clipboard = copyRange(doc, { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } });
        expect(clipboard.cells[0].format).toEqual({ type: "currency", decimals: 2 });

        const pasted = pasteRange(doc, clipboard, { start: { row: 0, col: 1 }, end: { row: 0, col: 1 } });
        expect(pasted.cells[cellKey(0, 1)].format).toEqual({ type: "currency", decimals: 2 });
        expect(textOf(pasted, "B1")).toBe("$50.00");

        // Fill down B1:B3
        const filled = fillDown(pasted, { start: { row: 0, col: 1 }, end: { row: 2, col: 1 } });
        expect(filled.cells[cellKey(1, 1)].format).toEqual({ type: "currency", decimals: 2 });
        expect(filled.cells[cellKey(2, 1)].format).toEqual({ type: "currency", decimals: 2 });
        expect(textOf(filled, "B2")).toBe("$50.00");
        expect(textOf(filled, "B3")).toBe("$50.00");
    });
});

describe("column widths", () => {
    it("setColumnWidth sets and updates custom column widths", () => {
        let doc = defaultSheet(10, 10);
        expect(doc.colWidths).toBeUndefined();

        doc = setColumnWidth(doc, 1, 140);
        expect(doc.colWidths?.[1]).toBe(140);

        doc = setColumnWidth(doc, 3, 200);
        expect(doc.colWidths?.[1]).toBe(140);
        expect(doc.colWidths?.[3]).toBe(200);

        // Update existing width
        doc = setColumnWidth(doc, 1, 160);
        expect(doc.colWidths?.[1]).toBe(160);
    });

    it("insertColumn shifts custom column widths at and after insertion point", () => {
        let doc = defaultSheet(10, 10);
        doc = setColumnWidth(doc, 1, 120);
        doc = setColumnWidth(doc, 3, 180);

        // Insert column at index 2 (between col 1 and col 3)
        const next = insertColumn(doc, 2);
        expect(next.colWidths?.[1]).toBe(120);
        expect(next.colWidths?.[2]).toBeUndefined();
        expect(next.colWidths?.[4]).toBe(180);

        // Insert column at index 0 (shifts all right)
        const shifted = insertColumn(next, 0);
        expect(shifted.colWidths?.[0]).toBeUndefined();
        expect(shifted.colWidths?.[2]).toBe(120);
        expect(shifted.colWidths?.[5]).toBe(180);
    });

    it("deleteColumn removes deleted column width and shifts subsequent widths left", () => {
        let doc = defaultSheet(10, 10);
        doc = setColumnWidth(doc, 1, 120);
        doc = setColumnWidth(doc, 2, 150);
        doc = setColumnWidth(doc, 4, 200);

        // Delete column 2
        const next = deleteColumn(doc, 2);
        expect(next.colWidths?.[1]).toBe(120);
        expect(next.colWidths?.[2]).toBeUndefined();
        expect(next.colWidths?.[3]).toBe(200);
    });

    it("insertRow and deleteRow preserve column widths intact", () => {
        let doc = defaultSheet(10, 10);
        doc = setColumnWidth(doc, 2, 175);

        const withRow = insertRow(doc, 1);
        expect(withRow.colWidths?.[2]).toBe(175);

        const withoutRow = deleteRow(withRow, 1);
        expect(withoutRow.colWidths?.[2]).toBe(175);
    });
});

describe("Chart3D range extraction and styling", () => {
    it("parseRangeA1 parses single cells and ranges", () => {
        const single = parseRangeA1("B4");
        expect(single).toEqual({
            start: { row: 3, col: 1 },
            end: { row: 3, col: 1 },
        });

        const range = parseRangeA1("A1:D5");
        expect(range).toEqual({
            start: { row: 0, col: 0 },
            end: { row: 4, col: 3 },
        });

        expect(parseRangeA1("invalid")).toBeNull();
    });

    it("createSampleSheet initializes a sample dataset with borders and values", () => {
        const doc = createSampleSheet();
        expect(doc.rows).toBe(30);
        expect(doc.cols).toBe(12);
        expect(doc.cells[cellKey(0, 0)]?.raw).toBe("Segment");
        expect(doc.cells[cellKey(0, 1)]?.raw).toBe("Q1");
        expect(doc.cells[cellKey(1, 0)]?.raw).toBe("SaaS");
        expect(doc.cells[cellKey(1, 1)]?.raw).toBe("120");
        expect(doc.cells[cellKey(1, 1)]?.border).toBeDefined();
    });

    it("extractChart3dData extracts series and xLabels with rows as series", () => {
        const doc = createSampleSheet();
        const evaluated = evaluateSheet(doc);
        const range = { start: { row: 0, col: 0 }, end: { row: 4, col: 4 } };

        const chart = extractChart3dData(doc, evaluated, range, {
            orientation: "rows",
            firstRowHeaders: true,
            firstColHeaders: true,
        });

        expect(chart.xLabels).toEqual(["Q1", "Q2", "Q3", "Q4"]);
        expect(chart.series.length).toBe(4);
        expect(chart.series[0].name).toBe("SaaS");
        expect(chart.series[0].values).toEqual([120, 145, 180, 215]);
        expect(chart.series[3].name).toBe("Cloud");
        expect(chart.series[3].values).toEqual([150, 195, 240, 310]);
    });

    it("extractChart3dData extracts series with columns as series", () => {
        const doc = createSampleSheet();
        const evaluated = evaluateSheet(doc);
        const range = { start: { row: 0, col: 0 }, end: { row: 4, col: 4 } };

        const chart = extractChart3dData(doc, evaluated, range, {
            orientation: "cols",
            firstRowHeaders: true,
            firstColHeaders: true,
        });

        expect(chart.xLabels).toEqual(["SaaS", "Hardware", "Services", "Cloud"]);
        expect(chart.series.length).toBe(4);
        expect(chart.series[0].name).toBe("Q1");
        expect(chart.series[0].values).toEqual([120, 95, 60, 150]);
        expect(chart.series[3].name).toBe("Q4");
        expect(chart.series[3].values).toEqual([215, 140, 95, 310]);
    });

    it("extractChart3dData resolves live formulas to numbers in chart series", () => {
        let doc = defaultSheet(5, 5);
        doc.cells[cellKey(0, 0)] = { raw: "Base" };
        doc.cells[cellKey(0, 1)] = { raw: "Col1" };
        doc.cells[cellKey(1, 0)] = { raw: "Row1" };
        doc.cells[cellKey(1, 1)] = { raw: "50" };
        doc.cells[cellKey(2, 0)] = { raw: "Row2" };
        doc.cells[cellKey(2, 1)] = { raw: "=B2*2" }; // formula evaluating to 100

        const evaluated = evaluateSheet(doc);
        const range = { start: { row: 0, col: 0 }, end: { row: 2, col: 1 } };
        const chart = extractChart3dData(doc, evaluated, range, {
            orientation: "rows",
            firstRowHeaders: true,
            firstColHeaders: true,
        });

        expect(chart.series[0].values).toEqual([50]);
        expect(chart.series[1].values).toEqual([100]);
    });

    it("applyChartBorders colors sheet cells matching the 3D palette", () => {
        let doc = defaultSheet(5, 5);
        doc.cells[cellKey(1, 1)] = { raw: "10" };
        doc.cells[cellKey(2, 1)] = { raw: "20" };

        const range = { start: { row: 1, col: 1 }, end: { row: 2, col: 1 } };
        const withBorders = applyChartBorders(doc, range, "rows");

        expect(withBorders.cells[cellKey(1, 1)]?.border).toBeDefined();
        expect(withBorders.cells[cellKey(2, 1)]?.border).toBeDefined();
        expect(withBorders.cells[cellKey(1, 1)]?.border).not.toEqual(withBorders.cells[cellKey(2, 1)]?.border);
    });
});


