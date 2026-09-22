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

import type { CellAddr, SheetDoc } from "./sheet_model";
import { a1, cellKey, defaultSheet, deleteColumn, deleteRow, evaluateSheet, insertColumn, insertRow } from "./sheet_model";

const addonInfo = {
    name: "sheet",
    version: "1.1.0",
    description: "A spreadsheet grid with formulas, inline editing, copy/cut/paste, undo/redo, and row/column insert-delete - the second pass of Alex's live-3D-chart spreadsheet idea.",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true },
};

const addon = Entropy.AddonAtom.register(addonInfo);

const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 12;
const GRID_MAX_HEIGHT = 560;
const UNDO_LIMIT = 100;

let doc: SheetDoc = defaultSheet(DEFAULT_ROWS, DEFAULT_COLS);
let selected: CellAddr = { row: 0, col: 0 };
/** The cell currently being edited and its live draft text - shared between the formula bar and
 * SheetGrid's own inline box, however the edit started. `null` means nothing is being edited. */
let editing: { row: number; col: number; value: string } | null = null;
let clipboard: { raw: string; border?: [number, number, number, number] } | null = null;
let undoStack: SheetDoc[] = [];
let redoStack: SheetDoc[] = [];

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
    if (raw.trim() === "" && !existing?.border) {
        delete doc.cells[key];
    } else {
        doc.cells[key] = { raw, border: existing?.border };
    }
}

function mutateBorder(addr: CellAddr, border: [number, number, number, number] | undefined) {
    const key = cellKey(addr.row, addr.col);
    const existing = doc.cells[key];
    if (!border && (!existing || existing.raw.trim() === "")) {
        delete doc.cells[key];
    } else {
        doc.cells[key] = { raw: existing?.raw ?? "", border };
    }
}

function clampSelection() {
    selected = { row: Math.min(selected.row, doc.rows - 1), col: Math.min(selected.col, doc.cols - 1) };
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
        const cellKeyStr = cellKey(selected.row, selected.col);
        if (k === "c") {
            const existing = doc.cells[cellKeyStr];
            clipboard = existing ? { raw: existing.raw, border: existing.border } : { raw: "" };
        } else if (k === "x") {
            const existing = doc.cells[cellKeyStr];
            clipboard = existing ? { raw: existing.raw, border: existing.border } : { raw: "" };
            commit(() => {
                mutateRaw(selected, "");
                mutateBorder(selected, undefined);
            });
        } else if (k === "v") {
            if (clipboard) {
                const paste = clipboard;
                commit(() => {
                    mutateRaw(selected, paste.raw);
                    mutateBorder(selected, paste.border);
                });
            }
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
        text: "Click a cell and type, or double-click to edit in place. Right-click a row/column header to insert or delete. Ctrl+C/X/V copies, Ctrl+Z/Y undoes/redoes.",
    });
    Entropy.UI.Widget.separator(win);

    // The formula bar and the grid's own inline box are two views onto the same edit session -
    // both show `editing.value` while one is in progress, and typing in either one keeps it in
    // sync (see onChange below and onEditChanged further down).
    const isEditingSelected = editing !== null && editing.row === selected.row && editing.col === selected.col;
    const formulaValue = isEditingSelected ? editing!.value : getRaw(selected);
    Entropy.UI.Widget.textInput(win, {
        id: "formula_bar",
        label: `${a1(selected.row, selected.col)}:`,
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
                commit(() => mutateBorder(selected, a > 0.01 ? [c[0], c[1], c[2], a] : undefined));
            },
        });
        Entropy.UI.Widget.button(row, {
            id: "clear_border",
            text: "Clear border",
            onClick: () => commit(() => mutateBorder(selected, undefined)),
        });
        Entropy.UI.Widget.button(row, {
            id: "clear_cell",
            text: "Clear cell",
            onClick: () => {
                if (isEditingSelected) editing = null;
                commit(() => mutateRaw(selected, ""));
            },
        });
        Entropy.UI.Widget.button(row, { id: "undo_btn", text: "Undo", onClick: () => undo() });
        Entropy.UI.Widget.button(row, { id: "redo_btn", text: "Redo", onClick: () => redo() });
    });
    
    Entropy.UI.Widget.separator(win);

    const evaluated = evaluateSheet(doc);
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

    Entropy.UI.Widget.sheetGrid(win, {
        id: "sheet_grid",
        cells,
        selected: { row: selected.row, col: selected.col },
        editing: editing ? { row: editing.row, col: editing.col, value: editing.value } : undefined,
        options: { rows: doc.rows, cols: doc.cols, maxHeight: GRID_MAX_HEIGHT },
        onCellSelected: (row, col) => {
            selected = { row, col };
        },
        onCellClear: (row, col) => {
            if (editing && editing.row === row && editing.col === col) editing = null;
            commit(() => mutateRaw({ row, col }, ""));
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
                if (selected.row >= row) selected = { ...selected, row: selected.row + 1 };
            }),
        onDeleteRow: (row) =>
            commit(() => {
                doc = deleteRow(doc, row);
                if (selected.row > row || selected.row >= doc.rows) selected = { ...selected, row: Math.max(0, selected.row - 1) };
            }),
        onInsertColumn: (col) =>
            commit(() => {
                doc = insertColumn(doc, col);
                if (selected.col >= col) selected = { ...selected, col: selected.col + 1 };
            }),
        onDeleteColumn: (col) =>
            commit(() => {
                doc = deleteColumn(doc, col);
                if (selected.col > col || selected.col >= doc.cols) selected = { ...selected, col: Math.max(0, selected.col - 1) };
            }),
    });
}

addon.onInit(async () => {
    setupUI();
});
