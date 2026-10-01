// Sheet - a spreadsheet addon exercising the new Entropy.UI.Widget.sheetGrid widget (see
// entropy_gui::widgets_sheet). Alex's own framing for the eventual differentiator here: live,
// beautiful 3D charts built from the same terrain-rendering trick as the wavetable synth's
// sculptable surface, plus color-coded cell borders for marking which column feeds which axis.
// This pass adds the basic spreadsheet features a grid needs before that chart is worth
// building on top of it: inline cell editing, double-click-to-edit, single-cell copy/cut/paste,
// undo/redo, and inserting/deleting rows and columns from their header's context menu. The chart
// itself is still deliberately deferred - see the sheet-chart-3d and related backlog cards in
// cc-manager/tasks.json.
//
// Cell editing can be driven two ways - typed directly into the grid (SheetGrid's own inline
// box) or typed into this addon's formula bar - and both share one `editing` session (see
// entropy_gui::widgets_sheet's module doc for exactly how the widget expects this to work).
// Everything else (the cell store, formula parsing/evaluation, row/column insert/delete) lives
// in sheet_model.ts so it can be unit-tested with no window at all.

import type { CellAddr, CellFormat, SheetClipboard, SheetDoc, SheetRange } from "./sheet_model";
import {
    a1,
    adjustFormulaForPaste,
    cellKey,
    clearRange,
    copyRange,
    defaultSheet,
    deleteColumn,
    deleteRow,
    evaluateSheet,
    fillDown,
    insertColumn,
    insertRow,
    pasteRange,
    rangeA1,
    setRangeBorder,
    setRangeFormat,
    setColumnWidth,
    applyChartBorders,
    createSampleSheet,
    extractChart3dData,
    extractHeatmapData,
    parseRangeA1,
} from "./sheet_model";

const addonInfo = {
    name: "sheet",
    version: "1.4.0",
    description: "A spreadsheet grid with formulas, inline editing, multi-cell range selection, per-column width resize, copy/cut/paste, fill-down, undo/redo, row/column insert-delete, number formatting (currency, percent, decimal, integer) and extended formula functions (IF, logic, text, math).",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true },
};

const addon = Entropy.AddonAtom.register(addonInfo);

const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 12;
const GRID_MAX_HEIGHT = 560;
const UNDO_LIMIT = 100;

let doc: SheetDoc = defaultSheet(DEFAULT_ROWS, DEFAULT_COLS);
let selected: { row: number; col: number; endRow?: number; endCol?: number } = { row: 0, col: 0 };
/** The cell currently being edited and its live draft text - shared between the formula bar and
 * SheetGrid's own inline box, however the edit started. `null` means nothing is being edited. */
let editing: { row: number; col: number; value: string } | null = null;
let clipboard: SheetClipboard | null = null;
let undoStack: SheetDoc[] = [];
let redoStack: SheetDoc[] = [];
let showChart = false;
let chartType: "surface" | "bar" | "ribbon" | "heatmap" = "surface";
let chartOrientation: "rows" | "cols" = "rows";
let chartFirstRowHeaders = true;
let chartFirstColHeaders = true;
let chartRangeOverride: string | null = null;

function currentRange(): SheetRange {
    return {
        start: { row: selected.row, col: selected.col },
        end: { row: selected.endRow ?? selected.row, col: selected.endCol ?? selected.col },
    };
}

function isMultiCellRange(): boolean {
    return selected.endRow !== undefined && selected.endCol !== undefined &&
        (selected.row !== selected.endRow || selected.col !== selected.endCol);
}

function loadSheet() {
    const loaded = addon.IO.load() as SheetDoc | null;
    doc = loaded && typeof loaded === "object" && loaded.cells ? loaded : defaultSheet(DEFAULT_ROWS, DEFAULT_COLS);
}

function saveSheet() {
    addon.IO.save(doc, { pretty: true });
}

function getRaw(addr: CellAddr): string {
    return doc.cells[cellKey(addr.row, addr.col)]?.raw ?? "";
}

function mutateRaw(addr: CellAddr, raw: string) {
    const key = cellKey(addr.row, addr.col);
    const existing = doc.cells[key];
    if (raw.trim() === "" && !existing?.border && !existing?.format) {
        delete doc.cells[key];
    } else {
        doc.cells[key] = { raw, border: existing?.border, format: existing?.format };
    }
}

function mutateBorder(addr: CellAddr, border: [number, number, number, number] | undefined) {
    const key = cellKey(addr.row, addr.col);
    const existing = doc.cells[key];
    if (!border && (!existing || (existing.raw.trim() === "" && !existing?.format))) {
        delete doc.cells[key];
    } else {
        doc.cells[key] = { raw: existing?.raw ?? "", border, format: existing?.format };
    }
}

function clampSelection() {
    selected = {
        row: Math.min(selected.row, doc.rows - 1),
        col: Math.min(selected.col, doc.cols - 1),
        endRow: selected.endRow !== undefined ? Math.min(selected.endRow, doc.rows - 1) : undefined,
        endCol: selected.endCol !== undefined ? Math.min(selected.endCol, doc.cols - 1) : undefined,
    };
}

/** Snapshots the document for undo, runs `action`, then saves - the one path every mutation
 * (typing, paste, clear, border, row/column insert-delete) goes through, so undo/redo cover all
 * of them the same way. */
function commit(action: () => void) {
    undoStack.push(JSON.parse(JSON.stringify(doc)));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    action();
    clampSelection();
    saveSheet();
}

function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(JSON.parse(JSON.stringify(doc)));
    doc = undoStack.pop()!;
    clampSelection();
    saveSheet();
}

function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(JSON.parse(JSON.stringify(doc)));
    doc = redoStack.pop()!;
    clampSelection();
    saveSheet();
}

function setupUI() {
    loadSheet();
    const win = Entropy.UI.createWindow({
        title: "Sheet",
        width: 1400,
        height: 860,
        x: 20,
        y: 20,
        onRender: () => renderUI(win),
    });

    // Ctrl-gated so ordinary typing (into the formula bar or the grid's own inline editor)
    // never trips these - and skipped entirely while mid-edit, since none of these have a
    // sensible meaning for "the text field currently under the caret" yet (no OS clipboard
    // integration, no text selection within a field - see the sheet-range-selection-and-
    // copy-paste backlog card for where multi-cell copy/paste is headed).
    Entropy.Input.onKeyDown((key, ctrl) => {
        if (!ctrl || editing) return;
        const k = key.toLowerCase();
        const rng = currentRange();
        if (k === "c") {
            clipboard = copyRange(doc, rng, false);
        } else if (k === "x") {
            clipboard = copyRange(doc, rng, true);
            commit(() => {
                doc = clearRange(doc, rng);
            });
        } else if (k === "v") {
            if (clipboard) {
                commit(() => {
                    doc = pasteRange(doc, clipboard!, rng);
                });
            }
        } else if (k === "d") {
            commit(() => {
                doc = fillDown(doc, rng);
            });
        } else if (k === "z") {
            undo();
        } else if (k === "y") {
            redo();
        }
    });
}

function renderUI(win: string) {
    Entropy.UI.Widget.label(win, { text: "Sheet", bold: true });
    Entropy.UI.Widget.label(win, {
        text: "Click a cell and type, or double-click to edit in place. Shift-click/drag to select ranges. Ctrl+C/X/V copies/pastes, Ctrl+D fills down, Ctrl+Z/Y undoes/redoes.",
    });
    Entropy.UI.Widget.separator(win);

    // The formula bar and the grid's own inline box are two views onto the same edit session -
    // both show `editing.value` while one is in progress, and typing in either one keeps it in
    // sync (see onChange below and onEditChanged further down).
    const isEditingSelected = editing !== null && editing.row === selected.row && editing.col === selected.col;
    const formulaValue = isEditingSelected ? editing!.value : getRaw(selected);
    const rng = currentRange();
    const rangeLabel = (rng.start.row === rng.end.row && rng.start.col === rng.end.col)
        ? `${a1(rng.start.row, rng.start.col)}:`
        : `${rangeA1(rng.start, rng.end)}:`;
    Entropy.UI.Widget.textInput(win, {
        id: "formula_bar",
        label: rangeLabel,
        value: formulaValue,
        onChange: (v) => {
            editing = { row: selected.row, col: selected.col, value: v };
        },
    });

    const selKey = cellKey(selected.row, selected.col);
    const currentBorder = doc.cells[selKey]?.border ?? [0, 0, 0, 0];

    Entropy.UI.Widget.horizontal(win, (row) => {
        Entropy.UI.Widget.colorInput(row, {
            id: "border_color",
            label: "Border color",
            color: currentBorder,
            onChange: (c) => {
                const a = c[3] ?? 1;
                const borderVal: [number, number, number, number] | undefined = a > 0.01 ? [c[0], c[1], c[2], a] : undefined;
                commit(() => {
                    doc = setRangeBorder(doc, currentRange(), borderVal);
                });
            },
        });
        Entropy.UI.Widget.button(row, {
            id: "clear_border",
            text: "Clear border",
            onClick: () => commit(() => {
                doc = setRangeBorder(doc, currentRange(), undefined);
            }),
        });
        Entropy.UI.Widget.button(row, {
            id: "fill_down",
            text: "Fill down",
            onClick: () => commit(() => {
                doc = fillDown(doc, currentRange());
            }),
        });
        Entropy.UI.Widget.button(row, {
            id: "clear_cell",
            text: isMultiCellRange() ? "Clear range" : "Clear cell",
            onClick: () => {
                if (isEditingSelected) editing = null;
                commit(() => {
                    doc = clearRange(doc, currentRange());
                });
            },
        });
        Entropy.UI.Widget.button(row, { id: "undo_btn", text: "Undo", onClick: () => undo() });
        Entropy.UI.Widget.button(row, { id: "redo_btn", text: "Redo", onClick: () => redo() });
    });

    Entropy.UI.Widget.horizontal(win, (row) => {
        Entropy.UI.Widget.label(row, { text: "Format:" });
        Entropy.UI.Widget.button(row, {
            id: "fmt_general",
            text: "General",
            onClick: () => commit(() => {
                doc = setRangeFormat(doc, currentRange(), undefined);
            }),
        });
        Entropy.UI.Widget.button(row, {
            id: "fmt_currency",
            text: "Currency ($)",
            onClick: () => commit(() => {
                doc = setRangeFormat(doc, currentRange(), { type: "currency", decimals: 2 });
            }),
        });
        Entropy.UI.Widget.button(row, {
            id: "fmt_percent",
            text: "Percent (%)",
            onClick: () => commit(() => {
                doc = setRangeFormat(doc, currentRange(), { type: "percent", decimals: 2 });
            }),
        });
        Entropy.UI.Widget.button(row, {
            id: "fmt_decimal",
            text: "Decimal (.00)",
            onClick: () => commit(() => {
                doc = setRangeFormat(doc, currentRange(), { type: "decimal", decimals: 2 });
            }),
        });
        Entropy.UI.Widget.button(row, {
            id: "fmt_integer",
            text: "Integer (#)",
            onClick: () => commit(() => {
                doc = setRangeFormat(doc, currentRange(), { type: "integer" });
            }),
        });
        Entropy.UI.Widget.button(row, {
            id: "toggle_chart",
            text: showChart ? "Hide 3D Chart" : "3D Chart",
            onClick: () => { showChart = !showChart; },
        });
        Entropy.UI.Widget.button(row, {
            id: "load_sample",
            text: "Load Sample",
            onClick: () => commit(() => { doc = createSampleSheet(); }),
        });
    });
    
    Entropy.UI.Widget.separator(win);

    const evaluated = evaluateSheet(doc);

    if (showChart) {
        const activeChartRange = (chartRangeOverride ? parseRangeA1(chartRangeOverride) : null) ?? (
            isMultiCellRange() ? currentRange() : { start: { row: 0, col: 0 }, end: { row: 4, col: 4 } }
        );

        const chartData = extractChart3dData(doc, evaluated, activeChartRange, {
            orientation: chartOrientation,
            firstRowHeaders: chartFirstRowHeaders,
            firstColHeaders: chartFirstColHeaders,
        });

        const activeRangeLabel = rangeA1(activeChartRange.start, activeChartRange.end);

        Entropy.UI.Widget.horizontal(win, (row) => {
            Entropy.UI.Widget.label(row, { text: `3D Chart (${activeRangeLabel}):`, bold: true });
            Entropy.UI.Widget.button(row, {
                id: "c3d_surface",
                text: chartType === "surface" ? "[Surface]" : "Surface",
                onClick: () => { chartType = "surface"; },
            });
            Entropy.UI.Widget.button(row, {
                id: "c3d_bar",
                text: chartType === "bar" ? "[Bar]" : "Bar",
                onClick: () => { chartType = "bar"; },
            });
            Entropy.UI.Widget.button(row, {
                id: "c3d_ribbon",
                text: chartType === "ribbon" ? "[Ribbon]" : "Ribbon",
                onClick: () => { chartType = "ribbon"; },
            });
            Entropy.UI.Widget.button(row, {
                id: "c3d_heatmap",
                text: chartType === "heatmap" ? "[Heatmap]" : "Heatmap",
                onClick: () => { chartType = "heatmap"; },
            });
            Entropy.UI.Widget.button(row, {
                id: "c3d_orientation",
                text: chartOrientation === "rows" ? "Rows = Series" : "Cols = Series",
                onClick: () => { chartOrientation = chartOrientation === "rows" ? "cols" : "rows"; },
            });
            Entropy.UI.Widget.button(row, {
                id: "c3d_row_hdr",
                text: chartFirstRowHeaders ? "Row Hdr: On" : "Row Hdr: Off",
                onClick: () => { chartFirstRowHeaders = !chartFirstRowHeaders; },
            });
            Entropy.UI.Widget.button(row, {
                id: "c3d_col_hdr",
                text: chartFirstColHeaders ? "Col Hdr: On" : "Col Hdr: Off",
                onClick: () => { chartFirstColHeaders = !chartFirstColHeaders; },
            });
            Entropy.UI.Widget.button(row, {
                id: "c3d_use_sel",
                text: "Use Selected",
                onClick: () => {
                    const r = currentRange();
                    chartRangeOverride = rangeA1(r.start, r.end);
                },
            });
            Entropy.UI.Widget.button(row, {
                id: "c3d_color_borders",
                text: "Color Sheet Borders",
                onClick: () => commit(() => {
                    doc = applyChartBorders(doc, activeChartRange, chartOrientation, chartFirstRowHeaders, chartFirstColHeaders);
                }),
            });
        });

        if (chartType === "heatmap") {
            const heatmapData = extractHeatmapData(doc, evaluated, activeChartRange, {
                firstRowHeaders: chartFirstRowHeaders,
                firstColHeaders: chartFirstColHeaders,
            });
            Entropy.UI.Widget.heatmap(win, {
                id: "sheet_heatmap",
                rows: heatmapData.rows,
                cols: heatmapData.cols,
                data: heatmapData.data,
                rowLabels: heatmapData.rowLabels,
                colLabels: heatmapData.colLabels,
                title: `Heatmap - ${activeRangeLabel}`,
                height: 320,
                onCellClick: (row, col) => {
                    const r0 = Math.min(activeChartRange.start.row, activeChartRange.end.row);
                    const c0 = Math.min(activeChartRange.start.col, activeChartRange.end.col);
                    const targetR = r0 + (chartFirstRowHeaders ? 1 : 0) + row;
                    const targetC = c0 + (chartFirstColHeaders ? 1 : 0) + col;
                    selectCell(targetR, targetC);
                },
            });
        } else {
            Entropy.UI.Widget.chart3d(win, {
                id: "sheet_3d_chart",
                chartType,
                series: chartData.series,
                xLabels: chartData.xLabels,
                title: `3D Chart - ${activeRangeLabel}`,
                height: 320,
                onChartType: (t) => {
                    const lower = t.toLowerCase();
                    if (lower === "surface" || lower === "bar" || lower === "ribbon") {
                        chartType = lower as any;
                    }
                },
            });
        }

        Entropy.UI.Widget.separator(win);
    }

    const cells = Object.entries(doc.cells).map(([k, data]) => {
        const [rowStr, colStr] = k.split(":");
        const row = parseInt(rowStr, 10);
        const col = parseInt(colStr, 10);
        const value = evaluated.get(k);
        return {
            row,
            col,
            text: value?.text ?? data.raw,
            numeric: value?.numeric ?? false,
            error: value?.error ?? false,
            border: data.border,
        };
    });

    const gridMaxH = showChart ? 380 : GRID_MAX_HEIGHT;

    Entropy.UI.Widget.sheetGrid(win, {
        id: "sheet_grid",
        cells,
        selected: {
            row: selected.row,
            col: selected.col,
            endRow: selected.endRow,
            endCol: selected.endCol,
        },
        editing: editing ? { row: editing.row, col: editing.col, value: editing.value } : undefined,
        options: { rows: doc.rows, cols: doc.cols, maxHeight: gridMaxH, colWidths: doc.colWidths },
        onCellSelected: (row, col) => {
            selected = { row, col };
        },
        onRangeSelected: (startRow, startCol, endRow, endCol) => {
            selected = { row: startRow, col: startCol, endRow, endCol };
        },
        onCellClear: (row, col) => {
            if (editing && editing.row === row && editing.col === col) editing = null;
            commit(() => mutateRaw({ row, col }, ""));
        },
        onRangeClear: (startRow, startCol, endRow, endCol) => {
            if (editing) editing = null;
            commit(() => {
                doc = clearRange(doc, {
                    start: { row: startRow, col: startCol },
                    end: { row: endRow, col: endCol },
                });
            });
        },
        onEditStarted: (row, col, initial) => {
            const value = initial.length > 0 ? initial : getRaw({ row, col });
            editing = { row, col, value };
        },
        onEditChanged: (row, col, text) => {
            editing = { row, col, value: text };
        },
        onEditCommitted: (row, col) => {
            if (editing && editing.row === row && editing.col === col) {
                const value = editing.value;
                commit(() => mutateRaw({ row, col }, value));
            }
            editing = null;
        },
        onEditCancelled: () => {
            editing = null;
        },
        onInsertRow: (row) =>
            commit(() => {
                doc = insertRow(doc, row);
                if (selected.row >= row) selected.row += 1;
                if (selected.endRow !== undefined && selected.endRow >= row) selected.endRow += 1;
            }),
        onDeleteRow: (row) =>
            commit(() => {
                doc = deleteRow(doc, row);
                if (selected.row > row || selected.row >= doc.rows) selected.row = Math.max(0, selected.row - 1);
                if (selected.endRow !== undefined && (selected.endRow > row || selected.endRow >= doc.rows)) {
                    selected.endRow = Math.max(0, selected.endRow - 1);
                }
            }),
        onInsertColumn: (col) =>
            commit(() => {
                doc = insertColumn(doc, col);
                if (selected.col >= col) selected.col += 1;
                if (selected.endCol !== undefined && selected.endCol >= col) selected.endCol += 1;
            }),
        onDeleteColumn: (col) =>
            commit(() => {
                doc = deleteColumn(doc, col);
                if (selected.col > col || selected.col >= doc.cols) selected.col = Math.max(0, selected.col - 1);
                if (selected.endCol !== undefined && (selected.endCol > col || selected.endCol >= doc.cols)) {
                    selected.endCol = Math.max(0, selected.endCol - 1);
                }
            }),
        onColumnResized: (col, width) => {
            doc = setColumnWidth(doc, col, width);
            saveSheet();
        },
    });
}

addon.onInit(async () => {
    setupUI();
});
